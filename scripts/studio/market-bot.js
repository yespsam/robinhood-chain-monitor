// 行情·评分 bot：价格、权益、总盈亏%、代币评分
import fs from 'node:fs'; import path from 'node:path';
import { E, dir, write, decisions, rpc, loop, ledgerSummary } from './common.js';
const USDT='0x55d398326f99059fF775485246999027B3197955';
const chains=String(E.LIVE_CHAINS||E.LIVE_CHAIN||'').split(',').map(s=>s.trim()).filter(Boolean);
export function score(d){ let s=50; const why=[]; const add=(n,t)=>{s+=n;why.push((n>0?'+':'')+n+' '+t);};
  if((d.kind==='buy'||d.kind==='fill')) add(20,'成交'); if(d.kind==='skip') add(-10,'跳过'); if(d.kind==='error') add(-25,'报错');
  if(d.chain) chains.includes(d.chain)?add(10,'可执行链'):add(-15,'非执行链');
  if(d.paperUsd) add(5,'有信号仓位');
  if(/流动性|蜜罐|honeypot|税|tax|风险|rug|liquidity/i.test(d.reason||'')) add(-15,'风险词');
  if(Date.now()-Date.parse(d.at)<12*3600e3) add(5,'12h内');
  s=Math.max(0,Math.min(100,s)); return {score:s, grade:s>=75?'A':s>=60?'B':s>=45?'C':'D', why}; }
async function tick(){
  const px=Object.fromEntries((await (await fetch('https://api.binance.com/api/v3/ticker/price?symbols=%5B%22BNBUSDT%22,%22SOLUSDT%22%5D',{signal:AbortSignal.timeout(8000)})).json()).map(x=>[x.symbol,Number(x.price)]));
  const bal={};
  if(E.LIVE_WALLET){ bal.bnb=Number(BigInt(await rpc('https://bsc-dataseed.bnbchain.org','eth_getBalance',[E.LIVE_WALLET,'latest'])))/1e18;
    const data='0x70a08231'+E.LIVE_WALLET.slice(2).toLowerCase().padStart(64,'0');
    bal.usdt=Number(BigInt(await rpc('https://bsc-dataseed.bnbchain.org','eth_call',[{to:USDT,data},'latest'])))/1e18; }
  if(E.LIVE_SOL_WALLET){ bal.sol=(await rpc('https://api.mainnet-beta.solana.com','getBalance',[E.LIVE_SOL_WALLET])).value/1e9; }
  const equity=(bal.bnb||0)*px.BNBUSDT+(bal.usdt||0)+(bal.sol||0)*px.SOLUSDT;
  const bf=path.join(dir,'baseline.json'); let base;
  if(E.STUDIO_BASELINE_USD) base={usd:Number(E.STUDIO_BASELINE_USD),at:null,source:'env STUDIO_BASELINE_USD'};
  else { try{ base=JSON.parse(fs.readFileSync(bf,'utf8')); }catch{ base={usd:equity,at:new Date().toISOString(),source:'首次快照权益',balances:bal,prices:px}; fs.writeFileSync(bf,JSON.stringify(base,null,1)); } }
  const pnlUsd=equity-base.usd, pnlPct=base.usd?pnlUsd/base.usd*100:0;
  const scores={}; for(const d of decisions()){ if(d.symbol||d.token){ scores[(d.chain||'')+':'+(d.token||d.symbol)+':'+d.at]=score(d); } }
  const ledger=ledgerSummary();
  write('market',{prices:px,balances:bal,equityUsd:equity,cashEquityUsd:equity,equityComplete:false,ledger,realizedTodayUsd:ledger.realizedTodayUsd,openExposureUsd:ledger.exposureUsd,baseline:base,pnlUsd,pnlPct,fills:decisions().filter(d=>(d.kind==='buy'||d.kind==='fill')).length,scores,
    note:'权益只含 BNB/SOL/USDT 现金，不含持仓代币估值（不完整）；日亏以实盘账本 realized（止盈止损平仓同步）为准，不用权益变化。盈亏% = (现金权益 − 基准)/基准；评分为透明启发式 0–100，见 docs/mavis-studio-plan.md'});
}
loop(tick, 60000);
