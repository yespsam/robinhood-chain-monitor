import { randomBytes } from 'node:crypto';
import { mkdir, lstat, chmod, open, readdir, rename, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, dirname } from 'node:path';
import { Interface, parseEther } from 'ethers';
import { Denied } from './auth.mjs';
import { validChain, validContract, decimal } from './model.mjs';

const idPattern = /^[a-f0-9]{32}$/;
const requestPattern = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const txHashPattern = /^0x[\da-f]{64}$/i;
const statuses = new Set(['SUBMITTING', 'BROADCASTED', 'PENDING_CONFIRMATION', 'UNKNOWN', 'FAILED']);
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const id = () => randomBytes(16).toString('hex');
const fields = (v, names, code = 'INVALID_CONTRACT_CALL_FIELDS') => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !names.includes(k))) throw new Denied(code, 400);
};
const cleanText = (v, max) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
const orderIdText = v => typeof v === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(v) ? v : null;
const requestIdText = v => typeof v === 'string' && requestPattern.test(v) ? v : null;
const cleanHash = v => typeof v === 'string' && txHashPattern.test(v) ? v : null;
const weiText = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 2n ** 256n ? v : null;

function parseInput(request) {
  fields(request, ['chainId', 'contractAddress', 'abiJson', 'functionSignature', 'argumentsJson', 'valueNative']);
  const { chainId } = request;
  try { validChain(chainId); } catch { throw new Denied('CONTRACT_CALL_CHAIN_UNSUPPORTED', 400); }
  if (chainId === 'CT_501') throw new Denied('CONTRACT_CALL_CHAIN_UNSUPPORTED', 400);
  const contractAddress = validContract(chainId, request.contractAddress);
  if (typeof request.abiJson !== 'string' || request.abiJson.length > 24_000) throw new Denied('CONTRACT_CALL_ABI_INVALID', 400);
  if (typeof request.functionSignature !== 'string' || request.functionSignature.length > 512) throw new Denied('CONTRACT_CALL_FUNCTION_INVALID', 400);
  if (typeof request.argumentsJson !== 'string' || request.argumentsJson.length > 16_000) throw new Denied('CONTRACT_CALL_ARGUMENTS_INVALID', 400);
  let abi, args;
  try { abi = JSON.parse(request.abiJson); } catch { throw new Denied('CONTRACT_CALL_ABI_INVALID', 400); }
  try { args = JSON.parse(request.argumentsJson); } catch { throw new Denied('CONTRACT_CALL_ARGUMENTS_INVALID', 400); }
  if (!Array.isArray(abi) || abi.length < 1 || abi.length > 100 || !Array.isArray(args) || args.length > 64) throw new Denied('CONTRACT_CALL_ABI_INVALID', 400);
  let iface, fragment;
  try {
    iface = new Interface(abi);
    fragment = iface.getFunction(request.functionSignature);
    if (!fragment || fragment.format('sighash') !== request.functionSignature ||
        iface.fragments.filter(x => x.type === 'function' && x.format('sighash') === request.functionSignature).length !== 1) throw Error();
  } catch { throw new Denied('CONTRACT_CALL_FUNCTION_INVALID', 400); }
  if (!['nonpayable', 'payable'].includes(fragment.stateMutability)) throw new Denied('CONTRACT_CALL_NOT_STATE_CHANGING', 400);
  if (/^(?:approve.*|.*permit.*|increaseAllowance|decreaseAllowance|setApprovalForAll|transferOwnership|renounceOwnership|(?:grant|revoke|renounce)Role|set(?:Owner|Admin|Minter|Authority|Implementation|Beacon|ProxyAdmin)|upgradeTo(?:AndCall)?|initialize\d*|setup|pause|unpause)$/i.test(fragment.name))
    throw new Denied('CONTRACT_CALL_PRIVILEGE_METHOD_BLOCKED', 403);
  let valueWei;
  try {
    decimal(request.valueNative, { zero: true });
    valueWei = parseEther(request.valueNative).toString();
  } catch { throw new Denied('INVALID_AMOUNT', 400); }
  if (fragment.stateMutability !== 'payable' && valueWei !== '0') throw new Denied('CONTRACT_CALL_VALUE_NOT_PAYABLE', 400);
  let inputData;
  try { inputData = iface.encodeFunctionData(fragment, args); } catch { throw new Denied('CONTRACT_CALL_ARGUMENTS_INVALID', 400); }
  if (inputData.length > 32_768 || !/^0x[0-9a-f]+$/i.test(inputData) || inputData.length < 10) throw new Denied('CONTRACT_CALL_DATA_TOO_LARGE', 400);
  const pending = [args];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === 'number' && (!Number.isSafeInteger(value) || !Number.isFinite(value))) throw new Denied('CONTRACT_CALL_ARGUMENTS_INVALID', 400);
    if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === 'object') pending.push(...Object.values(value));
  }
  let safeArgs;
  try { safeArgs = JSON.parse(JSON.stringify(args, (_key, value) => typeof value === 'bigint' ? value.toString() : value)); }
  catch { throw new Denied('CONTRACT_CALL_ARGUMENTS_INVALID', 400); }
  return { chainId, contractAddress, functionSignature: fragment.format('sighash'), functionName: fragment.name,
    selector: inputData.slice(0, 10), argumentsJson: JSON.stringify(safeArgs), inputData, valueWei,
    valueNative: request.valueNative, interface: iface, fragment, decoded: safeArgs };
}

