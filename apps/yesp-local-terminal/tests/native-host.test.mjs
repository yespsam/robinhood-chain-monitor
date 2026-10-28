import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createNativeConnection, encodeFrame, FrameDecoder, extensionIdFromKey, loadExtensionIdentity,
  verifyCallerOrigin, validateRequest, sanitizeBridgeData, MAX_FRAME_BYTES } from '../scripts/flap-native-host.mjs';
import { installExtension, launcherSource } from '../scripts/install-flap-extension.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const pageBinding={expectedMarket:'0x1111111111111111111111111111111111111111',expectedToken:'0x2222222222222222222222222222222222222222'};
const request = (id, method, params = { profile: 'heyi' }) => ({ id, method, params:{...(['prepare','trade'].includes(method)?pageBinding:{}),...params} });
function harness(handle) {
  const input = new PassThrough(), messages = [], logs = [];
  const decoder = new FrameDecoder({ onMessage: message => messages.push(message) });
  const output = new Writable({ write(chunk, _encoding, done) { try { decoder.push(chunk); done(); } catch (e) { done(e); } } });
  const connection = createNativeConnection({ input, output, handle, onLog: line => logs.push(line) });
  return { input, output, messages, logs, connection, send: value => input.write(encodeFrame(value)) };
}
function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }

test('native protocol handles every byte boundary, UTF-8 and coalesced messages', () => {
  const messages = [{ id: 'a', text: '领取 🟢' }, { id: 'b', value: '10000000000000000000000000' }];
  const bytes = Buffer.concat(messages.map(m => encodeFrame(m)));
  for (let cut = 1; cut < bytes.length; cut++) {
    const received = [], decoder = new FrameDecoder({ onMessage: m => received.push(m) });
    decoder.push(bytes.subarray(0, cut)); decoder.push(bytes.subarray(cut)); decoder.finish();
    assert.deepEqual(received, messages);
  }
  const received = [], decoder = new FrameDecoder({ onMessage: m => received.push(m) });
  for (const byte of bytes) decoder.push(Buffer.from([byte]));
  assert.deepEqual(received, messages);
});

test('zero/oversized frames, malformed JSON, invalid UTF-8 and truncated input fail closed', () => {
  for (const size of [0, MAX_FRAME_BYTES + 1, 0xffffffff]) {
    const bytes = Buffer.alloc(4); bytes.writeUInt32LE(size);
    assert.throws(() => new FrameDecoder({ onMessage: () => assert.fail('not dispatched') }).push(bytes), { code: 'INVALID_FRAME_LENGTH' });
  }
  for (const body of [Buffer.from('{broken'), Buffer.from([0xff])]) {
    const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length);
    assert.throws(() => new FrameDecoder({ onMessage: () => assert.fail('not dispatched') }).push(Buffer.concat([prefix, body])), { code: 'INVALID_JSON' });
  }
  const decoder = new FrameDecoder({ onMessage: () => {} }); decoder.push(Buffer.from([10, 0, 0]));
  assert.throws(() => decoder.finish(), { code: 'TRUNCATED_FRAME' });
  assert.throws(() => encodeFrame({ text: 'x'.repeat(MAX_FRAME_BYTES) }), { code: 'FRAME_TOO_LARGE' });
});

test('caller must be exactly this Chrome extension and requests cannot introduce command arguments', () => {
  const id = 'a'.repeat(32);
  for (const origin of [undefined, '', 'https://flap.sh/', `chrome-extension://${'b'.repeat(32)}/`, `chrome-extension://${id}/evil`, `chrome-extension://${id}/?x=1`])
    assert.throws(() => verifyCallerOrigin(origin, id), { code: 'CALLER_NOT_ALLOWED' });
  assert.equal(verifyCallerOrigin(`chrome-extension://${id}/`, id), true);
  assert.equal(verifyCallerOrigin(`chrome-extension://${id}`, id), true);
  for (const value of [null, [], request('x', 'exec'), { ...request('x', 'status'), command: 'bad' },
    request('x', 'trade', { profile: 'heyi', action: 'buy', args: ['bad'] }), request('x', 'trade', { path: '/bin/sh' }),
    request('x', 'trade', { profile: 'elsewhere' }), request('x', 'trade', { action: 'transfer' }),
    request('x', 'trade', { deadlineMs: 16000 }), request('x', 'status', { profile: { command: 'bad' } })])
    assert.throws(() => validateRequest(value), { code: 'INVALID_REQUEST' });
  assert.deepEqual(validateRequest(request('x', 'trade', { profile: 'heyi', action: 'buy', intentId: 'intent-1', deadlineMs: 15000 })).params,
    { ...pageBinding,profile: 'heyi', action: 'buy', intentId: 'intent-1', deadlineMs: 15000 });
});

