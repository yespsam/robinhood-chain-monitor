import { gmgnFlowAddress, gmgnFlowTags } from './gmgn-flow-signal.js';

export const PROFIT_LEADERBOARD_SCHEMA = 'yesp_token_profit_leaders_v1';
export const PROFIT_LEADERBOARD_SOURCE = 'gmgn_token_profit_leaderboard';
const number = value => ['number', 'string'].includes(typeof value) && String(value).trim() && Number.isFinite(Number(value)) ? Number(value) : null;
const blocked = /(?:^|[_-])(?:dev|bundler|rat_trader|wash(?:_trader)?|arbitrag\w*|mev(?:_bot)?|sandwich|router|exchange|contract)(?:$|[_-])/i;
const stamp = value => Date.parse(value || '');

export function parseProfitLeaderboard(payload, { chain, address, observedAt }) {
  const token = gmgnFlowAddress(chain, address), data = payload?.data ?? payload;
  if (!token || !Number.isFinite(stamp(observedAt)) || !payload || payload.success === false || payload.error
    || payload.code != null && ![0, 200].includes(Number(payload.code)) || !Array.isArray(data?.list) || data.list.length > 100) throw new Error('leaderboard_response_invalid');
  for (const envelope of [payload, data]) {
    if (envelope.chain != null && envelope.chain !== chain || envelope.token_address != null && gmgnFlowAddress(chain, envelope.token_address) !== token) throw new Error('leaderboard_identity_invalid');
  }
  const entries = new Map(); let omitted = 0;
  for (const [index, row] of data.list.entries()) {
    const wallet = gmgnFlowAddress(chain, row?.address), realizedProfitUsd = number(row?.realized_profit);
    if (!wallet || row.chain != null && row.chain !== chain || realizedProfitUsd === null || realizedProfitUsd <= 0) { omitted++; continue; }
    const tags = gmgnFlowTags([...(Array.isArray(row.tags) ? row.tags : []), ...(Array.isArray(row.maker_token_tags) ? row.maker_token_tags : [])]);
    const issues = [];
    if (number(row.addr_type) !== 0) issues.push('wallet_type_unverified');
    if (row.is_suspicious !== false) issues.push('suspicion_not_cleared');
    if (tags.some(tag => blocked.test(tag))) issues.push('excluded_wallet_tags');
    const transfers = ['history_transfer_in_amount', 'history_transfer_out_amount'].map(field => number(row[field]));
    if (row.transfer_in === true || transfers.some(value => value > 0)) issues.push('transfer_attribution');
    else if (transfers.some(value => value === null)) issues.push('transfer_history_unknown');
    const source = { chain, tokenAddress: token, sourceRank: index + 1, observedAt,
      realizedProfitUsd, unrealizedProfitUsd: number(row.unrealized_profit), totalProfitUsd: number(row.profit), issues };
    const key = `${chain}:${wallet}`;
    if (entries.has(key)) throw new Error('leaderboard_duplicate_wallet');
    entries.set(key, { key, chain, wallet, tags, source: PROFIT_LEADERBOARD_SOURCE, sources: [source],
      firstSeenAt: observedAt, lastObservedAt: stamp(observedAt), researchEligible: issues.length === 0 });
  }
  return { entries: [...entries.values()], observedRows: data.list.length, omitted };
}

export function validProfitLeaderboard(state) {
  if (state?.schema !== PROFIT_LEADERBOARD_SCHEMA || state.mode !== 'readonly' || !Number.isFinite(stamp(state.updatedAt))
    || !Array.isArray(state.entries) || state.entries.length > 500 || new Set(state.entries.map(row => row?.key)).size !== state.entries.length) return false;
  return state.entries.every(row => row && gmgnFlowAddress(row.chain, row.wallet) === row.wallet && row.key === `${row.chain}:${row.wallet}`
    && row.source === PROFIT_LEADERBOARD_SOURCE && Array.isArray(row.tags) && row.tags.every(tag => typeof tag === 'string')
    && row.tags.length <= 100 && Number.isFinite(stamp(row.firstSeenAt)) && Number.isSafeInteger(row.lastObservedAt)
    && typeof row.researchEligible === 'boolean' && Array.isArray(row.sources) && row.sources.length > 0 && row.sources.length <= 5
    && row.sources.every(source => source.chain === row.chain && gmgnFlowAddress(row.chain, source.tokenAddress) === source.tokenAddress
      && Number.isSafeInteger(source.sourceRank) && source.sourceRank >= 1 && source.sourceRank <= 100
      && Number.isFinite(stamp(source.observedAt)) && stamp(source.observedAt) <= row.lastObservedAt
      && Number.isFinite(source.realizedProfitUsd) && source.realizedProfitUsd > 0 && Array.isArray(source.issues)
      && source.issues.every(issue => ['wallet_type_unverified', 'suspicion_not_cleared', 'excluded_wallet_tags', 'transfer_attribution', 'transfer_history_unknown'].includes(issue)))
    && row.researchEligible === (row.sources.every(source => source.issues.length === 0) && !row.tags.some(tag => blocked.test(tag)))
    && (!row.researchEligible || !row.tags.some(tag => blocked.test(tag))));
}

export function mergeProfitLeaderboards(previous, additions, nowMs) {
  if (previous && !validProfitLeaderboard(previous)) throw new Error('leaderboard_state_invalid');
  const map = new Map((previous?.entries || []).filter(row => row.lastObservedAt >= nowMs - 7 * 86400000).map(row => [row.key, structuredClone(row)]));
  for (const item of additions) {
    const prior = map.get(item.key), sources = new Map((prior?.sources || []).map(source => [source.tokenAddress, source]));
    for (const source of item.sources) if (!sources.has(source.tokenAddress) || stamp(source.observedAt) >= stamp(sources.get(source.tokenAddress).observedAt)) sources.set(source.tokenAddress, source);
    const retained = [...sources.values()].sort((a, b) => stamp(b.observedAt) - stamp(a.observedAt)).slice(0, 5);
    const tags = gmgnFlowTags([...(prior?.tags || []), ...item.tags]).slice(0, 100);
    map.set(item.key, { ...item, tags, sources: retained, firstSeenAt: prior?.firstSeenAt || item.firstSeenAt,
      lastObservedAt: Math.max(prior?.lastObservedAt || 0, item.lastObservedAt),
      researchEligible: retained.every(source => !source.issues.length) && !tags.some(tag => blocked.test(tag)) });
  }
  // Reserve equal per-chain capacity; this is a sampled candidate list, not a
  // fabricated global PnL ranking or a sum of incomparable token profits.
  const lists = ['robinhood', 'sol', 'bsc', 'base', 'eth'].map(chain => [...map.values()].filter(row => row.chain === chain)
    .sort((a, b) => Number(b.researchEligible) - Number(a.researchEligible) || b.lastObservedAt - a.lastObservedAt || a.key.localeCompare(b.key)));
  const entries = [];
  while (entries.length < 500 && lists.some(list => list.length)) for (const list of lists) if (list.length && entries.length < 500) entries.push(list.shift());
  const result = { schema: PROFIT_LEADERBOARD_SCHEMA, mode: 'readonly', updatedAt: new Date(nowMs).toISOString(),
    scope: 'sampled_token_trader_profit_lists_not_global_ranking', entries };
  if (!validProfitLeaderboard(result)) throw new Error('leaderboard_state_invalid');
  return result;
}
