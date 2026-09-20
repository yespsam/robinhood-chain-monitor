import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sendAlerts } from "../src/alerts.js";
import {
  NEW_POOL_CONTEXT_VERSION,
  deriveNewPoolContext,
  matchReviewedPoolAssetKeys,
  resolveVerifiedPoolAssetContext,
} from "../src/new-pool-context.js";
import {
  BILINGUAL_RENDER_VERSION,
  buildBilingualAlertBundle,
  renderBilingualTelegramText,
} from "../src/bilingual-alert-renderer.js";

const NVDA_BSC = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const AAPL_BSC = "0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a";
const SOXL_BSC = "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf";
const SPACEX_BSC = "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1";
const AMC_PON = "0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B";
const UNKNOWN_BSC = "0x1111111111111111111111111111111111111111";
const FLAP_BOARD_URL = "https://flap.sh/board";
const FOUR_CONFIG_URL = "https://four.meme/meme-api/v1/public/config";
const PON_MARKETS_URL = "https://www.pon.fun/api/markets";
const PON_TOKEN_LIST_URL = "https://www.pon.fun/tokenlist.json";

const NVDA_ASSET_KEY = `eip155:56/erc20:${NVDA_BSC}`;
const AAPL_ASSET_KEY = `eip155:56/erc20:${AAPL_BSC}`;
const AMC_ASSET_KEY = `eip155:4663/erc20:${AMC_PON.toLowerCase()}`;

