import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  atomicWriteXaiOfficialState,
  classifyAiOfficialUpdate,
  createXaiOfficialMonitor,
  parseXApiChangelogRss,
  parseXaiNewsJina,
  parseXaiReleaseNotesMarkdown,
} from "../src/xai-official-monitor.js";

function rssItem({ guid, title, body, date = "Tue, 11 Aug 2026 10:00:00 GMT" }) {
  return `<item>
    <title>${date.slice(5, 16)}</title>
    <link>https://docs.x.com/changelog/${guid}</link>
    <guid>${guid}</guid>
    <pubDate>${date}</pubDate>
    <content:encoded><![CDATA[<h3>${title}</h3><p>${body}</p>]]></content:encoded>
  </item>`;
}

function rss(items) {
  return `<?xml version="1.0"?><rss xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel>${items.join("\n")}</channel></rss>`;
}

const baseRss = () => rss([
  rssItem({
    guid: "mute-block-events",
    title: "Mute and block events for X Activity API",
    body: "The X Activity API now supports real-time mute and block webhook events.",
  }),
]);

const baseRelease = () => `#### Release Notes
# Release Notes
## August
### Grok Bot
Grok Bot is now available and can execute tools for developers.

## July
### grok-imagine-video-1.5 modalities
The API now supports additional video modalities.
`;

const baseNews = () => `Title: SpaceXAI
URL Source: http://x.ai/news
Markdown Content:
[![Image](https://assets.x.ai/bot.png) Aug 11, 2026 Early beta ## Introducing Grok Bot Grok Bot is now available to developers.](http://x.ai/news/introducing-grok-bot)
## All posts
### [Grok 4.5 in GitHub Copilot Grok 4.5 is now available in GitHub Copilot. Jul 28, 2026](http://x.ai/news/grok-github-copilot)### [A customer story Case study with Acme. Jul 20, 2026](http://x.ai/news/acme-customer-story)`;

function response(body, status = 200, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    text: async () => body,
  };
}

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "xai-official-monitor-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function config(dataDir) {
  return {
    dataDir,
    xApiChangelogRssUrl: "https://fixture.test/x.rss",
    xaiReleaseNotesUrl: "https://fixture.test/release.md",
    xaiNewsJinaUrl: "https://fixture.test/news.md",
    xApiChangelogPollIntervalMs: 0,
    xaiReleaseNotesPollIntervalMs: 0,
    xaiNewsPollIntervalMs: 0,
    xaiOfficialBackoffBaseMs: 1_000,
    xaiOfficialBackoffMaxMs: 8_000,
  };
}

test("parses the X API RSS heading, GUID, publication time and stable identity", () => {
  const first = parseXApiChangelogRss(baseRss());
  assert.equal(first.length, 1);
  assert.equal(first[0].title, "Mute and block events for X Activity API");
  assert.match(first[0].summary, /real-time mute and block webhook events/);
  assert.equal(first[0].externalId, "mute-block-events");
  assert.equal(first[0].publishedAt, "2026-08-11T10:00:00.000Z");
  assert.equal(classifyAiOfficialUpdate(first[0]).relevant, true);

  const edited = parseXApiChangelogRss(baseRss().replace("real-time", "near real-time"));
  assert.equal(edited[0].stableId, first[0].stableId);
  assert.notEqual(edited[0].contentHash, first[0].contentHash);
});

