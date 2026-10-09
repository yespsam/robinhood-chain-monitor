// Bounded read-only verification; credential values are never printed.
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import WebSocket from 'ws';
import {loadPrivateBscRpcConfig,sanitizeBscRpcError} from '../src/bsc-private-rpc.js';
import {createInnerTradeRpcReader} from '../src/bsc-inner-trade-monitor.js';
import {INNER_TRADE_EMITTERS,INNER_TRADE_ORACLE,INNER_TRADE_ORACLE_ABI} from '../src/bsc-inner-trade-events.js';

const dataDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../data');
const config=loadPrivateBscRpcConfig({dataDir});
if(!config)throw new Error('PRIVATE_BSC_RPC_NOT_CONFIGURED');
const results={at:new Date().toISOString(),host:config.host,readOnly:true,http:[],wss:null};
const reader=createInnerTradeRpcReader({host:config.host,endpointUrl:config.httpUrl});
async function check(name,fn,summarize=x=>x) {
  const start=performance.now();
  try{const value=await fn();results.http.push({method:name,ok:true,ms:Math.round(performance.now()-start),result:summarize(value)});return value;}
  catch(error){results.http.push({method:name,ok:false,ms:Math.round(performance.now()-start),error:sanitizeBscRpcError(error)});throw error;}
}
try {
  await check('eth_chainId',()=>reader.getNetwork());
  const head=await check('eth_blockNumber',()=>reader.getBlockNumber());
  const block=head-8;
  await check('eth_getBlockByNumber(batch=3)',()=>reader.getBlocks([block-2,block-1,block]),rows=>({count:rows.length,lastNumber:rows.at(-1).number,lastTimestamp:rows.at(-1).timestamp}));
  const emitter=INNER_TRADE_EMITTERS.four_v2;
  await check('eth_getLogs(scoped,4 blocks)',()=>reader.getLogs({address:emitter.address,topics:[emitter.topics],fromBlock:block-3,toBlock:block}),rows=>({count:rows.length}));
  await check('eth_call(oracle,read-only)',()=>reader.call({to:INNER_TRADE_ORACLE,data:INNER_TRADE_ORACLE_ABI.encodeFunctionData('latestRoundData'),blockTag:block}),value=>({bytes:(value.length-2)/2}));
  results.wss=await new Promise(resolve=>{
    const start=performance.now(),socket=new WebSocket(config.wsUrl,{handshakeTimeout:7000,maxPayload:512000});
    let finished=false,chainChecked=false,subscription=null,heads=0,firstHeadMs=null;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);socket.terminate();resolve({...value,ms:Math.round(performance.now()-start),heads,firstHeadMs});};
    const timer=setTimeout(()=>finish({ok:false,reason:'bounded_wss_probe_timeout'}),14000);
    socket.on('open',()=>socket.send(JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})));
    socket.on('message',data=>{
      let message;try{message=JSON.parse(data.toString());}catch{return finish({ok:false,reason:'invalid_json'});}
      if(message.error)return finish({ok:false,reason:'rpc_error'});
      if(message.id===1){if(message.result!=='0x38')return finish({ok:false,reason:'chain_mismatch'});chainChecked=true;
        socket.send(JSON.stringify({jsonrpc:'2.0',id:2,method:'eth_subscribe',params:['newHeads']}));}
      else if(message.id===2){if(!chainChecked||typeof message.result!=='string')return finish({ok:false,reason:'subscription_identity'});subscription=message.result;}
      else if(message.method==='eth_subscription'&&message.params?.subscription===subscription){
        if(!/^0x[0-9a-f]+$/i.test(message.params?.result?.number||''))return finish({ok:false,reason:'invalid_head'});
        heads++;firstHeadMs??=Math.round(performance.now()-start);
        if(heads===3)socket.send(JSON.stringify({jsonrpc:'2.0',id:3,method:'eth_unsubscribe',params:[subscription]}));
      }else if(message.id===3)finish({ok:message.result===true,chainId:56,unsubscribed:message.result===true});
    });
    socket.on('error',error=>finish({ok:false,error:sanitizeBscRpcError(error)}));
    socket.on('close',()=>finish({ok:false,reason:'connection_closed_before_completion'}));
  });
}catch{/* check has recorded a sanitized error; do not send additional probes. */}
console.log(JSON.stringify(results,null,2));
if(results.http.some(x=>!x.ok)||!results.wss?.ok)process.exitCode=1;
