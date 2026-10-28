import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeLaunch,launchAbi,SCAN_SOURCES} from '../server/chain-scanner.mjs';
import {OPENFOUR} from '../server/openfour-reader.mjs';
import {FOUR} from '../server/four-reader.mjs';
import {agentAbi} from '../server/flap-agent-reader.mjs';
import {coreAbi} from '../server/openfour-abi.mjs';
import {aggregateCandles,decodeChartTrade,createMarketCharts,tradeFilter,validateChartRequest,chartMarket} from '../server/market-chart.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0'),hex=n=>'0x'+n.toString(16),U=10n**18n;
const ca=addr(1),wallet=addr(2),market=addr(3),zero=addr(0);
const flap={protocol:'flap-agent',tokenAddress:ca,marketAddress:market,base:{decimals:18,symbol:'TEST'},quote:{address:zero,decimals:18,symbol:'BNB'}};
test('DEX routing preserves the original curve asset for historical chart fallback',()=>{
 const quote={address:addr(8),symbol:'GANG',decimals:18},m=chartMarket({protocol:'dex-swap',originProtocol:'gang-curve',originQuote:quote,quote:{address:zero,symbol:'BNB',decimals:18}});
 assert.equal(m.protocol,'gang-curve');assert.equal(m.quote,quote);
});
function log(encoded,address,block=990,index=0,blockHash=hash(block)){return {...encoded,address,blockNumber:hex(block),blockHash,transactionHash:hash(10000+block),logIndex:hex(index)};}
function flapLog({block=990,index=0,paid=U,shares=100n*U,side=0,blockHash=hash(block)}={}){return log(agentAbi.encodeEventLog(agentAbi.getEvent('VirtualTrade'),[1,wallet,side,shares,paid,paid,0,paid,paid,0,0,0,0,0,0,0]),market,block,index,blockHash);}
test('scanner excludes classic Four, ordinary Flap and all other OpenFour presets',()=>{
 const source=SCAN_SOURCES[0],args=preset=>[1,preset,wallet,ca,'Name','T',1000,800,10,1,zero,addr(4),addr(5),addr(6),addr(7),zero,addr(8),'',0,'0x'];
 const good=log(launchAbi.encodeEventLog(launchAbi.getEvent(source.event),args(BigInt(OPENFOUR.presetId))),source.address);
 assert.equal(decodeLaunch(good).presetId,OPENFOUR.presetId);assert.match(decodeLaunch(good).mode,/Agent ID/);
 assert.equal(decodeLaunch(log(launchAbi.encodeEventLog(launchAbi.getEvent(source.event),args(999n)),source.address)),null);
 const classic=log(launchAbi.encodeEventLog(launchAbi.getEvent('TokenCreate'),[wallet,ca,1,'N','S',1000,1,0]),FOUR.v2);assert.equal(decodeLaunch(classic),null);
 assert.equal(decodeLaunch({...good,address:addr(99)}),null);assert.deepEqual(SCAN_SOURCES.map(s=>s.platform),['Four.meme','Flap','Gang','Gang']);
});
test('chart price derives from actual user quote/base with correct token decimals and market identity',()=>{
 const trade=decodeChartTrade(flapLog(),flap);assert.equal(trade.price,0.01);assert.equal(trade.volume,100);assert.equal(trade.quoteVolume,1);
 assert.equal(decodeChartTrade(flapLog({paid:2500000n}),{...flap,quote:{address:addr(9),decimals:6,symbol:'USD'}}).price,0.025);
 assert.equal(decodeChartTrade({...flapLog(),address:addr(99)},flap),null);
 const four={...flap,protocol:'openfour-agent',presetId:OPENFOUR.presetId,quoteAsset:OPENFOUR.wrappedNative,runtime:{vault:addr(4)}};
 const event=preset=>coreAbi.encodeEventLog(coreAbi.getEvent('TradeExecuted'),[ca,wallet,preset,true,OPENFOUR.wrappedNative,addr(4),100n*U,100n*U,U,U+U/100n,1,1,0,0,0,0,0,0]);
 assert.equal(decodeChartTrade(log(event(BigInt(OPENFOUR.presetId)),OPENFOUR.core),four).price,0.0101);
 assert.equal(decodeChartTrade(log(event(999),OPENFOUR.core),four),null);assert.equal(tradeFilter(four).topics.length,4);
 const newer={...four,presetId:'999',adapter:'openfour-agent-v1',manager:OPENFOUR.core};assert.equal(chartMarket(newer),newer);assert.equal(decodeChartTrade(log(event(999),OPENFOUR.core),newer).price,0.0101);assert.equal(BigInt(tradeFilter(newer).topics[3]),999n);
 assert.throws(()=>chartMarket({...newer,adapter:null}),{code:'CHART_UNSUPPORTED_MODE'});assert.throws(()=>chartMarket({...newer,manager:addr(999)}),{code:'CHART_UNSUPPORTED_MODE'});
});
test('candles use exact chronological OHLC, deduplicate events and leave empty minutes unfilled',()=>{
 const t=(id,time,block,index,price)=>({id,time,block,index,price,volume:2,quoteVolume:2*price});
 const a=t('a',120,1,1,2),b=t('b',125,1,2,4),c=t('c',179,2,0,1),d=t('d',300,3,0,3);
 const rows=aggregateCandles([c,a,b,d,a],60);assert.equal(rows.length,2);assert.deepEqual(rows[0],{time:120,open:2,high:4,low:1,close:1,volume:6,quoteVolume:14,trades:3});assert.equal(rows[1].time,300);
 assert.throws(()=>aggregateCandles([t('x',1,1,1,Infinity)],60),{code:'CHART_PRICE_INVALID'});
});
test('history validates exact block timestamps, reads older data and replaces recent reorg trades',async()=>{
 let now=2000000,head=1000,changed=false,logs=[flapLog({block:990})];const calls=[];
 const rpc=async(method,params)=>{calls.push([method,params]);if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return hex(head);
  if(method==='eth_getBlockByNumber'){const b=Number(BigInt(params[0]));return {number:hex(b),hash:changed&&b===990?hash(9999):hash(b),timestamp:hex(1000+b)};}
  if(method==='eth_getLogs'){assert.equal(params[0].address,market);const from=Number(BigInt(params[0].fromBlock)),to=Number(BigInt(params[0].toBlock));return logs.filter(l=>Number(BigInt(l.blockNumber))>=from&&Number(BigInt(l.blockNumber))<=to);}
  throw Error('Unexpected method');};
 const charts=createMarketCharts({rpc,resolveMarket:async()=>flap,clock:()=>now,windowBlocks:30,maxHistoryBlocks:100});
 let chart=(await charts.query({tokenAddress:ca,interval:60})).chart;assert.equal(chart.tradeCount,1);assert.equal(chart.fromBlock,971);assert.equal(chart.candles[0].time,1980);assert.equal(chart.candles[0].close,0.01);
 changed=true;head=1006;now=2006000;logs=[flapLog({block:990,paid:2n*U,blockHash:hash(9999)})];chart=(await charts.query({tokenAddress:ca,interval:60})).chart;assert.equal(chart.tradeCount,1);assert.equal(chart.candles[0].close,0.02);
 logs.push(flapLog({block:950}));chart=(await charts.query({tokenAddress:ca,interval:300,older:true})).chart;assert.equal(chart.fromBlock,941);assert.equal(chart.tradeCount,2);assert.ok(calls.every(([m])=>m.startsWith('eth_get')||['eth_chainId','eth_blockNumber'].includes(m)));
});
test('chart cannot accept arbitrary contracts or fabricated timestamps',async()=>{
 assert.throws(()=>validateChartRequest({tokenAddress:ca,interval:60,to:addr(99)}),{code:'INVALID_REQUEST'});assert.throws(()=>validateChartRequest({tokenAddress:ca,interval:0}),{code:'INVALID_REQUEST'});
 const rpc=async m=>m==='eth_chainId'?'0x38':m==='eth_blockNumber'?'0x1':{number:'0x1',hash:hash(1),timestamp:'0x3e8'};
 const charts=createMarketCharts({rpc,clock:()=>1000000,resolveMarket:async()=>({...flap,protocol:'flap-standard'})});await assert.rejects(()=>charts.query({tokenAddress:ca,interval:60}),{code:'CHART_UNSUPPORTED_MODE'});
});
