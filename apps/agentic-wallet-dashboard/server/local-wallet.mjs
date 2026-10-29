import { randomBytes } from 'node:crypto';
import { Denied } from './auth.mjs';
import { WalletGate } from './policy.mjs';
import { validChain, validContract, estimateAssets, reviewBlockers } from './model.mjs';
import { safeDiagnostic } from './diagnostics.mjs';
import { createPortfolioReader } from './portfolio.mjs';

const id = () => randomBytes(32).toString('hex');
const BOUND_SESSION_LIFETIME_MS = 24 * 60 * 60 * 1000;
const fields = (body, allowed) => { if (Object.keys(body).some(k => !allowed.includes(k))) throw new Denied('UNEXPECTED_FIELD', 400); };
export const LOCAL_CAPABILITIES = Object.freeze({ liveWalletAuth: true, walletRead: true, livePortfolio: true, swapQuotes: true,
  liveTrades: false, manualTrades: false, tokenMinting: false, tokenRevocation: false, automation: false, offlineAutomation: false });

// No dashboard password or Binance credentials. The browser may retain this short-lived
// local capability in origin-scoped sessionStorage to recover across refreshes.
// Local access is an OS trust boundary, not proof of the human owner's identity.
export class LocalWalletAccess {
  constructor(wallet, clock = Date.now, { portfolioReader = createPortfolioReader({ clock }), tradeService = null } = {}) {
    this.wallet = wallet; this.clock = clock; this.client = null; this.flow = null; this.busy = false; this.nextAuth = 0;
    this.portfolioReader = portfolioReader;
    this.tradeService = tradeService; this.mintService = null;
    this.gate = new WalletGate({ wallet, clock, sessions: {
      byKey: key => this.check(key), invalidateAll: () => this.lock()
    } });
  }
  check(key, { allowExpiredBound = false } = {}) {
    const c = this.client;
    const now = this.clock();
    if (!c || c.key !== key || now < c.lastSeen || now >= c.maxExpiresAt || (!c.bound && now >= c.expiresAt)) {
      if (c?.key === key) this.lock();
      throw new Denied('LOCAL_SESSION_EXPIRED', 401);
    }
    c.lastSeen = now;
    // A cached official idle deadline can become stale while this page sleeps.
    // Only the read-only state verifier may cross it to ask the official wallet.
    // Other requests remain blocked without destroying that recovery capability.
    if (now >= c.expiresAt && !(allowExpiredBound && this.gate.binding && !this.flow?.bindingInProgress))
      throw new Denied('AUTH_STATUS_UNCONFIRMED', 503);
    return c;
  }
  touch(key) {
    const c = this.check(key);
    // After address confirmation, the official authorization and the fixed local
    // bound-session deadline govern access. Reads must not shorten it to 10 minutes.
    if (!c.bound) c.expiresAt = Math.min(this.clock() + 600_000, c.maxExpiresAt);
  }
  updateAuthorization(key, expiresAt, { bound = false, checkSession = () => this.check(key) } = {}) {
    const c = checkSession();
    if (!Number.isFinite(expiresAt) || expiresAt <= this.clock()) {
      this.lock(); throw new Denied('WALLET_AUTH_EXPIRED');
    }
    if (bound && !c.bound) {
      c.bound = true;
      c.maxExpiresAt = this.clock() + BOUND_SESSION_LIFETIME_MS;
    }
    if (c.bound) c.expiresAt = Math.min(expiresAt, c.maxExpiresAt);
    if (this.flow) this.flow.walletExpiresAt = expiresAt;
    this.check(key);
  }
  lock() { this.client = null; this.flow = null; this.gate.binding = null; }
  bootstrap({ reuseExisting = false } = {}) {
    if (reuseExisting && this.client) {
      try {
        // The protected launcher can recover an existing bound capability; its
        // next /state request still has to revalidate the official authorization.
        const c = this.check(this.client.key, { allowExpiredBound: true });
        return { token: c.key, expiresAt: c.expiresAt, identityVerified: false };
      } catch (error) { if (error.code !== 'LOCAL_SESSION_EXPIRED') throw error; }
    }
    // Reopening the launcher must not replace a still-running official verification.
    if (reuseExisting && this.busy) throw new Denied('AUTH_IN_PROGRESS', 409);
    this.lock(); const now = this.clock();
    this.client = { key: id(), owner: 'local-browser', lastSeen: now, expiresAt: now + 600_000, maxExpiresAt: now + 3_600_000 };
    return { token: this.client.key, expiresAt: this.client.expiresAt, identityVerified: false };
  }
  state(key) {
    const c = this.check(key), f = this.flow, binding = this.gate.binding, connected = !!binding && !f?.bindingInProgress;
    const state = { expiresAt: c.expiresAt, walletConnected: connected,
      capabilities: { ...LOCAL_CAPABILITIES, manualTrades: this.tradeService !== null, liveTrades: this.tradeService !== null, tokenMinting: this.mintService !== null },
      phase: connected ? 'CONNECTED' : f?.phase || 'DISCONNECTED', error: f?.error || null,
      stage: f?.stage || 'LOCAL', diagnostic: f?.diagnostic || null, operationPending: this.busy,
      nextSignInAt: this.nextAuth,
      requiresStatusCheck: !!f?.requiresStatusCheck, waitStopped: !!f?.paused };
    if (f?.phase === 'WAITING' && !f.paused) {
      const expiry = Number(f.expireAt), valid = Number.isSafeInteger(expiry) && expiry > this.clock();
      Object.assign(state, { authExpiresAt: f.expireAt, authQrExpired: !valid });
      if (valid) Object.assign(state, { urlForWeb: f.urlForWeb, pairingCode: f.pairingCode });
    }
    if (f?.phase === 'REVIEW' || connected) Object.assign(state, { candidateId: f?.candidateId,
      chains: f?.chains, addresses: f?.addresses, walletExpiresAt: f?.walletExpiresAt, alreadyConnected: !!f?.alreadyConnected });
    return state;
  }
  async candidate(key, flow) {
    flow.phase = 'VERIFYING'; flow.stage = 'STATUS';
    const recheck = () => { this.check(key); if (this.flow !== flow || flow.paused) throw new Denied('AUTH_FLOW_CHANGED'); };
    if (await this.wallet.status() !== 'CONNECTED') throw new Denied('WALLET_AUTH_INVALID'); recheck();
    flow.stage = 'SETTINGS';
    const settings = await this.wallet.settings(); recheck();
    const expiry = Math.min(Date.parse(settings.sessionExpireTime), Date.parse(settings.inactiveSignOutTime));
    if (!Number.isFinite(expiry) || expiry <= this.clock()) throw new Denied('WALLET_AUTH_EXPIRED');
    flow.stage = 'CHAINS'; const chains = await this.wallet.chains(); recheck();
    flow.stage = 'ADDRESSES'; const addresses = await this.wallet.addresses(); recheck();
    const supported = chains.filter(x => addresses.some(a => a.chainId === x.id));
    if (!supported.length || new Set(supported.map(x => x.id)).size !== supported.length) throw new Denied('WALLET_ADDRESS_UNCONFIRMED');
    const selected = supported.map(c => {
      validChain(c.id); const rows = addresses.filter(a => a.chainId === c.id);
      if (rows.length !== 1) throw new Denied('WALLET_ADDRESS_UNCONFIRMED');
      validContract(c.id, rows[0].address); return { chainId: c.id, address: rows[0].address };
    });
    Object.assign(flow, { phase: 'REVIEW', candidateId: id(), chains: supported, addresses: selected, walletExpiresAt: expiry });
    delete flow.urlForWeb; delete flow.pairingCode; delete flow.qrCodeId;
  }
  async start(key, { checkOnly = false } = {}) {
    this.touch(key);
    if (this.gate.binding) throw new Denied('WALLET_ALREADY_BOUND', 409);
    if (this.busy) throw new Denied('AUTH_IN_PROGRESS', 409);
    // A read-only recovery check must neither consume nor extend the signin
    // cooldown. Otherwise "check, then connect" traps the user in a 429 loop.
    if (!checkOnly && this.clock() < this.nextAuth) throw new Denied('AUTH_RATE_LIMIT', 429);
    this.busy = true;
    if (!checkOnly) this.nextAuth = this.clock() + 10_000;
    const flow = { phase: 'CHECKING', stage: 'STATUS' }; this.flow = flow;
    const current = () => { this.check(key); if (this.flow !== flow) throw new Denied('AUTH_FLOW_CHANGED'); return !flow.paused; };
    // One server-owned operation. HTTP polling never creates another signin/verify.
    this.verification = (async () => {
      try {
        const status = await this.wallet.status(); if (!current()) return;
        if (status === 'CONNECTED') { flow.alreadyConnected = true; await this.candidate(key, flow); return; }
        if (status !== 'UNCONNECTED') throw new Denied('AUTH_STATUS_UNCONFIRMED');
        if (checkOnly) { flow.phase = 'DISCONNECTED'; flow.statusChecked = true; return; }
        flow.phase = 'STARTING'; flow.stage = 'SIGNIN';
        const auth = await this.wallet.beginOfficialSignIn(); if (!current()) return;
        if (auth.alreadyConnected) { flow.alreadyConnected = true; await this.candidate(key, flow); return; }
        Object.assign(flow, { phase: 'WAITING', stage: 'VERIFY', ...auth });
        // Keep the CLI foreground child alive and awaited through its official 5-minute wait.
        // Stop-waiting hides the UI/polls; it does not kill verify or claim remote revocation.
        const result = await this.wallet.verifyOfficialSignIn(auth.qrCodeId); if (!current()) return;
        flow.phase = 'VERIFYING';
        if (!result.verified) throw new Denied('WALLET_AUTH_INVALID');
        await this.candidate(key, flow);
      } catch (error) {
        if (this.flow === flow && !flow.paused) {
          const diag = safeDiagnostic(error, flow.stage);
          Object.assign(flow, { phase: diag.category === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED', error: diag.code, diagnostic: diag, requiresStatusCheck: true });
        }
      } finally {
        delete flow.urlForWeb; delete flow.pairingCode; delete flow.qrCodeId;
        this.busy = false;
      }
    })();
    return this.state(key);
  }
  async bind(key, body) {
    fields(body, ['candidateId', 'confirmed']); this.touch(key); const f = this.flow;
    if (this.gate.binding) throw new Denied('WALLET_ALREADY_BOUND', 409);
    if (!f || f.phase !== 'REVIEW' || body.candidateId !== f.candidateId || body.confirmed !== true)
      throw new Denied('WALLET_CONFIRMATION_REQUIRED');
    const binding = { sessionKey: key, owner: this.check(key).owner, userConfirmed: true, permissions: this.tradeService || this.mintService ? ['read', 'manual'] : ['read'],
      addresses: Object.fromEntries(f.addresses.map(x => [x.chainId, x.address])) };
    f.phase = 'VERIFYING'; f.stage = 'BIND'; f.bindingInProgress = true; this.gate.binding = binding;
    try {
      let expiresAt = Infinity;
      for (const chain of Object.keys(binding.addresses)) {
        const verified = await this.gate.check(key, chain);
        expiresAt = Math.min(expiresAt, verified.expiresAt);
      }
      this.updateAuthorization(key, expiresAt, { bound: true });
    }
    catch (error) { this.lock(); throw error; }
    f.bindingInProgress = false; return this.state(key);
  }
  async handle(path, key, body, { reuseSession = false } = {}) {
    if (path === '/api/local/session') { fields(body, []); return this.bootstrap({ reuseExisting: reuseSession }); }
    if (path === '/api/local/state') {
      fields(body, []);
      const checkSession = () => this.check(key, { allowExpiredBound: true });
      checkSession();
      if (this.gate.binding && !this.flow?.bindingInProgress) {
        const first = Object.keys(this.gate.binding.addresses)[0];
        const verified = await this.gate.check(key, first, 'read', { checkSession });
        this.updateAuthorization(key, verified.expiresAt, { checkSession });
      }
      return this.state(key);
    }
    if (path === '/api/local/lock') {
      fields(body, []); this.check(key, { allowExpiredBound: true });
      this.lock(); return { locked: true, walletSignedOut: false, ordersCanceled: false };
    }
    this.check(key);
    if (path === '/api/wallet/signin') { fields(body, []); return this.start(key); }
    if (path === '/api/wallet/check') { fields(body, []); return this.start(key, { checkOnly: true }); }
    if (path === '/api/wallet/stop-waiting') {
      fields(body, []);
      if (this.gate.binding) throw new Denied('WALLET_ALREADY_BOUND', 409);
      if (this.flow) {
        Object.assign(this.flow, { phase: 'PAUSED', paused: true, requiresStatusCheck: true });
        delete this.flow.urlForWeb; delete this.flow.pairingCode;
      }
      return { ...this.state(key), remoteAuthorizationRevoked: false };
    }
    if (path === '/api/wallet/bind') return this.bind(key, body);
    if (path === '/api/wallet/signout') {
      fields(body, ['confirmed']); if (body.confirmed !== true) throw new Denied('CONFIRMATION_REQUIRED');
      if (this.busy) throw new Denied('AUTH_IN_PROGRESS', 409);
      const binding = this.gate.binding; if (!binding) throw new Denied('WALLET_NOT_BOUND');
      this.busy = true;
      try {
        for (const chain of Object.keys(binding.addresses)) await this.gate.check(key, chain);
        this.lock(); return await this.wallet.officialSignOut();
      } finally { this.lock(); this.busy = false; }
    }
    if (path === '/api/wallet/read') {
      fields(body, ['chainId', 'kind', 'contract']); this.touch(key); const chain = validChain(body.chainId);
      return this.gate.read(key, chain, async bound => {
        if (body.kind === 'portfolio') {
          if (body.contract !== undefined) throw new Denied('UNEXPECTED_FIELD', 400);
          return { ...await this.portfolioReader({ chainId: chain, walletAddress: bound.walletAddress }), ...bound };
        }
        if (body.kind === 'assets') return { ...bound, ...estimateAssets(await this.wallet.balance(chain, body.contract)),
          mode: 'official', totalComplete: false, coverage: '官方 CLI 隐藏估值低于 $0.01 的代币；未返回不代表零余额。' };
        if (body.kind === 'transactions') return this.wallet.transactions(chain);
        if (body.kind === 'pending') return this.wallet.transactions(chain, 'pending');
        if (body.kind === 'orders') return this.wallet.orders(chain, 'limit');
        if (body.kind === 'marketOrders') return this.wallet.orders(chain, 'market');
        if (body.kind === 'approvals') return this.wallet.approvals(chain);
        throw new Denied('INVALID_READ_KIND', 400);
      });
    }
    if (path === '/api/wallet/quote') {
      fields(body, ['chainId', 'fromToken', 'toToken', 'amount', 'slippage']); this.touch(key);
      const quote = await this.gate.read(key, validChain(body.chainId), async bound => ({ ...await this.wallet.quote(body), wallet: bound.walletAddress }));
      return { ...quote, blockers: reviewBlockers(quote), executable: false };
    }
    // Manual trades use the separate review/confirmation routes in app.mjs.
    throw new Denied('LIVE_TRANSACTION_REVIEW_INCOMPLETE');
  }
}
