import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPaper100Runner, paperEventDigest, validatePaperReviews } from "../src/paper-100-runner.js";
import { parsePaper100Arguments } from "../scripts/paper-100.js";
import { GMGN_FLOW_CHAINS, evaluateGmgnFlowSignal, isGmgnFlowEvent } from "../src/gmgn-flow-signal.js";
import { NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID as PROVIDER } from "../src/narrative-bsc-v2-quote-provider.js";

const NOW = Date.parse("2026-09-20T01:00:10.000Z"), MINUTE = 60_000;
const iso = value => new Date(value).toISOString();
const addr = number => `0x${number.toString(16).padStart(40, "0")}`;
const hash = number => `0x${number.toString(16).padStart(64, "0")}`;
const CA = addr(900), POOL = addr(901);

function event(at = NOW, chain = "bsc") {
  const end = Math.floor(at / MINUTE) * MINUTE, profiles = {};
  const trades = Array.from({ length: 6 }, (_, i) => ({ chain, tokenAddress: CA, wallet: addr(i + 1),
    hash: hash(i + 1), side: "buy", amountUsd: 3000, at: end - MINUTE, tags: i >= 3 ? ["fomo"] : [] }));
  for (const trade of trades.slice(0, 5)) profiles[trade.wallet] = Object.fromEntries(["7d", "30d"].map(period => [period, {
    chain, wallet: trade.wallet, period, checkedAt: iso(at), realizedProfitUsd: 15000, realizedRoi: 0.5,
    winRate: 0.7, tokenCount: 150, buyCount: 200, sellCount: 200, tags: [],
    createdAt: Math.floor(at / 1000) - 90 * 86400, lastTradeAt: Math.floor(at / 1000) - 60, createdTokenCount: 0,
  }]));
  const candles = Array.from({ length: 20 }, (_, i) => ({ time: end - (20 - i) * MINUTE, volumeUsd: i < 15 ? 1000 : 10000 }));
  const evidence = { version: 1, provider: "gmgn-cli", chain, tokenAddress: CA, candles, trades, profiles };
  const result = evaluateGmgnFlowSignal({ ...evidence, nowMs: at });
  const value = { type: "gmgn_flow_surge", platform: "gmgn", chain: GMGN_FLOW_CHAINS[chain],
    token: { address: CA, symbol: "FIXTURE" }, observedAt: iso(at), sourceOccurredAt: result.signal.windowEndAt,
    eventKey: `gmgn-flow:${chain}:${CA}:${end}`, ...result, evidence,
    source: { id: "gmgn_flow_observed", trust: "provider_reported", url: `https://gmgn.ai/${chain}/token/${CA}` },
    narrative: { status: "sourced", text: "Fixture narrative bound to the exact token.",
      sourceUrl: "https://x.com/fixture/status/12345", sourceAt: iso(at), chain, tokenAddress: CA } };
  assert.equal(isGmgnFlowEvent(value, { nowMs: at }), true); return value;
}

function review(value, at = NOW) {
  return { version: 1, mode: "independent_paper_review", reviewer: "Offline fixture reviewer", reviewedAt: iso(at),
    reviews: [{ eventKey: value.eventKey, eventDigest: paperEventDigest(value), chainId: 56, ca: CA, poolAddress: POOL,
      evidence: { observedAt: iso(at), sourceUrls: ["https://example.com/fixture-review"], sellSimulationPassed: true,
        contractControlsReviewed: true, lpLockOrBurnVerified: true, holderDistributionReviewed: true,
        independentWalletClusterVerified: true, buyTaxBps: 0, sellTaxBps: 0, liquidityUsd: 50_000 } }] };
}

