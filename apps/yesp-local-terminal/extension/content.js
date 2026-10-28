(() => {
  'use strict';
  if (window.top !== window || location.origin !== 'https://flap.sh' || location.pathname !== '/apps/agent-bonding-curve') return;
  if(document.getElementById?.('yesp-flap-trading-panel'))return;
  const PROFILE = 'heyi';
  const TERMINAL = new Set(['CONFIRMED', 'COMPLETE', 'COMPLETED', 'FAILED', 'REJECTED', 'CANCELLED']);
  const host = document.createElement('div');
  host.id = 'yesp-flap-trading-panel';
  host.style.cssText = 'all:initial!important;position:fixed!important;right:18px!important;top:18px!important;z-index:2147483647!important;display:block!important;';
  const shadow = host.attachShadow({ mode: 'closed' });
  const sheet = document.createElement('link');
  sheet.rel = 'stylesheet'; sheet.href = chrome.runtime.getURL('panel.css'); shadow.append(sheet);
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const panel = el('aside', 'panel'); panel.setAttribute('aria-label', 'YESP 本机交易台'); shadow.append(panel);
  const header = el('header', 'header');
  const brand = el('div', 'brand', 'YESP'); brand.append(el('span', '', '本机交易台'));
  const collapse = el('button', 'collapse', '−'); collapse.type = 'button'; collapse.setAttribute('aria-label', '折叠交易台'); collapse.setAttribute('aria-expanded', 'true');
  header.append(brand, collapse); panel.append(header);
  const body = el('div', 'body'); panel.append(body);
  const connection = el('div', 'connection'); const light = el('span', 'light'); const connectionText = el('span', '', '连接本机钱包…');
  connection.append(light, connectionText); body.append(connection);
  const titleRow = el('div', 'title-row'); const title = el('h1', '', '请选择代币'); const phase = el('span', 'phase', '等待页面选择'); titleRow.append(title, phase); body.append(titleRow);
  const current = el('div','address-block');const caLabel=el('span','','当前代币 CA'),caText=el('code','','—'),marketLabel=el('span','','Market 市场地址'),marketText=el('code','','—');
  caText.id='yesp-current-ca';marketText.id='yesp-current-market';current.append(caLabel,caText,marketLabel,marketText);body.append(current);
  const pageNotice=el('p','preparation page-notice','在网页选择代币后自动识别。');body.append(pageNotice);
  const openTrade=el('button','prepare unified-entry','在统一面板交易当前 CA ↗');openTrade.type='button';body.append(openTrade);
  openTrade.addEventListener('click',e=>{if(e.isTrusted)request('openTrade',selection?.tokenAddress?{tokenAddress:selection.tokenAddress}:{});});
  const holdingLabel = el('div', 'eyebrow', '当前持仓 · 份'); const holding = el('div', 'holding', '—'); body.append(holdingLabel, holding);
  const balances = el('div', 'balances');
  function balanceRow(label) { const row = el('div', 'balance-row'); const value = el('strong', '', '—'); row.append(el('span', '', label), value); balances.append(row); return value; }
  const quoteBalance = balanceRow('报价资产余额'); const nativeBalance = balanceRow('可用 BNB'); body.append(balances);
  const modes = el('div', 'modes'); modes.setAttribute('role', 'tablist'); const modeButtons = {};
  for (const [action, label] of [['buy', '买入'], ['sell', '卖出'], ['claim', '领取']]) {
    const button = el('button', 'mode', label); button.type = 'button'; button.setAttribute('role', 'tab'); button.dataset.action = action;
    modeButtons[action] = button; modes.append(button);
  }
  body.append(modes);
  const form = el('section', 'trade-form'); const amountLabel = el('div', 'eyebrow'); const amount = el('div', 'amount'); const rule = el('p', 'rule'); form.append(amountLabel, amount, rule);
  const preview = el('dl', 'preview');
  function previewRow(label) { const name = el('dt', '', label); const value = el('dd', '', '—'); preview.append(name, value); return { name, value }; }
  const estimate = previewRow('预计支出'); const minimum = previewRow('最低获得'); const slip = previewRow('滑点上限'); form.append(preview);
  const preparation = el('p', 'preparation'); preparation.hidden = true; form.append(preparation);
  const prepare = el('button', 'prepare', '更新报价'); prepare.type = 'button';
  const trade = el('button', 'trade', '买入 1% 额度'); trade.type = 'button'; trade.disabled = true;
  form.append(prepare, trade, el('p', 'deadline', '目标 15 秒内提交 · 成交时间由链上决定'));
  body.append(form);
  const loginRow = el('div', 'login-row'); const signin = el('button', 'secondary', '扫码连接'); const verify = el('button', 'secondary', '我已扫码'); signin.type = verify.type = 'button'; loginRow.append(signin, verify); body.append(loginRow);
  const pairing = el('div', 'pairing'); pairing.hidden = true;
  const pairingValue = el('code', 'pairing-code'); pairing.append(el('span', '', '币安配对码'), pairingValue); body.append(pairing);
  const activity = el('div', 'activity'); activity.setAttribute('role', 'status'); activity.setAttribute('aria-live', 'polite');
  const activityTitle = el('strong', '', '等待连接'); const activityMessage = el('p', '', '通过本机钱包执行，不读取网页钱包。');
  const txLink = el('a', 'tx-link', '查看链上交易 ↗'); txLink.hidden = true; txLink.target = '_blank'; txLink.rel = 'noopener noreferrer'; activity.append(activityTitle, activityMessage, txLink); body.append(activity);
  const details = el('details', 'details'); details.append(el('summary', '', '已核验市场与钱包'));
  const addressBlock = el('div', 'address-block'); const verifiedAddress=el('code','','尚未核验');addressBlock.append(el('span', '', 'BSC · 本机已核验交易市场'), verifiedAddress);
  const walletText = el('code', '', '等待钱包连接'); addressBlock.append(el('span', '', '交易钱包'), walletText); details.append(addressBlock); body.append(details);
  const footer = el('footer', 'footer'); const stamp = el('span', '', 'YESP 0.4.0'); const refresh = el('button', 'refresh', '刷新状态'); refresh.type = 'button'; footer.append(stamp, refresh); body.append(footer);
  const openWallet = el('button', 'prepare', '打开钱包 · 代币转出 ↗'); openWallet.type='button'; body.append(openWallet); openWallet.addEventListener('click', e=>{if(e.isTrusted)request('openWallet');});
  document.documentElement.append(host);

  let selected = 'buy', data = {}, guard = null, connected = false, busy = false, lastStatusAt = 0, polling = false;
  let selection=null,selectionKey='',generation=0,pageVerified=false,scanQueued=false,quoteSymbol='报价资产';
  const sameAddress=(a,b)=>typeof a==='string'&&typeof b==='string'&&a.toLowerCase()===b.toLowerCase();
  const bound=()=>pageVerified&&selection&&sameAddress(data.profile?.market,selection.marketAddress);
  function syncPage(){
    const allowed=location.origin==='https://flap.sh'&&location.pathname==='/apps/agent-bonding-curve';host.hidden=!allowed;
    const next=allowed?globalThis.YespFlapPage?.read():null;
    const key=next?next.marketAddress.toLowerCase()+':'+next.tokenAddress.toLowerCase():'';
    if(key===selectionKey)return false;
    selection=next;selectionKey=key;generation++;pageVerified=false;data={};lastStatusAt=0;quoteSymbol='报价资产';
    title.textContent=next?.name||'请选择代币';caLabel.textContent=next?.predicted?'预测代币 CA（发射前）':'当前代币 CA';caText.textContent=next?.tokenAddress||'—';marketText.textContent=next?.marketAddress||'—';
    verifiedAddress.textContent='尚未核验';pageNotice.textContent=next?'已读取页面地址，正在核验市场与 CA。':'请在网页进入具体代币的市场详情；旧市场数据已清除。';
    setMessage(next?'已切换当前代币':'等待选择代币',next?'旧报价已清除，正在核对当前地址。':'不会沿用上一个代币的交易配置。');render();
    if(next)void inspectPage();return true;
  }
  async function inspectPage(){
    if(!selection)return;const revision=generation,chosen={...selection};
    const result=await request('flapInspect',{marketAddress:chosen.marketAddress,tokenAddress:chosen.tokenAddress});
    syncPage();if(revision!==generation||!result?.market)return;
    const m=result.market;
    if(!sameAddress(m.marketAddress,chosen.marketAddress)||!sameAddress(chosen.tokenAddress,m.predictedToken)&&!sameAddress(chosen.tokenAddress,m.tokenAddress)){pageNotice.textContent='页面 CA 与链上市场不一致，已停止操作。';return;}
    pageVerified=true;quoteSymbol=m.quoteSymbol;title.textContent=m.name||chosen.name||m.symbol||'当前代币';
    caLabel.textContent=/^0x0{40}$/i.test(m.tokenAddress)?'预测代币 CA（发射前）':'代币 CA';
    pageNotice.textContent=`链上地址已核对 · ${m.quoteSymbol} 池 ${m.pool} / ${m.cap}。交易还需匹配本机已核验配置。`;
    render();if(!polling)void updateStatus();
  }
  function setMessage(titleText, message, tone = '') { activityTitle.textContent = titleText; activityMessage.textContent = message; activity.dataset.tone = tone; }
  const errorMessages = {
    OFFICIAL_REJECTED: '币安拒绝了本次请求，请检查钱包状态与已完成步骤。',
    REJECTED: '本次请求已被拒绝，未继续执行后续步骤。',
    USER_REJECTED: '你已在钱包中拒绝本次请求，未继续执行后续步骤。',
    PREVIEW_REJECTED: '交易预演未通过，已停止提交。',
    PREVIEW_FAILED: '交易预演失败，已停止提交。',
    SUBMISSION_DEADLINE_EXCEEDED: '15 秒内未完成提交，已停止后续动作；已完成的准备步骤保留。',
    TIMEOUT: '请求等待超时，请刷新状态核验；不会自动重发。',
    UNKNOWN: '交易结果待核验，请勿重复提交。',
    SUBMISSION_UNKNOWN: '交易提交结果不确定，请刷新状态核验，切勿重复提交。',
    APP_CONFIRMATION_REQUIRED: '请在币安 App 确认此交易，结果确定前请勿重复提交。',
    TRANSACTION_REVERTED: '链上交易执行失败，已停止后续步骤。',
    LOGIN_REQUIRED: '钱包尚未登录，请先扫码连接。',
    INSUFFICIENT_GAS: 'BNB 不足以支付网络费，请先补足。',
    PENDING_TRANSACTION: '已有交易等待确认，请刷新状态核验。',
    READ_FAILED: '状态读取失败，请刷新后再操作。',
    PAGE_MARKET_MISMATCH:'当前网页市场与本机已核验交易配置不同，已阻止旧市场请求。',
    PROFILE_REVIEW_REQUIRED:'当前市场交易配置尚未核验；已识别的 CA 可查看，不能沿用旧币的配置交易。',
  };
  function readableError(code, message) {
    if (typeof message === 'string' && /\p{Script=Han}/u.test(message)) return message;
    return errorMessages[code] || errorMessages[message] || `操作未完成${code ? `（${String(code).slice(0, 80)}）` : ''}，请刷新状态核验。`;
  }
  function display(value, decimals = 6) {
    if (value === undefined || value === null || value === '') return '—';
    const text = String(value);
    if (!/^\d+(?:\.\d+)?$/.test(text)) return text.slice(0, 100);
    const [integer, fraction = ''] = text.split('.');
    return integer.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction ? `.${fraction.slice(0, decimals).replace(/0+$/, '') || '0'}` : '');
  }
  function stateAmount(name) {
    if (data.state?.[name] !== undefined) return data.state[name];
    const raw = data.state?.[`${name}Raw`];
    if (raw === undefined || !/^\d+$/.test(String(raw))) return undefined;
    const padded = String(raw).padStart(19, '0'); return `${padded.slice(0, -18)}.${padded.slice(-18)}`;
  }
  function render() {
    const state = bound()?data.state||{}:{}, operation = data.operation || {};
    const walletConnected = data.state?.connected === true;
    connectionText.textContent = connected ? walletConnected ? '本机钱包已连接' : data.state?.connected===false?'钱包未登录':'钱包状态待核验' : '本机连接已断开';
    light.dataset.connected = String(connected && walletConnected);
    phase.textContent = Number(state.phase) === 1 ? '内盘交易' : Number(state.phase) === 3 ? '已发射' : pageVerified?'CA 已核验':selection?'读取市场':'等待页面选择';
    holding.textContent = bound()?display(stateAmount('shares'), 4):'—'; quoteBalance.textContent = bound()?display(stateAmount('balance')):'—'; nativeBalance.textContent = bound()?display(stateAmount('native')):'—';
    walletText.textContent = data.profile?.wallet || '等待钱包连接';
    for (const [action, button] of Object.entries(modeButtons)) { button.classList.toggle('active', selected === action); button.setAttribute('aria-selected', String(selected === action)); }
    amountLabel.textContent = selected === 'buy' ? '购买额度' : selected === 'sell' ? '卖出比例' : '领取范围';
    amount.textContent = selected === 'buy' ? '1%' : selected === 'sell' ? '100%' : '全部';
    rule.textContent = selected === 'buy' ? '按机制补满单钱包 1% 限额' : selected === 'sell' ? '卖出全部份额，到账后兑换为 BNB' : '名义可领取数量；实际到账可能扣税';
    estimate.name.textContent = selected === 'buy' ? '预计支出' : selected === 'sell' ? '预计到账' : '名义可领取数量';
    const plan = !bound()||data.plan?.action && data.plan.action !== selected ? {} : data.plan || {};
    estimate.value.textContent = selected === 'buy' ? `${display(plan.gross)} ${quoteSymbol}` : selected === 'sell' ? `${display(plan.expectedOut)} ${quoteSymbol}` : display(plan.claim);
    minimum.name.textContent = selected === 'sell' ? '后续兑换' : '最低获得';
    minimum.value.textContent = selected === 'sell' ? 'BNB' : selected === 'claim' ? '—' : `${display(plan.minShares)} 份`;
    slip.value.textContent = selected === 'buy' ? '5%' : selected === 'sell' ? '99%' : '不适用';
    const blockers = Array.isArray(data.readiness?.blockers) ? data.readiness.blockers : [];
    const descriptions = { INSUFFICIENT_QUOTE: '需先兑换 BNCB，准备会增加用时', ALLOWANCE: '需先授权 BNCB，准备会增加用时', INSUFFICIENT_ALLOWANCE: '需先授权 BNCB，准备会增加用时', ALLOWANCE_REQUIRED: '需先授权 BNCB，准备会增加用时', INSUFFICIENT_GAS: 'BNB 不足以支付网络费', PENDING_TRANSACTION: '已有交易等待确认，请刷新核验', LOGIN_REQUIRED: '请先扫码连接钱包', MARKET_CLOSED: '当前阶段不可交易', UNKNOWN: '上一笔结果待核验' };
    const blockerText = blockers.map(b => typeof b === 'string' ? descriptions[b] || b : b.message || descriptions[b.code] || b.code || '').filter(Boolean).join('；');
    preparation.textContent = blockerText; preparation.hidden = !blockerText;
    const pending = Boolean(guard) || Boolean(data.operation) && !TERMINAL.has(String(operation.status || '').toUpperCase());
    const phaseAllowed = selected === 'claim' ? Number(state.phase) === 3 : Number(state.phase) === 1;
    const fresh = Date.now() - lastStatusAt < 30000;
    const sharesText = String(stateAmount('shares') ?? '');
    const noSharesToSell = selected === 'sell' && (!/^\d+(?:\.\d+)?$/.test(sharesText) || !/[1-9]/.test(sharesText));
    trade.disabled = !bound() || busy || Boolean(pending) || data.readiness?.[selected] === false || noSharesToSell || !connected || !walletConnected || !phaseAllowed || !fresh;
    trade.textContent = pending ? '交易待核验 · 请勿重复提交' : busy ? '正在处理…' : selected === 'buy' ? '买入 1% 额度' : selected === 'sell' ? '全部卖出并换 BNB' : '领取全部代币';
    prepare.disabled = !bound() || busy || !connected; signin.disabled = busy; verify.disabled = busy;
    loginRow.hidden = walletConnected; refresh.disabled = polling;
    txLink.hidden = !/^0x[0-9a-f]{64}$/i.test(operation.txHash || '');
    if (!txLink.hidden) txLink.href = `https://bscscan.com/tx/${operation.txHash}`;
  }
  function absorb(next) {
    if (!next || typeof next !== 'object') return;
    if (next.profile && (next.profile.id !== PROFILE || !selection || !sameAddress(next.profile.market,selection.marketAddress))) {
      data = {}; setMessage('市场交易配置不匹配', '当前 CA 已切换，本机旧市场配置不能用于这个代币。', 'warning'); return;
    }
    for (const key of ['profile', 'state', 'readiness', 'plan', 'operation', 'timings']) if (Object.hasOwn(next,key)) data[key] = next[key];
    if(next.profile)verifiedAddress.textContent=next.profile.market;
    if (next.guard !== undefined) guard = next.guard;
    if (next.pairingCode !== undefined) {
      pairingValue.textContent = String(next.pairingCode); pairing.hidden = false;
    }
    if (next.state?.connected === true) pairing.hidden = true;
    if (next.operation) {
      const status = String(next.operation.status || '').toUpperCase();
      const failed = ['FAILED', 'REJECTED', 'UNKNOWN'].includes(status);
      setMessage(status === 'UNKNOWN' ? '结果待核验' : status === 'REJECTED' ? '请求已拒绝' : status === 'FAILED' ? '操作未完成' : status === 'CONFIRMED' || status === 'COMPLETE' || status === 'COMPLETED' ? '交易已完成' : '交易进度',
        failed ? readableError(next.operation.error?.code || status, next.operation.message) : next.operation.message || status, failed ? 'warning' : '');
    } else if (next.message) setMessage(next.stage || '交易进度', next.message);
  }
  async function request(method, params = {}) {
    if(['status','prepare','trade'].includes(method))syncPage();
    if(['prepare','trade'].includes(method)&&!bound()){setMessage('请重新核验当前市场','页面市场或 CA 已改变，旧报价不可提交。','warning');render();return null;}
    const revision=generation;
    if(['status','prepare','trade'].includes(method)&&selection)params={...params,expectedMarket:selection.marketAddress,expectedToken:selection.tokenAddress};
    const message = { id: crypto.randomUUID(), method, params: { profile: PROFILE, ...params } };
    let response;
    try { response = await chrome.runtime.sendMessage(message); }
    catch { connected = false; if (method === 'trade') guard = { intentId: params.intentId, status: 'UNKNOWN' }; setMessage(method === 'trade' ? '结果待核验' : '本机连接不可用', method === 'trade' ? '本机连接中断，请刷新状态核验，切勿重复提交。' : '检查扩展和本机连接程序后刷新状态。', 'warning'); render(); return null; }
    if (response?.guard !== undefined) guard = response.guard;
    syncPage();if(revision!==generation&&['status','prepare','trade','flapInspect'].includes(method)){render();return null;}
    if (!response?.ok) {
      const code = response?.error?.code;
      if (code === 'NATIVE_UNAVAILABLE') connected = false;
      if (method === 'trade' && ['UNKNOWN', 'SUBMISSION_UNKNOWN', 'APP_CONFIRMATION_REQUIRED', 'TIMEOUT', 'BRIDGE_ERROR'].includes(code)) guard ||= { intentId: params.intentId, status: 'UNKNOWN' };
      setMessage(code === 'UNKNOWN' || code === 'SUBMISSION_UNKNOWN' || code === 'TRADE_PENDING' ? '结果待核验' : code === 'OFFICIAL_REJECTED' || code === 'USER_REJECTED' ? '请求已拒绝' : '暂时无法操作', readableError(code, response?.error?.message), 'warning');
      render(); return null;
    }
    connected = true; if(method!=='flapInspect')absorb(response.data);
    if (method === 'status' && !lastStatusAt && !response.data?.operation && connected) {
      setMessage(response.data?.state?.connected ? '钱包已连接' : '请扫码连接钱包',
        response.data?.state?.connected ? '选择操作后点击按钮，使用当前本机钱包提交。' : '点击「扫码连接」，在币安 App 完成登录。');
    }
    if (response.data?.state) { lastStatusAt = Date.now(); stamp.textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`; }
    render(); return response.data;
  }
  async function updateStatus() {
    if (polling) return;
    polling = true; render();
    await request('status'); polling = false; render();
  }
  for (const [action, button] of Object.entries(modeButtons)) button.addEventListener('click', event => {
    if (!event.isTrusted || busy) return;
    selected = action; data.plan = {}; render();
  });
  prepare.addEventListener('click', async event => {
    if (!event.isTrusted || busy) return;syncPage();if(prepare.disabled)return;
    busy = true; setMessage('更新报价', '读取最新市场、持仓与准备步骤。'); render();
    const result = await request('prepare', { action: selected });
    if (result?.planError) { data.plan=null; setMessage('报价不可用',readableError(result.planError.code),'warning'); } else if (result?.plan && !result.operation) setMessage('报价已更新', '点击交易按钮提交；执行前会再次核验。');
    busy = false; render();
  });
  trade.addEventListener('click', async event => {
    if (!event.isTrusted) return;syncPage();if (trade.disabled || busy || guard) return;
    busy = true;
    const intentId = crypto.randomUUID(); guard = { intentId, status: 'PENDING' };
    setMessage('正在提交', '执行必要准备并提交；请勿重复点击。'); render();
    await request('trade', { action: selected, intentId, deadlineMs: 15000 });
    busy = false; render();
    await updateStatus();
  });
  signin.addEventListener('click', async event => {
    if (!event.isTrusted || busy) return;
    busy = true; render(); setMessage('打开扫码登录', '在币安页面扫码，完成后点击「我已扫码」。');
    await request('signin'); busy = false; render();
  });
  verify.addEventListener('click', async event => {
    if (!event.isTrusted || busy) return;
    busy = true; setMessage('等待币安扫码确认', '请在币安 App 完成扫码与确认，连接验证最多等待 5 分钟。'); render();
    await request('verify'); busy = false; render();
  });
  refresh.addEventListener('click', event => { if (event.isTrusted) {syncPage();if(selection)void inspectPage();else void updateStatus();} });
  collapse.addEventListener('click', event => {
    if (!event.isTrusted) return;
    body.hidden = !body.hidden; panel.classList.toggle('collapsed', body.hidden); collapse.textContent = body.hidden ? '+' : '−';
    collapse.setAttribute('aria-expanded', String(!body.hidden)); collapse.setAttribute('aria-label', body.hidden ? '展开交易台' : '折叠交易台');
  });
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== chrome.runtime.id || message?.event !== 'progress') return;
    if (message.data?.connection === 'disconnected') { connected = false; setMessage('本机连接已断开', message.data.message || '刷新状态核验，交易不会自动重发。', 'warning'); }
    // Progress from other markets must never repopulate the selected page's data.
    if(message.data?.guard!==undefined)guard=message.data.guard;
    if(message.data?.profile&&selection&&sameAddress(message.data.profile.market,selection.marketAddress))absorb(message.data);render();
  });
  syncPage();render(); updateStatus();
  if(typeof MutationObserver==='function')new MutationObserver(()=>{if(scanQueued)return;scanQueued=true;queueMicrotask(()=>{scanQueued=false;syncPage();});}).observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['hidden','aria-hidden','style']});
  setInterval(syncPage,500);
  setInterval(() => { if (!document.hidden && !busy) updateStatus(); }, 15000);
})();
