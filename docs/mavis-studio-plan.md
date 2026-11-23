# 马维斯式交易工作室（Mavis Studio）方案

参考：腾讯 Marvis（马维斯）多 Agent 体系 https://marvis.qq.com/docs/agent-system
——「主 Agent 总指挥 + 若干专项 Agent 并行干活 + 工作室界面让每个 Agent 的状态/中间结果可见 + 关键动作必须人工确认（L2 兜底）」。

## 映射到实盘系统

| 马维斯角色 | 本系统角色 | 进程 | 产出 |
|---|---|---|---|
| 主 Agent（总指挥） | conductor 指挥台 | `scripts/studio/conductor.js` | 拉起/守护各 bot，汇总 `data/studio/board.json` |
| Search/App Agent | 行情·评分 bot | `scripts/studio/market-bot.js` | 价格、钱包权益、总盈亏%、每个代币评分 → `market.json` |
| Computer Agent（安全兜底） | 风控 bot | `scripts/studio/risk-bot.js` | 上限、日亏损线、gas 储备、敞口检查 → `risk.json` |
| App Agent（执行） | 跟单 bot | `scripts/studio/copy-bot.js`（观察者） | 执行器心跳、最近决策/成交 → `copy.json` |
| 工作室界面 | 手机 HUD 看板 | `scripts/mobile-live-server.js` | `/api/live` 读 board.json，显示盈亏%、评分、各 bot 在线状态 |

## 运行原则
- 每个 bot 是独立 Node 进程，各自循环、各自写 `data/studio/<role>.json`（含 `heartbeat`），一个挂掉不影响别的；conductor 自动重启。
- 真实下单仍只由现有执行器 `src/live-gmgn-mirror.js`（在 `src/index.js` 内）完成；copy-bot 只读监控，不重复下单，避免双开。后续可把执行器迁入 copy-bot，前提是先停掉 index.js 里的镜像。
- 风控 bot 只出信号（ok/warn/halt），目前不自动改开关；“停止实盘”属关键动作，需人工确认。
- 看板只读，30 秒刷新。

## 总盈亏% 口径
权益 = BSC(BNB+USDT) + SOL 钱包，用 Binance 现价折 USD。基准 = 第一次快照的权益（`data/studio/baseline.json`，可用环境变量 `STUDIO_BASELINE_USD` 覆盖为真实入金额）。盈亏% = (当前权益 − 基准)/基准。币价波动也会计入。

## 代币评分（0–100）口径
起点 50：成交 +20；系统可执行链（LIVE_CHAINS 内）+10，否则 −15；有 paperUsd 信号 +5；跳过 −10，报错 −25；原因含 流动性/蜜罐/税/风险 −15；12 小时内信号 +5。透明启发式，不是收益预测。

## 启动
`node scripts/studio/conductor.js`（后台：`nohup … &`）。
