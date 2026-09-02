import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { drainAlertOutbox, isRelevantAlert, sendAlerts, telegramButtons } from "../src/alerts.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";

const TOKEN = "0x2222222222222222222222222222222222222222";
const WALLET = "0x1111111111111111111111111111111111111111";
const X_POST_ID = "2089553165817667830";

const focusConfig = {
  monitorScope: "focus3",
  ponsMonitorEnabled: false,
  fomoCallEnabled: true,
  fomoBuyMonitorEnabled: false,
  fomoPublishedCallEnabled: true,
  fomoXCallEnabled: true,
  fomoCallAllowGmgnObservedWallets: true,
};

function assertFomoDisplayLayout(text) {
  assert.ok(text.length < 3_800, `Fomo card is ${text.length} characters`);
  assert.ok(text.split("\n").length <= 18, `Fomo card has ${text.split("\n").length} lines`);
  const blocks = String(text).match(/🇨🇳 中文\n([\s\S]*?)\n\n🇬🇧 English\n([\s\S]*)$/u);
  assert.ok(blocks, "Fomo alert must contain Chinese and English blocks");
  for (const block of blocks.slice(1)) {
    const lines = block.split("\n").filter(Boolean);
    assert.ok(lines.length >= 4 && lines.length <= 7, `Fomo language block has ${lines.length} lines`);
    assert.ok(lines.every((line) => line.length <= 150), "Fomo display lines must remain short");
  }
}

function linkedXCall(overrides = {}) {
  const observedAt = new Date().toISOString();
  return {
    type: "fomo_family_top_call",
    signalKind: "fomo_x_call",
    eventKey: `fomo-x-call:1777777777777777777:${X_POST_ID}:${TOKEN}`,
    callId: `x:1777777777777777777:${X_POST_ID}:${TOKEN}`,
    stableId: X_POST_ID,
    qualified: true,
    strong: true,
    source: {
      id: "fomo_linked_x_post",
      name: "Fomo-linked KOL public X post",
      trust: "public_x_identity_linked",
      url: `https://x.com/alpha/status/${X_POST_ID}`,
    },
    sourceTrust: "public_x_identity_linked",
    chain: { id: 56, chainId: 56, name: "BNB Smart Chain", slug: "bsc", gmgn: "bsc" },
    token: TOKEN,
    contractAddress: TOKEN,
    tokenSymbol: "CALL",
    symbol: "CALL",
    caller: {
      handle: "alpha",
      twitterHandle: "alpha",
      twitter: "https://x.com/alpha",
      xProfileId: "1777777777777777777",
      identitySource: "gmgn+fxtwitter",
      followers: 125_000,
      followersSyncedAt: observedAt,
    },
    handle: "alpha",
    walletAddress: WALLET,
    walletAttribution: {
      scheme: "gmgn_x_maker_observation_v1",
      status: "observed",
      verified: false,
      ambiguousIdentity: false,
      ambiguousWallets: false,
      ambiguousHandles: false,
      source: "gmgn_bsc_kol_feed",
      candidateSource: "gmgn_bsc_kol_feed",
      monitoringWallet: WALLET,
      xHandle: "alpha",
      xProfileId: "1777777777777777777",
      fomoTagged: true,
      tags: ["kol", "fomo", "gmgn"],
      observedAt,
      xFollowersCheckedAt: observedAt,
      bscActivityCheckedAt: observedAt,
      bscTransactionCount: 23,
    },
    body: `I bought CALL. CA: ${TOKEN}`,
    thesis: { id: X_POST_ID, text: `I bought CALL. CA: ${TOKEN}`, handle: "alpha", createdAt: observedAt },
    tweet: {
      id: X_POST_ID,
      text: `I bought CALL. CA: ${TOKEN}`,
      handle: "alpha",
      xUserId: "1777777777777777777",
      authorId: "1777777777777777777",
      createdAt: observedAt,
      url: `https://x.com/alpha/status/${X_POST_ID}`,
      sourceVerifiedBy: "official_x_oembed",
    },
    publishedAt: observedAt,
    observedAt,
    market: { liquidityUsd: 65_000, volumeM5: 18_000, marketCap: 720_000, sellsM5: 8 },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true } },
    explorerUrl: `https://bscscan.com/token/${TOKEN}`,
    ...overrides,
  };
}

