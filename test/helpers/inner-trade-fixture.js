import {parseUnits,ZeroAddress} from 'ethers';
import {INNER_TRADE_VERSION,INNER_TRADE_ORACLE,INNER_TRADE_ORACLE_ABI,INNER_TRADE_ERC20_ABI,
  INNER_TRADE_EMITTERS} from '../../src/bsc-inner-trade-events.js';
import {FLAP_PORTAL_VERIFIED_VERSION} from '../../src/flap-portal-pins.js';

export const INNER_TRADE_TEST_NOW=1791417900000;
export const INNER_TRADE_TEST_CA='0x'+'a'.repeat(40);
export const INNER_TRADE_TEST_WALLET='0x'+'c'.repeat(40);
export const innerTradeTestHash=n=>'0x'+n.toString(16).padStart(64,'0');
const h=innerTradeTestHash,u=n=>parseUnits(String(n),18);

export function buildInnerTradeFixture(platform='four_v2',nowMs=INNER_TRADE_TEST_NOW) {
  const spec=INNER_TRADE_EMITTERS[platform],fromBlock={number:100,hash:h(100),parentHash:h(99),timestamp:nowMs/1000-100};
  const toBlock={number:200,hash:h(200),parentHash:h(199),timestamp:nowMs/1000-2};
  const middle={number:175,hash:h(175),parentHash:h(174),timestamp:nowMs/1000-20};
  const raw={decimals:INNER_TRADE_ERC20_ABI.encodeFunctionResult('decimals',[18])};
  if(platform==='four_v2')raw.info=spec.metadataAbi.encodeFunctionResult('getTokenInfo',[2,spec.address,ZeroAddress,1,100,1,fromBlock.timestamp-100,u(100000),u(200000),u(10),u(100),false]);
  else {
    raw.info=spec.metadataAbi.encodeFunctionResult('getTokenV8Safe',[[1,u(10),u(100),1,7,1,1,1,u(100000),ZeroAddress,false,h(0),0,0,ZeroAddress,1,0,0]]);
    raw.portalVersion=spec.metadataAbi.encodeFunctionResult('version',[FLAP_PORTAL_VERIFIED_VERSION]);
  }
  const proof={version:INNER_TRADE_VERSION,chain:'bsc',chainId:56,platform,contract:spec.address,tokenAddress:INNER_TRADE_TEST_CA,
    observedAt:new Date(nowMs).toISOString(),fromBlock,toBlock,endBlockHash:toBlock.hash,
    range:{fromBlock:100,toBlock:200,complete:true,truncated:false},segments:[{fromBlock:100,toBlock:200,startHash:h(100),endHash:h(200),startParentHash:h(99)}],
    blocks:[fromBlock,middle,toBlock],logs:[],metadata:{blockNumber:200,blockHash:h(200),tokenAddress:INNER_TRADE_TEST_CA,source:spec.metadataSource,raw},
    oracle:{address:INNER_TRADE_ORACLE,blockNumber:200,blockHash:h(200),raw:{decimals:INNER_TRADE_ERC20_ABI.encodeFunctionResult('decimals',[8]),
      latestRoundData:INNER_TRADE_ORACLE_ABI.encodeFunctionResult('latestRoundData',[1,100000000000n,toBlock.timestamp-30,toBlock.timestamp-30,1])}}};
  proof.logs=[buildInnerTradeLog(proof,'buy',middle,0),buildInnerTradeLog(proof,'sell',toBlock,1)];
  return proof;
}

// index is block-global logIndex; tx is a numeric fixture hash seed. Passing
// the same tx for different indices models multiple events in one transaction.
export function buildInnerTradeLog(p,side,b,index,token=INNER_TRADE_TEST_CA,tx=300+index,
  {wallet=INNER_TRADE_TEST_WALLET,baseAmount=1000,quoteAmount=1,fee=.01,transactionIndex=index}={}) {
  const spec=INNER_TRADE_EMITTERS[p.platform],name=p.platform==='flap'?(side==='buy'?'TokenBought':'TokenSold'):(side==='buy'?'TokenPurchase':'TokenSale');
  const values=p.platform==='flap'?[b.timestamp,token,wallet,u(baseAmount),u(quoteAmount),u(fee),1]
    :[token,wallet,1,u(baseAmount),u(quoteAmount),u(fee),u(999000),u(100)];
  return {...spec.abi.encodeEventLog(spec.abi.getEvent(name),values),address:spec.address,blockNumber:b.number,blockHash:b.hash,
    transactionHash:h(tx),transactionIndex,logIndex:index,removed:false};
}
