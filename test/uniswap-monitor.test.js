import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  UNISWAP_BLOG_SITEMAP_URL,
  UNISWAP_GITHUB_RELEASE_FEEDS,
  UNISWAP_GOVERNANCE_POSTS_URL,
  atomicWriteUniswapState,
  classifyUniswapBlogEntry,
  classifyUniswapGovernancePost,
  createUniswapMonitor,
  parseGithubReleaseFeed,
  parseUniswapBlogPage,
  parseUniswapBlogSitemap,
  parseUniswapGovernancePosts,
} from "../src/uniswap-monitor.js";

const RELEASE_URL = UNISWAP_GITHUB_RELEASE_FEEDS[0].url;
const quietLogger = { error() {} };

const xmlEscape = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;");

const sitemap = (entries) => `<?xml version="1.0"?><urlset>${entries.map(({ url, lastmod }) => `
  <url><loc>${xmlEscape(url)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ""}</url>`).join("")}
</urlset>`;

const releaseFeed = (entries) => `<?xml version="1.0"?><feed>${entries.map((entry) => `
  <entry>
    <id>${xmlEscape(entry.id)}</id>
    <updated>${entry.updated || "2026-08-05T12:00:00Z"}</updated>
    <link rel="alternate" href="${xmlEscape(entry.url)}" />
    <title>${xmlEscape(entry.title)}</title>
    <content type="html">${xmlEscape(entry.content || entry.title)}</content>
    <author><name>${xmlEscape(entry.author || "uniswap")}</name></author>
  </entry>`).join("")}
</feed>`;

const governancePost = (id, overrides = {}) => ({
  id,
  topic_id: overrides.topic_id ?? 700,
  post_number: overrides.post_number ?? 1,
  username: overrides.username ?? "community-user",
  topic_slug: overrides.topic_slug ?? "governance-proposal",
  topic_title: overrides.topic_title ?? "Governance proposal",
  cooked: overrides.cooked ?? "<p>Onchain proposal and vote is live.</p>",
  created_at: overrides.created_at ?? "2026-08-05T12:00:00Z",
});

const okText = (url, body) => ({ ok: true, status: 200, url, text: async () => body });
const okJson = (url, body) => ({ ok: true, status: 200, url, json: async () => body, text: async () => JSON.stringify(body) });

