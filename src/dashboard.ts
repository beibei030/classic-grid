import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ingestVenuesForLedger,
  ledgerPublicView,
  loadLedger,
} from "./ledger.js";
import type { OfficialBundle } from "./officialStats.js";

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
  updatedAt: string;
};

export type DashboardSnapshot = {
  startedAt: string;
  updatedAt: string;
  dryRun: boolean;
  venues: DashboardVenueRow[];
  ledger?: ReturnType<typeof ledgerPublicView>;
  official?: OfficialBundle | null;
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, "..", "public");

let snapshot: DashboardSnapshot = {
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  dryRun: true,
  venues: [],
  ledger: ledgerPublicView(loadLedger()),
};

export function getDashboardSnapshot(): DashboardSnapshot {
  return snapshot;
}

export function setDashboardMeta(p: { dryRun: boolean }): void {
  snapshot = {
    ...snapshot,
    dryRun: p.dryRun,
    updatedAt: new Date().toISOString(),
    ledger: ledgerPublicView(loadLedger()),
  };
}

export function setDashboardOfficial(official: OfficialBundle | null): void {
  snapshot = {
    ...snapshot,
    official,
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

export function startDashboardServer(port: number, host = "127.0.0.1"): http.Server | null {
  if (!(port > 0)) return null;
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error(`拒绝监听非回环地址 ${host}；请通过 Tailscale Serve 访问看板`);
  }
  const server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] || "/";
    if (url === "/api/snapshot" || url === "/api/status" || url === "/api/overview") {
      const body = {
        ...snapshot,
        ledger: snapshot.ledger || ledgerPublicView(loadLedger()),
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
      res.end(JSON.stringify({ privateAccess: true, port }));
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
  server.listen(port, host, () => {
    console.log(`[dashboard] http://${host}:${port}/  api=/api/snapshot`);
  });
  server.on("error", (e: NodeJS.ErrnoException) => {
    console.error(`[dashboard] listen failed: ${e.message}`);
  });
  return server;
}
