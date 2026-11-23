# 官方源访问间断与增量检查

- 检查完成：2026-11-15 05:31:44 UTC；上次检查完成：01:35:46 UTC；间隔 3 小时 55 分 58 秒，比四小时目标提前 4 分 02 秒。低频抽样，不代表连续在线。
- 结论：上游仓库 ref/tag 和可访问官方文档未见实质规则变化。上一轮记录的 Four.Meme 公共配置接口 HTTP 502 已在当前本地采集快照中恢复；本轮 Four.Meme 公告页抓取返回 403，Flap FSI 文档抓取返回 `UnexpectedStatusCode`，需作为来源覆盖缺口记录，不推断为交易故障。

## Git refs

约 05:30 UTC 使用 `git ls-remote --heads --tags` 核对，跟踪 refs 与上轮相同，无 tag：

| 来源 | main SHA |
|---|---|
| `binance/binance-skills-hub` | `7d1b1f78d525f9e653b96819f91a549302fda1da` |
| `four-meme-community/four-meme-ai` | `3918818c064878f577159c0a144323d38c55612b` |
| `four-meme-community/fourmeme-docs` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` |
| `four-meme-community/openfour-docs` | `8ca5554df22ad511126d8547c212fa161ecf19ee` |
| `flap-sh/flap-skills` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` |
| 项目 GitHub main | `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1` |

## 官方文档检查

- [Binance Agentic Wallet 文档](https://developers.binance.com/en/docs/products/agentic-wallet/welcome) 仍列 BSC 56、Ethereum 1、Base 8453、Solana `CT_501`，未列 HyperEVM。
- [Four.Meme Agentic 页面](https://four.meme/en/agentic) 可读，仍列 15 项能力并链接 `four-meme-community/four-meme-ai`；[公告页](https://four.meme/en/announcement) 本轮直接抓取返回 HTTP 403，因此本轮不确认公告列表最新日期或内容。上一轮可读时最新可见日期为 2026-02-02。
- [Flap Agent Skills](https://docs.flap.sh/en/flap/v2/developers/agent-skills) 与 [Flap Apps](https://docs.flap.sh/en/flap/v2/developers/flap-apps) 可读且内容未见状态变化；前者仍描述 BNB Tax Token V3 v1.3.0，后者仍为 Draft/Coming。直接读取 [Flap Shared Indexer 页面](https://docs.flap.sh/en/flap/v2/developers/flap-infrastructures/flap-shared-indexer) 时工具返回 `UnexpectedStatusCode`，所以本轮未重新核实 FSI 内容；其 Beta/endpoint 未公布状态仍以先前官方核验为准。
- [HyperEVM 概览](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) 与 [JSON-RPC 文档](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc) 可读，仍列主网 999/测试网 998、HYPE gas、默认 RPC 不支持历史状态、`eth_getLogs` 最多 4 个 topics / 50 blocks。

仓库归属按官方交叉证据处理：Binance 官方文档链接 Skills Hub；Four.Meme 官方 Agentic 页面链接 AI 仓库；Flap 官方文档导航指向 Flap Skills。OpenFour 本轮未从官网重新核实，仍按 community/reference。

## 采集健康及本地影响

- `data/platform-capability-state.json` 最新结构化健康快照：Four.Meme `healthy/complete`，最近尝试/成功 `2026-11-15T05:30:09.382Z`；上一轮 `01:34:46Z` 对 `https://four.meme/meme-api/v1/public/config` 的 HTTP 502 已不再出现在最新状态中。恢复仅指采集器状态恢复，不表示链上交易验证。
- Flap 当前为 `partial`，既有 sitemap `https://docs.flap.sh/sitemap.xml` 返回 HTTP 404；Agent Skills 与 Apps 页面本轮可读。HyperEVM 为 `healthy/complete`，最近成功采集 `05:29:43Z`。
- 公告页 403 与 FSI 文档工具读取失败会降低该轮文档覆盖；这不证明 Four.Meme 或 Flap 的交易端点/合约不可用，也没有本地买卖回归证据。未因无源码或 ABI 变化而运行交易测试。
- 未连接钱包、未读秘密或生产 `.env`、未签名/广播/下单、未改源码/配置/策略、未部署/重启、未 push/merge。