const REVIEWED_BSC_ADDITIONS = [
  {
    label: "HIMSB",
    address: "0xee6f4bcc88c2c8583d5a65c7d0c877b464100711",
    onchainSymbol: "HIMSB",
    onchainName: "Hims & Hers",
    assetClass: "public_equity_reference",
    ticker: "HIMS",
    exactSourceUrl: "https://www.binance.com/zh-CN/support/announcement/detail/7880bcb7f4744d8bbbba88cbbcd43124",
    businessSourceUrl: "https://www.sec.gov/Archives/edgar/data/1773751/000177375126000022/hims-20251231.htm",
    businessNeedle: /数字医疗平台/u,
    memeNeedle: /GLP-1/u,
  },
  {
    label: "FXIon",
    address: "0x9b8e987e6fec8cf1380c4dca7071e2c7853aeea1",
    onchainSymbol: "FXIon",
    onchainName: "iShares China Large-Cap ETF (Ondo Tokenized)",
    assetClass: "index_etf_reference",
    ticker: "FXI",
    exactSourceUrl: "https://app.ondo.finance/assets/fxion",
    businessSourceUrl: "https://www.ishares.com/us/products/239536/ishares-china-large-cap-etf",
    businessNeedle: /不是一家公司/u,
    memeNeedle: /港股龙头篮子/u,
  },
  {
    label: "BNC4",
    address: "0x7c8d5502b544ddaf8852fc46d1174e34876d545c",
    onchainSymbol: "BNC4",
    onchainName: "Cea Industries",
    assetClass: "public_equity_reference",
    ticker: "BNC",
    exactSourceUrl: "https://www.binance.com/en/square/profile/Four_meme",
    businessSourceUrl: "https://www.sec.gov/Archives/edgar/data/1482541/000148254126000019/bncww-20260430.htm",
    businessNeedle: /BNB 为核心/u,
    memeNeedle: /首个 4Stock/u,
  },
  {
    label: "HEMI",
    address: "0x5ffd0eadc186af9512542d0d5e5eafc65d5afc5b",
    onchainSymbol: "HEMI",
    onchainName: "Hemi",
    assetClass: "crypto_asset",
    ticker: "HEMI",
    exactSourceUrl: "https://docs.hemi.xyz/discover/token-contract-details",
    businessSourceUrl: "https://docs.hemi.xyz/",
    businessNeedle: /模块化 Layer 2/u,
    memeNeedle: /超级网络/u,
  },
  {
    label: "KOMA",
    address: "0xd5eaaac47bd1993d661bc087e15dfb079a7f3c19",
    onchainSymbol: "KOMA",
    onchainName: "Koma Inu",
    assetClass: "crypto_asset",
    ticker: "KOMA",
    exactSourceUrl: "https://www.binance.com/en-NG/support/announcement/detail/08c08f06bec24d91a60a0ce8c48a3a76",
    businessSourceUrl: "https://komabnb.com",
    businessNeedle: /狗狗主题/u,
    memeNeedle: /Shib 之子/u,
  },
  {
    label: "WLFI",
    address: "0x47474747477b199288bf72a1d702f7fe0fb1deea",
    onchainSymbol: "WLFI",
    onchainName: "World Liberty Financial",
    assetClass: "crypto_asset",
    ticker: "WLFI",
    exactSourceUrl: "https://docs.worldlibertyfinancial.com/wlfi-token/contract-addresses",
    businessSourceUrl: "https://docs.worldlibertyfinancial.com/wlfi-token/wlfi-governance",
    businessNeedle: /治理代币/u,
    memeNeedle: /USD1/u,
  },
  {
    label: "KOGE",
    address: "0xe6df05ce8c8301223373cf5b969afcb1498c5528",
    onchainSymbol: "KOGE",
    onchainName: "BNB48 Club Token",
    assetClass: "crypto_asset",
    ticker: "KOGE",
    exactSourceUrl: "https://docs.48.club/koge-token",
    businessSourceUrl: "https://docs.48.club/koge-token",
    businessNeedle: /会员福利/u,
    memeNeedle: /Richest DAO on BNB/u,
  },
  {
    label: "SLVon",
    address: "0x8b872732b07be325a8803cdb480d9d20b6f8d11b",
    onchainSymbol: "SLVon",
    onchainName: "iShares Silver Trust (Ondo Tokenized)",
    assetClass: "index_etf_reference",
    ticker: "SLV",
    exactSourceUrl: "https://app.ondo.finance/assets/slvon",
    businessSourceUrl: "https://www.ishares.com/us/products/239855/ishares-silver-trust",
    businessNeedle: /白银价格/u,
    memeNeedle: /链上白银/u,
  },
  {
    label: "MarsCoin",
    address: "0xfe189e97832da1573e4e4ff034f4ffc3a15c7777",
    onchainSymbol: "MarsCoin",
    onchainName: "MarsCoin",
    assetClass: "crypto_asset",
    ticker: "MarsCoin",
    exactSourceUrl: "https://www.binance.com/en/support/announcement/detail/c2eaa763831745b2b1701dab45e20225",
    businessSourceUrl: "https://www.binance.com/en/support/announcement/detail/c2eaa763831745b2b1701dab45e20225",
    businessNeedle: /火星为主题/u,
    memeNeedle: /CZ × 马斯克/u,
  },
  {
    label: "TRX",
    address: "0xce7de646e7208a4ef112cb6ed5038fa6cc6b12e3",
    onchainSymbol: "TRX",
    onchainName: "TRON",
    assetClass: "wrapped_crypto_asset",
    ticker: "TRX",
    exactSourceUrl: "https://www.binance.com/en/support/announcement/detail/26ebedbedc5540edbdae11d7c7e1e43f",
    businessSourceUrl: "https://developers.tron.network/docs/token-standards-trx",
    businessNeedle: /BEP-20 表示/u,
    memeNeedle: /稳定币支付轨道/u,
  },
  {
    label: "PDDon",
    address: "0xf3e82ea164cb344b2b11bad4c24b0ea4f7ba4714",
    onchainSymbol: "PDDon",
    onchainName: "PDD Holdings (Ondo Tokenized)",
    assetClass: "adr_reference",
    ticker: "PDD",
    exactSourceUrl: "https://app.ondo.finance/assets/pddon",
    businessSourceUrl: "https://investor.pddholdings.com/static-files/e15edea4-5e6d-4740-808a-63a3dd1b2ce4",
    businessNeedle: /拼多多与 Temu/u,
    memeNeedle: /砍一刀/u,
  },
  {
    label: "BILIon",
    address: "0x91fc7371d6de682a1e8cfcb4eb7da693312a03a4",
    onchainSymbol: "BILIon",
    onchainName: "Bilibili (Ondo Tokenized)",
    assetClass: "adr_reference",
    ticker: "BILI",
    exactSourceUrl: "https://app.ondo.finance/assets/bilion",
    businessSourceUrl: "https://ir.bilibili.com/cn/corporate-information/?tab=company-profile",
    businessNeedle: /视频社区/u,
    memeNeedle: /弹幕/u,
  },
  {
    label: "BMNRB",
    address: "0x3548da95a9effe481e8604664d75e95821e557f5",
    onchainSymbol: "BMNRB",
    onchainName: "BitMine Immersion Technologies",
    assetClass: "public_equity_reference",
    ticker: "BMNR",
    exactSourceUrl: "https://www.binance.com/en/support/announcement/detail/ae96da838d754f91bced1501de728f03",
    businessSourceUrl: "https://www.sec.gov/Archives/edgar/data/1829311/000162828026048157/bmnr-20260531.htm",
    businessNeedle: /ETH 为主要储备资产/u,
    memeNeedle: /Alchemy of 5%/u,
  },
];

