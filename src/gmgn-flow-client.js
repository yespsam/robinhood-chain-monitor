import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createGmgnAccountGate } from './gmgn-account-gate.js';
import { GMGN_READONLY_INTERVAL_MS } from './gmgn-readonly-pacing.js';
import {classifyGmgnReadError} from './gmgn-read-error.js';

export const GMGN_FLOW_FULL_CHAINS = Object.freeze(["sol", "bsc", "base", "eth", "robinhood"]);
export const GMGN_FLOW_HOT_SEARCH_CHAINS = Object.freeze(["sol", "bsc", "base", "eth", "monad", "megaeth", "hyperevm", "tron"]);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// Share actual dispatch spacing/cooldown. The account gate owns concurrency and
// priority; a process-wide response FIFO must not hide feed requests behind a
// slow profile read before they can even reach that gate.
const GLOBAL_SCHEDULER = { tail: Promise.resolve(), lastStartedAt: null, rateLimitedUntil: 0 };

function failure(code, message, details = {}) {
  return Object.assign(new Error(message), { code, ...details });
}

function timestamp(value) {
  if (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value || ""))) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? (n < 10_000_000_000 ? n * 1000 : n) : null;
  }
  const n = Date.parse(String(value || ""));
  return Number.isFinite(n) ? n : null;
}

export function parseGmgnFlowRateLimit(value, nowMs = Date.now()) {
  const text = typeof value === "string" ? value : [value?.message, value?.stderr, value?.stdout,
    value?.error, value?.code, value?.status, value?.reset_at && `reset_at=${value.reset_at}`].filter(Boolean).join(" ");
  if (!/(?:\b429\b|RATE_LIMIT_(?:EXCEEDED|BANNED)|rate[ -]limit\s+(?:resets?|exceeded|banned))/i.test(text)) return null;
  const candidates = [];
  for (const match of text.matchAll(/["']?reset_at["']?\s*[:=]\s*["']?([^,"'\s}]+)/gi)) {
    candidates.push(timestamp(match[1]));
  }
  // Date.parse is inconsistent for the CLI's space-separated GMT offset format.
  for (const match of text.matchAll(/resets? at\s+(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})\s+GMT([+-]\d{2}:?\d{2})/gi)) {
    candidates.push(Date.parse(`${match[1]}T${match[2]}${match[3]}`));
  }
  for (const match of text.matchAll(/resets? at\s+(\d{4}-\d{2}-\d{2}T[^\s,)]+)/gi)) candidates.push(timestamp(match[1]));
  const future = candidates.filter((n) => Number.isFinite(n) && n > nowMs);
  if (future.length) return Math.max(...future);
  const remaining = Number(text.match(/~?(\d+)s\s+remaining/i)?.[1]);
  return nowMs + (Number.isFinite(remaining) ? Math.max(60, remaining) * 1000 : 60_000);
}

function chainValue(value, allowed = GMGN_FLOW_FULL_CHAINS) {
  if (typeof value !== "string" || !allowed.includes(value)) throw failure("GMGN_INVALID_ARGUMENT", "Unsupported GMGN chain");
  return value;
}

function addressValue(chain, value) {
  const valid = typeof value === "string" && (chain === "sol"
    ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value)
    : /^0x[0-9a-fA-F]{40}$/.test(value));
  if (!valid) throw failure("GMGN_INVALID_ARGUMENT", "Invalid GMGN address for chain");
  return value;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(minimum, Math.min(maximum, Math.trunc(n))) : fallback;
}

