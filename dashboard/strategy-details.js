import { renderNarrativeThesis } from './narrative-thesis.js';
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = value => typeof value === 'number' && Number.isFinite(value);
export const exactPrice = value => number(value) && value > 0 ? `$${Number(value.toPrecision(7)).toString()}` : '待确认';
const safeLink = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; } catch { return null; } };

export function renderStrategyDetails(plan, narrative, position = null, decision = position?.entryEvidence?.traderDecision) {
  if(position?.memeExitPolicy || !position&&['meme_evidence_exit_v1','meme_evidence_exit_v2'].includes(plan?.effectiveExitPolicyVersion)){
    const status=position?.thesisStatus;
    const recovery=position?.evidenceGapPolicy?.version==='evidence_gap_exit_v1';
    const gap=position?.evidenceGap;
    const rows=[['实际退出方式',recovery?'叙事与资金行为退出，加已授权的证据中断退出；不按固定持仓时长卖出':'叙事与资金行为退出；无固定百分比、倍数或时间触发'],
      ...(recovery?[['证据中断保护',`连续五分钟无法取得量价与有效地址行为证据，须新鲜真实报价才模拟退出；有效证据恢复则清零。${gap?`已观测 ${Math.floor((gap.lastObservedAt-gap.since)/1000)} 秒。`:'尚未开始断流计时。'}`]]:[]),
      ...(plan?.entryPolicyVersion==='meme_structure_entry_v1'?[['实际买入规则','取消固定 6% 结构距离门槛；形态、报价与成本条件仍须通过']]:[]),
      ...(['alpha_event_entry_v1','monitored_event_entry_v1'].includes(plan?.entryPolicyVersion)?[['实际买入规则',plan.summary],['事件入口价格目标','不设固定止盈止损；不虚构历史结构目标或盈亏比']]:[]),
      ['当前持有 / 退出依据',position?.markStatus==='stale'?'报价过期，等待更新；不能确认仍有效':position?.exitStatus?.holdReason||'候选预案，尚未持仓'],
      ...(position?.memeExitPolicy?.version==='meme_evidence_exit_v2'?[['动态结构观察位',position.structureTrail
        ?`${exactPrice(position.structureTrail.level)} · 入场后抬高低点，右侧两根收盘确认；非保证卖价`
        :'尚未出现已确认的抬高低点；不能按盘中最高价移动'],
        ...(status?.comparison?[['旧规则同刻对照',`${status.comparison.exit?'退出':'继续观察'}：${status.comparison.reason}（只比决策，不虚构收益）`]]:[])]:[]),
      ['叙事后续',status?.narrative?.summary||'等待入场后绑定此 CA 的原文，不按币名推断'],
      ['聪明钱进出',status?.flow?.summary||'等待同源完整地址流水；标签不等于核实盈利'],
      ['筹码 / 操盘推测',status?.operator?.summary||'庄家身份、共同控制与完整持仓变化未核实'],
      ...(['alpha_event_entry_v1','monitored_event_entry_v1'].includes(plan?.entryPolicyVersion)?[]:[['入场筛选参考',`结构价 ${exactPrice(plan?.stopPrice)} / 参考位 ${exactPrice(plan?.targetPrice)}，仅用于入场测算，不是退出触发价或最大亏损保证`]])];
    const sources=(status?.narrative?.followups||[]).flatMap(s=>{const url=safeLink(s.sourceUrl);return url?[`<p><a href="${escape(url)}" target="_blank" rel="noopener noreferrer">后续原文</a> ${escape(s.text)}</p>`]:[];});
    return `${renderNarrativeThesis(position?.entryEvidence?.narrativeThesis,{entrySnapshot:true})}<div class="strategy-proof">${rows.map(([label,value])=>`<p><span>${escape(label)}</span>${escape(value)}</p>`).join('')}${sources.join('')}</div>`;
  }
  const upside = !!position?.upsidePolicy || plan?.exitPolicyVersion === 'asymmetric_upside_v1';
  const confirmed = plan?.confirmedPolicyVersion === 'confirmed_pvp_v2';
  const reviewed=(position?.pvpPolicy?.version || plan?.exitPolicyVersion)==='structure_hold_v2';
  const evidenceHold = reviewed || (position?.pvpPolicy?.version || plan?.exitPolicyVersion) === 'evidence_hold_v1';
  const holdingState = position?.markStatus === 'stale' ? '报价过期，退出判断待更新；不模拟成交'
    : position?.exitStatus?.holdingMode || (evidenceHold ? '按价格与资金流证据持有，无固定时限' : '按入场时规则检查退出');
  const pvp = !!position?.pvpPolicy || plan?.exitPolicyVersion === 'fast_pvp_v1' || confirmed;
  const diagnostic = plan?.diagnosticVersion === 'paper_diagnostic_entry_v1';
  const baseline = position?.entryEvidence?.diagnostic?.baseline;
  const sources = (Array.isArray(narrative?.sources) ? narrative.sources : []).slice(0, 2).flatMap(row => {
    const url = safeLink(row.sourceUrl);
    return url ? [`<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(row.authorLabel || '查看原文')}</a>`] : [];
  });
  const decisionSource = safeLink(decision?.sourceUrl);
  if (!sources.length && decisionSource) sources.push(`<a href="${escape(decisionSource)}" target="_blank" rel="noopener noreferrer">查看决策出处</a>`);
  const compact = decision?.version === 'evidence_first_v1' && Array.isArray(decision.questions);
  const lines = compact ? [
    ...decision.questions.slice(0, 4).map(q => [q.label, q.text]),
    ...(reviewed ? [['入场保本涨幅',number(plan?.economics?.breakEvenRate)?`${(plan.economics.breakEvenRate*100).toFixed(2)}%（含模型成本）`:'待确认'],
      ['空间依据',`${exactPrice(plan?.targetPrice)} · ${plan?.targetKind||'待确认'}`]] : []),
    ...(position ? [['当前止损线', exactPrice(position.activeStopPrice)], ['持仓状态', holdingState],
      ...(evidenceHold ? [['本轮持仓依据', position.markStatus === 'stale' ? '等待新鲜报价；缺失数据不代表趋势仍然成立。' : position.exitStatus?.holdReason || '等待首次持仓检查']] : [])] : []),
  ] : [
    ['叙事主线', narrative?.theme || '未确认主线'],
    ['出处与时效', narrative ? `${narrative.quality} · ${narrative.phase}` : '缺少可核实来源'],
    ['原文主张（非事实确认）', narrative?.event || '暂无原始内容'],
    ['资金逻辑（研究假设）', narrative?.mechanism || '等待资金证据'],
    ['叙事判断依据', narrative?.gaps?.length ? narrative.gaps.join('；') : narrative?.eligible ? '出处与时效门槛通过，内容仍需独立核实' : '等待核实'],
    ['买点形态', plan?.setup || '等待已收盘 K 线'],
    ['确认买入区间', plan?.entryZone ? `${exactPrice(plan.entryZone.low)}–${exactPrice(plan.entryZone.high)}` : '待确认，不给假点位'],
    [confirmed ? '价格止损线' : diagnostic ? '诊断止损价' : '结构止损价', exactPrice(position?.activeStopPrice ?? plan?.stopPrice)],
    [diagnostic || confirmed ? '成本情景（非市场目标）' : upside || pvp ? '结构参考位（不触发减仓）' : '首档止盈价（兑现原仓 20%）', plan?.targetPrice ? `${exactPrice(plan.targetPrice)} · ${plan.targetKind}` : '待确认'],
    ...(diagnostic ? [['试单性质', '主账户模拟诊断，未通过原策略不拦截；不标为审计通过'],
      ['原策略未过条件', baseline ? [...baseline.missing, ...baseline.reasons].join('；') || '无' : '详见每笔入场证据']] : []),
    ...(pvp ? [['PVP 兑现规则', reviewed ? '历史结构参考位且净盈利时兑现 20%；2 / 3 倍各兑现 30%，留 20% 尾仓' : '2 / 3 倍分别兑现原仓 50% / 30%；尾仓最多原仓 20%，不在小幅参考位减仓'],
      ['持仓阶段', evidenceHold ? holdingState : position?.exitStatus?.holdingMode || (confirmed ? '120 秒价格停滞检查；主仓最长 5 分钟，强势尾仓最多 20 分钟' : '45 秒检验成本后盈利；主仓最长 3 分钟，强势尾仓自开仓起最多 20 分钟')]] : []),
    ...(upside ? [['大行情兑现规则', '3 / 10 / 30 倍各兑现原仓 20%；剩余 40% 跟随趋势，不设固定倍数清仓'],
      ['持仓阶段', position?.exitStatus?.holdingMode || '强势可延长、弱势到期退出；最长 7 天']] : []),
    ['成本后目标 / 损失', number(plan?.netRewardRisk) ? `${plan.netRewardRisk.toFixed(2)} 倍（不是胜率）` : '待确认'],
    ['确认状态', diagnostic || confirmed ? plan?.summary : position ? `${position.profitProtectionArmed ? '剩余本金保护已启动' : '按结构止损'}；${position.exitStatus?.flowStatus || '等待下一轮退出检查'}` : plan?.reasons?.length ? plan.reasons.join('；') : plan?.eligible ? '形态通过，还需资金、叙事和安全条件共同通过' : plan?.summary || '等待数据'],
  ];
  return `<div class="strategy-proof">${lines.map(([label, value]) => `<p><span>${escape(label)}</span>${escape(value)}</p>`).join('')}${sources.length ? `<p class="proof-sources">${sources.join(' · ')}</p>` : ''}</div>`;
}
