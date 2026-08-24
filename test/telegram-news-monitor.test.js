import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { isRelevantAlert } from "../src/alerts.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";
import {
  TELEGRAM_NEWS_CHAT_ID,
  TELEGRAM_NEWS_PREVIEW_URL,
  atomicWriteTelegramNewsState,
  classifyTelegramNews,
  createTelegramNewsMonitor,
  parseTelegramPublicPreview,
} from "../src/telegram-news-monitor.js";

const CHANNEL_TITLE = "Holly 💎 好资源分享";

const encodeView = (messageId, overrides = {}) => Buffer.from(JSON.stringify({
  c: -2540748528,
  p: messageId,
  t: 1_787_549_367,
  h: `proof-${messageId}`,
  ...overrides,
})).toString("base64url");

const messageCard = ({
  id,
  text,
  textHtml = null,
  datetime = "2026-08-24T06:00:00+00:00",
  post = `maxguruai/${id}`,
  view = encodeView(id),
}) => `<div class="tgme_widget_message_wrap js-widget_message_wrap">
  <div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="${post}" data-view="${view}">
    <div class="tgme_widget_message_text js-message_text" dir="auto">${textHtml ?? text}</div>
    <a class="tgme_widget_message_date" href="https://t.me/maxguruai/${id}"><time datetime="${datetime}">14:00</time></a>
  </div>
</div>`;

const preview = (...cards) => `<!doctype html><html><head><meta property="og:title" content="${CHANNEL_TITLE}"></head><body>
  <div class="tgme_channel_info_header_title"><span>${CHANNEL_TITLE}</span></div>
  ${cards.join("\n")}
</body></html>`;

const GOVERNANCE_TEXT = `<b>Optimism 通过 OP 生态基金重新分配提案 – </b><a href="https://coindesk.com/web3/story?utm_source=tg">链接</a><br/><br/>
治理投票已经通过，将部分 OP 代币从用户空投计划重新分配给战略生态基金；投票权集中度同时引发 DAO 治理风险讨论。`;

const SECURITY_TEXT = `<b>DeFi 协议修复跨链桥关键漏洞</b><br/><br/>
项目方确认攻击者曾利用验证漏洞盗取资产，团队现已暂停跨链桥并发布修复版本，链上调查仍在继续。`;

const AI_PRODUCT_TEXT = `<b>Binance 发布 Agent OS 开发产品</b><br/><br/>
新功能允许 AI 智能体通过 API 集成行情、支付、链上数据与交易能力，官方开发文档已经同步上线。`;

const POLITICAL_TEXT = `<b>美国总统宣布新的加拿大关税措施</b><br/><br/>
总统表示国会将讨论新的贸易政策，这场选举相关争议预计会继续影响两国政治关系。`;

const CRYPTO_POLICY_TEXT = `<b>美国国会通过稳定币监管提案</b><br/><br/>
新法案明确加密货币发行人的储备与披露要求，并将改变稳定币和 Bitcoin 相关服务的合规路径。`;

const LIVE_HTML_SHAPE = `<div class="tgme_channel_info_header_title"><span dir="auto">Holly <i class="emoji"><b>💎</b></i> 好资源分享</span></div>
<div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message text_not_supported_wrap js-widget_message" data-post="maxguruai/2953" data-view="eyJjIjotMjU0MDc0ODUyOCwicCI6Mjk1MywidCI6MTc4NzU0OTM3NiwiaCI6ImI4MTQ4ZDYwNDkzNDM5OGU5YSJ9">
<div class="tgme_widget_message_text js-message_text" dir="auto"><b>Optimism 将 OP 代币重新分配给生态系统基金 – </b><a href="https://www.coindesk.com/web3/2026/08/20/optimism-funded-team-s-deciding-vote-shifts-usd49-million-in-op-tokens-away-from-users">**链接**</a><br/><br/>一场备受争议的 Optimism 治理投票获得通过，将约 5.469 亿个 OP 代币从计划中的用户空投重新分配给基金会管理的战略生态系统基金。</div>
<a class="tgme_widget_message_date" href="https://t.me/maxguruai/2953"><time datetime="2026-08-23T13:15:18+00:00">13:15</time></a></div></div>`;

