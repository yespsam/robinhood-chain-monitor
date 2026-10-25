import test from 'node:test';
import assert from 'node:assert/strict';
import {projectQuoteOpportunity, selectQuoteOpportunity, EVENT_LEASE_HISTORY_LIMIT} from '../src/paper-quote-opportunity.js';
import {quoteCandidatePool} from '../src/paper-research-scheduler.js';
import {MONITOR_ENTRY_VERSION, monitorSignalId} from '../src/paper-monitor-signal.js';
import {ALPHA_ENTRY_VERSION, ALPHA_LIST_URL} from '../src/binance-alpha-catalog.js';
import {buildCollectiveWire} from '../src/paper-collective-signal.js';

const NOW = Date.parse('2026-10-13T12:00:00Z'), iso = n => new Date(n).toISOString();
const address = n => '0x' + n.toString(16).padStart(40, '0');
const key = r => `${r.input.token.chain}:${r.input.token.address}`;
const row = (n, chain='bsc') => ({input: {token: {chain, address: address(n)}}, candidateBook: 'main',
  decisions: [{decision: '观察', score: 60, missing: ['连续新鲜报价确认'], reasons: [],
    evidence: {safety: {blocked: []}, opportunity: {basis: 'flow', pattern: {ready: true}}}}]});
function monitor(n, id='original', at=NOW) {
  const r = row(n), signal = {version: MONITOR_ENTRY_VERSION, paperOnly: true, ...r.input.token,
    source: 'own_verified', sourceId: id, sourceAt: iso(at), observedAt: iso(at), authenticated: true,
    sourceUrl: 'https://example.com/offline-fixture', text: 'offline explicit CA event'};
  signal.id = monitorSignalId(signal); r.input.monitorSignal = signal; return r;
}
function alpha(n) {
  const r = row(n), signal = {version: ALPHA_ENTRY_VERSION, ...r.input.token, alphaId: 'ALPHA_1',
    sourceUrl: ALPHA_LIST_URL, listingTime: NOW, observedAt: iso(NOW), offline: false, offsell: false};
  signal.id = `binance-alpha:${signal.alphaId}:${signal.chain}:${signal.address}:${signal.listingTime}`;
  r.input.alphaSignal = signal; return r;
}
function collective(n) {
  const r = row(n), profiles = {};
  for (let i=1; i<=3; i++) profiles[`bsc:${address(i)}`] = Object.fromEntries(['7d','30d'].map(period => [period,
    {chain:'bsc',wallet:address(i),period,checkedAt:iso(NOW-5000),realizedProfitUsd:20000,realizedRoi:.1,
      winRate:.7,tokenCount:150,buyCount:200,sellCount:150,tags:['smart_money'],
      createdAt:NOW/1000-90*86400,lastTradeAt:NOW/1000-10,createdTokenCount:0}]));
  const feedCoverage = Object.fromEntries(['smartmoney','kol'].map(k => [k,
    {valid:true,startAt:NOW-360000,endAt:NOW,observedAt:NOW,keys:[]} ]));
  const state = {chains:{bsc:{status:'healthy',feedCoverage}},profiles,trades:{bsc:[1,2,3].map(i =>
    ({chain:'bsc',tokenAddress:r.input.token.address,wallet:address(i),side:'buy',amountUsd:200,
      at:NOW-(4-i)*1000,hash:'0x'+String(i).repeat(64),tags:['smart_money']}))}};
  r.input.collectiveSignal = buildCollectiveWire({state,nowMs:NOW}).signals[0];
  assert.ok(r.input.collectiveSignal); return r;
}
const refresh = (rows, now) => {
  for (const r of rows) for (const field of ['monitorSignal','alphaSignal'])
    if (r.input[field]) r.input[field].observedAt = iso(now);
};
function step(rows, previous, now, extra={}) {
  refresh(rows, now);
  return selectQuoteOpportunity(rows, previous?.lease || null, now,
    {windowMs:45000,mainFirst:true,eventLeaseHistory:previous?.eventLeaseHistory || [],
      eventPreemptionSuppressedUntil:previous?.eventPreemptionSuppressedUntil || 0,...extra});
}

