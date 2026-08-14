/**
 * Decibel 薄客户端：官方 @decibeltrade/sdk + REST 读接口。
 * 挂单/仓位/价格一律来自交易所，不维护本地假真相。
 */
import type { Account } from "@aptos-labs/ts-sdk";
import { loadEnv } from "../loadEnv.js";

export type DecibelMarketCfg = {
  market_addr: string;
  market_name: string;
  sz_decimals: number;
  px_decimals: number;
  tick_size: number;
  min_size: number;
  lot_size: number;
};

export type DecibelHumanOrder = {
  side: "buy" | "sell";
  price: number;
  size: number;
  reduceOnly: boolean;
  clientOrderId?: string;
  timeInForce: number;
};

export function encodeDecibelHumanOrder(
  market: DecibelMarketCfg,
  order: DecibelHumanOrder
) {
  const tick = Math.max(1, Number(market.tick_size) || 1);
  const lot = Math.max(1, Number(market.lot_size) || 1);
  let price = Math.round(order.price * 10 ** market.px_decimals);
  let size = Math.round(order.size * 10 ** market.sz_decimals);
  // 对齐 tick / lot（网格等差价可能落在 tick 之间）
  price = Math.round(price / tick) * tick;
  size = Math.round(size / lot) * lot;
  if (!(price > 0) || !(size > 0)) throw new Error("Decibel order price/size too small");
  if (price % tick !== 0) {
    throw new Error(`Decibel encoded price ${price} 未对齐 tick_size=${tick}`);
  }
  if (size % lot !== 0) {
    throw new Error(`Decibel encoded size ${size} 未对齐 lot_size=${lot}`);
  }
  return {
    marketName: market.market_name,
    price,
    size,
    isBuy: order.side === "buy",
    timeInForce: order.timeInForce,
    isReduceOnly: order.reduceOnly,
    clientOrderId: order.clientOrderId,
    tickSize: tick,
  };
}

function baseSymbol(marketName: string): string {
  return marketName.split(/[-/_]/)[0]!.toUpperCase();
}

export class DecibelLive {
  private read: any;
  private write: any;
  private account!: Account;
  private subaccount!: string;
  private sdk: any;
  private markets: DecibelMarketCfg[] = [];
  private byBase = new Map<string, DecibelMarketCfg>();
  private addrToBase = new Map<string, string>();

  async connect(): Promise<void> {
    loadEnv();
    const apiKey = process.env.DECIBEL_API_KEY?.trim();
    const privateKey = process.env.DECIBEL_ACCOUNT_PRIVATE_KEY?.trim();
    const gasStationApiKey = process.env.DECIBEL_GAS_STATION_API_KEY?.trim();
    if (!apiKey || !privateKey) throw new Error("缺少 DECIBEL_API_KEY / DECIBEL_ACCOUNT_PRIVATE_KEY");

    // npm 包的声明文件滞后于运行时导出；主网审计已验证这些运行时 API。
    const sdk: any = await import("@decibeltrade/sdk");
    const aptos = await import("@aptos-labs/ts-sdk");
    this.sdk = sdk;

    const baseCfg = sdk.MAINNET_CONFIG;
    const netCfg = gasStationApiKey
      ? {
          ...baseCfg,
          gasStationApiKey,
          gasStationUrl: "https://api.mainnet.aptoslabs.com/gs/v1",
        }
      : baseCfg;

    this.account = new aptos.Ed25519Account({
      privateKey: new aptos.Ed25519PrivateKey(privateKey),
    });

    this.read = new sdk.DecibelReadDex(netCfg, { nodeApiKey: apiKey });
    const gas = new sdk.GasPriceManager(netCfg);
    await gas.initialize().catch(() => {});
    this.write = new sdk.DecibelWriteDex(netCfg, this.account, {
      nodeApiKey: apiKey,
      gasPriceManager: gas,
      // SDK 0.6/0.7 会把节点返回的“最大可能 gas”再次乘 2，自付 gas 时必然超出余额上限。
      skipSimulate: true,
    });

    this.subaccount =
      process.env.DECIBEL_SUBACCOUNT?.trim() ||
      sdk.getPrimarySubaccountAddr(
        this.account.accountAddress,
        netCfg.compatVersion,
        netCfg.deployment.package
      );

    await this.refreshMarkets();
  }

