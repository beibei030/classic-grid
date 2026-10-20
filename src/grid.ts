import type {
  DesiredOrder,
  GridMode,
  GridParams,
  Intent,
  LiveOrder,
  SeedOrder,
  Side,
} from "./types.js";

export type BuiltGrid = {
  levels: number[];
  spacing: number;
  count: number;
  innerSpacing?: number;
  outerSpacing?: number;
};

export function splitProgressiveCounts(
  gridCount: number,
  innerFrac = 0.6
): { innerCount: number; outerEach: number } {
  const outerTotal = Math.max(2, Math.floor(gridCount * (1 - innerFrac) + 1e-9));
  const outerEach = Math.max(1, Math.floor(outerTotal / 2));
  const innerCount = Math.max(2, gridCount - outerEach * 2);
  return { innerCount, outerEach };
}

function round(x: number): number {
  return Math.round(x * 1e8) / 1e8;
}

/** 等差网格：levels[0]=lower … levels[count]=upper */
export function buildGrid(p: {
  lower: number;
  upper: number;
  gridCount: number;
  mid?: number;
  innerHalfPct?: number;
  innerFrac?: number;
}): BuiltGrid {
  if (!(p.upper > p.lower)) throw new Error("upper 必须大于 lower");
  if (!(p.gridCount >= 2)) throw new Error("gridCount 至少为 2");
  if (p.mid && p.mid > 0 && p.innerHalfPct && p.innerHalfPct > 0) {
    return buildProgressiveGrid(p);
  }
  const spacing = (p.upper - p.lower) / p.gridCount;
  const levels: number[] = [];
  for (let i = 0; i <= p.gridCount; i++) levels.push(round(p.lower + i * spacing));
  return { levels, spacing: round(spacing), count: p.gridCount };
}

function buildProgressiveGrid(p: {
  lower: number;
  upper: number;
  gridCount: number;
  mid?: number;
  innerHalfPct?: number;
  innerFrac?: number;
}): BuiltGrid {
  const mid = p.mid!;
  const innerHalf = mid * p.innerHalfPct!;
  const innerLower = mid - innerHalf;
  const innerUpper = mid + innerHalf;
  if (!(innerLower > p.lower) || !(innerUpper < p.upper)) {
    throw new Error("前紧后松：中心带必须落在外层带之内");
  }
  const { innerCount, outerEach } = splitProgressiveCounts(
    p.gridCount,
    p.innerFrac ?? 0.6
  );
  const outerLoStep = (innerLower - p.lower) / outerEach;
  const innerStep = (innerUpper - innerLower) / innerCount;
  const outerHiStep = (p.upper - innerUpper) / outerEach;
  const levels: number[] = [];
  for (let i = 0; i <= outerEach; i++) levels.push(round(p.lower + i * outerLoStep));
  for (let i = 1; i <= innerCount; i++) levels.push(round(innerLower + i * innerStep));
  for (let i = 1; i <= outerEach; i++) levels.push(round(innerUpper + i * outerHiStep));
  return {
    levels,
    spacing: round(innerStep),
    count: p.gridCount,
    innerSpacing: round(innerStep),
    outerSpacing: round((outerLoStep + outerHiStep) / 2),
  };
}

export function isReduceOnly(side: Side, mode: GridMode): boolean {
  if (mode === "long") return side === "sell";
  if (mode === "short") return side === "buy";
  return false;
}

