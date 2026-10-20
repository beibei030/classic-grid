/**
 * 各所独立止损：阶梯减仓 + 硬止损；硬止后持久锁定，等待人工恢复。
 * 硬止损优先挂交易所侧；bot 每 tick 兜底。各所状态互不影响。
 */
import fs from "node:fs";
import path from "node:path";
import type { VenueId, VenueSnapshot } from "./types.js";
import type { VenueExecutor } from "./venues/types.js";
import { loadEnv } from "./loadEnv.js";

export type StopPhase = "idle" | "ladder" | "hard" | "cooldown" | "locked";

export type StopLossView = {
  enabled: boolean;
  hardUp: number;
  hardDn: number;
  nativeArmed: boolean;
  phase: StopPhase;
  ladderLevel: number;
  cooldownUntil?: string;
  lastEvent?: string;
  /** 阶梯后锁开仓侧：long=只留买，short=只留卖 */
  openLock?: "long" | "short";
};

type Persisted = {
  venue: VenueId;
  ladderLevel: number;
  lastLadderAt: number;
  hardTriggeredAt: number;
  reanchorAfter: number;
  useLiveEquity: boolean;
  hardLocked?: boolean;
  lastEvent?: string;
  nativeArmed: boolean;
  hardUp: number;
  hardDn: number;
  /** 阶梯后只减不加：long=只留买，short=只留卖。不清，除非硬止或人手恢复 */
  openLock?: "long" | "short";
};

const FILE = () => path.resolve(process.cwd(), "data", "stop-loss.json");

const states = new Map<VenueId, Persisted>();

export function stopLossConfig() {
  loadEnv();
  return {
    ladderStartPct: (() => {
      const raw = Number(process.env.STOP_LADDER_START);
      return Number.isFinite(raw) ? Math.max(0, raw) : 0.01;
    })(),
    ladderStepPct: Math.max(0.005, Number(process.env.STOP_LADDER_STEP || 0.02) || 0.02),
    ladderFrac: Math.min(0.5, Math.max(0.05, Number(process.env.STOP_LADDER_FRAC || 0.15) || 0.15)),
    ladderCooldownMs: Math.max(60_000, Number(process.env.STOP_LADDER_COOLDOWN_MS || 1_800_000) || 1_800_000),
    hardPct: Math.max(0.005, Number(process.env.STOP_HARD_PCT || 0.025) || 0.025),
    reanchorMs: Math.max(60_000, Number(process.env.STOP_REANCHOR_MS || 10_800_000) || 10_800_000),
  };
}

export function stopLossEnabled(venue: VenueId): boolean {
  loadEnv();
  const on = ["1", "true", "yes", "YES"].includes(String(process.env.STOP_LOSS || "").trim());
  if (!on) return false;
  const raw = String(process.env.STOP_LOSS_VENUES || "").trim();
  if (!raw) return true;
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .includes(venue);
}

function inferLegacyOpenLock(s: Persisted): "long" | "short" | undefined {
  if (s.openLock === "long" || s.openLock === "short") return s.openLock;
  const m = String(s.lastEvent || "").match(/^L\d+\s+@(\d+)/);
  if (!m || !(s.lastLadderAt > 0)) return undefined;
  const px = Number(m[1]);
  if (!(px > 0) || !(s.hardUp > 0) || !(s.hardDn > 0)) return undefined;
  return Math.abs(px - s.hardUp) <= Math.abs(px - s.hardDn) ? "long" : "short";
}

export function loadStopLossState(): void {
  try {
    if (!fs.existsSync(FILE())) return;
    const j = JSON.parse(fs.readFileSync(FILE(), "utf8"));
    let dirty = false;
    for (const row of j.venues || []) {
      if (!row?.venue) continue;
      const inferred = inferLegacyOpenLock(row);
      if (inferred && row.openLock !== inferred) {
        row.openLock = inferred;
        dirty = true;
      }
      states.set(row.venue, row);
    }
    if (dirty) persist();
  } catch {
    /* ignore */
  }
}

