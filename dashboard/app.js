const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const STORAGE_KEY = 'gmgn-paper-terminal-v1';
const AUTO_STORAGE_KEY = 'yesp-atm-auto-v1';
const PAPER_START = 100;
const CHAINS = ['bsc', 'base', 'eth', 'sol'];
const REAL_REFRESH_MS = 60_000;
const AUTO_POLICY = Object.freeze({ entryUsd: 10, maxPositions: 2, stopLoss: -.2, takeProfit: .4, maxHoldMs: 30 * 60_000 });
const INTERVAL_LABELS = Object.freeze({ '1m': '1分钟', '5m': '5分钟', '1h': '1小时', '6h': '6小时', '24h': '24小时' });
const RESOLUTION_LABELS = Object.freeze({ '30s': '30秒', '1m': '1分', '5m': '5分', '15m': '15分', '1h': '1小时', '4h': '4小时', '1d': '1天' });
const RISK_LABELS = Object.freeze({ STRONG: '强', WATCH: '观察', BLOCKED: '拦截' });

const state = {
  selectedAddress: null,
  chain: 'bsc',
  interval: '1m',
  resolution: '1m',
  side: 'buy',
  slippage: 1,
  paused: false,
  tab: 'price',
  tokens: [],
  trades: [],
  chart: [],
  real: { status: 'loading', source: 'gmgn-cli', observedAt: null, latency: null, candleStatus: 'loading' },
  paper: loadPaper(),
  auto: loadAuto(),
};

function loadPaper() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (raw && Number.isFinite(raw.cash) && raw.cash >= 0 && raw.cash <= PAPER_START) return { cash: raw.cash, pnl: raw.pnl || 0, positions: raw.positions || {} };
  } catch { /* local-only fallback */ }
  return { cash: PAPER_START, pnl: 0, positions: {} };
}

function loadAuto() {
  try {
    const raw = JSON.parse(localStorage.getItem(AUTO_STORAGE_KEY) || 'null');
    if (raw && typeof raw.enabled === 'boolean') return { enabled: raw.enabled, lastRunAt: raw.lastRunAt || null, lastAction: raw.lastAction || '等待最新行情', lastReason: raw.lastReason || '' };
  } catch { /* local-only fallback */ }
  return { enabled: true, lastRunAt: null, lastAction: '已开启，等待最新行情', lastReason: '' };
}

