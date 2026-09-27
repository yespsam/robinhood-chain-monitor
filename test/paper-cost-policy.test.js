import test from 'node:test';
import assert from 'node:assert/strict';
import { paperCostGate } from '../src/paper-cost-policy.js';
const cost=rate=>({source:'assumption',notionalUsd:9,estimatedRoundTripCostRate:rate});
test('cost policy distinguishes research needed, net economics and hard cost failures',()=>{
  assert.equal(paperCostGate(cost(.062)).ready,false);
  const missing=paperCostGate(cost(.062),{structureMain:true});
  assert.equal(missing.ready,false);assert.equal(missing.needsStructure,true);
  assert.equal(paperCostGate(cost(.062),{structureMain:true,economics:{ready:true}}).ready,true);
  assert.equal(paperCostGate(cost(.15),{structureMain:true,economics:{ready:true}}).ready,true);
  assert.equal(paperCostGate(cost(.150001),{structureMain:true,economics:{ready:true}}).ready,false);
  for(const value of [null,undefined,NaN,Infinity,-.01])
    assert.equal(paperCostGate(cost(value),{structureMain:true,economics:{ready:true}}).ready,false);
  assert.equal(paperCostGate({...cost(.04),notionalUsd:0}).ready,false);
});
