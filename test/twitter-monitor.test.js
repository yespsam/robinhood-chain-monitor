import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OFFICIAL_TWITTER_TARGETS, atomicWriteTwitterState, classifyAiOfficialText, classifyBinanceCriticalProductText, classifyFocusLaunchpadText, classifyFourMemeOfficialText, classifyPonFunOfficialText, classifyTweet, classifyTwitterAlertDelivery, classifyUniswapOfficialText, createTwitterMonitor, parseCriticalXDirectDiscovery, parseFxTwitterExactStatus, parseFxTwitterTimeline, parseJinaReaderPayload, parseOfficialXOembed, parseTimelineHtml, twitterHandle, twitterStateControlKey } from "../src/twitter-monitor.js";

function timelineHtml(handle, tweets = []) {
  const entries = tweets.map((tweet) => ({
    type: "tweet",
    entry_id: `tweet-${tweet.id}`,
    content: {
      tweet: {
        id_str: tweet.id,
        full_text: tweet.text,
        created_at: tweet.createdAt || null,
        favorite_count: 0,
        retweet_count: 0,
        reply_count: 0,
        ...(tweet.permalink ? { permalink: tweet.permalink } : {}),
        ...(tweet.expandedUrl ? { entities: { urls: [{ url: "https://t.co/source", expanded_url: tweet.expandedUrl }] } } : {}),
        user: {
          name: handle,
          screen_name: tweet.authorHandle || handle,
          ...(tweet.authorId ? { id_str: tweet.authorId } : {}),
        },
      },
    },
  }));
  const payload = { props: { pageProps: { timeline: { entries } } } };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
}

function directTimelineHtml(handle, userId, tweets = []) {
  const publishedAt = (id) => new Date(Number((BigInt(id) >> 22n) + 1_288_834_974_657n)).toISOString();
  const person = (itemProp) => `<div itemProp="${itemProp}" itemScope itemType="https://schema.org/Person">
    <meta content="${userId}" itemProp="identifier"><meta content="${handle}" itemProp="alternateName">
    <meta content="https://x.com/${handle}" itemProp="url"><meta content="${handle}" itemProp="name">
  </div>`;
  const posts = tweets.map((tweet) => `<article data-tweet-id="${tweet.id}" itemID="https://x.com/i/status/${tweet.id}" itemScope itemProp="hasPart" itemType="https://schema.org/SocialMediaPosting">
    <meta content="${tweet.id}" itemProp="identifier"><meta content="${publishedAt(tweet.id)}" itemProp="datePublished">
    <meta content="https://x.com/${handle}/status/${tweet.id}" itemProp="url"><meta content="${tweet.text}" itemProp="articleBody">
    ${person("author")}
  </article>`).join("");
  return `<!doctype html><html><head><link rel="canonical" href="https://x.com/${handle}"></head><body>
    <div itemScope itemType="https://schema.org/ProfilePage">${person("mainEntity")}<ul>${posts}</ul></div>
  </body></html>`;
}

function response({ handle = "account", tweets = [], status = 200, retryAfter = null, rateLimitReset = null } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name) => name.toLowerCase() === "retry-after"
        ? retryAfter
        : name.toLowerCase() === "x-rate-limit-reset" ? rateLimitReset : null,
    },
    text: async () => timelineHtml(handle, tweets),
  };
}

function textResponse(body, status = 200) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: () => null },
    text: async () => typeof body === "string" ? body : JSON.stringify(body),
  };
}

function binanceCriticalFetch(agentOsFixture, requests = []) {
  const walletId = "2090379000000000000";
  const walletTimeline = {
    code: 200,
    results: [{
      id: walletId,
      text: "A look back at this week's Binance Wallet community posts.",
      created_timestamp: 1787220165,
      author: { id: "1400391752368992260", name: "Binance Wallet", screen_name: "BinanceWallet" },
      url: `https://x.com/BinanceWallet/status/${walletId}`,
      replying_to: null,
      replies: 0,
      reposts: 0,
      likes: 0,
    }],
  };
  return async (url) => {
    requests.push(String(url));
    if (String(url).includes("/2/profile/id:877807935493033984/statuses")) return textResponse(agentOsFixture.timeline);
    if (String(url).includes("/2/profile/id:1400391752368992260/statuses")) return textResponse(walletTimeline);
    if (String(url).startsWith("https://publish.x.com/oembed")) {
      const requested = new URL(url).searchParams.get("url");
      if (requested?.endsWith(`/status/${agentOsFixture.timeline.results[0].id}`)) return textResponse(agentOsFixture.oembed);
      if (requested?.endsWith(`/status/${walletId}`)) {
        return textResponse({
          url: `https://x.com/BinanceWallet/status/${walletId}`,
          author_url: "https://x.com/BinanceWallet",
          html: `<blockquote><p>A look back at this week's Binance Wallet community posts.</p><a href="https://x.com/BinanceWallet/status/${walletId}">August 20, 2026</a></blockquote>`,
        });
      }
    }
    return textResponse("", 404);
  };
}

const CRITICAL_TEST_ACCOUNTS = Object.freeze({
  binance: { handle: "binance", name: "Binance", userId: "877807935493033984" },
  binancewallet: { handle: "BinanceWallet", name: "Binance Wallet", userId: "1400391752368992260" },
  flapdotsh: { handle: "flapdotsh", name: "Flap", userId: "1749114887807320064" },
  fourdotmemezh: { handle: "fourdotmemezh", name: "Four.Meme", userId: "1816036559864619011" },
});

const FLAP_AGENTIC_WALLET_209113 = Object.freeze({
  id: "2091136006741500374",
  createdTimestamp: 1_787_400_650,
  text: `Launching a token on @BNBCHAIN just became as simple as having a chat with your AI agent🤖

Try it now through binance agentic wallet @BinanceWallet :

Step 1 — Install the Binance Agentic Wallet skill
Step 2 — Sign in to your Agentic Wallet
Step 3 — Configure your wallet's security settings (in the Binance App)
Step 4 — Install the Flap token-launch skill
*Step 5 — Launch a token quoted against a BStock

Check out the full guide below 👇
https://docs.flap.sh/flap/skills/using-with-binance-agentic-wallet

http://Flap.sh🦋`,
  // The production oEmbed preview for this long post stopped before the two
  // lines that establish the Flap token-launch skill integration.
  oembedText: `Launching a token on @BNBCHAIN just became as simple as having a chat with your AI agent🤖

Try it now through binance agentic wallet @BinanceWallet :

Step 1 — Install the Binance Agentic Wallet skill
Step 2 — Sign in to your Agentic Wallet
Step 3 — Configure your wallet's…`,
});

const FLAP_BSTOCK_PAIRS_209512 = Object.freeze({
  id: "2095124685788979225",
  createdTimestamp: Date.parse("2026-09-02T12:20:25.000Z") / 1_000,
  text: `Leveraged bStocks are coming to Flap. 🦋

Flap is expanding the programmable asset layer with two new bStock trading pairs:

SOXLB — Bull Semiconductors 3X ETF
SOXSB — Bear Semiconductors 3X ETF

Creators can now launch tokens paired directly against leveraged semiconductor exposure — and build their own token economies on top.

On Flap, the trading pair is only the foundation.

You can program mechanisms including:

1.Creator wallet — direct tax fees to creators, or a self-build distribution contract
2.Holder Dividends — continuously distribute dividends to token holders
3.Burn — use accumulated tax fees to burn tokens and reduce supply
4.Liquidity — automatically route trading taxes back into liquidity pool
5.Custom Tax Strategies — combine multiple mechanisms into one token economy

With these, you can build entirely different markets around the same underlying asset.

Different assets. Different mechanisms.

Build on http://Flap.sh 🦋`,
});

function criticalTestFetch(timelines, requests = []) {
  return async (url) => {
    const value = String(url);
    requests.push(value);
    for (const [key, account] of Object.entries(CRITICAL_TEST_ACCOUNTS)) {
      if (!value.includes(`/2/profile/id:${account.userId}/statuses`)) continue;
      const tweets = timelines[key] || [];
      return textResponse({
        code: 200,
        results: tweets.map((tweet) => ({
          id: tweet.id,
          text: tweet.text,
          created_timestamp: tweet.createdTimestamp,
          author: {
            id: tweet.authorId || account.userId,
            name: account.name,
            screen_name: tweet.authorHandle || account.handle,
          },
          url: `https://x.com/${tweet.canonicalHandle || account.handle}/status/${tweet.id}`,
          replying_to: null,
          replies: 0,
          reposts: 0,
          likes: 0,
        })),
      });
    }
    if (value.startsWith("https://publish.x.com/oembed")) {
      const requested = new URL(value).searchParams.get("url");
      const match = requested?.match(/^https:\/\/x\.com\/([^/]+)\/status\/(\d+)$/i);
      if (!match) return textResponse("", 404);
      const key = match[1].toLowerCase();
      const account = CRITICAL_TEST_ACCOUNTS[key];
      const tweet = timelines[key]?.find((item) => item.id === match[2]);
      if (!account || !tweet) return textResponse("", 404);
      const verifiedHandle = tweet.oembedAuthorHandle || account.handle;
      const verifiedStatusHandle = tweet.oembedStatusHandle || account.handle;
      return textResponse({
        url: `https://x.com/${verifiedStatusHandle}/status/${tweet.id}`,
        author_url: `https://x.com/${verifiedHandle}`,
        author_name: account.name,
        html: `<blockquote><p>${tweet.oembedText ?? tweet.text}</p><a href="https://x.com/${verifiedStatusHandle}/status/${tweet.id}">August 20, 2026</a></blockquote>`,
      });
    }
    return textResponse("", 404);
  };
}

async function fixture(t, state = null) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "twitter-monitor-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  if (state) await fs.writeFile(path.join(dataDir, "twitter-state.json"), `${JSON.stringify(state)}\n`);
  return dataDir;
}

function config(dataDir, overrides = {}) {
  return {
    dataDir,
    twitterApiBase: "https://primary.test/timeline",
    twitterPollIntervalMs: 60_000,
    twitterStandardPollConcurrency: 1,
    ...overrides,
  };
}

function criticalOnlyConfig(dataDir, overrides = {}) {
  return config(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: true,
    focusCriticalXMonitorEnabled: true,
    twitterApiBase: "https://ordinary-x-must-not-run.test",
    twitterFallbackApiBases: [],
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterPriorityPollConcurrency: 4,
    ...overrides,
  });
}

function steadyCriticalTimelines(epoch) {
  return Object.fromEntries(Object.keys(CRITICAL_TEST_ACCOUNTS).map((key, index) => [key, [{
    id: `209050000000000000${index + 1}`,
    text: `${CRITICAL_TEST_ACCOUNTS[key].name} community recap.`,
    createdTimestamp: epoch / 1_000 - 60,
  }]]));
}

function fakeTimeoutScheduler(getNow) {
  let sequence = 0;
  const tasks = new Map();
  const set = (callback, delay = 0) => {
    const handle = {
      id: ++sequence,
      dueAt: getNow() + Math.max(0, Number(delay) || 0),
      callback,
      unrefed: false,
      unref() { this.unrefed = true; },
    };
    tasks.set(handle.id, handle);
    return handle;
  };
  const clear = (handle) => tasks.delete(handle?.id);
  const runDue = async () => {
    for (;;) {
      const due = [...tasks.values()]
        .filter((task) => task.dueAt <= getNow())
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id);
      if (!due.length) return;
      for (const task of due) {
        tasks.delete(task.id);
        task.callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
    }
  };
  return { set, clear, runDue, tasks };
}

test("normalizes X and Twitter handles", () => {
  assert.equal(twitterHandle("https://x.com/ponsdotfamily"), "ponsdotfamily");
  assert.equal(twitterHandle("@NoxaLaunchpad"), "NoxaLaunchpad");
  assert.equal(twitterHandle("https://example.com/nope"), null);
  assert.equal(twitterHandle("https://twitter.com/you"), null);
});

test("keeps launch signals and rejects generic chatter", () => {
  assert.equal(classifyTweet("New migration portal and V2 contract are live").relevant, true);
  assert.equal(classifyTweet("Good morning everyone").relevant, false);
});

test("focus launchpad X classifier rejects ordinary token launches and CA posts", () => {
  for (const message of [
    "New launch: $DOG is live",
    "Contract address: 0x1111111111111111111111111111111111111111",
    "Trading is live for MEME",
    "Liquidity added for the new token",
    "New pool for $DOG",
    "DOG subscription is now live",
  ]) assert.equal(classifyFocusLaunchpadText(message).relevant, false, message);

  for (const message of [
    "Introducing a new Vault V2 module",
    "Our new launchpad Factory is deployed on mainnet",
    "Four.Meme subscription is now live",
    "OpenFour developer modules are available",
    "UUSD is available as a quote token",
    "Flap V2 is now live",
  ]) {
    const result = classifyFocusLaunchpadText(message);
    assert.equal(result.relevant, true, message);
    assert.equal(result.platformStructural, true, message);
  }
});

test("focus launchpad X classifier extracts the real Flap bStock quote-pair announcement", () => {
  const result = classifyFocusLaunchpadText(FLAP_BSTOCK_PAIRS_209512.text);
  assert.equal(result.relevant, true);
  assert.equal(result.strong, true);
  assert.equal(result.platformStructural, true);
  assert.equal(result.reason, "flap_bstock_quote_pair_announced");
  assert.ok(result.labels.includes("税收/募资/报价代币"));
  assert.deepEqual(result.quotePairChange, {
    assetClass: "bstock_quote",
    stage: "announced",
    assets: [
      { symbol: "SOXLB", name: "Bull Semiconductors 3X ETF" },
      { symbol: "SOXSB", name: "Bear Semiconductors 3X ETF" },
    ],
  });
});

test("focus launchpad X classifier distinguishes live Flap quote pairs and fails closed on marketing or malformed assets", () => {
  const live = classifyFocusLaunchpadText(`Two new bStock trading pairs are now live on Flap:
- NVDA2B — NVIDIA Leveraged 2X ETF
- TSLASB — Tesla Bear 1X ETF`);
  assert.equal(live.reason, "flap_bstock_quote_pair_live");
  assert.deepEqual(live.quotePairChange, {
    assetClass: "bstock_quote",
    stage: "live",
    assets: [
      { symbol: "NVDA2B", name: "NVIDIA Leveraged 2X ETF" },
      { symbol: "TSLASB", name: "Tesla Bear 1X ETF" },
    ],
  });

  for (const message of [
    `Flap introduces two new bStock trading pairs:
SOXLB — Bull Semiconductors 3X ETF
SOXSB — Bear Semiconductors 3X ETF
Trade & Win for a 50,000 USDT prize pool.`,
    `Explore bStock trading pairs on Flap:
SOXLB — Bull Semiconductors 3X ETF`,
    `Flap is expanding with two new bStock trading pairs:
SOXLB — Bull Semiconductors 3X ETF`,
    `Flap is expanding with two new bStock trading pairs:
SOXLB — Bull Semiconductors 3X ETF
SOXLB — Bear Semiconductors 3X ETF`,
    `Flap is expanding with nine new bStock trading pairs:
AAA1B — Alpha One ETF
AAA2B — Alpha Two ETF
AAA3B — Alpha Three ETF
AAA4B — Alpha Four ETF
AAA5B — Alpha Five ETF
AAA6B — Alpha Six ETF
AAA7B — Alpha Seven ETF
AAA8B — Alpha Eight ETF
AAA9B — Alpha Nine ETF`,
    "Flap adds a new bStock quote token promotion for stock traders.",
  ]) {
    const result = classifyFocusLaunchpadText(message);
    assert.equal(result.relevant, false, message);
    assert.equal(result.quotePairChange, undefined, message);
  }
});

test("focus launchpad X classifier keeps the official Flap Agentic Wallet skill integration", () => {
  const result = classifyFocusLaunchpadText(`Launching a token on @BNBCHAIN just became as simple as having a chat with your AI agent🤖

Try it now through binance agentic wallet @BinanceWallet:
Step 1 — Install the Binance Agentic Wallet skill
Step 2 — Sign in to your Agentic Wallet
Step 3 — Configure your wallet's security settings
Step 4 — Install the Flap token-launch skill
Step 5 — Launch a token quoted against a BStock`);

  assert.equal(result.relevant, true);
  assert.equal(result.strong, true);
  assert.equal(result.platformStructural, true);
  assert.equal(result.reason, "agentic_skill_integration");
  assert.ok(result.labels.includes("Agent/Skill 集成"));
  assert.match(result.headline, /Launching a token.*AI agent/i);

  for (const message of [
    "Ask your AI agent which token might trend next.",
    "Install a generic wallet skill and join our giveaway.",
    "New launch: $AGENT is live on Flap.",
    "Flap token-launch skill works with an AI agent. Join the giveaway and prize pool now.",
  ]) assert.equal(classifyFocusLaunchpadText(message).relevant, false, message);
});

test("focus launchpad X classifier preserves Four.Meme Royalty feature claims without inventing details", () => {
  const result = classifyFocusLaunchpadText(`Four.Meme Royalty tax mode is now live with a new royalty vault.
What's included:
1. Adds creator fee sharing
2. Supports buyback vaults
3. New stock pools are available
4. Contract suffix ffff is enabled
5. Adds flexible quote tokens
6. Adds reusable launch templates`);

  assert.equal(result.relevant, true);
  assert.equal(result.headline, "Four.Meme Royalty tax mode is now live with a new royalty vault.");
  assert.deepEqual(result.keyChanges, [
    "Adds creator fee sharing",
    "Supports buyback vaults",
    "New stock pools are available",
    "Contract suffix ffff is enabled",
    "Adds flexible quote tokens",
  ]);
  assert.deepEqual(result.claims, result.keyChanges);
  assert.equal(result.keyChanges.length, 5, "one X update must stay compact even when the post has more bullets");
});

test("focus launchpad X classifier treats Four.Meme TaxToken9 charity donation as a strong structural mode", () => {
  const result = classifyFocusLaunchpadText(
    "Four.Meme introduces the TaxToken9 Charity Donation feature. Transaction tax can now go to Giggle Charity or Binance Charity, with a Charity Badge and Charity Dashboard.",
  );
  assert.equal(result.relevant, true);
  assert.equal(result.strong, true);
  assert.equal(result.platformStructural, true);
  assert.equal(result.reason, "charity_donation_tax_mode");
  assert.ok(result.labels.includes("慈善捐赠/交易税模式"));
  assert.match(result.keyChanges.join(" "), /TaxToken9|Charity Donation/);

  const ordinaryDonation = classifyFocusLaunchpadText("Four.Meme donated to a local charity this week. Thank you to the community.");
  assert.equal(ordinaryDonation.relevant, false, "an ordinary corporate donation is not a launch mode");
});

test("focus launchpad X classifier keeps an explicit Previous to Now comparison as one change", () => {
  const result = classifyFocusLaunchpadText(`New launchpad fee module is live.
Previous: every launch used a fixed 1% creator fee.
Now: creators can set the fee from 0% to 10%.`);

  assert.equal(result.relevant, true);
  assert.equal(result.keyChanges[0], "Previous: every launch used a fixed 1% creator fee. → Now: creators can set the fee from 0% to 10%.");
  assert.equal(result.claims[0], "Previous: every launch used a fixed 1% creator fee. Now: creators can set the fee from 0% to 10%.");
  assert.ok(result.keyChanges.includes("New launchpad fee module is live."));
});

