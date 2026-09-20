import test from "node:test";
import assert from "node:assert/strict";
import {
  CAPITAL_KOL_CATALOG_HASH,
  CAPITAL_KOL_CATALOG_PUBLISHED_AT,
  CAPITAL_KOL_CATALOG_VERSION,
  CAPITAL_KOL_CATEGORIES,
  bindCapitalKolRuntimeIdentity,
  capitalKolCatalogFreshness,
  createCapitalKolEventSnapshot,
  findReviewedCapitalKolByHandle,
  findReviewedCapitalKolByXUserId,
  getCapitalKolCatalogManifest,
  listReviewedCapitalKols,
  validateCapitalKolCatalog,
  verifyCapitalKolCatalogIntegrity,
  verifyCapitalKolEventSnapshot,
} from "../src/capital-kol-catalog.js";

const NOW = Date.parse(CAPITAL_KOL_CATALOG_PUBLISHED_AT) + 47_000;
const ADDED_HANDLES = [
  "haydenzadams",
  "StaniKulechov",
  "IOHK_Charles",
  "SergeyNazarov",
  "el33th4xor",
  "tyler",
  "cameron",
  "kris",
  "bhorowitz",
  "dan_pantera",
  "veradittakit",
  "hosseeb",
  "KyleSamani",
  "sundarpichai",
  "LisaSu",
  "DarioAmodei",
  "ajassy",
  "Benioff",
  "BillAckman",
  "TruthGundlach",
];

function observation(overrides = {}) {
  return {
    subjectType: "person",
    handle: "VitalikButerin",
    observedHandle: "VitalikButerin",
    xUserId: "295218901",
    canonicalName: "Vitalik Buterin",
    profileUrl: "https://x.com/VitalikButerin",
    source: "fxtwitter_public_profile",
    observedAt: CAPITAL_KOL_CATALOG_PUBLISHED_AT,
    followers: 7_793_196,
    ...overrides,
  };
}

test("reviewed seed covers all broad capital leader categories with pinned X ids", () => {
  const entries = listReviewedCapitalKols();
  assert.equal(entries.length, 30);
  assert.deepEqual(new Set(entries.map((entry) => entry.category)), new Set(CAPITAL_KOL_CATEGORIES));
  assert.equal(new Set(entries.map((entry) => entry.id)).size, 30);
  assert.equal(new Set(entries.map((entry) => entry.handle.toLowerCase())).size, 30);
  assert.equal(new Set(entries.map((entry) => entry.expectedXUserId)).size, 30);
  assert.deepEqual(ADDED_HANDLES.filter((handle) => !findReviewedCapitalKolByHandle(handle)), []);
  for (const entry of entries) {
    assert.match(entry.handle, /^[A-Za-z0-9_]{1,15}$/u);
    assert.match(entry.expectedXUserId, /^[1-9]\d{0,20}$/u);
    assert.equal(entry.subjectType, "person");
    assert.ok(entry.background.zh);
    assert.ok(entry.background.en);
    assert.equal(entry.review.status, "reviewed");
    assert.equal("followers" in entry, false);
  }
});

