import assert from 'node:assert/strict';
import test from 'node:test';
import { createDashboardServer } from '../scripts/dashboard-server.js';

test('dashboard serves the paper terminal, local paper bridge, and rejects path traversal', async t => {
  const app = createDashboardServer({ host: '127.0.0.1', port: 0 });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://${address.address}:${address.port}`;
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /SIMULATION ONLY/);
  const css = await fetch(`${base}/styles.css`);
  assert.equal(css.status, 200);
  assert.match(await css.text(), /--lime/);
  const state = await fetch(`${base}/api/paper-state`);
  assert.equal(state.status, 200);
  assert.equal((await state.json()).execution, false);
  const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.equal(traversal.status, 400);
});
