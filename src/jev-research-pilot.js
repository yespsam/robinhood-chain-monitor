import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildJevShadowInput, probeJevShadow, validateJevAnswer, JEV_SHADOW_VERSION } from './jev-shadow-decision.js';
import { readTypesafeKey } from './typesafe-local-key.js';

export const JEV_PILOT_VERSION = 'jev_bounded_research_v1';
export const JEV_PILOT_FILE = 'jev-research-pilot.json';
const LIMIT = 30, DURATION = 3600000, OVERNIGHT_DURATION = 8 * 3600000, GAP = 10000;
const iso = ms => new Date(ms).toISOString();
const statuses = new Set(['evaluated', 'missing_key', 'insufficient_source', 'timeout', 'invalid_response', 'request_failed']);
const safeStatus = s => statuses.has(s) || /^http_\d{3}$/.test(s || '') ? s : 'request_failed';

// Market prices and passage of time must not turn one message into many bills.
export function jevResearchKey(input) {
  return createHash('sha256').update(JSON.stringify([JEV_SHADOW_VERSION, input.state.candidate.chain,
    input.state.candidate.address, input.state.source?.url, input.state.source?.excerpt])).digest('hex');
}

export async function createJevResearchPilot({ dataDir, sessionId, nowMs = Date.now(), durationMs = DURATION }) {
  if (!/^[a-z0-9_-]{1,100}$/i.test(sessionId || '') || !Number.isFinite(nowMs)) throw Error('invalid_pilot_session');
  if (![DURATION, OVERNIGHT_DURATION].includes(durationMs)) throw Error('invalid_pilot_duration');
  const state = { version: JEV_PILOT_VERSION, id: randomUUID(), sessionId, startedAt: nowMs,
    durationMs, expiresAt: nowMs + durationMs, maxCalls: LIMIT, halted: null, records: [] };
  // Explicit one-shot activation. Never overwrite or renew a previous budget.
  const handle = await fs.open(path.join(dataDir, JEV_PILOT_FILE), 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(state)); await handle.sync(); } finally { await handle.close(); }
  return state;
}

function validateState(s, sessionId) {
  const durationMs = s?.durationMs ?? DURATION;
  if (s?.version !== JEV_PILOT_VERSION || s.sessionId !== sessionId || typeof s.id !== 'string'
    || ![DURATION, OVERNIGHT_DURATION].includes(durationMs) || !Number.isFinite(s.startedAt)
    || s.expiresAt !== s.startedAt + durationMs || s.maxCalls !== LIMIT
    || s.halted !== null && !['persistence_error', 'request_failed'].includes(s.halted)
    || !Array.isArray(s.records) || s.records.length > LIMIT) throw Error('invalid_pilot');
  const keys = new Set(); let last = -Infinity;
  for (const r of s.records) {
    if (!/^[a-f0-9]{64}$/.test(r.key) || keys.has(r.key) || !Number.isFinite(r.requestedAt)
      || r.requestedAt < s.startedAt || r.requestedAt >= s.expiresAt || r.requestedAt - last < GAP
      || !Number.isFinite(r.sourceAt) || r.sourceAt > r.requestedAt
      || !r.candidate || typeof r.candidate.symbol !== 'string' || r.candidate.symbol.length > 64
      || typeof r.candidate.chain !== 'string' || typeof r.candidate.address !== 'string'
      || typeof r.sourceUrl !== 'string' || r.sourceUrl.length > 500) throw Error('invalid_pilot');
    buildJevShadowInput({ token: r.candidate }, r.requestedAt);
    if (r.result) {
      if (safeStatus(r.result.status) !== r.result.status || !Number.isFinite(r.finishedAt) || r.finishedAt < r.requestedAt) throw Error('invalid_pilot');
      if (r.result.status === 'evaluated') validateJevAnswer(r.result);
    }
    keys.add(r.key); last = r.requestedAt;
  }
}

async function save(file, state) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(state)); await handle.sync(); await handle.close(); handle = null;
    await fs.rename(temporary, file);
  } finally { await handle?.close(); await fs.unlink(temporary).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
}

