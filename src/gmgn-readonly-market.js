import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseGmgnFlowRateLimit } from './gmgn-flow-client.js';
import { createGmgnAccountGate } from './gmgn-account-gate.js';
import { gmgnFlowAddress } from './gmgn-flow-signal.js';
import { enqueueReadonly, readonlyQueueSnapshot } from './readonly-priority-queue.js';
import { GMGN_READONLY_INTERVAL_MS, gmgnReadonlyPolicy } from './gmgn-readonly-pacing.js';
import { createReadonlyProcessRunner } from './gmgn-readonly-process.js';
import {classifyGmgnReadError} from './gmgn-read-error.js';

const execFile = promisify(nodeExecFile);

// Robinhood Chain is supported by the read-only market/trenches CLI. It is
// intentionally included here as a market feed only; this does not enable any
// wallet, signer, or swap capability.
export const GMGN_CHAINS = Object.freeze(['sol', 'bsc', 'base', 'eth', 'robinhood']);
export const GMGN_INTERVALS = Object.freeze(['1m', '5m', '1h', '6h', '24h']);
export const GMGN_RESOLUTIONS = Object.freeze(['30s', '1m', '5m', '15m', '1h', '4h', '1d']);
const GMGN_ORDER_BY = 'volume';
// Keep the read-only feed gentle on the upstream API. A successful snapshot is
// retained beyond its short refresh window so a transient 429 does not make
// the dashboard look empty; callers can label that snapshot as stale.
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_BUFFER = 4 * 1024 * 1024;
const REQUEST_INTERVAL_MS = GMGN_READONLY_INTERVAL_MS;
const SHARED_SCHEDULER = { tail: Promise.resolve(), lastStartedAt: null, rateLimitedUntil: 0 };
const TRENCHES_CATEGORIES = Object.freeze({ new_creation: 'new_creation', near_completion: 'pump', completed: 'completed' });

const numberOrNull = value => {
  if (value == null || typeof value === 'boolean' || !['number', 'string'].includes(typeof value) || (typeof value === 'string' && !value.trim())) return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const boolOrNull = value => typeof value === 'boolean' ? value : [1, '1', 'true', 'yes'].includes(value) ? true : [0, '0', 'false', 'no'].includes(value) ? false : null;

const validChoice = (value, choices) => typeof value === 'string' && choices.includes(value);

function assertChain(chain) {
  if (!validChoice(chain, GMGN_CHAINS)) throw new TypeError('invalid chain');
}

function assertInterval(interval) {
  if (!validChoice(interval, GMGN_INTERVALS)) throw new TypeError('invalid interval');
}

function assertResolution(resolution) {
  if (!validChoice(resolution, GMGN_RESOLUTIONS)) throw new TypeError('invalid resolution');
}

function assertAddress(address) {
  if (typeof address !== 'string' || address.length < 8 || address.length > 128 || !/^[A-Za-z0-9_-]+$/.test(address)) {
    throw new TypeError('invalid address');
  }
}

function riskGate(item) {
  const rugRatio = numberOrNull(item.rug_ratio);
  if (boolOrNull(item.is_honeypot) === true || boolOrNull(item.is_wash_trading) === true || rugRatio > 0.3) return 'BLOCKED';
  if ((numberOrNull(item.smart_degen_count) ?? 0) >= 3 && rugRatio !== null && rugRatio < 0.2 && boolOrNull(item.creator_close) === true && boolOrNull(item.is_wash_trading) === false && boolOrNull(item.is_honeypot) === false && (numberOrNull(item.liquidity) ?? 0) > 50_000) return 'STRONG';
  return 'WATCH';
}

function addressKey(chain, address) { return chain === 'sol' ? address : address.toLowerCase(); }

function assertIdentity(item, chain, address = null) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return;
  if (item.chain != null && (typeof item.chain !== 'string' || item.chain.toLowerCase() !== chain)) throw new TypeError('upstream chain mismatch');
  if (address !== null) {
    for (const field of ['address', 'token_address']) {
      if (item[field] != null && (typeof item[field] !== 'string' || addressKey(chain, item[field]) !== addressKey(chain, address))) throw new TypeError('upstream address mismatch');
    }
  }
}

function assertEnvelope(payload, chain, address = null) {
  if (!payload || typeof payload !== 'object' || payload.error || payload.success === false || (payload.code != null && ![0, 200].includes(Number(payload.code)))) throw new TypeError('invalid upstream envelope');
  assertIdentity(payload, chain, address);
  assertIdentity(payload.data, chain, address);
}

function observedStage(item, category = null) {
  const fromCategory = category === 'completed' ? 'external' : ['new_creation', 'near_completion'].includes(category) ? 'internal' : 'unknown';
  const fromStatus = item.launchpad_status === '0' || item.launchpad_status === 0 ? 'internal' : item.launchpad_status === '1' || item.launchpad_status === 1 ? 'external' : 'unknown';
  const stageConflict = fromCategory !== 'unknown' && fromStatus !== 'unknown' && fromCategory !== fromStatus;
  return {
    marketStage: stageConflict ? 'unknown' : fromCategory !== 'unknown' ? fromCategory : fromStatus,
    stageConflict,
    marketCategory: category,
    stageSource: stageConflict ? 'conflicting_fields' : fromCategory !== 'unknown' ? `trenches:${category}` : fromStatus !== 'unknown' ? 'launchpad_status' : null,
  };
}