const INTENTIONALLY_UNRESOLVED_BSC = [
  ["4Stock", "0xd270d4e1ec6e6e0d28c0ecb8be966ec75997ffff"],
  ["FREE", "0x00d7ed582f47c2713fa63fb55f13a2cd89297777"],
  ["USELESS", "0xba38b3c706f7a515ff7c8db04daa0a134ec46d2b"],
  ["Marvin", "0xc6bff31bbfa84d3c05ad61d8ec47be8b31517777"],
];

function languageBlocks(rendered) {
  const match = String(rendered).match(/🇨🇳 中文\n([\s\S]*?)\n\n🇬🇧 English\n([\s\S]*)$/u);
  assert.ok(match);
  return {
    zh: match[1].split("\n").filter(Boolean),
    en: match[2].split("\n").filter(Boolean),
  };
}

function assertPoolLayout(rendered) {
  const blocks = languageBlocks(rendered);
  assert.ok(rendered.length < 3_800);
  assert.ok(rendered.split("\n").length <= 18);
  for (const lines of Object.values(blocks)) {
    assert.ok(lines.length >= 4 && lines.length <= 7);
    assert.ok(lines.every((line) => line.length <= 150), lines.join("\n"));
  }
  return blocks;
}

test("reviewed news matcher resolves exact tickers and reviewed company names deterministically", () => {
  assert.deepEqual(
    matchReviewedPoolAssetKeys("Apple Inc. expands its NVIDIA Corporation partnership; AAPL and NVDA react."),
    [NVDA_ASSET_KEY, AAPL_ASSET_KEY],
  );
  assert.deepEqual(matchReviewedPoolAssetKeys("NVIDIA and Apple Inc."), [NVDA_ASSET_KEY, AAPL_ASSET_KEY]);
  assert.deepEqual(matchReviewedPoolAssetKeys("AAPL, NVDA, AAPL, NVDA"), [NVDA_ASSET_KEY, AAPL_ASSET_KEY]);
});

test("reviewed news matcher requires complete case-sensitive ticker tokens and never guesses substrings", () => {
  for (const text of [
    "SNVDA",
    "NVDAish",
    "NVDA2",
    "NVDA_B",
    "aaapl",
    "AAPLish",
    "pineapple",
    "The app label changed",
  ]) assert.deepEqual(matchReviewedPoolAssetKeys(text), [], text);

  assert.deepEqual(matchReviewedPoolAssetKeys("(NVDA) / AAPL"), [NVDA_ASSET_KEY, AAPL_ASSET_KEY]);
  assert.deepEqual(matchReviewedPoolAssetKeys("nvda and aapl"), []);
});

test("reviewed news matcher applies an exact chain filter and does not cross-map assets", () => {
  assert.deepEqual(matchReviewedPoolAssetKeys("NVDA and AMC", { chainId: 56 }), [NVDA_ASSET_KEY]);
  assert.deepEqual(matchReviewedPoolAssetKeys("NVDA and AMC", { chainId: 4663 }), [AMC_ASSET_KEY]);
  assert.deepEqual(matchReviewedPoolAssetKeys("NVDA", { chainId: 1 }), []);
  assert.deepEqual(matchReviewedPoolAssetKeys("NVDA", { chainId: "56" }), []);
});

function flapPoolEvent({
  address = NVDA_BSC,
  symbol = "NVDAB",
  name = "NVIDIA Corp",
} = {}) {
  return {
    type: "platform_capability_update",
    kind: "flap_quote_asset_enabled",
    eventKey: `flap-quote:56:0x${"ab".repeat(32)}:7`,
    platform: { id: "flap", name: "Flap" },
    chainId: 56,
    chain: { id: 56, chainId: 56 },
    source: { id: "flap_portal_quote_configuration", url: FLAP_BOARD_URL, official: true },
    transactionHash: `0x${"ab".repeat(32)}`,
    blockNumber: 12_345,
    observedAt: "2026-09-06T08:00:00.000Z",
    changes: {
      newFlapPools: [{
        kind: "quote_asset",
        quoteAddress: address,
        quoteSymbol: symbol,
        quoteName: name,
        chainId: 56,
        sourceUrl: FLAP_BOARD_URL,
      }],
    },
    signal: {
      quotePairChange: {
        stage: "live",
        assetClass: "bstock_quote",
        assets: [{ address, symbol, name, chainId: 56 }],
      },
    },
  };
}

