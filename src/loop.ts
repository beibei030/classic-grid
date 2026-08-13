import {
  anchorGrid,
  assertLiveAllowed,
  gridFor,
  loadRuntimeConfig,
  type RuntimeConfig,
} from "./config.js";
import {
  setDashboardMeta,
  setDashboardOfficial,
  startDashboardServer,
  upsertDashboardVenue,
  getDashboardSnapshot,
} from "./dashboard.js";
import {
  assertFeeOk,
  assertMarginOk,
  buildGrid,
  computeRisk,
  evaluateRecenter,
  planFromFillsAndSeed,
  replacementFor,
  type BuiltGrid,
} from "./grid.js";
import { loadVenueSessionCounters } from "./ledger.js";
import { getOfficialCache, refreshOfficialStats } from "./officialStats.js";
import { createExecutor, type VenueExecutor } from "./venues/index.js";
import type { GridParams, Side, VenueId } from "./types.js";
import {
  classifyTrade,
  tgBoot,
  tgClose,
  tgDailyOverview,
  tgError,
  tgOpen,
} from "./telegram.js";
import { loadEnv } from "./loadEnv.js";
import fs from "node:fs";
import path from "node:path";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 软启：从 data/status.json 恢复锚点，避免重锚导致误撤现有挂单 */
function loadSoftResumeAnchors(): Partial<
  Record<VenueId, { anchorMid: number; gridCount: number }>
> {
  loadEnv();
  if (!["1", "true", "yes", "YES"].includes(String(process.env.SOFT_RESUME || "").trim())) {
    return {};
  }
  try {
    const p = path.resolve(process.cwd(), "data", "status.json");
    if (!fs.existsSync(p)) return {};
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    const out: Partial<Record<VenueId, { anchorMid: number; gridCount: number }>> = {};
    for (const v of j.venues || []) {
      const id = String(v.venue) as VenueId;
      const mid = Number(v.anchorMid);
      const gc = Number(v.gridCount);
      if (mid > 0 && gc > 0) out[id] = { anchorMid: mid, gridCount: gc };
    }
    console.log(
      `[soft-resume] loaded anchors: ${Object.entries(out)
        .map(([k, v]) => `${k}=${v!.anchorMid.toFixed(1)}`)
        .join(", ") || "(none)"}`
    );
    return out;
  } catch (e: any) {
    console.warn(`[soft-resume] load failed: ${String(e?.message || e).slice(0, 120)}`);
    return {};
  }
}

let softResumeAnchors: Partial<
  Record<VenueId, { anchorMid: number; gridCount: number }>
> = {};

type Tracked = { levelIndex: number; side: Side; price: number; size: number };

type VenueRuntime = {
  ex: VenueExecutor;
  seeded: boolean;
  active: Map<string, Tracked>;
  completedRungs: number;
  gridProfit: number;
  built: BuiltGrid | null;
  params: GridParams | null;
  anchorMid: number;
  lastError?: string;
  /** 本地 inventory：上一次仓位与成本名义 */
  lastPosition: number | null;
  invCost: number;
  unrealizedPnl: number;
  /** 仅记录本进程从交易所下单回执中确认过的订单 ID */
  ownedOrderIds: Set<string>;
  recenterPhase: "idle" | "cancelling" | "paused";
  recenterConfirmTicks: number;
  recenterStartedAt: number;
  lastRecenterAt: number;
  recenterCancelRequested: Set<string>;
  recenterNotice?: string;
};

/** 用 mid 变动维护本地均价，估浮盈亏（所方无 entry 时兜底） */
function syncInventory(rt: VenueRuntime, position: number, mid: number): number {
  if (!(mid > 0)) {
    rt.unrealizedPnl = 0;
    return 0;
  }
  if (rt.lastPosition == null) {
    rt.lastPosition = position;
    rt.invCost = position * mid;
    rt.unrealizedPnl = 0;
    return 0;
  }
  const prev = rt.lastPosition;
  const d = position - prev;
  if (Math.abs(d) > 1e-12) {
    if (prev === 0) {
      rt.invCost = position * mid;
    } else if (Math.sign(position) !== Math.sign(prev) && Math.abs(position) > 1e-12) {
      // 翻向：剩余新方向按现价建仓
      rt.invCost = position * mid;
    } else if (Math.abs(position) > Math.abs(prev) + 1e-12) {
      // 加仓
      rt.invCost += d * mid;
    } else {
      // 减仓：保留均价
      const avg = prev !== 0 ? rt.invCost / prev : mid;
      rt.invCost = position * avg;
    }
  }
  rt.lastPosition = position;
  rt.unrealizedPnl = position * mid - rt.invCost;
  if (Math.abs(position) < 1e-12) {
    rt.invCost = 0;
    rt.unrealizedPnl = 0;
  }
  return rt.unrealizedPnl;
}

