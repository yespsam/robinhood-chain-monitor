import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createReadonlyMarketClient } from '../src/gmgn-readonly-market.js';
import { createGmgnFlowClient } from '../src/gmgn-flow-client.js';

const rankItem = {
  chain: 'bsc', address: '0xabc12345', name: 'Example', symbol: 'EX', price: 0.12,
  price_change_percent: 4.5, market_cap: 1200000, liquidity: 80000, volume: 25000,
  swaps: 42, buys: 25, sells: 17, holder_count: 900, smart_degen_count: 5,
  renowned_count: 2, rug_ratio: 0, is_honeypot: 0, is_wash_trading: false,
  is_open_source: 1, is_renounced: 1, creator_token_status: 'creator_close', creator_close: true,
  launchpad_platform: 'geniusfun', creation_timestamp: 1700000000,
};

test('entry confirmations use the bounded critical lane and are not captured by pending research quotes',async()=>{
  const address=`0x${'a'.repeat(40)}`,start=1790000000000;let clock=start;const calls=[];
  const client=createReadonlyMarketClient({now:()=>clock,runner:(args,options)=>new Promise(resolve=>{
    options.onRequestStart(clock);calls.push({priority:options.priority,resolve});
  })});
  const payload=JSON.stringify({data:{address,price:{price:1}}});
  const research=client.quote({chain:'base',address,purpose:'learning'});
  await new Promise(resolve=>setImmediate(resolve));
  const urgent=client.quote({chain:'base',address,purpose:'entry_confirmation'});
  const duplicate=client.quote({chain:'base',address,purpose:'entry_confirmation'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(c=>c.priority),[0,2]);
  clock+=1000;calls[1].resolve(payload);
  const a=await urgent;assert.deepEqual(await duplicate,a);assert.equal(a.observedAt,new Date(start).toISOString());
  clock+=3000;
  const second=client.quote({chain:'base',address,purpose:'entry_confirmation',afterObservedAt:a.observedAt});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(calls.length,3);assert.equal(calls[2].priority,2);
  calls[2].resolve(payload);const b=await second;assert.notEqual(b.observedAt,a.observedAt);
  calls[0].resolve(payload);await research;
});

test('zero can_sell is not inverted into a cannot-sell claim; affirmative danger stays blocked',async()=>{
  const address=`0x${'a'.repeat(40)}`;
  for(const [canSell,canNotSell,expected] of [[0,0,null],[false,false,null],[0,undefined,null],[1,0,null],[0,1,true],[1,1,true]]){
    const client=createReadonlyMarketClient({runner:async args=>JSON.stringify({data:args[1]==='info'
      ?{address,price:{price:1}}:{address,is_honeypot:false,can_sell:canSell,can_not_sell:canNotSell}})});
    const result=await client.details({chain:'bsc',address});
    assert.equal(result.status,'ok');assert.equal(result.token.cannotSell,expected);
    assert.equal(result.token.isHoneypot,false);assert.ok(result.token.sellabilityFlags);
    assert.match(result.token.sellabilityFlags.interpretation,/非买卖模拟/);
  }
});

test('candidate quote and details share only the same in-flight token-info, without renewing timestamps or skipping security', async () => {
  const address=`0x${'a'.repeat(40)}`,start=1790000000000;let clock=start,release;const calls=[];
  const client=createReadonlyMarketClient({quoteTtlMs:0,now:()=>clock,runner:(args,options)=>{
    calls.push(args[1]);options.onRequestStart?.(clock);
    if(args[1]==='info')return new Promise(resolve=>{release=()=>resolve(JSON.stringify({data:{address,price:{price:1}}}));});
    return JSON.stringify({data:{is_honeypot:false}});
  }});
  const detail=client.details({chain:'base',address,purpose:'candidate'});
  await new Promise(resolve=>setImmediate(resolve));clock+=1000;
  const quote=client.quote({chain:'base',address});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['info','security'],'info is shared; independent security already runs alongside it');
  clock+=1000;release();const [d,q]=await Promise.all([detail,quote]);
  assert.deepEqual(calls,['info','security']);assert.equal(d.status,'ok');assert.equal(q.status,'ok');
  assert.equal(q.observedAt,new Date(start).toISOString());assert.equal(d.observedAt,q.observedAt);
  const next=client.quote({chain:'base',address});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls,['info','security','info'],'an independent confirmation needs another real observation');
  release();await next;
});

test('pending low-priority detail info cannot capture an exit request and wrong identities are never shared as valid', async () => {
  const address=`0x${'a'.repeat(40)}`,calls=[];
  const client=createReadonlyMarketClient({runner:(args,options)=>{
    if(args[1]==='info')return new Promise(resolve=>calls.push({priority:options.priority,resolve}));
    return JSON.stringify({data:{is_honeypot:false}});
  }});
  const detail=client.details({chain:'base',address});await new Promise(resolve=>setImmediate(resolve));
  const quote=client.quote({chain:'base',address,purpose:'exit'});await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(calls.map(c=>c.priority),[0,2]);
  for(const call of calls)call.resolve(JSON.stringify({data:{address:`0x${'b'.repeat(40)}`,price:{price:1}}}));
  const results=await Promise.all([detail,quote]);assert.ok(results.every(r=>r.status==='unavailable'));
});

