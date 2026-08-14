import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { FillMode, Nord, NordUser, Side, calcCurrPosLiqPrice } from "@n1xyz/nord-ts";
import { Connection } from "@solana/web3.js";
import type { Intent, VenueSnapshot } from "../types.js";
import { loadEnv } from "../loadEnv.js";
import { dryApply, type ApplyResult, type VenueExecutor } from "./types.js";

const MARKET_ID = 0;
const DEFAULT_APP = "zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5";
const DEFAULT_API = "https://zo-mainnet.n1.xyz";
const DEFAULT_SOLANA = "https://api.mainnet-beta.solana.com";
const MAX_SAFE_CLIENT_ID = (1n << 52n) - 1n;

const uint8Prototype = Uint8Array.prototype as Uint8Array & { toHex?: () => string };
if (typeof uint8Prototype.toHex !== "function") {
  Object.defineProperty(Uint8Array.prototype, "toHex", {
    configurable: true,
    value(this: Uint8Array) {
      return Buffer.from(this).toString("hex");
    },
  });
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function signedPerpSize(perp: any): number {
  const size = num(perp?.baseSize);
  if (perp?.isLong === true) return Math.abs(size);
  if (perp?.isLong === false) return -Math.abs(size);
  return size;
}

function clientOrderId(tag: string): bigint {
  const digest = crypto.createHash("sha256").update(tag).digest();
  const value = digest.readBigUInt64BE(0) & MAX_SAFE_CLIENT_ID;
  return value === 0n ? 1n : value;
}

export class N1Executor implements VenueExecutor {
  readonly id = "n1" as const;
  private nord: any = null;
  private user: any = null;
  private accountId: number | null = null;
  private sessionExpiresAt = 0;
  constructor(private dryRun: boolean) {}

  async connect(): Promise<void> {
    if (this.dryRun) return;
    loadEnv();
    const keyPath =
      process.env.N1_KEYPAIR_PATH?.trim() ||
      path.resolve(process.cwd(), "secrets", "id.json");
    if (!fs.existsSync(keyPath)) {
      throw new Error(`缺少 N1 keypair：${keyPath}（设 N1_KEYPAIR_PATH 或放 secrets/id.json）`);
    }
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")));
    this.nord = await Nord.new({
      app: process.env.N1_APP_PUBLIC_KEY || DEFAULT_APP,
      solanaConnection: new Connection(process.env.N1_SOLANA_RPC || DEFAULT_SOLANA, "confirmed"),
      webServerUrl: process.env.N1_API_URL || DEFAULT_API,
    });
    this.user = NordUser.fromPrivateKey(this.nord, secret);
    await this.user.updateAccountId();
    await this.user.fetchInfo();
    const ids = this.user.accountIds ?? [];
    if (ids.length !== 1) throw new Error(`N1 需要恰好 1 个账户，got ${ids.join(",")}`);
    this.accountId = ids[0];
  }

  disconnect(): void {
    this.nord = null;
    this.user = null;
    this.accountId = null;
  }

  private ensure(): void {
    if (!this.nord || !this.user || this.accountId == null) throw new Error("N1 未 connect");
  }

  private async ensureSession(): Promise<void> {
    const now = Date.now();
    if (now + 5 * 60_000 < this.sessionExpiresAt) return;
    const expiry = Math.floor(now / 1000) + 12 * 60 * 60;
    await this.user.refreshSession(BigInt(expiry));
    this.sessionExpiresAt = expiry * 1000;
  }

  async snapshot(market: string): Promise<VenueSnapshot> {
    if (this.dryRun) {
      return { venue: this.id, market, mid: 100_000, position: 0, openOrders: [] };
    }
    this.ensure();
    await this.user.fetchInfo();
    const marketStats = await this.nord.getMarketStats({ marketId: MARKET_ID });
    const accountKey = String(this.accountId);
    const positionRows = (this.user.positions[accountKey] ?? []).filter(
      (row: any) => Number(row.marketId) === MARKET_ID && row.perp
    );
    const position = positionRows.reduce(
      (sum: number, row: any) => sum + signedPerpSize(row.perp),
      0
    );
    const mid = num(marketStats?.perpStats?.mark_price, marketStats?.indexPrice);
    let unrealizedPnl: number | undefined;
    let liquidationPrice: number | undefined;
    if (positionRows.length && mid > 0) {
      let sum = 0;
      let ok = false;
      for (const row of positionRows) {
        const perp = row.perp || row;
        const sz = signedPerpSize(perp);
        // N1 官方：sizePricePnl / tradingPnl；否则用 price(均价)×标记
        const direct = Number(
          perp.sizePricePnl ??
            perp.tradingPnl ??
            perp.unrealizedPnl ??
            perp.unrealized_pnl ??
            NaN
        );
        if (Number.isFinite(direct)) {
          sum += direct;
          ok = true;
        } else {
          const entry = num(perp.price ?? perp.entryPrice ?? perp.avgEntryPrice ?? row.entryPrice);
          if (entry > 0 && Math.abs(sz) > 0) {
            sum += sz * (mid - entry);
            ok = true;
          }
        }
      }
      if (ok) unrealizedPnl = sum;

      // 官方公式 calcCurrPosLiqPrice（与网页爆仓价同源）
      try {
        const marg = this.user.margins?.[accountKey];
        const equity = Number(marg?.mf ?? marg?.omf);
        const first = positionRows[0]?.perp || positionRows[0];
        const sz = Math.abs(signedPerpSize(first));
        const isLong = first?.isLong !== false && signedPerpSize(first) >= 0;
        const notional = sz * mid;
        const mmf = Number(marg?.mmf);
        const mmfBase =
          Number.isFinite(mmf) && notional > 0 ? mmf / notional : NaN;
        if (sz > 0 && equity > 0 && Number.isFinite(mmfBase) && mmfBase > 0) {
          const liq = calcCurrPosLiqPrice({
            baseSize: sz,
            isLong,
            indexPrice: mid,
            mmfBase,
            accountEquity: equity,
            otherPositionsMmf: 0,
          });
          const nLiq = liq != null ? Number(liq.toString()) : NaN;
          if (Number.isFinite(nLiq) && nLiq > 0) liquidationPrice = nLiq;
        }
      } catch {
        /* ignore */
      }
    }
    const orders = (this.user.orders[accountKey] ?? [])
      .filter((row: any) => Number(row.marketId) === MARKET_ID)
      .map((row: any) => ({
        id: String(row.orderId),
        market,
        side: (row.side === "bid" || row.side === "Bid" ? "buy" : "sell") as "buy" | "sell",
        price: num(row.price ?? row.placedPrice),
        size: num(row.size ?? row.originalOrderSize),
        level: 0,
      }));
    const bals = this.user.balances?.[accountKey] ?? [];
    const usdc = bals.find((b: any) => String(b.symbol || "").toUpperCase() === "USDC");
    const marg = this.user.margins?.[accountKey];
    const eq = Number(usdc?.balance ?? marg?.mf ?? marg?.omf);
    const equityUsd = Number.isFinite(eq) && eq > 0 ? eq : undefined;
    return {
      venue: this.id,
      market,
      mid,
      position,
      openOrders: orders,
      equityUsd,
      unrealizedPnl,
      liquidationPrice,
    };
  }

  async apply(intents: Intent[]): Promise<ApplyResult> {
    if (this.dryRun) return dryApply(this.id, intents);
    this.ensure();
    if (process.env.N1_TRADING_ARMED !== "YES") {
      throw new Error("N1 trading not armed：设 N1_TRADING_ARMED=YES");
    }
    const result: ApplyResult = {
      placed: 0,
      cancelled: 0,
      failed: 0,
      errors: [],
      placedOrders: [],
    };
    for (const intent of intents) {
      try {
        await this.ensureSession();
        if (intent.type === "cancel") {
          await this.user.cancelOrder(BigInt(intent.orderId), this.accountId);
          result.cancelled += 1;
        } else {
          const tag = `grid:${intent.order.side}:${intent.order.level}:${intent.order.price}`;
          const receipt = await this.user.placeOrder({
            marketId: MARKET_ID,
            side: intent.order.side === "buy" ? Side.Bid : Side.Ask,
            fillMode: FillMode.PostOnly,
            isReduceOnly: false,
            size: intent.order.size,
            price: intent.order.price,
            accountId: this.accountId,
            clientOrderId: clientOrderId(tag),
          });
          if (!receipt.orderId) throw new Error("N1 place missing orderId");
          result.placed += 1;
          result.placedOrders.push({ id: String(receipt.orderId), order: intent.order });
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
      console.log(`[n1:dry] cancelAll ${market}`);
      return;
    }
    this.ensure();
    await this.user.fetchInfo();
    const rows = (this.user.orders[String(this.accountId)] ?? []).filter(
      (row: any) => Number(row.marketId) === MARKET_ID
    );
    await this.ensureSession();
    for (const row of rows) {
      await this.user.cancelOrder(BigInt(row.orderId), this.accountId);
    }
  }

  async closePosition(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[n1:dry] closePosition ${market}`);
      return;
    }
    if (process.env.N1_TRADING_ARMED !== "YES") {
      throw new Error("N1 trading not armed：设 N1_TRADING_ARMED=YES");
    }
    this.ensure();
    const snap = await this.snapshot(market);
    const pos = Number(snap.position) || 0;
    if (Math.abs(pos) < 1e-12) return;
    const mid = snap.mid > 0 ? snap.mid : 0;
    if (!(mid > 0)) throw new Error("closePosition: no mid");
    const side = pos > 0 ? Side.Ask : Side.Bid;
    const price = pos > 0 ? mid * 0.992 : mid * 1.008;
    await this.ensureSession();
    const receipt = await this.user.placeOrder({
      marketId: MARKET_ID,
      side,
      fillMode: FillMode.ImmediateOrCancel,
      isReduceOnly: true,
      size: Math.abs(pos),
      price,
      accountId: this.accountId,
      clientOrderId: clientOrderId(`flat:${Date.now()}`),
    });
    if (!receipt.orderId) throw new Error("N1 close missing orderId");
  }
}
