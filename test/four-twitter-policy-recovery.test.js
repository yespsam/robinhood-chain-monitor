import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FOUR_TWITTER_POLICY_RECOVERY_SIGNAL_SHAPES,
  FOUR_TWITTER_POLICY_RECOVERY_SPECS,
  buildFourPolicyRecoveryEvent,
  isExpectedFourRecoverySignal,
  recoverFourTwitterPolicyFixes,
} from "../src/four-twitter-policy-recovery.js";
import {
  classifyFourMemeMarketCampaignCore,
  classifyFourMemeNamedModeCore,
} from "../src/source-controls.js";

const LISTA_TEXT = "Yield is now built into the launch.\n\nIntroducing ListaYield on http://Four.Meme — a new OpenFour mode powered by @lista_dao. \n\nEvery trade can route a share of trading tax into yield-bearing products, creating ongoing yield for eligible holders.\n\nAnd once the token graduates, liquidity moves to Lista DEX by default. 🧵";
const CAMPAIGN_TEXT = "bStocks szn just got competitive. 🟢\n\n150,000 USDT is now live with @AveaiGlobal × @BNBCHAIN — including a 50,000 USDT leaderboard exclusively for http://Four.Meme traders.\n\nTrade http://Four.Meme Stock Memes on http://Ave.ai.\nClimb the Top 500.\nTake your share.\n\nThe sprint is on. 🏁";
const NOW = Date.parse("2026-09-04T09:00:00.000Z");
const REAL_LISTA_OUTBOX_FIXTURE = JSON.parse(readFileSync(
  new URL("./fixtures/four-listayield-suppressed-outbox.json", import.meta.url),
  "utf8",
));

const project = Object.freeze({
  id: "fourmeme",
  name: "Four.meme",
  website: "https://four.meme",
  twitter: "https://x.com/fourdotmemezh",
  handle: "fourdotmemezh",
  xUserId: "1816036559864619011",
  match: "official_x",
  priority: true,
});

function tweetFor(spec, { exact = false, ...overrides } = {}) {
  const text = spec.kind === "named_mode" ? LISTA_TEXT : CAMPAIGN_TEXT;
  return {
    id: spec.tweetId,
    text,
    createdAt: spec.createdAt,
    authorName: "Four.meme-華語",
    handle: "fourdotmemezh",
    xUserId: "1816036559864619011",
    authorId: "1816036559864619011",
    url: `https://x.com/fourdotmemezh/status/${spec.tweetId}`,
    isReply: false,
    expandedUrls: spec.kind === "named_mode" ? ["http://Four.Meme"] : ["http://Four.Meme", "http://Ave.ai"],
    ...(exact ? {
      sourceVerifiedBy: "official_x_oembed",
      identityVerifiedBy: "fxtwitter_exact_numeric_id",
    } : {}),
    ...overrides,
  };
}

function initialOutbox({ lista = true } = {}) {
  const outbox = lista ? structuredClone(REAL_LISTA_OUTBOX_FIXTURE) : { version: 2, events: {} };
  return outbox;
}

function acceptedMarkerFor(spec) {
  return {
    status: "durably_accepted",
    tweetId: spec.tweetId,
    originalEventKey: spec.originalEventKey,
    derivedEventKey: spec.derivedEventKey,
  };
}

function stateWithListaSettled() {
  const [lista, campaign] = FOUR_TWITTER_POLICY_RECOVERY_SPECS;
  return {
    fourdotmemezh: { latestId: campaign.tweetId },
    _meta: {
      policyFixRecovery: {
        fourTwitterV1: {
          version: 1,
          recoverySet: "four-twitter-policy-fix-2026-09-v1",
          rolloutStartedAt: "2026-09-04T08:00:00.000Z",
          rolloutEndsAt: "2026-09-11T08:00:00.000Z",
          items: { [lista.tweetId]: acceptedMarkerFor(lista) },
        },
      },
    },
  };
}

function classifier(text) {
  if (text === LISTA_TEXT) return structuredClone(FOUR_TWITTER_POLICY_RECOVERY_SIGNAL_SHAPES.named_mode);
  if (text === CAMPAIGN_TEXT) return structuredClone(FOUR_TWITTER_POLICY_RECOVERY_SIGNAL_SHAPES.market_campaign);
  return { relevant: false, strong: false, labels: [], reason: "unexpected_fixture" };
}