test('parallel detail reads preserve the older component time and wait for both results', async () => {
  const address=`0x${'a'.repeat(40)}`,start=1790000000000,releases={};let clock=start;
  const client=createReadonlyMarketClient({now:()=>clock,runner:(args,options)=>{
    options.onRequestStart(args[1]==='info'?start+3000:start);
    return new Promise(resolve=>{releases[args[1]]=()=>resolve(JSON.stringify({data:args[1]==='info'?{address,price:{price:1}}:{address,is_honeypot:false}}));});
  }});
  let finished=false;const task=client.details({chain:'bsc',address}).then(result=>{finished=true;return result;});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(Object.keys(releases).sort(),['info','security']);
  releases.info();await new Promise(resolve=>setImmediate(resolve));assert.equal(finished,false);
  clock=start+5000;releases.security();const result=await task;
  assert.equal(result.observedAt,new Date(start).toISOString());
  assert.equal(result.infoObservedAt,new Date(start+3000).toISOString());
  assert.equal(result.securityObservedAt,new Date(start).toISOString());
});

test('documented empty rank tax means zero, while absent tax and other endpoint blanks stay unknown', async () => {
  for (const [raw, expected] of [['', 0], [null, null], [undefined, null], ['0.03', '0.03']]) {
    const client = createReadonlyMarketClient({ runner: async () => JSON.stringify({ data: { rank: [{ ...rankItem, buy_tax: raw, sell_tax: raw }] } }) });
    const rank = await client.trending({ chain: 'bsc' });
    assert.equal(rank.tokens[0].buyTax, expected); assert.equal(rank.tokens[0].sellTax, expected);
  }
  const address = `0x${'a'.repeat(40)}`;
  const detail = createReadonlyMarketClient({ runner: async args => JSON.stringify({ data: args[1] === 'info'
    ? { address, price: { price: 1 } } : { buy_tax: '', sell_tax: '' } }) });
  const token = (await detail.details({ chain: 'bsc', address })).token;
  assert.equal(token.buyTax, ''); assert.equal(token.sellTax, '');
  const trench = createReadonlyMarketClient({ runner: async () => JSON.stringify({ data: { new_creation: [{ ...rankItem, buy_tax: '', sell_tax: '' }], pump: [], completed: [] } }) });
  const launch = (await trench.trenches({ chain: 'bsc' })).tokens[0];
  assert.equal(launch.buyTax, ''); assert.equal(launch.sellTax, '');
});

test('flow-discovered research binds info/security, preserves unknowns and does not renew old evidence', async () => {
  const address = `0x${'a'.repeat(40)}`, start = 1790000000000; let clock = start, fail = false; const calls = [];
  const client = createReadonlyMarketClient({ now: () => clock, runner: async args => {
    calls.push(args[1]); clock += 1000;
    if (fail) throw new Error('upstream failed');
    return JSON.stringify({ code: 0, data: args[1] === 'info'
      ? { chain: 'base', address, price: { price: '1.2', volume_1h: '10000' }, pool: { liquidity: '70000' }, stat: { top_10_holder_rate: '.2' } }
      : { is_honeypot: 'no', buy_tax: '0', sell_tax: '0' } });
  } });
  const result = await client.details({ chain: 'base', address });
  assert.deepEqual(calls, ['info', 'security']); assert.equal(result.token.price, 1.2); assert.equal(result.token.liquidity, 70000);
  assert.equal(result.token.isHoneypot, false); assert.equal(result.token.isWashTrading, null); assert.equal(result.token.rugRatio, null);
  assert.equal(result.token.top10HolderRate, .2); assert.equal(result.observedAt, new Date(start).toISOString());
  clock += 61000; fail = true; const stale = await client.details({ chain: 'base', address });
  assert.equal(stale.status, 'stale'); assert.equal(stale.observedAt, result.observedAt);
});

test('flow research rejects wrong-chain, wrong-address and errored security responses', async () => {
  const address = `0x${'a'.repeat(40)}`;
  for (const security of [{ data: { chain: 'eth' } }, { data: { address: `0x${'b'.repeat(40)}` } }, { code: 403 }, { data: [] }]) {
    const client = createReadonlyMarketClient({ runner: async args => JSON.stringify(args[1] === 'info' ? { data: { address, price: { price: '1' } } } : security) });
    assert.equal((await client.details({ chain: 'base', address })).status, 'unavailable');
  }
});

test('candidate details and charts receive bounded priority without changing their observation times', async () => {
  const address = `0x${'a'.repeat(40)}`, start = 1790000000000; let clock = start; const calls = [];
  const client = createReadonlyMarketClient({ now: () => clock, runner: async (args, options) => {
    calls.push({ route: args[1], priority: options?.priority }); options?.onRequestStart?.(clock); clock += 1000;
    return JSON.stringify({ code: 0, data: args[1] === 'info' ? { address, price: { price: 1 }, liquidity: 60000 }
      : args[1] === 'security' ? { is_honeypot: false } : { list: [] } });
  } });
  const result = await client.details({ chain: 'base', address, purpose: 'candidate' });
  assert.deepEqual(calls, [{ route: 'info', priority: 1 }, { route: 'security', priority: 1 }]);
  assert.equal(result.observedAt, new Date(start).toISOString());
  await client.details({ chain: 'base', address, purpose: 'candidate' }); assert.equal(calls.length, 2);
  clock += 31000; await client.details({ chain: 'base', address, purpose: 'candidate' }); assert.equal(calls.length, 4);
  await client.kline({ chain: 'base', address, purpose: 'candidate' }); assert.equal(calls.at(-1).priority, 1);
});

