import { randomBytes } from 'node:crypto';
import { Denied } from './auth.mjs';
import { validContract, decimal, NATIVE } from './model.mjs';
import { TradeJournal, TERMINAL_TRADE_STATES } from './trade-journal.mjs';

export const BSC_TRUSTED_TOKENS = Object.freeze([
  NATIVE, '0x55d398326f99059fF775485246999027B3197955', '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d'
]);
const trusted = address => BSC_TRUSTED_TOKENS.some(a => a.toLowerCase() === address.toLowerCase());
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
const id = () => randomBytes(16).toString('hex');
const fields = (v, names) => { if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !names.includes(k))) throw new Denied('UNEXPECTED_TRADE_FIELD', 400); };
const units = value => { decimal(value, { zero: true }); const [a, b = ''] = value.split('.'); return BigInt(a) * 10n ** 18n + BigInt(b.padEnd(18, '0')); };
const human = n => { const s = n.toString().padStart(19, '0'); return s.slice(0, -18) + (s.slice(-18).replace(/0+$/, '') ? '.' + s.slice(-18).replace(/0+$/, '') : ''); };
const tidy = value => human(units(value));
const text = value => typeof value === 'string' ? value.slice(0, 300) : null;
const orderId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value) ? value : null;
const txHash = value => typeof value === 'string' && /^0x[\da-f]{64}$/i.test(value) ? value : null;
function input(value) {
  fields(value, ['chainId', 'fromToken', 'toToken', 'amount', 'slippage']);
  if (value.chainId !== '56') throw new Denied('MANUAL_TRADE_BSC_ONLY', 400);
  const fromToken = validContract('56', value.fromToken), toToken = validContract('56', value.toToken);
  decimal(value.amount); decimal(value.slippage, { zero: true });
  if (same(fromToken, toToken) || units(value.slippage) >= 100n * 10n ** 18n) throw new Denied('INVALID_TRADE_PARAMETERS', 400);
  return { chainId: '56', fromToken, toToken, amount: tidy(value.amount), slippage: tidy(value.slippage), mev: true, gasLevel: 'MEDIUM' };
}
export function buildSwapArgs(trade) {
  const t = input(Object.fromEntries(['chainId', 'fromToken', 'toToken', 'amount', 'slippage'].map(k => [k, trade[k]])));
  return ['market-order', 'swap', '--fromTokenQty', t.amount, '--fromToken', t.fromToken, '--toToken', t.toToken,
    '--binanceChainId', t.chainId, '--slippage', t.slippage, '--mev', 'true', '--gasLevel', 'MEDIUM'];
}
function referenceMinimum(quoted, slippage) { return human(units(quoted) * (100n * 10n ** 18n - units(slippage)) / (100n * 10n ** 18n)); }
const publicRecord = r => ({ ...r, terminal: TERMINAL_TRADE_STATES.has(r.status), successful: r.status === 'FINISHED',
  canRetry: false, needsReadOnlyReconciliation: r.status === 'UNKNOWN' || r.status === 'SUBMITTING' });

