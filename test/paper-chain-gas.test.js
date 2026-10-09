import test from 'node:test';
import assert from 'node:assert/strict';
import { Interface, id } from 'ethers';
import { createChainGasMonitor, GAS_NETWORKS, validChainGas, receiptFeeNative } from '../src/paper-chain-gas.js';
import {gasFixture} from './helpers/paper-gas-fixture.js';
const NOW=Date.parse('2026-09-27T14:00:00Z'),hash='0x'+'1'.repeat(64),blockHash='0x'+'2'.repeat(64),wallet='0x'+'3'.repeat(40),ca='0x'+'4'.repeat(40);
const receipt={status:'0x1',gasUsed:'0x30d40',effectiveGasPrice:'0x3b9aca00',transactionHash:hash,blockHash,from:wallet,
  logs:[{address:ca,topics:[id('Transfer(address,address,uint256)')]}]};
test('EVM actual fee samples include Base L1 exactly once and Nitro does not double count L1 gas',()=>{
  assert.equal(receiptFeeNative('eth',receipt),.0002);
  assert.equal(receiptFeeNative('robinhood',{...receipt,gasUsedForL1:'0x2710'}),.0002);
  assert.equal(receiptFeeNative('base',{...receipt,l1Fee:'0x9184e72a000',operatorFeeScalar:'0x0',operatorFeeConstant:'0x0'}),.00021);
  for(const bad of [{...receipt,status:'0x0'},{...receipt,gasUsed:null},{...receipt,effectiveGasPrice:'0x0'}])assert.throws(()=>receiptFeeNative('eth',bad));
  assert.throws(()=>receiptFeeNative('base',receipt));
  assert.throws(()=>receiptFeeNative('base',{...receipt,l1Fee:'0x0',operatorFeeScalar:'0x1',operatorFeeConstant:'0x0'}));
});
test('fee evidence expires by receipt time and fetch time and never crosses chains',()=>{
  for(const chain of Object.keys(GAS_NETWORKS)) {
    const g=gasFixture(chain,NOW);assert.equal(validChainGas(g,chain,NOW),true);
    for(const mutate of [g=>g.status='unavailable',g=>g.chain='wrong',g=>g.observedAt=new Date(NOW+1).toISOString(),g=>g.gasUsd=0,
      g=>g.samples[0].at=new Date(NOW-300001).toISOString(),g=>g.samples.push(g.samples[0]),g=>g.gasUsd*=2,g=>g.nativeUsd=NaN]){
      const bad=structuredClone(g);mutate(bad);assert.equal(validChainGas(bad,chain,NOW),false);
    }
    assert.equal(validChainGas(g,chain,NOW+90001),false);
  }
});
test('collector verifies public swaps on all chains, single-flights and stops without signing or fabricating fees',async()=>{
  let time=NOW,requests=0,wrongChain=false;
  const oracle=new Interface(['function decimals() view returns(uint8)','function description() view returns(string)','function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
  const state={trades:Object.fromEntries(Object.keys(GAS_NETWORKS).map(chain=>[chain,[{chain,hash:chain==='sol'?'1'.repeat(88):hash,wallet:chain==='sol'?'2'.repeat(44):wallet,tokenAddress:chain==='sol'?'3'.repeat(44):ca,at:NOW-1000}]]))};
  const m=createChainGasMonitor({now:()=>time,fetchImpl:async(url,options)=>{
    requests++;assert.equal(options.redirect,'error');const chain=Object.keys(GAS_NETWORKS).find(c=>GAS_NETWORKS[c].rpc===url);
    const calls=JSON.parse(options.body),result=c=>{
      assert.ok(['eth_chainId','eth_call','eth_getTransactionReceipt','eth_getBlockByHash','getGenesisHash','getTransaction'].includes(c.method));
      if(c.method==='eth_chainId')return '0x'+(wrongChain?99:GAS_NETWORKS[chain].id).toString(16);
      if(c.method==='getGenesisHash')return GAS_NETWORKS.sol.id;
      if(c.method==='eth_call') {
        const fn=oracle.parseTransaction(c.params[0]).name,symbol=c.params[0].to.startsWith('0x5f4')?'ETH':c.params[0].to.startsWith('0x14e')?'BNB':'SOL';
        return oracle.encodeFunctionResult(fn,fn==='decimals'?[8]:fn==='description'?[`${symbol} / USD`]:[1,100n*10n**8n,0,Math.floor(NOW/1000)-1,1]);
      }
      if(c.method==='eth_getTransactionReceipt')return {...receipt,...(chain==='base'?{l1Fee:'0x0'}:{})};
      if(c.method==='eth_getBlockByHash')return {hash:blockHash,timestamp:'0x'+(NOW/1000-1).toString(16)};
      if(c.method==='getTransaction')return {blockTime:NOW/1000-1,meta:{err:null,fee:123456,preTokenBalances:[{mint:'3'.repeat(44)}]},
        transaction:{signatures:['1'.repeat(88)],message:{accountKeys:[{pubkey:'2'.repeat(44),signer:true}]}}};
    };
    return {ok:true,text:async()=>JSON.stringify(calls.map(c=>({id:c.id,result:result(c)})))};
  }});
  const first=m.refresh(state);assert.equal(m.refresh(state),first);await first;
  for(const chain of Object.keys(GAS_NETWORKS))assert.equal(m.snapshot(chain).status,'ok',JSON.stringify(m.snapshot(chain)));
  assert.equal(m.snapshot('sol').samples[0].feeNative,.000123456);
  const count=requests;await m.refresh(state);assert.equal(requests,count);
  time+=30001;wrongChain=true;await m.refresh(state);assert.equal(m.snapshot('eth').status,'unavailable');
  await m.stop();time+=40000;const stopped=requests;await m.refresh(state);assert.equal(requests,stopped);
});
