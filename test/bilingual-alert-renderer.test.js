import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildBilingualAlertBundle,
  renderBilingualTelegramText,
} from "../src/bilingual-alert-renderer.js";
import { withTradingPriority } from "../src/trading-priority.js";
import { clearTranslationCache, decodeAlertDisplayEntities } from "../src/chinese-localizer.js";
import { sendAlerts } from "../src/alerts.js";
import {
  classifyBinanceGithubChange,
  extractGithubChangeEvidence,
  parseGithubPatchFiles,
  parseGithubPatchMessage,
} from "../src/github-monitor.js";
import {
  produceFourRegistryPresetAndFirstToken,
  produceFourRegistryProtocolEvents,
} from "./helpers/four-registry-fixture.js";
import {
  FOUR_TWITTER_POLICY_RECOVERY_SIGNAL_SHAPES,
  FOUR_TWITTER_POLICY_RECOVERY_SPECS,
  buildFourPolicyRecoveryEvent,
} from "../src/four-twitter-policy-recovery.js";

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

function renderedLanguageBlocks(rendered) {
  const match = String(rendered).match(/🇨🇳 中文\n([\s\S]*?)\n\n🇬🇧 English\n([\s\S]*)$/u);
  assert.ok(match, "rendered alert must contain one Chinese block and one English block");
  return {
    zh: match[1].split("\n").filter(Boolean),
    en: match[2].split("\n").filter(Boolean),
  };
}

