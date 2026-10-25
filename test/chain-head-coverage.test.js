import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {projectChainHead,buildLaunchUpdateCoverage,createLaunchUpdateCoverageReader} from '../src/launch-update-coverage.js';

const now=Date.parse('2026-10-21T08:00:00Z'),iso=n=>new Date(n).toISOString(),hash='0x'+'a'.repeat(64);
function fixture(producer='fourmeme') {
  const cursor={nextBlock:90,anchorBlock:89,anchorBlockHash:hash,...(producer==='flap'?{afterLogIndex:-1}:{})};
  const state={initialized:true,chainId:56,identity:{chainId:56},cursor,updatedAt:iso(now-2000),checkedAt:iso(now-2000),_health:{status:'healthy',lastSuccessAt:iso(now-2000)}};
  const observation={version:'chain_head_observation_v1',displayOnly:true,producer,chainId:56,status:'verified',attemptedAt:iso(now-1000),completedAt:iso(now),errorCode:null,
    lastSuccess:{startedAt:iso(now-1000),verifiedAt:iso(now),cursorObservedAt:iso(now),cursor:structuredClone(cursor),headNumber:100,headHash:hash,blockTimestamp:now/1000-1,
      sourceIds:['a'.repeat(64),'b'.repeat(64)],sourceTips:[100,102],headSpread:2,confirmations:3,safeHead:97}};
  return {state,observation};
}
for(const producer of ['fourmeme','flap'])test(`${producer} lag uses last fully scanned block, distinguishes confirmation depth`,()=>{
  const {state,observation}=fixture(producer),before=JSON.stringify(state);
  const row=projectChainHead(observation,producer,state,now);
  assert.equal(row.liveHeadVerified,true);assert.equal(row.headLagBlocks,11);assert.equal(row.scanBacklogBlocks,8);
  assert.equal(row.observedHeadLagBlocks,11);assert.equal(row.observationNextBlock,90);assert.equal(row.headSpreadBlocks,2);
  state.cursor={...state.cursor,nextBlock:98,anchorBlock:97};
  const caught=projectChainHead(observation,producer,state,now);assert.equal(caught.headLagBlocks,3);assert.equal(caught.scanBacklogBlocks,0);
  const input=producer==='flap'?{flap:state,flapHead:observation}:{four:state,fourHead:observation};
  assert.equal(buildLaunchUpdateCoverage(input,now).platforms[producer].onchain.status,'verified_confirmed_head');
  assert.equal(JSON.stringify(fixture(producer).state),before);
});
test('Flap partially processed block remains unscanned; never uses anchor as completed height',()=>{
  const {state,observation}=fixture('flap');state.cursor={...state.cursor,anchorBlock:90,afterLogIndex:5};
  observation.lastSuccess.cursor=structuredClone(state.cursor);
  const row=projectChainHead(observation,'flap',state,now);assert.equal(row.headLagBlocks,11);assert.equal(row.scanBacklogBlocks,8);
});
test('cursor passing old head becomes unknown, not clamped to zero; retains labelled observation',()=>{
  const {state,observation}=fixture();state.cursor.nextBlock=103;state.cursor.anchorBlock=102;
  const row=projectChainHead(observation,'fourmeme',state,now);
  assert.equal(row.headVerificationStatus,'cursor_ahead_of_observation');assert.equal(row.headLagBlocks,null);assert.equal(row.liveHeadVerified,false);
  assert.equal(row.observedHeadLagBlocks,11);
  const flap=fixture('flap');flap.state.cursor={nextBlock:101,anchorBlock:101,anchorBlockHash:hash,afterLogIndex:3};
  assert.equal(projectChainHead(flap.observation,'flap',flap.state,now).headVerificationStatus,'cursor_ahead_of_observation');
  flap.observation.lastSuccess.cursor=structuredClone(flap.state.cursor);
  assert.equal(projectChainHead(flap.observation,'flap',flap.state,now).liveHeadVerified,false);
});
test('missing, malformed, single-source, wrong-chain, future and inconsistent evidence fails closed',()=>{
  const mutations=[o=>delete o.lastSuccess,o=>o.chainId=1,o=>o.displayOnly=false,o=>o.producer='flap',o=>o.version='future',
    o=>o.lastSuccess.sourceIds.pop(),o=>o.lastSuccess.sourceIds[1]=o.lastSuccess.sourceIds[0],o=>o.lastSuccess.sourceTips=[100],
    o=>o.lastSuccess.sourceTips[0]=101,o=>o.lastSuccess.headSpread=0,o=>o.lastSuccess.safeHead=100,o=>o.lastSuccess.headHash='bad',
    o=>o.lastSuccess.headNumber=-1,o=>o.lastSuccess.blockTimestamp=now/1000+1,o=>o.lastSuccess.startedAt=iso(now+1),
    o=>o.lastSuccess.verifiedAt=iso(now+1),o=>o.lastSuccess.cursorObservedAt=null,o=>o.lastSuccess.cursor.nextBlock=0];
  for(const mutate of mutations){const {state,observation}=fixture();mutate(observation);const row=projectChainHead(observation,'fourmeme',state,now);assert.equal(row.headLagBlocks,null);assert.equal(row.liveHeadVerified,false);}
});
test('fresh reread cannot rejuvenate old node head, slow proof, failed quorum or stale producer',()=>{
  for(const which of ['node','request','error','cursor']){
    const {state,observation}=fixture();
    if(which==='node')observation.lastSuccess.blockTimestamp=now/1000-121;
    if(which==='request')observation.lastSuccess.startedAt=iso(now-121000);
    if(which==='error')observation.status='error';
    if(which==='cursor')state.updatedAt=iso(now-121000);
    const row=projectChainHead(observation,'fourmeme',state,now);assert.equal(row.liveHeadVerified,false,which);assert.equal(row.headLagBlocks,null,which);
  }
});
test('reorg rewind, equal-height hash mismatch and invalid current cursor cannot claim catch-up',()=>{
  for(const which of ['rewind','anchor','head','chain','shape']){
    const {state,observation}=fixture();
    if(which==='rewind'){state.cursor.nextBlock=89;state.cursor.anchorBlock=88;}
    if(which==='anchor')state.cursor.anchorBlockHash='0x'+'c'.repeat(64);
    if(which==='head'){state.cursor={nextBlock:101,anchorBlock:100,anchorBlockHash:'0x'+'c'.repeat(64)};}
    if(which==='chain')state.chainId=1;
    if(which==='shape')state.cursor.anchorBlock=87;
    const row=projectChainHead(observation,'fourmeme',state,now);assert.equal(row.liveHeadVerified,false,which);assert.equal(row.headLagBlocks,null);
  }
});
test('real reader retains bounded head/cursor proof, isolates missing and corrupt sidecars',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'head-coverage-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const {state,observation}=fixture();
  for(const file of ['platform-capability-state.json','twitter-state.json','github-state.json','flap-quote-state.json'])await fs.writeFile(path.join(dir,file),'{}');
  await fs.writeFile(path.join(dir,'four-registry-state.json'),JSON.stringify(state));
  await fs.writeFile(path.join(dir,'four-chain-head-observation.json'),JSON.stringify(observation));
  let time=now;const read=createLaunchUpdateCoverageReader({dataDir:dir,now:()=>time});
  const a=await read();assert.deepEqual(a.readErrors,[]);assert.deepEqual(a.headReadErrors,['flapHead']);assert.equal(a.platforms.fourmeme.onchain.headLagBlocks,11);
  await fs.writeFile(path.join(dir,'four-chain-head-observation.json'),'secret broken');time+=15001;
  const b=await read();assert.equal(b.platforms.fourmeme.onchain.nextBlock,90);assert.equal(b.platforms.fourmeme.onchain.headLagBlocks,null);assert.doesNotMatch(JSON.stringify(b),/secret broken/);
  await fs.writeFile(path.join(dir,'four-chain-head-observation.json'),'x'.repeat(65537));time+=15001;
  assert.equal((await read()).readDiagnostics.fourHead.errorCode,'size_limit');
});
test('UI labels exact head age/snapshot and unknowns, does not render historical zero as current',async()=>{
  const app=await fs.readFile(new URL('../dashboard/app.js',import.meta.url),'utf8');
  const source=app.slice(app.indexOf('function chainHeadNotice('),app.indexOf('function renderStatus()'));
  const {state,observation}=fixture(),row=projectChainHead(observation,'fourmeme',state,now);
  const text=vm.runInNewContext(source+'\nchainHeadNotice(row,{now})',{row,now,clock:String});
  assert.match(text,/双源共同链头 100/);assert.match(text,/落后 11 块/);assert.match(text,/扣除 3 块确认深度后待扫 8 块/);
  state.cursor.nextBlock=105;state.cursor.anchorBlock=104;const advanced=projectChainHead(observation,'fourmeme',state,now);
  const unknown=vm.runInNewContext(source+'\nchainHeadNotice(row,{now})',{row:advanced,now,clock:String});
  assert.match(unknown,/当前落后块数未知/);assert.match(unknown,/上次核验快照/);assert.doesNotMatch(unknown,/落后 0 块/);
  for(const options of [{available:false,now},{now:now+121000},{now:now+20000,coverageCheckedAt:iso(now-110000)}]) {
    const stale=vm.runInNewContext(source+'\nchainHeadNotice(row,options)',{row,options,clock:String});
    assert.match(stale,/当前落后块数未知/);assert.doesNotMatch(stale,/相对该链头落后/);
  }
});
