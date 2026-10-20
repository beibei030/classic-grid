/**
 * Entropy = Hyperliquid 前端（https://entropy.io）。下单走 HL API，看板标 Entropy。
 * 必须全仓（isCross=true）。原生止损用 trigger stop-market。
 */
import { ExchangeClient, HttpTransport, InfoClient } from "@nktkas/hyperliquid";
import fs from "node:fs";
import path from "node:path";
import { privateKeyToAccount } from "viem/accounts";
import type { Intent, VenueSnapshot } from "../types.js";
import { loadEnv } from "../loadEnv.js";
import { dryApply, type ApplyResult, type HardStopSpec, type VenueExecutor } from "./types.js";

const COIN = "BTC";

function loadKey(): `0x${string}` {
  loadEnv();
  const raw =
    process.env.ENTROPY_PRIVATE_KEY?.trim() ||
    process.env.HYPERLIQUID_PRIVATE_KEY?.trim() ||
    "";
  const file =
    process.env.ENTROPY_KEY_PATH?.trim() ||
    path.resolve(process.cwd(), "secrets", "entropy.key");
  const fromFile = raw || (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "");
  if (!fromFile) throw new Error("缺少 ENTROPY_PRIVATE_KEY（或 secrets/entropy.key）");
  const hex = fromFile.startsWith("0x") ? fromFile : `0x${fromFile}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) throw new Error("ENTROPY_PRIVATE_KEY 不是 32 字节 hex");
  return hex as `0x${string}`;
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export class EntropyExecutor implements VenueExecutor {
  readonly id = "entropy" as const;
  private info: InfoClient | null = null;
  private ex: ExchangeClient | null = null;
  private address = "";
  private asset = 0;
  private szDecimals = 5;
  private stopOids: { up?: number; dn?: number; upPx?: number; dnPx?: number } = {};

  constructor(private dryRun: boolean) {}

  async connect(): Promise<void> {
    const transport = new HttpTransport();
    this.info = new InfoClient({ transport });
    const meta = await this.info.meta();
    const i = meta.universe.findIndex((u: any) => String(u.name || u.coin) === COIN);
    if (i < 0) throw new Error("Entropy/HL meta 无 BTC");
    this.asset = i;
    this.szDecimals = Number(meta.universe[i]?.szDecimals ?? 5);

    if (this.dryRun) {
      console.log(`[entropy] dry-run asset=${this.asset} szDecimals=${this.szDecimals}`);
      return;
    }
    const account = privateKeyToAccount(loadKey());
    this.address = account.address;
    this.ex = new ExchangeClient({ transport, wallet: account });
    if (process.env.GRID_SKIP_LEVERAGE !== "1") {
      const lev = Math.max(1, Number(process.env.ENTROPY_LEVERAGE || 30) || 30);
      try {
        await this.ex.updateLeverage({ asset: this.asset, isCross: true, leverage: lev });
      } catch (e: any) {
        console.warn(`[entropy] updateLeverage skipped: ${String(e?.message || e).slice(0, 160)}`);
      }
    }
    console.log(`[entropy] address=${this.address} asset=${this.asset} cross=true`);
  }

  disconnect(): void {
    this.info = null;
    this.ex = null;
  }

  private ensureInfo(): InfoClient {
    if (!this.info) throw new Error("Entropy 未 connect");
    return this.info;
  }

  private ensureEx(): ExchangeClient {
    if (!this.ex) throw new Error("Entropy 未 connect（实盘）");
    return this.ex;
  }

  private fmtSz(sz: number): string {
    const f = 10 ** this.szDecimals;
    return (Math.floor(Math.abs(sz) * f) / f).toFixed(this.szDecimals);
  }

  private fmtPx(px: number): string {
    return String(Math.round(px));
  }

  async snapshot(market: string): Promise<VenueSnapshot> {
    const info = this.ensureInfo();
    const mids = await info.allMids();
    const mid = num(mids[COIN] ?? mids["BTC"]);
    if (this.dryRun || !this.address) {
      return { venue: this.id, market, mid: mid || 100_000, position: 0, openOrders: [] };
    }
    const [state, oo] = await Promise.all([
      info.clearinghouseState({ user: this.address as `0x${string}` }),
      info.openOrders({ user: this.address as `0x${string}` }),
    ]);
    const posRow = (state.assetPositions || []).find(
      (p: any) => String(p?.position?.coin || "") === COIN
    );
    const position = num(posRow?.position?.szi);
    const upnl = num(posRow?.position?.unrealizedPnl, NaN);
    const liq = num(posRow?.position?.liquidationPx, NaN);
    const equity = num(state.marginSummary?.accountValue, NaN);
    const orders = (oo || [])
      .filter((o: any) => String(o.coin || "") === COIN && !o.isTrigger)
      .map((o: any) => ({
        id: String(o.oid),
        market,
        side: (o.side === "B" || o.b === true ? "buy" : "sell") as "buy" | "sell",
        price: num(o.limitPx ?? o.p),
        size: num(o.sz ?? o.s),
        level: 0,
      }));
    return {
      venue: this.id,
      market,
      mid,
      position,
      openOrders: orders,
      equityUsd: Number.isFinite(equity) && equity > 0 ? equity : undefined,
      unrealizedPnl: Number.isFinite(upnl) ? upnl : undefined,
      liquidationPrice: Number.isFinite(liq) && liq > 0 ? liq : undefined,
    };
  }

  async apply(intents: Intent[]): Promise<ApplyResult> {
    if (this.dryRun) return dryApply(this.id, intents);
    const ex = this.ensureEx();
    const result: ApplyResult = { placed: 0, cancelled: 0, failed: 0, errors: [] };
    const gap = Math.max(50, Number(process.env.ENTROPY_ORDER_GAP_MS || 200) || 200);
    for (const intent of intents) {
      try {
        if (intent.type === "cancel") {
          await ex.cancel({
            cancels: [{ a: this.asset, o: Number(intent.orderId) }],
          });
          result.cancelled += 1;
        } else {
          await ex.order({
            orders: [
              {
                a: this.asset,
                b: intent.order.side === "buy",
                p: this.fmtPx(intent.order.price),
                s: this.fmtSz(intent.order.size),
                r: false,
                t: { limit: { tif: "Alo" } },
              },
            ],
            grouping: "na",
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
      console.log(`[entropy:dry] cancelAll ${market}`);
      return;
    }
    const snap = await this.snapshot(market);
    const ex = this.ensureEx();
    const ids = snap.openOrders.map((o) => Number(o.id)).filter((n) => n > 0);
    if (ids.length) {
      await ex.cancel({ cancels: ids.map((o) => ({ a: this.asset, o })) });
    }
    await this.cancelHardStops(market);
  }

  async closePosition(market: string, sizeBase?: number | null): Promise<void> {
    if (this.dryRun) {
      console.log(`[entropy:dry] closePosition ${market}${sizeBase != null ? ` size=${sizeBase}` : ""}`);
      return;
    }
    const snap = await this.snapshot(market);
    const pos = Number(snap.position) || 0;
    if (Math.abs(pos) < 1e-12) return;
    const mid = snap.mid;
    if (!(mid > 0)) throw new Error("closePosition: no mid");
    const cut = sizeBase != null && sizeBase > 0 ? Math.min(Math.abs(sizeBase), Math.abs(pos)) : Math.abs(pos);
    const isBuy = pos < 0;
    const px = isBuy ? mid * 1.01 : mid * 0.99;
    await this.ensureEx().order({
      orders: [
        {
          a: this.asset,
          b: isBuy,
          p: this.fmtPx(px),
          s: this.fmtSz(cut),
          r: true,
          t: { limit: { tif: "Ioc" } },
        },
      ],
      grouping: "na",
    });
  }

  async syncHardStops(spec: HardStopSpec): Promise<{ armed: boolean; note?: string }> {
    if (this.dryRun) return { armed: true, note: "dry" };
    const drift =
      this.stopOids.upPx &&
      this.stopOids.dnPx &&
      Math.abs(this.stopOids.upPx - spec.hardUp) / spec.hardUp < 0.002 &&
      Math.abs(this.stopOids.dnPx - spec.hardDn) / spec.hardDn < 0.002;
    if (drift && this.stopOids.up && this.stopOids.dn) {
      return { armed: true, note: "kept" };
    }
    await this.cancelHardStops(spec.market);
    const snap = await this.snapshot(spec.market);
    const cover = Math.max(Math.abs(Number(snap.position) || 0), 0.00001);
    const sz = this.fmtSz(cover);
    const ex = this.ensureEx();
    const place = async (isBuy: boolean, trigger: number) => {
      const r = await ex.order({
        orders: [
          {
            a: this.asset,
            b: isBuy,
            p: this.fmtPx(isBuy ? trigger * 1.01 : trigger * 0.99),
            s: sz,
            r: true,
            t: {
              trigger: {
                isMarket: true,
                triggerPx: this.fmtPx(trigger),
                tpsl: "sl",
              },
            },
          },
        ],
        grouping: "na",
      });
      const st = (r as any)?.response?.data?.statuses?.[0];
      const oid = Number(st?.resting?.oid ?? st?.filled?.oid ?? 0);
      return oid > 0 ? oid : undefined;
    };
    try {
      this.stopOids.up = await place(true, spec.hardUp);
      this.stopOids.dn = await place(false, spec.hardDn);
      this.stopOids.upPx = spec.hardUp;
      this.stopOids.dnPx = spec.hardDn;
      const ok = !!(this.stopOids.up && this.stopOids.dn);
      return { armed: ok, note: ok ? "hl-trigger" : "partial" };
    } catch (e: any) {
      return { armed: false, note: String(e?.message || e).slice(0, 120) };
    }
  }

  async cancelHardStops(_market: string): Promise<void> {
    if (this.dryRun || !this.ex) return;
    const oids = [this.stopOids.up, this.stopOids.dn].filter((x): x is number => !!x);
    if (oids.length) {
      try {
        await this.ex.cancel({ cancels: oids.map((o) => ({ a: this.asset, o })) });
      } catch {
        /* already gone */
      }
    }
    this.stopOids = {};
  }
}