function anchorRuntime(
  rt: VenueRuntime,
  cfg: RuntimeConfig,
  mid: number,
  allowResume: boolean
): void {
  const base = gridFor(cfg, rt.ex.id);
  const resume = allowResume ? softResumeAnchors[rt.ex.id] : undefined;
  const midForAnchor =
    resume && resume.anchorMid > 0 ? resume.anchorMid : mid;
  if (resume && resume.anchorMid > 0 && Math.abs(midForAnchor - mid) > 1) {
    console.log(
      `[${rt.ex.id}] soft-resume anchorMid=${midForAnchor.toFixed(2)} (live mid=${mid.toFixed(2)})`
    );
  }
  const anchored = anchorGrid(base, midForAnchor);
  const built = buildGrid({
    lower: anchored.lower,
    upper: anchored.upper,
    gridCount: anchored.gridCount,
  });
  const risk = computeRisk(built, anchored, midForAnchor);
  const fee = assertFeeOk(risk.spacingPct, anchored.feeRate);
  const margin = assertMarginOk(risk, anchored.equityUsd, anchored.marginFraction);
  const eachSide = anchored.gridCount / 2;
  console.log(
    `[${rt.ex.id}] anchor mid=${midForAnchor.toFixed(2)} → [${anchored.lower.toFixed(2)},${anchored.upper.toFixed(2)}] ≈上下各${eachSide} 共${anchored.gridCount} spacing=${built.spacing} size=${anchored.sizeBase} lev=${anchored.leverage}x`
  );
  console.log(
    `[${rt.ex.id}] risk notional≈${risk.notional}U margin≈${risk.requiredMargin}U perRung≈${risk.perRungProfit}U spacing=${risk.spacingPct}%`
  );
  console.log(`[${rt.ex.id}] fee: ${fee.message}`);
  console.log(`[${rt.ex.id}] margin: ${margin.message}`);
  if (!fee.ok) throw new Error(`[${rt.ex.id}] ${fee.message}`);
  if (!margin.ok) throw new Error(`[${rt.ex.id}] ${margin.message}`);

  rt.built = built;
  rt.params = anchored;
  rt.anchorMid = midForAnchor;
  // 软启：有旧锚点则视为已铺过，只补漏档、不整表重铺
  if (resume && resume.anchorMid > 0) {
    rt.seeded = true;
  }
}

async function ensureAnchored(
  rt: VenueRuntime,
  market: string,
  cfg: RuntimeConfig,
  midHint?: number
): Promise<{ mid: number; snap: Awaited<ReturnType<VenueExecutor["snapshot"]>> }> {
  const snap = await rt.ex.snapshot(market);
  const mid = midHint && midHint > 0 ? midHint : snap.mid;
  if (rt.built && rt.params) return { mid: snap.mid, snap };
  anchorRuntime(rt, cfg, mid, true);
  return { mid: snap.mid, snap };
}

type RecenterResult =
  | { suspended: false }
  | { suspended: true; message: string };

