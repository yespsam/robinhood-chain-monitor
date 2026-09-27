import { createBrainDesk } from './brain-desk.js';
import { createCaDesk } from './ca-desk.js';

const q = s => document.querySelector(s);
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = v => Number.isFinite(v) ? `${v.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} U` : '—';
const time = v => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? new Date(n).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }) : '时间未记录'; };
const ca = createCaDesk(q('#caDesk'));
const brain = createBrainDesk(q('#brainDesk'), { onSelectCa: key => ca.select(key) });
let snapshot, connected = false, busy = false;
const htmlCache = new Map();
const html = (selector, content) => { if (htmlCache.get(selector) !== content) { q(selector).innerHTML = content; htmlCache.set(selector, content); } };
function render() {
  if (!snapshot) return;
  const age = Date.now() - Date.parse(snapshot.updatedAt);
  const fresh = connected && age >= -60000 && age <= 60000;
  q('#streamLabel').textContent = fresh ? '快照已同步' : '快照已过期 / 连接中断';
  q('#syncStatus').textContent = `${fresh ? '公开同步正常' : '请勿将旧快照当作当前状态'} · 数据时间 ${time(snapshot.updatedAt)} · 云端接收 ${time(snapshot.publicSync?.receivedAt)} · 后台状态以本机为准`;
  brain.update(snapshot, fresh); ca.update(snapshot, fresh);
  const a = snapshot.account, stats = a.stats || {}, summary = snapshot.publicSummary || {};
  for (const [id, value] of [['equity', stats.netLiquidationValue ?? stats.equity], ['cash', a.cash], ['pnl', a.realizedPnl], ['costs', summary.totalCostsUsd]]) q(`#${id}`).textContent = money(value);
  q('#pnl').className = a.realizedPnl >= 0 ? 'positive' : 'negative';
  q('#winLoss').textContent = `${stats.wins ?? '—'} 胜 / ${stats.losses ?? '—'} 负`;
  q('#accountTime').textContent = time(a.updatedAt);
  q('#accountNote').textContent = `初始虚拟资金 ${money(a.initialCash)} · 手动资金调整 ${money(summary.fundingAdjustmentsUsd)}（不计盈利） · ${snapshot.session?.label || '主模拟盘'}`;
  const positions = Object.values(a.positions || {});
  q('#positionCount').textContent = `${positions.length} 个仓位`;
  html('#positions', positions.map(p => `<article class="holding"><div class="holding-heading"><div><strong>${esc(p.symbol)} · ${esc(p.chain)}</strong><p class="contract-address">${esc(p.address)}</p></div><div class="holding-value"><strong>${esc(money(p.markValue))}</strong><span>浮盈亏 ${esc(money(p.pnl))}</span></div></div><p class="holding-reason"><span>买入逻辑</span>${esc(p.entryLogic || p.entryReasons?.join('；') || '未记录')}</p><p class="section-note">买入 ${esc(time(p.openedAt))} · 估值 ${esc(time(p.markAt))} · ${esc(p.markStatus || '状态未知')}</p></article>`).join('') || '<div class="focus-empty">当前没有持仓<span>保持真实空仓状态，不生成演示订单。</span></div>');
  q('#tradeCount').textContent = `账本共 ${summary.totalTrades ?? '—'} 笔 · 展示最近 ${a.trades.length} 笔`;
  html('#tradeRows', [...a.trades].reverse().map(t => `<tr><td><strong>${esc(t.symbol || '未命名')}</strong><small>${esc(time(t.atMs))}</small><small>${esc(t.address)}</small></td><td>${esc(({ buy: '模拟买入', sell: '模拟卖出', writeoff: '账面核销' })[t.side] || t.side)}<small>${esc(t.chain)} · ${esc(t.strategyLabel || t.strategyId)}</small></td><td>${esc(money(t.side === 'buy' ? t.grossUsd + t.costsUsd : t.netUsd))}<small>成本 ${esc(money(t.costsUsd))}</small></td><td class="${t.realizedPnl >= 0 ? 'positive' : 'negative'}">${t.side === 'buy' ? '—' : esc(money(t.realizedPnl))}</td><td>${esc(t.reason || t.entryLogic || '未记录')}</td></tr>`).join('') || '<tr><td colspan="5">尚无模拟成交</td></tr>');
  const review = snapshot.tradeCountReview;
  q('#tradeCountReview').textContent = `百笔本地复盘：本批 ${review?.pendingFills ?? '—'} / 100 笔，已完成 ${review?.completedBatches ?? '—'} 批；不定时唤醒 AI，不自动改写策略。`;
  q('#coverageNote').textContent = `本机共 ${summary.totalEvaluations ?? '—'} 条路线评估；公开按 CA 去重后的 ${snapshot.evaluations?.length || 0} 个重点候选（最多 100 个），不是全链覆盖。完整档案在本机。`;
}
async function refresh() {
  if (busy || document.hidden) return;
  busy = true;
  try {
    const result = await fetch('/api/strategy-state', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!result.ok) throw new Error('暂未取得公开快照');
    const next = await result.json();
    if (next.schema !== 'yesp-public-v1' || next.mode !== 'paper' || !next.account) throw new Error('快照格式异常');
    snapshot = next; connected = true;
  } catch {
    connected = false;
    if (!snapshot) { q('#streamLabel').textContent = '等待本机同步'; q('#syncStatus').textContent = '暂时无法取得公开快照，自动重试中。不会显示演示余额或虚构成交。'; }
  } finally { busy = false; render(); }
}
setInterval(refresh, 15000);
setInterval(() => { if (!document.hidden) render(); }, 5000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
await refresh();
