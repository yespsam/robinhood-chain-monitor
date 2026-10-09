import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createGmgnFlowClient, parseGmgnFlowRateLimit } from "../src/gmgn-flow-client.js";
import {createGmgnAccountGate} from '../src/gmgn-account-gate.js';

const EVM = "0x1234567890abcdef1234567890abcdef12345678";
const SOL = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const START = Date.parse("2026-09-19T18:00:00.000Z");

test('trade feeds use research priority and bind coverage to dispatch after queueing, never response time',async t=>{
  const admissions=[];let fx;
  fx=await fixture(t,{dependencies:{accountGate:async(work,_signal,options)=>{
    admissions.push(options.priority);fx.advance(12000);return work();
  }}});
  let dispatched;
  await fx.client.trades('bsc','smartmoney',{onRequestStart:at=>{dispatched=at;}});
  assert.equal(dispatched,fx.calls.find(c=>c.args[0]==='track').at);
  assert.ok(dispatched>=START+12000);assert.equal(admissions[0],1);
  await fx.client.stats('bsc',EVM,'7d');assert.equal(admissions[1],0);
  assert.throws(()=>fx.client.trades('bsc','kol',{onRequestStart:true}),{code:'GMGN_INVALID_ARGUMENT'});
});

test('Plus feed reaches the shared gate while a profile response is stalled; reserved exit seat survives', {timeout:10000}, async t=>{
  let fx,releaseProfile,releaseFeed,profileStarted,feedStarted;
  const profileReady=new Promise(r=>{profileStarted=r;}),feedReady=new Promise(r=>{feedStarted=r;});
  const order=[];
  fx=await fixture(t,{dependencies:{accountGate:(work,signal,options)=>createGmgnAccountGate(fx.dataDir)(work,signal,options)},
    execFileImpl:async(_file,args)=>{
      if(args[0]==='config')return {stdout:'ok'};
      order.push({route:args[0],at:fx.current()});
      if(args[0]==='portfolio'){profileStarted();await new Promise(r=>{releaseProfile=r;});}
      if(args[0]==='track'){feedStarted();await new Promise(r=>{releaseFeed=r;});}
      return {stdout:'{"data":[]}'};
    }});
  await fs.writeFile(path.join(fx.dataDir,'gmgn-readonly-plan.json'),JSON.stringify({version:1,plan:'plus'}));
  const profile=fx.client.stats('bsc',EVM,'7d');await profileReady;
  const feed=fx.client.trades('sol','smartmoney');await feedReady;
  assert.deepEqual(order.map(x=>x.route),['portfolio','track']);
  assert.ok(order[1].at-order[0].at>=1200,'retain configured process dispatch spacing');
  assert.equal(await createGmgnAccountGate(fx.dataDir)(async()=>42,undefined,{priority:2}),42);
  releaseFeed();await feed;releaseProfile();await profile;
  const slot=JSON.parse(await fs.readFile(path.join(fx.dataDir,'gmgn-account-slot.json'),'utf8'));
  assert.equal(slot.active.length,0);
});

test('Free still waits for the active profile; no phantom concurrency without Plus', {timeout:10000}, async t=>{
  let fx,release,entered;const ready=new Promise(r=>{entered=r;}),order=[];
  fx=await fixture(t,{dependencies:{accountGate:(work,signal,options)=>createGmgnAccountGate(fx.dataDir)(work,signal,options)},
    execFileImpl:async(_file,args)=>{
      if(args[0]==='config')return {stdout:'ok'};
      order.push(args[0]);if(args[0]==='portfolio'){entered();await new Promise(r=>{release=r;});}
      return {stdout:'{"data":[]}'};
    }});
  const profile=fx.client.stats('bsc',EVM,'7d');await ready;
  const feed=fx.client.trades('sol','smartmoney');
  await new Promise(r=>setTimeout(r,100));assert.deepEqual(order,['portfolio']);
  release();await Promise.all([profile,feed]);assert.deepEqual(order,['portfolio','track']);
});

