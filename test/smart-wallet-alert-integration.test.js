import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { deriveAlertChangeModel } from "../src/alert-change-model.js";
import { isRelevantAlert, isStrongAlert, sendAlerts, telegramButtons } from "../src/alerts.js";
import { buildBilingualAlertBundle, renderBilingualTelegramText } from "../src/bilingual-alert-renderer.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";

const WALLET = "0xa9b0295aa2d8486735d3fb3e92ab77e678ae3f9a";
const TOKEN = "0x2222222222222222222222222222222222222222";
const TX = `0x${"a".repeat(64)}`;
const BLOCK = 12_345_678;
const POOL = "0x4444444444444444444444444444444444444444";

const monitorConfig = {
  monitorScope: "focus3",
  ponsMonitorEnabled: false,
  fomoCallEnabled: true,
  fomoBuyMonitorEnabled: false,
  fomoSmartMoneyMonitorEnabled: true,
  fomoSmartMoneyProfileMaxAgeMs: 3_600_000,
  fomoCallMaxSignalAgeMs: 300_000,
};

function smartWalletBuy(overrides = {}) {
  const occurredAt = new Date(Date.now() - 2_000).toISOString();
  const observedAt = new Date().toISOString();
  const event = {
    type: "fomo_family_top_call",
    signalKind: "high_profit_high_winrate_wallet_buy",
    qualified: true,
    strong: true,
    activity: "buy",
    action: "buy",
    trade: "buy",
    side: "buy",
    source: {
      id: "gmgn_profitable_wallet_onchain",
      name: "GMGN profitable wallet on-chain monitor",
      trust: "public_onchain_profiled",
    },
    sourceTrust: "public_onchain_profiled",
    platform: { id: "smart-money", name: "高收益高胜率公开钱包" },
    chain: { id: 56, chainId: 56, slug: "bsc", name: "BNB Smart Chain", gmgn: "bsc" },
    token: TOKEN,
    contractAddress: TOKEN,
    tokenSymbol: "ABC",
    walletAddress: WALLET,
    transactionHash: TX,
    transactionUrl: `https://bscscan.com/tx/${TX}`,
    logIndex: 4,
    blockNumber: BLOCK,
    executionPool: POOL,
    executionPairVerified: true,
    amountUsd: 0.01,
    walletProfile: {
      scheme: "gmgn_wallet_stats_dual_window_v1",
      source: "gmgn_portfolio_stats",
      qualified: true,
      wallet: WALLET,
      chainId: 56,
      tags: ["fomo", "smart_degen"],
      createdAt: "2026-03-19T00:00:00.000Z",
      createdTokenCount: 0,
      feedObservedAt: occurredAt,
      statsCheckedAt: observedAt,
      windows: {
        "7d": { realizedProfitUsd: 6_258.72, winRate: 0.62011, realizedRoi: 0.017249, tokenCount: 223, buyCount: 1_476, sellCount: 1_478 },
        "30d": { realizedProfitUsd: 17_458.42, winRate: 0.63172, realizedRoi: 0.01963, tokenCount: 510, buyCount: 3_610, sellCount: 3_616 },
      },
    },
    sourceClassification: {
      id: "gmgn_public_performance_wallet",
      gmgnTags: ["fomo", "smart_degen"],
      includesKolTag: false,
      fomoOfficial: false,
      identityVerified: false,
    },
    positionSemantics: {
      id: "new_position_after_previous_block_zero",
      label: "前一区块零仓后的新建仓",
      proofBoundary: "previous_block",
      lifetimeFirstBuyVerified: false,
      transactionImmediatePreBalanceVerified: false,
    },
    sourceTrade: {
      scheme: "gmgn_smartmoney_trade_v1",
      wallet: WALLET,
      token: TOKEN,
      transactionHash: TX,
      transactionFrom: WALLET,
      receiptStatus: 1,
      logIndex: 4,
      blockNumber: BLOCK,
      side: "buy",
      swapVerified: true,
      curveBuyVerified: false,
      executionPool: POOL,
      executionPoolCount: 1,
      executionPoolReceiptVerified: true,
      executionPairVerified: true,
      exactExecutionPoolVerified: true,
      paymentRaw: "1",
      tokenDeltaRaw: "1000000000000000000",
      tags: ["fomo", "smart_degen"],
      occurredAt,
      observedAt,
    },
    positionProof: {
      status: "verified",
      complete: true,
      phase: "previous_block",
      previousBalanceRaw: "0",
      wallet: WALLET,
      token: TOKEN,
      transactionHash: TX,
      blockNumber: BLOCK,
    },
    market: {
      liquidityUsd: 25_000,
      sellsM5: 3,
      pairAddress: POOL,
      executionPool: POOL,
      executionPairVerified: true,
      exactExecutionPoolVerified: true,
    },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true } },
    publishedAt: occurredAt,
    observedAt,
  };
  event.transactionProof = {
    scheme: "evm_wallet_buy_proof_v1",
    chainId: 56,
    wallet: WALLET,
    token: TOKEN,
    transactionHash: TX,
    transactionFrom: WALLET,
    receiptStatus: 1,
    blockNumber: BLOCK,
    logIndex: 4,
    paymentRaw: "1",
    tokenDeltaRaw: "1000000000000000000",
    swapVerified: true,
    curveBuyVerified: false,
    executionPool: POOL,
    executionPoolCount: 1,
    executionPoolReceiptVerified: true,
    executionPairVerified: true,
    exactExecutionPoolVerified: true,
    eoaVerified: true,
    eoaCheckedAt: observedAt,
    walletCode: "0x",
    positionProof: structuredClone(event.positionProof),
  };
  return Object.assign(event, overrides);
}

