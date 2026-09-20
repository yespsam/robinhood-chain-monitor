import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createGeniusMonitor, parseGeniusDocument, GENIUS_DOCUMENTS, GENIUS_X_ACCOUNTS,
  geniusDocumentChanges, classifyGeniusAnnouncement, validateGeniusState, parseGeniusOembed } from "../src/genius-monitor.js";
import { GENIUS_FACTORY, GENIUS_FACTORY_CODE_HASH, GENIUS_START_BLOCK } from "../src/genius-chain-reader.js";
import { isStrictGeniusEvent, geniusDocumentChangesHash } from "../src/genius-source-policy.js";

const OWNER = "0xe7c7b7ee71db0f1b4f0ff25d7cec191268e7fd98";
const TOKEN = `0x${"a".repeat(40)}`, CURVE = `0x${"b".repeat(40)}`, COMMUNITY = `0x${"c".repeat(40)}`;
const TX = `0x${"d".repeat(64)}`;
const hash = n => `0x${BigInt(n).toString(16).padStart(64,"0")}`;
const initialTime = Date.parse("2026-09-18T08:00:00Z");
const providers = ["https://first.example", "https://second.test"];
const manifest = () => ({ schemaVersion: "1.0", environment: "prod", chainId: 56,
  release: { name: "prod-foundation-20260916" }, stacks: [{ stackId: "bnb-mainnet-m4.1", startBlock: GENIUS_START_BLOCK,
    contracts: { factory: { address: GENIUS_FACTORY, bytecodeHash: GENIUS_FACTORY_CODE_HASH } } }], initialConfig: { launchFee: "2000" } });
const html = extra => `<html><head><title>About - Genius.fun</title><link rel="canonical" href="https://genius.fun/about"></head><body><h1>Genius.fun</h1><p>${"Official launchpad deployment contract configuration and foundation mechanics. ".repeat(6)}</p><p>${extra}</p></body></html>`;
function tweet(account, id = "2100804510381936714", text = "Introducing genius.fun official testing.") {
  return { type: "status", id, url: `https://x.com/${account.handle}/status/${id}`, text,
    raw_text: { text }, author: { id: account.userId, screen_name: account.handle }, created_timestamp: initialTime / 1000,
    replying_to: null, reposted_by: null };
}
function log(name, args, blockNumber, logIndex = 0, time = initialTime) {
  return { name, args, blockNumber, blockHash: hash(blockNumber), blockTimestamp: Math.floor(time / 1000),
    transactionHash: TX, logIndex, address: GENIUS_FACTORY };
}
async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "genius-monitor-test-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const f = { dataDir, time: initialTime, manifest: manifest(), extra: "Existing terms.", emitted: [], requests: [], failDelivery: false,
    head: GENIUS_START_BLOCK + 600, events: [], brokenAnchor: false, failChain: false, tokenRecords: {},
    timelines: Object.fromEntries(GENIUS_X_ACCOUNTS.map(a => [a.userId, [tweet(a)]])), responses: new Map(), ...options };
  const chainReader = {
    head: async () => { if (f.failChain) throw Object.assign(new Error("factory identity mismatch"), { code: "GENIUS_FACTORY_IDENTITY" });
      return { number: f.head, hash: hash(f.head), timestamp: Math.floor(f.time/1000), providers }; },
    readRange: async (fromBlock,toBlock) => ({ fromBlock,toBlock, providers,
      anchor: { number: toBlock, hash: f.brokenAnchor && fromBlock === toBlock ? hash(1) : hash(toBlock), timestamp: Math.floor(f.time/1000) },
      events: f.events.filter(e => e.blockNumber >= fromBlock && e.blockNumber <= toBlock) }),
    readToken: async address => { if (!f.tokenRecords[address]) throw new Error("token lookup temporarily unavailable"); return f.tokenRecords[address]; },
  };
  const fetchImpl = async url => {
    f.requests.push(url);
    if (f.responses.has(url)) return f.responses.get(url)();
    if (url === GENIUS_DOCUMENTS[0].url) return new Response(JSON.stringify(f.manifest), { headers: { "content-type": "application/json", etag: '"manifest"' } });
    if (GENIUS_DOCUMENTS.some(s => s.url === url)) return new Response(html(f.extra), { headers: { "content-type": "text/html" } });
    if (url.includes("api.fxtwitter.com")) {
      const user = /id:(\d+)/.exec(url)[1]; return Response.json({ code: 200, results: f.timelines[user] });
    }
    if (url.startsWith("https://publish.x.com/oembed")) {
      const status = new URL(url).searchParams.get("url");
      const t = Object.values(f.timelines).flat().find(t => t.url === status);
      return Response.json({ author_url: `https://x.com/${t.author.screen_name}`, url: status,
        html: `<blockquote><p>${t.text}</p><a href="${status}">date</a></blockquote>` });
    }
    throw new Error(`Unexpected fixture URL ${url}`);
  };
  const config = { dataDir, geniusMonitorEnabled: true, geniusBlockRange: 512 };
  const deps = { chainReader, fetchImpl, now: () => f.time, autoStart: false, logger: { error() {} },
    sendAlertsImpl: async (_c,event) => { assert.equal(isStrictGeniusEvent(event), true, JSON.stringify(event));
      if (f.failDelivery) return { status: "failed" }; f.emitted.push(event); return { status: "queued", persisted: true }; } };
  f.monitor = createGeniusMonitor(config,deps);
  f.restart = () => createGeniusMonitor(config,deps);
  f.check = () => f.monitor.check({ force: true });
  return f;
}

