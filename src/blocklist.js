import fs from "node:fs/promises";
import path from "node:path";

const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const SOLANA_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ADDRESS_FIELD = /^(?:address(?:es)?|contract(?:s)?|newContracts|removedContracts|token|tokens|recipient|launcher|deployer|actor|from|to|pool|pools|factory|hook|quoteAsset|quoteAddress|vault|vaultFactory|implementation|proxy|router|manager|portal|controller|emitter|creator|owner|factoryAddress|launcherAddress|portalAddress|vaultPortalAddress|routerAddress|hookAddress|vaultFactoryAddress|managerAddress|deployerAddress|implementationAddress|proxyAddress|tokenCreatorAddress|tokenCreatorTaxAddress|tokenCreatorRushAddress|tokenManager\d*Address)$/i;
const fileCaches = new Map();

function normalizedAddress(value) {
  if (typeof value !== "string" || (!ADDRESS.test(value) && !SOLANA_ADDRESS.test(value))) return null;
  return ADDRESS.test(value) ? value.toLowerCase() : value;
}

function collectEventAddresses(value, values, allowScalar = false, depth = 0) {
  if (depth > 12 || value === null || value === undefined) return;
  if (typeof value === "string") {
    if (allowScalar) {
      const address = normalizedAddress(value);
      if (address) values.add(address);
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectEventAddresses(item, values, allowScalar, depth + 1);
    return;
  }
  if (typeof value !== "object") return;

  // GitHub change evidence commonly represents a deployment as
  // { subject: "factoryAddress", before, after }.  Treat before/after as
  // addresses only when the subject itself is explicitly address-shaped.
  const addressChange = typeof value.subject === "string" && ADDRESS_FIELD.test(value.subject);
  for (const [key, item] of Object.entries(value)) {
    const addressField = ADDRESS_FIELD.test(key)
      || (addressChange && ["before", "after", "value"].includes(key));
    collectEventAddresses(item, values, addressField, depth + 1);
  }
}

function eventAddresses(event) {
  const values = new Set();
  collectEventAddresses(event, values);
  return [...values];
}

function normalizedAddresses(values) {
  return new Set(Array.from(values || [], normalizedAddress).filter(Boolean));
}

function blocklistValues(file) {
  const values = Array.isArray(file)
    ? file
    : file && typeof file === "object" && Array.isArray(file.addresses)
      ? file.addresses
      : null;
  if (!values) throw new Error("blocked-contracts.json must be an array or an object with an addresses array");
  if (values.some((value) => !normalizedAddress(value))) {
    throw new Error("blocked-contracts.json contains an invalid contract address");
  }
  return values;
}

async function load(config) {
  const filename = path.resolve(config.dataDir, "blocked-contracts.json");
  const current = fileCaches.get(filename) || { fileAddresses: new Set(), nextRefreshAt: 0 };
  if (Date.now() >= current.nextRefreshAt) {
    try {
      const file = JSON.parse(await fs.readFile(filename, "utf8"));
      current.fileAddresses = normalizedAddresses(blocklistValues(file));
    } catch (error) {
      if (error.code === "ENOENT") {
        current.fileAddresses = new Set();
      } else {
        // A partially-written or malformed operator file must never clear the
        // previously enforced rules.  Keep the last successfully parsed set
        // and retry on the next refresh window.
        console.error(`[blocklist] ${error.message}; keeping last-known-good rules`);
      }
    }
    current.nextRefreshAt = Date.now() + 5_000;
    fileCaches.set(filename, current);
  }
  return new Set([
    ...normalizedAddresses(config.blockedContracts),
    ...current.fileAddresses,
  ]);
}

export async function isEventBlocked(config, event) {
  const blocked = await load(config);
  return eventAddresses(event).some((address) => blocked.has(address));
}

export { eventAddresses };
