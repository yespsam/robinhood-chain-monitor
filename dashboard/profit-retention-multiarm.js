const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const validCount = value => Number.isSafeInteger(value) && value >= 0;
const money = value => finite(value) ? `${value > 0 ? '+' : ''}${value.toFixed(3)} U` : '未知';
const count = value => validCount(value) ? String(value) : '未知';
const cash = value => finite(value) && value >= 0 ? `${value.toFixed(3)} U` : '未知';
const fraction = value => finite(value) && value >= 0 && value <= 1 ? `${(value * 100).toFixed(1)}%` : '未知';
const currentVersion = 'profit_retention_multiarm_v3';
const multiples = [2, 3, 5];
const sameArray = (a, b) => Array.isArray(a) && a.length === b.length && a.every((x, i) => x === b[i]);

// A partial or old snapshot cannot be presented as a comparable ranking.
function comparable(study) {
  if (study.version !== currentVersion || study.pairedCohort !== true
    || !sameArray(study.policy?.triggerPriceMultiples, multiples)
    || !Array.isArray(study.arms)
    || !sameArray(study.arms.map(a => a?.multiple), multiples)) return false;
  const counts = ['closedPairs', 'openPairs', 'excludedPairs', 'ineligibleEntries'];
  if (!counts.every(k => validCount(study[k]) && study.arms.every(a => a[k] === study[k]))) return false;
  if (!study.arms.every(a => a.policy?.triggerPriceMultiple === a.multiple)) return false;
  if (study.closedPairs > 0) {
    const baseline = study.arms[0].performance?.controlNetUsd;
    if (!finite(baseline) || !study.arms.every(a => a.performance?.completedRounds === study.closedPairs
      && a.performance.controlNetUsd === baseline)) return false;
  }
  return true;
}

export function profitRetentionStatus(study) {
  if (!study || study.status === 'not_loaded') return '尚未加载';
  if (study.version && study.version !== currentVersion) return '旧版对照 · 待升级';
  if (study.status === 'disabled') return '未启用';
  if (study.status === 'error') return '故障 · 保留检查点';
  if (!comparable(study)) return '三组同源性待核对';
  if (study.admissionStopped || study.status === 'admission_stopped') return '已达样本上限 · 不再接收新仓';
  return study.status === 'observing' ? '三组前向观察 · 尚未验证增益' : '状态待核对';
}