test("parses xAI Markdown sections into stable release-note entries", () => {
  const entries = parseXaiReleaseNotesMarkdown(baseRelease(), {
    sourceUrl: "https://docs.x.ai/developers/release-notes.md",
    observedAt: "2026-08-12T00:00:00.000Z",
  });
  assert.deepEqual(entries.map((item) => item.title), ["Grok Bot", "grok-imagine-video-1.5 modalities"]);
  assert.equal(entries[0].section, "August 2026");
  assert.match(entries[0].url, /release-notes\.md#grok-bot$/);
  assert.equal(classifyAiOfficialUpdate(entries[0]).relevant, true);

  const proseEdited = parseXaiReleaseNotesMarkdown(baseRelease().replace("execute tools", "execute more tools"), {
    observedAt: "2026-08-12T00:00:00.000Z",
  });
  assert.equal(proseEdited[0].stableId, entries[0].stableId);
  assert.notEqual(proseEdited[0].contentHash, entries[0].contentHash);
});

test("parses concatenated Jina news cards, canonicalizes URLs and deduplicates by slug", () => {
  const duplicated = `${baseNews()}\n### [Introducing Grok Bot duplicate](https://www.x.ai/news/introducing-grok-bot?utm_source=test)`;
  const entries = parseXaiNewsJina(duplicated);
  assert.equal(entries.length, 3);
  const bot = entries.find((item) => item.url.endsWith("introducing-grok-bot"));
  assert.ok(bot);
  assert.equal(bot.title, "Introducing Grok Bot");
  assert.equal(bot.url, "https://x.ai/news/introducing-grok-bot");
  assert.equal(bot.publishedAt, "2026-08-11T00:00:00.000Z");

  const edited = parseXaiNewsJina(baseNews().replace("now available to developers", "available globally to developers"));
  assert.equal(edited.find((item) => item.url.endsWith("introducing-grok-bot")).stableId, bot.stableId);
});

test("high-signal classification keeps product, model, API and security changes but drops promotion", () => {
  const relevant = [
    { sourceKey: "xai_news", title: "Introducing Grok 5", summary: "We released a new frontier model." },
    { sourceKey: "xai_release_notes", title: "Grok Bot", summary: "Grok Bot is now available with new agent tools." },
    { sourceKey: "xai_release_notes", title: "Adjustable VAD threshold for Speech to Text", summary: "Speech to Text now accepts a VAD threshold parameter." },
    { sourceKey: "xai_news", title: "Grok Imagine Image 2", summary: "Imagine Image 2.0" },
    { sourceKey: "x_api_changelog", title: "Webhook endpoint deprecated", summary: "Mandatory API migration is required." },
  ];
  for (const item of relevant) assert.equal(classifyAiOfficialUpdate(item).relevant, true, item.title);
  assert.deepEqual(
    classifyAiOfficialUpdate({ sourceKey: "xai_news", title: "Introducing Grok 5", summary: "We released a new frontier model." }).identifiers,
    ["grok 5"],
    "identifier extraction must not absorb surrounding release prose",
  );

  const ignored = [
    { sourceKey: "xai_news", title: "Customer story", summary: "A case study about an advertising campaign using Grok." },
    { sourceKey: "xai_news", title: "Join our webinar", summary: "A conference event recap and giveaway." },
    { sourceKey: "x_api_changelog", title: "Documentation cleanup", summary: "Minor formatting and typo fixes." },
    { sourceKey: "xai_news", title: "xAI raises $20 billion", summary: "New compute infrastructure." },
    { sourceKey: "xai_news", title: "xAI partners with Example Corp", summary: "A new corporate partnership." },
  ];
  for (const item of ignored) assert.equal(classifyAiOfficialUpdate(item).relevant, false, item.title);
});

test("silently baselines each source, then queues only new material entries and never repeats them", async (t) => {
  const dataDir = await fixture(t);
  const bodies = new Map([
    ["https://fixture.test/x.rss", baseRss()],
    ["https://fixture.test/release.md", baseRelease()],
    ["https://fixture.test/news.md", baseNews()],
  ]);
  const alerts = [];
  const requestHeaders = new Map();
  const monitor = createXaiOfficialMonitor(config(dataDir), {
    autoStart: false,
    now: () => Date.parse("2026-08-12T00:00:00.000Z"),
    fetchImpl: async (url, request) => {
      requestHeaders.set(url, request.headers);
      return response(bodies.get(url));
    },
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "queued" }; },
    logger: { error() {} },
  });

  const baseline = await monitor.check();
  assert.equal(baseline.status, "healthy");
  assert.equal(alerts.length, 0);
  assert.match(requestHeaders.get("https://fixture.test/x.rss").accept, /application\/rss\+xml/);
  assert.doesNotMatch(requestHeaders.get("https://fixture.test/release.md").accept, /text\/markdown/);

  bodies.set("https://fixture.test/x.rss", rss([
    rssItem({ guid: "filtered-stream-v2", title: "X Activity API launches filtered stream v2", body: "A new streaming API endpoint and webhook event are available." }),
    ...parseRawItems(baseRss()),
  ]));
  bodies.set("https://fixture.test/release.md", baseRelease().replace("### Grok Bot", "### Grok Code Agent\n+We released a new Grok coding agent tool.\n\n### Grok Bot"));
  bodies.set("https://fixture.test/news.md", `${baseNews()}\n### [Introducing Grok 5 We released the new Grok 5 model. Aug 12, 2026](http://x.ai/news/introducing-grok-5)\n### [Customer story A case study with an advertiser. Aug 12, 2026](http://x.ai/news/customer-story-advertiser)`);

  const changed = await monitor.check();
  assert.equal(changed.delivered, 3);
  assert.equal(alerts.length, 3);
  assert.deepEqual(new Set(alerts.map((event) => event.kind)), new Set(["x_api_changelog", "xai_release_notes", "xai_news"]));
  for (const event of alerts) {
    assert.equal(event.type, "ai_official_update");
    assert.equal(event.source.official, true);
    assert.equal(event.source.trust, "official_verified");
    assert.match(event.eventKey, /^ai-official:/);
    assert.equal(event.changeType, "published");
    assert.equal(event.comparisonBasis, "monitoring_baseline");
    assert.equal(event.baselineStatus, "not_recorded");
    assert.ok(event.currentSnapshot.title);
    assert.ok(event.changedFields.includes("title"));
  }

  const repeated = await monitor.check();
  assert.equal(repeated.delivered, 0);
  assert.equal(alerts.length, 3);
  const state = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  assert.equal(state.sources.xai_news.initialized, true);
  assert.equal(Object.keys(state.sources.xai_news.entries).length, 5);
  await monitor.stop();
});

