# 2026-11-17 12:53 UTC — Flap watcher network errors and platform delta check

- Snapshot time: 2026-11-17T12:52:40Z; final check: 2026-11-17T12:54:45Z; previous checkpoint: 2026-11-17T08:51:35Z. Interval 4h03m10s at final review, 3m10s over target. Sampling is low-frequency, not continuous.
- No new verified upstream release/tag/commit or reproduced local trade-path regression. A new local source-coverage fault class was observed: two legacy Flap page fetches failed with `ECONNRESET`; canonical official v2 pages were separately readable.

## Upstream repository refs and ownership

Read-only `git ls-remote --heads --tags` found no changed refs and no tags compared with the previous checkpoint:

| Repository | Main SHA | Classification |
| --- | --- | --- |
| `binance/binance-skills-hub` | `7d1b1f78d525f9e653b96819f91a549302fda1da` | Official; cross-linked by Binance Agentic Wallet docs. |
| `four-meme-community/four-meme-ai` | `3918818c064878f577159c0a144323d38c55612b` | Official; cross-linked by Four.Meme Agent Skill page. |
| `four-meme-community/fourmeme-docs` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` | Community/reference; no official cross-link established. |
| `four-meme-community/openfour-docs` | `8ca5554df22ad511126d8547c212fa161ecf19ee` | Community/reference; ownership unconfirmed. |
| `flap-sh/flap-skills` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` | Community/reference; no Flap official-site cross-link established. |
| Project remote `main` | `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1` | Unchanged. |

Unchanged additional heads: Binance `wallet_rm_agent_id` `4fc14e4c0b526c28e7cb1ec130a02a5f7bd99387`; Four.Meme AI `codex/fix-issue-3-events-bigint` `7987396e3db0710fe36c986d1fffc5c810d98846` and `codex/openfour-create` `028b49cda4f9fc38c38aa17d268e59b204e3f344`. They are not new releases or platform rules.

## Official source checks

- [Binance Agentic Wallet documentation](https://developers.binance.com/en/docs/products/agentic-wallet/welcome) was readable today. Its chain table remains BSC 56, Ethereum 1, Base 8453, Solana `CT_501`; HyperEVM is not listed. It describes user-set limits/token scope and high-risk confirmation/rejection. No new support delta found.
- [Four.Meme Agent Skill](https://four.meme/en/agentic) remains readable and lists 15 capabilities, including buy/sell quote and execution; it links the official `four-meme-community/four-meme-ai` repo. The announcement page content did not parse reliably, so no absence-of-announcements claim is made.
- Current canonical [Flap deployed-address docs](https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses), [Agent Skills](https://docs.flap.sh/en/flap/v2/developers/agent-skills), and [FSI docs](https://docs.flap.sh/en/flap/v2/developers/flap-infrastructures/flap-shared-indexer) were reviewed. The docs distinguish Bonding Curve Portal and Pool Launch Portal; the agent skill remains v1.3.0 for Tax Token V3 on BNB Chain; FSI remains Beta with endpoint unpublished and rollout BNB testnet → BNB mainnet → Robinhood Chain. No new deployment or launch delta relative to the previously recorded baseline was established. Addresses on other chains are not evidence of local support.
- [Hyperliquid HyperEVM docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) still state HYPE gas, chain IDs 999/998, and JSON-RPC interaction. The page also describes error `10055` at the HyperCore/HyperEVM boundary, listing nonce errors, insufficient funds, duplicate transaction hashes, and underpriced replacement transactions. Its publication/update time was not established, so this is recorded as a compatibility note, not asserted as a change in this sampling window.

## Local source and compatibility findings

- Four.Meme [public config](https://four.meme/meme-api/v1/public/config) was healthy at 12:52:40Z with 129 normalized quote configs. Full fingerprint moved `db5d525d…` → `7d8d41fe…`; the static normalized projection excluding `thresholds.totalBAmount` stayed `9aa5dee4…`. The symbol/`totalBAmount` projection moved `c36f26b7…` → `f23b4aae…`, consistent with progress-field movement in this projection, not a static fee/route/config change. Retained evidence does not allow exact per-token attribution.
- Flap local document watch: all 59 tracked legacy URLs still fail. Current buckets are 56 `redirect_rejected`, two `ECONNRESET` fetch failures (`.../preview/worldcup-resolver` and `.../wallet-and-terminal-and-bot-developers/token-migration`), and one legacy 404 (`.../preview/recent-release/v5.14.16-buy-quota`). The sitemap remains HTTP 404 (8,617 consecutive failures). Canonical v2 docs are separately readable; this is a local watcher route/network coverage issue, not evidence of a platform-wide Flap outage. The two reset errors are newly observed in this interval and must count as a coverage gap.
- `src/flap-pool-launch.js` remains scoped to BNB Chain `chainId 56`; parsed observations are `monitorOnly=true` and `autoTradeEligible=false`. No local HyperEVM/Hyperliquid/999/998 route or `10055` mapping was found in sampled transaction sources. There is no reproduced local impact because no HyperEVM buy/sell route was found; any future adapter must map boundary/nonce errors fail-closed and never blindly retry.
- Four.Meme source parsing remains informational BSC capability data, not a local buy/sell adapter. No claim is made that every CA is tradable.

## Verification and action

- `node --test --test-name-pattern='official config' test/platform-capability-monitor.test.js` — 2 passed, 0 failed. These are parser/schema fixture tests only, not live buy/sell, wallet, safety API, or chain-routing tests.
- Human follow-up: inspect the Flap watcher’s canonical URL/redirect handling and investigate the two reset failures; do not loosen redirect trust or infer a platform outage. No source code, strategy, risk setting, or trading config was changed in this cycle.
- No wallet connection, secret read, signing, broadcast, trade, deployment/restart, push, or merge occurred. Existing worktree edits were left untouched.
