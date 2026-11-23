import fs from 'node:fs';
import path from 'node:path';
import { loadLiveConfig, readLedgerForDisplay as readLedger, checkGates, normChain } from './live-gmgn-trader.js';
import { LIVE_MIRROR_SOURCE, readBnbBalance, readBnbPriceUsd, readUsdtBalanceUsd, redactObservationError } from './live-gmgn-mirror.js';
const rj = p => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const OBSERVATION_TTL_MS = 30_000;
const OBSERVATION_MAX_AGE_MS = 60_000;
const defaultCache = Object.create(null);
const GATE_ZH = {
  'LIVE_TRADING_ENABLED is not true': '实盘总开关关闭', 'kill switch present': '急停文件存在',
  'LIVE_WALLET invalid': '钱包地址无效', 'narrative signals are shadow-only': '叙事信号只走影子盘',
  'invalid order size': '下单金额无效', 'exceeds LIVE_MAX_PER_TRADE_USD': '超过单笔上限',
  'max open positions': '持仓数已满', 'exceeds LIVE_MAX_TOTAL_USD': '超过总敞口上限',
  'daily loss stop hit': '触发当日止损', 'insufficient balance': '余额不足',
  'BNB price unavailable': '拿不到 BNB 价格', 'insufficient BNB after gas reserve': '扣掉 gas 预留后 BNB 不够',
  'slippage above max': '滑点超过上限',
};
const zhExtra = r => {
  if (!r) return null;
  if (/AUTH_IP_BLOCKED|source ip blocked/i.test(r)) return 'GMGN 交易 IP 被拒：请把当前出口 IP 加到 https://gmgn.ai/ai 白名单（只读/报价可用，swap 不行）';
  if (/confirmation required/i.test(r) && /AUTH_IP_BLOCKED/i.test(r) === false) return r;
  return null;
};

const zh = r => (r && (GATE_ZH[r] || zhExtra(r) || (/^signal source/.test(r) ? '信号来源不在白名单' : r))) || null;
const readJsonl = (p, n) => { try { return fs.readFileSync(p, 'utf8').trim().split('\n').slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse(); } catch { return []; } };

async function observe(cache, key, reader, clock, isValid = Number.isFinite) {
  const prev = cache[key] || { value: null, observedAtMs: null, attemptedAtMs: null, error: null };
  const nowMs = clock();
  if (prev.attemptedAtMs == null || nowMs - prev.attemptedAtMs >= OBSERVATION_TTL_MS) {
    prev.attemptedAtMs = nowMs;
    try {
      const value = Number(await reader());
      if (!isValid(value)) throw new Error('invalid observation');
      prev.value = value;
      prev.observedAtMs = clock();
      prev.error = null;
    } catch (error) {
      // Keep the last successful value and its original timestamp. A failed refresh
      // must never make old wallet/price data look newly observed.
      prev.error = redactObservationError(error);
    }
  }
  cache[key] = prev;
  const ageMs = prev.observedAtMs == null ? null : Math.max(0, clock() - prev.observedAtMs);
  const status = prev.value == null ? 'unavailable'
    : prev.error ? 'degraded'
      : ageMs > OBSERVATION_MAX_AGE_MS ? 'stale' : 'fresh';
  return {
    value: prev.value,
    status,
    observedAt: prev.observedAtMs == null ? null : new Date(prev.observedAtMs).toISOString(),
    ageMs,
    error: prev.error,
  };
}

const noObservation = reason => ({ value: null, status: 'not_requested', observedAt: null, ageMs: null, reason });
const fresh = item => item?.status === 'fresh';

function thought(e, src) {
  const ev = e.evidence || {};
  const noted = ev.notedWallets || e.notedWallets || null;
  return {
    source: src, at: e.at || e.observedAt || null, strategy: e.label || e.strategyId, decision: e.decision,
    symbol: e.token?.symbol || e.symbol, chain: e.token?.chain || e.chain, address: e.token?.address || e.address,
    score: e.score ?? null, entryUsd: e.entryUsd ?? null, trigger: e.trigger || null,
    reasons: (e.reasons || []).slice(0, 6), missing: (e.missing || []).slice(0, 6),
    noted: Array.isArray(noted) ? noted.slice(0, 5).map(w => ({ label: w.label || w.name || String(w.address || '').slice(0, 10), follow: w.follow, side: w.side })) : null,
  };
}

