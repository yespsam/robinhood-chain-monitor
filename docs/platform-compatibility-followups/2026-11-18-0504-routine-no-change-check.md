# Platform compatibility incremental check — 2026-11-18 05:04 UTC

## Checkpoint

- Heartbeat received at 04:58:10Z; final sampled checkpoint at 05:04:11Z. Compared with 00:59:24Z: 4h04m47s elapsed. This is low-frequency sampled coverage, not continuous monitoring.
- Read-only Git heads/tags are unchanged for Binance skills, Four.Meme docs/integration repositories, Flap skills, and project `main`; no tags were returned. No relevant upstream commit/file delta was found.
- No wallet connection, secret/config read, signature, broadcast, trade, deployment, restart, push, merge, or application-code edit occurred.

## Upstream references and bounded discovery

- `binance/binance-skills-hub` main: `7d1b1f78d525f9e653b96819f91a549302fda1da`; `wallet_rm_agent_id`: `4fc14e4c0b526c28e7cb1ec130a02a5f7bd99387`.
- `four-meme-community/fourmeme-docs` main: `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`.
- `four-meme-community/openfour-docs` main: `079a45e9c3358c9f357c84f336c7d915c9f0e9fc`.
- `four-meme-community/four-meme-ai` main: `3918818c064878f577159c0a144323d38c55612b`; `codex/fix-issue-3-events-bigint`: `7987396e3db0710fe36c986d1fffc5c810d98846`; `codex/openfour-create`: `028b49cda4f9fc38c38aa17d268e59b204e3f344`.
- `flap-sh/flap-skills` main: `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`.
- Project GitHub `main`: `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1` (the local checkout remains a separate, extensively dirty worktree; no local changes were made in this cycle).
- OpenFour remains an official-linked integration reference, not a legal-ownership claim: the [official Four.Meme OpenFour Integration page](https://four-meme.gitbook.io/four.meme/developer/openfour-integration) calls OpenFour an engine introduced by Four.Meme and links `openfour-docs`. The previously reported 079a45e9 tax-callback/`authorWallet` semantic change is unchanged; no local buy/sell impact was reproduced. Human review remains open, with no new delta.

## Official documentation and coverage

- Binance's [Agentic Wallet overview](https://developers.binance.com/en/docs/products/agentic-wallet/welcome) currently lists BSC 56, Ethereum 1, Base 8453, and Solana `CT_501`, not HyperEVM. The support table is unchanged. The page shows a Nov 18 last-modified date, but that date alone does not establish an exact within-day content delta.
- Four.Meme's live public-config snapshot remains 129 quote configurations and BNB Chain 56 only; 13/13 structured sources are healthy and the two extracted announcement titles are unchanged (`Credits suspension notice`, `FOUR.MEME Tax Mode is Live`). The announcement page returned 403 in the independent web reader. Separately, 2/10 legacy document-body pages currently fail with `redirect_rejected`; no new body change was recorded, so publication-date coverage remains limited.
- Flap's [deployed-address page](https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses) distinguishes the bonding-curve Portal from the Pool Launch Portal. It lists bonding-curve deployments across multiple chains (including Robinhood Chain), while explicitly describing Pool Launch as live on BNB Chain and BNB Chain Testnet. The [Agent Skills page](https://docs.flap.sh/en/flap/v2/developers/agent-skills) still describes v1.3.0 as BNB-chain Tax Token V3 launch-only. No new launch mechanism or upstream delta was established this cycle. Local source health remains 4/5 because the sitemap returns 404; the legacy body watcher remains 59/59 failed (58 redirects, one 404), while official canonical pages are independently readable. These are existing local coverage gaps, not evidence of a Flap outage.
- [HyperEVM official docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) continue to specify HYPE gas, mainnet chain ID 999 / `https://rpc.hyperliquid.xyz/evm`, testnet 998 / `https://rpc.hyperliquid-testnet.xyz/evm`, and JSON-RPC interaction; the main endpoint has no WebSocket support. No new launchpad or local executor compatibility was verified. The local body watch has 10/10 pages healthy and no content delta, but a separate 8-source lane remains 5/8 healthy with three `fetch failed` entries unchanged since Nov 7.
- No new chain, launchpad, issuance mechanism, or release/tag was verified in the bounded source set. Documentation and quote-token lists do not establish that all CAs are tradable.

## Local compatibility checks

- `src/chain-support.js` recognizes HyperEVM names and metadata IDs 999/998 for discovery/alert classification only. `node --test test/chain-support.test.js test/hyperevm-telegram.test.js` passed 14/14; these tests cover detection/source gating, not a signing or swap route. No HyperEVM buy/sell adapter was found in the sampled transaction modules.
- `src/flap-pool-launch.js` remains BNB chain ID 56, `DIRECT_V2_POOL_TAX`, monitor-only, and `autoTradeEligible=false`. This matches the official Pool Launch chain scope; it does not imply support for the separate multi-chain bonding-curve deployments.
- Targeted local search found no OpenFour `BaseTaxVault` / `ForwardVault` callback wiring in sampled buy/sell modules. No new tax, allowance, slippage, quote-validity, nonce/pending, gas, or buy/sell-symmetry regression was reproduced.
- No code changes were made. The 14 focused discovery tests were run; no transaction/execution tests were attempted.

## Result

No new upstream ref, verified material platform change, compatibility regression, or coverage movement was established since the prior checkpoint. Preserve the existing OpenFour human-review item and local collector gaps. No notification is required for this routine no-change cycle.
