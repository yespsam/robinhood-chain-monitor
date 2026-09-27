const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const usd = value => Number.isFinite(value) ? `${value>=0?'+':''}${value.toFixed(2)} U` : '未知';
const evidenceRows = review => !review ? '' : `<p class="section-note">入场证据分组：${esc(review.note)}</p><div class="trades-scroll"><table><thead><tr><th>链 / 路线</th><th>叙事关联</th><th>钱包证据</th><th>完整原仓</th><th>扣成本净额</th></tr></thead><tbody>${review.groups.map(g=>`<tr><td>${esc(g.chain)} / ${esc(g.setup)}</td><td>${esc(g.narrativeLabel)}</td><td>${esc(g.walletLabel)}</td><td>${esc(g.closedRounds)}</td><td>${esc(usd(g.netPnlUsd))}</td></tr>`).join('')}</tbody></table></div>`;
export function renderTradeCountReview(s) {
  if (!s) return '<p class="section-note">百笔成交复盘等待初始化。</p>';
  if (s.status==='error') return `<p class="section-note">${esc(s.error)}</p>`;
  const latest=s.latestReport;
  return `<p class="section-note">本地百笔复盘：本批 ${esc(s.pendingFills)} / ${esc(s.batchSize)} 笔，距下一次 ${esc(s.remainingFills)} 笔；已完成 ${esc(s.completedBatches)} 批。买入、卖出各计一笔，仅计启用后的主模拟盘成交，对照盘不累加。不到 100 笔不触发；不定时调用 AI，不自动改参数。</p>`
    +(s.evidenceReviewVersion ? '<p class="section-note">新批次增加买入时的叙事与钱包证据分组；旧报告保留原样，事后补查不回填买入依据。</p>' : '')
    +(latest ? `<details><summary>最近一批复盘 · 第 ${esc(latest.sequence)} 批</summary><p class="section-note">买入 ${esc(latest.buys)} / 卖出 ${esc(latest.sells)}；本批已实现 ${esc(usd(latest.windowRealizedPnlUsd))}，模型成本 ${esc(usd(latest.modelCostsUsd))}（不再次扣除）。完整平仓 ${esc(latest.review.overall.closedRounds)} 个，胜率 ${Number.isFinite(latest.review.overall.winRate)?esc((latest.review.overall.winRate*100).toFixed(1))+'%':'暂无'}。${esc(latest.note)}</p><div class="trades-scroll"><table><thead><tr><th>链 / 逻辑 / 版本</th><th>完整原仓</th><th>扣成本净额</th></tr></thead><tbody>${latest.review.cohorts.map(c=>`<tr><td>${esc(c.chain)} / ${esc(c.setupId)} / ${esc(c.opportunityVersion)}</td><td>${esc(c.closedRounds)}</td><td>${esc(usd(c.netPnlUsd))}</td></tr>`).join('')}</tbody></table></div>${evidenceRows(latest.evidenceReview)}</details>` : '<p class="section-note">尚无满 100 笔的新批次；未平仓浮盈不当作已实现盈利。</p>');
}
