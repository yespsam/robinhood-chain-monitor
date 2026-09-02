import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BINANCE_ANNOUNCEMENT_DETAIL_BASE_URLS,
  BINANCE_ANNOUNCEMENT_STREAM_TOPIC,
  BINANCE_ANNOUNCEMENT_URLS,
  BINANCE_AGENT_OS_PAGE_URL,
  BINANCE_AGENT_OS_READER_URL,
  BINANCE_DEVELOPER_DOC_URLS,
  BINANCE_LAUNCHPOOL_URLS,
  BINANCE_MEME_RUSH_URL,
  BINANCE_SQUARE_FEED_URL,
  buildBinanceAnnouncementStreamUrl,
  classifyBinanceAnnouncement,
  classifyBinanceOfficialText,
  createBinanceMonitor,
  extractBinanceAnnouncementDetails,
  extractBinanceAnnouncementFacts,
  extractBinanceDeveloperSignalSnapshot,
  extractBinanceDeveloperSignals,
  extractLaunchpoolCapabilities,
  extractMemeRushCapabilities,
  parseBinanceAnnouncementDetail,
  parseBinanceAnnouncementStreamMessage,
  parseBinanceAnnouncements,
  parseBinanceSquarePosts,
} from "../src/binance-monitor.js";
import { deriveTradingPriority } from "../src/trading-priority.js";

const article = (code, title, releaseDate = Date.parse("2026-08-02T00:00:00Z")) => ({ id: Number.parseInt(code.slice(0, 6), 16), code, title, releaseDate, type: 1 });

function announcements(items = []) {
  return {
    code: "000000",
    data: { catalogs: [{ catalogId: 49, catalogName: "Latest Binance News", articles: items }] },
  };
}

function announcementDetail(code, title, overrides = {}) {
  return {
    code: "000000",
    data: {
      code,
      title,
      publishDate: Date.parse("2026-08-02T00:00:00Z"),
      lastUpdateTime: 0,
      version: "1",
      seoKeywords: "",
      seoDesc: "",
      body: "{}",
      ...overrides,
    },
  };
}

function announcementTableRow(cells) {
  return {
    node: "element",
    tag: "tr",
    child: cells.map((value) => ({
      node: "element",
      tag: "td",
      child: [{ node: "element", tag: "p", child: [{ node: "text", text: value }] }],
    })),
  };
}

function detailRequestCode(url) {
  const value = String(url);
  const base = BINANCE_ANNOUNCEMENT_DETAIL_BASE_URLS.find((candidate) => value.startsWith(candidate));
  return base ? decodeURIComponent(value.slice(base.length)) : null;
}

function launchpool(items = []) {
  return {
    code: "000000",
    data: {
      tracking: { total: String(items.length), list: items },
      completed: { total: "0", list: [] },
    },
  };
}

function memeRush(items = []) {
  return { code: "000000", data: items };
}

function ok(payload) {
  return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
}

function textResponse(text, { status = 200, headers = {}, url = null } = {}) {
  const normalized = new Map(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value)]));
  return {
    ok: status >= 200 && status < 300,
    status,
    ...(url ? { url } : {}),
    headers: { get: (name) => normalized.get(String(name).toLowerCase()) || null },
    text: async () => text,
  };
}

function verifiedAgentOsReaderBody(extra = "") {
  return `Title: MCP Server for Crypto AI Agents
URL Source: http://www.binance.com/en/agent-os
Markdown Content:
# BINANCE AGENT OS
## What is Binance Agent OS?
- Binance MCP Server
- Binance Agentic Wallet
- Agent REST API
- Trade
- Pay & settle
- Read the Market
- Track Your Portfolio
${extra}`;
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`condition was not met within ${timeoutMs}ms`);
}

function streamTestFetch(url) {
  if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return Promise.resolve(ok(announcements([])));
  if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return Promise.resolve(ok(launchpool([])));
  if (url === BINANCE_MEME_RUSH_URL) return Promise.resolve(ok(memeRush([item()])));
  throw new Error(`unexpected URL ${url}`);
}

function item({ protocol = 2002, version = "6", contract = "0x1111111111111111111111111111111111111111", chainId = "56", extra = {} } = {}) {
  return { chainId, protocol, tokenVersion: version, contractAddress: contract, migrateStatus: 0, launchTaxEnable: false, ...extra };
}

async function fixture(t) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "binance-monitor-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  return dataDir;
}

function instrumentedDurableFs({ onWrite = null, renameImpl = null, rmImpl = null, onSync = null } = {}) {
  return {
    readFile: (...args) => fs.readFile(...args),
    stat: (...args) => fs.stat(...args),
    chmod: (...args) => fs.chmod(...args),
    mkdir: (...args) => fs.mkdir(...args),
    rename: (...args) => renameImpl ? renameImpl(...args) : fs.rename(...args),
    rm: (...args) => rmImpl ? rmImpl(...args) : fs.rm(...args),
    open: async (target, flags, mode) => {
      const handle = await fs.open(target, flags, mode);
      return new Proxy(handle, {
        get(handleTarget, property) {
          if (property === "writeFile") {
            return async (value, ...args) => {
              onWrite?.({ file: String(target), value, mode });
              return handleTarget.writeFile(value, ...args);
            };
          }
          if (property === "sync") {
            return async () => {
              await onSync?.({ target: String(target), flags });
              return handleTarget.sync();
            };
          }
          const value = handleTarget[property];
          return typeof value === "function" ? value.bind(handleTarget) : value;
        },
      });
    },
  };
}

function schedulerTestState(checkedAt, targets, cursor = 0) {
  const healthy = (value = checkedAt) => ({ status: "healthy", checkedAt: value, lastSuccessAt: value, consecutiveFailures: 0 });
  return {
    version: 2,
    announcements: { initializedAt: checkedAt, detailCheckedAt: checkedAt, articles: {} },
    square: { posts: {} },
    developerDocs: { pages: {} },
    scheduler: {
      memeRushCursor: cursor,
      announcementDetailCheckedAt: checkedAt,
      checkpointRevision: 0,
      checkpointUpdatedAt: checkedAt,
    },
    memeRush: {
      initializedAt: checkedAt,
      baselinedTargets: targets.map(({ chainId, rankType }) => `${chainId}:${rankType}`),
      protocols: {}, versions: {}, schemaKeys: [], versionCandidates: {}, tokenIndex: {}, cursor,
    },
    launchpool: { initializedAt: checkedAt, buckets: ["completed", "tracking"], assets: [], statuses: [], fields: [] },
    _health: {
      announcements: healthy(), exchangeAnnouncements: healthy(), walletAnnouncements: healthy(),
      memeRush: healthy(), launchpool: healthy(),
    },
  };
}

function monitorConfig(dataDir) {
  return {
    dataDir,
    binanceAnnouncementPollIntervalMs: 0,
    binanceAnnouncementDetailPollIntervalMs: 0,
    binanceMemeRushPollIntervalMs: 0,
    binanceLaunchpoolPollIntervalMs: 0,
  };
}

test("keeps Binance product features plus priority listings while rejecting uncatalogued campaigns", () => {
  const relevant = [
    "Binance Wallet Launches Web3 API, Enabling Developers to Build on Binance Web3 Infrastructure",
    "Introducing the BuildKey TGE Model on Binance Wallet in Collaboration with Aspecta",
    "Introducing the Exclusive Bonding Curve-Based Token Generation Event (TGE) on Binance Wallet, in Collaboration With Four.Meme",
    "Binance Introduces Revamped Launchpool and BNB Pages for Easier Airdrop Tracking",
    "Binance Launches Pre-Market: Exclusive Offering Before Official Spot Listing",
    "Introducing Opinion (OPN) on Binance Launchpool! Farm OPN by Locking BNB and USDC",
    "GAIB (GAIB) Will Be Available on Binance Alpha and Binance Futures",
    "Binance Futures Will Launch EDGEUSDT Perpetual Contract Pre-Market Trading",
    "Binance Futures Will Launch Multiple USDⓈ-Margined TradFi Perpetual Contracts",
    "牛来 was added to Binance Alpha. You can trade 牛来 using market and limit orders.",
  ];
  const ignored = [
    "Participate in the Exclusive Mitosis (MITO) Booster Program and Token Generation Event on Binance Wallet",
    "Binance Wallet Alpha Deposit Campaign: Deposit GRVT and Share $20K Worth of Rewards",
    "Binance Will Add 10 bStocks Tokenized Securities as Collateral Assets",
    "Subscribe to Binance Wallet DeFi to Earn Up to 20% APR",
    "Join the Meme Rush Campaign and Win Token Rewards",
    "Binance Wallet Meme Rush Adds Three New Tokens",
  ];
  for (const title of relevant) assert.equal(classifyBinanceOfficialText(title).relevant, true, title);
  for (const title of ignored) assert.equal(classifyBinanceOfficialText(title).relevant, false, title);
  assert.equal(classifyBinanceOfficialText(relevant[2]).strong, true);
  const newMemeRushSource = classifyBinanceOfficialText("Binance Wallet Meme Rush adds Pools.fun as a new launchpad protocol");
  assert.equal(newMemeRushSource.relevant, true);
  assert.equal(newMemeRushSource.strong, true);
  assert.equal(classifyBinanceOfficialText("Binance Wallet launches limit orders across all Alpha assets").relevant, true);
});

test("classifies listings, contracts, activities, and ordinary exchange or Wallet announcements", () => {
  const spot = classifyBinanceAnnouncement({
    title: "Binance Will List Example (EXM) with Seed Tag Applied",
    catalogId: 48,
  });
  assert.deepEqual({ relevant: spot.relevant, scope: spot.scope, strong: spot.strong, category: spot.category }, {
    relevant: true,
    scope: "exchange",
    strong: true,
    category: "现货上币",
  });

  const delisting = classifyBinanceAnnouncement({
    title: "Binance Will Delist OLD, GONE on 2026-08-17",
    catalogId: 161,
  });
  assert.equal(delisting.relevant, true);
  assert.equal(delisting.strong, true);
  assert.deepEqual(delisting.labels, ["整币下架"]);

  const ordinary = [
    { title: "Binance Futures Will Launch EXMUSDT USDⓈ-Margined Perpetual Contract", catalogId: 48 },
    { title: "Notice on New Trading Pairs & Trading Bots Services on Binance Spot", catalogId: 48 },
    { title: "Notice of Removal of Spot Trading Pairs - 2026-08-07", catalogId: 161 },
  ];
  for (const item of ordinary) assert.equal(classifyBinanceAnnouncement(item).relevant, true, item.title);
  assert.deepEqual(classifyBinanceAnnouncement(ordinary[0]).labels, ["新合约上线"]);
  assert.equal(classifyBinanceAnnouncement({
    title: "Binance Exchange Adds 10 bStocks Trading Pairs on Binance Spot",
    catalogId: 48,
  }).relevant, false, "tokenized-equity announcements remain outside the Web3 scope");

  const tickSize = classifyBinanceAnnouncement({
    title: "Updates on Tick Size for Multiple USDⓈ-M Perpetual Futures Contracts",
    catalogId: 49,
  });
  assert.equal(tickSize.relevant, true);
  assert.equal(tickSize.strong, false);
  assert.deepEqual(tickSize.labels, ["交易规则调整"]);

  const api = classifyBinanceAnnouncement({ title: "Notice on Binance Spot API Update", catalogId: 51 });
  assert.equal(api.relevant, true);
  assert.equal(api.scope, "exchange");
  assert.equal(api.strong, false);

  const walletChain = classifyBinanceAnnouncement({
    title: "Binance Wallet Introduces Support for a New Chain and Web3 API",
    catalogId: 49,
  });
  assert.equal(walletChain.relevant, true);
  assert.equal(walletChain.scope, "wallet");
  assert.equal(walletChain.strong, true);

  const walletUi = classifyBinanceAnnouncement({
    title: "Binance Wallet Updates Its Swap Interface",
    catalogId: 49,
  });
  assert.equal(walletUi.relevant, true);
  assert.equal(walletUi.strong, false);

  for (const title of [
    "Binance Wallet Updates Portfolio Interface for Existing Launchpad Tokens",
    "Binance Wallet Adds Search Filters for Bonding Curve Tokens",
    "Binance Wallet Updates Help Center Documentation for BuildKey",
    "Binance Wallet Updates Search for Prime Sale Projects",
  ]) {
    const presentation = classifyBinanceAnnouncement({ title, catalogId: 49 });
    assert.equal(presentation.relevant, true, title);
    assert.equal(presentation.strong, false, title);
    assert.deepEqual(presentation.labels, ["Wallet 功能更新"], title);
  }

  const walletSecurity = classifyBinanceAnnouncement({
    title: "Binance Wallet Enhances Security Center",
    catalogId: 49,
  });
  assert.equal(walletSecurity.relevant, true);
  assert.equal(walletSecurity.strong, true);
  assert.deepEqual(walletSecurity.labels, ["Wallet 安全更新"]);

  const exchangeWalletMaintenance = classifyBinanceAnnouncement({
    title: "Wallet Maintenance for USDC Withdrawals on BNB Smart Chain",
    catalogId: 157,
  });
  assert.equal(exchangeWalletMaintenance.relevant, true);
  assert.equal(exchangeWalletMaintenance.scope, "exchange");
  assert.equal(exchangeWalletMaintenance.strong, false);

  const newlyIncluded = [
    { title: "Binance Alpha Adds Example (EXM)", catalogId: 49 },
    { title: "Binance Wallet Launches an Exclusive Airdrop for EXM", catalogId: 128 },
    { title: "Binance Launches Zero-Fee Spot Trading Promotion", catalogId: 49 },
  ];
  for (const item of newlyIncluded) assert.equal(classifyBinanceAnnouncement(item).relevant, true, item.title);
  assert.deepEqual(classifyBinanceAnnouncement(newlyIncluded[0]).labels, ["Alpha 上新"]);
  assert.equal(classifyBinanceAnnouncement(newlyIncluded[1]).category, "活动公告");
});

test("announcement body navigation cannot hide a valid title or turn Square programming into a product launch", () => {
  const detailWithFooterNoise = {
    title: "Updates on Tick Size for Spot Trading Pairs (2026-08-20)",
    seoKeywords: "Binance Announcements, Binance News",
    seoDesc: "Binance adjusts tick sizes for 29 spot trading pairs.",
    body: JSON.stringify({
      text: "Tick sizes will change at 05:00 UTC. Footer: refer to Stocks Trading and tokenized securities resources.",
    }),
  };
  const signal = classifyBinanceAnnouncement({
    title: detailWithFooterNoise.title,
    catalogId: 49,
  }, detailWithFooterNoise);
  assert.equal(signal.relevant, true);
  assert.deepEqual(signal.labels, ["交易规则调整"]);

  const squareProgramming = classifyBinanceOfficialText(
    "Watch Trading Live Daily. Interested to stream? Sign up for our Binance Square Live Trading Incubation Group and join the group.",
  );
  assert.equal(squareProgramming.relevant, false);

  const governanceTitle = "Binance Square Community Governance Announcement (Aug 24 – Aug 30)";
  const governance = classifyBinanceAnnouncement({ title: governanceTitle }, {
    title: governanceTitle,
    body: JSON.stringify({
      node: "root",
      child: [{
        node: "element",
        tag: "p",
        child: [{
          node: "text",
          text: "Based on user reports and platform review conducted last week, creators violated the Binance Square Community Guidelines. Enforcement Actions included suspending permission to post and comment.",
        }],
      }],
    }),
  });
  assert.equal(governance.relevant, false);

  const separatedSignals = classifyBinanceOfficialText(
    "Binance Square discusses trade sharing with creators. New community badges are now live.",
  );
  assert.equal(separatedSignals.relevant, false, "feature object and launch action must occur in the same sentence");
  assert.equal(classifyBinanceOfficialText("Binance Square Weekly Report: Copy Trading is now live").relevant, false);
});

test("classifies Binance Square KOL sharing, Futures product features, and new contracts", () => {
  const square = classifyBinanceOfficialText("Binance Square rolls out Faster Trade Sharing so KOL buys can be shared as calls and copied by followers");
  assert.equal(square.relevant, true);
  assert.equal(square.strong, true);
  assert.equal(square.category, "社交交易新功能");

  const futuresFeature = classifyBinanceOfficialText("New on Binance Futures: View funding and trading fees directly in position history");
  assert.equal(futuresFeature.relevant, true);
  assert.deepEqual(futuresFeature.labels, ["Futures 功能更新"]);
  const contract = classifyBinanceOfficialText("Binance Futures Will Launch DOGUSDT Perpetual Contract");
  assert.equal(contract.relevant, true);
  assert.deepEqual(contract.labels, ["新合约上线"]);
});

test("extracts concrete announcement facts while dropping boilerplate", () => {
  const facts = extractBinanceAnnouncementFacts({
    seoDesc: "This is a general Binance Exchange Notice. Products and services referred to here may not be available in your region.",
    body: JSON.stringify({ text: "Fellow Binancians. Binance Wallet now supports Base and adds a new Web3 API endpoint. The update takes effect on August 12, 2026." }),
  }, "Binance Wallet Product Update");
  assert.deepEqual(facts, [
    "Binance Wallet now supports Base and adds a new Web3 API endpoint.",
    "The update takes effect on August 12, 2026.",
  ]);
});

test("extracts exact funding interval, effective time, and rate limits from an official notice", () => {
  const details = extractBinanceAnnouncementDetails({
    body: JSON.stringify({
      node: "root",
      child: [
        { node: "text", text: "Effective from 2026-08-19 08:15 (UTC), Binance Futures will adjust the funding interval of UNITREEUSDT Perpetual Contract from every eight hours to every four hours." },
        { node: "text", text: "Time (UTC) Max Funding Rate 2026-08-19 08:00 +2.00% / -2.00%" },
      ],
    }),
  }, "Important Updates on the Funding Rate of USDⓈ-M UNITREEUSDT Perpetual Contract");

  assert.deepEqual(details, {
    kind: "funding_interval",
    instrument: "UNITREEUSDT",
    previousHours: 8,
    currentHours: 4,
    effectiveAt: "2026-08-19T08:15:00.000Z",
    fundingRateCap: "+2.00%",
    fundingRateFloor: "-2.00%",
  });
});

