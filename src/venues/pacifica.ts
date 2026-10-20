/**
 * Pacifica = Solana 永续（https://app.pacifica.fi/）。REST + Ed25519 签名。
 * 必须全仓。网格限价用 ALO（post-only）；硬止损挂所上 stop。
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import type { Intent, VenueSnapshot } from "../types.js";
import { loadEnv } from "../loadEnv.js";
import { dryApply, type ApplyResult, type HardStopSpec, type VenueExecutor } from "./types.js";

const SYMBOL = "BTC";
const DEFAULT_API = "https://api.pacifica.fi/api/v1";

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value && typeof value === "object") {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(value as object).sort()) {
      const v = (value as Record<string, unknown>)[k];
      if (v === undefined) continue;
      o[k] = sortJson(v);
    }
    return o;
  }
  return value;
}

function signEd25519(message: Uint8Array, secret64: Uint8Array): Uint8Array {
  const seed = secret64.slice(0, 32);
  const der = Buffer.concat([
    Buffer.from("302e020100300506032b657004220420", "hex"),
    Buffer.from(seed),
  ]);
  const key = crypto.createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  return crypto.sign(null, message, key);
}

function loadSecret(): Uint8Array {
  loadEnv();
  const raw = process.env.PACIFICA_PRIVATE_KEY?.trim() || "";
  const file =
    process.env.PACIFICA_KEY_PATH?.trim() ||
    path.resolve(process.cwd(), "secrets", "pacifica.key");
  const text = raw || (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
  if (!text) throw new Error("缺少 PACIFICA_PRIVATE_KEY（或 secrets/pacifica.key）");
  const bytes = text.startsWith("[")
    ? Uint8Array.from(JSON.parse(text))
    : bs58.decode(text.replace(/\s/g, ""));
  if (bytes.length === 64) return bytes;
  if (bytes.length === 32) return Keypair.fromSeed(bytes).secretKey;
  throw new Error(`Pacifica 私钥长度 ${bytes.length}，需要 32 或 64 字节`);
}

export class PacificaExecutor implements VenueExecutor {
  readonly id = "pacifica" as const;
  private api = DEFAULT_API;
  private kp: Keypair | null = null;
  private account = "";
  private tickSize = 1;
  private lotSize = 0.00001;
  private stopIds: { up?: string; dn?: string; upPx?: number; dnPx?: number } = {};

  constructor(private dryRun: boolean) {}

  async connect(): Promise<void> {
    loadEnv();
    this.api = (process.env.PACIFICA_API_URL || DEFAULT_API).replace(/\/$/, "");
    const info = await this.getJson("/info");
    const mkt = (info?.data || []).find((x: any) => String(x.symbol) === SYMBOL);
    if (mkt) {
      this.tickSize = num(mkt.tick_size, 1) || 1;
      this.lotSize = num(mkt.lot_size, 0.00001) || 0.00001;
    }
    if (this.dryRun) {
      console.log(`[pacifica] dry-run api=${this.api} tick=${this.tickSize} lot=${this.lotSize}`);
      return;
    }
    this.kp = Keypair.fromSecretKey(loadSecret());
    this.account = this.kp.publicKey.toBase58();
    if (process.env.GRID_SKIP_LEVERAGE !== "1") {
      const lev = Math.max(1, Math.min(50, Number(process.env.PACIFICA_LEVERAGE || 30) || 30));
      try {
        await this.signedPost("/account/margin", "update_margin_mode", {
          symbol: SYMBOL,
          is_isolated: false,
        });
      } catch (e: any) {
        console.warn(`[pacifica] margin cross skipped: ${String(e?.message || e).slice(0, 120)}`);
      }
      try {
        await this.signedPost("/account/leverage", "update_leverage", {
          symbol: SYMBOL,
          leverage: lev,
        });
      } catch (e: any) {
        console.warn(`[pacifica] leverage skipped: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
    console.log(`[pacifica] account=${this.account} cross=true`);
  }

  disconnect(): void {
    this.kp = null;
    this.account = "";
  }

  private fmtPx(px: number): string {
    const t = this.tickSize > 0 ? this.tickSize : 1;
    const n = Math.round(px / t) * t;
    if (t >= 1) return String(Math.round(n));
    const dec = Math.max(0, Math.round(-Math.log10(t)));
    return n.toFixed(dec);
  }

  private fmtSz(sz: number): string {
    const lot = this.lotSize > 0 ? this.lotSize : 0.00001;
    const n = Math.floor(Math.abs(sz) / lot) * lot;
    const dec = Math.max(0, Math.round(-Math.log10(lot)));
    return n.toFixed(dec);
  }

  private async getJson(pathName: string, query?: Record<string, string>): Promise<any> {
    const q = query ? "?" + new URLSearchParams(query).toString() : "";
    const r = await fetch(`${this.api}${pathName}${q}`, { headers: { Accept: "*/*" } });
    const text = await r.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`pacifica GET ${pathName} 非 JSON ${r.status}`);
    }
    if (!r.ok) {
      throw new Error(
        `pacifica GET ${pathName} HTTP ${r.status} ${String(body?.error || text).slice(0, 160)}`
      );
    }
    return body;
  }

  private signedBody(type: string, data: Record<string, unknown>): Record<string, unknown> {
    if (!this.kp) throw new Error("Pacifica 未 connect");
    const timestamp = Date.now();
    const expiry_window = 30_000;
    const signObj = sortJson({
      timestamp,
      expiry_window,
      type,
      data,
    });
    const compact = JSON.stringify(signObj);
    const sig = signEd25519(Buffer.from(compact, "utf8"), this.kp.secretKey);
    return {
      account: this.account,
      signature: bs58.encode(sig),
      timestamp,
      expiry_window,
      ...data,
    };
  }

  private async signedPost(
    pathName: string,
    type: string,
    data: Record<string, unknown>
  ): Promise<any> {
    if (process.env.PACIFICA_TRADING_ARMED !== "YES" && type !== "update_leverage" && type !== "update_margin_mode") {
      throw new Error("Pacifica trading not armed：设 PACIFICA_TRADING_ARMED=YES");
    }
    const payload = this.signedBody(type, data);
    const r = await fetch(`${this.api}${pathName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "*/*" },
      body: JSON.stringify(payload),
    });
    const text = await r.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`pacifica POST ${pathName} 非 JSON ${r.status} ${text.slice(0, 80)}`);
    }
    if (!r.ok || body?.success === false) {
      throw new Error(
        String(body?.error || body?.message || text || `HTTP ${r.status}`).slice(0, 200)
      );
    }
    return body;
  }

  async snapshot(market: string): Promise<VenueSnapshot> {
    const prices = await this.getJson("/info/prices");
    const row = (prices?.data || []).find((x: any) => String(x.symbol) === SYMBOL);
    const mid = num(row?.mid ?? row?.mark);
    if (this.dryRun || !this.account) {
      return { venue: this.id, market, mid: mid || 100_000, position: 0, openOrders: [] };
    }
    const [posBody, ordBody, accBody] = await Promise.all([
      this.getJson("/positions", { account: this.account }),
      this.getJson("/orders", { account: this.account }),
      this.getJson("/account", { account: this.account }),
    ]);
    const posRow = (posBody?.data || []).find((p: any) => String(p.symbol) === SYMBOL);
    const amt = num(posRow?.amount);
    const side = String(posRow?.side || "");
    const position = side === "ask" ? -Math.abs(amt) : side === "bid" ? Math.abs(amt) : 0;
    const entry = num(posRow?.entry_price);
    let unrealizedPnl: number | undefined;
    if (position !== 0 && entry > 0 && mid > 0) {
      unrealizedPnl = position * (mid - entry);
    }
    const liq = num(posRow?.liquidation_price, NaN);
    const equity = num(accBody?.data?.account_equity ?? accBody?.data?.balance, NaN);
    const orders = (ordBody?.data || [])
      .filter((o: any) => String(o.symbol) === SYMBOL)
      .filter((o: any) => !/stop|take_profit/i.test(String(o.order_type || "limit")))
      .map((o: any) => {
        const init = num(o.initial_amount);
        const filled = num(o.filled_amount);
        const cancelled = num(o.cancelled_amount);
        return {
          id: String(o.order_id),
          market,
          side: (o.side === "bid" ? "buy" : "sell") as "buy" | "sell",
          price: num(o.price),
          size: Math.max(0, init - filled - cancelled) || init,
          level: 0,
        };
      })
      .filter((o: { size: number }) => o.size > 0);
    return {
      venue: this.id,
      market,
      mid,
      position,
      openOrders: orders,
      equityUsd: Number.isFinite(equity) && equity > 0 ? equity : undefined,
      unrealizedPnl,
      liquidationPrice: Number.isFinite(liq) && liq > 0 ? liq : undefined,
    };
  }

  async apply(intents: Intent[]): Promise<ApplyResult> {
    if (this.dryRun) return dryApply(this.id, intents);
    const result: ApplyResult = { placed: 0, cancelled: 0, failed: 0, errors: [] };
    const gap = Math.max(50, Number(process.env.PACIFICA_ORDER_GAP_MS || 200) || 200);
    for (const intent of intents) {
      try {
        if (intent.type === "cancel") {
          await this.signedPost("/orders/cancel", "cancel_order", {
            symbol: SYMBOL,
            order_id: Number(intent.orderId),
          });
          result.cancelled += 1;
        } else {
          await this.signedPost("/orders/create", "create_order", {
            symbol: SYMBOL,
            price: this.fmtPx(intent.order.price),
            amount: this.fmtSz(intent.order.size),
            side: intent.order.side === "buy" ? "bid" : "ask",
            tif: "ALO",
            reduce_only: false,
            client_order_id: crypto.randomUUID(),
          });
          result.placed += 1;
        }
        await sleep(gap);
      } catch (e: any) {
        result.failed += 1;
        result.errors.push(String(e?.message || e).slice(0, 200));
      }
    }
    return result;
  }

  async cancelAll(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[pacifica:dry] cancelAll ${market}`);
      return;
    }
    await this.signedPost("/orders/cancel_all", "cancel_all_orders", {
      all_symbols: false,
      exclude_reduce_only: false,
      symbol: SYMBOL,
    });
    await this.cancelHardStops(market);
  }

  async closePosition(market: string, sizeBase?: number | null): Promise<void> {
    if (this.dryRun) {
      console.log(`[pacifica:dry] closePosition ${market}${sizeBase != null ? ` size=${sizeBase}` : ""}`);
      return;
    }
    const snap = await this.snapshot(market);
    const pos = Number(snap.position) || 0;
    if (Math.abs(pos) < 1e-12) return;
    const cut =
      sizeBase != null && sizeBase > 0 ? Math.min(Math.abs(sizeBase), Math.abs(pos)) : Math.abs(pos);
    await this.signedPost("/orders/create_market", "create_market_order", {
      symbol: SYMBOL,
      amount: this.fmtSz(cut),
      side: pos < 0 ? "bid" : "ask",
      slippage_percent: "0.8",
      reduce_only: true,
      client_order_id: crypto.randomUUID(),
    });
  }

  async syncHardStops(spec: HardStopSpec): Promise<{ armed: boolean; note?: string }> {
    if (this.dryRun) return { armed: true, note: "dry" };
    const snap = await this.snapshot(spec.market);
    const pos = Number(snap.position) || 0;
    if (Math.abs(pos) < 1e-12) {
      await this.cancelHardStops(spec.market);
      return { armed: false, note: "flat" };
    }
    const activeId = pos > 0 ? this.stopIds.dn : this.stopIds.up;
    const activePx = pos > 0 ? this.stopIds.dnPx : this.stopIds.upPx;
    const targetPx = pos > 0 ? spec.hardDn : spec.hardUp;
    const drift =
      activeId &&
      activePx &&
      Math.abs(activePx - targetPx) / targetPx < 0.002;
    if (drift) {
      return { armed: true, note: "kept" };
    }
    await this.cancelHardStops(spec.market);
    const minSz = Math.max(
      Number(this.lotSize) || 0.00001,
      10 / Math.max(Number(snap.mid) || 1, 1)
    );
    const cover = Math.max(Math.abs(pos), minSz);
    const place = async (side: "bid" | "ask", trigger: number) => {
      const r = await this.signedPost("/orders/stop/create", "create_stop_order", {
        symbol: SYMBOL,
        side,
        reduce_only: true,
        stop_order: {
          stop_price: this.fmtPx(trigger),
          trigger_price_type: "mark_price",
          amount: this.fmtSz(cover),
        },
      });
      const id = r?.order_id ?? r?.data?.order_id;
      return id != null ? String(id) : undefined;
    };
    if (pos > 0) {
      this.stopIds.dn = await place("ask", spec.hardDn);
      this.stopIds.dnPx = spec.hardDn;
      return { armed: !!this.stopIds.dn, note: "armed-long" };
    }
    this.stopIds.up = await place("bid", spec.hardUp);
    this.stopIds.upPx = spec.hardUp;
    return { armed: !!this.stopIds.up, note: "armed-short" };
  }

  async cancelHardStops(_market: string): Promise<void> {
    if (this.dryRun || !this.account) {
      this.stopIds = {};
      return;
    }
    const ids = new Set<string>();
    for (const id of [this.stopIds.up, this.stopIds.dn]) {
      if (id) ids.add(id);
    }
    try {
      const body = await this.getJson("/orders", { account: this.account });
      for (const o of body?.data || []) {
        if (String(o.symbol) !== SYMBOL) continue;
        if (!/stop|take_profit/i.test(String(o.order_type || ""))) continue;
        if (o.order_id != null) ids.add(String(o.order_id));
      }
    } catch {
      /* 只撤已知 id */
    }
    for (const id of ids) {
      try {
        await this.signedPost("/orders/stop/cancel", "cancel_stop_order", {
          symbol: SYMBOL,
          order_id: Number(id),
        });
      } catch {
        /* ignore */
      }
    }
    this.stopIds = {};
  }
}
