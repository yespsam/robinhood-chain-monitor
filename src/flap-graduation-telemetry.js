// Watch flap tokens and record bonding-curve progress the same way the entry
// gate reads it (curveProgressSnapshot). Dry-run needs no key, RPC, or .env.
// Outcomes are graduated, timeout, or still watching. Unknown progress is
// stored as null. This module does not sign or broadcast.
import fs from "node:fs/promises";
import path from "node:path";
import { curveProgressSnapshot } from "./curve-progress-entry.js";

export const FLAP_GRADUATION_SCHEMA = "flap_graduation_telemetry_v1";
export const DEFAULT_TELEMETRY_FILE = path.join("data", "flap-graduation-telemetry.jsonl");
const MAX_SAMPLES = 240;

function atMs(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function progressSample(token = {}, event = null, at) {
  const snap = curveProgressSnapshot(token, event);
  return { at, bondingCurveProgress: snap.bondingCurveProgress, bondingCurveProgressStatus: snap.bondingCurveProgressStatus };
}

export function isGraduated(token = {}) {
  if (token.marketStage === "external" || token.marketCategory === "completed") return true;
  if (token.graduated === true) return true;
  if (token.launchpadStatus === 1 || token.launchpadStatus === "1") return true;
  const progress = curveProgressSnapshot(token).bondingCurveProgress;
  return progress !== null && progress >= 1;
}

function tokenKey(token) {
  const chain = String(token?.chain || "unknown");
  const address = String(token?.address || "");
  return `${chain}:${address}`;
}

export function applyObservation(record, token, nowMs, { timeoutMs = 30 * 60_000 } = {}) {
  const createdMs = atMs(record?.createdAt) ?? atMs(token?.creationTimestamp ?? token?.createdAt);
  const firstSeenMs = atMs(record?.firstSeenAt) ?? nowMs;
  const sample = progressSample(token, null, new Date(nowMs).toISOString());
  const samples = [...(record?.samples || []), sample].slice(-MAX_SAMPLES);
  let outcome = "watching";
  let outcomeAt = null;
  if (record?.outcome === "graduated" || isGraduated(token)) {
    outcome = "graduated";
    outcomeAt = record?.outcome === "graduated" ? record.outcomeAt : new Date(nowMs).toISOString();
  } else {
    const anchor = createdMs ?? firstSeenMs;
    if (Number.isFinite(anchor) && nowMs - anchor >= timeoutMs) {
      outcome = "timeout";
      outcomeAt = new Date(nowMs).toISOString();
    }
  }
  return {
    schema: FLAP_GRADUATION_SCHEMA,
    key: tokenKey(token),
    chain: token?.chain ?? null,
    address: token?.address ?? null,
    symbol: typeof token?.symbol === "string" ? token.symbol : null,
    firstSeenAt: new Date(firstSeenMs).toISOString(),
    createdAt: createdMs === null ? null : new Date(createdMs).toISOString(),
    bondingCurveProgress: sample.bondingCurveProgress,
    bondingCurveProgressStatus: sample.bondingCurveProgressStatus,
    samples,
    outcome,
    outcomeAt,
  };
}

export function pollOnce({ tokens = [], records = [], nowMs = Date.now(), timeoutMs = 30 * 60_000 } = {}) {
  const byKey = new Map(records.map((row) => [row.key, row]));
  const updated = [];
  for (const token of tokens) {
    if (!token || typeof token !== "object" || !token.address) continue;
    const key = tokenKey(token);
    const next = applyObservation(byKey.get(key) || null, token, nowMs, { timeoutMs });
    byKey.set(key, next);
    updated.push(next);
  }
  return { records: [...byKey.values()], updated };
}

export function parseTelemetryLines(text) {
  const byKey = new Map();
  let skipped = 0;
  for (const line of String(text || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const row = JSON.parse(trimmed);
      if (row?.schema !== FLAP_GRADUATION_SCHEMA || typeof row.key !== "string") { skipped += 1; continue; }
      byKey.set(row.key, row);
    } catch { skipped += 1; }
  }
  return { records: [...byKey.values()], skipped };
}

export async function readTelemetry(file) {
  try {
    return parseTelemetryLines(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return { records: [], skipped: 0 };
    throw error;
  }
}

export async function appendTelemetry(file, rows) {
  if (!rows?.length) return;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const body = `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  await fs.appendFile(file, body, { encoding: "utf8", mode: 0o600 });
}

export async function runPollLoop({
  listTokens,
  file = DEFAULT_TELEMETRY_FILE,
  intervalMs = 15_000,
  timeoutMs = 30 * 60_000,
  maxPolls = 1,
  dryRun = false,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  write = appendTelemetry,
} = {}) {
  if (typeof listTokens !== "function") throw new TypeError("listTokens required");
  if (!Number.isInteger(maxPolls) || maxPolls < 1) throw new TypeError("maxPolls");
  let records = [];
  if (!dryRun) records = (await readTelemetry(file)).records;
  const appended = [];
  for (let i = 0; i < maxPolls; i += 1) {
    const nowMs = now();
    const tokens = await listTokens({ nowMs, poll: i });
    const result = pollOnce({ tokens, records, nowMs, timeoutMs });
    records = result.records;
    appended.push(...result.updated);
    if (!dryRun) await write(file, result.updated);
    if (i + 1 < maxPolls) await sleep(intervalMs);
  }
  return { records, appended, dryRun, file: dryRun ? null : file };
}
