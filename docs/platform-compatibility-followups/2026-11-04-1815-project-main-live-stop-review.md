# Project main live-stop / Flap curve-gate review

Checked at 2026-11-04T18:15Z. This is a read-only compatibility and risk review. No wallet, signing, broadcast, trade, deployment, restart, push, or merge was performed.

## Incremental refs and source health

- The five tracked platform repository heads are unchanged: Binance Skills Hub `96563daf34fa5a87af5d76c2f1107d697ae7ce07`, Four.Meme AI `0a07b65468caa73f552dd6a13013ef5071065996`, Four.Meme docs `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`, OpenFour docs `6f7efd5d3f14ed280cf471f70675ffba6d319943` (community/reference), and Flap skills `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`.
- Project GitHub main advanced from `e1f0eb561624c08dd17dd977728d9a89001826ab` to [`25335e6443128a099307b33fdd57844b3df65821`](https://github.com/yespsam/robinhood-chain-monitor/commit/25335e6443128a099307b33fdd57844b3df65821), “Move live stop to breakeven after principal-out and gate flap curve progress”. This is a project change, not a platform-upstream release.
- The canonical Flap Robinhood integration guide remains accessible directly and documents only `TOKEN_V2_PERMIT` via `newTokenV5` and `TOKEN_TAXED_V3` via `newTokenV6`, `V2_MIGRATOR`, and native ETH as the current RH quote token subject to live config verification: [official guide](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide). It does not document the project’s GMGN live-stop behavior.
- Local collection remains degraded as of 18:16Z: Flap’s watcher reports 59/59 tracked pages failed (guide 470 consecutive failures; last success 2026-11-03T18:03:43Z), Flap source-health endpoints are timing out, and Four.Meme source health has 448 consecutive failures with six optional circuits open. This is a local observation/fetch coverage gap; direct official Flap guide returned 200 and Four.Meme’s GitBook “How it works” page returned 200 while `four.meme` endpoints returned 403. Do not infer the platforms themselves are down.

## Project-main behavior and findings

Commit `25335e6` adds a default-on Flap inner-curve progress gate: known Flap curve entries are admitted only in the configured 30–70% interval; missing/out-of-range progress is skipped. Pool Launch and external/graduated markets are intentionally outside this curve gate. This narrows that entry route but does not establish trading compatibility for any arbitrary CA.

The same commit adds a live ladder change after a confirmed principal-out partial: local stop scale moves from `0.8` to `1.0` (or configured cushion), and a GMGN `stop_loss` is created before the prior stop is cancelled. Actual live impact is conditional: the deployed revision, process, and live environment were not inspected. The local checkout is dirty, on branch `codex/paper-focus-forward-simulation`, HEAD `817ff9f`; the running revision remains unknown.

Concrete cancellation-failure reproduction against the local uncommitted module used mocked CLI responses only: replacement `create` succeeded (`new-stop`), old-order `cancel` returned `cancel rejected`, and `runGmgnStopAmend` returned `ok: true`, `orderId: new-stop`, `cancelError: "cancel rejected"`, `cancelledOrderId: null`. The engine stores the new stop and marks the ladder as breakeven-applied; its amendment trigger is guarded by `!breakevenApplied`, so this path has no automatic follow-up cancellation attempt. If the old order remains active (or its state is ambiguous), two 100%-remainder stop orders may coexist and race/oversell. This is a confirmed logic gap in the reviewed local working-tree code, not evidence that it has happened in production. The existing tests cover rejected replacement creation, but not rejected/ambiguous cancellation.

Two additional guardrail observations:

- “Breakeven” is gross entry-price (`entryPrice * 1.0`), not fee-, gas-, tax-, or slippage-adjusted net break-even. The code comments disclose this; users can still incur a net loss when that stop triggers and fills.
- `LIVE_SL_SLIPPAGE_PERCENT` defaults to 15, but the validator accepts integers through 100, while the accompanying comments describe a protective 10–15% range. A 100% override is therefore accepted by code; actual runtime value is unknown and was not read.

## Verification and next action

`node --test test/gmgn-stop-amend.test.js test/live-ladder-breakeven.test.js test/curve-progress-entry.test.js` passed 15/15 on the dirty local worktree. These are offline tests/mocks and do not verify the GMGN CLI, exchange order state, a running service, or production behavior. The explicit cancel-rejection mock above reproduces the `ok: true`/`cancelError` state; the suite has no cancellation-failure regression case.

Before relying on this live behavior, a human should verify the exact deployed revision and intended live flags, then reconcile exchange orders for any affected positions. A reviewed repair should represent cancellation-pending/ambiguous order state, reconcile active orders before retrying (no blind retries), ensure exactly one active remainder stop, add cancellation-failure and timeout tests, distinguish gross cost stop from net break-even in UI/alerts, and enforce the intended protective slippage ceiling. No code or risk configuration was changed here.
