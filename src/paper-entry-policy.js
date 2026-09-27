// Experimental paper entry gates, not a profitability claim or execution grant.
export const PAPER_ENTRY_POLICY_VERSION = 'paper_exploration_v2';
export const LEGACY_PAPER_ENTRY_POLICY_VERSION = 'paper_exploration_v1';
export const EXPLORATORY_FLOW = Object.freeze({ minBuyers: 1, minHighProfit: 0, minSmartMoney: 1, minNetBuy: 200 });

export function exploratoryEntryPolicy(strategyId, version = PAPER_ENTRY_POLICY_VERSION) {
  const early = ['internal', 'launch_sniper'].includes(strategyId);
  if (version === LEGACY_PAPER_ENTRY_POLICY_VERSION) return {
    entryUsd: 2, minBuyers: 2, minHighProfit: 0, minSmartMoney: 1,
    minNetBuy: early ? 250 : 500, minLiquidity: early ? 10_000 : 25_000,
  };
  if (version !== PAPER_ENTRY_POLICY_VERSION) throw new TypeError('unknown paper entry policy');
  return { entryUsd: 2, ...EXPLORATORY_FLOW, minLiquidity: early ? 5_000 : 10_000 };
}

export function meetsPaperEntryFlow(flow, policy) {
  return [['highProfitCount', 'minHighProfit'], ['uniqueBuyerCount', 'minBuyers'],
    ['netBuyUsd', 'minNetBuy'], ['smartMoneyCount', 'minSmartMoney']]
    .every(([metric, minimum]) => Number.isFinite(flow?.[metric]) && Number.isFinite(policy?.[minimum]) && flow[metric] >= policy[minimum]);
}
