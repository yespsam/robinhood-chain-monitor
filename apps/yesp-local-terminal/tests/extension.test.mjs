import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { validateRequest, isAllowedPage, isOfficialSigninUrl, installBridge, HOST_NAME, GUARD_KEY, requestTimeoutMs } from '../extension/background.js';

const extensionId = 'elekekjeabljofoefoccekebfdalomfp';
const sender = { id: extensionId, frameId: 0, url: 'https://flap.sh/apps/agent-bonding-curve?lang=zh', tab: { id: 7, url: 'https://flap.sh/apps/agent-bonding-curve?lang=zh' } };
const intentId = 'b05fb1b0-9f2e-4aaf-89ab-6e5bca58f87d';
const pageBinding={expectedMarket:'0xeddc6C5736CD9f280bE750c408D36c8d6E1a473d',expectedToken:'0x2222222222222222222222222222222222222222'};
const request = (method, params = {}, id = 'request_0001') => ({ id, method, params: { profile: 'heyi', ...(['prepare','trade'].includes(method)?pageBinding:{}),...params } });
const trade = () => request('trade', { action: 'buy', intentId, deadlineMs: 15000 });
const tick = () => new Promise(resolve => setImmediate(resolve));

function mockChrome({ guard = null, connectionFailure = false } = {}) {
  const storage = { [GUARD_KEY]: guard }, posted = [], sent = [], opened = [];
  const listeners = {};
  let connections = 0;
  const port = {
    onMessage: { addListener(fn) { listeners.nativeMessage = fn; } },
    onDisconnect: { addListener(fn) { listeners.disconnect = fn; } },
    postMessage(message) { posted.push(structuredClone(message)); },
  };
  const api = {
    runtime: { id: extensionId, lastError: null,
      connectNative(name) { assert.equal(name, HOST_NAME); connections++; if (connectionFailure) throw Error('missing host'); return port; },
      onMessage: { addListener(fn) { listeners.runtimeMessage = fn; } },
    },
    storage: { local: {
      async get(key) { return { [key]: storage[key] }; },
      async set(values) { Object.assign(storage, structuredClone(values)); },
    } },
    tabs: { async sendMessage(...args) { sent.push(args); }, async create(args) { opened.push(args); } },
  };
  return { api, storage, posted, sent, opened, listeners, get connections() { return connections; } };
}

test('manifest grants only native messaging and storage and pins the expected extension ID', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['nativeMessaging', 'storage']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.externally_connectable, undefined);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://flap.sh/apps/agent-bonding-curve*']);
  assert.equal(manifest.content_scripts[0].all_frames, false);
  const derived = createHash('sha256').update(Buffer.from(manifest.key, 'base64')).digest('hex').slice(0, 32).replace(/[0-9a-f]/g, char => String.fromCharCode(97 + parseInt(char, 16)));
  assert.equal(derived, extensionId);
});

test('runtime messages require own extension, top frame, exact page, known method and fixed profile', () => {
  assert.deepEqual(validateRequest(trade(), sender, extensionId), trade());
  for (const badSender of [{ ...sender, id: 'other' }, { ...sender, frameId: 1 }, { ...sender, url: 'https://evil.test/' },
    { ...sender, tab: { id: 7, url: 'https://flap.sh/apps/agent-bonding-curve-evil' } }]) {
    assert.throws(() => validateRequest(trade(), badSender, extensionId));
  }
  for (const message of [request('execute'), request('status', { contract: '0x123' }),
    request('trade', { action: 'transfer', intentId, deadlineMs: 15000 }),
    request('trade', { action: 'buy', intentId, deadlineMs: 30000 }),
    request('trade', { action: 'buy', intentId: 'duplicate', deadlineMs: 15000 }),
    { ...request('status'), params: { profile: 'unverified' } }]) {
    assert.throws(() => validateRequest(message, sender, extensionId));
  }
  assert.equal(isAllowedPage('https://flap.sh/apps/agent-bonding-curve?lang=zh'), true);
  assert.equal(isAllowedPage('https://flap.sh.evil.test/apps/agent-bonding-curve'), false);
});

test('startup status is read-only and forwards no extra credentials or contract inputs', async () => {
  const mock = mockChrome(); const bridge = installBridge(mock.api);
  const pending = bridge.handle(request('status'), sender); await tick();
  assert.deepEqual(mock.posted, [request('status')]);
  assert.equal(mock.storage[GUARD_KEY], null);
  await mock.listeners.nativeMessage({ id: 'request_0001', ok: true, data: { state: { connected: false } } });
  assert.equal((await pending).ok, true);
});

