import test from "node:test";
import assert from "node:assert/strict";
import { createDashboardServer } from "../scripts/dashboard-server.js";

test("dashboard exposes local manual-only status and rejects confirmation without explicit phrase", async (t) => {
  let confirms = 0;
  const manualLiveApproval = {
    status: () => ({ ready: true, reason: "manual only" }),
    async listCandidates() { return [{ id: "candidate-1", chain: "bsc" }]; },
    async confirm() { confirms += 1; return { ok: true }; },
    async prepare() { return { ok: true }; },
    cancel() { return { ok: true }; },
  };
  const app = createDashboardServer({ host: "127.0.0.1", port: 0, manualLiveApproval, market: { async trending() { return { tokens: [] }; } } });
  const address = await app.listen();
  t.after(() => app.close());
  const base = `http://127.0.0.1:${address.port}`;
  const status = await (await fetch(`${base}/api/live-approval/status`)).json();
  assert.equal(status.manualOnly, true);
  assert.equal(status.mirrorEnabled, false);
  assert.deepEqual((await (await fetch(`${base}/api/live-approval/candidates`)).json()).candidates, [{ id: "candidate-1", chain: "bsc" }]);
  const rejected = await fetch(`${base}/api/live-approval/confirm`, { method: "POST", headers: { origin: base, "sec-fetch-site": "same-origin", "content-type": "application/json" }, body: JSON.stringify({ approvalId: "id" }) });
  assert.equal(rejected.status, 400);
  assert.equal(confirms, 0);
  const page = await fetch(`${base}/live-confirm.html`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /策略实盘候选/);
});
