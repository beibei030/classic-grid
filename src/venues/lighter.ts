/**
 * Lighter RH（Robinhood Chain，https://robinhoodchain.lighter.xyz/）。
 * Node 只做 REST 读；下单经 Python lighter-sdk sidecar（sendTxBatch + POST_ONLY）。
 * 必须全仓 30x。空仓不挂 reduce-only 硬止。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ProxyAgent, fetch as proxyFetch } from "undici";
import type { Intent, VenueSnapshot } from "../types.js";
import { loadEnv } from "../loadEnv.js";
import { dryApply, type ApplyResult, type HardStopSpec, type VenueExecutor } from "./types.js";

const DEFAULT_API = "https://api.rh.lighter.xyz";
const MARKET = 1;
const PX_DEC = 1;
const SZ_DEC = 5;
const MIN_BASE = 0.0002;
const MIN_QUOTE = 10;
const OID_FILE = () => path.resolve(process.cwd(), "data", "lighter-oid.json");
const AUTH_FILE = () => path.resolve(process.cwd(), "data", "lighter-auth.json");

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pythonBin(): string {
  return process.env.LIGHTER_PYTHON || process.env.PYTHON || "python";
}

function signerPath(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "lighterSigner.py");
}

function loadOid(): number {
  try {
    const j = JSON.parse(fs.readFileSync(OID_FILE(), "utf8"));
    const n = Number(j?.next);
    if (Number.isFinite(n) && n >= 5_000_000) return Math.floor(n);
  } catch {
    /* first run */
  }
  return 5_000_000;
}

function saveOid(n: number): void {
  try {
    fs.mkdirSync(path.dirname(OID_FILE()), { recursive: true });
    fs.writeFileSync(OID_FILE(), JSON.stringify({ next: n }, null, 2));
  } catch {
    /* ignore */
  }
}

function saveAuth(token: string, accountIndex: number): void {
  try {
    fs.mkdirSync(path.dirname(AUTH_FILE()), { recursive: true });
    fs.writeFileSync(
      AUTH_FILE(),
      JSON.stringify({ token, accountIndex, until: Date.now() + 45 * 60_000 }, null, 2)
    );
  } catch {
    /* ignore */
  }
}

export class LighterExecutor implements VenueExecutor {
  readonly id = "lighter" as const;
  private api = DEFAULT_API;
  private accountIndex = 0;
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextOid = 5_000_000;
  private pxDec = PX_DEC;
  private szDec = SZ_DEC;
  private minBase = MIN_BASE;
  private stopPx: { up?: number; dn?: number } = {};
  private proxyAgent: ProxyAgent | undefined;

  constructor(private dryRun: boolean) {}

  private allocOid(): number {
    this.nextOid += 1;
    if (this.nextOid >= 2 ** 48 - 1000) this.nextOid = 5_000_000;
    saveOid(this.nextOid);
    return this.nextOid;
  }

  private toPxI(px: number): number {
    const f = 10 ** this.pxDec;
    return Math.max(1, Math.round(px * f));
  }

  private toSzI(sz: number, px: number): number {
    const step = 10 ** -this.szDec;
    let n = Math.floor(Math.abs(sz) / step) * step;
    if (n < this.minBase) n = this.minBase;
    if (px > 0 && n * px < MIN_QUOTE) {
      n = Math.ceil(MIN_QUOTE / px / step) * step;
    }
    return Math.max(1, Math.round(n * 10 ** this.szDec));
  }

  private fromPxI(v: number): number {
    return v / 10 ** this.pxDec;
  }

