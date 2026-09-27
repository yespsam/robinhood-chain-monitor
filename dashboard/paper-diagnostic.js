const section = document.createElement('section');
section.className = 'trades-section'; section.id = 'paperDiagnostic'; section.hidden = true;
document.querySelector('.positions-section').after(section);
const money = n => typeof n === 'number' && Number.isFinite(n) ? `$${n.toFixed(4)}` : '—';
async function refresh() {
  try {
    const response = await fetch('/paper-diagnostic-status.json', { cache: 'no-store' });
    if (!response.ok) return;
    const s = await response.json();
    if (s.mode !== 'paper_diagnostic') return;
    const historyOpen = section.querySelector('details')?.open ?? (s.targetFills === 2);
    section.hidden = false; section.replaceChildren();
    const heading = document.createElement('h2');
    const timedFills = s.trades.filter(t => Date.parse(t.at) < Date.parse(s.deadlineAt)).length;
    const lateFills = s.trades.length - timedFills;
    const exitAlive = s.exitMonitor?.running && Date.now() - Date.parse(s.exitMonitor.lastCheckedAt) >= 0 && Date.now() - Date.parse(s.exitMonitor.lastCheckedAt) < 15000;
    const label = s.position && s.entriesEnabled === false ? exitAlive ? '停止开仓，退出管理中' : '停止开仓，退出状态待确认' : s.status === 'completed' ? '已完成' : s.status === 'running' ? '运行中' : '未完成';
    const historical = !s.position && ['completed', 'incomplete'].includes(s.status);
    const archive = document.querySelector('#researchArchive');
    if (historical && archive && section.parentElement !== archive) {
      archive.append(section);
      if (location.hash === '#paperDiagnostic') archive.open = true;
    } else if (!historical && archive && section.parentElement === archive) {
      document.querySelector('.positions-section').after(section);
    }
    heading.textContent = `${s.targetFills === 2 ? '单次模拟交易流程' : historical ? '历史独立测试' : '限时诊断模拟成交'} ${timedFills} / ${s.targetFills} · ${label}`;
    const note = document.createElement('p'); note.className = 'section-note'; note.textContent = s.note;
    const summary = document.createElement('p'); summary.textContent = `诊断余额 ${money(s.cash)} · 已实现 ${money(s.realizedPnl)} · 当前持仓 ${s.position?.symbol || '无'} · 截止 ${new Date(s.deadlineAt).toLocaleTimeString('zh-CN')}${lateFills ? ` · 另有 ${lateFills} 笔截止后退出，不计限时目标` : ''}`;
    const table = document.createElement('table');
    const head = document.createElement('tr');
    for (const label of ['时间 / 代币', '方向', '金额', '模型成本', '净盈亏', '原因']) { const th = document.createElement('th'); th.textContent = label; head.append(th); }
    table.append(head);
    for (const t of [...s.trades].reverse()) {
      const row = document.createElement('tr');
      for (const value of [`${new Date(t.at).toLocaleTimeString('zh-CN')} ${t.symbol} (${t.chain})`, t.side === 'buy' ? '模拟买入' : '模拟卖出', money(t.amountUsd), money(t.costUsd), money(t.pnlUsd), t.reason]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      table.append(row);
    }
    const scroll = document.createElement('div'); scroll.className = 'trades-scroll'; scroll.append(table);
    let content = section;
    if (historical) {
      const explanation = document.createElement('p'); explanation.className = 'section-note';
      explanation.textContent = '这是已结束的独立流程测试，不计入主策略成绩。主账户持仓及成交请看主账户区域。';
      const details = document.createElement('details'); details.open = historyOpen;
      const title = document.createElement('summary'); title.textContent = '查看独立测试记录'; details.append(title);
      section.append(heading, explanation, details); content = details;
    } else section.append(heading);
    content.append(note, summary, scroll);
    if (s.issues.length) {
      const warning = document.createElement('p'); warning.className = 'section-note'; const last = s.issues.at(-1);
      const reason = last.code ? `${last.text}（${last.code}${last.details?.upstreamCode ? ` / ${last.details.upstreamCode}` : ''}${typeof last.details?.ageMs === 'number' ? `，数据年龄 ${(last.details.ageMs / 1000).toFixed(1)} 秒` : ''}）` : last.text;
      const counts = last.details?.rejected;
      const reasons = { DIAG_SAFETY: '安全资料', DIAG_MARKET_STALE: '行情过期', DIAG_LIQUIDITY: '流动性', DIAG_VOLUME: '成交量', DIAG_FLOW_STALE: '资金流过期或不完整', DIAG_NO_NET_BUY: '无正净买入', DIAG_CHAIN_COST: '链成本' };
      warning.textContent = `${s.status === 'incomplete' && !s.position ? '本轮未达到成交目标；当前无诊断持仓。' : ''}最近诊断：${reason}${counts ? `；拒绝分布：${Object.entries(counts).map(([key, count]) => `${reasons[key] || key} ${count}`).join('，')}` : ''}`;
      content.append(warning);
    }
  } catch { /* Keep last actual record; never synthesize successful fills. */ }
}
refresh(); setInterval(refresh, 3000);
