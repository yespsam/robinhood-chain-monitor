import {Interface,formatUnits} from 'ethers';
import {createFlapRpc,fault,same} from './flap-reader.mjs';
import {createPanelChain,safeText} from './panel-chain.mjs';
import {batchedRpc} from './batched-rpc.mjs';
import {OPENFOUR,moduleAbi} from './openfour-reader.mjs';
import {coreAbi} from './openfour-abi.mjs';
import {ZERO,tokenAddress} from './four-reader.mjs';
import {FLAP_MARKET} from './flap-market.mjs';
import {agentAbi} from './flap-agent-reader.mjs';
import {createGangDetails} from './gang-details.mjs';
export const scanTokenAbi=new Interface(['function tokenURI() view returns(string)',...['buyFeeRate','sellFeeRate','rateFounder','rateHolder','rateBurn','rateLiquidity','minShare','feeHolder','feeClaimed','totalTaxCollected','totalManualRewards'].map(n=>`function ${n}() view returns(uint256)`)]);
const percent=(n,denominator=100)=>Number(n)/denominator;
const phaseName=p=>['待开盘','内盘交易','待迁移','已毕业','已终止','已售罄'][Number(p)]||'状态待确认';
export function createScanReader({rpc=batchedRpc(createFlapRpc({url:process.env.YESP_RPC_URL||'https://bsc-dataseed.bnbchain.org',timeoutMs:8000}),{maxBatch:10}),clock=Date.now}={}){
 const chain=createPanelChain(rpc,clock),call=chain.call;
 const gang=createGangDetails({rpc,clock});
 async function four(row){const {block,at}=await chain.head(),ca=tokenAddress(row.tokenAddress),cfg=await call(OPENFOUR.core,coreAbi,'tokens',[ca],block);
  if(!cfg.exists||!same(cfg.token,ca)||String(cfg.presetId)!==OPENFOUR.presetId)throw fault('SCAN_INFO_BINDING');
  const [tag,base,quote,phase,raised,remaining,uri,...values]=await Promise.all([
   call(ca,moduleAbi,'descriptor',[],block),chain.asset(ca,block),chain.asset(cfg.quoteAsset,block),call(cfg.vault,moduleAbi,'phase',[],block),call(cfg.vault,moduleAbi,'totalRaised',[],block),call(cfg.vault,moduleAbi,'remainingForSale',[],block),call(ca,scanTokenAbi,'tokenURI',[],block).catch(()=>['']),
   ...['buyFeeRate','sellFeeRate','rateFounder','rateHolder','rateBurn','rateLiquidity','minShare','feeHolder','feeClaimed','totalTaxCollected','totalManualRewards'].map(n=>call(ca,scanTokenAbi,n,[],block).then(r=>r[0]).catch(()=>null))]);
  if(tag.tag!=='token.tax.binance_agent'||tag.version!=='1')throw fault('SCAN_INFO_UNSUPPORTED');
  const [buy,sell,founder,holder,burn,liquidity,minShare,allocated,claimed,collected,manual]=values;
  if([buy,sell,founder,holder,burn,liquidity].some(v=>v===null)||buy>1000n||sell>1000n||founder+holder+burn+liquidity!==100n&&(buy>0n||sell>0n))throw fault('SCAN_TAX_UNVERIFIED');
  const display=v=>v===null?null:formatUnits(v,quote.decimals);
  const progress=cfg.saleAmount>0n?(cfg.saleAmount-remaining[0])*10000n/cfg.saleAmount:0n;
  return {chainUpdatedAt:clock(),snapshotAt:at,snapshotBlock:Number(BigInt(block)),creator:cfg.creator,quote,phase:Number(phase[0]),phaseLabel:phaseName(phase[0]),metadataRef:uri[0],
   pool:formatUnits(raised[0],quote.decimals),cap:formatUnits(cfg.raiseAmount,quote.decimals),progressBps:String(progress<0n?0n:progress>10000n?10000n:progress),
   totalSupply:formatUnits(cfg.maxSupply,base.decimals),maxWallet:formatUnits(cfg.maxSupply/100n,base.decimals),baseSymbol:base.symbol,
   dividends:{status:holder>0n?'enabled':'disabled',allocationPercent:percent(holder,1),buyTaxPercent:percent(buy),sellTaxPercent:percent(sell),asset:quote.symbol,assetAddress:quote.address,
    allocationLabel:'税费分配权重',splits:[['创建者',founder],['持有人',holder],['销毁',burn],['流动性',liquidity]].map(([label,n])=>({label,percent:percent(n,1)})),
    minHolding:minShare===null?null:formatUnits(minShare,base.decimals),allocated:display(allocated),claimed:display(claimed),totalTax:display(collected),manualRewards:display(manual),
    note:holder>0n?'持币达到门槛后按有效份额累计；实际分配按活跃权重归一化，等待合约派发。':'持有人分红权重为 0。',sourceUrl:'https://github.com/four-meme-community/openfour-docs/blob/main/docs/mechanisms/binance-agent-id-exclusive.md'}};
 }
 async function flap(row){const {block,at}=await chain.head(),market=tokenAddress(row.marketAddress),ca=tokenAddress(row.tokenAddress);
  const [[registered],[factory],[d],[s]]=await Promise.all([call(FLAP_MARKET.factory,agentAbi,'isMarket',[market],block),call(FLAP_MARKET.reader,agentAbi,'factory',[],block),call(FLAP_MARKET.reader,agentAbi,'marketDetail',[market],block),call(FLAP_MARKET.reader,agentAbi,'marketSettings',[market],block)]);
  if(!registered||!same(factory,FLAP_MARKET.factory)||!same(d.market,market)||!same(d.predictedToken,ca)&&!same(d.token,ca)||!same(d.quoteToken,s.quoteToken)||d.quoteDecimals!==s.quoteDecimals)throw fault('SCAN_INFO_BINDING');
  const c=s.launch,quote=await chain.asset(d.quoteToken,block);if(quote.decimals!==Number(d.quoteDecimals)||c.buyTaxRate>1000n||c.sellTaxRate>1000n||c.mktBps+c.deflationBps+c.dividendBps+c.lpBps!==10000n)throw fault('SCAN_TAX_UNVERIFIED');
  return {chainUpdatedAt:clock(),snapshotAt:at,snapshotBlock:Number(BigInt(block)),creator:d.creator,quote,metadataRef:c.meta,phase:Number(d.phase),phaseLabel:Number(d.phase)===1?'Agent 虚拟份额':Number(d.phase)===2?'毕业处理中':'已毕业',
   pool:formatUnits(d.poolRaw,quote.decimals),cap:formatUnits(d.capRaw,quote.decimals),progressBps:String(d.progressBps),maxWallet:formatUnits(d.maxWalletShares,18),baseSymbol:row.symbol,
   holderCount:d.holderCount.toString(),statsComplete:d.statsComplete,buyCount:d.buyCount.toString(),sellCount:d.sellCount.toString(),
   dividends:{status:c.dividendBps>0n?'configured':'disabled',allocationPercent:percent(c.dividendBps),buyTaxPercent:percent(c.buyTaxRate),sellTaxPercent:percent(c.sellTaxRate),agentFeePercent:percent(d.agentFeeBps),asset:null,
    allocationLabel:'发行配置分配比例',splits:[['市场资金',c.mktBps],['持有人',c.dividendBps],['销毁',c.deflationBps],['流动性',c.lpBps]].map(([label,n])=>({label,percent:percent(n)})),
    minHolding:null,allocated:null,claimed:null,totalTax:null,manualRewards:null,
    note:Number(d.phase)<3?'这是毕业发行配置；当前持仓为虚拟份额，不把配置当作已到账分红。':'发行配置已读取；实际分红资产、门槛和派发金额尚未核验。',sourceUrl:'https://flap.sh/apps/agent-bonding-curve?lang=zh'}};
 }
 return async row=>{if(row.platform==='Gang')return gang(row);if(row.platform==='Four.meme')return four(row);if(row.platform==='Flap'&&row.marketAddress)return flap(row);throw fault('SCAN_INFO_UNSUPPORTED');};
}
