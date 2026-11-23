# Flap Portal / Agent ID proposal delta — 2026-10-31

Checked at `2026-10-31T05:44:02.753Z` (UTC), compared with checkpoint `2026-10-31T01:43:32.066Z`.

## Findings

The monitored main refs did not move: Binance Skills Hub `96563daf34fa5a87af5d76c2f1107d697ae7ce07`; Four.Meme AI `0a07b65468caa73f552dd6a13013ef5071065996`; Four.Meme docs `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`; OpenFour docs `6e1b1c3a3c77be383784e23f5f01198d34690f1e`; Flap Skills `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`; project main `bb559cd5316090c37a578f56c2f5fe4655f09ee1`.

Two open, unmerged submissions to the official Binance Skills Hub are relevant but are not platform rules:

- [PR #382](https://github.com/binance/binance-skills-hub/pull/382), commit `23c83fc`, proposes a Meme Rush documentation clarification: for Flap V6, `taxFeeDistribution.taxRateVaultAddress` may identify the creating factory rather than the callable/receiving vault; resolve with Flap `VaultPortal.tryGetVault(token)` and distinguish `vault` from `vaultFactory`. The visible PR page showed no reviews/checks. The cited official Flap `indexing-vaults` page could not be independently fetched in this check (502; Markdown URL unavailable), so the interface details remain proposal-level here. This reinforces a safety concern for any future vault interaction but does not establish a local bug in the current wallet route.
- [PR #401](https://github.com/binance/binance-skills-hub/pull/401), commit `c7759bf`, proposes a SEEDS Agent ID-gated BSC on-chain garden skill using Agentic Wallet `contract-call preview/execute`. The author claims the contracts are verified and non-proxy; this monitor did not validate those claims. The PR page showed no reviews/checks. It is neither an official launch rule nor evidence that arbitrary contracts, minting, or later token trading are universally supported.

## Version discrepancy requiring follow-up

The [Flap official deployed-contract-addresses page](https://docs.flap.sh/flap/developers/deployed-contract-addresses.md) currently labels the BNB Chain Portal at `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` as v5.23.1. Existing local evidence [flap-v5272-compatibility-evidence-2026-10-30.json](../flap-v5272-compatibility-evidence-2026-10-30.json) records the same proxy at fixed block 129871644 with implementation v5.27.2 (`0x6FC1ac64c90A5A6d9E7EFc0d4064452AF3FC9968`) and a successful `getTokenV8Safe` call for one sample token. Possible explanations include stale deployment docs or different meanings of “Portal version” and “implementation version”; the discrepancy is not resolved here. No current-head RPC recheck, complete ABI verification, mint, buy, or sell test was performed. Do not use this alone to claim every CA or mint/trade path is compatible.

## Local effect and coverage

The requested checkout remains dirty, and `apps/agentic-wallet-dashboard` is absent. Existing local Flap pin changes were not edited. No new code regression was established and no tests were rerun. A future bounded read-only check should compare the current BNB Portal implementation against both the official deployment page and the fixed-block receipt, then validate only safe ABI/interface metadata. No wallet connection, secrets access, signing, broadcast, or trade occurred.

## Sources

- https://github.com/binance/binance-skills-hub/pull/382
- https://github.com/binance/binance-skills-hub/pull/401
- https://docs.flap.sh/flap/developers/deployed-contract-addresses.md
- https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/indexing-vaults (not retrievable via this check)
- https://github.com/binance/binance-skills-hub/commit/96563daf34fa5a87af5d76c2f1107d697ae7ce07