test('token quote uses documented nested price, bounded cache and conservative unrenewed timestamps', async () => {
  let clock = 1790000000000, calls = 0, fail = false;
  const address = `0x${'a'.repeat(40)}`;
  const client = createReadonlyMarketClient({ now: () => clock, runner: async args => {
    calls++; assert.deepEqual(args, ['token', 'info', '--chain', 'robinhood', '--address', address, '--raw']);
    if (fail) throw new Error('unavailable');
    clock += 200; return JSON.stringify({ code: 0, data: { chain: 'robinhood', address, price: { price: '1.25' } } });
  } });
  const first = await client.quote({ chain: 'robinhood', address });
  assert.equal(first.price, 1.25); assert.equal(first.timestampKind, 'local_request');
  assert.equal(Date.parse(first.receivedAt) - Date.parse(first.observedAt), 200);
  await client.quote({ chain: 'robinhood', address }); assert.equal(calls, 1);
  clock += 3001; fail = true;
  const stale = await client.quote({ chain: 'robinhood', address });
  assert.equal(stale.status, 'stale'); assert.equal(stale.observedAt, first.observedAt);
});

test('confirmation reads skip only successful cached observations, retaining dedup, priority and failure backoff',async()=>{
  let clock=1790000000000,calls=0,fail=false,release;
  const address=`0x${'a'.repeat(40)}`;
  const client=createReadonlyMarketClient({now:()=>clock,runner:async(args,options)=>{
    calls++;assert.equal(options.priority,1);options.onRequestStart(clock);
    clock+=4000;if(release)await release.promise;if(fail)throw new Error('unavailable');
    return JSON.stringify({data:{address,price:{price:1+calls*.001}}});
  }});
  const args={chain:'base',address,purpose:'candidate'},a=await client.quote(args);
  assert.equal((await client.quote(args)).observedAt,a.observedAt);assert.equal(calls,1);
  release={};release.promise=new Promise(r=>release.resolve=r);
  const b=client.quote({...args,afterObservedAt:a.observedAt}),shared=client.quote({...args,afterObservedAt:a.observedAt});
  release.resolve();const [x,y]=await Promise.all([b,shared]);
  assert.equal(calls,2);assert.deepEqual(x,y);assert.notEqual(x.observedAt,a.observedAt);
  fail=true;release=null;
  const stale=await client.quote({...args,afterObservedAt:x.observedAt});assert.equal(calls,3);assert.equal(stale.status,'stale');
  await client.quote({...args,afterObservedAt:x.observedAt});assert.equal(calls,3,'failure cooldown may not be bypassed');
});

test('observational narrative follow-ups use lower priority than entry and exit quotes', async () => {
  const priorities=[],address=`0x${'a'.repeat(40)}`;
  const client=createReadonlyMarketClient({quoteTtlMs:0,runner:async(args,options)=>{
    priorities.push(options.priority);return JSON.stringify({data:{address,price:{price:1}}});
  }});
  for(const purpose of ['learning','candidate','exit'])await client.quote({chain:'base',address,purpose});
  assert.deepEqual(priorities,[0,1,2]);
});

test('quote rejects mismatched identities and missing/nonpositive nested prices', async () => {
  const address = `0x${'a'.repeat(40)}`;
  for (const data of [
    { address: `0x${'b'.repeat(40)}`, price: { price: '1' } }, { address, chain: 'base', price: { price: '1' } },
    { address, price: 1 }, { address, price: { price: '0' } }, { address, price: { price: null } },
    { price: { price: '1' } },
  ]) {
    const client = createReadonlyMarketClient({ runner: async () => JSON.stringify({ code: 0, data }) });
    assert.equal((await client.quote({ chain: 'robinhood', address })).status, 'unavailable');
    await assert.rejects(client.quote({ chain: 'robinhood', address: '0xabc' }), /invalid address/);
  }
});

test('quote failures expose safe actionable reason codes without leaking CLI diagnostics or renewing stale prices', async () => {
  const address = `0x${'a'.repeat(40)}`;
  for (const code of ['GMGN_REQUEST_BUSY', 'GMGN_RATE_LIMITED', 'GMGN_CLI_TIMEOUT', 'GMGN_STATE_INVALID', 'untrusted']) {
    let clock = 1790000000000, fail = false;
    const client = createReadonlyMarketClient({ now: () => clock, runner: async () => {
      if (fail) throw Object.assign(new Error('SECRET_KEY=fixture'), { code });
      return JSON.stringify({ data: { address, price: { price: 1 } } });
    } });
    const first = await client.quote({ chain: 'base', address }); clock += 3001; fail = true;
    const stale = await client.quote({ chain: 'base', address });
    assert.equal(stale.reasonCode, code === 'untrusted' ? 'GMGN_UNAVAILABLE' : code);
    assert.equal(stale.status, 'stale'); assert.equal(stale.observedAt, first.observedAt);
    assert.ok(!JSON.stringify(stale).includes('SECRET_KEY'));
  }
  for (const [data, reason] of [[{ address, price: { price: 0 } }, 'GMGN_INVALID_QUOTE'],
    [{ address: `0x${'b'.repeat(40)}`, price: { price: 1 } }, 'GMGN_IDENTITY_MISMATCH']]) {
    const client = createReadonlyMarketClient({ runner: async () => JSON.stringify({ data }) });
    assert.equal((await client.quote({ chain: 'base', address })).reasonCode, reason);
  }
});