const response = (body, { status = 200, headers = {}, url = TELEGRAM_NEWS_PREVIEW_URL } = {}) => {
  const normalized = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]));
  return {
    status,
    ok: status >= 200 && status < 300,
    url,
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) ?? null },
    text: async () => body,
  };
};

const temporaryStateFile = async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "telegram-news-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, "telegram-news-state.json");
};

test("public preview parser proves exact numeric chat and exact handle/message pair", () => {
  const html = preview(
    messageCard({ id: 2953, textHtml: GOVERNANCE_TEXT }),
    messageCard({ id: 2954, textHtml: GOVERNANCE_TEXT, view: encodeView(2954, { c: -1 }) }),
    messageCard({ id: 2955, textHtml: GOVERNANCE_TEXT, view: encodeView(9999) }),
    messageCard({ id: 2956, textHtml: GOVERNANCE_TEXT, post: "MaxGuruAI/2956" }),
    messageCard({ id: 2957, textHtml: GOVERNANCE_TEXT, post: "maxguruai/02957" }),
    messageCard({ id: 2958, textHtml: GOVERNANCE_TEXT, datetime: "not-a-date" }),
    messageCard({ id: 2959, text: "" }),
  );

  const records = parseTelegramPublicPreview(html);
  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    messageId: 2953,
    messageUrl: "https://t.me/maxguruai/2953",
    sourceOccurredAt: "2026-08-24T06:00:00.000Z",
    text: "Optimism 通过 OP 生态基金重新分配提案 – 链接\n治理投票已经通过，将部分 OP 代币从用户空投计划重新分配给战略生态基金；投票权集中度同时引发 DAO 治理风险讨论。",
    externalUrls: ["https://coindesk.com/web3/story"],
    contentDigest: records[0].contentDigest,
    channelTitle: CHANNEL_TITLE,
  });
  assert.match(records[0].contentDigest, /^[a-f0-9]{64}$/);
});

test("captured Telegram public-preview HTML shape decodes the live data-view identity", () => {
  const [record] = parseTelegramPublicPreview(LIVE_HTML_SHAPE);
  assert.equal(record.messageId, 2953);
  assert.equal(record.messageUrl, "https://t.me/maxguruai/2953");
  assert.equal(record.sourceOccurredAt, "2026-08-23T13:15:18.000Z");
  assert.equal(record.channelTitle, CHANNEL_TITLE);
  assert.equal(classifyTelegramNews(record).accepted, true);
});

test("news classifier accepts substantive verticals and rejects politics, marketing, calls, failed translation, and thin content", () => {
  const classify = (text, externalUrls = []) => classifyTelegramNews({ text, externalUrls });
  assert.equal(classify(parseTelegramPublicPreview(preview(messageCard({ id: 1, textHtml: GOVERNANCE_TEXT })))[0].text).news.category, "governance");
  assert.equal(classify(parseTelegramPublicPreview(preview(messageCard({ id: 2, textHtml: SECURITY_TEXT })))[0].text).news.category, "security");
  assert.equal(classify(parseTelegramPublicPreview(preview(messageCard({ id: 3, textHtml: AI_PRODUCT_TEXT })))[0].text).news.category, "ai");
  assert.equal(classify(parseTelegramPublicPreview(preview(messageCard({ id: 4, textHtml: POLITICAL_TEXT })))[0].text).accepted, false);
  assert.equal(classify(parseTelegramPublicPreview(preview(messageCard({ id: 5, textHtml: CRYPTO_POLICY_TEXT })))[0].text).accepted, true, "substantive crypto policy is not discarded as generic politics");
  assert.equal(classify("交易所发布限时优惠活动，关注并转发即可参加抽奖，点击领取注册链接和邀请码，更多产品信息将在频道公布。\n所有参与用户都会获得奖励。 ").accepted, false);
  assert.equal(classify("新代币已经上线交易，立即买入这只 100x gem，目标价十倍，止损位置稍后公布。\n这是今天最强喊单信号，请不要错过。 ").accepted, false);
  assert.equal(classify("AI 产品更新：Translation failed，等待翻译。新功能已经发布但暂无翻译内容，后续将补充完整产品说明。 ").accepted, false);
  assert.equal(classify("您好，您提供的链接我无法访问，因此看不到需要重写的具体内容。请直接粘贴原文，我会保持原有格式并重新翻译全部内容。 ").accepted, false);
  assert.equal(classify("以太坊更新。 ").reason, "insufficient_content");
});