test('gated parallel responses retain shared 429 cooldown before another dispatch and drain on stop',async t=>{
  let fx,releaseProfile,releaseFeed,enteredProfile,enteredFeed;
  const profileReady=new Promise(r=>{enteredProfile=r;}),feedReady=new Promise(r=>{enteredFeed=r;});
  let launches=0;
  fx=await fixture(t,{dependencies:{accountGate:(work)=>work()},execFileImpl:async(_file,args)=>{
    if(args[0]==='config')return {stdout:'ok'};
    launches++;
    if(args[0]==='portfolio'){enteredProfile();await new Promise(r=>{releaseProfile=r;});throw {status:429,reset_at:(START+600000)/1000};}
    enteredFeed();await new Promise(r=>{releaseFeed=r;});return {stdout:'{"data":[]}'};
  }});
  const profile=fx.client.stats('bsc',EVM,'7d'),rejected=assert.rejects(profile,{code:'GMGN_RATE_LIMITED'});await profileReady;
  const feed=fx.client.trades('sol','smartmoney');await feedReady;
  releaseProfile();await rejected;
  await assert.rejects(fx.client.trades('eth','kol'),{code:'GMGN_RATE_LIMITED'});assert.equal(launches,2);
  releaseFeed();await feed;await fx.client.stop();
  await assert.rejects(fx.client.trades('sol','kol'),{code:'GMGN_STOPPED'});
});

test('stop drains cancelled account-gate tickets as well as active children',async t=>{
  let fx,entered;const ready=new Promise(r=>{entered=r;});let ticketCleaned=false;
  fx=await fixture(t,{dependencies:{accountGate:async(_work,signal)=>{
    entered();await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
    await new Promise(resolve=>setTimeout(resolve,20));ticketCleaned=true;
    throw Object.assign(new Error('stopped'),{code:'GMGN_STOPPED'});
  }}});
  const request=fx.client.trades('bsc','smartmoney'),rejected=assert.rejects(request,{code:'GMGN_STOPPED'});
  await ready;await fx.client.stop();await rejected;
  assert.equal(ticketCleaned,true);assert.equal(fx.calls.length,1,'only config check ran, no business request');
});

test('platform call route is read-only and limited to validated chains and type 13', async t=>{
  const {client,calls}=await fixture(t);await client.platformCalls('sol');
  assert.deepEqual(calls[1].args,['market','signal','--chain','sol','--signal-type','13','--raw']);
  for(const chain of ['base','eth','sol;echo bad'])assert.throws(()=>client.platformCalls(chain),{code:'GMGN_INVALID_ARGUMENT'});
});

test('profit leaderboard route is public, bounded and orders traders by profit without signing', async t => {
  const { client, calls } = await fixture(t);
  await client.topTraders('bsc', EVM, 50);
  assert.deepEqual(calls[1].args, ['token', 'traders', '--chain', 'bsc', '--address', EVM, '--order-by', 'profit', '--direction', 'desc', '--limit', '50', '--raw']);
  for (const limit of [0, 101, 1.5]) assert.throws(() => client.topTraders('bsc', EVM, limit), { code: 'GMGN_INVALID_ARGUMENT' });
  assert.throws(() => client.topTraders('sol', EVM), { code: 'GMGN_INVALID_ARGUMENT' });
});

async function fixture(t, options = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "gmgn-flow-client-"));
  let current = START;
  const calls = [];
  const scheduler = options.scheduler || { tail: Promise.resolve(), lastStartedAt: null, rateLimitedUntil: 0 };
  const execFileImpl = options.execFileImpl || (async (file, args, opts) => {
    calls.push({ file, args, opts, at: current });
    return { stdout: args[0] === "config" ? "configured" : JSON.stringify({ list: [], route: args.slice(0, 2) }) };
  });
  const dependencies = {
    scheduler, now: () => current, sleepImpl: async (ms) => { current += ms; }, execFileImpl,
    ...options.dependencies,
  };
  const config = { dataDir, ...options.config };
  const client = createGmgnFlowClient(config, dependencies);
  t.after(async () => { await client.stop(); await fs.rm(dataDir, { recursive: true, force: true }); });
  return { client, calls, config, dependencies, scheduler, dataDir, advance: (ms) => { current += ms; }, current: () => current };
}

