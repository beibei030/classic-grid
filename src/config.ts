import type { GridMode, GridParams, VenueId } from "./types.js";
import { loadEnv } from "./loadEnv.js";

/**
 * 以各所启动瞬间 mid 为锚点。
 * 现档（与正在跑的 Decibel / PopDEX 相同）：90 格、30x、1000U × 60%，
 * 前紧后松，中心 ±4%、外层 ±8%。Extended / Phoenix / Phoenix2 / Nado 用这套。
 * - N1：100 格、保证金 45%、中心加密到 80% 档（0 费，挂单上限约 100）
 * - RISEx：46 格、25x（所上挂单硬顶 50、杠杆上限）
 * - Entropy / Pacifica / Lighter：未并进这套，仍是旧档
 */
export const REF_MID = 65_000;
export const HALF_BAND = 3000;
/** RISEx：±3% → 参考半幅 = 0.03 * REF_MID */
export const RISEX_HALF_BAND = Math.round(REF_MID * 0.03);
/** Phoenix：±4.5% */
export const PHOENIX_HALF_BAND = Math.round(REF_MID * 0.045);
/** Decibel / N1：±5%（相对 Ext ±4.6% 略加宽，改善费率边） */
export const DECIBEL_HALF_BAND = Math.round(REF_MID * 0.05);
export const N1_HALF_BAND = Math.round(REF_MID * 0.05);
const EQUITY = 800;
const PACIFICA_EQUITY = 1000;
const MARGIN_FRAC = 0.7;
const PACIFICA_MARGIN_FRAC = 0.6;
const LEVERAGE = 30;
/** RISEx 所上杠杆上限按 25 处理 */
const RISEX_LEVERAGE = 25;
/** Phoenix：与 Ext 对齐 30x（不再默认 40） */
const PHOENIX_LEVERAGE = 30;

const SHARED = {
  halfBand: HALF_BAND,
  leverage: LEVERAGE,
  feeRate: 0.0005,
  equityUsd: EQUITY,
  marginFraction: MARGIN_FRAC,
  maxWritesPerTick: 10,
  mode: "neutral" as const,
  /**
   * 仅 seed 时跳过贴 mid 的档（×spacing）。成交补单不跳、近价单不撤。
   * 摩擦偏仓靠手动重挂，不靠空近价档。
   */
  skipBand: 0.25,
};

/** Ext 模板（兼容旧引用） */
export const GRID: GridParams = {
  ...SHARED,
  lower: 0,
  upper: 0,
  gridCount: 80,
  sizeBase: 0,
};

const VENUE_GRID_COUNT: Record<VenueId, number> = {
  extended: 80,
  phoenix: 80,
  phoenix2: 80,
  nado: 80,
  popdex: 80,
  entropy: 80,
  pacifica: 80,
  lighter: 80,
  n1: 80,
  risex: 46,
  decibel: 80,
};

const VENUE_LOWER_EXTRA: Partial<Record<VenueId, number>> = {
  decibel: 20,
  n1: 10,
  popdex: 10,
  pacifica: 10,
  lighter: 10,
};

const VENUE_UPPER_DELTA: Partial<Record<VenueId, number>> = {
  decibel: -10,
  n1: 10,
};

const VENUE_HALF_BAND: Partial<Record<VenueId, number>> = {
  risex: DECIBEL_HALF_BAND,
  phoenix: PHOENIX_HALF_BAND,
  phoenix2: PHOENIX_HALF_BAND,
  nado: PHOENIX_HALF_BAND,
  popdex: PHOENIX_HALF_BAND,
  decibel: DECIBEL_HALF_BAND,
  n1: N1_HALF_BAND,
  entropy: DECIBEL_HALF_BAND,
  pacifica: DECIBEL_HALF_BAND,
  lighter: DECIBEL_HALF_BAND,
};

const VENUE_MAX_OPEN: Partial<Record<VenueId, number>> = {
  extended: 82,
  phoenix: 82,
  phoenix2: 82,
  nado: 82,
  popdex: 82,
  n1: 82,
  risex: 50,
  decibel: 82,
  entropy: 82,
  pacifica: 82,
  lighter: 82,
};