test("focus launchpad X classifier treats real chain expansion as a strong structural signal", () => {
  const base = classifyFocusLaunchpadText("Flap is now live on Base mainnet with its Vault platform");
  assert.equal(base.relevant, true);
  assert.equal(base.strong, true);
  assert.equal(base.reason, "new_chain_support");
  assert.deepEqual(base.chainSupport, [{ id: "base", name: "Base", chainId: 8453, environment: "mainnet", stage: "deployed" }]);
  assert.ok(base.labels.includes("新增链支持"));

  for (const message of [
    "We love the Base community",
    "Trade DOG on Arbitrum",
    "New BASE token is live",
    "The chain icon order was updated",
  ]) assert.equal(classifyFocusLaunchpadText(message).relevant, false, message);
});

test("focus launchpad X classifier rejects a Trade & Win campaign on an existing chain", () => {
  const campaign = `🏆 Binance Wallet On-Chain Trade &amp; Win S5 introduces the “10U Challenger” bonus pool!

Trade tokens launched on https://four.meme/ for a chance to compete for a 50,000 USDT prize pool on @BNBCHAIN.

✅ Trading volume &gt; 100 USDT ✅ Profit &gt; 10 USDT`;
  assert.equal(classifyFocusLaunchpadText(campaign).relevant, false);

  const expansionWithCampaign = classifyFocusLaunchpadText("Four.Meme adds support for Base mainnet. Trade & Win prize pool starts tomorrow.");
  assert.equal(expansionWithCampaign.relevant, true);
  assert.equal(expansionWithCampaign.reason, "new_chain_support");
  assert.equal(expansionWithCampaign.chainSupport[0].name, "Base");
});

test("Four.Meme classifier preserves the named ListaYield mode as an independent structured lifecycle", () => {
  const text = "Yield is now built into the launch.\n\nIntroducing ListaYield on http://Four.Meme — a new OpenFour mode powered by @lista_dao. \n\nEvery trade can route a share of trading tax into yield-bearing products, creating ongoing yield for eligible holders.\n\nAnd once the token graduates, liquidity moves to Lista DEX by default. 🧵";
  assert.deepEqual(classifyFourMemeOfficialText(text), {
    relevant: true,
    strong: true,
    platformStructural: true,
    labels: ["新发射/新模式", "OpenFour", "税收/募资/报价代币"],
    reason: "fourmeme_named_mode_listayield",
    namedMode: {
      version: 1,
      id: "listayield",
      name: "ListaYield",
      parent: "OpenFour",
      stage: "announced",
      partnerHandle: "lista_dao",
      tradingTaxRoute: "yield_bearing_products",
      holderYield: true,
      graduationLiquidityDestination: "Lista DEX",
    },
  });
  for (const malformed of [
    text.replace("@lista_dao", "@attacker"),
    text.replace("creating ongoing yield for eligible holders", "creating rewards"),
    text.replace("Lista DEX by default", "a DEX later"),
  ]) assert.equal(classifyFourMemeOfficialText(malformed).namedMode, undefined, malformed);
});

test("Four.Meme classifier admits only the complete bStock partner leaderboard campaign", () => {
  const text = `bStocks szn just got competitive. 🟢

150,000 USDT is now live with @AveaiGlobal × @BNBCHAIN — including a 50,000 USDT leaderboard exclusively for http://Four.Meme traders.

Trade http://Four.Meme Stock Memes on http://Ave.ai.
Climb the Top 500.
Take your share.

The sprint is on. 🏁`;
  const result = classifyFourMemeOfficialText(text);
  assert.equal(result.relevant, true);
  assert.equal(result.strong, true);
  assert.equal(result.platformStructural, false);
  assert.equal(result.reason, "fourmeme_bstock_partner_leaderboard_live");
  assert.deepEqual(result.marketCampaign, {
    version: 1,
    kind: "bstock_partner_leaderboard",
    assetClass: "bstock",
    stage: "live",
    partnerHandle: "AveaiGlobal",
    chainHandle: "BNBCHAIN",
    venue: "Ave.ai",
    totalPrizeUsdt: 150_000,
    fourMemePrizeUsdt: 50_000,
    topRanks: 500,
    exclusiveToFourMemeTraders: true,
    campaignKey: "fourmeme:market-campaign:bstock:aveaiglobal:50000-usdt:top-500",
  });
  for (const malformed of [
    text.replace("bStocks", "Stocks"),
    text.replace("@AveaiGlobal × ", ""),
    text.replace("leaderboard exclusively for http://Four.Meme traders", "rewards for all traders"),
    text.replace("Top 500", "leaderboard"),
    text.replace("Stock Memes on http://Ave.ai", "tokens on another venue"),
  ]) assert.equal(classifyFourMemeOfficialText(malformed).marketCampaign, undefined, malformed);

  assert.equal(classifyFourMemeOfficialText("Trade Four.Meme stock memes and share a 150,000 USDT prize pool.").relevant, false);
});

test("uses Binance-specific X filtering while retaining priority token and Alpha listings", () => {
  assert.equal(classifyTweet("Binance Wallet launches a new Meme Rush launchpad filter", "binance").relevant, true);
  assert.equal(classifyTweet("Introducing TOKEN (TOKEN) on Binance Launchpool", "binance").relevant, true);
  assert.equal(classifyTweet("Binance Alpha trading competition: trade TOKEN and share rewards", "binance").relevant, false);
  assert.equal(classifyTweet("牛来 was added to Binance Alpha. You can trade 牛来 using market and limit orders.", "binance").relevant, true);
  assert.equal(classifyTweet("Binance Wallet Meme Rush adds Pools.fun as a new launchpad protocol", "binance").relevant, true);
});

test("tracks immutable X, xAI, Grok and X API identities with a strict product classifier", () => {
  const official = new Map(OFFICIAL_TWITTER_TARGETS.map((target) => [target.handle.toLowerCase(), target]));
  assert.equal(official.get("x")?.xUserId, "783214");
  assert.equal(official.get("spacexai")?.xUserId, "1661523610111193088");
  assert.equal(official.has("xai"), false, "the redirected legacy handle must not be monitored as an exact identity");
  assert.equal(official.get("grok")?.xUserId, "1720665183188922368");
  assert.equal(official.get("api")?.xUserId, "6253282");
  for (const handle of ["x", "spacexai", "grok", "api"]) {
    assert.equal(official.get(handle)?.baselineOnFirstSeen, true);
    assert.equal(official.get(handle)?.signalProfile, "ai");
  }

  for (const message of [
    "Introducing Grok 5, our new flagship model, available now on the xAI API.",
    "X Chat now supports encrypted group calls.",
    "We added new post.create events to the X Activity API.",
    "Grok Build launches a plugin marketplace and new workflows.",
    "The legacy endpoint is deprecated and will be removed next month.",
  ]) {
    const result = classifyAiOfficialText(message);
    assert.equal(result.relevant, true, message);
    assert.equal(result.strong, true, message);
    assert.equal(result.productStructural, true, message);
  }
  for (const message of [
    "Grok says good morning.",
    "We are hiring engineers in Austin.",
    "xAI raised a Series F funding round.",
    "A new compute partnership was announced.",
    "Try asking @grok about the universe.",
    "xAI partners with Acme to launch a Grok API campaign.",
    "The Grok API hackathon launches next week.",
    "Introducing Grok merchandise in the xAI shop.",
    "X Chat is now available in France.",
    "Grok 5 tops another benchmark.",
  ]) assert.equal(classifyAiOfficialText(message).relevant, false, message);
  assert.equal(classifyTweet("Grok Imagine 2.0 is now available via API", "ai").relevant, true);
  assert.equal(classifyAiOfficialText("Grok 5 API pricing changes to $0.20 per 1M input tokens.").relevant, true);
  assert.equal(classifyAiOfficialText("Critical vulnerability fixed in the Grok API.").relevant, true);
});

test("syndication parser carries an immutable author ID when the payload provides one", () => {
  const [tweet] = parseTimelineHtml(timelineHtml("API", [{
    id: "101",
    text: "X Activity API adds post.create events",
    authorId: "6253282",
  }]), "API");
  assert.equal(tweet.xUserId, "6253282");
  assert.equal(tweet.authorId, "6253282");
});

test("FxTwitter timeline accepts only exact numeric-ID originals and ignores verified reposts", () => {
  const tweets = parseFxTwitterTimeline({
    code: 200,
    results: [
      {
        id: "2087310458206199832",
        text: "Imagine Image 2.0 now available on our API",
        url: "https://x.com/grok/status/2087310458206199832",
        created_timestamp: 1_786_488_568,
        author: { id: "1720665183188922368", screen_name: "grok", name: "Grok" },
        replying_to: null,
        reposted_by: null,
      },
      {
        id: "2087275866950938662",
        text: "third-party repost",
        url: "https://x.com/Box/status/2087275866950938662",
        author: { id: "14936846", screen_name: "Box", name: "Box" },
        replying_to: null,
        reposted_by: { id: "1720665183188922368", screen_name: "grok" },
      },
    ],
  }, "grok", "1720665183188922368");
  assert.deepEqual(tweets.map(({ id }) => id), ["2087310458206199832"]);
  assert.equal(tweets[0].authorId, "1720665183188922368");
});

test("FxTwitter timeline fails closed on a foreign item that is not an exact verified repost", () => {
  assert.throws(() => parseFxTwitterTimeline({
    code: 200,
    results: [{
      id: "2087275866950938662",
      text: "forged",
      url: "https://x.com/attacker/status/2087275866950938662",
      author: { id: "999", screen_name: "attacker" },
      replying_to: null,
      reposted_by: null,
    }],
  }, "grok", "1720665183188922368"), /immutable identity mismatch/);
});

test("FxTwitter exact status requires the requested status, canonical handle, and numeric user ID", () => {
  const id = "2090380033013764166";
  const payload = {
    code: 200,
    tweet: {
      id,
      text: "Meet Agent OS - a new way to build, deploy and use AI agents on Binance.",
      created_timestamp: 1787220411,
      url: `https://x.com/binance/status/${id}`,
      author: { id: "877807935493033984", screen_name: "binance", name: "Binance" },
      replying_to: null,
      reposted_by: null,
    },
  };
  const parsed = parseFxTwitterExactStatus(payload, "binance", "877807935493033984", id);
  assert.equal(parsed.authorId, "877807935493033984");
  assert.equal(parsed.id, id);
  for (const forged of [
    { ...payload, tweet: { ...payload.tweet, author: { ...payload.tweet.author, id: "999" } } },
    { ...payload, tweet: { ...payload.tweet, url: `https://x.com/attacker/status/${id}` } },
    { ...payload, tweet: { ...payload.tweet, id: "2090380033013764167" } },
    { ...payload, tweet: { ...payload.tweet, replying_to: "123" } },
  ]) assert.throws(
    () => parseFxTwitterExactStatus(forged, "binance", "877807935493033984", id),
    /exact-status identity mismatch/,
  );
});

test("official X oEmbed verifies the exact status and supplies first-party text", () => {
  const text = parseOfficialXOembed({
    url: "https://x.com/grok/status/2087310458206199832",
    author_url: "https://x.com/grok",
    html: '<blockquote><p>Imagine Image 2.0 now available on our API.<br>Docs: <a href="https://t.co/example">https://t.co/example</a></p>&mdash; Grok (@grok) <a href="https://x.com/grok/status/2087310458206199832?ref_src=twsrc">August 11, 2026</a></blockquote>',
  }, "grok", "2087310458206199832");
  assert.equal(text, "Imagine Image 2.0 now available on our API.\nDocs: https://t.co/example");
  assert.throws(() => parseOfficialXOembed({
    url: "https://x.com/attacker/status/2087310458206199832",
    author_url: "https://x.com/attacker",
    html: "<blockquote></blockquote>",
  }, "grok", "2087310458206199832"), /identity mismatch/);
});

test("AI official accounts silently baseline once and alert only a later high-signal update", async (t) => {
  const dataDir = await fixture(t);
  const immutableIds = new Map(OFFICIAL_TWITTER_TARGETS
    .filter(({ signalProfile }) => signalProfile === "ai")
    .map(({ handle, xUserId }) => [handle.toLowerCase(), xUserId]));
  let round = 0;
  const delivered = [];
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterPriorityPollConcurrency: 8,
    twitterStandardPollConcurrency: 8,
  }), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => { delivered.push(event); return { status: "queued" }; },
    fetchImpl: async (url) => {
      const handle = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1));
      const authorId = immutableIds.get(handle.toLowerCase());
      const tweets = handle.toLowerCase() === "x" && round === 1
        ? [
            { id: "101", text: "X Chat now supports encrypted group calls.", authorId },
            { id: "100", text: "Welcome to X.", authorId },
          ]
        : [{ id: "100", text: "Good morning.", ...(authorId ? { authorId } : {}) }];
      return response({ handle, tweets });
    },
  });

  await monitor.check();
  assert.equal(delivered.filter(({ project }) => project.handle.toLowerCase() === "x").length, 0);
  round = 1;
  await monitor.check();

  const xAlerts = delivered.filter(({ project }) => project.handle.toLowerCase() === "x");
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.deepEqual(xAlerts.map(({ tweet }) => tweet.id), ["101"]);
  assert.equal(xAlerts[0].tweet.authorId, "783214");
  assert.equal(state.x.latestId, "101");
});

test("AI syndication fails closed on a wrong immutable ID and falls through to a verified source", async (t) => {
  const dataDir = await fixture(t, { x: { latestId: "100", checkedAt: "old" } });
  const immutableIds = new Map(OFFICIAL_TWITTER_TARGETS
    .filter(({ signalProfile }) => signalProfile === "ai")
    .map(({ handle, xUserId }) => [handle.toLowerCase(), xUserId]));
  const delivered = [];
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterFallbackApiBases: ["https://verified.test/{handle}"],
    twitterPriorityPollConcurrency: 8,
    twitterStandardPollConcurrency: 8,
  }), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => { delivered.push(event); return { status: "delivered" }; },
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const handle = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1));
      const expected = immutableIds.get(handle.toLowerCase());
      const authorId = parsed.hostname === "primary.test" && handle.toLowerCase() === "x" ? "999" : expected;
      return response({ handle, tweets: [{
        id: "101",
        text: handle.toLowerCase() === "x" ? "X Chat now supports encrypted group calls." : "Good morning.",
        ...(authorId ? { authorId } : {}),
      }] });
    },
  });

  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.deepEqual(delivered.filter(({ project }) => project.handle.toLowerCase() === "x").map(({ tweet }) => tweet.id), ["101"]);
  assert.equal(state.x.latestId, "101");
  assert.equal(state._health.x.activeSource, "https://verified.test/{handle}");
  assert.equal(state._health.x.status, "degraded");
  assert.match(state._health.x.sources["https://primary.test/timeline"].lastError, /immutable identity mismatch/);
});

test("AI accounts reject ID-less Jina evidence and use the next identity-bearing source", async (t) => {
  const dataDir = await fixture(t, { x: { latestId: "100", checkedAt: "old" } });
  const immutableIds = new Map(OFFICIAL_TWITTER_TARGETS
    .filter(({ signalProfile }) => signalProfile === "ai")
    .map(({ handle, xUserId }) => [handle.toLowerCase(), xUserId]));
  const jinaBase = "https://r.jina.ai/https://x.com/{handle}";
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterApiBase: jinaBase,
    twitterFallbackApiBases: ["https://verified.test/{handle}"],
    twitterPriorityPollConcurrency: 8,
    twitterStandardPollConcurrency: 8,
  }), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async () => ({ status: "queued" }),
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      const handle = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).at(-1));
      if (parsed.hostname === "r.jina.ai") {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({ data: { content: `* [${handle}](https://x.com/${handle}) [now](https://x.com/${handle}/status/101) Good morning.` } }),
        };
      }
      return response({ handle, tweets: [{
        id: "101",
        text: handle.toLowerCase() === "x" ? "X Chat now supports encrypted group calls." : "Good morning.",
        ...(immutableIds.has(handle.toLowerCase()) ? { authorId: immutableIds.get(handle.toLowerCase()) } : {}),
      }] });
    },
  });

  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.x.latestId, "101");
  assert.equal(state._health.x.activeSource, "https://verified.test/{handle}");
  assert.match(state._health.x.sources[jinaBase].lastError, /cannot be verified by Jina Reader/);
});

test("tracks official Uniswap and Pools accounts and keeps only protocol-level signals", () => {
  const official = new Map(OFFICIAL_TWITTER_TARGETS.map((target) => [target.handle.toLowerCase(), target]));
  assert.equal(official.get("uniswap")?.xUserId, "984188226826010624");
  assert.equal(official.get("tradepools")?.xUserId, "2080394757721735168");
  assert.equal(official.get("uniswap")?.baselineOnFirstSeen, true);
  assert.equal(official.get("tradepools")?.priority, true);
  const launcher = classifyUniswapOfficialText("Liquidity Launcher v3.2 adds InstantLaunchStrategy and FeeSplitter");
  assert.equal(launcher.strong, true);
  assert.deepEqual(launcher.keyChanges, ["Liquidity Launcher v3.2 adds InstantLaunchStrategy and FeeSplitter"]);
  assert.equal(classifyTweet("DualPool is a new v4 hook with ERC4626 idle yield", "uniswap").relevant, true);
  assert.equal(classifyTweet("Trade TOKEN now on Uniswap", "uniswap").relevant, false);
  assert.equal(classifyTweet("EquityLaunch enables tokenized stock issuance", "uniswap").relevant, false);
  assert.equal(classifyTweet("A new launchpad pool for tokenized stocks and security tokens", "uniswap").relevant, false);
  assert.equal(classifyTweet("A new launchpad pool for Security-token issuance", "uniswap").relevant, false);
  const expansion = classifyTweet("Uniswap protocol adds support for Base mainnet", "uniswap");
  assert.equal(expansion.relevant, true);
  assert.ok(expansion.labels.includes("Uniswap 新链支持"));
  assert.equal(expansion.chainSupport[0].name, "Base");
});

test("tracks official Binance, Binance Wallet, and Binance Futures X accounts without replaying their current timelines", async (t) => {
  const official = new Map(OFFICIAL_TWITTER_TARGETS.map((target) => [target.handle.toLowerCase(), target]));
  assert.equal(official.get("binancewallet")?.priority, true);
  assert.equal(official.get("binance")?.priority, true);
  assert.equal(official.get("binancefutures")?.priority, true);
  assert.equal(official.get("binancefutures")?.xUserId, "1426142483822518274");
  assert.equal(official.get("binancewallet")?.baselineOnFirstSeen, true);

  const dataDir = await fixture(t);
  let newest = "101";
  const delivered = [];
  const monitor = createTwitterMonitor(config(dataDir), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    fetchImpl: async (url) => url.endsWith("/BinanceWallet")
      ? response({
          handle: "BinanceWallet",
          tweets: [
            { id: newest, text: newest === "101" ? "Binance Wallet launches a new Meme Rush launchpad filter" : "Binance Wallet introduces a new chain and launchpad protocol" },
            ...(newest === "102" ? [{ id: "101", text: "Binance Wallet launches a new Meme Rush launchpad filter" }] : []),
          ],
        })
      : response(),
  });
  await monitor.check();
  assert.equal(delivered.length, 0, "the current Binance Wallet timeline must become a silent baseline");
  newest = "102";
  await monitor.check();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].project.id, "binance-wallet");
});

