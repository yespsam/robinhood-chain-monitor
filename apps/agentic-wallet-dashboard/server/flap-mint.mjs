import { randomBytes } from 'node:crypto';
import { mkdir, lstat, chmod, open, readdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { Denied } from './auth.mjs';
import { validContract, NATIVE, decimal } from './model.mjs';

export const FLAP_BSC_PORTAL = '0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0';
export const FLAP_NEW_TOKEN_SELECTOR = '2ca9cd6d';
const idPattern = /^[a-f0-9]{32}$/;
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const txHashPattern = /^0x[\da-f]{64}$/i;
const statuses = new Set(['SUBMITTING', 'BROADCASTED', 'PENDING_CONFIRMATION', 'UNKNOWN', 'FAILED']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const id = () => randomBytes(16).toString('hex');
const fields = (v, names) => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !names.includes(k))) throw new Denied('INVALID_MINT_FIELDS', 400);
};
const cleanText = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const word = value => BigInt(value).toString(16).padStart(64, '0');
function abiString(value) {
  const bytes = Buffer.from(value, 'utf8');
  const padded = Math.ceil(bytes.length / 32) * 32;
  return word(bytes.length) + bytes.toString('hex').padEnd(padded * 2, '0');
}

// Only the fixed Flap Portal method is encoded. User input can never select a
// contract, selector, transaction value, or arbitrary calldata.
export function encodeFlapNewToken({ name, symbol, metadataUri }) {
  const args = mintInput({ name, symbol, metadataUri });
  const parts = [args.name, args.symbol, args.metadataUri].map(abiString);
  const offsets = [];
  let offset = 96;
  for (const part of parts) { offsets.push(word(offset)); offset += part.length / 2; }
  return '0x' + FLAP_NEW_TOKEN_SELECTOR + offsets.join('') + parts.join('');
}

function mintInput(value) {
  fields(value, ['name', 'symbol', 'metadataUri']);
  const name = cleanText(value.name, 32), symbol = cleanText(value.symbol, 12), metadataUri = cleanText(value.metadataUri, 300);
  if (!name || !name.trim() || !/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,31}$/.test(name) ||
      !symbol || !/^[A-Za-z0-9]{1,12}$/.test(symbol)) throw new Denied('INVALID_MINT_METADATA', 400);
  if (!metadataUri || metadataUri.trim() !== metadataUri) throw new Denied('INVALID_MINT_METADATA_URI', 400);
  if (metadataUri.startsWith('ipfs://')) {
    if (!/^ipfs:\/\/[A-Za-z0-9][A-Za-z0-9./_-]{0,290}$/.test(metadataUri)) throw new Denied('INVALID_MINT_METADATA_URI', 400);
  } else {
    let url;
    try { url = new URL(metadataUri); } catch { throw new Denied('INVALID_MINT_METADATA_URI', 400); }
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 300) throw new Denied('INVALID_MINT_METADATA_URI', 400);
  }
  return { name, symbol, metadataUri };
}

function safeRiskDetails(risks) {
  if (!risks || typeof risks !== 'object' || Array.isArray(risks) || !Array.isArray(risks.riskDetails) || risks.riskDetails.length > 50 ||
      !risks.addresses || typeof risks.addresses !== 'object' || Array.isArray(risks.addresses) ||
      !Array.isArray(risks.riskBehaviors) || risks.riskBehaviors.length > 50) throw new Denied('MINT_PREVIEW_INCOMPLETE', 503);
  const riskDetails = risks.riskDetails.map(item => {
    if (!item || !['RISK', 'CAUTION'].includes(item.riskType)) throw new Denied('MINT_PREVIEW_INCOMPLETE', 503);
    return { code: cleanText(item.code, 80), title: cleanText(item.title, 160), description: cleanText(item.description, 500), riskType: item.riskType };
  });
  const addresses = {};
  for (const [address, item] of Object.entries(risks.addresses)) {
    validContract('56', address);
    if (!item || !Number.isInteger(item.riskLevel) || item.riskLevel < 0 || item.riskLevel > 5 || !Array.isArray(item.riskDetails) || item.riskDetails.length > 50)
      throw new Denied('MINT_PREVIEW_INCOMPLETE', 503);
    addresses[address] = { riskLevel: item.riskLevel, riskDetails: item.riskDetails.map(x => ({
      code: cleanText(x?.code, 80), title: cleanText(x?.title, 160), description: cleanText(x?.description, 500),
      riskType: ['RISK', 'CAUTION'].includes(x?.riskType) ? x.riskType : 'UNKNOWN'
    })) };
  }
  const riskBehaviors = risks.riskBehaviors.map(item => {
    if (!item || typeof item !== 'object') throw new Denied('MINT_PREVIEW_INCOMPLETE', 503);
    return { code: cleanText(item.code, 80), title: cleanText(item.title, 160), description: cleanText(item.description, 500),
      riskType: ['RISK', 'CAUTION'].includes(item.riskType) ? item.riskType : 'UNKNOWN' };
  });
  return { riskDetails, addresses, riskBehaviors };
}