// This component owns no ledger, wallet or signing dependency. One serialized
// background request; reserve to disk BEFORE contacting the billable provider.
export function createJevResearchMonitor({ dataDir, sessionId, now = Date.now,
  keyReader = readTypesafeKey, probe = probeJevShadow, persist = save } = {}) {
  const file = path.join(dataDir, JEV_PILOT_FILE), lock = `${file}.lock`, owner = randomUUID();
  let state = null, status = 'not_started', started = false, stopped = false, locked = false, job = null;
  let lastInspection = -Infinity, eligibleSources = 0;
  function liveStatus() {
    if (!state || !['active', 'in_flight'].includes(status)) return status;
    if (stopped) return 'stopped';
    if (now() < state.startedAt || now() >= state.expiresAt) return 'expired';
    if (job) return 'in_flight';
    return state.records.length >= LIMIT ? 'budget_exhausted' : 'active';
  }
  function hint(row, nowMs = now()) {
    if (!state || state.halted || !['active', 'in_flight', 'budget_exhausted'].includes(liveStatus())
      || nowMs < state.startedAt || nowMs >= state.expiresAt) return { adjustment: 0, label: '未采用模型调度' };
    let input;
    try { input = buildJevShadowInput(row, nowMs); } catch { return { adjustment: 0 }; }
    const c = input.localChecks, r = state.records.find(r => r.key === jevResearchKey(input)), a = r?.result?.answers;
    if (!c.sourceFresh || r?.result?.status !== 'evaluated' || !a || nowMs < r.finishedAt
      || nowMs - r.finishedAt > 900000 || nowMs - r.sourceAt > DURATION) return { adjustment: 0 };
    if (a.relationship.choice === 'unrelated' && a.relationship.confidence >= .8
      || a.event_status.choice === 'denied' && a.event_status.confidence >= .8) {
      return { adjustment: -20, label: '该条消息关联弱，降低消息研究加分', canExecute: false };
    }
    if (c.knownCaRelationship && !c.safetyBlocked && a.relationship.choice === 'explicit'
      && a.event_status.choice === 'claimed_completed' && ['token_mechanism', 'attention_only'].includes(a.demand_path.choice)
      && Object.values(a).every(v => v.confidence >= .8)) {
      return { adjustment: 20, label: '叙事优先复核；仍需行情和入场校验', canExecute: false };
    }
    return { adjustment: 0, label: '语义未确认，保留原研究顺序', canExecute: false };
  }
  async function request(row, input, key) {
    let apiKey;
    try { apiKey = await keyReader(); } catch { status = 'missing_key'; return; }
    if (!apiKey) { status = 'missing_key'; return; }
    if (stopped || now() >= state.expiresAt || now() < state.startedAt
      || !buildJevShadowInput(row, now()).localChecks.sourceFresh) return;
    const sourceTime = row.evidence.narrativeThesis.event.sourceAt;
    const requestedAt = now(), r = { key, candidate: input.state.candidate, sourceUrl: input.state.source.url,
      sourceAt: typeof sourceTime === 'number' ? sourceTime : Date.parse(sourceTime), requestedAt, result: null, finishedAt: null };
    state.records.push(r);
    try { await persist(file, state); }
    catch { state.halted = 'persistence_error'; status = 'persistence_error'; return; }
    // A crash here consumes one reservation and cannot retry it after restart.
    if (stopped || now() >= state.expiresAt) return;
    let result;
    try { result = await probe(row, { apiKey, nowMs: now(), timeoutMs: 2500 }); }
    catch { result = { status: 'request_failed' }; }
    apiKey = null;
    r.finishedAt = now();
    r.result = { status: safeStatus(result.status) };
    if (r.result.status === 'evaluated') {
      try { Object.assign(r.result, validateJevAnswer(result), {
        measuredLatencyMs: Number.isFinite(result.measuredLatencyMs) ? result.measuredLatencyMs : null }); }
      catch { r.result = { status: 'invalid_response' }; }
    }
    if (r.result.status !== 'evaluated') { state.halted = 'request_failed'; status = 'request_failed'; }
    try { await persist(file, state); }
    catch { state.halted = 'persistence_error'; status = 'persistence_error'; }
  }
  return {
    async start() {
      if (started || stopped) return; started = true;
      try {
        const st = await fs.lstat(file);
        if (!st.isFile() || st.isSymbolicLink() || st.size > 256000) throw Error('invalid_pilot');
        const handle = await fs.open(lock, 'wx', 0o600);
        locked = true;
        try { await handle.writeFile(JSON.stringify({ pid: process.pid, owner })); } finally { await handle.close(); }
        // Read budget AFTER owning the lock; never resume a stale pre-lock copy.
        state = JSON.parse(await fs.readFile(file, 'utf8')); validateState(state, sessionId);
        if (now() < state.startedAt || now() >= state.expiresAt) { status = 'expired'; return; }
        if (state.halted || state.records.some(r => !r.result)) { status = 'interrupted_or_failed'; return; }
        status = 'active';
      } catch (e) { status = e.code === 'ENOENT' ? 'disabled' : e.code === 'EEXIST' ? 'locked' : 'invalid_pilot'; state = null; }
    },
    // Never await a provider from the engine's single ledger queue.
    observe(rows) {
      if (stopped || job || liveStatus() !== 'active' || now() - lastInspection < 5000) return;
      lastInspection = now();
      const last = state.records.at(-1)?.requestedAt;
      if (last !== undefined && now() - last < GAP) return;
      const seen = new Set(state.records.map(r => r.key)), candidates = [];
      for (const row of rows) {
        let input;
        try { input = buildJevShadowInput(row, now()); } catch { continue; }
        if (!input.localChecks.sourceFresh || input.localChecks.safetyBlocked) continue;
        const key = jevResearchKey(input); if (seen.has(key)) continue; seen.add(key);
        candidates.push({ row, input, key });
      }
      eligibleSources = candidates.length;
      const selected = candidates.sort((a, b) => Number(b.input.localChecks.knownCaRelationship) - Number(a.input.localChecks.knownCaRelationship)
        || a.input.state.source.ageMs - b.input.state.source.ageMs || a.key.localeCompare(b.key))[0];
      if (!selected) return;
      job = request(selected.row, selected.input, selected.key).catch(() => { status = 'request_failed'; })
        .finally(() => { job = null; });
    },
    hint,
    snapshot() {
      return { version: JEV_PILOT_VERSION, status: liveStatus(), researchOnly: true, canExecute: false,
        sessionId, durationMs: state?.durationMs ?? DURATION, expiresAt: state ? iso(state.expiresAt) : null, maxCalls: LIMIT, minRequestGapMs: GAP,
        reservedCalls: state?.records.length || 0, evaluated: state?.records.filter(r => r.result?.status === 'evaluated').length || 0,
        eligibleSources, inputTokens: state?.records.reduce((n, r) => n + (r.result?.usage?.input_tokens || 0), 0) || 0,
        outputTokens: state?.records.reduce((n, r) => n + (r.result?.usage?.output_tokens || 0), 0) || 0,
        recent: state?.records.slice(-8).reverse().map(r => ({ id: r.key, candidate: { ...r.candidate },
          at: iso(r.finishedAt || r.requestedAt), status: r.result?.status || 'reserved',
          model: r.result?.model || null, measuredLatencyMs: r.result?.measuredLatencyMs ?? null,
          answers: r.result?.answers ? structuredClone(r.result.answers) : null })) || [] };
    },
    async drain() { await job; },
    async stop() {
      stopped = true; await job;
      if (locked) {
        try {
          const record = JSON.parse(await fs.readFile(lock, 'utf8'));
          if (record.owner === owner) await fs.unlink(lock);
        } catch (e) { if (e.code !== 'ENOENT') throw e; }
        locked = false;
      }
    }
  };
}
