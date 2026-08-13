import assert from "node:assert/strict";
import { HALF_BAND, REF_MID, anchorGrid } from "../src/config.js";
import {
  assertFeeOk,
  assertMarginOk,
  buildGrid,
  computeRisk,
  evaluateRecenter,
  planFromFillsAndSeed,
  seedOrders,
} from "../src/grid.js";

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

const firstRecenterCheck = evaluateRecenter({
  mid: 1066,
  anchorMid: 1000,
  halfBand: 100,
  spacing: 10,
  triggerRatio: 0.65,
  previousConfirmTicks: 0,
  confirmTicks: 3,
  now: 10_000,
  lastRecenterAt: 0,
  cooldownMs: 60_000,
});
assert.equal(firstRecenterCheck.distance.spacingUnits, 6.6);
assert.equal(firstRecenterCheck.nextConfirmTicks, 1);
assert.equal(firstRecenterCheck.ready, false);

const confirmedRecenter = evaluateRecenter({
  mid: 1066,
  anchorMid: 1000,
  halfBand: 100,
  spacing: 10,
  triggerRatio: 0.65,
  previousConfirmTicks: 2,
  confirmTicks: 3,
  now: 10_000,
  lastRecenterAt: 0,
  cooldownMs: 60_000,
});
assert.equal(confirmedRecenter.ready, true);

const coolingDown = evaluateRecenter({
  mid: 1080,
  anchorMid: 1000,
  halfBand: 100,
  spacing: 10,
  triggerRatio: 0.65,
  previousConfirmTicks: 2,
  confirmTicks: 3,
  now: 50_000,
  lastRecenterAt: 10_000,
  cooldownMs: 60_000,
});
assert.equal(coolingDown.coolingDown, true);
assert.equal(coolingDown.nextConfirmTicks, 0);
assert.equal(coolingDown.ready, false);

const baseForRecenter = {
  lower: 0,
  upper: 0,
  halfBand: HALF_BAND,
  gridCount: 80,
  sizeBase: 0,
  leverage: 30,
  feeRate: 0.0005,
  equityUsd: 800,
  marginFraction: 0.3,
  maxWritesPerTick: 10,
  mode: "neutral" as const,
  skipBand: 0.25,
};
const recenteredAt120k = anchorGrid(baseForRecenter, 120_000);
assert.ok(
  Math.abs(recenteredAt120k.halfBand - 120_000 * (HALF_BAND / REF_MID)) < 1e-6
);

const ownershipPlan = planFromFillsAndSeed({
  market: "BTC",
  mid: 100,
  levels: [90, 100, 110],
  spacing: 10,
  mode: "neutral",
  sizeBase: 1,
  openOrders: [
    { id: "manual", market: "BTC", side: "buy", price: 200, size: 1, level: 0 },
    { id: "owned", market: "BTC", side: "buy", price: 210, size: 1, level: 0 },
  ],
  prevActive: new Map(),
  maxWrites: 10,
  seeded: true,
  cancellableOrderIds: new Set(["owned"]),
});
const cancelledIds = ownershipPlan.intents
  .filter((intent): intent is Extract<(typeof ownershipPlan.intents)[number], { type: "cancel" }> =>
    intent.type === "cancel"
  )
  .map((intent) => intent.orderId);
assert.deepEqual(cancelledIds, ["owned"]);
assert.equal(ownershipPlan.nextActive.has("manual"), false);

console.log("grid.test.ts OK");
