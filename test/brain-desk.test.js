import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {buildBrainView,collectBrainEvents,renderBrainFocus,renderBrainEvents,renderBrainTelemetry} from '../dashboard/brain-desk.js';
const NOW=Date.parse('2026-09-27T12:00:00Z'),iso=n=>new Date(NOW+n).toISOString();
const token={chain:'sol',address:'Abc123',symbol:'同名币'};
const evaluation=t=>({token:t,decision:'观察',reasons:[],missing:['连续新鲜报价确认'],evidence:{marketFresh:true,marketObservedAt:iso(-1000),priceFresh:false,opportunity:{label:'资金动量',basis:'flow',signalReady:true}}});
const snapshot=()=>({status:'ok',mode:'paper',enabled:true,updatedAt:iso(0),session:{id:'s1'},account:{positions:{},trades:[]},
  evaluations:[evaluation(token),evaluation({...token,address:'different'})],cadence:{tickCount:10,lastTickAt:iso(-1000)},
  researchPipeline:{lastDetail:{...token,status:'pending',startedAt:iso(-3000)},hotCandidates:[token]},tradeCountReview:{pendingFills:14,completedBatches:1}});
test('first-three source ownership is separate from signal count and never claims continuous coverage',()=>{
  const s=snapshot();s.newsWire={poolFirstThree:{readySignals:0,launchSourceHealth:{
    fourmeme:{status:'local_checkpoint'},flapCanonical:{status:'updating'}}}};
  const text=JSON.stringify(buildBrainView(s,NOW).modules.find(m=>m.id==='news').facts);
  assert.match(text,/Four \/ Flap 首三 CA/);assert.match(text,/Four 本地证据可读/);
  assert.match(text,/Flap 归属未就绪，不入场/);assert.match(text,/不代表全链或持续在线/);
});
test('covered tagged-wallet feed is not presented as full-market trade coverage',()=>{
  const s=snapshot();s.algorithmSignals={sourceStatus:'covered',sourceObservedAt:iso(0),records:[],checks:[]};
  const text=JSON.stringify(buildBrainView(s,NOW).modules.find(m=>m.id==='decision').facts);
  assert.match(text,/标签钱包子集/);assert.match(text,/非全市场逐笔/);assert.match(text,/与链上普通地址来源分开核验/);
});
test('ordinary chain coverage lists only bound windows and never exposes hosts or raw proof as full-BSC coverage',()=>{
  const s=snapshot();s.algorithmSignals={sourceStatus:'unavailable',onchainCoverage:{status:'ready',lastSuccessAt:iso(-1000),
    lastRound:{selected:2,host:'private.example'},rawProof:'private raw',checks:[{address:'0x'+'a'.repeat(40),status:'covered',coveredMs:95000,tradeCount:12}]}};
  let text=JSON.stringify(buildBrainView(s,NOW).modules.find(m=>m.id==='decision').facts);
  assert.match(text,/不代表独立链上来源失效/);assert.match(text,/原生 BNB 底池/);assert.match(text,/非全 BSC/);
  assert.match(text,/95 秒 \/ 12 条成交观察/);assert.doesNotMatch(text,/private/);
  s.algorithmSignals.onchainCoverage.lastSuccessAt=iso(-31000);
  text=JSON.stringify(buildBrainView(s,NOW).modules.find(m=>m.id==='decision').facts);assert.match(text,/上次记录已过期/);
  s.algorithmSignals.onchainCoverage.lastSuccessAt=iso(-1000);s.algorithmSignals.onchainCoverage.status='unavailable';
  text=JSON.stringify(buildBrainView(s,NOW).modules.find(m=>m.id==='decision').facts);assert.match(text,/本轮覆盖中断/);assert.doesNotMatch(text,/已覆盖；95 秒/);
});
test('Flap latency panel labels retained late arrivals, never today coverage or filled orders',()=>{
  const s=snapshot();s.newsWire={poolFirstThree:{readySignals:0,uniqueEvents:2,expiredOnArrivalEvents:1,
    latency:{sampleCount:2,p95Ms:705876}}};
  const facts=JSON.stringify(buildBrainView(s,NOW).modules.find(m=>m.id==='news').facts);
  assert.match(facts,/1 \/ 2 个保留事件/);assert.match(facts,/不是今日全链统计/);
  assert.match(facts,/705.9 秒/);assert.match(facts,/不代表已下单/);
});
test('event casebook displays actual observations and escaped source text without fabricated thoughts or trades',()=>{
  const s=snapshot();s.narrativeAcademy={updatedAt:iso(0),caseCount:3,candidateObservations:2,followupCandidates:1,
    curriculum:[{label:'动物 / 图片',cases:3}],outcomes:{'24h':{observed:0,missing:0}},recent:[{id:'x:1',updatedAt:NOW-1000,
      sourceAt:NOW-86400000,firstSeenAt:NOW-2000,excerpt:'<script>bad</script>',labels:['图片梗'],phase:'历史背景',candidates:[],
      continuation:{note:'不计二次发酵'}}]};
  const facts=buildBrainView(s,NOW).modules.find(m=>m.id==='narrative').facts;
  assert.match(JSON.stringify(facts),/3 条事件 \/ 2 条 CA 观察/);assert.match(JSON.stringify(facts),/非账户收益/);
  const h=new Map(),events=collectBrainEvents(h,s,NOW),c=events.find(e=>e.id==='academy:x:1');
  assert.match(c.detail,/尚无 CA 对应/);assert.match(c.detail,/未批准买入/);assert.match(c.meta,/原文.*首次收录/);
  assert.match(renderBrainEvents(events),/&lt;script&gt;/);assert.doesNotMatch(renderBrainEvents(events),/<script>/);
  assert.equal(collectBrainEvents(h,s,NOW).filter(e=>e.id==='academy:x:1').length,1);
});
test('wallet module separates incomplete observations from currently verified teachers',()=>{
  const s=snapshot();s.learning={walletCount:80,roles:{teacher:1},behaviorLearning:{cases:1536,quarantined:672,
    observed:{chartContexts:0,narrativeContexts:0},teachers:{cases:20}}};
  const facts=buildBrainView(s,NOW).modules.find(m=>m.id==='wallet').facts;
  assert.match(JSON.stringify(facts),/1,536 条；隔离 672/);assert.match(JSON.stringify(facts),/成交前 K 线 0 条/);
  assert.match(JSON.stringify(facts),/20 条案例来自当前双周期盈利核验/);assert.match(JSON.stringify(facts),/不能据此断言交易员动机/);
});
test('brain shows frozen loss attribution, post-funding results and preserved learner archives',()=>{
  const s=snapshot();s.learning={roster:{waitingVerified:0,archivedWallets:2,archivedRecords:300}};
  s.lossRepair={learning:{overall:{closedRounds:102,netPnlUsd:-99.67,modelCostsUsd:35.79},
    currentRound:{fills:0,realizedPnlUsd:0},lessons:[{label:'入场依据不足',closedRounds:102,netPnlUsd:-99.67,action:'仅记录冻结证据'}],note:'相关性不是因果'}};
  const modules=buildBrainView(s,NOW).modules;
  assert.match(JSON.stringify(modules.find(m=>m.id==='wallet').facts),/300 条历史，未删除/);
  assert.match(JSON.stringify(modules.find(m=>m.id==='execution').facts),/补款不计利润/);
  assert.match(JSON.stringify(modules.find(m=>m.id==='execution').facts),/相关性不是因果/);
});

