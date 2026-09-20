#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";

import { createRpcPool } from "../src/bsc-launchpad-monitor.js";
import { createFomoXCallMonitor } from "../src/fomo-x-call-monitor.js";
import { renderKolTokenLaunchLanguageLines } from "../src/kol-token-launch-alert.js";
import { createNarrativeLiveEvidenceProvider } from "../src/narrative-live-evidence.js";
import { createProductionNarrativeShadowQuoteProvider } from "../src/narrative-shadow-quote-runtime.js";
import {
  createAuditOnlyLiveEvidenceProvider,
  createAuditOnlyShadowLedger,
  createDurableLocalAlertSink,
  createNarrativeShadowSoak,
} from "../src/narrative-shadow-soak-sidecar.js";
import { createNarrativeSniperRuntime } from "../src/narrative-sniper-runtime.js";
import { createNarrativeSourceAdapter } from "../src/narrative-source-adapter.js";

const PROJECT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PRODUCTION_DATA_DIR = path.join(PROJECT_DIR, "data");
const DEFAULT_SOAK_DIR = path.resolve(PROJECT_DIR, "..", "robinhood-chain-monitor-shadow-soak");
const DAY_MS = 24 * 60 * 60_000;

function integerEnvironment(name, fallback, { minimum = 1, maximum = Number.MAX_SAFE_INTEGER } = {}) {
  const value = process.env[name] == null || process.env[name] === "" ? fallback : Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new TypeError(`${name} must be an integer from ${minimum} through ${maximum}`);
  }
  return value;
}

function csvEnvironment(name, fallback = []) {
  const raw = process.env[name];
  return raw == null || raw.trim() === ""
    ? [...fallback]
    : raw.split(",").map((value) => value.trim()).filter(Boolean);
}

function enabledEnvironment(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  if (/^true$/iu.test(raw)) return true;
  if (/^false$/iu.test(raw)) return false;
  throw new TypeError(`${name} must be true or false`);
}

function inside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== "..");
}

function safeRpcUrls() {
  const values = csvEnvironment("NARRATIVE_SHADOW_SOAK_BSC_RPC_URLS", [
    "https://bsc-dataseed.nariox.org",
    "https://bsc-dataseed.defibit.io",
    "https://bsc-dataseed.ninicoin.io",
  ]);
  const seen = new Set();
  const urls = [];
  for (const value of values) {
    const parsed = new URL(value);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) {
      throw new TypeError("soak RPC URLs must be credential-free HTTP(S) URLs");
    }
    const host = parsed.hostname.toLowerCase().replace(/\.+$/u, "");
    if (!seen.has(host)) {
      seen.add(host);
      urls.push(parsed.toString());
    }
  }
  if (urls.length < 2) throw new TypeError("the shadow quote lane requires at least two distinct RPC hosts");
  return urls;
}

function renderLocalKolCard(event) {
  const zh = renderKolTokenLaunchLanguageLines(event, "zh");
  const en = renderKolTokenLaunchLanguageLines(event, "en");
  return [
    "🔔 监控提醒 | MONITOR ALERT",
    "",
    "中文",
    ...zh,
    "",
    "English",
    ...en,
  ].join("\n");
}

function runtimeConfig(soakDir, rpcUrls) {
  return {
    dataDir: path.join(soakDir, "narrative-runtime"),
    narrativeSniperEnabled: true,
    narrativeSniperAutoStart: false,
    narrativeSniperAutoCheckOnObserve: false,
    narrativeSniperEvaluationIntervalMs: 5_000,
    narrativeSniperRequestTimeoutMs: 5_000,
    narrativeSniperMarketEvidenceMaxAgeMs: 15_000,
    narrativeSniperRiskEvidenceMaxAgeMs: 30_000,
    narrativeSniperNewsMaxAgeMs: 600_000,
    narrativeSniperCandidateMaxAgeMs: 600_000,
    narrativeSniperStateLimit: 2_000,
    narrativeShadowEntryTtlMs: 30_000,
    narrativeShadowInitialEquityUsd: 10_000,
    narrativeShadowSimulatorEnabled: true,
    narrativeShadowSimulatorAutoStart: false,
    narrativeShadowMarkIntervalMs: 30_000,
    narrativeShadowProviderTimeoutMs: 30_000,
    narrativeShadowQuoteRpcBudgetMs: 25_000,
    narrativeShadowQuoteRpcRequestTimeoutMs: 5_000,
    narrativeShadowQuoteConfirmations: 2,
    narrativeShadowQuoteMaxHeadLagBlocks: 3,
    narrativeShadowOracleMaxAgeMs: 5_400_000,
    narrativeShadowQuoteMaxAgeMs: 15_000,
    narrativeShadowQuoteBlockMaxAgeMs: 30_000,
    narrativeShadowQuoteMaxValidityMs: 5_000,
    narrativeShadowQuoteFutureSkewMs: 1_000,
    narrativeShadowTakeProfitBps: 5_000,
    narrativeShadowStopLossBps: 2_000,
    narrativeShadowTimeStopMs: 900_000,
    narrativeShadowMaxOrdersPerCycle: 100,
    narrativeShadowTerminalAuditPerCycle: 10,
    narrativeShadowQuoteRpcUrls: rpcUrls,
    bscRpcUrls: rpcUrls,
    bscCausalClassificationRpcUrls: rpcUrls,
    bscConfirmations: 2,
    fomoCallGoPlusMaxTaxBps: 1_000,
    telegramToken: "",
    telegramChatId: "",
    webhookUrl: "",
    alertTranslationUrl: "",
    alertTranslationFallbackUrl: "",
  };
}