export async function buildStudioSnapshot({ project, strategy, env = process.env, dependencies = {} }) {
  const dataDir = path.join(project, 'data');
  const cfg = loadLiveConfig(env, dataDir);
  const killed = fs.existsSync(path.join(dataDir, 'live-kill'));
  const clock = dependencies.now || Date.now;
  const cache = dependencies.cache || defaultCache;
  const walletValid = /^0x[0-9a-f]{40}$/.test(cfg.wallet);
  let bnbObs = noObservation(cfg.enabled ? '钱包地址无效' : '实盘开关关闭');
  let priceObs = noObservation(cfg.enabled ? '钱包地址无效' : '实盘开关关闭');
  let usdtObs = noObservation(cfg.enabled ? '钱包地址无效' : '实盘开关关闭');
  if (cfg.enabled && walletValid) {
    const readBnb = dependencies.readBnbBalance || readBnbBalance;
    const readPrice = dependencies.readBnbPriceUsd || readBnbPriceUsd;
    const readUsdt = dependencies.readUsdtBalanceUsd || readUsdtBalanceUsd;
    [bnbObs, priceObs, usdtObs] = await Promise.all([
      observe(cache, `bnb:${cfg.wallet}`, () => readBnb(cfg.wallet), clock, value => Number.isFinite(value) && value >= 0),
      observe(cache, 'bnb-price', readPrice, clock, value => Number.isFinite(value) && value > 0),
      cfg.spendAsset === 'usdt'
        ? observe(cache, `usdt:${cfg.wallet}`, () => readUsdt(cfg.wallet), clock, value => Number.isFinite(value) && value >= 0)
        : Promise.resolve(noObservation('花费资产为 BNB，无需读取 USDT 余额')),
    ]);
  }
  const ledger = (dependencies.readLedger || readLedger)(cfg.ledgerPath) || {};
  const positions = Object.values(ledger.positions || {});
  const realizedTotalUsd = Object.values(ledger.realized || {}).reduce((sum, value) => {
    const amount = Number(value);
    return Number.isFinite(amount) ? sum + amount : sum;
  }, 0);
  const closedPositionCount = positions.filter(position => position.status === 'closed').length;
  const today = new Date().toLocaleDateString('sv', { timeZone: 'Asia/Shanghai' });

  // Read-only preview only. Never show a green gate based on missing or old wallet data.
  const spendObs = cfg.spendAsset === 'usdt' ? usdtObs : bnbObs;
  const requiredObservationsFresh = cfg.spendAsset === 'usdt'
    ? fresh(usdtObs) && fresh(bnbObs)
    : fresh(bnbObs) && fresh(priceObs);
  const balanceUsd = cfg.spendAsset === 'usdt'
    ? (fresh(usdtObs) ? usdtObs.value : null)
    : (fresh(bnbObs) && fresh(priceObs) ? Math.max(0, bnbObs.value - cfg.gasReserveBnb) * priceObs.value : null);
  const bnbForGate = fresh(bnbObs) ? bnbObs.value : null;
  const bnbPriceForGate = fresh(priceObs) ? priceObs.value : null;
  let gate = { ok: false, reason: 'unavailable' };
  try {
    if (cfg.enabled && !requiredObservationsFresh) gate = { ok: false, reason: '实时余额/价格数据不可用或已过期' };
    else gate = checkGates(cfg, { source: LIVE_MIRROR_SOURCE, usd: cfg.maxPerTradeUsd, bnbPriceUsd: bnbPriceForGate }, { ...ledger, balanceBnb: bnbForGate, balanceUsd });
  } catch (e) { gate = { ok: false, reason: e.message }; }
  const open = positions.filter(p => p.status !== 'closed');
  const exposure = open.reduce((a, p) => a + (Number(p.usd) || 0), 0);
  const checks = [
    { name: '总开关', ok: cfg.enabled === true, detail: cfg.enabled ? '已打开' : '关闭' },
    { name: '急停', ok: !killed, detail: killed ? 'data/live-kill 存在' : '未触发' },
    { name: '信号来源与镜像实现', ok: cfg.signalSource === LIVE_MIRROR_SOURCE, detail: `${cfg.signalSource} / 实际输入 ${LIVE_MIRROR_SOURCE}` },
    { name: '总敞口', ok: exposure + cfg.maxPerTradeUsd <= cfg.maxTotalUsd, detail: `$${exposure.toFixed(2)} / $${cfg.maxTotalUsd}` },
    { name: '当日止损', ok: -(ledger.realized?.[today] ?? 0) < cfg.dailyLossStopUsd, detail: `今日 $${(ledger.realized?.[today] ?? 0).toFixed(2)} / -$${cfg.dailyLossStopUsd}` },
    { name: '交易余额', ok: balanceUsd != null && balanceUsd >= cfg.maxPerTradeUsd, detail: balanceUsd != null ? `${cfg.spendAsset.toUpperCase()} ≈$${balanceUsd.toFixed(2)}${cfg.spendAsset === 'bnb' ? `（已留 ${cfg.gasReserveBnb} BNB gas）` : ''}` : '缺少新鲜余额数据' },
  ];
  const monitorWarnings = [];
  if (cfg.spendAsset === 'usdt') {
    const gasReady = fresh(bnbObs) && bnbObs.value >= cfg.gasReserveBnb;
    monitorWarnings.push({
      ok: gasReady,
      name: 'BNB 网络费观察（仅监控提示）',
      detail: fresh(bnbObs) ? `${bnbObs.value.toFixed(5)} BNB / 预留 ${cfg.gasReserveBnb} BNB` : 'BNB 余额数据不可用或已过期',
    });
  }

  // 实盘镜像决策日志（真实发生的：下单 / 拒绝 / 跳过）
  const decisions = readJsonl(path.join(dataDir, 'live-decisions.jsonl'), 30).map(d => ({ ...d, reasonZh: zh(d.reason) }));

  // 信号源思考（模拟策略的同一条评估链，实盘跟单只认它）
  const evals = Array.isArray(strategy?.evaluations) ? strategy.evaluations : [];
  const counts = evals.reduce((m, e) => (m[e.decision] = (m[e.decision] || 0) + 1, m), {});
  const rank = e => (e.decision === '买入' || e.decision === '买' ? 3 : e.decision === '观察' ? 1 : 0) * 1000 + (Number(e.score) || 0) + (/bsc/i.test(e.token?.chain) ? 0.5 : 0) - (e.reasons?.length || 0) * 0.01;
  const top = [...evals].sort((a, b) => rank(b) - rank(a)).slice(0, 10).map(e => thought(e, 'signal'));
  const reasonFreq = {};
  for (const e of evals) for (const r of e.reasons || []) reasonFreq[r] = (reasonFreq[r] || 0) + 1;
  const topReasons = Object.entries(reasonFreq).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, c]) => ({ reason: r, count: c }));
  const last = strategy?.cadence?.eventDispatch?.lastEvaluation;
  const sess = strategy?.session?.id || '';
  const acct = strategy?.account || strategy?.strategies?.[0]?.account || null;
  const signalBuys = (acct?.trades || []).filter(t => t.side === 'buy').slice(-8).reverse().map(t => ({ at: t.observedAt || (t.atMs ? new Date(t.atMs).toISOString() : null), symbol: t.symbol, chain: t.chain, address: t.address, usd: t.costBasisUsd, reasons: t.entryReasons || [], scopeMatch: /^confirmed-pvp-v2-/.test(sess) && cfg.chains.includes(normChain(t.chain)) }));

  return {
    now: new Date().toISOString(),
    live: { enabled: cfg.enabled, killed, chain: cfg.chain, chains: cfg.chains, wallet: cfg.wallet, spendAsset: cfg.spendAsset, gasReserveBnb: cfg.gasReserveBnb, maxPerTradeUsd: cfg.maxPerTradeUsd, maxTotalUsd: cfg.maxTotalUsd, dailyLossStopUsd: cfg.dailyLossStopUsd, maxOpenPositions: cfg.maxOpenPositions, antiMev: cfg.antiMev, signalSource: cfg.signalSource,
      bnb: bnbObs.value, bnbPriceUsd: priceObs.value, spendBalance: spendObs.value, balanceUsd, exposureUsd: exposure, todayRealizedUsd: ledger.realized?.[today] ?? 0, realizedTotalUsd, closedPositionCount, positions,
      observations: { bnb: bnbObs, bnbPriceUsd: priceObs, spendBalance: spendObs } },
    think: {
      gate: { ok: gate.ok, reason: zh(gate.reason), checks, previewOnly: true, monitorWarnings },
      decisions,
      scan: { total: evals.length, counts, intervalMs: strategy?.cadence?.evaluationIntervalMs ?? null, topReasons, session: sess, engineStatus: strategy?.status },
      last: last ? { ...thought(last, 'signal'), symbol: last.symbol || last.address?.slice(0, 10) } : null,
      candidates: top,
      signalBuys,
    },
  };
}
