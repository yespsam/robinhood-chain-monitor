// Bounded public-log observation owned by the existing paper runtime. This
// module has no scheduler, signer, transaction writer, or historical backlog.
import {ZeroAddress} from 'ethers';
import {sharedRpcHostCoordinator} from './rpc-host-coordinator.js';
import {rpcRetryAfterUntil} from './rpc-retry-after.js';
import {validateBscRpcEndpoints,sanitizeBscRpcError} from './bsc-private-rpc.js';
import {FLAP_PORTAL_VERIFIED_VERSION} from './flap-portal-pins.js';
import {INNER_TRADE_VERSION,INNER_TRADE_EMITTERS,INNER_TRADE_ORACLE,INNER_TRADE_ORACLE_ABI,
  INNER_TRADE_ERC20_ABI,innerTradeLogToken,normalizeInnerTradeWindow} from './bsc-inner-trade-events.js';

export const INNER_MONITOR_VERSION='bsc_inner_trade_monitor_v1';
const HOSTS=Object.freeze(['bsc-rpc.publicnode.com','public-bsc.nownodes.io','bsc.rpc.sentio.xyz']);
const ADDRESS=/^0x[0-9a-f]{40}$/,HASH=/^0x[0-9a-f]{64}$/,DATA=/^0x(?:[0-9a-f]{2})*$/;
const METHODS={getNetwork:'eth_chainId',getBlockNumber:'eth_blockNumber',getBlock:'eth_getBlockByNumber',getBlocks:'eth_getBlockByNumber',getLogs:'eth_getLogs',call:'eth_call',callBatch:'eth_call'};
const LIMITS=Object.freeze({intervalMs:10000,taskMs:10000,queueWaitMs:1000,physicalRequests:32,rpcItems:64,logsPerRound:2000,
  logsPerWindow:4000,targets:4,headerBatch:8,callBatch:8,retentionMs:120000,cursorRetentionMs:120000,
  watchAbsoluteMaxMs:240000,gapMs:30000,maxBlocksPerRound:256,confirmationDepth:8});
const iso=n=>new Date(n).toISOString(),key=t=>`bsc:${t.address}`,clone=v=>structuredClone(v);
const fail=(code,message)=>Object.assign(new Error(message),{code});
const hex=n=>{if(!Number.isSafeInteger(n)||n<0)throw fail('INVALID_RPC_INPUT','invalid numeric block');return `0x${n.toString(16)}`;};
const quantity=(v,label)=>{
  if(typeof v!=='string'||!/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(v))throw fail('INVALID_RPC_RESPONSE',`${label} is not canonical`);
  const n=Number(BigInt(v));if(!Number.isSafeInteger(n))throw fail('INVALID_RPC_RESPONSE',`${label} exceeds integer range`);return n;
};
function header(value,number,raw=false) {
  const n=raw?quantity(value?.number,'block number'):value?.number;
  const timestamp=raw?quantity(value?.timestamp,'block timestamp'):value?.timestamp;
  if(n!==number||!Number.isSafeInteger(timestamp)||timestamp<=0||!HASH.test(value?.hash||'')||!HASH.test(value?.parentHash||''))
    throw fail('INVALID_RPC_RESPONSE','block identity unavailable');
  return {number:n,hash:value.hash,parentHash:value.parentHash,timestamp};
}
function canonicalLog(log,filter,raw=false) {
  const number=raw?quantity(log?.blockNumber,'log block'):log?.blockNumber;
  const transactionIndex=raw?quantity(log?.transactionIndex,'transaction index'):log?.transactionIndex;
  const logIndex=raw?quantity(log?.logIndex,'log index'):(log?.logIndex??log?.index);
  if(!log||log.address!==filter.address||log.removed!==false||!HASH.test(log.blockHash||'')||!HASH.test(log.transactionHash||'')
    ||!Number.isSafeInteger(number)||number<filter.fromBlock||number>filter.toBlock
    ||!Number.isSafeInteger(transactionIndex)||transactionIndex<0||!Number.isSafeInteger(logIndex)||logIndex<0
    ||log.index!==undefined&&log.index!==logIndex||!Array.isArray(log.topics)||log.topics.length!==1
    ||!filter.topics[0].includes(log.topics[0])||!DATA.test(log.data||''))throw fail('INVALID_LOG_RESPONSE','log identity or filter mismatch');
  return {address:log.address,topics:[...log.topics],data:log.data,blockNumber:number,blockHash:log.blockHash,
    transactionHash:log.transactionHash,transactionIndex,logIndex,removed:false};
}

function callParams(value) {
  if(!value||Object.keys(value).sort().join(',')!=='blockTag,data,to'||!ADDRESS.test(value.to)||value.to===ZeroAddress||!DATA.test(value.data))
    throw fail('INVALID_RPC_INPUT','invalid pinned eth_call');
  return [{to:value.to,data:value.data},hex(value.blockTag)];
}