  async refreshMarkets() {
    const ms = (await this.read.markets.getAll()) as DecibelMarketCfg[];
    this.markets = ms || [];
    this.byBase.clear();
    this.addrToBase.clear();
    for (const m of this.markets) {
      const base = baseSymbol(m.market_name);
      if (!this.byBase.has(base)) this.byBase.set(base, m);
      this.addrToBase.set(m.market_addr, base);
    }
  }

  cfg(symbol: string): DecibelMarketCfg | undefined {
    return this.byBase.get(symbol.toUpperCase());
  }

  get marketList() {
    return [...this.markets];
  }

  get subAddr() {
    return this.subaccount;
  }

  get ownerAddr() {
    return this.account.accountAddress.toString();
  }

  async prices() {
    return this.read.marketPrices.getAll();
  }

  async pricesByName(marketName: string) {
    return this.read.marketPrices.getByName({ marketName });
  }

  async candles(
    symbol: string,
    intervalSec: 900 | 3600,
    startTime: number,
    endTime: number
  ) {
    const m = this.cfg(symbol);
    if (!m || !this.read.candlesticks?.getByName) return [];
    const interval =
      intervalSec >= 3600
        ? this.sdk.CandlestickInterval.OneHour
        : this.sdk.CandlestickInterval.FifteenMinutes;
    const rows = await this.read.candlesticks.getByName({
      marketName: m.market_name,
      interval,
      startTime,
      endTime,
    });
    return (rows ?? [])
      .map((row: any) => ({
        time: Number(row.t),
        open: Number(row.o),
        high: Number(row.h),
        low: Number(row.l),
        close: Number(row.c),
        volume: Number(row.v ?? 0),
      }))
      .filter((row: any) => Number.isFinite(row.close))
      .sort((a: any, b: any) => a.time - b.time);
  }

  async orderbook(marketName: string) {
    // SDK / REST: orderbook depth
    if (this.read.orderbook?.getByName) {
      return this.read.orderbook.getByName({ marketName });
    }
    if (this.read.marketDepth?.getByName) {
      return this.read.marketDepth.getByName({ marketName });
    }
    return null;
  }

  async mid(symbol: string): Promise<number> {
    const m = this.cfg(symbol);
    if (!m) throw new Error(`unknown ${symbol}`);
    const pr = await this.pricesByName(m.market_name);
    const row = Array.isArray(pr) ? pr[0] : pr;
    const mid = Number(row?.mid_px ?? row?.mark_px ?? row?.oracle_px ?? 0);
    if (!(mid > 0)) throw new Error("no mid/mark");
    return mid;
  }

  async positions() {
    return this.read.userPositions.getByAddr({ subAddr: this.subaccount });
  }

  async positionDetails(symbol?: string) {
    const rows = await this.positions();
    const items = rows?.items ?? rows ?? [];
    const wanted = symbol?.toUpperCase();
    const out: any[] = [];
    for (const p of Array.isArray(items) ? items : []) {
      const base = this.addrToBase.get(String(p.market)) ?? baseSymbol(String(p.market_name || ""));
      if (wanted && base !== wanted) continue;
      const m = this.cfg(base);
      if (!m) continue;
      const rawSize = Number(p.size ?? p.position_size ?? 0);
      const size = Math.abs(this.parseApiSize(Math.abs(rawSize), m));
      if (!(size > 0)) continue;
      const short = String(p.side || "").toUpperCase() === "SHORT" || rawSize < 0;
      const entry = this.parseApiPrice(
        Number(p.avg_entry_price ?? p.entry_price ?? p.open_price ?? 0),
        m
      );
      const markRow = await this.pricesByName(m.market_name).catch(() => null);
      const markSource = Array.isArray(markRow) ? markRow[0] : markRow;
      const mark = Number(markSource?.mark_px ?? markSource?.mid_px ?? 0);
      let upnl = Number(p.unrealized_pnl ?? p.unrealised_pnl ?? 0);
      if (upnl === 0 && entry > 0 && mark > 0) {
        upnl = (short ? entry - mark : mark - entry) * size;
      }
      out.push({
        symbol: base,
        side: short ? "short" : "long",
        size,
        entryPrice: entry,
        markPrice: mark,
        valueUsd: size * (mark || entry),
        unrealizedPnl: upnl,
        leverage: p.user_leverage != null ? Number(p.user_leverage) : null,
        margin: p.margin != null ? Number(p.margin) : null,
        liquidationPrice: (() => {
          const liqRaw = Number(
            p.estimated_liquidation_price ?? p.liquidation_price ?? NaN
          );
          if (!(Number.isFinite(liqRaw) && liqRaw > 0)) return null;
          return Math.abs(liqRaw) > 1e6
            ? this.parseApiPrice(liqRaw, m, mark)
            : liqRaw;
        })(),
      });
    }
    return out;
  }

