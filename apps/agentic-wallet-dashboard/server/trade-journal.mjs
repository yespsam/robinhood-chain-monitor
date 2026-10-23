import { mkdir, lstat, chmod, open, readdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { Denied } from './auth.mjs';

export const TERMINAL_TRADE_STATES = new Set(['FINISHED', 'FAILED']);
const idPattern = /^[a-f0-9]{32}$/;
const states = new Set(['SUBMITTING', 'SUBMITTED', 'PENDING', 'PENDING_CONFIRMATION', 'UNKNOWN', ...TERMINAL_TRADE_STATES]);
const fields = new Set(['schema', 'intentId', 'reviewId', 'walletAddress', 'chainId', 'fromToken', 'toToken', 'amount',
  'slippage', 'mev', 'gasLevel', 'quotedOut', 'minimumReferenceOut', 'createdAt', 'updatedAt', 'submittedAt',
  'status', 'orderId', 'txHash', 'actualReceived', 'failureCode', 'requiresAppConfirmation']);
function validate(record) {
  if (!record || record.schema !== 1 || !idPattern.test(record.intentId) || !idPattern.test(record.reviewId)
      || Object.keys(record).some(k => !fields.has(k)) || !states.has(record.status)
      || record.chainId !== '56' || !/^0x[\da-f]{40}$/i.test(record.walletAddress)
      || ![record.fromToken, record.toToken].every(v => /^0x[\da-f]{40}$/i.test(v))
      || ![record.amount, record.slippage, record.quotedOut, record.minimumReferenceOut].every(v => typeof v === 'string' && /^\d{1,24}(\.\d{1,18})?$/.test(v))
      || record.mev !== true || record.gasLevel !== 'MEDIUM'
      || ![record.createdAt, record.updatedAt, record.submittedAt].every(Number.isSafeInteger)
      || (record.orderId !== null && (typeof record.orderId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(record.orderId)))
      || (record.txHash !== null && !/^0x[\da-f]{64}$/i.test(record.txHash))
      || (record.actualReceived !== null && (typeof record.actualReceived !== 'string' || !/^\d{1,24}(\.\d{1,18})?$/.test(record.actualReceived)))
      || (record.failureCode !== null && !/^[A-Z0-9_]{1,80}$/.test(record.failureCode))
      || typeof record.requiresAppConfirmation !== 'boolean') throw new Denied('TRADE_JOURNAL_INVALID', 503);
  return record;
}

// Contains public order/transaction fields only. Never persist a browser session or CLI output.
export class TradeJournal {
  constructor(directory) { if (typeof directory !== 'string' || !directory) throw new Error('journalDir required'); this.directory = directory; }
  async ready() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const p of [this.directory, dirname(this.directory)]) {
      const stat = await lstat(p);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Denied('TRADE_JOURNAL_UNSAFE_PATH', 503);
    }
    await chmod(this.directory, 0o700);
  }
  path(id) { if (!idPattern.test(id)) throw new Denied('INVALID_INTENT_ID', 400); return join(this.directory, id + '.json'); }
  async syncDirectory() { const f = await open(this.directory, 'r'); try { await f.sync(); } finally { await f.close(); } }
  async read(id) {
    await this.ready(); const path = this.path(id);
    try {
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const s = await file.stat(); if (!s.isFile() || s.size > 16384 || (s.mode & 0o077)) throw new Error();
        const record = validate(JSON.parse(await file.readFile('utf8')));
        if (record.intentId !== id) throw new Error(); return record;
      }
      finally { await file.close(); }
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Denied('TRADE_JOURNAL_INVALID', 503); }
  }
  async all() {
    await this.ready(); const names = await readdir(this.directory);
    const files = names.filter(n => n.endsWith('.json'));
    if (files.some(n => !/^[a-f0-9]{32}\.json$/.test(n)) || files.length > 10000) throw new Denied('TRADE_JOURNAL_INVALID', 503);
    return Promise.all(files.map(n => this.read(n.slice(0, -5))));
  }
  async exclusive(name, operation) {
    await this.ready(); const path = join(this.directory, name);
    let handle;
    try { handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Denied('TRADE_JOURNAL_BUSY', 409); throw error; }
    try { await handle.sync(); return await operation(); }
    finally { await handle.close(); await unlink(path); await this.syncDirectory(); }
  }
  // A process crash leaves this lock in place: never automatically reclaim a financial write lock.
  // Read-only status/list still work; recovery must first reconcile the recorded intent.
  withSubmissionLock(operation) { return this.exclusive('.submission-lock', operation); }
  async create(record) {
    validate(record); await this.ready(); const path = this.path(record.intentId);
    let f;
    try { f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Denied('TRADE_INTENT_EXISTS', 409); throw error; }
    try { await f.writeFile(JSON.stringify(record) + '\n'); await f.sync(); } finally { await f.close(); }
    await this.syncDirectory(); return record;
  }
  async update(id, patch) {
    return this.exclusive('.update-' + id, async () => {
      const old = await this.read(id); if (!old) throw new Denied('UNKNOWN_TRADE', 404);
      if (TERMINAL_TRADE_STATES.has(old.status)) return old;
      const next = validate({ ...old, ...patch });
      for (const k of ['intentId', 'reviewId', 'walletAddress', 'chainId', 'fromToken', 'toToken', 'amount', 'slippage', 'mev', 'gasLevel', 'quotedOut', 'minimumReferenceOut', 'createdAt', 'submittedAt']) {
        if (next[k] !== old[k]) throw new Denied('TRADE_INTENT_IMMUTABLE', 409);
      }
      if (old.orderId && next.orderId !== old.orderId) throw new Denied('TRADE_ORDER_ID_CHANGED', 409);
      const temp = join(this.directory, '.tmp-' + randomBytes(16).toString('hex'));
      const f = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await f.writeFile(JSON.stringify(next) + '\n'); await f.sync(); } finally { await f.close(); }
      await rename(temp, this.path(id)); await this.syncDirectory(); return next;
    });
  }
}
