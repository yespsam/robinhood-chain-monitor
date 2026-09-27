import { renderStrategyDetails } from './strategy-details.js';
import { renderTradeCountReview } from './trade-count-review.js';
import { renderNewsWire } from './news-wire.js';
import { createCaDesk } from './ca-desk.js';
import { createBrainDesk } from './brain-desk.js';
import { renderExitComparison } from './exit-comparison.js';
import { revealHashSection } from './navigation.js';
import { renderWalletLearning } from './wallet-learning.js';
import { marketCoverageStatus, flowCoverageStatus, tradingDataHealth } from './coverage-status.js';
const openSectionAnchor = () => revealHashSection(document, location.hash);
window.addEventListener('hashchange', openSectionAnchor);
openSectionAnchor();
const $ = selector => document.querySelector(selector);
const caDesk = createCaDesk($('#caDesk'));
const brainDesk = createBrainDesk($('#brainDesk'),{onSelectCa:key=>caDesk.select?.(key)});
const STORAGE_KEY = 'gmgn-paper-terminal-v1';
const STRATEGY_LABELS = Object.freeze({ internal: '内盘早期', smart_money: '聪明钱跟踪', narrative_pvp: '外盘叙事 PVP', launch_sniper: '新币狙击' });
const chainName = chain => ({ robinhood: 'Robinhood', sol: 'Solana', bsc: '币安链', base: 'Base', eth: '以太坊' })[chain] || '未知链';
const DEPARTMENTS = [['chain', '链路研究'], ['narrative', '叙事研究'], ['flow', '筹码资金'], ['security', '合约安全'], ['market', '行情结构'], ['risk', '投委会']];
const STATUS_LABELS = { ok: '新鲜', healthy: '新鲜', fresh: '新鲜', stale: '上次快照', loading: '同步中', error: '暂不可用', unavailable: '暂不可用', partial: '部分覆盖', ready: '满足条件', eligible: '满足条件', buy: '满足条件', enter: '满足条件', observe: '观察', watch: '观察', blocked: '暂不入场', no_buy: '暂不入场', paused: '暂停开仓', missing: '缺少数据', unknown: '未知', degraded: '部分覆盖', complete: '完整覆盖' };
const REASON_LABELS = {
  ambiguous_trade_legs: '交易方向证据冲突', feed_truncated: '资金流水被截断', incomplete_coverage: '资金流覆盖不完整', coverage_incomplete: '资金流覆盖不完整', no_activity: '暂无可核实资金流', stale_flow: '资金流快照已过期', flow_stale: '资金流快照已过期', stale_market: '行情快照已过期', market_stale: '行情快照已过期', missing_flow: '缺少资金流证据', no_flow: '缺少资金流证据', no_data: '暂无数据', missing_narrative: '缺少已核实叙事', narrative_unverified: '叙事尚未核实', insufficient_liquidity: '流动性未达条件', liquidity_low: '流动性未达条件', risk_blocked: '合约检查未通过', unknown_security: '合约安全信息不完整', security_unknown: '合约安全信息不完整', stop_loss: '触发止损', trailing_stop: '触发追踪止盈', take_profit: '分段止盈', max_hold: '达到持仓时限', max_hold_time: '达到持仓时限', insufficient_cash: '可用余额不足', max_positions: '已达持仓上限', already_held: '已持有该代币', cooldown: '等待交易冷却', rate_limited: '上游接口限流', unavailable: '数据暂不可用', unsupported: '数据源尚未覆盖', disabled: '已暂停新增仓位', pending: '等待下一轮研究', no_candidates: '暂无满足条件的对象', fetch_failed: '数据读取失败', timeout: '数据请求超时', rpc_unavailable: '链上数据暂不可用', smart_money_missing: '缺少聪明钱证据', not_graduated: '尚未完成内盘', not_internal: '不在内盘阶段', stale: '快照已过期', honey_pot: '卖出能力检查未通过', honeypot: '卖出能力检查未通过', wash_trading: '疑似刷量', high_concentration: '筹码集中度过高', holder_count_low: '持有人数量不足', not_run: '等待首次采集', market_unavailable: '行情暂不可用', trenches_unavailable: '内盘数据暂不可用', flow_unavailable: '资金流暂不可用', scale_out: '分段止盈', time_exit: '达到持仓时限', hard_stop: '触发止损', stale_quote: '报价已过期', partial_coverage: '部分覆盖', feed_missing: '缺少资金流数据', non_actionable: '尚未满足入场条件', no_fresh_quote: '缺少新鲜报价', cap_reached: '已达仓位上限', capital_reserved: '可用资金已预留', duplicate_token: '该代币已有持仓', risk_exit: '触发退出条件', data_stale: '数据已过期', mark_missing: '估值缺少报价', liquidity_exit: '流动性退出', newly_created: '新创建代币', graduated: '已完成内盘', new_creation: '新创建代币'
};

