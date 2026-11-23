export function normalizeStudioSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.live || !snapshot.think) {
    throw new Error('快照字段不完整（需要 live 与 think）；请检查 /api/studio 版本');
  }
  return {
    ...snapshot,
    live: {
      ...snapshot.live,
      positions: Array.isArray(snapshot.live.positions) ? snapshot.live.positions : [],
      observations: snapshot.live.observations && typeof snapshot.live.observations === 'object' ? snapshot.live.observations : {},
    },
    think: {
      ...snapshot.think,
      gate: snapshot.think.gate && typeof snapshot.think.gate === 'object' ? snapshot.think.gate : {},
      decisions: Array.isArray(snapshot.think.decisions) ? snapshot.think.decisions : [],
      scan: snapshot.think.scan && typeof snapshot.think.scan === 'object' ? snapshot.think.scan : {},
      candidates: Array.isArray(snapshot.think.candidates) ? snapshot.think.candidates : [],
      signalBuys: Array.isArray(snapshot.think.signalBuys) ? snapshot.think.signalBuys : [],
    },
  };
}

export function liveSwitchStatus(live = {}) {
  if (live.killed) return { key: 'kill', label: '急停已触发' };
  if (live.enabled) return { key: 'on', label: '实盘开关已启用 · 执行状态待核验' };
  return { key: 'off', label: '实盘开关关闭' };
}

export function isObservationFresh(observation) {
  return observation?.status === 'fresh'
    && Number.isFinite(Number(observation.ageMs))
    && Number(observation.ageMs) <= 60_000;
}

export function observationLabel(observation) {
  if (!observation) return '未核验';
  if (observation.status === 'not_requested') return '未查询（按配置跳过）';
  if (observation.status === 'unavailable') return '不可用';
  const age = Number(observation.ageMs);
  const ageLabel = Number.isFinite(age) ? `${Math.max(0, Math.floor(age / 1000))} 秒前` : '时间未知';
  if (observation.status === 'degraded') return `刷新失败 · 上次成功 ${ageLabel}`;
  if (observation.status === 'stale' || (Number.isFinite(age) && age > 60_000)) return `已过期 · 上次成功 ${ageLabel}`;
  return `新鲜 · ${ageLabel}`;
}

export function observationsFresh(live = {}) {
  const observations = live.observations || {};
  return live.spendAsset === 'usdt'
    ? isObservationFresh(observations.bnb) && isObservationFresh(observations.spendBalance)
    : isObservationFresh(observations.bnb) && isObservationFresh(observations.bnbPriceUsd);
}

export function realizedLedgerSummary(live = {}) {
  const numeric = value => value != null && value !== '' && Number.isFinite(Number(value));
  if (numeric(live.realizedTotalUsd)) return { value: Number(live.realizedTotalUsd), count: Number(live.closedPositionCount) || 0 };
  const closed = (live.positions || []).filter(position => position.status === 'closed');
  if (closed.length && closed.every(position => numeric(position.realizedPnlUsd))) {
    return { value: closed.reduce((sum, position) => sum + Number(position.realizedPnlUsd), 0), count: closed.length };
  }
  return { value: null, count: closed.length };
}