function persist(): void {
  try {
    const dir = path.dirname(FILE());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      FILE(),
      JSON.stringify({ venues: [...states.values()], updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch {
    /* ignore */
  }
}

function getOrInit(venue: VenueId): Persisted {
  let s = states.get(venue);
  if (!s) {
    s = {
      venue,
      ladderLevel: -1,
      lastLadderAt: 0,
      hardTriggeredAt: 0,
      reanchorAfter: 0,
      useLiveEquity: false,
      nativeArmed: false,
      hardUp: 0,
      hardDn: 0,
    };
    states.set(venue, s);
  }
  return s;
}

export function shouldUseLiveEquity(venue: VenueId): boolean {
  return getOrInit(venue).useLiveEquity;
}

export function isReanchorCooldown(venue: VenueId): boolean {
  return Date.now() < getOrInit(venue).reanchorAfter;
}

export function isHardStopLocked(venue: VenueId): boolean {
  return getOrInit(venue).hardLocked === true;
}

/** 仅供收到用户明确通知后的人工恢复流程调用。 */
export function clearHardStopLock(venue: VenueId): void {
  const s = getOrInit(venue);
  s.hardLocked = false;
  s.hardTriggeredAt = 0;
  s.reanchorAfter = 0;
  s.useLiveEquity = false;
  s.lastEvent = "HARD lock manually cleared";
  persist();
}

export function ladderOpenLock(venue: VenueId): "neutral" | "long" | "short" {
  const lock = getOrInit(venue).openLock;
  return lock === "long" || lock === "short" ? lock : "neutral";
}

export function clearLadderOpenLock(venue: VenueId): void {
  const s = getOrInit(venue);
  if (!s.openLock) return;
  delete s.openLock;
  persist();
}

export function snapshotStop(venue: VenueId): StopLossView | undefined {
  if (!stopLossEnabled(venue)) return undefined;
  const s = getOrInit(venue);
  const now = Date.now();
  let phase: StopPhase = "idle";
  if (s.hardLocked) phase = "locked";
  else if (now < s.reanchorAfter) phase = "cooldown";
  else if (s.hardTriggeredAt && now - s.hardTriggeredAt < 60_000) phase = "hard";
  else if (s.ladderLevel >= 0) phase = "ladder";
  return {
    enabled: true,
    hardUp: s.hardUp,
    hardDn: s.hardDn,
    nativeArmed: s.nativeArmed,
    phase,
    ladderLevel: s.ladderLevel,
    cooldownUntil: s.reanchorAfter > now ? new Date(s.reanchorAfter).toISOString() : undefined,
    lastEvent: s.lastEvent,
    openLock: s.openLock === "long" || s.openLock === "short" ? s.openLock : undefined,
  };
}

export function edges(upper: number, lower: number) {
  const c = stopLossConfig();
  return {
    ladderUp: upper * (1 + c.ladderStartPct),
    hardUp: upper * (1 + c.hardPct),
    ladderDn: lower * (1 - c.ladderStartPct),
    hardDn: lower * (1 - c.hardPct),
  };
}

export type StopTickResult = {
  action: "none" | "ladder" | "hard" | "cooldown" | "locked";
  view: StopLossView;
};

export async function runStopLossTick(p: {
  ex: VenueExecutor;
  market: string;
  snap: VenueSnapshot;
  upper: number;
  lower: number;
}): Promise<StopTickResult> {
  const venue = p.ex.id;
  const s = getOrInit(venue);
  const cfg = stopLossConfig();
  const e = edges(p.upper, p.lower);
  s.hardUp = e.hardUp;
  s.hardDn = e.hardDn;

  if (s.hardLocked) {
    persist();
    return { action: "locked", view: snapshotStop(venue)! };
  }

  if (Date.now() < s.reanchorAfter) {
    persist();
    return { action: "cooldown", view: snapshotStop(venue)! };
  }

  const mid = p.snap.mid;
  const pos = Number(p.snap.position) || 0;

  if (typeof p.ex.syncHardStops === "function") {
    try {
      if (Math.abs(pos) < 1e-9) {
        if (s.nativeArmed) {
          try {
            await p.ex.cancelHardStops?.(p.market);
          } catch {
            /* ignore */
          }
        }
        s.nativeArmed = false;
      } else {
        const r = await p.ex.syncHardStops({ market: p.market, hardUp: e.hardUp, hardDn: e.hardDn });
        s.nativeArmed = !!r.armed;
        if (r.note && r.note !== "kept" && r.note !== "flat") s.lastEvent = `native:${r.note}`;
      }
    } catch (err: any) {
      s.nativeArmed = false;
      s.lastEvent = `native-fail:${String(err?.message || err).slice(0, 80)}`;
    }
  }

  const hitHardShort = pos < -1e-9 && mid >= e.hardUp;
  const hitHardLong = pos > 1e-9 && mid <= e.hardDn;
  if (hitHardShort || hitHardLong) {
    s.lastEvent = `HARD @${mid.toFixed(0)} pos=${pos.toFixed(4)}`;
    s.hardTriggeredAt = Date.now();
    s.reanchorAfter = 0;
    s.useLiveEquity = false;
    s.hardLocked = true;
    s.ladderLevel = -1;
    delete s.openLock;
    try {
      await p.ex.cancelAll(p.market);
    } catch {
      /* continue flatten */
    }
    try {
      await p.ex.closePosition(p.market);
    } catch (err: any) {
      s.lastEvent += ` close-fail:${String(err?.message || err).slice(0, 60)}`;
    }
    try {
      await p.ex.cancelHardStops?.(p.market);
    } catch {
      /* ignore */
    }
    persist();
    return { action: "hard", view: snapshotStop(venue)! };
  }

  const now = Date.now();
  if (pos < -1e-9 && mid >= e.ladderUp) {
    const beyond = (mid / e.ladderUp - 1) / cfg.ladderStepPct;
    const target = Math.max(0, Math.floor(beyond));
    if (target > s.ladderLevel && now - s.lastLadderAt >= cfg.ladderCooldownMs) {
      const cut = Math.abs(pos) * cfg.ladderFrac;
      s.lastEvent = `L${target + 1} @${mid.toFixed(0)} cut=${cut.toFixed(4)}`;
      s.ladderLevel = target;
      s.lastLadderAt = now;
      s.openLock = "long";
      try {
        await p.ex.closePosition(p.market, cut);
      } catch (err: any) {
        s.lastEvent += ` fail:${String(err?.message || err).slice(0, 60)}`;
      }
      persist();
      return { action: "ladder", view: snapshotStop(venue)! };
    }
  } else if (pos > 1e-9 && mid <= e.ladderDn) {
    const beyond = (e.ladderDn / mid - 1) / cfg.ladderStepPct;
    const target = Math.max(0, Math.floor(beyond));
    if (target > s.ladderLevel && now - s.lastLadderAt >= cfg.ladderCooldownMs) {
      const cut = Math.abs(pos) * cfg.ladderFrac;
      s.lastEvent = `L${target + 1} @${mid.toFixed(0)} cut=${cut.toFixed(4)}`;
      s.ladderLevel = target;
      s.lastLadderAt = now;
      s.openLock = "short";
      try {
        await p.ex.closePosition(p.market, cut);
      } catch (err: any) {
        s.lastEvent += ` fail:${String(err?.message || err).slice(0, 60)}`;
      }
      persist();
      return { action: "ladder", view: snapshotStop(venue)! };
    }
  } else if (mid < p.upper && mid > p.lower) {
    s.ladderLevel = -1;
  }

  persist();
  return { action: "none", view: snapshotStop(venue)! };
}
