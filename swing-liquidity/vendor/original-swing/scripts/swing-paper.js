#!/usr/bin/env node
// Entry point for the PAPER-ONLY 低市值波段 strategy. Reads only SWING_* keys from .env (no wallet/API secrets).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, swingLiveRequested } from '../src/swing-signal.js';
import { createSwing } from '../src/swing-paper.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*(SWING_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
if (swingLiveRequested(process.env)) { console.error('SWING_LIVE=true is refused: paper only.'); process.exit(2); }
const cfg = loadConfig();
const dry = process.argv.includes('--dry');
if (!cfg.enabled && !dry) { console.log('SWING_ENABLED is not true; idling (no trading, no API calls).'); setInterval(() => {}, 3600e3); }
else {
  const rt = createSwing({ cfg, dataDir: path.join(root, 'data', 'swing'), dry });
  if (process.argv.includes('--once') || dry) {
    await rt.load(); const r = await rt.tick();
    console.log(JSON.stringify(r, null, 1)); process.exit(0);
  } else await rt.run();
}
