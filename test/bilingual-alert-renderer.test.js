import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildBilingualAlertBundle,
  renderBilingualTelegramText,
} from "../src/bilingual-alert-renderer.js";
import { clearTranslationCache, decodeAlertDisplayEntities } from "../src/chinese-localizer.js";
import { sendAlerts } from "../src/alerts.js";
import {
  classifyBinanceGithubChange,
  extractGithubChangeEvidence,
  parseGithubPatchFiles,
  parseGithubPatchMessage,
} from "../src/github-monitor.js";

function googleResponse(translated) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify([[[translated, "source"]], null, "auto"]),
  };
}

function translationStub(url) {
  const parsed = new URL(url);
  const target = parsed.searchParams.get("tl");
  const source = parsed.searchParams.get("q");
  if (target === "zh-CN") {
    const translated = source
      .replace("Add Vault & Router through", "新增 Vault 与 Router，调用")
      .replace("Vault & Router through", "Vault 与 Router，调用")
      .replace("introduces a new launch API", "推出新的发行 API");
    return googleResponse(/[\u3400-\u9fff]/.test(translated) ? translated : `${translated} 中文`);
  }
  return googleResponse(source
    .replace(/[\u3400-\u9fff]+/g, " official update ")
    .replace(/\s+/g, " ")
    .trim());
}

async function binanceGithubFixtureEvent(fixture, commit) {
  const patch = await fs.readFile(new URL(`./fixtures/github/${fixture}`, import.meta.url), "utf8");
  const repository = "binance/binance-connector-go";
  const message = parseGithubPatchMessage(patch);
  const rawFiles = parseGithubPatchFiles(patch);
  const changeEvidence = extractGithubChangeEvidence(rawFiles, 4, { repository, commitMessage: message });
  return {
    type: "github_module_update",
    launchpad: "Binance",
    repository,
    commit,
    message: message.split("\n")[0],
    files: rawFiles.map(({ filename, status, additions, deletions }) => ({ filename, status, additions, deletions })),
    diffStatsAvailable: false,
    changeEvidence,
    binanceChange: classifyBinanceGithubChange(repository, message, rawFiles, changeEvidence),
    sourceTrust: "official_verified",
    committedAt: "2026-08-19T13:00:00.000Z",
    observedAt: "2026-08-19T13:03:10.000Z",
  };
}

function binanceGithubProductionBase(event) {
  return [
    "🟡 Binance Wallet 代码更新",
    `具体更新: ${event.message}`,
    `关键差异: ${event.changeEvidence.map((change) => `${change.subject}: ${change.before ?? "新增"} → ${change.after ?? "已记录"}`).join("；")}`,
    `范围: Binance connector · ${event.files.map((file) => file.filename).slice(0, 3).join("；")}`,
    "状态: GitHub 代码版本发布（未确认产品上线）",
    `证据: ${event.repository}#${event.commit.slice(0, 8)}`,
    "时间: 2026-08-19 21:00:00 · 延迟3分钟",
  ].join("\n");
}