const state = { snapshot: null, status: 'loading', fetching: false, controlling: false, research: null, researchToken: null, researchBusy: false, researchError: false };
Object.assign(REASON_LABELS, { bounded_trade_feed_not_full_chain: '公开交易页有条数上限，非全链资金流', token_quarantined: '该币交易证据冲突，暂时隔离', ambiguous_trade_legs: '同笔交易金额、时间或方向不一致', feed_window_unverified: '等待新版来源流覆盖校验', feed_window_warming_or_gap: '近五分钟来源流尚未接齐，持续补采中', feed_record_invalid: '上游交易记录字段不完整', gmgn_unavailable: 'GMGN 数据暂不可用' });
Object.assign(REASON_LABELS, { binance_flow_stale: '币安逐笔数据尚未更新', binance_no_verified_feed: '币安该类逐笔暂无可验证记录', binance_window_warming_or_gap: '币安连续五分钟窗口采集中', binance_token_record_unverified: '该币含未识别交易类型或冲突记录', binance_record_invalid: '币安逐笔字段校验未通过', binance_response_invalid: '币安回包格式待核对', binance_rate_limited: '币安数据限频冷却中', binance_access_unavailable: '币安数据接口暂不可访问', binance_fetch_failed: '币安数据请求失败', binance_http_failed: '币安数据接口异常', binance_response_too_large: '币安回包超过采集上限' });
REASON_LABELS.token_window_rebuilding = '该币隔离已解除，正在重建五分钟流水';
const finite = value => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value));
const num = (value, fallback = 0) => finite(value) ? Number(value) : fallback;
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const money = value => finite(value) ? `${Number(value) < 0 ? '−' : ''}$${Math.abs(Number(value)).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';
const signedMoney = value => finite(value) ? `${Number(value) > 0 ? '+' : ''}${money(value)}` : '—';
const shortAddress = value => typeof value === 'string' && value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value || '—';
const strategyLabel = id => STRATEGY_LABELS[id] || '历史策略';
const recordLabel = row => row.entryEvidence?.opportunity?.label || (row.strategyLabel && ['聪明钱动量','内盘启动','外盘放量突破','外盘回踩再启动','外盘趋势延续','叙事 OG 回流','Alpha 刚上新快线','Alpha 上新后跟随','监控事件快线'].includes(row.strategyLabel)) ? row.entryEvidence?.opportunity?.label || row.strategyLabel
  : row.entryEvidence?.narrativeRecall || row.strategyLabel === 'OG 回流狙击' ? 'OG 回流狙击'
  : (row.entryEvidence?.exitPolicy?.version || row.exitEvidence?.exitPolicyVersion) === 'evidence_hold_v1' ? '确认型 PVP · 按证据持仓'
  : row.entryEvidence?.confirmedPolicy || row.exitEvidence?.exitPolicyVersion === 'confirmed_pvp_exit_v2' ? '确认型 PVP'
  : row.entryEvidence?.diagnostic || row.exitEvidence?.diagnosticVersion ? '诊断试仓' : strategyLabel(row.strategyId);
const statusLabel = value => STATUS_LABELS[value] || humanText(value || '等待数据');
const clock = value => { const date = value ? new Date(value) : new Date(); return Number.isFinite(date.getTime()) ? date.toLocaleTimeString('zh-CN', { hour12: false }) : '—'; };
const dateTime = value => { const date = new Date(value); return value && Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }) : '—'; };

function humanText(value) {
  if (Array.isArray(value)) return value.map(humanText).filter(Boolean).join('；');
  if (value && typeof value === 'object') return humanText(value.message || value.reason || value.label || value.code || '证据待补全');
  let text = String(value ?? '');
  for (const [code, label] of Object.entries(REASON_LABELS).sort((a, b) => b[0].length - a[0].length)) text = text.replaceAll(code, label);
  if (/^[a-z_\s:0-9.-]+$/i.test(text) && /[a-z]/i.test(text)) return '证据待补全';
  return text.replace(/\b[a-z]+(?:_[a-z0-9]+)+\b/g, '证据待补全').replaceAll('缺少：缺少', '缺少：');
}

function paintMoney(selector, value, signed = false) {
  const node = $(selector);
  node.textContent = signed ? signedMoney(value) : money(value);
  node.classList.toggle('positive', signed && finite(value) && Number(value) > 0);
  node.classList.toggle('negative', signed && finite(value) && Number(value) < 0);
}

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('#toast').classList.remove('show'), 3500);
}

function archiveSummary() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return;
    const positions = raw.positions && typeof raw.positions === 'object' ? Object.keys(raw.positions).length : 0;
    $('#legacyArchive').hidden = false;
    $('#legacyArchive').textContent = `旧浏览器账本已保留为只读存档：余额 ${money(raw.cash)} · ${positions} 个旧仓位。存档未计入当前账户。`;
  } catch { /* An unreadable archive stays untouched. */ }
}

function renderStatus() {
  const data = state.snapshot;
  const recent = data?.updatedAt && Date.now() - Date.parse(data.updatedAt) >= 0 && Date.now() - Date.parse(data.updatedAt) <= 120000;
  const connected = state.status === 'ok' && data?.status === 'ok' && recent;
  const dataHealth = tradingDataHealth(data);
  $('#streamLabel').textContent = connected ? dataHealth.label : state.status === 'loading' ? '策略引擎同步中' : data ? '连接异常 · 显示上次账本' : '策略引擎暂不可用';
  $('#streamStatus').dataset.status = connected && dataHealth.status === 'ok' ? 'ok' : 'stale';
  $('#focusSyncState').textContent = data?.updatedAt ? `更新于 ${clock(data.updatedAt)}` : '等待服务端账本';
  $('#paperStateLabel').textContent = connected ? '已同步' : '待同步';
  $('#chainLabel').textContent = data?.chains?.length > 1 ? `${data.chains.length} 链模拟 · 共用本金` : chainName(data?.chain || 'robinhood');
  $('#focusAutoToggle').checked = data?.enabled === true;
  $('#focusAutoToggle').disabled = !connected || state.controlling;
  const continuous = data?.operatingPolicy?.continuous === true;
  $('#focusAutoLabel').textContent = state.controlling ? '正在更新' : data ? data.enabled ? data.entryGuard?.allowed === false ? '开仓受阻 · 查看原因' : continuous ? '全天候模拟已开启' : '自动开仓已开启' : '已暂停新增仓位' : '等待引擎';
  $('#controlNote').textContent = data?.enabled === false ? '止损、止盈和监控继续运行' : continuous ? '不按亏损、次数或固定冷却停机；满足买点且余额足够时交易。电脑与网络需保持运行。' : data?.entryMode === 'paper_diagnostic_entry_v1' ? '主账户诊断试仓已开启 · 后台持续监控' : data?.entryMode === 'standard_and_exploratory' ? '小额探索试仓已开启 · 后台持续监控' : '后台持续监控，页面关闭后仍运行';
  const cadence = data?.cadence;
  const flowAt = Date.parse(data?.coverage?.flow?.observedAt || '');
  const age = Number.isFinite(flowAt) ? `${Math.max(0, Math.round((Date.now() - flowAt) / 1000))} 秒前` : '未知';
  const timing = cadence?.lastQuoteTiming;
  const quoteTiming = timing ? ` · 最近报价排队 ${(timing.queueMs / 1000).toFixed(1)} 秒 / 请求 ${(timing.requestMs / 1000).toFixed(1)} 秒（${clock(timing.observedAt)}）` : ' · 报价耗时待采集';
  const exits = data?.exitMonitor;
  const exitNote = exits ? ` · 独立退出检查 ${exits.intervalMs / 1000} 秒（最近 ${clock(exits.lastCheckedAt)}）${exits.staleQuotes ? ` · ${exits.staleQuotes} 个持仓报价失效，等待新价` : ''}` : ' · 退出检查初始化中';
  const queueNote = cadence?.sharedReadonlyPolicy?.plan === 'plus'
    ? 'GMGN Plus 调度 · 最多并发 3 个，预留 1 个持仓名额 · 最小派发间隔 350 毫秒（不是每币刷新间隔）'
    : cadence?.quotePriorityScope === 'shared_account_queue' ? '共享账号跨进程排队，持仓报价优先，后台等待逐步提权' : '本进程持仓报价优先';
  const sourceAges = (cadence?.marketSourceAges || []).map(source => `${chainName(source.chain)} ${finite(source.ageMs) ? Math.ceil(source.ageMs / 1000) + '秒' : '未取得'}`).join(' / ');
  $('#cadenceNote').textContent = cadence ? `页面同步 1 秒 · 全部候选扫描目标 ${cadence.evaluationIntervalMs / 1000} 秒 · 实测间隔 ${finite(cadence.actualTickGapMs) ? (cadence.actualTickGapMs / 1000).toFixed(1) : '—'} 秒${cadence.evaluationOverrunMs > 0 ? `（本轮超时 ${(cadence.evaluationOverrunMs / 1000).toFixed(1)} 秒，不堆叠任务）` : ''}${exitNote}${quoteTiming}${sourceAges ? ` · 各链行情年龄：${sourceAges}` : ''} · ${queueNote} · 资金流窗口截至 ${age} · 扫描频率不等于上游价格更新频率` : '等待检查频率和数据时间…';
  const guard = data?.entryGuard;
  $('#engineNotice').hidden = connected && dataHealth.status === 'ok' && !data?.lastError && !exits?.lastError && guard?.allowed !== false;
  $('#engineNotice').textContent = exits?.lastError ? `退出管理异常：${humanText(exits.lastError)}` : data?.lastError ? `本轮数据异常：${humanText(data.lastError)}。请以各策略的数据状态为准。` : guard?.allowed === false ? `新仓风控：${guard.reasons.join('；')}。监控和已有仓位退出继续；旧亏损账本不重置。` : connected ? dataHealth.summary : state.status === 'loading' ? '正在读取统一模拟账本…' : '暂时无法取得引擎状态。已显示的数据可能过期，正在重新连接。';
}

function renderAccount() {
  const account = state.snapshot?.account;
  const stats = account?.stats || {};
  paintMoney('#focusCash', account?.cash);
  paintMoney('#focusPnl', account?.realizedPnl, true);
  paintMoney('#focusEquity', stats.netLiquidationValue ?? stats.equity);
  $('#focusWinLoss').textContent = finite(stats.wins) && finite(stats.losses) ? `${num(stats.wins)} 胜 / ${num(stats.losses)} 负` : '—';
  const costs = Array.isArray(account?.trades) ? account.trades.reduce((sum, trade) => sum + num(trade.costsUsd), 0) : null;
  paintMoney('#focusCosts', stats.totalCostsUsd ?? costs);
  $('#costModel').textContent = state.snapshot?.costModel || '费用及滑点按模型估算';
  const stale = num(stats.stalePositions);
  const session = state.snapshot?.session;
  const history = session ? `${session.label} · ${session.id} · 历史账户单独保留：余额 ${money(session.legacy.cash)} / 净盈亏 ${signedMoney(session.legacy.realizedPnl)} / ${session.legacy.tradeCount} 笔；不合并成绩、不自动补款` : '与旧浏览器账本独立';
  const sizing = state.snapshot?.positionSizing;
  const sizeNote = sizing?.mode === 'cash_fraction_cap' ? ' · 后续按可用余额 10%、最高 10 U 试仓，浮盈不计入投入' : sizing?.fixedEntryUsd === 10 ? ' · 后续每笔固定 10 U（含买入成本），不足 10 U 不下单' : sizing?.mode === 'cash_fraction' ? ' · 按可用余额滚仓，浮盈不计入投入' : '';
  const fundingNote = account?.cashAdjustments?.length ? ` · 手动虚拟资金调整 ${signedMoney(account.cashAdjustments.reduce((sum, item) => sum + item.amountUsd, 0))}（不计盈利，旧亏损保留）` : '';
  $('#accountNote').textContent = account ? `初始虚拟资金 ${money(account.initialCash)}${fundingNote} · ${history}${sizeNote}${stale ? ` · ${stale} 个仓位估值待刷新` : ''}` : '等待真实行情及统一模拟账本';
}

function renderPositions() {
  const account = state.snapshot?.account;
  const entries = Object.entries(account?.positions || {});
  const lastTrade = account?.trades?.at(-1);
  const experimental = state.snapshot?.exitComparison;
  const experimentNote = experimental ? `<span>独立对照持仓：原退出 ${num(experimental.control?.positions?.length)} 个 / 量价退出 ${num(experimental.dynamic?.positions?.length)} 个，不计入主账户。<a href="#exitComparison">查看对照持仓、买入依据与成交</a></span>` : '';
  const activityNote = (lastTrade ? `<span>主账户已有 ${num(account.stats?.entries)} 次买入；最近成交：${escapeHtml(dateTime(lastTrade.atMs))} ${escapeHtml(lastTrade.symbol || '未知')} ${lastTrade.side === 'buy' ? '买入' : '卖出'}。<a href="#recentTrades">查看成交记录</a></span>` : '') + experimentNote;
  const expanded = new Set([...document.querySelectorAll('.holding-detail[open]')].map(node => node.closest('.holding')?.dataset.position));
  $('#focusPositionCount').textContent = account ? `${entries.length} 个仓位` : '等待同步';
  $('#focusPositionsList').innerHTML = entries.length ? entries.map(([key, position]) => {
    const fresh = ['ok', 'fresh'].includes(position.markStatus) && Date.now() - Date.parse(position.markAt) <= 120000;
    const symbol = `${chainName(position.chain)} · ${position.symbol || shortAddress(position.address)}`;
    const unrealized = position.pnl;
    let reasons = humanText(position.entryLogic || (position.entryReasons?.length ? position.entryReasons : '入场依据未记录'));
    const proof = position.entryEvidence || {};
    const evidenceText = proof.flow ? `入场时：核实盈利地址 ${num(proof.flow.highProfitCount)} 个，净买家 ${num(proof.flow.uniqueBuyerCount)} 个，已观察净流入 ${money(proof.flow.netBuyUsd)}。${proof.narrativeText ? `叙事：${proof.narrativeText}` : ''}` : '';
    if (evidenceText) reasons += ` ${evidenceText}`;
    const research = renderStrategyDetails(proof.entryPlan, proof.narrativeAssessment, position);
    return `<article class="holding" data-position="${escapeHtml(key)}"><div class="holding-heading"><div class="holding-identity"><span class="token-letter">${escapeHtml(String(symbol).slice(0, 1))}</span><div><strong>${escapeHtml(symbol)}</strong><span>${escapeHtml(recordLabel(position))} · ${escapeHtml(shortAddress(position.address))}</span></div></div><div class="holding-value"><strong>${money(position.markValue)}</strong><span class="${num(unrealized) >= 0 ? 'positive' : 'negative'}">${signedMoney(unrealized)} <small>浮盈亏</small></span></div></div><p class="holding-reason"><span>买入逻辑</span>${escapeHtml(reasons)}</p><details class="holding-detail"${expanded.has(key) ? ' open' : ''}><summary>查看叙事、买卖点与仓位 <span>${fresh ? '估值已更新' : '估值待刷新'}</span></summary><dl><div><dt>当前数量</dt><dd>${finite(position.quantity) ? num(position.quantity).toLocaleString('zh-CN', { maximumFractionDigits: 5 }) : '—'}</dd></div><div><dt>剩余成本</dt><dd>${money(position.costBasisUsd ?? position.cost)}</dd></div><div><dt>买入时间</dt><dd>${dateTime(position.openedAt)}</dd></div><div><dt>估值时间</dt><dd>${dateTime(position.markAt)}</dd></div></dl>${research}<p>${escapeHtml(humanText(position.exitLogic || '按所属策略的止损、追踪止盈和持仓时限退出'))}</p><p class="contract-address">${escapeHtml(position.chain || '')} · ${escapeHtml(position.address || '合约地址未记录')}</p></details></article>`;
  }).join('') : `<div class="focus-empty">${account ? '当前没有持仓' : '账本同步中'}${activityNote}<span>${account ? state.snapshot?.enabled === false || state.snapshot?.entryGuard?.allowed === false ? '新仓已暂停，监控与信号评估继续。' : '满足策略条件后自动模拟买入，入场依据会显示在这里。' : '余额和持仓以服务端记录为准。'}</span></div>`;
}

function renderStrategies() {
  const multi = ['multi_setup_v1','multi_setup_v2'].includes(state.snapshot?.opportunityMode);
  const reviewed = state.snapshot?.opportunityMode === 'multi_setup_v2';
  const strategies = multi ? state.snapshot.opportunityRoutes || [] : state.snapshot?.strategies || [];
  const upside = state.snapshot?.exitPolicy?.mode === 'upside';
  const pvp = state.snapshot?.exitPolicy?.mode === 'pvp';
  const evidenceHold = state.snapshot?.exitPolicy?.version === 'evidence_hold_v1';
  const confirmed = state.snapshot?.entryMode === 'confirmed_pvp_v2';
  const continuous = state.snapshot?.operatingPolicy?.continuous === true;
  const recall = state.snapshot?.narrativeRecall;
  const newsNode=$('#newsWireContent');
  if(newsNode){
    const expanded=new Set([...newsNode.querySelectorAll('details[data-narrative-case][open]')].map(d=>d.dataset.narrativeCase));
    newsNode.innerHTML=renderNewsWire(state.snapshot?.newsWire,state.snapshot?.narrativeDesk,expanded);
  }
  const recallNode = $('#narrativeRecallNote');
  const review = state.snapshot?.entryGuard?.lossReview;
  const batchNode = $('#tradeCountReview');
  if (batchNode) batchNode.innerHTML = renderTradeCountReview(state.snapshot?.tradeCountReview);
  const reviewNode = $('#tradeReviewNote');
  if (reviewNode) reviewNode.textContent = review ? `即时交易统计（非 AI 复盘）· 连亏不暂停；已完成 ${num(review.completedRounds)} 个完整仓位，当前连续 ${num(review.consecutiveNonWinningRounds)} 次未盈利。${review.recent?.at(-1) ? `${review.recent.at(-1).symbol}：${review.recent.at(-1).findings.join('；')}。` : '等待真实平仓结果。'}${continuous ? '全天候模拟：日亏损、总亏损及次数只记录；止损、真实数据与余额检查保持。' : '止损、仓位、日亏损和总亏损保护保持。'}` : '交易统计初始化中…';
  const trader = state.snapshot?.entryGuard?.traderReview;
  const traderNode = $('#traderReasoningNote');
  if (traderNode) {
    const s = trader?.overall;
    const current = trader?.cohorts?.filter(c => c.reasoningVersion === 'evidence_first_v1' && (!multi || c.opportunityVersion === state.snapshot.opportunityMode) && (state.snapshot?.mainExitPolicy ? c.exitVersion===state.snapshot.mainExitPolicy.version : !evidenceHold || ['evidence_hold_v1','structure_hold_v2'].includes(c.exitVersion)) && (!continuous || c.accountPolicyVersion === 'continuous_paper_v1')) || [];
    traderNode.textContent = s ? `交易决策四问 · 为什么现在买 / 哪里判错 / 成本后是否值得 / 凭什么继续持有。完整平仓 ${num(s.closedRounds)} 笔，平均净收益 ${finite(s.averageNetUsd) ? signedMoney(s.averageNetUsd) : '待采样'}；价格亏损 ${num(s.priceLosses)} 笔，费用转亏 ${num(s.costOnlyLosses)} 笔。${continuous ? '全天候模拟版本' : evidenceHold ? '按证据持仓版本' : '新决策版本'}已平仓 ${current.reduce((n,c) => n + num(c.closedRounds), 0)} 笔，旧成交不混作新版成绩。按链与规则版本复核，未验证净期望；连亏不暂停。` : '交易决策与成本归因初始化中…';
  }
  const learner = state.snapshot?.narrativeLearning;
  const learningNote = $('#narrativeLearningNote');
  if (learningNote) {
    const latest = learner?.recentSamples?.[0];
    const theme = learner?.themes?.[0];
    learningNote.textContent = learner?.error || (learner ? `起量叙事自动学习 · 基线 ${num(learner.baselineReadyTokens)} / 当前观察 ${num(learner.observedTokens)} 个币；当前留存 ${num(learner.sampleCount)} 次起量，${num(learner.verifiedNarrativeSamples)} 次已核实叙事、${num(learner.linkedNarrativeSamples)} 次仅链接关联、${num(learner.narrativePending)} 次叙事待核实。市值≥100万美元、1分钟成交额≥1万美元且≥历史基线3倍；复查5分钟 / 1小时 / 24小时。24小时有效样本 ${num(learner.completed24h)}，缺失 ${num(learner.missed24h)}；涨跌都保留，不自动放宽买入规则。${latest ? ` 最近：${latest.symbol || shortAddress(latest.address)}，起量 ${num(latest.volumeMultiple).toFixed(1)} 倍；${latest.narratives?.[0] ? `${latest.narratives[0].binding === 'verified_ca' ? 'CA 已核实' : '关联待核实'}文案：${latest.narratives[0].text.slice(0,140)}` : '尚未找到可靠原文关联'}。` : '等待同口径基线和真实起量事件。'}${theme ? ` 角度「${theme.terms.slice(0,5).join('、')}」：24小时上涨 ${num(theme.positive)} / 下跌 ${num(theme.negative)}，先冲后回落 ${num(theme.observedPumpThenFade)}；${theme.status}。` : ''}` : '起量叙事自动学习初始化中；不是模型训练完成或已验证盈利。');
    const retention = learner?.retention;
    if (!learner?.error && retention) learningNote.textContent += ` 留存保护：待完成24小时观察 ${num(retention.pending24h)} / ${num(retention.pendingLimit)}，已结案 ${num(retention.resolved24h)} / ${num(retention.resolvedLimit)}；满额跳过新波次 ${num(retention.capacitySkippedEpisodes)}，已结案按时间淘汰 ${num(retention.evictedResolvedEpisodes)}。未到期案例不被新样本挤掉；遗漏不算亏损，未按涨跌筛选。`;
  }
  if (recallNode) recallNode.textContent = recall?.error || (recall ? `七天叙事回溯 · 已核实文案 ${num(recall.sourceCount)} 条 / 精确 CA 绑定 ${num(recall.knownTokens)} 个。仅覆盖已采集样本，不是完整七天；大 KOL / 官方网站文案高重合后，优先查历史 OG。${recall.matches?.length ? recall.matches.map(m=>`${m.summary} 历史市值参考空间 ${finite(m.referenceRoom) ? m.referenceRoom.toFixed(2)+' 倍（非预测）' : '未知'}；${m.ready ? '叙事条件通过，仍需新买盘、报价与账户检查' : m.reasons.join('；')}`).join(' ') : '当前没有可进入交易检查的回流事件，继续采集。'}` : '七天叙事回溯初始化中；无 CA 不等于无叙事，也不等于已找到可买代币。');
  $('#strategyObjective').textContent = state.snapshot?.entryMode === 'paper_diagnostic_entry_v1' ? '主账户诊断试仓 · K 线形态、盈亏比、聪明钱人数与辅助风控只记录，不拦截。按余额 2% 试单，5% 止损；45 秒无成本后盈利则撤。真实参考价＋模拟成本，不是实盘。' : pvp ? '短线 PVP · 45 秒后仍无成本后盈利则撤；主仓最长 3 分钟，确认继续走强才留最多 20% 尾仓，开仓后最多 20 分钟。' : upside ? '大行情优先 · 小仓试错，亏损及时退出；3 / 10 / 30 倍各兑现原仓 20%，留 40% 跟随趋势。倍数是条件规则，不是收益预测。' : '按结构目标与倍数档分段退出。';
  if (confirmed) $('#strategyObjective').textContent = `确认型 PVP v2 · 新增双地址买盘＋三次独立报价，全路径检查深跌反抽。往返模型成本≤5%、${state.snapshot?.positionSizing?.fixedEntryUsd === 10 ? '固定单笔 10 U（含买入成本）' : '单笔至少 $1'}；${continuous ? '全天候模拟：无开仓次数、固定冷却或持仓个数上限，不因日亏损或总亏损停机；保留买点、真实数据、余额检查和止损。' : '每小时最多6次、每日最多24次；连亏复盘、不设连亏冷静期，日亏损和总亏损保护保持。'}新参数尚未验证盈利。`;
  if (multi) $('#strategyObjective').textContent = '多路机会模拟 · 内盘启动 / 聪明钱动量 / 外盘突破 / 回踩再启动 / 趋势延续 / 叙事 OG 回流。外盘量价策略不强制聪明钱标签，使用已收盘 K 线＋新鲜独立报价；按行情持仓，没有固定到期卖出。每笔 10 U，往返模型成本≤5%；持续研究但不保证每时每刻成交，不能覆盖或获利于所有代币。';
  const exitNote = $('#strategyLanes').nextElementSibling;
  if (reviewed) {
    const r=state.snapshot.researchPipeline,c=state.snapshot.reviewComparison;
    $('#strategyObjective').textContent='多路机会 v2 · 全链发现、分链热点快研究；普通量价入口检查结构和成本，事件快线按各自规则入场。每笔 10 U，无固定持仓时限，旧仓沿用入场版本。'
      +` 当前热点 ${r?.hotCandidates?.length||0} 个 / 研究候选 ${r?.discoveryCandidates||0} 个。`
      +(c?` 前向对照：新版 ${c.main.entries} 次买入、${c.main.closedRounds} 笔平仓（${signedMoney(c.main.newRoundPnl)}）；旧入口对照 ${c.control.entries} 次买入、${c.control.closedRounds} 笔平仓（${signedMoney(c.control.newRoundPnl)}）。同起点、同数据池、同费用，独立模拟账本，未验证盈利。`:' 前向对照初始化中。');
  }
  if(state.snapshot?.mainExitPolicy)$('#strategyObjective').textContent+=' 后续主盘新仓已切换「叙事＋资金行为退出」，取消固定价格、倍数和时间触发；旧仓和独立对照规则不变。';
  if(state.snapshot?.mainEntryPolicy)$('#strategyObjective').textContent+=` ${state.snapshot.mainEntryPolicy.text}`;
  if(state.snapshot?.recovery)$('#strategyObjective').textContent=`恢复期 · ${state.snapshot.enabled?'新开仓已手动启用':'新开仓暂停；持仓退出和监控继续'}。${state.snapshot.recovery.entryText} ${state.snapshot.recovery.exitText} 当前主仓新鲜报价 ${state.snapshot.cadence?.mainFreshQuotes??0}/${state.snapshot.cadence?.mainQuoteTargets??0}；本地每秒检查不代表每币每秒收到新行情。`;
  if (exitNote?.classList.contains('section-note')) exitNote.textContent = state.snapshot?.mainExitPolicy ? state.snapshot.mainExitPolicy.text : reviewed
    ? '外盘新仓：真实结构＋波动缓冲止损；连续两根入场后收盘线确认买入依据失效则退出。历史结构参考位且扣成本盈利时兑现 20%，2 / 3 倍各兑现 30%，留 20% 尾仓；保护线只上调。资金流路线沿用证据持有。报价缺失不虚构成交；GMGN 单边 1% 费用参考，滑点与 gas 为估算。'
    : evidenceHold
    ? '秒级检查，不按分钟强制卖出。新仓无 120 秒停滞、5 分钟主仓或 20 分钟尾仓到期；初始止损 6%，价格上涨 15% 后启动成本保护和峰值回撤 12% 退出，完整资金流连续反向确认也退出。2 / 3 倍分别兑现原仓 50% / 30%，尾仓按证据持有。缺报价不虚构成交，缺资金流不宣称趋势有效；旧仓按原规则，成绩按版本区分。'
    : confirmed
    ? '秒级检查价格；初始止损 6%。120 秒价格仍未走强才退出，不按 45 秒机械支付往返费用；主仓最长 5 分钟，强势尾仓最长 20 分钟。旧仓按原规则，新旧成绩不混称新版收益。'
    : pvp
    ? '结构参考位不减仓；2 / 3 倍兑现原仓 50% / 30%。1.15 倍起保护剩余本金与成本，峰值回撤 12% 退出。只用新鲜报价模拟成交，旧仓保留入场规则；不为凑笔数交易。'
    : upside
    ? '不在小幅结构目标减仓；曾达 2 倍启动剩余本金保护，3 / 10 / 30 倍起峰值回撤线分别为 45% / 35% / 25%。强势仓延长、弱势仓到期退出，最长 7 天。旧仓沿用入场时规则。'
    : '新版先在结构目标分段回收 20%，2 / 5 / 10 倍再回收 30% / 30% / 10%；启动保护后止损线只收紧，尾仓继续追踪回撤。';
  const expanded = new Set([...document.querySelectorAll('.lane-detail[open]')].map(node => node.dataset.strategy));
  $('#strategyLanes').innerHTML = (multi ? strategies.map(p=>[p.id,p.label]) : Object.entries(STRATEGY_LABELS).filter(([id]) => !confirmed || id === 'smart_money')).map(([id, legacyLabel], index) => {
    const label = multi ? legacyLabel : evidenceHold ? '确认型 PVP · 按证据持仓' : confirmed ? '确认型 PVP v2' : legacyLabel;
    const lane = strategies.find(item => item.id === id);
    const ready = lane && (['eligible', 'ready', 'buy', 'enter', '可模拟', '可入场'].includes(lane.decision) || num(lane.eligibleCount) > 0);
    const decision = lane ? statusLabel(lane.decision) : '等待数据';
    const duration = lane?.exitPolicy?.version === 'evidence_hold_v1' ? '按行情，无固定时限' : finite(lane?.maxHoldMs) ? num(lane.maxHoldMs) < 3600000 ? `${Math.round(num(lane.maxHoldMs) / 60000)} 分钟` : `${(num(lane.maxHoldMs) / 3600000).toLocaleString('zh-CN', { maximumFractionDigits: 1 })} 小时` : '—';
    const stop = lane?.memeExitPolicy ? '不设固定百分比（非最大亏损保证）' : finite(lane?.stopLoss) ? `${Math.round(Math.abs(num(lane.stopLoss)) * 100)}%` : '—';
    let reason = lane ? humanText(lane.reasons?.length ? lane.reasons : ready ? '满足研究条件，等待仓位及余额检查' : '等待完整入场证据') : '等待引擎提供研究结论';
    const flow = lane?.flowEvidence;
    if (flow) reason += flow.coverageGap ? `。资金流：${humanText(flow.coverageGap)}`
      : `。已观察净买入 ${money(flow.netBuyUsd)}，盈利达标 ${finite(flow.highProfitCount) ? num(flow.highProfitCount) : '未知'} 个地址；画像完整 ${finite(flow.profileCheckedCount) ? num(flow.profileCheckedCount) : '未知'} / ${finite(flow.uniqueBuyerCount) ? num(flow.uniqueBuyerCount) : '未知'}`;
    if (flow?.providerLabel) reason += `。来源：${flow.providerLabel}${flow.fomoSupported === false ? '（本源不提供 FOMO 标签）' : ''}`;
    const stats = lane?.stats || state.snapshot?.account?.stats?.byStrategy?.[id] || lane;
    const probe = !confirmed && lane?.exploratoryEnabled ? lane.exploratory : null;
    const auditPolicyText = state.snapshot?.entryMode === 'paper_diagnostic_entry_v1' ? '诊断模式：策略与辅助风险只记录；不标为审计通过' : state.snapshot?.auxiliaryAuditPolicy === 'pvp_aux_audit_v1' ? '基础交易检查保留，缺少辅助评分可小额试仓' : '安全与量价检查照常';
    const description = multi ? lane?.description || '等待具体入场条件' : confirmed ? '近 90 秒至少两个净买家、净买入 $300；五分钟净流入至少 $500。常规需一个聪明钱标签；已核实的 OG 回流催化可替代标签要求，仍需双地址新买盘和连续报价。标签不代表核实盈利。' : probe ? `探索：${num(probe.minBuyers)} 个真实净买家、至少 ${num(probe.minSmartMoney)} 个聪明钱标签或核实盈利地址，净流入 ≥ ${money(probe.minNetBuy)}；不要求盈利画像人数达标，${auditPolicyText}。` : lane?.description || '等待具体入场条件';
    const sizing = state.snapshot?.positionSizing;
    const roll = sizing?.mode === 'cash_fraction', standardRate = sizing?.standardRates?.[id];
    const previewBudget = rate => Math.floor((num(sizing?.cashBasis) * num(rate) + 1e-9) * 100) / 100;
    const budget = sizing?.mode === 'cash_fraction_cap' ? `可用余额 ${num(sizing.entryFraction) * 100}%、最高 ${num(sizing.maxEntryUsd)} U（本轮≤${money(Math.min(num(sizing.maxEntryUsd),previewBudget(sizing.entryFraction)))}）；另受流动性、信号与成本限制` : sizing?.fixedEntryUsd === 10 ? '固定单笔 10 U（含买入成本）；余额或流动性额度不足则不下单' : confirmed ? `余额 ${num(sizing?.exploratoryRate ?? .02) * 100}%（≤${money(previewBudget(sizing?.exploratoryRate ?? .02))}），不足 $1 不下单` : roll ? `${probe ? `探索 ${num(sizing.exploratoryRate) * 100}%（≤${money(previewBudget(sizing.exploratoryRate))}） / ` : ''}标准 ${num(standardRate) * 100}%（≤${money(previewBudget(standardRate))}）`
      : probe ? `探索 ${money(probe.entryUsd)} / 标准 ${money(lane.entryUsd)}` : `单笔 ${money(lane?.entryUsd)}`;
    const details = renderStrategyDetails(lane?.entryPlan, lane?.narrativeAssessment, null, lane?.traderDecision);
    const legacyLogic = lane?.traderDecision ? '' : `<p>${escapeHtml(lane?.entryLogic || '等待入场依据')}</p>`;
    return `<article class="strategy-lane"><div class="lane-heading"><span class="lane-index">0${index + 1}</span><h3>${label}</h3><span class="lane-decision ${ready ? 'positive' : ''}">${escapeHtml(decision)}</span></div><p class="lane-description">${escapeHtml(humanText(description))}</p><div class="lane-policy"><span>${escapeHtml(budget)}</span><span>止损上限 ${stop}</span><span>初始时限 ${duration}</span></div><p class="lane-reason">${escapeHtml(reason)}</p><details class="lane-detail" data-strategy="${id}"${expanded.has(id) ? ' open' : ''}><summary>查看叙事与买卖点依据</summary>${legacyLogic}${details}<p>${escapeHtml(lane?.exitLogic || '等待退出计划')}</p></details><div class="lane-foot"><span>${lane ? `观察 ${num(lane.observedCount)} · 满足 ${num(lane.eligibleCount)}` : '尚未采集'}</span>${lane?.candidate ? `<span>候选 ${escapeHtml(lane.candidate.symbol || shortAddress(lane.candidate.address))}</span>` : ''}${finite(stats?.realizedPnl) ? `<span class="${num(stats.realizedPnl) >= 0 ? 'positive' : 'negative'}">净盈亏 ${signedMoney(stats.realizedPnl)}</span>` : ''}</div></article>`;
  }).join('');
}

function renderCoverage() {
  const coverage = state.snapshot?.coverage || {};
  const confirmed = state.snapshot?.entryMode === 'confirmed_pvp_v2';
  if (state.snapshot?.chains?.length > 1 && state.snapshot.chainCoverage) {
    $('#coverageList').innerHTML = state.snapshot.chains.map(chain => {
      const feed = state.snapshot.chainCoverage[chain] || {};
      const now = Date.now(), external = marketCoverageStatus(feed.market, now), internal = marketCoverageStatus(feed.trenches, now);
      const flow = flowCoverageStatus(feed.flow, now);
      const summary = `候选 ${num(feed.candidates)} · 资金流发现 ${num(feed.flowDiscovered)} · 待补查 ${num(feed.researchPending)} · 达标 ${num(feed.eligible)}`;
      const diagnostic = state.snapshot?.entryMode === 'paper_diagnostic_entry_v1';
      const funnel = feed.funnel ? `<span>逐关剩余：新鲜行情 ${num(feed.funnel.marketFresh)} → ${state.snapshot?.opportunityMode ? '路线信号达标' : '资金流达标'} ${num(feed.funnel.flowReady)} → ${diagnostic ? '成交模型可用' : '基础检查通过'} ${num(feed.funnel.safetyReady)} → ${confirmed ? '连续报价确认' : diagnostic ? '形态免筛选' : 'K 线齐全'} ${num(feed.funnel.chartReady)} → 新鲜报价 ${num(feed.funnel.quoteFresh)} → 可开仓 ${num(feed.funnel.eligible)}</span>` : '';
      return `<div class="coverage-item"><span class="coverage-dot ${external.fresh && internal.fresh && flow.fresh ? 'fresh' : ''}"></span><div><strong>${escapeHtml(chainName(chain))} · ${escapeHtml(summary)}</strong><span>外盘：${external.label} · 内盘：${internal.label}</span><span>资金流：${escapeHtml(flow.label || humanText(feed.flow?.coverageGap || '等待采集'))}${feed.flow?.providerLabel ? ` · ${escapeHtml(feed.flow.providerLabel)}` : ''}</span>${funnel}</div><time>${feed.flow?.observedAt ? clock(feed.flow.observedAt) : '—'}</time></div>`;
    }).join('');
    return;
  }
  $('#coverageList').innerHTML = [['market', '外盘行情'], ['trenches', '内盘 / 新发'], ['flow', '聪明钱资金流']].map(([key, label]) => {
    const feed = coverage[key];
    const live = key === 'flow' ? flowCoverageStatus(feed) : marketCoverageStatus(feed);
    const good = live.fresh;
    const gap = feed?.coverageGap ? humanText(feed.coverageGap) : key === 'flow' && feed?.complete === false ? '证据覆盖不完整' : null;
    const providers = key === 'flow' && Array.isArray(feed?.sources) ? `<span>${feed.sources.map(source => escapeHtml(`${source.label}：${flowCoverageStatus(source).label || humanText(source.coverageGap || '等待采集')}`)).join(' · ')}</span>` : '';
    return `<div class="coverage-item"><span class="coverage-dot ${good ? 'fresh' : ''}"></span><div><strong>${label}${key === 'flow' && feed?.providerLabel ? ` · ${escapeHtml(feed.providerLabel)}` : ''}</strong><span>${escapeHtml(live.label || gap || '等待采集')}${finite(feed?.count) ? ` · ${num(feed.count)} 个对象` : ''}</span>${providers}</div><time>${feed?.observedAt ? clock(feed.observedAt) : '—'}</time></div>`;
  }).join('');
}

function renderTrades() {
  const trades = state.snapshot?.account?.trades;
  const rows = Array.isArray(trades) ? [...trades].sort((a, b) => num(b.atMs) - num(a.atMs)).slice(0, 10) : [];
  $('#tradeCount').textContent = Array.isArray(trades) ? `共 ${trades.length} 笔` : '等待同步';
  $('#tradeRows').innerHTML = rows.length ? rows.map(row => {
    const buy = row.side === 'buy';
    const sideLabel = buy ? '买入' : row.side === 'writeoff' ? '计提损失' : '卖出';
    const pnl = row.realizedPnl;
    return `<tr><td><strong>${escapeHtml(row.symbol || shortAddress(row.address))}</strong><small>${dateTime(row.atMs)}</small></td><td><span class="${buy ? 'positive' : ''}">${sideLabel}</span><small>${escapeHtml(recordLabel(row))}</small></td><td>${money(buy ? Math.abs(num(row.netUsd)) : row.netUsd)}<small>${buy ? '总支出，含成本' : '净回款，已扣成本'} ${money(row.costsUsd)}</small></td><td class="${!buy && num(pnl) < 0 ? 'negative' : !buy && num(pnl) > 0 ? 'positive' : ''}">${buy ? '—' : signedMoney(pnl)}<small>${buy ? '见对应卖出结果' : '已计成本'}</small></td><td class="trade-reason">${escapeHtml(humanText(row.reason || '策略执行'))}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="trade-empty">暂无成交记录 · 实际模拟买卖后记录时间、成本和触发原因</td></tr>';
}

