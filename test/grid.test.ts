import assert from "node:assert/strict";
import {
  HALF_BAND,
  REF_MID,
  anchorGrid,
  applySoftResumeBand,
} from "../src/config.js";
import {
  assertFeeOk,
  assertMarginOk,
  buildGrid,
  computeRisk,
  planFromFillsAndSeed,
  replacementFor,
  seedOrders,
  splitProgressiveCounts,
} from "../src/grid.js";
import { edges } from "../src/stopLoss.js";

function checkVenue(label: string, gridCount: number, expectEach: number, mid: number) {
  const base = {
    lower: 0,
    upper: 0,
    halfBand: HALF_BAND,
    gridCount,
    sizeBase: 0,
    leverage: 30,
    feeRate: 0.0005,
    equityUsd: 800,
    marginFraction: 0.3,
    maxWritesPerTick: 10,
    mode: "neutral" as const,
    skipBand: 0.25,
  };
  const anchored = anchorGrid(base, mid);
  const g = buildGrid({
    lower: anchored.lower,
    upper: anchored.upper,
    gridCount,
  });
  assert.equal(g.levels.length, gridCount + 1);
  const expectHalf = mid * (HALF_BAND / REF_MID);
  assert.ok(Math.abs(anchored.lower - (mid - expectHalf)) < 1e-6);
  assert.ok(Math.abs(anchored.upper - (mid + expectHalf)) < 1e-6);

  const seeds = seedOrders({
    levels: g.levels,
    price: mid,
    mode: "neutral",
    spacing: g.spacing,
  });
  const buys = seeds.filter((s) => s.side === "buy").length;
  const sells = seeds.filter((s) => s.side === "sell").length;
  assert.equal(buys, expectEach, `${label} buy`);
  assert.equal(sells, expectEach, `${label} sell`);

  const risk = computeRisk(
    g,
    {
      sizeBase: anchored.sizeBase,
      leverage: 30,
      equityUsd: 800,
      marginFraction: 0.3,
    },
    mid
  );
  const fee = assertFeeOk(risk.spacingPct, 0.0005);
  assert.equal(fee.ok, true, `${label} fee ${fee.message}`);
  const margin = assertMarginOk(risk, 800, 0.3);
  assert.equal(margin.ok, true, `${label} margin`);
  console.log(
    `${label}: mid=${mid} count=${gridCount} ≈上下各${expectEach} spacing=${g.spacing.toFixed(2)} size=${anchored.sizeBase} perRung≈${risk.perRungProfit}U spacingPct=${risk.spacingPct}%`
  );
}

for (const mid of [65_000, 97_500, 120_000]) {
  checkVenue(`ext/n1@${mid}`, 80, 40, mid);
  checkVenue(`ris/dec@${mid}`, 50, 25, mid);
}

// 单边锁：long 只买不卖 / short 只卖不买——成交后不得补反向单（否则摩擦累计反向仓位）
function checkOneSideNoReverse() {  const g = buildGrid({ lower: 63000, upper: 67000, gridCount: 80 });
  const sizeBase = 0.0033;
  const mid = g.levels[40]!; // 网格中心
  const base = {
    market: "BTC",
    mid,
    levels: g.levels,
    spacing: g.spacing,
    sizeBase,
    openOrders: [] as Array<{ id: string; market: string; side: "buy" | "sell"; price: number; size: number; level: number }>,
    maxWrites: 20,
    seeded: true,
    skipBand: 0.5,
  };

  // long：买单成交（prevActive 有、openOrders 无）→ 不得补卖单
  {
    const prevActive = new Map([
      ["o1", { levelIndex: 10, side: "buy" as const, price: g.levels[10]!, size: sizeBase }],
    ]);
    const plan = planFromFillsAndSeed({ ...base, mode: "long", prevActive });
    const sells = plan.intents.filter((i) => i.type === "place" && i.order.side === "sell");
    assert.equal(sells.length, 0, "long 模式买成交后不得补卖单");
  }
  // short：卖单成交 → 不得补买单
  {
    const prevActive = new Map([
      ["o2", { levelIndex: 70, side: "sell" as const, price: g.levels[70]!, size: sizeBase }],
    ]);
    const plan = planFromFillsAndSeed({ ...base, mode: "short", prevActive });
    const buys = plan.intents.filter((i) => i.type === "place" && i.order.side === "buy");
    assert.equal(buys.length, 0, "short 模式卖成交后不得补买单");
  }
  console.log("one-side no-reverse OK");
}
checkOneSideNoReverse();

