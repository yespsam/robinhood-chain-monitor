// Descriptive research from frozen entry records. Never an entry/exit gate.
import { gmgnFlowAddress } from './gmgn-flow-signal.js';

export const EVIDENCE_REVIEW_VERSION = 'entry_evidence_review_v1';
const stamp = value => typeof value === 'number' ? value : Date.parse(value || '');
const count = value => Number.isSafeInteger(value) && value >= 0;
const labels = {
  official_catalog: '官方目录对应 CA', direct_ca: '原文明确对应 CA（非背书）',
  community_link: '社区题材关联（非作者认领）', project_link: '项目引用原帖，关系待核实',
  name_only: '仅名称相符', unverified: '未记录可核实关联',
  verified_profit: '入场记录有核实盈利地址', tagged_only: '有标签买家，盈利未核实',
  other_buyers: '其他可见净买地址', no_buyers: '可见样本无净买地址', unknown: '证据缺失 / 不完整'
};
const narrativeKinds = new Set(['official_catalog','direct_ca','community_link','project_link','name_only']);

export function classifyEntryEvidence(entry) {
  const e = entry?.entryEvidence || {}, t = e.narrativeThesis, d = e.flowDiagnostics || {}, f = e.flow || {};
  const at = entry?.atMs, ca = gmgnFlowAddress(entry?.chain, entry?.address);
  const bound = ca && t?.chain === entry.chain && gmgnFlowAddress(t.chain, t.address) === ca;
  let narrative = 'unverified';
  // Only the thesis frozen in this buy is eligible. A later source lookup must
  // not repair a past entry's classification or alter an existing batch report.
  if (bound && stamp(t.observedAt) > 0 && stamp(t.observedAt) <= at
    && narrativeKinds.has(t.relationship?.kind)
    && t.event?.sourceUrl && stamp(t.event.sourceAt) <= at
    && t.sources?.some(s => s.url === t.event.sourceUrl && s.binding === t.relationship.kind
      && Number.isFinite(stamp(s.at)) && stamp(s.at) <= at)) narrative = t.relationship.kind;
  const flowAt = stamp(d.observedAt || (d.provider === e.memeExitContext?.provider ? e.memeExitContext?.observedAt : null));
  const usable = e.flowFresh === true && d.complete === true && !d.coverageGap && !d.sourceIssue
    && Number.isFinite(flowAt) && flowAt <= at && at - flowAt <= 120000
    && (!d.sourceStatus || ['healthy', 'ok'].includes(d.sourceStatus))
    && count(f.uniqueBuyerCount) && count(f.smartMoneyCount) && count(f.highProfitCount)
    && f.smartMoneyCount <= f.uniqueBuyerCount && f.highProfitCount <= f.uniqueBuyerCount;
  let wallet = 'unknown';
  if (usable) {
    if (f.highProfitCount > 0) {
      if (count(d.profileCheckedCount) && d.profileCheckedCount >= f.highProfitCount) wallet = 'verified_profit';
    } else wallet = f.uniqueBuyerCount === 0 ? 'no_buyers' : f.smartMoneyCount > 0 ? 'tagged_only' : 'other_buyers';
  }
  return { narrative, narrativeLabel: labels[narrative], wallet, walletLabel: labels[wallet] };
}

export function reviewEntryEvidence(rounds, nowMs) {
  const groups = new Map();
  for (const r of rounds) {
    if (!r?.entry || !Number.isFinite(r.entry.atMs) || !Number.isFinite(r.at)
      || r.entry.atMs > r.at || r.at > nowMs || !Number.isFinite(r.pnl)) continue;
    const c = classifyEntryEvidence(r.entry), chain = r.entry.chain || 'unknown';
    const evidence = r.entry.entryEvidence || {}, setup = evidence.opportunity?.id || 'unknown';
    const entryPolicyVersion = evidence.opportunity?.entryPolicyVersion || evidence.entryPolicyVersion || 'legacy_unknown';
    const flowProvider = evidence.flowDiagnostics?.provider || 'unknown';
    const costPolicyVersion = evidence.costAssumptions?.version || 'legacy_unknown';
    const exitPolicyVersion = evidence.memeExitPolicy?.version || evidence.exitExperiment?.version || evidence.exitPolicy?.version || 'legacy_unknown';
    const key = JSON.stringify([chain, setup, entryPolicyVersion, exitPolicyVersion, costPolicyVersion, flowProvider, c.narrative, c.wallet]);
    if (!groups.has(key)) groups.set(key, { chain, setup, entryPolicyVersion, exitPolicyVersion, costPolicyVersion, flowProvider, ...c, closedRounds: 0, wins: 0, losses: 0,
      netPnlUsd: 0, modelCostsUsd: 0, costsComplete: true, entryIds: [] });
    const g = groups.get(key), fills = [r.entry, ...r.exits];
    g.closedRounds++; g.wins += Number(r.pnl > 0); g.losses += Number(r.pnl < 0); g.netPnlUsd += r.pnl;
    g.costsComplete &&= fills.every(t => Number.isFinite(t.costsUsd) && t.costsUsd >= 0);
    g.modelCostsUsd += fills.reduce((n, t) => n + (Number.isFinite(t.costsUsd) ? t.costsUsd : 0), 0);
    g.entryIds.push(r.entry.id);
  }
  return { version: EVIDENCE_REVIEW_VERSION, mode: 'frozen_entry_descriptive', automaticParameterChanges: false,
    groups: [...groups.values()].map(g => ({ ...g, modelCostsUsd: g.costsComplete ? g.modelCostsUsd : null,
      grossPricePnlUsd: g.costsComplete ? g.netPnlUsd + g.modelCostsUsd : null, winRate: g.wins / g.closedRounds })),
    note: '只按买入时冻结的证据分组；事后补叙事不回填。仅含完整原仓，含跨批成本，净额已扣模型成本；各组非随机对照，不能推导因果或稳定胜率。无净买仅指可见采集样本。' };
}