function renderResearchTeam() {
  const data = state.research;
  const report = data?.report;
  $('#researchTeamStatus').textContent = state.researchBusy ? '研究中' : state.researchError ? report ? '上次投研快照' : '数据暂不可用' : report ? `${state.researchToken?.symbol || ''} · ${statusLabel(data.status)}` : '展开查看';
  $('#researchTeamConclusion').textContent = humanText(report?.decision || '观察');
  $('#researchTeamScore').textContent = finite(report?.opportunityScore) ? `${num(report.opportunityScore)} / 100` : '—';
  $('#researchTeamConfidence').textContent = report?.confidence || '—';
  $('#researchTeamUpdated').textContent = data?.observedAt ? clock(data.observedAt) : '—';
  $('#researchTeamDepartments').innerHTML = report ? DEPARTMENTS.map(([id, label]) => {
    const department = report.departments?.[id] || {};
    return `<div class="research-department"><div><strong>${label}</strong><span>${escapeHtml(statusLabel(department.status || '观察'))}</span></div><p>${escapeHtml(humanText(department.conclusion || '暂无结论'))}</p></div>`;
  }).join('') : '<p class="research-empty">等待具体代币的链路、叙事、筹码、安全、行情和总控结论。</p>';
  $('#researchTeamBrief').textContent = humanText(data?.brief || (state.researchError ? '暂时无法获得投研数据，请稍后再试。' : '投研依据随真实证据更新。'));
}

