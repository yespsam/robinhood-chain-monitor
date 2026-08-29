import test from "node:test";
import assert from "node:assert/strict";

import {
  interpretBinanceOfficialUpdate,
  interpretGithubWeb3Change,
  interpretPlatformPoolChange,
  interpretTwitterWeb3Update,
} from "../src/web3-alert-interpreter.js";
import { buildBilingualAlertBundle, renderBilingualTelegramText } from "../src/bilingual-alert-renderer.js";

function github(change, extra = {}) {
  return {
    type: "github_module_update",
    repository: "binance/binance-connector-js",
    message: "Release wallet v22.2.0",
    githubChange: { primaryFact: change, facts: [change], classification: "substantive" },
    changeEvidence: [change],
    ...extra,
  };
}

test("wallet balance detail flag becomes a Web3 business explanation with literal evidence", () => {
  const change = {
    file: "clients/wallet/src/rest-api/modules/asset-api.ts",
    kind: "code_line",
    subject: "asset-api.ts",
    after: "needBalanceDetail?: boolean",
    action: "added",
  };
  const zh = interpretGithubWeb3Change(github(change), change, { language: "zh", module: "Wallet" });
  const en = interpretGithubWeb3Change(github(change), change, { language: "en", module: "Wallet" });
  assert.match(zh.summary, /钱包余额查询新增明细开关/);
  assert.match(en.summary, /wallet balance queries added a detail flag/i);
  assert.equal(zh.technical, "needBalanceDetail");
  assert.equal(zh.maintenance, false);
});

test("a client header version is maintenance rather than a product feature", () => {
  const change = {
    file: "clients/w3w-prediction/src/configuration.ts",
    kind: "code_line",
    subject: "User-Agent",
    before: "binance-w3w-prediction/2.1.0",
    after: "binance-w3w-prediction/2.1.1",
  };
  const interpreted = interpretGithubWeb3Change(github(change), change, { language: "zh", module: "Prediction" });
  assert.equal(interpreted.domain, "sdk-maintenance");
  assert.equal(interpreted.maintenance, true);
  assert.match(interpreted.summary, /未确认 Web3 产品功能/);
  assert.match(interpreted.technical, /binance-w3w-prediction 2\.1\.0 → 2\.1\.1/);
});

test("deprecated APIs are rendered as migration risk", () => {
  const change = {
    file: "clients/derivatives-trading-portfolio-margin/src/rest-api/modules/trade-api.ts",
    kind: "code_line",
    subject: "CancelAllUmOpenConditionalOrders",
    after: "CancelAllUmOpenConditionalOrders is Deprecated",
  };
  const interpreted = interpretGithubWeb3Change(github(change), change, { language: "zh", module: "Portfolio Margin" });
  assert.equal(interpreted.domain, "api-deprecation");
  assert.match(interpreted.summary, /接口 .* 已标记弃用；集成方需迁移/);
  assert.match(interpreted.technical, /Deprecated/);
});

test("API response changes explain downstream parsing impact", () => {
  const change = { kind: "response_schema", subject: "launch response", before: "pool", after: "poolAddress" };
  const interpreted = interpretGithubWeb3Change(github(change), change, { language: "zh", module: "Launchpad" });
  assert.equal(interpreted.domain, "api-schema");
  assert.match(interpreted.summary, /下游解析与类型定义需适配/);
  assert.equal(interpreted.technical, "pool → poolAddress");
});

test("docs-only deployment text never becomes a deployment claim", () => {
  const change = {
    file: "docs/morph-deployment.md",
    kind: "documentation_item",
    subject: "Morph deployment",
    after: "chainId=2818",
    action: "added",
  };
  const interpreted = interpretGithubWeb3Change(github(change), change, { language: "zh", module: "Flap" });
  assert.equal(interpreted.domain, "documentation");
  assert.match(interpreted.summary, /不等同于链上合约已部署/);
});

test("unknown diffs fail honestly instead of presenting code as business meaning", () => {
  const change = { file: "src/misc.ts", kind: "code_line", subject: "misc.ts", after: "const x = y" };
  const interpreted = interpretGithubWeb3Change(github(change), change, { language: "zh", module: "SDK" });
  assert.equal(interpreted.domain, "unknown");
  assert.match(interpreted.summary, /不足以可靠判断 Web3 业务影响/);
  assert.ok(interpreted.technical);
});

