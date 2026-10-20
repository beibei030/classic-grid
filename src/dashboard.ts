import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  ingestVenuesForLedger,
  ledgerPublicView,
  loadLedger,
  applyCapitalFlow,
  recordOfficialDayVolume,
  patchOfficialVolumeForDay,
  trimLedgerCalendar,
} from "./ledger.js";
import type { OfficialBundle } from "./officialStats.js";
import type { StopLossView } from "./stopLoss.js";
import type { VenueId } from "./types.js";
import {
  getBotPauseState,
  loadBotPauseState,
  setBotPaused,
  type BotPauseState,
} from "./botControl.js";
import {
  allVenueControl,
  enqueueVenueCommand,
  getPendingCommands,
  loadVenueControl,
  type VenueControlAction,
} from "./venueControl.js";

export type DashboardVenueRow = {
  venue: string;
  market: string;
  mid: number;
  anchorMid: number;
  lower: number;
  upper: number;
  spacing: number;
  sizeBase: number;
  gridCount: number;
  position: number;
  openOrders: number;
  seeded: boolean;
  completedRungs: number;
  gridProfit: number;
  unrealizedPnl?: number;
  /** 官方爆仓价 */
  liquidationPrice?: number;
  equityUsd?: number;
  orders?: Array<{ side: string; price: number }>;
  /** 官方今日量/费/平仓盈亏；无则 null，前端回退本地 */
  officialVolume?: number | null;
  officialFees?: number | null;
  officialRealizedPnl?: number | null;
  officialSource?: "official" | "unavailable" | "local";
  lastError?: string;
  stopLoss?: StopLossView;
  updatedAt: string;
};