test("Genius document parser accepts official schema and rejects wrong chain/login pages", () => {
  assert.equal(parseGeniusDocument(GENIUS_DOCUMENTS[0],JSON.stringify(manifest())).chainId,56);
  assert.throws(() => parseGeniusDocument(GENIUS_DOCUMENTS[0],JSON.stringify({...manifest(),chainId:1})),/SCHEMA/);
  assert.throws(() => parseGeniusDocument(GENIUS_DOCUMENTS[1],"<title>Login</title>"),/IDENTITY/);
  assert.deepEqual(parseGeniusDocument(GENIUS_DOCUMENTS[1],html("unchanged")+'<script nonce="x">Date.now()</script>'), parseGeniusDocument(GENIUS_DOCUMENTS[1],html("unchanged")));
});
test("full manifest diff finds late quote changes and stable order avoids false deltas", () => {
  const a = { pairTokens: Array.from({length:465},(_,id)=>({id,enabled:true})) }, b = structuredClone(a);
  b.pairTokens[464].enabled = false;
  assert.deepEqual(geniusDocumentChanges(a,b),[{field:"pairTokens.464.enabled",before:true,after:false}]);
  assert.deepEqual(geniusDocumentChanges({a:1,b:2},{b:2,a:1}),[]);
});
test("both fixed official accounts are included; denial/test words never assert official issuance", () => {
  const v = classifyGeniusAnnouncement(`We are not affiliated with this test token ${TOKEN}`,"GeniusTerminal");
  assert.equal(v.disclaimsAffiliation,true); assert.equal(v.mentionsTesting,true);
  assert.deepEqual(v.addresses,[TOKEN]); assert.equal(v.officialTestToken,undefined);
  assert.equal(classifyGeniusAnnouncement("An unrelated original update.","GeniusTerminal").related,true);
  assert.equal(classifyGeniusAnnouncement("test token", "impostor").related,false);
});
test("first read silently baselines documents and X; chain keeps independent historical/live cursors",async t=>{
  const f=await fixture(t); await f.check(); const s=f.monitor.state();
  assert.equal(f.emitted.length,0); assert.equal(s.chain.realtimeNextBlock,f.head+1);
  assert.equal(s.chain.historicalNextBlock,GENIUS_START_BLOCK+512); assert.equal(s.chain.historyComplete,false);
  assert.equal(s.sources.genius_x_terminal.initialized,true); validateGeniusState(s);
  await f.check(); assert.equal(f.monitor.state().chain.historyComplete,true);
});
test("document update uses exact source gate and no duplicate after restart",async t=>{
  const f=await fixture(t); await f.check(); f.manifest.initialConfig.launchFee="3000";
  await f.check(); assert.equal(f.emitted.length,1);
  assert.equal(f.emitted[0].changes[0].after,"3000");
  f.monitor=f.restart(); await f.check(); assert.equal(f.emitted.length,1);
});
test("one document transition retains every change in one complete event",async t=>{
  const f=await fixture(t); await f.check(); f.manifest.initialConfig={a:1,b:2,c:3,d:4,e:5};
  await f.check(); assert.equal(f.emitted.length,1);
  const event=f.emitted[0];
  assert.equal(event.partIndex,undefined); assert.equal(event.aggregation,"complete_transition");
  assert.equal(event.changes.length,6); assert.equal(event.changeCount,6);
  assert.equal(event.evidence.changesHash,geniusDocumentChangesHash(event.changes));
  assert.equal(event.eventKey,`genius:genius_manifest:${event.evidence.beforeHash}:${event.evidence.afterHash}`);
  assert.equal(event.sourceOccurredAt,new Date(f.time).toISOString());
});
test("failed delivery retains baseline and durable reservation for restart",async t=>{
  const f=await fixture(t); await f.check(); const old=f.monitor.state().sources.genius_manifest.hash;
  f.manifest.initialConfig.launchFee="4000"; f.failDelivery=true; await f.check();
  assert.equal(f.monitor.state().sources.genius_manifest.hash,old); assert.equal(f.monitor.state().pendingEvents.length,1);
  f.failDelivery=false; f.monitor=f.restart(); await f.check();
  assert.equal(f.monitor.state().pendingEvents.length,0); assert.equal(f.emitted.length,1);
});
test("HTTP Retry-After survives restart and skips source until due",async t=>{
  const f=await fixture(t); f.responses.set(GENIUS_DOCUMENTS[0].url,()=>new Response("limited",{status:429,headers:{"retry-after":"300"}}));
  await f.check(); const count=f.requests.filter(u=>u===GENIUS_DOCUMENTS[0].url).length;
  f.monitor=f.restart(); await f.monitor.check();
  assert.equal(f.requests.filter(u=>u===GENIUS_DOCUMENTS[0].url).length,count);
  assert.equal(Date.parse(f.monitor.state().health.sources.genius_manifest.nextAttemptAt)-f.time,300000);
});
test("304 cannot initialize a missing baseline and oversized response is rejected",async t=>{
  const f=await fixture(t); f.responses.set(GENIUS_DOCUMENTS[0].url,()=>new Response(null,{status:304})); await f.check();
  assert.equal(f.monitor.state().sources.genius_manifest.initialized,false);
  f.responses.set(GENIUS_DOCUMENTS[0].url,()=>new Response("{}",{headers:{"content-type":"application/json","content-length":"2000000"}})); await f.check();
  assert.match(f.monitor.state().health.sources.genius_manifest.lastError,/TOO_LARGE/);
});
test("X numeric identity plus original oEmbed content catches denial and exact CA",async t=>{
  const f=await fixture(t); await f.check(); const a=GENIUS_X_ACCOUNTS[0];
  f.timelines[a.userId].unshift(tweet(a,"2100804510381936715",`We are not affiliated with TEST ${TOKEN}`));
  await f.check(); assert.equal(f.emitted.length,1);
  assert.equal(f.emitted[0].disclaimsAffiliation,true); assert.deepEqual(f.emitted[0].mentionedAddresses,[TOKEN]);
  assert.equal(f.monitor.state().mentionedTokens[TOKEN].classification,"officially_disclaimed");
});
test("X continuity gap does not advance unseen durable cursor or duplicate known new posts",async t=>{
  const f=await fixture(t); await f.check(); const a=GENIUS_X_ACCOUNTS[0]; const old=f.monitor.state().sources[a.key].cursor;
  f.timelines[a.userId]=[tweet(a,"2100804510381936719")]; await f.check(); await f.check();
  assert.equal(f.monitor.state().sources[a.key].cursor,old); assert.equal(f.emitted.length,1);
  assert.match(f.monitor.state().sources[a.key].continuityGap,/durable_cursor/);
});
test("impostor numeric ID is rejected and cannot create X baseline",async t=>{
  const f=await fixture(t); f.timelines[GENIUS_X_ACCOUNTS[0].userId][0].author.id="999"; await f.check();
  assert.equal(f.monitor.state().sources.genius_x_terminal.initialized,false);
});
test("official-role launch is delivered, normal community launch is not",async t=>{
  const f=await fixture(t); await f.check(); f.head+=1;
  f.events=[log("TokenLaunched",{token:TOKEN,curve:CURVE,deployer:OWNER,pairToken:COMMUNITY,launchConfigId:"0",graduationThreshold:"15"},f.head),
    log("TokenLaunched",{token:COMMUNITY,curve:CURVE,deployer:COMMUNITY,pairToken:TOKEN,launchConfigId:"0",graduationThreshold:"15"},f.head,1)];
  await f.check(); assert.equal(f.emitted.length,1); assert.equal(f.emitted[0].kind,"official_token_launch");
  assert.equal(f.monitor.state().officialTokens[COMMUNITY],undefined);
});
test("unknown live lifecycle is durable until independent launch identity is available",async t=>{
  const f=await fixture(t); await f.check(); f.head+=1;
  f.events=[log("PoolGraduated",{token:TOKEN,positionId:"10",tokenAmount:"50",pairTokenAmount:"20"},f.head)];
  await f.check(); assert.equal(f.monitor.state().unresolvedTokenEvents.length,1); assert.equal(f.emitted.length,0);
  f.monitor=f.restart(); f.tokenRecords[TOKEN]={exists:true,token:TOKEN,curve:CURVE,deployer:OWNER};
  await f.check(); assert.equal(f.monitor.state().unresolvedTokenEvents.length,0);
  assert.equal(f.emitted[0].kind,"official_token_lifecycle");
});
test("historical discovery never rewrites a newer official token lifecycle",async t=>{
  const f=await fixture(t); f.events=[log("TokenLaunched",{token:TOKEN,curve:CURVE,deployer:OWNER,pairToken:COMMUNITY,launchConfigId:"0",graduationThreshold:"15"},GENIUS_START_BLOCK+20)];
  await f.check(); f.head+=1; f.events.push(log("PoolGraduated",{token:TOKEN,positionId:"1",tokenAmount:"2",pairTokenAmount:"3"},f.head));
  await f.check(); assert.equal(f.monitor.state().officialTokens[TOKEN].lastEvent.name,"PoolGraduated"); assert.equal(f.emitted.length,1);
});
test("delayed identity resolution never delivers an orphaned lifecycle event",async t=>{
  const f=await fixture(t); await f.check(); f.head+=1;
  f.events=[log("PoolGraduated",{token:TOKEN,positionId:"10",tokenAmount:"50",pairTokenAmount:"20"},f.head)];
  await f.check(); assert.equal(f.monitor.state().unresolvedTokenEvents.length,1);
  f.events=[]; f.tokenRecords[TOKEN]={exists:true,token:TOKEN,curve:CURVE,deployer:OWNER}; f.monitor=f.restart();
  await f.check(); assert.equal(f.emitted.length,0);
  assert.equal(f.monitor.state().unresolvedTokenEvents.length,1);
  assert.equal(f.monitor.state().tokenResolutionFailures[TOKEN].lastErrorCode,"GENIUS_REORG");
});
test("reserved chain delivery is revalidated after restart and does not bypass backoff",async t=>{
  const f=await fixture(t); await f.check(); f.head+=1; f.failDelivery=true;
  f.events=[log("TokenLaunched",{token:TOKEN,curve:CURVE,deployer:OWNER,pairToken:COMMUNITY,launchConfigId:"0",graduationThreshold:"15"},f.head)];
  await f.check(); assert.equal(f.monitor.state().pendingEvents.length,1);
  f.failDelivery=false; f.events=[]; f.monitor=f.restart(); await f.check();
  assert.equal(f.emitted.length,0); assert.equal(f.monitor.state().pendingEvents.length,1);
  assert.equal(f.monitor.state().health.sources.genius_chain.lastErrorCode,"GENIUS_REORG");
  const attempts=f.monitor.state().health.sources.genius_chain.consecutiveFailures;
  await f.monitor.check();
  assert.equal(f.monitor.state().health.sources.genius_chain.consecutiveFailures,attempts);
});
test("canonical anchor mismatch retains both cursors and reports precise error",async t=>{
  const f=await fixture(t); await f.check(); const before=f.monitor.state().chain; f.head+=5; f.brokenAnchor=true;
  await f.check(); assert.equal(f.monitor.state().chain.realtimeNextBlock,before.realtimeNextBlock);
  assert.equal(f.monitor.state().health.sources.genius_chain.lastErrorCode,"GENIUS_CANONICAL_ANCHOR_CHANGED");
});
test("chain integrity error is not swallowed as healthy",async t=>{
  const f=await fixture(t); f.failChain=true; await f.check();
  assert.equal(f.monitor.state().health.sources.genius_chain.lastErrorCode,"GENIUS_FACTORY_IDENTITY");
  assert.equal(f.monitor.state().health.status,"degraded");
});
test("concurrent check calls are single-flight and stop prevents new scheduling",async t=>{
  const f=await fixture(t); const first=f.check(); assert.equal(f.check(),first); await first;
  assert.equal(f.requests.filter(u=>u===GENIUS_DOCUMENTS[0].url).length,1);
  await f.monitor.stop(); assert.equal((await f.check()).status,"stopped");
});
test("invalid existing state is not reset to a fresh baseline",async t=>{
  const f=await fixture(t); await fs.writeFile(path.join(f.dataDir,"genius-state.json"),"{bad");
  await assert.rejects(f.check()); assert.equal(f.requests.length,0);
});
test("complete observed transitions survive failed delivery and a remote revert",async t=>{
  const f=await fixture(t); await f.check(); const original=structuredClone(f.manifest);
  for(let n=0;n<6;n++) f.manifest.initialConfig[`feature${n}`]=n;
  f.failDelivery=true; await f.check(); assert.equal(f.monitor.state().pendingEvents.length,1);
  f.manifest=original; f.failDelivery=false; f.monitor=f.restart(); await f.check();
  const changed=f.emitted.flatMap(e=>e.changes);
  assert.equal(f.emitted.length,2); assert.equal(changed.length,12);
  for(let n=0;n<6;n++) assert.equal(changed.filter(c=>c.field===`initialConfig.feature${n}`).length,2);
  assert.equal(f.monitor.state().sources.genius_manifest.pendingObservation,undefined);
});
test("one deleted X post cannot prevent newer authenticated posts from being delivered",async t=>{
  const f=await fixture(t); await f.check(); const a=GENIUS_X_ACCOUNTS[0];
  const deleted=tweet(a,"2100804510381936715"), valid=tweet(a,"2100804510381936716");
  f.timelines[a.userId].push(deleted,valid);
  const url=`https://publish.x.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(deleted.url)}`;
  f.responses.set(url,()=>new Response("deleted",{status:404})); await f.check();
  assert.equal(f.emitted.length,1); assert.equal(f.emitted[0].tweet.id,valid.id);
  assert.match(f.monitor.state().sources[a.key].continuityGap,/verification/);
});
test("full unknown-token queue drains before more admission, and one bad lookup does not starve the next",async t=>{
  const f=await fixture(t); await f.check(); const s=f.monitor.state();
  s.unresolvedTokenEvents=Array.from({length:5000},(_,i)=>{
    const item=log("LaunchSwept",{token:i===0?COMMUNITY:TOKEN,quoteOut:"1",tokenOut:"2"},f.head,i);
    return {key:`${TX}:${i}:${item.blockHash}`,lane:"historical",log:item,providers};
  });
  await fs.writeFile(path.join(f.dataDir,"genius-state.json"),JSON.stringify(s));
  f.monitor=f.restart(); f.tokenRecords[TOKEN]={exists:true,token:TOKEN,curve:CURVE,deployer:COMMUNITY}; await f.check();
  assert.equal(f.monitor.state().unresolvedTokenEvents.length,1);
  assert.equal(f.monitor.state().unresolvedTokenEvents[0].log.args.token,COMMUNITY);
  assert.equal(f.emitted.length,0);
});
test("corrupted durable pending events fail closed before contacting sources",async t=>{
  const f=await fixture(t); await f.check(); const s=f.monitor.state(); s.pendingEvents=[{eventKey:"genius:forged"}];
  await fs.writeFile(path.join(f.dataDir,"genius-state.json"),JSON.stringify(s)); f.requests=[]; f.monitor=f.restart();
  await assert.rejects(f.check(),/DURABLE_EVENT_STATE/); assert.equal(f.requests.length,0);
});
test("official media-only posts retain their link without inventing image contents",()=>{
  const a=GENIUS_X_ACCOUNTS[0], id="2100804550445965628",url=`https://x.com/${a.handle}/status/${id}`;
  const body={author_url:`https://x.com/${a.handle}`,url,
    html:`<blockquote><p><a href="https://t.co/abc">pic.twitter.com/abc</a></p><a href="${url}">date</a></blockquote>`};
  assert.deepEqual(parseGeniusOembed(body,a.handle,id),{text:"pic.twitter.com/abc",mediaOnly:true});
  assert.throws(()=>parseGeniusOembed({...body,author_url:"https://x.com/impostor"},a.handle,id),/identity/);
});

