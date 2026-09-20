import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFile = promisify(nodeExecFile);

export const GMGN_CHAINS = Object.freeze(['sol', 'bsc', 'base', 'eth']);
export const GMGN_INTERVALS = Object.freeze(['1m', '5m', '1h', '6h', '24h']);
export const GMGN_RESOLUTIONS = Object.freeze(['30s', '1m', '5m', '15m', '1h', '4h', '1d']);
const GMGN_ORDER_BY = 'volume';
const DEFAULT_TTL_MS = 12_000;
const DEFAULT_TIMEOUT_MS = 12_000;
const MAX_BUFFER = 4 * 1024 * 1024;

const numberOrNull = value => {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};

const boolOrNull = value => typeof value === 'boolean' ? value : value === 1 ? true : value === 0 ? false : null;

const validChoice = (value, choices) => typeof value === 'string' && choices.includes(value);

function assertChain(chain) {
  if (!validChoice(chain, GMGN_CHAINS)) throw new TypeError('invalid chain');
}

function assertInterval(interval) {
  if (!validChoice(interval, GMGN_INTERVALS)) throw new TypeError('invalid interval');
}

function assertResolution(resolution) {
  if (!validChoice(resolution, GMGN_RESOLUTIONS)) throw new TypeError('invalid resolution');
}

function assertAddress(address) {
  if (typeof address !== 'string' || address.length < 8 || address.length > 128 || !/^[A-Za-z0-9_-]+$/.test(address)) {
    throw new TypeError('invalid address');
  }
}

function riskGate(item) {
  if (item.is_honeypot === 1 || item.is_wash_trading === true || (numberOrNull(item.rug_ratio) ?? 0) > 0.3) return 'BLOCKED';
  if ((numberOrNull(item.smart_degen_count) ?? 0) >= 3 && (numberOrNull(item.rug_ratio) ?? 0) < 0.2 && item.creator_close === true && item.is_wash_trading !== true && (numberOrNull(item.liquidity) ?? 0) > 50_000) return 'STRONG';
  return 'WATCH';
}

function normalizeToken(item, fallbackChain) {
  if (!item || typeof item !== 'object' || typeof item.address !== 'string') return null;
  const token = {
    address: item.address,
    symbol: typeof item.symbol === 'string' && item.symbol ? item.symbol : 'UNKNOWN',
    name: typeof item.name === 'string' ? item.name : '',
    logo: typeof item.logo === 'string' ? item.logo : '',
    chain: typeof item.chain === 'string' ? item.chain : fallbackChain,
    price: numberOrNull(item.price),
    change: numberOrNull(item.price_change_percent),
    priceChange1m: numberOrNull(item.price_change_percent1m),
    priceChange5m: numberOrNull(item.price_change_percent5m),
    priceChange1h: numberOrNull(item.price_change_percent1h),
    totalSupply: numberOrNull(item.total_supply),
    marketCap: numberOrNull(item.market_cap),
    liquidity: numberOrNull(item.liquidity),
    volume: numberOrNull(item.volume),
    initialLiquidity: numberOrNull(item.initial_liquidity),
    historyHighestMarketCap: numberOrNull(item.history_highest_market_cap),
    swaps: numberOrNull(item.swaps),
    buys: numberOrNull(item.buys),
    sells: numberOrNull(item.sells),
    holders: numberOrNull(item.holder_count),
    smartDegenCount: numberOrNull(item.smart_degen_count),
    renownedCount: numberOrNull(item.renowned_count),
    rugRatio: numberOrNull(item.rug_ratio),
    isHoneypot: item.is_honeypot,
    isWashTrading: boolOrNull(item.is_wash_trading),
    isOpenSource: item.is_open_source,
    isRenounced: item.is_renounced,
    buyTax: item.buy_tax ?? null,
    sellTax: item.sell_tax ?? null,
    top10HolderRate: numberOrNull(item.top_10_holder_rate),
    creatorTokenStatus: typeof item.creator_token_status === 'string' ? item.creator_token_status : '',
    creatorClose: item.creator_close === true,
    creator: typeof item.creator === 'string' ? item.creator : '',
    launchpadPlatform: typeof item.launchpad_platform === 'string' ? item.launchpad_platform : '',
    launchpad: typeof item.launchpad === 'string' ? item.launchpad : '',
    launchpadStatus: item.launchpad_status ?? null,
    exchange: typeof item.exchange === 'string' ? item.exchange : '',
    twitterUsername: typeof item.twitter_username === 'string' ? item.twitter_username : '',
    website: typeof item.website === 'string' ? item.website : '',
    telegram: typeof item.telegram === 'string' ? item.telegram : '',
    creationTimestamp: numberOrNull(item.creation_timestamp),
    openTimestamp: numberOrNull(item.open_timestamp),
    rank: numberOrNull(item.rank),
    hotLevel: numberOrNull(item.hot_level),
    gasFee: numberOrNull(item.gas_fee),
    burnRatio: numberOrNull(item.burn_ratio),
    burnStatus: typeof item.burn_status === 'string' ? item.burn_status : '',
    renouncedMint: item.renounced_mint ?? null,
    renouncedFreezeAccount: item.renounced_freeze_account ?? null,
    isTokenLive: item.is_token_live ?? null,
    tcid: typeof item.tcid === 'string' ? item.tcid : '',
    botDegenCount: numberOrNull(item.bot_degen_count),
    botDegenRate: numberOrNull(item.bot_degen_rate),
    lockPercent: numberOrNull(item.lock_percent),
    bundlerRate: numberOrNull(item.bundler_rate),
    entrapmentRatio: numberOrNull(item.entrapment_ratio),
    sniperCount: numberOrNull(item.sniper_count),
    raw: item,
  };
  token.risk = riskGate(item);
  return token;
}