function normalizePreview(data, expected) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !requestPattern.test(data.requestId || '') ||
      !data.parsedTx || typeof data.parsedTx !== 'object' || Array.isArray(data.parsedTx) ||
      !data.simulationResult || typeof data.simulationResult !== 'object' || Array.isArray(data.simulationResult)) throw new Denied('MINT_PREVIEW_INCOMPLETE', 503);
  const parsedTx = data.parsedTx, simulation = data.simulationResult;
  const target = parsedTx.contractAddress || parsedTx.to;
  const parsedValue = parsedTx.value ?? parsedTx.amount;
  const isZeroValue = parsedValue === undefined || parsedValue === null || parsedValue === 0 ||
    typeof parsedValue === 'string' && (/^0+$/.test(parsedValue) || /^0x0+$/i.test(parsedValue));
  if (!target || !same(validContract('56', target), FLAP_BSC_PORTAL) ||
      !isZeroValue ||
      simulation.simulationCode !== '000000000' || !['', '000000000', undefined].includes(simulation.preCheckCode) ||
      !Array.isArray(simulation.authorityChanges) || !Array.isArray(simulation.allowanceChanges) ||
      simulation.authorityChanges.length > 50 || simulation.allowanceChanges.length > 50 ||
      simulation.authorityChanges.length > 0 || simulation.allowanceChanges.length > 0) throw new Denied('MINT_PREVIEW_BLOCKED', 403);
  const risks = safeRiskDetails(data.risks);
  const hardRisk = risks.riskDetails.some(x => x.riskType === 'RISK') || risks.riskBehaviors.some(x => x.riskType === 'RISK') ||
    Object.values(risks.addresses).some(x => x.riskLevel >= 4 || x.riskDetails.some(d => d.riskType === 'RISK'));
  if (hardRisk) throw new Denied('MINT_PREVIEW_BLOCKED', 403);
  const balanceChanges = Array.isArray(simulation.balanceChanges) ? simulation.balanceChanges.slice(0, 50).map(x => {
    if (!x || typeof x !== 'object') throw new Denied('MINT_PREVIEW_INCOMPLETE', 503);
    return { token: cleanText(x.token || x.symbol || x.contractAddress, 160), before: cleanText(x.before, 100), after: cleanText(x.after, 100), change: cleanText(x.change || x.amount, 100) };
  }) : null;
  const caution = risks.riskDetails.some(x => x.riskType === 'CAUTION') || risks.riskBehaviors.some(x => x.riskType === 'CAUTION') ||
    Object.values(risks.addresses).some(x => x.riskDetails.some(d => d.riskType === 'CAUTION')) || data.requireConfirmation === true || balanceChanges === null;
  return { requestId: data.requestId, parsedTx: structuredClone(parsedTx), risks, authorityChanges: simulation.authorityChanges,
    allowanceChanges: simulation.allowanceChanges, balanceChanges, requireConfirmation: data.requireConfirmation === true,
    expiresAt: Number.isSafeInteger(data.expiresAt) ? data.expiresAt : null, requiresRiskAcknowledgment: caution,
    walletAddress: expected.walletAddress, name: expected.name, symbol: expected.symbol, metadataUri: expected.metadataUri,
    chainId: '56', portal: FLAP_BSC_PORTAL, valueWei: '0', executable: true };
}