assert.equal(
  replacementFor(
    { side: "sell", levelIndex: 100 },
    Array.from({ length: 91 }, (_, i) => i),
    "neutral"
  ),
  null,
  "缩短网格后，旧越界卖单不得生成 undefined 补单"
);
console.log("stale level upper-bound OK");

{
  const levels = Array.from({ length: 91 }, (_, i) => 60_000 + i * 100);
  const plan = planFromFillsAndSeed({
    market: "BTC",
    mid: 65_000,
    levels,
    spacing: 100,
    mode: "neutral",
    sizeBase: 0.002,
    openOrders: [],
    prevActive: new Map(),
    maxWrites: 10,
    maxOpenOrders: 90,
    seeded: true,
    allowSeed: false,
    pendingClose: [
      { side: "buy", price: 0, level: 98 },
      { side: "buy", price: Number.NaN, level: 92 },
    ],
  });
  assert.equal(plan.intents.length, 0, "无效旧 pendingClose 必须直接丢弃");
  console.log("invalid pending-close filter OK");
}

// 叠单去重：同 level 两个单（同价同向），只保留 orderId 最小的，撤另一个（确定性，不依赖数组顺序）
function checkDupDedupDeterministic() {
  const g = buildGrid({ lower: 63000, upper: 67000, gridCount: 80 });
  const sizeBase = 0.0033;
  const mid = g.levels[40]!;
  const lvl = g.levels[10]!; // 某个固定 level
  const mkOrder = (id: string, price: number) => ({
    id,
    market: "BTC",
    side: "buy" as const,
    price,
    size: sizeBase,
    level: 10,
  });
  // 两个单落在同一 level（价格略有抖动但都在容差内）
  const oA = mkOrder("10", lvl + 0.01);
  const oB = mkOrder("9", lvl + 0.02);
  const base = {
    market: "BTC",
    mid,
    levels: g.levels,
    spacing: g.spacing,
    sizeBase,
    maxWrites: 20,
    seeded: true,
    skipBand: 0.5,
  };
  // 顺序 A,B
  const p1 = planFromFillsAndSeed({
    ...base,
    mode: "neutral",
    openOrders: [oA, oB],
    prevActive: new Map(),
  });
  // 顺序 B,A
  const p2 = planFromFillsAndSeed({
    ...base,
    mode: "neutral",
    openOrders: [oB, oA],
    prevActive: new Map(),
  });
  const cancels1 = p1.intents.filter((i) => i.type === "cancel").map((i: any) => i.orderId);
  const cancels2 = p2.intents.filter((i) => i.type === "cancel").map((i: any) => i.orderId);
  // 核心：无论输入顺序，撤掉的是同一个 orderId（确定性），且只撤 1 个
  assert.deepEqual(cancels1, cancels2, "两种顺序应撤掉同一个 orderId（确定性）");
  assert.equal(cancels1.length, 1, "只撤 1 个叠单");
  console.log("dup-dedup deterministic OK");
}
checkDupDedupDeterministic();

