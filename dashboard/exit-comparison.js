const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = value => typeof value === 'number' && Number.isFinite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(2)} U` : '待同步';
const time = value => {
  const ms = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(ms) ? new Date(ms).toLocaleString('zh-CN', { timeZone:'Asia/Shanghai', hour12:false }) : '待同步';
};
export function renderExitComparison(pair,mainExitPolicy=null,recovery=null) {
  if (!pair) return '<p class="section-note">量价退出实验尚未启动；主账户仍沿用原退出规则。</p>';
  const rows = [['原退出规则对照', pair.control], ['量价逻辑退出实验', pair.dynamic]];
  const started = Number.isFinite(Date.parse(pair.startedAt)) ? new Date(pair.startedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '待同步';
  const baseline = typeof pair.baselineEquity === 'number' && Number.isFinite(pair.baselineEquity) ? `${pair.baselineEquity.toFixed(2)} U` : '待同步';
  const summary = rows.map(([label, s]) => `<tr><td>${label}</td><td>${esc(s?.entries ?? 0)} / ${esc(s?.closedRounds ?? 0)}</td><td>${esc(money(s?.periodRealizedPnl))}</td><td>${esc(money(s?.equityChange))}</td><td>${esc(s?.positions?.length ?? 0)}${s?.stalePositions ? ' · 估值待刷新' : ''}</td></tr>`).join('');
  const accounts = rows.map(([label, s]) => {
    const holdings = (s?.positions || []).map(p => `<p class="section-note"><strong>${esc(p.symbol)} · ${esc(p.chain)}</strong><br>CA：${esc(p.address)}<br>买入依据：${esc(p.entryLogic || '未记录')}<br>买入时间：${esc(time(p.openedAt))}；初始投入（含买入成本）：${esc(money(p.entryUsd))}；剩余成本：${esc(money(p.costBasisUsd))}<br>持有依据：${esc(p.status?.reason || p.status?.holdReason || '等待入场后证据')}${p.markStatus === 'stale' ? ' · 报价过期，不能据此确认当前盈亏' : ''}<br>喊单来源：${esc(p.status?.sentiment?.quality || '待核实')}；${esc(p.status?.sentiment?.meaning || '尚无可用情绪依据')}</p>`).join('');
    const trades = (s?.recentTrades || []).slice().reverse().map(t => `<tr><td>${esc(time(t.atMs))}</td><td>${esc(t.symbol)} · ${esc(t.chain)}<br>${esc(t.address)}</td><td>${t.side === 'buy' ? '买入' : t.side === 'sell' ? '卖出' : t.side === 'writeoff' ? '核销' : '未知'}</td><td>${esc(money(t.netUsd))}</td><td>${esc(money(t.costsUsd))}</td><td>${t.side === 'sell' || t.side === 'writeoff' ? esc(money(t.realizedPnl)) : '—'}</td><td>${esc(t.reason || '未记录')}</td></tr>`).join('');
    return `<h3>${esc(label)} · 独立模拟账户</h3>${holdings || '<p class="section-note">当前没有持仓。</p>'}<p class="section-note">最近成交（北京时间）。净现金变动：买入为含成本支出，卖出为扣成本收入；成本列仅供核对，不再次扣除。</p><div class="trades-scroll"><table><thead><tr><th>时间</th><th>代币 / CA</th><th>方向</th><th>净现金变动</th><th>模型成本</th><th>本笔已实现</th><th>成交依据</th></tr></thead><tbody>${trades || '<tr><td colspan="7">本实验开始后暂无成交。</td></tr>'}</tbody></table></div>`;
  }).join('');
  const sampling=pair.entrySampling;
  const activeSince=sampling ? new Date(sampling.activatedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) : '';
  const entryText=sampling ? `<p class="section-note">${esc(sampling.label)} · 北京时间 ${esc(activeSince)}<br>${esc(sampling.description)}<br>放宽后新买入：原退出对照 ${esc(sampling.results?.control?.entries??0)} / 量价退出 ${esc(sampling.results?.dynamic?.entries??0)}；量价账户权益增量（含浮亏）：${esc(money(sampling.results?.dynamic?.equityChange))}。${sampling.scan ? `<br>本轮检查 ${esc(sampling.scan.observed)} 个 CA，买点通过 ${esc(sampling.scan.eligible)} 个（各账户另查余额与重复仓位）。仍未通过：${esc(sampling.scan.blockers.map(b=>`${b.reason} ${b.count}个`).join('；'))}` : ''}</p>` : '';
  return `<p class="section-note">${mainExitPolicy?'此处是保留的独立对照，继续按原实验版本运行。主账户后续新仓已另行切换叙事与资金行为退出；两个实验不是新版主盘的逐笔配对。':'这是独立模拟对照，不是主账户切换。仅实验新仓取消固定百分比止损、倍数止盈与百分比回撤线；主账户和已有仓位规则不变。'}</p>
    ${recovery?.comparisonNote?`<p class="section-note">${esc(recovery.comparisonNote)}</p>`:''}
    ${entryText}
    <p class="section-note">退出依据：两根收盘失守并下跌放量、连续三根收盘失守、放量长上影后跌破前低，或两次完整同源资金流转卖。喊单核对精确 CA、出处和时效，只作背景，不替代量价确认。</p>
    <div class="trades-scroll"><table><thead><tr><th>独立账户</th><th>新买入 / 完整平仓</th><th>区间已实现</th><th>权益变化（含浮盈亏）</th><th>持仓</th></tr></thead><tbody>${summary}</tbody></table></div>
    ${accounts}
    <p class="section-note">${esc(pair.note)} 起点权益 ${esc(baseline)}；开始（北京时间）${esc(started)}。此实验不承诺最大亏损，不能把未平仓浮亏藏成盈利。</p>`;
}