function publishedCall(overrides = {}) {
  const now = new Date().toISOString();
  return {
    type: "fomo_family_top_call",
    signalKind: "fomo_published_call",
    eventKey: "fomo-published-call:thesis-1001",
    callId: "thesis-1001",
    stableId: "thesis-1001",
    qualified: true,
    strong: true,
    source: {
      id: "fomo_family_official_thesis",
      name: "Fomo Family official thesis feed",
      trust: "official_authenticated_api",
      url: "https://fomo.family",
    },
    sourceTrust: "official_authenticated_api",
    chain: { id: 56, chainId: 56, name: "BNB Smart Chain", slug: "bsc", gmgn: "bsc" },
    token: TOKEN,
    contractAddress: TOKEN,
    tokenSymbol: "CALL",
    symbol: "CALL",
    caller: {
      handle: "alpha",
      followers: 125_000,
      trafficRank: 3,
      twitter: "https://x.com/alpha",
    },
    handle: "alpha",
    body: "Accumulating CALL while BSC liquidity is expanding.",
    thesis: {
      id: "thesis-1001",
      text: "Accumulating CALL while BSC liquidity is expanding.",
      handle: "alpha",
      createdAt: now,
    },
    publishedAt: now,
    observedAt: now,
    market: {
      liquidityUsd: 65_000,
      volumeM5: 18_000,
      marketCap: 720_000,
      sellsM5: 8,
    },
    security: {
      decision: "pass",
      metrics: { liquidityConfirmed: true, sellObserved: true },
    },
    fomoUrl: "https://fomo.family/profile/alpha?tradeId=thesis-1001",
    profileUrl: "https://fomo.family/profile/alpha",
    explorerUrl: `https://bscscan.com/token/${TOKEN}`,
    ...overrides,
  };
}

function legacyVerifiedFirstBuy() {
  return {
    type: "fomo_family_top_call",
    signalKind: "top_blogger_first_buy",
    chain: { id: 56, slug: "bsc" },
    qualified: true,
    strong: true,
    source: { id: "fomoscan_onchain", trust: "public_onchain_verified" },
    security: { decision: "pass" },
    token: TOKEN,
    walletAddress: WALLET,
    positionProof: {
      status: "verified",
      phase: "previous_block",
      previousBalanceRaw: "0",
    },
    walletBinding: {
      status: "verified",
      verified: true,
      proofSource: "fomoscan",
      wallet: WALLET,
      handle: "alpha",
    },
    caller: {
      handle: "alpha",
      followers: 125_000,
      identitySource: "fomoscan+fxtwitter",
      twitter: "https://x.com/alpha",
    },
  };
}

function verifiedFirstBuy(overrides = {}) {
  const now = new Date().toISOString();
  const transactionHash = `0x${"4".repeat(64)}`;
  const blockNumber = 12_345_678;
  const event = {
    type: "fomo_family_top_call",
    signalKind: "top_blogger_first_buy",
    eventKey: `fomo-call:top_blogger_first_buy:${transactionHash}:${TOKEN}`,
    callId: `${transactionHash}:${TOKEN}`,
    qualified: true,
    strong: true,
    activity: "buy",
    source: { id: "fomoscan_onchain", trust: "public_onchain_verified" },
    chain: { id: 56, chainId: 56, name: "BNB Smart Chain", slug: "bsc", gmgn: "bsc" },
    token: TOKEN,
    contractAddress: TOKEN,
    tokenSymbol: "CALL",
    caller: {
      handle: "alpha",
      twitter: "https://x.com/alpha",
      xProfileId: "1777777777777777777",
      identitySource: "fomoscan+fxtwitter",
      followers: 125_000,
      followersSyncedAt: now,
    },
    walletAddress: WALLET,
    walletBinding: {
      status: "verified",
      verified: true,
      proofSource: "fomoscan",
      wallet: WALLET,
      handle: "alpha",
      twitterHandle: "alpha",
      xProfileId: "1777777777777777777",
      checkedAt: now,
    },
    transactionHash,
    blockNumber,
    positionProof: {
      status: "verified",
      complete: true,
      phase: "previous_block",
      previousBalanceRaw: "0",
      wallet: WALLET,
      token: TOKEN,
      transactionHash,
      blockNumber,
    },
    publishedAt: now,
    observedAt: now,
    market: { liquidityUsd: 65_000, volumeM5: 18_000, marketCap: 720_000, sellsM5: 8 },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true } },
    explorerUrl: `https://bscscan.com/token/${TOKEN}`,
  };
  return { ...event, ...overrides };
}

