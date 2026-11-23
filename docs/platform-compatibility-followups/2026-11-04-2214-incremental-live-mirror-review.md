# 平台兼容性增量复核 — 2026-11-04 22:14 UTC

## 上游变化

- Binance Skills Hub、Four.Meme AI、Four.Meme docs、OpenFour docs、Flap skills 五个 GitHub 头部 SHA 与 18:15Z 检查点一致；项目 `main` 仍为 [`25335e6443128a099307b33fdd57844b3df65821`](https://github.com/yespsam/robinhood-chain-monitor/commit/25335e6443128a099307b33fdd57844b3df65821)。本轮未发现新的平台仓库提交或 release。
- 当前可访问的 Flap [Portal 发币指南](https://docs.flap.sh/en/flap/developers/token-launcher-developers/launch-token-through-portal)列出一般入口 `newTokenV6`（标准与税币）和 `newTokenV7`（`TOKEN_V3_PERMIT`）；Flap [Robinhood 专页](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide)则明确 RH Chain 仅支持 `TOKEN_V2_PERMIT` / `newTokenV5` 与 `TOKEN_TAXED_V3` / `newTokenV6`、`V2_MIGRATOR` 和原生 ETH 报价。两页是不同网络/发射范围，不应把一般 Portal 说明视作 RH 支持扩展；本轮没有发现使现有 BSC 解码 ABI 需要变更的证据。
- [Four.Meme 官方 GitBook 页面](https://four-meme.gitbook.io/four.meme/guide/how-it-works)当前仍描述多种内盘报价资产及交易费，但不能据此推出本地对任意 CA 的买卖兼容。

## 本地 live 镜像路径（需人工核对）

GitHub `main` 的 Flap Pool Launch 功能会把已识别的 BSC `DIRECT_V2_POOL_TAX` 事件送入 `paper-atm-confirmed-pvp-v2`。同一来源被 live GMGN mirror 消费；`LIVE_FLAP_POOL_LAUNCH` 在代码中默认开启，只有明确设为字符串 `false` 才关闭。因此，当且仅当正在运行的版本包含该逻辑、`LIVE_TRADING_ENABLED=true`、镜像来源/链允许且其余实时证据、报价、余额、仓位与损失闸门通过时，该新池来源才可能进一步触发真实 GMGN 买入。监控器本身不签名或广播；这一整条 live 条件是否成立、实际部署版本及订单均未检查，本轮没有证据证明有实盘成交。

若不希望新增 Flap Pool Launch 信号进入现有 live 镜像，操作人员应在部署环境核实后显式设置 `LIVE_FLAP_POOL_LAUNCH=false`；本轮没有读取环境变量、改配置、重启或执行交易。先前发现的“新止损创建成功但撤旧单失败仍返回成功、且无自动重试”也仍待人工复核，生产影响未知；不要盲目重试撤单，应先核对实际活动订单。

## 覆盖与验证

- 本地 `data/platform-capability-state.json` 最新状态（约 22:13Z）：Flap 59/59 个跟踪文档页失败，RH 指南连续失败 484 次，Flap 源健康连续超时 1,239 次（上次成功 14:26Z）；Four.Meme 源健康连续失败 840 次，GitBook 跟踪页超时 342 次，官网相关端点 403。当前 Web 直接读取 Flap 两个官方指南及 Four.Meme GitBook How-it-works 页面成功。结论是本地采集/传输覆盖持续退化，不是官方平台整体不可用的证据。
- 离线测试：`node --test test/flap-pool-launch.test.js test/live-gmgn-trader.test.js test/gmgn-stop-amend.test.js` — 53 通过、0 失败。测试用夹具/模拟，不覆盖生产环境变量、部署版本、Flap 新池到 live mirror 的完整线上流程、GMGN 实际订单或成交。
- 本地分支 `codex/paper-focus-forward-simulation` HEAD `817ff9fc8a79a12137e1658cfb45b343e4c7f46e`，工作树有大量 staged/unstaged/untracked 用户改动。不能将其等同当前部署版本。未读取 `.env`/密钥或绑定钱包；未连接钱包、签名、广播、交易、改策略/源码、部署、重启、push 或 merge。

## 结论

外部平台 GitHub refs 没有增量变化；主要未解决事项是项目新 Flap Pool Launch 信号可进入既有模拟至实盘镜像链路，以及本地官方资料采集仍严重退化。请人工确认当前实盘部署是否有意启用该来源，并在不暴露密钥的前提下核对运行 revision/开关；本轮未代为关闭或更改任何实盘设置。
