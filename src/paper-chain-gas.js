// Read-only fee samples. These are fees paid by public swap transactions, NOT
// the fee of an unbroadcast paper order and NOT a quote for its exact route.
import { Interface, id } from 'ethers';
export const CHAIN_GAS_VERSION = 'chain_receipt_gas_v1';
export const GAS_ACCOUNT_ONLY = 'gas_accounting_not_admission_v1';
export const GAS_NETWORKS = Object.freeze({
  eth: { rpc:'https://ethereum-rpc.publicnode.com', id:1, native:'ETH' },
  bsc: { rpc:'https://bsc-dataseed.bnbchain.org', id:56, native:'BNB' },
  base: { rpc:'https://base-rpc.publicnode.com', id:8453, native:'ETH' },
  robinhood: { rpc:'https://rpc.mainnet.chain.robinhood.com', id:4663, native:'ETH' },
  sol: { rpc:'https://api.mainnet-beta.solana.com', id:'5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', native:'SOL' },
});
const feeds={ETH:'0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419',BNB:'0x14e613ac84a31f709eadbdf89c6cc390fdc9540a',SOL:'0x4ffc43a60e009b551865a93d232e33fce9f01507'};
const abi=new Interface(['function decimals() view returns(uint8)','function description() view returns(string)',
  'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)']);
const swapTopics=new Set(['Swap(address,uint256,uint256,uint256,uint256,address)',
  'Swap(address,address,int256,int256,uint160,uint128,int24)',
  'Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)'].map(id));
const transfer=id('Transfer(address,address,uint256)'),stamp=v=>Date.parse(v||''),iso=t=>new Date(t).toISOString();
const fresh=(v,now,age)=>Number.isFinite(stamp(v))&&stamp(v)<=now&&now-stamp(v)<=age;
const positive=n=>Number.isFinite(n)&&n>0;
const hex=v=>{if(typeof v!=='string'||!/^0x[0-9a-f]+$/i.test(v))throw Error('invalid_receipt_quantity');return BigInt(v);};
const median=xs=>[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)];

export function receiptFeeNative(chain,receipt) {
  if(!GAS_NETWORKS[chain]||chain==='sol'||receipt?.status!=='0x1')throw Error('failed_receipt');
  const gas=hex(receipt.gasUsed),price=hex(receipt.effectiveGasPrice);
  if(gas<=21000n||price<=0n)throw Error('not_contract_fee_sample');
  // Nitro gasUsed already includes the parent-chain fee component. Do not
  // add gasUsedForL1 a second time. Base receipts expose L1 fees separately.
  let total=gas*price;
  if(chain==='base') {
    total+=hex(receipt.l1Fee);
    if(receipt.operatorFee!==undefined)total+=hex(receipt.operatorFee);
    else if(receipt.operatorFeeScalar!==undefined||receipt.operatorFeeConstant!==undefined) {
      const scalar=hex(receipt.operatorFeeScalar),constant=hex(receipt.operatorFeeConstant);
      // A nonzero operator schedule needs fork-specific decoding, not a guess.
      if(scalar!==0n||constant!==0n)throw Error('unsupported_operator_fee_schedule');
    }
  }
  return Number(total)/1e18;
}
export function validChainGas(value,chain,nowMs) {
  const network=GAS_NETWORKS[chain];
  return !!network&&value?.version===CHAIN_GAS_VERSION&&value.chain===chain&&value.native===network.native
    &&value.status==='ok'&&value.scope==='recent_chain_swaps_not_exact_route'
    &&fresh(value.observedAt,nowMs,90000)&&fresh(value.priceObservedAt,nowMs,network.native==='ETH'?3600000:86400000)
    &&positive(value.nativeUsd)&&value.nativeUsd<1e7&&Array.isArray(value.samples)&&value.samples.length>0&&value.samples.length<=3
    &&new Set(value.samples.map(s=>s.hash)).size===value.samples.length
    &&value.samples.every(s=>fresh(s.at,nowMs,300000)&&positive(s.feeNative)
      &&(chain==='sol'?/^[1-9A-HJ-NP-Za-km-z]{64,100}$/:/^0x[0-9a-f]{64}$/).test(s.hash))
    &&positive(value.gasUsd)&&Math.abs(value.gasUsd-median(value.samples.map(s=>s.feeNative))*value.nativeUsd)<1e-9;
}
export const chainGasUsd=(value,chain,nowMs)=>validChainGas(value,chain,nowMs)?value.gasUsd:null;

