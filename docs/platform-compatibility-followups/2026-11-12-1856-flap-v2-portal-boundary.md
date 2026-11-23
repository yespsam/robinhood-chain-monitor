# 2026-11-12 18:56 UTC — Flap v2 protocol boundary and documentation coverage

## Check window

- Compared with the 2026-11-12 14:59 UTC checkpoint; elapsed about 3h 57m 52s. This is low-frequency sampling, not continuous monitoring.
- Read-only Git refs: Binance Skills Hub `7d1b1f78d525f9e653b96819f91a549302fda1da`; Four.Meme AI `0a07b65468caa73f552dd6a13013ef5071065996`; FourMeme docs `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`; OpenFour docs `8ca5554df22ad511126d8547c212fa161ecf19ee`; Flap Skills `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`; authenticated project `origin/main` `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`. All unchanged from the prior checkpoint; no tag refs observed.
- Binance's official Agentic Wallet overview still describes generic market/limit-order capability. Four.Meme `/en/agentic` still lists 15 capabilities, including buy/sell quotes and execution. Hyperliquid JSON-RPC docs remain unchanged in checked details. Four.Meme announcement page returned 403 in the independent page fetch; local persisted source health did not show a corresponding new service outage.

## First-party Flap v2 docs reviewed

- The old URL `https://docs.flap.sh/en/flap/developers/deployed-contract-addresses` explicitly labels itself archived v1 and points to the current page.
- Current deployed-address page: [https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses](https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses). It describes two distinct protocols and separates their Portal addresses. The current Bonding Curve tables list deployments on BNB Chain, Robinhood Chain, Base, X Layer, Monad, Toshimart, Muffun and BNB Chain Testnet. The Pool Launch section says it is live on BNB Chain and BNB Chain Testnet, at the same Portal address on both: `0x000042108465206185A077Edc3F3fd2b49060000`.
- Current Pool Launch integration page: [https://docs.flap.sh/en/flap/v2/developers/pool-launch/build-on-pool-launch](https://docs.flap.sh/en/flap/v2/developers/pool-launch/build-on-pool-launch). It identifies Pool Launch as Beta/permissioned: Launcher and Vault factories must pass Flap audit and be enabled before use. Its token-launch interface is `launchTaxTokenV2`; the page documents specific tax, quote-asset, fee-slot, distribution and creator-buy parameters. This is protocol documentation, not proof that a particular factory or token is enabled or that a deployment changed in this four-hour window.
- The old v1 address page now clearly says it is out of date and no longer maintained. I could not establish the publication time of the v2 pages; therefore this is recorded as a current-source/coverage discovery, not a claim that the protocol launched or changed during this sample.

## Local compatibility comparison

- Local `src/flap-pool-launch.js` pins the Pool Launch Portal above, `chainId=56`, and parses `FlapDirectLaunched` kind 0 (`DIRECT_V2_POOL_TAX`). It marks decoded launches `monitorOnly: true` and `autoTradeEligible: false`. `src/bsc-launchpad-monitor.js` is BNB-chain scoped.
- This matches the official BNB Pool Launch Portal identity for the narrow BSC event-monitor path. It does **not** implement general Flap Bonding Curve routing, other chains' Flap deployments, or the permissioned custom Launcher-creation lifecycle. The monitor's source comment says buys are not sent by this monitor; any downstream paper/GMGN signal-to-order behavior and current runtime configuration were not tested. No end-to-end buy/sell compatibility is claimed.
- No local code or configuration was changed. No tests were run; this was official-page review, read-only Git refs, local source inspection and persisted collector-state inspection.

## Coverage and follow-up

- Persisted local document watcher at `2026-11-12T18:55Z`: Flap 59/59 tracked pages failed; its sitemap health URL returned HTTP 404 (6,991 consecutive failures). Four.Meme 2/10 tracked pages failed while all 13 source-health entries were healthy. HyperEVM had 10 tracked pages, 0 failed, 0 recorded body changes; its source-health snapshot still showed 3/8 degraded entries with old errors dating to Nov 7. These are persisted monitor observations, not proof of continuous availability.
- The automated Flap doc inventory is still based on stale/redirecting routes and does not cover the current `/en/flap/v2/...` pages reviewed above. Minimal follow-up for human review: add the two current canonical v2 URLs to the bounded document watch while retaining redirect rejection and classify the v1 URL as archived. Do not broaden trade support based on the page list; Pool Launch's page says factory access is permissioned.
- No wallet connection, secret/config read, signature, broadcast, trade, strategy/code/config change, deployment/restart, push or merge.