test('quote separately records queue time and the real CLI request start after configuration', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'yesp-quote-start-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const address = `0x${'a'.repeat(40)}`, start = 1790000000000; let clock = start;
  const client = createReadonlyMarketClient({ dataDir, now: () => clock,
    scheduler: { tail: Promise.resolve(), lastStartedAt: null, rateLimitedUntil: 0 },
    execFileImpl: async (_file, args) => {
      if (args[0] === 'config') { clock += 2000; return { stdout: '', stderr: '' }; }
      clock += 200; return { stdout: JSON.stringify({ address, price: { price: '1' } }), stderr: '' };
    } });
  const quote = await client.quote({ chain: 'robinhood', address });
  assert.equal(quote.status, 'ok'); assert.equal(Date.parse(quote.queuedAt), start);
  assert.equal(Date.parse(quote.observedAt), start + 2000); assert.equal(Date.parse(quote.receivedAt), start + 2200);
});

test('fast ranking cache expires after one second and records actual dispatch without refreshing cached timestamps', async () => {
  let clock = 1790000000000, calls = 0, fail = false;
  const client = createReadonlyMarketClient({ now: () => clock, trendingTtlMs: 1000, runner: async (_args, options) => {
    calls++; assert.equal(options.priority, 1); clock += 500; options.onRequestStart(clock); clock += 200;
    if (fail) throw new Error('upstream unavailable');
    return JSON.stringify({ data: { rank: [rankItem] } });
  } });
  const input = { chain: 'bsc', purpose: 'scan' };
  const first = await client.trending(input);
  assert.equal(Date.parse(first.observedAt), 1790000000500);
  assert.equal(Date.parse(first.receivedAt) - Date.parse(first.observedAt), 200);
  clock += 999; assert.deepEqual(await client.trending(input), first); assert.equal(calls, 1);
  clock += 1; const second = await client.trending(input); assert.equal(calls, 2);
  clock += 1001; fail = true; const stale = await client.trending(input);
  assert.equal(stale.status, 'stale'); assert.equal(stale.observedAt, second.observedAt);
});

test('readonly market parses GMGN trending envelope and applies transparent risk gate', async () => {
  const calls = [];
  const client = createReadonlyMarketClient({ runner: async args => {
    calls.push(args);
    return JSON.stringify({ code: 0, data: { rank: [rankItem] }, message: 'success' });
  } });
  const result = await client.trending({ chain: 'bsc', interval: '1m', limit: 10 });
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'gmgn-cli');
  assert.equal(result.tokens[0].address, rankItem.address);
  assert.equal(result.tokens[0].volume, rankItem.volume);
  assert.equal(result.tokens[0].risk, 'STRONG');
  assert.deepEqual(calls[0], ['market', 'trending', '--chain', 'bsc', '--interval', '1m', '--order-by', 'volume', '--limit', '10', '--raw']);
  await client.trending({ chain: 'bsc', interval: '1m', limit: 10 });
  assert.equal(calls.length, 1, 'identical snapshots are cached briefly');
});

test('readonly market parses K-line list with USD volume and token amount', async () => {
  const calls = [];
  const client = createReadonlyMarketClient({ runner: async args => {
    calls.push(args);
    return JSON.stringify({ list: [{ time: 1700000000000, open: '1', close: '2', high: '3', low: '0.5', volume: '1200', amount: '600' }] });
  } });
  const result = await client.kline({ chain: 'bsc', address: '0xabc12345', resolution: '1m', from: 1700000000, to: 1700003600 });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.candles[0], { time: 1700000000000, open: 1, close: 2, high: 3, low: 0.5, volume: 1200, amount: 600, source: null });
  assert.deepEqual(calls[0], ['market', 'kline', '--chain', 'bsc', '--address', '0xabc12345', '--resolution', '1m', '--from', '1700000000', '--to', '1700003600', '--raw']);
});

test('latest closed kline window is bound at actual dispatch after queueing, not relabelled after response', async () => {
  const base=Date.parse('2026-09-25T05:00:00Z');let clock=base+59000;const calls=[];
  const client=createReadonlyMarketClient({now:()=>clock,runner:async(args,options)=>{
    clock=base+65000;options.onRequestStart?.(clock);calls.push([...args]);clock=base+125000;
    return JSON.stringify({list:[{time:base,open:1,high:2,low:1,close:2,volume:100}]});
  }});
  const r=await client.kline({chain:'bsc',address:'0xabc12345',resolution:'1m',from:base/1000-3600,to:base/1000,latestClosed:true});
  assert.equal(Number(calls[0][calls[0].indexOf('--to')+1]),base/1000+60);
  assert.equal(r.to,base/1000+60);assert.equal(r.from,r.to-3600);
  assert.equal(r.requestWindow,'latest_closed_at_dispatch');
  assert.equal(r.requestedAt,new Date(base+65000).toISOString());
  assert.equal(r.queuedAt,new Date(base+59000).toISOString());
  assert.equal(r.receivedAt,new Date(base+125000).toISOString());
  assert.notEqual(r.to,Math.floor(clock/60000)*60,'response time must not advance the requested close boundary');
});

