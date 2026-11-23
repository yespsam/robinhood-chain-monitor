# 平台兼容性低频增量检查

- 检查时间：2026-11-13 06:58:27 UTC
- 上次检查：2026-11-13 03:02:53 UTC；间隔约 3 小时 55 分 34 秒，提前目标约 4 分 26 秒。本检查仅为低频采样，不代表持续在线。
- 结论：Git 上游 refs 未变；Flap 文档归档/新入口变化仍在，Flap 文档监控未覆盖新 canonical 页面；HyperEVM 文档采集出现一次可复核的短暂抓取失败。需要人工关注采集覆盖，不是已确认的交易兼容回归。

## 上游 refs 与官方文档

本轮只读 `git ls-remote` 与上次检查比较，五个重点仓库 HEAD 均未变化，未观察到 tag：

- `binance/binance-skills-hub`: `7d1b1f78d525f9e653b96819f91a549302fda1da`
- `four-meme-community/four-meme-ai`: `0a07b65468caa73f552dd6a13013ef5071065996`
- `four-meme-community/fourmeme-docs`: `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`
- `four-meme-community/openfour-docs`: `8ca5554df22ad511126d8547c212fa161ecf19ee`
- `flap-sh/flap-skills`: `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`
- 项目 `origin/main`: `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`

官方页面抽查：

- Flap 旧 [Agent Skills 页面](https://docs.flap.sh/en/flap/skills)仍显示 Archived docs (v1)；官网导航指向 [v2 Agent Skills 页面](https://docs.flap.sh/en/flap/v2/developers/agent-skills)。相较 03:02 检查，本轮没有进一步正文/能力变化。页面描述仍为 Flap BNB Tax Token V3 launcher skill v1.3.0，且从 quote API 读取 BNB Chain 报价 token。它是 token-launch skill，不等同于本地交易执行适配。
- Flap [v2 部署地址文档](https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses)区分 Bonding Curve 与 Pool Launch Portal：Bonding Curve 地址表列有 Robinhood Chain（v5.23.1）；Pool Launch 表述为 BNB Chain 与 BNB Chain Testnet，Portal 为 `0x000042108465206185A077Edc3F3fd2b49060000`。不能把不同 Portal/协议视作同一路径，也不能据文档表直接推断本地链上执行可用。
- Flap [Pool Launch 集成说明](https://docs.flap.sh/en/flap/v2/developers/pool-launch/build-on-pool-launch)仍将 Launcher/Vault Factory 标为 Beta、需 Flap 审核并在 Portal 启用。本轮没有看到新权限状态或实际部署证据。
- Binance [Agentic Wallet 概览](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)当前列 BNB Smart Chain 56、Ethereum 1、Base 8453、Solana CT_501；没有列 HyperEVM。当前文档仍显示 2026-11-12 修改。
- Four.Meme [Agent Skill 页面](https://four.meme/en/agentic)仍列 15 项能力。本轮浏览器对[公告页](https://four.meme/en/announcement)的独立读取返回 403；本地采集状态在 06:32Z 报告 13/13 source-health 健康，二者不一致，因此公告当前可见条目未验证。
- Hyperliquid 官方 [HyperEVM 概览](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm)、[JSON-RPC](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc)及[双区块架构](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture)本轮可读取；重点字段仍为主网 chain ID 999、测试网 998、gas 资产 HYPE、EVM 交互走 JSON-RPC。官方 JSON-RPC 文档仍说明 `eth_getLogs` 最多 4 个 topics / 50 blocks，默认 RPC 不支持需历史状态的请求；默认主网 RPC 无 WebSocket。未发现本轮文档记录的正文变化。

## 本地兼容与采集覆盖

- `src/platform-document-watch.js` 的 Flap seed 仍指向旧 `/flap/developers/...` 路径；没有 `https://docs.flap.sh/en/flap/v2/developers/agent-skills`。当前 Flap 页面采集 59 页全部失败：58 个 `redirect_rejected`、1 个 `document_http_404`。结构化 health 4/5 正常，sitemap 端点 HTTP 404，连续失败 7,035 次。建议人工审核后刷新有限的官方源 URL 清单，并继续校验官方主机与重定向最终地址；本轮没有修改采集器。
- Four.Meme 文档采集为 8/10 健康、2 页因 `redirect_rejected` 失败；结构化 source-health 为 13/13 healthy（06:32Z 快照）。公告页在本次独立浏览器读取中 403，不能因此宣称公告已更新或采集器故障已解决。
- HyperEVM 文档采集为 9/10 健康；`dual-block-architecture` 在 05:17Z 有一次 `document_fetch_failed`。本轮直接读取该官方页面成功，故目前是采集器/传输覆盖缺口，尚无正文或协议回归证据。HyperEVM 的 8 个健康源中 5 healthy、3 degraded；降级项包括两次短暂 fetch failure 和持续的 builder-tools fetch failure。监控记录本轮 0 条正文变化。
- 本地 `src/flap-pool-launch.js` 仍监控限定的 BNB Pool Launch 事件；解析记录默认 `monitorOnly=true`、`autoTradeEligible=false`，并有单独 live eligibility 门控。没有验证交易、签名或广播；该逻辑不构成 Flap Agent Skills 的通用执行器，也不表示支持 Robinhood Chain 的 Flap Bonding Curve。

本轮不运行项目测试；只读检查页面、refs、本地采集状态与源码。未连接钱包、读取秘密配置、签名、广播或下单；未改交易策略、源清单、代码或配置，未部署/重启，未 push/merge。