test("focus3 accepts real BSC Fomo published calls without wallet or position proof", () => {
  const official = publishedCall();
  assert.equal("walletAddress" in official, false);
  assert.equal("walletBinding" in official, false);
  assert.equal("positionProof" in official, false);
  assert.equal(isMonitoringSourceEnabled(focusConfig, official), true);

  const relay = publishedCall({
    eventKey: "fomo-published-call:relay-thesis-1002",
    callId: "relay-thesis-1002",
    stableId: "relay-thesis-1002",
    source: {
      id: "fomoscan_thesis_relay",
      name: "FomoScan thesis relay",
      trust: "verified_thesis_relay",
      url: "https://api.fomoscan.sh",
    },
    sourceTrust: "verified_thesis_relay",
    thesis: {
      id: "relay-thesis-1002",
      text: "CALL has a new catalyst and growing BSC volume.",
      handle: "alpha",
      createdAt: official.publishedAt,
    },
    body: "CALL has a new catalyst and growing BSC volume.",
  });
  assert.equal(isMonitoringSourceEnabled(focusConfig, relay), true);
});

test("focus3 rejects the disabled buy lane and untrusted or low-quality published calls", () => {
  assert.equal(
    isMonitoringSourceEnabled(focusConfig, legacyVerifiedFirstBuy()),
    false,
    "the legacy first-buy lane must stay off even when its old wallet proof is complete",
  );

  const rejected = [
    ["wrong source trust", publishedCall({
      source: { id: "copied_feed", trust: "public_onchain_attributed", url: "https://attacker.example" },
      sourceTrust: "public_onchain_attributed",
    })],
    ["missing thesis text", publishedCall({ body: "", thesis: { id: "thesis-1001", text: "", handle: "alpha" } })],
    ["non-BSC chain", publishedCall({ chain: { id: 8453, chainId: 8453, name: "Base", slug: "base", gmgn: "base" } })],
    ["caller below 10k X followers", publishedCall({
      caller: { handle: "alpha", followers: 9_999, trafficRank: 3, twitter: "https://x.com/alpha" },
    })],
  ];

  for (const [label, event] of rejected) {
    assert.equal(isMonitoringSourceEnabled(focusConfig, event), false, label);
  }
});

