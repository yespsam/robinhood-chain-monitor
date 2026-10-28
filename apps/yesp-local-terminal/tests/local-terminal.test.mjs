import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import http from 'node:http';
import {createSniper,validateSnipe,SnipeStore} from '../server/sniper.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createLocalApp} from '../server/local-server.mjs';
import {batchedRpc} from '../server/batched-rpc.mjs';
import {createChainScanner,launchAbi,SCAN_SOURCES} from '../server/chain-scanner.mjs';
const ca='0x'+'2'.repeat(40),wallet='0x'+'1'.repeat(40),zero='0x'+'0'.repeat(40);
const config=()=>({tokenAddress:ca,quoteTokenAddress:zero,amount:'100',maxSpend:'0.01',slippageBps:'100',validForSeconds:60,gasEstimateLimit:'0.002'});
function fixture({prepare,execute,rows=[]}={}){
 let now=100000,calls=[],saved=structuredClone(rows),snapshots=[];
 const store={read:async()=>structuredClone(saved),save:async x=>{saved=structuredClone(x);snapshots.push(saved);}};
 const preview={previewId:randomUUID(),wallet,tokenAddress:ca,action:'buy',kind:'buy',buyMode:'tokenAmount',quote:{address:zero,decimals:18},spendRaw:'1000000000000000',spend:'0.001',expected:'100',estimatedGas:'0.0001',official:{risks:{riskDetails:[],riskBehaviors:[]}}};
 const trader={restrictPreviewDeadline(id,deadline){calls.push(['deadline',id,deadline]);},async handle(method,params){calls.push([method,params]);if(method==='panelStatus')return {wallet:{connected:true,address:wallet},operation:null};if(method==='panelPrepare')return prepare?prepare(preview):{tradePreview:preview};if(method==='panelExecute'){assert.equal(saved[0].state,'SUBMITTING');return execute?execute():{operation:{status:'UNKNOWN'}};}}};
 const sniper=createSniper({trader,store,clock:()=>now});
 return {sniper,trader,calls,preview,snapshots,store,setTime:n=>now=n,async arm(){const d=await sniper.draft(config());return (await sniper.arm({draftId:d.snipeDraft.draftId})).snipe;}};
}
test('sniper commits before submit and never retries UNKNOWN even after concurrent ticks',async()=>{
 const f=fixture();await f.arm();await Promise.all([f.sniper.tick(),f.sniper.tick()]);await f.sniper.tick();assert.equal(f.calls.filter(x=>x[0]==='panelExecute').length,1);assert.equal(f.sniper.state().jobs[0].state,'FINISHED');assert.equal(f.sniper.state().jobs[0].operationStatus,'UNKNOWN');assert.equal(f.calls.find(x=>x[0]==='deadline')[2],160000);
});
test('sniper waits for opening, then executes once',async()=>{let open=false;const f=fixture({prepare:p=>{if(!open)throw Object.assign(Error(),{code:'NOT_FOUR_TOKEN'});return {tradePreview:p};}});await f.arm();await f.sniper.tick();assert.equal(f.sniper.state().jobs[0].state,'ARMED');open=true;await f.sniper.tick();assert.equal(f.calls.filter(x=>x[0]==='panelExecute').length,1);});
test('99 percent sniper config reaches the quote unchanged and cannot exceed its independent maximum spend',async()=>{
 const f=fixture();f.preview.spendRaw='10000000000000001';const d=await f.sniper.draft({...config(),slippageBps:'9900'});assert.equal(d.snipeDraft.slippageBps,'9900');
 await f.sniper.arm({draftId:d.snipeDraft.draftId});await f.sniper.tick();assert.equal(f.calls.find(c=>c[0]==='panelPrepare')[1].slippageBps,'9900');assert.equal(f.sniper.state().jobs[0].error,'SNIPE_BUDGET_EXCEEDED');assert.equal(f.calls.some(c=>c[0]==='panelExecute'),false);
});
for(const [name,mutate,code]of [
 ['budget',p=>p.spendRaw='11000000000000000','SNIPE_BUDGET_EXCEEDED'],['quote',p=>p.quote.address=ca,'SNIPE_QUOTE_CHANGED'],['gas',p=>p.estimatedGas='0.003','SNIPE_GAS_EXCEEDED'],['approval',p=>p.kind='approve','SNIPE_APPROVAL_REQUIRED'],['risk',p=>p.official.risks.riskDetails=['review'],'SNIPE_REVIEW_REQUIRED'],['wallet',p=>p.wallet=ca,'SNIPE_PREVIEW_MISMATCH']])test('sniper pauses without spending on '+name,async()=>{const f=fixture();mutate(f.preview);await f.arm();await f.sniper.tick();await f.sniper.tick();assert.equal(f.sniper.state().jobs[0].error,code);assert.equal(f.calls.filter(x=>x[0]==='panelExecute').length,0);});
