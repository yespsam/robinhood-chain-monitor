import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  alertDeliveryDisposition,
  alertEventKey,
  classifyAlertFreshness,
  isRelevantAlert,
  isStrongAlert,
  sendAlerts,
  telegramButtons,
} from "../src/alerts.js";
import {
  buildBilingualAlertBundle,
  renderBilingualTelegramText,
} from "../src/bilingual-alert-renderer.js";
import {
  KOL_TOKEN_LAUNCH_ALERT_MAX_LINE_LENGTH,
  classifyKolSelfLaunchText,
  kolTokenLaunchCanonicalSignalId,
  kolTokenLaunchCanonicalSignalIds,
  kolTokenLaunchEventKey,
  renderKolTokenLaunchLanguageLines,
  verifyKolTokenLaunchEvent,
} from "../src/kol-token-launch-alert.js";
import {
  CAPITAL_KOL_CATALOG_PUBLISHED_AT,
  createCapitalKolEventSnapshot,
} from "../src/capital-kol-catalog.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";

const CA = "0x1111111111111111111111111111111111111111";
const POOL = "0x2222222222222222222222222222222222222222";
const X_USER_ID = "1888888888888888888";
const TWEET_ID = "1999999999999999999";

function kolLaunchEvent(overrides = {}) {
  const event = {
    type: "fomo_family_top_call",
    signalKind: "kol_self_launch",
    strong: false,
    qualified: false,
    socialClaimVerified: true,
    simulationOnly: true,
    source: {
      id: "fomo_linked_x_post",
      name: "Fomo-linked public X post",
      trust: "public_x_identity_linked",
      url: `https://x.com/alpha_builder/status/${TWEET_ID}`,
    },
    sourceTrust: "public_x_identity_linked",
    caller: {
      handle: "alpha_builder",
      twitter: "https://x.com/alpha_builder",
      xProfileId: X_USER_ID,
      followers: 12_345,
      followersSyncedAt: "2026-09-06T07:59:30.000Z",
      identitySource: "gmgn+fxtwitter",
      background: {
        status: "self_described",
        text: "AI product builder and open-source developer.",
        source: "fxtwitter_public_profile",
        sourceUrl: "https://x.com/alpha_builder",
        observedAt: "2026-09-06T07:59:30.000Z",
      },
    },
    handle: "alpha_builder",
    tweet: {
      id: TWEET_ID,
      url: `https://x.com/alpha_builder/status/${TWEET_ID}`,
      handle: "alpha_builder",
      xUserId: X_USER_ID,
      sourceVerifiedBy: "official_x_oembed",
      text: `I just launched my token on BNB Smart Chain. CA ${CA}`,
      createdAt: "2026-09-06T08:00:00.000Z",
    },
    body: `I just launched my token on BNB Smart Chain. CA ${CA}`,
    publishedAt: "2026-09-06T08:00:00.000Z",
    observedAt: "2026-09-06T08:00:05.000Z",
    chain: { id: 56, chainId: 56, name: "BNB Smart Chain", slug: "bsc", gmgn: "bsc" },
    token: CA,
    contractAddress: CA,
    tokenSymbol: "ALPHA",
    explorerUrl: `https://bscscan.com/token/${CA}`,
    launchClaim: {
      status: "self_declared",
      explicitIssuerLanguage: true,
      onchainCreatorVerified: false,
      caSource: "official_x_oembed",
      chainVerification: "declared_only",
      chainSource: "declared_bsc_in_x_post",
    },
    market: { poolAddress: POOL, poolKind: "v2", liquidityUsd: 12_345 },
    security: {
      decision: "watch",
      summaryZh: "池存在；持仓、LP 与可卖性仍待完整核验",
      summaryEn: "pool exists; holder, LP and sellability checks remain incomplete",
    },
    shadow: {
      decision: "watch",
      executable: false,
      reasonCodes: ["creator_not_onchain_verified", "holder_lp_cluster_coverage_incomplete"],
    },
    ...overrides,
  };
  event.eventKey = kolTokenLaunchEventKey(event);
  return event;
}