async function fixture(initial = {}) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "uniswap-monitor-"));
  let current = Date.parse("2026-08-06T00:00:00.000Z");
  const requests = [];
  const alerts = [];
  const sources = {
    blog: initial.blog || sitemap([{ url: "https://blog.uniswap.org/introducing-uniswap-v4", lastmod: "2026-08-01" }]),
    blogPages: initial.blogPages || {},
    governance: initial.governance || { latest_posts: [governancePost(10)] },
    release: initial.release || releaseFeed([{ id: "release:v1", title: "v1.0.0", url: "https://github.com/Uniswap/liquidity-launcher/releases/tag/v1.0.0" }]),
  };
  let alertFailure = null;
  const fetchImpl = async (url) => {
    requests.push(url);
    if (url === UNISWAP_BLOG_SITEMAP_URL) {
      if (sources.blog instanceof Error) throw sources.blog;
      return okText(url, sources.blog);
    }
    if (url === UNISWAP_GOVERNANCE_POSTS_URL) {
      if (sources.governance instanceof Error) throw sources.governance;
      return okJson(url, sources.governance);
    }
    if (url === RELEASE_URL) {
      if (sources.release instanceof Error) throw sources.release;
      return okText(url, sources.release);
    }
    if (String(url).startsWith("https://blog.uniswap.org/")) {
      const page = sources.blogPages[url];
      if (page instanceof Error) throw page;
      return okText(url, page || "<html><main><h1>Product notes</h1><p>General interface improvements.</p></main></html>");
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createUniswapMonitor(
    {
      dataDir,
      uniswapBlogPollIntervalMs: 1_000,
      uniswapGovernancePollIntervalMs: 1_000,
      uniswapGithubPollIntervalMs: 1_000,
      uniswapMaxBackoffMs: 8_000,
    },
    {
      autoStart: false,
      fetchImpl,
      now: () => current,
      logger: quietLogger,
      sendAlertsImpl: async (_config, event) => {
        if (alertFailure?.(event)) throw new Error("telegram unavailable");
        alerts.push(event);
      },
    },
  );
  return {
    dataDir,
    monitor,
    sources,
    requests,
    alerts,
    advance: (milliseconds = 1_001) => { current += milliseconds; },
    failAlertsWhen: (predicate) => { alertFailure = predicate; },
  };
}

test("parses the canonical English Uniswap sitemap and classifies high-signal slugs", () => {
  const entries = parseUniswapBlogSitemap(sitemap([
    { url: "https://blog.uniswap.org/launch-aggregator-explore-top-uniswap-launchpads-in-one-place", lastmod: "2026-08-05" },
    { url: "https://blog.uniswap.org/es-ES/launch-aggregator-explore-top-uniswap-launchpads-in-one-place", lastmod: "2026-08-05" },
    { url: "https://example.com/fake-uniswap-launch", lastmod: "2026-08-05" },
  ]));
  assert.equal(entries.length, 1);
  assert.equal(entries[0].title, "Launch aggregator explore top Uniswap launchpads in one place");
  const signal = classifyUniswapBlogEntry(entries[0]);
  assert.equal(signal.relevant, true);
  assert.equal(signal.strong, true);
  assert.ok(signal.labels.includes("launch"));
  assert.equal(classifyUniswapBlogEntry({ title: "A design retrospective", url: "https://blog.uniswap.org/design-retrospective" }).relevant, false);
  assert.equal(classifyUniswapBlogEntry({ title: "New pool for DOG token", url: "https://blog.uniswap.org/new-pool-for-dog" }).relevant, false);
  assert.equal(classifyUniswapBlogEntry({ title: "New pool mechanism for Liquidity Launcher", url: "https://blog.uniswap.org/liquidity-launcher-pool-mechanism" }).relevant, true);
  const expansion = classifyUniswapBlogEntry({ title: "Uniswap launches Liquidity Launcher on Base mainnet", url: "https://blog.uniswap.org/liquidity-launcher-on-base" });
  assert.equal(expansion.relevant, true);
  assert.ok(expansion.labels.includes("chain_support"));
  assert.equal(expansion.chainSupport[0].chainId, 8453);
});

test("parses official article metadata and body for a chain launch absent from the slug", () => {
  const page = parseUniswapBlogPage(`<!doctype html><html><head>
    <meta property="og:title" content="A new chapter for liquidity" />
    <meta name="description" content="Liquidity Launcher adds permissionless launch pools on Base." />
    <script type="application/ld+json">${JSON.stringify({
      "@type": "BlogPosting",
      headline: "A new chapter for liquidity",
      articleBody: "Uniswap Liquidity Launcher is now live on Base mainnet.",
    })}</script>
  </head><body><article><p>Builders can deploy launch pools on Base mainnet.</p></article></body></html>`, {
    url: "https://blog.uniswap.org/a-new-chapter",
    title: "A new chapter",
  });
  const signal = classifyUniswapBlogEntry(page);
  assert.equal(signal.relevant, true);
  assert.equal(signal.chainSupport[0].name, "Base");
  assert.equal(page.description, "Liquidity Launcher adds permissionless launch pools on Base.");
  assert.equal(page.factSummary, "Builders can deploy launch pools on Base mainnet.");
  assert.equal(signal.summary, page.description, "the alert summary must preserve a concrete official description");
});

test("governance parsing uses durable post ids and rejects grants and reply chatter", () => {
  const [formal, grant, chatter] = parseUniswapGovernancePosts({
    latest_posts: [
      governancePost(12, { topic_title: "[Onchain] Enable protocol fees", cooked: "<p>The vote is live for protocol fees.</p>" }),
      governancePost(13, { topic_title: "Uniswap v4 grant application", cooked: "<p>Apply to the latest grants cohort.</p>" }),
      governancePost(14, { post_number: 9, topic_title: "Protocol fee proposal", cooked: "<p>I agree with the prior reply.</p>" }),
    ],
  });
  assert.equal(formal.url, "https://gov.uniswap.org/t/governance-proposal/700/1");
  assert.equal(classifyUniswapGovernancePost(formal).relevant, true);
  assert.equal(classifyUniswapGovernancePost(grant).relevant, false);
  assert.equal(classifyUniswapGovernancePost(chatter).relevant, false);
  const [parsedChainProposal] = parseUniswapGovernancePosts({ latest_posts: [governancePost(15, {
    topic_title: "[Onchain] Deploy Uniswap v4 on Base",
    cooked: "<p>The governance vote is live for the protocol deployment on Base mainnet.</p>",
  })] });
  const chainProposal = classifyUniswapGovernancePost(parsedChainProposal);
  assert.equal(chainProposal.relevant, true);
  assert.equal(chainProposal.chainSupport, undefined, "a proposal must not be presented as already supported");
  assert.equal(chainProposal.stage, "onchain_vote");
  assert.equal(chainProposal.deploymentConfirmed, false);
});

test("parses the official liquidity-launcher Atom release into a concise record", () => {
  const [release] = parseGithubReleaseFeed(releaseFeed([{
    id: "tag:github.com,2008:Repository/1/v3.2.0",
    title: "v3.2.0",
    url: "https://github.com/Uniswap/liquidity-launcher/releases/tag/v3.2.0",
    content: `<h2>Breaking changes</h2><p>${"Instant launch and fee splitter. ".repeat(30)}</p>`,
  }]), "Uniswap/liquidity-launcher");
  assert.equal(release.tag, "v3.2.0");
  assert.equal(release.repository, "Uniswap/liquidity-launcher");
  assert.ok(release.summary.length <= 280);
  assert.doesNotMatch(release.summary, /<h2>/);
});

test("first successful check creates silent baselines for all official sources", async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.dataDir, { recursive: true, force: true }));
  assert.equal(setup.requests.length, 0, "autoStart=false must not fetch");
  const result = await setup.monitor.check();
  assert.equal(result.blog.ok, true);
  assert.equal(result.governance.ok, true);
  assert.equal(result.githubReleases[0].ok, true);
  assert.equal(setup.alerts.length, 0);
  const state = JSON.parse(await fs.readFile(path.join(setup.dataDir, "uniswap-state.json"), "utf8"));
  assert.equal(state.governance.lastPostId, 10);
  assert.ok(state.blog.entries["https://blog.uniswap.org/introducing-uniswap-v4"]);
  assert.ok(state.githubReleases.feeds[RELEASE_URL].knownIds["release:v1"]);
  assert.equal(state._health.blog.status, "healthy");
  assert.equal(state._health.governance.status, "healthy");
  assert.equal(state._health.githubReleases[RELEASE_URL].status, "healthy");
  assert.equal(setup.requests.filter((url) => String(url).startsWith("https://blog.uniswap.org/") && url !== UNISWAP_BLOG_SITEMAP_URL).length, 0);
});