test("Flap pool categories are expressed by their Web3 purpose", () => {
  const event = {
    type: "platform_capability_update",
    changes: { newFlapPools: [{ category: "DIVIDEND", factoryAddress: "0x1111111111111111111111111111111111111111" }] },
  };
  assert.match(interpretPlatformPoolChange(event, "zh"), /持币奖励/);
  assert.match(interpretPlatformPoolChange(event, "en"), /holder-reward/i);

  const quote = structuredClone(event);
  quote.changes.newFlapPools[0] = { kind: "quote_asset", quoteAddress: "0x2222222222222222222222222222222222222222" };
  assert.match(interpretPlatformPoolChange(quote, "zh"), /定价与结算币种/);
});

test("official X quote-token updates explain launch pricing without losing the ticker", () => {
  const event = {
    type: "twitter_update",
    tweet: { text: "FLAP Quote Token updates on BNBCHAIN. $MSTRB MicroStrategy is now live on Flap." },
    signal: { labels: ["税收/募资/报价代币"] },
  };
  const zh = interpretTwitterWeb3Update(event, "zh");
  const en = interpretTwitterWeb3Update(event, "en");
  assert.match(zh, /\$MSTRB.*发币报价资产.*定价与结算/);
  assert.match(en, /\$MSTRB.*launch quote asset/i);
});

test("Binance developer endpoints become product-level API explanations", () => {
  const prediction = {
    type: "binance_official_update",
    kind: "developer_update",
    title: "Prediction Trading API 官方更新",
    keyChanges: ["POST /sapi/v1/w3w/wallet/prediction/otc/blocktrade/create: create an OTC blocktrade"],
  };
  const copy = {
    type: "binance_official_update",
    kind: "developer_update",
    title: "Copy Trading API 官方更新",
    keyChanges: ["GET /sapi/v1/copyTrading/futures/leadSymbol: get futures lead trading symbol whitelist"],
  };
  assert.match(interpretBinanceOfficialUpdate(prediction, "zh"), /Prediction OTC 大宗交易创建接口更新/);
  assert.match(interpretBinanceOfficialUpdate(copy, "zh"), /带单标的白名单查询/);
  assert.match(interpretBinanceOfficialUpdate(copy, "en"), /lead-trading symbol allowlist/i);
});

test("Binance listings, contracts, Alpha, activities, and product launches use local Web3 terminology", () => {
  const event = (title, category, project = "binance") => ({
    type: "binance_official_update",
    kind: "announcement",
    project: { id: project, name: project === "binance-wallet" ? "Binance Wallet" : "Binance" },
    title,
    signal: { category },
  });
  const spot = event("Binance Will List Example (EXM) with Seed Tag Applied", "现货上币");
  const futures = event("Binance Futures Will Launch EXMUSDT USDⓈ-Margined Perpetual Contract", "新合约上线");
  const alpha = event("EXM was added to Binance Alpha. You can trade EXM using market and limit orders.", "Alpha 上新", "binance-wallet");
  const activity = event("Binance Alpha Trading Competition: Trade EXM to Share 1,000,000 EXM", "活动公告");
  const feature = event("Binance Wallet Launches Web3 API, Enabling Developers to Build on Binance Web3 Infrastructure", "Wallet API/开发能力", "binance-wallet");

  assert.equal(interpretBinanceOfficialUpdate(spot, "zh"), "现货新增 EXM（Example）；带 Seed Tag");
  assert.match(interpretBinanceOfficialUpdate(futures, "zh"), /新增 EXMUSDT U 本位永续合约/);
  assert.match(interpretBinanceOfficialUpdate(alpha, "zh"), /Binance Alpha 新增 EXM；支持市价与限价交易/);
  assert.match(interpretBinanceOfficialUpdate(activity, "zh"), /Alpha 交易赛：交易 EXM，瓜分 1,000,000 EXM/);
  assert.match(interpretBinanceOfficialUpdate(feature, "zh"), /上线 Web3 API；开发者可接入钱包基础设施/);
  assert.match(interpretBinanceOfficialUpdate(spot, "en"), /Spot lists EXM \(Example\); Seed Tag applied/);
});

