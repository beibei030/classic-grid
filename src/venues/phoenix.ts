import fs from "node:fs";
import path from "node:path";
import bs58 from "bs58";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  OrderFlags,
  Side as PhoenixSide,
  calculateLiquidationPriceUsd,
  createPhoenixClient,
  type PhoenixClient,
} from "@ellipsis-labs/rise";
import type { Intent, LiveOrder, Side, VenueSnapshot } from "../types.js";
import { loadEnv } from "../loadEnv.js";
import { dryApply, type ApplyResult, type VenueExecutor } from "./types.js";

const DEFAULT_API = "https://perp-api.phoenix.trade";
const DEFAULT_RPC = "https://api.mainnet-beta.solana.com";
const LOT_DECIMALS = 4;
const LOT = 10 ** -LOT_DECIMALS;

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function roundLot(size: number): number {
  if (!(size > 0)) return 0;
  return Math.floor(size / LOT + 1e-12) * LOT;
}

function toPhoenixSide(side: Side): (typeof PhoenixSide)["Bid"] | (typeof PhoenixSide)["Ask"] {
  return side === "buy" ? PhoenixSide.Bid : PhoenixSide.Ask;
}

function fromPhoenixSide(side: unknown): Side {
  const s = String(side || "").toLowerCase();
  if (s === "ask" || s === "sell" || s === "1") return "sell";
  return "buy";
}

function orderId(priceTicks: string | number, seq: string | number): string {
  return `${priceTicks}:${seq}`;
}

function parseOrderId(id: string): { priceTicks: bigint; seq: bigint } | null {
  const m = String(id).match(/^(\d+):(\d+)$/);
  if (!m) return null;
  return { priceTicks: BigInt(m[1]), seq: BigInt(m[2]) };
}

function kitIxToWeb3(ix: {
  programAddress: string;
  accounts: Array<{ address: string; role: number }>;
  data: Uint8Array | number[];
}): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programAddress),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.address),
      isSigner: a.role === 2 || a.role === 3,
      isWritable: a.role === 1 || a.role === 3,
    })),
    data: Buffer.from(ix.data),
  });
}

function loadKeypair(): Keypair {
  loadEnv();
  const envKey = process.env.PHOENIX_PRIVATE_KEY?.trim();
  if (envKey) {
    if (envKey.startsWith("[")) {
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(envKey)));
    }
    return Keypair.fromSecretKey(bs58.decode(envKey));
  }
  const keyPath =
    process.env.PHOENIX_KEYPAIR_PATH?.trim() ||
    path.resolve(process.cwd(), "secrets", "phoenix.key");
  if (!fs.existsSync(keyPath)) {
    throw new Error(`缺少 Phoenix 密钥：${keyPath}（或设 PHOENIX_PRIVATE_KEY）`);
  }
  const raw = fs.readFileSync(keyPath, "utf8").trim();
  if (raw.startsWith("[")) {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
  }
  return Keypair.fromSecretKey(bs58.decode(raw));
}

export class PhoenixExecutor implements VenueExecutor {
  readonly id = "phoenix" as const;
  private client: PhoenixClient | null = null;
  private kp: Keypair | null = null;
  private conn: Connection | null = null;
  private apiUrl = DEFAULT_API;
  private authority = "";
  private symbolCache = new Map<string, string>();

  constructor(private dryRun: boolean) {}

  async connect(): Promise<void> {
    loadEnv();
    this.apiUrl = (process.env.PHOENIX_API_URL || DEFAULT_API).replace(/\/$/, "");
    const rpc = process.env.PHOENIX_SOLANA_RPC || process.env.SOLANA_RPC || DEFAULT_RPC;
    this.client = createPhoenixClient({
      apiUrl: this.apiUrl,
      rpcUrl: rpc,
      exchangeMetadata: { stream: false },
      ws: false,
    });
    await this.client.exchange.ready();
    if (this.dryRun) return;
    this.kp = loadKeypair();
    this.authority = this.kp.publicKey.toBase58();
    this.conn = new Connection(rpc, "confirmed");
    console.log(`[phoenix] authority=${this.authority}`);
  }

