import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const dataDir = path.resolve(process.env.DATA_DIR || "/var/lib/robinhood-chain-monitor");
const configDir = "/etc/robinhood-chain-monitor";

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function booleanSetting(name, fallback) {
  const raw = String(process.env[name] ?? fallback).trim().toLowerCase();
  if (["true", "1", "yes"].includes(raw)) return true;
  if (["false", "0", "no"].includes(raw)) return false;
  throw new Error(`${name} must be true or false`);
}

const limits = {
  robinhoodAgeSeconds: positiveInteger("HEALTH_ROBINHOOD_MAX_AGE_SECONDS", 180),
  bscAgeSeconds: positiveInteger("HEALTH_BSC_MAX_AGE_SECONDS", 180),
  githubAgeSeconds: positiveInteger("HEALTH_GITHUB_MAX_AGE_SECONDS", 180),
  platformCapabilityAgeSeconds: positiveInteger("HEALTH_PLATFORM_CAPABILITY_MAX_AGE_SECONDS", 180),
  fomoStateAgeSeconds: positiveInteger("HEALTH_FOMO_STATE_MAX_AGE_SECONDS", 180),
  fomoCheckpointAgeSeconds: positiveInteger("HEALTH_FOMO_CHECKPOINT_MAX_AGE_SECONDS", 900),
  fomoXAgeSeconds: positiveInteger("HEALTH_FOMO_X_MAX_AGE_SECONDS", 180),
  fomoThesisAgeSeconds: positiveInteger("HEALTH_FOMO_THESIS_MAX_AGE_SECONDS", 180),
  outboxPendingAgeSeconds: positiveInteger("HEALTH_OUTBOX_MAX_PENDING_AGE_SECONDS", 60),
  heartbeatTimeoutMs: positiveInteger("HEALTH_HEARTBEAT_TIMEOUT_MS", 5_000),
};

const requirements = {
  fomoState: booleanSetting("HEALTH_REQUIRE_FOMO_STATE", true),
  fomoCheckpoint: booleanSetting("HEALTH_REQUIRE_FOMO_CHECKPOINT", true),
  fomoX: booleanSetting("HEALTH_REQUIRE_FOMO_X", true),
  fomoThesis: booleanSetting("HEALTH_REQUIRE_FOMO_THESIS", true),
  externalHeartbeat: booleanSetting("HEALTH_REQUIRE_EXTERNAL_HEARTBEAT", true),
};

async function readTrimmed(filename) {
  try {
    return (await fs.readFile(filename, "utf8")).trim();
  } catch {
    return null;
  }
}

async function serviceState(unit) {
  try {
    const { stdout } = await execFileAsync("/usr/bin/systemctl", ["is-active", unit], {
      timeout: 5_000,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch (error) {
    return String(error?.stdout || "unknown").trim() || "unknown";
  }
}

async function fileAgeSeconds(filename, nowMs) {
  try {
    const stat = await fs.stat(filename);
    if (!stat.isFile()) return null;
    return Math.max(0, Math.floor((nowMs - stat.mtimeMs) / 1_000));
  } catch {
    return null;
  }
}

async function inspectLane({ id, files, maxAgeSeconds, required = true }, nowMs) {
  const observations = await Promise.all(files.map(async (file) => ({
    file,
    ageSeconds: await fileAgeSeconds(path.join(dataDir, file), nowMs),
  })));
  const present = observations.filter(({ ageSeconds }) => ageSeconds !== null);
  present.sort((left, right) => left.ageSeconds - right.ageSeconds);
  const authoritative = present[0] || null;
  const fresh = Boolean(authoritative && authoritative.ageSeconds <= maxAgeSeconds);
  return {
    id,
    required,
    healthy: !required || fresh,
    maxAgeSeconds,
    authoritative,
    observations,
    reason: !required ? "not_required" : !authoritative ? "missing" : fresh ? "fresh" : "stale",
  };
}

async function inspectOutbox(relativeFilename, nowMs) {
  const filename = path.join(dataDir, relativeFilename);
  try {
    const parsed = JSON.parse(await fs.readFile(filename, "utf8"));
    const events = Object.values(parsed?.events || {});
    const counts = {};
    let oldestPendingAgeSeconds = null;
    for (const entry of events) {
      const status = String(entry?.status || "unknown");
      counts[status] = (counts[status] || 0) + 1;
      if (!["delivered", "suppressed", "failed"].includes(status)) {
        const timestamp = Date.parse(entry?.createdAt || entry?.updatedAt || "");
        if (Number.isFinite(timestamp)) {
          const age = Math.max(0, Math.floor((nowMs - timestamp) / 1_000));
          oldestPendingAgeSeconds = Math.max(oldestPendingAgeSeconds ?? 0, age);
        }
      }
    }
    return { file: relativeFilename, counts, oldestPendingAgeSeconds, parseError: null };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { file: relativeFilename, counts: {}, oldestPendingAgeSeconds: null, parseError: null };
    }
    return { file: relativeFilename, counts: {}, oldestPendingAgeSeconds: null, parseError: error.message };
  }
}

async function deliverHeartbeat(rawUrl) {
  const result = {
    required: requirements.externalHeartbeat,
    configured: Boolean(rawUrl),
    delivered: false,
    status: null,
    error: null,
  };
  if (!rawUrl) {
    result.error = requirements.externalHeartbeat ? "not_configured" : null;
    return result;
  }
  let url;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== "https:" || url.username || url.password) throw new Error("invalid");
  } catch {
    result.error = "invalid_https_url";
    return result;
  }
  try {
    const response = await fetch(url, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(limits.heartbeatTimeoutMs),
      headers: { "user-agent": "robinhood-monitor-health/1" },
    });
    result.status = response.status;
    result.delivered = response.ok;
    if (!response.ok) result.error = "non_success_status";
  } catch (error) {
    result.error = `request_failed:${error?.name || "Error"}`;
  }
  return result;
}