test("self-launch classifier rejects quotation, denial, historical, service and cross-chain claims", () => {
  const rejected = [
    `“I just launched my token on BSC today. CA ${CA}” — @alice`,
    `要是我刚发了一个币，今天在 BNB链 上线，CA ${CA} 就好了`,
    `“I just launched my token on BSC today. CA ${CA}” is a lie.`,
    `Old post: I just launched my token on BSC. Today I am only archiving it. CA ${CA}`,
    `As a contractor, I just deployed token for Acme today on BSC. CA ${CA}`,
    `As an agency, we just launched token for our client today on BSC. CA ${CA}`,
    `作为代发服务商，我们刚发了一个币，今天在 BNB链 上线，CA ${CA}，属于客户项目`,
    `I just launched my token today on TON; BSC support comes next. CA ${CA}`,
    `我刚发了一个币，今天在 BNB链 上线。不要使用这个合约地址: ${CA}`,
    `CZ said: "I just launched my token on BSC today. CA ${CA}"`,
  ];
  for (const text of rejected) {
    assert.equal(classifyKolSelfLaunchText(text).relevant, false, text);
  }
  assert.deepEqual(classifyKolSelfLaunchText(
    `I just launched my token today on BNB Smart Chain. CA ${CA}`,
  ), {
    relevant: true,
    launchLanguage: true,
    reason: "self_declared_launch_with_exact_contract",
    token: CA,
  });
  for (const text of [
    `我刚发了一个币，今天在 BNB链 上线，CA: ${CA}`,
    `我刚发行了一个代币，在 BSC 上线。合约地址：${CA}`,
    `我今日发行了一枚新代币，于币安智能链正式上线。官方合约地址是 ${CA}`,
    `我刚发币，在 BNB链 上线。CA: ${CA}`,
  ]) {
    assert.equal(classifyKolSelfLaunchText(text).relevant, true, text);
  }
});

