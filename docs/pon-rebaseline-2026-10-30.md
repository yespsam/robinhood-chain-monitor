# PON rebaseline 2026-10-30

## Problem
Durable cursor was stuck at block `53194884` (baseline 2026-09-02). Public Robinhood RPCs retain roughly 6k blocks of `eth_call` historical state (~3 hours). `scanEvents` → `readCheckpoint` requires `marketCount`/`listingCount` at each chunk end, so catch-up from the old cursor was impossible without an archive RPC.

Live probes: `latest` marketCount=4 / listingCount=3 on robinhood official + publicnode; pinned cursor block failed (`historical state not available` / `Archive requests require a personal token`).

## Action
1. Backup `data/backups/pon-rebaseline-20261030-181900/`
2. Set `initialized=false` to take the designed baseline path (API snapshot + on-chain verify at current finalized tip)
3. Prefer `PON_RPC_URLS=https://rpc.mainnet.chain.robinhood.com,https://robinhood-rpc.publicnode.com`
4. `PON_REORG_REWIND_BLOCKS=64` (inside recent-state window)
5. `PON_API_MAX_BLOCK_LAG=512` (Robinhood ~2s blocks; prior 128 rejected a 185-block API lag)

## Result
- initialized=True
- status=healthy
- cursor.lastScannedBlock=101653485
- marketCountAtCursor=4
- listingCountAtCursor=3
- chain source=healthy
- lastSuccessAt=2026-10-30T10:21:24.844Z

Counts matched the pre-gap cursor (4/3), so no marketCount/listingCount drift was observed across the unscanned window. Full historical event replay still needs an archive-capable Robinhood RPC if that ever becomes available.