// 日常：allowSeed=false 时空档不按现价补开仓；买成交只补上邻卖
function checkFillOnlyNoSeed() {
  const g = buildGrid({ lower: 63000, upper: 67000, gridCount: 80 });
  const sizeBase = 0.0033;
  const mid = g.levels[40]!;
  const base = {
    market: "BTC",
    mid,
    levels: g.levels,
    spacing: g.spacing,
    mode: "neutral" as const,
    sizeBase,
    maxWrites: 20,
    seeded: true,
    allowSeed: false,
    skipBand: 0.5,
  };
  const empty = planFromFillsAndSeed({
    ...base,
    openOrders: [],
    prevActive: new Map(),
  });
  assert.equal(
    empty.intents.filter((i) => i.type === "place").length,
    0,
    "未成交且不允许 seed 时不得铺开仓"
  );

  const buyLvl = 10;
  const plan = planFromFillsAndSeed({
    ...base,
    openOrders: [],
    prevActive: new Map([
      [
        "o1",
        {
          levelIndex: buyLvl,
          side: "buy" as const,
          price: g.levels[buyLvl]!,
          size: sizeBase,
        },
      ],
    ]),
  });
  const places = plan.intents.filter((i) => i.type === "place");
  assert.equal(places.length, 1, "买成交只补一张邻格卖");
  assert.equal(places[0]!.type === "place" && places[0]!.order.side, "sell");
  assert.equal(places[0]!.type === "place" && places[0]!.order.level, buyLvl + 1);
  console.log("fill-only no-seed OK");
}
checkFillOnlyNoSeed();

// 跳格：买-空-买补买；买卖夹着的现价空档不补
function checkInteriorGapFill() {
  const g = buildGrid({ lower: 63000, upper: 67000, gridCount: 80 });
  const sizeBase = 0.0033;
  const mid = g.levels[40]!;
  const mk = (id: string, level: number, side: "buy" | "sell") => ({
    id,
    market: "BTC",
    side,
    price: g.levels[level]!,
    size: sizeBase,
    level,
  });
  const base = {
    market: "BTC",
    mid,
    levels: g.levels,
    spacing: g.spacing,
    mode: "neutral" as const,
    sizeBase,
    maxWrites: 20,
    seeded: true,
    allowSeed: false,
    skipBand: 0.5,
    prevActive: new Map(),
  };
  const jump = planFromFillsAndSeed({
    ...base,
    openOrders: [mk("a", 10, "buy"), mk("b", 12, "buy")],
  });
  const jumpPlaces = jump.intents.filter((i) => i.type === "place");
  assert.equal(jumpPlaces.length, 1, "买-空-买应补中间买");
  assert.equal(jumpPlaces[0]!.type === "place" && jumpPlaces[0]!.order.level, 11);
  assert.equal(jumpPlaces[0]!.type === "place" && jumpPlaces[0]!.order.side, "buy");

  const frontier = planFromFillsAndSeed({
    ...base,
    openOrders: [mk("c", 39, "buy"), mk("d", 41, "sell")],
  });
  assert.equal(
    frontier.intents.filter((i) => i.type === "place").length,
    0,
    "现价夹在买卖之间不补"
  );
  const wide = planFromFillsAndSeed({
    ...base,
    mid: g.levels[40]!,
    openOrders: [mk("e", 38, "buy"), mk("f", 44, "sell")],
  });
  const widePlaces = wide.intents.filter((i) => i.type === "place");
  const lvls = widePlaces
    .filter((i) => i.type === "place")
    .map((i) => (i.type === "place" ? i.order.level : -1))
    .sort((a, b) => a - b);
  assert.deepEqual(lvls, [39, 41, 42, 43], "夹缝超过 1 格应向现价补到只空中间");
  const midPlace = widePlaces.find(
    (i) => i.type === "place" && i.order.level === 40
  );
  assert.equal(midPlace, undefined, "现价那一格仍空着");
  const stuck = planFromFillsAndSeed({
    ...base,
    mid: g.levels[30]!,
    openOrders: [mk("g", 36, "sell"), mk("h", 39, "sell")],
    pendingClose: [
      { side: "buy", price: g.levels[37]!, level: 37 },
      { side: "buy", price: g.levels[38]!, level: 38 },
    ],
  });
  const stuckPlaces = stuck.intents.filter((i) => i.type === "place");
  assert.equal(stuckPlaces.length, 2, "穿价回补应让档，补上中间卖单");
  assert.ok(
    stuckPlaces.every((i) => i.type === "place" && i.order.side === "sell")
  );
  console.log("interior-gap fill OK");
}
checkInteriorGapFill();

