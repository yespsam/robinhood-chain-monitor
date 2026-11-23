# 2026-11-17 21:05 UTC — OpenFour attribution correction and vault callback follow-up

## Checkpoint

- Heartbeat received at 20:58:03Z; final check at 21:05:14Z. Previous checkpoint: 16:58:58Z. Elapsed 4h06m16s, 6m16s beyond target. Latest local source snapshot: 21:04:27Z. This is low-frequency sampling, not continuous monitoring.
- Read-only Git refs for Binance Skills Hub, Four.Meme docs/AI/OpenFour docs, Flap skills and project main were unchanged from the prior checkpoint; no tags were returned. OpenFour main remains 079a45e9c3358c9f357c84f336c7d915c9f0e9fc.
- No wallet connection, secret/config read, signature, broadcast, trade, deployment, restart, push, merge, or application-code change occurred.

## Attribution correction and upstream change status

The previous heartbeat message called OpenFour community/reference because the current Four.Meme website pages sampled then did not show the repository. That label was too conservative. The current [Four.Meme OpenFour Integration page](https://four-meme.gitbook.io/four.meme/developer/openfour-integration) says OpenFour was introduced by Four.Meme and directly links to [four-meme-community/openfour-docs](https://github.com/four-meme-community/openfour-docs). The [Four.Meme documentation home](https://four-meme.gitbook.io/four.meme) also describes infrastructure powered by OpenFour. Treat this as an official-linked project/reference; it does not prove the GitHub organization is legally owned by Four.Meme, nor that every documented contract/ABI is deployed or a current platform rule.

There is no new OpenFour commit since the previous checkpoint. The latest commit, [079a45e9](https://github.com/four-meme-community/openfour-docs/commit/079a45e9c3358c9f357c84f336c7d915c9f0e9fc), changes contracts/taxvault/BaseTaxVault.sol and contracts/taxvault/vaults/ForwardVault.sol (+20/-27; no tests changed):

- BaseTaxVault's default ERC-20 tax callback now checks the caller and requires the asset to equal _taxVaultQuote; its default authorWallet() returns address(0).
- ForwardVault overrides the callback, keeps its caller and reentrancy guards, but removes the quote-asset equality check and forwards the supplied ERC-20 asset balance. It also no longer stores/returns the value from _readAuthorWallet(), so it inherits authorWallet() == address(0).
- This changes the accepted callback-asset and author-fee semantics. It may be intentional; it is not a proven exploit. Human review should confirm which assets the authorized token/initializer may send and whether waiving the author wallet is intended, plus add/identify tests before adoption.

## Official-source and bounded-discovery results

- Binance's [Agentic Wallet overview](https://developers.binance.com/en/docs/products/agentic-wallet/welcome) still lists BSC 56, Ethereum 1, Base 8453 and Solana CT_501; HyperEVM is not listed. The page's last-modified date is November 17, same as the prior sample; no relevant chain-support delta was established.
- Four.Meme's [Agent Skill page](https://four.meme/en/agentic) still advertises 15 capabilities and the official four-meme-ai package. The official announcement page was not reliably parsed by the web reader this check; no claim is made that there were no announcements.
- Flap's current [deployed-addresses](https://docs.flap.sh/en/flap/v2/developers/deployed-contract-addresses) and [Agent Skills](https://docs.flap.sh/en/flap/v2/developers/agent-skills) pages show no new delta against the previous checkpoint. They continue to distinguish launch surfaces and describe Agent Skill v1.3.0 for BNB Chain Tax Token V3. No new launchpad, chain ID, buy/sell interface or ABI change was verified.
- [HyperEVM official docs](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) still distinguish HyperEVM from HyperCore; mainnet is chain 999 at https://rpc.hyperliquid.xyz/evm, testnet is 998 at https://rpc.hyperliquid-testnet.xyz/evm, HYPE is gas, interaction is JSON-RPC, and the default endpoint has no WebSocket JSON-RPC. No delta was established.
- Current official source cross-links were used for attribution; community directories/search snippets were not promoted to platform rules.

## Local compatibility and monitoring coverage

- Local source review found no BaseTaxVault, ForwardVault, onERC20TaxReceived, or authorWallet integration in src or the sampled buy/sell executor modules. No direct local buy/sell impact from this OpenFour change was reproduced. Local src/github-monitor.js marks OpenFour official_verified and test/github-monitor.test.js asserts that label; the current official docs cross-link supports the association. That test is source metadata coverage only, not contract-behavior coverage.
- Focused test: node --test --test-name-pattern='monitors verified Four.Meme community sources' test/github-monitor.test.js — 1 passed, 0 failed. It does not compile or test the OpenFour contracts.
- Four.Meme local source health was 13/13 healthy at 21:04Z; public config still exposed 129 quote configurations and only BNB Chain chain ID 56 as observed supported chain.
- Flap local source health was 4/5 healthy (the sitemap returns 404); its legacy document watcher still showed 59/59 failures: 58 redirect rejections and one 404. Canonical deployment/vault docs and both board sources were independently readable. This remains a local coverage gap, not evidence of Flap service failure.
- HyperEVM local docs state showed 5/8 sources healthy and three persistent fetch failures; the main official page was independently readable this check. No 999/998 executor route or 10055 error mapping was found in the sampled local trade files, so no local HyperEVM trade path is available to assess as supported.
- src/flap-pool-launch.js remains scoped to BNB Chain chainId 56 and monitor-only for parsed observations; no Flap transaction adapter was introduced.

## Open follow-up

Human review of commit 079a45e9 is recommended before adopting the callback behavior: confirm authorized asset provenance, quote-asset policy, and author-fee/authorWallet semantics, and add focused tests if the expanded asset behavior is intended. This report records an upstream reference change and attribution correction, not a local trading regression. No transaction-support code was changed.
