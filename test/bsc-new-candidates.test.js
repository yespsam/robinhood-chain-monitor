import test from "node:test";
import assert from "node:assert/strict";
import { Interface, getAddress } from "ethers";
import {
  BFUN_NEW_TOKEN_TOPIC,
  BNBS_STANDARD_TOKEN_CREATED_TOPIC,
  BNBS_TAX_TOKEN_CREATED_TOPIC,
  BSC_LAUNCH_TOPICS,
  BSC_PLATFORM_LIFECYCLE_TOPICS,
  BSC_TRIGGER_TOPICS,
  EAGLE_LAUNCHPAD_TOKEN_DEPLOYED_TOPIC,
  EAGLE_TOKEN_CREATED_TOPIC,
  ONEVONE_TOURNAMENT_CREATED_TOPIC,
  SINGULARRY_CURVE_FINALIZED_TOPIC,
  SINGULARRY_SYSTEM_DEPLOYED_TOPIC,
  commitBscDecision,
  evaluateBscObservation,
  parseKnownBscLaunchEvidence,
  parseKnownBscLaunchTokens,
  parseOfficialBscLifecycleLog,
  parseSingularryTokenPayload,
  platformForAddress,
} from "../src/bsc-launchpad-monitor.js";
import { DEFAULT_REPOSITORIES } from "../src/github-monitor.js";
import { BSC_DISCOVERY_SITE_TARGETS, extractSiteSignals } from "../src/site-monitor.js";
import { OFFICIAL_TWITTER_TARGETS } from "../src/twitter-monitor.js";

const EAGLE_INNER_FACTORY = "0x09c3febd30cb7be4f97924846c24f80604650947";
const EAGLE_LAUNCHPAD_FACTORY = "0x56ec1c3c9fd70099aea154c93a2d201e1fa0b589";
const BNBS_STANDARD_FACTORY = "0x99433911060ce29ba2272d3664854983bba3e258";
const BNBS_TAX_FACTORY = "0xa7fadbd1e27a898f1f719adf7e52206aa413d2aa";
const BFUN_FACTORY = "0x718fa87734cc6fce3e7374663a0dafa334aa4876";
const SINGULARRY_FACTORY = "0x1b1bd5e6ba84c8354c671ece0a45c9dfbeb7b4ec";
const ONEVONE_MANAGER = "0x5b3ba297a60685844fe673c134651d7dcf1a74b6";
const PRELAUNCH_FACTORY = "0xf77da2cf754234f17c0c0252052daa5af1f32cb4";

const eagleInner = new Interface([
  "event TokenCreated(address indexed token,address indexed launch,address indexed creator,string name,string symbol,uint256 totalSupply,uint256 saleInventory,string imageURI,string description,string website,string telegram,string twitter)",
]);
const eagleLaunchpad = new Interface([
  "event LaunchpadTokenDeployed(address indexed owner,address indexed token,uint8 indexed tokenType,string name,string symbol)",
]);
const bnbsStandard = new Interface([
  "event TokenCreated(address indexed tokenAddress,string name,string symbol,string logoUrl,string twitter,string telegram,address indexed creator,uint256 fundingGoal)",
]);
const bnbsTax = new Interface([
  "event TokenCreated(address indexed tokenAddress,string name,string symbol,string logoUrl,string twitter,string telegram,address indexed creator,uint256 fundingGoal,uint256 buyTaxRate,uint256 sellTaxRate,uint256 marketShare,uint256 burnShare,uint256 reflectShare,uint256 liquidityShare,uint256 minHoldForReward,address reflectionAsset)",
]);
const bfunFactory = new Interface([
  "event NewBFunToken(address addr,address bondingCurve,address creator,bytes signature,address payoutRecipient,address owner,uint256 nonce,string name,string symbol,string tokenURI,string version)",
]);
const singularryFactory = new Interface([
  "event BondingCurveSystemDeployed(address indexed bondingCurve,address indexed token,address indexed owner,string name,string symbol)",
]);
const singularryCurve = new Interface([
  "event CurveFinalized(address indexed uniswapPool,uint256 indexed lpTokenId)",
]);
const onevoneTournament = new Interface([
  "event TournamentCreated(uint256 indexed tournamentId,uint256 entryFee,uint256 roundDelay,uint256 roundDuration,uint256 startTime)",
]);

