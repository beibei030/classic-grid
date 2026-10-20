# Classic Grid — 四所经典网格（开源）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](./package.json)

等差网格：现价下买上卖，**成交后补相邻反向单**；启动校验格距 > 双边手续费、保证金预检。

适配器：**Decibel · N1 · PopDEX · RISEx**

> 开源模板，**不含私钥 / API Key / Telegram Token / 服务器地址 / 账本文件**。
> 生产运行只需要：`cp .env.example .env`，填上你的密钥，其余代码零改动。

---

## 注册链接（可选，非投资建议）

| 交易所 | 链接 |
|--------|------|
| **Decibel** | https://app.decibel.trade/r/K7B2QM |
| **N1** | https://app.n1.xyz/r/orderly-loop-curve |
| **PopDEX** | https://app.popdex.xyz/referral?referralCode=AIQIANG |
| **RISEx** | https://www.rise.trade/invite/aiqiang |

---

## 功能一览

- 多所统一 `VenueExecutor`：`snapshot` / `apply` / 可选 `cancelAll`·`closePosition`
- 经典网格核心：`seed` 铺单 + 成交补反向档 + `skipBand`（近价跳过带宽）
- 本地看板：总览 KPI、今日明细、各所状态、挂单档位横轴（看匀不匀）、日历盈亏
- 官方量 / 费 / 平仓盈亏（节流拉取，避免内存爆）
- Telegram：开/平简报、整点总览、异常去重（可选）
- `SOFT_RESUME`：重启恢复锚点，避免误整表撤单
- 紧急暂停 / 出入金记账（看板按钮 + API）

---

## 我们解决过什么（摘要）

完整版 → [`docs/CHALLENGES.md`](./docs/CHALLENGES.md)

| 难题 | 解法要点 |
|------|----------|
| 成交后网格断档 | 买→上邻卖 / 卖→下邻买，每 level 一单 |
| 重启冲掉挂单 | `SOFT_RESUME` + 本地锚点，只补漏 |
| 官方统计 OOM | 节流拉取 + 加大 Node 堆 |
| 各所盈亏口径不一 | Ex 用已平仓 history；Rise/Dec 用 fill realized 等 |
| 仓位名义差很多 | 净仓路径不同，先对满格名义再对净格数 |
| 限流 / 挂单上限 | `maxOpenOrders`、写频、间隔、错误去重 |
| Decibel tick/lot | 编码前对齐 |
| 链上 CLOB（PopDEX） | viem 签名 + gasless 中继广播 |
| 坏 JSON 回包 | 归类瞬时软错误，不刷 TG、下轮重试 |

---

## 怎么跑起来

### 0. 前置

- Node.js ≥ 20
- 至少一个交易所的账号 + API 密钥（无密钥也能用 `DRY_RUN=1` 跑空转看流程）

### 1. 安装依赖

```bash
npm install
```

### 2. 准备环境变量（**只在本机填密钥，永远不要提交 `.env`**）

```bash
cp .env.example .env
```

打开 `.env`，按需填写。关键项：

- `VENUES=` 只开你有密钥的所，例如 `VENUES=decibel,n1,popdex,risex`
- 各所的 API / 私钥 / keypair 路径（`secrets/*.key`、`secrets/*.json`，已在 `.gitignore`）
- 默认 `DRY_RUN=1`（模拟，只读看板，不下单）
- 实盘必须**同时**满足：`DRY_RUN=0` 且 `LIVE_CONFIRM=YES`

### 3. 先空转一轮（强烈建议）

```bash
DRY_RUN=1 npm start -- --once
```

会打印各所锚点、格数、档距、size、风险预检，但不下任何单。确认无报错再继续。

### 4. 实盘运行

```bash
DRY_RUN=0 LIVE_CONFIRM=YES npm start
```

看板默认 http://127.0.0.1:8088/（`/api/snapshot` 是机器可读 JSON）。

Windows（PowerShell）：

```powershell
Copy-Item .env.example .env
$env:DRY_RUN="1"; npm start -- --once
```

### 5. 禁止提交

`.env` / `secrets/` / `data/` 永远不提交；见 [`SECURITY.md`](./SECURITY.md)。

---

## Telegram 报警（可选）

代码已包含：`src/telegram.ts`（开/平简报、错误去重、整点总览）。在 **本机 `.env`** 填写：

```env
TELEGRAM_ENABLED=true
TELEGRAM_BOT_TOKEN=     # BotFather 发的 token，勿提交仓库
TELEGRAM_CHAT_IDS=      # 你的 chat_id；多个用逗号分隔
```

获取方式（自行完成，勿把真实值贴进 Issue/PR）：

1. Telegram 找 [@BotFather](https://t.me/BotFather) → `/newbot` → 得到 `BOT_TOKEN`
2. 先给 bot 发一条任意消息，再用 `https://api.telegram.org/bot<TOKEN>/getUpdates` 看 `chat.id`，填入 `TELEGRAM_CHAT_IDS`
3. 重启进程后：成交开/平、异常、整点总览会推送到该 chat

未启用或 token/chat 为空时，程序照常跑，只是不发 TG。

---

## 默认参数（可改）

| 所 | 格数 | 杠杆 | 带宽 | 预算 |
|----|------|------|------|------|
| Decibel | 90 | 30x | 中心 ±4% / 外层 ±8% | 1000U × 60% |
| N1 | 100 | 30x | 中心更密（80% 档）/ 外层 ±8% | 1000U × 45% |
| PopDEX | 90 | 30x | 中心 ±4% / 外层 ±8% | 1000U × 60% |
| RISEx | 46 | 25x | 中心 ±4% / 外层 ±8% | 1000U × 60%，挂单硬顶 50 |

各所可用对应 `*_LEVERAGE`、`*_EQUITY_USD`、`*_MARGIN_FRAC` 覆盖。

---

## 目录

```
src/
  grid.ts             # 网格核心：seed / 补反向 / skipBand
  loop.ts             # 主循环：snapshot → 计划 → apply
  config.ts           # 定档 / 锚点 / env 解析
  dashboard.ts        # 看板服务（/api/snapshot 等）
  ledger.ts           # 每日盈亏 / 出入金记账
  officialStats.ts    # 官方量/费/平仓盈亏（节流）
  telegram.ts         # TG 通知
  botControl.ts       # 紧急暂停 / 恢复
  venues/             # 各所适配器（snapshot/apply/cancelAll/closePosition）
    risex.ts decibel.ts decibelLive.ts n1.ts popdex.ts
    index.ts types.ts
public/index.html     # 看板前端（纯静态）
docs/CHALLENGES.md demo-dashboard.html images/
vendor/               # 轻量封装，无密钥
test/                 # 核心网格单测
```

---

## 给 AI / 改代码时

- 策略：`src/grid.ts` · 循环：`src/loop.ts` · 适配器：`src/venues/` · TG：`src/telegram.ts`
- 演示静态页：`docs/demo-dashboard.html`
- 只读看板：`/api/snapshot`；紧急暂停：`POST /api/pause` / `/api/resume`

---

## 免责声明

杠杆与合约有爆仓风险；软件按现状提供，不构成投资建议。注册/推荐链接非投资建议。切勿在 Issue 粘贴私钥。

## License

MIT · 推特 [@aiqiang888](https://twitter.com/aiqiang888)
