import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PLATFORM_DOCUMENT_WATCH_VERSION, allowedPlatformDocumentUrl,
  planPlatformDocumentWatch, platformDocumentSnapshot, fetchPlatformDocument,
  applyPlatformDocumentResult, platformDocumentCoverage,
} from '../src/platform-document-watch.js';
import { PLATFORM_CAPABILITY_TARGETS, runPlatformCapabilityCheck } from '../src/platform-capability-monitor.js';

const NOW = Date.parse('2026-10-11T10:00:00Z');
const MINUTE = 60_000;
const flap = PLATFORM_CAPABILITY_TARGETS.find(p => p.id === 'flap');
const four = PLATFORM_CAPABILITY_TARGETS.find(p => p.id === 'fourmeme');
const FLAP_MAP = 'https://docs.flap.sh/sitemap.xml';
const FOUR_MAP = 'https://four-meme.gitbook.io/four.meme/sitemap.xml';
const urlFor = (index, platform = flap) => platform.id === 'flap'
  ? `https://docs.flap.sh/flap/developers/hook-${String(index).padStart(3, '0')}`
  : `https://four-meme.gitbook.io/four.meme/product-update/hook-${String(index).padStart(3, '0')}`;
const metadata = (url, sitemap = FLAP_MAP) => ({ url, lastmod:'2026-10-01', source:{kind:'sitemap', url:sitemap} });
const entryWith = (count = 1, platform = flap) => ({ capabilities:{pageMetadata:Array.from({length:count}, (_, i) => metadata(urlFor(i, platform), platform.id === 'flap' ? FLAP_MAP : FOUR_MAP))} });
const body = (fee = 100) => `<main><h1>Hook settlement rules</h1><p>The beforeSwap fee cap is ${fee} basis points.</p></main>`;
const reply = (url, text = body(), extra = {}) => ({
  ok:true, status:200, url, redirected:false,
  headers:{get: name => extra.headers?.[name.toLowerCase()] || null}, text:async()=>text,
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'headers')),
});

test('coverage includes configured body sources before sitemap adoption and does not claim prior semantic reads as body coverage', () => {
  const entry = { capabilities:{pageMetadata:[]}, sources:{'docs:old':{lastSuccessAt:new Date(NOW).toISOString()}} };
  assert.equal(platformDocumentCoverage(flap, entry, NOW).configuredPages, 2);
  assert.equal(platformDocumentCoverage(flap, entry, NOW).uncheckedPages, 2);
  const summary = platformDocumentCoverage(four, entry, NOW);
  assert.equal(summary.configuredPages, 4);
  assert.equal(summary.allowedPages, 4);
  assert.equal(summary.freshPages, 0);
  assert.equal(summary.rosterOverflowPages, 0);
  assert.equal(summary.observationOnly, true);
});

test('only official same-origin allowlisted sitemap pages are promoted; stock and fake provenance stay excluded', () => {
  const denied = [
    'http://docs.flap.sh/flap/developers/hook',
    'https://user:secret@docs.flap.sh/flap/developers/hook',
    'https://docs.flap.sh.evil.invalid/flap/developers/hook',
    'https://docs.flap.sh/flap/developers/hook?token=secret',
    'https://docs.flap.sh/flap/developers/hook#secret',
    'https://docs.flap.sh/flap/developers/stock-launch',
    'https://docs.flap.sh/flap/developers/RWA/launch',
    'https://docs.flap.sh/flap/developers/hook.json',
    'https://docs.flap.sh/flap/developers/a%2fb',
    'https://docs.flap.sh/flap/arbitrary/hook',
  ];
  for (const url of denied) assert.equal(allowedPlatformDocumentUrl(flap, url), null, url);
  const valid = urlFor(1);
  const entry = { capabilities:{pageMetadata:[...denied.map(url=>metadata(url)),
    metadata(valid), metadata(urlFor(2), 'https://evil.invalid/sitemap.xml'),
    {url:urlFor(3),source:{kind:'docs',url:FLAP_MAP}}]} };
  const plan = planPlatformDocumentWatch(flap, entry, NOW);
  assert.equal(plan.discoveredPages, 3, 'two static seeds plus one verified sitemap page');
  assert.ok(plan.watch.pages[valid]);
  assert.equal(plan.watch.pages[urlFor(2)], undefined);
  assert.equal(plan.watch.pages[urlFor(3)], undefined);
  assert.equal(allowedPlatformDocumentUrl({id:'flap',pagePattern:/no-match/}, valid), null);
  assert.equal(allowedPlatformDocumentUrl('unknown', valid), null);
});

