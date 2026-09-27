import test from "node:test";
import assert from "node:assert/strict";

import {
  NARRATIVE_SOURCE_ADAPTER_SCHEMA,
  NORMALIZED_NARRATIVE_NEWS_SCHEMA,
  NORMALIZED_NARRATIVE_NEWS_TYPE,
  adaptNarrativeSourceEvent,
  createNarrativeSourceAdapter,
  readAuthenticatedNarrativeDocument,
} from "../src/narrative-source-adapter.js";

const PUBLISHED_AT = "2026-09-06T08:00:00.000Z";
const NVDA_KEY = "eip155:56/erc20:0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const AAPL_KEY = "eip155:56/erc20:0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a";

test('authenticated website prose does not require a CA or a pre-reviewed subject; fake hosts stay rejected',()=>{
  const event={type:'ai_official_update',kind:'xai_news',project:{id:'xai',website:'https://x.ai',twitter:'https://x.com/SpaceXAI'},
    source:{id:'xai_news',url:'https://r.jina.ai/https://x.ai/news',official:true,trust:'official_verified'},
    title:'Orbital starlight autonomous robotaxi fleet',url:'https://x.ai/news/orbital-starlight',publishedAt:PUBLISHED_AT};
  assert.equal(adaptNarrativeSourceEvent(event),null);
  assert.equal(readAuthenticatedNarrativeDocument(event).authenticated,true);
  assert.equal(readAuthenticatedNarrativeDocument({...event,url:'https://x.ai.attacker.test/news/orbital-starlight'}),null);
  assert.equal(readAuthenticatedNarrativeDocument({...event,publishedAt:null}),null);
});

function normalizedVerifiedNews() {
  const url = "https://news.example.test/releases/nvidia-apple";
  return {
    schema: NORMALIZED_NARRATIVE_NEWS_SCHEMA,
    type: NORMALIZED_NARRATIVE_NEWS_TYPE,
    eventKey: "wire:2026-09-06:nvidia-apple",
    source: {
      kind: "official_release",
      url,
      official: true,
      trust: "official_verified",
    },
    verification: { status: "official_verified" },
    publishedAt: PUBLISHED_AT,
    url,
    contextAssetKeys: [AAPL_KEY, NVDA_KEY, AAPL_KEY],
    narrativeEvidence: {
      verified: true,
      sourceKind: "official_release",
      sourceUrl: url,
      publishedAt: PUBLISHED_AT,
      headline: {
        zh: "NVIDIA Corporation 与 Apple Inc. 宣布扩大 AI 合作",
        en: "NVIDIA Corporation and Apple Inc. expand their AI partnership",
      },
      strength: 88,
      novelty: 91,
      mechanismConfidence: 74,
      mechanism: { channel: "product_distribution", direction: "positive" },
    },
  };
}

test("normalized news maps reviewed assets but cannot self-authenticate an absent producer", () => {
  const raw = normalizedVerifiedNews();
  const original = structuredClone(raw);
  const adapted = adaptNarrativeSourceEvent(raw);

  assert.equal(adapted.schema, NARRATIVE_SOURCE_ADAPTER_SCHEMA);
  assert.match(adapted.evidenceKey, /^narrative:[a-f0-9]{64}$/u);
  assert.deepEqual(adapted.contextAssetKeys, [NVDA_KEY, AAPL_KEY]);
  assert.equal(adapted.narrativeEvidence.verified, false);
  assert.equal(adapted.narrativeEvidence.subjectMatch, true);
  assert.equal(adapted.narrativeEvidence.sourceKind, "official_release");
  assert.equal(adapted.narrativeEvidence.sourceUrl, raw.url);
  assert.equal(adapted.narrativeEvidence.publishedAt, PUBLISHED_AT);
  assert.ok(adapted.narrativeEvidence.verificationErrors.includes("source_not_authenticated"));
  assert.deepEqual(raw, original);
  assert.equal(Object.isFrozen(adapted), true);
});