export function createGmgnFlowClient(config = {}, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const execute = dependencies.execFileImpl || execFile;
  const now = dependencies.now || Date.now;
  const scheduler = dependencies.scheduler || GLOBAL_SCHEDULER;
  const cliPath = String(config.gmgnFlowCliPath || config.fomoCallGmgnCliPath || "gmgn-cli");
  const dataDir = path.resolve(config.dataDir || "data");
  const accountGate=dependencies.accountGate || (!dependencies.execFileImpl ? createGmgnAccountGate(dataDir) : null);
  const cooldownGate=!dependencies.execFileImpl ? createGmgnAccountGate(path.join(dataDir,'gmgn-cooldown-write'),{intervalMs:1}) : null;
  const rateFile = path.join(dataDir, "gmgn-flow-rate-limit.json");
  const legacyFile = path.join(dataDir, "fomo-call-state.json");
  const interval = boundedNumber(config.gmgnFlowRequestIntervalMs ?? config.requestIntervalMs, GMGN_READONLY_INTERVAL_MS, GMGN_READONLY_INTERVAL_MS, 60_000);
  const timeout = boundedNumber(config.gmgnFlowRequestTimeoutMs ?? config.requestTimeoutMs, 15_000, 100, 15_000);
  const jobs = new Set();
  let stopped = false;
  let configurationChecked = false;
  let configPromise = null;
  let writeFault = false;

  const stoppedError = () => failure("GMGN_STOPPED", "GMGN flow client is stopped");
  const assertActive = (signal) => { if (stopped || signal?.aborted) throw stoppedError(); };
  const limitedError = (until) => failure("GMGN_RATE_LIMITED", "GMGN account is cooling down", {
    retryAt: new Date(until).toISOString(), retryAfterMs: Math.max(0, until - Number(now())), status: 429,
  });

  async function readJson(file, maximumBytes) {
    try {
      const stat = await fsImpl.stat(file);
      if (!stat.isFile() || stat.size > maximumBytes) throw failure("GMGN_STATE_INVALID", "GMGN cooldown state is not a bounded regular file");
      const text = await fsImpl.readFile(file, "utf8");
      if (Buffer.byteLength(text) > maximumBytes) throw failure("GMGN_STATE_INVALID", "GMGN cooldown state exceeds its size limit");
      return JSON.parse(text);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error?.code === "GMGN_STATE_INVALID") throw error;
      throw failure("GMGN_STATE_INVALID", "Cannot read GMGN cooldown state");
    }
  }

  async function checkCooldown(signal) {
    assertActive(signal);
    if (writeFault) throw failure("GMGN_STATE_WRITE_FAILED", "GMGN cooldown persistence failed; requests remain stopped");
    const [own, legacy] = await Promise.all([readJson(rateFile, 16_384), readJson(legacyFile, 32 * 1024 * 1024)]);
    let ownUntil = 0;
    if (own !== null) {
      ownUntil = timestamp(own?.rateLimitedUntil);
      if (own?.version !== 1 || ownUntil === null) throw failure("GMGN_STATE_INVALID", "Invalid GMGN cooldown schema");
    }
    const legacyValue = legacy?.publicOnchain?.smartMoney?.rateLimitedUntil;
    const legacyUntil = legacyValue == null ? 0 : timestamp(legacyValue);
    if (legacyUntil === null) throw failure("GMGN_STATE_INVALID", "Invalid legacy GMGN cooldown timestamp");
    scheduler.rateLimitedUntil = Math.max(Number(scheduler.rateLimitedUntil) || 0, ownUntil, legacyUntil);
    assertActive(signal);
    if (scheduler.rateLimitedUntil > Number(now())) throw limitedError(scheduler.rateLimitedUntil);
  }

  async function persistCooldown(until) {
    scheduler.rateLimitedUntil = Math.max(Number(scheduler.rateLimitedUntil) || 0, until);
    const temporary = `${rateFile}.${process.pid}.${randomUUID()}.tmp`;
    let handle;
    try {
      const existing=await readJson(rateFile,16_384);
      if(existing!==null) {
        const previous=timestamp(existing.rateLimitedUntil);
        if(existing.version!==1||previous===null)throw failure('GMGN_STATE_INVALID','Invalid GMGN cooldown schema');
        scheduler.rateLimitedUntil=Math.max(scheduler.rateLimitedUntil,previous);
      }
      await fsImpl.mkdir(dataDir, { recursive: true, mode: 0o700 });
      handle = await fsImpl.open(temporary, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ version: 1, rateLimitedUntil: new Date(scheduler.rateLimitedUntil).toISOString(),
        checkedAt: new Date(Number(now())).toISOString(), reason: "gmgn_cli_rate_limit" })}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      await fsImpl.rename(temporary, rateFile);
      const directory = await fsImpl.open(dataDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } catch {
      writeFault = true;
      throw failure("GMGN_STATE_WRITE_FAILED", "Could not persist GMGN cooldown; requests remain stopped", {
        retryAt: new Date(scheduler.rateLimitedUntil).toISOString(),
      });
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fsImpl.unlink(temporary).catch(() => {});
    }
  }

  function pause(ms, signal) {
    assertActive(signal);
    return new Promise((resolve, reject) => {
      let timer;
      const finish = (error) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error); else resolve();
      };
      const abort = () => finish(stoppedError());
      signal.addEventListener("abort", abort, { once: true });
      if (dependencies.sleepImpl) Promise.resolve().then(() => dependencies.sleepImpl(ms, signal)).then(() => finish(), finish);
      else timer = setTimeout(finish, Math.min(60_000, ms));
    });
  }

  function runChild(args, signal) {
    return new Promise((resolve, reject) => {
      let child;
      let settled = false;
      let timer;
      const finish = (error, stdout, stderr) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) {
          if (typeof stdout === "string" || Buffer.isBuffer(stdout)) error.stdout = String(stdout);
          if (typeof stderr === "string" || Buffer.isBuffer(stderr)) error.stderr = String(stderr);
          reject(error);
        } else resolve({ stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      };
      const kill = () => { try { child?.kill?.("SIGKILL"); } catch {} };
      const abort = () => { kill(); finish(stoppedError()); };
      signal.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { kill(); finish(failure("GMGN_CLI_TIMEOUT", "GMGN CLI request timed out")); }, timeout);
      try {
        assertActive(signal);
        child = execute(cliPath, args, {
          encoding: "utf8", shell: false, timeout, maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true, signal, killSignal: "SIGKILL",
        }, finish);
        // Supports both Node's callback execFile and promisified/mock executors.
        if (child?.then) child.then((result) => finish(null, result?.stdout, result?.stderr), (error) => finish(error));
      } catch (error) { finish(error); }
    });
  }

  function enqueue(args, configuration = false, { priority = 0, onRequestStart } = {}) {
    if (stopped) return Promise.reject(stoppedError());
    const controller = new AbortController();
    const job = { controller, promise: null, execution: null, started: false, gated:!!accountGate&&!configuration };
    jobs.add(job);
    const work = async () => {
      job.started = true;
      const signal = controller.signal;
      try {
        // Only serialize admission to the child, not its network response.
        // Free remains serial in the shared gate; Plus retains its bounded
        // leases and reserved critical slot. Explicit slower pacing survives.
        const dispatch=(scheduler.dispatchTail||Promise.resolve()).catch(()=>{}).then(async()=>{
          await checkCooldown(signal);
          const remaining=scheduler.lastStartedAt===null?0:Number(scheduler.lastStartedAt)+interval-Number(now());
          if(remaining>0)await pause(remaining,signal);
          await checkCooldown(signal);
          scheduler.lastStartedAt=Number(now());
          onRequestStart?.(Number(now()));
          return {response:runChild(args,signal)};
        });
        scheduler.dispatchTail=dispatch.then(()=>{},()=>{});
        const result = await (await dispatch).response;
        assertActive(signal);
        if (Buffer.byteLength(result.stdout) > MAX_OUTPUT_BYTES || Buffer.byteLength(result.stderr) > MAX_OUTPUT_BYTES) {
          throw failure("GMGN_RESPONSE_TOO_LARGE", "GMGN CLI output exceeds 4 MiB");
        }
        const retry = parseGmgnFlowRateLimit(result.stderr, Number(now()));
        if (retry) throw Object.assign(limitedError(retry), { reset_at: retry });
        if (configuration) { configurationChecked = true; return { ok: true }; }
        let payload;
        try { payload = JSON.parse(result.stdout); } catch { throw failure("GMGN_INVALID_RESPONSE", "GMGN CLI did not return JSON"); }
        if (payload === null || typeof payload !== "object") throw failure("GMGN_INVALID_RESPONSE", "GMGN CLI returned a non-object response");
        if (payload.success === false || payload.error || (Number.isFinite(Number(payload.code)) && Number(payload.code) >= 400)) {
          const apiRetry = parseGmgnFlowRateLimit(payload, Number(now()));
          if (apiRetry) throw Object.assign(limitedError(apiRetry), { reset_at: apiRetry });
          throw failure("GMGN_API_FAILED", "GMGN API returned an error response");
        }
        return payload;
      } catch (error) {
        if (signal.aborted || stopped) throw stoppedError();
        const retry = parseGmgnFlowRateLimit(error, Number(now()));
        if (retry) {
          try { await (cooldownGate ? cooldownGate(()=>persistCooldown(retry)) : persistCooldown(retry)); }
          catch(error) { writeFault=true;throw error; }
          throw limitedError(scheduler.rateLimitedUntil);
        }
        if (String(error?.code || "").startsWith("GMGN_")) throw error;
        // Never expose stdout, stderr, command strings, credentials, or provider errors.
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw failure("GMGN_RESPONSE_TOO_LARGE", "GMGN CLI output exceeds 4 MiB");
        if (error?.killed || error?.code === "ETIMEDOUT") throw failure("GMGN_CLI_TIMEOUT", "GMGN CLI request timed out");
        const category=classifyGmgnReadError(error);
        if(category)throw failure(category,category);
        throw failure(configuration ? "GMGN_CONFIG_FAILED" : "GMGN_CLI_FAILED", configuration ? "GMGN CLI configuration check failed" : "GMGN CLI request failed");
      }
    };
    const execution = accountGate && !configuration ? accountGate(work,controller.signal,{priority})
      : scheduler.tail.catch(() => {}).then(work);
    job.execution = execution;
    // Legacy/no-gate callers still serialize complete responses. Gated calls
    // must not lengthen the fallback/configuration FIFO.
    if(!accountGate||configuration)scheduler.tail = execution.catch(() => {});
    job.promise = new Promise((resolve, reject) => {
      const abort = () => reject(stoppedError());
      controller.signal.addEventListener("abort", abort, { once: true });
      execution.then(resolve, reject).finally(() => controller.signal.removeEventListener("abort", abort));
    }).finally(() => jobs.delete(job));
    return job.promise;
  }

  function checkConfig() {
    if (stopped) return Promise.reject(stoppedError());
    if (configurationChecked) return Promise.resolve({ ok: true });
    if (!configPromise) configPromise = enqueue(["config", "--check"], true).finally(() => { configPromise = null; });
    return configPromise;
  }

  async function request(args, options) { await checkConfig(); return enqueue([...args, "--raw"], false, options); }

  return {
    checkConfig,
    platformCalls(chain) {
      // Platform-call metadata is a discovery hint, not a full X timeline.
      return request(["market", "signal", "--chain", chainValue(chain, ["sol", "bsc"]), "--signal-type", "13"]);
    },
    trending(chain) {
      return request(["market", "trending", "--chain", chainValue(chain), "--interval", "5m", "--order-by", "volume", "--limit", "50"]);
    },
    trades(chain, kind, { limit = 200, onRequestStart } = {}) {
      if (!["smartmoney", "kol"].includes(kind)) throw failure("GMGN_INVALID_ARGUMENT", "Unsupported GMGN trade kind");
      if (!Number.isSafeInteger(limit) || limit<1 || limit>200) throw failure('GMGN_INVALID_ARGUMENT','Invalid GMGN trade limit');
      if (onRequestStart !== undefined && typeof onRequestStart !== 'function') throw failure('GMGN_INVALID_ARGUMENT','Invalid request timing callback');
      // Feed continuity is time-sensitive; profile enrichment is background.
      // Priority 1 still yields to priority-2 exits and entry confirmations.
      return request(["track", kind, "--chain", chainValue(chain), "--limit", String(limit)], {priority:1,onRequestStart});
    },
    candles(chain, address, fromSec, toSec) {
      chainValue(chain); addressValue(chain, address);
      if (!Number.isSafeInteger(fromSec) || !Number.isSafeInteger(toSec) || fromSec < 0 || toSec <= fromSec) {
        throw failure("GMGN_INVALID_ARGUMENT", "Invalid GMGN candle time range");
      }
      return request(["market", "kline", "--chain", chain, "--address", address, "--resolution", "1m", "--from", String(fromSec), "--to", String(toSec)]);
    },
    stats(chain, walletOrArray, period) {
      chainValue(chain);
      const requested = Array.isArray(walletOrArray) ? walletOrArray : [walletOrArray];
      if (!requested.length || requested.length > 20) throw failure("GMGN_INVALID_ARGUMENT", "GMGN stats requires one to twenty wallet addresses");
      const wallets = [...new Map(requested.map((wallet) => {
        addressValue(chain, wallet);
        return [chain === "sol" ? wallet : wallet.toLowerCase(), wallet];
      })).values()];
      if (!["7d", "30d"].includes(period)) throw failure("GMGN_INVALID_ARGUMENT", "Invalid GMGN stats period");
      return request(["portfolio", "stats", "--chain", chain, "--wallet", ...wallets, "--period", period]);
    },
    info(chain, address) {
      chainValue(chain); addressValue(chain, address);
      return request(["token", "info", "--chain", chain, "--address", address]);
    },
    topTraders(chain, address, limit = 50) {
      chainValue(chain); addressValue(chain, address);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw failure('GMGN_INVALID_ARGUMENT', 'Invalid trader limit');
      return request(['token', 'traders', '--chain', chain, '--address', address, '--order-by', 'profit', '--direction', 'desc', '--limit', String(limit)]);
    },
    activity(chain, wallet, { cursor = null, limit = 100 } = {}) {
      chainValue(chain); addressValue(chain, wallet);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
        || cursor !== null && (typeof cursor !== 'string' || !cursor || cursor.length > 2048 || /[\x00-\x1f]/.test(cursor))) {
        throw failure('GMGN_INVALID_ARGUMENT', 'Invalid wallet activity pagination');
      }
      // Include transfers and liquidity actions: filtering only buys/sells can
      // make inventory and completed round trips look falsely attributable.
      return request(['portfolio', 'activity', '--chain', chain, '--wallet', wallet, '--limit', String(limit),
        ...(cursor === null ? [] : ['--cursor', cursor])]);
    },
    createdTokens(chain, wallet, options = {}) {
      chainValue(chain, ['sol', 'bsc', 'base', 'eth']); addressValue(chain, wallet);
      const allowed = { orderBy: ['market_cap', 'token_ath_mc'], direction: ['asc', 'desc'], migrateState: ['migrated', 'non_migrated'] };
      if (options === null || typeof options !== 'object' || Array.isArray(options)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(options))
        || Reflect.ownKeys(options).some(key => typeof key !== 'string' || !Object.hasOwn(allowed, key))) {
        throw failure('GMGN_INVALID_ARGUMENT', 'Invalid created-token options');
      }
      for (const [key, values] of Object.entries(allowed)) {
        if (options[key] !== undefined && !values.includes(options[key])) {
          throw failure('GMGN_INVALID_ARGUMENT', 'Invalid created-token option value');
        }
      }
      // Public creator history uses the same background queue and cooldown as
      // profiles. Never introduce a signing endpoint or elevated priority here.
      return request(['portfolio', 'created-tokens', '--chain', chain, '--wallet', wallet,
        ...(options.orderBy === undefined ? [] : ['--order-by', options.orderBy]),
        ...(options.direction === undefined ? [] : ['--direction', options.direction]),
        ...(options.migrateState === undefined ? [] : ['--migrate-state', options.migrateState])]);
    },
    hotSearches(chains) {
      if (!Array.isArray(chains) || !chains.length || chains.length > GMGN_FLOW_HOT_SEARCH_CHAINS.length) {
        throw failure("GMGN_INVALID_ARGUMENT", "GMGN hot-search chains must be a nonempty bounded list");
      }
      const selected = [...new Set(chains.map((chain) => chainValue(chain, GMGN_FLOW_HOT_SEARCH_CHAINS)))];
      return request(["market", "hot-searches", ...selected.flatMap((chain) => ["--chain", chain]), "--interval", "5m", "--limit", "50"]);
    },
    async stop() {
      stopped = true;
      const pending = [...jobs];
      for (const job of pending) job.controller.abort();
      await Promise.allSettled(pending.map((job) => job.promise));
      // Active work can be between its child callback and durable cooldown write.
      // Finish that write before shutdown; abandoned queued work starts no child.
      // Cancelled gate tickets/leases also have filesystem cleanup to drain.
      await Promise.allSettled(pending.filter((job) => job.started||job.gated).map((job) => job.execution));
    },
  };
}
