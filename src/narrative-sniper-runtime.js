import { createNarrativeLiveEvidenceProvider } from "./narrative-live-evidence.js";
import { createNarrativeShadowLedger } from "./narrative-shadow-ledger.js";
import { createNarrativeShadowSimulator } from "./narrative-shadow-simulator.js";
import { createNarrativeSniperMonitor } from "./narrative-sniper-monitor.js";
import { verifyNarrativeTradeSignalIntegrity } from "./narrative-trade-signal.js";

export const NARRATIVE_SNIPER_RUNTIME_VERSION = 1;

const positiveInteger = (value, fallback) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

function initialEquityMicros(value) {
  const dollars = positiveInteger(value, 10_000);
  return (BigInt(dollars) * 1_000_000n).toString();
}

function monitorConfig(config) {
  const stateLimit = positiveInteger(config.narrativeSniperStateLimit, 2_000);
  const newsWindowMs = positiveInteger(config.narrativeSniperNewsMaxAgeMs, 600_000);
  const candidateWindowMs = positiveInteger(config.narrativeSniperCandidateMaxAgeMs, 600_000);
  return {
    ...config,
    narrativeSniperAutoStart: config.narrativeSniperAutoStart !== false,
    narrativeSniperAutoCheckOnObserve: config.narrativeSniperAutoCheckOnObserve !== false,
    narrativeSniperCheckIntervalMs: positiveInteger(config.narrativeSniperEvaluationIntervalMs, 1_000),
    narrativeSniperNewsRealtimeMs: newsWindowMs,
    narrativeSniperNewsRetentionMs: Math.max(newsWindowMs, candidateWindowMs),
    narrativeSniperPoolRealtimeMs: candidateWindowMs,
    narrativeSniperMaxInbox: stateLimit,
    narrativeSniperMaxAdmissions: stateLimit,
    narrativeSniperMaxNews: stateLimit,
    narrativeSniperMaxContexts: stateLimit,
    narrativeSniperMaxTargets: stateLimit,
    narrativeSniperMaxCandidates: stateLimit,
    narrativeSniperMaxSignals: stateLimit,
  };
}

function signalEvent(signal) {
  const integrity = verifyNarrativeTradeSignalIntegrity(signal);
  if (integrity?.valid !== true || signal?.decision !== "do"
    || signal?.shadowOrder?.mode !== "shadow" || signal?.shadowOrder?.executable !== false) {
    throw new TypeError(`refusing to deliver an invalid narrative shadow signal${integrity?.reasons?.length ? `: ${integrity.reasons.join(",")}` : ""}`);
  }
  return {
    type: "narrative_trade_signal",
    kind: "shadow_candidate",
    eventKey: `narrative-trade:${signal.decisionHash}`,
    observedAt: signal.event?.asOf || signal.shadowOrder?.simulatedAt,
    signal,
  };
}

/**
 * Wires the deterministic narrative engine to public evidence and a durable
 * shadow ledger. This runtime deliberately contains no signer, wallet, swap,
 * or broadcast dependency.
 */
