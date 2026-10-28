import {safeFunding,safeBudget} from '../extension/funding-model.js';
import {validateAutomatic} from './automatic-policy.mjs';
import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import {createFastTradeCli} from './fast-trade-cli.mjs';
import {createFlapTrader} from './flap-trader.mjs';
import {createWalletTransfer} from './wallet-transfer.mjs';
import {createFourTrader} from './four-trader.mjs';
import {createPanelRouter} from './panel-router.mjs';
import {createFlapRpc,fault} from './flap-reader.mjs';
import {batchedRpc} from './batched-rpc.mjs';
import {createResilientReadRpc} from './resilient-read-rpc.mjs';
import {createGangDiscovery} from './gang-discovery.mjs';
import {createChainScanner} from './chain-scanner.mjs';
import {createScanEnrichment} from './scan-enrichment.mjs';
import {createFourDiscovery} from './four-discovery.mjs';
import {createMarketCharts} from './market-chart.mjs';
import {createGmgnCharts,createChartSources} from './gmgn-chart.mjs';
import {createSniper} from './sniper.mjs';
import {createGangLaunchStrategy} from './gang-launch-strategy.mjs';
import {createGangLaunchSource} from './gang-launch-source.mjs';
import {createGangLaunchGateway} from './gang-launch-gateway.mjs';
import {createModeWatch} from './mode-watch.mjs';
import {signinDisplay} from './wallet-signin.mjs';
import {validateRequest,sanitizeBridgeData} from '../scripts/flap-native-host.mjs';
const ROOT=fileURLToPath(new URL('../extension/',import.meta.url));
const assets=new Set(['trade.html','trade.css','terminal.css','trade-ui.js','trade-model.js','funding-model.js','slippage-policy.js','client-bridge.js','local-features.js','gang-launch-ui.js','mode-ui.js','scan-ui.js','market-chart.js','wallet.html','wallet.css','wallet.js','signin-policy.js']);
const terminal=new Set(['COMPLETE','FAILED','REJECTED','CANCELLED']);
const UUID=/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const replaySensitive=new Set(['panelTrade','panelExecute','transfer','signin','verify','sniperArm','sniperCancel','gangLaunchArm','gangLaunchPause']);
const financialControl=new Set(['panelTrade','panelExecute','transfer','sniperArm','gangLaunchArm']);
export function createLocalApp({cli=createFastTradeCli({allowWrites:true,allowAuth:true,readTimeoutMs:15000,previewTimeoutMs:15000}),
 rpc=batchedRpc(createResilientReadRpc({url:process.env.YESP_RPC_URL||'https://bsc-dataseed.bnbchain.org'})),trader,scanner=createChainScanner({details:createScanEnrichment(),fourDiscovery:createFourDiscovery(),gangDiscovery:createGangDiscovery()}),sniper,gangLaunch,transfer,auth,charts,gmgn=createGmgnCharts(),modes=createModeWatch()}={}){
 trader??=createFourTrader({cli,reader:createPanelRouter({rpc}),allowWrites:true,panel:true,onProgress:data=>publish('trade',data)});
 charts??=createChartSources({gmgn,onchain:createMarketCharts({resolveMarket:createPanelRouter({rpc}).inspect})});
 const gangGateway=trader.startStrategy?createGangLaunchGateway({trader,reader:createPanelRouter({rpc}),cli}):null;
 sniper??=createSniper({trader,modes,gangGateway});transfer??=createWalletTransfer({cli,allowWrites:true});auth??=createFlapTrader({cli,allowAuth:true});
 gangLaunch??=trader.startStrategy?createGangLaunchStrategy({source:createGangLaunchSource({rpc}),gateway:createGangLaunchGateway({trader,reader:createPanelRouter({rpc}),cli})}):{init(){},start(){},stop(){},isLive:()=>false,state:()=>({run:null,positions:[],events:[],active:false,busy:false}),subscribe(){}};
 let controlGate=Promise.resolve();const serializeControl=fn=>{const p=controlGate.then(fn);controlGate=p.catch(()=>{});return p;};
 const csrf=randomBytes(32).toString('hex'),seen=new Map(),clients=new Set();let origin=null;
 const publish=(name,data)=>{const text=`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;for(const res of clients){if(res.writableLength>1000000){res.destroy();clients.delete(res);}else res.write(text);}};
 scanner.subscribe(data=>publish('scanner',data));sniper.subscribe(data=>publish('sniper',data));
 modes.subscribe(data=>publish('modes',data));
 gangLaunch.subscribe(data=>publish('gangLaunch',data));
 const send=(res,status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));};
 async function dispatch(r){
  if(!r||Object.keys(r).some(k=>!['id','method','params'].includes(k))||!UUID.test(r.id||'')||typeof r.method!=='string'||!r.params||typeof r.params!=='object'||Array.isArray(r.params))throw fault('INVALID_REQUEST');
  const {method,params}=r;
  if(method.startsWith('gangLaunch')){
   if(method==='gangLaunchStatus'&&Object.keys(params).length===0){await gangLaunch.init();return {gangLaunch:gangLaunch.state()};}
   if(method==='gangLaunchDraft')return gangLaunch.draft(params);
   if(method==='gangLaunchArm'&&Object.keys(params).length===1&&UUID.test(params.draftId||'')){await sniper.init();if(sniper.state().jobs.some(j=>['ARMED','SUBMITTING'].includes(j.state)))throw fault('SNIPE_ACTIVE');return gangLaunch.arm(params);}
   if(method==='gangLaunchPause'&&Object.keys(params).length===1&&typeof params.buysOnly==='boolean')return gangLaunch.pause(params);
   if(method==='gangLaunchReconcile'&&Object.keys(params).length===1&&UUID.test(params.id||''))return gangLaunch.reconcile(params);
   throw fault('INVALID_REQUEST');
  }
  if(gangLaunch.isLive()&&['sniperArm','panelTrade','panelPrepare','panelExecute','transferPrepare','transfer'].includes(method))throw Object.assign(fault('GANG_STRATEGY_ACTIVE'),{submissionNotStarted:true});
  if(method.startsWith('sniper')){
   if(method==='sniperDraft')return sniper.draft(params);
   if(method==='sniperArm'&&Object.keys(params).length===1&&UUID.test(params.draftId||''))return sniper.arm(params);
   if(method==='sniperCancel'&&Object.keys(params).length===1&&UUID.test(params.id||''))return sniper.cancel(params);
   if(method==='sniperStatus'&&Object.keys(params).length===0){await sniper.init();return {sniper:sniper.state()};}throw fault('INVALID_REQUEST');
  }
  if(method==='scannerStatus'&&Object.keys(params).length===0)return {scanner:scanner.state()};
  if(method==='modeStatus'&&Object.keys(params).length===0){await modes.init();return {modes:modes.state()};}
  if(method==='modeRefresh'&&Object.keys(params).length===0){await modes.refreshSources(true);await modes.refresh();return {modes:modes.state()};}
  if(method==='chartQuery')return charts.query(params);
  if(method==='gmgnStatus'&&Object.keys(params).length===0)return gmgn.status();
  if(method==='gmgnConfigure')return gmgn.configure(params);
  if(method==='panelTrade'){validateAutomatic(params);if(sniper.state().jobs.some(j=>['ARMED','SUBMITTING'].includes(j.state)))throw Object.assign(fault('SNIPE_ACTIVE'),{submissionNotStarted:true});return trader.handle(method,params);}
  if(['openWallet','openFour','openTrade'].includes(method))return {navigate:method==='openWallet'?'/wallet.html':'/trade.html'};
  if(!['panelStatus','panelQuery','panelPrepare','panelExecute','panelReconcile','walletStatus','transferPrepare','transfer','transferReconcile','signin','verify'].includes(method))throw fault('INVALID_REQUEST');
  validateRequest(r);
  if(['panelPrepare','panelExecute','transferPrepare','transfer'].includes(method)&&sniper.state().jobs.some(j=>['ARMED','SUBMITTING'].includes(j.state)))throw Object.assign(fault('SNIPE_ACTIVE'),{submissionNotStarted:true});
  if(method.startsWith('panel'))return trader.handle(method,params);
  if(['walletStatus','transferPrepare','transfer','transferReconcile'].includes(method))return transfer.handle(method,params);
  const result=await auth.handle(method,params);return method==='signin'?signinDisplay(result):result;
 }
 async function handle(req,res){
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  const topNavigation=req.method==='GET'&&['/','/trade.html','/wallet.html'].includes(req.url)&&req.headers['sec-fetch-mode']==='navigate'&&req.headers['sec-fetch-dest']==='document';
  if(!origin||req.headers.host!==new URL(origin).host||req.headers.origin&&req.headers.origin!==origin||req.headers['sec-fetch-site']==='cross-site'&&!topNavigation)return send(res,403,{error:{code:'LOCAL_ORIGIN_REQUIRED'}});
  const url=new URL(req.url,origin);if(url.search||url.hash)return send(res,400,{error:{code:'INVALID_REQUEST'}});
  if(req.method==='GET'){
   if(/^\/api\/token-image\/[a-f\d]{64}$/.test(url.pathname)){
    try{const data=await scanner.image?.(url.pathname.split('/').at(-1));if(!data)throw fault('IMAGE_NOT_FOUND');res.setHeader('Content-Type',data.type);res.setHeader('Cache-Control','private, max-age=600');return res.end(data.body);}
    catch(e){return send(res,e.code==='IMAGE_BUSY'?429:404,{error:{code:'IMAGE_UNAVAILABLE'}});}
   }
   if(url.pathname==='/api/health')return send(res,200,{name:'YESP Local Terminal',version:'1.11.0',network:'BSC',port:server.address().port});
   if(url.pathname==='/api/session')return send(res,200,{csrf});
   if(url.pathname==='/api/events'){
    if(clients.size>=8)return send(res,429,{error:{code:'TOO_MANY_STREAMS'}});res.writeHead(200,{'Content-Type':'text/event-stream','Connection':'keep-alive'});res.write(': YESP local stream\n\n');clients.add(res);req.on('close',()=>clients.delete(res));
    for(const [name,data] of [['scanner',scanner.state()],['sniper',sniper.state()],['gangLaunch',gangLaunch.state()],['modes',modes.state()],['metrics',rpc.metrics?.()||{}]])res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);return;
   }
   const file=url.pathname==='/'?'trade.html':url.pathname.slice(1);if(!assets.has(file))return send(res,404,{error:{code:'NOT_FOUND'}});
   try{const data=await readFile(resolve(ROOT,file));res.setHeader('Content-Type',file.endsWith('.html')?'text/html; charset=utf-8':file.endsWith('.css')?'text/css; charset=utf-8':'text/javascript; charset=utf-8');res.end(data);}catch{return send(res,404,{error:{code:'NOT_FOUND'}});}return;
  }
  if(req.method!=='POST'||url.pathname!=='/api/request')return send(res,405,{error:{code:'METHOD_NOT_ALLOWED'}});
  const given=Buffer.from(typeof req.headers['x-yesp-csrf']==='string'?req.headers['x-yesp-csrf']:''),expected=Buffer.from(csrf);
  if(req.headers.origin!==origin||given.length!==expected.length||!timingSafeEqual(given,expected)||req.headers['content-type']!=='application/json')return send(res,403,{error:{code:'LOCAL_CSRF_REQUIRED'}});
  let request;try{const chunks=[];let bytes=0;for await(const part of req){bytes+=part.length;if(bytes>16384)throw fault('REQUEST_TOO_LARGE');chunks.push(part);}request=JSON.parse(Buffer.concat(chunks).toString('utf8'));
   if(!UUID.test(request.id||''))throw fault('INVALID_REQUEST');if(seen.has(request.id))throw fault('REQUEST_ID_REUSED');if(seen.size>10000)throw fault('TOO_MANY_REQUESTS');seen.set(request.id,true);
   const start=performance.now(),data=sanitizeBridgeData(await (financialControl.has(request.method)?serializeControl(()=>dispatch(request)):dispatch(request)),request.method==='signin');
   publish('metrics',{...rpc.metrics?.(),lastOperation:request.method,lastOperationMs:Math.round(performance.now()-start)});
   const guard=Object.hasOwn(data,'operation')?(data.operation&&!terminal.has(data.operation.status)?{intentId:data.operation.intentId,status:data.operation.status,txHash:data.operation.txHash}:null):undefined;
   return send(res,200,{id:request.id,ok:true,data,...(guard!==undefined?{guard}:{})});
  }catch(e){const code=/^[A-Z][A-Z0-9_]{0,80}$/.test(e.code||'')?e.code:'LOCAL_REQUEST_FAILED';return send(res,200,{id:request?.id,ok:false,error:{code,...(code==='INSUFFICIENT_BALANCE'&&safeFunding(e.details?.funding)?{funding:safeFunding(e.details.funding)}:{}),...(code==='FUNDING_BUDGET_EXCEEDED'&&safeBudget(e.details?.budget)?{budget:safeBudget(e.details.budget)}:{})},...(e.submissionNotStarted?{submissionNotStarted:true,guard:null}:{})});}
  finally{if(request&&!replaySensitive.has(request.method))seen.delete(request.id);}
 }
 const server=http.createServer((req,res)=>{handle(req,res).catch(()=>{if(!res.headersSent)send(res,500,{error:{code:'LOCAL_SERVER_ERROR'}});else res.destroy();});});
 server.headersTimeout=15000;server.requestTimeout=330000;
 let heartbeat;
 return {server,scanner,sniper,gangLaunch,async listen(port=8717){await gangLaunch.init();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin=`http://127.0.0.1:${server.address().port}`;
   scanner.start();modes.start();sniper.start();gangLaunch.start();heartbeat=setInterval(()=>publish('metrics',rpc.metrics?.()||{}),10000);heartbeat.unref?.();return origin;},
  async close(){clearInterval(heartbeat);scanner.stop();await gangLaunch.stop();await sniper.stop();await modes.stop();await trader.drain?.();for(const c of clients)c.end();await new Promise(r=>server.close(r));await auth.close?.();}};
}
export async function main(){const app=createLocalApp();const url=await app.listen();process.stdout.write(`YESP Local Terminal 1.11.0\n${url}\n`);let closing=false;
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{if(!closing){closing=true;app.close().then(()=>process.exit(0));}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(e=>{process.stderr.write(`YESP: ${/^[A-Z][A-Z0-9_]+$/.test(e.code||'')?e.code:'START_FAILED'}\n`);process.exitCode=1;});