test('concurrent trade clicks reserve one persistent intent and never submit twice', async () => {
  const mock = mockChrome(); const bridge = installBridge(mock.api);
  const first = bridge.handle(trade(), sender);
  const second = bridge.handle({ ...trade(), id: 'request_0002' }, sender);
  await tick();
  assert.equal(mock.posted.length, 1);
  assert.equal((await second).error.code, 'TRADE_PENDING');
  assert.equal(mock.storage[GUARD_KEY].intentId, intentId);
  await mock.listeners.nativeMessage({ id: 'request_0001', ok: true, data: { operation: { intentId, status: 'SUBMITTED', txHash: `0x${'1'.repeat(64)}` } } });
  assert.equal((await first).guard.status, 'SUBMITTED');
});

test('worker recreation preserves UNKNOWN guard and status can reconcile only the same intent', async () => {
  const mock = mockChrome({ guard: { intentId, status: 'UNKNOWN', profile: 'heyi' } });
  const bridge = installBridge(mock.api);
  assert.equal((await bridge.handle(trade(), sender)).error.code, 'TRADE_PENDING');
  assert.equal(mock.posted.length, 0);
  const pending = bridge.handle(request('status'), sender); await tick();
  await mock.listeners.nativeMessage({ id: 'request_0001', ok: true, data: { operation: { intentId: 'other', status: 'CONFIRMED' } } });
  assert.equal((await pending).guard.status, 'UNKNOWN');
  const reconciled = bridge.handle(request('status', {}, 'request_0003'), sender); await tick();
  await mock.listeners.nativeMessage({ id: 'request_0003', ok: true, data: { operation: { intentId, status: 'CONFIRMED' } } });
  assert.equal((await reconciled).guard, null);
});

test('native disconnect marks the submitted intent UNKNOWN and does not resend on reconnect', async () => {
  const mock = mockChrome(); const bridge = installBridge(mock.api);
  const pending = bridge.handle(trade(), sender); await tick();
  await mock.listeners.disconnect();
  assert.equal((await pending).error.code, 'UNKNOWN');
  assert.equal(mock.storage[GUARD_KEY].status, 'UNKNOWN');
  assert.equal(mock.posted.length, 1);
  const status = bridge.handle(request('status', {}, 'request_0002'), sender); await tick();
  assert.equal(mock.connections, 2);
  assert.equal(mock.posted[1].method, 'status');
  await mock.listeners.nativeMessage({ id: 'request_0002', ok: true, data: {} }); await status;
  assert.equal(mock.posted.filter(q => q.method === 'trade').length, 1);
});

test('a missing native host before sending does not leave a permanently locked intent', async () => {
  const mock = mockChrome({ connectionFailure: true }); const bridge = installBridge(mock.api);
  const result = await bridge.handle(trade(), sender);
  assert.equal(result.error.code, 'NATIVE_UNAVAILABLE');
  assert.equal(mock.posted.length, 0);
  assert.equal(result.guard, null);
});

test('progress is display-only and cannot release the persistent uncertain-trade guard', async () => {
  const mock = mockChrome({ guard: { intentId, status: 'UNKNOWN', profile: 'heyi' } });
  const bridge = installBridge(mock.api);
  const pending = bridge.handle(request('status'), sender); await tick();
  await mock.listeners.nativeMessage({ event: 'progress', data: { operation: { intentId, status: 'CONFIRMED' } } });
  assert.equal(mock.storage[GUARD_KEY].status, 'UNKNOWN');
  assert.equal(mock.sent.length, 1);
  await mock.listeners.nativeMessage({ id: 'request_0001', ok: true, data: { operation: { intentId, status: 'CONFIRMED' } } });
  assert.equal((await pending).guard, null);
});

