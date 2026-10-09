import {normalizeFlapQuotePoolLifecycleRecord} from './bsc-launchpad-monitor.js';

export const PAPER_FLAP_LIFECYCLE='paper_flap_quote_lifecycle_v1';
export function launchLifecycle(event) {
  if(event?.type!==PAPER_FLAP_LIFECYCLE||Object.keys(event).sort().join(',')!=='lifecycle,observedAt,type'
    ||!Number.isFinite(Date.parse(event.observedAt)))return null;
  try {return normalizeFlapQuotePoolLifecycleRecord(event.lifecycle);}catch{return null;}
}
const position=x=>[x.blockNumber,x.transactionIndex,x.logIndex];
const compare=(a,b)=>{for(let i=0;i<3;i++)if(a[i]!==b[i])return a[i]-b[i];return 0;};
const identity=r=>`${r.activationEventKey}:${r.blockHash}`;
const generation=r=>`quote:${r.quoteAddress}:generation:${r.blockHash}:${r.transactionHash}:${r.logIndex}`;

// Local producer lifecycle records can only veto an entry, never create one.
// Undo records suppress their orphaned transition, but also veto tokens from
// the orphaned activation itself. Canonical replacements retain distinct hashes.
export function flapLifecycleVeto(events,tokenEvent,nowMs) {
  const rows=events.flatMap(event=>{
    const r=launchLifecycle(event);
    return r&&r.quoteAddress===tokenEvent.mode.quoteAsset&&Date.parse(event.observedAt)<=nowMs
      &&Date.parse(r.occurredAt)<=nowMs?[r]:[];
  });
  const undone=new Set(rows.filter(r=>['reverted','restored'].includes(r.action)).map(identity));
  if(rows.some(r=>r.action==='reverted'&&generation(r)===tokenEvent.featureGenerationKey))return true;
  const origin=tokenEvent.featureActivationProof||tokenEvent;
  return rows.some(r=>!undone.has(identity(r))&&['activated','reconfigured','disabled'].includes(r.action)
    &&generation(r)!==tokenEvent.featureGenerationKey&&compare(position(r),position(origin))>0);
}
