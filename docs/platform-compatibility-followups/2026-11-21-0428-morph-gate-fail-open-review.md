# Platform compatibility checkpoint — Morph route fail-open review

## Coverage window

- Checked at `2026-11-21T04:28:38Z`, compared with the saved checkpoint at `2026-11-20T20:24:34Z`; the `8h04m04s` sampling gap includes missed four-hour windows. This is low-frequency sampling, not continuous coverage.
- Read-only and simulated only. No wallet connection, real environment/config/secret reads, external trade CLI invocation, signature, broadcast, order, deployment/restart, source change, strategy/risk change, push, or merge.
- The latest persisted collector-health snapshot is older than this check; current Flap/Four.Meme/HyperEVM collector body freshness was not refreshed here and remains a coverage gap.

## Upstream refs and Flap/Morph documentation

- Rechecked monitored Git refs with `git ls-remote --heads --tags`. No head changes and no tags were returned: Binance `binance-skills-hub` main `7d1b1f78d525f9e653b96819f91a549302fda1da`, `wallet_rm_agent_id` `4fc14e4c0b526c28e7cb1ec130a2a5f7bd99387`; Four.Meme AI main `3918818c064878f577159c0a144323d38c55612b`, `codex/fix-issue-3-events-bigint` `7987396e3db0710fe36c986d1fffc5c810d98846`, `codex/openfour-create` `8e7e92b2e8d9830d20d3df136dd04f7e2bf9670a`; `fourmeme-docs` main `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`; `openfour-docs` main `079a45e9c3358c9f357c84f336c7d915c9f0e9fc`; `flap-skills` main `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`.
- Flap's first-party [legacy token-launcher guide](https://docs.flap.sh/en/flap/developers/token-launcher-developers/launch-token-through-portal) labels itself “Archived docs (v1)” and “out of date and no longer maintained.” Its ABI text includes `Profile.MORPH` and `CURVE_RH_TOSHI_MORPH_2ETH`; this is historical ABI evidence, **not** proof of a currently deployed Morph Portal or active launch/trade support.
- Flap's current [v2 deployed-contract table](https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses) still lists Pool Launch Portal deployments for BNB Chain and BNB testnet, but no Morph deployment row. Its [current developer overview](https://docs.flap.sh/en/flap/v2/developers) says role-based guides are being reorganized and points to the archived documentation. Therefore current Morph contract address, active ABI/version, and transaction route remain unverified. The current [Protocol Economics page](https://docs.flap.sh/en/flap/v2/developers/protocol-economics) states a 2.5% Morph bonding-curve rate but gives no effective date; it does not resolve deployment status.
- Classification update: Morph-specific ABI names exist in official **archived v1** documentation. Do not infer that Flap's current v2 deployment supports those curves, nor reuse the BNB Pool Launch contract on Morph.

## Local compatibility regression reproduced (no live command run)

- In `src/live-gmgn-trader.js`, `loadLiveConfig` accepts arbitrary `LIVE_CHAIN` values and copies them into `chains`; `chainCfg` only marks a chain unsupported when it differs from the configured default. Thus if both configured `LIVE_CHAIN=morph` and the requested order chain are `morph`, the unknown chain bypasses `unsupported`.
- `checkGates` checks only `cfg.unsupported` / membership in `cfg.chains`, not membership in the declared execution specs. `CHAIN_SPEC` currently lists only `bsc` and `sol` and is not used to reject other chain IDs.
- Deterministic mock check with synthetic values (no environment or secrets read): `chainCfg` returned `unsupported:false`; `checkGates` returned `{ok:true}` for the configured Morph case. `buildSwapArgs` then formed a `gmgn-cli swap --chain morph` command with the default BNB spend asset's all-zero native-token address as `--input-token`. The quote helper also constructs a CLI quote for the selected chain. The external CLI was **not** invoked, so whether it rejects or routes this malformed/unverified network/asset combination is unknown.
- This is a fail-closed gate defect / compatibility risk, not evidence that a Morph order was sent or that Morph is tradeable. No runtime configuration was inspected. A separate local Flap Pool Launch observer remains BNB chain ID 56; that does not provide Morph execution.
- Focused offline suite rerun: `node --test test/live-gmgn-trader.test.js test/live-manual-approval.test.js test/flap-pool-launch.test.js test/chain-support.test.js test/hyperevm-telegram.test.js` — **75 passed, 0 failed**. The tests do not cover `LIVE_CHAIN=morph` as the base config, so this defect is not contradicted by that result.

## Recommended minimal repair — pending human review

- Fail closed unless the normalized chain is in an explicit audited executor allowlist (currently `bsc` / `sol`) regardless of `LIVE_CHAIN`; validate the spend asset against that chain before quote or swap construction; reject unknown chains before any CLI call. Add regression tests for both base-config `LIVE_CHAIN=morph` and per-order `chain=morph`, asserting no quote/swap invocation.
- This changes trade construction and execution gating, so it is a proposed repair only; no trading code or thresholds were changed in this scheduled check.

