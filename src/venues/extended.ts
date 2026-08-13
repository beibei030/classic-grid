import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Intent, VenueSnapshot } from "../types.js";
import { loadEnv } from "../loadEnv.js";
import { dryApply, type ApplyResult, type VenueExecutor } from "./types.js";

type ExtendedExchange = {
  init(): Promise<boolean>;
  stop(): void;
  marketIdForName(name: string): number | null;
  getPrice(marketId: number): Promise<number>;
  getPosition(marketId: number): {
    sizeBase: number;
    entryPrice?: number;
    unrealizedPnl?: number;
    liquidationPrice?: number | null;
  } | null;
  getAllPositions?: () => Array<{
    marketId: number | null;
    market?: string;
    unrealizedPnl?: number;
    liquidationPrice?: number | null;
  }>;
  getAllOpenOrders(): Array<{
    orderId: string;
    externalId?: string;
    marketId: number | null;
    side: string;
    price: number;
    sizeBase: number;
  }>;
  _refreshAllPositions(): Promise<unknown>;
  _refreshAllOpenOrders(): Promise<unknown>;
  placeLimitOrder(o: {
    marketId: number;
    side: string;
    price: number;
    sizeBase: number;
    postOnly?: boolean;
  }): Promise<{ orderId: string }>;
  cancelOrder(marketId: number, orderId: string): Promise<unknown>;
  cancelAll(marketId: number): Promise<unknown>;
  closePosition(marketId: number, sizeBase?: number | null): Promise<unknown>;
  setLeverage(marketId: number, leverage: number): Promise<unknown>;
  getLeverage(marketId: number): Promise<number | null>;
  confirmNoOpenOrders(marketId: number, opts?: { retries?: number; waitMs?: number }): Promise<unknown>;
};

function marketName(market: string): string {
  const m = market.toUpperCase();
  return m.includes("-") ? m : `${m}-USD`;
}

export class ExtendedExecutor implements VenueExecutor {
  readonly id = "extended" as const;
  private ex: ExtendedExchange | null = null;
  private equityCache: { at: number; value: number | undefined } = { at: 0, value: undefined };
  constructor(private dryRun: boolean) {}

  async connect(): Promise<void> {
    if (this.dryRun) return;
    loadEnv();
    if (
      ["1", "true", "yes"].includes(String(process.env.EXTENDED_USE_PROXY || "").toLowerCase()) &&
      process.env.EXTENDED_PROXY
    ) {
      console.log(`[extended] proxy ${process.env.EXTENDED_PROXY}`);
    }
    const apiKey = process.env.EXTENDED_API_KEY?.trim();
    const vault = Number(process.env.EXTENDED_VAULT || process.env.EXTENDED_VAULT_ID || 0);
    const starkPrivateKey = process.env.EXTENDED_STARK_PRIVATE_KEY?.trim();
    const starkPublicKey = process.env.EXTENDED_STARK_PUBLIC_KEY?.trim() || null;
    const apiUrl = (
      process.env.EXTENDED_API_URL || "https://api.starknet.extended.exchange"
    ).replace(/\/$/, "");
    if (!apiKey || !vault || !starkPrivateKey) {
      throw new Error("缺少 EXTENDED_API_KEY / EXTENDED_VAULT / EXTENDED_STARK_PRIVATE_KEY");
    }
    const vendor = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../vendor/extended/exchange/index.js"
    );
    const mod = await import(pathToFileURL(vendor).href);
    this.ex = mod.createExchange({
      apiKey,
      vault,
      starkPrivateKey,
      starkPublicKey,
      apiUrl,
    }) as ExtendedExchange;
    await this.ex.init();
    if (process.env.GRID_SKIP_LEVERAGE !== "1") {
      const btcId = this.ex.marketIdForName("BTC-USD");
      if (btcId != null) {
        const target = Number(
          process.env.EXTENDED_LEVERAGE || process.env.GRID_LEVERAGE || 30
        );
        try {
          const current = await this.ex.getLeverage(btcId).catch(() => null);
          if (current == null || Math.abs(current - target) > 0.1) {
            await this.ex.setLeverage(btcId, target);
          }
        } catch (e: any) {
          console.warn(
            `[extended] setLeverage ${target}x skipped: ${String(e?.message || e).slice(0, 160)}`
          );
        }
      }
    }
  }

  disconnect(): void {
    this.ex?.stop();
    this.ex = null;
  }

  private ensure(): ExtendedExchange {
    if (!this.ex) throw new Error("Extended 未 connect");
    return this.ex;
  }

  private marketId(market: string): number {
    const id = this.ensure().marketIdForName(marketName(market));
    if (id == null) throw new Error(`Extended 无市场 ${market}`);
    return id;
  }

  private async readEquity(ex: ExtendedExchange): Promise<number | undefined> {
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
    await ex._refreshAllOpenOrders();
    const mid = await ex.getPrice(marketId);
    const pos = ex.getPosition(marketId);
    const oo = ex.getAllOpenOrders().filter((o) => o.marketId === marketId);
    const equityUsd = await this.readEquity(ex);
    const all =
      typeof ex.getAllPositions === "function" ? ex.getAllPositions() : [];
    const detail =
      all.find((p) => p.marketId === marketId) ||
      all.find((p) => /BTC/i.test(String(p.market || "")));
    const upnl = pos?.unrealizedPnl ?? detail?.unrealizedPnl;
    const liq = detail?.liquidationPrice ?? pos?.liquidationPrice;
    return {
      venue: this.id,
      market,
      mid,
      position: pos?.sizeBase ?? 0,
      openOrders: oo.map((o) => ({
        id: String(o.externalId || o.orderId),
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
    // Extended 下单 API 易 429：笔与笔之间强制间隔（默认 400ms，可用 EXTENDED_ORDER_GAP_MS 覆盖）
    const gapMs = Math.max(
      0,
      Number(process.env.EXTENDED_ORDER_GAP_MS || 400) || 400
    );
    let wrote = 0;
    for (const intent of intents) {
      try {
        if (intent.type === "cancel") {
          await ex.cancelOrder(this.marketId(intent.market), intent.orderId);
          result.cancelled += 1;
        } else {
          if (wrote > 0 && gapMs > 0) {
            await new Promise((r) => setTimeout(r, gapMs));
          }
          const placed = await ex.placeLimitOrder({
            marketId: this.marketId(intent.order.market),
            side: intent.order.side,
            price: intent.order.price,
            sizeBase: intent.order.size,
            postOnly: true,
          });
          result.placed += 1;
          result.placedOrders.push({ id: placed.orderId, order: intent.order });
          wrote += 1;
        }
      } catch (e: any) {
        const msg = String(e?.message || e);
        // 限流：本轮剩余 place 先停，留给下个 tick（vendor 内部已做过若干次退避重试）
        if (/429|限流/i.test(msg)) {
          result.failed += 1;
          result.errors.push(msg.slice(0, 200));
          break;
        }
        result.failed += 1;
        result.errors.push(msg.slice(0, 200));
      }
    }
    return result;
  }

  async cancelAll(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[extended:dry] cancelAll ${market}`);
      return;
    }
    const ex = this.ensure();
    const marketId = this.marketId(market);
    await ex.cancelAll(marketId);
    await ex.confirmNoOpenOrders(marketId, { retries: 8, waitMs: 750 });
  }

  async closePosition(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[extended:dry] closePosition ${market}`);
      return;
    }
    const ex = this.ensure();
    await ex.closePosition(this.marketId(market));
  }
}