test('bounded rotation visits oldest unchecked pages first and exposes roster overflow', () => {
  let entry = entryWith(8);
  let plan = planPlatformDocumentWatch(flap, entry, NOW, {limit:99});
  assert.equal(plan.selected.length, 4);
  const visited = new Set(plan.selected.map(p=>p.url));
  let watch = plan.watch;
  for (const p of plan.selected) watch = applyPlatformDocumentResult(watch, p.url, platformDocumentSnapshot(body()), NOW);
  entry = {...entry,documentWatch:watch};
  plan = planPlatformDocumentWatch(flap, entry, NOW+MINUTE);
  assert.equal(plan.selected.length, 4);
  for (const p of plan.selected) assert.equal(visited.has(p.url), false);
  const big = entryWith(140);
  const bigPlan = planPlatformDocumentWatch(flap, big, NOW);
  const coverage = platformDocumentCoverage(flap, {...big,documentWatch:bigPlan.watch}, NOW);
  assert.equal(Object.keys(bigPlan.watch.pages).length, 128);
  assert.equal(coverage.allowedPages, 142);
  assert.equal(coverage.trackedPages, 128);
  assert.equal(coverage.rosterOverflowPages, 14);
  assert.equal(coverage.uncheckedPages, 142);
  assert.equal(coverage.pages.length, 128);
});

test('normalized visible body detects unknown rule edits but ignores navigation, scripts, format and update boilerplate', () => {
  const first = platformDocumentSnapshot(body());
  const noise = `<nav>Random 2026 banner</nav><script>nonce=42</script><main><h1>Hook settlement rules</h1><p>The beforeSwap\n fee cap is   100 basis points.</p><p>Last updated yesterday</p></main><footer>Changed footer</footer>`;
  assert.equal(platformDocumentSnapshot(noise).fingerprint, first.fingerprint);
  assert.notEqual(platformDocumentSnapshot(body(300)).fingerprint, first.fingerprint);
  assert.throws(()=>platformDocumentSnapshot('<main>Access denied: forbidden by platform policy.</main>'), /unavailable/);
  assert.throws(()=>platformDocumentSnapshot('x'.repeat(2*1024*1024+1)), /too_large/);
});

test('first inclusion builds a quiet baseline; later same-URL body edits persist as bounded unverified observations', () => {
  const source = urlFor(0), entry = entryWith(1);
  let watch = planPlatformDocumentWatch(flap, entry, NOW).watch;
  watch = applyPlatformDocumentResult(watch, source, platformDocumentSnapshot(body()), NOW);
  assert.equal(watch.changes.length, 0);
  assert.equal(watch.pages[source].lastContentChangedAt, null);
  watch = applyPlatformDocumentResult(watch, source, platformDocumentSnapshot(body(300)), NOW+MINUTE);
  const change = watch.changes[0];
  assert.equal(change.status, 'pending_verification');
  assert.deepEqual(change.added, ['The beforeSwap fee cap is 300 basis points.']);
  assert.deepEqual(change.removed, ['The beforeSwap fee cap is 100 basis points.']);
  assert.match(change.meaning, /不代表/);
  assert.equal(change.tokenAddress, undefined);
  assert.equal(change.activation, undefined);
  const changedAt = watch.pages[source].lastContentChangedAt;
  watch = applyPlatformDocumentResult(watch, source, platformDocumentSnapshot(body(300)), NOW+2*MINUTE);
  assert.equal(watch.pages[source].lastContentChangedAt, changedAt);
  assert.equal(watch.changes.length, 1);
  assert.equal(watch.pages[source].lastSuccessAt, new Date(NOW+2*MINUTE).toISOString());
  for (let index=0;index<40;index++) watch = applyPlatformDocumentResult(watch, source, platformDocumentSnapshot(body(301+index)), NOW+(3+index)*MINUTE);
  assert.equal(watch.changes.length, 32);
  assert.equal(watch.omittedChangeCount, 9);
  assert.equal(platformDocumentCoverage(flap, {...entry,documentWatch:watch}, NOW+44*MINUTE).latestChanges.length, 8);
});