  async tradesSince(sinceMs: number, limit = 2000) {
    const reader = this.read.userTradeHistory;
    if (!reader?.getByAddr) return [];
    const out: any[] = [];
    for (let offset = 0; offset < limit; offset += 100) {
      const page = await reader.getByAddr({
        subAddr: this.subaccount,
        limit: 100,
        offset,
      });
      const items = page?.items ?? page ?? [];
      for (const row of items) {
        const at = Number(row.transaction_unix_ms ?? 0);
        if (at >= sinceMs) out.push(row);
      }
      if (items.length < 100) break;
      const oldest = Math.min(...items.map((row: any) => Number(row.transaction_unix_ms || 0)));
      if (oldest > 0 && oldest < sinceMs) break;
    }
    return out;
  }

  async tradesByOrderId(orderId: string, limit = 2000) {
    const reader = this.read.userTradeHistory;
    if (!reader?.getByAddr) return [];
    const out: any[] = [];
    for (let offset = 0; offset < limit; offset += 100) {
      const page = await reader.getByAddr({
        subAddr: this.subaccount,
        limit: 100,
        offset,
      });
      const items = page?.items ?? page ?? [];
      out.push(
        ...items.filter(
          (row: any) => String(row.order_id) === String(orderId)
        )
      );
      if (out.length || items.length < 100) break;
    }
    return out;
  }

  async overview() {
    const viaSdk = await this.read.accountOverviews
      ?.getByAddr?.({ subAddr: this.subaccount })
      .catch(() => null);
    if (viaSdk) return viaSdk;
    const base = this.sdk.MAINNET_CONFIG.tradingHttpUrl.replace(/\/$/, "");
    const key = process.env.DECIBEL_API_KEY?.trim();
    const res = await fetch(
      `${base}/api/v1/account_overviews?account=${encodeURIComponent(this.subaccount)}`,
      { headers: key ? { Authorization: `Bearer ${key}` } : undefined }
    );
    if (!res.ok) throw new Error(`Decibel overview HTTP ${res.status}`);
    const body: any = await res.json();
    return body?.data ?? body;
  }

  async orderById(orderId: string) {
    const reader = this.read.userOrderHistory;
    if (!reader?.getByAddr) return null;
    for (let offset = 0; offset < 500; offset += 100) {
      const page = await reader.getByAddr({
        subAddr: this.subaccount,
        limit: 100,
        offset,
      });
      const items = page?.items ?? page ?? [];
      const found = items.find((o: any) => String(o.order_id) === String(orderId));
      if (found) return found;
      if (items.length < 100) break;
    }
    return null;
  }

  async recentOrderHistoryForUnitAudit(limit = 100) {
    const page = await this.read.userOrderHistory.getByAddr({
      subAddr: this.subaccount,
      limit,
      offset: 0,
    });
    return page?.items ?? page ?? [];
  }

  async recentTradeHistoryForUnitAudit(limit = 100) {
    const page = await this.read.userTradeHistory.getByAddr({
      subAddr: this.subaccount,
      limit,
      offset: 0,
    });
    return page?.items ?? page ?? [];
  }

