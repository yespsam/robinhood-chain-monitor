import test from "node:test";
import assert from "node:assert/strict";
import { changeModelSummary, deriveAlertChangeModel, renderAlertChangeLines } from "../src/alert-change-model.js";

test("platform capability uses exact snapshots and deterministic deduped values", () => {
  const event = {
    type: "platform_capability_update",
    platform: { name: "Flap" },
    source: "https://flap.sh/api",
    changes: {
      quoteConfigChanges: [{ symbol: "USDT", before: { symbol: "USDT", version: "v1" }, after: { symbol: "USDT", version: "v2" } }],
      newModules: ["Tax Mode", "Tax Mode"],
    },
  };
  const snapshot = structuredClone(event);
  const result = deriveAlertChangeModel(event);
  assert.equal(result.basis, "exact_snapshot");
  assert.equal(result.kind, "modification");
  assert.equal(result.before.state, "known");
  assert.match(result.before.text, /USDT/);
  assert.match(result.after.text, /Tax Mode/);
  assert.deepEqual(event, snapshot, "derivation must not mutate the source event");
  assert.deepEqual(deriveAlertChangeModel(event), result, "derivation must be deterministic");
});

test("Morph upgrade exposes exact old and new implementation", () => {
  const result = deriveAlertChangeModel({
    kind: "portal_upgrade",
    chain: { slug: "morph" },
    platform: { id: "flap" },
    mode: { previousImplementation: "0xold", implementation: "0xnew", previousVersion: "1", version: "2" },
  });
  assert.equal(result.basis, "exact_snapshot");
  assert.match(result.before.text, /0xold/);
  assert.match(result.after.text, /0xnew/);
});

test("GitHub evidence and file states distinguish additions modifications and removals", () => {
  const result = deriveAlertChangeModel({
    type: "github_module_update",
    repository: "flap/contracts",
    commit: "abcdef",
    changeEvidence: [{ file: "config.ts", subject: "fee", before: "1", after: "2" }],
    files: [
      { filename: "new.sol", status: "added", additions: 5, deletions: 0 },
      { filename: "old.sol", status: "removed", additions: 0, deletions: 3 },
    ],
  });
  assert.equal(result.kind, "modification");
  assert.match(result.before.text, /fee: 1/);
  assert.match(result.after.text, /fee: 2/);
  assert.match(result.after.text, /已移除/);
});

test("public GitHub patch metadata keeps the concrete file without inventing +0/-0 diff stats", () => {
  const result = deriveAlertChangeModel({
    type: "github_module_update",
    repository: "binance/binance-connector-go",
    commit: "665ca7fdf188983d67c855cb9b03dbc40b92f432",
    diffStatsAvailable: false,
    files: [{ filename: "clients/wallet/src/restapi/rest_api.go", status: "modified", additions: 0, deletions: 0 }],
  });
  assert.match(result.after.text, /clients\/wallet\/src\/restapi\/rest_api\.go/);
  assert.doesNotMatch(result.after.text, /\+0|-0/);
});

test("GitHub producer primary facts stay paired and metadata-only updates never masquerade as commit titles", () => {
  const structured = deriveAlertChangeModel({
    type: "github_module_update",
    repository: "four-meme/contracts",
    commit: "abc1234",
    message: "feat: misleading broad launch claim",
    githubChange: {
      completeness: "structured",
      primaryFact: { file: "config/modes.ts", kind: "config_value", subject: "launchMode", before: "classic", after: "fast" },
      facts: [{ file: "README.md", kind: "documentation_item", subject: "Launch guide", action: "added", after: "Fast mode" }],
    },
  });
  assert.equal(structured.basis, "exact_snapshot");
  assert.deepEqual(structured.deltas[0], {
    category: "config",
    action: "modified",
    kind: "config_value",
    file: "config/modes.ts",
    subject: "launchMode",
    before: "classic",
    after: "fast",
    basis: "exact_patch",
  });
  assert.equal(structured.deltas[1].category, "docs");
  assert.doesNotMatch(structured.after.text, /misleading broad launch claim/);

  const metadataOnly = deriveAlertChangeModel({
    type: "github_module_update",
    repository: "flap/docs",
    commit: "def5678",
    message: "feat: claims an unverified product launch",
    diffStatsAvailable: false,
    files: [{ filename: "README.md", status: "modified", additions: 0, deletions: 0 }],
  });
  assert.equal(metadataOnly.basis, "monitoring_baseline");
  assert.match(metadataOnly.after.text, /README\.md.*精确差异未解析/);
  assert.doesNotMatch(metadataOnly.after.text, /unverified product launch/);
});

