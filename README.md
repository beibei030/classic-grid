# Classic Grid — 五所经典网格（开源）

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](./package.json)
[![Twitter](https://img.shields.io/badge/Twitter-@aiqiang888-1DA1F2.svg)](https://twitter.com/aiqiang888)

等差网格：现价下买上卖，**成交后补相邻反向单**；启动校验格距 > 双边手续费、保证金预检。

适配器：**Extended · RISEx · Decibel · N1 · Phoenix**

> 开源模板，**不含私钥 / API Key / Telegram Token / 服务器地址 / 账本文件**。  
> 下图为看板界面示意（无密钥、无地址）。推特：[@aiqiang888](https://twitter.com/aiqiang888)

![Dashboard](docs/images/dashboard-ui.png)

---

## 注册链接

| 交易所 | 链接 |
|--------|------|
| **Decibel** | https://app.decibel.trade/r/K7B2QM |
| **Phoenix** | https://phoenix.trade/?code=YNS0TXV0 |
| **Extended** | https://app.extended.exchange/join/AIQIANG888 |
| **N1** | https://app.n1.xyz/r/orderly-loop-curve |
| **RISEx** | https://rise.trade/（暂无推荐码） |

---

## 功能一览

- 多所统一 `VenueExecutor`：`snapshot` / `apply` / 可选 `cancelAll`·`closePosition`
- 经典网格核心：`seed` 铺单 + 成交补反向档 + `skipBand`
- 本地看板：总览 KPI、今日明细、四所状态、挂单档位横轴（看匀不匀）
- 官方量 / 费 / 平仓盈亏（节流拉取，避免内存爆）
- Telegram：开/平简报、整点总览（可选）
- `SOFT_RESUME`：重启恢复锚点，避免误整表撤单

---

## 我们解决过什么（摘要）

完整版 → [`docs/CHALLENGES.md`](./docs/CHALLENGES.md)

| 难题 | 解法要点 |
|------|----------|
| 成交后网格断档 | 买→上邻卖 / 卖→下邻买，每 level 一单 |
| 重启冲掉挂单 | `SOFT_RESUME` + 本地锚点，只补漏 |
| 官方统计 OOM | 2 分钟节流 + 加大 Node 堆；展示≠轻量拉取 |
| 各所盈亏口径不一 | Ex 用已平仓 history；Rise/Dec 用 fill realized 等 |
| 仓位名义差很多 | 多为净仓路径不同，先对满格名义再对净格数 |
| 限流 / 挂单上限 | `maxOpenOrders`、写频、间隔、错误去重 |
| Decibel tick/lot | 编码前对齐 |
| mid「缺一档」惊吓 | 买卖分界缝，不是漏单 |

---

## 怎么跑起来

1. `npm install`
2. 复制环境模板（**只在本机填密钥，永远不要提交 `.env`**）：

```bash
cp .env.example .env
```

3. 按需填写 `.env`（变量名见模板注释；值为空表示未配置）  
   - 各所 API / 私钥 / keypair 路径（`secrets/*.json`，已在 `.gitignore`）  
   - `VENUES=` 只开你有密钥的所，例如 `extended,phoenix`  
   - 默认 `DRY_RUN=1`（模拟）；实盘须同时：`DRY_RUN=0` 且 `LIVE_CONFIRM=YES`
4. 试跑一轮：`DRY_RUN=1 npm start -- --once`  
   看板：`http://127.0.0.1:8088/`（`/api/snapshot`）
5. **禁止**提交 `.env` / `secrets/` / `data/`；见 [`SECURITY.md`](./SECURITY.md)

### VPS 私网看板（无域名）

看板强制监听回环地址，不要向公网开放 `8088`：

```env
DASHBOARD_HOST=127.0.0.1
DASHBOARD_PORT=8088
```

在 VPS 安装并登录 Tailscale 后，将本机看板发布到 tailnet：

```bash
sudo tailscale up
sudo tailscale serve --bg 8088
tailscale serve status
```

使用命令输出的 `https://<设备名>.<tailnet>.ts.net` 地址访问。只有 tailnet 中获准的设备/用户可访问。使用 `tailscale serve`，不要使用会公开到互联网的 `tailscale funnel`。

Windows：

```powershell
Copy-Item .env.example .env
$env:DRY_RUN="1"; npm start -- --once
```

### Telegram 报警（可选）

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

### 给 AI / 改代码时

- 策略：`src/grid.ts` · 循环：`src/loop.ts` · 适配器：`src/venues/` · TG：`src/telegram.ts`
- 演示静态页：`docs/demo-dashboard.html`

---

## 默认参数（可改）

| 所 | 格数 | 杠杆 | 备注 |
|----|------|------|------|
| Extended | 80 | 30x | 半幅约 ±4.6% |
| Decibel / N1 | 65 | 30x | 同上 |
| RISEx | 46 | 25x | 半幅约 ±3% |
| Phoenix | config / env | env | Solana 永续 |

`GRID_MARGIN_FRAC` 默认 `0.7`。

### 网格重心化

重心化默认关闭。先使用独立账户/子账户并在 `DRY_RUN=1` 验证：

```env
GRID_RECENTER_ENABLED=1
GRID_RECENTER_RATIO=0.65
GRID_RECENTER_CONFIRM_TICKS=3
GRID_RECENTER_COOLDOWN_MS=600000
GRID_RECENTER_CANCEL_TIMEOUT_MS=900000
GRID_RECENTER_MAX_POSITION_USD=1
```

- 市价连续 3 轮偏离锚点达到半带宽的 65% 后触发。
- 只撤销本次进程从交易所下单回执中确认过 ID 的订单；不会按价格猜测或全市场撤单。
- 发现旧进程、人工或其他策略挂单时立即暂停，不新增也不撤销，需人工检查并重启。
- 持仓名义超过阈值、撤单超时或撤单期间出现持仓时暂停重铺。
- 撤单在交易所快照确认完成后才用当前价格建立新锚点；两次重心化默认间隔至少 10 分钟。
- 启用时 `MARKETS` 只能配置一个市场。

Phoenix 当前下单接口不能可靠回传可匹配的订单 ID，因此 Phoenix 实盘开启重心化会直接拒绝启动；不要为绕过保护而改成全市场撤单。

---

## 目录

```
src/grid.ts venues/ loop.ts dashboard.ts officialStats.ts telegram.ts
public/index.html
docs/CHALLENGES.md demo-dashboard.html images/
vendor/   # 轻量封装，无密钥
test/
```

---

## 免责声明

杠杆与合约有爆仓风险；软件按现状提供。推荐链接非投资建议。切勿在 Issue 粘贴私钥。

## License

MIT · 推特 [@aiqiang888](https://twitter.com/aiqiang888)