test('latest-closed cache advances by real minute while pending requests and failures stay bounded',async()=>{
  const base=Date.parse('2026-09-25T05:00:00Z');let clock=base+59000,calls=0,fail=false,release;
  const client=createReadonlyMarketClient({ttlMs:60000,now:()=>clock,runner:async(args,options)=>{
    calls++;if(calls===2)await new Promise(resolve=>{release=resolve;});
    options.onRequestStart(clock);if(fail)throw new Error('unavailable');
    return JSON.stringify({list:[{time:(Number(args[args.indexOf('--to')+1])-60)*1000,open:1,high:1.1,low:.9,close:1,volume:100}]});}});
  const args={chain:'bsc',address:'0xabc12345',resolution:'1m',from:base/1000-3600,to:base/1000,latestClosed:true};
  const first=await client.kline(args);assert.equal(first.to,base/1000);
  clock=base+61000;assert.deepEqual(await client.kline(args),first);assert.equal(calls,1,'minimum cache age remains five seconds');
  clock=base+65000;const a=client.kline(args),b=client.kline(args);await new Promise(resolve=>setImmediate(resolve));
  assert.equal(calls,2,'new closed minute refreshes once, not once per caller');
  release();const [second,duplicate]=await Promise.all([a,b]);assert.deepEqual(second,duplicate);assert.equal(second.to,base/1000+60);
  clock=base+125000;fail=true;const stale=await client.kline(args);assert.equal(stale.status,'stale');assert.equal(stale.to,second.to);
  clock+=10000;await client.kline(args);assert.equal(calls,3,'failed minute refresh retains the normal backoff');
});

test('one malformed candle cannot silently disappear from an otherwise valid response',async()=>{
  const client=createReadonlyMarketClient({runner:async()=>JSON.stringify({list:[
    {time:1700000000000,open:1,high:2,low:1,close:2,volume:100},
    {time:null,open:1,high:2,low:1,close:2,volume:100}]})});
  assert.equal((await client.kline({chain:'bsc',address:'0xabc12345'})).status,'unavailable');
});

test('readonly market fails closed on malformed or unavailable upstream data', async () => {
  const client = createReadonlyMarketClient({ runner: async () => '{"code":1,"data":{}}' });
  const result = await client.trending({ chain: 'base', interval: '5m', limit: 5 });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.tokens, undefined);
  await assert.rejects(() => client.kline({ chain: 'sol', address: 'not valid!', resolution: '1m' }), /invalid address/);
});

test('readonly market keeps the last real snapshot during a transient upstream failure', async () => {
  let attempts = 0;
  const client = createReadonlyMarketClient({ ttlMs: 1, runner: async args => {
    attempts += 1;
    if (attempts > 1) throw new Error('temporary upstream failure');
    if (args[1] === 'kline') return JSON.stringify({ list: [{ time: 1700000000000, open: 1, close: 2, high: 3, low: .5 }] });
    return JSON.stringify({ data: { rank: [rankItem] } });
  } });
  const first = await client.trending({ chain: 'bsc', interval: '1m', limit: 1 });
  assert.equal(first.status, 'ok');
  await new Promise(resolve => setTimeout(resolve, 5));
  const stale = await client.trending({ chain: 'bsc', interval: '1m', limit: 1 });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.stale, true);
  assert.equal(stale.staleReason, 'gmgn_unavailable');
  assert.equal(stale.tokens[0].address, first.tokens[0].address);
  assert.equal(stale.observedAt, first.observedAt);
  assert.ok(stale.staleAt);
});

test('readonly K-line keeps the last real candles during a transient upstream failure', async () => {
  let attempts = 0;
  const client = createReadonlyMarketClient({ ttlMs: 1, runner: async () => {
    attempts += 1;
    if (attempts > 1) throw new Error('temporary upstream failure');
    return JSON.stringify({ list: [{ time: 1700000000000, open: 1, close: 2, high: 3, low: .5 }] });
  } });
  const first = await client.kline({ chain: 'bsc', address: '0xabc12345', resolution: '1m', from: 1700000000, to: 1700003600 });
  assert.equal(first.status, 'ok');
  await new Promise(resolve => setTimeout(resolve, 5));
  const stale = await client.kline({ chain: 'bsc', address: '0xabc12345', resolution: '1m', from: 1700000000, to: 1700003600 });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.candles[0].close, first.candles[0].close);
  assert.equal(stale.observedAt, first.observedAt);
});

test('readonly market accepts only supported read-only chains and resolutions', async () => {
  const client = createReadonlyMarketClient({ runner: async args => JSON.stringify({ data: { rank: [{ ...rankItem, chain: args[3] }] } }) });
  const robinhood = await client.trending({ chain: 'robinhood', interval: '1m', limit: 1 });
  assert.equal(robinhood.status, 'ok');
  await assert.rejects(() => client.trending({ chain: 'polygon', interval: '1m' }), /invalid chain/);
  await assert.rejects(() => client.trending({ chain: 'bsc', interval: '10m' }), /invalid interval/);
  await assert.rejects(() => client.kline({ chain: 'bsc', address: '0xabc12345', resolution: '10m' }), /invalid resolution/);
});

const trenchesPayload = (categories = {}) => ({ code: 0, data: { new_creation: [], pump: [], completed: [], ...categories } });