test("read-only client builds bounded CLI argv for every route and checks configuration once", async (t) => {
  const { client, calls } = await fixture(t);
  assert.deepEqual(await client.checkConfig(), { ok: true });
  await client.trending("robinhood");
  await client.trades("bsc", "smartmoney");
  await client.trades("eth", "kol");
  await client.candles("sol", SOL, 100, 200);
  await client.stats("base", EVM, "30d");
  await client.info("sol", SOL);
  await client.hotSearches(["monad", "megaeth", "hyperevm", "tron", "monad"]);
  assert.equal(calls.filter((call) => call.args[0] === "config").length, 1);
  assert.deepEqual(calls[1].args, ["market", "trending", "--chain", "robinhood", "--interval", "5m", "--order-by", "volume", "--limit", "50", "--raw"]);
  assert.deepEqual(calls[2].args, ["track", "smartmoney", "--chain", "bsc", "--limit", "200", "--raw"]);
  assert.equal(calls.some((call) => call.args.includes("--side")), false);
  assert.deepEqual(calls[4].args, ["market", "kline", "--chain", "sol", "--address", SOL, "--resolution", "1m", "--from", "100", "--to", "200", "--raw"]);
  assert.deepEqual(calls[5].args, ["portfolio", "stats", "--chain", "base", "--wallet", EVM, "--period", "30d", "--raw"]);
  assert.deepEqual(calls[7].args, ["market", "hot-searches", "--chain", "monad", "--chain", "megaeth", "--chain", "hyperevm", "--chain", "tron", "--interval", "5m", "--limit", "50", "--raw"]);
  for (const [index, call] of calls.entries()) {
    assert.equal(call.opts.shell, false);
    assert.equal(call.opts.maxBuffer, 4 * 1024 * 1024);
    assert.ok(call.opts.timeout <= 15_000);
    if (index) assert.ok(call.at - calls[index - 1].at >= 1200);
  }
});

test("chain capability and address validation reject unsupported or injected inputs before any CLI work", async (t) => {
  const { client, calls } = await fixture(t);
  for (const run of [
    () => client.trending("monad"), () => client.trending("bsc;echo bad"),
    () => client.stats("eth", "--wallet", "7d"), () => client.info("bsc", SOL),
    () => client.info("sol", EVM), () => client.trades("sol", "follow-wallet"),
    () => client.stats("sol", SOL, "1d"), () => client.hotSearches(["all"]),
    () => client.hotSearches([]), () => client.candles("bsc", EVM, 200, 100),
    () => client.candles("bsc", EVM, 1.5, 100),
    () => client.stats("eth", [], "7d"), () => client.stats("eth", Array(21).fill(EVM), "7d"),
    () => client.stats("eth", [EVM, "--raw"], "7d"),
  ]) assert.throws(run, { code: "GMGN_INVALID_ARGUMENT" });
  assert.equal(calls.length, 0);
});

test("wallet stats batch is strictly validated, deduplicated and sent as one CLI request", async (t) => {
  const fx = await fixture(t);
  const second = "0xabcdef1234567890abcdef1234567890abcdef12";
  await fx.client.stats("eth", [EVM, EVM.toUpperCase().replace("0X", "0x"), second], "7d");
  assert.deepEqual(fx.calls[1].args, ["portfolio", "stats", "--chain", "eth", "--wallet",
    EVM.toUpperCase().replace("0X", "0x"), second, "--period", "7d", "--raw"]);
  await fx.client.stats("sol", [SOL, SOL], "30d");
  assert.deepEqual(fx.calls[2].args, ["portfolio", "stats", "--chain", "sol", "--wallet", SOL, "--period", "30d", "--raw"]);
});

