import test from 'node:test';
import assert from 'node:assert/strict';
import {createTradeReview,advanceTradeReview,validateTradeReview,tradeReviewSummary} from '../src/paper-trade-review.js';
import {renderTradeCountReview} from '../dashboard/trade-count-review.js';
import {createHash} from 'node:crypto';
const NOW=Date.parse('2026-09-25T07:00:00Z');
const trade=i=>({id:String(i),side:i%2?'sell':'buy',chain:'base',address:'fixture',symbol:'OFFLINE',atMs:NOW+i,
  quantity:1,realizedPnl:i%2?-.1:0,costsUsd:.02,price:1,entryEvidence:{},exitEvidence:{}});
const account=n=>({trades:Array.from({length:n},(_,i)=>trade(i))});
test('starts from current main trades, ignores time, reviews exactly at 100 new fills and persists across restart',()=>{
  const initial=createTradeReview(account(30),NOW);
  let s=advanceTradeReview(initial,account(129),NOW+1e6);
  assert.equal(s.pendingFills,99);assert.equal(s.reports.length,0);
  assert.equal(advanceTradeReview(s,account(129),NOW+1e9),s,'elapsed time is never a trigger');
  s=advanceTradeReview(JSON.parse(JSON.stringify(s)),account(130),NOW+1e6);
  assert.equal(s.reports.length,1);assert.equal(s.reports[0].fillCount,100);
  assert.equal(s.reports[0].review.overall.closedRounds,50);assert.equal(s.reports[0].lastTradeId,'129');
  assert.equal(s.pendingFills,0);assert.equal(tradeReviewSummary(s).remainingFills,100);
  assert.equal(advanceTradeReview(s,account(130),NOW+2e6),s);
  s=advanceTradeReview(s,account(335),NOW+1e6);
  assert.equal(s.reports.length,3);assert.equal(s.pendingFills,5);assert.equal(validateTradeReview(s,account(335)),true);
  const tampered=structuredClone(s);tampered.reports[0].windowRealizedPnlUsd=100;
  assert.throws(()=>validateTradeReview(tampered,account(335)),'stored report edits cannot silently change the result');
  assert.equal(tradeReviewSummary(s).aiAutomatic,false);
  assert.match(renderTradeCountReview(tradeReviewSummary(s)),/本批 5 \/ 100/);
  assert.match(renderTradeCountReview(tradeReviewSummary(s)),/第 3 批/);
});
test('count review panel escapes unknown source labels and shows local-only behavior',()=>{
  const s=tradeReviewSummary(createTradeReview(account(30),NOW));
  assert.match(renderTradeCountReview(s),/不定时调用 AI/);
  assert.match(renderTradeCountReview({...s,status:'error',error:'<script>bad</script>'}),/&lt;script&gt;/);
});
test('writeoffs do not inflate fill count; split sells are fills, but a complete position is one outcome',()=>{
  const a={trades:[trade(0),{...trade(1),quantity:.5},{...trade(2),side:'sell',quantity:.5}]};
  while(a.trades.length<100)a.trades.push({...trade(a.trades.length),side:'writeoff'});
  const s=advanceTradeReview(createTradeReview({trades:[]},NOW),a,NOW+1e6);
  assert.equal(s.pendingFills,3);assert.equal(s.reports.length,0);
  const carried={trades:[trade(0)]},initial=createTradeReview(carried,NOW);
  for(let i=1;i<=100;i++)carried.trades.push({...trade(i),side:'sell',quantity:.01,realizedPnl:.01});
  const completed=advanceTradeReview(initial,carried,NOW+1000).reports[0];
  assert.equal(completed.sells,100);assert.equal(completed.review.overall.closedRounds,1);
  assert.equal(completed.carriedInRounds,1,'original buy before baseline is recovered, not discarded or counted again');
});
test('duplicate ids, rewritten history, truncation and corrupt batch cursors fail without reset',()=>{
  const s=advanceTradeReview(createTradeReview(account(30),NOW),account(129),NOW+1e6);
  for(const a of [account(128),account(130)]){
    if(a.trades.length===130)a.trades[0].price=2;
    assert.throws(()=>validateTradeReview(s,a));
  }
  const duplicate=account(130);duplicate.trades[129].id='128';assert.throws(()=>advanceTradeReview(s,duplicate,NOW+1e6));
  const corrupted=structuredClone(s);corrupted.pendingFills=98;assert.throws(()=>validateTradeReview(corrupted,account(129)));
  assert.equal(s.pendingFills,99);
});
test('new batches include frozen evidence groups; old reports remain byte-for-byte and renderer escapes groups',()=>{
  const a=account(100),s=advanceTradeReview(createTradeReview({trades:[]},NOW),a,NOW+1000);
  assert.equal(s.reports[0].evidenceReview.groups[0].closedRounds,50);
  delete s.reports[0].evidenceReview;
  const {reportHash,...legacy}=s.reports[0];
  s.reports[0].reportHash=createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
  const old=JSON.stringify(s.reports[0]);assert.equal(validateTradeReview(s,a),true);
  const next=advanceTradeReview(s,account(200),NOW+1000);
  assert.equal(JSON.stringify(next.reports[0]),old);assert.ok(next.reports[1].evidenceReview);
  next.reports[1].evidenceReview.groups[0].narrativeLabel='<script>bad</script>';
  const html=renderTradeCountReview(tradeReviewSummary(next));
  assert.match(html,/入场证据分组/);assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
});