test('cancel while quote is in flight prevents submission',async()=>{let release;const f=fixture({prepare:p=>new Promise(r=>{release=()=>r({tradePreview:p});})});const j=await f.arm(),pending=f.sniper.tick();while(!release)await new Promise(r=>setImmediate(r));await f.sniper.cancel({id:j.id});release();await pending;assert.equal(f.sniper.state().jobs[0].state,'CANCELLED');assert.equal(f.calls.filter(x=>x[0]==='panelExecute').length,0);});
test('deadline expires after quote; restart pauses armed and submitting jobs',async()=>{const f=fixture({prepare:p=>{f.setTime(170000);return {tradePreview:p};}});await f.arm();await f.sniper.tick();assert.equal(f.sniper.state().jobs[0].state,'EXPIRED');assert.equal(f.calls.filter(x=>x[0]==='panelExecute').length,0);
 for(const state of ['ARMED','SUBMITTING']){const g=fixture({rows:[{...config(),id:randomUUID(),intentId:randomUUID(),wallet,state,createdAt:100000,validUntil:200000}]});await g.sniper.init();await g.sniper.tick();assert.equal(g.sniper.state().jobs[0].error,'SERVER_RESTARTED');assert.equal(g.calls.length,0);}
});
test('sniper rejects malformed limits and does not permit a second active task',async()=>{assert.throws(()=>validateSnipe({...config(),maxSpend:'Infinity'}));assert.throws(()=>validateSnipe({...config(),validForSeconds:99999}));const f=fixture();await f.arm();await assert.rejects(f.arm(),{code:'SNIPE_ALREADY_ACTIVE'});});
test('sniper private file survives restart and does not resume stored armed authorization',async t=>{const dir=await mkdtemp(join(tmpdir(),'yesp-sniper-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new SnipeStore(dir);assert.deepEqual(await store.read(),[]);const row={...config(),id:randomUUID(),intentId:randomUUID(),wallet,state:'ARMED',createdAt:100000,validUntil:200000};await store.save([row]);assert.deepEqual(await store.read(),[row]);const sniper=createSniper({trader:{},store});await sniper.init();assert.equal((await store.read())[0].error,'SERVER_RESTARTED');});
test('read RPC batches simultaneous calls, deduplicates only in flight and preserves RPC errors',async()=>{let count=0;const rpc=batchedRpc({batch:async calls=>{count++;return calls.map(([m])=>m==='bad'?{error:{code:-1,data:'0xdead'}}:{result:'0x1'});}});assert.deepEqual(await Promise.all([rpc('eth_blockNumber',[]),rpc('eth_blockNumber',[])]),['0x1','0x1']);assert.equal(count,1);await rpc('eth_blockNumber',[]);assert.equal(count,2);await assert.rejects(rpc('bad',[]),e=>e.rpcError.data==='0xdead');});
test('scanner reads only Agent creation events and replaces reorganized blocks',async()=>{let now=1000,logs=[];const source=SCAN_SOURCES[1],encoded=launchAbi.encodeEventLog(launchAbi.getEvent(source.event),[wallet,'0x'+'3'.repeat(40),ca,zero,'0x'+'0'.repeat(64)]);
 const log={...encoded,address:source.address,blockHash:'0x'+'a'.repeat(64),transactionHash:'0x'+'b'.repeat(64),blockNumber:'0x64',logIndex:'0x0'};logs=[log];
 const rpc=async(m,p)=>{if(m==='eth_chainId')return '0x38';if(m==='eth_blockNumber')return '0x64';if(m==='eth_call')throw Error('optional name unavailable');assert.ok(SCAN_SOURCES.some(s=>s.address===p[0].address));if(p[0].address===SCAN_SOURCES[0].address)assert.equal(p[0].topics.length,2);return p[0].address===source.address?logs:[];};
 const scanner=createChainScanner({rpc,discovery:null,clock:()=>now,lookback:4});await scanner.tick();assert.equal(scanner.state().rows[0].tokenAddress.toLowerCase(),ca);now=2000;await scanner.tick();assert.equal(scanner.state().rows[0].seenAt,1000);logs=[];await scanner.tick();assert.equal(scanner.state().rows.length,0);
});
test('local server enforces loopback Host, origin, CSRF, method allowlist and one-use write IDs',async()=>{
 const calls=[],scanner={start(){},stop(){},state:()=>({rows:[]}),subscribe(){}},sniper={start(){},stop(){},state:()=>({jobs:[]}),subscribe(){},init(){}},trader={handle:async(m,p)=>{calls.push(m);return {wallet:{connected:false},operation:null};}},auth={close(){}};
 let gmgnConfigured=false;const gmgn={async status(){return {gmgn:{configured:gmgnConfigured}};},async configure(p){calls.push('gmgnConfigure');gmgnConfigured=!!p.apiKey;return {gmgn:{configured:gmgnConfigured,apiKey:p.apiKey}};}};
 const app=createLocalApp({cli:{},rpc:()=>{},trader,scanner,sniper,gmgn,modes:{init(){},start(){},stop(){},state:()=>({modes:[],sources:[]}),subscribe(){}},transfer:{},auth});const url=await app.listen(0);
 try{const session=await(await fetch(url+'/api/session')).json();const post=(body,headers={})=>fetch(url+'/api/request',{method:'POST',headers:{'content-type':'application/json','Origin':url,'x-yesp-csrf':session.csrf,...headers},body:JSON.stringify(body)});
 assert.equal((await fetch(url+'/')).status,200);assert.equal((await fetch(url+'/.private/sniper/jobs.json')).status,404);assert.equal(await new Promise(resolve=>{http.get(url+'/api/session',{headers:{Host:'evil.test'}},res=>{res.resume();resolve(res.statusCode);});}),403);assert.equal((await fetch(url+'/api/session',{headers:{Origin:'https://evil.test'}})).status,403);
 assert.equal((await fetch(url+'/',{headers:{'sec-fetch-site':'cross-site','sec-fetch-dest':'document'}})).status,403);
 assert.equal(await new Promise(resolve=>http.get(url+'/',{headers:{'sec-fetch-site':'cross-site','sec-fetch-dest':'document','sec-fetch-mode':'navigate'}},res=>{res.resume();resolve(res.statusCode);})),200);
 const r={id:randomUUID(),method:'panelStatus',params:{profile:'unified'}};assert.equal((await post(r,{'x-yesp-csrf':''})).status,403);assert.equal((await post(r,{Origin:'https://evil.test'})).status,403);assert.equal((await(await post(r)).json()).ok,true);
 const unknown=await(await post({id:randomUUID(),method:'executeRaw',params:{}})).json();assert.equal(unknown.error.code,'INVALID_REQUEST');
 const settings={id:randomUUID(),method:'gmgnConfigure',params:{apiKey:'local-test-key-not-secret'}};
 assert.equal((await post(settings,{Origin:'https://evil.test'})).status,403);assert.equal(calls.includes('gmgnConfigure'),false);
 const configured=await(await post(settings)).json();assert.equal(configured.data.gmgn.configured,true);assert.equal(configured.data.gmgn.apiKey,undefined);assert.equal((await fetch(url+'/.private/gmgn/settings.json')).status,404);assert.equal((await fetch(url+'/terminal.css')).status,200);
 const write={id:randomUUID(),method:'panelExecute',params:{profile:'unified',intentId:randomUUID(),previewId:randomUUID()}};assert.equal((await(await post(write)).json()).ok,true);assert.equal((await(await post(write)).json()).error.code,'REQUEST_ID_REUSED');assert.equal(calls.filter(m=>m==='panelExecute').length,1);
 const automatic={id:randomUUID(),method:'panelTrade',params:{profile:'unified',tokenAddress:ca,wallet,intentId:randomUUID(),action:'buy',amount:'1',slippageBps:'100',swapSlippageBps:'100',maxBnb:'0.1'}};
 assert.equal((await post(automatic,{Origin:'https://evil.test'})).status,403);assert.equal(calls.includes('panelTrade'),false);
 assert.equal((await(await post(automatic)).json()).ok,true);assert.equal((await(await post(automatic)).json()).error.code,'REQUEST_ID_REUSED');assert.equal(calls.filter(m=>m==='panelTrade').length,1);
 sniper.state=()=>({jobs:[{state:'ARMED'}]});const blocked=await(await post({...write,id:randomUUID()})).json();assert.equal(blocked.error.code,'SNIPE_ACTIVE');assert.equal(blocked.submissionNotStarted,true);
 assert.equal((await(await post({...automatic,id:randomUUID()})).json()).error.code,'SNIPE_ACTIVE');
 }finally{await app.close();}
});
