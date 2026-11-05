import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyObservation, parseTelemetryLines, pollOnce, runPollLoop } from "../src/flap-graduation-telemetry.js";

const exec = promisify(execFile);
const CA = `0x${"ab".repeat(20)}`;
const token = (extra = {}) => ({ chain: "bsc", address: CA, symbol: "FLAP", marketStage: "internal", launchpadPlatform: "flap", ...extra });

test("unknown progress is stored as null and a known fraction is not invented from a percent", () => {
  const unknown = applyObservation(null, token({ bondingCurveProgress: null }), 1_000);
  assert.equal(unknown.bondingCurveProgress, null);
  assert.equal(unknown.bondingCurveProgressStatus, "unknown");
  assert.equal(unknown.createdAt, null);
  assert.equal(unknown.outcome, "watching");
  const fraction = applyObservation(null, token({ bondingCurveProgress: 0.35, creationTimestamp: 1_000 }), 2_000);
  assert.equal(fraction.bondingCurveProgress, 0.35);
  assert.equal(fraction.bondingCurveProgressStatus, "known");
  const percent = applyObservation(null, token({ bondingCurveProgress: 55 }), 2_000);
  assert.equal(percent.bondingCurveProgress, 0.55);
});

test("graduation and timeout are recorded without filling a missing create time", () => {
  const started = applyObservation(null, token({ bondingCurveProgress: 0.4, creationTimestamp: 0 }), 1_000, { timeoutMs: 5_000 });
  assert.equal(started.outcome, "watching");
  const timed = applyObservation(started, token({ bondingCurveProgress: 0.4, creationTimestamp: 0 }), 6_000, { timeoutMs: 5_000 });
  assert.equal(timed.outcome, "timeout");
  assert.equal(timed.createdAt, new Date(0).toISOString());
  const graduated = applyObservation(started, token({ bondingCurveProgress: 0.99, marketStage: "external" }), 3_000, { timeoutMs: 5_000 });
  assert.equal(graduated.outcome, "graduated");
  assert.equal(graduated.bondingCurveProgress, 0.99);
  const undated = applyObservation(null, token({ bondingCurveProgress: 0.2 }), 10_000, { timeoutMs: 30 * 60_000 });
  assert.equal(undated.createdAt, null);
  assert.equal(undated.outcome, "watching");
});

test("the poll loop appends jsonl in dry-run without creating a file", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "flap-telemetry-"));
  const file = path.join(dir, "flap-graduation-telemetry.jsonl");
  const seen = [];
  const result = await runPollLoop({
    file,
    dryRun: true,
    maxPolls: 2,
    intervalMs: 1,
    timeoutMs: 10_000,
    now: () => 5_000,
    sleep: async () => { seen.push("slept"); },
    listTokens: async () => [token({ bondingCurveProgress: 0.42, creationTimestamp: 1_000 })],
  });
  assert.equal(seen.length, 1);
  assert.equal(result.appended.length, 2);
  assert.equal(result.appended[1].samples.length, 2);
  assert.equal(result.file, null);
  await assert.rejects(fs.access(file));
  const written = await runPollLoop({
    file, dryRun: false, maxPolls: 1, now: () => 5_000,
    listTokens: async () => [token({ bondingCurveProgress: 0.42, creationTimestamp: 1_000 })],
  });
  const second = await runPollLoop({
    file, dryRun: false, maxPolls: 1, now: () => 6_000,
    listTokens: async () => [token({ bondingCurveProgress: 1, marketStage: "external", creationTimestamp: 1_000 })],
  });
  assert.equal(written.records[0].outcome, "watching");
  assert.equal(second.records[0].outcome, "graduated");
  const loaded = parseTelemetryLines(await fs.readFile(file, "utf8"));
  assert.equal(loaded.records.length, 1);
  assert.equal(loaded.records[0].outcome, "graduated");
  assert.equal(pollOnce({ tokens: [{ symbol: "skip" }], nowMs: 1 }).updated.length, 0);
});

test("the dry-run CLI prints samples and does not write the telemetry file", async () => {
  const { stdout } = await exec(process.execPath, ["scripts/flap-graduation-telemetry.js", "--dry-run"], { cwd: process.cwd() });
  const lines = stdout.trim().split("\n").filter((line) => line.startsWith("{"));
  assert.equal(lines.length, 2);
  const rows = lines.map((line) => JSON.parse(line));
  assert.equal(rows[0].bondingCurveProgress, null);
  assert.equal(rows[0].bondingCurveProgressStatus, "unknown");
  assert.equal(rows[1].bondingCurveProgress, 0.55);
  assert.match(stdout, /no file written/);
});