// Deliberately narrow JSON-RPC surface. Batches contain <= 8 public headers
// OR <= 8 eth_call items at one numeric block. They take one HTTP host lease,
// retain every semantic item in the budget, and never raise concurrency.
export function createInnerTradeRpcReader({host=HOSTS[0],endpointUrl,fetchImpl=globalThis.fetch}={}) {
  if(typeof fetchImpl!=='function')throw TypeError('unsupported inner-trade reader');
  // The credential-bearing URL stays in this reader's closure; all shared
  // capacity, diagnostics and proof identities continue to use a plain host.
  const [endpoint]=validateBscRpcEndpoints([{host,url:endpointUrl??`https://${host}`}]);
  const url=endpoint.url,origin=new URL(url).origin;let id=1;
  const callReverted=Symbol('verified eth_call revert');
  async function request(items,signal,{allowReverts=false}={}) {
    if(!Array.isArray(items)||!items.length||items.length>LIMITS.headerBatch
      ||items.length>1&&!(items.every(x=>x.method==='eth_getBlockByNumber')
        ||items.every(x=>x.method==='eth_call')&&new Set(items.map(x=>x.params[1])).size===1))
      throw fail('INVALID_RPC_INPUT','only bounded headers or same-block read-only calls may be batched');
    const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>controller.abort(fail('RPC_TIMEOUT','inner-trade RPC timeout')),1800);timer.unref?.();
    const payload=items.map(x=>({jsonrpc:'2.0',id:id++,method:x.method,params:x.params}));
    try {
      const response=await fetchImpl(url,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{accept:'application/json','content-type':'application/json'},body:JSON.stringify(items.length===1?payload[0]:payload)});
      if(response?.redirected||response?.url&&new URL(response.url).origin!==origin)throw fail('RPC_ORIGIN_MISMATCH','inner-trade RPC origin mismatch');
      if(response?.status!==200)throw Object.assign(fail('RPC_HTTP_ERROR',`inner-trade RPC HTTP ${response?.status}`),
        {status:response?.status,retryAfter:response?.headers?.get?.('retry-after')});
      if(Number(response.headers?.get?.('content-length'))>1500000)throw fail('RPC_RESPONSE_LIMIT','RPC response exceeds byte budget');
      let text='';const stream=response.body?.getReader?.();
      if(stream){const decoder=new TextDecoder();let bytes=0;while(true){const r=await stream.read();if(r.done)break;bytes+=r.value.length;
        if(bytes>1500000){await stream.cancel().catch(()=>{});throw fail('RPC_RESPONSE_LIMIT','RPC response exceeds byte budget');}text+=decoder.decode(r.value,{stream:true});}text+=decoder.decode();}
      else {text=await response.text();if(Buffer.byteLength(text)>1500000)throw fail('RPC_RESPONSE_LIMIT','RPC response exceeds byte budget');}
      const parsed=JSON.parse(text),rows=items.length===1?[parsed]:parsed;
      if(!Array.isArray(rows)||rows.length!==payload.length)throw fail('RPC_RESPONSE_IDENTITY','incomplete RPC response batch');
      const seen=new Map();for(const row of rows){if(!row||row.jsonrpc!=='2.0'||!payload.some(p=>p.id===row.id)||seen.has(row.id))
        throw fail('RPC_RESPONSE_IDENTITY','RPC response identity or result mismatch');
        if(Object.keys(row).sort().join(',')==='error,id,jsonrpc') {
          const message=String(row.error?.message||'');
          if(row.error?.code===429||/rate.?limit|too many requests|quota|requests per|request limit/i.test(message))
            throw Object.assign(fail('RPC_RATE_LIMIT','public RPC rate limit'),{status:429,retryAfter:response.headers?.get?.('retry-after')});
          if(payload.find(p=>p.id===row.id)?.method==='eth_call'&&(row.error?.code===3||/execution reverted|revert(?:ed)?(?:\s|$)/i.test(message))) {
            if(allowReverts){seen.set(row.id,callReverted);continue;}
            throw fail('CALL_REVERTED','read-only contract call reverted');
          }
          throw fail('RPC_PROVIDER_ERROR','public RPC returned a JSON-RPC error');
        }
        if(Object.keys(row).sort().join(',')!=='id,jsonrpc,result')throw fail('RPC_RESPONSE_IDENTITY','RPC response identity or result mismatch');seen.set(row.id,row.result);}
      return payload.map(p=>seen.get(p.id));
    }catch(error){
      const safe=sanitizeBscRpcError(error),clean=Object.assign(new Error(safe.message),safe);
      // Preserve transport classification without retaining an unsafe cause,
      // URL, response body or any enumerable fields from the original error.
      if(error instanceof TypeError)clean.name='TypeError';
      throw clean;
    }finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);}
  }
  const single=async(method,params,signal)=>(await request([{method,params}],signal))[0];
  return {
    async getNetwork({signal}={}){const chainId=quantity(await single('eth_chainId',[],signal),'chain id');if(chainId!==56)throw fail('CHAIN_MISMATCH','BSC chain id mismatch');return {chainId};},
    async getBlockNumber({signal}={}){return quantity(await single('eth_blockNumber',[],signal),'head');},
    async getBlock(number,{signal}={}){return header(await single('eth_getBlockByNumber',[hex(number),false],signal),number,true);},
    async getBlocks(numbers,{signal}={}){if(!Array.isArray(numbers)||new Set(numbers).size!==numbers.length)throw fail('INVALID_RPC_INPUT','duplicate header request');
      const rows=await request(numbers.map(n=>({method:'eth_getBlockByNumber',params:[hex(n),false]})),signal);return rows.map((r,i)=>header(r,numbers[i],true));},
    async getLogs(filter,{signal}={}){
      if(!filter||!Object.values(INNER_TRADE_EMITTERS).some(s=>s.address===filter.address&&JSON.stringify([s.topics])===JSON.stringify(filter.topics))
        ||filter.toBlock<filter.fromBlock||filter.toBlock-filter.fromBlock>=LIMITS.maxBlocksPerRound)throw fail('INVALID_RPC_INPUT','unscoped or excessive log range');
      const rows=await single('eth_getLogs',[{address:filter.address,topics:filter.topics,fromBlock:hex(filter.fromBlock),toBlock:hex(filter.toBlock)}],signal);
      if(!Array.isArray(rows)||rows.length>=LIMITS.logsPerRound)throw fail('LOG_RESPONSE_LIMIT','log result reached bounded limit; completeness unknown');
      return rows.map(r=>canonicalLog(r,filter,true));
    },
    async call(value,{signal}={}){
      const result=await single('eth_call',callParams(value),signal);
      if(!DATA.test(result||''))throw fail('INVALID_RPC_RESPONSE','eth_call response is not bytes');return result;
    },
    async callBatch(values,{signal}={}) {
      if(!Array.isArray(values)||!values.length||values.length>LIMITS.callBatch||new Set(values.map(v=>v?.blockTag)).size!==1)
        throw fail('INVALID_RPC_INPUT','read-only batch needs one numeric block and at most eight items');
      const rows=await request(values.map(v=>({method:'eth_call',params:callParams(v)})),signal,{allowReverts:true});
      return rows.map(value=>{
        if(value===callReverted)return {status:'rejected',code:'CALL_REVERTED'};
        if(typeof value!=='string'||!DATA.test(value))throw fail('INVALID_RPC_RESPONSE','eth_call batch result is not bytes');
        return {status:'fulfilled',value};
      });
    },
  };
}