export function createChainGasMonitor({chains=Object.keys(GAS_NETWORKS),fetchImpl=fetch,now=Date.now}={}) {
  const selected=[...new Set(chains)],values=new Map(),cache=new Map();let pending,nextAt=0,stopped=false;
  async function batch(url,calls,partial=false) {
    const r=await fetchImpl(url,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json'},
      body:JSON.stringify(calls.map(([method,params],i)=>({jsonrpc:'2.0',id:i+1,method,params}))),signal:AbortSignal.timeout(8000)});
    if(!r.ok)throw Error(`fee_rpc_http_${r.status}`);
    const raw=await r.text();if(raw.length>8000000)throw Error('fee_rpc_response_large');
    const rows=JSON.parse(raw);if(!Array.isArray(rows)||rows.length!==calls.length||new Set(rows.map(r=>r.id)).size!==calls.length)throw Error('fee_rpc_schema');
    return calls.map((_,i)=>{const row=rows.find(r=>r.id===i+1);if(!row||row.error||row.result==null){if(partial)return null;throw Error('fee_rpc_result');}return row.result;});
  }
  const rpc=async(url,method,params)=>(await batch(url,[[method,params]]))[0];
  function snapshot(chain) {
    if(!chain)return Object.fromEntries(selected.map(c=>[c,snapshot(c)]));
    const v=values.get(chain)||{version:CHAIN_GAS_VERSION,chain,status:'waiting'};
    return structuredClone(validChainGas(v,chain,now())?v:{...v,status:v.status==='ok'?'stale':v.status});
  }
  async function prices() {
    const symbols=[...new Set(selected.map(c=>GAS_NETWORKS[c]?.native).filter(Boolean))];
    const calls=[['eth_chainId',[]],...symbols.flatMap(symbol=>['decimals','description','latestRoundData'].map(name=>
      ['eth_call',[{to:feeds[symbol],data:abi.encodeFunctionData(name)},'latest']]))];
    const result=await batch(GAS_NETWORKS.eth.rpc,calls,true);if(hex(result[0])!==1n)throw Error('oracle_wrong_chain');
    const prices={};
    symbols.forEach((symbol,i)=>{
      try {
      const decimals=Number(abi.decodeFunctionResult('decimals',result[1+i*3])[0]);
      if(decimals!==8||abi.decodeFunctionResult('description',result[2+i*3])[0]!==`${symbol} / USD`)throw Error('oracle_identity');
      const [round,answer,,updated,answered]=abi.decodeFunctionResult('latestRoundData',result[3+i*3]);
      if(answer<=0n||answered<round)throw Error('oracle_round');
      prices[symbol]={nativeUsd:Number(answer)/1e8,priceObservedAt:iso(Number(updated)*1000)};
      } catch {prices[symbol]=null;}
    });return prices;
  }
  async function evmSample(chain,t) {
    const url=GAS_NETWORKS[chain].rpc;
    const receipt=await rpc(url,'eth_getTransactionReceipt',[t.hash]);
    if(receipt.transactionHash?.toLowerCase()!==t.hash||receipt.from?.toLowerCase()!==t.wallet
      ||!receipt.logs?.some(l=>l.address?.toLowerCase()===t.tokenAddress&&l.topics?.[0]===transfer))throw Error('fee_receipt_binding');
    const block=await rpc(url,'eth_getBlockByHash',[receipt.blockHash,false]);
    if(block.hash!==receipt.blockHash||Number(hex(block.timestamp))*1000!==t.at)throw Error('fee_block_binding');
    return {hash:t.hash,at:iso(t.at),feeNative:receiptFeeNative(chain,receipt)};
  }
  async function solSample(t) {
    const value=await rpc(GAS_NETWORKS.sol.rpc,'getTransaction',[t.hash,{encoding:'jsonParsed',commitment:'confirmed',maxSupportedTransactionVersion:0}]);
    if(value?.meta?.err!==null||value.transaction?.signatures?.[0]!==t.hash||value.blockTime*1000!==t.at
      ||!Number.isSafeInteger(value.meta.fee)||value.meta.fee<=0
      ||!value.transaction.message.accountKeys?.some(k=>k.pubkey===t.wallet&&k.signer)
      ||![...(value.meta.preTokenBalances||[]),...(value.meta.postTokenBalances||[])].some(b=>b.mint===t.tokenAddress))throw Error('fee_sol_binding');
    return {hash:t.hash,at:iso(t.at),feeNative:value.meta.fee/1e9};
  }
  async function fallbackBlock(chain) {
    if(chain==='sol')return [];
    const url=GAS_NETWORKS[chain].rpc,head=await rpc(url,'eth_getBlockByNumber',['latest',false]);
    // A just-produced L2 head can be slightly ahead of the local wall clock.
    // Observe an existing older block instead of accepting future evidence.
    const number=hex(head.number);if(number<2n)throw Error('fee_block_unavailable');
    const block=await rpc(url,'eth_getBlockByNumber',['0x'+(number-2n).toString(16),false]);
    const receipts=await rpc(url,'eth_getBlockReceipts',[block.number]);
    if(!Array.isArray(receipts))throw Error('fee_receipts_schema');
    return receipts.filter(r=>r.blockHash===block.hash&&r.status==='0x1'&&/^0x[0-9a-f]{64}$/.test(r.transactionHash||'')
      &&r.logs?.some(l=>swapTopics.has(l.topics?.[0]))).slice(-3).map(r=>({hash:r.transactionHash,at:iso(Number(hex(block.timestamp))*1000),feeNative:receiptFeeNative(chain,r)}));
  }
  async function collect(chain,flowState,price) {
    const network=GAS_NETWORKS[chain];if(!network)throw Error('unsupported_chain');
    if(!price||!fresh(price.priceObservedAt,now(),network.native==='ETH'?3600000:86400000))throw Error('native_price_unavailable');
    const identity=await rpc(network.rpc,chain==='sol'?'getGenesisHash':'eth_chainId',[]);
    if(chain==='sol'?identity!==network.id:hex(identity)!==BigInt(network.id))throw Error('fee_wrong_chain');
    const candidates=[...new Map((flowState?.trades?.[chain]||[]).filter(t=>t.chain===chain&&Number.isSafeInteger(t.at)&&t.at<=now()&&now()-t.at<240000
      &&(chain==='sol'?/^[1-9A-HJ-NP-Za-km-z]{64,100}$/:/^0x[0-9a-f]{64}$/).test(t.hash)).sort((a,b)=>b.at-a.at).map(t=>[t.hash,t])).values()].slice(0,3);
    const samples=[];
    for(const t of candidates) {
      const key=`${chain}:${t.hash}`;
      try {const sample=cache.get(key)||await(chain==='sol'?solSample(t):evmSample(chain,t));cache.set(key,sample);samples.push(sample);}catch{/* One bad sample must not erase other verified receipts. */}
    }
    if(!samples.length)samples.push(...await fallbackBlock(chain));
    if(!samples.length)throw Error('no_recent_swap_fee_receipts');
    const value={version:CHAIN_GAS_VERSION,chain,native:network.native,status:'ok',observedAt:iso(now()),...price,samples,
      gasUsd:median(samples.map(s=>s.feeNative))*price.nativeUsd,source:'onchain_receipts_chainlink',scope:'recent_chain_swaps_not_exact_route',
      note:chain==='sol'?'链上 meta.fee 含优先费；不含独立小费、账户租金或平台费':'链上已成交 swap 费用样本中位数；不是本模拟订单实际费用'};
    if(!validChainGas(value,chain,now()))throw Error('stale_fee_evidence');
    values.set(chain,value);
  }
  function refresh(flowState) {
    if(stopped||pending||now()<nextAt)return pending||Promise.resolve(snapshot());nextAt=now()+30000;
    pending=(async()=>{
      let px;try{px=await prices();}catch{for(const chain of selected)values.set(chain,{...values.get(chain),chain,status:'unavailable',reason:'native_price_unavailable'});return;}
      const queue=[...selected];
      await Promise.all([0,1].map(async()=>{while(queue.length&&!stopped){const chain=queue.shift();try{await collect(chain,flowState,px[GAS_NETWORKS[chain]?.native]);}
        catch(e){values.set(chain,{...values.get(chain),chain,status:'unavailable',reason:e.message});}}}));
      for(const[key,sample]of cache)if(!fresh(sample.at,now(),300000))cache.delete(key);
      while(cache.size>128)cache.delete(cache.keys().next().value);
    })().finally(()=>{pending=null;});return pending;
  }
  return {refresh,snapshot,stop:async()=>{stopped=true;await pending;}};
}
