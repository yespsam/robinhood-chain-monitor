import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(scrypt);
const digest = text => createHash('sha256').update(text).digest('hex');
const random = () => randomBytes(32).toString('base64url');
const SCRYPT = Object.freeze({ N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });

export class Denied extends Error {
  constructor(code, status = 403) { super(code); this.code = code; this.status = status; }
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 16 || password.length > 256)
    throw new Denied('PASSWORD_LENGTH_16_TO_256', 400);
  const salt = randomBytes(32).toString('hex');
  const hash = (await derive(password, salt, 64, SCRYPT)).toString('hex');
  return { version: 1, username: 'owner', algorithm: 'scrypt', salt, hash };
}

export function validOwner(owner) {
  return owner?.version === 1 && owner.username === 'owner' && owner.algorithm === 'scrypt'
    && /^[a-f0-9]{64}$/.test(owner.salt) && /^[a-f0-9]{128}$/.test(owner.hash);
}

// Single local owner. Browser gets only an opaque HttpOnly session cookie.
// No Binance credentials are accepted or persisted anywhere in this application.
export class Sessions {
  constructor({ owner = null, clock = Date.now, idleMs = 10 * 60_000, absoluteMs = 60 * 60_000 } = {}) {
    if (owner && !validOwner(owner)) throw new Error('INVALID_OWNER_CONFIGURATION');
    this.owner = owner;
    this.clock = clock;
    this.idleMs = idleMs;
    this.absoluteMs = absoluteMs;
    this.items = new Map();
    this.loginAttempts = [];
    this.epoch = 0;
    this.listeners = new Set();
    this.loginInFlight = false;
  }
  get configured() { return !!this.owner; }
  configureOwner(owner) {
    if (owner && !validOwner(owner)) throw new Error('INVALID_OWNER_CONFIGURATION');
    this.invalidateAll('OWNER_CONFIGURATION_CHANGED'); this.owner = owner;
  }
  onInvalidate(fn) { this.listeners.add(fn); }
  invalidateAll(reason) {
    this.epoch++;
    for (const session of this.items.values()) {
      session.active = false;
      for (const listener of this.listeners) listener(session.key, reason);
    }
    this.items.clear();
  }
  async login(username, password) {
    if (!this.owner) throw new Denied('OWNER_NOT_CONFIGURED', 503);
    if (this.loginInFlight) throw new Denied('LOGIN_BUSY', 429);
    const now = this.clock();
    this.loginAttempts = this.loginAttempts.filter(t => now - t < 60_000);
    if (this.loginAttempts.length >= 5) throw new Denied('LOGIN_RATE_LIMIT', 429);
    this.loginAttempts.push(now);
    if (typeof password !== 'string' || password.length < 16 || password.length > 256 || typeof username !== 'string')
      throw new Denied('LOGIN_FAILED', 401);
    const expectedEpoch = this.epoch;
    const loginOwner = this.owner;
    this.loginInFlight = true;
    let actual, matches;
    try {
      actual = await derive(password, loginOwner.salt, 64, SCRYPT);
      matches = timingSafeEqual(actual, Buffer.from(loginOwner.hash, 'hex'));
    } finally { actual?.fill(0); this.loginInFlight = false; }
    if (!matches || username !== 'owner') throw new Denied('LOGIN_FAILED', 401);
    // A concurrent logout/lock/login invalidates an authentication already in flight.
    if (this.epoch !== expectedEpoch) throw new Denied('LOGIN_RETRY_REQUIRED', 409);
    this.invalidateAll('NEW_LOGIN');
    const token = random();
    const session = { key: digest(token), csrf: random(), owner: 'owner', epoch: this.epoch,
      active: true, createdAt: this.clock(), lastActivity: this.clock(), autoEnabled: false };
    this.items.set(session.key, session);
    return { token, session };
  }
  fromToken(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token))
      throw new Denied('SESSION_REQUIRED', 401);
    return this.byKey(digest(token));
  }
  byKey(key) {
    const session = this.items.get(key);
    if (!session || !session.active || session.epoch !== this.epoch)
      throw new Denied('SESSION_REQUIRED', 401);
    const now = this.clock();
    if (!Number.isFinite(now) || now < session.createdAt || now < session.lastActivity) {
      this.invalidateAll('SESSION_CLOCK_INVALID');
      throw new Denied('SESSION_CLOCK_INVALID', 401);
    }
    if (now >= session.createdAt + this.absoluteMs || now >= session.lastActivity + this.idleMs) {
      this.invalidateAll('SESSION_EXPIRED');
      throw new Denied('SESSION_EXPIRED', 401);
    }
    return session;
  }
  checkCsrf(session, value) {
    const a = Buffer.from(session.csrf);
    const b = Buffer.from(typeof value === 'string' ? value : '');
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Denied('CSRF_REJECTED');
  }
  touch(key) { this.byKey(key).lastActivity = this.clock(); }
  publicState(session) {
    const valid = this.byKey(session.key);
    return { authenticated: true, username: 'owner', csrf: valid.csrf, serverNow: this.clock(),
      expiresAt: Math.min(valid.createdAt + this.absoluteMs, valid.lastActivity + this.idleMs),
      idleMs: this.idleMs, absoluteMs: this.absoluteMs };
  }
}
