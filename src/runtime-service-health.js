import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function parseLaunchdService(output) {
  const state = /^\s*state = ([\w -]+)\s*$/m.exec(output)?.[1]?.trim();
  const pid = Number(/^\s*pid = (\d+)\s*$/m.exec(output)?.[1]);
  return {
    state: state === "running" && Number.isSafeInteger(pid) && pid > 1 ? "active" : "inactive",
    pid: Number.isSafeInteger(pid) && pid > 1 ? pid : null,
  };
}

export function evaluateRuntimeHeartbeat({ heartbeat, producer, pid, nowMs, maxAgeSeconds = 120 }) {
  const reasons = [];
  const updatedAtMs = Date.parse(heartbeat?.updatedAt);
  const startedAtMs = Date.parse(heartbeat?.startedAt);
  if (!heartbeat || heartbeat.version !== 1 || heartbeat.producer !== producer
      || !Number.isSafeInteger(heartbeat.sequence) || heartbeat.sequence < 1) {
    reasons.push("heartbeat_invalid");
  }
  if (!Number.isSafeInteger(pid) || pid <= 1 || heartbeat?.pid !== pid) reasons.push("heartbeat_pid_mismatch");
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(startedAtMs)
      || startedAtMs > updatedAtMs || updatedAtMs > nowMs + 5_000) {
    reasons.push("heartbeat_timestamp_invalid");
  } else if (nowMs - updatedAtMs > maxAgeSeconds * 1_000) {
    reasons.push("heartbeat_stale");
  }
  return {
    healthy: reasons.length === 0,
    reasons,
    pid: heartbeat?.pid ?? null,
    updatedAt: heartbeat?.updatedAt ?? null,
    ageSeconds: Number.isFinite(updatedAtMs) ? Math.max(0, Math.floor((nowMs - updatedAtMs) / 1_000)) : null,
    sequence: heartbeat?.sequence ?? null,
  };
}

export async function readLaunchdService({ label, producer, dataDir, uid = process.getuid?.(),
  nowMs = Date.now(), maxAgeSeconds = 120, execImpl = execFileAsync, readFileImpl = fs.readFile }) {
  if (!Number.isSafeInteger(uid) || uid < 0) throw new Error("launchd health requires a valid user ID");
  if (!/^com\.qohfq\.[a-z0-9-]+$/.test(label)) throw new Error("invalid monitor LaunchAgent label");
  if (!["main", "fomo"].includes(producer)) throw new Error("invalid runtime heartbeat producer");
  const [serviceResult, heartbeatResult] = await Promise.allSettled([
    execImpl("/bin/launchctl", ["print", `gui/${uid}/${label}`], { timeout: 5_000, maxBuffer: 128 * 1024, encoding: "utf8" }),
    readFileImpl(path.join(dataDir, `${producer}-runtime-heartbeat.json`), "utf8"),
  ]);
  const service = serviceResult.status === "fulfilled"
    ? parseLaunchdService(serviceResult.value.stdout) : { state: "unknown", pid: null };
  let heartbeat = null;
  if (heartbeatResult.status === "fulfilled") {
    try { heartbeat = JSON.parse(heartbeatResult.value); } catch {}
  }
  const runtime = evaluateRuntimeHeartbeat({ heartbeat, producer, pid: service.pid, nowMs, maxAgeSeconds });
  return { label, ...service, heartbeat: runtime };
}
