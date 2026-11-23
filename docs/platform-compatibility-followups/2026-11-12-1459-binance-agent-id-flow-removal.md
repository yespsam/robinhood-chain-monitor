# 2026-11-12 14:59 UTC — Binance Agent ID-exclusive flow removal

## Check window and scope

- Compared with the 2026-11-12 10:58 UTC checkpoint. The interval was about 4 hours; checks are periodic samples, not continuous monitoring.
- Read-only refs checked: Binance Skills Hub, Four.Meme AI/docs/OpenFour docs, Flap Skills, and authenticated `origin/main`. No release/tag refs were returned.
- Official ownership cross-checks remain: Binance Developer Agentic Wallet docs link the Binance Skills Hub; Four.Meme's official GitBook integration page links OpenFour docs; Flap docs link Flap Skills. OpenFour is treated as an official cross-linked integration repository, but its implementation claims are not automatically treated as deployed platform behavior.

## Material upstream change

Binance `binance/binance-skills-hub` advanced from `96563daf34fa5a87af5d76c2f1107d697ae7ce07` to `7d1b1f78d525f9e653b96819f91a549302fda1da`:

- Commit: [7d1b1f78d525f9e653b96819f91a549302fda1da](https://github.com/binance/binance-skills-hub/commit/7d1b1f78d525f9e653b96819f91a549302fda1da), titled “remove Agent ID exclusive token trading flow”.
- The commit changes 10 paths (+3/-1436):
  1. `skills/binance-web3/binance-agentic-wallet/SKILL.md`
  2. `skills/binance-web3/binance-agentic-wallet/references/agent-id-claim-status.md`
  3. `skills/binance-web3/binance-agentic-wallet/references/agent-id-exclusive-token-launches.md` (deleted)
  4. `skills/binance-web3/binance-agentic-wallet/references/limit-order.md`
  5. `skills/binance-web3/binance-agentic-wallet/references/market-order.md`
  6. `skills/binance-web3/binance-agentic-wallet/references/preflight.md`
  7. `skills/binance-web3/binance-agentic-wallet/references/security.md`
  8. `skills/binance-web3/binance-agentic-wallet/scripts/agent-id-exclusive-token-launches.mjs` (deleted)
  9. `skills/binance-web3/meme-rush/SKILL.md`
  10. `skills/binance-web3/meme-rush/references/cli.md`
- The specialized Agent ID-exclusive Four.Meme trading guide/script and special routing notes (including BSC suffix/routing and bonding-curve protocol 2004 handling) are removed from the skill material. Generic market/limit-order security and token audit guidance remains.
- Classification: meaningful change to Binance Agentic Wallet skill guidance and its documented Four.Meme route, but the diff alone does **not** establish a change to a deployed smart contract, token eligibility, chain support, or launch mechanics. Do not infer that restrictions have been lifted or that trading is now available.

## Local compatibility comparison

- The project checkout remains `codex/paper-focus-forward-simulation` at `817ff9fc8a79a12137e1658cfb45b343e4c7f46e`, with extensive user-owned staged/unstaged changes; it was not modified.
- Focused read-only search of `src/` and `package.json` found no `AgentIdExclusive`, `agent-id-exclusive`, or `openfour.meme.AgentIdExclusive` implementation and no Binance Agentic Wallet/`baw` execution adapter. `src/github-monitor.js` does monitor Binance skill paths, which is source monitoring, not transaction execution.
- Therefore an impact on the local buy/sell path was **not reproduced**. Local code has no verified adapter to this specialized Binance skill route; no claim is made about the running process or other external agents.
- No tests run; this was a bounded Git ref/commit diff, official-doc review, local source search, and persisted collector-state comparison only.

## Other monitored sources and coverage

- Unchanged refs: Four.Meme AI `0a07b65468caa73f552dd6a13013ef5071065996`; Four.Meme docs `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`; OpenFour docs `8ca5554df22ad511126d8547c212fa161ecf19ee`; Flap Skills `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`; project `origin/main` `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`.
- Official Four.Meme announcement and Agentic Wallet pages, Flap deployed-contract and v5.14.16 Buy Quota docs, and Hyperliquid HyperEVM docs showed no material change in this sample. The Buy Quota page remains labeled Preview/unreviewed; no deployment inference made. HyperEVM remains documented as mainnet chain ID 999 / `https://rpc.hyperliquid.xyz/evm`, testnet 998 / `https://rpc.hyperliquid-testnet.xyz/evm`, native gas HYPE; HyperCore features are not treated as EVM contract trading support.
- Latest persisted collector snapshot: Flap 59 pages / 59 failures; Four.Meme 10 / 2 failures; HyperEVM 10 / 0 failures / 0 recorded changes. Flap and Four.Meme route failures are an existing coverage gap, not evidence of unchanged content or a newly worsened failure.

## Operations

No wallet connection, secrets/config read, signature, broadcast, trade, source/strategy/config change, deployment/restart, push, or merge. No local project files other than this follow-up note and the monitor checkpoint were changed.