async function writeReport(report) {
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  const destination = path.join(dataDir, "health.json");
  const temporary = path.join(dataDir, `.health.json.${process.pid}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temporary, destination);
}

const checkedAt = new Date();
const nowMs = checkedAt.getTime();
const laneDefinitions = [
  { id: "robinhood", files: ["state.json"], maxAgeSeconds: limits.robinhoodAgeSeconds },
  {
    id: "bsc",
    files: ["bsc-launchpad-state.json.wal", "bsc-launchpad-state.json"],
    maxAgeSeconds: limits.bscAgeSeconds,
  },
  { id: "github", files: ["github-state.json"], maxAgeSeconds: limits.githubAgeSeconds },
  {
    id: "platformCapability",
    files: ["platform-capability-state.json"],
    maxAgeSeconds: limits.platformCapabilityAgeSeconds,
  },
  {
    id: "fomoState",
    files: ["fomo-call-state.json"],
    maxAgeSeconds: limits.fomoStateAgeSeconds,
    required: requirements.fomoState,
  },
  {
    id: "fomoCheckpoint",
    files: ["fomo-call-checkpoint.json"],
    maxAgeSeconds: limits.fomoCheckpointAgeSeconds,
    required: requirements.fomoCheckpoint,
  },
  {
    id: "fomoX",
    files: ["fomo-x-call-state.json"],
    maxAgeSeconds: limits.fomoXAgeSeconds,
    required: requirements.fomoX,
  },
  {
    id: "fomoThesis",
    files: ["fomo-thesis-state.json"],
    maxAgeSeconds: limits.fomoThesisAgeSeconds,
    required: requirements.fomoThesis,
  },
];

const [nodeId, activeId, mainService, fomoService, laneResults, mainOutbox, fomoOutbox] = await Promise.all([
  readTrimmed(path.join(configDir, "node-id")),
  readTrimmed(path.join(configDir, "ACTIVE")),
  serviceState("robinhood-monitor.service"),
  serviceState("robinhood-fomo.service"),
  Promise.all(laneDefinitions.map((definition) => inspectLane(definition, nowMs))),
  inspectOutbox("alert-outbox.json", nowMs),
  inspectOutbox("fomo-alerts/alert-outbox.json", nowMs),
]);

const lanes = Object.fromEntries(laneResults.map((lane) => [lane.id, lane]));
const failures = [];
if (!nodeId || activeId !== nodeId) failures.push("local ACTIVE marker does not match this node");
if (mainService !== "active") failures.push(`robinhood-monitor.service is ${mainService}`);
if (fomoService !== "active") failures.push(`robinhood-fomo.service is ${fomoService}`);
for (const lane of laneResults) {
  if (!lane.healthy) failures.push(`${lane.id} lane is ${lane.reason} (limit ${lane.maxAgeSeconds}s)`);
}
for (const outbox of [mainOutbox, fomoOutbox]) {
  if (outbox.parseError) failures.push(`${outbox.file} cannot be parsed`);
  if ((outbox.counts.failed || 0) > 0) failures.push(`${outbox.file} contains failed deliveries`);
  if ((outbox.oldestPendingAgeSeconds ?? 0) > limits.outboxPendingAgeSeconds) {
    failures.push(`${outbox.file} has a delivery pending for more than ${limits.outboxPendingAgeSeconds}s`);
  }
}

let heartbeat;
const heartbeatUrl = String(process.env.HEALTH_HEARTBEAT_URL || "").trim();
if (failures.length > 0 && heartbeatUrl) {
  heartbeat = {
    required: requirements.externalHeartbeat,
    configured: true,
    delivered: false,
    status: null,
    error: "skipped_local_unhealthy",
  };
} else {
  heartbeat = await deliverHeartbeat(heartbeatUrl);
}
if (requirements.externalHeartbeat && !heartbeat.delivered) {
  failures.push(`external heartbeat is ${heartbeat.error || "not_delivered"}`);
}

const report = {
  version: 2,
  healthy: failures.length === 0,
  checkedAt: checkedAt.toISOString(),
  node: { nodeId, activeId, activeMarkerMatches: Boolean(nodeId && nodeId === activeId) },
  services: { main: mainService, fomo: fomoService },
  lanes,
  outboxes: { main: mainOutbox, fomo: fomoOutbox },
  heartbeat,
  limits,
  requirements,
  failures,
};

await writeReport(report);
console.log(JSON.stringify(report));
if (!report.healthy) process.exitCode = 1;
