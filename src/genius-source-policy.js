import { createHash } from "node:crypto";

export const GENIUS_FACTORY = "0x78EAE9537C0ef90DFe9B7ae964682Fe8138afe31";
export const GENIUS_FACTORY_CODE_HASH = "0x416f19c32fbf75ea1a0cd2f51d05f0722f1f4cb0dbaf8f00cb22832345d4eef6";
export const GENIUS_OFFICIAL_ROLES = Object.freeze([
  "0xE7C7B7EE71db0f1B4F0Ff25D7cEc191268e7FD98",
  "0xba5Ed099633D3B313e4D5F7bdc1305d3c28ba5Ed",
]);
export const GENIUS_DOCUMENT_SOURCES = Object.freeze({
  genius_manifest: "https://genius.fun/contracts/manifest.json",
  genius_about: "https://genius.fun/about",
  genius_integrate: "https://genius.fun/docs/integrate",
});
export const GENIUS_X_IDENTITIES = Object.freeze({
  geniusterminal: "1236460732486692864",
  geniusfdn: "1882130308918804480",
});

const ADDRESS = /^0x[0-9a-f]{40}$/i;
const HASH = /^0x[0-9a-f]{64}$/i;
const DIGEST = /^(?:0x)?[0-9a-f]{64}$/i;
const ID = /^[1-9][0-9]{0,20}$/;
const KINDS = new Set(["manifest_update", "docs_update", "official_announcement", "official_token_launch", "official_token_lifecycle", "factory_config"]);
const TOKEN_LIFECYCLE_EVENTS = new Set(["BuybackEnabledUpdated", "CreatorFeeRecipientChangeCancelled", "CreatorFeeRecipientChangeProposed", "CreatorFeeRecipientUpdated", "GraduationTokensPermanentlyLocked", "LaunchForceSwept", "LaunchGraduationRescued", "LaunchSwept", "PoolGraduated"]);
const FACTORY_EVENTS = new Set(["GraduationExecutorSet", "LaunchConfigAdded", "LaunchConfigUpdated", "LaunchDeployerSet", "LaunchEnabledUpdated", "LaunchFeeUpdated", "LaunchForwarderSet", "MaxCreatorTaxUpdated", "OwnershipTransferStarted", "OwnershipTransferred", "PairTokenApprovalUpdated", "PairTokenEconomicsUpdated", "SnipeTaxSecondsUpdated", "SnipeTaxStartBpsUpdated", "WhitelistedLauncherUpdated"]);
const ROLES = new Set(GENIUS_OFFICIAL_ROLES.map((value) => value.toLowerCase()));
const lower = (value) => String(value || "").toLowerCase();
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const address = (value) => typeof value === "string" && ADDRESS.test(value) && !/^0x0{40}$/i.test(value);
const instant = (value) => typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
const text = (value, maximum) => typeof value === "string" && value.trim().length > 0 && value.length <= maximum;
export const GENIUS_DOCUMENT_MAX_CHANGES = 2000;
export const GENIUS_DOCUMENT_MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;

// Check every value, including late/nested changes, before hashing or rendering.
// JSON serialization alone would silently erase undefined/functions and convert
// non-finite numbers; a cyclic or deeply nested payload must fail closed too.
function boundedChangesJson(changes) {
  if (!Array.isArray(changes) || !changes.length || changes.length > GENIUS_DOCUMENT_MAX_CHANGES) return null;
  if (!changes.every(change => record(change) && text(change.field, 160)
    && Object.hasOwn(change, "before") && Object.hasOwn(change, "after"))) return null;
  let bytes = 0, nodes = 0;
  const active = new Set();
  function append(value) {
    bytes += Buffer.byteLength(value);
    if (bytes > GENIUS_DOCUMENT_MAX_EVIDENCE_BYTES) throw new Error("size");
    return value;
  }
  function visit(value, depth) {
    if (depth > 32 || ++nodes > 200000) throw new Error("complexity");
    if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return append(JSON.stringify(value));
    if (typeof value === "string") return append(JSON.stringify(value));
    if (!value || typeof value !== "object" || active.has(value)) throw new Error("value");
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("object");
    active.add(value);
    let result;
    if (Array.isArray(value)) {
      const items = [];
      for (let i = 0; i < value.length; i++) {
        if (!Object.hasOwn(value, i)) throw new Error("sparse");
        items.push(visit(value[i], depth + 1));
      }
      result = append("[") + items.join(append(",")) + append("]");
    } else {
      const entries = [];
      for (const key of Object.keys(value).sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error("accessor");
        entries.push(append(JSON.stringify(key)) + append(":") + visit(descriptor.value, depth + 1));
      }
      result = append("{") + entries.join(append(",")) + append("}");
    }
    active.delete(value);
    return result;
  }
  try {
    const serialized = visit(changes, 0);
    return Buffer.byteLength(serialized) <= GENIUS_DOCUMENT_MAX_EVIDENCE_BYTES ? serialized : null;
  } catch { return null; }
}

