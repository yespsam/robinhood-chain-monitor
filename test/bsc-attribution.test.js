import test from "node:test";
import assert from "node:assert/strict";
import {
  inferBscLaunchpadAttribution,
  parseBscScanAttribution,
  parseDexScreenerTokenPairs,
} from "../src/bsc-attribution.js";

const token = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";

test("BscScan attribution is scoped to Contract Creator and a verified source heading", () => {
  const creator = "0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD";
  const creationTransaction = `0x${"a".repeat(64)}`;
  const noiseTransaction = `0x${"b".repeat(64)}`;
  const html = `
    <a href="/tx/${noiseTransaction}">unrelated transaction</a>
    <section><span>Contract</span> Creator
      <a href="/address/${creator}">creator</a> at txn
      <a href="/tx/${creationTransaction}?utm=noise">creation</a>
    </section>
    <div>Contract Name:</div><div>FlapTokenV3</div>
    <h3>Contract Source Code Verified (Exact Match)</h3>`;
  assert.deepEqual(parseBscScanAttribution(html), {
    creationTransaction,
    creator: creator.toLowerCase(),
    contractName: "FlapTokenV3",
    verifiedSource: true,
  });
});

test("BscScan attribution rejects links and verification copy outside valid structures", () => {
  const transaction = `0x${"c".repeat(64)}`;
  const html = `
    <script>const copy = "Contract Creator Contract Source Code Verified";</script>
    <a href="/address/${other}">noise</a><a href="/tx/${transaction}">noise</a>
    <div>Contract Name:</div><div>not a solidity contract name!</div>
    <p>This developer says the source is verified.</p>`;
  assert.deepEqual(parseBscScanAttribution(html), {
    creationTransaction: null,
    creator: null,
    contractName: null,
    verifiedSource: false,
  });
});

test("BscScan negative source heading wins over positive-looking page noise", () => {
  const html = `<div>Contract Name:</div><div>Token</div>
    <div>Contract Source Code Verified (Exact Match)</div><div>Contract Source Code Not Verified</div>`;
  assert.equal(parseBscScanAttribution(html).verifiedSource, false);
});

test("BscScan current exact-match source layout is recognized", () => {
  const html = `<div id="ContentPlaceHolder1_contractCodeDiv">
    <span><strong>Source Code Verified</strong></span><span>Exact Match</span>
    <h6>Contract Name</h6><h4>TransparentUpgradeableProxy</h4>
    <h6>Compiler Version</h6></div>`;
  const parsed = parseBscScanAttribution(html);
  assert.equal(parsed.contractName, "TransparentUpgradeableProxy");
  assert.equal(parsed.verifiedSource, true);
});

test("BscScan similar-match source is not promoted to verified family evidence", () => {
  const html = `<div id="ContentPlaceHolder1_contractCodeDiv">
    <strong>Source Code Verified</strong><span>Similar Match</span>
    <h6>Contract Name</h6><h4>TokenClone</h4></div>`;
  assert.equal(parseBscScanAttribution(html).verifiedSource, false);
});

function pair(overrides = {}) {
  return {
    chainId: "bsc",
    dexId: "pancakeswap",
    pairAddress: "0x3333333333333333333333333333333333333333",
    url: "https://dexscreener.com/bsc/example#chart",
    baseToken: { address: token, name: "Target", symbol: "TGT" },
    quoteToken: { address: other, name: "Wrapped BNB", symbol: "WBNB" },
    pairCreatedAt: 200,
    liquidity: { usd: 50 },
    info: {
      websites: [{ url: "https://project.example/app#top" }, { url: "javascript:alert(1)" }],
      socials: [
        { type: "twitter", url: "https://twitter.com/Project_Token/status/123?ref=x" },
        { type: "telegram", url: "https://telegram.me/project_chat?start=bad" },
      ],
    },
    ...overrides,
  };
}

test("DEX Screener parser keeps only BSC pairs containing the token and ranks first/best independently", () => {
  const earliest = pair({
    pairAddress: "0x4444444444444444444444444444444444444444",
    pairCreatedAt: 100,
    liquidity: { usd: 5 },
  });
  const liquid = pair({ pairCreatedAt: 300, liquidity: { usd: "900.5" } });
  const wrongChain = pair({ chainId: "ethereum", pairCreatedAt: 1, liquidity: { usd: 9_999 } });
  const wrongToken = pair({
    baseToken: { address: "0x5555555555555555555555555555555555555555" },
    quoteToken: { address: "0x6666666666666666666666666666666666666666" },
  });
  const result = parseDexScreenerTokenPairs({ pairs: [liquid, wrongChain, wrongToken, earliest] }, token.toUpperCase().replace(/^0X/, "0x"));
  assert.equal(result.pairCount, 2);
  assert.equal(result.firstPair.pairAddress, earliest.pairAddress);
  assert.equal(result.bestPair.pairAddress, liquid.pairAddress);
  assert.equal(result.bestPair.liquidityUsd, 900.5);
  assert.equal(result.website, "https://project.example/app");
  assert.equal(result.twitter, "https://x.com/Project_Token");
  assert.equal(result.telegram, "https://t.me/project_chat");
});

