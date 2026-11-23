# Platform compatibility checkpoint — 2026-11-20 12:27 UTC

## Coverage window

- Compared with the last saved review at `2026-11-19T19:43:26Z`. This check completed at `2026-11-20T12:27:20Z`, a `16h43m54s` sampling gap with multiple missed four-hour observations. This is not continuous coverage.
- Read-only review only. No wallet connection, secret/config reads, signature, broadcast, order, deployment/restart, push/merge, or source/strategy/risk edits.

## Upstream refs and source attribution

- `binance/binance-skills-hub` main: `7d1b1f78d525f9e653b96819f91a549302fda1da`; `wallet_rm_agent_id`: `4fc14e4c0b526c28e7cb1ec130a2a5f7bd99387`.
- `four-meme-community/four-meme-ai` main: `3918818c064878f577159c0a144323d38c55612b`; `codex/fix-issue-3-events-bigint`: `7987396e3db0710fe36c986d1fffc5c810d98846`; `codex/openfour-create`: `8e7e92b2e8d9830d20d3df136dd04f7e2bf9670a`.
- `four-meme-community/fourmeme-docs` main: `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`.
- `four-meme-community/openfour-docs` main: `079a45e9c3358c9f357c84f336c7d915c9f0e9fc`.
- `flap-sh/flap-skills` main: `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`.
- No release/tag refs were returned. The monitored platform refs above are unchanged from the prior saved checkpoint. The project GitHub ref recorded previously (`yespsam/robinhood-chain-monitor-main`, `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`) now returns “Repository not found” to `git ls-remote`; this may mean renamed/private/unavailable and prevents current remote-head verification. No conclusion about deletion is drawn.
- Four.Meme’s [Agentic page](https://four.meme/en/agentic) links its skill repository. Its [OpenFour integration guide](https://four-meme.gitbook.io/four.meme/developer/openfour-integration) describes OpenFour as a Four.Meme-introduced engine and links `openfour-docs`; this verifies a first-party documentation cross-link, not ownership of every repository branch or deployment.

## Material newly verified Flap/Morph capability signal

- The first-party Flap [Protocol Economics page](https://docs.flap.sh/en/flap/v2/developers/protocol-economics) explicitly states a 2.5% bonding-curve rate on Morph; the same page lists 1% for BNB Chain, Robinhood, X Layer, and Monad. It is a platform capability signal, but the page has no publication/effective timestamp, so this review cannot establish exactly when Morph support was added.
- The first-party Flap app exposes a [Morph board](https://flap.sh/morph/board). The local read-only collector snapshot at `2026-11-20T12:24:59Z` reports one Morph quote-asset row: BGB (`BitgetToken`), address `0x55d1f1879969bdbb9960d269974564c58dbc3238`. Treat this as an app/board observation, not a verified transaction route or token approval.
- Morph’s own [network contract documentation](https://docs.morph.network/docs/build-on-morph/developer-resources/contracts) lists Morph Mainnet chain ID `2818`, RPC `https://rpc-bgw.morph.network`, and native currency `ETH`. This identifies the network only; it does not define Flap’s contracts.
- Flap’s current [deployed-contract table](https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses) distinguishes Bonding Curve from Pool Launch. It lists Pool Launch on BNB Chain and BNB testnet only, and contains no Morph deployment row. The archived legacy address page also omits Morph. Therefore Morph’s Flap launch contract address, ABI/version, and complete buy/sell route remain **unverified**. A collector-generated `observedChains` entry that attributes Morph deployment to the old address-page URL conflicts with the page currently served; it should be treated as a probable local source-classification false positive until reconciled.
- Do not infer that Flap’s BNB Pool Launch portal/ABI applies to Morph, or that a first-party board means all Morph tokens are tradeable.

## Local compatibility impact and human review

- `src/chain-support.js` classifies Morph chain ID `2818`, but `src/live-gmgn-trader.js` only defines execution specs for `bsc` and `sol`. A read-only call to `chainCfg(..., "morph")` returns `unsupported: true`. The local adapter therefore has no Morph live buy/sell path; the upstream signal is not local trade support.
- Local Flap Pool Launch parsing is explicitly BNB-only: `src/flap-pool-launch.js` fixes chain ID `56` and the Pool Launch portal. Its feature switch `LIVE_FLAP_POOL_LAUNCH` defaults to enabled when absent, and a known `DIRECT_V2_POOL_TAX` launch with a pool is marked `autoTradeEligible` / `automaticExecution`; the source comment says that the confirmed paper session is the signal mirrored to GMGN. The live trader itself defaults OFF unless `LIVE_TRADING_ENABLED=true`. Runtime environment and secrets were not read, so this is a code-path review item, **not a claim that live trading is currently active**. Human review is needed before assuming this signal source is monitor-only.
- `src/live-gmgn-trader.js` checks raw quote amount/slippage and approved-preview equality, while the manual path reserves ledger capacity and refuses a changed quote. These safeguards are relevant to currently supported routes; they do not add Morph execution.
- Focused offline tests: `node --test test/live-gmgn-trader.test.js test/live-manual-approval.test.js test/flap-pool-launch.test.js test/chain-support.test.js test/hyperevm-telegram.test.js` — **75 passed, 0 failed**. Tests cover mocked gates, parsing and source policy, not a live trade, Morph execution, or runtime environment.
- Local monitoring remains degraded: Flap's sitemap is HTTP 404 and all 59 legacy body-watch pages are failing redirects, though direct reads of current canonical Flap docs succeeded. HyperEVM’s local source lane still has three transport-degraded docs (including 11 failures for builder tools); the relevant official JSON-RPC page was independently readable. These are collector coverage gaps, not evidence that either platform is down.
- The Four.Meme public quote-config snapshot remains at 151 entries; no count delta was observed in this interval. No tradeability is inferred from that registry.

## Result

Human review required: Morph appears in first-party Flap economics/app surfaces, but contract/ABI support is missing from the current deployed-address table and the local executor rejects Morph. Reconcile the collector's Morph `deployed` attribution and inspect the BNB Pool Launch signal's live-mirror boundary; do not enable a new chain or alter trade gates automatically. Upstream SHAs and tags did not change in this check. The local source tree was already dirty/staged in many areas; this monitor made no source-code changes.

## Sources

- [Flap Protocol Economics](https://docs.flap.sh/en/flap/v2/developers/protocol-economics)
- [Flap deployed contract addresses](https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses)
- [Flap Morph board](https://flap.sh/morph/board)
- [Morph Mainnet network details](https://docs.morph.network/docs/build-on-morph/developer-resources/contracts)
- [Binance Agentic Wallet network documentation](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)
- [HyperEVM JSON-RPC documentation](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc)
