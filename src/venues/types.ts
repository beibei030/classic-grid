import type { ApplyResult, Intent, VenueId, VenueSnapshot } from "../types.js";

export type { ApplyResult };

export type HardStopSpec = {
  market: string;
  /** 上沿硬止损：空仓买入平仓 */
  hardUp: number;
  /** 下沿硬止损：多仓卖出平仓 */
  hardDn: number;
};

export type HedgeOrder = {
  market: string;
  side: "buy" | "sell";
  size: number;
  price?: number;
  reduceOnly?: boolean;
  clientOrderId?: string;
  maxSlippagePct?: number;
};

export type HedgeOrderResult = {
  accepted: boolean;
  confirmed: boolean;
  orderId?: string;
  txHash?: string;
  note?: string;
};

export type TopOfBook = {
  bid: number;
  ask: number;
  updatedAt: number;
};

export type FundingQuote = {
  rate: number;
  nextFundingAt?: number;
  intervalMs?: number;
  source: string;
};

export type VenueExecutor = {
  readonly id: VenueId;
  connect(): Promise<void>;
  disconnect(): void;
  snapshot(market: string): Promise<VenueSnapshot>;
  apply(intents: Intent[]): Promise<ApplyResult>;
  cancelAll(market: string): Promise<void>;
  /** 尽力市价/IOC 减仓；sizeBase 有值则只平这么多，否则全平 */
  closePosition(market: string, sizeBase?: number | null): Promise<void>;
  /** 交易所侧硬止损（有则挂，无则只靠 bot 轮询） */
  syncHardStops?(spec: HardStopSpec): Promise<{ armed: boolean; note?: string }>;
  cancelHardStops?(market: string): Promise<void>;
  placeHedgeLimit?(order: HedgeOrder): Promise<HedgeOrderResult>;
  placeHedgeIoc?(order: HedgeOrder): Promise<HedgeOrderResult>;
  topOfBook?(market: string): Promise<TopOfBook>;
  fundingQuote?(market: string): Promise<FundingQuote>;
};

export function dryApply(venue: VenueId, intents: Intent[]): ApplyResult {
  const placed = intents.filter((i) => i.type === "place").length;
  const cancelled = intents.filter((i) => i.type === "cancel").length;
  console.log(`[${venue}:dry] apply place=${placed} cancel=${cancelled}`);
  return { placed, cancelled, failed: 0, errors: [] };
}
