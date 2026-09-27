import test from "node:test";
import assert from "node:assert/strict";
import { collectGmgnFlowNarratives, resolveGmgnFlowNarrative, GMGN_FLOW_NARRATIVE_MAX_AGE_MS } from "../src/gmgn-flow-narrative.js";

const CA = `0x${"1".repeat(40)}`, WALLET = `0x${"2".repeat(40)}`;
function xEvent(at = Date.now(), text = `AI agents for autonomous game worlds. CA ${CA}`) {
  const stamp = new Date(at).toISOString();
  return { type: "fomo_family_top_call", signalKind: "fomo_x_call", qualified: true, strong: true,
    chain: { id: 56, slug: "bsc" }, token: CA, contractAddress: CA, walletAddress: WALLET,
    source: { id: "fomo_linked_x_post", trust: "public_x_identity_linked" },
    tweet: { id: "1234567890", url: "https://x.com/alpha/status/1234567890", handle: "alpha", xUserId: "888888",
      sourceVerifiedBy: "official_x_oembed", text, createdAt: stamp },
    thesis: { text, createdAt: stamp }, body: text, publishedAt: stamp, observedAt: stamp,
    caller: { handle: "alpha", twitter: "https://x.com/alpha", xProfileId: "888888", identitySource: "fomoscan+fxtwitter", followers: 100_000, followersSyncedAt: stamp },
    walletBinding: { status: "verified", verified: true, proofSource: "fomoscan", wallet: WALLET, handle: "alpha", twitterHandle: "alpha", xProfileId: "888888", checkedAt: stamp },
    security: { decision: "pass", metrics: { liquidityConfirmed: true, sellObserved: true } }, market: { liquidityUsd: 100_000 },
  };
}
const resolve = (args = {}) => resolveGmgnFlowNarrative({ chain: "bsc", tokenAddress: CA, ...args });

test("narrative resolver uses latest strictly authenticated exact-CA X source", () => {
  const now = Date.now(), older = xEvent(now - 60_000), latest = xEvent(now, `Updated game world roadmap ${CA}`);
  older.tweet.id = '1234567889'; older.tweet.url = 'https://x.com/alpha/status/1234567889';
  const result = resolve({ events: [{ event: older }, latest], nowMs: now });
  assert.equal(result.status, "sourced"); assert.equal(result.text, latest.tweet.text);
  assert.equal(result.sourceUrl, latest.tweet.url); assert.equal(result.chain, "bsc"); assert.equal(result.tokenAddress, CA);
});

test("unproven trust labels, mismatched original text, chain, CA and stale posts never establish narrative", () => {
  const now = Date.now(), event = xEvent(now);
  const variants = [
    { ...event, walletBinding: undefined },
    { ...event, tweet: { ...event.tweet, sourceVerifiedBy: "profile_name" } },
    { ...event, tweet: { ...event.tweet, text: "unrelated tweet" } },
    { ...event, chain: { id: 8453, slug: "base" } },
    { ...event, token: WALLET },
    xEvent(now - GMGN_FLOW_NARRATIVE_MAX_AGE_MS - 1),
    { type: "twitter_update", token: CA, chain: { slug: "bsc" }, verified: true, text: "Made up story" },
  ];
  for (const entry of variants) assert.equal(resolve({ events: [entry], nowMs: now }).status, "unverified");
});

test("authenticated thesis text is sourced but never fabricates an official issuer claim", () => {
  const now = Date.now(), stamp = new Date(now).toISOString();
  const event = { ...xEvent(now), signalKind: "fomo_published_call", callId: "thesis-1", stableId: "thesis-1",
    source: { id: "fomo_family_official_thesis", trust: "official_authenticated_api" },
    thesis: { text: "My thesis: game agents are gaining adoption.", createdAt: stamp },
    body: "My thesis: game agents are gaining adoption.", fomoUrl: "https://fomo.family/profile/alpha" };
  assert.equal(resolve({ events: [event], nowMs: now }).status, "sourced");
  assert.equal(resolve({ events: [{ ...event, fomoUrl: "https://evil.example" }], nowMs: now }).status, "unverified");
});