test("bilingual rendering preserves layout, entities, and protected technical identifiers", async () => {
  clearTranslationCache();
  const address = "0x1111111111111111111111111111111111111111";
  const event = {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/flap-contracts",
    commit: "a1b2c3d4",
    message: "Add Vault & Router through deployFactoryV3()",
    files: [{ filename: "src/factory.ts", status: "modified", additions: 3, deletions: 1 }],
    changeEvidence: [{ file: "src/factory.ts", kind: "function", subject: "deployFactoryV3()", action: "added" }],
    contract: address,
    observedAt: "2026-08-10T12:10:00Z",
  };
  const base = [
    "🚨 Flap 官方代码更新",
    "具体更新: Add Vault &amp; Router through deployFactoryV3()",
    "代码: flap-sh/flap-contracts · commit a1b2c3d4",
    `合约: ${address}`,
    "状态: 官方仓库代码已合并，链上部署尚未独立确认",
    "风险: 功能激活不代表代币安全",
    "时间: 2026-08-10 20:10:00",
  ].join("\n");
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: translationStub,
    alertTranslationTimeoutMs: 3_000,
  }, event, base);
  const rendered = renderBilingualTelegramText(bundle, true);

  assert.match(bundle.zh.text, /新增\s*函数 deployFactoryV3\(\)/);
  assert.doesNotMatch(rendered, /Vault & Router/);
  assert.match(bundle.en.text, /Flap｜GitHub code update/i);
  assert.doesNotMatch(rendered, /&amp;/);
  for (const literal of ["deployFactoryV3()", "flap-sh/flap-contracts", "a1b2c3d4"] ) {
    assert.match(bundle.zh.text, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(bundle.en.text, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.doesNotMatch(rendered, new RegExp(address));
  assert.equal(bundle.version, 13);
  assert.equal(bundle.format, "telegram_zh_en_compact_v10");
  assert.match(rendered, /^🔴 强提醒 \| STRONG ALERT\n🇨🇳 中文\n/);
  assert.match(rendered, /\n\n🇬🇧 English\n/);
  assert.equal(bundle.zh.text.split("\n").length, 4);
  assert.equal(bundle.en.text.split("\n").length, 4);
  assert.ok(rendered.split("\n").length <= 12);
  assert.ok(rendered.length <= 600);
  assert.equal(decodeAlertDisplayEntities("Vault &amp; Router &gt; V2"), "Vault & Router > V2");
});

test("Binance connector cards state the one concrete diff and never disguise SDK maintenance as a product feature", async () => {
  clearTranslationCache();
  const config = { alertTranslationFetchImpl: translationStub, alertTranslationTimeoutMs: 3_000 };
  const cases = [
    {
      event: await binanceGithubFixtureEvent("binance-wallet-665ca7fd.patch", "665ca7fdf188983d67c855cb9b03dbc40b92f432"),
      zh: /Wallet SDK 维护：github\.com\/binance\/binance-connector-go\/common\/v2 v2\.6\.0 → v2\.7\.0（无产品新功能）/,
      en: /Wallet SDK maintenance: github\.com\/binance\/binance-connector-go\/common\/v2 v2\.6\.0 → v2\.7\.0 \(no product feature\)/,
      evidence: "clients/wallet/go.mod",
      strong: false,
      stageZh: "SDK 维护发布已记录",
      stageEn: "SDK maintenance release recorded",
    },
    {
      event: await binanceGithubFixtureEvent("binance-alpha-3744783d.patch", "3744783d9cb92a6de8a19b5d4ed06fc7dd5b98a2"),
      zh: /Alpha v1\.7\.0：调用签名 Connect\(\) → Connect\(\[\]string\{\}\)/,
      en: /Alpha v1\.7\.0: call signature Connect\(\) → Connect\(\[\]string\{\}\)/,
      evidence: "clients/alpha/src/websocketstreams/docs/DefaultAPI.md",
      strong: true,
      stageZh: "API/schema 变更已提交，下游兼容性待验证",
      stageEn: "API/schema change committed; downstream compatibility pending",
    },
    {
      event: await binanceGithubFixtureEvent("binance-subaccount-0efaaa29.patch", "0efaaa297cd54be4e619049288aee63cde0c9270"),
      zh: /Subaccount v1\.11\.0：querySubAccountApiKey\(\) 响应字段 list → rows/,
      en: /Subaccount v1\.11\.0: querySubAccountApiKey\(\) response field list → rows/,
      evidence: "clients/subaccount/CHANGELOG.md",
      strong: true,
      stageZh: "API/schema 变更已提交，下游兼容性待验证",
      stageEn: "API/schema change committed; downstream compatibility pending",
    },
    {
      event: await binanceGithubFixtureEvent("binance-mining-1b4d14ea.patch", "1b4d14eadc66e841a03f16b7eed1e51f32e710df"),
      zh: /Mining SDK 维护：github\.com\/binance\/binance-connector-go\/common\/v2 → v2\.7\.0（无产品新功能）/,
      en: /Mining SDK maintenance: github\.com\/binance\/binance-connector-go\/common\/v2 → v2\.7\.0 \(no product feature\)/,
      evidence: "clients/mining/CHANGELOG.md",
      strong: false,
      stageZh: "SDK 维护发布已记录",
      stageEn: "SDK maintenance release recorded",
    },
  ];

  for (const item of cases) {
    item.event.strong = item.event.binanceChange.substantive;
    assert.equal(item.event.strong, item.strong);
    const bundle = await buildBilingualAlertBundle(config, item.event, "Binance official GitHub update");
    assert.match(bundle.zh.text, item.zh);
    assert.match(bundle.en.text, item.en);
    assert.ok(bundle.zh.text.includes(item.evidence), item.evidence);
    assert.ok(bundle.en.text.includes(item.evidence), item.evidence);
    assert.ok(bundle.zh.text.includes(`${item.event.repository}#${item.event.commit.slice(0, 8)}`));
    assert.ok(bundle.en.text.includes(`${item.event.repository}#${item.event.commit.slice(0, 8)}`));
    assert.ok(bundle.zh.text.includes(item.stageZh));
    assert.ok(bundle.en.text.includes(item.stageEn));
    assert.equal(bundle.zh.text.split("\n").length, 4);
    assert.equal(bundle.en.text.split("\n").length, 4);
    assert.equal(bundle.version, 13);
    assert.equal(bundle.format, "telegram_zh_en_compact_v10");
  }
});

test("all generic GitHub fact kinds render the actual delta locally instead of the commit title", async () => {
  clearTranslationCache();
  let providerCalls = 0;
  const config = {
    alertTranslationFetchImpl: async () => {
      providerCalls += 1;
      throw new Error("GitHub structured cards must not call translation");
    },
  };
  const cases = [
    ["config_value", { subject: "launchMode", before: "classic", after: "fast" }, /launchMode classic → fast/, /GitHub config update/],
    ["dependency_version", { subject: "ethers", before: "v5.7.0", after: "v6.13.0" }, /ethers v5\.7\.0 → v6\.13\.0/, /GitHub dependency update/],
    ["api_call_signature", { subject: "createPool", before: "createPool(token)", after: "createPool(token, hook)" }, /createPool\(token\) → createPool\(token, hook\)/, /GitHub code update/],
    ["response_schema", { subject: "launch response", before: "pool", after: "poolAddress" }, /launch response field pool → poolAddress/, /GitHub code update/],
    ["contract", { subject: "VaultFactoryV2", action: "added" }, /Added contract VaultFactoryV2/, /GitHub code update/],
    ["interface", { subject: "ILauncherV2", action: "added" }, /Added interface ILauncherV2/, /GitHub code update/],
    ["class", { subject: "LaunchPolicy", action: "added" }, /Added class LaunchPolicy/, /GitHub code update/],
    ["function", { subject: "deployFactoryV3()", action: "added" }, /Added function deployFactoryV3\(\)/, /GitHub code update/],
    ["list_item", { subject: "supportedChains", before: "BSC", after: "BSC, Morph" }, /supportedChains BSC → BSC, Morph/, /GitHub config update/],
    ["code_assignment", { subject: "MAX_FEE", before: "5", after: "3" }, /MAX_FEE 5 → 3/, /GitHub config update/],
    ["code_line", { subject: "route", before: "legacyRouter", after: "vaultRouter" }, /route legacyRouter → vaultRouter/, /GitHub code update/],
    ["documentation_item", { subject: "Morph deployment", action: "added", after: "chainId=2818" }, /Added Morph deployment chainId=2818/, /GitHub docs update/],
    ["file_change", { file: "src/router.ts", subject: "src/router.ts", action: "modified" }, /src\/router\.ts changed.*exact delta unresolved/, /GitHub code update/],
  ];
  for (const [kind, fact, expected, title] of cases) {
    const event = {
      type: "github_module_update",
      launchpad: "Flap",
      repository: "flap-sh/contracts",
      commit: `fact-${kind}`,
      message: "feat: misleading title-only claim",
      committedAt: "2026-08-21T01:08:00Z",
      githubChange: { primaryFact: { file: fact.file || "src/change.ts", kind, ...fact }, facts: [] },
      files: [{ filename: fact.file || "src/change.ts", status: "modified", additions: 1, deletions: 1 }],
    };
    const bundle = await buildBilingualAlertBundle(config, event, "GitHub update\n时间: 2026-08-21 09:08 CST");
    const rendered = renderBilingualTelegramText(bundle, true);
    assert.match(bundle.en.text, expected, kind);
    assert.match(bundle.en.text, title, kind);
    assert.doesNotMatch(rendered, /misleading title-only claim/, kind);
    assert.equal(bundle.zh.provider, "local_structured", kind);
    assert.equal(bundle.en.provider, "local_structured", kind);
    assert.equal(bundle.zh.text.split("\n").length, 4, kind);
    assert.equal(bundle.en.text.split("\n").length, 4, kind);
    assert.ok(rendered.length <= 600, `${kind}: ${rendered.length}`);
  }
  assert.equal(providerCalls, 0);
});

test("GitHub producer primaryFact outranks lower-ranked changeEvidence", async () => {
  const event = {
    type: "github_module_update",
    launchpad: "Four.Meme",
    repository: "four-meme/contracts",
    commit: "primary-fact-1",
    message: "feat: broad title",
    githubChange: {
      primaryFact: { file: "config/modes.ts", kind: "config_value", subject: "launchMode", before: "classic", after: "fast" },
      facts: [],
    },
    changeEvidence: [{ file: "src/api.ts", kind: "api_call_signature", subject: "launch", before: "launch(a)", after: "launch(a,b)" }],
  };
  const bundle = await buildBilingualAlertBundle({}, event, "GitHub update\n时间: 2026-08-21 09:08 CST");
  assert.match(bundle.zh.text, /launchMode classic → fast/);
  assert.match(bundle.en.text, /launchMode classic → fast/);
  assert.doesNotMatch(renderBilingualTelegramText(bundle, true), /launch\(a\).*launch\(a,b\)|broad title/);
});

test("real X docs 471b classification keeps a docs list item out of the config category", async () => {
  const event = {
    type: "github_module_update",
    launchpad: "X",
    repository: "xdevplatform/docs",
    commit: "471b000",
    message: "Add delete chat messages to the API side navigation",
    committedAt: "2026-08-21T01:08:00Z",
    githubChange: {
      scheme: "github_change_v1",
      basis: "exact_patch",
      completeness: "complete",
      classification: "documentation",
      primaryFact: {
        file: "docs.json",
        kind: "list_item",
        subject: "docs.json",
        after: "x-api/chat/delete-chat-messages",
        action: "added",
      },
      facts: [],
    },
    files: [{ filename: "docs.json", status: "modified", additions: 1, deletions: 0 }],
  };
  const bundle = await buildBilingualAlertBundle({}, event, "GitHub update\n时间: 2026-08-21 09:08 CST");
  const rendered = renderBilingualTelegramText(bundle, true);
  assert.match(bundle.zh.text, /GitHub 文档更新/);
  assert.match(bundle.en.text, /GitHub docs update/);
  assert.match(rendered, /x-api\/chat\/delete-chat-messages/);
  assert.doesNotMatch(rendered, /GitHub 配置更新|GitHub config update/);
  assert.equal(bundle.zh.text.split("\n").length, 4);
  assert.equal(bundle.en.text.split("\n").length, 4);
  assert.ok(rendered.length <= 600, `X docs 471b card was ${rendered.length}`);

  const dependencyBundle = await buildBilingualAlertBundle({}, {
    ...event,
    repository: "example/sdk",
    commit: "dependency-list",
    githubChange: {
      ...event.githubChange,
      classification: "dependency_maintenance",
      primaryFact: { file: "package.json", kind: "list_item", subject: "dependencies", after: "ethers@6", action: "added" },
    },
    files: [{ filename: "package.json", status: "modified", additions: 1, deletions: 0 }],
  }, "GitHub update\n时间: 2026-08-21 09:08 CST");
  assert.match(dependencyBundle.zh.text, /GitHub 依赖更新/);
  assert.match(dependencyBundle.en.text, /GitHub dependency update/);
});

test("real Binance Skills Hub PRs keep skill semantics, immutable revision evidence, and complete external stage", async () => {
  const fixtures = [
    {
      number: 307,
      commit: "23e6b36108ee46c49a80836b241e36cee4ef2a58",
      message: "Add aiko: multi-signal decision-fusion skill",
      files: [
        { filename: "skills/binance-web3/aiko/SKILL.md", status: "added", additions: 115, deletions: 0 },
        { filename: "skills/binance-web3/aiko/scripts/cli.mjs", status: "added", additions: 140, deletions: 0 },
      ],
      primaryFact: { file: "skills/binance-web3/aiko/scripts/cli.mjs", kind: "function", subject: "isDirectExecution", action: "added" },
      expectedZh: /新增 Aiko 技能：多信号决策融合/,
      expectedEn: /Added Aiko skill: multi-signal decision fusion/,
    },
    {
      number: 308,
      commit: "4a2ad722ce188272d9466c9a7be74aedb02ec537",
      message: "Fix CLI scripts producing no output on Windows",
      files: [
        { filename: "skills/binance-web3/binance-trading-signal/scripts/cli.mjs", status: "modified", additions: 18, deletions: 1 },
        { filename: "skills/binance-web3/crypto-market-rank/scripts/cli.mjs", status: "modified", additions: 18, deletions: 1 },
      ],
      primaryFact: { file: "skills/binance-web3/binance-trading-signal/scripts/cli.mjs", kind: "function", subject: "isDirectExecution", action: "added" },
      expectedZh: /Binance Skills CLI：新增 isDirectExecution，修复 Windows 无输出/,
      expectedEn: /Binance Skills CLI: added isDirectExecution; fixed no output on Windows/,
    },
    {
      number: 309,
      commit: "8b4028e6d3ba9e50fc2dc3686eefaf24ded9848f",
      message: "Add onchain-pay-action-ref-verify skill",
      files: [
        { filename: "skills/binance/onchain-pay-action-ref-verify/SKILL.md", status: "added", additions: 112, deletions: 0 },
        { filename: "skills/binance/onchain-pay-action-ref-verify/scripts/produce.py", status: "added", additions: 103, deletions: 0 },
      ],
      primaryFact: {
        file: "skills/binance/onchain-pay-action-ref-verify/SKILL.md",
        kind: "documentation_item",
        subject: "onchain-pay-action-ref-verify",
        after: "Derives action_ref and independently verifies its on-chain anchor",
        action: "added",
      },
      expectedZh: /新增 onchain-pay-action-ref-verify 技能：派生 action_ref 并核验链上 anchor/,
      expectedEn: /Added onchain-pay-action-ref-verify skill: derives action_ref and verifies its on-chain anchor/,
    },
  ];

  for (const fixture of fixtures) {
    const event = {
      type: "github_module_update",
      launchpad: "Binance Wallet",
      repository: "binance/binance-skills-hub",
      headCommit: fixture.commit,
      commit: `pr-${fixture.number}-fixture`,
      message: fixture.message,
      committedAt: "2026-08-20T14:28:04Z",
      files: fixture.files,
      githubChange: {
        scheme: "github_change_v1",
        completeness: "complete",
        classification: "substantive",
        primaryFact: fixture.primaryFact,
        facts: [],
      },
      pullRequest: { number: fixture.number, state: "open", draft: false, authorAssociation: "NONE" },
    };
    const bundle = await buildBilingualAlertBundle({}, event, "GitHub PR\n时间: 2026-08-20 22:28:04 · 延迟5分钟");
    const rendered = renderBilingualTelegramText(bundle, true);
    const revision = `binance/binance-skills-hub#${fixture.commit.slice(0, 8)}`;
    assert.match(bundle.zh.text, /^Binance Skills｜GitHub/u);
    assert.match(bundle.en.text, /^Binance Skills｜GitHub/u);
    assert.match(bundle.zh.text, fixture.expectedZh);
    assert.match(bundle.en.text, fixture.expectedEn);
    assert.doesNotMatch(rendered, /\bSDK\b/);
    assert.ok(bundle.zh.text.includes(revision), revision);
    assert.ok(bundle.en.text.includes(revision), revision);
    assert.match(bundle.zh.text, /阶段\/时间: 外部 PR，未合并 ·/);
    assert.match(bundle.en.text, /Stage\/Time: External PR; unmerged ·/);
    assert.doesNotMatch(bundle.zh.text.split("\n")[2], /…/);
    assert.doesNotMatch(bundle.en.text.split("\n")[2], /…/);
    assert.doesNotMatch(bundle.zh.text.split("\n")[3], /…/);
    assert.doesNotMatch(bundle.en.text.split("\n")[3], /…/);
    assert.ok(rendered.split("\n").length <= 12, `PR${fixture.number} lines=${rendered.split("\n").length}`);
    assert.ok(rendered.length <= 600, `PR${fixture.number} length=${rendered.length}`);
  }
});

test("GitHub metadata fallback is honest and a long real fixture remains four-plus-four lines under 600", async () => {
  const metadata = {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/docs",
    commit: "metadata-only",
    message: "feat: claims a launch that the patch did not expose",
    diffStatsAvailable: false,
    files: [{ filename: "README.md", status: "modified", additions: 0, deletions: 0 }],
    committedAt: "2026-08-21T01:08:00Z",
  };
  const metadataBundle = await buildBilingualAlertBundle({}, metadata, "GitHub update\n时间: 2026-08-21 09:08 CST");
  assert.match(metadataBundle.zh.text, /README\.md 已修改；精确差异未解析/);
  assert.match(metadataBundle.en.text, /README\.md changed; exact delta unresolved/);
  assert.doesNotMatch(renderBilingualTelegramText(metadataBundle, true), /claims a launch/);

  const longPath = `src/${Array.from({ length: 16 }, (_, index) => `very-long-module-${index}`).join("/")}/factory.ts`;
  const longEvent = {
    type: "github_module_update",
    launchpad: "Four.Meme",
    repository: "organization-with-a-very-long-official-name/repository-with-a-very-long-official-name",
    commit: "abcdef1234567890abcdef1234567890abcdef12",
    files: [{ filename: longPath, status: "modified", additions: 8, deletions: 4 }],
    githubChange: {
      primaryFact: {
        file: longPath,
        kind: "api_call_signature",
        subject: "deployFactoryV3",
        before: "deployFactoryV3(wallet,config)",
        after: "deployFactoryV3(wallet,config,policy)",
      },
    },
    committedAt: "2026-08-21T01:08:00Z",
  };
  const longBundle = await buildBilingualAlertBundle({}, longEvent, "GitHub update\n时间: 2026-08-21 09:08 CST");
  const rendered = renderBilingualTelegramText(longBundle, true);
  assert.equal(longBundle.zh.text.split("\n").length, 4);
  assert.equal(longBundle.en.text.split("\n").length, 4);
  for (const literal of ["deployFactoryV3(wallet,config)", "deployFactoryV3(wallet,config,policy)"]) {
    assert.ok(longBundle.zh.text.includes(literal), literal);
    assert.ok(longBundle.en.text.includes(literal), literal);
  }
  assert.ok(rendered.length <= 600, `long GitHub card was ${rendered.length}`);
});

test("Binance connector cards keep local Chinese facts and mirrored production time when both translation providers are unavailable", async () => {
  clearTranslationCache();
  let providerCalls = 0;
  const config = {
    alertTranslationUrl: "https://translate.googleapis.com/translate_a/single",
    alertTranslationFallbackUrl: "https://api.mymemory.translated.net/get",
    alertTranslationFetchImpl: async () => {
      providerCalls += 1;
      return { ok: false, status: 503, text: async () => "unavailable" };
    },
    alertTranslationTimeoutMs: 50,
  };
  const cases = [
    {
      event: await binanceGithubFixtureEvent("binance-wallet-665ca7fd.patch", "665ca7fdf188983d67c855cb9b03dbc40b92f432"),
      zh: /重点: Wallet SDK 维护：github\.com\/binance\/binance-connector-go\/common\/v2 v2\.6\.0 → v2\.7\.0（无产品新功能）/,
      stageZh: "SDK 维护发布已记录",
      stageEn: "SDK maintenance release recorded",
    },
    {
      event: await binanceGithubFixtureEvent("binance-alpha-3744783d.patch", "3744783d9cb92a6de8a19b5d4ed06fc7dd5b98a2"),
      zh: /重点: Alpha v1\.7\.0：调用签名 Connect\(\) → Connect\(\[\]string\{\}\)/,
      stageZh: "API/schema 变更已提交，下游兼容性待验证",
      stageEn: "API/schema change committed; downstream compatibility pending",
    },
    {
      event: await binanceGithubFixtureEvent("binance-subaccount-0efaaa29.patch", "0efaaa297cd54be4e619049288aee63cde0c9270"),
      zh: /重点: Subaccount v1\.11\.0：querySubAccountApiKey\(\) 响应字段 list → rows/,
      stageZh: "API/schema 变更已提交，下游兼容性待验证",
      stageEn: "API/schema change committed; downstream compatibility pending",
    },
    {
      event: await binanceGithubFixtureEvent("binance-mining-1b4d14ea.patch", "1b4d14eadc66e841a03f16b7eed1e51f32e710df"),
      zh: /重点: Mining SDK 维护：github\.com\/binance\/binance-connector-go\/common\/v2 → v2\.7\.0（无产品新功能）/,
      stageZh: "SDK 维护发布已记录",
      stageEn: "SDK maintenance release recorded",
    },
  ];

  for (const item of cases) {
    const bundle = await buildBilingualAlertBundle(config, item.event, binanceGithubProductionBase(item.event));
    const rendered = renderBilingualTelegramText(bundle, item.event.binanceChange.substantive);
    const zhStageTime = `阶段/时间: ${item.stageZh} · 2026-08-19 21:00:00 · 延迟3分钟`;
    const enStageTime = `Stage/Time: ${item.stageEn} · 2026-08-19 21:00:00 · 3m delay`;

    assert.match(bundle.zh.text, item.zh);
    assert.ok(bundle.zh.text.includes(zhStageTime), bundle.zh.text);
    assert.ok(bundle.en.text.includes(enStageTime), bundle.en.text);
    assert.equal(bundle.zh.status, "not_needed");
    assert.equal(bundle.zh.provider, "local_structured");
    assert.doesNotMatch(rendered, /英文原文|(?:重点\s*[:：]\s*)?原文\s*[:：]|Source fact \(translation pending\)|Translation pending/iu);
    assert.doesNotMatch(rendered, /2026-08-19T13:/);
    assert.equal(bundle.zh.text.split("\n").length, 4);
    assert.equal(bundle.en.text.split("\n").length, 4);
    assert.ok(rendered.length <= 600, `card is ${rendered.length} characters`);
  }
  assert.equal(providerCalls, 0, "locally structured Binance facts must not depend on either translation provider");
});

test("Binance Agent Native developer diff renders the new MCP entry without signalDigest or a launch claim", async () => {
  clearTranslationCache();
  let providerCalls = 0;
  const event = {
    type: "binance_official_update",
    kind: "developer_update",
    project: { id: "binance", name: "Binance" },
    title: "Developer 文档目录 官方更新",
    addedSignals: [
      "[/agent-native/mcp-server](/en/docs/agent-native/mcp-server.md)",
      "[Binance MCP Server](/en/docs/agent-native/mcp-server/agentic.md)",
    ],
    removedSignals: ["`GET /fapi/v1/income` — Get Income History (USER_DATA)"],
    keyChanges: ["signalDigest: old → new"],
    comparisonBasis: "exact_snapshot",
    previousSnapshot: { signalDigest: "old", signals: ["Agent Native"] },
    currentSnapshot: { signalDigest: "new", signals: ["Agent Native", "Binance MCP Server"] },
    changedFields: ["signalDigest", "signals"],
    source: { id: "binance_developer_docs", name: "Binance Developer 官方文档", url: "https://developers.binance.com/en/docs/llms.txt" },
    url: "https://developers.binance.com/en/docs/llms.txt",
    observedAt: "2026-08-20T08:16:14.299Z",
    strong: true,
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationUrl: "https://translate.invalid/primary",
    alertTranslationFallbackUrl: "https://translate.invalid/fallback",
    alertTranslationFetchImpl: async () => {
      providerCalls += 1;
      return { ok: false, status: 503, text: async () => "unavailable" };
    },
    alertTranslationTimeoutMs: 50,
  }, event, [
    "Binance Developer 文档目录更新",
    "具体更新: Binance MCP Server 文档入口新增",
    "状态: 官方文档已更新",
    "时间: 2026-08-20 16:16:14 · 延迟4秒",
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);
  assert.match(bundle.zh.text, /^Binance Agent Native｜Developer 更新/m);
  assert.match(bundle.zh.text, /重点: Agent Native 新增 Binance MCP Server 文档入口/);
  assert.match(bundle.en.text, /Key: Agent Native added a Binance MCP Server docs entry/);
  assert.match(bundle.zh.text, /证据: 官方 Developer 文档 · llms\.txt/);
  assert.match(bundle.en.text, /Evidence: Official Developer docs · llms\.txt/);
  assert.match(bundle.zh.text, /阶段\/时间: 官方文档入口已出现；产品可用范围待确认 · 2026-08-20 16:16:14 · 延迟4秒/);
  assert.match(bundle.en.text, /Stage\/Time: Official docs entry published; product availability unconfirmed · 2026-08-20 16:16:14 · 4s delay/);
  assert.doesNotMatch(rendered, /signalDigest|官方已发布|Officially published|英文原文|Translation pending/iu);
  assert.equal(bundle.zh.status, "not_needed");
  assert.equal(bundle.en.status, "not_needed");
  assert.equal(providerCalls, 0);
  assert.equal(bundle.version, 13);
  assert.equal(bundle.format, "telegram_zh_en_compact_v10");
  assert.equal(bundle.zh.text.split("\n").length, 4);
  assert.equal(bundle.en.text.split("\n").length, 4);
  assert.ok(rendered.length <= 600, `card is ${rendered.length} characters`);
});

test("official Binance X Agent OS launch renders the exact capability and release stage", async () => {
  clearTranslationCache();
  let providerCalls = 0;
  const event = {
    type: "twitter_update",
    project: {
      id: "binance",
      name: "Binance",
      handle: "binance",
      twitter: "https://x.com/binance",
      xUserId: "877807935493033984",
      match: "official_x",
      signalProfile: "binance",
    },
    tweet: {
      id: "2090380033013764166",
      handle: "binance",
      xUserId: "877807935493033984",
      authorId: "877807935493033984",
      createdAt: "2026-08-20T10:06:51Z",
      url: "https://x.com/binance/status/2090380033013764166",
      text: "Meet Agent OS - a new way to build, deploy and use AI agents on Binance. Bring Binance market intelligence, payment, on-chain, data and trading capabilities directly into your AI workflow. Build. Analyze. Trade. With AI. Experience it ↠ https://www.binance.com/agent-os",
    },
    signal: { relevant: true, strong: true, labels: ["Agent OS"] },
    observedAt: "2026-08-20T10:06:55Z",
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationUrl: "https://translate.invalid/primary",
    alertTranslationFallbackUrl: "https://translate.invalid/fallback",
    alertTranslationFetchImpl: async () => {
      providerCalls += 1;
      return { ok: false, status: 503, text: async () => "unavailable" };
    },
    alertTranslationTimeoutMs: 50,
  }, event, [
    "Binance 官方 X 更新",
    "具体更新: Agent OS 正式发布",
    "状态: 官方已发布",
    "时间: 2026-08-20 18:06:51 · 延迟1小时13分",
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);
  assert.match(bundle.zh.text, /^Binance Agent OS｜正式发布/m);
  assert.match(bundle.zh.text, /重点: AI Agent 可接入行情、支付、链上数据与交易能力/);
  assert.match(bundle.en.text, /Key: AI agents can access market intelligence, payments, on-chain data, and trading/);
  assert.match(bundle.zh.text, /证据: @binance · X#2090380033013764166/);
  assert.match(bundle.en.text, /Evidence: @binance · X#2090380033013764166/);
  assert.match(bundle.zh.text, /阶段\/时间: 官方已发布 · 2026-08-20 18:06:51 · 延迟1小时13分/);
  assert.match(bundle.en.text, /Stage\/Time: Officially published · 2026-08-20 18:06:51 · 1h13m delay/);
  assert.doesNotMatch(rendered, /链上已确认|安全|代币|on-chain confirmed|token safety|英文原文|Translation pending/iu);
  assert.equal(bundle.zh.status, "not_needed");
  assert.equal(bundle.en.status, "not_needed");
  assert.equal(providerCalls, 0);
  assert.equal(bundle.zh.text.split("\n").length, 4);
  assert.equal(bundle.en.text.split("\n").length, 4);
  assert.ok(rendered.length <= 600, `card is ${rendered.length} characters`);
});

test("official Flap Agentic Wallet skill update renders the concrete launch flow without translation latency", async () => {
  clearTranslationCache();
  let providerCalls = 0;
  const event = {
    type: "twitter_update",
    project: { id: "flap", name: "Flap", criticalProfile: "focus_launchpad" },
    tweet: {
      id: "2091136006741500374",
      handle: "flapdotsh",
      authorId: "1749114887807320064",
      createdAt: "2026-08-22T12:10:50.092Z",
      url: "https://x.com/flapdotsh/status/2091136006741500374",
      text: "Launching a token on BNB Chain is now available through Binance Agentic Wallet. Install the Flap token-launch skill and launch a token quoted against a BStock.",
    },
    signal: {
      relevant: true,
      strong: true,
      platformStructural: true,
      labels: ["Agent/Skill 集成"],
      reason: "agentic_skill_integration",
    },
    observedAt: "2026-08-22T12:10:53.513Z",
  };
  const bundle = await buildBilingualAlertBundle({
    alertForceLocalStructured: true,
    alertTranslationFetchImpl: async () => {
      providerCalls += 1;
      return { ok: false, status: 503, text: async () => "unavailable" };
    },
  }, event, [
    "Flap official X update",
    "状态: 官方 X 已发布",
    "时间: 2026-08-22 20:10:50 · 延迟3秒",
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);
  assert.match(bundle.zh.text, /^Flap｜Agent 发币入口/m);
  assert.match(bundle.zh.text, /重点: 接入 Binance Agentic Wallet；Flap token-launch skill 可对话发币，支持 BStock 报价/);
  assert.match(bundle.en.text, /Key: Binance Agentic Wallet now supports chat-based launches through the Flap token-launch skill with BStock quotes/);
  assert.match(bundle.zh.text, /证据: @flapdotsh · Post 2091136006741500374/);
  assert.match(bundle.zh.text, /阶段\/时间: 官方 X 已发布；首个链上实币待确认 · 2026-08-22 20:10:50 · 延迟3秒/);
  assert.match(bundle.en.text, /Stage\/Time: Official X post published; first live on-chain token unconfirmed · 2026-08-22 20:10:50 · 3s delay/);
  assert.doesNotMatch(rendered, /英文原文|translation pending/iu);
  assert.equal(bundle.zh.status, "not_needed");
  assert.equal(bundle.en.status, "not_needed");
  assert.equal(providerCalls, 0);
  assert.equal(bundle.zh.text.split("\n").length, 4);
  assert.equal(bundle.en.text.split("\n").length, 4);
  assert.ok(rendered.length <= 600, `card is ${rendered.length} characters`);
});

test("translation failure still produces one honest compact bilingual card", async () => {
  clearTranslationCache();
  const address = "0x2222222222222222222222222222222222222222";
  const event = {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/flap-contracts",
    commit: "deadbeef",
    message: "Expose a guarded launch path through deployFactoryV3()",
    files: [{ filename: "src/factory.ts", status: "modified", additions: 1, deletions: 1 }],
    changeEvidence: [{
      file: "src/factory.ts",
      kind: "api_call_signature",
      subject: "deployFactoryV3",
      before: "deployFactoryV3(config)",
      after: "deployFactoryV3(config, guard)",
    }],
    contract: address,
    observedAt: "2026-08-10T12:10:00Z",
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    alertTranslationTimeoutMs: 50,
  }, event, `🚨 Flap 官方代码更新\n具体更新: Expose a guarded launch path through deployFactoryV3()\n合约: ${address}\n风险: 尚未确认部署\n时间: 2026-08-10 20:10:00`);
  const rendered = renderBilingualTelegramText(bundle, true);

  assert.equal(bundle.zh.status, "not_needed");
  assert.equal(bundle.zh.provider, "local_structured");
  assert.equal(bundle.en.status, "not_needed");
  assert.doesNotMatch(rendered, /Translation unavailable|see Chinese block|翻译暂不可用/i);
  assert.match(bundle.en.text, /Flap｜GitHub code update/);
  assert.match(bundle.en.text, /flap-sh\/flap-contracts#deadbeef/);
  assert.doesNotMatch(rendered, new RegExp(address));
  assert.match(bundle.en.text, /deployFactoryV3\(config\) → deployFactoryV3\(config, guard\)/);
  assert.doesNotMatch(rendered, /ZXQ(?:KEEP|NORM)/);
  assert.equal(bundle.zh.text.split("\n").length, 4);
  assert.equal(bundle.en.text.split("\n").length, 4);
  assert.match(rendered, /🇨🇳 中文[\s\S]+🇬🇧 English/);
});

test("a platform card selects one core module and one evidence address", async () => {
  clearTranslationCache();
  const address = "0x5555555555555555555555555555555555555555";
  let providerCalls = 0;
  const event = {
    type: "platform_capability_update",
    platform: { id: "fourmeme", name: "Four.Meme" },
    changes: {
      newModules: ["VaultRouterV2"],
      newContracts: [address],
      packageVersionChanges: [{ name: "@four-meme/core", fromVersion: "1.0.8", toVersion: "1.1.0" }],
      chainStageChanges: [{
        name: "Base",
        fromStage: "supported",
        toStage: "deployed",
        after: { id: "base", name: "Base", chainId: 8453, environment: "mainnet", stage: "deployed" },
      }],
    },
    sources: ["https://four.meme/api/platform-capabilities"],
    observedAt: "2026-08-11T09:30:00Z",
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationUrl: "https://translate.googleapis.com/translate_a/single",
    alertTranslationFallbackUrl: "https://api.mymemory.translated.net/get",
    alertTranslationFetchImpl: async () => {
      providerCalls += 1;
      return { ok: false, status: 503, text: async () => "unavailable" };
    },
    alertTranslationTimeoutMs: 100,
  }, event, [
    "🧩 Four.Meme 官方能力更新",
    `具体更新: 新增 VaultRouterV2；@four-meme/core：1.0.8→1.1.0；Base主网状态：已支持→已部署；新增合约地址 ${address}`,
    "状态: 官方 API显示为已部署；尚未独立核验链上入口",
    "时间: 2026-08-11 17:30:00",
  ].join("\n"));

  assert.equal(bundle.en.status, "not_needed");
  assert.equal(providerCalls, 0, "canonical v8 facts should render locally");
  assert.match(bundle.en.text, /Key:.*VaultRouterV2/i);
  assert.match(bundle.en.text, new RegExp(`Evidence: Contract ${address}`, "i"));
  assert.match(bundle.en.text, /Officially reported deployed; on-chain entry pending/);
  assert.doesNotMatch(bundle.en.text, /@four-meme\/core|1\.0\.8|1\.1\.0|Base|8453/);
  assert.ok(renderBilingualTelegramText(bundle, true).length <= 450);
});

test("Fomo inferred first-buy card says on-chain inference, preserves the zero-position tier, and keeps Tx out of the body", async () => {
  clearTranslationCache();
  const token = "0x2222222222222222222222222222222222222222";
  const transactionHash = `0x${"1".repeat(64)}`;
  const event = {
    type: "fomo_family_top_call",
    signalKind: "top_blogger_first_buy",
    callId: `${transactionHash}:${token}`,
    caller: { handle: "alpha" },
    token,
    amountUsd: 1_250,
    transactionHash,
    transactionUrl: `https://bscscan.com/tx/${transactionHash}`,
    positionProof: {
      status: "verified",
      complete: true,
      phase: "previous_block",
      previousBalanceRaw: "0",
    },
    security: { decision: "pass", metrics: { liquidityConfirmed: true } },
    publishedAt: "2026-08-19T00:00:00Z",
    observedAt: "2026-08-19T00:00:05Z",
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    alertTranslationTimeoutMs: 50,
  }, event, "Fomo 链上信号\n重点: @alpha first buy $1,250\n时间: 2026-08-19 08:00:00 · 延迟5秒");
  const rendered = renderBilingualTelegramText(bundle, true);

  assert.match(bundle.zh.text, /^Fomo｜KOL 链上首买/m);
  assert.match(bundle.en.text, /^Fomo｜KOL on-chain first buy/m);
  assert.match(bundle.zh.text, /重点: @alpha · 买入 \$1,250/);
  assert.match(bundle.en.text, /Key: @alpha · Bought \$1,250/);
  assert.match(bundle.zh.text, new RegExp(`证据: CA ${token} · 仓位证明已核验`));
  assert.match(bundle.en.text, new RegExp(`Evidence: CA ${token} · Position proof verified`));
  assert.match(bundle.zh.text, /链上推断，非 Fomo 官方喊单；前一区块代币零仓位；安全初筛通过，非买入建议/);
  assert.match(bundle.en.text, /On-chain inference, not an official Fomo call; Token zero position at previous block; Safety screened; not a buy recommendation/);
  assert.doesNotMatch(rendered, new RegExp(transactionHash));
  assert.equal(event.transactionHash, transactionHash, "the immutable event retains the full Tx for its Telegram button");
  assert.equal(bundle.zh.text.split("\n").length, 4);
  assert.equal(bundle.en.text.split("\n").length, 4);
  assert.ok(rendered.length <= 600, `card is ${rendered.length} characters`);
});

test("BSC feature-first-token card prioritizes mode and token over addresses and keeps chain, security, and liquidity facts", async () => {
  clearTranslationCache();
  const token = "0x3333333333333333333333333333333333333333";
  const launcher = "0x4444444444444444444444444444444444444444";
  const transactionHash = `0x${"2".repeat(64)}`;
  const event = {
    type: "bsc_launchpad_update",
    kind: "new_mode",
    featureFirstToken: true,
    platform: { id: "fourmeme", name: "Four.Meme" },
    launcher,
    transactionHash,
    blockNumber: 12_345,
    tokens: [{ token, metadata: { name: "Cyber Cat", symbol: "CCAT" } }],
    mode: {
      componentMode: "TaxToken9 Charity Donation",
      templateId: "9",
      selector: "0x12345678",
    },
    security: { decision: "pass", metrics: { liquidityConfirmed: true } },
    blockTimestamp: "2026-08-19T00:00:00Z",
    observedAt: "2026-08-19T00:00:05Z",
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    alertTranslationTimeoutMs: 50,
  }, event, "Four.Meme 新模式\n重点: TaxToken9 Charity Donation\n时间: 2026-08-19 08:00:00 · 延迟5秒");
  const rendered = renderBilingualTelegramText(bundle, true);

  assert.match(bundle.zh.text, /重点: TaxToken9 Charity Donation · 首币 Cyber Cat \(CCAT\)/);
  assert.match(bundle.en.text, /Key: TaxToken9 Charity Donation · First token Cyber Cat \(CCAT\)/);
  assert.match(bundle.zh.text, new RegExp(`证据: CA ${token} · templateId=9`));
  assert.match(bundle.en.text, new RegExp(`Evidence: CA ${token} · templateId=9`));
  assert.doesNotMatch(rendered, new RegExp(launcher));
  assert.doesNotMatch(rendered, /英文原文|Source fact \(translation pending\)/);
  assert.match(bundle.zh.text, /链上已确认 · security=pass · liquidityConfirmed=true · 安全初筛通过，非买入建议/);
  assert.match(bundle.en.text, /On-chain confirmed · security=pass · liquidityConfirmed=true · Safety screening passed; not a buy recommendation/);
  assert.doesNotMatch(rendered, new RegExp(transactionHash));
  assert.equal(event.transactionHash, transactionHash);
  assert.equal(bundle.zh.text.split("\n").length, 4);
  assert.equal(bundle.en.text.split("\n").length, 4);
  assert.ok(rendered.length <= 600, `card is ${rendered.length} characters`);
});

test("Flap Agentic Wallet first-token candidate keeps complete chain evidence and honest attribution", async () => {
  clearTranslationCache();
  let providerCalls = 0;
  const token = "0x1E04612A15530516ed340b0DF7427834153f7777";
  const transactionHash = "0xffa7b15f5b8a402424fa119e1879efbd28aa34ce2f30e9ab3fa99ceffcd4f0a0";
  const event = {
    type: "bsc_launchpad_update",
    kind: "new_mode",
    featureFirstToken: true,
    featurePlatform: "flap",
    platform: { id: "flap", name: "Flap", trust: "official_verified" },
    launcher: "0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0",
    transactionHash,
    blockNumber: 117421878,
    tokens: [{ token, metadata: { name: "chAIn", symbol: "chAIn" } }],
    mode: {
      candidateKind: "flap_agentic_wallet_skill_first_token",
      componentMode: "Agentic Wallet Skill · Tax Token V3 · NVDAB",
      selector: "0x8cb5772c",
      quoteAmountDisplay: "1.283 NVDAB",
    },
    structural: { eligible: true },
    security: { decision: "unknown", metrics: { liquidityConfirmed: false } },
    blockTimestamp: "2026-08-22T12:11:54.000Z",
    observedAt: "2026-08-22T12:12:00.000Z",
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => {
      providerCalls += 1;
      throw new Error("translation must not run for structured chain evidence");
    },
    alertTranslationTimeoutMs: 50,
  }, event, "Flap Agent Skill 首币候选\n时间: 2026-08-22 20:11:54 · 延迟45分钟");
  const rendered = renderBilingualTelegramText(bundle, true);

  assert.equal(providerCalls, 0);
  assert.match(bundle.zh.text, /^Flap｜Skill首币候选/m);
  assert.match(bundle.en.text, /^Flap｜Skill token candidate/m);
  assert.match(bundle.zh.text, /chAIn · V3 · 1\.283 NVDAB/);
  assert.match(bundle.en.text, /chAIn · V3 · 1\.283 NVDAB/);
  assert.match(bundle.zh.text, new RegExp(`证据: CA ${token} · Tx ${transactionHash}`));
  assert.match(bundle.en.text, new RegExp(`Evidence: CA ${token} · Tx ${transactionHash}`));
  assert.match(bundle.zh.text, /newTokenV6#117421878；Agentic未归因，非买入建议/);
  assert.match(bundle.en.text, /newTokenV6#117421878; Agentic unverified; not buy advice/);
  assert.equal(bundle.zh.text.split("\n").length, 4);
  assert.equal(bundle.en.text.split("\n").length, 4);
  assert.ok(rendered.length <= 600, `card is ${rendered.length} characters`);
});

test("platform capability fallback excludes unchanged snapshot addresses", async () => {
  clearTranslationCache();
  const changed = "0x47a216040dc9e0afe2e6fc5dcc44f7bbd1b60d25";
  const oldQuote = "0x02fca66c1d1afb4e2e6fc5dcc44f7bbd1b60d25";
  const unrelatedContract = "0x027e3704fc5c16522e9393d04c60a3ac5c0d775f";
  const event = {
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap" },
    previous: { flapPools: [{ quoteAddress: oldQuote }], contracts: [unrelatedContract] },
    current: {
      flapPools: [{ quoteAddress: oldQuote }, { category: "BURN", vaultFactory: changed }],
      contracts: [unrelatedContract],
    },
    changes: {
      newModules: ["Vault BURN"],
      newFlapPools: [{ category: "BURN", vaultFactory: changed }],
    },
    observedAt: "2026-08-11T11:49:10Z",
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    alertTranslationTimeoutMs: 50,
  }, event, `🧩 Flap 官方能力更新\n具体更新: 新底池 BURN · Factory ${changed}\n状态: 官方页面已记录\n时间: 2026-08-11 19:49:10`);

  assert.match(bundle.en.text, new RegExp(changed));
  assert.doesNotMatch(bundle.en.text, new RegExp(oldQuote));
  assert.doesNotMatch(bundle.en.text, new RegExp(unrelatedContract));
});

test("a provider rewriting a nested chainId is rejected while the English technical line stays local and exact", async () => {
  clearTranslationCache();
  const requests = [];
  const event = {
    type: "platform_capability_update",
    changes: {
      newChains: [{ id: "base", name: "Base", chainId: 8453, environment: "mainnet", stage: "deployed" }],
    },
    observedAt: "2026-08-11T09:35:00Z",
  };
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const source = parsed.searchParams.get("q");
    requests.push(source);
    const markers = source.match(/ZXQKEEP[A-Z]+QXZ/g) || [];
    const corrupted = source.includes("8453")
      ? source.replace("8453", "8543")
      : source.replace(markers.at(-1), "8543");
    return googleResponse(parsed.searchParams.get("tl") === "zh-CN" ? `中文 ${corrupted}` : `English ${corrupted}`);
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: fetchImpl,
    alertTranslationTimeoutMs: 100,
  }, event, "具体更新: Base now supports Chain ID 8453");

  assert.ok(requests.length >= 1);
  assert.ok(requests.every((source) => !source.includes("8453")), "nested chainId must be hidden behind a protected marker");
  assert.equal(bundle.zh.status, "fallback_source");
  assert.equal(bundle.en.status, "not_needed");
  assert.match(bundle.en.provider, /local_glossary/);
  assert.match(bundle.zh.text, /8453/);
  assert.match(bundle.en.text, /8453/);
  assert.doesNotMatch(bundle.zh.text, /8543/);
  assert.doesNotMatch(bundle.en.text, /8543/);
});

