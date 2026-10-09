import { createHash } from 'node:crypto';
import { gmgnFlowAddress, gmgnFlowData, gmgnFlowTags, qualifiesGmgnFlowWallet } from './gmgn-flow-signal.js';
import { PERSONA_CATALOG, classifyWalletPersonas } from './wallet-personas.js';

export const LEARNING_SCHEMA = 'yesp_wallet_learning_v1';
export const LEARNING_MINIMUMS = Object.freeze({ teachers: 3, matchedSells: 30, tokens: 10, spanMs: 3 * 86400_000, copyableHoldMs: 30_000 });
const finite = v => ['number', 'string'].includes(typeof v) && String(v).trim() && Number.isFinite(Number(v)) ? Number(v) : null;
const hashOK = (chain, value) => typeof value === 'string' && (chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/ : /^0x[\da-fA-F]{64}$/).test(value);
const iso = at => new Date(at).toISOString();
const blocked = /wash|arbitrag|sandwich|(?:^|_)mev|router|exchange|contract/i;
const quantile = (values, q = .5) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return sorted.length ? sorted[Math.floor((sorted.length - 1) * q)] : null; };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function learningWalletRole(w, nowMs = Date.now()) {
  const tags = gmgnFlowTags([...(w.tags || []), ...(w.profile?.['7d']?.tags || []), ...(w.profile?.['30d']?.tags || [])]);
  if (tags.some(t => blocked.test(t))) return 'excluded';
  if (w.statsError) return 'unverified';
  if (qualifiesGmgnFlowWallet(w.profile, w.chain, w.wallet, nowMs)) return 'teacher';
  const complete = ['7d', '30d'].every(period => {
    const p = w.profile?.[period], at = Date.parse(p?.checkedAt);
    return p?.chain === w.chain && p.wallet === w.wallet && p.period === period && at <= nowMs && at >= nowMs - 2 * 3600000
      && [p.realizedProfitUsd, p.realizedRoi, p.winRate].every(Number.isFinite);
  });
  return complete ? 'comparison' : 'unverified';
}

// Only two explicit sources for teachers: existing GMGN dual-window profiles
// and the existing monitor's GMGN performance roster. Never infer FOMO identity.
export function selectLearningTeachers(flow = {}, fomo = {}, nowMs = Date.now()) {
  const profiles = new Map(Object.entries(flow.profiles || {}));
  for (const entry of Object.values(fomo.publicOnchain?.smartMoney?.roster || {})) {
    const p = entry?.walletProfile, chain = p?.chainId === 56 ? 'bsc' : null, wallet = gmgnFlowAddress(chain, entry?.wallet);
    if (!wallet || p?.scheme !== 'gmgn_wallet_stats_dual_window_v1' || p.source !== 'gmgn_portfolio_stats' || p.wallet !== wallet || !entry.eoaVerified) continue;
    const converted = Object.fromEntries(['7d', '30d'].map(period => [period, { chain, wallet, period,
      checkedAt: p.statsCheckedAt, ...p.windows?.[period], tags: gmgnFlowTags(p.tags),
      createdAt: Math.floor(Date.parse(p.createdAt) / 1000), lastTradeAt: Math.floor(entry.lastTradeAt / 1000), createdTokenCount: p.createdTokenCount }]));
    if (!profiles.has(`${chain}:${wallet}`) || !qualifiesGmgnFlowWallet(profiles.get(`${chain}:${wallet}`), chain, wallet, nowMs)) profiles.set(`${chain}:${wallet}`, converted);
  }
  const observedTags = new Map();
  for (const rows of Object.values(flow.trades || {})) for (const row of rows) {
    if (row.at < nowMs - 20 * 60_000 || row.at > nowMs + 30_000) continue;
    const key = `${row.chain}:${row.wallet}`;
    observedTags.set(key, gmgnFlowTags([...(observedTags.get(key) || []), ...(row.tags || [])]));
  }
  return [...profiles].flatMap(([key, profile]) => {
    const [chain, wallet] = key.split(':');
    const tags = gmgnFlowTags([...(profile?.['7d']?.tags || []), ...(profile?.['30d']?.tags || []), ...(observedTags.get(key) || [])]);
    if (!qualifiesGmgnFlowWallet(profile, chain, wallet, nowMs) || tags.some(t => blocked.test(t))) return [];
    if (!tags.some(t => ['smart_degen', 'smart_money', 'smartmoney', 'fomo'].includes(t))) return [];
    return [{ key, chain, wallet, tags, groups: ['gmgn_smartmoney', ...(tags.includes('fomo') ? ['gmgn_fomo'] : [])],
      qualifiedAt: iso(nowMs), profile, fomoOfficial: false }];
  }).sort((a, b) => (b.chain === 'robinhood') - (a.chain === 'robinhood') || b.groups.length - a.groups.length || a.key.localeCompare(b.key)).slice(0, 80);
}