test("focus3 admits only fresh, identity-pinned and safely qualified Fomo-linked X calls", () => {
  const event = linkedXCall();
  assert.equal(isMonitoringSourceEnabled(focusConfig, event), true);
  assert.equal(isMonitoringSourceEnabled({ ...focusConfig, fomoXCallEnabled: false }, event), false);

  const fomoScanLinked = linkedXCall({
    caller: { ...event.caller, identitySource: "fomoscan+fxtwitter" },
    walletAttribution: null,
    walletBinding: {
      status: "verified",
      verified: true,
      proofSource: "fomoscan",
      wallet: WALLET,
      handle: "alpha",
      twitterHandle: "alpha",
      xProfileId: event.caller.xProfileId,
      checkedAt: event.observedAt,
    },
  });
  assert.equal(isMonitoringSourceEnabled(focusConfig, fomoScanLinked), true, "a fresh exact FomoScan binding is accepted");

  const rejected = [
    ["wrong immutable X id", linkedXCall({ tweet: { ...event.tweet, xUserId: "1888888888888888888" } })],
    ["call text points at another contract", linkedXCall({ thesis: { ...event.thesis, text: `Buying TOKEN CA 0x3333333333333333333333333333333333333333` }, body: `Buying TOKEN CA 0x3333333333333333333333333333333333333333`, tweet: { ...event.tweet, text: `Buying TOKEN CA 0x3333333333333333333333333333333333333333` } })],
    ["invalid linked wallet", linkedXCall({ walletAddress: "not-an-address", walletAttribution: { ...event.walletAttribution, monitoringWallet: "not-an-address" } })],
    ["wrong canonical post", linkedXCall({ tweet: { ...event.tweet, url: `https://x.com/impostor/status/${X_POST_ID}` } })],
    ["missing official oEmbed proof", linkedXCall({ tweet: { ...event.tweet, sourceVerifiedBy: "fxtwitter" } })],
    ["dirty wallet tag", linkedXCall({ walletAttribution: { ...event.walletAttribution, tags: ["kol", "fomo", "wash_trader"] } })],
    ["missing explicit GMGN candidate origin", linkedXCall({ walletAttribution: { ...event.walletAttribution, candidateSource: undefined } })],
    ["missing explicit ambiguity verdict", linkedXCall({ walletAttribution: { ...event.walletAttribution, ambiguousIdentity: undefined } })],
    ["ambiguous GMGN handles", linkedXCall({ walletAttribution: { ...event.walletAttribution, ambiguousHandles: true } })],
    ["wallet mismatch", linkedXCall({ walletAddress: "0x3333333333333333333333333333333333333333" })],
    ["lost FomoScan binding cannot masquerade as GMGN", linkedXCall({
      caller: { ...event.caller, identitySource: "gmgn+fxtwitter" },
      walletBinding: null,
      walletAttribution: { ...event.walletAttribution, candidateSource: undefined },
    })],
    ["stale FomoScan binding", {
      ...fomoScanLinked,
      walletBinding: { ...fomoScanLinked.walletBinding, checkedAt: new Date(Date.now() - 86_400_001).toISOString() },
    }],
    ["FomoScan binding X id mismatch", {
      ...fomoScanLinked,
      walletBinding: { ...fomoScanLinked.walletBinding, xProfileId: "1888888888888888888" },
    }],
    ["failed local safety", linkedXCall({ security: { decision: "block", metrics: { liquidityConfirmed: false, sellObserved: false } } })],
  ];
  for (const [label, candidate] of rejected) {
    assert.equal(isMonitoringSourceEnabled(focusConfig, candidate), false, label);
    assert.equal(isRelevantAlert(candidate), false, `${label} must also fail alert relevance`);
  }
});