test("a real Wallet GitHub card leads with business impact and keeps exact evidence", async () => {
  const commit = "9f515f11e9b88244eb6263e27246a2767e025e4f";
  const needBalanceFact = {
    file: "clients/wallet/src/rest-api/modules/asset-api.ts",
    kind: "code_line",
    subject: "asset-api.ts",
    after: "needBalanceDetail?: boolean",
    action: "added",
  };
  const event = {
    type: "github_module_update",
    launchpad: "Binance",
    repository: "binance/binance-connector-js",
    commit,
    message: "Release wallet v22.2.0",
    files: [{ filename: needBalanceFact.file, status: "modified", additions: 15, deletions: 0 }],
    binanceChange: { classification: "api_or_schema_change", substantive: true },
    githubChange: {
      classification: "substantive",
      primaryFact: { file: "clients/wallet/src/rest-api/types/balance.ts", kind: "interface", subject: "AssetBalances", action: "added" },
      facts: [needBalanceFact],
    },
    changeEvidence: [needBalanceFact],
    committedAt: "2026-08-25T06:57:53.000Z",
  };
  const original = structuredClone(event);
  const bundle = await buildBilingualAlertBundle({}, event, "GitHub update\nTime: 2026-08-25 14:57:53");
  const rendered = renderBilingualTelegramText(bundle, true);

  assert.deepEqual(event, original);
  assert.match(bundle.zh.text, /钱包余额查询新增明细开关；SDK 调用方需适配/);
  assert.match(bundle.en.text, /wallet balance queries added a detail flag/i);
  for (const literal of ["needBalanceDetail", `binance/binance-connector-js#${commit.slice(0, 8)}`]) {
    assert.ok(bundle.zh.text.includes(literal), literal);
    assert.ok(bundle.en.text.includes(literal), literal);
  }
  assert.doesNotMatch(rendered, /英文原文|Translation unavailable/i);
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
  assert.ok(rendered.length <= 600, `card is ${rendered.length} characters`);
});

test("a misclassified client-version card is corrected to maintenance in both languages", async () => {
  const change = {
    file: "clients/w3w-prediction/src/configuration.ts",
    kind: "code_line",
    subject: "User-Agent",
    before: "binance-w3w-prediction/2.1.0",
    after: "binance-w3w-prediction/2.1.1",
  };
  const event = {
    ...github(change),
    launchpad: "Binance",
    commit: "1234567890abcdef1234567890abcdef12345678",
    binanceChange: { classification: "api_or_schema_change", substantive: true },
    committedAt: "2026-08-25T06:57:53.000Z",
  };
  const bundle = await buildBilingualAlertBundle({}, event, "GitHub update\nTime: 2026-08-25 14:57:53");
  const rendered = renderBilingualTelegramText(bundle, true);
  assert.match(bundle.zh.text, /SDK 版本 2\.1\.0→2\.1\.1；未确认 Web3 产品功能/);
  assert.match(bundle.en.text, /SDK version 2\.1\.0→2\.1\.1; no Web3 feature confirmed/);
  assert.match(bundle.zh.text, /SDK\/依赖维护已记录；未确认 Web3 产品功能变化/);
  assert.doesNotMatch(rendered, /API\/schema 变更已提交|API\/schema change committed/);
  assert.ok(rendered.length <= 600);
});

test("a Binance developer card explains the endpoint purpose locally", async () => {
  const endpoint = "POST /sapi/v1/w3w/wallet/prediction/otc/blocktrade/create";
  const event = {
    type: "binance_official_update",
    kind: "developer_update",
    project: { id: "binance-wallet", name: "Binance Wallet" },
    title: "Prediction Trading API 官方更新",
    keyChanges: [`${endpoint}: create an OTC blocktrade as the maker`],
    observedAt: "2026-08-21T07:24:15.000Z",
  };
  const bundle = await buildBilingualAlertBundle({}, event, "Binance developer update\nTime: 2026-08-21 15:24:15");
  assert.match(bundle.zh.text, /Prediction OTC 大宗交易创建接口更新/);
  assert.match(bundle.en.text, /Prediction OTC block-trade creation endpoint updated/i);
  assert.ok(bundle.zh.text.includes(endpoint));
  assert.ok(bundle.en.text.includes(endpoint));
  assert.equal(bundle.zh.provider, "local_structured");
  assert.equal(bundle.en.provider, "local_structured");
});

test("a selected API change outranks a later User-Agent version fact", () => {
  const primary = {
    file: "clients/sub-account/docs/AssetManagementApi.md",
    kind: "api_call_signature",
    subject: "getMovePositionHistoryForSubAccount",
    before: "getMovePositionHistoryForSubAccount(symbol, page, rows, startTime, endTime)",
    after: "getMovePositionHistoryForSubAccount(symbol, page, rows, productType, startTime, endTime)",
  };
  const versionFact = {
    file: "clients/sub-account/src/AccountManagementApi.java",
    kind: "code_line",
    subject: "User-Agent",
    before: "binance-sub-account/7.0.0 (Java/%s; %s; %s)",
    after: "binance-sub-account/8.0.0 (Java/%s; %s; %s)",
  };
  const limitFact = {
    file: "clients/sub-account/docs/AssetManagementApi.md",
    kind: "api_call_signature",
    subject: "default",
    before: "default(up to 1000 records)",
    after: "default(up to 100 records)",
  };
  const event = github(primary, {
    message: "Release sub-account v8.0.0",
    githubChange: { primaryFact: primary, facts: [primary, limitFact, versionFact], classification: "substantive" },
    changeEvidence: [primary, limitFact, versionFact],
    binanceChange: { classification: "api_or_schema_change", substantive: true },
  });
  const interpreted = interpretGithubWeb3Change(event, primary, {
    language: "zh",
    module: "Sub Account",
    moduleSlug: "sub-account",
    version: "v8.0.0",
  });
  assert.equal(interpreted.domain, "account-api");
  assert.match(interpreted.summary, /productType/);
  assert.match(interpreted.summary, /1000 缩至 100/);
  assert.equal(interpreted.technical, "productType · 1000 → 100");
  assert.equal(interpreted.maintenance, false);
});