test("revised xAI and X entries carry the exact persisted before/after display snapshot", async (t) => {
  const dataDir = await fixture(t);
  const bodies = new Map([
    ["https://fixture.test/x.rss", baseRss()],
    ["https://fixture.test/release.md", baseRelease()],
    ["https://fixture.test/news.md", baseNews()],
  ]);
  const alerts = [];
  const monitor = createXaiOfficialMonitor(config(dataDir), {
    autoStart: false,
    now: () => Date.parse("2026-08-12T00:00:00.000Z"),
    fetchImpl: async (url) => response(bodies.get(url)),
    sendAlertsImpl: async (_config, event) => { alerts.push(event); return { status: "queued" }; },
    logger: { error() {} },
  });

  await monitor.check();
  bodies.set("https://fixture.test/x.rss", baseRss().replace(
    "real-time mute and block webhook events",
    "near real-time mute, block, and account-label webhook events",
  ));
  const result = await monitor.check();

  assert.equal(result.delivered, 1);
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].changeType, "revised");
  assert.equal(alerts[0].comparisonBasis, "exact_snapshot");
  assert.match(alerts[0].previousSnapshot.summary, /real-time mute and block/);
  assert.match(alerts[0].currentSnapshot.summary, /near real-time mute, block/);
  assert.ok(alerts[0].changedFields.includes("summary"));
  const state = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  const record = Object.values(state.sources.x_api_changelog.entries)[0];
  assert.equal(record.title, "Mute and block events for X Activity API");
  assert.match(record.summary, /account-label webhook events/);
  assert.equal(record.stage, "available");
  assert.deepEqual(record.identifiers, ["x activity api", "webhook"]);
  assert.deepEqual(record.displaySnapshot.identifiers, record.identifiers);
  await monitor.stop();
});

function parseRawItems(xml) {
  return String(xml).match(/<item\b[\s\S]*?<\/item>/gi) || [];
}