function renderResearchArchive() {
  renderStrategies(); renderCoverage();
  $('#exitComparisonContent').innerHTML = renderExitComparison(state.snapshot?.exitComparison,state.snapshot?.mainExitPolicy,state.snapshot?.recovery);
  $('#exitComparisonStatus').textContent = state.snapshot?.exitComparison ? '独立运行 · 尚未验证盈利' : '等待实验启动';
  $('#walletLearningContent').innerHTML = renderWalletLearning(state.snapshot?.learning, state.snapshot?.learningComparison);
  $('#walletLearningStatus').textContent = state.snapshot?.learning?.lastError ? '采集待恢复' : state.snapshot?.learningComparison?.student ? '向前模拟对照中' : '真实样本学习中';
}

function renderAll() {
  renderStatus(); renderAccount(); renderPositions(); renderTrades();
  const visible=$('#researchArchive').open;
  // Continue recording CA changes; do not rebuild hundreds of hidden DOM rows.
  caDesk.update(state.snapshot, state.status === 'ok', visible);
  brainDesk.update(state.snapshot, state.status === 'ok');
  if(visible)renderResearchArchive();
}
$('#researchArchive').addEventListener('toggle',()=>{
  if($('#researchArchive').open){renderResearchArchive();caDesk.update(state.snapshot,state.status==='ok');}
});

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.method ? 15000 : 12000);
  try {
    const response = await fetch(url, { cache: 'no-store', ...options, signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error('request_failed');
    return data;
  } finally { clearTimeout(timer); }
}

async function refreshStrategyState() {
  if (state.fetching) return;
  state.fetching = true;
  try {
    const data = await requestJson('/api/strategy-state');
    if (!data || data.mode !== 'paper' || !['ok', 'loading', 'error'].includes(data.status)) throw new Error('invalid_state');
    state.snapshot = data;
    state.status = data.status;
  } catch { state.status = 'error'; }
  finally { state.fetching = false; renderAll(); }
}

async function setEnabled(enabled) {
  state.controlling = true;
  renderStatus();
  try {
    const result = await requestJson('/api/strategy-control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }) });
    if (result?.status === 'error' || result?.ok === false) throw new Error('control_failed');
    await refreshStrategyState();
    toast(enabled ? '已恢复自动开仓。' : '已暂停新增仓位，持仓止损、止盈和监控继续运行。');
  } catch { toast('开关更新失败，请稍后重试。'); }
  finally { state.controlling = false; renderStatus(); }
}

async function refreshResearchTeam() {
  if (!$('#researchPanel').open || state.researchBusy) return;
  state.researchBusy = true;
  state.researchError = false;
  renderResearchTeam();
  try {
    let token = Object.values(state.snapshot?.account?.positions || {})[0] || state.snapshot?.strategies?.find(lane => lane.candidate)?.candidate;
    if (!token?.address) {
      const market = await requestJson('/api/market?chain=robinhood&interval=1m&limit=20');
      token = market.tokens?.[0];
    }
    if (!token?.address) throw new Error('no_research_target');
    const data = await requestJson(`/api/research-team?chain=${encodeURIComponent(token.chain || 'robinhood')}&address=${encodeURIComponent(token.address)}`);
    state.researchToken = token;
    state.research = data;
  } catch { state.researchError = true; }
  finally { state.researchBusy = false; renderResearchTeam(); }
}

$('#focusAutoToggle').addEventListener('change', event => setEnabled(event.target.checked));
$('#researchPanel').addEventListener('toggle', () => { if ($('#researchPanel').open) refreshResearchTeam(); });
archiveSummary();
renderAll();
renderResearchTeam();
$('#clock').textContent = clock();
setInterval(() => { $('#clock').textContent = clock(); }, 1000);
setInterval(refreshStrategyState, 1000);
setInterval(refreshResearchTeam, 60000);
refreshStrategyState();