async function manageRecenter(
  rt: VenueRuntime,
  market: string,
  cfg: RuntimeConfig,
  snap: Awaited<ReturnType<VenueExecutor["snapshot"]>>
): Promise<RecenterResult> {
  if (!cfg.recenter.enabled || !rt.params || !rt.built) {
    return { suspended: false };
  }

  if (rt.recenterPhase === "paused") {
    return {
      suspended: true,
      message: rt.recenterNotice || "重心化已暂停，需要人工检查并重启",
    };
  }

  const unowned = snap.openOrders.filter((o) => !rt.ownedOrderIds.has(o.id));
  if (unowned.length > 0) {
    rt.recenterPhase = "paused";
    rt.recenterNotice =
      `重心化保护暂停：发现 ${unowned.length} 个无法确认归属的挂单，不会新增或撤销订单；请人工检查并重启`;
    console.error(`[${rt.ex.id}] ${rt.recenterNotice}`);
    void tgError(rt.ex.id, rt.recenterNotice);
    return { suspended: true, message: rt.recenterNotice };
  }

  if (rt.recenterPhase === "idle") {
    const check = evaluateRecenter({
      mid: snap.mid,
      anchorMid: rt.anchorMid,
      halfBand: rt.params.halfBand,
      spacing: rt.built.spacing,
      triggerRatio: cfg.recenter.triggerRatio,
      previousConfirmTicks: rt.recenterConfirmTicks,
      confirmTicks: cfg.recenter.confirmTicks,
      now: Date.now(),
      lastRecenterAt: rt.lastRecenterAt,
      cooldownMs: cfg.recenter.cooldownMs,
    });
    rt.recenterConfirmTicks = check.nextConfirmTicks;
    if (!check.ready) {
      rt.recenterNotice = undefined;
      return { suspended: false };
    }

    const positionNotional = Math.abs(snap.position * snap.mid);
    if (positionNotional > cfg.recenter.maxPositionNotionalUsd) {
      const message =
        `重心化等待：持仓名义 ${positionNotional.toFixed(2)}U > ` +
        `上限 ${cfg.recenter.maxPositionNotionalUsd.toFixed(2)}U；已停止新增写操作`;
      if (rt.recenterNotice !== message) {
        console.warn(`[${rt.ex.id}] ${message}`);
        void tgError(rt.ex.id, message);
      }
      rt.recenterNotice = message;
      return { suspended: true, message };
    }

    rt.recenterPhase = "cancelling";
    rt.recenterStartedAt = Date.now();
    rt.recenterNotice =
      `重心化撤单中：偏离 ${check.distance.spacingUnits.toFixed(1)} 格 ` +
      `(${(check.distance.halfBandRatio * 100).toFixed(1)}% 半带宽)`;
    console.warn(
      `[${rt.ex.id}] recenter start mid=${snap.mid.toFixed(2)} anchor=${rt.anchorMid.toFixed(2)} ` +
        `distance=${check.distance.spacingUnits.toFixed(1)} grids owned=${rt.ownedOrderIds.size}`
    );
  }

  const positionNotional = Math.abs(snap.position * snap.mid);
  if (positionNotional > cfg.recenter.maxPositionNotionalUsd) {
    rt.recenterPhase = "paused";
    rt.recenterNotice =
      `重心化撤单期间出现持仓 ${positionNotional.toFixed(2)}U，已暂停重铺，请人工检查`;
    console.error(`[${rt.ex.id}] ${rt.recenterNotice}`);
    void tgError(rt.ex.id, rt.recenterNotice);
    return { suspended: true, message: rt.recenterNotice };
  }

  if (Date.now() - rt.recenterStartedAt > cfg.recenter.cancelTimeoutMs) {
    rt.recenterPhase = "paused";
    rt.recenterNotice = `重心化撤单超过 ${cfg.recenter.cancelTimeoutMs}ms，已暂停重铺，请人工检查`;
    console.error(`[${rt.ex.id}] ${rt.recenterNotice}`);
    void tgError(rt.ex.id, rt.recenterNotice);
    return { suspended: true, message: rt.recenterNotice };
  }

  const remaining = snap.openOrders.filter((o) => rt.ownedOrderIds.has(o.id));
  const notRequested = remaining.filter((o) => !rt.recenterCancelRequested.has(o.id));
  if (notRequested.length > 0) {
    const intents = notRequested.slice(0, rt.params.maxWritesPerTick).map((o) => ({
      type: "cancel" as const,
      orderId: o.id,
      market,
    }));
    const result = await rt.ex.apply(intents);
    if (!result.failed && !result.errors.length) {
      for (const intent of intents) rt.recenterCancelRequested.add(intent.orderId);
    }
    const message =
      result.failed || result.errors.length
        ? `重心化撤单失败 ${result.failed}：${result.errors.slice(0, 2).join("; ")}`
        : `重心化撤单中：剩余 ${remaining.length}，本轮请求 ${intents.length}`;
    rt.recenterNotice = message;
    return { suspended: true, message };
  }
  if (remaining.length > 0) {
    const message = `重心化等待交易所确认撤单：剩余 ${remaining.length}`;
    rt.recenterNotice = message;
    return { suspended: true, message };
  }

  rt.built = null;
  rt.params = null;
  rt.anchorMid = 0;
  rt.active.clear();
  rt.ownedOrderIds.clear();
  rt.recenterCancelRequested.clear();
  rt.seeded = false;
  delete softResumeAnchors[rt.ex.id];
  anchorRuntime(rt, cfg, snap.mid, false);
  rt.recenterPhase = "idle";
  rt.recenterConfirmTicks = 0;
  rt.lastRecenterAt = Date.now();
  rt.recenterNotice = undefined;
  console.warn(`[${rt.ex.id}] recenter complete newAnchor=${rt.anchorMid.toFixed(2)}`);
  return { suspended: false };
}

