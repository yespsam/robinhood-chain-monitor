import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  collectCapitalKolProfileObservations,
  fetchCapitalKolProfileObservation,
  runCapitalKolScreening,
} from "../scripts/capital-kol-screen.js";
import { listCapitalKolScreeningCandidates } from "../src/capital-kol-screening-universe.js";

function response(payload, status = 200) {
  return {
    ok: status === 200,
    status,
    text: async () => JSON.stringify(payload),
  };
}

test("profile screening validates the public observation but grants no admission", async () => {
  const [candidate] = listCapitalKolScreeningCandidates({ offset: 30, limit: 1 });
  let request;
  const observation = await fetchCapitalKolProfileObservation(candidate, {
    observedAt: "2026-09-06T18:45:00.000Z",
    fetchImpl: async (url, options) => {
      request = { url, options };
      return response({
        code: 200,
        user: {
          screen_name: candidate.handle,
          id: "123456789",
          followers: 9_999_999,
          protected: false,
          verification: { type: "individual" },
        },
      });
    },
  });
  assert.equal(request.url, `https://api.fxtwitter.com/${encodeURIComponent(candidate.handle)}`);
  assert.equal(request.options.redirect, "error");
  assert.equal(request.options.method, "GET");
  assert.ok(request.options.signal instanceof AbortSignal);
  assert.deepEqual(observation, {
    handle: candidate.handle,
    id: "123456789",
    subjectType: "person",
    followers: 9_999_999,
    protected: false,
    observedAt: "2026-09-06T18:45:00.000Z",
    source: "fxtwitter_public_profile_screening_only",
    candidateId: candidate.candidateId,
  });
  assert.equal(Object.hasOwn(observation, "monitorEligible"), false);
});

test("bounded collector never retries failed profiles and keeps successful observations", async () => {
  const candidates = listCapitalKolScreeningCandidates({ offset: 30, limit: 3 });
  const calls = new Map();
  const result = await collectCapitalKolProfileObservations(candidates, {
    delayMs: 0,
    observedAt: "2026-09-06T18:45:00.000Z",
    fetchImpl: async (url) => {
      const handle = decodeURIComponent(url.split("/").at(-1));
      calls.set(handle, (calls.get(handle) || 0) + 1);
      if (handle === candidates[1].handle) return response({}, 429);
      return response({
        code: 200,
        user: {
          screen_name: handle,
          id: handle === candidates[0].handle ? "101" : "103",
          followers: 1,
          protected: false,
          verification: { type: "individual" },
        },
      });
    },
  });
  assert.equal(result.observations.length, 2);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].error, /profile_http_429/u);
  assert.ok([...calls.values()].every((count) => count === 1));
});

test("malformed, oversized, and non-person profile payloads remain screening-only evidence", async () => {
  const [candidate] = listCapitalKolScreeningCandidates({ offset: 40, limit: 1 });
  await assert.rejects(
    fetchCapitalKolProfileObservation(candidate, { fetchImpl: async () => response({ code: 200 }) }),
    /profile_payload_invalid/u,
  );
  await assert.rejects(
    fetchCapitalKolProfileObservation(candidate, {
      fetchImpl: async () => ({ ok: true, status: 200, text: async () => "x".repeat(128 * 1024 + 1) }),
    }),
    /profile_response_too_large/u,
  );
  const observation = await fetchCapitalKolProfileObservation(candidate, {
    observedAt: "2026-09-06T18:45:00.000Z",
    fetchImpl: async () => response({
      code: 200,
      user: { screen_name: candidate.handle, id: "99", followers: 1, protected: false, verification: { type: "business" } },
    }),
  });
  assert.equal(observation.subjectType, "organization");
});

test("streaming profile size limit cancels a response before it is fully buffered", async () => {
  const [candidate] = listCapitalKolScreeningCandidates();
  let cancelled = false;
  let reads = 0;
  await assert.rejects(fetchCapitalKolProfileObservation(candidate, {
    fetchImpl: async () => ({
      ok: true, status: 200,
      body: new ReadableStream({
        pull(controller) { reads += 1; controller.enqueue(new Uint8Array(80 * 1024)); },
        cancel() { cancelled = true; },
      }),
    }),
  }), /profile_response_too_large/u);
  assert.equal(cancelled, true);
  assert.ok(reads <= 3);
});

async function screeningFixture(t, profileChecks) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "capital-screen-upgrade-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const previous = path.join(dir, "previous.json");
  if (profileChecks) await fs.writeFile(previous, JSON.stringify({ profileChecks }));
  return { dir, previous };
}

const screeningAt = "2026-09-17T07:00:00.000Z";