function normalizeCandle(item) {
  if (!item || typeof item !== 'object') return null;
  const time = numberOrNull(item.time);
  const open = numberOrNull(item.open);
  const close = numberOrNull(item.close);
  const high = numberOrNull(item.high);
  const low = numberOrNull(item.low);
  if (time === null || close === null) return null;
  return { time, open, close, high, low, volume: numberOrNull(item.volume), amount: numberOrNull(item.amount), source: typeof item.source === 'string' ? item.source : null };
}

function parseJson(stdout) {
  try { return JSON.parse(String(stdout).trim()); } catch { return null; }
}

function rankItems(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.data?.rank)) return payload.data.rank;
  if (Array.isArray(payload?.rank)) return payload.rank;
  return [];
}

function candleItems(payload) {
  if (Array.isArray(payload?.list)) return payload.list;
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  if (Array.isArray(payload)) return payload;
  return [];
}

const unavailable = (extra = {}) => ({ status: 'unavailable', source: 'gmgn-cli', reason: 'gmgn_unavailable', observedAt: null, ...extra });

export function createReadonlyMarketClient({ runner = null, ttlMs = DEFAULT_TTL_MS, timeoutMs = DEFAULT_TIMEOUT_MS, cliPath = process.env.GMGN_FLOW_CLI_PATH || 'gmgn-cli' } = {}) {
  let rateLimitedUntil = 0;
  const run = runner || (async args => {
    if (Date.now() < rateLimitedUntil) throw new Error('gmgn_rate_limited');
    try {
      await execFile(cliPath, ['config', '--check'], { timeout: timeoutMs, maxBuffer: MAX_BUFFER });
      const result = await execFile(cliPath, args, { timeout: timeoutMs, maxBuffer: MAX_BUFFER });
      return result.stdout;
    } catch (error) {
      const diagnostic = `${error?.stderr || ''} ${error?.message || ''}`;
      const match = diagnostic.match(/Rate limit resets at ([^\n(]+)/i);
      const resetAt = match ? Date.parse(match[1].trim()) : NaN;
      if (Number.isFinite(resetAt)) rateLimitedUntil = Math.max(rateLimitedUntil, resetAt + 1000);
      throw error;
    }
  });
  const cache = new Map();

  async function cached(key, load) {
    const previous = cache.get(key);
    const now = Date.now();
    if (previous && previous.expiresAt > now) return previous.promise;
    const promise = Promise.resolve().then(load).catch(() => null);
    cache.set(key, { expiresAt: now + ttlMs, promise });
    return promise;
  }

  async function trending({ chain, interval = '1m', limit = 20 } = {}) {
    assertChain(chain); assertInterval(interval);
    const requestedLimit = Math.min(50, Math.max(1, Number(limit) || 20));
    const key = `trending:${chain}:${interval}:${requestedLimit}`;
    const result = await cached(key, async () => {
      const stdout = await run(['market', 'trending', '--chain', chain, '--interval', interval, '--order-by', GMGN_ORDER_BY, '--limit', String(requestedLimit), '--raw']);
      const payload = parseJson(stdout);
      const tokens = rankItems(payload).map(item => normalizeToken(item, chain)).filter(Boolean);
      if (!tokens.length) return unavailable({ chain, interval });
      return { status: 'ok', source: 'gmgn-cli', chain, interval, orderBy: GMGN_ORDER_BY, observedAt: new Date().toISOString(), tokens };
    });
    return result || unavailable({ chain, interval });
  }

  async function kline({ chain, address, resolution = '1m', from, to } = {}) {
    assertChain(chain); assertResolution(resolution); assertAddress(address);
    const end = Number.isFinite(Number(to)) ? Math.floor(Number(to)) : Math.floor(Date.now() / 1000);
    const start = Number.isFinite(Number(from)) ? Math.floor(Number(from)) : end - 6 * 60 * 60;
    if (start >= end || end - start > 7 * 24 * 60 * 60) throw new TypeError('invalid time range');
    const key = `kline:${chain}:${address}:${resolution}:${start}:${end}`;
    const result = await cached(key, async () => {
      const stdout = await run(['market', 'kline', '--chain', chain, '--address', address, '--resolution', resolution, '--from', String(start), '--to', String(end), '--raw']);
      const payload = parseJson(stdout);
      const candles = candleItems(payload).map(normalizeCandle).filter(Boolean);
      if (!candles.length) return unavailable({ chain, address, resolution });
      return { status: 'ok', source: 'gmgn-cli', chain, address, resolution, from: start, to: end, observedAt: new Date().toISOString(), candles };
    });
    return result || unavailable({ chain, address, resolution });
  }

  return { trending, kline, clearCache: () => cache.clear() };
}

export const readonlyMarket = createReadonlyMarketClient();
