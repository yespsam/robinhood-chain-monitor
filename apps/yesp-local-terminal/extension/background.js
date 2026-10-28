import {safeFunding} from './funding-model.js';
import { isOfficialSigninUrl } from './signin-policy.js';
import { FOUR_METHODS, isFourPage, isOwnFourPage, validateFourParams } from './four-policy.js';
import { PANEL_METHODS, isTradePage, validatePanelParams } from './trade-policy.js';
export { isOfficialSigninUrl } from './signin-policy.js';
export const HOST_NAME = 'com.yesp.flap_wallet';
export const GUARD_KEY = 'yespTradeGuard';
const METHODS = new Set(['status', 'prepare', 'trade', 'signin', 'verify','openWallet','openFour','openTrade','walletStatus','transferPrepare','transfer','transferReconcile','flapInspect',...FOUR_METHODS,...PANEL_METHODS]);
const financial = method => ['trade','transfer','fourExecute','panelExecute'].includes(method);
const ACTIONS = new Set(['buy', 'sell', 'claim']);
const TERMINAL = new Set(['CONFIRMED', 'COMPLETE', 'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isAllowedPage(value) {
  try { const u = new URL(value); return u.origin === 'https://flap.sh' && u.pathname === '/apps/agent-bonding-curve'; }
  catch { return false; }
}

export function validateRequest(message, sender, extensionId) {
  const ownPage=`chrome-extension://${extensionId}/wallet.html`;
  const walletPage=sender?.url===ownPage && sender?.tab?.url===ownPage;
  const tradePage=isTradePage(sender?.url,extensionId)&&isTradePage(sender?.tab?.url,extensionId);
  const fourSource=isOwnFourPage(sender?.url,extensionId)&&isOwnFourPage(sender?.tab?.url,extensionId)||isFourPage(sender?.url)&&isFourPage(sender?.tab?.url);
  if (sender?.id !== extensionId || sender?.frameId !== 0 || !Number.isInteger(sender?.tab?.id) ||
      !walletPage && !tradePage && !fourSource && (!isAllowedPage(sender.tab.url) || !isAllowedPage(sender.url))) throw new Error('仅允许本扩展页面的请求。');
  if (!message || typeof message !== 'object' || !/^[a-zA-Z0-9_-]{8,100}$/.test(message.id || '') || !METHODS.has(message.method)) {
    throw new Error('无效的交易台请求。');
  }
  const params = message.params;
  if(PANEL_METHODS.has(message.method)){
    if(!tradePage)throw new Error('请从独立交易面板操作。');validatePanelParams(message.method,params);return {id:message.id,method:message.method,params:{...params}};
  }
  if(tradePage&&!['signin','verify','openWallet','openTrade','walletStatus','transferPrepare','transfer','transferReconcile'].includes(message.method))throw new Error('不支持此面板方法。');
  if(FOUR_METHODS.has(message.method)){
    if(!fourSource)throw new Error('请从 Four.meme 交易台操作。');validateFourParams(message.method,params);return {id:message.id,method:message.method,params:{...params}};
  }
  if(fourSource&&!['openWallet','openFour','openTrade'].includes(message.method))throw new Error('Four.meme 页面不能调用其他市场的交易方法。');
  if (!params || typeof params !== 'object' || Array.isArray(params) || params.profile !== 'heyi') throw new Error('仅支持已核验的 Heyi.ai 市场。');
  const allowed = new Set(['profile']);
  if(message.method==='flapInspect'){
    if(!isAllowedPage(sender.url)||!isAllowedPage(sender.tab.url))throw new Error('请从 Flap 市场页查询。');
    for(const key of ['marketAddress','tokenAddress']){allowed.add(key);if(!/^0x[\da-f]{40}$/i.test(params[key]||'')||/^0x0{40}$/i.test(params[key]))throw new Error('市场或代币地址无效。');}
  }
  if(['status','prepare','trade'].includes(message.method)){
    for(const key of ['expectedMarket','expectedToken']){allowed.add(key);if(params[key]!==undefined&&(!/^0x[\da-f]{40}$/i.test(params[key])||/^0x0{40}$/i.test(params[key])))throw new Error('页面市场绑定无效。');}
    if(['prepare','trade'].includes(message.method)&&(!params.expectedMarket||!params.expectedToken))throw new Error('请先识别当前页面的市场与代币。');
  }
  if(message.method==='openFour'||message.method==='openTrade'){
    allowed.add('tokenAddress');if(params.tokenAddress!==undefined&&!/^0x[\da-f]{40}$/i.test(params.tokenAddress))throw new Error('代币地址无效。');
  }
  if (['walletStatus','transferPrepare','transfer','transferReconcile'].includes(message.method)) {
    if(!walletPage&&!tradePage) throw new Error('请从扩展钱包或独立交易面板转出。');
    const fields={walletStatus:[],transferPrepare:['recipient','tokenAddress','amount'],transfer:['previewId','intentId'],transferReconcile:['intentId','txHash']}[message.method];
    for(const key of fields) {allowed.add(key);if(typeof params[key]!=='string' || params[key].length>128) throw new Error('转出参数无效。');}
    if(fields.includes('intentId') && !UUID.test(params.intentId)) throw new Error('转出编号无效。');
    if(fields.includes('previewId') && !UUID.test(params.previewId)) throw new Error('转出预览无效。');
    if(message.method==='transferPrepare' && (!/^0x[\da-f]{40}$/i.test(params.recipient) || !/^0x[\da-f]{40}$/i.test(params.tokenAddress)
      || !/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(params.amount))) throw new Error('地址或数量无效。');
    if(message.method==='transferReconcile' && !/^0x[\da-f]{64}$/i.test(params.txHash)) throw new Error('交易哈希无效。');
  }
  if (message.method === 'prepare' || message.method === 'trade') {
    allowed.add('action');
    if (!ACTIONS.has(params.action)) throw new Error('不支持此交易操作。');
  }
  if (message.method === 'trade') {
    allowed.add('intentId'); allowed.add('deadlineMs');
    if (!UUID.test(params.intentId || '') || params.deadlineMs !== 15000) throw new Error('交易意图或提交期限无效。');
  }
  if (Object.keys(params).some(key => !allowed.has(key))) throw new Error('请求包含不允许的参数。');
  return { id: message.id, method: message.method, params: { ...params } };
}

const errorResponse = (id, code, message) => ({ id, ok: false, error: { code, message } });
export const requestTimeoutMs = method => method === 'verify' ? 315000 : ['transfer','fourExecute','panelExecute'].includes(method) ? 100000
  : ['walletStatus','transferPrepare','transferReconcile','flapInspect',...FOUR_METHODS,...PANEL_METHODS].includes(method) ? 60000 : method === 'trade' || method === 'signin' ? 20000 : 12000;

export function installBridge(api) {
  let port = null;
  let tradeGate = Promise.resolve();
  const pending = new Map();
  const tabs = new Set();
  const readGuard = async () => (await api.storage.local.get(GUARD_KEY))[GUARD_KEY] || null;
  const writeGuard = guard => api.storage.local.set({ [GUARD_KEY]: guard });

  async function reconcileGuard(data) {
    const operation = data?.operation;
    if (!operation?.intentId) return;
    const guard = await readGuard();
    if (guard?.intentId !== operation.intentId) return;
    const status = String(operation.status || '').toUpperCase();
    if (TERMINAL.has(status)) await writeGuard(null);
    else if (status) await writeGuard({ ...guard, status, txHash: operation.txHash || null });
  }

  function broadcast(data) {
    for (const tabId of tabs) {
      api.tabs.sendMessage(tabId, { event: 'progress', data }, { frameId: 0 }).catch(() => tabs.delete(tabId));
    }
  }

  function connect() {
    if (port) return port;
    const connected = api.runtime.connectNative(HOST_NAME);
    port = connected;
    connected.onMessage.addListener(async message => {
      if (!message || typeof message !== 'object') return;
      if (message.event === 'progress') {
        // Progress is display-only. Only an explicit response can establish a
        // terminal result and release the persisted duplicate-submit guard.
        broadcast(message.data);
        return;
      }
      const waiting = pending.get(message.id);
      if (!waiting) return; // A late response is never resubmitted.
      pending.delete(message.id);
      clearTimeout(waiting.timeout);
      const response = message.ok === true ? { id: message.id, ok: true, data: message.data || {} }
        : errorResponse(message.id, message.error?.code || 'NATIVE_ERROR', message.error?.message || '本机钱包返回错误。');
      if(!response.ok&&response.error.code==='INSUFFICIENT_BALANCE'&&safeFunding(message.error?.funding))response.error.funding=safeFunding(message.error.funding);
      if(!response.ok&&financial(waiting.request.method)&&message.submissionNotStarted===true)response.submissionNotStarted=true;
      await reconcileGuard(message.data);
      if (waiting.request.method === 'signin' && response.ok && isOfficialSigninUrl(response.data.urlForWeb)) {
        // Keep the wallet QR visible; the official page is also available in a tab.
        api.tabs.create({ url: response.data.urlForWeb, active: !waiting.inlineSignin }).catch(() => {});
      }
      response.guard = await readGuard();
      waiting.resolve(response);
    });
    connected.onDisconnect.addListener(async () => {
      const detail = api.runtime.lastError?.message;
      if (port === connected) port = null;
      for (const [id, waiting] of pending) {
        pending.delete(id); clearTimeout(waiting.timeout);
        if (financial(waiting.request.method)) {
          const guard = await readGuard();
          if (guard) await writeGuard({ ...guard, status: 'UNKNOWN' });
        }
        waiting.resolve(errorResponse(id, financial(waiting.request.method) ? 'UNKNOWN' : 'NATIVE_UNAVAILABLE',
          financial(waiting.request.method) ? '连接中断，交易结果待核验。不要重复提交。' : '本机钱包连接已断开，请检查连接程序。'));
      }
      broadcast({ connection: 'disconnected', message: detail ? '本机连接不可用，请检查连接程序。' : '本机钱包连接已断开。', guard: await readGuard() });
    });
    return connected;
  }

  async function forward(request, inlineSignin = false) {
    if (pending.has(request.id)) return errorResponse(request.id, 'DUPLICATE_REQUEST', '该请求正在处理中。');
    let nativePort;
    try { nativePort = connect(); }
    catch { return { ...errorResponse(request.id, 'NATIVE_UNAVAILABLE', '本机连接程序未安装或不可用。'), submissionNotStarted: true }; }
    return new Promise(resolve => {
      const timeout = setTimeout(async () => {
        pending.delete(request.id);
        if (financial(request.method)) {
          const guard = await readGuard();
          if (guard) await writeGuard({ ...guard, status: 'UNKNOWN' });
        }
        resolve(errorResponse(request.id, financial(request.method) ? 'UNKNOWN' : 'TIMEOUT',
          financial(request.method) ? '交易响应超时，结果待核验。不会自动重发。' : '本机钱包响应超时，请刷新状态。'));
      }, requestTimeoutMs(request.method));
      pending.set(request.id, { resolve, timeout, request, inlineSignin });
      try { nativePort.postMessage(request); }
      catch {
        clearTimeout(timeout); pending.delete(request.id);
        resolve(errorResponse(request.id, financial(request.method) ? 'UNKNOWN' : 'NATIVE_UNAVAILABLE', '发送结果不确定，请核验状态。'));
      }
    });
  }

  async function handle(message, sender) {
    let request;
    try { request = validateRequest(message, sender, api.runtime.id); }
    catch (error) { return errorResponse(message?.id, 'FORBIDDEN', error.message); }
    tabs.add(sender.tab.id);
    if(request.method==='openWallet') {
      await api.tabs.create({url:api.runtime.getURL('wallet.html')});return {id:request.id,ok:true,data:{}};
    }
    if(request.method==='openFour') {
      await api.tabs.create({url:api.runtime.getURL('four.html')+(request.params.tokenAddress?'#'+request.params.tokenAddress:'')});return {id:request.id,ok:true,data:{}};
    }
    if(request.method==='openTrade') {
      await api.tabs.create({url:api.runtime.getURL('trade.html')+(request.params.tokenAddress?'#'+request.params.tokenAddress:'')});return {id:request.id,ok:true,data:{}};
    }
    if (!financial(request.method)) {
      const response = await forward(request, sender.url===`chrome-extension://${api.runtime.id}/wallet.html`||isTradePage(sender.url,api.runtime.id));
      response.guard = await readGuard();
      return response;
    }
    // Hold a process gate around storage reservation, not around the network.
    let release;
    const previous = tradeGate;
    tradeGate = new Promise(resolve => { release = resolve; });
    await previous;
    try {
      const guard = await readGuard();
      if (guard) return { ...errorResponse(request.id, 'TRADE_PENDING', '已有交易等待核验，请勿重复提交。'), guard };
      await writeGuard({ intentId: request.params.intentId, action: request.method==='transfer'?'transfer':['fourExecute','panelExecute'].includes(request.method)?'panel':request.params.action,
        status: 'PENDING', startedAt: Date.now(), profile: request.params.profile });
    } finally { release(); }
    const response = await forward(request);
    if (response.submissionNotStarted) {
      const guard = await readGuard();
      if (guard?.intentId === request.params.intentId) await writeGuard(null);
    }
    response.guard = await readGuard();
    return response;
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    handle(message, sender).then(sendResponse).catch(() => sendResponse(errorResponse(message?.id, 'BRIDGE_ERROR', '连接程序状态异常，请刷新核验。')));
    return true;
  });
  api.action?.onClicked.addListener(()=>api.tabs.create({url:api.runtime.getURL('trade.html')}));
  return { handle };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) installBridge(chrome);
