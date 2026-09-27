// Auxiliary provider metrics are not a contract audit. A user-authorized,
// small PVP paper experiment may keep unavailable auxiliary fields unknown.
// Known danger, invalid values, tax and core sell/authority checks stay blocking.
export const PAPER_TAX_FILTER_VERSION = 'scan_tax_cap_6pct_v1';
export const PAPER_MAX_TAX_RATE = .06;
export const PAPER_TAX_FILTER_TEXT = '扫描过滤买入税或卖出税大于 6% 的 CA；恰好 6% 不因税率上限过滤，税率未知需补齐后再检查，已有持仓继续监控和退出。';
// Provider tax fields use fractions: .06 means 6%. Never guess the unit or
// coerce missing values, booleans or containers into zero-tax evidence.
export function paperTaxRate(value) {
  if (!['number', 'string'].includes(typeof value) || typeof value === 'string' && !value.trim()) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null;
}
export function paperTaxScreen(token = {}) {
  const buyTax = paperTaxRate(token?.buyTax), sellTax = paperTaxRate(token?.sellTax);
  const reasons = [], missing = [];
  for (const [rate, label] of [[buyTax, '买入税'], [sellTax, '卖出税']]) {
    if (rate === null) missing.push(label);
    else if (rate > PAPER_MAX_TAX_RATE) reasons.push(`${label}超过 6%（当前 ${Number((rate * 100).toFixed(8))}%）`);
  }
  return { version: PAPER_TAX_FILTER_VERSION, maximumRate: PAPER_MAX_TAX_RATE,
    buyTax, sellTax, blocked: reasons.length > 0, reasons, missing };
}

export const PAPER_AUX_AUDIT_VERSION = 'pvp_aux_audit_v1';
const auxiliary = [
  ['isWashTrading', '洗量检测'], ['rugRatio', '撤池风险比'], ['top10HolderRate', 'Top10 集中度'],
  ['devTeamHoldRate', '开发团队持仓'], ['bundlerRate', '打包买入占比'],
];
export function unavailablePaperAuditFields(token, safety) {
  return auxiliary.filter(([field, label]) => safety.missing.includes(label)
    && (token[field] === null || token[field] === undefined || token[field] === '')).map(([, label]) => label);
}
export function paperSafetyForEntry(token, safety, enabled) {
  const auditMissing = enabled ? unavailablePaperAuditFields(token, safety) : [];
  return { ...safety, missing: safety.missing.filter(label => !auditMissing.includes(label)),
    auditMissing, auditComplete: safety.missing.length === 0, policyVersion: enabled ? PAPER_AUX_AUDIT_VERSION : 'strict_fields_v1',
    ...(auditMissing.length ? { coverage: '基础交易检查仍必需；辅助审计字段未提供，仅允许小额 PVP 模拟，不代表已通过安全审计' } : {}) };
}

export const MONITORED_PAPER_SAFETY_VERSION='monitored_paper_unknown_audit_v1';
const eventAuditFields=[...auxiliary,['isHoneypot','可卖出检测'],['renouncedMint','增发权限已撤销'],['renouncedFreezeAccount','冻结权限已撤销']];
const eventWarnings=new Set(['洗量检测未通过','撤池风险比超过筛选线','Top10 集中度超过筛选线','开发团队持仓超过筛选线','打包买入占比超过筛选线']);
export function monitoredPaperSafety(token,safety,enabled) {
  const auditMissing=enabled?eventAuditFields.filter(([field,label])=>safety.missing.includes(label)
    &&[undefined,null,''].includes(token[field])).map(([,label])=>label):[];
  const warnings=enabled?safety.blocked.filter(label=>eventWarnings.has(label)):[];
  return {...safety,missing:safety.missing.filter(label=>!auditMissing.includes(label)),
    blocked:safety.blocked.filter(label=>!warnings.includes(label)),warnings,
    sourceMissing:[...safety.missing],sourceBlocked:[...safety.blocked],auditMissing,
    auditComplete:safety.missing.length===0,policyVersion:enabled?MONITORED_PAPER_SAFETY_VERSION:'strict_fields_v1',
    sellabilityVerified:false,
    coverage:enabled?'监控事件模拟实验：缺失审计字段保留未知，集中度等代理指标只记录；不代表安全或已经验证可卖出。明确交易禁用标记、税费与数据完整性仍检查。':safety.coverage};
}
