import type { ApplyResult, Intent, VenueId, VenueSnapshot } from "../types.js";
export type { ApplyResult } from "../types.js";

export type VenueExecutor = {
  readonly id: VenueId;
  connect(): Promise<void>;
  disconnect(): void;
  snapshot(market: string): Promise<VenueSnapshot>;
  apply(intents: Intent[]): Promise<ApplyResult>;
  cancelAll(market: string): Promise<void>;
  /** 尽力市价/IOC 减仓清仓；无仓则 no-op */
  closePosition(market: string): Promise<void>;
};

export function dryApply(venue: VenueId, intents: Intent[]): ApplyResult {
  const places = intents.filter((i): i is Extract<Intent, { type: "place" }> => i.type === "place");
  const placed = places.length;
  const cancelled = intents.filter((i) => i.type === "cancel").length;
  console.log(`[${venue}:dry] apply place=${placed} cancel=${cancelled}`);
  return {
    placed,
    cancelled,
    failed: 0,
    errors: [],
    placedOrders: places.map((intent, i) => ({
      id: `dry:${venue}:${intent.order.side}:${intent.order.level}:${i}`,
      order: intent.order,
    })),
  };
}