test("the critical Binance X classifier admits Agent OS, major structures, and priority market listings", async () => {
  const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/binance-agent-os-x-2090380033013764166.json", import.meta.url), "utf8"));
  const agentOs = classifyBinanceCriticalProductText(fixture.timeline.results[0].text);
  assert.equal(agentOs.relevant, true);
  assert.equal(agentOs.strong, true);
  assert.equal(agentOs.criticalBinanceProduct, true);
  assert.deepEqual(agentOs.labels, ["Binance Agent OS/Agent Native/MCP"]);

  assert.equal(classifyBinanceCriticalProductText("Binance launches a new developer platform for autonomous agents.").relevant, true);
  assert.equal(classifyBinanceCriticalProductText("Binance Wallet now supports isolated agent sub-accounts with a user-controlled permission model.").relevant, true);
  assert.equal(classifyBinanceCriticalProductText("Binance will list TEST token on Spot.").relevant, true);
  assert.equal(classifyBinanceCriticalProductText("Binance Futures will launch TESTUSDT perpetual contract.").relevant, true);
  assert.equal(classifyBinanceCriticalProductText("TEST was added to Binance Alpha.").relevant, true);
  for (const text of [
    "Initializing a new mode. Less than 24 hours to go.",
    "Trade and win in our new Agent OS campaign with 10,000 USDT in rewards.",
    "Binance announces scheduled wallet maintenance.",
    "Binance Wallet adds dark mode.",
    "Binance launches a new platform for tokenized stocks.",
  ]) assert.equal(classifyBinanceCriticalProductText(text).relevant, false, text);
});

test("ordinary X off polls only Binance product accounts and catches the fresh official Agent OS post from the durable cursor", async (t) => {
  const agentOs = JSON.parse(await fs.readFile(new URL("./fixtures/binance-agent-os-x-2090380033013764166.json", import.meta.url), "utf8"));
  const dataDir = await fixture(t, {
    binance: { latestId: "2090069502390391037", checkedAt: "2026-08-19T13:33:00.000Z" },
  });
  const delivered = [];
  const requests = [];
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: true,
    binanceCriticalXMaxAgeMs: 2 * 60 * 60 * 1_000,
    twitterApiBase: "",
    twitterFallbackApiBases: [],
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterPriorityPollConcurrency: 2,
  }), {
    autoStart: false,
    now: () => Date.parse("2026-08-20T10:10:00.000Z"),
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    fetchImpl: binanceCriticalFetch(agentOs, requests),
  });

  await monitor.check();
  assert.deepEqual(delivered.map(({ tweet }) => tweet.id), ["2090380033013764166"]);
  assert.equal(delivered[0].tweet.sourceVerifiedBy, "official_x_oembed");
  assert.equal(delivered[0].signal.criticalBinanceProduct, true);
  const timelineIds = requests
    .map((url) => url.match(/\/2\/profile\/id:(\d+)\/statuses/)?.[1])
    .filter(Boolean);
  assert.deepEqual(new Set(timelineIds), new Set(["877807935493033984", "1400391752368992260"]));
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.binance.latestId, "2090380033013764166");
  assert.equal(state.binancewallet.latestId, "2090379000000000000");
});

test("the critical Binance X lane silently baselines without a cursor and never replays a two-hour-old post", async (t) => {
  const agentOs = JSON.parse(await fs.readFile(new URL("./fixtures/binance-agent-os-x-2090380033013764166.json", import.meta.url), "utf8"));

  const baselineDir = await fixture(t);
  const baselineAlerts = [];
  const baseline = createTwitterMonitor(config(baselineDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: true,
    twitterApiBase: "",
    twitterFallbackApiBases: [],
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterPriorityPollConcurrency: 2,
  }), {
    autoStart: false,
    now: () => Date.parse("2026-08-20T10:10:00.000Z"),
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => baselineAlerts.push(event),
    fetchImpl: binanceCriticalFetch(agentOs),
  });
  await baseline.check();
  assert.equal(baselineAlerts.length, 0);
  const baselineState = JSON.parse(await fs.readFile(path.join(baselineDir, "twitter-state.json"), "utf8"));
  assert.equal(baselineState.binance.latestId, "2090380033013764166");

  const staleDir = await fixture(t, { binance: { latestId: "2090069502390391037", checkedAt: "old" } });
  const staleAlerts = [];
  const stale = createTwitterMonitor(config(staleDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: true,
    binanceCriticalXMaxAgeMs: 2 * 60 * 60 * 1_000,
    twitterApiBase: "",
    twitterFallbackApiBases: [],
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterPriorityPollConcurrency: 2,
  }), {
    autoStart: false,
    now: () => Date.parse("2026-08-20T12:06:52.000Z"),
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => staleAlerts.push(event),
    fetchImpl: binanceCriticalFetch(agentOs),
  });
  await stale.check();
  assert.equal(staleAlerts.length, 0);
  const staleState = JSON.parse(await fs.readFile(path.join(staleDir, "twitter-state.json"), "utf8"));
  assert.equal(staleState.binance.latestId, "2090380033013764166", "stale posts advance the cursor without alert replay");
});

test("critical Binance X cross-scans Jina when Fx timeline is stale and merges only exact-status plus oEmbed verified posts", async (t) => {
  const agentOs = JSON.parse(await fs.readFile(new URL("./fixtures/binance-agent-os-x-2090380033013764166.json", import.meta.url), "utf8"));
  const targetId = "2090380033013764166";
  const staleFxId = "2090365456578441234";
  const walletId = "2090379000000000000";
  const jinaBase = "https://r.jina.ai/https://twitter.com/{handle}";
  const dataDir = await fixture(t, {
    binance: { latestId: staleFxId, checkedAt: "old" },
    binancewallet: { latestId: walletId, checkedAt: "old" },
  });
  const delivered = [];
  const requests = [];
  const loggedErrors = [];
  const timeoutBudgets = [];
  const originalAbortTimeout = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (timeoutMs) => {
    timeoutBudgets.push(timeoutMs);
    return originalAbortTimeout(timeoutMs);
  });
  const timeline = (id, handle, authorId, createdTimestamp, text) => ({
    code: 200,
    results: [{
      id,
      text,
      created_timestamp: createdTimestamp,
      author: { id: authorId, name: handle, screen_name: handle },
      url: `https://x.com/${handle}/status/${id}`,
      replying_to: null,
      replies: 0,
      reposts: 0,
      likes: 0,
    }],
  });
  const fetchImpl = async (url) => {
    const value = String(url);
    requests.push(value);
    if (value.includes("/2/profile/id:877807935493033984/statuses")) {
      return textResponse(timeline(staleFxId, "binance", "877807935493033984", 1787216936, "Binance market recap."));
    }
    if (value.includes("/2/profile/id:1400391752368992260/statuses")) {
      return textResponse(timeline(walletId, "BinanceWallet", "1400391752368992260", 1787220165, "Binance Wallet community recap."));
    }
    if (value === "https://r.jina.ai/https://twitter.com/binance") {
      return textResponse({
        data: {
          content: `* Pinned [Binance](https://twitter.com/binance) [now](https://twitter.com/binance/status/${targetId}) ${agentOs.timeline.results[0].text}`,
        },
      });
    }
    if (value === "https://r.jina.ai/https://twitter.com/BinanceWallet") return textResponse("", 503);
    if (value === `https://api.fxtwitter.test/binance/status/${targetId}`) {
      const official = agentOs.timeline.results[0];
      return textResponse({
        code: 200,
        tweet: {
          ...official,
          raw_text: { text: official.text, facets: [] },
          retweets: official.reposts,
          reposted_by: null,
        },
      });
    }
    if (value.startsWith("https://publish.x.com/oembed")
      && new URL(value).searchParams.get("url") === `https://x.com/binance/status/${targetId}`) {
      return textResponse(agentOs.oembed);
    }
    throw new Error(`unexpected critical-X request: ${value}`);
  };
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: true,
    binanceCriticalXMaxAgeMs: 2 * 60 * 60 * 1_000,
    binanceCriticalXVerifyTimeoutMs: 1_750,
    twitterApiBase: "",
    twitterFallbackApiBases: [jinaBase],
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterJinaMinIntervalMs: 300_000,
    twitterPriorityPollConcurrency: 2,
  }), {
    autoStart: false,
    now: () => Date.parse("2026-08-20T10:10:00.000Z"),
    logger: { error(message) { loggedErrors.push(message); } },
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    fetchImpl,
  });

  await monitor.check();
  assert.deepEqual(delivered.map(({ tweet }) => tweet.id), [targetId]);
  assert.equal(delivered[0].tweet.authorId, "877807935493033984");
  assert.equal(delivered[0].tweet.xUserId, "877807935493033984");
  assert.equal(delivered[0].tweet.sourceVerifiedBy, "official_x_oembed");
  assert.equal(delivered[0].tweet.identityVerifiedBy, "fxtwitter_exact_numeric_id");
  assert.equal(delivered[0].tweet.discoveredBy, "jina_twitter_profile");
  assert.ok(
    timeoutBudgets.filter((timeoutMs) => timeoutMs === 1_750).length >= 2,
    "fast discovery must let both exact-status and oEmbed use the dynamic 1750ms verification ceiling",
  );
  assert.ok(requests.includes("https://r.jina.ai/https://twitter.com/binance"));
  assert.ok(requests.includes(`https://api.fxtwitter.test/binance/status/${targetId}`));
  assert.equal(requests.some((url) => url.includes("r.jina.ai/https://x.com/")), false);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.binance.latestId, targetId);
  assert.equal(state._health.binance.sources[jinaBase].status, "healthy");
  assert.equal(state._health.binance.sources[jinaBase].identitySource, false);
  assert.equal(state._health.binancewallet.activeSource, "https://api.fxtwitter.test/2/profile/id:{userId}/statuses?count=40");
  assert.equal(
    state._health.binancewallet.status,
    "degraded",
    `Jina discovery failure must not fail the healthy Fx primary lane: ${loggedErrors.join(" | ")}`,
  );
  assert.equal(state._health.binance.slaStatus, "best_effort");
  assert.equal(state._health.binance.slaHardGuarantee, false);
  assert.equal(state._health.binancewallet.slaStatus, "source_limited");
  assert.equal(state.binancewallet.latestId, walletId);
});

test("a critical Jina 429 is account-scoped and marks only that account source-limited", async (t) => {
  const binanceId = "2090409112647446693";
  const walletId = "2090415248213975361";
  const jinaBase = "https://r.jina.ai/https://twitter.com/{handle}";
  const dataDir = await fixture(t, {
    binance: { latestId: binanceId, checkedAt: "old" },
    binancewallet: { latestId: walletId, checkedAt: "old" },
  });
  let clock = Date.parse("2026-08-20T12:40:00.000Z");
  const requests = [];
  const timeline = (id, handle, authorId) => ({
    code: 200,
    results: [{
      id,
      text: `${handle} community recap.`,
      created_timestamp: Math.floor(clock / 1_000) - 60,
      author: { id: authorId, name: handle, screen_name: handle },
      url: `https://x.com/${handle}/status/${id}`,
      replying_to: null,
      replies: 0,
      reposts: 0,
      likes: 0,
    }],
  });
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: true,
    binanceCriticalXDiscoveryIntervalMs: 500,
    twitterApiBase: "",
    twitterFallbackApiBases: [jinaBase],
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterPriorityPollConcurrency: 2,
  }), {
    autoStart: false,
    now: () => clock,
    logger: { error() {} },
    sendAlertsImpl: async () => ({ status: "queued" }),
    fetchImpl: async (url) => {
      const value = String(url);
      requests.push(value);
      if (value.includes("/2/profile/id:877807935493033984/statuses")) {
        return textResponse(timeline(binanceId, "binance", "877807935493033984"));
      }
      if (value.includes("/2/profile/id:1400391752368992260/statuses")) {
        return textResponse(timeline(walletId, "BinanceWallet", "1400391752368992260"));
      }
      if (value === "https://r.jina.ai/https://twitter.com/binance") {
        return textResponse({
          data: { content: `* [Binance](https://twitter.com/binance) [now](https://twitter.com/binance/status/${binanceId}) Binance community recap.` },
        });
      }
      if (value === "https://r.jina.ai/https://twitter.com/BinanceWallet") {
        return {
          status: 429,
          ok: false,
          headers: { get: (name) => name.toLowerCase() === "retry-after" ? "60" : null },
          text: async () => "",
        };
      }
      throw new Error(`unexpected account-circuit request: ${value}`);
    },
  });

  await monitor.check();
  clock += 1_000;
  await monitor.check();

  assert.equal(
    requests.filter((url) => url === "https://r.jina.ai/https://twitter.com/binance").length,
    2,
    "Binance must keep polling after a different account receives Jina 429",
  );
  assert.equal(
    requests.filter((url) => url === "https://r.jina.ai/https://twitter.com/BinanceWallet").length,
    1,
    "the rate-limited account must honor its own backoff",
  );
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state._health.binance.sources[jinaBase].status, "healthy");
  assert.equal(state._health.binance.slaStatus, "best_effort");
  assert.equal(state._health.binancewallet.sources[jinaBase].status, "backoff");
  assert.equal(state._health.binancewallet.slaStatus, "source_limited");
  assert.match(state._health.binancewallet.slaStatusReason, /public_discovery_limited/);
});

test("critical direct failure circuit persists across restart while healthy Fx coverage stays degraded, not failed", async (t) => {
  const binanceId = "2090409112647446693";
  const walletId = "2090415248213975361";
  const directBase = "https://x.com/{handle}";
  const fxBase = "https://api.fxtwitter.test/2/profile/id:{userId}/statuses?count=40";
  const epoch = Date.parse("2026-08-24T10:00:00.000Z");
  let clock = epoch;
  const dataDir = await fixture(t, {
    binance: { latestId: binanceId, checkedAt: "old" },
    binancewallet: { latestId: walletId, checkedAt: "old" },
  });
  const requests = [];
  const logs = [];
  const timeline = (id, account) => ({
    code: 200,
    results: [{
      id,
      text: `${account.name} community recap.`,
      created_timestamp: Math.floor(clock / 1_000) - 60,
      author: { id: account.userId, name: account.name, screen_name: account.handle },
      url: `https://x.com/${account.handle}/status/${id}`,
      replying_to: null,
      replies: 0,
      reposts: 0,
      likes: 0,
    }],
  });
  const fetchImpl = async (url) => {
    const value = String(url);
    requests.push(value);
    if (value.includes(`/2/profile/id:${CRITICAL_TEST_ACCOUNTS.binance.userId}/statuses`)) {
      return textResponse(timeline(binanceId, CRITICAL_TEST_ACCOUNTS.binance));
    }
    if (value.includes(`/2/profile/id:${CRITICAL_TEST_ACCOUNTS.binancewallet.userId}/statuses`)) {
      return textResponse(timeline(walletId, CRITICAL_TEST_ACCOUNTS.binancewallet));
    }
    if (value === "https://x.com/binance") return textResponse("", 503);
    if (value === "https://x.com/BinanceWallet") {
      return textResponse(`<div data-href="/BinanceWallet/status/${walletId}"><article data-tweet-id="${walletId}"></article></div>`);
    }
    throw new Error(`unexpected durable-circuit request: ${value}`);
  };
  const monitorConfig = config(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: true,
    focusCriticalXMonitorEnabled: false,
    twitterApiBase: "",
    twitterFallbackApiBases: [],
    twitterDirectXEnabled: true,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterCriticalDiscoveryFailureMinBackoffMs: 15_000,
    twitterCriticalDiscoveryFailureMaxBackoffMs: 300_000,
    twitterFailureLogSummaryIntervalMs: 15 * 60_000,
    twitterPriorityPollConcurrency: 2,
  });
  const dependencies = {
    autoStart: false,
    now: () => clock,
    logger: {
      error(message) { logs.push(message); },
      info(message) { logs.push(message); },
    },
    sendAlertsImpl: async () => ({ status: "queued" }),
    fetchImpl,
  };

  const first = createTwitterMonitor(monitorConfig, dependencies);
  await first.check();
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state._health.binance.activeSource, fxBase);
  assert.equal(state._health.binance.status, "degraded");
  assert.equal(state._health.binance.slaStatus, "source_limited");
  assert.equal(state._health.binance.sources[directBase].circuitState, "open");
  assert.equal(Date.parse(state._health.binance.sources[directBase].circuitUntil) - epoch, 15_000);
  assert.equal(requests.filter((url) => url === "https://x.com/binance").length, 1);

  // A fresh monitor instance must honor the persisted circuit rather than use
  // the legacy startup transport probe to immediately hit X again. Drain the
  // original monitor first so its deferred telemetry timer cannot race the
  // restarted instance or the fixture cleanup.
  await first.stop();
  clock = epoch + 1_000;
  const restarted = createTwitterMonitor(monitorConfig, dependencies);
  await restarted.check();
  assert.equal(requests.filter((url) => url === "https://x.com/binance").length, 1);

  clock = epoch + 15_000;
  await restarted.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(requests.filter((url) => url === "https://x.com/binance").length, 2);
  assert.equal(Date.parse(state._health.binance.sources[directBase].circuitUntil) - clock, 30_000);
  assert.equal(state._health.binance.sources[directBase].failureLog.suppressed, 1);
  assert.equal(logs.filter((message) => message.includes("@binance/x_direct_profile")).length, 1);
  assert.equal(logs.some((message) => message.includes("all X sources are in backoff")), false);

  clock = epoch + 15 * 60_000;
  await restarted.check();
  state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(requests.filter((url) => url === "https://x.com/binance").length, 3);
  assert.equal(Date.parse(state._health.binance.sources[directBase].circuitUntil) - clock, 60_000);
  assert.equal(logs.filter((message) => message.includes("@binance/x_direct_profile")).length, 2);
  assert.ok(logs.some((message) => message.includes("suppressed 1 repeated failures")));
  await restarted.stop();
});

test("critical X direct discovery accepts only an exact-handle status wrapper with the same article ID", () => {
  const id = "2090380033013764166";
  const html = `<div data-href="/binance/status/${id}"><article data-tweet-id="${id}"></article></div>
    <div data-href="/attacker/status/2090380033013764167"><article data-tweet-id="2090380033013764167"></article></div>
    <div data-href="/binance/status/2090380033013764168"><article data-tweet-id="2090380033013764169"></article></div>`;

  assert.deepEqual(parseCriticalXDirectDiscovery(html, "binance").map((tweet) => tweet.id), [id]);
});

