import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import {
  buildKolLaunchDemo,
  createKolLaunchFixture,
  FIXTURE_KOL_CA,
} from "../scripts/kol-launch-demo.js";

test("KOL launch fixture is explicitly fictional, creator-unverified, and non-executable", () => {
  const event = createKolLaunchFixture();
  assert.equal(event.fixtureOnly, true);
  assert.equal(event.signalKind, "kol_self_launch");
  assert.equal(event.caller.followers, 128_400);
  assert.equal(event.caller.background.status, "self_described");
  assert.equal(event.token, FIXTURE_KOL_CA);
  assert.match(event.token, /^0x[0-9a-f]{40}$/);
  assert.equal(event.launchClaim.onchainCreatorVerified, false);
  assert.equal(event.launchClaim.creatorAttribution, "not_onchain_verified");
  assert.equal(event.launchClaim.creator, null);
  assert.equal(event.shadow.decision, "watch");
  assert.equal(event.shadow.executable, false);
  assert.equal(event.shadow.signing, false);
  assert.equal(event.shadow.broadcast, false);
  assert.equal(event.shadow.score, null, "followers must not become a trading score");
});

test("demo uses the existing renderer to produce one honest bilingual watch-only card", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => assert.fail("fixture rendering must not access the network");
  try {
    const result = await buildKolLaunchDemo();
    assert.equal(result.fixtureOnly, true);
    assert.equal(result.mode, "watch-only");
    assert.equal(result.creatorOnchainVerified, false);
    assert.equal(result.signing, false);
    assert.equal(result.broadcast, false);
    assert.match(result.alertText, /📣 大V发币 \| KOL TOKEN LAUNCH/);
    assert.match(result.alertText, /🇨🇳 中文/);
    assert.match(result.alertText, /🇬🇧 English/);
    assert.match(result.alertText, /@demo_builder_ai/);
    assert.match(result.alertText, /128,400/);
    assert.match(result.alertText, /AI product builder/);
    assert.match(result.alertText, new RegExp(FIXTURE_KOL_CA, "i"));
    assert.match(result.alertText, /事件：该账号原帖声明发行 \$SPARK/u);
    assert.doesNotMatch(result.alertText, /风险|Risk|UNKNOWN|creator|不可执行|not executable|不签名|no signing|粉丝数不参与|followers are not scored|watch-only/iu);
    assert.equal(result.renderBundle.zh.provider, "local_structured");
    assert.equal(result.renderBundle.en.provider, "local_structured");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("--json emits parseable fixture output without starting a monitor", () => {
  const script = fileURLToPath(new URL("../scripts/kol-launch-demo.js", import.meta.url));
  const run = spawnSync(process.execPath, [script, "--json"], {
    encoding: "utf8",
    env: {
      ...process.env,
      KOL_LAUNCH_MONITOR_ENABLED: "false",
      TELEGRAM_BOT_TOKEN: "",
      TELEGRAM_CHAT_ID: "",
      WEBHOOK_URL: "",
    },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, "");
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.fixtureOnly, true);
  assert.equal(parsed.event.source.trust, "fixture_only");
  assert.equal(parsed.event.token, FIXTURE_KOL_CA);
  assert.equal(parsed.event.shadow.executable, false);
  assert.equal(parsed.signing, false);
  assert.equal(parsed.broadcast, false);
});

test("demo script contains no network, signing, broadcasting, or production startup calls", async () => {
  const [source, packageJson] = await Promise.all([
    fs.readFile(new URL("../scripts/kol-launch-demo.js", import.meta.url), "utf8"),
    fs.readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
  ]);
  assert.equal(packageJson.scripts["demo:kol-launch"], "node scripts/kol-launch-demo.js");
  assert.doesNotMatch(source, /\bfetch\s*\(/u);
  assert.doesNotMatch(source, /\b(?:WebSocket|JsonRpcProvider|Wallet)\s*\(/u);
  assert.doesNotMatch(source, /\b(?:sendTransaction|broadcastTransaction|createFomoXCallMonitor|sendAlerts)\s*\(/u);
  assert.doesNotMatch(source, /import\s+[^;]*src\/index\.js/u);
});