test("exact GMGN description is project self-description with canonical GMGN attribution", () => {
  const info = { address: CA.toUpperCase().replace("0X", "0x"), chain: "bsc", link: { description: "A community project for AI agent games." } };
  const result = resolve({ tokenInfo: info });
  assert.equal(result.status, "project_claim"); assert.equal(result.text, info.link.description);
  assert.equal(result.sourceUrl, `https://gmgn.ai/bsc/token/${CA}`);
  for (const tokenInfo of [{ ...info, chain: "base" }, { ...info, chain: undefined }, { ...info, chainId: 8453 }, { ...info, address: WALLET }]) {
    assert.equal(resolve({ tokenInfo }).status, "unverified");
  }
});

test("Solana CA case, unknown chains and absent descriptions remain fail-closed", () => {
  const token = "So11111111111111111111111111111111111111112";
  assert.equal(resolveGmgnFlowNarrative({ chain: "solana", tokenAddress: token, tokenInfo: { address: token, chain: "sol", link: { description: "Wrapped native SOL" } } }).status, "project_claim");
  assert.equal(resolveGmgnFlowNarrative({ chain: "sol", tokenAddress: token, tokenInfo: { address: token.toLowerCase(), chain: "sol", link: { description: "Impostor" } } }).status, "unverified");
  assert.equal(resolve({ chain: "imaginary" }).status, "unverified");
  assert.equal(resolve({ tokenInfo: { chain: "bsc", address: CA, name: "AI Robot Token" } }).status, "unverified");
});

test("narrative excerpts are bounded and never cut a CA in half", () => {
  const result = resolve({ tokenInfo: { chain: "bsc", address: CA, link: { description: `${"a".repeat(200)} ${CA} ${"b".repeat(300)}` } } });
  assert.ok(result.text.length <= 220); assert.ok(!result.text.includes("0x") || result.text.includes(CA));
});

test('collector preserves source identity, flags conflicting copies, and cannot re-date an old permalink', () => {
  const now = Date.now(), original = xEvent(now - 60000), replay = xEvent(now);
  let rows = collectGmgnFlowNarratives({ chain: 'bsc', tokenAddress: CA, events: [original, replay], nowMs: now });
  assert.equal(rows.length, 1); assert.equal(rows[0].sourceAt, original.publishedAt);
  assert.equal(rows[0].authorKey, 'x-id:888888'); assert.equal(rows[0].sourceAuthenticated, true);
  rows = collectGmgnFlowNarratives({ chain: 'bsc', tokenAddress: CA, events: [original, xEvent(now, `The launch is cancelled ${CA}`)], nowMs: now });
  assert.equal(rows[0].contentConflict, true);
  rows = collectGmgnFlowNarratives({ chain: 'bsc', tokenAddress: CA, events: [xEvent(now - GMGN_FLOW_NARRATIVE_MAX_AGE_MS - 1), replay], nowMs: now });
  assert.equal(rows.length, 0);
});

test('different authenticated Fomo call IDs sharing a profile URL remain distinct posts', () => {
  const now = Date.now(), stamp = new Date(now).toISOString();
  const make = (id, text) => ({ ...xEvent(now), signalKind: 'fomo_published_call', callId: id, stableId: id,
    source: { id: 'fomo_family_official_thesis', trust: 'official_authenticated_api' },
    thesis: { text, createdAt: stamp }, body: text, fomoUrl: 'https://fomo.family/profile/alpha' });
  const rows = collectGmgnFlowNarratives({ chain: 'bsc', tokenAddress: CA, nowMs: now,
    events: [make('call-1', 'The game agent product released a public roadmap.'), make('call-2', 'The game agent product has launched public testing.')] });
  assert.equal(rows.length, 2); assert.ok(rows.every(row => !row.contentConflict));
});
