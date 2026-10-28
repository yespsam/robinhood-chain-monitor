import { Interface, keccak256, formatUnits } from 'ethers';
import { createPortalQuoteReader, solveAllocation } from './fast-allocation.mjs';

const probeAbi = new Interface(['function assetProbe()', 'function buyCapacityProbe()', 'function actionStatusProbe()',
  'function buyPlanProbe(uint256,uint256)', 'function quoteFundingProbe(uint256)', 'function sellPlanCustomProbe(uint256,uint256)',
  'function claimableProbe()', 'function launchRouteProbe()', 'error Error(string)']);
export const tokenAbi = new Interface(['function balanceOf(address) view returns(uint256)', 'function allowance(address,address) view returns(uint256)',
  'function approve(address,uint256) returns(bool)', 'event Transfer(address indexed from,address indexed to,uint256 value)',
  'event Approval(address indexed owner,address indexed spender,uint256 value)']);
export const portalAbi = new Interface(['function buyWithQuote(address,uint256,uint256) returns(uint256)', 'function sellBps(address,uint256,uint256) returns(uint256)',
  'function claim(address) returns(uint256)', 'function factory() view returns(address)']);
const viewAbi = new Interface(['function portal() view returns(address)', 'function market() view returns(address)', 'function probeOfMarket(address) view returns(address)',
  'function implementation() view returns(address)', 'function token() view returns(address)', 'function predictedToken() view returns(address)', 'function sharesOf(address) view returns(uint256)']);
export const tradeEvents = new Interface(['event VirtualTrade(uint256 indexed id,address indexed wallet,uint8 side,uint256 shares,uint256 quoteSubmitted,uint256 quoteUser,uint256 agentFee,uint256 quotePool,uint256 quoteCurve,uint256 refund,uint256 launchReserveRefund,uint256 poolAfter,uint256 expectedFlapReserveAfter,uint256 outstandingSharesAfter,uint256 spotPriceBefore,uint256 spotPriceAfter)',
  'event Claimed(address indexed wallet,uint256 amount,address indexed caller)']);
export const BEACON_SLOT = '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50';
export const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.toLowerCase() === b.toLowerCase();
export const human = x => formatUnits(x, 18);
export function fault(code, details = {}) { const e = new Error(code); e.code = code; e.details = details; return e; }
const amount = x => { if (typeof x !== 'string' || !/^\d+$/.test(x)) throw fault('INVALID_CHAIN_AMOUNT'); return BigInt(x); };
function unwrap(row) { if (row.error) { const e = fault('RPC_CALL_FAILED'); e.rpcError = row.error; throw e; } if (!Object.hasOwn(row, 'result')) throw fault('RPC_INVALID_RESPONSE'); return row.result; }

export function createFlapRpc({ url = 'https://bsc-dataseed.bnbchain.org', fetchImpl = fetch, timeoutMs = 3500 } = {}) {
  let nextId = 1;
  async function batch(calls, { signal } = {}) {
    const requests = calls.map(([method, params]) => {
      if (!['eth_call','eth_chainId','eth_blockNumber','eth_getBlockByNumber','eth_getCode','eth_getStorageAt','eth_getBalance','eth_getTransactionCount','eth_getTransactionReceipt','eth_getTransactionByHash','eth_estimateGas','eth_gasPrice','eth_getLogs'].includes(method)) throw fault('RPC_WRITE_FORBIDDEN');
      return { jsonrpc: '2.0', id: nextId++, method, params };
    });
    const s = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(requests), signal:s });
    if (!response.ok) throw fault('RPC_UNAVAILABLE');
    const raw = await response.text(); if (raw.length > 2_000_000) throw fault('RPC_OVERSIZED');
    const rows = JSON.parse(raw);
    if (!Array.isArray(rows) || rows.length !== requests.length || new Set(rows.map(x=>x.id)).size !== rows.length) throw fault('RPC_INVALID_RESPONSE');
    return requests.map(q => { const row = rows.find(x=>x.id===q.id); if (!row || row.jsonrpc !== '2.0') throw fault('RPC_INVALID_RESPONSE'); return row; });
  }
  async function rpc(method, params, options) { return unwrap((await batch([[method,params]], options))[0]); }
  rpc.batch = batch; return rpc;
}

export function decodeProbe(row) {
  const raw = row?.error?.data;
  if (typeof raw !== 'string' || !raw.startsWith('0x08c379a0')) throw fault('PROBE_UNREADABLE');
  let text; try { text = probeAbi.parseError(raw).args[0]; } catch { throw fault('PROBE_UNREADABLE'); }
  if (!text.endsWith(';END') || text.length > 4096) throw fault('PROBE_INCOMPLETE');
  const fields = {};
  for (const item of text.slice(0,-4).split(';')) {
    const i = item.indexOf('='); if (i < 1 || Object.hasOwn(fields,item.slice(0,i))) throw fault('PROBE_INVALID_FIELDS');
    fields[item.slice(0,i)] = item.slice(i+1);
  }
  return fields;
}

