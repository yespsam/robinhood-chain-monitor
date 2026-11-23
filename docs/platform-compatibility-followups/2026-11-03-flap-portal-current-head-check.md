# Flap Portal current-head identity check — 2026-11-03

- Checked: 2026-11-03T06:00:17.026Z (UTC)
- Compared with checkpoint: 2026-11-03T01:55:16.282Z
- Scope: read-only Flap Portal identity confirmation and upstream index recheck. No wallet or transaction flow.

## Result

The prior concern that the *currently observed* BNB Chain Portal implementation might differ from the local v5.27.2 pin is narrowed: two independent public BNB RPC endpoints returned the same EIP-1967 implementation address and runtime-code hash at their respective latest heads.

| RPC observation | Chain | Head | Portal implementation | Runtime-code hash | Bytes |
|---|---:|---:|---|---|---:|
| `bsc-dataseed.binance.org` | 56 | 131381438 | `0xdeba03c2158892de1090305ed74a5facd52ab3570f0c611edd2e33c74c2d48b0` | `0x6fc1ac64c90a5a6d9e7efc0d4064452af3fc9968` | `0x90b3b19ddc87293d5bbd33167d7d977adf1cda5c078549b8cada05c6f9b3fa75` | 20643 |
| `bsc-dataseed1.defibit.io` | 56 | 131381440 | `0xfaecceaaab0eebffd6c2b736dbc0d7703ff8dee430db77ff6fd5d51916acea53` | `0x6fc1ac64c90a5a6d9e7efc0d4064452af3fc9968` | `0x90b3b19ddc87293d5bbd33167d7d977adf1cda5c078549b8cada05c6f9b3fa75` | 20643 |

Each endpoint's storage and code reads used that endpoint's exact block number (not the `latest` tag). These observations match the local fixed-block v5.27.2 receipt in `docs/flap-v5272-compatibility-evidence-2026-10-30.json`. They are latest-head snapshots only, not an explicit finalized-block proof or a mint/swap/quote/buy/sell test. Separate requests to read older state at head minus 200 failed on both endpoints with `missing trie node`, so historical/finalized verification is still a coverage gap.

The official [deployed addresses page](https://docs.flap.sh/flap/developers/deployed-contract-addresses) search snapshot continues to show the same BNB Portal address with label `v5.8.6`; it also says “Last updated 2 days ago” while the search result reports “Crawled 7 months ago.” The direct documentation fetch timed out. The previous checkpoint captured `v5.23.1`. Treat these as inconsistent document/index labels, not proof of a chain upgrade or the current on-chain version. The identity/hash matches the local pin at the two observed heads, so no live implementation mismatch was demonstrated.

## Scope and actions

- The six monitored GitHub `main` refs are unchanged from the previous checkpoint.
- `src/flap-portal-pins.js` and `src/flap-quote-monitor.js` are already modified in the user's working tree; no application source or pin was changed by this check.
- `apps/agentic-wallet-dashboard` remains unavailable in the primary checkout, so its buy/sell path remains unreviewed.
- The reads used public RPC only (`eth_chainId`, `eth_blockNumber`, `eth_getStorageAt`, `eth_getCode`). No API key or secret was read; no wallet, signature, broadcast, trade, deployment, or restart was used.

## Next step

Do not relabel or widen the local pin based on the documentation snippet. Retry the official page through a reliable direct fetch and obtain a finalized/archive-capable read-only BNB RPC proof if needed. Separately validate ABI/quote behavior before making any compatibility claim about mint or buy/sell.