  async connect(): Promise<void> {
    loadEnv();
    this.api = (process.env.LIGHTER_API_URL || DEFAULT_API).replace(/\/$/, "");
    const proxy = (process.env.LIGHTER_PROXY || "").trim();
    this.proxyAgent = proxy ? new ProxyAgent(proxy) : undefined;
    this.nextOid = loadOid();
    try {
      const books = await this.getJson("/api/v1/orderBookDetails");
      const btc = (books?.order_book_details || []).find((x: any) => String(x.symbol) === "BTC");
      if (btc) {
        this.pxDec = num(btc.supported_price_decimals ?? btc.price_decimals, PX_DEC) || PX_DEC;
        this.szDec = num(btc.supported_size_decimals ?? btc.size_decimals, SZ_DEC) || SZ_DEC;
        this.minBase = num(btc.min_base_amount, MIN_BASE) || MIN_BASE;
      }
    } catch {
      /* 用默认刻度 */
    }
    if (this.dryRun) {
      console.log(`[lighter] dry-run api=${this.api} pxDec=${this.pxDec} szDec=${this.szDec}`);
      return;
    }
    await this.startChild();
    const ping = await this.rpc("ping");
    this.accountIndex = num(ping.account_index);
    if (process.env.GRID_SKIP_LEVERAGE !== "1") {
      const lev = Math.max(1, Math.min(50, Number(process.env.LIGHTER_LEVERAGE || 30) || 30));
      try {
        await this.rpc("leverage", { lev });
      } catch (e: any) {
        console.warn(`[lighter] leverage skipped: ${String(e?.message || e).slice(0, 120)}`);
      }
    }
    console.log(`[lighter] account=${this.accountIndex} cross=true`);
  }

  disconnect(): void {
    for (const [, p] of this.pending) p.reject(new Error("lighter sidecar closed"));
    this.pending.clear();
    if (this.child) {
      try {
        this.child.stdin.end();
      } catch {
        /* ignore */
      }
      try {
        this.child.kill();
      } catch {
        /* ignore */
      }
    }
    this.child = null;
  }

