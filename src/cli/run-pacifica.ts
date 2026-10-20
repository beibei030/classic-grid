/**
 * Pacifica 独立实例。不改四所 VENUES，不进 start:four。
 */
import { loadEnv } from "../loadEnv.js";

loadEnv();
process.env.VENUES = "pacifica";
process.env.STOP_LOSS = "1";
process.env.STOP_LOSS_VENUES = "pacifica";
if (!String(process.env.PACIFICA_HALF_BAND || "").trim()) {
  process.env.PACIFICA_HALF_BAND = String(Math.round(65_000 * 0.05));
}
if (!String(process.env.PACIFICA_EQUITY_USD || "").trim()) {
  process.env.PACIFICA_EQUITY_USD = "1000";
}
if (!String(process.env.PACIFICA_MARGIN_FRAC || "").trim()) {
  process.env.PACIFICA_MARGIN_FRAC = "0.6";
}
if (!String(process.env.PACIFICA_LEVERAGE || "").trim()) {
  process.env.PACIFICA_LEVERAGE = "30";
}

const { runLoop } = await import("../loop.js");
await runLoop({ once: process.argv.includes("--once") });