  disconnect(): void {
    try {
      this.client?.dispose();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.kp = null;
    this.conn = null;
    this.authority = "";
    this.symbolCache.clear();
  }

  private ensureClient(): PhoenixClient {
    if (!this.client) throw new Error("Phoenix 未 connect");
    return this.client;
  }

  private ensureLive(): { client: PhoenixClient; kp: Keypair; conn: Connection; authority: string } {
    const client = this.ensureClient();
    if (!this.kp || !this.conn || !this.authority) {
      throw new Error("Phoenix 实盘未就绪（缺密钥）");
    }
    return { client, kp: this.kp, conn: this.conn, authority: this.authority };
  }

  private async resolveSymbol(market: string): Promise<string> {
    const key = market.toUpperCase().replace(/-USD$/, "").replace(/-PERP$/, "");
    const cached = this.symbolCache.get(key);
    if (cached) return cached;
    const client = this.ensureClient();
    await client.exchange.ready();
    const symbols = client.exchange.snapshot()?.markets?.map((m) => m.symbol) ?? [];
    const exact = symbols.find((s) => s.toUpperCase() === key);
    const hit = exact || symbols.find((s) => s.toUpperCase().startsWith(key));
    if (!hit) throw new Error(`Phoenix 无市场 ${market}`);
    this.symbolCache.set(key, hit);
    return hit;
  }

  private async sendIxs(ixs: any[]): Promise<string> {
    const { kp, conn } = this.ensureLive();
    const cuLimit = Math.max(
      200_000,
      Number(process.env.PHOENIX_CU_LIMIT || 600_000) || 600_000
    );
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: kp.publicKey,
      recentBlockhash: blockhash,
      instructions: [
        ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }),
        ...ixs.map(kitIxToWeb3),
      ],
    }).compileToV0Message();
    const tx = new VersionedTransaction(msg);
    tx.sign([kp]);
    try {
      const sig = await conn.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
      const conf = await conn.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );
      if (conf.value.err) {
        throw new Error(`Phoenix tx failed: ${JSON.stringify(conf.value.err)}`);
      }
      return sig;
    } catch (e: any) {
      const raw = String(e?.message || e);
      // 压缩 Solana simulation 长日志，方便 TG 去重与排障
      if (/MatchingEngine::place_order/i.test(raw)) {
        throw new Error("place_order 被拒（多半穿价/保证金，下轮再补）");
      }
      if (/block height exceeded|has expired/i.test(raw)) {
        throw new Error("tx 过期（block height），下轮重试");
      }
      if (/ComputationalBudgetExceeded|max.*compute/i.test(raw)) {
        throw new Error("CU 不足，已提高限额，下轮重试");
      }
      throw e;
    }
  }

  private async fetchMark(symbol: string): Promise<number> {
    const r = await fetch(`${this.apiUrl}/v1/market/${encodeURIComponent(symbol)}/mark-price`);
    if (!r.ok) throw new Error(`Phoenix mark-price HTTP ${r.status}`);
    const j = (await r.json()) as any;
    const mid = num(j?.markPrice?.price ?? j?.price);
    if (!(mid > 0)) throw new Error(`Phoenix 无效 mark ${symbol}`);
    return mid;
  }

  private async fetchTraderState(authority: string): Promise<any> {
    const r = await fetch(`${this.apiUrl}/v1/trader/state/${authority}`);
    if (!r.ok) throw new Error(`Phoenix trader state HTTP ${r.status}`);
    return r.json();
  }

  private parseSnapshot(market: string, symbol: string, mid: number, state: any): VenueSnapshot {
    const snap = state?.snapshot ?? {};
    const sub = (snap.subaccounts || []).find((s: any) => Number(s.subaccountIndex) === 0) ||
      snap.subaccounts?.[0];
    const equityUsd = sub?.collateral != null ? num(sub.collateral) / 1e6 : undefined;

    let position = 0;
    let unrealizedPnl: number | undefined;
    let liquidationPrice: number | undefined;
    let entryUsd = 0;
    for (const p of sub?.positions || []) {
      if (String(p.symbol || "").toUpperCase() !== symbol.toUpperCase()) continue;
      position = num(p.basePositionLots) * LOT;
      const entry = num(p.entryPriceUsd ?? p.entryPriceTicks);
      entryUsd = entry;
      if (entry > 0 && mid > 0 && Math.abs(position) > 0) {
        // 官方均价 × 标记价；lots 带符号（多正空负）
        unrealizedPnl = position * (mid - entry);
      }
      break;
    }

    // Hawkeye 同源公式（SDK calculateLiquidationPriceUsd）
    if (Math.abs(position) > 0 && entryUsd > 0 && equityUsd != null && equityUsd > 0) {
      try {
        const lev = Math.max(
          1,
          Number(process.env.PHOENIX_LEVERAGE || 30) || 30
        );
        const liq = calculateLiquidationPriceUsd({
          positionSize: position,
          entryPriceUsd: entryUsd,
          leverage: lev,
          maintenanceMarginBps: 100,
          collateralUsd: equityUsd,
        });
        if (liq != null && Number.isFinite(liq) && liq > 0) {
          liquidationPrice = liq;
        }
      } catch {
        /* ignore */
      }
    }

    const openOrders: LiveOrder[] = [];
    for (const block of sub?.orders || []) {
      if (String(block.symbol || "").toUpperCase() !== symbol.toUpperCase()) continue;
      for (const o of block.orders || []) {
        if (String(o.status || "").toLowerCase() === "cancelled") continue;
        const size = num(o.sizeRemainingLots ?? o.initialSizeLots) * LOT;
        if (!(size > 0)) continue;
        const price = num(o.priceUsd ?? o.priceTicks);
        const ticks = String(o.priceTicks ?? Math.round(price));
        const seq = String(o.orderSequenceNumber ?? "");
        if (!seq) continue;
        openOrders.push({
          id: orderId(ticks, seq),
          market,
          side: fromPhoenixSide(o.side),
          price,
          size,
          level: 0,
        });
      }
    }

    return {
      venue: this.id,
      market,
      mid,
      position,
      openOrders,
      equityUsd,
      unrealizedPnl,
      liquidationPrice,
    };
  }

  async snapshot(market: string): Promise<VenueSnapshot> {
    const client = this.ensureClient();
    const symbol = await this.resolveSymbol(market);
    if (this.dryRun) {
      let mid = 100_000;
      try {
        mid = await this.fetchMark(symbol);
      } catch {
        /* keep stub */
      }
      return { venue: this.id, market, mid, position: 0, openOrders: [] };
    }
    const { authority } = this.ensureLive();
    const [mid, state] = await Promise.all([
      this.fetchMark(symbol),
      this.fetchTraderState(authority),
    ]);
    void client;
    return this.parseSnapshot(market, symbol, mid, state);
  }

  async apply(intents: Intent[]): Promise<ApplyResult> {
    if (this.dryRun) return dryApply(this.id, intents);
    const { client, authority } = this.ensureLive();
    const result: ApplyResult = {
      placed: 0,
      cancelled: 0,
      failed: 0,
      errors: [],
      placedOrders: [],
    };
    const gapMs = Math.max(0, Number(process.env.PHOENIX_ORDER_GAP_MS || 800) || 800);
    let wrote = 0;

    for (const intent of intents) {
      try {
        if (intent.type === "cancel") {
          const parsed = parseOrderId(intent.orderId);
          if (!parsed) throw new Error(`无法解析 orderId=${intent.orderId}`);
          const symbol = await this.resolveSymbol(intent.market);
          const ix = await client.ixs.buildCancelOrdersById({
            authority,
            symbol,
            orders: [
              {
                price: parsed.priceTicks,
                orderSequenceNumber: String(parsed.seq),
              },
            ],
            traderPdaIndex: 0,
            traderSubaccountIndex: 0,
          });
          await this.sendIxs([ix]);
          result.cancelled += 1;
        } else {
          const size = roundLot(intent.order.size);
          if (!(size > 0)) throw new Error(`size 过小 lot=${LOT}`);
          const symbol = await this.resolveSymbol(intent.order.market);
          // 急跌/急涨时：补单价可能已穿现价；Phoenix post-only 会 MatchingEngine 失败刷屏
          // （SDK slide 对 ask 穿价仍会 fail）。跳过，等 mid 回到格线外侧再补。
          try {
            const mid = await this.fetchMark(symbol);
            const px = Number(intent.order.price);
            if (mid > 0 && Number.isFinite(px)) {
              if (intent.order.side === "sell" && px <= mid) {
                console.log(
                  `[phoenix] skip cross sell@${px} mid=${mid.toFixed(2)}（下轮再补）`
                );
                continue;
              }
              if (intent.order.side === "buy" && px >= mid) {
                console.log(
                  `[phoenix] skip cross buy@${px} mid=${mid.toFixed(2)}（下轮再补）`
                );
                continue;
              }
            }
          } catch {
            /* mark 失败则照常尝试下单 */
          }
          if (wrote > 0 && gapMs > 0) {
            await new Promise((r) => setTimeout(r, gapMs));
          }
          const limitPacket = await client.orderPackets.buildLimitOrderPacket({
            symbol,
            side: toPhoenixSide(intent.order.side),
            priceUsd: String(intent.order.price),
            baseUnits: String(size),
          });
          // 只走 post-only；穿价已在上面跳过，勿 fallback 成可吃单的 limit
          const ix = await client.ixs.buildPlacePostOnlyOrder({
            authority,
            symbol,
            orderPacket: {
              side: limitPacket.side,
              priceInTicks: limitPacket.priceInTicks,
              numBaseLots: limitPacket.numBaseLots,
              clientOrderId: 0n,
              slide: true,
              lastValidSlot: null,
              orderFlags: limitPacket.orderFlags,
              cancelExisting: false,
            },
            traderPdaIndex: 0,
            traderSubaccountIndex: 0,
          });
          await this.sendIxs([ix]);
          result.placed += 1;
          wrote += 1;
        }
      } catch (e: any) {
        result.failed += 1;
        result.errors.push(String(e?.message || e).slice(0, 200));
      }
    }
    return result;
  }

  async cancelAll(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[phoenix:dry] cancelAll ${market}`);
      return;
    }
    const { client, authority } = this.ensureLive();
    const symbol = await this.resolveSymbol(market);
    const ix = await client.ixs.buildCancelAll({
      authority,
      symbol,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    });
    await this.sendIxs([ix]);
  }

  async closePosition(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[phoenix:dry] closePosition ${market}`);
      return;
    }
    const snap = await this.snapshot(market);
    const abs = Math.abs(snap.position);
    const size = roundLot(abs);
    if (!(size > 0)) return;
    const { client, authority } = this.ensureLive();
    const symbol = await this.resolveSymbol(market);
    const side = snap.position > 0 ? PhoenixSide.Ask : PhoenixSide.Bid;
    const packet = await client.orderPackets.buildMarketOrderPacket({
      symbol,
      side,
      baseUnits: String(size),
    });
    (packet as any).orderFlags = OrderFlags.ReduceOnly;
    const ix = await client.ixs.buildPlaceMarketOrder({
      authority,
      symbol,
      orderPacket: packet,
      traderPdaIndex: 0,
      traderSubaccountIndex: 0,
    });
    await this.sendIxs([ix]);
  }
}
