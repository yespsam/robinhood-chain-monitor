import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";
import { pipeline } from "node:stream/promises";

const monitorRoot = "/Users/qohfq/Documents/Playground/robinhood-chain-monitor";
const logDir = path.join(monitorRoot, "data", "logs");
const archiveDir = path.join(logDir, "archive");
const configuredLimit = Number(process.env.MONITOR_LOG_ROTATE_MAX_BYTES || 67_108_864);
const dryRun = /^true$/i.test(process.env.MONITOR_LOG_ROTATE_DRY_RUN || "false");

if (!Number.isSafeInteger(configuredLimit) || configuredLimit < 1_048_576) {
  throw new Error("MONITOR_LOG_ROTATE_MAX_BYTES must be an integer of at least 1048576");
}

function stamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function rotateOne(filename) {
  const source = path.join(logDir, filename);
  let sourceStat;
  try {
    sourceStat = await fs.stat(source);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!sourceStat.isFile() || sourceStat.size < configuredLimit) return;

  const destination = path.join(archiveDir, `${filename}.${stamp()}.gz`);
  if (dryRun) {
    console.log(`would rotate ${source} (${sourceStat.size} bytes) -> ${destination}`);
    return;
  }

  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await pipeline(
      createReadStream(source),
      createGzip({ level: 9 }),
      createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
    );
    const archiveStat = await fs.stat(temporary);
    if (!archiveStat.size) throw new Error(`empty archive created for ${source}`);
    await fs.rename(temporary, destination);
    await fs.truncate(source, 0);
    console.log(`rotated ${source} (${sourceStat.size} bytes) -> ${destination}`);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

await fs.mkdir(archiveDir, { recursive: true });
for (const filename of [
  "monitor.out.log",
  "monitor.err.log",
  "fomo-worker.out.log",
  "fomo-worker.err.log",
]) {
  await rotateOne(filename);
}
