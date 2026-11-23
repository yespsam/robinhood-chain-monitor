# 2026-11-17 16:58 UTC — OpenFour reference vault change and compatibility review

- Snapshot: 2026-11-17T16:53:46Z; final check: 2026-11-17T16:58:58Z; previous checkpoint: 2026-11-17T12:54:45Z. Elapsed 4h04m13s at final review, 4m13s over the four-hour target. Monitoring is low-frequency, not continuous.
- One monitored GitHub head changed: `four-meme-community/openfour-docs` main advanced. It remains community/reference because official Four.Meme pages sampled do not cross-link it. The commit contains a potentially relevant vault callback validation change; no local buy/sell execution impact was reproduced.

## Ref changes and attribution

Read-only `git ls-remote --heads --tags` shows no tags. The official/main refs remain unchanged except the OpenFour reference repository:

| Repository | Current main SHA | Attribution |
| --- | --- | --- |
| `binance/binance-skills-hub` | `7d1b1f78d525f9e653b96819f91a549302fda1da` | Official; linked from Binance Agentic Wallet docs. |
| `four-meme-community/four-meme-ai` | `3918818c064878f577159c0a144323d38c55612b` | Official; linked from Four.Meme Agent Skill page. |
| `four-meme-community/fourmeme-docs` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` | Community/reference; unchanged. |
| `four-meme-community/openfour-docs` | `079a45e9c3358c9f357c84f336c7d915c9f0e9fc` | Community/reference; owner not cross-confirmed by official Four.Meme source. |
| `flap-sh/flap-skills` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` | Community/reference; no Flap official-site cross-link established. |
| Project remote `main` | `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1` | Unchanged. |

Unchanged additional heads: Binance `wallet_rm_agent_id` `4fc14e4c0b526c28e7cb1ec130a02a5f7bd99387`; Four.Meme AI `codex/fix-issue-3-events-bigint` `7987396e3db0710fe36c986d1fffc5c810d98846`; Four.Meme AI `codex/openfour-create` `028b49cda4f9fc38c38aa17d268e59b204e3f344`.

## New OpenFour reference commit

The changed main commit is [`079a45e9c3358c9f357c84f336c7d915c9f0e9fc`](https://github.com/four-meme-community/openfour-docs/commit/079a45e9c3358c9f357c84f336c7d915c9f0e9fc), dated `2026-11-17T23:18:44+08:00`, parent `8ca5554df22ad511126d8547c212fa161ecf19ee`, subject `docs: update BaseTaxVault & ForwardVault`. Changed files:

- `contracts/taxvault/BaseTaxVault.sol`
- `contracts/taxvault/vaults/ForwardVault.sol`

The diff moves `onlyTaxSender` and `_validateTaxVaultAsset(asset)` into `BaseTaxVault`; the base default `onERC20TaxReceived` now invokes the asset check. However, `ForwardVault` overrides that callback and this commit removes its prior `_validateTaxVaultAsset(asset)` call while leaving the override to read and forward `IERC20(asset)` balances. The new base check is not automatically invoked by an override that does not call `super`. This is a potential validation bypass/asset-mixing concern for a future reviewer, not a proven exploit: the callback remains caller-gated and the repo is not established as official platform code. The same commit makes `BaseTaxVault.authorWallet()` default to `address(0)` and removes ForwardVault's local cached override, changing the default royalty/author-wallet behavior. No test files changed in the commit; no third-party tests or deployment were run.

The current official [Four.Meme Agent Skill page](https://four.meme/en/agentic) links `four-meme-community/four-meme-ai`; no OpenFour repository cross-link was found there. The `/en/integrations` page could not be read by the web reader this sample. Therefore retain `openfour-docs` as community/reference and do not treat its code as platform rules.

## Other official page and config deltas

- [Binance Agentic Wallet docs](https://developers.binance.com/en/docs/products/agentic-wallet/welcome) now show last modified November 17 (prior recorded date November 16), but the readable chain table is unchanged: BSC 56, Ethereum 1, Base 8453, Solana `CT_501`; HyperEVM is still not listed. No relevant chain-support delta was established; exact prose diff was unavailable. Docs continue to describe API-enforced daily limits/token scope and high-risk rejection or confirmation.
- [Four.Meme Agent Skill](https://four.meme/en/agentic) remains readable, has 15 capabilities including buy/sell quotes and execution, and links the official `four-meme-ai` repo. Announcement contents were not reliably parsed, so no absence claim is made.
- Current [Flap v2 deployed addresses](https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses), [Agent Skills](https://docs.flap.sh/en/flap/v2/developers/agent-skills), and [FSI](https://docs.flap.sh/en/flap/v2/developers/flap-infrastructures/flap-shared-indexer) pages show no new delta versus the recorded baseline: separate Bonding Curve/Pool Launch portals; Agent Skill v1.3.0 Tax Token V3 on BNB; FSI Beta with unpublished endpoint and rollout BNB testnet/mainnet then Robinhood Chain.
- [Hyperliquid HyperEVM docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) retain HYPE gas, mainnet 999/testnet 998 and JSON-RPC. Error 10055's nonce/funds/duplicate-hash/underpriced-replacement examples remain an observed compatibility detail; its publication time is unknown, so no change-time claim is made.

## Local source and trade-path impact

- Local source has OpenFour Registry/Core observation and evidence gates in `src/four-registry-monitor.js` and `src/source-controls.js`. Search did not find a local `BaseTaxVault`, `ForwardVault`, `authorWallet`, or `onERC20TaxReceived` integration in the transaction path. Thus the changed vault callback is not consumed by a reproduced local buy/sell route. Existing OpenFour observation code is not proof of vault trading support.
- `src/flap-pool-launch.js` is still BNB Chain `chainId 56`, observation-only (`monitorOnly=true`, `autoTradeEligible=false`). The Flap canonical document fingerprints remain unchanged and those pages are readable. Local watcher still reports 59/59 legacy page failures (58 redirect rejections, one old 404); the two prior `ECONNRESET` failures cleared. Sitemap remains 404 (8,713 consecutive failures). This remains a local coverage gap, not proof of Flap service outage.
- Four.Meme public config was healthy at 16:53:46Z with 129 quote configs. Full fingerprint changed `7d8d41fe…` → `86578451…`; static normalized digest excluding `totalBAmount` remained `9aa5dee4…`; the `symbol/totalBAmount` projection moved `f23b4aae…` → `70a5f658…`. Exact per-token progress changes cannot be recovered from retained snapshots; no static fee/route change is asserted.
- No explicit HyperEVM/Hyperliquid/999/998 execution route or local 10055 error mapping was found in the sampled trade modules. No local chain route is available to be affected by that note.

## Verification and safety boundary

- `node --test test/four-registry-generations.test.js test/four-registry-pipeline.test.js test/four-registry-monitor.test.js` — 108 passed, 0 failed. These test local event-monitor/gating behavior, not the third-party vault contract.
- `node --test --test-name-pattern='official config' test/platform-capability-monitor.test.js` — 2 passed, 0 failed; parser/schema fixtures only.
- Human review is recommended before any adoption of the OpenFour reference vault code, specifically restoring or intentionally documenting the quote-asset invariant and confirming `authorWallet` semantics. No local code, strategy, risk settings, or trade configuration changed.
- No wallet connection, secret read, signature, broadcast, trade, deployment/restart, push, or merge occurred. Pre-existing worktree changes were left untouched.
