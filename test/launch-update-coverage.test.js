import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { entryStatus } from '../dashboard/entry-status.js';
import { buildLaunchUpdateCoverage, createLaunchUpdateCoverageReader, readCoverageSnapshot } from '../src/launch-update-coverage.js';
import { createDashboardServer } from '../scripts/dashboard-server.js';

const now = Date.parse('2026-10-10T16:00:00Z');
const healthy = {status:'healthy',lastSuccessAt:new Date(now-1000).toISOString()};
test('website health cannot certify live chain head or an unread document body', () => {
  const r=buildLaunchUpdateCoverage({platform:{flap:{sourceHealth:{site:healthy}}},four:{updatedAt:healthy.lastSuccessAt,cursor:{nextBlock:100}}},now);
  assert.equal(r.platforms.flap.officialWeb.status,'fresh');
  assert.equal(r.platforms.flap.documentBodies.status,'partial');
  assert.ok(r.platforms.flap.documentBodies.uncheckedPages>0);
  assert.equal(r.platforms.fourmeme.onchain.status,'checkpoint_only_unverified');
  assert.equal(r.platforms.fourmeme.onchain.liveHeadVerified,false);
  assert.equal(r.status,'coverage_limited');
});
test('optional source failures, X limitations, old and future timestamps remain visible without raw errors',()=>{
  const r=buildLaunchUpdateCoverage({platform:{fourmeme:{sourceHealth:{optional:{...healthy,status:'error',optionalForHealth:true,lastError:'https://rpc.example/private-key'}}}},
    twitter:{_health:{fourdotmemezh:{...healthy,slaStatus:'source_limited'},flapdotsh:{...healthy,lastSuccessAt:new Date(now+60000).toISOString()}}},
    flap:{_health:{...healthy,status:'degraded',lastErrorCode:'FLAP_QUOTE_PORTAL_IDENTITY_UNAVAILABLE',lastError:'secret'},checkedAt:healthy.lastSuccessAt}},now);
  assert.equal(r.platforms.fourmeme.officialWeb.status,'partial');
  assert.equal(r.platforms.fourmeme.officialX.status,'source_limited');
  assert.equal(r.platforms.flap.officialX.status,'unverified');
  assert.equal(r.platforms.flap.onchain.lastErrorCode,'FLAP_QUOTE_PORTAL_IDENTITY_UNAVAILABLE');
  assert.doesNotMatch(JSON.stringify(r),/private-key|secret/);
  assert.equal(buildLaunchUpdateCoverage({twitter:{_health:{flapdotsh:{...healthy,lastSuccessAt:'2026-01-01'}}}},now).platforms.flap.officialX.status,'stale');
  assert.equal(buildLaunchUpdateCoverage({flap:{_health:{...healthy,lastErrorCode:'SECRET_KEY'}}},now).platforms.flap.onchain.lastErrorCode,null);
});
test('a later healthy success clears only a timestamped historical source error',()=>{
  const oldError={...healthy,lastError:'retained private diagnostic',lastErrorAt:new Date(now-60000).toISOString()};
  const r=buildLaunchUpdateCoverage({platform:{flap:{sourceHealth:{site:oldError}}},twitter:{_health:{flapdotsh:oldError}}},now);
  assert.equal(r.platforms.flap.officialWeb.status,'fresh');assert.equal(r.platforms.flap.officialWeb.fresh,1);
  assert.equal(r.platforms.flap.officialX.status,'fresh');assert.equal(r.platforms.flap.officialX.lastErrorAt,oldError.lastErrorAt);
  assert.doesNotMatch(JSON.stringify(r),/private diagnostic/);
  for(const status of ['error','degraded','failed','unavailable']){
    const row=buildLaunchUpdateCoverage({twitter:{_health:{flapdotsh:{...oldError,status}}}},now).platforms.flap.officialX;
    assert.equal(row.status,'degraded',status);
  }
});
test('newer, tied, unknown and future errors cannot be mistaken for recovery',()=>{
  const source={...healthy,lastError:'retained diagnostic'};
  for(const lastErrorAt of [new Date(now-500).toISOString(),healthy.lastSuccessAt,undefined,null,'invalid',new Date(now+1000).toISOString()]){
    const row=buildLaunchUpdateCoverage({twitter:{_health:{flapdotsh:{...source,lastErrorAt}}}},now).platforms.flap.officialX;
    assert.equal(row.status,'degraded',String(lastErrorAt));
  }
  const oldError={...source,lastErrorAt:new Date(now-60000).toISOString()};
  for(const lastSuccessAt of [undefined,null,'invalid',new Date(now+60000).toISOString()]){
    const row=buildLaunchUpdateCoverage({twitter:{_health:{flapdotsh:{...oldError,lastSuccessAt}}}},now).platforms.flap.officialX;
    assert.equal(row.status,'unverified',String(lastSuccessAt));
  }
  const nearFuture=buildLaunchUpdateCoverage({twitter:{_health:{flapdotsh:{...oldError,lastSuccessAt:new Date(now+1000).toISOString()}}}},now);
  assert.equal(nearFuture.platforms.flap.officialX.status,'degraded','future success within display skew tolerance cannot clear an error');
  const stale=buildLaunchUpdateCoverage({twitter:{_health:{flapdotsh:{...oldError,lastSuccessAt:new Date(now-121000).toISOString()}}}},now);
  assert.equal(stale.platforms.flap.officialX.status,'stale');
  const limited=buildLaunchUpdateCoverage({twitter:{_health:{flapdotsh:{...source,slaStatus:'source_limited',status:'error'}}}},now);
  assert.equal(limited.platforms.flap.officialX.status,'source_limited');
});
test('GitHub candidate repositories are not upgraded to verified sources; metadata is not commit freshness',()=>{
  const github={_repositories:{'flap-sh/example':{sourceTrust:'official_verified'},'flap-sh/candidate':{sourceTrust:'unverified_candidate'}},
    _health:{repositories:{'flap-sh/example':{...healthy,organizationPushGate:'pushed_at_unchanged',lastCommitReadAt:'2026-01-01T00:00:00Z'}}}};
  const g=buildLaunchUpdateCoverage({github},now).platforms.flap.github;
  assert.equal(g.repositoryCount,1);assert.equal(g.candidateRepositories,1);
  assert.equal(g.status,'partial');assert.equal(g.repositories[0].status,'metadata_only');
  assert.equal(g.repositories[0].observationBasis,'organization_metadata_unchanged');
  assert.equal(g.repositories[0].lastCommitReadAt,'2026-01-01T00:00:00.000Z');
});
test('fresh adapter and fresh repository alone never imply complete live coverage',()=>{
  const r=buildLaunchUpdateCoverage({flap:{_health:healthy},github:{_repositories:{'flap-sh/example':{sourceTrust:'official_verified'}},
    _health:{repositories:{'flap-sh/example':{...healthy,lastCommitReadAt:healthy.lastSuccessAt}}}}},now);
  assert.equal(r.platforms.flap.onchain.status,'adapter_observed_head_unverified');
  assert.equal(r.platforms.fourmeme.onchain.status,'unverified');
  assert.equal(r.platforms.flap.github.status,'partial');
  assert.equal(r.platforms.flap.github.repositories[0].status,'fresh');
  assert.equal(r.platforms.flap.github.organizations[0].status,'unverified');
});
test('reader is bounded, cached and tolerant of missing or malformed local snapshots',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'update-coverage-test-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let time=now;const read=createLaunchUpdateCoverageReader({dataDir:dir,now:()=>time});
  const a=await read();assert.equal(a.readErrors.length,5);
  assert.strictEqual(await read(),a);
  time+=15001;assert.notStrictEqual(await read(),a);
  await fs.writeFile(path.join(dir,'twitter-state.json'),'null');
  await fs.writeFile(path.join(dir,'flap-quote-state.json'),JSON.stringify({_health:healthy}));
  time+=15001;const b=await read();assert.ok(b.readErrors.includes('twitter'));
  assert.ok(!b.readErrors.includes('flap'));assert.equal(b.status,'degraded');
});
test('dashboard adds coverage without mutating or disabling ledger snapshot on reader failure',async t=>{
  const snapshot={mode:'paper',account:{cash:100},execution:false};let fail=false;
  const app=createDashboardServer({port:0,strategyRuntime:{snapshot:()=>snapshot},launchUpdateCoverage:async()=>{if(fail)throw Error('secret');return {status:'coverage_limited'};}});
  const address=await app.listen();t.after(()=>app.close());const base=`http://${address.address}:${address.port}`;
  const a=await(await fetch(base+'/api/strategy-state')).json();assert.equal(a.launchUpdateCoverage.status,'coverage_limited');
  assert.equal(snapshot.launchUpdateCoverage,undefined);
  fail=true;const b=await(await fetch(base+'/api/strategy-state')).json();assert.equal(b.account.cash,100);assert.equal(b.launchUpdateCoverage.status,'unavailable');
  assert.doesNotMatch(JSON.stringify(b),/secret/);
});
test('UI shows coverage without a trading policy and exposes pending document changes and source failures',async()=>{
  const app=await fs.readFile(new URL('../dashboard/app.js',import.meta.url),'utf8');
  const render=app.slice(app.indexOf('function chainHeadNotice('),app.indexOf('function renderAccount()'));
  const nodes={}, snapshot={status:'ok',updatedAt:new Date().toISOString(),launchUpdateCoverage:{checkedAt:null,readErrors:['four'],platforms:{flap:{officialX:{status:'source_limited'},officialWeb:{status:'partial'},documentBodies:{freshPages:2,allowedPages:3,uncheckedPages:1,pendingChanges:1},github:{status:'partial'},onchain:{status:'adapter_observed_head_unverified'}}}}};
  vm.runInNewContext(render+'\nrenderStatus();',{state:{status:'ok',snapshot},$:key=>nodes[key]||={dataset:{}},entryStatus,
    tradingDataHealth:()=>({status:'ok'}),clock:String,chainName:String,humanText:String,finite:n=>typeof n==='number'&&Number.isFinite(n)});
  assert.equal(nodes['#newPoolNotice'].hidden,false);
  assert.match(nodes['#newPoolNotice'].textContent,/覆盖（—）.*网站 部分覆盖.*1 项变更待核实.*链头未核实.*快照读取失败/);
});