function harness({
  outbox = initialOutbox(),
  state = { fourdotmemezh: { latestId: "2095713912188739967", checkedAt: "old" } },
  recentTweets = [tweetFor(FOUR_TWITTER_POLICY_RECOVERY_SPECS[1])],
  classifyTweetImpl = classifier,
  verifyExactTweetImpl = async (_project, _tweetId, sourceTweet) => tweetFor(
    FOUR_TWITTER_POLICY_RECOVERY_SPECS.find((spec) => spec.tweetId === sourceTweet.id),
    { exact: true },
  ),
  persistStateImpl = async () => {},
  now = () => NOW,
} = {}) {
  const sent = [];
  let loads = 0;
  const loadOutboxImpl = async () => {
    loads += 1;
    return outbox;
  };
  const sendAlertsImpl = async (_config, event) => {
    sent.push(event);
    const at = new Date(now()).toISOString();
    const preparedEvent = {
      ...event,
      canonicalSignalId: `fourmeme:policy-fix-recovery:x:${event.tweet.id}:v1`,
      canonicalSignalIds: [
        `fourmeme:policy-fix-recovery:x:${event.tweet.id}:v1`,
      ],
      freshness: {
        decision: "policy_fix_recovery",
        sourceOccurredAt: event.tweet.createdAt,
        discoveredAt: at,
        lagMs: now() - Date.parse(event.tweet.createdAt),
      },
      tradingPriority: {
        tier: "T2",
        hardGates: { t0Eligible: false, t1Eligible: false },
        plan: { automaticExecution: false },
      },
    };
    outbox.events[event.eventKey] = {
      id: event.eventKey,
      event: preparedEvent,
      eventType: event.type,
      status: "pending",
      destinations: { telegram: { status: "pending" } },
      createdAt: at,
      updatedAt: at,
      deliveryDisposition: {
        mode: "immediate",
        deliverImmediately: true,
        tier: "T2",
        reason: "four_twitter_policy_fix_recovery",
      },
    };
    return { status: "queued", eventId: event.eventKey };
  };
  const run = (overrides = {}) => recoverFourTwitterPolicyFixes({
    config: { dataDir: "/not-used" },
    project,
    state,
    recentTweets,
    classifyTweetImpl,
    verifyExactTweetImpl,
    sendAlertsImpl,
    persistStateImpl,
    loadOutboxImpl,
    now,
    ...overrides,
  });
  return { state, outbox, recentTweets, sent, run, loads: () => loads, sendAlertsImpl, loadOutboxImpl };
}

test("closed recovery list emits ListaYield then the one recent campaign, one deterministic event per cycle", async () => {
  const persisted = [];
  const setup = harness({ persistStateImpl: async (state, options) => persisted.push({ state: structuredClone(state), options }) });
  const cursorBefore = structuredClone(setup.state.fourdotmemezh);

  const first = await setup.run();
  assert.equal(first.status, "recovered");
  assert.deepEqual(first.recovered, [{
    tweetId: "2095361508700258731",
    eventKey: "twitter:fourdotmemezh:2095361508700258731:policy-fix-recovery:v1",
    reused: false,
  }]);
  assert.equal(setup.sent.length, 1);
  assert.equal(setup.sent[0].tweet.id, "2095361508700258731");
  assert.equal(setup.sent[0].tweet.text, LISTA_TEXT);
  assert.equal(setup.sent[0].policyFixRecovery.noChase, true);
  assert.equal(setup.sent[0].policyFixRecovery.automaticExecution, false);
  assert.deepEqual(setup.state.fourdotmemezh, cursorBefore, "policy recovery must never rewind or advance the normal Twitter cursor");

  const second = await setup.run();
  assert.equal(second.status, "recovered");
  assert.deepEqual(second.recovered.map(({ tweetId }) => tweetId), ["2095713912188739967"]);
  assert.equal(setup.sent.length, 2);
  assert.equal(setup.sent[1].tweet.id, "2095713912188739967");
  assert.equal(setup.sent[1].tweet.text, CAMPAIGN_TEXT);
  assert.equal(setup.sent[1].signal.marketCampaign.fourMemePrizeUsdt, 50000);

  const third = await setup.run();
  assert.equal(third.status, "complete");
  assert.equal(setup.sent.length, 2);
  assert.equal(setup.loads(), 4, "completed migration must short-circuit before reading the outbox again");
  assert.equal(persisted.length, 2);
  assert.ok(persisted.every(({ options }) => options.durable === true));
  const markers = setup.state._meta.policyFixRecovery.fourTwitterV1.items;
  assert.equal(markers["2095361508700258731"].status, "durably_accepted");
  assert.equal(markers["2095713912188739967"].status, "durably_accepted");
});