test("reviewed new-pool profiles bind only by exact chain and address", () => {
  const nvda = resolveVerifiedPoolAssetContext({ chainId: 56, address: NVDA_BSC.toUpperCase() });
  assert.equal(nvda.version, NEW_POOL_CONTEXT_VERSION);
  assert.equal(nvda.resolution, "verified_complete");
  assert.equal(nvda.assetClass, "public_equity_reference");
  assert.equal(nvda.canonicalTicker, "NVDA");
  assert.equal(nvda.mappingEvidence.addressEvidence.assetKey, `eip155:56/erc20:${NVDA_BSC}`);
  assert.match(nvda.mappingEvidence.evidenceHash, /^[a-f0-9]{64}$/u);

  for (const unresolved of [
    resolveVerifiedPoolAssetContext({ chainId: 1, address: NVDA_BSC }),
    resolveVerifiedPoolAssetContext({ chainId: "56", address: NVDA_BSC }),
    resolveVerifiedPoolAssetContext({ chainId: 56, address: UNKNOWN_BSC }),
    resolveVerifiedPoolAssetContext({ chainId: 56, address: "NVIDIA" }),
  ]) {
    assert.equal(unresolved.resolution, "unresolved");
    assert.match(unresolved.business.zh, /不根据名称或代码猜测/u);
    assert.equal(unresolved.meme.kind, "editorial");
  }
});

test("thirteen researched BSC assets retain exact identity, narrative, and independent address evidence", () => {
  for (const expected of REVIEWED_BSC_ADDITIONS) {
    const profile = resolveVerifiedPoolAssetContext({ chainId: 56, address: expected.address.toUpperCase() });
    assert.equal(profile.resolution, "verified_complete", expected.label);
    assert.equal(profile.assetKey, `eip155:56/erc20:${expected.address}`, expected.label);
    assert.equal(profile.assetClass, expected.assetClass, expected.label);
    assert.equal(profile.canonicalTicker, expected.ticker, expected.label);
    assert.equal(profile.mappingEvidence.expectedOnchainIdentity.canonicalDisplaySymbol, expected.onchainSymbol, expected.label);
    assert.equal(profile.mappingEvidence.expectedOnchainIdentity.canonicalDisplayName, expected.onchainName, expected.label);
    assert.equal(profile.mappingEvidence.addressEvidence.chainId, 56, expected.label);
    assert.equal(profile.mappingEvidence.addressEvidence.address, expected.address, expected.label);
    assert.equal(profile.mappingEvidence.status, "reviewed_exact_address", expected.label);
    assert.equal(profile.mappingEvidence.reviewedAt, "2026-09-11", expected.label);
    assert.equal(profile.reviewedAt, "2026-09-11", expected.label);
    assert.match(profile.business.zh, expected.businessNeedle, expected.label);
    assert.ok(profile.business.en.length > 20, expected.label);
    assert.match(profile.meme.zh, expected.memeNeedle, expected.label);
    assert.ok(profile.meme.en.length > 15, expected.label);
    assert.equal(profile.businessSource.url, expected.businessSourceUrl, expected.label);
    assert.ok(profile.mappingEvidence.independentSources.some((source) => source.url === expected.exactSourceUrl
      && source.chainId === 56
      && source.address === expected.address), expected.label);
    assert.match(profile.mappingEvidence.evidenceHash, /^[a-f0-9]{64}$/u, expected.label);
    assert.match(profile.sourceHash, /^[a-f0-9]{64}$/u, expected.label);

    const crossChain = resolveVerifiedPoolAssetContext({ chainId: 1, address: expected.address });
    assert.equal(crossChain.resolution, "unresolved", `${expected.label} must not resolve cross-chain`);
  }
});

test("the four evidence-insufficient Flap labels remain unresolved by exact BSC address", () => {
  for (const [label, address] of INTENTIONALLY_UNRESOLVED_BSC) {
    const profile = resolveVerifiedPoolAssetContext({ chainId: 56, address });
    assert.equal(profile.resolution, "unresolved", label);
    assert.equal(profile.mappingEvidence.independentSources.length, 0, label);
    assert.equal(profile.canonicalTicker, null, label);
  }
});

test("all thirteen researched BSC assets render concise business and meme cards from exact Flap observations", async () => {
  for (const expected of REVIEWED_BSC_ADDITIONS) {
    const event = flapPoolEvent({
      address: expected.address,
      symbol: expected.onchainSymbol,
      name: expected.onchainName,
    });
    const context = deriveNewPoolContext(event, { flapQuote: { stage: "live", onchain: true } });
    assert.equal(context.assets[0].identityStatus, "matched", expected.label);
    assert.equal(context.assets[0].profile.assetKey, `eip155:56/erc20:${expected.address}`, expected.label);

    const bundle = await buildBilingualAlertBundle(
      { alertForceLocalStructured: true },
      event,
      "Flap quote pool enabled\n时间: 2026-09-11T08:00:00.000Z",
    );
    const rendered = renderBilingualTelegramText(bundle, true);
    const blocks = assertPoolLayout(rendered);
    assert.match(blocks.zh.join("\n"), expected.businessNeedle, expected.label);
    assert.match(blocks.zh.join("\n"), expected.memeNeedle, expected.label);
    assert.match(rendered, new RegExp(expected.address, "iu"), expected.label);
    assert.doesNotMatch(rendered, /风险|Risk|核验|Verification|勿追价|do not chase|非自动交易|no automatic trading/iu, expected.label);
  }
});

