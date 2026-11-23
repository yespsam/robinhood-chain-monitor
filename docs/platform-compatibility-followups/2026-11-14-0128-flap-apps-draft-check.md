# 平台兼容性低频增量检查

- 检查时间：2026-11-14 01:28:34 UTC
- 上次检查：2026-11-13 21:36:05 UTC；间隔约 3 小时 52 分 29 秒，比四小时采样目标提前约 7 分 31 秒。本轮仍是离散采样，不代表持续在线。
- 结论：五个上游仓库和项目 `HEAD/main` SHA 均未变；HyperEVM 官方文档内容/页面状态无异常。本轮补充核验到一个与用户监控范围相关的 Flap 官方“Flap Apps”草案路线图：应用 launchpad 仍处于开发预览/Coming 阶段，不能等同于新代币发行机制、已上线服务或本地交易支持。Flap 文档 watcher 仍未覆盖当前 v2 页面且旧页面队列全部失败，需人工评估来源清单。

## 上游提交与官方归属

本轮只读 `git ls-remote` 检查五个重点仓库以及项目公开 `HEAD/main`。对比 2026-11-13 21:36Z 均未变，未见 tag refs：

- `binance/binance-skills-hub`: `7d1b1f78d525f9e653b96819f91a549302fda1da`
- `four-meme-community/four-meme-ai`: `0a07b65468caa73f552dd6a13013ef5071065996`
- `four-meme-community/fourmeme-docs`: `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`
- `four-meme-community/openfour-docs`: `8ca5554df22ad511126d8547c212fa161ecf19ee`
- `flap-sh/flap-skills`: `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`
- 项目 `yespsam/robinhood-chain-monitor`：`96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`

官方归属仍按可交叉确认的站点/文档关系分类：Binance Agentic Wallet 文档链接 Skills Hub；Flap 官方 v2 文档链接 Flap Skills 仓库；Four.Meme 官方 OpenFour Integration 页面此前确认链接 `four-meme-community/openfour-docs`（本轮该 GitBook Markdown 页面 fetch 失败，沿用上次站点交叉证据，不把本轮读取失败记成内容变化）。OpenFour 公开示例合约注明未审计/仅供参考，不能作平台部署或实盘规则证据。

## 官方文档与新候选

- Binance [Agentic Wallet 官方概览](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)仍列 BSC 56、Ethereum 1、Base 8453、Solana `CT_501`；不列 HyperEVM。Skills Hub 内静态示例的其他链不能证明实时钱包支持或账户授权。
- Four.Meme [公告页](https://four.meme/en/announcement)可读，最新可见条目日期仍是 2026-02-02；[Agentic 页面](https://four.meme/en/agentic)仍返回 403，本轮无法独立复核其正文。未在可读官方页面中看到新链/发射台公告。
- Flap 官方 [Agent Skills](https://docs.flap.sh/en/flap/v2/developers/agent-skills)仍描述 BNB Chain Tax Token V3 发射 skill v1.3.0，不是通用买卖 adapter。
- Flap 官方 [Flap Apps 草案](https://docs.flap.sh/en/flap/v2/developers/flap-apps)说明其方向是从 token launchpad 扩展到 app launchpad。路线图：Standalone app developer preview；Flap Shared Indexer 为 Beta，路线写为 BNB Chain Testnet → BNB Chain Mainnet → Robinhood Chain；Flap Apps launch 标为 `Coming`。页面标注 Draft Spec 且未提供发布日期。此为“应用托管/部署平台”候选，不是新 token launch mechanism：本页未给出 chain ID、token launch/trade contract、ABI/version、quote asset 或买卖入口，且不能据路线图推断 Robinhood Chain 当前已部署。
- Hyperliquid 官方 [HyperEVM 概览](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm)、[JSON-RPC](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc)和[双区块架构](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/dual-block-architecture)内容与前次采样一致：主网 chain ID 999 / RPC `https://rpc.hyperliquid.xyz/evm`，测试网 998 / RPC `https://rpc.hyperliquid-testnet.xyz/evm`，HYPE 为 gas；默认 RPC 限制历史状态查询，logs 最大 50 blocks / 4 topics；双区块分别 1 秒/3M gas 与 1 分钟/30M gas，地址接受最多后续 8 个 nonce。没有据此推断本地交易支持。

## 本地采集与兼容性

- Flap：本地 watcher 59/59 个正文页面失败（58 `redirect_rejected`、1 HTTP 404）；结构化来源 4/5 healthy，`https://docs.flap.sh/sitemap.xml` 持续 HTTP 404（计数 7,140）。`src/platform-document-watch.js` 仅列两条旧 `/flap/developers/...` seeds，未包含 `/en/flap/v2/developers/agent-skills` 或 `flap-apps` 页面。官方搜索/直读可读不等于本地采集覆盖。
- Four.Meme：正文页面 watcher 8/10 healthy、2 个 redirect rejected；13/13 结构化来源 healthy。单页 403 仍是独立抓取覆盖差异。
- HyperEVM：正文页面 watcher 10/10 healthy、0 条正文变化；细分源健康表仍保存 3/8 历史降级项（Nov 7），而聚合健康为 healthy，状态新鲜度口径仍不一致。
- `src/flap-pool-launch.js` 仍限定 BNB Chain `chainId 56` Pool Launch 的事件观察；记录包含 `monitorOnly=true`、`autoTradeEligible=false`。这不实现 Flap Apps，也不等于 Robinhood Chain Bonding Curve 或 Flap Apps 执行支持。未复现本轮上游变化对本地买卖路径的直接影响。

本轮未运行测试；未连接钱包、读取秘密、签名、广播、下单或执行服务操作；未修改代码、配置、策略或监控源清单。
