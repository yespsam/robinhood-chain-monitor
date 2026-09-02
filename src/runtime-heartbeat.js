import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const RUNTIME_HEARTBEAT_INTERVAL_MS = 30_000;
export const RUNTIME_HEARTBEAT_VERSION = 1;

async function fsyncDirectory(directory, fsImpl) {
  let handle = null;
  try {
    handle = await fsImpl.open(directory, "r");
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

export async function atomicWriteRuntimeHeartbeat(file, value, fsImpl = fs) {
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${Date.now()}.${randomBytes(6).toString("hex")}.tmp`;
  let handle = null;
  let renamed = false;
  let failure = null;

  try {
    handle = await fsImpl.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.rename(temporary, file);
    renamed = true;
    await fsImpl.chmod(file, 0o600);
    await fsyncDirectory(directory, fsImpl);
  } catch (error) {
    failure = error;
  } finally {
    try {
      await handle?.close();
    } catch (closeError) {
      failure = failure
        ? new AggregateError([failure, closeError], "runtime heartbeat write failed and its temporary handle did not close cleanly")
        : closeError;
    }
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
  }

  if (failure) {
    failure.atomicRenameCompleted = renamed;
    throw failure;
  }
}

function epochMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new Error("runtime heartbeat clock returned an invalid timestamp");
  return milliseconds;
}

function compactError(error) {
  return String(error?.message || error || "unknown error").slice(0, 300);
}

export function startRuntimeHeartbeat({
  file,
  producer,
  intervalMs = RUNTIME_HEARTBEAT_INTERVAL_MS,
  fsImpl = fs,
  atomicWriteImpl = atomicWriteRuntimeHeartbeat,
  now = Date.now,
  processRef = process,
  logger = console,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
} = {}) {
  const heartbeatFile = String(file || "");
  const heartbeatProducer = String(producer || "");
  const heartbeatIntervalMs = Number(intervalMs);
  if (!heartbeatFile) throw new Error("runtime heartbeat file is required");
  if (!/^[a-z][a-z0-9_-]*$/i.test(heartbeatProducer)) throw new Error("runtime heartbeat producer is invalid");
  if (!Number.isFinite(heartbeatIntervalMs) || heartbeatIntervalMs <= 0) {
    throw new Error("runtime heartbeat intervalMs must be positive");
  }

  const startedAtMs = epochMilliseconds(now);
  const startedAt = new Date(startedAtMs).toISOString();
  const pid = Number(processRef?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("runtime heartbeat process pid is invalid");

  let sequence = 0;
  let requested = false;
  let stopped = false;
  let activeWrite = null;
  let stopPromise = null;

  const reportFailure = (error) => {
    try {
      logger.error?.(`[runtime-heartbeat:${heartbeatProducer}] ${compactError(error)}`);
    } catch {}
  };

  const pulse = () => {
    if (stopped) return Promise.resolve(false);
    requested = true;
    if (activeWrite) return activeWrite;

    const operation = (async () => {
      let wrote = false;
      while (requested && !stopped) {
        requested = false;
        sequence += 1;
        const updatedAtMs = epochMilliseconds(now);
        await atomicWriteImpl(heartbeatFile, {
          version: RUNTIME_HEARTBEAT_VERSION,
          producer: heartbeatProducer,
          pid,
          startedAt,
          updatedAt: new Date(updatedAtMs).toISOString(),
          sequence,
        }, fsImpl);
        wrote = true;
      }
      return wrote;
    })();
    activeWrite = operation.finally(() => {
      activeWrite = null;
    });
    return activeWrite;
  };

  const ready = pulse();
  void ready.catch(reportFailure);
  const timer = setIntervalImpl(() => {
    void pulse().catch(reportFailure);
  }, Math.floor(heartbeatIntervalMs));
  timer?.unref?.();

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopped = true;
    requested = false;
    clearIntervalImpl(timer);
    stopPromise = activeWrite ? activeWrite.then(() => undefined) : Promise.resolve();
    return stopPromise;
  };

  return {
    file: heartbeatFile,
    producer: heartbeatProducer,
    intervalMs: Math.floor(heartbeatIntervalMs),
    ready,
    pulse,
    stop,
  };
}