// 对账超出目标时，只撤最靠近现价的一档，保留远端保护网格
function checkTargetCapTrim() {
  const g = buildGrid({ lower: 63000, upper: 67000, gridCount: 80 });
  const mid = g.levels[40]!;
  const orders = g.levels.map((price, level) => ({
    id: `o${level}`,
    market: "BTC",
    side: (level < 40 ? "buy" : "sell") as "buy" | "sell",
    price,
    size: 0.0033,
    level,
  }));
  const plan = planFromFillsAndSeed({
    market: "BTC",
    mid,
    levels: g.levels,
    spacing: g.spacing,
    mode: "neutral",
    sizeBase: 0.0033,
    openOrders: orders,
    prevActive: new Map(),
    maxWrites: 10,
    maxOpenOrders: 80,
    seeded: true,
    allowSeed: false,
  });
  const cancels = plan.intents.filter((i) => i.type === "cancel");
  assert.equal(cancels.length, 1, "81 档应撤到目标 80 档");
  assert.equal(cancels[0]!.type === "cancel" && cancels[0]!.orderId, "o40");
  console.log("target-cap trim OK");
}
checkTargetCapTrim();

function checkLowerExtension() {
  const core = {
    lower: 0,
    upper: 0,
    halfBand: HALF_BAND,
    gridCount: 80,
    sizeBase: 0,
    leverage: 30,
    feeRate: 0.0001,
    equityUsd: 800,
    marginFraction: 0.7,
    maxWritesPerTick: 10,
    mode: "neutral" as const,
    skipBand: 0.25,
  };
  const old = anchorGrid(core, 65_000);
  const extended = anchorGrid(
    { ...core, gridCount: 90, lowerExtraLevels: 10 },
    65_000
  );
  const oldGrid = buildGrid({
    lower: old.lower,
    upper: old.upper,
    gridCount: old.gridCount,
  });
  const extendedGrid = buildGrid({
    lower: extended.lower,
    upper: extended.upper,
    gridCount: extended.gridCount,
  });
  assert.equal(extended.upper, old.upper, "下扩不能改变上沿");
  assert.equal(extended.sizeBase, old.sizeBase, "下扩不能摊薄每格 size");
  assert.equal(
    extended.marginFraction,
    core.marginFraction * (90 / 80),
    "下扩后的风险预算应覆盖新增格数"
  );
  assert.ok(
    Math.abs(extendedGrid.spacing - oldGrid.spacing) < 1e-8,
    "下扩必须保持原格距"
  );
  for (let i = 0; i < oldGrid.levels.length; i++) {
    assert.ok(
      Math.abs(extendedGrid.levels[i + 10]! - oldGrid.levels[i]!) < 1e-8,
      `旧价位 ${i} 必须保留`
    );
  }

  const migrated = applySoftResumeBand(extended, {
    gridCount: 80,
    lower: old.lower,
    upper: old.upper,
    sizeBase: old.sizeBase,
  });
  assert.ok(
    Math.abs(migrated.lower - extended.lower) < 1e-8,
    "旧软启带宽应一次性向下扩展"
  );
  const restarted = applySoftResumeBand(extended, {
    gridCount: 90,
    lower: migrated.lower,
    upper: migrated.upper,
    sizeBase: migrated.sizeBase,
  });
  assert.equal(restarted.lower, migrated.lower, "新状态重启不能重复下扩");
  console.log("lower extension OK");
}
checkLowerExtension();