test("reviewed capital people bypass follower thresholds only with exact catalog and runtime binding", () => {
  const base = kolLaunchEvent();
  const snapshot = createCapitalKolEventSnapshot("VitalikButerin");
  const catalogPublishedMs = Date.parse(CAPITAL_KOL_CATALOG_PUBLISHED_AT);
  const bindingAt = new Date(catalogPublishedMs + 30_000).toISOString();
  const tweetAt = new Date(catalogPublishedMs + 60_000).toISOString();
  const observedAt = new Date(catalogPublishedMs + 65_000).toISOString();
  const binding = {
    handle: "VitalikButerin",
    xUserId: "295218901",
    source: "fxtwitter_public_profile",
    observedAt: bindingAt,
  };
  const officialRole = snapshot.backgroundEvidence.find((item) => item.kind === "official_role");
  const event = kolLaunchEvent({
    caller: {
      ...base.caller,
      handle: "VitalikButerin",
      twitter: "https://x.com/VitalikButerin",
      xProfileId: "295218901",
      followers: 0,
      followersSyncedAt: bindingAt,
      identitySource: "reviewed_catalog+fxtwitter",
      capitalKolBinding: binding,
      capitalKolSnapshot: snapshot,
      background: {
        status: "primary_verified",
        text: snapshot.background.zh,
        textZh: snapshot.background.zh,
        textEn: snapshot.background.en,
        source: "reviewed_capital_person_catalog",
        sourceUrl: officialRole.url,
        observedAt: binding.observedAt,
        checkedAt: officialRole.checkedAt,
        catalogVersion: snapshot.catalogVersion,
        catalogHash: snapshot.catalogHash,
      },
    },
    handle: "VitalikButerin",
    tweet: {
      ...base.tweet,
      handle: "VitalikButerin",
      xUserId: "295218901",
      authorId: "295218901",
      url: `https://x.com/VitalikButerin/status/${TWEET_ID}`,
      createdAt: tweetAt,
    },
    publishedAt: tweetAt,
    observedAt,
    source: { ...base.source, url: `https://x.com/VitalikButerin/status/${TWEET_ID}` },
    capitalKolBinding: binding,
    capitalKolSnapshot: snapshot,
  });
  event.eventKey = kolTokenLaunchEventKey(event);

  assert.equal(verifyKolTokenLaunchEvent(event).valid, true,
    verifyKolTokenLaunchEvent(event).reasons.join(","));
  const enabled = {
    kolLaunchMonitorEnabled: true,
    kolCapitalRosterEnabled: true,
    kolCapitalCategories: [],
    kolLaunchMinXFollowers: 10_000_000,
  };
  assert.equal(isMonitoringSourceEnabled(enabled, event), true);
  assert.equal(isMonitoringSourceEnabled({ ...enabled, kolCapitalRosterEnabled: false }, event), false);
  assert.equal(isMonitoringSourceEnabled({ ...enabled, kolCapitalCategories: ["web2_ai"] }, event), false);
  const tampered = structuredClone(event);
  tampered.caller.capitalKolBinding.xUserId = "1605";
  assert.equal(verifyKolTokenLaunchEvent(tampered).valid, false);
  assert.equal(isMonitoringSourceEnabled(enabled, tampered), false);
  const conflictingSnapshot = structuredClone(event);
  conflictingSnapshot.caller.capitalKolSnapshot.category = "web2_ai";
  assert.equal(verifyKolTokenLaunchEvent(conflictingSnapshot).valid, false);
  assert.equal(isMonitoringSourceEnabled(enabled, conflictingSnapshot), false);

  const spoofedCatalogIdentity = kolLaunchEvent({
    caller: { ...base.caller, identitySource: "reviewed_catalog+fxtwitter" },
  });
  spoofedCatalogIdentity.eventKey = kolTokenLaunchEventKey(spoofedCatalogIdentity);
  assert.equal(verifyKolTokenLaunchEvent(spoofedCatalogIdentity).valid, false);
  assert.equal(isMonitoringSourceEnabled(enabled, spoofedCatalogIdentity), false);

  for (const followers of [undefined, -1]) {
    const invalidFollowers = structuredClone(event);
    if (followers === undefined) delete invalidFollowers.caller.followers;
    else invalidFollowers.caller.followers = followers;
    assert.equal(verifyKolTokenLaunchEvent(invalidFollowers).valid, false);
    assert.equal(isMonitoringSourceEnabled(enabled, invalidFollowers), false);
  }
  const staleFollowers = structuredClone(event);
  staleFollowers.caller.followersSyncedAt = "2026-09-01T00:00:00.000Z";
  assert.equal(verifyKolTokenLaunchEvent(staleFollowers).valid, false);
  assert.equal(isMonitoringSourceEnabled(enabled, staleFollowers), false);

  const [zhBackground] = renderKolTokenLaunchLanguageLines(event, "zh").slice(1, 2);
  const [enBackground] = renderKolTokenLaunchLanguageLines(event, "en").slice(1, 2);
  assert.match(zhBackground, new RegExp(snapshot.background.zh.slice(0, 12), "u"));
  assert.match(enBackground, new RegExp(snapshot.background.en.slice(0, 12), "u"));
});

test("KOL self-launch gate admits exact public-X evidence only as watch-only", () => {
  const event = kolLaunchEvent();
  const integrity = verifyKolTokenLaunchEvent(event);
  assert.equal(integrity.valid, true, integrity.reasons.join(","));
  assert.equal(isMonitoringSourceEnabled({ kolLaunchMonitorEnabled: true }, event), true);
  assert.equal(isMonitoringSourceEnabled({ kolLaunchMonitorEnabled: false }, event), false);
  assert.equal(isMonitoringSourceEnabled({ fomoCallEnabled: false, kolLaunchMonitorEnabled: true }, event), false);
  assert.equal(isRelevantAlert(event), true);
  assert.equal(isStrongAlert(event), false);
  assert.equal(isStrongAlert({ ...event, strong: true, tradingPriority: { tier: "T0" } }), false);
  assert.equal(alertEventKey(event), `kol-self-launch:${X_USER_ID}:${TWEET_ID}:56:${CA}`);

  const freshness = classifyAlertFreshness({}, event, Date.parse(event.observedAt));
  assert.equal(freshness.scope, "kol_self_launch");
  assert.equal(freshness.basis, "tweet.createdAt");
  assert.equal(freshness.decision, "realtime");
  assert.deepEqual(alertDeliveryDisposition({ ...event, freshness }), {
    mode: "immediate",
    deliverImmediately: true,
    tier: null,
    reason: "kol_self_launch_watch_only",
  });
});

