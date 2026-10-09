import test from 'node:test';
import assert from 'node:assert/strict';
import {ZeroAddress} from 'ethers';
import {INNER_TRADE_ORACLE_ABI,INNER_TRADE_ERC20_ABI,
  INNER_TRADE_EMITTERS,innerTradeLogToken,normalizeInnerTradeWindow} from '../src/bsc-inner-trade-events.js';
import {buildInnerTradeFixture as fixture,buildInnerTradeLog as log,innerTradeTestHash as h,
  INNER_TRADE_TEST_NOW as NOW,INNER_TRADE_TEST_CA as CA} from './helpers/inner-trade-fixture.js';
const OTHER='0x'+'b'.repeat(40);

for(const platform of ['four_v2','flap']) {
  test(`${platform}: native quote volume normalized from verified raw logs, never tags wallets`,()=>{
    const p=fixture(platform),out=normalizeInnerTradeWindow(p,NOW);
    assert.equal(out.ready,true);assert.equal(out.trades.length,2);assert.equal(out.trades[0].at,NOW-20000);
    assert.equal(out.trades[0].amountUsd,1000);assert.equal(out.trades[1].amountUsd,1000);
    assert.equal(out.trades[0].quoteAmount,1);assert.equal(out.trades[0].baseAmount,1000);
    assert.deepEqual(out.trades.map(t=>t.side),['buy','sell']);assert.deepEqual(out.trades[0].tags,[]);
    assert.equal(out.trades[0].group,p.logs[0].transactionHash);assert.equal(out.trades[0].amountBasis,'event_quote_volume_not_wallet_net_proceeds');
    assert.equal(innerTradeLogToken(platform,p.logs[0]),CA);
    assert.deepEqual(out.coverage,{startAt:NOW-100000,endAt:NOW-2000});
    assert.equal(JSON.stringify(p),JSON.stringify(fixture(platform)));
  });
  test(`${platform}: known non-BNB quote is explicitly unsupported, not dollarized`,()=>{
    const p=fixture(platform),s=INNER_TRADE_EMITTERS[platform],result=s.metadataAbi.decodeFunctionResult(s.metadataMethod,p.metadata.raw.info);
    if(platform==='four_v2') {const r=[...result];r[2]=OTHER;p.metadata.raw.info=s.metadataAbi.encodeFunctionResult(s.metadataMethod,r);}
    else {const r=[...result[0]];r[9]=OTHER;p.metadata.raw.info=s.metadataAbi.encodeFunctionResult(s.metadataMethod,[r]);}
    const out=normalizeInnerTradeWindow(p,NOW);assert.equal(out.ready,false);assert.equal(out.code,'unsupported_quote');assert.deepEqual(out.trades,[]);
  });
  test(`${platform}: strict source, raw layout, timestamps, range, and metadata binding`,()=>{
    const mutations=[p=>p.chainId=1,p=>p.contract=OTHER,p=>p.tokenAddress=ZeroAddress,p=>p.observedAt=new Date(NOW+1).toISOString(),
      p=>p.endBlockHash=h(666),p=>p.range.complete=false,p=>p.range.truncated=true,p=>p.logs[0].removed=true,
      p=>p.logs[0].address=OTHER,p=>p.logs[0].topics.push(h(1)),p=>p.logs[0].data+='00'.repeat(32),
      p=>p.logs[0].blockHash=h(999),p=>p.logs[0].transactionHash='not-a-hash',p=>p.logs[0].transactionIndex=-1,
      p=>p.logs[0].index=7,p=>p.blocks.splice(1,1),p=>p.metadata.tokenAddress=OTHER,p=>p.metadata.source=OTHER,
      p=>p.metadata.blockNumber--,p=>p.metadata.blockHash=h(10),p=>p.oracle.address=OTHER,p=>p.oracle.blockNumber--,
      p=>p.oracle.blockHash=h(9),p=>p.oracle.raw.decimals=INNER_TRADE_ERC20_ABI.encodeFunctionResult('decimals',[18]),
      p=>p.logs=Array(4001).fill(p.logs[0]),p=>p.segments=Array(65).fill(p.segments[0])];
    for(const mutate of mutations){const p=fixture(platform);mutate(p);assert.equal(normalizeInnerTradeWindow(p,NOW).ready,false,mutate.toString());}
    assert.equal(normalizeInnerTradeWindow(fixture(platform),NOW+31000).ready,false);
  });
}

