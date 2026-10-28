import {Interface,formatUnits} from 'ethers';
import {createFlapRpc,fault,same} from './flap-reader.mjs';
import {tokenAddress,ZERO} from './four-reader.mjs';
// Public addresses and ABI from flap.sh's agent-bonding-curve component,
// v20261023134909522_agent-bonding-curve_8b26639fea52 (read 2026-10-25).
export const FLAP_MARKET={factory:'0xC55820f24015bE7c4f18949D9e1363A3609B300e',portal:'0x49387D2E6cbF8FefE856e3FBc3E98a01aC3af062',reader:'0x18Aa6C93f1887a243fdc348C9A77F5136555174a'};
export const marketViewAbi=new Interface(['function factory() view returns(address)','function portal() view returns(address)',
  'function isMarket(address) view returns(bool)','function token() view returns(address)','function predictedToken() view returns(address)',
  'function marketCards(address[] markets) view returns((address market,address quoteToken,string name,string symbol,string meta,address predictedToken,address token,address pair,uint8 phase,uint256 poolRaw,uint256 capRaw,uint256 progressBps,uint256 buyCount,uint256 sellCount,uint256 curveH,uint256 curveK)[] cards)',
  'function symbol() view returns(string)','function decimals() view returns(uint8)']);
export function validateFlapInspect(params){
  if(!params||typeof params!=='object'||Array.isArray(params)||params.profile!=='heyi'||Object.keys(params).some(k=>!['profile','marketAddress','tokenAddress'].includes(k)))throw fault('INVALID_REQUEST');
  tokenAddress(params.marketAddress);tokenAddress(params.tokenAddress);return params;
}
export function createFlapMarketReader({rpc=createFlapRpc({timeoutMs:10000}),clock=Date.now,deployment=FLAP_MARKET}={}){
  async function call(to,name,args,block){return marketViewAbi.decodeFunctionResult(name,await rpc('eth_call',[{to,data:marketViewAbi.encodeFunctionData(name,args)},block]));}
  async function inspect(params){
    validateFlapInspect(params);const market=tokenAddress(params.marketAddress),hint=tokenAddress(params.tokenAddress);
    if(BigInt(await rpc('eth_chainId',[]))!==56n)throw fault('CHAIN_MISMATCH');
    const block=await rpc('eth_blockNumber',[]),header=await rpc('eth_getBlockByNumber',[block,false]),time=Number(BigInt(header?.timestamp||0))*1000;
    if(header?.number!==block||clock()-time>30000||time-clock()>5000)throw fault('STALE_BLOCK');
    const [portalFactory,readerFactory,registered,boundPortal,cards,token,predicted]=await Promise.all([
      call(deployment.portal,'factory',[],block),call(deployment.reader,'factory',[],block),call(deployment.factory,'isMarket',[market],block),
      call(market,'portal',[],block),call(deployment.reader,'marketCards',[[market]],block),call(market,'token',[],block),call(market,'predictedToken',[],block)]);
    const card=cards[0][0];
    if(!same(portalFactory[0],deployment.factory)||!same(readerFactory[0],deployment.factory)||!registered[0]||!same(boundPortal[0],deployment.portal)
      ||cards[0].length!==1||!same(card.market,market)||!same(card.token,token[0])||!same(card.predictedToken,predicted[0])
      ||!same(hint,card.predictedToken)&&!same(hint,card.token))throw fault('PAGE_MARKET_MISMATCH');
    const native=same(card.quoteToken,ZERO),quote=tokenAddress(native?'0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE':card.quoteToken);
    let decimals=18,symbol='BNB';
    if(!native){const [d,s]=await Promise.all([call(quote,'decimals',[],block),call(quote,'symbol',[],block)]);decimals=Number(d[0]);symbol=String(s[0]).slice(0,64);}
    if(decimals>36)throw fault('TOKEN_DECIMALS_UNSUPPORTED');
    return {market:{marketAddress:market,tokenAddress:token[0],predictedToken:predicted[0],name:card.name.slice(0,100),symbol:card.symbol.slice(0,64),phase:Number(card.phase),
      quote:card.quoteToken,quoteSymbol:symbol,pool:formatUnits(card.poolRaw,decimals),cap:formatUnits(card.capRaw,decimals),block,verifiedAt:clock(),chainId:'56'}};
  }
  return {inspect};
}