  /** @deprecated REST/indexer fields are human units; use recentOrderHistoryForUnitAudit. */
  recentRawOrderHistory(limit = 100) {
    return this.recentOrderHistoryForUnitAudit(limit);
  }

  /** @deprecated REST/indexer fields are human units; use recentTradeHistoryForUnitAudit. */
  recentRawTradeHistory(limit = 100) {
    return this.recentTradeHistoryForUnitAudit(limit);
  }

  async orderByClientId(clientOrderId: string) {
    const wanted = String(clientOrderId);
    const clientIdOf = (order: any) =>
      String(
        order?.client_order_id ?? order?.clientOrderId ?? order?.clientId ?? ""
      );
    const openReader = this.read.userOpenOrders;
    if (openReader?.getByAddr) {
      for (let offset = 0; offset < 500; offset += 100) {
        const page = await openReader.getByAddr({
          subAddr: this.subaccount,
          limit: 100,
          offset,
        });
        const items = page?.items ?? page ?? [];
        const found = items.find((order: any) => clientIdOf(order) === wanted);
        if (found) return found;
        if (items.length < 100) break;
      }
    }
    const historyReader = this.read.userOrderHistory;
    if (!historyReader?.getByAddr) return null;
    for (let offset = 0; offset < 500; offset += 100) {
      const page = await historyReader.getByAddr({
        subAddr: this.subaccount,
        limit: 100,
        offset,
      });
      const items = page?.items ?? page ?? [];
      const found = items.find((order: any) => clientIdOf(order) === wanted);
      if (found) return found;
      if (items.length < 100) break;
    }
    return null;
  }

  private parseApiPrice(raw: number, m: DecibelMarketCfg, markHint = 0): number {
    if (!(raw > 0)) return 0;
    const scaled = raw / 10 ** m.px_decimals;
    if (markHint > 0) {
      const near = (v: number) => v > markHint * 0.05 && v < markHint * 20;
      if (near(raw)) return raw;
      if (near(scaled)) return scaled;
    }
    if (raw >= 1e7) return scaled;
    return raw;
  }

  private parseApiSize(raw: number, m: DecibelMarketCfg): number {
    if (!(raw > 0)) return 0;
    const scaled = raw / 10 ** m.sz_decimals;
    if (raw < 1e5 && scaled < raw * 0.01) return raw;
    if (raw >= 1e6) return scaled;
    return raw;
  }