test("extracts every contract and UTC launch from the real seven-contract TradFi table without truncation", () => {
  const title = "Binance Futures Will Launch Multiple USDⓈ-Margined TradFi Perpetual Contracts (2026-09-02)";
  const symbols = ["NVDLUSDT", "TSLLUSDT", "DDOGUSDT", "TEAMUSDT", "MDBUSDT", "ZSUSDT", "GTLBUSDT"];
  const launches = ["10:00", "10:05", "10:10", "10:15", "10:20", "10:25", "10:30"];
  const detail = {
    seoDesc: "This is a general Binance Exchange Notice. Products and services referred to here may not be available in your region.",
    body: JSON.stringify({
      node: "root",
      child: [
        { node: "element", tag: "p", child: [{ node: "text", text: "Fellow Binancians," }] },
        { node: "element", tag: "table", child: [
          announcementTableRow(["Contract Type", ...symbols.map(() => "USDT-Priced")]),
          announcementTableRow(["USDⓈ-M Perpetual Contract", ...symbols]),
          announcementTableRow(["Launch Time", ...launches.map((time) => `2026-09-02 ${time} (UTC)`)]),
        ] },
        { node: "element", tag: "p", child: [{ node: "text", text: "There may be discrepancies between this original content in English and translated versions." }] },
      ],
    }),
  };

  const details = extractBinanceAnnouncementDetails(detail, title);
  assert.deepEqual(details, {
    kind: "instrument_change",
    action: "launch",
    market: "usd_m_perpetual",
    timezone: "UTC",
    instrument: "NVDLUSDT",
    launchAt: "2026-09-02T10:00:00.000Z",
    instruments: symbols.map((symbol, index) => ({
      symbol,
      launchAt: `2026-09-02T${launches[index]}:00.000Z`,
    })),
  });
  const facts = extractBinanceAnnouncementFacts(detail, title);
  assert.ok(facts[0].includes("GTLBUSDT"));
  assert.ok(facts[1].includes("GTLBUSDT=2026-09-02T10:30:00.000Z"));
  assert.doesNotMatch(facts.join(" "), /may not be available|discrepancies|…/i);
});

test("title fallback cannot overwrite distinct per-contract table launch times", () => {
  const title = "Binance Futures Will Launch ABCUSDT and XYZUSDT USDⓈ-Margined Perpetual Contracts (2026-09-04)";
  const details = extractBinanceAnnouncementDetails({
    body: JSON.stringify({
      node: "root",
      child: [{ node: "element", tag: "table", child: [
        announcementTableRow(["USDⓈ-M Perpetual Contract", "ABCUSDT", "XYZUSDT"]),
        announcementTableRow(["Launch Time", "2026-09-04 10:00 (UTC)", "2026-09-04 11:00 (UTC)"]),
      ] }],
    }),
  }, title);

  assert.deepEqual(details.instruments, [
    { symbol: "ABCUSDT", launchAt: "2026-09-04T10:00:00.000Z" },
    { symbol: "XYZUSDT", launchAt: "2026-09-04T11:00:00.000Z" },
  ]);
  assert.equal(details.launchAt, "2026-09-04T10:00:00.000Z");
});

test("unrelated withdrawal, deposit, or funding timestamps cannot become trading schedules", () => {
  const perpetual = extractBinanceAnnouncementDetails({
    body: "Funding fee settlement begins at 2026-09-04 09:00 (UTC). The ABCUSDT contract launch time is TBA.",
  }, "Binance Futures Will Launch ABCUSDT Perpetual Contract");
  assert.deepEqual(perpetual.instruments, [{ symbol: "ABCUSDT" }]);
  assert.equal(perpetual.launchAt, undefined);

  const fullDelist = extractBinanceAnnouncementDetails({
    body: "Withdrawals for ABC close at 2026-09-04 03:00 (UTC). The trading stop time is TBA.",
  }, "Binance Will Delist ABC on 2026-09-03");
  assert.deepEqual(fullDelist.instruments, [{ symbol: "ABC" }]);
  assert.equal(fullDelist.effectiveAt, undefined);

  const newPair = extractBinanceAnnouncementDetails({
    body: "Deposits open at 2026-09-04 02:00 (UTC). New Spot Trading Pairs: ABC/USDT. Trading time is TBA.",
  }, "Binance Adds New Spot Trading Pairs");
  assert.deepEqual(newPair.instruments, [{ symbol: "ABC/USDT" }]);
  assert.equal(newPair.launchAt, undefined);

  for (const [title, details] of [
    ["Binance Futures Will Launch ABCUSDT Perpetual Contract", perpetual],
    ["Binance Will Delist ABC on 2026-09-03", fullDelist],
    ["Binance Adds New Spot Trading Pairs", newPair],
  ]) {
    const priority = deriveTradingPriority({
      type: "binance_official_update",
      kind: "announcement",
      title,
      signal: { scope: "exchange", category: "新合约上线", labels: ["新合约上线"], strong: true },
      announcementDetails: details,
      source: { id: "binance_announcement_cms", trust: "official" },
      publishedAt: "2026-09-03T10:00:00.000Z",
      observedAt: "2026-09-03T10:00:01.000Z",
    }, { nowMs: Date.parse("2026-09-03T10:00:02.000Z") });
    assert.equal(priority.tier, "T2", `${title} must not become realtime without an action-bound schedule`);
    assert.equal(priority.hardGates.completeTargetSet, false);
  }
});

test("keeps a Unicode futures ticker and extracts spot-listing and delisting instruments with UTC times", () => {
  const unicodeTitle = "Binance Futures Will Launch USDⓈ-Margined 牛来USDT Perpetual Contract (2026-08-30)";
  const unicodeDetails = extractBinanceAnnouncementDetails({
    body: JSON.stringify({
      node: "root",
      child: [{ node: "element", tag: "table", child: [
        announcementTableRow(["USDⓈ-M Perpetual Contract", "牛来USDT"]),
        announcementTableRow(["Launch Time", "2026-08-30 11:30 (UTC)"]),
      ] }],
    }),
  }, unicodeTitle);
  assert.equal(unicodeDetails.instrument, "牛来USDT");
  assert.deepEqual(unicodeDetails.instruments, [{ symbol: "牛来USDT", launchAt: "2026-08-30T11:30:00.000Z" }]);

  const spotTitle = "Binance Will List Aerodrome (AERO) with Seed Tag Applied";
  const spotDetails = extractBinanceAnnouncementDetails({
    body: "Binance will list Aerodrome (AERO) and open trading for the following spot trading pairs at 2026-07-17 11:00 (UTC). New Spot Trading Pairs: AERO/USDT, AERO/USDC, and AERO/TRY. Products and services referred to here may not be available in your region.",
  }, spotTitle);
  assert.deepEqual(spotDetails, {
    kind: "instrument_change",
    action: "list",
    market: "spot",
    timezone: "UTC",
    instrument: "AERO",
    launchAt: "2026-07-17T11:00:00.000Z",
    instruments: [{
      symbol: "AERO",
      name: "Aerodrome",
      pairs: ["AERO/USDT", "AERO/USDC", "AERO/TRY"],
      launchAt: "2026-07-17T11:00:00.000Z",
    }],
  });

  const delistTitle = "Binance Will Delist ICX, SCRT, STORJ on 2026-09-03";
  const delistDetails = extractBinanceAnnouncementDetails({
    body: "Based on our reviews, we have decided to delist and cease trading on all spot trading pairs for the following tokens at 2026-09-03 03:00 (UTC): ICON (ICX), Secret (SCRT), Storj (STORJ).",
  }, delistTitle);
  assert.deepEqual(delistDetails.instruments, ["ICX", "SCRT", "STORJ"].map((symbol) => ({
    symbol,
    effectiveAt: "2026-09-03T03:00:00.000Z",
  })));
  assert.equal(delistDetails.effectiveAt, "2026-09-03T03:00:00.000Z");
});

test("fails closed on a real Alpha plus Futures announcement and only structures a complete Alpha-only listing", () => {
  const code = "13776254000000000000000000000000";
  const title = "DeLorean (DMC) Will Be Available on Binance Alpha and Binance Futures (2025-06-24)";
  const payload = announcementDetail(code, title, {
    publishDate: Date.parse("2025-06-21T00:15:00Z"),
    body: JSON.stringify({
      node: "root",
      child: [{
        node: "element",
        tag: "p",
        child: [{
          node: "text",
          text: "Binance is excited to announce that DeLorean (DMC) will open for trading on Binance Alpha starting 2025-06-24 11:00 (UTC). In addition, Binance Futures will launch DMCUSDT Perpetual Contract at 2025-06-24 13:00 (UTC).",
        }],
      }],
    }),
  });
  const detail = parseBinanceAnnouncementDetail(payload, code);

  assert.equal(extractBinanceAnnouncementDetails(detail, title), null,
    "a single-market schema cannot claim completeness for the Alpha leg while omitting DMCUSDT");
  const combinedSignal = classifyBinanceAnnouncement({ title }, detail);
  assert.equal(deriveTradingPriority({
    type: "binance_official_update",
    kind: "announcement",
    project: { id: "binance-wallet", name: "Binance Wallet" },
    signal: combinedSignal,
    title,
    source: { id: "binance_wallet_cms" },
    publishedAt: "2026-09-03T10:00:00.000Z",
    observedAt: "2026-09-03T10:00:00.000Z",
  }, { nowMs: Date.parse("2026-09-03T10:00:01Z") }).tier, "T2");

  const alphaOnlyTitle = "Infinex (INX) Will Be Available on Binance Alpha (2026-01-30)";
  assert.deepEqual(extractBinanceAnnouncementDetails({
    body: "Binance Alpha will list Infinex (INX), and Alpha trading will open at 2026-01-30 19:00 (UTC).",
  }, alphaOnlyTitle), {
    kind: "instrument_change",
    action: "list",
    market: "spot",
    timezone: "UTC",
    instrument: "INX",
    launchAt: "2026-01-30T19:00:00.000Z",
    instruments: [{
      symbol: "INX",
      name: "Infinex",
      launchAt: "2026-01-30T19:00:00.000Z",
    }],
  });
  assert.equal(extractBinanceAnnouncementDetails({
    body: "Binance Alpha will be the first platform to feature Infinex (INX). Trading will open at a time to be announced.",
  }, alphaOnlyTitle), null, "a date in the title is not an actual UTC trading time");
  assert.equal(extractBinanceAnnouncementDetails({
    body: "Another Token (OTHER) will open for trading on Binance Alpha starting 2025-06-24 11:00 (UTC).",
  }, alphaOnlyTitle), null, "a body that does not confirm the title ticker fails closed");
});

test("cross-checks every multi-asset spot title ticker against the complete pair set", () => {
  const code = "aabbccdd000000000000000000000000";
  const title = "Binance Will List Alpha (AAA) and Beta (BBB) with Seed Tag Applied";
  const body = "Binance will list Alpha (AAA) and Beta (BBB) and open trading for the following spot trading pairs at 2026-09-03 12:00 (UTC). New Spot Trading Pairs: AAA/USDT, AAA/USDC, BBB/USDT, and BBB/TRY. Deposits are now open.";
  const detail = parseBinanceAnnouncementDetail(announcementDetail(code, title, { body }), code);

  assert.deepEqual(extractBinanceAnnouncementDetails(detail, title), {
    kind: "instrument_change",
    action: "list",
    market: "spot",
    timezone: "UTC",
    instrument: "AAA",
    launchAt: "2026-09-03T12:00:00.000Z",
    instruments: [
      { symbol: "AAA", name: "Alpha", pairs: ["AAA/USDT", "AAA/USDC"], launchAt: "2026-09-03T12:00:00.000Z" },
      { symbol: "BBB", name: "Beta", pairs: ["BBB/USDT", "BBB/TRY"], launchAt: "2026-09-03T12:00:00.000Z" },
    ],
  });
  assert.equal(extractBinanceAnnouncementDetails({
    body: body.replace(", BBB/USDT, and BBB/TRY", ""),
  }, title), null, "a title asset missing from the pair list fails closed");
  assert.equal(extractBinanceAnnouncementDetails({
    body: body.replace(", and BBB/TRY", ", BBB/TRY, and CCC/USDT"),
  }, title), null, "an unaccounted pair base fails closed");
});

test("parses the official announcement stream, Square identity, and Developer semantic lines", () => {
  const streamed = parseBinanceAnnouncementStreamMessage(JSON.stringify({
    type: "DATA",
    topic: BINANCE_ANNOUNCEMENT_STREAM_TOPIC,
    data: JSON.stringify({ catalogId: 49, catalogName: "Latest News", publishDate: 1_786_000_000_000, title: "Binance Wallet adds a new Web3 API", body: "Now live" }),
  }));
  assert.equal(streamed.catalogId, 49);
  assert.equal(streamed.title, "Binance Wallet adds a new Web3 API");
  const signed = new URL(buildBinanceAnnouncementStreamUrl("secret", 123456789, "fixed-random"));
  assert.equal(signed.searchParams.get("topic"), BINANCE_ANNOUNCEMENT_STREAM_TOPIC);
  assert.equal(signed.searchParams.get("timestamp"), "123456789");
  assert.match(signed.searchParams.get("signature"), /^[a-f0-9]{64}$/);

  const posts = parseBinanceSquarePosts({ code: "000000", data: { contents: [{
    id: 123,
    squareUid: "Na1B6PUjBNGQfhvh1T_yig",
    title: "",
    bodyTextOnly: "Binance Square rolls out Faster Trade Sharing for KOL calls.",
    firstReleaseTime: 1_786_000_000_000,
    editCount: 1,
    webLink: "https://www.binance.com/en/square/post/123",
  }] } });
  assert.equal(posts[0].id, "123");
  assert.match(posts[0].title, /Faster Trade Sharing/);
  assert.deepEqual(extractBinanceDeveloperSignals("# Changelog\n- Added a new wallet endpoint.\nordinary prose\n## 2026-08-11"), [
    "Changelog",
    "Added a new wallet endpoint.",
    "2026-08-11",
  ]);

  const structured = extractBinanceDeveloperSignalSnapshot(`# Binance MCP Server
<FactTile
  label="MCP endpoint"
  value="https://agent.binance.com/mcp/agentic"
/>

## Permissions
- There is no withdrawal scope for the Agentic sub-account.
`);
  assert.ok(structured.signals.includes("MCP endpoint: https://agent.binance.com/mcp/agentic"));
  assert.ok(structured.signals.includes("There is no withdrawal scope for the Agentic sub-account."));
  assert.equal(structured.truncated, false);
});

test("announcement stream reports polling fallback for missing credentials without opening a fake WebSocket", async (t) => {
  const dataDir = await fixture(t);
  const errors = [];
  const infos = [];
  class UnexpectedWebSocket {
    constructor() { assert.fail("WebSocket must not be opened without both credentials"); }
  }
  const monitor = createBinanceMonitor({
    ...monitorConfig(dataDir),
    binanceAnnouncementStreamEnabled: true,
    binanceApiKey: "",
    binanceApiSecret: "",
    binanceSquareMonitorEnabled: false,
    binanceDeveloperMonitorEnabled: false,
  }, {
    WebSocketImpl: UnexpectedWebSocket,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl: streamTestFetch,
    sendAlertsImpl: async () => assert.fail("health checks must not send alerts"),
    logger: {
      error: (message) => errors.push(message),
      info: (message) => infos.push(message),
    },
  });
  t.after(() => monitor.stop());

  const stateFile = path.join(dataDir, "binance-state.json");
  await waitUntil(async () => {
    try {
      const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
      return state._health?.announcementStream?.status === "polling_fallback";
    } catch { return false; }
  });
  await monitor.check();

  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(state._health.announcementStream.status, "polling_fallback");
  assert.equal(state._health.announcementStream.streamStatus, "disabled_missing_credentials");
  assert.equal(state._health.announcementStream.configured, false);
  assert.equal(state._health.announcementStream.connected, false);
  assert.equal(state._health.announcementStream.websocketObserved, false);
  assert.deepEqual(state._health.announcementStream.missingCredentials, ["BINANCE_API_KEY", "BINANCE_API_SECRET"]);
  assert.equal(state._health.announcementStream.pollingFallbackActive, true);
  assert.equal(state._health.announcementStream.coverage.status, "covered_by_polling");
  assert.equal(state._health.announcementStream.coverage.available, true);
  assert.equal(state._health.announcementStream.sla.status, "best_effort_polling");
  assert.equal(state._health.announcementStream.sla.websocketAvailable, false);
  assert.equal(errors.filter((message) => message.includes("missing_credentials")).length, 0);
  assert.equal(infos.filter((message) => message.includes("polling_fallback_missing_credentials")).length, 1);
  assert.match(infos.find((message) => message.includes("polling_fallback_missing_credentials")), /REST\/CMS polling remains active/);
  await monitor.stop();
});

test("main Binance state removes stale Agent OS health while fast-lane state remains authoritative", async (t) => {
  const dataDir = await fixture(t);
  const stateFile = path.join(dataDir, "binance-state.json");
  const agentNativeStateFile = path.join(dataDir, "binance-agent-native-state.json");
  await fs.writeFile(stateFile, `${JSON.stringify({
    version: 2,
    announcements: { articles: {} },
    square: { posts: {} },
    developerDocs: { pages: {} },
    memeRush: { baselinedTargets: [], protocols: {}, versions: {}, schemaKeys: [], versionCandidates: {}, tokenIndex: {}, cursor: 0 },
    launchpool: {},
    _health: {
      agentOsPage: {
        status: "degraded",
        checkedAt: "2026-08-20T12:38:05.760Z",
        consecutiveFailures: 390,
      },
    },
  }, null, 2)}\n`);
  await fs.writeFile(agentNativeStateFile, `${JSON.stringify({
    version: 2,
    pages: {},
    cms: { articles: {} },
    scheduler: { developerCursor: 0 },
    sourceControls: {},
    _health: {
      agentOsPage: {
        status: "healthy",
        retrievalMode: "verified_reader",
        coverage: { status: "verified_reader_fallback", available: true },
      },
    },
  }, null, 2)}\n`);
  const monitor = createBinanceMonitor({
    ...monitorConfig(dataDir),
    binanceAnnouncementStreamEnabled: false,
    binanceSquareMonitorEnabled: false,
    binanceDeveloperMonitorEnabled: false,
  }, {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl: streamTestFetch,
    sendAlertsImpl: async () => assert.fail("state migration must not send alerts"),
    logger: { error() {} },
  });

  await monitor.check();
  const mainState = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const fastState = JSON.parse(await fs.readFile(agentNativeStateFile, "utf8"));
  assert.equal(Object.hasOwn(mainState._health, "agentOsPage"), false);
  assert.equal(fastState._health.agentOsPage.status, "healthy");
  assert.equal(fastState._health.agentOsPage.coverage.status, "verified_reader_fallback");
  await monitor.stop();
});

