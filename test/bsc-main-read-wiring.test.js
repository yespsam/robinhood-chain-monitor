import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { applyPrivateBscRpcConfig } from '../src/bsc-private-rpc.js';
import { createRpcPool } from '../src/bsc-launchpad-monitor.js';
import { orderedFlapQuoteMetadataRpcUrls, resolveFlapQuoteAssetMetadataAcrossRpcUrls } from '../src/platform-capability-monitor.js';

// Execute only the production wiring snippets with inert dependencies. Never
// import index/config, read dotenv/private files, start workers or make a call.
const source = fs.readFileSync(new URL('../src/index.js', import.meta.url), 'utf8');
const section = (start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `production wiring section missing: ${start}`);
  return source.slice(first, last);
};
const cloneSection = section('let mainBscPrimaryReadConfig = null;', 'async function resolveFlapQuoteAssetMetadata');
const metadataSection = section('async function resolveFlapQuoteAssetMetadata', 'const storage = new Storage');
const monitorSection = section('if (config.flapQuoteMonitorEnabled) startMonitor', 'if (config.binanceMonitorEnabled) startMonitor');
const narrativeSection = section('if (config.narrativeSniperEnabled) {', 'const pendingBscGithubCandidates');
const paid = { host: 'bsc-paid.example.test', httpUrl: 'https://bsc-paid.example.test/synthetic-token',
  wsUrl: 'wss://bsc-paid.example.test/synthetic-token' };
const publicUrl = 'https://bsc-rpc.publicnode.com';
const proofOne = 'https://proof-one.example.test', proofTwo = 'https://proof-two.example.test';
const address = '0x1111111111111111111111111111111111111111';

function harness({ privateConfig = paid, enabled = true, paidFails = false, realPoolFactory = null } = {}) {
  const pools = [], monitors = [], shadowConfigs = [], otherProviders = [], lines = [];
  let loads = 0;
  const config = {
    dataDir: '/synthetic-data-only', bscSharedRpcEnabled: true,
    bscRpcUrl: publicUrl, bscRpcUrls: [publicUrl], bscArchiveRpcUrls: [proofOne],
    bscCausalClassificationRpcUrls: [publicUrl], bscPreferredRpcHosts: [],
    morphRpcUrl: 'https://morph.example.test',
    flapQuoteMonitorEnabled: enabled, fourRegistryMonitorEnabled: enabled, narrativeSniperEnabled: enabled,
    flapQuoteLogRpcUrls: [proofOne, proofTwo], flapQuoteStateRpcUrls: [proofTwo, proofOne],
    fourRegistryLogRpcUrls: [proofTwo, proofOne], fourRegistryStateRpcUrls: [proofOne, proofTwo],
  };
  const before = structuredClone(config);
  const pool = (urls, archives, concurrency, options) => {
    const record = { urls: [...urls], archives: [...archives], concurrency, options };
    pools.push(record);
    if (realPoolFactory) return realPoolFactory(urls, archives, concurrency, options);
    return { record, async send() {
      if (paidFails && urls[0] === paid.httpUrl) throw new Error('synthetic paid outage');
      return '0x38';
    }, async getCode() { return '0x1234'; } };
  };
  const context = vm.createContext({ config, applyPrivateBscRpcConfig,
    loadPrivateBscRpcConfig: ({ dataDir }) => { assert.equal(dataDir, config.dataDir); loads++; return privateConfig; },
    createRpcPool: pool, orderedFlapQuoteMetadataRpcUrls, resolveFlapQuoteAssetMetadataAcrossRpcUrls,
    createAbortableJsonRpcProvider: (url, chainId) => {
      otherProviders.push({ url, chainId });
      return { async send() { return `0x${chainId.toString(16)}`; }, async getCode() { return '0x1234'; } };
    },
    readTokenMetadata: async () => ({ name: 'Fixture', symbol: 'FIX', decimals: 18 }),
    createFlapQuoteMonitor: (input, deps) => { monitors.push({ name: 'flap', input, deps }); return {}; },
    createFourRegistryMonitor: (input, deps) => { monitors.push({ name: 'four', input, deps }); return {}; },
    createProductionNarrativeShadowQuoteProvider: input => { shadowConfigs.push(input); return {}; },
    createNarrativeSourceAdapter: () => ({}),
    createNarrativeSniperRuntime: (input, deps) => { monitors.push({ name: 'narrative', input, deps }); return { ready: Promise.resolve() }; },
    startMonitor: (_name, callback) => callback(),
    shutdownRequested: false, deliverAlert() {}, sendAlerts() {}, cancelPendingFourRegistryEvent() {},
    bscLaunchpadMonitor: null, narrativeSniperRuntime: null, narrativeEvidenceRpcProvider: null,
    flapQuoteMonitor: null, fourRegistryMonitor: null, flapQuoteRpcProvider: null, fourRegistryRpcProvider: null,
    flapQuoteMetadataProviders: new Map(), flapQuoteLogProviders: new Map(), flapQuoteStateProviders: new Map(),
    fourRegistryLogProviders: new Map(), fourRegistryStateProviders: new Map(),
    URL, console: { log: line => lines.push(line), info: line => lines.push(line), error: line => lines.push(line) },
  });
  vm.runInContext(cloneSection + metadataSection, context);
  return { context, config, before, pools, monitors, shadowConfigs, otherProviders, lines, loads: () => loads,
    runMonitors: () => vm.runInContext(monitorSection, context),
    runNarrative: () => vm.runInContext(narrativeSection, context) };
}

