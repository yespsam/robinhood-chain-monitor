#!/usr/bin/env node

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  listCapitalKolScreeningCandidates,
  screenCapitalKolProfileObservation,
  screenCapitalKolCandidates,
  verifyCapitalKolScreeningUniverseIntegrity,
} from "../src/capital-kol-screening-universe.js";

const DEFAULT_LIMIT = 25;
const MAX_LIVE_BATCH = 50;
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_DELAY_MS = 250;
const MAX_BODY_BYTES = 128 * 1024;
const PRODUCTION_DATA_DIR = fileURLToPath(new URL("../data", import.meta.url));

function integerFlag(args, name, fallback, minimum, maximum) {
  const prefix = `--${name}=`;
  const raw = args.find((value) => value.startsWith(prefix))?.slice(prefix.length);
  if (raw == null) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function stringFlag(args, name) {
  const prefix = `--${name}=`;
  return args.find((value) => value.startsWith(prefix))?.slice(prefix.length) || null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function responseTextBounded(response) {
  const declaredBytes = Number(response.headers?.get?.("content-length"));
  if (declaredBytes > MAX_BODY_BYTES) {
    await response.body?.cancel?.();
    throw new Error("profile_response_too_large");
  }
  if (typeof response.body?.getReader !== "function") {
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) throw new Error("profile_response_too_large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error("profile_response_too_large");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    reader.releaseLock();
  }
}

export async function fetchCapitalKolProfileObservation(candidate, options = {}) {
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (typeof fetchImpl !== "function") throw new Error("fetch implementation is required");
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const observedAt = typeof options.observedAt === "string" ? options.observedAt : new Date().toISOString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("profile_request_timeout")), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(`https://api.fxtwitter.com/${encodeURIComponent(candidate.handle)}`, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response || response.ok !== true || response.status !== 200) {
      throw new Error(`profile_http_${Number(response?.status) || "unknown"}`);
    }
    const payload = JSON.parse(await responseTextBounded(response));
    const user = payload?.user;
    if (payload?.code !== 200 || !user || typeof user !== "object") throw new Error("profile_payload_invalid");
    return {
      handle: user.screen_name,
      id: user.id,
      subjectType: user?.verification?.type === "individual" ? "person"
        : ["business", "government"].includes(user?.verification?.type) ? "organization" : "",
      followers: user.followers,
      protected: user.protected,
      observedAt,
      source: "fxtwitter_public_profile_screening_only",
      candidateId: candidate.candidateId,
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function collectCapitalKolProfileObservations(candidates, options = {}) {
  const concurrency = Math.min(2, Math.max(1, Number.isSafeInteger(options.concurrency) ? options.concurrency : 2));
  const delayMs = Math.max(0, Number.isSafeInteger(options.delayMs) ? options.delayMs : DEFAULT_DELAY_MS);
  const observations = [];
  const errors = [];
  let cursor = 0;
  let checkpointFailure = null;
  let checkpoints = Promise.resolve();
  async function worker() {
    while (cursor < candidates.length && !checkpointFailure) {
      const index = cursor;
      cursor += 1;
      const candidate = candidates[index];
      try {
        observations.push(await fetchCapitalKolProfileObservation(candidate, options));
      } catch (error) {
        errors.push({
          candidateId: candidate.candidateId,
          handle: candidate.handle,
          checkedAt: options.observedAt || new Date().toISOString(),
          error: String(error?.message || error || "profile_screen_failed"),
        });
      }
      if (typeof options.onProgress === "function") {
        const snapshot = { observations: [...observations], errors: [...errors] };
        checkpoints = checkpoints.then(() => checkpointFailure ? undefined : options.onProgress(snapshot)).catch((error) => {
          checkpointFailure = error;
        });
        await checkpoints;
      }
      if (delayMs > 0 && cursor < candidates.length) await delay(delayMs);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (checkpointFailure) throw checkpointFailure;
  observations.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  errors.sort((left, right) => left.candidateId.localeCompare(right.candidateId));
  return { observations, errors };
}

async function writeJsonAtomic(filePath, value) {
  const resolved = path.resolve(filePath);
  const productionDataDir = path.resolve(PRODUCTION_DATA_DIR);
  const relative = path.relative(productionDataDir, resolved);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    throw new Error("screening output must not be written inside the production data directory");
  }
  await fs.mkdir(path.dirname(resolved), { recursive: true, mode: 0o700 });
  const temporary = `${resolved}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, resolved);
    const directory = await fs.open(path.dirname(resolved), "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (handle) await handle.close();
    await fs.rm(temporary, { force: true });
  }
}

async function readPreviousRun(filePath) {
  if (!filePath) return { observations: [], errors: [] };
  const resolved = path.resolve(filePath);
  const raw = await fs.readFile(resolved, "utf8");
  if (Buffer.byteLength(raw, "utf8") > 10 * 1024 * 1024) throw new Error("resume_file_too_large");
  const parsed = JSON.parse(raw);
  const observations = parsed?.profileChecks?.observations;
  if (!Array.isArray(observations)) throw new Error("resume_file_missing_observations");
  const errors = (Array.isArray(parsed?.profileChecks?.errors) ? parsed.profileChecks.errors : []).map((error) => {
    if (!error || Number.isFinite(Date.parse(error.checkedAt || ""))) return error;
    // Freeze a legacy attempt's time once. Falling back to the enclosing run's
    // observedAt on every resume makes untouched errors appear newly retried,
    // allowing other candidates to repeatedly jump ahead of them.
    if (error.checkedAtSource === "unknown") return { ...error, checkedAt: null };
    const originalRunAt = Date.parse(parsed.observedAt || "");
    return {
      ...error,
      checkedAt: Number.isFinite(originalRunAt) ? new Date(originalRunAt).toISOString() : null,
      checkedAtSource: Number.isFinite(originalRunAt) ? "legacy_run_observed_at" : "unknown",
    };
  });
  const knownIds = new Set(listCapitalKolScreeningCandidates().map((candidate) => candidate.candidateId));
  for (const rows of [observations, errors]) {
    const ids = new Set();
    for (const row of rows) {
      if (!knownIds.has(row?.candidateId)) throw new Error("resume_file_unknown_candidate");
      if (ids.has(row.candidateId)) throw new Error("resume_file_duplicate_candidate");
      ids.add(row.candidateId);
    }
  }
  return { observations, errors, observedAt: parsed.observedAt || null };
}

function mergeObservations(previous, current) {
  const byCandidate = new Map();
  for (const observation of [...previous, ...current]) {
    const candidateId = String(observation?.candidateId || "").trim();
    if (!candidateId) continue;
    byCandidate.set(candidateId, observation);
  }
  return [...byCandidate.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

function mergeErrors(previous, current, currentObservations) {
  const successful = new Set(currentObservations.map((observation) => observation.candidateId));
  const byCandidate = new Map();
  for (const error of [...previous, ...current]) {
    const candidateId = String(error?.candidateId || "").trim();
    if (!candidateId || successful.has(candidateId)) continue;
    byCandidate.set(candidateId, error);
  }
  return [...byCandidate.values()].sort((left, right) => left.candidateId.localeCompare(right.candidateId));
}

export async function runCapitalKolScreening(args = process.argv.slice(2), dependencies = {}) {
  const live = args.includes("--live");
  const json = args.includes("--json");
  const offset = integerFlag(args, "offset", 0, 0, 499);
  const requestedLimit = integerFlag(args, "limit", DEFAULT_LIMIT, 1, live ? MAX_LIVE_BATCH : 500);
  const timeoutMs = integerFlag(args, "timeout-ms", DEFAULT_TIMEOUT_MS, 250, 15_000);
  const delayMs = integerFlag(args, "delay-ms", DEFAULT_DELAY_MS, 0, 5_000);
  const outputPath = stringFlag(args, "output");
  const resumePath = stringFlag(args, "resume");
  const retryMissing = args.includes("--retry-missing");
  if (retryMissing && !resumePath) throw new Error("retry-missing requires --resume");
  const previous = await readPreviousRun(resumePath);
  const observedAt = typeof dependencies.observedAt === "string" ? dependencies.observedAt : new Date().toISOString();
  const nowMs = Date.parse(observedAt);
  if (!Number.isFinite(nowMs)) throw new Error("observedAt must be a valid timestamp");
  const previousFailures = new Map(previous.errors.map((error) => [error.candidateId, error]));
  const previousByCandidate = new Map(previous.observations.map((observation) => [observation.candidateId, observation]));
  const previousScreening = new Map(screenCapitalKolCandidates({ nowMs, profileObservations: previous.observations })
    .results.map((entry) => [entry.candidateId, entry]));
  const lastAttemptAt = (candidate) => {
    const observation = previousByCandidate.get(candidate.candidateId);
    const error = previousFailures.get(candidate.candidateId);
    return Math.max(
      Date.parse(observation?.observedAt || observation?.checkedAt || "") || 0,
      Date.parse(error?.checkedAt || "") || 0,
    );
  };
  const retryCandidates = listCapitalKolScreeningCandidates().filter((candidate) => {
    if (previousFailures.has(candidate.candidateId)) return true;
    const observation = previousByCandidate.get(candidate.candidateId);
    const screened = screenCapitalKolProfileObservation(candidate, observation, nowMs);
    return screened.disposition !== "identity_corroborated_role_review_required"
      || previousScreening.get(candidate.candidateId)?.reasons.includes("numeric_x_user_id_shared_by_handles");
  }).sort((left, right) => lastAttemptAt(left) - lastAttemptAt(right) || left.queuePosition - right.queuePosition);
  const candidates = retryMissing
    ? retryCandidates.slice(0, requestedLimit)
    : listCapitalKolScreeningCandidates({ offset, limit: requestedLimit });
  function buildResult(collected, status) {
    const accumulatedObservations = mergeObservations(previous.observations, collected.observations);
    const accumulatedErrors = mergeErrors(previous.errors, collected.errors, collected.observations);
    const report = screenCapitalKolCandidates({
      nowMs,
      profileObservations: accumulatedObservations,
      profileObservationErrors: accumulatedErrors,
    });
    return {
      schema: "capital_kol_screening_run_v1",
      mode: live ? "live_profile_screening" : "offline_manifest",
      status,
      observedAt,
      batch: {
        offset: retryMissing ? null : offset,
        limit: candidates.length,
        retryMissing,
        ...(retryMissing ? { retryQueueSize: retryCandidates.length, retryOrder: "oldest_attempt_first" } : {
          nextOffset: offset + candidates.length < 500 ? offset + candidates.length : null,
        }),
        handles: candidates.map((candidate) => candidate.handle),
      },
      profileChecks: {
        requested: live ? candidates.length : 0,
        succeeded: collected.observations.length,
        failed: collected.errors.length,
        accumulated: accumulatedObservations.length,
        remainingInBatch: live ? candidates.length - collected.observations.length - collected.errors.length : 0,
        observations: accumulatedObservations,
        errors: accumulatedErrors,
      },
      report,
      safety: {
        automaticPromotion: false,
        candidateMonitoringEligible: false,
        alertsSent: 0,
        ordersCreated: 0,
      },
    };
  }
  // Persist each completed request, so interrupting a long batch leaves a
  // resumable report. Validate/write the destination before making requests.
  if (outputPath && live) await writeJsonAtomic(outputPath, buildResult({ observations: [], errors: [] }, "running"));
  const collected = live
    ? await collectCapitalKolProfileObservations(candidates, {
      fetchImpl: dependencies.fetchImpl,
      timeoutMs,
      delayMs,
      concurrency: 2,
      observedAt,
      ...(outputPath ? { onProgress: (progress) => writeJsonAtomic(outputPath, buildResult(progress, "running")) } : {}),
    })
    : { observations: [], errors: [] };
  const result = buildResult(collected, "complete");
  if (outputPath) await writeJsonAtomic(outputPath, result);
  const writeOutput = dependencies.writeOutput || ((text) => process.stdout.write(text));
  if (json) writeOutput(`${JSON.stringify(result)}\n`);
  else writeOutput(`${JSON.stringify({
    mode: result.mode,
    universe: result.report.counts,
    progress: result.report.progress,
    batch: result.batch,
    profileChecks: {
      requested: result.profileChecks.requested,
      succeeded: result.profileChecks.succeeded,
      failed: result.profileChecks.failed,
      accumulated: result.profileChecks.accumulated,
      errors: result.profileChecks.errors,
    },
    safety: result.safety,
  }, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const integrity = verifyCapitalKolScreeningUniverseIntegrity();
  if (!integrity.valid) {
    process.stderr.write(`${JSON.stringify(integrity)}\n`);
    process.exitCode = 1;
  } else {
    runCapitalKolScreening().catch((error) => {
      process.stderr.write(`[capital-kol-screen] ${String(error?.stack || error)}\n`);
      process.exitCode = 1;
    });
  }
}