test("followers are a roster eligibility boundary only, never a signal score or identity", () => {
  const belowRosterMinimum = kolLaunchEvent({
    caller: { ...kolLaunchEvent().caller, followers: 7 },
  });
  belowRosterMinimum.eventKey = kolTokenLaunchEventKey(belowRosterMinimum);
  const aboveRosterMinimum = kolLaunchEvent({
    caller: { ...kolLaunchEvent().caller, followers: 2_000_000 },
  });
  aboveRosterMinimum.eventKey = kolTokenLaunchEventKey(aboveRosterMinimum);

  assert.equal(verifyKolTokenLaunchEvent(belowRosterMinimum).valid, true);
  assert.equal(isMonitoringSourceEnabled({ kolLaunchMonitorEnabled: true }, belowRosterMinimum), false);
  assert.equal(isMonitoringSourceEnabled({
    kolLaunchMonitorEnabled: true,
    kolLaunchMinXFollowers: 0,
  }, belowRosterMinimum), true);
  assert.equal(isStrongAlert(aboveRosterMinimum), false);
  assert.equal(kolTokenLaunchEventKey(belowRosterMinimum), kolTokenLaunchEventKey(aboveRosterMinimum));
  assert.equal(kolTokenLaunchCanonicalSignalId(belowRosterMinimum), kolTokenLaunchCanonicalSignalId(aboveRosterMinimum));
  assert.equal(belowRosterMinimum.shadow.score, undefined);
  assert.equal(aboveRosterMinimum.shadow.score, undefined);
});

test("dedup identity uses numeric X ID, chain and CA—not followers or handle", () => {
  const lowFollowers = kolLaunchEvent();
  const renamedHighFollowers = kolLaunchEvent({
    caller: {
      ...kolLaunchEvent().caller,
      handle: "renamed_builder",
      twitter: "https://x.com/renamed_builder",
      followers: 9_000_000,
      background: {
        ...kolLaunchEvent().caller.background,
        sourceUrl: "https://x.com/renamed_builder",
      },
    },
    handle: "renamed_builder",
    tweet: {
      ...kolLaunchEvent().tweet,
      handle: "renamed_builder",
      url: `https://x.com/renamed_builder/status/${TWEET_ID}`,
    },
    source: {
      ...kolLaunchEvent().source,
      url: `https://x.com/renamed_builder/status/${TWEET_ID}`,
    },
  });
  renamedHighFollowers.eventKey = kolTokenLaunchEventKey(renamedHighFollowers);

  assert.equal(verifyKolTokenLaunchEvent(lowFollowers).valid, true);
  assert.equal(verifyKolTokenLaunchEvent(renamedHighFollowers).valid, true);
  assert.equal(kolTokenLaunchEventKey(lowFollowers), kolTokenLaunchEventKey(renamedHighFollowers));
  assert.equal(kolTokenLaunchCanonicalSignalId(lowFollowers), kolTokenLaunchCanonicalSignalId(renamedHighFollowers));
  assert.deepEqual(kolTokenLaunchCanonicalSignalIds(lowFollowers), [
    `kol:token-launch:56:${CA}:x:${X_USER_ID}`,
    `kol:token-launch:56:${CA}:x:${X_USER_ID}:self-declared`,
  ]);
});