function riskText(value, max) { return cleanText(value, max); }
function normalizeRisks(value, chainId) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.riskDetails) || value.riskDetails.length > 50 ||
      !value.addresses || typeof value.addresses !== 'object' || Array.isArray(value.addresses) || Object.keys(value.addresses).length > 50 ||
      !Array.isArray(value.riskBehaviors) || value.riskBehaviors.length > 50) throw new Denied('CONTRACT_CALL_PREVIEW_INCOMPLETE', 503);
  const riskDetails = value.riskDetails.map(item => {
    if (!item || !['RISK', 'CAUTION'].includes(item.riskType)) throw new Denied('CONTRACT_CALL_PREVIEW_INCOMPLETE', 503);
    return { code: riskText(item.code, 80), title: riskText(item.title, 160), description: riskText(item.description, 500), riskType: item.riskType };
  });
  const addresses = {};
  for (const [address, item] of Object.entries(value.addresses)) {
    validContract(chainId, address);
    if (!item || !Number.isInteger(item.riskLevel) || item.riskLevel < 0 || item.riskLevel > 5 || !Array.isArray(item.riskDetails) || item.riskDetails.length > 50)
      throw new Denied('CONTRACT_CALL_PREVIEW_INCOMPLETE', 503);
    addresses[address] = { riskLevel: item.riskLevel, riskDetails: item.riskDetails.map(x => {
      if (!x || !['RISK', 'CAUTION'].includes(x.riskType)) throw new Denied('CONTRACT_CALL_PREVIEW_INCOMPLETE', 503);
      return { code: riskText(x.code, 80), title: riskText(x.title, 160), description: riskText(x.description, 500), riskType: x.riskType };
    }) };
  }
  const riskBehaviors = value.riskBehaviors.map(item => {
    if (!item || !['RISK', 'CAUTION'].includes(item.riskType)) throw new Denied('CONTRACT_CALL_PREVIEW_INCOMPLETE', 503);
    return { code: riskText(item.code, 80), title: riskText(item.title, 160), description: riskText(item.description, 500), riskType: item.riskType };
  });
  return { riskDetails, addresses, riskBehaviors };
}

