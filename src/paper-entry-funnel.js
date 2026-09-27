import { isDiagnosticPaperEntry } from './paper-diagnostic-entry.js';
import { isConfirmedPaperEntry } from './paper-confirmed-policy.js';
// Diagnostic counts only; never used to approve a trade. Every stage is a
// subset of the preceding one, deduplicated by chain + exact normalized CA.
export function paperEntryFunnel(evaluations = []) {
  let rows = evaluations;
  const count = () => new Set(rows.map(row => `${row.token.chain}:${row.token.address}`)).size;
  const result = { detected: count() };
  for (const [name, pass] of [
    ['marketFresh', row => row.evidence?.marketFresh === true],
    ['flowReady', row => row.evidence?.opportunity ? row.evidence.opportunity.signalReady === true : row.evidence?.flowFresh === true &&
      [['uniqueBuyerCount', 'minBuyers'], ['highProfitCount', 'minHighProfit'], ['smartMoneyCount', 'minSmartMoney'], ['netBuyUsd', 'minNetBuy']]
        .every(([metric, threshold]) => Number.isFinite(row.evidence.flow?.[metric]) && Number.isFinite(row.evidence.entryThresholds?.[threshold])
          && row.evidence.flow[metric] >= row.evidence.entryThresholds[threshold])],
    ['safetyReady', row => isDiagnosticPaperEntry(row.evidence) ? row.evidence.diagnostic.fillBoundariesPass === true
      : row.evidence?.safety?.missing?.length === 0 && row.evidence.safety.blocked?.length === 0],
    ['chartReady', row => isConfirmedPaperEntry(row.evidence) ? row.evidence.confirmedPolicy.confirmation.ready === true
      : isDiagnosticPaperEntry(row.evidence) || row.evidence?.chart?.ready === true],
    ['quoteFresh', row => row.evidence?.priceFresh === true],
    ['eligible', row => row.decision === '可模拟' && row.evidence?.paperEligible === true],
  ]) { rows = rows.filter(pass); result[name] = count(); }
  return result;
}
