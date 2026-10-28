import {fundingMessage,budgetMessage,automaticFailureMessage} from './funding-model.js';
import {setupLocalFeatures} from './local-features.js';
import {setupMarketChart} from './market-chart.js';
import {client} from './client-bridge.js';
import {isOfficialSigninUrl} from './signin-policy.js';
import {parseCA,percentAmount,slippageBps,terminal,buyRoom,toRaw,transferBlocked} from './trade-model.js';
const $=id=>document.getElementById(id),ids=['ca','query','amount','slippage','buy','sell','transfer','recipient','signin','verify','refresh','claim','reconcile','funding-enabled','funding-slippage','oneclick-enabled'];
const errors={TOKEN_METADATA_UNAVAILABLE:'合约存在，但名称、精度或供应量读取失败，暂不能按 ERC20 交易。',TOKEN_SUPPLY_INVALID:'该合约当前总供应量为零，暂不能建立交易报价。',GANG_KIND_UNSUPPORTED:'该 CA 属于 Gang 打新销售，尚未接入该机制的交易；不能使用 V3 内盘买卖。',DEX_QUOTE_UNAVAILABLE:'多次报价仍无法覆盖目标数量，请减少数量后重新核对。',DEX_ROUTE_UNAVAILABLE:'当前代币没有可用的 DEX 买卖路径。',DEX_SETTLEMENT_MISMATCH:'DEX 订单与链上到账未通过匹配，已停止后续提交，请保留订单核验。',NO_LIQUIDITY:'当前交易对没有可用流动性。',AUTO_DEADLINE:'一键流程已超时，后续步骤停止。',AUTO_PRICE_CHANGED:'当前价格已超出本次一键交易的首份报价范围，后续步骤停止。',AUTO_FUNDING_SHORTFALL:'兑换到账不足，后续买入已停止；不会再次自动兑换。',AUTO_RISK_REVIEW_REQUIRED:'币安预演返回新的风险提示，已停止自动提交。',AUTO_APPROVAL_CHANGED:'授权需求发生变化，已停止重复授权。',FUNDING_BALANCE_INSUFFICIENT:'当前 BNB 余额不足以兑换目标数量所需的结算币并预留网络费，请减少购买数量。',FUNDING_NOT_REQUIRED:'结算币余额已足够，请重新核对买入。',FUNDING_ROUTE_UNAVAILABLE:'该结算币目前没有可用的 BNB 兑换路径。',FUNDING_BUDGET_EXCEEDED:'兑换所需 BNB 超过预算上限，请调整购买数量或预算后重新核对。',FUNDING_QUOTE_UNAVAILABLE:'多次报价仍无法覆盖差额，未执行兑换。',SWAP_QUOTE_INVALID:'币安兑换报价未通过核验。',FUNDING_SETTLEMENT_MISMATCH:'兑换到账与预期身份不符，请保留交易记录并核验。',GANG_AGENT_ID_REQUIRED:'此 Gang 内盘要求当前钱包持有有效的 .ai Agent ID。',GANG_DEX_ROUTE_REQUIRED:'此 Gang 代币已毕业到 PancakeSwap；当前面板未接入该外盘交易。',GANG_CONTRACT_CHANGED:'Gang 合约代码发生变化，需重新核验后才能交易。',GANG_CURVE_INVALID:'Gang 曲线参数核验失败。',INVALID_AMOUNT:'请输入大于零的普通十进制数量。',SELF_TRANSFER:'收款地址不能与当前钱包相同。',TOKEN_NOT_CONTRACT:'该 CA 尚不是已部署的代币合约。',TOKEN_BALANCE_UNAVAILABLE:'币安暂未返回该代币余额，请等待同步后重试。',TOKEN_UNIT_MISMATCH:'币安显示数量与链上数量不一致，请等待同步后重试。',TRANSFER_IDENTITY_MISMATCH:'该交易哈希与本次转出不符，请核对。',WALLET_CHANGED:'钱包已变化，请重新核对。',TRANSFER_PREVIEW_MISMATCH:'转出预览与当前地址或数量不一致，已停止。',TRANSFER_UNAVAILABLE:'当前市场的份额或代币尚不可转出。',LOGIN_REQUIRED:'请先连接币安钱包。',DEVELOPER_MODE_REQUIRED:'请在币安 Agentic Wallet 开启开发者模式并核对额度。',AGENT_ID_REQUIRED:'此市场要求当前钱包持有有效 Agent ID。',
 INVALID_ADDRESS:'请填写完整、有效的 BSC 地址，并核对大小写。',INVALID_SLIPPAGE:'滑点范围为 0.01% 至 99.99%，最多两位小数。',AMOUNT_PRECISION:'请填写正数，且小数位不能超过代币精度。',
 INSUFFICIENT_BALANCE:'所需资产余额不足，请核对结算币种和数量。',INSUFFICIENT_GAS:'BNB 网络费余额不足。',BUY_LIMIT_EXCEEDED:'购买数量超过当前可买额度，请刷新并减少数量。',
 FLAP_SELL_MIN_PERCENT:'Flap 虚拟份额卖出最小步长为持仓的 0.01%，请增加数量。',FLAP_BACKING_UNVERIFIED:'市场的储备核验未通过，暂不能交易。',
 FLAP_LAUNCHING:'市场正在毕业，暂不能买卖。',FLAP_AGENT_GRADUATED:'虚拟份额已毕业，请先核对领取真实代币。',FLAP_DEX_ROUTE_REQUIRED:'代币已迁移至 DEX。此版本未接入该 DEX 池，不能继续走内盘。',
 FLAP_STAGED_TOKEN:'该 CA 尚未部署；如果是 Agent 市场，请确认完整的预测代币地址。',FLAP_NOT_TRADABLE:'该 Flap 市场目前不允许内盘交易。',FLAP_TAX_UNSUPPORTED:'此代币税率暂不支持交易。',
 FOUR_MIGRATED:'代币已迁移至 DEX。此版本不通过旧内盘继续交易。',FOUR_V1_READ_ONLY:'旧版 Four V1 目前仅支持读取。',FOUR_X_MODE:'此 Four X 模式尚未接入。',FOUR_TAX_MODE:'此经典 Four 税费模板尚未接入。',FOUR_ANTI_SNIPER:'此经典 Four 动态费用模式尚未接入。',
 NOT_FOUR_TOKEN:'未识别为当前支持的 Four.meme、Flap 或 Gang 市场。',OPENFOUR_UNSUPPORTED_PRESET:'此 OpenFour 模式尚未接入。',FOUR_GWEI_PRECISION:'Four 普通内盘数量最多保留 9 位小数。',
 PREVIEW_EXPIRED:'报价已过期或链上状态变化，请重新核对。',STALE_BLOCK:'节点数据已过期，请稍后刷新。',STALE_QUOTE:'报价期间区块已过期，请重新核对。',
 SEARCH_CEILING:'当前内盘无法报价出这个数量，请减少数量。',ALLOCATION_NOT_FOUND:'暂时无法精确匹配目标数量，请稍后重试或减少数量。',
 RPC_UNAVAILABLE:'BSC 节点连接失败，请稍后重试。',RPC_CALL_FAILED:'合约查询或模拟未通过，请检查余额、资格及交易限制。',
 NATIVE_UNAVAILABLE:'本机连接程序不可用，请重新加载扩展后再试。',TIMEOUT:'读取超时，请刷新状态。',WALLET_LOCKED:'币安钱包有待处理操作，请先在 App 中处理。',
 PENDING_TRANSACTION:'钱包存在未确认交易，请等待确认。',UNRESOLVED_TRADE_EXISTS:'上一笔操作结果待核验，不能重复提交。',TRADE_PENDING:'上一笔操作结果待核验，不能重复提交。',
 UNRESOLVED_TRADE_LOCK:'本机交易正在处理中，请等待。',UNKNOWN:'提交结果待核验，请勿重复发送。',CLAIM_UNAVAILABLE:'当前没有可领取代币，或领取条件尚未满足。',
 APPROVAL_PREVIEW_MISMATCH:'币安返回的授权预演与本次授权不一致，已停止。',PREVIEW_MISMATCH:'币安预演与本次交易不一致，已停止。',
 QR_CODE_EXPIRED:'二维码已过期，请重新获取。',AUTH_URL_REVIEW_REQUIRED:'登录链接未通过校验，请重新获取二维码。',LOGIN_FLOW_REQUIRED:'请先获取二维码，再验证连接。'};
