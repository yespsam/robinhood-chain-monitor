// The public boundary is an explicit allowlist, not a recursive secret denylist.
// Neither local configuration nor wallet credentials enter this object.
const fields = names => Object.fromEntries(names.split(' ').filter(Boolean).map(key => [key, true]));
const list = value => Array.isArray(value) ? value : [];
const url = value => {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password ? `${u.origin}${u.pathname}` : null; }
  catch { return null; }
};
const text = value => value.slice(0, 1600)
  .replace(/(?:gh[pousr]_[\w]{20,}|github_pat_[\w]+|sk-[\w-]{20,}|\d{7,12}:[A-Za-z0-9_-]{30,})/g, '[已隐藏]')
  .replace(/((?:api[_-]?key|access[_-]?token|secret|authorization)\s*[:=]\s*)[^\s,;]+/gi, '$1[已隐藏]');
function project(value, schema) {
  if (schema === url) return url(value);
  if (schema === true) return typeof value === 'string' ? text(value) : typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)) ? value : null;
  if (Array.isArray(schema)) return list(value).slice(0, 1000).map(item => project(item, schema[0]));
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(schema).filter(([key]) => Object.hasOwn(value, key)).map(([key, child]) => [key, project(value[key], child)]));
}
const identity = fields('chain address symbol name');
const flow = fields('uniqueBuyerCount highProfitCount fomoCount netBuyUsd buyerCount sellerCount');
const pattern = fields('closedAt close reason ready volumeMultiple');
const opportunity = { ...fields('id label version basis signalReady decision'), pattern, reasons: [true], missing: [true] };
const thesis = {
  ...fields('method conclusion'),
  event: { ...fields('label claimStatus excerpt mechanism verification'), sourceUrl: url },
  relationship: fields('label'), catalyst: fields('label'), propagation: fields('summary'), demand: fields('summary'),
  market: fields('summary'), invalidation: fields('observed'), history: fields('samples medianReturn24h'),
  sources: [{ url }],
};
const evidence = {
  ...fields('version paperEligible marketFresh priceFresh priceObservedAt marketObservedAt flowFresh narrativeText narrativeFresh marketStage'),
  flow, opportunity, opportunityRoutes: [opportunity], narrativeThesis: thesis,
  exitPolicy: fields('version entryQuoteMaxAgeMs exitQuoteMaxAgeMs'),
  flowDiagnostics: fields('scope complete'), safety: { metrics: fields('top10HolderRate') },
  confirmedPolicy: { ...fields('version'), pulse: fields('windowMs recentBuyerCount recentNetBuyUsd') },
  entryPlan: { ...fields('thesis invalidation stopPrice targetPrice targetKind'), economics: fields('breakEvenRate estimatedStopLossUsd ready') },
  narrativeAssessment: { ...fields('thesis summary'), sources: [{ ...fields('authorLabel'), sourceUrl: url }] },
};
const trade = { ...identity, ...fields('id side strategyId strategyLabel quantity price grossUsd costsUsd netUsd costBasisUsd realizedPnl reason entryLogic exitLogic atMs observedAt costSource') };
const position = {
  ...identity, ...fields('quantity price entryPrice markPrice markValue markStatus markAt pnl cost costBasisUsd openedAt entryLogic exitLogic activeStopPrice'),
  entryReasons: [true], entryEvidence: evidence,
  memeExitPolicy: fields('version'), pvpPolicy: fields('version'),
  exitStatus: fields('holdReason'), thesisStatus: { narrative: fields('summary'), flow: fields('summary'), operator: fields('summary') },
};
const task = { ...identity, ...fields('key at status startedAt finishedAt fetchedAt receivedAt sourceStatus ready reason') };
const schema = {
  ...fields('status mode execution signing broadcast enabled updatedAt costModel'),
  session: fields('id label'), entryGuard: { ...fields('allowed'), reasons: [true] },
  account: { ...fields('mode execution signing broadcast initialCash cash realizedPnl updatedAt'),
    stats: fields('entries exits wins losses realizedPnl equity netLiquidationValue unrealizedPnl openPositions stalePositions totalCostsUsd'),
    cashAdjustments: [fields('amountUsd atMs reason')] },
  evaluations: [{ ...fields('strategyId label decision entryLogic exitLogic observedAt'), reasons: [true], missing: [true],
    token: { ...identity, ...fields('price marketCap liquidity observedAt') }, evidence }],
  opportunityRoutes: [{ ...fields('id label description') }],
  cadence: { ...fields('actualTickGapMs lastTickDurationMs lastTickAt tickCount lastMarketRefreshAt'),
    lastQuoteTiming: fields('queueMs'), quoteInFlight: [task], marketSourceAges: [fields('chain ageMs status observedAt')] },
  researchPipeline: { ...fields('detailsSucceeded detailsRequested chartRequestsPending'), lastDetail: task, lastChartDispatch: task,
    hotCandidates: [task], pending: [task], stageSnapshot: [fields('chain status')], chartDiagnostics: [task], entryFocus: fields('active until key') },
  newsWire: fields('updatedAt ownDocumentCount gmgnSignalCount fullTwitterConnected'),
  narrativeDesk: fields('updatedAt withSources communityLinked directCa'),
  learning: { ...fields('updatedAt walletCount'), roles: fields('teacher') },
  exitMonitor: fields('lastCheckedAt'),
  tradeCountReview: { ...fields('pendingFills completedBatches'), latestReport: fields('sequence generatedAt windowRealizedPnlUsd') },
};