/** 分所默认杠杆（可被 env 覆盖） */
const VENUE_LEVERAGE: Record<VenueId, number> = {
  extended: 30,
  phoenix: PHOENIX_LEVERAGE,
  phoenix2: PHOENIX_LEVERAGE,
  nado: 30,
  popdex: 30,
  n1: 30,
  decibel: 30,
  entropy: 30,
  pacifica: 30,
  lighter: 30,
  risex: RISEX_LEVERAGE,
};

const ALL_VENUES: VenueId[] = [
  "extended",
  "risex",
  "decibel",
  "n1",
  "phoenix",
  "phoenix2",
  "nado",
  "popdex",
  "entropy",
  "pacifica",
  "lighter",
];

function truthy(v: string | undefined): boolean {
  return ["1", "true", "yes", "YES"].includes(String(v || "").trim());
}

export type RuntimeConfig = {
  dryRun: boolean;
  liveConfirm: boolean;
  venues: VenueId[];
  markets: string[];
  tickMs: number;
  dashboardPort: number;
  grids: Record<VenueId, GridParams>;
};

export function gridFor(cfg: RuntimeConfig, venue: VenueId): GridParams {
  return cfg.grids[venue];
}

function isLitProg(): boolean {
  return String(process.env.GRID_PROFILE || "").trim().toLowerCase() === "lit-prog";
}

function isLitProgVenue(venue: VenueId): boolean {
  return (
    isLitProg() &&
    (venue === "decibel" || venue === "n1" || venue === "popdex" || venue === "risex")
  );
}

/** 与正在跑的 Decibel / PopDEX 同一套，不依赖 GRID_PROFILE。 */
function usesDecTemplate(venue: VenueId): boolean {
  return (
    venue === "extended" ||
    venue === "phoenix" ||
    venue === "phoenix2" ||
    venue === "nado"
  );
}

export function anchorGrid(base: GridParams, mid: number): GridParams {
  if (!(mid > 0)) throw new Error(`无效 mid=${mid}`);
  if (base.innerHalfPct && base.outerHalfPct && base.innerHalfPct < base.outerHalfPct) {
    const outerHalf = mid * base.outerHalfPct;
    const notional = base.equityUsd * base.marginFraction * base.leverage;
    const sizeBase =
      Math.floor((notional / (base.gridCount * mid)) * 1e8) / 1e8;
    return {
      ...base,
      halfBand: outerHalf,
      lower: mid - outerHalf,
      upper: mid + outerHalf,
      sizeBase,
    };
  }
  const refHalf = base.halfBand || HALF_BAND;
  const half = mid * (refHalf / REF_MID);
  const lowerExtraLevels = Math.max(0, Math.floor(base.lowerExtraLevels || 0));
  const upperLevelDelta = Math.floor(base.upperLevelDelta || 0);
  const coreGridCount = Math.max(
    2,
    base.gridCount - lowerExtraLevels - upperLevelDelta
  );
  const spacing = (half * 2) / coreGridCount;
  const lower = mid - half - lowerExtraLevels * spacing;
  const upper = mid + half + upperLevelDelta * spacing;
  const marginFraction = Math.min(
    1,
    base.marginFraction * (base.gridCount / coreGridCount)
  );
  const notional = base.equityUsd * base.marginFraction * base.leverage;
  const sizeBase =
    Math.floor((notional / (coreGridCount * mid)) * 1e8) / 1e8;
  return {
    ...base,
    halfBand: half,
    lower,
    upper,
    marginFraction,
    sizeBase,
  };
}

export function applySoftResumeBand(
  anchored: GridParams,
  resume: {
    gridCount: number;
    lower: number;
    upper: number;
    sizeBase?: number;
  }
): GridParams {
  const lowerExtraLevels = Math.max(
    0,
    Math.floor(anchored.lowerExtraLevels || 0)
  );
  const upperLevelDelta = Math.floor(anchored.upperLevelDelta || 0);
  const coreGridCount =
    anchored.gridCount - lowerExtraLevels - upperLevelDelta;
  const migrateCoreBand =
    lowerExtraLevels > 0 &&
    resume.gridCount === coreGridCount &&
    resume.upper > resume.lower;
  const migrateUpperOnly =
    upperLevelDelta !== 0 &&
    resume.gridCount === anchored.gridCount - upperLevelDelta &&
    resume.upper > resume.lower;
  const oldSpacing =
    migrateCoreBand || migrateUpperOnly
      ? (resume.upper - resume.lower) / resume.gridCount
      : 0;
  return {
    ...anchored,
    lower: migrateCoreBand
      ? resume.lower - lowerExtraLevels * oldSpacing
      : resume.lower,
    upper:
      migrateCoreBand || migrateUpperOnly
        ? resume.upper + upperLevelDelta * oldSpacing
        : resume.upper,
    sizeBase:
      resume.sizeBase != null && resume.sizeBase > 0
        ? resume.sizeBase
        : anchored.sizeBase,
  };
}

