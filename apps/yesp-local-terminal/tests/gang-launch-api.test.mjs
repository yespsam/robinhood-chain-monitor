import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createLocalApp} from '../server/local-server.mjs';
import {createGangLaunchStrategy} from '../server/gang-launch-strategy.mjs';
import {emptyGangLaunch} from '../server/gang-launch-store.mjs';
const wallet='0x'+'1'.repeat(40),config={mode:'live',perTokenMaxBnb:'0.1',totalMaxBnb:'0.2',maxBuys:2,validForSeconds:3600,maxAgeSeconds:30,slippageBps:'1000',swapSlippageBps:'100'};
test('Gang API defaults inactive, requires CSRF and one-use arm, blocks conflicting wallet writes, and pauses explicitly',async()=>{
 let saved=emptyGangLaunch(),oldSniper=false;const calls=[],store={read:async()=>saved,save:async s=>{saved=structuredClone(s);}},gangLaunch=createGangLaunchStrategy({store,gateway:{wallet:async()=>({connected:true,address:wallet})},source:{baseline:async()=>({number:100,time:Date.now()})}});gangLaunch.start=()=>{};
 let sourceRefreshes=0;
 const scanner={state:()=>({rows:[]}),start(){},stop(){},subscribe(){}},sniper={state:()=>({jobs:oldSniper?[{state:'ARMED'}]:[]}),start(){},stop(){},subscribe(){},init(){}},modes={state:()=>({modes:[],reports:[],sources:[]}),start(){},stop(){},subscribe(){},init(){},async refresh(){},async refreshSources(force){assert.equal(force,true);sourceRefreshes++;}};
 const app=createLocalApp({cli:{},rpc(){},scanner,sniper,modes,gangLaunch,trader:{handle:async m=>{calls.push(m);return {wallet:{connected:false}};}},auth:{close(){}},transfer:{},gmgn:{},charts:{}}),origin=await app.listen(0);
 try{const {csrf}=await(await fetch(origin+'/api/session')).json(),post=async(method,params={},headers={},id=randomUUID())=>{const res=await fetch(origin+'/api/request',{method:'POST',headers:{origin,'x-yesp-csrf':csrf,'content-type':'application/json',...headers},body:JSON.stringify({id,method,params})});return {status:res.status,...await res.json()};};
  assert.equal((await post('gangLaunchStatus')).data.gangLaunch.active,false);assert.equal((await fetch(origin+'/gang-launch-ui.js')).status,200);assert.equal((await fetch(origin+'/.private/gang-launch/state.json')).status,404);
  assert.equal((await post('modeRefresh',{}, {'x-yesp-csrf':''})).status,403);assert.equal(sourceRefreshes,0);assert.equal((await post('modeRefresh')).ok,true);assert.equal(sourceRefreshes,1);assert.equal(saved.run,null);assert.equal(calls.length,0);
  assert.equal((await post('gangLaunchDraft',config,{'x-yesp-csrf':''})).status,403);assert.equal((await post('gangLaunchDraft',config,{origin:'https://evil.test'})).status,403);assert.equal(saved.run,null);
  const d=(await post('gangLaunchDraft',config)).data.gangLaunchDraft;assert.equal(saved.run,null);oldSniper=true;assert.equal((await post('gangLaunchArm',{draftId:d.draftId})).error.code,'SNIPE_ACTIVE');oldSniper=false;
  const id=randomUUID();assert.equal((await post('gangLaunchArm',{draftId:d.draftId},{},id)).ok,true);assert.equal((await post('gangLaunchArm',{draftId:d.draftId},{},id)).error.code,'REQUEST_ID_REUSED');
  for(const method of ['panelTrade','panelPrepare','panelExecute','transferPrepare','transfer','sniperArm']){const result=await post(method,{});assert.equal(result.error.code,'GANG_STRATEGY_ACTIVE');assert.equal(result.submissionNotStarted,true);}assert.equal(calls.length,0);
  assert.equal((await post('gangLaunchPause',{buysOnly:'true'})).error.code,'INVALID_REQUEST');assert.equal((await post('gangLaunchPause',{buysOnly:false})).data.gangLaunch.active,false);
 }finally{await app.close();}
});