/** 初始铺单：现价下买上卖；近价 skipBand*spacing 内跳过 */
export function seedOrders(p: {
  levels: number[];
  price: number;
  mode: GridMode;
  skipBand?: number;
  spacing: number;
}): SeedOrder[] {
  const band = p.spacing * (p.skipBand ?? 0.25);
  const orders: SeedOrder[] = [];
  for (let i = 0; i < p.levels.length; i++) {
    const lvl = p.levels[i]!;
    if (Math.abs(lvl - p.price) < band) continue;
    if (lvl < p.price) {
      // 下方买单：neutral/long 都挂。long=只买（平空/开多），永不卖。
      if (p.mode === "neutral" || p.mode === "long") {
        orders.push({
          levelIndex: i,
          price: lvl,
          side: "buy",
          reduceOnly: isReduceOnly("buy", p.mode),
        });
      }
    } else if (lvl > p.price) {
      // 上方卖单：只有 neutral/short 挂。long 模式严禁卖单（不追加空仓）。
      if (p.mode === "neutral" || p.mode === "short") {
        orders.push({
          levelIndex: i,
          price: lvl,
          side: "sell",
          reduceOnly: isReduceOnly("sell", p.mode),
        });
      }
    }
  }
  return orders;
}

/** 买成交 → 上邻挂卖；卖成交 → 下邻挂买 */
export function replacementFor(
  filled: { side: Side; levelIndex: number },
  levels: number[],
  mode: GridMode
): SeedOrder | null {
  if (filled.side === "buy") {
    const j = filled.levelIndex + 1;
    if (j > levels.length - 1) return null;
    return {
      levelIndex: j,
      price: levels[j]!,
      side: "sell",
      reduceOnly: isReduceOnly("sell", mode),
    };
  }
  const j = filled.levelIndex - 1;
  if (j < 0 || j > levels.length - 1) return null;
  return {
    levelIndex: j,
    price: levels[j]!,
    side: "buy",
    reduceOnly: isReduceOnly("buy", mode),
  };
}

export function rungProfit(spacing: number, sizeBase: number): number {
  return spacing * sizeBase;
}

export type RiskSnapshot = {
  notional: number;
  requiredMargin: number;
  perRungProfit: number;
  spacingPct: number;
  maxAffordableNotional: number;
};

export function computeRisk(
  grid: BuiltGrid,
  params: Pick<GridParams, "sizeBase" | "leverage" | "equityUsd" | "marginFraction">,
  mid: number
): RiskSnapshot {
  const midUse = mid > 0 ? mid : 1;
  const notional = grid.count * params.sizeBase * midUse;
  const maxAffordableNotional =
    params.equityUsd * params.marginFraction * params.leverage;
  return {
    notional: round(notional),
    requiredMargin: round(notional / params.leverage),
    perRungProfit: round(rungProfit(grid.spacing, params.sizeBase)),
    spacingPct: round((grid.spacing / midUse) * 100),
    maxAffordableNotional: round(maxAffordableNotional),
  };
}

/** 格距 % 必须明显大于双边费率 % */
export function assertFeeOk(
  spacingPct: number,
  feeRate: number
): { ok: boolean; roundTripFeePct: number; message: string } {
  const roundTripFeePct = feeRate * 2 * 100;
  if (spacingPct <= roundTripFeePct) {
    return {
      ok: false,
      roundTripFeePct,
      message: `格距 ${spacingPct}% ≤ 往返手续费约 ${round(roundTripFeePct)}%，每格可能亏损`,
    };
  }
  return {
    ok: true,
    roundTripFeePct,
    message: `格距 ${spacingPct}% > 往返手续费约 ${round(roundTripFeePct)}%`,
  };
}

export function assertMarginOk(
  risk: RiskSnapshot,
  equityUsd: number,
  marginFraction: number
): { ok: boolean; message: string } {
  const budget = equityUsd * marginFraction;
  // 允许 0.05U 浮点误差
  if (risk.requiredMargin > budget + 0.05) {
    return {
      ok: false,
      message: `保证金约需 ${risk.requiredMargin}U > 预算 ${round(budget)}U（权益×占用比），请降 size/格数或提高杠杆`,
    };
  }
  if (risk.requiredMargin > budget * 0.8) {
    return {
      ok: true,
      message: `保证金占用偏高：${risk.requiredMargin}/${round(budget)}U（>80%）`,
    };
  }
  return {
    ok: true,
    message: `保证金约 ${risk.requiredMargin}U / 预算 ${round(budget)}U（名义 ${risk.notional}U）`,
  };
}

