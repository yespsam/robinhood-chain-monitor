import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { BINANCE_FLOW_CHAINS, BINANCE_FLOW_KINDS, BINANCE_FLOW_SCHEMA, advanceBinanceFlowFeed, validBinanceFlowState } from './binance-flow-evidence.js';
import { tradingScanChains, tradingFlowChains } from './trading-scan-scope.js';

// Public market-data query only. No wallet/session, signing, swap or broadcast
// endpoints are reachable through this client; do not reuse Square credentials.
const URL = 'https://www.binance.com/bapi/defi/v1/public/wallet-direct/tracker/wallet/address/query';
const failure = (code, extra = {}) => Object.assign(new Error(code), { code, ...extra });
const MAX_BYTES = 4 * 1024 * 1024;
export const BINANCE_FOCUS_ROTATION=Object.freeze(['bsc','sol','robinhood','bsc','sol','base','bsc','sol','eth']);
export function selectBinanceFlowSlot(state,nowMs,allowedChains=Object.keys(BINANCE_FLOW_CHAINS)) {
  const start=state.focusChainIndex??0;
  for(let offset=0;offset<BINANCE_FOCUS_ROTATION.length;offset++){
    const index=(start+offset)%BINANCE_FOCUS_ROTATION.length,chain=BINANCE_FOCUS_ROTATION[index];
    if(allowedChains.includes(chain)&&BINANCE_FLOW_KINDS.some(kind=>!(state.chains?.[chain]?.feeds?.[kind]?.nextAttemptAt>nowMs)))
      return {chain,nextIndex:(index+1)%BINANCE_FOCUS_ROTATION.length};
  }
  return null;
}
export function createBinanceFlowClient({ fetchImpl = fetch, now = Date.now } = {}) {
  let lastAt = 0, tail = Promise.resolve(), cooldownUntil = 0, stopped = false;
  const controller = new AbortController();
  return {
    trades(chain, kind, {onRequestStart}={}) {
      if (!Object.hasOwn(BINANCE_FLOW_CHAINS, chain) || !BINANCE_FLOW_KINDS.includes(kind)
        ||onRequestStart!==undefined&&typeof onRequestStart!=='function') return Promise.reject(failure('binance_invalid_argument'));
      const work = async () => {
        if (stopped) throw failure('binance_stopped');
        if (cooldownUntil > now()) throw failure('binance_rate_limited', { retryAt: cooldownUntil });
        const delay = lastAt + 1000 - now();
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        if (stopped) throw failure('binance_stopped');
        lastAt = now();
        try {
          onRequestStart?.(lastAt);
          const response = await fetchImpl(URL, { method: 'POST', redirect: 'error', credentials: 'omit',
            headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity', 'User-Agent': 'yesp-atm-readonly/1.0' },
            body: JSON.stringify({ chainId: BINANCE_FLOW_CHAINS[chain], tagType: kind === 'smartmoney' ? 2 : 1, enableFilterRiskTokens: false }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) });
          if (!response.ok) {
            await response.body?.cancel();
            if ([429, 403, 418].includes(response.status)) {
              const retry = response.headers.get('retry-after'), seconds = Number(retry);
              const requested = retry && Number.isFinite(seconds) ? now() + seconds * 1000 : Date.parse(retry || '');
              cooldownUntil = Math.max(now() + (response.status === 429 ? 60_000 : 900_000), Number.isFinite(requested) ? requested : 0);
              throw failure(response.status === 429 ? 'binance_rate_limited' : 'binance_access_unavailable', { retryAt: cooldownUntil });
            }
            throw failure('binance_http_failed');
          }
          const reader = response.body.getReader(); let size = 0; const chunks = [];
          try {
            for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength;
              if (size > MAX_BYTES) throw failure('binance_response_too_large'); chunks.push(value); }
          } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
          let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw failure('binance_response_invalid'); }
          if (payload?.code !== '000000' || payload.success === false || !Array.isArray(payload.data)) throw failure('binance_response_invalid');
          return payload;
        } catch (error) {
          if (error.code?.startsWith('binance_')) throw error;
          throw failure(stopped ? 'binance_stopped' : 'binance_fetch_failed');
        }
      };
      const result = tail.then(work); tail = result.catch(() => {}); return result;
    },
    async stop() { stopped = true; controller.abort(); await tail; },
  };
}