test("the adapter consumes a current real ai_official_update event shape", () => {
  const adapted = adaptNarrativeSourceEvent({
    type: "ai_official_update",
    kind: "xai_news",
    eventKey: "ai-official:xai_news:nvidia-partnership:0123456789abcdef",
    project: {
      id: "xai",
      name: "xAI / Grok",
      website: "https://x.ai",
      twitter: "https://x.com/SpaceXAI",
      socials: ["https://x.com/SpaceXAI", "https://x.com/grok"],
    },
    source: {
      id: "xai_news",
      name: "xAI News",
      url: "https://r.jina.ai/https://x.ai/news",
      official: true,
      trust: "official_verified",
    },
    title: "NVIDIA launches a new xAI infrastructure partnership",
    summary: "NVIDIA Corporation will supply accelerated-computing systems.",
    url: "https://x.ai/news/nvidia-infrastructure-partnership",
    publishedAt: PUBLISHED_AT,
    observedAt: "2026-09-06T08:00:03.000Z",
    changeType: "published",
    strong: true,
    signal: { majorProductUpdate: true },
  });

  assert.deepEqual(adapted.contextAssetKeys, [NVDA_KEY]);
  assert.equal(adapted.narrativeEvidence.verified, true);
  assert.equal(adapted.narrativeEvidence.sourceKind, "official_release");
  assert.equal(adapted.narrativeEvidence.sourceUrl, "https://x.ai/news/nvidia-infrastructure-partnership");
});

test("GitHub provenance requires an exact reviewed repository, not merely an official-looking owner", () => {
  const commit = "a".repeat(40);
  const base = {
    type: "github_module_update",
    repository: "flap-sh/flap-skills",
    sourceTrust: "official_verified",
    verification: { status: "official_verified", evidence: null },
    commit,
    title: "NVIDIA integration for Flap",
    message: "Add NVIDIA Corporation integration",
    committedAt: PUBLISHED_AT,
    url: `https://github.com/flap-sh/flap-skills/commit/${commit}`,
    strong: true,
  };
  const reviewed = adaptNarrativeSourceEvent(base);
  assert.equal(reviewed.narrativeEvidence.verified, true);

  const forged = adaptNarrativeSourceEvent({
    ...base,
    repository: "flap-sh/not-in-the-reviewed-catalog",
    url: `https://github.com/flap-sh/not-in-the-reviewed-catalog/commit/${commit}`,
  });
  assert.equal(forged.narrativeEvidence.verified, false);
  assert.ok(forged.narrativeEvidence.verificationErrors.includes("source_not_authenticated"));
});

test("matching text is not enough to forge a verified source lane", () => {
  const adapted = adaptNarrativeSourceEvent({
    type: "pretend_official_update",
    eventKey: "forged:1",
    verified: true,
    sourceTrust: "official_verified",
    sourceKind: "official_release",
    source: { official: true, trust: "official_verified" },
    title: "NVDA launches a new product",
    url: "https://attacker.example/news/1",
    publishedAt: PUBLISHED_AT,
    strong: true,
  });

  assert.deepEqual(adapted.contextAssetKeys, [NVDA_KEY]);
  assert.equal(adapted.narrativeEvidence.verified, false);
  assert.equal(adapted.narrativeEvidence.sourceKind, "unverified_observation");
  assert.ok(adapted.narrativeEvidence.verificationErrors.includes("source_not_authenticated"));
  assert.ok(adapted.narrativeEvidence.verificationErrors.includes("source_kind_conflict"));

  const selfAssertedNormalized = adaptNarrativeSourceEvent({
    schema: NORMALIZED_NARRATIVE_NEWS_SCHEMA,
    type: NORMALIZED_NARRATIVE_NEWS_TYPE,
    eventKey: "forged:normalized",
    publishedAt: PUBLISHED_AT,
    url: "https://attacker.example/news/2",
    narrativeEvidence: {
      verified: true,
      sourceKind: "official_release",
      sourceUrl: "https://attacker.example/news/2",
      publishedAt: PUBLISHED_AT,
      headline: "NVDA launches a new product",
    },
  });
  assert.equal(selfAssertedNormalized.narrativeEvidence.verified, false);
  assert.ok(selfAssertedNormalized.narrativeEvidence.verificationErrors.includes("source_not_authenticated"));
});

