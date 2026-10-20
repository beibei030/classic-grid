/**
 * Decibel + PopDEX + N1 + RISEx：旧 Lighter 资金强度 + 前紧后松宽带。
 * 1000U × 60% / 30x（RISEx 25x），中心 ±4%、外层 ±8%。
 * 不读 .env 里其它 VENUES；SOFT_RESUME 开，崩了按原锚续跑，不重铺。
 */
import { loadEnv } from "../loadEnv.js";
import { setBotPaused, loadBotPauseState } from "../botControl.js";
import fs from "node:fs";
import path from "node:path";
import { enqueueVenueCommand, loadVenueControl, setVenueControl } from "../venueControl.js";
import {
  loadStopLossState,
  clearHardStopLock,
  clearLadderOpenLock,
} from "../stopLoss.js";
import type { VenueId } from "../types.js";

console.log("[lit-prog] boot");
loadEnv();

process.env.GRID_PROFILE = "lit-prog";
process.env.VENUES = "decibel,popdex,n1,risex";
process.env.DECIBEL_EQUITY_USD = "1000";
process.env.N1_EQUITY_USD = "1000";
process.env.POPDEX_EQUITY_USD = "1000";
process.env.RISEX_EQUITY_USD = "1000";
process.env.DECIBEL_MARGIN_FRAC = "0.6";
process.env.N1_MARGIN_FRAC = "0.45";
process.env.POPDEX_MARGIN_FRAC = "0.6";
process.env.RISEX_MARGIN_FRAC = "0.6";
process.env.SOFT_RESUME = "1";
process.env.STOP_LOSS = "1";
process.env.STOP_LOSS_VENUES = "decibel,popdex,n1,risex";
process.env.STOP_LADDER_START = "0";
process.env.STOP_LADDER_STEP = "0.007";
process.env.STOP_LADDER_FRAC = "0.25";
process.env.STOP_HARD_PCT = "0.014";
process.env.STOP_LADDER_COOLDOWN_MS = "60000";
if (!String(process.env.DASHBOARD_PORT || "").trim()) {
  process.env.DASHBOARD_PORT = "8088";
}
process.env.TELEGRAM_ENABLED = "yes";
process.env.TICK_MS = "10000";

const VENUES: VenueId[] = ["decibel", "popdex", "n1", "risex"];

loadBotPauseState();
if (loadBotPauseState().paused) {
  setBotPaused(false, "lit-prog fresh start");
}
loadVenueControl();
loadStopLossState();
for (const venue of VENUES) {
  setVenueControl(venue, { paused: false, holdSide: "neutral" });
  clearHardStopLock(venue);
  clearLadderOpenLock(venue);
}
const n1FlatOnce = path.resolve(process.cwd(), "data", "n1-flat-reseed.once");
if (fs.existsSync(n1FlatOnce)) {
  fs.unlinkSync(n1FlatOnce);
  enqueueVenueCommand("n1", "flat-reseed");
  console.log("[lit-prog] N1 flat-reseed queued once");
}

const { runLoop } = await import("../loop.js");
await runLoop({ once: process.argv.includes("--once") });
