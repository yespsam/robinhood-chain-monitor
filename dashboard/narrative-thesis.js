const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const percent=v=>typeof v==='number'&&Number.isFinite(v)?`${(v*100).toFixed(2)}%`:'未完成观察';
const source=s=>{try{const u=new URL(s.url);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.port)
  return `<a href="${esc(u.href)}" target="_blank" rel="noopener noreferrer">原文出处</a>`;}catch{}return '出处待核实';};

export function renderNarrativeThesis(t,{entrySnapshot=false}={}) {
  if(!t)return '';
  const agentic=t.agenticWallet;
  const rows=[['叙事判断',t.conclusion],['事件主张',`${t.event?.label} · ${t.event?.claimStatus}`],
    ['原文摘录',t.event?.excerpt||'未取得原文'],['CA 对应关系',t.relationship?.label],
    ['催化阶段',t.catalyst?.label],['为什么可能带来资金',t.event?.mechanism],
    ['事件到资金的验证链',`${t.thesisCard?.tokenValueCapture||'代币价值捕获未知'}；${t.thesisCard?.marketConfirmation||'买盘承接待核实'}；${t.thesisCard?.interpretation||''}`],
    ['新仓叙事闸门',t.admission?.ready?'通过':(t.admission?.blockers||['仅作研究，未形成入场许可']).join('；')],
    ['Binance 资格区分',agentic?`${agentic.explanation}；合格成功买入数：${agentic.qualifyingCandidateBuys===null?'null（未核实）':agentic.qualifyingCandidateBuys}`:'未分析'],
    ['还要核实什么',t.event?.verification],['后续传播',t.propagation?.summary],
    ['买盘承接',t.demand?.summary],['量价状态',t.market?.summary],['失效 / 待复核',t.invalidation?.observed],
    ['以往同 CA 案例',t.history?.samples?`${t.history.samples} 次已完成观察，24小时价格变化中位数 ${percent(t.history.medianReturn24h)}；未扣成本、不是预测。`:'尚无可比较的完成样本，不生成胜率。']];
  return `<section class="strategy-proof"><p><strong>${entrySnapshot?'入场时叙事快照':'当前叙事证据链'}</strong> · ${esc(t.method)}</p>${rows.map(([k,v])=>`<p><span>${esc(k)}</span>${esc(v||'待核实')}</p>`).join('')}
    <p>${(t.sources||[]).slice(0,3).map(source).join(' · ')}</p></section>`;
}

export function renderNarrativeDesk(desk,expanded=new Set()) {
  if(!desk)return '';
  const stage=desk.stageReport,admission=desk.admission;
  return `<section class="research-department"><div><strong>叙事研究 · 证据链</strong><span>${esc(desk.method)}</span></div>
    <p>本轮分析 ${esc(desk.candidates)} 个 CA，有原文关联 ${esc(desk.withSources)} 个；明确 CA / 官方目录 ${esc(desk.directCa)} 个，社区题材关联 ${esc(desk.communityLinked)} 个。${esc(desk.note)}</p>
    ${admission?`<p><strong>新仓叙事闸门 ${admission.enabled?'已启用':'仅研究'}</strong> · ${esc(admission.ready)} / ${esc(admission.evaluated)} 个候选满足完整证据链，${esc(admission.blocked)} 个暂缓；Agentic / .ai 限定主张 ${esc(admission.agenticClaims)} 个，其中已核实身份及成功 CA 买入 ${esc(admission.verifiedAgenticWalletBuys)} 个。${(admission.topBlockers||[]).slice(0,3).map(x=>`<span> · ${esc(x.reason)}（${esc(x.count)}）</span>`).join('')}</p>`:''}
    <p>历史原文关联案例 ${esc(stage?.associated??0)} 个，其中事后关联 ${esc(stage?.retrospective??0)} 个；未把事后故事填回历史买单。</p>
    ${desk.twitter?`<p><strong>独立推特叙事源</strong> · ${(desk.twitter.targets||[]).map(t=>`@${esc(t.handle)}：${t.fresh?'采集正常':t.status==='error'?'采集异常':'待刷新 / 部分可用'}`).join(' · ')}。已核验 ${esc(desk.twitter.count)} 条，其中回复 / 引用 ${esc(desk.twitter.contextPending)} 条待上下文核实。${desk.twitter.lastError?`采集保存异常：${esc(desk.twitter.lastError)}`:''}</p><p>${esc(desk.twitter.note)}</p>
      ${(desk.twitter.posts||[]).slice(0,6).map(p=>`<p>@${esc(p.author)} · ${esc(new Date(p.at).toLocaleString('zh-CN'))} · ${p.isReply||p.isQuote?'回复 / 引用，上下文待核实':'作者原帖'}：${esc(p.text.slice(0,280))} · ${source(p)}</p>`).join('')}`:''}
    ${(stage?.groups||[]).slice(0,6).map(g=>`<p>${esc(g.label)} · ${esc(g.phaseText)} · ${g.binding==='verified_ca'?'明确 CA 关联':'项目链接关联，非作者认领'}：${esc(g.samples)} 个案例 / ${esc(g.uniqueTokens)} 个代币，已完成 ${esc(g.completed24h)} 个；24小时变化中位数 ${esc(percent(g.medianReturn24h))}。${g.knowledge==='retrospective_association'?'事后关联，仅研究。':'记录时已有来源关联。'}</p>`).join('')}
    <p>以上为价格观察，未扣成本，不证明叙事导致上涨，也不自动修改参数。</p>
    ${(desk.cases||[]).slice(0,4).map(t=>`<details data-narrative-case="${esc(`${t.chain}:${t.address}`)}"${expanded.has(`${t.chain}:${t.address}`)?' open':''}><summary>${esc(t.symbol)} · ${esc(t.chain)} · ${esc(t.conclusion)}</summary><p class="contract-address">${esc(t.address)}</p>${renderNarrativeThesis(t)}</details>`).join('')||'<p>本轮没有足够的原文与 CA 对应证据，不编造分析。</p>'}</section>`;
}