test("critical Binance X scheduler cycle and sendAlerts share one non-extendable five-second budget", async (t) => {
  const agentOs = JSON.parse(await fs.readFile(new URL("./fixtures/binance-agent-os-x-2090380033013764166.json", import.meta.url), "utf8"));
  const targetId = "2090380033013764166";
  const staleFxId = "2090365456578441234";
  const walletId = "2090379000000000000";
  const publishedAt = agentOs.timeline.results[0].created_timestamp * 1_000;
  // The post becomes visible just after the previous attempt. Preserve a real
  // cycle start after the full configured one-second polling allowance.
  let clock = publishedAt + 1_000;
  const schedulerCycleStartedAt = clock;
  let sentAt = null;
  let sendReturnedAt = null;
  let receivedDeliverySla = null;
  const delayed = (durationMs, value) => {
    const startedAt = clock;
    return new Promise((resolve) => queueMicrotask(() => {
      clock = Math.max(clock, startedAt + durationMs);
      resolve(value);
    }));
  };
  const directHtml = (handle, id) => `<div data-href="/${handle}/status/${id}"><article data-tweet-id="${id}"></article></div>`;
  const timeline = (id, handle, authorId, text, createdTimestamp) => ({
    code: 200,
    results: [{
      id,
      text,
      created_timestamp: createdTimestamp,
      author: { id: authorId, name: handle, screen_name: handle },
      url: `https://x.com/${handle}/status/${id}`,
      replying_to: null,
      replies: 0,
      reposts: 0,
      likes: 0,
    }],
  });
  const dataDir = await fixture(t, {
    binance: { latestId: staleFxId, checkedAt: "old" },
    binancewallet: { latestId: walletId, checkedAt: "old" },
  });
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: true,
    binanceCriticalXMaxAgeMs: 2 * 60 * 60 * 1_000,
    binanceCriticalXSchedulerIntervalMs: 250,
    binanceCriticalXDiscoveryIntervalMs: 500,
    binanceCriticalXPollAllowanceMs: 1_000,
    binanceCriticalXDiscoveryTimeoutMs: 2_000,
    binanceCriticalXVerifyTimeoutMs: 1_750,
    binanceCriticalXLocalBudgetMs: 5_000,
    twitterApiBase: "",
    twitterFallbackApiBases: [],
    twitterDirectXEnabled: true,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterPriorityPollConcurrency: 2,
  }), {
    autoStart: false,
    now: () => clock,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => {
      if (event.tweet.id === targetId) {
        sentAt = clock;
        receivedDeliverySla = event.deliverySla;
        await delayed(750, null);
        sendReturnedAt = clock;
      }
      return { status: "queued" };
    },
    fetchImpl: async (url) => {
      const value = String(url);
      if (value === "https://x.com/binance") return delayed(2_000, textResponse(directHtml("binance", targetId)));
      if (value === "https://x.com/BinanceWallet") return delayed(1, textResponse(directHtml("BinanceWallet", walletId)));
      if (value.includes("/2/profile/id:877807935493033984/statuses")) {
        return delayed(2_000, textResponse(timeline(
          staleFxId,
          "binance",
          "877807935493033984",
          "Binance market recap.",
          agentOs.timeline.results[0].created_timestamp - 600,
        )));
      }
      if (value.includes("/2/profile/id:1400391752368992260/statuses")) {
        return delayed(1, textResponse(timeline(
          walletId,
          "BinanceWallet",
          "1400391752368992260",
          "Binance Wallet community recap.",
          agentOs.timeline.results[0].created_timestamp - 60,
        )));
      }
      if (value === `https://api.fxtwitter.test/binance/status/${targetId}`) {
        return delayed(1_250, textResponse({
          code: 200,
          tweet: {
            ...agentOs.timeline.results[0],
            raw_text: { text: agentOs.timeline.results[0].text, facets: [] },
            retweets: agentOs.timeline.results[0].reposts,
            reposted_by: null,
          },
        }));
      }
      if (value.startsWith("https://publish.x.com/oembed")
        && new URL(value).searchParams.get("url") === `https://x.com/binance/status/${targetId}`) {
        return delayed(1_250, textResponse(agentOs.oembed));
      }
      throw new Error(`unexpected latency-budget request: ${value}`);
    },
  });

  await monitor.check();
  assert.notEqual(sentAt, null);
  assert.notEqual(sendReturnedAt, null);
  assert.deepEqual(receivedDeliverySla, {
    startedAt: new Date(schedulerCycleStartedAt).toISOString(),
    deadlineAt: new Date(schedulerCycleStartedAt + 4_000).toISOString(),
    budgetMs: 5_000,
    pollAllowanceMs: 1_000,
    basis: "critical_source_poll",
  });
  assert.ok(
    sendReturnedAt - schedulerCycleStartedAt <= 5_000,
    `critical scheduler-to-delivery path took ${sendReturnedAt - schedulerCycleStartedAt}ms`,
  );
  assert.ok(
    sendReturnedAt - publishedAt <= 5_000,
    `poll allowance plus scheduler-to-delivery path took ${sendReturnedAt - publishedAt}ms`,
  );
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.binance.latestId, targetId);
  assert.equal(state._health.binance.criticalVerification.identity, "fxtwitter_exact_numeric_id+official_x_oembed");
});

test("ordinary X off selects exactly the four enabled immutable critical accounts and silently baselines them", async (t) => {
  const dataDir = await fixture(t);
  const nowMs = Date.parse("2026-08-20T10:10:00.000Z");
  const timelines = {
    binance: [{ id: "2090500000000000001", text: "Binance community recap.", createdTimestamp: nowMs / 1_000 - 60 }],
    binancewallet: [{ id: "2090500000000000002", text: "Binance Wallet community recap.", createdTimestamp: nowMs / 1_000 - 60 }],
    flapdotsh: [{ id: "2090500000000000003", text: "Flap community recap.", createdTimestamp: nowMs / 1_000 - 60 }],
    fourdotmemezh: [{ id: "2090500000000000004", text: "Four.Meme community recap.", createdTimestamp: nowMs / 1_000 - 60 }],
  };
  const requests = [];
  const delivered = [];
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: true,
    focusCriticalXMonitorEnabled: true,
    twitterApiBase: "https://ordinary-x-must-not-run.test",
    twitterFallbackApiBases: [],
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterPriorityPollConcurrency: 4,
  }), {
    autoStart: false,
    now: () => nowMs,
    logger: { error() {} },
    fetchImpl: criticalTestFetch(timelines, requests),
    sendAlertsImpl: async (_config, event) => { delivered.push(event); return { status: "queued" }; },
  });

  await monitor.check();

  assert.equal(delivered.length, 0, "all four first observations must become silent baselines");
  const timelineUserIds = requests
    .map((url) => url.match(/\/2\/profile\/id:(\d+)\/statuses/)?.[1])
    .filter(Boolean);
  assert.deepEqual(new Set(timelineUserIds), new Set(Object.values(CRITICAL_TEST_ACCOUNTS).map(({ userId }) => userId)));
  assert.equal(requests.some((url) => url.includes("ordinary-x-must-not-run.test")), false);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.deepEqual(
    Object.keys(state).filter((key) => !key.startsWith("_")).sort(),
    ["binance", "binancewallet", "flapdotsh", "fourdotmemezh"],
  );
  assert.equal(state._meta.health.coverageAccounts.total, 4);
  assert.equal(state._meta.health.coverageAccounts.priorityTotal, 4);
  for (const key of Object.keys(timelines)) {
    assert.equal(state[key].latestId, timelines[key][0].id);
    assert.equal(state._health[key].criticalVerification.status, "healthy");
    assert.equal(state._health[key].slaStatus, "source_limited", "no public discovery feed must never be labelled hard/fully healthy");
    assert.equal(state._health[key].slaHardGuarantee, false);
  }
});

test("focus critical X keeps the complete Fx body when the verified oEmbed preview is truncated", async (t) => {
  const nowMs = Date.parse("2026-08-22T12:10:53.513Z");
  const dataDir = await fixture(t, {
    flapdotsh: { latestId: "2091135000000000000", checkedAt: "old" },
    fourdotmemezh: { latestId: "2091135000000000200", checkedAt: "old" },
  });
  const timelines = {
    flapdotsh: [{ ...FLAP_AGENTIC_WALLET_209113 }],
    fourdotmemezh: [{
      id: "2091135000000000201",
      text: "New launch: $DOG is live. Contract address: 0x1111111111111111111111111111111111111111",
      createdTimestamp: nowMs / 1_000 - 30,
    }],
  };
  const delivered = [];
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: false,
    focusCriticalXMonitorEnabled: true,
    focusCriticalXMaxAgeMs: 10 * 60 * 1_000,
    binanceCriticalXPollAllowanceMs: 1_000,
    binanceCriticalXLocalBudgetMs: 5_000,
    twitterApiBase: "https://ordinary-x-must-not-run.test",
    twitterFallbackApiBases: [],
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterPriorityPollConcurrency: 2,
  }), {
    autoStart: false,
    now: () => nowMs,
    logger: { error() {} },
    fetchImpl: criticalTestFetch(timelines),
    sendAlertsImpl: async (_config, event) => { delivered.push(event); return { status: "queued" }; },
  });

  await monitor.check();

  assert.equal(delivered.length, 1, "ordinary token launch noise must not pass the focus structural classifier");
  const [event] = delivered;
  assert.equal(event.project.id, "flap");
  assert.equal(event.project.criticalFastLane, true);
  assert.equal(event.project.criticalProfile, "focus_launchpad");
  assert.equal(event.signal.platformStructural, true);
  assert.equal(event.signal.reason, "agentic_skill_integration");
  assert.ok(event.signal.labels.includes("Agent/Skill 集成"));
  assert.equal(event.signal.criticalBinanceProduct, undefined);
  assert.equal(event.tweet.authorId, CRITICAL_TEST_ACCOUNTS.flapdotsh.userId);
  assert.equal(event.tweet.sourceVerifiedBy, "official_x_oembed");
  assert.equal(event.tweet.text, FLAP_AGENTIC_WALLET_209113.text);
  assert.match(event.tweet.text, /Step 5 — Launch a token quoted against a BStock/);
  assert.doesNotMatch(FLAP_AGENTIC_WALLET_209113.oembedText, /Flap token-launch skill|Step 5/);
  assert.deepEqual(event.deliverySla, {
    startedAt: new Date(nowMs).toISOString(),
    deadlineAt: new Date(nowMs + 4_000).toISOString(),
    budgetMs: 5_000,
    pollAllowanceMs: 1_000,
    basis: "critical_source_poll",
  });
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.flapdotsh.latestId, timelines.flapdotsh[0].id);
  assert.equal(state.fourdotmemezh.latestId, timelines.fourdotmemezh[0].id, "filtered noise still advances its durable cursor");
  assert.equal(state._health.flapdotsh.criticalVerification.identity, "fxtwitter_numeric_id+official_x_oembed");
});

test("focus critical X emits the real Flap bStock quote-pair structure after official oEmbed verification", async (t) => {
  const nowMs = Date.parse("2026-09-02T12:20:55.000Z");
  const dataDir = await fixture(t, {
    flapdotsh: { latestId: "2095124685788979000", checkedAt: "old" },
    fourdotmemezh: { latestId: "2095124685788979100", checkedAt: "old" },
  });
  const timelines = {
    flapdotsh: [{ ...FLAP_BSTOCK_PAIRS_209512 }],
    fourdotmemezh: [{
      id: "2095124685788979101",
      text: "Four.Meme community recap.",
      createdTimestamp: nowMs / 1_000 - 30,
    }],
  };
  const delivered = [];
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: false,
    focusCriticalXMonitorEnabled: true,
    focusCriticalXMaxAgeMs: 10 * 60 * 1_000,
    binanceCriticalXPollAllowanceMs: 1_000,
    binanceCriticalXLocalBudgetMs: 5_000,
    twitterFallbackApiBases: [],
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterPriorityPollConcurrency: 2,
  }), {
    autoStart: false,
    now: () => nowMs,
    logger: { error() {} },
    fetchImpl: criticalTestFetch(timelines),
    sendAlertsImpl: async (_config, event) => { delivered.push(event); return { status: "queued" }; },
  });

  await monitor.check();

  assert.equal(delivered.length, 1);
  const [event] = delivered;
  assert.equal(event.tweet.id, FLAP_BSTOCK_PAIRS_209512.id);
  assert.equal(event.tweet.authorId, CRITICAL_TEST_ACCOUNTS.flapdotsh.userId);
  assert.equal(event.tweet.sourceVerifiedBy, "official_x_oembed");
  assert.equal(event.signal.reason, "flap_bstock_quote_pair_announced");
  assert.deepEqual(event.signal.quotePairChange, {
    assetClass: "bstock_quote",
    stage: "announced",
    assets: [
      { symbol: "SOXLB", name: "Bull Semiconductors 3X ETF" },
      { symbol: "SOXSB", name: "Bear Semiconductors 3X ETF" },
    ],
  });
});

test("focus critical X emits Four.Meme named-mode lifecycle and strict market-campaign structures", async (t) => {
  const nowMs = Date.parse("2026-09-04T12:00:00.000Z");
  const listaId = "2095361508700258731";
  const campaignId = "2095713912188739967";
  const listaText = "Yield is now built into the launch.\n\nIntroducing ListaYield on http://Four.Meme — a new OpenFour mode powered by @lista_dao. \n\nEvery trade can route a share of trading tax into yield-bearing products, creating ongoing yield for eligible holders.\n\nAnd once the token graduates, liquidity moves to Lista DEX by default. 🧵";
  const campaignText = `bStocks szn just got competitive. 🟢

150,000 USDT is now live with @AveaiGlobal × @BNBCHAIN — including a 50,000 USDT leaderboard exclusively for http://Four.Meme traders.

Trade http://Four.Meme Stock Memes on http://Ave.ai.
Climb the Top 500.
Take your share.

The sprint is on. 🏁`;
  const dataDir = await fixture(t, {
    flapdotsh: { latestId: "2095000000000000000", checkedAt: "old" },
    fourdotmemezh: { latestId: "2095000000000000000", checkedAt: "old" },
  });
  const timelines = {
    flapdotsh: [{ id: "2095000000000000000", text: "Flap community recap.", createdTimestamp: nowMs / 1_000 - 30 }],
    fourdotmemezh: [
      { id: campaignId, text: campaignText, createdTimestamp: nowMs / 1_000 - 20 },
      { id: listaId, text: listaText, createdTimestamp: nowMs / 1_000 - 40 },
    ],
  };
  const delivered = [];
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: false,
    focusCriticalXMonitorEnabled: true,
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterFallbackApiBases: [],
  }), {
    autoStart: false,
    now: () => nowMs,
    logger: { error() {} },
    fetchImpl: criticalTestFetch(timelines),
    sendAlertsImpl: async (_config, event) => { delivered.push(event); return { status: "queued" }; },
  });

  await monitor.check();

  assert.deepEqual(delivered.map((event) => event.tweet.id), [listaId, campaignId]);
  assert.deepEqual(delivered[0].mode, {
    officialName: "ListaYield",
    componentMode: "ListaYield",
    parentMode: "OpenFour",
  });
  assert.deepEqual(delivered[0].productLifecycle, {
    product: "listayield",
    stage: "announced",
    key: "fourmeme:lifecycle:listayield:announced",
  });
  assert.equal(delivered[1].signal.marketCampaign.campaignKey, "fourmeme:market-campaign:bstock:aveaiglobal:50000-usdt:top-500");
  assert.equal(delivered[1].mode, undefined);
});

test("Four.Meme policy recovery runs exact X verification through T2 immediate outbox delivery", async (t) => {
  let clock = Date.parse("2026-09-04T09:00:00.000Z");
  const listaId = "2095361508700258731";
  const campaignId = "2095713912188739967";
  const listaText = "Yield is now built into the launch.\n\nIntroducing ListaYield on http://Four.Meme — a new OpenFour mode powered by @lista_dao. \n\nEvery trade can route a share of trading tax into yield-bearing products, creating ongoing yield for eligible holders.\n\nAnd once the token graduates, liquidity moves to Lista DEX by default. 🧵";
  const campaignText = `bStocks szn just got competitive. 🟢

150,000 USDT is now live with @AveaiGlobal × @BNBCHAIN — including a 50,000 USDT leaderboard exclusively for http://Four.Meme traders.

Trade http://Four.Meme Stock Memes on http://Ave.ai.
Climb the Top 500.
Take your share.

The sprint is on. 🏁`;
  const dataDir = await fixture(t, {
    flapdotsh: { latestId: "2095000000000000000", checkedAt: "old" },
    fourdotmemezh: { latestId: campaignId, checkedAt: "old" },
  });
  await fs.copyFile(
    new URL("./fixtures/four-listayield-suppressed-outbox.json", import.meta.url),
    path.join(dataDir, "alert-outbox.json"),
  );
  const timelines = {
    flapdotsh: [{
      id: "2095000000000000000",
      text: "Flap community recap.",
      createdTimestamp: Date.parse("2026-09-02T00:00:00.000Z") / 1_000,
    }],
    fourdotmemezh: [
      { id: campaignId, text: campaignText, createdTimestamp: Date.parse("2026-09-04T03:21:47.000Z") / 1_000 },
      { id: listaId, text: listaText, createdTimestamp: Date.parse("2026-09-03T04:01:28.000Z") / 1_000 },
    ],
  };
  const timelineFetch = criticalTestFetch(timelines);
  const fetchImpl = async (url) => {
    const value = String(url);
    const match = value.match(/^https:\/\/api\.fxtwitter\.test\/fourdotmemezh\/status\/(\d+)$/);
    if (!match) return timelineFetch(url);
    const tweet = timelines.fourdotmemezh.find((item) => item.id === match[1]);
    if (!tweet) return textResponse("", 404);
    return textResponse({
      code: 200,
      tweet: {
        id: tweet.id,
        text: tweet.text,
        created_timestamp: tweet.createdTimestamp,
        author: {
          id: CRITICAL_TEST_ACCOUNTS.fourdotmemezh.userId,
          name: "Four.meme-華語",
          screen_name: "fourdotmemezh",
        },
        url: `https://x.com/fourdotmemezh/status/${tweet.id}`,
        replying_to: null,
        replies: 0,
        retweets: 0,
        likes: 0,
        raw_text: {
          facets: (tweet.id === campaignId
            ? ["http://Four.Meme", "http://Ave.ai"]
            : ["http://Four.Meme"]
          ).map((replacement) => ({ type: "url", replacement })),
        },
      },
    });
  };
  const telegramPayloads = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    telegramPayloads.push(JSON.parse(options.body));
    return textResponse({ ok: true, result: { message_id: telegramPayloads.length } });
  });
  t.mock.method(console, "info", () => {});
  const monitor = createTwitterMonitor(config(dataDir, {
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: false,
    focusCriticalXMonitorEnabled: true,
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterFallbackApiBases: [],
    twitterPriorityPollConcurrency: 2,
    fourTwitterPolicyRecoveryEnabled: true,
    telegramToken: "test-bot-token-secret",
    telegramChatId: "1234567890",
    telegramStrongAlerts: false,
    alertBilingualEnabled: true,
    alertChineseTranslationEnabled: false,
    alertEnglishTranslationEnabled: false,
    blockedContracts: new Set(),
    alertNow: () => clock,
  }), {
    autoStart: false,
    now: () => clock,
    logger: { error() {}, info() {} },
    fetchImpl,
  });

  await monitor.check();
  clock += 5_001;
  await monitor.check();
  clock += 5_001;
  await monitor.check();

  assert.equal(telegramPayloads.length, 2, "each immutable missed tweet is recovered exactly once");
  assert.ok(telegramPayloads.every((payload) => /勿追价|do not chase/iu.test(payload.text)));
  assert.ok(telegramPayloads.every((payload) => payload.reply_markup.inline_keyboard[0][0].url
    === `https://x.com/fourdotmemezh/status/${payload.text.includes("ListaYield") ? listaId : campaignId}`));

  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  for (const tweetId of [listaId, campaignId]) {
    const id = `twitter:fourdotmemezh:${tweetId}:policy-fix-recovery:v1`;
    const entry = outbox.events[id];
    assert.equal(entry.status, "delivered");
    assert.deepEqual(entry.event.canonicalSignalIds, [`fourmeme:policy-fix-recovery:x:${tweetId}:v1`]);
    assert.equal(entry.event.tradingPriority.tier, "T2");
    assert.equal(entry.event.tradingPriority.category, "focus_policy_recovery");
    assert.equal(entry.event.tradingPriority.hardGates.t1Eligible, false);
    assert.equal(entry.event.tradingPriority.plan.automaticExecution, false);
    assert.match(entry.event.tradingPriority.plan.risk.zh, /勿追价/);
    assert.deepEqual(entry.deliveryDisposition, {
      mode: "immediate",
      deliverImmediately: true,
      tier: "T2",
      reason: "fourmeme_policy_fix_recovery",
    });
  }
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state._meta.policyFixRecovery.fourTwitterV1.items[listaId].status, "durably_accepted");
  assert.equal(state._meta.policyFixRecovery.fourTwitterV1.items[campaignId].status, "durably_accepted");
});

