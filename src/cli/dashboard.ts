/**
 * 只读看板：连各所拉 snapshot，不挂单；供「先看看板」阶段使用。
 * 用法：node --import tsx src/cli/dashboard.ts
 */
import {
  anchorGrid,
  gridFor,
  loadRuntimeConfig,
} from "../config.js";
import {
  setDashboardMeta,
  startDashboardServer,
  upsertDashboardVenue,
} from "../dashboard.js";
import { createExecutor } from "../venues/index.js";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const cfg = loadRuntimeConfig();
  // 看板进程强制不下单；可读实盘行情（DRY_RUN=0）或假数据（DRY_RUN=1）
  const readDry = cfg.dryRun;
  setDashboardMeta({ dryRun: true });
  const port = cfg.dashboardPort || 8088;
  startDashboardServer(port, cfg.dashboardHost);
  console.log(
    `dashboard-only venues=${cfg.venues.join(",")} readDry=${readDry} host=${cfg.dashboardHost} port=${port} (不下单)`
  );

  const exs = cfg.venues.map((v) => createExecutor(v, readDry));
  for (const ex of exs) {
    try {
      await ex.connect();
      console.log(`[${ex.id}] connected`);
    } catch (e: any) {
      console.error(`[${ex.id}] connect failed: ${String(e?.message || e).slice(0, 200)}`);
    }
  }

  const anchors = new Map<string, ReturnType<typeof anchorGrid>>();

  const tick = async () => {
    for (const market of cfg.markets) {
      for (const ex of exs) {
        try {
          const snap = await ex.snapshot(market);
          let g = anchors.get(ex.id);
          if (!g && snap.mid > 0) {
            g = anchorGrid(gridFor(cfg, ex.id), snap.mid);
            anchors.set(ex.id, g);
            console.log(
              `[${ex.id}] anchor mid=${snap.mid.toFixed(2)} → [${g.lower.toFixed(0)},${g.upper.toFixed(0)}]`
            );
          }
          upsertDashboardVenue({
            venue: ex.id,
            market,
            mid: snap.mid,
            anchorMid: g ? (g.lower + g.upper) / 2 : 0,
            lower: g?.lower || 0,
            upper: g?.upper || 0,
            spacing: g ? (g.upper - g.lower) / g.gridCount : 0,
            sizeBase: g?.sizeBase || 0,
            gridCount: g?.gridCount || gridFor(cfg, ex.id).gridCount,
            position: snap.position,
            openOrders: snap.openOrders.length,
            seeded: false,
            completedRungs: 0,
            gridProfit: 0,
            updatedAt: new Date().toISOString(),
          });
        } catch (e: any) {
          const msg = String(e?.message || e).slice(0, 200);
          console.error(`[${ex.id}] ${msg}`);
          upsertDashboardVenue({
            venue: ex.id,
            market,
            mid: 0,
            anchorMid: 0,
            lower: 0,
            upper: 0,
            spacing: 0,
            sizeBase: 0,
            gridCount: gridFor(cfg, ex.id).gridCount,
            position: 0,
            openOrders: 0,
            seeded: false,
            completedRungs: 0,
            gridProfit: 0,
            lastError: msg,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
  };

  await tick();
  setInterval(() => void tick(), cfg.tickMs);

  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
  await new Promise(() => {});
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