function normalizePreview(data, expected) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || !requestIdText(data.requestId) ||
      !data.parsedTx || typeof data.parsedTx !== 'object' || Array.isArray(data.parsedTx) ||
      !data.simulationResult || typeof data.simulationResult !== 'object' || Array.isArray(data.simulationResult))
    throw new Denied('CONTRACT_CALL_PREVIEW_INCOMPLETE', 503);
  const tx = data.parsedTx, simulation = data.simulationResult;
  const targets = [tx.contractAddress, tx.to].filter(x => x !== undefined && x !== null);
  const values = [tx.value, tx.amount].filter(x => x !== undefined && x !== null);
  const senders = [tx.from, tx.sender, tx.walletAddress].filter(x => x !== undefined && x !== null);
  const chains = [tx.chainId, tx.binanceChainId].filter(x => x !== undefined && x !== null);
  if (!targets.length || targets.some(target => !same(validContract(expected.chainId, target), expected.contractAddress)) ||
      !values.length || values.some(value => weiText(value) !== expected.valueWei) ||
      !senders.length || senders.some(sender => !same(validContract(expected.chainId, sender), expected.walletAddress)) ||
      !chains.length || chains.some(chain => typeof chain !== 'string' || chain !== expected.chainId) ||
      typeof simulation.simulationCode !== 'string' || simulation.simulationCode !== '000000000' ||
      !['', '000000000', undefined].includes(simulation.preCheckCode) ||
      ![undefined, null, ''].includes(simulation.simulationErrorDetail) ||
      !Array.isArray(simulation.authorityChanges) || !Array.isArray(simulation.allowanceChanges) ||
      !Array.isArray(simulation.balanceChanges) || simulation.authorityChanges.length > 50 || simulation.allowanceChanges.length > 50 ||
      simulation.balanceChanges.length > 100 || simulation.authorityChanges.length > 0 || simulation.allowanceChanges.length > 0)
    throw new Denied('CONTRACT_CALL_PREVIEW_BLOCKED', 403);
  const returnedData = [tx.inputData, tx.callData, tx.data].filter(x => x !== undefined && x !== null);
  if (!returnedData.length || returnedData.some(data => typeof data !== 'string' || data.toLowerCase() !== expected.inputData.toLowerCase()))
    throw new Denied('CONTRACT_CALL_PREVIEW_BLOCKED', 403);
  const risks = normalizeRisks(data.risks, expected.chainId);
  const hardRisk = risks.riskDetails.some(x => x.riskType === 'RISK') || risks.riskBehaviors.some(x => x.riskType === 'RISK') ||
    Object.values(risks.addresses).some(x => x.riskLevel >= 4 || x.riskDetails.some(r => r.riskType === 'RISK'));
  if (hardRisk) throw new Denied('CONTRACT_CALL_PREVIEW_BLOCKED', 403);
  const balanceChanges = simulation.balanceChanges.map(x => {
    if (!x || typeof x !== 'object' || Array.isArray(x)) throw new Denied('CONTRACT_CALL_PREVIEW_INCOMPLETE', 503);
    return { token: cleanText(x.token || x.symbol || x.contractAddress, 160), before: cleanText(x.before, 100),
      after: cleanText(x.after, 100), change: cleanText(x.change || x.amount, 100) };
  });
  const caution = risks.riskDetails.some(x => x.riskType === 'CAUTION') || risks.riskBehaviors.some(x => x.riskType === 'CAUTION') ||
    Object.values(risks.addresses).some(x => x.riskLevel >= 2 || x.riskDetails.some(r => r.riskType === 'CAUTION')) || data.requireConfirmation === true;
  const expiresAt = Number.isSafeInteger(data.expiresAt) && data.expiresAt > 0 ? data.expiresAt : null;
  if (!expiresAt || typeof data.requireConfirmation !== 'boolean') throw new Denied('CONTRACT_CALL_PREVIEW_INCOMPLETE', 503);
  return { requestId: data.requestId, parsedTx: structuredClone(tx), risks, authorityChanges: [], allowanceChanges: [], balanceChanges,
    requireConfirmation: data.requireConfirmation === true, expiresAt, requiresRiskAcknowledgment: caution,
    walletAddress: expected.walletAddress, chainId: expected.chainId, contractAddress: expected.contractAddress,
    functionName: expected.functionName, functionSignature: expected.functionSignature, selector: expected.selector,
    argumentsJson: expected.argumentsJson, decodedArguments: expected.decoded, valueWei: expected.valueWei,
    valueNative: expected.valueNative, inputData: expected.inputData, executable: true };
}

const recordKeys = new Set(['schema', 'intentId', 'walletAddress', 'chainId', 'contractAddress', 'functionName', 'functionSignature',
  'selector', 'valueWei', 'createdAt', 'updatedAt', 'submittedAt', 'status', 'orderId', 'txHash', 'failureCode', 'requiresAppConfirmation']);