test("Flap quote-pool timeout fallback stays bilingual, structured, JSON-free, and literal-safe", async () => {
  clearTranslationCache();
  const factory = "0x1111111111111111111111111111111111111111";
  const quote = "0x2222222222222222222222222222222222222222";
  const event = {
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap" },
    changes: {
      newFlapPools: [{
        category: "QUOTE",
        factoryAddress: factory,
        quoteAddress: quote,
        quoteToken: { symbol: "USDT" },
      }],
    },
    sources: ["https://flap.sh/board"],
    observedAt: "2026-08-18T09:01:00Z",
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => new Promise(() => {}),
    alertTranslationTimeoutMs: 25,
  }, event, [
    "🧩 Flap 官方能力更新",
    `具体更新: {"category":"QUOTE","factoryAddress":"${factory}","quoteAddress":"${quote}","quoteToken":{"symbol":"USDT"}}`,
    "状态: 官方页面已记录",
    "时间: 2026-08-18 17:01:00",
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);

  assert.equal(bundle.zh.status, "not_needed");
  assert.equal(bundle.en.status, "not_needed");
  for (const literal of [factory, quote]) {
    assert.ok(bundle.zh.text.includes(literal), `Chinese block lost ${literal}`);
    assert.ok(bundle.en.text.includes(literal), `English block lost ${literal}`);
  }
  for (const omitted of ["https://flap.sh/board", "USDT"]) assert.doesNotMatch(rendered, new RegExp(omitted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(bundle.zh.text, /Flap｜底池更新/);
  assert.match(bundle.en.text, /Flap｜Pool update/);
  assert.match(bundle.zh.text, /重点: 新增 QUOTE 底池/);
  assert.doesNotMatch(rendered, /Translation unavailable|see Chinese block|\[object Object\]|[\[{]\s*"[^"\n]+"\s*:/i);
  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.equal(block.split("\n").length, 4);
  }
  assert.ok(rendered.split("\n").length <= 12);
});

test("official repository discovery keeps one repository identifier without metadata walls", async () => {
  clearTranslationCache();
  const repository = "four-meme-community/fourmeme-docs";
  const url = `https://github.com/${repository}`;
  const event = {
    type: "github_repository_discovered",
    platform: { id: "fourmeme", name: "Four.Meme" },
    repository,
    repositoryMetadata: {
      description: { purpose: "TaxToken9 charity donation module", language: "Solidity" },
    },
    sourceTrust: "official_verified",
    url,
    observedAt: "2026-08-18T09:07:00Z",
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    alertTranslationTimeoutMs: 50,
  }, event, [
    "📦 Four.Meme 发现官方仓库",
    `具体更新: {"repository":"${repository}","purpose":"TaxToken9 charity donation module"}`,
    `来源: ${url}`,
    "状态: 官方组织仓库",
    "时间: 2026-08-18 17:07:00",
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);

  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.equal(block.split(repository).length - 1, 1);
    assert.doesNotMatch(block, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(block, /TaxToken9 charity donation module/);
    assert.doesNotMatch(block, /Solidity/);
  }
  assert.match(bundle.zh.text, /Four\.Meme｜新仓库/);
  assert.match(bundle.en.text, /Four\.Meme｜New repository/);
  assert.match(bundle.zh.text, /重点: 英文原文: 仓库描述：TaxToken9 charity donation module/);
  assert.match(bundle.en.text, /Key: Repository description: TaxToken9 charity donation module/);
  assert.doesNotMatch(rendered, /Translation unavailable|see Chinese block|\[object Object\]|[\[{]\s*"[^"\n]+"\s*:/i);
  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.equal(block.split("\n").length, 4);
  }
  assert.ok(rendered.split("\n").length <= 12);
});

test("representative Flap, Four.Meme, X, and Binance Wallet cards use concise canonical bilingual facts", async () => {
  clearTranslationCache();
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const target = parsed.searchParams.get("tl");
    const source = parsed.searchParams.get("q") || "";
    if (target === "zh-CN") return googleResponse(source);
    return googleResponse(source
      .replaceAll("官方能力更新", "official capability update")
      .replaceAll("官方代码更新", "official code update")
      .replaceAll("官方动态", "official news")
      .replaceAll("代码已进入官方仓库；是否发布、部署或启用尚未确认", "Code is in the official repository; release, deployment, or activation is not yet confirmed")
      .replaceAll("社交交易新功能", "new social trading function")
      .replaceAll("首次发布", "First release")
      .replaceAll("另有1项", "and 1 more")
      .replaceAll("更新", "Update")
      .replace(/[\u3400-\u9fff]+/g, " official update ")
      .replace(/\s+/g, " ")
      .trim());
  };
  const config = { alertTranslationFetchImpl: fetchImpl, alertTranslationTimeoutMs: 500 };
  const factory = "0x1111111111111111111111111111111111111111";
  const quote = "0x2222222222222222222222222222222222222222";
  const flapEvent = {
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap" },
    changes: { newFlapPools: [{ category: "quote_asset", vaultFactory: factory, quoteAddress: quote, quoteToken: { symbol: "USD1" } }] },
    sources: ["https://flap.sh/board"],
    observedAt: "2026-08-18T09:01:00Z",
  };
  const githubEvent = {
    type: "github_module_update",
    launchpad: "Four.Meme",
    repository: "four-meme-community/fourmeme-docs",
    commit: "6748033c63e3f68b9ef6fba709783181c9a95792",
    message: "feat: add TaxToken9 charity donation feature",
    files: [{ filename: "docs/charity/TaxToken9.md", status: "added" }],
    sourceTrust: "official_verified",
    observedAt: "2026-08-18T09:07:00Z",
  };
  const xEvent = {
    type: "twitter_update",
    project: { id: "fourmeme", name: "Four.Meme" },
    tweet: {
      id: "2089553165817667830",
      handle: "fourdotmemezh",
      text: "TaxToken9 Charity Donation feature is now live. Transaction taxes can go to Giggle or Binance Charity.",
      createdAt: "2026-08-18T03:21:00Z",
      url: "https://x.com/fourdotmemezh/status/2089553165817667830",
    },
    signal: {
      headline: "TaxToken9 Charity Donation feature is now live",
      keyChanges: ["Transaction taxes can go to Giggle or Binance Charity", "Charity Badge added", "On-chain Charity Dashboard added"],
    },
    observedAt: "2026-08-18T03:21:25Z",
  };
  const binanceEvent = {
    type: "binance_official_update",
    kind: "announcement",
    strong: true,
    project: { id: "binance-wallet", name: "Binance Wallet" },
    signal: { scope: "wallet", category: "社交交易新功能", labels: ["Wallet 社交交易新功能"] },
    title: "Binance Wallet introduces KOL Trade Thesis sharing after an on-chain buy",
    keyChanges: ["Eligible KOLs can publish a Trade Thesis after buying", "Followers can open the token page from the call"],
    publishedAt: "2026-08-18T04:00:00Z",
    observedAt: "2026-08-18T04:00:20Z",
    url: "https://www.binance.com/en/support/announcement/example",
    source: {
      name: "Binance Wallet 官方公告",
      url: "https://www.binance.com/en/support/announcement/example",
    },
  };
  const cards = {
    flap: await buildBilingualAlertBundle(config, flapEvent, [
      "🧩 Flap 官方能力更新",
      `具体更新: 新增底池: quote_asset · Factory ${factory} · 报价 USD1 ${quote}`,
      "状态: 官方页面已记录；链上部署/实际启用尚未确认",
      "时间: 2026-08-18 17:01:00",
    ].join("\n")),
    github: await buildBilingualAlertBundle(config, githubEvent, [
      "🧱 Four.Meme 官方代码更新",
      "具体更新: feat: add TaxToken9 charity donation feature",
      "状态: 代码已进入官方仓库；是否发布、部署或启用尚未确认",
      "时间: 2026-08-18 17:07:00",
    ].join("\n")),
    x: await buildBilingualAlertBundle(config, xEvent, [
      "𝕏 Four.Meme 官方动态",
      "具体更新: TaxToken9 Charity Donation feature is now live",
      "关键变化: Transaction taxes can go to Giggle or Binance Charity；Charity Badge added；On-chain Charity Dashboard added",
      "状态: 官方 X 明示已上线；链上/合约启用尚未独立核验",
      "时间: 2026-08-18 11:21:00 · 延迟25秒",
    ].join("\n")),
    binance: await buildBilingualAlertBundle(config, binanceEvent, [
      "🚨 Binance Wallet 更新",
      "结论: Wallet 社交交易新功能",
      "事件: Binance Wallet introduces KOL Trade Thesis sharing after an on-chain buy",
      "重点: Eligible KOLs can publish a Trade Thesis after buying；Followers can open the token page from the call",
      "时间: 2026-08-18 12:00:00 · 延迟20秒",
    ].join("\n")),
  };

  for (const [name, bundle] of Object.entries(cards)) {
    const rendered = renderBilingualTelegramText(bundle, true);
    for (const block of [bundle.zh.text, bundle.en.text]) {
      assert.equal(block.split("\n").length, 4, name);
    }
    assert.ok(rendered.split("\n").length <= 12, name);
    assert.ok(rendered.length <= (["github", "flap"].includes(name) ? 600 : 450), name);
    assert.doesNotMatch(rendered, /Translation unavailable|see Chinese block|\[object Object\]|[\[{]\s*"[^"\n]+"\s*:/i, name);
  }

  for (const block of [cards.flap.zh.text, cards.flap.en.text]) {
    assert.equal(block.split(factory).length - 1, 1, "Flap Factory must render once");
    assert.equal(block.split(quote).length - 1, 1, "Flap quote must render once");
    assert.doesNotMatch(block, /quote(?:Token)?[^\n]*…/i);
  }
  assert.match(cards.github.zh.text, /重点: docs\/charity\/TaxToken9\.md 已新增；精确内容未解析/);
  assert.doesNotMatch(cards.github.zh.text, /feat:\s*add|charity donation feature/i);
  assert.match(cards.x.zh.text, /TaxToken9 慈善捐赠功能现已上线/);
  assert.doesNotMatch(cards.x.zh.text, /Charity Badge|Charity Dashboard|另有\d+项/);
  assert.doesNotMatch(cards.x.zh.text, /币安慈善/);
  assert.match(cards.x.en.text, /Officially stated live/);
  assert.doesNotMatch(cards.x.en.text, /has been stated|official news/i);
  assert.match(cards.binance.zh.text, /重点: KOL 买入后可发布 Trade Thesis/);
  assert.doesNotMatch(cards.binance.zh.text, /introduces KOL|Eligible KOLs can publish/i);
  assert.match(cards.binance.en.text, /Key: KOL can publish a post-buy Trade Thesis/i);
  assert.doesNotMatch(cards.binance.en.text, /social trading function/i);
  for (const block of [cards.binance.zh.text, cards.binance.en.text]) {
    assert.equal(block.split("Trade Thesis").length - 1, 1, "Trade Thesis should appear once per language");
    assert.equal(block.split("Binance Wallet").length - 1, 1, "the product name should not repeat outside the title");
    assert.doesNotMatch(block, /另有\d+项|\+\d+ more|and \d+ more/i);
  }
  assert.ok(renderBilingualTelegramText(cards.binance, true).length <= 450);
});

test("Binance funding notices lead with the actual rule change instead of an internal version", async () => {
  clearTranslationCache();
  const event = {
    type: "binance_official_update",
    kind: "announcement",
    project: { id: "binance", name: "Binance" },
    signal: { scope: "exchange", category: "交易规则", labels: ["交易规则调整"] },
    article: { code: "1309b6acfdb04b9f81d4547da49f1cbd", version: "1" },
    title: "Important Updates on the Funding Rate of USDⓈ-M UNITREEUSDT Perpetual Contract (2026-08-19)",
    announcementDetails: {
      kind: "funding_interval",
      instrument: "UNITREEUSDT",
      previousHours: 8,
      currentHours: 4,
      effectiveAt: "2026-08-19T08:15:00.000Z",
      fundingRateCap: "+2.00%",
      fundingRateFloor: "-2.00%",
    },
    currentSnapshot: {
      title: "Important Updates on the Funding Rate of USDⓈ-M UNITREEUSDT Perpetual Contract (2026-08-19)",
      facts: ["Effective from 2026-08-19 08:15 (UTC), the funding interval changes from every eight hours to every four hours."],
      version: "1",
    },
    publishedAt: "2026-08-19T06:45:01.476Z",
    observedAt: "2026-08-19T06:46:28.576Z",
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: translationStub,
    alertTranslationTimeoutMs: 3_000,
  }, event, [
    "Binance 交易所官方公告",
    "重点: UNITREEUSDT funding interval update",
    "状态: 官方公告已发布",
    "时间: 2026-08-19 14:45:01 · 延迟1分钟",
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, false);

  assert.equal(bundle.version, 13);
  assert.equal(bundle.format, "telegram_zh_en_compact_v10");
  assert.match(bundle.zh.text, /Binance Futures｜资金费率调整/);
  assert.match(bundle.zh.text, /重点: UNITREEUSDT 永续：8小时→4小时，费率上下限 \+2\.00%\/-2\.00%/);
  assert.match(bundle.zh.text, /证据: 官方公告 · 1309b6ac/);
  assert.match(bundle.zh.text, /北京时间 08-19 16:15 生效/);
  assert.match(bundle.en.text, /Key: UNITREEUSDT perpetual: 8h→4h, funding cap\/floor \+2\.00%\/-2\.00%/);
  assert.doesNotMatch(rendered, /重点:.*版本|Key:.*version/i);
  assert.equal(bundle.zh.text.split("\n").length, 4);
  assert.equal(bundle.en.text.split("\n").length, 4);
  assert.ok(rendered.length <= 600);
});

test("real hooklist registrations distinguish the Hook file address from an unresolved related address", async (t) => {
  clearTranslationCache();
  const hookAddress = "0xd623b79a6d49ed38c6b0183caca7612d41eb90cc";
  const relatedAddress = "0x9eb2b58df71d545260d5db857da0ab5b461e6559";
  const commit = "ec570acedc8507707451239b945270dd9ce98509";
  const url = `https://github.com/Uniswap/hooklist/commit/${commit}`;
  const event = {
    type: "github_module_update",
    launchpad: "Uniswap",
    repository: "Uniswap/hooklist",
    sourceTrust: "official_verified",
    uniswapOfficial: true,
    commit,
    message: "Add MemeRaceHook hook on robinhood",
    committedAt: new Date(Date.now() - 1_000).toISOString(),
    files: [{ filename: `hooks/robinhood/${hookAddress}.json`, status: "added" }],
    newContracts: [relatedAddress],
    changeEvidence: [
      { file: `hooks/robinhood/${hookAddress}.json`, kind: "config_value", subject: "chainId", before: null, after: "4663" },
      { file: `hooks/robinhood/${hookAddress}.json`, kind: "config_value", subject: "dynamicFee", before: null, after: "false" },
    ],
    strong: true,
    url,
    observedAt: new Date().toISOString(),
  };
  const original = structuredClone(event);
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: translationStub,
    alertTranslationTimeoutMs: 500,
  }, event, [
    "🧱 Uniswap 官方代码更新",
    "具体更新: Add MemeRaceHook hook on robinhood",
    "状态: 代码已进入官方仓库",
    "时间: 2026-08-19 00:45:42 · 延迟11秒",
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);

  assert.deepEqual(event, original);
  assert.equal(bundle.version, 13);
  assert.equal(bundle.format, "telegram_zh_en_compact_v10");
  assert.match(bundle.zh.text, /Uniswap hooklist｜新增登记/);
  assert.match(bundle.en.text, /Uniswap hooklist｜Registry entry/);
  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.equal(block.split("\n").length, 4);
    assert.match(block, /MemeRaceHook→Robinhood·chainId=4663·dynamicFee=false/);
    assert.match(block, new RegExp(`Hook ${hookAddress}`));
    assert.match(block, new RegExp(relatedAddress));
    assert.match(block, /#ec570ace/);
    assert.doesNotMatch(block, new RegExp(commit));
    assert.doesNotMatch(block, /hooks\/robinhood|\+\d+ more|另有\d+项/);
  }
  assert.match(bundle.zh.text, /关联 .*（角色未解析）/);
  assert.match(bundle.en.text, /Related .*\(role unresolved\)/);
  assert.equal((bundle.zh.text.match(/Hook 0x/g) || []).length, 1);
  assert.equal((bundle.en.text.match(/Hook 0x/g) || []).length, 1);
  assert.doesNotMatch(rendered, new RegExp(url.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(rendered, /deployed|deployment confirmed|已部署|部署已确认/i);
  assert.doesNotMatch(rendered, /ZXQ(?:KEEP|NORM)/);
  assert.ok(rendered.length <= 600, `dual-address hook card was ${rendered.length} characters`);

  const ordinary = structuredClone(event);
  ordinary.commit = "137dc7d62f2cc3bdd34a13359b4c97c71b633c79";
  ordinary.message = "Add Spot hook on robinhood";
  ordinary.files = [{ filename: "hooks/robinhood/0xb4f4949e8d0a177bb6d2fea33e9516bb219610cc.json", status: "added" }];
  ordinary.newContracts = [];
  ordinary.changeEvidence = [
    { subject: "chainId", after: "4663" },
    { subject: "dynamicFee", after: "true" },
  ];
  ordinary.url = `https://github.com/Uniswap/hooklist/commit/${ordinary.commit}`;
  const ordinaryBundle = await buildBilingualAlertBundle({}, ordinary,
    "Uniswap GitHub\n具体更新: Add Spot hook on robinhood\n时间: 2026-08-19 00:45:42 · 延迟11秒");
  const ordinaryRendered = renderBilingualTelegramText(ordinaryBundle, true);
  assert.match(ordinaryRendered, /Spot→Robinhood·chainId=4663·dynamicFee=true/);
  assert.match(ordinaryRendered, /Hook 0xb4f4949e8d0a177bb6d2fea33e9516bb219610cc/);
  assert.doesNotMatch(ordinaryRendered, /Related|关联/);
  assert.ok(ordinaryRendered.length <= 600);

  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-hooklist-v8-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let payload;
  t.mock.method(globalThis, "fetch", async (_requestUrl, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 811 } }) };
  });
  t.mock.method(console, "info", () => {});
  const result = await sendAlerts({
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "test-token",
    telegramChatId: "123456789",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertTranslationFetchImpl: translationStub,
    alertTranslationTimeoutMs: 500,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
  }, event);
  assert.equal(result.status, "delivered");
  assert.ok(payload.reply_markup.inline_keyboard.flat().some((button) => button.url === url));
  assert.match(payload.text, /#ec570ace/);
  assert.doesNotMatch(payload.text, new RegExp(commit));
  assert.deepEqual(event, original, "rendering and delivery must not mutate the immutable source event");
});

test("an Uniswap blog article never inherits a false live stage or observedAt as publication time", async () => {
  clearTranslationCache();
  const observedAt = "2026-08-18T13:09:14.352Z";
  const event = {
    type: "uniswap_official_update",
    kind: "blog",
    title: "Correlated pairs market structure",
    summary: "A market structure research article",
    url: "https://blog.uniswap.org/correlated-pairs-market-structure",
    publishedAt: null,
    lastmod: "2026-08-18",
    stage: "live",
    stageLabel: "官方原文明确已上线",
    deploymentConfirmed: true,
    observedAt,
  };
  const fetchImpl = async (requestUrl) => {
    const target = new URL(requestUrl).searchParams.get("tl");
    return googleResponse(target === "zh-CN" ? "相关资产市场结构" : "Correlated pairs market structure");
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: fetchImpl,
    alertTranslationTimeoutMs: 500,
  }, event, [
    "🦄 Uniswap 官方发布",
    "具体更新: Correlated pairs market structure",
    "状态: 官方原文明确已上线",
    `时间: ${observedAt}`,
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);
  assert.match(bundle.zh.text, /阶段\/时间: 文章已发布；功能上线未证实 · 原文时间未取得/);
  assert.match(bundle.en.text, /Stage\/Time: Article published; feature launch unverified · Source publication time unavailable/);
  assert.match(bundle.zh.text, /证据: 官方博客/);
  assert.match(bundle.en.text, /Evidence: Official blog/);
  assert.doesNotMatch(rendered, /Officially stated live|官方称已上线|deployment confirmed|部署已确认/i);
  assert.doesNotMatch(rendered, new RegExp(observedAt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.ok(rendered.length <= 450);
});

test("GitHub PR stage distinguishes external proposals from trusted collaborators", async () => {
  const base = {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/contracts",
    commit: "pr-42-head",
    files: [{ filename: "src/vault.ts", status: "modified" }],
    changeEvidence: [{ file: "src/vault.ts", kind: "function", subject: "createVaultV2()", action: "added" }],
    committedAt: "2026-08-21T01:08:00Z",
  };
  const external = await buildBilingualAlertBundle({}, {
    ...base,
    pullRequest: { number: 42, draft: false, authorAssociation: "CONTRIBUTOR" },
  }, "GitHub PR\n时间: 2026-08-21 09:08 CST");
  assert.match(external.zh.text, /外部 PR，未合并/);
  assert.match(external.en.text, /External PR; unmerged/);

  const trusted = await buildBilingualAlertBundle({}, {
    ...base,
    commit: "pr-43-head",
    pullRequest: { number: 43, draft: false, authorAssociation: "MEMBER" },
  }, "GitHub PR\n时间: 2026-08-21 09:08 CST");
  assert.match(trusted.zh.text, /PR 开放，未合并/);
  assert.match(trusted.en.text, /PR open; not merged/);
});

test("Uniswap GitHub releases lead with the first concrete summary item and degrade honestly without one", async () => {
  clearTranslationCache();
  const event = {
    type: "uniswap_official_update",
    kind: "github_release",
    title: "Uniswap Hooks SDK v4.2.0",
    tag: "v4.2.0",
    summary: "Added: Robinhood hooks support; Changed: default fee validation",
    url: "https://github.com/Uniswap/hooks/releases/tag/v4.2.0",
    publishedAt: "2026-08-21T01:08:00Z",
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async (url) => {
      const parsed = new URL(url);
      const source = parsed.searchParams.get("q") || "";
      return googleResponse(parsed.searchParams.get("tl") === "zh-CN"
        ? source.replace("Added", "新增").replace("support", "支持")
        : source);
    },
    alertTranslationTimeoutMs: 500,
  }, event, "Uniswap release\n时间: 2026-08-21 09:08 CST");
  assert.match(bundle.zh.text, /^Uniswap｜GitHub Release/m);
  assert.match(bundle.en.text, /^Uniswap｜GitHub Release/m);
  assert.match(bundle.zh.text, /重点: 新增: Robinhood hooks 支持/);
  assert.match(bundle.en.text, /Key: Added: Robinhood hooks support/);
  assert.doesNotMatch(renderBilingualTelegramText(bundle, true), /default fee validation/);
  assert.match(bundle.en.text, /GitHub Release published; product deployment unconfirmed/);

  const fallback = await buildBilingualAlertBundle({}, { ...event, summary: "" }, "Uniswap release\n时间: 2026-08-21 09:08 CST");
  assert.match(fallback.zh.text, /v4\.2\.0：Release 详情未取得/);
  assert.match(fallback.en.text, /v4\.2\.0: release details unavailable/);
});

test("GitHub local structured rendering never invokes an injected translation marker", async () => {
  clearTranslationCache();
  let providerCalls = 0;
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => {
      providerCalls += 1;
      return googleResponse("ZXQNORMAQXZ 中文");
    },
    alertTranslationTimeoutMs: 100,
  }, {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/flap-contracts",
    commit: "abcdef1234567890abcdef1234567890abcdef12",
    message: "Expose guarded launch routing",
  }, "Flap GitHub\n具体更新: Expose guarded launch routing\n时间: 2026-08-19 01:00:00");
  const rendered = renderBilingualTelegramText(bundle, true);
  assert.equal(bundle.zh.status, "not_needed");
  assert.equal(bundle.zh.provider, "local_structured");
  assert.equal(providerCalls, 0);
  assert.doesNotMatch(rendered, /ZXQ(?:KEEP|NORM)[A-Z0-9]+QXZ/i);
  assert.equal(bundle.zh.text.split("\n").length, 4);
  assert.equal(bundle.en.text.split("\n").length, 4);
});

test("Telegram news renders a translated four-fact channel lead and can never become a strong alert", async () => {
  clearTranslationCache();
  let providerCalls = 0;
  const event = {
    type: "telegram_news_update",
    eventKey: "telegram-news:-1002540748528:4821:0123456789abcdef",
    source: {
      id: "telegram_public_channel",
      name: "Telegram 公开频道 · @maxguruai",
      url: "https://t.me/s/maxguruai",
      trust: "public_telegram_observed",
    },
    sourceTrust: "public_telegram_observed",
    channel: {
      chatId: "-1002540748528",
      username: "maxguruai",
      title: "UNTRUSTED CHANNEL TITLE",
      visibility: "public",
    },
    title: "Headline copied from the producer",
    messageId: 4821,
    messageUrl: "https://t.me/maxguruai/4821",
    sourceOccurredAt: "2026-08-24T02:03:04.000Z",
    observedAt: "2026-08-24T02:03:05.000Z",
    news: {
      category: "AI Agent",
      headline: "Headline copied from the producer",
      summary: "MCP v2.1 adds guarded routing through triggerFeeUpdate()",
      externalUrls: ["https://example.invalid/story"],
      storyKey: "ai-agent-routing",
      confidence: "observed",
    },
    message: "RAW TELEGRAM FULL TEXT MUST NOT APPEAR",
    author: { username: "unverified_author" },
    contentDigest: "1".repeat(64),
    strong: true,
  };
  const snapshot = structuredClone(event);
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async (url) => {
      providerCalls += 1;
      const parsed = new URL(url);
      const source = parsed.searchParams.get("q") || "";
      return googleResponse(source.replace("adds guarded routing through", "新增受保护路由，调用"));
    },
    alertTranslationTimeoutMs: 500,
  }, event, [
    "Telegram public channel update",
    "内容: RAW TELEGRAM FULL TEXT MUST NOT APPEAR",
    "时间: 2099-01-01T00:00:00.000Z",
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);
  const zh = bundle.zh.text.split("\n");
  const en = bundle.en.text.split("\n");

  assert.ok(providerCalls > 0, "the existing translation provider path must be preferred");
  assert.equal(bundle.version, 13, "the new event does not require a global render-version bump");
  assert.equal(bundle.eventType, "telegram_news_update");
  assert.equal(bundle.focusModel.telegramNews.messageUrl, event.messageUrl);
  assert.equal(zh.length, 4);
  assert.equal(en.length, 4);
  assert.match(zh[0], /^频道线索｜分类: AI Agent · .*MCP v2\.1.*triggerFeeUpdate\(\)/u);
  assert.match(en[0], /^Channel lead \| Classification: AI Agent · .*MCP v2\.1.*triggerFeeUpdate\(\)/u);
  assert.equal(zh[1], "来源: @maxguruai#4821");
  assert.equal(en[1], "Source: @maxguruai#4821");
  assert.equal(zh[2], "阶段: 公开频道观察，待官方核实");
  assert.equal(en[2], "Stage: Public-channel observation; awaiting official verification");
  assert.equal(zh[3], "时间: 2026-08-24T02:03:04.000Z");
  assert.equal(en[3], "Time: 2026-08-24T02:03:04.000Z");
  assert.match(rendered, /^🔔 监控提醒 \| MONITOR ALERT\n/u);
  assert.doesNotMatch(rendered, /STRONG ALERT|RAW TELEGRAM|UNTRUSTED CHANNEL|unverified_author/);
  assert.ok(rendered.length <= 600, `Telegram news card length=${rendered.length}`);
  assert.deepEqual(event, snapshot, "rendering must not mutate the Telegram event");
});

test("Telegram news falls back honestly in either direction when both translation providers return 503", async () => {
  const unavailable = async () => {
    return { ok: false, status: 503, text: async () => "service unavailable" };
  };
  const unavailableConfig = {
    alertTranslationFetchImpl: unavailable,
    alertTranslationFallbackUrl: "https://api.mymemory.translated.net/get",
    alertTranslationTimeoutMs: 100,
  };
  const common = {
    type: "telegram_news_update",
    messageId: 4822,
    messageUrl: "https://t.me/maxguruai/4822",
    sourceTrust: "public_telegram_observed",
    channel: { username: "maxguruai", visibility: "public" },
    sourceOccurredAt: "2026-08-24T02:04:05.000Z",
    strong: true,
  };

  clearTranslationCache();
  const englishSource = await buildBilingualAlertBundle(unavailableConfig, {
    ...common,
    news: {
      category: "Protocol",
      summary: "MCP v2.1 adds triggerFeeUpdate() support",
      confidence: "observed",
    },
  }, "Telegram channel observation");
  assert.match(englishSource.zh.text.split("\n")[0], /^频道线索｜.*翻译暂不可用，原文: .*MCP v2\.1.*triggerFeeUpdate\(\)/u);
  assert.match(englishSource.en.text.split("\n")[0], /^Channel lead \| Classification:/u);

  clearTranslationCache();
  const chineseSource = await buildBilingualAlertBundle(unavailableConfig, {
    ...common,
    news: {
      category: "协议更新",
      summary: "MCP v2.1 新增 triggerFeeUpdate() 支持",
      confidence: "observed",
    },
  }, "Telegram 公开频道观察");
  const rendered = renderBilingualTelegramText(chineseSource, true);
  assert.match(chineseSource.en.text.split("\n")[0], /^Channel lead \| Translation unavailable; source: .*MCP v2\.1.*triggerFeeUpdate\(\)/u);
  for (const block of [englishSource, chineseSource]) {
    assert.equal(block.zh.status === "fallback_source" || block.en.status === "fallback_source", true);
    assert.match(`${block.zh.provider} ${block.en.provider}`, /google_gtx_public\+mymemory_public/u);
    assert.equal(block.zh.text.split("\n")[1], "来源: @maxguruai#4822");
    assert.equal(block.en.text.split("\n")[1], "Source: @maxguruai#4822");
    assert.equal(block.zh.text.split("\n")[2], "阶段: 公开频道观察，待官方核实");
    assert.equal(block.en.text.split("\n")[2], "Stage: Public-channel observation; awaiting official verification");
    assert.equal(block.zh.text.split("\n").length, 4);
    assert.equal(block.en.text.split("\n").length, 4);
    assert.ok(renderBilingualTelegramText(block, true).length <= 600);
  }
  assert.match(rendered, /^🔔 监控提醒 \| MONITOR ALERT\n/u);
});

test("every supported Telegram event type uses the same compact bilingual envelope", async () => {
  clearTranslationCache();
  const eventTypes = [
    "bsc_launchpad_update",
    "fomo_family_top_call",
    "uniswap_official_update",
    "ai_official_update",
    "platform_capability_update",
    "twitter_update",
    "github_module_update",
    "github_monitor_gap",
    "github_repository_discovered",
    "github_repository_verified",
    "launchpad_site_update",
    "binance_official_update",
    "pons_v2_factory_discovered",
    "pons_v2_factory_status_update",
    "early_activity_alert",
    "official_activity",
    "token_launch",
    "contract_deployed",
    "telegram_news_update",
  ];

  for (const type of eventTypes) {
    const event = {
      type,
      platform: { id: "test-platform", name: "Test Platform" },
      message: "Introduces a new verified module through deployFactoryV3()",
      observedAt: "2026-08-10T12:10:00Z",
    };
    const bundle = await buildBilingualAlertBundle({
      alertTranslationFetchImpl: translationStub,
      alertTranslationTimeoutMs: 3_000,
    }, event, [
      `🚨 ${type} 官方监控`,
      "具体更新: Introduces a new verified module through deployFactoryV3()",
      "状态: 官方来源已确认，链上激活待核验",
      "风险: 监控信号不等于买入建议",
      "时间: 2026-08-10 20:10:00",
    ].join("\n"));
    const rendered = renderBilingualTelegramText(bundle, false);

    assert.equal(bundle.version, 13, type);
    assert.equal(bundle.format, "telegram_zh_en_compact_v10", type);
    assert.match(bundle.zh.text, /[\u3400-\u9fff]/, type);
    assert.match(bundle.en.text, /[A-Za-z]{3,}/, type);
    assert.match(rendered, /^🔔 监控提醒 \| MONITOR ALERT\n🇨🇳 中文\n/, type);
    assert.match(rendered, /\n\n🇬🇧 English\n/, type);
    assert.equal(bundle.zh.text.split("\n").length, 4, type);
    assert.equal(bundle.en.text.split("\n").length, 4, type);
    assert.ok(rendered.split("\n").length <= 12, type);
    assert.ok(rendered.length <= 600, type);
  }
});

test("every bilingual alert persists a one-glance before/after model in the same order", async () => {
  clearTranslationCache();
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: translationStub,
    alertTranslationTimeoutMs: 3_000,
  }, {
    type: "binance_official_update",
    kind: "announcement",
    previousSnapshot: { title: "Wallet API v1", facts: ["One route"] },
    currentSnapshot: { title: "Wallet API v2", facts: ["Two routes"] },
    changedFields: ["title", "facts"],
    comparisonBasis: "exact_snapshot",
    source: { name: "Binance Wallet 官方公告" },
  }, "🚨 Binance Wallet 更新\n事件: Wallet API v2\n状态: 官方公告已确认\n时间: 2026-08-13 00:00:00");

  assert.equal(bundle.version, 13);
  assert.equal(bundle.format, "telegram_zh_en_compact_v10");
  assert.equal(bundle.changeModel.basis, "exact_snapshot");
  assert.match(bundle.zh.text, /重点:.*Wallet API v1.*→.*Wallet API v2/);
  assert.match(bundle.en.text, /Key:.*Wallet API v1.*→.*Wallet API v2/i);
  assert.doesNotMatch(bundle.zh.text, /变化类型:|原有:|更新后:|对比依据:/);
  assert.doesNotMatch(bundle.en.text, /Change type:|Before:|After:|Comparison basis:/i);
  assert.match(bundle.zh.text, /Wallet API v1/);
  assert.match(bundle.zh.text, /Wallet API v2/);
});

