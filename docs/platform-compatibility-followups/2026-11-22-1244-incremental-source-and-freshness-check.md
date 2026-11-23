# 2026-11-22 12:44 UTC — 增量来源与新鲜度检查

## 检查窗口

- 本次检查：2026-11-22 12:44:17 UTC；对比上次记录的上游仓库检查 2026-11-22 04:50:06 UTC，间隔 7 小时 54 分 11 秒。此间隔代表覆盖缺口，不能解释为持续在线。
- 仅检查公开官方文档/仓库 ref 和已有脱敏本地健康快照。没有查询实时价格、启动服务、连接钱包或读秘密配置。

## 上游 ref 与归属核验

GitHub 默认分支 SHA 与 04:50 检查点一致；Four.Meme AI 的 `codex/openfour-create` 也仍在同一 SHA。五个仓库的 Releases endpoint 均未返回 release。Tags endpoint 被当前 GitHub connector 的访问边界拒绝，因此本轮 tag 列表是 `not_checked`，没有将其写成“无 tags”。

| 仓库/ref | 本次 SHA | 上次 SHA | 归属/用法 |
|---|---|---|---|
| `binance/binance-skills-hub` `main` | `7d1b1f78d525f9e653b96819f91a549302fda1da` | 相同 | Binance Agentic Wallet 官方文档安装命令直接引用此仓库。 |
| `four-meme-community/four-meme-ai` `main` | `3918818c064878f577159c0a144323d38c55612b` | 相同 | Four.Meme 官方 Agent Skill 页面给出该仓库的安装命令；官方能力介绍不等同于本地已接入执行。 |
| `four-meme-community/four-meme-ai` `codex/openfour-create` | `8e7e92b2e8d9830d20d3df136dd04f7e2bf9670a` | 相同 | 分支仍是参考/待审实现，不是 main 或已发布版本。 |
| `four-meme-community/fourmeme-docs` `main` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` | 相同 | 本轮未建立官方站点到该 GitHub 仓库的直接交叉链接；对平台规则主张仅作 reference。 |
| `four-meme-community/openfour-docs` `main` | `079a45e9c3358c9f357c84f336c7d915c9f0e9fc` | 相同 | Four.Meme 官方 OpenFour Integration 文档直接链接此仓库；归属有交叉证据。 |
| `flap-sh/flap-skills` `main` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` | 相同 | Flap 当前 Official Links 页面未链接该仓库，技能页链接到 ClawHub；本轮按 reference、归属未核实，不作为平台规则。 |

Relevant official pages:

- Binance Agentic Wallet overview: https://developers.binance.com/en/docs/products/agentic-wallet/welcome
- Four.Meme Agent Skill: https://four.meme/en/agentic
- Four.Meme OpenFour integration: https://four-meme.gitbook.io/four.meme/developer/openfour-integration
- Flap Official Links: https://docs.flap.sh/en/flap/v2/flap-official-links
- Flap deployed contracts and skills: https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses and https://docs.flap.sh/en/flap/v2/developers/agent-skills
- Hyperliquid HyperEVM JSON-RPC: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc

No new watched commit/ref delta was found. Binance's official page still documents BNB Chain (56), Ethereum (1), Base (8453) and Solana (`CT_501`) wallet support; that is upstream documentation, not evidence of local executor support.

## Existing source-coverage snapshot

The local `data/platform-capability-state.json` is a set of independently sampled records, not an atomic/continuous check:

- Flap: 4/5 configured health endpoints healthy; sitemap returned 404. All 59 watched legacy document bodies remain failed, with last successful body reads on Nov 3. The canonical Flap v2 pages were independently readable in this check, so the legacy-watch failure is a route/coverage gap, not proof that all official docs are down and not proof that their contents are unchanged.
- Four.Meme: 13/13 configured health endpoints healthy; 8/10 tracked document bodies succeeded and 2 were redirect-rejected. Persisted body-change entries have no post-Nov-18 observation.
- HyperEVM: 5/8 configured health endpoints healthy; three remain transport-degraded since Nov 7. The bounded body watcher had 10/10 pages successful in its latest point-in-time sample; persisted change entries have no post-Nov-18 observation.

The official HyperEVM JSON-RPC page currently states `eth_getLogs` is limited to 4 topics and 50 blocks per query, historical-state reads are unsupported on the default RPC, and several state queries support only `latest`. This is an RPC compatibility boundary, not a newly confirmed local execution change: the local project has no HyperEVM buy/sell adapter.

Market/flow freshness is `not_checked` for this cycle. The existing studio-market snapshot has no trustworthy per-quote `observedAt`, and the general health file is dated Oct 31; neither was used to claim current market freshness. No live price or flow requests were made.

## Local compatibility impact

- No upstream refs changed. No new-chain or launchpad support was inferred.
- `src/live-gmgn-trader.js` remains restricted to its audited BSC/SOL spend-asset pairs. Prior unknown-chain fail-closed hardening remains an unapproved local patch and was not modified, deployed, or retested here.
- `src/flap-pool-launch.js` remains a BNB Chain 56 Pool Launch observer; Flap's separate multi-chain bonding-curve deployments are not thereby supported.
- Local HyperEVM support remains discovery/documentation metadata only; Four.Meme Agentic Wallet claims do not constitute a local buy/sell adapter.
- Tests were not run because no code changed during this read-only cycle.

## Outcome

No newly confirmed upstream content/ref delta or local trade-path regression. Known Flap legacy body-watch and HyperEVM endpoint coverage gaps remain; repo trust is kept conservative where an official cross-link was not found. No user notification is warranted for unchanged known gaps.