test('errors retain previous fingerprints; persisted origin cooldown honors Retry-After and redacts uncontrolled failures', () => {
  const source=urlFor(0), entry=entryWith(2);
  let watch=planPlatformDocumentWatch(flap,entry,NOW).watch;
  watch=applyPlatformDocumentResult(watch,source,platformDocumentSnapshot(body()),NOW);
  const before=structuredClone(watch.pages[source]);
  watch=applyPlatformDocumentResult(watch,source,{error:{status:429,retryAfterMs:60*MINUTE,message:'https://user:secret@bad.invalid'}},NOW+MINUTE);
  assert.equal(watch.pages[source].fingerprint,before.fingerprint);
  assert.equal(watch.pages[source].lastSuccessAt,before.lastSuccessAt);
  assert.equal(watch.pages[source].lastError,'document_http_429');
  assert.equal(watch.originNextAttemptAt,new Date(NOW+61*MINUTE).toISOString());
  assert.deepEqual(planPlatformDocumentWatch(flap,{...entry,documentWatch:watch},NOW+31*MINUTE).selected,[]);
  assert.ok(planPlatformDocumentWatch(flap,{...entry,documentWatch:watch},NOW+61*MINUTE).selected.length);
  watch=applyPlatformDocumentResult(watch,source,{error:new Error('secret credential in transport URL')},NOW+62*MINUTE);
  assert.equal(watch.pages[source].lastError,'document_fetch_failed');
  assert.equal(JSON.stringify(watch).includes('secret'),false);
  const existing={...entry,sources:{a:{url:source,lastErrorStatus:403,nextAttemptAt:new Date(NOW+60*MINUTE).toISOString()}}};
  assert.equal(planPlatformDocumentWatch(flap,existing,NOW).selected.length,0);
});

test('coverage distinguishes unvisited, stale, failed, future-clock and due states without falsely fresh aggregate', () => {
  const entry=entryWith(3); let watch=planPlatformDocumentWatch(flap,entry,NOW).watch;
  watch=applyPlatformDocumentResult(watch,urlFor(0),platformDocumentSnapshot(body()),NOW-3*60*MINUTE);
  watch=applyPlatformDocumentResult(watch,urlFor(1),{error:{code:'body_unavailable'}},NOW-MINUTE);
  watch=applyPlatformDocumentResult(watch,urlFor(2),platformDocumentSnapshot(body()),NOW+6000);
  const c=platformDocumentCoverage(flap,{...entry,documentWatch:watch},NOW);
  assert.equal(c.allowedPages,5);
  assert.equal(c.stalePages,1); assert.equal(c.failedPages,1); assert.equal(c.uncheckedPages,3); assert.equal(c.freshPages,0);
  assert.ok(c.nextDueAt);
  const input=structuredClone(watch);
  assert.deepEqual(applyPlatformDocumentResult(watch,urlFor(2),platformDocumentSnapshot(body(999)),NOW),input,'late result never rewinds newer checkpoint');
});

test('document fetch rejects redirects/provenance substitutions, uses conditionals, and accepts only an existing 304 baseline', async () => {
  const url=urlFor(0); let options;
  const baseline=await fetchPlatformDocument(flap,{url},async (value,opts)=>{options=opts;return reply(value,body(),{headers:{etag:'"v1"'}});},{nowMs:NOW});
  assert.equal(options.redirect,'manual');
  assert.equal(baseline.etag,'"v1"');
  const unchanged=await fetchPlatformDocument(flap,{url,...baseline},async(value,opts)=>{
    assert.equal(opts.headers['if-none-match'],'"v1"');return reply(value,'',{status:304,ok:false});
  });
  assert.deepEqual(unchanged,{notModified:true});
  for (const extra of [{status:302,ok:false},{redirected:true},{url:urlFor(1)},{url:'https://evil.invalid/hook'},{url:undefined}]) {
    await assert.rejects(fetchPlatformDocument(flap,{url},async()=>reply(url,body(),extra)),/redirect_rejected/);
  }
  await assert.rejects(fetchPlatformDocument(flap,{url},async()=>reply(url,'',{status:304,ok:false})),/http_304/);
  await assert.rejects(fetchPlatformDocument(flap,{url},async()=>reply(url,'',{status:429,ok:false,headers:{'retry-after':'3600'}}),{nowMs:NOW}),e=>e.status===429&&e.retryAfterMs===3600000);
  await assert.rejects(fetchPlatformDocument(flap,{url},async()=>reply(url,'',{headers:{'content-length':String(3*1024*1024)}})),/too_large/);
});

