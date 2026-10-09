import { createNativeReadonlyRunner } from './gmgn-readonly-market.js';

let run, closing=false, timer;
const jobs=new Set();
const send=message=>{if(process.connected)process.send(message,()=>{});};
const snapshot=()=>run?.diagnostics();
// Defense in depth: IPC cannot address wallets, signing, swaps, arbitrary CLI
// flags, files or shell commands. Only the five existing public read routes.
const routes=new Map([
  ['token:info',['--chain','--address']],['token:security',['--chain','--address']],
  ['market:trending',['--chain','--interval','--order-by','--limit']],
  ['market:kline',['--chain','--address','--resolution','--from','--to']],
  ['market:trenches',['--chain','--type','--limit']],
]);
function valid(message) {
  const a=message.args,flags=routes.get(`${a?.[0]}:${a?.[1]}`);
  if(!flags||!Array.isArray(a)||a.length>30||a.at(-1)!=='--raw'||!a.every(x=>typeof x==='string'&&x.length<=128)
    ||![0,1,2].includes(message.priority)||!Number.isSafeInteger(message.id))return false;
  const seen=new Set();
  for(let i=2;i<a.length-1;i+=2){
    if(!flags.includes(a[i])||!a[i+1]||a[i+1].startsWith('-')||seen.has(a[i])&&a[i]!=='--type')return false;
    seen.add(a[i]);
  }
  if(flags.some(flag=>!seen.has(flag)))return false;
  return message.latestClosedDuration===undefined||a[0]==='market'&&a[1]==='kline'
    &&a[a.indexOf('--resolution')+1]==='1m'&&Number.isInteger(message.latestClosedDuration)
    &&message.latestClosedDuration>0&&message.latestClosedDuration<=86400*31;
}
async function close() {
  if(closing)return;closing=true;clearInterval(timer);
  await run?.close();await Promise.allSettled([...jobs]);
  if(process.connected)process.disconnect();
}
process.on('message',message=>{
  if(message?.type==='close'){void close();return;}
  if(message?.type==='init'&&!run&&!closing){
    run=createNativeReadonlyRunner(message);
    timer=setInterval(()=>send({type:'snapshot',at:Date.now(),snapshot:snapshot()}),1000);timer.unref();return;
  }
  if(message?.type!=='read')return;
  if(!run||closing||!valid(message)){
    send({type:'result',id:message.id,ok:false,code:closing?'GMGN_STOPPED':'GMGN_STATE_INVALID',completedAt:Date.now()});return;
  }
  let requestedAt;
  const args=[...message.args];
  const work=Promise.resolve().then(()=>run(args,{priority:message.priority,onRequestStart:at=>{
    requestedAt=at;
    if(message.latestClosedDuration!==undefined){
      const end=Math.floor(at/60000)*60;
      args[args.indexOf('--from')+1]=String(end-message.latestClosedDuration);
      args[args.indexOf('--to')+1]=String(end);
    }
  }})).then(stdout=>({ok:true,stdout}),error=>({ok:false,code:error.code||'GMGN_UNAVAILABLE'}))
    .then(result=>send({type:'result',id:message.id,...result,requestedAt,completedAt:Date.now(),snapshot:snapshot()}))
    .finally(()=>jobs.delete(work));
  jobs.add(work);
});
process.once('disconnect',()=>{void close();});
process.once('SIGTERM',()=>{void close();});
process.once('SIGINT',()=>{void close();});
