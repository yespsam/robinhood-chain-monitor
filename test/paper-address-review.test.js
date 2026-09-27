import test from 'node:test';
import assert from 'node:assert/strict';
import {analyzeTraderSnapshot,analyzeWalletStatsSnapshot} from '../src/paper-address-review.js';
const NOW=Date.parse('2026-09-27T11:00:00Z'), address=n=>`0x${n.toString(16).padStart(40,'0')}`;
const CA=address(1), A=address(2), B=address(3), C=address(4), FUNDER=address(5);
const entry={id:'buy',side:'buy',chain:'bsc',address:CA,atMs:NOW-60000,entryEvidence:{memeExitContext:{
  cohortKnown:true,observedAt:NOW-65000,smartBuyers:[A,B,C],cohortTruncated:false}}};
const row=(wallet=A)=>({address:wallet,addr_type:0,balance:0,amount_percentage:0,realized_profit:'100',unrealized_profit:0,
  start_holding_at:(NOW-180000)/1000,end_holding_at:(NOW-70000)/1000,last_active_timestamp:(NOW-70000)/1000,
  tags:['smart_degen'],maker_token_tags:['bundler'],native_transfer:{from_address:FUNDER,name:null,timestamp:(NOW-1000000)/1000}});
const query=(list=[row(),row(B)])=>({type:'token_traders',chain:'bsc',address:CA,receivedAt:new Date(NOW).toISOString(),data:{list}});
test('early closed token winners are retrospective, not entry-known teachers; missing cohort is not sold',()=>{
  const r=analyzeTraderSnapshot(query(),entry,NOW);
  assert.equal(r.knowledge,'retrospective_only');assert.equal(r.earlyClosed.length,2);assert.equal(r.earlyClosed[0].secondsBeforeEntry,10);
  assert.equal(r.cohort[2].snapshotStatus,'not_in_bounded_sample');assert.equal(r.automaticTradingChanges,false);
  assert.equal(r.fundingGroups[0].classification,'unverified_shared_funder');assert.equal(r.fundingGroups[0].commonControlConfirmed,false);
});
test('partial holding, missing amounts, later activity and unrealized profit cannot become early realized exits',()=>{
  const a={...row(),balance:null,amount_percentage:null},b={...row(B),last_active_timestamp:(NOW-30000)/1000},c={...row(C),realized_profit:null,unrealized_profit:999};
  const r=analyzeTraderSnapshot(query([a,b,c]),entry,NOW);
  assert.equal(r.earlyClosed.length,0);assert.equal(r.cohort[0].snapshotStatus,'balance_unknown');
  assert.equal(r.fundingGroups[0].currentHoldingFraction,null);
});
test('duplicates do not inflate groups and conflicting duplicate wallets are quarantined',()=>{
  let r=analyzeTraderSnapshot(query([row(),row(),row(B)]),entry,NOW);
  assert.equal(r.usableWallets,2);assert.equal(r.duplicateRows,1);
  r=analyzeTraderSnapshot(query([row(),{...row(),balance:10},row(B)]),entry,NOW);
  assert.deepEqual(r.conflictingWallets,[A]);assert.equal(r.usableWallets,1);assert.equal(r.fundingGroups.length,0);
});
test('public exchange/service funders and pools are separated; conflicting funding aliases are not joined',()=>{
  const a=row(),b=row(B);b.native_transfer.name='FixedFloat: Hot Wallet';
  let r=analyzeTraderSnapshot(query([a,b,{...row(C),addr_type:2}]),entry,NOW);
  assert.equal(r.fundingGroups[0].classification,'public_service_source');assert.equal(r.excludedServiceWallets,1);
  a.native_transfer.address=address(9);r=analyzeTraderSnapshot(query([a,b]),entry,NOW);assert.equal(r.fundingGroups.length,0);
});
test('wrong CA, chain, future snapshots and overlong samples fail; future row data are excluded',()=>{
  for(const q of [{...query(),chain:'base'},{...query(),address:B},{...query(),receivedAt:new Date(NOW+1).toISOString()},query(Array.from({length:101},()=>row()))])
    assert.throws(()=>analyzeTraderSnapshot(q,entry,NOW));
  const r=analyzeTraderSnapshot(query([{...row(),last_active_timestamp:(NOW+1000)/1000}]),entry,NOW);
  assert.equal(r.usableWallets,0);assert.equal(r.invalidRows,1);
  assert.equal(analyzeTraderSnapshot(query(),{...entry,entryEvidence:{memeExitContext:{...entry.entryEvidence.memeExitContext,observedAt:NOW}}},NOW).cohortKnown,false);
});
test('stats batch results bind to returned wallets, never fan out a partial result',()=>{
  const q={type:'wallet_stats',chain:'bsc',period:'7d',wallets:[A,B],receivedAt:new Date(NOW).toISOString(),data:{wallet_address:A,realized_profit:'123'}};
  const r=analyzeWalletStatsSnapshot(q,NOW);
  assert.deepEqual(r.returnedWallets,[{wallet:A,period:'7d',realizedProfitUsd:123}]);assert.deepEqual(r.missingWallets,[B]);
  const conflict=analyzeWalletStatsSnapshot({...q,data:[q.data,{...q.data,realized_profit:'999'}]},NOW);
  assert.equal(conflict.returnedWallets.length,0);assert.deepEqual(conflict.missingWallets,[A,B]);
  assert.equal(analyzeWalletStatsSnapshot({...q,data:{wallet_address:C,realized_profit:500}},NOW).returnedWallets.length,0);
  assert.equal(analyzeWalletStatsSnapshot({...q,data:{wallet_address:A,address:B,realized_profit:500}},NOW).returnedWallets.length,0);
  assert.equal(analyzeWalletStatsSnapshot({...q,data:{address:A,realized_profit:500}},NOW).returnedWallets.length,0);
  assert.throws(()=>analyzeWalletStatsSnapshot({...q,receivedAt:NOW+1},NOW));
});