function memoryState(initial={}) {
  let state=structuredClone(initial); const audits=[];
  return {get:()=>structuredClone(state),deps:{
    fsImpl:{readFile:async()=>JSON.stringify(state),mkdir:async()=>{},appendFile:async(_path,text)=>audits.push(text)},
    atomicWriteJsonImpl:async(_path,value)=>{state=structuredClone(value);},
    stateFile:'/memory/platform.json',auditFile:'/memory/audit.jsonl',logger:{error(){}},
  }};
}
const sitemapBody=(platform,count=5)=>`<urlset>${Array.from({length:count},(_,i)=>`<url><loc>${urlFor(i,platform)}</loc><lastmod>2026-10-01</lastmod></url>`).join('')}</urlset>`;

test('existing slow cycle observes at most four sequential bodies across both platforms; no feature activation or outbound replay', async () => {
  const memory=memoryState(),requests=[],alerts=[],activations=[]; let at=NOW,fee=100,inFlight=0,maxBodyInFlight=0;
  const targets=[flap,four].map(p=>({...p,sources:[p.id==='flap'?FLAP_MAP:FOUR_MAP],marketSources:[],apiSources:[],packageSources:[],liveSources:[]}));
  const deps={...memory.deps,targets,now:()=>new Date(at),sourceLane:'slow',
    sendAlertsImpl:async(...args)=>alerts.push(args),onFourMemeFeatureActivation:async(...args)=>activations.push(args),
    fetchImpl:async(url,opts)=>{
      requests.push({url,body:opts.redirect==='manual'});
      if(url.endsWith('sitemap.xml')) return reply(url,sitemapBody(url===FLAP_MAP?flap:four));
      inFlight++;maxBodyInFlight=Math.max(maxBodyInFlight,inFlight); await Promise.resolve();inFlight--;
      return reply(url,body(fee));
    }};
  await runPlatformCapabilityCheck({dataDir:'/memory'},deps);
  assert.equal(requests.filter(r=>r.body).length,4);
  assert.equal(maxBodyInFlight,1);
  let state=memory.get();
  assert.equal(Object.values(state.flap.documentWatch.pages).filter(p=>p.fingerprint).length,2);
  assert.equal(Object.values(state.fourmeme.documentWatch.pages).filter(p=>p.fingerprint).length,2);
  assert.equal(state.flap.documentWatch.changes.length,0);
  assert.equal(alerts.length,0); assert.equal(activations.length,0);
  const firstSeen=new Set(requests.filter(r=>r.body).map(r=>r.url)); requests.length=0;at+=5000;
  await runPlatformCapabilityCheck({dataDir:'/memory'},deps);
  assert.equal(requests.filter(r=>r.body).length,4);
  assert.ok(requests.filter(r=>r.body).every(r=>!firstSeen.has(r.url)));
  // Complete the bounded directory baseline before changing one shared URL.
  for(let i=0;i<4;i++){at+=5000;await runPlatformCapabilityCheck({dataDir:'/memory'},deps);}
  at+=31*MINUTE; fee=300;requests.length=0;
  await runPlatformCapabilityCheck({dataDir:'/memory'},deps);
  state=memory.get();
  assert.equal(requests.filter(r=>r.body).length,4);
  assert.equal(state.flap.documentWatch.changes.length+state.fourmeme.documentWatch.changes.length,4);
  assert.equal(alerts.length,0,'body-only changes remain pending local research, not historical Telegram replay');
  assert.equal(activations.length,0,'no launch generation or first-three authority from page copy');
  const before=structuredClone(state.fourmeme.documentWatch);requests.length=0;
  await runPlatformCapabilityCheck({dataDir:'/memory'},{...deps,sourceLane:'fast'});
  assert.equal(requests.length,0); assert.deepEqual(memory.get().fourmeme.documentWatch,before);
});

