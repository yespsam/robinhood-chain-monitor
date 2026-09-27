// Public read-only routes used here have weights <= 5. Current official Free
// bucket is 5 units/second (Plus 20, Pro 50). Serial 1.2s spacing leaves margin
// even at weight 5; it is not an entitlement to ignore a returned 429/reset.
// https://github.com/GMGNAI/gmgn-skills/tree/main/skills (verified 2026-09-23)
// No signed follow-wallet/swap or Pro-only 1s K-line route uses this scheduler.
import fs from 'node:fs';
import path from 'node:path';

export const GMGN_READONLY_INTERVAL_MS = 1200;
const FREE = Object.freeze({ plan: 'free', intervalMs: 1200, concurrency: 1, normalConcurrency: 1, chargedWeight: 5 });
// Plus allows 20 weighted units/s. Charge EVERY supported read-only request
// its worst-case weight (5), spaced 350ms apart: <=14.29 units/s, no burst.
// This deliberately leaves headroom for CLI retries/other account consumers.
const PLUS = Object.freeze({ plan: 'plus', intervalMs: 350, concurrency: 3, normalConcurrency: 2, chargedWeight: 5 });

export function gmgnReadonlyPolicy(dataDir) {
  const file = path.join(dataDir, 'gmgn-readonly-plan.json');
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) throw new Error();
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value?.version !== 1 || !['free', 'plus'].includes(value.plan)
        || Object.keys(value).some(key => !['version', 'plan'].includes(key))) throw new Error();
    return value.plan === 'plus' ? PLUS : FREE;
  } catch (error) {
    if (error.code === 'ENOENT') return FREE;
    throw Object.assign(new Error('GMGN_STATE_INVALID'), { code: 'GMGN_STATE_INVALID' });
  }
}
