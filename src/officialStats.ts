/**
 * 六所今日官方统计（成交量/手续费/平仓盈亏）。
 * 拉得到则 source=official；失败时优先沿用同日上次成功结果（尤其 Extended 429），
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

/** Extended 成交分页：只累加当日，跨日即停（假设新→旧），避免拉全历史撑爆堆 */
async function fetchExtended(since: number): Promise<OfficialVenueDay> {
  try {
    const vendor = path.resolve("vendor/extended/exchange/index.js");
    const mod = await import(pathToFileURL(vendor).href);
    const ex = mod.createExchange({
      apiKey: process.env.EXTENDED_API_KEY,
      vault: process.env.EXTENDED_VAULT || process.env.EXTENDED_VAULT_ID,
      starkPrivateKey: process.env.EXTENDED_STARK_PRIVATE_KEY,
      starkPublicKey: process.env.EXTENDED_STARK_PUBLIC_KEY,
      apiUrl: (process.env.EXTENDED_API_URL || "https://api.starknet.extended.exchange").replace(
        /\/$/,
        ""
      ),
    });
    await ex.init();
    let volume = 0;
    let fees = 0;
    let fills = 0;
    let cursor: unknown;
    for (let page = 0; page < 12; page++) {
      const { data, pagination } =
        typeof ex.getTradesPage === "function"
          ? await ex.getTradesPage("BTC-USD", { cursor, limit: 200 })
          : { data: await ex.fetchAllTrades(["BTC-USD"]), pagination: null };
      const rows = data || [];
      if (!rows.length) break;
      let oldest = Number.POSITIVE_INFINITY;
      for (const t of rows) {
        const f = ex._parseOfficialTrade ? ex._parseOfficialTrade(t) : null;
        let ts = f?.t ?? Number(t.createdTime ?? t.timestamp ?? t.t ?? 0);
        if (ts > 0 && ts < 1e12) ts *= 1000;
        if (ts > 0 && ts < oldest) oldest = ts;
        if (!(ts >= since)) continue;
        const val = Math.abs(Number(f?.value ?? Number(t.price) * Number(t.qty ?? t.size ?? 0)));
        const fee = Math.abs(Number(f?.fee ?? t.fee ?? 0));
        volume += val;
        fees += fee;
        fills += 1;
      }
      if (!(oldest >= since)) break;
      const next = pagination?.cursor;
      if (next == null || String(next) === String(cursor)) break;
      cursor = next;
      if (!pagination) break;
    }

    // 官方平仓盈亏：positions/history.realisedPnl（不在单笔 trades 里）
    let realized = 0;
    let closeFills = 0;
    const closed =
      typeof ex.fetchClosedPositions === "function"
        ? await ex.fetchClosedPositions(["BTC-USD"])
        : [];
    for (const c of closed || []) {
      let t = Number(c.closedTime || 0);
      if (t > 0 && t < 1e12) t *= 1000;
      if (!(t >= since)) continue;
      realized += Number(c.realizedPnl || 0);
      closeFills += 1;
    }

    try {
      ex.stop?.();
    } catch {
      /* ignore */
    }
    return {
      venue: "extended",
      ok: true,
      source: "official",
      volume: round(volume, 2),
      fees: round(fees, 4),
      realizedPnl: closeFills > 0 ? round(realized, 4) : null,
      fills,
      closeFills,
      feeMaker: 0,
      feeTaker: 0.00025,
      note:
        closeFills > 0
          ? "trades 量/费 + positions/history realisedPnl"
          : "trades 有量/费；今日无已平仓位",
      updatedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    return empty("extended", String(e?.message || e).slice(0, 120));
  }
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

async function fetchPhoenix(
  since: number,
  venue: "phoenix" | "phoenix2" = "phoenix"
): Promise<OfficialVenueDay> {
  try {
    const api = (
      (venue === "phoenix2"
        ? process.env.PHOENIX2_API_URL || process.env.PHOENIX_API_URL
        : process.env.PHOENIX_API_URL) || "https://perp-api.phoenix.trade"
    ).replace(/\/$/, "");
    let authority = (
      venue === "phoenix2"
        ? process.env.PHOENIX2_AUTHORITY || process.env.PHOENIX_AUTHORITY
        : process.env.PHOENIX_AUTHORITY
    )?.trim();
    if (!authority) {
      const keyPath =
        (venue === "phoenix2"
          ? process.env.PHOENIX2_KEYPAIR_PATH?.trim()
          : process.env.PHOENIX_KEYPAIR_PATH?.trim()) ||
        path.resolve(
          process.cwd(),
          "secrets",
          venue === "phoenix2" ? "phoenix2.key" : "phoenix.key"
        );
      const envKey =
        venue === "phoenix2"
          ? process.env.PHOENIX2_PRIVATE_KEY?.trim()
          : process.env.PHOENIX_PRIVATE_KEY?.trim();
      if (envKey || fs.existsSync(keyPath)) {
        const { Keypair } = await import("@solana/web3.js");
        const bs58 = (await import("bs58")).default;
        let secret: Uint8Array;
        if (envKey) {
          secret = envKey.startsWith("[")
            ? Uint8Array.from(JSON.parse(envKey))
            : bs58.decode(envKey);
        } else {
          const raw = fs.readFileSync(keyPath, "utf8").trim();
          secret = raw.startsWith("[")
            ? Uint8Array.from(JSON.parse(raw))
            : bs58.decode(raw);
        }
        authority = Keypair.fromSecretKey(secret).publicKey.toBase58();
      }
    }
    if (!authority) {
      return empty(
        venue,
        venue === "phoenix2"
          ? "无 PHOENIX2_AUTHORITY / secrets/phoenix2.key"
          : "无 PHOENIX_AUTHORITY / secrets/phoenix.key"
      );
    }

    let volume = 0;
    let fees = 0;
    let fills = 0;
    let realized = 0;
    let cursor: string | null = null;
    let pages = 0;
    do {
      const q = new URLSearchParams({ limit: "100" });
      if (cursor) q.set("cursor", cursor);
      const r = await fetch(
        `${api}/v1/trader/${authority}/trades-history?${q.toString()}`
      );
      if (!r.ok) {
        return empty(venue, `trades-history HTTP ${r.status}`);
      }
      const body = (await r.json()) as any;
      const rows: any[] = body?.data || [];
      for (const t of rows) {
        const rawTs = t.timestamp ?? t.t ?? t.createdAt ?? 0;
        let ts = typeof rawTs === "string" ? Date.parse(rawTs) : Number(rawTs);
        if (!(Number.isFinite(ts) && ts > 0)) continue;
        if (ts > 0 && ts < 1e12) ts *= 1000;
        if (!(ts >= since)) continue;
        const px = Math.abs(Number(t.price ?? 0));
        // Phoenix 历史里数量在 baseLotsDelta（已是币数量字符串，如 "0.0031"）
        const qty = Math.abs(
          Number(
            t.baseLotsDelta ?? t.size ?? t.qty ?? t.baseSize ?? t.base_lots_delta ?? 0
          )
        );
        const notional =
          t.notional != null && Number.isFinite(Number(t.notional))
            ? Math.abs(Number(t.notional))
            : px * qty;
        volume += Number.isFinite(notional) ? notional : 0;
        fees += Math.abs(Number(t.fee ?? t.fees ?? 0));
        realized += Number(t.realizedPnl ?? t.realized_pnl ?? 0);
        fills += 1;
      }
      const oldest = rows.reduce((m, t) => {
        const rawTs = t.timestamp ?? t.t ?? t.createdAt ?? 0;
        let ts = typeof rawTs === "string" ? Date.parse(rawTs) : Number(rawTs);
        if (ts > 0 && ts < 1e12) ts *= 1000;
        return ts > 0 && ts < m ? ts : m;
      }, Number.POSITIVE_INFINITY);
      cursor = body?.hasMore ? body?.nextCursor || null : null;
      pages += 1;
      if (!(oldest >= since)) break;
    } while (cursor && pages < 12);

    return {
      venue,
      ok: true,
      source: "official",
      volume: round(volume, 2),
      fees: round(fees, 4),
      realizedPnl: round(realized, 4),
      fills: fills > 0 ? fills : 0,
      closeFills: null,
      feeMaker: null,
      feeTaker: null,
      note: "trades-history（perp-api）",
      updatedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    return empty(venue, String(e?.message || e).slice(0, 120));
  }
}

async function fetchNado(since: number): Promise<OfficialVenueDay> {
  try {
    const { createNadoClient, CHAIN_ENV_TO_CHAIN } = await import("@nadohq/client");
    const { removeDecimals } = await import("@nadohq/shared");
    const { createPublicClient, createWalletClient, http } = await import("viem");
    const { privateKeyToAccount } = await import("viem/accounts");

    let owner = (process.env.NADO_ADDRESS || "").trim();
    let walletClient: any = undefined;
    const chain = CHAIN_ENV_TO_CHAIN.inkMainnet;
    const rpc =
      process.env.NADO_INK_RPC?.trim() ||
      chain.rpcUrls.default.http[0] ||
      "https://rpc-gel.inkonchain.com";
    const publicClient = createPublicClient({ chain, transport: http(rpc) });

    let rawKey = (process.env.NADO_PRIVATE_KEY || "").trim();
    if (!rawKey) {
      const keyPath =
        process.env.NADO_KEY_PATH?.trim() ||
        path.resolve(process.cwd(), "secrets", "nado.key");
      if (fs.existsSync(keyPath)) rawKey = fs.readFileSync(keyPath, "utf8").trim();
    }
    if (rawKey) {
      const pk = (rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as `0x${string}`;
      const account = privateKeyToAccount(pk);
      owner = owner || account.address;
      walletClient = createWalletClient({
        account,
        chain,
        transport: http(rpc),
      });
    }
    if (!owner) return empty("nado", "无 NADO_ADDRESS / secrets/nado.key");

    const client = createNadoClient("inkMainnet", {
      publicClient: publicClient as any,
      ...(walletClient ? { walletClient: walletClient as any } : {}),
    });
    const indexer = (client as any).context.indexerClient;
    const productId = Math.max(
      1,
      Number(process.env.NADO_BTC_PRODUCT_ID || 2) || 2
    );
    const subaccountName =
      (process.env.NADO_SUBACCOUNT || "default").trim() || "default";

    const hum = (v: unknown): number => {
      if (v == null) return 0;
      const n = Number(typeof (v as any)?.toString === "function" ? (v as any).toString() : v);
      if (!Number.isFinite(n)) return 0;
      if (Math.abs(n) >= 1e12) return Number(removeDecimals(n));
      return n;
    };

    let volume = 0;
    let fees = 0;
    let realized = 0;
    let fills = 0;
    let closeFills = 0;
    let cursor: string | undefined;
    let pages = 0;

    do {
      const res = await indexer.getPaginatedSubaccountMatchEvents({
        subaccountOwner: owner,
        subaccountName,
        productIds: [productId],
        limit: 100,
        startCursor: cursor,
      });
      const events: any[] = res?.events || [];
      for (const e of events) {
        const tsRaw = Number(e.timestamp?.toString?.() ?? e.timestamp);
        if (!(Number.isFinite(tsRaw) && tsRaw > 0)) continue;
        const tsMs = tsRaw > 1e12 ? tsRaw : tsRaw * 1000;
        if (!(tsMs >= since)) continue;
        const quote = Math.abs(hum(e.quoteFilled));
        volume += quote;
        fees += Math.abs(hum(e.totalFee));
        realized += hum(e.realizedPnl);
        fills += 1;
        if (Math.abs(hum(e.closedAmount)) > 0) closeFills += 1;
      }
      cursor = res?.meta?.hasMore ? res.meta.nextCursor : undefined;
      pages += 1;
      if (!events.length) break;
      const oldest = events.reduce((m, e) => {
        const t = Number(e.timestamp?.toString?.() ?? e.timestamp);
        const ms = t > 1e12 ? t : t * 1000;
        return ms > 0 && ms < m ? ms : m;
      }, Number.POSITIVE_INFINITY);
      if (!(oldest >= since)) break;
    } while (cursor && pages < 12);

    return {
      venue: "nado",
      ok: true,
      source: "official",
      volume: round(volume, 2),
      fees: round(fees, 4),
      realizedPnl: round(realized, 4),
      fills: fills > 0 ? fills : 0,
      closeFills: closeFills > 0 ? closeFills : 0,
      feeMaker: 0.0001,
      feeTaker: null,
      note: "indexer matches（quoteFilled+fee+realized_pnl）",
      updatedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    return empty("nado", String(e?.message || e).slice(0, 120));
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

async function fetchEntropy(since: number): Promise<OfficialVenueDay> {
  try {
    const { HttpTransport, InfoClient } = await import("@nktkas/hyperliquid");
    const { privateKeyToAccount } = await import("viem/accounts");
    const raw =
      process.env.ENTROPY_PRIVATE_KEY?.trim() ||
      process.env.HYPERLIQUID_PRIVATE_KEY?.trim() ||
      "";
    const file =
      process.env.ENTROPY_KEY_PATH?.trim() ||
      path.resolve(process.cwd(), "secrets", "entropy.key");
    const key = raw || (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
    if (!key) return empty("entropy", "无 ENTROPY_PRIVATE_KEY");
    const hex = (key.startsWith("0x") ? key : `0x${key}`) as `0x${string}`;
    const addr = privateKeyToAccount(hex).address;
    const info = new InfoClient({ transport: new HttpTransport() });
    const fills = (await (info as any).userFillsByTime?.({ user: addr, startTime: since })) ||
      (await info.userFills({ user: addr }));
    let volume = 0;
    let fees = 0;
    let n = 0;
    for (const t of fills || []) {
      const ts = Number(t.time || 0);
      if (ts && ts < since) continue;
      if (String(t.coin || "") !== "BTC") continue;
      volume += Math.abs(Number(t.px) * Number(t.sz));
      fees += Math.abs(Number(t.fee || 0));
      n += 1;
    }
    return {
      venue: "entropy",
      ok: true,
      source: "official",
      volume: round(volume, 2),
      fees: round(fees, 4),
      realizedPnl: null,
      fills: n,
      closeFills: null,
      feeMaker: 0.00015,
      feeTaker: 0.00045,
      note: "HL userFills BTC",
      updatedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    return empty("entropy", String(e?.message || e).slice(0, 120));
  }
}

async function fetchPacifica(since: number): Promise<OfficialVenueDay> {
  try {
    loadEnv();
    const { Keypair } = await import("@solana/web3.js");
    const bs58 = (await import("bs58")).default;
    const raw = process.env.PACIFICA_PRIVATE_KEY?.trim() || "";
    const file =
      process.env.PACIFICA_KEY_PATH?.trim() ||
      path.resolve(process.cwd(), "secrets", "pacifica.key");
    const text = raw || (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
    if (!text) return empty("pacifica", "无 PACIFICA_PRIVATE_KEY");
    const bytes = text.startsWith("[")
      ? Uint8Array.from(JSON.parse(text))
      : bs58.decode(text.replace(/\s/g, ""));
    const secret = bytes.length === 32 ? Keypair.fromSeed(bytes).secretKey : bytes;
    const account = Keypair.fromSecretKey(secret).publicKey.toBase58();
    const api = (process.env.PACIFICA_API_URL || "https://api.pacifica.fi/api/v1").replace(
      /\/$/,
      ""
    );
    let cursor = "";
    let volume = 0;
    let fees = 0;
    let pnl = 0;
    let n = 0;
    let closeN = 0;
    for (let page = 0; page < 5; page++) {
      const q = new URLSearchParams({
        account,
        symbol: "BTC",
        start_time: String(since),
        limit: "100",
      });
      if (cursor) q.set("cursor", cursor);
      const r = await fetch(`${api}/trades/history?${q}`, { headers: { Accept: "*/*" } });
      const j: any = await r.json();
      if (!r.ok || j?.success === false) {
        return empty("pacifica", String(j?.error || r.status).slice(0, 120));
      }
      for (const t of j?.data || []) {
        const ts = Number(t.created_at || 0);
        if (ts && ts < since) continue;
        volume += Math.abs(Number(t.price) * Number(t.amount));
        fees += Math.abs(Number(t.fee || 0));
        const p = Number(t.pnl);
        if (Number.isFinite(p)) pnl += p;
        n += 1;
        if (/^close_/i.test(String(t.side || ""))) closeN += 1;
      }
      if (!j?.has_more || !j?.next_cursor) break;
      cursor = String(j.next_cursor);
    }
    return {
      venue: "pacifica",
      ok: true,
      source: "official",
      volume: round(volume, 2),
      fees: round(fees, 4),
      realizedPnl: round(pnl, 4),
      fills: n,
      closeFills: closeN,
      feeMaker: 0.00015,
      feeTaker: 0.0004,
      note: "trades/history BTC",
      updatedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    return empty("pacifica", String(e?.message || e).slice(0, 120));
  }
}

async function fetchLighter(since: number): Promise<OfficialVenueDay> {
  try {
    loadEnv();
    const authPath = path.resolve(process.cwd(), "data", "lighter-auth.json");
    if (!fs.existsSync(authPath)) return empty("lighter", "等网格连上后拉成交");
    const authJ = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const token = String(authJ?.token || "");
    const acc = Number(authJ?.accountIndex || process.env.LIGHTER_ACCOUNT_INDEX || 0);
    if (!token || !acc) return empty("lighter", "无 auth");
    const api = (process.env.LIGHTER_API_URL || "https://api.rh.lighter.xyz").replace(/\/$/, "");
    let cursor = "";
    let volume = 0;
    let fees = 0;
    let pnl = 0;
    let n = 0;
    for (let page = 0; page < 8; page++) {
      const q = new URLSearchParams({
        sort_by: "timestamp",
        limit: "100",
        account_index: String(acc),
        market_id: "1",
        sort_dir: "desc",
      });
      if (cursor) q.set("cursor", cursor);
      const r = await fetch(`${api}/api/v1/trades?${q}`, {
        headers: { Accept: "*/*", Authorization: token },
      });
      const j: any = await r.json();
      if (!r.ok || (j?.code && j.code !== 200)) {
        return empty("lighter", String(j?.message || r.status).slice(0, 120));
      }
      let stop = false;
      for (const t of j?.trades || []) {
        const ts = Number(t.timestamp || t.time || 0);
        if (ts && ts < since) {
          stop = true;
          break;
        }
        const px = Number(t.price || 0);
        const sz = Number(t.size || t.base_amount || 0);
        volume += Math.abs(px * sz);
        fees += Math.abs(Number(t.fee || t.usdc_fee || 0));
        const p = Number(t.pnl ?? t.realized_pnl);
        if (Number.isFinite(p)) pnl += p;
        n += 1;
      }
      if (stop || !j?.next_cursor) break;
      cursor = String(j.next_cursor);
    }
    return {
      venue: "lighter",
      ok: true,
      source: "official",
      volume: round(volume, 2),
      fees: round(fees, 4),
      realizedPnl: round(pnl, 4),
      fills: n,
      closeFills: null,
      feeMaker: 0,
      feeTaker: 0,
      note: "RH trades BTC",
      updatedAt: new Date().toISOString(),
    };
  } catch (e: any) {
    return empty("lighter", String(e?.message || e).slice(0, 120));
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
    const [extended, risex, decibel, n1, phoenix, phoenix2, nado, popdex, entropy, pacifica, lighter] =
      await Promise.all([
        fetchExtended(since),
        fetchRisex(since),
        fetchDecibel(since),
        fetchN1(since),
        fetchPhoenix(since, "phoenix"),
        fetchPhoenix(since, "phoenix2"),
        fetchNado(since),
        fetchPopdex(since),
        fetchEntropy(since),
        fetchPacifica(since),
        fetchLighter(since),
      ]);
    cache = {
      dayKey,
      dayStartMs: since,
      venues: {
        extended: keepOrFresh(dayKey, extended, prev),
        risex: keepOrFresh(dayKey, risex, prev),
        decibel: keepOrFresh(dayKey, decibel, prev),
        n1: keepOrFresh(dayKey, n1, prev),
        phoenix: keepOrFresh(dayKey, phoenix, prev),
        phoenix2: keepOrFresh(dayKey, phoenix2, prev),
        nado: keepOrFresh(dayKey, nado, prev),
        popdex: keepOrFresh(dayKey, popdex, prev),
        entropy: keepOrFresh(dayKey, entropy, prev),
        pacifica: keepOrFresh(dayKey, pacifica, prev),
        lighter: keepOrFresh(dayKey, lighter, prev),
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