export function createFlapReader(profile, { rpc = createFlapRpc(), clock = Date.now } = {}) {
  const call = (to, abi, name, args, block, from = profile.wallet) => ['eth_call', [{from,to,value:'0x0',data:abi.encodeFunctionData(name,args)},block]];
  const probeCall = (name,args,block) => call(profile.probe,probeAbi,name,args,block);
  async function probe(name,args=[],block='latest') { return decodeProbe((await rpc.batch([probeCall(name,args,block)]))[0]); }
  async function snapshot() {
    const start = clock();
    const [chainRow,headRow] = await rpc.batch([['eth_chainId',[]],['eth_blockNumber',[]]]);
    if (BigInt(unwrap(chainRow))!==56n) throw fault('CHAIN_MISMATCH'); const block=unwrap(headRow);
    const checks = [
      ['eth_getBlockByNumber',[block,false]], probeCall('assetProbe',[],block), probeCall('buyCapacityProbe',[],block),probeCall('actionStatusProbe',[],block),
      call(profile.quote,tokenAbi,'balanceOf',[profile.wallet],block),call(profile.quote,tokenAbi,'allowance',[profile.wallet,profile.market],block),
      ['eth_getBalance',[profile.wallet,block]], ['eth_getTransactionCount',[profile.wallet,'latest']],['eth_getTransactionCount',[profile.wallet,'pending']],
      call(profile.factory,viewAbi,'probeOfMarket',[profile.market],block),call(profile.probe,viewAbi,'market',[],block),
      call(profile.market,viewAbi,'portal',[],block),call(profile.portal,portalAbi,'factory',[],block),call(profile.market,viewAbi,'token',[],block),
      ...Object.keys(profile.codeHashes || {}).map(address=>['eth_getCode',[address,block]]),
      ...Object.entries(profile.beacons || {}).flatMap(([address,b])=>[['eth_getStorageAt',[address,BEACON_SLOT,block]],call(b.address,viewAbi,'implementation',[],block)])
    ];
    const r=await rpc.batch(checks), head=unwrap(r[0]);
    if(!head||head.number!==block)throw fault('BLOCK_MISMATCH');
    const snapshotAtMs=Number(BigInt(head.timestamp))*1000;
    if(clock()-snapshotAtMs>10000 || snapshotAtMs-clock()>2000) throw fault('STALE_BLOCK');
    const asset=decodeProbe(r[1]),capacity=decodeProbe(r[2]),action=decodeProbe(r[3]);
    if(!same(asset.MARKET,profile.market)||!same(asset.QUOTE,profile.quote)||asset.DECIMALS!=='18') throw fault('MARKET_BINDING_CHANGED');
    const bindings=[ [r[9],viewAbi,'probeOfMarket',profile.probe],[r[10],viewAbi,'market',profile.market],
      [r[11],viewAbi,'portal',profile.portal],[r[12],portalAbi,'factory',profile.factory] ];
    for(const [row,abi,method,expected] of bindings) if(!same(abi.decodeFunctionResult(method,unwrap(row))[0],expected)) throw fault('MARKET_BINDING_CHANGED');
    let cursor=14;
    for(const [address,hash] of Object.entries(profile.codeHashes||{})) if(keccak256(unwrap(r[cursor++]))!==hash) throw fault('CONTRACT_CODE_CHANGED',{address});
    for(const [address,b] of Object.entries(profile.beacons||{})) {
      const beacon='0x'+unwrap(r[cursor++]).slice(-40),impl=viewAbi.decodeFunctionResult('implementation',unwrap(r[cursor++]))[0];
      if(!same(beacon,b.address)||!same(impl,b.implementation)) throw fault('CONTRACT_UPGRADED',{address});
    }
    const sharesRaw=amount(capacity.HELD_SHARES), roomRaw=amount(capacity.ROOM_SHARES),limitRaw=amount(capacity.LIMIT_SHARES);
    if(!['1','2','3'].includes(capacity.PHASE)||!['0','1'].includes(capacity.ID)||!['0','1'].includes(action.BUY_OK)||!['0','1'].includes(action.CLAIM_OK)||sharesRaw+roomRaw>limitRaw||capacity.PHASE!==action.PHASE) throw fault('CHAIN_STATE_INCONSISTENT');
    return {block,snapshotAtMs,readMs:clock()-start,phase:Number(capacity.PHASE),eligible:capacity.ID==='1',buyOk:action.BUY_OK==='1',
      claimOk:action.CLAIM_OK==='1',sharesRaw,roomRaw,limitRaw,statusToken:action.TOKEN,token:viewAbi.decodeFunctionResult('token',unwrap(r[13]))[0],
      balanceRaw:tokenAbi.decodeFunctionResult('balanceOf',unwrap(r[4]))[0],allowanceRaw:tokenAbi.decodeFunctionResult('allowance',unwrap(r[5]))[0],
      nativeRaw:BigInt(unwrap(r[6])),nonce:unwrap(r[7]),pendingNonce:unwrap(r[8])};
  }
  const quoteBuy=createPortalQuoteReader({rpc,portal:profile.portal,market:profile.market,wallet:profile.wallet});
  async function buyPlan(s, {signal}={}) {
    if(s.phase!==1||!s.eligible||!s.buyOk) throw fault('BUY_UNAVAILABLE');
    const target=BigInt(profile.allocationSharesRaw)>s.sharesRaw?BigInt(profile.allocationSharesRaw)-s.sharesRaw:0n;
    const targetSharesRaw=target<s.roomRaw?target:s.roomRaw;
    if(targetSharesRaw<=0n) throw fault('ALLOCATION_FULL');
    const solved=await solveAllocation({quoteBuy,blockTag:s.block,snapshotAtMs:s.snapshotAtMs,targetSharesRaw,
      initialGrossRaw:BigInt(profile.quoteHintRaw),maxGrossRaw:BigInt(profile.quoteSearchMaxRaw),availableBalanceRaw:s.balanceRaw,
      maxCalls:8,maxAgeMs:10000,maxShortfallRaw:1000000000n,now:clock,signal});
    const p=await probe('buyPlanProbe',[solved.grossRaw,profile.buySlippageBps],s.block);
    if(p.RULES_OK!=='1'||BigInt(p.BLOCK)!==BigInt(s.block)||amount(p.BUY_SHARES)!==solved.sharesRaw) throw fault('BUY_PLAN_MISMATCH');
    const minSharesRaw=amount(p.MIN_SHARES);
    if(minSharesRaw>solved.sharesRaw||minSharesRaw<solved.sharesRaw*BigInt(10000-profile.buySlippageBps)/10000n) throw fault('MINIMUM_MISMATCH');
    return {...solved,minSharesRaw,kind:'buy'};
  }
  async function sellPlan(s) {
    if(s.phase!==1||s.sharesRaw===0n) throw fault('NO_SELLABLE_SHARES');
    const p=await probe('sellPlanCustomProbe',[10000,profile.sellSlippageBps],s.block);
    if(amount(p.SHARES)!==s.sharesRaw||BigInt(p.BLOCK)!==BigInt(s.block)||amount(p.MIN_RAW)>amount(p.OUT_RAW)||amount(p.MIN_RAW)<amount(p.OUT_RAW)*BigInt(10000-profile.sellSlippageBps)/10000n) throw fault('SELL_PLAN_MISMATCH');
    return {kind:'sell',sharesRaw:amount(p.SHARES),expectedOutRaw:amount(p.OUT_RAW),minOutRaw:amount(p.MIN_RAW),blockTag:s.block};
  }
  async function claimPlan(s) {
    if(s.phase!==3||!s.claimOk||/^0x0{40}$/i.test(s.token)) throw fault('CLAIM_UNAVAILABLE');
    const [p,route]=await Promise.all([probe('claimableProbe',[],s.block),probe('launchRouteProbe',[],s.block)]);
    if(amount(p.CLAIM_RAW)<=0n||p.STATE!=='READY'||p.PHASE!=='3'||route.PHASE!=='3'||!same(route.TOKEN,s.token)||!same(s.statusToken,s.token)) throw fault('CLAIM_STATE_REVIEW_REQUIRED',{state:p.STATE});
    return {kind:'claim',claimRaw:amount(p.CLAIM_RAW),token:s.token,blockTag:s.block};
  }
  async function verifySelection(market,token){
    if(!same(market,profile.market)||!/^0x[\da-f]{40}$/i.test(token)||/^0x0{40}$/i.test(token))throw fault('PAGE_MARKET_MISMATCH');
    const values=await rpc.batch(['predictedToken','token'].map(n=>call(profile.market,viewAbi,n,[],'latest')));
    if(!values.some((row,i)=>same(viewAbi.decodeFunctionResult(i===0?'predictedToken':'token',unwrap(row))[0],token)))throw fault('PAGE_MARKET_MISMATCH');
  }
  return {rpc,snapshot,buyPlan,sellPlan,claimPlan,probe,verifySelection};
}