test('runtime projection preserves current catalyst, signal-time and cost evidence instead of CA ordering', () => {
  const price=row(1), event=row(9);
  for (const [r,catalyst,group,cost] of [[price,false,'price_only',.01],[event,true,'verified_wallet',.04]]) {
    r.decisions[0].token=r.input.token;
    r.decisions[0].evidence.lossRepair={ready:true,catalystReady:catalyst,group};
    r.decisions[0].evidence.costAssumptions={estimatedRoundTripCostRate:cost};
    r.decisions[0].evidence.opportunity.signalAt=NOW;
  }
  const original=structuredClone([price,event]);
  const projected=[price,event].map(r=>projectQuoteOpportunity(r,{recoveryMode:true}));
  assert.equal(projected[1].decisions,event.decisions);
  const ranked=quoteCandidatePool(projected,{mainFirst:true,catalystFirst:true});
  assert.equal(ranked[0].input.token.address,event.input.token.address);
  const current=step([projected[0]],null,NOW);
  assert.equal(step(ranked,current,NOW+1000).lease.since,NOW,'ordinary evidence sorting cannot restart a lease');
  assert.equal(step(ranked,current,NOW+1000).row,projected[0]);
  assert.deepEqual([price,event],original);
  // No old evaluation may be borrowed after the new one loses the catalyst.
  const updated=structuredClone(event); updated.decisions[0].evidence.lossRepair.catalystReady=false;
  assert.equal(quoteCandidatePool([projected[0],projectQuoteOpportunity(updated)],{catalystFirst:true})[0],projected[0]);
});

test('collective and monitor groups cannot reset each other every tick; all rows get a bounded turn', () => {
  const c=collective(1), m=monitor(2), ordinary=row(3), grants=[];
  let previous=null;
  for (let offset=0; offset<=118000; offset+=2000) {
    // Real collective proofs expire after 30s, never fabricate a 120s flow.
    const rows=offset<=28000?[c,m,ordinary]:[m,ordinary];
    const next=step(rows,previous,NOW+offset);
    if (!previous || next.lease.key!==previous.lease.key) grants.push([next.lease.key,offset]);
    else assert.equal(next.lease.since,previous.lease.since,'repeat ticks must not renew the lease');
    previous=next;
  }
  assert.deepEqual(grants.slice(0,3),[[key(c),0],[key(m),30000],[key(ordinary),76000]]);
  assert.equal(previous.lease.key,key(ordinary));
});

test('a new event preempts ordinary research once, including events first served by normal rotation', () => {
  const a=monitor(2), ordinary=row(1), rows=[a,ordinary];
  const normal=step([ordinary],null,NOW);
  const first=step(rows,normal,NOW+2000);
  assert.equal(first.lease.key,key(a)); assert.equal(first.lease.since,NOW+2000);
  assert.equal(first.eventLeaseHistory.length,1);
  assert.equal(step(rows,first,NOW+4000).lease.since,NOW+2000);
  const rotated=step(rows,first,NOW+48000);
  assert.equal(rotated.lease.key,key(ordinary));
  for (let offset=50000;offset<93000;offset+=2000)
    assert.deepEqual(step(rows,rotated,NOW+offset).lease,rotated.lease);
  const byRotation=step(rows,null,NOW);
  const after=step(rows,byRotation,NOW+46000);
  assert.equal(after.lease.key,key(ordinary));
  assert.deepEqual(step(rows,after,NOW+48000).lease,after.lease);
});

test('simultaneous valid events rotate without stealing active event leases or renewing the same CA', () => {
  const a=alpha(1), b=monitor(2), ordinary=row(3), rows=[a,b,ordinary];
  let selected=step(rows,null,NOW);
  for (let offset=2000;offset<45000;offset+=2000)
    assert.deepEqual(step(rows,selected,NOW+offset).lease,selected.lease);
  selected=step(rows,selected,NOW+46000); assert.equal(selected.lease.key,key(b));
  const another=monitor(2,'new-id',NOW+47000);
  selected=step([a,another,ordinary],selected,NOW+48000);
  assert.equal(selected.lease.since,NOW+46000,'another event on the same CA cannot renew its lease');
  assert.equal(selected.eventLeaseHistory.length,3);
  const next=step([a,another,ordinary],selected,NOW+92000);
  assert.equal(next.lease.key,key(ordinary));
  const freshEvent=monitor(4,'genuinely-new',NOW+94000);
  assert.equal(step([a,another,freshEvent,ordinary],next,NOW+94000).lease.key,key(freshEvent));
});