test("dedicated Telegram card is exactly six bounded fact lines per language", async () => {
  const event = kolLaunchEvent();
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => assert.fail("dedicated KOL rendering must not call a translator"),
  }, event, "ignored generic fallback");
  assert.equal(bundle.format, "telegram_zh_en_kol_launch_v3");
  assert.equal(bundle.zh.provider, "local_structured");
  assert.equal(bundle.en.provider, "local_structured");

  for (const language of ["zh", "en"]) {
    const lines = bundle[language].text.split("\n");
    assert.equal(lines.length, 6);
    assert.ok(lines.every((value) => value.length <= KOL_TOKEN_LAUNCH_ALERT_MAX_LINE_LENGTH));
    assert.ok(lines.some((value) => value.includes(X_USER_ID)));
    assert.ok(lines.some((value) => value.includes(TWEET_ID)));
    assert.ok(lines.some((value) => value.includes(CA)));
    assert.ok(lines.some((value) => value.includes(POOL)));
  }

  const telegram = renderBilingualTelegramText(bundle, true);
  assert.match(telegram, /^📣 大V发币 \| KOL TOKEN LAUNCH/u);
  assert.equal(telegram.split("\n").length, 16);
  assert.match(telegram, new RegExp(`CA：${CA}`, "u"));
  assert.match(telegram, /事件：该账号原帖声明发行 \$ALPHA/u);
  assert.doesNotMatch(telegram, /风险|Risk|UNKNOWN|creator|不可执行|not executable|不签名|no signing|粉丝数不参与|followers are not scored|watch-only/iu);

  const bounded = kolLaunchEvent({
    caller: {
      ...event.caller,
      handle: "123456789012345",
      twitter: "https://x.com/123456789012345",
      background: {
        ...event.caller.background,
        text: "A very long sourced profile description ".repeat(20),
        sourceUrl: "https://x.com/123456789012345",
      },
    },
    handle: "123456789012345",
    tweet: {
      ...event.tweet,
      handle: "123456789012345",
      url: `https://x.com/123456789012345/status/${TWEET_ID}`,
    },
    source: {
      ...event.source,
      url: `https://x.com/123456789012345/status/${TWEET_ID}`,
    },
    security: {
      ...event.security,
      summaryZh: "很长的安全说明".repeat(30),
      summaryEn: "a very long security explanation ".repeat(30),
    },
  });
  for (const language of ["zh", "en"]) {
    assert.ok(renderKolTokenLaunchLanguageLines(bounded, language)
      .every((value) => value.length <= KOL_TOKEN_LAUNCH_ALERT_MAX_LINE_LENGTH));
  }
});

test("missing pool data stays concise instead of being invented as zero", () => {
  const event = kolLaunchEvent({
    market: { poolAddress: null, poolKind: null, liquidityUsd: null },
    security: { decision: "unknown" },
  });
  const zh = renderKolTokenLaunchLanguageLines(event, "zh").join("\n");
  const en = renderKolTokenLaunchLanguageLines(event, "en").join("\n");
  assert.match(zh, /底池\/流动性：当前仅有代币 CA；无底池地址及流动性数值/u);
  assert.match(en, /Pool\/Liquidity: Token CA only; no pool address or liquidity value/u);
  assert.doesNotMatch(`${zh}\n${en}`, /\$0(?:\.00)?/u);

  const zeroPool = kolLaunchEvent({
    market: { poolAddress: "0x0000000000000000000000000000000000000000", liquidityUsd: null },
  });
  assert.match(renderKolTokenLaunchLanguageLines(zeroPool, "en").join("\n"), /Pool\/Liquidity: Token CA only; no pool address or liquidity value/u);
});