test("translation outage keeps the same before/after model in the English fallback", async () => {
  clearTranslationCache();
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => ({ ok: false, status: 503, text: async () => "unavailable" }),
    alertTranslationTimeoutMs: 50,
  }, {
    type: "ai_official_update",
    previousSnapshot: { stage: "preview", title: "Grok API v1" },
    currentSnapshot: { stage: "available", title: "Grok API v2" },
    changedFields: ["stage", "title"],
    comparisonBasis: "exact_snapshot",
    source: { name: "xAI Release Notes" },
  }, "🚨 xAI / Grok 官方产品更新\n具体更新: Grok API v2\n时间: 2026-08-13 00:00:00");

  assert.equal(bundle.en.status, "not_needed");
  assert.match(bundle.en.text, /Key:.*Grok API v1.*→.*Grok API v2/);
  assert.equal(bundle.en.text.split("\n").length, 4);
  assert.match(bundle.en.text, /Grok API v1/);
  assert.match(bundle.en.text, /Grok API v2/);
});

test("GitHub structured facts bypass public translation while evidence stays exact", async () => {
  clearTranslationCache();
  const address = "0x3333333333333333333333333333333333333333";
  const commit = "deadbeef";
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    calls.push(parsed.hostname);
    if (parsed.hostname === "translate.googleapis.com") {
      return { ok: false, status: 503, text: async () => "unavailable" };
    }
    const source = parsed.searchParams.get("q");
    const pair = parsed.searchParams.get("langpair");
    const translatedText = pair === "en|zh-CN"
      ? `新增模块 ${source}`
      : source.replace(/[\u3400-\u9fff]+/g, " official update ").replace(/\s+/g, " ").trim();
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ responseStatus: 200, responseData: { translatedText } }),
    };
  };
  const event = {
    type: "github_module_update",
    launchpad: "Flap",
    repository: "flap-sh/flap-contracts",
    commit,
    message: "Expose guarded launch routing via deployFactoryV3()",
    contract: address,
    files: [{ filename: "src/factory.ts", status: "modified", additions: 1, deletions: 0 }],
    changeEvidence: [{ file: "src/factory.ts", kind: "function", subject: "deployFactoryV3()", action: "added" }],
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationUrl: "https://translate.googleapis.com/translate_a/single",
    alertTranslationFallbackUrl: "https://api.mymemory.translated.net/get",
    alertTranslationFetchImpl: fetchImpl,
    alertTranslationTimeoutMs: 500,
  }, event, `🚨 Flap 官方代码更新\n具体更新: Expose guarded launch routing via deployFactoryV3()\n代码: flap-sh/flap-contracts · commit ${commit}\n合约: ${address}`);

  assert.equal(bundle.zh.provider, "local_structured");
  assert.equal(bundle.en.provider, "local_structured");
  assert.deepEqual(calls, []);
  for (const literal of [commit, "flap-sh/flap-contracts", "deployFactoryV3()"] ) {
    assert.ok(bundle.zh.text.includes(literal), literal);
    assert.ok(bundle.en.text.includes(literal), literal);
  }
  assert.doesNotMatch(renderBilingualTelegramText(bundle, true), new RegExp(address));
});

