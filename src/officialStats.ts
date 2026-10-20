/**
 * 四所今日官方统计（成交量/手续费/平仓盈亏）。
 * 拉得到则 source=official；失败时优先沿用同日上次成功结果，
 * 避免冲刷下单配额、也避免看板整行空白。
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { VenueId } from "./types.js";
import { loadEnv } from "./loadEnv.js";
import { DecibelLive } from "./venues/decibelLive.js";

export type OfficialVenueDay = {
  venue: VenueId;
  ok: boolean;
  source: "official" | "unavailable";
  volume: number | null;
  fees: number | null;
  realizedPnl: number | null;
  fills: number | null;
  closeFills: number | null;
  feeMaker: number | null;
  feeTaker: number | null;
  note?: string;
  updatedAt: string;
};

export type OfficialBundle = {
  dayKey: string;
  dayStartMs: number;
  venues: Record<VenueId, OfficialVenueDay>;
  updatedAt: string;
};

function shanghaiDayKey(d = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function dayStartMs(dayKey: string): number {
  return Date.parse(`${dayKey}T00:00:00+08:00`);
}

function round(n: number, d = 4): number {
  const p = 10 ** d;
  return Math.round(n * p) / p;
}

function empty(venue: VenueId, note: string): OfficialVenueDay {
  return {
    venue,
    ok: false,
    source: "unavailable",
    volume: null,
    fees: null,
    realizedPnl: null,
    fills: null,
    closeFills: null,
    feeMaker: null,
    feeTaker: null,
    note,
    updatedAt: new Date().toISOString(),
  };
}

async function fetchRisex(since: number): Promise<OfficialVenueDay> {
  try {
    const vendor = path.resolve("vendor/risex/index.js");
    const mod = await import(pathToFileURL(vendor).href);
    const ex = mod.createExchange({
      account: process.env.RISEX_ACCOUNT,
      signerKey: process.env.RISEX_SIGNER_KEY,
      apiUrl: (process.env.RISEX_API_URL || "https://api.rise.trade").replace(/\/$/, ""),
      wsUrl: process.env.RISEX_WS_URL || "wss://ws.rise.trade/ws",
    });
    await ex.init();
    if (typeof ex._refreshOfficialStats === "function") {
      await ex._refreshOfficialStats();
    }
    const s = typeof ex.getTradeStats === "function" ? ex.getTradeStats() : ex._statsCache;
    const list = (s?.officialFills || []).filter((f: any) => f.t >= since);
    let volume = 0;
    let fees = 0;
    let realized = 0;
    let closeFills = 0;
    for (const f of list) {
      volume += Math.abs(Number(f.price) * Number(f.size));
      fees += Math.abs(Number(f.fee || 0));
      realized += Number(f.realizedPnl || 0);
      if (Math.abs(Number(f.realizedPnl || 0)) > 1e-9) closeFills += 1;
    }
    try {
      ex.stop?.();
    } catch {
      /* ignore */
    }
    return {
      venue: "risex",
      ok: true,
      source: "official",
      volume: round(volume, 2),
      fees: round(fees, 4),
      realizedPnl: round(realized, 4),
      fills: list.length,
      closeFills,
      feeMaker: null,
      feeTaker: null,
      note: "trade history fee+realized_pnl",
      updatedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    return empty("risex", String(e?.message || e).slice(0, 120));
  }
}

