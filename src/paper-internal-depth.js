// Read-only depth admission evidence. Never an executable order or P&L quote.
import {Interface,parseUnits,formatUnits,ZeroAddress} from 'ethers';
import {createInnerTradeRpcReader} from './bsc-inner-trade-monitor.js';
import {sharedRpcHostCoordinator} from './rpc-host-coordinator.js';
import {rpcRetryAfterUntil} from './rpc-retry-after.js';
import {validateBscRpcEndpoints} from './bsc-private-rpc.js';
import {FLAP_PORTAL_VERIFIED_VERSION} from './flap-portal-pins.js';

export const INTERNAL_DEPTH_VERSION='four_native_depth_probe_v1';
export const FLAP_DEPTH_VERSION='flap_native_depth_probe_v1';
export const FLAP_QUOTE_DEPTH_VERSION='flap_quote_native_route_depth_v1';
export const DEPTH_TRANSPORT_VERSION='bounded_same_block_depth_batches_v1';
export const DEPTH_RETRY_POLICY=Object.freeze({retryPolicyVersion:'bounded_zero_rpc_capacity_retry_v1',
  maxAttempts:3,windowMs:10000,minBackoffMs:1000,failureBackoffMs:60000,maxCandidates:64});
// Never evict a CA's live retry/cooldown record to admit a new CA. A missed
// short retry must retain its full failure cooldown, not merely its due time.
export function admitInternalDepthRetryCandidate(attempts,key,nowMs) {
  if(attempts.has(key)||attempts.size<DEPTH_RETRY_POLICY.maxCandidates)return true;
  for(const [candidate,record] of attempts) {
    const reclaimAt=Math.max(record.capacityRetry?record.at+DEPTH_RETRY_POLICY.failureBackoffMs:record.nextAttemptAt,
      record.generationStartedAt+DEPTH_RETRY_POLICY.windowMs);
    if(nowMs>=reclaimAt)attempts.delete(candidate);
  }
  return attempts.size<DEPTH_RETRY_POLICY.maxCandidates;
}
export const FLAP_DEPTH_PORTAL='0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0';
export const FOUR_HELPER='0xf251f83e40a78868fcfa3fa4599dad6494e46034';
export const BNB_ORACLE='0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee';
const DEPTH_RPC_HOSTS=Object.freeze(['bsc-rpc.publicnode.com','public-bsc.nownodes.io','bsc.rpc.sentio.xyz']);
const managers={1:'0xec4549cadce5da21df6e6422d448034b5233bfbc',2:'0x5c952063c7fc8610ffdb798152d69f0b9550762b'};
const helper=new Interface([
  'function getTokenInfo(address) view returns(uint256,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)',
  'function tryBuy(address,uint256,uint256) view returns(address,address,uint256,uint256,uint256,uint256,uint256,uint256)',
  'function trySell(address,uint256) view returns(address,address,uint256,uint256)',
]);
export const FLAP_DEPTH_ABI=new Interface([
  'function version() view returns(string)',
  'function getTokenV8Safe(address) view returns((uint8,uint256,uint256,uint256,uint8,uint256,uint256,uint256,uint256,address,bool,bytes32,uint256,uint256,address,uint256,uint8,uint8))',
  'function getQuoteTokenConfiguration(address) view returns((uint8,uint8,uint8,uint8,uint8))',
  // Non-view ABI, but ONLY encoded for the strict reader's eth_call.
  'function quoteExactInput((address inputToken,address outputToken,uint256 inputAmount)) returns(uint256)',
]);
const erc=new Interface(['function decimals() view returns(uint8)']);
const oracle=new Interface(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
const at=x=>Date.parse(x||''),fresh=(x,now,ms)=>Number.isFinite(at(x))&&at(x)<=now&&now-at(x)<=ms;
const units=(v,d)=>Number(formatUnits(v,d));
const decode=(abi,name,raw)=>abi.decodeFunctionResult(name,raw);
const goodAddress=a=>typeof a==='string'&&/^0x[0-9a-f]{40}$/.test(a)&&a!==ZeroAddress;
// Type 6 is the official mixed router. Type 7's bidirectional Portal quote
// capability was checked on pinned v5.24.0 at BSC block 126216078 (2026-10-07);
// its implementation semantics are NOT inferred from the older public enum.
// Every admission still needs its own exact-CA, same-block quotes in BOTH
// directions. This is depth evidence only, never a sellability exemption.
const supportedFlapQuoteConfig=c=>c[0]===1n&&c[3]>=1n&&c[3]<=7n&&c[4]===0n;
// Copy only bounded scheduling metadata, never provider messages/URLs. A
// coordinator rejection can mean capacity OR a real host/method cooldown.
const depthRetryMetadata=error=>error?.code==='RPC_COORDINATOR_UNAVAILABLE'
  &&['capacity','host','method'].includes(error.rpcFailureScope)?{
    rpcFailureScope:error.rpcFailureScope,
    ...(Number.isSafeInteger(error.retryAfterMs)&&error.retryAfterMs>0?{retryAfterMs:error.retryAfterMs}:{}),
  }:{};

export function internalDepthCheck(proof,token,budgetUsd,nowMs,signal,expectedNotionalUsd) {
  const flap=[FLAP_DEPTH_VERSION,FLAP_QUOTE_DEPTH_VERSION].includes(proof?.version);
  const fail=reason=>({ready:false,reason,version:flap?proof.version:INTERNAL_DEPTH_VERSION});
  try {
    if(expectedNotionalUsd!==undefined&&(!Number.isFinite(expectedNotionalUsd)||expectedNotionalUsd<=0
      ||!Number.isFinite(proof?.notionalUsd)||Math.abs(proof.notionalUsd-expectedNotionalUsd)>1e-8))
      return fail('曲线试算须覆盖本单扣费后的完整金额');
    if(![INTERNAL_DEPTH_VERSION,FLAP_DEPTH_VERSION,FLAP_QUOTE_DEPTH_VERSION].includes(proof?.version)||proof.chain!=='bsc'||token?.chain!=='bsc'||!goodAddress(token.address)
      ||proof.address!==token.address||proof.helper!==(flap?FLAP_DEPTH_PORTAL:FOUR_HELPER)||proof.oracle!==BNB_ORACLE||proof.chainId!==56
      ||!Number.isFinite(budgetUsd)||budgetUsd<1||!Number.isFinite(proof.budgetUsd)||Math.abs(proof.budgetUsd-budgetUsd)>1e-8
      ||!fresh(proof.observedAt,nowMs,15000)||!fresh(proof.referenceAt,nowMs,20000)
      ||!(proof.referencePrice>0)||!(token.price>0)||Math.abs(token.price/proof.referencePrice-1)>.02
      ||signal&&(!fresh(signal.sourceAt,nowMs,30000)||at(proof.referenceAt)<at(signal.sourceAt)))
      return fail('等待此 CA、此预算的新鲜曲线深度试算');
    const b=proof.block;
    if(!Number.isSafeInteger(b?.number)||b.number<1||!/^0x[0-9a-f]{64}$/.test(b.hash)||proof.endBlockHash!==b.hash
      ||!Number.isSafeInteger(b.timestamp)||b.timestamp*1000>at(proof.observedAt)||nowMs-b.timestamp*1000>20000)
      return fail('曲线区块身份或时效未核实');
    if(flap)return checkFlapDepth(proof,budgetUsd,b,fail);
    const info=decode(helper,'getTokenInfo',proof.raw.info),version=Number(info[0]),manager=managers[version];
    if(!manager||info[1].toLowerCase()!==manager||info[2]!==ZeroAddress||info[11]!==false
      ||info[6]*1000n>BigInt(Math.floor(nowMs))||info[7]<=0n||info[8]<info[7]||info[10]<=0n||info[9]>=info[10])
      return fail('不是受支持的 Four 原生 BNB 未迁移曲线');
    const decimals=Number(decode(erc,'decimals',proof.raw.decimals)[0]);
    const oracleDecimals=Number(decode(erc,'decimals',proof.raw.oracleDecimals)[0]);
    const round=decode(oracle,'latestRoundData',proof.raw.oracle);
    if(decimals<9||decimals>24||oracleDecimals!==8||round[1]<=0n||round[4]<round[0]
      ||round[3]<=0n||round[3]>BigInt(b.timestamp)||b.timestamp-Number(round[3])>3600)
      return fail('代币精度或 BNB/USD 预言机未核实');
    const nativeUsd=units(round[1],8),amount=BigInt(proof.amount),small=BigInt(proof.smallAmount);
    if(amount<=0n||amount%1000000000n||small!==amount/10n/1000000000n*1000000000n||small<=0n||amount>info[7]
      ||!Number.isFinite(proof.notionalUsd)||proof.notionalUsd<=0||proof.notionalUsd>budgetUsd
      ||Math.abs(units(amount,decimals)*proof.referencePrice/proof.notionalUsd-1)>.001)
      return fail('曲线试算数量与拟下单金额不一致');
    const full=decode(helper,'tryBuy',proof.raw.buy),tiny=decode(helper,'tryBuy',proof.raw.smallBuy),sell=decode(helper,'trySell',proof.raw.sell);
    if([full,tiny,sell].some(q=>q[0].toLowerCase()!==manager||q[1]!==ZeroAddress)
      ||full[2]<amount||full[2]>amount+1000000000n||tiny[2]<small||tiny[2]>small+1000000000n
      ||[full,tiny].some(q=>q[3]<=0n||q[5]<q[3]+q[4]||q[6]!==0n)||sell[2]<=0n)
      return fail('曲线双向返回身份、数量或费用不一致');
    const buyUsd=units(full[5],18)*nativeUsd,sellUsd=units(sell[2],18)*nativeUsd;
    const fullUnit=units(full[3],18)/units(full[2],decimals),smallUnit=units(tiny[3],18)/units(tiny[2],decimals);
    const impact=fullUnit/smallUnit-1,spread=(buyUsd-sellUsd)/buyUsd,priceDeviation=Math.abs(fullUnit*nativeUsd/proof.referencePrice-1);
    if(![impact,spread,priceDeviation,buyUsd,sellUsd].every(Number.isFinite)||impact<-.001||impact>.05||spread<-.01||spread>.15
      ||priceDeviation>.1||buyUsd>budgetUsd||buyUsd<proof.notionalUsd*.85)
      return fail('曲线试算冲击、买卖价差或预算超限');
    return {ready:true,reason:null,version:INTERNAL_DEPTH_VERSION,buyUsd,sellUsd,impact,spread,priceDeviation,
      note:'同区块只读买卖试算，不是顺序交易模拟；不证明可卖性，不替代账本税费/滑点/Gas模型。'};
  }catch{return fail('曲线深度原始证明缺失或无法解码');}
}

function checkFlapDepth(p,budgetUsd,b,fail) {
  const info=decode(FLAP_DEPTH_ABI,'getTokenV8Safe',p.raw.info)[0];
  const version=decode(FLAP_DEPTH_ABI,'version',p.raw.portalVersion)[0];
  const converted=p.version===FLAP_QUOTE_DEPTH_VERSION;
  if(version!==FLAP_PORTAL_VERIFIED_VERSION||info[0]!==1n||info[1]<=0n||info[2]<=0n||info[2]>=info[8]
    ||info[4]>7n||(!converted&&info[9]!==ZeroAddress)||info[11]!=='0x'+'0'.repeat(64)||info[12]>600n||info[13]>600n||info[14]!==ZeroAddress)
    return fail('Flap 阶段/版本、底池路径、扩展或税率未通过深度适配');
  let quoteDecimals=null;
  if(converted) {
    const quote=info[9].toLowerCase(),config=decode(FLAP_DEPTH_ABI,'getQuoteTokenConfiguration',p.raw.quoteConfig)[0];
    quoteDecimals=Number(decode(erc,'decimals',p.raw.quoteDecimals)[0]);
    if(!goodAddress(quote)||quote===p.address||p.quoteAddress!==quote||info[10]!==true
      ||!supportedFlapQuoteConfig(config)||quoteDecimals<1||quoteDecimals>24)
      return fail('Flap 报价资产身份、精度或已支持的 BNB 转换路径未核实');
  }
  const decimals=Number(decode(erc,'decimals',p.raw.decimals)[0]),od=Number(decode(erc,'decimals',p.raw.oracleDecimals)[0]);
  const r=decode(oracle,'latestRoundData',p.raw.oracle);
  if(decimals!==18||od!==8||r[1]<=0n||r[4]<r[0]||r[3]<=0n||r[3]>BigInt(b.timestamp)||b.timestamp-Number(r[3])>3600)
    return fail('Flap 精度或 BNB/USD 预言机未核实');
  const usd=units(r[1],8),amount=BigInt(p.amount),small=BigInt(p.smallAmount);
  if(amount<=0n||small<=0n||small!==amount/10n||!Number.isFinite(p.notionalUsd)||p.notionalUsd<=0||p.notionalUsd>budgetUsd
    ||Math.abs(units(amount,18)*usd/p.notionalUsd-1)>.001)return fail('Flap 试算输入与拟下单金额不一致');
  const full=decode(FLAP_DEPTH_ABI,'quoteExactInput',p.raw.buy)[0],tiny=decode(FLAP_DEPTH_ABI,'quoteExactInput',p.raw.smallBuy)[0];
  const sold=decode(FLAP_DEPTH_ABI,'quoteExactInput',p.raw.sell)[0];
  // reserve is denominated in the quote asset, NOT BNB. Check the direct
  // token->quote leg against it; never compare unlike raw token units.
  const quoteSold=converted?decode(FLAP_DEPTH_ABI,'quoteExactInput',p.raw.quoteSell)[0]:sold;
  if(full<=0n||tiny<=0n||sold<=0n||quoteSold<=0n||full>info[8]-info[2]||quoteSold>info[1])return fail('Flap 试算超过可用曲线范围或反向报价不可用');
  const buyUsd=units(amount,18)*usd,sellUsd=units(sold,18)*usd;
  const unit=units(amount,18)/units(full,18),tinyUnit=units(small,18)/units(tiny,18);
  const impact=unit/tinyUnit-1,spread=(buyUsd-sellUsd)/buyUsd,priceDeviation=Math.abs(unit*usd/p.referencePrice-1);
  if(![impact,spread,priceDeviation,buyUsd,sellUsd].every(Number.isFinite)||impact<-.001||impact>.05||spread<-.01||spread>.15||priceDeviation>.1||buyUsd>budgetUsd)
    return fail('Flap 曲线冲击、价差或预算超限');
  return {ready:true,reason:null,version:p.version,buyUsd,sellUsd,impact,spread,priceDeviation,
    ...(converted?{quoteAddress:p.quoteAddress,quoteDecimals,quoteExitAmount:formatUnits(quoteSold,quoteDecimals),
      route:'BNB -> quote asset -> token / token -> BNB (Portal quoted)',
      // Diagnostic implied exit rate, not an independent USD oracle.
      impliedQuoteExitUsd:sellUsd/units(quoteSold,quoteDecimals)}:{}),
    note:'Flap 同区块 eth_call 双向试算；不是成交、顺序交易模拟或可卖性保证，账本仍按费用模型扣费。'};
}

export function selectInternalDepthRpcHost(snapshot,nowMs,rpcEndpoints) {
  const endpoints=validateBscRpcEndpoints(rpcEndpoints??DEPTH_RPC_HOSTS.map(host=>({host,url:`https://${host}`})));
  const hosts=endpoints.map(endpoint=>endpoint.host),preferred=new Set(endpoints.filter(endpoint=>endpoint.preferred===true).map(endpoint=>endpoint.host));
  const operations=new Set(['*','eth_call','eth_blockNumber','eth_getBlockByNumber','getNetwork','eth_chainId']);
  return hosts.filter(h=>!snapshot.circuits.some(c=>c.host===h&&c.until_ms>nowMs&&operations.has(c.operation)))
    .map(h=>{
      const active=snapshot.leases.filter(l=>l.host===h);
      // A healthy preferred endpoint keeps the work even when its seat is
      // busy: the shared coordinator still applies the bounded queue. An
      // active half-open recovery probe is different from ordinary load and
      // lets a healthy backup take over. Selection never grants a lease.
      const probing=snapshot.circuits.some(c=>c.host===h&&c.until_ms>0&&c.until_ms<=nowMs&&operations.has(c.operation)
        &&active.some(l=>c.operation==='*'||l.operation===c.operation));
      const blocked=active.length>=2||active.some(l=>l.lane!=='realtime')||probing;
      return {h,probing,blocked,load:active.length+2*snapshot.waiters.filter(w=>w.host===h).length};
    })
    .sort((a,b)=>Number(a.probing)-Number(b.probing)||Number(preferred.has(b.h))-Number(preferred.has(a.h))
      ||Number(a.blocked)-Number(b.blocked)
      ||a.load-b.load||hosts.indexOf(a.h)-hosts.indexOf(b.h))[0]?.h;
}

// One event-driven background probe, no polling worker. Every physical read
// shares the existing host coordinator. Busy/cooling hosts are not bypassed.
export function createInternalDepthProbe({dataDir,now=Date.now,reader=null,coordinator:injectedCoordinator=null,rpcEndpoints}={}) {
  const endpoints=validateBscRpcEndpoints(rpcEndpoints??DEPTH_RPC_HOSTS.map(host=>({host,url:`https://${host}`})));
  const readers=reader?null:new Map(endpoints.map(({host,url})=>[host,createInnerTradeRpcReader({host,endpointUrl:url})]));
  const coordinator=injectedCoordinator||(reader?null:sharedRpcHostCoordinator(dataDir));
  let active=false;
  return {async probe({token,budgetUsd,notionalUsd,referenceAt}) {
    if(active||token?.chain!=='bsc'||!goodAddress(token.address)||!['internal','near_completion'].includes(token.marketStage))return {status:'unavailable',reason:'曲线深度任务忙碌或阶段不支持'};
    if(!Number.isFinite(budgetUsd)||budgetUsd<1||!Number.isFinite(notionalUsd)||notionalUsd<=0||notionalUsd>budgetUsd
      ||!Number.isFinite(token.price)||token.price<=0||!fresh(referenceAt,now(),20000))return {status:'unavailable',reason:'曲线试算预算或参考价无效/过期'};
    // Pick once per probe from configured providers. No host retries,
    // changed API keys, lock removal or requests into another host's cooldown.
    let host=endpoints[0].host;
    if(coordinator&&!reader) {
      host=selectInternalDepthRpcHost(coordinator.snapshot(),now(),endpoints);
      if(!host)return {status:'unavailable',reason:'公共 RPC 均在共享冷却，等待恢复；未绕过限流'};
    }
    const rpc=reader||readers.get(host);
    active=true;
    const startedAt=now(),metrics={version:DEPTH_TRANSPORT_VERSION,host,physicalRequests:0,rpcItems:0,callBatches:0,failedMethod:null};
    const failure=(code,message)=>Object.assign(new Error(message),{code});
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(failure('ROUND_TIMEOUT','曲线试算达到十秒预算')),10000);timer.unref?.();
    const check=()=>{if(controller.signal.aborted)throw controller.signal.reason;
      if(now()-startedAt>=10000)throw failure('ROUND_TIMEOUT','曲线试算达到十秒预算');};
    const methods={getNetwork:'eth_chainId',getBlockNumber:'eth_blockNumber',getBlock:'eth_getBlockByNumber',call:'eth_call',callBatch:'eth_call'};
    const read=(name,...args)=>{
      check();const method=methods[name],items=name==='callBatch'?args[0].length:1;
      const run=async()=>{
        check();if(metrics.physicalRequests>=16||metrics.rpcItems+items>24)throw failure('ROUND_BUDGET','曲线只读请求预算已满');
        metrics.physicalRequests++;metrics.rpcItems+=items;if(name==='callBatch')metrics.callBatches++;
        try{const result=await rpc[name](...args,{signal:controller.signal});check();return result;}
        catch(e){metrics.failedMethod=method;
          if(coordinator&&!controller.signal.aborted){
            if([429,503].includes(e.status))await coordinator.persistCooldown(host,method,rpcRetryAfterUntil(e.retryAfter,now()));
            else if(['RPC_TIMEOUT','TIMEOUT','ECONNRESET','ECONNREFUSED','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(e.code)||e.name==='TypeError')
              await coordinator.persistCooldown(host,method,now()+30000);
          }throw e;}
      };
      const task=coordinator?coordinator.run(host,method,'background',run,{waitMs:Math.min(200,10000-(now()-startedAt))}):run();
      // Releasing the shared lease can also consume time after the RPC has
      // returned. No proof may escape the round budget through that boundary.
      return task.then(result=>{check();return result;}).catch(e=>{metrics.failedMethod=method;throw e;});
    };
    try {const result=await (async()=>{
    try {
      const network=await read('getNetwork'),number=await read('getBlockNumber'),block=await read('getBlock',number);
      const call=(abi,name,to,args=[])=>read('call',{to,blockTag:number,data:abi.encodeFunctionData(name,args)});
      // Every batch is <= 8 eth_call items at this exact numeric block. One
      // shared HTTP lease, unchanged semantic budget, no added concurrency.
      const calls=async specs=>{
        if(typeof rpc.callBatch!=='function'){
          const result={};for(const [key,abi,name,to,args=[]] of specs)result[key]=await call(abi,name,to,args);return result;
        }
        const rows=await read('callBatch',specs.map(([,abi,name,to,args=[]])=>({to,blockTag:number,data:abi.encodeFunctionData(name,args)})));
        const invalid=(code,message)=>{metrics.failedMethod='eth_call';return failure(code,message);};
        if(!Array.isArray(rows)||rows.length!==specs.length)throw invalid('RPC_RESPONSE_IDENTITY','曲线批量返回缺项');
        const result={};for(let i=0;i<rows.length;i++){
          if(rows[i]?.status!=='fulfilled')throw invalid(rows[i]?.code==='CALL_REVERTED'?'CALL_REVERTED':'RPC_RESPONSE_IDENTITY','曲线批量只读调用未完成');
          if(typeof rows[i].value!=='string'||!/^0x(?:[0-9a-f]{2})*$/.test(rows[i].value))throw invalid('RPC_RESPONSE_IDENTITY','曲线批量返回不是原始字节');
          result[specs[i][0]]=rows[i].value;
        }return result;
      };
      // Platform/suffix is a dispatch hint only. The pinned Portal must
      // independently return this CA's tradable curve; never an allowlist.
      const isFlap=/flap/i.test(`${token.launchpadPlatform||''} ${token.launchpad||''}`)||token.address.endsWith('7777');
      if(isFlap) {
        const raw={info:await call(FLAP_DEPTH_ABI,'getTokenV8Safe',FLAP_DEPTH_PORTAL,[token.address])};
        const state=decode(FLAP_DEPTH_ABI,'getTokenV8Safe',raw.info)[0];
        if(state[0]!==1n)return {status:'unavailable',reason:`Flap 链上并非可交易内盘（阶段 ${state[0]}），不能按内盘深度放行`};
        const converted=state[9]!==ZeroAddress,quoteAddress=state[9].toLowerCase();
        if(state[11]!=='0x'+'0'.repeat(64))return {status:'unavailable',reason:'Flap 自定义交易扩展尚未验证，不能套用普通曲线'};
        if(converted&&state[10]!==true)return {status:'unavailable',reason:'Flap 报价资产未开启 BNB 转换，不能假设原生买入路径'};
        Object.assign(raw,await calls([
          ['portalVersion',FLAP_DEPTH_ABI,'version',FLAP_DEPTH_PORTAL],
          ['decimals',erc,'decimals',token.address],['oracleDecimals',erc,'decimals',BNB_ORACLE],['oracle',oracle,'latestRoundData',BNB_ORACLE],
          ...(converted?[['quoteConfig',FLAP_DEPTH_ABI,'getQuoteTokenConfiguration',FLAP_DEPTH_PORTAL,[quoteAddress]],['quoteDecimals',erc,'decimals',quoteAddress]]:[]),
        ]));
        if(converted) {
          const config=decode(FLAP_DEPTH_ABI,'getQuoteTokenConfiguration',raw.quoteConfig)[0];
          if(!supportedFlapQuoteConfig(config))return {status:'unavailable',reason:`Flap 报价资产转换不可用（enabled=${config[0]}, swapType=${config[3]}, dexId=${config[4]}）；未跳过反向报价`,
            code:'flap_quote_route_unsupported',quoteAddress};
        }
        const nativeUsd=units(decode(oracle,'latestRoundData',raw.oracle)[1],8);
        const amount=parseUnits((notionalUsd/nativeUsd).toFixed(18),18),smallAmount=amount/10n;
        Object.assign(raw,await calls([['buy',FLAP_DEPTH_ABI,'quoteExactInput',FLAP_DEPTH_PORTAL,[[ZeroAddress,token.address,amount]]],
          ['smallBuy',FLAP_DEPTH_ABI,'quoteExactInput',FLAP_DEPTH_PORTAL,[[ZeroAddress,token.address,smallAmount]]]]));
        const output=decode(FLAP_DEPTH_ABI,'quoteExactInput',raw.buy)[0];
        try {Object.assign(raw,await calls([
          ...(converted?[['quoteSell',FLAP_DEPTH_ABI,'quoteExactInput',FLAP_DEPTH_PORTAL,[[token.address,quoteAddress,output]]]]:[]),
          ['sell',FLAP_DEPTH_ABI,'quoteExactInput',FLAP_DEPTH_PORTAL,[[token.address,ZeroAddress,output]]],
        ]));}
        catch(e) {return {status:'unavailable',code:e.code||'RPC_READ_FAILED',...depthRetryMetadata(e),reason:'Flap 反向 BNB 报价未完成；能用 BNB 买入不代表能换回 BNB'};}
        const end=await read('getBlock',number);
        const proof={version:converted?FLAP_QUOTE_DEPTH_VERSION:FLAP_DEPTH_VERSION,...(converted?{quoteAddress}:{}),chain:'bsc',rpcHost:host,chainId:network.chainId,address:token.address,helper:FLAP_DEPTH_PORTAL,oracle:BNB_ORACLE,
          budgetUsd,notionalUsd,referencePrice:token.price,referenceAt,observedAt:new Date(now()).toISOString(),block,endBlockHash:end.hash,
          amount:amount.toString(),smallAmount:smallAmount.toString(),raw};
        const check=internalDepthCheck(proof,token,budgetUsd,now());
        return {status:check.ready?'ok':'unavailable',reason:check.reason,proof};
      }
      const raw={info:await call(helper,'getTokenInfo',FOUR_HELPER,[token.address])};
      const info=decode(helper,'getTokenInfo',raw.info);
      if(!managers[Number(info[0])]||info[2]!==ZeroAddress||info[11])return {status:'unavailable',reason:'未接入此平台/报价资产的真实曲线适配器'};
      Object.assign(raw,await calls([['decimals',erc,'decimals',token.address],['oracleDecimals',erc,'decimals',BNB_ORACLE],['oracle',oracle,'latestRoundData',BNB_ORACLE]]));
      const decimals=Number(decode(erc,'decimals',raw.decimals)[0]);
      if(decimals<9||decimals>24||!(token.price>0)||!(notionalUsd>0))throw Error('unsupported precision');
      const amount=parseUnits((notionalUsd/token.price).toFixed(decimals),decimals)/1000000000n*1000000000n;
      const smallAmount=amount/10n/1000000000n*1000000000n;
      if(amount<=0n||smallAmount<=0n)throw Error('insufficient quantity');
      Object.assign(raw,await calls([['buy',helper,'tryBuy',FOUR_HELPER,[token.address,amount,0]],
        ['smallBuy',helper,'tryBuy',FOUR_HELPER,[token.address,smallAmount,0]],['sell',helper,'trySell',FOUR_HELPER,[token.address,amount]]]));
      const end=await read('getBlock',number);
      const proof={version:INTERNAL_DEPTH_VERSION,chain:'bsc',rpcHost:host,chainId:network.chainId,address:token.address,helper:FOUR_HELPER,oracle:BNB_ORACLE,
        budgetUsd,notionalUsd,referencePrice:token.price,referenceAt,observedAt:new Date(now()).toISOString(),
        block,endBlockHash:end.hash,amount:amount.toString(),smallAmount:smallAmount.toString(),raw};
      const check=internalDepthCheck(proof,token,budgetUsd,now());
      return {status:check.ready?'ok':'unavailable',reason:check.reason,proof};
    }catch(e){return {status:'unavailable',code:e.code||'RPC_READ_FAILED',...depthRetryMetadata(e),reason:'曲线只读试算未完成（接口不支持、共享席位忙碌或超时）；未授予深度豁免'};}
    })();
      // Include proof validation/serialization preparation in the deadline.
      try{check();}catch(e){return {status:'unavailable',code:e.code||'ROUND_TIMEOUT',reason:'曲线试算超过整轮时间预算；未授予深度豁免',
        diagnostics:{...metrics,durationMs:Math.max(0,now()-startedAt)}};}
      return {...result,diagnostics:{...metrics,durationMs:Math.max(0,now()-startedAt)}};}
    finally{clearTimeout(timer);active=false;}
  }};
}