test("Telegram remains a public watch observation even when its payload claims verified", () => {
  const messageUrl = "https://t.me/WhaleInsider/12345";
  const adapted = adaptNarrativeSourceEvent({
    type: "telegram_news_update",
    eventKey: "telegram-news:-100123:12345:0123456789abcdef",
    verified: true,
    sourceTrust: "public_telegram_observed",
    source: {
      id: "telegram_public_channel",
      url: "https://t.me/s/WhaleInsider",
      trust: "public_telegram_observed",
    },
    title: "NVDA signs a large supply agreement",
    messageUrl,
    sourceOccurredAt: PUBLISHED_AT,
    observedAt: "2026-09-06T08:00:02.000Z",
    news: {
      headline: "NVDA signs a large supply agreement",
      summary: "Public-channel report awaiting primary-source confirmation.",
    },
  });

  assert.deepEqual(adapted.contextAssetKeys, [NVDA_KEY]);
  assert.equal(adapted.narrativeEvidence.verified, false);
  assert.equal(adapted.narrativeEvidence.sourceKind, "public_telegram_observed");
  assert.equal(adapted.narrativeEvidence.sourceUrl, messageUrl);
  assert.ok(adapted.narrativeEvidence.verificationErrors.includes("public_observation_never_verifies_underlying_news"));
});

test("source URL, publication time, trust, and declared-asset conflicts all fail closed", async (t) => {
  const cases = [
    ["URL", (event) => { event.sourceUrl = "https://conflict.example.test/news/other"; }, "source_url_conflict"],
    ["time", (event) => { event.sourceOccurredAt = "2026-09-06T08:00:01.000Z"; }, "publication_time_conflict"],
    ["trust", (event) => { event.source.trust = "unverified"; }, "trust_claim_conflict_or_invalid"],
    ["asset", (event) => { event.contextAssetKeys = [NVDA_KEY]; }, "declared_asset_keys_conflict_with_reviewed_text_match"],
  ];

  for (const [name, mutate, expectedError] of cases) {
    await t.test(name, () => {
      const event = normalizedVerifiedNews();
      mutate(event);
      const adapted = adaptNarrativeSourceEvent(event);
      assert.equal(adapted.narrativeEvidence.verified, false);
      assert.ok(adapted.narrativeEvidence.verificationErrors.includes(expectedError));
    });
  }
});

test("same semantic evidence has a stable key and chain filtering is exact", () => {
  const firstRaw = normalizedVerifiedNews();
  const secondRaw = {
    observedAt: "2030-01-01T00:00:00.000Z",
    narrativeEvidence: {
      mechanism: { direction: "positive", channel: "product_distribution" },
      mechanismConfidence: 74,
      novelty: 91,
      strength: 88,
      headline: {
        en: "NVIDIA Corporation and Apple Inc. expand their AI partnership",
        zh: "NVIDIA Corporation 与 Apple Inc. 宣布扩大 AI 合作",
      },
      publishedAt: PUBLISHED_AT,
      sourceUrl: firstRaw.url,
      sourceKind: "official_release",
      verified: true,
    },
    contextAssetKeys: [NVDA_KEY, AAPL_KEY],
    url: firstRaw.url,
    publishedAt: PUBLISHED_AT,
    verification: { status: "official_verified" },
    source: {
      trust: "official_verified",
      official: true,
      url: firstRaw.url,
      kind: "official_release",
    },
    eventKey: firstRaw.eventKey,
    type: NORMALIZED_NARRATIVE_NEWS_TYPE,
    schema: NORMALIZED_NARRATIVE_NEWS_SCHEMA,
  };

  const first = adaptNarrativeSourceEvent(firstRaw);
  const second = adaptNarrativeSourceEvent(secondRaw);
  assert.equal(second.evidenceKey, first.evidenceKey);
  assert.deepEqual(second, first);
  assert.deepEqual(adaptNarrativeSourceEvent(firstRaw, { chainId: 56 }).contextAssetKeys, [NVDA_KEY, AAPL_KEY]);
  assert.equal(adaptNarrativeSourceEvent(firstRaw, { chainId: 4663 }), null);
  assert.deepEqual(createNarrativeSourceAdapter({ chainId: 56 }).adapt(firstRaw), first);
});

test("unmatched subjects do not create narrative evidence", () => {
  const raw = normalizedVerifiedNews();
  raw.contextAssetKeys = [];
  raw.narrativeEvidence.headline = "A private company released an unrelated product";
  assert.equal(adaptNarrativeSourceEvent(raw), null);
  assert.equal(adaptNarrativeSourceEvent(null), null);
  assert.equal(adaptNarrativeSourceEvent([]), null);
  assert.equal(adaptNarrativeSourceEvent({
    type: "panews_update",
    title: "NVDA launches a product",
    url: "https://www.panewslab.com/news/1",
    publishedAt: PUBLISHED_AT,
    verified: true,
  }), null, "PANews has no authenticated producer schema in the current repository");
  assert.throws(() => createNarrativeSourceAdapter({ chainId: "56" }), /positive safe integer/u);
});
