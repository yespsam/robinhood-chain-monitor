import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isGmgnFlowEvent } from "./gmgn-flow-signal.js";
import { createProductionNarrativeShadowQuoteProvider } from "./narrative-shadow-quote-runtime.js";
import { NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID } from "./narrative-bsc-v2-quote-provider.js";
import { PAPER_100_POLICY, createPaperAccount, validatePaperAccount, evaluatePaperCandidate,
  openPaperPosition, markPaperPosition, paperAccountSummary } from "./paper-100-ledger.js";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MAX_INPUT_BYTES = 64 * 1024 * 1024, MAX_STATE_BYTES = 16 * 1024 * 1024;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const plain = value => Boolean(value && typeof value === "object" && !Array.isArray(value));
const validDate = value => typeof value === "string" && Number.isFinite(Date.parse(value));
const iso = now => new Date(now()).toISOString();
const inDirectory = (child, parent) => child === parent || (!path.relative(parent, child).startsWith(`..${path.sep}`)
  && path.relative(parent, child) !== ".." && !path.isAbsolute(path.relative(parent, child)));
const canonical = value => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
export const paperEventDigest = event => createHash("sha256").update(canonical(event)).digest("hex");
const orderId = eventKey => `shadow:${createHash("sha256").update(eventKey).digest("hex")}`;

export const PAPER_100_DEFAULTS = Object.freeze({
  dataDir: path.resolve(PROJECT, "..", "robinhood-chain-monitor-paper-100"),
  productionDataDir: path.join(PROJECT, "data"),
  sourceFiles: Object.freeze([path.join(PROJECT, "data", "alert-outbox.json"),
    path.join(PROJECT, "data", "fomo-alerts", "alert-outbox.json")]),
});

async function rejectSymlinks(filename) {
  const absolute = path.resolve(filename), parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try { if ((await fs.lstat(cursor)).isSymbolicLink()) throw new Error("paper_path_symlink_rejected"); }
    catch (error) { if (error.code === "ENOENT") break; throw error; }
  }
  return absolute;
}

