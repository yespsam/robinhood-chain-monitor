import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import path from "node:path";

const run = promisify(execFile);
const dataDir = path.resolve(process.env.DATA_DIR || "./data");
const outputFile = path.join(dataDir, "gmgn-baseline.json");

const { stdout } = await run(
  "gmgn-cli",
  ["market", "trenches", "--chain", "robinhood", "--limit", "80", "--raw"],
  { maxBuffer: 32 * 1024 * 1024 },
);
const response = JSON.parse(stdout);
const tokens = {};
const platforms = new Set();

for (const [category, list] of Object.entries(response)) {
  if (!Array.isArray(list)) continue;
  for (const token of list) {
    const address = token.address?.toLowerCase();
    if (!address) continue;
    const platform = token.launchpad_platform || "unknown";
    platforms.add(platform);
    tokens[address] = {
      category,
      platform,
      launchpad: token.launchpad || "",
      status: token.status,
      createdTimestamp: token.created_timestamp,
      poolAddress: token.pool_address || "",
    };
  }
}

const baseline = {
  chain: "robinhood",
  fetchedAt: new Date().toISOString(),
  platforms: [...platforms].sort(),
  tokenCount: Object.keys(tokens).length,
  tokens,
};
await fs.mkdir(dataDir, { recursive: true });
await fs.writeFile(outputFile, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(JSON.stringify({ outputFile, fetchedAt: baseline.fetchedAt, platforms: baseline.platforms, tokenCount: baseline.tokenCount }));
