import {formatUnits} from 'ethers';
import {createGangReader,gangAbi} from './gang-reader.mjs';
import {createPanelChain} from './panel-chain.mjs';
import {readGangBuyback} from './gang-buyback.mjs';
export function createGangDetails({rpc,clock=Date.now}){const reader=createGangReader({rpc,clock}),c=createPanelChain(rpc,clock);
 return async row=>{const m=await reader.inspect(row.tokenAddress),legacyTax=m.taxed&&!['v2','v3'].includes(m.variant),configured=m.taxed&&!legacyTax&&m.phase!==3;
  let minHolding=null;if(m.taxed&&(m.variant!=='v3'||m.taxConfig.dividendBps>0))minHolding=formatUnits((await c.call(m.manager,gangAbi(m),'TAXED_MIN_SHARE',[],m.block))[0],18);
  const buyback=await readGangBuyback(c,m);
  return {chainUpdatedAt:clock(),snapshotAt:m.snapshotAtMs,snapshotBlock:Number(BigInt(m.block)),creator:m.creator,quote:m.quote,phase:m.phase,phaseLabel:m.phaseLabel,
   metadataRef:m.logoURI||row.metadataRef||'',metadataKind:'image',pool:formatUnits(m.reserveRaw,m.quote.decimals),cap:formatUnits(m.gradRaw,m.quote.decimals),progressBps:m.progressBps,
   totalSupply:'1000000000',maxWallet:m.walletCap?formatUnits(m.maxBuyRaw,18):null,baseSymbol:m.base.symbol,buyback,
   dividends:m.variant==='v3'?{status:m.taxConfig.dividendBps>0?(m.phase===3?'enabled':'configured'):'disabled',allocationPercent:m.taxConfig.dividendBps/100,
    buyTaxPercent:m.taxConfig.buyTaxBps/100,sellTaxPercent:m.taxConfig.sellTaxBps/100,agentFeePercent:m.phase===3?0:1,
    asset:m.quote.symbol,assetAddress:m.quote.address,minHolding,allocated:null,claimed:null,totalTax:null,manualRewards:null,
    allocationLabel:'扣除平台税后的剩余税费分配',splits:[{label:'持有人',percent:m.taxConfig.dividendBps/100},{label:'税费接收方',percent:100-m.taxConfig.dividendBps/100}],
    note:'V3 内盘只收 1% 协议费；买卖税在毕业后收取，其中平台收交易额的 0.5%，剩余税费再按配置分配。'+(buyback?.status==='configured'?`接收方所得的 ${buyback.buybackPercent}% 配置用于回购销毁，比例不是交易额占比；执行依赖外盘与 keeper。`:''),sourceUrl:'https://github.com/gangfun/gang-launchpad'}:
   {status:m.taxed?(configured?'configured':'enabled'):'disabled',allocationPercent:m.taxed?50:0,buyTaxPercent:m.taxed&&m.phase===3?1:0,sellTaxPercent:m.taxed&&m.phase===3?1:0,agentFeePercent:m.phase===3?0:1,
    asset:m.quote.symbol,assetAddress:m.quote.address,minHolding,allocated:null,claimed:null,totalTax:null,manualRewards:null,
    allocationLabel:configured?'毕业后税费分配配置':'税费分配比例',splits:m.taxed?[{label:'持有人',percent:50},{label:'平台回购及费用',percent:50}]:[{label:'平台回购及费用',percent:100}],
    note:configured?'V2 内盘只收 1% 平台费用，不产生持有人分红；毕业后交易税由 keeper 处理，再按有效份额分配。':legacyTax?'旧 U/S 内盘费用包含持有人分配；实际到账需以分红合约为准。':m.taxed?'毕业后交易税经 keeper 处理，按有效份额累计；未核验金额不会显示为已到账。':'未配置持币分红。',
    sourceUrl:'https://github.com/gangfun/gang-launchpad'}};
 };
}