test("announcement stream persists connect, message, and close health without sending", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-11T03:00:00Z");
  const errors = [];
  class FakeWebSocket extends EventEmitter {
    static OPEN = 1;
    static CLOSING = 2;
    static instances = [];

    constructor(url, options) {
      super();
      this.url = url;
      this.options = options;
      this.readyState = 0;
      this.sent = [];
      FakeWebSocket.instances.push(this);
    }

    send(value) { this.sent.push(value); }
    ping() {}
    close() { this.readyState = 3; }
  }
  const monitor = createBinanceMonitor({
    ...monitorConfig(dataDir),
    binanceAnnouncementStreamEnabled: true,
    binanceApiKey: "key",
    binanceApiSecret: "secret",
    binanceSquareMonitorEnabled: false,
    binanceDeveloperMonitorEnabled: false,
  }, {
    WebSocketImpl: FakeWebSocket,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl: streamTestFetch,
    now: () => current,
    sendAlertsImpl: async () => assert.fail("a non-data frame must not send alerts"),
    logger: { error: (message) => errors.push(message) },
  });
  t.after(() => monitor.stop());

  assert.equal(FakeWebSocket.instances.length, 1);
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.options.headers["X-MBX-APIKEY"], "key");
  socket.readyState = FakeWebSocket.OPEN;
  socket.emit("open");

  const stateFile = path.join(dataDir, "binance-state.json");
  await waitUntil(async () => {
    try {
      const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
      return state._health?.announcementStream?.status === "connected";
    } catch { return false; }
  });
  assert.deepEqual(JSON.parse(socket.sent[0]), { command: "SUBSCRIBE", value: BINANCE_ANNOUNCEMENT_STREAM_TOPIC });

  current += 1_000;
  socket.emit("message", JSON.stringify({ type: "PING" }));
  await waitUntil(async () => {
    const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    return state._health?.announcementStream?.lastMessageAt === "2026-08-11T03:00:01.000Z";
  });
  let state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(state._health.announcementStream.status, "healthy");
  assert.equal(state._health.announcementStream.streamStatus, "healthy");
  assert.equal(state._health.announcementStream.connected, true);
  assert.equal(state._health.announcementStream.websocketObserved, true);

  current += 1_000;
  socket.readyState = 3;
  socket.emit("close", 1006, Buffer.from("network reset"));
  await waitUntil(async () => {
    state = JSON.parse(await fs.readFile(stateFile, "utf8"));
    return state._health?.announcementStream?.status === "backoff";
  });
  assert.equal(state._health.announcementStream.connected, false);
  assert.equal(state._health.announcementStream.streamStatus, "backoff");
  assert.equal(state._health.announcementStream.disconnectedAt, "2026-08-11T03:00:02.000Z");
  assert.equal(state._health.announcementStream.closeCode, 1006);
  assert.equal(state._health.announcementStream.closeReason, "network reset");
  assert.equal(state._health.announcementStream.consecutiveFailures, 1);
  assert.deepEqual(errors, []);
  await monitor.stop();
});

test("parses official announcement catalogs with canonical detail URLs", () => {
  const code = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const [parsed] = parseBinanceAnnouncements(announcements([article(code, "Binance Wallet Launches Web3 API") ]));
  assert.equal(parsed.code, code);
  assert.equal(parsed.catalogId, 49);
  assert.equal(parsed.url, `https://www.binance.com/en/support/announcement/detail/${code}`);
  assert.deepEqual(parsed.catalogs, [{ id: 49, name: "Latest Binance News" }]);
});

test("parses official announcement details and uses SEO/body evidence for Wallet routing", () => {
  const code = "dddddddddddddddddddddddddddddddd";
  const detail = parseBinanceAnnouncementDetail(announcementDetail(code, "Product Upgrade Notice", {
    lastUpdateTime: Date.parse("2026-08-02T01:00:00Z"),
    version: "2",
    seoDesc: "Binance Wallet upgrades Prediction Markets API with a new protocol module",
    body: JSON.stringify({ text: "The new Prediction Markets API module is available in Binance Wallet." }),
  }), code);
  assert.equal(detail.code, code);
  assert.equal(detail.version, "2");
  assert.equal(detail.semanticHash.length, 16);
  assert.equal(detail.materialHash.length, 16);
  assert.equal(detail.contentHash.length, 16);
  const signal = classifyBinanceAnnouncement({ title: detail.title, catalogId: 157 }, detail);
  assert.equal(signal.relevant, true);
  assert.equal(signal.scope, "wallet");
  assert.equal(signal.strong, true);

  const bodyOnly = parseBinanceAnnouncementDetail(announcementDetail(code, "Product Upgrade Notice", {
    body: JSON.stringify({ text: "Binance Wallet rolls out a new Web3 API module and protocol." }),
  }), code);
  const bodySignal = classifyBinanceAnnouncement({ title: bodyOnly.title, catalogId: 49 }, bodyOnly);
  assert.equal(bodySignal.relevant, true);
  assert.equal(bodySignal.scope, "wallet");
  assert.equal(bodySignal.strong, true);

  const bodyUi = parseBinanceAnnouncementDetail(announcementDetail(code, "Product Upgrade Notice", {
    body: JSON.stringify({ text: "Binance Wallet updates its swap interface for faster routing." }),
  }), code);
  const bodyUiSignal = classifyBinanceAnnouncement({ title: bodyUi.title, catalogId: 49 }, bodyUi);
  assert.equal(bodyUiSignal.relevant, true);
  assert.equal(bodyUiSignal.scope, "wallet");
  assert.equal(bodyUiSignal.strong, false);

  const bodySecurity = parseBinanceAnnouncementDetail(announcementDetail(code, "Product Upgrade Notice", {
    body: JSON.stringify({ text: "Binance Wallet enhances account security for transaction signing." }),
  }), code);
  const bodySecuritySignal = classifyBinanceAnnouncement({ title: bodySecurity.title, catalogId: 49 }, bodySecurity);
  assert.equal(bodySecuritySignal.relevant, true);
  assert.equal(bodySecuritySignal.strong, true);

  const bodyCampaign = parseBinanceAnnouncementDetail(announcementDetail(code, "Product Upgrade Notice", {
    body: JSON.stringify({ text: "Binance Wallet launches a Meme Rush trading campaign. Trade tokens and win rewards." }),
  }), code);
  const bodyCampaignSignal = classifyBinanceAnnouncement({ title: bodyCampaign.title, catalogId: 49 }, bodyCampaign);
  assert.equal(bodyCampaignSignal.relevant, true);
  assert.equal(bodyCampaignSignal.category, "活动公告");
});

test("extracts only Meme Rush platform capabilities and Launchpool structure", () => {
  const capabilities = extractMemeRushCapabilities(memeRush([
    item(),
    item({ contract: "0x2222222222222222222222222222222222222222", extra: { antiSniperTaxType: 1 } }),
  ]), { chainId: "56", rankType: 10 });
  assert.deepEqual(capabilities.protocols.map(({ chainId, protocol, name }) => ({ chainId, protocol, name })), [{ chainId: "56", protocol: "2002", name: "Flap" }]);
  assert.equal(capabilities.versions[0].contracts.length, 2);
  assert.ok(capabilities.schemaKeys.includes("antiSniperTaxType"));

  const baseCapabilities = extractMemeRushCapabilities(memeRush([
    item({ protocol: 3001, chainId: "8453" }),
    item({ protocol: 3002, chainId: "8453" }),
    item({ protocol: 3010, chainId: "8453" }),
  ]), { chainId: "8453", rankType: 10 });
  assert.deepEqual(baseCapabilities.protocols.map(({ protocol, name }) => ({ protocol, name })), [
    { protocol: "3001", name: "Clanker" },
    { protocol: "3002", name: "Doppler" },
    { protocol: "3010", name: "Base B20" },
  ]);

  assert.deepEqual(extractLaunchpoolCapabilities(launchpool([
    { projectId: "ONE_BNB", asset: "BNB", status: "SUBSCRIBABLE" },
    { projectId: "ONE_USDC", asset: "USDC", status: "SUBSCRIBABLE" },
  ])), {
    buckets: ["completed", "tracking"],
    assets: ["BNB", "USDC"],
    statuses: ["SUBSCRIBABLE"],
    fields: ["asset", "projectId", "status"],
  });
});

test("extracts normalized Meme Rush token attribution records without market-risk data", () => {
  const contract = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
  const capabilities = extractMemeRushCapabilities(memeRush([
    item({
      version: "7",
      contract,
      extra: {
        createTime: "1785673290000",
        createHeight: "113584798",
        name: "Launch Token",
        symbol: "LAUNCH",
        devAddress: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        socials: { website: "https://example.com", telegram: "", ignored: "value" },
        taxRateBuy: "3",
        creatorType: -1,
        exclusive: 0,
      },
    }),
    item({
      version: "7",
      contract: contract.toLowerCase(),
      extra: {
        antiSniperTaxType: 1,
        socials: { twitter: "https://x.com/example" },
      },
    }),
  ]), { chainId: "56", rankType: 10 });

  assert.equal(capabilities.tokens.length, 1, "the same token in one official feed is coalesced");
  assert.deepEqual(capabilities.tokens[0], {
    chainId: "56",
    contractAddress: contract.toLowerCase(),
    sourceId: "binance_wallet_meme_rush",
    protocol: "2002",
    protocolName: "Flap",
    tokenVersion: "7",
    rankTypes: ["10"],
    name: "Launch Token",
    symbol: "LAUNCH",
    devAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    createTime: 1785673290000,
    createHeight: 113584798,
    migrateStatus: 0,
    creatorType: -1,
    exclusive: 0,
    launchTaxEnable: false,
    antiSniperTaxType: 1,
    taxRateBuy: "3",
    socials: { website: "https://example.com", twitter: "https://x.com/example" },
  });
  assert.equal("price" in capabilities.tokens[0], false, "dynamic market data is not persisted as attribution evidence");
});

test("persists a bounded Meme Rush token index and upgrades old state files", async (t) => {
  const dataDir = await fixture(t);
  await fs.writeFile(path.join(dataDir, "binance-state.json"), JSON.stringify({
    version: 1,
    memeRush: { baselinedTargets: [] },
  }));

  let stage = 0;
  let current = Date.parse("2026-08-02T10:20:00Z");
  const newest = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const middle = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
  const oldest = "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush(stage === 0 ? [
      item({ contract: oldest, extra: { createTime: 100, name: "Old" } }),
      item({ contract: newest, extra: { createTime: 300, name: "Newest", symbol: "NEW", socials: { website: "https://new.example" } } }),
      item({ contract: middle, extra: { createTime: 200, name: "Middle" } }),
    ] : [
      item({ contract: newest.toLowerCase(), extra: { createTime: 300, socials: { twitter: "https://x.com/newest" } } }),
    ]));
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor(monitorConfig(dataDir), {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    memeRushTokenIndexLimit: 2,
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async () => {},
    logger: { error() {} },
  });

  await monitor.check();
  const stateFile = path.join(dataDir, "binance-state.json");
  const first = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.equal(first.version, 2, "old Binance state is upgraded without resetting its baseline");
  assert.deepEqual(Object.keys(first.memeRush.tokenIndex).sort(), [
    `56:${middle.toLowerCase()}`,
    `56:${newest.toLowerCase()}`,
  ].sort());
  assert.equal(first.memeRush.tokenIndex[`56:${oldest.toLowerCase()}`], undefined);
  assert.equal(first.memeRush.tokenIndex[`56:${newest.toLowerCase()}`].protocolName, "Flap");
  assert.equal(first.memeRush.tokenIndex[`56:${newest.toLowerCase()}`].name, "Newest");
  assert.equal(first.memeRush.tokenIndex[`56:${newest.toLowerCase()}`].symbol, "NEW");
  assert.equal(first.memeRush.tokenIndex[`56:${newest.toLowerCase()}`].firstSeenAt, "2026-08-02T10:20:00.000Z");
  const firstProtocolEvidence = structuredClone(first.memeRush.protocols["56:2002"]);

  stage = 1;
  current += 1_000;
  await monitor.check();
  await monitor.stop();
  const second = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const retained = second.memeRush.tokenIndex[`56:${newest.toLowerCase()}`];
  assert.equal(retained.name, "Newest", "a sparse later rank response does not erase attribution metadata");
  assert.deepEqual(retained.socials, { website: "https://new.example", twitter: "https://x.com/newest" });
  assert.equal(retained.firstSeenAt, "2026-08-02T10:20:00.000Z");
  assert.equal(retained.lastSeenAt, "2026-08-02T10:20:01.000Z");
  assert.equal(Object.keys(second.memeRush.tokenIndex).length, 2);
  assert.deepEqual(second.memeRush.protocols["56:2002"], firstProtocolEvidence, "rank rotation cannot rewrite the protocol's first durable evidence");
});

test("first run is a silent baseline, then only structural deltas are delivered", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  const delivered = [];
  const baseCode = "11111111111111111111111111111111";
  const featureCode = "22222222222222222222222222222222";
  const listingCode = "33333333333333333333333333333333";
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(stage === 0
      ? announcements([article(baseCode, "Binance Adds a New Spot Trading Pair")])
      : announcements([
          article(baseCode, "Binance Adds a New Spot Trading Pair"),
          article(featureCode, "Introducing the BuildKey TGE Model on Binance Wallet"),
          article(listingCode, "Introducing TOKEN (TOKEN) on Binance Launchpool! Farm TOKEN by Locking BNB"),
        ]));
    const detailCode = detailRequestCode(url);
    if (detailCode === featureCode) return ok(announcementDetail(featureCode, "Introducing the BuildKey TGE Model on Binance Wallet"));
    if (detailCode === listingCode) return ok(announcementDetail(listingCode, "Introducing TOKEN (TOKEN) on Binance Launchpool! Farm TOKEN by Locking BNB"));
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(stage === 0
      ? launchpool([{ projectId: "OLD_BNB", asset: "BNB", status: "REDEEMED" }])
      : launchpool([
          { projectId: "OLD_BNB", asset: "BNB", status: "REDEEMED" },
          { projectId: "NEW_USDX", asset: "USDX", status: "REDEEMED" },
        ]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(stage === 0
      ? memeRush([item()])
      : memeRush([
          item(),
          item({ protocol: 2099, version: "1", contract: "0x9999999999999999999999999999999999999991" }),
          item({ protocol: 2099, version: "1", contract: "0x9999999999999999999999999999999999999992" }),
        ]));
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor(monitorConfig(dataDir), {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    logger: { error() {} },
  });

  await monitor.check();
  assert.equal(delivered.length, 0);
  stage = 1;
  await monitor.check();
  assert.deepEqual(delivered.map((event) => event.kind), ["announcement", "announcement", "launchpool_capability", "meme_rush_capability"]);
  assert.equal(delivered[0].article.code, featureCode);
  assert.equal(delivered[1].article.code, listingCode);
  assert.deepEqual(delivered[2].changes.newStakeAssets, ["USDX"]);
  assert.equal(delivered[3].changes.newProtocols[0].protocol, "2099");
  assert.equal(delivered.some((event) => event.article?.code === listingCode), true);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "binance-state.json"), "utf8"));
  assert.ok(state.announcements.articles[listingCode], "ignored articles still advance the durable cursor");
  assert.ok(state.memeRush.protocols["56:2099"]);
});

test("routes exchange, Wallet, and campaign announcements separately", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  const delivered = [];
  const baseCode = "10000000000000000000000000000000";
  const spotCode = "20000000000000000000000000000000";
  const rulesCode = "30000000000000000000000000000000";
  const walletCode = "40000000000000000000000000000000";
  const campaignCode = "50000000000000000000000000000000";
  const titles = {
    [spotCode]: "Binance Will List Example (EXM) with Seed Tag Applied",
    [rulesCode]: "Updates on Tick Size for Multiple USDⓈ-M Perpetual Futures Contracts",
    [walletCode]: "Binance Wallet Introduces Support for a New Chain and Web3 API",
    [campaignCode]: "Binance Wallet Trading Campaign: Trade EXM and Win Token Rewards",
  };
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements(stage === 0
      ? [article(baseCode, "Existing baseline article")]
      : [
          article(baseCode, "Existing baseline article"),
          article(spotCode, titles[spotCode]),
          article(rulesCode, titles[rulesCode]),
          article(walletCode, titles[walletCode]),
          article(campaignCode, titles[campaignCode]),
        ]));
    const detailCode = detailRequestCode(url);
    if (detailCode && titles[detailCode]) return ok(announcementDetail(detailCode, titles[detailCode]));
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([item()]));
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor(monitorConfig(dataDir), {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    logger: { error() {} },
  });

  await monitor.check();
  stage = 1;
  await monitor.check();

  assert.deepEqual(delivered.map((event) => ({
    code: event.article.code,
    scope: event.signal.scope,
    strong: event.strong,
    source: event.source.id,
  })), [
    { code: spotCode, scope: "exchange", strong: true, source: "binance_exchange_cms" },
    { code: rulesCode, scope: "exchange", strong: false, source: "binance_exchange_cms" },
    { code: walletCode, scope: "wallet", strong: true, source: "binance_wallet_cms" },
    { code: campaignCode, scope: "exchange", strong: false, source: "binance_exchange_cms" },
  ]);
  assert.equal(delivered.some((event) => event.article.code === campaignCode), true);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "binance-state.json"), "utf8"));
  assert.equal(state.announcements.articles[campaignCode].relevant, true);
  assert.equal(state._health.exchangeAnnouncements.status, "healthy");
  assert.equal(state._health.walletAnnouncements.status, "healthy");
});

test("isolates a detail 429 so a later conclusive exchange alert is not blocked", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  const delivered = [];
  const baseCode = "61000000000000000000000000000000";
  const hiddenCode = "62000000000000000000000000000000";
  const spotCode = "63000000000000000000000000000000";
  const spotTitle = "Binance Will List Later (LATER) with Seed Tag Applied";
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements(stage === 0
      ? [article(baseCode, "Existing baseline article")]
      : [
          article(baseCode, "Existing baseline article"),
          article(hiddenCode, "Product Upgrade Notice"),
          article(spotCode, spotTitle),
        ]));
    const detailCode = detailRequestCode(url);
    if (detailCode === hiddenCode) return { ok: false, status: 429, text: async () => "rate limited" };
    if (detailCode === spotCode) return ok(announcementDetail(spotCode, spotTitle));
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([item()]));
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor(monitorConfig(dataDir), {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    logger: { error() {} },
  });

  await monitor.check();
  stage = 1;
  await monitor.check();

  assert.deepEqual(delivered.map((event) => event.article.code), [hiddenCode, spotCode]);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "binance-state.json"), "utf8"));
  assert.equal(state.announcements.articles[hiddenCode].relevant, true, "catalogued ordinary notice is retained even while detail is rate-limited");
  assert.equal(state.announcements.articles[spotCode].relevant, true);
  assert.equal(state._health.announcements.status, "degraded");
  assert.equal(state._health.announcements.detailFailures, 1);
});

test("a transient listing-detail failure recovers once with a stable complete-details revision", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  let detailReady = false;
  let current = Date.parse("2026-09-03T10:00:00Z");
  const delivered = [];
  const baseCode = "64000000000000000000000000000000";
  const listingCode = "65000000000000000000000000000000";
  const listingTitle = "Binance Will List Alpha (AAA) and Beta (BBB) with Seed Tag Applied";
  const listingArticle = article(listingCode, listingTitle, current - 60_000);
  const listingBody = "Binance will list Alpha (AAA) and Beta (BBB) and open trading for the following spot trading pairs at 2026-09-03 12:00 (UTC). New Spot Trading Pairs: AAA/USDT and BBB/USDT. Deposits are now open.";
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements(stage === 0
      ? [article(baseCode, "Existing baseline article", current - 120_000)]
      : [article(baseCode, "Existing baseline article", current - 120_000), listingArticle]));
    const detailCode = detailRequestCode(url);
    if (detailCode === listingCode) {
      if (!detailReady) return { ok: false, status: 503, text: async () => "detail not ready" };
      return ok(announcementDetail(listingCode, listingTitle, {
        publishDate: listingArticle.releaseDate,
        body: listingBody,
      }));
    }
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([item()]));
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor(monitorConfig(dataDir), {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    logger: { error() {} },
  });

  await monitor.check();
  stage = 1;
  current += 1_000;
  await monitor.check();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].announcementDetails, undefined);
  assert.equal(deriveTradingPriority(delivered[0], { nowMs: current }).tier, "T2");

  detailReady = true;
  current += 1_000;
  await monitor.check();
  current += 1_000;
  await monitor.check();

  assert.equal(delivered.length, 2, "the complete detail recovery is emitted exactly once");
  const recovered = delivered[1];
  assert.equal(recovered.changeType, "revised");
  assert.equal(recovered.detailRecovery, true);
  assert.equal(recovered.recoveryReason, "complete_instrument_details");
  assert.match(recovered.eventKey, new RegExp(`^binance-announcement:${listingCode}:detail-recovered:[a-f0-9]+$`));
  assert.deepEqual(recovered.announcementDetails.instruments.map((item) => item.symbol), ["AAA", "BBB"]);
  assert.equal(deriveTradingPriority(recovered, { nowMs: current }).tier, "T0");
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "binance-state.json"), "utf8"));
  assert.equal(state.announcements.articles[listingCode].detailPending, false);
  assert.ok(state.announcements.articles[listingCode].contentHash);
});

