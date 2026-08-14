import type { Intent, VenueSnapshot } from "../types.js";
import { DecibelLive } from "./decibelLive.js";
import { dryApply, type ApplyResult, type VenueExecutor } from "./types.js";

function sym(market: string): string {
  return market.toUpperCase().replace(/-USD$/, "").replace(/-PERP$/, "");
}

export class DecibelExecutor implements VenueExecutor {
  readonly id = "decibel" as const;
  private live: DecibelLive | null = null;
  private equityCache: { at: number; value: number | undefined } = { at: 0, value: undefined };
  constructor(private dryRun: boolean) {}

  async connect(): Promise<void> {
    if (this.dryRun) return;
    this.live = new DecibelLive();
    await this.live.connect();
    if (process.env.GRID_SKIP_LEVERAGE !== "1") {
      try {
        await this.live.setLeverage(
          "BTC",
          Number(process.env.DECIBEL_LEVERAGE || process.env.GRID_LEVERAGE || 30)
        );
      } catch (e: any) {
        console.warn(
          `[decibel] setLeverage skipped: ${String(e?.message || e).slice(0, 160)}`
        );
      }
    }
  }

  disconnect(): void {
    this.live?.disconnect();
    this.live = null;
  }

  private ensure(): DecibelLive {
    if (!this.live) throw new Error("Decibel 未 connect");
    return this.live;
  }

  private async readEquity(live: DecibelLive): Promise<number | undefined> {
    const now = Date.now();
    if (now - this.equityCache.at < 60_000 && this.equityCache.value != null) {
      return this.equityCache.value;
    }
    try {
      const ov: any = await live.overview();
      const row = Array.isArray(ov) ? ov[0] : ov?.items?.[0] ?? ov;
      const v = Number(
        row?.perp_equity_balance ?? row?.total_margin ?? row?.equity ?? row?.balance
      );
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
    const live = this.ensure();
    const s = sym(market);
    const mid = await live.mid(s);
    const oo = await live.openOrders(s);
    const posRows = await live.positions();
    const items = posRows?.items ?? posRows ?? [];
    let position = 0;
    let unrealizedPnl: number | undefined;
    let liquidationPrice: number | undefined;
    for (const p of Array.isArray(items) ? items : []) {
      const m = live.cfg(s);
      if (!m) continue;
      if (String(p.market) !== m.market_addr && !String(p.market_name || "").includes(s)) continue;
      const sz = Number(p.size ?? p.position_size ?? 0);
      const scaled = Math.abs(sz) > 1e5 ? sz / 10 ** m.sz_decimals : sz;
      const short = String(p.side || "").toUpperCase() === "SHORT" || scaled < 0;
      position = Math.abs(scaled) * (short ? -1 : 1);
      let upnl = Number(p.unrealized_pnl ?? p.unrealised_pnl ?? NaN);
      if (!Number.isFinite(upnl)) {
        const entryRaw = Number(p.avg_entry_price ?? p.entry_price ?? p.open_price ?? 0);
        const entry =
          Math.abs(entryRaw) > 1e6 ? entryRaw / 10 ** m.px_decimals : entryRaw;
        if (entry > 0 && mid > 0) {
          upnl = (short ? entry - mid : mid - entry) * Math.abs(position);
        }
      }
      if (Number.isFinite(upnl)) unrealizedPnl = upnl;
      if (p.liquidation_price != null || p.estimated_liquidation_price != null) {
        const liqRaw = Number(
          p.estimated_liquidation_price ?? p.liquidation_price ?? NaN
        );
        const liq =
          Math.abs(liqRaw) > 1e6 ? liqRaw / 10 ** m.px_decimals : liqRaw;
        if (liq > 0) liquidationPrice = liq;
      }
    }
    const equityUsd = await this.readEquity(live);
    return {
      venue: this.id,
      market: s,
      mid,
      position,
      openOrders: oo.map((o) => ({
        id: o.orderId,
        market: s,
        side: o.side,
        price: Number(o.price),
        size: o.size,
        level: 0,
      })),
      equityUsd,
      unrealizedPnl,
      liquidationPrice,
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
    const live = this.ensure();
    for (const intent of intents) {
      try {
        if (intent.type === "cancel") {
          await live.cancel(sym(intent.market), intent.orderId);
          result.cancelled += 1;
        } else {
          const placed = await live.placeLimit({
            symbol: sym(intent.order.market),
            side: intent.order.side,
            price: intent.order.price,
            size: intent.order.size,
            postOnly: true,
          });
          result.placed += 1;
          result.placedOrders.push({ id: placed.orderId, order: intent.order });
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
      console.log(`[decibel:dry] cancelAll ${market}`);
      return;
    }
    await this.ensure().cancelAll(sym(market));
  }

  async closePosition(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[decibel:dry] closePosition ${market}`);
      return;
    }
    const live = this.ensure();
    const snap = await this.snapshot(market);
    const pos = Number(snap.position) || 0;
    if (Math.abs(pos) < 1e-12) return;
    const side = pos > 0 ? "sell" : "buy";
    const size = Math.abs(pos);
    const mid = snap.mid > 0 ? snap.mid : 0;
    if (!(mid > 0)) throw new Error("closePosition: no mid");
    const price = pos > 0 ? mid * 0.992 : mid * 1.008;
    await live.placeIoc({
      symbol: sym(market),
      side,
      price,
      size,
      reduceOnly: true,
      clientOrderId: `flat-${Date.now()}`,
    });
  }
}