test("focus critical Jina discovery keeps the complete exact Fx body after truncated oEmbed verification", async (t) => {
  const nowMs = Date.parse("2026-08-22T12:10:53.513Z");
  const previousFlapId = "2091135000000000000";
  const fourId = "2091135000000000200";
  const jinaBase = "https://r.jina.ai/https://twitter.com/{handle}";
  const dataDir = await fixture(t, {
    flapdotsh: { latestId: previousFlapId, checkedAt: "old" },
    fourdotmemezh: { latestId: fourId, checkedAt: "old" },
  });
  const timeline = (id, account, text) => ({
    code: 200,
    results: [{
      id,
      text,
      created_timestamp: nowMs / 1_000 - 60,
      author: { id: account.userId, name: account.name, screen_name: account.handle },
      url: `https://x.com/${account.handle}/status/${id}`,
      replying_to: null,
      replies: 0,
      reposts: 0,
      likes: 0,
    }],
  });
  const requests = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    requests.push(value);
    if (value.includes(`/2/profile/id:${CRITICAL_TEST_ACCOUNTS.flapdotsh.userId}/statuses`)) {
      return textResponse(timeline(previousFlapId, CRITICAL_TEST_ACCOUNTS.flapdotsh, "Flap community recap."));
    }
    if (value.includes(`/2/profile/id:${CRITICAL_TEST_ACCOUNTS.fourdotmemezh.userId}/statuses`)) {
      return textResponse(timeline(fourId, CRITICAL_TEST_ACCOUNTS.fourdotmemezh, "Four.Meme community recap."));
    }
    if (value === "https://r.jina.ai/https://twitter.com/flapdotsh") {
      return textResponse({
        data: {
          content: `* [Flap](https://twitter.com/flapdotsh) [now](https://twitter.com/flapdotsh/status/${FLAP_AGENTIC_WALLET_209113.id}) ${FLAP_AGENTIC_WALLET_209113.oembedText}`,
        },
      });
    }
    if (value === "https://r.jina.ai/https://twitter.com/fourdotmemezh") return textResponse("", 503);
    if (value === `https://api.fxtwitter.test/flapdotsh/status/${FLAP_AGENTIC_WALLET_209113.id}`) {
      return textResponse({
        code: 200,
        tweet: {
          id: FLAP_AGENTIC_WALLET_209113.id,
          text: FLAP_AGENTIC_WALLET_209113.text,
          raw_text: { text: FLAP_AGENTIC_WALLET_209113.text, facets: [] },
          created_timestamp: FLAP_AGENTIC_WALLET_209113.createdTimestamp,
          author: {
            id: CRITICAL_TEST_ACCOUNTS.flapdotsh.userId,
            name: CRITICAL_TEST_ACCOUNTS.flapdotsh.name,
            screen_name: CRITICAL_TEST_ACCOUNTS.flapdotsh.handle,
          },
          url: `https://x.com/flapdotsh/status/${FLAP_AGENTIC_WALLET_209113.id}`,
          replying_to: null,
          replies: 0,
          retweets: 0,
          reposts: 0,
          likes: 0,
          reposted_by: null,
        },
      });
    }
    if (value.startsWith("https://publish.x.com/oembed")
      && new URL(value).searchParams.get("url") === `https://x.com/flapdotsh/status/${FLAP_AGENTIC_WALLET_209113.id}`) {
      return textResponse({
        url: `https://x.com/flapdotsh/status/${FLAP_AGENTIC_WALLET_209113.id}`,
        author_url: "https://x.com/flapdotsh",
        author_name: "Flap",
        html: `<blockquote><p>${FLAP_AGENTIC_WALLET_209113.oembedText}</p><a href="https://x.com/flapdotsh/status/${FLAP_AGENTIC_WALLET_209113.id}">August 22, 2026</a></blockquote>`,
      });
    }
    throw new Error(`unexpected focus critical-X request: ${value}`);
  };
  const delivered = [];
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: false,
    focusCriticalXMonitorEnabled: true,
    focusCriticalXMaxAgeMs: 10 * 60 * 1_000,
    twitterApiBase: "",
    twitterFallbackApiBases: [jinaBase],
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterJinaMinIntervalMs: 300_000,
    twitterPriorityPollConcurrency: 2,
  }), {
    autoStart: false,
    now: () => nowMs,
    logger: { error() {} },
    fetchImpl,
    sendAlertsImpl: async (_config, event) => { delivered.push(event); return { status: "queued" }; },
  });

  await monitor.check();

  assert.equal(delivered.length, 1);
  const [event] = delivered;
  assert.equal(event.tweet.id, FLAP_AGENTIC_WALLET_209113.id);
  assert.equal(event.tweet.text, FLAP_AGENTIC_WALLET_209113.text);
  assert.equal(event.tweet.sourceVerifiedBy, "official_x_oembed");
  assert.equal(event.tweet.identityVerifiedBy, "fxtwitter_exact_numeric_id");
  assert.equal(event.tweet.discoveredBy, "jina_twitter_profile");
  assert.equal(event.signal.reason, "agentic_skill_integration");
  assert.ok(event.signal.labels.includes("Agent/Skill 集成"));
  assert.ok(requests.includes(`https://api.fxtwitter.test/flapdotsh/status/${FLAP_AGENTIC_WALLET_209113.id}`));
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.flapdotsh.latestId, FLAP_AGENTIC_WALLET_209113.id);
});

test("focus critical X silently advances a structural post older than ten minutes", async (t) => {
  const nowMs = Date.parse("2026-08-20T10:10:00.000Z");
  const dataDir = await fixture(t, {
    flapdotsh: { latestId: "2090500000000000300", checkedAt: "old" },
    fourdotmemezh: { latestId: "2090500000000000400", checkedAt: "old" },
  });
  const timelines = {
    flapdotsh: [{
      id: "2090500000000000301",
      text: "Flap introduces a new Vault V2 module on mainnet.",
      createdTimestamp: nowMs / 1_000 - 11 * 60,
    }],
    fourdotmemezh: [{
      id: "2090500000000000400",
      text: "Four.Meme community recap.",
      createdTimestamp: nowMs / 1_000 - 60,
    }],
  };
  const delivered = [];
  const requests = [];
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: false,
    focusCriticalXMonitorEnabled: true,
    focusCriticalXMaxAgeMs: 10 * 60 * 1_000,
    twitterFallbackApiBases: [],
    twitterDirectXEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterPriorityPollConcurrency: 2,
  }), {
    autoStart: false,
    now: () => nowMs,
    logger: { error() {} },
    fetchImpl: criticalTestFetch(timelines, requests),
    sendAlertsImpl: async (_config, event) => { delivered.push(event); return { status: "queued" }; },
  });

  await monitor.check();

  assert.equal(delivered.length, 0);
  assert.equal(requests.some((url) => url.startsWith("https://publish.x.com/oembed") && url.includes(timelines.flapdotsh[0].id)), false);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.flapdotsh.latestId, timelines.flapdotsh[0].id, "stale backlog must be retired without Telegram replay");
});

test("focus critical X fails closed when either numeric identity or official oEmbed identity is forged", async (t) => {
  const nowMs = Date.parse("2026-08-20T10:10:00.000Z");
  for (const mutation of [
    { name: "Fx numeric author", authorId: "999" },
    { name: "official oEmbed author", oembedAuthorHandle: "attacker" },
  ]) {
    const dataDir = await fixture(t, {
      flapdotsh: { latestId: "2090500000000000500", checkedAt: "old" },
      fourdotmemezh: { latestId: "2090500000000000600", checkedAt: "old" },
    });
    const timelines = {
      flapdotsh: [{
        id: "2090500000000000501",
        text: "Flap introduces a new Vault V2 module on mainnet.",
        createdTimestamp: nowMs / 1_000 - 30,
        ...mutation,
      }],
      fourdotmemezh: [{
        id: "2090500000000000600",
        text: "Four.Meme community recap.",
        createdTimestamp: nowMs / 1_000 - 60,
      }],
    };
    const delivered = [];
    const monitor = createTwitterMonitor(config(dataDir, {
      twitterMonitorEnabled: false,
      binanceCriticalXMonitorEnabled: false,
      focusCriticalXMonitorEnabled: true,
      twitterFallbackApiBases: [],
      twitterDirectXEnabled: false,
      twitterFxTwitterEnabled: true,
      twitterFxTwitterApiBase: "https://api.fxtwitter.test",
      twitterPriorityPollConcurrency: 2,
    }), {
      autoStart: false,
      now: () => nowMs,
      logger: { error() {} },
      fetchImpl: criticalTestFetch(timelines),
      sendAlertsImpl: async (_config, event) => { delivered.push(event); return { status: "queued" }; },
    });

    await monitor.check();

    assert.equal(delivered.length, 0, mutation.name);
    const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
    assert.equal(state.flapdotsh.latestId, "2090500000000000500", `${mutation.name} must not advance the cursor`);
    assert.equal(state._health.flapdotsh.status, "error");
    assert.equal(state._health.flapdotsh.slaStatus, "source_limited");
  }
});

test("tracks the active official Four.Meme X account", () => {
  assert.equal(OFFICIAL_TWITTER_TARGETS.some(({ handle }) => handle.toLowerCase() === "fourdotmemezh"), true);
  assert.equal(OFFICIAL_TWITTER_TARGETS.some(({ handle }) => handle.toLowerCase() === "four_meme_"), false);
  assert.equal(OFFICIAL_TWITTER_TARGETS.find(({ handle }) => handle === "fourdotmemezh")?.xUserId, "1816036559864619011");
});

test("uses first-party X SSR first for immutable verified priority accounts", async (t) => {
  const previousId = "2084600000000000000";
  const currentId = "2084610000000000000";
  const oldJina = "https://r.jina.ai/https://twitter.com/{handle}";
  const dataDir = await fixture(t, {
    fourdotmemezh: { latestId: previousId, checkedAt: "old" },
    _health: {
      fourdotmemezh: {
        status: "degraded",
        activeSource: oldJina,
        sources: { [oldJina]: { status: "healthy", nextPollAt: "2099-01-01T00:00:00.000Z" } },
      },
    },
  });
  const delivered = [];
  const fourRequests = [];
  const monitor = createTwitterMonitor(config(dataDir, { twitterDirectXEnabled: true }), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    fetchImpl: async (url) => {
      if (url.includes("fourdotmemezh")) fourRequests.push(url);
      if (url === "https://x.com/fourdotmemezh") {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => directTimelineHtml("fourdotmemezh", "1816036559864619011", [
            { id: currentId, text: "New launchpad contract deployed and V2 is live" },
            { id: previousId, text: "Earlier post" },
          ]),
        };
      }
      return response();
    },
  });

  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.deepEqual(delivered.map((event) => event.tweet.id), [currentId]);
  assert.deepEqual(fourRequests, ["https://x.com/fourdotmemezh"]);
  assert.equal(state._health.fourdotmemezh.status, "healthy");
  assert.equal(state._health.fourdotmemezh.activeSourceId, "x_direct_ssr");
});

test("does not advance from a shallow direct X page that no longer covers the durable cursor", async (t) => {
  const previousId = "2084600000000000000";
  const currentId = "2084610000000000000";
  const dataDir = await fixture(t, { fourdotmemezh: { latestId: previousId, checkedAt: "old" } });
  const delivered = [];
  const monitor = createTwitterMonitor(config(dataDir, { twitterDirectXEnabled: true }), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    fetchImpl: async (url) => {
      if (url === "https://x.com/fourdotmemezh") {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => directTimelineHtml("fourdotmemezh", "1816036559864619011", [
            { id: currentId, text: "New launchpad contract deployed and V2 is live" },
          ]),
        };
      }
      if (url === "https://primary.test/timeline/fourdotmemezh") {
        return response({ handle: "fourdotmemezh", tweets: [
          { id: currentId, text: "New launchpad contract deployed and V2 is live" },
          { id: previousId, text: "Earlier post" },
        ] });
      }
      return response();
    },
  });

  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.deepEqual(delivered.map((event) => event.tweet.id), [currentId]);
  assert.equal(state._health.fourdotmemezh.activeSourceId, "syndication");
  assert.match(state._health.fourdotmemezh.sources["https://x.com/{handle}"].lastError, /does not cover the durable cursor/);
});

test("silently baselines official prelaunch BSC launchpad accounts", () => {
  const official = new Map(OFFICIAL_TWITTER_TARGETS.map((target) => [target.handle.toLowerCase(), target]));
  assert.equal(official.get("bltxdotfun")?.baselineOnFirstSeen, true);
  assert.equal(official.get("fabibsc")?.baselineOnFirstSeen, true);
  assert.equal(official.get("bltxdotfun")?.priority, false);
  assert.equal(official.get("fabibsc")?.priority, false);
});

test("polls Four.Meme and Flap as independent priority accounts while Pons is standard", async (t) => {
  const official = new Map(OFFICIAL_TWITTER_TARGETS.map((target) => [target.handle, target]));
  assert.equal(official.get("fourdotmemezh")?.priority, true);
  assert.equal(official.get("flapdotsh")?.priority, true);
  assert.equal(official.get("ponsdotfamily")?.priority, false);

  const dataDir = await fixture(t, {
    _meta: { cursor: 0, retryAfter: "2099-01-01T00:00:00.000Z" },
    fourdotmemezh: { latestId: "100", checkedAt: "old" },
    flapdotsh: { latestId: "100", checkedAt: "old" },
    ponsdotfamily: { latestId: "100", checkedAt: "old" },
  });
  const requested = [];
  const monitor = createTwitterMonitor(config(dataDir), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async () => {},
    fetchImpl: async (url) => {
      requested.push(url);
      if (url.endsWith("/fourdotmemezh")) return response({ status: 429, retryAfter: "60" });
      if (url.endsWith("/flapdotsh")) return response({ handle: "flapdotsh", tweets: [{ id: "101", text: "Good morning" }] });
      if (url.endsWith("/ponsdotfamily")) return response({ handle: "ponsdotfamily", tweets: [{ id: "101", text: "Good morning" }] });
      return response();
    },
  });

  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(requested.some((url) => url.endsWith("/fourdotmemezh")), true);
  assert.equal(requested.some((url) => url.endsWith("/flapdotsh")), true);
  assert.equal(state.fourdotmemezh.latestId, "100", "429 must not advance the Four.Meme tweet cursor");
  assert.equal(state.flapdotsh.latestId, "101", "Flap must keep polling despite another account's 429");
  assert.equal(state._health.fourdotmemezh.status, "backoff");
  assert.equal(state._health.flapdotsh.status, "healthy");
  assert.equal("retryAfter" in state._meta, false, "legacy global cooldown must be removed");
});

test("polls three standard accounts concurrently and fairly rotates the next batch", async (t) => {
  const dataDir = await fixture(t, { _meta: { cursor: 0 } });
  const priorityHandles = new Set(OFFICIAL_TWITTER_TARGETS
    .filter(({ priority }) => priority)
    .map(({ handle }) => handle.toLowerCase()));
  const standardByRound = [[], []];
  let round = 0;
  let activeStandard = 0;
  let maximumActiveStandard = 0;
  const monitor = createTwitterMonitor(config(dataDir, { twitterStandardPollConcurrency: 3 }), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async () => {},
    fetchImpl: async (url) => {
      const handle = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1));
      if (!priorityHandles.has(handle.toLowerCase())) {
        standardByRound[round].push(handle.toLowerCase());
        activeStandard += 1;
        maximumActiveStandard = Math.max(maximumActiveStandard, activeStandard);
        await new Promise((resolve) => setImmediate(resolve));
        activeStandard -= 1;
      }
      return response({ handle, tweets: [{ id: String(101 + round), text: "Good morning" }] });
    },
  });

  await monitor.check();
  round = 1;
  await monitor.check();

  assert.equal(new Set(standardByRound[0]).size, 3);
  assert.equal(new Set(standardByRound[1]).size, 3);
  assert.equal(maximumActiveStandard, 3, "the configured standard batch must actually run concurrently");
  assert.deepEqual(
    standardByRound[1].filter((handle) => standardByRound[0].includes(handle)),
    [],
    "the durable scheduler cursor must offer the next accounts before wrapping",
  );
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state._meta.cursor, 6);
});

test("one failed standard account does not block the other cursors or the fair scheduler", async (t) => {
  const seededAccounts = Object.fromEntries(OFFICIAL_TWITTER_TARGETS
    .filter(({ priority }) => !priority)
    .map(({ handle }) => [handle.toLowerCase(), { latestId: "100", checkedAt: "old" }]));
  const dataDir = await fixture(t, {
    _meta: { cursor: 0 },
    ...seededAccounts,
    unrelated: { latestId: "777", checkedAt: "keep" },
  });
  const priorityHandles = new Set(OFFICIAL_TWITTER_TARGETS
    .filter(({ priority }) => priority)
    .map(({ handle }) => handle.toLowerCase()));
  const attempted = [];
  let failedHandle = null;
  const monitor = createTwitterMonitor(config(dataDir, { twitterStandardPollConcurrency: 3 }), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async () => {},
    fetchImpl: async (url) => {
      const handle = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1));
      const normalized = handle.toLowerCase();
      if (!priorityHandles.has(normalized)) {
        attempted.push(normalized);
        failedHandle ||= normalized;
        if (normalized === failedHandle) return response({ status: 503 });
      }
      return response({ handle, tweets: [{ id: "101", text: "Good morning" }] });
    },
  });

  await monitor.check();

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(new Set(attempted).size, 3);
  assert.equal(state[failedHandle].latestId, "100", "a failed account must keep its own durable tweet cursor");
  for (const handle of attempted.filter((candidate) => candidate !== failedHandle)) {
    assert.equal(state[handle].latestId, "101", `@${handle} must advance despite the peer failure`);
  }
  assert.equal(state._health[failedHandle].status, "error");
  assert.equal(state._meta.cursor, 3, "the shared scheduler must advance past the failed account");
  assert.deepEqual(state.unrelated, { latestId: "777", checkedAt: "keep" }, "concurrent snapshots must preserve unrelated account state");
});