test('main BSC primary config is lazy, private and leaves shared proof config unchanged', () => {
  const h = harness();
  assert.equal(h.loads(), 0);
  const first = h.context.bscPrimaryReadConfig();
  assert.notEqual(first, h.config);
  assert.equal(first.bscRpcUrl, paid.httpUrl);
  assert.deepEqual([...first.bscRpcUrls], [paid.httpUrl, publicUrl]);
  assert.deepEqual([...first.bscPreferredRpcHosts], [paid.host]);
  assert.equal(h.context.bscPrimaryReadConfig(), first);
  assert.equal(h.loads(), 1);
  assert.deepEqual(h.lines, [`[bsc-main-reader] primary=${paid.host}`]);
  assert.ok(!h.lines.join('').includes('synthetic-token'));
  assert.deepEqual(h.config, h.before);
});

test('BSC metadata remains paid-first after both ordering passes and uses fallback only on failure', async () => {
  for (const paidFails of [false, true]) {
    const h = harness({ paidFails });
    const result = await h.context.resolveFlapQuoteAssetMetadata({ address, chainId: 56 });
    assert.equal(result.symbol, 'FIX');
    assert.deepEqual(h.pools.map(p => p.urls[0]), paidFails ? [paid.httpUrl, publicUrl] : [paid.httpUrl]);
    assert.ok(h.pools.every(p => p.options.preferredHosts[0] === paid.host));
    assert.deepEqual(h.config, h.before);
  }
});

test('Morph metadata and disabled main consumers never load the private BSC config', async () => {
  const h = harness({ enabled: false });
  await h.context.resolveFlapQuoteAssetMetadata({ address, chainId: 2818 });
  h.runMonitors(); h.runNarrative();
  assert.equal(h.loads(), 0);
  assert.equal(h.pools.length, 0);
  assert.equal(h.monitors.length, 0);
  assert.deepEqual(h.otherProviders, [{ url: h.config.morphRpcUrl, chainId: 2818 }]);
});

test('Flap and Four primary pools receive paid preference without changing fixed-origin proof readers', () => {
  const h = harness(); h.runMonitors();
  assert.equal(h.loads(), 1);
  assert.equal(h.monitors.length, 2);
  for (const monitor of h.monitors) {
    assert.equal(monitor.input, h.config);
    assert.equal(monitor.deps.provider.record.urls[0], paid.httpUrl);
    assert.equal(monitor.deps.provider.record.archives[0], paid.httpUrl);
    assert.deepEqual([...monitor.deps.provider.record.options.preferredHosts], [paid.host]);
    const prefix = monitor.name === 'flap' ? 'flapQuote' : 'fourRegistry';
    for (const [role, key] of [['log', 'Log'], ['state', 'State']]) {
      const readers = monitor.deps[`${role}VerificationProviders`];
      assert.deepEqual(Array.from(readers, p => p.sourceId), h.before[`${prefix}${key}RpcUrls`]);
      assert.ok(readers.every(p => p.provider.record.urls.length === 1
        && p.provider.record.urls[0] === p.sourceId && p.provider.record.options.preferredHosts === undefined));
    }
  }
  assert.deepEqual(h.config, h.before);
});

test('narrative primary evidence uses paid config while independent shadow proof still receives global config', () => {
  const h = harness(); h.runNarrative();
  assert.equal(h.loads(), 1);
  assert.equal(h.pools.length, 1);
  assert.deepEqual(h.pools[0].urls, [paid.httpUrl, publicUrl]);
  assert.deepEqual([...h.pools[0].options.preferredHosts], [paid.host]);
  assert.equal(h.pools[0].options.priorityLane, 'realtime');
  assert.equal(h.shadowConfigs[0], h.config);
  assert.equal(h.monitors[0].input, h.config);
  assert.deepEqual(h.config, h.before);
});

test('missing private config preserves existing public primary and proof wiring', () => {
  const h = harness({ privateConfig: null }); h.runMonitors(); h.runNarrative();
  assert.equal(h.loads(), 1);
  for (const monitor of h.monitors) {
    assert.equal(monitor.deps.provider.record.urls[0], publicUrl);
    assert.deepEqual([...monitor.deps.provider.record.options.preferredHosts], []);
  }
  assert.deepEqual(h.config, h.before);
});

test('paid primary consumers cannot turn off cross-process admission with an old public-only flag', async () => {
  const h = harness(); h.config.bscSharedRpcEnabled = false;
  await h.context.resolveFlapQuoteAssetMetadata({ address, chainId: 56 });
  h.runMonitors(); h.runNarrative();
  const primary = h.pools.filter(pool => pool.urls.includes(paid.httpUrl));
  assert.equal(primary.length, 4);
  assert.ok(primary.every(pool => pool.options.coordinatorDataDir === h.config.dataDir));
});

test('main metadata failures and startup diagnostics never expose paid endpoint paths', async t => {
  const realPools = [];
  const h = harness({ realPoolFactory: (urls, archives, concurrency, options) => {
    const pool = createRpcPool(urls, archives, concurrency, { ...options,
      coordinatorDataDir: null, requestTimeoutMs: 100,
      providerFactory: url => ({
        async send() { throw Object.assign(new Error(`transport failed at ${url}`), {
          info: { error: { message: `upstream response for ${url}` } },
        }); },
        async getCode() { return '0x1234'; },
      }),
    });
    realPools.push(pool); return pool;
  } });
  t.after(() => realPools.forEach(pool => pool.destroy()));
  await assert.rejects(h.context.resolveFlapQuoteAssetMetadata({ address, chainId: 56 }), error => {
    assert.equal(error.code, 'FLAP_QUOTE_METADATA_UNAVAILABLE');
    const diagnostics = JSON.stringify({ message: error.message, details: error.details, lines: h.lines });
    assert.ok(!diagnostics.includes(paid.httpUrl));
    assert.ok(!diagnostics.includes('synthetic-token'));
    assert.match(diagnostics, /bsc-paid\.example\.test/);
    return true;
  });
});
