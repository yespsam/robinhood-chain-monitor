import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { createNarrativeShadowLedger } from "../src/narrative-shadow-ledger.js";
import { createNarrativeShadowSimulator } from "../src/narrative-shadow-simulator.js";
import { buildNarrativeSniperDemo } from "./narrative-sniper-demo.js";

const ENTRY_BLOCK = 100;
const EXIT_BLOCK = 101;
const QUANTITY_RAW = "1000000000000000000";
const ENTRY_VALUE_USD_MICROS = "25000000";
const EXIT_VALUE_USD_MICROS = "31250000";
const ROUTE_DIGEST = "7".repeat(64);

function fixtureQuoteProvider(now) {
  const providerId = "fixture.shadow.lifecycle.v1";
  const blockHash = (blockNumber) => `0x${((blockNumber % 15) + 1).toString(16).repeat(64)}`;
  const quote = (request, kind, blockNumber, valueUsdMicros, priceUsdMicros) => {
    const observedAt = new Date(now()).toISOString();
    return {
      status: "ok",
      providerId,
      kind,
      side: kind === "entry" ? "buy" : "sell",
      marketExecutable: true,
      chainId: request.chainId,
      ca: request.ca,
      poolAddress: request.poolAddress,
      blockNumber,
      blockHash: blockHash(blockNumber),
      blockTimestamp: observedAt,
      observedAt,
      validUntil: new Date(now() + 2_000).toISOString(),
      valueUsdMicros,
      quantityRaw: kind === "entry" ? QUANTITY_RAW : request.quantityRaw,
      priceUsdMicros,
      estimatedSlippageBps: 75,
      routeDigest: ROUTE_DIGEST,
    };
  };
  return Object.freeze({
    providerId,
    trusted: true,
    readOnly: true,
    getEntryQuote: async (request) => quote(
      request,
      "entry",
      ENTRY_BLOCK,
      request.valueUsdMicros,
      ENTRY_VALUE_USD_MICROS,
    ),
    getPositionMark: async (request) => quote(
      request,
      "mark",
      EXIT_BLOCK,
      EXIT_VALUE_USD_MICROS,
      EXIT_VALUE_USD_MICROS,
    ),
    checkCanonicalBlock: async (request) => ({
      status: "ok",
      providerId,
      chainId: request.chainId,
      blockNumber: request.blockNumber,
      blockHash: request.expectedBlockHash,
      observedAt: new Date(now()).toISOString(),
    }),
  });
}

function usd(micros) {
  const value = BigInt(micros);
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1_000_000n;
  const fraction = (absolute % 1_000_000n).toString().padStart(6, "0").replace(/0+$/u, "");
  return `${sign}$${whole}${fraction ? `.${fraction}` : ""}`;
}

export async function buildNarrativeShadowLifecycleDemo() {
  const signal = buildNarrativeSniperDemo("candidate").signal;
  let nowMs = Date.parse(signal.shadowOrder.simulatedAt);
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "narrative-shadow-lifecycle-demo-"));
  let ledger;
  let simulator;
  try {
    ledger = createNarrativeShadowLedger({
      dataDir,
      now: () => nowMs,
      entryTtlMs: 30_000,
    });
    await ledger.ready;
    const admitted = await ledger.admit(signal, {
      sourceProof: {
        eventKey: signal.event.eventKey,
        stableEventKey: signal.event.eventKey,
        chainId: signal.shadowOrder.chainId,
        contentDigest: signal.inputHash,
        observedAt: signal.shadowOrder.simulatedAt,
      },
    });
    simulator = createNarrativeShadowSimulator({
      narrativeShadowSimulatorEnabled: true,
      narrativeShadowSimulatorAutoStart: false,
      narrativeShadowMarkIntervalMs: 1_000,
      narrativeShadowProviderTimeoutMs: 250,
      narrativeShadowQuoteMaxAgeMs: 5_000,
      narrativeShadowQuoteBlockMaxAgeMs: 5_000,
      narrativeShadowQuoteMaxValidityMs: 5_000,
      narrativeShadowQuoteFutureSkewMs: 1_000,
      narrativeShadowTakeProfitBps: 2_000,
      narrativeShadowStopLossBps: 1_000,
      narrativeShadowTimeStopMs: 60_000,
      narrativeShadowMaxOrdersPerCycle: 10,
      narrativeShadowTerminalAuditPerCycle: 1,
    }, {
      ledger,
      quoteProvider: fixtureQuoteProvider(() => nowMs),
      now: () => nowMs,
    });
    const entryCycle = await simulator.check();
    nowMs += 1_000;
    const exitCycle = await simulator.check();
    const order = await ledger.getOrder(admitted.orderId);
    const metrics = await simulator.getMetrics();
    return Object.freeze({
      schema: "narrative_shadow_lifecycle_demo_v1",
      fixture: true,
      networkAccess: false,
      signing: false,
      broadcast: false,
      entryCycle,
      exitCycle,
      order,
      metrics,
    });
  } finally {
    await simulator?.stop().catch(() => {});
    await ledger?.stop().catch(() => {});
    await fs.rm(dataDir, { recursive: true, force: true });
  }
}

async function main() {
  const result = await buildNarrativeShadowLifecycleDemo();
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  const pnl = BigInt(result.order.exit.valueUsdMicros) - BigInt(result.order.entry.valueUsdMicros);
  process.stdout.write([
    "🧪 SHADOW LIFECYCLE FIXTURE｜离线纸面交易，不联网、不签名、不广播",
    `状态：${result.order.status}｜退出：${result.order.exitReason}`,
    `入场：${usd(result.order.entry.valueUsdMicros)}｜区块 ${result.order.entry.blockNumber}`,
    `退出：${usd(result.order.exit.valueUsdMicros)}｜区块 ${result.order.exit.blockNumber}`,
    `模拟盈亏：${usd(pnl)}｜胜率样本 ${result.metrics.ledger.winRateBps / 100}%`,
    `台账：${result.metrics.ledger.totalOrders} 单｜已平仓 ${result.metrics.ledger.counts.closed}`,
    "边界：fixture 行情，仅验证生命周期；没有连接钱包或真实交易账户。",
    "",
  ].join("\n"));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