test("an overlapping scheduler tick is coalesced into an immediate follow-up cycle", async (t) => {
  const dataDir = await fixture(t, Object.fromEntries(OFFICIAL_TWITTER_TARGETS.map(({ handle }) => [
    handle.toLowerCase(),
    { latestId: "100", checkedAt: "old" },
  ])));
  let flapRequests = 0;
  let releaseFirstFlap;
  const firstFlapBlocked = new Promise((resolve) => { releaseFirstFlap = resolve; });
  let firstFlapStarted;
  const flapStarted = new Promise((resolve) => { firstFlapStarted = resolve; });
  let releaseSecondFlap;
  const secondFlapBlocked = new Promise((resolve) => { releaseSecondFlap = resolve; });
  let secondFlapStarted;
  const secondFlapStart = new Promise((resolve) => { secondFlapStarted = resolve; });
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterPriorityPollConcurrency: 20,
    twitterStandardPollConcurrency: 20,
  }), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async () => ({ status: "queued" }),
    fetchImpl: async (url) => {
      const handle = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1));
      if (handle.toLowerCase() === "flapdotsh") {
        flapRequests += 1;
        if (flapRequests === 1) {
          firstFlapStarted();
          await firstFlapBlocked;
        } else if (flapRequests === 2) {
          secondFlapStarted();
          await secondFlapBlocked;
        }
      }
      return response({ handle, tweets: [{ id: "100", text: "Good morning" }] });
    },
  });

  const first = monitor.check();
  await flapStarted;
  const overlapped = monitor.check();
  releaseFirstFlap();
  await secondFlapStart;
  const duringCatchup = monitor.check();
  releaseSecondFlap();
  await Promise.all([first, overlapped, duringCatchup]);
  assert.equal(flapRequests, 2, "overlap during the catch-up must wait for the next scheduled cycle");
});

test("FxTwitter cadence is five seconds start-to-start without overlapping a slow poll", async (t) => {
  const epoch = Date.parse("2026-08-12T12:00:00Z");
  let current = epoch;
  const focusTargets = OFFICIAL_TWITTER_TARGETS.filter(({ id }) => [
    "flap", "long", "fourmeme", "uniswap", "uniswap-pools",
  ].includes(id));
  const byUserId = new Map(focusTargets.map((target) => [target.xUserId, target]));
  const dataDir = await fixture(t, Object.fromEntries(focusTargets.map(({ handle }) => [
    handle.toLowerCase(),
    { latestId: "100", checkedAt: "old" },
  ])));
  const flapStarts = [];
  let releaseFirstFlap;
  const firstFlapBlocked = new Promise((resolve) => { releaseFirstFlap = resolve; });
  let firstFlapStarted;
  const flapStarted = new Promise((resolve) => { firstFlapStarted = resolve; });
  const monitor = createTwitterMonitor(config(dataDir, {
    monitorScope: "focus3",
    ponsMonitorEnabled: false,
    twitterFxTwitterEnabled: true,
    twitterFxTwitterApiBase: "https://api.fxtwitter.test",
    twitterFxTwitterMinIntervalMs: 1_000,
    twitterCriticalFxTwitterMinIntervalMs: 1_000,
    twitterPriorityPollConcurrency: 12,
  }), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    sendAlertsImpl: async () => ({ status: "queued" }),
    fetchImpl: async (url) => {
      const userId = String(url).match(/\/id:(\d+)\/statuses/)?.[1];
      const target = byUserId.get(userId);
      if (!target) throw new Error(`unexpected X source: ${url}`);
      if (target.id === "flap") {
        flapStarts.push(current);
        if (flapStarts.length === 1) {
          firstFlapStarted();
          await firstFlapBlocked;
        }
      }
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        text: async () => JSON.stringify({
          code: 200,
          results: [{
            id: "100",
            text: "Good morning.",
            url: `https://x.com/${target.handle}/status/100`,
            author: { id: target.xUserId, screen_name: target.handle, name: target.name },
            replying_to: null,
            reposted_by: null,
          }],
        }),
      };
    },
  });

  const first = monitor.check();
  await flapStarted;
  const overlapped = monitor.check();
  current = epoch + 1_500;
  releaseFirstFlap();
  await Promise.all([first, overlapped]);

  let state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  const flapSource = "https://api.fxtwitter.test/2/profile/id:{userId}/statuses?count=40";
  assert.equal(flapStarts.length, 1, "a coalesced tick must not overlap the in-flight FxTwitter poll");
  assert.equal(
    state._health.flapdotsh.sources[flapSource].nextPollAt,
    new Date(epoch + 5_000).toISOString(),
    "the hard five-second floor must be anchored to request start, even if configured lower",
  );

  current = epoch + 4_999;
  await monitor.check();
  assert.equal(flapStarts.length, 1, "the source must stay idle before the five-second start boundary");

  current = epoch + 5_000;
  await monitor.check();
  assert.deepEqual(flapStarts, [epoch, epoch + 5_000]);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.flapdotsh.latestId, "100", "cadence scheduling must not disturb the durable tweet cursor");
});

test("Twitter control projection coalesces only steady telemetry fields", () => {
  const baseline = {
    binance: { latestId: "100", checkedAt: "2026-08-24T00:00:00.000Z", profile: { handle: "binance" } },
    _health: {
      binance: {
        status: "healthy",
        activeSource: "fx",
        consecutiveFailures: 0,
        checkedAt: "2026-08-24T00:00:00.000Z",
        lastSuccessAt: "2026-08-24T00:00:00.000Z",
        sources: {
          fx: {
            status: "healthy",
            circuitState: "closed",
            checkedAt: "2026-08-24T00:00:00.000Z",
            nextPollAt: "2026-08-24T00:00:05.000Z",
            latencyMs: 20,
          },
        },
        criticalVerification: { status: "healthy", identity: "numeric+oembed", verifiedCandidates: 1 },
      },
    },
    _meta: { cursor: 0, health: { status: "healthy", checkedAt: "2026-08-24T00:00:00.000Z" } },
  };
  const telemetryOnly = structuredClone(baseline);
  telemetryOnly.binance.checkedAt = "2026-08-24T00:00:30.000Z";
  telemetryOnly._health.binance.checkedAt = "2026-08-24T00:00:30.000Z";
  telemetryOnly._health.binance.lastSuccessAt = "2026-08-24T00:00:30.000Z";
  telemetryOnly._health.binance.sources.fx.nextPollAt = "2026-08-24T00:00:35.000Z";
  telemetryOnly._health.binance.sources.fx.latencyMs = 35;
  telemetryOnly._health.binance.criticalVerification.verifiedCandidates = 2;
  telemetryOnly._meta.health.checkedAt = "2026-08-24T00:00:30.000Z";
  assert.equal(twitterStateControlKey(telemetryOnly), twitterStateControlKey(baseline));

  for (const mutate of [
    (state) => { state.binance.latestId = "101"; },
    (state) => { state._health.binance.status = "backoff"; },
    (state) => { state._health.binance.lastError = "HTTP 429"; },
    (state) => { state._health.binance.consecutiveFailures = 1; },
    (state) => { state._health.binance.sources.fx.circuitUntil = "2026-08-24T00:15:00.000Z"; },
    (state) => { state._health.binance.retryAfter = "2026-08-24T00:15:00.000Z"; },
    (state) => { state._health.binance.criticalVerification.identity = "forged"; },
    (state) => { state._meta.cursor = 1; },
  ]) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.notEqual(twitterStateControlKey(changed), twitterStateControlKey(baseline));
  }
});

test("critical fast lane keeps request cadence while whole-state telemetry writes stay on a 30-second budget", async (t) => {
  const epoch = Date.parse("2026-08-24T10:00:00.000Z");
  let current = epoch;
  const timers = fakeTimeoutScheduler(() => current);
  const dataDir = await fixture(t);
  const requests = [];
  const writes = [];
  const monitor = createTwitterMonitor(criticalOnlyConfig(dataDir), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    fetchImpl: criticalTestFetch(steadyCriticalTimelines(epoch), requests),
    sendAlertsImpl: async () => ({ status: "queued" }),
    twitterTelemetrySetTimeoutImpl: timers.set,
    twitterTelemetryClearTimeoutImpl: timers.clear,
    twitterStateRetrySetTimeoutImpl: timers.set,
    twitterStateRetryClearTimeoutImpl: timers.clear,
    twitterStateAtomicWriteImpl: async (file, snapshot, metadata) => {
      writes.push({ at: current, kind: metadata.kind });
      await atomicWriteTwitterState(file, snapshot, fs, metadata);
    },
  });

  await monitor.check();
  assert.ok(requests.length >= 4, "all four immutable critical accounts must be polled");
  requests.length = 0;
  writes.length = 0;

  for (let seconds = 1; seconds <= 120; seconds += 1) {
    current = epoch + seconds * 1_000;
    await timers.runDue();
    await monitor.check();
  }

  assert.equal(
    requests.filter((url) => url.includes("/2/profile/id:")).length,
    4 * 24,
    "all four numeric-ID timelines must retain their five-second source cadence",
  );
  assert.ok(writes.length <= 4, `expected no more than four steady writes, observed ${writes.length}`);
  assert.ok(writes.every(({ kind }) => kind === "telemetry"));
  assert.ok([...timers.tasks.values()].every((timer) => timer.unrefed), "deferred persistence timers must be unref'ed");
  await monitor.stop();
});

test("a failed Twitter state rename keeps the newest telemetry pending and retries without tmp leakage", async (t) => {
  const epoch = Date.parse("2026-08-24T11:00:00.000Z");
  let current = epoch;
  const timers = fakeTimeoutScheduler(() => current);
  const dataDir = await fixture(t);
  let failNextRename = false;
  let renameFailures = 0;
  let attempts = 0;
  let resolveRenameFailure;
  let resolveRetryScheduled;
  let resolveSecondAttempt;
  const renameFailureObserved = new Promise((resolve) => { resolveRenameFailure = resolve; });
  const retryScheduled = new Promise((resolve) => { resolveRetryScheduled = resolve; });
  const secondAttemptObserved = new Promise((resolve) => { resolveSecondAttempt = resolve; });
  const fsWithRenameFailure = {
    mkdir: (...args) => fs.mkdir(...args),
    writeFile: (...args) => fs.writeFile(...args),
    rename: async (...args) => {
      if (failNextRename) {
        failNextRename = false;
        renameFailures += 1;
        resolveRenameFailure();
        throw Object.assign(new Error("simulated Twitter state rename failure"), { code: "EIO" });
      }
      return fs.rename(...args);
    },
    chmod: (...args) => fs.chmod(...args),
    rm: (...args) => fs.rm(...args),
  };
  const monitor = createTwitterMonitor(criticalOnlyConfig(dataDir), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    fetchImpl: criticalTestFetch(steadyCriticalTimelines(epoch)),
    sendAlertsImpl: async () => ({ status: "queued" }),
    twitterTelemetrySetTimeoutImpl: timers.set,
    twitterTelemetryClearTimeoutImpl: timers.clear,
    twitterStateRetrySetTimeoutImpl: (callback, delay) => {
      const handle = timers.set(callback, delay);
      resolveRetryScheduled(handle);
      return handle;
    },
    twitterStateRetryClearTimeoutImpl: timers.clear,
    twitterStateAtomicWriteImpl: async (file, snapshot, metadata) => {
      attempts += 1;
      if (attempts === 2) resolveSecondAttempt();
      await atomicWriteTwitterState(file, snapshot, fsWithRenameFailure, metadata);
    },
  });

  await monitor.check();
  attempts = 0;
  current = epoch + 5_000;
  await monitor.check();
  failNextRename = true;
  current = epoch + 60_000;
  await timers.runDue();
  await renameFailureObserved;
  assert.equal(renameFailures, 1);
  assert.equal(attempts, 1);

  const retryHandle = await retryScheduled;
  current = Math.max(current, retryHandle.dueAt);
  await timers.runDue();
  await secondAttemptObserved;
  assert.equal(attempts, 2, "the failed latest revision must be retried");
  await monitor.stop();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state._health.binance.checkedAt, new Date(epoch + 5_000).toISOString());
  assert.equal((await fs.stat(path.join(dataDir, "twitter-state.json"))).mode & 0o777, 0o600);
  assert.equal((await fs.readdir(dataDir)).some((name) => name.endsWith(".tmp")), false);
});

test("same-millisecond durable X error wins over an already queued healthy telemetry write", async (t) => {
  const epoch = Date.parse("2026-08-24T12:00:00.000Z");
  let current = epoch;
  let failRequests = false;
  let blockTelemetry = false;
  let releaseTelemetry;
  let telemetryStarted;
  const telemetryGate = new Promise((resolve) => { releaseTelemetry = resolve; });
  const telemetryStart = new Promise((resolve) => { telemetryStarted = resolve; });
  const timers = fakeTimeoutScheduler(() => current);
  const dataDir = await fixture(t);
  const healthyFetch = criticalTestFetch(steadyCriticalTimelines(epoch));
  const monitor = createTwitterMonitor(criticalOnlyConfig(dataDir), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    fetchImpl: async (url) => failRequests
      ? response({ status: 429, retryAfter: "60" })
      : healthyFetch(url),
    sendAlertsImpl: async () => ({ status: "queued" }),
    twitterTelemetrySetTimeoutImpl: timers.set,
    twitterTelemetryClearTimeoutImpl: timers.clear,
    twitterStateRetrySetTimeoutImpl: timers.set,
    twitterStateRetryClearTimeoutImpl: timers.clear,
    twitterStateAtomicWriteImpl: async (file, snapshot, metadata) => {
      if (metadata.kind === "telemetry" && blockTelemetry) {
        telemetryStarted();
        await telemetryGate;
      }
      await atomicWriteTwitterState(file, snapshot, fs, metadata);
    },
  });

  await monitor.check();
  current = epoch + 5_000;
  await monitor.check();
  current = epoch + 30_000;
  blockTelemetry = true;
  const due = timers.runDue();
  await telemetryStart;
  failRequests = true;
  const failingCheck = monitor.check();
  await new Promise((resolve) => setImmediate(resolve));
  releaseTelemetry();
  await Promise.all([due, failingCheck]);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state._health.binance.status, "backoff");
  assert.match(state._health.binance.lastError, /429|backoff/i);
  assert.equal(state._health.binance.sources["https://api.fxtwitter.test/2/profile/id:{userId}/statuses?count=40"].circuitState, "open");
  await monitor.stop();
});

test("Twitter stop waits for an active poll, flushes its telemetry, and prevents later checks", async (t) => {
  const epoch = Date.parse("2026-08-24T13:00:00.000Z");
  let current = epoch;
  let blockFlap = false;
  let releaseFlap;
  let flapStarted;
  const flapGate = new Promise((resolve) => { releaseFlap = resolve; });
  const flapStart = new Promise((resolve) => { flapStarted = resolve; });
  const timers = fakeTimeoutScheduler(() => current);
  const dataDir = await fixture(t);
  const requests = [];
  const healthyFetch = criticalTestFetch(steadyCriticalTimelines(epoch), requests);
  const monitor = createTwitterMonitor(criticalOnlyConfig(dataDir), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    fetchImpl: async (url) => {
      if (blockFlap && String(url).includes(`/id:${CRITICAL_TEST_ACCOUNTS.flapdotsh.userId}/statuses`)) {
        flapStarted();
        await flapGate;
      }
      return healthyFetch(url);
    },
    sendAlertsImpl: async () => ({ status: "queued" }),
    twitterTelemetrySetTimeoutImpl: timers.set,
    twitterTelemetryClearTimeoutImpl: timers.clear,
    twitterStateRetrySetTimeoutImpl: timers.set,
    twitterStateRetryClearTimeoutImpl: timers.clear,
  });

  await monitor.check();
  current = epoch + 5_000;
  blockFlap = true;
  const active = monitor.check();
  await flapStart;
  let stopped = false;
  const stopRequest = monitor.stop();
  const stopping = stopRequest.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false, "stop must wait for the active source request");
  releaseFlap();
  await Promise.all([active, stopping]);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state._health.flapdotsh.checkedAt, new Date(epoch + 5_000).toISOString());
  assert.equal(timers.tasks.size, 0, "stop must clear telemetry and retry timers");
  const requestCount = requests.length;
  await monitor.check();
  assert.equal(requests.length, requestCount, "checks after stop must not start a new poll");
  assert.equal(monitor.stop(), stopRequest, "stop must be async and idempotent");
});

test("Twitter stop still clears timers and retries the latest state when the active poll rejects", async (t) => {
  const epoch = Date.parse("2026-08-24T14:00:00.000Z");
  let current = epoch;
  let failRequests = false;
  let failWrites = false;
  let writeAttempts = 0;
  const timers = fakeTimeoutScheduler(() => current);
  const dataDir = await fixture(t);
  const healthyFetch = criticalTestFetch(steadyCriticalTimelines(epoch));
  const monitor = createTwitterMonitor(criticalOnlyConfig(dataDir), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    fetchImpl: async (url) => failRequests
      ? response({ status: 429, retryAfter: "60" })
      : healthyFetch(url),
    sendAlertsImpl: async () => ({ status: "queued" }),
    twitterTelemetrySetTimeoutImpl: timers.set,
    twitterTelemetryClearTimeoutImpl: timers.clear,
    twitterStateRetrySetTimeoutImpl: timers.set,
    twitterStateRetryClearTimeoutImpl: timers.clear,
    twitterStateAtomicWriteImpl: async (file, snapshot, metadata) => {
      writeAttempts += 1;
      if (failWrites) throw Object.assign(new Error("simulated persistent state write failure"), { code: "EIO" });
      await atomicWriteTwitterState(file, snapshot, fs, metadata);
    },
  });

  await monitor.check();
  writeAttempts = 0;
  current = epoch + 5_000;
  failRequests = true;
  failWrites = true;
  const active = monitor.check();
  let activeRejected = false;
  const observedActive = active.catch(() => {
    activeRejected = true;
    failWrites = false;
  });
  await Promise.all([observedActive, monitor.stop()]);

  assert.equal(activeRejected, true, "the injected active-cycle persistence failure must reach the scheduler boundary");
  assert.ok(writeAttempts >= 2, "stop must retry the highest failed revision after the active poll settles");
  assert.equal(timers.tasks.size, 0);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state._health.binance.status, "backoff");
  assert.match(state._health.binance.lastError, /429|backoff/i);
});

test("Twitter atomic state replacement creates both temporary and final files as 0600", async (t) => {
  const dataDir = await fixture(t);
  const stateFile = path.join(dataDir, "twitter-state.json");
  await fs.writeFile(stateFile, "{}\n", { mode: 0o644 });
  await fs.chmod(stateFile, 0o644);
  const modes = [];
  const recordingFs = {
    mkdir: (...args) => fs.mkdir(...args),
    writeFile: async (file, value, options) => {
      modes.push({ file, mode: options?.mode });
      return fs.writeFile(file, value, options);
    },
    rename: (...args) => fs.rename(...args),
    chmod: (...args) => fs.chmod(...args),
    rm: (...args) => fs.rm(...args),
  };
  await atomicWriteTwitterState(stateFile, "{\"version\":1}\n", recordingFs, { suffix: "permissions" });
  assert.equal(modes.length, 1);
  assert.equal(modes[0].mode, 0o600);
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
  assert.equal((await fs.readdir(dataDir)).some((name) => name.endsWith(".tmp")), false);
});

test("normalizes relative syndication permalinks to absolute X URLs", () => {
  const [tweet] = parseTimelineHtml(timelineHtml("flapdotsh", [{
    id: "2083771650500182333",
    text: "BTCB is now a quote token",
    permalink: "/flapdotsh/status/2083771650500182333",
  }]), "flapdotsh");
  assert.equal(tweet.url, "https://x.com/flapdotsh/status/2083771650500182333");
});

