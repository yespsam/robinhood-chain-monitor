# 平台兼容性增量检查 — 2026-11-09 14:54 UTC

本轮是有界只读上游与本地兼容性复核，对比 2026-11-09 10:58 UTC 检查点。发现一个被跟踪的 OpenFour 参考仓库 main 前进，以及本地仍把该仓库标为 `official_verified` 的来源信任不匹配。该仓库未能从 Four.Meme 官方站点交叉确认归属，故本轮只按 community/reference 处理；提交内容不是平台规则或已部署功能证明。

## 上游 refs 与候选变化

`git ls-remote` 读取了各仓库 `HEAD` / `main`，并计数 tag refs。五个平台仓库及项目 GitHub `main` 当前值：

| 仓库 | 上次 SHA | 本次 `main` SHA | 结果 |
| --- | --- | --- | --- |
| `binance/binance-skills-hub` | `96563daf34fa5a87af5d76c2f1107d697ae7ce07` | `96563daf34fa5a87af5d76c2f1107d697ae7ce07` | 未变 |
| `four-meme-community/four-meme-ai` | `0a07b65468caa73f552dd6a13013ef5071065996` | `0a07b65468caa73f552dd6a13013ef5071065996` | 未变 |
| `four-meme-community/fourmeme-docs` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` | 未变 |
| `four-meme-community/openfour-docs` | `84dc55c7f4710544430ef4939ef36e4e514017bb` | `26b937d626d9124c1a582e9e13463a04cae08a32` | 新提交，待核归属 |
| `flap-sh/flap-skills` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` | 未变 |
| 项目 `yespsam/robinhood-chain-monitor` | `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1` | `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1` | 未变 |

本次观察到的 tag refs 数量为 0。OpenFour 具体提交：[26b937d626d9124c1a582e9e13463a04cae08a32](https://github.com/four-meme-community/openfour-docs/commit/26b937d626d9124c1a582e9e13463a04cae08a32)，标题为 “feat: ship Stock4 Tax preset with SIH fork wiring and BNC4 docs”，父提交 `84dc55c`，13 个文件、+389/-47 行。页面列出的相关路径包括 `developer/fork-deploy/README.md`、`developer/fork-deploy/fork-from-chain.js`、`developer/fork-deploy/lib/stock4SihFork.js`、`developer/fork-deploy/source/bsctestnet.json` 及中英文机制/开发文档；内容围绕 BSC 测试网 Stock4 税币、BNC4 报价、SIH 迁移与测试工具。

该仓库虽处于 `four-meme-community` GitHub 组织，但本轮 Four.Meme 官方页面只交叉链接 `four-meme-community/four-meme-ai`，没有找到 OpenFour 的官方归属链接。组织名称和仓库内容不足以确认官方规则、官方部署或主网可用性；不能把该提交播报成 Four.Meme 的新发射台或平台规则。

## 官方页面核对

- [Four.Meme Agent Skill](https://four.meme/en/agentic)：当前页面列出 15 项能力并链接 `four-meme-community/four-meme-ai`；没有 OpenFour 仓库的归属反链。
- [Four.Meme 公告](https://four.meme/en/announcement)：页面当前展示的最新公告日期仍为 2026-02-02；本轮没有从该公告索引确认新链或新发射台。
- [Binance Agentic Wallet](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)：链表仍列 BSC 56、Ethereum 1、Base 8453、Solana `CT_501`；未列 HyperEVM。
- Flap [Recent Release](https://docs.flap.sh/en/flap/developers/preview/recent-release/v5.14.16-buy-quota) 当前仍标注 `Preview` / 未审阅，同时文档索引把它列在 Recent Release。它描述的 `tx.origin` 累积买入额度及超额部分退款语义仍需按“文档观察，不能由此确认具体链上激活”处理。
- Flap [deployed contract addresses](https://docs.flap.sh/en/flap/developers/deployed-contract-addresses) 与 [Portal launch guide](https://docs.flap.sh/en/flap/developers/token-launcher-developers/launch-token-through-portal) 本轮读取；未确认新增部署或当前本地观察器覆盖范围变化。通用 Portal V6/V7 文档不等于 Robinhood/BSC 的本地交易适配。
- Hyperliquid [HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) 与 [JSON-RPC](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc) 当前正文仍将 HyperEVM 与 HyperCore 区分；本轮没有发现新官方 HyperEVM 发射台。

## 本地兼容性与来源信任问题

- 本地 `src/github-monitor.js:36` 将 `four-meme-community/openfour-docs` 标为 `official_verified`；`test/github-monitor.test.js:1720-1731` 也断言这一来源级别。`src/alerts.js` 的 GitHub 更新资格逻辑会依据 `sourceTrust` 对平台变更进行筛选，因此该错误标签可能让未经官方归属确认的仓库更新获得官方来源语义。当前 heartbeat 的本地来源规则明确要求它按 `community/reference` 保留，除非找到官方交叉链接。
- 建议最小修复：把 OpenFour 降为明确的 community/reference（而不是平台规则来源），并同步调整 alert eligibility/rendering 和相应测试；在归属证据改变前，将其提交仅作为待核线索。**本轮没有修改源码或测试**，也没有运行测试。
- 此提交不触发交易适配结论。`openfour-docs` 的 BNC4/SIH 内容仅描述其自有 BSC 测试网工具；未发现本地对应的 Stock4/BNC4/SIH 执行集成证据。Flap 买入额度方法/事件及新 Portal 版本也未在本地 Flap 买卖执行路径中验证；外部 GMGN 行为未验证。

## 监控覆盖状态

读取本地只读 source-health/document-watch 快照（最近采样发生在本轮观察时间附近）：

- Flap 文档观察：59/59 页面失败；5/5 source-health 项降级；最近成功正文 `2026-11-03T18:03:43.843Z`。
- Four.Meme 文档观察：10/10 页面失败；13/13 source-health 项降级；最近成功正文 `2026-11-08T12:35:42.883Z`。本轮官网页面可通过独立网页读取，但这不代表本地采集器恢复。
- HyperEVM 文档观察：10/10 页面健康、0 条未报告变更；8 项 health 端点中 3 项降级。此为当前采样快照，不能宣称持续在线。

Flap/Four.Meme 的传输失败是持续覆盖缺口，不能作为“无更新”的证据；其故障已在前几轮报告，本轮记录为仍持续，避免把相同故障误报为新回归。

本轮未连接钱包、未读秘密配置、未签名、未广播/交易、未改交易策略/限额/安全门槛、未部署或重启、未提交或推送。工作树本来就有大量 staged/unstaged/untracked 改动；本轮没有改应用代码，也没有触碰这些改动。