test("detects one semantic same-title revision and ignores body-only copy churn", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  let current = Date.parse("2026-08-02T10:20:00Z");
  const delivered = [];
  const baseCode = "71000000000000000000000000000000";
  const walletCode = "72000000000000000000000000000000";
  const walletTitle = "Binance Wallet Updates Its Swap Interface";
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements(stage === 0
      ? [article(baseCode, "Existing baseline article")]
      : [article(baseCode, "Existing baseline article"), article(walletCode, walletTitle)]));
    const detailCode = detailRequestCode(url);
    if (detailCode === walletCode) {
      const version = stage === 1 ? "1" : stage === 2 ? "2" : "3";
      const seoDesc = "Binance Wallet updates its swap interface.";
      const body = stage === 1
        ? seoDesc
        : `Binance Wallet rolls out a new routing API endpoint.${stage === 3 ? " Typo corrected in footer." : ""}`;
      return ok(announcementDetail(walletCode, walletTitle, {
        version,
        lastUpdateTime: current,
        seoDesc,
        body: JSON.stringify({ text: body }),
      }));
    }
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([item()]));
    throw new Error(`unexpected URL ${url}`);
  };
  let monitor = createBinanceMonitor(monitorConfig(dataDir), {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    logger: { error() {} },
  });

  await monitor.check();
  stage = 1;
  current += 1_000;
  await monitor.check();
  stage = 2;
  current += 1_000;
  await monitor.check();
  assert.equal(
    JSON.parse(await fs.readFile(path.join(dataDir, "binance-state.json"), "utf8")).announcements.articles[walletCode].version,
    "2",
    "a material announcement revision is durable before the polling call returns",
  );
  await monitor.stop();
  monitor = createBinanceMonitor(monitorConfig(dataDir), {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    logger: { error() {} },
  });
  stage = 3;
  current += 1_000;
  await monitor.check();
  await monitor.stop();

  assert.deepEqual(delivered.map((event) => event.changeType), ["published", "revised"]);
  assert.notEqual(delivered[0].eventKey, delivered[1].eventKey);
  assert.equal(delivered[0].comparisonBasis, "monitoring_baseline");
  assert.equal(delivered[0].baselineStatus, "not_recorded");
  assert.equal(delivered[1].comparisonBasis, "exact_snapshot");
  assert.equal(delivered[1].previousSnapshot.title, walletTitle);
  assert.equal(delivered[1].currentSnapshot.title, walletTitle);
  assert.ok(delivered[1].changedFields.includes("facts"));
  assert.match(delivered[1].currentSnapshot.facts.join(" "), /routing API endpoint/i);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "binance-state.json"), "utf8"));
  assert.equal(state.announcements.articles[walletCode].version, "3");
  assert.equal(state.announcements.articles[walletCode].listTitle, walletTitle);
  assert.equal(state.announcements.articles[walletCode].displaySnapshot.title, walletTitle);
});

test("a persistent detail 429 cannot starve another article's revision refresh", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  let current = Date.parse("2026-08-02T10:20:00Z");
  const delivered = [];
  const baseCode = "81000000000000000000000000000000";
  const blockedCode = "82000000000000000000000000000000";
  const revisedCode = "83000000000000000000000000000000";
  const blockedTitle = "Binance Wallet Updates Its Portfolio Interface";
  const revisedTitle = "Binance Wallet Updates Its Swap Interface";
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements(stage === 0
      ? [article(baseCode, "Existing baseline article")]
      : [
          article(baseCode, "Existing baseline article"),
          article(blockedCode, blockedTitle),
          article(revisedCode, revisedTitle),
        ]));
    const detailCode = detailRequestCode(url);
    if (detailCode === blockedCode) {
      if (stage >= 2) return { ok: false, status: 429, text: async () => "rate limited" };
      return ok(announcementDetail(blockedCode, blockedTitle, { seoDesc: "Binance Wallet updates its portfolio interface." }));
    }
    if (detailCode === revisedCode) return ok(announcementDetail(revisedCode, revisedTitle, {
      version: stage >= 3 ? "2" : "1",
      seoDesc: stage >= 3
        ? "Binance Wallet updates its swap interface with a new routing API."
        : "Binance Wallet updates its swap interface.",
    }));
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([item()]));
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor(monitorConfig(dataDir), {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    logger: { error() {} },
  });

  await monitor.check();
  stage = 1;
  current += 1_000;
  await monitor.check();
  stage = 2;
  current += 1_000;
  await monitor.check();
  stage = 3;
  current += 1_000;
  await monitor.check();

  assert.deepEqual(delivered.map((event) => [event.article.code, event.changeType]), [
    [blockedCode, "published"],
    [revisedCode, "published"],
    [revisedCode, "revised"],
  ]);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "binance-state.json"), "utf8"));
  assert.equal(state.announcements.articles[blockedCode].detailPending, true);
  assert.equal(state.announcements.articles[blockedCode].detailFailureCount, 1);
  assert.equal(state.announcements.articles[revisedCode].version, "2");
});

test("first run emits one bounded alert for a recent undocumented OpenFour protocol", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.parse("2026-08-02T10:20:00Z");
  const createTime = current - 5 * 60 * 1_000;
  const delivered = [];
  const requestedLimits = [];
  const fetchImpl = async (url, options = {}) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) {
      requestedLimits.push(JSON.parse(options.body).limit);
      return ok(memeRush([
        item({ protocol: 2004, version: "openfour.meme.TaxToken", contract: "0x2004000000000000000000000000000000000001", extra: { createTime } }),
        item({ protocol: 2004, version: "openfour.meme.TaxToken", contract: "0x2004000000000000000000000000000000000002", extra: { createTime } }),
      ]));
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor(monitorConfig(dataDir), {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    logger: { error() {} },
  });

  await monitor.check();
  await monitor.check();

  assert.equal(delivered.length, 1);
  assert.deepEqual(requestedLimits, [200, 200]);
  assert.equal(delivered[0].eventKey, "binance-meme-rush-baseline-gap:56:2004");
  assert.equal(delivered[0].baselineDiscovery, true);
  assert.equal(delivered[0].strong, true);
  assert.equal(delivered[0].changes.newProtocols[0].name, "OpenFour (Four.Meme)");
  assert.deepEqual(delivered[0].changes.newProtocols[0].tokenVersions, ["openfour.meme.TaxToken"]);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "binance-state.json"), "utf8"));
  assert.ok(state.memeRush.protocols["56:2004"]);
  assert.ok(state.memeRush.versions["56:2004:openfour.meme.TaxToken"]);
});

test("an alert delivery failure does not advance the Binance announcement cursor", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  let fail = false;
  const baseCode = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const nextCode = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements(stage === 0
      ? [article(baseCode, "Binance Adds a New Spot Trading Pair")]
      : [
          article(baseCode, "Binance Adds a New Spot Trading Pair"),
          article(nextCode, "Binance Wallet Launches a New Web3 API Module"),
        ]));
    const detailCode = detailRequestCode(url);
    if (detailCode === nextCode) return ok(announcementDetail(nextCode, "Binance Wallet Launches a New Web3 API Module"));
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([item()]));
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor(monitorConfig(dataDir), {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    sendAlertsImpl: async () => { if (fail) throw new Error("telegram unavailable"); },
    logger: { error() {} },
  });

  await monitor.check();
  stage = 1;
  fail = true;
  await monitor.check();
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "binance-state.json"), "utf8"));
  assert.equal(state.announcements.articles[nextCode], undefined);
  assert.equal(state._health.announcements.status, "error");
  assert.match(state._health.announcements.lastError, /telegram unavailable/);
});

test("terminal Binance announcement rejections advance the cursor and do not block later articles", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  const baseCode = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const sourceDisabledCode = "cccccccccccccccccccccccccccccccc";
  const notRelevantCode = "dddddddddddddddddddddddddddddddd";
  const blockedCode = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
  const deliveredCode = "ffffffffffffffffffffffffffffffff";
  const newArticles = [
    article(sourceDisabledCode, "Binance Futures Will Launch Multiple USDⓈ-Margined TradFi Perpetual Contracts"),
    article(notRelevantCode, "Example Two (TWO) Will Be Available on Binance Alpha"),
    article(blockedCode, "Binance Futures Will Launch THREEUSDT USDⓈ-Margined Perpetual Contract"),
    article(deliveredCode, "Binance Launches Example Four Trading Activity"),
  ];
  const attempted = [];
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements(stage === 0
      ? [article(baseCode, "Binance Adds a New Spot Trading Pair")]
      : [article(baseCode, "Binance Adds a New Spot Trading Pair"), ...newArticles]));
    const detailCode = detailRequestCode(url);
    const matching = newArticles.find((candidate) => candidate.code === detailCode);
    if (matching) return ok(announcementDetail(matching.code, matching.title));
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([item()]));
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor(monitorConfig(dataDir), {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    sendAlertsImpl: async (_config, event) => {
      attempted.push(event.article.code);
      if (event.article.code === sourceDisabledCode) return { status: "suppressed", reason: "monitoring_source_disabled" };
      if (event.article.code === notRelevantCode) return { status: "suppressed", reason: "not_relevant" };
      if (event.article.code === blockedCode) return { status: "suppressed", reason: "blocked_event" };
      return { status: "delivered" };
    },
    logger: { error() {} },
  });

  await monitor.check();
  stage = 1;
  await monitor.check();

  assert.deepEqual(attempted, [sourceDisabledCode, notRelevantCode, blockedCode, deliveredCode]);
  const state = JSON.parse(await fs.readFile(path.join(dataDir, "binance-state.json"), "utf8"));
  for (const code of attempted) assert.ok(state.announcements.articles[code], `${code} cursor was not persisted`);
  assert.equal(state._health.announcements.status, "healthy");

  await monitor.check();
  assert.deepEqual(attempted, [sourceDisabledCode, notRelevantCode, blockedCode, deliveredCode], "consumed articles must not replay");
});

test("Square starts silently, marks a new feature against the monitoring baseline, and compares edits exactly", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  let current = Date.parse("2026-08-11T00:00:00Z");
  const delivered = [];
  const squarePayload = () => ({
    code: "000000",
    data: {
      contents: [
        {
          id: 1,
          squareUid: "Na1B6PUjBNGQfhvh1T_yig",
          bodyTextOnly: "Live interview on Binance Square. Set a reminder for the next episode.",
          firstReleaseTime: current - 60_000,
          editCount: 0,
          webLink: "https://www.binance.com/en/square/post/1",
        },
        ...(stage ? [{
          id: 2,
          squareUid: "Na1B6PUjBNGQfhvh1T_yig",
          bodyTextOnly: stage >= 2
            ? "Binance Square rolls out Faster Trade Sharing and Share Copy Trading so KOL buys can be shared with followers through a new copy endpoint."
            : "Binance Square rolls out Faster Trade Sharing and Share Copy Trading so KOL buys can be shared with followers.",
          firstReleaseTime: current,
          editCount: stage >= 2 ? 1 : 0,
          editTime: stage >= 2 ? current : null,
          webLink: "https://www.binance.com/en/square/post/2",
        }] : []),
      ],
    },
  });
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([item()]));
    if (url === BINANCE_SQUARE_FEED_URL) return ok(squarePayload());
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor({
    ...monitorConfig(dataDir),
    binanceSquareMonitorEnabled: true,
    binanceSquarePollIntervalMs: 0,
  }, {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    logger: { error() {} },
  });

  await monitor.check();
  assert.equal(delivered.length, 0);
  stage = 1;
  current += 1_000;
  await monitor.check();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].source.id, "binance_square_cms");
  assert.equal(delivered[0].signal.category, "社交交易新功能");
  assert.match(delivered[0].factSummary, /Trade Sharing/);
  assert.equal(delivered[0].comparisonBasis, "monitoring_baseline");
  assert.equal(delivered[0].baselineStatus, "not_recorded");
  stage = 2;
  current += 1_000;
  await monitor.check();
  assert.equal(delivered.length, 2);
  assert.equal(delivered[1].changeType, "revised");
  assert.equal(delivered[1].comparisonBasis, "exact_snapshot");
  assert.equal(delivered[1].previousSnapshot.editCount, 0);
  assert.equal(delivered[1].currentSnapshot.editCount, 1);
  assert.ok(delivered[1].changedFields.includes("facts"));
});

test("Developer changelogs consume terminal scope rejections while preserving exact cursor deltas", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  let current = Date.parse("2026-08-11T01:00:00Z");
  const delivered = [];
  const walletUrl = BINANCE_DEVELOPER_DOC_URLS.find((url) => url.includes("/wallet/change-log.md"));
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([item()]));
    if (url === BINANCE_AGENT_OS_PAGE_URL) {
      return textResponse("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
    }
    if (url === BINANCE_AGENT_OS_READER_URL) return textResponse(verifiedAgentOsReaderBody());
    if (BINANCE_DEVELOPER_DOC_URLS.includes(url)) {
      const text = url !== walletUrl
        ? "# Wallet Changelog\n- Existing endpoint."
        : stage === 0
          ? "# Wallet Changelog\n- Existing endpoint."
          : stage === 1
            ? "# Wallet Changelog\n- Existing endpoint.\n- Added a new Web3 API endpoint for KOL trade sharing."
            : stage === 2
              ? "# Wallet Changelog\n- Added a new Web3 API endpoint for KOL trade sharing."
              : "- Added a new Web3 API endpoint for KOL trade sharing.\n# Wallet Changelog";
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => text };
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor({
    ...monitorConfig(dataDir),
    binanceDeveloperMonitorEnabled: true,
    binanceDeveloperPollIntervalMs: 1_000,
  }, {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      return { status: "suppressed", reason: "not_relevant" };
    },
    logger: { error() {} },
  });

  await monitor.check();
  assert.equal(delivered.length, 0);
  stage = 1;
  current += 1_000;
  await monitor.check();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].kind, "developer_update");
  assert.equal(delivered[0].source.id, "binance_developer_docs");
  assert.deepEqual(delivered[0].keyChanges, ["Added a new Web3 API endpoint for KOL trade sharing."]);
  assert.deepEqual(delivered[0].addedSignals, ["Added a new Web3 API endpoint for KOL trade sharing."]);
  assert.deepEqual(delivered[0].removedSignals, []);
  assert.equal(delivered[0].comparisonBasis, "exact_snapshot");
  stage = 2;
  current += 1_000;
  await monitor.check();
  assert.equal(delivered.length, 2);
  assert.deepEqual(delivered[1].addedSignals, []);
  assert.deepEqual(delivered[1].removedSignals, ["Existing endpoint."]);
  assert.ok(delivered[1].changedFields.includes("signalDigest"));
  stage = 3;
  current += 1_000;
  await monitor.check();
  assert.equal(delivered.length, 2, "pure ordering changes are not product updates");
});

test("Agent Native bodies preserve material API facts and keep verified Agent OS reader fallback healthy", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  let current = Date.parse("2026-08-20T10:07:10Z");
  const delivered = [];
  const agenticUrl = BINANCE_DEVELOPER_DOC_URLS.find((url) => url.endsWith("/agent-native/mcp-server/agentic.md"));
  const releaseHeader = "Thu, 20 Aug 2026 10:06:51 GMT";
  const baseAgentic = "# Binance MCP Server\n\n## What your agent can access\n- Market data is public and requires no auth.";
  const materialFact = "Agent REST API POST /v1/orders now supports scoped Spot trade permission.";
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([item()]));
    if (url === BINANCE_AGENT_OS_PAGE_URL) {
      return textResponse("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
    }
    if (url === BINANCE_AGENT_OS_READER_URL) {
      return textResponse(verifiedAgentOsReaderBody(), {
        headers: { "last-modified": releaseHeader },
        url: BINANCE_AGENT_OS_READER_URL,
      });
    }
    if (BINANCE_DEVELOPER_DOC_URLS.includes(url)) {
      let text = "# Existing developer document\n- Existing endpoint.";
      if (url === agenticUrl) {
        text = stage === 0
          ? baseAgentic
          : stage === 1
            ? `${baseAgentic}\n- ${materialFact}`
            : `- **${materialFact.replace("Agent REST API", "Agent REST API")}**\n## What your agent can access\n- Market data is public and requires no auth.\n# Binance MCP Server`;
      }
      return textResponse(text, {
        headers: { "last-modified": stage ? releaseHeader : "Thu, 20 Aug 2026 10:00:00 GMT" },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor({
    ...monitorConfig(dataDir),
    binanceDeveloperMonitorEnabled: true,
    binanceDeveloperPollIntervalMs: 1_000,
  }, {
    autoStart: false,
    agentNativeDeveloperPagesPerCycle: 4,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    logger: { error() {} },
  });

  await monitor.check();
  assert.equal(delivered.length, 0, "new sources establish a silent baseline");
  stage = 1;
  current += 1_000;
  await monitor.check();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].source.id, "binance_developer_docs");
  assert.equal(delivered[0].source.url, agenticUrl);
  assert.equal(delivered[0].signal.category, "agent_native");
  assert.equal(delivered[0].strong, true);
  assert.deepEqual(delivered[0].keyChanges, [materialFact]);
  assert.equal(delivered[0].sourceOccurredAt, "2026-08-20T10:06:51.000Z");
  assert.equal(delivered[0].publishedAt, "2026-08-20T10:06:51.000Z");
  stage = 2;
  current += 1_000;
  await monitor.check();
  assert.equal(delivered.length, 1, "formatting and ordering changes do not alert");

  const state = JSON.parse(await fs.readFile(monitor.agentNativeStateFile, "utf8"));
  assert.equal(state.pages[agenticUrl].sourceOccurredAt, "2026-08-20T10:06:51.000Z");
  assert.equal(state.pages[BINANCE_AGENT_OS_PAGE_URL].retrievalMode, "verified_reader");
  assert.equal(state._health.agentOsPage.status, "healthy");
  assert.equal(state._health.agentOsPage.consecutiveFailures, 0);
  assert.equal(state._health.agentOsPage.activeSource, BINANCE_AGENT_OS_READER_URL);
  assert.equal(state._health.agentOsPage.fallbackActive, "verified_reader");
  assert.equal(state._health.agentOsPage.coverage.status, "verified_reader_fallback");
  assert.equal(state._health.agentOsPage.coverage.available, true);
  assert.equal(state._health.agentOsPage.sla.status, "degraded");
});