test("unsafe external links are dropped while a mixed message remains deliverable", () => {
  const classification = classifyTelegramNews({
    text: "DeFi 协议发布安全升级\n团队修复了跨链桥漏洞并部署新的链上验证合约，官方确认主网服务已经恢复，用户资产未受进一步影响。",
    externalUrls: [
      "https://security.example.com/report?utm_source=tg",
      "http://security.example.com/plain",
      "https://user:pass@security.example.com/private",
      "https://127.0.0.1/admin",
      "https://localhost/internal",
      "https://example.internal/secret",
      "https://security.example.com:8443/report",
    ],
  });
  assert.equal(classification.accepted, true);
  assert.deepEqual(classification.news.externalUrls, ["https://security.example.com/report"]);
});

test("first non-empty feed is a silent baseline; new messages and qualified edits emit exact revisions", async (t) => {
  const stateFile = await temporaryStateFile(t);
  let current = Date.parse("2026-08-24T06:00:02Z");
  const requests = [];
  const pages = [
    preview(messageCard({ id: 2953, textHtml: GOVERNANCE_TEXT, datetime: "2026-08-24T06:00:00Z" })),
    preview(
      messageCard({ id: 2953, textHtml: GOVERNANCE_TEXT, datetime: "2026-08-24T06:00:00Z" }),
      messageCard({ id: 2954, textHtml: SECURITY_TEXT, datetime: "2026-08-24T06:00:03Z" }),
    ),
    preview(
      messageCard({ id: 2953, textHtml: GOVERNANCE_TEXT, datetime: "2026-08-24T06:00:00Z" }),
      messageCard({ id: 2954, textHtml: `${SECURITY_TEXT}<br/>官方随后补充，受影响的验证模块已经完成第二轮审计。`, datetime: "2026-08-24T06:00:03Z" }),
    ),
  ];
  const events = [];
  const monitor = createTelegramNewsMonitor({ dataDir: path.dirname(stateFile), telegramNewsPollIntervalMs: 4_000 }, {
    stateFile,
    autoStart: false,
    now: () => current,
    fetchImpl: async (_url, options) => {
      requests.push(options);
      return response(pages.shift(), { headers: { etag: `"revision-${requests.length}"`, "last-modified": "Mon, 24 Aug 2026 06:00:00 GMT", "content-type": "text/html; charset=utf-8" } });
    },
    sendAlertsImpl: async (_config, event) => { events.push(event); },
  });

  assert.equal((await monitor.check()).ok, true);
  assert.equal(events.length, 0, "baseline never replays the current preview window");
  current += 4_000;
  assert.equal((await monitor.check()).ok, true);
  assert.equal(events.length, 1);
  current += 4_000;
  assert.equal((await monitor.check()).ok, true);
  assert.equal(events.length, 2, "an edited qualifying message becomes a new digest revision");

  const [created, edited] = events;
  assert.equal(created.type, "telegram_news_update");
  assert.equal(created.strong, false);
  assert.equal(created.source.id, "telegram_public_channel");
  assert.equal(created.source.trust, "public_telegram_observed");
  assert.equal(created.sourceTrust, "public_telegram_observed");
  assert.deepEqual(created.channel, {
    chatId: TELEGRAM_NEWS_CHAT_ID,
    username: "maxguruai",
    title: CHANNEL_TITLE,
    visibility: "public",
  });
  assert.equal(created.chatId, TELEGRAM_NEWS_CHAT_ID);
  assert.equal(created.username, "maxguruai");
  assert.equal(created.messageId, 2954);
  assert.equal(created.messageUrl, "https://t.me/maxguruai/2954");
  assert.equal(created.sourceOccurredAt, "2026-08-24T06:00:03.000Z");
  assert.equal(created.news.confidence, "observed");
  assert.equal(created.news.category, "security");
  assert.ok(created.news.headline.length <= 180);
  assert.ok(created.news.summary.length <= 320);
  assert.match(created.contentDigest, /^[a-f0-9]{64}$/);
  assert.equal(created.eventKey, `telegram-news:${TELEGRAM_NEWS_CHAT_ID}:2954:${created.contentDigest.slice(0, 16)}`);
  assert.notEqual(created.contentDigest, edited.contentDigest);
  assert.notEqual(created.eventKey, edited.eventKey);
  assert.match(requests[1].headers["if-none-match"], /revision-1/);

  const persisted = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(persisted.messages["2954"].digest, edited.contentDigest);
  assert.ok(persisted.messages["2954"].summary.length <= 320);
  assert.equal("text" in persisted.messages["2954"], false);
  assert.equal("rawHtml" in persisted, false);
});

