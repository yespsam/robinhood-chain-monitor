import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { sendAlerts, startAlertOutboxWorker } from "./alerts.js";
import { createFomoCallMonitor } from "./fomo-call-monitor.js";
import { createGmgnFlowMonitor } from "./gmgn-flow-monitor.js";
import { createBinanceFlowMonitor } from "./binance-flow-monitor.js";
import { createFomoThesisMonitor } from "./fomo-thesis-monitor.js";
import { createFomoXCallMonitor } from "./fomo-x-call-monitor.js";
import { startRuntimeHeartbeat } from "./runtime-heartbeat.js";

function compactError(error) {
  return String(error?.message || error || "unknown error").slice(0, 300);
}

export function createFomoWorkerShutdown({
  clearKeepAlive = () => {},
  onStopping = () => {},
  buyMonitor = null,
  thesisMonitor = null,
  xCallMonitor = null,
  gmgnFlowMonitor = null,
  binanceFlowMonitor = null,
  outbox = null,
  runtimeHeartbeat = null,
  processRef = process,
  logger = console,
} = {}) {
  let stopPromise = null;

  const stop = (signal = "shutdown") => {
    if (stopPromise) return stopPromise;
    const failures = [];
    try { onStopping(); } catch (error) { failures.push(["work-gate", error]); }
    try { clearKeepAlive(); } catch (error) { failures.push(["keep-alive", error]); }

    const attempt = (async () => {
      const monitors = [
        ["buy", buyMonitor],
        ["thesis", thesisMonitor],
        ["x-call", xCallMonitor],
        ["gmgn-flow", gmgnFlowMonitor],
        ["binance-flow", binanceFlowMonitor],
      ].filter(([, monitor]) => monitor?.stop);
      const monitorResults = await Promise.allSettled(
        monitors.map(([, monitor]) => Promise.resolve().then(() => monitor.stop())),
      );
      monitorResults.forEach((result, index) => {
        if (result.status === "rejected") failures.push([monitors[index][0], result.reason]);
      });

      if (outbox?.stop) {
        const [outboxResult] = await Promise.allSettled([
          Promise.resolve().then(() => outbox.stop()),
        ]);
        if (outboxResult.status === "rejected") failures.push(["outbox", outboxResult.reason]);
      }

      if (runtimeHeartbeat?.stop) {
        const [heartbeatResult] = await Promise.allSettled([
          Promise.resolve().then(() => runtimeHeartbeat.stop()),
        ]);
        if (heartbeatResult.status === "rejected") failures.push(["runtime-heartbeat", heartbeatResult.reason]);
      }

      for (const [label, error] of failures) logger.error?.(`[fomo-worker][shutdown] ${label}: ${compactError(error)}`);
      if (failures.length) processRef.exitCode = 1;
      logger.info?.(`[fomo-worker][shutdown] ${signal} ${failures.length ? "completed with errors" : "complete"}`);
    })();
    stopPromise = attempt;
    return attempt;
  };

  return { stop };
}

export function installFomoWorkerSignalHandlers(stop, processRef = process) {
  const onSigint = () => { void stop("SIGINT"); };
  const onSigterm = () => { void stop("SIGTERM"); };
  processRef.on("SIGINT", onSigint);
  processRef.on("SIGTERM", onSigterm);
  return () => {
    processRef.removeListener("SIGINT", onSigint);
    processRef.removeListener("SIGTERM", onSigterm);
  };
}