const recordKeys = new Set(['schema', 'intentId', 'walletAddress', 'chainId', 'portal', 'name', 'symbol', 'metadataUri',
  'createdAt', 'updatedAt', 'submittedAt', 'status', 'orderId', 'txHash', 'failureCode', 'requiresAppConfirmation']);
function validateRecord(record) {
  if (!record || record.schema !== 1 || !idPattern.test(record.intentId) || Object.keys(record).some(k => !recordKeys.has(k)) ||
      !['56'].includes(record.chainId) || !/^0x[\da-f]{40}$/i.test(record.walletAddress) || !same(record.portal, FLAP_BSC_PORTAL) ||
      !cleanText(record.name, 32) || !/^[A-Za-z0-9]{1,12}$/.test(record.symbol) || !cleanText(record.metadataUri, 300) || !statuses.has(record.status) ||
      ![record.createdAt, record.updatedAt, record.submittedAt].every(Number.isSafeInteger) ||
      (record.orderId !== null && (typeof record.orderId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(record.orderId))) ||
      (record.txHash !== null && !txHashPattern.test(record.txHash)) ||
      (record.failureCode !== null && (typeof record.failureCode !== 'string' || !/^[A-Z0-9_]{1,80}$/.test(record.failureCode))) ||
      typeof record.requiresAppConfirmation !== 'boolean') throw new Denied('MINT_JOURNAL_INVALID', 503);
  return record;
}

