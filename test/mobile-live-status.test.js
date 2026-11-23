import test from 'node:test';
import assert from 'node:assert/strict';
import { readLiveRuntimeStatus } from '../src/mobile-live-status.js';

const response = (body) => ({ ok: true, json: async () => body });

test('mobile status follows the executor switch, not the mobile environment', async () => {
  for (const enabled of [false, true]) {
    const result = await readLiveRuntimeStatus({ fetchImpl: async (url, options) => {
      assert.equal(url, 'http://127.0.0.1:4173/api/live-runtime-status');
      assert.equal(options.cache, 'no-store');
      assert.equal(options.headers['accept-encoding'], 'identity');
      assert.ok(options.signal instanceof AbortSignal);
      return response({ status: 'ok', enabled: true, updatedAt: '2026-11-09T12:00:00Z', liveMirror: { enabled, chains: ['bsc', 'sol'] } });
    } });
    assert.equal(result.enabled, enabled);
    assert.equal(result.status, 'available');
    assert.equal(result.chains, 'bsc,sol');
    assert.equal(result.paperEnabled, true);
    assert.equal(result.runtimeStatus, 'ok');
  }
});

test('paused paper source is exposed independently of enabled live mirror', async () => {
  const state = await readLiveRuntimeStatus({ fetchImpl: async () => response({
    status: 'ok', enabled: false, liveMirror: { enabled: true, chains: ['bsc'] },
  }) });
  assert.equal(state.enabled, true);
  assert.equal(state.paperEnabled, false);
});

test('unreachable, failed or incomplete executor state is unknown, never an enabled fallback', async () => {
  for (const fetchImpl of [
    async () => { throw new Error('connection refused'); },
    async () => ({ ok: false }),
    async () => response({ enabled: true }),
    async () => response({ liveMirror: { enabled: 'true' } }),
  ]) {
    const state = await readLiveRuntimeStatus({ fetchImpl });
    assert.equal(state.status, 'unavailable');
    assert.equal(state.enabled, null);
  }
});

test('executor request is bounded by its abort signal', async () => {
  const state = await readLiveRuntimeStatus({ timeoutMs: 5, fetchImpl: async (_url, { signal }) => {
    await new Promise((resolve, reject) => {
      const hold = setTimeout(resolve, 500);
      signal.addEventListener('abort', () => { clearTimeout(hold); reject(signal.reason); }, { once: true });
    });
  } });
  assert.equal(state.status, 'unavailable');
  assert.equal(state.enabled, null);
});