export function geniusDocumentChangesHash(changes) {
  const serialized = boundedChangesJson(changes);
  return serialized === null ? null : createHash("sha256").update(serialized).digest("hex");
}

export function claimsGeniusSource(value) {
  return value?.type === "genius_fun_update"
    || lower(value?.platform?.id || value?.platform || value?.project?.id) === "geniusfun"
    || /^genius(?:_|:)/i.test(String(value?.sourceId || value?.source?.id || ""));
}

function sourceConsistency(event) {
  return (!event.source || (record(event.source)
    && (event.source.id == null || event.source.id === event.sourceId)
    && (event.source.url == null || event.source.url === event.sourceUrl)
    && (event.source.trust == null || event.source.trust === "official_verified")))
    && (event.url == null || event.url === event.sourceUrl)
    && event.automaticExecution !== true && event.autoTradeEligible !== true;
}

function documentEvent(event) {
  const url = GENIUS_DOCUMENT_SOURCES[event.sourceId];
  if (!url || event.sourceUrl !== url || event.evidence?.sourceUrl !== url
    || !["manifest_update", "docs_update"].includes(event.kind)
    || (event.kind === "manifest_update") !== (event.sourceId === "genius_manifest")
    || !DIGEST.test(String(event.evidence?.afterHash || ""))
    || (event.evidence?.beforeHash != null && !DIGEST.test(String(event.evidence.beforeHash)))
    || !Array.isArray(event.changes) || event.changes.length === 0) return false;
  if (event.evidence.beforeHash === event.evidence.afterHash) return false;
  const baseKey = `genius:${event.sourceId}:${event.evidence.beforeHash}:${event.evidence.afterHash}`;
  if (event.partIndex == null ? event.eventKey !== baseKey
    : !Number.isSafeInteger(event.partIndex) || event.partIndex < 0 || event.eventKey !== `${baseKey}:${event.partIndex}`) return false;
  const changesHash = geniusDocumentChangesHash(event.changes);
  if (!changesHash || (event.sourceOccurredAt != null && !instant(event.sourceOccurredAt))) return false;
  if (event.aggregation != null) {
    return event.aggregation === "complete_transition" && event.partIndex == null
      && event.observationOnly === true && instant(event.sourceOccurredAt)
      && event.changeCount === event.changes.length && event.evidence.changesHash === changesHash;
  }
  // Existing outbox/reservation keys stay valid during upgrade. Never turn an
  // already delivered old part into a new aggregate key and replay it.
  if (event.changes.length > (event.partIndex == null ? 200 : 2)) return false;
  if (event.changeCount != null && (!Number.isSafeInteger(event.changeCount) || event.changeCount < event.changes.length
    || event.changeCount > GENIUS_DOCUMENT_MAX_CHANGES * 2
    || (event.partIndex != null && (event.partIndex * 2 >= event.changeCount
      || event.changes.length !== Math.min(2, event.changeCount - event.partIndex * 2))))) return false;
  return event.evidence.changesHash == null || event.evidence.changesHash === changesHash;
}

function xEvent(event) {
  const identity = event.identity;
  const tweet = event.tweet;
  const handle = lower(identity?.handle);
  const expectedId = GENIUS_X_IDENTITIES[handle];
  if (event.kind !== "official_announcement" || !expectedId || identity?.verified !== true
    || identity.verification !== "fxtwitter_numeric_id+official_x_oembed"
    || identity.userId !== expectedId || !record(tweet) || !ID.test(String(tweet.id || ""))
    || typeof tweet.id !== "string" || !text(tweet.text, 30_000)
    || tweet.author?.id !== expectedId || lower(tweet.author?.screen_name) !== handle) return false;
  if (event.eventKey !== `genius:x:${expectedId}:${tweet.id}` || !instant(event.sourceOccurredAt)
    || !instant(tweet.createdAt) || Date.parse(event.sourceOccurredAt) !== Date.parse(tweet.createdAt)) return false;
  const url = event.sourceUrl;
  if (typeof url !== "string" || !new RegExp(`^https://x\\.com/${handle}/status/${tweet.id}$`, "i").test(url)) return false;
  // A mention by an authenticated account is evidence of a statement, not
  // proof that a token was issued by the team, even when its name says TEST.
  if (event.token && (!address(event.token.address) || event.token.classification !== "official_mentioned"
    || !tweet.text.toLowerCase().includes(event.token.address.toLowerCase()))) return false;
  if (event.mentionedAddresses != null && (!Array.isArray(event.mentionedAddresses)
    || event.mentionedAddresses.length > 200
    || !event.mentionedAddresses.every(value => address(value) && tweet.text.toLowerCase().includes(value.toLowerCase())))) return false;
  return event.officialTestToken !== true && event.officialToken !== true;
}

