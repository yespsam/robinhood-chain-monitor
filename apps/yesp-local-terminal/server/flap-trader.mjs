import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseUnits } from 'ethers';
import { createFastTradeCli } from './fast-trade-cli.mjs';
import { createFlapReader, portalAbi, tokenAbi, tradeEvents, fault, same, human } from './flap-reader.mjs';
import { FlapJournal, TERMINAL } from './flap-journal.mjs';

const NATIVE='0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const actions=new Set(['buy','sell','claim']);
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const asRaw=x=>parseUnits(String(x),18);
const cleanError=e=>({code:/^[A-Z0-9_]{1,100}$/.test(e.code||'')?e.code:'OPERATION_FAILED',
  ...(e.officialCode?{officialCode:e.officialCode}:{}),...(e.officialName?{officialName:e.officialName}:{})});
const closeAmount=(a,b)=>{const x=BigInt(a),y=BigInt(b),diff=x>y?x-y:y-x;return diff<=((y<0n?-y:y)/100000000000000n+1n);};
function profilePublic(p) {return {id:p.id,name:p.name,market:p.market,wallet:p.wallet,quoteSymbol:p.quoteSymbol,quote:p.quote};}
function statePublic(s,connected) {return {connected,phase:s.phase,shares:human(s.sharesRaw),balance:human(s.balanceRaw),allowance:human(s.allowanceRaw),native:human(s.nativeRaw),block:s.block,observedAt:new Date(s.snapshotAtMs).toISOString()};}
function planPublic(p) {return {gross:p.grossRaw===undefined?undefined:human(p.grossRaw),shares:p.sharesRaw===undefined?undefined:human(p.sharesRaw),
  claim:p.claimRaw===undefined?undefined:human(p.claimRaw),
  minShares:p.minSharesRaw===undefined?undefined:human(p.minSharesRaw),expectedOut:p.expectedOutRaw===undefined?undefined:human(p.expectedOutRaw),
  minOut:p.minOutRaw===undefined?undefined:human(p.minOutRaw),requiredFunding:p.requiredFundingRaw===undefined?undefined:human(p.requiredFundingRaw),calls:p.calls};}
export function validatePreview(preview,{action,profile,plan,tx}) {
  if(preview?.outcome!=='PREVIEWED')throw fault(preview?.code||'PREVIEW_FAILED');
  const d=preview.data,s=d.simulationResult,r=d.risks,parsed=d.parsedTx;
  if(!s||s.simulationCode!=='000000000'||s.simulationErrorDetail||!parsed||!same(parsed.contractAddress,tx.to))throw fault('PREVIEW_MISMATCH');
  if(!r||!Array.isArray(r.riskDetails)||!Array.isArray(r.riskBehaviors)||!r.addresses)throw fault('PREVIEW_RISKS_MISSING');
  if(r.riskDetails.length||r.riskBehaviors.length||Object.values(r.addresses).some(x=>(x.riskDetails||[]).length||Number(x.riskLevel)>1))throw fault('NEW_RISK_REQUIRES_REVIEW');
  if(!Array.isArray(s.authorityChanges)||s.authorityChanges.length||!Array.isArray(s.balanceChanges)||!Array.isArray(s.allowanceChanges))throw fault('UNEXPECTED_AUTHORITY_CHANGE');
  if(s.gasTokenFromData===undefined||s.gasTokenFromData===null||!/^\d+$/.test(String(s.gasTokenFromData))||BigInt(s.gasTokenFromData)!==0n)throw fault('UNEXPECTED_NATIVE_TRANSFER');
  if(action==='approve') {
    if(parsed.transactionType!=='Approve'||!same(parsed.spender,profile.market)||!closeAmount(parsed.amount,plan.grossRaw)||s.balanceChanges.length)throw fault('APPROVAL_PREVIEW_MISMATCH');
    if(s.allowanceChanges.length!==1)throw fault('APPROVAL_PREVIEW_MISMATCH');
    const a=s.allowanceChanges[0];if(!same(a.owner,profile.wallet)||!same(a.tokenAddress,profile.quote)||!same(a.spender,profile.market)||!closeAmount(a.postAmount,plan.grossRaw))throw fault('APPROVAL_PREVIEW_MISMATCH');
  } else {
    if(parsed.action!==tx.inputData.slice(0,10)||s.allowanceChanges.length)throw fault('TRADE_PREVIEW_MISMATCH');
    const token=action==='claim'?plan.token:profile.quote;
    if(!s.balanceChanges.length||s.balanceChanges.some(x=>!same(x.owner,profile.wallet)||!same(x.contractAddress,token)||x.tokenType!=='Erc20'))throw fault('UNEXPECTED_ASSET_CHANGE');
    const net=s.balanceChanges.reduce((sum,x)=>sum+BigInt(x.change),0n);
    if(action==='buy'&&(net>=0n||!closeAmount(-net,plan.grossRaw-(plan.refundRaw||0n))))throw fault('BUY_DEBIT_MISMATCH');
    if(action==='sell'&&(net<=0n||net<plan.minOutRaw))throw fault('SELL_RECEIPT_MISMATCH');
    if(action==='claim'&&(net<=0n||net>plan.claimRaw&&!closeAmount(net,plan.claimRaw)))throw fault('CLAIM_RECEIPT_MISMATCH');
  }
  return d.requestId;
}

