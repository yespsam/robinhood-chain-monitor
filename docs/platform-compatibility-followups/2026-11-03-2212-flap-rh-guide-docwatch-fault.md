# 2026-11-03 22:12Z Flap Robinhood guide and documentation-watch fault

- Checked: 2026-11-03T22:12:51Z UTC
- Scope: six tracked GitHub main refs, official Flap Robinhood integration documentation, local doc-watch coverage, and offline safety tests.
- No wallet/secret access, signing, broadcast, mint, swap, buy/sell, deployment, or source edits.

## Upstream snapshot

The six tracked GitHub main refs did not change from the 18:04Z checkpoint: Binance Skills Hub `96563daf34fa5a87af5d76c2f1107d697ae7ce07`; Four.Meme AI `0a07b65468caa73f552dd6a13013ef5071065996`; Four.Meme docs `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`; OpenFour community/reference docs `6f7efd5d3f14ed280cf471f70675ffba6d319943`; Flap skills `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`; project main `bb559cd5316090c37a578f56c2f5fe4655f09ee1`.

The first-party [Flap Robinhood Chain Integration Guide](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide) is present in the official docs sitemap with `lastmod=2026-07-13T06:18:57.575Z` and the local capability state records it was discovered on 2026-10-10; this is not a newly published upstream page in this four-hour interval. Its route-specific facts are material and must be kept distinct from BNB Flap behavior:

- Robinhood launch support is limited to Non-Tax `TOKEN_V2_PERMIT` via `newTokenV5` and Tax Token V3 via `newTokenV6`; other token versions revert `FeatureDisabled()`.
- Both support only `V2_MIGRATOR`; the guide lists Uniswap V2 as the migration venue. Native ETH (`address(0)`) is the only currently enabled quote token, and live configuration must still be checked.
- Pre-graduation pool transfers are blocked; the guide says buys/sells use Portal `swapExactInput`. For Non-Tax tokens, post-graduation anti-farmer restrictions allow the main pool while registered alternative pools remain blocked until expiry.
- The guide's illustrative swap passes `minOutputAmount: 0`; do not copy that as a production execution limit. Local quote policy keeps a positive minimum-output/slippage constraint.

The guide exposes its publication/sitemap timestamp but no source commit or release tag. Its existence and current content were directly rechecked; no change timestamp newer than the sitemap's July 13 value was found.

## Local compatibility and monitoring fault

The main checkout has no `apps/agentic-wallet-dashboard` transaction UI to revalidate. Local `src/flap-quote-monitor.js` remains fixed to BNB chain ID 56 and Portal `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0`; it cannot observe Robinhood chain 4663 or its separate Portal. The BNB/only observer fails closed rather than silently treating RH as BNB. This is an observer gap, not proof that Robinhood trading is impossible.

The local official-document watcher has a reproducible ingestion outage: at 22:12Z its Flap document state showed all 59 tracked pages failed, 58 with `redirect_rejected` and one with HTTP 404. The Robinhood guide page had `lastSuccessAt=17:57:33.591Z` and 92 consecutive redirect failures. A direct read-only request to its sitemap URL returned HTTP 308 with `Location: /en/flap/developers/token-launcher-developers/robinhood-integration-guide`. `src/platform-document-watch.js` only allows `/flap/...` paths and forces `redirect: 'manual'`, then rejects every 3xx. Thus this is a local collector canonical-path mismatch, not evidence the official documentation or contracts are down. Current web access to the canonical `/en/flap/...` page succeeds.

Minimal repair proposal: canonicalize trusted Flap sitemap URLs to the same-origin `/en/flap/...` path before requesting, allow only that exact locale-prefixed Flap path set, and continue rejecting cross-origin, protocol-downgrade, query-bearing, or non-allowlisted redirects. Add a regression test for the observed 308/location and retain rejection tests for external redirects. No source change was made in this check.

## Verification

- `node --test --test-name-pattern='live chain ID and every pinned Portal implementation identity field fail closed' test/flap-quote-monitor.test.js` — 5 passed, 0 failed; offline identity/chain check only.
- `node --test test/trade-bot-engine.test.js` — 8 passed, 0 failed; generic offline paper engine checks stale/over-slippage quotes and unknown receipts, not Flap/Robinhood execution.
- `node --test --test-name-pattern='redirect' test/platform-document-watch.test.js` — 1 passed, 0 failed; confirms generic redirects remain rejected, not that canonical Flap docs can be fetched.

No RH ABI, live quote, mint, wallet preview, signature, or trade was tested. Preserve fail-closed transaction constraints; do not infer universal CA tradeability.
