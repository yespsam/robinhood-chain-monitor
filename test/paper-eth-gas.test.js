import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface } from 'ethers';
import { createEthGasMonitor, ETH_GAS_VERSION, validEthGas, ethGasUsd } from '../src/paper-eth-gas.js';
import { costAssumptions } from '../src/paper-strategy-engine.js';
import { paperCostGate } from '../src/paper-cost-policy.js';
const NOW=Date.parse('2026-09-27T12:00:00Z');
const sample=()=>({version:ETH_GAS_VERSION,chain:'eth',status:'ok',observedAt:new Date(NOW).toISOString(),blockAt:new Date(NOW-10000).toISOString(),priceObservedAt:new Date(NOW-60000).toISOString(),gasPriceWei:100000000,nativeUsd:2700,gasUnits:250000,buffer:1.25});
test('dynamic ETH cost uses fresh on-chain fee environment while retaining modeled units and entry cost caps',()=>{
  const s=sample();assert.equal(ethGasUsd(s,NOW),.084375);
  const c=costAssumptions('eth',0,0,10,'gmgn_reference_cost_v1',s,NOW);
  assert.equal(c.gasUsd,.084375);assert.equal(c.source,'assumption');assert.equal(c.gasEvidenceReady,true);
  const expensive=costAssumptions('eth',0,0,10,'gmgn_reference_cost_v1',{...s,gasPriceWei:4000000000},NOW);
  assert.equal(paperCostGate(expensive,{structureMain:true}).ready,false);
  const stale=costAssumptions('eth',0,0,10,'gmgn_reference_cost_v1',s,NOW+90001);
  assert.equal(stale.gasEvidenceReady,false);assert.match(paperCostGate(stale).reason,/Gas/);
  assert.equal(costAssumptions('bsc',0,0,10,'gmgn_reference_cost_v1',s,NOW).gasUsd,.02);
  for(const patch of [{chain:'bsc'},{status:'stale'},{gasPriceWei:0},{nativeUsd:-1},{gasUnits:21000},{observedAt:new Date(NOW+1).toISOString()},{priceObservedAt:new Date(NOW-3600001).toISOString()}])assert.equal(validEthGas({...s,...patch},NOW),false);
});
test('fee collector is single-flight, throttled, chain/round-bound and does not reuse failures as fresh',async()=>{
  const abi=new Interface(['function decimals() view returns(uint8)','function description() view returns(string)','function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
  let clock=NOW,calls=0,bad=false;
  const m=createEthGasMonitor({now:()=>clock,fetchImpl:async(url,options)=>{
    calls++;const body=JSON.parse(options.body);assert.ok(body.every(c=>!c.method.includes('send')&&!c.method.includes('sign')));
    return {ok:true,json:async()=>[
      {id:1,result:bad?'0x38':'0x1'},{id:2,result:'0x5f5e100'},
      {id:3,result:{timestamp:'0x'+Math.floor((clock-10000)/1000).toString(16),number:'0x1'}},
      {id:4,result:abi.encodeFunctionResult('decimals',[8])},{id:5,result:abi.encodeFunctionResult('description',['ETH / USD'])},
      {id:6,result:abi.encodeFunctionResult('latestRoundData',[1,2700n*100000000n,Math.floor(clock/1000)-60,Math.floor(clock/1000)-60,1])}]};
  }});
  await Promise.all([m.refresh(),m.refresh()]);assert.equal(calls,1);assert.equal(m.snapshot().status,'ok');
  await m.refresh();assert.equal(calls,1);
  clock+=31000;bad=true;await m.refresh();assert.equal(m.snapshot().status,'unavailable');
  await m.stop();clock+=60000;await m.refresh();assert.equal(calls,2);
});