function platformFor(token) {
  if(['four_v2','flap'].includes(token.platform))return token.platform;
  const hint=`${token.launchpadPlatform||''} ${token.launchpad||''}`;
  return /flap/i.test(hint)||token.address.endsWith('7777')?'flap':'four_v2';
}
function metadataSupport(platform,raw,block) {
  try {
    const spec=INNER_TRADE_EMITTERS[platform],info=spec.metadataAbi.decodeFunctionResult(spec.metadataMethod,raw.info);
    const decimals=Number(INNER_TRADE_ERC20_ABI.decodeFunctionResult('decimals',raw.decimals)[0]);
    if(decimals<9||decimals>24)return '此 CA 精度未核实';
    if(platform==='four_v2') {
      if(info[0]!==2n||info[1].toLowerCase()!==spec.address||info[11]!==false||info[6]>BigInt(block.timestamp)
        ||info[7]<=0n||info[8]<info[7]||info[9]>=info[10])return 'Four V2 曲线归属或未迁移状态待核';
      if(info[2]!==ZeroAddress)return '非原生 BNB 底池逐笔估值尚未适配';
    }else {
      const state=info[0];
      if(state[0]!==1n||state[4]>7n||state[2]>=state[8]||state[11]!=='0x'+'0'.repeat(64)||state[14]!==ZeroAddress||decimals!==18)
        return 'Flap 已迁移、存在未验证扩展或并非受支持内盘';
      if(state[9]!==ZeroAddress)return '非原生 BNB 底池逐笔估值尚未适配';
      if(spec.metadataAbi.decodeFunctionResult('version',raw.portalVersion)[0]!==FLAP_PORTAL_VERIFIED_VERSION)return 'Flap Portal 版本尚未验证';
    }
    return null;
  }catch{return '此 CA 原始曲线元数据无法验证';}
}

