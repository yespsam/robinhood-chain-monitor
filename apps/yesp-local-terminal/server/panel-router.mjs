import {formatUnits} from 'ethers';
import {createFlapRpc,fault,same} from './flap-reader.mjs';
import {createFourRouter} from './four-router.mjs';
import {erc20Abi,ZERO} from './four-reader.mjs';
import {createAgentReader,agentAbi} from './flap-agent-reader.mjs';
import {createStandardFlapReader,flapStandardAbi} from './flap-standard-reader.mjs';
import {reviewedFlapDeployments} from './reviewed-modes.mjs';
import {createGangReader,gangReceipt} from './gang-reader.mjs';
import {createReadScopeRpc} from './read-scope.mjs';
import {externalMarket} from './dex-swap.mjs';
import {createPanelChain} from './panel-chain.mjs';
import {createGenericTokenReader} from './generic-token-reader.mjs';
export function createPanelRouter({rpc=createFlapRpc({timeoutMs:10000}),clock=Date.now,readers}={}){
 rpc=createReadScopeRpc(rpc);
 const {four,agent,standard}=readers||{four:createFourRouter({rpc,clock}),agent:createAgentReader({rpc,clock}),standard:createStandardFlapReader({rpc,clock})};
 const gang=readers?readers.gang:createGangReader({rpc,clock});
 const generic=readers?.generic||createGenericTokenReader({rpc,clock});
 const extraAgents=new Map();
 function agents(){if(readers)return [{reader:agent}];return reviewedFlapDeployments().map((d,i)=>{if(i===0)return {factory:d.factory,reader:agent};const key=JSON.stringify(d);if(!extraAgents.has(key))extraAgents.set(key,createAgentReader({rpc,clock,deployment:d}));return {factory:d.factory,reader:extraAgents.get(key)};});}
 const agentFor=m=>{if(!m.agentFactory)return agent;const a=agents().find(a=>same(a.factory,m.agentFactory));if(!a)throw fault('MODE_DEFINITION_CHANGED');return a.reader;};
 const route=m=>m.protocol==='gang-curve'?gang:m.protocol==='flap-agent'?agentFor(m):m.protocol==='flap-standard'?standard:four;
 const hints=new Map();
 const decorate=m=>({...m,platform:'Four.meme',phaseLabel:m.protocol==='openfour-agent'?'Agent ID 专属内盘':m.liquidityAdded?'已迁移到 DEX':'Four.meme 普通内盘',positionKind:'代币余额'});
 async function readVia(address,entry){const m=await entry.reader.inspect(address);if(entry.kind==='agent'&&m.phase===3)return {...await standard.inspect(address),agentMarket:m};return entry.kind==='four'?decorate(m):m;}
 function remember(address,entry,m){hints.delete(address.toLowerCase());hints.set(address.toLowerCase(),{...entry,until:clock()+300000});while(hints.size>256)hints.delete(hints.keys().next().value);return m;}
 async function inspectRaw(address){
  const cached=hints.get(String(address).toLowerCase());
  if(cached&&clock()<cached.until&&(cached.kind!=='agent'||agents().some(a=>a.reader===cached.reader))){
   try{return await readVia(address,cached);}catch(e){if(!['NOT_GANG_TOKEN','NOT_FOUR_TOKEN','NOT_FLAP_TOKEN','NOT_FLAP_AGENT'].includes(e.code))throw e;hints.delete(address.toLowerCase());}
  }
  for(const candidate of agents())try{const a=await candidate.reader.inspect(address);
   const m=a.phase===3?{...await standard.inspect(address),agentMarket:a}:a;return remember(address,{kind:'agent',reader:candidate.reader},m);
  }catch(e){if(e.code!=='NOT_FLAP_AGENT')throw e;}
  try{return remember(address,{kind:'standard',reader:standard},await standard.inspect(address));}catch(e){if(e.code!=='NOT_FLAP_TOKEN')throw e;}
  try{return remember(address,{kind:'four',reader:four},decorate(await four.inspect(address)));}
  catch(e){if(e.code!=='NOT_FOUR_TOKEN')throw e;}
  if(gang)try{return remember(address,{kind:'gang',reader:gang},await gang.inspect(address));}catch(e){if(e.code!=='NOT_GANG_TOKEN')throw e;}
  // Generic routing never suppresses a known platform failure or invents an
  // inner-pool call. Do not cache this fallback: a new platform deployment may
  // later become recognizable while the ERC20 contract stays the same.
  return generic.inspect(address);
 }
 const inspect=async address=>externalMarket(await inspectRaw(address));
 async function holdings(m,w){let h;
  if(m.protocol==='dex-swap'){const c=createPanelChain(rpc,clock),[base,native]=await Promise.all([c.balance(m.tokenAddress,w,m.block),c.balance(ZERO,w,m.block)]);h={base:formatUnits(base,m.base.decimals),baseRaw:base.toString(),quote:formatUnits(native,18),native:formatUnits(native,18),limitType:m.limitType};}
  else h=await route(m).holdings(m,w);
  if(m.agentMarket){const a=await agentFor(m.agentMarket).holdings(m.agentMarket,w);return {...h,claimable:a.claimable,claimableRaw:a.claimableRaw};}return h;}
 async function build(p,w){const m=await inspect(p.tokenAddress);return p.action==='claim'&&m.agentMarket?agentFor(m.agentMarket).build(p,w):route(m).build({...p,...(p.action==='buy'?{buyMode:'tokenAmount'}:{})},w);}
 return {rpc,inspect,holdings,build,recheck:p=>route(p).recheck(p),receipt:(p,r)=>p.protocol==='gang-curve'?gangReceipt(p,r):flapReceipt(p,r)};
}
function events(rec,address,abi,name){return (rec.logs||[]).filter(l=>same(l.address,address)).flatMap(l=>{try{const e=abi.parseLog(l);return e?.name===name?[e.args]:[];}catch{return [];}});}
function netToken(rec,token,w){return events(rec,token,erc20Abi,'Transfer').reduce((sum,e)=>sum+(same(e.to,w)?e.value:0n)-(same(e.from,w)?e.value:0n),0n);}
export function flapReceipt(p,rec){
 const buy=p.kind==='buy';let received,actual;
 if(p.protocol==='flap-agent'){
  if(p.kind==='claim'){
   const claims=events(rec,p.marketAddress,agentAbi,'Claimed').filter(e=>same(e.wallet,p.wallet)&&(same(e.caller,p.wallet)||same(e.caller,p.portal)));
   const net=netToken(rec,p.deployedToken,p.wallet);
   if(claims.length!==1||claims[0].amount!==BigInt(p.amountRaw)||net<=0n||net>claims[0].amount)throw fault('CLAIM_SETTLEMENT_MISMATCH');
   return {receivedAmount:formatUnits(net,p.base.decimals),message:`领取已确认，实际收到 ${formatUnits(net,p.base.decimals)} ${p.base.symbol}。`};
  }
  const matches=events(rec,p.marketAddress,agentAbi,'VirtualTrade').filter(e=>same(e.wallet,p.wallet));if(matches.length!==1)throw fault('TRADE_EVENT_MISSING');const e=matches[0];
  if(e.side!==(buy?0n:1n)||e.shares<=0n||buy&&(e.shares<BigInt(p.minimumRaw)||e.quoteSubmitted!==BigInt(p.spendRaw)||e.quoteUser+e.refund!==e.quoteSubmitted)
   ||!buy&&(e.shares!==BigInt(p.amountRaw)||e.quoteUser<BigInt(p.minimumRaw)))throw fault('TRADE_SETTLEMENT_MISMATCH');
  if(!same(p.quote.address,ZERO)&&netToken(rec,p.quote.address,p.wallet)!==(buy?-e.quoteUser:e.quoteUser))throw fault('TRADE_SETTLEMENT_MISMATCH');
  received=buy?e.shares:e.quoteUser;actual=e.shares;
 }else if(p.protocol==='flap-standard'){
  const matches=events(rec,p.manager,flapStandardAbi,buy?'TokenBought':'TokenSold').filter(e=>same(e.token,p.tokenAddress)&&same(buy?e.buyer:e.seller,p.wallet));
  if(matches.length!==1)throw fault('TRADE_EVENT_MISSING');const e=matches[0],baseNet=netToken(rec,p.tokenAddress,p.wallet);
  if(buy){received=baseNet;if(received<BigInt(p.minimumRaw)||e.eth>BigInt(p.spendRaw)||received<=0n)throw fault('TRADE_SETTLEMENT_MISMATCH');}
  else{if(baseNet!==-BigInt(p.amountRaw)||e.amount<=0n||e.amount>BigInt(p.amountRaw))throw fault('TRADE_SETTLEMENT_MISMATCH');
   // Official TokenSold.eth is the received quote amount; fee is already deducted.
   received=same(p.quote.address,ZERO)?e.eth:netToken(rec,p.quote.address,p.wallet);if(received<BigInt(p.minimumRaw))throw fault('TRADE_SETTLEMENT_MISMATCH');}
  actual=buy?received:-baseNet;
 }else throw fault('UNSUPPORTED_PROTOCOL');
 return {receivedAmount:formatUnits(received,buy?p.base.decimals:p.quote.decimals),executedTokenAmount:formatUnits(actual,p.base.decimals),
  message:`${buy?'买入':'卖出'}已确认，收到 ${formatUnits(received,buy?p.base.decimals:p.quote.decimals)} ${buy?p.base.symbol:p.quote.symbol}。`};
}