test('stale, future, forged, wrong-chain or held/control events cannot preempt a main lease', () => {
  const ordinary=row(1), current=step([ordinary],null,NOW);
  const mutations=[r=>r.input.monitorSignal.sourceAt=iso(NOW-120001),
    r=>r.input.monitorSignal.sourceAt=iso(NOW+3000),r=>r.input.monitorSignal.id='forged',
    r=>r.input.monitorSignal.chain='sol',r=>{r.candidateBook='comparison';},
    r=>{r.input.opportunityAccount={positions:{[key(r)]:{}}};}];
  for (const mutate of mutations) {
    const event=monitor(2); mutate(event);
    const next=step([event,ordinary],current,NOW+2000);
    assert.deepEqual(next.lease,current.lease);
    assert.equal(next.eventLeaseHistory.length,0);
  }
  const expiredAlpha=alpha(2); expiredAlpha.input.alphaSignal.listingTime=NOW-300001;
  const s=expiredAlpha.input.alphaSignal; s.id=`binance-alpha:${s.alphaId}:${s.chain}:${s.address}:${s.listingTime}`;
  assert.deepEqual(step([expiredAlpha,ordinary],current,NOW+2000).lease,current.lease);
  const lost=step([],current,NOW+2000); assert.equal(lost.lease,null);
});

test('event history is bounded without evicting active IDs or reviving duplicate preemption', () => {
  const ordinary=row(1), event=monitor(2), current=step([ordinary],null,NOW);
  const history=Array.from({length:EVENT_LEASE_HISTORY_LIMIT},(_,i)=>
    ({id:`already-granted-${i}`,sourceAt:NOW,expiresAt:NOW+120000}));
  const next=step([event,ordinary],{...current,eventLeaseHistory:history},NOW+2000);
  assert.deepEqual(next.lease,current.lease); assert.deepEqual(next.eventLeaseHistory,history);
  const fresh=monitor(3,'after-expiry',NOW+122000);
  const ordinaryLease=step([ordinary],null,NOW+121000);
  const cleared=step([fresh,ordinary],{...ordinaryLease,eventLeaseHistory:history},NOW+122000);
  assert.equal(cleared.lease.key,key(fresh)); assert.equal(cleared.eventLeaseHistory.length,1);
});

test('same event ID with a changed source clock stays suppressed across original expiry and repeated ticks', () => {
  const original=monitor(2), ordinary=row(1), served=step([original],null,NOW);
  const normal=step([ordinary],null,NOW+120500);
  const changed=monitor(2,'original',NOW+120000);
  let selected={...normal,eventLeaseHistory:served.eventLeaseHistory};
  for (const offset of [121000,123000,125000]) {
    selected=step([changed,ordinary],selected,NOW+offset);
    assert.deepEqual(selected.lease,normal.lease);
    assert.equal(selected.eventLeaseHistory[0].sourceAt,NOW,'suppression must not rewrite the original event time');
  }
});

test('overflow-served events cannot preempt again as soon as old history slots expire', () => {
  const event=monitor(2), ordinary=row(1), history=Array.from({length:EVENT_LEASE_HISTORY_LIMIT},(_,i)=>
    ({id:`full-${i}`,sourceAt:NOW-74000,expiresAt:NOW+46000}));
  const served=step([event,ordinary],null,NOW,{eventLeaseHistory:history});
  assert.equal(served.lease.key,key(event));
  const rotated=step([event,ordinary],served,NOW+45000);
  assert.equal(rotated.lease.key,key(ordinary));
  const cleared=step([event,ordinary],rotated,NOW+47000);
  assert.deepEqual(cleared.lease,rotated.lease);
});
