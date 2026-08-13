import type { GridParams, VenueId } from "./types.js";
import { loadEnv } from "./loadEnv.js";

/**
 * 以各所启动瞬间 mid 为锚点。
 * - Extended：80 格、30x，带宽约 ±4.6%
 * - Phoenix：80 格、30x，带宽 ±4.5%（与 Ext 同杠杆模板）
 * - Decibel / N1：65 格、30x，带宽约 ±4.6%
 * - RISEx：46 格、25x、半幅约 ±3%
 * 保证金占用统一 70%（MARGIN_FRAC）；权益预算 800U
 */
export const REF_MID = 65_000;
export const HALF_BAND = 3000;
/** RISEx：±3% → 参考半幅 = 0.03 * REF_MID */
export const RISEX_HALF_BAND = Math.round(REF_MID * 0.03);
/** Phoenix：±4.5% */
export const PHOENIX_HALF_BAND = Math.round(REF_MID * 0.045);
const EQUITY = 800;
const MARGIN_FRAC = 0.7;
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
  n1: 65,
  risex: 46,
  decibel: 65,
};

const VENUE_HALF_BAND: Partial<Record<VenueId, number>> = {
  risex: RISEX_HALF_BAND,
  phoenix: PHOENIX_HALF_BAND,
};

const VENUE_MAX_OPEN: Partial<Record<VenueId, number>> = {
  extended: 82,
  phoenix: 82,
  n1: 67,
  risex: 50,
  decibel: 67,
};

/** 分所默认杠杆（可被 env 覆盖） */
const VENUE_LEVERAGE: Record<VenueId, number> = {
  extended: 30,
  phoenix: PHOENIX_LEVERAGE,
  n1: 30,
  decibel: 30,
  risex: RISEX_LEVERAGE,
};

const ALL_VENUES: VenueId[] = ["extended", "risex", "decibel", "n1", "phoenix"];

function truthy(v: string | undefined): boolean {
  return ["1", "true", "yes", "YES"].includes(String(v || "").trim());
}

export type RuntimeConfig = {
  dryRun: boolean;
  liveConfirm: boolean;
  venues: VenueId[];
  markets: string[];
  tickMs: number;
  dashboardHost: string;
  dashboardPort: number;
  recenter: {
    enabled: boolean;
    triggerRatio: number;
    confirmTicks: number;
    cooldownMs: number;
    cancelTimeoutMs: number;
    maxPositionNotionalUsd: number;
  };
  grids: Record<VenueId, GridParams>;
};

export function gridFor(cfg: RuntimeConfig, venue: VenueId): GridParams {
  return cfg.grids[venue];
}

export function anchorGrid(base: GridParams, mid: number): GridParams {
  if (!(mid > 0)) throw new Error(`无效 mid=${mid}`);
  const refHalf = base.halfBand || HALF_BAND;
  const half = mid * (refHalf / REF_MID);
  const lower = mid - half;
  const upper = mid + half;
  const notional = base.equityUsd * base.marginFraction * base.leverage;
  const sizeBase =
    Math.floor((notional / (base.gridCount * mid)) * 1e8) / 1e8;
  return { ...base, halfBand: half, lower, upper, sizeBase };
}

function leverageFor(venue: VenueId, fallbackGridLev: number): number {
  if (venue === "risex") {
    return Math.max(
      1,
      Number(process.env.RISEX_LEVERAGE || process.env.RISE_LEVERAGE || RISEX_LEVERAGE) ||
        RISEX_LEVERAGE
    );
  }
  if (venue === "phoenix") {
    // 只认 PHOENIX_LEVERAGE；不受 GRID_LEVERAGE 误覆盖
    return Math.max(
      1,
      Number(process.env.PHOENIX_LEVERAGE || PHOENIX_LEVERAGE) || PHOENIX_LEVERAGE
    );
  }
  const envKey =
    venue === "extended"
      ? process.env.EXTENDED_LEVERAGE
      : venue === "decibel"
        ? process.env.DECIBEL_LEVERAGE
        : process.env.N1_LEVERAGE;
  // 分所默认优先于 GRID_LEVERAGE，避免本机 GRID_LEVERAGE=15 拖垮五所定档 30x
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
  const dashboardHost = String(process.env.DASHBOARD_HOST || "127.0.0.1").trim();
  if (!["127.0.0.1", "::1", "localhost"].includes(dashboardHost)) {
    throw new Error(
      `DASHBOARD_HOST=${dashboardHost} 不安全：看板只允许监听本机回环地址，请用 Tailscale Serve 代理访问`
    );
  }
  const recenter = {
    enabled: truthy(process.env.GRID_RECENTER_ENABLED),
    triggerRatio: Math.min(
      0.95,
      Math.max(0.1, Number(process.env.GRID_RECENTER_RATIO || 0.65) || 0.65)
    ),
    confirmTicks: Math.max(
      1,
      Math.floor(Number(process.env.GRID_RECENTER_CONFIRM_TICKS || 3) || 3)
    ),
    cooldownMs: Math.max(
      0,
      Number(process.env.GRID_RECENTER_COOLDOWN_MS || 600_000) || 600_000
    ),
    cancelTimeoutMs: Math.max(
      tickMs,
      Number(process.env.GRID_RECENTER_CANCEL_TIMEOUT_MS || 900_000) || 900_000
    ),
    maxPositionNotionalUsd: Math.max(
      0,
      Number(process.env.GRID_RECENTER_MAX_POSITION_USD || 1) || 1
    ),
  };
  if (recenter.enabled && markets.length !== 1) {
    throw new Error("启用 GRID_RECENTER_ENABLED 时 MARKETS 必须只配置一个市场");
  }
  const effectiveVenues = venues.length ? venues : ALL_VENUES;
  if (recenter.enabled && !dryRun && effectiveVenues.includes("phoenix")) {
    throw new Error("Phoenix 实盘无法可靠回读网格订单 ID，暂不支持自动重心化");
  }

  const grids = {} as Record<VenueId, GridParams>;
  for (const v of ALL_VENUES) {
    const gridCount = VENUE_GRID_COUNT[v];
    const venueLev = leverageFor(v, leverage);
    const venueHalf =
      v === "risex"
        ? Math.max(
            100,
            Number(process.env.RISEX_HALF_BAND || VENUE_HALF_BAND.risex || RISEX_HALF_BAND) ||
              RISEX_HALF_BAND
          )
        : v === "phoenix"
          ? Math.max(
              100,
              Number(
                process.env.PHOENIX_HALF_BAND || VENUE_HALF_BAND.phoenix || PHOENIX_HALF_BAND
              ) || PHOENIX_HALF_BAND
            )
          : halfBand;
    grids[v] = {
      ...SHARED,
      marginFraction,
      halfBand: venueHalf,
      leverage: venueLev,
      ...(v === "phoenix" ? { feeRate: 0.00005 } : {}),
      lower: 0,
      upper: 0,
      gridCount,
      sizeBase: 0,
      ...(VENUE_MAX_OPEN[v] != null ? { maxOpenOrders: VENUE_MAX_OPEN[v] } : {}),
    };
  }

  return {
    dryRun,
    liveConfirm,
    venues: venues.length ? venues : [...ALL_VENUES],
    markets: markets.length ? markets : ["BTC"],
    tickMs,
    dashboardHost,
    dashboardPort,
    recenter,
    grids,
  };
}

export function assertLiveAllowed(cfg: RuntimeConfig): void {
  if (cfg.dryRun) return;
  if (!cfg.liveConfirm) {
    throw new Error("拒绝实盘：需要 LIVE_CONFIRM=YES（且 DRY_RUN=0）");
  }
}
