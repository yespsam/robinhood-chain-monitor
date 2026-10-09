// Explicitly hypothetical costs for an isolated paper experiment, never routing fees.
export const ESTIMATED_COST_VERSION = 'isolated_estimated_cost_v1';
export const ESTIMATED_GAS_USD = Object.freeze({sol:.01,bsc:.04,base:.02,eth:.5,robinhood:.02});
export const ESTIMATED_COST_TEXT = '独立估算费用模拟盘：100 U 新虚拟本金，不转入原盘资金、不合并成绩。单边平台费 1%、滑点 1%；每次 Gas 假设 SOL 0.01 / BSC 0.04 / Base 0.02 / ETH 0.50 / Robinhood 0.02 U。税率使用采集值；所有成本均为模型，非链上实付或真实路由报价。保留叙事/盈利地址证据、结构退出及亏损重入校验；原主盘仍暂停。';
export function estimatedPaperCosts(chain,buyTax,sellTax,budget) {
  const gasUsd=ESTIMATED_GAS_USD[chain]??null,feeRate=.01,slippageRate=.01;
  const notionalUsd=gasUsd===null||buyTax===null?null:Math.max(0,(budget-gasUsd)/(1+feeRate+slippageRate+buyTax));
  const roundtrip=notionalUsd===null||sellTax===null?null:budget-notionalUsd+notionalUsd*(feeRate+slippageRate+sellTax)+gasUsd;
  return {version:ESTIMATED_COST_VERSION,source:'assumption',label:ESTIMATED_COST_TEXT,accountingEligible:true,actualOnchainFee:false,
    feeBps:100,slippageBps:100,feeRate,slippageRate,gasUsd,buyTax,sellTax,notionalUsd,
    gasEvidenceReady:gasUsd!==null,estimatedRoundTripCost:roundtrip,estimatedRoundTripCostRate:roundtrip===null||budget<=0?null:roundtrip/budget};
}