test("DEX Screener parser rejects unsafe or mislabeled social URLs", () => {
  const result = parseDexScreenerTokenPairs([pair({
    info: {
      websites: [{ url: "http://insecure.example" }, { url: "https://localhost/private" }],
      socials: [
        { type: "twitter", url: "https://evil.example/project" },
        { type: "telegram", url: "https://x.com/not_telegram" },
      ],
    },
  })], token);
  assert.deepEqual(result.socials, { website: null, twitter: null, telegram: null });
});

test("DEX Screener parser accepts the target as quote token and handles malformed input", () => {
  const quoteTarget = pair({
    baseToken: { address: other, name: "Base", symbol: "BASE" },
    quoteToken: { address: token, name: "Target", symbol: "TGT" },
  });
  assert.equal(parseDexScreenerTokenPairs([quoteTarget], token).pairCount, 1);
  assert.equal(parseDexScreenerTokenPairs({ nope: [] }, "bad-address").firstPair, null);
});

test("an exact official factory is verified and lower-tier disagreement is only a recorded conflict", () => {
  const result = inferBscLaunchpadAttribution({
    officialFactory: {
      platform: { id: "flap", name: "Flap", website: "https://flap.sh" },
      address: "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0",
      sourceId: "flap-official-docs",
    },
    thirdPartyLabels: { platform: "Four.Meme", sourceId: "dex-label" },
  });
  assert.equal(result.status, "verified");
  assert.equal(result.platform.id, "flap");
  assert.equal(result.match, "official_factory");
  assert.equal(result.conflicts[0].platform.id, "fourmeme");
});

test("a Binance official token record alone remains candidate", () => {
  const result = inferBscLaunchpadAttribution({
    binanceTokenRecord: { protocolName: "Four.Meme", contractAddress: token, tokenVersion: "v2" },
  });
  assert.equal(result.status, "candidate");
  assert.equal(result.platform.id, "fourmeme");
  assert.equal(result.match, "binance_wallet_token_record");
  assert.equal(result.evidence[0].trust, "official_record");
});

test("verified source family plus independent causal evidence is corroborated", () => {
  const result = inferBscLaunchpadAttribution({
    verifiedSourceFamily: {
      platform: { id: "flap", name: "Flap" },
      contractName: "FlapTaxTokenV3",
      sourceId: "bscscan-source",
      verifiedSource: true,
    },
    causalEvidence: {
      platform: "Flap",
      emitter: "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0",
      blockNumber: 123,
      sourceId: "transaction-receipt",
    },
  });
  assert.equal(result.status, "corroborated");
  assert.equal(result.match, "verified_source_family+causal_event");
  assert.equal(result.evidence.length, 2);
});

test("the same source cannot self-corroborate a source family", () => {
  const result = inferBscLaunchpadAttribution({
    verifiedSourceFamily: { platform: "Flap", sourceId: "one-source" },
    externalEvidence: { platform: "Flap", sourceId: "one-source" },
  });
  assert.equal(result.status, "candidate");
});

test("equal-tier platform conflicts are ambiguous", () => {
  const candidateConflict = inferBscLaunchpadAttribution({
    binanceTokenRecords: [
      { protocolName: "Flap", sourceId: "binance-a" },
      { protocolName: "Four.Meme", sourceId: "binance-b" },
    ],
  });
  assert.equal(candidateConflict.status, "ambiguous");
  assert.equal(candidateConflict.platform, null);
  assert.equal(candidateConflict.conflicts.length, 2);

  const officialConflict = inferBscLaunchpadAttribution({ officialFactories: [
    { platform: "Flap", address: "0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0" },
    { platform: "Four.Meme", address: "0xec4549cadce5da21df6e6422d448034b5233bfbc" },
  ] });
  assert.equal(officialConflict.status, "ambiguous");
  assert.equal(officialConflict.match, "conflicting_verified_evidence");
});

test("third-party labels can suggest a candidate but never verified attribution", () => {
  const result = inferBscLaunchpadAttribution({
    thirdPartyLabels: { platform: "Unlisted Launchpad", sourceId: "community-label", trust: "official_verified" },
  });
  assert.equal(result.status, "candidate");
  assert.equal(result.platform.id, "unlistedlaunchpad");
  assert.equal(result.evidence[0].trust, "third_party");
});

test("an official label without an exact factory address cannot become verified", () => {
  const result = inferBscLaunchpadAttribution({
    officialFactory: { platform: "Flap", sourceId: "copied-doc-label" },
    evidence: [
      { kind: "official_factory", platform: "Four.Meme", trust: "third_party", address: "0xec4549cadce5da21df6e6422d448034b5233bfbc" },
      { kind: "source_family", platform: "Four.Meme", trust: "third_party" },
    ],
  });
  assert.equal(result.status, "candidate");
  assert.equal(result.platform.id, "fourmeme");
  assert.equal(result.evidence[0].trust, "third_party");
});

test("no usable attribution evidence returns the complete unknown schema", () => {
  assert.deepEqual(inferBscLaunchpadAttribution({}), {
    status: "unknown",
    platform: null,
    match: null,
    evidence: [],
    conflicts: [],
  });
});
