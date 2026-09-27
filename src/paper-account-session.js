import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createPaperStrategyAccount, validatePaperStrategyAccount } from './paper-strategy-engine.js';
import { CONFIRMED_PAPER_VERSION } from './paper-confirmed-policy.js';
import { GMGN_FLOW_CHAINS } from './gmgn-flow-signal.js';

export const PAPER_SESSION_FILE = 'yesp-atm-active-paper-session.json';
export const LEGACY_PAPER_FILE = 'yesp-atm-strategy-paper.json';
export function validatePaperSession(s) {
  if (!s || s.schema !== 'yesp_atm_paper_session_v1' || !/^confirmed-pvp-v2-[a-z0-9-]{1,40}$/.test(s.id)
    || s.label !== 'V2 独立实验' || s.mode !== 'paper' || s.initialCash !== 100
    || s.strategyVersion !== CONFIRMED_PAPER_VERSION || !Number.isFinite(Date.parse(s.createdAt))
    || !Object.hasOwn(GMGN_FLOW_CHAINS, s.chain) || !Array.isArray(s.chains) || !s.chains.includes(s.chain)
    || new Set(s.chains).size !== s.chains.length || s.chains.some(c => !Object.hasOwn(GMGN_FLOW_CHAINS, c))
    || s.legacy?.file !== LEGACY_PAPER_FILE || !/^[a-f0-9]{64}$/.test(s.legacy.sha256)
    || !Number.isFinite(s.legacy.cash) || !Number.isFinite(s.legacy.realizedPnl)
    || !Number.isSafeInteger(s.legacy.tradeCount) || s.legacy.tradeCount < 0) throw new Error('独立模拟账户配置无效，未切换或补款');
  return true;
}
export function paperSessionLedgerFile(s) {
  validatePaperSession(s);
  return `yesp-atm-${s.id}.json`;
}
export async function loadPaperSession(dataDir) {
  let raw;
  try { raw = await fs.readFile(path.join(dataDir, PAPER_SESSION_FILE), 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  const s = JSON.parse(raw); validatePaperSession(s); return s;
}

// Exclusive creation, never overwrites a ledger or silently refills on retry.
async function createJson(file, value) {
  const handle = await fs.open(file, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
}
export async function createConfirmedPaperSession({ dataDir, id, nowMs = Date.now() }) {
  const prior = await loadPaperSession(dataDir);
  if (prior) {
    if (prior.id !== id) throw new Error('已有独立模拟实验，未创建另一个账户');
    // A retry confirms the same selection only; it never repairs missing funds/files.
    const saved = JSON.parse(await fs.readFile(path.join(dataDir, paperSessionLedgerFile(prior)), 'utf8'));
    if (saved.schema !== 'yesp_atm_runtime_v1' || JSON.stringify(saved.session) !== JSON.stringify(prior)
      || saved.chain !== prior.chain || typeof saved.enabled !== 'boolean' || saved.account?.initialCash !== prior.initialCash)
      throw new Error('实验账本不匹配，未重置');
    validatePaperStrategyAccount(saved.account);
    return prior;
  }
  const legacyFile = path.join(dataDir, LEGACY_PAPER_FILE), lockFile = `${legacyFile}.lock`;
  const owner = randomUUID();
  await createJson(lockFile, { pid: process.pid, owner });
  try {
    const raw = await fs.readFile(legacyFile, 'utf8'), old = JSON.parse(raw);
    validatePaperStrategyAccount(old.account);
    if (old.schema !== 'yesp_atm_runtime_v1' || old.enabled !== false || Object.keys(old.account.positions).length)
      throw new Error('旧账户必须已暂停且无持仓，未切换');
    const session = { schema: 'yesp_atm_paper_session_v1', id, label: 'V2 独立实验', mode: 'paper', initialCash: 100,
      strategyVersion: CONFIRMED_PAPER_VERSION, createdAt: new Date(nowMs).toISOString(), chain: old.chain, chains: old.chains || [old.chain],
      legacy: { file: LEGACY_PAPER_FILE, sha256: createHash('sha256').update(raw).digest('hex'), cash: old.account.cash,
        realizedPnl: old.account.realizedPnl, tradeCount: old.account.trades.length } };
    validatePaperSession(session);
    const account = createPaperStrategyAccount({ initialCash: 100, nowMs });
    // Start paused; the user-authorized start is a separate, auditable control call.
    await createJson(path.join(dataDir, paperSessionLedgerFile(session)), { schema: 'yesp_atm_runtime_v1',
      session, chain: session.chain, chains: session.chains, enabled: false, account, learningShadow: null });
    await createJson(path.join(dataDir, PAPER_SESSION_FILE), session);
    return session;
  } finally {
    const lock = JSON.parse(await fs.readFile(lockFile, 'utf8'));
    if (lock.owner === owner && lock.pid === process.pid) await fs.unlink(lockFile);
  }
}
