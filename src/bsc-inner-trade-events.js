// Pure, read-only normalization of locally collected, bounded RPC evidence.
// Coverage is an RPC observation, not a cryptographic proof that a provider
// returned every log. No wallet qualification, safety waiver, or order here.
import {Interface,formatUnits,ZeroAddress} from 'ethers';
import {createHash} from 'node:crypto';
import {FLAP_PORTAL_VERIFIED_VERSION} from './flap-portal-pins.js';

export const INNER_TRADE_VERSION='bsc_inner_trade_window_v1';
export const INNER_TRADE_ORACLE='0x0567f2323251f0aab15c8dfb1967e4e8a7d42aee';
export const INNER_TRADE_ORACLE_ABI=new Interface(['function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
export const INNER_TRADE_ERC20_ABI=new Interface(['function decimals() view returns(uint8)']);
const fourAbi=new Interface([
  'event TokenPurchase(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)',
  'event TokenSale(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)',
]);
const flapAbi=new Interface([
  'event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
  'event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)',
]);
const fourInfo=new Interface(['function getTokenInfo(address) view returns(uint256,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)']);
const flapInfo=new Interface([
  'function version() view returns(string)',
  'function getTokenV8Safe(address) view returns((uint8,uint256,uint256,uint256,uint8,uint256,uint256,uint256,uint256,address,bool,bytes32,uint256,uint256,address,uint256,uint8,uint8))',
]);
export const INNER_TRADE_EMITTERS=Object.freeze({
  four_v2:Object.freeze({address:'0x5c952063c7fc8610ffdb798152d69f0b9550762b',abi:fourAbi,
    topics:Object.freeze(['TokenPurchase','TokenSale'].map(n=>fourAbi.getEvent(n).topicHash)),
    metadataSource:'0xf251f83e40a78868fcfa3fa4599dad6494e46034',metadataAbi:fourInfo,metadataMethod:'getTokenInfo'}),
  flap:Object.freeze({address:'0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0',abi:flapAbi,
    topics:Object.freeze(['TokenBought','TokenSold'].map(n=>flapAbi.getEvent(n).topicHash)),
    metadataSource:'0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0',metadataAbi:flapInfo,metadataMethod:'getTokenV8Safe'}),
});
const addr=v=>typeof v==='string'&&/^0x[0-9a-f]{40}$/i.test(v)?v.toLowerCase():null;
const hash=v=>typeof v==='string'&&/^0x[0-9a-f]{64}$/i.test(v)?v.toLowerCase():null;
const integer=n=>Number.isSafeInteger(n)&&n>=0;
const stamp=v=>typeof v==='number'?v:Date.parse(v||'');
const block=b=>b&&integer(b.number)&&b.number>0&&hash(b.hash)&&hash(b.parentHash)&&integer(b.timestamp)&&b.timestamp>0;
const decode=(abi,name,value)=>abi.decodeFunctionResult(name,value);
const units=(value,decimals)=>Number(formatUnits(value,decimals));

function parsedLog(platform,log) {
  const spec=INNER_TRADE_EMITTERS[platform];
  if(!spec||addr(log?.address)!==spec.address||log.removed!==false||!Array.isArray(log.topics)
    ||log.topics.length!==1||!spec.topics.includes(log.topics[0]?.toLowerCase())
    ||typeof log.data!=='string')return null;
  // All arguments in these exact ABI versions are non-indexed; reject trailing
  // bytes instead of letting a permissive decoder conceal an ABI upgrade.
  const words=platform==='flap'?7:8;
  if(log.data.length!==2+64*words||!/^0x[0-9a-f]+$/i.test(log.data))return null;
  // These pinned events contain only full static uint256/address words. Strict
  // slicing avoids repeated Interface fragment/Result construction per event.
  // Address high bytes MUST be zero: never silently truncate malformed words.
  const word=i=>log.data.slice(2+i*64,2+(i+1)*64),uint=i=>BigInt('0x'+word(i));
  const address=i=>{const v=word(i);if(!/^0{24}/.test(v))throw Error('address padding');return '0x'+v.slice(24).toLowerCase();};
  try {
    const buy=log.topics[0].toLowerCase()===spec.topics[0];
    if(platform==='four_v2')return {name:buy?'TokenPurchase':'TokenSale',args:{token:address(0),account:address(1),
      price:uint(2),amount:uint(3),cost:uint(4),fee:uint(5),offers:uint(6),funds:uint(7)}};
    return {name:buy?'TokenBought':'TokenSold',args:{ts:uint(0),token:address(1),[buy?'buyer':'seller']:address(2),
      amount:uint(3),eth:uint(4),fee:uint(5),postPrice:uint(6)}};
  }catch{return null;}
}

export function innerTradeLogToken(platform,log) {
  const p=parsedLog(platform,log);return p?addr(p.args.token):null;
}

/** See tests for a complete raw fixture. Segments are successful getLogs
 * ranges, linked by an equal shared boundary or the next header's parentHash.
 * metadata and oracle eth_call results must refer to toBlock, never latest. */
function normalizeInnerTradeWindowUncached(proof,nowMs) {
  const fail=(reason,code='invalid_evidence')=>({ready:false,reason,code,coverage:null,trades:[]});
  try {
    const p=proof,spec=INNER_TRADE_EMITTERS[p?.platform],observedAt=stamp(p?.observedAt);
    if(!spec||p.version!==INNER_TRADE_VERSION||p.chain!=='bsc'||p.chainId!==56||p.contract!==spec.address
      ||addr(p.tokenAddress)!==p.tokenAddress||p.tokenAddress===ZeroAddress||!integer(nowMs)
      ||!Number.isFinite(observedAt)||observedAt>nowMs||nowMs-observedAt>30000)
      return fail('内盘逐笔来源、CA、版本或采集时效未核实');
    const from=p.fromBlock,to=p.toBlock;
    if(!block(from)||!block(to)||from.number>to.number||from.timestamp>to.timestamp
      ||to.timestamp*1000>observedAt||nowMs-to.timestamp*1000>30000||p.endBlockHash!==to.hash
      ||p.range?.fromBlock!==from.number||p.range?.toBlock!==to.number
      ||p.range.complete!==true||p.range.truncated!==false||to.timestamp-from.timestamp>600)
      return fail('内盘逐笔区间不完整、已截断、过期或区块身份不一致','coverage_incomplete');
    if(!Array.isArray(p.segments)||!p.segments.length||p.segments.length>64
      ||!Array.isArray(p.blocks)||p.blocks.length>4002||!Array.isArray(p.logs)||p.logs.length>4000)
      return fail('内盘逐笔证明缺失或超过有界容量','coverage_incomplete');
    let prev=null;
    const anchors=new Map();
    const anchor=(number,value)=>{if(anchors.has(number)&&anchors.get(number)!==value)throw Error('anchor conflict');anchors.set(number,value);};
    for(const s of p.segments) {
      if(!integer(s.fromBlock)||!integer(s.toBlock)||s.fromBlock>s.toBlock||!hash(s.startHash)||!hash(s.endHash)
        ||s.fromBlock<from.number||s.toBlock>to.number)throw Error('segment bounds');
      if(!prev&&(s.fromBlock!==from.number||s.startHash!==from.hash))throw Error('segment start');
      if(prev&&!((s.fromBlock===prev.toBlock&&s.startHash===prev.endHash&&s.toBlock>prev.toBlock)
        ||(s.fromBlock===prev.toBlock+1&&s.startParentHash===prev.endHash)))throw Error('segment gap or conflict');
      anchor(s.fromBlock,s.startHash);anchor(s.toBlock,s.endHash);prev=s;
    }
    if(prev.toBlock!==to.number||prev.endHash!==to.hash)throw Error('segment end');
    const headers=new Map();
    for(const b of [...p.blocks,from,to]) {
      if(!block(b)||b.number<from.number||b.number>to.number||b.timestamp<from.timestamp||b.timestamp>to.timestamp)throw Error('header bounds');
      const value={number:b.number,hash:hash(b.hash),parentHash:hash(b.parentHash),timestamp:b.timestamp};
      if(headers.has(b.number)&&JSON.stringify(headers.get(b.number))!==JSON.stringify(value))throw Error('header conflict');
      if(anchors.has(b.number)&&anchors.get(b.number)!==value.hash)throw Error('anchor header conflict');
      headers.set(b.number,value);
    }
    const ordered=[...headers.values()].sort((a,b)=>a.number-b.number);
    for(let i=1;i<ordered.length;i++)if(ordered[i].timestamp<ordered[i-1].timestamp
      ||ordered[i].number===ordered[i-1].number+1&&ordered[i].parentHash!==ordered[i-1].hash)throw Error('header chain conflict');
    const m=p.metadata,o=p.oracle;
    if(m?.blockNumber!==to.number||m.blockHash!==to.hash||m.tokenAddress!==p.tokenAddress||m.source!==spec.metadataSource
      ||o?.blockNumber!==to.number||o.blockHash!==to.hash||o.address!==INNER_TRADE_ORACLE)
      return fail('同区块 CA 元数据或预言机身份未核实');
    const info=decode(spec.metadataAbi,spec.metadataMethod,m.raw.info),decimals=Number(decode(INNER_TRADE_ERC20_ABI,'decimals',m.raw.decimals)[0]);
    let quote;
    if(p.platform==='four_v2') {
      if(info[0]!==2n||addr(info[1])!==spec.address||info[11]!==false||info[6]>BigInt(to.timestamp)||info[7]<=0n||info[8]<info[7]||info[9]>=info[10])
        return fail('Four V2 CA 归属或未迁移曲线状态未核实');
      quote=info[2];
    }else {
      const v=decode(spec.metadataAbi,'version',m.raw.portalVersion)[0],state=info[0];
      if(v!==FLAP_PORTAL_VERIFIED_VERSION||state[0]!==1n||state[4]>7n||state[2]>=state[8]
        ||state[11]!=='0x'+'0'.repeat(64)||state[14]!==ZeroAddress||decimals!==18)
        return fail('Flap 固定版本、CA 归属、扩展或未迁移曲线状态未核实');
      quote=state[9];
    }
    if(quote!==ZeroAddress)return fail('非原生 BNB 底池尚无此逐笔美元估值适配，不能将 eth 字段当 BNB','unsupported_quote');
    const od=Number(decode(INNER_TRADE_ERC20_ABI,'decimals',o.raw.decimals)[0]),r=decode(INNER_TRADE_ORACLE_ABI,'latestRoundData',o.raw.latestRoundData);
    if(decimals<9||decimals>24||od!==8||r[0]<=0n||r[1]<=0n||r[4]<r[0]||r[2]<=0n||r[2]>r[3]
      ||r[3]<=0n||r[3]>BigInt(to.timestamp)||to.timestamp-Number(r[3])>3600)
      return fail('逐笔精度或 BNB/USD 预言机未核实');
    const nativeUsd=units(r[1],od),seen=new Map(),positions=new Map(),transactions=new Map(),transactionPositions=new Map();
    for(const log of p.logs) {
      const event=parsedLog(p.platform,log),index=log.logIndex??log.index,b=headers.get(log.blockNumber);
      if(!event||!b||hash(log.blockHash)!==b.hash||!hash(log.transactionHash)||!integer(log.transactionIndex)||!integer(index)
        ||log.logIndex!==undefined&&log.index!==undefined&&log.logIndex!==log.index)throw Error('log identity');
      const a=event.args,tokenAddress=addr(a.token),wallet=addr(p.platform==='four_v2'?a.account:(event.name==='TokenBought'?a.buyer:a.seller));
      if(!tokenAddress||tokenAddress===ZeroAddress||!wallet||wallet===ZeroAddress||a.amount<=0n
        ||p.platform==='flap'&&a.ts!==BigInt(b.timestamp))throw Error('event identity or time');
      const quoteRaw=p.platform==='four_v2'?a.cost:a.eth;
      if(quoteRaw<=0n)throw Error('event amount');
      const id=`bsc:${tokenAddress}:${log.transactionHash.toLowerCase()}:${index}`;
      const canonical=JSON.stringify({address:spec.address,topics:log.topics.map(x=>x.toLowerCase()),data:log.data.toLowerCase(),blockNumber:log.blockNumber,
        blockHash:b.hash,transactionIndex:log.transactionIndex,index});
      const position=`${b.hash}:${index}`,tx=log.transactionHash.toLowerCase(),txPlace=`${b.hash}:${log.transactionIndex}`;
      if(positions.has(position)&&positions.get(position)!==`${tx}:${canonical}`)throw Error('block log position conflict');
      if(transactions.has(tx)&&transactions.get(tx)!==txPlace)throw Error('transaction block or index conflict');
      if(transactionPositions.has(txPlace)&&transactionPositions.get(txPlace)!==tx)throw Error('transaction position conflict');
      positions.set(position,`${tx}:${canonical}`);transactions.set(tx,txPlace);transactionPositions.set(txPlace,tx);
      if(seen.has(id)){if(seen.get(id).canonical!==canonical)throw Error('duplicate log conflict');continue;}
      const baseAmount=units(a.amount,decimals),quoteAmount=units(quoteRaw,18),amountUsd=quoteAmount*nativeUsd;
      if(![baseAmount,quoteAmount,amountUsd,nativeUsd].every(n=>Number.isFinite(n)&&n>0))throw Error('amount overflow');
      seen.set(id,{canonical,trade:{chain:'bsc',tokenAddress,wallet,side:['TokenPurchase','TokenBought'].includes(event.name)?'buy':'sell',
        hash:log.transactionHash.toLowerCase(),logIndex:index,transactionIndex:log.transactionIndex,blockNumber:b.number,blockHash:b.hash,
        at:b.timestamp*1000,amountUsd,baseAmount,quoteAmount,tags:[],group:log.transactionHash.toLowerCase(),
        baseAmountRaw:a.amount.toString(),quoteAmountRaw:quoteRaw.toString(),feeRaw:a.fee.toString(),quoteToken:ZeroAddress,
        valuationBlock:to.number,quoteUsdUpdatedAt:Number(r[3])*1000,
        walletRole:p.platform==='four_v2'&&event.name==='TokenPurchase'?'token_recipient':'event_account',
        amountBasis:'event_quote_volume_not_wallet_net_proceeds'}});
    }
    const trades=[...seen.values()].map(x=>x.trade).filter(t=>t.tokenAddress===p.tokenAddress)
      .sort((a,b)=>a.blockNumber-b.blockNumber||a.transactionIndex-b.transactionIndex||a.logIndex-b.logIndex);
    return {ready:true,reason:null,code:null,coverage:{startAt:from.timestamp*1000,endAt:to.timestamp*1000},trades,
      scope:'固定 Four V2/Flap Portal 已核 RPC 区间的原生 BNB 曲线成交；非全 BSC、非独立控制人证明；估值不是钱包净盈亏。'};
  }catch{return fail('逐笔原始证明无法解码、区间断档或身份/数量冲突');}
}

// Memoize only immutable, fully validated observations, never buy permission.
// Content hashing (not object identity) catches in-place raw evidence changes.
// The cache retains no raw proof; every use still checks the changing clock.
const normalizedCache=new Map();
const CACHE_MAX_ENTRIES=8,CACHE_MAX_TRADES=16000,CACHE_MAX_BYTES=16*1024*1024;
let cachedTrades=0,cachedBytes=0;
const cacheFailure=(reason,code='invalid_evidence')=>({ready:false,reason,code,coverage:null,trades:[]});
const fresh=(observedAt,toAt,nowMs)=>integer(nowMs)&&Number.isFinite(observedAt)&&Number.isFinite(toAt)
  &&observedAt<=nowMs&&nowMs-observedAt<=30000&&toAt<=observedAt&&nowMs-toAt<=30000;
function freezeNormalized(result) {
  for(const trade of result.trades){Object.freeze(trade.tags);Object.freeze(trade);}
  Object.freeze(result.trades);Object.freeze(result.coverage);return Object.freeze(result);
}
export function normalizeInnerTradeWindow(proof,nowMs) {
  try {
    const observedAt=stamp(proof?.observedAt),toAt=proof?.toBlock?.timestamp*1000;
    if(!fresh(observedAt,toAt,nowMs))return cacheFailure('内盘逐笔采集或区块时效已过期、位于未来或未核实','coverage_incomplete');
    const serialized=JSON.stringify(proof);
    const key=createHash('sha256').update(serialized).digest('hex'),entry=normalizedCache.get(key);
    if(entry&&fresh(entry.observedAt,entry.toAt,nowMs)) {
      normalizedCache.delete(key);normalizedCache.set(key,entry);return entry.result;
    }
    // Validate precisely the content that was hashed, isolating later caller
    // mutation and custom getters/toJSON from the memoized evidence snapshot.
    const snapshot=JSON.parse(serialized),result=normalizeInnerTradeWindowUncached(snapshot,nowMs);
    if(!result.ready)return result;
    freezeNormalized(result);
    const bytes=Buffer.byteLength(JSON.stringify(result));
    if(bytes>CACHE_MAX_BYTES)return result;
    while(normalizedCache.size>=CACHE_MAX_ENTRIES||cachedTrades+result.trades.length>CACHE_MAX_TRADES||cachedBytes+bytes>CACHE_MAX_BYTES) {
      const first=normalizedCache.keys().next().value,old=normalizedCache.get(first);
      if(!old)break;
      normalizedCache.delete(first);cachedTrades-=old.result.trades.length;cachedBytes-=old.bytes;
    }
    normalizedCache.set(key,{result,bytes,observedAt:stamp(snapshot.observedAt),toAt:snapshot.toBlock.timestamp*1000});
    cachedTrades+=result.trades.length;cachedBytes+=bytes;
    return result;
  }catch{return cacheFailure('逐笔原始证明无法序列化或校验');}
}
