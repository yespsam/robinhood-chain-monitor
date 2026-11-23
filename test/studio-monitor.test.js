import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStudioSnapshot } from '../src/studio-snapshot.js';
import { deriveLivePipelineDiagnosis, extractTransactionHash, isObservationFresh, liveSwitchStatus, normalizeStudioSnapshot, observationLabel, observationsFresh, realizedLedgerSummary } from '../dashboard/studio-model.js';

const WALLET = `0x${'1'.repeat(40)}`;
const readConfig = (enabled = true, spendAsset = 'bnb') => ({
  LIVE_TRADING_ENABLED: String(enabled), LIVE_WALLET: WALLET, LIVE_SPEND_ASSET: spendAsset,
});
const noLedger = () => ({ positions: [], realized: {} });
const deps = (overrides = {}) => ({
  cache: {},
  now: () => 100_000,
  readBnbBalance: async () => 1,
  readBnbPriceUsd: async () => 500,
  readUsdtBalanceUsd: async () => 100,
  readLedger: noLedger,
  ...overrides,
});

test('studio snapshot matches the page schema and marks the gate as preview-only', async () => {
  const snapshot = await buildStudioSnapshot({ project: '/nonexistent/studio', strategy: {}, env: readConfig(), dependencies: deps() });
  const normalized = normalizeStudioSnapshot(snapshot);
  assert.equal(normalized.live.enabled, true);
  assert.equal(normalized.live.bnb, 1);
  assert.equal(normalized.live.observations.bnb.status, 'fresh');
  assert.equal(normalized.think.gate.previewOnly, true);
  assert.equal(normalized.think.gate.ok, true);
  assert.deepEqual(normalized.think.decisions, []);
  assert.equal(liveSwitchStatus(normalized.live).label, '实盘开关已启用 · 执行状态待核验');
});

test('disabled live switch performs no wallet or price reads', async () => {
  let reads = 0;
  const snapshot = await buildStudioSnapshot({
    project: '/nonexistent/studio', strategy: {}, env: readConfig(false),
    dependencies: deps({
      readBnbBalance: async () => { reads++; throw new Error('must not run'); },
      readBnbPriceUsd: async () => { reads++; throw new Error('must not run'); },
      readUsdtBalanceUsd: async () => { reads++; throw new Error('must not run'); },
    }),
  });
  assert.equal(reads, 0);
  assert.equal(snapshot.live.observations.bnb.status, 'not_requested');
  assert.equal(snapshot.think.gate.ok, false);
  assert.equal(liveSwitchStatus(snapshot.live).key, 'off');
});

test('BNB spend mode does not issue an unnecessary USDT balance read', async () => {
  let usdtReads = 0;
  const snapshot = await buildStudioSnapshot({
    project: '/nonexistent/studio', strategy: {}, env: readConfig(),
    dependencies: deps({ readUsdtBalanceUsd: async () => { usdtReads++; return 100; } }),
  });
  assert.equal(usdtReads, 0);
  assert.equal(snapshot.live.observations.spendBalance.value, 1);
});

test('failed balance refresh retains its original timestamp and blocks a green preview', async () => {
  const cache = {
    [`bnb:${WALLET}`]: { value: 1, observedAtMs: 0, attemptedAtMs: 0, error: null },
  };
  const snapshot = await buildStudioSnapshot({
    project: '/nonexistent/studio', strategy: {}, env: readConfig(),
    dependencies: deps({ cache, readBnbBalance: async () => { throw new Error('rpc unavailable'); } }),
  });
  assert.equal(snapshot.live.observations.bnb.observedAt, new Date(0).toISOString());
  assert.equal(snapshot.live.observations.bnb.status, 'degraded');
  assert.equal(snapshot.live.balanceUsd, null);
  assert.equal(snapshot.think.gate.ok, false);
  assert.match(snapshot.think.gate.reason, /不可用或已过期/);
});

test('USDT view surfaces native BNB gas as a monitor-only warning', async () => {
  const snapshot = await buildStudioSnapshot({
    project: '/nonexistent/studio', strategy: {}, env: readConfig(true, 'usdt'),
    dependencies: deps({ readBnbBalance: async () => 0.001 }),
  });
  assert.equal(snapshot.live.balanceUsd, 100);
  assert.equal(snapshot.think.gate.monitorWarnings[0].ok, false);
  assert.match(snapshot.think.gate.monitorWarnings[0].detail, /预留/);
});

test('studio reports cumulative realized ledger PnL separately from today and counts closed ledger positions', async () => {
  const snapshot = await buildStudioSnapshot({
    project: '/nonexistent/studio', strategy: {}, env: readConfig(),
    dependencies: deps({ readLedger: () => ({
      positions: [{ status: 'closed' }, { status: 'open' }],
      realized: { '2026-11-03': -6.94, '2026-11-04': 2.5 },
    }) }),
  });
  assert.ok(Math.abs(snapshot.live.realizedTotalUsd - -4.44) < 1e-9);
  assert.equal(snapshot.live.closedPositionCount, 1);
  assert.equal(snapshot.live.todayRealizedUsd, 0);
});

