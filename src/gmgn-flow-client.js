import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";

export const GMGN_FLOW_FULL_CHAINS = Object.freeze(["sol", "bsc", "base", "eth", "robinhood"]);
export const GMGN_FLOW_HOT_SEARCH_CHAINS = Object.freeze(["sol", "bsc", "base", "eth", "monad", "megaeth", "hyperevm", "tron"]);
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// All client instances in this process share one queue, including different chains.
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
  const rateFile = path.join(dataDir, "gmgn-flow-rate-limit.json");
  const legacyFile = path.join(dataDir, "fomo-call-state.json");
  const interval = boundedNumber(config.gmgnFlowRequestIntervalMs ?? config.requestIntervalMs, 3000, 3000, 60_000);
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

  function enqueue(args, configuration = false) {
    if (stopped) return Promise.reject(stoppedError());
    const controller = new AbortController();
    const job = { controller, promise: null, execution: null, started: false };
    jobs.add(job);
    const work = async () => {
      job.started = true;
      const signal = controller.signal;
      await checkCooldown(signal);
      const remaining = scheduler.lastStartedAt === null ? 0 : Number(scheduler.lastStartedAt) + interval - Number(now());
      if (remaining > 0) await pause(remaining, signal);
      await checkCooldown(signal);
      scheduler.lastStartedAt = Number(now());
      try {
        const result = await runChild(args, signal);
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
        if (retry) { await persistCooldown(retry); throw limitedError(retry); }
        if (String(error?.code || "").startsWith("GMGN_")) throw error;
        // Never expose stdout, stderr, command strings, credentials, or provider errors.
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw failure("GMGN_RESPONSE_TOO_LARGE", "GMGN CLI output exceeds 4 MiB");
        if (error?.killed || error?.code === "ETIMEDOUT") throw failure("GMGN_CLI_TIMEOUT", "GMGN CLI request timed out");
        throw failure(configuration ? "GMGN_CONFIG_FAILED" : "GMGN_CLI_FAILED", configuration ? "GMGN CLI configuration check failed" : "GMGN CLI request failed");
      }
    };
    const execution = scheduler.tail.catch(() => {}).then(work);
    job.execution = execution;
    scheduler.tail = execution.catch(() => {});
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

  async function request(args) { await checkConfig(); return enqueue([...args, "--raw"]); }

  return {
    checkConfig,
    trending(chain) {
      return request(["market", "trending", "--chain", chainValue(chain), "--interval", "5m", "--order-by", "volume", "--limit", "50"]);
    },
    trades(chain, kind) {
      if (!["smartmoney", "kol"].includes(kind)) throw failure("GMGN_INVALID_ARGUMENT", "Unsupported GMGN trade kind");
      return request(["track", kind, "--chain", chainValue(chain), "--limit", "200"]);
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
      await Promise.allSettled(pending.filter((job) => job.started).map((job) => job.execution));
    },
  };
}
