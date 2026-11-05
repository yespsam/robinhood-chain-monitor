#!/usr/bin/env node
// Print SQN and closed-round count for the current paper ledger.
// Does not read .env, API keys, or a wallet. Exit 1 when the ledger is missing
// or unreadable. A computed report exits 0 even when promote is false.
import { loadPaperSqnReport } from "../src/paper-sqn.js";

const help = `Paper SQN report (read-only)
  node scripts/paper-sqn-report.js
  node scripts/paper-sqn-report.js --data-dir data
  node scripts/paper-sqn-report.js --file data/yesp-atm-confirmed-pvp-v2-estimated-20260928.json

Looks for the estimated session pointer, then the active paper pointer, then
yesp-atm-strategy-paper.json. SQN = (mean closed-round PnL / sample stdev) * sqrt(N).
LIVE promotion defaults are SQN >= 1.6 and closed rounds >= 30. This command
does not place an order.`;

function flag(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error("missing");
  return value;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  console.log(help);
  process.exit(0);
}

try {
  const report = await loadPaperSqnReport({
    dataDir: flag("--data-dir") || process.env.DATA_DIR || "data",
    file: flag("--file"),
  });
  console.log(JSON.stringify(report, (_, value) => (value === Infinity ? "Infinity" : value === -Infinity ? "-Infinity" : value), 2));
  if (!report.ok) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ ok: false, reason: "模拟盘账本无法读取", closed: 0, sqn: null, promote: false }));
  process.exitCode = 1;
}
