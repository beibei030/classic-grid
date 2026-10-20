import type { TopOfBook } from "../venues/types.js";

export type HedgeVenue = "decibel" | "popdex";

export function shortVenueForFunding(
  decRate: number,
  popRate: number
): HedgeVenue {
  return decRate >= popRate ? "decibel" : "popdex";
}

export function chooseCommonMakerPrice(
  decBook: TopOfBook,
  popBook: TopOfBook,
  shortVenue: HedgeVenue
): number | null {
  // 两所共同 tick 取 Pop 的 1U；buy 必须低于 ask，sell 必须高于 bid。
  const low =
    shortVenue === "decibel" ? decBook.bid + 0.1 : popBook.bid + 1;
  const high =
    shortVenue === "decibel" ? popBook.ask - 1 : decBook.ask - 0.1;
  const minPrice = Math.ceil(low);
  const maxPrice = Math.floor(high);
  return minPrice <= maxPrice
    ? Math.round((minPrice + maxPrice) / 2)
    : null;
}

export function isNeutralPair(
  decPosition: number,
  popPosition: number,
  targetQty: number
): boolean {
  const tolerance = Math.max(1e-8, targetQty * 0.05);
  const bothFilled =
    Math.abs(decPosition) >= targetQty * 0.95 &&
    Math.abs(popPosition) >= targetQty * 0.95;
  return (
    bothFilled &&
    Math.sign(decPosition) === -Math.sign(popPosition) &&
    Math.abs(decPosition + popPosition) <= tolerance
  );
}