test("line compaction preserves every selected GitHub identifier without re-expanding discarded evidence", async () => {
  clearTranslationCache();
  const address = "0x4444444444444444444444444444444444444444";
  const commit = "cafebabe";
  const repository = "flap-sh/flap-contracts";
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    const target = parsed.searchParams.get("tl");
    const source = parsed.searchParams.get("q");
    const expansion = "这是经过验证的新模块与部署能力".repeat(24);
    return googleResponse(target === "zh-CN"
      ? `${expansion} ${source}`
      : source.replace(/[\u3400-\u9fff]+/g, " verified update "));
  };
  const event = {
    type: "github_module_update",
    launchpad: "Flap",
    repository,
    commit,
    contract: address,
    message: "Add deployFactoryV3()",
    files: [{ filename: "src/factory.ts", status: "modified", additions: 1, deletions: 0 }],
    changeEvidence: [{ file: "src/factory.ts", kind: "function", subject: "deployFactoryV3()", action: "added" }],
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: fetchImpl,
    alertTranslationTimeoutMs: 500,
  }, event, `具体更新: Add deployFactoryV3() from ${repository} commit ${commit} contract ${address}`);

  for (const literal of [commit, repository, "deployFactoryV3()"] ) {
    assert.ok(bundle.zh.text.includes(literal), `Chinese block lost ${literal}`);
    assert.ok(bundle.en.text.includes(literal), `English block lost ${literal}`);
  }
  assert.doesNotMatch(renderBilingualTelegramText(bundle, true), new RegExp(address));
  assert.ok(renderBilingualTelegramText(bundle, true).split("\n").length <= 12);
  assert.ok(renderBilingualTelegramText(bundle, true).length <= 600);
});

