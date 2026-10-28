import { createFlapTrader } from '../server/flap-trader.mjs';
const args=process.argv.slice(2),allowed=new Set(['--action','--intent-id','--execute']);
let action='buy',intentId,execute=false;
for(let i=0;i<args.length;i++){
  if(!allowed.has(args[i]))throw Error('INVALID_ARGUMENT');
  if(args[i]==='--execute'){if(execute)throw Error('DUPLICATE_ARGUMENT');execute=true;}
  else if(args[i]==='--action')action=args[++i];
  else intentId=args[++i];
}
if(!['buy','sell','claim'].includes(action)||execute&&!/^[a-zA-Z0-9_-]{8,100}$/.test(intentId||'')||!execute&&intentId)throw Error('INVALID_ARGUMENT');
const started=Date.now();
const trader=createFlapTrader({allowWrites:execute,onProgress:data=>process.stderr.write(JSON.stringify(data)+'\n')});
try{
  const data=await trader.handle(execute?'trade':'prepare',{profile:'heyi',action,...(execute?{intentId,deadlineMs:15000}:{})});
  process.stdout.write(JSON.stringify({readOnly:!execute,elapsedMs:Date.now()-started,...data},null,2)+'\n');
}catch(error){process.stdout.write(JSON.stringify({ok:false,code:error.code||'CHECK_FAILED',elapsedMs:Date.now()-started})+'\n');process.exitCode=1;}
