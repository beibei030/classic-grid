import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { loadEnv } from "../loadEnv.js";
import { DecibelExecutor } from "../venues/decibel.js";
import { PopdexExecutor } from "../venues/popdex.js";
import { startTgPump, tgSend } from "../telegram.js";
import {
  isNeutralPair,
  shortVenueForFunding,
} from "../hedge/core.js";
import type {
  FundingQuote,
  HedgeOrder,
  TopOfBook,
  VenueExecutor,
} from "../venues/types.js";

loadEnv();
process.env.GRID_SKIP_LEVERAGE = "1";

const live = process.env.HEDGE_LIVE_CONFIRM === "YES";
const qty = Math.max(0.0002, Number(process.env.HEDGE_SIZE_BTC || 0.0002));
const maxRounds = Math.max(1, Number(process.env.HEDGE_MAX_ROUNDS || 10));
const pairTimeoutMs = Math.max(
  5_000,
  Number(process.env.HEDGE_PAIR_TIMEOUT_MS || 15_000)
);
const makerTimeoutMs = Math.max(
  15_000,
  Number(process.env.HEDGE_MAKER_TIMEOUT_MS || 60_000)
);
const holdMs = Math.max(30_000, Number(process.env.HEDGE_HOLD_MS || 60_000));
const dailyLossLimit = Math.max(
  0.5,
  Number(process.env.HEDGE_DAILY_LOSS_USD || 2)
);
const fundingGate = Math.max(
  0,
  Number(process.env.HEDGE_FUNDING_GATE_BP || 0)
) / 10_000;
const tgEnabled = process.env.HEDGE_TELEGRAM_ENABLED === "YES";
const port = Math.max(1, Number(process.env.HEDGE_DASHBOARD_PORT || 8091));
const host = process.env.HEDGE_DASHBOARD_HOST || "127.0.0.1";
const publicFile = path.resolve(process.cwd(), "public", "hedge.html");

type Phase =
  | "shadow"
  | "idle"
  | "opening"
  | "hedging"
  | "hedged"
  | "closing"
  | "cooldown"
  | "halted";

type SafeSnapshot = Awaited<ReturnType<VenueExecutor["snapshot"]>>;

type HedgeState = {
  startedAt: string;
  updatedAt: string;
  live: boolean;
  phase: Phase;
  round: number;
  maxRounds: number;
  qty: number;
  commonPrice?: number;
  direction?: string;
  fundingGapBp?: number;
  decBook?: TopOfBook;
  popBook?: TopOfBook;
  decFunding?: FundingQuote;
  popFunding?: FundingQuote;
  dec?: SafeSnapshot;
  pop?: SafeSnapshot;
  startEquity?: number;
  currentEquity?: number;
  error?: string;
  logs: string[];
};

const state: HedgeState = {
  startedAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  live,
  phase: live ? "idle" : "shadow",
  round: 0,
  maxRounds,
  qty,
  logs: [],
};

const dec = new DecibelExecutor(false);
const pop = new PopdexExecutor(false);
let phaseAt = Date.now();
let cooldownUntil = 0;
let ticking = false;
let activeShortVenue: "decibel" | "popdex" | null = null;
let activeQty = qty;
let makerRequoteAt = 0;

function log(message: string) {
  const line = `${new Date().toISOString()} ${message}`;
  console.log(line);
  state.logs.push(line);
  if (state.logs.length > 100) state.logs.splice(0, state.logs.length - 100);
}

async function notify(message: string, opts: { key: string; ttlMs: number }) {
  if (!tgEnabled) return;
  await tgSend(message, opts);
}

function sideFor(
  venue: "decibel" | "popdex",
  shortVenue: "decibel" | "popdex"
): "buy" | "sell" {
  return venue === shortVenue ? "sell" : "buy";
}

async function marketData() {
  const [decBook, popBook, decFunding, popFunding, decSnap, popSnap] =
    await Promise.all([
      dec.topOfBook!("BTC"),
      pop.topOfBook!("BTC"),
      dec.fundingQuote!("BTC"),
      pop.fundingQuote!("BTC"),
      dec.snapshot("BTC"),
      pop.snapshot("BTC"),
    ]);
  state.decBook = decBook;
  state.popBook = popBook;
  state.decFunding = decFunding;
  state.popFunding = popFunding;
  state.dec = decSnap;
  state.pop = popSnap;
  state.currentEquity =
    Number(decSnap.equityUsd || 0) + Number(popSnap.equityUsd || 0);
  if (state.startEquity == null && state.currentEquity > 0) {
    state.startEquity = state.currentEquity;
  }
  return { decBook, popBook, decFunding, popFunding, decSnap, popSnap };
}

