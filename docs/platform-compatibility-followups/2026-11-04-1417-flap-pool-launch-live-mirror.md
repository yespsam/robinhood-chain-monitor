# 平台兼容性增量复核 — 2026-11-04 14:24 UTC

## 重要发现：项目 GitHub main 改变了 Flap 新池信号的 live-eligible 路径

检查的 GitHub `main` 当前为 [`e1f0eb561624c08dd17dd977728d9a89001826ab`](https://github.com/yespsam/robinhood-chain-monitor/commit/e1f0eb561624c08dd17dd977728d9a89001826ab)，提交标题为 `Make Flap Pool Launch live-eligible via paper-atm-confirmed-pvp-v2`。五个外部监控仓库的 main SHA 与上轮一致；这是项目自身新增行为，不是 Binance、Four.Meme 或 Flap 上游发布。

该提交将 BNB Chain（chainId 56）Flap Portal 已识别的 `DIRECT_V2_POOL_TAX` / `V2_POOL_LAUNCH_SCHEMA_V1` 事件接入 `paper-atm-confirmed-pvp-v2` 确认型模拟信号。提交中的 `src/flap-pool-launch.js` 依据官方 Portal、schema 与池地址生成 `liveEligible/autoTradeEligible/automaticExecution`，并让 `src/flap-pool-launch-signal.js` 将不超过 120 秒的事件送入现有模拟入口。未知 schema 保持只观察；这不是“所有 CA 均可交易”，也不覆盖 Robinhood Chain 4663。

### 实盘影响边界

- `docs/flap-pool-launch.md` 明确写明：确认型模拟账本 `paper-atm-confirmed-pvp-v2` 已被 live GMGN mirror 映射到买单。`src/live-gmgn-mirror.js` 只消费该来源的新确认型模拟买入；`src/live-gmgn-trader.js` 要求 `LIVE_TRADING_ENABLED === "true"`，且仍通过钱包/链、策略 allowlist、信号时效、余额/仓位、日亏损、报价和现有风险闸门。
- 新增 `LIVE_FLAP_POOL_LAUNCH` 的默认值为开启：仅明确设置为字符串 `false` 才关闭。`.env.example` 顶部也写为 `LIVE_FLAP_POOL_LAUNCH=true`。因此若部署的真实运行配置已启用 `LIVE_TRADING_ENABLED=true`，且该来源和其余 live gates 允许，这类新池可能由模拟账本触发实盘镜像买入；本轮没有读取 `.env`、部署秘密或运行时配置，不能确认该条件是否成立，也没有证据证明已发生实盘买入。
- 如不希望新 Flap Pool Launch 事件进入既有实盘镜像，应由操作人员核实运行环境并显式设置 `LIVE_FLAP_POOL_LAUNCH=false`；本轮没有修改配置、重启或代为停用。

### 本地版本与测试

请求检查的本地分支为 `codex/paper-focus-forward-simulation`，HEAD `817ff9fc8a79a12137e1658cfb45b343e4c7f46e`，不是上述 GitHub main commit；工作区有大量 staged/unstaged 用户改动。工作区中已存在 staged 的 `src/flap-pool-launch.js`、`src/flap-pool-launch-signal.js`、测试与文档新增，以及未提交的 `src/paper-strategy-runtime.js` 路径接线，能看到同一类 live-eligible 设计。无法仅凭本地文件确定哪个进程/部署正在运行，故不把该工作树等同 GitHub main 或生产版本。

只运行离线 focused tests：

```text
node --test test/flap-pool-launch.test.js test/live-gmgn-trader.test.js
49 passed, 0 failed
```

这验证了事件/schema 解析、模拟信号、mock live gates、mirror 的基础闸门与下单接口测试；不验证真实 `.env`、当前运行版本、实际 Flap 事件、线上报价/流动性、真实 GMGN CLI、实际成交或 live mirror 到新来源的端到端生产行为。测试未触发钱包、CLI、签名或广播。

## 平台官方文档和采集覆盖

- 当前直接 HTTP 只读检查：Flap [Pool Launch 文档](https://docs.flap.sh/en/docs/pool-launch) 和 [Robinhood 集成指南](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide) 均返回 200；官网 sitemap 和 `llms.txt` 仍为 404。文档可读不等于本地自动采集已恢复。
- 本地 `data/platform-capability-state.json` 快照：59/59 条 Flap 文档观察页为 `failed`，Robinhood 集成指南已连续失败 463 次；Flap 官网/市场采集在 14:23:35Z 有 90 次连续传输超时，最近一次成功 13:56:26Z。说明当前是本地采集/传输覆盖缺口，独立请求可读指南时不要误报为官网不可用。
- Four.Meme `/en/agentic` 直接请求返回 403；本地 10/10 条 GitBook 观察页在 14:23Z 快照均为 `failed`，source health 有 62 次连续传输失败，公开配置 API 有 1,918 次连续失败。14:17Z 独立直连 [How it works](https://four-meme.gitbook.io/four.meme/guide/how-it-works) 返回 200。动态官网/API采集不健康，但这不是项目平台中断或交易失败的证据。

## 处理结论

这是需要人工确认的交易行为闸门变化，而不是本轮替用户修改实盘策略。若当前 live 镜像正在运行，请先检查部署进程实际采用的 revision 和 `LIVE_FLAP_POOL_LAUNCH` / `LIVE_TRADING_ENABLED`，并确认是否希望该信号源参与 live mirror；不要依据 `.env.example` 推断真实配置。若要保持旧行为，明确关闭该源后再按既有运维流程验证。当前 Flap 文档采集持续异常，建议后续修复同源 locale URL 规范化和确定性错误退避；本轮不改源码。

本轮仅读取公开 Git refs/patch、公开文档、现有本地状态、普通源码与离线 mock 测试；没有读取 `.env`/密钥/绑定钱包，没有连接钱包、签名、广播、mint、买卖、部署、重启、push/merge，也未改任何交易源码或策略配置。