function savePaper() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.paper)); }
function saveAuto() { localStorage.setItem(AUTO_STORAGE_KEY, JSON.stringify(state.auto)); }
function currentToken() { return state.tokens.find(token => token.address === state.selectedAddress) || state.tokens[0] || null; }
function number(value, fallback = 0) { const n = Number(value); return Number.isFinite(n) ? n : fallback; }
function money(value, digits = 2) { return Number.isFinite(Number(value)) ? `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}` : '—'; }
function compact(value) { const n = Number(value); if (!Number.isFinite(n)) return '—'; if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`; if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`; if (n >= 1e3) return `$${(n / 1e3).toFixed(1)}K`; return money(n); }
function tokenPrice(token) {
  if (!token || !Number.isFinite(Number(token.price))) return '—';
  const price = Number(token.price);
  if (price < .001) return `$${price.toFixed(8)}`;
  if (price < 1) return `$${price.toFixed(6)}`;
  return `$${price.toFixed(2)}`;
}
function shortClock(date = new Date()) { return date.toLocaleTimeString('en-GB', { hour12: false }); }
function formatAddress(address) { return typeof address === 'string' && address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address || '—'; }
function intervalLabel(interval) { return INTERVAL_LABELS[interval] || interval; }
function resolutionLabel(resolution) { return RESOLUTION_LABELS[resolution] || resolution; }
function riskLabel(risk) { return RISK_LABELS[risk] || '观察'; }
function hasRealData(status) { return status === 'ok' || status === 'stale'; }
function ageLabel(timestamp) {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - number(timestamp)));
  if (!timestamp || seconds <= 0) return '—';
  if (seconds < 3600) return `${Math.max(1, Math.floor(seconds / 60))}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 3000); }

function markRealStatus(status, extra = {}) {
  state.real = { ...state.real, status, ...extra };
  const ok = status === 'ok';
  const stale = status === 'stale';
  const hasData = ok || stale;
  $('#streamLabel').textContent = ok ? 'GMGN 真实行情' : stale ? 'GMGN 真实行情 · 上次成功快照' : status === 'loading' ? 'GMGN 行情 · 加载中' : 'GMGN 行情 · 暂不可用';
  $('#safetyCopy').textContent = ok ? 'GMGN 真实只读行情 · 不连接钱包 · 不签名 · 不广播' : stale ? 'GMGN 真实行情 · 上次成功快照 · 等待刷新 · 不连接钱包' : 'GMGN 真实行情暂不可用 · 未显示合成替代数据 · 不连接钱包';
  $('#sourceLabel').textContent = hasData
    ? `GMGN CLI · 只读 · ${state.chain}/${intervalLabel(state.interval)} · ${state.real.observedAt ? shortClock(new Date(state.real.observedAt)) : '—'}`
    : status === 'loading' ? 'GMGN CLI · 连接中' : 'GMGN CLI · 暂不可用';
  $('#latency').textContent = Number.isFinite(state.real.latency) ? String(state.real.latency) : '--';
  $('#paperStateLabel').textContent = hasData ? '已同步' : '本地';
}

function renderWatchlist() {
  const query = $('#tokenSearch').value.trim().toLowerCase();
  const visible = state.tokens.filter(token => !query || `${token.symbol} ${token.name} ${token.chain} ${token.address}`.toLowerCase().includes(query));
  $('#watchlist').innerHTML = visible.map(token => {
    const positive = number(token.change) >= 0;
    const risk = token.risk || 'WATCH';
    return `<button class="watch-item ${token.address === state.selectedAddress ? 'active' : ''}" data-token="${escapeHtml(token.address)}" type="button">
      <span class="watch-avatar" style="color:var(--lime);background:rgba(185,255,102,.08)">${escapeHtml(token.symbol.slice(0, 1))}</span>
      <span><span class="watch-symbol">${escapeHtml(token.symbol)}</span><span class="watch-chain">${escapeHtml(String(token.chain).toUpperCase())} · ${escapeHtml(riskLabel(risk))}</span></span>
      <span><span class="watch-price">${tokenPrice(token)}</span><span class="watch-change ${positive ? 'positive' : 'negative'}">${positive ? '+' : ''}${number(token.change).toFixed(2)}%</span></span>
    </button>`;
  }).join('') || (state.real.status === 'unavailable'
    ? '<div class="empty-position" style="margin:12px">GMGN 真实数据暂不可用<br /><span>未显示合成替代数据</span></div>'
    : '<div class="empty-position" style="margin:12px">等待 GMGN 真实排行…</div>');
  $$('.watch-item').forEach(button => button.addEventListener('click', () => { state.selectedAddress = button.dataset.token; refreshKline(); renderAll(); }));
  $('#watchCount').textContent = `${visible.length} 个资产`;
}

function renderMarket() {
  const token = currentToken();
  if (!token) {
    $('#tokenAvatar').textContent = '?'; $('#tokenAvatar').style.color = 'var(--muted)'; $('#tokenAvatar').style.background = '#18221c';
    $('#tokenName').textContent = '暂无实时代币'; $('#tokenChain').textContent = state.chain.toUpperCase(); $('#tokenAddress').textContent = '—'; $('#tokenAge').textContent = '—';
    $('#tokenPrice').textContent = '—'; $('#tokenChange').textContent = '—'; $('#tokenChange').className = 'market-change';
    ['#metricMcap', '#metricLiquidity', '#metricVolume', '#metricHolders'].forEach(selector => { $(selector).textContent = '—'; });
    $('#metricRisk').innerHTML = '<i class="risk-dot"></i> 等待中'; $('#orderAvatar').textContent = '?'; $('#orderToken').textContent = '—';
    $('#simulateButton').disabled = true; updateChart(); updateQuote(); return;
  }
  $('#simulateButton').disabled = false;
  $('#tokenAvatar').textContent = token.symbol.slice(0, 1); $('#tokenAvatar').style.color = 'var(--lime)'; $('#tokenAvatar').style.background = 'rgba(185,255,102,.08)';
  $('#tokenName').textContent = token.symbol; $('#tokenChain').textContent = String(token.chain).toUpperCase(); $('#tokenAddress').textContent = formatAddress(token.address); $('#tokenAge').textContent = ageLabel(token.creationTimestamp || token.openTimestamp);
  $('#tokenPrice').textContent = tokenPrice(token); const change = $('#tokenChange'); change.textContent = `${number(token.change) >= 0 ? '+' : ''}${number(token.change).toFixed(2)}%`; change.className = `market-change ${number(token.change) >= 0 ? 'positive' : 'negative'}`;
  $('#metricMcap').textContent = compact(token.marketCap); $('#metricLiquidity').textContent = compact(token.liquidity); $('#metricVolume').textContent = compact(token.volume); $('#metricHolders').textContent = token.holders == null ? '—' : Number(token.holders).toLocaleString('en-US');
  const riskColor = token.risk === 'BLOCKED' ? 'var(--red)' : token.risk === 'STRONG' ? 'var(--lime)' : 'var(--amber)'; $('#metricRisk').innerHTML = `<i class="risk-dot" style="background:${riskColor}"></i> ${escapeHtml(riskLabel(token.risk))}`;
  $('#orderAvatar').textContent = token.symbol.slice(0, 1); $('#orderAvatar').style.color = 'var(--lime)'; $('#orderAvatar').style.background = 'rgba(185,255,102,.08)'; $('#orderToken').textContent = token.symbol; $('#orderToken').nextElementSibling.textContent = String(token.chain).toUpperCase();
  updateChart(); updateQuote();
}

function updateChart() {
  const points = state.tab === 'price' ? state.chart.filter(value => Number.isFinite(Number(value))).map(Number) : [];
  const safePoints = points.length > 1 ? points : [0, 0]; const min = Math.min(...safePoints); const max = Math.max(...safePoints); const range = max - min || Math.max(Math.abs(max) * .02, .00000001); const width = 900; const height = 330;
  const coords = safePoints.map((value, index) => `${(index / (safePoints.length - 1)) * width},${height - ((value - (min - range * .1)) / (range * 1.2)) * height}`).join(' ');
  $('#chartLine').setAttribute('points', coords); $('#chartArea').setAttribute('d', `M 0 ${height} L ${coords.replaceAll(' ', ' L ')} L ${width} ${height} Z`);
  const last = safePoints.at(-1); const y = height - ((last - (min - range * .1)) / (range * 1.2)) * height; $('#chartCursor').setAttribute('cx', width); $('#chartCursor').setAttribute('cy', y);
  const token = currentToken(); const base = token?.price; $('#chartTop').textContent = Number.isFinite(base) ? tokenPrice({ price: base * 1.1 }) : '—'; $('#chartMid').textContent = Number.isFinite(base) ? tokenPrice({ price: base }) : '—'; $('#chartBottom').textContent = Number.isFinite(base) ? tokenPrice({ price: base * .9 }) : '—';
  const candleNote = state.real.candleStatus === 'ok'
    ? `GMGN K线 ${resolutionLabel(state.resolution)} · ${state.real.observedAt ? shortClock(new Date(state.real.observedAt)) : '采集时间'}`
    : state.real.candleStatus === 'stale'
      ? `GMGN K线 · 上次成功快照 · ${state.real.observedAt ? shortClock(new Date(state.real.observedAt)) : '采集时间'}`
      : hasRealData(state.real.status) ? 'GMGN 排行快照 · K线暂不可用' : '等待 GMGN 真实 K 线';
  $('#chartNote').textContent = state.tab === 'price' ? candleNote : `GMGN ${state.tab === 'trades' ? '成交' : '持有人'}聚合数据暂不可用 · 不使用合成序列`;
}

function renderTrades() {
  $('#tradeStream').innerHTML = state.trades.slice(0, 8).map(row => `<div class="trade-row"><span class="trade-time">${escapeHtml(row.time)}</span><span class="trade-type ${row.type === '上涨' ? 'buy' : 'sell'}">${row.type}</span><span class="trade-price">${escapeHtml(row.price)}</span><span class="trade-size">${escapeHtml(row.size)}</span><span class="trade-wallet">${escapeHtml(row.wallet)}</span></div>`).join('') || '<div class="empty-position" style="margin-top:8px">等待 GMGN 排行快照…</div>';
}

function updateQuote() {
  const token = currentToken(); const amount = Math.max(0, Number.parseFloat($('#amountInput').value) || 0); const price = token?.price; const receive = Number.isFinite(price) && price > 0 ? amount / price * (1 - state.slippage / 10000) : 0;
  $('#estimatedReceive').textContent = token && Number.isFinite(price) ? `${receive < 1 ? receive.toFixed(8) : receive.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${token.symbol}` : '—'; $('#priceImpact').textContent = token ? `${Math.max(.12, amount / 1200).toFixed(2)}%` : '—';
  $('#simulateLabel').textContent = state.side === 'buy' ? '模拟买入' : '模拟卖出'; $('#simulateButton').classList.toggle('sell-mode', state.side === 'sell');
}

function renderPaper() {
  $('#paperCash').textContent = money(state.paper.cash); $('#paperPnl').textContent = `${state.paper.pnl >= 0 ? '+' : ''}${money(state.paper.pnl)}`; $('#paperPnl').style.color = state.paper.pnl >= 0 ? 'var(--lime)' : 'var(--red)';
  const entries = Object.entries(state.paper.positions); $('#positionCount').textContent = `${entries.length} 个持仓`;
  $('#positionsList').innerHTML = entries.length ? entries.map(([symbol, position]) => `<div class="position-row"><div><strong>${escapeHtml(symbol)}</strong><small>${position.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })} 份额 · ${money(position.cost)} · ${position.auto ? '自动' : '手动'}</small></div><div class="position-pnl">${money(position.markValue - position.cost)}<small>纸上盈亏</small></div></div>`).join('') : '<div class="empty-position">暂无持仓<br /><span>模拟成交后显示在这里</span></div>';
  renderFocus();
}

function renderAuto() {
  const toggle = $('#autoPaperToggle');
  if (!toggle) return;
  toggle.checked = state.auto.enabled;
  $('#autoPaperLabel').textContent = state.auto.enabled ? '自动运行' : '已暂停';
  const focusToggle = $('#focusAutoToggle');
  if (focusToggle) focusToggle.checked = state.auto.enabled;
  const focusLabel = $('#focusAutoLabel');
  if (focusLabel) focusLabel.textContent = state.auto.enabled ? '自动运行' : '已暂停';
  const runAt = state.auto.lastRunAt ? `上次运行 ${shortClock(new Date(state.auto.lastRunAt))}` : '尚未运行';
  const reason = state.auto.lastReason ? ` · ${state.auto.lastReason}` : '';
  $('#autoPaperStatus').textContent = `${state.auto.lastAction || '等待最新行情'} · ${runAt}${reason}`;
}

function renderFocus() {
  const token = currentToken();
  const focusCash = $('#focusCash');
  if (!focusCash) return;
  focusCash.textContent = money(state.paper.cash);
  const focusPnl = $('#focusPnl');
  focusPnl.textContent = `${state.paper.pnl >= 0 ? '+' : ''}${money(state.paper.pnl)}`;
  focusPnl.style.color = state.paper.pnl >= 0 ? 'var(--lime)' : 'var(--red)';
  $('#focusSyncState').textContent = $('#paperStateLabel')?.textContent === '已同步' ? '已同步' : '本地账本';
  $('#focusAutoToggle').checked = state.auto.enabled;
  $('#focusAutoLabel').textContent = state.auto.enabled ? '自动运行' : '已暂停';
  $('#focusLastAction').textContent = state.auto.lastAction || '等待行情';
  $('#focusLastReason').textContent = state.auto.lastReason || '只写入本机模拟账本';

  const entries = Object.entries(state.paper.positions);
  $('#focusPositionCount').textContent = `${entries.length} 个仓位`;
  $('#focusPositionsList').innerHTML = entries.length ? entries.map(([symbol, position]) => {
    const liveToken = state.tokens.find(item => item.symbol === symbol);
    const quantity = number(position.quantity);
    const livePrice = Number(liveToken?.price);
    const markValue = Number.isFinite(livePrice) && livePrice > 0 ? quantity * livePrice : number(position.markValue, number(position.cost));
    const pnl = markValue - number(position.cost);
    const pnlClass = pnl >= 0 ? 'positive' : 'negative';
    const mode = position.auto ? '自动策略' : '手动模拟';
    const openedAt = position.openedAt ? shortClock(new Date(position.openedAt)) : '—';
    return `<article class="focus-position-row"><div class="focus-position-main"><span class="focus-position-avatar">${escapeHtml(symbol.slice(0, 1))}</span><div><strong>${escapeHtml(symbol)}</strong><span>${mode} · ${openedAt}</span></div></div><div class="focus-position-numbers"><strong>${money(markValue)}</strong><span class="${pnlClass}">${pnl >= 0 ? '+' : ''}${money(pnl)} · ${quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })} 份</span></div></article>`;
  }).join('') : '<div class="focus-empty">暂无持仓<span>自动买入后会显示在这里</span></div>';

  const freshness = state.real.status === 'ok' ? '实时' : state.real.status === 'stale' ? '上次快照' : state.real.status === 'loading' ? '连接中' : '不可用';
  $('#focusFreshness').textContent = freshness;
  $('#focusFreshness').className = `signal-state ${state.real.status === 'ok' ? 'fresh' : state.real.status === 'stale' ? 'stale' : ''}`;
  if (!token) {
    $('#focusTokenAvatar').textContent = '?'; $('#focusTokenName').textContent = '等待 GMGN 行情'; $('#focusTokenMeta').textContent = `${state.chain.toUpperCase()} · —`;
    $('#focusTokenPrice').textContent = '—'; $('#focusTokenChange').textContent = '—'; $('#focusRisk').textContent = '等待'; $('#focusLiquidity').textContent = '—'; $('#focusSmartMoney').textContent = '—'; $('#focusRug').textContent = '—';
    $('#focusSignalNote').textContent = '等待最新 GMGN 真实快照。';
    return;
  }
  const change = number(token.change);
  $('#focusTokenAvatar').textContent = token.symbol.slice(0, 1);
  $('#focusTokenName').textContent = token.symbol;
  $('#focusTokenMeta').textContent = `${String(token.chain).toUpperCase()} · ${formatAddress(token.address)}`;
  $('#focusTokenPrice').textContent = tokenPrice(token);
  const focusChange = $('#focusTokenChange'); focusChange.textContent = `${change >= 0 ? '+' : ''}${change.toFixed(2)}%`; focusChange.className = change >= 0 ? 'positive' : 'negative';
  $('#focusRisk').textContent = riskLabel(token.risk);
  $('#focusRisk').className = token.risk === 'STRONG' ? 'positive' : token.risk === 'BLOCKED' ? 'negative' : 'warning';
  $('#focusLiquidity').textContent = compact(token.liquidity);
  $('#focusSmartMoney').textContent = token.smartDegenCount == null ? '—' : `${token.smartDegenCount} 个`;
  $('#focusRug').textContent = Number.isFinite(Number(token.rugRatio)) ? `${(Number(token.rugRatio) * 100).toFixed(1)}%` : '—';
  const qualifies = state.real.status === 'ok' && autoEligible(token);
  $('#focusSignalNote').textContent = qualifies ? '当前对象满足自动筛选条件，下一周期可进入。' : state.real.status !== 'ok' ? '行情不是最新成功快照，不触发自动买入。' : '当前对象未满足全部买入条件，自动策略会继续观察。';
}

function autoEligible(token) {
  return token?.risk === 'STRONG'
    && Number.isFinite(Number(token.price)) && Number(token.price) > 0
    && Number.isFinite(Number(token.liquidity)) && Number(token.liquidity) >= 50_000
    && Number.isFinite(Number(token.smartDegenCount)) && Number(token.smartDegenCount) >= 3
    && Number.isFinite(Number(token.rugRatio)) && Number(token.rugRatio) < .2
    && token.isWashTrading !== true
    && number(token.change) >= 0;
}

function runPaperAutoCycle({ fresh = false, force = false } = {}) {
  if (!state.auto.enabled) return;
  const now = Date.now(); const previousRun = Date.parse(state.auto.lastRunAt || '');
  if (!force && Number.isFinite(previousRun) && now - previousRun < REAL_REFRESH_MS) {
    state.auto.lastAction = '等待下一个自动周期'; state.auto.lastReason = '自动周期为 60 秒'; saveAuto(); renderAuto(); return;
  }
  state.auto.lastRunAt = new Date(now).toISOString();
  if (!fresh) {
    state.auto.lastAction = '等待最新真实行情'; state.auto.lastReason = '旧快照不触发自动模拟'; saveAuto(); renderAuto(); return;
  }
  const prices = new Map(state.tokens.map(token => [token.symbol, Number(token.price)]));
  const actions = [];
  for (const [symbol, position] of Object.entries(state.paper.positions)) {
    if (position.auto !== true) continue;
    const price = prices.get(symbol);
    if (!Number.isFinite(price) || price <= 0) continue;
    position.markValue = position.quantity * price;
    const returnRate = position.cost > 0 ? position.markValue / position.cost - 1 : 0;
    const age = now - number(position.openedAt, now);
    const exitReason = returnRate <= AUTO_POLICY.stopLoss ? '触发止损' : returnRate >= AUTO_POLICY.takeProfit ? '触发止盈' : age >= AUTO_POLICY.maxHoldMs ? '到达最长持仓时间' : null;
    if (exitReason) {
      state.paper.cash += position.markValue; state.paper.pnl += position.markValue - position.cost; delete state.paper.positions[symbol];
      actions.push(`自动卖出 ${symbol} · ${exitReason}`);
    }
  }
  const autoPositions = Object.values(state.paper.positions).filter(position => position.auto === true).length;
  if (autoPositions < AUTO_POLICY.maxPositions && state.paper.cash >= AUTO_POLICY.entryUsd) {
    const candidate = state.tokens.find(token => autoEligible(token) && !state.paper.positions[token.symbol]);
    if (candidate) {
      const quantity = AUTO_POLICY.entryUsd / Number(candidate.price);
      state.paper.cash -= AUTO_POLICY.entryUsd;
      state.paper.positions[candidate.symbol] = { quantity, cost: AUTO_POLICY.entryUsd, markValue: AUTO_POLICY.entryUsd, auto: true, openedAt: now };
      actions.push(`自动买入 ${candidate.symbol} · ${money(AUTO_POLICY.entryUsd)}`);
    } else state.auto.lastReason = '没有同时满足强信号、流动性和风控条件的代币';
  } else if (autoPositions >= AUTO_POLICY.maxPositions) state.auto.lastReason = '已达到最多 2 个自动仓位';
  else state.auto.lastReason = '纸上余额不足 10 美元';
  state.auto.lastAction = actions.length ? actions.join('；') : '本轮没有交易动作';
  if (actions.length) state.auto.lastReason = '仅写入本机模拟账本';
  savePaper(); saveAuto(); renderAuto();
}

function renderAll() { renderWatchlist(); renderMarket(); renderTrades(); renderPaper(); renderAuto(); renderFocus(); }

function rowsFromTokens(tokens, observedAt) {
  const time = observedAt ? shortClock(new Date(observedAt)) : '--:--:--';
  return tokens.map(token => ({ time, type: number(token.change) >= 0 ? '上涨' : '下跌', price: tokenPrice(token), size: compact(token.volume), wallet: `${token.smartDegenCount ?? '—'} 聪明钱 / ${token.holders ?? '—'} 持有人` }));
}

async function getJson(url) {
  const started = performance.now(); const response = await fetch(url, { cache: 'no-store' }); const data = await response.json(); if (!response.ok) throw new Error('request failed'); return { data, latency: Math.round(performance.now() - started) };
}

async function refreshKline() {
  const token = currentToken(); if (!token) { state.chart = []; state.real.candleStatus = 'unavailable'; updateChart(); return; }
  const previousChart = state.chart;
  state.real.candleStatus = 'loading';
  try {
    const { data } = await getJson(`/api/kline?chain=${encodeURIComponent(String(token.chain).toLowerCase())}&address=${encodeURIComponent(token.address)}&resolution=${encodeURIComponent(state.resolution)}&hours=6`);
    if (!hasRealData(data?.status) || !Array.isArray(data.candles)) throw new Error('kline unavailable');
    state.chart = data.candles.map(candle => Number(candle.close)).filter(Number.isFinite); state.real.candleStatus = state.chart.length > 1 ? data.status === 'stale' ? 'stale' : 'ok' : 'unavailable';
  } catch { state.chart = previousChart.length > 1 ? previousChart : []; state.real.candleStatus = state.chart.length > 1 ? 'stale' : 'unavailable'; }
  updateChart();
}

async function refreshRealMarket() {
  if (state.paused) return;
  markRealStatus('loading');
  try {
    const { data, latency } = await getJson(`/api/market?chain=${encodeURIComponent(state.chain)}&interval=${encodeURIComponent(state.interval)}&limit=20`);
    if (!hasRealData(data?.status) || !Array.isArray(data.tokens)) throw new Error('market unavailable');
    state.tokens = data.tokens.filter(token => token && token.address && Number.isFinite(Number(token.price)));
    if (!state.tokens.some(token => token.address === state.selectedAddress)) state.selectedAddress = state.tokens[0]?.address || null;
    state.trades = rowsFromTokens(state.tokens.slice(0, 8), data.observedAt); state.real.candleStatus = 'loading';
    markRealStatus(data.status, { observedAt: data.observedAt, latency, staleReason: data.staleReason || null }); runPaperAutoCycle({ fresh: data.status === 'ok' }); renderAll(); await refreshKline();
  } catch {
    if (state.tokens.length) {
      state.real.candleStatus = state.chart.length > 1 ? 'stale' : 'unavailable';
      markRealStatus('stale', { staleReason: 'dashboard_fetch_failed' });
      renderAll();
    } else {
      state.tokens = []; state.selectedAddress = null; state.trades = []; state.chart = []; state.real.candleStatus = 'unavailable'; markRealStatus('unavailable'); renderAll();
    }
  }
}

async function syncPaperBridge() {
  try {
    const response = await fetch('/api/paper-state', { cache: 'no-store' }); if (!response.ok) throw new Error('paper state unavailable'); const data = await response.json();
    $('#paperStateLabel').textContent = data?.status === 'ok' ? '已同步' : '本地';
    if ($('#focusSyncState')) $('#focusSyncState').textContent = data?.status === 'ok' ? '已同步' : '本地账本';
  } catch { $('#paperStateLabel').textContent = '本地'; if ($('#focusSyncState')) $('#focusSyncState').textContent = '本地账本'; }
}

function placePaperOrder() {
  const token = currentToken(); if (!token) return toast('当前没有 GMGN 真实行情，暂停模拟下单。'); if (token.risk === 'BLOCKED') return toast(`${token.symbol} 已触发风险拦截，停止模拟下单。`);
  const amount = Number.parseFloat($('#amountInput').value); if (!Number.isFinite(amount) || amount <= 0) return toast('请输入大于 0 的模拟金额。');
  if (state.side === 'buy') { if (state.paper.positions[token.symbol]?.auto) return toast(`${token.symbol} 正由自动策略持有，请等待自动退出。`); if (amount > state.paper.cash) return toast('纸上账户余额不足。'); state.paper.cash -= amount; const units = amount / token.price; const position = state.paper.positions[token.symbol] || { quantity: 0, cost: 0, markValue: 0, auto: false, openedAt: Date.now() }; position.auto = false; position.quantity += units; position.cost += amount; position.markValue = position.quantity * token.price; state.paper.positions[token.symbol] = position; toast(`模拟买入 · ${money(amount)} ${token.symbol} 已加入纸上账本`); }
  else { const position = state.paper.positions[token.symbol]; if (!position || position.quantity <= 0) return toast(`纸上账本没有 ${token.symbol} 持仓。`); const sellUnits = Math.min(position.quantity, amount / token.price); const proceeds = sellUnits * token.price; const costBasis = position.cost * (sellUnits / position.quantity); state.paper.cash += proceeds; state.paper.pnl += proceeds - costBasis; position.quantity -= sellUnits; position.cost -= costBasis; position.markValue = position.quantity * token.price; if (position.quantity < .00000001) delete state.paper.positions[token.symbol]; toast(`模拟卖出 · ${money(proceeds)} ${token.symbol} 已从纸上账本扣除`); }
  savePaper(); renderPaper(); updateQuote();
}

$$('.order-tab').forEach(button => button.addEventListener('click', () => { state.side = button.dataset.side; $$('.order-tab').forEach(item => item.classList.toggle('active', item === button)); updateQuote(); }));
$$('[data-amount]').forEach(button => button.addEventListener('click', () => { $('#amountInput').value = button.dataset.amount; updateQuote(); }));
$$('[data-slippage]').forEach(button => button.addEventListener('click', () => { state.slippage = Number(button.dataset.slippage); $$('[data-slippage]').forEach(item => item.classList.toggle('active', item === button)); updateQuote(); }));
$('#amountInput').addEventListener('input', updateQuote); $('#maxButton').addEventListener('click', () => { const token = currentToken(); $('#amountInput').value = state.side === 'buy' ? state.paper.cash.toFixed(2) : (token ? state.paper.positions[token.symbol]?.markValue || 0 : 0).toFixed(2); updateQuote(); }); $('#simulateButton').addEventListener('click', placePaperOrder);
$('#tokenSearch').addEventListener('input', renderWatchlist);
function setAutoEnabled(enabled) {
  state.auto.enabled = enabled;
  state.auto.lastAction = state.auto.enabled ? '已开启，等待最新行情' : '自动模拟已暂停';
  state.auto.lastReason = state.auto.enabled ? '只使用最新 GMGN 真实快照' : '不会再自动买卖';
  saveAuto(); renderAuto(); toast(state.auto.enabled ? '自动模拟交易已开启。' : '自动模拟交易已暂停。');
  if (state.auto.enabled && state.real.status === 'ok') { runPaperAutoCycle({ fresh: true, force: true }); renderPaper(); updateQuote(); }
  renderFocus();
}
$('#autoPaperToggle').addEventListener('change', event => setAutoEnabled(event.target.checked));
$('#focusAutoToggle').addEventListener('change', event => setAutoEnabled(event.target.checked));
$('#pauseButton').addEventListener('click', () => { state.paused = !state.paused; $('#pauseButton').textContent = state.paused ? '▶' : 'Ⅱ'; $('#pauseButton').classList.toggle('active', state.paused); $('#streamLabel').textContent = state.paused ? 'GMGN 行情 · 已暂停' : hasRealData(state.real.status) ? state.real.status === 'stale' ? 'GMGN 真实行情 · 上次成功快照' : 'GMGN 真实行情' : 'GMGN 行情 · 加载中'; toast(state.paused ? 'GMGN 实时轮询已暂停。' : 'GMGN 实时轮询已恢复。'); if (!state.paused) refreshRealMarket(); });
$('#resetPaper').addEventListener('click', () => { state.paper = { cash: PAPER_START, pnl: 0, positions: {} }; state.auto.lastAction = '纸上账户已重置'; state.auto.lastReason = '自动模拟仍按开关状态运行'; savePaper(); saveAuto(); renderPaper(); renderAuto(); renderFocus(); toast('纸上账户已重置为 100 美元。'); });
$('#focusResetPaper').addEventListener('click', () => $('#resetPaper').click());
$('#copyButton').addEventListener('click', async () => { const token = currentToken(); if (!token) return toast('没有可复制的真实合约地址。'); try { await navigator.clipboard.writeText(token.address); toast('GMGN 合约地址已复制。'); } catch { toast('当前浏览器无法使用剪贴板。'); } });
$$('.chart-tab').forEach(button => button.addEventListener('click', () => { state.tab = button.dataset.tab; $$('.chart-tab').forEach(item => item.classList.toggle('active', item === button)); updateChart(); }));
$('#chainButton').addEventListener('click', () => { state.chain = CHAINS[(CHAINS.indexOf(state.chain) + 1) % CHAINS.length]; state.selectedAddress = null; $('#chainLabel').textContent = state.chain.toUpperCase(); toast(`链筛选：${state.chain.toUpperCase()} · GMGN 只读`); refreshRealMarket(); });
$('#filterButton').addEventListener('click', () => { const intervals = ['1m', '5m', '1h', '6h', '24h']; state.interval = intervals[(intervals.indexOf(state.interval) + 1) % intervals.length]; $('#filterButton').textContent = `GMGN ${intervalLabel(state.interval)}`; toast(`GMGN 排行窗口：${intervalLabel(state.interval)}`); refreshRealMarket(); });
$$('.timeframes button').forEach(button => button.addEventListener('click', () => { const resolution = button.dataset.resolution; if (!resolution) return; state.resolution = resolution; $$('.timeframes button').forEach(item => item.classList.toggle('active', item === button)); refreshKline(); }));
$('#crosshair').addEventListener('mousemove', event => { const bounds = event.currentTarget.parentElement.getBoundingClientRect(); event.currentTarget.style.left = `${event.clientX - bounds.left}px`; });
document.addEventListener('keydown', event => { if (event.key === '/' && document.activeElement !== $('#tokenSearch')) { event.preventDefault(); $('#tokenSearch').focus(); } });

renderAll(); $('#clock').textContent = shortClock(); markRealStatus('loading');
setInterval(() => { $('#clock').textContent = shortClock(); }, 1000);
setInterval(refreshRealMarket, REAL_REFRESH_MS);
setInterval(syncPaperBridge, 10_000);
syncPaperBridge();
refreshRealMarket();
