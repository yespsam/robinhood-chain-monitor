# Flap Pool Launch draft: compatibility and watcher coverage — 2026-11-05 18:21 UTC

## Result

The five monitored GitHub `HEAD` refs are unchanged from the previous check at 2026-11-05 14:21:40Z. No tags were returned by `git ls-remote --tags --refs` for these repositories. The project GitHub `main` is still `12316231628f6efd5a2b477138dc8f2b8e33887e`; the local checkout remains a heavily modified user worktree and is not the same revision.

Newly verified during this check: Flap's official documentation navigation contains a **Drafts → Pool Launch — Integration Guide** page at [the canonical guide](https://docs.flap.sh/en/flap/drafts/pool-launch). Its publication/change timestamp is not exposed in the page response, so this is recorded as newly observed now, not claimed to have been published in this four-hour interval. The canonical page is missing from the local Flap document watch list. The local module points to the old URL `https://docs.flap.sh/en/docs/pool-launch`, which responds HTTP 308 to `/en/flap/drafts/pool-launch`; the canonical URL responds HTTP 200. The watcher intentionally rejects redirects, so this exact source is currently not ingested. Keep that safety behavior and add only the verified canonical URL/route after review.

## Upstream evidence and compatibility

- Flap's official draft page describes a direct-to-V2-pool tax-token launch, with no bonding-curve phase. It lists the Pool Launch Portal at `0x000042108465206185A077Edc3F3fd2b49060000` on BNB Chain mainnet/testnet (56/97). The same draft marks the Direct Launch Portal as TBD on Robinhood Chain (4663) and says the lookup reverts as unsupported. This is a draft specification, not a promise of a Robinhood deployment.
- Its event is `FlapDirectLaunched(address token, LaunchKind kind, address creator, bytes32 schemaId, bytes data)` and its schema identifier is `keccak256("DirectLaunchV2(DirectLaunchV2Data)")`. `FlapTokenGraduated` is emitted at launch only when the one-time graduation floor is met; absence is final for this launch kind. Launches seed a V2 pool, burn LP, and may be tradable immediately, but the draft does not imply every token is safe/sellable.
- The current local [Flap Pool Launch decoder](../../src/flap-pool-launch.js) is explicitly BNB-chain-only (56), uses that portal address, and its event/schema decoder matches the draft. It indexes receipts and emits a paper-signal candidate; this module is not a launch transaction builder and adds no Robinhood-chain route. `node --test test/flap-pool-launch.test.js` passed **4/4** offline tests, including exact topic/schema matching, joined receipt events, and unknown-schema observe-only behavior. This does not test a live transaction, token sellability, or production wiring.
- The official Flap skills page currently labels the separate BNB launch skill v1.3.0 and describes Tax Token V3 only with a live BNB quote-token list. The `flap-sh/flap-skills` GitHub `HEAD` did not change; the docs page has no verified publication timestamp in this check, so no new Git release is claimed. This BNB launch skill is distinct from Robinhood-chain token compatibility.
- [Flap Robinhood integration guide](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide) still limits Robinhood launches to `TOKEN_V2_PERMIT`/`newTokenV5` or `TOKEN_TAXED_V3`/`newTokenV6`, `V2_MIGRATOR`, and native ETH quote. Do not infer that the BNB Pool Launch portal is available on Robinhood or that an arbitrary CA can trade there.
- Four.Meme official GitBook content is still the platform-rule source. Its watcher now records 8/10 pages healthy (up from 0/10 at the prior check); the root page and most recent successful product-update page were fetched at 17:55Z, and the last known body change remains `guide/how-it-works` at 2026-11-01T00:21:48Z. Two paths, `brand/protocol-integration` and `product-update`, remain `redirect_rejected`. This is a real ingestion-coverage improvement, not evidence that every Four.Meme page or trading path has been validated.

## Current persisted coverage snapshot

- Flap: 59/59 configured document pages still `failed`; latest successful tracked page was 2026-11-03T18:03:43Z. `https://docs.flap.sh/sitemap.xml` returns HTTP 404, and the legacy non-`/en` page routes redirect. Independent direct checks in this cycle: legacy pool-launch URL 308 → canonical `/en/flap/drafts/pool-launch`; canonical page 200.
- Four.Meme: 8/10 tracked pages healthy, 2 redirects rejected; main source health is healthy at the snapshot. Last known official body change remains Nov 1 as above.
- The new Flap draft page is absent from the current 59-page watch list. This is a concrete watchlist coverage gap; no local watcher code was changed.

## Refs and ownership

Checked 2026-11-05T18:21Z via read-only `git ls-remote`:

| Repository | `HEAD` SHA | Change since 14:21Z |
| --- | --- | --- |
| `binance/binance-skills-hub` | `96563daf34fa5a87af5d76c2f1107d697ae7ce07` | none |
| `four-meme-community/four-meme-ai` | `0a07b65468caa73f552dd6a13013ef5071065996` | none |
| `four-meme-community/fourmeme-docs` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` | none |
| `four-meme-community/openfour-docs` | `6f7efd5d3f14ed280cf471f70675ffba6d319943` | none |
| `flap-sh/flap-skills` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` | none |
| `yespsam/robinhood-chain-monitor` `main` | `12316231628f6efd5a2b477138dc8f2b8e33887e` | none |

Binance's official site links to the Skills Hub, and Flap's official skill tutorial links directly to `binance/binance-skills-hub` and `flap-sh/flap-skills`. No official Four.Meme documentation backlink to the three `four-meme-community` repositories was verified in this check; keep those repositories as community/reference material rather than platform policy. `openfour-docs` remains unverified as official.

## Actions and next check

No source, strategy, risk threshold, wallet, live config, ledger, or service was changed. No wallet was connected; no secrets were read; no signature, broadcast, trade, restart, deployment, push, or merge occurred.

Next: review adding the exact canonical Flap draft URL as a narrowly allowlisted document-watch seed (do not relax redirect validation); track the draft separately from released Flap and Robinhood support. Continue comparing local chain-56 launch decoding with official ABI/schema and leave chain 4663 fail-closed absent an official deployed portal plus validation.