async function fixture(t, options = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "paper-runner-test-"));
  const root = await fs.realpath(temporary), sourceDir = path.join(root, "sources"), reviewDir = path.join(root, "reviews");
  const dataDir = path.join(root, "paper"), source = path.join(sourceDir, "alert-outbox.json"), reviewFile = path.join(reviewDir, "review.json");
  await fs.mkdir(sourceDir); await fs.mkdir(reviewDir);
  const value = options.event || event();
  await fs.writeFile(source, JSON.stringify({ events: { fixture: { id: "fixture", event: value, status: "delivered" } } }));
  await fs.writeFile(reviewFile, JSON.stringify(options.review || review(value)));
  const calls = [], runners = []; let at = NOW, factories = 0;
  const provider = Object.freeze({ providerId: PROVIDER, trusted: true, readOnly: true,
    getEntryQuote: async request => {
      calls.push({ method: "entry", request });
      const q = { status: "ok", providerId: PROVIDER, kind: "entry", side: "buy", marketExecutable: true,
        chainId: request.chainId, ca: request.ca, poolAddress: request.poolAddress,
        blockNumber: Math.floor(at / 1000), blockHash: hash(100), blockTimestamp: iso(at), observedAt: iso(at), validUntil: iso(at + 5000),
        valueUsdMicros: request.valueUsdMicros, quantityRaw: "1000000000000000000", priceUsdMicros: "10000000", estimatedSlippageBps: 100, routeDigest: "a".repeat(64) };
      return options.entry ? options.entry(request, q) : q;
    },
    getPositionMark: async request => {
      calls.push({ method: "mark", request });
      const q = { status: "ok", providerId: PROVIDER, kind: "mark", side: "sell", marketExecutable: true,
        chainId: request.chainId, ca: request.ca, poolAddress: request.poolAddress,
        blockNumber: Math.floor(at / 1000), blockHash: hash(100), blockTimestamp: iso(at), observedAt: iso(at), validUntil: iso(at + 5000),
        valueUsdMicros: "11000000", quantityRaw: request.quantityRaw, priceUsdMicros: "11000000", estimatedSlippageBps: 100, routeDigest: "b".repeat(64) };
      return options.mark ? options.mark(request, q) : q;
    },
    checkCanonicalBlock: async request => {
      calls.push({ method: "canonical", request });
      const result = { status: "ok", providerId: PROVIDER, chainId: 56,
        blockNumber: request.blockNumber, blockHash: request.expectedBlockHash, observedAt: iso(at) };
      return options.canonical ? options.canonical(request, result) : result;
    },
  });
  const create = (config = {}, dependencies = {}) => {
    const runner = createPaper100Runner({ dataDir, productionDataDir: sourceDir, sourceFiles: [source], ...config },
      { now: () => at, quoteProviderFactory: () => { factories++; return provider; }, ...dependencies });
    runners.push(runner); return runner;
  };
  t.after(async () => { for (const runner of runners) await runner.stop().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { root, dataDir, sourceDir, source, reviewFile, value, create, calls, factoryCount: () => factories,
    now: () => at, advance: ms => { at += ms; }, provider };
}

test("paper CLI defaults to offline once and rejects execution or sub-minute watch flags", () => {
  const options = parsePaper100Arguments([], { PRIVATE_KEY: "never-read", TELEGRAM_TOKEN: "never-read" });
  assert.equal(options.action, "once"); assert.equal(options.liveQuotes, false); assert.deepEqual(options.rpcUrls, []);
  for (const args of [["--execute"], ["--watch", "--interval-seconds", "59"], ["--status", "--once"], ["--status", "--live-quotes"]]) {
    assert.throws(() => parsePaper100Arguments(args, {}));
  }
  assert.equal(parsePaper100Arguments(["--watch", "--interval-seconds", "60"], {}).intervalMs, 60_000);
});

test("paper --status is read-only and does not create a directory or provider", async (t) => {
  const f = await fixture(t), runner = f.create();
  const report = await runner.status();
  assert.equal(report.status, "not_initialized"); assert.equal(report.account, null);
  await assert.rejects(fs.stat(f.dataDir), { code: "ENOENT" });
  assert.equal(f.factoryCount(), 0);
});

test("paper default observation preserves production sources and never invents review evidence", async (t) => {
  const f = await fixture(t), before = await fs.readFile(f.source, "utf8"), runner = f.create();
  const report = await runner.runOnce();
  assert.equal(report.mode, "observation_only"); assert.equal(report.account.cashUsd, 100);
  assert.equal(report.account.openPositions, 0); assert.equal(f.factoryCount(), 0);
  assert.ok(report.decisions[0].reasons.includes("independent_paper_review_missing"));
  assert.ok(report.decisions[0].reasons.includes("live_quotes_disabled"));
  assert.equal(report.decisions[0].eventDigest, paperEventDigest(f.value));
  assert.equal(await fs.readFile(f.source, "utf8"), before);
  assert.equal((await fs.stat(runner.stateFile)).mode & 0o777, 0o600);
});

test("paper live-quote opt-in without a bound independent review still makes zero network calls", async (t) => {
  const f = await fixture(t), runner = f.create({ liveQuotes: true });
  const report = await runner.runOnce();
  assert.equal(report.account.openPositions, 0); assert.equal(f.factoryCount(), 0);
});

test("paper valid reviewed event gets a canonical read-only quote and reserves only ten dollars plus gas", async (t) => {
  const f = await fixture(t), runner = f.create({ liveQuotes: true, reviewFile: f.reviewFile });
  const report = await runner.runOnce();
  assert.equal(report.account.openPositions, 1, JSON.stringify(report.decisions));
  assert.equal(report.account.cashUsd, 89.8);
  assert.equal(report.account.estimatedLiquidationEquityUsd, null, "unmarked position is not claimed as priced profit");
  assert.deepEqual(f.calls.map(call => call.method), ["entry", "canonical"]);
  assert.equal(f.calls[0].request.valueUsdMicros, "10000000");
  assert.equal(f.calls[0].request.executable, false);
  assert.match(report.decisions[0].reviewProvenance.meaning, /not_independently_verified/);
});

test("paper canonical split or quote expiry during verification cannot open a position", async (t) => {
  for (const expired of [false, true]) {
    let f;
    f = await fixture(t, { canonical: (_request, response) => {
      if (expired) { f.advance(6000); return { ...response, observedAt: iso(f.now()) }; }
      return { ...response, blockHash: hash(999) };
    } });
    const report = await f.create({ liveQuotes: true, reviewFile: f.reviewFile }).runOnce();
    assert.equal(report.account.openPositions, 0); assert.equal(report.account.cashUsd, 100);
  }
});

test("paper restart marks haircut-adjusted quantity and never buys a duplicate event", async (t) => {
  const f = await fixture(t), first = f.create({ liveQuotes: true, reviewFile: f.reviewFile });
  await first.runOnce(); await first.stop(); f.advance(1000);
  const restarted = f.create({ liveQuotes: true, reviewFile: f.reviewFile });
  const report = await restarted.runOnce();
  assert.equal(report.account.openPositions, 1);
  assert.equal(f.calls.filter(call => call.method === "entry").length, 1);
  assert.equal(f.calls.find(call => call.method === "mark").request.quantityRaw, "990000000000000000");
  assert.equal(report.account.unpricedPositions, 0);
  assert.ok(report.account.estimatedLiquidationEquityUsd < 101);
  assert.deepEqual(f.calls.slice(2).map(call => call.method), ["canonical", "mark", "canonical"]);
  assert.equal(f.calls[2].request.blockNumber, f.calls[1].request.blockNumber);
  assert.equal(f.calls[2].request.expectedBlockHash, f.calls[1].request.expectedBlockHash);
});

test("paper reorged or unknown entry anchor remains unpriced and cannot fabricate an exit", async (t) => {
  for (const unavailable of [false, true]) {
    let invalidateAnchor = false;
    const f = await fixture(t, {
      canonical: (_request, response) => !invalidateAnchor ? response : unavailable
        ? { ...response, status: "unavailable" } : { ...response, blockHash: hash(999) },
      mark: (_request, quote) => ({ ...quote, valueUsdMicros: "20000000" }),
    });
    const first = f.create({ liveQuotes: true, reviewFile: f.reviewFile });
    await first.runOnce(); await first.stop(); f.advance(1000); invalidateAnchor = true;
    const report = await f.create({ liveQuotes: true, reviewFile: f.reviewFile }).runOnce();
    assert.equal(report.account.openPositions, 1);
    assert.equal(report.account.closedPositions, 0);
    assert.equal(report.account.unpricedPositions, 1);
    assert.equal(report.account.estimatedLiquidationEquityUsd, null);
    assert.equal(report.account.cashUsd, 89.8);
    assert.equal(f.calls.filter(call => call.method === "mark").length, 0);
    assert.deepEqual(f.calls.map(call => call.method), ["entry", "canonical", "canonical"]);
  }
});

test("paper offline run with an existing position marks it unpriced and makes no quote calls", async (t) => {
  const f = await fixture(t), first = f.create({ liveQuotes: true, reviewFile: f.reviewFile });
  await first.runOnce(); await first.stop(); f.advance(1000);
  const calls = f.calls.length, report = await f.create().runOnce();
  assert.equal(f.calls.length, calls); assert.equal(report.account.openPositions, 1);
  assert.equal(report.account.estimatedLiquidationEquityUsd, null);
});

test("paper exact event digest and CA review binding cannot be replaced by a nearby review", async (t) => {
  for (const field of ["eventDigest", "ca", "chainId"]) {
    const value = event(), reviewed = review(value);
    reviewed.reviews[0][field] = field === "eventDigest" ? "f".repeat(64) : field === "ca" ? addr(88) : 1;
    const f = await fixture(t, { review: reviewed }), runner = f.create({ liveQuotes: true, reviewFile: f.reviewFile });
    assert.equal((await runner.runOnce()).account.openPositions, 0);
    assert.equal(f.factoryCount(), 0);
  }
});

test("paper rejects corrupted GMGN numerical evidence instead of trusting its headline counts", async (t) => {
  const value = event(); value.signal.highProfitCount++;
  const f = await fixture(t, { event: value }), runner = f.create({ liveQuotes: true, reviewFile: f.reviewFile });
  const report = await runner.runOnce();
  assert.equal(report.account.openPositions, 0); assert.equal(report.decisions.length, 0);
  assert.ok(report.sourceIssues.some(issue => issue.reason === "gmgn_event_invalid_or_stale"));
  assert.equal(f.factoryCount(), 0);
});

test("paper does not promote a valid non-BSC GMGN signal into unsupported quoting", async (t) => {
  const f = await fixture(t, { event: event(NOW, "base") }), runner = f.create({ liveQuotes: true });
  const report = await runner.runOnce();
  assert.ok(report.decisions[0].reasons.includes("unsupported_chain")); assert.equal(f.factoryCount(), 0);
});

test("paper single writer and orphan lock are fail-closed and never auto-deleted", async (t) => {
  const f = await fixture(t), first = f.create(), second = f.create();
  await first.runOnce(); await assert.rejects(second.runOnce(), /paper_writer_lock_exists/);
  await first.stop(); await second.stop();
  const lock = path.join(f.dataDir, ".paper-100.lock"); await fs.writeFile(lock, JSON.stringify({ pid: 999999, token: "orphan" }));
  const orphan = f.create(); await assert.rejects(orphan.runOnce(), /paper_writer_lock_exists/);
  assert.match(await fs.readFile(lock, "utf8"), /orphan/);
});

test("paper refuses production overlap and symlinked input or output paths", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.create({ dataDir: path.join(f.sourceDir, "paper") }).runOnce(), /overlaps/);
  await fs.symlink(f.sourceDir, path.join(f.root, "linked-source"));
  await assert.rejects(f.create({ sourceFiles: [path.join(f.root, "linked-source", "alert-outbox.json")] }).runOnce(), /symlink/);
  await fs.symlink(f.sourceDir, path.join(f.root, "linked-output"));
  await assert.rejects(f.create({ dataDir: path.join(f.root, "linked-output", "paper") }).runOnce(), /symlink/);
});

