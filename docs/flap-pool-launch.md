# Flap Pool Launch monitor

Pool Launch skips the bonding curve. One Portal transaction creates a tax token, seeds a V2 pool, burns the LP, and optionally routes the remainder and a creator first buy. The token trades on the DEX from the first block.

Official guide: https://docs.flap.sh/en/docs/pool-launch

BNB Chain (chain id 56) Portal proxy, also the address documented for BNB testnet:

`0x000042108465206185A077Edc3F3fd2b49060000`

This is not the legacy curve Portal `0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0`. Curve `TokenCreated` monitoring is unchanged.

## What is indexed

The BSC launchpad monitor subscribes to `FlapDirectLaunched` on that Portal (full scan and focus3). The same receipt is checked for:

- `FlapTokenGraduated(address token)` — for `DIRECT_V2_POOL_TAX` this is one-shot. If it is missing, the token does not graduate later.
- `FlapLaunchVaultResolved` — vault and vault factory, when the launch has a VAULT fee slot.
- `FlapDistributionExecuted` — dev-remainder handoff. `target == VAULT` means the provenance vault received it.
- `FlapSaltLocked` / `FlapSaltUsed` — recorded when they appear in the launch receipt. They are not separate subscriptions.

`schemaId = keccak256("DirectLaunchV2(DirectLaunchV2Data)")` (`V2_POOL_LAUNCH_SCHEMA_V1`) is decoded as `DirectLaunchV2Data`: nonce, timestamp, token version, quote, migrator, initial price (1e18 quote per token), name, symbol, meta, pool, total supply. The event does not include the quote seed size, so liquidity is reported as that opening price plus total supply, not a USD figure.

An unrecognized `schemaId` still alerts with token, kind, and creator. The struct fields stay empty.

Optional reads on the same Portal, not required to index a launch: `getLaunchToken(token)`, `getLaunchVault(token)`, `graduationFloorV2(...)`.

## How it trades

A canonical `DIRECT_V2_POOL_TAX` launch is a `bsc_launchpad_update` / `flap_pool_launch` with `liveEligible`, `autoTradeEligible: true`, and `automaticExecution: true`. That does **not** make this process sign or broadcast. It admits the token to the confirmed paper session `paper-atm-confirmed-pvp-v2`, which is the ledger `LIVE_SIGNAL_SOURCE=paper-atm-confirmed-pvp-v2` already mirrors into live GMGN buys.

The buy still has to pass that session's existing gates: fresh quote, liquidity, tax, cost, balance, open positions, and loss limits. Size stays the session's fixed 10 U ticket. Exit stays the main-session policy (including its ladder and −20% stop where that runtime already applies them). No new size is introduced.

Unknown schemas stay observe-only (`liveEligible: false`). Curve `TokenCreated` / first-three is unchanged.

Turn Pool Launch trading off without stopping the rest of live:

```bash
LIVE_FLAP_POOL_LAUNCH=false
```

Unset or any value other than `false` leaves it on.

## How to run

Indexing is on with the BSC monitor (`BSC_MONITOR_ENABLED` defaults to true):

```bash
BSC_MONITOR_ENABLED=true npm start
```

Logs look like:

```text
[bsc][flap-pool-launch] Name (SYMBOL) token=0x… pool=0x… creator=0x… quote=BNB price=… graduated=true|false vault=0x…|none tx=0x…
```

Alerts include token, pool, creator, quote, opening price, total supply, graduated or not, vault, and name/symbol.

## Local check

```bash
node --test test/flap-pool-launch.test.js
```