function encodedLog(address, contractInterface, eventName, values) {
  return { address, ...contractInterface.encodeEventLog(contractInterface.getEvent(eventName), values) };
}

function monitorState() {
  return {
    initializedAt: "2026-08-02T00:00:00.000Z",
    launchers: {},
    seenTransactions: {},
    coverageGaps: [],
  };
}

function observation({
  launcher,
  platform,
  token,
  transactionHash,
  blockNumber,
  caller = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  fingerprint = "candidate-mode-a",
  security = {
    decision: "block",
    reasons: ["检测到可增发入口", "池子实际流动性未确认"],
    metrics: { liquidityConfirmed: false },
  },
} = {}) {
  return {
    launcher,
    platform,
    transactionHash,
    blockNumber,
    tokens: [{ token, metadata: { name: "Candidate", symbol: "CAND" } }],
    pools: [],
    mode: {
      fingerprint,
      selector: "0x12345678",
      poolKinds: [],
      creationTopics: [EAGLE_TOKEN_CREATED_TOPIC],
      customTopics: [EAGLE_TOKEN_CREATED_TOPIC],
      tokenSelectorHash: "token-template-a",
      launcherCodeHash: "launcher-code-a",
      implementation: "0x7777777777777777777777777777777777777777",
    },
    structural: {
      eligible: true,
      mechanismEvidence: true,
      usesCreate2: true,
      codeSize: 12_000,
      argumentBytes: 128,
    },
    deployer: caller,
    causalTokenEvent: true,
    security,
    sampleToken: token,
    observedAt: "2026-08-02T01:00:00.000Z",
  };
}

test("Eagle exact creation events preserve supply, socials and both launch modes", () => {
  const innerToken = "0x1111111111111111111111111111111111111111";
  const launch = "0x2222222222222222222222222222222222222222";
  const creator = "0x3333333333333333333333333333333333333333";
  const totalSupply = (10n ** 30n) + 123n;
  const saleInventory = (8n * 10n ** 29n) + 456n;
  const deployedToken = "0x4444444444444444444444444444444444444444";
  const owner = "0x5555555555555555555555555555555555555555";

  const logs = [
    encodedLog(EAGLE_INNER_FACTORY, eagleInner, "TokenCreated", [
      innerToken,
      launch,
      creator,
      "Eagle AI",
      "EAI",
      totalSupply,
      saleInventory,
      "ipfs://eagle-image",
      "AI-assisted inner-market launch",
      "https://eagle-token.example",
      "https://t.me/eagletoken",
      "https://x.com/eagletoken",
    ]),
    encodedLog(EAGLE_LAUNCHPAD_FACTORY, eagleLaunchpad, "LaunchpadTokenDeployed", [
      owner,
      deployedToken,
      2,
      "Eagle Tax",
      "ETAX",
    ]),
  ];

  const evidence = parseKnownBscLaunchEvidence(logs);
  assert.equal(evidence.length, 2);
  assert.deepEqual(evidence[0], {
    token: getAddress(innerToken),
    creator: getAddress(creator),
    launch: launch,
    name: "Eagle AI",
    symbol: "EAI",
    totalSupply: totalSupply.toString(),
    saleInventory: saleInventory.toString(),
    image: "ipfs://eagle-image",
    description: "AI-assisted inner-market launch",
    website: "https://eagle-token.example",
    twitter: "https://x.com/eagletoken",
    telegram: "https://t.me/eagletoken",
    launchType: "eagle_inner_market",
    event: "TokenCreated",
    emitter: getAddress(EAGLE_INNER_FACTORY),
    topic: EAGLE_TOKEN_CREATED_TOPIC,
  });
  assert.deepEqual(evidence[1], {
    token: getAddress(deployedToken),
    creator: getAddress(owner),
    name: "Eagle Tax",
    symbol: "ETAX",
    launchType: "eagle_launchpad_type_2",
    event: "LaunchpadTokenDeployed",
    emitter: getAddress(EAGLE_LAUNCHPAD_FACTORY),
    topic: EAGLE_LAUNCHPAD_TOKEN_DEPLOYED_TOPIC,
  });
  assert.deepEqual(parseKnownBscLaunchTokens(logs), [getAddress(innerToken), getAddress(deployedToken)]);
  assert.ok(BSC_LAUNCH_TOPICS.includes(EAGLE_TOKEN_CREATED_TOPIC));
  assert.ok(BSC_LAUNCH_TOPICS.includes(EAGLE_LAUNCHPAD_TOKEN_DEPLOYED_TOPIC));
});

