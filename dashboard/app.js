const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const STORAGE_KEY = 'gmgn-paper-terminal-v1';
const PAPER_START = 100;

const tokens = [
  { symbol: 'GENIUS', chain: 'BSC', price: 0.02184, change: 18.42, mcap: '$21.8M', liquidity: '$632K', volume: '$4.8M', holders: '8,412', address: '0x9a7…4f2c', color: '#b9ff66', risk: 'WATCH', age: '12m', volatility: .006 },
  { symbol: 'TOSHI', chain: 'BASE', price: 0.000891, change: 7.18, mcap: '$89.1M', liquidity: '$2.4M', volume: '$1.2M', holders: '31,209', address: '0x4b2…9ac1', color: '#6bd6ff', risk: 'LOW', age: '3h', volatility: .003 },
  { symbol: 'BRETT', chain: 'BASE', price: 0.05822, change: -2.83, mcap: '$580M', liquidity: '$6.8M', volume: '$12.9M', holders: '72,883', address: '0x1c4…78d0', color: '#ffbe6b', risk: 'WATCH', age: '2d', volatility: .002 },
  { symbol: 'MOG', chain: 'ETH', price: 0.0000016, change: 12.61, mcap: '$619M', liquidity: '$8.3M', volume: '$15.4M', holders: '44,308', address: '0x6f2…aa13', color: '#ff7d77', risk: 'WATCH', age: '4d', volatility: .004 },
  { symbol: 'BNB', chain: 'BSC', price: 607.41, change: 1.22, mcap: '$90.7B', liquidity: '$1.2B', volume: '$1.1B', holders: '—', address: 'native asset', color: '#f0b90b', risk: 'LOW', age: 'native', volatility: .001 },
];

const state = {
  selected: 'GENIUS',
  chain: 'BSC',
  side: 'buy',
  slippage: 1,
  paused: false,
  tab: 'price',
  lastTick: Date.now(),
  chart: Array.from({ length: 54 }, (_, index) => 48 + Math.sin(index / 5) * 8 + index * .12 + (Math.random() - .5) * 4),
  trades: [
    { time: '09:51:14', type: 'BUY', price: '$0.02184', size: '$4.2K', wallet: '0x7d…e19a' },
    { time: '09:51:08', type: 'BUY', price: '$0.02177', size: '$1.8K', wallet: '0xab…312f' },
    { time: '09:50:59', type: 'SELL', price: '$0.02161', size: '$840', wallet: '0x91…8b2c' },
    { time: '09:50:44', type: 'BUY', price: '$0.02152', size: '$3.1K', wallet: '0x4c…0a6e' },
    { time: '09:50:31', type: 'SELL', price: '$0.02149', size: '$592', wallet: '0x2e…f81d' },
    { time: '09:50:18', type: 'BUY', price: '$0.02137', size: '$1.1K', wallet: '0xf1…4c0b' },
  ],
  paper: loadPaper(),
};

function loadPaper() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (raw && Number.isFinite(raw.cash) && raw.cash >= 0 && raw.cash <= 100) return { cash: raw.cash, pnl: raw.pnl || 0, positions: raw.positions || {} };
  } catch { /* local-only fallback */ }
  return { cash: PAPER_START, pnl: 0, positions: {} };
}
function savePaper() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state.paper)); }
function currentToken() { return tokens.find(token => token.symbol === state.selected) || tokens[0]; }
function money(value, digits = 2) { return `$${Number(value).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`; }
function compact(value) { if (value >= 1e9) return `$${(value / 1e9).toFixed(1)}B`; if (value >= 1e6) return `$${(value / 1e6).toFixed(1)}M`; if (value >= 1e3) return `$${(value / 1e3).toFixed(1)}K`; return money(value); }
function parseCompact(value) { const match = String(value).replace(/[$,]/g, '').match(/^([0-9.]+)([KMB])?$/i); if (!match) return 0; const multiplier = { K: 1e3, M: 1e6, B: 1e9 }[String(match[2] || '').toUpperCase()] || 1; return Number(match[1]) * multiplier; }
function tokenPrice(token) { const p = token.price; return p < .001 ? `$${p.toFixed(7)}` : p < 1 ? `$${p.toFixed(5)}` : `$${p.toFixed(2)}`; }
function shortClock(date = new Date()) { return date.toLocaleTimeString('en-GB', { hour12: false }); }
function toast(message) { const node = $('#toast'); node.textContent = message; node.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2600); }