function checkUpperTailAdjustments() {
  const core = {
    lower: 0,
    upper: 0,
    halfBand: HALF_BAND,
    gridCount: 80,
    sizeBase: 0,
    leverage: 30,
    feeRate: 0.0001,
    equityUsd: 800,
    marginFraction: 0.7,
    maxWritesPerTick: 20,
    mode: "neutral" as const,
    skipBand: 0.25,
  };

  const n1Before = anchorGrid(
    { ...core, gridCount: 90, lowerExtraLevels: 10 },
    65_000
  );
  const n1After = anchorGrid(
    {
      ...core,
      gridCount: 100,
      lowerExtraLevels: 10,
      upperLevelDelta: 10,
    },
    65_000
  );
  const n1OldGrid = buildGrid({
    lower: n1Before.lower,
    upper: n1Before.upper,
    gridCount: n1Before.gridCount,
  });
  const n1NewGrid = buildGrid({
    lower: n1After.lower,
    upper: n1After.upper,
    gridCount: n1After.gridCount,
  });
  assert.equal(n1After.lower, n1Before.lower, "N1 下沿不能改变");
  assert.equal(n1After.sizeBase, n1Before.sizeBase, "N1 size 不能改变");
  assert.equal(n1NewGrid.spacing, n1OldGrid.spacing, "N1 格距不能改变");
  for (let i = 0; i < n1OldGrid.levels.length; i++) {
    assert.equal(n1NewGrid.levels[i], n1OldGrid.levels[i], `N1 旧价位 ${i}`);
  }
  const n1Migrated = applySoftResumeBand(n1After, {
    gridCount: n1Before.gridCount,
    lower: n1Before.lower,
    upper: n1Before.upper,
    sizeBase: n1Before.sizeBase,
  });
  assert.equal(n1Migrated.lower, n1Before.lower, "N1 迁移下沿不动");
  assert.equal(n1Migrated.upper, n1After.upper, "N1 只扩顶部10格");

  const decBefore = anchorGrid(
    { ...core, gridCount: 100, lowerExtraLevels: 20 },
    65_000
  );
  const decAfter = anchorGrid(
    {
      ...core,
      gridCount: 90,
      lowerExtraLevels: 20,
      upperLevelDelta: -10,
    },
    65_000
  );
  const decOldGrid = buildGrid({
    lower: decBefore.lower,
    upper: decBefore.upper,
    gridCount: decBefore.gridCount,
  });
  const decNewGrid = buildGrid({
    lower: decAfter.lower,
    upper: decAfter.upper,
    gridCount: decAfter.gridCount,
  });
  assert.equal(decAfter.lower, decBefore.lower, "Dec 下沿不能改变");
  assert.equal(decAfter.sizeBase, decBefore.sizeBase, "Dec size 不能改变");
  assert.equal(decNewGrid.spacing, decOldGrid.spacing, "Dec 格距不能改变");
  for (let i = 0; i < decNewGrid.levels.length; i++) {
    assert.equal(decNewGrid.levels[i], decOldGrid.levels[i], `Dec 保留价位 ${i}`);
  }
  const decOrders = decOldGrid.levels.slice(1).map((price, i) => ({
    id: `dec-${i + 1}`,
    market: "BTC",
    side: "sell" as const,
    price,
    size: decBefore.sizeBase,
    level: i + 1,
  }));
  const decPlan = planFromFillsAndSeed({
    market: "BTC",
    mid: decNewGrid.levels[1]!,
    levels: decNewGrid.levels,
    spacing: decNewGrid.spacing,
    mode: "neutral",
    sizeBase: decAfter.sizeBase,
    openOrders: decOrders,
    prevActive: new Map(),
    maxWrites: 20,
    maxOpenOrders: 90,
    seeded: true,
    allowSeed: false,
  });
  const cancelled = decPlan.intents
    .filter((i) => i.type === "cancel")
    .map((i) => (i.type === "cancel" ? i.orderId : ""));
  assert.deepEqual(
    cancelled.sort(),
    Array.from({ length: 10 }, (_, i) => `dec-${91 + i}`).sort(),
    "Dec 只能撤最高10个卖单"
  );
  console.log("upper tail adjustments OK");
}
checkUpperTailAdjustments();

