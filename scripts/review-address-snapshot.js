// Replay saved public evidence without network calls or changing the live ledger.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { completedPaperRounds } from '../src/paper-confirmed-policy.js';
import { reviewEntryEvidence } from '../src/paper-evidence-review.js';
import { analyzeTraderSnapshot, analyzeWalletStatsSnapshot } from '../src/paper-address-review.js';
import { gmgnFlowAddress } from '../src/gmgn-flow-signal.js';

const args = process.argv.slice(2);
if (args.length !== 3) throw Error('Usage: node scripts/review-address-snapshot.js <saved-snapshot.json> <paper-ledger.json> <entry-from-ISO-with-timezone>');
const fromMs = Date.parse(args[2]);
if (!Number.isFinite(fromMs) || !/(?:Z|[+-]\d{2}:\d{2})$/.test(args[2])) throw Error('Explicit entry start time and timezone required');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [snapshotText, ledgerText] = await Promise.all(args.slice(0,2).map(f => fs.readFile(path.resolve(f), 'utf8')));
const snapshot = JSON.parse(snapshotText), ledger = JSON.parse(ledgerText), nowMs = Date.now();
if (snapshot.version !== 'address_research_snapshot_v1' || snapshot.mode !== 'research_only'
  || !Array.isArray(snapshot.queries) || ledger.session?.mode !== 'paper' || ledger.account?.mode !== 'paper'
  || ledger.account.execution !== false || ledger.account.signing !== false || ledger.account.broadcast !== false) throw Error('Read-only research and paper-main input required');
const rounds = completedPaperRounds(ledger.account.trades).filter(r => r.entry.atMs >= fromMs && r.at <= nowMs);
const addressReviews = [], walletStats = [], errors = [];
for (const [index,q] of snapshot.queries.entries()) {
  try {
    if (q.type === 'token_traders') {
      const ca = gmgnFlowAddress(q.chain,q.address);
      const entries = rounds.filter(r => ca && r.entry.chain === q.chain && gmgnFlowAddress(r.entry.chain,r.entry.address) === ca).map(r => r.entry);
      for (const entry of entries.length ? entries : [null]) addressReviews.push(analyzeTraderSnapshot(q, entry, nowMs));
    } else if (q.type === 'wallet_stats') walletStats.push(analyzeWalletStatsSnapshot(q, nowMs));
  } catch (error) { errors.push({index, type:q.type, message:error.message}); }
}
const sha = value => createHash('sha256').update(value).digest('hex');
const report = { version:'research_evidence_replay_v1', mode:'research_only', execution:false,
  automaticTradingChanges:false, generatedAt:new Date(nowMs).toISOString(), entryFrom:args[2],
  inputHashes:{snapshot:sha(snapshotText), ledger:sha(ledgerText)},
  rounds:rounds.map(r=>({entryId:r.entry.id,symbol:r.entry.symbol,chain:r.entry.chain,address:r.entry.address,netPnlUsd:r.pnl})),
  evidenceReview:reviewEntryEvidence(rounds,nowMs), addressReviews, walletStats, errors };
const output = path.join(root,'data',`research-evidence-review-${report.generatedAt.replace(/[:.]/g,'-')}.json`);
await fs.writeFile(output,JSON.stringify(report,null,2),{flag:'wx',mode:0o600});
console.log(JSON.stringify({output,closedRounds:rounds.length,groups:report.evidenceReview.groups,
  addressReviews:addressReviews.map(r=>({chain:r.chain,address:r.address,entryId:r.entryId,knowledge:r.knowledge,
    earlyClosed:r.earlyClosed.length,cohortKnown:r.cohortKnown,cohortMatched:r.cohort.filter(w=>w.snapshotStatus!=='not_in_bounded_sample').length,
    cohortCount:r.cohort.length,unknownFundingGroups:r.fundingGroups.filter(g=>g.classification==='unverified_shared_funder').length,
    serviceFundingGroups:r.fundingGroups.filter(g=>g.classification==='public_service_source').length})),
  walletStats:walletStats.map(r=>({requested:r.requestedWallets.length,returned:r.returnedWallets.length,missing:r.missingWallets})), errors},null,2));