export function createFlapTrader({allowWrites=false,allowAuth=false,onProgress=()=>{},profile:givenProfile,reader:givenReader,cli:givenCli,
  journal:givenJournal,clock=Date.now,sleep=delay,profilePath=new URL('../.private/flap/profile.json',import.meta.url)}={}) {
  const cli=givenCli||createFastTradeCli({allowWrites,allowAuth});
  const journal=givenJournal||new FlapJournal(fileURLToPath(new URL('../.private/flap/operations/',import.meta.url)));
  let profilePromise,reader,login,active=null,statusPromise,lastStatus=null,authBusy=false;
  async function context() {
    profilePromise??=Promise.resolve(givenProfile||readFile(profilePath,'utf8').then(JSON.parse));
    const p=await profilePromise;
    if(p.id!=='heyi'||p.chainId!=='56'||p.buySlippageBps!==500||p.sellSlippageBps!==9900||p.priorAuditUnavailableAcknowledged!==true||!p.codeHashes||Object.keys(p.codeHashes).length<5)throw fault('PROFILE_REVIEW_REQUIRED');
    reader??=givenReader||createFlapReader(p,{clock});return {p,r:reader};
  }
  function emit(op,message,extra={}) {onProgress({intentId:op?.intentId,status:op?.status||'CHECKING',elapsedMs:op?clock()-op.createdAt:0,message,...extra});}
  async function latest() {const rows=(await journal.all()).filter(x=>['buy','sell','claim'].includes(x.action));return rows.sort((a,b)=>b.createdAt-a.createdAt)[0]||null;}
  async function authenticate(p) {
    if(authBusy)throw fault('LOGIN_IN_PROGRESS');
    const status=await cli.status();if(status.status!=='CONNECTED')throw fault('LOGIN_REQUIRED');
    // Same-session authenticated reads stay sequential; public RPC runs alongside.
    const addresses=await cli.addresses();if(!addresses.addresses?.some(a=>a.binanceChainId==='56'&&same(a.address,p.wallet)))throw fault('WALLET_CHANGED');
    const settings=await cli.settings();if(settings.devMode?.enabled!==true||settings.devMode.balanceExceeded)throw fault('DEVELOPER_MODE_REQUIRED');
    if((await cli.txLock('56')).status!=='UNLOCKED')throw fault('WALLET_LOCKED');
    return settings;
  }
  async function makePlan(action,s,r) {return action==='buy'?r.buyPlan(s):action==='sell'?r.sellPlan(s):r.claimPlan(s);}
  function readiness(s,connected,plan) {
    const blockers=[];if(!connected)blockers.push('LOGIN_REQUIRED');if(s.pendingNonce!==s.nonce)blockers.push('PENDING_TRANSACTION');
    if(s.nativeRaw<asRaw('0.001'))blockers.push('INSUFFICIENT_GAS');
    if(plan?.grossRaw>s.balanceRaw)blockers.push('INSUFFICIENT_QUOTE');
    if(plan?.grossRaw>s.allowanceRaw)blockers.push('ALLOWANCE_REQUIRED');
    return {buy:connected&&s.phase===1&&s.eligible&&s.roomRaw>0n,sell:connected&&s.phase===1&&s.sharesRaw>0n,claim:connected&&s.phase===3&&s.claimOk,blockers};
  }
  async function status({action}={}) {
    const {p,r}=await context();
    const connectedRead=authBusy?Promise.resolve(false):active?Promise.resolve(lastStatus?.state?.connected===true):cli.status().then(x=>x.status==='CONNECTED').catch(()=>false);
    const [s,connected]=await Promise.all([r.snapshot(),connectedRead]);
    let plan=null,planError=null;
    if(action)try{plan=await makePlan(action,s,r);}catch(e){planError=cleanError(e);}
    let op=await latest();
    if(op&&!TERMINAL.has(op.status)&&op.intentId!==active)try{
      op=await journal.exclusive(async()=>{const fresh=await journal.read(op.intentId);return TERMINAL.has(fresh.status)?fresh:reconcile(fresh,p,r);});
    }catch(e){if(e.code!=='UNRESOLVED_TRADE_LOCK')throw e;op=await latest();}
    const result={profile:profilePublic(p),state:statePublic(s,connected),readiness:readiness(s,connected,plan),plan:plan?planPublic(plan):null,
      ...(planError?{planError}:{}),operation:op,timings:{snapshotMs:s.readMs}};lastStatus=result;return result;
  }
  function checkDeadline(op) {if(clock()>=op.deadlineAt)throw fault('SUBMISSION_DEADLINE_EXCEEDED');}
  async function save(op) {op.updatedAt=clock();await journal.save(op);return op;}
  async function receipt(hash,r,{wait=true}={}) {
    if(!/^0x[\da-f]{64}$/i.test(hash||''))throw fault('TRANSACTION_HASH_MISSING');
    const end=clock()+(wait?45000:1);
    do {const rec=await r.rpc('eth_getTransactionReceipt',[hash]);if(rec){if(rec.transactionHash?.toLowerCase()!==hash.toLowerCase())throw fault('RECEIPT_MISMATCH');
        if(BigInt(rec.status)===0n)throw fault('TRANSACTION_REVERTED',{receipt:rec});if(BigInt(rec.status)!==1n)throw fault('INVALID_RECEIPT_STATUS');return rec;}if(!wait)return null;await sleep(600);}while(clock()<end);
    return null;
  }
  async function verifyReceiptIdentity(step,rec,p,r) {
    const tx=await r.rpc('eth_getTransactionByHash',[step.txHash]);
    if(!tx||!same(tx.from,p.wallet)||tx.blockHash!==rec.blockHash||!same(rec.from,p.wallet))throw fault('RECEIPT_IDENTITY_MISMATCH');
    if(step.tx&&(!same(tx.to,step.tx.to)||tx.input.toLowerCase()!==step.tx.inputData.toLowerCase()||BigInt(tx.value)!==0n))throw fault('RECEIPT_CALLDATA_MISMATCH');
  }
  async function saveRevert(op,step,e,p,r) {
    if(e.code!=='TRANSACTION_REVERTED')return;
    const rec=e.details.receipt;await verifyReceiptIdentity(step,rec,p,r);
    step.failedReceipt={txHash:rec.transactionHash,blockHash:rec.blockHash,blockNumber:rec.blockNumber,status:'0x0',gasRaw:(BigInt(rec.gasUsed)*BigInt(rec.effectiveGasPrice)).toString()};
    step.status='FAILED';await save(op);
  }
  function validateSwapOrder(row,step) {
    if(!row)return;
    const trade=step.trade;
    if(row.orderId!==step.orderId||row.chain!==trade.chainId||!same(row.fromToken,trade.fromToken)||!same(row.toToken,trade.toToken)||asRaw(row.fromTokenQty)!==asRaw(trade.amount))throw fault('SWAP_ORDER_MISMATCH');
  }
  async function verifyReceipt(step,rec,p,r) {
    await verifyReceiptIdentity(step,rec,p,r);
    const token=step.token||p.quote;let net=0n;
    for(const log of rec.logs||[])if(same(log.address,token))try{const e=tokenAbi.parseLog(log);if(e.name==='Transfer'){if(same(e.args.to,p.wallet))net+=e.args.value;if(same(e.args.from,p.wallet))net-=e.args.value;}}catch{/* unrelated log */}
    if(step.action==='buy'||step.action==='sell') {
      const events=(rec.logs||[]).filter(l=>same(l.address,p.market)).map(l=>{try{return tradeEvents.parseLog(l);}catch{return null;}}).filter(e=>e?.name==='VirtualTrade'&&same(e.args.wallet,p.wallet));
      if(events.length!==1)throw fault('TRADE_EVENT_MISSING');const e=events[0];
      if(step.action==='buy'&&(e.args.side!==0n||net>=0n||-net!==e.args.quoteUser||e.args.quoteSubmitted!==BigInt(step.plan.grossRaw)||e.args.quoteUser+e.args.refund!==e.args.quoteSubmitted||e.args.shares<BigInt(step.plan.minSharesRaw)||e.args.shares>BigInt(step.plan.targetSharesRaw)))throw fault('BUY_SETTLEMENT_MISMATCH');
      if(step.action==='sell'&&(e.args.side!==1n||net<=0n||net!==e.args.quoteUser||e.args.shares!==BigInt(step.plan.sharesRaw)||net<BigInt(step.plan.minOutRaw)))throw fault('SELL_SETTLEMENT_MISMATCH');
      step.actualSharesRaw=e.args.shares.toString();step.actualQuoteRaw=(net<0n?-net:net).toString();
    } else if(step.action==='approve') {
      const args=tokenAbi.encodeFunctionData('allowance',[p.wallet,p.market]);
      const value=await r.rpc('eth_call',[{to:p.quote,data:args},rec.blockNumber]);
      if(tokenAbi.decodeFunctionResult('allowance',value)[0]!==BigInt(step.plan.grossRaw))throw fault('ALLOWANCE_SETTLEMENT_MISMATCH');
    } else if(step.action==='claim') {
      const claims=(rec.logs||[]).filter(l=>same(l.address,p.market)).map(l=>{try{return tradeEvents.parseLog(l);}catch{return null;}}).filter(e=>e?.name==='Claimed'&&same(e.args.wallet,p.wallet));
      if(net<=0n||net>BigInt(step.plan.claimRaw)||claims.length!==1||claims[0].args.amount!==BigInt(step.plan.claimRaw))throw fault('CLAIM_SETTLEMENT_MISMATCH');step.actualTokenRaw=net.toString();
    }
    else if(step.action==='fund') {if(net<=0n)throw fault('FUNDING_SETTLEMENT_MISMATCH');step.actualQuoteRaw=net.toString();}
    else if(step.action==='convert') {
      if(net>=0n||-net!==BigInt(step.amountRaw)||step.nativeBeforeRaw===undefined)throw fault('CONVERSION_DEBIT_MISMATCH');
      const after=BigInt(await r.rpc('eth_getBalance',[p.wallet,rec.blockNumber]));
      const received=after-BigInt(step.nativeBeforeRaw)+BigInt(rec.gasUsed)*BigInt(rec.effectiveGasPrice);
      if(received<=0n)throw fault('NATIVE_PROCEEDS_UNCONFIRMED');
      step.observedNativeIncreaseWithGasRaw=received.toString();
      // This is the observed wallet delta, not a claim that unrelated transfers are impossible.
      if(step.orderActualOutRaw!==undefined&&BigInt(step.orderActualOutRaw)>received)throw fault('NATIVE_PROCEEDS_UNCONFIRMED');
    }
    step.status='CONFIRMED';step.blockNumber=rec.blockNumber;step.gasRaw=(BigInt(rec.gasUsed)*BigInt(rec.effectiveGasPrice)).toString();
  }
  async function reconcile(op,p,r) {
    const step=op.steps.at(-1);if(!step)return op;
    if(step.status==='SUBMITTING'||step.status==='UNKNOWN'){op.status='UNKNOWN';return save(op);}
    if(step.status==='PENDING_CONFIRMATION'&&!step.txHash){op.status='PENDING_CONFIRMATION';return op;}
    if(step.orderId&&!step.txHash&&(step.action==='fund'||step.action==='convert')) {
      const row=(await cli.readOrder({chainId:'56',orderId:step.orderId})).list[0];
      validateSwapOrder(row,step);
      if(!row||['PENDING','PENDING_CONFIRMATION'].includes(row.status))return op;
      if(row.status==='FAILED'){step.status='FAILED';op.status='FAILED';op.message='兑换失败，未自动重试';return save(op);}step.txHash=row.txHash;
      if(row.toTokenActualQty!==undefined&&row.toTokenActualQty!==null)step.orderActualOutRaw=asRaw(row.toTokenActualQty).toString();await save(op);
    }
    if(step.txHash&&step.status!=='CONFIRMED') {let rec;try{rec=await receipt(step.txHash,r,{wait:false});}catch(e){await saveRevert(op,step,e,p,r);if(step.status==='FAILED'){op.status='FAILED';op.error=cleanError(e);return save(op);}throw e;}if(!rec)return op;
      try{await verifyReceipt(step,rec,p,r);}catch(e){op.status='UNKNOWN';op.error=cleanError(e);return save(op);}
      if(step.action===op.action&&op.action!=='sell'||step.action==='convert'){op.status='COMPLETE';op.message='已核验链上成交';}
      else {op.status='FAILED';op.message=step.action==='sell'?'卖出已确认，兑换 BNB 尚未执行，请检查记录':'准备步骤已确认，买入尚未提交；需再次点击';}
      return save(op);
    }
    return op;
  }
  async function contractStep(op,action,plan,p,r) {
    checkDeadline(op);
    const to=action==='approve'?p.quote:p.portal;
    const inputData=action==='approve'?tokenAbi.encodeFunctionData('approve',[p.market,plan.grossRaw]):
      action==='buy'?portalAbi.encodeFunctionData('buyWithQuote',[p.market,plan.grossRaw,plan.minSharesRaw]):
      action==='sell'?portalAbi.encodeFunctionData('sellBps',[p.market,10000,plan.minOutRaw]):portalAbi.encodeFunctionData('claim',[p.market]);
    const tx={chainId:'56',from:p.wallet,to,value:'0',inputData};
    emit(op,action==='approve'?'正在预演精确授权':'正在预演交易');
    const preview=await cli.previewContract(tx);const requestId=validatePreview(preview,{action,profile:p,plan,tx});
    checkDeadline(op);
    const step={action,status:'SUBMITTING',tx,plan,token:plan.token,startedAt:clock()};op.steps.push(step);await save(op);
    try{checkDeadline(op);}catch(e){step.status='REJECTED';step.error='PRE_SUBMISSION_DEADLINE';await save(op);throw e;}
    const result=await cli.executePreview(requestId);step.status=result.outcome;step.orderId=result.data?.orderId||null;step.txHash=result.data?.txHash||null;step.error=result.code||null;
    op.status=result.outcome;op.txHash=step.txHash;op.submittedAt=clock();await save(op);
    emit(op,result.outcome==='PENDING_CONFIRMATION'?'请在币安 App 确认':result.outcome==='SUBMITTED'?'交易已提交，正在核验':'交易提交结果待核验');
    if(!['SUBMITTED'].includes(result.outcome))throw fault(result.outcome==='REJECTED'?'OFFICIAL_REJECTED':result.outcome==='PENDING_CONFIRMATION'?'APP_CONFIRMATION_REQUIRED':'SUBMISSION_UNKNOWN');
    let rec;try{rec=await receipt(step.txHash,r);}catch(e){await saveRevert(op,step,e,p,r);throw e;}if(!rec)throw fault('RECEIPT_PENDING');
    await verifyReceipt(step,rec,p,r);await save(op);return step;
  }
  async function swapStep(op,action,trade,p,r,{afterSale=false}={}) {
    if(!afterSale)checkDeadline(op);
    const step={action,status:'SUBMITTING',trade,amountRaw:asRaw(trade.amount).toString(),startedAt:clock(),
      ...(action==='convert'?{nativeBeforeRaw:BigInt(await r.rpc('eth_getBalance',[p.wallet,'latest'])).toString()}:{} )};op.steps.push(step);await save(op);
    if(!afterSale)try{checkDeadline(op);}catch(e){step.status='REJECTED';step.error='PRE_SUBMISSION_DEADLINE';await save(op);throw e;}
    const out=await cli.executeSwap(trade);step.status=out.outcome;step.orderId=out.data?.orderId||null;step.txHash=out.data?.txHash||null;op.status=out.outcome;await save(op);
    if(out.outcome!=='SUBMITTED')throw fault(out.outcome==='REJECTED'?'OFFICIAL_REJECTED':'SUBMISSION_UNKNOWN');
    const end=clock()+45000;let row;
    do{row=(await cli.readOrder({chainId:'56',orderId:step.orderId})).list[0];
      validateSwapOrder(row,step);
      if(row?.status==='FAILED'){step.status='FAILED';throw fault('SWAP_FAILED');}if(row?.status==='FINISHED')break;await sleep(700);}while(clock()<end);
    if(row?.status!=='FINISHED')throw fault('RECEIPT_PENDING');step.txHash=row.txHash;
    if(row.toTokenActualQty!==undefined&&row.toTokenActualQty!==null)step.orderActualOutRaw=asRaw(row.toTokenActualQty).toString();
    await save(op);
    let rec;try{rec=await receipt(step.txHash,r);}catch(e){await saveRevert(op,step,e,p,r);throw e;}if(!rec)throw fault('RECEIPT_PENDING');await verifyReceipt(step,rec,p,r);await save(op);return step;
  }
  async function fund(op,plan,s,p,r) {
    if(!p.priorAuditUnavailableAcknowledged)throw fault('QUOTE_ASSET_AUDIT_REQUIRED');
    const base={chainId:'56',fromToken:NATIVE,toToken:p.quote,slippage:'5'};
    const q=await cli.quoteSwap({...base,amount:'0.01'}),out=asRaw(q.toCoinAmount);
    if(out<=0n)throw fault('NO_FUNDING_QUOTE');
    const shortfall=plan.grossRaw-s.balanceRaw;
    let native=(shortfall*asRaw('0.01')*10000n+out*9500n-1n)/(out*9500n);
    // One wei rounding buffer; never use the wallet balance as the purchase budget.
    native+=1n;
    const trade={...base,amount:human(native)};const exact=await cli.quoteSwap(trade);
    if(asRaw(exact.toCoinAmount)*9500n/10000n<shortfall)throw fault('FUNDING_QUOTE_CHANGED');
    if(s.nativeRaw-native<asRaw('0.001'))throw fault('INSUFFICIENT_FUNDS');
    emit(op,'正在兑换买满所需的 BNCB 差额');await swapStep(op,'fund',trade,p,r);
  }
  async function trade(params) {
    const startedAt=clock();
    const notStarted=e=>Object.assign(e,{submissionNotStarted:true});
    if(!allowWrites)throw notStarted(fault('WRITES_DISABLED'));
    if(active)throw notStarted(fault('TRADE_IN_PROGRESS'));
    active=params.intentId;
    let p,r,existing;
    try{({p,r}=await context());existing=await journal.read(params.intentId);}catch(e){active=null;throw notStarted(e);}
    if(existing){active=null;return {operation:existing};}
    const op={intentId:params.intentId,action:params.action,status:'PREPARING',createdAt:startedAt,deadlineAt:startedAt+(params.deadlineMs||15000),steps:[],market:p.market,wallet:p.wallet};
    const timer=setTimeout(()=>emit(op,'已超过 5 秒，正在处理当前步骤；尚未确认成交'),Math.max(1,5000-(clock()-startedAt)));
    try{return await journal.exclusive(async()=>{
      const pending=(await journal.all()).find(x=>!TERMINAL.has(x.status));if(pending)throw fault('UNRESOLVED_TRADE_EXISTS');
      await journal.save(op,{create:true});
      try{
        let [s]=await Promise.all([r.snapshot(),authenticate(p)]);
        if(s.nonce!==s.pendingNonce)throw fault('PENDING_TRANSACTION');if(s.nativeRaw<asRaw('0.001'))throw fault('INSUFFICIENT_GAS');
        let plan=await makePlan(op.action,s,r);checkDeadline(op);
        if(op.action==='buy') {
          if(plan.grossRaw>s.balanceRaw){await fund(op,plan,s,p,r);checkDeadline(op);s=await r.snapshot();plan=await r.buyPlan(s);}
          if(plan.grossRaw>s.balanceRaw)throw fault('INSUFFICIENT_QUOTE');
          if(plan.grossRaw>s.allowanceRaw){await contractStep(op,'approve',plan,p,r);checkDeadline(op);s=await r.snapshot();plan=await r.buyPlan(s);}
          if(plan.grossRaw>s.balanceRaw||plan.grossRaw>s.allowanceRaw)throw fault('FUNDING_OR_APPROVAL_CHANGED');
          const funding=await r.probe('quoteFundingProbe',[plan.grossRaw],s.block);
          if(funding.BALANCE_OK!=='1'||funding.ALLOWANCE_OK!=='1')throw fault('FUNDING_UNCONFIRMED');
        }
        if(clock()-s.snapshotAtMs>10000)throw fault('STALE_QUOTE');
        const step=await contractStep(op,op.action,plan,p,r);
        if(op.action==='sell') {
          // Only the proven proceeds of this sale are converted; existing BNCB is untouched.
          const trade={chainId:'56',fromToken:p.quote,toToken:NATIVE,amount:human(BigInt(step.actualQuoteRaw)),slippage:'99'};
          await cli.quoteSwap(trade);emit(op,'卖出已确认，正在将本次所得兑换为 BNB');await swapStep(op,'convert',trade,p,r,{afterSale:true});
        }
        op.status='COMPLETE';op.message=op.action==='buy'?'买入已确认':op.action==='sell'?'卖出及兑换 BNB 已确认':'代币领取已确认';
        const after=await r.snapshot();op.finalShares=human(after.sharesRaw);op.finalQuoteBalance=human(after.balanceRaw);await save(op);emit(op,op.message);
      }catch(e){
        const last=op.steps.at(-1);op.error=cleanError(e);
        if(TERMINAL.has(op.status)){ /* Preserve a final outcome even if the holdings refresh fails. */ }
        else if(last&&['SUBMITTING','UNKNOWN','SUBMITTED','PENDING_CONFIRMATION'].includes(last.status))op.status=last.status==='SUBMITTING'?'UNKNOWN':last.status;
        else if(op.steps.some(x=>x.action===op.action&&x.status==='CONFIRMED')&&op.action!=='sell')op.status='COMPLETE';
        else op.status='FAILED';
        op.message=op.status==='COMPLETE'?'链上交易已确认，持仓刷新暂不可用':op.error.code==='SUBMISSION_DEADLINE_EXCEEDED'?'15 秒内未完成提交，已停止后续动作；已完成的准备步骤保留':
          op.action==='sell'&&op.steps.some(x=>x.action==='sell'&&x.status==='CONFIRMED')?'卖出已确认，兑换 BNB 尚未确认；请查看记录':op.error.code;
        await save(op);emit(op,op.message);
      }
      return {profile:profilePublic(p),operation:op};
    });}catch(e){if(op.steps.length===0)throw notStarted(e);throw e;}finally{clearTimeout(timer);if(active===op.intentId)active=null;lastStatus=null;}
  }
  async function handle(method,params={}) {
    const fields=['profile','action','intentId','deadlineMs','expectedMarket','expectedToken'];
    if(!params||Array.isArray(params)||Object.keys(params).some(x=>!fields.includes(x))||params.profile!=='heyi')throw fault('INVALID_REQUEST');
    if(['status','prepare','trade'].includes(method)&&(params.expectedMarket!==undefined||params.expectedToken!==undefined)){
      try{const {p,r}=await context();if(!same(params.expectedMarket,p.market)||!/^0x[\da-f]{40}$/i.test(params.expectedToken||''))throw fault('PAGE_MARKET_MISMATCH');
        await r.verifySelection(params.expectedMarket,params.expectedToken);
      }catch(e){if(method==='trade')e.submissionNotStarted=true;throw e;}
    }
    if(['prepare','trade'].includes(method)&&!actions.has(params.action))throw fault('INVALID_ACTION');
    if(method==='trade'&&(!/^[a-zA-Z0-9_-]{8,100}$/.test(params.intentId||'')||params.deadlineMs!==undefined&&(!Number.isSafeInteger(params.deadlineMs)||params.deadlineMs<1000||params.deadlineMs>15000)))throw fault('INVALID_INTENT');
    if(method==='trade')return trade(params);
    if(method==='signin') {if(!allowAuth)throw fault('AUTH_DISABLED');if(active||authBusy)throw fault('WALLET_BUSY');authBusy=true;try{login=await cli.signin();return login.urlForWeb?{urlForWeb:login.urlForWeb,pairingCode:login.pairingCode,expireAt:login.expireAt}:{connected:true};}finally{authBusy=false;}}
    if(method==='verify') {if(!allowAuth||!login?.qrCodeId)throw fault('LOGIN_FLOW_REQUIRED');if(active||authBusy)throw fault('WALLET_BUSY');authBusy=true;try{const v=await cli.verify(login.qrCodeId);if(v.verified)login=null;return {connected:v.verified};}finally{authBusy=false;}}
    if(method==='status'||method==='prepare') {
      if(active&&lastStatus&&method==='status')return {...lastStatus,operation:await latest()};
      if(method==='status'&&statusPromise)return statusPromise;
      const p=status(method==='prepare'?{action:params.action}:{});if(method==='status')statusPromise=p;
      try{return await p;}finally{if(statusPromise===p)statusPromise=null;}
    }
    throw fault('METHOD_NOT_ALLOWED');
  }
  return {handle};
}