test("paper corrupted checkpoint cannot silently refill cash or create a quote provider", async (t) => {
  const f = await fixture(t), first = f.create(); await first.runOnce(); await first.stop();
  const value = JSON.parse(await fs.readFile(first.stateFile, "utf8")); value.account.cashUsdMicros = 999_000_000;
  await fs.writeFile(first.stateFile, JSON.stringify(value));
  await assert.rejects(f.create({ liveQuotes: true, reviewFile: f.reviewFile }).runOnce(), /cash conservation/);
  assert.equal(f.factoryCount(), 0);
});

test("paper stopped inflight quote does not open a position and releases only its own lock", async (t) => {
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { entry: async () => { entered(); return new Promise(() => {}); } });
  const runner = f.create({ liveQuotes: true, reviewFile: f.reviewFile });
  const flight = runner.runOnce(); assert.equal(runner.runOnce(), flight);
  const rejection = assert.rejects(flight, /paper_runner_stopped/);
  await started; await runner.stop(); await rejection; await runner.stop();
  await assert.rejects(fs.stat(path.join(f.dataDir, ".paper-100.lock")), { code: "ENOENT" });
  const status = await f.create().status(); assert.equal(status.account, null);
});

test("paper provider with an added execution capability is rejected before requesting a quote", async (t) => {
  const f = await fixture(t);
  const runner = f.create({ liveQuotes: true, reviewFile: f.reviewFile }, {
    quoteProviderFactory: () => ({ ...f.provider, sendTransaction() { throw new Error("must never execute"); } }),
  });
  const report = await runner.runOnce();
  assert.equal(report.account.openPositions, 0); assert.equal(f.calls.length, 0);
  assert.ok(report.decisions[0].reasons.includes("quote_provider_unavailable"));
});