  async openOrders(symbol?: string) {
    const sym = symbol?.toUpperCase();
    const priceRows = await this.prices().catch(() => []);
    const priceByAddr = new Map<string, any>(
      (priceRows || []).map((p: any) => [String(p.market), p])
    );
    const out: Array<{
      orderId: string;
      symbol: string;
      side: "buy" | "sell";
      price: number;
      size: number;
    }> = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const page = await this.read.userOpenOrders.getByAddr({
        subAddr: this.subaccount,
        limit: 100,
        offset,
      });
      const items = page.items ?? [];
      if (!items.length) break;
      for (const o of items) {
        if (o.is_tpsl) continue;
        const base = this.addrToBase.get(o.market) ?? baseSymbol(String(o.market));
        if (sym && base !== sym) continue;
        const m = this.cfg(base);
        if (!m || o.price == null) continue;
        const mark = Number(priceByAddr.get(o.market)?.mark_px ?? 0);
        const px = this.parseApiPrice(Number(o.price), m, mark);
        const sz = this.parseApiSize(Math.abs(Number(o.remaining_size ?? o.orig_size ?? 0)), m);
        if (sz <= 0 || px <= 0) continue;
        out.push({
          orderId: String(o.order_id),
          symbol: base,
          side: o.is_buy ? "buy" : "sell",
          price: px,
          size: sz,
        });
      }
      if (items.length < 100) break;
    }
    return out;
  }

  async placeLimit(params: {
    symbol: string;
    side: "buy" | "sell";
    price: number;
    size: number;
    postOnly?: boolean;
    reduceOnly?: boolean;
    clientOrderId?: string;
  }) {
    const m = this.cfg(params.symbol);
    if (!m) throw new Error(`unknown ${params.symbol}`);
    const encoded = encodeDecibelHumanOrder(m, {
      ...params,
      reduceOnly: params.reduceOnly === true,
      timeInForce:
        params.postOnly !== false
          ? this.sdk.TimeInForce.PostOnly
          : this.sdk.TimeInForce.GoodTillCanceled,
    });
    const res = await this.write.placeOrder({
      ...encoded,
      subaccountAddr: this.subaccount,
    });
    if (!res?.success) throw new Error(res?.error || "placeOrder failed");
    return { orderId: String(res.orderId) };
  }

  async placeIoc(params: {
    symbol: string;
    side: "buy" | "sell";
    price: number;
    size: number;
    reduceOnly: boolean;
    clientOrderId: string;
  }) {
    const m = this.cfg(params.symbol);
    if (!m) throw new Error(`unknown ${params.symbol}`);
    const encoded = encodeDecibelHumanOrder(m, {
      ...params,
      timeInForce: this.sdk.TimeInForce.ImmediateOrCancel,
    });
    const res = await this.write.placeOrder({
      ...encoded,
      subaccountAddr: this.subaccount,
    });
    if (!res?.success) throw new Error(res?.error || "IOC placeOrder failed");
    return { orderId: String(res.orderId) };
  }

  async setLeverage(symbol: string, leverage: number) {
    const m = this.cfg(symbol);
    if (!m) throw new Error(`unknown ${symbol}`);
    const target = Math.max(1, Math.min(255, Math.floor(leverage)));
    const rows = await this.read.userPositions.getByAddr({
      subAddr: this.subaccount,
      marketAddr: m.market_addr,
      includeDeleted: true,
      limit: 5,
    });
    const list = Array.isArray(rows) ? rows : rows?.items ?? [];
    const row = list.find((p: any) => p.market === m.market_addr) ?? list[0];
    if (Number(row?.user_leverage) === target) return;
    await this.write.configureUserSettingsForMarket({
      marketAddr: m.market_addr,
      subaccountAddr: this.subaccount,
      isCross: true,
      userLeverage: target,
    });
  }

  async cancel(symbol: string, orderId: string) {
    const m = this.cfg(symbol);
    if (!m) throw new Error(`unknown ${symbol}`);
    try {
      const res = await this.write.cancelOrder({
        orderId,
        marketName: m.market_name,
        subaccountAddr: this.subaccount,
      });
      return !!res?.success;
    } catch (e: any) {
      const msg = String(e?.message || e);
      // 索引滞后或已成交/已撤
      if (/EORDER_NOT_FOUND|ORDER_NOT_FOUND|not found/i.test(msg)) return true;
      throw e;
    }
  }

  async cancelAll(symbol?: string) {
    let n = 0;
    for (let round = 0; round < 20; round++) {
      const orders = await this.openOrders(symbol);
      if (!orders.length) break;
      for (const o of orders) {
        try {
          if (await this.cancel(o.symbol, o.orderId)) n++;
        } catch {
          /* 继续清其它单 */
        }
        await new Promise((r) => setTimeout(r, 120));
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return n;
  }

  /** REST orderbook（文档 /api/v1/orderbook）；SDK depth GET 已注释掉 */
  async fetchOrderbookRest(marketAddr: string) {
    const base = this.sdk.MAINNET_CONFIG.tradingHttpUrl.replace(/\/$/, "");
    const key = process.env.DECIBEL_API_KEY?.trim();
    const url = `${base}/api/v1/orderbook?ticker_id=${encodeURIComponent(marketAddr)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${key}`,
        Origin: "https://app.decibel.trade",
        Accept: "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
    const text = await res.text();
    let body: any = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    if (!res.ok) {
      throw new Error(`orderbook HTTP ${res.status}: ${String(text).slice(0, 200)}`);
    }
    return body;
  }

  minHumanSize(symbol: string): number {
    const m = this.cfg(symbol);
    if (!m) return 0;
    return m.min_size / 10 ** m.sz_decimals;
  }

  disconnect() {
    try {
      this.read?.close?.();
      this.read?.deps?.ws?.close?.();
    } catch {
      /* ignore */
    }
  }
}
