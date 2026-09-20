# Flap Portal v5.23.1 pin evidence

Verified on 2026-09-17 using read-only HTTPS JSON-RPC calls. No transaction was submitted. This record supports the explicit pin update in `src/flap-quote-monitor.js`; it does not make future versions trusted automatically.

## Official source

- [Flap deployed contract addresses](https://docs.flap.sh/flap/developers/deployed-contract-addresses) lists the BNB Chain Portal `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` as **v5.23.1**.
- The configured Portal ABI source remains [FlapVaultExample / IPortal.sol](https://github.com/flap-sh/FlapVaultExample/blob/main/src/flap/IPortal.sol).

## Fixed-block identity

All three origins below independently returned the same block, chain ID, decoded `version()`, EIP-1967 implementation slot and code hashes at the explicit block tag `0x74b3eec`. Every code hash was calculated locally as Keccak-256 of the returned runtime bytecode.

| RPC origin | Fixed-block identity matched |
| --- | --- |
| `https://bsc-rpc.publicnode.com` | Yes |
| `https://bsc-dataseed.bnbchain.org` | Yes |
| `https://bsc.blockrazor.xyz` | Yes |

```json
{
  "chainId": 56,
  "blockTag": "0x74b3eec",
  "blockHash": "0x5079cf13eb3f061b4c9b24b01e4f70555069d07cc62014acdba7a523c6b85557",
  "portal": "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0",
  "version": "v5.23.1",
  "implementationSlot": "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  "implementation": "0xAb8Ec926b6e113c2212aF152b086eA62d1FDced9",
  "portalRuntimeCodeHash": "0x0a3fe6f701ee3cb432f45912e054896327ce5902337eae4d62d01406005a91c3",
  "implementationCodeHash": "0x78653cdd7296d940ae531c86bc6700ae163f1f9dec002c2af3143c9ae6696a15",
  "implementationCodeBytes": 20438
}
```

The methods used were `eth_chainId`, `eth_getBlockByNumber`, `eth_getStorageAt`, `eth_call` for `version()`, and `eth_getCode` for the proxy and implementation. The block tag was supplied to every state/code read; independent `latest` responses were not combined into this proof.

## Canonical upgrade transaction

Both `https://rpc.48.club` and `https://rpc-bnb.blockmachine.io` independently returned the same Portal `Upgraded(address)` event from the transaction receipt and an exact single-block `eth_getLogs` request. Both also returned the matching canonical block and transaction object. The receipt had status `0x1`; the transaction hash appeared in that block's transaction list; transaction, receipt and event block hashes all matched.

```json
{
  "blockNumber": 121652738,
  "blockTag": "0x7404602",
  "blockHash": "0x417ed36b65fcf27dd3cd1e213fdcb9f0fce64ae13b9e403ff4b98fd0f7197845",
  "transactionHash": "0xfa9f414b3a98527d52b3015ee4df17d61a5eb712ce7764cbfc6757e62fa1190f",
  "transactionIndex": "0x55",
  "receiptStatus": "0x1",
  "eventEmitter": "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0",
  "logIndex": "0x592",
  "removed": false,
  "topics": [
    "0xbc7cd75a20ee27fd9adebab32041f755214dbc6bffa90cc0225b39da2e5c2d3b",
    "0x000000000000000000000000ab8ec926b6e113c2212af152b086ea62d1fdced9"
  ],
  "data": "0x"
}
```

The receipt's transaction destination is the upgrade executor `0x1f96bc88f0794060433be5f3ec9159a9c4f08a3b`; the event emitter is the Portal itself. The upgrade block was located by bounded binary search of historical implementation storage on BlockMachine and then verified independently on both origins above. The binary search alone was not treated as canonical event evidence.

## State migration

The sole recognized predecessor tuple is:

```json
{
  "version": "v5.23.0",
  "implementation": "0xeb8d85bACe2AE64B74aa29cC95678a3bBb804350",
  "implementationCodeHash": "0x3ad289cea90449a420c91a8de3a077c4d74a8d41230cb32229fcd843ff1dc3e5"
}
```

The existing migration path still requires a current finalized-block identity quorum before any state rewrite. It preserves the original baseline, cursor, assets, pending candidates, deduplication records, event records and audit history. Unknown predecessor tuples fail validation. Failed identity checks write nothing; failed migration writes require fresh identity verification before retry. Historical coverage is not advanced merely because the version changed.

The older fixed block initially supplied for inspection could no longer be read from non-archive public state endpoints. That failed read was excluded from the proof; all three successful identity results above used the same newer explicit finalized block. Public log range limits were respected by the final single-block event queries.