export class ManualTradeService {
  constructor({ wallet, gate, executeSwap, readOrder, auditTarget, journalDir, clock = Date.now,
    reviewTtlMs = 120000, minNativeReserve = '0.001' }) {
    this.wallet = wallet; this.gate = gate; this.clock = clock; this.reviews = new Map(); this.inFlight = new Map();
    this.journal = new TradeJournal(journalDir); this.auditTarget = auditTarget;
    if (!Number.isSafeInteger(reviewTtlMs) || reviewTtlMs < 1000 || reviewTtlMs > 120000) throw new Error('Invalid review TTL');
    this.reviewTtlMs = reviewTtlMs; decimal(minNativeReserve); this.minNativeReserve = tidy(minNativeReserve);
    if (typeof executeSwap !== 'function') throw new Error('A reviewed executeSwap callback is required');
    this.executeSwap = executeSwap;
    this.readOrder = readOrder || (q => wallet.call(['market-order', 'list', '--orderId', q.orderId]));
  }
  async bound(key, permission = 'read', expectedWallet) {
    const bound = await this.gate.check(key, '56', permission);
    if (expectedWallet && !same(bound.walletAddress, expectedWallet)) throw new Denied('TRADE_WALLET_CHANGED', 409);
    return bound;
  }
  async preflight(key, trade, permission = 'read', expectedWallet) {
    const bound = await this.bound(key, permission, expectedWallet);
    const lock = await (this.wallet.txLock ? this.wallet.txLock('56') : this.wallet.call(['wallet', 'tx-lock', '--binanceChainId', '56']));
    if ((typeof lock === 'string' ? lock : lock?.status) !== 'UNLOCKED') throw new Denied('WALLET_TRANSACTION_LOCKED', 409);
    const balance = async contract => {
      const rows = await this.wallet.balance('56', contract);
      if (!Array.isArray(rows) || rows.length !== 1 || rows[0].chainId !== '56' || !same(rows[0].contract, contract)) throw new Denied('TRADE_BALANCE_UNCONFIRMED', 409);
      try { return units(rows[0].balance); } catch { throw new Denied('TRADE_BALANCE_UNCONFIRMED', 409); }
    };
    const sourceBalance = await balance(trade.fromToken);
    const nativeBalance = same(trade.fromToken, NATIVE) ? sourceBalance : await balance(NATIVE);
    if (sourceBalance < units(trade.amount)) throw new Denied('INSUFFICIENT_TRADE_BALANCE', 409);
    if (nativeBalance - (same(trade.fromToken, NATIVE) ? units(trade.amount) : 0n) < units(this.minNativeReserve)) throw new Denied('INSUFFICIENT_GAS_RESERVE', 409);
    const gas = await (this.wallet.gasPrice ? this.wallet.gasPrice('56') : this.wallet.call(['wallet', 'gas-price', '--binanceChainId', '56']));
    try { if (units(gas?.medium?.gasPrice) <= 0n) throw new Error(); } catch { throw new Denied('GAS_PRICE_UNCONFIRMED', 409); }
    await this.bound(key, permission, bound.walletAddress);
    return { ...bound, sourceBalance: human(sourceBalance), nativeBalance: human(nativeBalance), gasPriceGwei: gas.medium.gasPrice };
  }
  async tokenRisk(contractAddress) {
    if (trusted(contractAddress)) return { state: 'TRUSTED', blocked: false, requiresAcknowledgment: false, items: [] };
    let result; try { result = await this.auditTarget?.({ chainId: '56', contractAddress }); } catch { /* No raw provider errors or response data. */ }
    const items = Array.isArray(result?.riskItems) ? result.riskItems.filter(x => x?.isHit === true).slice(0, 50).map(x => ({ code: text(x.code), description: text(x.description) })) : [];
    if (result?.blocked === true || result?.block === true || result?.status === 'BLOCKED')
      return { state: 'BLOCKED', blocked: true, requiresAcknowledgment: false,
        riskLevel: Number.isInteger(result.riskLevel) ? String(result.riskLevel) : text(result.riskLevel), items };
    if (result?.hasResult !== true || result?.isSupported !== true || result?.status === 'UNKNOWN')
      return { state: 'UNAVAILABLE', blocked: false, requiresAcknowledgment: true, items: [] };
    return { state: 'AUDITED', blocked: false, requiresAcknowledgment: items.length > 0 || result.requiresAcknowledgment === true || result.status === 'WARNING', riskLevel: Number.isInteger(result.riskLevel) ? String(result.riskLevel) : text(result.riskLevel), items };
  }
  async risk(trade) {
    if (trusted(trade.toToken)) return { state: 'TRUSTED_TARGET', blocked: false, requiresAcknowledgment: false, items: [] };
    return this.tokenRisk(trade.toToken);
  }
  async sourceRisk(trade) {
    if (trusted(trade.fromToken)) return null;
    const result = await this.tokenRisk(trade.fromToken);
    // A high-risk source is being sold, not acquired. Surface the warning and
    // require explicit acknowledgment, but never make the risk gate trap an exit.
    if (result.blocked) return { ...result, state: 'SOURCE_HIGH_RISK_ADVISORY', blocked: false, advisoryOnly: true,
      requiresAcknowledgment: true, items: [...result.items, { code: 'SELL_SIDE_ADVISORY', description: '该源代币触发强风险提示；本次是卖出方向，风险提示不拦截退出，但不保证存在可用路由或交易能够成功。' }] };
    return { ...result, state: result.state === 'UNAVAILABLE' ? 'SOURCE_AUDIT_UNAVAILABLE' : 'SOURCE_AUDITED_FOR_SELL',
      blocked: false, advisoryOnly: true, requiresAcknowledgment: result.requiresAcknowledgment };
  }
  async preview(key, request) {
    const trade = input(request), before = await this.preflight(key, trade);
    const quote = await this.wallet.quote(Object.fromEntries(['chainId', 'fromToken', 'toToken', 'amount', 'slippage'].map(k => [k, trade[k]])));
    if (quote?.mode !== 'official-quote' || quote.chainId !== '56' || !same(quote.fromToken, trade.fromToken) || !same(quote.toToken, trade.toToken)
        || units(quote.amount) !== units(trade.amount) || units(quote.slippagePercent) !== units(trade.slippage)) throw new Denied('TRADE_QUOTE_MISMATCH', 503);
    decimal(quote.estimatedOut);
    const risk = await this.risk(trade), sourceRisk = await this.sourceRisk(trade); await this.bound(key, 'read', before.walletAddress);
    const now = this.clock();
    for (const [k, r] of this.reviews) if (r.expiresAt <= now && !this.inFlight.has(k)) this.reviews.delete(k);
    if (this.reviews.size >= 1000) throw new Denied('TRADE_REVIEW_CAPACITY', 429);
    const review = { reviewId: id(), intentId: id(), ...trade, walletAddress: before.walletAddress,
      fromSymbol: text(quote.fromSymbol), toSymbol: text(quote.toSymbol), quotedOut: tidy(quote.estimatedOut),
      minimumReferenceOut: referenceMinimum(quote.estimatedOut, trade.slippage), minimumIsReferenceOnly: true,
      expiresAt: now + this.reviewTtlMs, createdAt: now, risk, sourceRisk,
      requiresRiskAcknowledgment: risk.requiresAcknowledgment || sourceRisk?.requiresAcknowledgment === true,
      requiresCostAcknowledgment: true, executable: !risk.blocked,
      sourceBalance: before.sourceBalance, nativeBalance: before.nativeBalance, minNativeReserve: this.minNativeReserve,
      gasPriceGwei: before.gasPriceGwei, totalGas: null, knownFees: null, approvalPlan: null,
      warnings: ['最终路由、手续费及 Gas 由官方 CLI 构建，报价不是最终到账保证。',
        '最低参考到账按本次报价及滑点计算，提交会重新构建路由；价格明显变动时需重新审单。',
        '保留 BNB 门槛不是交易 Gas 估算；兑换可能包括代币授权，并可能要求币安 App 确认。',
        ...(!trusted(trade.fromToken) ? ['卖出非可信币：目标资产可信不代表源代币可卖或没有转账税。'] : []),
      ...(risk.state === 'UNAVAILABLE' ? ['目标代币安全审计数据不可用，无法确认代币风险。'] : []),
      ...(sourceRisk ? ['支付侧代币也已单独检查；若本次为卖出，源币强风险仅作退出提示，不会因此阻止卖出。'] : [])] };
    this.reviews.set(review.reviewId, { ...review, sessionKey: key });
    return structuredClone(review);
  }
  async submit(key, request) {
    fields(request, ['reviewId', 'confirmed', 'riskAcknowledged', 'costAcknowledged']);
    if (request.confirmed !== true || request.costAcknowledged !== true) throw new Denied('TRADE_CONFIRMATION_REQUIRED', 400);
    const review = this.reviews.get(request.reviewId);
    if (!review || review.sessionKey !== key) throw new Denied('UNKNOWN_TRADE_REVIEW', 404);
    await this.bound(key, 'manual', review.walletAddress);
    if (this.inFlight.has(review.reviewId)) { await this.inFlight.get(review.reviewId); return this.status(key, { intentId: review.intentId }); }
    const existing = await this.journal.read(review.intentId);
    if (existing) return this.status(key, { intentId: review.intentId });
    if (this.inFlight.has(review.reviewId)) { await this.inFlight.get(review.reviewId); return this.status(key, { intentId: review.intentId }); }
    if (this.clock() < review.createdAt || this.clock() >= review.expiresAt) throw new Denied('TRADE_REVIEW_EXPIRED', 409);
    if (review.risk.blocked) throw new Denied('TOKEN_RISK_BLOCKED', 403);
    if (review.requiresRiskAcknowledgment && request.riskAcknowledged !== true) throw new Denied('TOKEN_RISK_ACKNOWLEDGMENT_REQUIRED', 400);
    // Set the in-memory marker before the first await in the submission operation.
    const operation = this.performSubmit(key, review);
    this.inFlight.set(review.reviewId, operation);
    try { const record = await operation; await this.bound(key, 'read', review.walletAddress); return publicRecord(record); }
    finally { if (this.inFlight.get(review.reviewId) === operation) this.inFlight.delete(review.reviewId); }
  }
  async performSubmit(key, review) {
    return this.journal.withSubmissionLock(async () => {
      const existing = await this.journal.read(review.intentId); if (existing) return existing;
      const unresolved = (await this.journal.all()).some(r => same(r.walletAddress, review.walletAddress) && !TERMINAL_TRADE_STATES.has(r.status));
      if (unresolved) throw new Denied('UNRESOLVED_TRADE_EXISTS', 409);
      await this.preflight(key, review, 'manual', review.walletAddress);
      const fresh = await this.wallet.quote(Object.fromEntries(['chainId', 'fromToken', 'toToken', 'amount', 'slippage'].map(k => [k, review[k]])));
      if (fresh?.mode !== 'official-quote' || fresh.chainId !== review.chainId || !same(fresh.fromToken, review.fromToken) || !same(fresh.toToken, review.toToken)
          || units(fresh.amount) !== units(review.amount) || units(fresh.slippagePercent) !== units(review.slippage)) throw new Denied('TRADE_QUOTE_MISMATCH', 503);
      if (units(fresh.estimatedOut) < units(review.quotedOut)) throw new Denied('TRADE_QUOTE_CHANGED_REVIEW_REQUIRED', 409);
      const risk = await this.risk(review), sourceRisk = await this.sourceRisk(review);
      if (risk.blocked) throw new Denied('TOKEN_RISK_BLOCKED', 403);
      if (JSON.stringify(risk) !== JSON.stringify(review.risk) || JSON.stringify(sourceRisk) !== JSON.stringify(review.sourceRisk)) throw new Denied('TOKEN_AUDIT_CHANGED_REVIEW_REQUIRED', 409);
      await this.bound(key, 'manual', review.walletAddress);
      const now = this.clock(); if (now < review.createdAt || now >= review.expiresAt) throw new Denied('TRADE_REVIEW_EXPIRED', 409);
      const record = { schema: 1, intentId: review.intentId, reviewId: review.reviewId, walletAddress: review.walletAddress,
        ...Object.fromEntries(['chainId', 'fromToken', 'toToken', 'amount', 'slippage', 'mev', 'gasLevel', 'quotedOut', 'minimumReferenceOut'].map(k => [k, review[k]])),
        createdAt: review.createdAt, submittedAt: now, updatedAt: now, status: 'SUBMITTING', orderId: null, txHash: null,
        actualReceived: null, failureCode: null, requiresAppConfirmation: false };
      await this.journal.create(record); // Durable intent precedes the sole side effect.
      try {
        await this.bound(key, 'manual', review.walletAddress);
        this.gate.sessions.byKey(key);
        const binding = this.gate.binding;
        if (!binding || binding.sessionKey !== key || !binding.permissions.includes('manual') || !same(binding.addresses['56'], review.walletAddress)
            || this.clock() < review.createdAt || this.clock() >= review.expiresAt) throw new Error();
      } catch {
        return this.journal.update(record.intentId, { status: 'FAILED', failureCode: 'PRE_SUBMISSION_AUTH_OR_REVIEW_EXPIRED', updatedAt: this.clock() });
      }
      let response;
      try { response = await this.executeSwap(Object.freeze(Object.fromEntries(['chainId', 'fromToken', 'toToken', 'amount', 'slippage'].map(k => [k, review[k]])))); }
      catch { return this.journal.update(record.intentId, { status: 'UNKNOWN', failureCode: 'SUBMISSION_RESULT_UNKNOWN', updatedAt: this.clock() }); }
      if (response?.outcome === 'REJECTED' || response?.status === 'REJECTED') {
        return this.journal.update(record.intentId, { status: 'FAILED',
          failureCode: typeof response.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(response.code) ? response.code : 'OFFICIAL_REJECTED', updatedAt: this.clock() });
      }
      const data = response?.success === true ? response.data : response;
      const oid = orderId(data?.orderId), pendingApp = data?.status === 'PENDING_CONFIRMATION' || data?.requiresAppConfirmation === true;
      const unknown = data?.status === 'UNKNOWN' || data?.outcome === 'UNKNOWN' || !oid;
      return this.journal.update(record.intentId, { status: unknown ? 'UNKNOWN' : (pendingApp ? 'PENDING_CONFIRMATION' : 'SUBMITTED'),
        orderId: oid, txHash: txHash(data?.txHash), requiresAppConfirmation: pendingApp,
        failureCode: unknown ? 'SUBMISSION_RESULT_UNKNOWN' : null, updatedAt: this.clock() });
    });
  }
  async locate(key, request) {
    fields(request, ['intentId', 'orderId']);
    if (Boolean(request.intentId) === Boolean(request.orderId)) throw new Denied('TRADE_IDENTIFIER_REQUIRED', 400);
    const bound = await this.bound(key);
    let record;
    if (request.intentId) record = await this.journal.read(request.intentId);
    else {
      if (!orderId(request.orderId)) throw new Denied('INVALID_ORDER_ID', 400);
      const rows = (await this.journal.all()).filter(r => same(r.walletAddress, bound.walletAddress) && r.orderId === request.orderId);
      if (rows.length > 1) throw new Denied('TRADE_JOURNAL_INVALID', 503); record = rows[0];
    }
    if (!record || !same(record.walletAddress, bound.walletAddress)) throw new Denied('UNKNOWN_TRADE', 404);
    return record;
  }
  async status(key, request) {
    let record = await this.locate(key, request);
    if (!TERMINAL_TRADE_STATES.has(record.status) && record.orderId) {
      let data; try { const result = await this.readOrder({ orderId: record.orderId, chainId: record.chainId }); data = result?.success === true ? result.data : result; }
      catch { await this.bound(key, 'read', record.walletAddress); return { ...publicRecord(record), pollingError: 'ORDER_STATUS_UNAVAILABLE' }; }
      const rows = Array.isArray(data?.list) ? data.list : data?.orderId ? [data] : [];
      if (rows.length !== 1) { await this.bound(key, 'read', record.walletAddress); return { ...publicRecord(record), pollingError: 'ORDER_NOT_UNIQUELY_IDENTIFIED' }; }
      const row = rows[0];
      if (row.orderId !== record.orderId || row.chain !== record.chainId || !same(row.fromToken, record.fromToken) || !same(row.toToken, record.toToken)
          || typeof row.fromTokenQty !== 'string' || units(row.fromTokenQty) !== units(record.amount)
          || (row.walletAddress && !same(row.walletAddress, record.walletAddress))) throw new Denied('TRADE_ORDER_MISMATCH', 503);
      const allowed = new Set(['PENDING', 'PENDING_CONFIRMATION', 'FINISHED', 'FAILED']);
      let next = allowed.has(row.status) ? row.status : 'UNKNOWN';
      const hash = txHash(row.txHash); if (next === 'FINISHED' && !hash) next = 'UNKNOWN';
      let received = null;
      for (const candidate of [row.toTokenActualQty, row.actualReceived]) {
        try { if (typeof candidate === 'string') { received = tidy(candidate); break; } } catch { /* Never invent an actual amount. */ }
      }
      await this.bound(key, 'read', record.walletAddress);
      record = await this.journal.update(record.intentId, { status: next, txHash: hash || record.txHash, actualReceived: received,
        requiresAppConfirmation: next === 'PENDING_CONFIRMATION', failureCode: next === 'FAILED' ? 'OFFICIAL_ORDER_FAILED' : next === 'UNKNOWN' ? 'ORDER_RESULT_UNCONFIRMED' : null, updatedAt: this.clock() });
    }
    await this.bound(key, 'read', record.walletAddress);
    const value = publicRecord(record);
    if (record.status === 'SUBMITTING' && !this.inFlight.has(record.reviewId)) Object.assign(value, { status: 'UNKNOWN', needsReadOnlyReconciliation: true });
    return value;
  }
  async list(key, request = {}) {
    fields(request, []); const bound = await this.bound(key);
    const list = (await this.journal.all()).filter(r => same(r.walletAddress, bound.walletAddress)).sort((a, b) => b.createdAt - a.createdAt).map(r => {
      const value = publicRecord(r);
      if (r.status === 'SUBMITTING' && !this.inFlight.has(r.reviewId)) value.status = 'UNKNOWN';
      return value;
    });
    await this.bound(key, 'read', bound.walletAddress); return { list };
  }
}
