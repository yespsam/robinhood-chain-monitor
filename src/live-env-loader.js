// Load only LIVE_* keys from project .env into process.env (launchd does not source .env).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
try {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*(LIVE_[A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}
