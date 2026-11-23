#!/usr/bin/env node
// Entry point for the PAPER-ONLY 老盘重启 strategy. Reads only OLD_REVIVAL_* keys from .env (no wallet/API secrets).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/old-revival-signal.js';
import { createOldRevival } from '../src/old-revival-paper.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*(OLD_REVIVAL_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
const cfg = loadConfig();
const dry = process.argv.includes('--dry');
if (cfg.live) { console.error('OLD_REVIVAL_LIVE=true is refused: paper only.'); process.exit(2); }
if (!cfg.enabled && !dry) { console.log('OLD_REVIVAL_ENABLED is not true; idling (no trading, no API calls).'); setInterval(() => {}, 3600e3); }
else {
  const rt = createOldRevival({ cfg, dataDir: path.join(root, 'data', 'old-revival'), dry });
  if (process.argv.includes('--once') || dry) {
    await rt.load(); const r = await rt.tick();
    console.log(JSON.stringify(r.evaluated, null, 1)); console.log(`watch=${r.watch} snaps=${r.snaps}`); process.exit(0);
  } else await rt.run();
}
