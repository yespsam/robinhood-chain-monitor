// A read-only view of recorded evidence and scheduler state, not model thoughts.
import { buildCaDesk, caKey } from './ca-desk.js';

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
  const ages=rows(c.marketSourceAges).filter(s=>Number.isFinite(s.ageMs)&&s.ageMs>=0);
  const fields=[['本地扫描间隔',seconds(c.actualTickGapMs)],['本轮计算耗时',seconds(c.lastTickDurationMs)],
    ['最近报价排队',seconds(c.lastQuoteTiming?.queueMs)],['K 线处理中',Number.isFinite(p.chartRequestsPending)?`${p.chartRequestsPending} 个`:'待测']];
  return `<dl class="brain-telemetry-metrics">${fields.map(([label,v])=>`<div><dt>${esc(label)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>
    <div class="brain-feed-strip"><span>${online?'各链行情年龄':'上次记录 · 连接待恢复'}</span>${ages.map(s=>`<span data-stale="${s.status!=='ok'||s.ageMs>120000}">${esc(chain(s.chain))}<b>${Math.round(s.ageMs/1000)}s</b></span>`).join('')||'<span>等待来源时间</span>'}<small>本地扫描 ≠ 每个 CA 的上游刷新</small></div>`;
}

export function buildBrainView(snapshot, now=Date.now(), connected=true, selectedKey=null) {
  const s=snapshot || {}, p=s.researchPipeline || {}, cadence=s.cadence || {};
  const online=connected && s.status==='ok' && fresh(s.updatedAt,now,s.publicView===true?60000:15000);
  const items=buildCaDesk(s,now,online), byKey=new Map(items.map(i=>[i.key,i]));
  const pending=p.lastDetail?.status==='pending' && fresh(p.lastDetail.startedAt,now,90000);
  const focusKey=selectedKey || (pending?caKey(p.lastDetail):null)
    || (p.entryFocus?.active && now<=p.entryFocus.until ? p.entryFocus.key : null)
    || caKey(rows(p.hotCandidates)[0]) || items[0]?.key;
  const selected=byKey.get(focusKey) || (!selectedKey ? items[0] : null);
  const ready=items.filter(i=>i.state==='ready').length, held=Object.values(s.account?.positions || {}).length;
  const current= !online ? {label:snapshot?'连接或快照待恢复':'等待首轮数据',text:'保留最后记录，不把旧状态显示为正在处理。',active:false}
    : pending ? {label:`正在补全 ${p.lastDetail.symbol || short(p.lastDetail.address)}`,text:`${chain(p.lastDetail.chain)} · 资料请求已发起，等待回包；不代表已经下单。`,active:true}
    : rows(cadence.quoteInFlight).length ? {label:`正在请求 ${cadence.quoteInFlight.length} 个报价`,text:'包含主盘或独立对照的行情请求；报价请求不是成交。',active:true}
    : p.chartRequestsPending>0 ? {label:`${p.chartRequestsPending} 个 K 线任务处理中`,text:'任务可能正在排队或请求；完成情况见下方记录。',active:true}
    : {label:s.enabled?'本轮评估完成，等待新证据':'新增仓位已暂停',text:s.enabled?`本轮 ${items.length} 个候选，${ready} 个显示条件通过；是否成交以账本为准。`:'不据此推断消息采集或持仓退出已停止。',active:false};
  const modules=depts.map(([id,label,subtitle])=>({id,label,subtitle,state:!online?'stale':'observed'}));
  const facts={
    news:[['自有原文',`${value(s.newsWire?.ownDocumentCount)} 条已收录`],['GMGN 消息',`${value(s.newsWire?.gmgnSignalCount)} 条平台信号`],['覆盖说明',s.newsWire?.fullTwitterConnected?'以记录的来源范围为准':'非全量推特；平台喊单不等于原始推文']],
    narrative:[['带来源候选',`${value(s.narrativeDesk?.withSources)} 个`],['社区题材关联',`${value(s.narrativeDesk?.communityLinked)} 个`],['明确 CA 对应',`${value(s.narrativeDesk?.directCa)} 个；不等于作者发行`]],
    wallet:[['深采样钱包',`${value(s.learning?.walletCount)} 个`],['教师候选',`${value(s.learning?.roles?.teacher)} 个；不等于可直接跟单`],['当前局限','标签、单币盈利、长期盈利分开记录；同源资金不是控盘证明。']],
    market:[['资料成功 / 请求',`${value(p.detailsSucceeded)} / ${value(p.detailsRequested)}`],['K 线待处理',`${value(p.chartRequestsPending)} 个`],['行情覆盖',`${rows(p.stageSnapshot).length} 条链；逐币上游更新速度不同`]],
    decision:[['本轮候选',`${items.length} 个（非全链代币总数）`],['显示条件通过',`${ready} 个；不是已下单`],['开仓状态',!online?'快照待恢复':s.enabled===false?'暂停新增仓位':s.entryGuard?.allowed===false?'账户条件受阻':'已启用，等待满足完整条件']],
    execution:[['主盘持仓',`${held} 个`],['账本成交',`${s.publicSummary?.totalTrades??rows(s.account?.trades).length} 条；买卖各计一笔`],['百笔复盘',`${value(s.tradeCountReview?.pendingFills)} / 100；${value(s.tradeCountReview?.completedBatches)} 批完成`]]
  };
  const observedAt={news:s.newsWire?.updatedAt,narrative:s.narrativeDesk?.updatedAt,wallet:s.learning?.updatedAt,market:cadence.lastMarketRefreshAt,decision:cadence.lastTickAt,execution:s.exitMonitor?.lastCheckedAt};
  for(const m of modules){m.facts=facts[m.id];m.at=observedAt[m.id];
    if(online)m.state=!fresh(m.at,now,120000)?'stale':m.id==='market'&&current.active?'active':'observed';}
  return {online,current,modules,selected,selectionMissing:!!selectedKey&&!selected,items,ready,held,updatedAt:s.updatedAt,
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
