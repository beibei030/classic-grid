/**
 * Decibel + PopDEX + N1 + RISEx + Lighter RH，共用 8088。
 * 强制只跑这些所 + 止损；不读 .env 里其它 VENUES。
 * RISEx：所上杠杆硬顶 25x、挂单硬顶 50，故 46 格 + ±5%（半幅对齐，不能铺 80）。
 * Lighter：1000U × 60% / 30x / 80格 / ±5%。
 */
import { loadEnv } from "../loadEnv.js";

loadEnv();
process.env.VENUES = "decibel,popdex,n1,risex,lighter";
process.env.STOP_LOSS = "1";
process.env.STOP_LOSS_VENUES = "decibel,popdex,n1,risex,lighter";
if (!String(process.env.POPDEX_HALF_BAND || "").trim()) {
  process.env.POPDEX_HALF_BAND = String(Math.round(65_000 * 0.05));
}
if (!String(process.env.RISEX_HALF_BAND || "").trim()) {
  process.env.RISEX_HALF_BAND = String(Math.round(65_000 * 0.05));
}
if (!String(process.env.N1_HALF_BAND || "").trim()) {
  process.env.N1_HALF_BAND = String(Math.round(65_000 * 0.05));
}
if (!String(process.env.LIGHTER_HALF_BAND || "").trim()) {
  process.env.LIGHTER_HALF_BAND = String(Math.round(65_000 * 0.05));
}
if (!String(process.env.LIGHTER_EQUITY_USD || "").trim()) {
  process.env.LIGHTER_EQUITY_USD = "1000";
}
if (!String(process.env.LIGHTER_MARGIN_FRAC || "").trim()) {
  process.env.LIGHTER_MARGIN_FRAC = "0.6";
}
if (!String(process.env.LIGHTER_LEVERAGE || "").trim()) {
  process.env.LIGHTER_LEVERAGE = "30";
}
if (!String(process.env.LIGHTER_ACCOUNT_INDEX || "").trim()) {
  process.env.LIGHTER_ACCOUNT_INDEX = "22746";
}
if (!String(process.env.LIGHTER_API_KEY_INDEX || "").trim()) {
  process.env.LIGHTER_API_KEY_INDEX = "5";
}

const { runLoop } = await import("../loop.js");
await runLoop({ once: process.argv.includes("--once") });
