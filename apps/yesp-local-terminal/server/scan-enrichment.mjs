import {createScanReader} from './scan-details.mjs';
import {createScanMetadata} from './scan-metadata.mjs';
const key=r=>r.platform+':'+r.tokenAddress.toLowerCase()+':'+(r.marketAddress?.toLowerCase()||'');
const signature=r=>JSON.stringify([r.blockHash||null,r.metadataRef||null,r.presetId||null,r.phase??null]);
export function createScanEnrichment({reader=createScanReader(),metadata=createScanMetadata(),clock=Date.now,ttlMs=120000,workers=4}={}){
 const entries=new Map(),queue=[];let active=0,stopped=false;const listeners=new Set();
 const notify=()=>{for(const f of listeners)try{f();}catch{}};
 function state(row){const e=entries.get(key(row));if(!e||e.signature!==signature(row))return {state:'loading'};return {...e.value,state:e.value?'ready':e.error?'error':'loading',error:e.error||null,stale:Boolean(e.error)||Boolean(e.value&&clock()-e.value.chainUpdatedAt>ttlMs*2)};}
 function update(rows){if(stopped)return;const selected=rows.slice(0,500),keys=new Set(selected.map(key));for(const k of entries.keys())if(!keys.has(k))entries.delete(k);
  for(const row of selected){const k=key(row),sig=signature(row);let e=entries.get(k);if(!e||e.signature!==sig){e={signature:sig,value:null,attempt:null,busy:false};entries.set(k,e);}e.row=row;
   if(!e.busy&&(e.attempt===null||clock()-e.attempt>=(e.error?30000:ttlMs))){e.busy=true;e.attempt=clock();queue.push({k,e});}}
  drain();
 }
 function drain(){while(!stopped&&active<workers&&queue.length){const {k,e}=queue.shift();if(entries.get(k)!==e)continue;active++;void (async()=>{
   try{const chain=await reader(e.row);if(entries.get(k)!==e||stopped)return;const old=e.value?.metadataRef===chain.metadataRef?e.value:null;e.value={...old,...chain,metadataStatus:'loading'};e.error=null;notify();
    const meta=await metadata.read(chain.metadataRef,{kind:chain.metadataKind});if(entries.get(k)!==e||stopped)return;e.value={...e.value,...meta,...(meta.metadataStatus!=='ready'&&old?{description:old.description,links:old.links,imageUrl:old.imageUrl,metadataUpdatedAt:old.metadataUpdatedAt}:{})};notify();
   }catch(error){if(entries.get(k)===e){e.error=/^[A-Z][A-Z0-9_]+$/.test(error?.code||'')?error.code:'SCAN_INFO_UNAVAILABLE';notify();}}
   finally{e.busy=false;active--;drain();}
  })();}}
 return {update,state,image:metadata.image,subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},stop(){stopped=true;queue.length=0;}};
}
