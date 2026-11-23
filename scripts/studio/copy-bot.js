// 跟单 bot（观察者）：真实下单由 launchd com.qohfq.yesp-atm-dashboard（scripts/dashboard-server.js → paper-strategy-runtime → live-gmgn-mirror → live-gmgn-trader）执行，这里只监控，不下单。
// 改 trader/mirror/runtime 后必须重启 yesp-atm-dashboard，只重启主监控(src/index.js)不生效。
import { execSync } from 'node:child_process';
import { E, write, decisions, loop } from './common.js';
import { publicDecision } from '../../src/live-redact.js';
loop(async()=>{ let executorUp=false; try{ executorUp=/scripts\/dashboard-server\.js/.test(execSync('ps -axo command',{encoding:'utf8'})); }catch{}
  const ds=decisions(); const last=ds[ds.length-1]||null; const fills=ds.filter(d=>(d.kind==='buy'||d.kind==='fill'));
  write('copy',{executorUp,enabled:E.LIVE_TRADING_ENABLED==='true',signalSource:E.LIVE_SIGNAL_SOURCE,chains:E.LIVE_CHAINS||E.LIVE_CHAIN,
    lastDecision:last&&{at:last.at,kind:last.kind,chain:last.chain,symbol:last.symbol},fillCount:fills.length,lastFill:fills.length?publicDecision(fills[fills.length-1]):null});
}, 30000);