test("the production legacy ListaYield outbox shape recovers without an inner eventKey", async () => {
  const spec = FOUR_TWITTER_POLICY_RECOVERY_SPECS[0];
  const outbox = structuredClone(REAL_LISTA_OUTBOX_FIXTURE);
  assert.equal(outbox.events[spec.originalEventKey].event.eventKey, undefined);
  const setup = harness({ outbox, recentTweets: [] });
  const result = await setup.run();
  assert.equal(result.status, "recovered");
  assert.equal(setup.sent[0].eventKey, spec.derivedEventKey);
  assert.equal(setup.sent[0].originalEventKey, spec.originalEventKey);
});

test("a durable normal-producer campaign entry closes recovery without creating a derived duplicate", async () => {
  const campaign = FOUR_TWITTER_POLICY_RECOVERY_SPECS[1];
  const outbox = initialOutbox({ lista: false });
  outbox.events[campaign.originalEventKey] = {
    id: campaign.originalEventKey,
    status: "delivered",
    event: {
      type: "twitter_update",
      eventKey: campaign.originalEventKey,
      project,
      tweet: {
        ...tweetFor(campaign),
        sourceVerifiedBy: "official_x_oembed",
      },
      signal: classifier(CAMPAIGN_TEXT),
    },
  };
  const persisted = [];
  const setup = harness({
    state: stateWithListaSettled(),
    outbox,
    persistStateImpl: async (state) => persisted.push(structuredClone(state)),
  });
  const result = await setup.run();
  assert.equal(result.status, "complete");
  assert.equal(setup.sent.length, 0);
  assert.equal(persisted.length, 1);
  const marker = setup.state._meta.policyFixRecovery.fourTwitterV1.items[campaign.tweetId];
  assert.equal(marker.status, "already_covered");
  assert.equal(marker.coveredByEventKey, campaign.originalEventKey);
  assert.equal(marker.outboxStatus, "delivered");

  const loads = setup.loads();
  await setup.run();
  assert.equal(setup.loads(), loads, "already-covered is terminal and skips future outbox reads");
});

test("a suppressed original campaign is not coverage and still derives one recovery event", async () => {
  const campaign = FOUR_TWITTER_POLICY_RECOVERY_SPECS[1];
  const outbox = initialOutbox({ lista: false });
  outbox.events[campaign.originalEventKey] = {
    id: campaign.originalEventKey,
    status: "suppressed",
    event: {
      type: "twitter_update",
      project,
      tweet: {
        ...tweetFor(campaign),
        sourceVerifiedBy: "official_x_oembed",
      },
      signal: classifier(CAMPAIGN_TEXT),
    },
    destinations: { telegram: { status: "disabled", disabledReason: "policy_suppressed" } },
  };
  const setup = harness({ state: stateWithListaSettled(), outbox });
  const result = await setup.run();
  assert.equal(result.status, "recovered");
  assert.equal(setup.sent.length, 1);
  assert.equal(setup.sent[0].eventKey, campaign.derivedEventKey);
});

test("the deterministic classifier output must exactly match the expected structured recovery shape", () => {
  const [lista, campaign] = FOUR_TWITTER_POLICY_RECOVERY_SPECS;
  assert.equal(isExpectedFourRecoverySignal(lista, classifier(LISTA_TEXT)), true);
  assert.equal(isExpectedFourRecoverySignal(campaign, classifier(CAMPAIGN_TEXT)), true);

  const wrongLabels = classifier(LISTA_TEXT);
  wrongLabels.labels = [...wrongLabels.labels].reverse();
  assert.equal(isExpectedFourRecoverySignal(lista, wrongLabels), false);

  const wrongPrize = classifier(CAMPAIGN_TEXT);
  wrongPrize.marketCampaign.fourMemePrizeUsdt = 150000;
  assert.equal(isExpectedFourRecoverySignal(campaign, wrongPrize), false);
});

