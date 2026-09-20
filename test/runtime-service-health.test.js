import test from "node:test";
import assert from "node:assert/strict";
import { evaluateRuntimeHeartbeat, parseLaunchdService, readLaunchdService } from "../src/runtime-service-health.js";

const nowMs = Date.parse("2026-09-17T07:00:00Z");
const heartbeat = { version: 1, producer: "main", pid: 42, sequence: 8,
  startedAt: "2026-09-17T06:00:00Z", updatedAt: "2026-09-17T06:59:50Z" };

test("launchd service requires a running state and real PID", () => {
  assert.deepEqual(parseLaunchdService("service = {\n state = running\n pid = 42\n}"), { state: "active", pid: 42 });
  assert.equal(parseLaunchdService(" state = waiting\n last exit code = 0").state, "inactive");
  assert.equal(parseLaunchdService(" state = running\n pid = 0").state, "inactive");
});

test("a fresh file from a previous worker cannot prove a replacement worker is healthy", () => {
  const check = evaluateRuntimeHeartbeat({ heartbeat, producer: "main", pid: 43, nowMs });
  assert.equal(check.healthy, false);
  assert.ok(check.reasons.includes("heartbeat_pid_mismatch"));
});

test("runtime health rejects stale, malformed, wrong-producer and future-dated heartbeat content", () => {
  for (const changes of [
    { updatedAt: "2026-09-17T06:57:59Z" },
    { updatedAt: "2026-09-17T07:01:00Z" },
    { startedAt: "2026-09-17T07:02:00Z" },
    { producer: "fomo" }, { sequence: 0 }, { version: 2 }, { updatedAt: "invalid" },
  ]) {
    assert.equal(evaluateRuntimeHeartbeat({ heartbeat: { ...heartbeat, ...changes }, producer: "main", pid: 42, nowMs }).healthy, false);
  }
  assert.equal(evaluateRuntimeHeartbeat({ heartbeat, producer: "main", pid: 42, nowMs }).healthy, true);
});

test("launchd probe reads only its service and matches its persisted runtime heartbeat", async () => {
  const result = await readLaunchdService({
    label: "com.qohfq.robinhood-launchpad-monitor", producer: "main", uid: 501, dataDir: "/fixture", nowMs,
    execImpl: async (bin, args) => {
      assert.equal(bin, "/bin/launchctl");
      assert.deepEqual(args, ["print", "gui/501/com.qohfq.robinhood-launchpad-monitor"]);
      return { stdout: "service = {\n state = running\n pid = 42\n}" };
    },
    readFileImpl: async (file) => {
      assert.equal(file, "/fixture/main-runtime-heartbeat.json");
      return JSON.stringify(heartbeat);
    },
  });
  assert.equal(result.state, "active");
  assert.equal(result.heartbeat.healthy, true);
  assert.equal(result.heartbeat.ageSeconds, 10);
});

test("unavailable service and corrupt heartbeat are reported without leaking command errors", async () => {
  const result = await readLaunchdService({
    label: "com.qohfq.fomo-call-monitor", producer: "fomo", uid: 501, dataDir: "/fixture", nowMs,
    execImpl: async () => { throw new Error("sensitive command output"); },
    readFileImpl: async () => "not json",
  });
  assert.equal(result.state, "unknown");
  assert.equal(result.heartbeat.healthy, false);
  assert.ok(!JSON.stringify(result).includes("sensitive"));
});
