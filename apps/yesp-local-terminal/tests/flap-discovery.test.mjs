import test from 'node:test';
import assert from 'node:assert/strict';
import {createFlapDiscovery,discoveryAbi} from '../server/flap-discovery.mjs';
import {FLAP_MARKET,marketViewAbi} from '../server/flap-market.mjs';
import {createChainScanner,launchAbi,SCAN_SOURCES} from '../server/chain-scanner.mjs';
const addr=n=>'0x'+n.toString(16).padStart(40,'0'),hash=n=>'0x'+n.toString(16).padStart(64,'0');
function fixture({total=79,wrongFactory=false,wrongCard=false,incomplete=false,phase=1}={}){
 const calls=[];
 const rpc=async(method,p)=>{calls.push([method,p]);if(method==='eth_chainId')return '0x38';if(method==='eth_blockNumber')return '0x100';if(method==='eth_getBlockByNumber')return {number:'0x100',timestamp:'0x3e8'};
  assert.equal(method,'eth_call');assert.equal(p[1],'0x100');let tx;try{tx=discoveryAbi.parseTransaction({data:p[0].data});}catch{}
  if(tx){if(tx.name==='factory')return discoveryAbi.encodeFunctionResult('factory',[wrongFactory?addr(99):FLAP_MARKET.factory]);
   if(tx.name==='marketCount')return discoveryAbi.encodeFunctionResult('marketCount',[total]);
   if(tx.name==='marketPage'){const [start,size]=tx.args;return discoveryAbi.encodeFunctionResult('marketPage',[Array.from({length:Number(size)-(incomplete?1:0)},(_,i)=>addr(Number(start)+i+1)),start+size,total]);}}
  const {args}=marketViewAbi.parseTransaction({data:p[0].data});
  const cards=args[0].map(m=>{const n=Number(BigInt(m));return [wrongCard?addr(999):m,addr(0),'Market '+n,'T'+n,'',addr(n+1000),phase===3?addr(n+2000):addr(0),addr(0),phase,100,1000,1000,1,2,1,1];});
  return marketViewAbi.encodeFunctionResult('marketCards',[cards]);};
 return {calls,reader:createFlapDiscovery({rpc,clock:()=>1000000})};
}
test('official Flap directory includes older markets without a creation-event history and sorts latest first',async()=>{
 const f=fixture(),s=await f.reader.read();assert.equal(s.total,79);assert.equal(s.rows.length,79);assert.equal(s.rows[0].creationId,79);assert.equal(s.rows[0].tokenAddress.toLowerCase(),addr(1079));assert.equal(s.rows[0].marketAddress,addr(79));
 assert.equal(s.rows[0].chainTimestamp,null);assert.equal(s.rows[0].txHash,null);assert.ok(f.calls.every(([m])=>!m.includes('send')&&!m.includes('Logs')));
});
test('directory caps the list at latest 100 and uses deployed token after graduation',async()=>{
 const s=await fixture({total:120,phase:3}).reader.read();assert.equal(s.rows.length,100);assert.equal(s.rows.at(-1).creationId,21);assert.equal(s.rows[0].tokenAddress.toLowerCase(),addr(2120));assert.equal(s.rows[0].predictedToken.toLowerCase(),addr(1120));
});
for(const config of [{wrongFactory:true},{wrongCard:true},{incomplete:true},{phase:0}])test('directory rejects mismatched or incomplete official binding '+JSON.stringify(config),async()=>{await assert.rejects(fixture(config).reader.read());});
test('directory survives event RPC failure, deduplicates recent events, and preserves last good snapshot on error',async()=>{
 let now=1000,fail=false;const row={id:'flap:'+addr(4),platform:'Flap',marketAddress:addr(4),tokenAddress:addr(5),creationId:1,source:'flap-agent-directory',symbol:'FRESH',confirmed:true};
 const discovery={read:async()=>{if(fail)throw Error();return {total:1,updatedAt:now,rows:[row]};}};
 const scanner=createChainScanner({rpc:async()=>{throw Error();},discovery,clock:()=>now});await scanner.refreshDirectory();await scanner.tick();assert.equal(scanner.state().rows.length,1);assert.equal(scanner.state().rows[0].symbol,'FRESH');assert.ok(scanner.state().error);
 now=20000;fail=true;await scanner.refreshDirectory();assert.equal(scanner.state().rows.length,1);assert.equal(scanner.state().rows[0].stale,true);assert.equal(scanner.state().flapDirectory.error,'FLAP_DIRECTORY_UNAVAILABLE');
 const source=SCAN_SOURCES[1],log={...launchAbi.encodeEventLog(launchAbi.getEvent(source.event),[addr(2),addr(4),addr(5),addr(0),hash(1)]),address:source.address,blockNumber:'0xff',logIndex:'0x0',blockHash:hash(2),transactionHash:hash(3)};
 fail=false;const rpc=async(m,p)=>m==='eth_chainId'?'0x38':m==='eth_blockNumber'?'0x100':m==='eth_call'?Promise.reject(Error()):p[0].address===source.address?[log]:[];
 const merged=createChainScanner({rpc,discovery,clock:()=>now,lookback:4});await merged.refreshDirectory();await merged.tick();assert.equal(merged.state().rows.length,1);assert.equal(merged.state().rows[0].txHash,hash(3));assert.equal(merged.state().rows[0].creationId,1);
});
