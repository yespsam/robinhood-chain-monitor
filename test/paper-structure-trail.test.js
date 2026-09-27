import test from 'node:test';
import assert from 'node:assert/strict';
import {assessMemeExit,MEME_EXIT_POLICY,LEGACY_MEME_EXIT_POLICY} from '../src/paper-meme-exit.js';
import {advanceStructureTrail,validStructureTrail} from '../src/paper-structure-trail.js';
import {opportunityChart} from '../src/paper-opportunity-policy.js';
const NOW=Date.parse('2026-09-27T00:00:00Z'),iso=n=>new Date(n).toISOString();
const address=`0x${'a'.repeat(40)}`, token={chain:'base',address};
const position=()=>({...token,entryPrice:1.03,openedAt:iso(NOW),markAt:iso(NOW+600000),
  memeExitPolicy:{...MEME_EXIT_POLICY},entryEvidence:{opportunity:{basis:'ohlcv',pattern:{reclaimPrice:1}},flow:{netBuyUsd:500}}});
function risingThenBreak() {
  const rows=Array.from({length:30},(_,i)=>({time:NOW+(i-20)*60000,open:1.5,close:1.5,high:1.55,low:1.45,volume:100}));
  rows[24]={...rows[24],open:1.38,close:1.37,high:1.4,low:1.3};
  rows[25]={...rows[25],open:1.4,close:1.5,high:1.53,low:1.36};
  rows[26]={...rows[26],open:1.5,close:1.55,high:1.6,low:1.45};
  rows[27]={...rows[27],open:1.55,close:1.6,high:1.65,low:1.5};
  rows[28]={...rows[28],open:1.32,close:1.29,high:1.33,low:1.28};
  rows[29]={...rows[29],open:1.29,close:1.27,high:1.30,low:1.26};
  return {...token,status:'ok',observedAt:iso(NOW+600000),price:1.27,
    structureChart:{...opportunityChart(rows,'ok',NOW+600000),...token}};
}

test('confirmed post-entry higher low raises the reference and exits while the frozen V1 still holds',()=>{
  const p=position(),m=risingThenBreak(),before=structuredClone(p),d=assessMemeExit(p,m,NOW+600000);
  assert.equal(d.structureTrail.level,1.3);assert.equal(d.structure.referenceLevel,1.3);
  assert.equal(d.structureTrail.confirmedAt,iso(NOW+420000));
  assert.equal(d.exit,true);assert.match(d.reason,/抬高低点/);
  assert.equal(d.comparison.exit,false);assert.match(d.comparison.meaning,/不虚构/);
  assert.equal(validStructureTrail(d.structureTrail,p),true);assert.deepEqual(p,before);
  const legacy=assessMemeExit({...p,memeExitPolicy:LEGACY_MEME_EXIT_POLICY},m,NOW+600000);
  assert.equal(legacy.version,'meme_evidence_exit_v1');assert.equal(legacy.exit,false);assert.equal(legacy.structureTrail,undefined);
});

test('unfinished right bars, pre-entry lows, a wick and missing candles cannot manufacture a trail exit',()=>{
  const p=position(),m=risingThenBreak();
  const early={...m,price:1.5,observedAt:iso(NOW+360000)};
  early.structureChart={...opportunityChart(m.structureChart.rows,'ok',NOW+360000),...token};
  assert.equal(advanceStructureTrail(p,early),null,'right second bar has not closed');
  assert.equal(advanceStructureTrail({...p,openedAt:iso(NOW+300000)},m),null,'the pivot predates entry');
  const wick=structuredClone(m);wick.structureChart.rows[28]={...wick.structureChart.rows[28],open:1.4,high:1.5,low:1.28,close:1.4};
  assert.equal(assessMemeExit(p,wick,NOW+600000).exit,false,'a wick followed by one close is not two closes');
  for(const mutate of [x=>x.observedAt=iso(NOW+601000),x=>x.observedAt=iso(NOW+580000),
    x=>x.address=`0x${'b'.repeat(40)}`,x=>x.structureChart.chain='sol',x=>x.structureChart.rows.splice(23,1)]) {
    const bad=structuredClone(m);mutate(bad);assert.equal(assessMemeExit(p,bad,NOW+600000).exit,false);
  }
});

test('confirmed references persist across serialization and never move lower or imply a guaranteed price',()=>{
  const p=position(),m=risingThenBreak(),d=assessMemeExit(p,m,NOW+600000);
  const resumed=JSON.parse(JSON.stringify({...p,structureTrail:d.structureTrail}));
  const lower=structuredClone(m);lower.structureChart.rows[24].low=1.2;
  assert.deepEqual(advanceStructureTrail(resumed,lower),d.structureTrail);
  assert.equal(validStructureTrail({...d.structureTrail,level:.9},p),false);
  assert.equal(validStructureTrail({...d.structureTrail,observedAt:iso(NOW+601000)},p),false);
  assert.equal(validStructureTrail({...d.structureTrail,confirmedAt:iso(NOW+360000)},p),false);
});