test("focus3 buy lane fails closed on stale, dirty, ambiguous, misaligned, transfer or sell evidence", () => {
  const enabled = { ...focusConfig, fomoBuyMonitorEnabled: true };
  const verified = verifiedFirstBuy();
  assert.equal(isMonitoringSourceEnabled(enabled, verified), true);
  assert.equal(isRelevantAlert(verified), true);

  const observedAt = verified.observedAt;
  const gmgn = verifiedFirstBuy({
    source: { id: "gmgn_kol_onchain", trust: "public_onchain_attributed" },
    caller: {
      ...verified.caller,
      identitySource: "gmgn+fxtwitter",
    },
    walletBinding: null,
    walletAttribution: {
      scheme: "gmgn_x_maker_observation_v1",
      status: "observed",
      verified: false,
      source: "gmgn_bsc_kol_feed",
      candidateSource: "gmgn_bsc_kol_feed",
      monitoringWallet: WALLET,
      xHandle: "alpha",
      xProfileId: verified.caller.xProfileId,
      fomoTagged: true,
      tags: ["kol", "fomo"],
      ambiguousIdentity: false,
      ambiguousWallets: false,
      ambiguousHandles: false,
      observedAt,
      xFollowersCheckedAt: observedAt,
      bscActivityCheckedAt: observedAt,
      bscTransactionCount: 23,
    },
  });
  assert.equal(isMonitoringSourceEnabled(enabled, gmgn), true);

  const rejected = [
    ["missing explicit buy direction", verifiedFirstBuy({ activity: undefined })],
    ["ordinary transfer", verifiedFirstBuy({ activity: "transfer" })],
    ["sell", verifiedFirstBuy({ side: "sell" })],
    ["wrong signal kind", verifiedFirstBuy({ signalKind: "wallet_transfer" })],
    ["stale FomoScan binding", verifiedFirstBuy({ walletBinding: { ...verified.walletBinding, checkedAt: new Date(Date.now() - 86_400_001).toISOString() } })],
    ["FomoScan handle mismatch", verifiedFirstBuy({ walletBinding: { ...verified.walletBinding, handle: "impostor" } })],
    ["FomoScan X id mismatch", verifiedFirstBuy({ walletBinding: { ...verified.walletBinding, xProfileId: "1888888888888888888" } })],
    ["incomplete first-position proof", verifiedFirstBuy({ positionProof: { ...verified.positionProof, complete: false } })],
    ["dirty GMGN tag", { ...gmgn, walletAttribution: { ...gmgn.walletAttribution, tags: ["kol", "fomo", "arbitrager"] } }],
    ["ambiguous GMGN identity", { ...gmgn, walletAttribution: { ...gmgn.walletAttribution, ambiguousIdentity: true } }],
    ["missing GMGN ambiguity verdict", { ...gmgn, walletAttribution: { ...gmgn.walletAttribution, ambiguousIdentity: undefined } }],
    ["missing GMGN candidate origin", { ...gmgn, walletAttribution: { ...gmgn.walletAttribution, candidateSource: undefined } }],
    ["stale GMGN attribution", {
      ...gmgn,
      walletAttribution: {
        ...gmgn.walletAttribution,
        observedAt: new Date(Date.now() - 86_400_001).toISOString(),
      },
    }],
    ["GMGN wallet mismatch", { ...gmgn, walletAttribution: { ...gmgn.walletAttribution, monitoringWallet: "0x3333333333333333333333333333333333333333" } }],
    ["GMGN X id mismatch", { ...gmgn, walletAttribution: { ...gmgn.walletAttribution, xProfileId: "1888888888888888888" } }],
  ];
  for (const [label, candidate] of rejected) {
    assert.equal(isMonitoringSourceEnabled(enabled, candidate), false, label);
  }
  for (const candidate of rejected.slice(0, 3).map(([, event]) => event)) {
    assert.equal(isRelevantAlert(candidate), false, "missing/transfer/sell directions must fail relevance too");
  }
});

