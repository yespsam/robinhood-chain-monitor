// Wallets that deploy a token matching a hotspot, ranked by how fast they repeat.
// A known fast dev is a positive signal. A wallet marked rug can be a block.
import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

export const FAST_DEV_REGISTRY_VERSION = 1;
export const FAST_DEV_REGISTRY_FILE = "fast-dev-registry.json";

const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function emptyFastDevRegistry() {
  return { version: FAST_DEV_REGISTRY_VERSION, wallets: {} };
}

export function normalizeDevWallet(chain, wallet) {
  const name = String(chain || "").toLowerCase();
  const value = String(wallet || "").trim();
  if (name === "sol") return SOL.test(value) ? value : null;
  if (name === "bsc" || name === "eth" || name === "base") return EVM.test(value) ? value.toLowerCase() : null;
  return null;
}

function walletKey(chain, wallet) {
  const normalized = normalizeDevWallet(chain, wallet);
  if (!normalized) return null;
  return `${String(chain).toLowerCase()}:${normalized}`;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function validRegistry(value) {
  return value?.version === FAST_DEV_REGISTRY_VERSION && value.wallets && typeof value.wallets === "object" && !Array.isArray(value.wallets);
}

export function recordFastDevLaunch(registry, launch = {}) {
  const next = validRegistry(registry) ? structuredClone(registry) : emptyFastDevRegistry();
  const chain = String(launch.chain || "").toLowerCase();
  const key = walletKey(chain, launch.wallet);
  if (!key) return next;
  const lag = Number(launch.lagSeconds);
  if (!Number.isFinite(lag) || lag < 0 || lag > 86_400) return next;
  const rawAddress = String(launch.address || "").trim();
  const address = chain === "sol" ? rawAddress : rawAddress.toLowerCase();
  const hotspotId = String(launch.hotspotId || "");
  if (!address || !hotspotId) return next;
  const wallet = key.slice(chain.length + 1);
  const row = next.wallets[key] || { chain, wallet, rug: false, launches: [] };
  if (row.launches.some((item) => item.hotspotId === hotspotId && item.address === address)) return next;
  row.launches = [...row.launches, {
    hotspotId,
    address,
    lagSeconds: lag,
    atMs: Number.isFinite(Number(launch.atMs)) ? Number(launch.atMs) : null,
  }].slice(-50);
  next.wallets[key] = row;
  const keys = Object.keys(next.wallets);
  if (keys.length > 2_000) {
    const ranked = keys.map((item) => ({
      item,
      at: (next.wallets[item].launches || []).reduce((max, launchRow) => Math.max(max, launchRow.atMs || 0), 0),
    })).sort((left, right) => left.at - right.at);
    for (const drop of ranked.slice(0, keys.length - 2_000)) delete next.wallets[drop.item];
  }
  return next;
}

export function markFastDevRug(registry, { chain, wallet, rug = true } = {}) {
  const next = validRegistry(registry) ? structuredClone(registry) : emptyFastDevRegistry();
  const key = walletKey(chain, wallet);
  if (!key) return next;
  const name = String(chain || "").toLowerCase();
  const row = next.wallets[key] || { chain: name, wallet: key.slice(name.length + 1), rug: false, launches: [] };
  row.rug = rug === true;
  next.wallets[key] = row;
  return next;
}

function summarize(row, { minLaunches, maxMedianSeconds }) {
  const lags = (row.launches || []).map((item) => Number(item.lagSeconds)).filter((value) => Number.isFinite(value));
  const count = lags.length;
  const medianLagSeconds = count ? median(lags) : null;
  const fastestLagSeconds = count ? Math.min(...lags) : null;
  const lastAtMs = (row.launches || []).reduce((max, item) => Math.max(max, Number(item.atMs) || 0), 0) || null;
  const knownFast = row.rug !== true && count >= minLaunches && medianLagSeconds !== null && medianLagSeconds <= maxMedianSeconds;
  return {
    chain: row.chain,
    wallet: row.wallet,
    count,
    medianLagSeconds,
    fastestLagSeconds,
    lastAtMs,
    rug: row.rug === true,
    knownFast,
  };
}

export function rankFastDevs(registry, { minLaunches = 2, maxMedianSeconds = 180 } = {}) {
  const rows = Object.values(validRegistry(registry) ? registry.wallets : {})
    .map((row) => summarize(row, { minLaunches, maxMedianSeconds }))
    .filter((row) => row.count >= minLaunches && row.rug !== true);
  rows.sort((left, right) => left.medianLagSeconds - right.medianLagSeconds
    || left.fastestLagSeconds - right.fastestLagSeconds
    || right.count - left.count
    || left.wallet.localeCompare(right.wallet));
  return rows.map((row, index) => ({ ...row, rank: index + 1 }));
}

export function listRugDevs(registry) {
  return Object.values(validRegistry(registry) ? registry.wallets : {})
    .filter((row) => row.rug === true)
    .map((row) => ({ chain: row.chain, wallet: row.wallet, count: (row.launches || []).length }));
}

export function rugWalletsFromEnv(env = process.env) {
  return String(env?.NARRATIVE_LIVE_RUG_WALLETS || "").split(/[\s,]+/u).map((item) => item.trim()).filter(Boolean);
}

export function isRugDev(registry, { chain, wallet } = {}, env = process.env) {
  const key = walletKey(chain, wallet);
  if (!key) return false;
  if (validRegistry(registry) && registry.wallets[key]?.rug === true) return true;
  const name = String(chain || "").toLowerCase();
  for (const item of rugWalletsFromEnv(env)) {
    const normalized = normalizeDevWallet(name, item);
    if (normalized && `${name}:${normalized}` === key) return true;
  }
  return false;
}

export function fastDevSignal(registry, { chain, wallet, minLaunches = 2, maxMedianSeconds = 180 } = {}) {
  const ranked = rankFastDevs(registry, { minLaunches, maxMedianSeconds });
  const key = walletKey(chain, wallet);
  const walletText = key ? key.slice(String(chain).toLowerCase().length + 1) : null;
  const row = ranked.find((item) => item.chain === String(chain || "").toLowerCase() && item.wallet === walletText);
  const rug = isRugDev(registry, { chain, wallet }, {});
  if (!row?.knownFast) {
    return {
      knownFast: false,
      rug,
      rank: null,
      medianLagSeconds: row?.medianLagSeconds ?? null,
      fastestLagSeconds: row?.fastestLagSeconds ?? null,
      count: row?.count ?? 0,
      wallet: walletText,
    };
  }
  return {
    knownFast: true,
    rug: false,
    rank: row.rank,
    medianLagSeconds: row.medianLagSeconds,
    fastestLagSeconds: row.fastestLagSeconds,
    count: row.count,
    wallet: row.wallet,
  };
}

async function writeJson(file, value, fsImpl) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  const handle = await fsImpl.open(temp, "wx", 0o600);
  try {
    await handle.writeFile(JSON.stringify(value));
    await handle.sync?.();
  } finally {
    await handle.close();
  }
  await fsImpl.rename(temp, file);
}

export function createFastDevStore({ dataDir, fs: fsImpl = fs } = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  const file = path.join(dataDir, FAST_DEV_REGISTRY_FILE);
  let registry = null;
  async function load() {
    try {
      const parsed = JSON.parse(await fsImpl.readFile(file, "utf8"));
      registry = validRegistry(parsed) ? parsed : emptyFastDevRegistry();
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      registry = emptyFastDevRegistry();
    }
    return registry;
  }
  async function update(mutator) {
    const current = await load();
    registry = mutator(current);
    await writeJson(file, registry, fsImpl);
    return registry;
  }
  return { load, update, file };
}