function validateRecord(r) {
  if (!r || r.schema !== 1 || !idPattern.test(r.intentId || '') || Object.keys(r).some(k => !recordKeys.has(k)) ||
      typeof r.chainId !== 'string' || !/^[1-9][0-9]{0,9}$/.test(r.chainId) || !/^0x[\da-f]{40}$/i.test(r.walletAddress || '') ||
      !/^0x[\da-f]{40}$/i.test(r.contractAddress || '') || !cleanText(r.functionName, 128) || !cleanText(r.functionSignature, 512) ||
      !/^0x[\da-f]{8}$/i.test(r.selector || '') || !weiText(r.valueWei) || !statuses.has(r.status) ||
      ![r.createdAt, r.updatedAt, r.submittedAt].every(Number.isSafeInteger) ||
      (r.orderId !== null && !orderIdText(r.orderId)) || (r.txHash !== null && !cleanHash(r.txHash)) ||
      (r.failureCode !== null && !/^[A-Z0-9_]{1,80}$/.test(r.failureCode)) || typeof r.requiresAppConfirmation !== 'boolean')
    throw new Denied('CONTRACT_CALL_JOURNAL_INVALID', 503);
  return r;
}

class ContractCallJournal {
  constructor(directory) { if (!directory) throw new Error('journalDir required'); this.directory = directory; }
  async ready() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const path of [this.directory, dirname(this.directory)]) { const s = await lstat(path); if (s.isSymbolicLink() || !s.isDirectory()) throw new Denied('CONTRACT_CALL_JOURNAL_UNSAFE_PATH', 503); }
    await chmod(this.directory, 0o700);
  }
  path(intentId) { if (!idPattern.test(intentId)) throw new Denied('INVALID_CONTRACT_CALL_ID', 400); return join(this.directory, intentId + '.json'); }
  async syncDirectory() { const f = await open(this.directory, 'r'); try { await f.sync(); } finally { await f.close(); } }
  async read(intentId) {
    await this.ready();
    try { const f = await open(this.path(intentId), constants.O_RDONLY | constants.O_NOFOLLOW); try {
      const s = await f.stat(); if (!s.isFile() || s.size > 16384 || (s.mode & 0o077)) throw Error();
      const r = validateRecord(JSON.parse(await f.readFile('utf8'))); if (r.intentId !== intentId) throw Error(); return r;
    } finally { await f.close(); } } catch (e) { if (e.code === 'ENOENT') return null; throw new Denied('CONTRACT_CALL_JOURNAL_INVALID', 503); }
  }
  async all() { await this.ready(); const names = (await readdir(this.directory)).filter(x => x.endsWith('.json'));
    if (names.length > 5000 || names.some(x => !/^[a-f0-9]{32}\.json$/.test(x))) throw new Denied('CONTRACT_CALL_JOURNAL_INVALID', 503);
    return Promise.all(names.map(x => this.read(x.slice(0, -5)))); }
  async exclusive(name, operation) {
    await this.ready(); const path = join(this.directory, name); let f;
    try { f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (e) { if (e.code !== 'EEXIST') throw e; if (!await this.removeExitedLock(path)) throw new Denied('CONTRACT_CALL_JOURNAL_BUSY', 409);
      try { f = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (again) { if (again.code === 'EEXIST') throw new Denied('CONTRACT_CALL_JOURNAL_BUSY', 409); throw again; } }
    try { await f.writeFile(JSON.stringify({ pid: process.pid, nonce: randomBytes(16).toString('hex') })); await f.sync(); return await operation(); }
    finally { await f.close(); await unlink(path); await this.syncDirectory(); }
  }
  async removeExitedLock(path) {
    let f; try { f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (e) { return e.code === 'ENOENT'; }
    let before, pid; try { before = await f.stat(); if (!before.isFile() || before.size > 512) return false;
      const value = JSON.parse(await f.readFile('utf8')); if (!Number.isSafeInteger(value?.pid) || value.pid <= 0 || !/^[a-f0-9]{32}$/.test(value?.nonce || '')) return false; pid = value.pid;
    } catch { return false; } finally { await f.close(); }
    try { process.kill(pid, 0); return false; } catch (e) { if (e.code !== 'ESRCH') return false; }
    try { const now = await lstat(path); if (now.dev !== before.dev || now.ino !== before.ino) return false; await unlink(path); await this.syncDirectory(); return true; }
    catch (e) { return e.code === 'ENOENT'; }
  }
  withSubmissionLock(fn) { return this.exclusive('.submission-lock', fn); }
  async create(r) { validateRecord(r); await this.ready(); let f; try { f = await open(this.path(r.intentId), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
    catch (e) { if (e.code === 'EEXIST') throw new Denied('CONTRACT_CALL_INTENT_EXISTS', 409); throw e; }
    try { await f.writeFile(JSON.stringify(r) + '\n'); await f.sync(); } finally { await f.close(); } await this.syncDirectory(); return r; }
  async update(intentId, patch) { return this.exclusive('.update-' + intentId, async () => {
    const old = await this.read(intentId); if (!old) throw new Denied('UNKNOWN_CONTRACT_CALL', 404); if (old.status !== 'SUBMITTING') return old;
    const next = validateRecord({ ...old, ...patch });
    for (const k of ['intentId', 'walletAddress', 'chainId', 'contractAddress', 'functionName', 'functionSignature', 'selector', 'valueWei', 'createdAt', 'submittedAt']) if (old[k] !== next[k]) throw new Denied('CONTRACT_CALL_INTENT_IMMUTABLE', 409);
    const temp = join(this.directory, '.tmp-' + randomBytes(16).toString('hex')); const f = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await f.writeFile(JSON.stringify(next) + '\n'); await f.sync(); } finally { await f.close(); }
    await rename(temp, this.path(intentId)); await this.syncDirectory(); return next;
  }); }
}

function publicRecord(r) { return { ...r, terminal: r.status === 'FAILED', successful: false, canRetry: false,
  note: r.status === 'BROADCASTED' ? '已广播，尚未确认链上执行结果。' : r.status === 'PENDING_CONFIRMATION' ? '等待 Binance App 确认；暂未广播。' :
    ['UNKNOWN', 'SUBMITTING'].includes(r.status) ? '结果未确认，先核对钱包/链上记录；不会自动重试。' : r.status === 'FAILED' ? '本次提交失败；可重新预览后再决定是否尝试。' : '状态待核对。' }; }

export class CustomContractCallService {
  constructor({ wallet, gate, previewContractCall, executeContractCall, journalDir, clock = Date.now, reviewTtlMs = 120000, minNativeReserve = '0.001' }) {
    if (typeof previewContractCall !== 'function' || typeof executeContractCall !== 'function') throw new Error('contract-call callbacks required');
    if (!Number.isSafeInteger(reviewTtlMs) || reviewTtlMs < 1000 || reviewTtlMs > 120000) throw new Error('Invalid review TTL');
    decimal(minNativeReserve); this.wallet = wallet; this.gate = gate; this.previewContractCall = previewContractCall;
    this.executeContractCall = executeContractCall; this.clock = clock; this.reviewTtlMs = reviewTtlMs; this.minNativeReserve = minNativeReserve;
    this.journal = new ContractCallJournal(journalDir); this.reviews = new Map(); this.inFlight = new Map();
  }
  async bound(key, chainId, permission = 'read', expectedWallet) {
    const result = await this.gate.check(key, chainId, permission);
    if (expectedWallet && !same(result.walletAddress, expectedWallet)) throw new Denied('CONTRACT_CALL_WALLET_CHANGED', 409);
    return result;
  }
  async boundAnyEvm(key, permission = 'read') {
    const chainId = Object.keys(this.gate.binding?.addresses || {}).find(x => /^[1-9][0-9]{0,9}$/.test(x));
    if (!chainId) throw new Denied('CONTRACT_CALL_CHAIN_UNSUPPORTED', 400);
    return this.bound(key, chainId, permission);
  }
  async preflight(key, input, expectedWallet) {
    const bound = await this.bound(key, input.chainId, 'manual', expectedWallet);
    const settings = await this.wallet.settings(); if (settings?.devMode?.enabled !== true) throw new Denied('DEVELOPER_MODE_REQUIRED', 403);
    const lock = await this.wallet.txLock(input.chainId); if ((typeof lock === 'string' ? lock : lock?.status) !== 'UNLOCKED') throw new Denied('WALLET_TRANSACTION_LOCKED', 409);
    const rows = await this.wallet.balance(input.chainId, '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE');
    if (!Array.isArray(rows) || rows.length !== 1 || rows[0].chainId !== input.chainId || rows[0].contract?.toLowerCase() !== '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') throw new Denied('CONTRACT_CALL_BALANCE_UNCONFIRMED', 409);
    let balance; try { decimal(rows[0].balance, { zero: true }); const [whole, fraction = ''] = rows[0].balance.split('.'); balance = BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0')); }
    catch { throw new Denied('CONTRACT_CALL_BALANCE_UNCONFIRMED', 409); }
    const [reserveWhole, reserveFraction = ''] = this.minNativeReserve.split('.'); const reserve = BigInt(reserveWhole) * 10n ** 18n + BigInt(reserveFraction.padEnd(18, '0'));
    if (balance < BigInt(input.valueWei) + reserve) throw new Denied('INSUFFICIENT_GAS_RESERVE', 409);
    const finalBound = await this.bound(key, input.chainId, 'manual', bound.walletAddress);
    return { ...finalBound, nativeBalance: rows[0].balance };
  }
  async preview(key, request) {
    const input = parseInput(request), before = await this.preflight(key, input);
    const response = await this.previewContractCall({ chainId: input.chainId, from: before.walletAddress, to: input.contractAddress,
      value: input.valueWei, inputData: input.inputData });
    if (response?.kind !== 'success') throw new Denied('CONTRACT_CALL_PREVIEW_REJECTED', 409);
    const preview = normalizePreview(response.data, { ...input, walletAddress: before.walletAddress });
    await this.bound(key, input.chainId, 'manual', before.walletAddress);
    const now = this.clock(); for (const [k, v] of this.reviews) if (v.expiresAt <= now && !this.inFlight.has(k)) this.reviews.delete(k);
    if (preview.expiresAt <= now) throw new Denied('CONTRACT_CALL_REVIEW_EXPIRED', 409);
    if (this.reviews.size >= 500) throw new Denied('CONTRACT_CALL_REVIEW_CAPACITY', 429);
    const reviewId = id(), intentId = id();
    const review = { ...preview, reviewId, intentId, requestId: response.data.requestId, sessionKey: key, createdAt: now,
      expiresAt: Math.min(now + this.reviewTtlMs, preview.expiresAt), gasReserve: this.minNativeReserve,
      warning: '自定义合约会按编码参数调用；恶意合约、白名单/权限/预售条件、税费、流动性和后续买卖能力无法由预览保证。仅在完整核对后才逐笔确认。' };
    this.reviews.set(reviewId, review);
    return Object.fromEntries(Object.entries(review).filter(([k]) => !['requestId', 'sessionKey', 'interface', 'fragment'].includes(k)));
  }
  async submit(key, request) {
    fields(request, ['reviewId', 'confirmed', 'costAcknowledged', 'riskAcknowledged', 'customCallAcknowledged']);
    if (request.confirmed !== true || request.costAcknowledged !== true || request.customCallAcknowledged !== true) throw new Denied('CONTRACT_CALL_CONFIRMATION_REQUIRED', 400);
    const review = this.reviews.get(request.reviewId); if (!review || review.sessionKey !== key) throw new Denied('UNKNOWN_CONTRACT_CALL_REVIEW', 404);
    await this.bound(key, review.chainId, 'manual', review.walletAddress);
    if (review.expiresAt <= this.clock() || review.createdAt > this.clock()) throw new Denied('CONTRACT_CALL_REVIEW_EXPIRED', 409);
    if (review.requiresRiskAcknowledgment && request.riskAcknowledged !== true) throw new Denied('CONTRACT_CALL_RISK_ACKNOWLEDGMENT_REQUIRED', 400);
    if (this.inFlight.has(review.reviewId)) { const r = await this.inFlight.get(review.reviewId); await this.bound(key, review.chainId, 'read', review.walletAddress); return publicRecord(r); }
    const already = await this.journal.read(review.intentId); if (already) return publicRecord(already);
    if (this.inFlight.has(review.reviewId)) { const r = await this.inFlight.get(review.reviewId); await this.bound(key, review.chainId, 'read', review.walletAddress); return publicRecord(r); }
    const operation = this.performSubmit(key, review); this.inFlight.set(review.reviewId, operation);
    try { const result = await operation; await this.bound(key, review.chainId, 'read', review.walletAddress); return publicRecord(result); }
    finally { this.inFlight.delete(review.reviewId); }
  }
  async performSubmit(key, review) {
    return this.journal.withSubmissionLock(async () => {
      const unresolved = (await this.journal.all()).some(r => same(r.walletAddress, review.walletAddress) && ['SUBMITTING', 'UNKNOWN'].includes(r.status));
      if (unresolved) throw new Denied('UNRESOLVED_CONTRACT_CALL_EXISTS', 409);
      await this.preflight(key, review, review.walletAddress);
      if (review.expiresAt <= this.clock()) throw new Denied('CONTRACT_CALL_REVIEW_EXPIRED', 409);
      const now = this.clock(), record = { schema: 1, intentId: review.intentId, walletAddress: review.walletAddress, chainId: review.chainId,
        contractAddress: review.contractAddress, functionName: review.functionName, functionSignature: review.functionSignature, selector: review.selector,
        valueWei: review.valueWei, createdAt: review.createdAt, submittedAt: now, updatedAt: now, status: 'SUBMITTING', orderId: null, txHash: null,
        failureCode: null, requiresAppConfirmation: false };
      await this.journal.create(record);
      try { await this.bound(key, review.chainId, 'manual', review.walletAddress); this.gate.sessions.byKey(key); }
      catch { return this.journal.update(record.intentId, { status: 'FAILED', failureCode: 'PRE_SUBMISSION_AUTH_CHANGED', updatedAt: this.clock() }); }
      let response; try { response = await this.executeContractCall(review.requestId, review.chainId); }
      catch { return this.journal.update(record.intentId, { status: 'UNKNOWN', failureCode: 'SUBMISSION_RESULT_UNKNOWN', updatedAt: this.clock() }); }
      if (response?.status === 'REJECTED') return this.journal.update(record.intentId, { status: 'FAILED', failureCode: response.code || 'OFFICIAL_REJECTED', updatedAt: this.clock() });
      if (response?.status === 'UNKNOWN') return this.journal.update(record.intentId, { status: 'UNKNOWN', orderId: response.orderId || null,
        txHash: cleanHash(response.txHash), failureCode: response.code || 'SUBMISSION_RESULT_UNKNOWN', updatedAt: this.clock() });
      if (response?.status === 'PENDING_CONFIRMATION' && orderIdText(response.orderId)) return this.journal.update(record.intentId, { status: 'PENDING_CONFIRMATION',
        orderId: response.orderId, txHash: cleanHash(response.txHash), requiresAppConfirmation: true, updatedAt: this.clock() });
      if (response?.status === 'BROADCASTED' && orderIdText(response.orderId) && cleanHash(response.txHash)) return this.journal.update(record.intentId, { status: 'BROADCASTED',
        orderId: response.orderId, txHash: cleanHash(response.txHash), updatedAt: this.clock() });
      return this.journal.update(record.intentId, { status: 'UNKNOWN', orderId: orderIdText(response?.orderId), txHash: cleanHash(response?.txHash),
        failureCode: 'SUBMISSION_RESULT_UNKNOWN', updatedAt: this.clock() });
    });
  }
  async locate(key, request) {
    fields(request, ['intentId']); if (!idPattern.test(request.intentId || '')) throw new Denied('INVALID_CONTRACT_CALL_ID', 400);
    const record = await this.journal.read(request.intentId);
    if (!record) throw new Denied('UNKNOWN_CONTRACT_CALL', 404);
    const bound = await this.bound(key, record.chainId, 'read');
    if (!record || !same(record.walletAddress, bound.walletAddress)) throw new Denied('UNKNOWN_CONTRACT_CALL', 404);
    return record;
  }
  async status(key, request) { const r = await this.locate(key, request); await this.bound(key, r.chainId, 'read', r.walletAddress); return publicRecord(r); }
  async list(key, request = {}) {
    fields(request, []); const all = await this.journal.all(), addresses = this.gate.binding?.addresses || {};
    const chains = [...new Set(all.filter(r => same(r.walletAddress, addresses[r.chainId])).map(r => r.chainId))];
    if (!chains.length) { await this.boundAnyEvm(key, 'read'); return { list: [] }; }
    const verified = new Map();
    for (const chainId of chains) verified.set(chainId, (await this.bound(key, chainId, 'read')).walletAddress);
    const list = all.filter(r => same(r.walletAddress, verified.get(r.chainId))).sort((a, b) => b.createdAt - a.createdAt).map(publicRecord);
    for (const [chainId, walletAddress] of verified) await this.bound(key, chainId, 'read', walletAddress);
    return { list };
  }
}