test("Telegram retries reuse the persisted bilingual render bundle without retranslation", async (t) => {
  clearTranslationCache();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-bilingual-retry-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let translationCalls = 0;
  let telegramCalls = 0;
  let deliveredPayload = null;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    telegramCalls += 1;
    deliveredPayload = JSON.parse(options.body);
    if (telegramCalls === 1) return { ok: false, status: 503, text: async () => "temporary" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 707 } }) };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});

  const config = {
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "test-token",
    telegramChatId: "123456789",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertTranslationTimeoutMs: 3_000,
    alertTranslationFetchImpl: async (url) => {
      translationCalls += 1;
      return translationStub(url);
    },
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
  };
  const event = {
    type: "binance_official_update",
    kind: "announcement",
    strong: true,
    project: { id: "binance-wallet", name: "Binance Wallet", website: "https://www.binance.com", twitter: "https://x.com/BinanceWallet" },
    signal: { scope: "wallet", labels: ["Wallet 新发射功能"] },
    title: "Binance Wallet introduces a new launch API",
    url: "https://www.binance.com/en/support/announcement/example",
    publishedAt: new Date(Date.now() - 30_000).toISOString(),
    observedAt: new Date().toISOString(),
  };
  const original = structuredClone(event);

  assert.equal((await sendAlerts(config, event)).status, "queued");
  const firstOutbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = firstOutbox.events[Object.keys(firstOutbox.events)[0]];
  assert.equal(entry.renderBundle.version, 13);
  const callsAfterFirstRender = translationCalls;
  entry.destinations.telegram.nextAttemptAt = null;
  await fs.writeFile(path.join(dataDir, "alert-outbox.json"), `${JSON.stringify(firstOutbox, null, 2)}\n`);

  assert.equal((await sendAlerts(config, event)).status, "delivered");
  assert.equal(translationCalls, callsAfterFirstRender, "the persisted render bundle must be reused after Telegram failure");
  assert.equal(telegramCalls, 2);
  assert.match(deliveredPayload.text, /🇨🇳 中文[\s\S]+🇬🇧 English/);
  assert.equal(deliveredPayload.disable_notification, false);
  assert.equal(deliveredPayload.reply_markup.inline_keyboard[0][0].url, event.url);
  assert.deepEqual(event, original, "rendering must not mutate the source event");

  const finalOutbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const finalEntry = finalOutbox.events[Object.keys(finalOutbox.events)[0]];
  assert.equal(finalEntry.destinations.telegram.receipt.renderVersion, 13);
  assert.equal(finalEntry.destinations.telegram.receipt.translation.zh.status, finalEntry.renderBundle.zh.status);
  assert.equal(finalEntry.destinations.telegram.receipt.translation.en.status, finalEntry.renderBundle.en.status);
});