function independentProviders(values) {
  if (!Array.isArray(values) || values.length < 2 || values.length > 12) return false;
  const hosts = new Set();
  for (const value of values) {
    try {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash) return false;
      hosts.add(url.hostname.toLowerCase());
    } catch { return false; }
  }
  return hosts.size >= 2;
}

function chainEvent(event) {
  const evidence = event.evidence;
  if (!["official_token_launch", "official_token_lifecycle", "factory_config"].includes(event.kind)
    || lower(event.factory) !== lower(GENIUS_FACTORY)
    || !HASH.test(String(event.transactionHash || "")) || !HASH.test(String(event.blockHash || ""))
    || !Number.isSafeInteger(event.blockNumber) || event.blockNumber <= 0
    || !Number.isSafeInteger(event.logIndex) || event.logIndex < 0
    || event.sourceUrl !== `https://bscscan.com/tx/${event.transactionHash}`
    || evidence?.chainId !== 56 || lower(evidence?.factory) !== lower(GENIUS_FACTORY)
    || lower(evidence?.runtimeCodeHash) !== GENIUS_FACTORY_CODE_HASH
    || !independentProviders(evidence?.providers)
    || !text(evidence?.eventName, 100) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(evidence.eventName)
    || !record(evidence.args)) return false;
  if (event.eventKey !== `genius:chain:${event.transactionHash}:${event.logIndex}:${event.blockHash}`
    || !instant(event.sourceOccurredAt)) return false;
  if (event.kind === "official_token_launch" && evidence.eventName !== "TokenLaunched") return false;
  if (event.kind === "official_token_lifecycle" && !TOKEN_LIFECYCLE_EVENTS.has(evidence.eventName)) return false;
  if (event.kind === "factory_config" && !FACTORY_EVENTS.has(evidence.eventName)) return false;
  if (event.kind !== "factory_config") {
    if (!address(event.token?.address) || !address(event.token?.curve)
      || event.token?.classification !== "official_wallet_associated"
      || !ROLES.has(lower(event.token?.deployer))) return false;
    if (lower(evidence.args.token) !== lower(event.token.address)) return false;
    if (event.kind === "official_token_launch" && (lower(evidence.args.deployer) !== lower(event.token.deployer)
      || lower(evidence.args.curve) !== lower(event.token.curve))) return false;
    for (const key of ["token", "tokenAddress"]) {
      if (evidence.args[key] != null && lower(evidence.args[key]) !== lower(event.token.address)) return false;
    }
    if (evidence.args.deployer != null && lower(evidence.args.deployer) !== lower(event.token.deployer)) return false;
    if (evidence.args.curve != null && lower(evidence.args.curve) !== lower(event.token.curve)) return false;
  }
  return event.officialTestToken !== true;
}

export function isGeniusOfficialEvent(event) {
  if (!record(event) || event.type !== "genius_fun_update" || event.platform !== "geniusfun"
    || event.chainId !== 56 || event.sourceTrust !== "official_verified"
    || !KINDS.has(event.kind) || !text(event.eventKey, 512) || !/^genius:[A-Za-z0-9:_./-]+$/.test(event.eventKey)
    || !instant(event.observedAt) || !sourceConsistency(event)) return false;
  if (event.sourceId === "genius_x") return xEvent(event);
  if (event.sourceId === "genius_chain") return chainEvent(event);
  return documentEvent(event);
}

export function isGeniusHistorical(event) {
  return event?.snapshot === true || event?.delayed === true || event?.historical === true
    || event?.baselineDiscovery === true || event?.firstObserved === true
    || ["snapshot", "delayed", "historical", "first_observed"].includes(event?.observationMode);
}

export const isStrictGeniusEvent = isGeniusOfficialEvent;