let wallet={connected:false},market=null,holdings=null,preview=null,operation=null,guard=null,busy=false,polling=false,side='buy',signinExpiry=0,recent=[];
let revision=0,formRevision=0,autoActive=false,refreshDone=Promise.resolve();
let balancesRefreshing=false,settledRefreshKey='';
const chartView=setupMarketChart({client});
function say(title,text){$('status-title').textContent=title;$('status-text').textContent=text;}
function oneclick(){return client.local&&$('oneclick-enabled').checked&&side!=='transfer';}
function pending(){return Boolean(guard)||Boolean(operation&&!terminal.has(operation.status));}
function invalidate(){formRevision++;preview=null;$('ack').checked=false;if($('review').open)$('review').close();render();}
function clearLogin(){signinExpiry=0;$('signin-details').hidden=true;$('signin-qr').hidden=true;$('signin-qr').removeAttribute('src');$('signin-link').hidden=true;$('signin-link').removeAttribute('href');$('pairing-code').textContent='';}
function clearMarket(){market=holdings=null;$('amount').value='';$('recipient').value='';invalidate();renderMarket();}
function validSelection(){return market&&parseCA($('ca').value)?.toLowerCase()===market.tokenAddress.toLowerCase();}
function render(){
 const emptyPosition=market&&holdings?.base!==undefined&&!/[1-9]/.test(holdings.base);
 for(const id of ids)$(id).disabled=busy;
 $('refresh').disabled=busy||polling;$('verify').disabled=busy||!signinExpiry;
 $('prepare').disabled=autoActive||busy||pending()||!wallet.connected||!validSelection()||side==='sell'&&emptyPosition||(side==='transfer'?Boolean(transferBlocked(market)):!market.supported);
 $('send').disabled=autoActive||busy||pending()||!preview||!$('ack').checked||Date.now()>=preview.expiresAt||!validSelection()||wallet.address!==preview.wallet;
 $('fill-limit').disabled=busy||!wallet.connected||!validSelection()||!market.supported||market.protocol==='dex-swap';
 for(const el of document.querySelectorAll('[data-percent],[data-quantity]'))el.disabled=busy||!validSelection();
 $('claim').disabled=busy||pending()||!wallet.connected;
 for(const el of document.querySelectorAll('[data-quick-buy],[data-quick-sell]'))el.disabled=autoActive||busy||pending()||!wallet.connected||!validSelection()||!market.supported||Boolean(el.dataset.quickSell)&&emptyPosition;
 $('quick-trade').hidden=side==='transfer';$('oneclick-options').hidden=!client.local||side==='transfer';
 $('oneclick-note').textContent=market?.protocol==='dex-swap'?(side==='buy'?'按目标代币数量计算 BNB 投入，使用下方滑点；余额需覆盖投入和网络费。':'出售所选代币数量并收到 BNB，中途不再弹窗。') :side==='buy'?'点击买入即授权本次完整流程，中途不再弹窗。已有结算币先抵扣；按购买数量计算所需 BNB，只兑换缺口并预留网络费。':'点击卖出即自动卖出并将本次所得换回 BNB，中途不再弹窗。不会兑换原有结算币余额。';
 $('swap-slippage-label').hidden=market?.protocol==='dex-swap';$('manual-funding-switch').hidden=oneclick()||market?.protocol==='dex-swap';$('funding-quantity-note').hidden=side==='sell';
 $('funding-help').textContent=market?.protocol==='dex-swap'?'外盘直接兑换使用下方滑点上限；币安执行时重新报价，手机确认由币安决定。':oneclick()?'缺少流动性、到账不足或超过参数时停止。手机确认仍由币安决定。':'先确认兑换，到账后继续核对授权和买入。';
 $('quick-mode-label').textContent=oneclick()?'点击即交易':'点击即核对';$('quick-help').textContent=oneclick()?'按下即执行本次完整流程，不再二次弹窗。':'点击打开确认页，不会立即交易。';
 $('preview-only').disabled=busy||pending()||autoActive||!wallet.connected||!validSelection();$('preview-only').hidden=side==='transfer';
 $('funding-options').hidden=market?.protocol==='dex-swap'?side!=='buy':!market||side==='transfer'||!oneclick()&&(side!=='buy'||/^0x0{40}$/i.test(market.quote.address)||market.quote.address?.toLowerCase()==='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c');
 const continuation=operation?.status==='COMPLETE'&&['panelFund','panelWrap','panelApprove'].includes(operation.action)&&operation.steps?.[0]?.plan.action==='buy';
 $('continue-buy').hidden=!continuation;$('continue-buy').disabled=busy||pending()||autoActive||!wallet.connected;
 $('funding-note').hidden=side!=='buy'||!market;
 if(market){$('funding-title').textContent='买入支付：'+market.quote.symbol;$('funding-balance').textContent=`余额：${holdings?.quote??'未读取'} ${market.quote.symbol}。`+(/^0x0{40}$/i.test(market.quote.address)?'另需预留 BNB 网络费。':market.quote.symbol==='WBNB'?'不足时可单独确认 BNB → WBNB。':'可先用 BNB 兑换差额，到账后继续买入。');$('funding-ca').textContent=market.quote.address;$('funding-ca').href='https://bscscan.com/address/'+market.quote.address;}
 $('login-toggle').textContent=wallet.connected?'钱包已连接':'连接钱包';$('wallet-address').textContent=wallet.connected?wallet.address:'尚未连接';
 for(const action of ['buy','sell','transfer'])$(action).classList.toggle('selected',side===action);
 $('transfer-fields').hidden=side!=='transfer';$('slippage-field').hidden=side==='transfer';
 $('transfer-ca').textContent=market?.tokenAddress||'请先识别代币';
 $('transfer-balance').textContent=transferBlocked(market)||`可转代币余额：${holdings?.base??'—'} ${market?.base.symbol||''} · 核对时重新检查`;
 $('order-title').textContent=side==='transfer'?'代币转出':'市价交易';$('order-subtitle').textContent=side==='transfer'?'使用当前 CA':market?.protocol==='dex-swap'?'DEX 实时报价':'按实时合约报价';
 $('order-footnote').textContent=oneclick()?'一次点击执行当前参数。后台接续兑换、授权和买卖；请勿重复点击。':side==='transfer'?'先核对收款地址、代币数量与网络费，再确认转出。':'每笔交易先预演，再由你确认。授权完成后需重新核对买卖。';
 $('buy-presets').hidden=side!=='buy';$('sell-presets').hidden=side==='buy'||side==='transfer'&&Boolean(transferBlocked(market));
 $('amount-label').textContent=side==='buy'?'购买数量':side==='sell'?'卖出数量':'转出数量';$('prepare').textContent=oneclick()?(side==='buy'?'一键买入':'一键卖出 → BNB'):side==='buy'?'核对买入':side==='sell'?'核对卖出':'核对转出';
 $('amount-hint').textContent=side==='transfer'?(transferBlocked(market)||'转出当前 CA 的真实代币。比例按钮会先刷新持仓，BNB 需留作网络费。'):oneclick()?(side==='buy'?'按目标数量计算投入，按滑点检查；实际到账可能少于目标数量。':'按当前数量卖出，自动将本次实际所得换回 BNB。'):side==='buy'?((market?.protocol?.startsWith('flap')||market?.protocol==='gang-curve')?'按目标数量反算投入，实际输出会受滑点影响；确认页显示最低收到量。':'填写想买的代币数量，核对时计算所需结算资产。'):
  market?.protocol==='flap-agent'?'虚拟份额按持仓比例卖出，步长 0.01%；核对页显示实际卖出份额。':'选择持仓比例或填写代币数量，卖出后收到本市场结算资产。';
 if(side==='sell'&&emptyPosition){$('prepare').textContent='当前钱包无可卖余额';$('amount-hint').textContent='刚读取的持仓为 0。若已转出，请在收款钱包卖出；若刚买入，请重新识别代币刷新余额。';}
 if(preview)$('expiry').textContent=`报价有效期剩余 ${Math.max(0,Math.ceil((preview.expiresAt-Date.now())/1000))} 秒。`;
 if(signinExpiry){if(Date.now()>=signinExpiry){clearLogin();$('login-status').textContent='二维码已过期，请重新获取。';}else $('signin-expiry').textContent=`二维码 ${Math.ceil((signinExpiry-Date.now())/1000)} 秒后过期。`;}
 const hash=operation?.steps?.at(-1)?.txHash||operation?.txHash||guard?.txHash;$('tx-link').hidden=!/^0x[\da-f]{64}$/i.test(hash||'');if(!$('tx-link').hidden)$('tx-link').href=`https://bscscan.com/tx/${hash}`;
 $('recover').hidden=!operation||terminal.has(operation.status)||Boolean(hash)||!['panelBuy','panelSell','panelApprove','panelClaim','panelWrap','panelFund','fourBuy','fourSell','fourApprove','transfer'].includes(operation.action);
}
function renderMarket(){
 const m=market,h=holdings,room=buyRoom(m,h);
 chartView.select(m);
 $('platform').textContent=m?`${m.platform||'Four.meme'} · BSC`:'等待识别';$('symbol').textContent=m?.base.symbol||'粘贴代币合约';$('coin').textContent=(m?.base.symbol||'?').slice(0,2);
 $('name').textContent=m?.name||m?.preset?.name||'Four.meme / Flap / Gang · BSC';$('phase').textContent=m?.phaseLabel||'未选择市场';
 $('contract').textContent=m?.tokenAddress||'';if(m)$('contract').href=`https://bscscan.com/address/${m.tokenAddress}`;else $('contract').removeAttribute('href');
 $('position-kind').textContent=m?.positionKind||'—';$('quote-symbol').textContent=m?.quote.symbol||'—';$('amount-symbol').textContent=m?.base.symbol||'TOKEN';
 let percent=null;if(m?.progressBps!==undefined)percent=Number(m.progressBps)/100;else if(m?.progressRaw!==undefined)percent=Number(BigInt(m.progressRaw)/100000000000000n)/100;else if(m?.maxFunds&&Number(m.maxFunds)>0)percent=Number(m.funds)/Number(m.maxFunds)*100;
 $('progress').textContent=percent===null?'—':`${Math.min(100,percent).toFixed(2)}%`;$('progress-bar').style.width=`${Math.max(0,Math.min(100,percent||0))}%`;
 $('base-balance').textContent=h?.base||'—';$('buy-room').textContent=room||'—';$('quote-balance').textContent=h?.quote||'—';$('bnb-balance').textContent=h?.native||'—';
 $('balance-label').textContent=m?.positionKind||'代币 / 份额';$('quote-balance-label').textContent=m?`${m.quote.symbol} 余额`:'结算资产余额';
 $('limit-note').textContent=m?(h?`${h.limitType||m.limitType||(m.holdCap?'持仓上限 '+m.holdCap:'内盘剩余供应量')}。${h.eligible===false?'当前钱包未通过 Agent ID 资格。':''}`:'连接钱包后读取个人可买额度。'):'登录一次，内盘与通用 Swap 共用当前钱包。';
 if(m&&m.protocol!=='dex-swap')$('limit-note').textContent+=' 此额度是平台允许的持仓数量，不按 BNB 预算计算。';
 $('route-note').textContent=m?.originProtocol==='generic-erc20'?'已读取链上代币信息，发行平台尚未识别。买入尝试 BNB → 代币，卖出尝试代币 → BNB；以币安实时路由报价为准。没有报价时不提交交易；仅有未知内盘的币仍需接入其合约。':m?.protocol==='dex-swap'?'已毕业，使用币安 DEX 市价兑换。买入用 BNB，卖出直接回 BNB；无需再走内盘合约。':m?.protocol==='gang-curve'?`Gang ${m.variant.toUpperCase()}：按数量反算固定投入，以 ${m.quote.symbol} 结算。${m.transferLocked?'毕业前不能转账。':''}${m.variant==='v3'?`内盘收 1% 协议费；毕业后买税 ${m.taxConfig.buyTaxBps/100}%、卖税 ${m.taxConfig.sellTaxBps/100}%。`:''}${m.quote.symbol==='WBNB'?'WBNB 不足时先单独确认 BNB 兑换。':''}`:m?.protocol==='flap-agent'?'毕业前买卖的是此 CA 对应的虚拟份额，卖出结算为 '+m.quote.symbol+'。':m?.protocol==='openfour-agent'?'通过 OpenFour 专属内盘买卖；无需 Pancake 池，额度按链上持仓上限计算。':m?'按当前合约的报价与交易阶段执行，结算为 '+m.quote.symbol+'。':'内盘交易会走对应平台的合约。额度、持仓与报价以链上读取结果为准。';
 $('blockers').hidden=!m?.blockers?.length;$('blockers').textContent=(m?.blockers||[]).map(e=>errors[e]||`当前模式未开放交易（${e}）`).join(' ');
 $('claim-box').hidden=!h?.claimableRaw||BigInt(h.claimableRaw)===0n;$('claim-text').textContent=`待领取 ${h?.claimable||'0'} ${m?.base.symbol||''}。领取后才能作为代币出售。`;
 render();
}
function absorb(data){
 if(data?.operation&&operation?.intentId===data.operation.intentId&&(Number(operation.updatedAt)>Number(data.operation.updatedAt)||terminal.has(operation.status)&&!terminal.has(data.operation.status)))data={...data,operation};
 const operationChanged=Object.hasOwn(data||{},'operation')&&JSON.stringify([data.operation?.intentId,data.operation?.status,data.operation?.updatedAt])!==JSON.stringify([operation?.intentId,operation?.status,operation?.updatedAt]);
 if(data?.wallet){if(wallet.address!==data.wallet.address||wallet.connected!==data.wallet.connected){invalidate();holdings=null;$('amount').value='';$('recipient').value='';}wallet=data.wallet;if(wallet.connected)clearLogin();renderMarket();}
 if(Object.hasOwn(data||{},'operation'))operation=data.operation;
 if(data?.reconcileError)say('交易仍待核验',`${errors[data.reconcileError.code]||'暂未通过回执核验，请保留交易记录。'}（${data.reconcileError.code}）`);
 else if(operationChanged&&operation)say(terminal.has(operation.status)?operation.status==='FAILED'&&operation.steps?.length===0?'上次报价未通过 · 未提交交易':'上次操作已结束':'操作处理中',(market&&operation.market?.toLowerCase()!==market.tokenAddress.toLowerCase()?'另一代币的记录（'+operation.market+'）：':'')+(operation.action?.startsWith('panelAuto')?automaticFailureMessage(operation):operation.message||operation.status));
 renderFlow();render();refreshSettledHoldings();
}
function refreshSettledHoldings(){
 const op=operation;if(balancesRefreshing||!wallet.connected||!validSelection()||!terminal.has(op?.status)||!op.steps?.some(s=>s.status==='CONFIRMED')||op.market?.toLowerCase()!==market.tokenAddress.toLowerCase())return;
 const ca=market.tokenAddress,address=wallet.address,rev=revision,key=address+':'+ca+':'+op.intentId;if(settledRefreshKey===key)return;
 balancesRefreshing=true;settledRefreshKey=key;
 // One read after settlement, not a second trade or a continuous balance poll.
 // Keep the current inputs and discard results for another wallet/selection.
 client.sendMessage({id:crypto.randomUUID(),method:'panelQuery',params:{profile:'unified',tokenAddress:ca}}).then(r=>{
  if(!r?.ok||!r.data?.holdings||r.data.market?.tokenAddress?.toLowerCase()!==ca.toLowerCase())throw Error('BALANCE_REFRESH_FAILED');
  if(rev!==revision||wallet.address!==address||r.data.wallet?.address!==address||parseCA($('ca').value)?.toLowerCase()!==ca.toLowerCase())return;
  market=r.data.market;holdings=r.data.holdings;$('data-time').textContent='成交后更新 · 区块 '+BigInt(market.block).toString();renderMarket();
 }).catch(()=>{settledRefreshKey='';if(rev===revision&&wallet.address===address&&validSelection())$('data-time').textContent='持仓更新失败，点击刷新状态重试';}).finally(()=>{balancesRefreshing=false;});
}
function renderFlow(){const flow=operation?.action?.startsWith('panelAuto')?operation:null;$('flow-steps').hidden=!flow?.steps?.length;$('flow-steps').replaceChildren();$('flow-timing').textContent='';if(!flow)return;
 if(!flow.steps?.length){$('flow-timing').textContent=terminal.has(flow.status)?'报价阶段已结束 · 未提交交易':'正在准备报价 · 尚未提交交易';return;}
 const names={panelFund:'BNB 兑换结算币',panelWrap:'BNB 包装为 WBNB',panelApprove:'本次数量授权',panelBuy:'内盘买入',panelSell:'内盘卖出',panelConvert:'本次所得换回 BNB'},states={SUBMITTING:'正在提交',SUBMITTED:'等待到账',PENDING_CONFIRMATION:'等待币安确认',UNKNOWN:'结果待核验',CONFIRMED:'已到账',FAILED:'失败',REJECTED:'未提交'};
 for(const step of flow.steps||[]){const li=document.createElement('li'),times=[];if(Number.isFinite(step.prepareMs))times.push('报价 '+(step.prepareMs/1000).toFixed(2)+' 秒');if(step.submittedAt>=step.startedAt)times.push('提交 '+((step.submittedAt-step.startedAt)/1000).toFixed(2)+' 秒');if(step.confirmedAt>=step.submittedAt)times.push('回执 '+((step.confirmedAt-step.submittedAt)/1000).toFixed(2)+' 秒');li.textContent=(step.plan?.protocol==='dex-swap'?(step.action==='panelBuy'?'DEX 买入':'DEX 卖出 → BNB'):(names[step.action]||step.action))+' · '+(states[step.status]||step.status)+(times.length?' · '+times.join(' / '):'');$('flow-steps').append(li);}
 $('flow-timing').textContent=(flow.firstSubmittedAt?'首笔提交 '+((flow.firstSubmittedAt-flow.createdAt)/1000).toFixed(2)+' 秒':terminal.has(flow.status)?'流程已结束':'正在准备首笔提交')+(flow.completedAt?' · 全部到账 '+((flow.completedAt-flow.createdAt)/1000).toFixed(2)+' 秒':terminal.has(flow.status)?flow.status==='COMPLETE'?' · 最终步骤已核验':' · 后续交易已停止，已到账步骤保留':' · 链上确认中');
}
async function request(method,params={}){
 const financial=['panelExecute','panelTrade','transfer'].includes(method);let r;try{r=await client.sendMessage({id:crypto.randomUUID(),method,params:{profile:method.startsWith('panel')?'unified':'heyi',...params}});}
 catch{if(financial)guard={intentId:params.intentId,status:'UNKNOWN'};throw Error(financial?'UNKNOWN':'NATIVE_UNAVAILABLE');}
 const stale=r?.data?.operation&&operation?.intentId===r.data.operation.intentId&&(Number(operation.updatedAt)>Number(r.data.operation.updatedAt)||terminal.has(operation.status)&&!terminal.has(r.data.operation.status));
 if(!stale&&r?.guard!==undefined&&(r.guard||!guard||financial&&r.submissionNotStarted||r.data?.operation?.intentId===guard.intentId))guard=r.guard;
 if(!r?.ok){if(financial&&!r?.submissionNotStarted&&!guard)guard={intentId:params.intentId,status:'UNKNOWN'};throw Object.assign(Error(r?.error?.code||'UNKNOWN'),{funding:r?.error?.funding,budget:r?.error?.budget});}
 absorb(r.data);return r.data;
}
function showError(e){const code=/^[A-Z][A-Z0-9_]{0,80}$/.test(e?.message||'')?e.message:'READ_FAILED',message=`${code==='FUNDING_BUDGET_EXCEEDED'&&budgetMessage(e.budget)||code==='INSUFFICIENT_BALANCE'&&fundingMessage(e.funding)||errors[code]||'操作未完成，请核对当前状态。'}（${code}）`;
 say('操作未完成',message);if($('login-dialog').open)$('login-status').textContent=message;render();}
