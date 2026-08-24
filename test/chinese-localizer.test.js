import test from "node:test";
import assert from "node:assert/strict";
import {
  clearTranslationCache,
  localizeAlertEvent,
  translateNarrativeToChinese,
} from "../src/chinese-localizer.js";

function googleResponse(translated) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify([[[translated, "source"]], null, "en"]),
  };
}

test("English narrative becomes concise Chinese without changing project names, CA, links, or function names", async () => {
  clearTranslationCache();
  const address = "0x1111111111111111111111111111111111111111";
  const link = "https://docs.example/new-mode";
  let requestedText = "";
  const result = await translateNarrativeToChinese(
    `We shipped Four.Meme swapExactTokens() for ${address}. Docs: ${link}`,
    {
      protectedTerms: ["Four.Meme"],
      fetchImpl: async (url) => {
        requestedText = new URL(url).searchParams.get("q");
        return googleResponse(requestedText
          .replace("We shipped", "我们已发布")
          .replace(" for ", "，用于 ")
          .replace("Docs:", "文档："));
      },
    },
  );

  assert.equal(result.status, "translated");
  assert.match(result.text, /我们已发布/);
  assert.match(requestedText, /ZXQKEEP[A-Z]+QXZ/);
  assert.match(result.text, /Four\.Meme/);
  assert.match(result.text, /swapExactTokens\(\)/);
  assert.match(result.text, new RegExp(address));
  assert.match(result.text, /https:\/\/docs\.example\/new-mode/);
  assert.doesNotMatch(result.text, /ZXQKEEP[A-Z]+QXZ/);
});

test("translation failure keeps a marked, shortened English source and its critical literals", async () => {
  clearTranslationCache();
  const address = "0x2222222222222222222222222222222222222222";
  const link = "https://example.com/release";
  const result = await translateNarrativeToChinese(
    `This is a deliberately long release explanation with several secondary details that can be shortened safely before delivery. executeLaunch() ${address} ${link}`,
    {
      fallbackLength: 64,
      fetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    },
  );

  assert.equal(result.status, "fallback_english");
  assert.match(result.text, /^翻译暂不可用：/);
  assert.match(result.text, /executeLaunch/);
  assert.match(result.text, new RegExp(address));
  assert.match(result.text, /https:\/\/example\.com\/release/);
  assert.ok(result.text.length < 220);
});

test("Chinese source bypasses the network", async () => {
  clearTranslationCache();
  let calls = 0;
  const result = await translateNarrativeToChinese("已上线新的发射模式", {
    fetchImpl: async () => { calls += 1; return googleResponse("不应调用"); },
  });
  assert.equal(result.status, "not_needed");
  assert.equal(result.text, "已上线新的发射模式");
  assert.equal(calls, 0);
});

test("a single English action word is translated while a protected project name alone is not", async () => {
  clearTranslationCache();
  let calls = 0;
  const translated = await translateNarrativeToChinese("Launch", {
    fetchImpl: async () => { calls += 1; return googleResponse("发射"); },
  });
  const projectOnly = await translateNarrativeToChinese("Four.Meme", {
    protectedTerms: ["Four.Meme"],
    fetchImpl: async () => { calls += 1; return googleResponse("不应调用"); },
  });
  assert.equal(translated.text, "发射");
  assert.equal(projectOnly.status, "not_needed");
  assert.equal(calls, 1);
});

test("only user-visible narrative fields are localized and the raw event is not mutated", async () => {
  clearTranslationCache();
  const event = {
    type: "twitter_update",
    project: { id: "flap", name: "Flap" },
    tweet: {
      id: "123",
      handle: "flapdotsh",
      text: "Flap launches a new bonding curve mode",
      url: "https://x.com/flapdotsh/status/123",
      expandedUrls: ["https://docs.flap.sh/mode"],
    },
    signal: { labels: ["新发射/新模式"] },
  };
  const config = {
    alertChineseTranslationEnabled: true,
    alertTranslationTimeoutMs: 1_800,
    alertTranslationUrl: "https://translate.googleapis.com/translate_a/single",
    alertTranslationFetchImpl: async (url) => {
      const source = new URL(url).searchParams.get("q");
      return googleResponse(source.replace("launches a new bonding curve mode", "上线新的联合曲线模式"));
    },
  };
  const localized = await localizeAlertEvent(config, event);

  assert.equal(event.tweet.text, "Flap launches a new bonding curve mode");
  assert.equal(localized.tweet.text, "Flap 上线新的联合曲线模式");
  assert.equal(localized.tweet.url, event.tweet.url);
  assert.deepEqual(localized.tweet.expandedUrls, event.tweet.expandedUrls);
  assert.deepEqual(localized.signal, event.signal);
});

test("GitHub, Binance, Uniswap, AI, and official template narratives use the same localization gate", async () => {
  clearTranslationCache();
  const config = {
    alertChineseTranslationEnabled: true,
    alertTranslationFetchImpl: async (url) => googleResponse(`中文：${new URL(url).searchParams.get("q")}`),
  };
  const events = [
    { type: "github_module_update", launchpad: "Flap", message: "Add a new vault module", repository: "flap-sh/contracts" },
    { type: "binance_official_update", kind: "announcement", project: { name: "Binance Wallet" }, title: "Binance Wallet introduces a launch API" },
    { type: "bsc_launchpad_update", mode: { selector: "official-template", template: { description: "A fair launch with revenue sharing" } } },
    { type: "uniswap_official_update", title: "Liquidity Launcher release", summary: "Adds a new instant launch strategy" },
    { type: "ai_official_update", title: "Grok Bot is available", summary: "Adds persistent agents and connectors" },
  ];
  const localized = await Promise.all(events.map((event) => localizeAlertEvent(config, event)));

  assert.match(localized[0].message, /^中文：/);
  assert.match(localized[1].title, /^中文：/);
  assert.match(localized[2].mode.template.description, /^中文：/);
  assert.match(localized[3].title, /^中文：/);
  assert.match(localized[3].summary, /^中文：/);
  assert.match(localized[4].title, /^中文：/);
  assert.match(localized[4].summary, /^中文：/);
  assert.equal(events[2].mode.template.description, "A fair launch with revenue sharing");
});

