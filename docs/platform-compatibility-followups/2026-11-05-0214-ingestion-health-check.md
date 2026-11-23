# 上游与采集健康核对 — 2026-11-05 02:14 UTC

## 结果

六个受跟踪 GitHub 引用均未变化：Binance Skills Hub `96563daf34fa5a87af5d76c2f1107d697ae7ce07`、Four.Meme AI `0a07b65468caa73f552dd6a13013ef5071065996`、Four.Meme docs `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`、OpenFour community/reference docs `6f7efd5d3f14ed280cf471f70675ffba6d319943`、Flap skills `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`、项目 `main` `25335e6443128a099307b33fdd57844b3df65821`。OpenFour 仍是未确认官方归属的社区参考，不作平台规则。

## 官方资料抽查

本次通过独立页面读取确认：

- [Flap Robinhood Chain Integration Guide](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide)：RH 文档列出 `TOKEN_V2_PERMIT`/`newTokenV5` 与 `TOKEN_TAXED_V3`/`newTokenV6`，只支持 `V2_MIGRATOR`，迁移 DEX 为 Uniswap V2 原生 fork。此范围不能外推到任意 CA 或其他链。
- [Flap Skills](https://docs.flap.sh/en/flap/skills)：兼容该 skill 格式的 agent 均可使用；当前列出的 launch skill 是 BNB Chain Tax Token V3 路径，quote token 从 Flap 支持项动态解析。
- [Four.Meme How it works](https://four-meme.gitbook.io/four.meme/guide/how-it-works)：说明其内部池的多 quote 选择及达成阈值后的 Pancake 配对流程；不构成本地适配或任意 token 买卖保证。

## 本地覆盖故障

`data/platform-capability-state.json` 在本轮报告的最新快照显示：

- Flap 本地文档监视 59/59 页均为失败；平台健康计数为 1,876 次连续超时，最近成功时间 `2026-11-04T14:26:01.597Z`，最近尝试 `2026-11-05T02:14:15.086Z`。
- Four.Meme 本地文档监视 10/10 页均为失败；健康计数为 1,239 次连续失败，最近成功时间 `2026-11-04T13:47:18.750Z`，最近尝试 `2026-11-05T02:14:26.916Z`；官网部分页面仍返回 403。
- 与此同时，本次独立页面读取可访问 Flap 官方指南/skills 页面和 Four.Meme 官方 GitBook 页面。因此这证明本地采集覆盖退化，不能据此断言上游站点整体宕机。

## 本地兼容性与限制

未发现新上游提交，也未发现本地相关交易源码自上轮检查后有修改。由于无相关代码差异，本轮不重复运行测试；上轮 53 项 focused tests 是离线 mock，不是生产交易验证。Flap Pool Launch 是否有意进入被 GMGN live mirror 消费的 confirmed paper session，仍需人工确认部署版本和配置。生产环境变量、服务版本、真实订单均未读取或确认。GMGN 替换止损“新单创建成功但旧单取消失败”的模拟风险仍需人工核对活动订单，不应盲目重试。

本轮没有读取秘密、连接钱包、执行签名/广播/交易、修改交易参数或代码、部署/重启、push/merge。

## 下一步

定位本地 Flap/Four.Meme 文档抓取器的 timeout/403 失败路径，查清它与独立可读页面之间的差异；不绕过站点访问策略，不以重试成功伪造覆盖。另保留 Robinhood Chain 4663 的本地观察器未覆盖缺口及 fail-closed 行为。
