# GitHub main LIVE 入场门槛与采集健康 — 2026-11-05 14:21 UTC

## 本轮结论

五个受监控平台仓库的 `main` SHA 未变；项目 GitHub `main` 从 `25335e6443128a099307b33fdd57844b3df65821` 前进到 [`12316231628f6efd5a2b477138dc8f2b8e33887e`](https://github.com/yespsam/robinhood-chain-monitor/commit/12316231628f6efd5a2b477138dc8f2b8e33887e)，提交标题为 **Gate LIVE entries on consecutive losses and paper SQN (#6)**。

这不是交易路由/ABI 上游变化，但会影响本地 LIVE 入场授权，值得单独审阅。提交在 `src/paper-strategy-engine.js` 对 Flap/内盘曲线入口计算门槛并只在允许时创建 `liveLadder`；纸面买入仍会记录。默认值是最近 3 笔 LIVE 平仓全亏则暂停，以及至少 30 笔纸面平仓且 `paperSqn >= 1.6`；示例环境文件说明把相应 `LIVE_REQUIRE_PAPER_*` 或连亏项设为 `0`/`false`/`off` 可关闭该门槛。

## 兼容性与风险审阅

- 当前 checkout 是 `codex/paper-focus-forward-simulation`、HEAD `817ff9fc8a79a12137e1658cfb45b343e4c7f46e`，仍含大量 staged/unstaged/untracked 用户改动；其中另有未提交的 LIVE GMGN mirror/trader 文件。它既不是刚检查的 GitHub `main`，也不能代表 Grok/本机实际运行的版本。没有读取运行时配置、秘密或进程环境；实际是否部署了此门槛、交易执行来源和已有订单状态均未知。
- GitHub `main` 这次提交在自身代码注释中说明，门槛仅由 paper strategy engine 在创建 LIVE ladder 前调用；没有由此证明真实签名/广播路径已集成，也没有证明当前运行服务受其保护。测试只验证纯函数/纸面状态。
- `src/paper-sqn.js` 将每个完整回合的 `realizedPnl` 美元数值直接作为 SQN 输入，没有按每笔初始风险归一成 R 倍数。测试明确展示 30 个完全相同的正数会得到 `Infinity` 并允许晋级。因此该阈值不能被当作稳健的风险调整绩效证明；在依赖它开放 LIVE 之前需人工评估样本来源、费用口径、风险单位和零方差处理。未更改代码或门槛。
- 门槛的显式紧急关闭选项是可配置旁路；因真实部署配置未知，不能据代码默认值断言它当前有效。

## 上游交易兼容性

本轮 `git ls-remote` 的平台仓库头仍为：Binance Skills Hub `96563daf34fa5a87af5d76c2f1107d697ae7ce07`、Four.Meme AI `0a07b65468caa73f552dd6a13013ef5071065996`、Four.Meme docs `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`、OpenFour community/reference `6f7efd5d3f14ed280cf471f70675ffba6d319943`、Flap skills `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`。OpenFour 的官方归属仍未确认。

官方 Flap Robinhood 指南当前仍限定为 `TOKEN_V2_PERMIT` (`newTokenV5`) 或 `TOKEN_TAXED_V3` (`newTokenV6`)、`V2_MIGRATOR`，并要求先核对链上报价配置；因此不能把本地入口门槛误读成任意 CA、任意 token 版本均可买卖。见 [Flap Robinhood 集成指南](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide)。Flap 的通用技能页称其 agent skill 可由多种兼容助手使用；这不扩大上述链/版本边界，见 [Flap Skills](https://docs.flap.sh/en/flap/skills)。Four.Meme 的多报价资产说明针对其内部池和迁移流程，不表示该项目的任意 CA 都可由本地路由交易，见 [Four.Meme 工作机制](https://four-meme.gitbook.io/four.meme/guide/how-it-works)。

## 采集覆盖故障

`data/platform-capability-state.json` 本轮快照仍显示 Flap 文档 59/59 页失败、Four.Meme GitBook 文档 10/10 页失败；页面错误分类为 `document_fetch_failed`，另有来源健康记录为超时。Flap 与 Four.Meme 最近成功的持久化文档页时间仍分别在 2026-11-03/04；因此平台更新摄取未恢复，不能依据此本地 watcher 状态宣称已覆盖最新规则。上轮已确认的 Flap 路径故障仍是安全候选根因：旧 `/flap/...` 走 308 至 `/en/flap/...`，collector 保留手动重定向拒绝且 allowlist 尚未接纳 canonical 路径；必须经人工审阅后改种子/精确 allowlist，不能放宽成任意跟随 3xx。Four.Meme worker 与当前 shell 的网络上下文/版本差异仍未解释。

## 验证与边界

- `node --test test/live-entry-gates.test.js test/paper-sqn.test.js`：9 passed，0 failed。
- `node --test test/platform-document-watch.test.js`：12 passed，0 failed。
- 均为本机当前脏 checkout 上的离线测试/夹具；不验证生产配置、运行进程、实际报价、交易或上游合约状态。
- 未检查 `.env`/密钥、未连接钱包、未签名或广播、未买卖、未改代码或策略、未重启/部署、未 push/merge。

## 下一步

需要人工确认当前实际交易/监控服务运行的 commit 与非秘密的生效门槛状态；在依赖此 LIVE gate 前审阅 SQN 是否应按净 R 值计算以及 `Infinity`/显式禁用情形。监控采集方面，先为 Four.Meme worker 取得脱敏的错误类别与请求耗时，再人工审阅 Flap canonical `/en` seeds/allowlist 修复。保持交易失败时 fail-closed，不以绕过门槛或无限重试代替诊断。