export function createInnerTradeMonitor({dataDir,now=Date.now,reader=null,coordinator=null,rpcEndpoints}={}) {
  if(!reader&&!dataDir)throw TypeError('inner-trade monitor requires dataDir');
  const endpoints=validateBscRpcEndpoints(rpcEndpoints??HOSTS.map(host=>({host,url:`https://${host}`})));
  const hosts=endpoints.map(endpoint=>endpoint.host),preferred=new Set(endpoints.filter(endpoint=>endpoint.preferred===true).map(endpoint=>endpoint.host));
  const gate=coordinator||(reader?null:sharedRpcHostCoordinator(dataDir));
  const readers=reader?null:new Map(endpoints.map(({host,url})=>[host,createInnerTradeRpcReader({host,endpointUrl:url})]));
  let stopped=false,job=null,controller=null,lastStartedAt=null,lastHost=null;
  const states=new Map(),platformHeads=new Map(),unsupported=new Map(),leases=new Map(),selectionHistory=new Map();
  let selectionSequence=0;
  let state={version:INNER_MONITOR_VERSION,status:'idle',observedAt:null,lastSuccessAt:null,lastCoveredAt:null,lastError:null,
    lastRound:null,windows:[],checks:[],coverage:{scope:'selected_bsc_native_portal_tokens',fullBscMarket:false},
    totals:{rounds:0,physicalRequests:0,rpcItems:0,logs:0,gaps:0,reorgs:0,maxCoveredMs:0,coveredRounds:0},limits:LIMITS};
  const refreshWindows=()=>{state.windows=[...states.values()].map(s=>s.proof).filter(Boolean);};
  function forget(platform,reason) {
    for(const [k,s] of states)if(s.platform===platform){states.delete(k);unsupported.delete(k);}
    platformHeads.delete(platform);state.totals.gaps++;state.coverage.lastGap={platform,at:iso(now()),reason};refreshWindows();
  }
  function chooseHost() {
    if(reader)return hosts[0];
    const s=gate.snapshot(),at=now(),operations=new Set(['*',...Object.values(METHODS)]);
    return hosts.filter(h=>!s.circuits.some(c=>c.host===h&&c.until_ms>at&&operations.has(c.operation)))
      .map(h=>{
        const active=s.leases.filter(l=>l.host===h);
        // One realtime lease still leaves a background seat; one background
        // lease does not. Expired circuits also retain their single-probe
        // constraint until a successful read clears them. This snapshot is
        // only a selection hint: run() still owns atomic FIFO admission.
        const probing=s.circuits.some(c=>c.host===h&&c.until_ms>0&&c.until_ms<=at&&operations.has(c.operation)
          &&active.some(l=>c.operation==='*'||l.operation===c.operation));
        const blocked=active.length>=2||active.some(l=>l.lane!=='realtime')||probing;
        return {h,blocked,probing,load:active.length+2*s.waiters.filter(w=>w.host===h).length};
      })
      // A healthy paid endpoint owns the first bounded queue attempt even
      // when its seat is temporarily occupied. Recovery probes still yield
      // to usable fallback hosts; selection never bypasses atomic admission.
      .sort((a,b)=>Number(a.probing)-Number(b.probing)||Number(preferred.has(b.h))-Number(preferred.has(a.h))
        ||Number(a.blocked)-Number(b.blocked)
        ||a.load-b.load||hosts.indexOf(a.h)-hosts.indexOf(b.h))[0]?.h;
  }
  async function run(tokens) {
    const startedAt=now(),round={startedAt:iso(startedAt),physicalRequests:0,rpcItems:0,logs:0,selected:tokens.length,host:null,
      confirmationDepth:LIMITS.confirmationDepth,callBatches:0,callBatchItems:0};
    state.totals.rounds++;state.status='collecting';state.checks=[];
    let host=null,rpc=null;
    controller=new AbortController();const signal=controller.signal;
    const timer=setTimeout(()=>controller?.abort(fail('ROUND_TIMEOUT','逐笔采集达到十秒预算')),LIMITS.taskMs);timer.unref?.();
    const check=()=>{if(signal.aborted)throw signal.reason||fail('ABORTED','逐笔采集已取消');if(now()-startedAt>=LIMITS.taskMs)throw fail('ROUND_TIMEOUT','逐笔采集达到十秒预算');};
    async function read(method,...args) {
      check();const items=['getBlocks','callBatch'].includes(method)?args[0].length:1;
      if(round.physicalRequests>=LIMITS.physicalRequests||round.rpcItems+items>LIMITS.rpcItems)throw fail('ROUND_BUDGET','逐笔物理请求或 RPC 项目预算已满');
      const callback=async()=>{check();round.physicalRequests++;round.rpcItems+=items;state.totals.physicalRequests++;state.totals.rpcItems+=items;
        if(method==='callBatch'){round.callBatches++;round.callBatchItems+=items;}
        try{return await rpc[method](...args,{signal});}catch(e){if(gate&&[429,503].includes(e.status)) {
          await gate.persistCooldown(host,METHODS[method],rpcRetryAfterUntil(e.retryAfter,now()));
        }else if(gate&&!signal.aborted&&(['RPC_TIMEOUT','ECONNRESET','ECONNREFUSED','ETIMEDOUT','UND_ERR_CONNECT_TIMEOUT'].includes(e.code)||e.name==='TypeError')) {
          await gate.persistCooldown(host,METHODS[method],now()+30000);
        }throw e;}};
      // Use the coordinator's existing default FIFO wait, never priority or
      // concurrency escalation. A late read cannot wait beyond this round.
      check();const remainingMs=LIMITS.taskMs-(now()-startedAt);
      if(remainingMs<=0)throw fail('ROUND_TIMEOUT','逐笔采集达到十秒预算');
      const waitMs=Math.min(LIMITS.queueWaitMs,remainingMs);
      return gate?gate.run(host,METHODS[method],'background',callback,{waitMs}):callback();
    }
    try {
      host=chooseHost();round.host=host||null;lastHost=host||lastHost;rpc=reader||(host&&readers.get(host));
      if(!host)throw fail('RPC_COOLING','公共 RPC 均在共享冷却');
      const network=await read('getNetwork');if(network?.chainId!==56)throw fail('CHAIN_MISMATCH','BSC chain id mismatch');
      const head=await read('getBlockNumber');if(!Number.isSafeInteger(head)||head<=LIMITS.confirmationDepth)throw fail('INVALID_HEAD','BSC head unavailable');
      // Validator/header timestamps can lead local wall time by a sub-second.
      // Observe a deeper confirmed tip rather than weakening the time check.
      const confirmedNumber=head-LIMITS.confirmationDepth;
      const to=header(await read('getBlock',confirmedNumber),confirmedNumber);
      Object.assign(round,{reportedHead:head,headBlock:to.number,headAt:iso(to.timestamp*1000),headAgeMs:now()-to.timestamp*1000});
      if(round.headAgeMs<0||round.headAgeMs>LIMITS.gapMs) {
        // A successfully decoded but stale/future head is unusable evidence.
        // Cool only this endpoint's relevant read methods; the next scheduled
        // round may choose another existing host, never retry this round.
        if(gate) {
          await gate.persistCooldown(host,'eth_blockNumber',now()+30000,'method');
          await gate.persistCooldown(host,'eth_getBlockByNumber',now()+30000,'method');
        }
        throw fail('STALE_HEAD',round.headAgeMs<0?'公共 RPC 已确认区块时间晚于本机时钟，时钟或来源时间待核；未自动校时或放宽时效':'公共 RPC 最新已确认区块过期');
      }
      const selected=new Set(tokens.map(key));for(const k of states.keys())if(!selected.has(k))states.delete(k);
      const currentPlatforms=new Set(tokens.map(platformFor));for(const p of platformHeads.keys())if(!currentPlatforms.has(p))platformHeads.delete(p);
      const headers=new Map([[to.number,to]]),plans=new Map(),metas=new Map();
      async function getHeader(n){if(headers.has(n))return headers.get(n);const b=header(await read('getBlock',n),n);headers.set(n,b);return b;}
      // Each previously committed tip is re-read before new evidence is used.
      for(const platform of currentPlatforms) {
        let previous=platformHeads.get(platform);
        // A cursor is only a private re-read anchor, not fresh trade evidence.
        // Its bounded lifetime is independent of the unchanged 30s exposure
        // rule: all intervening logs and both anchors must still be re-read.
        if(previous&&(now()-previous.observedAt>LIMITS.cursorRetentionMs||to.number<previous.block.number
          ||to.number-previous.block.number>LIMITS.maxBlocksPerRound)) {forget(platform,'采集断档或超过近期范围，已从当前区块重建');previous=null;}
        if(previous) {
          const prior=await getHeader(previous.block.number);
          if(prior.hash!==previous.block.hash){state.totals.reorgs++;forget(platform,'已核区块哈希变化，撤销旧窗口并重建');previous=null;}
        }
        if(previous&&to.number===previous.block.number){state.checks.push({platform,status:'head_not_advanced',reason:'已确认链头没有前进，未刷新证据时间'});continue;}
        const from=previous?await getHeader(previous.block.number+1):to;
        if(previous&&from.parentHash!==previous.block.hash){state.totals.reorgs++;forget(platform,'新区块父哈希与已核锚点不一致');throw fail('REORG','新区间父哈希不一致');}
        plans.set(platform,{from,to,logs:[]});
      }
      const callTasks=[],callResults=new Map(),metadataTargets=[];
      const addCall=(id,abi,name,toAddress,args=[])=>callTasks.push({id,request:{to:toAddress,blockTag:to.number,data:abi.encodeFunctionData(name,args)}});
      for(const token of tokens) {
        const k=key(token),platform=platformFor(token),spec=INNER_TRADE_EMITTERS[platform];
        if(!plans.has(platform))continue;
        const prior=unsupported.get(k);
        if(prior&&now()<prior.retryAt){state.checks.push({chain:'bsc',address:token.address,platform,status:'unsupported',reason:prior.reason,nextCheckAt:iso(prior.retryAt)});continue;}
        metadataTargets.push({token,k,platform,spec});
        addCall(`${k}:info`,spec.metadataAbi,spec.metadataMethod,spec.metadataSource,[token.address]);
        addCall(`${k}:decimals`,INNER_TRADE_ERC20_ABI,'decimals',token.address);
      }
      if(metadataTargets.some(t=>t.platform==='flap'))addCall('portalVersion',INNER_TRADE_EMITTERS.flap.metadataAbi,'version',INNER_TRADE_EMITTERS.flap.metadataSource);
      if(metadataTargets.length){addCall('oracleDecimals',INNER_TRADE_ERC20_ABI,'decimals',INNER_TRADE_ORACLE);addCall('oracleRound',INNER_TRADE_ORACLE_ABI,'latestRoundData',INNER_TRADE_ORACLE);}
      for(let i=0;i<callTasks.length;i+=LIMITS.callBatch) {
        const batch=callTasks.slice(i,i+LIMITS.callBatch);let rows;
        if(typeof rpc.callBatch==='function')rows=await read('callBatch',batch.map(t=>t.request));
        else {
          // Injected test/legacy readers may omit batching. Production always
          // has it; a failed upstream batch is NEVER split or retried here.
          rows=[];for(const task of batch)try{rows.push({status:'fulfilled',value:await read('call',task.request)});}
          catch(error){if(error.code!=='CALL_REVERTED')throw error;rows.push({status:'rejected',code:'CALL_REVERTED'});}
        }
        if(!Array.isArray(rows)||rows.length!==batch.length)throw fail('RPC_RESPONSE_IDENTITY','read-only metadata batch missing items');
        for(let j=0;j<batch.length;j++) {
          const row=rows[j];if(!(row?.status==='fulfilled'&&typeof row.value==='string'&&DATA.test(row.value))
            &&!(row?.status==='rejected'&&row.code==='CALL_REVERTED'))throw fail('RPC_RESPONSE_IDENTITY','invalid read-only batch item');
          callResults.set(batch[j].id,row);
        }
      }
      for(const {token,k,platform,spec} of metadataTargets) {
        const ids=[`${k}:info`,`${k}:decimals`,...(platform==='flap'?['portalVersion']:[])];
        if(ids.some(id=>callResults.get(id)?.status!=='fulfilled')) {
          const reason='此 CA 只读曲线/精度查询回退，未确认受支持内盘';unsupported.set(k,{reason,retryAt:now()+60000});states.delete(k);
          state.checks.push({chain:'bsc',address:token.address,platform,status:'unsupported',reason});continue;
        }
        const raw={info:callResults.get(`${k}:info`).value,decimals:callResults.get(`${k}:decimals`).value,
          ...(platform==='flap'?{portalVersion:callResults.get('portalVersion').value}:{})};
        const reason=metadataSupport(platform,raw,to);
        if(reason){unsupported.set(k,{reason,retryAt:now()+60000});states.delete(k);state.checks.push({chain:'bsc',address:token.address,platform,status:'unsupported',reason});continue;}
        metas.set(k,{blockNumber:to.number,blockHash:to.hash,tokenAddress:token.address,source:spec.metadataSource,raw});
      }
      if(metas.size&&['oracleDecimals','oracleRound'].some(id=>callResults.get(id)?.status!=='fulfilled'))throw fail('ORACLE_UNAVAILABLE','同区块 BNB 预言机只读查询回退');
      const oracle=metas.size?{address:INNER_TRADE_ORACLE,blockNumber:to.number,blockHash:to.hash,raw:{
        decimals:callResults.get('oracleDecimals').value,latestRoundData:callResults.get('oracleRound').value}}:null;
      const needed=new Set();
      for(const [platform,plan] of plans) {
        const active=new Set(tokens.filter(t=>platformFor(t)===platform&&metas.has(key(t))).map(t=>t.address));
        if(!active.size)continue;
        const spec=INNER_TRADE_EMITTERS[platform],filter={address:spec.address,topics:[spec.topics],fromBlock:plan.from.number,toBlock:to.number};
        const logs=await read('getLogs',filter);
        if(!Array.isArray(logs)||round.logs+logs.length>=LIMITS.logsPerRound)throw fail('LOG_RESPONSE_LIMIT','逐笔返回达到每轮容量，覆盖不可确认');
        round.logs+=logs.length;state.totals.logs+=logs.length;
        for(const raw of logs) {
          const log=canonicalLog(raw,filter),ca=innerTradeLogToken(platform,log);
          if(!ca)throw fail('ABI_CHANGED','固定事件 ABI 无法解析，不能宣称完整覆盖');
          if(active.has(ca)){plan.logs.push(log);if(!headers.has(log.blockNumber))needed.add(log.blockNumber);}
        }
        plan.queried=true;
      }
      const numbers=[...needed].sort((a,b)=>a-b);
      for(let i=0;i<numbers.length;i+=LIMITS.headerBatch) {
        const batch=numbers.slice(i,i+LIMITS.headerBatch);
        if(typeof rpc.getBlocks==='function') {
          const rows=await read('getBlocks',batch);
          if(!Array.isArray(rows)||rows.length!==batch.length)throw fail('HEADER_BATCH_MISMATCH','事件区块头不完整');
          for(let j=0;j<batch.length;j++)headers.set(batch[j],header(rows[j],batch[j]));
        }else for(const number of batch)await getHeader(number);
      }
      const end=header(await read('getBlock',to.number),to.number);
      if(end.hash!==to.hash){for(const p of currentPlatforms)forget(p,'当轮区块身份发生变化');state.totals.reorgs++;throw fail('REORG','区间末尾复核检测到重组');}
      check();const observedAt=iso(now()),pending=new Map();
      for(const token of tokens) {
        const k=key(token),platform=platformFor(token),plan=plans.get(platform),metadata=metas.get(k);
        if(!metadata||!plan?.queried)continue;
        const old=states.get(k),spec=INNER_TRADE_EMITTERS[platform];
        let segments=[...(old?.proof.segments||[]),{fromBlock:plan.from.number,toBlock:to.number,startHash:plan.from.hash,
          endHash:to.hash,startParentHash:plan.from.parentHash}];
        const allHeaders=new Map([...(old?.proof.blocks||[]),...headers.values()].map(b=>[b.number,b]));
        while(segments.length>1&&allHeaders.get(segments[1].fromBlock)?.timestamp*1000<=to.timestamp*1000-LIMITS.retentionMs)segments.shift();
        const from=allHeaders.get(segments[0].fromBlock);
        const logs=[...(old?.proof.logs||[]),...plan.logs.filter(l=>innerTradeLogToken(platform,l)===token.address)].filter(l=>l.blockNumber>=from.number);
        if(logs.length>LIMITS.logsPerWindow||segments.length>64)throw fail('WINDOW_LIMIT','逐笔窗口达到有界容量，停止推广信号');
        const proof={version:INNER_TRADE_VERSION,chain:'bsc',chainId:56,platform,contract:spec.address,tokenAddress:token.address,
          observedAt,fromBlock:from,toBlock:to,endBlockHash:end.hash,range:{fromBlock:from.number,toBlock:to.number,complete:true,truncated:false},
          segments,blocks:[...allHeaders.values()].filter(b=>b.number>=from.number&&b.number<=to.number).sort((a,b)=>a.number-b.number),logs,metadata,oracle};
        const result=normalizeInnerTradeWindow(proof,now());
        check(); // Synchronous ABI normalization also consumes the wall budget.
        if(!result.ready)throw fail('PROOF_INVALID',result.reason);
        pending.set(k,{platform,proof,newAnchor:!old});
        state.checks.push({chain:'bsc',address:token.address,platform,status:to.timestamp-from.timestamp>=90?'covered':'warming_up',
          coveredMs:(to.timestamp-from.timestamp)*1000,tradeCount:result.trades.length,fromBlock:from.number,toBlock:to.number,
          reason:to.timestamp-from.timestamp>=90?null:'从首次观察开始积累相邻 90 秒窗口，未回填旧积压'});
      }
      check(); // Never commit after CPU work outlived the task deadline.
      for(const [k,s] of pending) {
        if(s.newAnchor&&leases.has(k))leases.get(k).anchorAt=now();
        states.set(k,{platform:s.platform,proof:s.proof});
      }
      // Historical diagnostics describe a successfully committed full window,
      // never the current provider state or a failed/partially built proof.
      const committedCoveredMs=Math.max(0,...[...pending.values()].map(s=>(s.proof.toBlock.timestamp-s.proof.fromBlock.timestamp)*1000));
      if(committedCoveredMs>=90000) {
        state.totals.maxCoveredMs=Math.max(state.totals.maxCoveredMs,committedCoveredMs);
        state.totals.coveredRounds++;state.lastCoveredAt=observedAt;
      }
      for(const [p,plan] of plans)if(plan.queried)platformHeads.set(p,{block:to,observedAt:now()});
      refreshWindows();state.observedAt=observedAt;state.lastSuccessAt=observedAt;state.lastError=null;
      state.status=state.checks.some(c=>c.status==='covered')?'ready':state.windows.length?'warming_up':state.checks.some(c=>c.status==='unsupported')?'unsupported':'idle';
    }catch(error) {
      // Keep only an in-memory cursor for a bounded retry. Never expose old
      // windows as current after a failed/partial round, nor advance its tip.
      const safe=sanitizeBscRpcError(error);
      state.windows=[];state.status=stopped?'stopped':'unavailable';state.lastError={code:safe.code||'READ_UNAVAILABLE',reason:safe.message,at:iso(now())};
    }finally {
      clearTimeout(timer);controller=null;round.finishedAt=iso(now());round.durationMs=Math.max(0,now()-startedAt);state.lastRound=round;
    }
    return snapshot();
  }
  function snapshot() {
    const targets=[...leases].map(([k,l])=>({chain:'bsc',address:k.slice(4),platform:l.platform}));
    const result=clone({...state,targets,running:!!job,host:lastHost,nextCheckAt:lastStartedAt===null?null:iso(lastStartedAt+LIMITS.intervalMs)});
    result.windows=result.windows.filter(p=>now()-Date.parse(p.observedAt)<=LIMITS.gapMs&&now()-p.toBlock.timestamp*1000<=LIMITS.gapMs);
    if(!result.windows.length&&['ready','warming_up'].includes(result.status))result.status='stale';
    return result;
  }
  return {
    refresh({tokens=[],exitPending=false}={}) {
      if(stopped||exitPending||job||lastStartedAt!==null&&now()-lastStartedAt<LIMITS.intervalMs)return Promise.resolve(snapshot());
      const unique=new Map();
      for(const t of tokens.filter(t=>t?.chain==='bsc'&&ADDRESS.test(t.address||'')&&t.address!==ZeroAddress
        &&['internal','near_completion'].includes(t.marketStage)&&(t.held||t.sourceObservedAt===undefined||Number.isFinite(Date.parse(t.sourceObservedAt))
          &&Date.parse(t.sourceObservedAt)<=now()&&now()-Date.parse(t.sourceObservedAt)<=120000))) {
        const prior=unique.get(key(t));unique.set(key(t),prior?{...t,...prior,held:!!prior.held||!!t.held}:t);
      }
      const eligible=[...unique.values()];
      const eligibleKeys=new Set(eligible.map(key));
      for(const k of leases.keys())if(!eligibleKeys.has(k))leases.delete(k);
      for(const k of selectionHistory.keys())if(!eligibleKeys.has(k))selectionHistory.delete(k);
      for(const [k,v] of unsupported)if(v.retryAt<=now()||!eligibleKeys.has(k))unsupported.delete(k);
      const available=eligible.filter(t=>!unsupported.has(key(t)));
      const held=available.filter(t=>t.held),watched=available.filter(t=>{
        const lease=leases.get(key(t));return !t.held&&lease&&now()-lease.selectedAt<LIMITS.watchAbsoluteMaxMs
          &&(lease.fairRotation||now()-(lease.anchorAt??lease.selectedAt)<LIMITS.retentionMs);
      });
      const rotationDue=available.some(t=>!t.held&&leases.has(key(t))&&now()-leases.get(key(t)).selectedAt>=LIMITS.watchAbsoluteMaxMs)
        &&available.some(t=>!t.held&&!leases.has(key(t)));
      // Expiring preference alone cannot rotate a fixed ranking: the same
      // four entries would immediately take their old seats again. Only when
      // an absolute lease expires AND another candidate is waiting, prefer
      // unobserved/least-recently selected replacements. Held and unexpired
      // seats keep their continuity; no substitute means no forced reset.
      const tier=t=>{const lease=leases.get(key(t));return !lease?1:now()-lease.selectedAt<LIMITS.watchAbsoluteMaxMs?0:2;};
      const ordered=rotationDue?[...available].sort((a,b)=>tier(a)-tier(b)
        ||(tier(a)===1?(selectionHistory.get(key(a))??-1)-(selectionHistory.get(key(b))??-1):0)):available;
      const selected=[...new Map([...held,...watched,...ordered].map(t=>[key(t),t])).values()].slice(0,LIMITS.targets);
      const selectedKeys=new Set(selected.map(key));
      for(const k of states.keys())if(!selectedKeys.has(k))states.delete(k);
      for(const k of leases.keys())if(!selectedKeys.has(k))leases.delete(k);
      const selectedPlatforms=new Set(selected.map(platformFor));
      for(const platform of platformHeads.keys())if(!selectedPlatforms.has(platform))platformHeads.delete(platform);
      for(const t of selected) {
        if(!leases.has(key(t))){
          // A fair replacement gets one bounded full turn; otherwise the
          // unchanged top ranking could reclaim it at the 120s soft expiry.
          leases.set(key(t),{selectedAt:now(),anchorAt:null,platform:platformFor(t),fairRotation:rotationDue});
          selectionHistory.delete(key(t));selectionHistory.set(key(t),++selectionSequence);
        }
        else leases.get(key(t)).platform=platformFor(t);
      }
      while(selectionHistory.size>128)selectionHistory.delete(selectionHistory.keys().next().value);
      refreshWindows();
      if(!selected.length){states.clear();platformHeads.clear();leases.clear();state.windows=[];
        state.checks=eligible.slice(0,LIMITS.targets).map(t=>({chain:'bsc',address:t.address,platform:platformFor(t),status:'unsupported',
          reason:unsupported.get(key(t))?.reason||'无可用目标',nextCheckAt:unsupported.has(key(t))?iso(unsupported.get(key(t)).retryAt):null}));
        state.status=state.checks.length?'unsupported':'idle';return Promise.resolve(snapshot());}
      lastStartedAt=now();job=run(selected).finally(()=>{job=null;});return job;
    },
    snapshot,
    async stop(){stopped=true;controller?.abort(fail('STOPPED','逐笔采集已停止'));await job;state.status='stopped';state.windows=[];states.clear();platformHeads.clear();leases.clear();unsupported.clear();selectionHistory.clear();},
  };
}