test("Jina Reader accepts only exact-handle status links from data.content and drops pinned duplicates", () => {
  const pinnedId = "2083100000000000000";
  const currentId = "2084610000000000000";
  const imageOnlyId = "2084620000000000000";
  const payload = {
    data: {
      content: [
        `* Pinned [Four](https://x.com/fourdotmemezh) [Jul 31](https://x.com/fourdotmemezh/status/${pinnedId}) V2 contract deployed`,
        `* [Four](https://x.com/fourdotmemezh) [2h](https://x.com/fourdotmemezh/status/${currentId}) New launchpad contract deployed and V2 is live`,
        `* [avatar](https://x.com/fourdotmemezh) Quote token mode is live [![Image](https://pbs.twimg.com/media/example)](https://x.com/fourdotmemezh/status/${imageOnlyId}/photo/1)`,
        `## Log in or sign up for X\n[Ads](https://ads.example/tracker)`,
        `* [Other](https://x.com/other) [1h](https://x.com/other/status/2089999999999999999) New launch is live`,
      ].join("\n"),
    },
    metadata: {
      description: "https://x.com/fourdotmemezh/status/2099999999999999999 fake metadata tweet",
    },
  };
  const tweets = parseJinaReaderPayload(payload, "fourdotmemezh");
  assert.deepEqual(tweets.map(({ id }) => id), [currentId, imageOnlyId]);
  const criticalDiscoveryTweets = parseJinaReaderPayload(payload, "fourdotmemezh", { includePinned: true });
  assert.deepEqual(
    criticalDiscoveryTweets.map(({ id }) => id),
    [pinnedId, currentId, imageOnlyId],
    "pinned posts are opt-in for the freshness- and identity-gated critical discovery lane only",
  );
  assert.match(tweets[0].text, /New launchpad contract deployed/);
  assert.equal(tweets[1].text, "Quote token mode is live");
  assert.equal(tweets[0].url, `https://x.com/fourdotmemezh/status/${currentId}`);
  assert.equal(tweets[0].createdAt, new Date(Number((BigInt(currentId) >> 22n) + 1_288_834_974_657n)).toISOString());
  assert.equal(tweets[0].likes, null);
  assert.equal(tweets.some((tweet) => (tweet.expandedUrls || []).includes("https://ads.example/tracker")), false);
});

test("Jina Reader accepts canonical twitter.com links and preserves external evidence URLs", () => {
  const pinnedId = "2083101682033184832";
  const currentId = "2084706267562709294";
  const payload = {
    data: {
      content: [
        `* Pinned [Four](https://x.com/fourdotmemezh) [Jul 31](https://twitter.com/fourdotmemezh/status/${pinnedId}) old launchpad mode`,
        `* [Four](https://x.com/fourdotmemezh) [2h](https://twitter.com/fourdotmemezh/status/${currentId}) Royalty tax token mode is live [docs](https://github.com/Four-Meme/contracts-v2)`,
      ].join("\n"),
    },
  };
  const tweets = parseJinaReaderPayload(payload, "fourdotmemezh");
  assert.deepEqual(tweets.map(({ id }) => id), [currentId]);
  assert.deepEqual(tweets[0].expandedUrls, ["https://github.com/Four-Meme/contracts-v2"]);
  assert.equal(tweets[0].url, `https://x.com/fourdotmemezh/status/${currentId}`);
});

test("a syndication 429 falls through to rate-limited Jina Reader without account cooldown blocking it", async (t) => {
  const current = Date.parse("2026-08-05T02:00:00Z");
  const previousId = "2084600000000000000";
  const currentId = "2084610000000000000";
  const dataDir = await fixture(t, {
    fourdotmemezh: { latestId: previousId, checkedAt: "old" },
  });
  const requested = [];
  const delivered = [];
  const monitor = createTwitterMonitor(config(dataDir, {
    twitterFallbackApiBases: ["https://r.jina.ai/http://x.com/{handle}"],
    twitterJinaMinIntervalMs: 300_000,
  }), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    fetchImpl: async (url, init) => {
      requested.push({ url, headers: init.headers });
      if (url === "https://primary.test/timeline/fourdotmemezh") return response({ status: 429, retryAfter: "0" });
      if (url === "https://r.jina.ai/http://x.com/fourdotmemezh") {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({
            data: { content: `* [Four](https://x.com/fourdotmemezh) [2h](https://x.com/fourdotmemezh/status/${currentId}) New launchpad contract deployed and V2 is live` },
            metadata: { description: "https://x.com/fourdotmemezh/status/2099999999999999999 should be ignored" },
          }),
        };
      }
      return response();
    },
  });

  await monitor.check();
  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  const primaryRequests = requested.filter(({ url }) => url === "https://primary.test/timeline/fourdotmemezh");
  const jinaRequests = requested.filter(({ url }) => url === "https://r.jina.ai/http://x.com/fourdotmemezh");
  assert.equal(primaryRequests.length, 1);
  assert.equal(jinaRequests.length, 1, "the five-minute source interval must suppress a duplicate Jina request");
  assert.equal(jinaRequests[0].headers.accept, "application/json");
  assert.equal(jinaRequests[0].headers["x-no-cache"], "true");
  assert.equal(jinaRequests[0].headers["x-cache-tolerance"], "0");
  assert.deepEqual(delivered.map((event) => event.tweet.id), [currentId]);
  assert.equal(state.fourdotmemezh.latestId, currentId);
  assert.equal(state._health.fourdotmemezh.status, "degraded");
  assert.equal(state._health.fourdotmemezh.activeSourceId, "jina_reader");
  assert.equal(state._health.fourdotmemezh.sources["https://primary.test/timeline"].status, "backoff");
  assert.equal(state._health.fourdotmemezh.sources["https://r.jina.ai/http://x.com/{handle}"].source, "jina_reader");
  assert.equal(Date.parse(state._health.fourdotmemezh.sources["https://r.jina.ai/http://x.com/{handle}"].nextPollAt) - current, 300_000);
  assert.equal(state._meta.health.status, "partial");
  assert.ok(state._meta.health.coverageAccounts.priorityCovered >= 1);
});

test("accepts the canonical HTTPS x.com Jina route as an exact-handle official fallback", async (t) => {
  const current = Date.parse("2026-08-05T02:00:00Z");
  const currentId = "2084610000000000000";
  const base = "https://r.jina.ai/https://x.com/{handle}";
  const dataDir = await fixture(t, { fourdotmemezh: { latestId: "2084600000000000000", checkedAt: "old" } });
  const delivered = [];
  const monitor = createTwitterMonitor(config(dataDir, { twitterFallbackApiBases: [base] }), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    fetchImpl: async (url) => {
      if (url === "https://primary.test/timeline/fourdotmemezh") return response({ status: 429, retryAfter: "0" });
      if (url === "https://r.jina.ai/https://x.com/fourdotmemezh") {
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          text: async () => JSON.stringify({
            data: { content: `* [Four](https://x.com/fourdotmemezh) [2h](https://x.com/fourdotmemezh/status/${currentId}) New launchpad contract deployed and V2 is live` },
          }),
        };
      }
      return response();
    },
  });

  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.deepEqual(delivered.map((event) => event.tweet.id), [currentId]);
  assert.equal(state._health.fourdotmemezh.activeSource, base);
  assert.equal(state._health.fourdotmemezh.activeSourceId, "jina_reader");
});

test("a healthy scheduled Jina source prevents lower-priority fallback churn", async (t) => {
  const current = Date.parse("2026-08-05T02:00:00Z");
  const dataDir = await fixture(t, { fourdotmemezh: { latestId: "2084600000000000000", checkedAt: "old" } });
  const primaryJina = "https://r.jina.ai/https://twitter.com/{handle}";
  const lowerJina = "https://r.jina.ai/http://x.com/{handle}";
  const requested = [];
  const monitor = createTwitterMonitor(config(dataDir, { twitterFallbackApiBases: [primaryJina, lowerJina] }), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    sendAlertsImpl: async () => {},
    fetchImpl: async (url) => {
      requested.push(url);
      if (url === "https://primary.test/timeline/fourdotmemezh") return response({ status: 429, retryAfter: "0" });
      if (url === "https://r.jina.ai/https://twitter.com/fourdotmemezh") {
        return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { content: "* [Four](https://x.com/fourdotmemezh) [2h](https://twitter.com/fourdotmemezh/status/2084610000000000000) New launchpad V2 is live" } }) };
      }
      throw new Error(`lower fallback should not be called: ${url}`);
    },
  });
  await monitor.check();
  await monitor.check();
  assert.equal(requested.filter((url) => url === "https://r.jina.ai/https://twitter.com/fourdotmemezh").length, 1);
  assert.equal(requested.some((url) => url === "https://r.jina.ai/http://x.com/fourdotmemezh"), false);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state._health.fourdotmemezh.status, "degraded");
  assert.equal(state._health.fourdotmemezh.scheduledUntil, new Date(current + 300_000).toISOString());
});

test("a relevant truncated Jina timeline item is completed from its exact status page", async (t) => {
  const current = Date.parse("2026-08-05T02:00:00Z");
  const previousId = "2084600000000000000";
  const currentId = "2084706267562709294";
  const dataDir = await fixture(t, { fourdotmemezh: { latestId: previousId, checkedAt: "old" } });
  const requested = [];
  const delivered = [];
  const base = "https://r.jina.ai/https://twitter.com/{handle}";
  const monitor = createTwitterMonitor(config(dataDir, { twitterFallbackApiBases: [base] }), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    fetchImpl: async (url) => {
      requested.push(url);
      if (url === "https://primary.test/timeline/fourdotmemezh") return response({ status: 429, retryAfter: "0" });
      const content = url.endsWith(`/status/${currentId}`)
        ? `* [Four](https://x.com/fourdotmemezh) [2h](https://twitter.com/fourdotmemezh/status/${currentId}) Royalty tax token mode is live with a new buyback vault, stock pools, creator fees and contract suffix ffff.`
        : `* [Four](https://x.com/fourdotmemezh) [2h](https://twitter.com/fourdotmemezh/status/${currentId}) Royalty tax token mode is live. Show more`;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data: { content } }) };
    },
  });
  await monitor.check();
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].tweet.text, /new buyback vault/);
  assert.equal(delivered[0].tweet.textTruncated, false);
  assert.equal(delivered[0].tweet.detailSource, "jina_status");
  assert.ok(requested.includes(`https://r.jina.ai/https://twitter.com/fourdotmemezh/status/${currentId}`));
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state._health.fourdotmemezh.detailCoverage.status, "complete");
});

test("an explicit repository link from the official Pons timeline reaches the identity verifier", async (t) => {
  const dataDir = await fixture(t, {
    fourdotmemezh: { latestId: "100", checkedAt: "old" },
    ponsdotfamily: { latestId: "100", checkedAt: "old" },
  });
  const repositories = [];
  const monitor = createTwitterMonitor(config(dataDir), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async () => {},
    onOfficialRepository: async (repository, evidence) => repositories.push({ repository, evidence }),
    fetchImpl: async (url) => url.endsWith("/ponsdotfamily")
      ? response({ handle: "ponsdotfamily", tweets: [{ id: "101", text: "Pons v2 source code", expandedUrl: "https://github.com/pons-labs/contracts" }] })
      : response(),
  });
  await monitor.check();
  assert.equal(repositories.length, 1);
  assert.equal(repositories[0].repository, "pons-labs/contracts");
  assert.equal(repositories[0].evidence.source, "official_x");
});

test("startup retries persisted X transport failures without bypassing HTTP rate-limit backoff", async (t) => {
  const current = Date.parse("2026-08-05T02:00:00Z");
  const future = new Date(current + 30 * 60_000).toISOString();
  const source = (lastError) => ({ status: "error", lastError, consecutiveFailures: 4, retryAfter: future });
  const dataDir = await fixture(t, {
    fourdotmemezh: { latestId: "100", checkedAt: "old" },
    flapdotsh: { latestId: "100", checkedAt: "old" },
    _health: {
      fourdotmemezh: { status: "error", sources: { "https://primary.test/timeline": source("fetch failed: EADDRNOTAVAIL") } },
      flapdotsh: { status: "backoff", sources: { "https://primary.test/timeline": source("HTTP 429") } },
    },
  });
  const requested = [];
  const monitor = createTwitterMonitor(config(dataDir, { monitorScope: "focus3", ponsMonitorEnabled: false }), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    sendAlertsImpl: async () => {},
    fetchImpl: async (url) => {
      requested.push(url);
      const handle = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1));
      return response({ handle, tweets: [{ id: "101", text: "Good morning" }, { id: "100", text: "Earlier" }] });
    },
  });

  await monitor.check();
  assert.equal(requested.some((url) => url.endsWith("/fourdotmemezh")), true);
  assert.equal(requested.some((url) => url.endsWith("/flapdotsh")), false);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state._health.fourdotmemezh.sources["https://primary.test/timeline"].status, "healthy");
  assert.equal(state._health.flapdotsh.sources["https://primary.test/timeline"].retryAfter, future);
});

test("X transport failure source backoff is capped at one minute", async (t) => {
  let current = Date.parse("2026-08-05T02:00:00Z");
  const dataDir = await fixture(t, { fourdotmemezh: { latestId: "100", checkedAt: "old" } });
  const monitor = createTwitterMonitor(config(dataDir, { monitorScope: "focus3", ponsMonitorEnabled: false }), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    sendAlertsImpl: async () => {},
    fetchImpl: async () => { throw new Error("fetch failed: socket unavailable"); },
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await monitor.check();
    const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
    current = Date.parse(state._health.fourdotmemezh.sources["https://primary.test/timeline"].retryAfter);
  }
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  const health = state._health.fourdotmemezh.sources["https://primary.test/timeline"];
  assert.equal(Date.parse(health.retryAfter) - Date.parse(health.checkedAt), 60_000);
});

test("a zero Retry-After cannot turn an X rate limit into a five-second retry loop", async (t) => {
  const current = Date.parse("2026-07-31T01:00:00Z");
  const dataDir = await fixture(t, {
    fourdotmemezh: { latestId: "100", checkedAt: "old" },
    ponsdotfamily: { latestId: "100", checkedAt: "old" },
  });
  let fourMemeRequests = 0;
  const monitor = createTwitterMonitor(config(dataDir), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    sendAlertsImpl: async () => {},
    fetchImpl: async (url) => {
      if (url.endsWith("/fourdotmemezh")) {
        fourMemeRequests += 1;
        return response({ status: 429, retryAfter: "0" });
      }
      return response();
    },
  });

  await monitor.check();
  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(fourMemeRequests, 1, "the account-level cooldown must suppress the immediate retry");
  assert.equal(Date.parse(state._health.fourdotmemezh.retryAfter) - current, 15 * 60 * 1_000);
});

test("X rate-limit reset headers extend the account cooldown", async (t) => {
  const current = Date.parse("2026-07-31T01:00:00Z");
  const reset = current + 30 * 60 * 1_000;
  const dataDir = await fixture(t, {
    fourdotmemezh: { latestId: "100", checkedAt: "old" },
    ponsdotfamily: { latestId: "100", checkedAt: "old" },
  });
  const monitor = createTwitterMonitor(config(dataDir), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    sendAlertsImpl: async () => {},
    fetchImpl: async (url) => url.endsWith("/fourdotmemezh")
      ? response({ status: 429, retryAfter: "0", rateLimitReset: String(reset / 1_000) })
      : response(),
  });

  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(Date.parse(state._health.fourdotmemezh.retryAfter), reset);
});

test("does not advance a tweet cursor when alert delivery fails", async (t) => {
  const dataDir = await fixture(t, {
    _meta: { cursor: 0 },
    fourdotmemezh: { latestId: "100", checkedAt: "old" },
    ponsdotfamily: { latestId: "100", checkedAt: "old" },
  });
  const monitor = createTwitterMonitor(config(dataDir), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => {
      if (event.project.handle === "fourdotmemezh") throw new Error("telegram unavailable");
    },
    fetchImpl: async (url) => {
      if (url.endsWith("/fourdotmemezh")) return response({ handle: "fourdotmemezh", tweets: [{ id: "101", text: "V2 launch is live" }] });
      return response();
    },
  });

  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.fourdotmemezh.latestId, "100");
  assert.equal(state._health.fourdotmemezh.status, "degraded");
  assert.match(state._health.fourdotmemezh.lastError, /telegram unavailable/);
  assert.ok(state._health.fourdotmemezh.deliveryRetryAfter);
});

test("structured alert delivery receipts accept only durable outcomes", () => {
  assert.equal(classifyTwitterAlertDelivery(undefined), "accepted");
  assert.equal(classifyTwitterAlertDelivery(true), "accepted");
  assert.equal(classifyTwitterAlertDelivery({ status: "delivered" }), "accepted");
  assert.equal(classifyTwitterAlertDelivery({ status: "queued" }), "accepted");
  assert.equal(classifyTwitterAlertDelivery({ status: "suppressed", reason: "semantic_duplicate" }), "semantic_duplicate");
  assert.equal(classifyTwitterAlertDelivery({ status: "suppressed", reason: "not_relevant" }), "accepted");
  assert.equal(classifyTwitterAlertDelivery({ status: "suppressed", reason: "monitoring_source_disabled" }), "accepted");
  assert.equal(classifyTwitterAlertDelivery({ status: "suppressed", reason: "blocked_event" }), "accepted");
  assert.equal(classifyTwitterAlertDelivery({ status: "suppressed", reason: "unknown" }), "retry");
  assert.equal(classifyTwitterAlertDelivery(false), "retry");
  assert.equal(classifyTwitterAlertDelivery({ status: "queued" }, { strictPonFun: true }), "accepted");
  assert.equal(classifyTwitterAlertDelivery({ status: "suppressed", reason: "blocked_event", terminal: true }, { strictPonFun: true }), "accepted");
  assert.equal(classifyTwitterAlertDelivery({ status: "suppressed", reason: "freshness_too_old", terminal: true }, { strictPonFun: true }), "retry");
  assert.equal(classifyTwitterAlertDelivery({ status: "suppressed", reason: "delivery_ttl_expired", terminal: true }, { strictPonFun: true }), "retry");
  assert.equal(classifyTwitterAlertDelivery({ status: "suppressed", reason: "not_relevant", terminal: true }, { strictPonFun: true }), "retry");
  assert.equal(classifyTwitterAlertDelivery({ status: "suppressed", reason: "monitoring_source_disabled", terminal: true }, { strictPonFun: true }), "retry");
  assert.equal(classifyTwitterAlertDelivery({ status: "suppressed", reason: "policy_suppressed", terminal: true }, { strictPonFun: true }), "retry");
  assert.equal(classifyTwitterAlertDelivery(undefined, { strictPonFun: true }), "retry");
});

test("a normally filtered Four.Meme alert advances its cursor without a delivery retry", async (t) => {
  const current = Date.parse("2026-08-12T01:00:00Z");
  const dataDir = await fixture(t, { fourdotmemezh: { latestId: "100", checkedAt: "old" } });
  let deliveryAttempts = 0;
  const monitor = createTwitterMonitor(config(dataDir, { twitterPriorityPollConcurrency: 8 }), {
    autoStart: false,
    now: () => current,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => {
      if (event.project.handle.toLowerCase() !== "fourdotmemezh") return { status: "queued" };
      deliveryAttempts += 1;
      return { status: "suppressed", reason: "not_relevant" };
    },
    fetchImpl: async (url) => {
      const handle = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1));
      const target = OFFICIAL_TWITTER_TARGETS.find((item) => item.handle.toLowerCase() === handle.toLowerCase());
      return response({ handle, tweets: [{
        id: "101",
        text: handle.toLowerCase() === "fourdotmemezh" ? "Four.Meme V2 launchpad is now live." : "Good morning.",
        ...(target?.signalProfile === "ai" ? { authorId: target.xUserId } : {}),
      }] });
    },
  });

  await monitor.check();
  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(deliveryAttempts, 1, "a terminal policy decision must not be sent again");
  assert.equal(state.fourdotmemezh.latestId, "101");
  assert.notEqual(state._health.fourdotmemezh.status, "degraded");
  assert.equal(state._health.fourdotmemezh.deliveryRetryAfter, undefined);
  assert.equal(state._health.fourdotmemezh.lastError, undefined);
});

