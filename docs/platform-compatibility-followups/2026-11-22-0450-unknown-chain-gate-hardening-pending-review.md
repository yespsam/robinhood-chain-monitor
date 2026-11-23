# Unknown-chain trade gate hardening — pending review

Checked at `2026-11-22T04:50:06Z` (UTC), in response to the user's request to implement the previously proposed fail-closed repair.

## Change

The live executor previously treated `LIVE_CHAIN=morph` as enabled when `LIVE_CHAINS=morph`, then could construct Morph swap arguments using the BNB native zero-address input asset. The local patch now:

- Freezes the audited execution-chain map (`bsc`, `sol`) so other code cannot extend it at runtime.
- Makes `chainCfg` mark any unrecognized chain unsupported, including when it matches the configured base chain.
- Makes `checkGates` explicitly reject unknown chains and unsupported chain/spend-asset pairs before wallet/order checks. Accepted pairs remain BSC with BNB or USDT, and Solana with SOL.
- Makes `buildSwapArgs` reject unknown chains and invalid spend assets instead of producing command arguments; canonicalizes recognized chain and asset names.

Files changed in the local worktree: `src/live-gmgn-trader.js` and `test/live-gmgn-trader.test.js`. The test file and trade module already contained unrelated user edits before this repair; those edits were preserved. Nothing was staged, committed, pushed, deployed, or restarted.

## Verification

Added regression coverage for (1) `LIVE_CHAIN=morph` even when `LIVE_CHAINS=morph`, (2) a per-order Morph route from a BSC config, (3) direct argument-builder rejection, (4) refusal before any CLI call, (5) invalid spend assets, and (6) case-normalized BNB checks.

```text
node --test test/live-gmgn-trader.test.js test/live-manual-approval.test.js test/flap-pool-launch.test.js test/chain-support.test.js test/hyperevm-telegram.test.js
77 passed, 0 failed
git diff --check -- src/live-gmgn-trader.js test/live-gmgn-trader.test.js
passed
```

These are local/offline tests with injected mocks; no real GMGN CLI was invoked by the new fail-closed test, no wallet or secret configuration was read, and no transaction was signed or broadcast.

## Review and rollout status

This change affects the live trade eligibility gate. It is therefore a **pending-review patch only**, not approved for production/live execution. Human review should confirm the intended chain and spend-asset allowlist against the operator's actual supported execution paths before any rollout. No new chain is enabled by this patch.
