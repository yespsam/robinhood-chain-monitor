# 2026-11-23 16:53 UTC — routine source and local compatibility review

## Sampling window

- Completed at `2026-11-23T16:53:47Z`, compared with `2026-11-23T12:47:25Z` (4h06m22s). This is a discrete sample, not continuous coverage.
- Read-only Git refs, existing source-health/document-watch snapshots, and local worktree diffs were reviewed. No live market/chain query, wallet access, collector start/stop, or transaction was performed.

## Upstream references

All watched refs remain unchanged:

| Repository/ref | SHA |
|---|---|
| `binance/binance-skills-hub` `main` | `7d1b1f78d525f9e653b96819f91a549302fda1da` |
| `four-meme-community/four-meme-ai` `main` | `3918818c064878f577159c0a144323d38c55612b` |
| `four-meme-community/four-meme-ai` `codex/openfour-create` | `8e7e92b2e8d9830d20d3df136dd04f7e2bf9670a` |
| `four-meme-community/fourmeme-docs` `main` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` |
| `four-meme-community/openfour-docs` `main` | `079a45e9c3358c9f357c84f336c7d915c9f0e9fc` |
| `flap-sh/flap-skills` `main` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` |

`git ls-remote --tags --refs` returned zero tags for all five repositories. The latest-release endpoint returned HTTP 403 for all five, so release state remains unverified rather than “no release.” No commit/file delta was established.

Persisted source coverage as sampled around 16:53Z:

- Flap: 4/5 health sources healthy; sitemap is 404; all 59 legacy watched body routes failed, with the last successful body read on Nov 3. No new recorded body delta; the last one remains Oct 17.
- Four.Meme: all 13 health sources healthy; 8/10 watched bodies healthy, 2 failed. No new recorded body delta; the last one remains Nov 18.
- HyperEVM: 5/8 health sources healthy, while 10/10 watched page bodies succeeded. No new recorded body delta; the last one remains Nov 18.
- The previously raised Flap skills GitHub attribution question remains open; it was not re-reviewed this sample. OpenFour remains an official-linked integration reference, but legal GitHub organization ownership is not established.

## Local compatibility and offline regression

The existing worktree is heavily modified; this task made no source/config/strategy changes. Relevant current local code remains conservative about execution scope:

- `src/chain-support.js` recognizes HyperEVM IDs 999/998 for discovery/classification; this is not a trade adapter.
- `src/live-gmgn-trader.js` allowlists live execution to BSC/SOL and validates spend assets. It now checks raw quote amount, output/minimum-output and slippage; optionally requires the fresh pre-submit quote to equal the user's approved quote; and guards duplicate manual-candidate reservations.
- `src/flap-portal-pins.js` carries the v5.27.2 Portal identity and retains v5.26 as a historical window. This is local identity/monitoring evidence, not a claim of a new supported trade route.
- `src/source-controls.js` has a strict HyperEVM official-doc path gate; no execution support follows from it.

Ran these nine offline/mocked test files:

```text
node --test test/chain-support.test.js test/github-monitor.test.js test/flap-pool-launch.test.js test/flap-quote-monitor.test.js test/flap-portal-pins.test.js test/live-gmgn-trader.test.js test/monitor-source-policy.test.js test/hyperevm-telegram.test.js test/focus-scope.test.js
```

Result: 372 passed, 0 failed. Tests exercised unknown-chain/spend-asset refusal, durable/pending state and Flap identity/observer behavior; no live order, wallet, signature, or chain RPC was used.

Coverage gap for manual review: `test/live-gmgn-trader.test.js` contains no direct approved-quote equality/mismatch or duplicate `manualCandidateId` reservation cases. The implementation branches exist, but this sample did not reproduce a failure. Minimal follow-up is to add injected-run offline tests proving exact approved quote acceptance, changed amount/output/slippage/min-output refusal before swap, and duplicate candidate reservation refusal.

No HyperEVM or Four.Meme buy/sell execution adapter was verified. Local HyperEVM remains metadata/discovery-only; Flap Pool Launch parsing remains BNB Chain 56. Upstream changes do not establish local trade support.

## Local market and flow freshness

- `data/studio/market.json` has a heartbeat and recent file mtime, but its two numeric quote values have no per-quote `observedAt`; status remains `invalid_timestamp`. No live price query was made.
- GMGN and Binance flow snapshots remain about 80 hours old by their explicit timestamps; BSC/SOL/Robinhood are partial/stale, Base/Ethereum are backoff/stale, and HyperEVM flow is not checked. These are known gaps previously notified; no repeated alert in the report record.

## Outcome

No upstream ref or recorded body delta. Focused offline regressions pass. The only new review note is missing direct tests for the manual quote-matching/reservation branches; no compatibility regression was reproduced. No wallet/secrets/signature/broadcast/trade, source/strategy change, deploy/restart, push, or merge.