test("non-news and insufficient messages are remembered without entering sendAlerts", async (t) => {
  const stateFile = await temporaryStateFile(t);
  let current = Date.parse("2026-08-24T06:10:00Z");
  const pages = [
    preview(messageCard({ id: 10, textHtml: GOVERNANCE_TEXT })),
    preview(
      messageCard({ id: 10, textHtml: GOVERNANCE_TEXT }),
      messageCard({ id: 11, textHtml: POLITICAL_TEXT }),
      messageCard({ id: 12, text: "比特币更新。" }),
      messageCard({ id: 13, text: "AI 产品已经发布，但 Translation unavailable，等待翻译后补充完整说明和功能细节。" }),
    ),
  ];
  let calls = 0;
  const monitor = createTelegramNewsMonitor({ dataDir: path.dirname(stateFile) }, {
    stateFile,
    autoStart: false,
    now: () => current,
    fetchImpl: async () => response(pages.shift()),
    sendAlertsImpl: async () => { calls += 1; },
  });
  await monitor.check();
  current += 4_000;
  await monitor.check();
  assert.equal(calls, 0);
  assert.equal(Object.keys(monitor.state().messages).length, 4);
  assert.equal(monitor.state().messages["11"].accepted, false);
});

test("a real producer event passes the opt-in source-control and alert relevance gates", async (t) => {
  const stateFile = await temporaryStateFile(t);
  const occurredAt = new Date(Date.now() - 5_000).toISOString();
  let current = Date.now();
  const pages = [
    preview(messageCard({ id: 40, textHtml: GOVERNANCE_TEXT, datetime: occurredAt })),
    preview(
      messageCard({ id: 40, textHtml: GOVERNANCE_TEXT, datetime: occurredAt }),
      messageCard({ id: 41, textHtml: SECURITY_TEXT, datetime: occurredAt }),
    ),
  ];
  let captured = null;
  const config = {
    dataDir: path.dirname(stateFile),
    monitorScope: "focus3",
    telegramNewsMonitorEnabled: true,
    telegramNewsPollIntervalMs: 3_000,
  };
  const monitor = createTelegramNewsMonitor(config, {
    stateFile,
    autoStart: false,
    now: () => current,
    fetchImpl: async () => response(pages.shift()),
    sendAlertsImpl: async (_config, event) => { captured = event; },
  });
  await monitor.check();
  current += 3_000;
  await monitor.check();
  assert.ok(captured);
  assert.equal(isMonitoringSourceEnabled(config, captured), true);
  assert.equal(isRelevantAlert(captured), true);
});

