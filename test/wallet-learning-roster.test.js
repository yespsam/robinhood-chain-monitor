import test from 'node:test';
import assert from 'node:assert/strict';
import { admitLearningWallets, LEARNING_ARCHIVE_LIMIT } from '../src/wallet-learning-roster.js';
import { validateLearningState } from '../src/wallet-learning-monitor.js';
import { LEARNING_SCHEMA } from '../src/wallet-learning.js';
import { NOW, teacher, row } from './fixtures/wallet-learning.js';
function wallet(n, verified=false) {
  const w=teacher(n);w.tags=['smart_money'];w.lastObservedAt=NOW-1000;
  if(!verified)w.profile={};
  w.rows=[row(n,'buy',{wallet:w.wallet})];w.pages=4;w.nextCursor='retained';w.cursors=['earlier'];return w;
}
function state(){return {schema:LEARNING_SCHEMA,execution:false,signing:false,broadcast:false,nextAttemptAt:0,
  wallets:Object.fromEntries(Array.from({length:80},(_,i)=>{const w=wallet(i+1);return [w.key,w];})),universe:{}};}
test('full roster admits at most two verified teachers and preserves every old sample/cursor',()=>{
  const s=state(),old=structuredClone(s.wallets);
  for(const n of [101,102,103]){const w=wallet(n,true);s.universe[w.key]=w;}
  admitLearningWallets(s,NOW);
  assert.equal(Object.keys(s.wallets).length,80);assert.equal(Object.keys(s.walletArchive).length,2);
  assert.equal(Object.values(s.wallets).filter(w=>w.key in s.universe).length,2);
  for(const [k,w]of Object.entries(old))assert.deepEqual(s.wallets[k]||s.walletArchive[k],w);
  assert.equal(validateLearningState(s),true);
  const a=Object.keys(s.walletArchive)[0];s.walletArchive[a].rows[0].wallet='bad';
  assert.throws(()=>validateLearningState(s),/learning_row_invalid/);
});
test('tags alone cannot get a full seat; in-flight profiles and refreshed teachers are protected',()=>{
  const s=state(),newcomer=wallet(101);s.universe[newcomer.key]=newcomer;
  admitLearningWallets(s,NOW);assert.equal(s.wallets[newcomer.key],undefined);
  s.statsJob={chain:'robinhood',wallets:[wallet(1).wallet]};
  const incumbent=wallet(2,true);s.universe[incumbent.key]=incumbent;s.universe[newcomer.key]=wallet(101,true);
  admitLearningWallets(s,NOW);
  assert.ok(s.wallets[wallet(1).key]);assert.ok(s.wallets[wallet(2).key]);assert.ok(s.wallets[newcomer.key]);
});
test('bounded archive does not erase old records; restoration swaps seats without duplicating rows',()=>{
  const s=state();s.walletArchive=Object.fromEntries(Array.from({length:LEARNING_ARCHIVE_LIMIT},(_,i)=>{
    const w=wallet(100+i);return [w.key,w];}));
  const fresh=wallet(999,true);s.universe[fresh.key]=fresh;
  admitLearningWallets(s,NOW);assert.equal(s.wallets[fresh.key],undefined);
  const restore=wallet(100,true),saved=structuredClone(s.walletArchive[restore.key]);
  s.universe[restore.key]=restore;admitLearningWallets(s,NOW);
  assert.deepEqual(s.wallets[restore.key].rows,saved.rows);assert.deepEqual(s.wallets[restore.key].cursors,saved.cursors);
  assert.equal(s.walletArchive[restore.key],undefined);assert.equal(Object.keys(s.walletArchive).length,40);
  assert.equal(validateLearningState(s),true);
});
