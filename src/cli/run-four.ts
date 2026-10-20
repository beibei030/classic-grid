/**
 * Decibel + PopDEX + N1 + RISEx，共用 8088。
 * 强制只跑这四所 + 止损；不读 .env 里其它 VENUES。
 * RISEx：所上杠杆硬顶 25x、挂单硬顶 50，故 46 格。
 */
import { loadEnv } from "../loadEnv.js";

loadEnv();
process.env.VENUES = "decibel,popdex,n1,risex";
process.env.STOP_LOSS = "1";
process.env.STOP_LOSS_VENUES = "decibel,popdex,n1,risex";

const { runLoop } = await import("../loop.js");
await runLoop({ once: process.argv.includes("--once") });