test("BNBS standard and tax events decode independently and map to official factories", () => {
  const standardToken = "0x6111111111111111111111111111111111111111";
  const taxToken = "0x6222222222222222222222222222222222222222";
  const creator = "0x6333333333333333333333333333333333333333";
  const reflectionAsset = "0x55d398326f99059ff775485246999027b3197955";
  const fundingGoal = (1n << 160n) + 99n;
  const minHoldForReward = (1n << 128n) + 7n;

  const logs = [
    encodedLog(BNBS_STANDARD_FACTORY, bnbsStandard, "TokenCreated", [
      standardToken,
      "BNBS Standard",
      "BNBSS",
      "ipfs://bnbs-standard",
      "https://x.com/bnbsstandard",
      "https://t.me/bnbsstandard",
      creator,
      fundingGoal,
    ]),
    encodedLog(BNBS_TAX_FACTORY, bnbsTax, "TokenCreated", [
      taxToken,
      "BNBS Tax",
      "BNBST",
      "ipfs://bnbs-tax",
      "https://x.com/bnbstax",
      "https://t.me/bnbstax",
      creator,
      fundingGoal + 1n,
      100n,
      200n,
      3_000n,
      1_000n,
      2_500n,
      3_500n,
      minHoldForReward,
      reflectionAsset,
    ]),
  ];

  const [standard, tax] = parseKnownBscLaunchEvidence(logs);
  assert.deepEqual(standard, {
    token: getAddress(standardToken),
    creator: getAddress(creator),
    name: "BNBS Standard",
    symbol: "BNBSS",
    image: "ipfs://bnbs-standard",
    twitter: "https://x.com/bnbsstandard",
    telegram: "https://t.me/bnbsstandard",
    fundingGoal: fundingGoal.toString(),
    launchType: "bnbs_standard_curve",
    event: "TokenCreated",
    emitter: getAddress(BNBS_STANDARD_FACTORY),
    topic: BNBS_STANDARD_TOKEN_CREATED_TOPIC,
  });
  assert.deepEqual(tax, {
    token: getAddress(taxToken),
    creator: getAddress(creator),
    name: "BNBS Tax",
    symbol: "BNBST",
    image: "ipfs://bnbs-tax",
    twitter: "https://x.com/bnbstax",
    telegram: "https://t.me/bnbstax",
    fundingGoal: (fundingGoal + 1n).toString(),
    buyTaxRate: "100",
    sellTaxRate: "200",
    marketShare: "3000",
    burnShare: "1000",
    reflectShare: "2500",
    liquidityShare: "3500",
    minHoldForReward: minHoldForReward.toString(),
    reflectionAsset: getAddress(reflectionAsset),
    launchType: "bnbs_tax_reflection_curve",
    event: "TokenCreated",
    emitter: getAddress(BNBS_TAX_FACTORY),
    topic: BNBS_TAX_TOKEN_CREATED_TOPIC,
  });

  const standardPlatform = platformForAddress(BNBS_STANDARD_FACTORY);
  const taxPlatform = platformForAddress(BNBS_TAX_FACTORY);
  assert.equal(standardPlatform.id, "bnbs");
  assert.equal(standardPlatform.trust, "official_verified");
  assert.equal(taxPlatform.id, "bnbs-tax");
  assert.equal(taxPlatform.trust, "official_verified");
  assert.equal(taxPlatform.notifyFirstInfrastructureActivation, true);
  assert.ok(BSC_LAUNCH_TOPICS.includes(BNBS_STANDARD_TOKEN_CREATED_TOPIC));
  assert.ok(BSC_LAUNCH_TOPICS.includes(BNBS_TAX_TOKEN_CREATED_TOPIC));
});

