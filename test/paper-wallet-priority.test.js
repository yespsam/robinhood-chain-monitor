import test from 'node:test';
import assert from 'node:assert/strict';
import {walletBuyResearchHint} from '../src/paper-wallet-priority.js';
import {planHotResearch,selectResearchChart} from '../src/paper-research-scheduler.js';
const NOW=Date.parse('2026-10-03T06:00:00Z'),CA='0x'+'a'.repeat(40),OTHER='0x'+'b'.repeat(40),W='0x'+'1'.repeat(40);
const input=()=>({memeExitMode:true,token:{chain:'bsc',address:CA},flow:{chain:'bsc',address:CA,provider:'gmgn',
  fresh:true,complete:true,observedAt:new Date(NOW-10000).toISOString(),netBuyUsd:150,
  pulse:{lastBuyAt:NOW-20000,recentBuyerCount:1,recentNetBuyUsd:150},
  wallets:[{wallet:W,netBuyUsd:150,lastBuyAt:NOW-20000}]}});
const row=(i=input())=>({input:i,decisions:[{decision:'观察',evidence:{safety:{blocked:[]}}}]});
test('new observed buy schedules research without inventing verification or eligibility',()=>{
  const i=input(),before=structuredClone(i),hint=walletBuyResearchHint(i,NOW);
  assert.equal(hint.researchOnly,true);assert.equal(hint.ageMs,20000);assert.equal(hint.recentBuyerCount,1);
  assert.deepEqual(i,before);assert.deepEqual(walletBuyResearchHint(i,NOW),hint,'same snapshot has stable identity');
  i.flow.provider='binance_smartmoney';assert.ok(walletBuyResearchHint(i,NOW));
  i.flow.provider='binance_kol';assert.ok(walletBuyResearchHint(i,NOW));
});
test('sells, transfers, stale/future/conflicting pages and wrong identities do not trigger',()=>{
  const mutations=[i=>i.memeExitMode=false,i=>i.flow.address=OTHER,i=>i.flow.chain='base',i=>i.flow.provider='untrusted',
    i=>i.flow.complete=false,i=>i.flow.fresh=false,i=>i.flow.coverageGap='gap',i=>i.flow.netBuyUsd=-1,
    i=>i.flow.pulse.lastBuyAt=null,i=>i.flow.pulse.lastBuyAt=NOW-90001,i=>i.flow.pulse.lastBuyAt=NOW+1,
    i=>i.flow.pulse.recentNetBuyUsd=-10,i=>i.flow.pulse.recentBuyerCount=0,
    i=>i.flow.observedAt=new Date(NOW-120001).toISOString(),i=>i.flow.observedAt=new Date(NOW+1).toISOString(),
    i=>i.flow.wallets=[],i=>i.flow.wallets[0].netBuyUsd=-150,i=>i.flow.wallets[0].wallet='bad',
    i=>i.flow.wallets[0].lastBuyAt=NOW-21000];
  for(const mutate of mutations){const i=input();mutate(i);assert.equal(walletBuyResearchHint(i,NOW),null,mutate.toString());}
});
test('wallet buy preempts an unstarted ordinary chart seat but cannot bypass safety or ongoing work',()=>{
  const buy=row(),ordinary=row({memeExitMode:true,token:{chain:'bsc',address:OTHER,volume:1e9}});
  const before=structuredClone([buy,ordinary]),charts=new Map();
  const hot=planHotResearch([ordinary,buy],['bsc'],charts,NOW,[`bsc:${OTHER}`]);
  assert.equal(hot[0],buy);assert.deepEqual([buy,ordinary],before);
  const params={holdings:[],hot,broad:[buy,ordinary],charts,nowMs:NOW,dispatch:0,chains:['bsc']};
  const target=selectResearchChart(params);assert.equal(target.address,CA);assert.equal(target.researchLane,'wallet');
  assert.equal(target.walletTrigger.researchOnly,true);
  assert.equal(selectResearchChart({...params,dispatch:2}).address,OTHER,'discovery keeps its slot');
  assert.equal(selectResearchChart({...params,holdings:[{chain:'bsc',address:OTHER,holdingTier:'main',requiresStructureChart:true}]}).address,OTHER);
  assert.equal(selectResearchChart({...params,focus:ordinary.input.token}).address,OTHER,'admitted entry focus wins');
  assert.notEqual(selectResearchChart({...params,pendingKeys:new Set([`bsc:${CA}`])})?.address,CA);
  charts.set(`bsc:${CA}`,{status:'unavailable',fetchedAt:NOW});
  assert.notEqual(selectResearchChart(params)?.address,CA,'failed fetch keeps its cache backoff');
  buy.decisions[0].evidence.safety.blocked=['honeypot'];
  assert.equal(planHotResearch([buy,ordinary],['bsc'],new Map(),NOW)[0],ordinary);
});