test("resume retries expired evidence and retains a current failure even when an older profile exists", async (t) => {
  const candidates = listCapitalKolScreeningCandidates();
  const { previous } = await screeningFixture(t, {
    observations: candidates.map((candidate, index) => ({
      candidateId: candidate.candidateId, handle: candidate.handle,
      id: String(index + 100), followers: 1, subjectType: "person",
      observedAt: index ? screeningAt : "2026-09-15T07:00:00.000Z",
    })),
    errors: [],
  });
  const requests = [];
  const result = await runCapitalKolScreening([
    "--live", "--retry-missing", "--limit=1", "--delay-ms=0", `--resume=${previous}`,
  ], {
    observedAt: screeningAt, writeOutput() {},
    fetchImpl: async (url) => { requests.push(url); return response({}, 503); },
  });
  assert.deepEqual(result.batch.handles, [candidates[0].handle]);
  assert.equal(requests.length, 1);
  assert.equal(result.profileChecks.errors.length, 1);
  assert.equal(result.profileChecks.errors[0].candidateId, candidates[0].candidateId);
  assert.equal(result.profileChecks.accumulated, 500, "historical observations remain available for review");
});

test("resume gives unseen candidates a turn before recently failed profiles", async (t) => {
  const candidates = listCapitalKolScreeningCandidates({ limit: 2 });
  const { previous } = await screeningFixture(t, {
    observations: [],
    errors: [{ candidateId: candidates[0].candidateId, handle: candidates[0].handle, checkedAt: screeningAt, error: "profile_http_503" }],
  });
  const result = await runCapitalKolScreening(["--retry-missing", "--limit=1", `--resume=${previous}`], {
    observedAt: screeningAt, writeOutput() {},
  });
  assert.deepEqual(result.batch.handles, [candidates[1].handle]);
  assert.equal(result.batch.retryOrder, "oldest_attempt_first");
  assert.equal(result.batch.retryQueueSize, 500);
});

test("an unresolved refresh failure overrides a fresh prior profile until a successful retry", async (t) => {
  const candidates = listCapitalKolScreeningCandidates();
  const offset = candidates.findIndex((candidate) => candidate.handle.toLowerCase() === "apompliano");
  const candidate = candidates[offset];
  const observation = {
    candidateId: candidate.candidateId, handle: candidate.handle,
    id: "999900011112222333", followers: 1, subjectType: "person",
    observedAt: "2026-09-17T06:59:50.000Z",
  };
  const { dir, previous } = await screeningFixture(t, { observations: [observation], errors: [] });
  const output = path.join(dir, "failed-refresh.json");
  const failed = await runCapitalKolScreening([
    "--live", `--offset=${offset}`, "--limit=1", "--delay-ms=0", `--resume=${previous}`, `--output=${output}`,
  ], { observedAt: screeningAt, writeOutput() {}, fetchImpl: async () => response({}, 503) });
  assert.deepEqual(failed.profileChecks.observations, [observation], "keep the old observation for audit");
  assert.equal(failed.report.counts.identityReady, 0);
  const row = failed.report.results.find((entry) => entry.candidateId === candidate.candidateId);
  assert.equal(row.disposition, "awaiting_identity_and_role_review");
  assert.ok(row.reasons.includes("latest_profile_observation_failed"));
  assert.equal(row.profileObservationFailure.error, "profile_http_503");
  assert.equal(failed.report.progress.profileObservationFailures, 1);
  const resumed = await runCapitalKolScreening([`--resume=${output}`], { observedAt: screeningAt, writeOutput() {} });
  assert.equal(resumed.report.counts.identityReady, 0, "offline resume cannot silently clear an unresolved source failure");
  const recovered = await runCapitalKolScreening([
    "--live", `--offset=${offset}`, "--limit=1", "--delay-ms=0", `--resume=${output}`,
  ], {
    observedAt: screeningAt, writeOutput() {},
    fetchImpl: async () => response({ code: 200, user: {
      screen_name: candidate.handle, id: observation.id, followers: 1,
      protected: false, verification: { type: "individual" },
    } }),
  });
  assert.equal(recovered.profileChecks.errors.length, 0);
  assert.equal(recovered.report.counts.identityReady, 1);
  assert.equal(recovered.report.progress.profileObservationFailures, 0);
});

