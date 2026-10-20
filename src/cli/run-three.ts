/**
 * 三所独立实例：Decibel / N1 / Entropy，共用 8088 总看板。
 * 不改旧的 `npm start` 八所路径。本入口强制 STOP_LOSS=1。
 */
import { loadEnv } from "../loadEnv.js";

loadEnv();
process.env.VENUES = "decibel,n1,entropy";
process.env.STOP_LOSS = "1";
process.env.STOP_LOSS_VENUES = "decibel,n1,entropy";

const { runLoop } = await import("../loop.js");
await runLoop({ once: process.argv.includes("--once") });
