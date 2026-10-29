// Only public, typed funding facts cross the native/local error boundary.
export function safeFunding(value){
 if(!value||typeof value!=='object'||!/^0x[\da-f]{40}$/i.test(value.assetAddress||'')||typeof value.symbol!=='string'||!value.symbol||value.symbol.length>80||/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value.symbol))return null;
 const decimal=x=>typeof x==='string'&&x.length<=116&&/^\d+(?:\.\d{1,36})?$/.test(x);
 if(!['required','available','shortfall'].every(k=>decimal(value[k])))return null;
 return {assetAddress:value.assetAddress,symbol:value.symbol,required:value.required,available:value.available,shortfall:value.shortfall};
}
export function fundingMessage(value){const f=safeFunding(value);return f?`支付资产 ${f.symbol} 不足：本次需备 ${f.required}，余额 ${f.available}，还差 ${f.shortfall} ${f.symbol}。资产 CA：${f.assetAddress}。`:null;}

// Budget failures contain only quote facts, never raw CLI output or credentials.
export function safeBudget(value){
 if(!value||!['fund','dex','native'].includes(value.kind))return null;
 const decimal=x=>typeof x==='string'&&x.length<=116&&/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(x);
 const symbol=x=>typeof x==='string'&&x.length>0&&x.length<=80&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(x);
 if(!['maxBnb','amount','needed','expected','minimum'].every(k=>decimal(value[k]))||!symbol(value.tokenSymbol)||!symbol(value.symbol))return null;
 return Object.fromEntries(['kind','maxBnb','amount','needed','expected','minimum','tokenSymbol','symbol'].map(k=>[k,value[k]]));
}
const display=x=>{const [whole,f='']=x.split('.'),fraction=f.slice(0,6).replace(/0+$/,'');return whole.replace(/\B(?=(\d{3})+(?!\d))/g,',')+(fraction?'.'+fraction:'');};
export function budgetMessage(value){const b=safeBudget(value);if(!b)return null;
 const first=`目标 ${display(b.amount)} ${b.tokenSymbol}，BNB 支付上限 ${b.maxBnb}。`;
 return first+(b.kind==='fund'?`还需约 ${display(b.needed)} ${b.symbol}；该预算预计可兑换约 ${display(b.expected)}，按兑换滑点检查约 ${display(b.minimum)} ${b.symbol}，不足以完成买入。`:b.kind==='dex'?`该预算预计可买约 ${display(b.expected)} ${b.symbol}，低于目标数量。`:`本次流程需要支付约 ${display(b.needed)} BNB，超过上限。`)+ ' 请减少购买数量，或自行调整 BNB 支付上限后重新核对报价。';
}
export function safePriceChange(value){
 if(!value||typeof value.slippageBps!=='string'||!/^\d{1,4}$/.test(value.slippageBps)||Number(value.slippageBps)<1||Number(value.slippageBps)>9999)return null;
 const decimal=x=>typeof x==='string'&&x.length<=116&&/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(x);
 const symbol=x=>typeof x==='string'&&x.length>0&&x.length<=80&&!/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(x);
 if(!['amount','expected','minimum','spend'].every(k=>decimal(value[k]))||!symbol(value.symbol)||!symbol(value.quoteSymbol))return null;
 return Object.fromEntries(['amount','expected','minimum','spend','symbol','quoteSymbol','slippageBps'].map(k=>[k,value[k]]));
}
export function automaticFailureMessage(op){
 const empty=Array.isArray(op.steps)&&op.steps.length===0;
 if(op.error?.code==='AUTO_PRICE_CHANGED'){
  const facts=safePriceChange(op.error.price),slip=op.request?.slippageBps,swap=op.request?.swapSlippageBps;
  const validBps=x=>/^\d{1,4}$/.test(x||'')&&Number(x)>0&&Number(x)<10000;
  const detail=facts?`固定投入 ${facts.spend} ${facts.quoteSymbol}，当时预计收到 ${display(facts.expected)} ${facts.symbol}，低于本次最低 ${display(facts.minimum)} ${facts.symbol}（目标 ${display(facts.amount)}，买入滑点 ${Number(facts.slippageBps)/100}%）。`:`价格已超出本次首份报价允许范围${validBps(slip)?'（买入滑点 '+Number(slip)/100+'%）':''}。`;
  const confirmed=(op.steps||[]).some(s=>s.status==='CONFIRMED'&&['panelFund','panelWrap'].includes(s.action));
  return detail+(validBps(swap)?`兑换滑点 ${Number(swap)/100}% 只用于兑换结算币，不控制目标代币买入。`:'')+(empty?'本次未提交交易。':confirmed?'已到账的结算币保留在钱包，目标代币尚未买入。':'后续买入已停止。')+'可修改当前数量与滑点后重新买入，也可仅查看报价；已有结算币会先抵扣，不会自动重发旧交易。';
 }
 if(op.error?.code==='FUNDING_BUDGET_EXCEEDED'){
  const p=op.request,legacy=p?.action==='buy'&&/^[\d.]+$/.test(p.amount||'')&&/^[\d.]+$/.test(p.maxBnb||'')?`本次目标 ${display(p.amount)} 枚，BNB 支付上限 ${p.maxBnb}；所需支付超过预算。平台持仓额度不代表预算可买数量。请减少数量或自行调整预算后重新核对。`: '所需支付超过 BNB 预算，请核对数量与支付上限。';
  return (budgetMessage(op.error.budget)||legacy)+(empty?' 本次在报价阶段停止，未提交兑换、授权或买入。':' 已执行步骤保留，后续步骤停止，未自动重试。');
 }
 if(empty&&['FAILED','REJECTED'].includes(op.status))return `报价或参数检查未通过（${op.error?.code||op.status}），未提交交易。`;
 return op.message||op.status;
}
