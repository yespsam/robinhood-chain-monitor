import test from 'node:test';
import assert from 'node:assert/strict';
import {classifyGmgnReadError} from '../src/gmgn-read-error.js';
import {createReadonlyMarketClient} from '../src/gmgn-readonly-market.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

test('read errors expose only allowlisted categories, never sensitive diagnostics',()=>{
  for(const [stderr,want] of [['fetch failed: ECONNRESET secret-token','GMGN_NETWORK_FAILED'],
    ['HTTP 403 Authorization: secret-token','GMGN_AUTH_FAILED'],['HTTP status: 503 secret-token','GMGN_UPSTREAM_FAILED']])
    assert.equal(classifyGmgnReadError({stderr}),want);
  assert.equal(classifyGmgnReadError({stderr:'arbitrary response secret-token'}),null);
});

test('network/config failures remain unavailable and recover with fresh data; no automatic request replay',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'gmgn-read-errors-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  let clock=Date.parse('2026-10-05T05:00:00Z'),fault='network',calls=0;
  const c=createReadonlyMarketClient({dataDir:dir,now:()=>clock,ttlMs:0,
    scheduler:{lastStartedAt:null,rateLimitedUntil:0},sleepImpl:async ms=>{clock+=ms;},
    execFileImpl:async(_file,args)=>{
      if(args[0]==='config'){if(fault==='config')throw {code:1,stderr:'secret-token'};return {stdout:''};}
      calls++;if(fault==='network')throw {code:1,stderr:'fetch failed ECONNRESET secret-token'};
      return {stdout:JSON.stringify({data:{rank:[]}})};
    }});
  try {
    const a=await c.trending({chain:'bsc'});assert.equal(a.reasonCode,'GMGN_NETWORK_FAILED');assert.equal(calls,1);
    fault='config';clock+=60000;const b=await c.trending({chain:'bsc'});assert.equal(b.reasonCode,'GMGN_CONFIG_FAILED');assert.equal(calls,1);
    fault=null;clock+=60000;const d=await c.trending({chain:'bsc'});assert.equal(d.status,'ok');assert.equal(calls,2);
    assert.equal(d.observedAt,new Date(clock).toISOString());
    assert.ok(!JSON.stringify(c.diagnostics()).includes('secret-token'));
  }finally{await c.close();}
});