test("technical-only manifest updates advance baseline without delivery or later replay",async t=>{
  const f=await fixture(t); f.manifest.release.commit="old"; f.manifest.build={hash:"old"}; await f.check();
  const oldHash=f.monitor.state().sources.genius_manifest.hash;
  f.manifest.release.commit="new"; f.manifest.build={hash:"new"};
  f.manifest.stacks[0].contracts.factory.bytecodeHash=hash(2);
  await f.check(); assert.equal(f.emitted.length,0);
  const advanced=f.monitor.state().sources.genius_manifest.hash;
  assert.notEqual(advanced,oldHash); assert.equal(f.monitor.state().pendingEvents.length,0);
  f.monitor=f.restart(); await f.check(); assert.equal(f.emitted.length,0);
  f.manifest.initialConfig.launchFee="7000"; await f.check();
  assert.equal(f.emitted.length,1); assert.equal(f.emitted[0].evidence.beforeHash,advanced);
  assert.deepEqual(f.emitted[0].changes,[{field:"initialConfig.launchFee",before:"2000",after:"7000"}]);
});

test("new deployment, fees and permissions remain complete evidence without adopting a new chain pin",async t=>{
  const f=await fixture(t); await f.check();
  f.manifest.release.name="prod-4.2";
  f.manifest.initialConfig.launchFee="9000";
  f.manifest.initialConfig.launchEnabled=false;
  f.manifest.stacks.push({stackId:"bnb-mainnet-m4.2",startBlock:GENIUS_START_BLOCK+100,
    contracts:{factory:{address:TOKEN,bytecodeHash:hash(55)}},permissions:{owner:CURVE}});
  await f.check(); assert.equal(f.emitted.length,1);
  const event=f.emitted[0]; assert.equal(event.changes.length,4);
  assert.equal(event.changes.find(c=>c.field==="stacks.bnb-mainnet-m4.2").after.contracts.factory.address,TOKEN);
  assert.equal(event.changes.find(c=>c.field==="initialConfig.launchEnabled").after,false);
  assert.equal(event.changes.find(c=>c.field==="release.name").after,"prod-4.2");
  assert.equal(f.monitor.state().identity.factory,GENIUS_FACTORY);
  assert.equal(f.monitor.state().identity.factoryCodeHash,GENIUS_FACTORY_CODE_HASH);
});