test('wallet learning activity is public read-only with bounded pagination arguments', async t => {
  const { client, calls } = await fixture(t);
  await client.activity('bsc', EVM, { cursor: 'cursor-value', limit: 100 });
  assert.deepEqual(calls[1].args, ['portfolio', 'activity', '--chain', 'bsc', '--wallet', EVM, '--limit', '100', '--cursor', 'cursor-value', '--raw']);
  for (const options of [{ limit: 101 }, { limit: 0 }, { cursor: '\n' }, { cursor: '' }, { cursor: 'x'.repeat(2049) }]) assert.throws(() => client.activity('bsc', EVM, options), { code: 'GMGN_INVALID_ARGUMENT' });
  assert.equal(calls.length, 2);
});

test('creator history uses public read-only argv and one configuration check for all supported chains', async t => {
  const { client, calls } = await fixture(t);
  await client.createdTokens('bsc', EVM);
  await client.createdTokens('sol', SOL, { orderBy: 'token_ath_mc', direction: 'desc', migrateState: 'migrated' });
  await client.createdTokens('base', EVM, { orderBy: 'market_cap', direction: 'asc', migrateState: 'non_migrated' });
  await client.createdTokens('eth', EVM, { orderBy: undefined });
  assert.deepEqual(calls[0].args, ['config', '--check']);
  assert.deepEqual(calls[1].args, ['portfolio', 'created-tokens', '--chain', 'bsc', '--wallet', EVM, '--raw']);
  assert.deepEqual(calls[2].args, ['portfolio', 'created-tokens', '--chain', 'sol', '--wallet', SOL,
    '--order-by', 'token_ath_mc', '--direction', 'desc', '--migrate-state', 'migrated', '--raw']);
  assert.deepEqual(calls[3].args, ['portfolio', 'created-tokens', '--chain', 'base', '--wallet', EVM,
    '--order-by', 'market_cap', '--direction', 'asc', '--migrate-state', 'non_migrated', '--raw']);
  assert.deepEqual(calls[4].args, ['portfolio', 'created-tokens', '--chain', 'eth', '--wallet', EVM, '--raw']);
  assert.equal(calls.filter(call => call.args[0] === 'config').length, 1);
  for (const call of calls) assert.equal(call.opts.shell, false);
});

test('creator history rejects unsupported chains, wallet identities and non-allowlisted options before CLI work', async t => {
  const { client, calls } = await fixture(t);
  for (const [chain, wallet] of [['robinhood', EVM], ['monad', EVM], ['BSC', EVM], ['bsc;echo bad', EVM],
    ['bsc', SOL], ['sol', EVM], ['eth', '--wallet'], ['base', [EVM]]]) {
    assert.throws(() => client.createdTokens(chain, wallet), { code: 'GMGN_INVALID_ARGUMENT' });
  }
  for (const options of [null, [], 'desc', 0, true, () => {}, new Date(), Object.create({ direction: 'asc' }),
    { orderBy: 'profit' }, { orderBy: null }, { direction: 'DESC' }, { direction: '--raw' },
    { migrateState: 'all' }, { migrateState: false }, { orderBy: ['market_cap'] },
    { priority: 2 }, { limit: 100 }, { cursor: 'next' }, { wallet: EVM }, { [Symbol('direction')]: 'asc' }]) {
    assert.throws(() => client.createdTokens('bsc', EVM, options), { code: 'GMGN_INVALID_ARGUMENT' });
  }
  assert.equal(calls.length, 0);
});

test('creator history keeps shared background priority and account cooldown without a second business dispatch', async t => {
  const priorities = [], commands = [];
  const fx = await fixture(t, {
    dependencies: { accountGate: async (work, _signal, options) => { priorities.push(options.priority); return work(); } },
    execFileImpl: async (_file, args) => {
      commands.push(args);
      if (args[0] === 'config') return { stdout: 'ok' };
      throw { status: 429, reset_at: (START + 600_000) / 1000 };
    },
  });
  await assert.rejects(fx.client.createdTokens('bsc', EVM), { code: 'GMGN_RATE_LIMITED' });
  await assert.rejects(fx.client.createdTokens('sol', SOL), { code: 'GMGN_RATE_LIMITED' });
  await assert.rejects(fx.client.stats('eth', EVM, '7d'), { code: 'GMGN_RATE_LIMITED' });
  assert.deepEqual(priorities, [0, 0, 0]);
  assert.equal(commands.length, 2, 'configuration and the initial creator request only');
  const cooldown = JSON.parse(await fs.readFile(path.join(fx.dataDir, 'gmgn-flow-rate-limit.json'), 'utf8'));
  assert.equal(cooldown.rateLimitedUntil, new Date(START + 600_000).toISOString());
});

