import fs from 'node:fs/promises';
import path from 'node:path';
import {isStrictFlapTrackedPoolTokenUpdate,isStrictFlapPortalQuoteAssetUpdate} from './source-controls.js';
import {launchLifecycle} from './paper-launch-lifecycle.js';

export const LAUNCH_EVIDENCE_FILE='paper-launch-evidence.json';
export const LAUNCH_EVIDENCE_VERSION='canonical_launch_evidence_v1';
export const LAUNCH_EVIDENCE_MAX_BYTES=4*1024*1024;
const supported=e=>isStrictFlapTrackedPoolTokenUpdate(e)||isStrictFlapPortalQuoteAssetUpdate(e)||!!launchLifecycle(e);
const time=e=>Date.parse(e?.observedAt||e?.blockTimestamp||'');

// A small canonical-event projection, independent of Telegram delivery and its
// unbounded historical outbox. It grants research access only, never a fill.
// One instance belongs to the main alert dispatcher; serialize overlapping
// producers so two updates cannot overwrite one another.
export function createPaperLaunchEvidenceWriter(dataDir,{now=Date.now}={}) {
  const file=path.join(dataDir,LAUNCH_EVIDENCE_FILE);
  let tail=Promise.resolve();
  return event=>{
    if(!supported(event))return Promise.resolve(false);
    const snapshot=structuredClone(event);
    const run=tail.then(async()=>{
      const at=now();let previous={};
      try {
        const stat=await fs.stat(file);
        if(stat.size>LAUNCH_EVIDENCE_MAX_BYTES)throw Error('launch evidence exceeds bound');
        previous=JSON.parse(await fs.readFile(file,'utf8'));
        if(previous.version!==LAUNCH_EVIDENCE_VERSION)throw Error('launch evidence version mismatch');
      } catch(error) {if(error.code!=='ENOENT')throw error;}
      const events=(Array.isArray(previous.events)?previous.events:[]).filter(e=>supported(e)
        &&Number.isFinite(time(e))&&time(e)<=at&&at-time(e)<=600000);
      // Identical retries retain their original timestamps. Conflicting payloads
      // remain visible to the consumer, rather than last-write-wins admission.
      if(!events.some(e=>JSON.stringify(e)===JSON.stringify(snapshot)))events.push(snapshot);
      events.sort((a,b)=>time(a)-time(b));
      const priorGap=Date.parse(previous.coverage?.gapUntil||'');
      let dropped=priorGap>at?Number(previous.coverage?.dropped)||0:0;
      let gapUntil=priorGap>at?priorGap:null;
      const newlyDropped=Math.max(0,events.length-256);
      dropped+=newlyDropped;
      if(newlyDropped)gapUntil=at+120000;
      const retained=events.slice(-256);
      const state={version:LAUNCH_EVIDENCE_VERSION,updatedAt:new Date(at).toISOString(),events:retained,
        coverage:{scope:'verified_flap_producer_events_only',dropped,complete:gapUntil===null,
          gapUntil:gapUntil===null?null:new Date(gapUntil).toISOString()}};
      let raw=JSON.stringify(state);
      while(Buffer.byteLength(raw)>LAUNCH_EVIDENCE_MAX_BYTES&&retained.length){retained.shift();state.coverage.dropped=++dropped;
        state.coverage.complete=false;state.coverage.gapUntil=new Date(at+120000).toISOString();raw=JSON.stringify(state);}
      await fs.mkdir(dataDir,{recursive:true});
      const temporary=`${file}.${process.pid}.tmp`;
      const handle=await fs.open(temporary,'w',0o600);
      try {await handle.writeFile(raw);await handle.sync();}finally{await handle.close();}
      await fs.rename(temporary,file);
      return true;
    });
    tail=run.catch(()=>{});
    return run;
  };
}