test("paper review provenance is explicitly required and duplicate review keys fail closed", () => {
  const valid = review(event()); assert.equal(validatePaperReviews(valid), valid);
  for (const mutation of [value => { value.reviewer = ""; }, value => { value.mode = "auto_gmgn_labels"; },
    value => { value.reviews.push(structuredClone(value.reviews[0])); }]) {
    const copy = structuredClone(valid); mutation(copy); assert.throws(() => validatePaperReviews(copy));
  }
});

test("paper missing or corrupt review blocks new entries but never prevents an existing position exit", async (t) => {
  for (const missing of [false, true]) {
    const f = await fixture(t, { mark: (_request, quote) => ({ ...quote, valueUsdMicros: "5000000" }) });
    const runner = f.create({ liveQuotes: true, reviewFile: f.reviewFile });
    await runner.runOnce();
    if (missing) await fs.unlink(f.reviewFile); else await fs.writeFile(f.reviewFile, "{broken");
    f.advance(1000);
    const report = await runner.runOnce();
    assert.equal(report.account.openPositions, 0);
    assert.equal(report.account.closedPositions, 1);
    assert.ok(report.sourceIssues.some(issue => issue.reason === "paper_review_unreadable_or_invalid"));
    const saved = JSON.parse(await fs.readFile(runner.stateFile, "utf8"));
    const provenance = saved.account.closed[0].candidate.reviewProvenance;
    assert.equal(provenance.eventDigest, paperEventDigest(f.value));
    assert.equal(provenance.reviewer, "Offline fixture reviewer");
    assert.match(provenance.meaning, /user_supplied/);
  }
});
