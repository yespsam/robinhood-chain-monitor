import test from "node:test";
import assert from "node:assert/strict";
import { targetList } from "../src/twitter-monitor.js";

function generalTwitterConfig(overrides = {}) {
  return {
    twitterMonitorEnabled: true,
    binanceCriticalXMonitorEnabled: false,
    focusCriticalXMonitorEnabled: false,
    ponMonitorEnabled: false,
    fomoCallEnabled: false,
    ...overrides,
  };
}

function targetByHandle(targets, handle) {
  return targets.find((target) => target.handle.toLowerCase() === handle.toLowerCase());
}

test("general X monitoring overlays enabled Four and Flap critical profiles after handle deduplication", () => {
  const targets = targetList([
    {
      id: "duplicate-flap",
      name: "Duplicate Flap",
      twitter: "https://x.com/flapdotsh",
      priority: false,
      backfillOnFirstSeen: true,
    },
    {
      id: "legacy-four",
      name: "Legacy Four",
      twitter: "https://x.com/four_meme_",
      priority: true,
    },
  ], {
    flap: {
      signals: {
        socials: ["https://x.com/flapdotsh", "https://x.com/four_meme_"],
      },
    },
  }, generalTwitterConfig({ focusCriticalXMonitorEnabled: true }));

  const handles = targets.map((target) => target.handle.toLowerCase());
  assert.equal(handles.filter((handle) => handle === "flapdotsh").length, 1);
  assert.equal(handles.filter((handle) => handle === "fourdotmemezh").length, 1);
  assert.equal(handles.includes("four_meme_"), false, "the disabled legacy Four handle must stay excluded");

  for (const handle of ["flapdotsh", "fourdotmemezh"]) {
    const target = targetByHandle(targets, handle);
    assert.ok(target);
    assert.equal(target.criticalFastLane, true);
    assert.equal(target.criticalProfile, "focus_launchpad");
    assert.equal(target.priority, true);
    assert.equal(target.baselineOnFirstSeen, true);
    assert.equal(target.backfillOnFirstSeen, false);
  }
});

test("disabled focus critical switch preserves ordinary Four and Flap target behavior", () => {
  const targets = targetList([], {}, generalTwitterConfig());

  for (const handle of ["flapdotsh", "fourdotmemezh"]) {
    const target = targetByHandle(targets, handle);
    assert.ok(target);
    assert.notEqual(target.criticalFastLane, true);
    assert.equal(target.criticalProfile, undefined);
    assert.equal(target.priority, true);
    assert.equal(target.backfillOnFirstSeen, true);
  }
});

test("general X monitoring retains every enabled existing critical profile without changing AI targets", () => {
  const targets = targetList([], {}, generalTwitterConfig({
    binanceCriticalXMonitorEnabled: true,
    focusCriticalXMonitorEnabled: true,
    ponMonitorEnabled: true,
  }));
  const expectedProfiles = new Map([
    ["binance", "binance_product"],
    ["binancewallet", "binance_product"],
    ["flapdotsh", "focus_launchpad"],
    ["fourdotmemezh", "focus_launchpad"],
    ["pondotfun", "pon_fun"],
  ]);

  for (const [handle, profile] of expectedProfiles) {
    const matches = targets.filter((target) => target.handle.toLowerCase() === handle);
    assert.equal(matches.length, 1, `@${handle} must be deduplicated`);
    assert.equal(matches[0].criticalFastLane, true);
    assert.equal(matches[0].criticalProfile, profile);
    assert.equal(matches[0].priority, true);
    assert.equal(matches[0].baselineOnFirstSeen, true);
    assert.equal(matches[0].backfillOnFirstSeen, false);
  }

  for (const handle of ["x", "spacexai", "grok", "api"]) {
    const target = targetByHandle(targets, handle);
    assert.ok(target);
    assert.equal(target.signalProfile, "ai");
    assert.notEqual(target.criticalFastLane, true);
    assert.equal(target.priority, true);
    assert.equal(target.baselineOnFirstSeen, true);
  }
});