const MIB = 1024 * 1024;
async function coverageDir(t) {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'four-panel-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  for(const name of ['platform-capability','twitter','github','flap-quote']) await fs.writeFile(path.join(dir,`${name}-state.json`),'{}');
  return dir;
}
test('Four checkpoint history over 8 MiB is read within its own bound, cached and refreshed',async t=>{
  const dir=await coverageDir(t),file=path.join(dir,'four-registry-state.json');
  const write=nextBlock=>fs.writeFile(file,JSON.stringify({cursor:{nextBlock},updatedAt:healthy.lastSuccessAt,checkpoints:[{privateDiagnostic:'not-for-panel',padding:'x'.repeat(9*MIB)}]}));
  await write(128900302);
  let time=now;const reader=createLaunchUpdateCoverageReader({dataDir:dir,now:()=>time});
  const [a,b]=await Promise.all([reader(),reader()]);assert.strictEqual(a,b);
  assert.deepEqual(a.readErrors,[]);assert.equal(a.readDiagnostics.four.maxBytes,32*MIB);
  assert.ok(a.readDiagnostics.four.bytes>8*MIB);
  assert.equal(a.platforms.fourmeme.onchain.nextBlock,128900302);
  assert.equal(a.platforms.fourmeme.onchain.checkpointAt,healthy.lastSuccessAt);
  assert.equal(a.platforms.fourmeme.onchain.liveHeadVerified,false);
  assert.equal(a.platforms.fourmeme.onchain.status,'checkpoint_only_unverified');
  assert.ok(JSON.stringify(a).length<20000);assert.doesNotMatch(JSON.stringify(a),/not-for-panel|padding/);
  await write(128900399);assert.strictEqual(await reader(),a);
  time+=15001;const c=await reader();assert.equal(c.platforms.fourmeme.onchain.nextBlock,128900399);
  assert.notStrictEqual(c,a);
});
test('Four remains capped at 32 MiB and other sources retain the 8 MiB cap',async t=>{
  const dir=await coverageDir(t),file=path.join(dir,'four-registry-state.json');
  const h=await fs.open(file,'w');await h.truncate(32*MIB+1);await h.close();
  await fs.writeFile(path.join(dir,'twitter-state.json'),JSON.stringify({padding:'x'.repeat(8*MIB)}));
  let time=now;const reader=createLaunchUpdateCoverageReader({dataDir:dir,now:()=>time});const a=await reader();
  assert.deepEqual(a.readErrors,['four','twitter']);
  assert.equal(a.readDiagnostics.four.errorCode,'size_limit');
  assert.equal(a.readDiagnostics.twitter.maxBytes,8*MIB);
  assert.equal(a.platforms.fourmeme.onchain.nextBlock,null);
  await fs.writeFile(file,JSON.stringify({cursor:{nextBlock:9},updatedAt:healthy.lastSuccessAt}));
  time+=15001;const b=await reader();assert.deepEqual(b.readErrors,['twitter']);
  assert.equal(b.readDiagnostics.four.status,'ok');assert.equal(b.platforms.fourmeme.onchain.nextBlock,9);
});
test('invalid complete JSON and non-object snapshots fail closed without raw content',async t=>{
  const dir=await coverageDir(t),file=path.join(dir,'four-registry-state.json');
  for(const [content,errorCode] of [['{"cursor":{"nextBlock":123},"private-secret":','invalid_json'],['null','invalid_state'],['[]','invalid_state'],['{} trailing-private-secret','invalid_json']]){
    await fs.writeFile(file,content);const a=await createLaunchUpdateCoverageReader({dataDir:dir})();
    assert.ok(a.readErrors.includes('four'));assert.equal(a.readDiagnostics.four.errorCode,errorCode);
    assert.equal(a.platforms.fourmeme.onchain.nextBlock,null);
    assert.doesNotMatch(JSON.stringify(a),/private-secret|four-panel-test/);
  }
  await fs.unlink(file);await fs.mkdir(file);
  const a=await createLaunchUpdateCoverageReader({dataDir:dir})();assert.equal(a.readDiagnostics.four.errorCode,'not_regular_file');
});
test('bounded reader pins the old inode across atomic path replacement',async t=>{
  const dir=await coverageDir(t),file=path.join(dir,'four-registry-state.json'),replacement=path.join(dir,'replacement.json');
  await fs.writeFile(file,JSON.stringify({cursor:{nextBlock:1}}));
  await fs.writeFile(replacement,JSON.stringify({cursor:{nextBlock:2}}));
  let reads=0,closed=false;
  const result=await readCoverageSnapshot(file,1024,{open:async (...args)=>{
    const fd=await fs.open(...args);
    return {stat:()=>fd.stat(),read:async (...readArgs)=>{if(!reads++)await fs.rename(replacement,file);return fd.read(...readArgs);},close:async()=>{closed=true;await fd.close();}};
  }});
  assert.equal(result.value.cursor.nextBlock,1);assert.equal(closed,true);
  assert.equal((await readCoverageSnapshot(file,1024)).value.cursor.nextBlock,2);
});
test('bounded reader rejects a FIFO without waiting for a writer', {skip:process.platform==='win32',timeout:3000}, async t=>{
  const dir=await coverageDir(t),file=path.join(dir,'four-registry-state.json');
  execFileSync('mkfifo',[file]);
  await assert.rejects(readCoverageSnapshot(file,1024),e=>e.diagnostic.errorCode==='not_regular_file');
});
test('bounded reader rejects in-place growth, truncation and same-size edits, always closes',async()=>{
  const raw=Buffer.from('{"a":1}');
  for(const change of ['growth','truncation','mtime','ctime']){
    let stats=0,closed=false;const info={isFile:()=>true,size:raw.length,mtimeMs:now,ctimeMs:now,nlink:1};
    const fd={stat:async()=>{if(!stats++)return info;return {...info,size:change==='growth'?raw.length+1:change==='truncation'?raw.length-1:raw.length,mtimeMs:now+(change==='mtime'?1:0),ctimeMs:now+(change==='ctime'?1:0)};},
      read:async(buffer,offset,length,position)=>{const data=change==='growth'?Buffer.concat([raw,Buffer.from(' ')]):change==='truncation'?raw.subarray(0,raw.length-1):raw;const n=Math.max(0,Math.min(length,data.length-position));data.copy(buffer,offset,position,position+n);return {bytesRead:n};},close:async()=>{closed=true;}};
    await assert.rejects(readCoverageSnapshot('unused',1024,{open:async()=>fd}),e=>e.diagnostic.errorCode==='snapshot_changed',change);
    assert.equal(closed,true,change);
  }
});
test('Four coverage through the real reader and HTTP route does not mutate paper safety or account',async t=>{
  const dir=await coverageDir(t);await fs.writeFile(path.join(dir,'four-registry-state.json'),JSON.stringify({cursor:{nextBlock:1234},updatedAt:healthy.lastSuccessAt,padding:'x'.repeat(9*MIB)}));
  const snapshot={mode:'paper',execution:false,signing:false,broadcast:false,account:{cash:100,trades:[{id:'unchanged'}]}};
  const before=JSON.stringify(snapshot),app=createDashboardServer({port:0,strategyRuntime:{snapshot:()=>snapshot},launchUpdateCoverage:createLaunchUpdateCoverageReader({dataDir:dir,now:()=>now})});
  const address=await app.listen();t.after(()=>app.close());const a=await(await fetch(`http://${address.address}:${address.port}/api/strategy-state`)).json();
  assert.deepEqual(a.launchUpdateCoverage.readErrors,[]);assert.equal(a.launchUpdateCoverage.platforms.fourmeme.onchain.nextBlock,1234);
  assert.equal(a.mode,'paper');for(const k of ['execution','signing','broadcast'])assert.equal(a[k],false);
  assert.equal(JSON.stringify(snapshot),before);
});
test('UI shows exact Four cursor and checkpoint, while a reader failure stays explicit',async()=>{
  const app=await fs.readFile(new URL('../dashboard/app.js',import.meta.url),'utf8');
  const render=app.slice(app.indexOf('function chainHeadNotice('),app.indexOf('function renderAccount()'));
  for(const failure of [false,true]){
    const nodes={},coverage=buildLaunchUpdateCoverage({four:failure?{}:{cursor:{nextBlock:128900302},updatedAt:healthy.lastSuccessAt}},now);
    if(failure){coverage.readErrors=['four'];coverage.readDiagnostics={four:{errorCode:'size_limit'}};}
    vm.runInNewContext(render+'\nrenderStatus();',{state:{status:'ok',snapshot:{launchUpdateCoverage:coverage}},$:key=>nodes[key]||={dataset:{}},entryStatus,tradingDataHealth:()=>({status:'ok'}),clock:String,chainName:String,humanText:String,finite:n=>typeof n==='number'&&Number.isFinite(n)});
    const text=nodes['#newPoolNotice'].textContent;
    if(failure){assert.match(text,/Four：文件超出读取上限/);assert.doesNotMatch(text,/128900302/);}
    else {assert.match(text,/Four\.meme.*仅本地检查点；下一区块 128900302；检查点 2026-10-10T15:59:59.000Z/);assert.doesNotMatch(text,/快照读取失败/);}
    assert.match(text,/不代表已追平链头/);
  }
  assert.equal(buildLaunchUpdateCoverage({four:{cursor:{nextBlock:-1},updatedAt:healthy.lastSuccessAt}},now).platforms.fourmeme.onchain.nextBlock,null);
});
