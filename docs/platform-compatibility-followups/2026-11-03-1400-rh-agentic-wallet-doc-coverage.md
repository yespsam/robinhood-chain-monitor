# Robinhood Chain follow-up: Agentic Wallet docs list the chain; Flap observer gap remains

- Checked: 2026-11-03T14:00:18.800Z (UTC)
- Compared with: 2026-11-03T10:04:17.870Z (UTC)
- Scope: incremental official-doc/ref check and local Flap observer revalidation. No wallet or transaction operation.

## Incremental evidence

All six monitored GitHub `main` refs remain unchanged from the saved SHAs. Flap's direct [deployed-addresses page](https://docs.flap.sh/flap/developers/deployed-contract-addresses) still lists Robinhood Mainnet Portal `0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09` with label `v5.23.1`. The [Binance Agentic Wallet `wallet-view.md`](https://github.com/binance/binance-skills-hub/blob/96563daf34fa5a87af5d76c2f1107d697ae7ce07/skills/binance-web3/binance-agentic-wallet/references/wallet-view.md) at the already-tracked Binance skills-hub commit `96563daf34fa5a87af5d76c2f1107d697ae7ce07` includes Robinhood (`binanceChainId: "4663"`) in its documented `wallet chains` response example. This corrects the prior checkpoint's overly broad note that Binance wallet documentation listed only BSC, ETH, Base, and Solana.

The documentation detail is narrower than a live capability check: no `baw wallet chains` command was run, no wallet state was read, and the static example does not validate Flap-specific calls, ABI, quote, mint, or swap paths. Do not infer wallet state or tradeability from it.

## Local compatibility check

The dirty checkout still pins [`src/flap-quote-monitor.js`](../../src/flap-quote-monitor.js) to BNB Chain ID `56` and Portal `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0`. Its wrong-chain behavior remains intentionally fail-closed. Focused test:

```text
node --test --test-name-pattern='live chain ID and every pinned Portal implementation identity field fail closed' test/flap-quote-monitor.test.js
5 passed, 0 failed
```

The existing RH public-RPC observation is still the one recorded in the 10:04 report (block `104975330`); this cycle did not repeat an RPC read or claim that observation as current/finalized. No new code, test fixture, or source change was made. The local Flap quote/event observer gap on chain `4663` remains open, while actual wallet execution compatibility remains unverified.

## Limits

No wallet CLI, secret/config, quote, transaction, signature, broadcast, mint, or buy/sell flow was invoked. `src/flap-quote-monitor.js`, `src/flap-portal-pins.js`, and its test file were already modified in the working tree and were left untouched. No claims about universal CA tradeability.
