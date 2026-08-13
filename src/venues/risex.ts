import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { calculateLiquidationPriceUsd } from "@ellipsis-labs/rise";
import type { Intent, VenueSnapshot } from "../types.js";
import { loadEnv } from "../loadEnv.js";
import { dryApply, type ApplyResult, type VenueExecutor } from "./types.js";

type RiseExchange = {
  init(): Promise<boolean>;
  stop(): void;
  marketIdForName(name: string): number | null;
  getPrice(marketId: number): Promise<number>;
  getPosition(marketId: number): {
    sizeBase: number;
    entryPrice?: number;
    unrealizedPnl?: number;
    liquidationPrice?: number | null;
    leverage?: number | null;
  } | null;
  getAllPositions?: () => Array<{
    marketId: number | null;
    market?: string;
    entryPrice?: number;
    unrealizedPnl?: number;
    liquidationPrice?: number | null;
    leverage?: number | null;
  }>;
  refreshOpenOrders(marketId: number): Promise<
    Array<{ orderId: string; side: string; price: number; sizeBase: number }>
  >;
  _refreshAllPositions(): Promise<unknown>;
  placeLimitOrder(o: {
    marketId: number;
    side: string;
    price: number;
    sizeBase: number;
    postOnly?: boolean;
  }): Promise<{ orderId: string }>;
  cancelOrder(marketId: number, orderId: string): Promise<unknown>;
  cancelAllConfirmed(marketId: number, opts?: { attempts?: number }): Promise<unknown>;
  closePosition(marketId: number): Promise<unknown>;
  setLeverage(marketId: number, leverage: number): Promise<unknown>;
  markets: Map<number, { name: string; symbol?: string }>;
};

function resolveMarketName(market: string): string {
  const m = market.toUpperCase();
  return m.includes("-") ? m : `${m}-PERP`;
}

export class RisexExecutor implements VenueExecutor {
  readonly id = "risex" as const;
  private ex: RiseExchange | null = null;
  private equityCache: { at: number; value: number | undefined } = { at: 0, value: undefined };
  constructor(private dryRun: boolean) {}

