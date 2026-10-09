// Explicit one-shot probe only: no scheduler, no ledger, no wallet commands.
import { readTypesafeKey } from '../src/typesafe-local-key.js';
import { buildJevShadowInput, probeJevShadow } from '../src/jev-shadow-decision.js';

const args = process.argv.slice(2), mode = args[0] || '--dry-run', limit = Number(args[1] || 3);
if (!['--dry-run', '--live'].includes(mode) || args.length > 2 || !Number.isInteger(limit) || limit < 1 || limit > 3) {
  console.error('用法：node scripts/probe-jev-shadow.js --dry-run|--live [1-3]'); process.exit(1);
}
const apiKey = await readTypesafeKey();
if (mode === '--live' && !apiKey?.trim()) {
  console.log(JSON.stringify({ mode: 'shadow_only', status: 'missing_key', apiCalls: 0,
    message: '请运行 node scripts/configure-typesafe-key.js，在本地隐藏输入入口保存 TYPESAFE_API_KEY，不要在聊天中提供；尚未调用 Jev。' }, null, 2));
  process.exit(2);
}
try {
  const response = await fetch('http://127.0.0.1:4173/api/strategy-state', { redirect: 'error', signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw Error('local_snapshot_unavailable');
  const snapshot = await response.json(), nowMs = Date.now();
  const snapshotAge = nowMs - Date.parse(snapshot.updatedAt || '');
  if (snapshot.mode !== 'paper' || snapshot.execution !== false || snapshot.signing !== false || snapshot.broadcast !== false
    || !Number.isFinite(snapshotAge) || snapshotAge < 0 || snapshotAge > 30000) throw Error('fresh_paper_snapshot_required');
  const unique = new Map();
  for (const row of snapshot.evaluations || []) {
    try {
      const input = buildJevShadowInput(row, nowMs), t = input.state.candidate, id = `${t.chain}:${t.address}`;
      if (!unique.has(id)) unique.set(id, { row, input });
    } catch { /* Invalid identity is not eligible for this research probe. */ }
  }
  const candidates = [...unique.values()].sort((a, b) => Number(b.input.localChecks.sourceFresh) - Number(a.input.localChecks.sourceFresh)
    || Number(b.input.localChecks.sourceAvailable) - Number(a.input.localChecks.sourceAvailable));
  const selected = (mode === '--live' ? candidates.filter(c => c.input.localChecks.sourceAvailable) : candidates).slice(0, limit);
  const results = [];
  for (const { row, input } of selected) results.push(mode === '--live'
    ? await probeJevShadow(row, { apiKey })
    : { status: 'dry_run_not_model_output', input });
  console.log(JSON.stringify({ mode: 'shadow_only', status: mode === '--dry-run' ? 'dry_run' : results.length ? 'probe_finished' : 'insufficient_source',
    execution: false, signing: false, broadcast: false, apiCalls: mode === '--live' ? results.filter(r => !['missing_key', 'insufficient_source'].includes(r.status)).length : 0,
    uniqueCandidates: candidates.length, withSource: candidates.filter(c => c.input.localChecks.sourceAvailable).length,
    withFreshSource: candidates.filter(c => c.input.localChecks.sourceFresh).length, results,
    note: '只读旁路测试；不改变成交、余额、扫描、TG 或自动化。最多三个样本，不能据此推断稳定延迟或盈利能力。' }, null, 2));
  if (mode === '--live' && (!results.length || results.some(r => r.status !== 'evaluated'))) process.exitCode = 2;
} catch {
  console.error(JSON.stringify({ status: 'local_probe_failed', message: '请检查本地模拟盘接口及快照新鲜度；未修改交易。' }));
  process.exitCode = 1;
}