test('status stays responsive during a mutation while writes remain serialized', async () => {
  const gate = deferred(), calls = [];
  const h = harness(async (method, params) => { calls.push(params.intentId ?? method); if (params.intentId === 'one') await gate.promise; return { method }; });
  h.send(request('a', 'trade', { action: 'buy', intentId: 'one' }));
  h.send(request('b', 'trade', { action: 'sell', intentId: 'two' }));
  h.send(request('c', 'status')); await tick();
  assert.deepEqual(calls, ['one', 'status']);
  assert.deepEqual(h.messages.map(m => m.id), ['c']);
  gate.resolve(); await tick();
  assert.deepEqual(calls, ['one', 'status', 'two']);
  assert.deepEqual(h.messages.map(m => m.id), ['c', 'a', 'b']);
  h.input.end(); await h.connection.drained;
});

test('duplicate request IDs never execute twice or alias a changed request', async () => {
  let calls = 0; const gate = deferred();
  const h = harness(async () => { calls++; await gate.promise; return { status: 'CONFIRMED' }; });
  h.send(request('same', 'trade', { action: 'buy', intentId: 'one' }));
  h.send(request('same', 'trade', { action: 'sell', intentId: 'two' })); await tick();
  assert.equal(calls, 1); assert.equal(h.messages[0].error.code, 'REQUEST_ID_REUSED');
  gate.resolve(); await tick();
  h.send(request('same', 'trade', { action: 'buy', intentId: 'one' })); await tick();
  assert.equal(calls, 1); assert.equal(h.messages.at(-1).error.code, 'REQUEST_ID_REUSED');
  h.input.end(); await h.connection.drained;
});

test('long-running read polling does not exhaust the lifetime mutation request guard', async () => {
  let calls=0;const h=harness(async()=>{calls++;return {state:{connected:false}};});
  for(let i=0;i<10010;i++){h.send(request(`status-${i}`,'status'));await tick();}
  assert.equal(calls,10010);assert.equal(h.messages.some(x=>x.error?.code==='TOO_MANY_REQUESTS'),false);
  h.input.end();await h.connection.drained;
});

test('only a proved pre-submission trade error forwards the no-submission marker', async () => {
  const h=harness(async()=>{throw Object.assign(new Error('private details'),{code:'PROFILE_REVIEW_REQUIRED',submissionNotStarted:true});});
  h.send(request('trade-safe','trade',{action:'buy',intentId:'intent123'}));await tick();
  h.send(request('read-safe','status'));await tick();
  assert.equal(h.messages[0].submissionNotStarted,true);assert.equal(h.messages[1].submissionNotStarted,undefined);
  h.send({id:'old-ui-unbound',method:'trade',params:{profile:'heyi',action:'buy',intentId:'intent-old'}});await tick();
  assert.equal(h.messages[2].error.code,'INVALID_REQUEST');assert.equal(h.messages[2].submissionNotStarted,true);
  h.input.end();await h.connection.drained;
});

test('disconnect does not cancel or resend started work; queued mutation is not started', async () => {
  const gate = deferred(), calls = []; let finished = false;
  const h = harness(async (_method, params) => { calls.push(params.intentId); await gate.promise; finished = true; return { status: 'CONFIRMED' }; });
  h.send(request('a', 'trade', { action: 'buy', intentId: 'one' }));
  h.send(request('b', 'trade', { action: 'buy', intentId: 'two' })); await tick();
  h.input.end(); await tick(); assert.equal(finished, false); assert.equal(h.connection.connected, false);
  gate.resolve(); await h.connection.drained;
  assert.equal(finished, true); assert.deepEqual(calls, ['one']); assert.deepEqual(h.messages, []);
});

test('broken output leaves accepted operation running without resending', async () => {
  const gate = deferred(); let calls = 0;
  const h = harness(async () => { calls++; await gate.promise; return { status: 'COMPLETE' }; });
  h.send(request('a', 'trade', { action: 'buy', intentId: 'one' })); await tick();
  h.output.destroy(Object.assign(new Error('secret must not leak'), { code: 'EPIPE' })); await tick();
  gate.resolve(); await h.connection.drained;
  assert.equal(calls, 1); assert.deepEqual(h.logs, ['flap-native-host: OUTPUT_CLOSED']);
});

test('invalid JSON produces a framed error and terminates input without wallet calls', async () => {
  const h = harness(() => assert.fail('not called'));
  const body = Buffer.from('{bad'); const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length);
  h.input.write(Buffer.concat([prefix, body])); await h.connection.drained;
  assert.equal(h.messages[0].error.code, 'INVALID_JSON');
  assert.equal(h.connection.connected, false);
});