test("ETF and current SpaceX profiles are not misclassified as companies or private equity", () => {
  const soxl = resolveVerifiedPoolAssetContext({ chainId: 56, address: SOXL_BSC });
  assert.equal(soxl.assetClass, "leveraged_etf_reference");
  assert.match(soxl.business.zh, /单日 \+300%.*每日重置.*不是一家公司/u);
  assert.match(soxl.business.en, /\+300%.*resets daily.*not a company/i);

  const spacex = resolveVerifiedPoolAssetContext({ chainId: 56, address: SPACEX_BSC });
  assert.equal(spacex.assetClass, "public_equity_reference");
  assert.equal(spacex.canonicalTicker, "SPCX");
  assert.match(spacex.business.zh, /2026-06-12.*上市/u);
  assert.doesNotMatch(spacex.subject.zh, /私营|私人/u);
  assert.match(spacex.businessSource.url, /Announces-Closing-of-Initial-Public-Offering/u);
  assert.match(spacex.businessSource.corroborating[0].url, /^https:\/\/www\.sec\.gov\/Archives\//u);
  assert.equal(spacex.mappingEvidence.addressEvidence.address, SPACEX_BSC);
  assert.equal(spacex.mappingEvidence.independentSources[0].address, SPACEX_BSC);
  assert.match(spacex.mappingEvidence.independentSources[0].url, /^https:\/\/www\.bnbchain\.org\//u);
  assert.notEqual(spacex.businessSource.url, spacex.mappingEvidence.independentSources[0].url);
});

test("Flap new-pool card explains the company and editorial meme without a network lookup", async () => {
  let fetchCalls = 0;
  const event = flapPoolEvent();
  const original = structuredClone(event);
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => {
      fetchCalls += 1;
      throw new Error("translation must not run for a verified new-pool context");
    },
  }, event, "Flap quote pool enabled\n时间: 2026-09-06T08:00:00.000Z");
  const rendered = renderBilingualTelegramText(bundle, true);
  const blocks = assertPoolLayout(rendered);

  assert.equal(fetchCalls, 0);
  assert.equal(bundle.version, BILINGUAL_RENDER_VERSION);
  assert.equal(bundle.format, "telegram_zh_en_pool_context_v2");
  assert.equal(bundle.focusModel.newPoolContext.assets[0].profile.canonicalTicker, "NVDA");
  assert.equal(bundle.focusModel.newPoolContext.assets[0].identityStatus, "matched");
  assert.equal(bundle.focusModel.newPoolContext.assets[0].canonicalDisplaySymbol, "NVDAB");
  assert.equal(bundle.focusModel.newPoolContext.assets[0].mappingEvidence.producerObservation.chainField, "changes.newFlapPools[].chainId");
  assert.match(rendered, /^🆕 新底池 \| NEW POOL/u);
  assert.match(blocks.zh.join("\n"), /项目：Flap/u);
  assert.match(blocks.zh.join("\n"), /AI 与加速计算.*芯片/u);
  assert.match(blocks.zh.join("\n"), /梗：/u);
  assert.match(blocks.en.join("\n"), /Meme:/i);
  assert.match(rendered, new RegExp(NVDA_BSC, "i"));
  assert.doesNotMatch(rendered, /风险|Risk|核验|Verification|勿追价|do not chase|非自动交易|no automatic trading/iu);
  assert.deepEqual(event, original);
  assert.equal(renderBilingualTelegramText(bundle, true), rendered, "a persisted bundle must render identically on retry");
});

