import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const PAPER_STRATEGY_FOCUS_SHADOW_STORE_VERSION = 'bounded_focus_shadow_journal_v1';
const SCHEMA = 'paper_strategy_focus_shadow_v1';
const finite = value => typeof value === 'number' && Number.isFinite(value);
const iso = value => new Date(value).toISOString();
const compactNumber = value => finite(value) ? Number(value.toPrecision(8)) : null;
const boundedText = value => typeof value === 'string' ? value.slice(0, 360) : null;

function compactResult(row) {
  const internal = row?.internalSmartMoney || {};
  const external = row?.externalSecondBreakout || {};
  const metrics = external.metrics || {};
  const economics = external.economics || {};
  const quote = external.quoteConfirmation || {};
  return {
    internalSmartMoney: {
      status: boundedText(internal.status), reason: boundedText(internal.reason),
      evidence: internal.evidence ? {
        version: boundedText(internal.evidence.version), source: boundedText(internal.evidence.source),
        observedAt: boundedText(internal.evidence.observedAt), netBuyUsd: compactNumber(internal.evidence.netBuyUsd),
        independentGroups: finite(internal.evidence.independentGroups) ? internal.evidence.independentGroups : null,
      } : null,
    },
    externalSecondBreakout: {
      version: boundedText(external.version), status: boundedText(external.status),
      signalReady: external.signalReady === true, reasons: Array.isArray(external.reasons) ? external.reasons.slice(0, 8).map(boundedText) : [],
      metrics: {
        closedAt: boundedText(metrics.closedAt), impulseRise: compactNumber(metrics.impulseRise),
        impulsePeak: compactNumber(metrics.impulsePeak), pullback: compactNumber(metrics.pullback),
        consolidationBars: finite(metrics.consolidationBars) ? metrics.consolidationBars : null,
        breakoutLevel: compactNumber(metrics.breakoutLevel), lastClose: compactNumber(metrics.lastClose),
        volumeMultiple: compactNumber(metrics.volumeMultiple), support: compactNumber(metrics.support),
        targetPrice: compactNumber(metrics.targetPrice),
      },
      quoteConfirmation: {
        ready: quote.ready === true, count: finite(quote.count) ? quote.count : 0,
        firstAt: boundedText(quote.firstAt), confirmedAt: boundedText(quote.confirmedAt), reason: boundedText(quote.reason),
      },
      economics: {
        ready: economics.ready === true, reason: boundedText(economics.reason),
        breakEvenPrice: compactNumber(economics.breakEvenPrice), estimatedStopLossUsd: compactNumber(economics.estimatedStopLossUsd),
        netRewardRisk: compactNumber(economics.netRewardRisk), netReferenceGainUsd: compactNumber(economics.netReferenceGainUsd),
      },
    },
    operatorFootprint: { status: boundedText(row?.operatorFootprint?.status), caveat: boundedText(row?.operatorFootprint?.caveat),
      reason: boundedText(row?.operatorFootprint?.reason) },
    researchOnly: row?.researchOnly === true, entryAllowed: false, paperFillAllowed: false,
  };
}

function stableSignature(result) {
  const internal = result.internalSmartMoney;
  const external = result.externalSecondBreakout;
  return JSON.stringify({
    internal: [internal.status, internal.reason, internal.evidence?.source || null,
      internal.evidence?.netBuyUsd ?? null, internal.evidence?.independentGroups ?? null],
    external: [external.status, external.signalReady, external.reasons, external.metrics,
      external.quoteConfirmation.ready, external.quoteConfirmation.reason, external.economics.ready, external.economics.reason],
    operatorFootprint: result.operatorFootprint.status,
  });
}

function minuteBucket(at) { return Math.floor(at / 60_000) * 60_000; }