function renderWatchlist() {
  const query = $('#tokenSearch').value.trim().toLowerCase();
  const visible = tokens.filter(token => !query || `${token.symbol} ${token.chain} ${token.address}`.toLowerCase().includes(query));
  $('#watchlist').innerHTML = visible.map(token => `<button class="watch-item ${token.symbol === state.selected ? 'active' : ''}" data-token="${token.symbol}" type="button">
    <span class="watch-avatar" style="color:${token.color};background:${token.color}18">${token.symbol[0]}</span><span><span class="watch-symbol">${token.symbol}</span><span class="watch-chain">${token.chain} · ${token.age}</span></span><span><span class="watch-price">${tokenPrice(token)}</span><span class="watch-change ${token.change >= 0 ? 'positive' : 'negative'}">${token.change >= 0 ? '+' : ''}${token.change.toFixed(2)}%</span></span>
  </button>`).join('') || '<div class="empty-position" style="margin:12px">No matching assets</div>';
  $$('.watch-item').forEach(button => button.addEventListener('click', () => { state.selected = button.dataset.token; renderAll(); }));
  $('#watchCount').textContent = `${visible.length} assets`;
}

function renderMarket() {
  const token = currentToken();
  $('#tokenAvatar').textContent = token.symbol[0]; $('#tokenAvatar').style.color = token.color; $('#tokenAvatar').style.background = `${token.color}18`;
  $('#tokenName').textContent = token.symbol; $('#tokenChain').textContent = token.chain; $('#tokenAddress').textContent = token.address; $('#tokenAge').textContent = token.age;
  $('#tokenPrice').textContent = tokenPrice(token); const change = $('#tokenChange'); change.textContent = `${token.change >= 0 ? '+' : ''}${token.change.toFixed(2)}%`; change.className = `market-change ${token.change >= 0 ? 'positive' : 'negative'}`;
  $('#metricMcap').textContent = token.mcap; $('#metricLiquidity').textContent = token.liquidity; $('#metricVolume').textContent = token.volume; $('#metricHolders').textContent = token.holders;
  $('#metricRisk').innerHTML = `<i class="risk-dot"></i> ${token.risk}`; $('#orderAvatar').textContent = token.symbol[0]; $('#orderAvatar').style.color = token.color; $('#orderAvatar').style.background = `${token.color}18`; $('#orderToken').textContent = token.symbol;
  updateChart(); updateQuote();
}

function updateChart() {
  const points = state.chart; const min = Math.min(...points) - 5; const max = Math.max(...points) + 5; const width = 900; const height = 330;
  const coords = points.map((value, index) => `${(index / (points.length - 1)) * width},${height - ((value - min) / (max - min)) * height}`).join(' ');
  $('#chartLine').setAttribute('points', coords); $('#chartArea').setAttribute('d', `M 0 ${height} L ${coords.replaceAll(' ', ' L ')} L ${width} ${height} Z`);
  const last = points.at(-1); const x = width; const y = height - ((last - min) / (max - min)) * height; $('#chartCursor').setAttribute('cx', x); $('#chartCursor').setAttribute('cy', y);
  const token = currentToken(); const base = token.price; $('#chartTop').textContent = tokenPrice({ price: base * 1.1 }); $('#chartMid').textContent = tokenPrice({ price: base }); $('#chartBottom').textContent = tokenPrice({ price: base * .9 });
  $('#chartNote').textContent = `${state.tab === 'price' ? 'Synthetic price stream' : state.tab === 'trades' ? 'Synthetic buy/sell flow' : 'Synthetic holder delta'} · updated just now`;
}

