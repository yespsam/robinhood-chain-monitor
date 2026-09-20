#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { createPaper100Runner, PAPER_100_DEFAULTS } from "../src/paper-100-runner.js";

export function parsePaper100Arguments(args, env = process.env) {
  const options = { action: "once", liveQuotes: false, intervalMs: 60_000,
    dataDir: env.PAPER_100_DATA_DIR || PAPER_100_DEFAULTS.dataDir,
    sourceFiles: [env.PAPER_100_MAIN_OUTBOX || PAPER_100_DEFAULTS.sourceFiles[0],
      env.PAPER_100_FOMO_OUTBOX || PAPER_100_DEFAULTS.sourceFiles[1]],
    rpcUrls: String(env.PAPER_100_BSC_RPC_URLS || "").split(",").map(value => value.trim()).filter(Boolean) };
  let action = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (["--status", "--once", "--watch"].includes(arg)) {
      if (action) throw new Error("choose only one of --status, --once, --watch");
      action = true; options.action = arg.slice(2);
    } else if (arg === "--live-quotes") options.liveQuotes = true;
    else if (arg === "--help") options.action = "help";
    else if (["--data-dir", "--main-outbox", "--fomo-outbox", "--review-file", "--interval-seconds"].includes(arg)) {
      const value = args[++index]; if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value`);
      if (arg === "--data-dir") options.dataDir = value;
      else if (arg === "--main-outbox") options.sourceFiles[0] = value;
      else if (arg === "--fomo-outbox") options.sourceFiles[1] = value;
      else if (arg === "--review-file") options.reviewFile = value;
      else { const seconds = Number(value); if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 3600) throw new Error("watch interval must be 60-3600 seconds"); options.intervalMs = seconds * 1000; }
    } else throw new Error(`unsupported paper-only option: ${arg}`);
  }
  if (options.action === "status" && (options.liveQuotes || options.reviewFile)) throw new Error("--status is strictly read-only; omit quote/review options");
  return options;
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const options = parsePaper100Arguments(args, env);
  if (options.action === "help") {
    process.stdout.write("paper-100 [--once|--status|--watch] [--live-quotes] [--review-file PATH] [--data-dir PATH]\nDefault: offline observation, never signs or broadcasts. Watch interval >=60s. Explicit RPC env: PAPER_100_BSC_RPC_URLS.\n");
    return;
  }
  const runner = createPaper100Runner(options);
  let ending = false, wake = null;
  const interrupt = () => { ending = true; wake?.(); void runner.stop().catch(() => {}); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    if (options.action === "status") process.stdout.write(`${JSON.stringify(await runner.status(), null, 2)}\n`);
    else do {
      process.stdout.write(`${JSON.stringify(await runner.runOnce(), null, 2)}\n`);
      if (options.action !== "watch" || ending) break;
      await new Promise(resolve => { const timer = setTimeout(() => { wake = null; resolve(); }, options.intervalMs);
        wake = () => { clearTimeout(timer); wake = null; resolve(); }; });
    } while (!ending);
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    await runner.stop();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(error => { process.stderr.write(`[paper-100] ${error.message}\n`); process.exitCode = 1; });
}
