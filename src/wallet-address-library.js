import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { gmgnFlowAddress, gmgnFlowTags } from './gmgn-flow-signal.js';

export const ADDRESS_LIBRARY_VERSION = 'public_wallet_archive_v1';
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = value => typeof value === 'number' ? value : Date.parse(value || '');
const validTime = (value, now) => Number.isSafeInteger(value) && value > 0 && value <= now + 30_000;
const hashOK = (chain, value) => typeof value === 'string' && (chain === 'sol'
  ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/ : /^0x[\da-fA-F]{64}$/).test(value);
const profileFields = ['realizedProfitUsd', 'realizedRoi', 'winRate', 'tokenCount', 'buyCount', 'sellCount',
  'createdAt', 'lastTradeAt', 'createdTokenCount', 'unrealizedProfitUsd'];
const positive = value => Number.isFinite(value) && value > 0 ? value : null;

// Cold research evidence only. Nothing in this module authorizes a trade, marks
// an address as controlled by an operator, or refreshes a profile's checkedAt.
// All input is from the already-collected public feeds, never private holdings.
export function createWalletAddressLibrary({ dataDir, now = Date.now } = {}) {
  const file = path.join(dataDir, 'wallet-address-library.sqlite');
  let db, statements, active, stopped = false, status = null;
  async function initialize() {
    if (db) return;
    await fs.mkdir(dataDir, { recursive: true });
    const handle = await fs.open(file, 'a', 0o600); await handle.close();
    const candidate = new DatabaseSync(file, { timeout: 100 });
    try {
      candidate.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
        PRAGMA cache_size=-2048; PRAGMA max_page_count=262144;
        CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS addresses (
          key TEXT PRIMARY KEY, chain TEXT NOT NULL, wallet TEXT NOT NULL,
          first_observed_at INTEGER, last_observed_at INTEGER,
          first_recorded_at INTEGER NOT NULL) STRICT;
        CREATE TABLE IF NOT EXISTS sources (key TEXT NOT NULL REFERENCES addresses(key), source TEXT NOT NULL,
          first_at INTEGER, last_at INTEGER, PRIMARY KEY(key,source)) STRICT;
        CREATE TABLE IF NOT EXISTS labels (key TEXT NOT NULL REFERENCES addresses(key), source TEXT NOT NULL,
          tag TEXT NOT NULL, PRIMARY KEY(key,source,tag)) STRICT;
        CREATE TABLE IF NOT EXISTS profiles (key TEXT NOT NULL REFERENCES addresses(key), period TEXT NOT NULL,
          checked_at INTEGER NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, negative INTEGER NOT NULL,
          PRIMARY KEY(key,period,checked_at,digest)) STRICT;
        CREATE TABLE IF NOT EXISTS events (key TEXT NOT NULL REFERENCES addresses(key), token TEXT NOT NULL,
          tx TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY(key,token,tx)) STRICT;
        CREATE TABLE IF NOT EXISTS evidence (key TEXT NOT NULL, token TEXT NOT NULL, tx TEXT NOT NULL,
          source TEXT NOT NULL, digest TEXT NOT NULL, side TEXT NOT NULL, payload TEXT NOT NULL,
          PRIMARY KEY(key,token,tx,source,digest), FOREIGN KEY(key,token,tx) REFERENCES events(key,token,tx)) STRICT;
        CREATE TABLE IF NOT EXISTS coverage (key TEXT NOT NULL REFERENCES addresses(key), digest TEXT NOT NULL,
          payload TEXT NOT NULL, PRIMARY KEY(key,digest)) STRICT;
        CREATE TABLE IF NOT EXISTS checkpoints (key TEXT PRIMARY KEY, digest TEXT NOT NULL) STRICT;
        CREATE INDEX IF NOT EXISTS profile_time ON profiles(key,checked_at);
        CREATE INDEX IF NOT EXISTS event_time ON events(at);`);
      const version = candidate.prepare("SELECT value FROM metadata WHERE key='version'").get()?.value;
      if (version && version !== ADDRESS_LIBRARY_VERSION) throw Error('library_version');
      candidate.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('version', ADDRESS_LIBRARY_VERSION);
      db = candidate;
      statements = {
        address: db.prepare(`INSERT INTO addresses VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET
          first_observed_at=CASE WHEN excluded.first_observed_at IS NULL THEN first_observed_at
            WHEN first_observed_at IS NULL THEN excluded.first_observed_at ELSE MIN(first_observed_at,excluded.first_observed_at) END,
          last_observed_at=CASE WHEN excluded.last_observed_at IS NULL THEN last_observed_at
            WHEN last_observed_at IS NULL THEN excluded.last_observed_at ELSE MAX(last_observed_at,excluded.last_observed_at) END`),
        source: db.prepare(`INSERT INTO sources VALUES (?,?,?,?) ON CONFLICT(key,source) DO UPDATE SET
          first_at=COALESCE(MIN(first_at,excluded.first_at),first_at,excluded.first_at),
          last_at=COALESCE(MAX(last_at,excluded.last_at),last_at,excluded.last_at)`),
        label: db.prepare('INSERT OR IGNORE INTO labels VALUES (?,?,?)'),
        profile: db.prepare('INSERT OR IGNORE INTO profiles VALUES (?,?,?,?,?,?)'),
        event: db.prepare('INSERT OR IGNORE INTO events VALUES (?,?,?,?)'),
        evidence: db.prepare('INSERT OR IGNORE INTO evidence VALUES (?,?,?,?,?,?,?)'),
        coverage: db.prepare('INSERT OR IGNORE INTO coverage VALUES (?,?,?)'),
        checkpoint: db.prepare('INSERT OR REPLACE INTO checkpoints VALUES (?,?)'),
        prior: db.prepare('SELECT digest FROM checkpoints WHERE key=?'),
      };
    } catch (error) { candidate.close(); throw error; }
  }
  function* observations({ state = {}, flow = {}, leaderboard = null, activity = null, nowMs }) {
    function* address(chain, input, tags, source, times = []) {
      const wallet = gmgnFlowAddress(chain, input); if (!wallet) return;
      const key = `${chain}:${wallet}`, valid = times.map(stamp).filter(t => validTime(t, nowMs));
      const first = valid.length ? Math.min(...valid) : null, last = valid.length ? Math.max(...valid) : null;
      yield ['address', [key, chain, wallet, first, last, nowMs]];
      yield ['source', [key, source, first, last]];
      for (const tag of gmgnFlowTags(tags).filter(t => t.length <= 100).slice(0, 100)) yield ['label', [key, source, tag]];
    }
    function* profiles(chain, input, values) {
      const wallet = gmgnFlowAddress(chain, input); if (!wallet) return;
      for (const period of ['7d', '30d']) {
        const p = values?.[period], checkedAt = stamp(p?.checkedAt);
        if (!p || p.chain !== chain || gmgnFlowAddress(chain, p.wallet) !== wallet || p.period !== period || !validTime(checkedAt, nowMs)) continue;
        const payload = { chain, wallet, period, checkedAt: p.checkedAt,
          ...Object.fromEntries(profileFields.map(k => [k, Number.isFinite(p[k]) ? p[k] : null])),
          tags: gmgnFlowTags(p.tags).filter(t => t.length <= 100).slice(0, 100) };
        yield* address(chain, wallet, payload.tags, 'gmgn_profile', [p.lastTradeAt * 1000]);
        yield ['profile', [`${chain}:${wallet}`, period, checkedAt, hash(payload), JSON.stringify(payload), Number(p.realizedProfitUsd < 0)]];
      }
    }
    function* event(row, source, expected = null) {
      const chain = row.chain, wallet = gmgnFlowAddress(chain, row.wallet), token = gmgnFlowAddress(chain, row.token ?? row.tokenAddress);
      if (!wallet || !token || !hashOK(chain, row.hash) || !validTime(row.at, nowMs)
        || expected && (chain !== expected.chain || wallet !== expected.wallet)) return;
      const tx = chain === 'sol' ? row.hash : row.hash.toLowerCase();
      const quantity = positive(row.quantity ?? row.baseAmount), usd = positive(row.usd ?? row.amountUsd);
      const side = ['buy', 'sell'].includes(row.side) && quantity && usd ? row.side : 'unattributable';
      const payload = { chain, wallet, token, hash: tx, at: row.at, side,
        quantity, usd, price: positive(row.price), symbol: String(row.symbol || '').slice(0, 40) };
      yield* address(chain, wallet, row.tags, source, [row.at]);
      yield ['event', [`${chain}:${wallet}`, token, tx, row.at]];
      // Distinct source variants are retained, not added as extra trades/P&L.
      yield ['evidence', [`${chain}:${wallet}`, token, tx, source, hash({ ...payload, symbol: '' }), side, JSON.stringify(payload)]];
    }
    for (const [key, p] of Object.entries(flow.profiles || {})) {
      const [chain, wallet] = key.split(':'); yield* profiles(chain, wallet, p);
    }
    for (const rows of Object.values(flow.trades || {})) for (const row of rows) yield* event(row, 'gmgn_public_feed');
    for (const w of leaderboard?.entries || []) yield* address(w.chain, w.wallet, w.tags, 'profit_leaderboard', [w.lastObservedAt]);
    for (const [lane, wallets] of Object.entries({ universe: state.universe, deep: state.wallets, archive: state.walletArchive })) {
      for (const [key, w] of Object.entries(wallets || {})) {
        const wallet = gmgnFlowAddress(w.chain, w.wallet);
        if (!wallet || key !== `${w.chain}:${wallet}` || w.key !== key) continue;
        const version = hash(w), checkpoint = `${lane}:${key}`;
        if (statements.prior.get(checkpoint)?.digest === version) continue;
        yield* address(w.chain, wallet, w.tags, `learning_${lane}`, [w.firstSeenAt, w.lastObservedAt]);
        yield* profiles(w.chain, wallet, w.profile);
        const coverage = { checkedAt: w.checkedAt || null, historyGap: w.historyGap === true, pages: w.pages ?? null,
          backfillComplete: w.backfillComplete === true, olderPagePending: !!w.nextCursor,
          rowsRetainedBySource: w.rows?.length ?? 0, firstSeenAt: w.firstSeenAt || null };
        yield ['coverage', [key, hash(coverage), JSON.stringify(coverage)]];
        for (const row of w.rows || []) yield* event(row, 'gmgn_activity', { chain: w.chain, wallet });
        // Checkpoint follows evidence: a crash can only replay, never skip rows.
        yield ['checkpoint', [checkpoint, version]];
      }
    }
    if (activity) for (const row of activity.rows || []) yield* event(row, 'gmgn_activity', activity);
  }
  function report(nowMs, elapsedMs, added) {
    const count = table => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    return { version: ADDRESS_LIBRARY_VERSION, status: 'ok', updatedAt: new Date(nowMs).toISOString(),
      addresses: count('addresses'), events: count('events'), profileSnapshots: count('profiles'),
      evidenceVariants: count('evidence'), coverageSnapshots: count('coverage'),
      byChain: db.prepare('SELECT chain,COUNT(*) AS addresses FROM addresses GROUP BY chain ORDER BY chain').all(),
      negativeProfileSamples: db.prepare('SELECT COUNT(*) AS n FROM profiles WHERE negative=1').get().n,
      unattributableEvents: db.prepare("SELECT COUNT(*) AS n FROM (SELECT key,token,tx FROM evidence WHERE side='unattributable' GROUP BY key,token,tx)").get().n,
      conflictingEvents: db.prepare('SELECT COUNT(*) AS n FROM (SELECT key,token,tx,source FROM evidence GROUP BY key,token,tx,source HAVING COUNT(*)>1)').get().n,
      addedAddresses: added, elapsedMs, lastError: null, autoFollow: false,
      note: '公开来源历史档案；不等于合格教师、独立交易者或完整链上覆盖。不自动跟单，不从档案续期盈利资格。' };
  }
  async function ingest(input) {
    const started = performance.now(), nowMs = input.nowMs ?? now();
    try {
      await initialize();
      const before = db.prepare('SELECT COUNT(*) AS n FROM addresses').get().n;
      let batch = [];
      const commit = () => {
        db.exec('BEGIN IMMEDIATE');
        try { for (const [kind, args] of batch) statements[kind].run(...args); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
        batch = [];
      };
      for (const operation of observations({ ...input, nowMs })) {
        batch.push(operation);
        if (batch.length >= 200) { commit(); await yieldTurn(); }
      }
      if (batch.length) commit();
      const after = db.prepare('SELECT COUNT(*) AS n FROM addresses').get().n;
      status = report(nowMs, Math.round(performance.now() - started), after - before);
      db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run('summary', JSON.stringify(status));
    } catch {
      // Archive failure is visible, never a reason to stop live monitoring or
      // erase the learning roster. Completed batches are safe to replay.
      status = { ...status, version: ADDRESS_LIBRARY_VERSION, status: 'error', lastError: 'address_library_write_failed',
        attemptedAt: new Date(nowMs).toISOString(), autoFollow: false };
    }
    return snapshot();
  }
  function snapshot() { return status ? structuredClone(status) : { version: ADDRESS_LIBRARY_VERSION, status: 'pending', autoFollow: false }; }
  return { file, snapshot,
    capture(input = {}) {
      if (stopped) return Promise.resolve(snapshot());
      if (active) return active;
      active = ingest(input).finally(() => { active = null; }); return active;
    },
    async stop() { stopped = true; await active; db?.close(); db = null; },
  };
}
