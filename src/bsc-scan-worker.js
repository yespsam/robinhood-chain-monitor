import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { config } from "./config.js";
import { createBscLaunchpadMonitor } from "./bsc-launchpad-monitor.js";
import { createBscWorkerMailbox } from "./bsc-worker-mailbox.js";
import { startRuntimeHeartbeat } from "./runtime-heartbeat.js";

if (!process.send || !process.connected) throw new Error("BSC scan worker requires its supervising monitor");
if (!config.bscSharedRpcEnabled) throw new Error("BSC scan worker requires shared RPC coordination");
const mailbox = createBscWorkerMailbox(config.dataDir);
const pending = new Map();
let stopped = false;
let shutdown = null;
let monitor = null;
let heartbeat = null;
function parentCall(method, event) {
  if (!process.connected) return Promise.reject(new Error("BSC monitor parent disconnected"));
  if (pending.size >= 32) return Promise.reject(new Error("BSC parent callback capacity exhausted"));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("BSC parent callback timeout; delivery not acknowledged")); }, 120_000);
    pending.set(id, { resolve, reject, timer });
    process.send({ kind: "callback", id, method, event }, (error) => {
      if (!error) return;
      const entry = pending.get(id);
      if (entry) { clearTimeout(entry.timer); pending.delete(id); entry.reject(error); }
    });
  });
}
process.on("message", (message) => {
  if (message?.kind !== "callback-result") return;
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id); clearTimeout(entry.timer);
  if (message.error) entry.reject(Object.assign(new Error(message.error.message), message.error));
  else entry.resolve(message.result);
});

async function run() {
  // Prevent a launchd parent restart from overlapping an old draining child.
  while (!stopped && !mailbox.claimOwner()) await delay(500);
  if (stopped) return;
  heartbeat = startRuntimeHeartbeat({ file: path.join(config.dataDir, "bsc-runtime-heartbeat.json"), producer: "bsc" });
  monitor = createBscLaunchpadMonitor(config, {
    sendAlertsImpl: (_config, event) => parentCall("alert", event),
    onLaunchpadCandidate: (event) => parentCall("candidate", event),
  });
  while (!stopped) {
    try {
      const command = mailbox.next();
      if (command) {
        try {
          const result = await monitor[command.method](...JSON.parse(command.args));
          mailbox.complete(command.id, result);
        } catch (error) { mailbox.retry(command.id, error); }
      }
    } catch (error) { console.error(`[bsc-worker-inbox] ${error.message}`); }
    await delay(200);
  }
}
const running = run();
function stop() {
  if (shutdown) return shutdown;
  stopped = true;
  shutdown = (async () => {
    try {
      await monitor?.stop();
      await running;
      await heartbeat?.stop();
      mailbox.releaseOwner();
      mailbox.close();
      if (process.connected) process.disconnect();
    } catch (error) {
      console.error(`[bsc-worker-stop] ${error.message}`);
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    }
  })();
  return shutdown;
}
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
process.on("disconnect", () => {
  for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error("BSC parent disconnected; delivery unacknowledged")); }
  pending.clear();
  void stop();
});
void running.catch((error) => { console.error(`[bsc-worker-fatal] ${error.message}`); process.exitCode = 1; void stop(); });
