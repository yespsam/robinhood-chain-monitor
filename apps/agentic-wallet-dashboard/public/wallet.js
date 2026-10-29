import { PHASES, STAGES, activePhases, diagnosticText, safeDiagnosticExport } from './connection-state.js';
import { AUTH_URL_ISSUES } from './official-error-catalog.js';
import { renderAuthQr } from './auth-qr.js';
import { readLocalSession, saveLocalSession, clearLocalSession } from './session-recovery.js';
import { COMMON_TOKENS, createBscTradePair } from './trade-pair.js';
const $ = id => document.getElementById(id);
// The launch capability is transient. Never persist it, display it, or send it to external origins.
const accessMatch = /^#access=([a-f0-9]{64})$/.exec(location.hash);
const localAccessKey = accessMatch?.[1] || null;
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
let token = null, state = null, epoch = 0, pollTimer, expiryTimer, pollBusy = false, readVersion = 0;
let connectBusy = false, pollController = null, lastDiagnostic = null, cooldownTimer, cliVersions = {};
let authQrVersion = 0, authExpiryTimer;
let restoreBusy = false, restoreRetryNeeded = false, suspended = false, sessionExpiresAt = 0;
let recoveryTimer, recoveryAttempts = 0;
const readControllers = new Set();
const abortablePaths = new Set(['/api/local/session', '/api/local/state', '/api/wallet/check', '/api/wallet/read', '/api/wallet/quote', '/api/trade/preview', '/api/trade/list', '/api/trade/status', '/api/mint/preview', '/api/mint/list', '/api/mint/status', '/api/contract-call/preview', '/api/contract-call/list', '/api/contract-call/status']);
let quoteBusy = false, quoteVersion = 0, displayedIntentId = null;
let tradeReview = null, tradeTimer, reviewTimer, tradeSubmitting = false, trackedIntentId = null, tradePollBusy = false, trades = [];
let mintReview = null, mintBusy = false, mintSubmitting = false, mintRecords = [], mintExpiryTimer;
let customCallReview = null, customCallBusy = false, customCallSubmitting = false, customCallRecords = [], customCallExpiryTimer, customCallVersion = 0;
const isEvmChain = value => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value);
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
  AUTH_STATUS_UNCONFIRMED: '钱包连接暂未核实，正在重新核对；不会重新登录或提交交易。',
  AUTH_RATE_LIMIT: '请稍等片刻再生成新的配对码。',
  DEVELOPER_MODE_REQUIRED: '请先在 Binance App 中启用 Developer Mode，再重新预览。',
  MINT_PREVIEW_REJECTED: 'Binance Agentic Wallet 未接受这笔预览；未提交交易。',
  MINT_PREVIEW_INCOMPLETE: '官方预览信息不完整或无法核验；已停止，未提交交易。',
  MINT_PREVIEW_BLOCKED: '官方模拟或风险检查未通过；已拦截，未提交交易。',
  MINT_REVIEW_EXPIRED: 'Mint 预览已过期，请重新预览。',
  UNKNOWN_MINT_REVIEW: 'Mint 预览不存在或已失效，请重新预览。',
  MINT_CONFIRMATION_REQUIRED: '请先勾选并核对这笔真实链上创建交易。',
  MINT_RISK_ACKNOWLEDGMENT_REQUIRED: '请先阅读预览风险并确认是否继续。',
  MINT_BALANCE_UNCONFIRMED: 'BNB 余额未能唯一核实，暂不能创建。',
  UNRESOLVED_MINT_EXISTS: '已有一笔 Mint 结果待核验；先核对交易状态，不会自动重发。',
  MINT_JOURNAL_BUSY: '本机正在处理一笔 Mint，请稍后查看记录。',
  CONTRACT_CALL_CHAIN_UNSUPPORTED: '当前绑定钱包没有可用的受支持 EVM 网络。',
  CONTRACT_CALL_ABI_INVALID: 'ABI 必须是有效且受支持的函数 ABI JSON。',
  CONTRACT_CALL_FUNCTION_INVALID: '函数签名无法从 ABI 唯一解析；请填写规范签名，例如 mint(address,uint256)。',
  CONTRACT_CALL_NOT_STATE_CHANGING: '只允许调用非 view 或 payable 的状态变更函数。',
  CONTRACT_CALL_PRIVILEGE_METHOD_BLOCKED: '授权、所有权、角色或升级类高权限函数在此界面被拦截。',
  CONTRACT_CALL_ARGUMENTS_INVALID: '参数必须是可按 ABI 编码的 JSON 数组。',
  CONTRACT_CALL_VALUE_NOT_PAYABLE: '该函数不是 payable；附带原生币必须为 0。',
  CONTRACT_CALL_DATA_TOO_LARGE: '编码后的调用数据超出安全长度限制。',
  CONTRACT_CALL_BALANCE_UNCONFIRMED: '目标网络的原生币余额无法唯一核实。',
  CONTRACT_CALL_PREVIEW_REJECTED: 'Agentic Wallet 未接受该合约调用预览；未提交。',
  CONTRACT_CALL_PREVIEW_INCOMPLETE: '官方模拟返回字段缺失或不完整；已停止，未提交。',
  CONTRACT_CALL_PREVIEW_BLOCKED: '模拟失败、地址/金额不匹配、风险过高或检测到权限变化；已拦截。',
  CONTRACT_CALL_REVIEW_EXPIRED: '预览已过期，请重新进行模拟。',
  UNKNOWN_CONTRACT_CALL_REVIEW: '自定义合约预览不存在或已经失效。',
  CONTRACT_CALL_CONFIRMATION_REQUIRED: '请核对并确认本次自定义合约调用。',
  CONTRACT_CALL_RISK_ACKNOWLEDGMENT_REQUIRED: '请先阅读并确认模拟返回的风险提示。',
  UNRESOLVED_CONTRACT_CALL_EXISTS: '已有一笔合约调用结果待核验；先核对记录，不会自动重发。',
  CONTRACT_CALL_JOURNAL_BUSY: '本机正在处理一笔合约调用，请稍后刷新状态。',
  CONTRACT_CALL_WALLET_CHANGED: '钱包地址或会话发生变化，预览已作废。',
  INSUFFICIENT_GAS_RESERVE: 'BNB 余额需高于预留 Gas 门槛；请核对钱包余额和官方预览。',
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
    catch (error) { if (error.name === 'AbortError') throw error; if (isCurrentRequest()) lastDiagnostic = { code: 'LOCAL_SERVICE_UNAVAILABLE', category: 'LOCAL_HTTP', stage: 'HTTP', at: new Date().toISOString() }; throw Object.assign(Error('暂时无法连接本机服务，正在自动重试；官方会话未退出。'), { retryable: true }); }
    try { data = await response.json(); }
    catch (error) { if (error.name === 'AbortError') throw error; if (isCurrentRequest()) lastDiagnostic = { code: 'LOCAL_RESPONSE_PARSE_FAILED', category: 'PARSE', stage: 'HTTP', at: new Date().toISOString() }; throw Object.assign(Error('本机接口返回格式异常，正在重新核对连接状态。'), { retryable: true }); }
    if (!response.ok) {
      if (isCurrentRequest()) lastDiagnostic = data.diagnostic || { code: 'INTERNAL_ERROR', category: 'LOCAL_FLOW', stage: 'LOCAL' };
      const message = messages[data.error] || describeDiagnostic(data.diagnostic) || '请求未完成，请在连接设置中查看诊断。';
      const authenticationLost = response.status === 401 || ['WALLET_AUTH_INVALID', 'WALLET_AUTH_EXPIRED', 'WALLET_IDENTITY_MISMATCH', 'WALLET_BINDING_CHANGED'].includes(data.error);
      if (authenticationLost && isCurrentRequest()) {
        clearLocalSession();
        if (preserveOnAuthFailure) { token = null; state = null; sessionExpiresAt = 0; }
        else wipe(message);
      }
      const error = Error(message); error.code = data.error; error.authenticationLost = authenticationLost;
      error.retryable = !authenticationLost && (response.status >= 500 || response.status === 408 || data.error === 'AUTH_STATUS_UNCONFIRMED'); throw error;
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
  if ($('mint-preview-button')) $('mint-preview-button').disabled = !v?.walletConnected || mintBusy || mintSubmitting;
  if ($('refresh-mints')) $('refresh-mints').disabled = !v?.walletConnected;
  if ($('custom-preview-button')) $('custom-preview-button').disabled = !v?.walletConnected || customCallBusy || customCallSubmitting || !v?.chains?.some(chain => isEvmChain(chain.id));
  if ($('refresh-custom-calls')) $('refresh-custom-calls').disabled = !v?.walletConnected;
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
  clearTradeUI(); clearMintUI(); clearCustomCallUI();
  readVersion++; readBusy = false; clearBalances(); emptyState('live-table', '暂无已读取的记录', '连接钱包后刷新当前列表。');
  $('live-review-details').replaceChildren(); $('live-review-blockers').replaceChildren(); if ($('live-review').open) $('live-review').close();
  $('candidate-addresses').replaceChildren(); $('live-address').textContent = '尚未绑定'; $('copy-wallet-address').disabled = true; $('copy-address-message').textContent = '';
  $('read-wallet').classList.remove('loading'); document.body.classList.remove('wallet-connected');
}
function stopLocalWork() {
  clearTimeout(pollTimer); clearTimeout(expiryTimer); clearTimeout(cooldownTimer); clearTimeout(recoveryTimer);
  pollController?.abort(); for (const controller of readControllers) controller.abort(); readControllers.clear();
  pollBusy = false; tradePollBusy = false;
}
function wipe(message = '本页已断开，官方 CLI 会话保持不变。', { preserveSession = false } = {}) {
  epoch++; state = null; connectBusy = false; restoreBusy = false; restoreRetryNeeded = false; stopLocalWork();
  if (!preserveSession) { token = null; sessionExpiresAt = 0; clearLocalSession(); suspended = false; recoveryAttempts = 0; }
  clearPrivateData();
  $('wallet-candidate').hidden = true; $('read-permission').textContent = '待绑定'; $('wallet-notice').textContent = '连接本机钱包'; $('live-data-badge').textContent = '等待连接';
  $('global-state').textContent = '本机直开 · 钱包待连接'; $('confirm-wallet-address').checked = false;
  for (const name of ['lock-wallet', 'signout-wallet', 'bind-wallet', 'read-wallet', 'live-chain', 'live-quote-button']) $(name).disabled = true;
  $('mint-preview-button').disabled = true; $('refresh-mints').disabled = true;
  $('custom-preview-button').disabled = true; $('refresh-custom-calls').disabled = true; $('custom-chain').replaceChildren(new Option('请先连接钱包', ''));
  $('live-chain').replaceChildren(el('option', '等待连接'));
  for (const name of ['live-from', 'live-to', 'live-amount', 'live-slippage', 'asset-search']) $(name).value = '';
  $('live-quote-message').textContent = '请先连接并核对钱包。'; $('mint-message').textContent = '连接并核对钱包后可预览。'; $('mint-state-message').textContent = '连接钱包后读取本机 Mint 记录。'; $('custom-call-message').textContent = '连接钱包后可进行只读预览。'; $('custom-call-state-message').textContent = '连接钱包后读取本机记录。'; $('quote-chain-label').textContent = '等待连接'; setReadMessage(message);
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
  else if (!token) sessionExpiresAt = 0;
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
    restoreBusy = false; recoveryAttempts = 0; render(value);
    if (!value.walletConnected) setReadMessage(value.phase === 'WAITING' ? '已恢复原扫码流程，继续等待同一次 App 确认。' : value.phase === 'REVIEW' ? '已恢复待核对的钱包地址，确认后读取资产。' : '已恢复本页会话，钱包状态已核对。');
  } catch (error) {
    if (current === epoch && error.name !== 'AbortError') { restoreBusy = false; showFailure(error.message, { retry: error.retryable }); }
  } finally { if (current === epoch) restoreBusy = false; }
}
function showFailure(message, { retry = false } = {}) {
  if (state?.walletConnected) wipe(message, { preserveSession: true });
  restoreRetryNeeded = !!(token || localAccessKey);
  clearTimeout(pollTimer); pollController?.abort(); clearPrivateData(); $('wallet-candidate').hidden = true;
  for (const name of ['bind-wallet', 'read-wallet', 'live-chain', 'live-quote-button']) $(name).disabled = true;
  state = { ...state, walletConnected: false, phase: lastDiagnostic?.category === 'TIMEOUT' ? 'TIMEOUT' : 'FAILED', stage: lastDiagnostic?.stage || 'LOCAL', diagnostic: lastDiagnostic, requiresStatusCheck: true };
  connectionControls(state, message); setReadMessage(message, true);
  clearTimeout(recoveryTimer);
  if (retry && token && !suspended && navigator.onLine !== false) {
    const delays = [2000, 5000, 15000, 30000], delay = delays[Math.min(recoveryAttempts++, delays.length - 1)];
    const current = epoch;
    recoveryTimer = setTimeout(() => { if (current === epoch) void restoreSession(); }, delay);
    for (const id of ['wallet-badge', 'top-wallet-state']) $(id).textContent = '连接恢复中';
    $('top-wallet-message').textContent = message + ` ${delay / 1000} 秒后自动重新核验。`;
    $('wallet-message').textContent = $('top-wallet-message').textContent;
  }
}
async function session() { if (!token) { if (!localAccessKey) throw Error(launchMessage); const current = epoch, v = await api('/api/local/session'); if (current !== epoch) throw Error('本页连接请求已取消。'); token = v.token; rememberSession(v.expiresAt); } }
function render(v) {
  const wasConnected = !!state?.walletConnected, wasReview = state?.phase === 'REVIEW', wasWaiting = state?.phase === 'WAITING'; state = v;
  clearTimeout(expiryTimer);
  const expiresAt = Math.min(timestamp(v.expiresAt), v.walletExpiresAt ? timestamp(v.walletExpiresAt) : Infinity);
  rememberSession(expiresAt);
  // Browser clocks and other tabs can make this deadline stale. Only the server
  // decides whether access expired; a timer must never revoke a shared session.
  const expiryEpoch = epoch;
  if (Number.isFinite(expiresAt)) expiryTimer = setTimeout(() => { if (expiryEpoch === epoch && token) void restoreSession(); }, Math.max(1000, expiresAt - Date.now()));
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
  const message = connected ? '钱包地址已核对，可读取资产、Swap、Flap Mint 或预览自定义 EVM 合约。' : v.diagnostic ? describeDiagnostic(v.diagnostic)
    : v.phase === 'WAITING' ? '用币安 App 扫描下方二维码，核对配对码并确认。二维码到期后会自动清除。'
    : v.phase === 'REVIEW' ? '已找到官方钱包会话，请在连接设置中核对地址。'
    : v.phase === 'PAUSED' ? '本页等待已停止，远端授权未撤销。核验结束后可重查状态。'
    : activePhases.includes(v.phase) ? `正在${STAGES[v.stage] || '核验'}…`
    : '用币安 App 扫码登录；本机已有会话会直接复用。';
  connectionControls(v, message);
  if (v.phase === 'WAITING' && !wasWaiting && !$('wallet-auth').hidden) document.dispatchEvent(new CustomEvent('wallet:show-settings'));
  $('read-permission').textContent = connected ? '已绑定' : '待绑定'; $('wallet-notice').textContent = connected ? '我的 Agentic Wallet' : '连接本机钱包';
  $('global-state').textContent = connected ? '真实钱包 · Swap / Mint 逐笔确认' : '本机直开 · 钱包待连接';
  for (const name of ['live-chain', 'read-wallet', 'live-quote-button']) $(name).disabled = !connected || (name === 'read-wallet' && readBusy) || (name === 'live-quote-button' && (tradeSubmitting || hasOpenTrade()));
  if (connected && !wasConnected) {
    $('live-chain').replaceChildren(...v.chains.map(c => { const o = el('option', c.name); o.value = c.id; return o; }));
    populateCustomChains(v);
    if (v.chains.some(c => c.id === '56')) $('live-chain').value = '56';
    changeChain(false); $('live-data-badge').textContent = '已绑定 · 待读取'; document.dispatchEvent(new CustomEvent('wallet:bound')); void refreshCurrent(); void loadTrades(); void loadMints(); void loadCustomCalls();
  }
  if (connected && !wasConnected) $('live-quote-message').textContent = '填好合约、数量和滑点后，点击一次买入/卖出按钮即可核验并提交。';
  clearTimeout(pollTimer);
  if (!['FAILED', 'TIMEOUT', 'PAUSED', 'DISCONNECTED'].includes(v.phase)) pollTimer = setTimeout(poll, connected ? 60_000 : 1500);
}
async function poll() {
  if (!token || pollBusy) return; const current = epoch; pollBusy = true; const controller = new AbortController(); pollController = controller;
  try { const v = await api('/api/local/state', {}, controller.signal); if (current === epoch && !controller.signal.aborted) render(v); }
  catch (error) { if (current === epoch && error.name !== 'AbortError') showFailure(error.message, { retry: error.retryable }); }
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
  $('live-quote-message').textContent = chain === '56' ? '点击买入/卖出按钮一次即可核验并提交；不会自动重发。' : '此网络仅提供报价预览，手动交易暂仅支持 BSC。';
  if (chain !== '56') $('ptah-note').textContent = 'PTAH 持仓仅在 BNB Smart Chain 上查询。';
  updateTradeActionButton(); setReadMessage('网络已切换，待读取真实数据。'); if (refresh) void refreshCurrent();
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
  catch (error) { if (current === epoch) { connectBusy = false; showFailure(error.message, { retry: error.retryable }); } }
  finally { connectBusy = false; }
}
$('connect-wallet').onclick = connectWallet; $('top-connect-wallet').onclick = connectWallet;
$('stop-wallet-wait').onclick = async () => {
  clearTimeout(pollTimer); pollController?.abort(); const current = ++epoch; connectBusy = false;
  state = { ...state, phase: 'PAUSED', stage: 'LOCAL', diagnostic: null, requiresStatusCheck: true }; connectionControls(state, '正在停止本页等待…');
  try { const v = await api('/api/wallet/stop-waiting'); if (current === epoch) render(v); } catch (error) { if (current === epoch) showFailure(error.message, { retry: error.retryable }); }
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
  try { const v = await api('/api/wallet/bind', { candidateId: state.candidateId, confirmed: $('confirm-wallet-address').checked }); if (current === epoch) render(v); } catch (error) { if (current === epoch) showFailure(error.message, { retry: error.retryable }); }
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
document.addEventListener('wallet:view', event => { const before = currentView; currentView = event.detail.view; $('read-wallet').hidden = ['quote', 'mint', 'custom-call'].includes(currentView); if (before !== currentView && state?.walletConnected) { if (currentView === 'history') { readVersion++; readBusy = false; void refreshCurrent(); } else if (currentView === 'overview') { if (assetSnapshot || portfolioSnapshot) renderAssets(); else { readVersion++; readBusy = false; void refreshCurrent(); } } else if (currentView === 'mint') void loadMints(); else if (currentView === 'custom-call') void loadCustomCalls(); } });
function installCaTradeHelper() {
  const form = $('live-quote-form'); if (!form) return;
  const panel = el('div', undefined, 'quote-scope'), direction = el('select'), token = el('input'), quoteAsset = el('select');
  panel.append(el('strong', '单 CA 快捷买入 / 卖出'));
  const directionLabel = el('label', '方向'), tokenLabel = el('label', '代币 CA'), quoteLabel = el('label', '报价资产');
  direction.id = 'quick-ca-direction'; directionLabel.htmlFor = direction.id;
  direction.append(new Option('买入该 CA', 'buy'), new Option('卖出该 CA', 'sell'));
  token.id = 'quick-ca-address'; token.type = 'text'; token.autocomplete = 'off'; token.spellcheck = false; token.placeholder = '粘贴 BNB Chain 代币合约地址'; tokenLabel.htmlFor = token.id;
  quoteAsset.id = 'quick-ca-quote'; quoteLabel.htmlFor = quoteAsset.id;
  for (const [id, label] of [['BNB', 'BNB'], ['USDT', 'USDT'], ['USDC', 'USDC']]) quoteAsset.append(new Option(label, id));
  const hint = el('p', '买入：用报价资产支付并接收 CA；卖出：支付 CA 并换回报价资产。', 'small muted');
  const apply = el('button', '填入交易对', 'quiet-button full'); apply.type = 'button';
  const status = el('p', '', 'small muted'); status.setAttribute('role', 'status');
  direction.onchange = () => { hint.textContent = direction.value === 'buy'
    ? '买入：支付数量填写报价资产数量。'
    : '卖出：支付数量填写要卖出的 CA 数量。'; };
  apply.onclick = () => {
    try {
      if ($('live-chain').value !== '56') throw new Error('BSC_ONLY');
      const pair = createBscTradePair({ direction: direction.value, tokenAddress: token.value.trim(), quoteAsset: quoteAsset.value });
      for (const [side, address] of [['from', pair.fromToken], ['to', pair.toToken]]) {
        const preset = Object.entries(COMMON_TOKENS).find(([, contract]) => contract.toLowerCase() === address.toLowerCase());
        $(side + '-preset').value = preset?.[0] || 'custom'; $('live-' + side).value = address;
      }
      $('live-amount').value = '';
      updateTradeActionButton();
      invalidateReview('交易对已填入；填写支付数量和滑点后，点击一次即可核验并提交。');
      status.textContent = '已填入。CA 仍须通过实时报价、审计、余额、Gas 与交易锁核验；快捷填入不保证可交易。';
    } catch (error) { status.textContent = error.message === 'BSC_ONLY'
      ? '此快捷入口只适用于 BNB Smart Chain；其他网络当前仅可查询报价。'
      : 'CA 格式或报价资产无效，请核对完整合约地址。'; }
  };
  panel.append(directionLabel, direction, tokenLabel, token, quoteLabel, quoteAsset, apply, hint, status);
  form.prepend(panel);
}
installCaTradeHelper();
function updateTradeActionButton() {
  const button = $('live-quote-button');
  const known = address => Object.values(COMMON_TOKENS).some(value => value.toLowerCase() === address.trim().toLowerCase());
  const fromKnown = known($('live-from').value), toKnown = known($('live-to').value);
  button.type = 'button';
  button.textContent = $('live-chain').value !== '56' ? '仅获取报价' : fromKnown && !toKnown ? '一键买入并提交' : !fromKnown && toKnown ? '一键卖出并提交' : '一键兑换并提交';
  document.querySelector('.readonly-label').textContent = '一键手动提交 · 本机专属';
  document.querySelector('.quote-screen .section-note').textContent = '填好合约、数量和滑点后，点击买入/卖出按钮一次；系统会即时核验并提交。';
  document.querySelector('.quote-scope strong').textContent = '每次点击即为本笔提交授权';
  document.querySelector('.quote-scope p').textContent = '仅 BNB Smart Chain 开放手动兑换。按钮点击后会核验最新报价、风险、余额、Gas 与交易锁；任一硬拦截或参数变化都会停止提交。未知结果不自动重发；币安 App 如要求确认，仍需在 App 内完成。';
}
updateTradeActionButton();
document.querySelector('.quote-screen .section-note').setAttribute('aria-live', 'polite');
document.querySelector('.quote-scope p').setAttribute('aria-live', 'polite');
function invalidateReview(message = '') {
  quoteVersion++; displayedIntentId = null;
  tradeReview = null; clearTimeout(reviewTimer);
  $('confirm-trade').disabled = true;
  if (!tradeSubmitting && $('live-review').open) $('live-review').close();
  if (message) $('live-quote-message').textContent = message;
}
function clearTradeUI() {
  quoteBusy = false; quoteVersion++; displayedIntentId = null; clearTimeout(tradeTimer); clearTimeout(reviewTimer); trackedIntentId = null; tradeReview = null; trades = []; tradeSubmitting = false;
  $('trade-list').replaceChildren(); $('trade-state-message').textContent = '连接钱包后查询本机交易记录。'; $('refresh-trades').disabled = true;
  $('trade-risk-items').replaceChildren(); $('trade-confirmations').hidden = true; $('confirm-trade').disabled = true;
  $('trade-submit-message').textContent = '请先连接钱包。';
}
function checkTradeConfirmation() {
  const review = tradeReview;
  const notExpired = review && timestamp(review.expiresAt) > Date.now();
  $('confirm-trade').disabled = tradeSubmitting || !review?.executable || review?.risk?.blocked === true || !notExpired;
}
function quoteDetails(details) { $('live-review-details').replaceChildren(...details.map(([key, value]) => { const div = el('div'); div.append(el('dt', key), el('dd', value ?? '未返回')); return div; })); }
function showTradeReview(review) {
  displayedIntentId = null;
  tradeReview = review;
  quoteDetails([['网络', 'BNB Smart Chain / ' + review.chainId], ['钱包', review.walletAddress], ['支付合约', review.fromToken], ['接收合约', review.toToken], ['支付数量', review.amount + (review.fromSymbol ? ' ' + review.fromSymbol : '')], ['预计到账', review.quotedOut + (review.toSymbol ? ' ' + review.toSymbol : '')], ['滑点参考最低到账', review.minimumReferenceOut + (review.toSymbol ? ' ' + review.toSymbol : '')], ['滑点上限', review.slippage + '%'], ['报价有效期', localTime(review.expiresAt)], ['MEV 保护', review.mev === true ? '已启用' : '未确认'], ['Gas 档位', review.gasLevel || '未确认'], ['价格影响 / 总费用', '未完整确认，实际以执行结果为准']]);
  const warnings = Array.isArray(review.warnings) ? review.warnings : [];
  $('live-review-blockers').replaceChildren(...warnings.map(x => el('li', typeof x === 'string' ? x : x.message || '存在未确认信息')));
  const riskItems = Array.isArray(review.risk?.items) ? review.risk.items : [];
  const sourceRisk = review.sourceRisk, sourceRiskItems = Array.isArray(sourceRisk?.items) ? sourceRisk.items : [];
  const riskRows = [];
  if (review.risk?.state !== 'TRUSTED_TARGET') {
    riskRows.push(el('p', '接收侧（买入目标）风险审查', 'risk-heading'));
    riskRows.push(...riskItems.map(x => el('p', typeof x === 'string' ? x : x.message || x.description || x.name || '目标代币风险信息待核对')));
    if (review.risk?.blocked) riskRows.push(el('p', '目标代币风险检查已拦截，此笔买入/兑换不能提交。', 'blocked-notice'));
  }
  if (sourceRisk) {
    riskRows.push(el('p', '支付侧（卖出源币）风险审查', 'risk-heading'));
    riskRows.push(...sourceRiskItems.map(x => el('p', typeof x === 'string' ? x : x.message || x.description || x.name || '源代币风险信息待核对')));
    if (sourceRisk.state === 'SOURCE_AUDIT_UNAVAILABLE') riskRows.push(el('p', '卖出源币的安全资料不可用；此提示不拦截退出，但交易仍可能因合约、税费或路由失败。'));
  }
  $('trade-risk-items').replaceChildren(...riskRows);
  if (!review.risk?.blocked && review.requiresRiskAcknowledgment && riskRows.length === 0) $('trade-risk-items').append(el('p', '代币安全信息未完整确认。请核实合约并明确确认风险。'));
  $('trade-confirmations').hidden = true;
  $('review-state-label').textContent = '安全拦截 · 未提交'; $('trade-submit-message').textContent = '风险检查已阻止本次提交。请查看拦截原因；本机不会提供绕过按钮。';
  $('confirm-trade').textContent = '确认并提交真实交易'; checkTradeConfirmation(); $('live-review').showModal();
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
  $(side + '-preset').onchange = () => { invalidateReview('代币已更改，请再次点击执行。'); $('live-' + side).value = COMMON_TOKENS[$(side + '-preset').value] || ''; if ($(side + '-preset').value === 'custom') $('live-' + side).focus(); updateTradeActionButton(); };
  $('live-' + side).addEventListener('input', () => { const match = Object.entries(COMMON_TOKENS).find(([, contract]) => contract.toLowerCase() === $('live-' + side).value.trim().toLowerCase()); $(side + '-preset').value = match?.[0] || 'custom'; });
}
$('live-quote-form').addEventListener('input', () => { invalidateReview('参数已更改，请再次点击执行。'); updateTradeActionButton(); });
$('live-chain').addEventListener('change', updateTradeActionButton);
$('live-quote-form').onsubmit = event => event.preventDefault();
$('live-quote-button').onclick = async () => {
  if (!$('live-quote-form').reportValidity()) return;
  if (tradeSubmitting || quoteBusy || hasOpenTrade()) return;
  invalidateReview(); quoteBusy = true; const requestVersion = quoteVersion;
  const current = epoch, chainId = $('live-chain').value; let review = null, submissionStarted = false;
  $('live-quote-button').disabled = true; $('live-quote-button').textContent = '正在核验…'; $('live-quote-message').textContent = '正在核验钱包、最新报价、风险、余额与 Gas…';
  const request = { chainId, fromToken: $('live-from').value.trim(), toToken: $('live-to').value.trim(), amount: $('live-amount').value.trim(), slippage: $('live-slippage').value.trim() };
  const parameters = JSON.stringify(request);
  try {
    const quote = await api(chainId === '56' ? '/api/trade/preview' : '/api/wallet/quote', request);
    const now = JSON.stringify({ chainId: $('live-chain').value, fromToken: $('live-from').value.trim(), toToken: $('live-to').value.trim(), amount: $('live-amount').value.trim(), slippage: $('live-slippage').value.trim() });
    if (current !== epoch || requestVersion !== quoteVersion || parameters !== now) return;
    if (chainId !== '56') {
      quoteDetails([['网络', quote.chainId], ['钱包', quote.wallet], ['支付合约', quote.fromToken], ['接收合约', quote.toToken], ['支付数量', quote.amount + ' ' + (quote.fromSymbol || '')], ['预计到账', quote.estimatedOut === null ? '官方未返回' : quote.estimatedOut + ' ' + (quote.toSymbol || '')], ['滑点上限', quote.slippagePercent + '%'], ['价格影响 / 费用', '未确认']]);
      $('live-review-blockers').replaceChildren(...(quote.blockers || []).map(x => el('li', x))); $('trade-risk-items').replaceChildren(); $('trade-confirmations').hidden = true; $('review-state-label').textContent = '此网络仅提供报价预览'; $('trade-submit-message').textContent = '手动交易暂仅支持 BSC。'; $('live-review').showModal();
      $('live-quote-message').textContent = '官方报价已返回；此网络未开放提交。';
      return;
    }
    review = quote;
    if (quote.risk?.blocked === true) { showTradeReview(quote); $('live-quote-message').textContent = '安全检查已拦截，未提交交易。请查看拦截原因。'; return; }
    tradeSubmitting = true; submissionStarted = true; displayedIntentId = quote.intentId;
    $('live-quote-button').textContent = '正在提交…'; $('live-quote-message').textContent = '报价与安全检查通过，正在通过官方钱包提交；提交不代表成交。';
    const intent = normalizeIntent(await api('/api/trade/submit', { reviewId: review.reviewId, confirmed: true, riskAcknowledged: true, costAcknowledged: true }));
    if (current !== epoch) return;
    trackIntent(intent); $('live-quote-message').textContent = labelOfIntent(intent) + '。本机只查询状态，不会自动重复提交。';
  } catch (error) {
    if (current === epoch) {
      const beforeSubmissionErrors = new Set(['TRADE_REVIEW_EXPIRED', 'UNKNOWN_TRADE_REVIEW', 'TRADE_QUOTE_CHANGED_REVIEW_REQUIRED', 'TOKEN_AUDIT_CHANGED_REVIEW_REQUIRED', 'TOKEN_RISK_BLOCKED', 'UNRESOLVED_TRADE_EXISTS', 'TRADE_CONFIRMATION_REQUIRED', 'TOKEN_RISK_ACKNOWLEDGMENT_REQUIRED', 'INSUFFICIENT_TRADE_BALANCE', 'INSUFFICIENT_GAS_RESERVE', 'WALLET_TRANSACTION_LOCKED', 'TRADE_BALANCE_UNCONFIRMED', 'GAS_PRICE_UNCONFIRMED', 'TRADE_QUOTE_MISMATCH']);
      if (!submissionStarted || beforeSubmissionErrors.has(error.code)) {
        displayedIntentId = null; $('live-quote-message').textContent = error.message;
        if (error.code === 'UNRESOLVED_TRADE_EXISTS') void loadTrades();
      } else {
        const intent = { intentId: review.intentId, state: 'UNKNOWN', amount: review.amount, fromToken: review.fromToken, toToken: review.toToken, message: '提交结果未确认：' + error.message }; updateIntent(intent); trackedIntentId = review.intentId; if (trackedIntentId) tradeTimer = setTimeout(pollTrade, 5000); $('live-quote-message').textContent = '提交结果待核验；已锁定本笔意图，只查询状态，不会重发。';
      }
    }
  } finally { if (current === epoch) { quoteBusy = false; tradeSubmitting = false; updateTradeActionButton(); $('live-quote-button').disabled = !state?.walletConnected || hasOpenTrade(); } }
};
$('close-live-review').onclick = () => { if (!tradeSubmitting) invalidateReview(); };
$('live-review').addEventListener('cancel', event => { if (tradeSubmitting) event.preventDefault(); else invalidateReview(); });
$('refresh-trades').onclick = async () => { if (!trackedIntentId) trackedIntentId = intentIdOf(trades.find(intent => ['UNKNOWN', 'SUBMISSION_UNKNOWN'].includes(stateOf(intent)))); if (trackedIntentId) await pollTrade(); await loadTrades(); };
let mintListBusy = false, mintVersion = 0;
function clearMintReview(message = '') {
  mintVersion++; clearTimeout(mintExpiryTimer); mintReview = null;
  $('mint-cost-ack').checked = false; $('mint-risk-ack').checked = false; $('confirm-mint').disabled = true;
  if (!mintSubmitting && $('mint-review').open) $('mint-review').close();
  if (message) $('mint-message').textContent = message;
}
function clearMintUI() {
  clearMintReview(); mintBusy = false; mintSubmitting = false; mintRecords = []; mintListBusy = false;
  $('mint-list').replaceChildren(); $('mint-state-message').textContent = '连接钱包后读取本机 Mint 记录。';
  $('mint-message').textContent = '连接并核对钱包后可预览。'; $('mint-submit-message').textContent = '请逐项核对；如果 Binance App 要求确认，还需在 App 内确认。';
  $('mint-name').value = ''; $('mint-symbol').value = ''; $('mint-metadata').value = '';
  $('mint-review-details').replaceChildren(); $('mint-review-risks').replaceChildren(); $('mint-simulation-details').textContent = '';
  if ($('mint-review').open) $('mint-review').close();
}
function mintStateLabel(value) {
  return ({ SUBMITTING: '正在提交', BROADCASTED: '已广播 · 待链上确认', PENDING_CONFIRMATION: '等待 Binance App 确认', UNKNOWN: '结果未知 · 请核对历史', FAILED: '提交失败' })[value] || '状态待核对';
}
function renderMintRecords() {
  $('mint-list').replaceChildren(...mintRecords.map(record => {
    const item = el('article', undefined, 'trade-item'), heading = el('div', undefined, 'trade-item-head');
    heading.append(el('strong', `${record.name || 'Token'} (${record.symbol || '—'}) · BSC`), el('span', mintStateLabel(record.status), 'badge')); item.append(heading);
    item.append(el('p', 'CA 尚未从 TokenCreated 事件解析；不根据交易哈希猜测合约地址。'));
    if (record.orderId) item.append(el('p', '官方订单 ' + record.orderId));
    if (record.txHash && /^0x[a-fA-F0-9]{64}$/.test(record.txHash)) { const link = el('a', '在 BscScan 核对交易 ↗', 'small'); link.href = 'https://bscscan.com/tx/' + record.txHash; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); }
    if (record.note) item.append(el('p', record.note));
    if (record.metadataUri) item.append(el('p', 'Metadata: ' + record.metadataUri));
    return item;
  }));
  $('mint-state-message').textContent = mintRecords.length ? '提交不等于创建成功；请在链上核对回执与 TokenCreated 事件。未知结果不会自动重发。' : '本机尚无已读取的 Mint 记录。';
}
async function loadMints() {
  if (!state?.walletConnected || mintListBusy) return;
  const current = epoch; mintListBusy = true; $('refresh-mints').disabled = true;
  try {
    const result = await api('/api/mint/list');
    if (current !== epoch) return;
    mintRecords = Array.isArray(result?.list) ? result.list : []; renderMintRecords();
  } catch (error) { if (current === epoch) $('mint-state-message').textContent = 'Mint 记录暂未读取：' + error.message; }
  finally { mintListBusy = false; if (current === epoch) $('refresh-mints').disabled = !state?.walletConnected; }
}
function mintDetails(details) {
  $('mint-review-details').replaceChildren(...details.map(([key, value]) => { const row = el('div'); row.append(el('dt', key), el('dd', value ?? '未返回')); return row; }));
}
function updateMintConfirm() {
  const review = mintReview, riskRequired = review?.requiresRiskAcknowledgment === true;
  const fresh = review && Number.isFinite(review.expiresAt) && review.expiresAt > Date.now();
  $('confirm-mint').disabled = mintSubmitting || !review?.executable || !fresh || !$('mint-cost-ack').checked || (riskRequired && !$('mint-risk-ack').checked);
}
function showMintReview(review) {
  mintReview = review; $('mint-cost-ack').checked = false; $('mint-risk-ack').checked = false;
  $('mint-review-state').textContent = review.requireConfirmation ? '预览通过 · 执行后还需在 Binance App 确认' : '预览通过 · 最后一步将通过钱包提交';
  mintDetails([['网络', 'BNB Smart Chain / 56'], ['钱包', review.walletAddress], ['发射平台', 'Flap Standard'], ['代币', `${review.name} (${review.symbol})`],
    ['Metadata URI', review.metadataUri], ['Portal 合约', review.portal], ['附带 BNB', '0 BNB（不含最终 Gas）'], ['预留燃料余额', `${review.gasReserve} BNB`],
    ['预览有效期', localTime(review.expiresAt)], ['App 二次确认', review.requireConfirmation ? '需要' : '预览未要求；最终点击仍是本页明确授权']]);
  const riskRows = [];
  for (const risk of review.risks?.riskDetails || []) riskRows.push(el('p', `${risk.riskType}: ${risk.title || risk.code || '风险提示'} — ${risk.description || '未提供说明'}`));
  for (const [address, info] of Object.entries(review.risks?.addresses || {})) {
    if (info.riskLevel > 0) riskRows.push(el('p', `地址 ${address} 风险级别 ${info.riskLevel}: ${(info.riskDetails || []).map(x => x.title || x.description || x.code).filter(Boolean).join('；') || '无详细说明'}`));
  }
  for (const risk of review.risks?.riskBehaviors || []) riskRows.push(el('p', `${risk.riskType}: ${risk.title || risk.code || '行为提示'} — ${risk.description || '未提供说明'}`));
  $('mint-review-risks').replaceChildren(...(riskRows.length ? riskRows : [el('p', '官方预览未返回可展示的风险提示；这不构成安全保证。')]));
  $('mint-risk-label').hidden = !review.requiresRiskAcknowledgment;
  $('mint-simulation-details').textContent = JSON.stringify({ parsedTx: review.parsedTx, risks: review.risks,
    authorityChanges: review.authorityChanges, allowanceChanges: review.allowanceChanges, balanceChanges: review.balanceChanges }, null, 2);
  $('mint-submit-message').textContent = review.warning;
  $('mint-review').showModal(); updateMintConfirm();
  clearTimeout(mintExpiryTimer); mintExpiryTimer = setTimeout(() => { updateMintConfirm(); $('mint-submit-message').textContent = '预览已过期，请关闭后重新预览。'; }, Math.max(0, review.expiresAt - Date.now()));
}
function currentMintInput() { return JSON.stringify({ name: $('mint-name').value.trim(), symbol: $('mint-symbol').value.trim(), metadataUri: $('mint-metadata').value.trim() }); }
$('mint-form').addEventListener('input', () => { if (mintReview) clearMintReview('Mint 参数已变化；旧预览已作废，请重新预览。'); });
$('mint-platform').onchange = () => { if ($('mint-platform').value !== 'flap') $('mint-message').textContent = '该平台暂未接入 Agentic Wallet 签名；没有调用或保存私钥。'; };
$('mint-preview-button').onclick = async () => {
  if (!$('mint-form').reportValidity() || mintBusy || mintSubmitting || !state?.walletConnected) return;
  if (!state.chains?.some(chain => chain.id === '56')) { $('mint-message').textContent = '当前 Agentic Wallet 未报告 BNB Smart Chain，已停止预览。'; return; }
  clearMintReview(); mintBusy = true; const version = ++mintVersion, current = epoch, input = currentMintInput();
  $('mint-preview-button').disabled = true; $('mint-preview-button').textContent = '正在安全预览…';
  $('mint-message').textContent = '核对 Developer Mode、BSC 钱包、交易锁与 BNB 余额，并通过官方 CLI 模拟固定 Flap 调用…';
  try {
    const result = await api('/api/mint/preview', JSON.parse(input));
    if (current !== epoch || version !== mintVersion || input !== currentMintInput()) return;
    if (result.chainId !== '56' || result.portal?.toLowerCase() !== '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0' || result.executable !== true || !/^[a-f0-9]{32}$/.test(result.reviewId || '') || !/^[a-f0-9]{32}$/.test(result.intentId || '')) throw Error('官方预览信息未通过完整性核验，已停止。');
    showMintReview(result); $('mint-message').textContent = '官方模拟预览已返回；尚未提交，确认按钮会触发本笔真实链上调用。';
  } catch (error) { if (current === epoch && version === mintVersion) $('mint-message').textContent = error.message; }
  finally { mintBusy = false; if (current === epoch) { $('mint-preview-button').disabled = !state?.walletConnected; $('mint-preview-button').innerHTML = '预览创建交易 <span>→</span>'; } }
};
$('mint-cost-ack').onchange = updateMintConfirm; $('mint-risk-ack').onchange = updateMintConfirm;
$('confirm-mint').onclick = async () => {
  if (mintSubmitting || !mintReview || $('confirm-mint').disabled) return;
  const review = mintReview, current = epoch; mintSubmitting = true; updateMintConfirm();
  $('mint-submit-message').textContent = '正在通过 Binance Agentic Wallet 提交；不要关闭页面或重复点击。';
  $('mint-preview-button').disabled = true;
  let responseReceived = false;
  try {
    const result = await api('/api/mint/submit', { reviewId: review.reviewId, confirmed: true, costAcknowledged: true, riskAcknowledged: $('mint-risk-ack').checked });
    responseReceived = true; if (current !== epoch) return;
    mintReview = null; clearTimeout(mintExpiryTimer); mintRecords = [result, ...mintRecords.filter(x => x.intentId !== result.intentId)]; renderMintRecords();
    $('mint-review-state').textContent = mintStateLabel(result.status); $('mint-submit-message').textContent = result.note || '已处理；请核对状态，不会自动重发。';
    $('mint-message').textContent = result.note || mintStateLabel(result.status);
    $('mint-cost-ack').checked = false; $('mint-risk-ack').checked = false; $('confirm-mint').disabled = true;
  } catch (error) {
    if (current === epoch) {
      const definite = new Set(['DEVELOPER_MODE_REQUIRED', 'MINT_REVIEW_EXPIRED', 'UNKNOWN_MINT_REVIEW', 'MINT_CONFIRMATION_REQUIRED', 'MINT_RISK_ACKNOWLEDGMENT_REQUIRED', 'WALLET_TRANSACTION_LOCKED', 'MINT_BALANCE_UNCONFIRMED', 'INSUFFICIENT_GAS_RESERVE', 'UNRESOLVED_MINT_EXISTS', 'MINT_PREVIEW_BLOCKED', 'MINT_PREVIEW_INCOMPLETE']);
      if (!responseReceived && !definite.has(error.code)) {
        const unknown = { ...review, status: 'UNKNOWN', txHash: null, orderId: null, note: '本机未收到最终响应；只查询 Mint 记录，不会自动重发。' };
        mintRecords = [unknown, ...mintRecords.filter(x => x.intentId !== unknown.intentId)]; renderMintRecords();
        $('mint-submit-message').textContent = '提交结果未知。请刷新记录并核对 Binance App / 链上历史；本机不会自动重发。';
      } else $('mint-submit-message').textContent = error.message;
    }
  } finally {
    mintSubmitting = false; if (current === epoch) { $('mint-preview-button').disabled = !state?.walletConnected; $('confirm-mint').disabled = true; void loadMints(); }
  }
};
$('close-mint-review').onclick = () => { if (!mintSubmitting) clearMintReview(); };
$('mint-review').addEventListener('cancel', event => { if (mintSubmitting) event.preventDefault(); else clearMintReview(); });
$('refresh-mints').onclick = loadMints;
function populateCustomChains(walletState = state) {
  const choices = (walletState?.chains || []).filter(chain => isEvmChain(chain.id) && walletState.addresses?.some(address => address.chainId === chain.id));
  $('custom-chain').replaceChildren(...(choices.length ? choices.map(chain => { const option = el('option', `${chain.name} · ${chain.id}`); option.value = chain.id; return option; }) : [new Option('没有可用的 EVM 网络', '')]));
  $('custom-chain').disabled = !walletState?.walletConnected || choices.length === 0;
  if (choices.some(chain => chain.id === '56')) $('custom-chain').value = '56';
  updateCustomNativeLabel();
}
function updateCustomNativeLabel() {
  const label = ({ '56': 'BNB', '1': 'ETH', '8453': 'ETH' })[$('custom-chain').value] || '该网络原生币';
  $('custom-native-label').textContent = `(${label})`;
}
function clearCustomCallReview(message = '') {
  customCallVersion++; clearTimeout(customCallExpiryTimer); customCallReview = null;
  $('custom-call-risk-ack').checked = false; $('custom-call-cost-ack').checked = false; $('custom-call-caution-ack').checked = false; $('confirm-custom-call').disabled = true;
  if (!customCallSubmitting && $('custom-call-review').open) $('custom-call-review').close();
  if (message) $('custom-call-message').textContent = message;
}
function clearCustomCallUI() {
  clearCustomCallReview(); customCallBusy = false; customCallSubmitting = false; customCallRecords = [];
  $('custom-call-list').replaceChildren(); $('custom-call-state-message').textContent = '连接钱包后读取本机记录。';
  $('custom-call-message').textContent = '连接钱包后可进行只读预览。'; $('custom-call-submit-message').textContent = '确认后只提交当前预览一次；结果未知时不会自动重发。';
  for (const name of ['custom-contract', 'custom-abi', 'custom-function', 'custom-arguments']) $(name).value = '';
  $('custom-value').value = '0'; $('custom-call-review-details').replaceChildren(); $('custom-call-review-risks').replaceChildren(); $('custom-call-simulation-details').textContent = '';
  if ($('custom-call-review').open) $('custom-call-review').close();
}
function customCallStateLabel(value) {
  return ({ SUBMITTING: '正在提交', BROADCASTED: '已广播 · 待链上确认', PENDING_CONFIRMATION: '等待 Binance App 确认', UNKNOWN: '结果未知 · 先核对', FAILED: '提交失败' })[value] || '状态待核对';
}
function explorerTx(chainId, txHash) {
  const base = ({ '56': 'https://bscscan.com/tx/', '1': 'https://etherscan.io/tx/', '8453': 'https://basescan.org/tx/' })[chainId];
  return base && /^0x[a-fA-F0-9]{64}$/.test(txHash || '') ? base + txHash : null;
}
function renderCustomCallRecords() {
  $('custom-call-list').replaceChildren(...customCallRecords.map(record => {
    const item = el('article', undefined, 'trade-item'), heading = el('div', undefined, 'trade-item-head');
    heading.append(el('strong', `${record.functionSignature || record.functionName || '合约调用'} · ${record.chainId}`), el('span', customCallStateLabel(record.status), 'badge')); item.append(heading);
    item.append(el('p', `合约 ${record.contractAddress || '未返回'} · selector ${record.selector || '未返回'}`));
    if (record.valueWei !== '0') item.append(el('p', `附带原生币 ${record.valueWei} wei`));
    if (record.orderId) item.append(el('p', '官方订单 ' + record.orderId));
    const href = explorerTx(record.chainId, record.txHash); if (href) { const link = el('a', '在区块浏览器核对交易 ↗', 'small'); link.href = href; link.target = '_blank'; link.rel = 'noopener noreferrer'; item.append(link); }
    if (record.note) item.append(el('p', record.note)); return item;
  }));
  $('custom-call-state-message').textContent = customCallRecords.length ? '已广播不代表合约执行成功；请核对链上状态与事件。未知结果不会自动重发。' : '本机尚无已读取的自定义合约调用记录。';
}
async function loadCustomCalls() {
  if (!state?.walletConnected || customCallBusy) return;
  const current = epoch; customCallBusy = true; $('refresh-custom-calls').disabled = true;
  try { const result = await api('/api/contract-call/list'); if (current !== epoch) return;
    customCallRecords = Array.isArray(result?.list) ? result.list : []; renderCustomCallRecords();
  } catch (error) { if (current === epoch) $('custom-call-state-message').textContent = '调用记录暂未读取：' + error.message; }
  finally { customCallBusy = false; if (current === epoch) $('refresh-custom-calls').disabled = !state?.walletConnected; }
}
function customCallDetails(details) {
  $('custom-call-review-details').replaceChildren(...details.map(([key, value]) => { const row = el('div'); row.append(el('dt', key), el('dd', value ?? '未返回')); return row; }));
}
function updateCustomCallConfirm() {
  const review = customCallReview, fresh = review && Number.isFinite(review.expiresAt) && review.expiresAt > Date.now();
  $('confirm-custom-call').disabled = customCallSubmitting || !review?.executable || !fresh || !$('custom-call-risk-ack').checked ||
    !$('custom-call-cost-ack').checked || (review?.requiresRiskAcknowledgment && !$('custom-call-caution-ack').checked);
}
function showCustomCallReview(review) {
  customCallReview = review; for (const id of ['custom-call-risk-ack', 'custom-call-cost-ack', 'custom-call-caution-ack']) $(id).checked = false;
  $('custom-call-review-state').textContent = review.requireConfirmation ? '模拟通过 · 提交后还需在 Binance App 确认' : '模拟通过 · 本次确认将通过 Agentic Wallet 提交';
  const chainName = state?.chains?.find(x => x.id === review.chainId)?.name || review.chainId;
  customCallDetails([['网络', `${chainName} / ${review.chainId}`], ['钱包', review.walletAddress], ['目标合约', review.contractAddress],
    ['函数', review.functionSignature], ['参数', JSON.stringify(review.decodedArguments)], ['函数选择器', review.selector],
    ['附带原生币', `${review.valueNative} · ${review.valueWei} wei`], ['calldata', review.inputData],
    ['预览有效期', localTime(review.expiresAt)], ['App 二次确认', review.requireConfirmation ? '需要' : '预览未要求；仍需本页明确确认']]);
  const rows = [];
  for (const risk of review.risks?.riskDetails || []) rows.push(el('p', `${risk.riskType}: ${risk.title || risk.code || '风险提示'} — ${risk.description || '未提供说明'}`));
  for (const [address, info] of Object.entries(review.risks?.addresses || {})) if (info.riskLevel > 0)
    rows.push(el('p', `地址 ${address} 风险级别 ${info.riskLevel}: ${(info.riskDetails || []).map(x => x.title || x.description || x.code).filter(Boolean).join('；') || '无详细说明'}`));
  for (const risk of review.risks?.riskBehaviors || []) rows.push(el('p', `${risk.riskType}: ${risk.title || risk.code || '行为提示'} — ${risk.description || '未提供说明'}`));
  $('custom-call-review-risks').replaceChildren(...(rows.length ? rows : [el('p', '官方没有返回已知风险项；这不构成安全保证。')]));
  $('custom-call-risk-label').hidden = !review.requiresRiskAcknowledgment;
  $('custom-call-simulation-details').textContent = JSON.stringify({ parsedTx: review.parsedTx, risks: review.risks,
    authorityChanges: review.authorityChanges, allowanceChanges: review.allowanceChanges, balanceChanges: review.balanceChanges }, null, 2);
  $('custom-call-submit-message').textContent = review.warning; $('custom-call-review').showModal(); updateCustomCallConfirm();
  clearTimeout(customCallExpiryTimer); customCallExpiryTimer = setTimeout(() => { updateCustomCallConfirm(); $('custom-call-submit-message').textContent = '预览已过期，请关闭后重新模拟。'; }, Math.max(0, review.expiresAt - Date.now()));
}
function currentCustomCallInput() { return JSON.stringify({ chainId: $('custom-chain').value, contractAddress: $('custom-contract').value.trim(),
  abiJson: $('custom-abi').value.trim(), functionSignature: $('custom-function').value.trim(), argumentsJson: $('custom-arguments').value.trim(), valueNative: $('custom-value').value.trim() }); }
