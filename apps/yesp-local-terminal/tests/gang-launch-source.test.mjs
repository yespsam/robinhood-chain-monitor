import test from 'node:test';
import assert from 'node:assert/strict';
import {keccak256} from 'ethers';
import {createGangLaunchSource} from '../server/gang-launch-source.mjs';
import {GANG_PADS,gangAbi} from '../server/gang-reader.mjs';
import {addr,hash} from './helpers/roundtrip-ledger.mjs';
function fixture(){let head=100,now=1000000,count=2,code='0x60006000',reorg=false;const pad={...GANG_PADS[0],hash:keccak256(code)},abi=gangAbi(pad),calls=[];
 const rpc=async(method,args)=>{calls.push([method,args]);if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return '0x'+head.toString(16);if(method==='eth_getCode')return code;if(method==='eth_getBlockByNumber'){const n=Number(BigInt(args[0]));return {number:args[0],hash:hash(n+(reorg&&n===100?10000:0)),timestamp:'0x'+Math.floor((now-(head-n)*1000)/1000).toString(16)};}
  assert.equal(method,'eth_call');const c=abi.parseTransaction({data:args[0].data});return abi.encodeFunctionResult(c.name,c.name==='tokenCount'?[count]:[addr(1000+Number(c.args[0]))]);};
 return {source:createGangLaunchSource({rpc,clock:()=>now,pads:[pad]}),calls,advance(n=1){head+=4;now+=4000;count+=n;},reorg(){reorg=true;},change(){code='0x60006001';},age(){now+=60000;}};
}
test('Gang chain directory baseline excludes every pre-existing token, waits two blocks, and does not repeat candidates',async()=>{const f=fixture(),baseline=await f.source.baseline();assert.equal(baseline.counts[GANG_PADS[0].address],'2');assert.deepEqual((await f.source.poll(baseline)).rows,[]);f.advance();const p=await f.source.poll(baseline);assert.equal(p.rows.length,1);assert.equal(p.rows[0].tokenAddress.toLowerCase(),addr(1002));await f.source.verify(p.rows[0],30);assert.deepEqual((await f.source.poll(p.cursor)).rows,[]);assert(f.calls.some(([m,p])=>m==='eth_call'&&p[1]==='0x66'));});
test('Gang source rejects reorg, changed contract code and excessive catch-up instead of buying uncertain candidates',async()=>{for(const [change,code]of [['reorg','GANG_SOURCE_REORG'],['change','GANG_CONTRACT_CHANGED']]){const f=fixture(),b=await f.source.baseline();f.advance();f[change]();await assert.rejects(f.source.poll(b),{code});}const f=fixture(),b=await f.source.baseline();f.advance(51);await assert.rejects(f.source.poll(b),{code:'GANG_SOURCE_GAP'});});
test('Gang source verifies the canonical discovery blocks again and rejects tokens outside the age bound',async()=>{const f=fixture(),b=await f.source.baseline();f.advance();const {rows:[r]}=await f.source.poll(b);f.reorg();await assert.rejects(f.source.verify(r,30),{code:'GANG_SOURCE_REORG'});f.age();await assert.rejects(f.source.verify(r,30),{code:'GANG_NEW_TOO_OLD'});});