test("a new body-only chain launch is alerted and a detail failure remains retryable", async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.dataDir, { recursive: true, force: true }));
  await setup.monitor.check();
  const articleUrl = "https://blog.uniswap.org/a-new-chapter";
  setup.sources.blog = sitemap([
    { url: "https://blog.uniswap.org/introducing-uniswap-v4", lastmod: "2026-08-01" },
    { url: articleUrl, lastmod: "2026-08-06T00:00:00Z" },
  ]);
  setup.sources.blogPages[articleUrl] = new Error("detail fetch failed");
  setup.advance();
  const failed = await setup.monitor.check();
  assert.equal(failed.blog.ok, false);
  assert.equal(setup.monitor.state().blog.entries[articleUrl], undefined);

  setup.sources.blogPages[articleUrl] = "<html><article><h1>A new chapter</h1><p>Uniswap Liquidity Launcher is now live on Base mainnet.</p></article></html>";
  setup.advance();
  const recovered = await setup.monitor.check();
  assert.equal(recovered.blog.ok, true);
  const [alert] = setup.alerts.filter((event) => event.kind === "blog");
  assert.equal(alert.chainSupport[0].name, "Base");
  assert.equal(alert.title, "A new chapter");
  assert.equal(alert.summary, "Uniswap Liquidity Launcher is now live on Base mainnet.");
  assert.equal(alert.factSummary, alert.summary);
  assert.equal(alert.stage, "live");
  assert.equal(alert.deploymentConfirmed, true);
});