test("strict rejection matrix blocks attribution, execution, scoring and identity drift", () => {
  const base = kolLaunchEvent();
  const rejected = [
    {
      ...base,
      tweet: { ...base.tweet, text: `Token is live. CA ${CA}` },
      body: `Token is live. CA ${CA}`,
    },
    { ...base, launchClaim: { ...base.launchClaim, explicitIssuerLanguage: false } },
    { ...base, launchClaim: { ...base.launchClaim, caSource: "post_text" } },
    { ...base, launchClaim: { ...base.launchClaim, onchainCreatorVerified: true, creator: POOL } },
    { ...base, shadow: { ...base.shadow, decision: "do", executable: true } },
    { ...base, shadow: { ...base.shadow, score: base.caller.followers } },
    { ...base, strong: true },
    { ...base, handle: "impostor" },
    { ...base, caller: { ...base.caller, xUserId: "1777777777777777777" } },
    { ...base, tweet: { ...base.tweet, xUserId: "1777777777777777777" } },
    { ...base, tweet: { ...base.tweet, authorId: "1777777777777777777" } },
    { ...base, chainId: 1 },
    {
      ...base,
      sourceOccurredAt: base.publishedAt,
      tweet: { ...base.tweet, createdAt: "2020-01-01T00:00:00.000Z" },
    },
    {
      ...base,
      caller: {
        ...base.caller,
        background: { ...base.caller.background, sourceUrl: "https://evil.example/profile" },
      },
    },
    { ...base, explorerUrl: `https://evil.example/token/${CA}` },
    {
      ...base,
      market: { ...base.market, poolAddress: "0x0000000000000000000000000000000000000000" },
    },
    { ...base, tweet: { ...base.tweet, text: `${base.tweet.text} and 0x3333333333333333333333333333333333333333` } },
    { ...base, eventKey: `${base.eventKey}:tampered` },
    {
      ...base,
      token: "0x0000000000000000000000000000000000000000",
      contractAddress: "0x0000000000000000000000000000000000000000",
      tweet: {
        ...base.tweet,
        text: "I just launched my token on BNB Smart Chain. CA 0x0000000000000000000000000000000000000000",
      },
      eventKey: null,
    },
  ];
  for (const event of rejected) {
    assert.equal(verifyKolTokenLaunchEvent(event).valid, false);
    assert.equal(isRelevantAlert(event), false);
  }
  const zeroCa = rejected.at(-1);
  assert.equal(kolTokenLaunchEventKey(zeroCa), null);
  assert.equal(kolTokenLaunchCanonicalSignalId(zeroCa), null);
  assert.deepEqual(kolTokenLaunchCanonicalSignalIds(zeroCa), []);

  for (const event of rejected) {
    assert.deepEqual(telegramButtons(event), { inline_keyboard: [] });
  }
});

test("buttons expose the declaration and contract, never the unrelated discovery wallet", () => {
  const event = kolLaunchEvent({ walletAddress: "0x4444444444444444444444444444444444444444" });
  const buttons = telegramButtons(event).inline_keyboard.flat();
  assert.ok(buttons.some((button) => button.copy_text?.text === CA));
  assert.ok(buttons.some((button) => button.url === event.tweet.url));
  assert.ok(buttons.some((button) => button.url === event.explorerUrl));
  assert.ok(buttons.some((button) => button.url === event.caller.background.sourceUrl));
  assert.ok(!buttons.some((button) => button.copy_text?.text === event.walletAddress),
    "the discovery wallet is not the unverified token creator");
});

test("sendAlerts forces the bilingual watch card and folds a later same-KOL same-CA post", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-kol-self-launch-"));
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
  const event = kolLaunchEvent();
  const config = {
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "test-bot-token",
    telegramChatId: "123456789",
    telegramStrongAlerts: true,
    alertBilingualEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
    kolLaunchMonitorEnabled: true,
    fomoXCallMinXFollowers: 10_000,
    alertNow: () => Date.parse(event.observedAt),
  };

  const first = await sendAlerts(config, event);
  assert.equal(first.status, "delivered");
  assert.equal(payloads.length, 1);
  assert.match(payloads[0].text, /^📣 大V发币 \| KOL TOKEN LAUNCH/u);
  assert.match(payloads[0].text, new RegExp(`CA：${CA}`, "u"));
  assert.doesNotMatch(payloads[0].text, /风险|Risk|UNKNOWN|creator|不可执行|not executable|不签名|no signing|粉丝数不参与|followers are not scored|watch-only/iu);
  assert.equal(payloads[0].text.split("\n").length, 16);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.events[first.eventId].renderBundle.format, "telegram_zh_en_kol_launch_v3");

  const laterTweetId = "2000000000000000000";
  const repeatedClaim = kolLaunchEvent({
    tweet: {
      ...event.tweet,
      id: laterTweetId,
      url: `https://x.com/alpha_builder/status/${laterTweetId}`,
    },
    callId: laterTweetId,
    stableId: laterTweetId,
    source: {
      ...event.source,
      url: `https://x.com/alpha_builder/status/${laterTweetId}`,
    },
  });
  repeatedClaim.eventKey = kolTokenLaunchEventKey(repeatedClaim);
  const repeated = await sendAlerts(config, repeatedClaim);
  assert.equal(repeated.status, "suppressed");
  assert.equal(repeated.reason, "semantic_duplicate");
  assert.equal(payloads.length, 1);
});