class MintJournal {
  constructor(directory) { if (typeof directory !== 'string' || !directory) throw new Error('journalDir required'); this.directory = directory; }
  async ready() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const path of [this.directory, dirname(this.directory)]) {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Denied('MINT_JOURNAL_UNSAFE_PATH', 503);
    }
    await chmod(this.directory, 0o700);
  }
  path(intentId) { if (!idPattern.test(intentId)) throw new Denied('INVALID_MINT_ID', 400); return join(this.directory, intentId + '.json'); }
  async syncDirectory() { const f = await open(this.directory, 'r'); try { await f.sync(); } finally { await f.close(); } }
  async read(intentId) {
    await this.ready();
    try {
      const f = await open(this.path(intentId), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await f.stat();
        if (!stat.isFile() || stat.size > 16384 || (stat.mode & 0o077)) throw Error();
        const value = validateRecord(JSON.parse(await f.readFile('utf8')));
        if (value.intentId !== intentId) throw Error(); return value;
      } finally { await f.close(); }
    } catch (error) { if (error.code === 'ENOENT') return null; throw new Denied('MINT_JOURNAL_INVALID', 503); }
  }
  async all() {
    await this.ready(); const names = (await readdir(this.directory)).filter(name => name.endsWith('.json'));
    if (names.some(name => !/^[a-f0-9]{32}\.json$/.test(name)) || names.length > 5000) throw new Denied('MINT_JOURNAL_INVALID', 503);
    return Promise.all(names.map(name => this.read(name.slice(0, -5))));
  }
  async exclusive(name, operation) {
    await this.ready(); const path = join(this.directory, name); let f;
    try { f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if (!await this.removeExitedOwnerLock(path)) throw new Denied('MINT_JOURNAL_BUSY', 409);
      try { f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (retryError) { if (retryError.code === 'EEXIST') throw new Denied('MINT_JOURNAL_BUSY', 409); throw retryError; }
    }
    try {
      await f.writeFile(JSON.stringify({ pid: process.pid, nonce: randomBytes(16).toString('hex') }));
      await f.sync(); return await operation();
    }
    finally { await f.close(); await unlink(path); await this.syncDirectory(); }
  }
  async removeExitedOwnerLock(path) {
    let f;
    try { f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (error.code === 'ENOENT') return true; return false; }
    let before, owner;
    try {
      before = await f.stat();
      if (!before.isFile() || before.size > 512) return false;
      const value = JSON.parse(await f.readFile('utf8'));
      if (!Number.isSafeInteger(value?.pid) || value.pid <= 0 || !/^[a-f0-9]{32}$/.test(value?.nonce || '')) return false;
      owner = value.pid;
    } catch { return false; }
    finally { await f.close(); }
    try { process.kill(owner, 0); return false; }
    catch (error) { if (error.code !== 'ESRCH') return false; }
    try {
      const current = await lstat(path);
      if (current.dev !== before.dev || current.ino !== before.ino) return false;
      await unlink(path); await this.syncDirectory(); return true;
    } catch (error) { if (error.code === 'ENOENT') return true; return false; }
  }
  withSubmissionLock(operation) { return this.exclusive('.submission-lock', operation); }
  async create(record) {
    validateRecord(record); await this.ready(); let f;
    try { f = await open(this.path(record.intentId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (error) { if (error.code === 'EEXIST') throw new Denied('MINT_INTENT_EXISTS', 409); throw error; }
    try { await f.writeFile(JSON.stringify(record) + '\n'); await f.sync(); } finally { await f.close(); }
    await this.syncDirectory(); return record;
  }
  async update(intentId, patch) {
    return this.exclusive('.update-' + intentId, async () => {
      const old = await this.read(intentId); if (!old) throw new Denied('UNKNOWN_MINT', 404);
      if (old.status !== 'SUBMITTING') return old;
      const next = validateRecord({ ...old, ...patch });
      for (const key of ['intentId', 'walletAddress', 'chainId', 'portal', 'name', 'symbol', 'metadataUri', 'createdAt', 'submittedAt'])
        if (old[key] !== next[key]) throw new Denied('MINT_INTENT_IMMUTABLE', 409);
      const temp = join(this.directory, '.tmp-' + randomBytes(16).toString('hex'));
      const f = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await f.writeFile(JSON.stringify(next) + '\n'); await f.sync(); } finally { await f.close(); }
      await rename(temp, this.path(intentId)); await this.syncDirectory(); return next;
    });
  }
}

function publicRecord(record) {
  return { ...record, terminal: ['FAILED'].includes(record.status), successful: false, canRetry: false,
    note: record.status === 'BROADCASTED' ? '已广播，不代表链上创建已确认；请核对交易凭证。' :
      record.status === 'PENDING_CONFIRMATION' ? '等待 Binance App 确认；暂未广播。' :
      record.status === 'UNKNOWN' || record.status === 'SUBMITTING' ? '结果未确认，请先核对交易历史；不会自动重试。' :
      record.status === 'FAILED' ? '提交未完成；可重新预览后再决定是否尝试。' : '交易状态待核对。' };
}

export class FlapMintService {
  constructor({ wallet, gate, previewContractCall, executeContractCall, journalDir, clock = Date.now, reviewTtlMs = 120000, minNativeReserve = '0.001' }) {
    if (typeof previewContractCall !== 'function' || typeof executeContractCall !== 'function') throw new Error('External contract-call callbacks are required');
    if (!Number.isSafeInteger(reviewTtlMs) || reviewTtlMs < 1000 || reviewTtlMs > 120000) throw new Error('Invalid review TTL');
    this.wallet = wallet; this.gate = gate; this.previewContractCall = previewContractCall; this.executeContractCall = executeContractCall;
    this.clock = clock; this.reviewTtlMs = reviewTtlMs; this.minNativeReserve = minNativeReserve;
    decimal(minNativeReserve); this.journal = new MintJournal(journalDir); this.reviews = new Map(); this.inFlight = new Map();
  }
  async bound(key, permission = 'read', expectedWallet) {
    const result = await this.gate.check(key, '56', permission);
    if (expectedWallet && !same(result.walletAddress, expectedWallet)) throw new Denied('MINT_WALLET_CHANGED', 409);
    return result;
  }
  async preflight(key, expectedWallet) {
    const bound = await this.bound(key, 'manual', expectedWallet);
    const settings = await this.wallet.settings();
    if (settings?.devMode?.enabled !== true) throw new Denied('DEVELOPER_MODE_REQUIRED', 403);
    const lock = await this.wallet.txLock('56');
    if ((typeof lock === 'string' ? lock : lock?.status) !== 'UNLOCKED') throw new Denied('WALLET_TRANSACTION_LOCKED', 409);
    const rows = await this.wallet.balance('56', NATIVE);
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].chainId !== '56' || !same(rows[0].contract, NATIVE)) throw new Denied('MINT_BALANCE_UNCONFIRMED', 409);
    let balance;
    try {
      const amount = rows[0].balance;
      decimal(amount, { zero: true }); const [whole, fraction = ''] = amount.split('.');
      balance = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
    } catch { throw new Denied('MINT_BALANCE_UNCONFIRMED', 409); }
    const [reserveWhole, reserveFraction = ''] = this.minNativeReserve.split('.');
    const reserve = BigInt(reserveWhole) * 10n ** 18n + BigInt(reserveFraction.padEnd(18, '0'));
    if (balance <= reserve) throw new Denied('INSUFFICIENT_GAS_RESERVE', 409);
    const finalBound = await this.bound(key, 'manual', bound.walletAddress);
    return { ...finalBound, balanceBnb: rows[0].balance };
  }
  async preview(key, request) {
    const input = mintInput(request); const before = await this.preflight(key);
    const contractData = encodeFlapNewToken(input);
    const response = await this.previewContractCall({ chainId: '56', from: before.walletAddress, to: FLAP_BSC_PORTAL, value: '0', inputData: contractData });
    if (response?.kind !== 'success') throw new Denied('MINT_PREVIEW_REJECTED', 409);
    const preview = normalizePreview(response.data, { ...input, walletAddress: before.walletAddress });
    await this.bound(key, 'manual', before.walletAddress);
    const now = this.clock();
    for (const [k, v] of this.reviews) if (v.expiresAt <= now && !this.inFlight.has(k)) this.reviews.delete(k);
    if (this.reviews.size >= 500) throw new Denied('MINT_REVIEW_CAPACITY', 429);
    const reviewId = id(), intentId = id();
    const review = { ...preview, reviewId, intentId, requestId: response.data.requestId, sessionKey: key,
      createdAt: now, expiresAt: Math.min(now + this.reviewTtlMs, preview.expiresAt || Infinity), gasReserve: this.minNativeReserve,
      warning: '这会创建真实链上代币；预览不代表成功。创建不附带初始买入，Gas / 平台费用以官方预览及最终交易为准。' };
    this.reviews.set(reviewId, review);
    return Object.fromEntries(Object.entries(review).filter(([k]) => k !== 'requestId' && k !== 'sessionKey'));
  }
  async submit(key, request) {
    fields(request, ['reviewId', 'confirmed', 'costAcknowledged', 'riskAcknowledged']);
    if (request.confirmed !== true || request.costAcknowledged !== true) throw new Denied('MINT_CONFIRMATION_REQUIRED', 400);
    const review = this.reviews.get(request.reviewId);
    if (!review || review.sessionKey !== key) throw new Denied('UNKNOWN_MINT_REVIEW', 404);
    await this.bound(key, 'manual', review.walletAddress);
    if (review.expiresAt <= this.clock() || review.createdAt > this.clock()) throw new Denied('MINT_REVIEW_EXPIRED', 409);
    if (review.requiresRiskAcknowledgment && request.riskAcknowledged !== true) throw new Denied('MINT_RISK_ACKNOWLEDGMENT_REQUIRED', 400);
    if (this.inFlight.has(review.reviewId)) {
      const result = await this.inFlight.get(review.reviewId);
      await this.bound(key, 'read', review.walletAddress);
      return publicRecord(result);
    }
    const already = await this.journal.read(review.intentId);
    if (already) return publicRecord(already);
    if (this.inFlight.has(review.reviewId)) {
      const result = await this.inFlight.get(review.reviewId);
      await this.bound(key, 'read', review.walletAddress);
      return publicRecord(result);
    }
    const operation = this.performSubmit(key, review);
    this.inFlight.set(review.reviewId, operation);
    try { const result = await operation; await this.bound(key, 'read', review.walletAddress); return publicRecord(result); }
    finally { if (this.inFlight.get(review.reviewId) === operation) this.inFlight.delete(review.reviewId); }
  }
  async performSubmit(key, review) {
    return this.journal.withSubmissionLock(async () => {
      const existing = await this.journal.read(review.intentId); if (existing) return existing;
      // A broadcast or App-pending call is a known, separately journaled intent;
      // it must not deadlock every later, separately reviewed mint. Only an
      // indeterminate/stale submission blocks a new intent to avoid duplicates.
      const unresolved = (await this.journal.all()).some(item => same(item.walletAddress, review.walletAddress) &&
        ['SUBMITTING', 'UNKNOWN'].includes(item.status));
      if (unresolved) throw new Denied('UNRESOLVED_MINT_EXISTS', 409);
      await this.preflight(key, review.walletAddress);
      if (review.expiresAt <= this.clock() || review.createdAt > this.clock()) throw new Denied('MINT_REVIEW_EXPIRED', 409);
      const now = this.clock();
      const record = { schema: 1, intentId: review.intentId, walletAddress: review.walletAddress, chainId: '56', portal: FLAP_BSC_PORTAL,
        name: review.name, symbol: review.symbol, metadataUri: review.metadataUri, createdAt: review.createdAt, submittedAt: now, updatedAt: now,
        status: 'SUBMITTING', orderId: null, txHash: null, failureCode: null, requiresAppConfirmation: false };
      await this.journal.create(record);
      try { await this.bound(key, 'manual', review.walletAddress); this.gate.sessions.byKey(key); }
      catch { return this.journal.update(record.intentId, { status: 'FAILED', failureCode: 'PRE_SUBMISSION_AUTH_CHANGED', updatedAt: this.clock() }); }
      let response;
      try { response = await this.executeContractCall(review.requestId); }
      catch { return this.journal.update(record.intentId, { status: 'UNKNOWN', failureCode: 'SUBMISSION_RESULT_UNKNOWN', updatedAt: this.clock() }); }
      if (response?.status === 'REJECTED') return this.journal.update(record.intentId, { status: 'FAILED', failureCode: response.code || 'OFFICIAL_REJECTED', updatedAt: this.clock() });
      if (response?.status === 'UNKNOWN') return this.journal.update(record.intentId, { status: 'UNKNOWN', orderId: response.orderId || null, txHash: response.txHash || null,
        failureCode: response.code || 'SUBMISSION_RESULT_UNKNOWN', updatedAt: this.clock() });
      if (response?.status === 'PENDING_CONFIRMATION' && response.orderId) return this.journal.update(record.intentId, { status: 'PENDING_CONFIRMATION', orderId: response.orderId,
        txHash: response.txHash || null, requiresAppConfirmation: true, updatedAt: this.clock() });
      if (response?.status === 'BROADCASTED' && response.orderId && response.txHash) return this.journal.update(record.intentId, { status: 'BROADCASTED', orderId: response.orderId,
        txHash: response.txHash, updatedAt: this.clock() });
      return this.journal.update(record.intentId, { status: 'UNKNOWN', orderId: response?.orderId || null, txHash: response?.txHash || null,
        failureCode: 'SUBMISSION_RESULT_UNKNOWN', updatedAt: this.clock() });
    });
  }
  async locate(key, request) {
    fields(request, ['intentId']); if (!idPattern.test(request.intentId || '')) throw new Denied('INVALID_MINT_ID', 400);
    const bound = await this.bound(key); const record = await this.journal.read(request.intentId);
    if (!record || !same(record.walletAddress, bound.walletAddress)) throw new Denied('UNKNOWN_MINT', 404);
    return record;
  }
  async status(key, request) { const record = await this.locate(key, request); await this.bound(key, 'read', record.walletAddress); return publicRecord(record); }
  async list(key, request = {}) {
    fields(request, []); const bound = await this.bound(key);
    const list = (await this.journal.all()).filter(r => same(r.walletAddress, bound.walletAddress)).sort((a, b) => b.createdAt - a.createdAt).map(publicRecord);
    await this.bound(key, 'read', bound.walletAddress); return { list };
  }
}