test("legacy failed-attempt timestamps are frozen across successive resumed report writes", async (t) => {
  const [candidate] = listCapitalKolScreeningCandidates();
  const { dir, previous } = await screeningFixture(t);
  const legacyAt = "2026-09-06T18:45:00.000Z";
  const error = { candidateId: candidate.candidateId, handle: candidate.handle, error: "profile_http_503" };
  await fs.writeFile(previous, JSON.stringify({ observedAt: legacyAt, profileChecks: { observations: [], errors: [error] } }));
  const output = path.join(dir, "resumed.json");
  const first = await runCapitalKolScreening([`--resume=${previous}`, `--output=${output}`], {
    observedAt: screeningAt, writeOutput() {},
  });
  assert.equal(first.profileChecks.errors[0].checkedAt, legacyAt);
  assert.equal(first.profileChecks.errors[0].checkedAtSource, "legacy_run_observed_at");
  const second = await runCapitalKolScreening([`--resume=${output}`], {
    observedAt: "2026-09-17T08:00:00.000Z", writeOutput() {},
  });
  assert.deepEqual(second.profileChecks.errors, first.profileChecks.errors);
  assert.notEqual(second.observedAt, first.observedAt);
});

test("unknown legacy error timestamps stay unknown instead of adopting a later run time", async (t) => {
  const [candidate] = listCapitalKolScreeningCandidates();
  const { dir, previous } = await screeningFixture(t, {
    observations: [], errors: [{ candidateId: candidate.candidateId, handle: candidate.handle, error: "profile_http_503" }],
  });
  const output = path.join(dir, "unknown-time.json");
  const first = await runCapitalKolScreening([`--resume=${previous}`, `--output=${output}`], { observedAt: screeningAt, writeOutput() {} });
  assert.equal(first.profileChecks.errors[0].checkedAt, null);
  assert.equal(first.profileChecks.errors[0].checkedAtSource, "unknown");
  const second = await runCapitalKolScreening([`--resume=${output}`], { observedAt: "2026-09-17T08:00:00.000Z", writeOutput() {} });
  assert.deepEqual(second.profileChecks.errors, first.profileChecks.errors);
});

test("resume rejects duplicate or unknown candidate rows before any network request", async (t) => {
  const [candidate] = listCapitalKolScreeningCandidates();
  const row = { candidateId: candidate.candidateId, handle: candidate.handle };
  const { previous } = await screeningFixture(t, { observations: [row, row] });
  let calls = 0;
  const dependencies = { fetchImpl: async () => { calls += 1; }, writeOutput() {} };
  await assert.rejects(runCapitalKolScreening(["--live", `--resume=${previous}`], dependencies), /resume_file_duplicate_candidate/u);
  await fs.writeFile(previous, JSON.stringify({ profileChecks: { observations: [{ candidateId: "unknown" }] } }));
  await assert.rejects(runCapitalKolScreening(["--live", `--resume=${previous}`], dependencies), /resume_file_unknown_candidate/u);
  assert.equal(calls, 0);
});

test("live batches persist a resumable checkpoint before another profile finishes", async (t) => {
  const { dir } = await screeningFixture(t);
  const output = path.join(dir, "checkpoint.json");
  const candidates = listCapitalKolScreeningCandidates({ offset: 30, limit: 2 });
  let releaseSecond;
  const blocked = new Promise((resolve) => { releaseSecond = resolve; });
  const run = runCapitalKolScreening(["--live", "--offset=30", "--limit=2", "--delay-ms=0", `--output=${output}`], {
    observedAt: screeningAt, writeOutput() {},
    fetchImpl: async (url) => {
      const handle = decodeURIComponent(url.split("/").at(-1));
      if (handle === candidates[1].handle) await blocked;
      return response({ code: 200, user: { screen_name: handle, id: handle === candidates[0].handle ? "111" : "112", followers: 1 } });
    },
  });
  let checkpoint;
  try {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try { checkpoint = JSON.parse(await fs.readFile(output, "utf8")); } catch {}
      if (checkpoint?.profileChecks?.succeeded === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(checkpoint?.status, "running");
    assert.equal(checkpoint?.profileChecks?.succeeded, 1);
    assert.equal(checkpoint?.profileChecks?.remainingInBatch, 1);
  } finally { releaseSecond(); }
  const completed = await run;
  assert.equal(completed.status, "complete");
  const saved = JSON.parse(await fs.readFile(output, "utf8"));
  assert.equal(saved.profileChecks.succeeded, 2);
  assert.equal(saved.profileChecks.remainingInBatch, 0);
  assert.equal(saved.safety.automaticPromotion, false);
  assert.equal((await fs.stat(output)).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(dir)).filter((name) => name.endsWith(".tmp")), []);
});

test("checkpoint persistence failure stops scheduling more requests", async () => {
  const candidates = listCapitalKolScreeningCandidates({ offset: 30, limit: 5 });
  let calls = 0;
  await assert.rejects(collectCapitalKolProfileObservations(candidates, {
    concurrency: 1, delayMs: 0,
    fetchImpl: async (url) => { calls += 1; return response({ code: 200, user: { screen_name: url.split("/").at(-1), id: "123" } }); },
    onProgress: async () => { throw new Error("disk unavailable"); },
  }), /disk unavailable/u);
  assert.equal(calls, 1);
});