async function task(fn){if(busy)return;const version=formRevision;busy=true;render();try{await refreshDone;if(version!==formRevision)return;await fn();}catch(e){showError(e);}finally{busy=false;render();}}
async function query(){
 const ca=parseCA($('ca').value);if(!ca){clearMarket();throw Error('INVALID_ADDRESS');}invalidate();
 const rev=++revision,data=await request('panelQuery',{tokenAddress:ca});if(rev!==revision||parseCA($('ca').value)?.toLowerCase()!==ca.toLowerCase())return null;
 market=data.market;holdings=data.holdings;$('ca').value=market.tokenAddress;$('data-time').textContent='刚刚更新 · 区块 '+BigInt(market.block).toString();renderMarket();
 recent=[{ca:market.tokenAddress,symbol:market.base.symbol},...recent.filter(x=>x.ca.toLowerCase()!==ca.toLowerCase())].slice(0,6);
 await client.storage.set({yespRecentMarkets:recent});renderRecent();return data;
}
function renderRecent(){$('recent').replaceChildren();for(const row of recent){const b=document.createElement('button');b.type='button';b.textContent=`${row.symbol.slice(0,16)} · ${row.ca.slice(0,6)}…${row.ca.slice(-4)}`;
 b.addEventListener('click',e=>{if(e.isTrusted&&!busy&&!polling)task(async()=>{$('ca').value=row.ca;clearMarket();say('正在读取市场','核验平台、阶段和持仓。');await query();if(market&&!pending())say('市场已识别',market.supported?'请填写本次交易数量和滑点，所需支付自动计算。':'当前阶段的支持情况见市场提示。');});});$('recent').append(b);}}