test("a high-signal slug still fetches its detail once and emits the concrete official change", async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.dataDir, { recursive: true, force: true }));
  await setup.monitor.check();
  const articleUrl = "https://blog.uniswap.org/new-liquidity-launcher-hook";
  setup.sources.blog = sitemap([
    { url: "https://blog.uniswap.org/introducing-uniswap-v4", lastmod: "2026-08-01" },
    { url: articleUrl, lastmod: "2026-08-06T00:00:00Z" },
  ]);
  setup.sources.blogPages[articleUrl] = `<html><head>
    <meta property="og:title" content="A new hook for Liquidity Launcher" />
    <meta name="description" content="Launchers can now split creator fees between two recipients." />
  </head><article><p>The new hook adds a configurable second fee recipient to each launch pool.</p></article></html>`;
  setup.advance();
  await setup.monitor.check();
  const [alert] = setup.alerts.filter((event) => event.kind === "blog");
  assert.equal(alert.summary, "Launchers can now split creator fees between two recipients.");
  assert.equal(alert.description, alert.summary);
  assert.equal(alert.factSummary, "The new hook adds a configurable second fee recipient to each launch pool.");
  assert.equal(alert.stage, "official_publication");
  assert.equal(alert.deploymentConfirmed, false);
  assert.equal(setup.requests.filter((url) => url === articleUrl).length, 1);
  setup.advance();
  await setup.monitor.check();
  assert.equal(setup.requests.filter((url) => url === articleUrl).length, 1, "an unchanged URL must not refetch or replay");
  assert.equal(setup.alerts.filter((event) => event.kind === "blog").length, 1);
});

