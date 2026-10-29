import {formatUnits,parseUnits} from 'ethers';
import {fault,same} from './flap-reader.mjs';
import {ZERO,tokenAddress} from './four-reader.mjs';
import {TERMINAL} from './flap-journal.mjs';
import {AUTO_ACTIONS,validateAutomatic} from './automatic-policy.mjs';
import {safeBudget,safePriceChange,automaticFailureMessage} from '../extension/funding-model.js';
const unresolved=s=>['SUBMITTING','SUBMITTED','PENDING_CONFIRMATION','UNKNOWN'].includes(s?.status);
const wait=ms=>new Promise(r=>setTimeout(r,ms));
export function createAutomaticTrader({journal,prepare,submit,reconcile,conversion,allowWrites=false,clock=Date.now,sleep=wait,onProgress=()=>{}}){
 let running=null,task=null;
 async function save(op,options){op.updatedAt=clock();await journal.save(op,options);try{onProgress({operation:structuredClone(op)});}catch{}return op;}
 const child=(op,s)=>({intentId:op.intentId,action:s.action,market:op.market,wallet:op.wallet,status:s.status,createdAt:op.createdAt,deadlineAt:op.deadlineAt,steps:[structuredClone(s)]});
 async function settle(op){const s=op.steps.at(-1),before=JSON.stringify(s);const result=await reconcile(child(op,s));op.steps[op.steps.length-1]=result.steps[0];if(result.txHash)op.txHash=result.txHash;
  if(result.receivedAmount)op.lastReceivedAmount=result.receivedAmount;
  if(result.steps[0]?.plan.protocol==='dex-swap'&&result.status==='COMPLETE'){op.partial=result.partial===true;op.refunds=result.refunds;op.receivedAmountSource=result.receivedAmountSource;op.settlementMessage=result.message;}
  if(result.steps[0]?.status==='CONFIRMED'&&s.status!=='CONFIRMED')op.steps.at(-1).confirmedAt=clock();
  if(JSON.stringify(op.steps.at(-1))!==before)await save(op);return result;
 }
 async function awaitStep(op){let failures=0;while(clock()<op.deadlineAt){const current=op.steps.at(-1);if(['UNKNOWN','SUBMITTING'].includes(current.status)&&!current.txHash&&!current.orderId)throw fault('SUBMISSION_UNKNOWN');try{const result=await settle(op);failures=0;if(TERMINAL.has(result.status))return result;}catch(e){if(++failures>=3)throw e;}
   const s=op.steps.at(-1);if(s.status==='UNKNOWN'||s.status==='SUBMITTING'&&!s.txHash&&!s.orderId)throw fault('SUBMISSION_UNKNOWN');await sleep(s.orderId&&!s.txHash?1500:500);
  }throw fault('AUTO_DEADLINE');
 }
 function request(p,amount){return {profile:'unified',tokenAddress:p.tokenAddress,action:p.action,...(amount!==undefined?{amount}:p.sellPercent!==undefined?{sellPercent:p.sellPercent}:{amount:p.amount}),slippageBps:p.slippageBps,...(p.action==='buy'?{buyMode:'tokenAmount',funding:{...(p.fundingMode==='quantity'?{mode:'quantity'}:{maxBnb:p.maxBnb}),slippageBps:p.swapSlippageBps}}:{})};}
 function approveRisks(p){if(p.official?.risks?.riskDetails?.length||p.official?.risks?.riskBehaviors?.length||Object.values(p.official?.risks?.addresses||{}).some(r=>r.riskDetails?.length||Number(r.riskLevel)>1))throw fault('AUTO_RISK_REVIEW_REQUIRED');}
 async function run(op,policy){const p=op.request;let spent=0n,funded=false,wrapped=false,approvalCount=0,amount,quoteCap=null,route=null,execution;
  try{for(let count=0;count<6;count++){
    if(clock()>=op.deadlineAt)throw fault('AUTO_DEADLINE');op.message=op.steps.length?'正在读取到账状态并接续下一步。':'正在报价和预演，完成后按当前参数自动提交。';await save(op);
    const prepareStarted=clock(),prepared=await prepare(request(p,amount),p.wallet,execution),prepareMs=Math.max(0,clock()-prepareStarted),plan=prepared.preview;if(!same(plan.wallet,p.wallet))throw fault('WALLET_CHANGED');approveRisks(plan);
    if(!route){route={quote:plan.quote.address,manager:plan.manager,protocol:plan.protocol};amount=plan.amount;
     if(p.action==='buy'){const total=plan.kind==='fund'?parseUnits(plan.funding.required,plan.quote.decimals):plan.kind==='wrap'?BigInt(plan.fundingQuoteRequiredRaw):BigInt(plan.spendRaw);quoteCap=total*(10000n+BigInt(p.slippageBps))/10000n;
      // Gang buys take a fixed input. Freeze it across funding and approvals;
      // the reader keeps the original target-derived minimum output.
      if(plan.protocol==='gang-curve')execution={...route,spendRaw:total.toString()};}
    }else if(!same(plan.quote.address,route.quote)||!same(plan.manager,route.manager)||plan.protocol!==route.protocol)throw fault('MODE_DEFINITION_CHANGED');
    if(plan.kind==='fund'){if(funded)throw fault('AUTO_FUNDING_SHORTFALL');funded=true;spent+=parseUnits(plan.trade.amount,18);}
    else if(plan.kind==='wrap'){if(wrapped)throw fault('AUTO_FUNDING_SHORTFALL');wrapped=true;spent+=BigInt(plan.wrapRaw);}
    else if(plan.kind==='approve'){if(++approvalCount>2)throw fault('AUTO_APPROVAL_CHANGED');}
    else if(!['buy','sell'].includes(plan.kind))throw fault('UNSUPPORTED_PROTOCOL');
    if(p.action==='buy'){if(plan.kind!=='fund'&&plan.kind!=='wrap'&&(BigInt(plan.spendRaw)>quoteCap||execution&&plan.spendRaw!==execution.spendRaw))throw fault('AUTO_PRICE_CHANGED');
     const nativeBuy=plan.kind==='buy'&&same(plan.quote.address,ZERO)?BigInt(plan.spendRaw):0n;if(p.fundingMode!=='quantity'&&spent+nativeBuy>parseUnits(p.maxBnb,18))throw fault('FUNDING_BUDGET_EXCEEDED',{budget:{kind:'native',maxBnb:p.maxBnb,amount,tokenSymbol:plan.base.symbol,symbol:'BNB',needed:formatUnits(spent+nativeBuy,18),expected:p.maxBnb,minimum:p.maxBnb}});}
    await sendStep(op,prepared,prepareMs,policy);const result=await awaitStep(op);if(result.status!=='COMPLETE')throw fault('AUTO_STEP_FAILED');
    if(plan.kind==='buy'){op.status='COMPLETE';op.message=plan.protocol==='dex-swap'?result.message:`一键买入已完成，实际收到 ${result.receivedAmount||'待查看回执'} ${plan.base.symbol}。`;op.receivedAmount=result.receivedAmount;if(result.spentRaw)op.spentRaw=result.spentRaw;op.completedAt=clock();await save(op);return;}
    if(plan.kind==='sell'){
     op.saleReceivedAmount=result.receivedAmount;if(same(plan.quote.address,ZERO)){op.status='COMPLETE';op.receivedAmount=result.receivedAmount;op.message=plan.protocol==='dex-swap'?result.message:`一键卖出已完成，收到 ${result.receivedAmount} BNB。`;op.completedAt=clock();await save(op);return;}
     if(clock()>=op.deadlineAt)throw fault('AUTO_DEADLINE');op.message=`卖出已到账 ${result.receivedAmount} ${plan.quote.symbol}，正在将本次所得换回 BNB。`;await save(op);
     const conversionStarted=clock(),converted=await conversion(result,p.swapSlippageBps,p.wallet);approveRisks(converted.preview);await sendStep(op,converted,Math.max(0,clock()-conversionStarted),policy);const done=await awaitStep(op);if(done.status!=='COMPLETE')throw fault('AUTO_CONVERSION_FAILED');
     op.status='COMPLETE';op.receivedAmount=done.receivedAmount;op.message='一键卖出流程完成。'+done.message;op.partial=done.partial===true;op.completedAt=clock();await save(op);return;
    }
   }throw fault('AUTO_STEP_LIMIT');
  }catch(e){const last=op.steps.at(-1);op.error={code:/^[A-Z][A-Z0-9_]{0,80}$/.test(e.code||'')?e.code:'AUTO_FAILED'};op.status=unresolved(last)?'UNKNOWN':'FAILED';op.message=unresolved(last)?'已有交易结果待核验；已停止后续流程，不会重复发送。':`流程已停止（${op.error.code}）。已完成的步骤保留，未自动重试。`;
   const budget=op.error.code==='FUNDING_BUDGET_EXCEEDED'&&safeBudget(e.details?.budget);if(budget)op.error.budget=budget;const price=op.error.code==='AUTO_PRICE_CHANGED'&&safePriceChange(e.details?.price);if(price)op.error.price=price;if(!unresolved(last))op.message=automaticFailureMessage(op);
   await save(op);
  }finally{if(running===op.intentId)running=null;}
 }
 async function sendStep(op,prepared,prepareMs,policy){if(clock()>=op.deadlineAt)throw fault('AUTO_DEADLINE');const plan=prepared.preview,action={fund:'panelFund',wrap:'panelWrap',approve:'panelApprove',buy:'panelBuy',sell:'panelSell',convert:'panelConvert'}[plan.kind];if(!action)throw fault('UNSUPPORTED_PROTOCOL');
  const checked=await policy?.check?.(plan);policy?.active?.();
  // Persist SUBMITTING before the only network mutation for this step.
  if(checked?.costRaw!==undefined&&(!/^[1-9]\d{0,77}$/.test(checked.costRaw)||BigInt(checked.costRaw)>=1n<<256n))throw fault('GANG_COST_INVALID');
  const step={action,status:'SUBMITTING',startedAt:clock(),prepareMs,...(checked?.costRaw?{strategyCostRaw:checked.costRaw}:{}),plan,...(plan.tx?{tx:plan.tx}:{trade:plan.trade})};op.steps.push(step);op.status='SUBMITTING';op.message={fund:'正在兑换买入所需的结算币差额。',wrap:'正在把所需 BNB 包装为 WBNB。',approve:'正在提交本次数量授权。',buy:'正在提交目标代币买入。',sell:'正在提交目标代币卖出。',convert:'正在把本次卖出所得换回 BNB。'}[plan.kind];await save(op);
  let r;try{r=await submit(prepared,op.wallet,op.deadlineAt,policy?.active);}catch(e){if(e.submissionNotStarted){step.status='REJECTED';await save(op);throw e;}r={outcome:'UNKNOWN'};}
  if(r.outcome==='REJECTED'&&r.submitted===false){step.status='REJECTED';step.error={code:r.code||'REJECTED'};await save(op);throw fault(r.code||'AUTO_STEP_REJECTED');}
  step.submittedAt=clock();
  if(['SUBMITTED','PENDING_CONFIRMATION'].includes(r.outcome)){step.status=r.outcome;if(/^0x[\da-f]{64}$/i.test(r.data?.txHash||''))step.txHash=r.data.txHash;if(/^[A-Za-z0-9_-]{1,100}$/.test(r.data?.orderId||''))step.orderId=r.data.orderId;}
  else step.status='UNKNOWN';op.status=step.status;op.firstSubmittedAt??=clock();op.message=step.status==='PENDING_CONFIRMATION'?'币安要求手机确认，等待结果；不会跳过币安确认。':'已提交当前步骤，等待链上到账后接续。';await save(op);
 }
 async function start(p,policy){validateAutomatic(p);p={...p,wallet:tokenAddress(p.wallet),tokenAddress:tokenAddress(p.tokenAddress)};if(!allowWrites)throw Object.assign(fault('WRITES_DISABLED'),{submissionNotStarted:true});if(running)throw Object.assign(fault('WALLET_BUSY'),{submissionNotStarted:true});running=p.intentId;
  let accepted=false,resolveAccepted,rejectAccepted;const response=new Promise((resolve,reject)=>{resolveAccepted=resolve;rejectAccepted=reject;});
  // Keep the shared cross-process lock for the entire sequence, including waits.
  // Return acceptance after the durable record, not after the chain finishes.
  task=journal.exclusive(async()=>{const old=await journal.read(p.intentId);if(old){if(JSON.stringify(old.request)!==JSON.stringify(p))throw fault('INVALID_INTENT');accepted=true;resolveAccepted({operation:old});running=null;return;}
   if((await journal.all()).some(r=>!TERMINAL.has(r.status)))throw fault('UNRESOLVED_TRADE_EXISTS');const now=clock(),op=await save({intentId:p.intentId,action:p.action==='buy'?'panelAutoBuy':'panelAutoSell',market:p.tokenAddress,wallet:p.wallet,request:p,status:'SUBMITTING',createdAt:now,deadlineAt:now+180000,steps:[],message:'已接收本次一键交易，正在处理。'},{create:true});
   accepted=true;resolveAccepted({operation:structuredClone(op)});await run(op,policy);
  }).catch(e=>{running=null;if(!accepted)rejectAccepted(Object.assign(e,{submissionNotStarted:true}));});return response;
 }
 async function recover(op){if(running===op.intentId||TERMINAL.has(op.status))return op;const last=op.steps.at(-1);
  if(last?.status==='CONFIRMED'&&(last.action==='panelBuy'||last.action==='panelConvert'||last.action==='panelSell'&&same(last.plan.quote.address,ZERO))){op.status='COMPLETE';op.receivedAmount=op.lastReceivedAmount;op.message='已核验上次一键交易的最终步骤。';return save(op);}
  if(last&&unresolved(last)){const result=await settle(op);if(!TERMINAL.has(result.status)){op.status='UNKNOWN';op.message='上次一键交易结果待核验，后续步骤不会在重启后自动提交。';return save(op);}
   if(result.status==='COMPLETE'&&(last.action==='panelBuy'||last.action==='panelConvert'||last.action==='panelSell'&&same(last.plan.quote.address,ZERO))){op.status='COMPLETE';op.receivedAmount=result.receivedAmount;op.message='已核验上次一键交易的最终步骤。';return save(op);}
  }
  op.status='FAILED';
  const funded=op.steps.find(s=>s.action==='panelFund'&&s.status==='CONFIRMED');
  op.message=funded?`兑换已核验到账${funded.actualQuoteRaw?' '+formatUnits(BigInt(funded.actualQuoteRaw),funded.plan.quote.decimals)+' '+funded.plan.quote.symbol:''}；后续买入未完成。旧任务已结束，可按当前余额重新发起交易；已有结算币先抵扣。`:'服务重启或流程中断；已核验已有步骤，后续交易已停止。';return save(op);
 }
 return {start,recover,isRunning:()=>Boolean(running),async drain(){await task;}};
}
