import test from "node:test";
import assert from "node:assert/strict";
import { renderNarrativeTradeSignalText } from "../src/narrative-trade-alert.js";
import {
  buildBilingualAlertBundle,
  renderBilingualTelegramText,
} from "../src/bilingual-alert-renderer.js";
import { alertEventKey, isRelevantAlert, isStrongAlert } from "../src/alerts.js";
import { isMonitoringSourceEnabled } from "../src/source-controls.js";
import { buildNarrativeSniperDemo } from "../scripts/narrative-sniper-demo.js";
import {
  NARRATIVE_TRADE_SIGNAL_SCHEMA,
  NARRATIVE_TRADE_SIGNAL_VERSION,
} from "../src/narrative-trade-signal.js";

const TOKEN = "0x2222222222222222222222222222222222222222";
const POOL = "0x3333333333333333333333333333333333333333";

function signal(overrides = {}) {
  return {
    version: NARRATIVE_TRADE_SIGNAL_VERSION,
    schema: NARRATIVE_TRADE_SIGNAL_SCHEMA,
    deterministic: true,
    decision: "do",
    score: 82,
    asOf: "2026-09-06T08:00:00.000Z",
    event: {
      platform: "Flap",
      zh: "NVIDIA 叙事底池出现首个可交易代币",
      en: "First tradable token appeared in the NVIDIA-narrative pool",
    },
    mechanism: {
      zh: "AI 算力关注度流向 NVIDIA 主题新币",
      en: "AI-compute attention may flow into the NVIDIA-themed launch",
    },
    target: {
      chainId: 56,
      ca: TOKEN,
      poolAddress: POOL,
      address: TOKEN,
      zh: "JENSEN｜官方 Portal 创建",
      en: "JENSEN | created by the official Portal",
    },
    confirmation: {
      zh: "精确 CA、安全门、流动性与真实卖出已确认",
      en: "Exact CA, safety, liquidity, and observed selling confirmed",
    },
    execution: {
      zh: "只记录影子入场，等待回测",
      en: "Record a shadow entry only and await evaluation",
    },
    risk: {
      zh: "新闻过期、流动性下降或卖出失败即失效",
      en: "Invalid if the catalyst stales, liquidity falls, or selling fails",
    },
    hardBlocks: [],
    shadowOrder: { mode: "shadow", executable: false, side: "buy", chainId: 56, ca: TOKEN, poolAddress: POOL },
    ...overrides,
  };
}

test("narrative result renders one bounded pure-fact bilingual card with the exact CA", () => {
  const input = signal();
  const original = structuredClone(input);
  const rendered = renderNarrativeTradeSignalText(input);
  const lines = rendered.split("\n");
  assert.match(rendered, /平台：Flap｜AI 叙事分析/u);
  assert.match(rendered, /Platform: Flap \| AI narrative analysis/u);
  assert.match(rendered, /结果：符合策略｜评分 82\/100/u);
  assert.match(rendered, /Result: Strategy match \| score 82\/100/u);
  assert.match(rendered, /时间：09-06 16:00 CST/u);
  assert.match(rendered, /Time: 09-06 16:00 CST/u);
  assert.equal(rendered.match(new RegExp(TOKEN, "g"))?.length, 2);
  assert.equal(lines.filter(Boolean).length, 17);
  assert.ok(lines.every((line) => line.length <= 150), lines.join("\n"));
  assert.doesNotMatch(rendered, /风险|risk|失效|invalidation|影子|shadow|签名|signing|广播|broadcast|不做|do not trade|not a buy/iu);
  assert.deepEqual(input, original, "rendering must not mutate the complete internal signal");
});

test("rejected signal shows only its result and keeps hard blocks internal", () => {
  const input = signal({
    decision: "reject",
    score: 91,
    shadowOrder: null,
    hardBlocks: [{ code: "SELLABILITY_UNVERIFIED", zh: "可卖性未核验", en: "Sellability is unverified" }],
  });
  const original = structuredClone(input);
  const rendered = renderNarrativeTradeSignalText(input);
  assert.match(rendered, /结果：不符合策略｜评分 91\/100/u);
  assert.match(rendered, /Result: No strategy match \| score 91\/100/u);
  assert.doesNotMatch(rendered, /可卖性未核验|Sellability is unverified|不生成订单|no order generated|风险|risk/iu);
  assert.deepEqual(input, original);
});

test("renderer fails closed for an unvalidated signal and bounds long narrative fields", () => {
  assert.throws(() => renderNarrativeTradeSignalText({ decision: "do" }), /deterministic narrative trade signal/u);
  assert.throws(() => renderNarrativeTradeSignalText(signal({
    shadowOrder: { mode: "shadow", executable: false, side: "buy", chainId: 4663, ca: TOKEN, poolAddress: POOL },
  })), /deterministic narrative trade signal/u);
  const rendered = renderNarrativeTradeSignalText(signal({
    mechanism: { zh: "长".repeat(500), en: "long narrative ".repeat(80) },
  }));
  assert.ok(rendered.split("\n").every((line) => line.length <= 150));
  assert.equal(rendered.match(new RegExp(TOKEN, "g"))?.length, 2);
});

test("a verified do signal enters the durable alert pipeline as one local bilingual card", async () => {
  const { signal: derived } = buildNarrativeSniperDemo("candidate");
  const event = {
    type: "narrative_trade_signal",
    kind: "shadow_candidate",
    eventKey: `narrative-trade:${derived.decisionHash}`,
    observedAt: derived.event.asOf,
    signal: derived,
  };
  assert.equal(isMonitoringSourceEnabled({ narrativeSniperEnabled: false }, event), false);
  assert.equal(isMonitoringSourceEnabled({ narrativeSniperEnabled: true }, event), true);
  assert.equal(isRelevantAlert(event), true);
  assert.equal(isStrongAlert(event), true);
  assert.equal(alertEventKey(event), event.eventKey);

  const bundle = await buildBilingualAlertBundle({}, event, "ignored");
  const rendered = renderBilingualTelegramText(bundle, true);
  assert.equal(bundle.format, "telegram_zh_en_narrative_v2");
  assert.match(rendered, /平台：Flap｜AI 叙事分析/u);
  assert.match(rendered, /结果：符合策略｜评分/u);
  assert.match(rendered, /时间：.*CST/u);
  assert.doesNotMatch(rendered, /风险|risk|失效|invalidation|影子|shadow|签名|signing|广播|broadcast|不做|do not trade|not a buy/iu);
  assert.ok(rendered.split("\n").every((line) => line.length <= 150));
});

test("tampered or non-do signals cannot enter the alert pipeline", () => {
  const watch = buildNarrativeSniperDemo("watch").signal;
  assert.equal(isRelevantAlert({ type: "narrative_trade_signal", signal: watch }), false);

  const tampered = structuredClone(buildNarrativeSniperDemo("candidate").signal);
  tampered.shadowOrder.notionalUsd = 1_000_000;
  assert.equal(isRelevantAlert({ type: "narrative_trade_signal", signal: tampered }), false);
});
