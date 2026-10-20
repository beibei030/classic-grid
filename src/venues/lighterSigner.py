#!/usr/bin/env python3
"""Lighter RH JSONL sidecar. Never print secrets."""
from __future__ import annotations

import asyncio
import json
import os
import re
import sys
import traceback
from pathlib import Path

import lighter

URL = os.environ.get("LIGHTER_API_URL", "https://api.rh.lighter.xyz").rstrip("/")
MARKET = int(os.environ.get("LIGHTER_MARKET_ID", "1") or "1")
CHUNK = max(1, min(40, int(os.environ.get("LIGHTER_BATCH_CHUNK", "20") or "20")))


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8-sig")


def load_keys():
    env_priv = (os.environ.get("LIGHTER_PRIVATE_KEY") or "").strip()
    env_acc = os.environ.get("LIGHTER_ACCOUNT_INDEX")
    env_idx = os.environ.get("LIGHTER_API_KEY_INDEX")
    candidates = []
    raw = (os.environ.get("LIGHTER_KEY_PATH") or "").strip()
    if raw:
        candidates.append(Path(raw))
    cwd = Path(os.environ.get("LIGHTER_CWD") or os.getcwd())
    candidates.append(cwd / "secrets" / "lighter.key")
    text = ""
    for p in candidates:
        try:
            if p.is_file():
                text = _read_text(p)
                break
        except OSError:
            continue
    if env_priv and env_acc:
        return int(env_acc), int(env_idx or "4"), env_priv
    if not text:
        raise RuntimeError("缺少 Lighter 钥匙（secrets/lighter.key 或 LIGHTER_PRIVATE_KEY）")
    acc_m = re.search(r"(?:account_index|账户|#)\s*[=:：]?\s*(\d{3,})", text, re.I)
    if not acc_m:
        acc_m = re.search(r"#?\s*(\d{3,})", text)
    idx_m = re.search(r"(?:api_key_index|API 密钥索引|密钥索引)\s*[=:：]?\s*(\d+)", text, re.I)
    priv_m = re.search(r"(?:private_key|私钥)\s*[=:：]?\s*([0-9a-fA-F]{64,})", text, re.I)
    if not (acc_m and idx_m and priv_m):
        raise RuntimeError("Lighter 钥匙文件缺 account_index / api_key_index / private_key")
    return int(acc_m.group(1)), int(idx_m.group(1)), priv_m.group(1)