export function renderProfitRetention(study) {
  const boundary = '<p class="section-note">2／3／5 倍同入场三组独立影子对照，不改变主盘买卖、余额或仓位。只配对启用后的同一笔实际模拟买入；既有仓位不回填。三组是互斥的假设结果，不能相加，结果不与主盘收益相加。</p>';
  if (!study || study.status === 'not_loaded') return `${boundary}<p class="section-note">当前运行实例尚未加载此项前向对照，没有可报告的实验收益。网页展示不代表后端已经启用。</p>`;
  if (study.version && study.version !== currentVersion) return `${boundary}<p class="section-note">当前后端仍是旧版对照，不是三倍数同源比较。旧证据单独保留，不迁移成绩、不自动启用新版。</p>`;
  if (study.status === 'disabled') return `${boundary}<p class="section-note">对照未启用，尚无本次观察结果；未自动重启或切换主盘策略。</p>`;
  const error = study.status === 'error' ? `<p class="section-note">对照已冻结：${esc(study.error || '检查点或数据连续性待核对')}。保留已有证据，不把缺口视为连续运行。</p>` : '';
  if (!comparable(study)) return `${boundary}${error}<p class="section-note">三组规则、样本或共同基准尚未核对，暂不展示收益比较；缺组不能补零，也不从旧单组推断三组成绩。</p>`;
  const policy = '<p class="section-note">固定比较入场价格的 2 倍、3 倍、5 倍：各自触发后，下一条更新且新鲜的共同报价仍满足条件，才模拟按净回款收回原始全部投入（含入场费用）。余仓沿用同一主盘最终退出；每次卖出另计完整 Gas、手续费及模型滑点。不假定成交在阈值或峰顶，不自动选择赢家或切换主盘。</p>';
  const results = study.closedPairs > 0 ? `<p class="section-note">共同原退出基准：${money(study.arms[0].performance.controlNetUsd)}，${count(study.closedPairs)} 个已平配对；未触发的回合也计入每组。基准只计一次，不是三份利润。</p>
    <div class="trades-scroll"><table><thead><tr><th>回本倍数</th><th>已平配对</th><th>已回本 / 未回本</th><th>本组净收益</th><th>较原退出增减</th><th>本组模型总成本</th><th>额外模型成本</th><th>少赚回合 / 少赚金额</th></tr></thead><tbody>${study.arms.map(a => {
      const p = a.performance;
      return `<tr><td>${a.multiple} 倍</td><td>${count(p.completedRounds)}</td><td>${count(p.recoveries)} / ${count(p.unrecoveredRounds)}</td><td>${money(p.treatmentNetUsd)}</td><td>${money(p.deltaNetUsd)}</td><td>${cash(p.treatmentCostsUsd)}</td><td>${money(p.extraCostsUsd)}</td><td>${count(p.foregoneUpsideRounds)} / ${cash(p.foregoneUpsideUsd)}</td></tr>`;
    }).join('')}</tbody></table></div>
    <div class="trades-scroll"><table><thead><tr><th>倍数</th><th>已平回合累计回撤</th><th>最大盈利 CA 占比</th><th>剔除最大盈利 CA 后净收益</th><th>有覆盖缺口的已平配对</th></tr></thead><tbody>${study.arms.map(a => {
      const p = a.performance, c = p.caRobustness?.treatment;
      return `<tr><td>${a.multiple} 倍</td><td>${cash(p.closedRoundDrawdown?.treatmentMaxDrawdownUsd)}</td><td>${fraction(c?.largestPositiveCAShare)}</td><td>${money(c?.netExcludingLargestPositiveCAUsd)}</td><td>${count(p.completedWithCoverageGaps)}</td></tr>`;
    }).join('')}</tbody></table></div><p class="section-note">回撤按完整回合结束顺序累计，不是实时资金曲线或最大持仓回撤；少赚金额包含相对原退出的净收益损失，不声称能在市场峰顶卖出。</p>`
    : '<p class="section-note">尚无完整配对平仓，各组净收益差为未知，不能记作零收益或优化成功。</p>';
  const active = study.arms.flatMap(a => (Array.isArray(a.active) ? a.active : []).map(row => `<tr><td>${a.multiple} 倍</td><td>${esc(row.chain)}<br>${esc(row.address)}</td><td>${row.partialTaken ? '已模拟回收本金' : '尚未回收本金'}</td><td>${cash(row.recoveredPrincipalUsd)} / ${cash(row.principalTargetUsd)}</td><td>${fraction(row.remainingFraction)}</td><td>${money(row.treatmentTotalIfLiquidatedUsd)}</td></tr>`)).join('');
  const positions = active ? `<div class="trades-scroll"><table><thead><tr><th>倍数</th><th>链 / CA</th><th>处理状态</th><th>回收净现金 / 原始投入</th><th>剩余原仓比例</th><th>已兑现＋余仓估算总盈亏</th></tr></thead><tbody>${active}</tbody></table></div><p class="section-note">同一入场展示三组假设，不是三笔主盘买入。回收净现金不是利润，不与已实现盈亏重复相加。未平仓不计入已平成绩；报价缺失或过期显示未知，余仓仍可能归零并产生退出费用。</p>` : '';
  return `${boundary}${error}${policy}${results}${positions}<p class="section-note">同源未平配对 ${count(study.openPairs)}；排除回合 ${count(study.excludedPairs)}；不合格入场 ${count(study.ineligibleEntries)}。共同报价／观察缺口 ${count(study.sharedCoverage?.gapCount)}，不将三组重复计数；各组自身记录（含共享报价问题和组内回本限制，不相加）：${study.arms.map(a => `${a.multiple} 倍 ${count(a.coverage?.gapCount)}`).join(' / ')}。配对闭合不等于行情覆盖完整；“未触发”仅指已观察报价，漏观察区间未知。必须保留亏损、未回本、少赚和额外费用，少量正收益不证明稳定盈利。</p>`;
}