test('legacy studio snapshot can derive realized total from fully recorded closed positions', () => {
  assert.deepEqual(realizedLedgerSummary({ positions: [
    { status: 'closed', realizedPnlUsd: -6.94 }, { status: 'open', realizedPnlUsd: null },
  ] }), { value: -6.94, count: 1 });
  assert.deepEqual(realizedLedgerSummary({ positions: [{ status: 'closed' }] }), { value: null, count: 1 });
});

test('snapshot schema mismatch is visible and cannot masquerade as a live state', () => {
  assert.throws(() => normalizeStudioSnapshot({ live: {} }), /live 与 think/);
  assert.equal(liveSwitchStatus({ enabled: true, killed: false }).label, '实盘开关已启用 · 执行状态待核验');
  assert.equal(observationLabel({ status: 'degraded', ageMs: 70_000 }), '刷新失败 · 上次成功 70 秒前');
  assert.equal(observationLabel({ status: 'stale', ageMs: 61_000 }), '已过期 · 上次成功 61 秒前');
  assert.equal(isObservationFresh(undefined), false);
  assert.equal(isObservationFresh({ status: 'fresh', ageMs: 61_000 }), false);
  assert.equal(observationsFresh({ enabled: true, spendAsset: 'bnb', observations: {} }), false);
  assert.equal(observationsFresh({ spendAsset: 'bnb', observations: {
    bnb: { status: 'fresh', ageMs: 2_000 }, bnbPriceUsd: { status: 'fresh', ageMs: 2_000 },
  } }), true);
  const txHash = `0x${'a'.repeat(64)}`;
  assert.equal(extractTransactionHash({ result: `submitted ${txHash}` }), txHash);
  assert.equal(extractTransactionHash({ sellTxHash: txHash }), txHash);
  assert.equal(extractTransactionHash({ result: 'no hash here' }), null);
});

test('studio explains that enabled live is waiting for a paper buy, not connected to Grok', async () => {
  const snapshot = await buildStudioSnapshot({
    project: '/nonexistent/studio',
    strategy: {
      session: { id: 'confirmed-pvp-v2-estimated-20260928' },
      cadence: { eventDispatch: { lastEvaluation: { at: new Date(99_000).toISOString(), decision: '观察', token: { chain: 'bsc' } } } },
      evaluations: Array.from({ length: 4 }, (_, i) => ({ decision: i ? '观察' : '不买', reasons: ['缺少入场证据'] })),
      account: { trades: [] },
    },
    env: readConfig(), dependencies: deps(),
  });
  const diagnosis = deriveLivePipelineDiagnosis(snapshot);
  assert.equal(diagnosis.key, 'waiting');
  assert.match(diagnosis.title, /等待合格的新买入信号/);
  assert.match(diagnosis.sourceLabel, /未接入 Grok/);
  assert.match(diagnosis.detail, /买入决策 0 条/);
});

test('studio explains when the latest signal is on a chain outside the live scope', async () => {
  const snapshot = await buildStudioSnapshot({
    project: '/nonexistent/studio',
    strategy: {
      session: { id: 'confirmed-pvp-v2-estimated-20260928' },
      cadence: { eventDispatch: { lastEvaluation: { at: new Date(99_000).toISOString(), decision: '观察', token: { chain: 'solana' } } } },
      evaluations: [{ decision: '观察', reasons: [] }],
    },
    env: readConfig(), dependencies: deps(),
  });
  assert.match(deriveLivePipelineDiagnosis(snapshot).detail, /最近评估在 SOL，不在当前实盘链范围 BSC 内/);
});

test('studio preview uses the actual mirror source and marks source mismatch as blocked', async () => {
  const snapshot = await buildStudioSnapshot({
    project: '/nonexistent/studio', strategy: { session: { id: 'confirmed-pvp-v2-test' }, evaluations: [] },
    env: { ...readConfig(), LIVE_SIGNAL_SOURCE: 'grok-feed' }, dependencies: deps(),
  });
  assert.equal(snapshot.think.gate.ok, false);
  assert.equal(snapshot.think.gate.checks.find(x => x.name === '信号来源与镜像实现').ok, false);
  assert.equal(deriveLivePipelineDiagnosis(snapshot).key, 'blocked');
});

test('historical BSC buys are labeled scope matches, never as live-qualified orders', async () => {
  const snapshot = await buildStudioSnapshot({
    project: '/nonexistent/studio',
    strategy: { session: { id: 'confirmed-pvp-v2-test' }, account: { trades: [
      { side: 'buy', chain: 'bsc', address: '0xabc', costBasisUsd: 10 },
      { side: 'buy', chain: 'sol', address: 'So111', costBasisUsd: 10 },
    ] } },
    env: readConfig(), dependencies: deps(),
  });
  const bscBuy = snapshot.think.signalBuys.find(item => item.chain === 'bsc');
  const solBuy = snapshot.think.signalBuys.find(item => item.chain === 'sol');
  assert.equal(bscBuy.scopeMatch, true);
  assert.equal(solBuy.scopeMatch, false);
  assert.equal('wouldMirror' in bscBuy, false);
});
