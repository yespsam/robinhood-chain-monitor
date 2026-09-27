#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { marketCoverageStatus, flowCoverageStatus } from '../dashboard/coverage-status.js';

export function observationSample(snapshot, capturedAt, seenTrades = new Set()) {
  if (snapshot?.mode !== 'paper' || snapshot.execution !== false || snapshot.signing !== false || snapshot.broadcast !== false
    || !Array.isArray(snapshot.account?.trades)) throw Error('仅允许读取模拟账户');
  const unique = [...new Map((snapshot.evaluations || []).map(e => [`${e.token.chain}:${e.token.address}`, e])).values()];
  const rejections = {};
  // Counts are per evaluation (one token can be evaluated by four strategies).
  for (const e of snapshot.evaluations || []) for (const reason of new Set([...(e.missing || []), ...(e.reasons || [])])) {
    const group = reason.startsWith('资金流未达') ? '资金流未达门槛' : reason;
    rejections[group] = (rejections[group] || 0) + 1;
  }
  const trades = snapshot.account.trades.filter(t => !seenTrades.has(t.id)).map(t => ({
    id: t.id, side: t.side, chain: t.chain, address: t.address, symbol: t.symbol, atMs: t.atMs, observedAt: t.observedAt,
    price: t.price, quantity: t.quantity, netUsd: t.netUsd, costsUsd: t.costsUsd, realizedPnl: t.realizedPnl, reason: t.reason,
  }));
  const observedTokens = new Set(snapshot.account.trades.map(t => `${t.chain}:${t.address}`));
  return { at: new Date(capturedAt).toISOString(), engineStatus: snapshot.status, engineUpdatedAt: snapshot.updatedAt,
    enabled: snapshot.enabled, cash: snapshot.account.cash, realizedPnl: snapshot.account.realizedPnl,
    tradeCount: snapshot.account.trades.length, positions: Object.values(snapshot.account.positions || {}).map(p => ({
      chain: p.chain, address: p.address, symbol: p.symbol, openedAt: p.openedAt, entryPrice: p.entryPrice,
      markAt: p.markAt, markPrice: p.markPrice, markStatus: p.markStatus, peakPrice: p.peakPrice })),
    newTrades: trades,
    exitMonitor: snapshot.exitMonitor, lastQuoteTiming: snapshot.cadence?.lastQuoteTiming,
    evaluationGapMs: snapshot.cadence?.actualTickGapMs, quoteTargets: snapshot.cadence?.quoteTargets,
    chains: Object.fromEntries(Object.entries(snapshot.chainCoverage || {}).map(([chain, c]) => [chain, {
      market: marketCoverageStatus(c.market, capturedAt), trenches: marketCoverageStatus(c.trenches, capturedAt),
      flow: { ...flowCoverageStatus(c.flow, capturedAt), providerLabel: c.flow?.providerLabel, coverageGap: c.flow?.coverageGap },
      candidates: c.candidates, flowDiscovered: c.flowDiscovered, researchPending: c.researchPending, eligible: c.eligible }])),
    funnel: { uniqueCandidates: unique.length, flowFresh: unique.filter(e => e.evidence?.flowFresh).length,
      positiveNet: unique.filter(e => e.evidence?.flow?.netBuyUsd > 0).length,
      twoBuyers: unique.filter(e => e.evidence?.flow?.uniqueBuyerCount >= 2).length,
      safetyClear: unique.filter(e => e.evidence?.safety?.missing?.length === 0 && e.evidence?.safety?.blocked?.length === 0).length },
    rejectionCounts: Object.fromEntries(Object.entries(rejections).sort((a,b) => b[1]-a[1]).slice(0,25)),
    // Post-exit prices are only sampled when the token remains in evaluations.
    // Null priceObservedAt is not promoted to a fresh independent quote.
    trackedPrices: unique.filter(e => observedTokens.has(`${e.token.chain}:${e.token.address}`)).map(e => ({
      chain: e.token.chain, address: e.token.address, price: e.token.price,
      quoteObservedAt: e.evidence?.priceObservedAt, marketObservedAt: e.evidence?.marketObservedAt,
      priceFresh: e.evidence?.priceFresh, marketFresh: e.evidence?.marketFresh })),
  };
}

async function main() {
  if (process.argv.length > 2) throw Error('本观察固定运行三十分钟，无交易参数');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), data = path.join(root, 'data');
  const started = Date.now(), deadline = started + 1800000, iso = new Date(started).toISOString();
  const file = path.join(data, `paper-observation-${iso.replace(/[:.]/g,'-')}.json`);
  const lockPath = path.join(data, 'paper-observation.lock');
  const lock = await fs.open(lockPath, 'wx', 0o600);
  const record = { schema: 'yesp_paper_observation_v1', mode: 'readonly_observation', status: 'running',
    pid: process.pid, startedAt: iso, deadlineAt: new Date(deadline).toISOString(), intervalMs: 10000, samples: [], errors: [],
    note: '只读观察现有模拟引擎，不开仓、不停止监控、不修改账本。十秒采样并非完整逐笔行情，不能证明真实滑点或精确止损延迟。' };
  let stopped = false, baseline = false;
  const seen = new Set();
  const stop = () => { stopped = true; };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  const save = async () => {
    record.updatedAt = new Date().toISOString();
    await fs.writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 }); await fs.rename(`${file}.tmp`, file);
  };
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, file, deadlineAt: record.deadlineAt }));
    await save(); console.log(JSON.stringify({ file, startedAt: iso, deadlineAt: record.deadlineAt, mode: record.mode }));
    while (!stopped && Date.now() < deadline) {
      const tick = Date.now();
      try {
        const response = await fetch('http://127.0.0.1:4173/api/strategy-state', { signal: AbortSignal.timeout(5000) });
        if (!response.ok) throw Error('状态接口不可用');
        const snapshot = await response.json();
        const sample = observationSample(snapshot, Date.now(), seen);
        if (!baseline) { record.baseline = { at: sample.at, cash: sample.cash, realizedPnl: sample.realizedPnl, tradeCount: sample.tradeCount };
          sample.newTrades = []; baseline = true; }
        snapshot.account.trades.forEach(t => seen.add(t.id)); record.samples.push(sample);
      } catch { record.errors.push({ at: new Date().toISOString(), code: 'OBSERVATION_UNAVAILABLE', text: '模拟状态读取或校验失败，不填补缺失样本' }); }
      await save();
      await delay(Math.max(1, Math.min(10000 - (Date.now() - tick), deadline - Date.now())));
    }
    record.status = stopped ? 'interrupted' : record.errors.length ? 'completed_with_gaps' : 'completed';
    record.finishedAt = new Date().toISOString(); await save();
    console.log(JSON.stringify({ file, status: record.status, samples: record.samples.length, errors: record.errors.length }));
  } finally { process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); await lock.close(); await fs.unlink(lockPath); }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(() => { console.error('只读观察器未能完成；请检查锁、服务和已保存记录，未修改模拟账本'); process.exitCode = 1; });
}
