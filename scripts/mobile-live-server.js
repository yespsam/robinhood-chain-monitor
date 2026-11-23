// 手机实盘看板：只读。0.0.0.0:4180  /  和 /api/live
import '../src/live-env-loader.js';
import { publicDecision, redactText } from '../src/live-redact.js';
import { readLiveRuntimeStatus } from '../src/mobile-live-status.js';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.MOBILE_LIVE_PORT || 4180);
const E = process.env;
async function rpc(url, method, params){ const r = await fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),signal:AbortSignal.timeout(6000)}); return (await r.json()).result; }
let cache={t:0,v:null};
async function balances(){ if(Date.now()-cache.t<20000) return cache.v; const out={};
  try{ if(E.LIVE_WALLET){ const h=await rpc('https://bsc-dataseed.bnbchain.org','eth_getBalance',[E.LIVE_WALLET,'latest']); out.bnb=Number(BigInt(h))/1e18; } }catch(e){ out.bnbErr='rpc_error'; }
  try{ if(E.LIVE_SOL_WALLET){ const r=await rpc('https://api.mainnet-beta.solana.com','getBalance',[E.LIVE_SOL_WALLET]); out.sol=r.value/1e9; } }catch(e){ out.solErr='rpc_error'; }
  cache={t:Date.now(),v:out}; return out; }
// Bounded tail read (last 512KB) instead of parsing the whole append-only file every request.
function tailText(file,max=512*1024){ const fd=fs.openSync(file,'r'); try{ const {size}=fs.fstatSync(fd); const len=Math.min(size,max); const b=Buffer.alloc(len); fs.readSync(fd,b,0,len,size-len); const t=b.toString('utf8'); return size>max?t.slice(t.indexOf('\n')+1):t; } finally{ fs.closeSync(fd); } }
function decisions(){ try{ return tailText(path.join(root,'data/live-decisions.jsonl')).trim().split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l)}catch{return null}}).filter(Boolean).slice(-200).reverse().map(publicDecision); }catch{ return []; } }
const rd=n=>{ try{ return JSON.parse(fs.readFileSync(path.join(root,'data/studio',n+'.json'),'utf8')); }catch{ return null; } };
const pidUp=g=>{ try{ process.kill(Number(fs.readFileSync(path.join(root,'data/studio',g+'.pid'),'utf8')),0); return true; }catch{ return false; } };
// 只读汇总：直接读三个 group 各自的状态文件，不托管任何进程
function board(){ const market=rd('market'),risk=rd('risk'),copy=rd('copy'); const fresh=(s,ms)=>!!(s?.heartbeat&&Date.now()-Date.parse(s.heartbeat)<ms);
  const g=(role,name,s,ms,file)=>({role,name,up:fresh(s,ms)&&pidUp(file),pid:s?.pid,heartbeat:s?.heartbeat||null});
  return {heartbeat:new Date().toISOString(),market,risk,copy,bots:[g('score','评分 group',market,150e3,'score'),g('risk','风控 group',risk,90e3,'risk'),g('copy','跟单 group',copy,90e3,'copy')]}; }
async function live(){ const B=board(), M=B?.market||{}, SC=M.scores||{}; const short=a=>a?a.slice(0,6)+'…'+a.slice(-4):null;
  const [runtime, walletBalances] = await Promise.all([readLiveRuntimeStatus({port:Number(E.DASHBOARD_PORT||4173)}), balances()]);
  return { now:new Date().toISOString(), enabled:runtime.enabled, configuredEnabled:E.LIVE_TRADING_ENABLED==='true', runtime, chains:runtime.chains, maxPerTrade:E.LIVE_MAX_PER_TRADE_USD, maxTotal:E.LIVE_MAX_TOTAL_USD, dailyStop:E.LIVE_DAILY_LOSS_STOP_USD, maxOpen:E.LIVE_MAX_OPEN_POSITIONS, bscWallet:short(E.LIVE_WALLET), solWallet:short(E.LIVE_SOL_WALLET), balances:walletBalances, decisions:decisions().map(d=>({...d,score:SC[(d.chain||'')+':'+(d.token||d.symbol)+':'+d.at]||null})), account:B?{equityUsd:M.equityUsd,pnlUsd:M.pnlUsd,pnlPct:M.pnlPct,baseline:M.baseline,balances:M.balances,prices:M.prices,asOf:M.heartbeat,fills:M.fills,note:M.note}:null, studio:B?{bots:B.bots,risk:B.risk&&{status:B.risk.status,checks:B.risk.checks,heartbeat:B.risk.heartbeat},copy:B.copy,work:Object.fromEntries([['score',B.market],['risk',B.risk],['copy',B.copy]].map(([k,v])=>[k,v&&{thinking:v.thinking,currentTask:v.currentTask,activityLog:v.activityLog}])),asOf:B.heartbeat}:null }; }
const AUTH=E.MOBILE_LIVE_TOKEN||'';
http.createServer(async (req,res)=>{ try{
  if(AUTH){ const u=new URL(req.url,'http://x'); const t=u.searchParams.get('t')||req.headers['x-live-token']; if(t!==AUTH&&!/^\/(assets|js)\//.test(req.url)){ res.writeHead(401); return res.end('unauthorized'); } }
  const am=req.url.match(/^\/assets\/([\w.-]+\.(jpg|jpeg|png|webp|svg))(\?.*)?$/i); if(am){ const fp=path.join(root,'dashboard/assets',am[1]); if(!fs.existsSync(fp)){res.writeHead(404);return res.end('not found');} res.writeHead(200,{'content-type':{jpg:'image/jpeg',jpeg:'image/jpeg',png:'image/png',webp:'image/webp',svg:'image/svg+xml'}[am[2].toLowerCase()],'cache-control':'public, max-age=3600'}); return res.end(fs.readFileSync(fp)); }
  const jm=req.url.match(/^\/js\/([\w.-]+\.js)(\?.*)?$/); if(jm){ const fp=path.join(root,'dashboard/js',jm[1]); if(!fs.existsSync(fp)){res.writeHead(404);return res.end('not found');} res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'public, max-age=600'}); return res.end(fs.readFileSync(fp)); }
  const gm=req.url.match(/^\/api\/(score|risk|copy)/); if(gm){ const B=board(),k={score:'market',risk:'risk',copy:'copy'}[gm[1]]; res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); return res.end(JSON.stringify({group:B.bots.find(b=>b.role==gm[1]),data:B[k]})); }
  if(req.url.startsWith('/api/live')){ res.writeHead(200,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'}); return res.end(JSON.stringify(await live())); }
  res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}); res.end(fs.readFileSync(path.join(root,'dashboard/mobile-live.html')));
 }catch(e){ console.error('[mobile-live]',redactText(e?.message||e)); res.writeHead(500); res.end('internal error'); } }).listen(PORT,'0.0.0.0',()=>console.log('mobile live on',PORT));
