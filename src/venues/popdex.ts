/**
 * PopDEX（Morph Tachyon CLOB）VenueExecutor
 *
 * 读（面板 snapshot）：
 *   GET /api/v1/public/market/tickers
 *   GET /api/v1/account/{wallet}/overview|positions|orders
 *   GET /api/v1/config/symbol
 * 写：
 *   Order 预编译 0x…1000 placeOrder / cancelOrder / cancelAllOrders
 *   经 POST /api/v1/web3/rpc eth_sendRawTransaction（gasless）
 *
 * WS（可选，当前轮询即可）：wss://ws.popdex.xyz/v1/ws/public
 *   ticker / books / order / position / fill / account
 */
import fs from "node:fs";
import path from "node:path";
import {
  createPublicClient,
  createWalletClient,
  custom,
  defineChain,
  encodeFunctionData,
  pad,
  parseUnits,
  stringToHex,
  toHex,
  type Hex,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import type { Intent, LiveOrder, Side, VenueSnapshot } from "../types.js";
import { loadEnv } from "../loadEnv.js";
import {
  dryApply,
  type ApplyResult,
  type FundingQuote,
  type HedgeOrder,
  type HedgeOrderResult,
  type TopOfBook,
  type VenueExecutor,
} from "./types.js";

const API = "https://api.popdex.xyz";
const ORDER = "0x0000000000000000000000000000000000001000" as const;
const CHAIN_ID = 0x888;
const DEFAULT_SYMBOL = "BTCUSDT";
const DEFAULT_SYMBOL_ID = 20000;

const Category = { Spot: 0, Margin: 1, Futures: 2 } as const;
const OrderType = { Limit: 0, Market: 1, Plan: 2, Tpsl: 3 } as const;
const SideEnum = { Buy: 0, Sell: 1 } as const;
const TimeInForce = { Default: 0, GTC: 1, IOC: 2, FOK: 3, PostOnly: 4 } as const;
const MarketUnit = { BaseToken: 0, QuoteToken: 1 } as const;
const PositionSide = { None: 0, Long: 1, Short: 2 } as const;
const OrderCategory = { Regular: 0, Plan: 1, Tpsl: 2 } as const;

const placeAbi = [
  {
    type: "function",
    name: "placeOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "clientOrderId", type: "bytes32" },
      { name: "symbolId", type: "uint16" },
      { name: "orderParams", type: "bytes32" },
      { name: "price", type: "uint256" },
      { name: "qty", type: "uint256" },
      { name: "slippage", type: "uint256" },
      { name: "builder", type: "address" },
      { name: "builderFeeRate", type: "uint256" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

const cancelAbi = [
  {
    type: "function",
    name: "cancelOrder",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "orderId", type: "uint128" },
      { name: "clientOrderId", type: "bytes32" },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

const cancelAllAbi = [
  {
    type: "function",
    name: "cancelAllOrders",
    stateMutability: "nonpayable",
    inputs: [
      { name: "account", type: "address" },
      { name: "symbolId", type: "uint16" },
      {
        name: "category",
        type: "tuple",
        components: [
          { name: "isSome", type: "bool" },
          { name: "value", type: "uint8" },
        ],
      },
      {
        name: "orderCategory",
        type: "tuple",
        components: [
          { name: "isSome", type: "bool" },
          { name: "value", type: "uint8" },
        ],
      },
      {
        name: "isFullPositionTpsl",
        type: "tuple",
        components: [
          { name: "isSome", type: "bool" },
          { name: "value", type: "bool" },
        ],
      },
    ],
    outputs: [{ name: "success", type: "bool" }],
  },
] as const;

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function packOrderParams(p: {
  category: number;
  orderType: number;
  side: number;
  timeInForce: number;
  marketUnit?: number;
  bbo?: number;
  isReduceOnly?: number;
  positionSide?: number;
}): Hex {
  const buf = new Uint8Array(32);
  buf[0] = p.category;
  buf[1] = p.orderType;
  buf[2] = p.side;
  buf[3] = p.timeInForce;
  buf[4] = p.marketUnit ?? 0;
  buf[5] = p.bbo ?? 0;
  buf[6] = p.isReduceOnly ?? 0;
  buf[7] = p.positionSide ?? 0;
  return toHex(buf);
}

function clientOid(label: string): Hex {
  return pad(stringToHex(label.slice(0, 31)), { size: 32, dir: "right" });
}

const popdexChain = defineChain({
  id: CHAIN_ID,
  name: "PopDEX",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [`${API}/api/v1/web3/rpc`] } },
});

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const r = await fetch(`${API}/api/v1/web3/rpc`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = (await r.json()) as { result?: unknown; error?: unknown };
  if (j.error) throw new Error(`rpc ${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function apiGet<T = any>(pathname: string): Promise<T> {
  const r = await fetch(`${API}${pathname}`, {
    headers: { "Content-Type": "application/json", Accept: "application/json" },
  });
  const j = (await r.json()) as { code?: string; msg?: string; data?: T };
  if (String(j.code) !== "200") {
    throw new Error(`${pathname} => ${j.code} ${j.msg || JSON.stringify(j).slice(0, 180)}`);
  }
  return j.data as T;
}

function loadPrivateKey(): Hex {
  loadEnv();
  let raw = (process.env.POPDEX_PRIVATE_KEY || "").trim();
  if (!raw) {
    const keyPath =
      process.env.POPDEX_KEY_PATH?.trim() ||
      path.resolve(process.cwd(), "secrets", "popdex.key");
    if (fs.existsSync(keyPath)) raw = fs.readFileSync(keyPath, "utf8").trim();
  }
  if (!raw) throw new Error("缺少 POPDEX_PRIVATE_KEY（或 secrets/popdex.key）");
  return (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
}

export class PopdexExecutor implements VenueExecutor {
  readonly id = "popdex" as const;
  private account: PrivateKeyAccount | null = null;
  private address = "";
  private symbol = DEFAULT_SYMBOL;
  private symbolId = DEFAULT_SYMBOL_ID;
  private tickSize = 1;
  private lotSize = 0.0001;
  private minQty = 0.0001;
  private minNotional = 10;
  private wallet: ReturnType<typeof createWalletClient> | null = null;
  private pub: ReturnType<typeof createPublicClient> | null = null;
  /** 刚广播过的限价，避免订单簿回显慢时同一价再下一张 */
  private recentPlaces = new Map<number, number>();
  /** 上次可信仓位/挂单，用来丢掉偶发空簿 */
  private lastGoodBook: { position: number; orders: number; equity?: number; at: number } | null =
    null;
  private lastEquity: number | undefined;

  constructor(private dryRun: boolean) {}

  private pruneRecentPlaces(): void {
    const now = Date.now();
    for (const [px, exp] of this.recentPlaces) {
      if (now > exp) this.recentPlaces.delete(px);
    }
  }

  private roundPrice(px: number): number {
    const t = this.tickSize > 0 ? this.tickSize : 1;
    return Math.round(px / t) * t;
  }

  private roundSize(size: number): number {
    if (!(size > 0)) return 0;
    const lot = this.lotSize > 0 ? this.lotSize : 0.0001;
    const rounded = Math.floor(size / lot + 1e-12) * lot;
    return Number(rounded.toFixed(8));
  }

  private ensureSize(size: number, price: number): number {
    let s = this.roundSize(size);
    const minByNotional =
      price > 0 ? Math.ceil(this.minNotional / price / this.lotSize) * this.lotSize : this.minQty;
    const minSz = Math.max(this.minQty, minByNotional);
    if (s > 0 && s < minSz) s = minSz;
    return Number(s.toFixed(8));
  }

  async connect(): Promise<void> {
    loadEnv();
    this.symbol = (process.env.POPDEX_SYMBOL || DEFAULT_SYMBOL).trim() || DEFAULT_SYMBOL;
    try {
      const cfg = await apiGet<any>(
        `/api/v1/config/symbol?symbol=${encodeURIComponent(this.symbol)}&category=Futures`
      );
      this.symbolId = Math.max(1, num(cfg.symbolId, DEFAULT_SYMBOL_ID));
      this.tickSize = num(cfg.tickSize, 1) || 1;
      this.lotSize = num(cfg.lotSize, 0.0001) || 0.0001;
      this.minQty = num(cfg.minQty, this.lotSize) || this.lotSize;
      this.minNotional = num(cfg.minNotional, 10) || 10;
    } catch (e: any) {
      console.warn(`[popdex] symbol config fallback: ${String(e?.message || e).slice(0, 120)}`);
    }

    if (this.dryRun && !(process.env.POPDEX_PRIVATE_KEY || "").trim()) {
      const keyPath =
        process.env.POPDEX_KEY_PATH?.trim() ||
        path.resolve(process.cwd(), "secrets", "popdex.key");
      if (!fs.existsSync(keyPath)) {
        console.log(
          `[popdex] dry-run connected symbol=${this.symbol} id=${this.symbolId} (no key)`
        );
        return;
      }
    }

    const pk = loadPrivateKey();
    this.account = privateKeyToAccount(pk);
    this.address = this.account.address;
    const transport = custom({
      async request({ method, params }) {
        const args = [...((params as unknown[]) ?? [])];
        // Pop 的 latest nonce 明显落后于写节点要求；写交易必须取 pending，
        // 否则会持续报 "nonce is too low" 而无法补单/撤单。
        if (method === "eth_getTransactionCount") {
          if (args.length >= 2) args[1] = "pending";
          else args.push("pending");
        }
        return rpc(method, args);
      },
    });
    this.wallet = createWalletClient({
      account: this.account,
      chain: popdexChain,
      transport,
    });
    this.pub = createPublicClient({ chain: popdexChain, transport });
    console.log(
      `[popdex] address=${this.address} symbol=${this.symbol} id=${this.symbolId} tick=${this.tickSize} lot=${this.lotSize}`
    );
  }

  disconnect(): void {
    this.account = null;
    this.wallet = null;
    this.pub = null;
    this.address = "";
  }

  private async mid(): Promise<number> {
    const rows = await apiGet<any[]>(
      `/api/v1/public/market/tickers?category=Futures&symbol=${encodeURIComponent(this.symbol)}`
    );
    const list = Array.isArray(rows) ? rows : [];
    const t =
      list.find((x) => String(x.symbol).toUpperCase() === this.symbol.toUpperCase()) || list[0];
    if (!t) throw new Error("PopDEX 无 ticker");
    const bid = num(t.bid1Price);
    const ask = num(t.ask1Price);
    const mark = num(t.markPrice);
    const last = num(t.lastPrice);
    const mid =
      bid > 0 && ask > 0 ? (bid + ask) / 2 : mark > 0 ? mark : last > 0 ? last : 0;
    if (!(mid > 0)) throw new Error("PopDEX 无效 mid");
    return mid;
  }

  async topOfBook(_market: string): Promise<TopOfBook> {
    const book = await apiGet<any>(
      `/api/v1/public/market/orderbook?category=Futures&symbol=${encodeURIComponent(this.symbol)}&levels=5`
    );
    const bid = num(book?.bids?.[0]?.[0]);
    const ask = num(book?.asks?.[0]?.[0]);
    if (!(bid > 0 && ask > bid)) throw new Error("PopDEX 无有效 bid/ask");
    return { bid, ask, updatedAt: Date.now() };
  }

  async fundingQuote(_market: string): Promise<FundingQuote> {
    const rows = await apiGet<any[]>(
      `/api/v1/market/funding-rate?symbol=${encodeURIComponent(this.symbol)}`
    );
    const row = Array.isArray(rows) ? rows[0] : rows;
    const rate = num(row?.fundingRate, NaN);
    if (!Number.isFinite(rate)) throw new Error("PopDEX 无 funding rate");
    const intervalHours = num(row?.fundingRateInterval, NaN);
    const next = num(row?.nextUpdate, NaN);
    return {
      rate,
      intervalMs:
        Number.isFinite(intervalHours) && intervalHours > 0
          ? intervalHours * 3_600_000
          : undefined,
      nextFundingAt: Number.isFinite(next) && next > 0 ? next : undefined,
      source: "popdex-funding-rate",
    };
  }

  private async readEquity(addr: string): Promise<number | undefined> {
    for (let i = 0; i < 3; i++) {
      try {
        const overview = await apiGet<any>(`/api/v1/account/${addr}/overview`);
        const eq = num(
          overview?.accountEquity ?? overview?.totalCollateral ?? overview?.balances?.[0]?.usdValue,
          NaN
        );
        if (Number.isFinite(eq) && eq > 0) {
          this.lastEquity = eq;
          return eq;
        }
      } catch {
        /* Pop overview 常 10700，重试后再用缓存 */
      }
    }
    return this.lastEquity;
  }

  async snapshot(market: string): Promise<VenueSnapshot> {
    if (this.dryRun && !this.address) {
      const mid = await this.mid().catch(() => 100_000);
      return { venue: this.id, market, mid, position: 0, openOrders: [] };
    }
    const addr = this.address || (await this.resolveAddressOnly());
    const mid = await this.mid();
    const overviewEq = await this.readEquity(addr);
    let positions: any[] = [];
    let orders: any[] = [];
    let readErr = "";
    try {
      positions = await apiGet<any[]>(`/api/v1/account/${addr}/positions`);
    } catch (e: any) {
      readErr = String(e?.message || e);
    }
    try {
      orders = await apiGet<any[]>(
        `/api/v1/account/${addr}/orders?status=pending&category=Futures&symbol=${encodeURIComponent(this.symbol)}`
      );
    } catch (e: any) {
      readErr = readErr || String(e?.message || e);
    }
    if (readErr) {
      const prev = this.lastGoodBook;
      if (prev && Date.now() - prev.at < 300_000 && (Math.abs(prev.position) > 1e-8 || prev.orders > 0)) {
        throw new Error(`stale empty book (${readErr.slice(0, 80)})`);
      }
      throw new Error(readErr);
    }

    let position = 0;
    let unrealizedPnl: number | undefined;
    for (const p of positions || []) {
      if (String(p.symbol || "").toUpperCase() !== this.symbol.toUpperCase()) continue;
      // PopDEX 实盘字段：holdQty + positionSide(Long/Short)；兼容 size/qty
      const sz = num(
        p.holdQty ?? p.size ?? p.holdSize ?? p.qty ?? p.positionSize
      );
      const side = String(p.side || p.positionSide || "").toLowerCase();
      const signed =
        side.includes("short") || side === "sell" ? -Math.abs(sz) : Math.abs(sz);
      // oneway 也可能用正负 size
      if (p.size != null && Number(p.size) < 0) position += num(p.size);
      else position += signed;
      const upl = num(
        p.unPnl ?? p.unrealizedPnl ?? p.upl ?? p.unrealizedProfit,
        NaN
      );
      if (Number.isFinite(upl)) unrealizedPnl = (unrealizedPnl ?? 0) + upl;
    }

    const openOrders: LiveOrder[] = [];
    for (const o of orders || []) {
      const rem = num(o.remainingQty ?? o.qty);
      if (!(rem > 0)) continue;
      const sideRaw = String(o.side || "").toLowerCase();
      const side: Side = sideRaw.startsWith("s") ? "sell" : "buy";
      openOrders.push({
        id: o.orderId
          ? `${String(o.orderId)}:${String(o.clientOid || "")}`
          : String(o.clientOid || ""),
        market,
        side,
        price: this.roundPrice(num(o.price)),
        size: rem,
        level: 0,
      });
    }

    const equityUsd =
      overviewEq != null && Number.isFinite(overviewEq) && overviewEq > 0
        ? overviewEq
        : this.lastEquity;
    const liveOrders = openOrders.filter((o) => o.id);
    const empty = Math.abs(position) < 1e-12 && liveOrders.length === 0;
    const prev = this.lastGoodBook;
    if (
      empty &&
      prev &&
      Date.now() - prev.at < 90_000 &&
      (Math.abs(prev.position) > 1e-8 || prev.orders > 0)
    ) {
      throw new Error(
        `stale empty book (last pos=${prev.position} oo=${prev.orders})`
      );
    }
    this.lastGoodBook = {
      position,
      orders: liveOrders.length,
      equity: equityUsd,
      at: Date.now(),
    };
    return {
      venue: this.id,
      market,
      mid,
      position,
      openOrders: liveOrders,
      equityUsd,
      unrealizedPnl:
        unrealizedPnl != null && Number.isFinite(unrealizedPnl) ? unrealizedPnl : undefined,
    };
  }

  private async resolveAddressOnly(): Promise<string> {
    if (this.address) return this.address;
    const pk = loadPrivateKey();
    this.account = privateKeyToAccount(pk);
    this.address = this.account.address;
    return this.address;
  }

  private async send(to: Hex, data: Hex, gas = 500_000n): Promise<Hex> {
    if (!this.wallet || !this.pub || !this.account) {
      throw new Error("PopDEX 未 connect");
    }
    const hash = await this.wallet.sendTransaction({
      to,
      data,
      value: 0n,
      gas,
      gasPrice: 0n,
    });
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const receipt = await this.pub.getTransactionReceipt({ hash }).catch(() => null);
      if (receipt) {
        if (receipt.status !== "success") {
          throw new Error(`tx reverted ${hash}`);
        }
        return hash;
      }
    }
    console.warn(`[popdex] tx receipt timeout ${hash}`);
    return hash;
  }

  async apply(intents: Intent[]): Promise<ApplyResult> {
    if (this.dryRun) return dryApply(this.id, intents);
    const result: ApplyResult = { placed: 0, cancelled: 0, failed: 0, errors: [] };
    const gapMs = Math.max(0, Number(process.env.POPDEX_ORDER_GAP_MS || 200) || 200);
    let wrote = 0;
    let liveMid = 0;
    try {
      liveMid = await this.mid();
    } catch {
      /* place 时再试 */
    }

    for (const intent of intents) {
      try {
        if (intent.type === "cancel") {
          const id = String(intent.orderId || "");
          const [orderId, oidRaw = ""] = id.split(":", 2);
          if (!/^\d+$/.test(orderId)) throw new Error(`无效 orderId=${id}`);
          const oid = oidRaw
            ? pad(stringToHex(oidRaw.slice(0, 31)), { size: 32, dir: "right" })
            : pad("0x", { size: 32 });
          const data = encodeFunctionData({
            abi: cancelAbi,
            functionName: "cancelOrder",
            args: [this.address as Hex, BigInt(orderId), oid],
          });
          if (wrote > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
          await this.send(ORDER, data, 300_000n);
          result.cancelled += 1;
          wrote += 1;
        } else {
          const px = this.roundPrice(intent.order.price);
          if (!(px > 0)) throw new Error(`无效价格 ${intent.order.price}`);
          const size = this.ensureSize(intent.order.size, px);
          if (!(size > 0)) throw new Error(`size 过小 lot=${this.lotSize}`);
          this.pruneRecentPlaces();
          if (this.recentPlaces.has(px)) {
            console.log(`[popdex] skip duplicate place @${px}`);
            continue;
          }

          if (liveMid > 0) {
            if (intent.order.side === "sell" && px <= liveMid) {
              console.log(`[popdex] skip cross sell@${px} mid=${liveMid.toFixed(2)}`);
              continue;
            }
            if (intent.order.side === "buy" && px >= liveMid) {
              console.log(`[popdex] skip cross buy@${px} mid=${liveMid.toFixed(2)}`);
              continue;
            }
          }

          if (wrote > 0 && gapMs > 0) await new Promise((r) => setTimeout(r, gapMs));
          const oid = clientOid(`g${Date.now().toString(36)}${wrote}`);
          const orderParams = packOrderParams({
            category: Category.Futures,
            orderType: OrderType.Limit,
            side: intent.order.side === "buy" ? SideEnum.Buy : SideEnum.Sell,
            timeInForce: TimeInForce.PostOnly,
            marketUnit: MarketUnit.BaseToken,
            positionSide: PositionSide.None,
          });
          const data = encodeFunctionData({
            abi: placeAbi,
            functionName: "placeOrder",
            args: [
              this.address as Hex,
              oid,
              this.symbolId,
              orderParams,
              parseUnits(String(px), 18),
              parseUnits(String(size), 18),
              0n,
              "0x0000000000000000000000000000000000000000",
              0n,
            ],
          });
          try {
            await this.send(ORDER, data);
          } catch (e: any) {
            // Pop RPC 偶发返回 unknown error，但交易实际已接收；先冷却该价位，
            // 等订单簿回显后再决定是否重试，避免同价重复挂单。
            if (/unknown RPC error/i.test(String(e?.message || e))) {
              this.recentPlaces.set(px, Date.now() + 120_000);
            }
            throw e;
          }
          this.recentPlaces.set(px, Date.now() + 120_000);
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
      console.log(`[popdex:dry] cancelAll ${market}`);
      return;
    }
    const data = encodeFunctionData({
      abi: cancelAllAbi,
      functionName: "cancelAllOrders",
      args: [
        this.address as Hex,
        this.symbolId,
        { isSome: true, value: Category.Futures },
        { isSome: true, value: OrderCategory.Regular },
        { isSome: false, value: false },
      ],
    });
    await this.send(ORDER, data, 400_000n);
  }

  private async submitHedgeOrder(
    order: HedgeOrder,
    marketOrder: boolean
  ): Promise<HedgeOrderResult> {
    if (this.dryRun) {
      return {
        accepted: true,
        confirmed: true,
        orderId: marketOrder ? "dry-pop-ioc" : "dry-pop-limit",
      };
    }
    if (!this.address) throw new Error("PopDEX 未 connect");
    const mid = await this.mid();
    const size = this.ensureSize(order.size, mid);
    if (!(size > 0)) throw new Error("PopDEX hedge size 过小");
    const px = marketOrder ? 0 : this.roundPrice(Number(order.price));
    if (!marketOrder && !(px > 0)) throw new Error("PopDEX hedge limit 缺少价格");
    const oid = clientOid(order.clientOrderId || `h${Date.now().toString(36)}`);
    const orderParams = packOrderParams({
      category: Category.Futures,
      orderType: marketOrder ? OrderType.Market : OrderType.Limit,
      side: order.side === "buy" ? SideEnum.Buy : SideEnum.Sell,
      timeInForce: marketOrder ? TimeInForce.IOC : TimeInForce.PostOnly,
      marketUnit: MarketUnit.BaseToken,
      isReduceOnly: order.reduceOnly === true ? 1 : 0,
      positionSide: PositionSide.None,
    });
    const data = encodeFunctionData({
      abi: placeAbi,
      functionName: "placeOrder",
      args: [
        this.address as Hex,
        oid,
        this.symbolId,
        orderParams,
        marketOrder ? 0n : parseUnits(String(px), 18),
        parseUnits(String(size), 18),
        marketOrder
          ? parseUnits(String(order.maxSlippagePct ?? 0.003), 18)
          : 0n,
        "0x0000000000000000000000000000000000000000",
        0n,
      ],
    });
    const txHash = await this.send(ORDER, data);
    const receipt = this.pub
      ? await this.pub
          .getTransactionReceipt({ hash: txHash })
          .catch(() => null)
      : null;
    return {
      accepted: true,
      confirmed: receipt?.status === "success",
      txHash,
      note: receipt ? undefined : "receipt-pending",
    };
  }

  async placeHedgeLimit(order: HedgeOrder): Promise<HedgeOrderResult> {
    return this.submitHedgeOrder(order, false);
  }

  async placeHedgeIoc(order: HedgeOrder): Promise<HedgeOrderResult> {
    return this.submitHedgeOrder(order, true);
  }

  async closePosition(market: string, sizeBase?: number | null): Promise<void> {
    if (this.dryRun) {
      console.log(`[popdex:dry] closePosition ${market}${sizeBase != null ? ` size=${sizeBase}` : ""}`);
      return;
    }
    const snap = await this.snapshot(market);
    const pos = snap.position;
    if (!(Math.abs(pos) > this.minQty / 2)) return;
    const mid = snap.mid > 0 ? snap.mid : await this.mid();
    const want =
      sizeBase != null && sizeBase > 0 ? Math.min(Math.abs(sizeBase), Math.abs(pos)) : Math.abs(pos);
    const size = this.ensureSize(want, mid);
    const isLong = pos > 0;
    const orderParams = packOrderParams({
      category: Category.Futures,
      orderType: OrderType.Market,
      side: isLong ? SideEnum.Sell : SideEnum.Buy,
      timeInForce: TimeInForce.IOC,
      marketUnit: MarketUnit.BaseToken,
      isReduceOnly: 1,
      positionSide: PositionSide.None,
    });
    const oid = clientOid(`c${Date.now().toString(36)}`);
    const data = encodeFunctionData({
      abi: placeAbi,
      functionName: "placeOrder",
      args: [
        this.address as Hex,
        oid,
        this.symbolId,
        orderParams,
        0n,
        parseUnits(String(size), 18),
        parseUnits("0.01", 18),
        "0x0000000000000000000000000000000000000000",
        0n,
      ],
    });
    await this.send(ORDER, data);
  }
}