test("concurrent routes share one serial process queue and one configuration check", async (t) => {
  let running = 0;
  let maximum = 0;
  let configs = 0;
  const { client } = await fixture(t, { execFileImpl: async (_file, args) => {
    running++; maximum = Math.max(maximum, running);
    await new Promise((resolve) => setImmediate(resolve));
    if (args[0] === "config") configs++;
    running--;
    return { stdout: args[0] === "config" ? "ok" : "{\"list\":[]}" };
  } });
  await Promise.all([client.trending("bsc"), client.trades("sol", "kol"), client.stats("eth", EVM, "7d")]);
  assert.equal(maximum, 1);
  assert.equal(configs, 1);
});

test("separate client instances share the account scheduler and retain a three-second gap", async (t) => {
  const fx = await fixture(t, { config: { gmgnFlowRequestIntervalMs: 1, gmgnFlowRequestTimeoutMs: 99_000 } });
  const other = createGmgnFlowClient(fx.config, fx.dependencies);
  t.after(() => other.stop());
  await Promise.all([fx.client.trending("bsc"), other.trending("eth"), fx.client.trades("sol", "kol")]);
  for (let i = 1; i < fx.calls.length; i++) assert.ok(fx.calls[i].at - fx.calls[i - 1].at >= 1200);
  assert.equal(fx.calls[0].opts.timeout, 15_000);
});

test("rate-limit parser understands CLI GMT+08 reset, numeric reset_at and conservative fallback", () => {
  assert.equal(parseGmgnFlowRateLimit("Rate limit resets at 2026-09-20 02:14:16 GMT+08:00 (~856s remaining)", START), Date.parse("2026-09-19T18:14:16Z"));
  assert.equal(parseGmgnFlowRateLimit({ code: 429, reset_at: (START + 120_000) / 1000 }, START), START + 120_000);
  assert.equal(parseGmgnFlowRateLimit({ stdout: '{"code":429,"error":"RATE_LIMIT_BANNED","reset_at":1789841700}' }, START), 1789841700000);
  assert.equal(parseGmgnFlowRateLimit("HTTP 429", START), START + 60_000);
  assert.equal(parseGmgnFlowRateLimit("provider unavailable", START), null);
  assert.equal(parseGmgnFlowRateLimit("token about API rate limits", START), null);
});

test("429 cooldown is durably stored privately and blocks every route after restart", async (t) => {
  let count = 0;
  const fx = await fixture(t, { execFileImpl: async (_file, args) => {
    count++;
    if (args[0] === "config") return { stdout: "ok" };
    throw Object.assign(new Error("CLI failed"), { stderr: "HTTP 429: Rate limit resets at 2026-09-20 02:14:16 GMT+08:00" });
  } });
  await assert.rejects(fx.client.trending("bsc"), { code: "GMGN_RATE_LIMITED", retryAt: "2026-09-19T18:14:16.000Z" });
  const file = path.join(fx.dataDir, "gmgn-flow-rate-limit.json");
  const persisted = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(persisted.rateLimitedUntil, "2026-09-19T18:14:16.000Z");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(fx.client.info("eth", EVM), { code: "GMGN_RATE_LIMITED" });
  const restarted = createGmgnFlowClient(fx.config, { ...fx.dependencies,
    scheduler: { tail: Promise.resolve(), lastStartedAt: null, rateLimitedUntil: 0 } });
  t.after(() => restarted.stop());
  await assert.rejects(restarted.trades("sol", "kol"), { code: "GMGN_RATE_LIMITED" });
  assert.equal(count, 2);
});

