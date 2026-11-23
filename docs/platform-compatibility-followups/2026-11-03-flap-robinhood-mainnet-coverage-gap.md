# Flap on Robinhood Chain: local observer coverage gap

- Checked: 2026-11-03T10:04:17.870Z (UTC)
- Compared with checkpoint: 2026-11-03T06:00:17.026Z (UTC)
- Scope: verify official Flap deployment documentation, Robinhood Chain network identity, and whether the documented Portal is deployed; compare with the local Flap quote/event observer. Read-only only.

## Finding

Flap's current official [deployed-contract-addresses page](https://docs.flap.sh/flap/developers/deployed-contract-addresses) lists a **Mainnet → Robinhood** Portal at `0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09`, labeled `v5.23.1`, alongside Standard Token Impl, Tax Token V3 Impl, VaultPortal, Tax Token Helper, and Trigger Service. Robinhood's official [network configuration](https://docs.robinhood.com/chain/connecting/) identifies mainnet chain ID `4663` (testnet `46630`) and the public RPC `https://rpc.mainnet.chain.robinhood.com`.

At a single public-RPC latest block, the endpoint returned chain ID `4663`, block `104975330` (`0x6cce41a46457af1a0183e4b7490d30a5c6c562848f86ede40f2d5f2c1f99bbf1`), non-empty code at the documented Portal (2,840 bytes), and a non-empty implementation (20,643 bytes) via the EIP-1967 implementation slot. The slot pointed to `0x413612fffcdb22da15b1d6c542d119b7b75f18c6`. This establishes that code is present at that observation; it does **not** verify the Portal ABI, version semantics, quote/mint behavior, or buy/sell compatibility.

The local observer in [`src/flap-quote-monitor.js`](../../src/flap-quote-monitor.js) is explicitly BNB-only: `FLAP_QUOTE_CHAIN_ID = 56` and Portal `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0`. It validates chain and Portal identity before consuming events. On Robinhood Chain it therefore fails closed with a chain-ID mismatch and does not monitor Flap quote-configuration events. This is a **monitoring/network coverage gap**, not evidence that Robinhood-chain tokens cannot be traded through a separate supported wallet route, and not a claim that every Flap CA is tradable.

## Minimal verification

- `node --test --test-name-pattern='live chain ID and every pinned Portal implementation identity field fail closed' test/flap-quote-monitor.test.js` — 5 passed, 0 failed. The offline cases include a wrong live chain ID; the monitor returns `FLAP_QUOTE_CHAIN_ID_MISMATCH`, stays uninitialized, and makes no `getLogs` call.
- One read-only call sequence against Robinhood's documented public RPC queried `eth_chainId`, `eth_getBlockByNumber`, `eth_getCode`, and `eth_getStorageAt` at the exact selected block above.
- All six monitored GitHub main refs were unchanged from the preceding checkpoint. Relevant refs: Binance skills hub `96563daf34fa5a87af5d76c2f1107d697ae7ce07`; Four.Meme AI `0a07b65468caa73f552dd6a13013ef5071065996`; Four.Meme docs `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`; OpenFour docs `6f7efd5d3f14ed280cf471f70675ffba6d319943`; Flap skills `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`; project GitHub main `bb559cd5316090c37a578f56c2f5fe4655f09ee1`.

## Limits and next step

No quote, launch, mint, wallet preview, transaction, signing, or broadcast was attempted. The Portal's deployed implementation has not been compared against a locally reviewed RH-specific pin/ABI, and this code read was at a latest block rather than a finalized/archive proof. Local `src/flap-quote-monitor.js` and `src/flap-portal-pins.js` are already user-modified in the dirty checkout; they were not edited. A multi-chain observer should be a reviewed change with chain-specific Portal pins, ABI/event fixtures, and fail-closed wrong-chain tests before claiming RH coverage. Do not reuse the BNB pin or widen accepted identities automatically.
