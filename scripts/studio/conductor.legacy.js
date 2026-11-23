// [已弃用] 旧指挥台：改为 scripts/studio/group.sh 独立启动三个 group，勿再运行
import { spawn } from 'node:child_process'; import path from 'node:path';
import { root, write, read, loop } from './common.js';
const roles={market:'行情·评分 bot',risk:'风控 bot',copy:'跟单 bot'}; const kids={};
function start(r){ const p=spawn(process.execPath,[path.join(root,'scripts/studio',r+'-bot.js')],{cwd:root,stdio:'inherit'}); kids[r]={p,restarts:(kids[r]?.restarts??-1)+1,since:new Date().toISOString()}; p.on('exit',()=>setTimeout(()=>start(r),5000)); }
Object.keys(roles).forEach(start);
loop(async()=>{ const bots=Object.entries(roles).map(([r,name])=>{ const s=read(r); const fresh=s?.heartbeat&&Date.now()-Date.parse(s.heartbeat)<(r==='market'?150e3:90e3);
  return {role:r,name,up:!!fresh,pid:kids[r]?.p.pid,restarts:kids[r]?.restarts,heartbeat:s?.heartbeat||null}; });
  bots.unshift({role:'conductor',name:'指挥台',up:true,pid:process.pid,restarts:0,heartbeat:new Date().toISOString()});
  write('board',{bots,market:read('market'),risk:read('risk'),copy:read('copy')});
}, 15000);
process.on('SIGTERM',()=>{ Object.values(kids).forEach(k=>{k.p.removeAllListeners('exit');k.p.kill();}); process.exit(0); });
