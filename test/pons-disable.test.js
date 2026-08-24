import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPonsVersionMonitor } from "../src/pons-version-monitor.js";
import { createGithubMonitor } from "../src/github-monitor.js";
import { startSiteMonitor } from "../src/site-monitor.js";
import { createTwitterMonitor } from "../src/twitter-monitor.js";
import { buildOfficialCatalog } from "../src/official-monitor.js";
import { sendAlerts } from "../src/alerts.js";
import { isPonsSource } from "../src/source-controls.js";

const PONS_FACTORY = "0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb";

async function temporaryDirectory(t, prefix) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the Pons master switch leaves the version cursor untouched and starts no provider work", async (t) => {
  const dataDir = await temporaryDirectory(t, "pons-disabled-version-");
  const stateFile = path.join(dataDir, "pons-version-state.json");
  const original = '{"cursor":{"nextBlock":123456},"sentinel":"keep"}\n';
  await fs.writeFile(stateFile, original);

  const monitor = createPonsVersionMonitor({ dataDir, ponsMonitorEnabled: false });
  assert.equal(monitor.disabled, true);
  assert.equal(await monitor.check(), false);
  assert.equal(await monitor.observeLaunchFactory(PONS_FACTORY), false);
  assert.equal(await fs.readFile(stateFile, "utf8"), original);
});

test("disabled Pons repositories cannot be restored from state or registered again", async (t) => {
  const dataDir = await temporaryDirectory(t, "pons-disabled-github-");
  const stateFile = path.join(dataDir, "github-state.json");
  const originalState = {
    _repositories: {
      "ponsdotdev/ponsfamily": {
        repository: "ponsdotdev/ponsfamily",
        launchpad: "pons",
        sourceTrust: "official_verified",
      },
    },
    sentinel: "keep",
  };
  await fs.writeFile(stateFile, `${JSON.stringify(originalState, null, 2)}\n`);
  const monitor = createGithubMonitor({ dataDir, ponsMonitorEnabled: false }, { autoStart: false });

  const registered = await monitor.confirmOfficialRepository("ponsdotdev/ponsfamily", {
    source: "official_x",
    launchpad: "pons",
    url: "https://x.com/ponsdotfamily/status/1",
  });
  assert.equal(registered, null);
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, "utf8")), originalState);
});

test("disabled Pons sites are neither polled nor added to the dynamic watchlist", async (t) => {
  const dataDir = await temporaryDirectory(t, "pons-disabled-site-");
  const requested = [];
  const monitor = startSiteMonitor({ dataDir, ponsMonitorEnabled: false }, {
    autoStart: false,
    targets: [
      { id: "pons", name: "Pons", website: "https://ponsfamily.com" },
      { id: "other", name: "Other", website: "https://other.example" },
    ],
    fetchImpl: async (url) => {
      requested.push(url);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "Factory V2" };
    },
    sendAlertsImpl: async () => {},
  });
  await monitor.check();
  assert.deepEqual(requested, ["https://other.example"]);
  assert.equal(await monitor.watch({
    factory: PONS_FACTORY,
    website: "https://ponsfamily.com",
    name: "Pons",
    twitter: "https://x.com/ponsdotfamily",
  }), false);
  await assert.rejects(fs.access(path.join(dataDir, "site-watchlist.json")), { code: "ENOENT" });
});

test("disabled Pons X account is absent from the polling schedule", async (t) => {
  const dataDir = await temporaryDirectory(t, "pons-disabled-twitter-");
  const requested = [];
  const monitor = createTwitterMonitor({
    dataDir,
    ponsMonitorEnabled: false,
    twitterDirectXEnabled: false,
    twitterApiBase: "https://timeline.example",
    twitterFallbackApiBases: [],
    twitterStandardPollConcurrency: 100,
  }, {
    autoStart: false,
    logger: { error() {} },
    fetchImpl: async (url) => {
      requested.push(url);
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => "<html></html>" };
    },
    sendAlertsImpl: async () => {},
  });
  await monitor.check();
  assert.ok(requested.length > 0);
  assert.equal(requested.some((url) => /ponsdotfamily/i.test(url)), false);
});

test("official Pons addresses remain persisted but are excluded from the active catalog", async (t) => {
  const dataDir = await temporaryDirectory(t, "pons-disabled-official-");
  const catalogFile = path.join(dataDir, "official-addresses.json");
  const preservedActor = {
    address: "0x0815a4881f9c4073a70fdf00600eba54c5a5baaa",
    project: "Pons",
    role: "V2 owner",
  };
  await fs.writeFile(catalogFile, `${JSON.stringify({ actors: [preservedActor] })}\n`);
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    json: async () => ({ assets: [] }),
  }));
  const calledContracts = [];
  const provider = {
    call: async ({ to }) => {
      calledContracts.push(to);
      throw new Error("getter unavailable");
    },
  };

  const active = await buildOfficialCatalog(provider, dataDir, { ponsMonitorEnabled: false });
  assert.equal(active.officialContracts.some(isPonsSource), false);
  assert.equal(active.actors.some(isPonsSource), false);
  assert.equal(calledContracts.some((address) => address.toLowerCase() === PONS_FACTORY), false);
  const persisted = JSON.parse(await fs.readFile(catalogFile, "utf8"));
  assert.equal(persisted.officialContracts.some(isPonsSource), true);
  assert.equal(persisted.actors.some((actor) => actor.address.toLowerCase() === preservedActor.address), true);
});

test("the alert boundary drops Pons events before creating an outbox", async (t) => {
  const dataDir = await temporaryDirectory(t, "pons-disabled-alert-");
  const result = await sendAlerts({ dataDir, ponsMonitorEnabled: false }, {
    type: "pons_v2_factory_discovered",
    factory: PONS_FACTORY,
    platform: { id: "pons", name: "Pons" },
    observedAt: new Date().toISOString(),
  });
  assert.equal(result.status, "suppressed");
  await assert.rejects(fs.access(path.join(dataDir, "alert-outbox.json")), { code: "ENOENT" });
});
