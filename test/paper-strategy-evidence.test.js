import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPaperFlowEvidence, buildPaperNarrativeEvidence, createPaperEvidenceLoader, createPaperEvidenceIndex, buildPaperDualFlowEvidence } from '../src/paper-strategy-evidence.js';

const NOW = Date.parse('2026-09-20T10:00:00Z'), CA = `0x${'1'.repeat(40)}`, WALLET = `0x${'2'.repeat(40)}`;
const hash = digit => `0x${digit.repeat(64)}`;
const trade = (side, amountUsd, digit = 'a') => ({ chain: 'robinhood', tokenAddress: CA, wallet: WALLET, side, amountUsd, at: NOW - 1000, hash: hash(digit), tags: ['fomo', 'smart_degen'] });
const feedCoverage=()=>Object.fromEntries(['smartmoney','kol'].map(k=>[k,{valid:true,startAt:NOW-360000,endAt:NOW,observedAt:NOW,keys:[]}]));
const state = rows => ({ chains: { robinhood: { status: 'healthy', lastSuccessAt: new Date(NOW).toISOString(), feedTruncated: false,feedCoverage:feedCoverage() } }, trades: { robinhood: rows }, profiles: {} });
const build = (data, extra = {}) => buildPaperFlowEvidence({ state: data, chain: 'robinhood', address: CA, nowMs: NOW, ...extra });

test('per-scan index preserves all provider counts, freshness, conflicts and narrative gates', () => {
  const other=`0x${'3'.repeat(40)}`;
  const evidence={flowState:state([trade('buy',200),trade('sell',25,'b'),{...trade('buy',900,'c'),tokenAddress:other},
    {...trade('buy',300,'d'),chain:'bsc'},null]),events:[]};
  const index=createPaperEvidenceIndex(evidence);
  for(const address of [CA,other,`0x${'4'.repeat(40)}`,null])for(const nowMs of [NOW,NOW+120001,NOW+360001]){
    const options={chain:'robinhood',address,nowMs};
    assert.deepEqual(index.flow(options),buildPaperDualFlowEvidence({state:evidence.flowState,...options}));
    assert.deepEqual(index.narrative(options),buildPaperNarrativeEvidence({...options,events:evidence.events}));
  }
  const updated={...evidence,flowState:state([trade('sell',500,'e')])};
  assert.deepEqual(createPaperEvidenceIndex(updated).flow({chain:'robinhood',address:CA,nowMs:NOW}),
    buildPaperDualFlowEvidence({state:updated.flowState,chain:'robinhood',address:CA,nowMs:NOW}));
});

test('fast evidence cache reuses unchanged files and invalidates replaced, corrupt or deleted files', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'yesp-fast-evidence-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'gmgn-flow-state.json'), load = createPaperEvidenceLoader(dir);
  await fs.writeFile(file, JSON.stringify({ version: 1 }));
  const first = await load(); assert.equal(first.flowState.version, 1);
  assert.equal((await load()).flowState, first.flowState);
  await fs.writeFile(`${file}.new`, JSON.stringify({ version: 2 })); await fs.rename(`${file}.new`, file);
  assert.equal((await load()).flowState.version, 2);
  await fs.writeFile(file, '{broken'); assert.equal((await load()).flowState, null);
  await fs.unlink(file); assert.equal((await load()).flowState, null);
});

test('observed net flow subtracts sells and deduplicates identical feed records', () => {
  const buy = trade('buy', 400), sell = trade('sell', 150, 'b');
  const result = build(state([buy, buy, sell]));
  assert.equal(result.netBuyUsd, 250); assert.equal(result.uniqueBuyerCount, 1);
  assert.equal(result.fomoCount, 1); assert.equal(result.smartMoneyCount, 1);
  assert.equal(result.highProfitCount, 0); assert.equal(result.complete, true);
  assert.equal(build(state([buy, trade('sell', 600, 'b')])).netBuyUsd, -200);
  assert.equal(build(state([buy, trade('sell', 600, 'b')])).uniqueBuyerCount, 0);
  const exit = build(state([buy, trade('sell', 600, 'b')]));
  assert.equal(exit.smartMoneySellerCount, 1); assert.equal(exit.highProfitSellerCount, 0);
  assert.equal(exit.chain, 'robinhood'); assert.equal(exit.address, CA);
});

