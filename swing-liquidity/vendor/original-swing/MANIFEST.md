# Swing liquidity-paper input pack (for cloud coding only)

Prepared 2026-11-16 23:57–23:59 Asia/Shanghai. Read-only from the user's Mac repo. No Mac files were modified, staged, or committed.

## Git remote (no credentials in URL)

- origin fetch/push: `https://github.com/yespsam/robinhood-chain-monitor.git`
- Remote HEAD: `origin/main`
- Mac checkout at inspection: `/Users/qohfq/Documents/Playground/robinhood-chain-monitor`
- Local branch: `codex/paper-focus-forward-simulation` @ `f2ecc063d0287ba3c0e44dbaf88a6278450bb376`
- That branch has no `origin/` counterpart. A related remote branch exists: `origin/codex/paper-focus-forward-simulation-upstream`.
- Shared worktree at inspection had many unrelated staged (~175) and unstaged (~69) tracked changes. Do not `git add -A`, and do not clean or commit those.

## Tracking fact (critical)

All swing sources below are **untracked** on the Mac (`git status` shows `??`). They are **not** in `HEAD`, **not** in `origin/main`, and **not** in any local or remote ref scanned with `git ls-tree`. They currently exist only as untracked files on the Mac disk (plus this box copy). Runtime data under `data/swing/` is gitignored by `.gitignore` line `data/` and was **not** copied here.

Do not assume `git clone` of origin will contain these files.

## Included files (copied verbatim)

| path | role |
|---|---|
| `src/swing-signal.js` | Pure signal / exit / cost / metrics. `live` hard-coded `false`. |
| `src/swing-paper.js` | Paper runtime (DexScreener + GeckoTerminal + GoPlus + curve venue). |
| `src/swing-flap.js` | Read-only Flap curve ingestion (`ethers` only). |
| `scripts/swing-paper.js` | Entry; loads only `SWING_*` lines from repo `.env` if present; **hardcodes** `dataDir` to `<root>/data/swing`. |
| `scripts/swing-backtest.js` | Read-only backtest on persisted 5m bars. |
| `test/swing-signal.test.js` | Node test runner tests. |
| `docs/swing-paper.md` | Current design doc (30% pullback entry, paper-only gates). |
| `package.fragment.json` | Minimal dependency metadata. |
| `launchagent/com.qohfq.swing-paper-liquidity.plist.template` | Isolated-agent template (placeholders). |

Excluded by design: `.env`, credentials, keys, `node_modules`, `data/swing/**` (ledger, state, OHLCV, logs), wallets, personal data.

## Source dependencies

- Node ESM (`"type": "module"`). Runtime observed: Node v25.8.0 at `/opt/homebrew/bin/node`.
- Direct npm: `ethers@^6.15.0` (used only by `src/swing-flap.js`).
- Repo also has `dotenv@^16.6.1` and unused-by-swing `@netlify/blobs`, `ws`. Swing entry does **not** import dotenv; it parses `SWING_*` keys itself.
- Node builtins: `node:fs`, `node:fs/promises`, `node:path`, `node:url`, `node:assert/strict`, `node:test`.
- Public HTTP: DexScreener, GeckoTerminal, GoPlus. Curve: read-only BSC RPC via `SWING_BSC_RPC` or public defaults in `swing-flap.js`. No wallet/signing imports.

## Approved change (user t189u: “可以 你去修改”)

Paper-only low-cap swing. Prefer thick pools, continuous trading, and low impact among low-cap names. **Stop using “fell 30% then buy” as the sole entry.** Keep `live` hard-coded false; `SWING_LIVE=true` must still refuse to start.

**Ledger isolation (mandatory):** Keep the running book at `data/swing/` untouched. New logic must use a **new `strategyId`** and a **new data directory**. Do not append to `data/swing/ledger.jsonl` / `state.json` / `status.json`. Do not mix old and new stats, gates, or win rates.

User still wants at least ~20% net space per trade conceptually; current TP=+20% on fill is ~+14.6% net after the existing cost model. Cloud work should not silently break the cost/gross-vs-net logging. Do not loosen live-trading safety gates. Do not deploy or restart anything in this pack; coding happens in the cloud only.

## LaunchAgent: current vs isolated deploy (do not deploy now)

Current agent `com.qohfq.swing-paper` (Mac `~/Library/LaunchAgents/com.qohfq.swing-paper.plist`):

- Program: `/opt/homebrew/bin/node --max-old-space-size=256 <repo>/scripts/swing-paper.js`
- WorkingDirectory: the shared repo root
- KeepAlive + RunAtLoad, logs: `<repo>/data/swing/run.log`
- No `EnvironmentVariables` in the plist
- Because `scripts/swing-paper.js` **hardcodes** `dataDir` to `<root>/data/swing`, merely adding `SWING_DATA_DIR` to the existing plist will **not** isolate the ledger until the entry honors that env (or a new entry is used)

Recommended later deploy options (after cloud coding, only with user approval; not now):

1. **Preferred:** Leave `com.qohfq.swing-paper` running the old strategy on `data/swing/` so open paper positions stay on the old book. Add a **new** label such as `com.qohfq.swing-paper-liquidity`, new isolated root or worktree, new data dir `data/swing-liquidity/`, new strategyId. See the template in `launchagent/`. The entry script must honor `SWING_DATA_DIR` / `SWING_STRATEGY_ID` (or a dedicated new entry) — this is a required code change, not just a plist edit.
2. Isolated git worktree of the cloud branch, same new plist + new data dir, still do not point the old agent at the new code.
3. Do **not** bootout/replace the existing agent or overwrite `data/swing/` in place.

Stop command for the *old* agent (for reference only, do not run now): `launchctl bootout gui/$(id -u)/com.qohfq.swing-paper`
