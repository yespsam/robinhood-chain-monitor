#!/usr/bin/env node
// Record flap bonding-curve progress samples. Dry-run uses built-in examples
// and does not write, call the network, or read secrets. A tokens file is a
// JSON array of objects with the same bondingCurveProgress field the curve
// gate already reads (a fraction of 1, or null when unknown).
import fs from "node:fs/promises";
import { runPollLoop, DEFAULT_TELEMETRY_FILE } from "../src/flap-graduation-telemetry.js";

const help = `Flap graduation telemetry
  node scripts/flap-graduation-telemetry.js --dry-run
  node scripts/flap-graduation-telemetry.js --once --tokens tokens.json
  node scripts/flap-graduation-telemetry.js --poll --tokens tokens.json --max-polls 4 --interval-ms 15000

Writes data/flap-graduation-telemetry.jsonl (gitignored with data/). Each line
is the latest snapshot for one token: createdAt (null if the feed has no
create time), progress samples, and outcome watching | graduated | timeout.
Unknown progress is null. No wallet, no .env, no order.`;

function flag(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("missing");
  return value;
}

function integer(name, fallback) {
  const raw = flag(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error("bad integer");
  return value;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(help);
  process.exit(0);
}

const dryRun = process.argv.includes("--dry-run");
const poll = process.argv.includes("--poll");
const once = process.argv.includes("--once") || poll;
if (!dryRun && !once) {
  console.log(help);
  process.exitCode = 1;
} else {
  try {
    const out = flag("--out") || DEFAULT_TELEMETRY_FILE;
    const timeoutMs = integer("--timeout-ms", 30 * 60_000);
    const listTokens = dryRun && !flag("--tokens")
      ? async () => [
        { chain: "bsc", address: `0x${"ab".repeat(20)}`, symbol: "DRY", marketStage: "internal", launchpadPlatform: "flap", bondingCurveProgress: null },
        { chain: "bsc", address: `0x${"cd".repeat(20)}`, symbol: "CURVE", marketStage: "internal", launchpadPlatform: "flap", bondingCurveProgress: 0.55, creationTimestamp: Date.parse("2026-11-05T00:00:00Z") },
      ]
      : async () => {
        const file = flag("--tokens");
        if (!file) throw new Error("tokens");
        const parsed = JSON.parse(await fs.readFile(file, "utf8"));
        if (!Array.isArray(parsed)) throw new Error("tokens");
        return parsed;
      };
    const result = await runPollLoop({
      listTokens,
      file: out,
      dryRun,
      maxPolls: dryRun && !poll ? 1 : integer("--max-polls", 1),
      intervalMs: integer("--interval-ms", 15_000),
      timeoutMs,
      now: dryRun && !flag("--tokens") ? () => Date.parse("2026-11-05T00:05:00Z") : Date.now,
    });
    if (dryRun) {
      console.log(result.appended.map((row) => JSON.stringify(row)).join("\n"));
      console.log("dry-run: no file written, no network, no secrets");
    } else {
      console.log(JSON.stringify({ file: out, rows: result.appended.length, outcomes: result.records.map((row) => ({ address: row.address, outcome: row.outcome, bondingCurveProgress: row.bondingCurveProgress })) }));
    }
  } catch {
    console.error("telemetry 未完成：检查 --tokens JSON 和参数。未发单，未读取密钥。");
    process.exitCode = 1;
  }
}
