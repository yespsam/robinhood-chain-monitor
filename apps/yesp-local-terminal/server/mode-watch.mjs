import {ModeStore} from './mode-store.mjs';
import {createSourceReader,MODE_SOURCES} from './mode-sources.mjs';
import {createModeChain} from './mode-chain.mjs';
import {fault,same} from './flap-reader.mjs';
import {describeModeUpdate} from './mode-report.mjs';
const code=e=>/^[A-Z][A-Z0-9_]{0,80}$/.test(e?.code||'')?e.code:'MODE_READ_FAILED';
const empty=()=>({version:1,sequence:0,platforms:{},modes:[],sources:[],changes:[]});
export function createModeWatch({store=new ModeStore(),chain=createModeChain(),sources=createSourceReader(),clock=Date.now,intervalMs=10000,sourceIntervalMs=300000,artifactIntervalMs=30000}={}){
 let data=empty(),initPromise,chainPromise,sourcePromise,timer=null,lastChainAttempt=0;const listeners=new Set();
 const catalog=()=>({sequence:data.sequence,blocks:Object.fromEntries(Object.entries(data.platforms).filter(([,v])=>v.block&&!v.error).map(([p,v])=>[p,v.block]))});
 const candidates=c=>data.modes.filter(m=>m.platform===c.platform&&(c.platform==='gang'?
  c.chainModeIds?.includes(m.id)||m.reviewedReports?.[c.sourceId]?.includes(c.revision):c.baseline?.blocks?.[c.platform]&&m.newMode&&m.sequence>c.baseline.sequence));
 const currentReport=c=>data.changes.find(x=>x.sourceId===c.sourceId)?.id===c.id;
 const reportState=c=>{const source=data.sources.find(s=>s.id===c.sourceId);if(source?.revision!==c.revision||!currentReport(c))return 'SUPERSEDED';if(source?.error)return 'SOURCE_UNAVAILABLE';
  if(data.platforms[c.platform]?.error)return 'SOURCE_UNAVAILABLE';
  if(c.platform==='gang'){const list=candidates(c),pending=list.filter(m=>!m.first&&!m.firstAlreadyExists);return !pending.length&&list.length?'FIRST_ALREADY_EXISTS':!pending.some(m=>m.adapter&&!m.definitionChanged)?'ADAPTER_REVIEW_REQUIRED':!pending.some(m=>m.adapter&&!m.definitionChanged&&!m.chainError&&m.historyComplete)?'HISTORY_SYNCING':'REVIEW_REQUIRED';}
  return !c.baseline?.blocks?.[c.platform]?'BASELINE_UNAVAILABLE':candidates(c).length?'REVIEW_REQUIRED':'WAITING_MODE';};
 const state=()=>({running:Boolean(timer),updatedAt:Math.max(...Object.values(data.platforms).map(p=>p.updatedAt||0),0),intervalMs,sourceIntervalMs,artifactIntervalMs,sequence:data.sequence,
  platforms:structuredClone(data.platforms),sources:data.sources.map(s=>({...structuredClone(s),summary:describeModeUpdate(s)})),changes:data.changes.map(c=>({...structuredClone(c),summary:describeModeUpdate(c),reviewState:reportState(c),candidateIds:candidates(c).map(m=>m.id)})),modes:structuredClone(data.modes)});
 const emit=()=>{for(const fn of listeners)try{fn(state());}catch{}};
 const persist=async()=>{await store.save(data);emit();};
 async function init(){initPromise??=(async()=>{data=await store.read()||empty();data.changes??=[];})();await initPromise;}
 async function readSources(force=false){await init();if(!Object.keys(data.platforms).length)await refresh();const sourceCatalog=structuredClone(catalog()),now=clock(),due=MODE_SOURCES.filter(s=>{const old=data.sources.find(x=>x.id===s.id);return !old?.catalog||!old?.checkedAt||now-old.checkedAt>=(force?30000:s.kind==='artifact'?artifactIntervalMs:sourceIntervalMs);});
  const results=await Promise.allSettled(due.map(s=>sources.read(s,data.sources.find(x=>x.id===s.id))));
  for(let i=0;i<due.length;i++){const s=due[i],result=results[i],old=data.sources.find(x=>x.id===s.id),row={...old,id:s.id,name:s.name,platform:s.platform,url:s.url,kind:s.kind,checkedAt:now};
   if(result.status==='fulfilled'){
    if(old?.revision&&old.revision!==result.value.revision){
     const report={...result.value,id:s.id+':'+result.value.revision+':'+now,sourceId:s.id,sourceName:s.name,platform:s.platform,at:now,previousRevision:old.revision,baseline:old.catalog||sourceCatalog,status:'REVIEW_REQUIRED'};
     // Reports are evidence only. No source update creates a job or grants trading permission.
     if(!data.changes.some(c=>c.id===report.id))data.changes.unshift(report);
    }
    Object.assign(row,result.value,{catalog:sourceCatalog,error:null,updatedAt:now});
   }else row.error=code(result.reason);
   data.sources=data.sources.filter(x=>x.id!==s.id);data.sources.push(row);
  }
  data.changes=data.changes.slice(0,100);if(due.length)await persist();
 }
 function refreshSources(force=false){if(sourcePromise)return sourcePromise;sourcePromise=readSources(force).finally(()=>{sourcePromise=null;});return sourcePromise;}
 async function readChain(only){await init();lastChainAttempt=clock();
  const discovered=data.sources.find(s=>s.id==='flap-agent-app'&&!s.error)?.deployment;
  const names=['four','flap',...(chain.gang?['gang']:[])].filter(p=>!only||p===only),results=await Promise.allSettled(names.map(p=>p==='flap'?chain.flap(discovered):chain[p]()));
  for(let i=0;i<names.length;i++){
   const platform=names[i],result=results[i],previous=data.platforms[platform];
   if(result.status==='rejected'){data.platforms[platform]={...previous,error:code(result.reason),checkedAt:clock()};if(platform==='gang'){const source=data.sources.find(s=>s.id==='gang-deployments');if(source)source.error=code(result.reason);}continue;}
   const snapshot=result.value,ids=new Set(snapshot.rows.map(r=>r.id)),changedIds=snapshot.rows.filter(r=>{const old=data.modes.find(m=>m.id===r.id);return !old||old.fingerprint!==r.fingerprint||old.ready!==r.ready;}).map(r=>r.id);
   if(previous?.block){try{await chain.canonical(previous.block);}catch(e){data.platforms[platform]={...previous,error:code(e),checkedAt:clock()};continue;}}
   for(const row of snapshot.rows){
    const old=data.modes.find(m=>m.id===row.id);
    if(old){
     const firstAdapterReview=!old.adapter&&row.adapter&&(old.platform==='flap'&&['factory','portal','reader'].every(k=>same(old[k],row[k]))||old.platform==='gang'&&same(old.manager,row.manager)&&old.factory===row.factory);
     const definitionChanged=old.fingerprint!==row.fingerprint&&!firstAdapterReview;
     Object.assign(old,row,{definitionChanged:old.definitionChanged||definitionChanged,lastSeen:clock(),chainError:null});
     if(definitionChanged){old.ready=false;old.reason='MODE_DEFINITION_CHANGED';}
     if(old.definitionChanged){old.ready=false;old.reason='MODE_DEFINITION_CHANGED';}
     if(row.platform==='flap'&&row.tokenCount===0)old.emptyBlock=snapshot.block;
    }else{
     const isNew=Boolean(previous?.block)&&!previous.ids.includes(row.id);
     const mode={...row,newMode:isNew,sequence:++data.sequence,discoveredAt:clock(),lastSeen:clock(),absence:isNew&&platform==='four'?previous.block:null,
      emptyBlock:platform==='flap'&&row.tokenCount===0?snapshot.block:null,first:null,chainError:null,definitionChanged:false};
     if(platform==='flap'&&row.tokenCount>0)mode.firstAlreadyExists=true;
     data.modes.push(mode);
    }
   }
   for(const m of data.modes.filter(m=>m.platform===platform&&!ids.has(m.id))){m.ready=false;m.reason='MODE_REMOVED';}
   data.platforms[platform]={block:snapshot.block,ids:[...ids],updatedAt:clock(),error:null};
   if(platform==='gang'){
    const old=data.sources.find(s=>s.id==='gang-deployments'),now=clock(),revision=snapshot.revision;
    const source={id:'gang-deployments',name:'Gang 官方链上注册目录',platform:'gang',kind:'chain',url:'https://github.com/gangfun/gang-launchpad/blob/main/docs/MAINNET-PAD-REGISTRY-2026-10-28.md',revision,checkedAt:now,updatedAt:now,error:null,title:'Gang 链上模式目录核验'};
    if(!old||old.revision!==revision){data.changes.unshift({id:'gang-deployments:'+revision+':'+now,sourceId:source.id,sourceName:source.name,platform:'gang',revision,previousRevision:old?.revision||null,at:now,link:source.url,title:old?'Gang 链上模式目录发生变化':'Gang 链上模式目录已接入',description:'模式身份来自官方注册目录与本地核验的代码。首币按完整发行历史判断；未核验合约只报告，不启用交易。',baseline:{sequence:data.sequence,blocks:{gang:previous?.block||snapshot.block}},chainModeIds:old?changedIds:[...ids],status:'REVIEW_REQUIRED'});}
    data.sources=data.sources.filter(s=>s.id!==source.id);data.sources.push(source);data.changes=data.changes.slice(0,100);
    for(const m of data.modes.filter(m=>m.platform==='gang'&&m.adapter&&!m.definitionChanged&&!m.first&&m.reason!=='MODE_REMOVED')){
     try{const result=await chain.earliest(m);if(result.first)m.first={...result.first,foundAt:clock()};m.coveredThrough=result.through;m.coveredHash=result.throughHash;m.historyComplete=result.complete;m.chainError=null;}catch(e){m.chainError=code(e);}
    }
   }
  }
  if(data.modes.length>2000)throw fault('MODE_CATALOG_LIMIT');await persist();
 }
 function refresh(only){if(chainPromise)return chainPromise;chainPromise=readChain(only).finally(()=>{chainPromise=null;});return chainPromise;}
 async function baseline(modeId='next'){
  await refresh();for(const p of ['four','flap'])if(!data.platforms[p]?.block||data.platforms[p].error)throw fault('MODE_BASELINE_UNAVAILABLE');
  if(modeId!=='next'){
   const m=data.modes.find(m=>m.id===modeId);if(!m?.newMode)throw fault('MODE_NOT_NEW');
   const result=await resolve(m.id);if(result.first||m.firstAlreadyExists)throw fault('MODE_FIRST_ALREADY_EXISTS');
  }
  return {sequence:data.sequence,at:clock(),modeId,blocks:Object.fromEntries(Object.entries(data.platforms).map(([p,v])=>[p,v.block]))};
 }
 async function choose(baseline){await init();if(clock()-lastChainAttempt>=intervalMs)await refresh();
  if(baseline.reportId){await checkReport(baseline.reportId,baseline.modeId,baseline.fingerprint);return structuredClone(data.modes.find(m=>m.id===baseline.modeId));}
  for(const p of ['four','flap'])if(data.platforms[p]?.error||!data.platforms[p]?.updatedAt||clock()-data.platforms[p].updatedAt>45000)throw fault('MODE_CATALOG_STALE');
  const choices=data.modes.filter(m=>m.newMode&&(baseline.modeId==='next'?m.sequence>baseline.sequence:m.id===baseline.modeId));
  return choices.sort((a,b)=>a.sequence-b.sequence)[0]||null;
 }
 async function checkReport(reportId,modeId,fingerprint){await init();
  const report=data.changes.find(c=>c.id===reportId);if(!report)throw fault('MODE_REPORT_REQUIRED');
  const source=data.sources.find(s=>s.id===report.sourceId);
  if(source?.revision!==report.revision||!currentReport(report))throw fault('MODE_REPORT_SUPERSEDED');
  if(source.error||!source.updatedAt||clock()-source.updatedAt>(source.kind==='artifact'?artifactIntervalMs:sourceIntervalMs)+45000)throw fault('MODE_SOURCE_STALE');
  if(report.platform!=='gang'&&!report.baseline?.blocks?.[report.platform])throw fault('MODE_BASELINE_UNAVAILABLE');
  const mode=candidates(report).find(m=>m.id===modeId);if(!mode)throw fault('MODE_REPORT_TARGET_INVALID');
  if(data.platforms[mode.platform]?.error||clock()-data.platforms[mode.platform].updatedAt>45000)throw fault('MODE_CATALOG_STALE');
  if(mode.definitionChanged||fingerprint&&mode.fingerprint!==fingerprint||mode.reason==='MODE_REMOVED')throw fault('MODE_DEFINITION_CHANGED');
  if(!mode.adapter)throw fault('MODE_ADAPTER_REQUIRED');
  return {report,mode};
 }
 async function authorize(reportId,modeId,fingerprint){
  await refreshSources();await refresh();const {report,mode}=await checkReport(reportId,modeId,fingerprint);
  if(mode.first||mode.firstAlreadyExists)throw fault('MODE_FIRST_ALREADY_EXISTS');
  const resolved=await resolve(modeId);if(resolved.first||resolved.firstAlreadyExists||resolved.platform==='flap'&&resolved.tokenCount>0)throw fault('MODE_FIRST_ALREADY_EXISTS');
  if(!resolved.historyComplete)throw fault('MODE_HISTORY_INCOMPLETE');
  await chain.canonical(report.baseline?.blocks?.[mode.platform]||data.platforms[mode.platform].block);
  await checkReport(reportId,modeId,mode.fingerprint);
  return {sequence:data.sequence,at:clock(),modeId,reportId,fingerprint:mode.fingerprint,blocks:structuredClone(catalog().blocks),
   report:{id:report.id,title:report.title,sourceName:report.sourceName,revision:report.revision,link:report.link,platform:report.platform},modeName:mode.name};
 }
 async function resolve(id){await init();const mode=data.modes.find(m=>m.id===id);if(!mode)throw fault('MODE_NOT_FOUND');
  if(mode.definitionChanged)throw fault('MODE_DEFINITION_CHANGED');
  if(mode.firstAlreadyExists)throw fault('MODE_FIRST_ALREADY_EXISTS');
  try{
   if(mode.first){await chain.verifyFirst(mode,mode.first);return structuredClone(mode);}
   if(mode.platform==='flap'&&!mode.emptyBlock){if(!mode.adapter)return structuredClone(mode);throw fault('MODE_HISTORY_UNVERIFIED');}
   if(mode.emptyBlock)await chain.canonical(mode.emptyBlock);
   const result=await chain.earliest(mode);
   if(result.first){mode.first={...result.first,foundAt:clock()};}
   mode.coveredThrough=result.through;mode.coveredHash=result.throughHash;mode.historyComplete=result.complete;mode.chainError=null;await persist();return structuredClone(mode);
  }catch(e){mode.chainError=code(e);await persist();throw e;}
 }
 async function verify(id,fingerprint,first){await init();await refresh(data.modes.find(m=>m.id===id)?.platform==='gang'?'gang':undefined);const m=data.modes.find(m=>m.id===id);
  if(!m||!m.ready||m.definitionChanged||m.fingerprint!==fingerprint||data.platforms[m.platform]?.error)throw fault('MODE_DEFINITION_CHANGED');
  if(!m.first||!same(m.first.tokenAddress,first.tokenAddress))throw fault('MODE_FIRST_CHANGED');await chain.verifyFirst(m,first);return structuredClone(m);
 }
 function start(){if(timer)return;timer=setInterval(()=>{void refreshSources().catch(()=>{});void refresh().catch(()=>{});},intervalMs);timer.unref?.();void refreshSources().then(()=>refresh()).catch(()=>{});}
 async function stop(){if(timer)clearInterval(timer);timer=null;await Promise.allSettled([sourcePromise,chainPromise]);}
 return {state,init,refresh,refreshSources,baseline,choose,resolve,verify,authorize,checkReport,start,stop,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);}};
}