  async connect(): Promise<void> {
    if (this.dryRun) return;
    loadEnv();
    delete process.env.RISEX_PROXY;
    if (process.env.RISE_ORDER_GAP_MS == null || process.env.RISE_ORDER_GAP_MS === "") {
      process.env.RISE_ORDER_GAP_MS = "10500";
    }
    const account = process.env.RISEX_ACCOUNT?.trim();
    const signerKey = process.env.RISEX_SIGNER_KEY?.trim();
    const apiUrl = (process.env.RISEX_API_URL || "https://api.rise.trade").replace(/\/$/, "");
    const wsUrl = process.env.RISEX_WS_URL || "wss://ws.rise.trade/ws";
    if (!account || !signerKey) throw new Error("缺少 RISEX_ACCOUNT / RISEX_SIGNER_KEY");
    const vendor = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../vendor/risex/index.js"
    );
    const mod = await import(pathToFileURL(vendor).href);
    this.ex = mod.createExchange({ account, signerKey, apiUrl, wsUrl }) as RiseExchange;
    await this.ex.init();
    if (process.env.GRID_SKIP_LEVERAGE !== "1" && process.env.RISE_SKIP_LEVERAGE !== "1") {
      // RISEx 所上杠杆硬顶约 25：优先 RISEX_LEVERAGE，默认 25，不被 GRID_LEVERAGE=30 带偏
      const riseLev = Math.max(
        1,
        Number(process.env.RISEX_LEVERAGE || process.env.RISE_LEVERAGE || 25) || 25
      );
      await this.ex.setLeverage(this.marketId("BTC"), riseLev);
    }
  }

  disconnect(): void {
    this.ex?.stop();
    this.ex = null;
  }

  private ensure(): RiseExchange {
    if (!this.ex) throw new Error("RISEx 未 connect");
    return this.ex;
  }

  private marketId(market: string): number {
    const ex = this.ensure();
    const want = resolveMarketName(market);
    let id = ex.marketIdForName(want);
    if (id != null) return id;
    const key = market.toUpperCase().replace(/-USD$/, "").replace(/-PERP$/, "");
    for (const [mid, m] of ex.markets) {
      if (
        String(m.name).toUpperCase().includes(key) ||
        String(m.symbol || "").toUpperCase() === key
      ) {
        return mid;
      }
    }
    throw new Error(`RISEx 无市场 ${want}`);
  }

  private async readEquity(ex: RiseExchange): Promise<number | undefined> {
    const now = Date.now();
    if (now - this.equityCache.at < 60_000 && this.equityCache.value != null) {
      return this.equityCache.value;
    }
    try {
      await (ex as any)._refreshAccount?.();
      const v = Number((ex as any).equity ?? (ex as any).balance);
      const value = Number.isFinite(v) && v > 0 ? v : undefined;
      this.equityCache = { at: now, value };
      return value;
    } catch {
      return this.equityCache.value;
    }
  }

  async snapshot(market: string): Promise<VenueSnapshot> {
    if (this.dryRun) {
      return { venue: this.id, market, mid: 100_000, position: 0, openOrders: [] };
    }
    const ex = this.ensure();
    const marketId = this.marketId(market);
    await ex._refreshAllPositions();
    const oo = await ex.refreshOpenOrders(marketId);
    const mid = await ex.getPrice(marketId);
    const pos = ex.getPosition(marketId);
    const equityUsd = await this.readEquity(ex);
    const all =
      typeof ex.getAllPositions === "function" ? ex.getAllPositions() : [];
    const detail =
      all.find((p) => p.marketId === marketId) ||
      all.find((p) => /BTC/i.test(String(p.market || "")));
    const upnl = pos?.unrealizedPnl ?? detail?.unrealizedPnl;
    let liq = detail?.liquidationPrice ?? pos?.liquidationPrice;
    // RISEx 仓位 API 无 liquidation_price；用保证金公式估算（与仓位/权益同源）
    if (!(liq != null && Number(liq) > 0)) {
      const entry = Number(detail?.entryPrice ?? pos?.entryPrice ?? 0);
      const size = Number(pos?.sizeBase ?? 0);
      const lev = Math.max(
        1,
        Number(detail?.leverage ?? pos?.leverage ?? process.env.RISEX_LEVERAGE ?? 25) || 25
      );
      const coll = Number(equityUsd ?? 0);
      if (entry > 0 && Math.abs(size) > 0 && coll > 0) {
        try {
          const est = calculateLiquidationPriceUsd({
            positionSize: size,
            entryPriceUsd: entry,
            leverage: lev,
            maintenanceMarginBps: 200,
            collateralUsd: coll,
          });
          if (est != null && Number.isFinite(est) && est > 0) liq = est;
        } catch {
          /* ignore */
        }
      }
    }
    return {
      venue: this.id,
      market,
      mid,
      position: pos?.sizeBase ?? 0,
      openOrders: oo.map((o) => ({
        id: String(o.orderId),
        market,
        side: o.side === "sell" ? "sell" : "buy",
        price: Number(o.price),
        size: Number(o.sizeBase),
        level: 0,
      })),
      equityUsd,
      unrealizedPnl:
        upnl != null && Number.isFinite(Number(upnl)) ? Number(upnl) : undefined,
      liquidationPrice:
        liq != null && Number.isFinite(Number(liq)) && Number(liq) > 0
          ? Number(liq)
          : undefined,
    };
  }

  async apply(intents: Intent[]): Promise<ApplyResult> {
    if (this.dryRun) return dryApply(this.id, intents);
    const result: ApplyResult = {
      placed: 0,
      cancelled: 0,
      failed: 0,
      errors: [],
      placedOrders: [],
    };
    const ex = this.ensure();
    for (const intent of intents) {
      try {
        if (intent.type === "cancel") {
          await ex.cancelOrder(this.marketId(intent.market), intent.orderId);
          result.cancelled += 1;
        } else {
          const placed = await ex.placeLimitOrder({
            marketId: this.marketId(intent.order.market),
            side: intent.order.side,
            price: intent.order.price,
            sizeBase: intent.order.size,
            postOnly: true,
          });
          result.placed += 1;
          result.placedOrders.push({ id: placed.orderId, order: intent.order });
        }
      } catch (e: any) {
        const msg = String(e?.message || e);
        // 市场硬顶 50：plan 侧已限流；竞态仍顶满时静默跳过，避免刷屏
        if (/max open orders/i.test(msg) || /\b50\/50\b/.test(msg)) {
          continue;
        }
        result.failed += 1;
        result.errors.push(msg.slice(0, 200));
      }
    }
    return result;
  }

  async cancelAll(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[risex:dry] cancelAll ${market}`);
      return;
    }
    await this.ensure().cancelAllConfirmed(this.marketId(market), { attempts: 5 });
  }

  async closePosition(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[risex:dry] closePosition ${market}`);
      return;
    }
    await this.ensure().closePosition(this.marketId(market));
  }
}