test('missing profit profiles do not erase a complete platform-tagged cohort or its sells',()=>{
  const data=state([trade('buy',400),trade('sell',150,'b')]);
  data.chains.robinhood.status='partial';data.chains.robinhood.coverageGap='wallet_profile_incomplete';
  const result=build(data);
  assert.equal(result.fresh,true);assert.equal(result.complete,true);assert.equal(result.coverageGap,null);
  assert.equal(result.sourceIssue,'wallet_profile_incomplete');
  assert.equal(result.highProfitCount,0);assert.equal(result.profileCheckedCount,0);
  assert.equal(result.smartMoneyCount,1);assert.equal(result.netBuyUsd,250);
  data.trades.robinhood.push(trade('sell',400,'c'));
  assert.equal(build(data).netBuyUsd,-150);assert.equal(build(data).smartMoneyCount,0);
});

test('ambiguous legs, quarantine, stale and future chain snapshots cannot qualify', () => {
  const data = state([trade('buy', 400), trade('sell', 100)]);
  assert.equal(build(data).complete, false); assert.equal(build(data).coverageGap, 'ambiguous_trade_legs');
  for (const date of [NOW - 120001, NOW + 30001]) {
    const item = state([trade('buy', 400)]); item.chains.robinhood.lastSuccessAt = new Date(date).toISOString();
    delete item.chains.robinhood.feedCoverage;
    assert.equal(build(item).fresh, false); assert.equal(build(item).netBuyUsd, null);
  }
  const item = state([trade('buy', 400)]); item.chains.robinhood.quarantinedTokens = { [CA]: new Date(NOW + 10000).toISOString() };
  assert.equal(build(item).coverageGap, 'token_quarantined'); assert.equal(build(item).netBuyUsd, null);
});

test('fresh feed timestamps cannot refresh the event-time entry pulse or duplicate buyers', () => {
  const buy=trade('buy',400),other={...trade('buy',300,'b'),wallet:`0x${'3'.repeat(40)}`};
  const evidence=build(state([buy,buy,other]));assert.equal(evidence.pulse.recentBuyerCount,2);
  assert.equal(evidence.pulse.recentNetBuyUsd,700);assert.equal(evidence.pulse.lastBuyAt,NOW-1000);
  const old=build(state([{...buy,at:NOW-100000}, {...other,at:NOW-100000}]));
  assert.equal(old.uniqueBuyerCount,2);assert.equal(old.pulse.recentBuyerCount,0);assert.equal(old.pulse.lastBuyAt,null);
  const broken=state([buy,trade('sell',100)]);assert.equal(build(broken).pulse,null);
});

test('partial feed exposes observed counts but never claims complete coverage', () => {
  const data = state([trade('buy', 400)]); Object.assign(data.chains.robinhood, { status: 'partial', feedTruncated: true });
  delete data.chains.robinhood.feedCoverage;
  const result = build(data); assert.equal(result.fresh, true); assert.equal(result.netBuyUsd, 400); assert.equal(result.complete, false);
  assert.equal(result.coverageGap, 'feed_window_unverified');
  delete data.chains.robinhood.lastSuccessAt; data.updatedAt = new Date(NOW).toISOString();
  assert.equal(build(data).fresh, false);
});

test('foreign chain, invalid timestamps and blocked wallets never add conviction', () => {
  const data = state([{ ...trade('buy', 400), chain: 'base' }, { ...trade('buy', 400), at: NOW + 60000 }, { ...trade('buy', 400), tags: ['wash_trader'] }]);
  assert.equal(build(data).netBuyUsd, 0);
});

test('Solana addresses stay case-sensitive and ticker text never becomes a narrative', () => {
  const ca = 'So11111111111111111111111111111111111111112';
  const data = { chains: { sol: { status: 'healthy', lastSuccessAt: new Date(NOW).toISOString() } }, trades: { sol: [{ ...trade('buy', 400), chain: 'sol', tokenAddress: ca.toLowerCase(), wallet: ca, hash: 'a'.repeat(88) }] } };
  assert.equal(build(data, { chain: 'sol', address: ca }).netBuyUsd, 0);
  const narrative = buildPaperNarrativeEvidence({ chain: 'robinhood', address: CA, token: { symbol: '世界级官方AI' }, nowMs: NOW });
  assert.equal(narrative.caBound, false); assert.equal(narrative.status, 'unverified');
});
