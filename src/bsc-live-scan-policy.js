import fs from "node:fs/promises";
import path from "node:path";

export function validateBscScanPolicy(value) {
  if (!value || value.version !== 1 || !["all", "live_only"].includes(value.mode)) {
    throw new Error("Invalid BSC scan policy; refusing to silently resume historical work");
  }
  if (value.mode === "all") return { version: 1, mode: "all" };
  if (!Number.isSafeInteger(value.fromBlock) || value.fromBlock < 1
    || !Number.isFinite(Date.parse(value.activatedAt))) throw new Error("Invalid BSC live scan boundary");
  return { version: 1, mode: "live_only", fromBlock: value.fromBlock,
    activatedAt: new Date(value.activatedAt).toISOString() };
}

export async function loadBscScanPolicy(dataDir, durablePolicy = null) {
  try { return validateBscScanPolicy(JSON.parse(await fs.readFile(path.join(dataDir, "bsc-scan-policy.json"), "utf8"))); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    // Losing the control file must not silently restart 30k paused tasks.
    return durablePolicy ? validateBscScanPolicy(durablePolicy) : { version: 1, mode: "all" };
  }
}

export const bscScanEntryActive = (policy, record) => policy?.mode !== "live_only"
  || (Number.isSafeInteger(record?.blockNumber) && record.blockNumber >= policy.fromBlock);

export function bscScanFeatureActive(policy, activation) {
  if (policy?.mode !== "live_only") return true;
  if (Number.isSafeInteger(activation?.activationBlockNumber)) {
    return activation.activationBlockNumber >= policy.fromBlock;
  }
  const at = Date.parse(activation?.firstObservedAt || activation?.activatedAt || "");
  return Number.isFinite(at) && at >= Date.parse(policy.activatedAt);
}

export const bscScanGapActive = (policy, gap) => policy?.mode !== "live_only"
  || Number(gap?.toBlock) >= policy.fromBlock;

// Preserve the pending block union, but prevent an old range from pinning a
// new range's scheduler cursor. Idempotent across restarts and compaction.
export function splitBscScanGaps(policy, gaps) {
  if (policy?.mode !== "live_only") return gaps;
  const floor = policy.fromBlock;
  return gaps.flatMap(gap => {
    if (gap.toBlock < floor || gap.fromBlock >= floor) return [gap];
    const active = { ...gap, fromBlock: floor, nextBlock: Math.max(floor, gap.nextBlock) };
    return gap.nextBlock < floor
      ? [{ ...gap, id: `${gap.id}:paused-before:${floor}`, toBlock: floor - 1 }, active]
      : [active];
  });
}
