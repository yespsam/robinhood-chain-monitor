import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {open,rm} from 'node:fs/promises';
import {secureDirectory,openPrivateRead,checkPrivateFile,commitFile,syncDirectory} from './platform-files.mjs';
import {fault,same} from './flap-reader.mjs';
import {ZERO,tokenAddress} from './four-reader.mjs';
import {rawAmount} from './panel-chain.mjs';
import {validatePanelParams} from '../extension/trade-policy.js';
import {validateSlippageBps} from '../extension/slippage-policy.js';
const UUID=/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const waitCodes=new Set(['MODE_MODULE_BINDING_PENDING','MODE_HISTORY_INCOMPLETE','NOT_FOUR_TOKEN','NOT_OPENFOUR_TOKEN','OPENFOUR_TOKEN_NOT_FOUND','FLAP_STAGED_TOKEN','FOUR_NOT_LAUNCHED','OPENFOUR_NOT_TRADING','FLAP_LAUNCHING','RPC_UNAVAILABLE','RPC_INVALID_RESPONSE','STALE_BLOCK','STALE_QUOTE','PREVIEW_EXPIRED']);
export function validateSnipe(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['strategy','reportId','modeId','firstMaxAgeSeconds','tokenAddress','amount','maxSpend','quoteTokenAddress','slippageBps','swapSlippageBps','validForSeconds','gasEstimateLimit'].includes(k)))throw fault('INVALID_REQUEST');
 if(p.swapSlippageBps!==undefined)validateSlippageBps(p.swapSlippageBps);
 if(p.strategy!==undefined&&!['token','first-mode'].includes(p.strategy))throw fault('INVALID_REQUEST');
 const first=p.strategy==='first-mode';
 if(first){if(typeof p.reportId!=='string'||! /^[a-z-]+:[a-f\d]{40,64}(?::\d{1,16})?$/i.test(p.reportId))throw fault('MODE_REPORT_REQUIRED');
  if(p.tokenAddress!==undefined||typeof p.modeId!=='string'||!p.modeId||p.modeId==='next'||p.modeId.length>200||!Number.isInteger(p.firstMaxAgeSeconds)||p.firstMaxAgeSeconds<10||p.firstMaxAgeSeconds>300)throw fault('INVALID_REQUEST');}
 else if(p.modeId!==undefined||p.reportId!==undefined||p.firstMaxAgeSeconds!==undefined)throw fault('INVALID_REQUEST');
 validatePanelParams('panelPrepare',{profile:'unified',tokenAddress:first?'0x'+'1'.repeat(40):p.tokenAddress,amount:p.amount,action:'buy',slippageBps:p.slippageBps,buyMode:'tokenAmount'});
 if(p.quoteTokenAddress!==ZERO)tokenAddress(p.quoteTokenAddress);
 for(const k of ['maxSpend','gasEstimateLimit'])if(typeof p[k]!=='string'||p[k].length>100||! /^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(p[k])||!/[1-9]/.test(p[k]))throw fault('INVALID_REQUEST');
 rawAmount(p.gasEstimateLimit,18);
 if(!Number.isInteger(p.validForSeconds)||p.validForSeconds<30||p.validForSeconds>(first?604800:1800))throw fault('INVALID_REQUEST');return p;
}
export class SnipeStore{
 constructor(directory=fileURLToPath(new URL('../.private/sniper/',import.meta.url))){this.directory=directory;this.tail=Promise.resolve();}
 async read(){await secureDirectory(this.directory);const path=join(this.directory,'jobs.json');let f;try{f=await openPrivateRead(path);}catch(e){if(e.code==='ENOENT')return [];throw e;}
  try{const s=await checkPrivateFile(path,f);if(s.size>1000000)throw fault('SNIPE_STORE_INVALID');const rows=JSON.parse(await f.readFile('utf8'));if(!Array.isArray(rows)||rows.length>100||rows.some(x=>!UUID.test(x.id)||!UUID.test(x.intentId)||!['ARMED','SUBMITTING','FINISHED','PAUSED','CANCELLED','EXPIRED'].includes(x.state)||!Number.isSafeInteger(x.validUntil)||!Number.isSafeInteger(x.createdAt)))throw fault('SNIPE_STORE_INVALID');return rows;}finally{await f.close();}}
 save(rows){const content=JSON.stringify(rows)+'\n';const run=async()=>{await secureDirectory(this.directory);const target=join(this.directory,'jobs.json'),tmp=target+'.'+randomUUID()+'.tmp';const f=await open(tmp,'wx',0o600);
  try{try{await checkPrivateFile(tmp,f);await f.writeFile(content);await f.sync();}finally{await f.close();}await commitFile(tmp,target);await syncDirectory(this.directory);}finally{await rm(tmp,{force:true});}};
  const result=this.tail.then(run);this.tail=result.catch(()=>{});return result;
 }
}
export function createSniper({trader,modes,gangGateway,store=new SnipeStore(),clock=Date.now,intervalMs=1500}={}){
 let jobs=[],drafts=new Map(),timer=null,busy=false,ready=false,initPromise=null,writeGate=Promise.resolve(),tickPromise=null;const listeners=new Set();
 const state=()=>({running:Boolean(timer),checking:busy,intervalMs,jobs:jobs.map(x=>({...x}))});
 const emit=()=>{for(const fn of listeners)try{fn(state());}catch{}};
 const persist=async()=>{await store.save(jobs);emit();};
 async function init(){if(initPromise)return initPromise;initPromise=(async()=>{jobs=await store.read();let changed=false;for(const job of jobs)if(['ARMED','SUBMITTING'].includes(job.state)){job.state='PAUSED';job.error='SERVER_RESTARTED';changed=true;}if(changed)await persist();ready=true;})();return initPromise;}
 const walletStatus=()=>trader.handle('panelStatus',{profile:'unified'});
 async function draft(params){await init();validateSnipe(params);const s=await walletStatus();if(!s.wallet?.connected)throw fault('LOGIN_REQUIRED');
  if(s.operation&&!['COMPLETE','REJECTED','FAILED','CANCELLED'].includes(s.operation.status))throw fault('UNRESOLVED_TRADE_EXISTS');
  let reviewed=null;if(params.strategy==='first-mode'){if(!modes)throw fault('MODE_MONITOR_UNAVAILABLE');reviewed=await modes.authorize(params.reportId,params.modeId);}
  if(reviewed?.report?.platform==='gang'&&(params.quoteTokenAddress!==ZERO||!gangGateway))throw fault(params.quoteTokenAddress!==ZERO?'SNIPE_GANG_BNB_REQUIRED':'MODE_ADAPTER_REQUIRED');
  const id=randomUUID(),d={...params,swapSlippageBps:params.swapSlippageBps||'100',...(reviewed?{report:reviewed.report,modeName:reviewed.modeName,modeFingerprint:reviewed.fingerprint}:{tokenAddress:tokenAddress(params.tokenAddress)}),quoteTokenAddress:params.quoteTokenAddress===ZERO?ZERO:tokenAddress(params.quoteTokenAddress),draftId:id,wallet:s.wallet.address,expiresAt:clock()+60000};
  drafts.clear();drafts.set(id,d);return {snipeDraft:d};}
 function exclusive(fn){const p=writeGate.then(fn);writeGate=p.catch(()=>{});return p;}
 async function arm({draftId}){return exclusive(async()=>{await init();if(!UUID.test(draftId||''))throw fault('INVALID_REQUEST');const d=drafts.get(draftId);drafts.delete(draftId);
  if(!d||clock()>=d.expiresAt)throw fault('PREVIEW_EXPIRED');if(jobs.some(j=>['ARMED','SUBMITTING'].includes(j.state)))throw fault('SNIPE_ALREADY_ACTIVE');
  const s=await walletStatus();if(!s.wallet?.connected||!same(s.wallet.address,d.wallet))throw fault('WALLET_CHANGED');if(clock()>=d.expiresAt)throw fault('PREVIEW_EXPIRED');
  if(s.operation&&!['COMPLETE','REJECTED','FAILED','CANCELLED'].includes(s.operation.status))throw fault('UNRESOLVED_TRADE_EXISTS');
  const baseline=d.strategy==='first-mode'?await modes.authorize(d.reportId,d.modeId,d.modeFingerprint):null;if(clock()>=d.expiresAt)throw fault('PREVIEW_EXPIRED');
  const {draftId:unused,expiresAt,...config}=d,now=clock(),job={...config,...(baseline?{baseline,phase:'WAITING_MODE'}:{}),id:randomUUID(),intentId:randomUUID(),state:'ARMED',createdAt:now,validUntil:now+d.validForSeconds*1000,checks:0,error:null};
  jobs=[job,...jobs].slice(0,100);try{await persist();}catch(e){job.state='PAUSED';job.error='STORE_WRITE_FAILED';throw e;}return {snipe:job};});}
 async function cancel({id}){return exclusive(async()=>{await init();const job=jobs.find(j=>j.id===id);if(!job)throw fault('INVALID_INTENT');if(job.state==='SUBMITTING')throw fault('SUBMISSION_ALREADY_STARTED');
  if(job.state==='ARMED'||job.state==='PAUSED'){job.state='CANCELLED';await persist();}return {snipe:job};});}
 const live=job=>job.state==='ARMED'&&clock()<job.validUntil;
 function freshFirst(job,mode){
  const first=job.first,at=first.createdAt??mode.emptyBlock?.time;
  if(!Number.isSafeInteger(at)||at>clock()+5000||clock()-at>job.firstMaxAgeSeconds*1000)throw fault('MODE_FIRST_MISSED');
  const baseline=job.baseline.blocks[mode.platform];
  if(first.blockNumber!==undefined?first.blockNumber<=baseline.number:mode.emptyBlock?.number<baseline.number)throw fault('MODE_FIRST_ALREADY_EXISTS');
 }
 async function targetFirst(job){
  await modes.checkReport(job.reportId,job.modeId,job.modeFingerprint);if(!live(job))return null;
  if(!job.lockedModeId){const selected=await modes.choose(job.baseline);if(!live(job))return null;if(!selected){job.phase='WAITING_MODE';emit();return null;}
   job.lockedModeId=selected.id;job.modeName=selected.name;job.platform=selected.platform;job.phase='MODE_LOCKED';await persist();}
  if(!live(job))return null;const mode=await modes.resolve(job.lockedModeId);if(!live(job))return null;
  if(mode.first&&!job.first){job.first=mode.first;job.tokenAddress=tokenAddress(mode.first.tokenAddress);job.phase='FIRST_LOCKED';await persist();}
  if(job.first)freshFirst(job,mode);
  if(!mode.adapter){job.phase='WAITING_ADAPTER';job.error='MODE_ADAPTER_REQUIRED';emit();return null;}
  if(!job.first){job.phase='WAITING_FIRST';job.error=mode.reason||null;emit();return null;}
  if(!mode.ready){job.phase='FIRST_LOCKED';job.error=mode.reason||'MODE_NOT_OPEN';emit();return null;}
  if(!job.modeFingerprint){job.modeFingerprint=mode.fingerprint;await persist();}
  const verified=await modes.verify(job.lockedModeId,job.modeFingerprint,job.first);if(!live(job))return null;freshFirst(job,verified);return verified;
 }
 async function runTick(){await init();if(busy)return;const job=jobs.find(j=>j.state==='ARMED');if(!job)return;busy=true;emit();
  try{
   if(!live(job)){job.state='EXPIRED';await persist();return;}
   job.checks++;job.lastCheck=clock();
   const mode=job.strategy==='first-mode'?await targetFirst(job):null;
   if(!live(job)){if(job.state==='ARMED'){job.state='EXPIRED';await persist();}return;}
   if(job.strategy==='first-mode'&&!mode)return;
   if(mode?.platform==='gang'){
    if(!gangGateway||job.quoteTokenAddress!==ZERO)throw fault('SNIPE_GANG_BNB_REQUIRED');
    const config={perTokenMaxBnb:job.maxSpend,slippageBps:job.slippageBps,swapSlippageBps:job.swapSlippageBps||'100'},row={tokenAddress:job.tokenAddress,manager:mode.manager};
    const entry=await gangGateway.entry(row,config,job.wallet,job.amount);if(!live(job))return;
    if(BigInt(entry.costRaw)>rawAmount(job.maxSpend,18))throw fault('SNIPE_BUDGET_EXCEEDED');
    await modes.checkReport(job.reportId,job.modeId,job.modeFingerprint);const checked=await modes.verify(job.lockedModeId,job.modeFingerprint,job.first);if(!live(job))return;freshFirst(job,checked);
    job.state='SUBMITTING';job.triggeredAt=clock();job.quoteSymbol='BNB';job.gangEntry={...entry,...row,wallet:job.wallet,config,buyIntentId:job.intentId};await persist();
    const active=()=>{if(job.state!=='SUBMITTING'||clock()>=job.validUntil)throw fault('SNIPE_EXPIRED');};
    const result=await gangGateway.buy(job.gangEntry,{active,verify:async()=>{active();await modes.checkReport(job.reportId,job.modeId,job.modeFingerprint);const m=await modes.verify(job.lockedModeId,job.modeFingerprint,job.first);freshFirst(job,m);active();},checkPlan:async p=>{const reserved=p.kind==='fund'&&p.estimatedGas===undefined,fee=p.estimatedGas??(reserved?p.gasReserve:undefined);if(typeof fee!=='string'||rawAmount(fee,18)>rawAmount(job.gasEstimateLimit,18))throw fault(reserved?'SNIPE_GAS_RESERVE_EXCEEDED':'SNIPE_GAS_EXCEEDED');}});
    job.state='FINISHED';job.operationStatus=result.status;job.txHash=result.txHash||null;job.error=result.code||null;await persist();return;
   }
   const result=await trader.handle('panelPrepare',{profile:'unified',tokenAddress:job.tokenAddress,action:'buy',amount:job.amount,slippageBps:job.slippageBps,buyMode:'tokenAmount'});
   if(!live(job)){if(job.state==='ARMED'){job.state='EXPIRED';await persist();}return;}
   const p=result.tradePreview;if(!p||!same(p.wallet,job.wallet)||!same(p.tokenAddress,job.tokenAddress)||p.action!=='buy'||p.buyMode!=='tokenAmount')throw fault('SNIPE_PREVIEW_MISMATCH');
   if(p.protocol==='dex-swap')throw fault('SNIPE_REVIEW_REQUIRED');
   if(!same(p.quote.address,job.quoteTokenAddress))throw fault('SNIPE_QUOTE_CHANGED');
   if(BigInt(p.spendRaw)>rawAmount(job.maxSpend,p.quote.decimals))throw fault('SNIPE_BUDGET_EXCEEDED');
   if(rawAmount(p.estimatedGas,18)>rawAmount(job.gasEstimateLimit,18))throw fault('SNIPE_GAS_EXCEEDED');
   if(p.kind==='approve')throw fault('SNIPE_APPROVAL_REQUIRED');if(p.kind!=='buy')throw fault('SNIPE_PREVIEW_MISMATCH');
   if(p.official?.requireConfirmation||p.official?.risks?.riskDetails?.length||p.official?.risks?.riskBehaviors?.length)throw fault('SNIPE_REVIEW_REQUIRED');
   if(mode){
    await modes.checkReport(job.reportId,job.modeId,job.modeFingerprint);if(!live(job))return null;
    if(mode.platform==='four'?(p.protocol!=='openfour-agent'||String(p.presetId)!==mode.presetId||!same(p.manager,mode.emitter)):(p.protocol!=='flap-agent'||!same(p.agentFactory,mode.factory)||!same(p.marketAddress,job.first.marketAddress)))throw fault('MODE_PREVIEW_MISMATCH');
    const checked=await modes.verify(job.lockedModeId,job.modeFingerprint,job.first);if(!live(job))return;freshFirst(job,checked);
   }
   // This durable marker precedes the engine's own persistent submission record.
   // Cancellation checks and the transition are synchronous; no retry follows it.
   if(!live(job))return;job.state='SUBMITTING';job.triggeredAt=clock();job.expected=p.expected;job.spend=p.spend;job.quoteSymbol=p.quote.symbol;await persist();
   if(clock()>=job.validUntil){job.state='EXPIRED';await persist();return;}
   trader.restrictPreviewDeadline(p.previewId,job.validUntil);
   const execution=await trader.handle('panelExecute',{profile:'unified',previewId:p.previewId,intentId:job.intentId});job.state='FINISHED';job.operationStatus=execution.operation?.status||'UNKNOWN';job.txHash=execution.operation?.txHash||null;job.error=null;await persist();
  }catch(e){const code=/^[A-Z][A-Z0-9_]{0,80}$/.test(e.code||'')?e.code:'SNIPE_FAILED';
   if(job.state==='ARMED'&&waitCodes.has(code)&&clock()<job.validUntil){job.error=code;emit();}
   else if(job.state!=='CANCELLED'){job.state=clock()>=job.validUntil&&job.state==='ARMED'?'EXPIRED':'PAUSED';job.error=code;await persist();}
  }finally{busy=false;emit();}
 }
 function tick(){if(tickPromise)return tickPromise;tickPromise=runTick().finally(()=>{tickPromise=null;});return tickPromise;}
 function start(){if(timer)return;timer=setInterval(()=>tick().catch(()=>{}),intervalMs);timer.unref?.();}
 async function stop(){if(timer)clearInterval(timer);timer=null;await init();for(const job of jobs)if(job.state==='ARMED'){job.state='PAUSED';job.error='SERVER_STOPPED';}await tickPromise;if(ready)await persist();}
 return {init,state,draft,arm,cancel,tick,start,stop,subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);}};
}
