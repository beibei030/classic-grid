import type { GridParams, VenueId } from "./types.js";
import { loadEnv } from "./loadEnv.js";

/**
 * 以各所启动瞬间 mid 为锚点。
 * 现档：Decibel / PopDEX 为 90 格、30x、1000U × 60%，
 * 前紧后松，中心 ±4%、外层 ±8%。
 * - N1：100 格、保证金 45%、中心加密到 80% 档（0 费，挂单上限约 100）
 * - RISEx：46 格、25x（所上挂单硬顶 50、杠杆上限）
 */
export const REF_MID = 65_000;
/** 外层半幅 ±8% */
export const HALF_BAND = Math.round(REF_MID * 0.08);
const EQUITY = 1000;
const MARGIN_FRAC = 0.6;
const LEVERAGE = 30;
/** RISEx 所上杠杆上限按 25 处理 */
const RISEX_LEVERAGE = 25;

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

/** 默认定档（兼容旧引用）：90 格、外层 ±8% */
export const GRID: GridParams = {
  ...SHARED,
  lower: 0,
  upper: 0,
  gridCount: 90,
  sizeBase: 0,
};

const VENUE_GRID_COUNT: Record<VenueId, number> = {
  decibel: 90,
  popdex: 90,
  n1: 100,
  risex: 46,
};

const VENUE_MAX_OPEN: Record<VenueId, number> = {
  decibel: 92,
  popdex: 92,
  n1: 102,
  risex: 50,
};

/** 分所默认杠杆（可被 env 覆盖） */
const VENUE_LEVERAGE: Record<VenueId, number> = {
  decibel: 30,
  popdex: 30,
  n1: 30,
  risex: RISEX_LEVERAGE,
};

const ALL_VENUES: VenueId[] = ["decibel", "n1", "popdex", "risex"];

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
  if (venue === "popdex") {
    return Math.max(1, Number(process.env.POPDEX_LEVERAGE || 30) || 30);
  }
  const envKey =
    venue === "decibel" ? process.env.DECIBEL_LEVERAGE : process.env.N1_LEVERAGE;
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
  const n = Number(
    venue === "decibel"
      ? process.env.DECIBEL_EQUITY_USD
      : venue === "n1"
        ? process.env.N1_EQUITY_USD
        : venue === "popdex"
          ? process.env.POPDEX_EQUITY_USD
          : process.env.RISEX_EQUITY_USD
  );
  if (Number.isFinite(n) && n > 0) return n;
  return EQUITY;
}

function marginFor(venue: VenueId): number {
  const n = Number(
    venue === "decibel"
      ? process.env.DECIBEL_MARGIN_FRAC
      : venue === "n1"
        ? process.env.N1_MARGIN_FRAC
        : venue === "popdex"
          ? process.env.POPDEX_MARGIN_FRAC
          : process.env.RISEX_MARGIN_FRAC
  );
  if (Number.isFinite(n) && n >= 0.05 && n <= 1) return n;
  return venue === "n1" ? 0.45 : MARGIN_FRAC;
}

export function loadRuntimeConfig(): RuntimeConfig {
  loadEnv();
  const dryRun = process.env.DRY_RUN == null ? true : truthy(process.env.DRY_RUN);
  const liveConfirm = truthy(process.env.LIVE_CONFIRM);
  const venues = String(process.env.VENUES || "decibel,n1,popdex,risex")
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
  const dashboardPort = Math.max(
    0,
    Number(process.env.DASHBOARD_PORT || 8088) || 8088
  );

  const grids = {} as Record<VenueId, GridParams>;
  for (const v of ALL_VENUES) {
    const gridCount = VENUE_GRID_COUNT[v];
    const venueLev = leverageFor(v, leverage);
    grids[v] = {
      ...SHARED,
      equityUsd: equityFor(v),
      marginFraction: marginFor(v),
      halfBand: HALF_BAND,
      leverage: venueLev,
      ...(v === "n1" ? { feeRate: 0 } : {}),
      ...(v === "popdex" ? { feeRate: 0.00012 } : {}),
      ...(v === "decibel" ? { feeRate: 0.00011 } : {}),
      ...(v === "decibel" || v === "n1" || v === "popdex"
        ? { maxWritesPerTick: 40 }
        : {}),
      lower: 0,
      upper: 0,
      gridCount,
      innerHalfPct: 0.04,
      outerHalfPct: 0.08,
      innerFrac: v === "n1" ? 0.8 : 0.6,
      sizeBase: 0,
      maxOpenOrders: Math.max(VENUE_MAX_OPEN[v], gridCount + 2),
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