test("new high-signal blog, governance, and GitHub releases alert once while noise stays silent", async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.dataDir, { recursive: true, force: true }));
  await setup.monitor.check();
  setup.sources.blog = sitemap([
    { url: "https://blog.uniswap.org/introducing-uniswap-v4", lastmod: "2026-08-01" },
    { url: "https://blog.uniswap.org/design-retrospective", lastmod: "2026-08-06" },
    { url: "https://blog.uniswap.org/pools-trade-a-new-way-to-launch-on-robinhood-chain", lastmod: "2026-08-06" },
  ]);
  setup.sources.blogPages["https://blog.uniswap.org/design-retrospective"] = "<html><article><h1>A design retrospective</h1><p>General interface design notes with no protocol capability change.</p></article></html>";
  setup.sources.blogPages["https://blog.uniswap.org/pools-trade-a-new-way-to-launch-on-robinhood-chain"] = `<html><head>
    <meta name="description" content="Pools.trade introduces a new launch mechanism for Robinhood Chain." />
  </head><article><h1>Pools.trade launch mechanism</h1><p>Creators can configure a new pool launch mode on Robinhood Chain.</p></article></html>`;
  setup.sources.governance = { latest_posts: [
    governancePost(10),
    governancePost(11, { topic_title: "[Onchain] Deploy Uniswap v4 on a new chain", cooked: "<p>Governance vote is live for protocol deployment.</p>" }),
    governancePost(12, { topic_title: "Uniswap Foundation grants", cooked: "<p>Apply for the newest grant cohort.</p>" }),
    governancePost(13, { post_number: 2, topic_title: "Protocol fees", cooked: "<p>Thanks for the update.</p>" }),
  ] };
  setup.sources.release = releaseFeed([
    { id: "release:v1", title: "v1.0.0", url: "https://github.com/Uniswap/liquidity-launcher/releases/tag/v1.0.0" },
    { id: "release:v2", title: "v2.0.0", url: "https://github.com/Uniswap/liquidity-launcher/releases/tag/v2.0.0", content: "InstantLaunchStrategy and FeeSplitter" },
  ]);
  setup.advance();
  await setup.monitor.check();
  assert.deepEqual(setup.alerts.map((event) => event.kind).sort(), ["blog", "github_release", "governance"]);
  assert.ok(setup.alerts.every((event) => event.type === "uniswap_official_update" && event.strong === true));
  const blog = setup.alerts.find((event) => event.kind === "blog");
  assert.ok(blog.labels.includes("robinhood"));
  assert.ok(blog.labels.includes("launch"));
  assert.equal(blog.chainSupport[0].name, "Robinhood Chain");
  assert.equal(blog.summary, "Pools.trade introduces a new launch mechanism for Robinhood Chain.");
  assert.equal(blog.stage, "official_publication");
  const governance = setup.alerts.find((event) => event.kind === "governance");
  assert.equal(governance.postId, 11);
  assert.equal(governance.chainSupport, undefined, "a live vote remains a governance alert, not a confirmed new-chain alert");
  assert.ok(governance.summary.length <= 280);
  assert.equal(governance.stage, "onchain_vote");
  assert.equal(governance.deploymentConfirmed, false);
  const release = setup.alerts.find((event) => event.kind === "github_release");
  assert.equal(release.repository, "Uniswap/liquidity-launcher");
  assert.equal(release.tag, "v2.0.0");
  assert.equal(release.summary, "InstantLaunchStrategy and FeeSplitter");
  assert.equal(release.stage, "github_release");
  assert.equal(release.deploymentConfirmed, false);
  setup.advance();
  await setup.monitor.check();
  assert.equal(setup.alerts.length, 3, "unchanged sources must not duplicate alerts");
  assert.equal(setup.monitor.state().governance.lastPostId, 13, "irrelevant posts still advance the durable cursor");
});

test("sitemap lastmod-only edits update state silently instead of replaying an old article", async (t) => {
  const url = "https://blog.uniswap.org/pools-trade-a-new-way-to-launch-on-robinhood-chain";
  const setup = await fixture({ blog: sitemap([{ url, lastmod: "2026-08-05" }]) });
  t.after(() => fs.rm(setup.dataDir, { recursive: true, force: true }));
  await setup.monitor.check();
  setup.sources.blog = sitemap([{ url, lastmod: "2026-08-06" }]);
  setup.advance();
  await setup.monitor.check();
  assert.equal(setup.alerts.filter((event) => event.kind === "blog").length, 0);
  assert.equal(setup.monitor.state().blog.entries[url].lastmod, "2026-08-06");
  assert.equal(setup.requests.filter((request) => request === url).length, 0, "lastmod-only edits must not fetch article detail");
});

