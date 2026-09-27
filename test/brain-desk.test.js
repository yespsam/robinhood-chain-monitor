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
