# 我们踩过的坑 / 已解决问题

本页记录把经典网格跑稳时遇到的真实难题与解法，方便后来者（和 AI）少走弯路。当前仓库只保留 Decibel、N1、PopDEX、RISEx。

## 1. 成交后如何保持网格不断档

**问题**：限价网格成交后若只撤不补，买卖档会越来越稀。  
**做法**：`grid.ts` 里「买成交 → 上邻挂卖；卖成交 → 下邻挂买」。每 level 最多一单，错位/叠单撤掉腾名额。  
**注意**：`skipBand` 会跳过贴 mid 的档；看板里 mid 旁「缺 1 档」通常是买卖分界，不是漏单。

## 2. 重启别把挂单冲掉（SOFT_RESUME）

**问题**：进程一重启若按最新 mid 重锚，会整表撤挂、重铺，仓位路径被打乱。  
**做法**：`SOFT_RESUME=1` 时从本地 `data/status.json` 读回各所 `anchorMid`，视为已铺过，只补漏档。  
**注意**：`data/` 永不提交仓库。

## 3. 官方统计把内存打爆（OOM）

**问题**：为了看板「几乎实时」，曾每几秒强制拉四所全日成交史；一轮要十几～三十秒，临时数组 + SDK 缓存堆到 Node 默认堆上限 → `heap out of memory`。  
**做法**：官方量/费/盈亏改为约 **2 分钟**一轮，并给 Node 足够 `--max-old-space-size`。挂单/仓位仍走 tick，TG 开平成交通知不依赖该轮询。  
**教训**：展示数字很小 ≠ 拉取过程很轻。

## 4. 各所「平仓盈亏」口径不一致

| 所 | 口径要点 |
|----|----------|
| Extended | 单笔 trade 常无可靠 realized；用 `positions/history` 已平仓记录。今日无已平仓位时看板显示 `-` 是正常的。 |
| RISEx / Decibel | 成交历史上的 `realized_pnl` 类字段可累加。 |
| N1 | volume + pnl summary + trades fee。 |
| Phoenix | 接 trader pnl / trades 接口（见适配器）。 |

不要拿「四所数字形态是否一致」当唯一健康标准。

## 5. 仓位名义差很多不一定是 bug

**问题**：同资金占比下，A 所仓位名义 3000U、B 所只有几百 U。  
**原因**：单格 `sizeBase` 可能相近，但**净持仓格数**是路径依赖（谁成交更多、是否完成更多来回）。  
**核对**：看 `sizeBase × gridCount × mid`（满格名义）是否同量级；再看净仓 = `|pos| / sizeBase`。

## 6. 限流 / 最大挂单数

**问题**：RISEx 等对单市场挂单数、写频率有限制。  
**做法**：`maxOpenOrders`、`maxWritesPerTick`、下单间隔（如 `RISE_ORDER_GAP_MS`）；TG 对同类限流错误做去重，避免刷屏。

## 7. Decibel 价位/数量对齐

**问题**：网格等差价可能落在 tick/lot 之间导致下单失败。  
**做法**：编码前按 `tick_size` / `lot_size` 四舍五入对齐（见 `decibelLive.ts`）。

## 8. 地区与鉴权差异（Phoenix）

**问题**：网页可能提示地区不可用；下单常是「API 构建指令 → 本地签名 → 上链」。  
**做法**：以 [docs.phoenix.trade](https://docs.phoenix.trade/) / Rise SDK 为准，适配器封装 `snapshot`/`apply`，与 CEX 风格 REST 区分开。

## 9. 看板：看「匀不匀」而不是只看多空数量

挂单横轴用相邻档距相对期望 spacing 判空洞；mid 缝与远离 mid 的大洞要分开解读。

## 10. 开源与生产隔离

生产密钥、服务器地址、真实 ledger **不得**进公开库。开源树只保留适配器 + 策略 + 看板模板 + `.env.example`。

## 11. 链上 CLOB（PopDEX）与 gasless 下单

**问题**：PopDEX（Morph Tachyon）是链上订单簿，下单=合约调用 `eth_sendRawTransaction`，与 CEX 风格 REST 完全不同；钱包需走 viem 本地签名。  
**做法**：`popdex.ts` 用 `viem` 构造 `Order` 合约 place/cancel 的 calldata，走 `/api/v1/web3/rpc` 广播；gasless 由官方中继代付，无需自备 gas。挂单价按 `tick_size` / `lot_size` 对齐。  
**注意**：官方统计 indexer 明细（trade/fills）仍在接入中，量/费口径要与链上 `execValue` 对齐。

## 12. 坏 JSON 回包不一定是故障

**问题**：Phoenix 等下单接口偶发回包 `id` 字段缺引号，导致 `JSON.parse` 抛「is not valid JSON」；若按硬错误处理会狂刷 TG、把看板标红。  
**做法**：把这类解析错误归类为「瞬时软错误」——日志仍记、但不发 TG、不挂看板红字；下一轮自动重试补单。
