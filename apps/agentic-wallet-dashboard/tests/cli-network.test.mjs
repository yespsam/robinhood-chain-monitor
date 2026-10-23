import test from 'node:test';
import assert from 'node:assert/strict';
import { proxyEnvironment, walletChildEnvironment } from '../server/cli-network.mjs';
import { createCliRunner } from '../server/official-cli.mjs';
const settings = { enabled: true, server: '127.0.0.1:12345', bypass: '127.*;192.168.*;10.20.30.*;*.example.test;<local>' };

test('existing local Windows proxy and IPv4 bypasses reach only the CLI environment with strict TLS unchanged', async () => {
  const base = Object.freeze({ PATH: 'synthetic-path' });
  const network = proxyEnvironment(base, settings);
  assert.equal(network.mode, 'existing-windows-loopback-proxy');
  assert.equal(network.env.HTTP_PROXY, 'http://127.0.0.1:12345');
  assert.equal(network.env.HTTPS_PROXY, network.env.HTTP_PROXY);
  assert.equal(network.env.NODE_USE_ENV_PROXY, '1');
  assert.equal(network.env.NO_PROXY, 'localhost,127.0.0.1,[::1],127.0.0.0-127.255.255.255,192.168.0.0-192.168.255.255,10.20.30.0-10.20.30.255,*.example.test');
  assert.equal(network.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.deepEqual(base, { PATH: 'synthetic-path' });
  const run = createCliRunner({ childEnv: network.env,
    readMetadata: async () => ({ name: '@binance/agentic-wallet', version: '1.11.0', bin: { baw: 'dist/index.js' } }),
    execute: async (_exe, args, options) => {
      assert.equal(options.env, network.env); assert.equal(options.shell, false);
      assert.deepEqual(args.slice(1), ['wallet', 'status', '--json']);
      return { stdout: '{}' };
    } });
  await run(['wallet', 'status']);
});

test('explicit proxy settings including opt-out and NO_PROXY are preserved', () => {
  for (const base of [{ HTTPS_PROXY: 'https://explicit.example' }, { http_proxy: 'http://explicit.example' }, { ALL_PROXY: 'socks5://explicit.example' }, { NODE_USE_ENV_PROXY: '0' }]) {
    assert.deepEqual(proxyEnvironment(base, settings), { env: base, mode: 'explicit-environment-preserved' });
  }
  const withBypass = proxyEnvironment({ no_proxy: 'explicit.test' }, settings);
  assert.equal(withBypass.env.no_proxy, 'explicit.test'); assert.equal(withBypass.env.NO_PROXY, undefined);
});

test('unknown, remote, credentialed, SOCKS and per-protocol proxy formats are never guessed', () => {
  for (const server of ['proxy.example:12345', 'http://user:secret@127.0.0.1:12345', 'socks5://127.0.0.1:12345', 'http=127.0.0.1:12345;https=127.0.0.1:12345', '127.0.0.1', '127.0.0.1:0', '127.0.0.1:65536', 'http://127.0.0.1:12345/path']) {
    assert.deepEqual(proxyEnvironment({}, { ...settings, server }), { env: {}, mode: 'system-proxy-format-unconfirmed' });
  }
  for (const bypass of ['256.*', '10.*.4', '*.example.test/path', 'https://example.test', '<unknown>']) {
    assert.deepEqual(proxyEnvironment({}, { ...settings, bypass }), { env: {}, mode: 'system-proxy-bypass-unconfirmed' });
  }
  assert.equal(proxyEnvironment({}, { ...settings, server: 'https://[::1]:12345' }).env.HTTPS_PROXY, 'https://[::1]:12345');
});

test('disabled, unsupported and unreadable system settings leave the environment intact', async () => {
  const options = { base: { PATH: 'synthetic-path' }, platform: 'win32', version: '24.13.0', readSettings: async () => settings };
  assert.equal((await walletChildEnvironment(options)).mode, 'existing-windows-loopback-proxy');
  const noRead = async () => assert.fail('must not inspect registry');
  for (const [override, mode] of [[{ enabled: false }, 'adapter-disabled'], [{ platform: 'linux' }, 'platform-unchanged'], [{ version: '22.0.0' }, 'node-proxy-support-unconfirmed']]) {
    assert.deepEqual(await walletChildEnvironment({ ...options, ...override, readSettings: noRead }), { env: options.base, mode });
  }
  assert.deepEqual(await walletChildEnvironment({ ...options, readSettings: async () => { throw Error('private registry detail'); } }), { env: options.base, mode: 'system-proxy-read-unavailable' });
  assert.equal(proxyEnvironment({}, { enabled: false }).mode, 'system-proxy-disabled');
});