test('trenches requests each category and binds internal/external stage to observed fields', async () => {
  const calls = [];
  const client = createReadonlyMarketClient({ runner: async args => {
    calls.push(args);
    return JSON.stringify(trenchesPayload({
      new_creation: [{ ...rankItem, address: '0xABC12345', launchpad_status: '0', progress: .35 }],
      pump: [{ ...rankItem, address: '0xabc12346', launchpad_status: 0, progress: '.96' }],
      completed: [{ ...rankItem, address: '0xabc12347', launchpad_status: '1', progress: 1 }],
    }));
  } });
  const result = await client.trenches({ chain: 'bsc', limit: 3 });
  assert.equal(result.status, 'ok');
  assert.equal(result.tokens.length, 3);
  assert.deepEqual(result.tokens.map(token => token.marketStage), ['internal', 'internal', 'external']);
  assert.equal(result.categories.near_completion[0].marketCategory, 'near_completion');
  assert.equal(result.categories.near_completion[0].stageSource, 'trenches:near_completion');
  assert.equal(result.categories.new_creation[0].address, '0xabc12345');
  assert.equal(result.categories.new_creation[0].bondingCurveProgress, .35);
  assert.equal(result.categories.near_completion[0].bondingCurveProgress, .96);
  assert.equal(result.tokens[0].stageObservedAt, result.observedAt);
  assert.deepEqual(calls[0], ['market', 'trenches', '--chain', 'bsc', '--type', 'new_creation', '--type', 'near_completion', '--type', 'completed', '--limit', '3', '--raw']);
});

test('trenches accepts the installed CLI normalized near_completion output', async () => {
  const client = createReadonlyMarketClient({ runner: async () => JSON.stringify({ new_creation: [], near_completion: [{ ...rankItem, launchpad_status: 0 }], completed: [] }) });
  const result = await client.trenches({ chain: 'bsc' });
  assert.equal(result.status, 'ok'); assert.equal(result.tokens.length, 1);
  assert.equal(result.tokens[0].marketStage, 'internal');
  assert.equal(result.categories.near_completion[0].marketCategory, 'near_completion');
});

test('contradictory upstream and CLI category aliases fail closed', async () => {
  const client = createReadonlyMarketClient({ runner: async () => JSON.stringify(trenchesPayload({ near_completion: [{ ...rankItem, launchpad_status: 0 }] })) });
  assert.equal((await client.trenches({ chain: 'bsc' })).status, 'unavailable');
});

test('missing stage remains unknown and numeric nulls do not turn into favorable zeros', async () => {
  const client = createReadonlyMarketClient({ runner: async () => JSON.stringify({ data: { rank: [{ ...rankItem,
    name: 'Completed graduated mainnet', launchpad_platform: 'pump_amm', launchpad_status: null,
    rug_ratio: null, liquidity: '', creator_close: null, top_10_holder_rate: null, bundler_rate: ' ', price: false,
  }] } }) });
  const token = (await client.trending({ chain: 'bsc' })).tokens[0];
  assert.equal(token.marketStage, 'unknown');
  assert.equal(token.stageSource, null);
  assert.equal(token.creatorClose, null);
  assert.equal(token.rugRatio, null);
  assert.equal(token.price, null);
  assert.equal(token.liquidity, null);
  assert.equal(token.top10HolderRate, null);
  assert.equal(token.bundlerRate, null);
  assert.equal(token.bondingCurveProgress, null);
  assert.equal(token.risk, 'WATCH');
});

test('trenches category disagreement and internal/external duplicates fail stage closed', async () => {
  const client = createReadonlyMarketClient({ runner: async () => JSON.stringify(trenchesPayload({
    new_creation: [{ ...rankItem, launchpad_status: '1' }, { ...rankItem, address: '0xabc12346', launchpad_status: '0' }],
    completed: [{ ...rankItem, address: '0xABC12346', launchpad_status: '1' }],
  })) });
  const result = await client.trenches({ chain: 'bsc' });
  assert.equal(result.status, 'ok');
  assert.equal(result.tokens.length, 2, 'EVM address case is deduplicated');
  assert.ok(result.tokens.every(token => token.marketStage === 'unknown' && token.stageConflict));
  assert.ok(result.categories.new_creation.every(token => token.stageConflict));
  assert.ok(result.categories.completed.every(token => token.stageConflict));
});

test('trenches normalizes actual field variants without confusing windowed volume', async () => {
  const client = createReadonlyMarketClient({ runner: async () => JSON.stringify(trenchesPayload({ pump: [{
    chain: 'robinhood', address: '0xabc12345', usd_market_cap: '12000', created_timestamp: '1700000000',
    volume_1h: '3000', volume_24h: '12000', net_buy_24h: '850', swaps_1m: 2, swaps_1h: 12,
    bundler_trader_amount_rate: '.21', open_source: 'yes', owner_renounced: 'unknown', progress: 3,
  }] })) });
  const token = (await client.trenches({ chain: 'robinhood' })).tokens[0];
  assert.equal(token.marketStage, 'internal');
  assert.equal(token.marketCap, 12000);
  assert.equal(token.creationTimestamp, 1700000000);
  assert.equal(token.volume, null);
  assert.equal(token.volume1h, 3000);
  assert.equal(token.volume24h, 12000);
  assert.equal(token.netBuy24h, 850);
  assert.equal(token.swaps1m, 2);
  assert.equal(token.bundlerRate, .21);
  assert.equal(token.isOpenSource, true);
  assert.equal(token.isRenounced, null);
  assert.equal(token.bondingCurveProgress, null);
});