async function refresh(){if(busy||polling)return;let finish;refreshDone=new Promise(resolve=>{finish=resolve;});polling=true;render();try{let data=await request('panelStatus');if(data.operation?.action==='transfer'&&!terminal.has(data.operation.status))data=await request('walletStatus');if(!data.operation)say(wallet.connected?'钱包已连接':'请连接钱包',wallet.connected?'填写 CA 即可查询，内盘与通用 Swap 共用此钱包。':'点击右上角连接钱包，获取币安登录二维码。');}catch(e){showError(e);}finally{polling=false;finish();render();}}
function showPreview(p){preview=p;$('official-details').hidden=false;$('review-ack-text').textContent='我已核对完整 CA、钱包、数量、结算资产、滑点与授权。';$('ack').checked=false;$('review-title').textContent=p.kind==='approve'?(p.approvalRaw==='0'?'核对清零旧授权':'核对本次数量授权'):p.kind==='claim'?'核对领取代币':p.action==='buy'?'核对买入':'核对卖出';
 const facts=[['网络','BNB Smart Chain（56）'],['钱包',p.wallet],['完整 CA',p.tokenAddress],['市场',p.protocol||'Four.meme V2'],['操作',p.kind==='approve'?'仅授权，不会自动买卖':p.kind==='claim'?'领取':p.action==='buy'?'买入':'卖出'],
  ['目标数量',`${p.amount} ${p.base.symbol}`],...(p.actualTokenAmount?[['本次报价数量',`${p.actualTokenAmount} ${p.base.symbol}`]]:[]),
  [p.action==='buy'&&!p.protocol?.startsWith('flap')&&p.protocol!=='gang-curve'?'最高支付':'本次投入',`${p.spend} ${p.action==='buy'?p.quote.symbol:p.base.symbol}`],['预计收到',`${p.expected} ${p.action==='buy'||p.kind==='claim'?p.base.symbol:p.quote.symbol}`],
  [p.action==='sell'&&!p.protocol?'最低曲线回款（未扣费）':'最低收到',`${p.minimum} ${p.action==='buy'||p.kind==='claim'?p.base.symbol:p.quote.symbol}`],['滑点',Number(p.slippageBps)/100+'%'],['预估网络费',`${p.estimatedGas} BNB`]];
 if(p.estimatedSpend)facts.push(['预计支付',`${p.estimatedSpend} ${p.quote.symbol}`]);
 if(p.totalFee||p.protocolFee)facts.push(['报价费用',`${p.totalFee||p.protocolFee} ${p.quote.symbol}`]);
 if(p.kind==='approve')facts.push(['授权代币',p.approvalToken],['授权给',p.manager],['授权数量',p.approvalAmount]);
 if(p.tax)facts.push(['买 / 卖税率',`${Number(p.tax.buyFeeRate)/100}% / ${Number(p.tax.sellFeeRate)/100}%`]);
 if(p.buyTaxBps!==undefined)facts.push(['买 / 卖税率',`${Number(p.buyTaxBps)/100}% / ${Number(p.sellTaxBps)/100}%`]);
 $('review-facts').replaceChildren();for(const [k,v] of facts){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=String(v);$('review-facts').append(dt,dd);}
 $('review-note').textContent=p.kind==='approve'?'本次只提交上述授权。确认上链后，再点击核对买卖，重新取得报价。':p.protocol==='flap-agent'&&p.action==='sell'?'实际卖出份额已按 0.01% 持仓步长向下取整，剩余份额不会自动卖出。':(p.protocol?.startsWith('flap')||p.protocol==='gang-curve')&&p.action==='buy'?'合约按固定投入成交，目标数量为估算；最低收到数量受滑点保护，成交不足不会自动补买。':'请核对钱包、CA 和数量。确认只提交本次预演的交易。';
 const risk=p.official?.risks;$('risk-summary').textContent=risk?.riskDetails?.length||risk?.riskBehaviors?.length?'币安预演返回风险提示，请展开明细核对后再决定。':'币安预演已返回，请仍核对本次交易参数。';
 $('official-preview').textContent=JSON.stringify(p.official,null,2);$('send').textContent=p.kind==='approve'?'确认授权':p.kind==='claim'?'确认领取':p.action==='buy'?'确认买入':'确认卖出';if(p.kind==='wrap'){
  $('review-title').textContent='核对 BNB 兑换为 WBNB';$('send').textContent='确认兑换 WBNB';$('review-note').textContent='本次仅把所需 BNB 按 1:1 包装为 WBNB，不会买入代币。确认上链后重新核对买入，再分别确认授权和交易。';
  $('review-facts').replaceChildren();for(const [k,v]of [['钱包',p.wallet],['操作','BNB → WBNB（1:1）'],['支付 BNB',p.spend],['收到 WBNB',p.spend],['WBNB 合约',p.tx.to],['预估网络费',p.estimatedGas+' BNB']]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=v;$('review-facts').append(dt,dd);}
 }if(p.kind==='fund')showFundingFacts(p);if(p.protocol==='dex-swap')showDexFacts(p);$('review').showModal();render();
}
function showDexFacts(p){
 const buy=p.kind==='buy',output=buy?p.base.symbol:'BNB';
 $('review-title').textContent=buy?'核对 DEX 买入':'核对 DEX 卖出 → BNB';$('official-details').hidden=true;$('official-preview').textContent='';
 $('review-facts').replaceChildren();
 for(const [k,v]of [['网络','BNB Smart Chain（56）'],['钱包',p.wallet],['完整 CA',p.tokenAddress],['路径',buy?'BNB → '+p.base.symbol:p.base.symbol+' → BNB'],['目标数量',p.amount+' '+p.base.symbol],['本次固定投入',p.spend+' '+(buy?'BNB':p.base.symbol)],['预计收到',p.expected+' '+output],['参考最低收到',p.minimum+' '+output],['滑点上限',Number(p.slippageBps)/100+'%'],['网络费余额预留',p.gasReserve+' BNB（不是最终费用）']]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=v;$('review-facts').append(dt,dd);}
 $('review-note').textContent='币安市价单在执行时重新报价，参考最低数量不是锁定报价。按固定投入成交，到账不足或部分退款会如实显示，不自动重复交易。';
 $('risk-summary').textContent='这是 DEX 报价，尚未提交交易。币安会在执行时检查兑换、授权及手机确认要求。';
 $('review-ack-text').textContent='我已核对 CA、钱包、固定投入、滑点和参考到账数量；确认执行本次 DEX 兑换。';
}
function showFundingFacts(p){
 $('review-title').textContent='第 1 步 · 用 BNB 兑换结算币';$('send').textContent='确认兑换 '+p.quote.symbol;$('official-details').hidden=true;$('official-preview').textContent='';
 $('review-facts').replaceChildren();for(const [k,v]of [['钱包',p.wallet],['后续目标 CA',p.tokenAddress],['后续购买数量',p.amount+' '+p.base.symbol],['兑换路径','BNB → '+p.quote.symbol+' → '+p.base.symbol],['结算币 CA',p.quote.address],['现有结算币',p.funding.available+' '+p.quote.symbol],['需补差额',p.funding.shortfall+' '+p.quote.symbol],['本次固定支付',p.spend+' BNB'],p.fundingSettings.mode==='quantity'?['兑换方式','按目标数量计算，只兑换结算币差额']:['兑换预算上限',p.fundingSettings.maxBnb+' BNB（不含 Gas）'],['预计到账',p.expected+' '+p.quote.symbol],['参考最低到账',p.minimum+' '+p.quote.symbol],['兑换滑点',Number(p.fundingSettings.slippageBps)/100+'%'],['后续买入滑点',Number(p.slippageBps)/100+'%'],['网络费预留检查',p.gasReserve+' BNB（不是最终费用上限）']]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=v;$('review-facts').append(dt,dd);}
 $('review-note').textContent='本次只兑换结算币，不会买入目标代币。到账后按实际余额重新核对授权和买入；多余结算币保留在钱包。';
 $('risk-summary').textContent='币安市价兑换会在执行时重新报价，参考最低到账不是锁定报价。手续费按币安实际报价执行；到账不足或后续买入失败时，已完成的兑换不会撤回或自动重复。';
 $('review-ack-text').textContent='我已核对 BNB 支付、结算币完整 CA、两段滑点和计算出的支付金额；确认本次仅兑换结算币。';
}
function showTransferPreview(p){
 preview={...p,kind:'transfer'};$('ack').checked=false;$('review-title').textContent='核对代币转出';
 $('review-facts').replaceChildren();
 for(const [k,v] of [['网络','BNB Smart Chain（56）'],['转出钱包',p.wallet],['收款地址',p.recipient],['完整 CA',p.tokenAddress],['转出数量',p.amount+' '+p.symbol],['真实代币余额',p.balance],['预估网络费',p.estimatedFee+' BNB'],['BNB 预留检查',p.gasReserve+' BNB（不是最终费用上限）']]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=k;dd.textContent=v;$('review-facts').append(dt,dd);}
 $('review-note').textContent='请核对完整收款地址。代币转账不适用买卖滑点；带税代币实际到账可能少于转出数量。';
 $('risk-summary').textContent='已核对链上余额、代币精度和转账 Gas 模拟。若币安要求地址簿或手机确认，请在 App 完成。';
 $('official-details').hidden=true;$('official-preview').textContent='';$('review-ack-text').textContent='我已核对 BSC 网络、完整收款地址、当前代币 CA、转出数量和网络费。';
 $('send').textContent='确认转出';$('review').showModal();render();
}
async function prepareTransfer(){
 if(!validSelection()||!wallet.connected||pending())return;if(transferBlocked(market))throw Error('TRANSFER_UNAVAILABLE');
 invalidate();const version=formRevision,params={tokenAddress:market.tokenAddress,recipient:$('recipient').value.trim(),amount:$('amount').value.trim()};
 const expectedWallet=wallet.address;if(!/^0x[\da-f]{40}$/i.test(params.recipient)||/^0x0{40}$/i.test(params.recipient))throw Error('INVALID_ADDRESS');
 if(toRaw(params.amount,market.base.decimals)<=0n)throw Error('INVALID_AMOUNT');say('正在核对转出','读取当前代币余额并模拟转账。');
 const data=await request('transferPrepare',params),p=data?.transferPreview;
 if(version!==formRevision||side!=='transfer'||!validSelection())return;
 if(!p||p.wallet?.toLowerCase()!==expectedWallet.toLowerCase()||wallet.address?.toLowerCase()!==expectedWallet.toLowerCase()||p.tokenAddress?.toLowerCase()!==params.tokenAddress.toLowerCase()||p.recipient?.toLowerCase()!==params.recipient.toLowerCase()||p.decimals!==market.base.decimals||toRaw(p.amount,p.decimals)!==toRaw(params.amount,p.decimals))throw Error('TRANSFER_PREVIEW_MISMATCH');
 showTransferPreview(p);
}
async function prepare(action=side,sellPercent){if(action==='transfer')return prepareTransfer();if(!validSelection()||!wallet.connected||pending()||autoActive)return;
 invalidate();const version=formRevision,expectedWallet=wallet.address,amount=action==='claim'?holdings.claimable:$('amount').value.trim(),params={tokenAddress:market.tokenAddress,action,...(sellPercent?{sellPercent}:{amount}),slippageBps:slippageBps($('slippage').value.trim()),...(action==='buy'?{buyMode:'tokenAmount',...($('funding-enabled').checked||market.protocol==='dex-swap'?{funding:{mode:'quantity',slippageBps:slippageBps($('funding-slippage').value.trim())}}:{})}:{})};
 if(!sellPercent&&toRaw(amount,market.base.decimals)<=0n)throw Error('AMOUNT_PRECISION');say('正在核对交易','读取链上报价并运行币安预演，请稍候。');const data=await request('panelPrepare',params),p=data?.tradePreview;
 if(version!==formRevision||!validSelection()||autoActive||pending())return;
 if(!p||p.wallet?.toLowerCase()!==expectedWallet?.toLowerCase()||wallet.address?.toLowerCase()!==expectedWallet?.toLowerCase()||p.tokenAddress?.toLowerCase()!==params.tokenAddress.toLowerCase()||p.action!==action||p.slippageBps!==params.slippageBps||sellPercent&&p.sellPercent!==sellPercent)throw Error('PREVIEW_MISMATCH');
 if(sellPercent)$('amount').value=p.amount;
 if(p.timing){const t=p.timing;$('quote-timing').textContent=`本次核对 ${t.totalMs} ms · 钱包 ${t.walletMs} / 报价 ${t.quoteMs} / 预演 ${t.previewMs} ms`;}
 showPreview(p);say('报价已返回，尚未提交',p.protocol==='dex-swap'?'DEX 报价已就绪，请核对确认页。关闭确认页不会执行交易。':'预演已返回，请核对确认页。关闭确认页不会执行交易。');
}
async function trade(action=side,sellPercent){if(!oneclick()||action==='claim')return prepare(action,sellPercent);if(!validSelection()||!wallet.connected||pending()||autoActive)return;
 const params={tokenAddress:market.tokenAddress,wallet:wallet.address,action,...(sellPercent?{sellPercent}:{amount:$('amount').value.trim()}),slippageBps:slippageBps($('slippage').value.trim()),swapSlippageBps:slippageBps($('funding-slippage').value.trim()),...(action==='buy'?{fundingMode:'quantity'}:{}),intentId:crypto.randomUUID()};
 if(!sellPercent&&toRaw(params.amount,market.base.decimals)<=0n)throw Error('AMOUNT_PRECISION');invalidate();guard={intentId:params.intentId,status:'PENDING'};const start=performance.now();say('正在发送一键交易','按当前数量计算所需支付，并按滑点执行。请勿重复点击。');await request('panelTrade',params);$('quote-timing').textContent='本机受理 '+Math.round(performance.now()-start)+' ms；实际提交与到账时间见交易状态。';
}
for(const b of document.querySelectorAll('[data-quick-buy],[data-quick-sell]'))b.addEventListener('click',e=>{if(!e.isTrusted||b.disabled)return;task(async()=>{side=b.dataset.quickBuy?'buy':'sell';$('amount').value=b.dataset.quickBuy||'';invalidate();await trade(side,b.dataset.quickSell);});});
$('lookup').addEventListener('submit',e=>{e.preventDefault();if(e.isTrusted)task(async()=>{clearMarket();say('正在识别代币','核验平台合约与当前市场阶段。');await query();if(market)say('市场已识别',market.supported?'可以填写数量并核对报价。':'当前阶段的支持情况见市场提示。');});});
$('ca').addEventListener('input',()=>{revision++;clearMarket();});
$('funding-enabled').addEventListener('change',invalidate);$('oneclick-enabled').addEventListener('change',invalidate);
$('preview-only').addEventListener('click',e=>{if(e.isTrusted&&!$('preview-only').disabled)task(()=>prepare());});
for(const id of ['amount','slippage','recipient','funding-slippage'])$(id).addEventListener('input',invalidate);
for(const action of ['buy','sell','transfer'])$(action).addEventListener('click',e=>{if(e.isTrusted&&!busy&&!polling){side=action;$('amount').value='';$('recipient').value='';invalidate();render();if(side==='transfer'&&validSelection()&&wallet.connected)task(()=>query());}});
for(const b of document.querySelectorAll('[data-quantity]'))b.addEventListener('click',e=>{if(e.isTrusted&&!busy){$('amount').value=b.dataset.quantity;invalidate();}});
for(const b of document.querySelectorAll('[data-percent]'))b.addEventListener('click',e=>{if(e.isTrusted)task(async()=>{if(!await query()||!holdings)throw Error('LOGIN_REQUIRED');if(side==='transfer'&&transferBlocked(market))throw Error('TRANSFER_UNAVAILABLE');$('amount').value=percentAmount(holdings.base,market.base.decimals,b.dataset.percent,side==='sell'&&!market.protocol);invalidate();});});
$('continue-buy').addEventListener('click',e=>{if(!e.isTrusted||$('continue-buy').disabled)return;const plan=operation?.steps?.[0]?.plan;if(!plan)return;task(async()=>{side='buy';$('ca').value=plan.tokenAddress;clearMarket();if(!await query())return;$('amount').value=plan.amount;$('slippage').value=String(Number(plan.slippageBps)/100);$('funding-enabled').checked=false;invalidate();await prepare('buy');});});
 $('fill-limit').addEventListener('click',e=>{if(e.isTrusted)task(async()=>{if(!await query())return;const value=buyRoom(market,holdings);if(value===null)throw Error('LOGIN_REQUIRED');$('amount').value=value;invalidate();});});
