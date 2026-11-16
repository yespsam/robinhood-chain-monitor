#!/usr/bin/env node
// Paper-only entry for the liquidity-first low-cap swing.
// Honors SWING_DATA_DIR. Default directory is data/swing-liquidity under this bundle, never data/swing.
// Reads SWING_* keys from a local .env when one exists. Does not require .env and does not read other keys.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, swingLiveRequested } from '../src/liquidity-signal.js';
import { createLiquiditySwing } from '../src/liquidity-paper.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*(SWING_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch { /* no .env is normal */ }

if (swingLiveRequested(process.env)) {
  console.error('SWING_LIVE=true is refused: this process is paper-only and cannot place an order.');
  process.exit(2);
}

const offline = process.argv.includes('--offline');
const dry = offline || process.argv.includes('--dry');
const once = process.argv.includes('--once') || dry;
const dataDir = process.env.SWING_DATA_DIR
  ? path.resolve(root, process.env.SWING_DATA_DIR)
  : path.join(root, 'data', 'swing-liquidity');

if (offline) {
  const { runOfflineDry } = await import('../src/offline-fixture.js');
  const { status } = await runOfflineDry(process.env);
  console.log(JSON.stringify({ offline: true, writes: false, live: status.live, ranked: status.ranked, signals: status.signals, rejected: status.rejected, curve: status.curve }, null, 1));
  process.exit(0);
}

const cfg = loadConfig(process.env);
if (!cfg.enabled && !dry) {
  console.log('SWING_ENABLED is not true; idling (no trading, no API calls).');
  setInterval(() => {}, 3600e3);
} else {
  try {
    const rt = createLiquiditySwing({ cfg, dataDir, dry });
    if (once) {
      await rt.load();
      const status = await rt.tick();
      console.log(JSON.stringify(status, null, 1));
      process.exit(0);
    }
    await rt.run();
  } catch (e) {
    if (e && ['LEGACY_LEDGER', 'FOREIGN_LEDGER', 'LEGACY_STRATEGY', 'BAD_CONFIG'].includes(e.code)) {
      console.error(e.message);
      process.exit(2);
    }
    throw e;
  }
}