test("B.Fun exact creation event preserves dynamic-curve addresses, metadata, version and uint256 precision", () => {
  const token = "0x9111111111111111111111111111111111111111";
  const bondingCurve = "0x9222222222222222222222222222222222222222";
  const creator = "0x9333333333333333333333333333333333333333";
  const payoutRecipient = "0x9444444444444444444444444444444444444444";
  const owner = "0x9555555555555555555555555555555555555555";
  const nonce = (1n << 220n) + 123_456_789n;
  const log = encodedLog(BFUN_FACTORY, bfunFactory, "NewBFunToken", [
    token,
    bondingCurve,
    creator,
    "0xdeadbeef01020304",
    payoutRecipient,
    owner,
    nonce,
    "B.Fun Agent",
    "BFAI",
    "ipfs://bfun-agent-metadata",
    "dynamic-curve-v2026.08",
  ]);

  assert.equal(log.topics.length, 1, "the official B.Fun event has no indexed parameters");
  assert.equal(log.topics[0], BFUN_NEW_TOKEN_TOPIC);
  assert.deepEqual(parseKnownBscLaunchEvidence([log]), [{
    token: getAddress(token),
    bondingCurve: getAddress(bondingCurve),
    creator: getAddress(creator),
    payoutRecipient: getAddress(payoutRecipient),
    owner: getAddress(owner),
    nonce: nonce.toString(),
    name: "B.Fun Agent",
    symbol: "BFAI",
    metadataUri: "ipfs://bfun-agent-metadata",
    version: "dynamic-curve-v2026.08",
    launchType: "bfun_dynamic_curve",
    event: "NewBFunToken",
    emitter: getAddress(BFUN_FACTORY),
    topic: BFUN_NEW_TOKEN_TOPIC,
  }]);
  assert.deepEqual(parseKnownBscLaunchTokens([log]), [getAddress(token)]);
  assert.ok(BSC_LAUNCH_TOPICS.includes(BFUN_NEW_TOKEN_TOPIC));

  const platform = platformForAddress(BFUN_FACTORY);
  assert.equal(platform.id, "bfun");
  assert.equal(platform.name, "B.Fun");
  assert.equal(platform.trust, "official_verified");
  assert.equal(platform.website, "https://b.fun");
  assert.equal(platform.twitter, "https://x.com/BdotFun");
  assert.equal(platform.github, "https://github.com/bfun-ai/bfun-ai");
});

test("Singularry exact deployment event maps its bonding curve, token and owner to the official launchpad", () => {
  const bondingCurve = "0xa111111111111111111111111111111111111111";
  const token = "0xa222222222222222222222222222222222222222";
  const owner = "0xa333333333333333333333333333333333333333";
  const log = encodedLog(SINGULARRY_FACTORY, singularryFactory, "BondingCurveSystemDeployed", [
    bondingCurve,
    token,
    owner,
    "Singularry Agent",
    "SGAI",
  ]);

  assert.equal(SINGULARRY_SYSTEM_DEPLOYED_TOPIC, "0x3ef4c1f0529a2ee6b2e04f4f81ace41250f87a6d1ecc603d9168c55780c890fb");
  assert.equal(log.topics[0], SINGULARRY_SYSTEM_DEPLOYED_TOPIC);
  assert.equal(log.topics.length, 4, "bondingCurve, token and owner must remain indexed");
  assert.deepEqual(parseKnownBscLaunchEvidence([log]), [{
    token: getAddress(token),
    creator: getAddress(owner),
    bondingCurve: getAddress(bondingCurve),
    name: "Singularry Agent",
    symbol: "SGAI",
    launchType: "singularry_bonding_thena_v3",
    event: "BondingCurveSystemDeployed",
    emitter: getAddress(SINGULARRY_FACTORY),
    topic: SINGULARRY_SYSTEM_DEPLOYED_TOPIC,
  }]);
  assert.deepEqual(parseKnownBscLaunchTokens([log]), [getAddress(token)]);
  assert.ok(BSC_LAUNCH_TOPICS.includes(SINGULARRY_SYSTEM_DEPLOYED_TOPIC));

  const platform = platformForAddress(SINGULARRY_FACTORY);
  assert.equal(platform.id, "singularry");
  assert.equal(platform.name, "Singularry Launchpad");
  assert.equal(platform.trust, "official_verified");
  assert.equal(platform.notifyFirstToken, true);
  assert.equal(platform.website, "https://launch.singularry.org");
  assert.equal(platform.twitter, "https://x.com/singularryai");
  assert.equal(platform.evidenceUrl, "https://docs.singularry.org/launchpad/overview");
  assert.equal(platform.github, null);
});