async function cancelAndFlatten(reason: string) {
  log(`safety flatten: ${reason}`);
  await Promise.allSettled([dec.cancelAll("BTC"), pop.cancelAll("BTC")]);
  const [ds, ps] = await Promise.all([
    dec.snapshot("BTC").catch(() => null),
    pop.snapshot("BTC").catch(() => null),
  ]);
  await Promise.allSettled([
    ds && Math.abs(ds.position) > 1e-9
      ? dec.closePosition("BTC")
      : Promise.resolve(),
    ps && Math.abs(ps.position) > 1e-9
      ? pop.closePosition("BTC")
      : Promise.resolve(),
  ]);
}

async function openDecMaker(
  price: number,
  shortVenue: "decibel" | "popdex"
) {
  const clientBase = `hp${Date.now().toString(36)}`;
  const decOrder: HedgeOrder = {
    market: "BTC",
    side: sideFor("decibel", shortVenue),
    size: qty,
    price,
    reduceOnly: false,
    clientOrderId: `${clientBase}d`,
  };
  const result = await dec.placeHedgeLimit!(decOrder);
  if (!result.accepted) {
    await cancelAndFlatten("open submit rejected");
    throw new Error(result.note || "Dec maker 未受理");
  }
  log(
    `Dec maker submitted price=${price} qty=${qty} side=${decOrder.side}`
  );
}

async function hedgePop(decPosition: number) {
  const size = Math.abs(decPosition);
  const order: HedgeOrder = {
    market: "BTC",
    side: decPosition > 0 ? "sell" : "buy",
    size,
    reduceOnly: false,
    maxSlippagePct: 0.0005,
    clientOrderId: `hh${Date.now().toString(36)}p`,
  };
  const result = await pop.placeHedgeIoc!(order);
  if (!result.accepted) {
    throw new Error(result.note || "Pop IOC 未受理");
  }
  log(`Pop IOC submitted side=${order.side} qty=${size}`);
}

async function beginPopHedge(decPosition: number) {
  activeQty = Math.abs(decPosition);
  if (activeQty < 0.0001) {
    await dec.closePosition("BTC");
    state.phase = "halted";
    state.error = `Dec 部分成交 ${activeQty} BTC，小于 Pop 最小数量`;
    throw new Error(state.error);
  }
  await dec.cancelAll("BTC");
  state.phase = "hedging";
  phaseAt = Date.now();
  await hedgePop(decPosition);
}

async function closePair() {
  state.phase = "closing";
  phaseAt = Date.now();
  await Promise.allSettled([dec.cancelAll("BTC"), pop.cancelAll("BTC")]);
  await Promise.all([
    dec.closePosition("BTC"),
    pop.closePosition("BTC"),
  ]);
  log("close submitted reduce-only");
}