test("example-only parameter changes stay examples even when a release version also changes", () => {
  const example = {
    file: "examples/fiat/src/DepositExample.java",
    kind: "api_call_signature",
    subject: "apiPaymentMethod",
    before: "apiPaymentMethod(ApiPaymentMethod.bank_transfer)",
    after: "apiPaymentMethod(ApiPaymentMethod.pix)",
  };
  const versionFact = {
    file: "clients/fiat/src/DefaultApi.java",
    kind: "code_line",
    subject: "User-Agent",
    before: "binance-fiat/3.0.0 (Java/%s; %s; %s)",
    after: "binance-fiat/3.0.1 (Java/%s; %s; %s)",
  };
  const event = github(example, {
    message: "Release fiat v3.0.1",
    githubChange: { primaryFact: example, facts: [example, versionFact], classification: "substantive" },
    changeEvidence: [example, versionFact],
    binanceChange: { classification: "api_or_schema_change", substantive: true },
  });
  const interpreted = interpretGithubWeb3Change(event, example, {
    language: "zh",
    module: "Fiat",
    moduleSlug: "fiat",
    version: "v3.0.1",
  });
  assert.equal(interpreted.domain, "documentation");
  assert.match(interpreted.summary, /示例代码已更新/);
  assert.doesNotMatch(interpreted.summary, /API 调用参数发生变化/);
});

test("routing labels and campaign token lists cannot invent an X product capability", () => {
  const campaign = {
    type: "twitter_update",
    tweet: { text: "MEME ARENA is LIVE. Trade eligible Tax Tokens and climb the daily leaderboard." },
    signal: { labels: ["税收/募资/报价代币"] },
  };
  assert.equal(interpretTwitterWeb3Update(campaign, "zh"), null);

  const quote = {
    type: "twitter_update",
    tweet: { text: "FLAP Quote Token update: BABAB is now live on Flap." },
  };
  assert.match(interpretTwitterWeb3Update(quote, "zh"), /BABAB 新增为发币报价资产/);
});

test("Vault Factory registrations use precise Web3 terminology and retain chain identity", async () => {
  const event = {
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap" },
    changes: {
      newFlapPools: [{
        kind: "vault_factory",
        category: "STAKING",
        chainId: 56,
        factoryAddress: "0x1111111111111111111111111111111111111111",
      }],
    },
    observedAt: "2026-08-25T06:57:53.000Z",
  };
  assert.match(interpretPlatformPoolChange(event, "zh"), /STAKING Vault Factory 登记/);
  const bundle = await buildBilingualAlertBundle({}, event, "Flap platform update");
  assert.match(bundle.zh.text, /chainId=56/);
  assert.match(bundle.en.text, /chainId=56/);
});

test("long Java client-version cards stay bounded and retain product plus versions", async () => {
  const versionFact = {
    file: "clients/derivatives-trading-portfolio-margin-pro/src/AccountApi.java",
    kind: "code_line",
    subject: "User-Agent",
    before: "\"binance-derivatives-trading-portfolio-margin-pro/8.0.0 (Java/%s; %s; %s)\"",
    after: "\"binance-derivatives-trading-portfolio-margin-pro/8.0.1 (Java/%s; %s; %s)\"",
  };
  const event = github(versionFact, {
    message: "Release derivatives-trading-portfolio-margin-pro v8.0.1",
    repository: "binance/binance-connector-java",
    commit: "8876c6b9980479daeb6dfdc76a0e9a2ee431b40f",
    githubChange: { primaryFact: versionFact, facts: [versionFact], classification: "substantive" },
    changeEvidence: [versionFact],
    binanceChange: { classification: "api_or_schema_change", substantive: true },
    committedAt: "2026-08-25T06:57:53.000Z",
  });
  const bundle = await buildBilingualAlertBundle({}, event, "GitHub update");
  const card = renderBilingualTelegramText(bundle, true);
  for (const literal of ["binance-derivatives-trading-portfolio-margin-pro", "8.0.0", "8.0.1"]) {
    assert.ok(card.includes(literal), literal);
  }
  assert.ok(card.length <= 600, `card is ${card.length} characters`);
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
});
