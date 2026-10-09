// A read-only view of recorded evidence and scheduler state, not model thoughts.
import { buildCaDesk, caKey } from './ca-desk.js';
import { entryStatus, renderEntryStatus } from './entry-status.js';

const rows = v => Array.isArray(v) ? v : [];
const stamp = v => typeof v === 'number' ? v : Date.parse(v || '');
const fresh = (v, now, age = 15000) => Number.isFinite(stamp(v)) && stamp(v) <= now && now-stamp(v) <= age;
const esc = v => String(v ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const value = v => Number.isFinite(v) ? v.toLocaleString('zh-CN',{maximumFractionDigits:2}) : '未知';
const brief = (v,n=150) => typeof v === 'string' ? v.length>n ? v.slice(0,n)+'…' : v : '';
const clock = v => Number.isFinite(stamp(v)) ? new Date(stamp(v)).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}) : '时间未知';
const chain = c => ({sol:'Solana',bsc:'币安链',base:'Base',eth:'以太坊',robinhood:'Robinhood'})[c] || c || '链未知';
const short = a => typeof a==='string' && a.length>14 ? a.slice(0,6)+'…'+a.slice(-5) : a || 'CA 未记录';
const depts = [
  ['news','消息感知','原始事件'],['narrative','叙事关联','事件 → 代币'],['wallet','资金研究','地址与筹码'],
  ['market','量价研究','结构与报价'],['decision','决策检查','条件与缺口'],['execution','执行复盘','成交与结果']
];

