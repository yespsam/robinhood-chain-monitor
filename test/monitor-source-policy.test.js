import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadMonitorSourcePolicy, monitorSourceOverrides, isCancelledFomoPlatformEvent } from "../src/monitor-source-policy.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";

test("FOMO cancellation preserves independent worker, smart money and X flags", async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-source-policy-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.equal(loadMonitorSourcePolicy(dir).fomoPlatformSourcesEnabled, true);
  await fs.writeFile(path.join(dir, "monitor-source-policy.json"), JSON.stringify({version: 1, fomoPlatformSourcesEnabled: false}));
  const config = { fomoCallEnabled: true, fomoCallStandalone: true, fomoBuyMonitorEnabled: true,
    fomoPublishedCallEnabled: true, fomoSmartMoneyMonitorEnabled: true, gmgnFlowMonitorEnabled: true,
    fomoXCallEnabled: true, kolLaunchMonitorEnabled: true, telegramNewsMonitorEnabled: true, bscMonitorEnabled: true };
  const applied = { ...config, ...monitorSourceOverrides(loadMonitorSourcePolicy(dir)) };
  assert.equal(applied.fomoBuyMonitorEnabled, false);
  assert.equal(applied.fomoPublishedCallEnabled, false);
  for (const key of Object.keys(config).filter(key => !["fomoBuyMonitorEnabled", "fomoPublishedCallEnabled"].includes(key))) {
    assert.equal(applied[key], config[key], key);
  }
  await fs.writeFile(path.join(dir, "monitor-source-policy.json"), "broken");
  assert.equal(loadMonitorSourcePolicy(dir).fomoPlatformSourcesEnabled, false);
  assert.equal(loadMonitorSourcePolicy(dir).monitorSourcePolicyStatus, "invalid_disabled");
});

test("cancelled platform events cannot escape via retained outbox or cached bindings", () => {
  const config = { fomoPlatformSourcesEnabled: false, fomoCallEnabled: true, fomoPublishedCallEnabled: true };
  for (const event of [
    {signalKind: "fomo_published_call"},
    {source: {id: "fomo_family_official_thesis"}},
    {source: {id: "fomoscan_onchain"}},
    {source: {id: "fomo_linked_x_post"}, walletBinding: {proofSource: "fomoscan"}},
  ]) {
    assert.equal(isCancelledFomoPlatformEvent(config, event), true);
    assert.equal(isMonitoringSourceEnabled(config, event), false);
  }
  for (const id of ["gmgn_flow_observed", "gmgn_kol_onchain", "gmgn_smart_money", "fomo_linked_x_post", "official_x"]) {
    assert.equal(isCancelledFomoPlatformEvent(config, {source: {id}}), false, id);
  }
});