export type DashboardSnapshot = {
  startedAt: string;
  updatedAt: string;
  dryRun: boolean;
  /** 紧急暂停：不下单/不撤单/不补单，仅刷新看板只读 */
  paused: boolean;
  pausedAt?: string;
  venues: DashboardVenueRow[];
  ledger?: ReturnType<typeof ledgerPublicView>;
  official?: OfficialBundle | null;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

loadBotPauseState();
loadVenueControl();

let snapshot: DashboardSnapshot = {
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  dryRun: true,
  paused: getBotPauseState().paused,
  pausedAt: getBotPauseState().paused ? getBotPauseState().updatedAt : undefined,
  venues: [],
  ledger: ledgerPublicView(loadLedger()),
};

function syncPauseIntoSnapshot(): void {
  const p = getBotPauseState();
  snapshot = {
    ...snapshot,
    paused: p.paused,
    pausedAt: p.paused ? p.updatedAt : undefined,
    updatedAt: new Date().toISOString(),
  };
}

export function getDashboardSnapshot(): DashboardSnapshot {
  return snapshot;
}

export function setDashboardMeta(p: { dryRun: boolean }): void {
  syncPauseIntoSnapshot();
  snapshot = {
    ...snapshot,
    dryRun: p.dryRun,
    updatedAt: new Date().toISOString(),
    ledger: ledgerPublicView(loadLedger()),
  };
}

export function applyBotPause(paused: boolean, reason?: string): BotPauseState {
  const next = setBotPaused(paused, reason);
  syncPauseIntoSnapshot();
  persistStatus();
  return next;
}

export function setDashboardOfficial(official: OfficialBundle | null): void {
  let ledger = snapshot.ledger || ledgerPublicView(loadLedger());
  if (official?.venues) {
    let sum = 0;
    let n = 0;
    for (const o of Object.values(official.venues)) {
      if (!o || o.source !== "official") continue;
      if (o.volume != null && Number.isFinite(Number(o.volume))) {
        sum += Number(o.volume);
        n += 1;
      }
    }
    if (n > 0) {
      try {
        ledger = ledgerPublicView(recordOfficialDayVolume(sum));
      } catch {
        /* ignore */
      }
    }
  }
  snapshot = {
    ...snapshot,
    official,
    ledger,
    updatedAt: new Date().toISOString(),
  };
  persistStatus();
}

function persistStatus(): void {
  try {
    const dataDir = path.resolve(process.cwd(), "data");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(
      path.join(dataDir, "status.json"),
      JSON.stringify(snapshot, null, 2),
      "utf8"
    );
  } catch {
    /* ignore */
  }
}

export function upsertDashboardVenue(row: DashboardVenueRow): void {
  const next = snapshot.venues.filter((v) => v.venue !== row.venue);
  next.push(row);
  next.sort((a, b) => a.venue.localeCompare(b.venue));
  let ledger;
  try {
    ledger = ledgerPublicView(ingestVenuesForLedger(next));
  } catch {
    ledger = ledgerPublicView(loadLedger());
  }
  snapshot = {
    ...snapshot,
    venues: next,
    updatedAt: new Date().toISOString(),
    ledger,
  };
  persistStatus();
}

export function startDashboardServer(port: number): http.Server | null {
  if (!(port > 0)) return null;
  const server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] || "/";
    if (url === "/api/snapshot" || url === "/api/status" || url === "/api/overview") {
      syncPauseIntoSnapshot();
      const body = {
        ...snapshot,
        ledger: ledgerPublicView(loadLedger()),
        venueControl: {
          venues: allVenueControl(),
          pending: getPendingCommands(),
        },
      };
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
      return;
    }
    if (url === "/api/meta") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ authRequired: false, port }));
      return;
    }
    if (
      (url === "/api/pause" || url === "/api/resume" || url === "/api/bot-pause") &&
      req.method === "POST"
    ) {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        let reason: string | undefined;
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (raw) {
            const j = JSON.parse(raw);
            if (j?.reason) reason = String(j.reason);
            if (url === "/api/bot-pause" && typeof j?.paused === "boolean") {
              const st = applyBotPause(j.paused, reason || "dashboard");
              res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store",
              });
              res.end(JSON.stringify({ ok: true, ...st }));
              return;
            }
          }
        } catch {
          /* ignore body */
        }
        const wantPause = url === "/api/pause";
        const st = applyBotPause(wantPause, reason || "dashboard");
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end(JSON.stringify({ ok: true, ...st }));
      });
      return;
    }
    if (url === "/api/rehang" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8") || "{}";
          const j = JSON.parse(raw);
          const venue = String(j?.venue || "").trim().toLowerCase();
          const allowed = new Set(["decibel", "n1", "popdex", "risex"]);
          if (!allowed.has(venue)) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "venue must be decibel|n1|popdex|risex" }));
            return;
          }
          const bat = path.resolve(process.cwd(), "deploy", "run-hg.bat");
          if (!fs.existsSync(bat)) {
            res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, error: "run-hg.bat missing" }));
            return;
          }
          const child = spawn("cmd.exe", ["/c", bat, venue], {
            cwd: path.resolve(process.cwd()),
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });
          child.unref();
          console.log(`[dashboard] rehang queued venue=${venue}`);
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({ ok: true, venue, started: true }));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(e?.message || e).slice(0, 200) }));
        }
      });
      return;
    }
    if (url === "/api/venue-control" && req.method === "GET") {
      const body = {
        venues: allVenueControl(),
        pending: getPendingCommands(),
      };
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(body));
      return;
    }
    if (url === "/api/venue-control" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8") || "{}";
          const j = JSON.parse(raw);
          const venue = String(j?.venue || "").trim();
          const action = String(j?.action || "").trim() as VenueControlAction;
          const actions: VenueControlAction[] = [
            "cancel-sells",
            "cancel-buys",
            "close-half",
            "pause",
            "resume",
            "flat-reseed",
            "refill",
          ];
          const validVenues = [
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
          if (!venue || !validVenues.includes(venue) || !actions.includes(action)) {
            res.writeHead(400, {
              "Content-Type": "application/json; charset=utf-8",
            });
            res.end(
              JSON.stringify({
                ok: false,
                error: `非法参数 venue=${venue} action=${action}`,
              })
            );
            return;
          }
          const cmd = enqueueVenueCommand(venue as VenueId, action);
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({ ok: true, command: cmd }));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              ok: false,
              error: String(e?.message || e).slice(0, 240),
            })
          );
        }
      });
      return;
    }
    if (url === "/api/capital-flow" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8") || "{}";
          const j = JSON.parse(raw);
          const items = Array.isArray(j?.flows)
            ? j.flows
            : [
                {
                  venue: j?.venue,
                  amount:
                    j?.amount != null
                      ? Number(j.amount)
                      : j?.withdraw != null
                        ? -Math.abs(Number(j.withdraw))
                        : j?.deposit != null
                          ? Math.abs(Number(j.deposit))
                          : NaN,
                  note: j?.note,
                },
              ];
          const applied = [];
          for (const it of items) {
            const venue = String(it?.venue || "manual");
            let amount = Number(it?.amount);
            if (!Number.isFinite(amount) && it?.withdraw != null) {
              amount = -Math.abs(Number(it.withdraw));
            }
            if (!Number.isFinite(amount) && it?.deposit != null) {
              amount = Math.abs(Number(it.deposit));
            }
            const st = applyCapitalFlow({
              venue,
              amount,
              note: it?.note ? String(it.note) : undefined,
            });
            applied.push({
              venue,
              amount,
              dayProfit: st.calendar[0]?.dayProfit,
              dayOpenEquity: st.dayOpenEquity,
            });
          }
          const view = ledgerPublicView();
          // 刷新看板里的 ledger 视图
          snapshot = {
            ...snapshot,
            ledger: view,
            updatedAt: new Date().toISOString(),
          };
          persistStatus();
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({ ok: true, applied, ledger: view }));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              ok: false,
              error: String(e?.message || e).slice(0, 240),
            })
          );
        }
      });
      return;
    }
    if (url === "/api/ledger/official-volume" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8") || "{}";
          const j = JSON.parse(raw);
          const items = Array.isArray(j?.days)
            ? j.days
            : [{ day: j?.day, volume: j?.volume }];
          const applied = [];
          for (const it of items) {
            const day = String(it?.day || "");
            const volume = Number(it?.volume);
            const st = patchOfficialVolumeForDay(day, volume);
            const row = st.calendar.find((d) => d.day === day);
            applied.push({ day, volume: row?.officialVolume ?? volume });
          }
          const view = ledgerPublicView();
          snapshot = {
            ...snapshot,
            ledger: view,
            updatedAt: new Date().toISOString(),
          };
          persistStatus();
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(JSON.stringify({ ok: true, applied, ledger: view }));
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              ok: false,
              error: String(e?.message || e).slice(0, 240),
            })
          );
        }
      });
      return;
    }
    if (url === "/api/ledger/calendar-trim" && req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8") || "{}";
          const j = JSON.parse(raw);
          const from = String(j?.from || j?.keepFrom || "");
          const st = trimLedgerCalendar(from);
          const view = ledgerPublicView(st);
          snapshot = {
            ...snapshot,
            ledger: view,
            updatedAt: new Date().toISOString(),
          };
          persistStatus();
          res.writeHead(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Cache-Control": "no-store",
          });
          res.end(
            JSON.stringify({
              ok: true,
              from,
              days: view.calendar.map((d) => d.day),
              ledger: view,
            })
          );
        } catch (e: any) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          res.end(
            JSON.stringify({
              ok: false,
              error: String(e?.message || e).slice(0, 240),
            })
          );
        }
      });
      return;
    }
    if (url === "/" || url === "/index.html") {
      const htmlPath = path.join(PUBLIC_DIR, "index.html");
      if (!fs.existsSync(htmlPath)) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("public/index.html missing");
        return;
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
      });
      res.end(fs.readFileSync(htmlPath));
      return;
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });
  server.listen(port, "0.0.0.0", () => {
    console.log(`[dashboard] http://0.0.0.0:${port}/  api=/api/snapshot`);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(`[dashboard] listen failed: ${e.message}`);
  });
  return server;
}
