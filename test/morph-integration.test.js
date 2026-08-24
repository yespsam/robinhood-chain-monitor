import test from "node:test";
import assert from "node:assert/strict";
import { isRelevantAlert, isStrongAlert, telegramButtons } from "../src/alerts.js";
import { extractChainSupportSignals } from "../src/chain-support.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";
import { OFFICIAL_TWITTER_TARGETS, classifyFocusLaunchpadText } from "../src/twitter-monitor.js";

const focus = { monitorScope: "focus3", ponsMonitorEnabled: false };

function morphEvent(overrides = {}) {
  return {
    type: "evm_launchpad_update",
    kind: "new_mode",
    chainId: 2818,
    chain: { id: 2818, slug: "morph", name: "Morph" },
    platform: { id: "flap", name: "Flap", twitter: "https://x.com/flapdotsh" },
    launcher: "0x4267F317adee7C6478a5EE92985c2BD5D855E274",
    tokens: [{ token: "0x3333333333333333333333333333333333333333" }],
    explorerUrl: "https://explorer.morph.network/tx/0xabc",
    marketUrl: "https://dexscreener.com/morph/0x3333333333333333333333333333333333333333",
    sourceUrl: "https://docs.flap.sh/flap/developers/deployed-contract-addresses",
    structural: { eligible: true, exactOfficialRoot: true },
    strong: true,
    blockTimestamp: new Date().toISOString(),
    ...overrides,
  };
}

test("focus3 accepts only high-signal official Morph launchpad milestones", () => {
  const event = morphEvent();
  assert.equal(isMonitoringSourceEnabled(focus, event), true);
  assert.equal(isRelevantAlert(event), true);
  assert.equal(isStrongAlert(event), true);
  assert.equal(isMonitoringSourceEnabled(focus, morphEvent({ kind: "ordinary_token" })), false);
  assert.equal(isMonitoringSourceEnabled(focus, morphEvent({ chainId: 56, chain: { id: 56, slug: "bsc" } })), false);
});

test("Morph Telegram actions copy exact addresses and never invent a GMGN route", () => {
  const keyboard = telegramButtons(morphEvent()).inline_keyboard;
  const serialized = JSON.stringify(keyboard);
  assert.match(serialized, /copy_text/);
  assert.match(serialized, /explorer\.morph\.network/);
  assert.match(serialized, /dexscreener\.com\/morph/);
  assert.doesNotMatch(serialized, /gmgn\.ai/);
  assert.doesNotMatch(serialized, /bscscan/i);
});

test("Long official target starts quietly and recognizes a future Morph deployment", () => {
  const target = OFFICIAL_TWITTER_TARGETS.find((item) => item.id === "long");
  assert.equal(target.handle, "longdotxyz");
  assert.equal(target.baselineOnFirstSeen, true);
  assert.equal(target.backfillOnFirstSeen, undefined);

  const signal = classifyFocusLaunchpadText("Long launchpad is now live on Morph mainnet, chain ID 2818, with a new factory deployment.");
  assert.equal(signal.platformStructural, true);
  assert.equal(signal.chainSupport.some((chain) => chain.id === "morph" && chain.chainId === 2818), true);
  const event = {
    type: "twitter_update",
    project: target,
    tweet: { text: "Long launchpad is now live on Morph mainnet, chain ID 2818, with a new factory deployment." },
    signal,
  };
  assert.equal(isMonitoringSourceEnabled(focus, event), true);
  assert.equal(isRelevantAlert(event), true);

  const baseOnly = {
    ...event,
    signal: {
      ...signal,
      chainSupport: [{ id: "base", name: "Base", chainId: 8453, environment: "mainnet", stage: "deployed" }],
    },
  };
  assert.equal(isRelevantAlert(baseOnly), false);
});

test("Morph is normalized as chain 2818 instead of a generic unknown chain", () => {
  assert.deepEqual(extractChainSupportSignals("Flap launchpad is now live on Morph mainnet, chain ID 2818."), [{
    id: "morph",
    name: "Morph",
    chainId: 2818,
    environment: "mainnet",
    stage: "deployed",
  }]);
});
