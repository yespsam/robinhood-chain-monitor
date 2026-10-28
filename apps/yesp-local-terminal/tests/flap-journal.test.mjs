import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, chmod, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FlapJournal, TERMINAL } from '../server/flap-journal.mjs';
import { WINDOWS, windowsFiles } from '../server/platform-files.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runFile=promisify(execFile);

async function setup(t) {
  const root = await mkdtemp(join(tmpdir(), 'flap-journal-test-')); t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, 'journal'); return { root, dir, journal: new FlapJournal(dir) };
}
const createdAt=1792760000000;
const hash='0x'+'a'.repeat(64),otherHash='0x'+'b'.repeat(64);
const record = (extra = {}) => ({ intentId: 'intent-00000001', action:'buy', status: 'PREPARING', steps: [],
  market:'0x'+'1'.repeat(40),wallet:'0x'+'2'.repeat(40),createdAt,deadlineAt:createdAt+15000,...extra });
const step=(extra={})=>({action:'buy',status:'SUBMITTING',startedAt:createdAt+1,tx:{to:'0x'+'3'.repeat(40),inputData:'0x12345678',value:'0'},plan:{grossRaw:'100'},...extra});
const confirmed=(extra={})=>step({status:'CONFIRMED',txHash:hash,blockNumber:'0x100',gasRaw:'21000',...extra});
test('journal saves durable private records, preserves bigint amounts and prevents duplicate intent creation', async t => {
  const { journal, dir } = await setup(t);
  await journal.save(record({ quoteRaw: 123456789012345678901n }), { create: true });
  const saved = await journal.read('intent-00000001'); assert.equal(saved.quoteRaw, '123456789012345678901');
  if(WINDOWS) {await windowsFiles('check-directory',dir);await windowsFiles('check-file',journal.path(saved.intentId));}
  else {assert.equal((await stat(dir)).mode & 0o777, 0o700); assert.equal((await stat(journal.path(saved.intentId))).mode & 0o777, 0o600);}
  await assert.rejects(journal.save(record(), { create: true }), { code: 'EEXIST' });
  assert.equal((await journal.all()).length, 1);
});
test('UNKNOWN survives restart and is not a terminal state or permission to resubmit', async t => {
  const { journal, dir } = await setup(t);
  await journal.save(record({ status: 'UNKNOWN', steps: [step({ status: 'UNKNOWN', txHash: null })] }), { create: true });
  const restarted = new FlapJournal(dir), recovered = await restarted.read('intent-00000001');
  assert.equal(recovered.status, 'UNKNOWN'); assert.equal(recovered.steps[0].status, 'UNKNOWN'); assert.equal(TERMINAL.has('UNKNOWN'), false);
  await assert.rejects(restarted.save(record(), { create: true }), { code: 'EEXIST' });
  for (const state of ['SUBMITTING', 'SUBMITTED', 'PENDING', 'PENDING_CONFIRMATION']) assert.equal(TERMINAL.has(state), false);
});
test('submission lock excludes a concurrent writer and a leftover lock is never reclaimed automatically', async t => {
  const { journal, dir } = await setup(t);
  let release, started; const ready = new Promise(resolve => { started = resolve; });
  const active = journal.exclusive(async () => { started(); await new Promise(resolve => { release = resolve; }); });
  await ready; await assert.rejects(journal.exclusive(async () => assert.fail('second writer ran')), { code: 'UNRESOLVED_TRADE_LOCK' });
  release(); await active;
  await writeFile(join(dir, '.submission-lock'), '', { mode: 0o600 });
  await assert.rejects(new FlapJournal(dir).exclusive(async () => assert.fail('stale lock reclaimed')), { code: 'UNRESOLVED_TRADE_LOCK' });
});
test('journal rejects traversal, mismatched IDs, malformed steps and unsafe file permissions', async t => {
  const { journal } = await setup(t);
  assert.throws(() => journal.path('../intent'), { code: 'INVALID_INTENT' });
  await journal.ready();
  for (const corrupt of [{ ...record(), intentId: 'another-id' }, { ...record(), steps: null }]) {
    await writeFile(journal.path('intent-00000001'), JSON.stringify(corrupt), { mode: 0o600 });
    await assert.rejects(journal.read('intent-00000001'), { code: 'JOURNAL_INVALID' });
  }
  await writeFile(journal.path('intent-00000001'), JSON.stringify(record()), { mode: 0o600 });
  if(WINDOWS)await runFile(join(process.env.SystemRoot,'System32/icacls.exe'),[journal.path('intent-00000001'),'/grant','*S-1-1-0:(R)'],{shell:false,windowsHide:true});
  else await chmod(journal.path('intent-00000001'), 0o644);
  await assert.rejects(journal.read('intent-00000001'), { code: 'JOURNAL_UNSAFE' });
});
test('journal rejects symlink or junction directories', async t => {
  const { journal, root, dir } = await setup(t); await journal.ready();
  const link = join(root, 'link'); await symlink(dir, link,WINDOWS?'junction':'dir');
  await assert.rejects(new FlapJournal(link).ready(), { code: 'JOURNAL_UNSAFE' });
});
test('journal rejects symlink record files', async t => {
  const {journal,root}=await setup(t);await journal.ready();
  const target = join(root, 'outside.json'); await writeFile(target, JSON.stringify(record()), { mode: 0o600 });
  try {await symlink(target, journal.path('intent-00000001'),'file');}
  catch(e){if(WINDOWS&&e.code==='EPERM'){t.skip('Windows file symlinks require Developer Mode or the create-symlink privilege.');return;}throw e;}
  await assert.rejects(journal.read('intent-00000001'));
});