export function parseWalletActivity(payload, chain, wallet, nowMs = Date.now()) {
  const data = gmgnFlowData(payload);
  if (!gmgnFlowAddress(chain, wallet) || !Array.isArray(data?.activities) || data.activities.length > 200
    || data.next != null && (typeof data.next !== 'string' || data.next.length > 2048)) throw new Error('learning_activity_schema');
  const rows = data.activities.map(raw => {
    const token = gmgnFlowAddress(chain, raw?.token?.address), at = finite(raw?.timestamp), hash = raw?.tx_hash ?? raw?.transaction_hash;
    const side = raw?.event_type ?? raw?.type;
    if (!token || !hashOK(chain, hash) || !Number.isSafeInteger(at) || at <= 0 || at * 1000 > nowMs + 30_000
      || raw.wallet != null && gmgnFlowAddress(chain, raw.wallet) !== wallet || raw.chain != null && raw.chain !== chain
      || raw.tx_hash && raw.transaction_hash && raw.tx_hash !== raw.transaction_hash
      || raw.type && raw.event_type && raw.type !== raw.event_type) throw new Error('learning_activity_identity');
    const quantity = finite(raw.token_amount), usd = finite(raw.cost_usd), price = finite(raw.price_usd);
    const trade = ['buy', 'sell'].includes(side);
    const validAmount = quantity > 0 && usd > 0 && price > 0 && Math.abs(quantity * price - usd) <= Math.max(.01, usd * .02);
    return { chain, wallet, token, hash: chain === 'sol' ? hash : hash.toLowerCase(), at: at * 1000,
      side: trade && validAmount ? side : 'unattributable', quantity: trade && validAmount ? quantity : null,
      usd: trade && validAmount ? usd : null, price: trade && validAmount ? price : null,
      symbol: String(raw.token?.symbol || '').slice(0, 40) };
  });
  return { rows, next: data.next || null };
}

export function mergeLearningActivity(previous = [], incoming = [], nowMs = Date.now()) {
  const map = new Map();
  for (const row of [...previous, ...incoming]) {
    if (row.at < nowMs - 30 * 86400_000) continue;
    const key = `${row.chain}:${row.wallet}:${row.hash}:${row.token}`, prior = map.get(key);
    // No log index is provided by this route. Conflicting legs or USD revisions
    // are not profit evidence: quarantine the token in this retained window.
    if (prior && !same({ ...prior, symbol: '' }, { ...row, symbol: '' })) map.set(key, { ...row, side: 'unattributable', quantity: null, usd: null, price: null });
    else map.set(key, row);
  }
  return [...map.values()].sort((a, b) => a.at - b.at || a.hash.localeCompare(b.hash)).slice(-2000);
}

