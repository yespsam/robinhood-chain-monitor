# Platform documentation fetch timeouts — 2026-11-05 22:16 UTC

## Summary

The monitored GitHub refs remain unchanged since 18:21Z, but the local platform collector has a material coverage regression. In the latest persisted `data/platform-capability-state.json`, Flap document coverage is 0/59 successful pages and Four.Meme is 0/10 at the page level. Flap's last successful tracked page remains 2026-11-03T18:03:43.843Z. Four.Meme's last successful page was fetched at 2026-11-05T19:25:33.247Z, but the latest ten page attempts failed by 22:16Z. The earlier 8/10 Four.Meme recovery did not persist.

The source-health records classify the recent failures as `transport` / `The operation was aborted due to timeout` across both platforms' document and non-document sources. The document watcher stores the page-level error class `document_fetch_failed`. This cross-source timeout pattern is broader than the known canonical-path/redirect issue, so it is not yet attributed to a specific upstream outage or a code defect.

## Bounded independent checks

Read-only direct requests from this shell returned HTTP 200 in approximately 1.0–1.2 seconds for:

- Flap canonical draft: `https://docs.flap.sh/en/flap/drafts/pool-launch`
- Flap Robinhood integration guide: `https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide`
- Four.Meme official GitBook `guide/how-it-works`
- Flap BNB board: `https://flap.sh/board`

The browser search/open tool could not open the Flap draft URL on this check, while the independent shell request returned 200; this is recorded as a tool-path discrepancy, not as a Flap outage. The checks establish that these exact endpoints were reachable from one shell context at that moment; they do not prove the background monitor uses the same environment or that all pages are healthy.

`node --test test/platform-document-watch.test.js`: **12 passed, 0 failed**. These are fixture/mock tests; they do not exercise the running worker's network path or prove the timeout cause. A direct request and passing offline tests narrow but do not resolve the fault. Keep the explicit redirect rejection and canonical allowlist gap from the previous report distinct from this timeout class.

## Compatibility and upstream refs

No upstream code change was found in this cycle. Read-only `git ls-remote` at 22:16Z:

| Repository | `HEAD` SHA | `refs/tags` |
| --- | --- | --- |
| `binance/binance-skills-hub` | `96563daf34fa5a87af5d76c2f1107d697ae7ce07` | none |
| `four-meme-community/four-meme-ai` | `0a07b65468caa73f552dd6a13013ef5071065996` | none |
| `four-meme-community/fourmeme-docs` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` | none |
| `four-meme-community/openfour-docs` | `6f7efd5d3f14ed280cf471f70675ffba6d319943` | none |
| `flap-sh/flap-skills` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` | none |
| `yespsam/robinhood-chain-monitor` `main` | `12316231628f6efd5a2b477138dc8f2b8e33887e` | none |

The official Flap Robinhood guide still lists `TOKEN_V2_PERMIT`/`newTokenV5` or `TOKEN_TAXED_V3`/`newTokenV6`, `V2_MIGRATOR`, and native ETH quote; no newly verified chain or token-version support. The Pool Launch draft remains untracked by the local watcher and explicitly does not establish a Robinhood Portal. Local Pool Launch decoding remains BNB Chain 56-only; the prior offline parser tests passed 4/4 and are not live-trade validation. Four.Meme official `how-it-works` content still describes BNB internal multi-quote pools and migration; no new document-body change was established in this check.

## Safe actions and next diagnostic

No strategy, trade path, risk threshold, wallet, ledger, source code, or monitor configuration was changed. No process was restarted; no secrets were read; no wallet was connected; no signature, broadcast, or trade occurred; nothing was deployed, pushed, or merged.

Next: compare the background collector's redacted timeout/worker-run data against one direct successful URL from the same process environment; determine whether its abort budget, queueing, runtime/network context, or runtime revision explains the broad timeout. Keep unknown outcomes as a coverage gap; do not mark the Flap canonical draft ingested until a durable successful body read is recorded.
