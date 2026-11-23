import '../../src/live-env-loader.js';
import 'dotenv/config';
import { readLedgerForDisplay, RESERVING_STATUSES } from '../../src/live-gmgn-trader.js';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const dir = path.join(root, 'data/studio'); fs.mkdirSync(dir, { recursive: true });
export const E = process.env;
// 工作直播：根据各 bot 本轮产出生成「思考 / 当前任务 / 最近几步」
const _log=[]; const N=x=>x==null?'—':Number(x).toFixed(2);
function narrate(name,o){ const t=new Date().toISOString(); let task,think,code,steps;
  if(name==='market'){ const sc=Object.values(o.scores||{}); const avg=sc.length?Math.round(sc.reduce((a,b)=>a+(b.score||0),0)/sc.length):'—';
    task={title:'刷新行情并重算代币评分',file:'scripts/studio/market-bot.js'};
    think=`BNB ${N(o.prices?.BNBUSDT)}、SOL ${N(o.prices?.SOLUSDT)}；权益 $${N(o.equityUsd)}，盈亏 ${o.pnlPct>=0?'+':''}${N(o.pnlPct)}%。已评 ${sc.length} 条，均分 ${avg}。`;
    code=`equity = bnb*${N(o.prices?.BNBUSDT)} + sol*${N(o.prices?.SOLUSDT)} + usdt\npnlPct = (${N(o.equityUsd)} - ${N(o.baseline?.usd)}) / ${N(o.baseline?.usd)} * 100  // ${N(o.pnlPct)}%`;
    steps=['拉取 BNB/SOL 现价','读取钱包余额','计算权益与盈亏率',`为 ${sc.length} 条决策打分`,'写入 market.json']; }
  else if(name==='risk'){ const bad=(o.checks||[]).filter(c=>!c.ok);
    task={title:'巡检敞口 / 日亏损 / gas / 数据新鲜度',file:'scripts/studio/risk-bot.js'};
    think=bad.length?`发现 ${bad.length} 项异常：${bad.map(c=>c.name).join('、')}，需要报警。`:`${(o.checks||[]).length} 项全部通过，状态 ${o.status}。继续值守，只报警不关实盘。`;
    code=(o.checks||[]).map(c=>`${c.ok?'✓':'✗'} ${c.name}${c.detail?'  // '+c.detail:''}`).join('\n');
    steps=['读取今日成交与敞口','对比日亏损止损线','检查 BNB / SOL gas 储备','检查行情心跳','写入 risk.json']; }
  else { task={title:'盯 LIVE 执行器与 live-decisions',file:'data/live-decisions.jsonl'};
    think=`执行器${o.executorUp?'在线':'离线'}，实盘${o.enabled?'开':'关'}（${String(o.chains||'').toUpperCase()}）。累计成交 ${o.fillCount??0} 笔，等待新信号；不重复下单。`;
    code=`tail -f data/live-decisions.jsonl\nsignal = "${o.signalSource||'—'}"\nfills = ${o.fillCount??0}`;
    steps=['检查执行器进程','读取最新决策','统计 fill / skip / error','写入 copy.json']; }
  _log.unshift({at:t,text:think}); _log.length=Math.min(_log.length,12);
  return {thinking:think,currentTask:{...task,code,steps,startedAt:t},activityLog:_log}; }
export function write(name, obj){ const f=path.join(dir,name+'.json'); let w={}; try{ w=narrate(name,obj); }catch(e){} fs.writeFileSync(f+'.tmp', JSON.stringify({...obj, ...w, role:name, heartbeat:new Date().toISOString(), pid:process.pid},null,1)); fs.renameSync(f+'.tmp', f); }
export function read(name){ try{ return JSON.parse(fs.readFileSync(path.join(dir,name+'.json'),'utf8')); }catch{ return null; } }
function tailText(file,max=1024*1024){ const fd=fs.openSync(file,'r'); try{ const {size}=fs.fstatSync(fd); const len=Math.min(size,max); const b=Buffer.alloc(len); fs.readSync(fd,b,0,len,size-len); const t=b.toString('utf8'); return size>max?t.slice(t.indexOf('\n')+1):t; } finally{ fs.closeSync(fd); } }
// Live ledger view (same source the trader gates on): realized PnL by UTC day + reserved exposure.
export function ledgerSummary(){ const l=readLedgerForDisplay(path.join(root,'data/live-gmgn-ledger.json')); const day=new Date().toISOString().slice(0,10);
  const held=(l.positions||[]).filter(p=>RESERVING_STATUSES.has(p.status));
  return { realizedTodayUsd:Number(l.realized?.[day]||0), realizedTotalUsd:Object.values(l.realized||{}).reduce((a,b)=>a+Number(b||0),0), exposureUsd:held.reduce((a,p)=>a+Number(p.usd||0),0), openCount:held.length, unresolved:held.filter(p=>p.status!=='open').length, closedCount:(l.positions||[]).filter(p=>p.status==='closed').length, ledgerError:l.error||null, day }; }
export function decisions(){ try{ return tailText(path.join(root,'data/live-decisions.jsonl')).trim().split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean); }catch{ return []; } }
export async function rpc(url, method, params){ const r = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(8000)}); return (await r.json()).result; }
export function loop(fn, ms){ const run=async()=>{ try{ await fn(); }catch(e){ console.error(e); } }; run(); setInterval(run, ms); }