test('body 429 stops that origin immediately and blocks static official doc probes until the persisted cooldown ends', async () => {
  const memory=memoryState(),requests=[];let at=NOW,block=true;
  const target={...flap,sources:[FLAP_MAP],marketSources:[],apiSources:[],packageSources:[],liveSources:[]};
  const deps={...memory.deps,targets:[target],sourceLane:'slow',now:()=>new Date(at),sendAlertsImpl:async()=>{},
    fetchImpl:async(url,opts)=>{
      requests.push({url,body:opts.redirect==='manual'});
      if(url===FLAP_MAP)return reply(url,sitemapBody(flap));
      return block?reply(url,'',{status:429,ok:false,headers:{'retry-after':'3600'}}):reply(url);
    }};
  await runPlatformCapabilityCheck({dataDir:'/memory'},deps);
  assert.equal(requests.filter(r=>r.body).length,1);
  assert.equal(memory.get().flap.documentWatch.originNextAttemptAt,new Date(NOW+60*MINUTE).toISOString());
  requests.length=0;at+=5*MINUTE;
  await runPlatformCapabilityCheck({dataDir:'/memory'},deps);
  assert.equal(requests.length,0,'both sitemap source and body watcher honor the shared origin circuit');
  requests.length=0;at=NOW+60*MINUTE;block=false;
  await runPlatformCapabilityCheck({dataDir:'/memory'},deps);
  assert.ok(requests.length>0);
});

test('custom platform sources and descriptor-scoped probes never silently acquire official body work', async () => {
  const memory=memoryState(),requests=[];
  const custom={id:'fourmeme',name:'test',sources:['https://test.invalid/page'],pagePattern:/no-pages/};
  const deps={...memory.deps,targets:[custom],now:()=>new Date(NOW),sendAlertsImpl:async()=>{},fetchImpl:async(url)=>{requests.push(url);return reply(url,body());}};
  await runPlatformCapabilityCheck({dataDir:'/memory'},deps);
  assert.deepEqual(requests,['https://test.invalid/page']);
  assert.equal(memory.get().fourmeme.documentWatch,undefined);
  requests.length=0;
  await runPlatformCapabilityCheck({dataDir:'/memory'},{...deps,targets:[{...custom,sources:[FOUR_MAP]}],descriptorKeys:[`docs:${FOUR_MAP}`],fetchImpl:async(url)=>{requests.push(url);return reply(url,sitemapBody(four));}});
  assert.deepEqual(requests,[FOUR_MAP]);
  assert.equal(memory.get().fourmeme.documentWatch,undefined);
});

test('a successful structured fast-lane commit preserves the independent body baselines and observations', async () => {
  const memory=memoryState();let at=NOW;
  const base={...four,sources:[FOUR_MAP],marketSources:[],apiSources:[],packageSources:[],liveSources:[]};
  const common={...memory.deps,targets:[base],sourceLane:'slow',now:()=>new Date(at),sendAlertsImpl:async()=>{},
    fetchImpl:async(url)=>reply(url,url===FOUR_MAP?sitemapBody(four):body())};
  await runPlatformCapabilityCheck({dataDir:'/memory'},common);
  const before=memory.get().fourmeme.documentWatch,requests=[];
  at+=5000;
  const api='https://four.meme/meme-api/v1/public/config';
  await runPlatformCapabilityCheck({dataDir:'/memory'},{...common,sourceLane:'fast',
    targets:[{...base,apiSources:[{url:api,parser:'fourmeme-config',authoritativeQuotes:true}]}],
    fetchImpl:async(url)=>{requests.push(url);return reply(url,JSON.stringify({code:0,data:[{
      symbol:'BNB',nativeSymbol:'BNB',symbolAddress:'0x0000000000000000000000000000000000000000',
      deployCost:'0',buyFee:'0.01',sellFee:'0.01',totalBAmount:'18',totalAmount:'1000000000',
      networkCode:'BSC',status:'PUBLISH',platform:'MEME',saleRate:'0.8',
    }]}));},
  });
  assert.deepEqual(requests,[api]);
  assert.equal(memory.get().fourmeme.sources[`api:${api}`].status,'healthy');
  assert.deepEqual(memory.get().fourmeme.documentWatch,before);
});