function kolConfig(soakDir) {
  return {
    dataDir: path.join(soakDir, "kol-monitor"),
    fomoXCallEnabled: false,
    kolLaunchMonitorEnabled: true,
    kolCapitalRosterEnabled: true,
    kolCapitalCatalogMaximumAgeMs: 180 * DAY_MS,
    kolCapitalCategories: csvEnvironment("NARRATIVE_SHADOW_SOAK_KOL_CATEGORIES"),
    fomoCallPublicHandles: [],
    fomoXCallPollIntervalMs: integerEnvironment("NARRATIVE_SHADOW_SOAK_KOL_POLL_MS", 30_000, {
      minimum: 5_000,
      maximum: 10 * 60_000,
    }),
    fomoXCallDiscoveryIntervalMs: 60_000,
    fomoXCallAttributionMaxAgeMs: DAY_MS,
    fomoXCallProfileRefreshMs: 30 * 60_000,
    fomoXCallVerifiedSeedRefreshMs: 30 * 60_000,
    fomoXCallVerifiedSeedRetryMs: 5 * 60_000,
    fomoXCallMaxPostAgeMs: 5 * 60_000,
    fomoXCallPendingMaxAgeMs: 10 * 60_000,
    fomoXCallAdmissionRetryMs: 30 * 60_000,
    fomoXCallTokenDedupMs: 30 * DAY_MS,
    fomoXCallMinXFollowers: 10_000,
    fomoXCallMinLiquidityUsd: 10_000,
    fomoXCallCandidateLimit: 100,
    fomoXCallBatchSize: 5,
    fomoXCallConcurrency: 2,
    fomoXCallRequestTimeoutMs: 8_000,
    fomoCallFxTwitterApiBase: process.env.NARRATIVE_SHADOW_SOAK_FXTWITTER_BASE || "https://api.fxtwitter.com",
    fomoXCallOembedBase: "https://publish.x.com/oembed",
    fomoCallBscRpcUrl: process.env.NARRATIVE_SHADOW_SOAK_BSC_READ_URL || "https://bsc-rpc.publicnode.com",
    fomoScanApiBase: "https://api.fomoscan.sh",
    fomoPublishedCallMinXFollowers: 10_000,
    fomoPublishedCallMinLiquidityUsd: 10_000,
    telegramToken: "",
    telegramChatId: "",
    webhookUrl: "",
  };
}

