import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createBscWorkerMailbox, BSC_WORKER_COMMANDS } from "./bsc-worker-mailbox.js";

// The main monitor supervises one scanner child. IPC carries alert requests,
// not credentials/configuration; the existing main-process TG/narrative path
// still owns delivery and acknowledgements. Inbound feature/discovery records
// go through a durable inbox, not a fire-and-forget IPC message.
export function createBscWorkerClient(config, {
  sendAlertsImpl, onLaunchpadCandidate, logger = console,
  workerFile = fileURLToPath(new URL("./bsc-scan-worker.js", import.meta.url)),
  forkImpl = fork, commandTimeoutMs = 60_000, restartDelayMs = 1_000,
} = {}) {
  if (!config.bscSharedRpcEnabled) throw new Error("BSC worker requires shared RPC coordination");
  const mailbox = createBscWorkerMailbox(config.dataDir);
  let child = null;
  let stopped = false;
  let restartTimer = null;
  let exitPromise = null;
  let stopPromise = null;
  let failures = 0;
  const waiting = new Map();
  const callbacks = new Set();
  const reply = (target, response) => {
    try { if (target.connected) target.send(response, () => {}); } catch {}
  };
  function start() {
    if (stopped || child) return;
    const target = forkImpl(workerFile, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"], serialization: "advanced",
      env: { ...process.env, DATA_DIR: config.dataDir },
    });
    child = target;
    const started = Date.now();
    logger.info(`[bsc-worker] spawned pid=${target.pid}`);
    target.on("message", (message) => {
      if (message?.kind !== "callback" || !["alert", "candidate"].includes(message.method)) return;
      const work = (async () => {
        try {
          if (callbacks.size >= 32) throw new Error("BSC callback queue full; retry required");
          const result = message.method === "alert"
            ? await sendAlertsImpl(config, message.event)
            : await onLaunchpadCandidate?.(message.event);
          reply(target, { kind: "callback-result", id: message.id, result });
        } catch (error) {
          reply(target, { kind: "callback-result", id: message.id,
            error: { message: error.message, name: error.name, code: error.code, retryAfterMs: error.retryAfterMs,
              alertDeliveryTiming: error.alertDeliveryTiming, eventType: error.eventType, destinations: error.destinations, failures: error.failures } });
        }
      })();
      callbacks.add(work);
      void work.finally(() => callbacks.delete(work));
    });
    target.on("error", (error) => logger.error(`[bsc-worker] child error: ${error.message}`));
    exitPromise = new Promise((resolve) => target.once("exit", (code, signal) => {
      child = null;
      logger.info(`[bsc-worker] exited code=${code} signal=${signal || "none"}`);
      resolve();
      if (stopped) return;
      failures = Date.now() - started >= 60_000 ? 0 : failures + 1;
      restartTimer = setTimeout(start, Math.min(30_000, restartDelayMs * 2 ** Math.min(failures, 5)));
    }));
  }
  async function awaitCommand(id) {
    const deadline = Date.now() + commandTimeoutMs;
    while (!stopped && Date.now() < deadline) {
      const row = mailbox.get(id);
      if (row?.status === "done") {
        const result = JSON.parse(row.result);
        mailbox.acknowledge(id);
        return result;
      }
      if (row?.error) throw new Error(`BSC command retained for retry: ${row.error}`);
      await delay(100);
    }
    throw new Error("BSC command remains durable; worker acknowledgement pending");
  }
  const client = {
    start,
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (restartTimer) clearTimeout(restartTimer);
      stopPromise = (async () => {
        // Keep IPC callbacks alive until the scanner drains its original WAL.
        child?.kill("SIGTERM");
        await exitPromise;
        await Promise.allSettled([...waiting.values(), ...callbacks]);
        mailbox.close();
      })();
      return stopPromise;
    },
    getStatus: () => ({ pid: child?.pid || null, stopped, inbox: mailbox.summary() }),
  };
  for (const method of BSC_WORKER_COMMANDS) client[method] = (...args) => {
    if (stopped) return Promise.reject(new Error("BSC worker stopping"));
    let id;
    try { id = mailbox.enqueue(method, args); } catch (error) { return Promise.reject(error); }
    if (!waiting.has(id)) {
      const work = awaitCommand(id).finally(() => waiting.delete(id));
      waiting.set(id, work);
    }
    return waiting.get(id);
  };
  start();
  return client;
}