function renderTrades() {
  $('#tradeStream').innerHTML = state.trades.slice(0, 8).map(trade => `<div class="trade-row"><span class="trade-time">${trade.time}</span><span class="trade-type ${trade.type === 'BUY' ? 'buy' : 'sell'}">${trade.type}</span><span class="trade-price">${trade.price}</span><span class="trade-size">${trade.size}</span><span class="trade-wallet">${trade.wallet}</span></div>`).join('');
}

function updateQuote() {
  const token = currentToken(); const amount = Math.max(0, Number.parseFloat($('#amountInput').value) || 0); const receive = amount / token.price * (1 - state.slippage / 10000);
  $('#estimatedReceive').textContent = `${receive < 1 ? receive.toFixed(6) : receive.toLocaleString('en-US', { maximumFractionDigits: 2 })} ${token.symbol}`; $('#priceImpact').textContent = `${Math.max(.12, amount / 1200).toFixed(2)}%`;
  $('#simulateLabel').textContent = `Simulate ${state.side}`; $('#simulateButton').classList.toggle('sell-mode', state.side === 'sell');
}

function renderPaper() {
  $('#paperCash').textContent = money(state.paper.cash); $('#paperPnl').textContent = `${state.paper.pnl >= 0 ? '+' : ''}${money(state.paper.pnl)}`; $('#paperPnl').style.color = state.paper.pnl >= 0 ? 'var(--lime)' : 'var(--red)';
  const entries = Object.entries(state.paper.positions); $('#positionCount').textContent = `${entries.length} open`;
  $('#positionsList').innerHTML = entries.length ? entries.map(([symbol, position]) => `<div class="position-row"><div><strong>${symbol}</strong><small>${position.quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })} units · ${money(position.cost)}</small></div><div class="position-pnl">${money(position.markValue - position.cost)}<small>paper PNL</small></div></div>`).join('') : '<div class="empty-position">No open positions<br /><span>模拟成交后显示在这里</span></div>';
}

function renderAll() { renderWatchlist(); renderMarket(); renderTrades(); renderPaper(); }

function tick() {
  if (state.paused) return;
  const now = Date.now(); const token = currentToken(); const move = (Math.random() - .47) * token.volatility; token.price = Math.max(token.price * (1 + move), Number.MIN_VALUE); token.change += move * 130; token.volume = compact(parseCompact(token.volume) * (1 + Math.abs(move) * .18));
  state.chart.push(50 + (token.change * .2) + Math.sin(now / 3700) * 6 + (Math.random() - .5) * 4); if (state.chart.length > 54) state.chart.shift();
  if (Math.random() > .58) { const buy = Math.random() > .27; const size = Math.round(320 + Math.random() * 5200); state.trades.unshift({ time: shortClock(), type: buy ? 'BUY' : 'SELL', price: tokenPrice(token), size: compact(size), wallet: `0x${Math.random().toString(16).slice(2, 4)}…${Math.random().toString(16).slice(2, 6)}` }); state.trades = state.trades.slice(0, 12); }
  state.lastTick = now; $('#latency').textContent = String(38 + Math.round(Math.random() * 44)); $('#clock').textContent = shortClock(); renderAll();
}

async function syncPaperBridge() {
  try {
    const response = await fetch('/api/paper-state', { cache: 'no-store' }); if (!response.ok) throw new Error('paper state unavailable'); const data = await response.json();
    if (data?.status === 'ok') { $('#sourceLabel').textContent = `paper-100 status bridge: ${data.updatedAt ? 'synced' : 'ready'}`; $('#paperStateLabel').textContent = 'synced'; }
  } catch { $('#sourceLabel').textContent = 'paper-100 status bridge: local-only'; $('#paperStateLabel').textContent = 'local'; }
}