test("the same external story is kept to its first observed message even if a repost is edited", async (t) => {
  const stateFile = await temporaryStateFile(t);
  let current = Date.now();
  const repost = `<b>Optimism 通过 OP 生态基金重新分配提案 – </b><a href="https://coindesk.com/web3/story">链接</a><br/><br/>治理投票已经通过，将部分 OP 代币从用户空投计划重新分配给战略生态基金，DAO 投票集中度引发风险讨论。`;
  const pages = [
    preview(messageCard({ id: 50, textHtml: GOVERNANCE_TEXT, datetime: new Date(current - 1_000).toISOString() })),
    preview(
      messageCard({ id: 50, textHtml: GOVERNANCE_TEXT, datetime: new Date(current - 1_000).toISOString() }),
      messageCard({ id: 51, textHtml: repost, datetime: new Date(current).toISOString() }),
    ),
    preview(
      messageCard({ id: 50, textHtml: GOVERNANCE_TEXT, datetime: new Date(current - 1_000).toISOString() }),
      messageCard({ id: 51, textHtml: `${repost}<br/>频道稍后补充了相同投票结果。`, datetime: new Date(current).toISOString() }),
    ),
  ];
  let calls = 0;
  const monitor = createTelegramNewsMonitor({ dataDir: path.dirname(stateFile), telegramNewsPollIntervalMs: 3_000 }, {
    stateFile,
    autoStart: false,
    now: () => current,
    fetchImpl: async () => response(pages.shift()),
    sendAlertsImpl: async () => { calls += 1; },
  });
  await monitor.check();
  current += 3_000;
  await monitor.check();
  current += 3_000;
  await monitor.check();
  assert.equal(calls, 0);
  const story = Object.values(monitor.state().stories)[0];
  assert.equal(story.messageId, 50);
});

test("ETag and Last-Modified are conditional and a 304 advances health without parsing a body", async (t) => {
  const stateFile = await temporaryStateFile(t);
  let current = Date.parse("2026-08-24T07:00:00Z");
  const requests = [];
  let call = 0;
  const monitor = createTelegramNewsMonitor({ dataDir: path.dirname(stateFile) }, {
    stateFile,
    autoStart: false,
    now: () => current,
    fetchImpl: async (_url, options) => {
      requests.push(options);
      call += 1;
      return call === 1
        ? response(preview(messageCard({ id: 20, textHtml: GOVERNANCE_TEXT })), { headers: { etag: '"abc"', "last-modified": "Mon, 24 Aug 2026 07:00:00 GMT" } })
        : response("this must not be parsed", { status: 304 });
    },
    sendAlertsImpl: async () => assert.fail("baseline/304 must not emit"),
  });
  await monitor.check();
  current += 4_000;
  const result = await monitor.check();
  assert.equal(result.notModified, true);
  assert.equal(requests[1].headers["if-none-match"], '"abc"');
  assert.equal(requests[1].headers["if-modified-since"], "Mon, 24 Aug 2026 07:00:00 GMT");
  assert.equal(monitor.state().health.lastResponseStatus, 304);
});

test("403 and 429 Retry-After circuits survive restart and prevent premature requests", async (t) => {
  const stateFile = await temporaryStateFile(t);
  let current = Date.parse("2026-08-24T08:00:00Z");
  let requests = 0;
  let monitor = createTelegramNewsMonitor({ dataDir: path.dirname(stateFile) }, {
    stateFile,
    autoStart: false,
    now: () => current,
    fetchImpl: async () => {
      requests += 1;
      return response("limited", { status: 429, headers: { "retry-after": "120" } });
    },
  });
  assert.equal((await monitor.check()).reason, "http_429");
  assert.equal(monitor.state().health.nextAttemptAt, "2026-08-24T08:02:00.000Z");

  current += 30_000;
  monitor = createTelegramNewsMonitor({ dataDir: path.dirname(stateFile) }, {
    stateFile,
    autoStart: false,
    now: () => current,
    fetchImpl: async () => { requests += 1; return response("unexpected"); },
  });
  assert.equal((await monitor.check()).reason, "circuit_open");
  assert.equal(requests, 1);

  current = Date.parse("2026-08-24T08:02:01Z");
  const retryDate = "Mon, 24 Aug 2026 08:05:00 GMT";
  monitor = createTelegramNewsMonitor({ dataDir: path.dirname(stateFile) }, {
    stateFile,
    autoStart: false,
    now: () => current,
    fetchImpl: async () => { requests += 1; return response("blocked", { status: 403, headers: { "retry-after": retryDate } }); },
  });
  assert.equal((await monitor.check()).reason, "http_403");
  assert.equal(monitor.state().health.nextAttemptAt, "2026-08-24T08:05:00.000Z");

  current = Date.parse("2026-08-24T08:04:59Z");
  monitor = createTelegramNewsMonitor({ dataDir: path.dirname(stateFile) }, {
    stateFile,
    autoStart: false,
    now: () => current,
    fetchImpl: async () => { requests += 1; return response("unexpected"); },
  });
  assert.equal((await monitor.check()).reason, "circuit_open");
  assert.equal(requests, 2);
});