/** 用价位匹配活单到格线（±半格间距） */
export function matchLevelIndex(
  price: number,
  levels: number[],
  spacing: number
): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < levels.length; i++) {
    const d = Math.abs(levels[i]! - price);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  // 过宽会把「旧半幅/旧档距」残留单误认成当前格（Dec/N1 曾 73.8 与 80 混挂）
  if (best < 0) return -1;
  const left = best > 0 ? levels[best]! - levels[best - 1]! : 0;
  const right = best < levels.length - 1 ? levels[best + 1]! - levels[best]! : 0;
  const local = Math.min(left || Infinity, right || Infinity);
  const tol = (Number.isFinite(local) && local > 0 ? local : spacing) * 0.1;
  if (bestDist > tol) return -1;
  return best;
}

export function seedToDesired(
  market: string,
  seeds: SeedOrder[],
  size: number
): DesiredOrder[] {
  return seeds.map((s) => ({
    market,
    side: s.side,
    price: s.price,
    size,
    level: s.levelIndex,
  }));
}

export type CloseNeed = {
  side: Side;
  price: number;
  level: number;
};

/**
 * 根据上一轮跟踪单 vs 本轮交易所挂单，推断成交并生成补单 intents。
 * 默认只补成交的邻格反向（止盈/回补）。allowSeed 仅首次铺网 / 重铺为 true。
 */