async function main() {
  const soakDir = path.resolve(process.env.NARRATIVE_SHADOW_SOAK_DATA_DIR || DEFAULT_SOAK_DIR);
  const configuredMainOutbox = process.env.NARRATIVE_SHADOW_SOAK_MAIN_OUTBOX
    ? path.resolve(process.env.NARRATIVE_SHADOW_SOAK_MAIN_OUTBOX)
    : null;
  const configuredProductionDataDir = path.resolve(
    process.env.NARRATIVE_SHADOW_SOAK_PRODUCTION_DATA_DIR
      || (configuredMainOutbox ? path.dirname(configuredMainOutbox) : PRODUCTION_DATA_DIR),
  );
  const durationMs = integerEnvironment("NARRATIVE_SHADOW_SOAK_DURATION_MS", DAY_MS, {
    minimum: 60_000,
    maximum: 7 * DAY_MS,
  });
  const pollIntervalMs = integerEnvironment("NARRATIVE_SHADOW_SOAK_POLL_MS", 2_000, {
    minimum: 250,
    maximum: 60_000,
  });
  const heartbeatIntervalMs = integerEnvironment("NARRATIVE_SHADOW_SOAK_HEARTBEAT_MS", 30_000, {
    minimum: 1_000,
    maximum: 10 * 60_000,
  });
  const kolEnabled = enabledEnvironment("NARRATIVE_SHADOW_SOAK_KOL_ENABLED", true);
  const rpcUrls = safeRpcUrls();
  const sourceFiles = [
    {
      id: "main",
      file: configuredMainOutbox || path.join(configuredProductionDataDir, "alert-outbox.json"),
    },
    {
      id: "fomo",
      file: path.resolve(process.env.NARRATIVE_SHADOW_SOAK_FOMO_OUTBOX
        || path.join(configuredProductionDataDir, "fomo-alerts", "alert-outbox.json")),
    },
  ];
  const forbiddenWriteRoots = [...new Set([
    PRODUCTION_DATA_DIR,
    configuredProductionDataDir,
    ...sourceFiles.map((source) => path.dirname(source.file)),
  ].map((value) => path.resolve(value)))];
  const conflictingRoot = forbiddenWriteRoots.find((root) => inside(soakDir, root));
  if (conflictingRoot) {
    throw new Error(`refusing to place the shadow soak inside a production/source data directory: ${conflictingRoot}`);
  }

  const worker = createNarrativeShadowSoak({
    dataDir: soakDir,
    sourceFiles,
    forbiddenWriteRoots,
    ownedWriteDirectories: [
      path.join(soakDir, "narrative-runtime"),
      path.join(soakDir, "kol-monitor"),
    ],
    durationMs,
    pollIntervalMs,
    heartbeatIntervalMs,
  }, {
    logger: console,
    initialize: async () => {
      let evidenceRpc = null;
      let runtime = null;
      let kolMonitor = null;
      let signalSink = null;
      let kolSink = null;
      try {
        const settings = runtimeConfig(soakDir, rpcUrls);
        evidenceRpc = createRpcPool(rpcUrls, [], 1, {
          requestTimeoutMs: 2_500,
          standardConcurrency: 2,
        });
        const readOnlyEvidenceRpc = Object.freeze({
          getNetwork: (...args) => evidenceRpc.getNetwork(...args),
          getCode: (...args) => evidenceRpc.getCode(...args),
          getStorage: (...args) => evidenceRpc.getStorage(...args),
          call: (...args) => evidenceRpc.call(...args),
        });
        const liveEvidence = createNarrativeLiveEvidenceProvider({
          provider: readOnlyEvidenceRpc,
          totalBudgetMs: 5_000,
          marketTtlMs: 15_000,
          goPlusTtlMs: 30_000,
          maximumTax: 0.1,
        });
        const guardedEvidence = createAuditOnlyLiveEvidenceProvider(liveEvidence);
        const denyLedger = createAuditOnlyShadowLedger();
        const quoteProvider = createProductionNarrativeShadowQuoteProvider(settings);
        signalSink = createDurableLocalAlertSink(path.join(soakDir, "shadow-signals.jsonl"));
        runtime = createNarrativeSniperRuntime(settings, {
          narrativeAdapter: createNarrativeSourceAdapter(),
          liveEvidenceProvider: guardedEvidence,
          ledger: denyLedger,
          shadowQuoteProvider: quoteProvider,
          sendAlertsImpl: (sinkConfig, event) => signalSink.send(sinkConfig, event, {
            channel: "narrative_shadow_signal",
            localOnly: true,
          }),
          logger: console,
        });
        await runtime.ready;

        if (kolEnabled) {
          kolSink = createDurableLocalAlertSink(path.join(soakDir, "kol-launch-alerts.jsonl"));
          const localKolDelivery = async (_sinkConfig, event) => {
            let alertText = null;
            let renderError = null;
            try {
              alertText = renderLocalKolCard(event);
            } catch (error) {
              renderError = String(error?.message || error).slice(0, 300);
            }
            return kolSink.send({}, {
              type: "narrative_shadow_soak_kol_launch_record",
              eventKey: event?.eventKey || null,
              observedAt: event?.observedAt || new Date().toISOString(),
              mode: "watch_only",
              executable: false,
              alertText,
              renderError,
              sourceEvent: event,
            }, {
              channel: "kol_launch_watch",
              localOnly: true,
            });
          };
          kolMonitor = createFomoXCallMonitor(kolConfig(soakDir), {
            sendAlertsImpl: localKolDelivery,
            discoverCandidatesImpl: async () => [],
            qualifyCallImpl: async () => ({
              decision: "watch",
              reason: "shadow_soak_social_claim_only",
              market: null,
              security: { decision: "unknown", reasons: ["audit_only_soak_policy"] },
            }),
            autoStart: false,
            logger: console,
          });
        }
        return {
          runtime,
          kolMonitor,
          cleanup: async () => {
            evidenceRpc?.destroy?.();
            await Promise.allSettled([signalSink?.stop?.(), kolSink?.stop?.()]);
          },
        };
      } catch (error) {
        await Promise.allSettled([
          kolMonitor?.stop?.(),
          runtime?.stop?.(),
          signalSink?.stop?.(),
          kolSink?.stop?.(),
        ]);
        evidenceRpc?.destroy?.();
        throw error;
      }
    },
  });

  let shutdown = null;
  const requestStop = (signal) => {
    shutdown ||= worker.stop(signal).catch((error) => {
      console.error(`[shadow-soak] shutdown failed: ${error?.stack || error}`);
      process.exitCode = 1;
    });
  };
  process.once("SIGINT", () => requestStop("SIGINT"));
  process.once("SIGTERM", () => requestStop("SIGTERM"));

  const started = await worker.start();
  console.info(`[shadow-soak] started ${JSON.stringify(started)} dataDir=${soakDir}`);
  const completed = await worker.done;
  console.info(`[shadow-soak] completed state=${completed.state} reason=${completed.stopReason}`);
}

main().catch((error) => {
  console.error(`[shadow-soak] fatal: ${error?.stack || error}`);
  process.exitCode = 1;
});
