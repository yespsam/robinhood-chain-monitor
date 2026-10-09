import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperOrderFeeProbe } from '../src/paper-order-fee-probe.js';
const NOW=Date.parse('2026-09-28T00:00:00Z'),CA='0x'+'a'.repeat(40),WALLET='0x'+'b'.repeat(40),ROUTER='0x'+'c'.repeat(40),ZERO='0x'+'0'.repeat(40);
const amount='1000000000000000',received='100000000000000000000',balance='0x'+BigInt(received).toString(16),block={number:'0x10',hash:'0x'+'d'.repeat(64),timestamp:'0x'+(NOW/1000).toString(16)};
const request={chain:'bsc',address:CA,wallet:WALLET,inputAmount:amount};
const ok=(data='0x0',gas='0x5208')=>({status:'0x1',returnData:data,gasUsed:gas});
function fixture(change={}){
  const methods=[],requests=[];let simulations=0,blocks=0;
  const quote=async q=>{
    requests.push(q);const buy=q.input===ZERO;
    const t={chain_id:56,to:ROUTER,from_address:WALLET,input_token_address:q.input,output_token_address:q.output,
      value:buy?amount:'0',amount_in:q.amount,amount_out:buy?received:amount,amount_min_out:buy?received:amount,
      deadline:NOW/1000+1200,data:'0x1234567800',gas_limit:'4500000',token_in_usd_price:'800',
      approve_txs:buy?[]:[{from:WALLET,to:CA,value:'0',data:'0x095ea7b3'+ROUTER.slice(2).padStart(64,'0')+BigInt(received).toString(16).padStart(64,'0')}]};
    change.quote?.(t,buy);return{tx:t};
  };
  const fetchImpl=async(url,{body})=>{
    const call=JSON.parse(body);methods.push(call.method);assert.equal(url,'https://bsc-dataseed.bnbchain.org');
    let result;
    if(call.method==='eth_chainId')result=change.chainId||'0x38';
    if(call.method==='eth_getBlockByNumber')result={...block,...change.block?.(++blocks)};
    if(call.method==='eth_gasPrice')result='0x2faf080';
    if(call.method==='eth_simulateV1'){
      simulations++;assert.equal(call.params[1],block.number);assert.equal(call.params[0].validation,false);
      const state=call.params[0].blockStateCalls[0];assert.deepEqual(Object.keys(state.stateOverrides[WALLET]),['balance']);
      assert.equal(state.calls.length,simulations===1?3:6);
      result=[{calls:simulations===1?[ok(),ok('0x', '0x7a120'),ok(balance)]:[ok(),ok('0x','0x7a120'),ok(balance),ok('0x','0xc350'),ok('0x','0x61a80'),ok()]}];
      change.simulate?.(result,simulations);
    }
    assert.ok(result,`unexpected method ${call.method}`);
    return{ok:true,text:async()=>JSON.stringify({jsonrpc:'2.0',id:1,result})};
  };
  return{probe:createPaperOrderFeeProbe({quote,fetchImpl,now:change.now||(()=>NOW)}),methods,requests};
}
test('exact buy, approval and sell simulated on one pinned block; gas ceiling is not charged',async()=>{
  const f=fixture(),result=await f.probe.run(request);
  assert.equal(result.status,'roundtrip_simulated');assert.equal(result.accountingEligible,false);
  assert.equal(result.execution,false);assert.equal(result.signing,false);assert.equal(result.broadcast,false);
  assert.equal(result.legs.buy.simulatedGasUsed,'500000');assert.equal(result.legs.approvals[0].simulatedGasUsed,'50000');
  assert.equal(result.legs.sell.simulatedGasUsed,'400000');assert.ok(Math.abs(result.roundtripEstimatedGasUsd-.038)<1e-12);
  assert.equal(f.requests[1].amount,received);assert.equal(f.requests[1].input,CA);
  assert.ok(!JSON.stringify(result).includes(WALLET));assert.ok(!JSON.stringify(result).includes('095ea7b3'));
  assert.ok(f.methods.every(m=>!m.startsWith('eth_send')&&!m.includes('sign')));
});
test('zero sell deadline metadata does not bypass freshness or EVM simulation',async()=>{
  const f=fixture({quote:(t,buy)=>{if(!buy)t.deadline=0;}});
  assert.equal((await f.probe.run(request)).status,'roundtrip_simulated');
  const broken=fixture({quote:(t,buy)=>{if(!buy)t.deadline=0;},simulate:(r,n)=>{if(n===2)r[0].calls.at(-2).status='0x0';}});
  assert.equal((await broken.probe.run(request)).reason,'simulation_failed');
});
test('wrong chains, route binding, approvals, failed execution and balance mismatch fail closed without fallback',async()=>{
  for(const change of [
    {chainId:'0x1'}, {quote:t=>t.chain_id=1}, {quote:t=>t.from_address=ROUTER},
    {quote:t=>t.input_token_address=ROUTER}, {quote:t=>t.value='2'},
    {quote:(t,buy)=>{if(!buy)t.approve_txs[0].to=ROUTER;}},
    {quote:(t,buy)=>{if(!buy)t.approve_txs[0].data='0xa9059cbb'+'0'.repeat(128);}},
    {quote:(t,buy)=>{if(!buy)t.approve_txs[0].data='0x095ea7b3'+CA.slice(2).padStart(64,'0')+'f'.repeat(64);}},
    {quote:t=>t.deadline=NOW/1000},
    {simulate:r=>r[0].calls[1].status='0x0'},
    {simulate:(r,n)=>{if(n===2)r[0].calls.at(-1).returnData='0x1';}},
    {block:n=>n===2?{hash:'0x'+'f'.repeat(64)}:{}},
  ]){const r=await fixture(change).probe.run(request);assert.equal(r.status,'unavailable');assert.equal(r.accountingEligible,false);assert.equal(r.legs,undefined);}
});
test('unsupported chains and malformed orders are rejected before network, timeout and quote stderr are not leaked',async()=>{
  const f=fixture();await assert.rejects(f.probe.run({...request,chain:'base'}));await assert.rejects(f.probe.run({...request,inputAmount:'1e18'}));assert.equal(f.methods.length,0);
  let time=NOW;const stale=fixture({now:()=>{time+=31000;return time;}});assert.equal((await stale.probe.run(request)).status,'unavailable');
  const probe=createPaperOrderFeeProbe({quote:async()=>{throw Error('private token: DO-NOT-LEAK');},fetchImpl:async()=>({ok:true,text:async()=>JSON.stringify({id:1,result:'0x38'})}),now:()=>NOW});
  const r=await probe.run(request);assert.equal(r.reason,'readonly_probe_failed');assert.ok(!JSON.stringify(r).includes('DO-NOT-LEAK'));
});