test("high-profit/high-win-rate wallet buy is independent from the disabled KOL buy lane", () => {
  const event = smartWalletBuy();
  assert.equal(isMonitoringSourceEnabled(monitorConfig, event), true);
  assert.equal(isRelevantAlert(event), true);
  assert.equal(isStrongAlert(event), true);
  assert.equal(event.amountUsd, 0.01, "a sub-dollar verified buy is not rejected by a USD floor");
});

test("qualified GMGN smart-money tags do not require the smart_degen label", () => {
  const event = smartWalletBuy();
  event.walletProfile.tags = ["launchpad_smart", "axiom"];
  event.sourceTrade.tags = ["launchpad_smart", "axiom"];
  event.sourceClassification.gmgnTags = ["launchpad_smart", "axiom"];
  assert.equal(isMonitoringSourceEnabled(monitorConfig, event), true);
  assert.equal(isRelevantAlert(event), true);
});

test("a smartmoney-feed wallet may overlap a KOL tag without becoming a Fomo or KOL identity claim", () => {
  const event = smartWalletBuy();
  event.walletProfile.tags.push("kol");
  event.sourceTrade.tags.push("kol");
  event.sourceClassification.gmgnTags.push("kol");
  event.sourceClassification.includesKolTag = true;
  assert.equal(isMonitoringSourceEnabled(monitorConfig, event), true);
  assert.equal(isRelevantAlert(event), true);
  assert.equal(event.sourceClassification.fomoOfficial, false);
  assert.equal(event.sourceClassification.identityVerified, false);
  assert.equal(event.caller, undefined);
  assert.equal(event.walletBinding, undefined);
  assert.equal(event.walletAttribution, undefined);
});