export function analyzeWalletHabits(rows = []) {
  const tokens = new Map(), matches = [], actions = [], holds = [], buys = [], addMoves = [];
  const tokenSpend = [];
  let excludedTokens = 0, unmatchedSells = 0, openLots = 0, adds = 0, partialSells = 0;
  for (const row of rows) { const group = tokens.get(row.token) || []; group.push(row); tokens.set(row.token, group); }
  for (const group of tokens.values()) {
    const ordered = [...group].sort((a, b) => a.at - b.at);
    // Transfers, unknown actions, same-second opposite events and oversells
    // invalidate inventory attribution for this token, not just one bad row.
    if (ordered.some(r => r.side === 'unattributable') || ordered.some((r, i) => i && r.at === ordered[i - 1].at && r.side !== ordered[i - 1].side)) { excludedTokens++; continue; }
    const lots = [], tokenMatches = [], tokenActions = [], tokenBuys = [], tokenMoves = []; let invalid = false, tokenAdds = 0, tokenPartials = 0;
    for (const row of ordered) {
      if (row.side === 'buy') {
        tokenActions.push({...row,positionAction:lots.length?'add':'observed_entry',
          addPriceChange:lots.length?row.price/lots.at(-1).price-1:null});
        if (lots.length) { tokenAdds++; tokenMoves.push(row.price / lots.at(-1).price - 1); }
        lots.push({ ...row, remaining: row.quantity }); tokenBuys.push(row.usd); continue;
      }
      const balance = lots.reduce((s, lot) => s + lot.remaining, 0);
      if (!balance || row.quantity > balance * (1 + 1e-8)) { unmatchedSells++; invalid = true; break; }
      if (row.quantity < balance * (1 - 1e-8)) tokenPartials++;
      let remaining = row.quantity, cost = 0, weightedHold = 0;
      for (const lot of lots) {
        if (remaining <= row.quantity * 1e-10) break;
        const amount = Math.min(lot.remaining, remaining);
        cost += lot.usd * amount / lot.quantity; weightedHold += (row.at - lot.at) * amount;
        lot.remaining -= amount; remaining -= amount;
      }
      while (lots[0]?.remaining <= row.quantity * 1e-10) lots.shift();
      const holdMs = weightedHold / row.quantity, grossReturn = row.usd / cost - 1;
      if (!Number.isFinite(holdMs) || !Number.isFinite(grossReturn)) { invalid = true; break; }
      tokenMatches.push({ token: row.token, at: row.at, holdMs, grossReturn, sellHash: row.hash });
      tokenActions.push({...row,positionAction:row.quantity<balance*(1-1e-8)?'partial_exit':'observed_exit',
        soldFraction:row.quantity/balance,holdMs,grossReturn,matchedCostUsd:cost,averageBuyPrice:cost/row.quantity});
    }
    if (invalid) { excludedTokens++; continue; }
    matches.push(...tokenMatches); holds.push(...tokenMatches.map(x => x.holdMs)); buys.push(...tokenBuys); addMoves.push(...tokenMoves);
    actions.push(...tokenActions);
    if (tokenBuys.length) tokenSpend.push(tokenBuys.reduce((s, v) => s + v, 0));
    openLots += lots.length; adds += tokenAdds; partialSells += tokenPartials;
  }
  const copyable = matches.filter(x => x.holdMs >= LEARNING_MINIMUMS.copyableHoldMs);
  const buyTotal = buys.reduce((s, v) => s + v, 0), lowBuy = quantile(buys, .1);
  return { observedRecords: rows.length, matchedSells: matches.length, copyableMatchedSells: copyable.length,
    excludedTokens, unmatchedSells, openLots, adds, partialSells,
    matchedTokenCount: new Set(matches.map(m => m.token)).size,
    observedSpanMs: rows.length ? Math.max(...rows.map(r => r.at)) - Math.min(...rows.map(r => r.at)) : 0,
    buyCount: buys.length, buyTokenCount: tokenSpend.length, buySizeP90P10: lowBuy > 0 ? quantile(buys, .9) / lowBuy : null,
    largestTokenBuyShare: buyTotal > 0 ? Math.max(...tokenSpend) / buyTotal : null,
    risingAdds: addMoves.filter(v => v >= .03).length, fallingAdds: addMoves.filter(v => v <= -.03).length,
    winningExits: copyable.filter(x => x.grossReturn > 0).length, losingExits: copyable.filter(x => x.grossReturn < 0).length,
    medianHoldMs: quantile(holds), medianBuyUsd: quantile(buys), medianAddPriceChange: quantile(addMoves),
    medianWinningExit: quantile(copyable.filter(x => x.grossReturn > 0).map(x => x.grossReturn)),
    medianLosingExit: quantile(copyable.filter(x => x.grossReturn < 0).map(x => x.grossReturn)),
    tooFastSells: matches.length - copyable.length, matches, actions,
    scope: '观察窗口内 FIFO 数量配对，非完整持仓；毛收益未扣费用，不能当作跟单回测',
    unknown: ['交易前真实总仓位', '场外及跨链头寸', '可复制净收益', '动机与因果', '买入前价格路径'] };
}

