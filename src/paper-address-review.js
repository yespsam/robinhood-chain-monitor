// Offline, bounded public-address evidence. No network, signing, or trade policy.
import { gmgnFlowAddress, gmgnFlowData, gmgnFlowTags } from './gmgn-flow-signal.js';

export const ADDRESS_REVIEW_VERSION = 'address_snapshot_review_v1';
const num = v => ['number', 'string'].includes(typeof v) && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const seconds = v => { const n = num(v); return Number.isSafeInteger(n) && n > 0 ? n * 1000 : null; };
const service = /binance|coinbase|mexc|gate\.io|fixedfloat|okx|kraken|bybit|bitget|kucoin|exchange|hot.?wallet|bridge|router|pool|交易所|热钱包|兑换|跨链/i;
const at = value => typeof value === 'number' ? value : Date.parse(value || '');
const validTime = (value, now) => Number.isFinite(value) && value > 0 && value <= now;

function uniqueRows(rows, chain, project) {
  const found = new Map(), conflicts = new Set(); let invalidRows = 0, duplicates = 0;
  for (const raw of rows) {
    const wallet = gmgnFlowAddress(chain, raw?.wallet_address || raw?.address);
    if (!wallet) { invalidRows++; continue; }
    const row = project(raw, wallet);
    if (!row) { invalidRows++; conflicts.add(wallet); continue; }
    if (found.has(wallet)) {
      duplicates++;
      if (JSON.stringify(found.get(wallet)) !== JSON.stringify(row)) conflicts.add(wallet);
    } else found.set(wallet, row);
  }
  return { rows: [...found.values()].filter(r => !conflicts.has(r.wallet)),
    invalidRows, duplicateRows: duplicates, conflictingWallets: [...conflicts] };
}