test("saturated Developer directory reports bounded additions without invented removals and survives Agent OS source failure", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  let current = Date.parse("2026-08-20T10:10:00Z");
  const delivered = [];
  const directoryUrl = BINANCE_DEVELOPER_DOC_URLS.find((url) => url.endsWith("/llms.txt"));
  const baseline = Array.from({ length: 1_200 }, (_, index) => `- [Document ${index}](/en/docs/products/doc-${index}.md)`);
  const agentAddition = "- [Binance MCP Server V2](/en/docs/agent-native/mcp-server/v2.md)";
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([item()]));
    if (url === BINANCE_AGENT_OS_PAGE_URL) {
      return textResponse("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
    }
    if (url === BINANCE_AGENT_OS_READER_URL) return textResponse("reader unavailable", { status: 503 });
    if (BINANCE_DEVELOPER_DOC_URLS.includes(url)) {
      const text = url === directoryUrl
        ? [...baseline, ...(stage ? [agentAddition] : [])].join("\n")
        : "# Existing developer document\n- Existing endpoint.";
      return textResponse(text, { headers: { "last-modified": "Thu, 20 Aug 2026 10:09:59 GMT" } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor({
    ...monitorConfig(dataDir),
    binanceDeveloperMonitorEnabled: true,
    binanceDeveloperPollIntervalMs: 1_000,
  }, {
    autoStart: false,
    agentNativeDeveloperPagesPerCycle: 4,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    logger: { error() {} },
  });

  await monitor.check();
  stage = 1;
  current += 1_000;
  await monitor.check();
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].addedSignals, ["Binance MCP Server V2 (/en/docs/agent-native/mcp-server/v2.md)"]);
  assert.deepEqual(delivered[0].removedSignals, []);
  assert.equal(delivered[0].signal.category, "agent_native");
  assert.equal(delivered[0].comparisonBasis, "bounded_additions_only");
  assert.equal(delivered[0].removalInferenceSuppressed, true);

  const state = JSON.parse(await fs.readFile(path.join(dataDir, "binance-state.json"), "utf8"));
  const fastState = JSON.parse(await fs.readFile(monitor.agentNativeStateFile, "utf8"));
  assert.equal(fastState.pages[directoryUrl].truncated, true);
  assert.equal(fastState.pages[directoryUrl].totalSignals, 1_201);
  assert.equal(state._health.developerDocs.status, "healthy");
  assert.equal(fastState._health.agentOsPage.status, "degraded");
  assert.equal(fastState._health.agentOsPage.fallbackActive, "binance_developer_docs");
  assert.equal(fastState.pages[BINANCE_AGENT_OS_PAGE_URL], undefined);
});

