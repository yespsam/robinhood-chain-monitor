# Flap Portal version-index conflict — 2026-11-03

- Checked: 2026-11-03T01:55:16.282Z (UTC)
- Compared with checkpoint: 2026-11-02T21:54:45.493Z
- Scope: official documentation retrieval/index and local read-only compatibility evidence; no live-chain or wallet operation.

## Finding

The official Flap [deployed contract addresses page](https://docs.flap.sh/flap/developers/deployed-contract-addresses) was returned by the current search snapshot with the BNB Chain Portal address `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` labeled `v5.8.6`. That snapshot says it was crawled 7 months ago. The previous local checkpoint recorded a different rendered/indexed label (`v5.23.1`) for the same address. Local fixed-block evidence records implementation `0x6FC1ac64c90A5A6d9E7EFc0d4064452AF3FC9968`, code hash `0x90b3b19ddc87293d5bbd33167d7d977adf1cda5c078549b8cada05c6f9b3fa75`, and a successful `getTokenV8Safe` call at block `129871644` on 2026-10-30.

The direct documentation fetch timed out during this check. Therefore this is a documentation retrieval/index conflict, not proof of a fresh Flap deployment, an actual current-chain version, or a local trading regression. Do not infer that `v5.8.6` is newer/current than `v5.27.2`: the labels may use different versioning or one/both snapshots may be stale.

## Local compatibility boundary

- `src/flap-portal-pins.js` is a user-modified working-tree file. It pins the v5.27.2 implementation/code hash based on the fixed-block receipt and its evidence identity window currently extends through `Number.MAX_SAFE_INTEGER`.
- `src/flap-quote-monitor.js` uses strict configured implementation and code-hash pins for its live expected Portal identity. This check did not establish that the monitor accepts a different implementation; no live RPC/current-head read was performed.
- `node --test test/flap-portal-pins.test.js`: 3 passed, 0 failed. These are offline identity/window tests only; they do not resolve the docs conflict or verify current chain state, mint, quote, buy, or sell behavior.
- Local `apps/agentic-wallet-dashboard` source remains unavailable in the primary checkout; UI buy/sell compatibility is still not revalidated.

## Next verification

When a reliable official-doc fetch is available, capture the page's current rendered content and update metadata. Separately, an authorized read-only BNB Chain check should compare the Portal proxy implementation at a fixed finalized block against the locally recorded implementation/code hash and inspect the relevant current ABI/version evidence before any pin window is widened or relabeled. Keep fail-closed behavior until then. No wallet connection, secret/config access, signing, broadcast, trade, deployment, or code modification was performed.
