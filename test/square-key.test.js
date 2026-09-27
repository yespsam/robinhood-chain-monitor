import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createSquareKeyStore, validateSquareKey } from '../src/square-key-store.js';
import { createDashboardServer } from '../scripts/dashboard-server.js';

const DUMMY = 'fixture-only-not-a-real-binance-key';
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'yesp-square-key-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, 'config', 'binance-square');
  return { root, configDir, file: path.join(configDir, 'openapi-key'), store: createSquareKeyStore({ configDir, environmentKeyPresent: () => false }) };
}

test('Square key is private, atomic, never readable through status, and requires explicit replacement', async t => {
  const { store, configDir, file } = await fixture(t);
  assert.deepEqual(await store.status(), { stored: false, hasSavedFile: false, environmentKeyPresent: false, verified: false, publishingEnabled: false });
  const result = await store.save(` ${DUMMY}\n`);
  assert.deepEqual(result, { stored: true, hasSavedFile: true, environmentKeyPresent: false, verified: false, publishingEnabled: false });
  assert.equal(await fs.readFile(file, 'utf8'), `${DUMMY}\n`);
  assert.equal((await fs.stat(configDir)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  await assert.rejects(store.save('fixture-replacement'), { code: 'already_saved' });
  assert.equal(await fs.readFile(file, 'utf8'), `${DUMMY}\n`);
  await store.save('fixture-replacement', { replace: true });
  assert.equal(await fs.readFile(file, 'utf8'), 'fixture-replacement\n');
  assert.deepEqual(await fs.readdir(configDir), ['openapi-key']);
  assert.equal(JSON.stringify(await store.status()).includes('fixture'), false);
});

test('Square key validates bounded printable input without inventing a Binance prefix', () => {
  assert.equal(validateSquareKey('abc._=-123'), 'abc._=-123');
  for (const input of ['', '  ', null, {}, 1, 'key with spaces', 'key\nkey', '密钥：123', 'x'.repeat(4097), 'key\u0000key']) {
    assert.throws(() => validateSquareKey(input), { code: 'invalid_key' });
  }
});

test('a confirmed post verifies only the exact credential file version, not a rotated or environment key', async t => {
  const { store: baseStore, root, configDir, file } = await fixture(t);
  await baseStore.save(DUMMY);
  const stat = await fs.lstat(file);
  const publicationReceiptFile = path.join(root, 'receipt.json');
  const receipt = { status: 'confirmed_publication', id: '123456', link: 'https://www.binance.com/zh-CN/square/post/123456', requestedAccount: 'Example', verifiedAuthor: 'Example', verifiedAt: '2026-09-22T00:00:00Z', credentialFile: Object.fromEntries(['dev', 'ino', 'mtimeMs', 'size'].map(field => [field, stat[field]])) };
  await fs.writeFile(publicationReceiptFile, JSON.stringify(receipt), { mode: 0o600 });
  const store = createSquareKeyStore({ configDir, publicationReceiptFile, environmentKeyPresent: () => false });
  const status = await store.status();
  assert.equal(status.verified, true);
  assert.equal(status.publicationTest.link, receipt.link);
  assert.equal(status.publishingEnabled, false);
  assert.equal(JSON.stringify(status).includes('credentialFile'), false);
  assert.equal((await createSquareKeyStore({ configDir, publicationReceiptFile, environmentKeyPresent: () => true }).status()).verified, false);
  for (const invalid of [{ ...receipt, status: 'unconfirmed' }, { ...receipt, verifiedAuthor: 'SomeoneElse' }, { ...receipt, link: 'https://evil.example/' }]) {
    await fs.writeFile(publicationReceiptFile, JSON.stringify(invalid));
    assert.equal((await store.status()).verified, false);
  }
  await fs.writeFile(publicationReceiptFile, JSON.stringify(receipt));
  await store.save('fixture-rotated-key', { replace: true });
  assert.equal((await store.status()).verified, false);
});

test('Square key refuses symlink directories/files, hard links and permissive files', async t => {
  for (const scenario of ['parent-link', 'dir-link', 'file-link', 'hard-link', 'file-mode', 'dir-mode']) {
    await t.test(scenario, async t => {
      const { store, root, configDir, file } = await fixture(t);
      const external = path.join(root, 'outside');
      await fs.mkdir(external, { mode: 0o700 });
      if (scenario === 'parent-link') await fs.symlink(external, path.dirname(configDir));
      else if (scenario === 'dir-link') { await fs.mkdir(path.dirname(configDir)); await fs.symlink(external, configDir); }
      else {
        await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
        const sentinel = path.join(external, 'sentinel');
        await fs.writeFile(sentinel, 'unchanged', { mode: 0o600 });
        if (scenario === 'file-link') await fs.symlink(sentinel, file);
        if (scenario === 'hard-link') await fs.link(sentinel, file);
        if (scenario === 'file-mode') { await fs.writeFile(file, 'old', { mode: 0o644 }); await fs.chmod(file, 0o644); }
        if (scenario === 'dir-mode') await fs.chmod(configDir, 0o755);
      }
      await assert.rejects(store.save(DUMMY, { replace: true }), { code: 'unsafe_storage' });
      await assert.rejects(store.status(), { code: 'unsafe_storage' });
      if (['file-link', 'hard-link'].includes(scenario)) assert.equal(await fs.readFile(path.join(external, 'sentinel'), 'utf8'), 'unchanged');
    });
  }
});

test('concurrent first saves do not replace the winner', async t => {
  const { store, file } = await fixture(t);
  const results = await Promise.allSettled([store.save(DUMMY), store.save('fixture-second-key')]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].reason.code, 'already_saved');
  assert.equal(await fs.readFile(file, 'utf8'), `${DUMMY}\n`);
});

test('empty files are distinguishable from missing keys, and environment precedence is disclosed', async t => {
  const { configDir, file } = await fixture(t);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(file, '', { mode: 0o600 });
  const store = createSquareKeyStore({ configDir, environmentKeyPresent: () => true });
  const status = await store.status();
  assert.equal(status.stored, false);
  assert.equal(status.hasSavedFile, true);
  assert.equal(status.environmentKeyPresent, true);
  await store.save(DUMMY, { replace: true });
  assert.equal((await store.status()).stored, true);
});

test('local key route enforces origin/token/body limits and never echoes credentials', async t => {
  const { store, file } = await fixture(t);
  const app = createDashboardServer({ port: 0, squareKeyStore: store });
  const address = await app.listen(); t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const endpoint = `${base}/api/square-key`;
  const statusResponse = await fetch(endpoint);
  const status = await statusResponse.json();
  assert.equal(statusResponse.headers.get('cache-control'), 'no-store');
  assert.equal(status.stored, false);
  assert.match(status.csrfToken, /^[a-f0-9]{64}$/);
  const headers = { origin: base, 'content-type': 'application/json', 'x-yesp-csrf': status.csrfToken };
  const send = (body, extra = {}) => fetch(endpoint, { method: 'POST', headers: { ...headers, ...extra }, body });
  assert.equal((await send(JSON.stringify({ key: DUMMY }), { origin: 'https://evil.example' })).status, 403);
  assert.equal((await send(JSON.stringify({ key: DUMMY }), { origin: '' })).status, 403);
  assert.equal((await send(JSON.stringify({ key: DUMMY }), { 'x-yesp-csrf': 'wrong' })).status, 403);
  assert.equal((await send(JSON.stringify({ key: DUMMY }), { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await send('{}', { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await send('{}', { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await fetch(endpoint, { headers: { origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${endpoint}?key=fixture`)).status, 400);
  assert.equal((await fetch(endpoint, { method: 'DELETE' })).status, 405);
  assert.equal((await send(JSON.stringify({ key: 'x'.repeat(9000) }))).status, 413);
  for (const body of ['{', 'null', '[]', '{}', '{"key":1}', '{"key":"fixture","replace":"true"}', '{"key":"fixture","publish":true}']) assert.equal((await send(body)).status, 400);
  assert.equal((await store.status()).stored, false);
  const saved = await send(JSON.stringify({ key: DUMMY }));
  assert.equal(saved.status, 200);
  const text = await saved.text();
  assert.equal(text.includes(DUMMY), false);
  assert.equal(JSON.parse(text).stored, true);
  assert.equal(JSON.parse(text).publishingEnabled, false);
  assert.equal(await fs.readFile(file, 'utf8'), `${DUMMY}\n`);
  assert.equal((await send(JSON.stringify({ key: 'fixture-second' }))).status, 409);
  assert.equal((await send(JSON.stringify({ key: 'fixture-second', replace: true }))).status, 200);
  const rebound = await new Promise((resolve, reject) => {
    http.get(endpoint, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }).once('error', reject);
  });
  assert.equal(rebound, 403);
  const page = await fetch(`${base}/`);
  assert.match(page.headers.get('content-security-policy'), /connect-src 'self'/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const html = await page.text();
  assert.match(html, /id="squareApiKey" type="password"/);
  assert.match(html, /自动发布尚未接入/);
  const script = await (await fetch(`${base}/square-settings.js`)).text();
  assert.doesNotMatch(script, /localStorage|sessionStorage|console\./);
  assert.match(script, /input\.value = ''/);
});

test('unexpected storage errors are redacted and CSRF tokens rotate on server recreation', async t => {
  const tokens = [];
  for (let i = 0; i < 2; i++) {
    const app = createDashboardServer({ port: 0, squareKeyStore: {
      status: async () => ({ stored: false }),
      save: async () => { throw new Error(`filesystem secret: ${DUMMY}`); },
    } });
    const address = await app.listen(); t.after(() => app.close());
    const base = `http://127.0.0.1:${address.port}`;
    tokens.push((await (await fetch(`${base}/api/square-key`)).json()).csrfToken);
    const response = await fetch(`${base}/api/square-key`, { method: 'POST', headers: { origin: base, 'content-type': 'application/json', 'x-yesp-csrf': tokens[i] }, body: JSON.stringify({ key: DUMMY }) });
    assert.equal(response.status, 503);
    assert.equal((await response.text()).includes(DUMMY), false);
  }
  assert.notEqual(tokens[0], tokens[1]);
});
