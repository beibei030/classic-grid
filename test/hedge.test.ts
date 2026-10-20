import assert from "node:assert/strict";
import {
  chooseCommonMakerPrice,
  isNeutralPair,
  shortVenueForFunding,
} from "../src/hedge/core.js";

assert.equal(shortVenueForFunding(0.0001, 0.00005), "decibel");
assert.equal(shortVenueForFunding(-0.0001, 0.00005), "popdex");

assert.equal(
  chooseCommonMakerPrice(
    { bid: 85_000.1, ask: 85_001.1, updatedAt: 0 },
    { bid: 85_000, ask: 85_002, updatedAt: 0 },
    "decibel"
  ),
  85_001
);
assert.equal(
  chooseCommonMakerPrice(
    { bid: 85_000, ask: 85_010, updatedAt: 0 },
    { bid: 84_999, ask: 85_011, updatedAt: 0 },
    "decibel"
  ),
  85_006,
  "共同 maker 区间应取中点，避免贴边穿价"
);
assert.equal(
  chooseCommonMakerPrice(
    { bid: 85_001, ask: 85_002, updatedAt: 0 },
    { bid: 85_002, ask: 85_003, updatedAt: 0 },
    "popdex"
  ),
  null,
  "没有共同 maker 区间时必须等待"
);

assert.equal(isNeutralPair(0.0002, -0.0002, 0.0002), true);
assert.equal(isNeutralPair(0.0002, -0.00019, 0.0002), true);
assert.equal(isNeutralPair(0.0002, 0, 0.0002), false);
assert.equal(isNeutralPair(0.0002, -0.0001, 0.0002), false);
assert.equal(isNeutralPair(0.0002, -0.00015, 0.0002), false);

console.log("hedge.test.ts OK");
