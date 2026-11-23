Source-provenance correction, 2026-11-10

No runtime restart, provider call, trade, ledger change, or threshold change.

Before the source fix, both new offline regressions failed: a ticker-only source was labeled `direct_ca`, and it incorrectly passed `eventProof` as an `event_narrative` catalyst. The tests now verify that exact-CA sources still work and the existing ticker-plus-control route stays admitted as `narrative_control`.

Verification command:

```sh
node --test test/paper-narrative-thesis.test.js test/paper-loss-repair.test.js test/paper-narrative-understanding.test.js test/paper-narrative-search-rules.test.js test/paper-chase-gate.test.js test/paper-strategy-evidence.test.js test/paper-evidence-review.test.js
```

Result: 59 tests passed, 0 failed.

Detailed captured output:

```text
✔ control score is unknown without concentration data, ok inside the control band with consistent net buying (4.130792ms)
✔ no-narrative / exploratory evidence is shadow-only with zero main friction budget (0.36075ms)
✔ narrative + control can chase a breakout with a higher (chain-adjusted) friction budget (0.243625ms)
✔ narrative without control cannot chase a breakout (0.572791ms)
✔ main ledger: exploratory row without narrative cannot fill; narrative+control fills and records the gate (21.88475ms)
✔ new per-CA complete window proof isolates global warnings without relaxing old records or missing profiles (2.20925ms)
✔ frozen community link is not direct endorsement; tags are not verified profit (0.185667ms)
✔ post-entry source, wrong CA, missing source and future observation do not backfill entry knowledge (0.167208ms)
✔ partial, stale, future, null and inconsistent wallet counts remain unknown rather than zero (0.160208ms)
✔ only completed rounds are described, costs counted once; unknown costs remain null and inputs unchanged (4.498083ms)
✔ different policy, cost and provider cohorts do not mix (0.49475ms)
✔ ticker research cannot borrow the exact-CA event catalyst, while narrative plus control stays admitted (18.649417ms)
✔ repair diagnostics distinguish missing catalyst and structure from unavailable actual fees (11.98625ms)
✔ expired or denied original is reported accurately without renewing its clock or permitting entry (2.486583ms)
✔ main quarantine rejects old receipt-cost rows and forged ready flags at the ledger, controls stay unchanged (16.401875ms)
✔ frozen entry low avoids selling merely because the same pre-entry weak EMA persists; a new break still exits (9.214708ms)
✔ new timestamps/same cohort cannot re-buy a loser; two distinct new post-exit buyers can form research proof (17.802458ms)
✔ same tweet under a new host, tracking parameters or timestamp does not authorize loss reentry (1.516666ms)
✔ research groups never call name-only matches narrative or unprofiled labels verified profit (2.257292ms)
✔ anomaly IDs are stable, immediate, local and non-mutating without waiting for the next 100 fills (1.757584ms)
✔ repair mode still sells a legacy lot on real fresh evidence without changing its buy or exit policy (8.339333ms)
✔ runtime keeps discovery and old exits alive while restart and manual enable cannot reopen unsupported orders (84.803625ms)
✔ no key: multi-author CA corroboration upgrades chatter to narrative (search_rules, not llm) (11.36725ms)
✔ copy-paste shill from many accounts is not corroboration (1.365875ms)
✔ any scam/denial post in corpus vetoes (0.218958ms)
✔ single anonymous author without event stays non-narrative (0.151125ms)
✔ event frames distinguish attention, promised delivery and value claims without predictions (6.442125ms)
✔ Agentic Wallet, Agent ID and AI Pro claims stay separate; only official identity plus a successful exact-CA buy qualifies (3.083125ms)
✔ narrative admission is a fresh source-to-CA-to-demand chain, not a keyword score (0.88025ms)
✔ explicit CA, community permalink and name-only hypotheses remain distinct, across chains too (15.475708ms)
✔ parsed social ticker matches preserve their provenance instead of claiming an explicit CA (9.665375ms)
✔ unverified, future, conflicted and too-old sources cannot become current research facts (1.265459ms)
✔ copied posts are not independent propagation or a new substantive catalyst (0.979334ms)
✔ a fresh feed is not buying: net amounts, tags, event timing and coverage are checked (2.230875ms)
✔ subsequent bound original can reactivate an old story without renewing old clocks or promoting copies/names (3.295334ms)
✔ negative post blocks only linked/direct new entries, never manufactures a sell or approval (0.759917ms)
✔ learning profiles freeze discovery time; future results, wrong CA and late text do not become entry evidence (1.13825ms)
✔ verified public linked text is reusable but retains uncertain CA association (0.781708ms)
✔ unclassified stories are not treated as a shared narrative unless the original post matches (2.572958ms)
✔ production evaluator freezes research in new paper buys and rechecks a contradictory thesis at commit (26.955333ms)
✔ Chinese research views escape source text, label late associations and make no trade request (1.800416ms)
✔ CA-bound Fomo narrative still qualifies (9.489375ms)
✔ social post containing exact CA is matched by CA (3.29375ms)
✔ reputable author naming the ticker becomes eligible narrative and reaches main-book tier (2.018208ms)
✔ ticker spam from non-reputable author or wrong chain never establishes narrative (0.494958ms)
✔ scam, denial and short slogans are rejected (2.959166ms)
✔ duplicate scraped bodies collapse; stale social narrative expires (0.459ms)
✔ no narrative stays shadow-only (0.203791ms)
✔ LLM verdict is cached and can veto; missing key reports unavailable (21.74575ms)
✔ per-scan index preserves all provider counts, freshness, conflicts and narrative gates (12.587917ms)
✔ fast evidence cache reuses unchanged files and invalidates replaced, corrupt or deleted files (51.3605ms)
✔ Flap healthy RPC progress does not imply the pool scan has caught up (12.774416ms)
✔ observed net flow subtracts sells and deduplicates identical feed records (0.966875ms)
✔ missing profit profiles do not erase a complete platform-tagged cohort or its sells (0.242917ms)
✔ ambiguous legs, quarantine, stale and future chain snapshots cannot qualify (0.74175ms)
✔ fresh feed timestamps cannot refresh the event-time entry pulse or duplicate buyers (0.6535ms)
✔ partial feed exposes observed counts but never claims complete coverage (0.288542ms)
✔ foreign chain, invalid timestamps and blocked wallets never add conviction (0.163042ms)
✔ Solana addresses stay case-sensitive and ticker text never becomes a narrative (2.959666ms)
ℹ tests 59
ℹ suites 0
ℹ pass 59
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 892.490917
```