async function fetchDecibel(since: number): Promise<OfficialVenueDay> {
  try {
    const live = new DecibelLive();
    await live.connect();
    let feeMaker: number | null = 0.00011;
    let feeTaker: number | null = 0.00034;
    try {
      const addr = (live as any).subaccount;
      const base = (live as any).sdk?.MAINNET_CONFIG?.tradingHttpUrl?.replace(/\/$/, "");
      const key = process.env.DECIBEL_API_KEY?.trim();
      if (base && addr) {
        const res = await fetch(
          `${base}/api/v1/user_fee_rates?account=${encodeURIComponent(addr)}`,
          { headers: key ? { Authorization: `Bearer ${key}` } : undefined }
        );
        if (res.ok) {
          const j: any = await res.json();
          const body = j?.data ?? j;
          if (body?.user_maker_rate != null) feeMaker = Number(body.user_maker_rate);
          if (body?.user_taker_rate != null) feeTaker = Number(body.user_taker_rate);
        }
      }
    } catch {
      /* keep defaults */
    }
    const trades = await live.tradesSince(since, 1200);
    let volume = 0;
    let fees = 0;
    let realized = 0;
    let closeFills = 0;
    for (const t of trades || []) {
      const px = Number(t.price || 0);
      const sz = Math.abs(Number(t.size || 0));
      const fee = Math.abs(Number(t.fee_amount || 0));
      const rp = Number(t.realized_pnl_amount || 0);
      volume += px * sz;
      fees += fee;
      realized += rp;
      if (Math.abs(rp) > 1e-12) closeFills += 1;
    }
    try {
      live.disconnect?.();
    } catch {
      /* ignore */
    }
    return {
      venue: "decibel",
      ok: true,
      source: "official",
      volume: round(volume, 2),
      fees: round(fees, 4),
      realizedPnl: round(realized, 4),
      fills: (trades || []).length,
      closeFills,
      feeMaker,
      feeTaker,
      note: "userTradeHistory fee_amount+realized_pnl_amount",
      updatedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    return empty("decibel", String(e?.message || e).slice(0, 120));
  }
}

async function fetchN1(sinceMs: number): Promise<OfficialVenueDay> {
  try {
    const base = (process.env.N1_API_URL || "https://zo-mainnet.n1.xyz").replace(/\/$/, "");
    const keyPath =
      process.env.N1_KEYPAIR_PATH?.trim() ||
      path.resolve(process.cwd(), "secrets", "id.json");
    if (!fs.existsSync(keyPath)) {
      return empty("n1", `缺少 keypair：${keyPath}`);
    }
    // 延迟加载，避免官方统计拖垮无 N1 时的启动
    const { Nord, NordUser } = await import("@n1xyz/nord-ts");
    const { Connection } = await import("@solana/web3.js");
    const secret = Uint8Array.from(JSON.parse(fs.readFileSync(keyPath, "utf8")));
    const nord = await Nord.new({
      app: process.env.N1_APP_PUBLIC_KEY || "zoau54n5U24GHNKqyoziVaVxgsiQYnPMx33fKmLLCT5",
      solanaConnection: new Connection(
        process.env.N1_SOLANA_RPC || "https://api.mainnet-beta.solana.com",
        "confirmed"
      ),
      webServerUrl: base,
    });
    const user = NordUser.fromPrivateKey(nord, secret);
    await user.updateAccountId();
    const accountId = Number((user.accountIds ?? [])[0]);
    if (!Number.isFinite(accountId)) return empty("n1", "无 accountId");

    const sinceIso = new Date(sinceMs).toISOString();
    const marketId = 0;

    const volRes = await fetch(
      `${base}/account/volume?accountId=${accountId}&since=${encodeURIComponent(sinceIso)}&marketIds=${marketId}`
    );
    if (!volRes.ok) throw new Error(`volume HTTP ${volRes.status}`);
    const volRows: any[] = await volRes.json();
    const vol =
      (volRows || []).find((r) => Number(r.marketId) === marketId) || (volRows || [])[0];
    const volume = vol?.volumeQuote != null ? Number(vol.volumeQuote) : null;

    const pnlRes = await fetch(
      `${base}/account/${accountId}/pnl/summary?since=${encodeURIComponent(sinceIso)}&marketId=${marketId}`
    );
    if (!pnlRes.ok) throw new Error(`pnl/summary HTTP ${pnlRes.status}`);
    const pnlBody: any = await pnlRes.json();
    const pnlItem =
      (pnlBody?.items || []).find((r: any) => Number(r.marketId) === marketId) ||
      (pnlBody?.items || [])[0];
    const realizedPnl =
      pnlItem?.tradingPnl != null ? Number(pnlItem.tradingPnl) : null;

    let feeMaker: number | null = null;
    let feeTaker: number | null = null;
    try {
      const [m, t] = await Promise.all([
        fetch(`${base}/market/${marketId}/fees/maker/${accountId}`),
        fetch(`${base}/market/${marketId}/fees/taker/${accountId}`),
      ]);
      if (m.ok) feeMaker = Number(await m.json());
      if (t.ok) feeTaker = Number(await t.json());
    } catch {
      /* optional */
    }

    // 今日成交手续费：分别按 makerId / takerId 翻页累加本方 fee
    let fees = 0;
    let fills = 0;
    let feeKnown = false;
    for (const role of ["makerId", "takerId"] as const) {
      let start: string | number | null = null;
      for (let page = 0; page < 40; page++) {
        const q = new URLSearchParams({
          [role]: String(accountId),
          marketId: String(marketId),
          since: sinceIso,
          pageSize: "50",
        });
        if (start != null) q.set("startInclusive", String(start));
        const tr = await fetch(`${base}/trades?${q}`);
        if (!tr.ok) break;
        const body: any = await tr.json();
        const items: any[] = body?.items || body?.trades || [];
        for (const it of items) {
          fills += 1;
          const fee =
            role === "makerId"
              ? Number(it.makerFee)
              : Number(it.takerFee);
          if (Number.isFinite(fee)) {
            fees += Math.abs(fee);
            feeKnown = true;
          }
        }
        const next = body?.nextStartInclusive;
        if (next == null || items.length === 0) break;
        start = next;
      }
    }

    return {
      venue: "n1",
      ok: true,
      source: "official",
      volume: volume != null && Number.isFinite(volume) ? round(volume, 2) : null,
      fees: feeKnown ? round(fees, 4) : null,
      realizedPnl:
        realizedPnl != null && Number.isFinite(realizedPnl)
          ? round(realizedPnl, 4)
          : null,
      fills: fills > 0 ? fills : null,
      closeFills: null,
      feeMaker,
      feeTaker,
      note: "volume+pnl/summary+trades fee（docs.n1.xyz/api）",
      updatedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    return empty("n1", String(e?.message || e).slice(0, 120));
  }
}

async function fetchPopdex(since: number): Promise<OfficialVenueDay> {
  try {
    loadEnv();
    let addr = (process.env.POPDEX_ADDRESS || "").trim();
    if (!addr) {
      const keyPath =
        process.env.POPDEX_KEY_PATH?.trim() ||
        path.resolve(process.cwd(), "secrets", "popdex.key");
      const raw =
        (process.env.POPDEX_PRIVATE_KEY || "").trim() ||
        (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, "utf8").trim() : "");
      if (!raw) return empty("popdex", "无 POPDEX_PRIVATE_KEY / secrets/popdex.key");
      const { privateKeyToAccount } = await import("viem/accounts");
      const pk = (raw.startsWith("0x") ? raw : `0x${raw}`) as `0x${string}`;
      addr = privateKeyToAccount(pk).address;
    }
    let volume = 0;
    let fees = 0;
    let fills = 0;
    let cursor = "";
    for (let page = 0; page < 12; page++) {
      const qs = new URLSearchParams({
        category: "Futures",
        symbol: "BTCUSDT",
        limit: "100",
        startTime: String(since),
      });
      if (cursor) qs.set("cursor", cursor);
      const r = await fetch(
        `https://api.popdex.xyz/api/v1/account/${addr}/trade/fills?${qs}`,
        { headers: { "Content-Type": "application/json" } }
      );
      const j = (await r.json()) as any;
      if (String(j.code) !== "200") {
        return empty("popdex", String(j.msg || j.code || "fills fail").slice(0, 120));
      }
      const rows = Array.isArray(j.data) ? j.data : [];
      if (!rows.length) break;
      let oldest = Number.POSITIVE_INFINITY;
      for (const t of rows) {
        const ts = Number(t.createdAt ?? t.updatedAt ?? t.ts ?? 0);
        if (ts > 0 && ts < oldest) oldest = ts;
        if (ts > 0 && ts < since) continue;
        const notional = Math.abs(
          Number(
            t.execValue ??
              t.filledQuoteQty ??
              t.quoteQty ??
              (Number(t.execPrice ?? t.price) *
                Number(t.execQty || t.filledQty || t.qty) ||
                0)
          )
        );
        if (Number.isFinite(notional)) volume += notional;
        const feeArr = Array.isArray(t.feeDetail) ? t.feeDetail : [];
        for (const f of feeArr) {
          const fee = Number(f.fee ?? f.amount ?? 0);
          if (Number.isFinite(fee)) fees += Math.abs(fee);
        }
        fills += 1;
      }
      cursor = j.cursor || "";
      if (!cursor || !(oldest >= since)) break;
    }
    return {
      venue: "popdex",
      ok: true,
      source: "official",
      volume: round(volume, 2),
      fees: round(fees, 4),
      realizedPnl: null,
      fills: fills > 0 ? fills : 0,
      closeFills: null,
      feeMaker: 0.00012,
      feeTaker: 0.0004,
      note: "account trade/fills",
      updatedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    return empty("popdex", String(e?.message || e).slice(0, 120));
  }
}

let cache: OfficialBundle | null = null;
let inflight: Promise<OfficialBundle> | null = null;
let lastRefreshAt = 0;

export function getOfficialCache(): OfficialBundle | null {
  return cache;
}

/** 单所拉取失败时沿用同日上次 official，避免 429 把看板刷空、也少反复重打 API */
function keepOrFresh(
  dayKey: string,
  fresh: OfficialVenueDay,
  prevBundle: OfficialBundle | null
): OfficialVenueDay {
  if (fresh.ok && fresh.source === "official") return fresh;
  const prev =
    prevBundle && prevBundle.dayKey === dayKey
      ? prevBundle.venues?.[fresh.venue]
      : undefined;
  if (prev && prev.ok && prev.source === "official") {
    const why = (fresh.note || "拉取失败").slice(0, 80);
    return {
      ...prev,
      note: `${why} · 沿用上次`,
      updatedAt: fresh.updatedAt,
    };
  }
  return fresh;
}

export async function refreshOfficialStats(opts?: {
  force?: boolean;
  minIntervalMs?: number;
}): Promise<OfficialBundle> {
  loadEnv();
  // 默认 5 分钟；过勤会反复建连/拉成交史，长跑易堆内存
  const minInterval = opts?.minIntervalMs ?? 5 * 60_000;
  const now = Date.now();
  if (!opts?.force && cache && now - lastRefreshAt < minInterval) {
    return cache;
  }
  if (inflight) return inflight;

  inflight = (async () => {
    const dayKey = shanghaiDayKey();
    const since = dayStartMs(dayKey);
    const prev = cache;
    const [risex, decibel, n1, popdex] = await Promise.all([
      fetchRisex(since),
      fetchDecibel(since),
      fetchN1(since),
      fetchPopdex(since),
    ]);
    cache = {
      dayKey,
      dayStartMs: since,
      venues: {
        risex: keepOrFresh(dayKey, risex, prev),
        decibel: keepOrFresh(dayKey, decibel, prev),
        n1: keepOrFresh(dayKey, n1, prev),
        popdex: keepOrFresh(dayKey, popdex, prev),
      },
      updatedAt: new Date().toISOString(),
    };
    lastRefreshAt = Date.now();
    return cache;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

export function formatOfficialLine(v: OfficialVenueDay): string {
  if (!v.ok || v.source !== "official") {
    return `[${v.venue}] 官方=无${v.note ? `(${v.note})` : ""}`;
  }
  const vol = v.volume != null ? `${v.volume.toFixed(0)}U` : "无";
  const fee = v.fees != null ? `${v.fees.toFixed(2)}U` : "无";
  const pnl =
    v.realizedPnl == null
      ? "无"
      : `${v.realizedPnl >= 0 ? "+" : ""}${v.realizedPnl.toFixed(2)}U`;
  return `[${v.venue}] 量${vol} 费${fee} 平仓盈亏${pnl} 笔${v.fills ?? "无"}`;
}