function normalizeToken(item, fallbackChain, category = null, source = null) {
  if (!item || typeof item !== 'object' || typeof item.address !== 'string') return null;
  assertIdentity(item, fallbackChain);
  assertAddress(item.address);
  // Reject EVM/Solana address mixups; retain shortened EVM fixture compatibility.
  if (fallbackChain !== 'sol' && !/^0x[0-9a-fA-F]+$/.test(item.address)) throw new TypeError('upstream address mismatch');
  if (fallbackChain === 'sol' && !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(item.address)) throw new TypeError('upstream address mismatch');
  const progress = numberOrNull(item.progress);
  const token = {
    address: addressKey(fallbackChain, item.address),
    symbol: typeof item.symbol === 'string' && item.symbol ? item.symbol : 'UNKNOWN',
    name: typeof item.name === 'string' ? item.name : '',
    logo: typeof item.logo === 'string' ? item.logo : '',
    chain: fallbackChain,
    ...observedStage(item, category),
    bondingCurveProgress: progress !== null && progress >= 0 && progress <= 1 ? progress : null,
    price: numberOrNull(item.price),
    change: numberOrNull(item.price_change_percent),
    priceChange1m: numberOrNull(item.price_change_percent1m),
    priceChange5m: numberOrNull(item.price_change_percent5m),
    priceChange1h: numberOrNull(item.price_change_percent1h),
    totalSupply: numberOrNull(item.total_supply),
    marketCap: numberOrNull(item.market_cap ?? item.usd_market_cap),
    liquidity: numberOrNull(item.liquidity),
    volume: numberOrNull(item.volume),
    volume1h: numberOrNull(item.volume_1h),
    volume24h: numberOrNull(item.volume_24h),
    netBuy24h: numberOrNull(item.net_buy_24h),
    swaps1m: numberOrNull(item.swaps_1m),
    swaps1h: numberOrNull(item.swaps_1h),
    swaps24h: numberOrNull(item.swaps_24h),
    buys24h: numberOrNull(item.buys_24h),
    sells24h: numberOrNull(item.sells_24h),
    initialLiquidity: numberOrNull(item.initial_liquidity),
    historyHighestMarketCap: numberOrNull(item.history_highest_market_cap),
    swaps: numberOrNull(item.swaps),
    buys: numberOrNull(item.buys),
    sells: numberOrNull(item.sells),
    holders: numberOrNull(item.holder_count),
    smartDegenCount: numberOrNull(item.smart_degen_count),
    renownedCount: numberOrNull(item.renowned_count),
    rugRatio: numberOrNull(item.rug_ratio),
    isHoneypot: boolOrNull(item.is_honeypot),
    // The provider can return BOTH flags as zero while is_honeypot is false.
    // These are not established complements: absence of a positive can_sell
    // signal is not proof of prohibition. Keep the negative flag and preserve
    // uncertainty; never convert this fix into a positive sellability claim.
    cannotSell: boolOrNull(item.can_not_sell) === true ? true : null,
    sellabilityFlags: { canSell:boolOrNull(item.can_sell),cannotSell:boolOrNull(item.can_not_sell),
      interpretation:'原始辅助标记，未核实为互斥布尔值；非买卖模拟或实际可卖出证明' },
    isBlacklisted: boolOrNull(item.is_blacklist ?? item.blacklist),
    isWashTrading: boolOrNull(item.is_wash_trading),
    isOpenSource: boolOrNull(item.is_open_source ?? item.open_source),
    isRenounced: boolOrNull(item.is_renounced ?? item.owner_renounced),
    // The rank endpoint explicitly encodes no tax as "". This meaning does
    // NOT extend to absent keys, null, or token-security/trenches responses.
    buyTax: source === 'trending' && item.buy_tax === '' ? 0 : item.buy_tax ?? null,
    sellTax: source === 'trending' && item.sell_tax === '' ? 0 : item.sell_tax ?? null,
    top10HolderRate: numberOrNull(item.top_10_holder_rate),
    creatorTokenStatus: typeof item.creator_token_status === 'string' ? item.creator_token_status : '',
    creatorClose: boolOrNull(item.creator_close),
    creator: typeof item.creator === 'string' ? item.creator : '',
    launchpadPlatform: typeof item.launchpad_platform === 'string' ? item.launchpad_platform : '',
    launchpad: typeof item.launchpad === 'string' ? item.launchpad : '',
    launchpadStatus: item.launchpad_status ?? null,
    exchange: typeof item.exchange === 'string' ? item.exchange : '',
    twitterUsername: typeof (item.twitter_username || item.link?.twitter_username) === 'string' ? item.twitter_username || item.link.twitter_username : '',
    website: typeof (item.website || item.link?.website) === 'string' ? item.website || item.link.website : '',
    narrativeTags: (Array.isArray(item.tags) ? item.tags : []).filter(tag=>typeof tag==='string'&&tag.length<=120).slice(0,40),
    telegram: typeof item.telegram === 'string' ? item.telegram : '',
    creationTimestamp: numberOrNull(item.creation_timestamp ?? item.created_timestamp),
    openTimestamp: numberOrNull(item.open_timestamp),
    completeTimestamp: numberOrNull(item.complete_timestamp),
    rank: numberOrNull(item.rank),
    hotLevel: numberOrNull(item.hot_level),
    gasFee: numberOrNull(item.gas_fee),
    burnRatio: numberOrNull(item.burn_ratio),
    burnStatus: typeof item.burn_status === 'string' ? item.burn_status : '',
    renouncedMint: item.renounced_mint ?? null,
    renouncedFreezeAccount: item.renounced_freeze_account ?? null,
    isTokenLive: item.is_token_live ?? null,
    tcid: typeof item.tcid === 'string' ? item.tcid : '',
    botDegenCount: numberOrNull(item.bot_degen_count),
    botDegenRate: numberOrNull(item.bot_degen_rate),
    lockPercent: numberOrNull(item.lock_percent),
    bundlerRate: numberOrNull(item.bundler_rate ?? item.bundler_trader_amount_rate),
    entrapmentRatio: numberOrNull(item.entrapment_ratio),
    sniperCount: numberOrNull(item.sniper_count),
    devTeamHoldRate: numberOrNull(item.dev_team_hold_rate),
    top70SniperHoldRate: numberOrNull(item.top70_sniper_hold_rate),
    ratTraderAmountRate: numberOrNull(item.rat_trader_amount_rate),
    bluechipOwnerPercentage: numberOrNull(item.bluechip_owner_percentage),
    ctoFlag: boolOrNull(item.cto_flag),
    raw: item,
  };
  token.risk = riskGate(item);
  return token;
}