function leverageFor(venue: VenueId, fallbackGridLev: number): number {
  if (venue === "risex") {
    return Math.max(
      1,
      Number(process.env.RISEX_LEVERAGE || process.env.RISE_LEVERAGE || RISEX_LEVERAGE) ||
        RISEX_LEVERAGE
    );
  }
  if (venue === "phoenix" || venue === "phoenix2") {
    const envLev =
      venue === "phoenix2"
        ? process.env.PHOENIX2_LEVERAGE || process.env.PHOENIX_LEVERAGE
        : process.env.PHOENIX_LEVERAGE;
    return Math.max(1, Number(envLev || PHOENIX_LEVERAGE) || PHOENIX_LEVERAGE);
  }
  if (venue === "nado") {
    return Math.max(1, Number(process.env.NADO_LEVERAGE || 30) || 30);
  }
  if (venue === "popdex") {
    return Math.max(1, Number(process.env.POPDEX_LEVERAGE || 30) || 30);
  }
  if (venue === "entropy") {
    return Math.max(1, Number(process.env.ENTROPY_LEVERAGE || 30) || 30);
  }
  if (venue === "pacifica") {
    return Math.max(1, Number(process.env.PACIFICA_LEVERAGE || 30) || 30);
  }
  if (venue === "lighter") {
    return Math.max(1, Number(process.env.LIGHTER_LEVERAGE || 30) || 30);
  }
  const envKey =
    venue === "extended"
      ? process.env.EXTENDED_LEVERAGE
      : venue === "decibel"
        ? process.env.DECIBEL_LEVERAGE
        : process.env.N1_LEVERAGE;
  // 分所默认优先于 GRID_LEVERAGE，避免本机 GRID_LEVERAGE 误覆盖定档
  return Math.max(
    1,
    Number(
      envKey ||
        VENUE_LEVERAGE[venue] ||
        process.env.GRID_LEVERAGE ||
        fallbackGridLev
    ) ||
      VENUE_LEVERAGE[venue] ||
      fallbackGridLev
  );
}

function equityFor(venue: VenueId): number {
  if (isLitProgVenue(venue) || usesDecTemplate(venue)) {
    const n = Number(
      venue === "decibel"
        ? process.env.DECIBEL_EQUITY_USD
        : venue === "n1"
          ? process.env.N1_EQUITY_USD
          : venue === "popdex"
            ? process.env.POPDEX_EQUITY_USD
            : venue === "risex"
              ? process.env.RISEX_EQUITY_USD
              : ""
    );
    if (Number.isFinite(n) && n > 0) return n;
    return 1000;
  }
  if (venue === "popdex") {
    const n = Number(process.env.POPDEX_EQUITY_USD);
    if (Number.isFinite(n) && n > 0) return n;
    return EQUITY;
  }
  if (venue === "risex") {
    const n = Number(process.env.RISEX_EQUITY_USD);
    if (Number.isFinite(n) && n > 0) return n;
    return EQUITY;
  }
  if (venue === "entropy") {
    const n = Number(process.env.ENTROPY_EQUITY_USD);
    if (Number.isFinite(n) && n > 0) return n;
    return EQUITY;
  }
  if (venue === "pacifica") {
    const n = Number(process.env.PACIFICA_EQUITY_USD);
    if (Number.isFinite(n) && n > 0) return n;
    return PACIFICA_EQUITY;
  }
  if (venue === "lighter") {
    const n = Number(process.env.LIGHTER_EQUITY_USD);
    if (Number.isFinite(n) && n > 0) return n;
    return PACIFICA_EQUITY;
  }
  const envKey =
    venue === "decibel"
      ? process.env.DECIBEL_EQUITY_USD
      : venue === "n1"
        ? process.env.N1_EQUITY_USD
        : "";
  const n = Number(envKey);
  if (Number.isFinite(n) && n >= 50) return n;
  return EQUITY;
}

