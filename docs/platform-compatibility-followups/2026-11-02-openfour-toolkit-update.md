# OpenFour developer toolkit update and local compatibility check

- Checked: 2026-11-02T09:57:40.915Z
- Compared with saved checkpoint: 2026-11-02T05:57:10Z
- Scope: public upstream commit diff, local OpenFour observer/CA eligibility comparison, focused offline tests. No wallet or live-chain operation.

## Upstream change

`four-meme-community/openfour-docs` moved from `6e1b1c3a3c77be383784e23f5f01198d34690f1e` to `6f7efd5d3f14ed280cf471f70675ffba6d319943` (2026-11-02). The intervening commits add a community developer toolkit/workbench and sample FairLaunch workflow, publish/update OpenFour interfaces and ABIs, and move the executable developer skill to `developer/skills/openfour-developer/`. The final commit removes a duplicate `.cursor/skills` copy. The compare contains 157 changed paths; importantly, `docs/integration-guide.md` is byte-identical to the prior checkpoint, and the `TokenCreated` event's ABI type signature is unchanged.

New or expanded examples/interfaces describe custom module development, Token/TaxToken/StrategyTaxToken/UniToken concepts, V4 hooks, `ZapRouter`, strategy-tax/stock-token surfaces, and buy/sell/migration lifecycle details. This is an upstream development/reference surface, not proof that every preset or token is tradeable. Its README explicitly labels samples unaudited/demo-only; `AGENTS.md` says writes must target a developer-owned fork and stop chain writes on BSC 56 or testnet 4663. It does not authorize arbitrary production contract calls or a universal mint/swap path.

The repo remains classified as community/reference rather than independently verified official policy. Four.Meme's official [classic integration page](https://four-meme.gitbook.io/four.meme/developer/fourmeme-integration) links `four-meme-community/fourmeme-docs` and says classic TokenManager docs are separate from OpenFour; no direct official-page backlink to `openfour-docs` was found during this check. The GitHub repo self-describes OpenFour as a Four.Meme-introduced launch engine, which is not by itself sufficient to upgrade repository ownership/trust classification.

Primary references:

- [OpenFour compare from saved SHA](https://github.com/four-meme-community/openfour-docs/compare/6e1b1c3a3c77be383784e23f5f01198d34690f1e...6f7efd5d3f14ed280cf471f70675ffba6d319943)
- [Developer toolkit commit](https://github.com/four-meme-community/openfour-docs/commit/1eafa2eaa19396fcc46a8e34942c9f4603d2bc64)
- [OpenFour repository README](https://github.com/four-meme-community/openfour-docs/blob/6f7efd5d3f14ed280cf471f70675ffba6d319943/README.md)
- [Updated developer guide](https://github.com/four-meme-community/openfour-docs/blob/6f7efd5d3f14ed280cf471f70675ffba6d319943/docs/developer-guide.md)
- [Four.Meme classic integration page](https://four-meme.gitbook.io/four.meme/developer/fourmeme-integration)

## Local compatibility comparison

The checked-out source has a fixed BSC 56 observer in `src/four-registry-monitor.js`: pinned Registry/Core addresses, strict cross-binding, Registry capability topics (`ModuleUpserted`, `TokenImplUpserted`, `TagRegistered`, preset lifecycle), and the OpenFour Core `TokenCreated` event. `src/bsc-launchpad-monitor.js` correlates the creation's preset and quote-asset with known activation evidence. These existing hooks can observe a new preset/module/token implementation as an update and preserve the first-token proof; the new developer tooling does not change the local event selector.

The local observer does not interpret arbitrary new module implementations, run the OpenFour `estimateBuy`/`estimateSell`/`ZapRouter` paths, or track `PhaseTransition`/`TokenPaused`/`TradeExecuted`/`MigrateExecuted` as per-token buy/sell readiness. No Agentic Wallet execution path is present in this checkout's OpenFour observer. Accordingly, this check establishes only discovery/metadata coverage; it does not establish that any newly created/custom CA can be bought or sold. A future trading integration must resolve each token's current phase and migration/pause state, quote/token route and fees/taxes, and independently simulate both directions before exposing trade actions; unknown modules or stale evidence should remain blocked.

## Validation

- `node --test test/four-registry-monitor.test.js test/four-registry-pipeline.test.js` — 97 passed, 0 failed (offline fixtures/mocks).
- The tests cover canonical Registry/Core identity, preset/module/token-implementation/tag changes, and first-token lifecycle. They do not cover custom token execution, quote simulation, tax behavior, migration/pause events, or a signed transaction.
- No RPC, wallet CLI/preflight, secrets, authentication, preview, signature, broadcast, buy, sell, code change, or deployment was performed.

## Conclusion / next check

This is a material OpenFour developer-tooling expansion but no confirmed regression to the current local launch observer. The actionable limitation remains that the observer is not a buy/sell compatibility verifier. Keep the repository marked community/reference pending a direct official backlink; next check compare OpenFour interface/ABI changes and whether Binance/Flap or Four.Meme docs add a direct official link or trade-readiness guidance. Do not automatically add new token types, loosen quote-asset gates, or call the sample contracts.