test("backs off a failed source independently while healthy sources continue", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-12T00:00:00.000Z");
  let xFails = true;
  const calls = { x: 0, release: 0, news: 0 };
  const monitor = createXaiOfficialMonitor(config(dataDir), {
    autoStart: false,
    now: () => current,
    fetchImpl: async (url) => {
      if (url.endsWith("x.rss")) {
        calls.x += 1;
        return xFails ? response("unavailable", 503) : response(baseRss());
      }
      if (url.endsWith("release.md")) { calls.release += 1; return response(baseRelease()); }
      calls.news += 1;
      return response(baseNews());
    },
    sendAlertsImpl: async () => ({ status: "queued" }),
    logger: { error() {} },
  });

  const first = await monitor.check();
  assert.equal(first.status, "degraded");
  let state = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  assert.equal(state.health.sources.x_api_changelog.status, "backoff");
  assert.equal(state.health.sources.xai_release_notes.status, "healthy");
  assert.equal(state.health.sources.xai_news.status, "healthy");
  assert.equal(state.sources.xai_release_notes.initialized, true);

  await monitor.check();
  assert.equal(calls.x, 1, "failed source should be skipped until its own backoff expires");
  assert.equal(calls.release, 2, "healthy source should keep polling independently");
  assert.equal(calls.news, 2, "healthy source should keep polling independently");

  xFails = false;
  current += 1_000;
  const recovered = await monitor.check();
  assert.equal(recovered.status, "healthy");
  state = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  assert.equal(state.health.sources.x_api_changelog.status, "healthy");
  assert.equal(state.health.sources.x_api_changelog.consecutiveFailures, 0);
  assert.equal(state.sources.x_api_changelog.initialized, true);
  await monitor.stop();
});

test("serial xAI sources anchor healthy cadence to each request start", async (t) => {
  const dataDir = await fixture(t);
  const epoch = Date.parse("2026-08-12T00:00:00.000Z");
  let current = epoch;
  let slowBaseline = true;
  const starts = [];
  const sourceKeyByUrl = new Map([
    ["https://fixture.test/x.rss", "x_api_changelog"],
    ["https://fixture.test/release.md", "xai_release_notes"],
    ["https://fixture.test/news.md", "xai_news"],
  ]);
  const baselineDuration = new Map([
    ["x_api_changelog", 20_000],
    ["xai_release_notes", 15_000],
    ["xai_news", 5_000],
  ]);
  const monitor = createXaiOfficialMonitor(config(dataDir), {
    autoStart: false,
    now: () => current,
    sourceDefinitions: [
      { key: "x_api_changelog", intervalMs: 60_000 },
      { key: "xai_release_notes", intervalMs: 60_000 },
      { key: "xai_news", intervalMs: 60_000 },
    ],
    fetchImpl: async (url) => {
      const key = sourceKeyByUrl.get(url);
      starts.push({ key, at: current });
      if (slowBaseline) current += baselineDuration.get(key);
      if (key === "x_api_changelog") return response(baseRss());
      if (key === "xai_release_notes") return response(baseRelease());
      return response(baseNews());
    },
    sendAlertsImpl: async () => ({ status: "queued" }),
    logger: { error() {} },
  });

  await monitor.check();
  let state = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  assert.deepEqual(starts, [
    { key: "x_api_changelog", at: epoch },
    { key: "xai_release_notes", at: epoch + 20_000 },
    { key: "xai_news", at: epoch + 35_000 },
  ]);
  assert.equal(state.health.sources.x_api_changelog.nextAttemptAt, new Date(epoch + 60_000).toISOString(), "the first source cadence is not extended by its 20-second response");
  assert.equal(state.health.sources.xai_release_notes.nextAttemptAt, new Date(epoch + 80_000).toISOString());
  assert.equal(state.health.sources.xai_news.nextAttemptAt, new Date(epoch + 95_000).toISOString());

  slowBaseline = false;
  starts.length = 0;
  current = epoch + 60_000;
  const next = await monitor.check();
  assert.deepEqual(next.checked, ["x_api_changelog"]);
  assert.deepEqual(new Set(next.skipped), new Set(["xai_release_notes", "xai_news"]));
  assert.deepEqual(starts, [{ key: "x_api_changelog", at: epoch + 60_000 }], "later serial sources do not immediately catch up to the first source's cadence");
  state = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  assert.equal(state.health.sources.x_api_changelog.nextAttemptAt, new Date(epoch + 120_000).toISOString());
  await monitor.stop();
});