test('only a matching native trade failure can release a guard via submissionNotStarted', async () => {
  const mock = mockChrome(); const bridge = installBridge(mock.api);
  const pending = bridge.handle(trade(), sender); await tick();
  await mock.listeners.nativeMessage({ id: 'unsolicited', ok: false, submissionNotStarted: true, error: { code: 'READ_FAILED' } });
  assert.equal(mock.storage[GUARD_KEY].intentId, intentId);
  await mock.listeners.nativeMessage({ id: 'request_0001', ok: false, submissionNotStarted: true, error: { code: 'LOGIN_REQUIRED', message: 'Sign in first.' } });
  const response = await pending;
  assert.equal(response.error.code, 'LOGIN_REQUIRED');
  assert.equal(response.guard, null);
  const second = bridge.handle({ ...trade(), id: 'request_0002' }, sender); await tick();
  await mock.listeners.nativeMessage({ id: 'request_0002', ok: false, error: { code: 'OPERATION_FAILED' } });
  assert.equal((await second).guard.intentId, intentId);
  const status = bridge.handle(request('status', {}, 'request_0003'), sender); await tick();
  await mock.listeners.nativeMessage({ id: 'request_0003', ok: false, submissionNotStarted: true, error: { code: 'READ_FAILED' } });
  assert.equal((await status).guard.intentId, intentId);
});

test('verify accommodates the official five-minute wait without extending the trade response timeout', () => {
  assert.equal(requestTimeoutMs('verify'), 315000);
  assert.equal(requestTimeoutMs('trade'), 20000);
  assert.equal(requestTimeoutMs('status'), 12000);
});

test('only an explicit signin response can open an official Binance login page', async () => {
  const mock = mockChrome(); const bridge = installBridge(mock.api);
  assert.equal(isOfficialSigninUrl('https://web3.binance.com/zh-CN/agent-login?x=1'), true);
  assert.equal(isOfficialSigninUrl('https://web3.binance.com.evil.test/agent-login'), false);
  assert.equal(isOfficialSigninUrl('javascript:alert(1)'), false);
  assert.equal(isOfficialSigninUrl('https://app.binance.com/vendor-generated/login?opaque=1'), true);
  const pending = bridge.handle(request('signin'), sender); await tick();
  await mock.listeners.nativeMessage({ id: 'request_0001', ok: true, data: { urlForWeb: 'https://web3.binance.com/zh-CN/agent-login?x=1' } }); await pending;
  assert.equal(mock.opened.length, 1);
  assert.equal(mock.opened[0].url,'https://web3.binance.com/zh-CN/agent-login?x=1');
  assert.equal(mock.opened[0].active,true);
  await mock.listeners.nativeMessage({ id: 'unsolicited', ok: true, data: { urlForWeb: 'https://web3.binance.com/zh-CN/agent-login' } });
  assert.equal(mock.opened.length, 1);
});

test('browser tab creation failure still returns the official URL for the manual login link',async()=>{
  const mock=mockChrome();mock.api.tabs.create=async()=>{throw Error('tab unavailable');};
  const bridge=installBridge(mock.api),pending=bridge.handle(request('signin'),sender);await tick();
  const urlForWeb='https://web3.binance.com/en/agent-login?url=example%2Bopaque';
  await mock.listeners.nativeMessage({id:'request_0001',ok:true,data:{urlForWeb}});
  assert.equal((await pending).data.urlForWeb,urlForWeb);
});

test('wallet signin keeps its inline QR visible while opening the official page in a background tab',async()=>{
  const mock=mockChrome(),bridge=installBridge(mock.api),url=`chrome-extension://${extensionId}/wallet.html`;
  const pending=bridge.handle(request('signin'),{...sender,url,tab:{id:7,url}});await tick();
  await mock.listeners.nativeMessage({id:'request_0001',ok:true,data:{urlForWeb:'https://web3.binance.com/en/agent-login?url=example'}});await pending;
  assert.equal(mock.opened[0].active,false);
});