test("successful exit containing a JSON API rate-limit error is not treated as empty data", async (t) => {
  const fx = await fixture(t, { execFileImpl: async (_file, args) => ({ stdout: args[0] === "config" ? "ok"
    : JSON.stringify({ code: 429, error: "RATE_LIMIT_BANNED", reset_at: (START + 100_000) / 1000 }) }) });
  await assert.rejects(fx.client.trending("sol"), { code: "GMGN_RATE_LIMITED" });
  assert.ok(JSON.parse(await fs.readFile(path.join(fx.dataDir, "gmgn-flow-rate-limit.json"), "utf8")).rateLimitedUntil);
});

test('a later short 429 cannot overwrite a longer cooldown written by another client',async t=>{
  let fx;
  fx=await fixture(t,{execFileImpl:async(_file,args)=>{
    if(args[0]==='config')return {stdout:'ok'};
    await fs.writeFile(path.join(fx.dataDir,'gmgn-flow-rate-limit.json'),JSON.stringify({version:1,rateLimitedUntil:new Date(START+600000).toISOString()}));
    throw {status:429,reset_at:(START+100000)/1000};
  }});
  await assert.rejects(fx.client.trending('bsc'),{code:'GMGN_RATE_LIMITED',retryAt:new Date(START+600000).toISOString()});
  assert.equal(JSON.parse(await fs.readFile(path.join(fx.dataDir,'gmgn-flow-rate-limit.json'),'utf8')).rateLimitedUntil,new Date(START+600000).toISOString());
});

test('KOL discovery can preserve its smaller result limit through the shared client',async t=>{
  const {client,calls}=await fixture(t);await client.trades('bsc','kol',{limit:100});
  assert.equal(calls[1].args[calls[1].args.indexOf('--limit')+1],'100');
  for(const limit of [0,201,1.5,NaN])assert.throws(()=>client.trades('bsc','kol',{limit}),{code:'GMGN_INVALID_ARGUMENT'});
});

test("legacy Fomo cooldown is read before request and again after the spacing wait", async (t) => {
  const fx = await fixture(t);
  await fx.client.checkConfig();
  const until = new Date(START + 600_000).toISOString();
  await fs.writeFile(path.join(fx.dataDir, "fomo-call-state.json"), JSON.stringify({ publicOnchain: { smartMoney: { rateLimitedUntil: until } } }));
  await assert.rejects(fx.client.trending("eth"), { code: "GMGN_RATE_LIMITED", retryAt: until });
  assert.equal(fx.calls.length, 1);
  fx.advance(600_001);
  assert.deepEqual(await fx.client.trending("eth"), { list: [], route: ["market", "trending"] });
});

test("a legacy cooldown appearing while waiting for the global request slot prevents the child", async (t) => {
  const fx = await fixture(t);
  await fx.client.checkConfig();
  const other = createGmgnFlowClient(fx.config, { ...fx.dependencies, sleepImpl: async (ms) => {
    fx.advance(ms);
    await fs.writeFile(path.join(fx.dataDir, "fomo-call-state.json"), JSON.stringify({ publicOnchain: {
      smartMoney: { rateLimitedUntil: new Date(START + 600_000).toISOString() },
    } }));
  } });
  t.after(() => other.stop());
  await assert.rejects(other.trending("bsc"), { code: "GMGN_RATE_LIMITED" });
  assert.equal(fx.calls.length, 1);
});

test("malformed cooldown files fail closed rather than bypassing shared account protection", async (t) => {
  const fx = await fixture(t);
  await fs.writeFile(path.join(fx.dataDir, "gmgn-flow-rate-limit.json"), '{"version":1,"rateLimitedUntil":"bad"}');
  await assert.rejects(fx.client.checkConfig(), { code: "GMGN_STATE_INVALID" });
  assert.equal(fx.calls.length, 0);
});