test("a failed governance delivery does not advance its cursor and retries after source backoff", async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.dataDir, { recursive: true, force: true }));
  await setup.monitor.check();
  setup.sources.governance = { latest_posts: [
    governancePost(10),
    governancePost(11, { topic_title: "[Snapshot] Protocol fee switch", cooked: "<p>Snapshot vote is live for protocol fees.</p>" }),
  ] };
  setup.failAlertsWhen((event) => event.kind === "governance");
  setup.advance();
  const failed = await setup.monitor.check();
  assert.equal(failed.governance.ok, false);
  assert.equal(setup.monitor.state().governance.lastPostId, 10);
  assert.equal(setup.monitor.state()._health.governance.status, "backoff");
  setup.failAlertsWhen(() => false);
  setup.advance();
  await setup.monitor.check();
  assert.equal(setup.alerts.filter((event) => event.kind === "governance").length, 1);
  assert.equal(setup.monitor.state().governance.lastPostId, 11);
  assert.equal(setup.monitor.state()._health.governance.status, "healthy");
});

test("failed blog and release deliveries preserve their unseen records for retry", async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.dataDir, { recursive: true, force: true }));
  await setup.monitor.check();
  const blogUrl = "https://blog.uniswap.org/new-liquidity-launcher-hook";
  setup.sources.blog = sitemap([
    { url: "https://blog.uniswap.org/introducing-uniswap-v4", lastmod: "2026-08-01" },
    { url: blogUrl, lastmod: "2026-08-06" },
  ]);
  setup.sources.release = releaseFeed([
    { id: "release:v1", title: "v1.0.0", url: "https://github.com/Uniswap/liquidity-launcher/releases/tag/v1.0.0" },
    { id: "release:v2", title: "v2.0.0", url: "https://github.com/Uniswap/liquidity-launcher/releases/tag/v2.0.0" },
  ]);
  setup.failAlertsWhen((event) => event.kind === "blog" || event.kind === "github_release");
  setup.advance();
  await setup.monitor.check();
  assert.equal(setup.monitor.state().blog.entries[blogUrl], undefined);
  assert.equal(setup.monitor.state().githubReleases.feeds[RELEASE_URL].knownIds["release:v2"], undefined);
  setup.failAlertsWhen(() => false);
  setup.advance();
  await setup.monitor.check();
  assert.equal(setup.alerts.filter((event) => event.kind === "blog").length, 1);
  assert.equal(setup.alerts.filter((event) => event.kind === "github_release").length, 1);
});

test("one failed source backs off without blocking healthy sources", async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.dataDir, { recursive: true, force: true }));
  await setup.monitor.check();
  setup.sources.blog = new Error("blog unavailable");
  setup.sources.governance = { latest_posts: [governancePost(10), governancePost(11, {
    topic_title: "[Onchain] New UniswapX mechanism",
    cooked: "<p>Governance proposal for a new UniswapX mechanism.</p>",
  })] };
  setup.advance();
  const result = await setup.monitor.check();
  assert.equal(result.blog.ok, false);
  assert.equal(result.governance.ok, true);
  assert.equal(setup.monitor.state()._health.blog.status, "backoff");
  assert.equal(setup.monitor.state()._health.governance.status, "healthy");
  assert.equal(setup.monitor.state().governance.lastPostId, 11);
  assert.equal(setup.alerts.filter((event) => event.kind === "governance").length, 1);
});

