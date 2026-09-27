import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicSnapshot } from '../src/public-dashboard-state.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = path.join(project, 'data/public-publisher.json');
const statusPath = path.join(project, 'data/public-publisher-status.json');
let stopped = false, timer;
process.once('SIGTERM', () => { stopped = true; clearTimeout(timer); });
process.once('SIGINT', () => { stopped = true; clearTimeout(timer); });

export async function publishSnapshot(config, fetcher = fetch) {
  const destination = new URL(config.url);
  if (destination.protocol !== 'https:' || !destination.hostname.endsWith('.netlify.app') || destination.username || destination.password || destination.port) throw new Error('Invalid public destination');
  if (typeof config.token !== 'string' || config.token.length < 32) throw new Error('Missing publish credential');
  const local = await fetcher('http://127.0.0.1:4173/api/strategy-state', { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!local.ok) throw new Error(`Local snapshot unavailable (${local.status})`);
  const snapshot = createPublicSnapshot(await local.json());
  if (Date.now() - Date.parse(snapshot.updatedAt) > 120000) throw new Error('Local snapshot is stale');
  const body = JSON.stringify(snapshot);
  if (Buffer.byteLength(body) > 2_000_000) throw new Error('Public snapshot exceeds size budget');
  const remote = await fetcher(new URL('/api/publish-state', destination), {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.token}` }, body,
  });
  if (!remote.ok) throw new Error(`Public receiver unavailable (${remote.status})`);
  return { status: 'ok', syncedAt: new Date().toISOString(), sourceUpdatedAt: snapshot.updatedAt, bytes: Buffer.byteLength(body), tradeCount: snapshot.publicSummary.totalTrades };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let failures = 0;
  const run = async () => {
    if (stopped) return;
    let status;
    try { status = await publishSnapshot(JSON.parse(await fs.readFile(configPath, 'utf8'))); failures = 0; }
    catch (error) { failures++; status = { status: 'error', at: new Date().toISOString(), message: error.message }; }
    await fs.writeFile(statusPath, JSON.stringify(status), { mode: 0o600 });
    if (process.argv.includes('--once')) { if (failures) process.exitCode = 1; console.log(JSON.stringify(status)); return; }
    // Sequential completion-driven timer: no overlapping snapshots or upstream GMGN calls.
    if (!stopped) timer = setTimeout(run, Math.min(120000, 15000 * 2 ** Math.min(failures, 3)));
  };
  await run();
}
