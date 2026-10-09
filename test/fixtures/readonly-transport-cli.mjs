import fs from 'node:fs';
import path from 'node:path';
const args=process.argv.slice(2),log=path.join(path.dirname(process.argv[1]),'calls.jsonl');
const append=value=>fs.appendFileSync(log,JSON.stringify({...value,at:Date.now()})+'\n');
if(args[0]==='config'){
  append({type:'config'});
  const settingsFile=path.join(path.dirname(process.argv[1]),'config-behavior.json');
  const settings=fs.existsSync(settingsFile)?JSON.parse(fs.readFileSync(settingsFile,'utf8')):{};
  setTimeout(()=>{
    if(settings.fail){console.error('PRIVATE_CONFIG_DIAGNOSTIC');process.exit(1);}
    if(settings.rateLimit){console.error(JSON.stringify({code:429,error:'RATE_LIMIT_BANNED',reset_at:Math.floor(Date.now()/1000)+300}));process.exit(1);}
    process.exit(0);
  },settings.delayMs||0);
}else{
append({type:'start',args});
const address=args[args.indexOf('--address')+1];
setTimeout(()=>{
  append({type:'end',args});
  if(address==='0x'+ '6'.repeat(40)){console.error('fetch failed ECONNRESET PRIVATE_NETWORK_DIAGNOSTIC');process.exit(1);}
  if(address==='0x'+ '9'.repeat(40)){console.log(JSON.stringify({code:429,error:'RATE_LIMIT_BANNED',reset_at:Math.floor(Date.now()/1000)+300}));return;}
  if(args[1]==='kline'){
    const end=Number(args[args.indexOf('--to')+1]);
    console.log(JSON.stringify({data:{list:[{time:(end-60)*1000,open:1,high:2,low:1,close:2,volume:123,amount:456}]}}));return;
  }
  console.log(JSON.stringify({data:{chain:'bsc',address:address==='0x'+'8'.repeat(40)?'0x'+'7'.repeat(40):address,price:{price:1.2}}}));
},400);
}
