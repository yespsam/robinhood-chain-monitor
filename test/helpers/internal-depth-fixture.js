import {Interface,parseUnits,ZeroAddress} from 'ethers';
import {FOUR_HELPER,BNB_ORACLE,INTERNAL_DEPTH_VERSION} from '../../src/paper-internal-depth.js';
import {FLAP_DEPTH_ABI,FLAP_DEPTH_PORTAL,FLAP_DEPTH_VERSION,FLAP_QUOTE_DEPTH_VERSION} from '../../src/paper-internal-depth.js';
import {FLAP_PORTAL_VERIFIED_VERSION} from '../../src/flap-portal-pins.js';
export const depthAbi=new Interface([
  'function getTokenInfo(address) view returns(uint256,address,address,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,bool)',
  'function tryBuy(address,uint256,uint256) view returns(address,address,uint256,uint256,uint256,uint256,uint256,uint256)',
  'function trySell(address,uint256) view returns(address,address,uint256,uint256)',
  'function decimals() view returns(uint8)',
  'function latestRoundData() view returns(uint80,int256,uint256,uint256,uint80)',
]);
const units=n=>parseUnits(n.toFixed(18),18),manager='0x5c952063c7fc8610ffdb798152d69f0b9550762b';
export function depthFixture(token,budgetUsd,notionalUsd,nowMs) {
  const amount=units(notionalUsd/token.price)/1000000000n*1000000000n,small=amount/10n/1000000000n*1000000000n;
  const cost=q=>units(Number(q)/1e18*token.price/1000);
  const buy=q=>depthAbi.encodeFunctionResult('tryBuy',[manager,ZeroAddress,q,cost(q),cost(q)/100n,cost(q)*101n/100n,0,0]);
  return {version:INTERNAL_DEPTH_VERSION,chain:'bsc',chainId:56,address:token.address,helper:FOUR_HELPER,oracle:BNB_ORACLE,
    budgetUsd,notionalUsd,referencePrice:token.price,referenceAt:new Date(nowMs).toISOString(),observedAt:new Date(nowMs).toISOString(),
    block:{number:12345,hash:'0x'+'c'.repeat(64),timestamp:nowMs/1000},endBlockHash:'0x'+'c'.repeat(64),
    amount:amount.toString(),smallAmount:small.toString(),raw:{
      info:depthAbi.encodeFunctionResult('getTokenInfo',[2,manager,ZeroAddress,1,100,1,nowMs/1000-60,units(10000),units(20000),units(100),units(1000),false]),
      decimals:depthAbi.encodeFunctionResult('decimals',[18]),oracleDecimals:depthAbi.encodeFunctionResult('decimals',[8]),
      oracle:depthAbi.encodeFunctionResult('latestRoundData',[1,100000000000n,nowMs/1000-30,nowMs/1000-30,1]),
      buy:buy(amount),smallBuy:buy(small),sell:depthAbi.encodeFunctionResult('trySell',[manager,ZeroAddress,cost(amount)*99n/100n,cost(amount)/100n]),
    }};
}
export function flapDepthFixture(token,budgetUsd,notionalUsd,nowMs) {
  const p=depthFixture(token,budgetUsd,notionalUsd,nowMs),amount=units(notionalUsd/1000),small=amount/10n;
  const quote=n=>FLAP_DEPTH_ABI.encodeFunctionResult('quoteExactInput',[n]);
  return {...p,version:FLAP_DEPTH_VERSION,helper:FLAP_DEPTH_PORTAL,amount:amount.toString(),smallAmount:small.toString(),raw:{
    ...p.raw,info:FLAP_DEPTH_ABI.encodeFunctionResult('getTokenV8Safe',[[1,units(100),units(10000),1,7,1,1,1,units(100000),ZeroAddress,false,'0x'+'0'.repeat(64),0,0,ZeroAddress,1,0,0]]),
    portalVersion:FLAP_DEPTH_ABI.encodeFunctionResult('version',[FLAP_PORTAL_VERIFIED_VERSION]),
    buy:quote(units(notionalUsd/token.price*.99)),smallBuy:quote(units(notionalUsd/token.price*.099)),sell:quote(amount*98n/100n),
  }};
}

export function flapQuoteDepthFixture(token,budgetUsd,notionalUsd,nowMs) {
  const p=flapDepthFixture(token,budgetUsd,notionalUsd,nowMs),quoteAddress='0x'+'b'.repeat(40);
  const state=[...FLAP_DEPTH_ABI.decodeFunctionResult('getTokenV8Safe',p.raw.info)[0]];
  state[9]=quoteAddress;state[10]=true;
  state[1]=100000000n; // 100 units of a 6-decimal quote asset, NOT 18-decimal BNB
  return {...p,version:FLAP_QUOTE_DEPTH_VERSION,quoteAddress,raw:{...p.raw,
    info:FLAP_DEPTH_ABI.encodeFunctionResult('getTokenV8Safe',[state]),
    quoteDecimals:depthAbi.encodeFunctionResult('decimals',[6]),
    quoteConfig:FLAP_DEPTH_ABI.encodeFunctionResult('getQuoteTokenConfiguration',[[1,7,7,2,0]]),
    quoteSell:FLAP_DEPTH_ABI.encodeFunctionResult('quoteExactInput',[9500000n]),
  }};
}