test("xAI failure backoff starts at the actual error time while aggregate health keeps the cycle start", async (t) => {
  const dataDir = await fixture(t);
  const epoch = Date.parse("2026-08-12T00:00:00.000Z");
  let current = epoch;
  const monitor = createXaiOfficialMonitor(config(dataDir), {
    autoStart: false,
    now: () => current,
    sourceDefinitions: [{
      key: "x_api_changelog",
      name: "X API delayed failure fixture",
      url: "https://fixture.test/delayed-failure.rss",
      intervalMs: 60_000,
      parser: parseRawItems,
    }],
    fetchImpl: async () => {
      current += 20_000;
      return response("unavailable", 503);
    },
    sendAlertsImpl: async () => ({ status: "queued" }),
    logger: { error() {} },
  });

  const failed = await monitor.check();
  const state = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  assert.equal(failed.status, "error");
  assert.equal(state.health.status, "error");
  assert.equal(state.health.checkedAt, new Date(epoch).toISOString(), "aggregate health retains the cycle-start timestamp");
  assert.equal(state.health.sources.x_api_changelog.checkedAt, new Date(epoch + 20_000).toISOString());
  assert.equal(state.health.sources.x_api_changelog.lastErrorAt, new Date(epoch + 20_000).toISOString());
  assert.equal(state.health.sources.x_api_changelog.nextAttemptAt, new Date(epoch + 21_000).toISOString(), "backoff starts when the delayed request fails");
  await monitor.stop();
});

test("a terminal xAI policy suppression advances the entry and does not retry", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-12T00:00:00.000Z");
  const bodies = new Map([
    ["https://fixture.test/x.rss", baseRss()],
    ["https://fixture.test/release.md", baseRelease()],
    ["https://fixture.test/news.md", baseNews()],
  ]);
  let suppress = false;
  const alerts = [];
  const monitor = createXaiOfficialMonitor(config(dataDir), {
    autoStart: false,
    now: () => current,
    fetchImpl: async (url) => response(bodies.get(url)),
    sendAlertsImpl: async (_config, event) => {
      alerts.push(event);
      return suppress ? { status: "suppressed", reason: "monitoring_source_disabled" } : { status: "queued" };
    },
    logger: { error() {} },
  });
  await monitor.check();
  bodies.set("https://fixture.test/news.md", `${baseNews()}\n### [Introducing Grok 5 We released the new Grok 5 model. Aug 12, 2026](http://x.ai/news/introducing-grok-5)`);
  suppress = true;
  const filtered = await monitor.check();
  assert.equal(filtered.status, "healthy");
  assert.equal(filtered.delivered, 1);
  let state = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  const newItem = parseXaiNewsJina(bodies.get("https://fixture.test/news.md"), {
    sourceUrl: "https://fixture.test/news.md",
    observedAt: new Date(current).toISOString(),
  }).find((item) => item.url.endsWith("introducing-grok-5"));
  assert.equal(state.sources.xai_news.entries[newItem.stableId].contentHash, newItem.contentHash);
  assert.equal(state.health.sources.xai_news.status, "healthy");

  current += 1_000;
  const repeated = await monitor.check();
  assert.equal(repeated.delivered, 0);
  state = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  assert.equal(state.sources.xai_news.entries[newItem.stableId].contentHash, newItem.contentHash);
  assert.equal(alerts.filter((event) => event.title === "Introducing Grok 5").length, 1, "the terminally filtered entry must not reach the sender twice");
  await monitor.stop();
});

test("startup retries a legacy delivery-classification backoff once without bypassing HTTP backoff", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.parse("2026-08-12T00:00:00.000Z");
  const future = "2026-08-12T01:00:00.000Z";
  await fs.writeFile(path.join(dataDir, "xai-official-state.json"), `${JSON.stringify({
    version: 1,
    sources: {
      x_api_changelog: { initialized: true, entries: {} },
      xai_release_notes: { initialized: true, entries: {} },
      xai_news: { initialized: true, entries: {} },
    },
    health: {
      status: "degraded",
      checkedAt: "2026-08-11T23:59:00.000Z",
      sources: {
        x_api_changelog: { status: "backoff", nextAttemptAt: future, lastError: "X API Changelog returned HTTP 429", consecutiveFailures: 1 },
        xai_release_notes: { status: "healthy", nextAttemptAt: future, consecutiveFailures: 0 },
        xai_news: { status: "backoff", nextAttemptAt: future, lastError: "AI official alert was not durably queued", consecutiveFailures: 9 },
      },
    },
  }, null, 2)}\n`);
  const requests = [];
  const monitor = createXaiOfficialMonitor(config(dataDir), {
    autoStart: false,
    now: () => current,
    fetchImpl: async (url) => {
      requests.push(url);
      assert.equal(url, "https://fixture.test/news.md");
      return response(baseNews());
    },
    sendAlertsImpl: async () => ({ status: "suppressed", reason: "not_relevant" }),
    logger: { error() {} },
  });

  const recovered = await monitor.check();
  assert.deepEqual(requests, ["https://fixture.test/news.md"]);
  assert.ok(recovered.skipped.includes("x_api_changelog"), "HTTP policy backoff must remain intact");
  assert.ok(recovered.skipped.includes("xai_release_notes"));
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "xai-official-state.json"), "utf8"));
  assert.equal(state.health.sources.xai_news.status, "healthy");
  assert.equal(state.health.sources.xai_news.consecutiveFailures, 0);
  await monitor.stop();
});

