# Genius.fun official-source evidence

Checked 2026-09-18 (UTC). Read-only research; no wallet session, transaction, private key, or paid API was used. This document records observations, not an endorsement of launch tokens.

## Canonical public integration sources

- Homepage: <https://genius.fun/>
- Contract registry: <https://genius.fun/docs/contracts>
- Integration specification: <https://genius.fun/docs/integrate>
- Deployment manifest: <https://genius.fun/contracts/manifest.json>
- Factory ABI: <https://genius.fun/contracts/abi/4.1.0/GeniusLaunchFactory.json>
- Token ABI: <https://genius.fun/contracts/abi/4.1.0/GeniusLauncherToken.json>
- Curve ABI: <https://genius.fun/contracts/abi/4.1.0/GeniusBondingCurve.json>
- ABI checksums: <https://genius.fun/contracts/abi/4.1.0/checksums.json>

The integration page explicitly says there is no public REST or WebSocket API. Website endpoints are same-origin only; supported third-party integration is through contract events and view functions. The monitor must not depend on undocumented website endpoints or bypass geographic/access restrictions. Public documentation and contract files were available without authentication.

Observed manifest fields:

| Field | Value |
| --- | --- |
| Chain | BNB Smart Chain, chainId `56` |
| Release | `prod-foundation-20260916` |
| Source commit | `f5fbd1fde93cbd7dbe44e3276cafbea9875f9996` |
| Built at | `2026-09-16T19:40:20.243Z` |
| Stack | `bnb-mainnet-m4.1` |
| ABI version | `4.1.0` |
| Index from block | `122266383` |
| Factory | `0x78EAE9537C0ef90DFe9B7ae964682Fe8138afe31` |
| Factory runtime bytecode hash | `0x416f19c32fbf75ea1a0cd2f51d05f0722f1f4cb0dbaf8f00cb22832345d4eef6` |
| Launch deployer | `0xaB3eAD42ec2587D16BAE8f2c9Fb133c533C7fAAf` |
| Launch-and-buy router | `0x2EF00378984e84f2DAa08DfB5Fb03bBDE2038ae6` |
| Owner/controller | `0xE7C7B7EE71db0f1B4F0Ff25D7cEc191268e7FD98` |
| Deployment sender, NOT blanket token issuer attribution | `0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed` |
| Foundation vault, NOT proof that a token is official | `0xF1200f24c38dDCE80A3F0cF26606F047c8EBE49b` |

`TokenLaunched(address,address,address,address,uint256,uint256)` topic0 is `0x8d4aad4953d0ca700d468f3753aa14432d1b35b43ec6409f051fb6aa43a89607`. Its indexed fields are token, curve and deployer. Other useful factory events include `LaunchSwept` and `PoolGraduated`; the factory ABI also exposes launch/configuration/governance changes.

Native BNB uses `pairToken = address(0)`. The release manifest also lists 465 approved ERC-20 quote assets. Quote-asset admission and economics must be read per asset; a symbol or a hardcoded 15 BNB threshold is not valid for every launch.

## Independent on-chain observation

Both `https://bsc-dataseed.bnbchain.org` and `https://bsc.blockrazor.xyz` returned:

- chainId `0x38`;
- fixed block `0x74e46f2`;
- block hash `0x54fdf767aa4ad2d04dfc007e6839f5af32adf7ce50286fde8c11caa672aea545`;
- factory runtime code hash `0x416f19c32fbf75ea1a0cd2f51d05f0722f1f4cb0dbaf8f00cb22832345d4eef6`, matching the manifest.

Separate recent-block reads on these providers also agreed on `owner()`, `launchDeployer()`, and `launchFee() = 2000000000000000` wei. These are point-in-time observations, not a permanent substitute for the runtime identity gate.

`rpc.48.club` and PublicNode rejected at least one historical-state request during this check (`not supported` / archive personal-token requirement). A failed source must remain visibly incomplete, not be interpreted as empty logs or successful coverage.

### Factory creation and the manifest's earlier index boundary