function checkProgressiveLit() {
  const mid = 85_000;
  const dec = splitProgressiveCounts(90);
  const n1 = splitProgressiveCounts(100, 0.8);
  const rise = splitProgressiveCounts(46);
  assert.deepEqual(dec, { innerCount: 54, outerEach: 18 });
  assert.deepEqual(n1, { innerCount: 80, outerEach: 10 });
  assert.deepEqual(rise, { innerCount: 28, outerEach: 9 });

  const cases = [
    { id: "decibel", gridCount: 90, lev: 30, fee: 0.00011, cell: 200, margin: 0.6, innerFrac: 0.6 },
    { id: "n1", gridCount: 100, lev: 30, fee: 0, cell: 135, margin: 0.45, innerFrac: 0.8 },
    { id: "popdex", gridCount: 90, lev: 30, fee: 0.00012, cell: 200, margin: 0.6, innerFrac: 0.6 },
    { id: "risex", gridCount: 46, lev: 25, fee: 0.0005, cell: 326, margin: 0.6, innerFrac: 0.6 },
  ];
  for (const c of cases) {
    const anchored = anchorGrid(
      {
        lower: 0,
        upper: 0,
        halfBand: Math.round(REF_MID * 0.08),
        gridCount: c.gridCount,
        sizeBase: 0,
        leverage: c.lev,
        feeRate: c.fee,
        equityUsd: 1000,
        marginFraction: c.margin,
        maxWritesPerTick: 10,
        mode: "neutral",
        skipBand: 0.25,
        innerHalfPct: 0.04,
        outerHalfPct: 0.08,
        innerFrac: c.innerFrac,
      },
      mid
    );
    assert.ok(Math.abs(anchored.lower - mid * 0.92) < 1e-6, `${c.id} lower`);
    assert.ok(Math.abs(anchored.upper - mid * 1.08) < 1e-6, `${c.id} upper`);
    const g = buildGrid({
      lower: anchored.lower,
      upper: anchored.upper,
      gridCount: c.gridCount,
      mid,
      innerHalfPct: 0.04,
      innerFrac: c.innerFrac,
    });
    assert.equal(g.levels.length, c.gridCount + 1, `${c.id} levels`);
    assert.ok(g.innerSpacing! > 0 && g.outerSpacing! > g.innerSpacing!, `${c.id} 前紧后松`);
    const cell = anchored.sizeBase * mid;
    assert.ok(Math.abs(cell - c.cell) < 2, `${c.id} 单格名义 ${cell}`);
    const risk = computeRisk(g, anchored, mid);
    const fee = assertFeeOk(risk.spacingPct, c.fee);
    assert.equal(fee.ok, true, `${c.id} ${fee.message}`);
    const margin = assertMarginOk(risk, 1000, c.margin);
    assert.equal(margin.ok, true, `${c.id} ${margin.message}`);
    console.log(
      `${c.id} lit-prog: size=${anchored.sizeBase} cell≈${cell.toFixed(1)} inner=${g.innerSpacing} outer=${g.outerSpacing}`
    );
  }

  process.env.STOP_LADDER_START = "0";
  process.env.STOP_HARD_PCT = "0.014";
  const e = edges(mid * 1.08, mid * 0.92);
  assert.ok(Math.abs(e.ladderUp - mid * 1.08) < 1e-6, "一级减仓在上沿");
  assert.ok(Math.abs(e.hardUp / mid - 1.09512) < 0.0002, `硬止上沿 ${e.hardUp}`);
  assert.ok(Math.abs(e.hardDn / mid - 0.90712) < 0.0002, `硬止下沿 ${e.hardDn}`);
  console.log("progressive Lit profile OK");
}
checkProgressiveLit();

console.log("grid.test.ts OK");