test("an empty schema cannot create a silent baseline", async (t) => {
  const dataDir = await fixture(t);
  const monitor = createXaiOfficialMonitor(config(dataDir), {
    autoStart: false,
    fetchImpl: async (url) => {
      if (url.endsWith("x.rss")) return response(baseRss());
      if (url.endsWith("release.md")) return response(baseRelease());
      return response("Title: xAI\nMarkdown Content: no news entries");
    },
    sendAlertsImpl: async () => ({ status: "queued" }),
    logger: { error() {} },
  });
  const result = await monitor.check();
  assert.equal(result.status, "degraded");
  const state = JSON.parse(await fs.readFile(monitor.stateFile, "utf8"));
  assert.equal(state.sources.xai_news.initialized, false);
  assert.equal(state.health.sources.xai_news.status, "backoff");
  assert.match(state.health.sources.xai_news.lastError, /schema produced no entries/);
  await monitor.stop();
});

test("writes state atomically through a temporary file and rename", async (t) => {
  const dataDir = await fixture(t);
  const file = path.join(dataDir, "nested", "state.json");
  await atomicWriteXaiOfficialState(file, { version: 1, hello: "world" });
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 1, hello: "world" });
  const names = await fs.readdir(path.dirname(file));
  assert.deepEqual(names, ["state.json"]);
});

test("overlapping xAI scheduler ticks coalesce into one immediate serial follow-up", async (t) => {
  const dataDir = await fixture(t);
  let requests = 0;
  let active = 0;
  let maxActive = 0;
  let releaseFirst;
  let releaseSecond;
  let signalStarted;
  let signalSecondStarted;
  const firstStarted = new Promise((resolve) => { signalStarted = resolve; });
  const secondStarted = new Promise((resolve) => { signalSecondStarted = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const secondRelease = new Promise((resolve) => { releaseSecond = resolve; });
  const monitor = createXaiOfficialMonitor(config(dataDir), {
    autoStart: false,
    sourceDefinitions: [{
      key: "x_api_changelog",
      name: "X API fixture",
      url: "https://fixture.test/coalesced.rss",
      intervalMs: 0,
      parser: () => [{
        stableId: "baseline",
        title: "X API baseline",
        summary: "The API now supports a stable endpoint.",
        contentHash: "baseline-hash",
      }],
    }],
    fetchImpl: async () => {
      requests += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (requests === 1) {
          signalStarted();
          await firstRelease;
        } else if (requests === 2) {
          signalSecondStarted();
          await secondRelease;
        }
        return response("fixture");
      } finally {
        active -= 1;
      }
    },
    sendAlertsImpl: async () => ({ status: "queued" }),
    logger: { error() {} },
  });

  const first = monitor.check();
  await firstStarted;
  const overlaps = [monitor.check(), monitor.check(), monitor.check()];
  releaseFirst();
  await secondStarted;
  const secondCycleOverlaps = [monitor.check(), monitor.check()];
  releaseSecond();
  await Promise.all([first, ...overlaps, ...secondCycleOverlaps]);

  assert.equal(requests, 2, "overlap during the catch-up cannot extend the drain indefinitely");
  assert.equal(maxActive, 1);
  await monitor.stop();
});
