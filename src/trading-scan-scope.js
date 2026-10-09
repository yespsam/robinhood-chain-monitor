import fs from 'node:fs';
import path from 'node:path';
import { GMGN_FLOW_CHAINS, gmgnFlowAddress } from './gmgn-flow-signal.js';
import { validatePaperSession, paperSessionLedgerFile, ESTIMATED_SESSION_FILE, PAPER_SESSION_FILE, LEGACY_PAPER_FILE } from './paper-account-session.js';

export const TRADING_SCAN_SCOPE_FILE = 'trading-scan-scope.json';
const ALL = Object.keys(GMGN_FLOW_CHAINS);
function read(file, maxBytes) {
  try {
    if (fs.statSync(file).size > maxBytes) throw new Error('trading_scan_scope_file_too_large');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

// Startup-only policy overlay. Never rewrite an experiment's identity, history
// or balance to change discovery scope. Malformed explicit policy fails closed.
export function tradingScanChains(dataDir, available = ALL) {
  const policy = read(path.join(dataDir || 'data', TRADING_SCAN_SCOPE_FILE), 4096);
  if (policy === undefined) return [...available];
  if (policy?.version !== 1 || !Array.isArray(policy.chains) || !policy.chains.length
    || policy.chains.some(c => !ALL.includes(c)) || new Set(policy.chains).size !== policy.chains.length)
    throw new Error('trading_scan_scope_invalid');
  return policy.chains.filter(c => available.includes(c));
}

// Retain flow evidence for already-open paper positions, including comparison
// books. Only local simulated ledgers are read; no bound live wallet is queried.
// With new entries confined to scanChains, this startup union safely over-retains
// exit feeds until the next restart, rather than dropping a held chain too early.
export function tradingFlowChains(dataDir, scanChains) {
  if (scanChains.length === ALL.length) return [...scanChains];
  const dir = dataDir || 'data';
  const estimated = read(path.join(dir, ESTIMATED_SESSION_FILE), 16384);
  const session = estimated === undefined ? read(path.join(dir, PAPER_SESSION_FILE), 16384) : estimated;
  if (session !== undefined) validatePaperSession(session);
  const saved = read(path.join(dir, session ? paperSessionLedgerFile(session) : LEGACY_PAPER_FILE), 96 * 1024 * 1024);
  if (saved === undefined && !session) return [...scanChains];
  if (saved?.schema !== 'yesp_atm_runtime_v1' || !saved.account?.positions
    || session && JSON.stringify(saved.session) !== JSON.stringify(session)) throw new Error('trading_scan_exit_ledger_invalid');
  const result = new Set(scanChains);
  for (const book of [saved.account, saved.reviewComparison?.control, saved.exitComparison?.control,
    saved.exitComparison?.dynamic, saved.learningShadow?.control, saved.learningShadow?.student].filter(Boolean)) {
    for (const position of Object.values(book.positions || {})) {
      if (!ALL.includes(position.chain) || !gmgnFlowAddress(position.chain, position.address))
        throw new Error('trading_scan_exit_position_invalid');
      result.add(position.chain);
    }
  }
  return [...result];
}
