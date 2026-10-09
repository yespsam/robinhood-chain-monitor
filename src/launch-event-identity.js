import {createHash} from 'node:crypto';
const deliveryFields=new Set(['observedAt','alertQueuedAt','canonicalSignalId','canonicalSignalIds','tradingPriority','freshness','deliveryEvidenceDigest']);
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
  ?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
export function poolEventProofIdentity(event) {
  const material=Object.fromEntries(Object.entries(event||{}).filter(([key])=>!deliveryFields.has(key)));
  if(material.deliveryPolicy){material.deliveryPolicy={...material.deliveryPolicy};delete material.deliveryPolicy.firstObservedAt;}
  return JSON.stringify(stable(material));
}
export const launchEventDigest=event=>createHash('sha256').update(poolEventProofIdentity(event)).digest('hex');
