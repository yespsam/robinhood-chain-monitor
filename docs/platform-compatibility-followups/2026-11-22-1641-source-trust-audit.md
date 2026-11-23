# 2026-11-22 16:41 UTC — 来源归属与兼容性抽查

## 检查窗口

- 本次检查于 `2026-11-22T16:41:47Z` 完成，对比上次检查点 `2026-11-22T12:44:17Z`，间隔 3 小时 57 分 30 秒。低频样本，不表示持续在线。
- 仅做公开仓库 ref、官方文档、已有脱敏健康快照和本地源码的只读检查。未查询实时行情/链上交易数据，未连接钱包、读取秘密、签名或广播，未启动服务。

## 上游增量

五个 GitHub 主分支及 Four.Meme AI 的待审功能分支均未变：

| 仓库 / ref | SHA |
|---|---|
| `binance/binance-skills-hub` `main` | `7d1b1f78d525f9e653b96819f91a549302fda1da` |
| `four-meme-community/four-meme-ai` `main` | `3918818c064878f577159c0a144323d38c55612b` |
| `four-meme-community/four-meme-ai` `codex/openfour-create` | `8e7e92b2e8d9830d20d3df136dd04f7e2bf9670a` |
| `four-meme-community/fourmeme-docs` `main` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` |
| `four-meme-community/openfour-docs` `main` | `079a45e9c3358c9f357c84f336c7d915c9f0e9fc` |
| `flap-sh/flap-skills` `main` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` |

`/releases/latest` 返回五个仓库均无 release（HTTP 404）；`git ls-remote --tags --refs` 对五个仓库均未返回 tag ref。没有上游仓库 ref 增量。

本轮重新读取的官方页面：

- Binance Agentic Wallet: https://developers.binance.com/en/docs/products/agentic-wallet/welcome
- Four.Meme Agent Skill: https://four.meme/en/agentic
- Flap Official Links: https://docs.flap.sh/en/flap/v2/flap-official-links
- Flap Agent Skills: https://docs.flap.sh/en/flap/v2/developers/agent-skills
- Flap deployed contracts: https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses
- HyperEVM JSON-RPC: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc

页面内容保持在已知范围内：Four.Meme Agent Skill 页面列出报价及买卖能力；这是上游能力陈述，不代表本地已有执行器。Flap Agent Skills 页面指向 ClawHub 中的 BNB Tax Token V3 skill；部署页中的多链合约表也不等于本地已适配那些链。HyperEVM RPC 仍注明部分状态读取只支持 `latest`、`eth_getLogs` 最多 4 个 topics / 50 个区块、默认 RPC 不支持历史状态读取；没有发现可据此推断本地交易支持的变化。

## 来源覆盖

- Flap 快照 `2026-11-22T16:36:12.648Z`：5 个 health endpoint 中 4 健康，sitemap 仍为 404；旧 body watcher 59/59 失败，最后成功正文读取时间为 `2026-11-03T18:03:43.843Z`。本次官方 v2 canonical 页面独立读取成功，因此不能据旧路由失败宣称 Flap 官方文档整体不可用或内容未变。
- Four.Meme 快照 `2026-11-22T16:36:12.667Z`：13/13 health sources 健康；body watcher 8/10 成功、2 个失败。最新成功正文读取为 `2026-11-22T16:36:15.481Z`，最新记录变更时间仍为 `2026-11-18T18:31:10.073Z`。
- HyperEVM 快照 `2026-11-22T16:25:00.421Z`：8 个 source endpoints 中 5 健康、3 degraded；body watcher 10/10 成功，最新正文读取 `2026-11-22T16:28:54.935Z`，最新记录变更为 `2026-11-18T18:44:43.339Z`。

仓库归属按官方站点交叉证据处理：Binance 文档链接 Skills Hub；Four.Meme Agent Skill 页面给出 `four-meme-ai` 安装命令，OpenFour 官方集成页链接 `openfour-docs`；本轮未找到 `fourmeme-docs` 的官方站点直链，规则主张仅作参考。

## 本地监控完整性问题（需人工审查）

本地 [`src/github-monitor.js`](../../src/github-monitor.js) 第 29 行将 `flap-sh/flap-skills` 标为 `sourceTrust: "official_verified"`。该值会被同文件的事件构造逻辑输出为 `verification.status = "official_verified"`（约第 2730–2732、3181–3183 行）。但本轮检查的 Flap [Official Links](https://docs.flap.sh/en/flap/v2/flap-official-links) 只列网站、X、Telegram；官方 [Agent Skills](https://docs.flap.sh/en/flap/v2/developers/agent-skills) 链到 ClawHub registry，而不是该 GitHub 仓库。因此，在目前核验范围内，仓库被本地标签过度认证，可能让技能仓库更新的来源证明显得比实际更强。

这是监控归属标注问题，不是上游变更或交易执行回归。最小修复建议：将 `flap-sh/flap-skills` 降为 `reference/community`（或项目已有的未核验枚举），直到官方页面直接链接该 repo；补测试禁止仅凭 GitHub 组织名/本地标签提升信任。遵照只读审查边界，本轮未修改该配置。

## 本地交易路径对照

- `src/live-gmgn-trader.js` 当前固定的 `CHAIN_SPEC` 为 BSC/SOL，spend pairs 为 BNB/USDT/SOL；未知链在 gate 中拒绝。
- `src/chain-support.js` 中 HyperEVM chain IDs 999/998 是链识别元数据，不是 EVM 买卖适配证明。
- `src/flap-pool-launch.js` 针对 BNB Chain (56) Pool Launch `DIRECT_V2_POOL_TAX` 事件解析；不能由此推断 Flap 其他链或 bonding-curve 交易支持。
- 未运行测试；无新上游兼容变化，未重跑交易用例。
- `data/studio/market.json` 是 2026-11-19 的既有快照，报价没有可信的逐项 `observedAt`。市场新鲜度保持 `not_checked`；本轮没有实时价格/流量请求。

## 结果

没有新的 Git ref、tag/release 或经确认的平台正文变化。已记录一个本地 Flap GitHub 仓库来源信任标签待人工复核；没有据此推断 Flap 平台规则或本地交易支持。没有连接钱包、读取秘密、签名、广播、买卖、改策略/限额、部署/重启或 push/merge。
