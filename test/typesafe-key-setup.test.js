import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';
import { readTypesafeKey, saveTypesafeKey } from '../src/typesafe-local-key.js';
import { startTypesafeKeySetup } from '../src/typesafe-key-setup.js';

const KEY = 'OFFLINE_FIXTURE_NOT_A_REAL_API_KEY';
test('local credential file is owner-only and separate from existing provider settings', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'typesafe-key-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const localFile = pathToFileURL(path.join(dir, '.env.typesafe.local')), envFile = pathToFileURL(path.join(dir, '.env'));
  await fs.writeFile(envFile, 'GMGN_KEY=OTHER_OFFLINE_FIXTURE\n');
  const before = await fs.readFile(envFile, 'utf8');
  await saveTypesafeKey(KEY, localFile);
  assert.equal((await fs.stat(localFile)).mode & 0o777, 0o600);
  assert.equal(await readTypesafeKey({ env: {}, localFile, envFile }), KEY);
  assert.equal(await fs.readFile(envFile, 'utf8'), before);
  await assert.rejects(saveTypesafeKey('invalid\ninjection', localFile), /invalid_key/);
  assert.equal(await readTypesafeKey({ env: {}, localFile, envFile }), KEY);
  assert.equal((await fs.readdir(dir)).length, 2);
});

test('local key file rejects symlink destinations', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'typesafe-symlink-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'original'), link = path.join(dir, 'link');
  await fs.writeFile(target, 'unchanged'); await fs.symlink(target, link);
  await assert.rejects(saveTypesafeKey(KEY, pathToFileURL(link)), /invalid_config_target/);
  assert.equal(await fs.readFile(target, 'utf8'), 'unchanged');
});

test('form is loopback, no-store, password masked and CSP-protected', async t => {
  const setup = await startTypesafeKeySetup({ saveKey: async () => {} }); t.after(setup.close);
  assert.ok(setup.url.startsWith('http://127.0.0.1:'));
  const r = await fetch(setup.url), html = await r.text();
  assert.equal(r.status, 200); assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.equal(r.headers.get('referrer-policy'), 'same-origin');
  assert.match(r.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.match(html, /type="password"/); assert.doesNotMatch(html, /<script|https?:\/\/[^1]/);
  assert.equal((await fetch(`${setup.origin}/`)).status, 404);
});

test('single-use save requires same origin and never returns submitted secret', async t => {
  const values = [], setup = await startTypesafeKeySetup({ saveKey: async key => { values.push(key); } });
  t.after(setup.close);
  const submit = headers => fetch(setup.url, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body: new URLSearchParams({ key: KEY }) });
  for (const headers of [{}, { origin: 'null' }, { origin: 'https://attacker.invalid' }, { origin: setup.origin, 'sec-fetch-site': 'cross-site' }])
    assert.equal((await submit(headers)).status, 403, JSON.stringify(headers));
  // Node fetch replaces Host; use raw HTTP to exercise DNS-rebinding protection.
  const wrongHost = await new Promise((resolve, reject) => {
    const req = http.request(setup.url, { method: 'POST', headers: { host: 'attacker.invalid', origin: setup.origin,
      'content-type': 'application/x-www-form-urlencoded' } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end(new URLSearchParams({ key: KEY }).toString());
  });
  assert.equal(wrongHost, 403);
  assert.equal(values.length, 0);
  const r = await submit({ origin: setup.origin });
  assert.equal(r.status, 303); assert.equal(setup.isSaved(), true); assert.deepEqual(values, [KEY]);
  assert.doesNotMatch(await r.text(), new RegExp(KEY));
  const done = await fetch(new URL(r.headers.get('location'), setup.origin));
  assert.match(await done.text(), /密钥已保存到本地/);
  assert.equal((await submit({ origin: setup.origin })).status, 409);
  assert.equal((await fetch(setup.url)).status, 404); assert.equal(values.length, 1);
});

test('bad input and save exceptions never reflect credentials', async t => {
  const setup = await startTypesafeKeySetup({ saveKey: async key => { throw Error(key); } }); t.after(setup.close);
  for (const [key, status] of [['a', 400], [KEY, 500], ['x'.repeat(2050), 413]]) {
    const r = await fetch(setup.url, { method: 'POST', headers: { origin: setup.origin,
      'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ key }) });
    assert.equal(r.status, status); assert.doesNotMatch(await r.text(), new RegExp(KEY)); assert.equal(setup.isSaved(), false);
  }
});
