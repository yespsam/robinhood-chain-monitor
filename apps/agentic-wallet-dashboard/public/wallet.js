import { PHASES, STAGES, activePhases, diagnosticText, safeDiagnosticExport } from './connection-state.js';
import { AUTH_URL_ISSUES } from './official-error-catalog.js';
import { renderAuthQr } from './auth-qr.js';
import { readLocalSession, saveLocalSession, clearLocalSession } from './session-recovery.js';
const $ = id => document.getElementById(id);
// The launch capability is transient. Never persist it, display it, or send it to external origins.
const accessMatch = /^#access=([a-f0-9]{64})$/.exec(location.hash);
const localAccessKey = accessMatch?.[1] || null;
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
let token = null, state = null, epoch = 0, pollTimer, expiryTimer, pollBusy = false, readVersion = 0;
let connectBusy = false, pollController = null, lastDiagnostic = null, cooldownTimer, cliVersions = {};
let authQrVersion = 0, authExpiryTimer;
let restoreBusy = false, restoreRetryNeeded = false, suspended = false, sessionExpiresAt = 0;
const readControllers = new Set();
const abortablePaths = new Set(['/api/local/session', '/api/local/state', '/api/wallet/check', '/api/wallet/read', '/api/wallet/quote', '/api/trade/preview', '/api/trade/list', '/api/trade/status']);
let quoteBusy = false, quoteVersion = 0, displayedIntentId = null;
let tradeReview = null, tradeTimer, reviewTimer, tradeSubmitting = false, trackedIntentId = null, tradePollBusy = false, trades = [];
let currentView = 'overview', assetTab = 'tokens', assetSnapshot = null, portfolioSnapshot = null, mergedAssets = [], readBusy = false;
const launchMessage = '请通过本机启动器打开看板：双击“打开钱包.command”，或在项目目录运行 npm run open。';
const messages = {
  LOCAL_ACCESS_REQUIRED: launchMessage,
  TRADE_REVIEW_EXPIRED: '报价审阅已过期，请重新获取报价。',
  UNKNOWN_TRADE_REVIEW: '本次审阅已失效，请重新获取报价。',
  TRADE_QUOTE_CHANGED_REVIEW_REQUIRED: '最新报价已变化，尚未提交，请重新获取报价并核对。',
  TOKEN_AUDIT_CHANGED_REVIEW_REQUIRED: '风险检查结果发生变化，尚未提交，请重新审阅。',
  TOKEN_RISK_BLOCKED: '代币风险检查已拦截，不能提交这笔交易。',
  UNRESOLVED_TRADE_EXISTS: '已有一笔交易结果待核验，请先查询该笔状态。',
  INSUFFICIENT_TRADE_BALANCE: '支付代币余额不足，请调整数量。',
  INSUFFICIENT_GAS_RESERVE: '需保留足够 BNB 支付网络费用，请减少数量或补足燃料。',
  WALLET_TRANSACTION_LOCKED: '官方钱包交易暂时锁定，请检查币安 App。',
  LOCAL_SESSION_EXPIRED: '本页短期会话已过期，请通过本机启动器重新打开。',
  WALLET_NOT_BOUND: '请先在 Binance App 核对钱包地址并绑定。',
  WALLET_AUTH_INVALID: '官方钱包尚未连接或授权已失效，请重新连接。',
  WALLET_AUTH_EXPIRED: '官方钱包授权已过期，请重新连接。',
  WALLET_IDENTITY_MISMATCH: '钱包地址发生变化，已断开本页，请重新核对地址。',
  AUTH_IN_PROGRESS: '官方验证正在进行，请等待完成或超时后重试。',
  AUTH_RATE_LIMIT: '请稍等片刻再生成新的配对码。',
  INVALID_AMOUNT: '请输入正十进制数量，并明确填写滑点。',
  INVALID_CONTRACT: '请填写该网络的完整有效合约地址。',
  INVALID_SLIPPAGE: '滑点必须在 0–100% 范围内。',
  LIMIT_CHAIN_UNSUPPORTED: '官方限价挂单查询仅支持 BSC / Solana。',
  APPROVALS_EVM_ONLY: '此授权查询仅适用于 EVM 网络。'
};
const el = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = String(text); if (className) node.className = className; return node; };
const shortAddress = value => typeof value === 'string' && value.length > 20 ? value.slice(0, 6) + '…' + value.slice(-4) : value || '未返回';
const timestamp = value => typeof value === 'number' ? value : typeof value === 'string' && /^\d{13}$/.test(value) ? Number(value) : Date.parse(value);
const localTime = value => { const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '时间未返回'; };
function numberText(value, maximumFractionDigits = 6) { if (value === null || value === undefined || value === '') return '—'; const n = Number(value); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits }) : '—'; }
function usdText(value) { return value === null || value === undefined ? '暂无估值' : '$' + numberText(value, 2); }
function decimalUnits(value) { if (typeof value !== 'string' || !/^\d+(\.\d+)?$/.test(value)) return null; const [whole, fraction = ''] = value.split('.'); return BigInt(whole) * 10n ** 18n + BigInt(fraction.slice(0, 18).padEnd(18, '0')); }
function unitsText(value) { return (value / 10n ** 18n).toString() + '.' + (value % 10n ** 18n).toString().padStart(18, '0'); }
function priceValue(balance, price) { const a = decimalUnits(balance), b = decimalUnits(price); return a === null || b === null ? null : unitsText(a * b / 10n ** 18n); }
function setReadMessage(message, error = false) { $('live-read-message').textContent = message; $('live-read-message').closest('.data-status').classList.toggle('error', error); }
function emptyState(target, title, description) { const box = el('div', undefined, 'empty-state'); box.append(el('span', '◇', 'empty-symbol'), el('strong', title), el('p', description)); $(target).replaceChildren(box); }
function skeleton(target) { const table = el('table', undefined, 'skeleton-table'); const body = el('tbody'); for (let row = 0; row < 3; row++) { const tr = el('tr'); for (let col = 0; col < 3; col++) { const td = el('td'); td.append(el('div', undefined, 'skeleton-line')); if (col === 0) td.append(el('div', undefined, 'skeleton-line')); tr.append(td); } body.append(tr); } table.append(body); $(target).replaceChildren(table); }
async function api(path, body = {}, signal, { preserveOnAuthFailure = false } = {}) {
  const requestEpoch = epoch, requestToken = token;
  const isCurrentRequest = () => requestEpoch === epoch && requestToken === token;
  const controller = !signal && abortablePaths.has(path) ? new AbortController() : null;
  if (controller) { signal = controller.signal; readControllers.add(controller); }
  try {
    let response, data;
    try { response = await fetch(path, { method: 'POST', credentials: 'omit', cache: 'no-store', signal,
      headers: { 'Content-Type': 'application/json', ...(requestToken ? { 'X-Local-Session': requestToken } : {}), ...(path === '/api/local/session' && localAccessKey ? { 'X-Local-Access': localAccessKey } : {}) }, body: JSON.stringify(body) }); }
    catch (error) { if (error.name === 'AbortError') throw error; if (isCurrentRequest()) lastDiagnostic = { code: 'LOCAL_SERVICE_UNAVAILABLE', category: 'LOCAL_HTTP', stage: 'HTTP', at: new Date().toISOString() }; throw Error('无法连接本机服务，可恢复网络后重试；官方会话未退出。'); }
    try { data = await response.json(); }
    catch (error) { if (error.name === 'AbortError') throw error; if (isCurrentRequest()) lastDiagnostic = { code: 'LOCAL_RESPONSE_PARSE_FAILED', category: 'PARSE', stage: 'HTTP', at: new Date().toISOString() }; throw Error('本机接口返回格式异常，未能核对连接状态。'); }
    if (!response.ok) {
      if (isCurrentRequest()) lastDiagnostic = data.diagnostic || { code: 'INTERNAL_ERROR', category: 'LOCAL_FLOW', stage: 'LOCAL' };
      const message = messages[data.error] || describeDiagnostic(data.diagnostic) || '请求未完成，请在连接设置中查看诊断。';
      const authenticationLost = response.status === 401 || ['WALLET_AUTH_INVALID', 'WALLET_AUTH_EXPIRED', 'WALLET_IDENTITY_MISMATCH', 'WALLET_BINDING_CHANGED'].includes(data.error);
      if (authenticationLost && isCurrentRequest()) {
        clearLocalSession();
        if (preserveOnAuthFailure) { token = null; state = null; sessionExpiresAt = 0; }
        else wipe(message);
      }
      const error = Error(message); error.code = data.error; error.authenticationLost = authenticationLost; throw error;
    }
    return data;
  } finally { if (controller) readControllers.delete(controller); }
}
function describeDiagnostic(d) {
  if (!d) return '';
  const safe = safeDiagnosticExport(d);
  const identity = [safe.officialName, safe.officialCode !== undefined ? String(safe.officialCode) : null].filter(Boolean).join(' / ');
  const signals = [...(safe.connectionSignals || []), ...(safe.httpStatus ? ['HTTP ' + safe.httpStatus] : [])].join(', ');
  const urlIssues = safe.authUrlIssues?.map(x => AUTH_URL_ISSUES[x]).join('、');
  return `${STAGES[d.stage] || '本地流程'}：${d.message || '请求失败。'}${identity ? ' 官方错误：' + identity + '。' : ''}${signals ? ' 连接标识：' + signals + '。' : ''}${urlIssues ? ' 拦截原因：' + urlIssues + '。' : ''} ${d.nextStep || ''}`;
}
function clearAuthQr({ forgetPayload = true } = {}) {
  authQrVersion++; clearTimeout(authExpiryTimer);
  for (const id of ['auth-qr', 'top-auth-qr']) { const canvas = $(id); canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height); canvas.width = 1; canvas.height = 1; canvas.hidden = true; }
  for (const id of ['wallet-auth', 'top-wallet-auth']) $(id).hidden = true;
  for (const id of ['pairing-code', 'top-pairing-code', 'auth-expiry', 'top-auth-expiry', 'auth-qr-status', 'top-auth-qr-status']) $(id).textContent = '';
  for (const id of ['official-auth-link', 'top-official-auth-link']) $(id).removeAttribute('href');
  if (forgetPayload && state) { delete state.urlForWeb; delete state.pairingCode; }
}
function authExpiredMessage() {
  const message = '二维码已过期并已清除，等待本次核验结束后重新获取。';
  for (const id of ['wallet-badge', 'top-wallet-state']) $(id).textContent = '二维码已过期';
  $('top-wallet-message').textContent = message; $('wallet-message').textContent = message;
}
function showAuthQr(v) {
  const urlForWeb = v.urlForWeb, expiresAt = timestamp(v.authExpiresAt), pairingCode = v.pairingCode;
  clearAuthQr({ forgetPayload: false });
  const version = authQrVersion, current = epoch;
  for (const id of ['wallet-auth', 'top-wallet-auth']) $(id).hidden = false;
  for (const id of ['pairing-code', 'top-pairing-code']) $(id).textContent = typeof pairingCode === 'string' ? pairingCode : '';
  for (const id of ['official-auth-link', 'top-official-auth-link']) $(id).href = urlForWeb;
  for (const id of ['auth-qr-status', 'top-auth-qr-status']) $(id).textContent = '正在本机生成二维码…';
  const stillCurrent = () => current === epoch && version === authQrVersion && state?.phase === 'WAITING' && Date.now() < expiresAt;
  const countdown = () => {
    if (current !== epoch || version !== authQrVersion) return;
    const remaining = Math.max(0, expiresAt - Date.now());
    if (!remaining) { clearAuthQr(); authExpiredMessage(); return; }
    const seconds = Math.ceil(remaining / 1000), minutes = Math.floor(seconds / 60);
    const label = `剩余 ${minutes}:${String(seconds % 60).padStart(2, '0')} · ${localTime(expiresAt)} 到期`;
    for (const id of ['auth-expiry', 'top-auth-expiry']) $(id).textContent = label;
    authExpiryTimer = setTimeout(countdown, Math.min(1000, remaining));
  };
  countdown();
  const offscreen = document.createElement('canvas'); offscreen.width = 1; offscreen.height = 1;
  // Keep the full official payload untouched. No remote QR service, storage, or URL rewrite.
  Promise.resolve().then(() => renderAuthQr(offscreen, urlForWeb)).then(result => {
    if (!stillCurrent()) return;
    if (result === false || offscreen.width < 2 || offscreen.height < 2) throw Error('QR_RENDER_FAILED');
    for (const id of ['auth-qr', 'top-auth-qr']) { const canvas = $(id); canvas.width = offscreen.width; canvas.height = offscreen.height; canvas.getContext('2d').drawImage(offscreen, 0, 0); canvas.hidden = false; }
    for (const id of ['auth-qr-status', 'top-auth-qr-status']) $(id).textContent = '';
  }).catch(() => {
    if (!stillCurrent()) return;
    for (const id of ['auth-qr-status', 'top-auth-qr-status']) $(id).textContent = '二维码未能生成，请打开官方授权页继续。';
  }).finally(() => { offscreen.getContext('2d')?.clearRect(0, 0, offscreen.width, offscreen.height); offscreen.width = 1; offscreen.height = 1; });
}
function connectionControls(v, message) {
  clearTimeout(cooldownTimer);
  const phase = v?.phase || 'DISCONNECTED', active = activePhases.includes(phase);
  const remaining = phase === 'DISCONNECTED' && Number.isSafeInteger(v?.nextSignInAt) ? Math.max(0, v.nextSignInAt - Date.now()) : 0;
  for (const name of ['wallet-badge', 'top-wallet-state']) $(name).textContent = PHASES[phase] || PHASES.DISCONNECTED;
  for (const name of ['connect-wallet', 'top-connect-wallet']) {
    $(name).disabled = !(token || localAccessKey) || restoreBusy || suspended || connectBusy || active || phase === 'CONNECTED' || remaining > 0;
    $(name).textContent = restoreBusy ? '正在恢复连接…' : suspended ? '等待恢复连接' : restoreRetryNeeded ? '重试恢复连接' : !(token || localAccessKey) ? '请使用本机启动器' : phase === 'CONNECTED' ? '钱包已连接' : remaining > 0 ? `稍候 ${Math.ceil(remaining / 1000)} 秒` : phase === 'REVIEW' ? '核对钱包地址' : ['FAILED', 'TIMEOUT', 'PAUSED'].includes(phase) || v?.requiresStatusCheck ? '核对状态后重试' : '扫码登录';
  }
  if (remaining > 0) cooldownTimer = setTimeout(() => connectionControls(v, message), Math.min(1000, remaining));
  $('top-wallet-message').textContent = message || ''; $('wallet-message').textContent = message || '';
  const authExpiry = timestamp(v?.authExpiresAt), expired = v?.authQrExpired === true || (Number.isFinite(authExpiry) && authExpiry <= Date.now());
  const showAuth = phase === 'WAITING' && typeof v?.urlForWeb === 'string' && v.urlForWeb.length > 0 && Number.isFinite(authExpiry) && !expired;
  if (showAuth) showAuthQr(v); else clearAuthQr();
  $('stop-wallet-wait').hidden = !active; $('stop-wallet-wait').disabled = v?.stage === 'BIND'; $('drawer-stop-wallet-wait').disabled = v?.stage === 'BIND';
  if (expired && phase === 'WAITING') authExpiredMessage();
  else if (phase === 'WAITING' && !showAuth) { $('top-wallet-message').textContent = '官方登录信息或有效期尚未确认，暂不展示二维码。'; $('wallet-message').textContent = $('top-wallet-message').textContent; }

}
function clearBalances() {
  assetSnapshot = null; portfolioSnapshot = null; mergedAssets = [];
  for (const id of ['known-value', 'bnb-balance', 'usdt-balance', 'ptah-balance', 'holdings-count', 'nft-count']) $(id).textContent = '—';
  $('relic-balance').replaceChildren(document.createTextNode('—'), el('small', '张')); $('loom-balance').replaceChildren(document.createTextNode('—'), el('small', '台'));
  $('valuation-note').textContent = '尚未读取真实资产；暂无估值。';
  $('bnb-value').textContent = '等待链上查询'; $('usdt-value').textContent = '等待链上查询';
  $('ptah-note').textContent = '连接后核验合约余额。NFT 未计入上方估值。';
  $('last-updated').textContent = '尚未刷新';
  $('asset-coverage').textContent = '资产按网络与合约识别。未查询的余额不会按零显示。';
  emptyState('asset-table', '等待钱包数据', '连接并核对地址后，读取真实持仓。');
}
function clearPrivateData() {
  clearAuthQr();
  clearTradeUI();
  readVersion++; readBusy = false; clearBalances(); emptyState('live-table', '暂无已读取的记录', '连接钱包后刷新当前列表。');
  $('live-review-details').replaceChildren(); $('live-review-blockers').replaceChildren(); if ($('live-review').open) $('live-review').close();
  $('candidate-addresses').replaceChildren(); $('live-address').textContent = '尚未绑定'; $('copy-wallet-address').disabled = true; $('copy-address-message').textContent = '';
  $('read-wallet').classList.remove('loading'); document.body.classList.remove('wallet-connected');
}
function stopLocalWork() {
  clearTimeout(pollTimer); clearTimeout(expiryTimer); clearTimeout(cooldownTimer);
  pollController?.abort(); for (const controller of readControllers) controller.abort(); readControllers.clear();
  pollBusy = false; tradePollBusy = false;
}
function wipe(message = '本页已断开，官方 CLI 会话保持不变。', { preserveSession = false } = {}) {
  epoch++; state = null; connectBusy = false; restoreBusy = false; restoreRetryNeeded = false; stopLocalWork();
  if (!preserveSession) { token = null; sessionExpiresAt = 0; clearLocalSession(); suspended = false; }
  clearPrivateData();
  $('wallet-candidate').hidden = true; $('read-permission').textContent = '待绑定'; $('wallet-notice').textContent = '连接本机钱包'; $('live-data-badge').textContent = '等待连接';
  $('global-state').textContent = '本机直开 · 钱包待连接'; $('confirm-wallet-address').checked = false;
  for (const name of ['lock-wallet', 'signout-wallet', 'bind-wallet', 'read-wallet', 'live-chain', 'live-quote-button']) $(name).disabled = true;
  $('live-chain').replaceChildren(el('option', '等待连接'));
  for (const name of ['live-from', 'live-to', 'live-amount', 'live-slippage', 'asset-search']) $(name).value = '';
  $('live-quote-message').textContent = '请先连接并核对钱包。'; $('quote-chain-label').textContent = '等待连接'; setReadMessage(message);
  connectionControls({ phase: 'DISCONNECTED' }, message);
}
function suspendSession(message = '页面已暂停，返回后将恢复连接。') {
  suspended = true; wipe(message, { preserveSession: true });
}
function rememberSession(expiresAt) {
  const value = timestamp(expiresAt);
  if (token && Number.isFinite(value)) { sessionExpiresAt = value; saveLocalSession(token, value); }
}
async function restoreSession() {
  if (restoreBusy) return;
  if (navigator.onLine === false) { suspendSession('网络已离线，恢复网络后将重新读取连接状态。'); return; }
  const saved = readLocalSession();
  if (saved) { token = saved.token; sessionExpiresAt = saved.expiresAt; }
  else if (!(token && sessionExpiresAt > Date.now())) { token = null; sessionExpiresAt = 0; }
  suspended = false; restoreBusy = true; restoreRetryNeeded = false; const current = ++epoch; stopLocalWork(); state = null; clearPrivateData();
  connectionControls({ phase: 'CHECKING', stage: 'STATUS' }, '正在恢复本页连接，不会重新扫码或提交交易。');
  $('wallet-notice').textContent = '正在恢复钱包连接'; setReadMessage('正在核对已保存的本页短期会话…');
  try {
    let value;
    if (token) {
      try { value = await api('/api/local/state', {}, undefined, { preserveOnAuthFailure: true }); }
      catch (error) { if (!error.authenticationLost) throw error; }
      if (current !== epoch) return;
    }
    if (!value) {
      if (!localAccessKey) { restoreBusy = false; wipe(launchMessage); return; }
      await session(); if (current !== epoch) return;
      value = await api('/api/local/state'); if (current !== epoch) return;
    }
    // A recovery check never starts a new official signin, repeats a binding, or submits a trade.
    if (value.phase === 'DISCONNECTED' && !value.operationPending) {
      value = await api('/api/wallet/check'); if (current !== epoch) return;
    }
    restoreBusy = false; render(value);
    if (!value.walletConnected) setReadMessage(value.phase === 'WAITING' ? '已恢复原扫码流程，继续等待同一次 App 确认。' : value.phase === 'REVIEW' ? '已恢复待核对的钱包地址，确认后读取资产。' : '已恢复本页会话，钱包状态已核对。');
  } catch (error) {
    if (current === epoch && error.name !== 'AbortError') { restoreBusy = false; showFailure(error.message); }
  } finally { if (current === epoch) restoreBusy = false; }
}
function showFailure(message) {
  if (state?.walletConnected) wipe(message, { preserveSession: true });
  restoreRetryNeeded = !!(token || localAccessKey);
  clearTimeout(pollTimer); pollController?.abort(); clearPrivateData(); $('wallet-candidate').hidden = true;
  for (const name of ['bind-wallet', 'read-wallet', 'live-chain', 'live-quote-button']) $(name).disabled = true;
  state = { ...state, walletConnected: false, phase: lastDiagnostic?.category === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED', stage: lastDiagnostic?.stage || 'LOCAL', diagnostic: lastDiagnostic, requiresStatusCheck: true };
  connectionControls(state, message); setReadMessage(message, true);
}
async function session() { if (!token) { if (!localAccessKey) throw Error(launchMessage); const current = epoch, v = await api('/api/local/session'); if (current !== epoch) throw Error('本页连接请求已取消。'); token = v.token; rememberSession(v.expiresAt); } }
function render(v) {
  const wasConnected = !!state?.walletConnected, wasReview = state?.phase === 'REVIEW', wasWaiting = state?.phase === 'WAITING'; state = v;
  clearTimeout(expiryTimer);
  const expiresAt = Math.min(timestamp(v.expiresAt), v.walletExpiresAt ? timestamp(v.walletExpiresAt) : Infinity);
  rememberSession(expiresAt);
  if (Number.isFinite(expiresAt)) expiryTimer = setTimeout(() => lock('本页连接或官方授权到期，请重新连接。'), Math.max(0, expiresAt - Date.now()));
  const connected = v.walletConnected;
  $('refresh-trades').disabled = !connected;
  document.body.classList.toggle('wallet-connected', !!connected);
  $('lock-wallet').disabled = false; $('signout-wallet').disabled = !connected;
  $('wallet-candidate').hidden = v.phase !== 'REVIEW';
  if (v.phase === 'REVIEW') {
    $('candidate-note').textContent = v.alreadyConnected ? '已发现本机 CLI 会话。请在 Binance App 核对完整地址后，将它绑定到本页。' : '官方连接已验证。核对完整地址后，本页即可读取资产。';
    $('candidate-addresses').replaceChildren(...v.addresses.map(a => { const div = el('div'); div.append(el('span', v.chains.find(c => c.id === a.chainId)?.name || a.chainId), el('code', a.address)); return div; }));
    $('bind-wallet').disabled = !$('confirm-wallet-address').checked;
    if (!wasReview) document.dispatchEvent(new CustomEvent('wallet:show-settings'));
  } else $('candidate-addresses').replaceChildren();
  if (v.diagnostic) lastDiagnostic = v.diagnostic;
  const message = connected ? '钱包地址已核对，可读取资产并逐笔确认 BSC 兑换。' : v.diagnostic ? describeDiagnostic(v.diagnostic)
    : v.phase === 'WAITING' ? '用币安 App 扫描下方二维码，核对配对码并确认。二维码到期后会自动清除。'
    : v.phase === 'REVIEW' ? '已找到官方钱包会话，请在连接设置中核对地址。'
    : v.phase === 'PAUSED' ? '本页等待已停止，远端授权未撤销。核验结束后可重查状态。'
    : activePhases.includes(v.phase) ? `正在${STAGES[v.stage] || '核验'}…`
    : '用币安 App 扫码登录；本机已有会话会直接复用。';
  connectionControls(v, message);
  if (v.phase === 'WAITING' && !wasWaiting && !$('wallet-auth').hidden) document.dispatchEvent(new CustomEvent('wallet:show-settings'));
  $('read-permission').textContent = connected ? '已绑定' : '待绑定'; $('wallet-notice').textContent = connected ? '我的 Agentic Wallet' : '连接本机钱包';
  $('global-state').textContent = connected ? '真实钱包 · 手动交易逐笔确认' : '本机直开 · 钱包待连接';
  for (const name of ['live-chain', 'read-wallet', 'live-quote-button']) $(name).disabled = !connected || (name === 'read-wallet' && readBusy) || (name === 'live-quote-button' && (tradeSubmitting || hasOpenTrade()));
  if (connected && !wasConnected) {
    $('live-chain').replaceChildren(...v.chains.map(c => { const o = el('option', c.name); o.value = c.id; return o; }));
    if (v.chains.some(c => c.id === '56')) $('live-chain').value = '56';
    changeChain(false); $('live-data-badge').textContent = '已绑定 · 待读取'; document.dispatchEvent(new CustomEvent('wallet:bound')); void refreshCurrent(); void loadTrades();
  }
  if (connected && !wasConnected) $('live-quote-message').textContent = '先获取报价并核对信息，点击确认交易后才会提交。';
  clearTimeout(pollTimer);
  if (!['FAILED', 'TIMEOUT', 'PAUSED', 'DISCONNECTED'].includes(v.phase)) pollTimer = setTimeout(poll, connected ? 60_000 : 1500);
}
async function poll() {
  if (!token || pollBusy) return; const current = epoch; pollBusy = true; const controller = new AbortController(); pollController = controller;
  try { const v = await api('/api/local/state', {}, controller.signal); if (current === epoch && !controller.signal.aborted) render(v); }
  catch (error) { if (current === epoch && error.name !== 'AbortError') showFailure(error.message); }
  finally { pollBusy = false; }
}
async function lock(message) {
  const previous = token; wipe(message);
  if (previous) try { await fetch('/api/local/lock', { method: 'POST', credentials: 'omit', keepalive: true, headers: { 'Content-Type': 'application/json', 'X-Local-Session': previous }, body: '{}' }); } catch { /* Browser capability was discarded; server expires independently. */ }
}
function changeChain(refresh = true) {
  invalidateReview();
  readVersion++; readBusy = false; clearBalances(); emptyState('live-table', '等待查询', '刷新以获取该网络的交易记录。');
  if ($('live-review').open) $('live-review').close();
  const chain = $('live-chain').value, address = state?.addresses?.find(a => a.chainId === chain)?.address;
  $('live-address').textContent = address || '地址未核验'; $('copy-wallet-address').disabled = !address;
  $('copy-address-message').textContent = ''; $('quote-chain-label').textContent = state?.chains?.find(c => c.id === chain)?.name || chain;
  // Public token identifiers from the official BSC common token table, never wallet identifiers.
  $('live-from').value = chain === '56' ? '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' : '';
  $('live-to').value = chain === '56' ? '0x55d398326f99059fF775485246999027B3197955' : '';
  $('from-preset').value = chain === '56' ? 'BNB' : 'custom'; $('to-preset').value = chain === '56' ? 'USDT' : 'custom';
  $('from-preset').disabled = chain !== '56'; $('to-preset').disabled = chain !== '56';
  $('live-quote-message').textContent = chain === '56' ? '获取报价后逐笔确认；不会自动交易。' : '此网络仅提供报价预览，手动交易暂仅支持 BSC。';
  if (chain !== '56') $('ptah-note').textContent = 'PTAH 持仓仅在 BNB Smart Chain 上查询。';
  setReadMessage('网络已切换，待读取真实数据。'); if (refresh) void refreshCurrent();
}
function makeTable(headers, rows, target = 'live-table', numeric = []) {
  const t = el('table'), head = el('tr'), thead = el('thead'), body = el('tbody');
  headers.forEach((text, i) => head.append(el('th', text, numeric.includes(i) ? 'number' : ''))); thead.append(head); t.append(thead, body);
  rows.forEach(row => { const tr = el('tr'); row.forEach((value, i) => { const td = el('td', undefined, numeric.includes(i) ? 'number' : ''); if (value instanceof Node) td.append(value); else td.textContent = value ?? '未返回'; tr.append(td); }); body.append(tr); });
  if (!rows.length) { const tr = el('tr'), td = el('td', '未返回匹配记录；不能据此认定余额为零。', 'muted'); td.colSpan = headers.length; tr.append(td); body.append(tr); }
  $(target).replaceChildren(t);
}
function assetCell(asset) {
  const div = el('div', undefined, 'asset-cell'), icon = el('span', (asset.symbol || '?').slice(0, 1), 'coin-icon ' + (asset.symbol === 'BNB' ? 'bnb' : ''));
  const label = el('div'), contract = el('small', shortAddress(asset.contract)); contract.title = asset.contract || '';
  label.append(el('strong', asset.symbol || asset.name || '未命名代币'), contract); div.append(icon, label); return div;
}
function renderHoldings() {
  const search = $('asset-search').value.trim().toLowerCase();
  const all = assetTab === 'tokens' ? mergedAssets : portfolioSnapshot?.nfts || [];
  if (!all.length) { emptyState('asset-table', assetTab === 'nfts' && $('live-chain').value !== '56' ? 'PTAH 资产位于 BSC' : '暂无已读取的资产', assetTab === 'nfts' ? '选择 BNB Smart Chain 后刷新 NFT 持仓。' : '刷新以读取当前钱包余额。'); return; }
  const rows = all.filter(a => [a.symbol, a.name, a.contract].some(v => v?.toLowerCase().includes(search)));
  if (assetTab === 'tokens') makeTable(['资产', '余额', '估值 · USD'], rows.map(a => { const amount = el('span', a.balance === null ? '查询未完成' : numberText(a.balance)); amount.title = a.balance ?? ''; return [assetCell(a), amount, usdText(a.valueUsd)]; }), 'asset-table', [1, 2]);
  else makeTable(['资产', '链上数量', '估值'], rows.map(a => [assetCell(a), a.quantity === null ? '查询未完成' : numberText(a.quantity, 0), '暂无估值']), 'asset-table', [1, 2]);
}
function renderAssets() {
  const official = assetSnapshot?.assets || [], map = new Map(official.map(a => [a.contract?.toLowerCase(), { ...a }]));
  for (const direct of portfolioSnapshot?.assets || []) {
    const previous = map.get(direct.contract?.toLowerCase());
    map.set(direct.contract?.toLowerCase(), { ...previous, ...direct, priceUsd: previous?.priceUsd ?? null, valueUsd: priceValue(direct.balance, previous?.priceUsd) });
  }
  mergedAssets = [...map.values()];
  let known = 0n, priced = 0;
  for (const asset of mergedAssets) { const value = decimalUnits(asset.valueUsd); if (value !== null) { known += value; priced++; } }
  $('known-value').textContent = priced ? '$' + numberText(unitsText(known), 2) : '—';
  const unknown = mergedAssets.length - priced;
  $('valuation-note').textContent = priced ? `部分估值 · ${unknown ? unknown + ' 项代币未计价；' : ''}NFT 未计入。价格来自官方 CLI。` : '暂无可靠价格，余额已单独展示；未计价资产不会按零估值。';
  $('holdings-count').textContent = String(mergedAssets.length);
  for (const [symbol, id] of [['BNB', 'bnb'], ['USDT', 'usdt']]) {
    const asset = mergedAssets.find(a => a.symbol === symbol && (a.chainId || $('live-chain').value) === $('live-chain').value);
    $(id + '-balance').textContent = asset ? numberText(asset.balance, symbol === 'BNB' ? 6 : 4) : '—';
    $(id + '-balance').title = asset?.balance || '';
    $(id + '-value').textContent = asset ? usdText(asset.valueUsd) : '官方未返回该资产';
  }
  const nftRows = portfolioSnapshot?.nfts || [], relic = nftRows.find(a => a.symbol === 'RELIC'), loom = nftRows.find(a => a.symbol === 'LOOM');
  $('relic-balance').replaceChildren(document.createTextNode(numberText(relic?.quantity, 0)), el('small', '张'));
  $('loom-balance').replaceChildren(document.createTextNode(numberText(loom?.quantity, 0)), el('small', '台'));
  const nftComplete = nftRows.length > 0 && nftRows.every(a => a.quantity !== null && /^\d+$/.test(a.quantity));
  $('nft-count').textContent = nftComplete ? nftRows.reduce((sum, a) => sum + BigInt(a.quantity), 0n).toString() : '—';
  $('ptah-balance').textContent = numberText(mergedAssets.find(a => a.symbol === 'PTAH')?.balance, 4);
  const mining = portfolioSnapshot?.mining;
  $('ptah-note').textContent = $('live-chain').value !== '56' ? 'PTAH 持仓仅在 BNB Smart Chain 上查询。' : mining?.status === 'ok' ? `矿机权重 ${mining.weight ?? '未返回'} · ${mining.emissionStarted === false ? '挖矿尚未启动' : mining.emissionStarted === true ? '挖矿已启动' : '挖矿状态未确认'} · 可领 ${numberText(mining.claimable, 4)} PTAH` : '材料与矿机为链上数量；未计入资产估值。挖矿状态尚未完整核验。';
  $('asset-coverage').textContent = portfolioSnapshot?.coverage || assetSnapshot?.coverage || '余额未完整返回，空值不代表零持仓。';
  renderHoldings();
}
const statusLabel = s => ({ PENDING: '处理中', FINISHED: '官方报告已执行', FAILED: '失败', WORKING: '等待触发', TRIGGERED: '已触发', confirmed: '链上已确认', pending: '待处理', CANCELED: '已取消', EXPIRED: '已过期' })[s] || s || '状态未确认';
const typeLabel = s => ({ send: '发送', receive: '接收', swap: '兑换', approve: '授权', SEND: '发送', RECEIVE: '接收', SWAP: '兑换', APPROVE: '授权', contractInteraction: '合约交互' })[s] || s || '未知类型';
function txLink(hash) { const chain = $('live-chain').value, bases = { '56': 'https://bscscan.com/tx/', '1': 'https://etherscan.io/tx/', '8453': 'https://basescan.org/tx/' }; if (!bases[chain] || typeof hash !== 'string' || !/^0x[a-fA-F0-9]{64}$/.test(hash)) return shortAddress(hash); const link = el('a', shortAddress(hash), 'mono'); link.href = bases[chain] + hash; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.title = hash; return link; }
async function refreshCurrent() {
  if (!state?.walletConnected || readBusy || currentView === 'quote') return;
  const current = epoch, version = ++readVersion, chainId = $('live-chain').value, view = currentView;
  readBusy = true; $('read-wallet').disabled = true; $('read-wallet').classList.add('loading');
  setReadMessage('正在核验钱包身份并刷新数据…'); $('live-data-badge').textContent = '刷新中';
  if (view === 'overview') skeleton('asset-table'); else skeleton('live-table');
  try {
    if (view === 'overview') {
      const requests = [api('/api/wallet/read', { chainId, kind: 'assets' })];
      if (chainId === '56') requests.push(api('/api/wallet/read', { chainId, kind: 'portfolio' }));
      const results = await Promise.allSettled(requests); if (current !== epoch || version !== readVersion) return;
      assetSnapshot = results[0].status === 'fulfilled' ? results[0].value : null;
      portfolioSnapshot = results[1]?.status === 'fulfilled' ? results[1].value : null;
      renderAssets();
      const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
      const partial = errors.length > 0 || (portfolioSnapshot && portfolioSnapshot.status !== 'ok');
      $('live-data-badge').textContent = partial ? '部分数据未更新' : '真实数据';
      $('last-updated').textContent = localTime(portfolioSnapshot?.observedAt || assetSnapshot?.assets?.[0]?.observedAt || new Date().toISOString());
      const chainInfo = portfolioSnapshot?.block?.number ? `链上区块 ${portfolioSnapshot.block.number}。` : '';
      setReadMessage(errors.length ? errors.join(' ') : partial ? '部分链上查询未完成，失败项目显示为空。可稍后刷新。' : `已刷新真实余额。${chainInfo}资产估值不代表完整净值。`, partial);
    } else {
      const kind = $('live-kind').value, data = await api('/api/wallet/read', { chainId, kind });
      if (current !== epoch || version !== readVersion) return;
      if (['transactions', 'pending'].includes(kind)) makeTable(['类型', '状态', '时间 · 北京', '交易凭证'], (data.transactions || []).map(x => [typeLabel(x.type), statusLabel(x.status), localTime(x.time), txLink(x.txHash)]));
      else if (kind === 'approvals') makeTable(['代币', '合约', 'Spender', '授权数量'], data.map(x => [x.symbol, shortAddress(x.contract), shortAddress(x.spender), x.amount]));
      else makeTable(['订单 ID', '状态', '支付数量', '交易凭证'], (data.list || []).map(x => [x.orderId, statusLabel(x.status), x.amount, txLink(x.txHash)]));
      $('history-coverage').textContent = `来源：Binance Agentic Wallet CLI · ${localTime(new Date().toISOString())}。显示首批记录，不是完整账本。`;
      setReadMessage('当前记录已更新；订单状态按官方返回显示。');
    }
  } catch (error) { if (current === epoch && version === readVersion) { setReadMessage(error.message, true); emptyState(view === 'overview' ? 'asset-table' : 'live-table', '暂时无法读取', error.message); } }
  finally { if (current === epoch && version === readVersion) { readBusy = false; $('read-wallet').disabled = !state?.walletConnected; $('read-wallet').classList.remove('loading'); } }
}
async function connectWallet() {
  if (restoreRetryNeeded) { await restoreSession(); return; }
  if (!(token || localAccessKey)) { setReadMessage(launchMessage, true); return; }
  if (restoreBusy || suspended) return;
  if (connectBusy || activePhases.includes(state?.phase) || state?.walletConnected) return;
  if (state?.phase === 'REVIEW') { document.dispatchEvent(new CustomEvent('wallet:show-settings')); return; }
  const checkOnly = ['FAILED', 'TIMEOUT', 'PAUSED'].includes(state?.phase) || state?.requiresStatusCheck;
  const current = epoch; connectBusy = true; state = { ...state, phase: 'CHECKING', stage: 'STATUS', diagnostic: null };
  connectionControls(state, '正在核对本机已有会话…');
  try { await session(); if (current !== epoch) return; const v = await api(checkOnly ? '/api/wallet/check' : '/api/wallet/signin'); if (current !== epoch) return; connectBusy = false; render(v); }
  catch (error) { if (current === epoch) { connectBusy = false; showFailure(error.message); } }
  finally { connectBusy = false; }
}
$('connect-wallet').onclick = connectWallet; $('top-connect-wallet').onclick = connectWallet;
$('stop-wallet-wait').onclick = async () => {
  clearTimeout(pollTimer); pollController?.abort(); const current = ++epoch; connectBusy = false;
  state = { ...state, phase: 'PAUSED', stage: 'LOCAL', diagnostic: null, requiresStatusCheck: true }; connectionControls(state, '正在停止本页等待…');
  try { const v = await api('/api/wallet/stop-waiting'); if (current === epoch) render(v); } catch (error) { if (current === epoch) showFailure(error.message); }
};
$('drawer-stop-wallet-wait').onclick = () => $('stop-wallet-wait').onclick();
$('copy-wallet-diagnostic').onclick = async () => {
  const value = diagnosticText(state, lastDiagnostic, document.body.dataset.qa === 'true', cliVersions);
  try { await navigator.clipboard.writeText(value); $('diagnostic-copy-message').textContent = '已复制脱敏诊断，不含地址、配对码或授权链接。'; $('diagnostic-fallback').hidden = true; }
  catch { $('diagnostic-fallback').hidden = false; $('diagnostic-fallback').value = value; $('diagnostic-fallback').select(); $('diagnostic-copy-message').textContent = '剪贴板不可用，可手动复制下方诊断。'; }
};
$('copy-wallet-address').onclick = async () => { const address = state?.addresses?.find(a => a.chainId === $('live-chain').value)?.address; if (!address) return; try { await navigator.clipboard.writeText(address); $('copy-address-message').textContent = ' 已复制'; } catch { $('copy-address-message').textContent = ' 请手动选取地址复制'; } };
$('confirm-wallet-address').onchange = () => { $('bind-wallet').disabled = !$('confirm-wallet-address').checked; };
$('bind-wallet').onclick = async () => {
  const current = epoch; $('bind-wallet').disabled = true; state = { ...state, phase: 'VERIFYING', stage: 'BIND', diagnostic: null };
  connectionControls(state, '正在核对官方连接与钱包地址…');
  try { const v = await api('/api/wallet/bind', { candidateId: state.candidateId, confirmed: $('confirm-wallet-address').checked }); if (current === epoch) render(v); } catch (error) { if (current === epoch) showFailure(error.message); }
};
$('lock-wallet').onclick = () => lock();
$('signout-wallet').onclick = async () => {
  if (!confirm('退出官方 CLI 将清除其会话，可能影响其他本机工具；不会撤单或撤销链上授权。确认退出？')) return;
  $('signout-wallet').disabled = true; const current = epoch;
  try { const v = await api('/api/wallet/signout', { confirmed: true }); if (current === epoch) wipe(v.localSessionCleared ? '官方 CLI 已确认退出。' : '本页已断开，官方 CLI 退出状态未确认。'); }
  catch { if (current === epoch) wipe('本页已断开，官方 CLI 退出状态未确认。'); }
};
$('live-chain').onchange = () => changeChain(); $('read-wallet').onclick = refreshCurrent;
$('live-kind').onchange = () => { readVersion++; readBusy = false; void refreshCurrent(); };
$('asset-search').oninput = renderHoldings;
document.querySelectorAll('[data-asset-tab]').forEach(button => button.addEventListener('click', () => { assetTab = button.dataset.assetTab; document.querySelectorAll('[data-asset-tab]').forEach(node => node.setAttribute('aria-selected', String(node === button))); renderHoldings(); }));
document.addEventListener('wallet:view', event => { const before = currentView; currentView = event.detail.view; $('read-wallet').hidden = currentView === 'quote'; if (before !== currentView && state?.walletConnected) { if (currentView === 'history') { readVersion++; readBusy = false; void refreshCurrent(); } else if (currentView === 'overview') { if (assetSnapshot || portfolioSnapshot) renderAssets(); else { readVersion++; readBusy = false; void refreshCurrent(); } } } });
const COMMON_TOKENS = { BNB: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE', USDT: '0x55d398326f99059fF775485246999027B3197955', USDC: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d' };
function invalidateReview(message = '') {
  quoteVersion++; displayedIntentId = null;
  tradeReview = null; clearTimeout(reviewTimer);
  $('trade-cost-ack').checked = false; $('trade-risk-ack').checked = false; $('confirm-trade').disabled = true;
  if (!tradeSubmitting && $('live-review').open) $('live-review').close();
  if (message) $('live-quote-message').textContent = message;
}
function clearTradeUI() {
  quoteBusy = false; quoteVersion++; displayedIntentId = null; clearTimeout(tradeTimer); clearTimeout(reviewTimer); trackedIntentId = null; tradeReview = null; trades = []; tradeSubmitting = false;
  $('trade-list').replaceChildren(); $('trade-state-message').textContent = '连接钱包后查询本机交易记录。'; $('refresh-trades').disabled = true;
  $('trade-risk-items').replaceChildren(); $('trade-confirmations').hidden = true; $('confirm-trade').disabled = true;
  $('trade-cost-ack').checked = false; $('trade-risk-ack').checked = false; $('trade-submit-message').textContent = '请先连接钱包。';
}
function checkTradeConfirmation() {
  const review = tradeReview;
  const notExpired = review && timestamp(review.expiresAt) > Date.now();
  $('confirm-trade').disabled = tradeSubmitting || !review?.executable || review?.risk?.blocked === true || !notExpired || !$('trade-cost-ack').checked || (review.requiresRiskAcknowledgment && !$('trade-risk-ack').checked);
}
function quoteDetails(details) { $('live-review-details').replaceChildren(...details.map(([key, value]) => { const div = el('div'); div.append(el('dt', key), el('dd', value ?? '未返回')); return div; })); }
function showTradeReview(review) {
  displayedIntentId = null;
  tradeReview = review; $('trade-cost-ack').checked = false; $('trade-risk-ack').checked = false;
  quoteDetails([['网络', 'BNB Smart Chain / ' + review.chainId], ['钱包', review.walletAddress], ['支付合约', review.fromToken], ['接收合约', review.toToken], ['支付数量', review.amount + (review.fromSymbol ? ' ' + review.fromSymbol : '')], ['预计到账', review.quotedOut + (review.toSymbol ? ' ' + review.toSymbol : '')], ['滑点参考最低到账', review.minimumReferenceOut + (review.toSymbol ? ' ' + review.toSymbol : '')], ['滑点上限', review.slippage + '%'], ['报价有效期', localTime(review.expiresAt)], ['MEV 保护', review.mev === true ? '已启用' : '未确认'], ['Gas 档位', review.gasLevel || '未确认'], ['价格影响 / 总费用', '未完整确认，实际以执行结果为准']]);
  const warnings = Array.isArray(review.warnings) ? review.warnings : [];
  $('live-review-blockers').replaceChildren(...warnings.map(x => el('li', typeof x === 'string' ? x : x.message || '存在未确认信息')));
  const riskItems = Array.isArray(review.risk?.items) ? review.risk.items : [];
  $('trade-risk-items').replaceChildren(...riskItems.map(x => el('p', typeof x === 'string' ? x : x.message || x.description || x.name || '代币风险信息待核对')));
  if (review.risk?.blocked) $('trade-risk-items').prepend(el('p', '风险检查已拦截，此笔交易不能提交。', 'blocked-notice'));
  else if (review.requiresRiskAcknowledgment && riskItems.length === 0) $('trade-risk-items').append(el('p', '代币安全信息未完整确认。请核实合约并明确确认风险。'));
  $('trade-risk-label').hidden = !review.requiresRiskAcknowledgment;
  $('trade-confirmations').hidden = !review.executable || review.risk?.blocked === true;
  $('review-state-label').textContent = '报价预览 · 尚未提交'; $('trade-submit-message').textContent = '确认将提交真实兑换；请核对以上完整合约和金额。';
  $('confirm-trade').textContent = '确认交易'; checkTradeConfirmation(); $('live-review').showModal();
  clearTimeout(reviewTimer); const duration = timestamp(review.expiresAt) - Date.now();
  reviewTimer = setTimeout(() => { if (tradeReview?.reviewId !== review.reviewId || tradeSubmitting) return; tradeReview = null; $('confirm-trade').disabled = true; $('review-state-label').textContent = '报价已过期'; $('trade-submit-message').textContent = '关闭审阅并重新获取报价，再次确认。'; }, Math.max(0, Number.isFinite(duration) ? duration : 0));
}
function normalizeIntent(data) { return data?.intent || data?.operation || data; }
function intentIdOf(intent) { return intent?.intentId || intent?.id || null; }
function stateOf(intent) { return String(intent?.state || intent?.status || 'UNKNOWN').toUpperCase(); }
function labelOfIntent(intent) {
  const value = stateOf(intent);
  if (value === 'FINISHED' && !(intent.successful === true && /^0x[a-fA-F0-9]{64}$/.test(intent.txHash || ''))) return '待核验完成凭证';
  if (intent?.requiresConfirmation || intent?.requiresAppConfirmation || intent?.needAppConfirmation) return '等待币安 App 确认';
  return ({ PREVIEW: '仅预览，未提交', PREVIEWED: '已预览，待确认', READY: '待本人确认', SUBMITTING: '正在提交，尚未成交', SUBMITTED: '已提交，尚未成交', PENDING: '处理中，尚未成交', PENDING_CONFIRMATION: '等待币安 App 确认', PROCESSING: '处理中，尚未成交', WORKING: '处理中', WAITING_APP_CONFIRMATION: '等待币安 App 确认', WAITING_CONFIRMATION: '等待币安 App 确认', REQUIRE_CONFIRMATION: '等待币安 App 确认', NEED_CONFIRMATION: '等待币安 App 确认', FINISHED: '已完成', COMPLETED: '状态待进一步核验', FAILED: '执行失败', CANCELED: '已取消', CANCELLED: '已取消', REJECTED: '已拒绝', EXPIRED: '已过期', UNKNOWN: '结果未知，禁止重复提交', SUBMISSION_UNKNOWN: '结果未知，禁止重复提交' })[value] || '状态未确认';
}
function updateIntent(intent) {
  if (!intent || !intentIdOf(intent)) return;
  const id = intentIdOf(intent), index = trades.findIndex(x => intentIdOf(x) === id);
  if (displayedIntentId === id && $('live-review').open) { $('review-state-label').textContent = labelOfIntent(intent); $('trade-submit-message').textContent = stateOf(intent) === 'FINISHED' && intent.successful === true ? '交易已完成。' + (intent.actualReceived != null ? '实际到账 ' + intent.actualReceived + '。' : '实收数量未返回。') + '链上凭证见交易记录，资产余额可手动刷新。' : labelOfIntent(intent) + '。不会自动重复提交。'; }
  if (index < 0) trades.unshift(intent); else trades[index] = { ...trades[index], ...intent };
  renderTrades();
}
function hasOpenTrade() { return trades.some(intent => ['SUBMITTING', 'SUBMITTED', 'PENDING', 'PENDING_CONFIRMATION', 'PROCESSING', 'WAITING_APP_CONFIRMATION', 'WAITING_CONFIRMATION', 'REQUIRE_CONFIRMATION', 'NEED_CONFIRMATION', 'UNKNOWN', 'SUBMISSION_UNKNOWN'].includes(stateOf(intent))); }
function renderTrades() {
  $('trade-list').replaceChildren(...trades.map(intent => {
    const item = el('article', undefined, 'trade-item' + (intentIdOf(intent) === trackedIntentId ? ' trade-active' : ''));
    const heading = el('div', undefined, 'trade-item-head'); heading.append(el('strong', (intent.amount || intent.fromTokenQty || '—') + ' · BSC'), el('span', labelOfIntent(intent), 'badge')); item.append(heading);
    if (intent.fromToken || intent.toToken) item.append(el('p', shortAddress(intent.fromToken) + ' → ' + shortAddress(intent.toToken)));
    if (intent.orderId) item.append(el('p', '订单 ' + intent.orderId));
    if (intent.txHash && /^0x[a-fA-F0-9]{64}$/.test(intent.txHash)) { const link = el('a', '查看链上凭证 ↗', 'small'); link.href = 'https://bscscan.com/tx/' + intent.txHash; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); }
    if (stateOf(intent) === 'FINISHED' && intent.successful === true && intent.actualReceived != null) item.append(el('p', '实际到账 ' + intent.actualReceived));
    if (intent.pollingError) item.append(el('p', '本次状态查询未完成，保留上次状态。'));
    if (intent.message || intent.error?.message) item.append(el('p', intent.message || intent.error.message));
    return item;
  }));
  $('live-quote-button').disabled = !state?.walletConnected || tradeSubmitting || hasOpenTrade();
  $('trade-state-message').textContent = trades.length ? '已提交不代表成交；结果未知时只查询状态，不重复发单。' : '本机尚无已读取的交易记录。';
}
function trackIntent(intent) {
  clearTimeout(tradeTimer); updateIntent(intent);
  const state = stateOf(intent);
  if (['FINISHED', 'FAILED', 'CANCELED', 'CANCELLED', 'REJECTED', 'EXPIRED', 'UNKNOWN', 'SUBMISSION_UNKNOWN', 'PREVIEW', 'PREVIEWED', 'READY'].includes(state)) { trackedIntentId = null; renderTrades(); return; }
  trackedIntentId = intentIdOf(intent); if (trackedIntentId) tradeTimer = setTimeout(pollTrade, 5000);
}
async function pollTrade() {
  if (!trackedIntentId || !state?.walletConnected || tradePollBusy) return;
  const current = epoch, intentId = trackedIntentId; tradePollBusy = true;
  try { const value = normalizeIntent(await api('/api/trade/status', { intentId })); if (current !== epoch || trackedIntentId !== intentId) return; trackIntent(value); }
  catch (error) { if (current === epoch) { $('trade-state-message').textContent = '状态查询未完成：' + error.message + ' 不会重新提交交易。'; tradeTimer = setTimeout(pollTrade, 5000); } }
  finally { tradePollBusy = false; }
}
async function loadTrades() {
  if (!state?.walletConnected) return;
  const current = epoch; $('refresh-trades').disabled = true;
  try {
    const value = await api('/api/trade/list'); if (current !== epoch) return;
    const items = Array.isArray(value) ? value : value.intents || value.orders || value.list || [];
    trades = items; renderTrades();
    const pending = trades.find(item => ['SUBMITTING', 'SUBMITTED', 'PENDING', 'PENDING_CONFIRMATION', 'PROCESSING', 'WORKING', 'WAITING_APP_CONFIRMATION', 'WAITING_CONFIRMATION', 'REQUIRE_CONFIRMATION', 'NEED_CONFIRMATION'].includes(stateOf(item)));
    if (pending) trackIntent(pending);
  } catch (error) { if (current === epoch) $('trade-state-message').textContent = '交易状态暂未读取：' + error.message; }
  finally { if (current === epoch) $('refresh-trades').disabled = !state?.walletConnected; }
}
for (const side of ['from', 'to']) {
  $(side + '-preset').onchange = () => { invalidateReview('代币已更改，请重新获取报价。'); $('live-' + side).value = COMMON_TOKENS[$(side + '-preset').value] || ''; if ($(side + '-preset').value === 'custom') $('live-' + side).focus(); };
  $('live-' + side).addEventListener('input', () => { const match = Object.entries(COMMON_TOKENS).find(([, contract]) => contract.toLowerCase() === $('live-' + side).value.trim().toLowerCase()); $(side + '-preset').value = match?.[0] || 'custom'; });
}
$('live-quote-form').addEventListener('input', () => invalidateReview('参数已更改，请重新获取报价。'));
$('live-quote-form').onsubmit = async event => {
  event.preventDefault(); if (tradeSubmitting || quoteBusy || hasOpenTrade()) return; invalidateReview(); quoteBusy = true; const requestVersion = quoteVersion;
  const current = epoch, chainId = $('live-chain').value; $('live-quote-button').disabled = true; $('live-quote-message').textContent = '正在核验钱包、查询报价与风险…';
  const request = { chainId, fromToken: $('live-from').value.trim(), toToken: $('live-to').value.trim(), amount: $('live-amount').value.trim(), slippage: $('live-slippage').value.trim() };
  const parameters = JSON.stringify(request);
  try {
    const quote = await api(chainId === '56' ? '/api/trade/preview' : '/api/wallet/quote', request);
    const now = JSON.stringify({ chainId: $('live-chain').value, fromToken: $('live-from').value.trim(), toToken: $('live-to').value.trim(), amount: $('live-amount').value.trim(), slippage: $('live-slippage').value.trim() });
    if (current !== epoch || requestVersion !== quoteVersion || parameters !== now) return;
    if (chainId === '56') { showTradeReview(quote); $('live-quote-message').textContent = quote.risk?.blocked ? '风险检查已拦截，未提交交易。' : '报价与风险信息已返回，请逐项核对。'; }
    else {
      quoteDetails([['网络', quote.chainId], ['钱包', quote.wallet], ['支付合约', quote.fromToken], ['接收合约', quote.toToken], ['支付数量', quote.amount + ' ' + (quote.fromSymbol || '')], ['预计到账', quote.estimatedOut === null ? '官方未返回' : quote.estimatedOut + ' ' + (quote.toSymbol || '')], ['滑点上限', quote.slippagePercent + '%'], ['价格影响 / 费用', '未确认']]);
      $('live-review-blockers').replaceChildren(...(quote.blockers || []).map(x => el('li', x))); $('trade-risk-items').replaceChildren(); $('trade-confirmations').hidden = true; $('review-state-label').textContent = '此网络仅提供报价预览'; $('trade-submit-message').textContent = '手动交易暂仅支持 BSC。'; $('live-review').showModal();
      $('live-quote-message').textContent = '官方报价已返回；此网络未开放提交。';
    }
  } catch (error) { if (current === epoch && requestVersion === quoteVersion) $('live-quote-message').textContent = error.message; }
  finally { if (current === epoch) { quoteBusy = false; $('live-quote-button').disabled = !state?.walletConnected || tradeSubmitting || hasOpenTrade(); } }
};
$('trade-cost-ack').onchange = checkTradeConfirmation; $('trade-risk-ack').onchange = checkTradeConfirmation;
$('confirm-trade').onclick = async () => {
  checkTradeConfirmation(); if ($('confirm-trade').disabled || !tradeReview) return;
  const current = epoch, review = tradeReview; displayedIntentId = review.intentId; tradeSubmitting = true; tradeReview = null; clearTimeout(reviewTimer); $('confirm-trade').disabled = true; $('confirm-trade').textContent = '正在提交…'; $('close-live-review').disabled = true;
  $('trade-submit-message').textContent = '提交一次后只查询状态。请勿重复操作。'; $('live-quote-button').disabled = true;
  try {
    const intent = normalizeIntent(await api('/api/trade/submit', { reviewId: review.reviewId, confirmed: true, riskAcknowledged: review.requiresRiskAcknowledgment ? $('trade-risk-ack').checked : false, costAcknowledged: $('trade-cost-ack').checked }));
    if (current !== epoch) return;
    trackIntent(intent); $('review-state-label').textContent = labelOfIntent(intent); $('trade-submit-message').textContent = '请在下方交易状态区查看进度，需要 App 确认时请在币安处理。'; $('trade-confirmations').hidden = true;
    $('live-quote-message').textContent = labelOfIntent(intent) + '。本机持续查询，未确认完成前不会当作成交。';
  } catch (error) {
    if (current === epoch) {
      const beforeSubmissionErrors = new Set(['TRADE_REVIEW_EXPIRED', 'UNKNOWN_TRADE_REVIEW', 'TRADE_QUOTE_CHANGED_REVIEW_REQUIRED', 'TOKEN_AUDIT_CHANGED_REVIEW_REQUIRED', 'TOKEN_RISK_BLOCKED', 'UNRESOLVED_TRADE_EXISTS', 'TRADE_CONFIRMATION_REQUIRED', 'TOKEN_RISK_ACKNOWLEDGMENT_REQUIRED', 'INSUFFICIENT_TRADE_BALANCE', 'INSUFFICIENT_GAS_RESERVE', 'WALLET_TRANSACTION_LOCKED', 'TRADE_BALANCE_UNCONFIRMED', 'GAS_PRICE_UNCONFIRMED', 'TRADE_QUOTE_MISMATCH']);
      if (beforeSubmissionErrors.has(error.code)) {
        displayedIntentId = null; $('review-state-label').textContent = '尚未提交'; $('trade-submit-message').textContent = error.message; $('live-quote-message').textContent = error.message;
        if (error.code === 'UNRESOLVED_TRADE_EXISTS') void loadTrades();
      } else {
        const intent = { intentId: review.intentId, state: 'UNKNOWN', amount: review.amount, fromToken: review.fromToken, toToken: review.toToken, message: '提交结果未确认：' + error.message }; updateIntent(intent); trackedIntentId = review.intentId; if (trackedIntentId) tradeTimer = setTimeout(pollTrade, 5000); $('review-state-label').textContent = '提交结果待核验'; $('trade-submit-message').textContent = '正在查询此意图的状态，不会重发。可关闭此窗口查看记录。';
      }
      $('trade-confirmations').hidden = true;
    }
  } finally { if (current === epoch) { tradeSubmitting = false; $('close-live-review').disabled = false; $('live-quote-button').disabled = !state?.walletConnected || tradeSubmitting || hasOpenTrade(); } }
};
$('close-live-review').onclick = () => { if (!tradeSubmitting) invalidateReview(); };
$('live-review').addEventListener('cancel', event => { if (tradeSubmitting) event.preventDefault(); else invalidateReview(); });
$('refresh-trades').onclick = async () => { if (!trackedIntentId) trackedIntentId = intentIdOf(trades.find(intent => ['UNKNOWN', 'SUBMISSION_UNKNOWN'].includes(stateOf(intent)))); if (trackedIntentId) await pollTrade(); await loadTrades(); };
window.addEventListener('offline', () => suspendSession('网络已离线，已隐藏资产；恢复网络后继续当前会话。'));
window.addEventListener('online', () => { void restoreSession(); });
window.addEventListener('pagehide', () => suspendSession());
window.addEventListener('pageshow', event => { if (event.persisted) void restoreSession(); });
void restoreSession();
fetch('/api/status', { credentials: 'omit', cache: 'no-store' }).then(response => response.json()).then(value => { cliVersions = value.cli || {}; $('installed-cli-version').textContent = cliVersions.installedVersion || '未确认'; if (!value.capabilities?.liveWalletAuth) { connectionControls({ phase: 'DISCONNECTED' }, '本机服务暂未启用钱包连接。'); $('top-connect-wallet').disabled = true; $('connect-wallet').disabled = true; } }).catch(() => { $('installed-cli-version').textContent = '未确认'; setReadMessage('本机服务未响应，请通过启动器重新打开。', true); });
