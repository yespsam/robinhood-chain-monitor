// Read-only explanations of engine snapshots. No scoring, fetching or order API.
import { exactPrice } from './strategy-details.js';
import { renderNarrativeThesis } from './narrative-thesis.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const finite = n => typeof n === 'number' && Number.isFinite(n);
const stamp = value => typeof value === 'number' ? value : Date.parse(value || '');
const fresh = (value, now, maxAge) => finite(stamp(value)) && now >= stamp(value) && now - stamp(value) <= maxAge;
const unique = rows => [...new Set(rows.filter(v => typeof v === 'string' && v.trim()))];
const list = value => Array.isArray(value) ? value : [];
const money = n => finite(n) ? `$${n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}` : '未采集';
const pct = n => finite(n) ? `${(n * 100).toFixed(2)}%` : '未采集';
const time = value => finite(stamp(value)) ? new Date(stamp(value)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '未采集';
const chainLabel = value => ({ sol: 'Solana', bsc: '币安链', eth: '以太坊', base: 'Base', robinhood: 'Robinhood' })[value] || value;
export const caKey = token => token?.chain && token?.address ? `${token.chain}:${token.address}` : null;
const stageLabel = value => ({ external: '外盘', internal: '内盘', near_completion: '临毕业' })[value] || '阶段未核实';
const stateLabels = { holding: '持仓管理', ready: '满足开仓条件', confirm: '等报价确认', watch: '观察条件', data: '数据待补 / 过期', blocked: '暂不入场', paused: '新增仓位暂停' };
const priority = { holding: 0, ready: 1, confirm: 2, watch: 3, blocked: 4, data: 5, paused: 6 };

export function buildCaDesk(snapshot, now = Date.now(), connected = true) {
  const groups = new Map();
  for (const row of list(snapshot?.evaluations)) {
    const key = caKey(row.token);
    if (!key) continue;
    const previous = groups.get(key);
    // Preserve all routes, but never merge different contracts by ticker.
    const routes = [...list(previous?.routes), ...list(row.evidence?.opportunityRoutes)];
    const chosen = !previous || row.decision === '可模拟' ? row : previous.row;
    groups.set(key, { key, token: chosen.token, row: chosen, routes: [...new Map(routes.map(r => [r.id, r])).values()] });
  }
  for (const position of Object.values(snapshot?.account?.positions || {})) {
    const key = caKey(position);
    if (key) groups.set(key, { key, token: position, row: null, routes: [], ...groups.get(key), position });
  }
  const snapshotFresh = connected && snapshot?.status === 'ok' && fresh(snapshot.updatedAt, now, 120000);
  return [...groups.values()].map(item => {
    const e = item.row?.evidence || {}, chosen = e.opportunity || {};
    const pattern = chosen.pattern || {};
    const marketFresh = e.marketFresh === true && fresh(e.marketObservedAt, now, 120000);
    const quoteFresh = e.priceFresh === true && fresh(e.priceObservedAt, now, e.exitPolicy?.entryQuoteMaxAgeMs || 5000);
    // The multi-route chart is stricter than the legacy chart summary. A ready
    // legacy chart cannot turn missing route-specific closed bars into evidence.
    const chartAt = pattern.closedAt;
    const chartFresh = finite(chartAt) && fresh(chartAt, now, 90000);
    const rowBlockers = unique([...list(item.row?.reasons), ...list(item.row?.missing)]);
    const blockers = [...rowBlockers];
    if (!snapshotFresh) blockers.unshift('页面与引擎未保持新鲜同步，显示上次判断');
    if (!marketFresh && !blockers.some(x => x.includes('行情'))) blockers.push('行情待刷新');
    if (!quoteFresh && !blockers.some(x => x.includes('报价'))) blockers.push('独立报价待刷新');
    let state;
    if (item.position) state = 'holding';
    else if (!snapshotFresh) state = 'data';
    else if (snapshot?.enabled !== true || snapshot?.entryGuard?.allowed === false) {
      state = 'paused';
      blockers.unshift(...(snapshot?.enabled !== true ? ['引擎未开启新增仓位'] : list(snapshot.entryGuard.reasons)));
    } else if (item.row?.decision === '不买') state = 'blocked';
    else if (item.row?.decision === '可模拟' && e.paperEligible === true && !rowBlockers.length && marketFresh && quoteFresh && (chosen.basis !== 'ohlcv' || chartFresh)) state = 'ready';
    else if (!marketFresh || (chosen.basis === 'ohlcv' && !chartFresh)) state = 'data';
    else if (chosen.signalReady === true && rowBlockers.length > 0 && rowBlockers.every(reason => reason.includes('报价'))) state = 'confirm';
    else state = 'watch';
    const lead = state === 'holding' ? (!snapshotFresh ? '与引擎同步异常；持仓仍在账本中，当前退出判断待同步。' : !fresh(item.position.markAt, now, e.exitPolicy?.exitQuoteMaxAgeMs || 15000) || !['ok', 'fresh'].includes(item.position.markStatus)
      ? '持仓报价待刷新；缺失数据不代表可以继续持有。'
      : item.position.exitStatus?.holdReason || '按该仓入场时规则持续检查退出。')
      : state === 'ready' ? '本轮引擎条件通过，等待账本记录确认；不等于已经买入。'
      : state === 'confirm' ? blockers.join('；') || '信号已成立，等待报价校验。'
      : blockers.join('；') || pattern.reason || '当前证据尚不足以入场，等待引擎下一轮评估。';
    return { ...item, e, chosen, pattern, marketFresh, quoteFresh, chartFresh, snapshotFresh,
      state, label: stateLabels[state], blockers: unique(blockers), lead, at: snapshot?.updatedAt,
      routeDescription: list(snapshot?.opportunityRoutes).find(r => r.id === chosen.id)?.description || item.row?.entryLogic || '该路线尚无已记录的条件说明。',
      hot: list(snapshot?.researchPipeline?.hotCandidates).some(r => caKey(r) === item.key) };
  }).sort((a, b) => priority[a.state] - priority[b.state] || Number(b.hot) - Number(a.hot)
    || Number(b.chartFresh) - Number(a.chartFresh) || a.key.localeCompare(b.key));
}

export function filterCaItems(items, { query = '', chain = '', state = '' } = {}) {
  const search = query.trim().toLocaleLowerCase();
  return items.filter(item => (!chain || item.token.chain === chain) && (!state || item.state === state)
    && (!search || `${item.token.symbol} ${item.token.address} ${chainLabel(item.token.chain)}`.toLocaleLowerCase().includes(search)));
}

export function pickCaSelection(items, previousKey) {
  return items.some(item => item.key === previousKey) ? previousKey : items[0]?.key || null;
}

export function recordCaChanges(history, items) {
  const current = new Set(items.map(item => item.key));
  for (const [key] of history) if (!current.has(key)) history.delete(key);
  for (const item of items) {
    const signature = JSON.stringify([item.state, item.chosen.id, item.lead]);
    const previous = history.get(item.key);
    if (previous?.signature === signature) continue;
    const text = previous ? `${previous.label === item.label ? `条件更新（${item.label}）` : `${previous.label} → ${item.label}`}。${item.lead}` : `本页首次看到：${item.label}。${item.lead}`;
    history.set(item.key, { signature, label: item.label, events: [{ at: item.at, text }, ...list(previous?.events)].slice(0, 5) });
  }
}

const fact = (label, value) => `<div><dt>${esc(label)}</dt><dd>${esc(value)}</dd></div>`;
const paragraph = (label, value) => `<section class="ca-answer"><h4>${esc(label)}</h4><p>${esc(value)}</p></section>`;
const safeSource = source => {
  try { const url = new URL(source); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; }
};

export function renderCaDetail(item, events = []) {
  if (!item) return '<div class="ca-empty">当前筛选没有匹配的 CA。<span>可清空搜索或切换链；未扫到的合约不编造判断。</span></div>';
  const { token, e, chosen, pattern, position } = item;
  const narrative = e.narrativeAssessment;
  const plan = e.entryPlan || {}, economics = plan.economics;
  const flow = e.flow || {}, pulse = e.confirmedPolicy?.pulse;
  const sourceLinks = list(narrative?.sources).flatMap(s => {
    const url = safeSource(s.sourceUrl);
    return url ? [`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(s.authorLabel || '原始出处')} ↗</a>`] : [];
  }).slice(0, 3);
  const observation = chosen.basis === 'ohlcv'
    ? finite(pattern.closedAt) ? `最近可见收盘价 ${exactPrice(pattern.close)}；同源相对成交量 ${finite(pattern.volumeMultiple) ? pattern.volumeMultiple.toFixed(2) + ' 倍' : '未知'}。${pattern.ready ? '该路线结构检查通过。' : pattern.reason || '结构尚未确认。'}${item.chartFresh ? '' : ' 这根收盘线已过期，不作为当前触发。'}`
      : '尚无这条路线可用的收盘线，不把行情榜上的涨幅当成已确认买点。'
    : pulse ? `近 ${finite(pulse.windowMs) ? pulse.windowMs / 1000 : '未知'} 秒可见净买家 ${finite(pulse.recentBuyerCount) ? pulse.recentBuyerCount : '未知'} 个，净流入 ${money(pulse.recentNetBuyUsd)}。${e.flowFresh === true ? '' : '资金流待刷新。'}`
      : '尚未采到可用的逐笔买盘证据。';
  const narrativeText = narrative?.eligible
    ? `${narrative.theme || '主题待确认'}。原文主张：${narrative.event || '未记录'}。${narrative.mechanism || ''} 来源校验通过不等于内容为真。`
    : `叙事尚未核实。${unique(list(narrative?.gaps)).join('；') || '没有绑定此链和精确 CA 的原始出处，不按币名猜故事。'}`;
  const thesis = position
    ? `已持有；入场记录：${position.entryLogic || list(position.entryReasons).join('；') || '未记录'}。当前候选判断不能覆盖历史买入依据。`
    : `${stageLabel(e.marketStage)} · 本轮路线：${chosen.label || item.row?.label || '等待分类'}。${observation}`;
  const invalidation = position
    ? `${position.exitStatus?.holdReason || '等待本轮持仓检查'} ${position.exitLogic || '退出说明未记录，不能推断固定持仓时间。'}`
    : `以下是候选入场后的退出预案，尚未成交：${item.row?.exitLogic || '缺少退出证据，暂不给假点位。'}`;
  return `<header class="ca-detail-head"><div><span class="ca-kicker">${esc(chainLabel(token.chain))} · ${esc(stageLabel(e.marketStage))}</span><h3>${esc(token.symbol || '未命名代币')}</h3></div><span class="ca-badge" data-state="${item.state}">${esc(item.label)}</span></header>
    <p class="ca-address">${esc(token.address)}</p>
    ${renderNarrativeThesis(e.narrativeThesis||position?.entryEvidence?.narrativeThesis,{entrySnapshot:!e.narrativeThesis&&!!position})}
    <div class="ca-verdict"><span>现在的结论</span><p>${esc(item.lead)}</p></div>
    <dl class="ca-facts">${fact('参考价 · 非成交承诺', exactPrice(token.price ?? position?.lastPrice))}${fact('流动性', money(e.liquidity))}${fact('行情时间', `${time(e.marketObservedAt)} · ${item.marketFresh ? '新鲜' : '待刷新'}`)}${fact('独立报价时间', `${time(e.priceObservedAt)} · ${item.quoteFresh ? '新鲜' : '待补 / 过期'}`)}${fact('所选路线收盘时间', chosen.basis === 'flow' ? '本轮选用买盘路线；外盘数据见下方' : `${time(pattern.closedAt)} · ${item.chartFresh ? '时效内' : '待补 / 过期'}`)}${fact('判断快照', `${time(item.at)}${item.snapshotFresh ? '' : ' · 同步异常'}`)}</dl>
    ${paragraph(position ? '为什么持有这笔仓位' : '现在看到了什么', thesis)}
    ${paragraph('叙事是什么', narrativeText)}${sourceLinks.length ? `<p class="ca-sources">${sourceLinks.join(' · ')}</p>` : ''}
    ${paragraph('买盘与筹码证据', `可见窗口：净买家 ${finite(flow.uniqueBuyerCount) ? flow.uniqueBuyerCount : '未知'}，盈利地址 ${finite(flow.highProfitCount) ? flow.highProfitCount : '未知'}，FOMO 地址 ${finite(flow.fomoCount) ? flow.fomoCount : '未覆盖'}；净流入 ${money(flow.netBuyUsd)}。${e.flowDiagnostics?.scope || '来源覆盖范围未记录'}。${e.flowFresh === true ? '引擎本轮资金流时效通过' : '资金流待更新'}；${e.flowDiagnostics?.complete === true ? '来源窗口完整，不代表全链' : '来源完整性未确认'}。前十大持仓占比 ${pct(e.safety?.metrics?.top10HolderRate)}，仅为集中度代理，不代表独立持有人。`)}
    ${paragraph(position ? '新一轮开仓看什么' : '什么变化才会考虑买', `${item.routeDescription} 当前未通过：${item.blockers.length ? item.blockers.join('；') : '本轮已通过，仍以真实模拟成交记录为准'}。`)}
    ${paragraph('什么情况退出 / 判断失效', invalidation)}
    ${position?.memeExitPolicy ? paragraph('叙事后续与地址行为',`${position.thesisStatus?.narrative?.summary||'叙事后续待核实'} ${position.thesisStatus?.flow?.summary||'资金流待核实'} ${position.thesisStatus?.operator?.summary||'操盘身份未核实'}`) : ''}
    ${position ? paragraph('这笔仓位的实际记录', `买入 ${time(position.openedAt)}；估值时间 ${time(position.markAt)}；${position.memeExitPolicy?'无固定价格退出线':'当前止损 '+exactPrice(position.activeStopPrice)}；入场版本 ${position.entryEvidence?.opportunity?.version || position.entryEvidence?.confirmedPolicy?.version || '未记录'}；退出版本 ${position.memeExitPolicy?.version || position.pvpPolicy?.version || position.entryEvidence?.exitPolicy?.version || '未记录'}。按该仓原始规则管理，不用当前候选规则改写。`) : ''}
    ${paragraph('成本后空间 · 候选测算', economics ? `保本需涨 ${pct(economics.breakEvenRate)}；模型止损损失 ${money(economics.estimatedStopLossUsd)}；参考位 ${exactPrice(plan.targetPrice)}。${plan.targetKind || '不是价格预测'}。成本 / 空间校验${economics.ready ? '通过，但不代表整笔交易条件通过' : '未通过'}；费用、滑点与 gas 为模型假设。` : '本轮没有完整的结构成本测算，不生成收益预期。')}
    <section class="ca-answer"><h4>其他路线也在检查</h4><div class="ca-route-list">${item.routes.map(route => `<div><strong>${esc(route.label || route.id)}</strong><span>${esc(route.decision === '可模拟' ? '快照条件通过，非成交' : unique([...list(route.reasons), ...list(route.missing)]).join('；') || '待下一轮证据')}${finite(route.pattern?.closedAt) ? `<small>可见收盘 ${esc(time(route.pattern.closedAt))} · 收盘价 ${esc(exactPrice(route.pattern.close))} · 相对量 ${esc(finite(route.pattern.volumeMultiple) ? route.pattern.volumeMultiple.toFixed(2) + ' 倍' : '未知')}</small>` : ''}</span></div>`).join('') || '<p>暂无逐路线记录</p>'}</div></section>
    <section class="ca-answer"><h4>判断如何变化</h4><p class="ca-footnote">仅本页打开后采样的最近 5 次变化；刷新页面重置，不补造历史。</p><ol class="ca-history">${events.map(event => `<li><time>${esc(time(event.at))}</time><span>${esc(event.text)}</span></li>`).join('')}</ol></section>`;
}

export function createCaDesk(root) {
  if (!root) return { update() {} };
  const query = root.querySelector('[data-ca-search]'), chain = root.querySelector('[data-ca-chain]'), filter = root.querySelector('[data-ca-filter]');
  const listNode = root.querySelector('[data-ca-list]'), detail = root.querySelector('[data-ca-detail]'), summary = root.querySelector('[data-ca-summary]');
  const history = new Map();
  let items = [], selected = null, listHtml = '', detailHtml = '', lastKey = null;
  function render() {
    const visible = filterCaItems(items, { query: query.value, chain: chain.value, state: filter.value });
    selected = pickCaSelection(visible, selected);
    const counts = Object.keys(stateLabels).map(key => [stateLabels[key], items.filter(item => item.state === key).length]).filter(([, count]) => count);
    summary.textContent = `本轮 ${items.length} 个 CA · 当前筛选 ${visible.length} 个 · ${counts.map(([label, count]) => `${label} ${count}`).join(' / ')}`;
    const nextList = visible.map(item => `<button type="button" class="ca-row" data-ca-key="${esc(item.key)}" aria-pressed="${item.key === selected}" aria-controls="caInspector"><span class="ca-row-top"><strong>${esc(item.token.symbol || '未命名')}</strong><span class="ca-badge" data-state="${item.state}">${esc(item.label)}</span></span><span class="ca-row-meta">${esc(chainLabel(item.token.chain))} · ${esc(item.token.address.slice(0, 6))}…${esc(item.token.address.slice(-5))}</span><span class="ca-row-reason">${esc(item.lead)}</span></button>`).join('') || '<p class="ca-empty">没有匹配的 CA</p>';
    if (nextList !== listHtml) {
      const focused = root.ownerDocument.activeElement?.closest('[data-ca-key]')?.dataset.caKey;
      const scrollTop = listNode.scrollTop;
      listNode.innerHTML = listHtml = nextList;
      if (focused) [...listNode.querySelectorAll('[data-ca-key]')].find(node => node.dataset.caKey === focused)?.focus({ preventScroll: true });
      listNode.scrollTop = scrollTop;
    }
    const item = visible.find(row => row.key === selected);
    const nextDetail = renderCaDetail(item, history.get(selected)?.events);
    if (nextDetail !== detailHtml) {
      const scrollTop = detail.scrollTop;
      detail.innerHTML = detailHtml = nextDetail;
      detail.scrollTop = selected === lastKey ? scrollTop : 0;
      lastKey = selected;
    }
  }
  query.addEventListener('input', render);
  chain.addEventListener('change', render);
  filter.addEventListener('change', render);
  listNode.addEventListener('click', event => {
    const button = event.target.closest('[data-ca-key]');
    if (button) { selected = button.dataset.caKey; render(); }
  });
  return { select(key) { if (!items.some(item=>item.key===key)) return false;
    query.value='';chain.value='';filter.value='';selected=key;render();return true; },
    update(snapshot, connected = true, visible = true) { items = buildCaDesk(snapshot, Date.now(), connected); recordCaChanges(history, items); if(visible)render(); } };
}
