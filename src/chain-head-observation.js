import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export const CHAIN_HEAD_OBSERVATION_VERSION = "chain_head_observation_v1";
const MIN_INTERVAL_MS = 60_000;
const MAX_SIDECAR_BYTES = 64 * 1024;
const HASH = /^0x[\da-f]{64}$/;
const SOURCE_HASH = /^[\da-f]{64}$/;
const iso = (value) => new Date(value).toISOString();
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const time = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));
const failure = (code) => Object.assign(new Error(code), { code });

function fixedSources(providers) {
  if (!Array.isArray(providers) || providers.length !== 2) throw failure("CHAIN_HEAD_SOURCES_INVALID");
  const sources = providers.map(({ sourceId, provider } = {}) => {
    let parsed;
    try { parsed = new URL(String(sourceId).includes("://") ? sourceId : `https://${sourceId}`); }
    catch { throw failure("CHAIN_HEAD_SOURCES_INVALID"); }
    if (!["https:", "http:"].includes(parsed.protocol) || !parsed.hostname
      || parsed.username || parsed.password || parsed.search || parsed.hash
      || !["", "/"].includes(parsed.pathname)
      || !provider || typeof provider.getBlockNumber !== "function" || typeof provider.getBlock !== "function"
      || (typeof provider.send !== "function" && typeof provider.getNetwork !== "function")) {
      throw failure("CHAIN_HEAD_SOURCES_INVALID");
    }
    const host = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
    return { host, provider, id: createHash("sha256").update(host).digest("hex") };
  });
  if (sources[0].host === sources[1].host || sources[0].provider === sources[1].provider) {
    throw failure("CHAIN_HEAD_SOURCES_NOT_INDEPENDENT");
  }
  return sources;
}

function chainId(value) {
  try {
    if (!(["number", "bigint"].includes(typeof value)
      || typeof value === "string" && /^(?:0x[\da-f]+|[\d]+)$/iu.test(value))) throw new Error();
    if (BigInt(value) !== 56n) throw new Error();
  } catch { throw failure("CHAIN_HEAD_CHAIN_MISMATCH"); }
}

function validProof(proof, confirmations, sourceIds) {
  return proof && typeof proof === "object" && !Array.isArray(proof)
    && time(proof.startedAt) && time(proof.verifiedAt)
    && Date.parse(proof.startedAt) <= Date.parse(proof.verifiedAt)
    && integer(proof.headNumber) && HASH.test(proof.headHash)
    && integer(proof.blockTimestamp) && proof.blockTimestamp > 0
    && proof.blockTimestamp * 1_000 <= Date.parse(proof.verifiedAt) + 30_000
    && Array.isArray(proof.sourceIds) && proof.sourceIds.length === 2
    && proof.sourceIds.every((id, index) => SOURCE_HASH.test(id) && id === sourceIds[index])
    && new Set(proof.sourceIds).size === 2
    && Array.isArray(proof.sourceTips) && proof.sourceTips.length === 2 && proof.sourceTips.every(integer)
    && Math.min(...proof.sourceTips) === proof.headNumber
    && proof.headSpread === Math.max(...proof.sourceTips) - proof.headNumber
    && proof.confirmations === confirmations && integer(proof.safeHead)
    && proof.safeHead === proof.headNumber - confirmations;
}

function errorDetails(error) {
  const queue = [error], seen = new Set();
  let code = "CHAIN_HEAD_RPC_FAILED", retryAfterMs = 0;
  while (queue.length && seen.size < 16) {
    const item = queue.shift();
    if (!item || typeof item !== "object" || seen.has(item)) continue;
    seen.add(item);
    if (/^CHAIN_HEAD_[A-Z_]+$/.test(item.code || "") && code === "CHAIN_HEAD_RPC_FAILED") code = item.code;
    if (item.rpcFailureScope === "capacity" && code === "CHAIN_HEAD_RPC_FAILED") code = "CHAIN_HEAD_RPC_CAPACITY";
    if (Number(item.status) === 429 || Number(item.code) === 429 || /\b429\b|rate.?limit|too many requests/iu.test(item.message || "")) {
      code = "CHAIN_HEAD_RPC_RATE_LIMITED";
    }
    for (const delay of [item.retryAfterMs, item.rpcHostRetryAfterMs]) {
      if (Number.isFinite(Number(delay)) && Number(delay) > 0) retryAfterMs = Math.max(retryAfterMs, Number(delay));
    }
    queue.push(item.cause, item.error, item.info?.error, ...(Array.isArray(item.errors) ? item.errors : []));
  }
  return { code, retryAfterMs };
}

