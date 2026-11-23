#!/usr/bin/env node
// Reconcile pending/uncertain live orders via `gmgn-cli order get`; optionally resolve one by hand.
// Usage: node scripts/live-reconcile.js [--resolve <positionId|orderId>=open|failed]
import "../src/live-env-loader.js";
import { createLiveTrader, loadLiveConfig } from "../src/live-gmgn-trader.js";
process.chdir(new URL("..", import.meta.url).pathname);
const cfg = loadLiveConfig();
const t = createLiveTrader(cfg);
const i = process.argv.indexOf("--resolve");
if (i > 0) { const [id, status] = String(process.argv[i + 1] || "").split("="); console.log(await t.resolve({ id, status })); }
const left = await t.reconcile();
console.log(left.length ? JSON.stringify(left, null, 2) : "no unresolved live orders");