test("GitHub metadata-only primary facts remain monitoring evidence rather than exact patches", () => {
  const producerMetadataOnly = deriveAlertChangeModel({
    type: "github_module_update",
    repository: "example/platform",
    commit: "metadata123",
    githubChange: {
      scheme: "github_change_v1",
      basis: "api_patch",
      completeness: "metadata_only",
      primaryFact: {
        file: "src/binary.wasm",
        kind: "file_change",
        subject: "src/binary.wasm",
        action: "modified",
        confidence: "metadata_only",
      },
      facts: [],
    },
    files: [{ filename: "src/binary.wasm", status: "modified" }],
  });
  assert.equal(producerMetadataOnly.deltas[0].basis, "metadata_only");
  assert.equal(producerMetadataOnly.basis, "monitoring_baseline");
  assert.equal(producerMetadataOnly.confidence, "observed");
  assert.match(producerMetadataOnly.after.text, /src\/binary\.wasm.*精确差异未解析/);

  const confidenceOnly = deriveAlertChangeModel({
    type: "github_module_update",
    repository: "example/platform",
    commit: "metadata456",
    githubChange: {
      primaryFact: {
        file: "src/opaque.bin",
        kind: "file_change",
        action: "modified",
        confidence: "metadata_only",
      },
    },
  });
  assert.equal(confidenceOnly.deltas[0].basis, "metadata_only");
  assert.equal(confidenceOnly.basis, "monitoring_baseline");
});

test("repository discovery and verification have distinct baseline semantics", () => {
  const discovered = deriveAlertChangeModel({ type: "github_repository_discovered", repository: "four/meme", sourceTrust: "official_verified" });
  assert.equal(discovered.before.state, "not_observed");
  assert.equal(discovered.basis, "official_claim");
  const verified = deriveAlertChangeModel({ type: "github_repository_verified", repository: "four/meme", evidence: { source: "official_x" } });
  assert.equal(verified.kind, "verification");
  assert.match(verified.before.text, /未确认/);
  assert.match(verified.after.text, /已确认/);
});

test("Binance developer updates prioritize concrete deltas and never expose signalDigest", () => {
  const change = deriveAlertChangeModel({
    type: "binance_official_update",
    kind: "developer_update",
    comparisonBasis: "exact_snapshot",
    addedSignals: [
      "[/agent-native/mcp-server](/en/docs/agent-native/mcp-server.md)",
      "[Binance MCP Server](/en/docs/agent-native/mcp-server/agentic.md)",
    ],
    removedSignals: ["`GET /fapi/v1/income` — Get Income History (USER_DATA)"],
    keyChanges: ["signalDigest: old → new"],
    previousSnapshot: { signalDigest: "old", signals: ["Agent Native"] },
    currentSnapshot: { signalDigest: "new", signals: ["Agent Native", "Binance MCP Server"] },
    changedFields: ["signalDigest", "signals"],
    source: { url: "https://developers.binance.com/en/docs/llms.txt" },
  });
  assert.equal(change.basis, "exact_snapshot");
  assert.match(change.after.items.join(" "), /Binance MCP Server/);
  assert.match(change.after.items.join(" "), /已移除/);
  assert.doesNotMatch(JSON.stringify(change), /signalDigest/);
});

test("GitHub gap compares the durable cursor to newest observed commit", () => {
  const result = deriveAlertChangeModel({ type: "github_monitor_gap", repository: "x/y", gap: { previousSha: "old", newestSha: "new", status: "gap_unresolved", fetchedCommits: 100 } });
  assert.match(result.before.text, /old/);
  assert.match(result.after.text, /new/);
  assert.equal(result.basis, "exact_snapshot");
});

test("ordinary X post uses official claim while explicit before-after stays explicit", () => {
  const ordinary = deriveAlertChangeModel({ type: "twitter_update", tweet: { id: "1", text: "New chain support is live" } });
  assert.equal(ordinary.before.state, "not_observed");
  assert.equal(ordinary.basis, "official_claim");
  const changed = deriveAlertChangeModel({ type: "twitter_update", before: "fee 1%", after: "fee 0.5%", tweet: { id: "2" } });
  assert.equal(changed.before.text, "fee 1%");
  assert.equal(changed.after.text, "fee 0.5%");
});