test('Jev shows actual bounded research results, Chinese labels and never a buy approval',()=>{
  const s=snapshot();s.jevResearch={status:'active',evaluated:1,reservedCalls:1,maxCalls:30,recent:[{id:'one',candidate:token,
    at:iso(-10),status:'evaluated',measuredLatencyMs:290,answers:{relationship:{choice:'theme_only'},event_status:{choice:'planned'},demand_path:{choice:'attention_only'}}}]};
  const facts=buildBrainView(s,NOW).modules.find(m=>m.id==='narrative').facts;
  assert.match(JSON.stringify(facts),/完成 1 次.*上限 30 次/);
  const h=new Map();let events=collectBrainEvents(h,s,NOW);const event=events.find(e=>e.id==='jev:one');
  assert.match(event.detail,/只有题材关联；计划或传闻；注意力叙事/);assert.match(event.detail,/不是买入批准/);
  assert.match(event.meta,/290 毫秒/);assert.equal(collectBrainEvents(h,s,NOW).filter(e=>e.id==='jev:one').length,1);
  s.jevResearch.recent[0].status='timeout';s.jevResearch.recent[0].answers=null;
  events=collectBrainEvents(h,s,NOW);assert.match(events.find(e=>e.id==='jev:one').detail,/未成功/);
});
test('speed instrument uses measured values, distinguishes source age and never invents a fast scan',()=>{
  assert.match(renderBrainTelemetry(null,false),/待测/);
  const html=renderBrainTelemetry({cadence:{actualTickGapMs:1060,lastTickDurationMs:205,lastQuoteTiming:{queueMs:42000},
    marketSourceAges:[{chain:'sol',status:'ok',ageMs:180000},{chain:'<bad>',ageMs:-1}]},researchPipeline:{chartRequestsPending:2}},true);
  assert.match(html,/1.06 秒/);assert.match(html,/0.20 秒/);assert.match(html,/42.00 秒/);
  assert.match(html,/data-stale="true"/);assert.match(html,/180s/);assert.doesNotMatch(html,/<bad>/);
  assert.match(html,/本地扫描 ≠ 每个 CA 的上游刷新/);
});
test('shows actual pending job separately from candidate decision; preserves exact chain and CA selection',()=>{
  const s=snapshot(),v=buildBrainView(s,NOW,true);
  assert.equal(v.online,true);assert.equal(v.current.active,true);assert.match(v.current.label,/正在补全/);
  assert.equal(v.selected.key,'sol:Abc123');assert.equal(v.ready,0);
  assert.equal(buildBrainView(s,NOW,true,'sol:different').selected.key,'sol:different');
  assert.equal(buildBrainView(s,NOW,true,'bsc:Abc123').selectionMissing,true);
  assert.equal(buildBrainView(s,NOW,true,'bsc:Abc123').selected,null);
  assert.match(renderBrainFocus(v.selected),/连续新鲜报价确认/);assert.match(renderBrainFocus(v.selected),/核实盈利 未知/);
});
test('disconnected, stale and future snapshots never animate active work or show ready orders',()=>{
  for(const [s,connected] of [[snapshot(),false],[{...snapshot(),updatedAt:iso(-15001)},true],[{...snapshot(),updatedAt:iso(1)},true]]){
    const v=buildBrainView(s,NOW,connected);assert.equal(v.online,false);assert.equal(v.current.active,false);
    assert.equal(v.activeEvaluation,false);assert.equal(v.ready,0);assert.ok(v.modules.every(m=>m.state==='stale'));
  }
  const s=snapshot();s.researchPipeline.lastDetail.startedAt=iso(-100000);s.cadence.lastTickAt=iso(-20000);
  const v=buildBrainView(s,NOW,true);assert.equal(v.current.active,false);assert.equal(v.activeEvaluation,false);
});
test('paused entry is not described as paused monitoring and no data is not a fake decision',()=>{
  const s=snapshot();s.enabled=false;s.researchPipeline.lastDetail=null;
  const v=buildBrainView(s,NOW);assert.match(v.current.label,/新增仓位已暂停/);assert.match(v.current.text,/不据此推断/);
  assert.equal(buildBrainView(null,NOW).current.active,false);assert.match(renderBrainFocus(null),/没有记录时不补造/);
});
test('global pause takes precedence over detail, quote and chart jobs without mutating the snapshot',()=>{
  const s=snapshot();s.enabled=false;s.cadence.quoteInFlight=[token];s.researchPipeline.chartRequestsPending=2;
  s.lossGuards={enforced:true,triggered:true,realizedPnlUsd:-10.037,lossLimitUsd:10,dailyRealizedPnlUsd:-1.65,reasons:['本轮累计亏损达到额度']};
  const before=JSON.stringify(s),v=buildBrainView(s,NOW);
  assert.match(v.current.label,/新增仓位已暂停.*亏损预算/);
  assert.equal(v.current.active,false);
  assert.equal(v.entry.blocked,true);
  assert.match(JSON.stringify(v.modules.find(m=>m.id==='decision').facts),/不会提交新仓/);
  assert.match(JSON.stringify(v.entry.metrics),/-10.04 U/);
  assert.equal(JSON.stringify(s),before);
  s.enabled=true;
  assert.equal(buildBrainView(s,NOW).entry.blocked,true,'enforced loss guard outranks an inconsistent enabled flag');
});
test('decision panel displays measured entry blockers instead of implying no market opportunities',()=>{
  const s=snapshot();s.researchPipeline.entryDiagnostics={verifiedCatalyst:0,quoteResearchReady:0,quoteScheduled:0,
    blockers:[{code:'catalyst',label:'缺少有效原文催化或核实盈利钱包',count:17}],
    note:'当前样本不足不代表市场没有机会；报价调度不等于成交。'};
  const text=JSON.stringify(buildBrainView(s,NOW).modules.find(m=>m.id==='decision').facts);
  assert.match(text,/0 个可研究报价/);assert.match(text,/盈利钱包：17 个/);assert.match(text,/不代表市场没有机会/);
});
test('execution panel separates frozen paper route results without treating empty samples as performance',()=>{
  const s=snapshot();s.lossRepair={learning:{routePerformance:{groups:[{label:'事件叙事',closedRounds:0,netPnlUsd:0,modelCostsUsd:0},
    {label:'外盘纯量价',closedRounds:2,netPnlUsd:-2.44,modelCostsUsd:null}],note:'零笔不是零机会；非随机对照。'}}};
  const text=JSON.stringify(buildBrainView(s,NOW).modules.find(m=>m.id==='execution').facts);
  assert.match(text,/本轮路线 · 事件叙事/);assert.match(text,/外盘纯量价/);assert.match(text,/模型成本 未知/);assert.match(text,/零笔不是零机会/);
});
test('algorithm panel separates source gaps, unfilled triggers and measured paper fills',()=>{
  const s=snapshot();s.algorithmSignals={enabled:true,sourceStatus:'unavailable_or_stale',retained:2,filled:1,
    checks:[{status:'observing',reason:'事前盈利画像未核验'}],
    records:[{source:'collective_smart_money',address:token.address,status:'filled',detectionToFillMs:1234,sourceToFillMs:8000},
      {source:'new_pool_first_three',address:token.address,status:'expired',missing:['可卖出检测'],reasons:[]}],note:'底池仅已验证 BSC Flap'};
  const text=JSON.stringify(buildBrainView(s,NOW).modules.find(m=>m.id==='decision').facts);
  assert.match(text,/不能当作没有机会/);assert.match(text,/1,234 毫秒/);assert.match(text,/信号已过期；可卖出检测/);
  assert.match(text,/底池仅已验证/);
  assert.match(text,/当前地址信号检查/);assert.match(text,/事前盈利画像未核验/);
});
test('action timeline retains ledger fills, labels dispatch not completion, deduplicates and rejects future time',()=>{
  const s=snapshot(),h=new Map();
  s.account.trades=[{id:'t1',...token,atMs:NOW-10000,side:'buy',reason:'实际入场依据'},{id:'future',atMs:NOW+1,side:'sell'}];
  s.researchPipeline.chartDiagnostics=[{...token,receivedAt:iso(-2000),sourceStatus:'ok',ready:false,reason:'样本不足'}];
  s.researchPipeline.lastChartDispatch={...token,at:iso(-2500)};
  let events=collectBrainEvents(h,s,NOW);assert.equal(events.length,4);
  assert.equal(events.filter(e=>e.type==='trade').length,1);
  assert.match(renderBrainEvents(events,'trade'),/模拟买入/);assert.doesNotMatch(renderBrainEvents(events,'trade'),/K 线/);
  assert.match(renderBrainEvents(events),/派发不等于已经取得数据/);
  assert.equal(collectBrainEvents(h,s,NOW+1).length,5,'future event becomes observable only once its timestamp is reached');
  s.researchPipeline.lastDetail.status='ok';s.researchPipeline.lastDetail.finishedAt=iso(-500);
  events=collectBrainEvents(h,s,NOW);assert.equal(events.filter(e=>e.id.startsWith('detail:')).length,1);
  assert.match(events.find(e=>e.id.startsWith('detail:')).title,/已完成/);
});
test('bounded research timeline cannot grow indefinitely or call trading APIs',async()=>{
  const h=new Map();for(let i=0;i<150;i++)collectBrainEvents(h,{account:{trades:[{id:`t${i}`,atMs:NOW-i,side:'buy',...token}]}},NOW);
  assert.equal(h.size,30,'retains up to 30 ledger fills independently of research');
  for(let i=0;i<100;i++)collectBrainEvents(h,{researchPipeline:{lastChartDispatch:{...token,at:NOW-i}}},NOW);
  assert.equal(h.size,79);assert.equal([...h.values()].filter(e=>e.type==='trade').length,30);
  const code=await fs.readFile(new URL('../dashboard/brain-desk.js',import.meta.url),'utf8');
  assert.doesNotMatch(code,/\bfetch\s*\(|setInterval\s*\(|strategy-control|localStorage|sessionStorage/);
  const css=await fs.readFile(new URL('../dashboard/brain-desk.css',import.meta.url),'utf8');
  assert.match(css,/prefers-reduced-motion/);assert.match(css,/data-active=true/);
});
test('untrusted tickers, evidence, reasons and event links are escaped',()=>{
  const s=snapshot();s.evaluations[0].token={...token,symbol:'<script>bad</script>'};
  const html=renderBrainFocus(buildBrainView(s,NOW).selected);
  assert.match(html,/&lt;script&gt;/);assert.doesNotMatch(html,/<script>/);
  const events=renderBrainEvents([{id:'x',type:'trade',at:NOW,title:'<img src=x>',detail:'<script>',href:'javascript:alert(1)',meta:'"'}]);
  assert.match(events,/&lt;img/);assert.doesNotMatch(events,/javascript:/);assert.doesNotMatch(events,/<script>/);
});