test("Singularry first curve graduation resolves the token from its exact creation evidence", () => {
  const bondingCurve = "0xa411111111111111111111111111111111111111";
  const token = "0xa422222222222222222222222222222222222222";
  const owner = "0xa433333333333333333333333333333333333333";
  const pool = "0xa444444444444444444444444444444444444444";
  const lpTokenId = (1n << 240n) + 987_654_321n;
  const deploymentLog = encodedLog(SINGULARRY_FACTORY, singularryFactory, "BondingCurveSystemDeployed", [
    bondingCurve,
    token,
    owner,
    "Singularry Graduate",
    "SGRAD",
  ]);
  const [creation] = parseKnownBscLaunchEvidence([deploymentLog]);
  assert.equal(creation.bondingCurve, getAddress(bondingCurve));
  assert.equal(creation.token, getAddress(token));

  const curveRecord = { curve: creation.bondingCurve, token: creation.token };
  const singularryCurves = new Map([[creation.bondingCurve.toLowerCase(), curveRecord]]);
  const finalizedLog = encodedLog(creation.bondingCurve, singularryCurve, "CurveFinalized", [pool, lpTokenId]);
  const lifecycle = parseOfficialBscLifecycleLog(finalizedLog, { singularryCurves });

  assert.equal(SINGULARRY_CURVE_FINALIZED_TOPIC, "0x1e75a30ff2c00ce5b7284539725ed60843e751d9d76c3334813a971e24955ebe");
  assert.equal(finalizedLog.topics[0], SINGULARRY_CURVE_FINALIZED_TOPIC);
  assert.equal(finalizedLog.topics.length, 3, "pool and LP token id must remain indexed");
  assert.equal(lifecycle.platform.id, "singularry");
  assert.equal(lifecycle.platform.trust, "official_verified");
  assert.equal(lifecycle.lifecycleId, "first_curve_finalized");
  assert.equal(lifecycle.eventName, "CurveFinalized");
  assert.equal(lifecycle.token, getAddress(token));
  assert.equal(lifecycle.pool, getAddress(pool));
  assert.equal(lifecycle.lpTokenId, lpTokenId.toString());
  assert.ok(BSC_PLATFORM_LIFECYCLE_TOPICS.includes(SINGULARRY_CURVE_FINALIZED_TOPIC));
  assert.ok(BSC_TRIGGER_TOPICS.includes(SINGULARRY_CURVE_FINALIZED_TOPIC));

  assert.equal(parseOfficialBscLifecycleLog({ ...finalizedLog, address: SINGULARRY_FACTORY }, { singularryCurves }), null);
  assert.equal(parseOfficialBscLifecycleLog({ ...finalizedLog, address: "0xa455555555555555555555555555555555555555" }, { singularryCurves }), null);
});

test("Singularry token API normalizes current launch and graduation fields and rejects malformed schemas", () => {
  const token = "0xB511111111111111111111111111111111111111";
  const curve = "0xB522222222222222222222222222222222222222";
  const owner = "0xB533333333333333333333333333333333333333";
  const pool = "0xB544444444444444444444444444444444444444";
  const graduatedAt = "2026-08-02T04:05:06.000Z";

  assert.deepEqual(parseSingularryTokenPayload([
    {
      mint: token,
      bondingCurve: curve,
      creator: { walletAddress: owner },
      name: "  Singularry\tAPI Agent  ",
      symbol: " SAPI ",
      complete: true,
      currentPhase: "  graduated  ",
      graduatedAt,
      dexPoolAddress: pool,
      graduationDex: "  THENA\tV3  ",
      progressBps: "10000",
    },
    { mint: "not-an-address", bondingCurve: curve },
    { mint: "0xB555555555555555555555555555555555555555", bondingCurve: "0x1234" },
  ]), [{
    token: token.toLowerCase(),
    curve: curve.toLowerCase(),
    owner: owner.toLowerCase(),
    name: "Singularry API Agent",
    symbol: "SAPI",
    complete: true,
    currentPhase: "graduated",
    graduatedAt,
    pool: pool.toLowerCase(),
    graduationDex: "THENA V3",
    progressBps: 10_000,
  }]);

  assert.throws(
    () => parseSingularryTokenPayload({ data: [] }),
    /Singularry token schema: expected array/,
  );
});

