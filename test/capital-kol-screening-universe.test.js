import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  CAPITAL_KOL_SCREENING_POLICY,
  CAPITAL_KOL_SCREENING_TARGET_COUNT,
  EXPECTED_CAPITAL_KOL_SCREENING_HASH,
  findCapitalKolScreeningCandidate,
  getCapitalKolScreeningManifest,
  listCapitalKolScreeningCandidates,
  screenCapitalKolCandidates,
  verifyCapitalKolScreeningUniverseIntegrity,
} from "../src/capital-kol-screening-universe.js";
import { listReviewedCapitalKols } from "../src/capital-kol-catalog.js";

const NOW = Date.parse("2026-09-06T18:45:00.000Z");

test("capital KOL screening universe is an integrity-locked 500-account candidate pool", () => {
  const integrity = verifyCapitalKolScreeningUniverseIntegrity();
  assert.equal(integrity.valid, true, integrity.reasons.join(","));
  assert.equal(integrity.count, 500);
  assert.equal(integrity.actualHash, EXPECTED_CAPITAL_KOL_SCREENING_HASH);

  const candidates = listCapitalKolScreeningCandidates();
  assert.equal(candidates.length, CAPITAL_KOL_SCREENING_TARGET_COUNT);
  assert.equal(new Set(candidates.map((candidate) => candidate.handleKey)).size, 500);
  assert.equal(new Set(candidates.map((candidate) => candidate.candidateId)).size, 500);
  assert.ok(candidates.every((candidate) => candidate.candidateMonitoringEligible === false));
  assert.ok(candidates.every((candidate) => candidate.automaticPromotion === false));
  assert.ok(candidates.every((candidate) => !Object.hasOwn(candidate, "followers")));
  assert.ok(Object.isFrozen(candidates[0]));
});

test("candidate manifest preserves discovery provenance without treating it as identity evidence", () => {
  const manifest = getCapitalKolScreeningManifest();
  assert.equal(manifest.count, 500);
  assert.equal(manifest.targetCount, 500);
  assert.equal(manifest.hash, EXPECTED_CAPITAL_KOL_SCREENING_HASH);
  assert.equal(manifest.sources.crypto_twitter_favorites_2025.authority, "discovery_only");
  assert.equal(manifest.sources.legacy_investor_backfill.authority, "discovery_only_stale");
  assert.equal(manifest.policy.automaticPromotion, false);
  assert.equal(manifest.policy.followersAffectTrading, false);
  assert.ok(manifest.bySource.reviewed_priority >= 30);
});

test("reviewed runtime catalog is joined explicitly while candidate capability stays disabled", () => {
  const report = screenCapitalKolCandidates({ nowMs: NOW });
  assert.equal(report.status, "complete");
  assert.equal(report.counts.total, 500);
  assert.equal(report.counts.reviewed, listReviewedCapitalKols().length);
  assert.equal(report.reviewedCatalog.runtimeAdmissionIsSeparate, true);

  const vitalik = report.results.find((result) => result.handle.toLowerCase() === "vitalikbuterin");
  assert.equal(vitalik.disposition, "manual_reviewed_runtime_catalog");
  assert.equal(vitalik.candidateMonitoringEligible, false);
  assert.equal(vitalik.runtimeAdmissionSource, "capital-kol-catalog");
});

test("a huge follower count can prioritize review but can never auto-promote a candidate", () => {
  const candidate = findCapitalKolScreeningCandidate("APompliano");
  assert.ok(candidate);
  const report = screenCapitalKolCandidates({
    nowMs: NOW,
    profileObservations: [{
      handle: candidate.handle,
      id: "339061487",
      subjectType: "person",
      followers: 250_000_000,
      protected: false,
      observedAt: "2026-09-06T18:44:00.000Z",
    }],
  });
  const result = report.results.find((entry) => entry.candidateId === candidate.candidateId);
  assert.equal(result.disposition, "identity_corroborated_role_review_required");
  assert.equal(result.followers, 250_000_000);
  assert.equal(result.candidateMonitoringEligible, false);
  assert.equal(result.runtimeAdmissionSource, null);
});