test('updates never create a missing intent and reject immutable operation changes', async t => {
  const { journal } = await setup(t);
  await assert.rejects(journal.save(record()),{code:'JOURNAL_MISSING'});
  await journal.save(record(),{create:true});
  for(const patch of [{action:'sell'},{market:'0x'+'4'.repeat(40)},{wallet:'0x'+'5'.repeat(40)},{createdAt:createdAt+1},{deadlineAt:createdAt+16000}])
    await assert.rejects(journal.save(record(patch)),{code:'JOURNAL_IMMUTABLE'});
  assert.equal((await journal.read('intent-00000001')).action,'buy');
});

test('a completed operation cannot be downgraded by stale UNKNOWN reconciliation', async t => {
  const { journal } = await setup(t);
  const saved=record({status:'COMPLETE',steps:[confirmed()]});await journal.save(saved,{create:true});
  await assert.rejects(journal.save({...saved,status:'UNKNOWN'}),{code:'JOURNAL_TERMINAL'});
  await assert.rejects(journal.save({...saved,status:'FAILED'}),{code:'JOURNAL_TERMINAL'});
  assert.equal((await journal.read(saved.intentId)).status,'COMPLETE');
});

test('normal submission and receipt-confirmed recovery preserve the durable state sequence', async t => {
  const { journal } = await setup(t);let saved=record();await journal.save(saved,{create:true});
  saved={...saved,steps:[step()]};await journal.save(saved);
  saved={...saved,status:'SUBMITTED',steps:[{...saved.steps[0],status:'SUBMITTED',txHash:hash,orderId:'order-1'}]};await journal.save(saved);
  saved={...saved,status:'UNKNOWN',steps:[{...saved.steps[0],status:'UNKNOWN'}]};await journal.save(saved);
  saved={...saved,status:'COMPLETE',steps:[{...saved.steps[0],status:'CONFIRMED',blockNumber:'0x100',gasRaw:'21000'}]};await journal.save(saved);
  assert.equal((await journal.read(saved.intentId)).status,'COMPLETE');
});

test('known hashes, exact submitted calldata and existing history cannot change or disappear', async t => {
  const { journal } = await setup(t);
  const saved=record({status:'SUBMITTED',steps:[step({status:'SUBMITTED',txHash:hash,orderId:'order-1'})]});await journal.save(saved,{create:true});
  for(const patch of [{txHash:null},{txHash:otherHash},{orderId:null},{orderId:'order-2'},{tx:{...saved.steps[0].tx,inputData:'0x87654321'}},{plan:{grossRaw:'999'}}])
    await assert.rejects(journal.save({...saved,steps:[{...saved.steps[0],...patch}]}),{code:'JOURNAL_HISTORY_CHANGED'});
  await assert.rejects(journal.save({...saved,steps:[]}),{code:'JOURNAL_HISTORY_CHANGED'});
});

test('confirmed steps are immutable while an operation may append its next required step', async t => {
  const { journal } = await setup(t);
  const saved=record({status:'SUBMITTED',steps:[confirmed({action:'approve'})]});await journal.save(saved,{create:true});
  for(const patch of [{status:'UNKNOWN'},{status:'SUBMITTED'},{gasRaw:'2'}])
    await assert.rejects(journal.save({...saved,steps:[{...saved.steps[0],...patch}]}),{code:'JOURNAL_CONFIRMED_CHANGED'});
  const next={...saved,steps:[...saved.steps,step({startedAt:createdAt+2})]};await journal.save(next);
  assert.equal((await journal.read(saved.intentId)).steps.length,2);
});