test("1V1MEME lifecycle parsing keeps the full ABI and uint256 precision", () => {
  const tournamentId = (1n << 200n) + 123_456_789n;
  const entryFee = (1n << 180n) + 987n;
  const roundDelay = (1n << 100n) + 15n;
  const roundDuration = (1n << 120n) + 30n;
  const startTime = (1n << 140n) + 1_800n;
  const log = encodedLog(ONEVONE_MANAGER, onevoneTournament, "TournamentCreated", [
    tournamentId,
    entryFee,
    roundDelay,
    roundDuration,
    startTime,
  ]);

  const lifecycle = parseOfficialBscLifecycleLog(log);
  assert.equal(lifecycle.platform.id, "onevone");
  assert.equal(lifecycle.platform.trust, "multi_source_corroborated");
  assert.equal(lifecycle.lifecycleId, "first_tournament_created");
  assert.equal(lifecycle.eventName, "TournamentCreated");
  assert.equal(lifecycle.tournamentId, tournamentId.toString());
  assert.equal(lifecycle.entryFee, entryFee.toString());
  assert.equal(lifecycle.roundDelay, roundDelay.toString());
  assert.equal(lifecycle.roundDuration, roundDuration.toString());
  assert.equal(lifecycle.startTime, startTime.toString());
  assert.equal(log.topics[0], ONEVONE_TOURNAMENT_CREATED_TOPIC);

  assert.equal(parseOfficialBscLifecycleLog({ ...log, address: "0x7000000000000000000000000000000000000007" }), null);
  assert.equal(parseOfficialBscLifecycleLog({ ...log, data: "0x1234" }), null);
  assert.equal(parseOfficialBscLifecycleLog({ ...log, topics: [log.topics[0]] }), null);
});

test("Eagle infrastructure activation alerts once without weakening other first-token safety gates", () => {
  const snapshot = monitorState();
  const platform = platformForAddress(EAGLE_INNER_FACTORY);
  const first = observation({
    launcher: EAGLE_INNER_FACTORY,
    platform,
    token: "0x8111111111111111111111111111111111111111",
    transactionHash: `0x${"1".repeat(64)}`,
    blockNumber: 101,
  });
  const decision = evaluateBscObservation(snapshot, first, Date.parse("2026-08-02T01:00:00.000Z"));
  assert.equal(decision.kind, "new_launchpad");
  assert.equal(decision.officialFirstToken, true);
  commitBscDecision(snapshot, decision);

  const repeated = evaluateBscObservation(snapshot, observation({
    launcher: EAGLE_INNER_FACTORY,
    platform,
    token: "0x8222222222222222222222222222222222222222",
    transactionHash: `0x${"2".repeat(64)}`,
    blockNumber: 102,
  }), Date.parse("2026-08-02T01:00:01.000Z"));
  assert.equal(repeated, null);
  assert.equal(snapshot.launchers[EAGLE_INNER_FACTORY].discoveryAlerted, true);

  const hodlFactory = "0x99a1f02f56e8356e6e90a880dbb1be6ec7485737";
  const hodlSnapshot = monitorState();
  const hodlPlatform = platformForAddress(hodlFactory);
  assert.equal(hodlPlatform.notifyFirstToken, true);
  assert.notEqual(hodlPlatform.notifyFirstInfrastructureActivation, true);
  assert.equal(evaluateBscObservation(hodlSnapshot, observation({
    launcher: hodlFactory,
    platform: hodlPlatform,
    token: "0x8333333333333333333333333333333333333333",
    transactionHash: `0x${"3".repeat(64)}`,
    blockNumber: 103,
  }), Date.parse("2026-08-02T01:00:02.000Z")), null);
});

test("the f77d prelaunch prototype records unsafe same-caller samples without announcing a launchpad", () => {
  const snapshot = monitorState();
  const platform = platformForAddress(PRELAUNCH_FACTORY);
  assert.equal(platform.id, "unnamed-usdt-curve-prototype");
  assert.equal(platform.trust, "chain_verified_prelaunch");
  assert.equal(platform.notifyFirstToken, true);

  const caller = "0x62d0d2dda53f2de7fdb6a770f0d8a19228bdaa90";
  for (let index = 1; index <= 8; index += 1) {
    const nibble = index.toString(16);
    const decision = evaluateBscObservation(snapshot, observation({
      launcher: PRELAUNCH_FACTORY,
      platform,
      token: `0x${nibble.repeat(40)}`,
      transactionHash: `0x${nibble.repeat(64)}`,
      blockNumber: 200 + index,
      caller,
      fingerprint: "f77d-prelaunch-prototype",
    }), Date.parse("2026-08-02T01:00:00.000Z") + index * 1_000);
    assert.equal(decision, null, `unsafe prelaunch sample ${index} must remain silent`);
  }

  const launcher = snapshot.launchers[PRELAUNCH_FACTORY];
  const mode = launcher.modes["f77d-prelaunch-prototype"];
  assert.equal(launcher.uniqueTokenCount, 8);
  assert.equal(launcher.discoveryAlerted, false);
  assert.deepEqual(launcher.callers, [caller]);
  assert.equal(mode.safeTokens.length, 0);
  assert.deepEqual(mode.callers, [caller]);
});