$('order-form').addEventListener('submit',e=>{e.preventDefault();if(e.isTrusted&&!$('prepare').disabled)task(()=>trade());});
$('claim').addEventListener('click',e=>{if(e.isTrusted&&!$('claim').disabled)task(()=>prepare('claim'));});
$('ack').addEventListener('change',render);$('cancel').addEventListener('click',e=>{if(e.isTrusted&&!busy)invalidate();});$('review').addEventListener('cancel',e=>{if(busy)e.preventDefault();else invalidate();});
$('send').addEventListener('click',e=>{if(!e.isTrusted||$('send').disabled||!preview)return;const previewId=preview.previewId,method=preview.kind==='transfer'?'transfer':'panelExecute',intentId=crypto.randomUUID();task(async()=>{guard={intentId,status:'PENDING'};invalidate();say('正在提交','请勿重复点击，等待币安返回提交结果。');await request(method,{previewId,intentId});if(method==='transfer')$('recipient').value='';});});
$('refresh').addEventListener('click',e=>{if(e.isTrusted)refresh();});
$('recover').addEventListener('submit',e=>{e.preventDefault();if(e.isTrusted&&operation&&!terminal.has(operation.status))task(()=>request(operation.action==='transfer'?'transferReconcile':'panelReconcile',{intentId:operation.intentId,txHash:$('tx-hash').value.trim()}));});
for(const id of ['login-toggle','wallet-settings'])$(id).addEventListener('click',e=>{if(e.isTrusted&&!$('login-dialog').open){$('login-status').textContent=wallet.connected?'当前钱包会话已连接，三个平台共用此会话。':'';$('login-dialog').showModal();}});
$('close-login').addEventListener('click',e=>{if(e.isTrusted&&!busy)$('login-dialog').close();});
$('login-dialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});
$('signin').addEventListener('click',e=>{if(e.isTrusted)task(async()=>{clearLogin();$('login-status').textContent='正在获取币安官方登录二维码…';const d=await request('signin');
 if(d?.connected){await request('panelStatus');$('login-status').textContent='钱包已连接。';return;}
 if(!isOfficialSigninUrl(d?.urlForWeb)||!Number.isSafeInteger(Number(d.expireAt))||Number(d.expireAt)<=Date.now()||!/^[A-Za-z0-9]{1,64}$/.test(d.pairingCode||''))throw Error('AUTH_URL_REVIEW_REQUIRED');
 signinExpiry=Number(d.expireAt);$('signin-details').hidden=false;$('pairing-code').textContent=d.pairingCode;$('signin-link').href=d.urlForWeb;$('signin-link').hidden=false;
 if(typeof d.qrImage==='string'&&d.qrImage.length<500000&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(d.qrImage)){$('signin-qr').src=d.qrImage;$('signin-qr').hidden=false;}
 $('login-status').textContent='请使用币安 App 扫码，核对配对码并确认登录。';});});
$('verify').addEventListener('click',e=>{if(e.isTrusted&&!$('verify').disabled)task(async()=>{$('login-status').textContent='等待币安确认，最多 5 分钟。';const d=await request('verify');if(d.connected){clearLogin();await request('panelStatus');$('login-dialog').close();if(parseCA($('ca').value))await query();}else{$('login-status').textContent='尚未连接，请重新获取二维码。';clearLogin();}});});
client.subscribe?.('trade',data=>{if(!data?.operation)return;absorb(data);guard=operation&&!terminal.has(operation.status)?{intentId:operation.intentId,status:operation.status}:null;render();});
client.onProgress(data=>{const m={data};if(m.data?.guard!==undefined)guard=m.data.guard;if(m.data?.connection==='disconnected'){invalidate();clearLogin();say('本机连接已断开','请刷新状态；已提交的交易不会自动重发。');}render();});
window.addEventListener('hashchange',()=>{revision++;clearMarket();$('ca').value=parseCA(location.hash.slice(1))||'';});
async function init(){
 $('version').textContent=client.version();
 try{const stored=(await client.storage.get('yespRecentMarkets')).yespRecentMarkets;recent=Array.isArray(stored)?stored.filter(x=>parseCA(x?.ca)===x.ca&&typeof x.symbol==='string').slice(0,6):[];renderRecent();}catch{}
 $('ca').value=parseCA(location.hash.slice(1))||'';renderMarket();await refresh();
}
init();setInterval(()=>{if(!document.hidden&&(preview||signinExpiry))render();},1000);setInterval(()=>{if(!document.hidden)refresh();},15000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden)render();});

setupLocalFeatures({client,getSelected:()=>market,onSelect:ca=>task(async()=>{$('ca').value=ca;clearMarket();await query();}),onActive:value=>{if(autoActive!==value){autoActive=value;invalidate();}render();}});