async function settledReads(reads) {
  // Drain every launched request even if its peer fails. Never start a second
  // proof phase, retry, or release an underlying transport lease prematurely.
  const results = await Promise.allSettled(reads.map((read) => Promise.resolve().then(read)));
  const failures = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (failures.length) {
    const aggregate = new AggregateError(failures, "chain head proof unavailable");
    const details = failures.map(errorDetails);
    aggregate.code = details.find((item) => item.code === "CHAIN_HEAD_RPC_RATE_LIMITED")?.code
      || details.find((item) => item.code === "CHAIN_HEAD_RPC_CAPACITY")?.code || details[0].code;
    aggregate.retryAfterMs = Math.max(...details.map((item) => item.retryAfterMs));
    throw aggregate;
  }
  return results.map((result) => result.value);
}

async function atomicWrite(file, value, fsImpl) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    await fsImpl.rename(temporary, file);
  } finally {
    await fsImpl.unlink(temporary).catch(() => {});
  }
}

async function readPriorSnapshot(file, fsImpl) {
  let handle;
  try {
    // Pin one bounded regular-file version, including across atomic rename.
    // O_NONBLOCK prevents a damaged FIFO sidecar from blocking the collector.
    handle = await fsImpl.open(file, constants.O_RDONLY | constants.O_NONBLOCK);
    const before = await handle.stat();
    if (!before.isFile() || !integer(before.size) || before.size > MAX_SIDECAR_BYTES) {
      throw failure("CHAIN_HEAD_SIDECAR_INVALID");
    }
    const buffer = Buffer.alloc(before.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    const replaced = before.nlink > 0 && after.nlink === 0;
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs
      || (!replaced && after.ctimeMs !== before.ctimeMs)) throw failure("CHAIN_HEAD_SIDECAR_CHANGED");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally {
    await handle?.close();
  }
}

/** Display-only observer; owned by an existing producer, with no timer, new
 * provider, fallback origin, retries, or authority over trading state. */
export function createChainHeadObserver({ file, producer, providers, confirmations, now = Date.now,
  intervalMs = MIN_INTERVAL_MS, fsImpl = fs, getCursor, isStopped = () => false, writeSnapshot } = {}) {
  let sources, configurationError;
  try {
    if (typeof file !== "string" || !file || typeof producer !== "string" || !producer
      || !integer(confirmations) || !integer(intervalMs)) throw failure("CHAIN_HEAD_CONFIGURATION_INVALID");
    sources = fixedSources(providers);
  } catch (error) { configurationError = error; }
  const spacing = Math.max(MIN_INTERVAL_MS, Number(intervalMs) || MIN_INTERVAL_MS);
  let active = null, loaded = false, closed = false, lastSuccess = null, lastResult = null, nextAttemptMs = 0;
  const assertRunning = () => { if (closed || isStopped()) throw failure("CHAIN_HEAD_STOPPED"); };

  async function observeOnce() {
    const startedMs = Number(now()), startedAt = iso(startedMs);
    nextAttemptMs = startedMs + spacing;
    if (!loaded && !configurationError) {
      loaded = true;
      try {
        const existing = await readPriorSnapshot(file, fsImpl);
        if (existing.version === CHAIN_HEAD_OBSERVATION_VERSION && existing.displayOnly === true
          && existing.producer === producer && existing.chainId === 56
          && validProof(existing.lastSuccess, confirmations, sources.map((source) => source.id))) {
          lastSuccess = existing.lastSuccess;
        }
      } catch { /* A missing/malformed telemetry sidecar conveys no proof. */ }
    }
    let errorCode = null;
    try {
      if (configurationError) throw configurationError;
      assertRunning();
      const observations = await settledReads(sources.map(({ provider }) => async () => {
        assertRunning();
        const [network, tip] = await settledReads([
          () => { assertRunning(); return typeof provider.send === "function" ? provider.send("eth_chainId", []) : Promise.resolve(provider.getNetwork()).then((value) => value?.chainId); },
          () => { assertRunning(); return provider.getBlockNumber(); },
        ]);
        chainId(network);
        if (!integer(tip) || tip < confirmations) throw failure("CHAIN_HEAD_NUMBER_INVALID");
        return tip;
      }));
      assertRunning();
      const headNumber = Math.min(...observations);
      const blocks = await settledReads(sources.map(({ provider }) => () => { assertRunning(); return provider.getBlock(headNumber); }));
      assertRunning();
      for (const block of blocks) {
        if (!block || block.number !== headNumber || typeof block.hash !== "string" || !HASH.test(block.hash.toLowerCase())
          || !integer(block.timestamp) || block.timestamp <= 0 || block.timestamp * 1_000 > Number(now()) + 30_000) {
          throw failure("CHAIN_HEAD_BLOCK_INVALID");
        }
      }
      if (blocks[0].hash.toLowerCase() !== blocks[1].hash.toLowerCase()
        || blocks[0].timestamp !== blocks[1].timestamp) throw failure("CHAIN_HEAD_CONSENSUS_MISMATCH");
      const verifiedAt = iso(Number(now()));
      if (Date.parse(verifiedAt) < startedMs) throw failure("CHAIN_HEAD_CLOCK_INVALID");
      let cursor;
      if (getCursor !== undefined) {
        cursor = structuredClone(getCursor());
        if (!cursor || !integer(cursor.nextBlock) || !integer(cursor.anchorBlock)
          || typeof cursor.anchorBlockHash !== "string" || !HASH.test(cursor.anchorBlockHash.toLowerCase())
          || (cursor.afterLogIndex !== undefined && (!Number.isSafeInteger(cursor.afterLogIndex) || cursor.afterLogIndex < -1))
          || ((cursor.afterLogIndex ?? -1) === -1 ? cursor.nextBlock !== cursor.anchorBlock + 1 : cursor.nextBlock !== cursor.anchorBlock)) {
          throw failure("CHAIN_HEAD_CURSOR_INVALID");
        }
        cursor = { nextBlock: cursor.nextBlock, anchorBlock: cursor.anchorBlock,
          anchorBlockHash: cursor.anchorBlockHash.toLowerCase(),
          ...(cursor.afterLogIndex === undefined ? {} : { afterLogIndex: cursor.afterLogIndex }) };
      }
      lastSuccess = { startedAt, verifiedAt, headNumber, headHash: blocks[0].hash.toLowerCase(),
        blockTimestamp: blocks[0].timestamp, sourceIds: sources.map((source) => source.id), sourceTips: observations,
        headSpread: Math.max(...observations) - headNumber, confirmations, safeHead: headNumber - confirmations,
        ...(cursor ? { cursor, cursorObservedAt: iso(Number(now())) } : {}) };
    } catch (error) {
      const details = errorDetails(error);
      errorCode = details.code;
      nextAttemptMs = Math.max(nextAttemptMs, Number(now()) + details.retryAfterMs);
    }
    const snapshot = { version: CHAIN_HEAD_OBSERVATION_VERSION, displayOnly: true, producer, chainId: 56,
      status: errorCode ? "error" : "verified", attemptedAt: startedAt, completedAt: iso(Number(now())),
      errorCode, lastSuccess };
    try {
      if (typeof file !== "string" || !file) throw new Error();
      if (writeSnapshot) await writeSnapshot(file, structuredClone(snapshot));
      else await atomicWrite(file, snapshot, fsImpl);
      lastResult = snapshot;
    } catch {
      lastResult = { ...snapshot, persistenceErrorCode: "CHAIN_HEAD_WRITE_FAILED" };
    }
    return structuredClone(lastResult);
  }

  function observe() {
    if (active) return active;
    if (Number(now()) < nextAttemptMs) return Promise.resolve(structuredClone(lastResult));
    active = observeOnce().catch(() => ({ version: CHAIN_HEAD_OBSERVATION_VERSION, displayOnly: true,
      producer, chainId: 56, status: "error", errorCode: "CHAIN_HEAD_OBSERVER_FAILED", lastSuccess }))
      .finally(() => { active = null; });
    return active;
  }
  return { observe, close: async () => { closed = true; if (active) await active; } };
}