test('trenches yes/no safety flags and rank numeric flags normalize consistently without making unknown safe', async () => {
  const client = createReadonlyMarketClient({ runner: async () => JSON.stringify(trenchesPayload({
    new_creation: [
      { chain: 'bsc', address: '0xabc12345', is_honeypot: 'no', open_source: 'yes', owner_renounced: 'yes' },
      { chain: 'bsc', address: '0xabc12346', is_honeypot: 'yes', open_source: 'no', owner_renounced: 'no' },
      { chain: 'bsc', address: '0xabc12347', is_honeypot: '', open_source: 'unknown', owner_renounced: null },
      { chain: 'bsc', address: '0xabc12348', is_honeypot: 0, is_open_source: 1, is_renounced: 0 },
    ],
  })) });
  const result = await client.trenches({ chain: 'bsc' });
  assert.deepEqual(result.tokens.map(token => [token.isHoneypot, token.isOpenSource, token.isRenounced]), [
    [false, true, true], [true, false, false], [null, null, null], [false, true, false],
  ]);
  assert.equal(result.tokens[1].risk, 'BLOCKED');
  assert.equal(result.tokens[2].risk, 'WATCH');
});

test('empty trenches is a successful cached observation while malformed/error envelopes are unavailable', async () => {
  let calls = 0;
  const client = createReadonlyMarketClient({ runner: async () => { calls++; return JSON.stringify(trenchesPayload()); } });
  const result = await client.trenches({ chain: 'robinhood' });
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.tokens, []);
  assert.deepEqual(result.categories, { new_creation: [], near_completion: [], completed: [] });
  await client.trenches({ chain: 'robinhood' });
  assert.equal(calls, 1);
  for (const payload of [{ data: {} }, { data: { new_creation: [] } }, trenchesPayload({ pump: {} }), { ...trenchesPayload(), code: 429 }, trenchesPayload({ pump: [{}] })]) {
    const broken = createReadonlyMarketClient({ runner: async () => JSON.stringify(payload) });
    assert.equal((await broken.trenches({ chain: 'bsc' })).status, 'unavailable');
  }
});

test('trenches preserves observation time and stage when falling back to stale real data', async () => {
  let clock = 1700000000000;
  let attempts = 0;
  const client = createReadonlyMarketClient({ ttlMs: 10, now: () => clock, runner: async () => {
    if (++attempts > 1) throw new Error('offline');
    return JSON.stringify(trenchesPayload({ new_creation: [rankItem] }));
  } });
  const first = await client.trenches({ chain: 'bsc' });
  clock += 11;
  const stale = await client.trenches({ chain: 'bsc' });
  assert.equal(stale.status, 'stale');
  assert.equal(stale.observedAt, first.observedAt);
  assert.equal(stale.tokens[0].stageObservedAt, first.observedAt);
  assert.equal(stale.tokens[0].marketStage, 'internal');
  assert.equal(stale.staleAt, new Date(clock).toISOString());
});

test('upstream chain and address mismatches are rejected including case-sensitive Solana identity', async () => {
  const badChain = createReadonlyMarketClient({ runner: async () => JSON.stringify({ data: { rank: [rankItem] } }) });
  assert.equal((await badChain.trending({ chain: 'robinhood' })).status, 'unavailable');
  const badEnvelope = createReadonlyMarketClient({ runner: async () => JSON.stringify({ chain: 'eth', ...trenchesPayload() }) });
  assert.equal((await badEnvelope.trenches({ chain: 'bsc' })).status, 'unavailable');
  const wrongAddressType = createReadonlyMarketClient({ runner: async () => JSON.stringify(trenchesPayload({ pump: [{ ...rankItem, chain: 'sol' }] })) });
  assert.equal((await wrongAddressType.trenches({ chain: 'sol' })).status, 'unavailable');
  const list = [{ time: 1700000000000, close: 1 }];
  for (const [chain, requested, actual, status] of [
    ['bsc', '0xabc12345', '0xABC12345', 'ok'],
    ['bsc', '0xabc12345', '0xabc12346', 'unavailable'],
    ['sol', 'So11111111111111111111111111111111111111112', 'so11111111111111111111111111111111111111112', 'unavailable'],
  ]) {
    const client = createReadonlyMarketClient({ runner: async () => JSON.stringify({ data: { chain, address: actual, list } }) });
    assert.equal((await client.kline({ chain, address: requested, from: 1700000000, to: 1700003600 })).status, status);
  }
});

test('shared read-only transport serializes requests by 1.2 seconds and checks config before each', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmgn-readonly-queue-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let clock = 1700000000000;
  const calls = [];
  const scheduler = { tail: Promise.resolve(), lastStartedAt: null, rateLimitedUntil: 0 };
  const options = { dataDir, scheduler, now: () => clock, sleepImpl: async ms => { clock += ms; }, execFileImpl: async (file, args) => {
    calls.push({ args, at: clock });
    return { stdout: args[0] === 'config' ? '' : JSON.stringify(trenchesPayload()), stderr: '' };
  } };
  const a = createReadonlyMarketClient(options);
  const b = createReadonlyMarketClient(options);
  await Promise.all([a.trenches({ chain: 'bsc' }), b.trenches({ chain: 'robinhood' })]);
  assert.deepEqual(calls.map(call => call.args[0]), ['config', 'market', 'config', 'market']);
  assert.equal(calls[3].at - calls[1].at, 1200);
  assert.ok(calls.filter(call => call.args[0] === 'config').every(call => call.args[1] === '--check'));
});