async function atomicWrite(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(typeof value === 'string' ? value : JSON.stringify(value));
    await handle.sync();
    await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally {
    if (handle) await handle.close();
    await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}

export function createPaperStrategyFocusShadowStore({ dataDir, sessionId = null, now = Date.now,
  maxSamples = 5000, maxTransitions = 12, debounceMs = 1500, checkpointMs = 60_000 } = {}) {
  if (typeof dataDir !== 'string' || !dataDir || typeof now !== 'function'
    || !Number.isSafeInteger(maxSamples) || maxSamples < 1 || !Number.isSafeInteger(maxTransitions) || maxTransitions < 1
    || !Number.isFinite(debounceMs) || debounceMs < 0 || !Number.isFinite(checkpointMs) || checkpointMs < 1000)
    throw new TypeError('invalid focus shadow store configuration');
  const suffix = sessionId == null ? '' : `-${createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 12)}`;
  const filePath = path.join(dataDir, `paper-strategy-focus-shadow-v1${suffix}.json`);
  let state = { schema: SCHEMA, version: PAPER_STRATEGY_FOCUS_SHADOW_STORE_VERSION, updatedAt: null,
    maxSamples, droppedSamples: 0, samples: [] };
  let index = new Map(), initialized = false, writable = true, lastError = null, lastPersistedAt = null;
  let dirty = false, flushTimer = null, flushPromise = null, flushAgain = false, lastCheckpointAt = 0, trimmedOnLoad = false;

  const rebuildIndex = () => { index = new Map(state.samples.map(sample => [sample.sampleKey, sample])); };
  const snapshot = () => ({ version: PAPER_STRATEGY_FOCUS_SHADOW_STORE_VERSION,
    status: !initialized ? 'loading' : lastError ? 'error' : dirty || flushPromise ? 'saving' : 'ready',
    durability: 'separate_bounded_research_file', file: path.basename(filePath), sampleCount: state.samples.length,
    droppedSamples: state.droppedSamples, oldestRetainedAt: state.samples[0]?.firstSeenAt || null,
    latestSampleAt: state.samples.at(-1)?.lastSeenAt || null, lastPersistedAt,
    lastError: lastError ? String(lastError).slice(0, 180) : null,
    note: '独立研究数据；不含原始K线，不修改交易账本/信号许可；容量到顶后保留较新样本并记录丢弃数。' });

  function scheduleFlush() {
    if (!initialized || !writable || !dirty) return;
    if (flushPromise) { flushAgain = true; return; }
    if (flushTimer) return;
    flushTimer = setTimeout(() => { flushTimer = null; void flush(); }, debounceMs);
    flushTimer.unref?.();
  }

  async function flush() {
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    if (flushPromise) { flushAgain = true; return flushPromise; }
    if (!initialized || !writable || !dirty) return snapshot();
    flushPromise = (async () => {
      do {
        flushAgain = false;
        if (!dirty || !writable) break;
        state.updatedAt = iso(now());
        const payload = JSON.stringify(state);
        dirty = false;
        try {
          await atomicWrite(filePath, payload);
          lastPersistedAt = state.updatedAt;
          lastError = null;
        } catch (error) {
          dirty = true; writable = false; lastError = `shadow journal write failed: ${error?.code || error?.message || 'unknown'}`;
          break;
        }
      } while (flushAgain || dirty);
    })();
    try { await flushPromise; }
    finally {
      flushPromise = null;
      if (dirty && writable) scheduleFlush();
    }
    return snapshot();
  }

  return {
    filePath,
    async initialize() {
      if (initialized) return snapshot();
      try {
        await fs.mkdir(dataDir, { recursive: true });
        let info;
        try { info = await fs.stat(filePath); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (info && info.size > 32 * 1024 * 1024) throw new Error('shadow journal exceeds safe read limit');
        if (info) {
          const loaded = JSON.parse(await fs.readFile(filePath, 'utf8'));
          if (loaded?.schema !== SCHEMA || loaded?.version !== PAPER_STRATEGY_FOCUS_SHADOW_STORE_VERSION
            || !Array.isArray(loaded.samples) || !Number.isSafeInteger(loaded.droppedSamples) || loaded.droppedSamples < 0
            || loaded.samples.some(sample => typeof sample?.sampleKey !== 'string' || typeof sample.chain !== 'string'
              || typeof sample.address !== 'string' || !Number.isSafeInteger(sample.observations) || sample.observations < 1
              || !Array.isArray(sample.transitions) || !sample.transitions.length || !sample.latest))
            throw new Error('shadow journal schema invalid; original file preserved');
          state = { ...loaded, maxSamples, samples: loaded.samples.slice(-maxSamples) };
          if (loaded.samples.length > maxSamples) {
            state.droppedSamples += loaded.samples.length - maxSamples;
            trimmedOnLoad = true;
          }
          rebuildIndex();
          lastPersistedAt = typeof loaded.updatedAt === 'string' ? loaded.updatedAt : null;
        }
      } catch (error) {
        writable = false;
        lastError = `shadow journal initialization failed: ${error?.code || error?.message || 'unknown'}`;
      }
      initialized = true;
      if (writable && trimmedOnLoad) { rebuildIndex(); dirty = true; scheduleFlush(); }
      return snapshot();
    },
    record(rows, checkedAt = now()) {
      if (!initialized || !writable || !Array.isArray(rows) || !finite(checkedAt)) return snapshot();
      const checkedAtIso = iso(checkedAt);
      let changed = false;
      for (const row of rows) {
        const chain = typeof row?.chain === 'string' ? row.chain : null;
        const address = typeof row?.address === 'string' ? row.address : null;
        if (!chain || !address || row?.researchOnly !== true) continue;
        const canonicalAddress = ['sol', 'solana'].includes(chain.toLowerCase()) ? address : address.toLowerCase();
        const closedAt = row.externalSecondBreakout?.metrics?.closedAt;
        const candleKey = typeof closedAt === 'string' && Number.isFinite(Date.parse(closedAt))
          ? new Date(Date.parse(closedAt)).toISOString() : iso(minuteBucket(checkedAt));
        const sampleKey = `${chain}:${canonicalAddress}:${candleKey}`;
        const result = compactResult(row), signature = stableSignature(result);
        let sample = index.get(sampleKey);
        if (!sample) {
          sample = { sampleKey, chain, address: canonicalAddress, symbol: typeof row.symbol === 'string' ? row.symbol.slice(0, 48) : null,
            marketStage: typeof row.marketStage === 'string' ? row.marketStage : null, candleClosedAt: closedAt || null,
            firstSeenAt: checkedAtIso, lastSeenAt: checkedAtIso, observations: 1, transitions: [{ at: checkedAtIso, signature,
              result }], latest: result };
          state.samples.push(sample); index.set(sampleKey, sample); changed = true;
          if (state.samples.length > maxSamples) {
            const removed = state.samples.splice(0, state.samples.length - maxSamples);
            state.droppedSamples += removed.length; rebuildIndex();
          }
        } else {
          sample.observations += 1;
          sample.lastSeenAt = checkedAtIso;
          sample.latest = result;
          const lastTransition = sample.transitions.at(-1);
          if (!lastTransition || lastTransition.signature !== signature) {
            sample.transitions.push({ at: checkedAtIso, signature, result });
            if (sample.transitions.length > maxTransitions) sample.transitions.splice(0, sample.transitions.length - maxTransitions);
            changed = true;
          }
        }
      }
      if (changed || checkedAt - lastCheckpointAt >= checkpointMs) {
        dirty = true; lastCheckpointAt = checkedAt; scheduleFlush();
      }
      return snapshot();
    },
    flush,
    snapshot,
  };
}
