import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, LEGACY_STRATEGY_ID } from '../src/liquidity-signal.js';
import { createLiquiditySwing } from '../src/liquidity-paper.js';
import { buildFixtureMarket, buildSwingBars, goodSecurity, runOfflineDry } from '../src/offline-fixture.js';

const NOW = Date.UTC(2026, 10, 16, 4, 0, 0);
const cfg = loadConfig({});

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'swing-liq-'));
}

test('SWING_LIVE and the legacy book are refused before any write', () => {
  const liveCfg = loadConfig({ SWING_LIVE: 'true' });
  assert.throws(() => createLiquiditySwing({ cfg: liveCfg, dataDir: path.join(tmp(), 'nope') }), /paper-only/);
  const legacyDir = path.join(tmp(), 'swing');
  fs.mkdirSync(legacyDir);
  fs.writeFileSync(path.join(legacyDir, 'ledger.jsonl'), '{"strategyId":"paper-lowcap-swing","type":"open"}\n');
  const before = fs.readFileSync(path.join(legacyDir, 'ledger.jsonl'));
  assert.throws(() => createLiquiditySwing({ cfg, dataDir: legacyDir }), /legacy data directory/);
  assert.deepEqual(fs.readFileSync(path.join(legacyDir, 'ledger.jsonl')), before);
  assert.equal(fs.existsSync(path.join(legacyDir, 'state.json')), false);
});

test('a foreign strategy ledger is not opened, migrated, or appended', async () => {
  const dir = tmp();
  const state = { strategyId: LEGACY_STRATEGY_ID, positions: { abc: { addr: 'abc', symbol: 'OLD', entryPrice: 1 } }, closed: [{ addr: 'abc', netUsd: -4 }] };
  fs.writeFileSync(path.join(dir, 'state.json'), JSON.stringify(state));
  fs.writeFileSync(path.join(dir, 'ledger.jsonl'), `${JSON.stringify({ strategyId: LEGACY_STRATEGY_ID, type: 'open', addr: 'abc' })}\n`);
  const beforeState = fs.readFileSync(path.join(dir, 'state.json'));
  const beforeLedger = fs.readFileSync(path.join(dir, 'ledger.jsonl'));
  const rt = createLiquiditySwing({ cfg, dataDir: dir, log() {} });
  await assert.rejects(() => rt.load(), /foreign ledger|paper-lowcap-swing/);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'state.json')), beforeState);
  assert.deepEqual(fs.readFileSync(path.join(dir, 'ledger.jsonl')), beforeLedger);
  assert.equal(fs.existsSync(path.join(dir, 'ohlcv')), false);
});

test('offline dry-run ranks depth over volume, rejects the shallow pool, and writes nothing', async () => {
  const { status, dir } = await runOfflineDry();
  assert.equal(status.live, false);
  assert.equal(status.orders, false);
  assert.equal(status.wallet, false);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(status.curve.ok, false);
  assert.equal(status.curve.error, 'bnb_usd_unavailable');
  assert.equal(status.opened.length, 0);
  const symbols = status.ranked.map(r => r.symbol);
  assert.deepEqual(symbols, ['DEEP', 'MID']);
  assert.ok(status.signals.map(s => s.symbol).includes('DEEP'));
  assert.equal(status.signals.every(s => s.quoteBacked === false), true);
  assert.ok((status.rejected.liq_low || 0) >= 1);
  assert.ok((status.rejected.stale_snapshot || 0) >= 1);
  assert.ok((status.rejected.pullback_shallow || 0) >= 1);
});