async function tickOne(
  rt: VenueRuntime,
  market: string,
  cfg: RuntimeConfig
): Promise<void> {
  const { mid, snap } = await ensureAnchored(rt, market, cfg);
  const g = rt.params!;
  const built = rt.built!;
  const posBefore = rt.lastPosition ?? snap.position;
  // 仅维护仓位变化跟踪（开平仓 TG）；浮盈亏看板一律用所方官方字段
  syncInventory(rt, snap.position, snap.mid);
  const upnlOfficial =
    snap.unrealizedPnl != null && Number.isFinite(Number(snap.unrealizedPnl))
      ? Number(snap.unrealizedPnl)
      : null;
  rt.unrealizedPnl = upnlOfficial ?? 0;
  for (const id of [...rt.ownedOrderIds]) {
    if (!snap.openOrders.some((o) => o.id === id)) rt.ownedOrderIds.delete(id);
  }
  const recenter = await manageRecenter(rt, market, cfg, snap);
  const currentGrid = rt.built!;
  const currentParams = rt.params!;
  const plan = recenter.suspended
    ? {
        intents: [],
        nextActive: rt.active,
        filled: [],
        completedRungs: 0,
      }
    : planFromFillsAndSeed({
        market,
        mid,
        levels: currentGrid.levels,
        spacing: currentGrid.spacing,
        mode: currentParams.mode,
        sizeBase: currentParams.sizeBase,
        openOrders: snap.openOrders,
        prevActive: rt.active,
        maxWrites: currentParams.maxWritesPerTick,
        seeded: rt.seeded,
        cancellableOrderIds: cfg.recenter.enabled ? rt.ownedOrderIds : undefined,
        maxOpenOrders: currentParams.maxOpenOrders,
      });

  if (plan.completedRungs > 0) {
    const perRung = currentGrid.spacing * currentParams.sizeBase;
    let simPos = posBefore;
    for (const f of plan.filled) {
      const repl = replacementFor(f, currentGrid.levels, currentParams.mode);
      if (!repl) continue;
      const { kind, posAfter } = classifyTrade(simPos, f.side, currentParams.sizeBase);
      simPos = posAfter;
      if (kind === "开多" || kind === "开空") {
        void tgOpen({
          venue: rt.ex.id,
          kind,
          posAfter,
          mid: snap.mid,
          openOrders: snap.openOrders,
        });
      } else {
        rt.completedRungs += 1;
        rt.gridProfit += perRung;
        void tgClose({
          venue: rt.ex.id,
          kind,
          posAfter,
          mid: snap.mid,
          openOrders: snap.openOrders,
          pnlUsd: perRung,
        });
      }
    }
  }

  console.log(
    `[${rt.ex.id}] mid=${snap.mid.toFixed(2)} pos=${snap.position} oo=${snap.openOrders.length} count=${currentParams.gridCount} spacing=${currentGrid.spacing} size=${currentParams.sizeBase} fills=${plan.filled.length} intents=${plan.intents.length} recenter=${rt.recenterPhase} rungs=${rt.completedRungs} profit≈${rt.gridProfit.toFixed(4)} upnl≈${upnlOfficial != null ? upnlOfficial.toFixed(4) : "n/a"}`
  );

  let applyErr: string | undefined;
  const nextActive = new Map(plan.nextActive);
  if (plan.intents.length) {
    const result = await rt.ex.apply(plan.intents);
    for (const placed of result.placedOrders) {
      rt.ownedOrderIds.add(placed.id);
      nextActive.set(placed.id, {
        levelIndex: placed.order.level,
        side: placed.order.side,
        price: placed.order.price,
        size: placed.order.size,
      });
    }
    if (result.failed || result.errors.length) {
      console.log(
        `[${rt.ex.id}] apply placed=${result.placed} cancelled=${result.cancelled} failed=${result.failed} ${result.errors.join("; ")}`
      );
      applyErr = result.errors.slice(0, 2).join("; ") || `failed=${result.failed}`;
      void tgError(rt.ex.id, applyErr);
    }
  }

  rt.active = nextActive;
  rt.seeded = rt.seeded || !recenter.suspended;
  rt.lastError = applyErr || (recenter.suspended ? recenter.message : undefined);

  const off = getOfficialCache()?.venues?.[rt.ex.id];
  upsertDashboardVenue({
    venue: rt.ex.id,
    market,
    mid: snap.mid,
    anchorMid: rt.anchorMid,
    lower: currentParams.lower,
    upper: currentParams.upper,
    spacing: currentGrid.spacing,
    sizeBase: currentParams.sizeBase,
    gridCount: currentParams.gridCount,
    position: snap.position,
    openOrders: snap.openOrders.length,
    seeded: rt.seeded,
    completedRungs: rt.completedRungs,
    gridProfit: Number(rt.gridProfit.toFixed(4)),
    unrealizedPnl:
      upnlOfficial != null ? Number(upnlOfficial.toFixed(4)) : undefined,
    equityUsd:
      snap.equityUsd != null && Number.isFinite(snap.equityUsd)
        ? Number(snap.equityUsd.toFixed(4))
        : undefined,
    orders: snap.openOrders.slice(0, 120).map((o) => ({
      side: o.side,
      price: Number(o.price),
    })),
    officialVolume: off?.source === "official" ? off.volume : null,
    officialFees: off?.source === "official" ? off.fees : null,
    officialRealizedPnl: off?.source === "official" ? off.realizedPnl : null,
    officialSource: off?.source === "official" ? "official" : "local",
    lastError: rt.lastError,
    updatedAt: new Date().toISOString(),
  });
}

