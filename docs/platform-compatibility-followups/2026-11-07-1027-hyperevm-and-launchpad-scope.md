# HyperEVM / 新链与发射台监控范围更新 — 2026-11-07 10:27 UTC

## 结论

已把 Hyperliquid HyperEVM（HYPE）及经一手来源核验的新链、新发射台公告并入现有四小时 `agentic-wallet-four-meme-flap` heartbeat，没有创建重复自动化。自动化仍为 ACTIVE；名称更新为包含 HyperEVM。新增规则区分 HyperCore 与 HyperEVM，只把社区目录当作线索，并要求先验证链/合约/ABI/报价资产/买卖路径，再判断本地是否适配。未连接钱包、未签名、未广播或交易，未修改交易代码/策略/运行配置，也未部署、重启、push 或 merge。

## HyperEVM 官方资料与本地覆盖边界

- Hyperliquid 官方 [HyperEVM 文档](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) 当前列出主网 chain ID `999`、RPC `https://rpc.hyperliquid.xyz/evm`；测试网 chain ID `998`、RPC `https://rpc.hyperliquid-testnet.xyz/evm`；HYPE 是 HyperEVM 原生 gas 资产。
- 官方 [JSON-RPC 说明](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc) 表明默认端点只支持部分最新状态读取，`eth_getLogs` 单次最多 50 blocks，并列出不支持的历史状态请求；官方说明默认端点没有 WebSocket JSON-RPC。持续链上监测若采用该端点，必须按这些能力边界分块、退避并报告缺口，不能据此承诺完整历史覆盖。
- 官方 [HyperEVM 使用说明](https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/how-to-use-the-hyperevm) 将社区生态目录列为发现线索；这不是官方背书。本轮没有找到由官方文档确认的特定 HYPE 发射台/新发射合约，因此不将任何社区项目升级为官方发射台。
- 本地 `docs/gmgn-flow-monitor.md` 将 `hyperevm` 列在待验证扩展热搜探测中，明确不计为完整联合信号覆盖；本地检索只证实 discovery 字符串/测试存在，未验证钱包交易 adapter、报价、签名或买卖路径。因此目前不能声称项目已支持 HyperEVM 交易。

## OpenFour 增量

六个监测仓库的只读 main refs 已核对；Binance Skills Hub、Four.Meme docs、Four.Meme AI、Flap skills 和项目 main 均未变。本轮 tag refs 数量均为 0。唯一变化是 `four-meme-community/openfour-docs` 从 `8a75373a0be50c5acd1bd52fc618d632e8666ea4` 前进到 [`84dc55c7f4710544430ef4939ef36e4e514017bb`](https://github.com/four-meme-community/openfour-docs/commit/84dc55c7f4710544430ef4939ef36e4e514017bb)，提交时间为 `2026-11-07T18:16:08+08:00`。

该提交涉及 13 个文件：新增 OpenFour `StandardVault` / `TaxBondingVault`、`SimpleTradeModule` / `TaxBondingTradeModule`、`StandardCustomData` 参考实现，并更新 BSC Testnet 开发 fork/preset 说明。它是社区开发工具/代码参考变化；未证明这些模块已注册或部署到任何生产 registry，也没有本地 adapter 兼容性变更依据。未执行该仓库中的脚本、部署或合约测试。

归属核对：Four.Meme 官方 [欢迎页](https://four-meme.gitbook.io/four.meme) 确认 OpenFour 是其生态中的白标基础设施，但本轮页面未提供该 GitHub 仓库链接；仅凭组织名、commit 邮箱或本地 `sourceTrust` 标签不足以证明精确仓库归属。因此本次该仓库变化仍标为 `community/reference`，不当作平台规则。只读检查发现本地 `src/github-monitor.js` 对 `four-meme-community/openfour-docs`（以及 `four-meme-community/four-meme-ai`）设为 `official_verified`，但 OpenFour 项目项没有 `officialEvidence`；这与本监控的官方交叉验证政策存在来源信任不一致。当前不改用户的脏工作树或监控源码，后续若需修正应单独审阅。

## 验证与下一步

`git ls-remote` 核对六个 main refs 与 tag refs；OpenFour 新提交用临时浅克隆查看 commit metadata、diffstat 和相关源码，没有执行代码。未运行交易或生产测试，因为本轮只调整监控范围。下一轮按四小时节奏复核 Hyperliquid 官方文档/官方仓库与新链、新发射台一手公告；对任何候选继续分开记录“来源已核验”“链上合约已核验”“本地适配/模拟验证”。
