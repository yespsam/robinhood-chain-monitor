// Admission into the confirmed paper session that live already mirrors
// (LIVE_SIGNAL_SOURCE=paper-atm-confirmed-pvp-v2). This file does not sign,
// size a new ticket, or call GMGN. Curve TokenCreated / first-three stays in
// paper-pool-signal.js.
import { isLiveFlapPoolLaunchUpdate } from "./flap-pool-launch.js";

export const FLAP_POOL_LAUNCH_SIGNAL_SOURCE = "flap_pool_launch";
export const FLAP_POOL_LAUNCH_SIGNAL_VERSION = "monitored_event_entry_v1";
export const FLAP_POOL_LAUNCH_SIGNAL_MAX_AGE_MS = 120_000;

const at = (value) => Date.parse(value || "");
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function fields(event, nowMs) {
  if (!isLiveFlapPoolLaunchUpdate(event)) return null;
  const launch = event.poolLaunches[0];
  const blockAt = at(event.blockTimestamp);
  const observedAt = at(event.observedAt);
  if (!Number.isFinite(blockAt) || !Number.isFinite(observedAt)
    || blockAt > nowMs || observedAt > nowMs || observedAt < blockAt
    || nowMs - blockAt > FLAP_POOL_LAUNCH_SIGNAL_MAX_AGE_MS) return null;
  const address = event.tokens[0].token;
  return {
    chain: "bsc",
    address,
    source: FLAP_POOL_LAUNCH_SIGNAL_SOURCE,
    sourceId: event.eventKey,
    sourceUrl: event.sourceUrl,
    sourceAt: event.blockTimestamp,
    authenticated: true,
    liveSignalSource: event.liveSignalSource,
    text: `Flap Pool Launch ${launch.name || "未命名"} (${launch.symbol || "?"}) 已在 Portal 直接建 V2 池。报价 ${launch.quoteLabel || "未取得"}，开盘价 ${launch.initialPriceQuotePerToken || "未取得"}。进入确认型模拟盘后仍受现有报价、流动性、税费、成本和亏损闸门约束，不另开仓位额度。`,
    pool: {
      version: "flap_pool_launch_v1",
      platform: "flap",
      launchKind: "DIRECT_V2_POOL_TAX",
      schemaName: "V2_POOL_LAUNCH_SCHEMA_V1",
      quoteAddress: launch.quoteToken,
      quoteSymbol: launch.quoteLabel,
      poolAddress: launch.pool,
      graduated: launch.graduated === true,
      initialPriceQuotePerToken: launch.initialPriceQuotePerToken,
      createdAt: event.blockTimestamp,
    },
    poolEvent: structuredClone(event),
  };
}

export function validFlapPoolLaunchSignal(signal, token, nowMs) {
  const built = fields(signal?.poolEvent, nowMs);
  return Boolean(built
    && signal.version === FLAP_POOL_LAUNCH_SIGNAL_VERSION
    && signal.paperOnly === true
    && token?.chain === built.chain
    && token.address === built.address
    && Object.entries(built).every(([key, value]) => same(signal[key], value))
    && signal.id === `${FLAP_POOL_LAUNCH_SIGNAL_VERSION}:${FLAP_POOL_LAUNCH_SIGNAL_SOURCE}:${built.sourceId}:${built.chain}:${built.address}`
    && Number.isFinite(at(signal.observedAt))
    && at(signal.observedAt) >= at(built.poolEvent.observedAt)
    && at(signal.observedAt) <= nowMs
    && nowMs - at(signal.observedAt) <= 30_000);
}

export function buildFlapPoolLaunchWire({ events = [], account, nowMs = Date.now(), enabled = true } = {}) {
  if (enabled !== true) return { signals: [], seeds: [], report: { enabled: false, readySignals: 0 } };
  const bought = new Set((account?.trades || [])
    .filter((trade) => trade?.side === "buy" && trade.chain === "bsc")
    .map((trade) => String(trade.address || "").toLowerCase()));
  const seen = new Map();
  for (const row of events) {
    const event = row?.event || row;
    const built = fields(event, nowMs);
    if (!built || bought.has(built.address.toLowerCase())) continue;
    const previous = seen.get(built.address.toLowerCase());
    if (!previous || at(event.observedAt) < at(previous.observedAt)) seen.set(built.address.toLowerCase(), event);
  }
  const signals = [...seen.values()].map((event) => {
    const built = fields(event, nowMs);
    const signal = {
      version: FLAP_POOL_LAUNCH_SIGNAL_VERSION,
      paperOnly: true,
      ...built,
      observedAt: new Date(nowMs).toISOString(),
    };
    signal.id = `${FLAP_POOL_LAUNCH_SIGNAL_VERSION}:${FLAP_POOL_LAUNCH_SIGNAL_SOURCE}:${signal.sourceId}:${signal.chain}:${signal.address}`;
    return signal;
  }).filter((signal) => validFlapPoolLaunchSignal(signal, signal, nowMs))
    .sort((left, right) => at(left.sourceAt) - at(right.sourceAt))
    .slice(0, 32);
  return {
    signals,
    seeds: signals.map((signal) => ({
      chain: signal.chain,
      address: signal.address,
      symbol: signal.poolEvent.tokens[0].metadata?.symbol || signal.pool.quoteSymbol,
      name: signal.poolEvent.tokens[0].metadata?.name || null,
    })),
    report: {
      enabled: true,
      liveSignalSource: "paper-atm-confirmed-pvp-v2",
      readySignals: signals.length,
      maxEventAgeMs: FLAP_POOL_LAUNCH_SIGNAL_MAX_AGE_MS,
    },
  };
}