test('segments require contiguous queried ranges and matching anchors; shared one-block boundary accepted',()=>{
  const p=fixture();p.segments=[{fromBlock:100,toBlock:175,startHash:h(100),endHash:h(175),startParentHash:h(99)},
    {fromBlock:175,toBlock:200,startHash:h(175),endHash:h(200),startParentHash:h(174)}];
  assert.equal(normalizeInnerTradeWindow(p,NOW).ready,true);
  for(const mutate of [x=>x.segments[1].fromBlock=177,x=>x.segments[1].startHash=h(999),x=>x.segments[1].fromBlock=174,x=>x.segments[1].toBlock=199,
    x=>x.segments[0].fromBlock=101,x=>x.blocks[1].hash=h(999)]){const x=structuredClone(p);mutate(x);assert.equal(normalizeInnerTradeWindow(x,NOW).ready,false);}
  p.segments[1].fromBlock=176;p.segments[1].startHash=h(176);p.segments[1].startParentHash=h(175);
  assert.equal(normalizeInnerTradeWindow(p,NOW).ready,true);
  p.segments[1].startParentHash=h(999);assert.equal(normalizeInnerTradeWindow(p,NOW).ready,false);
});

test('duplicate identity conflicts fail; same transaction multiple logs retained and grouped; only requested CA returned',()=>{
  const p=fixture();p.logs.push(structuredClone(p.logs[0]));assert.equal(normalizeInnerTradeWindow(p,NOW).trades.length,2);
  p.logs[2].transactionIndex=6;assert.equal(normalizeInnerTradeWindow(p,NOW).ready,false);
  p.logs.pop();p.logs.push(log(p,'buy',p.blocks[1],2,CA,300,{transactionIndex:0}),log(p,'buy',p.blocks[1],3,OTHER,300,{transactionIndex:0}));
  const out=normalizeInnerTradeWindow(p,NOW);assert.equal(out.ready,true);assert.equal(out.trades.length,3);
  assert.equal(out.trades.filter(t=>t.group===h(300)).length,2);
});

test('one block log index cannot identify two transactions or CAs; one transaction cannot change block/index',()=>{
  for(const mutation of [p=>p.logs.push(log(p,'buy',p.blocks[1],0,OTHER,399)),
    p=>p.logs.push(log(p,'buy',p.blocks[1],0,OTHER,300,{transactionIndex:0})),
    p=>p.logs.push(log(p,'buy',p.blocks[1],2,CA,399,{transactionIndex:0})),
    p=>p.logs.push(log(p,'buy',p.blocks[1],2,CA,300,{transactionIndex:5})),
    p=>p.logs.push(log(p,'buy',p.toBlock,2,CA,300,{transactionIndex:0}))]) {
    const p=fixture();mutation(p);assert.equal(normalizeInnerTradeWindow(p,NOW).ready,false);
  }
});

test('Four manager identity/phase and Flap fixed version/phase/extensions fail closed',()=>{
  const four=fixture(),spec=INNER_TRADE_EMITTERS.four_v2,raw=spec.metadataAbi.decodeFunctionResult(spec.metadataMethod,four.metadata.raw.info);
  for(const [i,value] of [[0,1],[1,OTHER],[11,true]]){const p=structuredClone(four),r=[...raw];r[i]=value;p.metadata.raw.info=spec.metadataAbi.encodeFunctionResult(spec.metadataMethod,r);assert.equal(normalizeInnerTradeWindow(p,NOW).ready,false);}
  const f=fixture('flap'),s=INNER_TRADE_EMITTERS.flap,state=s.metadataAbi.decodeFunctionResult(s.metadataMethod,f.metadata.raw.info)[0];
  for(const [i,value] of [[0,4],[4,8],[11,h(1)],[14,OTHER]]){const p=structuredClone(f),r=[...state];r[i]=value;p.metadata.raw.info=s.metadataAbi.encodeFunctionResult(s.metadataMethod,[r]);assert.equal(normalizeInnerTradeWindow(p,NOW).ready,false);}
  f.metadata.raw.portalVersion=s.metadataAbi.encodeFunctionResult('version',['v5.25.0']);assert.equal(normalizeInnerTradeWindow(f,NOW).ready,false);
});

test('Flap timestamp must equal real block header; zero volume and stale/future oracle fail',()=>{
  const p=fixture('flap'),s=INNER_TRADE_EMITTERS.flap,a=s.abi.parseLog(p.logs[0]);
  const vals=[...a.args];vals[0]--;Object.assign(p.logs[0],s.abi.encodeEventLog(s.abi.getEvent(a.name),vals));
  assert.equal(normalizeInnerTradeWindow(p,NOW).ready,false);
  for(const round of [[1,0,1,1,1],[1,100000000000n,NOW/1000,NOW/1000,1],[1,100000000000n,NOW/1000-4000,NOW/1000-4000,1],[2,100000000000n,NOW/1000-30,NOW/1000-30,1]]){
    const x=fixture();x.oracle.raw.latestRoundData=INNER_TRADE_ORACLE_ABI.encodeFunctionResult('latestRoundData',round);assert.equal(normalizeInnerTradeWindow(x,NOW).ready,false);
  }
});

test('empty successfully queried range means no observed trades, not provider failure or no opportunity',()=>{
  const p=fixture();p.logs=[];const out=normalizeInnerTradeWindow(p,NOW);assert.equal(out.ready,true);assert.deepEqual(out.trades,[]);
});

