// 风控 bot：只出信号，不改开关
import { E, write, read, decisions, loop, ledgerSummary } from './common.js';
loop(async()=>{ const m=read('market')||{}; const b=m.balances||{}; const checks=[];
  const c=(name,ok,detail,level='warn')=>checks.push({name,ok,detail,level:ok?'ok':level});
  const L=ledgerSummary();
  c('实盘账本可读', !L.ledgerError, L.ledgerError||'ok','halt');
  c('总敞口', L.exposureUsd<=Number(E.LIVE_MAX_TOTAL_USD||1e9), `账本占用 $${L.exposureUsd.toFixed(2)}（${L.openCount} 仓）/ 上限 $${E.LIVE_MAX_TOTAL_USD}`);
  c('未决订单', L.unresolved===0, `${L.unresolved} 笔 pending/uncertain，需对账（node scripts/live-reconcile.js）`,'halt');
  c('日亏损线', !(L.realizedTodayUsd<=-Number(E.LIVE_DAILY_LOSS_STOP_USD||1e9)), `今日已实现 $${L.realizedTodayUsd.toFixed(2)}（UTC ${L.day}）/ 止损 -$${E.LIVE_DAILY_LOSS_STOP_USD}`,'halt');
  if(b.bnb!=null) c('BNB gas 储备', b.bnb>Number(E.LIVE_GAS_RESERVE_BNB||0), `${b.bnb.toFixed(4)} > ${E.LIVE_GAS_RESERVE_BNB}`);
  if(b.sol!=null) c('SOL gas 储备', b.sol>Number(E.LIVE_GAS_RESERVE_SOL||0), `${b.sol.toFixed(4)} > ${E.LIVE_GAS_RESERVE_SOL}`);
  c('行情数据新鲜', m.heartbeat && Date.now()-Date.parse(m.heartbeat)<180e3, '行情 bot 心跳 <3 分钟');
  const status=checks.some(x=>x.level==='halt')?'halt':checks.some(x=>x.level==='warn')?'warn':'ok';
  write('risk',{status,checks,limits:{perTrade:E.LIVE_MAX_PER_TRADE_USD,total:E.LIVE_MAX_TOTAL_USD,dailyStop:E.LIVE_DAILY_LOSS_STOP_USD,maxOpen:E.LIVE_MAX_OPEN_POSITIONS}});
}, 30000);