function placePaperOrder() {
  const token = currentToken(); const amount = Number.parseFloat($('#amountInput').value); if (!Number.isFinite(amount) || amount <= 0) return toast('Enter a positive paper amount.');
  if (state.side === 'buy') { if (amount > state.paper.cash) return toast('Paper balance is too low for this order.'); state.paper.cash -= amount; const units = amount / token.price; const position = state.paper.positions[token.symbol] || { quantity: 0, cost: 0, markValue: 0 }; position.quantity += units; position.cost += amount; position.markValue = position.quantity * token.price; state.paper.positions[token.symbol] = position; toast(`SIM BUY · ${money(amount)} ${token.symbol} added to paper book`); }
  else { const position = state.paper.positions[token.symbol]; if (!position || position.quantity <= 0) return toast(`No ${token.symbol} position in paper book.`); const sellUnits = Math.min(position.quantity, amount / token.price); const proceeds = sellUnits * token.price; const costBasis = position.cost * (sellUnits / position.quantity); state.paper.cash += proceeds; state.paper.pnl += proceeds - costBasis; position.quantity -= sellUnits; position.cost -= costBasis; position.markValue = position.quantity * token.price; if (position.quantity < .00000001) delete state.paper.positions[token.symbol]; toast(`SIM SELL · ${money(proceeds)} ${token.symbol} removed from paper book`); }
  savePaper(); renderPaper(); updateQuote();
}

$$('.order-tab').forEach(button => button.addEventListener('click', () => { state.side = button.dataset.side; $$('.order-tab').forEach(item => item.classList.toggle('active', item === button)); updateQuote(); }));
$$('[data-amount]').forEach(button => button.addEventListener('click', () => { $('#amountInput').value = button.dataset.amount; updateQuote(); }));
$$('[data-slippage]').forEach(button => button.addEventListener('click', () => { state.slippage = Number(button.dataset.slippage); $$('[data-slippage]').forEach(item => item.classList.toggle('active', item === button)); updateQuote(); }));
$('#amountInput').addEventListener('input', updateQuote); $('#maxButton').addEventListener('click', () => { $('#amountInput').value = state.side === 'buy' ? state.paper.cash.toFixed(2) : (state.paper.positions[state.selected]?.markValue || 0).toFixed(2); updateQuote(); }); $('#simulateButton').addEventListener('click', placePaperOrder);
$('#tokenSearch').addEventListener('input', renderWatchlist); $('#pauseButton').addEventListener('click', () => { state.paused = !state.paused; $('#pauseButton').textContent = state.paused ? '▶' : 'Ⅱ'; $('#pauseButton').classList.toggle('active', state.paused); $('#streamLabel').textContent = state.paused ? 'STREAM PAUSED' : 'SYNTHETIC FEED'; toast(state.paused ? 'Synthetic stream paused.' : 'Synthetic stream resumed.'); });
$('#resetPaper').addEventListener('click', () => { state.paper = { cash: PAPER_START, pnl: 0, positions: {} }; savePaper(); renderPaper(); toast('Paper account reset to $100.00.'); }); $('#copyButton').addEventListener('click', async () => { try { await navigator.clipboard.writeText(currentToken().address); toast('Synthetic contract label copied.'); } catch { toast('Clipboard unavailable in this browser.'); } });
$$('.chart-tab').forEach(button => button.addEventListener('click', () => { state.tab = button.dataset.tab; $$('.chart-tab').forEach(item => item.classList.toggle('active', item === button)); updateChart(); }));
$('#chainButton').addEventListener('click', () => { const chains = ['BSC', 'BASE', 'ETH']; state.chain = chains[(chains.indexOf(state.chain) + 1) % chains.length]; $('#chainLabel').textContent = state.chain; toast(`Chain filter: ${state.chain} · synthetic feed`); });
$('#crosshair').addEventListener('mousemove', event => { const bounds = event.currentTarget.parentElement.getBoundingClientRect(); event.currentTarget.style.left = `${event.clientX - bounds.left}px`; });
document.addEventListener('keydown', event => { if (event.key === '/' && document.activeElement !== $('#tokenSearch')) { event.preventDefault(); $('#tokenSearch').focus(); } });

renderAll(); $('#clock').textContent = shortClock(); setInterval(tick, 1200); setInterval(syncPaperBridge, 10000); syncPaperBridge();