function normalizeCandle(item) {
  if (!item || typeof item !== 'object') return null;
  const time = numberOrNull(item.time);
  const open = numberOrNull(item.open);
  const close = numberOrNull(item.close);
  const high = numberOrNull(item.high);
  const low = numberOrNull(item.low);
  if (time === null || close === null) return null;
  return { time, open, close, high, low, volume: numberOrNull(item.volume), amount: numberOrNull(item.amount), source: typeof item.source === 'string' ? item.source : null };
}

function parseJson(stdout) {
  try { return JSON.parse(String(stdout).trim()); } catch { return null; }
}

function rankItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data?.rank)) return payload.data.rank;
  if (Array.isArray(payload?.rank)) return payload.rank;
  return [];
}

function candleItems(payload) {
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  if (Array.isArray(payload)) return payload;
  return [];
}

const unavailable = (extra = {}) => ({ status: 'unavailable', source: 'gmgn-cli', reason: 'gmgn_unavailable', observedAt: null, ...extra });
const safeFailureCode = error => ['GMGN_QUEUE_EXPIRED', 'GMGN_REQUEST_BUSY', 'GMGN_STATE_INVALID', 'GMGN_STOPPED', 'GMGN_RATE_LIMITED', 'GMGN_CLI_TIMEOUT', 'GMGN_INVALID_QUOTE', 'GMGN_IDENTITY_MISMATCH'].includes(error?.code)
  ? error.code : error?.message === 'gmgn_rate_limited' ? 'GMGN_RATE_LIMITED'
    : ['upstream address mismatch', 'upstream chain mismatch'].includes(error?.message) ? 'GMGN_IDENTITY_MISMATCH'
      : error?.message === 'invalid quote' ? 'GMGN_INVALID_QUOTE' : classifyGmgnReadError(error)||'GMGN_UNAVAILABLE';