function oldDocumentParts(event) {
  const { aggregation, ...legacy }=event;
  delete legacy.evidence.changesHash;
  return Array.from({length:Math.ceil(event.changes.length/2)},(_,partIndex)=>({...legacy,
    eventKey:`${event.eventKey}:${partIndex}`,partIndex,changes:event.changes.slice(partIndex*2,partIndex*2+2)}));
}

test("upgrade delivers only outstanding legacy parts with their original keys and source times",async t=>{
  const f=await fixture(t); await f.check();
  for(let n=0;n<6;n++) f.manifest.initialConfig[`feature${n}`]=n;
  f.failDelivery=true; await f.check(); const s=f.monitor.state();
  const parts=oldDocumentParts(s.pendingEvents[0]);
  s.sources.genius_manifest.pendingObservation.events=parts;
  s.processedEvents[parts[0].eventKey]=new Date(f.time).toISOString();
  s.pendingEvents=parts.slice(1); validateGeniusState(s);
  await fs.writeFile(path.join(f.dataDir,"genius-state.json"),JSON.stringify(s));
  f.time+=60000; f.failDelivery=false; f.monitor=f.restart(); await f.check();
  assert.deepEqual(f.emitted.map(e=>e.eventKey),parts.slice(1).map(e=>e.eventKey));
  assert.ok(f.emitted.every(e=>e.sourceOccurredAt===parts[0].sourceOccurredAt));
  assert.equal(f.monitor.state().pendingEvents.length,0);
  f.monitor=f.restart(); await f.check(); assert.equal(f.emitted.length,2);
});

