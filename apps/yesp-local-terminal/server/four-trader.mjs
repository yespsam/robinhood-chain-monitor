import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {formatUnits,parseUnits} from 'ethers';
import {createAutomaticTrader} from './automatic-trader.mjs';
import {createPanelConversion} from './panel-conversion.mjs';
import {pendingContractHash} from './pending-contract.mjs';
import {AUTO_ACTIONS} from './automatic-policy.mjs';
import {createPanelFunding} from './panel-funding.mjs';
import {createDexSwap} from './dex-swap.mjs';
import {createFastTradeCli} from './fast-trade-cli.mjs';
import {FlapJournal,TERMINAL} from './flap-journal.mjs';
import {fault,same} from './flap-reader.mjs';
import {managerAbi,erc20Abi,tokenAddress} from './four-reader.mjs';
import {createFourRouter} from './four-router.mjs';
import {coreAbi} from './openfour-abi.mjs';
import {FOUR_ACTIONS,validateFourParams} from '../extension/four-policy.js';
import {PANEL_ACTIONS,validatePanelParams} from '../extension/trade-policy.js';
import {percentAmount} from '../extension/trade-model.js';
const HASH=/^0x[\da-f]{64}$/i;
const actionName={buy:'fourBuy',sell:'fourSell',approve:'fourApprove'};
const errorCode=e=>({code:/^[A-Z][A-Z0-9_]{0,80}$/.test(e?.code||'')?e.code:'READ_FAILED'});
const notStarted=e=>Object.assign(e,{submissionNotStarted:true});
function exactRaw(value,expected){try{return (typeof value==='string'&&/^\d+$/.test(value)||Number.isSafeInteger(value)&&value>=0)&&BigInt(value)===BigInt(expected);}catch{return false;}}
function approvalDisplayMatches(value,expected){
  if(exactRaw(value,expected))return true;
  // The official JSON may contain a lossy IEEE-754 decimal/scientific display. Accept
  // only the canonical representation of the exact locally encoded amount,
  // never use that display to construct calldata or increase an allowance.
  return typeof value==='string'&&value.length<=80&&/^(?:[1-9]\d*|[1-9](?:\.\d{1,16})?e\+\d{1,3})$/.test(value)
    &&BigInt(expected)>BigInt(Number.MAX_SAFE_INTEGER)&&Number.isFinite(Number(expected))&&String(Number(expected))===value;
}
export function validateFourPreview(result,plan){
  if(result?.outcome!=='PREVIEWED')throw fault(result?.code||'PREVIEW_REJECTED');
  const d=result.data,s=d?.simulationResult,r=d?.risks;
  if(!d?.parsedTx||!s||s.simulationCode!=='000000000'||s.simulationErrorDetail||!r||!Array.isArray(r.riskDetails)||!Array.isArray(r.riskBehaviors)
    ||!r.addresses||typeof r.addresses!=='object'||Array.isArray(r.addresses)||!Array.isArray(s.authorityChanges)||!Array.isArray(s.allowanceChanges)||!Array.isArray(s.balanceChanges))throw fault('PREVIEW_MISMATCH');
  if(!same(d.parsedTx.contractAddress,plan.tx.to)||d.parsedTx.action&&!same(d.parsedTx.action,plan.tx.inputData.slice(0,10)))throw fault('PREVIEW_MISMATCH');
  if(plan.kind!=='approve'&&s.authorityChanges.length)throw fault('UNEXPECTED_AUTHORITY_CHANGE');
  if((plan.kind==='wrap'||plan.kind==='convert'&&plan.conversionMode==='unwrap')&&s.allowanceChanges.length)throw fault('UNEXPECTED_AUTHORITY_CHANGE');
  if(plan.kind==='approve'){
    let encoded;try{encoded=erc20Abi.decodeFunctionData('approve',plan.tx.inputData);}catch{throw fault('APPROVAL_PREVIEW_MISMATCH');}
    if(!same(plan.tx.from,plan.wallet)||!same(plan.tx.to,plan.approvalToken)||BigInt(plan.tx.value)!==0n||!same(encoded[0],plan.manager)||encoded[1]!==BigInt(plan.approvalRaw))throw fault('APPROVAL_PREVIEW_MISMATCH');
    // Binance labels approve(spender, 0) as Revoke and omits parsed amount.
    // Only that exact zero calldata may use Revoke; simulation must still
    // confirm the same owner/token/spender and a zero final allowance below.
    const revoke=d.parsedTx.transactionType==='Revoke'&&encoded[1]===0n;
    const parsedAmount=revoke&&d.parsedTx.amount===undefined||approvalDisplayMatches(d.parsedTx.amount,plan.approvalRaw);
    if((d.parsedTx.transactionType!=='Approve'&&!revoke)||!same(d.parsedTx.spender,plan.manager)||!parsedAmount||s.balanceChanges.length)throw fault('APPROVAL_PREVIEW_MISMATCH');
    const a=s.allowanceChanges[0];
    if(s.allowanceChanges.length!==1||!same(a.owner,plan.wallet)||!same(a.tokenAddress,plan.approvalToken)||!same(a.spender,plan.manager)||!approvalDisplayMatches(a.postAmount,plan.approvalRaw))throw fault('APPROVAL_PREVIEW_MISMATCH');
    for(const row of [...s.authorityChanges,...s.allowanceChanges])if(!same(row.spender,plan.manager))throw fault('UNEXPECTED_AUTHORITY_CHANGE');
  }
  return {parsedTx:d.parsedTx,simulationResult:s,risks:r,tokenInfos:d.tokenInfos||{},requireConfirmation:d.requireConfirmation===true};
}
export function createFourTrader({cli=createFastTradeCli(),reader=createFourRouter(),journal=new FlapJournal(fileURLToPath(new URL('../.private/flap/operations/',import.meta.url))),
  allowWrites=false,clock=Date.now,panel=false,onProgress=()=>{},sleep}={}){
  const acceptedActions=panel?new Set([...FOUR_ACTIONS,...PANEL_ACTIONS,...AUTO_ACTIONS]):FOUR_ACTIONS;
  const names=panel?{buy:'panelBuy',sell:'panelSell',approve:'panelApprove',claim:'panelClaim',wrap:'panelWrap',fund:'panelFund'}:actionName;
  const funding=panel?createPanelFunding({reader,cli,clock}):null;
  const dex=panel?createDexSwap({reader,cli,clock}):null;
  const conversion=panel?createPanelConversion({reader,cli,clock}):null;
  const automatic=panel?createAutomaticTrader({journal,allowWrites,clock,sleep,onProgress,prepare:prepareAutomatic,submit:submitAutomatic,reconcile:op=>reconcile(op,undefined,async x=>x),conversion:prepareConversion}):null;
  const previews=new Map();let active=false;
  const readScope=fn=>reader.rpc?.withReadScope?reader.rpc.withReadScope(fn):fn();
  async function wallet({sign=false}={}){
    let addresses,settings,lock;
    if(sign){
      // Independent read-only CLI checks share one latency window. No cached
      // wallet, developer-mode or lock result authorizes a later submission.
      const results=await Promise.allSettled([cli.status(),cli.addresses(),cli.settings(),cli.txLock('56')]);
      if(results[0].status==='rejected')throw results[0].reason;
      if(results[0].value.status!=='CONNECTED')throw fault('LOGIN_REQUIRED');
      for(const r of results)if(r.status==='rejected')throw r.reason;
      [,addresses,settings,lock]=results.map(r=>r.value);
    }else{if((await cli.status()).status!=='CONNECTED')return {connected:false,chainId:'56'};addresses=await cli.addresses();}
    const rows=addresses.addresses.filter(r=>r.binanceChainId==='56');if(rows.length!==1)throw fault('WALLET_ADDRESS_UNAVAILABLE');
    const w={connected:true,address:tokenAddress(rows[0].address),chainId:'56'};
    if(sign){if(settings.devMode?.enabled!==true||settings.devMode.balanceExceeded)throw fault('DEVELOPER_MODE_REQUIRED');
      if(lock.status!=='UNLOCKED')throw fault('WALLET_LOCKED');}
    return w;
  }
  async function save(op){op.updatedAt=clock();await journal.save(op);return op;}
  async function latest(){const rows=(await journal.all()).sort((a,b)=>b.createdAt-a.createdAt);return rows.find(r=>!TERMINAL.has(r.status))||rows.find(r=>acceptedActions.has(r.action))||null;}
  async function reconcile(op,suppliedHash,persist=save){
    if(!op||!acceptedActions.has(op.action)||TERMINAL.has(op.status))return op;
    if(AUTO_ACTIONS.has(op.action))return automatic.recover(op);
    if(op.action==='panelConvert')return conversion.reconcile(op,persist);
    if(op.action==='panelFund')return reconcileFunding(op,suppliedHash,persist);
    if(panel&&op.steps[0]?.plan.protocol==='dex-swap')return dex.reconcile(op,persist);
    const s=op.steps[0],p=s.plan,rpc=reader.rpc;
    if(BigInt(await rpc('eth_chainId',[]))!==56n)throw fault('WRONG_NETWORK');
    const hash=s.txHash||suppliedHash||await pendingContractHash({cli,rpc,op});if(!hash)return op;
    const tx=await rpc('eth_getTransactionByHash',[hash]);if(!tx){if(suppliedHash)throw fault('TRANSACTION_NOT_FOUND');return op;}
    if(!same(tx.hash,hash)||!same(tx.from,op.wallet)||!same(tx.to,s.tx.to)||!same(tx.input,s.tx.inputData)||BigInt(tx.value)!==BigInt(s.tx.value)||BigInt(tx.nonce)!==BigInt(p.nonce))throw fault('FOUR_TRANSACTION_MISMATCH');
    if(!s.txHash){s.txHash=hash;s.status='SUBMITTED';op.txHash=hash;op.status='SUBMITTED';await persist(op);}
    const rec=await rpc('eth_getTransactionReceipt',[hash]);if(!rec)return op;
    if(!same(rec.transactionHash,hash)||!same(rec.from,op.wallet)||!same(rec.to,s.tx.to)||rec.blockHash!==tx.blockHash||!HASH.test(rec.blockHash||'')||!/^0x[\da-f]+$/i.test(rec.blockNumber||''))throw fault('RECEIPT_IDENTITY_MISMATCH');
    if(BigInt(await rpc('eth_blockNumber',[]))-BigInt(rec.blockNumber)<2n)return op;
    if((await rpc('eth_getBlockByNumber',[rec.blockNumber,false]))?.hash!==rec.blockHash)throw fault('RECEIPT_IDENTITY_MISMATCH');
    const gasRaw=(BigInt(rec.gasUsed)*BigInt(rec.effectiveGasPrice)).toString();
    if(BigInt(rec.status)===0n){s.status='FAILED';s.failedReceipt={txHash:hash,blockHash:rec.blockHash,blockNumber:rec.blockNumber,status:'0x0',gasRaw};op.status='FAILED';op.message='交易在链上失败，网络费可能已扣除。';return persist(op);}
    if(BigInt(rec.status)!==1n)throw fault('INVALID_RECEIPT_STATUS');
    if(p.kind==='approve'){
      const matches=(rec.logs||[]).filter(log=>same(log.address,p.approvalToken)).flatMap(log=>{try{const e=erc20Abi.parseLog(log);return e?.name==='Approval'&&same(e.args.owner,op.wallet)&&same(e.args.spender,p.manager)&&e.args.value===BigInt(p.approvalRaw)?[e]:[];}catch{return [];}});
      if(matches.length!==1)throw fault('APPROVAL_RECEIPT_MISMATCH');op.message=BigInt(p.approvalRaw)===0n?'旧授权已清零，请重新核对以授权所需数量。':'本次数量授权已确认。请重新核对买卖报价，交易需再次确认。';
    }else if(['flap-agent','flap-standard','gang-curve'].includes(p.protocol)){
      if(!reader.receipt)throw fault('UNSUPPORTED_PROTOCOL');Object.assign(op,reader.receipt(p,rec));
    }else if(p.protocol==='openfour-agent'){
      const events=(rec.logs||[]).filter(log=>same(log.address,p.manager)).flatMap(log=>{try{const e=coreAbi.parseLog(log);return e?.name==='TradeExecuted'&&same(e.args.token,p.tokenAddress)&&same(e.args.trader,op.wallet)?[e.args]:[];}catch{return [];}});
      if(events.length!==1)throw fault('FOUR_RECEIPT_MISMATCH');const e=events[0],buy=p.kind==='buy';
      const fees=e.protocolFee+e.taxFee+e.devFee+e.antiSniperFee;
      const quantityBuy=buy&&p.buyMode==='tokenAmount';
      if(e.presetId!==BigInt(p.presetId)||e.isBuy!==buy||!same(e.quoteAsset,p.quoteAsset)||!same(e.vault,p.runtime.vault)||e.tokenAmount<=0n
        ||buy&&((quantityBuy?(e.requestedTokenAmount!==BigInt(p.amountRaw)||e.tokenAmount>BigInt(p.amountRaw)):e.tokenAmount<BigInt(p.minimumRaw))
          ||e.traderQuoteAmount>BigInt(p.spendRaw)||e.traderQuoteAmount!==e.curveQuoteAmount+fees)
        ||!buy&&(e.requestedTokenAmount!==BigInt(p.amountRaw)||e.tokenAmount>BigInt(p.amountRaw)||e.traderQuoteAmount<BigInt(p.minimumRaw)||e.traderQuoteAmount+fees!==e.curveQuoteAmount))throw fault('FOUR_RECEIPT_MISMATCH');
      op.receivedAmount=formatUnits(buy?e.tokenAmount:e.traderQuoteAmount,buy?p.base.decimals:p.quote.decimals);
      op.executedTokenAmount=formatUnits(e.tokenAmount,p.base.decimals);op.actualFee=formatUnits(fees,p.quote.decimals);
      op.message=`${buy?'买入':'卖出'}已确认，成交回执记录 ${op.receivedAmount} ${buy?p.base.symbol:p.quote.symbol}，税费合计 ${op.actualFee} ${p.quote.symbol}。`;
      if(quantityBuy&&e.tokenAmount<BigInt(p.amountRaw))op.message+=' 合约实际成交少于目标数量；剩余数量不会自动补买。';
    }else{
      const events=(rec.logs||[]).filter(log=>same(log.address,p.manager)).flatMap(log=>{try{const e=managerAbi.parseLog(log);return e?.name===(p.kind==='buy'?'TokenPurchase':'TokenSale')&&same(e.args.token,p.tokenAddress)&&same(e.args.account,op.wallet)?[e.args]:[];}catch{return [];}});
      if(events.length!==1)throw fault('FOUR_RECEIPT_MISMATCH');const e=events[0];
      if(p.kind==='buy'&&(e.amount<BigInt(p.minimumRaw)||e.cost+e.fee>BigInt(p.spendRaw)
        ||p.buyMode==='tokenAmount'&&(e.amount!==BigInt(p.amountRaw)||e.cost>BigInt(p.maximumCostRaw)))
        ||p.kind==='sell'&&(e.amount!==BigInt(p.amountRaw)||e.cost<BigInt(p.minimumRaw)||e.fee>e.cost))throw fault('FOUR_RECEIPT_MISMATCH');
      const amount=p.kind==='buy'?e.amount:e.cost-e.fee,asset=p.kind==='buy'?p.base:p.quote;
      op.receivedAmount=formatUnits(amount,asset.decimals);op.message=`${p.kind==='buy'?'买入':'卖出'}已确认，成交回执记录 ${op.receivedAmount} ${asset.symbol}。`;
    }
    s.status='CONFIRMED';s.blockNumber=rec.blockNumber;s.gasRaw=gasRaw;op.status='COMPLETE';return persist(op);
  }
  async function reconcileFunding(op,suppliedHash,persist=save){
    const step=op.steps[0],p=step.plan,rpc=reader.rpc;
    if(BigInt(await rpc('eth_chainId',[]))!==56n)throw fault('WRONG_NETWORK');
    let verifiedOrder=false;
    if(step.orderId){const row=(await cli.readOrder({chainId:'56',orderId:step.orderId})).list[0];if(!row)return op;funding.verifyOrder(row,p,step.orderId);
      if(['PENDING','PENDING_CONFIRMATION'].includes(row.status))return op;
      if(row.status==='FAILED'){step.status=op.status='FAILED';op.message='结算币兑换失败，未继续买入或自动重试。';return persist(op);}
      if(row.status!=='FINISHED'||!HASH.test(row.txHash||'')||step.txHash&&!same(step.txHash,row.txHash))throw fault('SWAP_ORDER_MISMATCH');verifiedOrder=true;
      if(!step.txHash){step.txHash=op.txHash=row.txHash;await persist(op);}
    }
    const hash=step.txHash||suppliedHash;if(!hash)return op;
    const [tx,rec]=await Promise.all([rpc('eth_getTransactionByHash',[hash]),rpc('eth_getTransactionReceipt',[hash])]);if(!tx||!rec)return op;
    // A Binance native swap can split its input into swap value and fee with
    // separate integer rounding. Permit only a one-wei shortfall, never extra
    // spending, and only for the exact FINISHED official order and its hash.
    const requested=parseUnits(p.trade.amount,18),actual=BigInt(tx.value),rounding=requested-actual;
    if(!same(tx.hash,hash)||!same(tx.from,op.wallet)||!same(rec.from,op.wallet)||!same(rec.transactionHash,hash)||!same(tx.to,rec.to)||tx.blockHash!==rec.blockHash||!HASH.test(rec.blockHash||'')||!/^0x[\da-f]+$/i.test(rec.blockNumber||'')||BigInt(tx.nonce)!==BigInt(p.nonce)||actual<=0n||rounding<0n||rounding>(verifiedOrder?1n:0n))throw fault('FUNDING_SETTLEMENT_MISMATCH');
    if(BigInt(await rpc('eth_blockNumber',[]))-BigInt(rec.blockNumber)<2n)return op;
    if((await rpc('eth_getBlockByNumber',[rec.blockNumber,false]))?.hash!==rec.blockHash)throw fault('RECEIPT_IDENTITY_MISMATCH');
    step.txHash=op.txHash=hash;const gasRaw=(BigInt(rec.gasUsed)*BigInt(rec.effectiveGasPrice)).toString();
    if(BigInt(rec.status)===0n){step.failedReceipt={txHash:hash,blockHash:rec.blockHash,blockNumber:rec.blockNumber,status:'0x0',gasRaw};step.status=op.status='FAILED';op.message='兑换在链上失败，未继续买入。';return persist(op);}
    if(BigInt(rec.status)!==1n)throw fault('INVALID_RECEIPT_STATUS');const net=funding.received(p,rec);
    step.status='CONFIRMED';step.blockNumber=rec.blockNumber;step.gasRaw=gasRaw;step.actualQuoteRaw=net.toString();step.actualNativeInputRaw=actual.toString();step.inputRoundingRaw=rounding.toString();op.status='COMPLETE';op.receivedAmount=formatUnits(net,p.quote.decimals);
    op.message=`兑换已确认，实际收到 ${op.receivedAmount} ${p.quote.symbol}。请继续核对目标代币买入；本次尚未购买目标代币。`;return persist(op);
  }
  async function status(){
    let operation=await latest(),reconcileError;
    if(!active&&!automatic?.isRunning()&&operation&&acceptedActions.has(operation.action)&&!TERMINAL.has(operation.status)){
      try{operation=await journal.exclusive(async()=>reconcile(await journal.read(operation.intentId)));}catch(e){reconcileError=errorCode(e);}
    }
    return {wallet:await wallet(),operation,...(reconcileError?{reconcileError}:{})};
  }
  async function prepare(p,internal=false,expectedWallet,execution){
    const start=performance.now();
    if(!internal&&(active||automatic?.isRunning()||(await journal.all()).some(x=>!TERMINAL.has(x.status))))throw fault('UNRESOLVED_TRADE_EXISTS');
    const w=await wallet({sign:true}),walletAt=performance.now();if(expectedWallet&&!same(w.address,expectedWallet))throw fault('WALLET_CHANGED');
    const {funding:fundingSettings,...request}=p;
    if(execution){if(!internal||p.action!=='buy'||execution.protocol!=='gang-curve')throw fault('INVALID_REQUEST');request.fixedSpendRaw=execution.spendRaw;}
    const build=async req=>{if(panel&&reader.inspect){const m=await reader.inspect(req.tokenAddress);
      if(execution&&(m.protocol!==execution.protocol||!same(m.manager,execution.manager)||!same(m.quote.address,execution.quote)))throw fault('MODE_DEFINITION_CHANGED');
      if(m.protocol==='dex-swap'&&['buy','sell'].includes(req.action))return dex.prepare(m,{...req,...(fundingSettings?{funding:fundingSettings}:{})},w.address);}return reader.build(req,w.address);};
    const plan=await readScope(async()=>{if(p.sellPercent){const market=await reader.inspect(p.tokenAddress),h=await reader.holdings(market,w.address);
      const {sellPercent,...typed}=p,amount=percentAmount(h.base,market.base.decimals,sellPercent,!market.protocol);if(!/[1-9]/.test(amount))throw fault('INSUFFICIENT_BALANCE');
      return {...await build({...typed,amount}),sellPercent};}
     try{return await build(request);}catch(e){if(panel&&fundingSettings&&p.action==='buy'&&e.code==='INSUFFICIENT_BALANCE'&&e.details?.funding)return funding.prepare(request,w.address,fundingSettings,e.details.funding);throw e;}});
    const planAt=performance.now();
    if(plan.trade){const previewId=randomUUID(),preview={...plan,previewId,timing:{walletMs:Math.round(walletAt-start),quoteMs:Math.round(planAt-walletAt),previewMs:0,totalMs:Math.round(planAt-start)}};previews.clear();previews.set(previewId,{preview,used:false});return {wallet:w,tradePreview:preview};}
    const result=await cli.previewContract({chainId:'56',...plan.tx});
    const official=validateFourPreview(result,plan),expiresAt=Math.min(Number(result.data.expiresAt),clock()+60000);
    if(!Number.isSafeInteger(expiresAt)||expiresAt<=clock())throw fault('PREVIEW_EXPIRED');
    const previewId=randomUUID(),preview={...plan,previewId,expiresAt,official,timing:{walletMs:Math.round(walletAt-start),quoteMs:Math.round(planAt-walletAt),previewMs:Math.round(performance.now()-planAt),totalMs:Math.round(performance.now()-start)}};
    previews.clear();previews.set(previewId,{preview,requestId:result.data.requestId,used:false});
    return {wallet:w,[panel?'tradePreview':'fourPreview']:preview};
  }
  async function execute(p){
    if(!allowWrites)throw notStarted(fault('WRITES_DISABLED'));if(active||automatic?.isRunning())throw notStarted(fault('WALLET_BUSY'));
    const held=previews.get(p.previewId);if(!held||held.used||clock()>=held.preview.expiresAt)throw notStarted(fault('PREVIEW_EXPIRED'));
    held.used=true;active=true;let started=false;
    try{return await journal.exclusive(async()=>{
      const existing=await journal.read(p.intentId);if(existing)return {operation:existing};
      if((await journal.all()).some(x=>!TERMINAL.has(x.status)))throw fault('UNRESOLVED_TRADE_EXISTS');
      const w=await wallet({sign:true}),plan=held.preview;if(!same(w.address,plan.wallet))throw fault('WALLET_CHANGED');
      await readScope(()=>plan.kind==='fund'?funding.recheck(plan):plan.protocol==='dex-swap'?dex.recheck(plan):reader.recheck(plan));if(clock()>=plan.expiresAt)throw fault('PREVIEW_EXPIRED');
      const now=clock(),action=names[plan.kind],step={action,status:'SUBMITTING',startedAt:now,plan,tx:plan.tx};
      if(plan.trade){delete step.tx;step.trade=plan.trade;}
      const op={intentId:p.intentId,action,market:plan.tokenAddress,wallet:w.address,status:'SUBMITTING',createdAt:now,deadlineAt:plan.expiresAt,steps:[step],message:'正在提交已确认的操作，请勿重复点击。'};
      await journal.save(op,{create:true});started=true;
      try{const r=clock()>=plan.expiresAt?{outcome:'REJECTED',submitted:false,code:'PREVIEW_EXPIRED'}:plan.trade?await cli.executeSwap(plan.trade):await cli.executePreview(held.requestId);
        if(r.outcome==='REJECTED'&&r.submitted===false){step.status=op.status='REJECTED';op.error={code:r.code};op.message='本次操作未提交，请重新读取状态。';}
        else if(plan.trade&&['SUBMITTED','PENDING_CONFIRMATION'].includes(r.outcome)&&/^[A-Za-z0-9_-]{1,100}$/.test(r.data?.orderId||'')){step.status=op.status=r.outcome;step.orderId=r.data.orderId;op.message=plan.protocol==='dex-swap'?'DEX 市价单已提交，等待实际到账核验；不会重复提交。':'结算币兑换已提交，等待实际到账；不会重复兑换或自动买入。';}
        else if(r.outcome==='SUBMITTED'&&HASH.test(r.data?.txHash||'')){step.status=op.status='SUBMITTED';step.txHash=op.txHash=r.data.txHash;op.message='交易已广播，等待链上确认。';}
        else if(r.outcome==='PENDING_CONFIRMATION'){step.status=op.status='PENDING_CONFIRMATION';if(/^[A-Za-z0-9_-]{1,100}$/.test(r.data?.orderId||''))step.orderId=r.data.orderId;op.message='请在币安 App 确认。本机等待核验，不会重复提交。';}
        else{step.status=op.status='UNKNOWN';op.message='提交结果待核验，请在币安 App 查询交易，切勿重复提交。';}
      }catch{step.status=op.status='UNKNOWN';op.message='提交结果待核验，请勿重复提交。';}
      await save(op);return {wallet:w,operation:op};
    });}catch(e){if(!started)throw notStarted(e);throw e;}finally{active=false;}
  }
  async function prepareAutomatic(p,expectedWallet,execution){const result=await prepare(p,true,expectedWallet,execution),preview=result.tradePreview,held=previews.get(preview.previewId);return {preview,requestId:held?.requestId};}
  async function prepareConversion(sale,slippage,expectedWallet){const w=await wallet({sign:true});if(!same(w.address,expectedWallet))throw fault('WALLET_CHANGED');const preview=await readScope(()=>conversion.prepare(sale,slippage));
    if(preview.tx){const result=await cli.previewContract({chainId:'56',...preview.tx});preview.official=validateFourPreview(result,preview);preview.expiresAt=Math.min(preview.expiresAt,Number(result.data.expiresAt));if(!Number.isSafeInteger(preview.expiresAt)||preview.expiresAt<=clock())throw fault('PREVIEW_EXPIRED');return {preview,requestId:result.data.requestId};}return {preview};}
  async function submitAutomatic(held,expectedWallet,deadline,guard){const p=held.preview;
    try{if(!same(p.wallet,expectedWallet)||clock()>=Math.min(deadline,p.expiresAt))throw fault('PREVIEW_EXPIRED');
      await readScope(()=>p.kind==='fund'?funding.recheck(p):p.kind==='convert'?conversion.recheck(p):p.protocol==='dex-swap'?dex.recheck(p):reader.recheck(p));
      if(clock()>=Math.min(deadline,p.expiresAt))throw fault('PREVIEW_EXPIRED');guard?.();
    }catch(e){throw notStarted(e);}
    // The immediately preceding prepare authenticated this wallet. The official
    // CLI enforces its current session and phone confirmation during submission.
    return p.trade?cli.executeSwap(p.trade):cli.executePreview(held.requestId);
  }
  async function handle(method,p){
    if(panel&&method==='panelTrade')return automatic.start(p);
    if(panel){validatePanelParams(method,p);method=method.replace('panel','four');}else validateFourParams(method,p);
    if(method==='fourStatus')return status();
    if(method==='fourQuery')return readScope(async()=>{const [market,w]=await Promise.all([reader.inspect(p.tokenAddress),wallet()]);return {market,wallet:w,holdings:w.connected?await reader.holdings(market,w.address):null};});
    if(method==='fourPrepare')return prepare(p);
    if(method==='fourExecute')return execute(p);
    return journal.exclusive(async()=>{const op=await journal.read(p.intentId);if(!op||!acceptedActions.has(op.action))throw fault('INVALID_INTENT');return {operation:await reconcile(op,p.txHash)};});
  }
  return {handle,startStrategy:(p,policy)=>automatic.start(p,policy),strategyOperation:async id=>reconcile(await journal.read(id)),drain:()=>automatic?.drain(),restrictPreviewDeadline(id,deadline){const held=previews.get(id);if(!held||!Number.isSafeInteger(deadline)||deadline<=clock())throw fault('PREVIEW_EXPIRED');held.preview.expiresAt=Math.min(held.preview.expiresAt,deadline);}};
}