test("a pending v12 card is rebuilt once as v13 while terminal v12 is not migrated", async (t) => {
  clearTranslationCache();
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-bilingual-v6-migration-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let translationCalls = 0;
  let telegramCalls = 0;
  let deliveredPayload = null;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    telegramCalls += 1;
    deliveredPayload = JSON.parse(options.body);
    if (telegramCalls === 1) return { ok: false, status: 503, text: async () => "temporary" };
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 708 } }) };
  });
  t.mock.method(console, "info", () => {});
  t.mock.method(console, "error", () => {});

  const config = {
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "test-token",
    telegramChatId: "123456789",
    telegramStrongAlerts: true,
    alertBilingualEnabled: true,
    alertTranslationTimeoutMs: 3_000,
    alertTranslationFetchImpl: async (url) => {
      translationCalls += 1;
      return translationStub(url);
    },
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
  };
  const event = {
    type: "github_module_update",
    launchpad: "Four.Meme",
    repository: "four-meme-community/fourmeme-docs",
    commit: "6748033c63e3f68b9ef6fba709783181c9a95792",
    message: "feat: add TaxToken9 charity donation feature",
    sourceTrust: "official_verified",
    observedAt: new Date().toISOString(),
  };

  assert.equal((await sendAlerts(config, event)).status, "queued");
  const file = path.join(dataDir, "alert-outbox.json");
  const outbox = JSON.parse(await fs.readFile(file, "utf8"));
  const entry = outbox.events[Object.keys(outbox.events)[0]];
  entry.renderBundle.version = 12;
  entry.renderBundle.format = "telegram_zh_en_compact_v9";
  entry.renderBundle.sourceHash = "V12_SENTINEL_HASH";
  entry.renderBundle.zh.text = "V12_LONG_CARD_SENTINEL\n旧长卡\n旧长卡\n旧长卡\n旧长卡";
  entry.renderBundle.en.text = "V12_LONG_CARD_SENTINEL\nold long card\nold long card\nold long card\nold long card";
  entry.destinations.telegram.nextAttemptAt = null;
  await fs.writeFile(file, `${JSON.stringify(outbox)}\n`);
  const callsBeforeMigration = translationCalls;

  assert.equal((await sendAlerts(config, event)).status, "delivered");
  const callsAfterMigration = translationCalls;
  assert.equal(telegramCalls, 2);
  assert.doesNotMatch(deliveredPayload.text, /V12_LONG_CARD_SENTINEL/);
  assert.ok(deliveredPayload.text.split("\n").length <= 12);

  const migrated = JSON.parse(await fs.readFile(file, "utf8"));
  const migratedEntry = migrated.events[Object.keys(migrated.events)[0]];
  assert.equal(migratedEntry.renderBundle.version, 13);
  assert.equal(migratedEntry.renderBundle.format, "telegram_zh_en_compact_v10");
  assert.notEqual(migratedEntry.renderBundle.sourceHash, "V12_SENTINEL_HASH");
  assert.equal(migratedEntry.renderBundle.zh.text.split("\n").length, 4);
  assert.equal(migratedEntry.renderBundle.en.text.split("\n").length, 4);
  assert.equal((await sendAlerts(config, event)).status, "delivered");
  assert.equal(translationCalls, callsAfterMigration, "the persisted v13 bundle must not be translated again");
  assert.equal(telegramCalls, 2, "a terminal delivered event must not be sent again");

  migratedEntry.renderBundle.version = 12;
  migratedEntry.renderBundle.zh.text = "TERMINAL_V12_SENTINEL";
  migratedEntry.renderBundle.en.text = "TERMINAL_V12_SENTINEL";
  await fs.writeFile(file, `${JSON.stringify(migrated)}\n`);
  assert.equal((await sendAlerts(config, event)).status, "delivered");
  const terminal = JSON.parse(await fs.readFile(file, "utf8"));
  const terminalEntry = terminal.events[Object.keys(terminal.events)[0]];
  assert.equal(terminalEntry.renderBundle.version, 12);
  assert.equal(terminalEntry.renderBundle.zh.text, "TERMINAL_V12_SENTINEL");
  assert.equal(translationCalls, callsAfterMigration);
  assert.equal(telegramCalls, 2);
});

test("an unknown Binance official kind never falls through to a Robinhood contract card", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alerts-binance-generic-kind-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  let payload;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, result: { message_id: 1 } }) };
  });
  t.mock.method(console, "info", () => {});
  const result = await sendAlerts({
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "test-token",
    telegramChatId: "123456789",
    telegramStrongAlerts: false,
    alertBilingualEnabled: false,
    alertChineseTranslationEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
  }, {
    type: "binance_official_update",
    kind: "future_capability",
    title: "New platform capability",
    signal: { labels: ["平台能力"] },
    url: "https://www.binance.com/en/support/announcement/example",
    publishedAt: new Date().toISOString(),
  });
  assert.equal(result.status, "delivered");
  assert.match(payload.text, /Binance 官方更新/);
  assert.doesNotMatch(payload.text, /Robinhood 新合约/);
});