async function readJson(filename, maximumBytes, optional = false) {
  await rejectSymlinks(filename);
  let handle;
  try {
    handle = await fs.open(filename, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const before = await handle.stat();
    if (!before.isFile() || before.size > maximumBytes) throw new Error("paper_input_not_bounded_regular_file");
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text) > maximumBytes) throw new Error("paper_input_too_large");
    const after = await handle.stat(), current = await fs.lstat(filename);
    if (current.isSymbolicLink() || before.ino !== after.ino || before.dev !== after.dev
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || current.ino !== after.ino || current.dev !== after.dev) throw new Error("paper_input_changed_during_read");
    return JSON.parse(text);
  } catch (error) { if (optional && error.code === "ENOENT") return null; throw error; }
  finally { await handle?.close(); }
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function atomicJson(filename, value) {
  await rejectSymlinks(filename);
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text) > MAX_STATE_BYTES) throw new Error("paper_state_capacity_exceeded");
  const temporary = `${filename}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null;
    await rejectSymlinks(filename); await fs.rename(temporary, filename); await syncDirectory(path.dirname(filename));
  } finally { await handle?.close().catch(() => {}); await fs.unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}

export function validatePaperReviews(value) {
  if (!plain(value) || value.version !== 1 || value.mode !== "independent_paper_review"
    || typeof value.reviewer !== "string" || !value.reviewer.trim() || value.reviewer.length > 200
    || !validDate(value.reviewedAt) || !Array.isArray(value.reviews) || value.reviews.length > 500) throw new Error("paper_review_schema_invalid");
  const seen = new Set();
  for (const review of value.reviews) {
    if (!plain(review) || typeof review.eventKey !== "string" || !review.eventKey || review.eventKey.length > 512
      || seen.has(review.eventKey) || !/^[0-9a-f]{64}$/.test(review.eventDigest)
      || review.chainId !== 56 || !ADDRESS.test(review.ca) || !ADDRESS.test(review.poolAddress)
      || /^0x0{40}$/.test(review.ca) || /^0x0{40}$/.test(review.poolAddress) || !plain(review.evidence)) {
      throw new Error("paper_review_binding_invalid");
    }
    seen.add(review.eventKey);
  }
  return value;
}

function candidateFor(event, review) {
  return {
    eventKey: event.eventKey, chainId: event.chain.id, ca: event.token.address,
    poolAddress: review?.poolAddress ?? null, symbol: String(event.token.symbol || "").slice(0, 40),
    observedAt: event.observedAt,
    narrative: { text: event.narrative.text, status: event.narrative.status, sourceUrl: event.narrative.sourceUrl },
    evidence: review ? structuredClone(review.evidence) : { observedAt: null, sourceUrls: [],
      sellSimulationPassed: false, contractControlsReviewed: false, lpLockOrBurnVerified: false,
      holderDistributionReviewed: false, independentWalletClusterVerified: false,
      buyTaxBps: null, sellTaxBps: null, liquidityUsd: null },
  };
}

function envelope(account, at) {
  return { version: 1, schema: "paper_100_runner_v1", account, updatedAt: at, seen: {}, lastRun: null };
}

function validateEnvelope(value) {
  if (!plain(value) || value.version !== 1 || value.schema !== "paper_100_runner_v1"
    || !validDate(value.updatedAt) || !plain(value.seen) || Object.keys(value.seen).length > 10_000) throw new Error("paper_runner_state_invalid");
  validatePaperAccount(value.account);
  for (const [key, record] of Object.entries(value.seen)) {
    if (!key || key.length > 512 || !plain(record) || !/^[0-9a-f]{64}$/.test(record.eventDigest)
      || !validDate(record.checkedAt) || !["opened", "watch"].includes(record.decision)
      || !Array.isArray(record.reasons) || record.reasons.some(reason => typeof reason !== "string")) throw new Error("paper_runner_seen_invalid");
  }
  return value;
}

function quoteRequest(provider, candidate, kind, at, position = null) {
  return { schema: "narrative_shadow_quote_request_v1", providerId: provider.providerId,
    mode: "shadow", executable: false, kind, orderId: position?.orderId || orderId(candidate.eventKey),
    chainId: candidate.chainId, ca: candidate.ca, poolAddress: candidate.poolAddress,
    maximumSlippageBps: 300, requestedAt: at, side: kind === "entry" ? "buy" : "sell",
    valueUsdMicros: kind === "entry" ? String(PAPER_100_POLICY.tradeUsdMicros) : null,
    quantityRaw: kind === "entry" ? null : position.quantityRaw };
}

/** Isolated paper account; the only optional network capability is a sealed read-only quote provider. */
export function createPaper100Runner(options = {}, dependencies = {}) {
  const now = dependencies.now || Date.now;
  const dataDir = path.resolve(options.dataDir || PAPER_100_DEFAULTS.dataDir);
  const productionDataDir = path.resolve(options.productionDataDir || PAPER_100_DEFAULTS.productionDataDir);
  const sourceFiles = (options.sourceFiles || PAPER_100_DEFAULTS.sourceFiles).map(file => path.resolve(file));
  const reviewFile = options.reviewFile ? path.resolve(options.reviewFile) : null;
  const liveQuotes = options.liveQuotes === true;
  const stateFile = path.join(dataDir, "paper-100-state.json"), lockFile = path.join(dataDir, ".paper-100.lock");
  if (!sourceFiles.length || sourceFiles.length > 4 || new Set(sourceFiles).size !== sourceFiles.length) throw new Error("paper_source_paths_invalid");
  let state = null, locked = false, lockToken = null, lockHandle = null, active = null, stopped = false, provider = null, stopping = null;
  const controllers = new Set();

  async function validatePaths() {
    const roots = [PAPER_100_DEFAULTS.productionDataDir, productionDataDir, ...sourceFiles.map(file => path.dirname(file))];
    for (const value of [dataDir, ...roots, ...sourceFiles]) await rejectSymlinks(value);
    if (dataDir === path.parse(dataDir).root || roots.some(root => inDirectory(dataDir, root) || inDirectory(root, dataDir))
      || (reviewFile && inDirectory(reviewFile, dataDir))) throw new Error("paper_output_overlaps_production_or_input");
  }

  async function lock() {
    if (locked) return;
    await validatePaths();
    await fs.mkdir(dataDir, { recursive: true, mode: 0o700 }); await rejectSymlinks(dataDir);
    lockToken = randomUUID();
    try { lockHandle = await fs.open(lockFile, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === "EEXIST") throw new Error("paper_writer_lock_exists_manual_review_required"); throw error; }
    locked = true;
    await lockHandle.writeFile(`${JSON.stringify({ token: lockToken, pid: process.pid, createdAt: iso(now) })}\n`);
    await lockHandle.sync(); await syncDirectory(dataDir);
  }

  async function readState() {
    const value = await readJson(stateFile, MAX_STATE_BYTES, true);
    return value === null ? null : validateEnvelope(value);
  }

  async function persist() {
    validateEnvelope(state); state.updatedAt = iso(now); await atomicJson(stateFile, state);
  }

  async function quoteProvider() {
    if (!liveQuotes) return null;
    if (provider) return provider;
    const config = { narrativeSniperEnabled: true, narrativeShadowSimulatorEnabled: true,
      narrativeShadowQuoteRpcUrls: options.rpcUrls, narrativeShadowProviderTimeoutMs: 30_000,
      narrativeShadowQuoteRpcBudgetMs: 25_000, narrativeShadowQuoteRpcRequestTimeoutMs: 5_000 };
    provider = (dependencies.quoteProviderFactory || createProductionNarrativeShadowQuoteProvider)(config);
    if (!provider || provider.providerId !== NARRATIVE_BSC_V2_QUOTE_PROVIDER_ID
      || provider.trusted !== true || provider.readOnly !== true
      || Object.keys(provider).sort().join(",") !== ["checkCanonicalBlock", "getEntryQuote", "getPositionMark", "providerId", "readOnly", "trusted"].sort().join(",")) {
      provider = null; throw new Error("paper_quote_provider_capability_invalid");
    }
    return provider;
  }

  async function boundedCall(method, request) {
    if (stopped) throw new Error("paper_runner_stopped");
    const controller = new AbortController(); controllers.add(controller);
    let timer, abort;
    try {
      return await Promise.race([
        Promise.resolve().then(() => method(request, { signal: controller.signal })),
        new Promise((_, reject) => {
          abort = () => reject(new Error("paper_quote_cancelled"));
          controller.signal.addEventListener("abort", abort, { once: true });
          timer = setTimeout(() => controller.abort(), 30_000); timer.unref?.();
        }),
      ]);
    } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); controllers.delete(controller); }
  }

  async function isCanonicalQuoteBlock(reader, candidate, quote) {
    if (!quote || quote.status !== "ok" || quote.providerId !== reader.providerId
      || !Number.isSafeInteger(quote.blockNumber) || !/^0x[0-9a-f]{64}$/.test(quote.blockHash)) return false;
    const canonicalBlock = await boundedCall(reader.checkCanonicalBlock, {
      schema: "narrative_shadow_canonical_request_v1", providerId: reader.providerId,
      mode: "shadow", executable: false, chainId: candidate.chainId, blockNumber: quote.blockNumber,
      expectedBlockHash: quote.blockHash, requestedAt: iso(now),
    });
    if (stopped) throw new Error("paper_runner_stopped");
    if (canonicalBlock?.status !== "ok" || canonicalBlock.providerId !== reader.providerId
      || canonicalBlock.chainId !== candidate.chainId || canonicalBlock.blockNumber !== quote.blockNumber
      || canonicalBlock.blockHash !== quote.blockHash || !validDate(canonicalBlock.observedAt)
      || Date.parse(canonicalBlock.observedAt) > now() || now() - Date.parse(canonicalBlock.observedAt) > 5000) return false;
    return true;
  }

  async function canonicalQuote(candidate, kind, position = null) {
    const reader = await quoteProvider();
    // A fresh mark cannot legitimize an entry whose original chain anchor was reorged.
    // Check the old anchor first so this read does not consume the new quote's freshness budget.
    if (kind === "mark" && !await isCanonicalQuoteBlock(reader, candidate, position?.entryQuote)) return null;
    const quote = await boundedCall(kind === "entry" ? reader.getEntryQuote : reader.getPositionMark,
      quoteRequest(reader, candidate, kind, iso(now), position));
    if (stopped) throw new Error("paper_runner_stopped");
    if (!await isCanonicalQuoteBlock(reader, candidate, quote)) return null;
    return { ...quote, canonicalVerified: true };
  }

  async function inputs() {
    const events = new Map(), issues = [];
    for (const file of sourceFiles) {
      let payload;
      try { payload = await readJson(file, MAX_INPUT_BYTES, true); }
      catch { issues.push({ source: file, reason: "outbox_unreadable_or_changed" }); continue; }
      if (payload === null) { issues.push({ source: file, reason: "outbox_missing" }); continue; }
      if (!plain(payload?.events) || Object.keys(payload.events).length > 50_000) { issues.push({ source: file, reason: "outbox_schema_invalid" }); continue; }
      for (const entry of Object.values(payload.events)) {
        const event = entry?.event;
        if (event?.type !== "gmgn_flow_surge") continue;
        if (!isGmgnFlowEvent(event, { nowMs: now() })) { issues.push({ source: file, reason: "gmgn_event_invalid_or_stale" }); continue; }
        const digest = paperEventDigest(event), old = events.get(event.eventKey);
        if (old && old.digest !== digest) events.set(event.eventKey, { ...old, conflict: true });
        else if (!old) events.set(event.eventKey, { event, digest, conflict: false });
      }
    }
    let review = null;
    if (reviewFile) {
      try { review = validatePaperReviews(await readJson(reviewFile, 2 * 1024 * 1024)); }
      catch { issues.push({ source: reviewFile, reason: "paper_review_unreadable_or_invalid" }); }
    }
    return { events: [...events.values()].sort((a, b) => a.event.observedAt.localeCompare(b.event.observedAt)), review, issues };
  }

  async function run() {
    await lock(); if (stopped) throw new Error("paper_runner_stopped");
    state = await readState() || envelope(createPaperAccount(iso(now)), iso(now));
    const input = await inputs(), decisions = [];
    const reviews = new Map((input.review?.reviews || []).map(review => [review.eventKey, review]));
    const reviewDigest = input.review ? paperEventDigest(input.review) : null;
    for (const position of Object.values(state.account.positions || {})) {
      if (stopped) throw new Error("paper_runner_stopped");
      let quote = null;
      if (liveQuotes) { try { quote = await canonicalQuote(position.candidate, "mark", position); } catch { if (stopped) throw new Error("paper_runner_stopped"); } }
      const result = markPaperPosition(state.account, position.id || position.orderId, quote, iso(now));
      state.account = result.state;
      decisions.push({ eventKey: position.candidate.eventKey, decision: result.decision, reasons: result.reasons });
      await persist();
    }
    const selected = input.events.slice(-100);
    if (input.events.length > selected.length) input.issues.push({ reason: "candidate_budget_limited", omitted: input.events.length - selected.length });
    for (const { event, digest, conflict } of selected) {
      if (stopped) throw new Error("paper_runner_stopped");
      const previous = state.seen[event.eventKey];
      if (previous?.decision === "opened") continue;
      if (previous?.eventDigest === digest && previous.reviewDigest === reviewDigest && previous.liveQuotes === liveQuotes
        && Date.parse(previous.checkedAt) + 60_000 > now()) continue;
      const supplied = reviews.get(event.eventKey);
      const bound = supplied && supplied.chainId === event.chain.id && supplied.ca === event.token.address
        && supplied.eventDigest === digest;
      const candidate = candidateFor(event, bound ? supplied : null);
      if (bound) candidate.reviewProvenance = { reviewer: input.review.reviewer, reviewedAt: input.review.reviewedAt,
        fileDigest: reviewDigest, eventDigest: digest,
        meaning: "user_supplied_paper_attestation_not_independently_verified_by_runner" };
      let reasons = [...evaluatePaperCandidate(candidate, iso(now))];
      if (!bound) reasons.unshift(supplied ? "paper_review_binding_mismatch" : "independent_paper_review_missing");
      if (conflict || (previous && previous.eventDigest !== digest)) reasons.unshift("source_event_digest_conflict");
      if (input.review && (Date.parse(input.review.reviewedAt) > now() + 30_000 || Date.parse(input.review.reviewedAt) < now() - 300_000)) reasons.unshift("paper_review_timestamp_invalid");
      if (!liveQuotes) reasons.push("live_quotes_disabled");
      let decision = "watch";
      if (!reasons.length) reasons.push(...openPaperPosition(state.account, candidate, null, iso(now)).reasons
        .filter(reason => reason !== "unverified_quote"));
      if (!reasons.length) {
        let quote = null;
        try { quote = await canonicalQuote(candidate, "entry"); }
        catch { if (stopped) throw new Error("paper_runner_stopped"); reasons.push("quote_provider_unavailable"); }
        if (quote) {
          const result = openPaperPosition(state.account, candidate, quote, iso(now));
          state.account = result.state; decision = result.decision; reasons = result.reasons;
        } else if (!reasons.length) reasons.push("quote_not_canonically_verified");
      }
      if (!previous && Object.keys(state.seen).length >= 10_000) throw new Error("paper_seen_capacity_exceeded");
      state.seen[event.eventKey] = { eventDigest: previous?.eventDigest || digest, reviewDigest, liveQuotes,
        decision, reasons: [...new Set(reasons)], checkedAt: iso(now) };
      decisions.push({ eventKey: event.eventKey, eventDigest: digest, chain: event.chain.slug, ca: event.token.address,
        decision, reasons: [...new Set(reasons)], reviewProvenance: candidate.reviewProvenance || null });
      await persist();
    }
    state.lastRun = { checkedAt: iso(now), mode: liveQuotes ? "paper_live_read_only_quotes" : "observation_only",
      decisions, sourceIssues: input.issues, execution: false, signing: false, broadcast: false };
    await persist();
    return { ...state.lastRun, account: paperAccountSummary(state.account, iso(now)), stateFile };
  }

  function runOnce() {
    if (stopped) return Promise.reject(new Error("paper_runner_stopped"));
    if (!active) active = run().finally(() => { active = null; });
    return active;
  }
  async function status() {
    await validatePaths(); const saved = await readState();
    return { status: saved ? "initialized" : "not_initialized", stateFile, execution: false,
      account: saved ? paperAccountSummary(saved.account, iso(now)) : null, lastRun: saved?.lastRun || null };
  }
  function stop() {
    if (stopping) return stopping;
    stopped = true;
    stopping = (async () => {
      for (const controller of controllers) controller.abort();
      await active?.catch(() => {});
      if (locked) {
        await lockHandle?.close(); lockHandle = null;
        const current = await readJson(lockFile, 4096);
        if (current?.token !== lockToken) throw new Error("paper_writer_lock_identity_changed");
        await fs.unlink(lockFile); await syncDirectory(dataDir); locked = false;
      }
    })();
    return stopping;
  }
  return Object.freeze({ runOnce, status, stop, stateFile });
}