test("new-pool Telegram delivery persists the dedicated fact-card format even when global bilingual mode is off", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-new-pool-context-"));
  const event = flapPoolEvent();
  const payloads = [];
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }),
    };
  });
  t.mock.method(console, "info", () => {});
  const result = await sendAlerts({
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "test-bot-token",
    telegramChatId: "123456789",
    telegramStrongAlerts: true,
    alertBilingualEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
    alertNow: () => Date.parse(event.observedAt),
  }, event);
  assert.equal(result.status, "delivered");
  assert.equal(payloads.length, 1);
  assert.match(payloads[0].text, /^🆕 新底池 \| NEW POOL/u);
  const outbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  assert.equal(outbox.events[result.eventId].renderBundle.format, "telegram_zh_en_pool_context_v2");
  assert.doesNotMatch(payloads[0].text, /风险|Risk|核验|Verification|勿追价|do not chase|非自动交易|no automatic trading/iu);
});

test("a spoofed NVIDIA name on an unknown CA stays unresolved", async () => {
  const event = flapPoolEvent({ address: UNKNOWN_BSC, symbol: "NVDAB", name: "NVIDIA Corp" });
  const bundle = await buildBilingualAlertBundle(
    { alertForceLocalStructured: true },
    event,
    "Flap quote pool enabled\n时间: 2026-09-06T08:00:00.000Z",
  );
  const rendered = renderBilingualTelegramText(bundle, true);
  const blocks = assertPoolLayout(rendered);
  assert.equal(bundle.focusModel.newPoolContext.assets[0].profile.resolution, "unresolved");
  assert.equal(bundle.focusModel.newPoolContext.assets[0].identityStatus, "unverified");
  assert.equal(bundle.focusModel.newPoolContext.assets[0].canonicalDisplaySymbol, null);
  assert.doesNotMatch(blocks.zh.join("\n"), /对应 无对应资料/u);
  assert.match(blocks.zh.join("\n"), /链上标识 NVDAB · NVIDIA Corp/u);
  assert.match(blocks.zh.join("\n"), /资料：该报价 CA 无已确认资产映射/u);
  assert.doesNotMatch(blocks.zh.join("\n"), /梗：/u);
  assert.match(blocks.en.join("\n"), /Profile: no confirmed asset mapping for this quote CA/i);
  assert.doesNotMatch(rendered, /AI 淘金|accelerated computing|leather jacket/iu);
});

test("Four.Meme new quote config explains SpaceX as a current public-equity reference", async () => {
  const event = {
    type: "platform_capability_update",
    eventKey: "platform-capability:fourmeme:spcxb",
    platform: { id: "fourmeme", name: "Four.Meme" },
    observedAt: "2026-09-06T08:01:00.000Z",
    changes: {
      newQuoteConfigs: [{
        symbol: "SPCXB",
        address: SPACEX_BSC,
        status: "PUBLISH",
        platform: "MEME",
        networkCode: "BSC",
        source: { kind: "api", url: FOUR_CONFIG_URL },
      }],
    },
  };
  const bundle = await buildBilingualAlertBundle(
    { alertForceLocalStructured: true },
    event,
    "Four.Meme quote config published\n时间: 2026-09-06T08:01:00.000Z",
  );
  const rendered = renderBilingualTelegramText(bundle, true);
  const blocks = assertPoolLayout(rendered);
  assert.match(blocks.zh.join("\n"), /SPCX · SpaceX/u);
  assert.match(blocks.zh.join("\n"), /2026-06-12.*上市/u);
  assert.match(blocks.zh.join("\n"), /官方 config API 新增 PUBLISH 报价配置/u);
  assert.doesNotMatch(rendered, /风险|Risk|核验|Verification|非自动交易|no automatic trading/iu);
  assert.doesNotMatch(rendered, /私人公司|private company/iu);
  const asset = bundle.focusModel.newPoolContext.assets[0];
  assert.equal(asset.identityStatus, "matched");
  assert.equal(asset.mappingEvidence.producerObservation.networkCode, "BSC");
  assert.equal(asset.mappingEvidence.producerObservation.sources[0].url, FOUR_CONFIG_URL);
});

