import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { config } from "./config.js";
import { createGiwaMonitor } from "./giwa-monitor.js";
import { sendAlerts, startAlertOutboxWorker } from "./alerts.js";
import { startRuntimeHeartbeat } from "./runtime-heartbeat.js";

const once = process.argv.includes("--once");
const noSend = process.argv.includes("--no-send");
if (noSend && !once) throw new Error("--no-send requires --once (isolated diagnostic)");
if (!noSend && (!config.telegramToken || !config.telegramChatId)) throw new Error("GIWA monitoring requires the existing Telegram destination");
// Dry runs never advance production baselines or claim production delivery.
const dataDir = noSend
  ? await fs.mkdtemp(path.join(os.tmpdir(), "giwa-monitor-check-"))
  : path.join(config.dataDir, "giwa-monitor");
const workerConfig = { ...config, dataDir, giwaMonitorEnabled: true,
  alertBilingualEnabled: false, alertChineseTranslationEnabled: false, webhookUrl: "" };
let guard;
if (!noSend) {
  // Kernel-owned singleton: no stale PID files after SIGKILL or a reboot.
  // This loopback socket serves no API and immediately closes connections.
  guard = net.createServer((socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    guard.once("error", reject);
    guard.listen({ host: "127.0.0.1", port: 19134, exclusive: true }, resolve);
  });
}
const outbox = noSend ? null : startAlertOutboxWorker(workerConfig);
const heartbeat = noSend ? null : startRuntimeHeartbeat({
  file: path.join(dataDir, "runtime-heartbeat.json"), producer: "giwa-monitor",
});
const monitor = await createGiwaMonitor({ dataDir,
  sendAlert: noSend ? null : (event) => sendAlerts(workerConfig, event),
});
let timer;
let stopping = false;
let stopPromise;
const stop = () => stopPromise ||= (async () => {
  stopping = true;
  clearTimeout(timer);
  try { await monitor.stop(); }
  finally {
    await Promise.allSettled([outbox?.stop(), heartbeat?.stop()]);
    guard?.close();
  }
})();
process.once("SIGTERM", () => { void stop(); });
process.once("SIGINT", () => { void stop(); });
async function tick() {
  try {
    const state = await monitor.check();
    console.info(JSON.stringify({ at: state.updatedAt, producer: "giwa-monitor", healthySources: state.coverage.healthySources,
      registeredSources: state.coverage.registeredSources, pending: state.pending.length,
      testnetHealth: state.testnet?.status, mainnet: state.coverage.network.mainnetStatus,
      ...(noSend ? { diagnosticDataDir: dataDir } : {}) }));
  } catch (error) {
    console.error(`[giwa-monitor] ${String(error.message).slice(0, 200)}`);
    if (once) process.exitCode = 1;
  }
  if (once) await stop();
  else if (!stopping) timer = setTimeout(() => { void tick(); }, 30_000);
}
await heartbeat?.ready;
await tick();