test("smart wallet routing fails closed on weak stats, dirty tags, stale evidence, and mismatches", () => {
  const rejected = [];
  const reject = (label, mutate) => {
    const event = structuredClone(smartWalletBuy());
    mutate(event);
    rejected.push([label, event]);
  };
  reject("30d profit below threshold", (event) => { event.walletProfile.windows["30d"].realizedProfitUsd = 9_999.99; });
  reject("7d win rate below threshold", (event) => { event.walletProfile.windows["7d"].winRate = 0.5999; });
  reject("dirty wallet", (event) => { event.walletProfile.tags.push("wash_trader"); });
  reject("MEV wallet", (event) => { event.sourceTrade.tags.push("mev_bot"); });
  reject("router wallet", (event) => { event.walletProfile.tags.push("router"); });
  reject("wallet created tokens above policy", (event) => { event.walletProfile.createdTokenCount = 11; });
  reject("wallet mismatch", (event) => { event.walletProfile.wallet = "0x3333333333333333333333333333333333333333"; });
  reject("failed receipt", (event) => { event.sourceTrade.receiptStatus = 0; });
  reject("zero payment", (event) => { event.sourceTrade.paymentRaw = "0"; });
  reject("sell", (event) => { event.sourceTrade.side = "sell"; });
  reject("incomplete zero-position proof", (event) => { event.positionProof.complete = false; });
  reject("missing EOA proof", (event) => { event.transactionProof.eoaVerified = false; });
  reject("transaction proof mismatch", (event) => { event.transactionProof.logIndex = 5; });
  reject("execution pool mismatch", (event) => { event.transactionProof.executionPool = "0x5555555555555555555555555555555555555555"; });
  reject("execution pool not unique", (event) => { event.sourceTrade.executionPoolCount = 2; });
  reject("execution pool not receipt verified", (event) => { event.sourceTrade.executionPoolReceiptVerified = false; });
  reject("market pair mismatch", (event) => { event.market.pairAddress = "0x5555555555555555555555555555555555555555"; });
  reject("top-level execution pair not verified", (event) => { event.executionPairVerified = false; });
  reject("swap and curve both verified", (event) => {
    event.sourceTrade.curveBuyVerified = true;
    event.transactionProof.curveBuyVerified = true;
  });
  reject("payment proof mismatch", (event) => { event.transactionProof.paymentRaw = "2"; });
  reject("position zero proof mismatch", (event) => { event.transactionProof.positionProof.previousBalanceRaw = "1"; });
  reject("first-buy action overclaims the previous-block proof", (event) => { event.action = "first_buy"; });
  reject("missing position semantics", (event) => { delete event.positionSemantics; });
  reject("lifetime first-buy overclaim", (event) => { event.positionSemantics.lifetimeFirstBuyVerified = true; });
  reject("immediate pre-transaction overclaim", (event) => { event.positionSemantics.transactionImmediatePreBalanceVerified = true; });
  reject("Fomo ownership overclaim", (event) => { event.sourceClassification.fomoOfficial = true; });
  reject("KOL tag classification mismatch", (event) => { event.sourceClassification.includesKolTag = true; });
  reject("Fomo platform spoof", (event) => { event.platform.id = "fomo"; });
  reject("non-array caller spoof", (event) => { event.callers = "@fake"; });
  reject("stale trade", (event) => { event.sourceTrade.occurredAt = new Date(Date.now() - 300_001).toISOString(); });
  for (const [label, event] of rejected) {
    assert.equal(isMonitoringSourceEnabled(monitorConfig, event), false, label);
    assert.equal(isRelevantAlert(event), false, label);
  }
});

test("smart wallet card extracts performance and omits purchase amount and Fomo/KOL identity claims", async () => {
  const event = smartWalletBuy();
  const model = deriveAlertChangeModel(event);
  assert.match(model.after.text, /高收益高胜率钱包买入 ABC/);
  assert.equal(model.before.text, "前一区块仓位: 0");
  assert.doesNotMatch(model.after.text, /@\?|金额/);

  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    alertTranslationTimeoutMs: 50,
  }, event, "高收益高胜率钱包买入");
  const rendered = renderBilingualTelegramText(bundle, true);
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
  assert.ok(rendered.split("\n").length <= 18);
  assert.ok(rendered.length < 3_800, `card is ${rendered.length} characters`);
  const languageBlocks = rendered.match(/🇨🇳 中文\n([\s\S]*?)\n\n🇬🇧 English\n([\s\S]*)$/u);
  assert.ok(languageBlocks);
  for (const block of languageBlocks.slice(1)) {
    const lines = block.split("\n").filter(Boolean);
    assert.ok(lines.length >= 4 && lines.length <= 7, `Fomo language block has ${lines.length} lines`);
    assert.ok(lines.every((line) => line.length <= 150));
  }
  assert.match(bundle.zh.text, /^平台：/m);
  assert.match(bundle.zh.text, /^更新了什么：/m);
  assert.match(bundle.en.text, /^Platform: /m);
  assert.match(bundle.en.text, /^What changed: /m);
  assert.match(rendered, /Platform: High-profit\/high-win-rate public wallet/u);
  assert.doesNotMatch(languageBlocks[2], /高收益高胜率公开钱包/u);
  assert.match(bundle.zh.text, /30D \+\$17\.5K · 胜率63\.2%\/510币 · ABC/);
  assert.match(bundle.en.text, /30d \+\$17\.5K · win 63\.2%\/510 tokens · ABC/);
  assert.match(rendered, new RegExp(TOKEN, "i"));
  assert.match(rendered, new RegExp(WALLET, "i"));
  assert.doesNotMatch(rendered, new RegExp(TX, "i"));
  assert.equal(event.transactionHash, TX, "the immutable event and transaction button retain the full hash");
  assert.doesNotMatch(rendered, /\$0\.01|Fomo|KOL|喊单|X call|绑定钱包|linked wallet/i);
  assert.match(rendered, /30D \+\$17\.5K|30d \+\$17\.5K/u);
  assert.doesNotMatch(rendered, /风险|Risk:|核验|Verification:|勿追价|do not chase|非自动交易|no automatic trading|非买入建议|not a buy recommendation|\bT[0-2]\b/iu);
  assert.doesNotMatch(rendered, /交易前仓位|首仓|first.position|lifetime first/i);
});

