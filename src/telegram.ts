import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./loadEnv.js";

let lastSentAt = 0;
const MIN_GAP_MS = 1500;
const recentKeys = new Map<string, number>();

type TgJob = {
  id: string;
  text: string;
  createdAt: number;
  tries: number;
};

let tradeQueue: TgJob[] = [];
let tradePumping = false;
let lastPosMap: Record<string, number> | null = null;

const VENUE_LABEL: Record<string, string> = {
  risex: "RISEx",
  decibel: "Decibel",
  n1: "N1",
  popdex: "PopDEX",
};

function venueLabel(id: string): string {
  return VENUE_LABEL[id] || id;
}

function enabled(): boolean {
  loadEnv();
  const v = String(process.env.TELEGRAM_ENABLED || "").toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function token(): string {
  return (process.env.TELEGRAM_BOT_TOKEN || process.env.TG_BOT_TOKEN || "").trim();
}

function chatIds(): string[] {
  const raw =
    process.env.TELEGRAM_CHAT_IDS ||
    process.env.TELEGRAM_CHAT_ID ||
    process.env.TG_CHAT_ID ||
    "";
  return String(raw)
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function shouldSend(key: string, ttlMs: number): boolean {
  const now = Date.now();
  const prev = recentKeys.get(key) || 0;
  if (now - prev < ttlMs) return false;
  recentKeys.set(key, now);
  if (recentKeys.size > 200) {
    for (const [k, t] of recentKeys) {
      if (now - t > ttlMs) recentKeys.delete(k);
    }
  }
  return true;
}

function dataFile(name: string): string {
  const dir = path.resolve(process.cwd(), "data");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function loadTradeQueue(): void {
  try {
    const p = dataFile("tg-queue.json");
    if (!fs.existsSync(p)) return;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    if (Array.isArray(j)) tradeQueue = j.filter((x) => x && typeof x.text === "string");
  } catch {
    /* ignore */
  }
}

function saveTradeQueue(): void {
  try {
    fs.writeFileSync(dataFile("tg-queue.json"), JSON.stringify(tradeQueue), "utf8");
  } catch {
    /* ignore */
  }
}

/** 上次已入队/已记账的仓位；重启后用这个比现仓，成交不会被第一拍吃掉 */
export function loadRememberedPositions(): Record<string, number> {
  if (lastPosMap) return { ...lastPosMap };
  lastPosMap = {};
  try {
    const p = dataFile("tg-last-pos.json");
    if (fs.existsSync(p)) {
      const j = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const [k, v] of Object.entries(j || {})) {
        const n = Number(v);
        if (Number.isFinite(n)) lastPosMap[k] = n;
      }
    }
  } catch {
    /* ignore */
  }
  if (!Object.keys(lastPosMap).length) {
    try {
      const p = path.resolve(process.cwd(), "data", "status.json");
      if (fs.existsSync(p)) {
        const j = JSON.parse(fs.readFileSync(p, "utf8"));
        for (const v of j.venues || []) {
          const id = String(v.venue || "");
          const pos = Number(v.position);
          const mid = Number(v.mid);
          if (id && Number.isFinite(pos) && mid > 1000) lastPosMap[id] = pos;
        }
      }
    } catch {
      /* ignore */
    }
  }
  return { ...lastPosMap };
}

export function rememberVenuePos(venue: string, pos: number): void {
  if (!Number.isFinite(pos)) return;
  if (!lastPosMap) loadRememberedPositions();
  lastPosMap![venue] = pos;
  try {
    fs.writeFileSync(dataFile("tg-last-pos.json"), JSON.stringify(lastPosMap), "utf8");
  } catch {
    /* ignore */
  }
}

function enqueueTrade(text: string): void {
  tradeQueue.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    text,
    createdAt: Date.now(),
    tries: 0,
  });
  saveTradeQueue();
  void pumpTradeQueue();
}