test("startup immediately retries persisted transport failures but preserves HTTP policy backoff", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "uniswap-startup-recovery-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const stateFile = path.join(dataDir, "uniswap-state.json");
  const now = Date.parse("2026-08-06T00:00:00.000Z");
  const future = "2026-08-06T01:00:00.000Z";
  const backoff = (lastError) => ({
    status: "backoff",
    consecutiveFailures: 5,
    lastAttemptAt: "2026-08-05T23:59:00.000Z",
    lastSuccessAt: "2026-08-05T23:00:00.000Z",
    lastErrorAt: "2026-08-05T23:59:00.000Z",
    lastError,
    nextAttemptAt: future,
  });
  await fs.writeFile(stateFile, `${JSON.stringify({
    version: 1,
    blog: { initializedAt: "2026-08-05T23:00:00.000Z", entries: {} },
    governance: { initializedAt: "2026-08-05T23:00:00.000Z", lastPostId: 10 },
    githubReleases: { feeds: { [RELEASE_URL]: { repository: "Uniswap/liquidity-launcher", initializedAt: "2026-08-05T23:00:00.000Z", knownIds: {} } } },
    _health: {
      blog: backoff("fetch failed: EADDRNOTAVAIL"),
      governance: backoff("HTTP 429"),
      githubReleases: { [RELEASE_URL]: backoff("HTTP 403") },
    },
  })}\n`);
  const requests = [];
  const monitor = createUniswapMonitor({ dataDir }, {
    autoStart: false,
    now: () => now,
    logger: quietLogger,
    fetchImpl: async (url) => {
      requests.push(url);
      if (url !== UNISWAP_BLOG_SITEMAP_URL) throw new Error(`unexpected startup request ${url}`);
      return okText(url, sitemap([]));
    },
    sendAlertsImpl: async () => {},
  });

  const result = await monitor.check();
  assert.deepEqual(requests, [UNISWAP_BLOG_SITEMAP_URL]);
  assert.equal(result.blog.ok, true);
  assert.equal(result.governance.reason, "backoff");
  assert.equal(result.githubReleases[0].reason, "backoff");
  assert.equal(monitor.state()._health.blog.status, "healthy");
});

test("transport outage backoff stays capped at one minute", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "uniswap-transport-cap-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let current = Date.parse("2026-08-06T00:00:00.000Z");
  const monitor = createUniswapMonitor({
    dataDir,
    uniswapBlogPollIntervalMs: 1_000,
    uniswapGovernancePollIntervalMs: 1_000,
    uniswapMaxBackoffMs: 10 * 60_000,
  }, {
    autoStart: false,
    githubReleaseFeeds: [],
    now: () => current,
    logger: quietLogger,
    fetchImpl: async () => { throw new Error("fetch failed: socket unavailable"); },
    sendAlertsImpl: async () => {},
  });

  for (let attempt = 0; attempt < 8; attempt += 1) {
    await monitor.check();
    current = Date.parse(monitor.state()._health.blog.nextAttemptAt);
  }
  const health = monitor.state()._health.blog;
  assert.equal(Date.parse(health.nextAttemptAt) - Date.parse(health.lastAttemptAt), 60_000);
});

test("state writer uses a temporary file and atomic rename", async () => {
  const calls = [];
  const fakeFs = {
    async mkdir(directory, options) { calls.push(["mkdir", directory, options]); },
    async writeFile(file, contents) { calls.push(["write", file, contents]); },
    async rename(from, to) { calls.push(["rename", from, to]); },
    async unlink(file) { calls.push(["unlink", file]); },
  };
  await atomicWriteUniswapState("/tmp/uniswap-test/state.json", { ok: true }, fakeFs);
  assert.equal(calls[0][0], "mkdir");
  assert.match(calls[1][1], /state\.json\.\d+\.\d+\.tmp$/);
  assert.deepEqual(calls[2], ["rename", calls[1][1], "/tmp/uniswap-test/state.json"]);
  assert.equal(calls.some(([operation]) => operation === "unlink"), false);
});

test("stop prevents future manual or scheduled checks", async (t) => {
  const setup = await fixture();
  t.after(() => fs.rm(setup.dataDir, { recursive: true, force: true }));
  setup.monitor.stop();
  const result = await setup.monitor.check();
  assert.deepEqual(result, { skipped: true, reason: "stopped" });
  assert.equal(setup.requests.length, 0);
});