test("pon.fun market_created resolves the company through stockToken, not the meme coin CA", async () => {
  const coin = "0x1EbAAB225157ff0eAecFc69EdAbbE978D8b610D9";
  const event = {
    type: "pon_fun_update",
    kind: "market_created",
    eventKey: `pon-fun:market_created:4663:0x${"cd".repeat(32)}:7`,
    chainId: 4663,
    platform: { id: "ponfun", name: "pon.fun", chainId: 4663 },
    source: { id: "pon_fun_official", url: "https://robinhoodchain.blockscout.com/tx/example", official: true },
    transactionHash: `0x${"cd".repeat(32)}`,
    blockNumber: 222,
    observedAt: "2026-09-06T08:02:00.000Z",
    token: coin,
    contractAddress: coin,
    market: {
      ticker: "AMC",
      symbol: "AMCAPE",
      name: "Apes Together Strong",
      coin,
      stockToken: AMC_PON,
    },
    currentSnapshot: {
      ticker: "AMC",
      symbol: "AMCAPE",
      name: "Apes Together Strong",
      coin,
      stockToken: AMC_PON,
    },
    changes: { market: { before: null, after: { ticker: "AMC", symbol: "AMCAPE", coin } } },
    evidence: {
      chainId: 4663,
      receiptVerified: true,
      api: { marketsUrl: PON_MARKETS_URL, tokenListUrl: PON_TOKEN_LIST_URL },
    },
  };
  const bundle = await buildBilingualAlertBundle(
    { alertForceLocalStructured: true },
    event,
    "pon.fun market created\n时间: 2026-09-06T08:02:00.000Z",
  );
  const rendered = renderBilingualTelegramText(bundle, true);
  const blocks = assertPoolLayout(rendered);
  assert.match(rendered, /^🆕 新市场 \| NEW MARKET/u);
  assert.match(blocks.zh.join("\n"), /CA：coin 0x1EbA/u);
  assert.match(blocks.zh.join("\n"), /stockToken 0x05a3/u);
  assert.match(blocks.zh.join("\n"), /电影院线/u);
  assert.match(blocks.zh.join("\n"), /Apes、爆米花/u);
  assert.doesNotMatch(rendered, /风险|Risk|核验|Verification|非自动交易|no automatic trading/iu);
  const asset = bundle.focusModel.newPoolContext.assets[0];
  assert.equal(asset.identityStatus, "matched");
  assert.deepEqual(asset.identityComparedFields, ["symbol"]);
  assert.equal(asset.observedDisplayName, "Apes Together Strong");
  assert.equal(asset.canonicalDisplayName, "AMC Entertainment • Robinhood Token");
  assert.equal(asset.mappingEvidence.producerObservation.addressField, "market.stockToken");
});

test("known exact address reports producer identity conflicts without changing its canonical display identity", async () => {
  const event = flapPoolEvent({ address: SOXL_BSC, symbol: "BRK.B", name: "Berkshire Hathaway" });
  const context = deriveNewPoolContext(event, { flapQuote: { stage: "live", onchain: true } });
  const asset = context.assets[0];
  assert.equal(asset.identityStatus, "mismatch");
  assert.deepEqual(asset.identityComparedFields, ["symbol", "name"]);
  assert.deepEqual(asset.identityMismatches.map((item) => item.field), ["symbol", "name"]);
  assert.equal(asset.observedDisplaySymbol, "BRK.B");
  assert.equal(asset.observedDisplayName, "Berkshire Hathaway");
  assert.equal(asset.canonicalDisplaySymbol, "SOXLB");
  assert.equal(asset.canonicalDisplayName, "Semicon Bull 3X ETF");
  assert.equal(asset.displaySymbol, "SOXLB");
  assert.equal(asset.profile.canonicalTicker, "SOXL");

  const bundle = await buildBilingualAlertBundle(
    { alertForceLocalStructured: true },
    event,
    "Flap quote pool enabled\n时间: 2026-09-06T08:00:00.000Z",
  );
  const rendered = renderBilingualTelegramText(bundle, true);
  assert.match(rendered, /BRK\.B · Berkshire Hathaway 新报价底池/u);
  assert.match(rendered, /SOXL · 半导体多头/u);
  assert.doesNotMatch(rendered, /身份冲突|identity conflict|风险|Risk/iu);
});

