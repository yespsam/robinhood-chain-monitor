import test from 'node:test';
import assert from 'node:assert/strict';
import {pendingContractHash} from '../server/pending-contract.mjs';
const wallet='0x'+'1'.repeat(40),to='0x'+'2'.repeat(40),hash='0x'+'a'.repeat(64);
const op={steps:[{orderId:'pending-1',startedAt:100000,plan:{wallet,nonce:'0x2',tx:{from:wallet,to,inputData:'0x12345678',value:'0x1'}}}]};
const tx={hash,from:wallet,to,nonce:'0x2',input:'0x12345678',value:'0x1'};
test('phone-confirmed contract candidates are accepted only after exact transaction identity checks',async()=>{
 const cli={recentTransactions:async p=>{assert.deepEqual(p,{chainId:'56',since:40000});return [hash];}};
 const resolve=value=>pendingContractHash({cli,rpc:async(method,args)=>{assert.equal(method,'eth_getTransactionByHash');assert.deepEqual(args,[hash]);return value;},op});
 assert.equal(await resolve(null),null);assert.equal(await resolve({...tx,nonce:'0x1'}),null);assert.equal(await resolve(tx),hash);
 for(const patch of [{to:wallet},{input:'0xdeadbeef'},{value:'0x2'}])await assert.rejects(()=>resolve({...tx,...patch}),{code:'PENDING_TRANSACTION_CHANGED'});
});
test('missing order reference cannot trigger discovery or a new submission',async()=>{
 const copy=structuredClone(op);delete copy.steps[0].orderId;
 assert.equal(await pendingContractHash({cli:{recentTransactions:async()=>assert.fail('unexpected read')},rpc:async()=>assert.fail('unexpected RPC'),op:copy}),null);
});