export function renderBrainTelemetry(snapshot, online) {
  const c=snapshot?.cadence || {}, p=snapshot?.researchPipeline || {};
  const seconds=n=>Number.isFinite(n)&&n>=0?`${(n/1000).toFixed(2)} 秒`:'待测';
  const scanChains=snapshot?.scanScope?.scanChains;
  const discovery=snapshot?.discoveryScope;
  const ages=rows(c.marketSourceAges).filter(s=>(!scanChains||scanChains.includes(s.chain))&&Number.isFinite(s.ageMs)&&s.ageMs>=0);
  const fields=[['本地扫描间隔',seconds(c.actualTickGapMs)],['本轮计算耗时',seconds(c.lastTickDurationMs)],
    ['最近报价排队',seconds(c.lastQuoteTiming?.queueMs)],['K 线处理中',Number.isFinite(p.chartRequestsPending)?`${p.chartRequestsPending} 个`:'待测']];
  return `<dl class="brain-telemetry-metrics">${fields.map(([label,v])=>`<div><dt>${esc(label)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    <div class="brain-feed-strip"><span>${scanChains?`交易扫描：${scanChains.map(c=>esc(chain(c))).join('、')} · `:''}${online?'行情年龄':'上次记录 · 连接待恢复'}</span>${ages.map(s=>`<span data-stale="${s.status!=='ok'||s.ageMs>120000}">${esc(chain(s.chain))}<b>${Math.round(s.ageMs/1000)}s</b></span>`).join('')||'<span>等待来源时间</span>'}<small>${scanChains?'TG 新闻保持；其他链旧仓只做退出管理。':''}本地扫描 ≠ 每个 CA 的上游刷新</small></div>
    ${discovery?.version==='gmgn_three_lists_v1'?`<div class="brain-feed-strip"><span>GMGN 战壕/热门＋内盘快线</span>${rows(discovery.feeds).map(f=>`<span data-stale="${f.status!=='ok'}">${esc(f.label)}<b>${value(f.count)}</b></span>`).join('')}<small>四类去重 ${value(discovery.uniqueCandidates)} 个 · 5分钟是榜单统计窗口 · 内盘地址与逐笔放量可独立发现</small></div>`:''}`;
}

export function buildBrainView(snapshot, now=Date.now(), connected=true, selectedKey=null) {
  const s=snapshot || {}, p=s.researchPipeline || {}, cadence=s.cadence || {};
  const online=connected && s.status==='ok' && fresh(s.updatedAt,now,s.publicView===true?60000:15000);
  const entry=entryStatus(snapshot,now,connected);
  const items=buildCaDesk(s,now,online), byKey=new Map(items.map(i=>[i.key,i]));
  const pending=p.lastDetail?.status==='pending' && fresh(p.lastDetail.startedAt,now,90000);
  const focusKey=selectedKey || (pending?caKey(p.lastDetail):null)
    || (p.entryFocus?.active && now<=p.entryFocus.until ? p.entryFocus.key : null)
    || caKey(rows(p.hotCandidates)[0]) || items[0]?.key;
  const selected=byKey.get(focusKey) || (!selectedKey ? items[0] : null);
  const ready=items.filter(i=>i.state==='ready').length, held=Object.values(s.account?.positions || {}).length;
  const current= !online ? {label:snapshot?'连接或快照待恢复':'等待首轮数据',text:'保留最后记录，不把旧状态显示为正在处理。',active:false}
    : entry.blocked ? {label:entry.label,text:'原因与额度见上方账户提示。不据此推断消息采集或持仓退出已停止；研究请求与成交分开记录。',active:false}
    : pending ? {label:`正在补全 ${p.lastDetail.symbol || short(p.lastDetail.address)}`,text:`${chain(p.lastDetail.chain)} · 资料请求已发起，等待回包；不代表已经下单。`,active:true}
    : rows(cadence.quoteInFlight).length ? {label:`正在请求 ${cadence.quoteInFlight.length} 个报价`,text:'包含主盘或独立对照的行情请求；报价请求不是成交。',active:true}
    : p.chartRequestsPending>0 ? {label:`${p.chartRequestsPending} 个 K 线任务处理中`,text:'任务可能正在排队或请求；完成情况见下方记录。',active:true}
    : {label:s.enabled?'本轮评估完成，等待新证据':'新增仓位已暂停',text:s.enabled?`本轮 ${items.length} 个候选，${ready} 个显示条件通过；是否成交以账本为准。`:'不据此推断消息采集或持仓退出已停止。',active:false};
  const modules=depts.map(([id,label,subtitle])=>({id,label,subtitle,state:!online?'stale':'observed'}));
  const facts={
    news:[['自有原文',`${value(s.newsWire?.ownDocumentCount)} 条已收录`],['GMGN 消息',`${value(s.newsWire?.gmgnSignalCount)} 条平台信号`],['覆盖说明',s.newsWire?.fullTwitterConnected?'以记录的来源范围为准':'非全量推特；平台喊单不等于原始推文']],
    narrative:[['带来源候选',`${value(s.narrativeDesk?.withSources)} 个`],['社区题材关联',`${value(s.narrativeDesk?.communityLinked)} 个`],['明确 CA 对应',`${value(s.narrativeDesk?.directCa)} 个；不等于作者发行`]],
    wallet:[['深采样钱包',`${value(s.learning?.walletCount)} 个`],['教师候选',`${value(s.learning?.roles?.teacher)} 个；不等于可直接跟单`],['当前局限','标签、单币盈利、长期盈利分开记录；同源资金不是控盘证明。']],
    market:[['资料成功 / 请求',`${value(p.detailsSucceeded)} / ${value(p.detailsRequested)}`],['K 线待处理',`${value(p.chartRequestsPending)} 个`],['行情覆盖',`${rows(s.scanScope?.scanChains||p.stageSnapshot).length} 条扫描链；逐币上游更新速度不同`]],
    decision:[['本轮候选',`${items.length} 个（非全链代币总数）`],['显示条件通过',`${ready} 个；${entry.blocked?'账户暂停或受阻，不会提交新仓':'不是已下单'}`],['开仓状态',entry.label],...(entry.blocked?entry.metrics:[])],
    execution:[['主盘持仓',`${held} 个`],['账本成交',`${s.publicSummary?.totalTrades??rows(s.account?.trades).length} 条；买卖各计一笔`],['百笔复盘',`${value(s.tradeCountReview?.pendingFills)} / 100；${value(s.tradeCountReview?.completedBatches)} 批完成`]]
  };
  if(s.newsWire?.poolFirstThree){const f=s.newsWire.poolFirstThree;
    facts.news.push(['Four / Flap 首三 CA',`${value(f.readySignals)} 个新鲜信号；不代表已下单`]);
    if(f.launchSourceHealth){const h=f.launchSourceHealth;
      facts.news.push(['首三来源校验',`Four ${h.fourmeme?.status==='local_checkpoint'?'本地证据可读':'证据不可用'}；Flap ${h.flapCanonical?.status==='available'?'归属索引可读':'归属未就绪，不入场'}；不代表全链或持续在线`]);
    }
    if(Number.isFinite(f.expiredOnArrivalEvents))facts.news.push(['形成时已过期',`${f.expiredOnArrivalEvents} / ${value(f.uniqueEvents)} 个保留事件；历史漏点，不是今日全链统计`]);
    if(Number.isFinite(f.latency?.p95Ms))facts.news.push(['创建到证据完成 P95',`${(f.latency.p95Ms/1000).toFixed(1)} 秒；${value(f.latency.sampleCount)} 个去重保留样本`]);
  }
  if(p.entryDiagnostics){const d=p.entryDiagnostics;
    facts.decision.push(['有效催化 / 报价调度',`${value(d.verifiedCatalyst)} 个已核实催化或盈利钱包；${value(d.quoteResearchReady)} 个可研究报价；${value(d.quoteScheduled)} 个已入调度`],
      ...rows(d.blockers).slice(0,3).map(b=>['候选主要状态',`${b.label}：${value(b.count)} 个`]),
      ['统计边界',d.note]);
  }
  if(p.focusedReadBudget){const b=p.focusedReadBudget;
    facts.market.push(['研究调度',b.note],['K线轮次保留 / 缺字段退避',`${b.chartTurnReserved?'已保留下一轮':'按需调度'}；${value(b.detailBackoffCandidates)} 个候选等待重试，未知字段未放行`]);
  }
  if(['eligible_catalyst_recency_cost_v2','eligible_algorithm_catalyst_v3'].includes(p.candidateSelectionPolicy))facts.decision.push(
    ['选标排序','合格候选先看核实事件 / 新底池 / 集体盈利钱包信号，再看单独核实盈利钱包；同类催化看新鲜度，再比较成本。纯量价独立记录，不补故事。'],
    ['重点观察池',`${rows(p.hotCandidates).length} / ${value(p.hotLimit)} 个；保留普通发现轮次，研究排序不是买入许可。`]);
  if(s.algorithmSignals){const a=s.algorithmSignals;
    facts.decision.push(['BSC 算法信号',a.enabled?'内盘逐笔放量＋预核验地址快线＋集体聪明钱＋新底池前三 CA；仅模拟，AI 不在同步下单链路':'未启用'],
      ['资金流覆盖',a.sourceStatus==='covered'?`GMGN 标签钱包子集窗口已覆盖，源截止 ${clock(a.sourceObservedAt)}；非全市场逐笔，与链上普通地址来源分开核验`:'GMGN 标签钱包流缺失、断档或超过 30 秒；不代表独立链上来源失效；不能当作没有机会'],
      ['保留信号 / 已成交',`${value(a.retained)} / ${value(a.filled)}；最近 200 个信号，非全部历史`]);
    for(const r of rows(a.records).slice(-3).reverse())facts.decision.push([
      `${r.source==='onchain_internal_burst'?'内盘链上普通地址放量':r.source==='internal_burst'?'内盘逐笔放量':r.source==='prequalified_wallet'?'内盘预核验地址':r.source==='collective_smart_money'?'集体聪明钱':'新底池'} · ${short(r.address)}`,
      r.status==='filled'?`已模拟买入；检测到成交 ${value(r.detectionToFillMs)} 毫秒，源事件到成交 ${value(r.sourceToFillMs)} 毫秒`
        :`${r.status==='expired'?'信号已过期':r.decision}；${[...rows(r.missing),...rows(r.reasons)].join('；')||'等待资料或独立报价'}`]);
    const currentCheck=rows(a.checks).find(c=>c.status==='observing'&&c.reason);
    if(currentCheck||!rows(a.records).length)facts.decision.push(['当前地址信号检查',currentCheck?.reason||'尚无可验证地址信号；不是判断市场没有机会']);
    if(a.depthProbe?.enabled)facts.decision.push(['内盘曲线深度',a.depthProbe.running?'正在只读试算，未成交':a.depthProbe.last?`${short(a.depthProbe.last.address)} · ${a.depthProbe.last.status==='ok'?'试算通过':a.depthProbe.last.reason||'未完成'}；${value(a.depthProbe.last.durationMs)} 毫秒`:'按需核验 Four / Flap 原生及受支持的 Flap 转换路径；缺反向报价不放行']);
    if(a.onchainCoverage){const o=a.onchainCoverage,live=['ready','warming_up','collecting'].includes(o.status)&&fresh(o.lastSuccessAt,now,30000);
      const status={idle:'等待指定 CA',collecting:'只读采集中',ready:'指定窗口已覆盖',warming_up:'积累连续窗口',
        unsupported:'当前底池未支持',unavailable:'本轮覆盖中断',stopped:'已停止',stale:'上次记录已过期'};
      facts.decision.push(['内盘链上来源',`${!live&&['ready','warming_up'].includes(o.status)?'上次记录已过期':status[o.status]||'状态待核'}；最近成功 ${clock(o.lastSuccessAt)}`],
        ['链上覆盖边界',`仅固定 Four V2 / Flap 的原生 BNB 底池、指定 CA 与已核区间；本轮 ${value(o.lastRound?.selected)} 个 CA，非全 BSC、非聪明钱资格`]);
      if(o.lastError?.reason)facts.decision.push(['逐笔采集缺口',brief(o.lastError.reason)]);
      for(const c of rows(o.checks).slice(0,4))facts.decision.push([`逐笔窗口 · ${short(c.address)}`,
        `${c.status==='covered'?(live?'已覆盖':'记录过期'):c.status==='warming_up'?'积累中':c.status==='unsupported'?'未支持':c.status==='head_not_advanced'?'链头未前进':'待核验'}；${value(Number.isFinite(c.coveredMs)?c.coveredMs/1000:null)} 秒 / ${value(c.tradeCount)} 条成交观察${c.reason?'；'+brief(c.reason):''}`]);
    }
    facts.decision.push(['信号边界',a.note]);
  }
  if(s.jevResearch){const j=s.jevResearch;
    const label={active:'试运行中，等待新来源',in_flight:'正在分析原文',budget_exhausted:'调用预算已用完',expired:'试运行已到期',
      disabled:'未启用',not_started:'等待启动',stopped:'已停止',missing_key:'密钥不可用',request_failed:'接口失败，已停止新增调用',
      persistence_error:'保存失败，已停止新增调用',invalid_pilot:'试运行配置待检查',locked:'存在其他研究进程',interrupted_or_failed:'上轮中断，等待检查'}[j.status]||'状态待检查';
    facts.narrative.push(['Jev 语义筛选',`${label}；完成 ${value(j.evaluated)} 次 / 已占用 ${value(j.reservedCalls)} 次 / 上限 ${value(j.maxCalls)} 次`],
      ['Jev 使用边界','只调整研究顺序；不批准买入、不认定新闻真实，也不替代 CA 校验。']);
  }
  if(s.narrativeAcademy){const a=s.narrativeAcademy;
    facts.narrative.push(['事件案例学习',a.error||`${value(a.caseCount)} 条事件 / ${value(a.candidateObservations)} 条 CA 观察；不等于成交`],
      ['学习方向',rows(a.curriculum).map(c=>`${c.label} ${value(c.cases)}`).join('；')||'等待案例'],
      ['后续发展',`${value(a.followupCandidates)} 条后续线索待核实；重复文案不算二次发酵`],
      ['前瞻结果',`24 小时已观察 ${value(a.outcomes?.['24h']?.observed)} 条；缺失 ${value(a.outcomes?.['24h']?.missing)} 条；未扣费用，非账户收益`],
      ['待补能力','原图理解、OG / 发行者身份、底池关系和同控钱包仍需独立证据；当前不是全量推特或模型训练。']);
  }
  if(s.learning?.behaviorLearning){const w=s.learning.behaviorLearning;
    facts.wallet.push(['买卖情境案例',w.error||`${value(w.cases)} 条；隔离 ${value(w.quarantined)} 条不完整样本`],
      ['位置与叙事证据',`成交前 K 线 ${value(w.observed?.chartContexts)} 条；叙事关联 ${value(w.observed?.narrativeContexts)} 条；不能据此断言交易员动机`],
      ['当前教师样本',`${value(w.teachers?.cases)} 条案例来自当前双周期盈利核验通过的钱包；历史毛收益不是跟单净收益。`]);
  }
  if(s.learning?.roster){const r=s.learning.roster;
    facts.wallet.push(['教师席位轮换',`核验通过待入席 ${value(r.waitingVerified)} 个；已归档 ${value(r.archivedWallets)} 个钱包 / ${value(r.archivedRecords)} 条历史，未删除`]);
  }
  if(s.learning?.addressLibrary){const a=s.learning.addressLibrary;
    facts.wallet.push(['长期地址库存',`${value(a.addresses)} 个地址 / ${value(a.events)} 条去重交易观察 / ${value(a.profileSnapshots)} 份历史画像`],
      ['库存积累状态',a.status==='error'?'写入异常，本轮覆盖不完整；旧档案保留，实时监控继续':'随研究轮次增量归档；不随候选淘汰或 30 天窗口删除，不额外增加接口请求'],
      ['库存使用边界','收录不等于合格教师；保留亏损和归因不明样本，旧画像不会自动续期或直接触发跟单。']);
  }
  if(s.lossRepair?.learning){const l=s.lossRepair.learning;
    facts.execution.push(['历史完整交易',`${value(l.overall?.closedRounds)} 次；净损益 ${value(l.overall?.netPnlUsd)} U；模型成本 ${value(l.overall?.modelCostsUsd)} U`],
      ['本轮补款后',`${value(l.currentRound?.fills)} 笔成交；已实现 ${value(l.currentRound?.realizedPnlUsd)} U；补款不计利润`],
      ...rows(l.lessons).map(x=>[x.label,`${value(x.closedRounds)} 次 / 净 ${value(x.netPnlUsd)} U。${x.action}`]),
      ['复盘边界',l.note]);
    if(l.routePerformance)facts.execution.push(
      ...rows(l.routePerformance.groups).map(g=>[`本轮路线 · ${g.label}`,`${value(g.closedRounds)} 次完整平仓 / 净 ${value(g.netPnlUsd)} U / 模型成本 ${value(g.modelCostsUsd)} U`]),
      ['路线统计边界',l.routePerformance.note]);
  }
  const observedAt={news:s.newsWire?.updatedAt,narrative:s.narrativeAcademy?.updatedAt||s.narrativeDesk?.updatedAt,wallet:s.learning?.updatedAt,market:cadence.lastMarketRefreshAt,decision:cadence.lastTickAt,execution:s.exitMonitor?.lastCheckedAt};
  for(const m of modules){m.facts=facts[m.id];m.at=observedAt[m.id];
    if(online)m.state=!fresh(m.at,now,120000)?'stale':m.id==='market'&&current.active?'active':'observed';}
  return {online,current,entry,modules,selected,selectionMissing:!!selectedKey&&!selected,items,ready,held,updatedAt:s.updatedAt,
    selectedKey:focusKey,session:s.session?.id||'default',activeEvaluation:online&&fresh(cadence.lastTickAt,now,5000),
    ticks:cadence.tickCount,pending:rows(p.pending),snapshot:s};
}

// Merge source-timestamped events only. Reload reconstructs retained backend
// history; transient dispatch history is limited to this page session.
export function collectBrainEvents(history,snapshot,now=Date.now()) {
  const s=snapshot||{},p=s.researchPipeline||{};
  const name=t=>t?.symbol || rows(s.evaluations).find(e=>caKey(e.token)===caKey(t))?.token?.symbol || short(t?.address);
  const add=e=>{if(e.id&&Number.isFinite(stamp(e.at))&&stamp(e.at)<=now&&stamp(e.at)>0)history.set(e.id,e);};
  for(const t of rows(s.account?.trades).slice(-30)){
    const label={buy:'模拟买入',sell:'模拟卖出',writeoff:'账面核销'}[t.side];if(!label)continue;
    add({id:`fill:${t.id}`,type:'trade',at:t.atMs,title:`${label} · ${name(t)}`,detail:brief(t.reason||t.entryLogic||'成交依据见账本'),
      meta:`${chain(t.chain)} · ${short(t.address)}${t.side!=='buy'?` · 已实现 ${value(t.realizedPnl)} U`:''}`,href:'#recentTrades'});
  }
  for(const c of rows(p.chartDiagnostics).slice(0,8))add({id:`chart:${caKey(c)}:${c.receivedAt||c.fetchedAt}`,type:'research',at:c.receivedAt||c.fetchedAt,
    title:`${c.sourceStatus==='ok'?'已取得 K 线':'K 线采集未成功'} · ${name(c)}`,
    detail:c.sourceStatus==='ok'?(c.ready?'结构数据可用；不代表通过全部买入条件。':brief(c.reason)||'结构样本尚不足。'):'数据请求未成功，等待后续恢复。',meta:`${chain(c.chain)} · ${short(c.address)}`,href:'#caDesk'});
  const d=p.lastDetail;
  if(d)add({id:`detail:${caKey(d)}:${d.startedAt}`,type:'research',at:d.finishedAt||d.startedAt,
    title:`${d.status==='ok'?'资料请求已完成':d.status==='pending'?'资料请求已发起':'资料请求待恢复'} · ${name(d)}`,
    detail:d.status==='pending'?'已进入请求流程；这条发起记录不证明任务仍在执行或已经完成。':brief(d.reason)||'以最新返回数据为准。',meta:`${chain(d.chain)} · ${short(d.address)}`,href:'#caDesk'});
  const dispatch=p.lastChartDispatch;
  if(dispatch)add({id:`dispatch:${caKey(dispatch)}:${dispatch.at}`,type:'research',at:dispatch.at,title:`K 线任务已派发 · ${name(dispatch)}`,
    detail:'任务已进入只读请求流程；派发不等于已经取得数据。',meta:`${chain(dispatch.chain)} · ${short(dispatch.address)}`,href:'#caDesk'});
  const review=s.tradeCountReview?.latestReport;
  if(review)add({id:`review:${review.sequence}:${review.generatedAt}`,type:'review',at:review.generatedAt,title:`第 ${review.sequence} 批复盘已生成`,detail:'满 100 笔触发本地统计；不自动修改策略。',meta:`本批已实现 ${value(review.windowRealizedPnlUsd)} U`,href:'#tradeCountReview'});
  const semantic={explicit:'文案明确指向（CA 另核）',theme_only:'只有题材关联',unrelated:'文案无关',unknown:'无法确认',
    claimed_completed:'文案声称已发生',planned:'计划或传闻',denied:'否认或警示',token_mechanism:'代币机制叙事',attention_only:'注意力叙事',none:'未见需求路径'};
  for(const c of rows(s.narrativeAcademy?.recent).slice(0,8)){
    const names=rows(c.candidates).slice(0,4).map(t=>`${t.symbol||short(t.address)} (${chain(t.chain)} / ${short(t.address)})`).join('、');
    add({id:`academy:${c.id}`,type:'research',at:c.updatedAt,title:`叙事案例 · ${rows(c.labels).join(' / ')}`,
      detail:brief(`${c.excerpt}；${c.continuation?.note||''}；${names?`候选：${names}`:'尚无 CA 对应'}；仅研究，未批准买入。`,400),
      meta:`${c.author||'来源主体待核实'} · 原文 ${clock(c.sourceAt)} · 首次收录 ${clock(c.firstSeenAt)} · ${c.phase||'阶段待核实'}`,href:'#brainDesk'});
  }
  for(const r of rows(s.jevResearch?.recent)){
    const complete=r.status==='evaluated';
    const detail=complete?['relationship','event_status','demand_path'].map(k=>semantic[r.answers?.[k]?.choice]||'无法确认').join('；')+'。模型分类，不是买入批准。'
      :r.status==='reserved'?'已预留调用额度；尚无已完成结果。':'本次调用未成功；保留原研究逻辑，不补造模型结论。';
    add({id:`jev:${r.id}`,type:'research',at:r.at,title:`Jev ${complete?'完成语义筛选':r.status==='reserved'?'请求待完成':'请求未成功'} · ${name(r.candidate)}`,
      detail,meta:`${chain(r.candidate?.chain)} · ${short(r.candidate?.address)}${complete&&Number.isFinite(r.measuredLatencyMs)?` · ${r.measuredLatencyMs} 毫秒`:''}`,href:'#caDesk'});
  }
  const sorted=[...history.values()].filter(e=>stamp(e.at)<=now).sort((a,b)=>stamp(b.at)-stamp(a.at)||a.id.localeCompare(b.id));
  // Research traffic must not evict every real fill from the trade filter.
  const keep=new Set([...sorted.filter(e=>e.type==='trade').slice(0,30),...sorted.filter(e=>e.type==='review').slice(0,1),...sorted.filter(e=>e.type==='research').slice(0,49)]);
  history.clear();for(const e of sorted)if(keep.has(e))history.set(e.id,e);
  return [...history.values()];
}

export function renderBrainFocus(item,missing=false) {
  if(!item)return `<div class="brain-focus-empty"><span>当前关注</span><h3>${missing?'所选 CA 本轮不在列表':'等待候选资料'}</h3><p>没有记录时不补造判断。${missing?'可切回自动关注，或到逐币判断台查找。':'数据到达后显示事件、资金与下一步条件。'}</p></div>`;
  const e=item.e,t=e.narrativeThesis||item.position?.entryEvidence?.narrativeThesis,f=e.flow||{};
  const narrative=t?.event?.sourceUrl ? `${t.event.label} · ${t.relationship?.label||'代币关联待核实'}` : '未取得可核实的原文关联，不按币名补故事。';
  const fields=[['叙事',narrative],['资金',`可见净买 ${value(f.uniqueBuyerCount)} 个地址 / ${value(f.netBuyUsd)} U；核实盈利 ${value(f.highProfitCount)} 个。${e.flowFresh===true?'':'数据时效未通过。'}`],
    ['量价',item.chosen.label ? `${item.chosen.label} · ${item.chartFresh?'收盘数据在时效内':'该路线收盘数据待确认'}`:'本轮未记录有效量价路线'],
    ['下一步',item.state==='ready'?'等待新鲜报价与账本确认；当前只是条件通过。':item.state==='holding'?'按原仓退出规则复核结构与资金，不因页面操作买卖。':brief(item.blockers.slice(0,2).join('；')||'等待下一轮证据变化。',180)]];
  return `<div class="brain-focus-head"><div><span>当前关注 · ${esc(chain(item.token.chain))}</span><h3>${esc(item.token.symbol||'未命名代币')}</h3></div><span class="brain-verdict" data-state="${esc(item.state)}">${esc(item.label)}</span></div>
    <p class="brain-contract">${esc(item.token.address)}</p><dl class="brain-evidence">${fields.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    <a class="brain-detail-link" data-brain-ca="${esc(item.key)}" href="#caDesk">查看这个币的完整依据 <span aria-hidden="true">↗</span></a>`;
}

export function renderBrainEvents(events,filter='all') {
  const visible=events.filter(e=>filter==='all'||e.type===filter).slice(0,8);
  return visible.map(e=>`<li class="brain-event" data-type="${esc(e.type)}"><time>${esc(clock(e.at))}</time><div><strong>${esc(e.title)}</strong><p>${esc(e.detail)}</p><small>${esc(e.meta)}</small></div><a href="${['#recentTrades','#caDesk','#tradeCountReview'].includes(e.href)?e.href:'#caDesk'}" aria-label="查看${esc(e.title)}记录">↗</a></li>`).join('')||'<li class="brain-log-empty">尚无这个类别的记录；不会为了展示动态生成虚拟动作。</li>';
}

const brainSvg=()=>`<div class="brain-instrument" aria-hidden="true"><div class="brain-orbit"></div><img class="brain-render" src="/generated-designs/neural-core-v2.png" width="1280" height="1280" alt="" decoding="async"/><svg class="brain-connectors" viewBox="0 0 640 360"><g><path d="M115 68H179L231 112M525 68H460L410 112M108 188H202M532 188H438M160 302H215L254 268M480 302H430L390 268"/></g><g class="brain-contact-points"><circle cx="231" cy="112" r="3"/><circle cx="410" cy="112" r="3"/><circle cx="202" cy="188" r="3"/><circle cx="438" cy="188" r="3"/><circle cx="254" cy="268" r="3"/><circle cx="390" cy="268" r="3"/></g></svg><span class="brain-instrument-label">神经中枢 / 状态映射</span></div>`;

export function createBrainDesk(root,{onSelectCa=()=>{}}={}) {
  if(!root)return {update(){}};
  root.innerHTML=`<header class="brain-heading"><div><span class="brain-eyebrow">实时工作视图</span><h2>决策大脑</h2></div><div class="brain-connection" data-brain-connection role="status">等待连接</div></header>
    <div data-brain-entry-status></div>
    <div class="brain-workspace"><div class="brain-network"><div class="brain-task"><span>引擎当前任务</span><h3 data-brain-task>等待首轮数据</h3><p data-brain-task-note>读取真实后台状态。</p></div><div class="brain-map">${brainSvg()}${depts.map(([id,label,subtitle],i)=>`<button type="button" class="brain-node brain-node-${i}" data-brain-module="${id}" aria-pressed="${id==='decision'}"><span class="brain-node-dot"></span><strong>${label}</strong><small data-brain-module-status>${subtitle}</small></button>`).join('')}</div><div class="brain-map-caption"><span data-brain-ticks>扫描次数待同步</span><span>节点表示模块状态，不是私有思维流</span></div></div>
    <aside class="brain-inspector" aria-label="当前关注代币的证据摘要"><label class="brain-picker">关注对象<select data-brain-target aria-label="选择关注的代币"><option value="">自动跟随研究任务</option></select></label><div data-brain-focus></div></aside></div>
    <section class="brain-telemetry" aria-label="真实扫描速度"><div data-brain-telemetry></div></section>
    <section class="brain-module-detail" aria-label="所选研究模块"><div><span class="brain-eyebrow">模块记录</span><h3 data-brain-module-title>决策检查</h3><time data-brain-module-time>等待记录</time></div><dl data-brain-module-facts></dl></section>
    <section class="brain-activity" aria-labelledby="brainActivityTitle"><div class="brain-activity-heading"><div><h3 id="brainActivityTitle">已经做了什么</h3><p>成交来自持久化账本；请求记录来自后台快照与本页采样，非完整历史。</p></div><div class="brain-log-filters" role="group" aria-label="筛选动作记录">${[['all','全部'],['research','研究'],['trade','成交'],['review','复盘']].map(([id,label])=>`<button type="button" data-brain-filter="${id}" aria-pressed="${id==='all'}">${label}</button>`).join('')}</div></div><ol data-brain-events class="brain-event-list"></ol></section>`;
  let snapshot=null,connected=false,selectedKey=null,moduleId='decision',filter='all',session=null;
  const history=new Map(),cache=new Map(),q=selector=>root.querySelector(selector);
  const html=(selector,content)=>{if(cache.get(selector)!==content){q(selector).innerHTML=content;cache.set(selector,content);}};
  const text=(selector,content)=>{if(q(selector).textContent!==content)q(selector).textContent=content;};
  function render(){
    const now=Date.now(),view=buildBrainView(snapshot,now,connected,selectedKey);
    if(session!==view.session){history.clear();session=view.session;}
    root.dataset.online=String(view.online);root.dataset.active=String(view.current.active||view.activeEvaluation);
    text('[data-brain-connection]',view.online?`${snapshot?.publicView?'公开同步快照':'本地快照'} · ${clock(view.updatedAt)}`:snapshot?'连接 / 快照待恢复':'等待连接');
    text('[data-brain-task]',view.current.label);text('[data-brain-task-note]',view.current.text);
    html('[data-brain-entry-status]',renderEntryStatus(view.entry));
    text('[data-brain-ticks]',`本进程扫描 ${value(view.ticks)} 次 · ${view.items.length} 个候选`);
    html('[data-brain-telemetry]',renderBrainTelemetry(snapshot,view.online));
    const options=[...new Map([view.selected,...view.items.filter(i=>i.hot||i.position||i.state==='ready'),...view.items].filter(Boolean).map(i=>[i.key,i])).values()].slice(0,80);
    // Do not replace a focused picker while the user is selecting a CA.
    if(root.ownerDocument.activeElement!==q('[data-brain-target]')){
      html('[data-brain-target]','<option value="">自动跟随研究任务</option>'+(selectedKey&&!view.selected?`<option value="${esc(selectedKey)}">所选 CA 本轮未出现</option>`:'')+options.map(i=>`<option value="${esc(i.key)}">${esc(i.token.symbol||short(i.token.address))} · ${esc(chain(i.token.chain))} · ${esc(short(i.token.address))}</option>`).join(''));
      q('[data-brain-target]').value=selectedKey||'';
    }
    html('[data-brain-focus]',renderBrainFocus(view.selected,view.selectionMissing));
    for(const m of view.modules){const b=q(`[data-brain-module="${m.id}"]`);b.dataset.state=m.state;b.setAttribute('aria-pressed',String(m.id===moduleId));
      b.querySelector('[data-brain-module-status]').textContent=m.state==='active'?'处理中 / 排队':m.state==='stale'?'数据待更新':'已有记录';}
    const module=view.modules.find(m=>m.id===moduleId);
    text('[data-brain-module-title]',module.label);text('[data-brain-module-time]',`最近记录 ${clock(module.at)}`);
    html('[data-brain-module-facts]',module.facts.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join(''));
    html('[data-brain-events]',renderBrainEvents(collectBrainEvents(history,snapshot,now),filter));
  }
  q('[data-brain-target]').addEventListener('change',e=>{selectedKey=e.target.value||null;render();});
  root.addEventListener('click',e=>{const node=e.target.closest('[data-brain-module]'),f=e.target.closest('[data-brain-filter]');
    const ca=e.target.closest('[data-brain-ca]');if(ca)onSelectCa(ca.dataset.brainCa);
    if(node){moduleId=node.dataset.brainModule;render();}
    if(f){filter=f.dataset.brainFilter;for(const b of root.querySelectorAll('[data-brain-filter]'))b.setAttribute('aria-pressed',String(b===f));render();}
  });
  render();return {update(next,ok=true){snapshot=next;connected=ok;render();}};
}
