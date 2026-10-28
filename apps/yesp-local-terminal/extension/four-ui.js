(() => {
  'use strict';
  if(window.top!==window)return;
  const own=location.protocol==='chrome-extension:'&&location.hostname===chrome.runtime.id&&location.pathname==='/four.html';
  if(!own&&location.origin!=='https://four.meme')return;
  if(document.getElementById('yesp-four-panel'))return;
  const host=document.createElement('div');host.id='yesp-four-panel';
  if(!own)host.style.cssText='all:initial!important;position:fixed!important;right:18px!important;top:18px!important;z-index:2147483647!important;display:block!important;';
  const root=host.attachShadow({mode:'closed'}),css=document.createElement('link');css.rel='stylesheet';css.href=chrome.runtime.getURL('four.css');root.append(css);
  const el=(tag,cls,text)=>{const n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const button=(id,text,cls='secondary')=>{const n=el('button',cls,text);n.type='button';n.id=id;return n;};
  const panel=el('main',own?'panel standalone':'panel');panel.setAttribute('aria-label','YESP Four.meme 交易台');root.append(panel);
  const header=el('header','row'),brand=el('strong','brand','YESP'),subtitle=el('span','muted','FOUR.MEME · BSC'),collapse=button('collapse','−','collapse');
  collapse.setAttribute('aria-label','折叠交易台');collapse.setAttribute('aria-expanded','true');header.append(brand,subtitle,collapse);panel.append(header);
  const body=el('div','body');panel.append(body);const title=el('h1','','查询与交易');body.append(title);
  const walletText=el('p','wallet','正在读取钱包…'),walletButton=button('wallet','Agentic Wallet · 扫码 / 转出 ↗');body.append(walletText,walletButton);
  const unified=button('unified','统一交易面板 · Four + Flap ↗');body.append(unified);
  const agentEntry=el('a','hint','币安官方 Agent ID 入口 ↗');agentEntry.href='https://web3.binance.com/agent-id';agentEntry.target='_blank';agentEntry.rel='noopener noreferrer';body.append(agentEntry);
  const form=el('form'),address=el('input'),query=button('query','查询代币'),side=el('select'),amount=el('input'),slippage=el('input');
  form.id='four-form';address.id='token';address.placeholder='粘贴完整 BSC 代币合约 0x…';address.maxLength=42;address.spellcheck=false;
  for(const [value,text] of [['buy','买入'],['sell','卖出']]){const option=el('option','',text);option.value=value;side.append(option);}side.id='side';side.value='buy';
  amount.id='amount';amount.placeholder='输入数量';amount.inputMode='decimal';amount.maxLength=115;amount.autocomplete='off';
  slippage.id='slippage';slippage.value='1';slippage.inputMode='decimal';slippage.maxLength=5;
  function label(text,input){const l=el('label','',text);l.htmlFor=input.id;form.append(l,input);return l;}
  label('代币合约',address);form.append(query);
  const marketInfo=el('dl','facts');marketInfo.id='market-info';form.append(marketInfo);
  const marketNote=el('p','hint','支持经典 V2 普通币对与 OpenFour Agent ID 专属模式。请先查询代币。');marketNote.id='market-note';form.append(marketNote);
  label('操作',side);const amountLabel=label('购买数量（代币）',amount);amountLabel.id='amount-label';
  const buyLimit=el('p','hint'),fillLimit=button('fill-limit','填入可买上限');buyLimit.id='buy-limit';form.append(buyLimit,fillLimit);
  label('滑点上限（% · 0.01 至 99.99）',slippage);
  const prepare=button('prepare','核对报价与交易','primary');prepare.type='submit';form.append(prepare);body.append(form);
  const review=el('section','review');review.id='review';review.hidden=true;const reviewTitle=el('h2'),facts=el('dl','facts'),reviewNote=el('p','hint');facts.id='review-facts';reviewNote.id='review-note';
  const officialDetails=el('details'),summary=el('summary','','币安预演、风险与授权明细'),official=el('pre');official.id='official-preview';officialDetails.append(summary,official);
  const riskSummary=el('p','hint');riskSummary.id='risk-summary';
  const ackLabel=el('label','check'),ack=el('input');ack.id='ack';ack.type='checkbox';ackLabel.append(ack,el('span','','我已核对网络、完整合约、数量、滑点、授权及币安预演结果。'));
  const expires=el('p','hint'),actions=el('div','row'),cancel=button('cancel','返回修改'),send=button('send','确认提交','primary');actions.append(cancel,send);
  review.append(reviewTitle,facts,reviewNote,riskSummary,officialDetails,ackLabel,expires,actions);body.append(review);
  const status=el('section','status'),statusTitle=el('strong','','等待查询'),statusText=el('p','','填写代币地址，查询后核对报价。');statusTitle.id='status-title';statusText.id='status-text';status.setAttribute('role','status');status.setAttribute('aria-live','polite');status.append(statusTitle,statusText);
  const txLink=el('a','','查看链上交易 ↗');txLink.target='_blank';txLink.rel='noopener noreferrer';txLink.hidden=true;status.append(txLink);
  const recover=el('div','recover'),recoverHint=el('p','hint','若币安 App 已显示交易，请粘贴这笔交易哈希进行核验；不会再次提交。'),recoverHash=el('input'),reconcile=button('reconcile','核验已有交易');
  recoverHash.id='recover-hash';recoverHash.placeholder='交易哈希 0x…';recoverHash.maxLength=66;recover.append(recoverHint,recoverHash,reconcile);recover.hidden=true;status.append(recover);body.append(status);
  const footer=el('footer','row'),version=el('span','','YESP 0.4.0'),refresh=button('refresh','刷新状态','text-button'),expand=button('expand','独立窗口 ↗','text-button');footer.append(version,refresh);if(!own)footer.append(expand);body.append(footer);
  document.documentElement.append(host);
  const errors={LOGIN_REQUIRED:'请先打开钱包扫码连接。',DEVELOPER_MODE_REQUIRED:'请在币安 App 的 Agentic Wallet 设置中开启开发者模式并确认限额，再重新核对。',
    FOUR_V1_READ_ONLY:'当前为经典 V1 代币，本版只查询；买卖支持经典 V2。',FOUR_MIGRATED:'代币已迁移到外部 DEX，当前内盘交易入口停止提交。',
    FOUR_X_MODE:'此代币需要 X Mode 专用签名，本版仅查询。',FOUR_TAX_MODE:'此代币有特殊税费，本版仅查询。',FOUR_ANTI_SNIPER:'此代币启用了动态防狙击费用，本版仅查询。',
    FOUR_NOT_LAUNCHED:'代币尚未开始交易。',NOT_FOUR_TOKEN:'经典 Four 与 OpenFour 合约均未识别此代币，请核对完整地址。',
    OPENFOUR_AGENT_ID_REQUIRED:'该操作需要带有 Agent ID 的币安 Agentic Wallet。扫码连接不等于已取得 Agent ID，请通过币安官方入口检查。',
    OPENFOUR_HOLD_CAP:'已达到创建总量的 1% 持仓上限，无法继续买入。',OPENFOUR_BUY_LIMIT:'购买数量超过当前钱包剩余限额，请重新查询或填入可买上限。',
    FOUR_QUANTITY_UNAVAILABLE:'当前库存或合约报价无法满足此购买数量，请刷新并减少数量。',OPENFOUR_PRESALE_UNSUPPORTED:'本交易台不参与创建区块预售，请等待下一阶段再查询。',
    OPENFOUR_TRANSFER_LOCKED:'此币内盘期间限制普通转账，只允许合约买入交付和卖出收币。',OPENFOUR_TRADE_DENIED:'该钱包或数量未通过 OpenFour 合约交易条件检查。',
    OPENFOUR_PAUSED:'代币、主合约或模式已暂停，暂不可提交。',OPENFOUR_NOT_TRADING:'当前不处于可交易的内盘阶段。',
    OPENFOUR_PRESET_UNSUPPORTED:'本版 OpenFour 仅接入 Agent ID 专属模式，此模式暂只查询。',OPENFOUR_MODULE_UNSUPPORTED:'该模式的模块或版本尚未适配，暂不可提交。',
    OPENFOUR_CORE_CHANGED:'官方主合约地址发生变化，需更新适配后再交易。',OPENFOUR_TAX_UNSUPPORTED:'代币税费配置超出当前支持范围。',
    FOUR_GWEI_PRECISION:'经典 Four 买卖数量需符合合约精度：原始数量须为 10⁹ 的整数倍。',FOUR_BUDGET_EXCEEDED:'报价的总支出超过输入预算或报价无效，已停止。',
    FOUR_QUOTE_UNAVAILABLE:'当前数量没有有效报价。',INVALID_ADDRESS:'请核对完整的代币合约地址。',INVALID_REQUEST:'请核对地址、数量与滑点范围。',
    AMOUNT_PRECISION:'数量无效或小数位超过代币精度。',INSUFFICIENT_BALANCE:'支付资产或代币余额不足。',INSUFFICIENT_GAS:'BNB 网络费余额不足。',
    WALLET_LOCKED:'币安 App 中有待处理操作，请先完成确认或拒绝。',PENDING_TRANSACTION:'钱包有待确认交易，请等待。',WALLET_CHANGED:'钱包已变化，请重新核对。',
    PREVIEW_EXPIRED:'报价已过期或链上状态发生变化，请重新核对。',PREVIEW_REJECTED:'币安预演未通过，已停止提交。',PREVIEW_MISMATCH:'币安预演数据未通过核验，已停止。',
    APPROVAL_PREVIEW_MISMATCH:'授权预演与本次授权不符，已停止。',UNEXPECTED_AUTHORITY_CHANGE:'预演包含非预期授权变更，已停止。',
    TRADE_PENDING:'已有操作结果待核验，请先处理上一笔。',UNRESOLVED_TRADE_EXISTS:'已有操作结果待核验，请先处理上一笔。',
    UNRESOLVED_TRADE_LOCK:'本机操作尚未结束，请等待并保留记录。',NATIVE_UNAVAILABLE:'本机程序不可用，请重新加载扩展后再读取状态。',
    UNKNOWN:'提交结果待核验，请勿重复提交。',TIMEOUT:'请求超时，请刷新状态；已提交的操作不要重复发送。',
    FOUR_TRANSACTION_MISMATCH:'交易哈希与已确认的调用不符，已拒绝绑定。',TRANSACTION_NOT_FOUND:'链上尚未找到此交易。',READ_FAILED:'读取失败，请检查网络后刷新。',
    RPC_UNAVAILABLE:'BSC 节点暂不可用，请稍后重新查询。',RPC_CALL_FAILED:'链上检查未通过，可能处于暂停、迁移或不支持的状态。'};
  const terminal=new Set(['COMPLETE','FAILED','REJECTED','CANCELLED']);
  let wallet={connected:false},market=null,holdings=null,limitWallet=null,preview=null,operation=null,guard=null,busy=false,polling=false,notice=false,lastRoute='';
  const message=(title,text)=>{statusTitle.textContent=title;statusText.textContent=text;};
  const pending=()=>Boolean(guard)||Boolean(operation&&!terminal.has(operation.status));
  function invalidate(){preview=null;review.hidden=true;ack.checked=false;render();}
  function rows(node,values){node.replaceChildren();for(const [name,value]of values){const dt=el('dt','',name),dd=el('dd','',String(value??'—'));node.append(dt,dd);}}
  function render(){
    walletText.textContent=wallet.connected?`本机钱包：${wallet.address}`:'钱包未连接；可先查询代币。';
    amountLabel.textContent=`${side.value==='buy'?'购买':'卖出'}数量（${market?.base.symbol||'代币'}）`;
    const sameWallet=wallet.connected&&wallet.address===limitWallet;
    buyLimit.hidden=side.value!=='buy';fillLimit.hidden=side.value!=='buy'||market?.protocol!=='openfour-agent';
    buyLimit.textContent=market?.protocol==='openfour-agent'?`持仓上限：${market.holdCap} ${market.base.symbol}；当前最多可买：${sameWallet?(holdings?.buyable??'请重新查询'):'连接钱包并查询后读取'}。可买数量同时受剩余库存约束，支付资产需另行充足。`:
      market?`按输入的代币数量获取当前内盘报价。内盘剩余可售：${market.offers??'—'} ${market.base.symbol}。该模式未提供已核验的单钱包购买限额。`:'先查询代币，读取购买限额和数量单位。';
    fillLimit.disabled=busy||pending()||!market?.supported||!sameWallet||!holdings?.buyable||!/[1-9]/.test(holdings.buyable);
    for(const n of [address,side,amount,slippage,query,cancel,reconcile])n.disabled=busy;
    prepare.disabled=busy||!wallet.connected||!market?.supported||pending();refresh.disabled=busy||polling;
    send.disabled=busy||!preview||!ack.checked||Date.now()>=preview.expiresAt||pending();
    if(preview){const left=Math.max(0,Math.ceil((preview.expiresAt-Date.now())/1000));expires.textContent=left?`本次预演 ${left} 秒后过期。`:'预演已过期，请返回重新核对。';}
    const hash=operation?.txHash||guard?.txHash;txLink.hidden=!/^0x[\da-f]{64}$/i.test(hash||'');if(!txLink.hidden)txLink.href=`https://bscscan.com/tx/${hash}`;
    recover.hidden=!operation?.action?.startsWith('four')||terminal.has(operation?.status)||Boolean(hash);
  }
  function showMarket(data){
    market=data.market;holdings=data.holdings;limitWallet=data.wallet?.address??null;
    rows(marketInfo,[['代币',market.base.symbol],['代币合约',market.tokenAddress],['报价资产',market.quote.symbol],['报价合约',market.quote.address==='0x0000000000000000000000000000000000000000'?'BNB 原生币':market.quote.address],
      ['协议',market.protocol==='openfour-agent'?`OpenFour · ${market.preset?.name||market.presetId}`:`经典 V${market.version}`],['代币持仓',data.holdings?`${data.holdings.base} ${market.base.symbol}`:'连接钱包后读取'],['可用报价资产',data.holdings?`${data.holdings.quote} ${market.quote.symbol}`:'—'],['内盘募资',`${market.funds} / ${market.maxFunds} ${market.quote.symbol}`],
      ...(market.tax?[['买入 / 卖出代币税',`${Number(market.tax.buyFeeRate)/100}% / ${Number(market.tax.sellFeeRate)/100}%`],['持仓上限（创建总量 1%）',`${market.holdCap} ${market.base.symbol}`],['剩余可买数量',data.holdings?.buyable??'连接钱包后读取']]:[])]);
    marketNote.textContent=market.supported?(market.protocol==='openfour-agent'?'按代币数量获取内盘报价，通过 OpenFour 合约买卖，无需 DEX 池。交易资格由合约检查，普通转出受限；代币税和其他交易费用均计入报价。':'按代币数量获取经典内盘报价。合约显示的名称不代表资产真实性。'):market.blockers.map(c=>errors[c]||c).join(' ');render();
  }
  function showPreview(p){
    preview=p;ack.checked=false;review.hidden=false;reviewTitle.textContent=p.kind==='approve'?'先确认本次数量授权':`确认${p.kind==='buy'?'买入':'卖出'}`;
    const values=[['网络','BNB Smart Chain（56）'],['钱包',p.wallet],['代币',`${p.base.symbol} · ${p.tokenAddress}`],['报价资产',`${p.quote.symbol} · ${p.quote.address}`],['交易合约',p.manager],
      ['请求操作',p.action==='buy'?'买入':'卖出'],[p.buyMode==='tokenAmount'?'目标购买数量':'输入数量',`${p.amount} ${p.action==='sell'||p.buyMode==='tokenAmount'?p.base.symbol:p.quote.symbol}`],['滑点上限',`${Number(p.slippageBps)/100}%`]];
    if(p.buyMode==='tokenAmount')values.push(['交易方式','按当前内盘报价购买'],['预计支付（含交易费）',`${p.estimatedSpend} ${p.quote.symbol}`],['最高支付（含滑点及交易费）',`${p.spend} ${p.quote.symbol}`]);
    if(p.kind==='approve')values.push(['授权代币',p.approvalToken],['授权对象',p.manager],['授权数量',`${p.approvalAmount} ${p.action==='buy'?p.quote.symbol:p.base.symbol}`],['授权原始单位',p.approvalRaw]);
    else values.push(...(p.buyMode==='tokenAmount'?[]:[[p.protocol==='openfour-agent'?'最大支出':'预计支出',`${p.spend} ${p.action==='buy'?p.quote.symbol:p.base.symbol}`]]),['预计获得',`${p.expected} ${p.action==='buy'?p.base.symbol:p.quote.symbol}`],
      ...(p.buyMode==='tokenAmount'?[]:[[p.action==='buy'?'最低获得':p.minimumKind==='net'?'最低净到账':'最低扣费前收入',`${p.minimum} ${p.action==='buy'?p.base.symbol:p.quote.symbol}`]]),
      [p.protocol==='openfour-agent'?'税费合计估算':'协议费估算',`${p.totalFee??p.protocolFee} ${p.quote.symbol}`]);
    if(p.protocol==='openfour-agent')values.push(['预计实际支出',`${p.estimatedSpend} ${p.action==='buy'?p.quote.symbol:p.base.symbol}`],['持仓上限 / 剩余额度',`${p.holdCap} / ${p.holdRoom} ${p.base.symbol}`],
      ['代币税分配',`创建者 ${p.tax.rateFounder}% · 持有人 ${p.tax.rateHolder}% · 销毁 ${p.tax.rateBurn}% · 流动性 ${p.tax.rateLiquidity}%`]);
    values.push(['本次附带 BNB',p.nativeValue],['网络费估算',`${p.estimatedGas} BNB`]);rows(facts,values);
    reviewNote.textContent=p.kind==='approve'?'本次只提交授权，不会自动买卖。授权确认后，需要重新核对报价并再次确认。':p.buyMode==='tokenAmount'?
      '按目标代币数量购买，最高支付已计入交易费用和滑点，网络费另付。'+(p.protocol==='openfour-agent'?'若成交时持仓限额或库存变化，合约可能缩减数量并退回多余支付；按实际回执显示，不自动补买。':'价格变化使支出超过上限时，交易将失败。'):
      p.protocol==='openfour-agent'?(p.kind==='sell'?'最低净到账已扣除代币税和协议等费用；合约按此金额校验。网络费另付。':'预算包含全部交易税费；接近持仓上限时可部分成交，多余预算由合约退回。交易按最低获得数量校验，网络费另付。'):p.kind==='sell'?'卖出最低金额是合约校验的扣费前收入；实际到账还会扣除协议费。网络费另付。':'预计数量随市场变化；交易按上面的最低获得数量校验。网络费另付。';
    const risks=p.official?.risks||{},items=[...(risks.riskDetails||[]),...(risks.riskBehaviors||[])];
    const riskText=items.map(x=>typeof x==='string'?x:[x.title,x.description,x.code].filter(Boolean).join('：'));
    for(const [target,info]of Object.entries(risks.addresses||{}))if(info.riskDetails?.length||Number(info.riskLevel)>1)riskText.push(`${target} · 风险等级 ${info.riskLevel??'未标明'}：${(info.riskDetails||[]).map(x=>[x.title,x.description].filter(Boolean).join('：')).join('；')}`);
    riskSummary.textContent=riskText.length?'币安风险提示：'+riskText.join('；'):'币安预演未列出额外风险项，仍需核对合约与金额。';
    officialDetails.open=riskText.length>0||p.kind==='approve';
    official.textContent=JSON.stringify({transaction:p.tx,...p.official},null,2);send.textContent=p.kind==='approve'?'确认授权':p.kind==='buy'?'确认买入':'确认卖出';
    review.scrollIntoView({block:'nearest',behavior:'smooth'});render();
  }
  async function request(method,params={}){
    let r;try{r=await chrome.runtime.sendMessage({id:crypto.randomUUID(),method,params:{profile:['openWallet','openFour','openTrade'].includes(method)?'heyi':'fourmeme',...params}});}
    catch{if(method==='fourExecute')guard={intentId:params.intentId,status:'UNKNOWN'};message('连接未完成',method==='fourExecute'?errors.UNKNOWN:errors.NATIVE_UNAVAILABLE);notice=true;render();return null;}
    if(r?.guard!==undefined)guard=r.guard;
    if(!r?.ok){const c=r?.error?.code||'UNKNOWN';notice=true;message('操作未完成',`${errors[c]||'请求未完成，请核对状态，提交后切勿重复发送。'}（${c}）`);render();return null;}
    const d=r.data||{};if(d.wallet)wallet=d.wallet;if(Object.hasOwn(d,'operation'))operation=d.operation;
    if(d.reconcileError){notice=true;message('结果待核验',`${errors[d.reconcileError.code]||'链上结果尚未通过核验。'}（${d.reconcileError.code}）`);}
    else if(operation){message(terminal.has(operation.status)?'操作已结束':'操作处理中',operation.message||operation.status);}
    render();return d;
  }
  async function refreshStatus(){if(busy||polling)return;polling=true;render();try{const d=await request('fourStatus');if(d&&!operation&&!notice)message('钱包状态已更新',wallet.connected?'查询代币后，填写数量并核对。':'请打开钱包扫码连接；代币查询无需登录。');}finally{polling=false;render();}}
  function changed(){market=null;holdings=null;limitWallet=null;amount.value='';marketInfo.replaceChildren();marketNote.textContent='地址已改变，请重新查询。';invalidate();}
  address.addEventListener('input',changed);for(const n of [side,amount,slippage])n.addEventListener('input',invalidate);side.addEventListener('change',invalidate);
  query.addEventListener('click',async e=>{if(!e.isTrusted||busy)return;invalidate();busy=true;notice=false;render();message('查询代币','读取 BSC 合约、交易阶段和钱包余额。');
    try{const d=await request('fourQuery',{tokenAddress:address.value.trim()});if(d?.market){showMarket(d);message('查询完成',marketNote.textContent);}}finally{busy=false;render();}});
  fillLimit.addEventListener('click',async e=>{if(!e.isTrusted||busy||fillLimit.disabled)return;invalidate();busy=true;render();
    try{const d=await request('fourQuery',{tokenAddress:address.value.trim()});if(d?.market){showMarket(d);
      if(d.market.protocol==='openfour-agent'&&d.market.supported&&d.wallet?.connected&&d.holdings?.buyable){amount.value=d.holdings.buyable;message('已填入最新可买上限','请核对购买数量，再获取当前报价；此按钮仅填写数量。');}}}
    finally{busy=false;render();}});
  form.addEventListener('submit',async e=>{
    e.preventDefault();if(!e.isTrusted||busy||prepare.disabled)return;invalidate();
    const text=slippage.value.trim();if(!/^(?:0|[1-9]\d?)(?:\.\d{1,2})?$/.test(text)){message('滑点无效','请输入 0.01 至 99.99 的百分数，最多两位小数。');return;}
    const [whole,dec='']=text.split('.'),bps=Number(whole)*100+Number(dec.padEnd(2,'0'));
    if(bps<1||bps>9999){message('滑点无效','请输入 0.01 至 99.99 的百分数，最多两位小数。');return;}
    busy=true;notice=false;render();message('核对报价','读取最新报价并运行币安交易预演。');
    try{const d=await request('fourPrepare',{tokenAddress:address.value.trim(),action:side.value,amount:amount.value.trim(),slippageBps:String(bps),...(side.value==='buy'?{buyMode:'tokenAmount'}:{})});if(d?.fourPreview){showPreview(d.fourPreview);message('请核对确认',reviewNote.textContent);}}
    finally{busy=false;render();}
  });
  ack.addEventListener('change',render);cancel.addEventListener('click',e=>{if(e.isTrusted&&!busy)invalidate();});
  send.addEventListener('click',async e=>{if(!e.isTrusted||busy)return;route();if(send.disabled||!preview)return;const previewId=preview.previewId,intentId=crypto.randomUUID();
    guard={intentId,status:'PENDING'};busy=true;invalidate();message('正在提交','请勿重复点击；若币安 App 要求确认，请在手机上处理。');
    try{await request('fourExecute',{previewId,intentId});}finally{busy=false;render();}await refreshStatus();});
  walletButton.addEventListener('click',e=>{if(e.isTrusted)request('openWallet');});
  unified.addEventListener('click',e=>{if(e.isTrusted)request('openTrade',/^0x[\da-f]{40}$/i.test(address.value.trim())?{tokenAddress:address.value.trim()}:{});});
  expand.addEventListener('click',e=>{if(e.isTrusted)request('openFour',/^0x[\da-f]{40}$/i.test(address.value.trim())?{tokenAddress:address.value.trim()}:{});});
  refresh.addEventListener('click',e=>{if(e.isTrusted){notice=false;refreshStatus();}});
  reconcile.addEventListener('click',async e=>{if(!e.isTrusted||busy||!operation?.intentId)return;busy=true;render();try{await request('fourReconcile',{intentId:operation.intentId,txHash:recoverHash.value.trim()});}finally{busy=false;render();}});
  collapse.addEventListener('click',e=>{if(!e.isTrusted)return;body.hidden=!body.hidden;collapse.textContent=body.hidden?'+':'−';collapse.setAttribute('aria-expanded',String(!body.hidden));});
  function route(){const key=own?location.hash:location.pathname;if(key===lastRoute||busy)return;const hadRoute=lastRoute!=='';lastRoute=key;const match=own?key.match(/^#(0x[\da-f]{40})$/i):key.match(/(?:^|\/)token\/(0x[\da-f]{40})\/?$/i);if(match){address.value=match[1];changed();}else if(hadRoute){address.value='';changed();}
    if(!own&&/\/contract\/1778027615735\/?$/.test(key))marketNote.textContent='这是 Binance Agent ID 专属模式介绍页。请打开具体代币页或粘贴合约地址后查询；交易资格将在核对报价时检查。';}
  chrome.runtime.onMessage.addListener((m,sender)=>{if(sender.id!==chrome.runtime.id||m?.event!=='progress')return;if(m.data?.guard!==undefined)guard=m.data.guard;render();});
  route();render();refreshStatus();setInterval(()=>{route();render();},1000);setInterval(()=>{if(!document.hidden)refreshStatus();},15000);
})();