export function createBinanceFlowMonitor(config = {}, { client = createBinanceFlowClient(), now = Date.now, autoStart = true, logger = console } = {}) {
  const dataDir = path.resolve(config.dataDir || 'data'), file = path.join(dataDir, 'binance-flow-state.json'), lock = `${file}.lock`;
  const chains = Object.keys(BINANCE_FLOW_CHAINS), owner = randomUUID();
  const scanChains=tradingScanChains(dataDir,chains),activeChains=tradingFlowChains(dataDir,scanChains);
  const focusScheduling=config.binanceFlowFocusSchedulingEnabled===true;
  let state, active, stopped = false, held = false, loadPromise, writeFault = false, focusNext = true;
  async function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      await fs.mkdir(dataDir, { recursive: true });
      try { await fs.writeFile(lock, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // Recovery itself is serialized. Corrupt/unknown owners fail closed.
        const guard = await fs.open(`${lock}.reclaim`, 'wx', 0o600);
        try {
          const prior = JSON.parse(await fs.readFile(lock, 'utf8'));
          if (!Number.isSafeInteger(prior.pid) || prior.pid <= 0 || typeof prior.owner !== 'string') throw failure('binance_state_lock_invalid');
          try { process.kill(prior.pid, 0); throw failure('binance_already_running'); } catch (probe) { if (probe.code !== 'ESRCH') throw probe; }
          await fs.unlink(lock); await fs.writeFile(lock, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 });
        } finally { await guard.close(); await fs.unlink(`${lock}.reclaim`); }
      }
      held = true;
      try {
        const stat = await fs.stat(file); if (!stat.isFile() || stat.size > 24 * 1024 * 1024) throw failure('binance_state_invalid');
        state = JSON.parse(await fs.readFile(file, 'utf8'));
        if (!validBinanceFlowState(state)) throw failure('binance_state_invalid');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        state = { schema: BINANCE_FLOW_SCHEMA, mode: 'readonly', updatedAt: now(), nextChainIndex: 0, cooldownUntil: 0,
          chains: Object.fromEntries(chains.map(chain => [chain, { feeds: {} }])) };
      }
      for (const chain of chains) {
        state.chains[chain] ||= { feeds: {} };
        for (const feed of Object.values(state.chains[chain].feeds)) { feed.coverage = null; feed.status = 'warming'; }
      }
      await persist();
    })();
    return loadPromise;
  }
  async function persist() {
    if (writeFault) throw failure('binance_state_write_failed');
    state.scanScope={scanChains,flowChains:activeChains,retainedExitChains:activeChains.filter(c=>!scanChains.includes(c))};
    state.updatedAt = now(); const text = JSON.stringify(state);
    if (Buffer.byteLength(text) > 24 * 1024 * 1024 || !validBinanceFlowState(state)) throw failure('binance_state_invalid');
    const temporary = `${file}.${owner}.tmp`; let handle;
    try { handle = await fs.open(temporary, 'w', 0o600); await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null; await fs.rename(temporary, file); }
    catch { writeFault = true; throw failure('binance_state_write_failed'); }
    finally { await handle?.close(); await fs.unlink(temporary).catch(() => {}); }
  }
  async function run() {
    await load(); if (stopped || writeFault) return;
    if (state.cooldownUntil > now()) return;
    // Same two queries per 2.5s slot, but BSC/SOL get 3/9 slots each rather
    // than 1/8. Robinhood/Base/ETH retain a slot each; cooldowns never consume
    // a business request or become false successful observations.
    let chain;
    if(focusScheduling||activeChains.length!==chains.length){
      const slot=selectBinanceFlowSlot(state,now(),activeChains);if(!slot)return;
      chain=slot.chain;state.focusChainIndex=slot.nextIndex;
      state.scheduling={version:activeChains.length===chains.length?'bsc_sol_weighted_v1':'scoped_flow_v1',intervalMs:2500,activeChain:chain,rotation:BINANCE_FOCUS_ROTATION.filter(c=>activeChains.includes(c))};
    }else{
      let index = Number.isSafeInteger(state.nextChainIndex) ? state.nextChainIndex % chains.length : 1;
      if (index === 0) index = 1;
      chain = focusNext ? 'robinhood' : chains[index];
      if (!focusNext) state.nextChainIndex = index === chains.length - 1 ? 1 : index + 1;
      focusNext = !focusNext;
    }
    for (const kind of BINANCE_FLOW_KINDS) {
      if (stopped) break;
      const prior = state.chains[chain].feeds[kind];
      if (prior?.nextAttemptAt > now()) continue;
      const requestedAt = now();
      let dispatchedAt=null;
      try {
        const payload = await client.trades(chain, kind,{onRequestStart:at=>{dispatchedAt=at;}}); if (stopped) break;
        const receivedAt=now();
        state.chains[chain].feeds[kind] = {...advanceBinanceFlowFeed(prior, payload, chain, kind, dispatchedAt??requestedAt, receivedAt),
          timing:{requestedAt,dispatchedAt,receivedAt,queueWaitMs:dispatchedAt===null?null:Math.max(0,dispatchedAt-requestedAt),
            responseMs:dispatchedAt===null?null:Math.max(0,receivedAt-dispatchedAt)}};
      } catch (error) {
        if (stopped) break;
        const code = /^binance_[a-z_]+$/.test(error.code || error.message || '') ? error.code || error.message : 'binance_fetch_failed';
        // Backoff is never fresh/complete. Preserve the previous page solely so
        // a successful overlapping page within MAX_GAP can prove continuity;
        // long gaps/disjoint pages and process restarts still rebuild it.
        state.chains[chain].feeds[kind] = { ...prior, rows: prior?.rows || [], issues: prior?.issues || {}, coverage: prior?.coverage || null,
          status: 'backoff', checkedAt: now(), lastError: code, nextAttemptAt: error.retryAt || now() + 60_000 };
        if (error.retryAt) state.cooldownUntil = error.retryAt;
        logger.error?.(`[binance-flow][${chain}/${kind}] ${code}`);
      }
      await persist();
      if (state.cooldownUntil > now()) break;
    }
  }
  function check() {
    if (stopped) return Promise.resolve();
    if (!active) active = run().finally(() => { active = null; });
    return active;
  }
  const timer = autoStart ? setInterval(() => void check().catch(() => logger.error?.('[binance-flow] local state unavailable')), 2500) : null;
  timer?.unref(); if (autoStart) void check().catch(() => logger.error?.('[binance-flow] local state unavailable'));
  return { check, state: () => state && structuredClone(state), stateFile: file,
    async stop() { stopped = true; clearInterval(timer); await client.stop?.(); await active?.catch(() => {});
      if (held) { const prior = JSON.parse(await fs.readFile(lock, 'utf8')); if (prior.owner === owner) await fs.unlink(lock); held = false; } },
  };
}