test("the production deterministic classifiers exactly recognize both immutable source texts", () => {
  const [lista, campaign] = FOUR_TWITTER_POLICY_RECOVERY_SPECS;
  assert.equal(isExpectedFourRecoverySignal(lista, classifyFourMemeNamedModeCore(LISTA_TEXT)), true);
  assert.equal(isExpectedFourRecoverySignal(campaign, classifyFourMemeMarketCampaignCore(CAMPAIGN_TEXT)), true);
});

test("derived event creation fails closed on an altered immutable tweet or a hand-authored signal", () => {
  const spec = FOUR_TWITTER_POLICY_RECOVERY_SPECS[1];
  const exact = tweetFor(spec, { exact: true });
  const signal = classifier(CAMPAIGN_TEXT);
  const recoveredAt = new Date(NOW).toISOString();
  const event = buildFourPolicyRecoveryEvent({ project, tweet: exact, signal, spec, recoveredAt });
  assert.equal(event.eventKey, spec.derivedEventKey);
  assert.equal(event.originalEventKey, spec.originalEventKey);
  assert.equal(event.tweet.id, spec.tweetId);
  assert.equal(event.policyFixRecovery.tweetTextSha256, spec.textSha256);

  assert.equal(buildFourPolicyRecoveryEvent({
    project,
    tweet: { ...exact, authorId: "999" },
    signal,
    spec,
    recoveredAt,
  }), null);
  assert.equal(buildFourPolicyRecoveryEvent({
    project,
    tweet: exact,
    signal: { ...signal, reason: "manually_bypassed" },
    spec,
    recoveredAt,
  }), null);
  assert.equal(buildFourPolicyRecoveryEvent({
    project,
    tweet: exact,
    signal,
    spec: { ...spec },
    recoveredAt,
  }), null, "only the module-owned frozen allowlist entry may authorize construction");
});

test("missing or altered bounded evidence never scans or replays another Four tweet", async (t) => {
  for (const [name, options] of [
    ["no suppressed Lista source and no campaign timeline item", { outbox: initialOutbox({ lista: false }), recentTweets: [] }],
    ["wrong suppression reason", { outbox: (() => {
      const value = initialOutbox();
      value.events[FOUR_TWITTER_POLICY_RECOVERY_SPECS[0].originalEventKey].destinations.telegram.disabledReason = "policy_suppressed";
      return value;
    })(), recentTweets: [] }],
    ["conflicting legacy inner event key", { outbox: (() => {
      const value = initialOutbox();
      value.events[FOUR_TWITTER_POLICY_RECOVERY_SPECS[0].originalEventKey].event.eventKey = "twitter:fourdotmemezh:wrong";
      return value;
    })(), recentTweets: [] }],
    ["unrelated newer timeline item", { outbox: initialOutbox({ lista: false }), recentTweets: [{ ...tweetFor(FOUR_TWITTER_POLICY_RECOVERY_SPECS[1]), id: "2099999999999999999", url: "https://x.com/fourdotmemezh/status/2099999999999999999" }] }],
    ["campaign URL mismatch", { outbox: initialOutbox({ lista: false }), recentTweets: [tweetFor(FOUR_TWITTER_POLICY_RECOVERY_SPECS[1], { url: "https://x.com/attacker/status/2095713912188739967" })] }],
    ["campaign text digest mismatch", { outbox: initialOutbox({ lista: false }), recentTweets: [tweetFor(FOUR_TWITTER_POLICY_RECOVERY_SPECS[1], { text: `${CAMPAIGN_TEXT}!` })] }],
  ]) {
    await t.test(name, async () => {
      let verified = 0;
      const setup = harness({
        ...options,
        verifyExactTweetImpl: async () => { verified += 1; throw new Error("must not verify ineligible evidence"); },
      });
      const result = await setup.run();
      assert.equal(result.status, "deferred");
      assert.equal(setup.sent.length, 0);
      assert.equal(verified, 0);
    });
  }
});

