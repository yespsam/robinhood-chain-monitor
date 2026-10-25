const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const money = value => finite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(3)} U` : '未知';
const count = value => Number.isSafeInteger(value) && value >= 0 ? String(value) : '未知';
const cash = value => finite(value) && value >= 0 ? `${value.toFixed(3)} U` : '未知';
const fraction = value => finite(value) && value >= 0 && value <= 1 ? `${(value*100).toFixed(1)}%` : '未知';
const currentVersion = 'profit_retention_principal_v2';

export function profitRetentionStatus(study) {
  if (!study || study.status === 'not_loaded') return '尚未加载';
  if (study.version && study.version !== currentVersion) return '旧版对照 · 待升级';
  if (study.status === 'disabled') return '未启用';
  if (study.status === 'error') return '故障 · 保留检查点';
  if (study.admissionStopped || study.status === 'admission_stopped') return '已达样本上限 · 不再接收新仓';
  return study.status === 'observing' ? '前向观察 · 尚未验证增益' : '状态待核对';
}

export function renderProfitRetention(study) {
  const boundary = '<p class="section-note">独立影子对照，不改变主盘买卖、余额或仓位。只配对启用后的同一笔实际模拟买入；既有仓位不回填，结果不与主盘收益相加。</p>';
  if (!study || study.status === 'not_loaded') return `${boundary}<p class="section-note">当前运行实例尚未加载此项前向对照，没有可报告的实验收益。网页展示不代表后端已经启用。</p>`;
  if (study.version && study.version !== currentVersion) return `${boundary}<p class="section-note">当前后端仍是旧版对照，不是倍数回本留仓规则。旧证据单独保留，不迁移成绩、不自动启用新版。</p>`;
  if (study.status === 'disabled') return `${boundary}<p class="section-note">对照未启用，尚无本次观察结果；未自动重启或切换主盘策略。</p>`;
  const error = study.status === 'error' ? `<p class="section-note">对照已冻结：${esc(study.error || '检查点或数据连续性待核对')}。保留已有证据，不把缺口视为连续运行。</p>` : '';
  const multiple = [2,3,5].includes(study.policy?.triggerPriceMultiple) ? study.policy.triggerPriceMultiple : null;
  const policy = multiple === null ? '<p class="section-note">冻结的价格倍数尚未核对，不能宣称本金回收规则已生效。</p>'
    : `<p class="section-note">预先固定的试验：报价达到入场价格的 ${multiple} 倍后，等待下一条更新且新鲜的报价仍满足条件，按该次观察价计算最少卖出数量，使扣除卖出费用后的净回款覆盖原始全部投入（含入场费用）；剩余筹码跟随主盘实际退出。净回款不等于已实现利润，回本后余仓也可能归零。每次卖出另计完整 Gas、手续费及模型滑点；不假定成交在阈值或峰顶。</p>`;
  const p = study.performance;
  const complete = Number.isSafeInteger(study.closedPairs) && study.closedPairs > 0 && p;
  const results = complete ? `<div class="trades-scroll"><table><thead><tr><th>相同完整回合</th><th>原退出净收益</th><th>回本留仓净收益</th><th>净收益差</th><th>额外模型成本</th><th>不同 CA</th></tr></thead><tbody><tr><td>${count(study.closedPairs)}</td><td>${money(p.controlNetUsd)}</td><td>${money(p.treatmentNetUsd)}</td><td>${money(p.deltaNetUsd)}</td><td>${money(p.extraCostsUsd)}</td><td>${count(p.distinctCAs)}</td></tr></tbody></table></div>` : '<p class="section-note">尚无完整配对平仓，净收益差为未知，不能记作零收益或优化成功。</p>';
  const active = Array.isArray(study.active) ? study.active.map(row => `<tr><td>${esc(row.chain)}<br>${esc(row.address)}</td><td>${row.partialTaken ? '已模拟回收本金' : '尚未回收本金'}</td><td>${cash(row.recoveredPrincipalUsd)} / ${cash(row.principalTargetUsd)}</td><td>${fraction(row.remainingFraction)}</td><td>${money(row.controlUnrealizedNetUsd)}</td><td>${money(row.treatmentTotalIfLiquidatedUsd)}</td></tr>`).join('') : '';
  const positions = active ? `<div class="trades-scroll"><table><thead><tr><th>链 / CA</th><th>处理状态</th><th>回收净现金 / 原始投入</th><th>剩余原仓比例</th><th>原退出当前净浮盈亏</th><th>实验已兑现＋余仓估算总盈亏</th></tr></thead><tbody>${active}</tbody></table></div><p class="section-note">回收净现金不是利润，不与已实现盈亏重复相加。未平仓不计入完整回合成绩；报价缺失或过期显示未知。估算不等于可实现成交。</p>` : '';
  return `${boundary}${error}${policy}${results}${positions}<p class="section-note">未平仓配对 ${count(study.openPairs)}；排除回合 ${count(study.excludedPairs)}；不合格入场 ${count(study.ineligibleEntries)}；覆盖缺口 ${count(study.coverage?.gapCount)}。必须连同卖飞、亏损和额外费用一起评价，少量正收益不证明稳定盈利。</p>`;
}