  private startChild(): Promise<void> {
    if (this.child) return Promise.resolve();
    const py = pythonBin();
    const script = signerPath();
    if (!fs.existsSync(script)) throw new Error(`缺少 ${script}`);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("lighter sidecar 启动超时")), 20_000);
      const prev = this.onMessage;
      this.onMessage = (msg) => {
        if (msg?.ready) {
          clearTimeout(t);
          this.accountIndex = num(msg.account_index);
          this.onMessage = prev;
          resolve();
          return;
        }
        if (msg?.ok === false && (msg.id === 0 || msg.id == null)) {
          clearTimeout(t);
          this.onMessage = prev;
          reject(new Error(String(msg.error || "sidecar init fail")));
          return;
        }
        prev.call(this, msg);
      };
      const child = spawn(py, ["-u", script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          LIGHTER_CWD: process.cwd(),
          PYTHONIOENCODING: "utf-8",
        },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      this.child = child;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
      child.stderr.on("data", (chunk: string) => {
        const s = String(chunk).trim();
        if (s) console.warn(`[lighter:py] ${s.slice(0, 240)}`);
      });
      child.on("exit", (code) => {
        const err = new Error(`lighter sidecar exit ${code}`);
        for (const [, p] of this.pending) p.reject(err);
        this.pending.clear();
        this.child = null;
        if (!this.accountIndex) {
          clearTimeout(t);
          this.onMessage = prev;
          reject(err);
        }
      });
    });
  }

  private onMessage = (msg: any): void => {
    if (msg?.ready && this.accountIndex === 0) {
      this.accountIndex = num(msg.account_index);
    }
    const id = Number(msg?.id);
    if (!Number.isFinite(id) || id === 0) return;
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    if (msg.ok) p.resolve(msg);
    else p.reject(new Error(String(msg.error || "lighter rpc fail")));
  };

  private onStdout(chunk: string): void {
    this.buf += chunk;
    let i = this.buf.indexOf("\n");
    while (i >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) {
        try {
          this.onMessage(JSON.parse(line));
        } catch {
          console.warn(`[lighter] bad sidecar line ${line.slice(0, 120)}`);
        }
      }
      i = this.buf.indexOf("\n");
    }
  }

  private async rpc(op: string, extra: Record<string, unknown> = {}): Promise<any> {
    if (!this.child) await this.startChild();
    const id = this.nextId++;
    const payload = JSON.stringify({ id, op, ...extra }) + "\n";
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`lighter ${op} timeout`));
      }, 45_000);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(t);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      });
      this.child!.stdin.write(payload, (err) => {
        if (err) {
          clearTimeout(t);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private async getJson(pathName: string, query?: Record<string, string>): Promise<any> {
    const q = query ? "?" + new URLSearchParams(query).toString() : "";
    const r = await proxyFetch(`${this.api}${pathName}${q}`, {
      headers: { Accept: "*/*" },
      ...(this.proxyAgent ? { dispatcher: this.proxyAgent } : {}),
    });
    const text = await r.text();
    let body: any = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(`lighter GET ${pathName} 非 JSON ${r.status}`);
    }
    if (!r.ok || (body?.code && body.code !== 200)) {
      throw new Error(
        `lighter GET ${pathName} ${body?.message || body?.code || r.status}`.slice(0, 160)
      );
    }
    return body;
  }

  async snapshot(market: string): Promise<VenueSnapshot> {
    const books = await this.getJson("/api/v1/orderBookDetails");
    const btc = (books?.order_book_details || []).find((x: any) => String(x.symbol) === "BTC");
    const mid = num(btc?.mark_price ?? btc?.last_trade_price);
    const accIdx = this.accountIndex || Number(process.env.LIGHTER_ACCOUNT_INDEX || 0);
    if (this.dryRun || !accIdx) {
      return { venue: this.id, market, mid: mid || 100_000, position: 0, openOrders: [] };
    }
    const acct = await this.getJson("/api/v1/account", { by: "index", value: String(accIdx) });
    const a = acct?.accounts?.[0] || {};
    const posRow = (a.positions || []).find((p: any) => Number(p.market_id) === MARKET);
    const rawPos = num(posRow?.position);
    const sign = num(posRow?.sign, 1);
    const position = rawPos === 0 ? 0 : sign < 0 ? -Math.abs(rawPos) : Math.abs(rawPos);
    const equity = num(a.collateral ?? a.available_balance ?? a.total_asset_value, NaN);
    const upnl = num(posRow?.unrealized_pnl, NaN);
    const liq = num(posRow?.liquidation_price, NaN);
    let openOrders: VenueSnapshot["openOrders"] = [];
    try {
      const o = await this.rpc("orders");
      if (o.auth) saveAuth(String(o.auth), accIdx);
      openOrders = (o.orders || []).map((x: any) => {
        let px = num(x.price);
        if (px > 200_000) px = this.fromPxI(px);
        let sz = num(x.size);
        if (sz >= 1 && Number.isInteger(sz)) sz = sz / 10 ** this.szDec;
        return {
          id: String(x.id),
          market,
          side: x.side === "sell" ? "sell" : "buy",
          price: px,
          size: sz,
          level: 0,
        };
      });
    } catch (e: any) {
      console.warn(`[lighter] orders: ${String(e?.message || e).slice(0, 120)}`);
    }
    return {
      venue: this.id,
      market,
      mid,
      position,
      openOrders,
      equityUsd: Number.isFinite(equity) && equity > 0 ? equity : undefined,
      unrealizedPnl: Number.isFinite(upnl) ? upnl : undefined,
      liquidationPrice: Number.isFinite(liq) && liq > 0 ? liq : undefined,
    };
  }

  async apply(intents: Intent[]): Promise<ApplyResult> {
    if (this.dryRun) return dryApply(this.id, intents);
    const result: ApplyResult = { placed: 0, cancelled: 0, failed: 0, errors: [] };
    const cancels = intents.filter((i) => i.type === "cancel").map((i) => Number(i.orderId));
    if (cancels.length) {
      const r = await this.rpc("cancel_batch", { oids: cancels.filter((n) => Number.isFinite(n)) });
      result.cancelled += num(r.cancelled);
      result.failed += num(r.failed);
      for (const e of r.errors || []) result.errors.push(String(e).slice(0, 200));
    }
    const places = intents.filter((i) => i.type === "place");
    if (places.length) {
      const orders = places.map((i) => {
        const px = i.order.price;
        return {
          cid: this.allocOid(),
          px_i: this.toPxI(px),
          sz_i: this.toSzI(i.order.size, px),
          is_ask: i.order.side === "sell",
          reduce_only: false,
        };
      });
      const r = await this.rpc("place_batch", { orders });
      result.placed += num(r.placed);
      result.failed += num(r.failed);
      for (const e of r.errors || []) result.errors.push(String(e).slice(0, 200));
    }
    return result;
  }

  async cancelAll(market: string): Promise<void> {
    if (this.dryRun) {
      console.log(`[lighter:dry] cancelAll ${market}`);
      return;
    }
    await this.rpc("cancel_all");
  }

  async closePosition(market: string, sizeBase?: number | null): Promise<void> {
    if (this.dryRun) {
      console.log(`[lighter:dry] closePosition ${market}${sizeBase != null ? ` size=${sizeBase}` : ""}`);
      return;
    }
    const snap = await this.snapshot(market);
    const pos = Number(snap.position) || 0;
    if (Math.abs(pos) < 1e-12) return;
    const cut =
      sizeBase != null && sizeBase > 0 ? Math.min(Math.abs(sizeBase), Math.abs(pos)) : Math.abs(pos);
    const mid = snap.mid || 1;
    const isAsk = pos > 0;
    const px = isAsk ? mid * 0.99 : mid * 1.01;
    await this.rpc("close", {
      sz_i: this.toSzI(cut, px),
      px_i: this.toPxI(px),
      is_ask: isAsk,
      cid: this.allocOid(),
    });
  }

  async syncHardStops(spec: HardStopSpec): Promise<{ armed: boolean; note?: string }> {
    if (this.dryRun) return { armed: true, note: "dry" };
    const snap = await this.snapshot(spec.market);
    if (Math.abs(Number(snap.position) || 0) < 1e-12) {
      this.stopPx = {};
      return { armed: false, note: "flat" };
    }
    if (
      this.stopPx.up &&
      this.stopPx.dn &&
      Math.abs(this.stopPx.up - spec.hardUp) / spec.hardUp < 0.002 &&
      Math.abs(this.stopPx.dn - spec.hardDn) / spec.hardDn < 0.002
    ) {
      return { armed: true, note: "kept" };
    }
    const cover = Math.max(Math.abs(Number(snap.position) || 0), this.minBase);
    const orders = [
      {
        cid: this.allocOid(),
        px_i: this.toPxI(spec.hardUp * 1.01),
        sz_i: this.toSzI(cover, spec.hardUp),
        is_ask: false,
        reduce_only: true,
        order_type: 2,
        tif: 0,
        trigger_px_i: this.toPxI(spec.hardUp),
      },
      {
        cid: this.allocOid(),
        px_i: this.toPxI(spec.hardDn * 0.99),
        sz_i: this.toSzI(cover, spec.hardDn),
        is_ask: true,
        reduce_only: true,
        order_type: 2,
        tif: 0,
        trigger_px_i: this.toPxI(spec.hardDn),
      },
    ];
    const r = await this.rpc("place_batch", { orders });
    const ok = num(r.placed) >= 2;
    if (ok) this.stopPx = { up: spec.hardUp, dn: spec.hardDn };
    return { armed: ok, note: ok ? "armed" : String((r.errors || [])[0] || "partial") };
  }

  async cancelHardStops(_market: string): Promise<void> {
    /* pending 止损随 cancel_all 或下次空仓跳过；不单独扫 */
  }
}
