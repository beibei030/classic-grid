export type VenueId = "decibel" | "n1" | "popdex" | "risex";
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
  /** 保持原格距/size，在原下沿之外额外增加的格数 */
  lowerExtraLevels?: number;
  /** 保持原格距/size，在上沿增加（正数）或删除（负数）的格数 */
  upperLevelDelta?: number;
  /** 前紧后松：中心半幅，相对锚点（如 0.04 = ±4%） */
  innerHalfPct?: number;
  /** 前紧后松：外层半幅，相对锚点（如 0.08 = ±8%） */
  outerHalfPct?: number;
  /** 前紧后松：中心区占用的格数比例 */
  innerFrac?: number;
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
  /** 账户权益（USD）；读不到则为 undefined */
  equityUsd?: number;
  /** 官方爆仓价；读不到则省略 */
  liquidationPrice?: number;
};

export type Intent =
  | { type: "place"; order: DesiredOrder }
  | { type: "cancel"; orderId: string; market: string };

export type ApplyResult = {
  placed: number;
  cancelled: number;
  failed: number;
  errors: string[];
};

export type ActiveOrder = {
  id: string;
  levelIndex: number;
  side: Side;
  price: number;
  size: number;
};
