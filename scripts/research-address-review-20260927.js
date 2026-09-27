// One-shot, read-only public-address research. Never imports an execution client,
// changes a paper ledger, schedules a job, or promotes an address into a strategy.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGmgnFlowClient } from '../src/gmgn-flow-client.js';
import { buildLearningReport } from '../src/wallet-learning.js';
import { completedPaperRounds } from '../src/paper-confirmed-policy.js';
import { traderReview } from '../src/paper-trader-reasoning.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.join(root, 'data');
const read = async name => JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8'));
const ledger = await read('yesp-atm-confirmed-pvp-v2-20260923.json');
if (ledger.session?.mode !== 'paper') throw Error('Expected paper-only session');
const startedAt = new Date().toISOString();
const cutoff = Date.now();
const rounds = completedPaperRounds(ledger.account.trades).filter(r => r.entry.atMs >= Date.parse('2026-09-27T00:00:00+08:00') && r.at <= cutoff);
const learning = buildLearningReport(await read('wallet-learning-state.json'), cutoff);
const report = {
  version: 'address_research_snapshot_v1', startedAt, mode: 'research_only', execution: false,
  automaticTradingChanges: false, localReview: traderReview(rounds, cutoff),
  rounds: rounds.map(r => ({ symbol:r.entry.symbol, chain:r.entry.chain, address:r.entry.address,
    entryAt:new Date(r.entry.atMs).toISOString(), exitAt:new Date(r.at).toISOString(),
    pnl:r.pnl, modelCosts:[r.entry,...r.exits].reduce((n,t)=>n+t.costsUsd,0),
    entryFlow:r.entry.entryEvidence?.flow, setup:r.entry.entryEvidence?.opportunity?.id,
    narrative:r.entry.entryEvidence?.narrativeThesis })),
  learning: { updatedAt:learning.updatedAt, candidateCount:learning.candidateCount, walletCount:learning.walletCount,
    activityRecords:learning.activityRecords, roles:learning.roles, policies:learning.policies,
    teachers:learning.wallets.filter(w=>w.role==='teacher') },
  queries: [],
  limitations: ['Public trader list is bounded, not all holders or full-chain activity.',
    'Shared funding and synchronized activity do not establish common control; exchanges can fund unrelated users.',
    'Trader-list profit sorting is a discovery hint; realized and unrealized P&L are separate.',
    'Current snapshots cannot be used as evidence that was known at a past entry.']
};
const client = createGmgnFlowClient({dataDir});
try {
  await client.checkConfig();
  const targets = [
    ['sol', 'C47MWp6h3pmMVMkzLcyKQ92z1wyjr7kmF1BwuWYupump'],
    ['bsc', '0xcb975f49924a2c8f8d7884b3b5adcef7e1fc7777']
  ];
  for (const [chain,address] of targets) {
    try {
      const payload = await client.topTraders(chain,address,50);
      const data = payload.data ?? payload;
      if (!Array.isArray(data.list)) throw Object.assign(Error('Missing trader list'),{code:'INVALID_LIST'});
      report.queries.push({type:'token_traders',chain,address,receivedAt:new Date().toISOString(),data});
    } catch(e) {
      report.queries.push({type:'token_traders',chain,address,error:e.code||'UNAVAILABLE',retryAt:e.retryAt});
      if(e.status===429) break;
    }
  }
  if(!report.queries.some(q=>q.error==='GMGN_RATE_LIMITED')) {
    const teachers = report.learning.teachers.filter(w=>w.chain==='bsc').map(w=>w.wallet).slice(0,2);
    if(teachers.length) {
      try {
        const payload=await client.stats('bsc',teachers,'7d');
        const data=payload.data??payload;
        // Some CLI versions return only one bound wallet for a batch. Retain the
        // requested/returned distinction; never duplicate one profile per input.
        const returned=(Array.isArray(data)?data:[data]).map(x=>x?.wallet_address).filter(x=>typeof x==='string');
        report.queries.push({type:'wallet_stats',chain:'bsc',wallets:teachers,returnedWallets:returned,
          missingWallets:teachers.filter(w=>!returned.includes(w)),period:'7d',receivedAt:new Date().toISOString(),data});
      } catch(e) { report.queries.push({type:'wallet_stats',error:e.code||'UNAVAILABLE',retryAt:e.retryAt}); }
    }
  }
} finally { await client.stop(); }
report.finishedAt = new Date().toISOString();
const output = path.join(dataDir,`address-research-${startedAt.replace(/[:.]/g,'-')}.json`);
await fs.writeFile(output,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,closedRounds:rounds.length,netPnl:report.localReview.overall.netPnlUsd,
  queries:report.queries.map(q=>({type:q.type,chain:q.chain,address:q.address,receivedAt:q.receivedAt,error:q.error,retryAt:q.retryAt,
    rows:q.data?.list?.length,keys:q.data&&Object.keys(q.data)}))},null,2));
