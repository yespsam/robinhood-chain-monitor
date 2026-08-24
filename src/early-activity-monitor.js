import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { Interface, formatUnits, id } from "ethers";
import { readTokenMetadata } from "./detector.js";
import { assessLocalTokenSecurity } from "./local-security.js";

const V3_SWAP = id("Swap(address,address,int256,int256,uint160,uint128,int24)");
const V2_SWAP = id("Swap(address,uint256,uint256,uint256,uint256,address)");
const swaps = new Interface([
  "event Swap(address indexed sender,address indexed recipient,int256 amount0,int256 amount1,uint160 sqrtPriceX96,uint128 liquidity,int24 tick)",
  "event Swap(address indexed sender,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out,address indexed to)",
]);

const ACTIVITY_STATE_VERSION = 3;
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SUPPORTED_ACTIVITY_POOL_KINDS = new Set(["uniswap-v2", "uniswap-v3"]);
const KNOWN_QUOTE_METADATA = {
  "0x0bd7d308f8e1639fab988df18a8011f41eacad73": { symbol: "WETH", name: "WETH", decimals: 18 },
  "0x5fc5360d0400a0fd4f2af552add042d716f1d168": { symbol: "USDG", name: "Global Dollar", decimals: 6 },
};

const lower = (value) => value?.toLowerCase();

// The rolling activity scanner understands pool-local V2/V3 Swap logs only.
// Uniswap V4 emits swaps from PoolManager and identifies a pool by poolId, so
// routing a V4 launch through this scanner would query a null/wrong address.
function isSupportedActivityPool(pool) {
  return Boolean(
    pool
    && SUPPORTED_ACTIVITY_POOL_KINDS.has(pool.kind)
    && EVM_ADDRESS.test(pool.pool || "")
    && EVM_ADDRESS.test(pool.token0 || "")
    && EVM_ADDRESS.test(pool.token1 || ""),
  );
}