test("exact-status author, proof and digest mismatches fail closed without advancing recovery state", async (t) => {
  const cases = [
    { authorId: "999" },
    { sourceVerifiedBy: "untrusted_preview" },
    { identityVerifiedBy: "fxtwitter_timeline_only" },
    { text: `${LISTA_TEXT}\nchanged` },
  ];
  for (const mutation of cases) {
    await t.test(JSON.stringify(mutation), async () => {
      const setup = harness({
        recentTweets: [],
        verifyExactTweetImpl: async (_project, _tweetId, sourceTweet) => ({ ...tweetFor(FOUR_TWITTER_POLICY_RECOVERY_SPECS[0], { exact: true }), ...mutation, sourceTweet }),
      });
      const result = await setup.run();
      assert.equal(result.status, "deferred");
      assert.equal(setup.sent.length, 0);
      assert.equal(setup.state._meta.policyFixRecovery.fourTwitterV1.items[FOUR_TWITTER_POLICY_RECOVERY_SPECS[0].tweetId], undefined);
    });
  }
});

test("a classifier contract mismatch is deferred and cannot create an outbox entry", async () => {
  const setup = harness({
    recentTweets: [],
    classifyTweetImpl: () => ({ ...classifier(LISTA_TEXT), namedMode: { id: "openfour" } }),
  });
  const result = await setup.run();
  assert.equal(result.status, "deferred");
  assert.equal(result.deferred[0].reason, "deterministic_classifier_shape_mismatch");
  assert.equal(setup.sent.length, 0);
});

test("queued return without an exact durable outbox proof never records completion", async () => {
  const setup = harness({ recentTweets: [] });
  await assert.rejects(setup.run({
    sendAlertsImpl: async (_config, event) => ({ status: "queued", eventId: event.eventKey }),
  }), /outbox proof is missing/);
  assert.equal(setup.state._meta.policyFixRecovery.fourTwitterV1.items[FOUR_TWITTER_POLICY_RECOVERY_SPECS[0].tweetId], undefined);
});

test("an outbox-first crash retries the same key and reuses it without a second send", async () => {
  let persistAttempts = 0;
  const setup = harness({
    recentTweets: [],
    persistStateImpl: async () => {
      persistAttempts += 1;
      if (persistAttempts === 1) throw new Error("injected Twitter state fsync failure");
    },
  });
  await assert.rejects(setup.run(), /injected Twitter state fsync failure/);
  assert.equal(setup.sent.length, 1);
  assert.equal(setup.state._meta.policyFixRecovery.fourTwitterV1.items[FOUR_TWITTER_POLICY_RECOVERY_SPECS[0].tweetId], undefined);

  const retry = await setup.run();
  assert.equal(retry.status, "recovered");
  assert.equal(retry.recovered[0].reused, true);
  assert.equal(setup.sent.length, 1, "the durable derived outbox key is the exact-once authority");
  assert.equal(setup.state._meta.policyFixRecovery.fourTwitterV1.items[FOUR_TWITTER_POLICY_RECOVERY_SPECS[0].tweetId].status, "durably_accepted");
});

test("a pre-deadline enqueue is recovered from the exact outbox key even when state resumes after the deadline", async () => {
  const setup = harness({ recentTweets: [] });
  await assert.rejects(setup.run({
    persistStateImpl: async () => { throw new Error("crash after enqueue"); },
  }), /crash after enqueue/);
  assert.equal(setup.sent.length, 1);

  const resumed = await setup.run({
    now: () => Date.parse("2026-09-12T00:00:00.000Z"),
    persistStateImpl: async () => {},
  });
  assert.equal(resumed.status, "recovered");
  assert.equal(resumed.recovered[0].reused, true);
  assert.equal(setup.sent.length, 1);
  assert.equal(setup.state._meta.policyFixRecovery.fourTwitterV1.items["2095361508700258731"].status, "durably_accepted");
});

