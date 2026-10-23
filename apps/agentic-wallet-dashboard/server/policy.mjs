import { Denied } from './auth.mjs';
import { addressKey, validChain } from './model.mjs';
import { isDeepStrictEqual } from 'node:util';

// This app is intentionally a development build: no auth or financial state-changing CLI calls.
export const DEVELOPMENT = Object.freeze({ liveWalletAuth: false, liveTrades: false, tokenRevocation: false, automation: false, offlineAutomation: false });

export class WalletGate {
  constructor({ sessions, wallet, binding = null, clock = Date.now }) {
    this.sessions = sessions; this.wallet = wallet; this.binding = binding; this.clock = clock;
  }
  async check(key, chain, permission = 'read') {
    validChain(chain);
    const session = this.sessions.byKey(key);
    const bind = this.binding;
    if (!bind || bind.sessionKey !== key || bind.owner !== session.owner || bind.userConfirmed !== true)
      throw new Denied('WALLET_NOT_BOUND');
    if (!bind.permissions.includes(permission)) throw new Denied('PERMISSION_DENIED');
    if (!bind.addresses[chain]) throw new Denied('CHAIN_OUTSIDE_BINDING');
    const snapshot = structuredClone(bind);
    let expiry = null;
    const revalidate = () => {
      this.sessions.byKey(key);
      if (this.binding !== bind || !isDeepStrictEqual(bind, snapshot)) {
        this.sessions.invalidateAll('WALLET_BINDING_CHANGED'); throw new Denied('WALLET_BINDING_CHANGED');
      }
      if (expiry !== null && (!Number.isFinite(expiry) || expiry <= this.clock())) {
        this.sessions.invalidateAll('WALLET_AUTH_EXPIRED'); throw new Denied('WALLET_AUTH_EXPIRED');
      }
    };
    const status = await this.wallet.status(); revalidate();
    if (status !== 'CONNECTED') { this.sessions.invalidateAll('WALLET_AUTH_INVALID'); throw new Denied('WALLET_AUTH_INVALID'); }
    const settings = await this.wallet.settings(); revalidate();
    expiry = Math.min(Date.parse(settings.sessionExpireTime), Date.parse(settings.inactiveSignOutTime));
    revalidate();
    const chains = await this.wallet.chains(); revalidate();
    if (!chains.some(x => x.id === chain)) throw new Denied('CHAIN_NOT_REPORTED_BY_WALLET');
    const addresses = await this.wallet.addresses(); revalidate();
    const candidates = addresses.filter(x => x.chainId === chain);
    if (candidates.length !== 1 || addressKey(chain, candidates[0].address) !== addressKey(chain, bind.addresses[chain])) {
      this.sessions.invalidateAll('WALLET_IDENTITY_MISMATCH'); throw new Denied('WALLET_IDENTITY_MISMATCH');
    }
    return { chainId: chain, walletAddress: bind.addresses[chain], expiresAt: expiry };
  }
  async read(key, chain, operation) {
    const bound = await this.check(key, chain, 'read');
    this.sessions.byKey(key);
    const result = await operation(bound);
    await this.check(key, chain, 'read'); // Do not release stale private data after logout or wallet changes.
    this.sessions.byKey(key); return result;
  }
  rejectWrite(key) { this.sessions.byKey(key); throw new Denied('DEVELOPMENT_WRITES_DISABLED'); }
}

// Shared confirmation/at-most-once gate for tests and future reviewed integrations.
// There is no live execution callback wired to this class in main.mjs.
export class ConfirmedQueue {
  constructor({ gate, sessions, execute, clock = Date.now }) {
    this.gate = gate; this.sessions = sessions; this.execute = execute; this.clock = clock; this.jobs = new Map();
    sessions.onInvalidate(key => { for (const j of this.jobs.values()) if (j.key === key && j.state === 'QUEUED') j.state = 'BLOCKED'; });
  }
  enqueue({ id, key, chainId, confirmed, expiresAt, review, blockers = [] }) {
    this.sessions.byKey(key);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(id) || confirmed !== true || !Array.isArray(blockers) || blockers.length || !review || typeof review !== 'object' || Array.isArray(review) || !Number.isFinite(expiresAt) || expiresAt <= this.clock()) throw new Denied('CONFIRMATION_NOT_EXECUTABLE');
    if (this.jobs.has(id)) {
      const previous = this.jobs.get(id);
      if (previous.key !== key || previous.chainId !== chainId || previous.expiresAt !== expiresAt || !isDeepStrictEqual(previous.review, review)) throw new Denied('IDEMPOTENCY_CONFLICT', 409);
      return previous.state;
    }
    if (this.jobs.size >= 1000) throw new Denied('QUEUE_CAPACITY', 429);
    this.jobs.set(id, { id, key, chainId, expiresAt, review: structuredClone(review), state: 'QUEUED' }); return 'QUEUED';
  }
  async run(id) {
    const job = this.jobs.get(id); if (!job) throw new Denied('UNKNOWN_JOB');
    if (job.state !== 'QUEUED') return job.state;
    try {
      const bound = await this.gate.check(job.key, job.chainId, 'manual');
      this.sessions.byKey(job.key);
      if (job.expiresAt <= this.clock()) throw new Denied('REVIEW_EXPIRED');
      if (job.state !== 'QUEUED') return job.state;
      job.state = 'SUBMITTING';
      try { const result = await this.execute(bound, job.review); job.state = result?.orderId ? 'SUBMITTED' : 'UNKNOWN'; }
      catch { job.state = 'UNKNOWN'; }
    } catch (error) { if (job.state === 'QUEUED') job.state = 'BLOCKED'; throw error; }
    return job.state; // UNKNOWN is sticky. Re-running this ID never invokes execute again.
  }
}