test("X key changes and repository purpose are localized without changing the evidence event", async () => {
  clearTranslationCache();
  const config = {
    alertChineseTranslationEnabled: true,
    alertTranslationFetchImpl: async (url) => {
      const source = new URL(url).searchParams.get("q");
      return googleResponse(`中文：${source}`);
    },
  };
  const twitter = {
    type: "twitter_update",
    project: { id: "fourmeme", name: "Four.Meme" },
    tweet: { text: "Royalty is now live with new creator tools" },
    signal: { headline: "Royalty is now live", keyChanges: ["Adds a buyback vault", "Supports custom royalty templates"] },
  };
  const repository = {
    type: "github_repository_discovered",
    launchpad: "Uniswap",
    repository: "Uniswap/liquidity-launcher-v2",
    repositoryMetadata: { description: "Contracts and SDK for a new liquidity launcher" },
  };

  const [localizedTwitter, localizedRepository] = await Promise.all([
    localizeAlertEvent(config, twitter),
    localizeAlertEvent(config, repository),
  ]);
  assert.match(localizedTwitter.signal.headline, /^中文：/);
  assert.ok(localizedTwitter.signal.keyChanges.every((value) => value.startsWith("中文：")));
  assert.match(localizedRepository.repositoryMetadata.description, /^中文：/);
  assert.deepEqual(twitter.signal.keyChanges, ["Adds a buyback vault", "Supports custom royalty templates"]);
  assert.equal(twitter.signal.headline, "Royalty is now live");
  assert.equal(repository.repositoryMetadata.description, "Contracts and SDK for a new liquidity launcher");
});

test("successful translations are cached for repeated alert text", async () => {
  clearTranslationCache();
  let calls = 0;
  const options = {
    endpoint: "https://translate.googleapis.com/translate_a/single",
    fetchImpl: async (url) => {
      calls += 1;
      return googleResponse(`中文：${new URL(url).searchParams.get("q")}`);
    },
  };
  const first = await translateNarrativeToChinese("Launch a new liquidity module", options);
  const second = await translateNarrativeToChinese("Launch a new liquidity module", options);
  assert.equal(first.status, "translated");
  assert.equal(second.status, "translated_cached");
  assert.equal(first.text, second.text);
  assert.equal(calls, 1);
});

test("Fomo thesis is localized without changing technical identifiers, versions, CA, or thesis metadata", async () => {
  clearTranslationCache();
  const address = "0x3333333333333333333333333333333333333333";
  const event = {
    type: "fomo_family_top_call",
    platform: { id: "fomo", name: "fomo.family" },
    launchpad: { id: "fourmeme", name: "Four.Meme" },
    chain: { name: "BSC" },
    tokenSymbol: "MEME",
    caller: { handle: "alpha" },
    thesis: {
      text: `Watching Four.Meme BondingCurveV2 on BSC after deployToken() at ${address}`,
      handle: "alpha",
      likes: 7,
    },
  };
  let requested = "";
  const localized = await localizeAlertEvent({
    alertChineseTranslationEnabled: true,
    alertTranslationFetchImpl: async (url) => {
      requested = new URL(url).searchParams.get("q");
      return googleResponse(requested
        .replace("Watching", "正在关注")
        .replace(" on ", "，位于 ")
        .replace(" after ", "，发生在 ")
        .replace(" at ", "，地址 "));
    },
  }, event);

  assert.match(localized.thesis.text, /正在关注/);
  assert.match(localized.thesis.text, /Four\.Meme/);
  assert.match(localized.thesis.text, /BondingCurveV2/);
  assert.match(localized.thesis.text, /BSC/);
  assert.match(localized.thesis.text, /deployToken\(\)/);
  assert.match(localized.thesis.text, new RegExp(address));
  assert.match(requested, /ZXQKEEP[A-Z]+QXZ/);
  assert.equal(localized.thesis.handle, "alpha");
  assert.equal(localized.thesis.likes, 7);
  assert.equal(event.thesis.text.startsWith("Watching"), true);
});

test("site launchpad model is localized while compound identifiers and versions stay exact", async () => {
  clearTranslationCache();
  const event = {
    type: "launchpad_site_update",
    launchpad: {
      id: "flap",
      name: "Flap",
      model: "Portal/VaultPortal standard and tax-token modes for V2",
      website: "https://flap.sh",
    },
  };
  const localized = await localizeAlertEvent({
    alertChineseTranslationEnabled: true,
    alertTranslationFetchImpl: async (url) => {
      const source = new URL(url).searchParams.get("q");
      return googleResponse(source
        .replace("standard and tax-token modes for", "标准与税费代币模式，适用于"));
    },
  }, event);

  assert.equal(localized.launchpad.model, "Portal/VaultPortal 标准与税费代币模式，适用于 V2");
  assert.equal(localized.launchpad.website, "https://flap.sh");
  assert.equal(event.launchpad.model, "Portal/VaultPortal standard and tax-token modes for V2");
});