test('content script isolates DOM and does not accept website messages or auto-submit trades', async () => {
  const content = await readFile(new URL('../extension/content.js', import.meta.url), 'utf8');
  assert.match(content, /attachShadow\(\{ mode: 'closed' \}\)/);
  assert.doesNotMatch(content, /innerHTML|window\.postMessage|addEventListener\(['"]message['"]|document\.querySelector/);
  assert.match(content, /trade\.addEventListener\('click', async event => \{\s*if \(!event\.isTrusted/);
  assert.match(content, /signin\.addEventListener\('click', async event => \{\s*if \(!event\.isTrusted/);
  assert.match(content, /verify\.addEventListener\('click', async event => \{\s*if \(!event\.isTrusted/);
  assert.match(content, /pairingValue\.textContent = String\(next\.pairingCode\)/);
  assert.match(content, /syncPage\(\);render\(\); updateStatus\(\);/);
  assert.match(content, /setInterval\(\(\) => \{ if \(!document\.hidden && !busy\) updateStatus\(\); \}, 15000\)/);
});

async function mockPanel({ state = {}, readiness = {}, operation, reply, selection } = {}) {
  const nodes = [], methods = [], messages=[],intervals=[];
  let choice=selection===undefined?{marketAddress:pageBinding.expectedMarket,tokenAddress:pageBinding.expectedToken,predicted:true,name:'Current token'}:selection;
  class FakeNode {
    constructor(tag) { this.tagName = tag; this.children = []; this.style = {}; this.dataset = {}; this.listeners = {}; this.classList = { toggle() {} }; nodes.push(this); }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    addEventListener(name, listener) { this.listeners[name] = listener; }
    attachShadow() { return new FakeNode('shadow'); }
  }
  const win = {}; win.top = win;
  const snapshot = {
    profile: { id: 'heyi', market: '0xeddc6C5736CD9f280bE750c408D36c8d6E1a473d', wallet: '0x1111111111111111111111111111111111111111' },
    state: { connected: true, phase: 1, shares: '10', balance: '5', native: '0.02', ...state },
    readiness: { buy: true, sell: true, claim: false, blockers: [], ...readiness },
    ...(operation === undefined ? {} : { operation }),
  };
  let seq = 0;
  const runtime = {
    id: 'fixture', getURL: () => 'fixture.css', onMessage: { addListener() {} },
    async sendMessage(message) {
      methods.push(message.method);
      messages.push(message);
      if(message.method==='flapInspect')return {id:message.id,ok:true,data:{market:{marketAddress:message.params.marketAddress,predictedToken:message.params.tokenAddress,tokenAddress:'0x'+'0'.repeat(40),name:choice?.name||'Current token',quoteSymbol:'BNCB',pool:'1',cap:'10'}}};
      return message.method === 'status' ? { id: message.id, ok: true, guard: null, data: snapshot }
        : reply ? reply(message) : { id: message.id, ok: true, guard: null, data: {} };
    },
  };
  const context = vm.createContext({ window: win,
    location: { origin: 'https://flap.sh', pathname: '/apps/agent-bonding-curve' },
    document: { createElement: tag => new FakeNode(tag), documentElement: new FakeNode('html'), hidden: false },
    chrome: { runtime }, crypto: { randomUUID: () => `fixture_request_${++seq}` }, setInterval(fn,ms) {intervals.push({fn,ms});}, Date,
    YespFlapPage:{read:()=>choice},
  });
  vm.runInContext(await readFile(new URL('../extension/content.js', import.meta.url), 'utf8'), context);
  await tick(); await tick();
  return {
    nodes, methods, messages,node: cls => nodes.find(n => n.className === cls),byId:id=>nodes.find(n=>n.id===id),
    async changePage(next,{scan=true}={}){choice=next;if(scan)for(const i of intervals)if(i.ms===500)i.fn();await tick();await tick();},
    async select(action) { nodes.find(n => n.dataset.action === action).listeners.click({ isTrusted: true }); await tick(); },
  };
}

test('any nonterminal operation, including an unfamiliar or empty status, disables another trade', async () => {
  for (const operation of [{ intentId, status: 'WAITING_FOR_APP_APPROVAL' }, { intentId }, {}]) {
    const panel = await mockPanel({ operation });
    assert.equal(panel.node('trade').disabled, true);
    assert.match(panel.node('trade').textContent, /待核验/);
    assert.ok(panel.methods.includes('flapInspect'));assert.equal(panel.methods.includes('trade'),false);
  }
  const complete = await mockPanel({ operation: { intentId, status: 'COMPLETE' } });
  assert.equal(complete.node('trade').disabled, false);
});

test('backend readiness false and zero holdings each disable the corresponding trade', async () => {
  const unavailable = await mockPanel({ readiness: { buy: false, sell: false } });
  assert.equal(unavailable.node('trade').disabled, true);
  await unavailable.select('sell'); assert.equal(unavailable.node('trade').disabled, true);
  const empty = await mockPanel({ state: { shares: '0.000000000000000000' }, readiness: { sell: true } });
  await empty.select('sell'); assert.equal(empty.node('trade').disabled, true);
  const holding = await mockPanel({ state: { shares: '0.000000000000000001' } });
  await holding.select('sell'); assert.equal(holding.node('trade').disabled, false);
});

test('claim uses nominal claim quantity and explains possible transfer tax', async () => {
  const panel = await mockPanel({ state: { phase: 3 }, readiness: { claim: true }, reply: message => ({ id: message.id, ok: true, data: { plan: { action: 'claim', claim: '123456.75', shares: '9999' } } }) });
  await panel.select('claim');
  await panel.node('prepare').listeners.click({ isTrusted: true });
  const preview = panel.node('preview');
  assert.equal(preview.children[0].textContent, '名义可领取数量');
  assert.equal(preview.children[1].textContent, '123,456.75');
  assert.match(panel.node('rule').textContent, /实际到账可能扣税/);
});

test('blockers and real refusal or timeout codes are shown in readable Chinese', async () => {
  const blockers = await mockPanel({ readiness: { blockers: ['ALLOWANCE_REQUIRED', 'INSUFFICIENT_GAS', 'PENDING_TRANSACTION'] } });
  assert.match(blockers.node('preparation').textContent, /授权 BNCB/);
  assert.match(blockers.node('preparation').textContent, /不足以支付网络费/);
  assert.match(blockers.node('preparation').textContent, /等待确认/);
  for (const [code, expected] of [['OFFICIAL_REJECTED', /币安拒绝/], ['TIMEOUT', /等待超时/], ['SUBMISSION_DEADLINE_EXCEEDED', /15 秒内未完成提交/]]) {
    const panel = await mockPanel({ reply: message => ({ id: message.id, ok: false, error: { code, message: 'Official request failed.' } }) });
    await panel.node('prepare').listeners.click({ isTrusted: true });
    assert.match(panel.node('activity').children[1].textContent, expected);
  }
});
test('Flap CA follows selections on the same URL and removes stale Heyi holdings and quotes',async()=>{
  const panel=await mockPanel();assert.equal(panel.byId('yesp-current-ca').textContent,pageBinding.expectedToken);assert.equal(panel.node('trade').disabled,false);
  const next={marketAddress:'0x3333333333333333333333333333333333333333',tokenAddress:'0x4444444444444444444444444444444444444444',name:'New coin',predicted:true};
  await panel.changePage(next);assert.equal(panel.byId('yesp-current-ca').textContent,next.tokenAddress);assert.equal(panel.byId('yesp-current-market').textContent,next.marketAddress);
  assert.equal(panel.nodes.find(n=>n.tagName==='h1').textContent,'New coin');assert.equal(panel.node('holding').textContent,'—');assert.equal(panel.node('trade').disabled,true);
  await panel.node('trade').listeners.click({isTrusted:true});assert.equal(panel.methods.includes('trade'),false);
  await panel.changePage(null);assert.equal(panel.byId('yesp-current-ca').textContent,'—');assert.equal(panel.node('trade').disabled,true);
});
test('Flap re-reads page at click time and prevents stale submission before the observer runs',async()=>{
  const panel=await mockPanel();await panel.changePage({marketAddress:'0x3333333333333333333333333333333333333333',tokenAddress:pageBinding.expectedToken,name:'Changed'}, {scan:false});
  await panel.node('trade').listeners.click({isTrusted:true});assert.equal(panel.methods.includes('trade'),false);
});
test('an in-flight old-market quote cannot repopulate the new selection',async()=>{
  let finish;const panel=await mockPanel({reply:message=>new Promise(resolve=>{finish=()=>resolve({id:message.id,ok:true,data:{plan:{action:'buy',gross:'999',minShares:'900'}}});})});
  const preparing=panel.node('prepare').listeners.click({isTrusted:true});await tick();
  await panel.changePage({marketAddress:'0x3333333333333333333333333333333333333333',tokenAddress:'0x4444444444444444444444444444444444444444',name:'New'});
  finish();await preparing;assert.equal(panel.node('preview').children.some(n=>/999|900/.test(n.textContent||'')),false);assert.equal(panel.node('trade').disabled,true);
});
test('Flap financial requests bind both market and CA, while unbound requests and cross-site inspection fail',()=>{
  const message=trade();delete message.params.expectedMarket;assert.throws(()=>validateRequest(message,sender,extensionId));
  const inspect=request('flapInspect',{marketAddress:pageBinding.expectedMarket,tokenAddress:pageBinding.expectedToken});assert.equal(validateRequest(inspect,sender,extensionId).method,'flapInspect');
  const four={...sender,url:'https://four.meme/',tab:{id:7,url:'https://four.meme/'}};assert.throws(()=>validateRequest(inspect,four,extensionId));
});