test("Telegram news stays an observed channel lead and never authenticates raw channel text", () => {
  const event = {
    type: "telegram_news_update",
    eventKey: "telegram-news:-1002540748528:4821:0123456789abcdef",
    messageId: 4821,
    messageUrl: "https://t.me/maxguruai/4821",
    sourceTrust: "official_verified",
    channel: {
      chatId: "-1002540748528",
      username: "maxguruai",
      title: "UNTRUSTED CHANNEL TITLE",
      visibility: "public",
    },
    news: {
      category: "AI Agent",
      headline: "A broader headline that is not the selected summary",
      summary: "MCP v2.1 adds guarded routing through triggerFeeUpdate()",
      externalUrls: ["https://example.invalid/story"],
      storyKey: "ai-agent-routing",
      confidence: "observed",
    },
    message: "RAW TELEGRAM FULL TEXT MUST NOT BECOME A FACT",
    author: { username: "unverified_author" },
    contentDigest: "1".repeat(64),
  };
  const snapshot = structuredClone(event);
  const result = deriveAlertChangeModel(event);

  assert.equal(result.kind, "publication");
  assert.equal(result.basis, "monitoring_baseline");
  assert.equal(result.confidence, "observed");
  assert.equal(result.before.state, "not_observed");
  assert.equal(result.after.text, "分类 AI Agent: MCP v2.1 adds guarded routing through triggerFeeUpdate()");
  assert.deepEqual(result.evidence, ["@maxguruai#4821"]);
  assert.doesNotMatch(JSON.stringify(result), /RAW TELEGRAM|UNTRUSTED CHANNEL|unverified_author|official_verified/);
  assert.deepEqual(event, snapshot, "derivation must not mutate the Telegram event");
  assert.deepEqual(deriveAlertChangeModel(event), result, "Telegram derivation must be deterministic");
});

test("token mode, volume anomaly and Fomo first position use exact comparisons", () => {
  const mode = deriveAlertChangeModel({ type: "token_launch", modeDifference: { previous: [{ selector: "0x1", poolKinds: ["V3"] }], current: { selector: "0x2", poolKinds: ["V4"] } } });
  assert.match(mode.before.text, /0x1/);
  assert.match(mode.after.text, /0x2/);
  const volume = deriveAlertChangeModel({ type: "early_activity_alert", activity: "volume_anomaly", previousVolumeInMinute: 1, volumeInMinute: 4, stage: 2, entry: { quoteSymbol: "WETH" } });
  assert.equal(volume.kind, "escalation");
  assert.match(volume.before.text, /1 WETH/);
  assert.match(volume.after.text, /4 WETH/);
  const fomo = deriveAlertChangeModel({ type: "fomo_family_top_call", signalKind: "top_blogger_first_buy", caller: { handle: "kol" }, token: "0xabc", positionProof: { status: "verified", phase: "immediately_before_transaction", totalWalletPreRaw: "0" } });
  assert.equal(fomo.basis, "exact_snapshot");
  assert.match(fomo.before.text, /仓位: 0/);
});

test("a linked Fomo X call remains a public KOL post and never becomes a first-position buy", () => {
  const result = deriveAlertChangeModel({
    type: "fomo_family_top_call",
    signalKind: "fomo_x_call",
    caller: { handle: "alpha" },
    tweet: { id: "2089553165817667830", url: "https://x.com/alpha/status/2089553165817667830" },
    thesis: { text: "Buying TOKEN after liquidity expansion" },
    token: "0x1111111111111111111111111111111111111111",
    source: { id: "fomo_linked_x_post" },
  });
  assert.equal(result.kind, "publication");
  assert.equal(result.basis, "monitoring_baseline");
  assert.match(result.after.text, /@alpha X 喊单/);
  assert.match(result.evidence.join(" "), /X post 2089553165817667830/);
  assert.doesNotMatch(`${result.before.text} ${result.after.text}`, /首仓|首买|零仓位/);
});

