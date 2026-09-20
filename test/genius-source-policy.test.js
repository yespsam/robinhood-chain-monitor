import test from "node:test";
import assert from "node:assert/strict";
import { isStrictGeniusEvent, geniusDocumentChangesHash, GENIUS_DOCUMENT_MAX_EVIDENCE_BYTES } from "../src/genius-source-policy.js";

const stamp="2026-09-20T04:00:00.000Z";
function event(changes=[{field:"initialConfig.launchFee",before:"2000",after:"3000"}]) {
  const sourceId="genius_manifest",sourceUrl="https://genius.fun/contracts/manifest.json";
  const beforeHash="a".repeat(64),afterHash="b".repeat(64);
  return {type:"genius_fun_update",platform:"geniusfun",chainId:56,sourceTrust:"official_verified",
    kind:"manifest_update",sourceId,sourceUrl,eventKey:`genius:${sourceId}:${beforeHash}:${afterHash}`,
    observedAt:stamp,sourceOccurredAt:stamp,observationOnly:true,aggregation:"complete_transition",
    changeCount:changes.length,changes,evidence:{sourceUrl,beforeHash,afterHash,changesHash:geniusDocumentChangesHash(changes)}};
}

test("complete Genius transition validates every entry and binds count, digest and original timestamp",()=>{
  const changes=Array.from({length:2000},(_,i)=>({field:`assets.${i}.enabled`,before:false,after:true}));
  const valid=event(changes); assert.equal(isStrictGeniusEvent(valid),true);
  for(const mutation of [
    {changes:changes.slice(0,-1)}, {changeCount:1999}, {sourceOccurredAt:undefined},
    {sourceOccurredAt:"bad"}, {observationOnly:false}, {partIndex:0,eventKey:`${valid.eventKey}:0`},
    {aggregation:"partial"}, {evidence:{...valid.evidence,changesHash:"c".repeat(64)}},
    {changes:[...changes,{field:"late",before:1,after:2}]},
    {changes:[...changes.slice(0,-1),{field:"late",before:1}]},
  ]) assert.equal(isStrictGeniusEvent({...valid,...mutation}),false);
  const modified=structuredClone(valid); modified.changes[1999].after=false;
  assert.equal(isStrictGeniusEvent(modified),false);
});

test("nested JSON evidence is bounded and cannot silently erase unsupported values",()=>{
  const cycle={};cycle.self=cycle;
  let deep={fee:1};for(let n=0;n<40;n++)deep={nested:deep};
  for(const value of [undefined,NaN,Infinity,1n,()=>{},new Date(),cycle,deep]) {
    assert.equal(geniusDocumentChangesHash([{field:"deployment",before:null,after:value}]),null);
  }
  const long=[{field:"deployment",before:null,after:{metadata:"x".repeat(GENIUS_DOCUMENT_MAX_EVIDENCE_BYTES)}}];
  assert.equal(geniusDocumentChangesHash(long),null);
  const nested=event([{field:"stacks.new",before:null,after:{address:`0x${"1".repeat(40)}`,permissions:{launchEnabled:false},fee:2}}]);
  assert.equal(isStrictGeniusEvent(nested),true);
});

test("canonical digest is object-order independent but includes all original evidence",()=>{
  const a=[{field:"deployment",before:null,after:{fee:2,address:"value"}}];
  const b=[{after:{address:"value",fee:2},before:null,field:"deployment"}];
  assert.equal(geniusDocumentChangesHash(a),geniusDocumentChangesHash(b));
  b[0].after.fee=3;assert.notEqual(geniusDocumentChangesHash(a),geniusDocumentChangesHash(b));
});

test("legacy two-field parts remain accepted, but a widened or inconsistent old part is rejected",()=>{
  const original=event(),{aggregation,...old}=original; delete old.evidence.changesHash;
  old.changeCount=3;old.partIndex=1;
  old.eventKey=original.eventKey+":1";
  assert.equal(isStrictGeniusEvent(old),true);
  assert.equal(isStrictGeniusEvent({...old,changeCount:2}),false);
  assert.equal(isStrictGeniusEvent({...old,changes:[...old.changes,...old.changes]}),false);
  const wide={...old,changeCount:5,partIndex:0,eventKey:original.eventKey+":0",changes:Array(3).fill(old.changes[0])};
  assert.equal(isStrictGeniusEvent(wide),false);
});