// Explain where the current live mirror is waiting without treating a paper
// evaluation or a matching chain/session as permission to submit a real order.
export function deriveLivePipelineDiagnosis(snapshot) {
  const s = normalizeStudioSnapshot(snapshot);
  const { live, think } = s;
  const chains = Array.isArray(live.chains) && live.chains.length ? live.chains : [live.chain].filter(Boolean);
  const chainLabel = chains.map(chain => String(chain).toUpperCase()).join(' / ') || '未配置';
  const counts = think.scan.counts || {};
  const buyEvaluations = Number(counts['买入'] || 0) + Number(counts['买'] || 0);
  const totalEvaluations = Number(think.scan.total || 0);
  const sessionSupported = /^confirmed-pvp-v2-/.test(String(think.scan.session || ''));
  const sourceMatches = live.signalSource === 'paper-atm-confirmed-pvp-v2';
  const canonicalChain = chain => String(chain || '').toLowerCase() === 'solana' ? 'sol' : String(chain || '').toLowerCase();
  const latest = think.last;
  const latestAt = latest?.at ? new Date(latest.at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间未知';
  const latestSummary = latest
    ? `最近策略评估：${latest.decision || '未知'} · ${String(canonicalChain(latest.chain) || '链未知').toUpperCase()} · ${latestAt}`
    : '尚无策略评估记录';
  const latestOutsideScope = latest?.chain && !chains.some(chain => canonicalChain(chain) === canonicalChain(latest.chain));
  const latestScopeNote = latestOutsideScope ? `最近评估在 ${String(canonicalChain(latest.chain)).toUpperCase()}，不在当前实盘链范围 ${chainLabel} 内。` : '';
  const reasonSummary = (think.scan.topReasons || []).slice(0, 3)
    .map(item => `${item.reason}（${item.count}）`).join('；');
  const recentNow = Date.parse(s.now);
  const recentExecution = think.decisions.find(item => {
    if (!['error', 'refused', 'uncertain', 'skip', 'reconcile'].includes(item.kind)) return false;
    const at = Date.parse(item.at);
    return Number.isFinite(recentNow) && Number.isFinite(at) && at <= recentNow && recentNow - at <= 5 * 60_000;
  });
  const executionSummary = recentExecution
    ? `最近 5 分钟有执行层记录：${recentExecution.kind} · ${recentExecution.reasonZh || recentExecution.reason || '查看执行日志'}`
    : '最近 5 分钟没有拒绝/报错/跳过记录';
  const sourceLabel = '本地 confirmed-pvp-v2 模拟账户新增买入；未接入 Grok 对话/信号流';
  const scopeLabel = `实盘允许链：${chainLabel}`;

  if (live.killed) return { key: 'kill', title: '急停保护已触发', detail: '有急停时不应提交新单；此诊断不会解除急停。', sourceLabel, scopeLabel, latestSummary, executionSummary };
  if (!live.enabled) return { key: 'off', title: '实盘开关关闭', detail: '当前不会调用实盘执行器。', sourceLabel, scopeLabel, latestSummary, executionSummary };
  if (!think.gate.ok || !observationsFresh(live)) {
    return { key: 'blocked', title: '账户/配置预检未通过', detail: think.gate.reason || '余额或价格快照不够新鲜；必须先修复数据/配置问题。', sourceLabel, scopeLabel, latestSummary, executionSummary };
  }
  if (!sourceMatches || !sessionSupported) {
    return { key: 'source', title: '实盘信号输入不匹配', detail: !sourceMatches
      ? `配置的 LIVE_SIGNAL_SOURCE 与代码镜像输入不一致（${live.signalSource || '未配置'}）；预检已按实际镜像来源校验。`
      : '当前模拟会话不是实盘镜像支持的 confirmed-pvp-v2 会话。', sourceLabel, scopeLabel, latestSummary, executionSummary };
  }
  if (recentExecution) return { key: 'execution', title: '近期信号到达执行层但被阻止/跳过', detail: recentExecution.reasonZh || recentExecution.reason || '请查看执行日志并按拒绝原因处理。', sourceLabel, scopeLabel, latestSummary, executionSummary };
  if (buyEvaluations === 0) {
    return { key: 'waiting', title: '实盘开关已开 · 等待合格的新买入信号', detail: `当前载入的 ${totalEvaluations} 条策略评估中，买入决策 ${buyEvaluations} 条；没有新增模拟买入就不会触发实盘镜像。${latestScopeNote}${reasonSummary ? `常见记录原因（可能是缺证据或结构条件，彼此可重叠）：${reasonSummary}` : ''}`, sourceLabel, scopeLabel, latestSummary, executionSummary };
  }
  return { key: 'candidate', title: '有买入评估，但仍需模拟成交与实盘证据闸门', detail: `买入评估 ${buyEvaluations} 条不等于模拟账户已买入或实盘已准入；仅支持链上的新增模拟买入会进入后续实盘检查。${reasonSummary ? `常见记录原因（可能彼此重叠）：${reasonSummary}` : ''}`, sourceLabel, scopeLabel, latestSummary, executionSummary };
}

export function extractTransactionHash(entry = {}) {
  const direct = [entry.txHash, entry.sellTxHash, entry.transactionHash, entry.hash].find(value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value));
  if (direct) return direct;
  const match = typeof entry.result === 'string' ? entry.result.match(/0x[0-9a-f]{64}/i) : null;
  return match?.[0] || null;
}