test("new candidate sources are silently baselined and BNBS tracks only structural AI assets", () => {
  const repositories = new Map(DEFAULT_REPOSITORIES.map((entry) => [entry.repository.toLowerCase(), entry]));
  assert.equal(repositories.get("1v1me-me/foundry")?.baselineOnly, true);
  assert.equal(repositories.get("1v1me-me/foundry")?.sourceTrust, "multi_source_corroborated");
  assert.equal(repositories.get("zhangjichao1717/bnbs-meme-token-template")?.baselineOnly, true);
  assert.equal(repositories.get("zhangjichao1717/bnbs-meme-token-template")?.sourceTrust, "multi_source_corroborated");
  assert.equal(repositories.get("bfun-ai/bfun-ai")?.baselineOnly, true);
  assert.equal(repositories.get("bfun-ai/bfun-ai")?.sourceTrust, "official_verified");
  assert.equal(DEFAULT_REPOSITORIES.some((entry) => /singularry/i.test(`${entry.repository} ${entry.launchpad}`)), false);

  const twitter = new Map(OFFICIAL_TWITTER_TARGETS.map((entry) => [entry.handle.toLowerCase(), entry]));
  assert.equal(twitter.get("eagleswaphq")?.baselineOnFirstSeen, true);
  assert.equal(twitter.get("1v1meme")?.baselineOnFirstSeen, true);
  assert.equal(twitter.get("bdotfun")?.baselineOnFirstSeen, true);
  assert.equal(twitter.get("singularryai")?.baselineOnFirstSeen, true);
  assert.equal(twitter.get("eagleswaphq")?.priority, false);
  assert.equal(twitter.get("1v1meme")?.priority, false);
  assert.equal(twitter.get("bdotfun")?.priority, false);
  assert.equal(twitter.get("bdotfun")?.twitter, "https://x.com/BdotFun");
  assert.equal(twitter.get("singularryai")?.priority, false);
  assert.equal(twitter.get("singularryai")?.twitter, "https://x.com/singularryai");

  const sites = new Map(BSC_DISCOVERY_SITE_TARGETS.map((entry) => [entry.id, entry]));
  assert.equal(sites.get("bsc-eaglefun")?.website, "https://eagleworld.fun");
  assert.equal(sites.get("bsc-onevone")?.website, "https://1v1me.me");
  assert.equal(sites.get("bsc-bnbs")?.website, "https://bnbs.meme");
  assert.equal(sites.get("bsc-bnbs")?.trackAssets, true);
  assert.equal(sites.has("bsc-bnbs-tax"), false, "the shared BNBS site must not be polled twice");
  assert.equal(sites.get("bsc-bfun")?.website, "https://b.fun");
  assert.equal(sites.get("bsc-bfun")?.twitter, "https://x.com/BdotFun");
  assert.equal(sites.get("bsc-bfun-docs")?.website, "https://docs.b.fun/for-developers/contracts-and-abi");
  assert.equal(sites.get("bsc-singularry")?.website, "https://launch.singularry.org");
  assert.equal(sites.get("bsc-singularry")?.twitter, "https://x.com/singularryai");
  assert.equal(sites.get("bsc-singularry-docs")?.website, "https://docs.singularry.org/launchpad/overview");

  const html = `
    <script src="/static/ai-launch-assistant.js?v=42"></script>
    <link href="/styles/tax-reflection.css" rel="stylesheet">
    <script src="/static/main.js"></script>
  `;
  assert.deepEqual(extractSiteSignals(html).assets, []);
  assert.deepEqual(extractSiteSignals(html, { trackAssets: true }).assets, [
    "/static/ai-launch-assistant.js?v=42",
    "/styles/tax-reflection.css",
  ]);
});
