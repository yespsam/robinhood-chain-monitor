# Platform compatibility follow-up — 2026-11-09 10:58 UTC

Bounded read-only review compared with 2026-11-09 06:50 UTC. No monitored GitHub main ref or tag moved. One Flap protocol page was reviewed that was not captured in the previous cycle; its publication/activation date cannot be established from the available official pages.

## Upstream evidence

- Flap's official Recent Release index links **Buy Quota (v5.14.16)**: https://docs.flap.sh/en/flap/developers/preview/recent-release. The linked official page https://docs.flap.sh/en/flap/developers/preview/recent-release/v5.14.16-buy-quota identifies `Current Protocol Version: v5.14.16`, but also explicitly labels itself Preview / not reviewed; do not treat it as independently confirmed live behavior or a newly shipped change.
- The page describes an optional cumulative per-token bonding-curve buy cap keyed by `tx.origin`. Over-quota buys may partially fill or return zero output while refunding unused quote input rather than reverting. It says quota-aware `eth_call`/quotes must use the actual trader address as `from`; exposes `maxBuyPerOrigin(token)`, `buyQuotaOf(token, origin)`, `FlapTokenMaxBuyPerOriginSet`, and `FlapBuyQuotaUpdated`. Treat as a compatibility watch item pending authoritative release/runtime confirmation because of the page's own warning.
- Binance Agentic Wallet docs still list BSC 56, Ethereum 1, Base 8453, and Solana `CT_501`; no HyperEVM support is listed: https://developers.binance.com/en/docs/products/agentic-wallet/welcome.
- Four.Meme's official announcement index still shows 2026-02-02 as latest; the official Agentic page remains readable and cross-links `four-meme-community/four-meme-ai`: https://four.meme/en/announcement and https://four.meme/en/agentic. No new chain/launchpad was verified. `four-meme-community/openfour-docs` remains community/reference; no official ownership backlink was verified.
- HyperEVM official docs still distinguish HyperEVM from HyperCore, document mainnet 999 / `https://rpc.hyperliquid.xyz/evm`, testnet 998 / `https://rpc.hyperliquid-testnet.xyz/evm`, and native gas asset HYPE: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm. No official HyperEVM launchpad or buy/sell route was found.

Monitored `main` refs (all unchanged; zero tag refs observed): `binance/binance-skills-hub` `96563daf34fa5a87af5d76c2f1107d697ae7ce07`; `four-meme-community/four-meme-ai` `0a07b65468caa73f552dd6a13013ef5071065996`; `four-meme-community/fourmeme-docs` `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`; `four-meme-community/openfour-docs` `84dc55c7f4710544430ef4939ef36e4e514017bb`; `flap-sh/flap-skills` `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`; project `main` `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`.

## Local comparison and coverage

- Current persisted monitor snapshot, latest attempts around 10:55 UTC: Flap document bodies 59/59 failed (last successful body 2026-11-03 18:03:43 UTC; five source-health endpoints degraded); Four.Meme bodies 10/10 failed (last success 2026-11-08 12:35:42 UTC; 13/13 source-health endpoints degraded; six older pending document observations); HyperEVM document watch has 10 tracked pages and zero recorded changes, with five of eight source-health endpoints healthy and three degraded. These are coverage gaps, not evidence that upstream documents are unchanged.
- Local `src/chain-support.js` recognizes HyperEVM chain IDs 999/998 as metadata. This is not an execution adapter. Local Flap quote/launch observation remains BSC-only. Search of local Flap and GMGN executor files found no `maxBuyPerOrigin`, `buyQuotaOf`, quota events, `quoteExactInput`, or `swapExactInput` integration. No direct local Flap quota-aware execution was found; whether an external GMGN route handles this feature is unverified.
- No tests run: this cycle reviewed official pages, refs, and saved health snapshots only. No on-chain reads, wallet access, secrets, signing, broadcast, trade, deploy, restart, push, or merge.

## Follow-up

Recheck whether Flap publishes a reviewed/current contract spec or versioned implementation confirmation, and whether the local document collectors recover. If direct Flap bonding-curve quoting is later added, require exact `from` identity and quota-aware quote/min-output handling; do not adapt the current observer into a transaction path based on this preview page alone.