test("all launchpad entry points fail closed on missing or contradictory chain/network evidence", () => {
  const flapMissingPoolChain = flapPoolEvent();
  delete flapMissingPoolChain.changes.newFlapPools[0].chainId;
  assert.equal(deriveNewPoolContext(flapMissingPoolChain), null);

  const flapCrossChain = flapPoolEvent();
  flapCrossChain.changes.newFlapPools[0].chainId = 1;
  assert.equal(deriveNewPoolContext(flapCrossChain), null);

  const fourBase = {
    type: "platform_capability_update",
    platform: { id: "fourmeme" },
    changes: {
      newQuoteConfigs: [{
        symbol: "SPCXB",
        address: SPACEX_BSC,
        platform: "MEME",
        status: "PUBLISH",
        networkCode: "BSC",
        source: { kind: "api", url: FOUR_CONFIG_URL },
      }],
    },
  };
  const fourMissingNetwork = structuredClone(fourBase);
  delete fourMissingNetwork.changes.newQuoteConfigs[0].networkCode;
  assert.equal(deriveNewPoolContext(fourMissingNetwork), null);
  const fourWrongNetwork = structuredClone(fourBase);
  fourWrongNetwork.changes.newQuoteConfigs[0].networkCode = "ETH";
  assert.equal(deriveNewPoolContext(fourWrongNetwork), null);
  const fourContradictoryChain = structuredClone(fourBase);
  fourContradictoryChain.chainId = 1;
  assert.equal(deriveNewPoolContext(fourContradictoryChain), null);

  const ponBase = {
    type: "pon_fun_update",
    kind: "market_created",
    platform: { id: "ponfun", chainId: 4663 },
    chainId: 4663,
    market: { ticker: "AMC", name: "AMC market", stockToken: AMC_PON, coin: UNKNOWN_BSC },
  };
  const ponMissingChain = structuredClone(ponBase);
  delete ponMissingChain.chainId;
  assert.equal(deriveNewPoolContext(ponMissingChain), null);
  const ponWrongChain = structuredClone(ponBase);
  ponWrongChain.chainId = 56;
  assert.equal(deriveNewPoolContext(ponWrongChain), null);
  const ponMissingPlatform = structuredClone(ponBase);
  delete ponMissingPlatform.platform;
  assert.equal(deriveNewPoolContext(ponMissingPlatform), null);

  const ponCoinConflict = structuredClone(ponBase);
  ponCoinConflict.currentSnapshot = {
    ...ponCoinConflict.market,
    coin: "0x2222222222222222222222222222222222222222",
  };
  ponCoinConflict.token = "0x2222222222222222222222222222222222222222";
  ponCoinConflict.contractAddress = "0x2222222222222222222222222222222222222222";
  assert.equal(deriveNewPoolContext(ponCoinConflict), null);

  const ponMissingCoin = structuredClone(ponBase);
  delete ponMissingCoin.market.coin;
  assert.equal(deriveNewPoolContext(ponMissingCoin), null);

  const ponZeroCoin = structuredClone(ponBase);
  ponZeroCoin.market.coin = `0x${"0".repeat(40)}`;
  assert.equal(deriveNewPoolContext(ponZeroCoin), null);

  const ponZeroStockToken = structuredClone(ponBase);
  ponZeroStockToken.market.stockToken = `0x${"0".repeat(40)}`;
  assert.equal(deriveNewPoolContext(ponZeroStockToken), null);

  const ponTickerConflict = structuredClone(ponBase);
  ponTickerConflict.currentSnapshot = { ...ponTickerConflict.market, ticker: "CLOV" };
  assert.equal(deriveNewPoolContext(ponTickerConflict), null);
});

test("the first-three CA card stays concise and does not repeat company context", async () => {
  const token = "0x2222222222222222222222222222222222222222";
  const activation = "flap:quote:56:nvdab";
  const event = {
    type: "bsc_launchpad_update",
    kind: "flap_pool_token",
    eventKey: `bsc-flap-pool-token:${activation}:1:0x${"ef".repeat(32)}:2:${token}`,
    platform: { id: "flap", trust: "official_verified" },
    featurePlatform: "flap",
    featureTrackedToken: true,
    featureTokenOrdinal: 1,
    featureTokenTarget: 3,
    featureActivationKey: activation,
    featureGenerationKey: activation,
    transactionHash: `0x${"ef".repeat(32)}`,
    logIndex: 2,
    tokens: [{ token, metadata: { name: "Example", symbol: "EX" } }],
    mode: { quoteAsset: NVDA_BSC, quoteSymbol: "NVDAB", quoteName: "NVIDIA Corp" },
    informationalOnly: true,
    autoTradeEligible: false,
    automaticExecution: false,
    security: { decision: "unknown" },
    observedAt: "2026-09-06T08:03:00.000Z",
  };
  const bundle = await buildBilingualAlertBundle(
    { alertForceLocalStructured: true },
    event,
    "Flap first token\n时间: 2026-09-06T08:03:00.000Z",
  );
  const rendered = renderBilingualTelegramText(bundle, true);
  const blocks = languageBlocks(rendered);
  assert.equal(blocks.zh.length, 5);
  assert.equal(blocks.en.length, 5);
  assert.match(rendered, /NVDAB 底池｜第 1\/3 个/u);
  assert.doesNotMatch(rendered, /业务：|Business:|梗点|Meme angle|AI 淘金|风险|Risk|非自动交易|no automatic trading/u);
});

test("non-new pool events do not gain a context bundle", () => {
  const firstObserved = flapPoolEvent();
  firstObserved.kind = "flap_quote_asset_first_observed_after_gap";
  firstObserved.changes.updatedFlapPools = firstObserved.changes.newFlapPools;
  firstObserved.changes.newFlapPools = [];
  assert.equal(deriveNewPoolContext(firstObserved), null);
});
