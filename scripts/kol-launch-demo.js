import { fileURLToPath } from "node:url";

import {
  buildBilingualAlertBundle,
  renderBilingualTelegramText,
} from "../src/bilingual-alert-renderer.js";

export const FIXTURE_KOL_CA = `0x${"d3".repeat(18)}cafe`;

const FIXTURE_X_USER_ID = "2999999999999999999";
const FIXTURE_TWEET_ID = "1999999999999999999";
const FIXTURE_HANDLE = "demo_builder_ai";
const SOURCE_OCCURRED_AT = "2026-09-06T08:00:00.000Z";
const OBSERVED_AT = "2026-09-06T08:00:05.000Z";

const RENDER_CONFIG = Object.freeze({
  alertForceLocalStructured: true,
  alertTranslationTimeoutMs: 1,
  alertTranslationUrl: "",
  alertTranslationFallbackUrl: "",
});

export function createKolLaunchFixture() {
  const tweetText = `I launched my fictional demo token $SPARK on BNB Smart Chain. Official CA: ${FIXTURE_KOL_CA}`;
  return {
    type: "fomo_family_top_call",
    signalKind: "kol_self_launch",
    eventKey: `fixture:kol-self-launch:${FIXTURE_X_USER_ID}:${FIXTURE_TWEET_ID}:56:${FIXTURE_KOL_CA}`,
    fixtureOnly: true,
    simulationOnly: true,
    strong: false,
    official: false,
    qualified: false,
    source: {
      id: "kol_launch_demo_fixture",
      name: "Fictional KOL launch fixture",
      trust: "fixture_only",
      url: "demo://kol-launch/x-post",
    },
    sourceTrust: "fixture_only",
    sourceOccurredAt: SOURCE_OCCURRED_AT,
    observedAt: OBSERVED_AT,
    publishedAt: SOURCE_OCCURRED_AT,
    timestamp: SOURCE_OCCURRED_AT,
    caller: {
      handle: FIXTURE_HANDLE,
      xProfileId: FIXTURE_X_USER_ID,
      followers: 128_400,
      followersSyncedAt: "2026-09-06T07:59:30.000Z",
      identitySource: "fxtwitter_public_profile",
      background: {
        status: "self_described",
        text: "独立 AI 产品开发者（虚构 fixture 自述）",
        textZh: "独立 AI 产品开发者（虚构 fixture 自述）",
        textEn: "Independent AI product builder (fictional fixture bio)",
        source: "x_profile_bio_fixture",
        sourceUrl: "demo://kol-launch/x-profile",
        checkedAt: "2026-09-06T07:59:30.000Z",
      },
    },
    handle: FIXTURE_HANDLE,
    tweet: {
      id: FIXTURE_TWEET_ID,
      url: "demo://kol-launch/x-post",
      text: tweetText,
      createdAt: SOURCE_OCCURRED_AT,
      xUserId: FIXTURE_X_USER_ID,
      sourceVerifiedBy: "official_x_oembed",
      fixtureVerification: true,
    },
    body: tweetText,
    token: FIXTURE_KOL_CA,
    contractAddress: FIXTURE_KOL_CA,
    tokenSymbol: "SPARK",
    chainId: 56,
    chain: {
      id: 56,
      chainId: 56,
      name: "BNB Smart Chain",
      slug: "bsc",
      evm: true,
    },
    launchClaim: {
      status: "self_declared",
      explicitIssuerLanguage: true,
      onchainCreatorVerified: false,
      creatorAttribution: "not_onchain_verified",
      creator: null,
      caSource: "post_text",
    },
    market: {
      poolAddress: null,
      poolKind: null,
      liquidityUsd: null,
    },
    security: {
      decision: "unknown",
      summaryZh: "fixture 未读取链上安全、流动性或可卖性证据",
      summaryEn: "fixture did not read onchain security, liquidity, or sellability evidence",
    },
    shadow: {
      decision: "watch",
      executable: false,
      signing: false,
      broadcast: false,
      score: null,
      reasonCodes: [
        "creator_not_onchain_verified",
        "fixture_has_no_live_market_evidence",
      ],
    },
  };
}

function fixtureBaseMessage(event) {
  return [
    "🧪 虚构大V发币模板｜Fixture-only KOL launch template",
    `人物：@${event.caller.handle}｜粉丝 ${event.caller.followers.toLocaleString("en-US")}`,
    `背景：${event.caller.background.text}`,
    `事件：该账号原帖声明发行 $${event.tokenSymbol}`,
    "链：BNB Smart Chain (56)",
    `CA：${event.token}`,
    `原帖：Tweet ${event.tweet.id}｜${event.sourceOccurredAt}`,
  ].join("\n");
}

export async function buildKolLaunchDemo() {
  const event = createKolLaunchFixture();
  const renderBundle = await buildBilingualAlertBundle(
    RENDER_CONFIG,
    event,
    fixtureBaseMessage(event),
  );
  const alertText = renderBilingualTelegramText(renderBundle, false);
  return {
    fixtureOnly: true,
    mode: "watch-only",
    creatorOnchainVerified: false,
    signing: false,
    broadcast: false,
    event,
    renderBundle,
    alertText,
  };
}

async function main() {
  const unknown = process.argv.slice(2).filter((argument) => argument !== "--json");
  if (unknown.length) throw new TypeError(`unsupported argument: ${unknown[0]}`);
  const result = await buildKolLaunchDemo();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  process.stdout.write([
    "🧪 KOL LAUNCH DEMO FIXTURE｜以下人物、粉丝、背景、帖子和 CA 均为虚构数据",
    "",
    result.alertText,
    "",
  ].join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  void main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