test("scheduled Uniswap ticks coalesce into one non-concurrent catch-up cycle", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "uniswap-scheduler-coalesce-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let intervalTick;
  t.mock.method(globalThis, "setInterval", (callback) => {
    intervalTick = callback;
    return { unref() {} };
  });
  t.mock.method(globalThis, "clearInterval", () => {});

  let current = Date.parse("2026-08-06T00:00:00.000Z");
  let blogRequests = 0;
  let activeBlogRequests = 0;
  let maximumActiveBlogRequests = 0;
  let releaseFirst;
  const firstBlocked = new Promise((resolve) => { releaseFirst = resolve; });
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
  const monitor = createUniswapMonitor({
    dataDir,
    uniswapBlogPollIntervalMs: 1_000,
    uniswapGovernancePollIntervalMs: 1_000,
    uniswapGithubPollIntervalMs: 1_000,
  }, {
    githubReleaseFeeds: [],
    now: () => current,
    logger: quietLogger,
    sendAlertsImpl: async () => {},
    fetchImpl: async (url) => {
      if (url === UNISWAP_GOVERNANCE_POSTS_URL) return okJson(url, { latest_posts: [governancePost(10)] });
      assert.equal(url, UNISWAP_BLOG_SITEMAP_URL);
      blogRequests += 1;
      activeBlogRequests += 1;
      maximumActiveBlogRequests = Math.max(maximumActiveBlogRequests, activeBlogRequests);
      try {
        if (blogRequests === 1) {
          markFirstStarted();
          await firstBlocked;
        }
        return okText(url, sitemap([]));
      } finally {
        activeBlogRequests -= 1;
      }
    },
  });

  await firstStarted;
  assert.deepEqual(await monitor.check(), { skipped: true, reason: "running" }, "manual overlap semantics stay unchanged");
  const catchUp = intervalTick();
  intervalTick();
  intervalTick();
  current += 1_001;
  releaseFirst();
  await catchUp;
  monitor.stop();

  assert.equal(blogRequests, 2, "many overlapping timer ticks collapse into one immediate follow-up");
  assert.equal(maximumActiveBlogRequests, 1, "the catch-up cycle must never overlap the active cycle");
});

test("Uniswap stop is idempotent and drains an in-flight alert plus its cursor checkpoint", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "uniswap-stop-drain-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let current = Date.parse("2026-08-06T00:00:00.000Z");
  let posts = [governancePost(10)];
  let releaseAlert;
  const alertBlocked = new Promise((resolve) => { releaseAlert = resolve; });
  let markAlertStarted;
  const alertStarted = new Promise((resolve) => { markAlertStarted = resolve; });
  const monitor = createUniswapMonitor({
    dataDir,
    uniswapBlogPollIntervalMs: 1_000,
    uniswapGovernancePollIntervalMs: 1_000,
    uniswapGithubPollIntervalMs: 1_000,
  }, {
    autoStart: false,
    githubReleaseFeeds: [],
    now: () => current,
    logger: quietLogger,
    fetchImpl: async (url) => {
      if (url === UNISWAP_BLOG_SITEMAP_URL) return okText(url, sitemap([]));
      if (url === UNISWAP_GOVERNANCE_POSTS_URL) return okJson(url, { latest_posts: posts });
      throw new Error(`unexpected URL ${url}`);
    },
    sendAlertsImpl: async () => {
      markAlertStarted();
      await alertBlocked;
    },
  });

  await monitor.check();
  current += 1_001;
  posts = [governancePost(10), governancePost(11, {
    topic_title: "[Onchain] Deploy Uniswap v4 on a new chain",
    cooked: "<p>Governance vote is live for protocol deployment.</p>",
  })];
  const checking = monitor.check();
  await alertStarted;
  const stopping = monitor.stop();
  assert.equal(monitor.stop(), stopping, "repeated stops share one drain boundary");
  assert.equal(monitor.check(), checking, "a post-stop check cannot start another source round");
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  releaseAlert();
  await stopping;
  assert.equal(monitor.state().governance.lastPostId, 11);
  const durable = JSON.parse(await fs.readFile(path.join(dataDir, "uniswap-state.json"), "utf8"));
  assert.equal(durable.governance.lastPostId, 11);
});
