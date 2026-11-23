# Flap domain security incident — 2026-10-31

Checked at `2026-10-31T06:29:21Z` (UTC) after the user reported the domain change. This is an incident note, not confirmation that `flap.cool` is safe.

## What is corroborated, and what is not

- Multiple reports on 2026-10-31 attribute a warning to Flap that `flap.sh` was affected by DNS hijacking and redirected visitors to an unauthorized site. TokenPost reports the founder said the team was working with Blockaid, Vercel and Name.com. SignalPlus, citing Odaily, reports Flap moved to `flap.cool` and told users to avoid `flap.sh`.
- A public mirror of the `@flapdotsh` timeline shows a warning not to visit `flap.sh`, connect a wallet, or sign. Direct access to `x.com/flapdotsh` returned 403 in this check, so the statement could not be validated on the primary X page.
- Flap's official Telegram and official-links documentation still list `flap.sh`; neither accessible source confirmed `flap.cool`. A read-only web fetch of `flap.sh` rendered the board, but that conflicts with the warning and is not evidence that the domain or page is safe.
- Therefore: treat `flap.sh` as compromised/untrusted and treat `flap.cool` as unverified/untrusted until an accessible primary Flap channel explicitly confirms both the replacement domain and safe status. Do not connect or sign on either domain based only on secondary reporting or a social-media mirror.

## Scope and local compatibility impact

This is a reported domain/frontend incident. It does not by itself prove compromise of Flap smart contracts, Agentic Wallet, or on-chain assets. The local wallet/CA code was not changed and no live trade route was exercised. No wallet was connected; no secrets were read; no signature, broadcast or trade was performed. This monitor did not visit `flap.cool` or independently resolve its DNS.

If a user interacted with a suspicious page, distinguish among viewing it, connecting a wallet, signing an approval/transaction, and disclosing a seed/private key. Viewing alone is not proof of compromise. Any approval or signature should be reviewed using a trusted wallet/explorer route, not links from the suspicious site. A disclosed seed/private key should be treated as compromised.

## Sources and coverage caveat

- [TokenPost report](https://www.tokenpost.com/news/technology/45331) (secondary report quoting the founder)
- [SignalPlus/Odaily report on flap.cool](https://t.signalplus.com/crypto-news/detail/flap-new-domain-flap-cool-avoid-flap-sh?lang=en-US) (secondary report; does not replace primary verification)
- [Public mirror of @flapdotsh posts](https://teapawt.net/flapdotsh) (third-party mirror; not primary evidence)
- [Flap official Telegram](https://t.me/FlapOfficial) (currently lists flap.sh; no flap.cool confirmation observed)
- [Flap official links page](https://docs.flap.sh/flap/flap-official-links) (currently lists flap.sh; page metadata says updated two months ago)
- Direct primary X page `https://x.com/flapdotsh` was inaccessible via this check (403). `flap.cool` was not visited or independently verified.

## Follow-up — 2026-10-31 06:41Z

The user reports that `flap.cool` is currently safe. Fresh coverage now also identifies a Flap announcement changing the official website to `flap.cool` and warning users away from `flap.sh`: [CoinNess](https://coinness.com/news/1173840) quotes the change, and [Lookonchain](https://www.lookonchain.com/feeds/79722) exposes a source link to the [Flap X post](https://x.com/flapdotsh/status/2116400008127996252). The X post itself still returns 403 through this check, so the primary text and live frontend safety could not be independently inspected. This corrects the earlier blanket wording: `flap.cool` is now classified as the reported official replacement domain, not as “also known compromised”; however, this monitor cannot independently certify the current site is safe. `flap.sh` remains the domain explicitly warned against. No visit to `flap.cool`, DNS probe, wallet connection, signing or transaction was performed.

## Follow-up — 2026-10-31 08:54Z

The user reports that `flap.sh` is repaired. Fresh [SignalPlus/Odaily](https://t.signalplus.com/crypto-news/detail/flap-website-restored-backup-domain-remains-open?lang=en-US) and [TechFlow](https://www.techflowpost.com/newsletter/142225) coverage says Flap announced on X that `flap.sh` has resumed normal access and `flap.cool` remains open as a backup; both domains are reportedly usable. This changes the incident classification from “active warning” to “restoration reported.” The primary X post remains unavailable to this check and neither domain/DNS was tested, so this is not an independent security audit. No wallet connection, signature or transaction was performed.