export async function runLoop(opts?: { once?: boolean }): Promise<void> {
  const cfg = loadRuntimeConfig();
  assertLiveAllowed(cfg);
  softResumeAnchors = loadSoftResumeAnchors();

  console.log(
    `classic-grid start dryRun=${cfg.dryRun} venues=${cfg.venues.join(",")} markets=${cfg.markets.join(",")} tickMs=${cfg.tickMs}`
  );
  const gridSummary = cfg.venues
    .map((id) => {
      const g = cfg.grids[id];
      return `${id}=${g.gridCount}g/${g.leverage}x`;
    })
    .join(" ");
  void tgBoot(
    `dryRun=${cfg.dryRun}\nvenues=${cfg.venues.join(",")}\nmarkets=${cfg.markets.join(",")}\n` +
      `tickMs=${cfg.tickMs}\nmarginFrac=${cfg.grids[cfg.venues[0]]?.marginFraction ?? ""}\n` +
      gridSummary
  );

  setDashboardMeta({ dryRun: cfg.dryRun });
  const dash = startDashboardServer(cfg.dashboardPort, cfg.dashboardHost);

  // 后台拉官方日统计（不阻塞启动）
  void refreshOfficialStats({ force: true })
    .then((b) => setDashboardOfficial(b))
    .catch((e) => console.error(`[official] refresh failed: ${String(e?.message || e).slice(0, 160)}`));

  let lastHourlyKey = "";
  let lastOfficialDashAt = 0;
  const maybeHourlyTg = async () => {
    const now = new Date();
    const key = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
    if (key === lastHourlyKey) return;
    // 整点后 2 分钟内触发，避免刚启动连发
    if (now.getMinutes() > 5 && lastHourlyKey !== "") return;
    if (now.getMinutes() > 5 && lastHourlyKey === "") {
      // 启动不在整点：跳过，等下一整点
      lastHourlyKey = key;
      return;
    }
    try {
      const bundle = await refreshOfficialStats({ force: true, minIntervalMs: 0 });
      setDashboardOfficial(bundle);
      const snap = getDashboardSnapshot();
      const venues = snap.venues || [];
      const equitySum = venues.reduce((s, v) => s + (Number(v.equityUsd) || 0), 0);
      const oo = venues.reduce((s, v) => s + (Number(v.openOrders) || 0), 0);
      const expectOo = venues.reduce((s, v) => {
        const gc = Number(v.gridCount) || 0;
        return s + (gc > 0 ? gc : 0);
      }, 0);
      const healthy = venues.filter((v) => !v.lastError && v.seeded).length;
      let vol = 0;
      let fees = 0;
      let vn = 0;
      let fn = 0;
      for (const id of Object.keys(bundle.venues || {}) as VenueId[]) {
        const o = bundle.venues?.[id];
        if (!o || o.source !== "official") continue;
        if (o.volume != null && Number.isFinite(o.volume)) {
          vol += o.volume;
          vn++;
        }
        if (o.fees != null && Number.isFinite(o.fees)) {
          fees += o.fees;
          fn++;
        }
      }
      const cal = snap.ledger?.calendar || [];
      const todayRow =
        cal.find((r) => r.day === snap.ledger?.dayKey) || cal[0];
      const dayProfit =
        todayRow != null && Number.isFinite(Number(todayRow.dayProfit))
          ? Number(todayRow.dayProfit)
          : null;
      lastHourlyKey = key;
      await tgDailyOverview({
        dayKey: snap.ledger?.dayKey || bundle.dayKey || key,
        dayProfit,
        equity: equitySum > 0 ? equitySum : null,
        volume: vn > 0 ? vol : null,
        fees: fn > 0 ? fees : null,
        openOrders: oo,
        expectOrders: expectOo,
        healthy,
        totalVenues: venues.length || 5,
      });
    } catch (e: any) {
      console.error(`[tg-hourly] ${String(e?.message || e).slice(0, 160)}`);
    }
  };

  const saved = loadVenueSessionCounters();
  const runtimes: VenueRuntime[] = [];
  for (const venue of cfg.venues) {
    const prev = saved[venue];
    if (prev && (prev.completedRungs > 0 || prev.gridProfit > 0)) {
      console.log(
        `[${venue}] restore ledger rungs=${prev.completedRungs} profit≈${prev.gridProfit.toFixed(4)}`
      );
    }
    runtimes.push({
      ex: createExecutor(venue, cfg.dryRun),
      seeded: false,
      active: new Map(),
      completedRungs: prev?.completedRungs || 0,
      gridProfit: prev?.gridProfit || 0,
      built: null,
      params: null,
      anchorMid: 0,
      lastPosition: null,
      invCost: 0,
      unrealizedPnl: 0,
      ownedOrderIds: new Set(),
      recenterPhase: "idle",
      recenterConfirmTicks: 0,
      recenterStartedAt: 0,
      lastRecenterAt: 0,
      recenterCancelRequested: new Set(),
    });
  }

  for (const rt of runtimes) {
    try {
      await rt.ex.connect();
      console.log(`[${rt.ex.id}] connected`);
    } catch (e: any) {
      const msg = String(e?.message || e).slice(0, 200);
      console.error(`[${rt.ex.id}] connect failed: ${msg}`);
      rt.lastError = msg;
      void tgError(rt.ex.id, `connect failed: ${msg}`);
      upsertDashboardVenue({
        venue: rt.ex.id,
        market: cfg.markets[0] || "BTC",
        mid: 0,
        anchorMid: 0,
        lower: 0,
        upper: 0,
        spacing: 0,
        sizeBase: 0,
        gridCount: gridFor(cfg, rt.ex.id).gridCount,
        position: 0,
        openOrders: 0,
        seeded: false,
        completedRungs: 0,
        gridProfit: 0,
        unrealizedPnl: 0,
        lastError: msg,
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const stop = async () => {
    if (dash) {
      try {
        dash.close();
      } catch {
        /* ignore */
      }
    }
    for (const rt of runtimes) {
      try {
        rt.ex.disconnect();
      } catch {
        /* ignore */
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void stop());
  process.on("SIGTERM", () => void stop());

  do {
    for (const market of cfg.markets) {
      for (const rt of runtimes) {
        try {
          // 首连失败（如 Ext 429）时每轮重试，避免整场卡死
          if (!rt.seeded && rt.lastError && !rt.recenterNotice) {
            try {
              rt.ex.disconnect();
            } catch {
              /* ignore */
            }
            await rt.ex.connect();
            console.log(`[${rt.ex.id}] reconnected`);
            rt.lastError = undefined;
          }
          await tickOne(rt, market, cfg);
        } catch (e: any) {
          const msg = String(e?.message || e).slice(0, 200);
          console.error(`[${rt.ex.id}] tick failed: ${msg}`);
          rt.lastError = msg;
          void tgError(rt.ex.id, `tick failed: ${msg}`);
          upsertDashboardVenue({
            venue: rt.ex.id,
            market,
            mid: 0,
            anchorMid: rt.anchorMid,
            lower: rt.params?.lower || 0,
            upper: rt.params?.upper || 0,
            spacing: rt.built?.spacing || 0,
            sizeBase: rt.params?.sizeBase || 0,
            gridCount: gridFor(cfg, rt.ex.id).gridCount,
            position: 0,
            openOrders: 0,
            seeded: rt.seeded,
            completedRungs: rt.completedRungs,
            gridProfit: Number(rt.gridProfit.toFixed(4)),
            unrealizedPnl: Number(rt.unrealizedPnl.toFixed(4)),
            lastError: msg,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
    void maybeHourlyTg();
    // 看板官方统计：约 5 分钟一轮（过勤会堆内存，且 Extended 易与下单抢 429）
    if (Date.now() - lastOfficialDashAt > 300_000) {
      lastOfficialDashAt = Date.now();
      void refreshOfficialStats({ force: true, minIntervalMs: 240_000 })
        .then((b) => setDashboardOfficial(b))
        .catch(() => {});
    }
    if (opts?.once) break;
    await sleep(cfg.tickMs);
  } while (true);

  await stop();
}

export async function runStatus(): Promise<void> {
  const cfg = loadRuntimeConfig();
  const dry = cfg.dryRun;
  if (dry) {
    console.log("status: DRY_RUN=1 → 假 snapshot（设 DRY_RUN=0 可读实盘，仍不下单）");
  }
  for (const venue of cfg.venues) {
    const ex = createExecutor(venue, dry);
    try {
      await ex.connect();
      for (const market of cfg.markets) {
        const snap = await ex.snapshot(market);
        const anchored = snap.mid > 0 ? anchorGrid(gridFor(cfg, venue), snap.mid) : gridFor(cfg, venue);
        console.log(
          JSON.stringify(
            {
              venue: snap.venue,
              market: snap.market,
              mid: snap.mid,
              position: snap.position,
              openOrders: snap.openOrders.length,
              grid: anchored,
              sample: snap.openOrders.slice(0, 3),
            },
            null,
            2
          )
        );
      }
    } catch (e: any) {
      console.error(`[${venue}] ${String(e?.message || e).slice(0, 300)}`);
    } finally {
      ex.disconnect();
    }
  }
}

export async function runFlat(): Promise<void> {
  const cfg = loadRuntimeConfig();
  assertLiveAllowed(cfg);
  if (cfg.dryRun) {
    console.log("flat: DRY_RUN=1 → 只打印，不撤单/清仓");
  }
  for (const venue of cfg.venues) {
    const ex = createExecutor(venue, cfg.dryRun);
    try {
      await ex.connect();
      for (const market of cfg.markets) {
        try {
          await ex.cancelAll(market);
          console.log(`[${venue}] cancelAll ${market} done`);
        } catch (e: any) {
          console.error(
            `[${venue}] cancelAll failed: ${String(e?.message || e).slice(0, 300)}`
          );
        }
        try {
          await ex.closePosition(market);
          console.log(`[${venue}] closePosition ${market} done`);
        } catch (e: any) {
          console.error(
            `[${venue}] closePosition failed: ${String(e?.message || e).slice(0, 300)}`
          );
        }
        try {
          const snap = await ex.snapshot(market);
          console.log(
            `[${venue}] after flat pos=${snap.position} oo=${snap.openOrders.length}`
          );
        } catch {
          /* ignore */
        }
      }
    } catch (e: any) {
      console.error(`[${venue}] flat failed: ${String(e?.message || e).slice(0, 300)}`);
    } finally {
      ex.disconnect();
    }
  }
}