test("Fomo-linked X call card shows the CA-wallet-X link without claiming an official Fomo call", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-x-call-card-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }),
    };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});

  const event = linkedXCall();
  const result = await sendAlerts({
    ...focusConfig,
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "test-bot-token",
    telegramChatId: "123456789",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertTranslationFetchImpl: async () => { throw new Error("offline translation fixture"); },
    alertTranslationFallbackUrl: "https://api.mymemory.translated.net/get",
    alertTranslationTimeoutMs: 50,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
  }, event);

  assert.equal(result.status, "delivered");
  assert.equal(payloads.length, 1);
  const text = payloads[0].text;
  assert.match(text, /平台：Fomo/);
  assert.match(text, /英文原文：I bought CALL/);
  assert.match(text, /信号：@alpha X 喊单 · 标的 CALL/);
  assert.match(text, /Platform: Fomo/);
  assert.match(text, /Thesis: I bought CALL/);
  assert.match(text, /Signal: @alpha X call · target CALL/);
  assert.match(text, new RegExp(TOKEN, "i"));
  assert.match(text, new RegExp(WALLET, "i"));
  assert.match(text, new RegExp(`X#${X_POST_ID}`));
  assert.match(text, /GMGN 钱包关联仅观测/);
  assert.match(text, /非 Fomo 官方/);
  assert.match(text, /非买入建议/);
  assert.match(text, /not a buy recommendation/iu);
  assert.doesNotMatch(text, /Fomo 官方发布|Official Fomo publication|链上首买|zero.position/i);
  assertFomoDisplayLayout(text);

  const buttons = telegramButtons(event).inline_keyboard.flat();
  assert.equal(buttons.find((button) => button.copy_text)?.copy_text.text, TOKEN);
  assert.equal(buttons.find((button) => button.text.includes("观测地址"))?.copy_text.text, WALLET);
  assert.equal(buttons.find((button) => button.text.includes("喊单原帖"))?.url, event.tweet.url);
  assert.ok(buttons.some((button) => button.text.includes("GMGN")));
});

test("the first trusted Fomo call for a BSC token wins across X and the official feed", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-cross-source-first-"));
  let telegramCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).startsWith("https://api.telegram.org/")) telegramCalls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: Math.max(1, telegramCalls) } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = {
    ...focusConfig,
    fomoBuyMonitorEnabled: true,
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "test-bot-token",
    telegramChatId: "123456789",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
  };
  assert.equal((await sendAlerts(config, linkedXCall())).status, "delivered");
  const duplicate = await sendAlerts(config, publishedCall({ eventKey: "fomo-published-call:cross-source-duplicate" }));
  assert.equal(duplicate.status, "suppressed");
  assert.equal(duplicate.reason, "semantic_duplicate");
  const duplicateBuy = await sendAlerts(config, verifiedFirstBuy({ eventKey: "fomo-buy:cross-source-duplicate" }));
  assert.equal(duplicateBuy.status, "suppressed");
  assert.equal(duplicateBuy.reason, "semantic_duplicate");
  assert.equal(telegramCalls, 1);
});

test("the first verified Fomo buy suppresses later X and published calls for the token", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-cross-source-buy-first-"));
  let telegramCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).startsWith("https://api.telegram.org/")) telegramCalls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: Math.max(1, telegramCalls) } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = {
    ...focusConfig,
    fomoBuyMonitorEnabled: true,
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "test-bot-token",
    telegramChatId: "123456789",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
  };

  assert.equal((await sendAlerts(config, verifiedFirstBuy())).status, "delivered");
  assert.equal((await sendAlerts(config, linkedXCall({ eventKey: "fomo-x-call:buy-first-duplicate" }))).reason, "semantic_duplicate");
  assert.equal((await sendAlerts(config, publishedCall({ eventKey: "fomo-published-call:buy-first-duplicate" }))).reason, "semantic_duplicate");
  assert.equal(telegramCalls, 1);
});