test('unresolved history cannot become terminal or return to submission preparation', async t => {
  for(const state of ['SUBMITTING','UNKNOWN','SUBMITTED','PENDING_CONFIRMATION']) {
    const { journal } = await setup(t);const saved=record({status:state,steps:[step({status:state,txHash:state==='SUBMITTED'?hash:null})]});
    await journal.save(saved,{create:true});
    for(const status of TERMINAL)await assert.rejects(journal.save({...saved,status}),{code:'JOURNAL_UNRESOLVED_TERMINAL'});
    if(state==='UNKNOWN') {
      await assert.rejects(journal.save({...saved,status:'PREPARING'}),{code:'JOURNAL_UNKNOWN_TRANSITION'});
      await assert.rejects(journal.save({...saved,steps:[{...saved.steps[0],status:'SUBMITTING'}]}),{code:'JOURNAL_UNKNOWN_TRANSITION'});
      await assert.rejects(journal.save({...saved,status:'FAILED',steps:[{...saved.steps[0],status:'FAILED'}]}),{code:'JOURNAL_UNKNOWN_TRANSITION'});
    }
  }
});

test('complete requires receipt evidence and sell completion includes confirmed conversion', async t => {
  const { journal } = await setup(t);
  for(const bad of [record({status:'COMPLETE'}),record({status:'COMPLETE',steps:[step({status:'CONFIRMED'})]}),
    record({action:'sell',status:'COMPLETE',steps:[confirmed({action:'sell'})]})])
    await assert.rejects(journal.save(bad,{create:true}),{code:'JOURNAL_INVALID'});
  await journal.save(record({action:'sell',status:'COMPLETE',steps:[confirmed({action:'sell'}),confirmed({action:'convert',txHash:otherHash})]}),{create:true});
  assert.equal((await journal.read('intent-00000001')).status,'COMPLETE');
});

test('a known reverted receipt resolves submitted or unknown work without weakening unknown protection', async t => {
  for(const status of ['SUBMITTED','UNKNOWN']) {
    const { journal }=await setup(t);const saved=record({status,steps:[step({status,txHash:hash})]});await journal.save(saved,{create:true});
    const failedReceipt={txHash:hash,blockHash:otherHash,blockNumber:'0x100',status:'0x0',gasRaw:'21000'};
    const next={...saved,status:'FAILED',steps:[{...saved.steps[0],status:'FAILED',failedReceipt}]};
    await assert.rejects(journal.save({...next,steps:[{...next.steps[0],failedReceipt:undefined}]}),{code:'JOURNAL_UNKNOWN_TRANSITION'});
    for(const patch of [{txHash:otherHash},{blockHash:'bad'},{status:'0x1'},{gasRaw:'-1'},{blockNumber:5}])
      await assert.rejects(journal.save({...next,steps:[{...next.steps[0],failedReceipt:{...failedReceipt,...patch}}]}),{code:'JOURNAL_INVALID'});
    await journal.save(next);assert.equal((await journal.read(saved.intentId)).status,'FAILED');
    await assert.rejects(journal.save({...next,steps:[{...next.steps[0],failedReceipt:undefined}]}),{code:'JOURNAL_HISTORY_CHANGED'});
  }
});

test('read and write both reject malformed schema, oversized records and hard links', async t => {
  const { journal,root } = await setup(t);await journal.ready();
  for(const patch of [{action:'transfer'},{status:'unrecognized'},{createdAt:NaN},{deadlineAt:0},{wallet:'bad'},{steps:[{}]}]) {
    const bad=record(patch);await assert.rejects(journal.save(bad,{create:true}),{code:'JOURNAL_INVALID'});
    await writeFile(journal.path(bad.intentId),JSON.stringify(bad),{mode:0o600});
    await assert.rejects(journal.read(bad.intentId),{code:'JOURNAL_INVALID'});await rm(journal.path(bad.intentId));
  }
  await assert.rejects(journal.save(record({note:'x'.repeat(250000)}),{create:true}),{code:'JOURNAL_TOO_LARGE'});
  await journal.save(record(),{create:true});await link(journal.path('intent-00000001'),join(root,'hardlink.json'));
  await assert.rejects(journal.read('intent-00000001'),{code:'JOURNAL_UNSAFE'});
  await assert.rejects(journal.save(record()),{code:'JOURNAL_UNSAFE'});
});
