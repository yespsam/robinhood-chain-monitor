import test from "node:test";
import assert from "node:assert/strict";

import { buildNarrativeSniperDemo } from "../scripts/narrative-sniper-demo.js";

const QUOTE_CA = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const TARGET_CA = "0xa11ce00000000000000000000000000000000001";

test("candidate demo keeps the narrative asset separate from the tradable token", () => {
  const result = buildNarrativeSniperDemo("candidate");
  assert.equal(result.signal.decision, "do");
  assert.equal(result.signal.target.ca, TARGET_CA);
  assert.equal(result.signal.target.context.ca, QUOTE_CA);
  assert.equal(result.signal.shadowOrder.ca, TARGET_CA);
  assert.notEqual(result.signal.shadowOrder.ca, result.signal.target.context.ca);
  assert.equal(result.signal.shadowOrder.executable, false);
  assert.match(result.alertText, /JENSEN/u);
  assert.match(result.alertText, /结果：符合策略｜评分/u);
  assert.match(result.alertText, /目标 CA：0xa11ce00000000000000000000000000000000001/u);
  assert.match(result.alertText, /时间：.*CST/u);
  assert.doesNotMatch(result.alertText, /风险|risk|失效|invalidation|影子|shadow|签名|signing|广播|broadcast|不做|do not trade|not a buy/iu);
  assert.ok(result.alertText.split("\n").every((line) => line.length <= 150));
});

test("watch and reject demos never create a shadow order", () => {
  const watch = buildNarrativeSniperDemo("watch");
  const reject = buildNarrativeSniperDemo("reject");
  assert.equal(watch.signal.decision, "watch");
  assert.equal(watch.signal.shadowOrder, null);
  assert.equal(reject.signal.decision, "reject");
  assert.equal(reject.signal.shadowOrder, null);
  assert.ok(reject.signal.hardBlocks.some((block) => block.code === "cannot_sell"));
});

test("the same demo evidence produces byte-stable decisions and cards", () => {
  const first = buildNarrativeSniperDemo("candidate");
  const second = buildNarrativeSniperDemo("candidate");
  assert.equal(first.signal.inputHash, second.signal.inputHash);
  assert.equal(first.signal.decisionHash, second.signal.decisionHash);
  assert.equal(first.alertText, second.alertText);
  assert.throws(() => buildNarrativeSniperDemo("live"), /scenario must/u);
});