test('a non-dry book opens the deepest names only, with a separate strategy id', async () => {
  const dir = tmp();
  const market = buildFixtureMarket(NOW);
  const extra = { ...market.snapshots[0], addr: '0x' + 'f'.repeat(40), symbol: 'FOURTH', liquidityUsd: 60_000 };
  market.snapshots.push(extra);
  market.bars[extra.addr] = buildSwingBars(NOW).bars;
  market.security[extra.addr] = goodSecurity(NOW);
  const rt = createLiquiditySwing({ cfg, dataDir: dir, log() {} });
  const status = await rt.tick(market);
  assert.equal(status.strategyId, 'paper-lowcap-swing-liquidity');
  assert.equal(Object.keys(rt.state().positions).length, 3);
  const opened = Object.values(rt.state().positions).map(p => p.symbol).sort();
  assert.deepEqual(opened, ['DEEP', 'FOURTH', 'MID']);
  const ledger = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.equal(ledger.length, 3);
  for (const row of ledger) {
    assert.equal(row.strategyId, 'paper-lowcap-swing-liquidity');
    assert.equal(row.type, 'open');
    assert.equal(row.quoteBacked, false);
    assert.equal(row.modelReserveAssumption, true);
    assert.equal(row.lpFeeSource, 'model');
    assert.equal(row.sizeUsd, 20);
    assert.ok(row.tpPrice > row.price);
  }
  const other = tmp();
  const otherCfg = loadConfig({ SWING_STRATEGY_ID: 'paper-lowcap-swing-liquidity-b' });
  const rt2 = createLiquiditySwing({ cfg: otherCfg, dataDir: other, log() {} });
  await rt2.tick({ ...market, snapshots: market.snapshots.filter(s => s.symbol === 'DEEP') });
  const ledger2 = fs.readFileSync(path.join(other, 'ledger.jsonl'), 'utf8');
  assert.ok(ledger2.includes('paper-lowcap-swing-liquidity-b'));
  assert.equal(ledger2.includes('paper-lowcap-swing-liquidity"') || ledger2.includes('paper-lowcap-swing-liquidity\n'), false);
  assert.equal(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').includes('liquidity-b'), false);
});

test('curve quote reserve is labeled quote-backed, and missing curve state opens nothing', async () => {
  const dir = tmp();
  const raw = buildSwingBars(NOW);
  const priceUsd = 2e-7 * 600;
  const scale = priceUsd / raw.lastClose;
  const bars = raw.bars.map(b => ({ ...b, o: b.o * scale, h: b.h * scale, l: b.l * scale, c: b.c * scale }));
  const addr = '0x' + '9'.repeat(40);
  const entry = {
    addr, symbol: 'CURVE',
    activity: { vol1hUsd: 6_000, buys1h: 22, sells1h: 14, buyers1h: 10, sellers1h: 7, activeBars1h: 6, ageMin: 90 },
    state: { status: 1, reserveBnb: 20, circ: 400e6, thresh: 800e6, priceBnb: 2e-7, quoteIsNative: true, buyFeeBps: 100, sellFeeBps: 100, at: NOW },
    bnbUsd: 600,
    bars,
  };
  const market = {
    now: NOW, snapshots: [], bars: {}, security: { [addr]: goodSecurity(NOW) },
    curve: { ok: true, error: null, entries: [entry] },
  };
  const rt = createLiquiditySwing({ cfg, dataDir: dir, log() {} });
  const status = await rt.tick(market);
  assert.equal(status.curve.ok, true);
  assert.equal(Object.keys(rt.state().positions).length, 1);
  const row = JSON.parse(fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8').trim());
  assert.equal(row.venue, 'curve');
  assert.equal(row.quoteBacked, true);
  assert.equal(row.modelReserveAssumption, false);
  assert.equal(row.impactSource, 'observed_quote_reserve');
  assert.equal(row.lpFeeSource, 'venue');
  const broken = tmp();
  const rt2 = createLiquiditySwing({ cfg, dataDir: broken, log() {} });
  const missed = await rt2.tick({ ...market, curve: { ok: true, entries: [{ ...entry, state: null }] } });
  assert.equal(Object.keys(rt2.state().positions).length, 0);
  assert.ok((missed.rejected['curve:c_no_state'] || 0) >= 1);
  assert.equal(fs.existsSync(path.join(broken, 'ledger.jsonl')), false);
});

test('stale price does not take profit, a stop does not re-enter, and a duplicate is refused', async () => {
  const dir = tmp();
  const market = buildFixtureMarket(NOW);
  const only = market.snapshots.find(s => s.symbol === 'DEEP');
  const one = { ...market, snapshots: [only] };
  const rt = createLiquiditySwing({ cfg, dataDir: dir, log() {} });
  await rt.tick(one);
  const pos = rt.state().positions[only.addr];
  assert.ok(pos);
  const rich = { ...one, now: NOW + 60_000, snapshots: [{ ...only, at: NOW + 60_000 - 120_000, price: pos.tpPrice * 2 }] };
  const stale = await rt.tick(rich);
  assert.equal(stale.closedNow.length, 0);
  assert.ok(rt.state().positions[only.addr]);
  const stopped = await rt.tick({ ...one, now: NOW + 120_000, snapshots: [{ ...only, at: NOW + 120_000, price: pos.entrySpot * 0.8, liquidityUsd: 200_000 }] });
  assert.equal(stopped.closedNow.length, 1);
  assert.equal(stopped.closedNow[0].reason, 'stop_loss');
  assert.ok(stopped.closedNow[0].netPct < stopped.closedNow[0].grossPct);
  const ledger = fs.readFileSync(path.join(dir, 'ledger.jsonl'), 'utf8');
  assert.ok(ledger.includes('"type":"close"'));
  assert.equal(ledger.includes(`"strategyId":"${LEGACY_STRATEGY_ID}"`), false);
  assert.ok(ledger.includes('"strategyId":"paper-lowcap-swing-liquidity"'));
  const again = await rt.tick({ ...one, now: NOW + 180_000, snapshots: [{ ...only, at: NOW + 180_000 }] });
  assert.equal(Object.keys(rt.state().positions).length, 0);
  assert.ok(again.skips.some(s => s.reason === 'cooldown'));
  rt.state().positions[only.addr] = { ...pos, addr: only.addr };
  const dup = await rt.tick({ ...one, now: NOW + 200_000, snapshots: [{ ...only, at: NOW + 200_000 }] });
  assert.ok((dup.rejected.duplicate || 0) >= 1);
  assert.equal(Object.keys(rt.state().positions).length, 1);
});

test('unpriceable positions are written off at -100 rather than marked at a guessed price', async () => {
  const dir = tmp();
  const rt = createLiquiditySwing({ cfg, dataDir: dir, log() {} });
  await rt.load();
  const addr = '0x' + '7'.repeat(40);
  rt.state().positions[addr] = {
    addr, symbol: 'GONE', venue: 'dex', entrySpot: 1, entryPrice: 1.02, qty: 19, costUsd: 20,
    entryAt: NOW - (cfg.maxHoldHours + cfg.writeOffAfterHours + 1) * 3600e3,
    tpPrice: 2, stopPrice: 0.5, peak: 1, trough: 1, bucket: 'lt300k',
    cost: { knownSellFeePct: 0, lpFeePct: 0.25, impactSellPct: 0.1, quoteBacked: false, modelReserveAssumption: true },
  };
  const status = await rt.tick({ now: NOW, snapshots: [], bars: {}, security: {}, curve: { ok: false, error: 'not_scanned', entries: [] } });
  assert.equal(status.closedNow[0].reason, 'unpriceable_writeoff');
  assert.equal(status.closedNow[0].netPct, -100);
  assert.equal(status.closedNow[0].grossPct, null);
});

test('entrypoint source honors SWING_DATA_DIR and does not default to data/swing', () => {
  const src = fs.readFileSync(new URL('../scripts/paper.js', import.meta.url), 'utf8');
  assert.match(src, /SWING_DATA_DIR/);
  assert.match(src, /swing-liquidity/);
  assert.doesNotMatch(src, /path\.join\(root,\s*'data',\s*'swing'\)/);
  const paper = fs.readFileSync(new URL('../src/liquidity-paper.js', import.meta.url), 'utf8');
  const signal = fs.readFileSync(new URL('../src/liquidity-signal.js', import.meta.url), 'utf8');
  for (const text of [src, paper, signal]) {
    assert.equal(text.includes('sendTransaction'), false);
    assert.equal(text.includes('new Wallet'), false);
    assert.equal(text.includes('live-entry-gates'), false);
    assert.equal(text.includes('privateKey'), false);
  }
});