The chain-reader verification on 2026-09-18 used `https://bsc-mainnet.public.blastapi.io` and `https://rpc-bnb.blockmachine.io` to independently establish the actual creation boundary:

- Manifest index start: `122266383` (unchanged; this is not the creation block).
- Factory creation block: `122266653` (`0x749a41d`).
- Block hash: `0xc75b7ae5b74a167137700ebaf9a3b7608af49b451ded90cfe40dbace4e438f75`.
- Creation transaction: <https://bscscan.com/tx/0xe22293ddd7b7b65d6c930bb888ab3da5cc23317902caffbead05562b09561557>.
- Both receipts reported successful status `0x1`. This was an internal creation: top-level `contractAddress` was null, the transaction recipient was the manifest owner/controller `0xE7C7B7EE71db0f1B4F0Ff25D7cEc191268e7FD98`, and its sender was `0x087e5f859921f39ef3a5dbdca6b406ebd1b48166`.
- Both sources returned empty factory code (`0x`) at block `122266652`, and the pinned factory runtime hash at block `122266653`.
- Both returned the factory's `OwnershipTransferred` event in the creation block, from the zero address to the manifest owner/controller.

The reader retains the manifest's index start, verifies the empty pre-creation prefix, and applies the runtime code pin at and after the independently confirmed creation boundary. It does not silently skip that prefix or require contract code at blocks before the contract existed. The transaction sender is recorded as a transaction fact only; it is not added automatically to the official-token issuer allowlist.

## Official social identity

The official documentation community page directly links to `@GeniusTerminal`:

- <https://docs.tradegenius.com/contact-us/community>
- Machine-readable equivalent: <https://docs.tradegenius.com/contact-us/community.md>
- Official X: <https://x.com/GeniusTerminal>
- Numeric X account ID: `1236460732486692864`

The account's launch announcement names `@GeniusFDN` as the supporting foundation:

- <https://x.com/GeniusTerminal/status/2100548722556121312>
- Foundation X: <https://x.com/GeniusFDN>
- Numeric X account ID: `1882130308918804480`

Handle-to-numeric-ID observations came from the public FxTwitter profile and numeric-ID timeline endpoints. The official `publish.twitter.com/oembed` endpoint independently returned the expected author URL and announcement text for the launch post. FxTwitter is a discovery/profile mirror, not sufficient evidence alone to attribute arbitrary tokens to the project.

Other official posts verified through X oEmbed:

- Foundation's announced September 25 purchase program: <https://x.com/GeniusTerminal/status/2100558764843941971>.
- September 18 explanation of tokenized-equity redemption mechanics: <https://x.com/GeniusTerminal/status/2100804510381936714> and <https://x.com/GeniusTerminal/status/2100804523090731330>.
- GSTOCK mention with explicit non-affiliation: <https://x.com/GeniusTerminal/status/2100661401433886894>. This must NOT be upgraded to an official/test-token claim.

## Official test-token admission boundary

No official test-token contract address was confirmed in the inspected public integration documents, release manifest, or launch-period official posts. This is a bounded research result, not proof that no test tokens exist.

- A factory launch proves platform provenance, not official team ownership or endorsement: creation is permissionless.
- Sending creator/destination fees to the foundation does not prove official issuance; the creator chooses that destination.
- `Genius Cat`, `genius.cat`, and related handles appear as form placeholders in the site's translation payload. They are not a canonical test-token registry or an official CA binding.
- Community posts give conflicting GCAT addresses and label several unrelated assets as test tokens. None was admitted here as official. Historic Four.meme assets and the Genius X/Cardano project must not be conflated with the current Genius.fun release.
- Future official test/demo/faucet/contract announcements can be monitored as official-source information. Label a particular CA as an official test token only when the official source explicitly binds the exact chain and address to that purpose; otherwise retain the statement as unconfirmed source information.

## Coverage limits

Polling a numeric-ID timeline is not a guarantee of all replies, deleted posts, or full historical coverage. In the observed timeline, one reply in the redemption thread was absent from the first returned page but retrievable through its exact official post URL. Runtime health should distinguish an account check from verified cursor continuity.
