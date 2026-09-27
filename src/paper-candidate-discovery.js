import { gmgnFlowAddress } from './gmgn-flow-signal.js';
import { validBinanceFlowState, BINANCE_FLOW_KINDS } from './binance-flow-evidence.js';
import { buildPaperDualFlowEvidence } from './paper-strategy-evidence.js';

// Discovery is not an entry signal. Every candidate still needs independently
// refreshed market/security data, confirmed flow, candles and a fast quote.
export function discoverPaperFlowCandidates({ evidence, chains, nowMs, limitPerChain = 30 }) {
  const secondary = validBinanceFlowState(evidence?.binanceState) ? evidence.binanceState : null;
  return chains.flatMap(chain => {
    const addresses = new Set();
    const groups = [evidence?.flowState?.trades?.[chain] || [],
      ...BINANCE_FLOW_KINDS.map(kind => secondary?.chains?.[chain]?.feeds?.[kind]?.rows || [])];
    for (const rows of groups) for (const row of rows) {
      const address = gmgnFlowAddress(chain, row?.tokenAddress);
      if (row?.chain === chain && address && row.side === 'buy' && Number.isFinite(row.at)
        && row.at >= nowMs - 300_000 && row.at <= nowMs) addresses.add(address);
    }
    return [...addresses].map(address => ({ token: { chain, address, symbol: address.slice(0, 8) },
      flow: buildPaperDualFlowEvidence({ state: evidence?.flowState, binanceState: secondary, chain, address, nowMs }) }))
      .filter(item => item.flow.fresh && item.flow.uniqueBuyerCount > 0 && item.flow.netBuyUsd > 0)
      .sort((a, b) => Number(b.flow.complete) - Number(a.flow.complete)
        || b.flow.highProfitCount - a.flow.highProfitCount || b.flow.uniqueBuyerCount - a.flow.uniqueBuyerCount
        || b.flow.netBuyUsd - a.flow.netBuyUsd || a.token.address.localeCompare(b.token.address))
      .slice(0, limitPerChain);
  });
}