test("Agent Native fast lane completes a material endpoint alert within one shared five-second SLA without waiting for a slow sibling", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  let current = Date.parse("2026-08-20T11:00:00Z");
  let releaseSlow;
  let advanced = false;
  let runSettled = false;
  const delivered = [];
  const overviewUrl = BINANCE_DEVELOPER_DOC_URLS.find((url) => url.endsWith("/agent-native/overview.md"));
  const agenticUrl = BINANCE_DEVELOPER_DOC_URLS.find((url) => url.endsWith("/agent-native/mcp-server/agentic.md"));
  const baseAgentic = "# Binance MCP Server\n- Existing market-data permission.";
  const materialFact = "Agent REST API POST /v2/orders now enables scoped Spot trade permission.";
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
    if (url === BINANCE_AGENT_OS_PAGE_URL) {
      return textResponse("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
    }
    if (url === BINANCE_AGENT_OS_READER_URL) return textResponse(verifiedAgentOsReaderBody());
    if (BINANCE_DEVELOPER_DOC_URLS.includes(url)) {
      if (stage === 1 && url === overviewUrl) {
        return new Promise((resolve) => { releaseSlow = () => resolve(textResponse("# Existing developer document\n- Existing endpoint.")); });
      }
      if (stage === 1 && url === agenticUrl && !advanced) {
        advanced = true;
        current += 900;
      }
      const text = url === agenticUrl && stage
        ? `${baseAgentic}\n- ${materialFact}`
        : url === agenticUrl
          ? baseAgentic
          : "# Existing developer document\n- Existing endpoint.";
      return textResponse(text, {
        headers: { "last-modified": new Date(current).toUTCString() },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor({
    ...monitorConfig(dataDir),
    binanceDeveloperMonitorEnabled: true,
    binanceDeveloperPollIntervalMs: 1_000,
  }, {
    autoStart: false,
    agentNativePollIntervalMs: 1_000,
    agentNativeDeveloperPagesPerCycle: 4,
    agentNativeRequestTimeoutMs: 2_000,
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async (_config, event) => {
      current += 500;
      delivered.push({ event, completedAt: current });
    },
    logger: { error() {} },
  });

  await monitor.checkAgentNative();
  stage = 1;
  const becameVisibleAt = current + 1;
  current += monitor.agentNativePollIntervalMs;
  const pollStartedAt = current;
  const run = monitor.checkAgentNative().finally(() => { runSettled = true; });
  await waitUntil(() => delivered.length === 1);
  assert.equal(runSettled, false, "the intentionally slow overview request is still pending");
  assert.equal(delivered[0].event.fastLane, "agent_native");
  assert.equal(delivered[0].event.signal.category, "agent_native");
  assert.deepEqual(delivered[0].event.keyChanges, [materialFact]);
  assert.ok(delivered[0].completedAt - becameVisibleAt <= 5_000);
  assert.equal(delivered[0].event.deliverySla.startedAt, new Date(pollStartedAt).toISOString());
  assert.equal(delivered[0].event.deliverySla.deadlineAt, new Date(pollStartedAt + 4_000).toISOString());
  assert.equal(delivered[0].event.deliverySla.budgetMs, 5_000);
  assert.equal(delivered[0].event.deliverySla.pollAllowanceMs, 1_000);
  assert.equal(delivered[0].event.deliverySla.basis, "critical_source_poll");
  assert.ok(delivered[0].completedAt <= Date.parse(delivered[0].event.deliverySla.deadlineAt));
  assert.ok(monitor.agentNativeLocalDetectionBudgets.developerMs < 5_000);
  assert.ok(monitor.agentNativeLocalDetectionBudgetMs > 5_000, "the public Agent OS fallback is not falsely advertised as a hard five-second guarantee");
  releaseSlow();
  await run;
});

test("Agent Native fast lane immediately catches up when a tick lands behind a slow round", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  let current = Date.parse("2026-08-20T11:05:00Z");
  let releaseSlow;
  let agenticReadInSlowRound = false;
  let catchupAdvanced = false;
  const delivered = [];
  const overviewUrl = BINANCE_DEVELOPER_DOC_URLS.find((url) => url.endsWith("/agent-native/overview.md"));
  const agenticUrl = BINANCE_DEVELOPER_DOC_URLS.find((url) => url.endsWith("/agent-native/mcp-server/agentic.md"));
  const baseAgentic = "# Binance MCP Server\n- Existing market-data permission.";
  const materialFact = "MCP endpoint https://agent.binance.com/mcp/agentic/v2 now enables read-only portfolio scope.";
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
    if (url === BINANCE_AGENT_OS_PAGE_URL) {
      return textResponse("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
    }
    if (url === BINANCE_AGENT_OS_READER_URL) return textResponse(verifiedAgentOsReaderBody());
    if (BINANCE_DEVELOPER_DOC_URLS.includes(url)) {
      if (stage === 1 && url === overviewUrl) {
        return new Promise((resolve) => { releaseSlow = () => resolve(textResponse("# Existing developer document\n- Existing endpoint.")); });
      }
      if (stage === 1 && url === agenticUrl) agenticReadInSlowRound = true;
      if (stage === 2 && url === agenticUrl && !catchupAdvanced) {
        catchupAdvanced = true;
        current += 900;
      }
      const text = url === agenticUrl && stage === 2
        ? `${baseAgentic}\n- ${materialFact}`
        : url === agenticUrl
          ? baseAgentic
          : "# Existing developer document\n- Existing endpoint.";
      return textResponse(text, { headers: { "last-modified": new Date(current).toUTCString() } });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor({
    ...monitorConfig(dataDir),
    binanceDeveloperMonitorEnabled: true,
    binanceDeveloperPollIntervalMs: 1_000,
  }, {
    autoStart: false,
    agentNativePollIntervalMs: 1_000,
    agentNativeDeveloperPagesPerCycle: 4,
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async (_config, event) => {
      current += 500;
      delivered.push({ event, completedAt: current });
    },
    logger: { error() {} },
  });

  await monitor.checkAgentNative();
  stage = 1;
  current += 1_000;
  const active = monitor.checkAgentNative();
  await waitUntil(() => agenticReadInSlowRound && typeof releaseSlow === "function");
  stage = 2;
  const changedAt = current;
  current += 1_000;
  const catchupScheduledAt = current;
  const overlappingTick = monitor.checkAgentNative();
  releaseSlow();
  await Promise.all([active, overlappingTick]);
  assert.equal(delivered.length, 1, JSON.stringify(delivered.map(({ event }) => ({ url: event.url, keyChanges: event.keyChanges }))));
  assert.deepEqual(delivered[0].event.keyChanges, [materialFact]);
  assert.ok(delivered[0].completedAt - changedAt <= 5_000);
  assert.equal(delivered[0].event.deliverySla.startedAt, new Date(catchupScheduledAt).toISOString());
  assert.equal(delivered[0].event.deliverySla.pollAllowanceMs, 1_000);
  assert.ok(delivered[0].completedAt <= Date.parse(delivered[0].event.deliverySla.deadlineAt));
  assert.equal(delivered[0].event.fastLane, "agent_native");
});

test("Agent Native CMS fast lane sends a launch title immediately and ignores punctuation-only revisions", async (t) => {
  const dataDir = await fixture(t);
  let stage = 0;
  let current = Date.parse("2026-08-20T11:10:00Z");
  const delivered = [];
  const code = "abcdef0123456789abcdef0123456789";
  const cmsItems = () => stage === 0 ? [] : [article(
    code,
    stage === 1
      ? "Binance Launches Agent OS: MCP Server and Agent REST API"
      : "BINANCE launches Agent OS — MCP Server and Agent REST API!",
    current,
  )];
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements(cmsItems()));
    if (url === BINANCE_AGENT_OS_PAGE_URL) {
      return textResponse("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
    }
    if (url === BINANCE_AGENT_OS_READER_URL) return textResponse(verifiedAgentOsReaderBody());
    if (BINANCE_DEVELOPER_DOC_URLS.includes(url)) {
      return textResponse("# Existing developer document\n- Existing endpoint.", {
        headers: { "last-modified": new Date(current).toUTCString() },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor({
    ...monitorConfig(dataDir),
    binanceDeveloperMonitorEnabled: true,
    binanceDeveloperPollIntervalMs: 1_000,
  }, {
    autoStart: false,
    agentNativePollIntervalMs: 1_000,
    agentNativeCmsPollIntervalMs: 1_000,
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async (_config, event) => {
      current += 400;
      delivered.push({ event, completedAt: current });
    },
    logger: { error() {} },
  });

  await monitor.checkAgentNative();
  stage = 1;
  const cmsBecameVisibleAt = current + 1;
  current += 1_000;
  const cmsPollStartedAt = current;
  await monitor.checkAgentNative();
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].event.kind, "announcement");
  assert.equal(delivered[0].event.signal.category, "agent_native");
  assert.equal(delivered[0].event.strong, true);
  assert.equal(delivered[0].event.fastLane, "agent_native");
  assert.equal(delivered[0].event.publishedAt, new Date(cmsPollStartedAt).toISOString());
  assert.equal(delivered[0].event.deliverySla.startedAt, new Date(cmsPollStartedAt).toISOString());
  assert.equal(delivered[0].event.deliverySla.pollAllowanceMs, 1_000);
  assert.ok(delivered[0].completedAt - cmsBecameVisibleAt <= 5_000);
  assert.ok(delivered[0].completedAt <= Date.parse(delivered[0].event.deliverySla.deadlineAt));
  stage = 2;
  current += 1_000;
  await monitor.checkAgentNative();
  assert.equal(delivered.length, 1, "case and punctuation-only title edits are not product changes");
});

test("Agent Native source circuits persist Retry-After per URL without stalling healthy docs, reader, or CMS fallback", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-20T12:00:00Z");
  const requests = new Map();
  const logMessages = [];
  const limitedDoc = BINANCE_DEVELOPER_DOC_URLS.find((url) => url.endsWith("/agent-native/overview.md"));
  const primaryCms = BINANCE_ANNOUNCEMENT_URLS[0];
  const count = (url) => requests.set(url, Number(requests.get(url) || 0) + 1);
  const fetchImpl = async (url) => {
    count(url);
    if (url === limitedDoc) {
      return textResponse("rate limited", { status: 429, headers: { "retry-after": "120" } });
    }
    if (url === primaryCms) {
      return textResponse("rate limited", {
        status: 429,
        headers: { "retry-after": new Date(current + 120_000).toUTCString() },
      });
    }
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
    if (url === BINANCE_AGENT_OS_PAGE_URL) {
      return textResponse("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
    }
    if (url === BINANCE_AGENT_OS_READER_URL) {
      return textResponse(verifiedAgentOsReaderBody(), { url: BINANCE_AGENT_OS_READER_URL });
    }
    if (BINANCE_DEVELOPER_DOC_URLS.includes(url)) {
      return textResponse("# Binance MCP Server\n- Existing market data endpoint.", {
        headers: { etag: `\"${path.basename(url)}\"`, "last-modified": new Date(current).toUTCString() },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const config = {
    ...monitorConfig(dataDir),
    binanceDeveloperMonitorEnabled: true,
    binanceDeveloperPollIntervalMs: 1_000,
  };
  const dependencies = {
    autoStart: false,
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async () => {},
    logger: { error: (message) => logMessages.push(message) },
  };
  const monitor = createBinanceMonitor(config, dependencies);

  for (let second = 0; second < 120; second += 1) {
    await monitor.checkAgentNative();
    current += 1_000;
  }

  assert.equal(requests.get(limitedDoc), 1, "the limited Developer URL stays open-circuit for Retry-After");
  assert.equal(requests.get(primaryCms), 1, "the limited CMS hostname is not retried while its fallback remains healthy");
  assert.ok(Number(requests.get(BINANCE_ANNOUNCEMENT_URLS[1]) || 0) >= 39, "the healthy CMS fallback continues independently");
  assert.equal(requests.get(BINANCE_AGENT_OS_PAGE_URL), 1, "the canonical WAF URL is not retried every Agent OS tick");
  assert.ok(Number(requests.get(BINANCE_AGENT_OS_READER_URL) || 0) >= 23, "the verified reader continues behind the canonical WAF circuit");
  assert.ok(BINANCE_DEVELOPER_DOC_URLS.filter((url) => (
    (url.endsWith("/llms.txt") || url.includes("/agent-native/")) && url !== limitedDoc
  ))
    .every((url) => Number(requests.get(url) || 0) >= 30), "healthy Developer pages continue rotating");

  const state = JSON.parse(await fs.readFile(monitor.agentNativeStateFile, "utf8"));
  const checkpoint = JSON.parse(await fs.readFile(monitor.agentNativeCheckpointFile, "utf8"));
  assert.equal(checkpoint.version, 1);
  assert.deepEqual(Object.keys(checkpoint).sort(), ["revision", "scheduler", "updatedAt", "version"]);
  assert.equal("sourceControls" in checkpoint, false, "429/WAF circuits remain in the immediately durable main state only");
  assert.equal(state.sourceControls[limitedDoc].status, "rate_limited");
  assert.equal(state.sourceControls[limitedDoc].retryAfterMs, 120_000);
  assert.equal(state.sourceControls[primaryCms].status, "rate_limited");
  assert.equal(state.sourceControls[BINANCE_AGENT_OS_PAGE_URL].status, "waf_blocked");
  assert.equal(state._health.developerDocs.sourceRateLimited, true);
  assert.equal(state._health.developerDocs.slaUnavailable, false);
  assert.equal(state._health.developerDocs.coverage.status, "partial");
  assert.equal(state._health.developerDocs.coverage.available, true);
  assert.equal(state._health.developerDocs.sla.status, "degraded");
  assert.equal(state._health.lane.sourceRateLimited, true);
  assert.equal(state._health.lane.slaUnavailable, false);
  assert.equal(state._health.lane.coverage.status, "partial");
  assert.equal(state._health.lane.coverage.available, true);
  assert.equal(state._health.agentOsPage.status, "healthy");
  assert.equal(state._health.agentOsPage.coverage.status, "verified_reader_fallback");
  assert.equal(state._health.cms.slaUnavailable, false, "one healthy CMS hostname preserves CMS coverage");
  assert.equal(state._health.cms.coverage.status, "complete_via_mirror_fallback");
  for (const url of [limitedDoc, primaryCms, BINANCE_AGENT_OS_PAGE_URL]) {
    assert.equal(logMessages.filter((message) => message.includes(url)).length, 1, `${url} logs only its circuit transition`);
  }

  const requestsBeforeRestartedReader = Number(requests.get(limitedDoc) || 0);
  const restored = createBinanceMonitor(config, dependencies);
  await restored.checkAgentNative();
  assert.equal(requests.get(limitedDoc), requestsBeforeRestartedReader, "a new monitor instance honours the persisted circuit");
});

test("Agent Native low-request plan runs a simulated two minutes without tripping per-source rate thresholds", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-20T12:30:00Z");
  const requests = new Map();
  const lastRequestAt = new Map();
  const conditionalRequests = new Map();
  let rateLimitResponses = 0;
  const fetchImpl = async (url, options = {}) => {
    requests.set(url, Number(requests.get(url) || 0) + 1);
    const prior = lastRequestAt.get(url);
    const minimumSpacing = BINANCE_DEVELOPER_DOC_URLS.includes(url)
      ? 3_500
      : BINANCE_ANNOUNCEMENT_URLS.includes(url)
        ? 2_500
        : url === BINANCE_AGENT_OS_READER_URL
          ? 4_500
          : 0;
    if (Number.isFinite(prior) && current - prior < minimumSpacing) {
      rateLimitResponses += 1;
      return textResponse("rate limited", { status: 429, headers: { "retry-after": "60" } });
    }
    lastRequestAt.set(url, current);
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
    if (url === BINANCE_AGENT_OS_PAGE_URL) {
      return textResponse("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
    }
    if (url === BINANCE_AGENT_OS_READER_URL) {
      return textResponse(verifiedAgentOsReaderBody(), { url: BINANCE_AGENT_OS_READER_URL });
    }
    if (BINANCE_DEVELOPER_DOC_URLS.includes(url)) {
      const conditional = Boolean(options.headers?.["if-none-match"] || options.headers?.["if-modified-since"]);
      if (conditional) {
        conditionalRequests.set(url, Number(conditionalRequests.get(url) || 0) + 1);
        return textResponse("", { status: 304 });
      }
      return textResponse("# Binance MCP Server\n- Existing market data endpoint.", {
        headers: { etag: `\"${path.basename(url)}\"`, "last-modified": new Date(current).toUTCString() },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor({
    ...monitorConfig(dataDir),
    binanceDeveloperMonitorEnabled: true,
    binanceDeveloperPollIntervalMs: 1_000,
  }, {
    autoStart: false,
    fetchImpl,
    now: () => current,
    sendAlertsImpl: async () => {},
    logger: { error() {} },
  });

  for (let second = 0; second < 120; second += 1) {
    await monitor.checkAgentNative();
    current += 1_000;
  }

  const totalRequests = [...requests.values()].reduce((sum, value) => sum + value, 0);
  const previousFanoutRequests = 120 * (
    BINANCE_DEVELOPER_DOC_URLS.filter((url) => url.endsWith("/llms.txt") || url.includes("/agent-native/")).length
    + BINANCE_ANNOUNCEMENT_URLS.length
    + 2
  );
  assert.equal(rateLimitResponses, 0, "the configured rotation stays below every simulated public-source threshold for two minutes");
  assert.ok(previousFanoutRequests / totalRequests >= 5, `request reduction was ${previousFanoutRequests / totalRequests}x`);
  assert.ok(BINANCE_DEVELOPER_DOC_URLS.filter((url) => url.endsWith("/llms.txt") || url.includes("/agent-native/"))
    .every((url) => Number(conditionalRequests.get(url) || 0) >= 28), "body pages use conditional probes after their baseline");
  const state = JSON.parse(await fs.readFile(monitor.agentNativeStateFile, "utf8"));
  assert.equal(state._health.lane.sourceRateLimited, false);
  assert.equal(state._health.lane.slaUnavailable, false);
  assert.deepEqual(state._health.lane.requestPlan, {
    schedulerIntervalMs: 1_000,
    developerPagesPerCycle: 1,
    developerPageCount: 4,
    developerPerUrlCadenceMs: 4_000,
    cmsIntervalMs: 3_000,
    cmsRequestsPerProbe: 1,
    agentOsIntervalMs: 5_000,
    agentOsSteadyRequestsPerProbe: 1,
    conditionalRequests: true,
  });
});

test("overlapping Binance scheduler ticks coalesce into one immediate serial follow-up", async (t) => {
  const dataDir = await fixture(t);
  let announcementRequests = 0;
  let activeAnnouncements = 0;
  let maxActiveAnnouncements = 0;
  let releaseFirst;
  let releaseSecond;
  let signalStarted;
  let signalSecondStarted;
  const firstStarted = new Promise((resolve) => { signalStarted = resolve; });
  const secondStarted = new Promise((resolve) => { signalSecondStarted = resolve; });
  const firstRelease = new Promise((resolve) => { releaseFirst = resolve; });
  const secondRelease = new Promise((resolve) => { releaseSecond = resolve; });
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) {
      announcementRequests += 1;
      activeAnnouncements += 1;
      maxActiveAnnouncements = Math.max(maxActiveAnnouncements, activeAnnouncements);
      try {
        if (announcementRequests === 1) {
          signalStarted();
          await firstRelease;
        } else if (announcementRequests === 2) {
          signalSecondStarted();
          await secondRelease;
        }
        return ok(announcements([]));
      } finally {
        activeAnnouncements -= 1;
      }
    }
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([item()]));
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor(monitorConfig(dataDir), {
    autoStart: false,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
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

  assert.equal(announcementRequests, 2, "ticks during the catch-up are deferred to the next interval instead of creating an infinite drain");
  assert.equal(maxActiveAnnouncements, 1);
  await monitor.stop();
});

test("main Binance state coalesces steady telemetry while persisting health transitions immediately with 0600 atomic files", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-24T08:00:00Z");
  let announcementMode = "healthy";
  const timers = [];
  const writeAttempts = [];
  const mainStateFsImpl = instrumentedDurableFs({
    onWrite: ({ file, mode }) => writeAttempts.push({ file, mode }),
  });
  const setTimer = (callback, delay) => {
    const handle = { callback, delay, cleared: false, fired: false, unref() {} };
    timers.push(handle);
    return handle;
  };
  const clearTimer = (handle) => { if (handle) handle.cleared = true; };
  const activeTimer = () => [...timers].reverse().find((handle) => !handle.cleared && !handle.fired);
  const fetchImpl = async (url) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) {
      if (announcementMode === "rate_limited") return { ok: false, status: 429, text: async () => "rate limited" };
      return ok(announcements([]));
    }
    if (BINANCE_LAUNCHPOOL_URLS.includes(url)) return ok(launchpool([]));
    if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([]));
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor({
    dataDir,
    binanceAnnouncementPollIntervalMs: 1_000,
    binanceAnnouncementDetailPollIntervalMs: 60_000,
    binanceMemeRushPollIntervalMs: 60_000,
    binanceLaunchpoolPollIntervalMs: 1_000,
  }, {
    autoStart: false,
    now: () => current,
    memeRushTargets: [{ chainId: "56", rankType: 10 }],
    fetchImpl,
    sendAlertsImpl: async () => ({ status: "queued" }),
    mainStateTelemetryFlushMs: 120_000,
    mainStateSetTimeoutImpl: setTimer,
    mainStateClearTimeoutImpl: clearTimer,
    mainStateFsImpl,
    logger: { error() {} },
  });

  // The first two rounds durably establish baselines and one-time scheduling
  // cursors. The third round changes only checkedAt/latency-style health.
  await monitor.check();
  current += 1_000;
  await monitor.check();
  current += 1_000;
  const beforeSteadyRound = writeAttempts.length;
  await monitor.check();
  assert.equal(writeAttempts.length, beforeSteadyRound, "same-state health does not rewrite the multi-megabyte state every tick");
  const steadyTimer = activeTimer();
  assert.ok(steadyTimer);
  assert.equal(steadyTimer.delay, 60_000, "telemetry flush is capped at sixty seconds");

  steadyTimer.fired = true;
  steadyTimer.callback();
  await waitUntil(() => writeAttempts.length === beforeSteadyRound + 1);
  assert.ok(writeAttempts.every(({ file, mode }) => file.endsWith(".tmp") && mode === 0o600), "every atomic temporary is created as 0600");
  assert.equal((await fs.stat(monitor.stateFile)).mode & 0o777, 0o600, "the renamed final state remains 0600");

  announcementMode = "rate_limited";
  current += 1_000;
  const beforeFailure = writeAttempts.length;
  await monitor.check();
  assert.equal(writeAttempts.length, beforeFailure + 1, "healthy to HTTP 429 persists immediately");
  assert.equal(JSON.parse(await fs.readFile(monitor.stateFile, "utf8"))._health.announcements.status, "error");

  current += 1_000;
  const beforeRepeatedFailure = writeAttempts.length;
  await monitor.check();
  assert.equal(writeAttempts.length, beforeRepeatedFailure, "a repeated same-class error is telemetry-only");

  announcementMode = "healthy";
  current += 1_000;
  const beforeRecovery = writeAttempts.length;
  await monitor.check();
  assert.equal(writeAttempts.length, beforeRecovery + 1, "error recovery persists immediately");
  assert.equal(JSON.parse(await fs.readFile(monitor.stateFile, "utf8"))._health.announcements.status, "healthy");
  await monitor.stop();
});

test("Meme Rush commits its small scheduler checkpoint per round and resumes it after restart", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-24T09:00:00Z");
  const targets = [
    { chainId: "56", rankType: 10 },
    { chainId: "CT_501", rankType: 10 },
    { chainId: "8453", rankType: 10 },
    { chainId: "56", rankType: 20 },
  ];
  const targetKeys = targets.map(({ chainId, rankType }) => `${chainId}:${rankType}`);
  const healthy = (checkedAt) => ({ status: "healthy", checkedAt, lastSuccessAt: checkedAt, consecutiveFailures: 0 });
  const checkedAt = new Date(current).toISOString();
  const stateFile = path.join(dataDir, "binance-state.json");
  await fs.writeFile(stateFile, `${JSON.stringify({
    version: 2,
    announcements: { initializedAt: checkedAt, detailCheckedAt: checkedAt, articles: {} },
    square: { posts: {} },
    developerDocs: { pages: {} },
    memeRush: {
      initializedAt: checkedAt,
      baselinedTargets: targetKeys,
      protocols: {},
      versions: {},
      schemaKeys: [],
      versionCandidates: {},
      tokenIndex: {},
      targets: {},
      cursor: 0,
    },
    launchpool: { initializedAt: checkedAt, buckets: ["completed", "tracking"], assets: [], statuses: [], fields: [] },
    _health: {
      announcements: healthy(checkedAt),
      exchangeAnnouncements: healthy(checkedAt),
      walletAnnouncements: healthy(checkedAt),
      launchpool: healthy(checkedAt),
      memeRush: healthy(new Date(current - 5_000).toISOString()),
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const writes = [];
  const requests = [];
  const mainStateFsImpl = instrumentedDurableFs({
    onWrite: ({ file }) => writes.push(file),
  });
  const fetchImpl = async (url, options = {}) => {
    if (url !== BINANCE_MEME_RUSH_URL) throw new Error(`unexpected URL ${url}`);
    const body = JSON.parse(options.body);
    requests.push(`${body.chainId}:${body.rankType}`);
    return ok(memeRush([]));
  };
  const config = {
    dataDir,
    binanceAnnouncementPollIntervalMs: 60_000,
    binanceAnnouncementDetailPollIntervalMs: 60_000,
    binanceMemeRushPollIntervalMs: 5_000,
    binanceLaunchpoolPollIntervalMs: 60_000,
  };
  const dependencies = {
    autoStart: false,
    now: () => current,
    memeRushTargets: targets,
    fetchImpl,
    sendAlertsImpl: async () => ({ status: "queued" }),
    mainStateFsImpl,
    logger: { error() {} },
  };

  const firstMonitor = createBinanceMonitor(config, dependencies);
  const beforeFirstMainWrites = writes.filter((file) => file.includes("binance-state.json.")).length;
  const beforeFirstCheckpointWrites = writes.filter((file) => file.includes("binance-main-scheduler-checkpoint.json.")).length;
  await firstMonitor.check();
  assert.equal(writes.filter((file) => file.includes("binance-state.json.")).length, beforeFirstMainWrites, "a stable rank round does not rewrite the full state");
  assert.equal(writes.filter((file) => file.includes("binance-main-scheduler-checkpoint.json.")).length, beforeFirstCheckpointWrites + 1, "three successful targets share one small cursor write");
  assert.deepEqual(requests, targetKeys.slice(0, 3));
  assert.equal(JSON.parse(await fs.readFile(firstMonitor.mainSchedulerCheckpointFile, "utf8")).scheduler.memeRushCursor, 3);
  assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).memeRush.cursor, 0, "main retains the prior safe cursor until a coalesced flush");
  await firstMonitor.stop();
  const afterFirstStop = JSON.parse(await fs.readFile(stateFile, "utf8"));
  const afterFirstSidecar = JSON.parse(await fs.readFile(firstMonitor.mainSchedulerCheckpointFile, "utf8"));
  assert.equal(afterFirstStop.memeRush.cursor, 3, JSON.stringify({ scheduler: afterFirstStop.scheduler, sidecar: afterFirstSidecar, writes }));

  current += 5_000;
  requests.length = 0;
  const secondMonitor = createBinanceMonitor(config, dependencies);
  const beforeRestartMainWrites = writes.filter((file) => file.includes("binance-state.json.")).length;
  const beforeRestartCheckpointWrites = writes.filter((file) => file.includes("binance-main-scheduler-checkpoint.json.")).length;
  await secondMonitor.check();
  assert.equal(writes.filter((file) => file.includes("binance-state.json.")).length, beforeRestartMainWrites);
  assert.equal(writes.filter((file) => file.includes("binance-main-scheduler-checkpoint.json.")).length, beforeRestartCheckpointWrites + 1);
  assert.deepEqual(requests, [targetKeys[3], targetKeys[0], targetKeys[1]], "restart resumes from the persisted cursor");
  assert.equal(JSON.parse(await fs.readFile(secondMonitor.mainSchedulerCheckpointFile, "utf8")).scheduler.memeRushCursor, 2);
  await secondMonitor.stop();
  assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).memeRush.cursor, 2);
});

test("sixty seconds of static Meme Rush and announcement fixtures coalesce full-state writes while bounding the small checkpoint", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-24T09:30:00Z");
  const startedAt = new Date(current).toISOString();
  const targets = [
    { chainId: "56", rankType: 10 },
    { chainId: "CT_501", rankType: 10 },
    { chainId: "8453", rankType: 10 },
    { chainId: "56", rankType: 20 },
  ];
  const healthy = () => ({ status: "healthy", checkedAt: startedAt, lastSuccessAt: startedAt, consecutiveFailures: 0 });
  await fs.writeFile(path.join(dataDir, "binance-state.json"), `${JSON.stringify({
    version: 2,
    announcements: { initializedAt: startedAt, detailCheckedAt: startedAt, articles: {} },
    square: { posts: {} },
    developerDocs: { pages: {} },
    memeRush: {
      initializedAt: startedAt,
      baselinedTargets: targets.map(({ chainId, rankType }) => `${chainId}:${rankType}`).sort(),
      protocols: {},
      versions: {},
      schemaKeys: [],
      versionCandidates: {},
      tokenIndex: {},
      cursor: 0,
    },
    launchpool: { initializedAt: startedAt, buckets: ["completed", "tracking"], assets: [], statuses: [], fields: [] },
    _health: {
      announcements: healthy(),
      exchangeAnnouncements: healthy(),
      walletAnnouncements: healthy(),
      memeRush: healthy(),
      launchpool: healthy(),
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const timers = [];
  const attempts = [];
  const mainStateFsImpl = instrumentedDurableFs({
    onWrite: ({ file, value, mode }) => attempts.push({ file, bytes: Buffer.byteLength(value), mode }),
  });
  const setTimer = (callback, delay) => {
    const timer = { callback, delay, fired: false, cleared: false, unref() {} };
    timers.push(timer);
    return timer;
  };
  const monitor = createBinanceMonitor({
    dataDir,
    binanceAnnouncementPollIntervalMs: 5_000,
    binanceAnnouncementDetailPollIntervalMs: 10_000,
    binanceMemeRushPollIntervalMs: 5_000,
    binanceLaunchpoolPollIntervalMs: 120_000,
    binanceSquareMonitorEnabled: false,
    binanceDeveloperMonitorEnabled: false,
    binanceAnnouncementStreamEnabled: false,
  }, {
    autoStart: false,
    now: () => current,
    memeRushTargets: targets,
    fetchImpl: async (url) => {
      if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
      if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([]));
      throw new Error(`unexpected URL ${url}`);
    },
    sendAlertsImpl: async () => assert.fail("static fixtures must not alert"),
    mainStateTelemetryFlushMs: 120_000,
    mainStateSetTimeoutImpl: setTimer,
    mainStateClearTimeoutImpl: (timer) => { if (timer) timer.cleared = true; },
    mainStateFsImpl,
    logger: { error() {} },
  });

  for (let elapsed = 5_000; elapsed <= 60_000; elapsed += 5_000) {
    current = Date.parse("2026-08-24T09:30:00Z") + elapsed;
    await monitor.check();
  }
  const mainAttemptsBeforeFlush = attempts.filter(({ file }) => file.includes("binance-state.json."));
  const checkpointAttempts = attempts.filter(({ file }) => file.includes("binance-main-scheduler-checkpoint.json."));
  assert.equal(mainAttemptsBeforeFlush.length, 0, "steady business state does not rewrite the full file during the window");
  assert.ok(checkpointAttempts.length <= 18, `bounded scheduler writes: ${checkpointAttempts.length}`);
  assert.ok(checkpointAttempts.every(({ bytes, mode }) => bytes < 1_024 && mode === 0o600));
  const telemetryTimer = timers.find((timer) => !timer.cleared && !timer.fired);
  assert.ok(telemetryTimer);
  assert.equal(telemetryTimer.delay, 60_000);
  telemetryTimer.fired = true;
  telemetryTimer.callback();
  await waitUntil(() => attempts.filter(({ file }) => file.includes("binance-state.json.")).length === 1);
  await monitor.stop();
  assert.ok(attempts.filter(({ file }) => file.includes("binance-state.json.")).length <= 2);
  assert.equal((await fs.stat(monitor.stateFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(monitor.mainSchedulerCheckpointFile)).mode & 0o777, 0o600);
});

test("Binance main scheduler selection is monotonic and corrupt sidecars fall back to main", async (t) => {
  const targets = [
    { chainId: "56", rankType: 10 },
    { chainId: "CT_501", rankType: 10 },
    { chainId: "8453", rankType: 10 },
    { chainId: "56", rankType: 20 },
  ];
  const runCase = async ({ name, main, sidecar, expectedFirst, conflict = false }) => t.test(name, async (st) => {
    const dataDir = await fixture(st);
    let current = Date.parse("2026-08-24T10:00:05Z");
    const checkedAt = "2026-08-24T10:00:00.000Z";
    const healthy = () => ({ status: "healthy", checkedAt, lastSuccessAt: checkedAt, consecutiveFailures: 0 });
    await fs.writeFile(path.join(dataDir, "binance-state.json"), `${JSON.stringify({
      version: 2,
      announcements: { initializedAt: checkedAt, detailCheckedAt: checkedAt, articles: {} },
      square: { posts: {} },
      developerDocs: { pages: {} },
      scheduler: {
        memeRushCursor: main.cursor,
        announcementDetailCheckedAt: checkedAt,
        checkpointRevision: main.revision,
        checkpointUpdatedAt: main.updatedAt,
      },
      memeRush: {
        initializedAt: checkedAt,
        baselinedTargets: targets.map(({ chainId, rankType }) => `${chainId}:${rankType}`),
        protocols: {}, versions: {}, schemaKeys: [], versionCandidates: {}, tokenIndex: {}, cursor: main.cursor,
      },
      launchpool: { initializedAt: checkedAt },
      _health: {
        announcements: healthy(), exchangeAnnouncements: healthy(), walletAnnouncements: healthy(),
        memeRush: healthy(), launchpool: healthy(),
      },
    }, null, 2)}\n`, { mode: 0o600 });
    const sidecarFile = path.join(dataDir, "binance-main-scheduler-checkpoint.json");
    if (typeof sidecar === "string") await fs.writeFile(sidecarFile, sidecar, { mode: 0o600 });
    else if (sidecar) await fs.writeFile(sidecarFile, `${JSON.stringify({
      version: 1,
      revision: sidecar.revision,
      updatedAt: sidecar.updatedAt,
      scheduler: { memeRushCursor: sidecar.cursor, announcementDetailCheckedAt: checkedAt },
    }, null, 2)}\n`, { mode: 0o600 });
    const requests = [];
    const logs = [];
    const monitor = createBinanceMonitor({
      dataDir,
      binanceAnnouncementPollIntervalMs: 60_000,
      binanceAnnouncementDetailPollIntervalMs: 60_000,
      binanceMemeRushPollIntervalMs: 5_000,
      binanceLaunchpoolPollIntervalMs: 60_000,
      binanceDeveloperMonitorEnabled: false,
    }, {
      autoStart: false,
      now: () => current,
      memeRushTargets: targets,
      fetchImpl: async (url, options = {}) => {
        if (url !== BINANCE_MEME_RUSH_URL) throw new Error(`unexpected URL ${url}`);
        const body = JSON.parse(options.body);
        requests.push(`${body.chainId}:${body.rankType}`);
        return ok(memeRush([]));
      },
      sendAlertsImpl: async () => assert.fail("checkpoint selection must not alert"),
      logger: { error: (message) => logs.push(message) },
    });
    await monitor.check();
    if (conflict) {
      assert.equal(requests.length, 0, "a tied but divergent checkpoint fails closed before polling");
      assert.ok(logs.some((message) => message.includes("checkpoint conflict")));
    } else assert.equal(requests[0], expectedFirst);
    current += 1;
    await monitor.stop();
  });

  await runCase({
    name: "higher main revision wins over a newer sidecar timestamp",
    main: { revision: 5, updatedAt: "2026-08-24T09:59:00.000Z", cursor: 2 },
    sidecar: { revision: 4, updatedAt: "2026-08-24T10:00:00.000Z", cursor: 1 },
    expectedFirst: "8453:10",
  });
  await runCase({
    name: "higher sidecar revision wins over an older timestamp",
    main: { revision: 5, updatedAt: "2026-08-24T10:00:00.000Z", cursor: 1 },
    sidecar: { revision: 6, updatedAt: "2026-08-24T09:59:00.000Z", cursor: 3 },
    expectedFirst: "56:20",
  });
  await runCase({
    name: "newer main timestamp wins at the same revision",
    main: { revision: 6, updatedAt: "2026-08-24T10:00:00.000Z", cursor: 2 },
    sidecar: { revision: 6, updatedAt: "2026-08-24T09:59:00.000Z", cursor: 1 },
    expectedFirst: "8453:10",
  });
  await runCase({
    name: "newer sidecar timestamp wins at the same revision",
    main: { revision: 6, updatedAt: "2026-08-24T09:59:00.000Z", cursor: 1 },
    sidecar: { revision: 6, updatedAt: "2026-08-24T10:00:00.000Z", cursor: 3 },
    expectedFirst: "56:20",
  });
  await runCase({
    name: "same revision and timestamp with divergent payload fails closed",
    main: { revision: 8, updatedAt: "2026-08-24T10:00:00.000Z", cursor: 1 },
    sidecar: { revision: 8, updatedAt: "2026-08-24T10:00:00.000Z", cursor: 3 },
    conflict: true,
  });
  await runCase({
    name: "invalid high-revision main metadata cannot outrank a valid sidecar",
    main: { revision: 99, updatedAt: "not-an-iso-time", cursor: 1 },
    sidecar: { revision: 1, updatedAt: "2026-08-24T10:00:00.000Z", cursor: 3 },
    expectedFirst: "56:20",
  });
  await runCase({
    name: "corrupt sidecar safely uses the main checkpoint",
    main: { revision: 7, updatedAt: "2026-08-24T10:00:00.000Z", cursor: 1 },
    sidecar: "{\"version\":999,\"revision\":99}",
    expectedFirst: "CT_501:10",
  });
});

test("Binance main and scheduler checkpoints fsync every atomic replacement and tighten existing files to 0600", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.parse("2026-08-24T10:20:05Z");
  const checkedAt = new Date(current - 5_000).toISOString();
  const targets = [
    { chainId: "56", rankType: 10 },
    { chainId: "CT_501", rankType: 10 },
    { chainId: "8453", rankType: 10 },
    { chainId: "56", rankType: 20 },
  ];
  const stateFile = path.join(dataDir, "binance-state.json");
  const checkpointFile = path.join(dataDir, "binance-main-scheduler-checkpoint.json");
  await fs.writeFile(stateFile, `${JSON.stringify(schedulerTestState(checkedAt, targets), null, 2)}\n`, { mode: 0o644 });
  await fs.writeFile(checkpointFile, `${JSON.stringify({
    version: 1,
    revision: 0,
    updatedAt: checkedAt,
    scheduler: { memeRushCursor: 0, announcementDetailCheckedAt: checkedAt },
  }, null, 2)}\n`, { mode: 0o644 });

  let lastRenameTarget = null;
  const fileSyncs = { main: 0, checkpoint: 0 };
  const directorySyncs = { main: 0, checkpoint: 0 };
  const kindFor = (target) => String(target).includes("binance-main-scheduler-checkpoint.json") ? "checkpoint" : "main";
  const mainStateFsImpl = instrumentedDurableFs({
    renameImpl: async (temporary, target) => {
      await fs.rename(temporary, target);
      lastRenameTarget = String(target);
    },
    onSync: ({ target }) => {
      if (path.resolve(target) === path.resolve(dataDir)) directorySyncs[kindFor(lastRenameTarget)] += 1;
      else fileSyncs[kindFor(target)] += 1;
    },
  });
  const monitor = createBinanceMonitor({
    dataDir,
    binanceAnnouncementPollIntervalMs: 60_000,
    binanceAnnouncementDetailPollIntervalMs: 60_000,
    binanceMemeRushPollIntervalMs: 5_000,
    binanceLaunchpoolPollIntervalMs: 60_000,
    binanceDeveloperMonitorEnabled: false,
  }, {
    autoStart: false,
    now: () => current,
    memeRushTargets: targets,
    fetchImpl: async (url) => {
      if (url === BINANCE_MEME_RUSH_URL) return ok(memeRush([]));
      throw new Error(`unexpected URL ${url}`);
    },
    sendAlertsImpl: async () => assert.fail("stable fixtures must not alert"),
    mainStateFsImpl,
    logger: { error() {} },
  });

  await monitor.check();
  assert.equal(fileSyncs.checkpoint, 1, "the complete sidecar temp file is fsynced before rename");
  assert.equal(directorySyncs.checkpoint, 1, "the sidecar rename is committed by a parent-directory fsync");
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(checkpointFile)).mode & 0o777, 0o600);
  await monitor.stop();
  assert.ok(fileSyncs.main >= 1, "the final main-state absorption fsyncs its temp file");
  assert.ok(directorySyncs.main >= 1, "the final main-state absorption fsyncs the parent directory");
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(checkpointFile)).mode & 0o777, 0o600);
});

test("a scheduler directory-fsync failure keeps the old cursor authoritative until a confirmed retry", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-24T10:30:05Z");
  const checkedAt = new Date(current - 5_000).toISOString();
  const targets = [
    { chainId: "56", rankType: 10 },
    { chainId: "CT_501", rankType: 10 },
    { chainId: "8453", rankType: 10 },
    { chainId: "56", rankType: 20 },
  ];
  const stateFile = path.join(dataDir, "binance-state.json");
  await fs.writeFile(stateFile, `${JSON.stringify(schedulerTestState(checkedAt, targets), null, 2)}\n`, { mode: 0o600 });
  let lastRenameTarget = null;
  let failCheckpointDirectorySync = true;
  const mainStateFsImpl = instrumentedDurableFs({
    renameImpl: async (temporary, target) => {
      await fs.rename(temporary, target);
      lastRenameTarget = String(target);
    },
    onSync: ({ target }) => {
      if (path.resolve(target) === path.resolve(dataDir)
        && lastRenameTarget?.endsWith("binance-main-scheduler-checkpoint.json")
        && failCheckpointDirectorySync) {
        failCheckpointDirectorySync = false;
        throw new Error("simulated scheduler directory fsync failure");
      }
    },
  });
  const requests = [];
  const monitor = createBinanceMonitor({
    dataDir,
    binanceAnnouncementPollIntervalMs: 60_000,
    binanceAnnouncementDetailPollIntervalMs: 60_000,
    binanceMemeRushPollIntervalMs: 5_000,
    binanceLaunchpoolPollIntervalMs: 60_000,
    binanceDeveloperMonitorEnabled: false,
  }, {
    autoStart: false,
    now: () => current,
    memeRushTargets: targets,
    fetchImpl: async (url, options = {}) => {
      if (url !== BINANCE_MEME_RUSH_URL) throw new Error(`unexpected URL ${url}`);
      const body = JSON.parse(options.body);
      requests.push(`${body.chainId}:${body.rankType}`);
      return ok(memeRush([]));
    },
    sendAlertsImpl: async () => assert.fail("stable fixtures must not alert"),
    mainStateFsImpl,
    logger: { error() {} },
  });

  await monitor.check();
  assert.deepEqual(requests, ["56:10", "CT_501:10", "8453:10"]);
  assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8")).memeRush.cursor, 0);
  assert.equal(JSON.parse(await fs.readFile(monitor.mainSchedulerCheckpointFile, "utf8")).scheduler.memeRushCursor, 3,
    "the rename may be visible but is not treated as durable without the directory barrier");

  current += 5_000;
  requests.length = 0;
  await monitor.check();
  assert.deepEqual(requests, ["56:10", "CT_501:10", "8453:10"], "the same monitor safely re-fetches from the old cursor");
  assert.equal(JSON.parse(await fs.readFile(monitor.mainSchedulerCheckpointFile, "utf8")).scheduler.memeRushCursor, 3);
  await monitor.stop();
});

test("a transient final main directory barrier failure can be retried by a second idempotent stop", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.parse("2026-08-24T10:40:01Z");
  const checkedAt = new Date(current - 1_000).toISOString();
  const targets = [{ chainId: "56", rankType: 10 }];
  const stateFile = path.join(dataDir, "binance-state.json");
  await fs.writeFile(stateFile, `${JSON.stringify(schedulerTestState(checkedAt, targets), null, 2)}\n`, { mode: 0o600 });
  let lastRenameTarget = null;
  let failNextMainDirectorySync = false;
  let mainDirectorySyncAttempts = 0;
  const mainStateFsImpl = instrumentedDurableFs({
    renameImpl: async (temporary, target) => {
      await fs.rename(temporary, target);
      lastRenameTarget = String(target);
    },
    onSync: ({ target }) => {
      if (path.resolve(target) !== path.resolve(dataDir) || !lastRenameTarget?.endsWith("binance-state.json")) return;
      mainDirectorySyncAttempts += 1;
      if (failNextMainDirectorySync) {
        failNextMainDirectorySync = false;
        throw new Error("simulated final main directory fsync failure");
      }
    },
  });
  let announcementRequests = 0;
  const monitor = createBinanceMonitor({
    dataDir,
    binanceAnnouncementPollIntervalMs: 1_000,
    binanceAnnouncementDetailPollIntervalMs: 60_000,
    binanceMemeRushPollIntervalMs: 60_000,
    binanceLaunchpoolPollIntervalMs: 60_000,
    binanceDeveloperMonitorEnabled: false,
  }, {
    autoStart: false,
    now: () => current,
    memeRushTargets: targets,
    fetchImpl: async (url) => {
      if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) {
        announcementRequests += 1;
        return ok(announcements([]));
      }
      throw new Error(`unexpected URL ${url}`);
    },
    sendAlertsImpl: async () => ({ status: "queued" }),
    mainStateFsImpl,
    logger: { error() {} },
  });

  await monitor.check();
  failNextMainDirectorySync = true;
  await assert.rejects(() => monitor.stop(), /simulated final main directory fsync failure/);
  const requestsAfterFailedStop = announcementRequests;
  await monitor.check();
  assert.equal(announcementRequests, requestsAfterFailedStop, "a failed stop never restores polling");
  const retry = monitor.stop();
  await retry;
  assert.equal(monitor.stop(), retry, "the successful retry remains the idempotent stop boundary");
  assert.equal(mainDirectorySyncAttempts, 2);
  assert.equal((await fs.stat(stateFile)).mode & 0o777, 0o600);
});

test("a chmod failure on an existing scheduler sidecar fails closed before polling", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.parse("2026-08-24T10:50:05Z");
  const checkedAt = new Date(current - 5_000).toISOString();
  const targets = [
    { chainId: "56", rankType: 10 },
    { chainId: "CT_501", rankType: 10 },
    { chainId: "8453", rankType: 10 },
    { chainId: "56", rankType: 20 },
  ];
  const stateFile = path.join(dataDir, "binance-state.json");
  const checkpointFile = path.join(dataDir, "binance-main-scheduler-checkpoint.json");
  await fs.writeFile(stateFile, `${JSON.stringify(schedulerTestState(checkedAt, targets), null, 2)}\n`, { mode: 0o600 });
  await fs.writeFile(checkpointFile, `${JSON.stringify({
    version: 1, revision: 0, updatedAt: checkedAt,
    scheduler: { memeRushCursor: 0, announcementDetailCheckedAt: checkedAt },
  })}\n`, { mode: 0o644 });
  const blockedFs = instrumentedDurableFs();
  blockedFs.chmod = async (target, mode) => {
    if (path.resolve(String(target)) === path.resolve(checkpointFile)) {
      throw Object.assign(new Error("simulated scheduler chmod failure"), { code: "EACCES" });
    }
    return fs.chmod(target, mode);
  };
  const requests = [];
  const logs = [];
  const monitor = createBinanceMonitor({
    dataDir,
    binanceMemeRushPollIntervalMs: 5_000,
    binanceAnnouncementPollIntervalMs: 60_000,
    binanceLaunchpoolPollIntervalMs: 60_000,
    binanceDeveloperMonitorEnabled: false,
  }, {
    autoStart: false,
    now: () => current,
    memeRushTargets: targets,
    mainStateFsImpl: blockedFs,
    fetchImpl: async (url) => { requests.push(url); return ok(memeRush([])); },
    sendAlertsImpl: async () => ({ status: "queued" }),
    logger: { error: (message) => logs.push(message) },
  });

  await monitor.check();
  assert.equal(requests.length, 0);
  assert.ok(logs.some((message) => message.includes("simulated scheduler chmod failure")));
  await monitor.stop();
});

test("a Binance main scheduler rename failure safely re-fetches without replaying a durable Meme Rush alert", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-24T10:30:05Z");
  const checkedAt = "2026-08-24T10:30:00.000Z";
  const targets = [
    { chainId: "56", rankType: 10 },
    { chainId: "CT_501", rankType: 10 },
    { chainId: "8453", rankType: 10 },
    { chainId: "56", rankType: 20 },
  ];
  const healthy = () => ({ status: "healthy", checkedAt, lastSuccessAt: checkedAt, consecutiveFailures: 0 });
  await fs.writeFile(path.join(dataDir, "binance-state.json"), `${JSON.stringify({
    version: 2,
    announcements: { initializedAt: checkedAt, detailCheckedAt: checkedAt, articles: {} },
    square: { posts: {} },
    developerDocs: { pages: {} },
    scheduler: {
      memeRushCursor: 0,
      announcementDetailCheckedAt: checkedAt,
      checkpointRevision: 0,
      checkpointUpdatedAt: checkedAt,
    },
    memeRush: {
      initializedAt: checkedAt,
      baselinedTargets: targets.map(({ chainId, rankType }) => `${chainId}:${rankType}`),
      protocols: {}, versions: {}, schemaKeys: ["protocol", "tokenVersion"], versionCandidates: {}, tokenIndex: {}, cursor: 0,
    },
    launchpool: { initializedAt: checkedAt },
    _health: {
      announcements: healthy(), exchangeAnnouncements: healthy(), walletAnnouncements: healthy(),
      memeRush: healthy(), launchpool: healthy(),
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const delivered = [];
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    if (url !== BINANCE_MEME_RUSH_URL) throw new Error(`unexpected URL ${url}`);
    const body = JSON.parse(options.body);
    requests.push(`${body.chainId}:${body.rankType}`);
    return ok(memeRush(body.chainId === "56" && body.rankType === 10 ? [
      item({ protocol: 2099, version: "v2", contract: "0x9999999999999999999999999999999999999991" }),
      item({ protocol: 2099, version: "v2", contract: "0x9999999999999999999999999999999999999992" }),
    ] : []));
  };
  const config = {
    dataDir,
    binanceAnnouncementPollIntervalMs: 60_000,
    binanceAnnouncementDetailPollIntervalMs: 60_000,
    binanceMemeRushPollIntervalMs: 5_000,
    binanceLaunchpoolPollIntervalMs: 60_000,
    binanceDeveloperMonitorEnabled: false,
  };
  const shared = {
    autoStart: false,
    now: () => current,
    memeRushTargets: targets,
    fetchImpl,
    sendAlertsImpl: async (_config, event) => {
      delivered.push(event);
      return { status: "queued" };
    },
    logger: { error() {} },
  };
  const failingMonitor = createBinanceMonitor(config, {
    ...shared,
    mainSchedulerCheckpointAtomicWriteImpl: async () => {
      throw Object.assign(new Error("simulated main scheduler rename failure"), { code: "EIO" });
    },
  });
  await failingMonitor.check();
  const afterFailure = JSON.parse(await fs.readFile(failingMonitor.stateFile, "utf8"));
  assert.ok(afterFailure.memeRush.protocols["56:2099"]);
  assert.ok(afterFailure.memeRush.versions["56:2099:v2"]);
  assert.equal(afterFailure.memeRush.cursor, 0, "failed checkpoint cannot advance the main fallback cursor");
  await assert.rejects(fs.readFile(failingMonitor.mainSchedulerCheckpointFile, "utf8"), { code: "ENOENT" });
  await failingMonitor.stop();

  current += 5_000;
  requests.length = 0;
  const restartedMonitor = createBinanceMonitor(config, shared);
  await restartedMonitor.check();
  assert.deepEqual(requests.slice(0, 3), ["56:10", "CT_501:10", "8453:10"], "restart safely re-fetches the old cursor");
  assert.equal(delivered.length, 1, "durable protocol/version evidence prevents alert replay");
  assert.equal(JSON.parse(await fs.readFile(restartedMonitor.mainSchedulerCheckpointFile, "utf8")).scheduler.memeRushCursor, 3);
  await restartedMonitor.stop();
});

test("a failed telemetry atomic rename retries while a same-timestamp durable health transition wins", async (t) => {
  const dataDir = await fixture(t);
  const current = Date.parse("2026-08-24T10:00:00Z");
  const priorCheckedAt = new Date(current - 1_000).toISOString();
  const nowValue = new Date(current).toISOString();
  const healthy = (checkedAt) => ({ status: "healthy", checkedAt, lastSuccessAt: checkedAt, consecutiveFailures: 0 });
  const stateFile = path.join(dataDir, "binance-state.json");
  await fs.writeFile(stateFile, `${JSON.stringify({
    version: 2,
    announcements: { initializedAt: nowValue, detailCheckedAt: nowValue, articles: {} },
    square: { posts: {} },
    developerDocs: { pages: {} },
    memeRush: { baselinedTargets: [], protocols: {}, versions: {}, schemaKeys: [], versionCandidates: {}, tokenIndex: {}, cursor: 0 },
    launchpool: { initializedAt: nowValue, buckets: ["completed", "tracking"], assets: [], statuses: [], fields: [] },
    _health: {
      announcements: healthy(priorCheckedAt),
      exchangeAnnouncements: healthy(priorCheckedAt),
      walletAnnouncements: healthy(priorCheckedAt),
      launchpool: healthy(nowValue),
      memeRush: healthy(nowValue),
    },
  }, null, 2)}\n`, { mode: 0o600 });

  const timers = [];
  let renameAttempts = 0;
  const mainStateFsImpl = instrumentedDurableFs({
    renameImpl: async (...args) => {
      renameAttempts += 1;
      if (renameAttempts === 1) throw Object.assign(new Error("simulated atomic rename failure"), { code: "EIO" });
      return fs.rename(...args);
    },
  });
  const setTimer = (callback, delay) => {
    const handle = { callback, delay, cleared: false, fired: false, unref() {} };
    timers.push(handle);
    return handle;
  };
  const clearTimer = (handle) => { if (handle) handle.cleared = true; };
  const nextTimer = () => [...timers].reverse().find((handle) => !handle.cleared && !handle.fired);
  const monitor = createBinanceMonitor({
    dataDir,
    binanceAnnouncementPollIntervalMs: 1_000,
    binanceAnnouncementDetailPollIntervalMs: 60_000,
    binanceMemeRushPollIntervalMs: 60_000,
    binanceLaunchpoolPollIntervalMs: 60_000,
  }, {
    autoStart: false,
    now: () => current,
    fetchImpl: async (url) => {
      if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
      throw new Error(`unexpected URL ${url}`);
    },
    sendAlertsImpl: async () => ({ status: "queued" }),
    mainStateTelemetryFlushMs: 1_000,
    mainStateSetTimeoutImpl: setTimer,
    mainStateClearTimeoutImpl: clearTimer,
    mainStateFsImpl,
    logger: { error() {} },
  });

  await monitor.check();
  assert.equal(renameAttempts, 0, "same-state health stays pending until the telemetry timer");
  const durableState = JSON.parse(await fs.readFile(stateFile, "utf8"));
  durableState._health.announcements = {
    status: "error",
    checkedAt: nowValue,
    lastErrorAt: nowValue,
    lastError: "HTTP 429 rate limited",
    consecutiveFailures: 1,
  };
  await fs.writeFile(stateFile, `${JSON.stringify(durableState, null, 2)}\n`, { mode: 0o600 });
  const firstTimer = nextTimer();
  firstTimer.fired = true;
  firstTimer.callback();
  await waitUntil(() => renameAttempts === 1 && Boolean(nextTimer()));
  assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8"))._health.announcements.status, "error");
  assert.equal((await fs.readdir(dataDir)).some((name) => name.endsWith(".tmp")), false, "failed atomic temporary is cleaned up");

  const retryTimer = nextTimer();
  retryTimer.fired = true;
  retryTimer.callback();
  await waitUntil(async () => renameAttempts === 2
    && JSON.parse(await fs.readFile(stateFile, "utf8"))._health.announcements.status === "error");
  assert.equal(JSON.parse(await fs.readFile(stateFile, "utf8"))._health.announcements.checkedAt, nowValue);
  await monitor.stop();
});

test("Agent Native stable ticks write only the small checkpoint and coalesce the full state to one thirty-second flush", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-24T11:00:00Z");
  const timers = [];
  const pendingFiles = new Map();
  const mainWrites = [];
  const checkpointWrites = [];
  const mainAttempts = [];
  let failNextMainRename = false;
  const setTimer = (callback, delay) => {
    const handle = { callback, delay, cleared: false, fired: false, unref() {} };
    timers.push(handle);
    return handle;
  };
  const clearTimer = (handle) => { if (handle) handle.cleared = true; };
  const activeTimer = () => [...timers].reverse().find((handle) => !handle.cleared && !handle.fired);
  const agentNativeStateFsImpl = instrumentedDurableFs({
    onWrite: ({ file, value, mode }) => {
      const record = { bytes: Buffer.byteLength(value), mode };
      pendingFiles.set(file, record);
      if (file.includes("binance-agent-native-state.json.")) mainAttempts.push(record);
    },
    renameImpl: async (temporary, target) => {
      const record = pendingFiles.get(String(temporary));
      if (String(target).endsWith("binance-agent-native-state.json") && failNextMainRename) {
        failNextMainRename = false;
        throw Object.assign(new Error("simulated Agent Native telemetry rename failure"), { code: "EIO" });
      }
      await fs.rename(temporary, target);
      if (String(target).endsWith("binance-agent-native-state.json")) mainWrites.push(record);
      if (String(target).endsWith("binance-agent-native-checkpoint.json")) checkpointWrites.push(record);
      pendingFiles.delete(String(temporary));
    },
    rmImpl: async (file, options) => {
      pendingFiles.delete(String(file));
      return fs.rm(file, options);
    },
  });
  const fetchImpl = async (url, options = {}) => {
    if (BINANCE_ANNOUNCEMENT_URLS.includes(url)) return ok(announcements([]));
    if (url === BINANCE_AGENT_OS_PAGE_URL) {
      return textResponse("", { status: 202, headers: { "x-amzn-waf-action": "challenge" } });
    }
    if (url === BINANCE_AGENT_OS_READER_URL) {
      return textResponse(verifiedAgentOsReaderBody(), { url: BINANCE_AGENT_OS_READER_URL });
    }
    if (BINANCE_DEVELOPER_DOC_URLS.includes(url)) {
      if (options.headers?.["if-none-match"] || options.headers?.["if-modified-since"]) return textResponse("", { status: 304 });
      return textResponse("# Binance MCP Server\n- Existing market data endpoint.", {
        headers: { etag: `"${path.basename(url)}"`, "last-modified": new Date(current).toUTCString() },
      });
    }
    throw new Error(`unexpected URL ${url}`);
  };
  const monitor = createBinanceMonitor({
    ...monitorConfig(dataDir),
    binanceDeveloperMonitorEnabled: true,
    binanceDeveloperPollIntervalMs: 1_000,
  }, {
    autoStart: false,
    now: () => current,
    fetchImpl,
    sendAlertsImpl: async () => assert.fail("stable Agent Native telemetry must not alert"),
    agentNativeTelemetryFlushMs: 60_000,
    agentNativeTelemetrySetTimeoutImpl: setTimer,
    agentNativeTelemetryClearTimeoutImpl: clearTimer,
    agentNativeStateFsImpl,
    logger: { error() {} },
  });

  for (let second = 0; second < 20; second += 1) {
    await monitor.checkAgentNative();
    current += 1_000;
  }
  const warmupTimer = activeTimer();
  assert.ok(warmupTimer, "warmup ends with one pending telemetry flush");
  const beforeWarmupFlush = mainWrites.length;
  warmupTimer.fired = true;
  warmupTimer.callback();
  await waitUntil(() => mainWrites.length === beforeWarmupFlush + 1);

  const fullWritesBeforeSteadyWindow = mainWrites.length;
  const checkpointsBeforeSteadyWindow = checkpointWrites.length;
  for (let second = 0; second < 20; second += 1) {
    await monitor.checkAgentNative();
    current += 1_000;
  }
  assert.equal(mainWrites.length, fullWritesBeforeSteadyWindow, "twenty stable one-second ticks do not rewrite the full state");
  assert.ok(checkpointWrites.length >= checkpointsBeforeSteadyWindow + 20, "each rotating cursor is immediately durable in the small sidecar");
  assert.ok(checkpointWrites.slice(checkpointsBeforeSteadyWindow).every(({ bytes, mode }) => bytes < 2_048 && mode === 0o600));
  const telemetryTimer = activeTimer();
  assert.ok(telemetryTimer);
  assert.equal(telemetryTimer.delay, 30_000, "the full-state telemetry window is capped at thirty seconds");

  const attemptsBeforeFailure = mainAttempts.length;
  failNextMainRename = true;
  telemetryTimer.fired = true;
  telemetryTimer.callback();
  await waitUntil(() => mainAttempts.length === attemptsBeforeFailure + 1 && Boolean(activeTimer()));
  assert.equal(mainWrites.length, fullWritesBeforeSteadyWindow, "a failed telemetry rename is not reported as durable");
  const retryTimer = activeTimer();
  retryTimer.fired = true;
  retryTimer.callback();
  await waitUntil(() => mainWrites.length === fullWritesBeforeSteadyWindow + 1);
  assert.equal((await fs.stat(monitor.agentNativeStateFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(monitor.agentNativeCheckpointFile)).mode & 0o777, 0o600);
  assert.equal((await fs.readdir(dataDir)).some((name) => name.endsWith(".tmp")), false);
  await monitor.stop();
});

test("Agent Native checkpoint selection is monotonic across main/sidecar versions and rejects corrupt sidecars", async (t) => {
  const current = Date.parse("2026-08-24T12:00:00Z");
  const nowValue = new Date(current).toISOString();
  const oldProbeAt = new Date(current - 10_000).toISOString();
  const cases = [
    {
      name: "higher main revision wins even when its timestamp is older",
      mainVersion: 2,
      mainCursor: 1,
      mainRevision: 6,
      mainUpdatedAt: new Date(current - 5_000).toISOString(),
      sidecar: { version: 1, revision: 5, updatedAt: new Date(current - 1_000).toISOString(), scheduler: { developerCursor: 3, agentOsLastProbeAt: oldProbeAt, cmsLastProbeAt: oldProbeAt } },
      expectedCursor: 1,
    },
    {
      name: "higher sidecar revision wins even when its timestamp is older",
      mainVersion: 2,
      mainCursor: 1,
      mainRevision: 5,
      mainUpdatedAt: new Date(current - 1_000).toISOString(),
      sidecar: { version: 1, revision: 6, updatedAt: new Date(current - 5_000).toISOString(), scheduler: { developerCursor: 3, agentOsLastProbeAt: oldProbeAt, cmsLastProbeAt: oldProbeAt } },
      expectedCursor: 3,
    },
    {
      name: "main timestamp wins at the same revision",
      mainVersion: 2,
      mainCursor: 2,
      mainRevision: 5,
      mainUpdatedAt: new Date(current - 1_000).toISOString(),
      sidecar: { version: 1, revision: 5, updatedAt: new Date(current - 2_000).toISOString(), scheduler: { developerCursor: 3, agentOsLastProbeAt: oldProbeAt, cmsLastProbeAt: oldProbeAt } },
      expectedCursor: 2,
    },
    {
      name: "sidecar timestamp wins at the same revision",
      mainVersion: 2,
      mainCursor: 2,
      mainRevision: 5,
      mainUpdatedAt: new Date(current - 2_000).toISOString(),
      sidecar: { version: 1, revision: 5, updatedAt: new Date(current - 1_000).toISOString(), scheduler: { developerCursor: 3, agentOsLastProbeAt: oldProbeAt, cmsLastProbeAt: oldProbeAt } },
      expectedCursor: 3,
    },
    {
      name: "corrupt sidecar falls back to main",
      mainVersion: 2,
      mainCursor: 1,
      mainRevision: 2,
      mainUpdatedAt: new Date(current - 1_000).toISOString(),
      corruptSidecar: true,
      expectedCursor: 1,
    },
    {
      name: "legacy v1 main migrates without losing its cursor",
      mainVersion: 1,
      mainCursor: 1,
      expectedCursor: 1,
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const dataDir = await fixture(subtest);
      const mainState = {
        version: scenario.mainVersion,
        pages: {},
        cms: { initializedAt: nowValue, articles: {} },
        scheduler: {
          developerCursor: scenario.mainCursor,
          agentOsLastProbeAt: oldProbeAt,
          cmsLastProbeAt: oldProbeAt,
          ...(scenario.mainRevision == null ? {} : {
            checkpointRevision: scenario.mainRevision,
            checkpointUpdatedAt: scenario.mainUpdatedAt,
          }),
        },
        sourceControls: {},
        _health: { lane: { status: "healthy", checkedAt: oldProbeAt, lastStartedAt: oldProbeAt, lastSuccessAt: oldProbeAt } },
      };
      await fs.writeFile(path.join(dataDir, "binance-agent-native-state.json"), `${JSON.stringify(mainState)}\n`, { mode: 0o600 });
      const checkpointFile = path.join(dataDir, "binance-agent-native-checkpoint.json");
      if (scenario.corruptSidecar) await fs.writeFile(checkpointFile, "{broken checkpoint", { mode: 0o600 });
      else if (scenario.sidecar) await fs.writeFile(checkpointFile, `${JSON.stringify(scenario.sidecar)}\n`, { mode: 0o600 });
      const requested = [];
      const logs = [];
      const monitor = createBinanceMonitor({
        ...monitorConfig(dataDir),
        binanceDeveloperMonitorEnabled: true,
        binanceDeveloperPollIntervalMs: 1_000,
      }, {
        autoStart: false,
        now: () => current,
        agentNativePollIntervalMs: 1_000,
        agentNativeCmsPollIntervalMs: 3_600_000,
        agentOsPagePollIntervalMs: 3_600_000,
        fetchImpl: async (url) => {
          if (!BINANCE_DEVELOPER_DOC_URLS.includes(url)) throw new Error(`unexpected URL ${url}`);
          requested.push(url);
          return textResponse("", { status: 304 });
        },
        sendAlertsImpl: async () => assert.fail("checkpoint selection must not alert"),
        logger: { error: (message) => logs.push(message) },
      });

      await monitor.checkAgentNative();
      assert.equal(requested[0], BINANCE_DEVELOPER_DOC_URLS[scenario.expectedCursor]);
      await monitor.stop();
      const migratedCheckpoint = JSON.parse(await fs.readFile(checkpointFile, "utf8"));
      assert.equal(migratedCheckpoint.version, 1);
      assert.ok(Number.isSafeInteger(migratedCheckpoint.revision));
      assert.ok(migratedCheckpoint.revision >= Number(scenario.mainRevision || 0));
      assert.deepEqual(Object.keys(migratedCheckpoint).sort(), ["revision", "scheduler", "updatedAt", "version"]);
      assert.equal("sourceControls" in migratedCheckpoint, false);
      const migratedMain = JSON.parse(await fs.readFile(path.join(dataDir, "binance-agent-native-state.json"), "utf8"));
      assert.equal(migratedMain.version, 2);
      if (scenario.corruptSidecar) assert.ok(logs.some((message) => message.includes("using main-state scheduler")));
    });
  }
});

test("Agent Native content survives a checkpoint rename failure while restart safely re-probes the old cursor without replaying the alert", async (t) => {
  const dataDir = await fixture(t);
  let current = Date.parse("2026-08-24T13:00:00Z");
  const previousAt = new Date(current - 1_000).toISOString();
  const agenticUrl = BINANCE_DEVELOPER_DOC_URLS.find((url) => url.endsWith("/agent-native/mcp-server/agentic.md"));
  const agenticCursor = BINANCE_DEVELOPER_DOC_URLS.indexOf(agenticUrl);
  const baseText = "# Binance MCP Server\n- Existing market-data permission.";
  const materialFact = "Agent REST API POST /v2/orders now enables scoped Spot trade permission.";
  const currentText = `${baseText}\n- ${materialFact}`;
  const baseline = extractBinanceDeveloperSignalSnapshot(baseText);
  const stateFile = path.join(dataDir, "binance-agent-native-state.json");
  await fs.writeFile(stateFile, `${JSON.stringify({
    version: 2,
    pages: {
      [agenticUrl]: {
        semanticHash: "old-semantic-hash",
        signals: baseline.signals,
        totalSignals: baseline.totalSignals,
        truncated: false,
        etag: '"old"',
        lastModified: new Date(current - 60_000).toUTCString(),
        checkedAt: previousAt,
        displaySnapshot: { signalCount: baseline.signals.length, facts: baseline.signals },
      },
    },
    cms: { initializedAt: previousAt, articles: {} },
    scheduler: {
      developerCursor: agenticCursor,
      agentOsLastProbeAt: new Date(current).toISOString(),
      cmsLastProbeAt: new Date(current).toISOString(),
      checkpointRevision: 1,
      checkpointUpdatedAt: previousAt,
    },
    sourceControls: {
      [agenticUrl]: { status: "healthy", consecutiveRateLimits: 0, totalAttempts: 1, lastAttemptAt: new Date(current - 5_000).toISOString() },
    },
    _health: {
      developerDocs: { status: "healthy", checkedAt: previousAt, lastSuccessAt: previousAt, consecutiveFailures: 0 },
      lane: { status: "healthy", checkedAt: previousAt, lastStartedAt: previousAt, lastSuccessAt: previousAt, consecutiveFailures: 0 },
    },
  })}\n`, { mode: 0o600 });

  const delivered = [];
  const requested = [];
  const logs = [];
  let restarting = false;
  const fetchImpl = async (url, options = {}) => {
    if (url !== agenticUrl) throw new Error(`unexpected URL ${url}`);
    requested.push(url);
    if (restarting && options.headers?.["if-none-match"] === '"new"') return textResponse("", { status: 304 });
    return textResponse(currentText, {
      headers: { etag: '"new"', "last-modified": new Date(current).toUTCString() },
    });
  };
  const config = {
    ...monitorConfig(dataDir),
    binanceDeveloperMonitorEnabled: true,
    binanceDeveloperPollIntervalMs: 1_000,
  };
  const commonDependencies = {
    autoStart: false,
    now: () => current,
    agentNativePollIntervalMs: 1_000,
    agentNativeCmsPollIntervalMs: 60_000,
    agentOsPagePollIntervalMs: 60_000,
    fetchImpl,
    sendAlertsImpl: async (_config, event) => delivered.push(event),
    logger: { error: (message) => logs.push(message) },
  };
  const failingMonitor = createBinanceMonitor(config, {
    ...commonDependencies,
    agentNativeCheckpointAtomicWriteImpl: async () => {
      throw Object.assign(new Error("simulated checkpoint rename failure"), { code: "EIO" });
    },
  });

  await failingMonitor.checkAgentNative();
  assert.equal(delivered.length, 1);
  assert.deepEqual(delivered[0].keyChanges, [materialFact]);
  assert.ok(Date.parse(delivered[0].deliverySla.deadlineAt) - Date.parse(delivered[0].deliverySla.startedAt) <= 5_000);
  const afterFailure = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert.ok(afterFailure.pages[agenticUrl].signals.includes(materialFact), "the accepted event evidence is durable in main state");
  assert.equal(afterFailure.scheduler.developerCursor, agenticCursor, "failed sidecar never claims the next cursor is durable");
  await assert.rejects(fs.readFile(failingMonitor.agentNativeCheckpointFile, "utf8"), { code: "ENOENT" });
  assert.ok(logs.some((message) => message.includes("simulated checkpoint rename failure")));

  restarting = true;
  // lastAttemptAt is a durable per-source throttle and remains authoritative;
  // advance past the four-page rotation cadence, then verify the old cursor is
  // retried instead of skipping ahead.
  current += 5_000;
  const requestsBeforeRestart = requested.length;
  const restored = createBinanceMonitor(config, commonDependencies);
  await restored.checkAgentNative();
  assert.equal(requested[requestsBeforeRestart], agenticUrl, "restart re-probes the old durable cursor");
  assert.equal(delivered.length, 1, "the already durable content prevents an alert replay");
  await restored.stop();
});