export function createPublicSnapshot(input, nowMs = Date.now()) {
  for (const item of [input, input?.account]) {
    if (!item || item.mode !== 'paper' || ['execution', 'signing', 'broadcast'].some(key => item[key] !== false)) throw new Error('Only explicitly non-executable paper snapshots may be published');
  }
  const at = Date.parse(input.updatedAt);
  if (!Number.isFinite(at) || at > nowMs + 60_000) throw new Error('Invalid snapshot time');
  // Public research is bounded; all currently held CAs and active research come
  // first. Avoid repeating each token's large evidence for every strategy.
  const priorityKeys = new Set([
    ...Object.values(input.account.positions || {}), ...list(input.researchPipeline?.hotCandidates),
    input.researchPipeline?.lastDetail,
  ].filter(Boolean).map(t => `${t.chain}:${t.address}`));
  const candidates = new Map();
  for (const row of list(input.evaluations)) {
    if (!row?.token?.chain || !row.token.address) continue;
    const key = `${row.token.chain}:${row.token.address}`;
    if (!candidates.has(key) || row.decision === '可模拟') candidates.set(key, row);
  }
  const rank = row => Number(row.decision === '可模拟') * 2 + Number(priorityKeys.has(`${row.token.chain}:${row.token.address}`));
  const evaluations = [...candidates.values()].sort((a, b) => rank(b) - rank(a)).slice(0, 100);
  const output = project({ ...input, evaluations }, schema);
  output.publicView = true;
  output.schema = 'yesp-public-v1';
  output.account.positions = Object.fromEntries(Object.values(input.account.positions || {}).slice(0, 1000).map((row, i) => [String(i), project(row, position)]));
  output.account.trades = list(input.account.trades).slice(-500).map(row => project(row, trade));
  const alreadyPublic = input.schema === output.schema && input.publicView === true;
  output.publicSummary = {
    totalTrades: alreadyPublic ? input.publicSummary?.totalTrades : list(input.account.trades).length,
    totalEvaluations: alreadyPublic ? input.publicSummary?.totalEvaluations : list(input.evaluations).length,
    totalCostsUsd: alreadyPublic ? input.publicSummary?.totalCostsUsd : list(input.account.trades).reduce((n, t) => n + (Number.isFinite(t.costsUsd) ? t.costsUsd : 0), 0),
    fundingAdjustmentsUsd: alreadyPublic ? input.publicSummary?.fundingAdjustmentsUsd : list(input.account.cashAdjustments).reduce((n, t) => n + (Number.isFinite(t.amountUsd) ? t.amountUsd : 0), 0),
  };
  for (const [key, value] of Object.entries(output.publicSummary)) if (!Number.isFinite(value)) output.publicSummary[key] = null;
  output.publicSync = { receivedAt: new Date(nowMs).toISOString(), intervalMs: 15000, staleAfterMs: 60000 };
  return output;
}