function startFomoWorker() {
  for (const level of ["error", "info"]) {
    const write = console[level].bind(console);
    console[level] = (...args) => write(`[${new Date().toISOString()}]`, ...args);
  }

  if (!config.fomoCallEnabled || !config.fomoCallStandalone) {
    console.info("[fomo-call] monitor is disabled; the worker will not start a scanner or outbox");
    return null;
  }
  if (!config.fomoBuyMonitorEnabled && !config.fomoSmartMoneyMonitorEnabled
    && !config.fomoPublishedCallEnabled && !config.fomoXCallEnabled && !config.kolLaunchMonitorEnabled
    && !config.gmgnFlowMonitorEnabled) {
    console.info("[fomo-call] all Fomo monitoring lanes are disabled");
    return null;
  }

  let stopping = false;
  if (config.fomoPlatformSourcesEnabled === false) {
    console.info("[monitor-sources] FOMO platform sources disabled by user; GMGN smart-money and public X retain their existing settings");
  }
  const runtimeHeartbeat = startRuntimeHeartbeat({
    file: path.join(config.dataDir, "fomo-runtime-heartbeat.json"),
    producer: "fomo",
  });
  const alertConfig = { ...config, dataDir: path.join(config.dataDir, "fomo-alerts") };
  const outbox = startAlertOutboxWorker(alertConfig);
  const deliverAlert = (_config, event) => {
    if (stopping) return Promise.reject(new Error("Fomo worker is stopping"));
    return sendAlerts(alertConfig, event);
  };
  const inferredWalletMonitorEnabled = config.fomoBuyMonitorEnabled || config.fomoSmartMoneyMonitorEnabled;
  const gmgnFlowMonitor = config.gmgnFlowMonitorEnabled
    ? createGmgnFlowMonitor(config, { sendAlertsImpl: deliverAlert })
    : null;
  if (gmgnFlowMonitor) console.info("[gmgn-flow] cross-chain joint volume / profitable-wallet / FOMO-tag observation enabled");
  const binanceFlowMonitor = config.gmgnFlowMonitorEnabled && config.binanceFlowMonitorEnabled
    ? createBinanceFlowMonitor(config) : null;
  if (binanceFlowMonitor) console.info("[binance-flow] public read-only secondary flow enabled; no wallet authorization");
  const buyMonitor = inferredWalletMonitorEnabled
    ? createFomoCallMonitor(config, { sendAlertsImpl: deliverAlert })
    : null;
  const thesisMonitor = config.fomoPublishedCallEnabled
    ? createFomoThesisMonitor(config, { sendAlertsImpl: deliverAlert })
    : null;
  const xCallMonitor = config.fomoXCallEnabled || config.kolLaunchMonitorEnabled
    ? createFomoXCallMonitor(config, { sendAlertsImpl: deliverAlert })
    : null;
  if (!buyMonitor) console.info("[fomo-call] inferred wallet-buy monitoring is disabled");
  else if (!config.fomoBuyMonitorEnabled && config.fomoSmartMoneyMonitorEnabled) {
    console.info("[fomo-smart-money] profitable-wallet monitoring enabled; legacy KOL buy delivery remains disabled");
  }
  if (xCallMonitor) console.info("[fomo-x-call] public X call monitoring enabled; this lane is not a Fomo official feed");
  if (config.kolLaunchMonitorEnabled) {
    console.info("[kol-launch] verified public X self-launch claims enabled; creator attribution remains watch-only");
  }
  if (thesisMonitor) {
    const activeSources = [
      config.fomoOfficialBearerToken ? "official" : null,
      config.fomoThesisRelayToken ? "relay" : null,
    ].filter(Boolean);
    if (activeSources.length) {
      console.info(`[fomo-thesis] published Trade Thesis monitoring enabled sources=${activeSources.join(",")}`);
    } else {
      console.error("[fomo-thesis] blocked_missing_credentials: set FOMO_OFFICIAL_BEARER_TOKEN or FOMOSCAN_THESIS_TOKEN; polling remains health-only and cannot receive calls");
    }
  }

  const keepAlive = setInterval(() => {}, 60_000);
  const shutdown = createFomoWorkerShutdown({
    clearKeepAlive: () => clearInterval(keepAlive),
    onStopping: () => { stopping = true; },
    buyMonitor,
    thesisMonitor,
    xCallMonitor,
    gmgnFlowMonitor,
    binanceFlowMonitor,
    outbox,
    runtimeHeartbeat,
  });
  installFomoWorkerSignalHandlers(shutdown.stop);
  return shutdown;
}

const isEntrypoint = Boolean(process.argv[1])
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) startFomoWorker();