async function tick() {
  if (ticking || state.phase === "halted") return;
  ticking = true;
  try {
    const { decBook, popBook, decFunding, popFunding, decSnap, popSnap } =
      await marketData();
    const preferredShortVenue = shortVenueForFunding(
      decFunding.rate,
      popFunding.rate
    );
    const gap = Math.abs(decFunding.rate - popFunding.rate);
    const shortVenue = activeShortVenue ?? preferredShortVenue;
    const decSide = sideFor("decibel", shortVenue);
    const commonPrice =
      decSide === "buy"
        ? Math.floor(decBook.bid * 10) / 10
        : Math.ceil(decBook.ask * 10) / 10;
    state.direction =
      shortVenue === "decibel" ? "Dec空 / Pop多" : "Dec多 / Pop空";
    state.fundingGapBp = gap * 10_000;
    state.commonPrice = commonPrice ?? undefined;
    state.updatedAt = new Date().toISOString();

    if (
      state.startEquity != null &&
      state.currentEquity != null &&
      state.currentEquity <= state.startEquity - dailyLossLimit
    ) {
      await cancelAndFlatten("daily loss limit");
      state.phase = "halted";
      state.error = `日亏达到 ${dailyLossLimit}U`;
      await notify(`HEDGE 已停机：${state.error}`, {
        key: "hedge-loss-stop",
        ttlMs: 86_400_000,
      });
      return;
    }

    if (!live) {
      state.phase = "shadow";
      state.error = undefined;
      return;
    }

    if (state.phase === "cooldown") {
      if (Date.now() >= cooldownUntil) state.phase = "idle";
      return;
    }

    if (state.phase === "idle") {
      if (state.round >= maxRounds) {
        state.phase = "halted";
        return;
      }
      if (
        gap < fundingGate ||
        Math.abs(decSnap.position) > 1e-9 ||
        Math.abs(popSnap.position) > 1e-9 ||
        decSnap.openOrders.length ||
        popSnap.openOrders.length
      ) {
        return;
      }
      state.phase = "opening";
      phaseAt = Date.now();
      makerRequoteAt = phaseAt;
      activeShortVenue = shortVenue;
      activeQty = qty;
      await openDecMaker(commonPrice, shortVenue);
      return;
    }

    if (state.phase === "opening") {
      if (Math.abs(decSnap.position) > 1e-9) {
        try {
          await beginPopHedge(decSnap.position);
        } catch (error) {
          await cancelAndFlatten("Pop hedge submit failed");
          state.phase = "halted";
          throw error;
        }
        return;
      }
      if (Date.now() - phaseAt > makerTimeoutMs) {
        await cancelAndFlatten("Dec maker timeout");
        state.phase = "halted";
        state.error = "Dec maker 60秒未成交";
        return;
      }
      if (Date.now() - makerRequoteAt >= 3_000) {
        await dec.cancelAll("BTC");
        const fresh = await dec.snapshot("BTC");
        if (Math.abs(fresh.position) > 1e-9) {
          try {
            await beginPopHedge(fresh.position);
          } catch (error) {
            await cancelAndFlatten("Pop hedge submit failed after reprice");
            state.phase = "halted";
            throw error;
          }
          return;
        }
        const freshBook = await dec.topOfBook!("BTC");
        const frozenShort = activeShortVenue ?? shortVenue;
        const freshSide = sideFor("decibel", frozenShort);
        const freshPrice =
          freshSide === "buy"
            ? Math.floor(freshBook.bid * 10) / 10
            : Math.ceil(freshBook.ask * 10) / 10;
        await openDecMaker(freshPrice, frozenShort);
        makerRequoteAt = Date.now();
      }
    }

    if (state.phase === "hedging") {
      if (isNeutralPair(decSnap.position, popSnap.position, activeQty)) {
        state.phase = "hedged";
        phaseAt = Date.now();
        log(
          `pair hedged dec=${decSnap.position} pop=${popSnap.position}`
        );
        await notify(
          `HEDGE 开仓完成\n${state.direction}\nqty=${activeQty} BTC\nprice≈${commonPrice}`,
          { key: `hedge-open-${state.round}`, ttlMs: 60_000 }
        );
        return;
      }
      if (Date.now() - phaseAt > pairTimeoutMs) {
        await cancelAndFlatten("pair timeout");
        state.phase = "halted";
        state.error = "Pop 对冲腿超时";
        return;
      }
    }

    if (state.phase === "hedged" && Date.now() - phaseAt >= holdMs) {
      await closePair();
      return;
    }

    if (state.phase === "closing") {
      const flat =
        Math.abs(decSnap.position) < 1e-9 &&
        Math.abs(popSnap.position) < 1e-9;
      if (flat) {
        state.round += 1;
        state.phase = "cooldown";
        cooldownUntil = Date.now() + 30_000;
        log(`round ${state.round} complete`);
        await notify(`HEDGE 第 ${state.round}/${maxRounds} 轮完成`, {
          key: `hedge-close-${state.round}`,
          ttlMs: 60_000,
        });
      } else if (Date.now() - phaseAt > 30_000) {
        await cancelAndFlatten("close timeout");
        state.phase = "halted";
        state.error = "平仓超时";
      }
    }
  } catch (error: any) {
    state.error = String(error?.message || error).slice(0, 300);
    log(`tick error: ${state.error}`);
    if (
      live &&
      (state.phase === "opening" ||
        state.phase === "hedging" ||
        state.phase === "closing")
    ) {
      await cancelAndFlatten("tick error").catch(() => {});
      state.phase = "halted";
    }
  } finally {
    state.updatedAt = new Date().toISOString();
    ticking = false;
  }
}

function startServer() {
  const server = http.createServer((req, res) => {
    const url = req.url?.split("?")[0] || "/";
    if (url === "/api/hedge") {
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(state));
      return;
    }
    if (url === "/api/hedge/stop" && req.method === "POST") {
      state.phase = "halted";
      void cancelAndFlatten("manual stop").catch((e) => {
        state.error = String(e?.message || e);
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    try {
      const html = fs.readFileSync(publicFile);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    } catch {
      res.writeHead(404);
      res.end("hedge dashboard missing");
    }
  });
  server.listen(port, host, () => {
    log(`hedge dashboard http://${host}:${port} live=${live}`);
  });
}

await Promise.all([dec.connect(), pop.connect()]);
if (tgEnabled) startTgPump();
startServer();
await notify(
  `HEDGE 启动\nmode=${live ? "LIVE" : "SHADOW"}\nDec + Pop\nqty=${qty} BTC\nmaxRounds=${maxRounds}`,
  { key: `hedge-boot-${state.startedAt}`, ttlMs: 60_000 }
);
await tick();
setInterval(() => void tick(), 1000).unref();
