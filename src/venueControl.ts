import fs from "node:fs";
import path from "node:path";
import type { VenueId } from "./types.js";

/**
 * 每所独立控制（venoe-control）：
 * - holdSide: "neutral" | "long" | "short" —— 单边锁（只留买单 / 只留卖单），覆盖网格 mode
 * - paused: 单所暂停（不下单/不撤单/不补单，仅读看板）
 * - pending: 一次性命令队列，由主循环 tick 顺序执行（避免并发下单）
 *
 * 与全局 bot-paused 独立：全局暂停优先，本模块只负责单所粒度。
 */

export type HoldSide = "neutral" | "long" | "short";

export type VenueControlAction =
  | "cancel-sells" // 撤上方卖单 + holdSide=long
  | "cancel-buys" // 撤下方买单 + holdSide=short
  | "close-half" // 平 50% 仓位
  | "pause" // 单所暂停
  | "resume" // 恢复（holdSide 回 neutral + 解除暂停）
  | "flat-reseed" // 清仓撤单 + 重锚重铺
  | "refill"; // 按现带宽把缺档补满，不挪带、不撤现有单

export type VenueControlState = {
  holdSide: HoldSide;
  paused: boolean;
  updatedAt: string;
};

export type PendingCommand = {
  id: string;
  venue: VenueId;
  action: VenueControlAction;
  at: string;
  done?: boolean;
  error?: string;
};

type ControlFile = {
  venues: Partial<Record<VenueId, VenueControlState>>;
  pending: PendingCommand[];
};

const CONTROL_FILE = () => path.resolve(process.cwd(), "data", "venue-control.json");

let state: ControlFile = { venues: {}, pending: [] };

function persist(): void {
  try {
    const dir = path.resolve(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CONTROL_FILE(), JSON.stringify(state, null, 2), "utf8");
  } catch {
    /* ignore */
  }
}

export function loadVenueControl(): void {
  try {
    const p = CONTROL_FILE();
    if (!fs.existsSync(p)) return;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    state = {
      venues: (j?.venues as ControlFile["venues"]) || {},
      pending: Array.isArray(j?.pending) ? j.pending : [],
    };
  } catch {
    state = { venues: {}, pending: [] };
  }
}

export function getVenueControl(venue: VenueId): VenueControlState {
  return (
    state.venues[venue] || { holdSide: "neutral", paused: false, updatedAt: "" }
  );
}

/** 直接改状态（pause/resume/单边锁），持久化 */
export function setVenueControl(
  venue: VenueId,
  patch: Partial<VenueControlState>
): VenueControlState {
  const prev = getVenueControl(venue);
  const next: VenueControlState = {
    holdSide: patch.holdSide ?? prev.holdSide,
    paused: patch.paused ?? prev.paused,
    updatedAt: new Date().toISOString(),
  };
  state.venues[venue] = next;
  persist();
  return next;
}

export function venueHoldSide(venue: VenueId): HoldSide {
  return getVenueControl(venue).holdSide;
}

export function isVenuePaused(venue: VenueId): boolean {
  return getVenueControl(venue).paused;
}

/** 入队一个命令；返回命令 id */
export function enqueueVenueCommand(
  venue: VenueId,
  action: VenueControlAction
): PendingCommand {
  const cmd: PendingCommand = {
    id: `${venue}:${action}:${Date.now()}`,
    venue,
    action,
    at: new Date().toISOString(),
  };
  state.pending.push(cmd);
  // 同所最多保留最近 20 条历史，避免无限增长
  const byVenue = state.pending.filter((c) => c.venue === venue);
  if (byVenue.length > 20) {
    const done = byVenue.filter((c) => c.done).slice(0, byVenue.length - 20);
    for (const d of done) d.done = true;
  }
  persist();
  return cmd;
}

/** 取出某所待执行命令（FIFO） */
export function takePendingCommands(venue: VenueId): PendingCommand[] {
  const out: PendingCommand[] = [];
  const rest: PendingCommand[] = [];
  for (const c of state.pending) {
    if (c.venue === venue && !c.done) out.push(c);
    else rest.push(c);
  }
  state.pending = rest;
  persist();
  return out;
}

export function markCommandDone(cmd: PendingCommand, error?: string): void {
  const found = state.pending.find((c) => c.id === cmd.id);
  if (!found) {
    // 已被 take 走；只记录日志即可
    return;
  }
  found.done = true;
  found.error = error;
  persist();
}

export function allVenueControl(): ControlFile["venues"] {
  return state.venues;
}

export function getPendingCommands(): PendingCommand[] {
  return state.pending;
}