test('content memo reuses cloned evidence, freezes results and detects in-place raw mutation',()=>{
  const p=fixture(),out=normalizeInnerTradeWindow(p,NOW);
  assert.equal(out.ready,true);
  assert.strictEqual(normalizeInnerTradeWindow(structuredClone(p),NOW+1000),out);
  for(const value of [out,out.coverage,out.trades,out.trades[0],out.trades[0].tags])assert.equal(Object.isFrozen(value),true);
  assert.throws(()=>out.trades[0].amountUsd=999,TypeError);
  assert.throws(()=>out.trades[0].tags.push('smart_money'),TypeError);
  assert.throws(()=>out.coverage.endAt=NOW,TypeError);
  assert.throws(()=>out.trades.push({}),TypeError);
  p.logs[0].data=log(p,'buy',p.blocks[1],0,CA,300,{quoteAmount:2}).data;
  const changed=normalizeInnerTradeWindow(p,NOW);
  assert.equal(changed.ready,true);assert.notStrictEqual(changed,out);assert.equal(changed.trades[0].amountUsd,2000);
  assert.equal(out.trades[0].amountUsd,1000);
  p.metadata.tokenAddress=OTHER;assert.equal(normalizeInnerTradeWindow(p,NOW).ready,false);
  assert.strictEqual(normalizeInnerTradeWindow(fixture(),NOW),out);
});

test('cached observations expire and future clock/evidence is rejected on every call',()=>{
  const p=fixture();assert.equal(normalizeInnerTradeWindow(p,NOW).ready,true);
  assert.equal(normalizeInnerTradeWindow(p,NOW+28000).ready,true);
  assert.equal(normalizeInnerTradeWindow(p,NOW+28001).ready,false); // end block precedes observedAt by 2s
  assert.equal(normalizeInnerTradeWindow(p,NOW+30001).ready,false);
  assert.equal(normalizeInnerTradeWindow(p,NOW-1).ready,false);
  p.observedAt=new Date(NOW+1).toISOString();assert.equal(normalizeInnerTradeWindow(p,NOW).ready,false);
  p.observedAt=new Date(NOW).toISOString();p.toBlock.timestamp=NOW/1000+1;assert.equal(normalizeInnerTradeWindow(p,NOW).ready,false);
});

test('memo never mixes CAs or platforms and evicts beyond eight entries',()=>{
  const initial=fixture(),first=normalizeInnerTradeWindow(initial,NOW);
  const other=fixture();other.tokenAddress=OTHER;other.metadata.tokenAddress=OTHER;
  other.logs=other.logs.map((_,i)=>log(other,i?'sell':'buy',other.blocks[1],i,OTHER,300+i));
  const second=normalizeInnerTradeWindow(other,NOW);
  assert.equal(second.ready,true);assert.notStrictEqual(second,first);assert.ok(second.trades.every(t=>t.tokenAddress===OTHER));
  assert.equal(first.trades[0].tokenAddress,CA);
  assert.notStrictEqual(normalizeInnerTradeWindow(fixture('flap'),NOW),first);
  for(let i=1;i<=8;i++){const p=fixture();p.cacheTestRevision=i;assert.equal(normalizeInnerTradeWindow(p,NOW).ready,true);}
  assert.notStrictEqual(normalizeInnerTradeWindow(initial,NOW),first);
});

for(const platform of ['four_v2','flap']) {
  test(`${platform}: strict static word decoding agrees with ethers for both sides, rejects address padding`,()=>{
    const s=INNER_TRADE_EMITTERS[platform];
    for(const side of ['buy','sell'])for(const amount of [1n,123456789012345678901n,(1n<<256n)-1n]) {
      const p=fixture(platform),entry=log(p,side,p.blocks[1],0),decoded=s.abi.parseLog(entry),args=[...decoded.args];
      args[3]=amount;args[4]=amount;args[5]=amount;
      Object.assign(entry,s.abi.encodeEventLog(s.abi.getEvent(decoded.name),args));p.logs=[entry];
      const parsed=s.abi.parseLog(entry),out=normalizeInnerTradeWindow(p,NOW);
      assert.equal(out.ready,true);assert.equal(out.trades[0].side,side);
      assert.equal(out.trades[0].baseAmountRaw,parsed.args.amount.toString());
      assert.equal(out.trades[0].quoteAmountRaw,(platform==='flap'?parsed.args.eth:parsed.args.cost).toString());
      assert.equal(out.trades[0].feeRaw,parsed.args.fee.toString());
      assert.equal(innerTradeLogToken(platform,entry),CA);
    }
    for(const index of platform==='flap'?[1,2]:[0,1]) {
      const p=fixture(platform),entry=p.logs[0],at=2+index*64;
      entry.data=entry.data.slice(0,at)+'1'+entry.data.slice(at+1);
      assert.equal(innerTradeLogToken(platform,entry),null);
      assert.equal(normalizeInnerTradeWindow(p,NOW).ready,false);
    }
  });
}