test('progress and final messages remain framed; credential fields and exception text never escape', async () => {
  const secret = 'SYNTHETIC_PRIVATE_CREDENTIAL'; let h;
  h = harness(async method => {
    if (method === 'signin') return { urlForWeb: 'https://web3.binance.com/agent-login', pairingCode: '123abc', qrCodeId: secret };
    if (method === 'verify') throw Object.assign(new Error(secret), { code: 'AUTH_REQUIRED' });
    h.connection.progress({ stage: 'SUBMITTED', intentId: 'one', privateKey: secret, sessionId: secret });
    return { balance: 99n, accessToken: secret, nested: { password: secret }, note: 'Bearer ABC123' };
  });
  h.send(request('a', 'status')); h.send(request('b', 'signin')); h.send(request('c', 'verify')); await tick();
  assert.equal(h.messages[0].event, 'progress'); assert.equal(h.messages[0].id, 'a');
  assert.equal(h.messages.find(m => m.id === 'a' && m.ok)?.data.balance, '99');
  assert.equal(h.messages.find(m => m.id === 'b').data.pairingCode, '123abc');
  assert.equal(h.messages.find(m => m.id === 'c').error.code, 'AUTH_REQUIRED');
  assert.ok(!JSON.stringify([h.messages, h.logs]).includes(secret));
  assert.deepEqual(sanitizeBridgeData({ pairingCode: secret, cookie: secret }), {});
  h.input.end(); await h.connection.drained;
});

test('auth failures expose only verified official error names, without raw CLI diagnostics',async()=>{
  const h=harness(async method=>{throw Object.assign(new Error('SYNTHETIC_PRIVATE_AUTH_DETAIL'),
    {code:'READ_FAILED',officialName:'NETWORK_ERROR',officialCode:50001001});});
  h.send(request('auth-error','signin'));h.send(request('read-error','status'));await tick();
  assert.equal(h.messages.find(m=>m.id==='auth-error').error.code,'NETWORK_ERROR');
  assert.equal(h.messages.find(m=>m.id==='read-error').error.code,'READ_FAILED');
  assert.ok(!JSON.stringify(h.messages).includes('SYNTHETIC_PRIVATE_AUTH_DETAIL'));
  h.input.end();await h.connection.drained;
});

test('public key fixes identity, installer dry run does not write, and installed launcher is safely quoted', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'yesp-native-test-'));
  try {
    const root = join(temp, "project with ' spaces"), home = join(temp, 'home');
    await mkdir(join(root, 'extension'), { recursive: true }); await mkdir(join(root, 'scripts'));
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const key = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    await writeFile(join(root, 'extension/extension-public-key.txt'), `${key}\n`);
    await writeFile(join(root, 'extension/manifest.json'), JSON.stringify({ key, manifest_version: 3, permissions: ['nativeMessaging'] }));
    await writeFile(join(root, 'scripts/flap-native-host.mjs'), '// fixture only\n');
    const identity = await loadExtensionIdentity(root);
    assert.match(identity.extensionId, /^[a-p]{32}$/); assert.equal(extensionIdFromKey(key), identity.extensionId);
    const dry = await installExtension({ root, home, platform: 'darwin', dryRun: true });
    assert.equal(dry.installed, false); await assert.rejects(readFile(dry.nativeManifest), { code: 'ENOENT' });
    const installed = await installExtension({ root, home, platform: 'darwin' });
    assert.equal(installed.installed, true);
    const manifest = JSON.parse(await readFile(installed.nativeManifest, 'utf8'));
    assert.deepEqual(manifest.allowed_origins, [`chrome-extension://${identity.extensionId}/`]);
    const launcher = await readFile(manifest.path, 'utf8');
    assert.ok(launcher.includes("'\\''")); assert.ok(launcher.endsWith(' "$@"\n')); assert.doesNotMatch(launcher, /^\s*eval\s/m);
    if (process.platform !== 'win32') {
      assert.equal((await stat(manifest.path)).mode & 0o777, 0o700);
      assert.equal((await stat(installed.nativeManifest)).mode & 0o777, 0o600);
    }
    assert.throws(() => launcherSource('node', '/tmp/test'), /absolute/);
    assert.throws(() => launcherSource('/bin/node\necho bad', '/tmp/test'), /absolute/);
    await writeFile(join(root, 'extension/manifest.json'), JSON.stringify({ key: 'wrong', manifest_version: 3, permissions: ['nativeMessaging'] }));
    await assert.rejects(loadExtensionIdentity(root), { code: 'EXTENSION_IDENTITY_MISMATCH' });
  } finally { await rm(temp, { recursive: true, force: true }); }
});