test("upgrade does not replay nine processed legacy cards under a new aggregate key",async t=>{
  const f=await fixture(t); await f.check(); f.manifest.initialConfig.launchFee="3000";
  for(let n=0;n<17;n++) f.manifest.initialConfig[`feature${n}`]=n;
  f.failDelivery=true; await f.check(); const s=f.monitor.state();
  const parts=oldDocumentParts(s.pendingEvents[0]); assert.equal(parts.length,9);
  s.sources.genius_manifest.pendingObservation.events=parts; s.pendingEvents=[];
  for(const part of parts) s.processedEvents[part.eventKey]=new Date(f.time).toISOString();
  await fs.writeFile(path.join(f.dataDir,"genius-state.json"),JSON.stringify(s));
  f.failDelivery=false; f.monitor=f.restart(); await f.check();
  assert.equal(f.emitted.length,0); assert.equal(f.monitor.state().sources.genius_manifest.pendingObservation,undefined);
  assert.equal(Object.keys(f.monitor.state().processedEvents).length,9);
});

test("legacy pure technical parts are consumed without dropping a substantive pending part",async t=>{
  const f=await fixture(t); f.manifest.build={commit:"a",hash:"a"}; await f.check();
  f.manifest.build={commit:"b",hash:"b"}; f.manifest.initialConfig.launchFee="3000";
  f.failDelivery=true; await f.check(); const s=f.monitor.state();
  const parts=oldDocumentParts(s.pendingEvents[0]); assert.equal(parts.length,2);
  s.sources.genius_manifest.pendingObservation.events=parts; s.pendingEvents=parts;
  await fs.writeFile(path.join(f.dataDir,"genius-state.json"),JSON.stringify(s));
  f.failDelivery=false; f.monitor=f.restart(); await f.check();
  assert.deepEqual(f.emitted.map(e=>e.eventKey),[parts[1].eventKey]);
  assert.equal(Object.keys(f.monitor.state().processedEvents).length,2);
  assert.equal(f.monitor.state().sources.genius_manifest.pendingObservation,undefined);
});

