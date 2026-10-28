import { open, readdir, lstat, unlink, rm } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fault } from './flap-reader.mjs';
import {AUTO_ACTIONS,validateAutomatic} from './automatic-policy.mjs';
import { WINDOWS, secureDirectory, checkPrivateFile, openPrivateRead, commitFile, syncDirectory } from './platform-files.mjs';
export const TERMINAL = new Set(['COMPLETE','FAILED','REJECTED','CANCELLED']);
const pattern=/^[a-zA-Z0-9_-]{8,100}$/;
const MAX_BYTES=250000;
const FOUR_ACTIONS=new Set(['fourBuy','fourSell','fourApprove','panelBuy','panelSell','panelApprove','panelClaim','panelWrap']);
const ACTIONS=new Set(['buy','sell','claim','transfer','panelFund','panelConvert',...AUTO_ACTIONS,...FOUR_ACTIONS]);
const STEP_ACTIONS=new Set(['fund','approve','buy','sell','claim','convert','transfer','panelFund','panelConvert',...FOUR_ACTIONS]);
const STATES=new Set(['PREPARING','PENDING','SUBMITTING','SUBMITTED','PENDING_CONFIRMATION','UNKNOWN',...TERMINAL]);
const STEP_STATES=new Set(['PENDING','SUBMITTING','SUBMITTED','PENDING_CONFIRMATION','UNKNOWN','CONFIRMED','FAILED','REJECTED']);
const UNRESOLVED=new Set(['PENDING','SUBMITTING','SUBMITTED','PENDING_CONFIRMATION','UNKNOWN']);
const address=value=>typeof value==='string'&&/^0x[\da-f]{40}$/i.test(value);
const hash=value=>typeof value==='string'&&/^0x[\da-f]{64}$/i.test(value);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
function failedReceiptValid(step) {
  const receipt=step.failedReceipt;
  return object(receipt)&&Object.keys(receipt).length===5&&hash(receipt.txHash)&&hash(step.txHash)
    &&receipt.txHash.toLowerCase()===step.txHash.toLowerCase()&&hash(receipt.blockHash)
    &&typeof receipt.blockNumber==='string'&&/^0x[\da-f]+$/i.test(receipt.blockNumber)
    &&receipt.status==='0x0'&&typeof receipt.gasRaw==='string'&&/^\d+$/.test(receipt.gasRaw);
}
function validate(record,id=record?.intentId) {
  if(!object(record)||!pattern.test(record.intentId||'')||record.intentId!==id||!ACTIONS.has(record.action)||!STATES.has(record.status)
    ||!address(record.market)||!address(record.wallet)||!Number.isSafeInteger(record.createdAt)||record.createdAt<0
    ||!Number.isSafeInteger(record.deadlineAt)||record.deadlineAt<record.createdAt
    ||record.updatedAt!==undefined&&(!Number.isSafeInteger(record.updatedAt)||record.updatedAt<record.createdAt)
    ||!Array.isArray(record.steps)||record.steps.length>32)throw fault('JOURNAL_INVALID');
  if(record.action==='transfer') {
    const s=record.steps[0],p=s?.plan;
    if(record.steps.length!==1 || s.action!=='transfer' || !object(p) || p.chainId!=='56'
      || p.wallet!==record.wallet || p.tokenAddress!==record.market || !address(p.recipient)
      || !Number.isInteger(p.decimals) || p.decimals<0 || p.decimals>36
      || typeof p.amountRaw!=='string' || !/^[1-9]\d{0,77}$/.test(p.amountRaw)
      || typeof p.nonce!=='string' || !/^0x[\da-f]+$/i.test(p.nonce)
      || !object(s.tx) || s.tx.from!==record.wallet || !address(s.tx.to)
      || typeof s.tx.inputData!=='string' || !/^0x(?:[\da-f]{2})*$/i.test(s.tx.inputData)
      || typeof s.tx.value!=='string' || !/^0x[\da-f]+$/i.test(s.tx.value))throw fault('JOURNAL_INVALID');
  }
  if(FOUR_ACTIONS.has(record.action)){
    const s=record.steps[0],p=s?.plan;
    if(record.steps.length!==1||s.action!==record.action||!object(p)||p.chainId!=='56'||p.wallet!==record.wallet||p.tokenAddress!==record.market
      ||({fourBuy:'buy',fourSell:'sell',fourApprove:'approve',panelBuy:'buy',panelSell:'sell',panelApprove:'approve',panelClaim:'claim',panelWrap:'wrap'})[record.action]!==p.kind||!address(p.manager)
      ||typeof p.nonce!=='string'||!/^0x[\da-f]+$/i.test(p.nonce)||typeof p.amountRaw!=='string'||!/^[1-9]\d{0,77}$/.test(p.amountRaw)
      ||p.protocol!=='dex-swap'&&(!object(s.tx)||s.tx.from!==record.wallet||!address(s.tx.to)||typeof s.tx.value!=='string'||!/^0x[\da-f]+$/i.test(s.tx.value)
      ||typeof s.tx.inputData!=='string'||!/^0x(?:[\da-f]{2})+$/i.test(s.tx.inputData)||!isDeepStrictEqual(s.tx,p.tx)
      ||p.kind==='approve'&&(!address(p.approvalToken)||typeof p.approvalRaw!=='string'||!/^\d{1,78}$/.test(p.approvalRaw))))throw fault('JOURNAL_INVALID');
    if(p.protocol==='dex-swap'){
      const t=p.trade,buy=p.kind==='buy',native='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
      if(!['panelBuy','panelSell'].includes(record.action)||!['buy','sell'].includes(p.kind)||p.action!==p.kind||s.tx!==undefined||p.tx!==undefined
        ||t?.chainId!=='56'||t.fromToken?.toLowerCase()!==(buy?native:record.market.toLowerCase())||t.toToken?.toLowerCase()!==(buy?record.market.toLowerCase():native)
        ||!isDeepStrictEqual(t,s.trade)||typeof t.amount!=='string'||!/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(t.amount)||!/[1-9]/.test(t.amount)
        ||typeof t.slippage!=='string'||!/^\d{1,2}(?:\.\d{1,2})?$/.test(t.slippage)||Number(t.slippage)<=0||Number(t.slippage)>=100
        ||!/^0x0{40}$/i.test(p.quote?.address||'')||!Number.isInteger(p.base?.decimals)||p.base.decimals<0||p.base.decimals>36)throw fault('JOURNAL_INVALID');
    }
    if(p.kind==='wrap'&&(p.protocol!=='gang-curve'||s.tx.to.toLowerCase()!=='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'||s.tx.inputData!=='0xd0e30db0'||typeof p.wrapRaw!=='string'||!/^[1-9]\d{0,77}$/.test(p.wrapRaw)||BigInt(p.wrapRaw)!==BigInt(s.tx.value)))throw fault('JOURNAL_INVALID');
  }
  if(record.action==='panelFund'){
    const s=record.steps[0],p=s?.plan,t=p?.trade;
    if(record.steps.length!==1||s.action!=='panelFund'||p?.kind!=='fund'||p.chainId!=='56'||p.wallet!==record.wallet||p.tokenAddress!==record.market||!address(p.quote?.address)
      ||!Number.isInteger(p.quote.decimals)||p.quote.decimals<0||p.quote.decimals>36||!/^0x[\da-f]+$/i.test(p.nonce||'')||t?.chainId!=='56'
      ||t.fromToken?.toLowerCase()!=='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'||t.toToken!==p.quote.address||typeof t.amount!=='string'||! /^(?:0|[1-9]\d*)(?:\.\d{1,18})?$/.test(t.amount)
      ||!/[1-9]/.test(t.amount)||!isDeepStrictEqual(t,s.trade)||!address(p.resumeRequest?.tokenAddress)||p.resumeRequest.tokenAddress!==record.market)throw fault('JOURNAL_INVALID');
  }
  if(record.action==='panelConvert'){
    const s=record.steps[0],p=s?.plan,t=p?.trade;
    if(record.steps.length!==1||s.action!=='panelConvert'||p?.kind!=='convert'||p.chainId!=='56'||p.wallet!==record.wallet||p.tokenAddress!==record.market||!address(p.quote?.address)||!/^0x[\da-f]+$/i.test(p.nonce||'')||typeof p.amountRaw!=='string'||!/^[1-9]\d{0,77}$/.test(p.amountRaw))throw fault('JOURNAL_INVALID');
    if(p.conversionMode==='unwrap'){if(p.quote.address.toLowerCase()!=='0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c'||p.tx?.to?.toLowerCase()!==p.quote.address.toLowerCase()||p.tx?.from!==record.wallet||p.tx?.value!=='0x0'||p.tx?.inputData!=='0x2e1a7d4d'+BigInt(p.amountRaw).toString(16).padStart(64,'0')||!isDeepStrictEqual(p.tx,s.tx))throw fault('JOURNAL_INVALID');}
    else if(p.conversionMode!=='swap'||t?.chainId!=='56'||t.fromToken!==p.quote.address||t.toToken?.toLowerCase()!=='0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee'||t.amount!==p.amount||!isDeepStrictEqual(t,s.trade))throw fault('JOURNAL_INVALID');
  }
  if(AUTO_ACTIONS.has(record.action)){
    validateAutomatic(record.request);if(record.request.wallet!==record.wallet||record.request.tokenAddress!==record.market||record.request.intentId!==record.intentId||record.request.action!==(record.action==='panelAutoBuy'?'buy':'sell')||record.steps.length>6)throw fault('JOURNAL_INVALID');
    const allowed=record.action==='panelAutoBuy'?['panelFund','panelWrap','panelApprove','panelBuy']:['panelApprove','panelSell','panelConvert'];
    for(const [i,s]of record.steps.entries()){
      if(!allowed.includes(s.action)||i<record.steps.length-1&&s.status!=='CONFIRMED')throw fault('JOURNAL_INVALID');
      validate({...record,action:s.action,status:s.status==='CONFIRMED'?'COMPLETE':s.status,steps:[s]});
    }
    for(const action of ['panelFund','panelWrap','panelBuy','panelSell','panelConvert'])if(record.steps.filter(s=>s.action===action).length>1)throw fault('JOURNAL_INVALID');
    if(record.status==='COMPLETE'){const last=record.steps.at(-1),sold=record.steps.find(s=>s.action==='panelSell'&&s.status==='CONFIRMED');
      if(last?.status!=='CONFIRMED'||record.action==='panelAutoBuy'&&last.action!=='panelBuy'||record.action==='panelAutoSell'&&(!sold||last.action!=='panelConvert'&&!/^0x0{40}$/i.test(sold.plan.quote.address)))throw fault('JOURNAL_INVALID');}
  }
  for(const step of record.steps) {
    if(!object(step)||!STEP_ACTIONS.has(step.action)||!STEP_STATES.has(step.status)
      ||!Number.isSafeInteger(step.startedAt)||step.startedAt<record.createdAt
      ||step.txHash!=null&&!hash(step.txHash)
      ||step.orderId!=null&&(typeof step.orderId!=='string'||! /^[A-Za-z0-9_-]{1,100}$/.test(step.orderId))
      ||step.tx!==undefined&&!object(step.tx)||step.plan!==undefined&&!object(step.plan)||step.trade!==undefined&&!object(step.trade))throw fault('JOURNAL_INVALID');
    if(step.status==='CONFIRMED'&&(!hash(step.txHash)||typeof step.blockNumber!=='string'||!/^0x[\da-f]+$/i.test(step.blockNumber)
      ||typeof step.gasRaw!=='string'||!/^\d+$/.test(step.gasRaw)))throw fault('JOURNAL_INVALID');
    if(step.failedReceipt!==undefined&&(step.status!=='FAILED'||!failedReceiptValid(step)))throw fault('JOURNAL_INVALID');
  }
  if(TERMINAL.has(record.status)&&record.steps.some(step=>UNRESOLVED.has(step.status)))throw fault('JOURNAL_UNRESOLVED_TERMINAL');
  if(record.status==='COMPLETE'&&!AUTO_ACTIONS.has(record.action)&&(!record.steps.some(step=>step.action===record.action&&step.status==='CONFIRMED')
    ||record.action==='sell'&&!record.steps.some(step=>step.action==='convert'&&step.status==='CONFIRMED')))throw fault('JOURNAL_INVALID');
  return record;
}
function validateUpdate(previous,next) {
  if(!isDeepStrictEqual(previous.request,next.request))throw fault('JOURNAL_IMMUTABLE');
  for(const key of ['intentId','action','market','wallet','createdAt','deadlineAt'])
    if(previous[key]!==next[key])throw fault('JOURNAL_IMMUTABLE');
  if(TERMINAL.has(previous.status)&&next.status!==previous.status)throw fault('JOURNAL_TERMINAL');
  if(['UNKNOWN','SUBMITTED','PENDING_CONFIRMATION'].includes(previous.status)&&['PREPARING','PENDING'].includes(next.status))throw fault('JOURNAL_UNKNOWN_TRANSITION');
  if(next.steps.length<previous.steps.length)throw fault('JOURNAL_HISTORY_CHANGED');
  for(let i=0;i<previous.steps.length;i++) {
    const before=previous.steps[i],after=next.steps[i];
    for(const key of ['action','startedAt','tx','plan','trade','token','amountRaw'])
      if(!isDeepStrictEqual(before[key],after[key]))throw fault('JOURNAL_HISTORY_CHANGED');
    for(const key of ['txHash','orderId'])if(before[key]!=null&&before[key]!==after[key])throw fault('JOURNAL_HISTORY_CHANGED');
    if(before.failedReceipt!==undefined&&!isDeepStrictEqual(before.failedReceipt,after.failedReceipt))throw fault('JOURNAL_HISTORY_CHANGED');
    if(before.status==='CONFIRMED'&&!isDeepStrictEqual(before,after))throw fault('JOURNAL_CONFIRMED_CHANGED');
    if(UNRESOLVED.has(before.status)&&['FAILED','REJECTED'].includes(after.status)
      &&before.status!=='SUBMITTING'&&!(after.status==='FAILED'&&(failedReceiptValid(after)
        ||before.status==='SUBMITTED'&&['fund','convert'].includes(before.action)&&before.orderId
        ||['SUBMITTED','PENDING_CONFIRMATION'].includes(before.status)&&['panelFund','panelConvert'].includes(before.action)&&before.orderId
        ||before.plan?.protocol==='dex-swap'&&before.orderId&&after.orderFailureConfirmed===true)))throw fault('JOURNAL_UNKNOWN_TRANSITION');
    if(['SUBMITTED','PENDING_CONFIRMATION','UNKNOWN'].includes(before.status)&&['PENDING','SUBMITTING'].includes(after.status))throw fault('JOURNAL_UNKNOWN_TRANSITION');
    if(['FAILED','REJECTED'].includes(before.status)&&!isDeepStrictEqual(before,after))throw fault('JOURNAL_HISTORY_CHANGED');
  }
  if(TERMINAL.has(previous.status)&&!isDeepStrictEqual(previous.steps,next.steps))throw fault('JOURNAL_HISTORY_CHANGED');
}
export class FlapJournal {
  constructor(directory) { this.directory=directory; this.readyPromise=null; }
  async ready() {
    this.readyPromise??=secureDirectory(this.directory).catch(e=>{this.readyPromise=null;throw e;});
    await this.readyPromise;
    const s=await lstat(this.directory);if(!s.isDirectory()||s.isSymbolicLink())throw fault('JOURNAL_UNSAFE');
  }
  path(id) {if(typeof id!=='string'||!pattern.test(id))throw fault('INVALID_INTENT'); return join(this.directory,id+'.json');}
  async read(id) {
    await this.ready(); let f; try {f=await openPrivateRead(this.path(id));}catch(e){if(e.code==='ENOENT')return null;throw e;}
    try {const s=await checkPrivateFile(this.path(id),f);if(s.size>MAX_BYTES)throw fault('JOURNAL_UNSAFE');
      let v;try{v=JSON.parse(await f.readFile('utf8'));}catch{throw fault('JOURNAL_INVALID');}return validate(v,id);
    }finally{await f.close();}
  }
  async all() {await this.ready();const names=await readdir(this.directory);return Promise.all(names.filter(x=>x.endsWith('.json')).map(x=>this.read(x.slice(0,-5))));}
  async save(record,{create=false}={}) {
    await this.ready(); const file=this.path(record?.intentId);const tmp=file+'.'+randomUUID()+'.tmp';
    let source;try{source=JSON.stringify(record,(_,v)=>typeof v==='bigint'?v.toString():v)+'\n';}catch{throw fault('JOURNAL_INVALID');}
    if(Buffer.byteLength(source)>MAX_BYTES)throw fault('JOURNAL_TOO_LARGE');
    const next=validate(JSON.parse(source));
    if(!create) {const previous=await this.read(record.intentId);if(!previous)throw fault('JOURNAL_MISSING');validateUpdate(previous,next);}
    const target=create&&!WINDOWS?file:tmp;
    const f=await open(target,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);
    try {
      try {await checkPrivateFile(target,f);await f.writeFile(source);await f.sync();}finally{await f.close();}
      if(target===tmp)await commitFile(tmp,file,{create});
      await syncDirectory(this.directory);return record;
    }finally{if(target===tmp)await rm(tmp,{force:true});}
  }
  async exclusive(fn) {
    await this.ready();const p=join(this.directory,'.submission-lock');let f;
    try{f=await open(p,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|(constants.O_NOFOLLOW||0),0o600);}catch(e){if(e.code==='EEXIST')throw fault('UNRESOLVED_TRADE_LOCK');throw e;}
    try{await f.sync();return await fn();}finally{await f.close();await unlink(p);}
  }
}