test("empty/WAF HTML and failed alert enqueue do not advance validators or message revisions", async (t) => {
  const stateFile = await temporaryStateFile(t);
  let current = Date.parse("2026-08-24T09:00:00Z");
  let phase = 0;
  const monitor = createTelegramNewsMonitor({ dataDir: path.dirname(stateFile), telegramNewsPollIntervalMs: 3_000 }, {
    stateFile,
    autoStart: false,
    now: () => current,
    fetchImpl: async () => {
      phase += 1;
      if (phase === 1) return response("<html><title>Just a moment</title></html>", { headers: { etag: '"waf"' } });
      if (phase === 2) return response(preview(messageCard({ id: 30, textHtml: GOVERNANCE_TEXT })), { headers: { etag: '"baseline"' } });
      return response(preview(
        messageCard({ id: 30, textHtml: GOVERNANCE_TEXT }),
        messageCard({ id: 31, textHtml: SECURITY_TEXT }),
      ), { headers: { etag: '"new"' } });
    },
    sendAlertsImpl: async () => { throw new Error("durable outbox unavailable"); },
    logger: { error() {} },
  });

  assert.equal((await monitor.check()).ok, false);
  assert.equal(monitor.state().initializedAt, null);
  assert.equal(monitor.state().http.etag, null);
  current += 3_000;
  assert.equal((await monitor.check()).ok, true);
  current += 3_000;
  assert.equal((await monitor.check()).ok, false);
  assert.equal(monitor.state().messages["31"], undefined);
  assert.equal(monitor.state().http.etag, '"baseline"');
});

test("state writes are atomic and leave no raw temporary file", async (t) => {
  const stateFile = await temporaryStateFile(t);
  await atomicWriteTelegramNewsState(stateFile, { version: 1, messages: { 1: { digest: "a".repeat(64) } } });
  assert.deepEqual(JSON.parse(await fs.readFile(stateFile, "utf8")), { version: 1, messages: { 1: { digest: "a".repeat(64) } } });
  assert.deepEqual((await fs.readdir(path.dirname(stateFile))).filter((name) => name.endsWith(".tmp")), []);
});

test("Telegram news stop is idempotent and drains alert delivery before persisting the message", async (t) => {
  const stateFile = await temporaryStateFile(t);
  let current = Date.parse("2026-08-24T10:00:00Z");
  let latest = preview(messageCard({ id: 30, textHtml: GOVERNANCE_TEXT }));
  let requests = 0;
  let releaseAlert;
  const alertBlocked = new Promise((resolve) => { releaseAlert = resolve; });
  let markAlertStarted;
  const alertStarted = new Promise((resolve) => { markAlertStarted = resolve; });
  const monitor = createTelegramNewsMonitor({
    dataDir: path.dirname(stateFile),
    telegramNewsPollIntervalMs: 3_000,
  }, {
    stateFile,
    autoStart: false,
    now: () => current,
    fetchImpl: async () => {
      requests += 1;
      return response(latest);
    },
    sendAlertsImpl: async () => {
      markAlertStarted();
      await alertBlocked;
    },
  });

  await monitor.check();
  current += 3_000;
  latest = preview(
    messageCard({ id: 30, textHtml: GOVERNANCE_TEXT }),
    messageCard({ id: 31, textHtml: SECURITY_TEXT }),
  );
  const checking = monitor.check();
  await alertStarted;
  const stopping = monitor.stop();
  assert.equal(monitor.stop(), stopping, "repeated stops share one drain boundary");
  assert.equal(monitor.check(), checking, "post-stop calls cannot poll Telegram again");
  let stopped = false;
  void stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, false);

  releaseAlert();
  await stopping;
  assert.equal(requests, 2);
  const durable = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(durable.messages["31"].accepted, true);
});
