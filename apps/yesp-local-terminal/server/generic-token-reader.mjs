import {Interface,formatUnits} from 'ethers';
import {createPanelChain,safeText} from './panel-chain.mjs';
import {fault} from './flap-reader.mjs';
import {ZERO,tokenAddress} from './four-reader.mjs';
const abi=new Interface(['function name() view returns(string)','function totalSupply() view returns(uint256)']);
// Chain metadata is not proof of an executable market. Every order still needs
// a fresh wallet aggregator quote and the normal identity/balance checks.
export function createGenericTokenReader({rpc,clock=Date.now}){
 const c=createPanelChain(rpc,clock);
 async function inspect(address){const token=tokenAddress(address),h=await c.head(),code=await rpc('eth_getCode',[token,h.block]);
  if(!/^0x(?:[\da-f]{2})+$/i.test(code))throw fault('TOKEN_NOT_CONTRACT');
  let base,supply,name;try{[base,[supply],[name]]=await Promise.all([c.asset(token,h.block),c.call(token,abi,'totalSupply',[],h.block),c.call(token,abi,'name',[],h.block)]);}catch(e){if(['RPC_UNAVAILABLE','RPC_INVALID_RESPONSE','WRONG_NETWORK','STALE_BLOCK','TOKEN_DECIMALS_UNSUPPORTED'].includes(e.code))throw e;throw fault('TOKEN_METADATA_UNAVAILABLE');}
  if(supply<=0n)throw fault('TOKEN_SUPPLY_INVALID');
  return {chainId:'56',platform:'通用 Swap',protocol:'dex-swap',originProtocol:'generic-erc20',tokenAddress:token,manager:ZERO,base,quote:{address:ZERO,symbol:'BNB',decimals:18},name:safeText(name)||base.symbol,
   block:h.block,snapshotAtMs:h.at,phase:null,phaseLabel:'通用路由 · 待核对报价',positionKind:'代币余额',supported:true,blockers:[],routeStatus:'quote-required',totalSupply:formatUnits(supply,base.decimals),
   limitType:'按实际余额与可用路由报价；未知发行平台的内盘限额未核验'};
 }
 return {inspect};
}