test("Fomo published-call Telegram card is concise, bilingual and contains only call actions", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-published-call-card-"));
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.match(String(url), /^https:\/\/api\.telegram\.org\/bot/);
    payloads.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: payloads.length } }),
    };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});

  const observedAt = Date.now();
  const event = publishedCall({
    publishedAt: new Date(observedAt - 5_000).toISOString(),
    observedAt: new Date(observedAt).toISOString(),
    thesis: {
      id: "thesis-1001",
      text: "Accumulating CALL while BSC liquidity is expanding.",
      handle: "alpha",
      createdAt: new Date(observedAt - 5_000).toISOString(),
    },
  });
  const translationHosts = [];
  const result = await sendAlerts({
    ...focusConfig,
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "test-bot-token",
    telegramChatId: "123456789",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertTranslationFetchImpl: async (url) => {
      translationHosts.push(new URL(url).hostname);
      throw new Error("offline translation fixture");
    },
    alertTranslationFallbackUrl: "https://api.mymemory.translated.net/get",
    alertTranslationTimeoutMs: 50,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
  }, event);

  assert.equal(result.status, "delivered");
  assert.equal(payloads.length, 1);
  const payload = payloads[0];
  const text = payload.text;
  assert.match(text, /🔴 强提醒 \| STRONG ALERT/);
  assert.match(text, /🇨🇳 中文/);
  assert.match(text, /🇬🇧 English/);
  assert.match(text, /平台：Fomo/);
  assert.match(text, /英文原文：Accumulating CALL while BSC liquidity is expanding\./);
  assert.match(text, /信号：@alpha 新喊单 · 标的 CALL/);
  assert.match(text, /Platform: Fomo/);
  assert.match(text, /Thesis: Accumulating CALL while BSC liquidity is expanding\./);
  assert.match(text, /Signal: @alpha New call · target CALL/);
  assert.equal(text.match(/@alpha/g)?.length, 2, "the handle appears once in each mirrored change summary");
  assert.match(text, /Accumulating CALL while BSC liquidity is expanding\./);
  assert.match(text, new RegExp(TOKEN, "i"));
  assert.match(text, /callId=thesis-1001/);
  assert.equal(text.match(/英文原文：/g)?.length, 1, "only the Chinese source fact is marked as English original");
  assert.deepEqual(translationHosts, [], "strong-alert delivery must not wait on either translation provider");
  assert.match(text, /Fomo 认证 Feed 发布；安全初筛通过，非买入建议/);
  assert.match(text, /Authenticated Fomo feed; Safety screened; not a buy recommendation/);
  assert.match(text, /时效|延迟|发现|Time:/);
  assert.doesNotMatch(text, /Translation unavailable|Source fact \(translation pending\)/);
  assert.doesNotMatch(text, /首次买入|首仓|零仓位|first buy|zero.position/i);
  assertFomoDisplayLayout(text);

  const buttons = payload.reply_markup.inline_keyboard.flat();
  const buttonLabels = buttons.map((button) => button.text).join(" | ");
  assert.equal(buttons.find((button) => button.copy_text)?.copy_text.text, TOKEN);
  assert.ok(buttons.some((button) => /GMGN/i.test(button.text)));
  assert.ok(buttons.some((button) => /Fomo/i.test(button.text)));
  assert.ok(buttons.some((button) => /𝕏|X/.test(button.text)));
  assert.doesNotMatch(buttonLabels, /复制交易钱包|查看交易/);
});

test("Fomo published-call translation fallback is persisted and retried without wording drift", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-published-call-fallback-retry-"));
  const payloads = [];
  let telegramCalls = 0;
  let translationCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    telegramCalls += 1;
    payloads.push(JSON.parse(options.body));
    if (telegramCalls === 1) return { ok: false, status: 503, text: async () => "temporary" };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: telegramCalls } }),
    };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});

  const observedAt = Date.now();
  const event = publishedCall({
    eventKey: "fomo-published-call:fallback-retry",
    callId: "fallback-retry",
    stableId: "fallback-retry",
    publishedAt: new Date(observedAt - 5_000).toISOString(),
    observedAt: new Date(observedAt).toISOString(),
    thesis: {
      id: "fallback-retry",
      text: "Accumulating CALL while BSC liquidity is expanding.",
      handle: "alpha",
      createdAt: new Date(observedAt - 5_000).toISOString(),
    },
  });
  const config = {
    ...focusConfig,
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "test-bot-token",
    telegramChatId: "123456789",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertTranslationFetchImpl: async () => {
      translationCalls += 1;
      throw new Error("both public translation providers unavailable");
    },
    alertTranslationFallbackUrl: "https://api.mymemory.translated.net/get",
    alertTranslationTimeoutMs: 50,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
  };

  assert.equal((await sendAlerts(config, event)).status, "queued");
  const outboxPath = path.join(dataDir, "alert-outbox.json");
  const outbox = JSON.parse(await fs.readFile(outboxPath, "utf8"));
  const entry = outbox.events[Object.keys(outbox.events)[0]];
  assert.equal(entry.renderBundle.zh.status, "fallback_source");
  assert.equal(entry.renderBundle.zh.provider, "local_structured");
  assert.equal(translationCalls, 0, "critical delivery uses the immediate local fallback");
  assert.match(entry.renderBundle.zh.text, /更新了什么：@alpha 新喊单 · 标的 CALL｜英文原文：Accumulating CALL while BSC liquidity is expanding\./);
  assert.equal(entry.renderBundle.zh.text.match(/原文：/g)?.length, 1);
  const callsAfterRender = translationCalls;
  entry.destinations.telegram.nextAttemptAt = null;
  await fs.writeFile(outboxPath, `${JSON.stringify(outbox, null, 2)}\n`);

  assert.equal((await sendAlerts(config, event)).status, "delivered");
  assert.equal(translationCalls, callsAfterRender, "retry must reuse the persisted fallback bundle");
  assert.equal(telegramCalls, 2);
  assert.equal(payloads[1].text, payloads[0].text, "retry wording must be byte-for-byte stable");
  assert.equal(payloads[1].text.match(/原文：/g)?.length, 1);
  assert.equal(entry.renderBundle.zh.text.split("\n").length, 2);
  assert.equal(entry.renderBundle.en.text.split("\n").length, 2);
  assertFomoDisplayLayout(payloads[1].text);
});

