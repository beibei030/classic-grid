/**
 * Decibel + PopDEX 独立实例，共用 8088 总看板。
 * 强制只跑这两所 + 新止损；不读 .env 里其它 VENUES。
 */
import { loadEnv } from "../loadEnv.js";

loadEnv();
process.env.VENUES = "decibel,popdex";
process.env.STOP_LOSS = "1";
process.env.STOP_LOSS_VENUES = "decibel,popdex";
if (!String(process.env.POPDEX_HALF_BAND || "").trim()) {
  process.env.POPDEX_HALF_BAND = String(Math.round(65_000 * 0.05));
}

const { runLoop } = await import("../loop.js");
await runLoop({ once: process.argv.includes("--once") });