$('custom-call-form').addEventListener('input', () => { if (customCallReview) clearCustomCallReview('参数已变化；旧预览已作废，请重新模拟。'); });
$('custom-chain').onchange = () => { updateCustomNativeLabel(); if (customCallReview) clearCustomCallReview('网络已变化；旧预览已作废，请重新模拟。'); };
$('custom-call-form').onsubmit = event => event.preventDefault();
$('custom-preview-button').onclick = async () => {
  if (!$('custom-call-form').reportValidity() || customCallBusy || customCallSubmitting || !state?.walletConnected) return;
  const input = currentCustomCallInput(), parsed = JSON.parse(input);
  if (!state.chains?.some(chain => chain.id === parsed.chainId && isEvmChain(chain.id)) || !state.addresses?.some(address => address.chainId === parsed.chainId)) { $('custom-call-message').textContent = '当前钱包未报告并绑定此 EVM 网络；已停止预览。'; return; }
  clearCustomCallReview(); customCallBusy = true; const version = ++customCallVersion, current = epoch;
  $('custom-preview-button').disabled = true; $('custom-preview-button').textContent = '正在解析并模拟…';
  $('custom-call-message').textContent = '核对 Developer Mode、绑定网络、交易锁、原生币余额与燃料预留，并调用 Agentic Wallet 预览…';
  try {
    const result = await api('/api/contract-call/preview', parsed);
    if (current !== epoch || version !== customCallVersion || input !== currentCustomCallInput()) return;
    if (result.chainId !== parsed.chainId || result.contractAddress?.toLowerCase() !== parsed.contractAddress.toLowerCase() ||
        result.executable !== true || !/^[a-f0-9]{32}$/.test(result.reviewId || '') || !/^[a-f0-9]{32}$/.test(result.intentId || '') ||
        !/^0x[0-9a-f]{8}$/i.test(result.selector || '') || !/^0x[0-9a-f]+$/i.test(result.inputData || '')) throw Error('官方预览信息未通过完整性核验，已停止。');
    showCustomCallReview(result); $('custom-call-message').textContent = '模拟预览已返回；尚未提交。确认按钮只提交当前这一次调用。';
  } catch (error) { if (current === epoch && version === customCallVersion) $('custom-call-message').textContent = error.message; }
  finally { customCallBusy = false; if (current === epoch) { $('custom-preview-button').disabled = !state?.walletConnected; $('custom-preview-button').innerHTML = '解析 ABI 并模拟预览 <span>→</span>'; } }
};
for (const id of ['custom-call-risk-ack', 'custom-call-cost-ack', 'custom-call-caution-ack']) $(id).onchange = updateCustomCallConfirm;
$('confirm-custom-call').onclick = async () => {
  if (customCallSubmitting || !customCallReview || $('confirm-custom-call').disabled) return;
  const review = customCallReview, current = epoch; customCallSubmitting = true; updateCustomCallConfirm();
  $('custom-call-submit-message').textContent = '正在通过 Agentic Wallet 提交本次预览；不要重复点击。'; $('custom-preview-button').disabled = true;
  let responseReceived = false;
  try {
    const result = await api('/api/contract-call/submit', { reviewId: review.reviewId, confirmed: true, costAcknowledged: true,
      riskAcknowledged: $('custom-call-caution-ack').checked, customCallAcknowledged: $('custom-call-risk-ack').checked });
    responseReceived = true; if (current !== epoch) return;
    customCallReview = null; clearTimeout(customCallExpiryTimer); customCallRecords = [result, ...customCallRecords.filter(x => x.intentId !== result.intentId)]; renderCustomCallRecords();
    $('custom-call-review-state').textContent = customCallStateLabel(result.status); $('custom-call-submit-message').textContent = result.note || '已处理；请核对记录，不会自动重发。';
    $('custom-call-message').textContent = result.note || customCallStateLabel(result.status);
    for (const id of ['custom-call-risk-ack', 'custom-call-cost-ack', 'custom-call-caution-ack']) $(id).checked = false;
    $('confirm-custom-call').disabled = true;
  } catch (error) {
    if (current === epoch) {
      const definite = new Set(['DEVELOPER_MODE_REQUIRED', 'CONTRACT_CALL_REVIEW_EXPIRED', 'UNKNOWN_CONTRACT_CALL_REVIEW', 'CONTRACT_CALL_CONFIRMATION_REQUIRED',
        'CONTRACT_CALL_RISK_ACKNOWLEDGMENT_REQUIRED', 'WALLET_TRANSACTION_LOCKED', 'CONTRACT_CALL_BALANCE_UNCONFIRMED', 'INSUFFICIENT_GAS_RESERVE',
        'UNRESOLVED_CONTRACT_CALL_EXISTS', 'CONTRACT_CALL_PREVIEW_BLOCKED', 'CONTRACT_CALL_PREVIEW_INCOMPLETE']);
      if (!responseReceived && !definite.has(error.code)) {
        const unknown = { ...review, status: 'UNKNOWN', txHash: null, orderId: null, note: '本机未收到最终响应；只查询记录，不会自动重发。' };
        customCallRecords = [unknown, ...customCallRecords.filter(x => x.intentId !== unknown.intentId)]; renderCustomCallRecords();
        $('custom-call-submit-message').textContent = '提交结果未知。请刷新记录并核对 Binance App / 链上历史；本机不会自动重发。';
      } else $('custom-call-submit-message').textContent = error.message;
    }
  } finally { customCallSubmitting = false; if (current === epoch) { $('custom-preview-button').disabled = !state?.walletConnected; $('confirm-custom-call').disabled = true; void loadCustomCalls(); } }
};
$('close-custom-call-review').onclick = () => { if (!customCallSubmitting) clearCustomCallReview(); };
$('custom-call-review').addEventListener('cancel', event => { if (customCallSubmitting) event.preventDefault(); else clearCustomCallReview(); });
$('refresh-custom-calls').onclick = loadCustomCalls;
window.addEventListener('offline', () => suspendSession('网络已离线，已隐藏资产；恢复网络后继续当前会话。'));
window.addEventListener('online', () => { void restoreSession(); });
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || restoreBusy) return;
  if (suspended || restoreRetryNeeded) void restoreSession();
  else if (token) void poll();
});
window.addEventListener('pagehide', () => suspendSession());
window.addEventListener('pageshow', event => { if (event.persisted) void restoreSession(); });
void restoreSession();
fetch('/api/status', { credentials: 'omit', cache: 'no-store' }).then(response => response.json()).then(value => { cliVersions = value.cli || {}; $('installed-cli-version').textContent = cliVersions.installedVersion || '未确认'; if (!value.capabilities?.liveWalletAuth) { connectionControls({ phase: 'DISCONNECTED' }, '本机服务暂未启用钱包连接。'); $('top-connect-wallet').disabled = true; $('connect-wallet').disabled = true; } }).catch(() => { $('installed-cli-version').textContent = '未确认'; setReadMessage('本机服务未响应，请通过启动器重新打开。', true); });
