#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createGmgnFlowClient } from '../src/gmgn-flow-client.js';
import { gmgnFlowAddress } from '../src/gmgn-flow-signal.js';
import { parseProfitLeaderboard, mergeProfitLeaderboards } from '../src/profit-leaderboard.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), dataDir = path.join(project, 'data');
const file = path.join(dataDir, 'profit-leaderboard-candidates.json'), lock = `${file}.lock`;
const owner = randomUUID(), client = createGmgnFlowClient({ dataDir });
let held = false;
try {
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, owner }), { flag: 'wx', mode: 0o600 }); held = true;
  let previous = null;
  try { if ((await fs.stat(file)).size > 16 * 1024 * 1024) throw new Error('leaderboard_state_too_large'); previous = JSON.parse(await fs.readFile(file, 'utf8')); if (!previous) throw new Error('leaderboard_state_invalid'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let state = mergeProfitLeaderboards(previous, [], Date.now());
  const snapshot = await (await fetch('http://127.0.0.1:4173/api/strategy-state', { signal: AbortSignal.timeout(10000) })).json();
  if (snapshot.mode !== 'paper' || snapshot.execution !== false || snapshot.signing !== false || snapshot.broadcast !== false) throw new Error('paper_source_required');
  const perChain = ['robinhood', 'sol', 'bsc', 'base', 'eth'].map(chain => {
    const rows = new Map();
    for (const item of snapshot.evaluations || []) {
      const t = item.token, at = Date.parse(item.evidence?.marketObservedAt || '');
      if (t?.chain !== chain || gmgnFlowAddress(chain, t.address) !== t.address || at > Date.now() || at < Date.now() - 120000 || !item.evidence?.marketFresh) continue;
      rows.set(t.address, item);
    }
    // Compare volume only inside the same reported window; no 1m/24h mixing.
    const items = [...rows.values()], window = items.some(row => row.evidence.volume.window === '24h') ? '24h' : items[0]?.evidence?.volume?.window;
    return items.filter(row => row.evidence.volume.window === window && row.evidence.volume.value > 0)
      .sort((a, b) => b.evidence.volume.value - a.evidence.volume.value).slice(0, 2).map(row => row.token);
  });
  const targets = [0, 1].flatMap(index => perChain.map(list => list[index]).filter(Boolean));
  if (!targets.length) throw new Error('no_fresh_candidate_tokens');
  for (const token of targets) {
    const observedAt = new Date().toISOString();
    try {
      const payload = await client.topTraders(token.chain, token.address, 50);
      const result = parseProfitLeaderboard(payload, { chain: token.chain, address: token.address, observedAt });
      state = mergeProfitLeaderboards(state, result.entries, Date.now());
      const tmp = `${file}.${owner}.tmp`;
      try { await fs.writeFile(tmp, JSON.stringify(state), { flag: 'wx', mode: 0o600 }); await fs.rename(tmp, file); }
      finally { await fs.unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      console.log(JSON.stringify({ chain: token.chain, token: token.symbol, observedRows: result.observedRows,
        positiveRealized: result.entries.length, researchEligible: result.entries.filter(row => row.researchEligible).length, savedAddresses: state.entries.length }));
    } catch (error) {
      console.log(JSON.stringify({ chain: token.chain, status: 'unavailable', code: /^GMGN_|^leaderboard_/.test(error.code || error.message) ? error.code || error.message : 'leaderboard_request_failed', retryAt: error.retryAt || null }));
      if (error.code === 'GMGN_RATE_LIMITED') break;
    }
  }
  console.log(JSON.stringify({ file, uniqueAddresses: state.entries.length, eligibleForResearch: state.entries.filter(row => row.researchEligible).length,
    note: '单币盈利榜抽样；排名不代表已通过7日/30日盈利核验' }));
} catch (error) { console.error(error.code === 'EEXIST' ? '排行榜采集已有进程或待检查的锁；未删除锁' : '排行榜采集未完成，未重置既有数据'); process.exitCode = 1; }
finally { await client.stop(); if (held) { const content = JSON.parse(await fs.readFile(lock, 'utf8')); if (content.owner === owner) await fs.unlink(lock); } }
