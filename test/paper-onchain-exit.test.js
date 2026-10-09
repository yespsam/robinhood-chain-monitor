import test from 'node:test';
import assert from 'node:assert/strict';
import {MEME_EXIT_POLICY,assessMemeExit,memeEntryContext} from '../src/paper-meme-exit.js';

const NOW=Date.parse('2026-10-08T00:00:00Z'),iso=n=>new Date(n).toISOString();
const CA=`0x${'a'.repeat(40)}`,wallet=n=>`0x${String(n).repeat(40)}`;
const token={chain:'bsc',address:CA,price:1};
const signal={version:'bsc_onchain_internal_burst_v1',provider:'bsc_portal_logs',chain:'bsc',address:CA,
  buyers:[{wallet:wallet(1)},{wallet:wallet(2)}]};
const row=(n,buyUsd=0,sellUsd=200,at=NOW+1000)=>({wallet:wallet(n),buyUsd,sellUsd,netBuyUsd:buyUsd-sellUsd,
  lastBuyAt:buyUsd?at:null,lastSellAt:sellUsd?at:null,tags:[],highProfit:false});
const flow=(at,rows)=>({...token,provider:'bsc_portal_logs',status:'healthy',fresh:true,complete:true,
  observedAt:iso(at),netBuyUsd:rows.reduce((sum,w)=>sum+w.netBuyUsd,0),wallets:rows,
  scope:'指定 CA 的固定 Portal 已核区间；非全链、非聪明钱资格'});
function position() {
  const evidence={flow:flow(NOW,[row(1,300,0,NOW),row(2,300,0,NOW)]),collectiveSignal:structuredClone(signal),
    flowDiagnostics:{provider:'bsc_portal_logs'}};
  evidence.memeExitContext=memeEntryContext(token,evidence,NOW);
  return {...token,entryPrice:1,openedAt:iso(NOW),memeExitPolicy:{...MEME_EXIT_POLICY},entryEvidence:evidence};
}
const mark=(at,rows)=>({...token,status:'ok',observedAt:iso(at),flow:flow(at,rows)});

test('onchain entry freezes a separate ordinary cohort without manufacturing smart-money qualification',()=>{
  const p=position(),context=p.entryEvidence.memeExitContext;
  assert.deepEqual(context.smartBuyers,[]);
  assert.deepEqual(context.cohortBuyers,[wallet(1),wallet(2)]);
  assert.equal(context.cohortKnown,true);
  const tagged=p.entryEvidence.flow.wallets.map(w=>({...w,tags:['smart_money'],highProfit:true}));
  assert.deepEqual(memeEntryContext(token,{...p.entryEvidence,flow:flow(NOW,tagged)},NOW).smartBuyers,[]);
  for(const change of [s=>s.provider='gmgn',s=>s.address=wallet(4),s=>s.version='future_unknown',s=>s.buyers.push(s.buyers[0])]) {
    const e=structuredClone(p.entryEvidence);change(e.collectiveSignal);
    const result=memeEntryContext(token,e,NOW);assert.equal(result.cohortKnown,false);assert.deepEqual(result.cohortBuyers,[]);
  }
});

test('onchain exits observe new sells from frozen entry addresses, not unrelated smart-tagged accounts',()=>{
  const p=position();
  let d=assessMemeExit(p,mark(NOW+1000,[row(1),row(2)]),NOW+1000);
  assert.equal(d.flowWatch.count,1);assert.deepEqual(d.flow.cohortSellers,[wallet(1),wallet(2)]);
  assert.match(d.flow.summary,/冻结入场普通地址群/);assert.doesNotMatch(d.flow.summary,/聪明钱标签/);
  p.thesisFlowWatch=d.flowWatch;
  const later=NOW+32000;
  d=assessMemeExit(p,mark(later,[row(1,0,250,later),row(2,0,250,later)]),later);
  assert.equal(d.exit,true);assert.match(d.reason,/入场普通地址/);
  const unrelated=[row(3,0,400,later),row(4,0,400,later)].map(w=>({...w,tags:['smart_money'],highProfit:true}));
  d=assessMemeExit(p,mark(later,unrelated),later);assert.equal(d.exit,false);assert.equal(d.flow.sellerCount,0);
});

test('onchain exits fail closed for source/coverage mismatch and timestamps or old sales alone do not confirm',()=>{
  const p=position(),first=mark(NOW+1000,[row(1),row(2)]);
  p.thesisFlowWatch=assessMemeExit(p,first,NOW+1000).flowWatch;
  const later=NOW+32000;
  assert.equal(assessMemeExit(p,mark(later,[row(1),row(2)]),later).exit,false);
  assert.equal(assessMemeExit(p,mark(later,[row(1,0,250,NOW),row(2,0,250,NOW)]),later).exit,false);
  for(const change of [f=>f.provider='gmgn',f=>f.complete=false,f=>f.coverageGap='reorg',f=>f.address=wallet(5),f=>f.observedAt=iso(later+1)]) {
    const m=mark(later,[row(1,0,250,later),row(2,0,250,later)]);change(m.flow);
    const d=assessMemeExit(p,m,later);assert.equal(d.exit,false);assert.equal(d.flow.usable,false);
  }
});

test('old tagged contexts keep their existing shape and behavior',()=>{
  const f={...flow(NOW,[{...row(1,300,0,NOW),tags:['smart_money']}]),provider:'gmgn'};
  const context=memeEntryContext(token,{flow:f},NOW);
  assert.deepEqual(context.smartBuyers,[wallet(1)]);assert.equal(context.cohortKnown,true);
  assert.equal(Object.hasOwn(context,'cohortBuyers'),false);
});
