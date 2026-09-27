import { diagnosticBuy, diagnosticSell, diagnosticCandidateIssue, diagnosticQuoteIssue, diagnosticTarget } from './paper-diagnostic.js';

const copy = value => structuredClone(value);
const rejection = (code, message, details = {}) => Object.assign(new Error(message), { code, details });
// Engineering exercise only. These rules do not replace the main PVP strategy.
export function diagnosticExitReason(position, quote, now) {
  const age = now - Date.parse(position.openedAt);
  if (quote.price <= position.entryPrice * .95) return '诊断单触发 5% 价格止损，按新观察价退出';
  const gross = position.quantity * quote.price;
  const net = gross * (1 - position.costs.feeRate - position.costs.slippageRate - position.costs.sellTax) - position.costs.gasUsd;
  if (age >= 45000 && net <= position.budgetUsd) return '诊断单持仓满 45 秒，扣除模型成本后未盈利，退出';
  if (age >= 180000) return '诊断单达到 180 秒持仓上限，退出';
  return null;
}

export function createPaperDiagnosticRunner({ initialState, market, loadSnapshot, persist, now = Date.now }) {
  let state = copy(initialState), tail = Promise.resolve(), entryJob = null, exitJob = null, stopRequested = false;
  if (state.mode !== 'paper_diagnostic' || state.execution !== false || state.signing !== false || state.broadcast !== false
    || !Number.isFinite(Date.parse(state.deadlineAt))) throw Error('需要隔离的模拟诊断账户');
  diagnosticTarget(state);
  const used = new Set(state.trades.filter(t => t.side === 'buy').map(t => `${t.chain}:${t.address}`));
  const issue = (draft, error) => {
    const known = /^DIAG_[A-Z_]+$/.test(error?.code || '');
    draft.issues = [...(draft.issues || []), { at: new Date(now()).toISOString(),
      code: known ? error.code : 'DIAG_SOURCE_UNAVAILABLE',
      text: known ? error.message : '诊断数据源暂不可用，本次不生成成交',
      details: known ? error.details || {} : {} }].slice(-100);
  };
  function boundary(draft) {
    const at = now(), deadline = Date.parse(draft.deadlineAt);
    if (stopRequested || at >= deadline - 30000 || draft.trades.length >= diagnosticTarget(draft)) draft.entriesEnabled = false;
    if (draft.entriesEnabled === false) {
      if (!draft.position) {
        const timed = draft.trades.filter(t => Date.parse(t.at) < deadline).length;
        draft.status = timed === diagnosticTarget(draft) ? 'completed' : 'incomplete';
        draft.finishedAt ||= new Date(at).toISOString();
      } else if (at >= deadline) {
        draft.status = 'incomplete_open_position';
        draft.finishedAt ||= new Date(at).toISOString();
      }
    }
    draft.exitMonitor = { ...draft.exitMonitor, running: Boolean(draft.position), intervalMs: 1000,
      quoteIntervalMs: 3000, lastCheckedAt: new Date(at).toISOString() };
  }
  function commit(work = () => {}) {
    const job = tail.then(async () => {
      const draft = copy(state); boundary(draft);
      await work(draft); boundary(draft); draft.updatedAt = new Date(now()).toISOString();
      await persist(copy(draft)); state = draft;
      return copy(state);
    });
    tail = job.catch(() => {}); return job;
  }
  const done = () => state.entriesEnabled === false && !state.position;
  function entryOnce() {
    if (entryJob) return entryJob;
    entryJob = (async () => {
      await commit();
      if (done() || state.position || state.entriesEnabled === false) return;
      let selected, quote, problem;
      try {
        const snapshot = await loadSnapshot();
        if (!Array.isArray(snapshot?.evaluations)) throw rejection('DIAG_SOURCE_SHAPE', '候选列表格式无效');
        const counts = {}, seen = new Set();
        const eligible = snapshot.evaluations.filter(e => {
          const reason = diagnosticCandidateIssue(e, now());
          if (reason) { counts[reason.code] = (counts[reason.code] || 0) + 1; return false; }
          const key = `${e.token.chain}:${e.token.address}`;
          if (seen.has(key)) return false;
          seen.add(key); return true;
        }).sort((a, b) => Number(used.has(`${a.token.chain}:${a.token.address}`)) - Number(used.has(`${b.token.chain}:${b.token.address}`))
          || b.evidence.flow.netBuyUsd - a.evidence.flow.netBuyUsd);
        selected = eligible[0];
        if (!selected) throw rejection('DIAG_NO_CANDIDATE', '暂无符合诊断条件的候选', { rejected: counts });
        quote = await market.quote({ ...selected.token, purpose: 'entry' });
        const latest = await loadSnapshot();
        selected = latest?.evaluations?.find(e => e.token?.chain === selected.token.chain && e.token?.address === selected.token.address);
        if (!selected) throw rejection('DIAG_CANDIDATE_GONE', '报价返回后原候选已不在监控列表');
      } catch (error) { problem = error; }
      await commit(draft => {
        if (draft.entriesEnabled === false || draft.position) return;
        if (problem) { issue(draft, problem); return; }
        try { diagnosticBuy(draft, selected, quote, now()); }
        catch (error) { issue(draft, error); }
      });
      if (state.position) used.add(`${state.position.chain}:${state.position.address}`);
    })().finally(() => { entryJob = null; });
    return entryJob;
  }
  function exitOnce() {
    if (exitJob) return exitJob;
    exitJob = (async () => {
      await commit();
      const position = copy(state.position);
      if (!position) return;
      let quote, problem;
      try { quote = await market.quote({ ...position, purpose: 'exit' }); } catch (error) { problem = error; }
      await commit(draft => {
        if (!draft.position || draft.position.openedAt !== position.openedAt || draft.position.address !== position.address
          || draft.position.chain !== position.chain) return;
        const invalid = problem || diagnosticQuoteIssue(quote, position, now());
        if (invalid) { issue(draft, invalid); draft.exitMonitor.lastError = draft.issues.at(-1).text; return; }
        draft.exitMonitor.lastQuoteAt = quote.observedAt; draft.exitMonitor.lastError = null;
        const reason = draft.entriesEnabled === false ? '已停止新开仓，使用有效新报价退出诊断持仓' : diagnosticExitReason(position, quote, now());
        if (!reason) return;
        try { diagnosticSell(draft, quote, now(), { settleAfterDeadline: now() >= Date.parse(draft.deadlineAt), reason }); }
        catch (error) { issue(draft, error); draft.exitMonitor.lastError = draft.issues.at(-1).text; }
      });
    })().finally(() => { exitJob = null; });
    return exitJob;
  }
  return { snapshot: () => copy(state), done, checkpoint: () => commit(), entryOnce, exitOnce,
    stopEntries: () => { stopRequested = true; return commit(); },
    idle: async () => { await Promise.allSettled([entryJob, exitJob]); await tail; } };
}
