# 平台兼容性增量检查 — 2026-11-07 18:29 UTC

## 结论

本轮受监测仓库 refs 未见变化；没有核实到新的官方链、发射台或发行机制。HyperEVM 官方文档复核及本地正文观察未见新内容变化，本轮不触发用户通知。OpenFour 仓库继续按 `community/reference` 处理，不能据此推导为 Four.Meme 平台规则。

## 上游 refs 与官方资料

只读复核的 main refs 与上轮一致，tag refs 均为空：

- `binance/binance-skills-hub`: `96563daf34fa5a87af5d76c2f1107d697ae7ce07`
- `four-meme-community/four-meme-ai`: `0a07b65468caa73f552dd6a13013ef5071065996`
- `four-meme-community/fourmeme-docs`: `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`
- `four-meme-community/openfour-docs`: `84dc55c7f4710544430ef4939ef36e4e514017bb` — `community/reference`；未核实该具体仓库的官方归属
- `flap-sh/flap-skills`: `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`
- 项目 GitHub `main`: `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`

本轮直接复核了 [HyperEVM 开发文档](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm)、[JSON-RPC 说明](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc)、[HyperEVM 使用指南](https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/how-to-use-the-hyperevm)、[Four.Meme 工作机制](https://four-meme.gitbook.io/four.meme/guide/how-it-works)、[Flap Robinhood 集成指南](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide)及 Binance 技能仓库。没有确认其内容相较已存快照有新变化。

HyperEVM 文档仍列主网 chain ID 999 / `https://rpc.hyperliquid.xyz/evm`、测试网 998 / `https://rpc.hyperliquid-testnet.xyz/evm`，gas 资产 HYPE。默认 RPC 对历史状态有局限、`eth_getLogs` 每次查询上限 50 blocks/4 topics；文档还说明 EIP-1559/Cancun、优先费当前返回 0，以及 10055 可表示 HyperCore/HyperEVM 边界错误。这些是对现存文档限制的核对，不是本轮新发布变化。HyperCore 功能不等于 HyperEVM 的本地合约交易支持；未核验新的官方 HyperEVM launchpad。

## 本地覆盖与兼容性

本地 `data/platform-capability-state.json` 的 HYPE 正文 watcher 覆盖 10/10 页、10 页 healthy、0 条新变化、0 条遗漏；最近一次成功正文读取为 `2026-11-07T18:25:29.633Z`。HyperEVM 无本地已验证买卖适配器；本轮未改源码、策略或配置。

已知缺口未改善、但本轮未发现新故障：

- Flap 正文 watcher：59/59 页 failed；最后成功读取仍为 `2026-11-03T18:03:43.843Z`；保留 2 条旧待核记录。单页官方 Robinhood 集成指南可读取不代表整组 watcher 已恢复。
- Four.Meme 正文 watcher：8/10 页 healthy、2 页 failed；保留 6 条旧待核记录，没有把它们当作本轮新增。
- `src/github-monitor.js` 对 OpenFour 仓库的本地 `official_verified` 标签仍缺精确的官方仓库交叉链接证据；本轮只记录、不改源码。

## 操作边界

仅做了公开 refs、官方网页和本地状态的只读检查；未运行应用测试，未连接钱包、读取秘密、签名、广播、交易、修改源码/配置、部署/重启服务、推送或合并。

下次检查不早于 `2026-11-07T22:29:14Z`。
