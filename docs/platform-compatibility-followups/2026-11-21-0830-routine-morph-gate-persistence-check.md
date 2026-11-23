# Platform compatibility checkpoint — routine delta and Morph gate recheck

## Coverage window

- Checked at `2026-11-21T08:30:12Z`, compared with `2026-11-21T04:28:38Z`; elapsed `4h01m34s`. This is low-frequency sampling, not continuous coverage.
- Read-only checks plus a deterministic mock of the gate/argument builders. No real environment/secrets read, external GMGN CLI call, wallet connection, signature, broadcast, order, deploy/restart, source change, strategy/risk change, push, or merge.

## Upstream incremental status

- Rechecked heads/tags for Binance `binance-skills-hub`, Four.Meme AI/docs/OpenFour docs, and Flap Skills. All returned the same SHAs as the 04:28Z checkpoint; no tag refs were returned.
- Current Binance Agentic Wallet docs still list BSC 56, Ethereum 1, Base 8453, and Solana `CT_501`; no Morph or HyperEVM support is listed. The page's last-modified label is Nov 20, 2026. [Official page](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)
- Current Flap docs still distinguish the bonding-curve and Pool Launch contracts, show Pool Launch deployments for BNB mainnet/testnet, and have no Morph deployment row. The 2.5% Morph bonding-curve rate remains documented with no effective date. [Deployments](https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses) · [Protocol economics](https://docs.flap.sh/en/flap/v2/developers/protocol-economics)
- HyperEVM official docs still specify chain ID 999/mainnet and 998/testnet, HYPE gas, JSON-RPC-only interaction and no official EVM frontend. No upstream reference delta was identified in this check.
- The previously found Morph ABI names remain on the Flap page explicitly marked archived/out-of-date v1 only; they do not verify a current Morph deployment.

## Local compatibility recheck

- The previously reported fail-open configuration remains reproducible in the current dirty worktree: synthetic `LIVE_CHAIN=morph` plus an order for Morph yields `chainCfg(...).unsupported === false` and `checkGates(...) === { ok: true }`. With the default BNB spend asset, `buildSwapArgs` forms `--chain morph` with the all-zero BNB native input-token address. No CLI was invoked; actual GMGN behavior and runtime environment remain unknown.
- Focused offline tests rerun: `node --test test/live-gmgn-trader.test.js test/live-manual-approval.test.js test/flap-pool-launch.test.js test/chain-support.test.js test/hyperevm-telegram.test.js` — **75 passed, 0 failed**. This suite still does not exercise base-config `LIVE_CHAIN=morph`.
- No trading code change or repair validation occurred. The hard chain allowlist and chain/spend-asset binding recommendation remains pending human review. The immediately prior report contains the full reproduction and proposed minimal repair: [`2026-11-21-0428-morph-gate-fail-open-review.md`](2026-11-21-0428-morph-gate-fail-open-review.md).
- Collector-health snapshots were not refreshed; the previously recorded Flap / HyperEVM collector freshness limitations remain coverage gaps, not platform-outage evidence.

## Result

- No new upstream Git ref/tag or current-doc deployment change was observed. The local unknown-chain gate issue is unchanged from the prior alert, so this routine check does not repeat the notification. Next check not before `2026-11-21T12:30:12Z`.