export function analyzeTraderSnapshot(query, entry = null, nowMs = Date.now()) {
  const chain = query?.chain, address = gmgnFlowAddress(chain, query?.address), receivedAtMs = at(query?.receivedAt);
  if (query?.type !== 'token_traders' || query.error || !address || !validTime(receivedAtMs, nowMs)) throw Error('Invalid trader snapshot envelope');
  if (entry && (entry.side !== 'buy' || entry.chain !== chain || gmgnFlowAddress(chain, entry.address) !== address
    || !validTime(entry.atMs, nowMs))) throw Error('Entry and trader snapshot must bind the same chain and CA');
  const data = gmgnFlowData(query.data);
  if (!Array.isArray(data?.list) || data.list.length > 100) throw Error('Expected a bounded trader list (0–100 rows)');
  if ((data.chain && data.chain !== chain) || (data.token_address && gmgnFlowAddress(chain, data.token_address) !== address)) throw Error('Conflicting trader payload identity');
  const dedup = uniqueRows(data.list, chain, (r, wallet) => {
    if ((r.chain && r.chain !== chain) || (r.token_address && gmgnFlowAddress(chain, r.token_address) !== address)) return null;
    const startAt = seconds(r.start_holding_at), endAt = seconds(r.end_holding_at), lastActiveAt = seconds(r.last_active_timestamp);
    if ([startAt, endAt, lastActiveAt].some(t => t !== null && t > receivedAtMs)
      || startAt && endAt && endAt < startAt) return null;
    const f = r.native_transfer || {}, from = gmgnFlowAddress(chain, f.from_address), alias = gmgnFlowAddress(chain, f.address);
    const fundAt = seconds(f.timestamp), fundingConflict = Boolean((f.from_address && !from) || (f.address && !alias) || (from && alias && from !== alias));
    const balance = num(r.balance), share = num(r.amount_percentage);
    const funder = !fundingConflict && validTime(fundAt, receivedAtMs) ? from || alias : null;
    return { wallet, realizedProfitUsd: num(r.realized_profit), unrealizedProfitUsd: num(r.unrealized_profit),
      balance: balance !== null && balance >= 0 ? balance : null,
      holdingFraction: share !== null && share >= 0 && share <= 1 ? share : null,
      startAt, endAt, lastActiveAt, tags: gmgnFlowTags([...(Array.isArray(r.tags) ? r.tags : []), ...(Array.isArray(r.maker_token_tags) ? r.maker_token_tags : [])]),
      serviceWallet: num(r.addr_type) === 2 || service.test(String(r.exchange || '')),
      funder, fundingAt: funder ? fundAt : null, fundingName: typeof f.name === 'string' ? f.name.slice(0,120) : null,
      fundingService: service.test(String(f.name || '')), fundingConflict };
  });
  const rows = dedup.rows.filter(r => !r.serviceWallet), context = entry?.entryEvidence?.memeExitContext;
  const contextAt = at(context?.observedAt);
  const cohortKnown = !!entry && context?.cohortKnown === true && validTime(contextAt, entry.atMs)
    && entry.atMs - contextAt <= 120000 && Array.isArray(context.smartBuyers)
    && context.smartBuyers.length <= 100 && context.smartBuyers.every(w => gmgnFlowAddress(chain, w));
  const wallets = cohortKnown ? [...new Set(context.smartBuyers.map(w => gmgnFlowAddress(chain, w)))] : [];
  const cohort = wallets.map(wallet => {
    const r = rows.find(r => r.wallet === wallet);
    return { wallet, snapshotStatus: !r ? 'not_in_bounded_sample' : r.balance === null ? 'balance_unknown' : r.balance > 0 ? 'holding_at_snapshot' : 'zero_balance_at_snapshot',
      holdingFraction: r?.holdingFraction ?? null, realizedProfitUsd: r?.realizedProfitUsd ?? null };
  });
  const funding = new Map();
  for (const r of rows) if (r.funder) { if (!funding.has(r.funder)) funding.set(r.funder, []); funding.get(r.funder).push(r); }
  const fundingGroups = [...funding].filter(([,rs]) => rs.length >= 2).map(([funder, rs]) => ({
    funder, wallets: rs.map(r => r.wallet), names: [...new Set(rs.map(r => r.fundingName).filter(Boolean))],
    classification: rs.some(r => r.fundingService) ? 'public_service_source' : 'unverified_shared_funder',
    currentHoldingFraction: rs.every(r => r.holdingFraction !== null) && rs.reduce((n,r) => n+r.holdingFraction,0) <= 1
      ? rs.reduce((n,r) => n+r.holdingFraction,0) : null,
    fundingTimes: rs.map(r => r.fundingAt), commonControlConfirmed: false
  })).sort((a,b) => b.wallets.length-a.wallets.length);
  const earlyClosed = entry ? rows.filter(r => r.realizedProfitUsd > 0 && r.balance === 0 && r.holdingFraction === 0
    && r.startAt && r.endAt && r.lastActiveAt && r.startAt < entry.atMs && r.endAt <= entry.atMs
    && r.lastActiveAt <= entry.atMs).sort((a,b) => b.realizedProfitUsd-a.realizedProfitUsd).map(r => ({
      wallet:r.wallet, tokenRealizedProfitAtSnapshotUsd:r.realizedProfitUsd, startAt:r.startAt, endAt:r.endAt,
      secondsBeforeEntry:(entry.atMs-r.endAt)/1000, tags:r.tags })) : [];
  return { version:ADDRESS_REVIEW_VERSION, mode:'research_only', chain, address, entryId:entry?.id || null,
    receivedAt:query.receivedAt, knowledge:!entry ? 'snapshot_only' : receivedAtMs > entry.atMs ? 'retrospective_only' : 'snapshot_received_before_entry',
    automaticTradingChanges:false, sampleRows:data.list.length, usableWallets:rows.length,
    invalidRows:dedup.invalidRows, duplicateRows:dedup.duplicateRows, conflictingWallets:dedup.conflictingWallets,
    excludedServiceWallets:dedup.rows.length-rows.length, earlyClosed, cohortKnown, cohort,
    cohortTruncated:cohortKnown ? context.cohortTruncated === true : null, fundingGroups,
    limitations:['榜单为有限、事后盈利排序样本，存在选择偏差；本币盈利不代表全钱包长期盈利。',
      '入场前结束持有时间为平台记录，当前余额不是历史余额；事后快照不证明入场时系统已获取。',
      '入场群体未上榜不等于已卖出；没有逐笔完整历史，不能认定持续增持或未兑现。',
      '同源资金不证明共同控制；公共服务来源不计作控盘线索，未知来源仍可能是服务商。'] };
}

export function analyzeWalletStatsSnapshot(query, nowMs = Date.now()) {
  if (query?.type !== 'wallet_stats' || query.error || !['7d','30d'].includes(query.period)
    || !validTime(at(query.receivedAt), nowMs) || !Array.isArray(query.wallets)
    || !query.wallets.length || query.wallets.length > 100) throw Error('Invalid wallet stats envelope');
  const requested = [...new Set(query.wallets.map(w => gmgnFlowAddress(query.chain, w)))];
  if (requested.includes(null)) throw Error('Invalid requested wallet');
  const data = gmgnFlowData(query.data), list = Array.isArray(data) ? data : [data];
  if (list.length > 100) throw Error('Unbounded wallet stats response');
  const parsed = uniqueRows(list, query.chain, (r, wallet) => {
    if ((r.chain && r.chain !== query.chain) || !requested.includes(wallet)
      || gmgnFlowAddress(query.chain, r.wallet_address) !== wallet
      || (r.address && gmgnFlowAddress(query.chain, r.address) !== wallet)) return null;
    return {wallet, realizedProfitUsd:num(r.realized_profit), period:query.period};
  });
  return { chain:query.chain, receivedAt:query.receivedAt, period:query.period, requestedWallets:requested,
    returnedWallets:parsed.rows, missingWallets:requested.filter(w => !parsed.rows.some(r => r.wallet === w)),
    conflictingWallets:parsed.conflictingWallets, invalidRows:parsed.invalidRows,
    note:'只归属到响应明确返回的钱包；未返回、未实现盈亏、统计完整性均不补猜，不自动晋升教师。' };
}
