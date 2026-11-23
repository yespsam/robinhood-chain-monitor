import test from 'node:test';
import assert from 'node:assert/strict';
import {validateChartSource} from '../src/paper-chart-source.js';
import {reconstructStructureEntry} from '../src/paper-structure-entry-proof.js';
import {recoveryEntryCheck} from '../src/paper-recovery-policy.js';
import {evaluatePaperStrategies,createPaperStrategyAccount,advancePaperStrategyAccount} from '../src/paper-strategy-engine.js';
import {ESTIMATED_COST_VERSION} from '../src/paper-estimated-cost.js';

// Offline, isolated input only. No request, cache injection or live execution.
const END=Date.parse('2026-10-10T10:00:00Z'),NOW=END+15000,iso=n=>new Date(n).toISOString();
const CA='0x'+'a'.repeat(40),QUOTE='0x'+'b'.repeat(40),POOL='0x'+'c'.repeat(64);
const modes={allowExploratory:true,pvpMode:true,confirmedMode:true,evidenceHoldMode:true,continuousPaperMode:true,
  opportunityMode:true,opportunityReviewMode:true,memeExitMode:true,recoveryMode:true,lossRepairMode:true,
  estimatedFeeMode:true,evidenceTierGate:true};
function input(poolId=POOL) {
  const raw=Array.from({length:30},(_,i)=>{const p=i<8?.8+i*.025:1;
    const [open,high,low,close,volume]=i===29?[1,1.035,.999,1.03,180]:[p,p+.01,p-.005,p,100];
    return {time:END-(30-i)*60000,open,high,low,close,volume};});
  const price=raw.at(-1).close,token={chain:'bsc',address:CA,symbol:'OFFLINE_SOURCE_TEST',price,
    marketStage:'external',liquidity:60000,volume:5000,isHoneypot:false,isWashTrading:false,rugRatio:.01,
    top10HolderRate:.15,devTeamHoldRate:.01,bundlerRate:.01,buyTax:0,sellTax:0};
  const checked=validateChartSource({status:'ok',source:'geckoterminal',chain:'bsc',address:CA,tokenAddress:CA,
    network:'bsc',poolId,dexId:'uniswap-v4-bsc',tokenSide:'base',currency:'usd',resolution:'1m',
    from:END/1000-3600,to:END/1000,requestWindow:'latest_closed_at_dispatch',
    requestedAt:iso(NOW-3000),receivedAt:iso(NOW-2000),emptyIntervals:false,inferredBars:0,
    binding:{network:'bsc',poolId,baseToken:{address:CA,decimals:18},quoteToken:{address:QUOTE,decimals:18},
      metadataRequestedAt:iso(NOW-6000),metadataReceivedAt:iso(NOW-4000)},
    ohlcvMeta:{base:{address:CA},quote:{address:QUOTE}},candles:raw},token,{nowMs:NOW});
  assert.equal(checked.ready,true);
  return {...modes,token,nowMs:NOW,observedAt:iso(NOW),priceObservedAt:iso(NOW),marketStatus:'ok',requireFastQuote:true,
    compoundingCash:100,klineStatus:'ok',candles:checked.candles,chartProvenance:checked.provenance,flow:{},
    quoteHistory:[-4000,0].map(d=>({...token,status:'ok',price:d?price*.998:price,observedAt:iso(NOW+d)}))};
}
const evaluate=i=>evaluatePaperStrategies(i)[0];
const fill=row=>advancePaperStrategyAccount({...createPaperStrategyAccount({nowMs:NOW}),estimatedCostModel:ESTIMATED_COST_VERSION},
  {...modes,externalStructureMainAdmission:true,evaluations:[row],nowMs:NOW});

test('source provenance survives evaluator, frozen recovery proof and actual strict writer',()=>{
  const i=input(),row=evaluate(i),before=structuredClone(row);
  assert.equal(row.decision,'可模拟',JSON.stringify({missing:row.missing,reasons:row.reasons}));
  assert.deepEqual(row.evidence.recoveryEntry.chartProvenance,i.chartProvenance);
  const validated=reconstructStructureEntry(row,NOW);assert.equal(validated.ready,true,validated.reason);
  assert.deepEqual(validated.chartProvenance,i.chartProvenance);
  const next=fill(row);assert.equal(next.trades.length,1);
  assert.deepEqual(next.trades[0].entryEvidence.structureValidation.chartProvenance,i.chartProvenance);
  assert.deepEqual(row,before);assert.equal(next.execution,false);assert.equal(next.signing,false);assert.equal(next.broadcast,false);
  i.chartProvenance.binding.baseToken.address=QUOTE;i.candles[0].volume++;
  assert.deepEqual(row,before,'recovery evidence is frozen without aliasing evaluator input');
});

test('changing or dropping a frozen source cannot bypass recovery and final writer by preserving ready flags',()=>{
  const row=evaluate(input());
  for(const [label,mutate] of [
    ['missing provenance',p=>{delete p.chartProvenance;}],
    ['unknown provenance version',p=>{p.chartProvenance.version='unknown';}],
    ['unknown provider',p=>{p.chartProvenance.source='unknown';}],
    ['different chain',p=>{p.chartProvenance.network='robinhood';}],
    ['different pool',p=>{p.chartProvenance.poolId='0x'+'d'.repeat(64);}],
    ['changed candle',p=>{p.candles[0].volume++;}],
    ['inferred minute',p=>{p.candles[0].synthetic=true;}],
    ['empty interval filling',p=>{p.chartProvenance.emptyIntervals=true;}],
    ['mixed-source minute',p=>{p.candles[0].source='gmgn-cli';}],
    ['changed request boundary',p=>{p.chartProvenance.to+=60;p.chartProvenance.from+=60;}],
  ]) {
    const forged=structuredClone(row);mutate(forged.evidence.recoveryEntry);
    assert.equal(forged.decision,'可模拟');
    assert.equal(recoveryEntryCheck(forged.evidence.recoveryEntry,forged.token,null,NOW,forged.evidence.opportunity).ready,false,label);
    assert.equal(reconstructStructureEntry(forged,NOW).ready,false,label);
    assert.equal(fill(forged).trades.length,0,label);
  }
});

test('source identity is included in structural source digest even when numeric prices are identical',()=>{
  const first=reconstructStructureEntry(evaluate(input()),NOW);
  const second=reconstructStructureEntry(evaluate(input('0x'+'d'.repeat(64))),NOW);
  assert.equal(first.ready,true);assert.equal(second.ready,true);assert.notEqual(first.sourceDigest,second.sourceDigest);
});

test('unmarked legacy GMGN numeric proof remains eligible under the existing strict writer checks',()=>{
  const i=input();delete i.chartProvenance;i.candles.forEach(c=>{delete c.source;delete c.sourcePoolId;});
  const row=evaluate(i),proof=reconstructStructureEntry(row,NOW);
  assert.equal(row.decision,'可模拟');assert.equal(proof.ready,true);assert.equal(proof.chartProvenance,undefined);
  assert.equal(fill(row).trades.length,1);
});