test("a persisted semantic duplicate is durable enough to advance the AI tweet cursor", async (t) => {
  const dataDir = await fixture(t, { x: { latestId: "100", checkedAt: "old" } });
  const eventId = "twitter:x:101";
  const monitor = createTwitterMonitor(config(dataDir, { twitterPriorityPollConcurrency: 8 }), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => {
      if (event.project.handle.toLowerCase() !== "x") return { status: "queued" };
      await fs.writeFile(path.join(dataDir, "alert-outbox.json"), `${JSON.stringify({
        version: 2,
        events: {
          [eventId]: {
            id: eventId,
            status: "suppressed",
            destinations: {
              telegram: { status: "disabled", disabledReason: "semantic_duplicate", duplicateOf: "ai:product:x-chat" },
            },
          },
        },
      })}\n`);
      return { status: "suppressed", eventId };
    },
    fetchImpl: async (url) => {
      const handle = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).at(-1));
      const target = OFFICIAL_TWITTER_TARGETS.find((item) => item.handle.toLowerCase() === handle.toLowerCase());
      return response({ handle, tweets: [{
        id: "101",
        text: handle.toLowerCase() === "x" ? "X Chat now supports encrypted group calls." : "Good morning.",
        ...(target?.signalProfile === "ai" ? { authorId: target.xUserId } : {}),
      }] });
    },
  });

  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.x.latestId, "101");
  assert.notEqual(state._health.x.status, "degraded");
});

test("bounded first-seen catch-up alerts on recent official Four.Meme signals", async (t) => {
  const dataDir = await fixture(t);
  const delivered = [];
  const recent = Array.from({ length: 12 }, (_, index) => ({
    id: String(112 - index),
    text: `V2 launch is live update ${112 - index}`,
  }));
  const monitor = createTwitterMonitor(config(dataDir, { twitterBackfillLimit: 3 }), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    fetchImpl: async (url) => {
      if (url.endsWith("/fourdotmemezh")) return response({ handle: "fourdotmemezh", tweets: recent });
      return response();
    },
  });

  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.deepEqual(delivered.map((event) => event.tweet.id), ["110", "111", "112"]);
  assert.equal(state.fourdotmemezh.latestId, "112");
  assert.equal(state._health.fourdotmemezh.coverage.firstSeenBackfill.omittedRelevant, 9);
  assert.equal(state._health.fourdotmemezh.coverage.firstSeenBackfill.status, "complete");
});

test("uses a configured fallback timeline source and exposes degraded health", async (t) => {
  const dataDir = await fixture(t, {
    _meta: { cursor: 0 },
    fourdotmemezh: { latestId: "100", checkedAt: "old" },
    ponsdotfamily: { latestId: "100", checkedAt: "old" },
  });
  const monitor = createTwitterMonitor(config(dataDir, { twitterFallbackApiBases: ["https://backup.test/{handle}"] }), {
    autoStart: false,
    logger: { error() {} },
    sendAlertsImpl: async () => {},
    fetchImpl: async (url) => {
      if (url === "https://primary.test/timeline/ponsdotfamily") return response({ status: 503 });
      if (url === "https://backup.test/ponsdotfamily") return response({ handle: "ponsdotfamily", tweets: [{ id: "101", text: "Good morning" }] });
      return response();
    },
  });

  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.ponsdotfamily.latestId, "101");
  assert.equal(state._health.ponsdotfamily.status, "degraded");
  assert.equal(state._health.ponsdotfamily.activeSource, "https://backup.test/{handle}");
  assert.equal(state._health.ponsdotfamily.sources["https://primary.test/timeline"].status, "error");
  assert.equal(state._health.ponsdotfamily.fallbackOfficialSources.some(({ url }) => url === "https://docs.ponsfamily.com"), true);
});

test("classifies Four.Meme product, token, campaign, and fee updates", () => {
  const cases = [
    ["Four.Meme subscription is now live", "订阅功能"],
    ["OpenFour developer modules are available", "OpenFour"],
    ["Tax Mode now supports a new raised token", "税收/募资/报价代币"],
    ["UUSD is available as a quote token", "税收/募资/报价代币"],
    ["The trading fee has been adjusted", "活动/费用变更"],
    ["新活动上线，手续费调整", "活动/费用变更"],
  ];
  for (const [message, label] of cases) {
    const result = classifyTweet(message);
    assert.equal(result.relevant, true, message);
    assert.equal(result.labels.includes(label), true, message);
  }
});

test("parses X embed timeline JSON", () => {
  const payload = { props: { pageProps: { timeline: { entries: [{ type: "tweet", entry_id: "tweet-123", content: { tweet: { id_str: "123", full_text: "Factory deployed", created_at: "now", favorite_count: 2, retweet_count: 1, reply_count: 0, user: { name: "Pad", screen_name: "padfun" } } } }] } } } };
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(payload)}</script>`;
  assert.deepEqual(parseTimelineHtml(html, "padfun")[0], { id: "123", text: "Factory deployed", createdAt: "now", authorName: "Pad", handle: "padfun", replies: 0, reposts: 1, likes: 2, url: "https://x.com/padfun/status/123", isReply: false });
});

test("pon.fun classifier uses Blockscout evidence links and filters mechanism marketing", () => {
  const token = "0x1111111111111111111111111111111111111111";
  const tx = `0x${"a".repeat(64)}`;
  const live = classifyPonFunOfficialText(`$PONFUN is live\nhttps://robinhoodchain.blockscout.com/address/${token}`);
  assert.equal(live.relevant, true);
  assert.equal(live.ponKind, "platform_token_update");
  assert.equal(live.ponStage, "platform_token_live");
  assert.equal(live.tokenAddress, token);
  assert.equal(live.ponPriority, "T1");

  const burn = classifyPonFunOfficialText(`Dev supply is burned\nhttps://robinhoodchain.blockscout.com/tx/${tx}`);
  assert.equal(burn.relevant, true);
  assert.equal(burn.ponStage, "supply_burned");
  assert.equal(burn.transactionHash, tx);
  assert.equal(burn.ponPriority, "T1");

  const graduated = classifyPonFunOfficialText(`The market graduated\nhttps://robinhoodchain.blockscout.com/address/${token}`);
  assert.equal(graduated.relevant, true);
  assert.equal(graduated.ponKind, "market_lifecycle");
  assert.equal(graduated.ponStage, "graduated");

  const transferStarted = classifyPonFunOfficialText("Factory ownership transfer initiated and pending to 0x1111111111111111111111111111111111111111");
  assert.equal(transferStarted.relevant, true);
  assert.equal(transferStarted.ponKind, "ownership_transfer_started");
  assert.equal(transferStarted.ponStage, "ownership_transfer_started");

  const transferred = classifyPonFunOfficialText("Factory ownership transfer completed and accepted by 0x1111111111111111111111111111111111111111");
  assert.equal(transferred.relevant, true);
  assert.equal(transferred.ponKind, "ownership_transferred");
  assert.equal(transferred.ponStage, "ownership_transferred");

  const ambiguousOwnership = classifyPonFunOfficialText("Factory ownership transfer update for 0x1111111111111111111111111111111111111111");
  assert.equal(ambiguousOwnership.relevant, false);
  assert.equal(ambiguousOwnership.reason, "ambiguous_ownership_transfer_stage");
  assert.equal(graduated.ponPriority, "T2");

  for (const message of [
    `Learn more about how pon.fun works\nhttps://robinhoodchain.blockscout.com/address/${token}`,
    "Built for the people. Join the pon.fun community.",
    "Pons launches a generic RWA token called PON.",
  ]) assert.equal(classifyPonFunOfficialText(message).relevant, false, message);
});

test("PON alone schedules only @pondotfun, silently baselines history, then verifies a link-only proof", async (t) => {
  const dataDir = await fixture(t);
  const account = { handle: "pondotfun", name: "pon.fun", userId: "2094048312772993024" };
  const tx = `0x${"b".repeat(64)}`;
  let clock = Date.parse("2026-09-02T04:00:00.000Z");
  let tweets = [1, 2, 3, 4].map((offset) => ({
    id: `209410000000000000${offset}`,
    text: `pon.fun historical platform post ${offset}`,
    createdTimestamp: clock / 1_000 - (10 - offset) * 60,
    expandedUrls: [],
  }));
  const requests = [];
  const delivered = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    requests.push(value);
    if (value.includes(`/2/profile/id:${account.userId}/statuses`)) {
      return textResponse({
        code: 200,
        results: tweets.map((tweet) => ({
          id: tweet.id,
          text: tweet.text,
          raw_text: {
            text: tweet.text,
            facets: tweet.expandedUrls.map((replacement) => ({ type: "url", replacement })),
          },
          created_timestamp: tweet.createdTimestamp,
          author: { id: account.userId, name: account.name, screen_name: account.handle },
          url: `https://x.com/${account.handle}/status/${tweet.id}`,
          replying_to: null,
          reposted_by: null,
          replies: 0,
          reposts: 0,
          likes: 0,
        })),
      });
    }
    const exactId = value.match(/^https:\/\/api\.fxtwitter\.test\/pondotfun\/status\/(\d+)$/)?.[1];
    if (exactId) {
      const tweet = tweets.find((candidate) => candidate.id === exactId);
      if (!tweet) return textResponse("", 404);
      return textResponse({
        code: 200,
        tweet: {
          id: tweet.id,
          text: tweet.text,
          raw_text: {
            text: tweet.text,
            facets: tweet.expandedUrls.map((replacement) => ({ type: "url", replacement })),
          },
          created_timestamp: tweet.createdTimestamp,
          author: { id: account.userId, name: account.name, screen_name: account.handle },
          url: `https://x.com/${account.handle}/status/${tweet.id}`,
          replying_to: null,
          reposted_by: null,
          replies: 0,
          reposts: 0,
          likes: 0,
        },
      });
    }
    if (value.startsWith("https://publish.x.com/oembed")) {
      const requested = new URL(value).searchParams.get("url");
      const id = requested?.match(/\/status\/(\d+)$/)?.[1];
      const tweet = tweets.find((candidate) => candidate.id === id);
      if (!tweet) return textResponse("", 404);
      return textResponse({
        url: requested,
        author_url: `https://x.com/${account.handle}`,
        author_name: account.name,
        html: `<blockquote><p>${tweet.text}</p><a href="${requested}">September 2, 2026</a></blockquote>`,
      });
    }
    return textResponse("", 404);
  };
  const monitor = createTwitterMonitor(criticalOnlyConfig(dataDir, {
    twitterMonitorEnabled: false,
    binanceCriticalXMonitorEnabled: false,
    focusCriticalXMonitorEnabled: false,
    ponMonitorEnabled: true,
    focusCriticalXMaxAgeMs: 10 * 60_000,
  }), {
    autoStart: false,
    now: () => clock,
    logger: { error() {} },
    fetchImpl,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      return { status: "queued", eventId: `twitter:${event.tweet.id}` };
    },
  });
  t.after(() => monitor.stop());

  await monitor.check();
  assert.equal(delivered.length, 0, "the four existing posts form a silent baseline");
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.pondotfun.latestId, "2094100000000000004");
  assert.deepEqual(Object.keys(state).filter((key) => !key.startsWith("_")), ["pondotfun"]);

  clock += 6_000;
  tweets = [{
    id: "2095100000000000000",
    text: "Dev supply is burned",
    createdTimestamp: clock / 1_000 - 1,
    expandedUrls: [`https://robinhoodchain.blockscout.com/tx/${tx}`],
  }, ...tweets];
  await monitor.check();

  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].project.id, "ponfun");
  assert.equal(delivered[0].project.criticalProfile, "pon_fun");
  assert.equal(delivered[0].tweet.sourceVerifiedBy, "official_x_oembed");
  assert.equal(delivered[0].tweet.identityVerifiedBy, "fxtwitter_exact_numeric_id");
  assert.deepEqual(delivered[0].tweet.expandedUrls, [`https://robinhoodchain.blockscout.com/tx/${tx}`]);
  assert.equal(delivered[0].signal.ponStage, "supply_burned");
  assert.equal(delivered[0].signal.transactionHash, tx);
  assert.equal(requests.some((url) => url.includes("ordinary-x-must-not-run.test")), false);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.pondotfun.latestId, "2095100000000000000");
});

test("pon.fun recovers a real source gap one exact oldest structural tweet per cycle", async (t) => {
  const cursorId = "2096100000000000000";
  const firstId = "2096100000000000001";
  const secondId = "2096100000000000002";
  const dataDir = await fixture(t, {
    pondotfun: {
      latestId: cursorId,
      checkedAt: "2026-09-02T04:00:00.000Z",
      profile: { name: "pon.fun", handle: "pondotfun" },
    },
    _health: {
      pondotfun: {
        status: "error",
        consecutiveFailures: 1,
        gapSince: "2026-09-02T04:01:00.000Z",
        sources: {},
      },
    },
  });
  let clock = Date.parse("2026-09-02T04:20:00.000Z");
  const account = { handle: "pondotfun", name: "pon.fun", userId: "2094048312772993024" };
  const tweets = [
    { id: secondId, text: "pon.fun Factory protocol paused", createdTimestamp: Date.parse("2026-09-02T04:03:00.000Z") / 1_000, expandedUrls: [] },
    { id: firstId, text: "pon.fun Factory treasury configuration updated", createdTimestamp: Date.parse("2026-09-02T04:02:00.000Z") / 1_000, expandedUrls: [] },
    { id: cursorId, text: "pon.fun baseline", createdTimestamp: Date.parse("2026-09-02T04:00:00.000Z") / 1_000, expandedUrls: [] },
  ];
  const exactRequests = [];
  const delivered = [];
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes(`/2/profile/id:${account.userId}/statuses`)) {
      return textResponse({
        code: 200,
        results: tweets.map((tweet) => ({
          id: tweet.id,
          text: tweet.text,
          raw_text: { text: tweet.text, facets: [] },
          created_timestamp: tweet.createdTimestamp,
          author: { id: account.userId, name: account.name, screen_name: account.handle },
          url: `https://x.com/${account.handle}/status/${tweet.id}`,
          replying_to: null,
          reposted_by: null,
          replies: 0,
          reposts: 0,
          likes: 0,
        })),
      });
    }
    const exactId = value.match(/^https:\/\/api\.fxtwitter\.test\/pondotfun\/status\/(\d+)$/)?.[1];
    if (exactId) {
      exactRequests.push(exactId);
      const tweet = tweets.find((candidate) => candidate.id === exactId);
      return textResponse({
        code: 200,
        tweet: {
          id: tweet.id,
          text: tweet.text,
          raw_text: { text: tweet.text, facets: [] },
          created_timestamp: tweet.createdTimestamp,
          author: { id: account.userId, name: account.name, screen_name: account.handle },
          url: `https://x.com/${account.handle}/status/${tweet.id}`,
          replying_to: null,
          reposted_by: null,
          replies: 0,
          reposts: 0,
          likes: 0,
        },
      });
    }
    if (value.startsWith("https://publish.x.com/oembed")) {
      const id = new URL(value).searchParams.get("url")?.match(/\/status\/(\d+)$/)?.[1];
      const tweet = tweets.find((candidate) => candidate.id === id);
      return textResponse({
        url: `https://x.com/${account.handle}/status/${id}`,
        author_url: `https://x.com/${account.handle}`,
        author_name: account.name,
        html: `<blockquote><p>${tweet.text}</p><a href="https://x.com/${account.handle}/status/${id}">September 2, 2026</a></blockquote>`,
      });
    }
    return textResponse("", 404);
  };
  const monitor = createTwitterMonitor(criticalOnlyConfig(dataDir, {
    binanceCriticalXMonitorEnabled: false,
    focusCriticalXMonitorEnabled: false,
    ponMonitorEnabled: true,
    focusCriticalXMaxAgeMs: 24 * 60 * 60_000,
  }), {
    autoStart: false,
    now: () => clock,
    logger: { error() {} },
    fetchImpl,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      return { status: "queued", eventId: `twitter:${event.tweet.id}` };
    },
  });
  t.after(() => monitor.stop());

  await monitor.check();
  assert.deepEqual(exactRequests, [firstId]);
  assert.deepEqual(delivered.map((event) => event.tweet.id), [firstId]);
  assert.equal(delivered[0].delayedRecovery.reason, "monitoring_gap_recovery");
  assert.deepEqual(delivered[0].delayedRecovery.cursor, { latestIdAtRecovery: cursorId, tweetId: firstId });
  assert.equal(delivered[0].deliverySla, undefined);
  let state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.pondotfun.latestId, firstId);
  assert.equal(state._health.pondotfun.coverage.delayedRecovery.status, "in_progress");
  assert.equal(state._health.pondotfun.gapSince, "2026-09-02T04:01:00.000Z");

  clock += 6_000;
  await monitor.check();
  assert.deepEqual(exactRequests, [firstId, secondId]);
  assert.deepEqual(delivered.map((event) => event.tweet.id), [firstId, secondId]);
  state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.pondotfun.latestId, secondId);
  assert.equal(state._health.pondotfun.coverage.delayedRecovery.status, "complete");
  assert.equal(state._health.pondotfun.gapSince, undefined);
});

test("pon.fun freezes its cursor and persists incomplete coverage when Fx omits the durable ID", async (t) => {
  const cursorId = "2096200000000000000";
  const newerId = "2096200000000000001";
  const dataDir = await fixture(t, {
    pondotfun: {
      latestId: cursorId,
      checkedAt: "2026-09-02T04:19:59.000Z",
      profile: { name: "pon.fun", handle: "pondotfun" },
    },
    _health: { pondotfun: { status: "healthy", consecutiveFailures: 0, sources: {} } },
  });
  const clock = Date.parse("2026-09-02T04:20:00.000Z");
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("/2/profile/id:2094048312772993024/statuses")) {
      return textResponse({
        code: 200,
        results: [{
          id: newerId,
          text: "pon.fun historical community recap",
          raw_text: { text: "pon.fun historical community recap", facets: [] },
          created_timestamp: Date.parse("2026-09-02T04:05:00.000Z") / 1_000,
          author: { id: "2094048312772993024", name: "pon.fun", screen_name: "pondotfun" },
          url: `https://x.com/pondotfun/status/${newerId}`,
          replying_to: null,
          reposted_by: null,
        }],
      });
    }
    return textResponse("", 404);
  };
  const delivered = [];
  const monitor = createTwitterMonitor(criticalOnlyConfig(dataDir, {
    binanceCriticalXMonitorEnabled: false,
    focusCriticalXMonitorEnabled: false,
    ponMonitorEnabled: true,
  }), {
    autoStart: false,
    now: () => clock,
    logger: { error() {} },
    fetchImpl,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      return { status: "queued", eventId: `twitter:${event.tweet.id}` };
    },
  });
  t.after(() => monitor.stop());

  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "twitter-state.json"), "utf8"));
  assert.equal(state.pondotfun.latestId, cursorId);
  assert.equal(delivered.length, 0);
  assert.equal(state._health.pondotfun.coverage.cursorGap.status, "incomplete");
  assert.equal(state._health.pondotfun.coverage.cursorGap.cursorId, cursorId);
  assert.match(state._health.pondotfun.lastError, /does not cover the durable cursor/);
});
