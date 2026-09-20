import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { runHealthCheck } from "../deploy/health-check.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
for (const arg of args) {
  if (!["--json", "--no-write"].includes(arg)) throw new Error(`Unknown health option: ${arg}`);
}
let localEnv = {};
try { localEnv = dotenv.parse(await fs.readFile(path.join(root, ".env"))); }
catch (error) { if (error.code !== "ENOENT") throw error; }
const env = { ...localEnv, ...process.env };
env.DATA_DIR = path.resolve(root, env.DATA_DIR || "data");
env.HEALTH_SERVICE_MANAGER ||= process.platform === "darwin" ? "launchd" : "systemd";
// This command is a local diagnostic, never an external dead-man ping.
env.HEALTH_REQUIRE_EXTERNAL_HEARTBEAT = "false";
env.HEALTH_HEARTBEAT_URL = "";
const report = await runHealthCheck({ env, writeReportFile: !args.has("--no-write") });
const summary = {
  checkedAt: report.checkedAt,
  status: report.status,
  operationalHealthy: report.operationalHealthy,
  coverageComplete: report.coverageComplete,
  deliveryComplete: report.deliveryComplete,
  services: report.services,
  lanes: Object.fromEntries(Object.entries(report.lanes).map(([name, lane]) => [name, {
    status: lane.status, reason: lane.reason, updatedAt: lane.authoritative?.mtimeAt,
  }])),
  outboxes: Object.fromEntries(Object.entries(report.outboxes).map(([name, box]) => [name, {
    counts: box.counts, pending: box.nonterminalCount, failed: box.failedDestinationCount,
  }])),
  operationalFailures: report.operationalFailures,
  coverageIssues: report.coverageIssues,
  deliveryIssues: report.deliveryIssues,
};
console.log(JSON.stringify(args.has("--json") ? report : summary, null, 2));
if (!report.operationalHealthy) process.exitCode = 1;
