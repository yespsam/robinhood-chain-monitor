# Flap / multi-site Step Drainer campaign follow-up — 2026-11-01

Checked at `2026-11-01T01:46:36Z` (UTC). This is a report-based security update, not a live DNS or on-chain audit.

## New material finding

[The Block, citing Blockaid](https://www.theblock.co/news/defi/2026-10-31-hackers-hijack-a-dozen-defi-websites-all-registered-with-name-com-and-steal-about-138000-432251), reports that Blockaid identified Step Drainer on 12 DeFi front ends, including Flap, and that The Block traced about **$138,000 to three attacker wallets on EVM chains**. This is a campaign-wide figure, not a Flap-specific loss estimate; the report explicitly excludes any possible losses on Solana or Aptos. The article says no affected project had published a victim count. Its later update quotes Name.com as saying 15 customer domains were affected; this differs in scope from Blockaid's 12 identified front ends. Name.com reportedly acknowledged improper redirects but did not state the root cause. The common registrar association does not prove Name.com itself was breached.

The reported risk was a malicious front end prompting wallet users to approve or sign a transfer. The information reviewed does not establish that Flap's smart contracts, Binance Agentic Wallet, or this repository's CA trade routes were compromised. The previous restoration status is still based on secondary reporting: `flap.sh` reportedly restored and `flap.cool` retained as backup. The primary X announcement could not be fetched (403); this monitor did not visit either domain, test DNS, or perform an independent safety check.

The user previously stated they did not connect a wallet. If that remains accurate, the reported connect-and-authorize attack path was not activated for them; merely viewing a page is not evidence of an on-chain authorization or loss. This is limited to the reported attack mechanism and is not a guarantee about device/browser security.

## Local compatibility and change boundary

Six monitored public GitHub `main` refs were checked with `git ls-remote`; all match the saved SHAs. There is no upstream repository code delta associated with this incident update. It is a domain/front-end security incident, not a confirmed local trading-code regression. No source code, transaction construction, slippage, approvals, wallet setup, strategy, or deployment was changed. No secrets were read; no wallet was connected; nothing was signed, broadcast, or traded.

## Sources and limits

- [The Block — campaign, EVM funds traced, scope and victim-count caveats](https://www.theblock.co/news/defi/2026-10-31-hackers-hijack-a-dozen-defi-websites-all-registered-with-name-com-and-steal-about-138000-432251)
- [Coindaro — follow-up on Name.com statement, count differences, and unresolved root cause](https://www.coindaro.com/defi-dns-hijack-name-com-step-drainer/)
- [SignalPlus/Odaily — Flap restoration report](https://t.signalplus.com/crypto-news/detail/flap-website-restored-backup-domain-remains-open?lang=en-US)

No primary Flap X content was independently retrieved in this check. No victim count, Flap-specific loss amount, root cause, or contract compromise is established by the sources above.

## Incremental check — 2026-11-01 05:49Z

No new verified incident event, restoration regression, root-cause/victim-count disclosure, or monitored GitHub main-ref change was found since 01:46Z. A secondary [Bloomingbit report](https://en.bloomingbit.io/feed/news/123344) attributes to Flap's founder that users connected to the genuine site before the hijack were not affected, while users who visited the tampered page and connected or approved permissions during its exposure window faced risk. The primary post remains unavailable here; preserve this as attributed secondary reporting. The user previously stated no wallet was connected, which is inconsistent with that reported trigger condition. No domain/DNS check or wallet interaction occurred.

## Incremental check — 2026-11-01 09:55Z

[Bitquery's on-chain investigation](https://bitquery.io/investigations/name-com-dns-hijack) estimates **$202,386 taken from 32 wallets across six EVM chains**, valuing each victim outflow at the time of the drain. This is a different metric from The Block's earlier ~$138,000, which was a later snapshot of funds held in three attacker wallets. Bitquery attributes much of the difference to stolen Kintsu stake that remained in an unstaking queue, plus price/receipt-token valuation differences. Bitquery explicitly says the total is not complete: Solana and Aptos losses and some unlinked collectors are excluded. It also says an on-chain drain cannot identify the precise site used; site attribution is matched by chain/token. Therefore neither $138,000 nor $202,386 should be described as Flap-specific loss.

Separately, secondary [Coinspect coverage relayed by Tozvan](https://tozvan.com/wallet-security/dapp-frontend-hijacking-domain-recovery) says that as of its Oct. 31 18:24 UTC post all 15 affected domains had been recovered, but 13 old Name.com DNS zones still pointed to `31.56.52.52`, 13 certificates remained valid until Jan. 29, 2027, and one server remained online at that observation. The [Coinspect X post](https://x.com/im23pds/status/2116688775791485100) could not be fetched (403). Secondary [Crypto Briefing reporting](https://cryptobriefing.com/name-com-restores-hijacked-defi-domains/) also says Name.com restored all 15 customer domains. These reports do **not** establish that the old Name.com zones remain authoritative or that `flap.sh` currently resolves to the reported address; this monitor did not query DNS or visit either Flap domain. Treat the residual-infrastructure claim as a reason to await primary clarification, not as a verified current compromise.

The six monitored GitHub `main` refs remain at their saved SHAs. No new upstream code delta, Flap contract compromise, or local CA trade-route regression was identified. The user previously said no wallet was connected; if accurate, that remains outside the reported connect-and-sign attack path. No secrets were read, no domain/DNS probe or wallet interaction occurred, and nothing was signed, broadcast, or traded.

## Incremental check — 2026-11-01 13:54Z

No material change since 09:55Z was found. Current search results continue to repeat Flap's Oct. 31 recovery announcement (`flap.sh` reportedly normal; `flap.cool` retained as backup) and the earlier, time-bounded Coinspect observation relayed by Tozvan about residual Name.com DNS zones/certificates. No newer primary root-cause, affected-user, loss-total, or remediation disclosure was found; direct X content remains inaccessible in this check. All six monitored GitHub `main` refs still match their saved SHAs. No visit to either domain, DNS probe, wallet interaction, signature, broadcast, trade, code change, or deployment occurred. This is a source-search/repository-ref check only, not a live safety audit or proof that the historic DNS zones remain authoritative.
