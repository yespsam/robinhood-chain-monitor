import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createTwitterNarrativeMonitor,TWITTER_NARRATIVE_TARGETS} from '../src/twitter-narrative-monitor.js';
import {renderNarrativeDesk} from '../dashboard/narrative-thesis.js';
const NOW=Date.parse('2026-09-26T08:00:00Z');
const statusId=(offset)=>String((BigInt(NOW-offset)-1288834974657n)<<22n);
function row(target,offset,extra={}) {return {id:statusId(offset),url:`https://x.com/${target.handle}/status/${statusId(offset)}`,
  created_timestamp:(NOW-offset)/1000,author:{id:target.id,screen_name:target.handle},text:'e/acc fees sent via Paid',replying_to:null,...extra};}
async function folder(t) {const d=await fs.mkdtemp(path.join(os.tmpdir(),'twitter-narrative-test-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;}
const sourceReader=async url=>{const [,author,,id]=new URL(url).pathname.split('/');
  return {status:'ok',author:author.toLowerCase(),url:url.toLowerCase(),text:'public post body',at:Number((BigInt(id)>>22n)+1288834974657n),observedAt:NOW,sourceVerifiedBy:'official_x_oembed'};};
test('independent X source needs no CA, GMGN call or wallet; replies and quotes are retained only for context research',async t=>{
  const dataDir=await folder(t),requests=[];
  const monitor=createTwitterNarrativeMonitor({dataDir,now:()=>NOW,sourceReader,fetchImpl:async url=>{
    requests.push(url);const target=TWITTER_NARRATIVE_TARGETS.find(x=>url.includes(x.id));
    return Response.json({code:200,results:[row(target,1000),row(target,2000,{replying_to:'XMoney'}),row(target,3000,{is_quote_status:true})]});}});
  const [a,b]=await Promise.all([monitor.runOnce(),monitor.runOnce()]);
  assert.equal(a.count,6);assert.equal(b.contextPending,4);assert.equal(a.documents.length,2);
  assert.equal(requests.length,2);assert.ok(requests.every(x=>x.startsWith('https://api.fxtwitter.com/')));
  assert.equal(a.execution,false);assert.equal(a.mode,'research_only');
  assert.equal(a.posts.some(p=>p.text.includes('CA')),false);
  const restored=createTwitterNarrativeMonitor({dataDir,now:()=>NOW,sourceReader,fetchImpl:async()=>Response.json({code:200,results:[]})});
  assert.equal((await restored.runOnce()).count,6);
  assert.match(renderNarrativeDesk({twitter:a}),/独立推特叙事源/);
  assert.match(renderNarrativeDesk({twitter:a}),/上下文待核实/);
  await monitor.stop();await restored.stop();
});
test('wrong identity, failed official verification and stale posts never become research evidence',async t=>{
  for(const mode of ['identity','verification','stale']){
    const monitor=createTwitterNarrativeMonitor({dataDir:await folder(t),now:()=>NOW,
      sourceReader:mode==='verification'?async()=>({status:'unavailable'}):sourceReader,
      fetchImpl:async url=>{const target=TWITTER_NARRATIVE_TARGETS.find(x=>url.includes(x.id));
        return Response.json({code:200,results:[row(target,mode==='stale'?2*86400000:1000,
          mode==='identity'?{author:{id:'1',screen_name:target.handle}}:{})]});}});
    const s=await monitor.runOnce();assert.equal(s.count,0);assert.equal(s.documents.length,0);
    if(mode==='identity')assert.ok(s.targets.every(t=>t.status==='error'));
    if(mode==='verification')assert.ok(s.targets.every(t=>t.status==='partial'));
    await monitor.stop();
  }
});
test('persistent failure backs off and old success is not a fresh feed',async t=>{
  let now=NOW,calls=0;
  const monitor=createTwitterNarrativeMonitor({dataDir:await folder(t),now:()=>now,sourceReader,
    fetchImpl:async()=>{calls++;throw new Error('offline');}});
  await monitor.runOnce();await monitor.runOnce();assert.equal(calls,2);
  assert.ok(monitor.snapshot().targets.every(t=>t.fresh===false&&t.status==='error'));
  now+=31000;await monitor.runOnce();assert.equal(calls,4);await monitor.stop();
});