test("conflicting, stale, institution, and disqualified observations fail closed", () => {
  const report = screenCapitalKolCandidates({
    nowMs: NOW,
    profileObservations: [
      { handle: "APompliano", id: "1", subjectType: "organization", observedAt: "2026-09-06T18:44:00.000Z" },
      { handle: "balajis", id: "2", subjectType: "person", observedAt: "2020-01-01T00:00:00.000Z" },
      { handle: "cburniske", id: "3", subjectType: "person", observedAt: "2026-09-06T18:44:00.000Z" },
      { handle: "cburniske", id: "4", subjectType: "person", observedAt: "2026-09-06T18:44:00.000Z" },
    ],
  });
  for (const handle of ["APompliano", "balajis", "cburniske", "SBF_FTX", "cointelegraph"]) {
    const result = report.results.find((entry) => entry.handle.toLowerCase() === handle.toLowerCase());
    assert.equal(result.disposition, "quarantined", `${handle}: ${JSON.stringify(result)}`);
    assert.equal(result.candidateMonitoringEligible, false);
  }
});

test("candidate module has no network, alert, ledger, signer, or execution capability", () => {
  const source = fs.readFileSync(new URL("../src/capital-kol-screening-universe.js", import.meta.url), "utf8");
  for (const forbidden of [
    /\bfetch\s*\(/u,
    /\bsendAlerts\b/u,
    /\.admit\s*\(/u,
    /\.open\s*\(/u,
    /\bsigner\b/u,
    /\bsendTransaction\b/u,
    /\bbroadcastTransaction\b/u,
    /\bswap\s*\(/u,
  ]) {
    assert.equal(forbidden.test(source), false, String(forbidden));
  }
  assert.equal(CAPITAL_KOL_SCREENING_POLICY.candidateMonitoringEligible, false);
});

test("a response for another handle stays bound to the requested candidate and is quarantined", () => {
  const requested = findCapitalKolScreeningCandidate("APompliano");
  const returned = findCapitalKolScreeningCandidate("balajis");
  const report = screenCapitalKolCandidates({ nowMs: NOW, profileObservations: [{
    candidateId: requested.candidateId, handle: returned.handle,
    id: "339061487", observedAt: new Date(NOW).toISOString(), subjectType: "person",
  }] });
  const a = report.results.find((row) => row.candidateId === requested.candidateId);
  const b = report.results.find((row) => row.candidateId === returned.candidateId);
  assert.equal(a.disposition, "quarantined");
  assert.ok(a.reasons.includes("profile_handle_mismatch"));
  assert.equal(b.disposition, "awaiting_identity_and_role_review");
});

test("numeric X identity collisions and unsafe integer IDs cannot become identity-ready", () => {
  const pinned = listReviewedCapitalKols()[0];
  const report = screenCapitalKolCandidates({ nowMs: NOW, profileObservations: [
    { handle: "APompliano", id: "777777777", subjectType: "person", observedAt: new Date(NOW).toISOString() },
    { handle: "balajis", id: "777777777", subjectType: "person", observedAt: new Date(NOW).toISOString() },
    { handle: "cburniske", id: pinned.expectedXUserId, subjectType: "person", observedAt: new Date(NOW).toISOString() },
    { handle: "adam3us", id: Number.MAX_SAFE_INTEGER + 10, subjectType: "person", observedAt: new Date(NOW).toISOString() },
  ] });
  for (const handle of ["APompliano", "balajis", "cburniske"]) {
    const row = report.results.find((entry) => entry.handle.toLowerCase() === handle.toLowerCase());
    assert.equal(row.disposition, "quarantined", handle);
    assert.ok(row.reasons.includes("numeric_x_user_id_shared_by_handles"), handle);
  }
  assert.ok(report.results.find((entry) => entry.handle.toLowerCase() === "adam3us")
    .reasons.includes("numeric_x_user_id_precision_lost"));
  assert.equal(report.counts.reviewed, listReviewedCapitalKols().length);
  assert.equal(report.progress.manualReviewComplete, false);
  assert.equal(report.progress.manualReviewRemaining, 500 - listReviewedCapitalKols().length);
  assert.equal(report.progress.identityReadyIsNotRuntimeAdmission, true);
});