test("all Fomo Telegram retries expire permanently five minutes from reliable source time", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "fomo-telegram-five-minute-ttl-"));
  let telegramCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => {
    telegramCalls += 1;
    throw new Error("simulated Telegram outage");
  });
  t.mock.method(console, "error", () => {});

  const event = publishedCall({
    eventKey: "fomo-published-call:five-minute-ttl",
    callId: "five-minute-ttl",
    stableId: "five-minute-ttl",
  });
  const config = {
    ...focusConfig,
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "test-bot-token",
    telegramChatId: "123456789",
    alertBilingualEnabled: false,
    alertChineseTranslationEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
  };

  const queued = await sendAlerts(config, event);
  assert.equal(queued.status, "queued");
  assert.equal(telegramCalls, 1);
  const outboxPath = path.join(dataDir, "alert-outbox.json");
  const outbox = JSON.parse(await fs.readFile(outboxPath, "utf8"));
  const entry = outbox.events[queued.eventId];
  const sourceAt = new Date(Date.now() - 5 * 60_000 - 1_000).toISOString();
  entry.event.publishedAt = sourceAt;
  entry.event.observedAt = sourceAt;
  entry.event.thesis.createdAt = sourceAt;
  entry.createdAt = new Date().toISOString();
  entry.destinations.telegram.nextAttemptAt = null;
  await fs.writeFile(outboxPath, `${JSON.stringify(outbox)}\n`);

  assert.equal(await drainAlertOutbox(config), 0);
  assert.equal(telegramCalls, 1, "an expired Fomo Telegram retry must never issue another request");
  const expired = JSON.parse(await fs.readFile(outboxPath, "utf8")).events[queued.eventId];
  assert.equal(expired.status, "suppressed");
  assert.equal(expired.destinations.telegram.status, "disabled");
  assert.equal(expired.destinations.telegram.disabledReason, "delivery_ttl_expired");
  assert.equal(expired.destinations.telegram.deliveryTimeBasis, "source_time");
  assert.equal(expired.destinations.telegram.deliveryMaxAgeMs, 5 * 60_000);
  assert.equal(expired.destinations.telegram.nextAttemptAt, null);

  const laterChannel = await sendAlerts(config, linkedXCall({
    eventKey: "fomo-x-call:after-expired-first-source",
    publishedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
  }));
  assert.equal(laterChannel.status, "suppressed");
  assert.equal(laterChannel.reason, "semantic_duplicate");
  assert.equal(telegramCalls, 1, "a later channel cannot revive the token after TTL suppression");
});