test("catalog exposes deterministic versioned manifest and integrity result", () => {
  const manifest = getCapitalKolCatalogManifest();
  assert.equal(manifest.version, CAPITAL_KOL_CATALOG_VERSION);
  assert.equal(manifest.hash, CAPITAL_KOL_CATALOG_HASH);
  assert.equal(manifest.count, 30);
  assert.equal(manifest.publishedAt, CAPITAL_KOL_CATALOG_PUBLISHED_AT);
  assert.match(manifest.hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(manifest.followersPolicy, "display_only");
  assert.equal(verifyCapitalKolCatalogIntegrity().valid, true);
  assert.equal(validateCapitalKolCatalog().valid, true);
});

test("all expanded reviewed identities bind only to their pinned numeric X ids", () => {
  for (const handle of ADDED_HANDLES) {
    const entry = findReviewedCapitalKolByHandle(handle);
    const exact = bindCapitalKolRuntimeIdentity({
      subjectType: "person",
      handle: entry.handle,
      observedHandle: entry.handle,
      xUserId: entry.expectedXUserId,
      canonicalName: entry.canonicalName,
      profileUrl: `https://x.com/${entry.handle}`,
      source: "fxtwitter_public_profile",
      observedAt: CAPITAL_KOL_CATALOG_PUBLISHED_AT,
      followers: 0,
    }, { nowMs: NOW });
    assert.equal(exact.status, "admitted", `@${entry.handle} should bind`);
    assert.equal(exact.monitorEligible, true);
    assert.equal(exact.identityKey, `capital-kol:x:${entry.expectedXUserId}`);
    assert.equal(exact.snapshot.catalogId, entry.id);

    const wrongId = bindCapitalKolRuntimeIdentity({
      subjectType: "person",
      handle: entry.handle,
      observedHandle: entry.handle,
      xUserId: "1",
      canonicalName: entry.canonicalName,
      profileUrl: `https://x.com/${entry.handle}`,
      source: "fxtwitter_public_profile",
      observedAt: CAPITAL_KOL_CATALOG_PUBLISHED_AT,
    }, { nowMs: NOW });
    assert.equal(wrongId.status, "quarantined");
    assert.equal(wrongId.reason, "expected_x_user_id_mismatch");
  }
});

test("lookups are exact and case-insensitive for X handles but never fuzzy", () => {
  assert.equal(findReviewedCapitalKolByHandle("@VITALIKBUTERIN")?.expectedXUserId, "295218901");
  assert.equal(findReviewedCapitalKolByXUserId("1605")?.handle, "sama");
  assert.equal(findReviewedCapitalKolByHandle("vitalik_buterin"), null);
  assert.equal(findReviewedCapitalKolByHandle("VitalikButerin1"), null);
  assert.equal(findReviewedCapitalKolByXUserId("0"), null);
});

test("unknown dynamic candidates and mismatched pinned ids stay quarantined", () => {
  const unknown = bindCapitalKolRuntimeIdentity(observation({
    handle: "new_whale",
    observedHandle: "new_whale",
    xUserId: "999999999",
    profileUrl: "https://x.com/new_whale",
  }), { nowMs: NOW });
  assert.equal(unknown.status, "quarantined");
  assert.equal(unknown.reason, "unknown_handle");
  assert.equal(unknown.monitorEligible, false);

  const takeover = bindCapitalKolRuntimeIdentity(observation({ xUserId: "999999999" }), { nowMs: NOW });
  assert.equal(takeover.status, "quarantined");
  assert.equal(takeover.reason, "expected_x_user_id_mismatch");
});

test("fresh exact handle and numeric X id bind to an immutable event snapshot", () => {
  const result = bindCapitalKolRuntimeIdentity(observation(), { nowMs: NOW });
  assert.equal(result.status, "admitted");
  assert.equal(result.monitorEligible, true);
  assert.equal(result.identityKey, "capital-kol:x:295218901");
  assert.equal(result.display.followers, 7_793_196);
  assert.equal(result.display.policy, "display_only");
  assert.equal(result.snapshot.catalogHash, CAPITAL_KOL_CATALOG_HASH);
  assert.equal(Object.isFrozen(result.snapshot), true);
  assert.equal(Object.isFrozen(result.snapshot.background), true);
});

test("followers are display-only and cannot change admission or identity", () => {
  const low = bindCapitalKolRuntimeIdentity(observation({ followers: 0 }), { nowMs: NOW });
  const high = bindCapitalKolRuntimeIdentity(observation({ followers: 999_999_999 }), { nowMs: NOW });
  assert.equal(low.status, high.status);
  assert.equal(low.reason, high.reason);
  assert.equal(low.identityKey, high.identityKey);
  assert.deepEqual(low.snapshot, high.snapshot);
  assert.notEqual(low.display.followers, high.display.followers);
  assert.equal("score" in low, false);
});

test("runtime binding rejects handle, URL, source, name, and freshness conflicts", () => {
  const cases = [
    [observation({ observedHandle: "vitalik_buterin" }), "observed_handle_mismatch"],
    [observation({ profileUrl: "https://x.com/sama" }), "profile_url_mismatch"],
    [observation({ source: "untrusted_scraper" }), "identity_source_not_admitted"],
    [observation({ canonicalName: "Someone Else" }), "canonical_name_mismatch"],
    [observation({ subjectType: "institution" }), "institution_not_person"],
    [observation({ observedAt: "2026-09-01T00:00:00.000Z" }), "identity_observation_stale_or_invalid"],
  ];
  for (const [candidate, reason] of cases) {
    assert.equal(bindCapitalKolRuntimeIdentity(candidate, { nowMs: NOW }).reason, reason);
  }
});

test("catalog freshness expires closed", () => {
  assert.equal(capitalKolCatalogFreshness({ nowMs: NOW }).valid, true);
  assert.equal(capitalKolCatalogFreshness({
    nowMs: Date.parse("2027-09-06T07:00:00.000Z"),
    maximumAgeMs: 180 * 86_400_000,
  }).valid, false);
});

test("event verifier requires exact handle, id, bilingual background, and evidence", () => {
  const snapshot = createCapitalKolEventSnapshot("VitalikButerin");
  const event = {
    caller: {
      handle: "VitalikButerin",
      xProfileId: "295218901",
      capitalKolSnapshot: snapshot,
      followers: 7_793_196,
    },
    tweet: {
      handle: "VitalikButerin",
      xUserId: "295218901",
      authorId: "295218901",
    },
  };
  assert.deepEqual(verifyCapitalKolEventSnapshot(event), {
    valid: true,
    reasons: [],
    entry: findReviewedCapitalKolByHandle("VitalikButerin"),
  });

  const wrongId = structuredClone(event);
  wrongId.tweet.authorId = "1605";
  assert.equal(verifyCapitalKolEventSnapshot(wrongId).valid, false);
  assert.ok(verifyCapitalKolEventSnapshot(wrongId).reasons.includes("event_x_user_id_mismatch"));

  const wrongBackground = structuredClone(event);
  wrongBackground.caller.capitalKolSnapshot.background.zh = "被篡改的背景";
  assert.equal(verifyCapitalKolEventSnapshot(wrongBackground).valid, false);
  assert.ok(verifyCapitalKolEventSnapshot(wrongBackground).reasons.includes("background_mismatch"));

  const wrongEvidence = structuredClone(event);
  wrongEvidence.caller.capitalKolSnapshot.backgroundEvidence[0].url = "https://evil.example/profile";
  assert.equal(verifyCapitalKolEventSnapshot(wrongEvidence).valid, false);
  assert.ok(verifyCapitalKolEventSnapshot(wrongEvidence).reasons.includes("background_evidence_mismatch"));
});

test("catalog validator rejects follower identity data and missing pinned ids", () => {
  const entries = structuredClone(listReviewedCapitalKols());
  entries[0].followers = 1_000_000;
  entries[1].expectedXUserId = null;
  const result = validateCapitalKolCatalog(entries);
  assert.equal(result.valid, false);
  assert.ok(result.reasons.some((reason) => reason.endsWith("followers_must_not_be_catalog_identity_data")));
  assert.ok(result.reasons.some((reason) => reason.endsWith("missing_or_invalid_expected_x_user_id")));
});