export function buildLearningReport(state, nowMs = Date.now(), habitCache = null) {
  const wallets = Object.values(state?.wallets || {}).map(w => {
    const cached = habitCache?.get(w.key), habits = cached?.rows === w.rows ? cached.habits : analyzeWalletHabits(w.rows);
    habitCache?.set(w.key, { rows: w.rows, habits });
    return { ...w, habits, role: learningWalletRole(w, nowMs), persona: classifyWalletPersonas(habits, w) };
  });
  const policies = [], groups = [], personaPolicies = [], personaGroups = [];
  for (const chain of ['robinhood', 'sol', 'bsc', 'base', 'eth']) for (const group of ['gmgn_smartmoney', 'gmgn_fomo']) {
    const teachers = wallets.filter(w => w.chain === chain && w.groups.includes(group) && w.role === 'teacher');
    // Equal-weight teachers (not trade count or wallet wealth); do not let a
    // single high-frequency wallet determine the student's risk preferences.
    const usable = teachers.filter(w => !w.historyGap && !w.lastError && Date.parse(w.checkedAt) <= nowMs
      && Date.parse(w.checkedAt) >= nowMs - 6 * 3600_000 && w.habits.copyableMatchedSells >= 5
      && !w.persona.labels.some(p => ['ultrafast', 'average_down'].includes(p.id)));
    const matches = usable.flatMap(w => w.habits.matches.filter(x => x.holdMs >= LEARNING_MINIMUMS.copyableHoldMs && x.at <= nowMs));
    const distinctTokens = new Set(matches.map(x => x.token)).size;
    const spanMs = matches.length ? Math.max(...matches.map(x => x.at)) - Math.min(...matches.map(x => x.at)) : 0;
    const ready = usable.length >= LEARNING_MINIMUMS.teachers && matches.length >= LEARNING_MINIMUMS.matchedSells
      && distinctTokens >= LEARNING_MINIMUMS.tokens && spanMs >= LEARNING_MINIMUMS.spanMs;
    const summary = { chain, group, teacherCount: teachers.length, usableTeachers: usable.length, matchedSells: matches.length,
      tokens: distinctTokens, spanMs, ready, minimums: LEARNING_MINIMUMS };
    groups.push(summary);
    for (const persona of PERSONA_CATALOG) {
      const observed = wallets.filter(w => w.chain === chain && w.groups.includes(group) && w.persona.labels.some(p => p.id === persona.id));
      const members = usable.filter(w => w.persona.labels.some(p => p.id === persona.id)
        && !w.persona.labels.some(p => ['ultrafast', 'average_down'].includes(p.id)));
      const sample = members.flatMap(w => w.habits.matches.filter(m => m.holdMs >= LEARNING_MINIMUMS.copyableHoldMs && m.at <= nowMs));
      const tokens = new Set(sample.map(m => m.token)).size;
      const span = sample.length ? Math.max(...sample.map(m => m.at)) - Math.min(...sample.map(m => m.at)) : 0;
      const eligible = persona.adoptable && members.length >= 3 && sample.length >= 30 && tokens >= 10 && span >= LEARNING_MINIMUMS.spanMs;
      if (observed.length) personaGroups.push({ chain, group, personaId: persona.id, label: persona.label, observedWallets: observed.length,
        teacherCount: members.length, comparisonWallets: observed.filter(w => w.role === 'comparison').length,
        matchedSells: sample.length, tokens, spanMs: span, ready: eligible, strength: persona.strength, weakness: persona.weakness });
      if (eligible) personaPolicies.push(makePolicy(members, sample, chain, group, nowMs, persona.id));
    }
    if (!ready) continue;
    policies.push(makePolicy(usable, matches, chain, group, nowMs));
  }
  return { schema: LEARNING_SCHEMA, updatedAt: iso(nowMs), status: policies.length ? 'shadow_ready' : 'collecting',
    mode: 'paper_learning', execution: false, signing: false, broadcast: false,
    walletCount: wallets.length, qualifiedNow: wallets.filter(w => w.role === 'teacher').length,
    candidateCount: Object.keys(state?.universe || {}).length,
    roles: Object.fromEntries(['teacher', 'comparison', 'unverified', 'excluded'].map(role => [role, wallets.filter(w => w.role === role).length])),
    chainCoverage: ['robinhood', 'sol', 'bsc', 'base', 'eth'].map(chain => ({ chain, candidates: Object.values(state?.universe || {}).filter(w => w.chain === chain).length,
      deepWallets: wallets.filter(w => w.chain === chain).length, sampledWallets: wallets.filter(w => w.chain === chain && w.checkedAt).length })),
    personaCatalog: PERSONA_CATALOG, personaGroups, personaPolicies,
    fomoWalletCount: wallets.filter(w => w.groups.includes('gmgn_fomo')).length,
    activityRecords: wallets.reduce((s, w) => s + w.rows.length, 0),
    wallets: wallets.map(w => ({ key: w.key, chain: w.chain, wallet: w.wallet, groups: w.groups, firstSeenAt: w.firstSeenAt,
      checkedAt: w.checkedAt || null, lastError: w.lastError || null, statsError: w.statsError || null, historyGap: w.historyGap === true, hasOlderPages: !!w.nextCursor, pages: w.pages || 0,
      performance: Object.fromEntries(['7d', '30d'].map(period => {
        const p = w.profile?.[period];
        return [period, p?.chain === w.chain && p.wallet === w.wallet && p.period === period
          ? { checkedAt: p.checkedAt, realizedProfitUsd: p.realizedProfitUsd, winRate: p.winRate, realizedRoi: p.realizedRoi, tokenCount: p.tokenCount } : null];
      })),
      habits: { ...w.habits, matches: undefined, actions: undefined }, role: w.role, persona: w.persona, qualifiedNow: w.role === 'teacher' })),
    groups, policies, promotion: '不自动替换原策略；先累计同时间、同报价、同成本的独立模拟对照' };
}

