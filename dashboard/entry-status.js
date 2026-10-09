// Read-only account-level status. Candidate research is not permission to enter.
const stamp = v => typeof v === 'number' ? v : Date.parse(v || '');
const rows = v => Array.isArray(v) ? v : [];
const money = v => typeof v === 'number' && Number.isFinite(v) ? `${v.toFixed(2)} U` : '未记录';
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const clock = v => new Date(v).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});

export function entryStatus(snapshot, now = Date.now(), connected = true) {
  const s = snapshot || {}, at = stamp(s.updatedAt);
  const online = connected && s.status === 'ok' && Number.isFinite(at) && at <= now && now-at <= (s.publicView ? 60000 : 15000);
  const guard = s.lossGuards || {};
  const lossBlocked = guard.enforced === true && (guard.triggered === true || guard.newEntriesStop === true);
  const blocked = lossBlocked || s.enabled === false || s.entryGuard?.allowed === false;
  const reasons = lossBlocked ? rows(guard.reasons) : rows(s.entryGuard?.reasons);
  const label = !online ? '开仓状态待同步' : lossBlocked ? '新增仓位已暂停 · 亏损预算触发'
    : s.enabled === false ? '新增仓位已暂停' : s.entryGuard?.allowed === false ? '账户条件受阻 · 暂不新增仓位'
    : s.enabled === true ? '自动开仓已启用' : '开仓开关状态未记录';
  const explanation = reasons.join('；') || (s.enabled === false ? '账本开仓开关已关闭；未记录更具体的暂停原因。' : '等待账户开仓条件满足。');
  const detail = !online ? `当前状态无法确认。${blocked ? `上次记录为暂停或受阻：${explanation}` : '不把上次快照当成当前正在交易。'}`
    : blocked ? `${explanation} ${lossBlocked ? '扫描和候选通过不会解除这项暂停；本页不自动恢复或补款。' : ''}不据此推断消息采集或持仓退出已停止；各监控是否在线请以独立心跳为准。`
    : '启用不等于已经成交；以模拟账本为准。';
  const metrics = guard.enforced === true ? [['本轮已实现净盈亏', money(guard.realizedPnlUsd)], ['亏损额度', money(guard.lossLimitUsd)], ['UTC 当日已实现', money(guard.dailyRealizedPnlUsd)]] : [];
  const last = rows(s.account?.trades).filter(t => ['buy','sell','writeoff'].includes(t.side) && Number.isFinite(stamp(t.atMs ?? t.at)) && stamp(t.atMs ?? t.at) <= now)
    .reduce((a,b) => !a || stamp(b.atMs ?? b.at) > stamp(a.atMs ?? a.at) ? b : a, null);
  const lastFill = last ? `最近成交：${clock(stamp(last.atMs ?? last.at))}（北京时间） · ${{buy:'模拟买入',sell:'模拟卖出',writeoff:'账面核销'}[last.side]} · ${last.symbol || last.address || '标的未记录'}` : '当前快照未提供成交记录。';
  return {online, blocked, lossBlocked, label, detail, metrics, lastFill, visible:!online || blocked};
}

export function renderEntryStatus(status) {
  if (!status.visible) return '';
  return `<section class="brain-entry-status" data-state="${status.online ? 'blocked' : 'stale'}" role="status" aria-label="账户开仓状态"><h3>${esc(status.label)}</h3><p>${esc(status.detail)}</p>${status.metrics.length ? `<dl>${status.metrics.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : ''}<small>${esc(status.lastFill)} · 扫描次数不是成交次数</small></section>`;
}