function createQueuedRunner({ cliPath, timeoutMs, dataDir, execute, now, sleep, scheduler }) {
  const accountGate=execute===execFile?createGmgnAccountGate(dataDir):null;
  const cooldownGate=accountGate?createGmgnAccountGate(path.join(dataDir,'gmgn-cooldown-write'),{intervalMs:1}):null;
  const rateFile = path.join(dataDir, 'gmgn-flow-rate-limit.json');
  let writeFault = false;
  const controller = new AbortController(), jobs = new Set();

  async function readCooldown() {
    try {
      const stat = await fs.stat(rateFile);
      if (!stat.isFile() || stat.size > 16_384) throw new Error('gmgn_cooldown_invalid');
      const raw = await fs.readFile(rateFile, 'utf8');
      if (Buffer.byteLength(raw) > 16_384) throw new Error('gmgn_cooldown_invalid');
      const state = JSON.parse(raw);
      const until = Date.parse(state?.rateLimitedUntil);
      if (state?.version !== 1 || !Number.isFinite(until)) throw new Error('gmgn_cooldown_invalid');
      scheduler.rateLimitedUntil = Math.max(scheduler.rateLimitedUntil || 0, until);
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
  }

  async function checkCooldown() {
    if (writeFault) throw new Error('gmgn_cooldown_write_failed');
    await readCooldown();
    try {
      const file=path.join(dataDir,'fomo-call-state.json'),stat=await fs.stat(file);
      if(!stat.isFile()||stat.size>32*1024*1024)throw new Error('gmgn_cooldown_invalid');
      const state=JSON.parse(await fs.readFile(file,'utf8'));
      const value=state?.publicOnchain?.smartMoney?.rateLimitedUntil;
      if(value!=null){const until=Date.parse(value);if(!Number.isFinite(until))throw new Error('gmgn_cooldown_invalid');scheduler.rateLimitedUntil=Math.max(scheduler.rateLimitedUntil||0,until);}
    }catch(e){if(e.code!=='ENOENT')throw e;}
    if (now() < scheduler.rateLimitedUntil) throw new Error('gmgn_rate_limited');
  }

  async function persistCooldown(until) {
    scheduler.rateLimitedUntil = Math.max(scheduler.rateLimitedUntil || 0, until + 1000);
    const temporary = `${rateFile}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      await readCooldown();
      await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
      handle = await fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify({ version: 1, rateLimitedUntil: new Date(scheduler.rateLimitedUntil).toISOString(), checkedAt: new Date(now()).toISOString(), reason: 'gmgn_cli_rate_limit' })}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await fs.rename(temporary, rateFile);
    } catch (error) {
      writeFault = true;
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fs.unlink(temporary).catch(() => {});
    }
  }

  const executionOptions = () => ({ timeout: timeoutMs, killSignal: 'SIGKILL', maxBuffer: MAX_BUFFER, shell: false, encoding: 'utf8', signal: controller.signal });
  async function checkConfiguration() {
    let configuration;
    try { configuration = await execute(cliPath, ['config', '--check'], executionOptions()); }
    catch(error) {
      if(parseGmgnFlowRateLimit(error,now())||error?.killed||error?.code==='ETIMEDOUT')throw error;
      throw Object.assign(new Error('GMGN_CONFIG_FAILED'),{code:'GMGN_CONFIG_FAILED'});
    }
    const retry = parseGmgnFlowRateLimit(configuration?.stderr, now());
    if (retry) throw { status: 429, reset_at: retry };
  }
  async function failSafely(error) {
    const until = parseGmgnFlowRateLimit(error, now());
    if (until) {
      try { await (cooldownGate ? cooldownGate(()=>persistCooldown(until)) : persistCooldown(until)); }
      catch(error) { writeFault=true;throw error; }
    }
    // Consumers only receive an unavailable/stale status, never CLI diagnostics.
    throw Object.assign(new Error('gmgn_unavailable'), { code: until ? 'GMGN_RATE_LIMITED'
      : error?.killed || error?.code === 'ETIMEDOUT' ? 'GMGN_CLI_TIMEOUT' : safeFailureCode(error) });
  }

  async function executeChecked(args, onRequestStart, configurationChecked = false) {
    if (!configurationChecked) await checkCooldown();
    // The cross-process gate already spaces real requests. Do not sleep again
    // after taking a lease; this used to hold up exits behind background work.
    const remaining = accountGate || scheduler.lastStartedAt === null ? 0 : scheduler.lastStartedAt + REQUEST_INTERVAL_MS - now();
    if (remaining > 0) { await sleep(remaining); await checkCooldown(); }
    try {
      if (!configurationChecked) await checkConfiguration();
      // Recheck after both configuration and admission: a monitor can enter
      // cooldown while either is pending. Bind quote clocks only after this.
      await checkCooldown();
      scheduler.lastStartedAt = now();
      onRequestStart?.(scheduler.lastStartedAt);
      const result = await execute(cliPath, args, executionOptions());
      const retry = parseGmgnFlowRateLimit(result?.stderr, now()) || parseGmgnFlowRateLimit(parseJson(result?.stdout), now());
      if (retry) throw { status: 429, reset_at: retry };
      return result.stdout;
    } catch (error) { return failSafely(error); }
  }

  const run = (args, { onRequestStart, priority = 0 } = {}) => {
    if(controller.signal.aborted)return Promise.reject(Object.assign(new Error('GMGN_STOPPED'),{code:'GMGN_STOPPED'}));
    const policy=accountGate?gmgnReadonlyPolicy(dataDir):{concurrency:1,normalConcurrency:1};
    const queuedAt=now(),kind=`${args[0]}:${args[1]}`;
    const record={kind,priority,queuedAt:new Date(queuedAt).toISOString(),localQueueMs:null,accountWaitMs:null,preflightMs:null,requestMs:null,
      preflightPlacement:accountGate?'before_account_gate_v1':'serial',
      chain:args.includes('--chain')?args[args.indexOf('--chain')+1]:null,
      address:args.includes('--address')?args[args.indexOf('--address')+1]:null};
    let localStartedAt,admittedAt,requestedAt,workFinishedAt;
    const executeWork=(configurationChecked=false)=>{admittedAt=now();return executeChecked(args,at=>{
      requestedAt=at;record.preflightMs=(record.preflightMs||0)+Math.max(0,at-admittedAt);onRequestStart?.(at);
    },configurationChecked).finally(()=>{workFinishedAt=now();if(requestedAt!=null)record.requestMs=Math.max(0,workFinishedAt-requestedAt);});};
    const admittedWork=async()=>{
      if(!accountGate)return executeWork();
      // config --check only checks local configuration in the installed CLI.
      // Keep one fresh check PER request, but do not occupy an upstream lease
      // during CLI startup. The existing bounded local ready set also bounds
      // these checks; all business commands still enter the shared gate.
      const preflightStartedAt=now();
      try { await checkCooldown();await checkConfiguration();await checkCooldown(); }
      catch(error) { return failSafely(error); }
      finally { record.preflightMs=Math.max(0,now()-preflightStartedAt); }
      const gateQueuedAt=now();
      return accountGate(()=>executeWork(true),controller.signal,{priority,onAdmitted:admission=>{
        record.accountWaitMs=Math.max(0,now()-gateQueuedAt);record.accountQueueScans=admission.queueScans;
      }});
    };
    const job = enqueueReadonly(scheduler,admittedWork,
    // These are bounded GATE WAITERS, not upstream requests. Reusing the
    // network concurrency here strands a normal seat behind a background job
    // waiting for the shared background seat in another process. Let the
    // cross-process gate arbitrate a small ready set; it ALONE owns native
    // business concurrency/pacing. Mock transports keep serial admission.
    {priority,now,kind,admissionOnly:!!accountGate,
      concurrency:accountGate?policy.concurrency+3:policy.concurrency,
      normalConcurrency:accountGate?policy.normalConcurrency+2:policy.normalConcurrency,
      // Background must survive the existing 30s aging promotion, otherwise
      // expiry itself starves the reserved discovery turns under sustained load.
      maxPending:priority===2?8:24,maxWaitMs:priority===2?15000:priority===1?20000:60000,
      onStart:()=>{localStartedAt=now();record.localQueueMs=Math.max(0,localStartedAt-queuedAt);}})
      .then(result=>{record.status='ok';return result;},error=>{
        record.status=controller.signal.aborted?'GMGN_STOPPED':safeFailureCode(error);
        throw Object.assign(new Error(record.status),{code:record.status});
      })
      .finally(()=>{
        record.completedAt=new Date(now()).toISOString();record.totalMs=Math.max(0,now()-queuedAt);
        record.accountReleaseMs=workFinishedAt==null?null:Math.max(0,now()-workFinishedAt);
        scheduler.requestHistory ||= [];scheduler.requestHistory.push(record);
        if(scheduler.requestHistory.length>64)scheduler.requestHistory.splice(0,scheduler.requestHistory.length-64);
      });
    jobs.add(job);job.then(()=>jobs.delete(job),()=>jobs.delete(job));return job;
  };
  run.diagnostics=()=>({...readonlyQueueSnapshot(scheduler,now()),recent:structuredClone(scheduler.requestHistory||[])});
  run.close=async()=>{
    controller.abort();
    for(const item of scheduler.pending?.splice(0)||[]){clearTimeout(item.timer);item.reject(Object.assign(new Error('GMGN_STOPPED'),{code:'GMGN_STOPPED'}));}
    await Promise.allSettled([...jobs]);
  };
  return run;
}

// Used by the dedicated read-only child. No signer / execution routes exist here.
export function createNativeReadonlyRunner({cliPath,timeoutMs=DEFAULT_TIMEOUT_MS,dataDir}={}) {
  return createQueuedRunner({cliPath,timeoutMs,dataDir,execute:execFile,now:Date.now,
    sleep:ms=>new Promise(resolve=>setTimeout(resolve,ms)),scheduler:{lastStartedAt:null,rateLimitedUntil:0}});
}

export function createReadonlyMarketClient({ runner = null, ttlMs = DEFAULT_TTL_MS, quoteTtlMs = 3000, trendingTtlMs = ttlMs, timeoutMs = DEFAULT_TIMEOUT_MS,
  cliPath = process.env.GMGN_FLOW_CLI_PATH || 'gmgn-cli', dataDir = path.resolve('data'),
  execFileImpl = execFile, now = Date.now, sleepImpl = ms => new Promise(resolve => setTimeout(resolve, ms)),
  scheduler = SHARED_SCHEDULER, isolated = false } = {}) {
  const run = runner || (isolated && execFileImpl===execFile
    ? createReadonlyProcessRunner({cliPath,timeoutMs,dataDir:path.resolve(dataDir)})
    : createQueuedRunner({ cliPath, timeoutMs, dataDir: path.resolve(dataDir), execute: execFileImpl, now, sleep: sleepImpl, scheduler }));
  const cache = new Map();
  const pendingInfo = new Map();

  function tokenInfo(chain, address, priority) {
    const key = `${chain}:${address}`;
    // Share the underlying public read, not a new observation. Never let a
    // queued low-priority research request hold an urgent exit behind it.
    const pending = pendingInfo.get(key) || new Map();
    for (let p = 2; p >= priority; p--) if (pending.has(p)) return pending.get(p);
    const job = Promise.resolve().then(async () => {
      const queuedAt = now(); let requestedAt = queuedAt;
      const payload = parseJson(await run(['token', 'info', '--chain', chain, '--address', address, '--raw'],
        { priority, onRequestStart: at => { requestedAt = at; } }));
      assertEnvelope(payload, chain, address);
      const data = payload.data ?? payload;
      if (gmgnFlowAddress(chain, data?.address) !== address) throw new TypeError('upstream address mismatch');
      return { data, queuedAt, requestedAt, receivedAt: now() };
    }).finally(() => {
      pending.delete(priority);
      if (!pending.size) pendingInfo.delete(key);
    });
    pending.set(priority, job); pendingInfo.set(key, pending);
    return job;
  }

  async function cached(key, load, lifetime = ttlMs) {
    const previous = cache.get(key);
    const requestedAt = now();
    if (previous && (previous.pending || previous.expiresAt > requestedAt)) return previous.promise;
    const entry = { expiresAt: requestedAt + lifetime, pending: true, promise: null, lastSuccess: previous?.lastSuccess || null };
    entry.promise = Promise.resolve().then(load).then(result => {
      entry.succeeded = result?.status === 'ok';
      if (result?.status === 'ok') entry.lastSuccess = result;
      return result;
    }).catch(error => { entry.failureCode = safeFailureCode(error); return null; }).finally(() => {
      entry.pending = false;
      // Queue expiry is not a failed upstream sample. Retry on a later scan,
      // with bounded backoff, without holding a stale job indefinitely.
      entry.expiresAt = now() + (['GMGN_QUEUE_EXPIRED','GMGN_REQUEST_BUSY'].includes(entry.failureCode)?Math.min(lifetime,5000):lifetime);
    });
    cache.set(key, entry);
    if (cache.size > 200) for (const [oldKey, old] of cache) {
      if (!old.pending && oldKey !== key) { cache.delete(oldKey); break; }
    }
    return entry.promise;
  }

  // Public token-info only. Request time is a conservative local observation
  // bound, NOT an exchange/block timestamp. Failed refreshes never renew it.
  async function quote({ chain, address, purpose = 'candidate', afterObservedAt = null } = {}) {
    assertChain(chain);
    const normalized = gmgnFlowAddress(chain, address);
    if (!normalized) throw new TypeError('invalid address');
    const critical = ['exit', 'entry_confirmation'].includes(purpose);
    // A queued background read must not capture an execution-critical request.
    // Critical reads still share their own cache and the existing account gate.
    const key = `quote:${chain}:${normalized}${critical ? ':critical' : ''}`;
    // A second confirmation must be an independent read, not the first result
    // cached for three seconds AFTER its slow response. Keep pending reads and
    // failed-read backoff intact; never bypass account pacing or a 429 cooldown.
    const prior = cache.get(key), after = Date.parse(afterObservedAt || '');
    const previousAt = Date.parse(prior?.lastSuccess?.observedAt || '');
    if (['candidate','entry_confirmation'].includes(purpose) && Number.isFinite(after) && after<=now() && now()-after>=3000
      && prior?.succeeded && !prior.pending && Number.isFinite(previousAt) && previousAt<=after)
      prior.expiresAt=0;
    const result = await cached(key, async () => {
      const { data, queuedAt, requestedAt, receivedAt } = await tokenInfo(chain, normalized, critical ? 2 : ['learning','comparison'].includes(purpose) ? 0 : 1);
      const price = numberOrNull(data?.price?.price);
      if (price === null || price <= 0) throw new TypeError('invalid quote');
      return { status: 'ok', chain, address: normalized, price, source: 'gmgn-cli-token-info',
        queuedAt: new Date(queuedAt).toISOString(), observedAt: new Date(requestedAt).toISOString(),
        receivedAt: new Date(receivedAt).toISOString(), timestampKind: 'local_request' };
    }, quoteTtlMs);
    if (result?.status === 'ok') return result;
    const previous = cache.get(key)?.lastSuccess;
    const reasonCode = cache.get(key)?.failureCode || 'GMGN_UNAVAILABLE';
    return previous ? { ...previous, status: 'stale', stale: true, staleReason: 'gmgn_unavailable', reasonCode } : unavailable({ chain, address: normalized, reasonCode });
  }

  async function trending({ chain, interval = '1m', limit = 20, purpose = 'research' } = {}) {
    assertChain(chain); assertInterval(interval);
    const requestedLimit = Math.min(50, Math.max(1, Number(limit) || 20));
    const key = `trending:${chain}:${interval}:${requestedLimit}`;
    const result = await cached(key, async () => {
      const queuedAt = now(); let requestedAt = queuedAt;
      const stdout = await run(['market', 'trending', '--chain', chain, '--interval', interval, '--order-by', GMGN_ORDER_BY, '--limit', String(requestedLimit), '--raw'],
        { priority: purpose === 'scan' ? 1 : 0, onRequestStart: at => { requestedAt = at; } });
      const payload = parseJson(stdout);
      assertEnvelope(payload, chain);
      if(!Array.isArray(payload)&&!Array.isArray(payload?.data?.rank)&&!Array.isArray(payload?.rank))
        throw Object.assign(new Error('invalid rank response'),{code:'GMGN_INVALID_RESPONSE'});
      const tokens = rankItems(payload).map(item => normalizeToken(item, chain, null, 'trending')).filter(Boolean);
      const observedAt = new Date(requestedAt).toISOString();
      tokens.forEach(token => { token.stageObservedAt = observedAt; token.volumeWindow = interval; });
      return { status: 'ok', source: 'gmgn-cli', chain, interval, orderBy: GMGN_ORDER_BY, observedAt, tokens,
        queuedAt: new Date(queuedAt).toISOString(), receivedAt: new Date(now()).toISOString(), timestampKind: 'local_request' };
    }, ['1m','5m'].includes(interval) ? trendingTtlMs : ttlMs);
    if (result?.status === 'ok') return result;
    const lastSuccess = cache.get(key)?.lastSuccess;
    const reasonCode=cache.get(key)?.failureCode||'GMGN_UNAVAILABLE';
    return lastSuccess
      ? { ...lastSuccess, status: 'stale', stale: true, staleReason: 'gmgn_unavailable', reasonCode, staleAt: new Date(now()).toISOString() }
      : unavailable({ chain, interval,reasonCode });
  }

  async function details({ chain, address, purpose = 'research' } = {}) {
    assertChain(chain);
    const normalized = gmgnFlowAddress(chain, address);
    if (!normalized) throw new TypeError('invalid address');
    const key = `details:${chain}:${normalized}`;
    const result = await cached(key, async () => {
      // Independent public reads enter the SAME bounded queue together. Do not
      // add a second queue wait after token-info has already become old.
      const priority = purpose === 'candidate' ? 1 : 0;
      let securityRequestedAt = now();
      const [info, securityText] = await Promise.all([
        tokenInfo(chain, normalized, priority),
        Promise.resolve().then(() => run(['token', 'security', '--chain', chain, '--address', normalized, '--raw'],
          { priority, onRequestStart: at => { securityRequestedAt = at; } })),
      ]);
      const { data, requestedAt, queuedAt } = info;
      const securityPayload = parseJson(securityText);
      assertEnvelope(securityPayload, chain, normalized);
      const security = securityPayload.data ?? securityPayload;
      if (!security || typeof security !== 'object' || Array.isArray(security)) throw new TypeError('invalid security');
      const token = normalizeToken({ ...data, ...security, address: normalized, chain,
        price: data.price?.price, volume_1h: data.price?.volume_1h, volume_24h: data.price?.volume_24h,
        liquidity: data.liquidity ?? data.pool?.liquidity,
        top_10_holder_rate: security.top_10_holder_rate ?? data.stat?.top_10_holder_rate,
        dev_team_hold_rate: security.dev_team_hold_rate ?? data.stat?.dev_team_hold_rate,
        bundler_trader_amount_rate: security.bundler_trader_amount_rate ?? data.stat?.top_bundler_trader_percentage,
        creator: data.dev?.creator_address ?? data.creator,
        exchange: data.pool?.exchange ?? data.exchange,
      }, chain);
      const observedAt = new Date(Math.min(requestedAt, securityRequestedAt)).toISOString();
      token.stageObservedAt = observedAt;
      return { status: 'ok', source: 'gmgn-cli-token-research', chain, address: normalized, token, observedAt,
        infoObservedAt: new Date(requestedAt).toISOString(), securityObservedAt: new Date(securityRequestedAt).toISOString(),
        queuedAt: new Date(queuedAt).toISOString(), receivedAt: new Date(now()).toISOString(), timestampKind: 'local_request' };
    }, purpose === 'candidate' ? 30_000 : 60_000);
    if (result?.status === 'ok') return result;
    const previous = cache.get(key)?.lastSuccess;
    const reasonCode=cache.get(key)?.failureCode||'GMGN_UNAVAILABLE';
    return previous ? { ...previous, status: 'stale', stale: true,reasonCode } : unavailable({ chain, address: normalized,reasonCode });
  }

  async function kline({ chain, address, resolution = '1m', from, to, purpose = 'research', latestClosed = false } = {}) {
    assertChain(chain); assertResolution(resolution); assertAddress(address);
    if(typeof latestClosed!=='boolean' || latestClosed && resolution!=='1m')throw new TypeError('invalid latest closed window');
    const end = numberOrNull(to) !== null ? Math.floor(Number(to)) : Math.floor(now() / 1000);
    const start = numberOrNull(from) !== null ? Math.floor(Number(from)) : end - 6 * 60 * 60;
    if (start >= end || end - start > 7 * 24 * 60 * 60) throw new TypeError('invalid time range');
    const duration=end-start;
    const key = latestClosed ? `kline-latest:${chain}:${address}:${resolution}:${duration}` : `kline:${chain}:${address}:${resolution}:${start}:${end}`;
    const previous=cache.get(key);
    // Keep one in-flight request per token, but do not let its stable cache key
    // swallow a genuinely new closed minute. Failures retain the normal TTL.
    if(latestClosed && !previous?.pending && previous?.succeeded
      && Math.floor(now()/60000)*60>previous.lastSuccess.to
      && now()-Date.parse(previous.lastSuccess.receivedAt)>=5000)previous.expiresAt=0;
    const result = await cached(key, async () => {
      const queuedAt=now();let requestedAt=queuedAt,requestEnd=end,requestStart=start;
      const args=['market', 'kline', '--chain', chain, '--address', address, '--resolution', resolution, '--from', String(start), '--to', String(end), '--raw'];
      const bindWindow=at=>{
        requestedAt=at;
        if(latestClosed){requestEnd=Math.floor(at/60000)*60;requestStart=requestEnd-duration;
          args[args.indexOf('--from')+1]=String(requestStart);args[args.indexOf('--to')+1]=String(requestEnd);}
      };
      bindWindow(queuedAt);
      const stdout = await run(args,
        { priority: ['exit','entry_confirmation'].includes(purpose) ? 2 : purpose === 'candidate' ? 1 : 0, onRequestStart:bindWindow,
          ...(latestClosed?{latestClosedDuration:duration}:{}) });
      const payload = parseJson(stdout);
      assertEnvelope(payload, chain, address);
      const candles = candleItems(payload).map(item => { assertIdentity(item, chain, address);const candle=normalizeCandle(item);
        if(!candle)throw new TypeError('invalid candle');return candle; });
      if (!candles.length) return unavailable({ chain, address, resolution });
      return { status: 'ok', source: 'gmgn-cli', chain, address, resolution, from: requestStart, to: requestEnd,
        ...(latestClosed?{requestWindow:'latest_closed_at_dispatch'}:{}),queuedAt:new Date(queuedAt).toISOString(),
        requestedAt:new Date(requestedAt).toISOString(),receivedAt:new Date(now()).toISOString(),observedAt: new Date(now()).toISOString(), candles };
    });
    if (result?.status === 'ok') return result;
    const lastSuccess = cache.get(key)?.lastSuccess;
    return lastSuccess
      ? { ...lastSuccess, status: 'stale', stale: true, staleReason: 'gmgn_unavailable', reasonCode:cache.get(key)?.failureCode||'GMGN_UNAVAILABLE',staleAt: new Date(now()).toISOString() }
      : unavailable({ chain, address, resolution,reasonCode:cache.get(key)?.failureCode||'GMGN_UNAVAILABLE' });
  }

  async function trenches({ chain, limit = 20, purpose = 'research', types = Object.keys(TRENCHES_CATEGORIES) } = {}) {
    assertChain(chain);
    if(!Array.isArray(types)||!types.length||new Set(types).size!==types.length||types.some(t=>!Object.hasOwn(TRENCHES_CATEGORIES,t)))throw new TypeError('invalid trenches categories');
    const selected=Object.keys(TRENCHES_CATEGORIES).filter(t=>types.includes(t));
    const requestedLimit = Math.min(80, Math.max(1, Math.trunc(Number(limit) || 20)));
    const key = `trenches:${chain}:${requestedLimit}:${selected.join(',')}`;
    const result = await cached(key, async () => {
      const queuedAt = now(); let requestedAt = queuedAt;
      const stdout = await run(['market', 'trenches', '--chain', chain, ...selected.flatMap(type=>['--type',type]), '--limit', String(requestedLimit), '--raw'],
        { priority: purpose === 'scan' ? 1 : 0, onRequestStart: at => { requestedAt = at; } });
      const payload = parseJson(stdout);
      assertEnvelope(payload, chain);
      const data = payload.data ?? payload;
      // The installed CLI normalizes upstream data.pump to near_completion.
      // Accept the observed CLI form and documented API form, never silently
      // prefer one when both are present with conflicting contents.
      if (selected.includes('near_completion') && data.pump != null && data.near_completion != null && JSON.stringify(data.pump) !== JSON.stringify(data.near_completion)) throw new TypeError('conflicting trenches categories');
      const categoryData = { ...data, pump: data.pump ?? data.near_completion };
      if (!selected.every(type => Array.isArray(categoryData[TRENCHES_CATEGORIES[type]]))) throw new TypeError('invalid trenches categories');
      const observedAt = new Date(requestedAt).toISOString();
      const categories = {};
      const byAddress = new Map();
      for (const category of selected) {
        const field=TRENCHES_CATEGORIES[category];
        categories[category] = categoryData[field].slice(0, requestedLimit).map(item => {
          const token = normalizeToken(item, chain, category);
          if (!token) throw new TypeError('invalid trenches token');
          token.stageObservedAt = observedAt;
          const key = addressKey(chain, token.address);
          const siblings = byAddress.get(key) || [];
          siblings.push(token);
          byAddress.set(key, siblings);
          return token;
        });
      }
      // A token duplicated across internal/external categories has ambiguous stage.
      const tokens = [...byAddress.values()].map(siblings => {
        if (siblings.some(token => token.stageConflict) || new Set(siblings.map(token => token.marketStage)).size > 1) {
          siblings.forEach(token => Object.assign(token, { marketStage: 'unknown', stageConflict: true, stageSource: 'conflicting_fields' }));
        }
        return siblings.at(-1);
      });
      return { status: 'ok', source: 'gmgn-cli', chain, observedAt, tokens, categories,
        queuedAt: new Date(queuedAt).toISOString(), receivedAt: new Date(now()).toISOString(), timestampKind: 'local_request' };
    });
    if (result?.status === 'ok') return result;
    const lastSuccess = cache.get(key)?.lastSuccess;
    const reasonCode=cache.get(key)?.failureCode||'GMGN_UNAVAILABLE';
    return lastSuccess
      ? { ...lastSuccess, status: 'stale', stale: true, staleReason: 'gmgn_unavailable', reasonCode, staleAt: new Date(now()).toISOString() }
      : unavailable({ chain,reasonCode });
  }

  return { trending, kline, trenches, quote, details, clearCache: () => cache.clear(),close:()=>run.close?.(),
    diagnostics:()=>({...(run.diagnostics?.()||{...readonlyQueueSnapshot(scheduler,now()),recent:structuredClone(scheduler.requestHistory||[])}),
      scope:'loaded_process',note:'当前客户端最近最多 64 次传输任务；隔离模式的请求时钟来自只读子进程。active 包括等待共享名额，非网络并发；共享账户限频不变，传输成功不等于入场通过'}) };
}

export const readonlyMarket = createReadonlyMarketClient({ ttlMs: 10_000, trendingTtlMs: 1000, quoteTtlMs: 1000, isolated:true });