function makePolicy(teachers, matches, chain, group, nowMs, personaId = null) {
  const holds = teachers.map(w => quantile(w.habits.matches.filter(x => x.holdMs >= LEARNING_MINIMUMS.copyableHoldMs && x.at <= nowMs).map(x => x.holdMs)));
  const losses = teachers.map(w => w.habits.medianLosingExit).filter(x => x !== null && x < 0);
  const lossCutRate = losses.length >= 3 ? Math.min(.15, Math.max(.06, Math.abs(quantile(losses)))) : null;
  const maxHoldMs = Math.round(Math.min(3600_000, Math.max(120_000, quantile(holds))));
  const version = createHash('sha256').update(JSON.stringify({ chain, group, personaId, maxHoldMs, lossCutRate, teachers: teachers.map(w => w.key).sort(), records: matches.map(x => x.sellHash).sort() })).digest('hex').slice(0, 16);
  return { version, chain, group, ...(personaId ? { personaId } : {}), maxHoldMs, lossCutRate, trainedAt: iso(nowMs), trainingEndAt: iso(Math.max(...matches.map(x => x.at))),
    teacherCount: teachers.length, matchedSells: matches.length, scope: '仅向前模拟；只测试持仓期限和亏损退出，不复制加仓或仓位规模' };
}

export function validLearningPolicy(p, chain, nowMs = Date.now()) {
  return p && p.chain === chain && /^[a-f0-9]{16}$/.test(p.version) && ['gmgn_smartmoney', 'gmgn_fomo'].includes(p.group)
    && (p.personaId === undefined || PERSONA_CATALOG.some(persona => persona.id === p.personaId && persona.adoptable))
    && Number.isInteger(p.maxHoldMs) && p.maxHoldMs >= 120_000 && p.maxHoldMs <= 3600_000
    && (p.lossCutRate === null || Number.isFinite(p.lossCutRate) && p.lossCutRate >= .06 && p.lossCutRate <= .15)
    && Number.isSafeInteger(p.teacherCount) && p.teacherCount >= 3 && Number.isSafeInteger(p.matchedSells) && p.matchedSells >= 30
    && Date.parse(p.trainingEndAt) > 0 && Date.parse(p.trainingEndAt) <= Date.parse(p.trainedAt)
    && Date.parse(p.trainedAt) <= nowMs && Date.parse(p.trainedAt) >= nowMs - 2 * 3600_000;
}