def out(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class Sidecar:
    def __init__(self):
        self.acc, self.api_idx, self.priv = load_keys()
        self.client = lighter.SignerClient(
            url=URL,
            api_private_keys={self.api_idx: self.priv},
            account_index=self.acc,
        )
        self.api = self.client.api_client
        proxy = (os.environ.get("LIGHTER_PROXY") or "").strip()
        if proxy:
            self.api.configuration.proxy = proxy
            self.api.rest_client.proxy = proxy
        self.order_api = lighter.OrderApi(self.api)
        self.auth = ""
        self.auth_until = 0.0

    async def shutdown(self) -> None:
        try:
            await self.client.close()
        except Exception:
            pass

    def ensure_armed(self) -> None:
        if os.environ.get("LIGHTER_TRADING_ARMED") != "YES":
            raise RuntimeError("Lighter trading not armed：设 LIGHTER_TRADING_ARMED=YES")

    async def auth_token(self) -> str:
        now = asyncio.get_event_loop().time()
        if self.auth and now < self.auth_until - 30:
            return self.auth
        token, err = self.client.create_auth_token_with_expiry(
            deadline=50 * 60, api_key_index=self.api_idx
        )
        if err:
            raise RuntimeError(f"auth fail: {err}")
        self.auth = token
        self.auth_until = now + 50 * 60
        return token

    async def place_batch(self, orders: list) -> dict:
        self.ensure_armed()
        placed = 0
        failed = 0
        errors: list[str] = []
        for o in orders:
            try:
                _tx, resp, err = await self.client.create_order(
                    market_index=MARKET,
                    client_order_index=int(o["cid"]),
                    base_amount=int(o["sz_i"]),
                    price=int(o["px_i"]),
                    is_ask=bool(o.get("is_ask")),
                    order_type=int(o.get("order_type", self.client.ORDER_TYPE_LIMIT)),
                    time_in_force=int(o.get("tif", self.client.ORDER_TIME_IN_FORCE_POST_ONLY)),
                    reduce_only=bool(o.get("reduce_only")),
                    trigger_price=int(o.get("trigger_px_i") or 0),
                    order_expiry=self.client.DEFAULT_28_DAY_ORDER_EXPIRY,
                )
                code = getattr(resp, "code", None) if resp is not None else None
                if err or (code not in (None, 200)):
                    failed += 1
                    errors.append(str(err or getattr(resp, "message", code))[:200])
                else:
                    placed += 1
            except Exception as e:
                failed += 1
                errors.append(str(e)[:200])
            await asyncio.sleep(0.15)
        return {"placed": placed, "failed": failed, "errors": errors[:6]}

    async def cancel_batch(self, oids: list) -> dict:
        self.ensure_armed()
        cancelled = 0
        failed = 0
        errors: list[str] = []
        for oid in oids:
            try:
                _tx, resp, err = await self.client.cancel_order(
                    market_index=MARKET, order_index=int(oid)
                )
                code = getattr(resp, "code", None) if resp is not None else None
                if err or (code not in (None, 200)):
                    failed += 1
                    errors.append(str(err or getattr(resp, "message", code))[:200])
                else:
                    cancelled += 1
            except Exception as e:
                failed += 1
                errors.append(str(e)[:200])
            await asyncio.sleep(0.12)
        return {"cancelled": cancelled, "failed": failed, "errors": errors[:6]}

    async def cancel_all(self) -> dict:
        self.ensure_armed()
        _tx, resp, err = await self.client.cancel_all_orders(
            time_in_force=self.client.CANCEL_ALL_TIF_IMMEDIATE,
            timestamp_ms=0,
            api_key_index=self.api_idx,
        )
        if err:
            raise RuntimeError(str(err))
        code = getattr(resp, "code", None)
        if code not in (None, 200):
            raise RuntimeError(str(getattr(resp, "message", code)))
        return {"ok": True}

    async def leverage(self, lev: int) -> dict:
        _tx, resp, err = await self.client.update_leverage(
            MARKET, self.client.CROSS_MARGIN_MODE, int(lev), api_key_index=self.api_idx
        )
        if err:
            raise RuntimeError(str(err))
        return {"ok": True, "code": getattr(resp, "code", None)}

    async def orders(self) -> dict:
        auth = await self.auth_token()
        active = await self.order_api.account_active_orders(
            authorization=auth, account_index=self.acc, market_id=MARKET
        )
        raw = getattr(active, "orders", None) or getattr(active, "data", None) or []
        out_orders = []
        for o in raw:
            d = o.model_dump() if hasattr(o, "model_dump") else dict(o)
            if int(d.get("market_id") or MARKET) != MARKET:
                continue
            typ = str(d.get("type") or d.get("order_type") or "limit").lower()
            if "stop" in typ or "take" in typ or "twap" in typ:
                continue
            oid = d.get("client_order_index") or d.get("order_index") or d.get("order_id")
            px = float(d.get("price") or 0)
            sz = float(
                d.get("remaining_base_amount")
                or d.get("unfilled_base_amount")
                or d.get("base_amount")
                or 0
            )
            is_ask = bool(d.get("is_ask"))
            if oid is None or sz <= 0:
                continue
            out_orders.append(
                {
                    "id": str(int(oid)),
                    "side": "sell" if is_ask else "buy",
                    "price": px,
                    "size": sz,
                }
            )
        return {"orders": out_orders, "auth": auth}

    async def close(self, sz_i: int, px_i: int, is_ask: bool, cid: int) -> dict:
        self.ensure_armed()
        _tx, resp, err = await self.client.create_market_order(
            market_index=MARKET,
            client_order_index=int(cid),
            base_amount=int(sz_i),
            avg_execution_price=int(px_i),
            is_ask=bool(is_ask),
            reduce_only=True,
            api_key_index=self.api_idx,
        )
        if err:
            raise RuntimeError(str(err))
        return {"ok": True, "code": getattr(resp, "code", None)}

    async def handle(self, msg: dict) -> dict:
        op = str(msg.get("op") or "")
        if op == "ping":
            return {"account_index": self.acc, "api_key_index": self.api_idx}
        if op == "leverage":
            return await self.leverage(int(msg.get("lev") or 30))
        if op == "place_batch":
            return await self.place_batch(list(msg.get("orders") or []))
        if op == "cancel_batch":
            return await self.cancel_batch(list(msg.get("oids") or []))
        if op == "cancel_all":
            return await self.cancel_all()
        if op == "orders":
            return await self.orders()
        if op == "close":
            return await self.close(
                int(msg["sz_i"]), int(msg["px_i"]), bool(msg.get("is_ask")), int(msg["cid"])
            )
        if op == "auth":
            token = await self.auth_token()
            return {"auth": token, "account_index": self.acc}
        raise RuntimeError(f"unknown op {op}")


async def main() -> None:
    box = Sidecar()
    out({"id": 0, "ok": True, "ready": True, "account_index": box.acc})
    loop = asyncio.get_event_loop()
    try:
        while True:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError as e:
                out({"id": None, "ok": False, "error": f"bad json: {e}"})
                continue
            mid = msg.get("id")
            try:
                data = await box.handle(msg)
                out({"id": mid, "ok": True, **data})
            except Exception as e:
                out({"id": mid, "ok": False, "error": str(e)[:240]})
    finally:
        await box.shutdown()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except Exception:
        out({"id": 0, "ok": False, "error": traceback.format_exc()[-400:]})
        sys.exit(1)