test("an incompatible existing derived key fails closed instead of overwriting it", async () => {
  const spec = FOUR_TWITTER_POLICY_RECOVERY_SPECS[0];
  const outbox = initialOutbox();
  outbox.events[spec.derivedEventKey] = {
    id: spec.derivedEventKey,
    status: "delivered",
    event: { eventKey: spec.derivedEventKey, tweet: { id: "999" } },
  };
  const setup = harness({ outbox, recentTweets: [] });
  await assert.rejects(setup.run(), /incompatible or non-durable derived recovery outbox entry/);
  assert.equal(setup.sent.length, 0);
});

test("a derived outbox row without the exact recovery novelty key is not accepted", async () => {
  const spec = FOUR_TWITTER_POLICY_RECOVERY_SPECS[0];
  const setup = harness({ recentTweets: [] });
  await setup.run();
  delete setup.state._meta.policyFixRecovery.fourTwitterV1.items[spec.tweetId];
  setup.outbox.events[spec.derivedEventKey].event.canonicalSignalIds = ["fourmeme:concept:openfour"];
  await assert.rejects(setup.run(), /incompatible or non-durable derived recovery outbox entry/);
  assert.equal(setup.sent.length, 1);
});

test("a malformed or unknown outbox schema fails closed", async () => {
  const setup = harness({ outbox: { version: 3, events: {} } });
  await assert.rejects(setup.run(), /invalid alert outbox/);
  assert.equal(setup.sent.length, 0);
});

test("source-age and rollout deadlines become durable audit markers and never enqueue stale history", async () => {
  const state = { fourdotmemezh: { latestId: "2095713912188739967" } };
  const persisted = [];
  const setup = harness({
    state,
    now: () => Date.parse("2026-09-12T00:00:00.000Z"),
    persistStateImpl: async (next) => persisted.push(structuredClone(next)),
  });
  const result = await setup.run();
  assert.equal(result.status, "complete");
  assert.equal(setup.sent.length, 0);
  assert.equal(persisted.length, 2);
  const markers = state._meta.policyFixRecovery.fourTwitterV1.items;
  assert.equal(markers["2095361508700258731"].status, "expired");
  assert.equal(markers["2095713912188739967"].status, "expired");
  assert.equal(markers["2095713912188739967"].reason, "rollout_window_closed");
});

test("campaign recovery closes 48 hours after source time even while the rollout remains open", async () => {
  const [lista, campaign] = FOUR_TWITTER_POLICY_RECOVERY_SPECS;
  const state = {
    fourdotmemezh: { latestId: campaign.tweetId },
    _meta: {
      policyFixRecovery: {
        fourTwitterV1: {
          version: 1,
          recoverySet: "four-twitter-policy-fix-2026-09-v1",
          rolloutStartedAt: "2026-09-04T08:00:00.000Z",
          rolloutEndsAt: "2026-09-11T08:00:00.000Z",
          items: {
            [lista.tweetId]: {
              status: "durably_accepted",
              tweetId: lista.tweetId,
              originalEventKey: lista.originalEventKey,
              derivedEventKey: lista.derivedEventKey,
            },
          },
        },
      },
    },
  };
  const setup = harness({
    state,
    outbox: initialOutbox({ lista: false }),
    now: () => Date.parse("2026-09-06T03:21:47.001Z"),
  });
  const result = await setup.run();
  assert.equal(result.status, "complete");
  assert.equal(setup.sent.length, 0);
  assert.equal(state._meta.policyFixRecovery.fourTwitterV1.items[campaign.tweetId].status, "expired");
  assert.equal(state._meta.policyFixRecovery.fourTwitterV1.items[campaign.tweetId].reason, "source_age_window_closed");
});

test("recovery is inert for a lookalike project and before the rollout begins", async () => {
  const state = { fourdotmemezh: { latestId: "1" } };
  const setup = harness({ state });
  const wrongProject = await setup.run({ project: { ...project, xUserId: "999" } });
  assert.equal(wrongProject.status, "not_applicable");
  assert.equal(state._meta, undefined);

  const before = await setup.run({ now: () => Date.parse("2026-09-04T07:59:59.999Z") });
  assert.equal(before.status, "not_started");
  assert.equal(state._meta, undefined);
  assert.equal(setup.sent.length, 0);
});
