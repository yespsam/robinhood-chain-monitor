import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Explicit setup command; never invoked by a cloud build or a trading worker.
// Dedicated write-only snapshot credential, unrelated to any exchange key.
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [siteId, publicUrl] = process.argv.slice(2);
if (!/^[a-f0-9-]{36}$/.test(siteId || '') || !/^https:\/\/[a-z0-9-]+\.netlify\.app\/?$/.test(publicUrl || '')) throw new Error('Usage: node scripts/configure-public-publisher.js <site-id> <https-site-url>');
const configFile = path.join(project, 'data/public-publisher.json');
let previous;
try { previous = JSON.parse(await fs.readFile(configFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (previous && previous.url !== publicUrl) throw new Error('Existing publisher targets another site; review before replacing');
const token = previous?.token || randomBytes(48).toString('hex');
const envFile = path.join(project, 'data/public-publisher-setup.env');
await fs.mkdir(path.dirname(configFile), { recursive: true });
let createdTemporary = false;
try {
  await fs.writeFile(envFile, `PUBLIC_PUBLISH_TOKEN=${token}\n`, { mode: 0o600, flag: 'wx' });
  createdTemporary = true;
  const run = args => {
    const result = spawnSync('npx', ['--yes', 'netlify-cli', ...args], { cwd: project, encoding: 'utf8', stdio: 'pipe' });
    // CLI output may echo credentials. Never log stdout/stderr from env commands.
    if (result.status !== 0) throw new Error(`Netlify ${args[0]} failed; output suppressed to protect secrets`);
  };
  run(['env:import', envFile, '--site', siteId]);
  run(['env:set', 'PUBLIC_PUBLISH_TOKEN', '--secret', '--force', '--site', siteId]);
  await fs.writeFile(configFile, JSON.stringify({ url: publicUrl, token }), { mode: 0o600 });
  await fs.chmod(configFile, 0o600);
  console.log('Dedicated publish credential configured; value not displayed.');
} finally { if (createdTemporary) await fs.unlink(envFile).catch(() => {}); }
