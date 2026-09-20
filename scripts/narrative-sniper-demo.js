import { fileURLToPath } from "node:url";

import { renderNarrativeTradeSignalText } from "../src/narrative-trade-alert.js";
import { deriveNarrativeTradeSignal } from "../src/narrative-trade-signal.js";
import { resolveVerifiedPoolAssetContext } from "../src/new-pool-context.js";

const QUOTE_CA = "0x02fca66c1d1afb4e2a7884261eb00f63598a7436";
const TARGET_CA = "0xa11ce00000000000000000000000000000000001";
const TARGET_POOL = "0xb001000000000000000000000000000000000001";
const PUBLISHED_AT = "2026-09-06T08:00:00.000Z";
const AS_OF = "2026-09-06T08:05:00.000Z";

function demoInput(scenario) {
  const profile = resolveVerifiedPoolAssetContext({ chainId: 56, address: QUOTE_CA });
  const input = {
    event: {
      eventKey: "demo:flap:nvda:first-token",
      type: "new_pool_first_token",
      platform: { id: "flap", name: "Flap" },
      targetSymbol: "JENSEN",
      title: {
        zh: "【模拟输入】NVIDIA 叙事底池出现首个可交易代币",
        en: "[DEMO INPUT] First tradable token appeared in an NVIDIA-narrative pool",
      },
      mechanism: {
        summary: {
          zh: "AI 算力关注度可能经 NVIDIA 映射底池流向同主题新币",
          en: "AI-compute attention may flow through the NVIDIA-reference pool into the themed token",
        },
        capitalFlow: {
          zh: "模拟新闻 → AI 注意力 → 新底池成交",
          en: "demo news → AI attention → new-pool flow",
        },
        confidence: 90,
      },
      occurredAt: PUBLISHED_AT,
    },
    poolContext: {
      chainId: 56,
      ca: QUOTE_CA,
      caVerified: true,
      identityStatus: "matched",
      profile,
    },
    targetEvidence: {
      chainId: 56,
      ca: TARGET_CA,
      poolAddress: TARGET_POOL,
      caVerified: true,
      poolVerified: true,
      symbol: "JENSEN",
    },
    narrativeEvidence: {
      verified: true,
      sourceKind: "demo_fixture",
      sourceUrl: "demo://narrative-sniper/nvda-first-token",
      publishedAt: PUBLISHED_AT,
      headline: {
        zh: "【模拟输入】NVIDIA 主题催化与 Flap 首币同时出现",
        en: "[DEMO INPUT] NVIDIA-themed catalyst coincides with a first Flap token",
      },
      subjectMatch: true,
      strength: 92,
      novelty: 90,
      mechanismConfidence: 90,
    },
    marketEvidence: {
      asOf: AS_OF,
      dataHealth: "healthy",
      coverageComplete: true,
      marketConfirmed: true,
      momentumConfirmed: true,
      walletClusterConfirmed: true,
      liquidityUsd: 85_000,
      estimatedSlippageBps: 110,
      entryWindow: "open",
      requestedShadowNotionalUsd: 25,
    },
    riskEvidence: {
      asOf: AS_OF,
      coverageComplete: true,
      sellability: "verified_sellable",
      riskLevel: "low",
      riskScore: 12,
      honeypot: false,
      ownerCanBlacklist: false,
      ownerCanMint: false,
      ownerCanFreeze: false,
      ownerCanPause: false,
      ownerCanChangeTax: false,
    },
    asOf: AS_OF,
  };

  if (scenario === "watch") input.marketEvidence.marketConfirmed = false;
  if (scenario === "reject") {
    input.riskEvidence.sellability = "cannot_sell";
    input.riskEvidence.riskLevel = "critical";
    input.riskEvidence.honeypot = true;
  }
  return input;
}

export function buildNarrativeSniperDemo(scenario = "candidate") {
  if (!["candidate", "watch", "reject"].includes(scenario)) {
    throw new TypeError("scenario must be candidate, watch, or reject");
  }
  const signal = deriveNarrativeTradeSignal(demoInput(scenario));
  return Object.freeze({
    scenario,
    signal,
    alertText: renderNarrativeTradeSignalText(signal),
  });
}

function argumentValue(name, fallback) {
  const prefix = `--${name}=`;
  const argument = process.argv.slice(2).find((value) => value.startsWith(prefix));
  return argument ? argument.slice(prefix.length) : fallback;
}

function main() {
  const scenario = argumentValue("scenario", "candidate");
  const jsonOnly = process.argv.includes("--json");
  const result = buildNarrativeSniperDemo(scenario);
  if (jsonOnly) {
    process.stdout.write(`${JSON.stringify(result.signal, null, 2)}\n`);
    return;
  }
  process.stdout.write([
    "🧪 DEMO FIXTURE｜本地模拟数据，不是实时信号，不会签名或广播交易",
    "",
    result.alertText,
    "",
    "Shadow order / 影子单：",
    JSON.stringify(result.signal.shadowOrder, null, 2),
    "",
  ].join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