async function atomicWriteJson(file, value) {
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function quoteAmount(entry, log) {
  try {
    const parsed = swaps.parseLog(log);
    const tokenIs0 = lower(entry.pool.token0) === lower(entry.token);
    if (log.topics[0] === V3_SWAP) return tokenIs0 ? parsed.args.amount1 : parsed.args.amount0;
    const incoming = tokenIs0 ? parsed.args.amount1In : parsed.args.amount0In;
    const outgoing = tokenIs0 ? parsed.args.amount1Out : parsed.args.amount0Out;
    return incoming > outgoing ? incoming : outgoing;
  } catch { return 0n; }
}

function swapDirection(entry, log) {
  try {
    const parsed = swaps.parseLog(log);
    const tokenIs0 = lower(entry.pool.token0) === lower(entry.token);
    if (log.topics[0] === V3_SWAP) {
      const tokenDelta = tokenIs0 ? parsed.args.amount0 : parsed.args.amount1;
      return tokenDelta > 0n ? "sell" : tokenDelta < 0n ? "buy" : null;
    }
    const tokenIn = tokenIs0 ? parsed.args.amount0In : parsed.args.amount1In;
    const tokenOut = tokenIs0 ? parsed.args.amount0Out : parsed.args.amount1Out;
    return tokenIn > tokenOut ? "sell" : tokenOut > tokenIn ? "buy" : null;
  } catch { return null; }
}

export function minimumVolume(entry) {
  const quote = lower(entry.quoteToken);
  if (quote === "0x0bd7d308f8e1639fab988df18a8011f41eacad73") return 0.2;
  if (quote === "0x5fc5360d0400a0fd4f2af552add042d716f1d168") return 200;
  return null;
}

export function anomalyStage(swapsInMinute, volumeInMinute, minimum) {
  if (swapsInMinute >= 200 && volumeInMinute >= minimum * 10) return 3;
  if (swapsInMinute >= 50 && volumeInMinute >= minimum * 3) return 2;
  if (swapsInMinute >= 10 && volumeInMinute >= minimum) return 1;
  return 0;
}

export function activityWindows(samples, now = Date.now()) {
  const aggregate = (items) => items.reduce((total, sample) => ({
    swaps: total.swaps + Number(sample.swaps || 0),
    volume: total.volume + Number(sample.volume || 0),
    buys: total.buys + Number(sample.buys || 0),
    sells: total.sells + Number(sample.sells || 0),
    unknownDirections: total.unknownDirections + Number(sample.unknownDirections || 0),
  }), { swaps: 0, volume: 0, buys: 0, sells: 0, unknownDirections: 0 });
  const age = (sample) => now - Number(sample.at || 0);
  const minute = aggregate(samples.filter((sample) => age(sample) >= 0 && age(sample) <= 60_000));
  const previousMinute = aggregate(samples.filter((sample) => age(sample) > 60_000 && age(sample) <= 120_000));
  const fiveMinutes = aggregate(samples.filter((sample) => age(sample) >= 0 && age(sample) <= 5 * 60_000));
  return {
    minute,
    previousMinute,
    fiveMinutes,
    volumeAcceleration: previousMinute.volume > 0 ? minute.volume / previousMinute.volume : null,
  };
}

export function activitySamplesFromLogs(entry, logs, blockTimestamps) {
  const buckets = new Map();
  for (const log of logs) {
    const at = Number(blockTimestamps.get(Number(log.blockNumber)));
    if (!Number.isFinite(at) || at <= 0) throw new Error(`missing block timestamp for ${log.blockNumber}`);
    const current = buckets.get(at) || { at, swaps: 0, rawVolume: 0n, buys: 0, sells: 0, unknownDirections: 0 };
    const rawAmount = quoteAmount(entry, log);
    current.swaps += 1;
    current.rawVolume += rawAmount < 0n ? -rawAmount : rawAmount;
    const direction = swapDirection(entry, log);
    if (direction === "buy") current.buys += 1;
    else if (direction === "sell") current.sells += 1;
    else current.unknownDirections += 1;
    buckets.set(at, current);
  }
  return [...buckets.values()]
    .sort((a, b) => a.at - b.at)
    .map(({ rawVolume, ...sample }) => ({ ...sample, volume: Number(formatUnits(rawVolume, entry.quoteDecimals)) }));
}

export function createEarlyActivityMonitor({ provider, config, onEvent, assessSecurity = assessLocalTokenSecurity }) {
  const stateFile = path.join(config.dataDir, "early-watchlist.json");
  const eventsFile = path.join(config.dataDir, "events.jsonl");
  let state = { activityStateVersion: ACTIVITY_STATE_VERSION, tokens: {}, _health: { status: "unknown", consecutiveFailures: 0 } };
  let running = false;
  let activeCheckPromise = null;
  const activeAdds = new Set();
  let initialized = false;
  let ready;
  let stopped = false;
  let stopPromise = null;
  let metadataCursor = 0;
  const blockTimestampCache = new Map();
  let writeQueue = Promise.resolve();

  const save = () => {
    const snapshot = structuredClone(state);
    const operation = writeQueue.catch(() => {}).then(() => atomicWriteJson(stateFile, snapshot));
    writeQueue = operation;
    return operation;
  };

  async function addLaunch(launch, persist = true) {
    const pool = launch?.pools?.find(isSupportedActivityPool);
    if (launch?.type !== "token_launch" || launch.factoryStatus !== "new_candidate" || !launch.tokens?.[0]?.token || !pool) return false;
    const token = launch.tokens[0];
    const key = lower(token.token);
    if (state.tokens[key]) return false;
    const quoteToken = lower(pool.token0) === key ? pool.token1 : pool.token0;
    const knownQuoteMetadata = KNOWN_QUOTE_METADATA[lower(quoteToken)] || null;
    const quoteMetadata = knownQuoteMetadata || await readTokenMetadata(provider, quoteToken, "latest").catch(() => null);
    const firstSeenAt = launch.timestamp || launch.observedAt || new Date().toISOString();
    state.tokens[key] = {
      token: token.token, name: token.metadata?.name, symbol: token.metadata?.symbol, launcher: launch.launcher,
      pool, quoteToken, quoteDecimals: quoteMetadata?.decimals ?? 18,
      quoteSymbol: quoteMetadata?.symbol || null,
      quoteName: quoteMetadata?.name || null,
      firstSeenBlock: launch.blockNumber, firstSeenAt,
      launchTransactionHash: launch.transactionHash || null,
      launchExplorerUrl: launch.explorerUrl || null,
      launchpad: launch.launchpad || null,
      mode: launch.mode ? { selector: launch.mode.selector || null, poolKinds: launch.mode.poolKinds || [] } : null,
      historicalSeed: Date.now() - Date.parse(firstSeenAt) > 2 * 60_000,
      lastScannedBlock: launch.blockNumber - 1, samples: [], alertStage: 0, lastAlertAt: 0,
      metadata: token.metadata || {}, nextMetadataAt: 0,
      securityDecision: launch.security?.decision || "unknown",
      security: launch.security || null,
      nextSecurityAt: 0,
    };
    if (persist) await save();
    return true;
  }

  async function runAdd(launch) {
    if (stopped) return false;
    if (!initialized) await ready;
    if (stopped) return false;
    if (!initialized) throw new Error("early activity monitor initialization did not complete");
    return addLaunch(launch);
  }

  function add(launch) {
    if (stopped) return Promise.resolve(false);
    const operation = runAdd(launch);
    activeAdds.add(operation);
    void operation.then(
      () => activeAdds.delete(operation),
      () => activeAdds.delete(operation),
    );
    return operation;
  }

  async function seed() {
    let recoveredMalformedState = false;
    let prunedUnsupportedPools = 0;
    try {
      const raw = await fs.readFile(stateFile, "utf8");
      let loaded;
      try {
        loaded = JSON.parse(raw);
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        recoveredMalformedState = true;
        const preserved = `${stateFile}.corrupt.${Date.now()}`;
        await fs.writeFile(preserved, raw, { flag: "wx" }).catch((preserveError) => {
          console.error(`[early-activity-recovery] could not preserve malformed state: ${preserveError.message}`);
        });
        console.error(`[early-activity-recovery] malformed state ignored; rebuilding the active 24h watchlist from events.jsonl: ${error.message}`);
        loaded = {};
      }
      const loadedVersion = Number(loaded.activityStateVersion || 0);
      state = { ...state, ...loaded, tokens: loaded.tokens || {} };
      // Version 2 already stores exact block-time samples. Version 3 only
      // narrows supported pool kinds, so its migration must preserve them.
      if (loadedVersion < 2) {
        for (const entry of Object.values(state.tokens)) entry.samples = [];
      }
      state.activityStateVersion = ACTIVITY_STATE_VERSION;
      for (const [key, entry] of Object.entries(state.tokens)) {
        if (!isSupportedActivityPool(entry?.pool)) {
          delete state.tokens[key];
          prunedUnsupportedPools += 1;
          continue;
        }
        entry.samples = Array.isArray(entry.samples) ? entry.samples : [];
        const known = KNOWN_QUOTE_METADATA[lower(entry.quoteToken)];
        if (known) {
          entry.quoteDecimals = known.decimals;
          entry.quoteSymbol ||= known.symbol;
          entry.quoteName ||= known.name;
        }
      }
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const initialTokenKeys = new Set(Object.keys(state.tokens));
    let recoveredLaunches = 0;
    let recoveredAlertSnapshots = 0;
    try {
      const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
      const input = createReadStream(eventsFile, { encoding: "utf8" });
      const lines = readline.createInterface({ input, crlfDelay: Infinity });
      for await (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.factoryStatus === "new_candidate"
            && Date.parse(event.timestamp || event.observedAt) >= cutoff
            && await addLaunch(event, false)) {
            recoveredLaunches += 1;
          } else if (event.type === "early_activity_alert" && event.entry?.token) {
            const key = lower(event.entry.token);
            const current = state.tokens[key];
            if (current && !initialTokenKeys.has(key) && Date.parse(event.entry.firstSeenAt) >= cutoff) {
              state.tokens[key] = {
                ...current,
                ...event.entry,
                samples: Array.isArray(event.entry.samples) ? event.entry.samples : current.samples,
              };
              recoveredAlertSnapshots += 1;
            }
          }
        } catch { /* Ignore a partial historical line. */ }
      }
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    for (const [key, entry] of Object.entries(state.tokens)) {
      if (!isSupportedActivityPool(entry?.pool)) {
        delete state.tokens[key];
        prunedUnsupportedPools += 1;
        continue;
      }
      entry.samples = Array.isArray(entry.samples) ? entry.samples : [];
      const known = KNOWN_QUOTE_METADATA[lower(entry.quoteToken)];
      if (known) {
        entry.quoteDecimals = known.decimals;
        entry.quoteSymbol ||= known.symbol;
        entry.quoteName ||= known.name;
      }
    }
    if (recoveredMalformedState || recoveredLaunches || recoveredAlertSnapshots || prunedUnsupportedPools) {
      state._recovery = {
        source: "events_jsonl_24h",
        reason: recoveredMalformedState
          ? "malformed_state"
          : prunedUnsupportedPools
            ? "unsupported_pool_migration"
            : "ledger_reconciliation",
        recoveredAt: new Date().toISOString(),
        watchedTokens: Object.keys(state.tokens).length,
        recoveredLaunches,
        recoveredAlertSnapshots,
        prunedUnsupportedPools,
      };
    }
    await save();
  }

  async function resolveBlockTimestamps(logs) {
    const blockNumbers = [...new Set(logs.map((log) => Number(log.blockNumber)))];
    const missing = blockNumbers.filter((blockNumber) => !blockTimestampCache.has(blockNumber));
    const blocks = await Promise.all(missing.map((blockNumber) => provider.getBlock(blockNumber)));
    for (let index = 0; index < missing.length; index += 1) {
      const timestamp = Number(blocks[index]?.timestamp) * 1_000;
      if (!Number.isFinite(timestamp) || timestamp <= 0) throw new Error(`block timestamp unavailable for ${missing[index]}`);
      blockTimestampCache.set(missing[index], timestamp);
    }
    const resolved = new Map(blockNumbers.map((blockNumber) => [blockNumber, blockTimestampCache.get(blockNumber)]));
    const cutoff = Date.now() - 15 * 60_000;
    for (const [blockNumber, timestamp] of blockTimestampCache) {
      if (timestamp < cutoff) blockTimestampCache.delete(blockNumber);
    }
    return resolved;
  }

  async function checkMetadata(entry) {
    if (Date.now() < entry.nextMetadataAt) return;
    entry.nextMetadataAt = Date.now() + 5 * 60_000;
    const [metadata, quoteMetadata] = await Promise.all([
      readTokenMetadata(provider, entry.token, "latest", true).catch(() => null),
      !entry.quoteSymbol && entry.quoteToken
        ? readTokenMetadata(provider, entry.quoteToken, "latest").catch(() => null)
        : Promise.resolve(null),
    ]);
    if (quoteMetadata) {
      entry.quoteDecimals = quoteMetadata.decimals ?? entry.quoteDecimals;
      entry.quoteSymbol = quoteMetadata.symbol || entry.quoteSymbol || null;
      entry.quoteName = quoteMetadata.name || entry.quoteName || null;
    }
    if (!metadata) return;
    const fields = ["website", "twitter", "telegram", "discord"];
    const additions = Object.fromEntries(fields.filter((field) => metadata[field] && !entry.metadata?.[field]).map((field) => [field, metadata[field]]));
    entry.metadata = { ...entry.metadata, ...metadata };
    if (Object.keys(additions).length && (entry.securityDecision !== "block" || entry.alertStage > 0)) await onEvent({ type: "early_activity_alert", activity: "metadata_enriched", entry, additions, observedAt: new Date().toISOString() });
  }

  async function runCheckCycle() {
    running = true;
    const checkStartedAt = Date.now();
    let head = null;
    let entries = [];
    try {
      head = (await provider.getBlockNumber()) - config.confirmations;
      entries = Object.values(state.tokens).filter((entry) => (
        isSupportedActivityPool(entry?.pool)
        && Date.now() - Date.parse(entry.firstSeenAt) <= 24 * 60 * 60_000
      ));
      if (entries.length) {
        await checkMetadata(entries[metadataCursor % entries.length]);
        metadataCursor += 1;
      }
      for (let offset = 0; offset < entries.length; offset += 20) {
        const batch = entries.slice(offset, offset + 20);
        const fromBlock = Math.max(Math.min(...batch.map((entry) => entry.lastScannedBlock + 1)), head - 25_000);
        if (fromBlock > head) continue;
        const batchLogs = await provider.getLogs({ address: batch.map((entry) => entry.pool.pool), fromBlock, toBlock: head, topics: [[V3_SWAP, V2_SWAP]] });
        const entriesByPool = new Map(batch.map((entry) => [lower(entry.pool.pool), entry]));
        const relevantLogs = batchLogs.filter((log) => log.blockNumber > Number(entriesByPool.get(lower(log.address))?.lastScannedBlock ?? head));
        const blockTimestamps = relevantLogs.length ? await resolveBlockTimestamps(relevantLogs) : new Map();
        const byPool = new Map();
        for (const log of relevantLogs) {
          const key = lower(log.address);
          if (!byPool.has(key)) byPool.set(key, []);
          byPool.get(key).push(log);
        }
        for (const entry of batch) {
          const logs = (byPool.get(lower(entry.pool.pool)) || []).filter((log) => log.blockNumber > entry.lastScannedBlock);
        if (!logs.length) {
          entry.lastScannedBlock = head;
          continue;
        }
        const newSamples = activitySamplesFromLogs(entry, logs, blockTimestamps);
        entry.lastScannedBlock = head;
        const now = Date.now();
        entry.samples.push(...newSamples);
        entry.samples = entry.samples.filter((sample) => now - sample.at >= 0 && now - sample.at <= 10 * 60_000);
        const { minute, previousMinute, fiveMinutes, volumeAcceleration } = activityWindows(entry.samples, now);
        const minimum = minimumVolume(entry);
        const stage = minimum === null ? 0 : anomalyStage(minute.swaps, minute.volume, minimum);
        const escalated = stage > entry.alertStage;
        if (escalated && now - entry.lastAlertAt >= 5 * 60_000) {
          if (now >= Number(entry.nextSecurityAt || 0)) {
            entry.security = await assessSecurity(provider, entry.token, [entry.pool]).catch((error) => ({
              decision: "unknown",
              label: "安全检查未完成",
              reasons: [`本地链上检查失败: ${error.message.slice(0, 120)}`],
              checkedAt: new Date(now).toISOString(),
              source: "local_onchain",
            }));
            entry.securityDecision = entry.security?.decision || "unknown";
            entry.nextSecurityAt = now + 2 * 60_000;
          }
          if (entry.securityDecision !== "pass") continue;
          entry.alertStage = stage;
          entry.lastAlertAt = now;
          await onEvent({
            type: "early_activity_alert",
            activity: "volume_anomaly",
            entry,
            swapsInMinute: minute.swaps,
            volumeInMinute: minute.volume,
            buysInMinute: minute.buys,
            sellsInMinute: minute.sells,
            swapsInFiveMinutes: fiveMinutes.swaps,
            buysInFiveMinutes: fiveMinutes.buys,
            sellsInFiveMinutes: fiveMinutes.sells,
            volumeInFiveMinutes: fiveMinutes.volume,
            previousVolumeInMinute: previousMinute.volume,
            volumeAcceleration,
            unknownDirectionsInMinute: minute.unknownDirections,
            unknownDirectionsInFiveMinutes: fiveMinutes.unknownDirections,
            latestSwapAt: new Date(Math.max(...entry.samples.map((sample) => sample.at))).toISOString(),
            activityCoverage: "rolling_window_exact_block_timestamps",
            minimumVolumeInMinute: minimum,
            stageCriteria: stage >= 3
              ? { swaps: 200, volume: minimum * 10 }
              : stage >= 2
                ? { swaps: 50, volume: minimum * 3 }
                : { swaps: 10, volume: minimum },
            stage: entry.alertStage,
            lastTransactionHash: logs.at(-1).transactionHash,
            observedAt: new Date().toISOString(),
          });
        }
        }
      }
      const sampleTimes = entries.flatMap((entry) => (entry.samples || []).map((sample) => Number(sample.at))).filter(Number.isFinite);
      state._health = {
        status: "healthy",
        checkedAt: new Date().toISOString(),
        lastSuccessAt: new Date().toISOString(),
        consecutiveFailures: 0,
        durationMs: Date.now() - checkStartedAt,
        headBlock: head,
        watchedTokens: entries.length,
        supportedQuotePools: entries.filter((entry) => minimumVolume(entry) !== null).length,
        unsupportedQuotePools: entries.filter((entry) => minimumVolume(entry) === null).length,
        timestampCoverage: "exact_block_headers",
        rollingWindowMinutes: 5,
        latestSampleAt: sampleTimes.length ? new Date(Math.max(...sampleTimes)).toISOString() : null,
      };
      await save();
    } catch (error) {
      const previous = state._health || { consecutiveFailures: 0 };
      state._health = {
        ...previous,
        status: "error",
        checkedAt: new Date().toISOString(),
        lastErrorAt: new Date().toISOString(),
        lastError: String(error.message || error).slice(0, 300),
        consecutiveFailures: Number(previous.consecutiveFailures || 0) + 1,
        durationMs: Date.now() - checkStartedAt,
        headBlock: head,
        watchedTokens: entries.length,
      };
      await save().catch(() => {});
      console.error(`[early-activity] ${error.message}`);
    }
    finally { running = false; }
  }

  function check() {
    if (stopped) return activeCheckPromise || Promise.resolve();
    if (activeCheckPromise) return Promise.resolve();
    activeCheckPromise = runCheckCycle().finally(() => {
      activeCheckPromise = null;
    });
    return activeCheckPromise;
  }

  ready = seed()
    .then(() => {
      initialized = true;
      return stopped ? undefined : check();
    })
    .catch((error) => {
      console.error(`[early-activity-init] ${error.message}`);
      throw error;
    });
  const timer = setInterval(() => {
    if (initialized && !stopped) void check();
  }, 15_000);
  timer.unref();
  return {
    add,
    check,
    ready,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      clearInterval(timer);
      const inFlight = [ready, activeCheckPromise, ...activeAdds].filter(Boolean);
      stopPromise = (async () => {
        await Promise.allSettled(inFlight);
        await writeQueue;
      })();
      return stopPromise;
    },
  };
}