function marginFor(venue: VenueId, fallback: number): number {
  if (isLitProgVenue(venue) || usesDecTemplate(venue)) {
    const n = Number(
      venue === "decibel"
        ? process.env.DECIBEL_MARGIN_FRAC
        : venue === "n1"
          ? process.env.N1_MARGIN_FRAC
          : venue === "popdex"
            ? process.env.POPDEX_MARGIN_FRAC
            : venue === "risex"
              ? process.env.RISEX_MARGIN_FRAC
              : ""
    );
    if (Number.isFinite(n) && n >= 0.05 && n <= 1) return n;
    return venue === "n1" ? 0.45 : 0.6;
  }
  if (venue === "pacifica") {
    const n = Number(process.env.PACIFICA_MARGIN_FRAC);
    if (Number.isFinite(n) && n >= 0.05 && n <= 1) return n;
    return PACIFICA_MARGIN_FRAC;
  }
  if (venue === "lighter") {
    const n = Number(process.env.LIGHTER_MARGIN_FRAC);
    if (Number.isFinite(n) && n >= 0.05 && n <= 1) return n;
    return PACIFICA_MARGIN_FRAC;
  }
  return fallback;
}

export function loadRuntimeConfig(): RuntimeConfig {
  loadEnv();
  const dryRun = process.env.DRY_RUN == null ? true : truthy(process.env.DRY_RUN);
  const liveConfirm = truthy(process.env.LIVE_CONFIRM);
  const venues = String(process.env.VENUES || "extended,risex,decibel,n1")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .filter((v): v is VenueId => (ALL_VENUES as string[]).includes(v));
  const markets = String(process.env.MARKETS || "BTC")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const tickMs = Math.max(1000, Number(process.env.TICK_MS || 15_000) || 15_000);
  const leverage = Math.max(
    1,
    Number(process.env.GRID_LEVERAGE || LEVERAGE) || LEVERAGE
  );
  const marginFraction = Math.min(
    1,
    Math.max(
      0.05,
      Number(process.env.GRID_MARGIN_FRAC || MARGIN_FRAC) || MARGIN_FRAC
    )
  );
  const halfBand = Math.max(
    100,
    Number(process.env.GRID_HALF_BAND || HALF_BAND) || HALF_BAND
  );
  const dashboardPort = Math.max(
    0,
    Number(process.env.DASHBOARD_PORT || 8088) || 8088
  );

  const grids = {} as Record<VenueId, GridParams>;
  for (const v of ALL_VENUES) {
    const litProg = isLitProgVenue(v);
    const current = litProg || usesDecTemplate(v);
    const coreGridCount = current
      ? v === "n1"
        ? 100
        : v === "risex"
          ? 46
          : 90
      : v === "popdex"
        ? Math.max(
            2,
            Number(process.env.POPDEX_GRID_COUNT || VENUE_GRID_COUNT.popdex) ||
              VENUE_GRID_COUNT.popdex
          )
        : VENUE_GRID_COUNT[v];
    const lowerExtraLevels = current ? 0 : VENUE_LOWER_EXTRA[v] || 0;
    const upperLevelDelta = current ? 0 : VENUE_UPPER_DELTA[v] || 0;
    const gridCount =
      coreGridCount + lowerExtraLevels + upperLevelDelta;
    const venueLev = leverageFor(v, leverage);
    const venueHalf = current
      ? Math.round(REF_MID * 0.08)
      : v === "risex"
        ? Math.max(
            100,
            Number(process.env.RISEX_HALF_BAND || VENUE_HALF_BAND.risex || RISEX_HALF_BAND) ||
              RISEX_HALF_BAND
          )
        : v === "phoenix" || v === "phoenix2" || v === "nado" || v === "popdex"
          ? Math.max(
              100,
              Number(
                (v === "nado"
                  ? process.env.NADO_HALF_BAND
                  : v === "popdex"
                    ? process.env.POPDEX_HALF_BAND || process.env.PHOENIX_HALF_BAND
                    : v === "phoenix2"
                      ? process.env.PHOENIX2_HALF_BAND || process.env.PHOENIX_HALF_BAND
                      : process.env.PHOENIX_HALF_BAND) ||
                  VENUE_HALF_BAND[v] ||
                  PHOENIX_HALF_BAND
              ) || PHOENIX_HALF_BAND
            )
          : v === "decibel" || v === "n1" || v === "entropy" || v === "pacifica" || v === "lighter"
            ? Math.max(
                100,
                Number(
                  (v === "n1"
                    ? process.env.N1_HALF_BAND || process.env.DECIBEL_HALF_BAND
                    : v === "entropy"
                      ? process.env.ENTROPY_HALF_BAND || process.env.DECIBEL_HALF_BAND
                      : v === "pacifica"
                        ? process.env.PACIFICA_HALF_BAND || process.env.DECIBEL_HALF_BAND
                        : v === "lighter"
                          ? process.env.LIGHTER_HALF_BAND || process.env.DECIBEL_HALF_BAND
                          : process.env.DECIBEL_HALF_BAND || process.env.N1_HALF_BAND) ||
                    VENUE_HALF_BAND[v] ||
                    DECIBEL_HALF_BAND
                ) || DECIBEL_HALF_BAND
              )
            : halfBand;
    grids[v] = {
      ...SHARED,
      equityUsd: equityFor(v),
      marginFraction: marginFor(v, marginFraction),
      halfBand: venueHalf,
      leverage: venueLev,
      // Phoenix maker 更低；Nado / N1 / Decibel / PopDEX 按所 maker 档
      ...(v === "phoenix" || v === "phoenix2" ? { feeRate: 0.00005 } : {}),
      // Phoenix 两所可临时切单边（PHOENIX_MODE=long 只留下方买单，撤上方卖单不加空）
      ...(v === "phoenix" || v === "phoenix2"
        ? {
            mode: (
              process.env.PHOENIX_MODE === "long" || process.env.PHOENIX_MODE === "short"
                ? process.env.PHOENIX_MODE
                : "neutral"
            ) as GridMode,
          }
        : {}),
      ...(v === "nado" ? { feeRate: 0.0001 } : {}),
      ...(v === "n1" ? { feeRate: 0 } : {}),
      ...(v === "popdex" ? { feeRate: 0.00012 } : {}),
      ...(v === "decibel" ? { feeRate: 0.00011 } : {}),
      ...(v === "entropy" || v === "pacifica" ? { feeRate: 0.00015 } : {}),
      ...(v === "lighter" ? { feeRate: 0 } : {}),
      // 换带宽时加快撤挂收敛（仓位不动，只改单）
      ...(v === "decibel" || v === "n1" || v === "entropy" || v === "pacifica" || (current && (v === "popdex" || usesDecTemplate(v)))
        ? { maxWritesPerTick: 40 }
        : {}),
      ...(v === "lighter" ? { maxWritesPerTick: 15 } : {}),
      lower: 0,
      upper: 0,
      gridCount,
      ...(lowerExtraLevels > 0 ? { lowerExtraLevels } : {}),
      ...(upperLevelDelta !== 0 ? { upperLevelDelta } : {}),
      ...(current
        ? {
            innerHalfPct: 0.04,
            outerHalfPct: 0.08,
            innerFrac: v === "n1" ? 0.8 : 0.6,
          }
        : {}),
      sizeBase: 0,
      ...(VENUE_MAX_OPEN[v] != null
        ? { maxOpenOrders: Math.max(VENUE_MAX_OPEN[v]!, gridCount + 2) }
        : {}),
    };
  }

  return {
    dryRun,
    liveConfirm,
    venues: venues.length ? venues : [...ALL_VENUES],
    markets: markets.length ? markets : ["BTC"],
    tickMs,
    dashboardPort,
    grids,
  };
}

export function assertLiveAllowed(cfg: RuntimeConfig): void {
  if (cfg.dryRun) return;
  if (!cfg.liveConfirm) {
    throw new Error("拒绝实盘：需要 LIVE_CONFIRM=YES（且 DRY_RUN=0）");
  }
}