test("smart wallet buttons contain only contract, GMGN, transaction, and monitored-wallet actions", () => {
  const buttons = telegramButtons(smartWalletBuy()).inline_keyboard.flat();
  assert.equal(buttons.find((button) => button.text.includes("复制合约"))?.copy_text.text, TOKEN);
  assert.equal(buttons.find((button) => button.text.includes("监控钱包"))?.copy_text.text, WALLET);
  assert.equal(buttons.find((button) => button.text.includes("GMGN"))?.url, `https://gmgn.ai/bsc/token/${TOKEN}`);
  assert.equal(buttons.find((button) => button.text.includes("查看交易"))?.url, `https://bscscan.com/tx/${TX}`);
  assert.equal(buttons.some((button) => /Fomo|KOL|X/i.test(button.text)), false);
});

test("the first smart-wallet signal owns the token novelty key without a minimum amount", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "smart-wallet-dedup-"));
  let telegramCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).startsWith("https://api.telegram.org/")) telegramCalls += 1;
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: telegramCalls } }) };
  });
  t.mock.method(console, "info", () => {});
  const config = {
    ...monitorConfig,
    fomoPublishedCallEnabled: true,
    fomoPublishedCallMinXFollowers: 10_000,
    fomoPublishedCallMaxAgeMs: 120_000,
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
  assert.equal((await sendAlerts(config, smartWalletBuy())).status, "delivered");
  const second = smartWalletBuy({
    transactionHash: `0x${"b".repeat(64)}`,
    transactionUrl: `https://bscscan.com/tx/0x${"b".repeat(64)}`,
  });
  second.sourceTrade.transactionHash = second.transactionHash;
  second.positionProof.transactionHash = second.transactionHash;
  second.transactionProof.transactionHash = second.transactionHash;
  second.transactionProof.positionProof.transactionHash = second.transactionHash;
  const duplicate = await sendAlerts(config, second);
  assert.equal(duplicate.status, "suppressed");
  assert.equal(duplicate.reason, "semantic_duplicate");
  const publishedAt = new Date(Date.now() - 1_000).toISOString();
  const officialDuplicate = await sendAlerts(config, {
    type: "fomo_family_top_call",
    signalKind: "fomo_published_call",
    eventKey: "fomo-published-call:smart-wallet-duplicate",
    callId: "smart-wallet-duplicate",
    qualified: true,
    strong: true,
    source: { id: "fomo_family_official_thesis", trust: "official_authenticated_api" },
    chain: { id: 56, chainId: 56, slug: "bsc", gmgn: "bsc" },
    token: TOKEN,
    thesis: { text: `Bought ${TOKEN}`, createdAt: publishedAt },
    caller: { handle: "alpha", followers: 10_000, twitter: "https://x.com/alpha" },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true } },
    market: { liquidityUsd: 25_000 },
    publishedAt,
    observedAt: new Date().toISOString(),
  });
  assert.equal(officialDuplicate.status, "suppressed");
  assert.equal(officialDuplicate.reason, "semantic_duplicate");
  assert.equal(telegramCalls, 1);
});
