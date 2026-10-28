import {randomUUID} from 'node:crypto';
import {parseUnits} from 'ethers';
import {fault,same} from './flap-reader.mjs';
import {GangLaunchStore,emptyGangLaunch} from './gang-launch-store.mjs';
import {validateSlippageBps} from '../extension/slippage-policy.js';
const uuid=v=>typeof v==='string'&&/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(v);
const address=v=>typeof v==='string'&&/^0x[\da-f]{40}$/i.test(v);
const raw=v=>typeof v==='string'&&/^(?:0|[1-9]\d{0,77})$/.test(v)&&BigInt(v)<1n<<256n;
const positive=v=>{try{if(typeof v!=='string'||!/^\d+(?:\.\d{1,18})?$/.test(v)||parseUnits(v,18)<=0n)throw Error();return parseUnits(v,18);}catch{throw fault('INVALID_REQUEST');}};
const transient=new Set(['RPC_UNAVAILABLE','RPC_RATE_LIMITED','RPC_INVALID_RESPONSE','STALE_BLOCK','STALE_QUOTE','WALLET_BUSY','PENDING_TRANSACTION']);
const safeCode=e=>/^[A-Z][A-Z0-9_]{0,80}$/.test(e?.code||'')?e.code:'GANG_STRATEGY_FAILED';
export function validateGangLaunch(p){
 const fields=['mode','perTokenMaxBnb','totalMaxBnb','maxBuys','validForSeconds','maxAgeSeconds','slippageBps','swapSlippageBps'];
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).length!==fields.length||Object.keys(p).some(k=>!fields.includes(k))||!['simulate','live'].includes(p.mode))throw fault('INVALID_REQUEST');
 const per=positive(p.perTokenMaxBnb),total=positive(p.totalMaxBnb);if(per>total||total>parseUnits('100',18))throw fault('GANG_BUDGET_INVALID');
 for(const [k,min,max]of [['maxBuys',1,50],['validForSeconds',60,86400],['maxAgeSeconds',5,120]])if(!Number.isInteger(p[k])||p[k]<min||p[k]>max)throw fault('INVALID_REQUEST');
 validateSlippageBps(p.slippageBps);validateSlippageBps(p.swapSlippageBps);return p;
}
export function createGangLaunchStrategy({gateway,source,store=new GangLaunchStore(),clock=Date.now,intervalMs=2000}={}){
 let data=emptyGangLaunch(),initPromise,timer=null,busy=false,tickPromise=null,draftValue=null,control=Promise.resolve(),exitCursor=0;const listeners=new Set();
 const active=()=>data.run?.state==='ACTIVE'&&(data.run.buyEnabled||data.run.exitEnabled);
 const snapshot=()=>structuredClone({...data,busy,running:Boolean(timer),active:active(),rules:{platform:'Gang',buySupplyPercent:1,profitMultiple:2,sellPositionPercent:50}});
 const emit=()=>{for(const f of listeners)try{f(snapshot());}catch{}};
 const persist=async()=>{await store.save(data);emit();};
 const event=(code,ca)=>{data.events.unshift({at:clock(),code,...(ca?{tokenAddress:ca}:{})});data.events=data.events.slice(0,100);};
 function storedValid(){const r=data.run;
  if(!Array.isArray(data.positions)||data.positions.length>100||!Array.isArray(data.seen)||data.seen.length>10000||data.seen.some(a=>!address(a))||!Array.isArray(data.events)||data.events.length>100)throw fault('GANG_STORE_INVALID');
  if(r){validateGangLaunch(r.config);if(!uuid(r.id)||!address(r.wallet)||!['ACTIVE','PAUSED','EXPIRED','FINISHED'].includes(r.state)||!raw(r.reservedRaw)||!Number.isInteger(r.attempts)||r.attempts<0||r.attempts>r.config.maxBuys||BigInt(r.reservedRaw)!==BigInt(r.attempts)*positive(r.config.perTokenMaxBnb)||BigInt(r.reservedRaw)>positive(r.config.totalMaxBnb)||!Number.isSafeInteger(r.expiresAt)||!Array.isArray(r.queue)||r.queue.length>200||typeof r.buyEnabled!=='boolean'||typeof r.exitEnabled!=='boolean')throw fault('GANG_STORE_INVALID');}
  for(const p of data.positions){validateGangLaunch(p.config);
   if(!uuid(p.id)||!uuid(p.runId)||!address(p.wallet)||!address(p.tokenAddress)||!address(p.manager)||!['BUYING','WATCHING','SELLING','KEPT','FAILED','NEEDS_REVIEW'].includes(p.state)||!uuid(p.buyIntentId)||!raw(p.costRaw)||BigInt(p.costRaw)<=0n||!raw(p.baselineRaw)||!raw(p.amountRaw)||!raw(p.expectedRaw)||!Number.isInteger(p.decimals)||p.decimals<0||p.decimals>36||p.mode!==p.config.mode||p.sellIntentId&&!uuid(p.sellIntentId))throw fault('GANG_STORE_INVALID');
   if(['WATCHING','SELLING','KEPT'].includes(p.state)&&(!raw(p.acquiredRaw)||BigInt(p.acquiredRaw)<=1n||!raw(p.halfRaw)||BigInt(p.halfRaw)!==BigInt(p.acquiredRaw)/2n))throw fault('GANG_STORE_INVALID');
   if(r&&p.runId===r.id&&(!same(p.wallet,r.wallet)||JSON.stringify(p.config)!==JSON.stringify(r.config)))throw fault('GANG_STORE_INVALID');
  }
 }
 function halt(){if(data.run){data.run.state='PAUSED';data.run.buyEnabled=data.run.exitEnabled=false;}}
 async function finishIfDone(r){if(r.state==='ACTIVE'&&!r.buyEnabled&&!data.positions.some(p=>p.runId===r.id&&['WATCHING','BUYING','SELLING','NEEDS_REVIEW'].includes(p.state))){r.state='FINISHED';r.exitEnabled=false;await persist();}}
 async function init(){return initPromise??=(async()=>{data=await store.read();storedValid();if(data.run?.state==='ACTIVE'){data.run.state='PAUSED';data.run.buyEnabled=data.run.exitEnabled=false;event('SERVER_RESTARTED');await persist();}})();}
 const exclusive=f=>{const p=control.then(f);control=p.catch(()=>{});return p;};
 async function draft(params){return exclusive(async()=>{await init();if(active()||busy)throw fault('GANG_STRATEGY_ACTIVE');
  const resume=params&&Object.keys(params).length===1&&params.resume===true;
  if(resume&&!data.run)throw fault('INVALID_REQUEST');const config=resume?data.run.config:validateGangLaunch(params);
  if(!resume&&data.positions.some(p=>['BUYING','WATCHING','SELLING','NEEDS_REVIEW'].includes(p.state)))throw fault('GANG_RESUME_REQUIRED');
  const w=await gateway.wallet();if(!w.connected)throw fault('LOGIN_REQUIRED');if(resume&&!same(w.address,data.run.wallet))throw fault('WALLET_CHANGED');
  const baseline=await source.baseline();draftValue={draftId:randomUUID(),wallet:w.address,config:{...config},resume,expiresAt:clock()+60000,baseline};return {gangLaunchDraft:structuredClone(draftValue)};
 });}
 async function arm({draftId}){return exclusive(async()=>{await init();const d=draftValue;draftValue=null;if(!uuid(draftId)||d?.draftId!==draftId||clock()>=d.expiresAt)throw fault('PREVIEW_EXPIRED');if(active()||busy)throw fault('GANG_STRATEGY_ACTIVE');
  const w=await gateway.wallet();if(!w.connected||!same(w.address,d.wallet))throw fault('WALLET_CHANGED');if(data.positions.some(p=>['BUYING','SELLING','NEEDS_REVIEW'].includes(p.state)))throw fault('UNRESOLVED_TRADE_EXISTS');
  const cursor=await source.baseline();if(clock()>=d.expiresAt)throw fault('PREVIEW_EXPIRED');
  if(d.resume){data.run={...data.run,state:'ACTIVE',buyEnabled:true,exitEnabled:true,cursor,queue:[],expiresAt:clock()+d.config.validForSeconds*1000};}
  else{data.positions=data.positions.filter(p=>['KEPT','FAILED'].includes(p.state)).slice(0,50);data.run={id:randomUUID(),wallet:d.wallet,config:d.config,state:'ACTIVE',buyEnabled:true,exitEnabled:true,createdAt:clock(),expiresAt:clock()+d.config.validForSeconds*1000,cursor,queue:[],attempts:0,reservedRaw:'0'};}
  event(d.config.mode==='live'?'GANG_LIVE_ARMED':'GANG_SIM_ARMED');try{await persist();}catch(e){data.run.state='PAUSED';data.run.buyEnabled=data.run.exitEnabled=false;throw e;}return {gangLaunch:snapshot()};
 });}
 async function pause({buysOnly=false}={}){await init();if(data.run){data.run.buyEnabled=false;if(!buysOnly){data.run.exitEnabled=false;data.run.state='PAUSED';}event(buysOnly?'GANG_BUYS_STOPPED':'GANG_ALL_PAUSED');await persist();}return {gangLaunch:snapshot()};}
 function guard(r,side,row){if(data.run?.id!==r.id||!active()||clock()>=r.expiresAt||!(side==='buy'?r.buyEnabled:r.exitEnabled))throw fault('GANG_STRATEGY_PAUSED');if(side==='buy'&&clock()-row.createdAfter>r.config.maxAgeSeconds*1000)throw fault('GANG_NEW_TOO_OLD');}
 async function finishBuy(p,result){if(result.status==='COMPLETE'&&raw(result.acquiredRaw)&&BigInt(result.acquiredRaw)>1n&&raw(result.costRaw)&&BigInt(result.costRaw)>0n){p.acquiredRaw=result.acquiredRaw;p.halfRaw=(BigInt(result.acquiredRaw)/2n).toString();p.costRaw=result.costRaw;p.buyTx=result.txHash;p.state='WATCHING';event('GANG_BUY_COMPLETE',p.tokenAddress);}
  else{p.state=result.pending?'NEEDS_REVIEW':'FAILED';p.error=result.code||'GANG_BUY_FAILED';if(result.pending)halt();event(p.error,p.tokenAddress);}await persist();}
 async function finishSell(p,result){if(result.halfSold){p.state='KEPT';p.sellTx=result.txHash;p.remainingRaw=(BigInt(p.acquiredRaw)-BigInt(p.halfRaw)).toString();p.error=result.status==='COMPLETE'?null:result.code||'GANG_CONVERSION_INCOMPLETE';event('GANG_HALF_SOLD',p.tokenAddress);}
  else{p.state='NEEDS_REVIEW';p.error=result.code||'GANG_SELL_REVIEW_REQUIRED';halt();event(p.error,p.tokenAddress);}await persist();}
 async function reconcilePosition({id}){await init();if(busy||!uuid(id))throw fault('GANG_STRATEGY_BUSY');const p=data.positions.find(p=>p.id===id);if(!p||!['BUYING','SELLING','NEEDS_REVIEW'].includes(p.state)||p.mode!=='live')throw fault('INVALID_REQUEST');const result=await gateway.recover(p);if(p.sellIntentId)await finishSell(p,result);else await finishBuy(p,result);return {gangLaunch:snapshot()};}
 async function buy(r,row){guard(r,'buy',row);const config=r.config,cap=positive(config.perTokenMaxBnb),entry=await gateway.entry(row,config,r.wallet);guard(r,'buy',row);await source.verify(row,config.maxAgeSeconds);guard(r,'buy',row);
  if(BigInt(entry.costRaw)>cap)throw fault('GANG_TOKEN_BUDGET');if(r.attempts>=config.maxBuys||BigInt(r.reservedRaw)+cap>positive(config.totalMaxBnb)){r.buyEnabled=false;event('GANG_BUDGET_USED');await persist();return;}
  const p={...entry,id:randomUUID(),runId:r.id,wallet:r.wallet,mode:config.mode,tokenAddress:row.tokenAddress,manager:row.manager,createdAt:clock(),state:'BUYING',buyIntentId:randomUUID(),candidate:row,config};
  r.attempts++;r.reservedRaw=(BigInt(r.reservedRaw)+cap).toString();data.positions.unshift(p);await persist();guard(r,'buy',row);
  if(config.mode==='simulate')await finishBuy(p,{status:'COMPLETE',acquiredRaw:entry.expectedRaw,costRaw:entry.costRaw});
  else await finishBuy(p,await gateway.buy(p,{active:()=>guard(r,'buy',row),verify:()=>source.verify(row,config.maxAgeSeconds)}));
 }
 async function exits(r){const rows=data.positions.filter(p=>p.runId===r.id&&p.state==='WATCHING');if(!rows.length||!r.exitEnabled)return false;const p=rows[exitCursor++%rows.length];
  try{const q=await gateway.exitQuote(p);guard(r,'sell');p.lastQuoteRaw=q.netBnbRaw;p.lastQuoteAt=clock();p.multiple=Number(BigInt(q.netBnbRaw)*20000n/BigInt(p.costRaw))/10000;
   // Selling half must quote at least the entire cost. This uses executable
   // curve / DEX output, not an unrelated chart's spot price.
   if(BigInt(q.netBnbRaw)<BigInt(p.costRaw)){emit();return false;}
   p.state='SELLING';p.sellIntentId=randomUUID();await persist();guard(r,'sell');
   if(p.mode==='simulate')await finishSell(p,{status:'COMPLETE',halfSold:true});else await finishSell(p,await gateway.sell(p,{active:()=>guard(r,'sell')}));return true;
  }catch(e){p.error=safeCode(e);if(p.error==='GANG_POSITION_CHANGED'||p.state==='SELLING'){p.state='NEEDS_REVIEW';halt();}await persist();return p.state==='NEEDS_REVIEW';}
 }
 async function runTick(){await init();if(busy||!active())return;busy=true;const r=data.run;try{
  if(clock()>=r.expiresAt){r.state='EXPIRED';r.buyEnabled=r.exitEnabled=false;event('GANG_EXPIRED');await persist();return;}
  if(await exits(r)||!active()){await finishIfDone(r);return;}
  if(r.buyEnabled){const found=await source.poll(r.cursor);if(!active()||!r.buyEnabled)return;r.cursor=found.cursor;
   for(const row of found.rows){const key=row.tokenAddress.toLowerCase();if(data.seen.includes(key))continue;if(data.seen.length>=10000||r.queue.length>=200)throw fault('GANG_SOURCE_GAP');data.seen.push(key);r.queue.push(row);}if(found.rows.length)await persist();
   const row=r.queue[0];if(row){try{await buy(r,row);r.queue.shift();await persist();}catch(e){const code=safeCode(e),p=data.positions.find(p=>same(p.tokenAddress,row.tokenAddress)&&p.state==='BUYING');if(!p&&transient.has(code)&&clock()-row.createdAfter<=r.config.maxAgeSeconds*1000){r.lastError=code;emit();}else{r.queue.shift();event(code,row.tokenAddress);if(p){p.state='NEEDS_REVIEW';p.error=code;}if(p||['GANG_SOURCE_REORG','GANG_CONTRACT_CHANGED','GANG_SOURCE_GAP'].includes(code)){r.buyEnabled=r.exitEnabled=false;r.state='PAUSED';}await persist();}}}
   if(r.attempts>=r.config.maxBuys||BigInt(r.reservedRaw)+positive(r.config.perTokenMaxBnb)>positive(r.config.totalMaxBnb)){r.buyEnabled=false;event('GANG_BUDGET_USED');await persist();}
  }
  await finishIfDone(r);
 }catch(e){r.lastError=safeCode(e);if(!transient.has(r.lastError)){r.state='PAUSED';r.buyEnabled=r.exitEnabled=false;}event(r.lastError);await persist();}finally{busy=false;emit();}}
 const tick=()=>tickPromise??=(runTick().finally(()=>{tickPromise=null;}));
 function start(){if(!timer){timer=setInterval(()=>tick().catch(()=>{}),intervalMs);timer.unref?.();}}
 async function stop(){clearInterval(timer);timer=null;await pause();await tickPromise;}
 return {init,state:snapshot,isActive:active,isLive:()=>Boolean(data.run?.config.mode==='live'&&(active()||busy)),draft,arm,pause,reconcile:reconcilePosition,tick,start,stop,subscribe(fn){listeners.add(fn);return ()=>listeners.delete(fn);}};
}