test("durable aggregate cannot omit a late actual change even with a recomputed changes digest",async t=>{
  const f=await fixture(t); await f.check(); f.manifest.initialConfig={launchFee:"3000",launchEnabled:false};
  f.failDelivery=true; await f.check(); const s=f.monitor.state();
  for(const event of [s.pendingEvents[0],s.sources.genius_manifest.pendingObservation.events[0]]) {
    event.changes=event.changes.slice(0,1); event.changeCount=1;
    event.evidence.changesHash=geniusDocumentChangesHash(event.changes);
  }
  assert.throws(()=>validateGeniusState(s),/OBSERVATION_INCOMPLETE/);
});

test("duplicate array identities cannot silently discard an address or fee change",()=>{
  const before={items:[{id:1,address:TOKEN,fee:1},{id:1,address:CURVE,fee:1}]};
  const after=structuredClone(before); after.items[0].fee=2;
  assert.deepEqual(geniusDocumentChanges(before,after),[{field:"items.0.fee",before:1,after:2}]);
});

test("identity-preserving array reordering advances the hash without a false alert or a retry loop",async t=>{
  const f=await fixture(t);f.manifest.stacks.push({...structuredClone(f.manifest.stacks[0]),stackId:"second"});
  await f.check(); const old=f.monitor.state().sources.genius_manifest.hash;
  f.manifest.stacks.reverse(); await f.check();
  assert.equal(f.emitted.length,0);assert.notEqual(f.monitor.state().sources.genius_manifest.hash,old);
  assert.equal(f.monitor.state().health.sources.genius_manifest.status,"healthy");
  f.monitor=f.restart();await f.check();assert.equal(f.emitted.length,0);
});

test("oversized transition fails closed without advancing its baseline or sending partial evidence",async t=>{
  const f=await fixture(t);await f.check();const old=f.monitor.state().sources.genius_manifest.hash;
  for(let n=0;n<2001;n++)f.manifest.initialConfig[`feature${n}`]=n;
  await f.check();const state=f.monitor.state();
  assert.equal(f.emitted.length,0);assert.equal(state.sources.genius_manifest.hash,old);
  assert.equal(state.pendingEvents.length,0);
  assert.match(state.health.sources.genius_manifest.lastErrorCode,/GENIUS_DOCUMENT_CHANGES_INVALID_OR_TOO_LARGE/);
});

test("business fields under a snapshot or build container cannot be mistaken for technical noise",async t=>{
  const f=await fixture(t);f.manifest.snapshot={permissions:{launchEnabled:true}};f.manifest.build={launchFee:"100"};
  await f.check();f.manifest.snapshot.permissions.launchEnabled=false;f.manifest.build.launchFee="200";
  await f.check();assert.equal(f.emitted.length,1);assert.equal(f.emitted[0].changes.length,2);
});