test("site additions and generic publications name their evidence limits honestly", () => {
  const site = deriveAlertChangeModel({ type: "launchpad_site_update", url: "https://new.example", newFeatures: ["V2"], newChains: [{ name: "Morph", stage: "supported" }] });
  assert.equal(site.before.state, "not_observed");
  assert.equal(site.basis, "monitoring_baseline");
  const publication = deriveAlertChangeModel({ type: "ai_official_update", title: "Grok API v2", source: { name: "xAI News" } });
  assert.equal(publication.kind, "publication");
  assert.equal(publication.basis, "official_claim");
});

test("bilingual renderer always emits four bounded lines with distinct unknown wording", () => {
  const unknown = deriveAlertChangeModel({ type: "binance_official_update", changeType: "revised", title: "Updated terms" });
  const zh = renderAlertChangeLines(unknown, { locale: "zh", maxItems: 1 });
  const en = renderAlertChangeLines(unknown, { locale: "en", maxItems: 1 });
  assert.equal(zh.length, 4);
  assert.equal(en.length, 4);
  assert.match(zh[1], /旧值暂不可得/);
  assert.match(en[1], /Previous value unavailable/);
  assert.ok([...zh, ...en].every((line) => [...line].length <= 220));
  assert.match(changeModelSummary({ type: "twitter_update", tweet: { text: "hello" } }), /此前监控基线未记录/);
});

test("producer snapshots drive exact Four.Meme, Binance, xAI, and site comparisons", () => {
  const template = deriveAlertChangeModel({
    type: "bsc_launchpad_update",
    kind: "new_mode",
    mode: { selector: "official-template", sourceUrl: "https://four.meme/templates" },
    previousTemplate: { name: "Curve", amount: "0.1" },
    currentTemplate: { name: "Curve", amount: "0.2" },
    changedFields: ["amount"],
  });
  assert.equal(template.basis, "exact_snapshot");
  assert.match(template.before.text, /0\.1/);
  assert.match(template.after.text, /0\.2/);

  for (const type of ["binance_official_update", "ai_official_update"]) {
    const result = deriveAlertChangeModel({
      type,
      previousSnapshot: { title: "V1", stage: "preview" },
      currentSnapshot: { title: "V2", stage: "available" },
      changedFields: ["title", "stage"],
      comparisonBasis: "exact_snapshot",
    });
    assert.equal(result.basis, "exact_snapshot");
    assert.match(result.before.text, /V1/);
    assert.match(result.after.text, /V2/);
  }

  const site = deriveAlertChangeModel({
    type: "launchpad_site_update",
    signalDelta: { added: { features: ["Vault V3"] } },
  });
  assert.match(site.after.text, /Vault V3/);
});

test("metadata enrichment and collection deltas show the exact newly added values", () => {
  const metadata = deriveAlertChangeModel({
    type: "early_activity_alert",
    activity: "metadata_enriched",
    additions: { twitter: "https://x.com/example", website: "https://example.com" },
    entry: { token: "0xabc" },
  });
  assert.equal(metadata.basis, "exact_snapshot");
  assert.match(metadata.before.text, /twitter: 未设置/);
  assert.match(metadata.after.text, /https:\/\/x\.com\/example/);
  assert.doesNotMatch(renderAlertChangeLines(metadata, { locale: "en" }).join("\n"), /[\u3400-\u9fff]/);

  const capability = deriveAlertChangeModel({
    type: "binance_official_update",
    kind: "meme_rush_capability",
    changes: { newSchemaKeys: ["taxFeeDistribution"] },
    source: { name: "Meme Rush API" },
  });
  assert.equal(capability.kind, "addition");
  assert.equal(capability.basis, "exact_snapshot");
  assert.equal(capability.before.state, "not_observed");
  assert.match(capability.after.text, /taxFeeDistribution/);
});

test("official address activity names the transaction delta without inventing a prior balance", () => {
  const activity = deriveAlertChangeModel({
    type: "official_activity",
    activity: "buy",
    actor: "0xactor",
    token: "0xtoken",
    tokenMetadata: { symbol: "ABC" },
    amount: "1250000",
    transactionHash: "0xtx",
    tradeVerified: true,
  });
  assert.equal(activity.before.state, "unknown");
  assert.match(activity.after.text, /本次买入: 1250000 ABC/);
  assert.match(activity.evidence.join(" "), /0xtx/);
  assert.doesNotMatch(renderAlertChangeLines(activity, { locale: "en" }).join("\n"), /[\u3400-\u9fff]/);
});