test("a failed atomic cooldown write latches the client closed without another request", async (t) => {
  let launches = 0;
  const fx = await fixture(t, { dependencies: { fsImpl: { ...fs, rename: async () => { throw new Error("disk fault"); } } },
    execFileImpl: async (_file, args) => {
      launches++;
      if (args[0] === "config") return { stdout: "ok" };
      throw new Error("HTTP 429");
    },
  });
  await assert.rejects(fx.client.trending("sol"), { code: "GMGN_STATE_WRITE_FAILED" });
  fx.advance(600_000);
  await assert.rejects(fx.client.trending("sol"), { code: "GMGN_STATE_WRITE_FAILED" });
  assert.equal(launches, 2);
});

test("ordinary narrative words do not fabricate a rate limit in a successful token response", async (t) => {
  const fx = await fixture(t, { execFileImpl: async (_file, args) => ({ stdout: args[0] === "config" ? "ok"
    : JSON.stringify({ address: EVM, link: { description: "API tooling: rate limit resets at 2030-01-01T00:00:00Z; code 429" } }) }) });
  assert.equal((await fx.client.info("eth", EVM)).address, EVM);
  await assert.rejects(fs.stat(path.join(fx.dataDir, "gmgn-flow-rate-limit.json")), { code: "ENOENT" });
});

test("invalid JSON, error envelopes and unknown CLI failures stay errors without leaking stderr", async (t) => {
  for (const [mode, expected] of [["json", "GMGN_INVALID_RESPONSE"], ["null", "GMGN_INVALID_RESPONSE"],
    ["envelope", "GMGN_API_FAILED"], ["exec", "GMGN_CLI_FAILED"], ["oversize", "GMGN_RESPONSE_TOO_LARGE"]]) {
    await t.test(mode, async (t) => {
      const fx = await fixture(t, { execFileImpl: async (_file, args) => {
        if (args[0] === "config") return { stdout: "ok" };
        if (mode === "exec") throw Object.assign(new Error("secret value in command"), { stderr: "credential=do-not-show" });
        return { stdout: ({ json: "not json", null: "null", envelope: '{"code":503,"message":"unavailable"}',
          oversize: "x".repeat(4 * 1024 * 1024 + 1) })[mode] };
      } });
      await assert.rejects(fx.client.trades("sol", "kol"), (error) => {
        assert.equal(error.code, expected); assert.doesNotMatch(JSON.stringify(error), /secret|credential|do-not-show/); return true;
      });
    });
  }
});

test("stop kills an active child, cancels queued requests and is permanently closed", async (t) => {
  let childStarted;
  const started = new Promise((resolve) => { childStarted = resolve; });
  let killed = 0;
  let launches = 0;
  const fx = await fixture(t, { execFileImpl: (_file, args, _options, callback) => {
    launches++;
    if (args[0] === "config") { queueMicrotask(() => callback(null, "ok", "")); return { kill() {} }; }
    childStarted();
    return { kill(signal) { assert.equal(signal, "SIGKILL"); killed++; } };
  } });
  const first = fx.client.trending("bsc");
  const second = fx.client.trades("sol", "kol");
  const accepted = Promise.allSettled([first, second]);
  await started;
  await fx.client.stop();
  for (const result of await accepted) assert.equal(result.reason.code, "GMGN_STOPPED");
  await assert.rejects(fx.client.info("eth", EVM), { code: "GMGN_STOPPED" });
  assert.equal(killed, 1);
  assert.equal(launches, 2);
});

test("CLI timeout kills the bounded child and rejects rather than stalling the global queue", async (t) => {
  let killed = 0;
  const fx = await fixture(t, { config: { gmgnFlowRequestTimeoutMs: 100 }, execFileImpl: (_file, args, _options, callback) => {
    if (args[0] === "config") queueMicrotask(() => callback(null, "ok", ""));
    return { kill() { killed++; } };
  } });
  await assert.rejects(fx.client.trending("bsc"), { code: "GMGN_CLI_TIMEOUT" });
  assert.equal(killed, 1);
});
