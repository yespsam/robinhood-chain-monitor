# Flap Agent Skills 文档路由迁移检查

- 检查时间：2026-11-13 03:02:53 UTC
- 上次检查：2026-11-12 22:55:50 UTC；间隔约 4 小时 7 分 3 秒，晚于四小时目标约 7 分钟。仅为低频采样，不代表持续在线。
- 结论：发现 Flap 官方文档覆盖变化，需要人工审核监控源 URL；没有发现新交易协议或本地交易能力变化。

## 上游证据

官方旧入口 [Flap Skills](https://docs.flap.sh/en/flap/skills) 现在明确标为 archived/legacy v1。上次检查时该页仍作为当前的 Flap Skills for AI Agents 页面显示。Flap 官网导航现在指向 [v2 Agent Skills](https://docs.flap.sh/en/flap/v2/developers/agent-skills)。该页面描述的是 Flap BNB tax-token launcher skill v1.3.0，仅支持 Tax Token V3，报价 token 通过 quote API 获取。观察到的是官方文档路径/归档迁移；不能据此推断新增发射台、上线、部署或可交易性。

本轮抽查的官方仓库 HEAD 未变化、未见 tag：

- `binance/binance-skills-hub`: `7d1b1f78d525f9e653b96819f91a549302fda1da`
- `four-meme-community/four-meme-ai`: `0a07b65468caa73f552dd6a13013ef5071065996`
- `four-meme-community/fourmeme-docs`: `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`
- `four-meme-community/openfour-docs`: `8ca5554df22ad511126d8547c212fa161ecf19ee`
- `flap-sh/flap-skills`: `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`
- 项目 `origin/main`: `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`

其他官方页面抽查：

- [Binance Agentic Wallet 概览](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)：本轮未观察到相关链/交易能力变化。
- [Four.Meme Agent 页面](https://four.meme/en/agentic)：仍列 15 项能力；[公告页](https://four.meme/en/announcement)最新可见公告仍为 2026-02-02。
- [Hyperliquid HyperEVM 开发文档](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm)：抽查页面未记录新变化。

## 本地影响与覆盖

- Flap 文档采集器仍是 59/59 页失败，`https://docs.flap.sh/sitemap.xml` 返回 HTTP 404，连续失败计数 7,025。新 canonical Agent Skills URL 不在现有可用覆盖中；这属于文档监控缺口，不等同于交易程序故障。
- Four.Meme 为 2/10 页失败、13/13 source-health endpoint 正常。HyperEVM 为 10/10 页成功、无记录变化；3/8 health endpoint 的旧降级错误仍自 2026-11-07 持续。
- `src/flap-pool-launch.js` 仍只解析 BNB Chain（chainId 56）的 Flap Pool Launch 事件，并标记 `monitorOnly=true`、`autoTradeEligible=false`。它不是 Agent Skills 发射器，也没有由本次文档迁移证据支持的买卖适配。
- 建议人工审核后，将官方 v2 Agent Skills 页面纳入有界文档源清单，并保留 HTTPS 官方主机校验与重定向最终地址校验。此次没有修改代码或源清单。

## 检查边界

本轮只读检查官方页面、Git refs 和本地采集器状态；未运行项目测试。未连接钱包、读取秘密配置、签名、广播或下单；未改策略/代码/配置，未部署/重启，未 push/merge。