export function planFromFillsAndSeed(p: {
  market: string;
  mid: number;
  levels: number[];
  spacing: number;
  mode: GridMode;
  sizeBase: number;
  openOrders: LiveOrder[];
  prevActive: Map<string, { levelIndex: number; side: Side; price: number; size: number }>;
  maxWrites: number;
  seeded: boolean;
  /** 达限后不再 place（如 RISEx 50/市场） */
  maxOpenOrders?: number;
  skipBand?: number;
  /** 刚下过、所上可能还没回显的档，禁止再 seed 一张（防叠单） */
  reservedLevels?: number[];
  /** true=按现价铺空档（仅首次/重铺）。默认 false，避免每拍乱补开仓 */
  allowSeed?: boolean;
  /** 上一拍没挂上的平仓邻格，本拍优先补 */
  pendingClose?: CloseNeed[];
}): {
  intents: Intent[];
  nextActive: Map<string, { levelIndex: number; side: Side; price: number; size: number }>;
  filled: Array<{ side: Side; levelIndex: number; price: number }>;
  completedRungs: number;
  pendingClose: CloseNeed[];
  closeIntents: CloseNeed[];
} {
  const nextActive = new Map<
    string,
    { levelIndex: number; side: Side; price: number; size: number }
  >();
  const occupied = new Set<number>(p.reservedLevels || []);
  const intents: Intent[] = [];
  const orphanCancels: string[] = [];

  // 按 level 分组；同 level 多单（叠单）时确定性保留 orderId 最小的一个，
  // 撤其余。不依赖 openOrders 数组顺序，避免 indexer 顺序抖动导致「撤A保B」与「撤B保A」交替震荡。
  const byLevel = new Map<number, LiveOrder[]>();
  for (const o of p.openOrders) {
    const idx = matchLevelIndex(o.price, p.levels, p.spacing);
    // 对不上当前格线 → 错位单，撤掉腾名额
    if (idx < 0) {
      orphanCancels.push(o.id);
      continue;
    }
    const arr = byLevel.get(idx) || [];
    arr.push(o);
    byLevel.set(idx, arr);
  }
  // 对账目标低于当前唯一档数时，撤掉最靠近现价的超额档；
  // 中心本就应留出夹缝，避免为了控总数误删远端保护档。
  const dropLevels = new Set<number>();
  if (
    p.maxOpenOrders != null &&
    Number.isFinite(p.maxOpenOrders) &&
    byLevel.size > p.maxOpenOrders
  ) {
    const excess = byLevel.size - p.maxOpenOrders;
    const nearest = [...byLevel.keys()].sort(
      (a, b) =>
        Math.abs(p.levels[a]! - p.mid) - Math.abs(p.levels[b]! - p.mid) ||
        a - b
    );
    for (const idx of nearest.slice(0, excess)) dropLevels.add(idx);
  }
  for (const [idx, arr] of byLevel) {
    if (dropLevels.has(idx)) {
      for (const o of arr) orphanCancels.push(o.id);
      continue;
    }
    let keep = arr[0]!;
    for (const o of arr) {
      if (String(o.id) < String(keep.id)) keep = o;
    }
    occupied.add(idx);
    nextActive.set(keep.id, {
      levelIndex: idx,
      side: keep.side,
      price: keep.price,
      size: keep.size,
    });
    for (const o of arr) {
      if (o.id === keep.id) continue;
      orphanCancels.push(o.id);
    }
  }

  for (const id of orphanCancels) {
    if (intents.length >= p.maxWrites) break;
    intents.push({ type: "cancel", orderId: id, market: p.market });
  }
  const cancelsPlanned = intents.length;

  const filled: Array<{ side: Side; levelIndex: number; price: number }> = [];
  for (const [id, prev] of p.prevActive) {
    if (nextActive.has(id)) continue;
    // 仍有同 level 同方向单 → 不像成交，跳过
    let still = false;
    for (const a of nextActive.values()) {
      if (a.levelIndex === prev.levelIndex && a.side === prev.side) {
        still = true;
        break;
      }
    }
    if (still) continue;
    filled.push({ side: prev.side, levelIndex: prev.levelIndex, price: prev.price });
  }

  let completedRungs = 0;
  let placeSlots =
    p.maxOpenOrders != null
      ? Math.max(0, p.maxOpenOrders - (p.openOrders.length - cancelsPlanned))
      : Number.POSITIVE_INFINITY;

  const pushPlace = (order: DesiredOrder): boolean => {
    if (placeSlots <= 0) return false;
    if (intents.length >= p.maxWrites) return false;
    intents.push({ type: "place", order });
    placeSlots -= 1;
    return true;
  };

  const closeNeeds: CloseNeed[] = [];
  const seenClose = new Set<number>();
  const pushCloseNeed = (n: CloseNeed) => {
    if (!(n.price > 0) || n.level < 0 || n.level >= p.levels.length) return;
    if (occupied.has(n.level) || seenClose.has(n.level)) return;
    seenClose.add(n.level);
    closeNeeds.push(n);
  };
  for (const prev of p.pendingClose || []) {
    if (p.mode === "long" && prev.side === "sell") continue;
    if (p.mode === "short" && prev.side === "buy") continue;
    // 买在现价上 / 卖在现价下挂不住，让档给同向补洞
    const crosses =
      (prev.side === "buy" && prev.price >= p.mid) ||
      (prev.side === "sell" && prev.price <= p.mid);
    if (crosses) continue;
    pushCloseNeed(prev);
  }
  for (const f of filled) {
    const repl = replacementFor(f, p.levels, p.mode);
    if (!repl) continue;
    completedRungs += 1;
    // 单边锁：long 只买（买成交不补卖）；short 只卖（卖成交不补买）
    if (p.mode === "long" && repl.side === "sell") continue;
    if (p.mode === "short" && repl.side === "buy") continue;
    pushCloseNeed({
      side: repl.side,
      price: repl.price,
      level: repl.levelIndex,
    });
  }

  const leftoverClose: CloseNeed[] = [];
  const closeIntents: CloseNeed[] = [];
  for (const n of closeNeeds) {
    if (occupied.has(n.level)) continue;
    if (
      !pushPlace({
        market: p.market,
        side: n.side,
        price: n.price,
        size: p.sizeBase,
        level: n.level,
      })
    ) {
      leftoverClose.push(n);
      continue;
    }
    occupied.add(n.level);
    closeIntents.push(n);
  }

  // 买卖梯子中间抠洞（买-空-买 / 卖-空-卖）补同向。现价夹在买卖之间的空档不补。
  {
    const sideAt = new Map<number, Side>();
    for (const a of nextActive.values()) sideAt.set(a.levelIndex, a.side);
    const nearestSide = (from: number, dir: number): Side | null => {
      for (let i = from + dir; i >= 0 && i < p.levels.length; i += dir) {
        const s = sideAt.get(i);
        if (s) return s;
        if (occupied.has(i)) return null;
      }
      return null;
    };
    for (let i = 0; i < p.levels.length; i++) {
      if (occupied.has(i)) continue;
      const left = nearestSide(i, -1);
      const right = nearestSide(i, 1);
      if (!left || !right || left !== right) continue;
      if (p.mode === "long" && left === "sell") continue;
      if (p.mode === "short" && left === "buy") continue;
      if (
        !pushPlace({
          market: p.market,
          side: left,
          price: p.levels[i]!,
          size: p.sizeBase,
          level: i,
        })
      ) {
        break;
      }
      occupied.add(i);
      sideAt.set(i, left);
    }

    // 现价夹缝最宽留 1 格：下面补买、上面补卖。急涨急跌冲过好几格时不要空一大片。
    let hiBuy = -1;
    let loSell = p.levels.length;
    for (const [idx, side] of sideAt) {
      if (side === "buy" && idx > hiBuy) hiBuy = idx;
      if (side === "sell" && idx < loSell) loSell = idx;
    }
    if (hiBuy >= 0 && loSell < p.levels.length && loSell - hiBuy > 2) {
      let midIdx = 0;
      for (let i = 1; i < p.levels.length; i++) {
        if (Math.abs(p.levels[i]! - p.mid) < Math.abs(p.levels[midIdx]! - p.mid)) {
          midIdx = i;
        }
      }
      if (midIdx <= hiBuy) midIdx = hiBuy + 1;
      if (midIdx >= loSell) midIdx = loSell - 1;
      const tryFill = (i: number, side: Side) => {
        if (i <= hiBuy || i >= loSell || i === midIdx || occupied.has(i)) return true;
        if (p.mode === "long" && side === "sell") return true;
        if (p.mode === "short" && side === "buy") return true;
        if (
          !pushPlace({
            market: p.market,
            side,
            price: p.levels[i]!,
            size: p.sizeBase,
            level: i,
          })
        ) {
          return false;
        }
        occupied.add(i);
        sideAt.set(i, side);
        return true;
      };
      for (let i = hiBuy + 1; i < midIdx; i++) {
        if (!tryFill(i, "buy")) break;
      }
      for (let i = loSell - 1; i > midIdx; i--) {
        if (!tryFill(i, "sell")) break;
      }
    }
  }

  // 仅首次铺网 / 重铺：按现价补空档。日常对账不准补开仓。
  if (p.allowSeed) {
    const filledLevelSide = new Map<number, Side>();
    for (const f of filled) filledLevelSide.set(f.levelIndex, f.side);
    const seeds = seedOrders({
      levels: p.levels,
      price: p.mid,
      mode: p.mode,
      spacing: p.spacing,
      skipBand: p.skipBand,
    });
    for (const s of seeds) {
      if (occupied.has(s.levelIndex)) continue;
      const opened = filledLevelSide.get(s.levelIndex);
      if (opened && opened !== s.side) continue;
      if (
        !pushPlace({
          market: p.market,
          side: s.side,
          price: s.price,
          size: p.sizeBase,
          level: s.levelIndex,
        })
      ) {
        break;
      }
      occupied.add(s.levelIndex);
    }
  }

  return {
    intents,
    nextActive,
    filled,
    completedRungs,
    pendingClose: leftoverClose,
    closeIntents,
  };
}
