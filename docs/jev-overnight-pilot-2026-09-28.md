# Jev 过夜有界研究试运行

2026-09-28 23:25（Asia/Shanghai）启动新一轮独立 Jev 研究，绑定 `confirmed-pvp-v2-estimated-20260928`。上一轮一小时记录保留为 `data/jev-research-pilot-first-run-20260928.json`，本轮不覆盖历史样本。

## 边界

- 最长 8 小时，截止约 2026-09-29 07:25:49（Asia/Shanghai；状态文件使用 UTC 时间字段）。
- 最多 30 次请求，仍保持至少 10 秒间隔、单请求在途、失败不重试。
- 只分析原文与 CA 的关联、事件状态和需求路径；不核实新闻真实性，不预测价格。
- 结果不能写入成交、余额、持仓、签名或广播许可；模拟盘原有入场与退出校验不变。
- 不新增 TG/FOMO 监控，不发送 Telegram/广场消息，不触碰密钥、环境变量或私钥。

## 启动核对

- dashboard 平滑切换后 `status=ok`、`mode=paper`。
- Jev `status=active`、`durationMs=28800000`、`maxCalls=30`。
- 启动约 10 秒时已完成 1 次请求，`execution/signing/broadcast=false`。
- 账户仍为独立模拟盘；本轮不会重置或补充本金。

本轮完成后只做一次只读复盘，报告成功/失败、去重、token、延迟、样本误判与对模拟盘的实际影响；不因少样本或零成交宣称盈利。