async function pumpTradeQueue(): Promise<void> {
  if (tradePumping) return;
  tradePumping = true;
  try {
    if (!tradeQueue.length) loadTradeQueue();
    while (tradeQueue.length) {
      const job = tradeQueue[0];
      const ok = await tgSendRaw(job.text);
      if (ok) {
        tradeQueue.shift();
        saveTradeQueue();
        continue;
      }
      job.tries += 1;
      saveTradeQueue();
      const wait = Math.min(60_000, 2000 * 2 ** Math.min(job.tries - 1, 5));
      console.error(`[tg] trade retry in ${wait}ms tries=${job.tries} left=${tradeQueue.length}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  } finally {
    tradePumping = false;
  }
  if (tradeQueue.length) void pumpTradeQueue();
}

export function startTgPump(): void {
  loadTradeQueue();
  if (tradeQueue.length) {
    console.log(`[tg] resume queue n=${tradeQueue.length}`);
    void pumpTradeQueue();
  }
}

async function tgSendRaw(text: string): Promise<boolean> {
  if (!enabled()) return false;
  const tok = token();
  const chats = chatIds();
  if (!tok || !chats.length) return false;

  const now = Date.now();
  const wait = lastSentAt + MIN_GAP_MS - now;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSentAt = Date.now();

  const body = encodeURIComponent(text.slice(0, 3500));
  let ok = false;
  for (const chat of chats) {
    try {
      const url = `https://api.telegram.org/bot${tok}/sendMessage?chat_id=${encodeURIComponent(
        chat
      )}&text=${body}&disable_web_page_preview=1`;
      const res = await fetch(url, { method: "GET", signal: AbortSignal.timeout(20_000) });
      if (res.ok) ok = true;
      else console.error(`[tg] HTTP ${res.status} chat=${chat}`);
    } catch (e: any) {
      console.error(`[tg] send failed: ${String(e?.message || e).slice(0, 120)}`);
    }
  }
  return ok;
}

export async function tgSend(
  text: string,
  opts?: { key?: string; ttlMs?: number }
): Promise<boolean> {
  if (opts?.key && !shouldSend(opts.key, opts.ttlMs ?? 60_000)) return false;
  return tgSendRaw(text);
}

/** 穿价 / post-only / 链上瞬时拒单 / 坏回包：可下轮重试，不发 TG、不挂看板红字 */
export function isSoftPlaceError(venue: string, msg: string): boolean {
  const short = String(msg || "").replace(/\s+/g, " ");
  // Phoenix API 偶发坏 JSON（id 缺引号等）→ 当拍补单失败，下轮重试；勿标异常
  if (
    /is not valid JSON|Unexpected token|Unexpected number in JSON|Expected ',' or '}' after property value|Exponent part is missing a number in JSON|JSON at position/i.test(
      short
    )
  ) {
    return true;
  }
  if (venue === "popdex") {
    return /post.?only|cross|穿价|would be (immediately )?filled|rejected|unknown RPC error/i.test(
      short
    );
  }
  if (venue === "n1" || venue === "decibel" || venue === "risex") {
    return /Failed to place|post.?only|cross|穿价|would be (immediately )?filled|rejected|max open/i.test(
      short
    );
  }
  return /Failed to place|post.?only|crosses the book|穿价/i.test(short);
}

export async function tgError(venue: string, msg: string): Promise<void> {
  const short = String(msg || "").replace(/\s+/g, " ").slice(0, 240);
  // 读侧瞬时网络/SDK 抖动：只打日志，不刷 TG（网格仍在跑）
  if (
    /fetch failed|ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|UND_ERR|internal assertion violation|network|getaddrinfo/i.test(
      short
    )
  ) {
    return;
  }
  const isRate = /429|限流|rate.?limit|max open orders/i.test(short);
  // Phoenix/Nado 瞬时穿价拒单：不提醒（日志里仍有 apply failed）
  if (isSoftPlaceError(venue, short)) return;
  await tgSend(`⚠️ [${venueLabel(venue)}] ${short}`, {
    key: `err:${venue}:${isRate ? "rate" : short.slice(0, 80)}`,
    ttlMs: isRate ? 600_000 : 120_000,
  });
}

export type TradeKind = "开多" | "平多" | "开空" | "平空";

export function classifyTrade(
  posBefore: number,
  side: "buy" | "sell",
  size: number
): { kind: TradeKind; posAfter: number } {
  const eps = 1e-10;
  const sz = Math.abs(size);
  if (side === "buy") {
    if (posBefore < -eps) {
      return { kind: "平空", posAfter: posBefore + sz };
    }
    return { kind: "开多", posAfter: posBefore + sz };
  }
  if (posBefore > eps) {
    return { kind: "平多", posAfter: posBefore - sz };
  }
  return { kind: "开空", posAfter: posBefore - sz };
}

function countBuySell(orders: Array<{ side: string }>): { buy: number; sell: number } {
  let buy = 0;
  let sell = 0;
  for (const o of orders) {
    if (o.side === "buy") buy += 1;
    else sell += 1;
  }
  return { buy, sell };
}

function fmtPosU(pos: number, mid: number): string {
  if (!(mid > 0)) return "-";
  const u = Math.abs(pos) * mid;
  if (u < 1e-6) return "0U";
  return `${u.toFixed(0)}U`;
}

function fmtFillU(sizeBase: number, mid: number): string {
  if (!(mid > 0) || !(sizeBase > 0)) return "-";
  const u = Math.abs(sizeBase) * mid;
  return `${u.toFixed(0)}U`;
}

function fmtPnlLabel(pnlUsd: number): string {
  const abs = Math.abs(pnlUsd);
  const n = abs >= 10 ? abs.toFixed(2) : abs.toFixed(4);
  if (pnlUsd < 0) return `亏损 -${n}U`;
  return `盈利 +${n}U`;
}

function fmtBagPos(pos: number, mid: number): string {
  if (!(mid > 0)) return "-";
  if (Math.abs(pos) < 1e-12) return "0U";
  const side = pos > 0 ? "多" : "空";
  return `${side} ${fmtPosU(pos, mid)}`;
}

function tradeLines(p: {
  venue: string;
  head: string;
  buyOrders: number;
  sellOrders: number;
  bagPos: string;
}): string {
  return [
    p.head,
    `挂单 多${p.buyOrders} · 空${p.sellOrders}`,
    `现仓 ${p.bagPos}`,
  ].join("\n");
}

/** 开仓：所 · 开多/开空 +本笔U · 挂单 · 现仓 */
export async function tgOpen(p: {
  venue: string;
  kind: "开多" | "开空";
  posAfter: number;
  mid: number;
  /** 本笔成交 size（base），用于显示 +本笔U */
  fillBase: number;
  openOrders: Array<{ side: string }>;
}): Promise<void> {
  const { buy, sell } = countBuySell(p.openOrders);
  enqueueTrade(
    tradeLines({
      venue: p.venue,
      head: `${venueLabel(p.venue)} · ${p.kind} +${fmtFillU(p.fillBase, p.mid)}`,
      buyOrders: buy,
      sellOrders: sell,
      bagPos: fmtBagPos(p.posAfter, p.mid),
    })
  );
}

/** 平仓：所 · 平多/平空 · 盈亏 · 挂单 · 现仓 */
export async function tgClose(p: {
  venue: string;
  kind: "平多" | "平空";
  posAfter: number;
  mid: number;
  fillBase: number;
  openOrders: Array<{ side: string }>;
  /** 单笔盈亏（优先官方 fill；否则格距×size） */
  pnlUsd?: number | null;
}): Promise<void> {
  const { buy, sell } = countBuySell(p.openOrders);
  const pnlLabel =
    p.pnlUsd != null && Number.isFinite(p.pnlUsd)
      ? fmtPnlLabel(p.pnlUsd)
      : "盈利";
  enqueueTrade(
    tradeLines({
      venue: p.venue,
      head: `${venueLabel(p.venue)} · ${p.kind} · ${pnlLabel}`,
      buyOrders: buy,
      sellOrders: sell,
      bagPos: fmtBagPos(p.posAfter, p.mid),
    })
  );
}

export async function tgStop(venue: string, msg: string): Promise<void> {
  await tgSend(`🛑 [${venueLabel(venue)}] ${msg}`.slice(0, 400), {
    key: `stop:${venue}:${String(msg).slice(0, 60)}`,
    ttlMs: 90_000,
  });
}

export async function tgBoot(summary: string): Promise<void> {
  await tgSend(`🚀 经典网格启动\n${summary}`, { key: "boot", ttlMs: 30_000 });
}

/** 整点/日报：只报看板总览；并落盘便于日历回填 */
export async function tgDailyOverview(p: {
  dayKey: string;
  dayProfit: number | null;
  equity: number | null;
  volume: number | null;
  fees: number | null;
  openOrders: number;
  expectOrders: number;
  healthy: number;
  totalVenues: number;
}): Promise<void> {
  const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}U`;
  const lines = [
    `📊 总览 ${p.dayKey}`,
    `今日盈亏 ${p.dayProfit != null ? signed(p.dayProfit) : "-"}`,
    `总余额 ${p.equity != null && p.equity > 0 ? p.equity.toFixed(0) + "U" : "-"}`,
    `今日成交量 ${p.volume != null ? p.volume.toFixed(0) + "U" : "-"}`,
    `今日手续费 ${p.fees != null ? p.fees.toFixed(2) + "U" : "-"}`,
    `挂单 ${p.openOrders} / 期望≈${p.expectOrders}`,
    `健康 ${p.healthy}/${p.totalVenues}`,
  ];
  try {
    const dir = path.resolve(process.cwd(), "data");
    fs.mkdirSync(dir, { recursive: true });
    const row = {
      at: new Date().toISOString(),
      dayKey: p.dayKey,
      volume: p.volume,
      fees: p.fees,
      dayProfit: p.dayProfit,
      equity: p.equity,
    };
    fs.appendFileSync(
      path.join(dir, "tg-hourly.jsonl"),
      JSON.stringify(row) + "\n",
      "utf8"
    );
  } catch {
    /* ignore */
  }
  await tgSend(lines.join("\n"), {
    key: `daily:${p.dayKey}:${new Date().getHours()}`,
    ttlMs: 50 * 60_000,
  });
}

/** @deprecated 保留别名，内部转总览 */
export async function tgHourlyStatus(p: {
  dayKey: string;
  dayProfit: number | null;
  equity: number | null;
  volume: number | null;
  fees: number | null;
  openOrders: number;
  expectOrders: number;
  healthy: number;
  totalVenues: number;
}): Promise<void> {
  await tgDailyOverview(p);
}
