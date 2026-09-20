import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("independent update monitors start before fallible chain initialization", async () => {
  const source = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const main = source.slice(source.indexOf("async function main()"));
  const independent = main.indexOf("startIndependentMonitors()");
  const chain = main.indexOf("await runChainMonitor()");
  const independentBody = source.slice(source.indexOf("function startIndependentMonitors()"), source.indexOf("async function runChainMonitor()"));

  assert.ok(independent >= 0);
  assert.ok(chain > independent);
  assert.match(independentBody, /createBscLaunchpadMonitor/);
  assert.match(independentBody, /createFlapQuoteMonitor/);
  assert.match(independentBody, /createFourRegistryMonitor/);
  assert.match(independentBody, /if \(config\.fourRegistryMonitorEnabled\) startMonitor\("four-registry"/);
  assert.match(independentBody, /onEvent: \(event\) => deliverAlert\(config, event\)/);
  assert.match(source, /async function deliverAlert\(runtimeConfig, event\)/);
  assert.match(source, /narrativeSniperRuntime\.sendAlert\(runtimeConfig, event\)/);
  assert.match(independentBody, /cancelPendingEvent: \(evidence\) => cancelPendingFourRegistryEvent\(config, evidence\)/);
  assert.match(independentBody, /onFlapQuotePoolLifecycle:\s*async \(record\)/);
  assert.match(independentBody, /bscLaunchpadMonitor\.registerFlapQuotePoolLifecycle\(record\)/);
  assert.match(independentBody, /lifecycle registry is not ready/,
    "a direct lifecycle cannot be silently dropped while the BSC registry is unavailable");
  assert.match(main, /\[chain-init-retry\]/);
});

test("chain events remain durable without duplicating every event into launchd stdout", async () => {
  const source = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");

  assert.match(source, /await storage\.append\(event\)/);
  assert.match(source, /if \(config\.logEventsToStdout\) console\.log/);
});

test("ordinary Twitter monitoring has an independent kill switch while narrow critical-X lanes can stay alive", async () => {
  const indexSource = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const configSource = await fs.readFile(new URL("../src/config.js", import.meta.url), "utf8");

  assert.match(configSource, /twitterMonitorEnabled:.*TWITTER_MONITOR_ENABLED/);
  assert.match(configSource, /binanceCriticalXMonitorEnabled:.*BINANCE_CRITICAL_X_MONITOR_ENABLED/);
  assert.match(configSource, /focusCriticalXMonitorEnabled:.*FOCUS_CRITICAL_X_MONITOR_ENABLED/);
  assert.match(configSource, /ponMonitorEnabled:.*PON_MONITOR_ENABLED/);
  assert.match(configSource, /focusCriticalXMaxAgeMs:.*FOCUS_CRITICAL_X_MAX_AGE_MS/);
  assert.match(configSource, /binanceCriticalXSchedulerIntervalMs:.*BINANCE_CRITICAL_X_SCHEDULER_INTERVAL_MS/);
  assert.match(configSource, /binanceCriticalXDiscoveryIntervalMs:.*BINANCE_CRITICAL_X_DISCOVERY_INTERVAL_MS/);
  assert.match(configSource, /binanceCriticalXPollAllowanceMs:.*BINANCE_CRITICAL_X_POLL_ALLOWANCE_MS/);
  assert.match(configSource, /binanceCriticalXDiscoveryTimeoutMs:.*BINANCE_CRITICAL_X_DISCOVERY_TIMEOUT_MS/);
  assert.match(configSource, /binanceCriticalXVerifyTimeoutMs:.*BINANCE_CRITICAL_X_VERIFY_TIMEOUT_MS/);
  assert.match(configSource, /binanceCriticalXLocalBudgetMs:.*BINANCE_CRITICAL_X_LOCAL_BUDGET_MS/);
  assert.match(indexSource, /if \(config\.twitterMonitorEnabled \|\| config\.binanceCriticalXMonitorEnabled \|\| config\.focusCriticalXMonitorEnabled \|\| config\.ponMonitorEnabled\) startMonitor\("twitter"/);
  assert.match(indexSource, /config\.fomoXCallEnabled/);
});

test("Robinhood RPC uses abortable transport and bounded transaction evidence reads", async () => {
  const source = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");

  assert.match(source, /createAbortableJsonRpcProvider\(config\.rpcUrl, config\.chainId/);
  assert.match(source, /robinhoodRpcReadConcurrency = Math\.max\(4, Math\.min\(8,/);
  assert.match(source, /mapWithConcurrency\(\s*hashes,\s*robinhoodRpcReadConcurrency,/);
  assert.doesNotMatch(source, /Promise\.all\(hashes\.map/);
});

test("SIGINT and SIGTERM share one graceful durability boundary", async () => {
  const source = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const shutdown = source.slice(source.indexOf("function stopNewScheduling()"));

  assert.match(shutdown, /if \(shutdownPromise\) return shutdownPromise/);
  assert.match(shutdown, /shutdownRequested = true/);
  assert.match(shutdown, /independentStartupTimers\.clear\(\)/);
  assert.match(shutdown, /for \(const wake of \[\.\.\.sleepWakeups\]\) wake\(\)/);
  assert.match(shutdown, /Promise\.allSettled\(\[/);
  assert.match(shutdown, /monitor\.stop\(\)/);
  assert.match(shutdown, /mainPromise \? \[mainPromise\] : \[\]/);
  assert.match(shutdown, /rpc\.destroy\?\.\(\)/);
  assert.match(shutdown, /runtimeHeartbeat\?\.stop\(\)/);
  assert.match(shutdown, /process\.on\("SIGINT"/);
  assert.match(shutdown, /process\.on\("SIGTERM"/);
  assert.doesNotMatch(shutdown, /process\.exit\(/);
});

test("graceful shutdown covers every independently created monitor and stops new chain ranges", async () => {
  const source = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const entries = source.slice(source.indexOf("function createdMonitorEntries()"), source.indexOf("function gracefulShutdown("));
  const expectedHandles = [
    "alertOutboxWorker",
    "githubMonitor",
    "siteMonitor",
    "earlyActivityMonitor",
    "twitterMonitor",
    "platformCapabilityMonitor",
    "flapQuoteMonitor",
    "fourRegistryMonitor",
    "ponsVersionMonitor",
    "binanceMonitor",
    "bscLaunchpadMonitor",
    "morphLaunchpadMonitor",
    "fomoCallMonitor",
    "fomoThesisMonitor",
    "fomoXCallMonitor",
    "uniswapMonitor",
    "xaiOfficialMonitor",
    "telegramNewsMonitor",
  ];

  for (const handle of expectedHandles) assert.match(entries, new RegExp(`\\b${handle}\\b`));
  assert.match(source, /fourRegistryRpcProvider/);
  assert.match(source, /ponRpcProvider \|\|= createPonReadOnlyRpcProvider\(config\.ponRpcUrls, config\.chainId,/);
  assert.match(source, /ponRpcConcurrency/);
  assert.match(source, /createPonMonitor\(config, \{ provider: ponRpcProvider,/);
  assert.match(source, /provider,\s+flapQuoteRpcProvider,\s+fourRegistryRpcProvider,\s+ponRpcProvider,/);
  assert.match(source, /const fourRegistryLogProviders = new Map\(\)/);
  assert.match(source, /const fourRegistryStateProviders = new Map\(\)/);
  assert.match(source, /fourRegistryLogProviders\.set\(sourceId, createAbortableJsonRpcProvider\(rpcUrl, 56,/);
  assert.match(source, /fourRegistryStateProviders\.set\(sourceId, createAbortableJsonRpcProvider\(rpcUrl, 56,/);
  assert.match(source, /logVerificationProviders: \[\.\.\.fourRegistryLogProviders\]/);
  assert.match(source, /stateVerificationProviders: \[\.\.\.fourRegistryStateProviders\]/);
  assert.match(source, /while \(!shutdownRequested && next <= safeHead\)/);
  assert.match(source, /if \(shutdownRequested\) return;\s+startIndependentMonitors\(\)/);
});

test("main starts a producer-owned runtime heartbeat independent of upstream polling", async () => {
  const source = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");
  const fomoSource = await fs.readFile(new URL("../src/fomo-worker.js", import.meta.url), "utf8");

  assert.match(source, /startRuntimeHeartbeat\(\{\s*file: path\.join\(config\.dataDir, "main-runtime-heartbeat\.json"\),\s*producer: "main"/);
  assert.ok(source.indexOf("runtimeHeartbeat = startRuntimeHeartbeat") < source.indexOf("mainPromise = main()"));
  assert.match(fomoSource, /startRuntimeHeartbeat\(\{\s*file: path\.join\(config\.dataDir, "fomo-runtime-heartbeat\.json"\),\s*producer: "fomo"/);
  assert.match(fomoSource, /runtimeHeartbeat\.stop\(\)/);
});

test("Docker Compose starts exactly one standalone Fomo worker beside the main monitor", async () => {
  const compose = await fs.readFile(new URL("../docker-compose.yml", import.meta.url), "utf8");
  const exampleEnv = await fs.readFile(new URL("../.env.example", import.meta.url), "utf8");
  const worker = await fs.readFile(new URL("../src/fomo-worker.js", import.meta.url), "utf8");
  const main = await fs.readFile(new URL("../src/index.js", import.meta.url), "utf8");

  assert.match(compose, /services:\s+[\s\S]*?monitor:\s+[\s\S]*?fomo-worker:/u);
  assert.equal((compose.match(/^\s{2}fomo-worker:\s*$/gmu) || []).length, 1);
  assert.match(compose, /fomo-worker:[\s\S]*?command:\s*\["node",\s*"src\/fomo-worker\.js"\]/u);
  assert.match(compose, /monitor:[\s\S]*?environment:\s+FOMO_CALL_STANDALONE:\s*"true"[\s\S]*?fomo-worker:/u);
  assert.match(compose, /fomo-worker:[\s\S]*?environment:\s+FOMO_CALL_STANDALONE:\s*"true"/u);
  assert.equal((compose.match(/^\s{6}FOMO_CALL_STANDALONE:\s*"true"\s*$/gmu) || []).length, 2,
    "both Compose processes must override a conflicting .env value with standalone topology");
  assert.equal((compose.match(/- \.\/data:\/app\/data/gu) || []).length, 2);
  assert.match(exampleEnv, /^FOMO_CALL_STANDALONE=true$/mu);
  assert.match(exampleEnv, /^KOL_LAUNCH_MONITOR_ENABLED=false$/mu);
  assert.match(worker, /config\.fomoXCallEnabled \|\| config\.kolLaunchMonitorEnabled/u);
  assert.match(main, /!config\.fomoCallStandalone\s*\n\s*&& \(config\.fomoXCallEnabled \|\| config\.kolLaunchMonitorEnabled\)/u);
});
