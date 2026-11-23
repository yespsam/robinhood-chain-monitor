# 平台兼容性增量检查 — 2026-11-08 22:50 UTC

## 结论

六个监测仓库的 `main` refs 与 2026-11-08 14:52Z 检查点相同，tag refs 仍为 0；没有核实到新的平台链部署或 HyperEVM 发射台。Flap 官方 Portal 开发页当前明确列出 `newTokenV7` 的公开 rollout 限制。现有本地成功正文仅到 2026-11-03，故本轮能确认“当前官方文档如此记载”，但**不能确认该具体参数说明是在 11-03 之后新增**。

需人工关注的持续覆盖故障：本地 Flap 文档观察仍为 59/59 失败，样本传输码 `UND_ERR_CONNECT_TIMEOUT`；Four.Meme 仍为 10/10 文档页失败、13/13 source health 项 degraded/partial，旧待核变化 6 条。独立官方网页读取可成功不等于本地采集器恢复，也不能据失败窗口推断没有平台变化。

## 官方 refs 与来源归属

只读 `git ls-remote --heads --tags --refs` 对照：

| 仓库 | `main` SHA | tag refs |
|---|---|---:|
| `binance/binance-skills-hub` | `96563daf34fa5a87af5d76c2f1107d697ae7ce07` | 0 |
| `four-meme-community/four-meme-ai` | `0a07b65468caa73f552dd6a13013ef5071065996` | 0 |
| `four-meme-community/fourmeme-docs` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` | 0 |
| `four-meme-community/openfour-docs` | `84dc55c7f4710544430ef4939ef36e4e514017bb` | 0 |
| `flap-sh/flap-skills` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` | 0 |
| 项目 GitHub `main` | `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1` | 0 |

Binance 官方开发文档安装说明直接指向 `binance/binance-skills-hub`；目前文档列出的 Agentic Wallet 链为 BSC 56、Ethereum 1、Base 8453 和 Solana `CT_501`，没有 HYPE。页面标示最后修改日期 2026-10-30：[Binance Agentic Wallet 文档](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)。

Flap 官方技能页及其 Binance Agentic Wallet 教程链接到 `flap-sh/flap-skills` 和 Binance 技能仓库，可交叉确认二者归属；教程提到的签名/广播是教程能力说明，不是本地监控器已集成或已执行：[Flap AI Skills](https://docs.flap.sh/en/flap/skills)、[Flap × Binance Agentic Wallet](https://docs.flap.sh/en/flap/skills/using-with-binance-agentic-wallet)。Four.Meme 官方公告页目前最新显示 2026-02-02；官方 `/en/agentic` 本轮直读为 403，搜索索引中 `four-meme-ai` 的旧链接只能作为历史交叉线索。OpenFour 仍标 `community/reference`，没有找到指向该确切仓库的官方归属反链：[Four.Meme 公告](https://four.meme/en/announcement)。

## Flap `newTokenV7` 文档细节与本地边界

当前 [Flap Portal 开发页](https://docs.flap.sh/en/flap/developers/token-launcher-developers/launch-token-through-portal) 记载：

- `newTokenV7` 是 TokenV3/CL-style migration 路径；公开 rollout 当前仅支持 `TOKEN_V3_PERMIT`。
- 通过 V7 创建 `TOKEN_TAXED_V3` 当前会回退；tax-token 使用 `newTokenV6`。
- V7 的 `TOKEN_V3_PERMIT` 路径要求 `PCS_INFINITY_CL_MIGRATOR`；其它 migrator 会回退。
- `commissionReceiver` 必须为零地址、buy/sell tax 必须为 0、`antiFarmerDuration` 不超过 365 天；V7 `feeConfigs` 当前只开放单一 10000 bps 的 marketing/vault 或符合文档约束的 dividend 模式，deflation 与 LP fee 模式未开放。

这属于**当前官方通用 Portal 文档**，不能外推成 HyperEVM 新链，也不能套用到 Robinhood Chain。Flap 的 [Robinhood Chain 专用指南](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide)仍单列 `TOKEN_V2_PERMIT`/`newTokenV5` 与 `TOKEN_TAXED_V3`/`newTokenV6`、`V2_MIGRATOR` 和原生 ETH 报价。新方法的具体链部署、Portal 实现与 ABI hash 未在本轮链上验证。

本地路径：

- `src/flap-pool-launch.js` 监听 BNB Chain (56) 上专用 Pool Launch Portal `0x000042108465206185A077Edc3F3fd2b49060000` 的 `FlapDirectLaunched`/`DIRECT_V2_POOL_TAX` schema；不是通用 `newTokenV7` Portal ABI。
- `src/flap-quote-monitor.js` 的报价配置监控固定在 BSC chain ID 56 与既有 Portal；不构成 V7 launch、卖出或交易兼容证明。
- 因此当前结论是“V7 路径尚未由本地观察器解析/验证”，不是认定现有 Pool Launch parser 有回归。若要接入，先需确切网络、部署地址、实现/ABI 与买卖入口的双源/链上验证；本轮不改代码。

## 本地覆盖和验证

- Flap 文档观察：59 tracked / 59 failed；最后成功正文 `2026-11-03T18:03:43.843Z`。最新存档传输错误为 `UND_ERR_CONNECT_TIMEOUT`；source health 仍 degraded。不能宣称该间隔没有文档更新。
- Four.Meme 文档观察：10 tracked / 10 failed；最后成功正文 `2026-11-08T12:35:42.883Z`；source health 13/13 degraded/partial，仍有 6 条历史待核变化。官方公告网页可读；`/en/agentic` 为 403。缺口持续，根因未解决。
- HyperEVM 文档观察：10 tracked / 10 healthy、0 unreported changes；最后正文成功 `2026-11-08T22:46:17.153Z`。官方资料仍列主网 chain ID 999、测试网 998、gas 为 HYPE、默认 RPC 限制；未确认官方 HyperEVM launchpad。官方 docs：[HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm)、[JSON-RPC](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc)。
- `node --test test/flap-pool-launch.test.js`：4 passed / 0 failed。仅离线 fixtures，确认现有专用 Pool Launch parser 行为；不是 V7、live wallet、报价、签名、广播或交易验收。

本轮未连接钱包、未读取秘密、未签名/广播/交易、未改源码/策略/配置、未启动或重启服务、未 push/merge。当前部署/运行 commit 未确认。

## 下次有界问题

复核 Flap/Four.Meme 本地采集的传输超时是否恢复；在采集恢复前保持官方正文覆盖缺口。若继续研究 V7，先确认与具体链对应的官方部署地址和 ABI，再单独检查 parser/买卖路径，不根据通用文档直接宣称本地可交易。