test('real readonly transport prioritizes pending exit quotes without bypassing 1.2-second spacing', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmgn-priority-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let clock = 1700000000000, release; const calls = [], address = `0x${'a'.repeat(40)}`;
  const client = createReadonlyMarketClient({ dataDir, now: () => clock, scheduler: {}, sleepImpl: async ms => { clock += ms; },
    execFileImpl: async (_file, args) => {
      if (args[0] === 'config') return { stdout: '' };
      calls.push({ kind: args[0], at: clock });
      if (calls.length === 1) await new Promise(resolve => { release = resolve; });
      return { stdout: JSON.stringify(args[0] === 'token' ? { data: { address, price: { price: 1 } } } : { data: { rank: [rankItem] } }) };
    } });
  const active = client.trending({ chain: 'bsc', interval: '1m' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const research = client.trending({ chain: 'bsc', interval: '5m' });
  const quote = client.quote({ chain: 'bsc', address, purpose: 'exit' });
  await new Promise(resolve => setImmediate(resolve)); release();
  await Promise.all([active, research, quote]);
  assert.deepEqual(calls.map(c => c.kind), ['market', 'token', 'market']);
  assert.ok(calls.slice(1).every((c, i) => c.at - calls[i].at >= 1200));
});

test('dashboard honors persisted flow cooldown and malformed cooldown without starting a child', async t => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmgn-readonly-cooldown-'));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const clock = 1700000000000;
  let calls = 0;
  const file = path.join(dataDir, 'gmgn-flow-rate-limit.json');
  const options = { dataDir, now: () => clock, scheduler: { tail: Promise.resolve(), lastStartedAt: null, rateLimitedUntil: 0 }, execFileImpl: async () => { calls++; return { stdout: JSON.stringify(trenchesPayload()) }; } };
  await fs.writeFile(file, JSON.stringify({ version: 1, rateLimitedUntil: new Date(clock + 60_000).toISOString() }));
  assert.equal((await createReadonlyMarketClient(options).trenches({ chain: 'bsc' })).status, 'unavailable');
  await fs.writeFile(file, '{broken');
  assert.equal((await createReadonlyMarketClient(options).trenches({ chain: 'bsc' })).status, 'unavailable');
  assert.equal(calls, 0);
});

test('CLI textual and JSON rate limits are persisted for the flow client and block queued work', async t => {
  for (const diagnostic of ['Rate limit resets at 2026-09-20 18:53:23 GMT+08:00 (~11s remaining).', '{"code":429,"error":"RATE_LIMIT_BANNED","reset_at":1790940600}']) {
    const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gmgn-readonly-ratelimit-'));
    t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
    const clock = Date.parse('2026-09-20T10:53:00Z');
    const expectedReset = diagnostic.startsWith('{') ? 1790940600000 : Date.parse('2026-09-20T10:53:23Z');
    let calls = 0;
    const scheduler = { tail: Promise.resolve(), lastStartedAt: null, rateLimitedUntil: 0 };
    const client = createReadonlyMarketClient({ dataDir, scheduler, now: () => clock, execFileImpl: async (file, args) => {
      calls++;
      if (args[0] === 'config') return { stdout: '', stderr: '' };
      if (diagnostic.startsWith('{')) return { stdout: diagnostic, stderr: '' };
      throw Object.assign(new Error('CLI failed'), { stderr: diagnostic });
    } });
    const results = await Promise.all([client.trenches({ chain: 'bsc' }), client.trenches({ chain: 'robinhood' })]);
    assert.ok(results.every(result => result.status === 'unavailable'));
    assert.equal(calls, 2, 'only the first config/market pair starts');
    const state = JSON.parse(await fs.readFile(path.join(dataDir, 'gmgn-flow-rate-limit.json'), 'utf8'));
    assert.equal(state.version, 1);
    assert.equal(Date.parse(state.rateLimitedUntil), expectedReset + 1000);
    const flow = createGmgnFlowClient({ dataDir }, { now: () => clock,
      scheduler: { tail: Promise.resolve(), lastStartedAt: null, rateLimitedUntil: 0 }, execFileImpl: () => { throw new Error('must not start'); } });
    await assert.rejects(() => flow.trending('bsc'), error => error.code === 'GMGN_RATE_LIMITED');
    await flow.stop();
  }
});

test('readonly market preserves Robinhood-specific chip fields without treating them as execution data', async () => {
  const calls = [];
  const client = createReadonlyMarketClient({ runner: async args => {
    calls.push(args);
    return JSON.stringify({ data: { rank: [{ ...rankItem, chain: 'robinhood', dev_team_hold_rate: .04, top70_sniper_hold_rate: .08, rat_trader_amount_rate: .03, bluechip_owner_percentage: .21, cto_flag: 1 }] } });
  } });
  const result = await client.trending({ chain: 'robinhood', interval: '5m', limit: 2 });
  const token = result.tokens[0];
  assert.equal(token.chain, 'robinhood');
  assert.equal(token.devTeamHoldRate, .04);
  assert.equal(token.top70SniperHoldRate, .08);
  assert.equal(token.ratTraderAmountRate, .03);
  assert.equal(token.bluechipOwnerPercentage, .21);
  assert.equal(token.ctoFlag, true);
  assert.deepEqual(calls[0], ['market', 'trending', '--chain', 'robinhood', '--interval', '5m', '--order-by', 'volume', '--limit', '2', '--raw']);
});
