# Platform compatibility incremental review — 2026-11-19 19:43 UTC

## Coverage window

- Compared with the last saved checkpoint at `2026-11-18T05:04:11Z`; this review completed at `2026-11-19T19:43:26Z`, a `38h39m15s` sampling gap. This is a missed low-frequency observation window, not continuous coverage.
- Read-only checks only. No wallet connection, secret/config access, signature, broadcast, order, deploy/restart, or source/strategy/risk change.

## Upstream refs and attribution

- `binance/binance-skills-hub` main: `7d1b1f78d525f9e653b96819f91a549302fda1da`; `wallet_rm_agent_id`: `4fc14e4c0b526c28e7cb1ec130a2a5f7bd99387`.
- `four-meme-community/fourmeme-docs` main: `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`.
- `four-meme-community/openfour-docs` main: `079a45e9c3358c9f357c84f336c7d915c9f0e9fc`.
- `four-meme-community/four-meme-ai` main: `3918818c064878f577159c0a144323d38c55612b`; `codex/fix-issue-3-events-bigint`: `7987396e3db0710fe36c986d1fffc5c810d98846`; `codex/openfour-create` advanced from `028b49cda4f9fc38c38aa17d268e59b204e3f344` to `8e7e92b2e8d9830d20d3df136dd04f7e2bf9670a` (`feat: integrate OpenFour internal-market trading`, committed `2026-11-19T11:08:29+08:00`). This is a non-main branch; no release/tag or main-branch change was found.
- `flap-sh/flap-skills` main: `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`.
- Project GitHub main: `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`.
- Official attribution remains scoped: Four.Meme's [Agentic page](https://four.meme/en/agentic) links the AI repository; its [OpenFour integration guide](https://four-meme.gitbook.io/four.meme/developer/openfour-integration) describes OpenFour as introduced by Four.Meme and links `openfour-docs`. This cross-link does not make every branch or draft change a platform rule or prove a deployment.

## Material deltas

### OpenFour internal-market buy/sell code (branch only)

The changed branch adds `openfour-trade.ts`, ABI/CLI files, a trade reference, and tests. The reference describes BSC chain ID 56, OpenFourCore's internal market while the Vault is in `Trading (1)`, read-only estimates, buy/sell limits, exact ERC-20 allowance and transaction simulation. It stops for migrated/non-trading phases instead of assuming an external DEX route. The execution function reads `PRIVATE_KEY`; when allowance is insufficient it can submit and confirm an approval before simulating the later trade. The reference explicitly warns that the approval can therefore be broadcast even if trade simulation subsequently fails.

This is a material new execution path to keep under human review, but it is only a branch in an officially linked public integration repository—not a release, main-branch change, verified deployment, or local integration. Do not infer support for arbitrary OpenFour tokens or migrated tokens. The branch was statically inspected; its own tests were not run here.

### Four.Meme quote-asset configuration

The official public-config endpoint returned HTTP 200 during this review. The last saved compatibility report recorded 129 normalized BSC/MEME/PUBLISH quote configs at Nov 18 05:03Z; the retained platform-source snapshot had 132 by Nov 19 04:29Z, then the current payload normalized to 151. Thus there are 22 more than the last compatibility checkpoint; the 19 added after the retained 132-entry snapshot are identifiable, while the earlier +3 cannot be individually attributed because only count/fingerprint (not the full 129-entry baseline) was retained. The 19 later symbols are `ANTB`, `APPB`, `BBB`, `BOTB`, `BRKBB`, `BSPB`, `EWZB`, `EWZSB`, `GEVB`, `KSTRB`, `MDBB`, `MELIB`, `NUB`, `PENGB`, `SKDDB`, `SKUUB`, `TMFB`, `UVXYB`, `VSTB`. No static fee/threshold/address change was found among the 132 symbols retained in the Nov 19 source snapshot when excluding the dynamic `totalBAmount` field. This is quote-asset metadata only; it does not establish new chain support or that any CA is tradable.

The Nov 18 document-body watcher also recorded a `how-it-works` copy addition describing an approximately `0.005 BNB` transaction fee. That record is marked pending verification and does not identify a new buy/sell route or chain.

### HyperEVM official documentation

The official [JSON-RPC page](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc) now lists `eth_getBlockByNumber`; the official [Core/EVM transfer page](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/hypercore-less-than-greater-than-hyperevm-transfers) documents a Core-to-EVM transfer cost of 200k gas at the next EVM block's base gas price. The local body watcher recorded these on Nov 18 (`2026-11-18T17:56:34Z` and `16:11:21Z` respectively); the current bounded read confirms the content. Other tracked body diffs are incomplete boilerplate/text deltas and remain non-actionable. Current official docs still distinguish HyperEVM from HyperCore, list HYPE gas and chain IDs 999/998, and describe EVM access through JSON-RPC; no new launchpad was found.

## Local compatibility and verification

- `src/chain-support.js` classifies HyperEVM IDs 999/998 for discovery/alerts; no HyperEVM buy/sell executor or 10055 transaction-error mapping was found in the sampled execution code. The RPC method/transfer documentation delta therefore does not establish local execution compatibility.
- Targeted search found local OpenFour discovery/event and source-policy paths in `src/bsc-launchpad-monitor.js` and `src/source-controls.js`, but no corresponding OpenFour `executeOpenFour`, `writeContract`, or `sendTransaction` adapter in `src/`. No local effect from the branch-only executor was reproduced.
- Flap's persisted health snapshot has a one-off `flap.sh/board` timeout and the known sitemap 404; the Morph board and canonical deployed-contract/skills docs are healthy, and canonical docs were independently readable. This is collector coverage degradation, not evidence that Flap is down.
- Local offline tests: `node --test test/chain-support.test.js test/hyperevm-telegram.test.js test/flap-pool-launch.test.js test/four-registry-generations.test.js` — 29 passed, 0 failed. These cover discovery, policy, and launch decoding; they do not test HyperEVM or OpenFour transaction execution.

## Result

Material: 22 more published quote configs than the prior saved checkpoint (19 later symbols individually identified; 3 earlier additions are not attributable from retained evidence); a new branch-only OpenFour BSC internal-market execution implementation with a possible approval-before-trade-simulation side effect; and two HyperEVM documentation additions. No local compatibility regression was reproduced, and no local trade support was added. The long sampling gap and Flap collector failure are coverage limits that must remain explicit.
