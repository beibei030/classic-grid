export type VenueId = "extended" | "risex" | "decibel" | "n1" | "phoenix";
export type Side = "buy" | "sell";
export type GridMode = "neutral" | "long" | "short";

export type GridParams = {
  /** 锚点后填入：mid − halfBand */
  lower: number;
  /** 锚点后填入：mid + halfBand */
  upper: number;
  /** 半幅（USD），默认 3000 → 总宽 6000 */
  halfBand: number;
  /** 格子数（价格线 = gridCount+1）；上下各 gridCount/2 */
  gridCount: number;
  sizeBase: number;
  leverage: number;
  /** 单边费率（maker），用于间距校验 */
  feeRate: number;
  /** 账户权益估算（保证金预检）；实盘以后可用真实 equity 覆盖 */
  equityUsd: number;
  /** 用权益的多少做保证金预算 */
  marginFraction: number;
  maxWritesPerTick: number;
  mode: GridMode;
  /** 近现价跳过带宽 = skipBand * spacing */
  skipBand: number;
  /** 单市场挂单上限（如 RISEx 50）；达限后本轮不再 place */
  maxOpenOrders?: number;
};

export type SeedOrder = {
  levelIndex: number;
  price: number;
  side: Side;
  reduceOnly: boolean;
};

export type DesiredOrder = {
  market: string;
  side: Side;
  price: number;
  size: number;
  level: number;
};

export type LiveOrder = DesiredOrder & { id: string };

export type VenueSnapshot = {
  venue: VenueId;
  market: string;
  mid: number;
  position: number;
  openOrders: LiveOrder[];
  /** 官方未实现盈亏（所方字段/均价×标记）；读不到则省略，看板显示 - */
  unrealizedPnl?: number;
  /** 官方爆仓价；读不到则省略 */
  liquidationPrice?: number;
  /** 账户权益（USD）；读不到则为 undefined */
  equityUsd?: number;
};

export type Intent =
  | { type: "place"; order: DesiredOrder }
  | { type: "cancel"; orderId: string; market: string };

export type ApplyResult = {
  placed: number;
  cancelled: number;
  failed: number;
  errors: string[];
  /** 仅包含交易所明确返回 ID 的成功下单；用于限制自动撤单的归属范围 */
  placedOrders: Array<{ id: string; order: DesiredOrder }>;
};

export type ActiveOrder = {
  id: string;
  levelIndex: number;
  side: Side;
  price: number;
  size: number;
};