export function createNarrativeSniperRuntime(config = {}, dependencies = {}) {
  if (config.narrativeSniperEnabled !== true) {
    throw new TypeError("narrative sniper runtime may only be created when explicitly enabled");
  }
  const sendAlertsImpl = dependencies.sendAlertsImpl;
  if (typeof sendAlertsImpl !== "function") throw new TypeError("sendAlertsImpl is required");
  const narrativeAdapter = dependencies.narrativeAdapter;
  if (!(typeof narrativeAdapter === "function" || typeof narrativeAdapter?.adapt === "function")) {
    throw new TypeError("narrativeAdapter is required");
  }
  const logger = dependencies.logger || console;
  const liveEvidence = dependencies.liveEvidenceProvider || createNarrativeLiveEvidenceProvider({
    provider: dependencies.provider,
    fetchImpl: dependencies.fetchImpl,
    totalBudgetMs: positiveInteger(config.narrativeSniperRequestTimeoutMs, 5_000),
    marketTtlMs: Math.min(15_000, positiveInteger(config.narrativeSniperMarketEvidenceMaxAgeMs, 30_000)),
    goPlusTtlMs: Math.min(30_000, positiveInteger(config.narrativeSniperRiskEvidenceMaxAgeMs, 300_000)),
    goPlusApiBase: config.fomoCallGoPlusApiBase,
    maximumTax: Math.max(0, Math.min(1, Number(config.fomoCallGoPlusMaxTaxBps || 1_000) / 10_000)),
    now: dependencies.now,
  });
  const ledger = dependencies.ledger || createNarrativeShadowLedger({
    dataDir: config.dataDir,
    now: dependencies.now,
    initialEquityUsdMicros: initialEquityMicros(config.narrativeShadowInitialEquityUsd),
    entryTtlMs: positiveInteger(config.narrativeShadowEntryTtlMs, 30_000),
  });
  let monitor;
  const sendSignal = async (signal) => sendAlertsImpl(config, signalEvent(signal));
  monitor = dependencies.monitor || createNarrativeSniperMonitor(monitorConfig(config), {
    narrativeAdapter,
    liveEvidenceProvider: liveEvidence,
    ledger,
    sendSignal,
    now: dependencies.now,
    fs: dependencies.fs,
    timers: dependencies.timers,
  });
  const shadowSimulator = config.narrativeShadowSimulatorEnabled === true
    ? dependencies.shadowSimulator || createNarrativeShadowSimulator(config, {
      ledger,
      quoteProvider: dependencies.shadowQuoteProvider,
      now: dependencies.now,
      timers: dependencies.timers,
    })
    : null;
  const ready = Promise.all([
    Promise.resolve(ledger.ready),
    Promise.resolve(shadowSimulator?.ready),
  ]).then(() => true);
  let stopped = false;
  let stopPromise = null;
  const admissionFlights = new Set();

  function logAdmissionFailure(reason) {
    try {
      logger.error?.(`[narrative-sniper] local admission failed: ${reason?.message || reason || "unknown admission error"}`);
    } catch {
      // Logging must never change the primary alert delivery result.
    }
  }

  async function observe(event) {
    if (stopped || event?.type === "narrative_trade_signal") return { status: stopped ? "stopped" : "ignored" };
    return monitor.observe(event);
  }

  async function sendAlert(runtimeConfig, event) {
    // Start the optional local admission immediately, but never let its fsync
    // latency consume the producer's Telegram/outbox SLA. The flight remains
    // tracked and is drained at shutdown so accepted evidence is not abandoned.
    const admission = Promise.resolve(observe(event)).then((result) => {
      if (result?.status === "error") logAdmissionFailure(result?.reason);
    }, logAdmissionFailure);
    admissionFlights.add(admission);
    void admission.finally(() => admissionFlights.delete(admission));
    return sendAlertsImpl(runtimeConfig, event);
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopped = true;
    stopPromise = (async () => {
      await Promise.allSettled([...admissionFlights]);
      const failures = [];
      for (const operation of [
        () => monitor.stop(),
        () => shadowSimulator?.stop?.(),
        () => liveEvidence.stop?.(),
        () => ledger.stop?.(),
      ]) {
        try { await operation(); } catch (error) { failures.push(error); }
      }
      if (failures.length) throw new AggregateError(failures, "narrative sniper runtime shutdown failed");
    })();
    return stopPromise;
  }

  return Object.freeze({
    version: NARRATIVE_SNIPER_RUNTIME_VERSION,
    enabled: true,
    ready,
    observe,
    sendAlert,
    check: () => monitor.check(),
    getState: () => monitor.getState(),
    getLedgerState: () => ledger.getState?.(),
    getMetrics: () => ledger.getMetrics?.() ?? ledger.metrics?.(),
    checkShadowSimulation: () => shadowSimulator?.check?.() ?? Promise.resolve({ status: "disabled" }),
    getShadowSimulationState: () => shadowSimulator?.getState?.() ?? Promise.resolve(null),
    getShadowSimulationMetrics: () => shadowSimulator?.getMetrics?.() ?? Promise.resolve(null),
    stop,
    monitor,
    ledger,
    liveEvidence,
    shadowSimulator,
  });
}
