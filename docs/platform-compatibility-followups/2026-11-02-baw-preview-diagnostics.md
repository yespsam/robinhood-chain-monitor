# Binance Agentic Wallet preview diagnostics and tracker reports

- Checked: `2026-11-02T05:57:10Z`
- Compared with: `2026-11-02T01:55:11Z`
- Scope: incremental upstream issue/PR review and offline source/test comparison; no wallet operation.

## New upstream reports

The official `binance/binance-skills-hub` repository has two newly observed open issues:

- [Issue #404](https://github.com/binance/binance-skills-hub/issues/404), opened Oct 31, reports one BSC `contract-call preview` returning `SERVICE_ERROR` 351803 for a finite ERC-20 approval without a structured `data`, `blockReason`, risk details, or usable request ID. The author did not execute the request. The same report notes a discrepancy between public explorer/Sourcify exact-source matches and a Token Audit result that still said `isVerified=false` / “Contract Code Not Verified”; it explicitly does not establish that this discrepancy caused the preview block. No Binance response or reproduced independent case is present in the issue snapshot.
- [Issue #405](https://github.com/binance/binance-skills-hub/issues/405), opened Nov 1, reports `baw tracker ws` closing after about 38–40 seconds with zero pushes on three networks. It is a user report, not a confirmed service incident. It concerns the Binance wallet tracker stream, not the repository's GMGN flow or the reviewed dashboard's trade/contract-call invocation.

The official [external-sign reference](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/external-sign.md) says a contract call must not execute after preview failure and intercepted previews have no usable `requestId`. That fail-closed rule remains correct; the missing actionable reason is a transparency/diagnostic concern, not a reason to bypass the security block. No change was found in the six monitored GitHub `main` refs; their SHAs match the previous checkpoint. Binance PRs #403, #396, #393, #392, #382, and #401 remain open/unmerged. #396 is an x402 preview example, #393 a read-only decoder proposal, and #392 a multi-account reference; none changes the local CA route or platform policy.

## Local comparison

The clean feature worktree at `/private/tmp/robinhood-chain-monitor-wallet-mint-swap-20261029`, branch `codex/agentic-wallet-mint-ui`, commit `77144d4`, contains the custom contract-call path. The requested working checkout is separately dirty and has no `apps/agentic-wallet-dashboard` directory, so this comparison does not prove which code is currently served at the user's browser URL.

In the feature worktree, `server/manual-cli.mjs` classifies an unrecognized `success:false` CLI response such as `SERVICE_ERROR` as unknown and does not retry. `server/custom-contract-call.mjs` then maps any non-success preview to `CONTRACT_CALL_PREVIEW_REJECTED`, dropping the safe upstream identity/code that the CLI adapter had extracted. This is fail-closed: the service does not create a review/request ID and `executeContractCall` is not reached. The likely local defect is limited to diagnostic fidelity: a user may see a generic rejection instead of the upstream code and a clear “reason unavailable; nothing submitted” message.

Minimal review recommendation (not implemented): carry only allowlisted official `name`/numeric `code` through the preview error response, never raw provider text/data; display `blockReason unavailable` when absent; keep review creation and execution impossible without a successful, complete preview and request ID. Add a mock test for `SERVICE_ERROR` 351803 that asserts safe code preservation and zero execute calls. Do not infer that explorer source verification overrides the provider audit, and do not weaken the risk gate.

The local CLI adapter has no `baw tracker ws` invocation in this path. The separate signal pipeline is GMGN-based; issue #405 therefore has no demonstrated local effect.

## Validation and limits

- `node --test tests/custom-contract-call.test.mjs tests/custom-contract-route.test.mjs` — 8 passed, 0 failed.
- `node --test tests/manual-cli.test.mjs` — 12 passed, 0 failed.
- These are offline/mock tests; they do not reproduce upstream issue #404 or verify current Binance service behavior.
- No wallet CLI/preflight, wallet status, secrets/config, RPC call, live preview, signature, broadcast, trade, or deployment was performed. No app code was changed.
- Flap X remains unavailable in this check; search only surfaced the already recorded Oct 31 restoration notice. No domain visit or DNS check was performed.

## Next check

Recheck whether issues #404/#405 receive maintainer responses, whether monitored `main` refs or the watched PRs change, and whether the feature-worktree preview diagnostic gap is repaired with a mock regression test. Keep all failed/unknown previews blocked; do not treat either issue as a confirmed Binance root cause.