function assertShortFieldLayout(rendered) {
  const blocks = renderedLanguageBlocks(rendered);
  for (const [language, lines] of Object.entries(blocks)) {
    assert.ok(lines.length >= 4 && lines.length <= 7, `${language} block has ${lines.length} lines`);
    assert.ok(lines.every((line) => line.length <= 150), `${language} block contains an overlong line`);
  }
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

  assert.match(bundle.zh.text, /发币工厂或代币创建流程变更；链上部署待核/);
  assert.match(bundle.zh.text, /技术 deployFactoryV3\(\)/);
  assert.doesNotMatch(rendered, /Vault & Router/);
  assert.match(bundle.en.text, /^Platform: Flap/m);
  assert.doesNotMatch(rendered, /&amp;/);
  for (const literal of ["deployFactoryV3()", "flap-sh/flap-contracts", "a1b2c3d4"] ) {
    assert.match(bundle.zh.text, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(bundle.en.text, new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  assert.match(rendered, new RegExp(address));
  assert.equal(bundle.version, 23);
  assert.equal(bundle.format, "telegram_zh_en_compact_v13");
  assert.match(rendered, /^🔴 强提醒 \| STRONG ALERT\n🇨🇳 中文\n/);
  assert.match(rendered, /\n\n🇬🇧 English\n/);
  assertShortFieldLayout(rendered);
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
  assert.ok(rendered.split("\n").length <= 18);
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
      zh: /Alpha v1\.7\.0 API 调用参数发生变化；SDK 调用方需适配/,
      en: /Alpha v1\.7\.0 API call parameters changed; SDK callers must adapt/,
      evidence: "Connect +[]string{}",
      strong: true,
      stageZh: "API/schema 变更已提交，下游兼容性待验证",
      stageEn: "API/schema change committed; downstream compatibility pending",
    },
    {
      event: await binanceGithubFixtureEvent("binance-subaccount-0efaaa29.patch", "0efaaa297cd54be4e619049288aee63cde0c9270"),
      zh: /Subaccount v1\.11\.0 API 响应字段调整；下游解析与类型定义需适配/,
      en: /Subaccount v1\.11\.0 API response fields changed; downstream parsers and types must adapt/,
      evidence: "list → rows",
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
    assert.equal(bundle.zh.text.split("\n").length, 2);
    assert.equal(bundle.en.text.split("\n").length, 2);
    assert.equal(bundle.version, 23);
    assert.equal(bundle.format, "telegram_zh_en_compact_v13");
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
    ["config_value", { subject: "launchMode", before: "classic", after: "fast" }, /launchMode classic → fast/, /Platform: Flap/],
    ["dependency_version", { subject: "ethers", before: "v5.7.0", after: "v6.13.0" }, /ethers v5\.7\.0 → v6\.13\.0/, /Platform: Flap/],
    ["api_call_signature", { subject: "createPool", before: "createPool(token)", after: "createPool(token, hook)" }, /createPool \+hook/, /Platform: Flap/],
    ["response_schema", { subject: "launch response", before: "pool", after: "poolAddress" }, /pool → poolAddress/, /Platform: Flap/],
    ["contract", { subject: "VaultFactoryV2", action: "added" }, /VaultFactoryV2/, /Platform: Flap/],
    ["interface", { subject: "ILauncherV2", action: "added" }, /ILauncherV2/, /Platform: Flap/],
    ["class", { subject: "LaunchPolicy", action: "added" }, /LaunchPolicy/, /Platform: Flap/],
    ["function", { subject: "deployFactoryV3()", action: "added" }, /deployFactoryV3\(\)/, /Platform: Flap/],
    ["list_item", { subject: "supportedChains", before: "BSC", after: "BSC, Morph" }, /supportedChains BSC → BSC, Morph/, /Platform: Flap/],
    ["code_assignment", { subject: "MAX_FEE", before: "5", after: "3" }, /MAX_FEE 5 → 3/, /Platform: Flap/],
    ["code_line", { subject: "route", before: "legacyRouter", after: "vaultRouter" }, /route legacyRouter → vaultRouter/, /Platform: Flap/],
    ["documentation_item", { subject: "Morph deployment", action: "added", after: "chainId=2818" }, /chainId=2818/, /Platform: Flap/],
    ["file_change", { file: "src/router.ts", subject: "src/router.ts", action: "modified" }, /src\/router\.ts/, /Platform: Flap/],
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
    assert.equal(bundle.zh.text.split("\n").length, 2, kind);
    assert.equal(bundle.en.text.split("\n").length, 2, kind);
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
  assert.match(bundle.zh.text, /^平台：X/m);
  assert.match(bundle.en.text, /^Platform: X/m);
  assert.match(rendered, /x-api\/chat\/delete-chat-messages/);
  assert.doesNotMatch(rendered, /GitHub 配置更新|GitHub config update/);
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
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
  assert.match(dependencyBundle.zh.text, /^平台：X/m);
  assert.match(dependencyBundle.en.text, /^Platform: X/m);
  assert.match(dependencyBundle.zh.text, /ethers@6/);
  assert.match(dependencyBundle.en.text, /ethers@6/);
  assert.doesNotMatch(renderBilingualTelegramText(dependencyBundle, true), /产品功能|product feature/i);
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
    assert.match(bundle.zh.text, /^平台：Binance Skills/u);
    assert.match(bundle.en.text, /^Platform: Binance Skills/u);
    assert.match(bundle.zh.text, fixture.expectedZh);
    assert.match(bundle.en.text, fixture.expectedEn);
    assert.doesNotMatch(rendered, /\bSDK\b/);
    assert.ok(bundle.zh.text.includes(revision), revision);
    assert.ok(bundle.en.text.includes(revision), revision);
    assert.match(bundle.zh.text, /外部 PR，未合并｜/);
    assert.match(bundle.en.text, /External PR; unmerged \|/);
    assert.doesNotMatch(bundle.zh.text.split("\n")[1], /…/);
    assert.doesNotMatch(bundle.en.text.split("\n")[1], /…/);
    assert.ok(rendered.split("\n").length <= 18, `PR${fixture.number} lines=${rendered.split("\n").length}`);
    assert.ok(rendered.length <= 600, `PR${fixture.number} length=${rendered.length}`);
  }
});

test("GitHub metadata fallback is honest and a long real fixture remains two-field bilingual under 600", async () => {
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
  assert.equal(longBundle.zh.text.split("\n").length, 2);
  assert.equal(longBundle.en.text.split("\n").length, 2);
  for (const literal of ["deployFactoryV3", "+policy"]) {
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
      zh: /更新了什么：Wallet SDK 维护：github\.com\/binance\/binance-connector-go\/common\/v2 v2\.6\.0 → v2\.7\.0（无产品新功能）/,
      stageZh: "SDK 维护发布已记录",
      stageEn: "SDK maintenance release recorded",
    },
    {
      event: await binanceGithubFixtureEvent("binance-alpha-3744783d.patch", "3744783d9cb92a6de8a19b5d4ed06fc7dd5b98a2"),
      zh: /更新了什么：Alpha v1\.7\.0 API 调用参数发生变化；SDK 调用方需适配/,
      stageZh: "API/schema 变更已提交，下游兼容性待验证",
      stageEn: "API/schema change committed; downstream compatibility pending",
    },
    {
      event: await binanceGithubFixtureEvent("binance-subaccount-0efaaa29.patch", "0efaaa297cd54be4e619049288aee63cde0c9270"),
      zh: /更新了什么：Subaccount v1\.11\.0 API 响应字段调整；下游解析与类型定义需适配/,
      stageZh: "API/schema 变更已提交，下游兼容性待验证",
      stageEn: "API/schema change committed; downstream compatibility pending",
    },
    {
      event: await binanceGithubFixtureEvent("binance-mining-1b4d14ea.patch", "1b4d14eadc66e841a03f16b7eed1e51f32e710df"),
      zh: /更新了什么：Mining SDK 维护：github\.com\/binance\/binance-connector-go\/common\/v2 → v2\.7\.0（无产品新功能）/,
      stageZh: "SDK 维护发布已记录",
      stageEn: "SDK maintenance release recorded",
    },
  ];

  for (const item of cases) {
    const bundle = await buildBilingualAlertBundle(config, item.event, binanceGithubProductionBase(item.event));
    const rendered = renderBilingualTelegramText(bundle, item.event.binanceChange.substantive);
    const zhStageTime = `${item.stageZh}`;
    const enStageTime = `${item.stageEn}`;

    assert.match(bundle.zh.text, item.zh);
    assert.ok(bundle.zh.text.includes(zhStageTime), bundle.zh.text);
    assert.ok(bundle.en.text.includes(enStageTime), bundle.en.text);
    assert.equal(bundle.zh.status, "not_needed");
    assert.equal(bundle.zh.provider, "local_structured");
    assert.doesNotMatch(rendered, /英文原文|(?:重点\s*[:：]\s*)?原文\s*[:：]|Source fact \(translation pending\)|Translation pending/iu);
    assert.doesNotMatch(rendered, /2026-08-19T13:/);
    assert.equal(bundle.zh.text.split("\n").length, 2);
    assert.equal(bundle.en.text.split("\n").length, 2);
    assertShortFieldLayout(rendered);
    assert.ok(rendered.length <= 900, `card is ${rendered.length} characters`);
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
  assert.match(bundle.zh.text, /^平台：Binance/m);
  assert.match(bundle.zh.text, /更新了什么：Agent Native 新增 Binance MCP Server 文档入口/);
  assert.match(bundle.en.text, /What changed: Agent Native added a Binance MCP Server docs entry/);
  assert.match(bundle.zh.text, /官方 Developer 文档 · llms\.txt/);
  assert.match(bundle.en.text, /Official Developer docs · llms\.txt/);
  assert.match(bundle.zh.text, /官方文档入口已出现；产品可用范围待确认｜08-20 16:16 CST · 延迟4秒/);
  assert.match(bundle.en.text, /Official docs entry published; product availability unconfirmed \| 08-20 16:16 CST · 4s delay/);
  assert.doesNotMatch(rendered, /signalDigest|官方已发布|Officially published|英文原文|Translation pending/iu);
  assert.equal(bundle.zh.status, "not_needed");
  assert.equal(bundle.en.status, "not_needed");
  assert.equal(providerCalls, 0);
  assert.equal(bundle.version, 23);
  assert.equal(bundle.format, "telegram_zh_en_compact_v13");
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
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
  assert.match(bundle.zh.text, /^平台：Binance/m);
  assert.match(bundle.zh.text, /更新了什么：AI Agent 可接入行情、支付、链上数据与交易能力/);
  assert.match(bundle.en.text, /What changed: AI agents can access market intelligence, payments, on-chain data, and trading/);
  assert.match(bundle.zh.text, /@binance · X#2090380033013764166/);
  assert.match(bundle.en.text, /@binance · X#2090380033013764166/);
  assert.match(bundle.zh.text, /官方已发布｜08-20 18:06 CST · 延迟1小时13分/);
  assert.match(bundle.en.text, /Officially published \| 08-20 18:06 CST · 1h13m delay/);
  assert.doesNotMatch(rendered, /链上已确认|安全|代币|on-chain confirmed|token safety|英文原文|Translation pending/iu);
  assert.equal(bundle.zh.status, "not_needed");
  assert.equal(bundle.en.status, "not_needed");
  assert.equal(providerCalls, 0);
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
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
  assert.match(bundle.zh.text, /^平台：Flap/m);
  assert.match(bundle.zh.text, /更新了什么：接入 Binance Agentic Wallet；Flap token-launch skill 可对话发币，支持 BStock 报价/);
  assert.match(bundle.en.text, /What changed: Binance Agentic Wallet now supports chat-based launches through the Flap token-launch skill with BStock quotes/);
  assert.match(bundle.zh.text, /@flapdotsh · Post 2091136006741500374/);
  assert.match(bundle.zh.text, /官方 X 已发布；首个链上实币待确认｜08-22 20:10 CST · 延迟3秒/);
  assert.match(bundle.en.text, /Official X post published; first live on-chain token unconfirmed \| 08-22 20:10 CST · 3s delay/);
  assert.doesNotMatch(rendered, /英文原文|translation pending/iu);
  assert.equal(bundle.zh.status, "not_needed");
  assert.equal(bundle.en.status, "not_needed");
  assert.equal(providerCalls, 0);
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
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
  assert.match(bundle.en.text, /^Platform: Flap/m);
  assert.match(bundle.en.text, /flap-sh\/flap-contracts#deadbeef/);
  assert.match(rendered, new RegExp(address));
  assert.match(bundle.en.text, /deployFactoryV3 \+guard/);
  assert.doesNotMatch(rendered, /ZXQ(?:KEEP|NORM)/);
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
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
  assert.match(bundle.en.text, /What changed:.*VaultRouterV2/i);
  assert.match(bundle.en.text, new RegExp(`Contract ${address}`, "i"));
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

  assert.match(bundle.zh.text, /^平台：Fomo/m);
  assert.match(bundle.en.text, /^Platform: Fomo/m);
  assert.match(bundle.zh.text, /更新了什么：@alpha · 买入 \$1,250/);
  assert.match(bundle.en.text, /What changed: @alpha · Bought \$1,250/);
  assert.match(bundle.zh.text, new RegExp(`CA ${token} · 仓位证明已核验`));
  assert.match(bundle.en.text, new RegExp(`CA ${token} · Position proof verified`));
  assert.match(bundle.zh.text, /链上推断，非 Fomo 官方喊单；前一区块代币零仓位；安全初筛通过，非买入建议/);
  assert.match(bundle.en.text, /On-chain inference, not an official Fomo call; Token zero position at previous block; Safety screened; not a buy recommendation/);
  assert.match(rendered, /风险：安全初筛通过，非买入建议/u);
  assert.match(rendered, /Risk: Safety screened; not a buy recommendation/u);
  assertShortFieldLayout(rendered);
  assert.doesNotMatch(rendered, new RegExp(transactionHash));
  assert.equal(event.transactionHash, transactionHash, "the immutable event retains the full Tx for its Telegram button");
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
  assert.ok(rendered.length <= 600, `card is ${rendered.length} characters`);
});

test("Fomo published and linked-X T0/T1 cards persist a bounded source thesis without online translation", async () => {
  clearTranslationCache();
  const token = "0x2222222222222222222222222222222222222222";
  const observedAt = "2026-09-03T01:00:02.000Z";
  const common = {
    type: "fomo_family_top_call",
    qualified: true,
    strong: true,
    chain: { id: 56, chainId: 56, slug: "bsc", name: "BNB Smart Chain" },
    token,
    contractAddress: token,
    tokenSymbol: "CALL",
    symbol: "CALL",
    caller: { handle: "alpha", followers: 125_000 },
    handle: "alpha",
    market: { liquidityUsd: 65_000, volumeM5: 18_000, sellsM5: 8 },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true } },
    publishedAt: "2026-09-03T01:00:00.000Z",
    observedAt,
  };
  const publishedText = "Accumulating CALL while BSC liquidity is expanding.";
  const published = withTradingPriority({
    ...common,
    eventKey: "fomo-published-call:thesis-1001",
    signalKind: "fomo_published_call",
    callId: "thesis-1001",
    body: publishedText,
    thesis: { id: "thesis-1001", text: publishedText, handle: "alpha" },
    source: { id: "fomo_family_official_thesis", trust: "official_authenticated_api" },
    sourceTrust: "official_authenticated_api",
  }, { nowMs: Date.parse(observedAt) });
  const chineseBody = "CALL 突破后继续观察成交量，流动性扩张才是确认信号。";
  const xCall = withTradingPriority({
    ...common,
    eventKey: "fomo-x-call:1777777777777777777:2090:CALL",
    signalKind: "fomo_x_call",
    callId: "x:1777777777777777777:2090:CALL",
    body: chineseBody,
    thesis: { id: "2090", handle: "alpha" },
    walletAddress: "0x1111111111111111111111111111111111111111",
    walletAttribution: { status: "observed", verified: false },
    tweet: {
      id: "2090",
      handle: "alpha",
      text: chineseBody,
      createdAt: "2026-09-03T01:00:00.000Z",
      url: "https://x.com/alpha/status/2090",
      sourceVerifiedBy: "official_x_oembed",
    },
    source: { id: "fomo_linked_x_post", trust: "public_x_identity_linked" },
    sourceTrust: "public_x_identity_linked",
  }, { nowMs: Date.parse(observedAt) });
  assert.equal(published.tradingPriority.tier, "T0");
  assert.equal(xCall.tradingPriority.tier, "T1");

  let providerCalls = 0;
  for (const [event, sourceField, sourceText, zhLabel, enLabel] of [
    [published, "thesis.text", publishedText, "英文原文：", "Thesis: "],
    [xCall, "body", chineseBody, "观点：", "Chinese original: "],
  ]) {
    const bundle = await buildBilingualAlertBundle({
      alertTranslationFetchImpl: async () => {
        providerCalls += 1;
        throw new Error("translation must not run for a published Fomo call");
      },
    }, event, `Fomo update\n状态: verified\n时间: ${event.publishedAt}`);
    const rendered = renderBilingualTelegramText(bundle, true);

    assert.equal(bundle.focusModel.callThesis.sourceField, sourceField);
    assert.equal(bundle.focusModel.callThesis.source, sourceText);
    assert.ok(bundle.focusModel.callThesis.source.length <= 112);
    assert.ok(bundle.zh.text.includes(`${zhLabel}${sourceText}`), bundle.zh.text);
    assert.ok(bundle.en.text.includes(`${enLabel}${sourceText}`), bundle.en.text);
    assert.match(rendered, new RegExp(zhLabel));
    assert.match(rendered, new RegExp(enLabel));
    assert.ok(rendered.includes(sourceText));
    assert.notEqual(bundle.zh.text, bundle.en.text);
    const blocks = renderedLanguageBlocks(rendered);
    for (const lines of Object.values(blocks)) {
      assert.ok(lines.length >= 4 && lines.length <= 7);
      assert.ok(lines.every((line) => line.length <= 150));
    }
    assert.ok(rendered.includes(`CA ${token}`));
    assert.match(rendered, /非买入建议/u);
    assert.match(rendered, /not a buy recommendation/iu);
    if (event.signalKind === "fomo_x_call") {
      assert.ok(rendered.includes("0x1111111111111111111111111111111111111111"));
      assert.ok(rendered.includes("X#2090"));
    } else {
      assert.ok(rendered.includes("callId=thesis-1001"));
    }
    assert.doesNotMatch(rendered, /translation unavailable|翻译暂不可用/iu);
  }
  assert.equal(providerCalls, 0);
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

  assert.match(bundle.zh.text, /更新了什么：TaxToken9 Charity Donation · 首币 Cyber Cat \(CCAT\)/);
  assert.match(bundle.en.text, /What changed: TaxToken9 Charity Donation · First token Cyber Cat \(CCAT\)/);
  assert.match(bundle.zh.text, new RegExp(`CA ${token} · templateId=9`));
  assert.match(bundle.en.text, new RegExp(`CA ${token} · templateId=9`));
  assert.doesNotMatch(rendered, new RegExp(launcher));
  assert.doesNotMatch(rendered, /英文原文|Source fact \(translation pending\)/);
  assert.match(bundle.zh.text, /安全初筛通过，非买入建议 · 链上已确认 · security=pass · liquidityConfirmed=true/);
  assert.match(bundle.en.text, /Safety screening passed; not a buy recommendation · On-chain confirmed · security=pass · liquidityConfirmed=true/);
  assert.doesNotMatch(rendered, new RegExp(transactionHash));
  assert.equal(event.transactionHash, transactionHash);
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
  assert.ok(rendered.length <= 600, `card is ${rendered.length} characters`);
});

test("Flap tracked pool-token cards are local five-line bilingual monitor-only alerts for pass, unknown, and block", async () => {
  clearTranslationCache();
  let providerCalls = 0;
  let passEvent = null;
  const observedAt = "2026-09-04T01:00:05.000Z";
  const generationKey = `quote:0xd97d097a89113fa59b76c572e5b2eb647e8eefaf:generation:0x${"a".repeat(64)}:0x${"b".repeat(64)}:4`;
  const cases = [
    {
      ordinal: 1,
      decision: "pass",
      zh: "结论：观察；静态初筛通过，可卖性仍待验证",
      en: "Decision: Watch; static screening passed; sellability still unverified",
    },
    {
      ordinal: 2,
      decision: "unknown",
      zh: "结论：安全未完成｜不买",
      en: "Decision: Safety incomplete | do not buy",
    },
    {
      ordinal: 3,
      decision: "block",
      zh: "结论：⛔ 不买；安全门已拦截",
      en: "Decision: ⛔ Do not buy; safety gate blocked",
    },
  ];

  for (const item of cases) {
    const token = `0x${String(item.ordinal).repeat(40)}`;
    const transactionHash = `0x${String(item.ordinal).repeat(64)}`;
    const logIndex = item.ordinal + 5;
    const event = withTradingPriority({
      type: "bsc_launchpad_update",
      kind: "flap_pool_token",
      eventKey: `bsc-flap-pool-token:${generationKey}:${item.ordinal}:${transactionHash}:${logIndex}:${token}`,
      featureTrackedToken: true,
      featureTokenOrdinal: item.ordinal,
      featureTokenTarget: 3,
      featureActivationKey: generationKey,
      featureGenerationKey: generationKey,
      informationalOnly: true,
      autoTradeEligible: false,
      automaticExecution: false,
      platform: { id: "flap", name: "Flap", trust: "official_verified" },
      mode: {
        quoteAsset: "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf",
        quoteSymbol: "SOXLB",
        quoteName: "Semicon Bull 3X ETF",
        selector: "0x12345678",
      },
      tokens: [{ token, metadata: { name: "Signal Cat", symbol: "SCAT" } }],
      security: { decision: item.decision, metrics: { liquidityConfirmed: item.decision === "pass" } },
      transactionHash,
      blockNumber: 119_800_000 + item.ordinal,
      blockHash: `0x${String(item.ordinal + 3).repeat(64)}`,
      transactionIndex: item.ordinal,
      logIndex,
      blockTimestamp: observedAt,
      observedAt,
    }, { nowMs: Date.parse(observedAt) + 5_000 });
    const bundle = await buildBilingualAlertBundle({
      alertTranslationFetchImpl: async () => {
        providerCalls += 1;
        throw new Error("tracked-token cards must not call translation");
      },
      alertTranslationTimeoutMs: 50,
    }, event, `Flap token selector=0x12345678 security=${item.decision} liquidityConfirmed=${item.decision === "pass"}\n时间: ${observedAt}`);
    const rendered = renderBilingualTelegramText(bundle, item.decision === "pass");
    const blocks = renderedLanguageBlocks(rendered);

    assert.equal(blocks.zh.length, 5);
    assert.equal(blocks.en.length, 5);
    assert.equal(blocks.zh[0], `平台：Flap｜SOXLB 底池｜第 ${item.ordinal}/3 个代币`);
    assert.equal(blocks.en[0], `Platform: Flap | SOXLB pool | Token ${item.ordinal}/3`);
    assert.equal(blocks.zh[1], `代币：Signal Cat (SCAT)｜CA ${token}`);
    assert.equal(blocks.en[1], `Token: Signal Cat (SCAT) | CA ${token}`);
    assert.ok(blocks.zh.includes(item.zh));
    assert.ok(blocks.en.includes(item.en));
    assert.match(blocks.zh[3], /^确认：官方 TokenCreated \+ SOXLB 配对$/u);
    assert.match(blocks.en[3], /^Proof: Official TokenCreated \+ SOXLB pair$/u);
    assert.match(blocks.zh[4], /^风险\/时间：非自动交易｜/u);
    assert.match(blocks.en[4], /^Risk\/Time: No automatic trading \|/u);
    assert.doesNotMatch(rendered, /selector=|security=|liquidityConfirmed=|路径=|flow=|入场=|entry=/iu);
    assert.equal(bundle.version, 23);
    if (item.decision === "pass") passEvent = event;
  }
  assert.equal(providerCalls, 0);

  const producerRecovery = {
    ...passEvent,
    blockTimestamp: "2026-09-04T00:00:00.000Z",
    observedAt: "2026-09-04T01:00:05.000Z",
    delayedRecovery: {
      version: 1,
      reason: "verified_generation_archive_catch_up",
      sourceOccurredAt: "2026-09-04T00:00:00.000Z",
      firstObservedAt: "2026-09-04T00:00:05.000Z",
      recoveredAt: "2026-09-04T01:00:05.000Z",
      lagMs: 3_605_000,
      continuousCoverage: true,
    },
  };
  const recoveryBundle = await buildBilingualAlertBundle({}, producerRecovery, "must stay structured");
  const recoveryBlocks = renderedLanguageBlocks(renderBilingualTelegramText(recoveryBundle, false));
  assert.equal(recoveryBlocks.zh.length, 5);
  assert.equal(recoveryBlocks.en.length, 5);
  assert.match(recoveryBlocks.zh[2], /^结论：延迟补报｜勿追价｜/u);
  assert.match(recoveryBlocks.en[2], /^Decision: Delayed recovery \| do not chase \|/);
  assert.doesNotMatch(recoveryBlocks.zh.join("\n"), /断线/u);

  const deliveryDelayed = {
    ...passEvent,
    freshness: {
      ...passEvent.freshness,
      decision: "realtime",
      realtimeMaxAgeMs: 600_000,
      telegramMaxAgeMs: 7_200_000,
      deliveryLagMs: 7_260_000,
      deliveryDecision: "suppress",
      deliveryEvaluatedAt: "2026-09-04T03:01:05.000Z",
    },
  };
  const deliveryBundle = await buildBilingualAlertBundle({}, deliveryDelayed, "must stay structured");
  const deliveryBlocks = renderedLanguageBlocks(renderBilingualTelegramText(deliveryBundle, false));
  assert.equal(deliveryBlocks.zh.length, 5);
  assert.equal(deliveryBlocks.en.length, 5);
  assert.match(deliveryBlocks.zh[2], /^结论：延迟送达｜勿追价｜/u);
  assert.match(deliveryBlocks.en[2], /^Decision: Delayed delivery \| do not chase \|/);
  assert.match(deliveryBlocks.zh[4], /^风险\/时间：勿追价｜非自动交易｜/u);

  const revisionBlockHash = `0x${"f".repeat(64)}`;
  const revisionEvent = {
    ...passEvent,
    blockHash: revisionBlockHash,
    eventKey: `${passEvent.eventKey}:canonical-revision:${revisionBlockHash}`,
    canonicalRevision: {
      version: 1,
      reason: "token_created_reorg",
      ordinal: 1,
      replacesEventKey: passEvent.eventKey,
      replacesBlockHash: passEvent.blockHash,
      replacesTokenAddress: passEvent.tokens[0].token,
    },
  };
  const revisionBundle = await buildBilingualAlertBundle({}, revisionEvent, "must stay structured");
  const revisionBlocks = renderedLanguageBlocks(renderBilingualTelegramText(revisionBundle, false));
  assert.equal(revisionBlocks.zh.length, 5);
  assert.equal(revisionBlocks.en.length, 5);
  assert.equal(revisionBlocks.zh[2], "结论：链重组修订｜以本条 CA 为准｜不买");
  assert.equal(revisionBlocks.en[2], "Decision: Chain-reorg revision | use this CA as canonical | do not buy");
  assert.match(revisionBlocks.zh[4], /非自动交易/u);
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
  assert.match(bundle.zh.text, /^平台：Flap/m);
  assert.match(bundle.en.text, /^Platform: Flap/m);
  assert.match(bundle.zh.text, /chAIn · V3 · 1\.283 NVDAB/);
  assert.match(bundle.en.text, /chAIn · V3 · 1\.283 NVDAB/);
  assert.match(bundle.zh.text, new RegExp(`CA ${token} · Tx ${transactionHash}`));
  assert.match(bundle.en.text, new RegExp(`CA ${token} · Tx ${transactionHash}`));
  assert.match(bundle.zh.text, /newTokenV6#117421878；Agentic未归因，非买入建议/);
  assert.match(bundle.en.text, /newTokenV6#117421878; Agentic unverified; not buy advice/);
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
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
  assert.match(bundle.zh.text, /^平台：Flap/m);
  assert.match(bundle.en.text, /^Platform: Flap/m);
  assert.match(bundle.zh.text, /更新了什么：新增发币报价资产；可作为新币定价与结算币种/);
  assert.doesNotMatch(rendered, /Translation unavailable|see Chinese block|\[object Object\]|[\[{]\s*"[^"\n]+"\s*:/i);
  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.equal(block.split("\n").length, 2);
  }
  assert.ok(rendered.split("\n").length <= 18);
});

test("Flap official bStock quote-pair announcement names every asset and keeps the no-auto-trade boundary", async () => {
  clearTranslationCache();
  const observedAt = new Date().toISOString();
  const event = withTradingPriority({
    type: "twitter_update",
    project: { id: "flap", name: "Flap", match: "official_x" },
    tweet: {
      id: "2095124685788979225",
      handle: "flapdotsh",
      url: "https://x.com/flapdotsh/status/2095124685788979225",
      text: "Flap is expanding the programmable asset layer with two new bStock trading pairs: SOXLB and SOXSB.",
      createdAt: observedAt,
    },
    signal: {
      relevant: true,
      strong: true,
      platformStructural: true,
      labels: ["税收/募资/报价代币"],
      quotePairChange: {
        assetClass: "bstock_quote",
        stage: "announced",
        assets: [
          { symbol: "SOXLB", name: "Semicon Bull 3X ETF" },
          { symbol: "SOXSB", name: "Direxion Semiconductor Bear 3X ETF" },
        ],
      },
    },
    source: { id: "official_x_oembed", trust: "official_verified" },
    sourceTrust: "official_verified",
    observedAt,
  }, { nowMs: Date.parse(observedAt) });
  assert.equal(event.tradingPriority.tier, "T1");

  const bundle = await buildBilingualAlertBundle({}, event, "Flap official X quote-pair announcement");
  const rendered = renderBilingualTelegramText(bundle, true);
  const blocks = renderedLanguageBlocks(rendered);

  assertShortFieldLayout(rendered);
  for (const literal of ["SOXLB", "SOXSB", "Semicon Bull 3X ETF", "Direxion Semiconductor Bear 3X ETF"]) {
    assert.match(blocks.zh.join("\n"), new RegExp(literal));
    assert.match(blocks.en.join("\n"), new RegExp(literal));
  }
  assert.match(blocks.zh.join("\n"), /官方 X 已验证；链上启用待确认/u);
  assert.match(blocks.en.join("\n"), /Official X verified; on-chain enablement pending/u);
  assert.match(blocks.zh.join("\n"), /不等于 ETF\/股票所有权.*非自动交易/u);
  assert.match(blocks.en.join("\n"), /not ETF\/share ownership.*no automatic trading/iu);
  assert.ok(rendered.split("\n").length <= 18);
  assert.ok(rendered.length < 3_800);
});

test("Flap verified quote-pool activation renders symbol, name, CA, chain and risk instead of a raw address", async () => {
  clearTranslationCache();
  const quoteAddress = "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf";
  const observedAt = new Date().toISOString();
  const event = withTradingPriority({
    type: "platform_capability_update",
    platform: { id: "flap", name: "Flap" },
    changes: {
      newFlapPools: [{
        kind: "quote_asset",
        category: "QUOTE",
        chainId: 56,
        quoteAddress,
        quoteSymbol: "SOXLB",
        quoteName: "Semicon Bull 3X ETF",
        quoteClassification: "bstock",
        sourceUrl: "https://flap.sh/board",
      }],
    },
    sources: ["https://flap.sh/board"],
    transactionHash: `0x${"a".repeat(64)}`,
    blockNumber: 71_234_567,
    observedAt,
  }, { nowMs: Date.parse(observedAt) });
  assert.equal(event.tradingPriority.tier, "T1");

  const bundle = await buildBilingualAlertBundle({}, event, "Flap quote-pool activation");
  const rendered = renderBilingualTelegramText(bundle, true);
  const blocks = renderedLanguageBlocks(rendered);

  assertShortFieldLayout(rendered);
  for (const block of [blocks.zh.join("\n"), blocks.en.join("\n")]) {
    assert.match(block, /SOXLB/);
    assert.match(block, /Semicon Bull 3X ETF/);
    assert.match(block, new RegExp(quoteAddress));
    assert.match(block, /chainId=56/);
  }
  assert.match(blocks.zh.join("\n"), /Portal 回执 \+ ERC-20 元数据已核验/u);
  assert.match(blocks.en.join("\n"), /Portal receipt \+ ERC-20 metadata verified/u);
  assert.match(blocks.zh.join("\n"), /后续播报该池第1–3个代币CA/u);
  assert.match(blocks.en.join("\n"), /report token CAs #1–#3 from this pool/iu);
  assert.match(blocks.zh.join("\n"), /不等于 ETF\/股票所有权.*非自动交易/u);
  assert.match(blocks.en.join("\n"), /not ETF\/share ownership.*no automatic trading/iu);
  assert.doesNotMatch(rendered, /平台新模式.*首个安全代币|Platform mode\/upgrade.*first safe token/iu);
  assert.ok(rendered.split("\n").length <= 18);
  assert.ok(rendered.length < 3_800);
});

test("Flap Board metadata recovery says first observed, keeps original time, and never claims enabled now", async () => {
  clearTranslationCache();
  const quoteAddress = "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf";
  const sourceOccurredAt = "2026-09-02T12:20:25.000Z";
  const observedAt = "2026-09-02T12:40:25.000Z";
  const asset = {
    kind: "quote_asset",
    category: null,
    vaultFactory: null,
    chainId: 56,
    identity: `chain-56:quote:${quoteAddress}`,
    quoteAddress,
    quoteSymbol: "SOXLB",
    quoteName: "Semicon Bull 3X ETF",
    quoteClassification: "bstock",
    sourceUrl: "https://flap.sh/board",
  };
  const event = withTradingPriority({
    type: "platform_capability_update",
    kind: "flap_quote_asset_board_observed",
    changeType: "observed",
    platform: { id: "flap", name: "Flap", website: "https://flap.sh" },
    source: "https://flap.sh/board",
    sources: ["https://flap.sh/board"],
    url: "https://flap.sh/board",
    sourceOccurredAt,
    observedAt,
    changes: { newFlapPools: [asset], updatedFlapPools: [], flapPoolChanges: [] },
    signal: {
      strong: false,
      platformStructural: true,
      category: "Flap quote asset observed on official Board",
      headline: "Flap official Board first confirmed SOXLB as quote asset",
      quotePairChange: {
        stage: "observed",
        assetClass: "quote_asset",
        assets: [{
          symbol: asset.quoteSymbol,
          name: asset.quoteName,
          address: asset.quoteAddress,
          chainId: 56,
          classification: "bstock",
        }],
      },
    },
  }, { nowMs: Date.parse(observedAt) });
  assert.equal(event.tradingPriority.tier, "T2");

  const bundle = await buildBilingualAlertBundle({ alertForceLocalStructured: true }, event, "Flap Board quote observation");
  const rendered = renderBilingualTelegramText(bundle, false);
  const blocks = renderedLanguageBlocks(rendered);
  assert.match(blocks.zh.join("\n"), /报价底池已发现：SOXLB/u);
  assert.match(blocks.zh.join("\n"), /官方看板首次确认观察到报价资产/u);
  assert.match(blocks.zh.join("\n"), /名称\/符号已解析/u);
  assert.match(blocks.en.join("\n"), /quote pools observed: SOXLB/i);
  assert.match(blocks.en.join("\n"), /official Board first confirmed the quote asset/i);
  assert.match(blocks.en.join("\n"), /name\/symbol resolved/i);
  assert.match(blocks.zh.join("\n"), /Portal 0→1 待确认/u);
  assert.match(blocks.en.join("\n"), /Portal 0→1 pending/i);
  assert.match(blocks.zh.join("\n"), /09-02 20:20 CST/u);
  assert.match(blocks.en.join("\n"), /09-02 20:20 CST/u);
  assert.match(blocks.zh.join("\n"), /元数据延迟补齐，勿追价/u);
  assert.match(blocks.zh.join("\n"), /不等于 ETF\/股票所有权.*非自动交易/u);
  assert.match(blocks.en.join("\n"), /not ETF\/share ownership.*no automatic trading/i);
  assert.doesNotMatch(blocks.zh.join("\n"), /报价底池已启用|当前启用/u);
  assert.doesNotMatch(blocks.en.join("\n"), /quote pools? enabled|currently enabled/i);
  assert.doesNotMatch(rendered, /ERC-20 元数据已核验|ERC-20 metadata verified/iu);
  assertShortFieldLayout(rendered);
  assert.ok(rendered.length < 3_800);
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
    assert.doesNotMatch(block, /Solidity/);
  }
  assert.match(bundle.zh.text, /^平台：Four\.Meme/m);
  assert.match(bundle.en.text, /^Platform: Four\.Meme/m);
  assert.match(bundle.zh.text, /更新了什么：中文翻译暂不可用；请看英文原文/);
  assert.doesNotMatch(bundle.zh.text, /charity donation module/);
  assert.match(bundle.en.text, /What changed: Repository description: TaxToken9 charity donation module/);
  assert.doesNotMatch(rendered, /Translation unavailable|see Chinese block|\[object Object\]|[\[{]\s*"[^"\n]+"\s*:/i);
  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.equal(block.split("\n").length, 2);
  }
  assert.ok(rendered.split("\n").length <= 18);
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
      "更新了什么: Eligible KOLs can publish a Trade Thesis after buying；Followers can open the token page from the call",
      "时间: 2026-08-18 12:00:00 · 延迟20秒",
    ].join("\n")),
  };

  for (const [name, bundle] of Object.entries(cards)) {
    const rendered = renderBilingualTelegramText(bundle, true);
    for (const block of [bundle.zh.text, bundle.en.text]) {
      assert.equal(block.split("\n").length, 2, name);
    }
    assert.ok(rendered.split("\n").length <= 18, name);
    assert.ok(rendered.length <= (["github", "flap"].includes(name) ? 600 : 450), name);
    assert.doesNotMatch(rendered, /Translation unavailable|see Chinese block|\[object Object\]|[\[{]\s*"[^"\n]+"\s*:/i, name);
  }

  for (const block of [cards.flap.zh.text, cards.flap.en.text]) {
    assert.equal(block.split(factory).length - 1, 1, "Flap Factory must render once");
    assert.equal(block.split(quote).length - 1, 1, "Flap quote must render once");
    assert.doesNotMatch(block, /0x[0-9a-f]{1,39}…/i, "an address must never be partially truncated");
  }
  assert.match(cards.github.zh.text, /更新了什么：docs\/charity\/TaxToken9\.md 已新增；精确内容未解析/);
  assert.doesNotMatch(cards.github.zh.text, /feat:\s*add|charity donation feature/i);
  assert.match(cards.x.zh.text, /Charity Donation 已上线；可把链上活动产生的资金持续导向公益捐赠/);
  assert.doesNotMatch(cards.x.zh.text, /Charity Badge|Charity Dashboard|另有\d+项/);
  assert.doesNotMatch(cards.x.zh.text, /币安慈善/);
  assert.match(cards.x.en.text, /Officially stated live/);
  assert.doesNotMatch(cards.x.en.text, /has been stated|official news/i);
  assert.match(cards.binance.zh.text, /更新了什么：KOL 买入后可发布 Trade Thesis/);
  assert.doesNotMatch(cards.binance.zh.text, /introduces KOL|Eligible KOLs can publish/i);
  assert.match(cards.binance.en.text, /What changed: KOL can publish a post-buy Trade Thesis/i);
  assert.doesNotMatch(cards.binance.en.text, /social trading function/i);
  for (const block of [cards.binance.zh.text, cards.binance.en.text]) {
    assert.equal(block.split("Trade Thesis").length - 1, 1, "Trade Thesis should appear once per language");
    assert.equal(block.split("Binance Wallet").length - 1, 1, "the product name should not repeat outside the title");
    assert.doesNotMatch(block, /另有\d+项|\+\d+ more|and \d+ more/i);
  }
  assert.ok(renderBilingualTelegramText(cards.binance, true).length <= 450);
});

test("Four.Meme named-mode and official campaign cards expose the trading mechanism instead of generic slogans", async () => {
  let translationCalls = 0;
  const config = {
    alertTranslationFetchImpl: async () => {
      translationCalls += 1;
      throw new Error("structured Four.Meme cards must not call translation");
    },
  };
  const project = { id: "fourmeme", name: "Four.meme" };
  const officialTweet = (id, createdAt, text) => ({
    id,
    handle: "fourdotmemezh",
    authorId: "1816036559864619011",
    xUserId: "1816036559864619011",
    sourceVerifiedBy: "official_x_oembed",
    url: `https://x.com/fourdotmemezh/status/${id}`,
    createdAt,
    text,
  });
  const listaYield = withTradingPriority({
    type: "twitter_update",
    project,
    tweet: officialTweet(
      "2095361508700258731",
      "2026-09-03T04:01:28.000Z",
      "Introducing ListaYield on Four.Meme — a new OpenFour mode powered by @lista_dao.",
    ),
    signal: {
      relevant: true,
      strong: true,
      platformStructural: true,
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
    },
    productLifecycle: {
      product: "listayield",
      stage: "announced",
      key: "fourmeme:lifecycle:listayield:announced",
    },
    mode: { officialName: "ListaYield", componentMode: "ListaYield" },
    observedAt: "2026-09-03T04:01:30.523Z",
  }, { nowMs: Date.parse("2026-09-03T04:01:31.000Z") });
  const campaign = withTradingPriority({
    type: "twitter_update",
    project,
    tweet: officialTweet(
      "2095713912188739967",
      "2026-09-04T03:21:47.000Z",
      "bStocks szn just got competitive: 150,000 USDT with 50,000 USDT for Four.Meme traders. Top 500 on Ave.ai.",
    ),
    signal: {
      relevant: true,
      strong: false,
      platformStructural: false,
      marketCampaign: {
        version: 1,
        kind: "bstock_partner_leaderboard",
        assetClass: "bstock",
        stage: "live",
        partnerHandle: "AveaiGlobal",
        chainHandle: "BNBCHAIN",
        venue: "Ave.ai",
        totalPrizeUsdt: 150000,
        fourMemePrizeUsdt: 50000,
        topRanks: 500,
        exclusiveToFourMemeTraders: true,
        campaignKey: "fourmeme:market-campaign:bstock:aveaiglobal:50000-usdt:top-500",
      },
    },
    policyFixRecovery: { version: 1, stale: true, noChase: true },
    observedAt: "2026-09-04T08:00:00.000Z",
  }, { nowMs: Date.parse("2026-09-04T08:00:01.000Z") });
  const github = withTradingPriority({
    type: "github_module_update",
    launchpad: "Four.meme",
    repository: "four-meme-community/openfour-docs",
    sourceTrust: "official_verified",
    commit: "bcf52911c992994af5d71ace12f90488be574949",
    message: "docs: update OpenFour integration and tax references",
    committedAt: "2026-09-03T02:07:41.000Z",
    observedAt: "2026-09-03T02:07:56.183Z",
    files: [
      { filename: "mechanisms/lista-v2-stake.md", status: "added" },
      { filename: "contracts/token/StrategyTaxToken.sol", status: "added" },
    ],
    githubChange: {
      classification: "substantive",
      primaryFact: { file: "contracts/interfaces/IOpenFourCore.sol", kind: "function", subject: "zapRouter", action: "added" },
    },
  }, { nowMs: Date.parse("2026-09-03T02:07:57.000Z") });
  const template = withTradingPriority({
    type: "bsc_launchpad_update",
    kind: "new_mode",
    changeType: "template_updated",
    chainId: 56,
    platform: { id: "fourmeme", name: "Four.meme" },
    source: {
      id: "fourmeme_public_template_api",
      name: "Four.Meme public template API",
      url: "https://four.meme/meme-api/v1/public/token_template/search",
      trust: "official_verified",
      official: true,
    },
    sourceTrust: "official_verified",
    officialCapability: {
      version: 1,
      platform: "fourmeme",
      kind: "template",
      changeType: "template_updated",
      sourceId: "fourmeme_public_template_api",
      sourceUrl: "https://four.meme/meme-api/v1/public/token_template/search",
      observedAt: "2026-09-04T04:00:00.000Z",
    },
    previousTemplate: {
      id: "1778027615732", name: "Bonding Lista V2 Stake Tax V1", status: "PUBLISH",
      numericParameters: ["10%"], mechanismTerms: ["tax", "dex"],
    },
    currentTemplate: {
      id: "1778027615732", name: "Bonding Lista V2 Stake Tax V1", status: "PUBLISH",
      numericParameters: ["25%"], mechanismTerms: ["tax", "dex"],
    },
    changedFields: ["numericParameters"],
    mode: {
      selector: "official-template",
      officialName: "Bonding Lista V2 Stake Tax V1",
      componentMode: "Bonding Lista V2 Stake Tax V1",
    },
    structural: { eligible: true, source: "official_api" },
    observedAt: "2026-09-04T04:00:00.000Z",
    strong: true,
  }, { nowMs: Date.parse("2026-09-04T04:00:01.000Z") });

  const listaBundle = await buildBilingualAlertBundle(config, listaYield, "Four.Meme official X update");
  const campaignBundle = await buildBilingualAlertBundle(config, campaign, "Four.Meme official X update");
  const githubBundle = await buildBilingualAlertBundle(config, github, "Four.Meme official GitHub update");
  const templateBundle = await buildBilingualAlertBundle(config, template, "Four.Meme official template update");
  const listaRendered = renderBilingualTelegramText(listaBundle, true);
  const campaignRendered = renderBilingualTelegramText(campaignBundle, false);
  const githubRendered = renderBilingualTelegramText(githubBundle, true);
  const templateRendered = renderBilingualTelegramText(templateBundle, true);

  for (const [rendered, expected] of [
    [listaRendered, ["ListaYield", "交易税分成→Lista 收益产品", "流动性默认迁移 Lista DEX", "等待首个 TokenCreated CA，再做安全检查", "await the first TokenCreated CA, then run safety checks", "2095361508700258731"]],
    [campaignRendered, ["150,000 USDT", "50,000 USDT", "Top 500", "流量催化；非协议升级；暂无指定 CA", "延迟补报｜勿追价", "2095713912188739967"]],
    [githubRendered, ["ListaYield", "Lista V2 stake-tax", "StrategyTaxToken", "尚未确认产品上线", "four-meme-community/openfour-docs#bcf52911"]],
    [templateRendered, ["Bonding Lista V2 Stake Tax V1", "参数 10% → 25%", "等待链上启用及首个 TokenCreated CA，再做安全检查", "await on-chain activation and the first TokenCreated CA, then run safety checks", "four.meme/meme-api/v1/public/token_template/search"]],
  ]) {
    assertShortFieldLayout(rendered);
    for (const literal of expected) assert.ok(rendered.includes(literal), literal);
    assert.doesNotMatch(rendered, /selector=|security=|liquidityConfirmed=|Translation unavailable|\[object Object\]/i);
    assert.doesNotMatch(rendered, /首个安全代币|first safety-cleared token/iu);
  }
  assert.match(listaBundle.en.text, /ListaYield/);
  assert.match(campaignBundle.en.text, /150,000 USDT/);
  assert.doesNotMatch(renderedLanguageBlocks(listaRendered).en.join("\n"), /[\u3400-\u9fff]/u);
  assert.doesNotMatch(renderedLanguageBlocks(campaignRendered).en.join("\n"), /[\u3400-\u9fff]/u);
  assert.equal(translationCalls, 0);
});

test("real Four policy-fix producer events show the source, recovery, and true lag clocks", async () => {
  const recoveredAt = "2026-09-04T11:06:29.000Z";
  const project = {
    id: "fourmeme",
    name: "Four.meme",
    website: "https://four.meme",
    twitter: "https://x.com/fourdotmemezh",
    handle: "fourdotmemezh",
    xUserId: "1816036559864619011",
    match: "official_x",
    priority: true,
  };
  const texts = {
    named_mode: "Yield is now built into the launch.\n\nIntroducing ListaYield on http://Four.Meme — a new OpenFour mode powered by @lista_dao. \n\nEvery trade can route a share of trading tax into yield-bearing products, creating ongoing yield for eligible holders.\n\nAnd once the token graduates, liquidity moves to Lista DEX by default. 🧵",
    market_campaign: "bStocks szn just got competitive. 🟢\n\n150,000 USDT is now live with @AveaiGlobal × @BNBCHAIN — including a 50,000 USDT leaderboard exclusively for http://Four.Meme traders.\n\nTrade http://Four.Meme Stock Memes on http://Ave.ai.\nClimb the Top 500.\nTake your share.\n\nThe sprint is on. 🏁",
  };
  const expected = {
    named_mode: {
      lagMs: 111_901_000,
      zh: "原始发生 09-03 12:01 CST｜恢复 09-04 19:06 CST｜真实延迟 31小时5分",
      en: "Original 09-03 12:01 CST | recovered 09-04 19:06 CST | actual lag 31h5m",
      falseDelay: /延迟\s*1秒|1s delay/iu,
    },
    market_campaign: {
      lagMs: 27_882_000,
      zh: "原始发生 09-04 11:21 CST｜恢复 09-04 19:06 CST｜真实延迟 7小时44分",
      en: "Original 09-04 11:21 CST | recovered 09-04 19:06 CST | actual lag 7h44m",
      falseDelay: /延迟\s*0秒|0s delay/iu,
    },
  };

  for (const spec of FOUR_TWITTER_POLICY_RECOVERY_SPECS) {
    const tweet = {
      id: spec.tweetId,
      text: texts[spec.kind],
      createdAt: spec.createdAt,
      authorName: "Four.meme-華語",
      handle: "fourdotmemezh",
      xUserId: "1816036559864619011",
      authorId: "1816036559864619011",
      url: `https://x.com/fourdotmemezh/status/${spec.tweetId}`,
      isReply: false,
      expandedUrls: spec.kind === "market_campaign" ? ["http://Four.Meme", "http://Ave.ai"] : ["http://Four.Meme"],
      sourceVerifiedBy: "official_x_oembed",
      identityVerifiedBy: "fxtwitter_exact_numeric_id",
    };
    const rawEvent = buildFourPolicyRecoveryEvent({
      project,
      tweet,
      signal: structuredClone(FOUR_TWITTER_POLICY_RECOVERY_SIGNAL_SHAPES[spec.kind]),
      spec,
      recoveredAt,
    });
    assert.ok(rawEvent, spec.kind);
    assert.equal(rawEvent.policyFixRecovery.lagMs, expected[spec.kind].lagMs);
    const event = withTradingPriority(rawEvent, { nowMs: Date.parse(recoveredAt) + 1_000 });
    assert.equal(event.tradingPriority.tier, "T2");
    const falseDelay = spec.kind === "named_mode" ? "延迟1秒" : "延迟0秒";
    const bundle = await buildBilingualAlertBundle(
      {},
      event,
      `Four.Meme official X update\n时间: 2026-09-04T11:06:30.000Z · ${falseDelay}`,
    );
    const rendered = renderBilingualTelegramText(bundle, false);
    assertShortFieldLayout(rendered);
    assert.ok(rendered.includes(expected[spec.kind].zh), spec.kind);
    assert.ok(rendered.includes(expected[spec.kind].en), spec.kind);
    assert.equal(bundle.focusModel.time.zh, expected[spec.kind].zh);
    assert.equal(bundle.focusModel.time.en, expected[spec.kind].en);
    assert.doesNotMatch(rendered, expected[spec.kind].falseDelay);
  }
});

test("Four.Meme Registry capability and first-token cards separate provenance from token safety", async (t) => {
  const produced = await produceFourRegistryPresetAndFirstToken(t, {
    now: () => Date.parse("2026-09-04T08:00:00.000Z"),
  });
  const [rawCapability, rawFirstToken] = produced.events;
  const capability = rawCapability;
  const firstToken = rawFirstToken;

  const capabilityBundle = await buildBilingualAlertBundle({}, capability, "Four.Meme Registry update");
  const tokenBundle = await buildBilingualAlertBundle({}, firstToken, "Four.Meme Core TokenCreated");
  const capabilityText = renderBilingualTelegramText(capabilityBundle, true);
  const tokenText = renderBilingualTelegramText(tokenBundle, true);

  for (const [rendered, expected] of [
    [capabilityText, ["OpenFour Registry", produced.added.name, `Preset ${produced.added.id}`, "新增预设", "等待该能力启用后的首个代币 CA", "安全性另行核验", rawCapability.explorerUrl]],
    [tokenText, [produced.added.name, "First Confirmed (FIRST)", `CA ${rawFirstToken.token.address}`, "官方 Core TokenCreated", "安全未完成｜不买", rawFirstToken.explorerUrl]],
  ]) {
    assertShortFieldLayout(rendered);
    for (const literal of expected) assert.ok(rendered.includes(literal), literal);
    assert.doesNotMatch(rendered, /selector=|security=|Translation unavailable|自动买入|buy now/i);
  }
});

test("Four.Meme Registry protocol cards name Module, TokenImpl, Tag, and authenticated recovery facts", async (t) => {
  const fresh = await produceFourRegistryProtocolEvents(t);
  assert.deepEqual(fresh.events.map((event) => event.kind), [
    "four_registry_module_upserted",
    "four_registry_token_impl_upserted",
    "four_registry_tag_registered",
  ]);
  const freshRendered = await Promise.all(fresh.events.map(async (event) => renderBilingualTelegramText(
    await buildBilingualAlertBundle({}, event, event.signal.headline),
    true,
  )));
  for (const [rendered, expected] of [
    [freshRendered[0], ["OpenFour Module", "ModuleUpserted", "kind=curve", "active=true", fresh.events[0].module.implementation, "安全性未知｜不买"]],
    [freshRendered[1], ["OpenFour TokenImpl", "TokenImplUpserted", "version=2.0.0", fresh.events[1].tokenImplementation.tokenImplId, "安全性未知｜不买"]],
    [freshRendered[2], ["OpenFour Tag", "TagRegistered", "module.curve.lista_yield", fresh.events[2].tag.tagId, "不代表代币或组件安全｜不买"]],
  ]) {
    assertShortFieldLayout(rendered);
    for (const literal of expected) assert.ok(rendered.includes(literal), literal);
    assert.doesNotMatch(rendered, /自动买入|buy now|GMGN/i);
  }

  const recovered = await produceFourRegistryProtocolEvents(t, {
    now: () => Date.parse("2026-09-04T12:00:00.000Z"),
  });
  assert.ok(recovered.events.every((event) => event.delayedRecovery?.reason === "verified_contiguous_registry_cursor_catch_up"));
  const recoveredText = renderBilingualTelegramText(
    await buildBilingualAlertBundle({}, recovered.events[0], recovered.events[0].signal.headline),
    true,
  );
  for (const literal of ["延迟补报｜勿追价", "源 09-04 15:58 CST", "恢复 09-04 20:00 CST", "延迟 4小时1分", "非自动交易"]) {
    assert.ok(recoveredText.includes(literal), literal);
  }
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

  assert.equal(bundle.version, 23);
  assert.equal(bundle.format, "telegram_zh_en_compact_v13");
  assert.match(bundle.zh.text, /^平台：Binance/m);
  assert.match(bundle.zh.text, /更新了什么：UNITREEUSDT 永续：8小时→4小时，费率上下限 \+2\.00%\/-2\.00%/);
  assert.match(bundle.zh.text, /官方公告 · 1309b6ac/);
  assert.match(bundle.zh.text, /北京时间 08-19 16:15 生效/);
  assert.match(bundle.en.text, /What changed: UNITREEUSDT perpetual: 8h→4h, funding cap\/floor \+2\.00%\/-2\.00%/);
  assert.doesNotMatch(rendered, /更新了什么：.*版本|What changed:.*version/i);
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
  assert.ok(rendered.length <= 600);
});

test("real multi-contract Binance notice renders every target and the first launch in CST plus UTC", async () => {
  const symbols = ["NVDLUSDT", "TSLLUSDT", "DDOGUSDT", "TEAMUSDT", "MDBUSDT", "ZSUSDT", "GTLBUSDT"];
  const event = {
    type: "binance_official_update",
    kind: "announcement",
    project: { id: "binance", name: "Binance" },
    signal: { category: "新合约上线", labels: ["新合约上线"] },
    title: "Binance Futures Will Launch Multiple USDⓈ-Margined TradFi Perpetual Contracts (2026-09-02)",
    announcementDetails: {
      kind: "instrument_change",
      action: "launch",
      market: "usd_m_perpetual",
      timezone: "UTC",
      instrument: symbols[0],
      launchAt: "2026-09-02T10:00:00.000Z",
      instruments: symbols.map((symbol, index) => ({
        symbol,
        launchAt: `2026-09-02T10:${String(index * 5).padStart(2, "0")}:00.000Z`,
      })),
    },
    source: { id: "binance_cms", trust: "official_verified" },
    sourceTrust: "official_verified",
    publishedAt: "2026-09-02T09:30:00.000Z",
    observedAt: "2026-09-02T09:30:05.000Z",
  };
  const prioritizedEvent = withTradingPriority(event, { nowMs: Date.parse(event.observedAt) });
  assert.equal(prioritizedEvent.tradingPriority.tier, "T0");
  const bundle = await buildBilingualAlertBundle({}, prioritizedEvent, [
    "Binance official announcement",
    "状态: 官方公告已发布",
    "时间: 2026-09-02T09:30:00.000Z",
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);
  const blocks = renderedLanguageBlocks(rendered);

  assertShortFieldLayout(rendered);
  assert.equal(blocks.zh.length, 6);
  assert.equal(blocks.en.length, 6);
  assert.match(rendered, /事件：上线 7个 USDⓈ-M 永续合约/u);
  assert.match(rendered, new RegExp(`标的：${symbols.join("、")}`));
  assert.match(rendered, new RegExp(`Targets: ${symbols.join(", ")}`));
  assert.match(rendered, /验证：.*入场=.*失效=.*官方时间表；待开盘核验/u);
  assert.match(rendered, /Verification: .*entry=.*invalid=.*Official schedule; verify at launch/u);
  assert.match(rendered, /时间：首批开盘=09-02 18:00 CST（09-02 10:00 UTC）/u);
  assert.match(rendered, /Time: First launch=09-02 18:00 CST \(09-02 10:00 UTC\)/u);
  assert.match(rendered, /永续→深度\/持仓\/资金费率\/基差/u);
  assert.match(rendered, /perpetual→depth\/OI\/funding\/basis/u);
  assert.match(rendered, /永续≠股票/u);
  assert.match(rendered, /perpetual≠stock/u);
  assert.doesNotMatch(rendered, /现货→合约|spot→contract/iu);
  assert.ok(rendered.length <= 900, `multi-contract card is ${rendered.length} characters`);
});

test("Binance Alpha, spot, and spot-delist cards use the structured market plan without inventing perpetual exposure", async () => {
  const base = {
    type: "binance_official_update",
    kind: "announcement",
    project: { id: "binance", name: "Binance" },
    source: { id: "binance_exchange_cms", trust: "official_verified" },
    sourceTrust: "official_verified",
    publishedAt: "2026-09-03T01:00:00.000Z",
    observedAt: "2026-09-03T01:00:02.000Z",
  };
  const cases = [
    {
      name: "Alpha listing",
      event: {
        ...base,
        eventKey: "binance-alpha:list:MARSCOIN",
        signal: { category: "Alpha 上新", labels: ["Alpha 上新"], strong: true },
        title: "MARSCOIN (MARSCOIN) Is Now Available on Binance Alpha",
        announcementDetails: {
          kind: "instrument_change",
          action: "list",
          market: "spot",
          instrument: "MARSCOIN",
          launchAt: "2026-09-03T02:00:00.000Z",
          instruments: [{ symbol: "MARSCOIN", launchAt: "2026-09-03T02:00:00.000Z" }],
        },
      },
      expected: /Alpha开盘→成交深度与价格发现/u,
      expectedEn: /Alpha launch→trading depth and price discovery/u,
    },
    {
      name: "spot listing",
      event: {
        ...base,
        eventKey: "binance-spot:list:AERO",
        signal: { category: "现货首次上币", labels: ["现货首次上币"], strong: true },
        title: "Binance Will List Aerodrome (AERO) and Open Spot Trading",
        announcementDetails: {
          kind: "instrument_change",
          action: "list",
          market: "spot",
          instrument: "AERO",
          launchAt: "2026-09-03T02:05:00.000Z",
          instruments: [{ symbol: "AERO", launchAt: "2026-09-03T02:05:00.000Z" }],
        },
      },
      expected: /现货开盘→成交深度与价格发现/u,
      expectedEn: /Spot launch→trading depth and price discovery/u,
    },
    {
      name: "spot delisting",
      event: {
        ...base,
        eventKey: "binance-spot:delist:ICX",
        signal: { category: "整币下架", labels: ["整币下架"], strong: true },
        title: "Binance Will Delist ICX and Open Order Cancellation",
        announcementDetails: {
          kind: "instrument_change",
          action: "delist",
          market: "spot",
          instrument: "ICX",
          effectiveAt: "2026-09-03T03:00:00.000Z",
          instruments: [{ symbol: "ICX", effectiveAt: "2026-09-03T03:00:00.000Z" }],
        },
      },
      expected: /现货下架→订单、退出与流动性/u,
      expectedEn: /Spot delisting→orders, exits, and liquidity/u,
    },
  ];

  for (const item of cases) {
    const event = withTradingPriority(item.event, { nowMs: Date.parse(item.event.observedAt) });
    assert.equal(event.tradingPriority.tier, "T0", item.name);
    const bundle = await buildBilingualAlertBundle({}, event, [
      "Binance official announcement",
      `具体更新: ${event.title}`,
      "状态: official source confirmed",
      `时间: ${event.publishedAt}`,
    ].join("\n"));
    const rendered = renderBilingualTelegramText(bundle, true);
    assert.match(rendered, item.expected, item.name);
    assert.match(rendered, item.expectedEn, item.name);
    assert.doesNotMatch(rendered, /永续|perpetual/iu, item.name);
    if (item.event.announcementDetails.action === "delist") {
      assert.match(rendered, /不新增仓位/u);
      assert.match(rendered, /Do not add positions/u);
      assert.match(rendered, /待生效核验|verify at effective time/u);
    }
    assertShortFieldLayout(rendered);
  }
});

test("details-null Alpha and Futures audit card uses an honest language-local unresolved target", async () => {
  const observedAt = "2026-09-03T01:00:05.000Z";
  const event = withTradingPriority({
    type: "binance_official_update",
    kind: "announcement",
    project: { id: "binance", name: "Binance" },
    signal: { category: "Alpha 上新", labels: ["Alpha 上新", "新合约上线"], strong: true },
    title: "Binance Alpha and Futures Product Update",
    currentSnapshot: { details: null },
    source: { id: "binance_exchange_cms", trust: "official_verified", url: "https://www.binance.com/en/support/announcement/unresolved" },
    sourceTrust: "official_verified",
    url: "https://www.binance.com/en/support/announcement/unresolved",
    publishedAt: "2026-09-03T01:00:00.000Z",
    observedAt,
  }, { nowMs: Date.parse(observedAt) });
  assert.equal(event.tradingPriority.tier, "T2");
  let providerCalls = 0;
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async () => {
      providerCalls += 1;
      throw new Error("structured unresolved target must stay local");
    },
  }, event, [
    "Binance official announcement",
    `具体更新: ${event.title}`,
    "状态: official source confirmed",
    `时间: ${event.publishedAt}`,
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, false);
  const blocks = renderedLanguageBlocks(rendered);

  assert.equal(providerCalls, 0);
  assert.match(blocks.zh.join("\n"), /Binance Alpha 上新；标的待解析/u);
  assert.match(blocks.en.join("\n"), /Binance Alpha listing; unresolved target/u);
  assert.doesNotMatch(rendered, /新代币/u);
  assert.doesNotMatch(blocks.en.join("\n"), /[\u3400-\u9fff]/u);
  assertShortFieldLayout(rendered);
});

test("large Binance batches preserve every exact target across bounded continuation lines", async () => {
  const symbols = Array.from({ length: 18 }, (_value, index) => `LONGTOKEN${String(index + 1).padStart(2, "0")}USDT`);
  const observedAt = "2026-09-03T01:00:05.000Z";
  const event = withTradingPriority({
    type: "binance_official_update",
    kind: "announcement",
    project: { id: "binance", name: "Binance" },
    signal: { category: "新合约上线", labels: ["新合约上线"], strong: true },
    title: "Binance Futures Will Launch Multiple USDⓈ-Margined Perpetual Contracts",
    announcementDetails: {
      kind: "instrument_change",
      action: "launch",
      market: "usd_m_perpetual",
      timezone: "UTC",
      instrument: symbols[0],
      launchAt: "2026-09-03T02:00:00.000Z",
      instruments: symbols.map((symbol, index) => ({
        symbol,
        launchAt: `2026-09-03T02:${String(index).padStart(2, "0")}:00.000Z`,
      })),
    },
    source: { id: "binance_exchange_cms", trust: "official_verified", url: "https://www.binance.com/en/support/announcement/batch" },
    sourceTrust: "official_verified",
    url: "https://www.binance.com/en/support/announcement/batch",
    publishedAt: "2026-09-03T01:00:00.000Z",
    observedAt,
  }, { nowMs: Date.parse(observedAt) });
  assert.equal(event.tradingPriority.tier, "T0");

  const bundle = await buildBilingualAlertBundle({}, event, [
    "Binance official announcement",
    "状态: 官方公告已发布",
    `时间: ${observedAt}`,
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);
  const blocks = renderedLanguageBlocks(rendered);
  assert.equal(blocks.zh.length, 7);
  assert.equal(blocks.en.length, 7);
  const zhTargetLines = blocks.zh.filter((line) => /^标的(?:续)?：/u.test(line));
  const enTargetLines = blocks.en.filter((line) => /^Targets(?: cont\.)?:/u.test(line));
  assert.equal(zhTargetLines.length, 3);
  assert.equal(enTargetLines.length, 3);
  assert.ok([...zhTargetLines, ...enTargetLines].every((line) => line.length <= 120));
  for (const symbol of symbols) {
    assert.ok(blocks.zh.join("\n").includes(symbol), `Chinese block lost ${symbol}`);
    assert.ok(blocks.en.join("\n").includes(symbol), `English block lost ${symbol}`);
  }
  assert.match(rendered, /标的续：/u);
  assert.match(rendered, /Targets cont\.:/u);
  assert.ok(rendered.length < 3_800, `batch card is ${rendered.length} characters`);
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
  assert.equal(bundle.version, 23);
  assert.equal(bundle.format, "telegram_zh_en_compact_v13");
  assert.match(bundle.zh.text, /^平台：Uniswap/m);
  assert.match(bundle.en.text, /^Platform: Uniswap/m);
  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.equal(block.split("\n").length, 2);
    assert.match(block, /MemeRaceHook→Robinhood·(?:固定费率|fixed fee)\(dynamicFee=false\)·chainId=4663/);
    assert.match(block, new RegExp(`Hook ${hookAddress}`));
    assert.match(block, new RegExp(relatedAddress));
    assert.match(block, /#ec570ace/);
    assert.doesNotMatch(block, new RegExp(commit));
    assert.doesNotMatch(block, /hooks\/robinhood|\+\d+ more|另有\d+项/);
  }
  assert.match(bundle.zh.text, /关联 .*（角色待核）/);
  assert.match(bundle.en.text, /Related .*\(role pending\)/);
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
  assert.match(ordinaryRendered, /Spot→Robinhood·(?:动态费率|dynamic fee)\(dynamicFee=true\)·chainId=4663/);
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
  assert.equal(result.status, "suppressed");
  assert.equal(result.reason, "policy_suppressed");
  assert.equal(payload, undefined, "a T3 repository update must remain audit-only");
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
  assert.match(bundle.zh.text, /文章已发布；功能上线未证实｜原文时间未取得/);
  assert.match(bundle.en.text, /Article published; feature launch unverified \| Source publication time unavailable/);
  assert.match(bundle.zh.text, /官方博客/);
  assert.match(bundle.en.text, /Official blog/);
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
  assert.match(bundle.zh.text, /^平台：Uniswap/m);
  assert.match(bundle.en.text, /^Platform: Uniswap/m);
  assert.match(bundle.zh.text, /更新了什么：新增: Robinhood Hooks 支持/);
  assert.match(bundle.en.text, /What changed: Added: Robinhood hooks support/);
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
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
});

test("Telegram news renders the two-field bilingual template and can never become a strong alert", async () => {
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
      return googleResponse(source
        .replace("Headline copied from the producer", "生产方标题")
        .replace("Summary:", "摘要：")
        .replace("adds guarded routing through", "新增受保护路由，调用")
        .replace("Type:", "类型：")
        .replace("Public-channel observation; awaiting official verification", "公开频道观察，待官方核实"));
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
  assert.equal(bundle.version, 23);
  assert.equal(bundle.eventType, "telegram_news_update");
  assert.equal(bundle.focusModel.telegramNews.messageUrl, event.messageUrl);
  assert.equal(zh.length, 2);
  assert.equal(en.length, 2);
  assert.equal(zh[0], "平台：Telegram · @maxguruai");
  assert.equal(en[0], "Platform: Telegram · @maxguruai");
  assert.match(zh[1], /^更新了什么：生产方标题｜摘要：.*MCP v2\.1.*triggerFeeUpdate\(\).*类型：AI Agent.*@maxguruai#4821.*公开频道观察，待官方核实.*08-24 10:03 CST/u);
  assert.match(en[1], /^What changed: Headline copied from the producer \| Summary: .*MCP v2\.1.*triggerFeeUpdate\(\).*Type: AI Agent.*@maxguruai#4821.*Public-channel observation; awaiting official verification.*08-24 10:03 CST/u);
  assert.match(rendered, /^🔔 监控提醒 \| MONITOR ALERT\n/u);
  assert.match(rendered, /事件：生产方标题/u);
  assert.match(rendered, /Event: Headline copied from the producer/u);
  assert.match(rendered, /时间：08-24 10:03 CST/u);
  assertShortFieldLayout(rendered);
  assert.doesNotMatch(rendered, /STRONG ALERT|RAW TELEGRAM|UNTRUSTED CHANNEL|unverified_author/);
  assert.ok(rendered.length <= 900, `Telegram news card length=${rendered.length}`);
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
      headline: "Protocol launches MCP v2.1 guarded routing",
      summary: "MCP v2.1 adds triggerFeeUpdate() support",
      confidence: "observed",
    },
  }, "Telegram channel observation");
  assert.equal(englishSource.focusModel.telegramNews.sourceLanguage, "en");
  assert.match(englishSource.zh.text.split("\n")[1], /^更新了什么：中文翻译暂不可用；英文原文已保留在下方英文区/u);
  assert.doesNotMatch(englishSource.zh.text, /English 区/u);
  assert.doesNotMatch(englishSource.zh.text, /adds triggerFeeUpdate/u);
  assert.match(englishSource.en.text.split("\n")[1], /^What changed: Protocol launches MCP v2\.1 guarded routing \| Summary: MCP v2\.1 adds triggerFeeUpdate\(\) support/u);

  clearTranslationCache();
  const chineseSource = await buildBilingualAlertBundle(unavailableConfig, {
    ...common,
    news: {
      category: "协议更新",
      headline: "协议发布 MCP v2.1 受保护路由",
      summary: "MCP v2.1 新增 triggerFeeUpdate() 支持",
      confidence: "observed",
    },
  }, "Telegram 公开频道观察");
  const rendered = renderBilingualTelegramText(chineseSource, true);
  assert.equal(chineseSource.focusModel.telegramNews.sourceLanguage, "zh");
  assert.match(chineseSource.zh.text.split("\n")[1], /^更新了什么：协议发布 MCP v2\.1 受保护路由｜摘要：MCP v2\.1 新增 triggerFeeUpdate\(\) 支持/u);
  assert.match(chineseSource.en.text.split("\n")[1], /^What changed: English translation unavailable; Chinese source retained in the Chinese section above/u);
  assert.doesNotMatch(chineseSource.en.text, /新增.*支持/u);
  assert.doesNotMatch(chineseSource.en.text, /[\u3400-\u9fff]/u);
  for (const block of [englishSource, chineseSource]) {
    assert.equal(block.zh.status === "fallback_source" || block.en.status === "fallback_source", true);
    assert.match(`${block.zh.provider} ${block.en.provider}`, /google_gtx_public\+mymemory_public/u);
    assert.equal(block.zh.text.split("\n").length, 2);
    assert.equal(block.en.text.split("\n").length, 2);
    const fallbackRendered = renderBilingualTelegramText(block, true);
    assert.match(fallbackRendered, /@maxguruai#4822/u);
    assert.match(fallbackRendered, /公开频道观察，待官方核实/u);
    assert.match(fallbackRendered, /Public-channel observation; awaiting official verification/u);
    assert.doesNotMatch(fallbackRendered, /请看下方英文原文[\s\S]*see verified Chinese facts above/iu);
    assertShortFieldLayout(fallbackRendered);
    assert.ok(fallbackRendered.length <= 900);
  }
  assert.match(rendered, /^🔔 监控提醒 \| MONITOR ALERT\n/u);
});

test("Telegram translates only narrative fragments and preserves #3191 financial meaning without marker collision", async () => {
  clearTranslationCache();
  const headline = "截至9月1日，基金净流出2.365亿美元，单日净流出860万美元";
  const summary = "比特币价格为77,520美元，以太坊价格为2,412美元";
  const providerQueries = [];
  const event = {
    type: "telegram_news_update",
    eventKey: "telegram-news:-1002540748528:3191:financial-flow",
    sourceTrust: "public_telegram_observed",
    channel: { username: "maxguruai", visibility: "public" },
    messageId: 3191,
    messageUrl: "https://t.me/maxguruai/3191",
    sourceOccurredAt: "2026-09-01T02:03:04.000Z",
    observedAt: "2026-09-01T02:03:05.000Z",
    priority: { version: 1 },
    freshness: { version: 2 },
    news: { category: "market", headline, summary, confidence: "observed" },
  };
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async (url) => {
      const source = new URL(url).searchParams.get("q") || "";
      providerQueries.push(source);
      if (source.includes("基金净流出")) {
        return googleResponse("As of September 1, fund net outflow reached $236.5 million, including a $8.6 million daily net outflow");
      }
      if (source.includes("比特币价格")) {
        return googleResponse("Bitcoin traded at $77,520 and Ethereum at $2,412");
      }
      throw new Error(`unexpected translation fragment: ${source}`);
    },
    alertTranslationTimeoutMs: 500,
  }, event, "Telegram public-channel observation");
  const rendered = renderBilingualTelegramText(bundle, false);

  assert.equal(bundle.focusModel.telegramNews.sourceLanguage, "zh");
  assert.equal(bundle.en.status, "translated");
  assert.equal(bundle.en.provider, "google_gtx_public");
  assert.match(bundle.en.text, /net outflow/iu);
  assert.match(bundle.en.text, /\$236\.5 million/u);
  assert.match(bundle.en.text, /\$8\.6 million/u);
  assert.match(bundle.en.text, /\$77,520/u);
  assert.match(bundle.en.text, /\$2,412/u);
  assert.ok(providerQueries.length === 2);
  assert.ok(providerQueries.every((query) => !/@maxguruai|CST|public.channel|公开频道|Type:|类型：/iu.test(query)));
  assert.ok(providerQueries.every((query) => !/ZXQKEEP[A-Z]+QXZ/iu.test(query)), providerQueries.join("\n"));
  assert.match(bundle.en.text, /@maxguruai#3191/u);
  assert.match(bundle.en.text, /Public-channel observation; awaiting official verification/u);
  assert.doesNotMatch(bundle.en.text, /translation unavailable|fallback/iu);
  assert.doesNotMatch(bundle.en.text, /[\u3400-\u9fff]/u);
  assertShortFieldLayout(rendered);
});

test("real Telegram #3160, #3163, and #3191 cards keep numeric catalysts and source IDs atomic", async () => {
  const fixtures = [
    {
      id: 3160,
      category: "security",
      sourceOccurredAt: "2026-09-01T06:30:40.000Z",
      observedAt: "2026-09-01T06:30:42.837Z",
      headline: "Cronos 网络在约 7500 万美元 Tectonic 漏洞利用后暂停",
      summary: "与 Crypto.com 相关联的 Cronos 区块链在借贷协议 Tectonic 遭受明显的价格操纵攻击后暂停了运营。一位链上研究人员估计，攻击者将流动性不足的 TONIC 代币价格抬高约 100 倍，从而借入约 7500 万美元的其他资产；在暂停之前，只有约 600 万美元被桥接出去。 重要性在于：预言机（Oracle）和价格操纵风险对较小的 DeFi 借贷市场仍然是现实威胁。",
      headlineEn: "Cronos network pauses after an approximately $75 million Tectonic exploit",
      summaryEn: "The Crypto.com-linked Cronos blockchain paused after an apparent price manipulation attack on lending protocol Tectonic. An on-chain researcher estimated that the attacker raised the illiquid TONIC token price by about 100 times, allowing roughly $75 million of other assets to be borrowed; only about $6 million was bridged out before the pause. Oracle and price manipulation risks remain real threats to smaller DeFi lending markets.",
      atoms: ["$75m", "$6m", "100x"],
      time: "09-01 14:30 CST (09-01 06:30 UTC)",
    },
    {
      id: 3163,
      category: "funding",
      sourceOccurredAt: "2026-09-01T10:15:32.000Z",
      observedAt: "2026-09-01T10:15:33.056Z",
      headline: "Bullish 向 USD.AI 提供 1 亿美元信贷额度，用于 GPU 抵押贷款",
      summary: "加密货币交易所 Bullish 向稳定币协议 USD.AI（由 Permian Labs 构建）提供了 1 亿美元的债务融资额度，以支持 GPU 抵押贷款。USD.AI 目前已锁定超过 2.25 亿美元的加密资产，Bullish 计划上线其 sUSDai 代币并新增交易对。 重要性：这表明 DeFi 信贷市场与 AI 基础设施融资之间的融合日益加深，这一新兴领域值得关注，未来或有更多机构资本涌入。",
      headlineEn: "Bullish provides USD.AI with a $100 million credit facility for GPU-backed loans",
      summaryEn: "Crypto exchange Bullish provided stablecoin protocol USD.AI, built by Permian Labs, with a $100 million debt facility for GPU-backed loans. USD.AI now has more than $225 million in crypto assets locked. Bullish plans to list sUSDai and add trading pairs. This shows growing convergence between DeFi credit and AI infrastructure financing.",
      atoms: ["$100m", "$225m"],
      time: "09-01 18:15 CST (09-01 10:15 UTC)",
    },
    {
      id: 3191,
      category: "product",
      sourceOccurredAt: "2026-09-02T16:15:41.000Z",
      observedAt: "2026-09-02T16:15:48.528Z",
      headline: "比特币ETF在9天内首次出现资金流出（2.365亿美元），BTC跌破7.7万美元",
      summary: "现货比特币ETF在9月1日净流出2.365亿美元，结束了连续九天的资金流入。现货以太坊ETF仍录得适度流入860万美元，而由于伊朗局势升级冲击风险资产，BTC跌至约77,520美元，ETH跌至约2,412美元。 重要原因：BTC/ETH的分化表明是轮动而非全面退出加密货币，但资金流入连续趋势的结束可能预示着在9月FOMC会议前机构短期持谨慎态度。",
      headlineEn: "Bitcoin ETFs see their first fund outflow in 9 days ($236.5 million), while BTC falls below $77,000",
      summaryEn: "Spot Bitcoin ETFs recorded a net outflow of $236.5 million on September 1, ending nine consecutive days of inflows. Spot Ethereum ETFs still recorded an $8.6 million inflow, while BTC fell to about $77,520 and ETH fell to about $2,412 as escalation involving Iran hit risk assets. The BTC/ETH divergence suggests rotation rather than a broad crypto exit, but the end of the inflow streak may signal short-term institutional caution before the September (month 9) FOMC meeting.",
      atoms: ["$236.5m", "$8.6m"],
      time: "09-03 00:15 CST (09-02 16:15 UTC)",
    },
  ];

  for (const fixture of fixtures) {
    clearTranslationCache();
    const providerQueries = [];
    const event = {
      type: "telegram_news_update",
      eventKey: `telegram-news:-1002540748528:${fixture.id}:real-fixture`,
      sourceTrust: "public_telegram_observed",
      channel: { username: "maxguruai", visibility: "public" },
      messageId: fixture.id,
      messageUrl: `https://t.me/maxguruai/${fixture.id}`,
      sourceOccurredAt: fixture.sourceOccurredAt,
      observedAt: fixture.observedAt,
      news: {
        category: fixture.category,
        headline: fixture.headline,
        summary: fixture.summary,
        confidence: "observed",
      },
    };
    const bundle = await buildBilingualAlertBundle({
      alertTranslationFetchImpl: async (url) => {
        const source = new URL(url).searchParams.get("q") || "";
        providerQueries.push(source);
        const translated = source.includes(fixture.headline.slice(-8))
          || (!source.includes("重要") && providerQueries.length % 2 === 1)
          ? fixture.headlineEn
          : fixture.summaryEn;
        const markers = source.match(/ZXQKEEP[A-Z]+QXZ/gu) || [];
        return googleResponse(`${translated}${markers.length ? ` ${markers.join(" ")}` : ""}`);
      },
      alertTranslationTimeoutMs: 500,
    }, event, "Telegram public-channel observation");
    const rendered = renderBilingualTelegramText(bundle, false);
    const blocks = renderedLanguageBlocks(rendered);

    assert.equal(bundle.en.status, "translated", `#${fixture.id}: ${bundle.en.error || "no error"}`);
    assert.equal(providerQueries.length, 2, `#${fixture.id}`);
    assert.ok(providerQueries.every((query) => !/@maxguruai|CST|公开频道|Type:|类型：/iu.test(query)), `#${fixture.id}`);
    for (const language of ["zh", "en"]) {
      const text = blocks[language].join("\n");
      assert.match(text, new RegExp(`@maxguruai#${fixture.id}`), `#${fixture.id} ${language}`);
      for (const atom of fixture.atoms) assert.ok(text.includes(atom), `#${fixture.id} ${language} lost ${atom}`);
      const numericLines = blocks[language].filter((line) => /^(?:数字(?:续)?：|Numbers(?: cont\.)?:)/u.test(line));
      assert.ok(numericLines.length >= 1 && numericLines.length <= 2, `#${fixture.id} ${language}`);
      assert.ok(numericLines.every((line) => line.length <= 120), `#${fixture.id} ${language} numeric line too long`);
      assert.ok(text.includes(fixture.time), `#${fixture.id} ${language} lost source time`);
    }
    if (fixture.id === 3160) {
      assert.match(blocks.zh.join("\n"), /100x/u);
      assert.match(blocks.en.join("\n"), /100x/u);
    }
    if (fixture.id === 3191) {
      assert.match(blocks.zh.join("\n"), /净流出 \$236\.5m/u);
      assert.match(blocks.en.join("\n"), /outflow \$236\.5m/iu);
      assert.match(blocks.zh.join("\n"), /BTC 下跌 77,520/u);
      assert.match(blocks.zh.join("\n"), /ETH 下跌 2,412/u);
      assert.match(blocks.en.join("\n"), /BTC down 77,520/iu);
      assert.match(blocks.en.join("\n"), /ETH down 2,412/iu);
      assert.doesNotMatch(blocks.zh.join("\n"), /净流出 \$77k/iu);
      assert.doesNotMatch(blocks.en.join("\n"), /outflow \$77k/iu);
    }
    assertShortFieldLayout(rendered);
    assert.ok(rendered.length < 3_800, `#${fixture.id} card length=${rendered.length}`);
  }
});

test("live-provider partial fallback derives target-language Numbers from the persisted source narrative", async () => {
  const fixtures = [
    {
      id: 3163,
      category: "funding",
      sourceOccurredAt: "2026-09-01T10:15:32.000Z",
      headline: "Bullish 向 USD.AI 提供 1 亿美元信贷额度，用于 GPU 抵押贷款",
      summary: "加密货币交易所 Bullish 向稳定币协议 USD.AI（由 Permian Labs 构建）提供了 1 亿美元的债务融资额度，以支持 GPU 抵押贷款。USD.AI 目前已锁定超过 2.25 亿美元的加密资产，Bullish 计划上线其 sUSDai 代币并新增交易对。",
      headlineNeedle: "信贷额度",
      headlineEn: "Bullish provides USD.AI with a $100 million credit facility for GPU-backed loans",
      atoms: [/\$100m/u, /\$225m/u],
    },
    {
      id: 3191,
      category: "product",
      sourceOccurredAt: "2026-09-02T16:15:41.000Z",
      headline: "比特币ETF在9天内首次出现资金流出（2.365亿美元），BTC跌破7.7万美元",
      summary: "现货比特币ETF在9月1日净流出2.365亿美元，结束了连续九天的资金流入。现货以太坊ETF仍录得适度流入860万美元，而由于伊朗局势升级冲击风险资产，BTC跌至约77,520美元，ETH跌至约2,412美元。",
      headlineNeedle: "首次出现资金流出",
      headlineEn: "Bitcoin ETFs see their first outflow in 9 days ($236.5 million), while BTC falls below $77,000",
      atoms: [/outflow \$236\.5m/iu, /inflow \$8\.6m/iu, /BTC down \$?77,520/iu, /ETH down \$?2,412/iu],
    },
  ];

  for (const fixture of fixtures) {
    clearTranslationCache();
    const event = {
      type: "telegram_news_update",
      eventKey: `telegram-news:-1002540748528:${fixture.id}:live-partial-fallback`,
      sourceTrust: "public_telegram_observed",
      channel: { username: "maxguruai", visibility: "public" },
      messageId: fixture.id,
      messageUrl: `https://t.me/maxguruai/${fixture.id}`,
      sourceOccurredAt: fixture.sourceOccurredAt,
      observedAt: fixture.sourceOccurredAt,
      news: {
        category: fixture.category,
        headline: fixture.headline,
        summary: fixture.summary,
        confidence: "observed",
      },
    };
    const bundle = await buildBilingualAlertBundle({
      alertTranslationFetchImpl: async (url) => {
        const source = new URL(url).searchParams.get("q") || "";
        if (!source.includes(fixture.headlineNeedle)) {
          return { ok: false, status: 503, text: async () => "temporary provider failure" };
        }
        const markers = source.match(/ZXQKEEP[A-Z]+QXZ/gu) || [];
        return googleResponse(`${fixture.headlineEn}${markers.length ? ` ${markers.join(" ")}` : ""}`);
      },
      alertTranslationTimeoutMs: 500,
    }, event, "Telegram public-channel observation");
    const rendered = renderBilingualTelegramText(bundle, false);
    const blocks = renderedLanguageBlocks(rendered);
    const english = blocks.en.join("\n");

    assert.equal(bundle.en.status, "partial_fallback", `#${fixture.id}: ${bundle.en.error || "no error"}`);
    assert.equal(bundle.focusModel.telegramNews.localized.en.unavailable, true, `#${fixture.id}`);
    assert.match(english, /English translation unavailable; Chinese source retained in the Chinese section above/u);
    assert.match(english, new RegExp(`@maxguruai#${fixture.id}`), `#${fixture.id}`);
    for (const atom of fixture.atoms) assert.match(english, atom, `#${fixture.id} lost ${atom}`);
    if (fixture.id === 3191) {
      assert.doesNotMatch(english, /outflow \$77k/iu);
      assert.doesNotMatch(english, /inflow \$77k/iu);
    }
    assertShortFieldLayout(rendered);
  }
});

test("Chinese price boundary verbs render as asset prices and never as flow amounts", async () => {
  const cases = [
    ["BTC跌破7.7万美元", "BTC down $77k"],
    ["BTC涨破8.1万美元", "BTC up $81k"],
    ["BTC升至8.2万美元", "BTC up $82k"],
    ["BTC下探7.5万美元", "BTC down $75k"],
    ["BTC上探8.3万美元", "BTC up $83k"],
  ];
  const unavailable = async () => ({ ok: false, status: 503, text: async () => "provider unavailable" });

  for (const [headline, expected] of cases) {
    clearTranslationCache();
    const messageId = 5000 + cases.findIndex((item) => item[0] === headline);
    const bundle = await buildBilingualAlertBundle({
      alertTranslationFetchImpl: unavailable,
      alertTranslationTimeoutMs: 100,
    }, {
      type: "telegram_news_update",
      eventKey: `telegram-news:-1002540748528:${messageId}:price-boundary`,
      sourceTrust: "public_telegram_observed",
      channel: { username: "maxguruai", visibility: "public" },
      messageId,
      messageUrl: `https://t.me/maxguruai/${messageId}`,
      sourceOccurredAt: "2026-09-02T16:15:41.000Z",
      observedAt: "2026-09-02T16:15:42.000Z",
      news: {
        category: "market",
        headline,
        summary: "价格阈值来自公开频道观察，仍待官方核实。",
        confidence: "observed",
      },
    }, "Telegram public-channel observation");
    const rendered = renderBilingualTelegramText(bundle, false);
    const english = renderedLanguageBlocks(rendered).en.join("\n");

    assert.match(english, new RegExp(expected.replace("$", "\\$"), "u"));
    assert.doesNotMatch(english, /(?:outflow|inflow) \$\d/iu);
    assertShortFieldLayout(rendered);
  }
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

    assert.equal(bundle.version, 23, type);
    assert.equal(bundle.format, "telegram_zh_en_compact_v13", type);
    assert.match(bundle.zh.text, /[\u3400-\u9fff]/, type);
    assert.match(bundle.en.text, /[A-Za-z]{3,}/, type);
    assert.match(rendered, /^🔔 监控提醒 \| MONITOR ALERT\n🇨🇳 中文\n/, type);
    assert.match(rendered, /\n\n🇬🇧 English\n/, type);
    assertShortFieldLayout(rendered);
    assert.equal(bundle.zh.text.split("\n").length, 2, type);
    assert.equal(bundle.en.text.split("\n").length, 2, type);
    assert.ok(rendered.split("\n").length <= 18, type);
    assert.ok(rendered.length <= 600, type);
  }
});

test("every bilingual alert persists a one-glance before/after model and fails over honestly", async () => {
  clearTranslationCache();
  const bundle = await buildBilingualAlertBundle({
    alertTranslationFetchImpl: async (url) => {
      const parsed = new URL(url);
      const source = parsed.searchParams.get("q") || "";
      return googleResponse(parsed.searchParams.get("tl") === "zh-CN"
        ? source.replaceAll("Wallet API", "钱包 API")
        : source);
    },
    alertTranslationTimeoutMs: 3_000,
  }, {
    type: "binance_official_update",
    kind: "announcement",
    project: { id: "binance", name: "Binance" },
    previousSnapshot: { title: "Wallet API v1", facts: ["One route"] },
    currentSnapshot: { title: "Wallet API v2", facts: ["Two routes"] },
    changedFields: ["title", "facts"],
    comparisonBasis: "exact_snapshot",
    source: { name: "Binance Wallet 官方公告" },
  }, "🚨 Binance Wallet 更新\n事件: Wallet API v2\n状态: 官方公告已确认\n时间: 2026-08-13 00:00:00");

  assert.equal(bundle.version, 23);
  assert.equal(bundle.format, "telegram_zh_en_compact_v13");
  assert.equal(bundle.changeModel.basis, "exact_snapshot");
  assert.match(bundle.zh.text, /更新了什么：中文翻译暂不可用；请看英文原文/);
  assert.match(bundle.en.text, /What changed:.*Wallet API v1.*→.*Wallet API v2/i);
  assert.doesNotMatch(bundle.zh.text, /变化类型:|原有:|更新后:|对比依据:/);
  assert.doesNotMatch(bundle.en.text, /Change type:|Before:|After:|Comparison basis:/i);
  assert.doesNotMatch(bundle.zh.text, /Wallet API|One route|Two routes/);
  assert.match(bundle.changeModel.before.text, /title: Wallet API v1/);
  assert.match(bundle.changeModel.after.text, /title: Wallet API v2/);
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
  assert.match(bundle.en.text, /What changed:.*Grok API v1.*→.*Grok API v2/);
  assert.equal(bundle.en.text.split("\n").length, 2);
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
  assert.match(renderBilingualTelegramText(bundle, true), new RegExp(address));
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
  assert.match(renderBilingualTelegramText(bundle, true), new RegExp(address));
  assert.ok(renderBilingualTelegramText(bundle, true).split("\n").length <= 18);
  assert.ok(renderBilingualTelegramText(bundle, true).length <= 600);
});

test("two-field evidence budgeting drops a lower-priority CA atomically instead of truncating identifiers", async () => {
  const owner = "o".repeat(39);
  const repositoryName = "r".repeat(70);
  const repository = `${owner}/${repositoryName}`;
  const functionName = `${"deployFactory".padEnd(58, "X")}()`;
  const contract = `0x${"a".repeat(40)}`;
  const commit = "abcdef1234567890abcdef1234567890abcdef12";
  const bundle = await buildBilingualAlertBundle({}, {
    type: "github_module_update",
    launchpad: "Flap",
    repository,
    commit,
    contract,
    githubChange: {
      primaryFact: { file: "src/factory.ts", kind: "function", subject: functionName, action: "added" },
    },
    files: [{ filename: "src/factory.ts", status: "modified" }],
    committedAt: "2026-08-21T01:08:00Z",
  }, "GitHub update\n时间: 2026-08-21 09:08 CST");
  const rendered = renderBilingualTelegramText(bundle, true);
  const revision = `${repository}#${commit.slice(0, 8)}`;

  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.equal(block.split("\n").length, 2);
    assert.ok(block.includes(revision));
    assert.ok(block.includes(functionName));
    assert.ok(!block.includes(contract), "the lower-priority CA must be omitted as a whole evidence item");
    assert.doesNotMatch(block, /0x[0-9a-f]{1,39}…/i);
  }
  assert.ok(rendered.length <= 600, `atomic evidence card was ${rendered.length}`);
});

test("Binance product T1 uses a product-capital brief instead of launchpad first-token logic", async () => {
  const observedAt = "2026-09-02T01:01:02.000Z";
  const event = withTradingPriority({
    type: "binance_official_update",
    kind: "announcement",
    eventKey: "binance-product:agent-wallet-routing",
    project: { id: "binance-wallet", name: "Binance Wallet" },
    signal: { category: "产品功能上线", labels: ["新功能/产品更新"], strong: true },
    productFeature: true,
    binanceChange: { classification: "product_feature", productFeature: true, substantive: true },
    title: "Binance Wallet adds automated agent wallet routing",
    source: {
      id: "binance_wallet_cms",
      url: "https://www.binance.com/en/support/announcement/agent-wallet-routing",
    },
    url: "https://www.binance.com/en/support/announcement/agent-wallet-routing",
    publishedAt: "2026-09-02T01:01:00.000Z",
    observedAt,
  }, { nowMs: Date.parse(observedAt) });
  assert.equal(event.tradingPriority.tier, "T1");
  assert.equal(event.tradingPriority.category, "binance_product");

  const bundle = await buildBilingualAlertBundle({}, event, [
    "Binance Wallet product update",
    `具体更新: ${event.title}`,
    "状态: official source confirmed",
    `时间: ${observedAt}`,
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);

  assert.match(bundle.zh.text, /资金路径=产品→资金入口；入场=标的\+采用；失效=无直接资金流/);
  assert.match(bundle.en.text, /flow=product→capital access; entry=target\+adoption; invalid=no direct flow/);
  assert.doesNotMatch(rendered, /新模式→首币|new mode→first token/iu);
  assert.equal(bundle.zh.text.split("\n").length, 2);
  assert.equal(bundle.en.text.split("\n").length, 2);
  assert.ok(rendered.length <= 600, `Binance product card was ${rendered.length}`);
});

test("Binance venue security T0 renders risk containment instead of a listing trade plan", async () => {
  const observedAt = "2026-09-03T01:10:05.000Z";
  const event = withTradingPriority({
    type: "binance_official_update",
    kind: "announcement",
    eventKey: "binance-security:withdrawals-paused",
    project: { id: "binance", name: "Binance" },
    signal: { scope: "exchange", category: "安全/紧急公告", labels: ["安全/紧急公告"], strong: true },
    title: "Binance confirms a security breach and suspends all withdrawals",
    source: {
      id: "binance_exchange_cms",
      trust: "official_verified",
      url: "https://www.binance.com/en/support/announcement/security-withdrawals-paused",
    },
    sourceTrust: "official_verified",
    url: "https://www.binance.com/en/support/announcement/security-withdrawals-paused",
    publishedAt: "2026-09-03T01:10:00.000Z",
    observedAt,
  }, { nowMs: Date.parse(observedAt) });
  assert.equal(event.tradingPriority.tier, "T0");
  assert.equal(event.tradingPriority.category, "binance_security_emergency");

  const bundle = await buildBilingualAlertBundle({}, event, [
    "Binance official security announcement",
    `具体更新: ${event.title}`,
    "状态: 官方公告已确认",
    `时间: ${observedAt}`,
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);
  assert.match(rendered, /事件：Binance 确认安全事件并暂停提现/u);
  assert.match(rendered, /路径=平台风险→充提\/交易\/流动性/u);
  assert.match(rendered, /入场=核对范围\+链上异常\+恢复条件/u);
  assert.match(rendered, /Event: Binance confirmed a security incident and suspended withdrawals/u);
  assert.match(rendered, /flow=venue risk→funding\/trading\/liquidity/u);
  assert.doesNotMatch(rendered, /现货\/Alpha|spot\/Alpha|开盘量价|opening price-volume/iu);
  assertShortFieldLayout(rendered);
  assert.ok(rendered.length < 900, `security card was ${rendered.length}`);
});

test("T0 compaction bounds chain-controlled names while keeping CA and selector evidence readable", async () => {
  const address = "0x4444444444444444444444444444444444444444";
  const selector = "0x12345678";
  const observedAt = "2026-09-02T01:16:02.000Z";
  const longTokenName = "N".repeat(111);
  const longModeName = `Mode-${"X".repeat(111)}`;
  const event = withTradingPriority({
    type: "bsc_launchpad_update",
    kind: "new_mode",
    eventKey: "bsc-feature-first-token:flap:long-display-stress",
    featureFirstToken: true,
    featureActivationKey: "flap:feature:long-display:first-token",
    platform: { id: "flap", name: "Flap", trust: "official_verified" },
    chainId: 56,
    launcher: "0x1111111111111111111111111111111111111111",
    tokens: [{ token: address, metadata: { name: longTokenName, symbol: "LONGTOKEN1" } }],
    transactionHash: `0x${"c".repeat(64)}`,
    blockNumber: 63_500_003,
    blockTimestamp: "2026-09-02T01:16:00.000Z",
    observedAt,
    mode: { selector, componentMode: longModeName, fingerprint: "long-display-stress" },
    structural: { eligible: true },
    security: { decision: "pass", metrics: { liquidityConfirmed: true } },
    strong: true,
  }, { nowMs: Date.parse(observedAt) });
  assert.equal(event.tradingPriority.tier, "T0");

  const bundle = await buildBilingualAlertBundle({}, event, [
    "Flap first-token activation",
    "具体更新: chain-controlled long token and mode display names",
    "状态: verified on-chain",
    `时间: ${observedAt}`,
  ].join("\n"));
  const rendered = renderBilingualTelegramText(bundle, true);

  for (const block of [bundle.zh.text, bundle.en.text]) {
    assert.equal(block.split("\n").length, 2);
    assert.ok(block.includes(`CA ${address}`), "CA label must remain attached to the complete address");
    assert.ok(block.includes(`selector=${selector}`), "selector label must remain attached to the complete selector");
    assert.ok(block.includes("security=pass"));
    assert.ok(block.includes("liquidityConfirmed=true"));
    assert.ok(!block.includes(longTokenName), "untrusted display prose should be compacted before exact identifiers");
    assert.doesNotMatch(block, /0x[0-9a-f]{1,39}…/iu);
  }
  assertShortFieldLayout(rendered);
  assert.ok(rendered.length <= 900, `long trading card was ${rendered.length}`);
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
    signal: { scope: "wallet", category: "产品功能上线", labels: ["新功能/产品更新"], strong: true },
    productFeature: true,
    binanceChange: { classification: "product_feature", productFeature: true, substantive: true },
    title: "Binance Wallet introduces a new launch API",
    url: "https://www.binance.com/en/support/announcement/example",
    source: { id: "binance_wallet_cms", trust: "official_verified", url: "https://www.binance.com/en/support/announcement/example" },
    sourceTrust: "official_verified",
    publishedAt: new Date(Date.now() - 30_000).toISOString(),
    observedAt: new Date().toISOString(),
  };
  const original = structuredClone(event);

  assert.equal((await sendAlerts(config, event)).status, "queued");
  const firstOutbox = JSON.parse(await fs.readFile(path.join(dataDir, "alert-outbox.json"), "utf8"));
  const entry = firstOutbox.events[Object.keys(firstOutbox.events)[0]];
  assert.equal(entry.renderBundle.version, 23);
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
  assert.equal(finalEntry.destinations.telegram.receipt.renderVersion, 23);
  assert.equal(finalEntry.destinations.telegram.receipt.translation.zh.status, finalEntry.renderBundle.zh.status);
  assert.equal(finalEntry.destinations.telegram.receipt.translation.en.status, finalEntry.renderBundle.en.status);
});

test("a pending v14 card is rebuilt once as v23 while terminal v14 is not migrated", async (t) => {
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
    type: "binance_official_update",
    kind: "announcement",
    strong: true,
    project: { id: "binance-wallet", name: "Binance Wallet" },
    signal: { scope: "wallet", category: "产品功能上线", labels: ["新功能/产品更新"], strong: true },
    productFeature: true,
    binanceChange: { classification: "product_feature", productFeature: true, substantive: true },
    title: "Binance Wallet adds a verified wallet execution feature",
    url: "https://www.binance.com/en/support/announcement/wallet-execution-feature",
    source: { id: "binance_wallet_cms", trust: "official_verified", url: "https://www.binance.com/en/support/announcement/wallet-execution-feature" },
    sourceTrust: "official_verified",
    publishedAt: new Date(Date.now() - 30_000).toISOString(),
    observedAt: new Date().toISOString(),
  };

  assert.equal((await sendAlerts(config, event)).status, "queued");
  const file = path.join(dataDir, "alert-outbox.json");
  const outbox = JSON.parse(await fs.readFile(file, "utf8"));
  const entry = outbox.events[Object.keys(outbox.events)[0]];
  entry.renderBundle.version = 14;
  entry.renderBundle.format = "telegram_zh_en_compact_v11";
  entry.renderBundle.sourceHash = "V14_SENTINEL_HASH";
  entry.renderBundle.zh.text = "V14_LONG_CARD_SENTINEL\n旧长卡\n旧长卡\n旧长卡\n旧长卡";
  entry.renderBundle.en.text = "V14_LONG_CARD_SENTINEL\nold long card\nold long card\nold long card\nold long card";
  entry.destinations.telegram.nextAttemptAt = null;
  await fs.writeFile(file, `${JSON.stringify(outbox)}\n`);
  const callsBeforeMigration = translationCalls;

  assert.equal((await sendAlerts(config, event)).status, "delivered");
  const callsAfterMigration = translationCalls;
  assert.equal(telegramCalls, 2);
  assert.doesNotMatch(deliveredPayload.text, /V14_LONG_CARD_SENTINEL/);
  assert.ok(deliveredPayload.text.split("\n").length <= 18);

  const migrated = JSON.parse(await fs.readFile(file, "utf8"));
  const migratedEntry = migrated.events[Object.keys(migrated.events)[0]];
  assert.equal(migratedEntry.renderBundle.version, 23);
  assert.equal(migratedEntry.renderBundle.format, "telegram_zh_en_compact_v13");
  assert.notEqual(migratedEntry.renderBundle.sourceHash, "V14_SENTINEL_HASH");
  assert.equal(migratedEntry.renderBundle.zh.text.split("\n").length, 2);
  assert.equal(migratedEntry.renderBundle.en.text.split("\n").length, 2);
  assert.equal((await sendAlerts(config, event)).status, "delivered");
  assert.equal(translationCalls, callsAfterMigration, "the persisted v20 bundle must not be translated again");
  assert.equal(telegramCalls, 2, "a terminal delivered event must not be sent again");

  migratedEntry.renderBundle.version = 14;
  migratedEntry.renderBundle.zh.text = "TERMINAL_V14_SENTINEL";
  migratedEntry.renderBundle.en.text = "TERMINAL_V14_SENTINEL";
  await fs.writeFile(file, `${JSON.stringify(migrated)}\n`);
  assert.equal((await sendAlerts(config, event)).status, "delivered");
  const terminal = JSON.parse(await fs.readFile(file, "utf8"));
  const terminalEntry = terminal.events[Object.keys(terminal.events)[0]];
  assert.equal(terminalEntry.renderBundle.version, 14);
  assert.equal(terminalEntry.renderBundle.zh.text, "TERMINAL_V14_SENTINEL");
  assert.equal(translationCalls, callsAfterMigration);
  assert.equal(telegramCalls, 2);
});

test("an unknown Binance official kind is suppressed before rendering", async (t) => {
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
  assert.equal(result.status, "suppressed");
  assert.equal(result.reason, "not_relevant");
  assert.equal(payload, undefined);
});

test("pon.fun official API plus Factory lifecycle card keeps the stock boundary and no-trading warning atomic", async () => {
  const nowMs = Date.parse("2026-09-02T04:00:30.000Z");
  const factory = "0xF698d13348686C1529c2DC54847C123424d9DAE0";
  const stockToken = "0x3333333333333333333333333333333333333333";
  const event = withTradingPriority({
    type: "pon_fun_update",
    kind: "market_lifecycle",
    platform: { id: "ponfun", name: "pon.fun", chainId: 4663 },
    source: {
      id: "pon_fun_official_api_onchain",
      trust: "official_site_bound_onchain_fingerprinted",
      official: true,
      url: "https://www.pon.fun/api/markets",
    },
    sourceTrust: "official_site_bound_onchain_fingerprinted",
    factory,
    token: stockToken,
    market: { symbol: "RWA", ticker: "RWA", stockToken, graduated: true, lpDeployed: true },
    currentSnapshot: { symbol: "RWA", ticker: "RWA", stockToken, graduated: true, lpDeployed: true },
    changes: {
      graduated: { before: false, after: true },
      lpDeployed: { before: false, after: true },
    },
    evidence: { apiVerified: true, factoryFingerprintVerified: true },
    blockTimestamp: "2026-09-02T04:00:00.000Z",
    observedAt: "2026-09-02T04:00:01.000Z",
  }, { nowMs });
  const bundle = await buildBilingualAlertBundle({}, event, "pon.fun official API and Factory lifecycle update");
  const rendered = renderBilingualTelegramText(bundle, false);
  const blocks = renderedLanguageBlocks(rendered);

  assert.match(blocks.zh.join("\n"), /验证：官方 API 与 Factory 指纹绑定/u);
  assert.match(blocks.zh.join("\n"), /风险：coin 不是股票；非自动交易/u);
  assert.match(blocks.en.join("\n"), /Verification: Official API bound to Factory fingerprint/u);
  assert.match(blocks.en.join("\n"), /Risk: coin is not the stock; no automatic trading/u);
  assert.doesNotMatch(blocks.en.join("\n"), /[\u3400-\u9fff]/u);
  assertShortFieldLayout(rendered);
});

test("pon.fun structural and official-X cards keep a clear bounded bilingual fact layout", async () => {
  const nowMs = Date.parse("2026-09-02T04:00:30.000Z");
  const factory = "0xF698d13348686C1529c2DC54847C123424d9DAE0";
  const tx = `0x${"a".repeat(64)}`;
  const before = "0x1111111111111111111111111111111111111111";
  const after = "0x2222222222222222222222222222222222222222";
  const structural = withTradingPriority({
    type: "pon_fun_update",
    kind: "factory_config",
    platform: { id: "ponfun", name: "pon.fun", chainId: 4663 },
    source: {
      id: "pon_fun_official_api_onchain",
      trust: "official_site_bound_onchain_fingerprinted",
      official: true,
      url: `https://robinhoodchain.blockscout.com/tx/${tx}`,
    },
    sourceTrust: "official_site_bound_onchain_fingerprinted",
    factory,
    transactionHash: tx,
    blockNumber: 52_000_001,
    blockTimestamp: "2026-09-02T04:00:00.000Z",
    observedAt: "2026-09-02T04:00:01.000Z",
    evidence: {
      factoryCodeHash: "0x4cb9795396b800a4b1e46f2e91a690ecf004ac0d52b059a7ef0e6b190af17384",
    },
    previousSnapshot: { oracle: before },
    currentSnapshot: { oracle: after },
    changes: { oracle: { before, after } },
  }, { nowMs });
  const token = "0x3333333333333333333333333333333333333333";
  const officialX = withTradingPriority({
    type: "twitter_update",
    project: {
      id: "ponfun",
      name: "pon.fun",
      handle: "pondotfun",
      xUserId: "2094048312772993024",
      match: "official_x",
      signalProfile: "pon_fun",
      website: "https://www.pon.fun",
      twitter: "https://x.com/pondotfun",
    },
    tweet: {
      id: "2095100000000000000",
      handle: "pondotfun",
      authorId: "2094048312772993024",
      xUserId: "2094048312772993024",
      sourceVerifiedBy: "official_x_oembed",
      identityVerifiedBy: "fxtwitter_exact_numeric_id",
      url: "https://x.com/pondotfun/status/2095100000000000000",
      createdAt: "2026-09-02T04:00:00.000Z",
      text: "$PONFUN is live",
    },
    signal: {
      relevant: true,
      strong: true,
      ponFunOfficial: true,
      ponKind: "platform_token_update",
      ponStage: "platform_token_live",
      ponAsset: "PONFUN",
      tokenAddress: token,
      ponPriority: "T1",
      majorProductUpdate: true,
      platformStructural: true,
    },
  }, { nowMs });

  for (const [event, identifiers] of [
    [structural, [factory, `${tx}#52000001`]],
    [officialX, [token, "@pondotfun", "2095100000000000000"]],
  ]) {
    const bundle = await buildBilingualAlertBundle({}, event, "pon.fun official update");
    const rendered = renderBilingualTelegramText(bundle, true);
    assert.equal(bundle.zh.text.split("\n").length, 2);
    assert.equal(bundle.en.text.split("\n").length, 2);
    assert.match(bundle.zh.text, /^平台：pon\.fun/m);
    assert.match(bundle.zh.text, /^更新了什么：/m);
    assert.match(bundle.en.text, /^Platform: pon\.fun/m);
    assert.match(bundle.en.text, /^What changed: /m);
    assert.doesNotMatch(bundle.en.text, /[\u3400-\u9fff]/u);
    assertShortFieldLayout(rendered);
    assert.ok(rendered.length < 3_800, `pon.fun card is ${rendered.length} characters`);
    for (const identifier of identifiers) {
      assert.ok(bundle.zh.text.includes(identifier), `Chinese card lost ${identifier}`);
      assert.ok(bundle.en.text.includes(identifier), `English card lost ${identifier}`);
    }
  }
  assert.deepEqual(structural.tradingPriority.tier, "T1");
  assert.deepEqual(structural.tradingPriority.plan.automaticExecution, false);
  const { tradingPriority: _originalPriority, ...officialXWithoutPriority } = officialX;
  const delayedX = withTradingPriority({
    ...officialXWithoutPriority,
    observedAt: "2026-09-02T04:00:30.000Z",
    tweet: { ...officialX.tweet, createdAt: "2026-09-02T03:40:00.000Z" },
    delayedRecovery: {
      version: 1,
      reason: "monitoring_gap_recovery",
      gapSince: "2026-09-02T03:45:00.000Z",
      sourceOccurredAt: "2026-09-02T03:40:00.000Z",
      recoveredAt: "2026-09-02T04:00:30.000Z",
      lagMs: 20 * 60_000 + 30_000,
      cursor: { latestIdAtRecovery: "2095099999999999999", tweetId: officialX.tweet.id },
    },
  }, { nowMs });
  const delayedBundle = await buildBilingualAlertBundle({}, delayedX, "pon.fun delayed recovery");
  const delayedRendered = renderBilingualTelegramText(delayedBundle, true);
  assert.equal(delayedX.tradingPriority.tier, "T2");
  assert.match(delayedBundle.zh.text, /监控恢复补报/);
  assert.match(delayedBundle.zh.text, /勿追价/);
  assert.match(delayedBundle.en.text, /Delayed recovery/);
  assert.match(delayedBundle.en.text, /do not chase/);
  assert.doesNotMatch(delayedBundle.en.text, /[\u3400-\u9fff]/u);
  assertShortFieldLayout(delayedRendered);
  assert.ok(delayedRendered.length < 3_800, `delayed pon.fun card is ${delayedRendered.length} characters`);
});

test("Flap Portal delayed recovery is a bilingual T2 outage card with original time and no-chase boundary", async () => {
  const occurredAt = "2026-09-03T06:40:00.000Z";
  const recoveredAt = "2026-09-03T07:00:00.000Z";
  const quoteAddress = "0xe28c09e21db5bb63c4821c3f44c26ee5aee8280f";
  const transactionHash = `0x${"ab".repeat(32)}`;
  const event = withTradingPriority({
    type: "platform_capability_update",
    kind: "flap_quote_asset_enabled",
    platform: { id: "flap", name: "Flap", website: "https://flap.sh", board: "https://flap.sh/board" },
    transactionHash,
    blockNumber: 119_700_000,
    blockTimestamp: occurredAt,
    occurredAt,
    observedAt: recoveredAt,
    changes: {
      newFlapPools: [{
        kind: "quote_asset",
        quoteAddress,
        quoteSymbol: "Brk.B",
        quoteName: "Berkshire Class B stock",
        sourceUrl: "https://flap.sh/board",
        chainId: 56,
      }],
    },
    signal: {
      quotePairChange: {
        stage: "live",
        assetClass: "quote_asset",
        assets: [{ symbol: "Brk.B", name: "Berkshire Class B stock", address: quoteAddress, decimals: 18 }],
      },
    },
    delayedRecovery: {
      version: 1,
      reason: "monitoring_gap_recovery",
      sourceOccurredAt: occurredAt,
      recoveredAt,
      lagMs: 20 * 60_000,
    },
    freshness: {
      version: 1,
      scope: "flap_delayed_recovery",
      basis: "delayedRecovery.recoveredAt_continuous_recovery",
      sourceOccurredAt: recoveredAt,
      discoveredAt: recoveredAt,
      lagMs: 0,
      sourceTimeReliable: true,
      realtimeMaxAgeMs: 600_000,
      telegramMaxAgeMs: 7_200_000,
      decision: "realtime",
      reason: "within_realtime_window",
    },
  }, { nowMs: Date.parse(recoveredAt) });

  const bundle = await buildBilingualAlertBundle({ alertForceLocalStructured: true }, event, "Flap delayed recovery");
  const rendered = renderBilingualTelegramText(bundle, false);
  const blocks = renderedLanguageBlocks(rendered);
  assert.equal(event.tradingPriority.tier, "T2");
  assert.match(rendered, /^🔔 监控提醒 \| MONITOR ALERT/u);
  assert.match(blocks.zh.join("\n"), /断线恢复补报/u);
  assert.match(blocks.zh.join("\n"), /勿追价/u);
  assert.match(blocks.zh.join("\n"), /非自动交易/u);
  assert.match(blocks.zh.join("\n"), /原始发生=.*恢复=/u);
  assert.match(blocks.en.join("\n"), /Delayed recovery/i);
  assert.match(blocks.en.join("\n"), /do not chase/i);
  assert.match(blocks.en.join("\n"), /no automatic trading/i);
  assert.match(blocks.en.join("\n"), /bStock quote token is not ETF\/share ownership/i);
  for (const literal of ["Brk.B", quoteAddress]) {
    assert.match(blocks.zh.join("\n"), new RegExp(literal.replaceAll(".", "\\.")));
    assert.match(blocks.en.join("\n"), new RegExp(literal.replaceAll(".", "\\.")));
  }
  assertShortFieldLayout(rendered);
  assert.ok(rendered.length < 3_800);

  const genericEvent = withTradingPriority({
    ...structuredClone(event),
    tradingPriority: undefined,
    changes: {
      newFlapPools: [{
        ...event.changes.newFlapPools[0],
        quoteSymbol: "USDT",
        quoteName: "Tether USD",
      }],
    },
    signal: {
      quotePairChange: {
        ...event.signal.quotePairChange,
        assets: [{ symbol: "USDT", name: "Tether USD", address: quoteAddress, decimals: 18 }],
      },
    },
  }, { nowMs: Date.parse(recoveredAt) });
  const genericBundle = await buildBilingualAlertBundle(
    { alertForceLocalStructured: true },
    genericEvent,
    "Flap generic quote delayed recovery",
  );
  const genericRendered = renderBilingualTelegramText(genericBundle, false);
  assert.match(genericRendered, /报价代币仍有合约、流动性与可卖性风险/u);
  assert.match(genericRendered, /quote-token contract, liquidity, and sellability risks remain/i);
  assert.doesNotMatch(genericRendered, /bStock|ETF|share ownership/iu);
  assert.match(genericRendered, /勿追价/u);
  assert.match(genericRendered, /do not chase/i);
  assert.match(genericRendered, /非自动交易/u);
  assert.match(genericRendered, /no automatic trading/i);
  assertShortFieldLayout(genericRendered);

  const firstObserved = structuredClone(genericEvent);
  const observedAsset = firstObserved.changes.newFlapPools[0];
  firstObserved.kind = "flap_quote_asset_first_observed_after_gap";
  firstObserved.changeType = "observed";
  firstObserved.strong = false;
  firstObserved.changes = {
    newFlapPools: [],
    updatedFlapPools: [observedAsset],
    removedFlapPools: [],
    flapPoolChanges: [],
    newQuoteTokens: [],
    newQuoteConfigs: [],
    newContracts: [],
  };
  firstObserved.signal = {
    strong: false,
    platformStructural: true,
    category: "Flap quote asset first observed after gap",
    headline: "Flap first observed USDT currently enabled after a monitoring gap",
    quotePairChange: {
      stage: "observed",
      assetClass: "quote_asset",
      assets: [{ symbol: "USDT", name: "Tether USD", address: quoteAddress, decimals: 18 }],
    },
  };
  firstObserved.delayedRecovery.reason = "first_observed_after_gap";
  firstObserved.freshness.scope = "flap_first_observed_after_gap";
  delete firstObserved.tradingPriority;
  const rankedFirstObserved = withTradingPriority(firstObserved, { nowMs: Date.parse(recoveredAt) });
  const observedBundle = await buildBilingualAlertBundle(
    { alertForceLocalStructured: true },
    rankedFirstObserved,
    "Flap first observed after gap",
  );
  const observedRendered = renderBilingualTelegramText(observedBundle, false);
  const observedBlocks = renderedLanguageBlocks(observedRendered);
  assert.equal(rankedFirstObserved.tradingPriority.tier, "T2");
  assert.match(observedBlocks.zh.join("\n"), /补扫首次观察/u);
  assert.match(observedBlocks.zh.join("\n"), /当前确认启用/u);
  assert.match(observedBlocks.zh.join("\n"), /此前是否新增\/0→1 未证/u);
  assert.match(observedBlocks.zh.join("\n"), /勿追价/u);
  assert.match(observedBlocks.zh.join("\n"), /非自动交易/u);
  assert.doesNotMatch(observedBlocks.zh.join("\n"), /新增底池|报价底池已启用/u);
  assert.match(observedBlocks.en.join("\n"), /First observed after (?:a )?gap/i);
  assert.match(observedBlocks.en.join("\n"), /currently confirmed enabled/i);
  assert.match(observedBlocks.en.join("\n"), /prior listing\/0→1 unproven/i);
  assert.match(observedBlocks.en.join("\n"), /do not chase/i);
  assert.match(observedBlocks.en.join("\n"), /no automatic trading/i);
  assert.doesNotMatch(observedBlocks.en.join("\n"), /new quote pools?|quote pools enabled/i);
  assert.doesNotMatch(observedRendered, /bStock|ETF|share ownership/iu);
  assertShortFieldLayout(observedRendered);
});
