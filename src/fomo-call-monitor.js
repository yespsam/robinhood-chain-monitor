import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Interface, JsonRpcProvider, formatUnits, id, isAddress } from "ethers";
import { isTerminalAlertSuppression, sendAlerts } from "./alerts.js";
import { assessLocalTokenSecurity } from "./local-security.js";
import { createGmgnFlowClient } from "./gmgn-flow-client.js";

export const COPE_API_BASE = "https://api.cope.capital";
export const FOMO_PLATFORM_URL = "https://fomo.family";
const DEX_SCREENER_BASE = "https://api.dexscreener.com/token-pairs/v1";
const SOLANA_CHAIN_ID = 1_399_811_149;
const BASE_CHAIN_ID = 8_453;
const BSC_CHAIN_ID = 56;
const SOLANA_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const SOLANA_TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const SOLANA_TOKEN_PROGRAMS = new Set([SOLANA_TOKEN_PROGRAM, SOLANA_TOKEN_2022_PROGRAM]);
const FOMOSCAN_API_BASE = "https://api.fomoscan.sh";
const PUBLIC_FOMO_HANDLES = [
  "_logjam", "remusofmars", "frankdegods", "jotagezin", "RuneCrypto_", "collectible",
  "orangie", "icemandot", "andy", "lesabre", "0xuberM", "octoseaa", "favel",
  "Thokani", "notwashed", "hdegrootvan", "DNS_ERR", "rasmr_eth", "aoulss",
  "spyzer", "riskanonymous", "notanicecat69", "notthreadguy",
];
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_WSOL = "So11111111111111111111111111111111111111112";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const BSC_WBNB = "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c";
const BASE_WETH = "0x4200000000000000000000000000000000000006";
const PRICE_COUNTERPARTIES = {
  bsc: new Set([
    BSC_WBNB,
    "0x55d398326f99059ff775485246999027b3197955", // USDT
    "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", // USDC
    "0xe9e7cea3dedca5984780bafc599bd69add087d56", // BUSD
    "0xc5f0f7b66764f6ec8c8dff7ba683102295e16409", // FDUSD
    "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d", // USD1
  ]),
  base: new Set([
    BASE_WETH,
    "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", // USDC
    "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", // USDbC
  ]),
  solana: new Set([SOLANA_WSOL, SOLANA_USDC]),
};
const FOUR_MEME_ADDRESS_URL = "https://four.meme/meme-api/v1/public/address";
const CURVE_SOURCE_403_BACKOFF_MS = [15 * 60_000, 60 * 60_000, 6 * 60 * 60_000, 24 * 60 * 60_000];
const CURVE_SOURCE_TIMEOUT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const CURVE_SOURCE_FALLBACK_BACKOFF_MS = 5 * 60_000;
const FLAP_BSC_PORTALS = new Set(["0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0", "0x90497450f2a706f1951b5bdda52b4e5d16f34c06"]);
const DEFAULT_FOUR_MEME_MANAGERS = new Set([
  "0xec4549cadce5da21df6e6422d448034b5233bfbc", "0x5c952063c7fc8610ffdb798152d69f0b9550762b",
  "0x87fd30d61a8dce9150e173be9bf53e7f1c55dff8", "0x681cf37be53aa3493a49bc4d466f81baff7d3966",
  "0x02226545f89d78c1afc936a7147180f061f69325", "0x704352c86b10247f361ccb7a1c95841c35753a17",
]);
const ERC20 = new Interface(["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)", "function symbol() view returns(string)"]);
const FLAP_CURVE = new Interface([
  "event TokenBought(uint256 ts,address token,address buyer,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)",
  "event TokenSold(uint256 ts,address token,address seller,uint256 amount,uint256 eth,uint256 fee,uint256 postPrice)",
  "function previewSell(address token,uint256 amount) view returns(uint256 eth)",
]);
const FLAP_TOKEN_STATE = new Interface([
  "function getTokenV5(address token) view returns(tuple(uint8 status,uint256 reserve,uint256 circulatingSupply,uint256 price,uint8 tokenVersion,uint256 r,uint256 h,uint256 k,uint256 dexSupplyThresh,address quoteTokenAddress,bool nativeToQuoteSwapEnabled,bytes32 extensionID) state)",
]);
const FOUR_CURVE_V1 = new Interface([
  "event TokenPurchase(address token,address account,uint256 tokenAmount,uint256 etherAmount,uint256 fee)",
  "event TokenSale(address token,address account,uint256 tokenAmount,uint256 etherAmount,uint256 fee)",
]);
const FOUR_CURVE_V2 = new Interface([
  "event TokenPurchase(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)",
  "event TokenSale(address token,address account,uint256 price,uint256 amount,uint256 cost,uint256 fee,uint256 offers,uint256 funds)",
]);
const FOUR_TOKEN_INFO = new Interface([
  "function _tokenInfos(address) view returns(address base,address quote,uint256 template,uint256 totalSupply,uint256 maxOffers,uint256 maxRaising,uint256 launchTime,uint256 offers,uint256 funds,uint256 lastPrice,uint256 K,uint256 T,uint256 status)",
  "function _tradingHalt() view returns(bool)",
]);
const TRANSFER_TOPIC = id("Transfer(address,address,uint256)").toLowerCase();
const SWAP_TOPICS = new Set([
  id("Swap(address,uint256,uint256,uint256,uint256,address)").toLowerCase(),
  id("Swap(address,address,int256,int256,uint160,uint128,int24)").toLowerCase(),
  id("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)").toLowerCase(),
]);
const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const HANDLE = /^[A-Za-z0-9_]{1,30}$/;
const GMGN_ATTRIBUTION_MAX_AGE_MS = 24 * 60 * 60_000;
const ATTRIBUTION_FUTURE_TOLERANCE_MS = 60_000;
const GMGN_BLOCKED_TAGS = new Set(["wash_trader", "arbitrager"]);
const SMART_MONEY_SIGNAL_KIND = "high_profit_high_winrate_wallet_buy";
const SMART_MONEY_SOURCE_ID = "gmgn_profitable_wallet_onchain";
const SMART_MONEY_SOURCE_TRUST = "public_onchain_profiled";
const SMART_MONEY_BLOCKED_TAG = /(?:^|[_-])(?:wash(?:[_-]?trader)?|arbitrager|arbitrage|mev(?:[_-]?bot)?|sandwich|router|cex|exchange|contract)(?:$|[_-])/i;
const FOMO_X_CALL_STATE_VERSION = 2;
const GOPLUS_BSC_CHAIN_ID = 56;
const GOPLUS_REQUIRED_ZERO_FLAGS = [
  "is_proxy",
  "is_mintable",
  "is_honeypot",
  "cannot_sell_all",
  "cannot_buy",
  "is_blacklisted",
  "is_whitelisted",
  "transfer_pausable",
  "trading_cooldown",
  "can_take_back_ownership",
  "owner_change_balance",
  "hidden_owner",
  "selfdestruct",
  "external_call",
  "personal_slippage_modifiable",
  "slippage_modifiable",
  "anti_whale_modifiable",
];
const execFileAsync = promisify(execFile);
const STABLE_OR_WRAPPED = new Set([
  "USDC", "USDT", "DAI", "USDG", "USDE", "USDS", "FDUSD", "BUSD",
  "ETH", "WETH", "SOL", "WSOL", "BTC", "WBTC", "BNB", "WBNB",
]);

function acquireFomoProcessLease(dataDir) {
  fsSync.mkdirSync(dataDir, { recursive: true });
  const lockDir = path.join(dataDir, "fomo-call-monitor.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fsSync.mkdirSync(lockDir);
      fsSync.writeFileSync(path.join(lockDir, "owner.json"), JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          const owner = JSON.parse(fsSync.readFileSync(path.join(lockDir, "owner.json"), "utf8"));
          if (Number(owner?.pid) === process.pid) fsSync.rmSync(lockDir, { recursive: true, force: true });
        } catch { /* A different/stale owner must never be removed by this process. */ }
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      let ownerPid = null;
      let ageMs = 0;
      try {
        ownerPid = Number(JSON.parse(fsSync.readFileSync(path.join(lockDir, "owner.json"), "utf8"))?.pid);
        ageMs = Date.now() - fsSync.statSync(lockDir).mtimeMs;
      } catch {
        try { ageMs = Date.now() - fsSync.statSync(lockDir).mtimeMs; } catch { ageMs = 0; }
      }
      if (Number.isSafeInteger(ownerPid) && ownerPid > 0) {
        try {
          process.kill(ownerPid, 0);
          return null;
        } catch (probeError) {
          if (probeError?.code === "EPERM") return null;
        }
      } else if (ageMs < 30_000) {
        return null;
      }
      fsSync.rmSync(lockDir, { recursive: true, force: true });
    }
  }
  return null;
}
const RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const PENDING_MAX_AGE_MS = 10 * 60 * 1_000;
const DEFAULT_TELEMETRY_PERSIST_INTERVAL_MS = 60_000;
const SMART_MONEY_EXACT_MAX_PER_CHECK = 3;
const SMART_MONEY_EXACT_BUDGET_MS = 8_000;
const SMART_MONEY_FEED_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000];
const SMART_MONEY_STATS_BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000];
const FOMO_CALL_CHECKPOINT_VERSION = 1;
const FOMO_CALL_CHECKPOINT_EPOCH = "1970-01-01T00:00:00.000Z";
const BSC_COVERAGE_RECOVERY_VERSION = 1;
const MAX_COVERAGE_GAPS = 50;

const finite = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const normalizedTags = (value) => Array.isArray(value)
  ? [...new Set(value.map((tag) => String(tag || "").trim().toLowerCase()).filter(Boolean))]
  : [];

const normalizedTagUnion = (...values) => normalizedTags(values.flatMap((value) =>
  Array.isArray(value) ? value : []));

const smartMoneySourceClassification = (...tagSets) => {
  const gmgnTags = normalizedTagUnion(...tagSets);
  return {
    id: "gmgn_public_performance_wallet",
    gmgnTags,
    includesKolTag: gmgnTags.includes("kol"),
    fomoOfficial: false,
    identityVerified: false,
  };
};

const gmgnTagsAreClean = (value) => {
  const tags = normalizedTags(value);
  return tags.includes("kol")
    && tags.includes("fomo")
    && !tags.some((tag) => GMGN_BLOCKED_TAGS.has(tag));
};

const freshTimestamp = (value, nowMs, maximumAgeMs) => {
  const timestamp = Date.parse(String(value || ""));
  return Number.isFinite(timestamp)
    && timestamp <= Number(nowMs) + ATTRIBUTION_FUTURE_TOLERANCE_MS
    && Number(nowMs) - timestamp <= Math.max(60_000, Number(maximumAgeMs));
};

const exactZeroFlag = (row, field) => Object.prototype.hasOwnProperty.call(row || {}, field)
  && String(row[field]) === "0";

const exactOneFlag = (row, field) => Object.prototype.hasOwnProperty.call(row || {}, field)
  && String(row[field]) === "1";

const parsedTax = (value) => {
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 && number <= 1 ? number : null;
};

export function evaluateGoPlusBscTokenSecurity(payload, token, options = {}) {
  const normalizedToken = String(token || "").toLowerCase();
  const maximumTax = Math.max(0, Math.min(1, Number(options.maximumTax ?? 0.10)));
  const observedSell = options.observedSell === true;
  if (Number(payload?.code) !== 1 || !payload?.result || typeof payload.result !== "object") {
    return { decision: "pending", reason: "GoPlus 返回状态无效或结果缺失" };
  }
  const resultKey = Object.keys(payload.result).find((key) => key.toLowerCase() === normalizedToken);
  const row = resultKey ? payload.result[resultKey] : null;
  if (!row || typeof row !== "object") return { decision: "pending", reason: "GoPlus 未返回该 BSC 合约" };

  const missing = [];
  if (!Object.prototype.hasOwnProperty.call(row, "is_open_source")) missing.push("is_open_source");
  if (!Object.prototype.hasOwnProperty.call(row, "is_in_dex")) missing.push("is_in_dex");
  if (!Object.prototype.hasOwnProperty.call(row, "owner_address")) missing.push("owner_address");
  const buyTax = parsedTax(row.buy_tax);
  const sellTax = parsedTax(row.sell_tax);
  for (const field of GOPLUS_REQUIRED_ZERO_FLAGS) {
    const fieldMissing = !Object.prototype.hasOwnProperty.call(row, field) || row[field] === null || String(row[field]).trim() === "";
    if (!fieldMissing) continue;
    const supplementedCannotSellAll = field === "cannot_sell_all"
      && observedSell
      && sellTax !== null && sellTax <= maximumTax
      && exactZeroFlag(row, "is_honeypot")
      && exactZeroFlag(row, "cannot_buy");
    if (!supplementedCannotSellAll) missing.push(field);
  }
  if (buyTax === null) missing.push("buy_tax");
  if (sellTax === null) missing.push("sell_tax");
  if (missing.length) {
    return { decision: "pending", reason: `GoPlus 风险字段缺失: ${[...new Set(missing)].join(",")}` };
  }

  const risks = [];
  if (!exactOneFlag(row, "is_open_source")) risks.push("合约未开源");
  if (!exactOneFlag(row, "is_in_dex")) risks.push("GoPlus 未确认可在 DEX 交易");
  const cannotSellAllSupplemented = !Object.prototype.hasOwnProperty.call(row, "cannot_sell_all")
    || row.cannot_sell_all === null || String(row.cannot_sell_all).trim() === "";
  for (const field of GOPLUS_REQUIRED_ZERO_FLAGS) {
    if (field === "cannot_sell_all" && cannotSellAllSupplemented && observedSell
      && sellTax !== null && sellTax <= maximumTax
      && exactZeroFlag(row, "is_honeypot") && exactZeroFlag(row, "cannot_buy")) continue;
    if (!exactZeroFlag(row, field)) risks.push(`${field}=${String(row[field])}`);
  }
  if (buyTax > maximumTax) risks.push(`buy_tax=${buyTax}`);
  if (sellTax > maximumTax) risks.push(`sell_tax=${sellTax}`);
  const owner = String(row.owner_address || "").trim().toLowerCase();
  if (owner && ![ZERO_ADDRESS, "0x000000000000000000000000000000000000dead"].includes(owner)) {
    risks.push(`owner_address=${owner}`);
  }
  if (risks.length) return { decision: "block", reason: `GoPlus 严格门拒绝: ${risks.join(" · ")}` };

  return {
    decision: "pass",
    reason: "GoPlus BSC 严格安全门通过",
    metrics: {
      provider: "goplus_token_security_v1",
      chainId: GOPLUS_BSC_CHAIN_ID,
      token: normalizedToken,
      isOpenSource: true,
      isProxy: false,
      isMintable: false,
      isHoneypot: false,
      cannotSellAll: false,
      cannotSellAllEvidence: cannotSellAllSupplemented ? "supplemented_by_observed_sell" : "goplus_explicit_zero",
      cannotBuy: false,
      blacklist: false,
      whitelist: false,
      transferPausable: false,
      tradingCooldown: false,
      ownerAddress: owner || null,
      ownerRenounced: !owner || [ZERO_ADDRESS, "0x000000000000000000000000000000000000dead"].includes(owner),
      buyTax,
      sellTax,
      maximumTax,
    },
  };
}

async function mapConcurrent(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await worker(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(runners);
  return results;
}

async function withTimeout(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const epochMs = (value) => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^0x[0-9a-f]+$/i.test(trimmed)) value = Number(BigInt(trimmed));
    else if (!/^\d+(?:\.\d+)?$/.test(trimmed)) {
      const parsed = Date.parse(trimmed);
      return Number.isFinite(parsed) ? parsed : null;
    }
  }
  const number = finite(value);
  if (number === null || number < 0) return null;
  return number < 10_000_000_000 ? number * 1_000 : number;
};

const isoFromEpoch = (value) => {
  const timestamp = epochMs(value);
  return timestamp === null ? null : new Date(timestamp).toISOString();
};

const smartMoneyTagsAreClean = (value) => {
  const tags = normalizedTags(value);
  return !tags.some((tag) => SMART_MONEY_BLOCKED_TAG.test(tag));
};

const exactTransactionHash = (value) => /^0x[0-9a-f]{64}$/.test(String(value || "").toLowerCase())
  ? String(value).toLowerCase()
  : null;

const rawPositive = (value) => {
  try { return BigInt(value) > 0n; }
  catch { return false; }
};

const strictEvmReceiptStatus = (value) => value === "0x0" ? 0 : (value === "0x1" ? 1 : null);

const strictEvmBlockNumber = (value) => {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return null;
  try {
    const number = Number(BigInt(value));
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
  } catch { return null; }
};

const strictEvmHeadNumber = (value) => typeof value === "string" ? strictEvmBlockNumber(value) : null;

const evmLogIdentityMatches = (log, expected) => {
  if (!log || typeof log !== "object" || log.removed === true) return false;
  return exactTransactionHash(log.transactionHash) === expected.transactionHash
    && strictEvmBlockNumber(log.blockNumber) === expected.blockNumber
    && exactTransactionHash(log.blockHash) === expected.blockHash;
};

const gmgnRateLimitResetMs = (error, nowMs = Date.now()) => {
  if (error?.code === "GMGN_RATE_LIMITED" && Date.parse(error.retryAt) > nowMs) return Date.parse(error.retryAt);
  const text = [error?.message, error?.stderr, error?.stdout].filter(Boolean).join(" ");
  if (!/(?:HTTP\s*429|RATE_LIMIT_(?:EXCEEDED|BANNED)|rate limit|code["'=:\s]+429)/i.test(text)) return null;
  const rawReset = text.match(/["']?reset_at["']?\s*[:=]\s*["']?([^,"'\s}]+)/i)?.[1];
  if (rawReset) {
    const resetEpoch = epochMs(rawReset);
    if (resetEpoch !== null && resetEpoch > nowMs) return resetEpoch;
  }
  const explicit = text.match(/resets? at\s+(.+?)(?:\s+\(~|$)/i)?.[1]?.trim();
  const parsed = explicit ? Date.parse(explicit) : NaN;
  if (Number.isFinite(parsed) && parsed > nowMs) return parsed;
  const seconds = Number(text.match(/~(\d+)s\s+remaining/i)?.[1]);
  return nowMs + (Number.isFinite(seconds) ? Math.max(5, seconds) * 1_000 : 60_000);
};

const rawCursor = (value) => {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : value;
};

const chainProfile = (value) => {
  const normalized = String(value || "").trim().toLowerCase();
  if (["sol", "solana", String(SOLANA_CHAIN_ID)].includes(normalized)) {
    return {
      id: SOLANA_CHAIN_ID,
      evm: false,
      slug: "solana",
      name: "Solana",
      gmgn: "sol",
      explorer: "https://solscan.io/token/",
      transactionExplorer: "https://solscan.io/tx/",
    };
  }
  if (["base", String(BASE_CHAIN_ID)].includes(normalized)) {
    return {
      id: BASE_CHAIN_ID,
      evm: true,
      slug: "base",
      name: "Base",
      gmgn: "base",
      explorer: "https://basescan.org/token/",
      transactionExplorer: "https://basescan.org/tx/",
    };
  }
  if (["bsc", "bnb", "bnb chain", "binance smart chain", String(BSC_CHAIN_ID)].includes(normalized)) {
    return {
      id: BSC_CHAIN_ID,
      evm: true,
      slug: "bsc",
      name: "BNB Chain",
      gmgn: "bsc",
      explorer: "https://bscscan.com/token/",
      transactionExplorer: "https://bscscan.com/tx/",
    };
  }
  return null;
};

const isEvmChain = (chain) => chain?.evm === true || [BASE_CHAIN_ID, BSC_CHAIN_ID].includes(Number(chain?.id));

const validToken = (chain, token) => isEvmChain(chain)
  ? isAddress(String(token || ""))
  : chain?.id === SOLANA_CHAIN_ID && BASE58_ADDRESS.test(String(token || ""));

const sameToken = (chain, left, right) => isEvmChain(chain)
  ? String(left || "").toLowerCase() === String(right || "").toLowerCase()
  : String(left || "") === String(right || "");

const tokenKey = (chain, token) => `${chain.slug}:${isEvmChain(chain) ? token.toLowerCase() : token}`;

const arrayFrom = (payload, keys) => {
  if (Array.isArray(payload)) return payload;
  for (const root of [payload, payload?.data, payload?.responseObject, payload?.result]) {
    if (!root || typeof root !== "object") continue;
    for (const key of keys) if (Array.isArray(root[key])) return root[key];
  }
  return [];
};

export function parseCopeLeaderboard(payload) {
  return arrayFrom(payload, ["leaderboard", "users", "traders", "items"])
    .map((row, index) => {
      const handle = String(row?.handle || row?.fomo_handle || row?.userHandle || "").replace(/^@/, "").trim();
      const followers = finite(row?.followers ?? row?.follower_count ?? row?.followersCount);
      const pnl = finite(row?.pnl ?? row?.total_pnl ?? row?.totalPnl);
      const numTrades = finite(row?.num_trades ?? row?.numTrades ?? row?.total_trades);
      const totalVolume = finite(row?.total_volume ?? row?.totalVolume ?? row?.volume);
      if (!HANDLE.test(handle) || followers === null || followers < 0 || numTrades === null || totalVolume === null) return null;
      return {
        id: String(row?.id || row?.user_id || handle.toLowerCase()),
        handle,
        displayName: String(row?.display_name || row?.displayName || handle).trim().slice(0, 100),
        followers,
        pnl,
        numTrades,
        totalVolume,
        leaderboardRank: index + 1,
        solanaAddress: BASE58_ADDRESS.test(String(row?.solana_address || "")) ? row.solana_address : null,
        baseAddress: isAddress(String(row?.base_address || "")) ? row.base_address : null,
        twitter: /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\/?$/i.test(String(row?.twitter || "")) ? row.twitter : null,
      };
    })
    .filter(Boolean);
}

export function selectTopTrafficBloggers(entries, options = {}) {
  const limit = Math.max(1, Number(options.limit || 10));
  const minimumTrades = Math.max(0, Number(options.minimumTrades ?? 20));
  const minimumVolume = Math.max(0, Number(options.minimumVolume ?? 100_000));
  return entries
    .filter((entry) => entry.followers > 0 && entry.numTrades >= minimumTrades && entry.totalVolume >= minimumVolume && (entry.pnl === null || entry.pnl >= 0))
    .sort((left, right) => right.followers - left.followers || (right.pnl ?? 0) - (left.pnl ?? 0) || left.handle.localeCompare(right.handle))
    .slice(0, limit)
    .map((entry, index) => ({ ...entry, trafficRank: index + 1 }));
}

export function parseGmgnBscKolCandidates(payload) {
  const rows = arrayFrom(payload, ["list", "items", "trades"]);
  const observations = [];
  for (const row of rows) {
    const handle = String(row?.maker_info?.twitter_username || row?.twitter_username || "").replace(/^@/, "").trim();
    const wallet = String(row?.maker || row?.wallet || "").trim().toLowerCase();
    const tags = normalizedTags(row?.maker_info?.tags);
    // Discovery is the first fail-closed boundary. A dirty observation must
    // never reach either the identity cache or a later wallet-binding step.
    if (!HANDLE.test(handle) || !isAddress(wallet) || !gmgnTagsAreClean(tags)) continue;
    observations.push({
      handle,
      wallet,
      tags: [...new Set(tags)],
      discoveredAt: epochMs(row?.timestamp ?? row?.block_timestamp ?? row?.created_at),
      source: "gmgn_bsc_kol_feed",
    });
  }

  const byHandle = new Map();
  const handlesByWallet = new Map();
  for (const observation of observations) {
    const handleKey = observation.handle.toLowerCase();
    if (!byHandle.has(handleKey)) byHandle.set(handleKey, []);
    byHandle.get(handleKey).push(observation);
    if (!handlesByWallet.has(observation.wallet)) handlesByWallet.set(observation.wallet, new Map());
    const walletHandles = handlesByWallet.get(observation.wallet);
    const previous = walletHandles.get(handleKey);
    if (!previous || (observation.discoveredAt || 0) >= (previous.discoveredAt || 0)) walletHandles.set(handleKey, observation);
  }

  return [...byHandle.values()].map((matches) => {
    const ranked = [...matches].sort((left, right) => {
      const leftBoth = Number(left.tags.includes("kol") && left.tags.includes("fomo"));
      const rightBoth = Number(right.tags.includes("kol") && right.tags.includes("fomo"));
      const leftFomo = Number(left.tags.includes("fomo"));
      const rightFomo = Number(right.tags.includes("fomo"));
      return rightBoth - leftBoth || rightFomo - leftFomo || (right.discoveredAt || 0) - (left.discoveredAt || 0);
    });
    const selected = ranked[0];
    const wallets = [...new Set(matches.map((match) => match.wallet))].sort();
    const twitterHandles = [...(handlesByWallet.get(selected.wallet)?.keys() || [])].sort();
    const ambiguousWallets = wallets.length > 1;
    const ambiguousHandles = twitterHandles.length > 1;
    return {
      ...selected,
      handle: selected.handle.toLowerCase(),
      wallets,
      twitterHandles,
      ambiguousWallets,
      ambiguousHandles,
      ambiguousIdentity: ambiguousWallets || ambiguousHandles,
    };
  }).sort((left, right) => left.handle.localeCompare(right.handle));
}

export async function discoverGmgnBscKolCandidates(options = {}) {
  const cliPath = String(options.cliPath || "gmgn-cli");
  const limit = Math.max(1, Math.min(100, Number(options.limit || 100)));
  const timeout = Math.max(5_000, Number(options.timeoutMs || 30_000));
  // This discovery path is also used by the X monitor; it must not bypass the
  // account's Plus admission queue or durable 429 cooldown.
  const client=createGmgnFlowClient({dataDir:options.dataDir,gmgnFlowCliPath:cliPath,requestTimeoutMs:timeout});
  try {return parseGmgnBscKolCandidates(await client.trades('bsc','kol',{limit}));}
  finally {await client.stop();}
}

export function parseGmgnBscSmartMoneyBuys(payload, options = {}) {
  const observedAtMs = Number(options.observedAtMs ?? Date.now());
  const observedAt = new Date(observedAtMs).toISOString();
  const includeBlocked = options.includeBlocked === true;
  return arrayFrom(payload, ["list", "items", "trades"])
    .map((row) => {
      const side = String(row?.side || "").trim().toLowerCase();
      const wallet = String(row?.maker || "").trim().toLowerCase();
      const token = String(row?.base_address || "").trim().toLowerCase();
      const transactionHash = exactTransactionHash(row?.transaction_hash);
      const timestampMs = epochMs(row?.timestamp);
      const tags = normalizedTags(row?.maker_info?.tags);
      const blockedTags = tags.filter((tag) => SMART_MONEY_BLOCKED_TAG.test(tag));
      if (side !== "buy" || !isAddress(wallet) || !isAddress(token) || !transactionHash
        || timestampMs === null || (!includeBlocked && blockedTags.length)) return null;
      const amountUsd = finite(row?.amount_usd);
      return {
        scheme: "gmgn_smartmoney_trade_v1",
        wallet,
        token,
        transactionHash,
        logIndex: null,
        side: "buy",
        occurredAt: new Date(timestampMs).toISOString(),
        observedAt,
        timestampMs,
        tags,
        tokenSymbol: String(row?.base_token?.symbol || "?").trim().slice(0, 30) || "?",
        launchpad: String(row?.base_token?.launchpad || "").trim().toLowerCase() || null,
        amountUsd: amountUsd !== null && amountUsd > 0 ? amountUsd : null,
        sourceReportedPositionFlag: Number.isFinite(Number(row?.is_open_or_close)) ? Number(row.is_open_or_close) : null,
        feedSource: "gmgn_track_smartmoney",
        eligible: blockedTags.length === 0,
        blockedTags,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.timestampMs - right.timestampMs || left.transactionHash.localeCompare(right.transactionHash));
}

export async function discoverGmgnBscSmartMoneyBuys(options = {}) {
  const cliPath = String(options.cliPath || "gmgn-cli");
  const limit = Math.max(1, Math.min(200, Number(options.limit || 200)));
  const timeout = Math.max(5_000, Number(options.timeoutMs || 30_000));
  const { stdout } = await execFileAsync(cliPath, ["track", "smartmoney", "--chain", "bsc", "--side", "buy", "--limit", String(limit), "--raw"], {
    encoding: "utf8",
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return parseGmgnBscSmartMoneyBuys(JSON.parse(stdout), {
    observedAtMs: options.observedAtMs,
    includeBlocked: true,
  });
}

export function parseGmgnWalletStats(payload, options = {}) {
  const period = String(options.period || "").toLowerCase();
  const expectedWallet = String(options.wallet || "").toLowerCase();
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.data) ? payload.data : [payload?.data || payload];
  const row = rows.find((item) => String(item?.wallet_address || "").toLowerCase() === expectedWallet);
  const wallet = String(row?.wallet_address || "").toLowerCase();
  const realizedProfitUsd = finite(row?.realized_profit);
  const realizedRoi = finite(row?.realized_profit_pnl);
  const winRate = finite(row?.pnl_stat?.winrate);
  const tokenCount = finite(row?.pnl_stat?.token_num);
  const buyCount = finite(row?.buy);
  const sellCount = finite(row?.sell);
  const lastTradeAt = isoFromEpoch(row?.last_timestamp);
  const createdAt = isoFromEpoch(row?.common?.created_at);
  const createdTokenCount = finite(row?.common?.created_token_count);
  const tags = normalizedTags(row?.common?.tags);
  const checkedAtMs = Number(options.checkedAtMs ?? Date.now());
  if (!["7d", "30d"].includes(period) || !isAddress(wallet) || wallet !== expectedWallet
    || realizedProfitUsd === null || realizedRoi === null || winRate === null || winRate < 0 || winRate > 1
    || tokenCount === null || !Number.isSafeInteger(tokenCount) || tokenCount < 0
    || buyCount === null || !Number.isSafeInteger(buyCount) || buyCount < 0
    || sellCount === null || !Number.isSafeInteger(sellCount) || sellCount < 0
    || !lastTradeAt || !createdAt || createdTokenCount === null
    || !Number.isSafeInteger(createdTokenCount) || createdTokenCount < 0
    || !smartMoneyTagsAreClean(tags)) return null;
  return {
    wallet,
    period,
    realizedProfitUsd,
    winRate,
    realizedRoi,
    tokenCount,
    buyCount,
    sellCount,
    lastTradeAt,
    createdAt,
    createdTokenCount,
    tags,
    checkedAt: new Date(checkedAtMs).toISOString(),
  };
}

export async function fetchGmgnWalletStats(options = {}) {
  const cliPath = String(options.cliPath || "gmgn-cli");
  const wallet = String(options.wallet || "").toLowerCase();
  const period = String(options.period || "").toLowerCase();
  const timeout = Math.max(5_000, Number(options.timeoutMs || 30_000));
  if (!isAddress(wallet) || !["7d", "30d"].includes(period)) throw new Error("invalid GMGN wallet stats request");
  const { stdout } = await execFileAsync(cliPath, ["portfolio", "stats", "--chain", "bsc", "--wallet", wallet, "--period", period, "--raw"], {
    encoding: "utf8",
    timeout,
    maxBuffer: 20 * 1024 * 1024,
    windowsHide: true,
  });
  return parseGmgnWalletStats(JSON.parse(stdout), { wallet, period, checkedAtMs: options.checkedAtMs });
}

export function qualifyGmgnSmartMoneyWallet(sevenDay, thirtyDay, options = {}) {
  const nowMs = Number(options.nowMs ?? Date.now());
  const wallet = String(sevenDay?.wallet || "").toLowerCase();
  const maximumStatsAgeMs = Math.max(60_000, Number(options.maximumStatsAgeMs ?? 2 * 60 * 60_000));
  const minimumWalletAgeMs = Math.max(24 * 60 * 60_000, Number(options.minimumWalletAgeMs ?? 30 * 24 * 60 * 60_000));
  const maximumCreatedTokens = Math.max(0, Number(options.maximumCreatedTokens ?? 10));
  const thresholds = {
    "7d": {
      realizedProfitUsd: Math.max(0, Number(options.minimumProfit7dUsd ?? 3_000)),
      winRate: Math.max(0, Math.min(1, Number(options.minimumWinRate7d ?? 0.60))),
      realizedRoi: Math.max(0, Number(options.minimumRoi7d ?? 0.015)),
      tokenCount: Math.max(1, Number(options.minimumTokenCount7d ?? 50)),
    },
    "30d": {
      realizedProfitUsd: Math.max(0, Number(options.minimumProfit30dUsd ?? 10_000)),
      winRate: Math.max(0, Math.min(1, Number(options.minimumWinRate30d ?? 0.60))),
      realizedRoi: Math.max(0, Number(options.minimumRoi30d ?? 0.015)),
      tokenCount: Math.max(1, Number(options.minimumTokenCount30d ?? 100)),
    },
  };
  if (!isAddress(wallet) || String(thirtyDay?.wallet || "").toLowerCase() !== wallet
    || sevenDay?.period !== "7d" || thirtyDay?.period !== "30d") return null;
  for (const stats of [sevenDay, thirtyDay]) {
    const checkedAt = Date.parse(stats?.checkedAt || "");
    const lastTradeAt = Date.parse(stats?.lastTradeAt || "");
    if (!Number.isFinite(checkedAt) || checkedAt > nowMs + ATTRIBUTION_FUTURE_TOLERANCE_MS || nowMs - checkedAt > maximumStatsAgeMs
      || !Number.isFinite(lastTradeAt) || lastTradeAt > nowMs + ATTRIBUTION_FUTURE_TOLERANCE_MS || nowMs - lastTradeAt > 7 * 24 * 60 * 60_000
      || !smartMoneyTagsAreClean(stats?.tags)) return null;
    const threshold = thresholds[stats.period];
    if (!threshold || Number(stats.realizedProfitUsd) < threshold.realizedProfitUsd
      || Number(stats.winRate) < threshold.winRate || Number(stats.realizedRoi) < threshold.realizedRoi
      || Number(stats.tokenCount) < threshold.tokenCount) return null;
  }
  const createdAtMs = Date.parse(thirtyDay.createdAt || "");
  const createdTokenCount = Math.max(Number(sevenDay.createdTokenCount), Number(thirtyDay.createdTokenCount));
  if (!Number.isFinite(createdAtMs) || createdAtMs > nowMs - minimumWalletAgeMs
    || !Number.isSafeInteger(createdTokenCount) || createdTokenCount > maximumCreatedTokens) return null;
  const tags = [...new Set([...normalizedTags(sevenDay.tags), ...normalizedTags(thirtyDay.tags)])];
  if (!smartMoneyTagsAreClean(tags)) return null;
  return {
    scheme: "gmgn_wallet_stats_dual_window_v1",
    wallet,
    chainId: BSC_CHAIN_ID,
    source: "gmgn_portfolio_stats",
    qualified: true,
    tags,
    createdAt: new Date(createdAtMs).toISOString(),
    createdTokenCount,
    feedObservedAt: null,
    statsCheckedAt: new Date(Math.min(Date.parse(sevenDay.checkedAt), Date.parse(thirtyDay.checkedAt))).toISOString(),
    windows: {
      "7d": {
        realizedProfitUsd: sevenDay.realizedProfitUsd,
        winRate: sevenDay.winRate,
        realizedRoi: sevenDay.realizedRoi,
        tokenCount: sevenDay.tokenCount,
        buyCount: sevenDay.buyCount,
        sellCount: sevenDay.sellCount,
      },
      "30d": {
        realizedProfitUsd: thirtyDay.realizedProfitUsd,
        winRate: thirtyDay.winRate,
        realizedRoi: thirtyDay.realizedRoi,
        tokenCount: thirtyDay.tokenCount,
        buyCount: thirtyDay.buyCount,
        sellCount: thirtyDay.sellCount,
      },
    },
  };
}

export function parseFxTwitterProfile(payload, expectedHandle = "") {
  const user = payload?.user;
  const screenName = String(user?.screen_name || "").replace(/^@/, "").trim();
  const followers = finite(user?.followers);
  const expected = String(expectedHandle || "").replace(/^@/, "").trim();
  if (Number(payload?.code) !== 200 || !HANDLE.test(screenName) || followers === null || followers < 0) return null;
  if (expected && expected.toLowerCase() !== screenName.toLowerCase()) return null;
  return {
    id: String(user?.id || "") || null,
    handle: screenName,
    followers,
    protected: user?.protected === true,
    verification: user?.verification || null,
    source: "fxtwitter_public_profile",
    ...(String(user?.name || "").trim() ? { displayName: String(user.name).replace(/\s+/gu, " ").trim().slice(0, 120) } : {}),
    ...(String(user?.description || user?.bio || "").trim()
      ? { description: String(user.description || user.bio).replace(/\s+/gu, " ").trim().slice(0, 280) }
      : {}),
  };
}

function publicWalletBindingKind(entry, allowGmgnObservedWallets = false, nowMs = Date.now(), maxAttributionAgeMs = GMGN_ATTRIBUTION_MAX_AGE_MS) {
  const binding = entry?.walletBinding;
  const wallet = String(entry?.baseAddress || "").toLowerCase();
  if (!isAddress(wallet) || !binding || typeof binding !== "object") return null;
  if (binding.status === "verified" && binding.verified === true && binding.proofSource === "fomoscan") {
    return "fomoscan_verified";
  }
  const tags = normalizedTags(binding.tags);
  const observedAtMs = Date.parse(binding.observedAt || "");
  if (allowGmgnObservedWallets
    && binding.status === "observed"
    && binding.verified === false
    && binding.proofSource === "gmgn_bsc_kol_feed"
    && String(binding.wallet || "").toLowerCase() === wallet
    && String(binding.twitterHandle || "").toLowerCase() === String(entry.twitterHandle || "").toLowerCase()
    && entry.twitterIdentityObserved === true
    && binding.ambiguousIdentity !== true
    && Number.isFinite(observedAtMs)
    && observedAtMs <= Number(nowMs) + ATTRIBUTION_FUTURE_TOLERANCE_MS
    && Number(nowMs) - observedAtMs <= Math.max(60_000, Number(maxAttributionAgeMs || GMGN_ATTRIBUTION_MAX_AGE_MS))
    && gmgnTagsAreClean(tags)) return "gmgn_observed";
  return null;
}

export function attachGmgnObservedWallet(candidate, profile = null, nowMs = Date.now(), options = {}) {
  const handle = String(candidate?.handle || "").replace(/^@/, "").trim();
  const wallet = String(candidate?.wallet || "").trim().toLowerCase();
  const tags = normalizedTags(candidate?.tags);
  const maxAttributionAgeMs = Math.max(60_000, Number(options.maxAttributionAgeMs || GMGN_ATTRIBUTION_MAX_AGE_MS));
  const observedAtMs = Number(candidate?.discoveredAt);
  // Binding is the second fail-closed boundary. Re-check the source tags even
  // when a caller bypasses the normal GMGN parser in a test or integration.
  if (!HANDLE.test(handle) || !isAddress(wallet) || !gmgnTagsAreClean(tags)) return null;
  if (candidate?.ambiguousIdentity === true || candidate?.ambiguousWallets === true || candidate?.ambiguousHandles === true) return null;
  if (!Number.isFinite(observedAtMs) || observedAtMs <= 0 || observedAtMs > Number(nowMs) + ATTRIBUTION_FUTURE_TOLERANCE_MS || Number(nowMs) - observedAtMs > maxAttributionAgeMs) return null;
  if (profile?.twitterHandle && profile.twitterHandle.toLowerCase() !== handle.toLowerCase()) return null;
  if (profile?.baseAddress && publicWalletBindingKind(profile, false) === "fomoscan_verified") return profile;
  const observedAt = new Date(observedAtMs).toISOString();
  return {
    id: profile?.id || `gmgn:${handle.toLowerCase()}`,
    handle,
    displayName: profile?.displayName || handle,
    followers: profile?.followers || 0,
    fomoFollowers: profile?.fomoFollowers ?? null,
    pnl: profile?.pnl ?? null,
    numTrades: profile?.numTrades || 0,
    totalVolume: profile?.totalVolume || 0,
    leaderboardRank: profile?.leaderboardRank ?? null,
    solanaAddress: profile?.solanaAddress || null,
    baseAddress: wallet,
    twitter: profile?.twitter || `https://x.com/${handle}`,
    twitterHandle: handle,
    twitterIdentityVerified: profile?.twitterIdentityVerified === true,
    twitterIdentityObserved: true,
    twitterIdentitySource: profile ? "fomoscan_x+gmgn_bsc_kol_feed" : "gmgn_bsc_kol_feed",
    fomoCreatedAt: profile?.fomoCreatedAt || null,
    followersSyncedAt: profile?.followersSyncedAt || null,
    profileFreshness: "current",
    walletBinding: {
      status: "observed",
      verified: false,
      proofSource: "gmgn_bsc_kol_feed",
      wallet,
      handle,
      twitterHandle: handle,
      tags,
      observedAt,
      lastCheckedAt: observedAt,
      ambiguousIdentity: false,
      ambiguousWallets: false,
      ambiguousHandles: false,
      candidateSource: "gmgn_bsc_kol_feed",
    },
    candidateSource: "gmgn_bsc_kol_feed",
    origin: "gmgn_bsc_kol_feed",
    ambiguousIdentity: false,
    ambiguousWallets: false,
    ambiguousHandles: false,
    source: profile ? "fomoscan_x+gmgn_bsc_kol_feed" : "gmgn_bsc_kol_feed",
  };
}

export function selectVerifiedBscKols(entries, options = {}) {
  const minimumFollowers = Math.max(0, Number(options.minimumFollowers ?? 10_000));
  const requireTwitter = options.requireTwitter === true;
  const allowGmgnObservedWallets = options.allowGmgnObservedWallets === true;
  const requireBscActivity = options.requireBscActivity === true;
  const requireRecentIdentity = options.requireRecentIdentity === true;
  const requireFreshProofs = options.requireFreshProofs === true;
  const nowMs = Number(options.nowMs || Date.now());
  const maxIdentityAgeMs = Math.max(60_000, Number(options.maxIdentityAgeMs || 30 * 24 * 60 * 60_000));
  const maxXProfileAgeMs = Math.max(60_000, Number(options.maxXProfileAgeMs || 24 * 60 * 60_000));
  const maxAttributionAgeMs = Math.max(60_000, Number(options.maxAttributionAgeMs || GMGN_ATTRIBUTION_MAX_AGE_MS));
  const seenWallets = new Set();
  return entries
    .filter((entry) => {
      const xFollowers = Number(entry?.xFollowers);
      if (!entry || !Number.isFinite(xFollowers) || xFollowers < minimumFollowers || !isAddress(String(entry.baseAddress || ""))) return false;
      const bindingKind = publicWalletBindingKind(entry, allowGmgnObservedWallets, nowMs, maxAttributionAgeMs);
      if (!bindingKind) return false;
      // Selection is the third and final dirty-tag boundary before scanning.
      if (bindingKind === "gmgn_observed" && !gmgnTagsAreClean(entry.walletBinding?.tags)) return false;
      if (requireTwitter && (!entry.twitterHandle || (entry.twitterIdentityVerified !== true && bindingKind !== "gmgn_observed"))) return false;
      if (entry.xProfile?.source !== "fxtwitter_public_profile") return false;
      if (!/^\d+$/.test(String(entry.xProfile?.id || ""))
        || String(entry.xProfile?.handle || "").toLowerCase() !== String(entry.twitterHandle || "").toLowerCase()
        || entry.xProfile?.protected === true) return false;
      const xCheckedAt = Date.parse(entry.xProfile?.checkedAt || "");
      if (!Number.isFinite(xCheckedAt) || nowMs - xCheckedAt > maxXProfileAgeMs) return false;
      if (requireBscActivity && (!(Number(entry.bscTransactionCount) > 0) || !Number.isFinite(Date.parse(entry.bscActivityCheckedAt || "")))) return false;
      if (requireRecentIdentity || requireFreshProofs) {
        const followerAt = Date.parse(entry.xProfile?.checkedAt || entry.followersSyncedAt || "");
        const walletAt = Date.parse(entry.walletBinding?.lastCheckedAt || entry.walletBinding?.verifiedAt || entry.walletBinding?.observedAt || "");
        const bscAt = Date.parse(entry.bscActivityCheckedAt || "");
        if (!Number.isFinite(followerAt) || !Number.isFinite(walletAt)) return false;
        if (nowMs - followerAt > maxIdentityAgeMs || nowMs - walletAt > maxIdentityAgeMs) return false;
        if (requireFreshProofs && (!Number.isFinite(bscAt) || nowMs - bscAt > maxIdentityAgeMs)) return false;
      }
      if (bindingKind === "fomoscan_verified" && requireFreshProofs) {
        if (String(entry.walletBinding?.wallet || "").toLowerCase() !== String(entry.baseAddress || "").toLowerCase()
          || String(entry.walletBinding?.handle || entry.walletBinding?.twitterHandle || "").toLowerCase() !== String(entry.twitterHandle || "").toLowerCase()
          || String(entry.walletBinding?.xProfileId || "") !== String(entry.xProfile.id)) return false;
      }
      return true;
    })
    .sort((left, right) => right.xFollowers - left.xFollowers || (right.totalVolume || 0) - (left.totalVolume || 0) || left.handle.localeCompare(right.handle))
    .filter((entry) => {
      const wallet = entry.baseAddress.toLowerCase();
      if (seenWallets.has(wallet)) return false;
      seenWallets.add(wallet);
      return true;
    })
    .map((entry, index) => ({ ...entry, fomoFollowers: entry.followers, followers: entry.xFollowers, trafficRank: index + 1 }));
}

export function selectFreshFomoXCallRoster(payload, options = {}) {
  const nowMs = Number(options.nowMs || Date.now());
  const maximumStateAgeMs = Math.max(60_000, Number(options.maximumStateAgeMs || 10 * 60_000));
  const maximumProofAgeMs = Math.max(60_000, Number(options.maximumProofAgeMs || 24 * 60 * 60_000));
  const minimumFollowers = Math.max(0, Number(options.minimumFollowers ?? 10_000));
  const healthAt = payload?.health?.checkedAt;
  if (Number(payload?.version || 0) < FOMO_X_CALL_STATE_VERSION) {
    return { status: "stale", reason: "fomo_x_call_state_version_unsupported", profiles: [] };
  }
  if (!String(payload?.health?.status || "").startsWith("healthy")
    || !freshTimestamp(healthAt, nowMs, maximumStateAgeMs)) {
    return { status: "stale", reason: "fomo_x_call_health_not_fresh", profiles: [] };
  }
  const roster = payload?.roster && typeof payload.roster === "object" ? payload.roster : {};
  const candidates = [];
  for (const [key, candidate] of Object.entries(roster)) {
    const handle = String(candidate?.handle || "").replace(/^@/, "").trim();
    const handleKey = handle.toLowerCase();
    const wallet = String(candidate?.wallet || "").toLowerCase();
    const tags = normalizedTags(candidate?.tags);
    const profile = candidate?.xProfile;
    const bscActivity = candidate?.bscActivity;
    if (key.toLowerCase() !== handleKey || !HANDLE.test(handle) || !isAddress(wallet)
      || candidate?.ambiguousIdentity !== false || candidate?.ambiguousWallets !== false || candidate?.ambiguousHandles !== false
      || !gmgnTagsAreClean(tags)
      || !Number.isFinite(Number(candidate?.discoveredAt))
      || Number(candidate.discoveredAt) > nowMs + ATTRIBUTION_FUTURE_TOLERANCE_MS
      || nowMs - Number(candidate.discoveredAt) > maximumProofAgeMs
      || !/^\d+$/.test(String(profile?.id || ""))
      || String(profile?.handle || "").toLowerCase() !== handleKey
      || profile?.protected === true
      || Number(profile?.followers) < minimumFollowers
      || !freshTimestamp(profile?.checkedAt, nowMs, maximumProofAgeMs)
      || String(bscActivity?.wallet || "").toLowerCase() !== wallet
      || !Number.isSafeInteger(Number(bscActivity?.count)) || Number(bscActivity.count) <= 0
      || !freshTimestamp(bscActivity?.checkedAt, nowMs, maximumProofAgeMs)) continue;

    let mapped;
    if (candidate?.source === "fomoscan_verified_profile") {
      const binding = candidate.walletBinding;
      const bindingHandle = String(binding?.handle || binding?.twitterHandle || "").toLowerCase();
      const bindingCheckedAt = binding?.checkedAt || binding?.lastCheckedAt;
      if (binding?.status !== "verified" || binding?.verified !== true || binding?.proofSource !== "fomoscan"
        || String(binding?.wallet || "").toLowerCase() !== wallet || bindingHandle !== handleKey
        || !freshTimestamp(bindingCheckedAt, nowMs, maximumProofAgeMs)) continue;
      mapped = {
        id: handleKey,
        handle,
        displayName: handle,
        followers: Number(profile.followers),
        xFollowers: Number(profile.followers),
        baseAddress: wallet,
        twitter: `https://x.com/${handle}`,
        twitterHandle: handle,
        twitterIdentityVerified: true,
        twitterIdentityObserved: false,
        xProfile: { ...profile, source: "fxtwitter_public_profile" },
        bscTransactionCount: Number(bscActivity.count),
        bscActivityCheckedAt: bscActivity.checkedAt,
        walletBinding: {
          ...binding,
          status: "verified",
          verified: true,
          proofSource: "fomoscan",
          wallet,
          handle,
          twitterHandle: handle,
          xProfileId: String(profile.id),
          checkedAt: bindingCheckedAt,
          lastCheckedAt: bindingCheckedAt,
          ambiguousIdentity: false,
          ambiguousWallets: false,
          ambiguousHandles: false,
          candidateSource: "fomoscan_verified_profile",
        },
        candidateSource: "fomoscan_verified_profile",
        origin: "fomoscan_verified_profile",
        ambiguousIdentity: false,
        ambiguousWallets: false,
        ambiguousHandles: false,
        followersSyncedAt: profile.checkedAt,
        profileFreshness: "fresh",
        sourceCheckedAt: healthAt,
        source: "fomoscan_verified_profile+fxtwitter+bsc_activity",
      };
    } else if (candidate?.source === "gmgn_bsc_kol_feed") {
      const observed = attachGmgnObservedWallet({
        ...candidate,
        handle,
        wallet,
        tags,
        source: "gmgn_bsc_kol_feed",
      }, null, nowMs, { maxAttributionAgeMs: maximumProofAgeMs });
      if (!observed) continue;
      mapped = {
        ...observed,
        followers: Number(profile.followers),
        xFollowers: Number(profile.followers),
        xProfile: { ...profile, source: "fxtwitter_public_profile" },
        bscTransactionCount: Number(bscActivity.count),
        bscActivityCheckedAt: bscActivity.checkedAt,
        followersSyncedAt: profile.checkedAt,
        profileFreshness: "fresh",
        sourceCheckedAt: healthAt,
      };
    } else continue;
    candidates.push(mapped);
  }

  const walletCounts = new Map();
  for (const profile of candidates) {
    const wallet = profile.baseAddress.toLowerCase();
    walletCounts.set(wallet, Number(walletCounts.get(wallet) || 0) + 1);
  }
  const profiles = candidates.filter((profile) => walletCounts.get(profile.baseAddress.toLowerCase()) === 1);
  return {
    status: profiles.length ? "healthy" : "empty",
    reason: profiles.length ? null : "no_fresh_admitted_fomo_x_call_profiles",
    checkedAt: healthAt,
    profiles,
  };
}

export function classifyFomoAlertDelivery(delivery) {
  const status = delivery?.status;
  if (["delivered", "queued"].includes(status)) return "accepted";
  if (isTerminalAlertSuppression(delivery)) return "suppressed";
  throw new Error(`Fomo alert sender returned an unknown status: ${String(status || "missing")}`);
}

export function parseFomoScanProfile(payload, requestedHandle = "") {
  const row = payload?.user || payload?.data?.user || payload?.data || payload;
  const handle = String(row?.username || row?.handle || requestedHandle).replace(/^@/, "").trim();
  const followers = finite(row?.social?.followers ?? row?.followers);
  const numTrades = finite(row?.fomoStats?.numTrades ?? row?.fomoStats?.swapCount ?? row?.numTrades) ?? 0;
  const totalVolume = finite(row?.fomoStats?.totalVolume ?? row?.totalVolume) ?? 0;
  const solana = row?.wallets?.solana;
  const evm = row?.wallets?.evm;
  const solanaAddress = solana?.status === "verified" && BASE58_ADDRESS.test(String(solana?.address || "")) ? solana.address : null;
  const baseAddress = evm?.status === "verified" && isAddress(String(evm?.address || "")) ? evm.address : null;
  const twitterMatch = String(row?.twitter || "").match(/^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i);
  const twitter = twitterMatch ? row.twitter : null;
  const requested = String(requestedHandle || "").replace(/^@/, "").trim();
  if (!HANDLE.test(handle) || (followers !== null && followers < 0)) return null;
  if (requested && requested.toLowerCase() !== handle.toLowerCase()) return null;
  const walletBinding = {
    status: baseAddress ? "verified" : String(evm?.status || "unverified").toLowerCase(),
    verified: Boolean(baseAddress),
    proofSource: "fomoscan",
    verifiedAt: evm?.verifiedAt || null,
    lastCheckedAt: evm?.lastCheckedAt || null,
  };
  return {
    id: handle.toLowerCase(),
    handle,
    displayName: String(row?.displayName || handle).trim().slice(0, 100),
    followers: followers ?? 0,
    fomoFollowers: followers,
    pnl: null,
    numTrades,
    totalVolume,
    leaderboardRank: null,
    solanaAddress,
    baseAddress,
    twitter,
    twitterHandle: twitterMatch?.[1] || null,
    twitterIdentityVerified: Boolean(twitterMatch),
    fomoCreatedAt: row?.fomoCreatedAt || null,
    followersSyncedAt: row?.social?.followersLastSyncedAt || null,
    profileFreshness: String(payload?.freshness?.staleness || "unknown").slice(0, 30),
    walletBinding,
    source: "fomoscan_public_wallet_map",
  };
}

function solanaWalletSigned(message, wallet, walletIndex) {
  const key = message?.accountKeys?.[walletIndex];
  if (key && typeof key === "object" && "signer" in key) return key.signer === true;
  const required = finite(message?.header?.numRequiredSignatures);
  return required !== null && walletIndex < Math.max(0, Math.trunc(required));
}

function solanaWalletTokenRows(items, message, wallet) {
  if (!Array.isArray(items) || !Array.isArray(message?.accountKeys)) return null;
  const rows = new Map();
  for (const item of items) {
    if (String(item?.owner || "") !== wallet) continue;
    const accountIndex = finite(item?.accountIndex);
    const mint = String(item?.mint || "");
    const programId = String(item?.programId || "");
    const raw = String(item?.uiTokenAmount?.amount || "");
    const decimals = finite(item?.uiTokenAmount?.decimals);
    if (accountIndex === null || !Number.isSafeInteger(accountIndex) || accountIndex < 0 || accountIndex >= message.accountKeys.length ||
      !BASE58_ADDRESS.test(mint) || !SOLANA_TOKEN_PROGRAMS.has(programId) || !/^\d+$/.test(raw) ||
      decimals === null || !Number.isSafeInteger(decimals) || decimals < 0 || decimals > 255 || rows.has(accountIndex)) return null;
    const accountKey = message.accountKeys[accountIndex];
    const address = typeof accountKey === "string" ? accountKey : accountKey?.pubkey;
    const writable = typeof accountKey === "object" && accountKey?.writable === true;
    if (!BASE58_ADDRESS.test(String(address || ""))) return null;
    rows.set(accountIndex, { accountIndex, address, writable, mint, programId, raw: BigInt(raw), decimals });
  }
  return rows;
}

function solanaMintTotals(rows) {
  const totals = new Map();
  for (const row of rows.values()) {
    const previous = totals.get(row.mint);
    if (previous && previous.decimals !== row.decimals) return null;
    totals.set(row.mint, { raw: (previous?.raw || 0n) + row.raw, decimals: row.decimals });
  }
  return totals;
}

function solanaFirstBuyCandidates(transaction, wallet, signature) {
  if (!transaction?.meta || transaction.meta.err || !transaction.transaction?.message) return [];
  const slot = finite(transaction.slot);
  if (slot === null || !Number.isSafeInteger(slot) || slot < 0) return [];
  const logs = (transaction.meta.logMessages || []).join(" ");
  if (!/(?:instruction:\s*swap|jupiter|raydium|orca|meteora|pump)/i.test(logs)) return [];
  const message = transaction.transaction.message;
  const keys = (message.accountKeys || []).map((item) => typeof item === "string" ? item : item?.pubkey);
  const walletIndex = keys.indexOf(wallet);
  if (walletIndex < 0 || !solanaWalletSigned(message, wallet, walletIndex)) return [];
  const preRows = solanaWalletTokenRows(transaction.meta.preTokenBalances, message, wallet);
  const postRows = solanaWalletTokenRows(transaction.meta.postTokenBalances, message, wallet);
  if (!preRows || !postRows) return [];
  const pre = solanaMintTotals(preRows);
  const post = solanaMintTotals(postRows);
  if (!pre || !post) return [];
  const negativeToken = [...new Set([...pre.keys(), ...post.keys()])].some((mint) => (post.get(mint)?.raw || 0n) < (pre.get(mint)?.raw || 0n));
  let nativeDelta;
  try {
    nativeDelta = BigInt(transaction.meta.postBalances?.[walletIndex]) - BigInt(transaction.meta.preBalances?.[walletIndex]);
  } catch { return []; }
  const walletFee = walletIndex === 0 ? BigInt(transaction.meta.fee || 0) : 0n;
  const paidNative = nativeDelta < -walletFee;
  if (!negativeToken && !paidNative) return [];
  const usdcBefore = pre.get(SOLANA_USDC);
  const usdcAfter = post.get(SOLANA_USDC);
  const usdcSpentRaw = (usdcBefore?.raw || 0n) - (usdcAfter?.raw || 0n);
  const usdcSpent = usdcSpentRaw > 0n ? Number(usdcSpentRaw) / (10 ** (usdcBefore?.decimals ?? usdcAfter?.decimals ?? 6)) : null;
  const nativeSpentLamports = paidNative ? -nativeDelta - walletFee : 0n;
  const timestampMs = epochMs(transaction.blockTime);
  if (timestampMs === null) return [];
  const chain = chainProfile("solana");
  const calls = [];
  for (const [mint, after] of post) {
    const before = pre.get(mint)?.raw || 0n;
    const netAcquired = after.raw - before;
    if (mint === SOLANA_USDC || before !== 0n || netAcquired <= 0n) continue;
    const outputTokenAccounts = [...postRows.values()].filter((row) => row.mint === mint).flatMap((row) => {
      const previous = preRows.get(row.accountIndex);
      if (previous && (previous.mint !== row.mint || previous.programId !== row.programId || previous.decimals !== row.decimals)) return [];
      const preRaw = previous?.raw || 0n;
      const deltaRaw = row.raw - preRaw;
      if (!row.writable || deltaRaw <= 0n) return [];
      return [{
        address: row.address,
        accountIndex: row.accountIndex,
        tokenProgram: row.programId,
        preRaw: preRaw.toString(),
        postRaw: row.raw.toString(),
        deltaRaw: deltaRaw.toString(),
      }];
    });
    if (!outputTokenAccounts.length) continue;
    const tokenAmount = Number(netAcquired) / (10 ** after.decimals);
    if (!Number.isFinite(tokenAmount) || tokenAmount <= 0) continue;
    calls.push({
      callId: `${signature}:${mint}`,
      kind: "top_blogger_first_buy",
      chain,
      token: mint,
      symbol: "?",
      amountUsd: Number.isFinite(usdcSpent) && usdcSpent > 0 ? usdcSpent : null,
      amountNative: nativeSpentLamports > 0n ? Number(nativeSpentLamports) / 1_000_000_000 : null,
      paymentToken: Number.isFinite(usdcSpent) && usdcSpent > 0 ? SOLANA_USDC : (nativeSpentLamports > 0n ? SOLANA_WSOL : null),
      paymentRaw: Number.isFinite(usdcSpent) && usdcSpent > 0 ? usdcSpentRaw.toString() : (nativeSpentLamports > 0n ? nativeSpentLamports.toString() : null),
      paymentSymbol: Number.isFinite(usdcSpent) && usdcSpent > 0 ? "USDC" : (nativeSpentLamports > 0n ? "SOL" : null),
      paymentVerification: "wallet_balance_delta",
      valuationBasis: Number.isFinite(usdcSpent) && usdcSpent > 0 ? "verified_wallet_net_outflow" : "transaction_native_balance_delta",
      tokenAmount,
      receivedRaw: netAcquired.toString(),
      touchedPreRaw: before.toString(),
      outputTokenAccounts,
      timestamp: transaction.blockTime,
      timestampMs,
      slot,
      blockNumber: slot,
      transactionHash: signature,
      walletAddress: wallet,
      firstBuyVerified: false,
      swapVerified: true,
    });
  }
  return calls;
}

function exactHistoricalPositionProof(proofs, call, wallet, signature) {
  const proof = proofs instanceof Map ? proofs.get(call.token) : proofs?.[call.token];
  if (!proof || proof.status !== "verified" || proof.complete !== true || proof.walletSignerVerified !== true ||
    proof.outputOwnerVerified !== true || proof.scope !== "wallet_mint_all_token_accounts" ||
    proof.phase !== "immediately_before_transaction" || proof.source !== "historical_owner_state" ||
    String(proof.wallet || "") !== wallet || String(proof.signature || "") !== signature ||
    String(proof.mint || "") !== call.token || Number(proof.slot) !== call.slot ||
    String(proof.totalWalletPreRaw ?? "") !== "0" || String(proof.netAcquiredRaw ?? "") !== call.receivedRaw) return null;
  return proof;
}

function hasExactSolanaFirstPosition(call) {
  const proof = call?.positionProof;
  return call?.firstBuyVerified === true && proof?.status === "verified" && proof?.complete === true &&
    proof?.walletSignerVerified === true && proof?.outputOwnerVerified === true &&
    proof?.scope === "wallet_mint_all_token_accounts" && proof?.phase === "immediately_before_transaction" &&
    proof?.source === "historical_owner_state" && proof?.totalWalletPreRaw === "0" &&
    String(proof?.mint || "") === String(call?.token || "") &&
    String(proof?.signature || "") === String(call?.transactionHash || "");
}

export function detectSolanaFirstBuys(transaction, wallet, signature, historicalPositionProofs = null) {
  if (!historicalPositionProofs) return [];
  return solanaFirstBuyCandidates(transaction, wallet, signature)
    .flatMap((call) => {
      const historical = exactHistoricalPositionProof(historicalPositionProofs, call, wallet, signature);
      if (!historical) return [];
      return [{
        ...call,
        firstBuyVerified: true,
        positionProof: {
          ...historical,
          outputTokenAccounts: call.outputTokenAccounts,
          touchedPreRaw: call.touchedPreRaw,
        },
      }];
    });
}

function topicAddress(value) {
  return /^0x[a-fA-F0-9]{64}$/.test(String(value || "")) ? `0x${value.slice(-40)}`.toLowerCase() : null;
}

function evmTransferDeltas(receipt, wallet) {
  const deltas = new Map();
  for (const log of receipt?.logs || []) {
    if (String(log?.topics?.[0] || "").toLowerCase() !== TRANSFER_TOPIC || log.topics.length < 3 || !/^0x[0-9a-fA-F]{64}$/.test(String(log.data || ""))) continue;
    const from = topicAddress(log.topics[1]);
    const to = topicAddress(log.topics[2]);
    if (!from || !to) continue;
    const amount = BigInt(log.data);
    const token = String(log.address).toLowerCase();
    let delta = deltas.get(token) || 0n;
    if (from === wallet.toLowerCase()) delta -= amount;
    if (to === wallet.toLowerCase()) delta += amount;
    if (delta !== 0n) deltas.set(token, delta); else deltas.delete(token);
  }
  return deltas;
}

async function evmZeroPositionTokenAmount(provider, token, wallet, block, delta) {
  let previous;
  let proofSource = "archive_balance_at_previous_block";
  const previousBlock = Math.max(0, Number(block.number) - 1);
  try {
    const previousRaw = await provider.call({
      to: token,
      data: ERC20.encodeFunctionData("balanceOf", [wallet]),
      blockTag: previousBlock,
    });
    previous = ERC20.decodeFunctionResult("balanceOf", previousRaw)[0];
  } catch (error) {
    if (provider?.failOnProofError && error?.code !== "CALL_EXCEPTION") throw error;
    try {
      if (typeof provider?.getCode !== "function") throw error;
      const [previousCode, currentCode] = await Promise.all([
        provider.getCode(token, previousBlock),
        provider.getCode(token, block.number),
      ]);
      const validCode = (value) => /^0x(?:[0-9a-f]{2})*$/i.test(String(value || ""));
      if (!validCode(previousCode) || !validCode(currentCode)) {
        const codeShapeError = new Error("historical token code proof returned malformed bytecode");
        if (provider?.failOnProofError) throw codeShapeError;
        return null;
      }
      if (previousCode !== "0x" || currentCode === "0x") {
        if (provider?.failOnProofError) throw new Error("historical balance revert did not prove a same-block token creation");
        return null;
      }
      previous = 0n;
      proofSource = "token_created_in_current_block";
    } catch (codeError) {
      if (provider?.failOnProofError) throw codeError;
      return null;
    }
  }
  if (previous !== 0n) return null;
  try {
    const decimalsRaw = await provider.call({ to: token, data: ERC20.encodeFunctionData("decimals"), blockTag: block.number });
    const decimals = Number(ERC20.decodeFunctionResult("decimals", decimalsRaw)[0]);
    const tokenAmount = Number(formatUnits(delta, decimals));
    return Number.isFinite(tokenAmount) && tokenAmount > 0 ? {
      tokenAmount,
      decimals,
      previousBlock,
      previousBalanceRaw: "0",
      proofSource,
    } : null;
  } catch (error) {
    if (provider?.failOnProofError) throw error;
    return null;
  }
}

export async function detectEvmFirstBuys(provider, transaction, receipt, block, wallet, chainValue = "base") {
  if (!receipt || Number(receipt.status) !== 1 || String(transaction?.from || "").toLowerCase() !== wallet.toLowerCase()) return [];
  const swapEmitters = new Set((receipt.logs || [])
    .filter((log) => SWAP_TOPICS.has(String(log?.topics?.[0] || "").toLowerCase()))
    .map((log) => String(log.address || "").toLowerCase()));
  if (!swapEmitters.size) return [];
  const deltas = evmTransferDeltas(receipt, wallet);
  const paidAsset = [...deltas.values()].some((delta) => delta < 0n) || BigInt(transaction.value || 0) > 0n;
  if (!paidAsset) return [];
  const timestampMs = epochMs(block?.timestamp);
  if (timestampMs === null) return [];
  const chain = chainProfile(chainValue);
  if (!chain?.evm) return [];
  const calls = [];
  for (const [token, delta] of deltas) {
    if (delta <= 0n || !isAddress(token)) continue;
    const executionPools = [...swapEmitters].filter((emitter) => (receipt.logs || []).some((log) => {
      if (String(log?.address || "").toLowerCase() !== token || String(log?.topics?.[0] || "").toLowerCase() !== TRANSFER_TOPIC) return false;
      return topicAddress(log.topics?.[1]) === emitter || topicAddress(log.topics?.[2]) === emitter;
    }));
    if (!executionPools.length) continue;
    const position = await evmZeroPositionTokenAmount(provider, token, wallet, block, delta);
    if (position !== null) {
      calls.push({
        callId: `${transaction.hash}:${token}`,
        kind: "top_blogger_first_buy",
        chain,
        token,
        symbol: "?",
        amountUsd: null,
        amountNative: null,
        tokenAmount: position.tokenAmount,
        receivedRaw: delta.toString(),
        timestamp: block.timestamp,
        timestampMs,
        blockNumber: Number(block.number),
        transactionHash: transaction.hash,
        walletAddress: wallet,
        firstBuyVerified: true,
        swapVerified: true,
        executionPool: executionPools.length === 1 ? executionPools[0] : null,
        executionPools,
        positionProof: {
          status: "verified",
          complete: true,
          phase: "previous_block",
          source: position.proofSource,
          wallet,
          token,
          previousBlock: position.previousBlock,
          previousBalanceRaw: position.previousBalanceRaw,
          transactionHash: transaction.hash,
          blockNumber: Number(block.number),
        },
      });
    }
  }
  if (calls.length !== 1) return [];
  const call = calls[0];
  const nativeValue = BigInt(transaction.value || 0);
  const spentTokens = [...deltas.entries()].filter(([, delta]) => delta < 0n);
  if (nativeValue > 0n && spentTokens.length === 0) {
    call.paymentToken = ZERO_ADDRESS;
    call.paymentRaw = nativeValue.toString();
    call.amountNative = Number(formatUnits(nativeValue, 18));
    call.paymentVerification = "transaction_native_value";
    call.valuationBasis = "transaction_native_value";
  } else if (nativeValue === 0n && spentTokens.length === 1) {
    call.paymentToken = spentTokens[0][0];
    call.paymentRaw = (-spentTokens[0][1]).toString();
    call.paymentVerification = "wallet_erc20_net_outflow";
    call.valuationBasis = "verified_wallet_net_outflow";
  } else {
    call.paymentVerification = "ambiguous_multi_asset_outflow";
    call.valuationBasis = "estimated_received_token_value";
  }
  return [call];
}

export async function detectBaseFirstBuys(provider, transaction, receipt, block, wallet) {
  return detectEvmFirstBuys(provider, transaction, receipt, block, wallet, "base");
}

async function configuredCurveQuote(provider, candidate, block) {
  try {
    if (candidate.platformId === "flap") {
      const raw = await provider.call({
        to: candidate.launcher,
        data: FLAP_TOKEN_STATE.encodeFunctionData("getTokenV5", [candidate.token]),
        blockTag: block.number,
      });
      const state = FLAP_TOKEN_STATE.decodeFunctionResult("getTokenV5", raw)[0];
      const quoteToken = String(state.quoteTokenAddress).toLowerCase();
      if (!isAddress(quoteToken)) return null;
      return { quoteToken, status: Number(state.status), reserve: BigInt(state.reserve) };
    }
    if (candidate.curveVersion === "four-v2") {
      const raw = await provider.call({
        to: candidate.launcher,
        data: FOUR_TOKEN_INFO.encodeFunctionData("_tokenInfos", [candidate.token]),
        blockTag: block.number,
      });
      const info = FOUR_TOKEN_INFO.decodeFunctionResult("_tokenInfos", raw);
      if (String(info.base).toLowerCase() !== candidate.token.toLowerCase()) return null;
      const quoteToken = String(info.quote).toLowerCase();
      if (!isAddress(quoteToken)) return null;
      return { quoteToken, status: Number(info.status), reserve: BigInt(info.funds) };
    }
    return { quoteToken: ZERO_ADDRESS, status: null, reserve: null };
  } catch (error) {
    if (provider?.failOnProofError) throw error;
    return null;
  }
}

export async function detectOfficialBscCurveBuys(provider, transaction, receipt, block, wallet, fourManagers = DEFAULT_FOUR_MEME_MANAGERS) {
  if (!receipt || Number(receipt.status) !== 1 || String(transaction?.from || "").toLowerCase() !== wallet.toLowerCase()) return [];
  const sentNative = BigInt(transaction.value || 0);
  const managerSet = new Set([...fourManagers].map((address) => String(address).toLowerCase()));
  const deltas = evmTransferDeltas(receipt, wallet);
  const timestampMs = epochMs(block?.timestamp);
  if (timestampMs === null) return [];
  const chain = chainProfile("bsc");
  const candidates = [];
  for (const log of receipt.logs || []) {
    const launcher = String(log?.address || "").toLowerCase();
    const topic = String(log?.topics?.[0] || "").toLowerCase();
    try {
      if (FLAP_BSC_PORTALS.has(launcher) && topic === FLAP_CURVE.getEvent("TokenBought").topicHash.toLowerCase()) {
        const parsed = FLAP_CURVE.parseLog(log);
        const token = String(parsed.args.token).toLowerCase();
        const buyer = String(parsed.args.buyer).toLowerCase();
        const eventSpend = BigInt(parsed.args.eth) + BigInt(parsed.args.fee);
        if (buyer === wallet.toLowerCase() && isAddress(token) && (deltas.get(token) || 0n) > 0n) {
          candidates.push({ token, launcher, curveVersion: "flap", platformId: "flap", platformName: "Flap", eventSpend, evidenceUrl: "https://docs.flap.sh/dev/trade-tokens" });
        }
      } else if (managerSet.has(launcher) && topic === FOUR_CURVE_V1.getEvent("TokenPurchase").topicHash.toLowerCase()) {
        const parsed = FOUR_CURVE_V1.parseLog(log);
        const token = String(parsed.args.token).toLowerCase();
        const account = String(parsed.args.account).toLowerCase();
        const eventSpend = BigInt(parsed.args.etherAmount) + BigInt(parsed.args.fee);
        if (account === wallet.toLowerCase() && isAddress(token) && (deltas.get(token) || 0n) > 0n) {
          candidates.push({ token, launcher, curveVersion: "four-v1", platformId: "fourmeme", platformName: "Four.Meme", eventSpend, evidenceUrl: "https://four-meme.gitbook.io/four.meme/brand/protocol-integration" });
        }
      } else if (managerSet.has(launcher) && topic === FOUR_CURVE_V2.getEvent("TokenPurchase").topicHash.toLowerCase()) {
        const parsed = FOUR_CURVE_V2.parseLog(log);
        const token = String(parsed.args.token).toLowerCase();
        const account = String(parsed.args.account).toLowerCase();
        const eventSpend = BigInt(parsed.args.cost) + BigInt(parsed.args.fee);
        if (account === wallet.toLowerCase() && isAddress(token) && (deltas.get(token) || 0n) > 0n) {
          candidates.push({ token, launcher, curveVersion: "four-v2", platformId: "fourmeme", platformName: "Four.Meme", eventSpend, evidenceUrl: "https://four-meme.gitbook.io/four.meme/brand/protocol-integration" });
        }
      }
    } catch (error) {
      if (provider?.failOnProofError) throw error;
      // Exact official event with malformed data is rejected in non-strict standalone parsing.
    }
  }
  const calls = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate.token)) continue;
    seen.add(candidate.token);
    const delta = deltas.get(candidate.token) || 0n;
    const configured = await configuredCurveQuote(provider, candidate, block);
    if (!configured) continue;
    const configuredQuote = configured.quoteToken;
    let paymentToken;
    let paymentRaw;
    let paymentVerification;
    if (configuredQuote && configuredQuote !== ZERO_ADDRESS) {
      const quoteDelta = deltas.get(configuredQuote) || 0n;
      const actualQuoteSpend = quoteDelta < 0n ? -quoteDelta : 0n;
      if (actualQuoteSpend > 0n) {
        const difference = actualQuoteSpend > candidate.eventSpend
          ? actualQuoteSpend - candidate.eventSpend
          : candidate.eventSpend - actualQuoteSpend;
        const tolerance = candidate.eventSpend / 50n > 10n ? candidate.eventSpend / 50n : 10n;
        if (candidate.eventSpend <= 0n || difference > tolerance) continue;
        paymentToken = configuredQuote;
        paymentRaw = actualQuoteSpend;
        paymentVerification = "official_event+erc20_transfer";
      }
    }
    if (!paymentRaw && configuredQuote === ZERO_ADDRESS && sentNative > 0n) {
      paymentToken = ZERO_ADDRESS;
      paymentRaw = candidate.eventSpend > 0n && candidate.eventSpend <= sentNative
        ? candidate.eventSpend
        : sentNative;
      paymentVerification = "official_event+native_value";
    }
    if (!paymentRaw || paymentRaw <= 0n) continue;
    const position = await evmZeroPositionTokenAmount(provider, candidate.token, wallet, block, delta);
    if (position === null) continue;
    calls.push({
      callId: `${transaction.hash}:${candidate.token}:curve`,
      kind: "top_blogger_first_buy",
      chain,
      token: candidate.token,
      symbol: "?",
      amountUsd: null,
      amountNative: paymentToken === ZERO_ADDRESS ? Number(formatUnits(paymentRaw, 18)) : null,
      tokenAmount: position.tokenAmount,
      receivedRaw: delta.toString(),
      paymentToken,
      paymentRaw: paymentRaw.toString(),
      paymentVerification,
      curveQuoteToken: configuredQuote,
      curveStatusAtBuy: configured?.status ?? null,
      curveReserveRawAtBuy: configured?.reserve?.toString() || null,
      eventSpendRaw: candidate.eventSpend.toString(),
      timestamp: block.timestamp,
      timestampMs,
      blockNumber: Number(block.number),
      transactionHash: transaction.hash,
      walletAddress: wallet,
      firstBuyVerified: true,
      curveBuyVerified: true,
      curveVersion: candidate.curveVersion,
      launchpad: {
        id: candidate.platformId,
        name: candidate.platformName,
        launcher: candidate.launcher,
        evidenceUrl: candidate.evidenceUrl,
      },
      executionPool: candidate.launcher,
      executionPools: [candidate.launcher],
      positionProof: {
        status: "verified",
        complete: true,
        phase: "previous_block",
        source: position.proofSource,
        wallet,
        token: candidate.token,
        previousBlock: position.previousBlock,
        previousBalanceRaw: position.previousBalanceRaw,
        transactionHash: transaction.hash,
        blockNumber: Number(block.number),
      },
    });
  }
  return calls;
}

export function parseCopeActivities(payload) {
  return arrayFrom(payload, ["activities", "activity", "items", "trades"])
    .map((row) => {
      const action = String(row?.action || row?.side || "").toLowerCase();
      if (action !== "buy") return null;
      const chain = chainProfile(row?.chain ?? row?.network ?? row?.chain_id);
      const handle = String(row?.fomo_handle || row?.handle || row?.user_handle || "").replace(/^@/, "").trim();
      const token = String(row?.token_mint || row?.token_address || row?.tokenAddress || "").trim();
      const amountUsd = finite(row?.usd_amount ?? row?.amount_usd ?? row?.usdAmount);
      const timestamp = row?.timestamp ?? row?.created_at ?? row?.createdAt;
      const timestampMs = epochMs(timestamp);
      if (!chain || !HANDLE.test(handle) || !validToken(chain, token) || amountUsd === null || amountUsd <= 0 || timestampMs === null) return null;
      const transactionHash = String(row?.tx_hash || row?.transaction_hash || row?.signature || "").trim() || null;
      const rawBlockNumber = finite(row?.block_number ?? row?.blockNumber ?? row?.slot);
      const blockNumber = rawBlockNumber !== null && Number.isSafeInteger(rawBlockNumber) && rawBlockNumber >= 0 ? rawBlockNumber : null;
      const callId = String(row?.id || row?.activity_id || transactionHash || `${handle}:${chain.slug}:${token}:${timestamp}:${amountUsd}`);
      return {
        callId,
        kind: "top_blogger_first_buy",
        handle,
        chain,
        token,
        symbol: String(row?.token_symbol || row?.symbol || "?").trim().slice(0, 30) || "?",
        amountUsd,
        paymentVerification: "authorized_public_api_reported_usd",
        valuationBasis: "source_reported_usd",
        timestamp,
        timestampMs,
        blockNumber,
        transactionHash,
      };
    })
    .filter(Boolean);
}

export function parseCopeConvergences(payload) {
  return arrayFrom(payload, ["convergences", "events", "items"])
    .map((row) => {
      const tokenData = row?.token || {};
      const chain = chainProfile(tokenData.chain ?? row?.chain);
      const token = String(tokenData.mint || tokenData.address || row?.token_mint || "").trim();
      const detectedAt = row?.detected_at ?? row?.timestamp ?? row?.created_at;
      const timestampMs = epochMs(detectedAt);
      const totalUsd = finite(row?.total_usd_in ?? row?.totalUsd ?? row?.total_volume);
      const wallets = Array.isArray(row?.wallets) ? row.wallets.map((wallet) => ({
        handle: String(wallet?.handle || wallet?.fomo_handle || "").replace(/^@/, "").trim(),
        amountUsd: finite(wallet?.amount_usd ?? wallet?.usd_amount) || 0,
        winRate: finite(wallet?.win_rate ?? wallet?.winRate),
      })).filter((wallet) => HANDLE.test(wallet.handle)) : [];
      const buyerCount = Math.max(wallets.length, Math.trunc(finite(row?.wallet_count ?? row?.buyer_count) || 0));
      if (!chain || !validToken(chain, token) || timestampMs === null || totalUsd === null || totalUsd <= 0 || buyerCount < 2) return null;
      return {
        callId: String(row?.id || `${chain.slug}:${token}:${detectedAt}`),
        kind: "top_blogger_convergence",
        chain,
        token,
        symbol: String(tokenData.symbol || row?.token_symbol || "?").trim().slice(0, 30) || "?",
        totalUsd,
        paymentVerification: "authorized_public_api_reported_aggregate_usd",
        valuationBasis: "source_reported_aggregate_usd",
        buyerCount,
        wallets,
        marketCapAtDetection: finite(row?.mcap_at_detection ?? tokenData.market_cap),
        timestamp: detectedAt,
        timestampMs,
      };
    })
    .filter(Boolean);
}

export function parseDexScreenerMarket(payload, chain, token, preferredPairAddress = null) {
  const normalizedPreferredPair = isEvmChain(chain)
    ? String(preferredPairAddress || "").toLowerCase()
    : String(preferredPairAddress || "");
  const pairs = (Array.isArray(payload) ? payload : Array.isArray(payload?.pairs) ? payload.pairs : [])
    .filter((pair) => String(pair?.chainId || "").toLowerCase() === chain.slug)
    .filter((pair) => sameToken(chain, pair?.baseToken?.address, token))
    .map((pair) => {
      const liquidityUsd = finite(pair?.liquidity?.usd);
      const volumeM5 = finite(pair?.volume?.m5) || 0;
      const buysM5 = Math.max(0, Math.trunc(finite(pair?.txns?.m5?.buys) || 0));
      const sellsM5 = Math.max(0, Math.trunc(finite(pair?.txns?.m5?.sells) || 0));
      const pairCreatedAt = epochMs(pair?.pairCreatedAt);
      const pairAddress = String(pair?.pairAddress || "").trim();
      if (liquidityUsd === null || liquidityUsd < 0 || !validToken(chain, pairAddress)) return null;
      const labels = Array.isArray(pair?.labels) ? pair.labels.map(String) : [];
      const kind = /(?:v3|cl|concentrated|slipstream)/i.test(`${pair?.dexId || ""} ${labels.join(" ")}`) ? "v3" : "v2";
      const websites = Array.isArray(pair?.info?.websites) ? pair.info.websites : [];
      const socials = Array.isArray(pair?.info?.socials) ? pair.info.socials : [];
      return {
        pairAddress,
        tokenSymbol: String(pair?.baseToken?.symbol || "").trim().slice(0, 30) || null,
        dexId: String(pair?.dexId || "unknown").slice(0, 60),
        kind,
        liquidityUsd,
        volumeM5,
        buysM5,
        sellsM5,
        pairCreatedAt,
        marketCap: finite(pair?.marketCap),
        fdv: finite(pair?.fdv),
        priceUsd: finite(pair?.priceUsd),
        url: /^https:\/\//i.test(String(pair?.url || "")) ? pair.url : null,
        website: websites.map((item) => item?.url).find((url) => /^https:\/\//i.test(String(url || ""))) || null,
        twitter: socials.find((item) => /^(?:twitter|x)$/i.test(String(item?.type || "")) && /^https:\/\/(?:www\.)?(?:x|twitter)\.com\//i.test(String(item?.url || "")))?.url || null,
      };
    })
    .filter(Boolean)
    .sort((left, right) => {
      const leftPreferred = normalizedPreferredPair && sameToken(chain, left.pairAddress, normalizedPreferredPair) ? 1 : 0;
      const rightPreferred = normalizedPreferredPair && sameToken(chain, right.pairAddress, normalizedPreferredPair) ? 1 : 0;
      return rightPreferred - leftPreferred || right.liquidityUsd - left.liquidityUsd || (left.pairCreatedAt ?? Infinity) - (right.pairCreatedAt ?? Infinity);
    });
  return pairs[0] || null;
}

function defaultState() {
  return {
    version: 10,
    initializedAt: null,
    cursor: null,
    watchlist: null,
    topBloggers: [],
    leaderboardCheckedAt: null,
    convergenceInitializedAt: null,
    convergenceCheckedAt: null,
    copeContext: { nextAttemptAt: null, lastError: null },
    seenCalls: {},
    seenConvergences: {},
    alertedTokens: {},
    pending: {},
    coverageSummary: {
      candidatePoolSize: 0,
      monitoredTopCount: 0,
      targetWallets: { solana: 0, evm: 0 },
      targetChains: [],
      configuredChains: [],
      missingChains: [],
      profileFreshness: { status: "unknown", fresh: 0, stale: 0, unknown: 0, staleHandles: [], unknownHandles: [] },
      gaps: { count: 0, skippedBlocks: 0, byChain: {} },
      convergence: { configured: false, available: false, source: null, reason: "not_evaluated" },
      complete: false,
      incompleteReasons: ["not_evaluated"],
      checkedAt: null,
    },
    publicOnchain: {
      initializedAt: null,
      candidateHandles: [],
      dynamicCandidates: {},
      discoveryCheckedAt: null,
      discoveryStatus: "initializing",
      discoveryError: null,
      profilesCheckedAt: null,
      profiles: {},
      profileCoverage: "initializing",
      curveSourcesCheckedAt: null,
      curveSourcesStatus: "initializing",
      curveSourcesError: null,
      curveSourcesNextRetryAt: null,
      curveSourceControls: {},
      fourMemeManagers: [...DEFAULT_FOUR_MEME_MANAGERS],
      solanaCursors: {},
      solanaFailures: {},
      baseNextBlock: null,
      bscNextBlock: null,
      bscLookbackRequested: false,
      bscSilentBaselinePending: true,
      bscBaseline: null,
      sharedRoster: {
        status: "initializing",
        checkedAt: null,
        sourceCheckedAt: null,
        admitted: 0,
        reason: null,
      },
      smartMoney: {
        initializedAt: null,
        feedInitializedAt: null,
        feedCheckedAt: null,
        feedStatus: "initializing",
        feedError: null,
        feedFailureCount: 0,
        feedNextRetryAt: null,
        lastFeedSuccessAt: null,
        baseline: null,
        candidates: {},
        roster: {},
        admittedWallets: [],
        seenTrades: {},
        pendingTrades: {},
        chainProofedTransactions: {},
        statsCheckedAt: null,
        statsStatus: "initializing",
        statsError: null,
        qualificationCoverage: {
          status: "initializing",
          admitted: 0,
          fresh: 0,
          lastKnownGood: 0,
          checkedAt: null,
        },
        exactTradeStatus: "initializing",
        rateLimitedUntil: null,
      },
      coverage: { profiles: "initializing", curves: "initializing", solana: "initializing", base: "initializing", bsc: "initializing" },
      coverageGaps: [],
    },
    health: {
      status: "initializing",
      checkedAt: null,
      checkStartedAt: null,
      lastSuccessAt: null,
      lastError: null,
      consecutiveFailures: 0,
      durationMs: null,
    },
  };
}

async function enforceOwnerOnlyFile(file, fsImpl = fs) {
  const details = await fsImpl.stat(file);
  if ((details.mode & 0o777) !== 0o600) await fsImpl.chmod(file, 0o600);
}

async function readState(file, fsImpl = fs) {
  try {
    await enforceOwnerOnlyFile(file, fsImpl);
    const parsed = JSON.parse(await fsImpl.readFile(file, "utf8"));
    const migratedPublicOnchain = { ...defaultState().publicOnchain, ...(parsed.publicOnchain || {}) };
    if (Number(parsed.version || 0) < 4) {
      migratedPublicOnchain.profilesCheckedAt = null;
      migratedPublicOnchain.curveSourcesCheckedAt = null;
      migratedPublicOnchain.curveSourcesStatus = "initializing";
    }
    if (Number(parsed.version || 0) < 6) {
      migratedPublicOnchain.profilesCheckedAt = null;
      migratedPublicOnchain.discoveryCheckedAt = null;
      migratedPublicOnchain.discoveryStatus = "initializing";
    }
    const resetLegacyFollowerRoster = Number(parsed.version || 0) < 7;
    if (resetLegacyFollowerRoster) migratedPublicOnchain.profilesCheckedAt = null;
    if (Number(parsed.version || 0) < 8) {
      migratedPublicOnchain.profilesCheckedAt = null;
      for (const candidate of Object.values(migratedPublicOnchain.dynamicCandidates || {})) {
        candidate.nextProfileAttemptAt = null;
        candidate.profileStatus = "pending_recheck";
      }
    }
    if (Number(parsed.version || 0) < 9) {
      // Version 9 enables the wallet-buy lane with a silent realtime baseline.
      // Never reuse a pre-disable cursor to replay historical transactions.
      migratedPublicOnchain.bscSilentBaselinePending = true;
      migratedPublicOnchain.bscLookbackRequested = false;
      migratedPublicOnchain.bscBaseline = null;
      migratedPublicOnchain.sharedRoster = { ...defaultState().publicOnchain.sharedRoster };
    }
    migratedPublicOnchain.smartMoney = {
      ...defaultState().publicOnchain.smartMoney,
      ...(parsed.publicOnchain?.smartMoney || {}),
    };
    if (Number(parsed.version || 0) < 10) {
      // Version 10 adds a separate GMGN performance roster. Preserve the live
      // BSC cursor and pending/seen state; the first non-empty GMGN feed is a
      // silent baseline and newly admitted wallets never request lookback.
      migratedPublicOnchain.smartMoney = { ...defaultState().publicOnchain.smartMoney };
    }
    return {
      ...defaultState(),
      ...parsed,
      version: defaultState().version,
      ...(resetLegacyFollowerRoster ? { topBloggers: [], watchlist: null, leaderboardCheckedAt: null } : {}),
      publicOnchain: migratedPublicOnchain,
      copeContext: { ...defaultState().copeContext, ...(parsed.copeContext || {}) },
      health: { ...defaultState().health, ...(parsed.health || {}) },
    };
  } catch (error) {
    if (error.code === "ENOENT") return defaultState();
    throw error;
  }
}

async function fsyncDirectory(directory, fsImpl = fs) {
  let handle;
  let failure = null;
  try {
    handle = await fsImpl.open(directory, "r");
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    try { await handle?.close(); } catch (closeError) {
      failure = failure
        ? new AggregateError([failure, closeError], "directory fsync failed and its handle did not close cleanly")
        : closeError;
    }
  }
  if (failure) throw failure;
}

async function atomicWrite(file, value, fsImpl = fs) {
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  let renamed = false;
  let failure = null;
  try {
    handle = await fsImpl.open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.rename(temporary, file);
    renamed = true;
    await fsImpl.chmod(file, 0o600);
    await fsyncDirectory(directory, fsImpl);
  } catch (error) {
    failure = error;
  } finally {
    try { await handle?.close(); } catch (closeError) {
      failure = failure
        ? new AggregateError([failure, closeError], "atomic write failed and its temporary handle did not close cleanly")
        : closeError;
    }
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
  }
  if (failure) {
    failure.atomicRenameCompleted = renamed;
    throw failure;
  }
}

const hasOnlyKeys = (value, allowed) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every((key) => allowed.has(key));

const strictIsoTimestamp = (value) => {
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  try { return new Date(parsed).toISOString() === value ? value : null; }
  catch { return null; }
};

const safeCheckpointNumber = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

const checkpointCandidateEligible = (wallet, candidate) => isAddress(wallet)
  && String(candidate?.wallet || wallet).toLowerCase() === wallet
  && smartMoneyTagsAreClean(candidate?.tags)
  && !/^(?:rejected_|revoked_)/.test(String(candidate?.profileStatus || ""));

function normalizeFomoCallCheckpoint(value) {
  if (!hasOnlyKeys(value, new Set([
    "version", "revision", "updatedAt", "bscNextBlock", "bscSilentBaselinePending", "smartMoney",
  ]))) return null;
  if (value.version !== FOMO_CALL_CHECKPOINT_VERSION
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || !strictIsoTimestamp(value.updatedAt)) return null;
  if (value.bscNextBlock !== null && safeCheckpointNumber(value.bscNextBlock) === null) return null;
  if (Object.prototype.hasOwnProperty.call(value, "bscSilentBaselinePending")
    && typeof value.bscSilentBaselinePending !== "boolean") return null;
  if (!hasOnlyKeys(value.smartMoney, new Set(["rateLimitedUntil", "wallets"]))) return null;
  if (value.smartMoney.rateLimitedUntil !== null && !strictIsoTimestamp(value.smartMoney.rateLimitedUntil)) return null;
  if (!value.smartMoney.wallets || typeof value.smartMoney.wallets !== "object" || Array.isArray(value.smartMoney.wallets)) return null;
  const wallets = {};
  for (const [rawWallet, schedule] of Object.entries(value.smartMoney.wallets)) {
    const wallet = String(rawWallet || "").toLowerCase();
    if (rawWallet !== wallet || !isAddress(wallet)
      || !hasOnlyKeys(schedule, new Set(["lastStatsAttemptAt", "nextStatsAttemptAt"]))) return null;
    const normalized = {};
    if (Object.prototype.hasOwnProperty.call(schedule, "lastStatsAttemptAt")) {
      const timestamp = safeCheckpointNumber(schedule.lastStatsAttemptAt);
      if (timestamp === null) return null;
      normalized.lastStatsAttemptAt = timestamp;
    }
    if (Object.prototype.hasOwnProperty.call(schedule, "nextStatsAttemptAt")) {
      const timestamp = safeCheckpointNumber(schedule.nextStatsAttemptAt);
      if (timestamp === null) return null;
      normalized.nextStatsAttemptAt = timestamp;
    }
    if (!Object.keys(normalized).length) return null;
    wallets[wallet] = normalized;
  }
  return {
    version: FOMO_CALL_CHECKPOINT_VERSION,
    revision: value.revision,
    updatedAt: value.updatedAt,
    bscNextBlock: value.bscNextBlock,
    ...(typeof value.bscSilentBaselinePending === "boolean"
      ? { bscSilentBaselinePending: value.bscSilentBaselinePending }
      : {}),
    smartMoney: {
      rateLimitedUntil: value.smartMoney.rateLimitedUntil,
      wallets: Object.fromEntries(Object.entries(wallets).sort(([left], [right]) => left.localeCompare(right))),
    },
  };
}

function fomoCallCheckpointFromState(state, metadata = {}) {
  const smartMoney = state?.publicOnchain?.smartMoney || {};
  const wallets = {};
  for (const [rawWallet, candidate] of Object.entries(smartMoney.candidates || {})) {
    const wallet = String(rawWallet || "").toLowerCase();
    if (rawWallet !== wallet || !checkpointCandidateEligible(wallet, candidate)) continue;
    const schedule = {};
    const lastStatsAttemptAt = safeCheckpointNumber(candidate?.lastStatsAttemptAt);
    const nextStatsAttemptAt = safeCheckpointNumber(candidate?.nextStatsAttemptAt);
    if (lastStatsAttemptAt !== null) schedule.lastStatsAttemptAt = lastStatsAttemptAt;
    if (nextStatsAttemptAt !== null) schedule.nextStatsAttemptAt = nextStatsAttemptAt;
    if (Object.keys(schedule).length) wallets[wallet] = schedule;
  }
  const mainMetadata = state?.fomoCallCheckpoint;
  const validMainMetadata = hasOnlyKeys(mainMetadata, new Set(["version", "revision", "updatedAt"]))
    && mainMetadata.version === FOMO_CALL_CHECKPOINT_VERSION
    && Number.isSafeInteger(mainMetadata.revision) && mainMetadata.revision >= 0
    && strictIsoTimestamp(mainMetadata.updatedAt);
  const fallbackUpdatedAt = strictIsoTimestamp(state?.health?.checkedAt) || FOMO_CALL_CHECKPOINT_EPOCH;
  const rateLimitedUntil = strictIsoTimestamp(smartMoney.rateLimitedUntil);
  return {
    version: FOMO_CALL_CHECKPOINT_VERSION,
    revision: Number.isSafeInteger(metadata.revision) && metadata.revision >= 0
      ? metadata.revision
      : (validMainMetadata ? mainMetadata.revision : 0),
    updatedAt: strictIsoTimestamp(metadata.updatedAt)
      || (validMainMetadata ? mainMetadata.updatedAt : fallbackUpdatedAt),
    bscNextBlock: safeCheckpointNumber(state?.publicOnchain?.bscNextBlock),
    bscSilentBaselinePending: state?.publicOnchain?.bscSilentBaselinePending !== false,
    smartMoney: {
      rateLimitedUntil: rateLimitedUntil || null,
      wallets: Object.fromEntries(Object.entries(wallets).sort(([left], [right]) => left.localeCompare(right))),
    },
  };
}

function compareFomoCallCheckpoints(left, right) {
  if (left.revision !== right.revision) return left.revision - right.revision;
  return Date.parse(left.updatedAt) - Date.parse(right.updatedAt);
}

function fomoCallCheckpointPayload(checkpoint) {
  return JSON.stringify({
    bscNextBlock: checkpoint.bscNextBlock,
    bscSilentBaselinePending: checkpoint.bscSilentBaselinePending,
    smartMoney: checkpoint.smartMoney,
  });
}

function applyFomoCallCheckpoint(state, checkpoint) {
  state.publicOnchain ||= {};
  state.publicOnchain.smartMoney ||= {};
  const smartMoney = state.publicOnchain.smartMoney;
  state.publicOnchain.bscNextBlock = checkpoint.bscNextBlock;
  if (typeof checkpoint.bscSilentBaselinePending === "boolean") {
    state.publicOnchain.bscSilentBaselinePending = checkpoint.bscSilentBaselinePending;
  }
  smartMoney.rateLimitedUntil = checkpoint.smartMoney.rateLimitedUntil;
  for (const [rawWallet, candidate] of Object.entries(smartMoney.candidates || {})) {
    const wallet = String(rawWallet || "").toLowerCase();
    if (rawWallet !== wallet || !checkpointCandidateEligible(wallet, candidate)) continue;
    const schedule = checkpoint.smartMoney.wallets[wallet];
    if (schedule && Object.prototype.hasOwnProperty.call(schedule, "lastStatsAttemptAt")) {
      candidate.lastStatsAttemptAt = schedule.lastStatsAttemptAt;
    } else {
      delete candidate.lastStatsAttemptAt;
    }
    if (schedule && Object.prototype.hasOwnProperty.call(schedule, "nextStatsAttemptAt")) {
      candidate.nextStatsAttemptAt = schedule.nextStatsAttemptAt;
    } else {
      delete candidate.nextStatsAttemptAt;
    }
  }
  state.fomoCallCheckpoint = {
    version: FOMO_CALL_CHECKPOINT_VERSION,
    revision: checkpoint.revision,
    updatedAt: checkpoint.updatedAt,
  };
  return state;
}

function materialHealthState(health = {}) {
  return {
    status: health.status || null,
    source: health.source || null,
    lastError: health.lastError || null,
    consecutiveFailures: Number(health.consecutiveFailures || 0),
  };
}

function materialHealthChanged(left, right) {
  return left.status !== right.status
    || left.source !== right.source
    || left.lastError !== right.lastError
    || left.consecutiveFailures !== right.consecutiveFailures;
}

function materialSourceHealthState(state = {}) {
  const publicOnchain = state.publicOnchain || {};
  const sharedRoster = publicOnchain.sharedRoster || {};
  const smartMoney = publicOnchain.smartMoney || {};
  const coverage = publicOnchain.coverage || {};
  const smartCoverage = coverage.smartMoney || {};
  return {
    discoveryStatus: publicOnchain.discoveryStatus || null,
    discoveryError: publicOnchain.discoveryError || null,
    profileCoverage: publicOnchain.profileCoverage || null,
    curveSourcesStatus: publicOnchain.curveSourcesStatus || null,
    curveSourcesError: publicOnchain.curveSourcesError || null,
    curveSourcesNextRetryAt: publicOnchain.curveSourcesNextRetryAt || null,
    sharedRosterStatus: sharedRoster.status || null,
    sharedRosterReason: sharedRoster.reason || null,
    smartFeedStatus: smartMoney.feedStatus || null,
    smartFeedError: smartMoney.feedError || null,
    smartFeedFailureCount: Number(smartMoney.feedFailureCount || 0),
    smartFeedNextRetryAt: smartMoney.feedNextRetryAt || null,
    smartStatsStatus: smartMoney.statsStatus || null,
    smartStatsError: smartMoney.statsError || null,
    smartQualificationStatus: smartMoney.qualificationCoverage?.status || null,
    smartQualificationAdmitted: Number(smartMoney.qualificationCoverage?.admitted || 0),
    smartQualificationFresh: Number(smartMoney.qualificationCoverage?.fresh || 0),
    smartQualificationLastKnownGood: Number(smartMoney.qualificationCoverage?.lastKnownGood || 0),
    smartExactTradeStatus: smartMoney.exactTradeStatus || null,
    coverageProfiles: coverage.profiles || null,
    coverageCurves: coverage.curves || null,
    coverageSolana: coverage.solana || null,
    coverageBase: coverage.base || null,
    coverageBsc: coverage.bsc || null,
    coverageSmartFeed: smartCoverage.feed || null,
    coverageSmartStats: smartCoverage.stats || null,
    coverageSmartQualification: smartCoverage.qualification || null,
    coverageSmartFresh: Number(smartCoverage.fresh || 0),
    coverageSmartLastKnownGood: Number(smartCoverage.lastKnownGood || 0),
    coverageSmartExactTrades: smartCoverage.exactTrades || null,
  };
}

function materialSourceHealthChanged(left, right) {
  const fields = Object.keys(right);
  return fields.some((field) => !Object.is(left?.[field], right[field]));
}

function boundedCoverageGaps(gaps, maximum = MAX_COVERAGE_GAPS) {
  const entries = Array.isArray(gaps) ? gaps : [];
  if (entries.length <= maximum) return entries;
  const indexed = entries.map((gap, index) => ({ gap, index }));
  const permanentLoss = indexed.filter(({ gap }) => gap?.reason === "backlog_exceeded_signal_window");
  const unresolved = indexed.filter(({ gap }) => gap?.reason !== "backlog_exceeded_signal_window"
    && !gap?.resolvedAt && gap?.status !== "resolved");
  const resolved = indexed.filter(({ gap }) => gap?.reason !== "backlog_exceeded_signal_window"
    && (gap?.resolvedAt || gap?.status === "resolved"));
  const retained = new Set();
  for (const group of [permanentLoss, unresolved, resolved]) {
    for (let index = group.length - 1; index >= 0 && retained.size < maximum; index -= 1) {
      retained.add(group[index].index);
    }
  }
  return indexed.filter(({ index }) => retained.has(index)).map(({ gap }) => gap);
}

function pruneState(state, nowMs) {
  let durableChanged = false;
  for (const field of ["seenCalls", "seenConvergences", "alertedTokens"]) {
    for (const [key, timestamp] of Object.entries(state[field] || {})) {
      if (nowMs - Number(timestamp || 0) > RETENTION_MS) {
        delete state[field][key];
        durableChanged = true;
      }
    }
    const maximum = field === "seenCalls" ? 20_000 : 10_000;
    if (Object.keys(state[field] || {}).length > maximum) durableChanged = true;
    state[field] = Object.fromEntries(Object.entries(state[field] || {})
      .sort(([, left], [, right]) => Number(right || 0) - Number(left || 0))
      .slice(0, maximum));
  }
  for (const [key, item] of Object.entries(state.pending || {})) {
    if (nowMs - Number(item.firstSeenAt || item.call?.timestampMs || 0) > PENDING_MAX_AGE_MS) {
      delete state.pending[key];
      durableChanged = true;
    }
  }
  if (Object.keys(state.pending || {}).length > 1_000) durableChanged = true;
  state.pending = Object.fromEntries(Object.entries(state.pending || {})
    .sort(([, left], [, right]) => Number(left?.call?.timestampMs || left?.firstSeenAt || 0)
      - Number(right?.call?.timestampMs || right?.firstSeenAt || 0))
    .slice(0, 1_000));
  if ((state.publicOnchain.coverageGaps || []).length > MAX_COVERAGE_GAPS) durableChanged = true;
  state.publicOnchain.coverageGaps = boundedCoverageGaps(state.publicOnchain.coverageGaps);
  const smartMoney = state.publicOnchain.smartMoney || {};
  for (const [key, timestamp] of Object.entries(smartMoney.seenTrades || {})) {
    if (nowMs - Number(timestamp || 0) > RETENTION_MS) {
      delete smartMoney.seenTrades[key];
      durableChanged = true;
    }
  }
  for (const [key, timestamp] of Object.entries(smartMoney.chainProofedTransactions || {})) {
    if (nowMs - Number(timestamp || 0) > RETENTION_MS) {
      delete smartMoney.chainProofedTransactions[key];
      durableChanged = true;
    }
  }
  for (const [key, trade] of Object.entries(smartMoney.pendingTrades || {})) {
    if (nowMs - Number(trade?.timestampMs || trade?.firstSeenAt || 0) > PENDING_MAX_AGE_MS) {
      delete smartMoney.pendingTrades[key];
      durableChanged = true;
    }
  }
  if (Object.keys(smartMoney.seenTrades || {}).length > 5_000
    || Object.keys(smartMoney.chainProofedTransactions || {}).length > 5_000
    || Object.keys(smartMoney.pendingTrades || {}).length > 500) durableChanged = true;
  const boundedSeenTrades = Object.entries(smartMoney.seenTrades || {})
    .sort(([, left], [, right]) => Number(right || 0) - Number(left || 0))
    .slice(0, 5_000);
  smartMoney.seenTrades = Object.fromEntries(boundedSeenTrades);
  smartMoney.chainProofedTransactions = Object.fromEntries(Object.entries(smartMoney.chainProofedTransactions || {})
    .sort(([, left], [, right]) => Number(right || 0) - Number(left || 0))
    .slice(0, 5_000));
  const boundedPendingTrades = Object.entries(smartMoney.pendingTrades || {})
    .slice(0, 500);
  smartMoney.pendingTrades = Object.fromEntries(boundedPendingTrades);
  return durableChanged;
}

function listFromWatchlists(payload) {
  return arrayFrom(payload, ["watchlists", "items"]);
}

function profileMap(state) {
  return new Map((state.topBloggers || []).map((entry) => [String(entry.handle).toLowerCase(), entry]));
}

function fresh(call, nowMs, maxAgeMs) {
  return call.timestampMs <= nowMs + 60_000 && nowMs - call.timestampMs <= maxAgeMs;
}

function cursorValue(call) {
  return rawCursor(call.timestamp);
}

function cursorMax(left, right) {
  if (left === null || left === undefined) return right;
  if (right === null || right === undefined) return left;
  const leftMs = epochMs(left);
  const rightMs = epochMs(right);
  return rightMs !== null && (leftMs === null || rightMs > leftMs) ? right : left;
}

function callScore(call, blogger) {
  const followers = blogger?.followers || call.topFollowers || 0;
  const dollars = call.amountUsd || call.totalUsd || 0;
  const convergence = call.kind === "top_blogger_convergence" ? 10_000_000_000 : 0;
  return convergence + Math.log10(followers + 1) * 1_000_000 + Math.log10(dollars + 1) * 10_000;
}

function parsePositions(payload) {
  return arrayFrom(payload, ["positions", "items", "trades"]);
}

function matchingFirstPosition(payload, call) {
  const position = parsePositions(payload).find((item) => {
    const chain = chainProfile(item?.chain);
    return chain?.id === call.chain.id && sameToken(call.chain, item?.token_mint || item?.token_address, call.token);
  });
  if (!position) return false;
  const buyCount = finite(position.buy_count ?? position.buyCount);
  const firstBuyAt = epochMs(position.first_buy_at ?? position.firstBuyAt);
  const closed = String(position.status || "").toLowerCase() === "closed" || position.closed_at || position.closedAt;
  return !closed && buyCount === 1 && firstBuyAt !== null && Math.abs(firstBuyAt - call.timestampMs) <= 5 * 60_000;
}

function parseOpenThesis(payload, call, topHandles) {
  const rows = arrayFrom(payload, ["theses", "items"]);
  const matches = rows.filter((item) => {
    const token = item?.token_mint || item?.token?.mint || item?.token_address;
    const chain = chainProfile(item?.chain || item?.token?.chain);
    const handle = String(item?.handle || item?.fomo_handle || call.handle || "").replace(/^@/, "").toLowerCase();
    const closed = item?.position?.is_closed === true || item?.position?.isClosed === true;
    return chain?.id === call.chain.id && sameToken(call.chain, token, call.token) && topHandles.has(handle) && !closed;
  });
  matches.sort((left, right) => (epochMs(right?.created_at) || 0) - (epochMs(left?.created_at) || 0));
  const thesis = matches[0];
  const comment = String(thesis?.comment || thesis?.text || "").replace(/\s+/g, " ").trim();
  if (!comment) return null;
  return {
    text: comment.slice(0, 300),
    handle: String(thesis?.handle || thesis?.fomo_handle || call.handle || "").replace(/^@/, ""),
    likes: Math.max(0, Math.trunc(finite(thesis?.likes) || 0)),
    replies: Math.max(0, Math.trunc(finite(thesis?.replies) || 0)),
    createdAt: thesis?.created_at || null,
  };
}

export async function assessSolanaMintSafety(fetchImpl, rpcUrl, token, market) {
  try {
    const response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [token, { encoding: "base64", commitment: "confirmed" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Solana RPC HTTP ${response.status}`);
    const payload = await response.json();
    const account = payload?.result?.value;
    const encoded = Array.isArray(account?.data) ? account.data[0] : null;
    const data = encoded ? Buffer.from(encoded, "base64") : null;
    const reasons = [];
    if (account?.owner !== SOLANA_TOKEN_PROGRAM) reasons.push("不是标准 SPL Token Program Mint");
    if (!data || data.length !== 82) reasons.push("Mint 布局未知或含未解析扩展");
    if (data?.length === 82) {
      if (data.readUInt32LE(0) !== 0) reasons.push("Mint Authority 未撤销");
      if (data.readUInt32LE(46) !== 0) reasons.push("Freeze Authority 未撤销");
      if (data[45] !== 1) reasons.push("Mint 未初始化");
    }
    if (!market?.liquidityUsd) reasons.push("池子实际流动性未确认");
    if ((market?.sellsM5 || 0) < 1) reasons.push("最近 5 分钟尚无真实卖出");
    return {
      decision: reasons.length ? "block" : "pass",
      label: reasons.length ? "不推送" : "本地安全门通过",
      reasons,
      warnings: ["已检查标准 Mint 权限、池流动性和真实卖出；不代表无价格或团队风险"],
      metrics: {
        liquidityConfirmed: Boolean(market?.liquidityUsd),
        sellObserved: (market?.sellsM5 || 0) >= 1,
        mintAuthorityRevoked: data?.length === 82 ? data.readUInt32LE(0) === 0 : false,
        freezeAuthorityRevoked: data?.length === 82 ? data.readUInt32LE(46) === 0 : false,
      },
      checkedAt: new Date().toISOString(),
      source: "local_solana_rpc",
    };
  } catch (error) {
    return { decision: "unknown", label: "观察", reasons: [`Solana 本地检查失败: ${error.message.slice(0, 120)}`], checkedAt: new Date().toISOString(), source: "local_solana_rpc" };
  }
}

export function createFomoCallMonitor(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const alertSender = dependencies.sendAlertsImpl || sendAlerts;
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const wallNow = dependencies.wallNow || Date.now;
  const autoStart = dependencies.autoStart !== false;
  const stateFile = path.join(config.dataDir, "fomo-call-state.json");
  const checkpointFile = String(config.fomoCallCheckpointFile
    || dependencies.checkpointFile
    || path.join(path.dirname(stateFile), "fomo-call-checkpoint.json"));
  const sharedRosterFile = path.join(config.dataDir, "fomo-x-call-state.json");
  const telemetryPersistIntervalMs = Math.max(30_000,
    Number(config.fomoCallTelemetryPersistIntervalMs) || DEFAULT_TELEMETRY_PERSIST_INTERVAL_MS);
  const stateFs = dependencies.stateFsImpl || dependencies.atomicFsImpl || fs;
  const checkpointFs = dependencies.checkpointFsImpl || fs;
  const mainAtomicWrite = dependencies.atomicWriteImpl
    || ((file, value) => atomicWrite(file, value, stateFs));
  const checkpointAtomicWrite = dependencies.checkpointAtomicWriteImpl
    || ((file, value) => atomicWrite(file, value, checkpointFs));
  let checkpointWriteQueue = Promise.resolve();
  let invalidCheckpointLogged = false;
  let checkpointWriteUncertain = false;
  let mainWriteUncertain = false;
  let activePersistence = null;

  const readCheckpoint = async () => {
    let parsed;
    try {
      await enforceOwnerOnlyFile(checkpointFile, checkpointFs);
      if (checkpointWriteUncertain) return null;
      parsed = JSON.parse(await checkpointFs.readFile(checkpointFile, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof SyntaxError) {
        if (!invalidCheckpointLogged) {
          logger.error("[fomo-call] ignoring malformed checkpoint; falling back to the main state");
          invalidCheckpointLogged = true;
        }
        return null;
      }
      throw error;
    }
    const checkpoint = normalizeFomoCallCheckpoint(parsed);
    if (!checkpoint && !invalidCheckpointLogged) {
      logger.error("[fomo-call] ignoring incompatible checkpoint; falling back to the main state");
      invalidCheckpointLogged = true;
    }
    if (checkpoint) invalidCheckpointLogged = false;
    return checkpoint;
  };

  const readStateWithCheckpoint = async () => {
    const state = await readState(stateFile, stateFs);
    const mainCheckpoint = fomoCallCheckpointFromState(state);
    const sidecarCheckpoint = await readCheckpoint();
    const sidecarIsNewer = sidecarCheckpoint
      && compareFomoCallCheckpoints(sidecarCheckpoint, mainCheckpoint) > 0;
    let selected = sidecarIsNewer ? sidecarCheckpoint : mainCheckpoint;
    // Checkpoints written before the baseline-control field was introduced
    // can still represent the exact crash window fixed here: a newer sidecar
    // moved the BSC cursor while main still says activation is pending. Only
    // that cursor-changing shape is safe to migrate as a consumed baseline;
    // stats-only legacy checkpoints must leave the main flag authoritative.
    if (sidecarIsNewer
      && typeof sidecarCheckpoint.bscSilentBaselinePending !== "boolean"
      && state.publicOnchain?.bscSilentBaselinePending !== false
      && sidecarCheckpoint.bscNextBlock !== null
      && sidecarCheckpoint.bscNextBlock !== mainCheckpoint.bscNextBlock) {
      selected = { ...sidecarCheckpoint, bscSilentBaselinePending: false };
    }
    applyFomoCallCheckpoint(state, selected);
    return { state, checkpoint: selected, mainCheckpoint, sidecarCheckpoint };
  };

  const markDurableState = () => {
    if (activePersistence) activePersistence.durableDirty = true;
  };

  const markTelemetryTransition = () => {
    if (activePersistence) activePersistence.telemetryTransitionDirty = true;
  };

  const markCheckpointState = () => {
    if (activePersistence) activePersistence.checkpointDirty = true;
  };

  const setDurableField = (target, field, value) => {
    if (Object.is(target[field], value)) return false;
    target[field] = value;
    markDurableState();
    return true;
  };

  const setTelemetryField = (target, field, value) => {
    if (Object.is(target[field], value)) return false;
    target[field] = value;
    markTelemetryTransition();
    return true;
  };

  const setCheckpointField = (target, field, value) => {
    if (Object.is(target[field], value)) return false;
    target[field] = value;
    markCheckpointState();
    return true;
  };

  const setOnchainCursor = (state, chain, field, value) => chain.id === BSC_CHAIN_ID
    ? setCheckpointField(state.publicOnchain, field, value)
    : setDurableField(state.publicOnchain, field, value);

  const enqueueCheckpointWrite = (operation) => {
    const queued = checkpointWriteQueue.catch(() => {}).then(operation);
    checkpointWriteQueue = queued.catch(() => {});
    return queued;
  };

  const persistCheckpoint = async (state, reason) => {
    if (activePersistence?.state !== state) return false;
    const persisted = activePersistence.persistedCheckpoint;
    const draft = fomoCallCheckpointFromState(state, persisted);
    // The cursor and baseline-consumption flag are one checkpoint fact. Once
    // this sidecar crosses its file+directory barriers, restart must scan from
    // that cursor even if main did not yet persist the richer baseline audit.
    if (activePersistence.bscBaselineAfterCheckpoint) {
      draft.bscSilentBaselinePending = false;
    }
    if (fomoCallCheckpointPayload(draft) === fomoCallCheckpointPayload(persisted)) {
      activePersistence.checkpointDirty = false;
      return false;
    }
    const checkpoint = {
      ...draft,
      revision: persisted.revision + 1,
      updatedAt: new Date(Number(now())).toISOString(),
    };
    try {
      await enqueueCheckpointWrite(() => checkpointAtomicWrite(checkpointFile, checkpoint));
      checkpointWriteUncertain = false;
    } catch (error) {
      checkpointWriteUncertain = true;
      throw error;
    }
    activePersistence.persistedCheckpoint = checkpoint;
    activePersistence.checkpointDirty = false;
    applyFomoCallCheckpoint(state, checkpoint);
    dependencies.onCheckpointWrite?.({ reason, revision: checkpoint.revision, writtenAtMs: Number(now()) });
    return true;
  };

  const finalizeBscCheckpointControls = async (state) => {
    if (activePersistence?.state !== state) return false;
    const baseline = activePersistence.bscBaselineAfterCheckpoint;
    const consumedLookback = activePersistence.bscLookbackConsumed === true;
    if (!baseline && !consumedLookback) return false;
    activePersistence.bscBaselineAfterCheckpoint = null;
    activePersistence.bscLookbackConsumed = false;
    setDurableField(state.publicOnchain, "bscLookbackRequested", false);
    if (baseline) {
      setDurableField(state.publicOnchain, "bscSilentBaselinePending", false);
      state.publicOnchain.bscBaseline = baseline;
      markDurableState();
    }
    return persistDurableState(state, baseline ? "bsc-baseline-consumed" : "bsc-lookback-consumed");
  };

  const writeState = async (state, reason, writtenAtMs = Number(now())) => {
    if (activePersistence?.state === state && reason !== "telemetry") {
      state.health = {
        ...state.health,
        checkedAt: new Date(writtenAtMs).toISOString(),
      };
    }
    const persistedState = activePersistence?.state === state
      ? applyFomoCallCheckpoint(structuredClone(state), activePersistence.persistedCheckpoint)
      : state;
    try {
      await mainAtomicWrite(stateFile, persistedState);
      mainWriteUncertain = false;
    } catch (error) {
      mainWriteUncertain = true;
      throw error;
    }
    dependencies.onStateWrite?.({ reason, writtenAtMs });
    if (activePersistence?.state === state) {
      activePersistence.durableDirty = false;
      activePersistence.telemetryTransitionDirty = false;
      activePersistence.lastPersistedAtMs = writtenAtMs;
      activePersistence.persistedHealth = materialHealthState(state.health);
      activePersistence.persistedSourceHealth = materialSourceHealthState(state);
    }
  };

  const persistDurableState = async (state, reason) => {
    if (activePersistence?.state !== state || !activePersistence.durableDirty) return false;
    await writeState(state, reason);
    return true;
  };

  const persistTelemetryState = async (state, writtenAtMs, options = {}) => {
    if (activePersistence?.state !== state) {
      await writeState(state, "telemetry", writtenAtMs);
      return true;
    }
    const nextHealth = materialHealthState(state.health);
    const statusChanged = materialHealthChanged(activePersistence.persistedHealth, nextHealth);
    const sourceHealthChanged = materialSourceHealthChanged(
      activePersistence.persistedSourceHealth,
      materialSourceHealthState(state),
    );
    const telemetryDue = !Number.isFinite(activePersistence.lastPersistedAtMs)
      || writtenAtMs - activePersistence.lastPersistedAtMs >= telemetryPersistIntervalMs;
    if (!activePersistence.durableDirty && !activePersistence.telemetryTransitionDirty
      && !options.force && !statusChanged && !sourceHealthChanged && !telemetryDue) return false;
    await writeState(state, activePersistence.durableDirty ? "durable+telemetry" : "telemetry", writtenAtMs);
    return true;
  };

  const absorbDurableCheckpoint = async () => {
    await checkpointWriteQueue;
    const loaded = await readStateWithCheckpoint();
    const sidecarNeedsAbsorption = loaded.sidecarCheckpoint
      && compareFomoCallCheckpoints(loaded.sidecarCheckpoint, loaded.mainCheckpoint) > 0;
    if (!sidecarNeedsAbsorption && !mainWriteUncertain) return false;
    const reason = sidecarNeedsAbsorption ? "checkpoint-absorb" : "state-barrier-retry";
    try {
      await mainAtomicWrite(stateFile, loaded.state);
      mainWriteUncertain = false;
    } catch (error) {
      mainWriteUncertain = true;
      throw error;
    }
    dependencies.onStateWrite?.({ reason, writtenAtMs: Number(now()) });
    return true;
  };
  let releaseProcessLease = null;
  let processLeaseBlocked = false;
  if (autoStart && config.fomoCallEnabled) {
    try {
      releaseProcessLease = acquireFomoProcessLease(config.dataDir);
      processLeaseBlocked = !releaseProcessLease;
    } catch (error) {
      processLeaseBlocked = true;
      logger.error(`[fomo-call] process lease unavailable: ${error.message}`);
    }
    if (processLeaseBlocked) logger.error("[fomo-call] another live scanner owns the process lease; this instance stays inactive");
  }
  const apiBase = String(config.copeApiBase || COPE_API_BASE).replace(/\/$/, "");
  const fomoScanApiBase = String(config.fomoScanApiBase || FOMOSCAN_API_BASE).replace(/\/$/, "");
  const configuredPublicHandles = (Array.isArray(config.fomoCallPublicHandles) ? config.fomoCallPublicHandles : PUBLIC_FOMO_HANDLES)
    .map((value) => String(value || "").replace(/^@/, "").trim())
    .filter((value, index, values) => HANDLE.test(value) && values.findIndex((item) => item.toLowerCase() === value.toLowerCase()) === index);
  const publicTopLimit = Math.max(1, Math.min(10, Number(config.fomoCallPublicTopLimit || 4)));
  const publicProfileIntervalMs = Math.max(5 * 60_000, Number(config.fomoCallPublicProfilePollIntervalMs || 30 * 60_000));
  const monitorAllEligible = config.fomoCallMonitorAllEligible === true;
  const minimumXFollowers = Math.max(0, Number(config.fomoCallMinXFollowers ?? 10_000));
  const requireTwitterIdentity = config.fomoCallRequireTwitterIdentity === true;
  const allowGmgnObservedWallets = config.fomoCallAllowGmgnObservedWallets === true;
  const requireBscActivity = config.fomoCallRequireBscActivity === true;
  const requireRecentIdentity = config.fomoCallRequireRecentIdentity === true;
  const maxIdentityAgeMs = Math.max(60_000, Number(config.fomoCallMaxIdentityAgeMs || 30 * 24 * 60 * 60_000));
  const fxTwitterApiBase = String(config.fomoCallFxTwitterApiBase || "https://api.fxtwitter.com").replace(/\/$/, "");
  const xProfileIntervalMs = Math.max(5 * 60_000, Number(config.fomoCallXProfilePollIntervalMs || 30 * 60_000));
  const maxXProfileAgeMs = Math.max(xProfileIntervalMs, Number(config.fomoCallMaxXProfileAgeMs || 24 * 60 * 60_000));
  const gmgnAttributionMaxAgeMs = Math.max(60_000, Number(config.fomoCallGmgnAttributionMaxAgeMs || GMGN_ATTRIBUTION_MAX_AGE_MS));
  const sharedRosterEnabled = config.fomoCallSharedRosterEnabled === true;
  const sharedRosterRequired = config.fomoCallSharedRosterRequired === true;
  const sharedRosterMaxAgeMs = Math.max(60_000, Number(config.fomoCallSharedRosterMaxAgeMs ?? 10 * 60_000));
  const sharedProofMaxAgeMs = Math.max(60_000, Number(config.fomoCallSharedProofMaxAgeMs ?? gmgnAttributionMaxAgeMs));
  const bscOnly = config.fomoCallBscOnly === true;
  const dynamicDiscoveryEnabled = config.fomoCallDynamicDiscoveryEnabled === true;
  const dynamicDiscoveryIntervalMs = Math.max(60_000, Number(config.fomoCallDynamicDiscoveryIntervalMs || 5 * 60_000));
  const dynamicCandidateRetentionMs = Math.max(dynamicDiscoveryIntervalMs * 2, Number(config.fomoCallDynamicCandidateRetentionMs || 7 * 24 * 60 * 60_000));
  const dynamicCandidateLimit = Math.max(1, Math.min(1_000, Number(config.fomoCallDynamicCandidateLimit || 500)));
  const dynamicProfileBatchLimit = Math.max(1, Math.min(25, Number(config.fomoCallDynamicProfileBatchLimit || 10)));
  const unresolvedCandidateRetryMs = Math.max(5 * 60_000, Number(config.fomoCallUnresolvedCandidateRetryMs || 15 * 60_000));
  const requireGmgnFomoTag = config.fomoCallGmgnRequireFomoTag !== false;
  const newWalletLookbackBlocks = Math.max(0, Number(config.fomoCallNewWalletLookbackBlocks ?? 600));
  const requireConvergence = config.fomoCallRequireConvergence !== false;
  const legacyBuyEnabled = config.fomoBuyMonitorEnabled === true;
  // The added cross-chain lane and the existing BSC lane share one CLI queue
  // and durable account cooldown. Separate clients retain independent stops.
  const gmgnSharedClient = config.gmgnFlowMonitorEnabled
    ? (dependencies.gmgnFlowClient || createGmgnFlowClient(config)) : null;
  const discoverBscKolCandidates = dependencies.discoverBscKolCandidatesImpl || (async () => {
    const candidates = gmgnSharedClient
      ? parseGmgnBscKolCandidates(await gmgnSharedClient.trades("bsc", "kol"))
      : await discoverGmgnBscKolCandidates({
      dataDir: config.dataDir,
      cliPath: config.fomoCallGmgnCliPath || "gmgn-cli",
      limit: config.fomoCallGmgnDiscoveryLimit || 100,
      timeoutMs: config.fomoCallGmgnDiscoveryTimeoutMs || 30_000,
    });
    return candidates.filter((candidate) => gmgnTagsAreClean(candidate.tags)
      && (!requireGmgnFomoTag || candidate.tags.includes("fomo")));
  });
  const smartMoneyEnabled = config.fomoSmartMoneyMonitorEnabled === true;
  const smartMoneyDiscoveryIntervalMs = Math.max(15_000, Number(config.fomoSmartMoneyDiscoveryIntervalMs ?? 30_000));
  const smartMoneyFeedLimit = Math.max(1, Math.min(200, Number(config.fomoSmartMoneyFeedLimit ?? 200)));
  const smartMoneyStatsBatchLimit = Math.max(1, Math.min(20, Number(config.fomoSmartMoneyStatsBatchLimit ?? 1)));
  const smartMoneyStatsRequestIntervalMs = Math.max(3_000, Number(config.fomoSmartMoneyStatsRequestIntervalMs ?? 3_000));
  const smartMoneyStatsTimeoutMs = Math.max(5_000, Number(config.fomoSmartMoneyStatsTimeoutMs ?? 8_000));
  const smartMoneyQualifiedCacheMs = Math.max(60_000, Number(config.fomoSmartMoneyQualifiedCacheMs ?? 30 * 60_000));
  const smartMoneyRejectedCacheMs = Math.max(5 * 60_000, Number(config.fomoSmartMoneyRejectedCacheMs ?? 60 * 60_000));
  const smartMoneyMaxStatsAgeMs = Math.max(smartMoneyQualifiedCacheMs, Number(config.fomoSmartMoneyMaxStatsAgeMs ?? 2 * 60 * 60_000));
  const smartMoneyCandidateRetentionMs = Math.max(60 * 60_000, Number(config.fomoSmartMoneyCandidateRetentionMs ?? 24 * 60 * 60_000));
  // A previously qualified wallet remains observable for one bounded feed
  // retention window when GMGN profile stats are temporarily unavailable.
  // All qualification, blocked-tag, EOA, first-position, and token safety gates
  // still apply; this only prevents an upstream stats outage from erasing the
  // entire on-chain watch roster at the two-hour freshness boundary.
  const smartMoneyLastKnownGoodGraceMs = Math.max(
    smartMoneyMaxStatsAgeMs,
    Math.min(7 * 24 * 60 * 60_000, Number(config.fomoSmartMoneyLastKnownGoodGraceMs ?? smartMoneyCandidateRetentionMs)),
  );
  const smartMoneyCandidateLimit = Math.max(1, Math.min(2_000, Number(config.fomoSmartMoneyCandidateLimit ?? 500)));
  const smartMoneyMaxWallets = Math.max(1, Math.min(100, Number(config.fomoSmartMoneyMaxWallets ?? 20)));
  const smartMoneyQualificationOptions = {
    maximumStatsAgeMs: smartMoneyMaxStatsAgeMs,
    minimumWalletAgeMs: Math.max(1, Number(config.fomoSmartMoneyMinWalletAgeDays ?? 30)) * 24 * 60 * 60_000,
    maximumCreatedTokens: Math.max(0, Number(config.fomoSmartMoneyMaxCreatedTokens ?? 10)),
    minimumProfit7dUsd: Math.max(0, Number(config.fomoSmartMoneyMinProfit7dUsd ?? 3_000)),
    minimumWinRate7d: Math.max(0, Math.min(1, Number(config.fomoSmartMoneyMinWinRate7dBps ?? 6_000) / 10_000)),
    minimumRoi7d: Math.max(0, Number(config.fomoSmartMoneyMinRoi7dBps ?? 150) / 10_000),
    minimumTokenCount7d: Math.max(1, Number(config.fomoSmartMoneyMinTokenCount7d ?? 50)),
    minimumProfit30dUsd: Math.max(0, Number(config.fomoSmartMoneyMinProfit30dUsd ?? 10_000)),
    minimumWinRate30d: Math.max(0, Math.min(1, Number(config.fomoSmartMoneyMinWinRate30dBps ?? 6_000) / 10_000)),
    minimumRoi30d: Math.max(0, Number(config.fomoSmartMoneyMinRoi30dBps ?? 150) / 10_000),
    minimumTokenCount30d: Math.max(1, Number(config.fomoSmartMoneyMinTokenCount30d ?? 100)),
  };
  const discoverSmartMoneyTrades = dependencies.discoverSmartMoneyTradesImpl || (async (observedAtMs) => gmgnSharedClient
    ? parseGmgnBscSmartMoneyBuys(await gmgnSharedClient.trades("bsc", "smartmoney"), { observedAtMs })
    : discoverGmgnBscSmartMoneyBuys({
    cliPath: config.fomoCallGmgnCliPath || "gmgn-cli",
    limit: smartMoneyFeedLimit,
    timeoutMs: config.fomoCallGmgnDiscoveryTimeoutMs || 30_000,
    observedAtMs,
  }));
  const fetchSmartMoneyStats = dependencies.fetchSmartMoneyStatsImpl || (async (wallet, period, checkedAtMs) => gmgnSharedClient
    ? parseGmgnWalletStats(await gmgnSharedClient.stats("bsc", wallet, period), { wallet, period, checkedAtMs })
    : fetchGmgnWalletStats({
    cliPath: config.fomoCallGmgnCliPath || "gmgn-cli",
    wallet,
    period,
    timeoutMs: smartMoneyStatsTimeoutMs,
    checkedAtMs,
  }));
  const sleep = dependencies.sleepImpl || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const publicBaseConfirmations = Math.max(0, Number(config.fomoCallBaseConfirmations ?? 2));
  const publicBaseMaxCatchup = Math.max(1, Number(config.fomoCallBaseMaxCatchupBlocks || 180));
  const publicBscConfirmations = Math.max(0, Number(config.fomoCallBscConfirmations ?? 2));
  const publicBscMaxCatchup = Math.max(1, Number(config.fomoCallBscMaxCatchupBlocks || 600));
  const minimumConvergenceUsd = Math.max(1_000, Number(config.fomoCallMinConvergenceUsd || 5_000));
  const minimumLiquidityUsd = Math.max(1_000, Number(config.fomoCallMinLiquidityUsd || 10_000));
  const maximumPairAgeMs = Math.max(60_000, Number(config.fomoCallMaxPairAgeMs || 30 * 24 * 60 * 60 * 1_000));
  const maximumSignalAgeMs = Math.max(60_000, Number(config.fomoCallMaxSignalAgeMs || 5 * 60 * 1_000));
  const leaderboardIntervalMs = Math.max(60_000, Number(config.fomoCallLeaderboardPollIntervalMs || 15 * 60_000));
  const convergenceIntervalMs = Math.max(30_000, Number(config.fomoCallConvergencePollIntervalMs || 30_000));
  const maxEmitsPerCheck = Math.max(1, Math.min(10, Number(config.fomoCallMaxEmitsPerCheck ?? 3)));
  const goPlusEnabled = config.fomoCallGoPlusEnabled === true;
  const goPlusApiBase = String(config.fomoCallGoPlusApiBase || "https://api.gopluslabs.io/api/v1/token_security").replace(/\/$/, "");
  const goPlusTimeoutMs = Math.max(1_000, Number(config.fomoCallGoPlusTimeoutMs ?? 8_000));
  const goPlusMaximumTax = Math.max(0, Math.min(1, Number(config.fomoCallGoPlusMaxTaxBps ?? 1_000) / 10_000));
  const goPlusCacheMs = Math.max(1_000, Number(config.fomoCallGoPlusCacheMs ?? 30_000));
  const strictBuyProvenance = config.fomoCallStrictBuyProvenance === true;
  const baseProvider = dependencies.baseProvider || new JsonRpcProvider(config.fomoCallBaseRpcUrl || "https://mainnet.base.org", BASE_CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
  const bscProvider = dependencies.bscProvider || new JsonRpcProvider(config.fomoCallBscRpcUrl || "https://bsc-rpc.publicnode.com", BSC_CHAIN_ID, { staticNetwork: true, batchMaxCount: 1 });
  const bscRpcUrls = [...new Set([
    config.fomoCallBscRpcUrl,
    ...(Array.isArray(config.bscRpcUrls) ? config.bscRpcUrls : []),
    "https://bsc-rpc.publicnode.com",
  ].filter(Boolean))];
  const bscReceiptRpcUrls = [...new Set([
    ...(Array.isArray(config.bscRpcUrls) ? config.bscRpcUrls : []),
    ...(Array.isArray(config.bscArchiveRpcUrls) ? config.bscArchiveRpcUrls : []),
    config.fomoCallBscRpcUrl,
    "https://bsc-dataseed-public.bnbchain.org",
    "https://bsc-mainnet.public.blastapi.io",
  ].filter(Boolean))];
  // Publicnode rejects historical receipt calls in some deployments. Batch
  // the latency-sensitive receipt phase against endpoints known to support it
  // before falling back to the broader archive list.
  const bscBatchReceiptRpcUrls = [...new Set([
    "https://bsc-dataseed-public.bnbchain.org",
    "https://bsc-mainnet.public.blastapi.io",
    ...bscReceiptRpcUrls,
  ])];
  const bscProofRpcUrls = [...new Set([
    ...(Array.isArray(config.bscArchiveRpcUrls) ? config.bscArchiveRpcUrls : []),
    "https://bsc-mainnet.public.blastapi.io",
  ].filter(Boolean))];
  const assessEvmSecurity = dependencies.assessEvmSecurityImpl || assessLocalTokenSecurity;
  const assessSolanaSecurity = dependencies.assessSolanaSecurityImpl || assessSolanaMintSafety;
  const verifySolanaFirstPosition = dependencies.verifySolanaFirstPositionImpl || null;
  let running = false;
  let stopping = false;
  let activeCheckDone = Promise.resolve();
  let stopPromise = null;
  let resourcesClosed = false;
  let fallbackLogged = false;
  const nativePriceCache = new Map();
  const goPlusCache = new Map();
  let lastSmartMoneyStatsRequestWallAt = 0;

  function buildCoverageSummary(state, options = {}) {
    const coverageGaps = state.publicOnchain?.coverageGaps || [];
    const boundedGaps = boundedCoverageGaps(coverageGaps);
    if (boundedGaps !== coverageGaps) {
      state.publicOnchain.coverageGaps = boundedGaps;
      markDurableState();
    }
    const smartMoney = ensureSmartMoneyState(state);
    const topBloggers = legacyBuyEnabled ? (state.topBloggers || []) : [];
    const smartWalletCount = smartMoneyEnabled ? smartMoney.admittedWallets.length : 0;
    const targetWallets = {
      solana: bscOnly ? 0 : topBloggers.filter((entry) => entry.solanaAddress).length,
      evm: new Set([
        ...topBloggers.map((entry) => String(entry.baseAddress || "").toLowerCase()).filter(Boolean),
        ...(smartMoneyEnabled ? smartMoney.admittedWallets : []),
      ]).size,
    };
    const targetChains = bscOnly ? (targetWallets.evm ? ["bsc"] : []) : [
      ...(targetWallets.solana ? ["solana"] : []),
      ...(targetWallets.evm ? ["base", "bsc"] : []),
    ];
    const coverage = state.publicOnchain?.coverage || {};
    const configuredChains = targetChains.filter((chain) => {
      if (chain === "solana" && !verifySolanaFirstPosition) return false;
      return coverage[chain] !== "not_configured";
    });
    const missingChains = targetChains.filter((chain) => !configuredChains.includes(chain));
    const unhealthyChains = configuredChains.filter((chain) => coverage[chain] !== "healthy");

    const summaryNowMs = Number(options.nowMs ?? now());
    const profileFreshness = { status: "fresh", fresh: 0, stale: 0, unknown: 0, staleHandles: [], unknownHandles: [] };
    for (const profile of topBloggers) {
      const xCheckedAt = Date.parse(profile.xProfile?.checkedAt || "");
      const bindingCheckedAt = Date.parse(profile.walletBinding?.lastCheckedAt || profile.walletBinding?.verifiedAt || "");
      const bindingKind = publicWalletBindingKind(profile, allowGmgnObservedWallets, summaryNowMs, gmgnAttributionMaxAgeMs);
      const strictPublicIdentityFresh = monitorAllEligible
        && profile.xProfile?.source === "fxtwitter_public_profile"
        && Number.isFinite(xCheckedAt)
        && summaryNowMs - xCheckedAt <= maxXProfileAgeMs
        && Boolean(bindingKind)
        && Number(profile.xFollowers ?? profile.followers) >= minimumXFollowers
        && (!requireRecentIdentity || (Number.isFinite(bindingCheckedAt) && summaryNowMs - bindingCheckedAt <= maxIdentityAgeMs));
      const freshness = strictPublicIdentityFresh
        ? "fresh"
        : String(profile.profileFreshness || "unknown").trim().toLowerCase();
      if (["fresh", "current", "healthy"].includes(freshness)) {
        profileFreshness.fresh += 1;
      } else if (freshness.includes("stale")) {
        profileFreshness.stale += 1;
        profileFreshness.staleHandles.push(profile.handle);
      } else {
        profileFreshness.unknown += 1;
        profileFreshness.unknownHandles.push(profile.handle);
      }
    }
    if (!legacyBuyEnabled && smartMoneyEnabled) {
      const usableSmartProfiles = Object.values(smartMoney.roster || {})
        .filter((entry) => smartRosterEntryUsable(entry, summaryNowMs));
      const freshSmartProfiles = usableSmartProfiles
        .filter((entry) => smartWalletProfileFresh(entry.walletProfile, entry.wallet, summaryNowMs)
          && freshTimestamp(entry.eoaCheckedAt, summaryNowMs, smartMoneyMaxStatsAgeMs)).length;
      const lastKnownGoodProfiles = Math.max(0, usableSmartProfiles.length - freshSmartProfiles);
      profileFreshness.fresh = freshSmartProfiles;
      profileFreshness.stale = lastKnownGoodProfiles;
      profileFreshness.unknown = Math.max(0, smartWalletCount - freshSmartProfiles - lastKnownGoodProfiles);
      profileFreshness.status = smartWalletCount === 0 ? "empty"
        : (lastKnownGoodProfiles ? "last_known_good" : (profileFreshness.unknown ? "unknown" : "fresh"));
    } else if (!topBloggers.length || profileFreshness.unknown) profileFreshness.status = "unknown";
    if (profileFreshness.stale) profileFreshness.status = "stale";

    const unresolvedGaps = (state.publicOnchain?.coverageGaps || []).filter((gap) => {
      if (gap?.reason === "backlog_exceeded_signal_window") {
        // An expired backlog is a terminal fact, not recovered coverage. Keep
        // it visible so a later healthy realtime cursor cannot erase the lost
        // signal/feed interval from aggregate health.
        return true;
      }
      if (gap?.resolvedAt) return false;
      const observedAt = Date.parse(gap?.observedAt || "");
      return !Number.isFinite(observedAt) || summaryNowMs - observedAt <= maximumSignalAgeMs;
    });
    const gapSummary = { count: unresolvedGaps.length, skippedBlocks: 0, byChain: {} };
    for (const gap of unresolvedGaps) {
      const chain = String(gap?.chain || "unknown");
      const skippedBlocks = Number.isFinite(Number(gap?.fromBlock)) && Number.isFinite(Number(gap?.toBlock))
        ? Math.max(0, Number(gap.toBlock) - Number(gap.fromBlock) + 1)
        : 0;
      gapSummary.count = unresolvedGaps.length;
      gapSummary.skippedBlocks += skippedBlocks;
      gapSummary.byChain[chain] ||= { count: 0, skippedBlocks: 0 };
      gapSummary.byChain[chain].count += 1;
      gapSummary.byChain[chain].skippedBlocks += skippedBlocks;
    }

    const convergenceConfigured = legacyBuyEnabled && Boolean(config.copeApiKey);
    const convergenceAvailable = convergenceConfigured && options.convergenceAvailable === true;
    const convergence = {
      configured: convergenceConfigured,
      available: convergenceAvailable,
      source: convergenceAvailable ? "cope_capital" : null,
      reason: convergenceAvailable ? null : (!legacyBuyEnabled ? "disabled" : (options.convergenceReason || (convergenceConfigured ? "source_unavailable" : "cope_not_configured"))),
    };
    const incompleteReasons = [];
    if (profileFreshness.status !== "fresh") incompleteReasons.push(`profile_freshness_${profileFreshness.status}`);
    if (!legacyBuyEnabled && smartMoneyEnabled && smartWalletCount === 0) incompleteReasons.push("no_admitted_smart_money_wallets");
    if (missingChains.length) incompleteReasons.push(`missing_chains:${missingChains.join(",")}`);
    if (unhealthyChains.length) incompleteReasons.push(`unhealthy_chains:${unhealthyChains.join(",")}`);
    if (gapSummary.count) incompleteReasons.push("unresolved_coverage_gaps");
    if (legacyBuyEnabled && requireConvergence && !convergence.available) incompleteReasons.push(convergence.reason || "convergence_unavailable");
    return {
      candidatePoolSize: legacyBuyEnabled
        ? (state.publicOnchain?.candidateHandles?.length || configuredPublicHandles.length)
        : Object.keys(smartMoney.candidates || {}).length,
      monitoredTopCount: legacyBuyEnabled ? topBloggers.length : smartWalletCount,
      monitoringMode: legacyBuyEnabled
        ? (monitorAllEligible ? "all_qualified_bsc_kol_wallets" : "top_ranked_candidates")
        : "gmgn_high_profit_high_winrate_wallets",
      minimumXFollowers,
      rosterDiscovery: {
        enabled: legacyBuyEnabled ? dynamicDiscoveryEnabled : smartMoneyEnabled,
        status: legacyBuyEnabled ? (state.publicOnchain?.discoveryStatus || (dynamicDiscoveryEnabled ? "initializing" : "disabled")) : smartMoney.feedStatus,
        checkedAt: legacyBuyEnabled ? (state.publicOnchain?.discoveryCheckedAt || null) : smartMoney.feedCheckedAt,
        dynamicCount: legacyBuyEnabled ? Object.keys(state.publicOnchain?.dynamicCandidates || {}).length : Object.keys(smartMoney.candidates || {}).length,
        error: legacyBuyEnabled ? (state.publicOnchain?.discoveryError || null) : smartMoney.feedError,
      },
      targetWallets,
      targetChains,
      configuredChains,
      missingChains,
      unhealthyChains,
      chainCoverage: { ...coverage },
      profileFreshness,
      gaps: gapSummary,
      convergence,
      complete: incompleteReasons.length === 0,
      incompleteReasons,
      checkedAt: new Date(options.nowMs ?? now()).toISOString(),
    };
  }

  async function api(pathname, options = {}) {
    const response = await fetchImpl(`${apiBase}${pathname}`, {
      method: options.method || "GET",
      headers: {
        accept: "application/json",
        authorization: `Bearer ${config.copeApiKey}`,
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok) {
      const retry = response.status === 402 ? "free activity quota exhausted until 00:00 UTC" : `HTTP ${response.status}`;
      throw new Error(`Cope API ${retry}`);
    }
    return response.json();
  }

  async function publicJson(url, options = {}) {
    const response = await fetchImpl(url, {
      method: options.method || "GET",
      headers: {
        accept: "application/json",
        ...(options.headers || {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: AbortSignal.timeout(options.timeoutMs || 12_000),
    });
    if (!response.ok) {
      const error = new Error(`public source HTTP ${response.status}`);
      error.status = Number(response.status) || null;
      error.retryAfter = typeof response.headers?.get === "function"
        ? response.headers.get("retry-after")
        : response.headers?.["retry-after"] || response.headers?.["Retry-After"] || null;
      error.sourceUrl = url;
      throw error;
    }
    return response.json();
  }

  async function solanaRpc(method, params) {
    const payload = await publicJson(config.fomoCallSolanaRpcUrl || "https://api.mainnet-beta.solana.com", {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method, params },
    });
    if (payload?.error) throw new Error(`Solana RPC ${payload.error.message || payload.error.code || "unknown error"}`);
    return payload?.result;
  }

  async function evmRpc(rpcUrl, method, params) {
    if (dependencies.evmRpcImpl) return dependencies.evmRpcImpl(rpcUrl, method, params);
    const payload = await publicJson(rpcUrl, {
      method: "POST",
      body: { jsonrpc: "2.0", id: 1, method, params },
    });
    if (payload?.error) throw new Error(`EVM RPC ${payload.error.message || payload.error.code || "unknown error"}`);
    return payload?.result;
  }

  async function evmRpcBatch(rpcUrl, calls) {
    if (dependencies.evmRpcBatchImpl) return dependencies.evmRpcBatchImpl(rpcUrl, calls);
    const requests = calls.map((call, index) => ({ jsonrpc: "2.0", id: index + 1, method: call.method, params: call.params }));
    const payload = await publicJson(rpcUrl, { method: "POST", body: requests, timeoutMs: 8_000 });
    if (!Array.isArray(payload)) throw new Error("EVM RPC batch returned a non-array response");
    const byId = new Map(payload.map((item) => [Number(item?.id), item]));
    return requests.map((request) => {
      const item = byId.get(request.id);
      if (!item) throw new Error(`EVM RPC batch missing response ${request.id}`);
      if (item.error) throw new Error(`EVM RPC ${item.error.message || item.error.code || "unknown error"}`);
      return item.result;
    });
  }

  async function evmRpcFallback(rpcUrls, method, params) {
    let lastError;
    for (const rpcUrl of rpcUrls) {
      try { return await evmRpc(rpcUrl, method, params); }
      catch (error) { lastError = error; }
    }
    throw lastError || new Error(`no RPC endpoint available for ${method}`);
  }

  async function evmRpcBatchFallback(rpcUrls, calls) {
    let lastError;
    for (const rpcUrl of rpcUrls) {
      try { return await evmRpcBatch(rpcUrl, calls); }
      catch (error) { lastError = error; }
    }
    throw lastError || new Error("no RPC endpoint available for EVM batch");
  }

  const bscHistoricalProvider = dependencies.bscHistoricalProvider || {
    call: async (request) => {
      const blockTag = request.blockTag ?? "latest";
      const normalizedTag = typeof blockTag === "number" ? `0x${blockTag.toString(16)}` : blockTag;
      const call = { ...request };
      delete call.blockTag;
      return evmRpcFallback(bscProofRpcUrls, "eth_call", [call, normalizedTag]);
    },
    getCode: async (address, blockTag = "latest") => {
      const normalizedTag = typeof blockTag === "number" ? `0x${blockTag.toString(16)}` : blockTag;
      return evmRpcFallback(bscProofRpcUrls, "eth_getCode", [address, normalizedTag]);
    },
  };

  function ensureSmartMoneyState(state) {
    if (!state.publicOnchain.smartMoney || typeof state.publicOnchain.smartMoney !== "object") {
      state.publicOnchain.smartMoney = {};
      markDurableState();
    }
    const smartMoney = state.publicOnchain.smartMoney;
    const missingDefault = Object.keys(defaultState().publicOnchain.smartMoney)
      .some((field) => !Object.prototype.hasOwnProperty.call(smartMoney, field));
    Object.assign(smartMoney, { ...defaultState().publicOnchain.smartMoney, ...smartMoney });
    if (missingDefault) markDurableState();
    for (const field of ["candidates", "roster", "seenTrades", "pendingTrades", "chainProofedTransactions"]) {
      if (!state.publicOnchain.smartMoney[field] || typeof state.publicOnchain.smartMoney[field] !== "object") {
        state.publicOnchain.smartMoney[field] = {};
        markDurableState();
      }
    }
    if (!Array.isArray(state.publicOnchain.smartMoney.admittedWallets)) {
      state.publicOnchain.smartMoney.admittedWallets = [];
      markDurableState();
    }
    return state.publicOnchain.smartMoney;
  }

  const smartTradeKey = (trade) => `${String(trade?.transactionHash || "").toLowerCase()}:${String(trade?.wallet || "").toLowerCase()}:${String(trade?.token || "").toLowerCase()}`;

  const smartCandidateMaterial = (candidate = {}) => {
    const material = structuredClone(candidate);
    delete material.lastSeenAt;
    delete material.feedObservedAt;
    delete material.lastStatsAttemptAt;
    delete material.nextStatsAttemptAt;
    if (material.latestTrade && typeof material.latestTrade === "object") delete material.latestTrade.observedAt;
    return JSON.stringify(material);
  };

  const smartWalletProfileMaterial = (profile = null) => {
    if (!profile || typeof profile !== "object") return JSON.stringify(profile ?? null);
    const material = structuredClone(profile);
    delete material.statsCheckedAt;
    delete material.feedObservedAt;
    return JSON.stringify(material);
  };

  const smartRosterMaterial = (entry = null) => {
    if (!entry || typeof entry !== "object") return JSON.stringify(entry ?? null);
    const material = structuredClone(entry);
    delete material.eoaCheckedAt;
    if (material.walletProfile && typeof material.walletProfile === "object") {
      delete material.walletProfile.statsCheckedAt;
      delete material.walletProfile.feedObservedAt;
    }
    return JSON.stringify(material);
  };

  const setSmartStatsSchedule = (candidate, lastStatsAttemptAt, nextStatsAttemptAt) => {
    let changed = false;
    if (!Object.is(candidate.lastStatsAttemptAt, lastStatsAttemptAt)) {
      candidate.lastStatsAttemptAt = lastStatsAttemptAt;
      changed = true;
    }
    if (!Object.is(candidate.nextStatsAttemptAt, nextStatsAttemptAt)) {
      candidate.nextStatsAttemptAt = nextStatsAttemptAt;
      changed = true;
    }
    if (changed) markCheckpointState();
    return changed;
  };

  const setSmartStatsFailureCount = (candidate, value) => {
    const next = Math.max(0, Number.isSafeInteger(Number(value)) ? Number(value) : 0);
    if (Number(candidate.statsFailureCount || 0) === next) return false;
    candidate.statsFailureCount = next;
    markDurableState();
    return true;
  };

  const setSmartRateLimitedUntil = (smartMoney, value) => setCheckpointField(smartMoney, "rateLimitedUntil", value);

  const setSmartProfileStatus = (candidate, status) => {
    if (candidate.profileStatus === status) return false;
    candidate.profileStatus = status;
    markDurableState();
    return true;
  };

  function smartWindowPass(window, period) {
    const thresholds = period === "7d" ? {
      profit: smartMoneyQualificationOptions.minimumProfit7dUsd,
      winRate: smartMoneyQualificationOptions.minimumWinRate7d,
      roi: smartMoneyQualificationOptions.minimumRoi7d,
      tokens: smartMoneyQualificationOptions.minimumTokenCount7d,
    } : {
      profit: smartMoneyQualificationOptions.minimumProfit30dUsd,
      winRate: smartMoneyQualificationOptions.minimumWinRate30d,
      roi: smartMoneyQualificationOptions.minimumRoi30d,
      tokens: smartMoneyQualificationOptions.minimumTokenCount30d,
    };
    return Number(window?.realizedProfitUsd) >= thresholds.profit
      && Number(window?.winRate) >= thresholds.winRate
      && Number(window?.realizedRoi) >= thresholds.roi
      && Number(window?.tokenCount) >= thresholds.tokens
      && Number.isSafeInteger(Number(window?.buyCount)) && Number(window.buyCount) >= 0
      && Number.isSafeInteger(Number(window?.sellCount)) && Number(window.sellCount) >= 0;
  }

  function smartStatsRecordValid(stats, wallet, period, nowMs) {
    const checkedAt = Date.parse(stats?.checkedAt || "");
    const lastTradeAt = Date.parse(stats?.lastTradeAt || "");
    const createdAt = Date.parse(stats?.createdAt || "");
    return String(stats?.wallet || "").toLowerCase() === wallet
      && stats?.period === period
      && Number.isFinite(stats?.realizedProfitUsd)
      && Number.isFinite(stats?.winRate)
      && stats.winRate >= 0 && stats.winRate <= 1
      && Number.isFinite(stats?.realizedRoi)
      && Number.isSafeInteger(stats?.tokenCount) && stats.tokenCount >= 0
      && Number.isSafeInteger(stats?.buyCount) && stats.buyCount >= 0
      && Number.isSafeInteger(stats?.sellCount) && stats.sellCount >= 0
      && Number.isFinite(checkedAt)
      && checkedAt <= nowMs + ATTRIBUTION_FUTURE_TOLERANCE_MS
      && nowMs - checkedAt <= smartMoneyMaxStatsAgeMs
      && Number.isFinite(lastTradeAt)
      && lastTradeAt <= nowMs + ATTRIBUTION_FUTURE_TOLERANCE_MS
      && nowMs - lastTradeAt <= 7 * 24 * 60 * 60_000
      && Number.isFinite(createdAt)
      && createdAt <= nowMs + ATTRIBUTION_FUTURE_TOLERANCE_MS
      && Number.isSafeInteger(stats?.createdTokenCount)
      && stats.createdTokenCount >= 0
      && smartMoneyTagsAreClean(stats?.tags);
  }

  function smartWalletProfileWithinAge(profile, wallet, nowMs, maximumStatsAgeMs) {
    const normalizedWallet = String(wallet || "").toLowerCase();
    const statsCheckedAt = Date.parse(profile?.statsCheckedAt || "");
    const feedObservedAt = Date.parse(profile?.feedObservedAt || "");
    const createdAt = Date.parse(profile?.createdAt || "");
    return profile?.scheme === "gmgn_wallet_stats_dual_window_v1"
      && profile?.source === "gmgn_portfolio_stats"
      && profile?.qualified === true
      && Number(profile?.chainId) === BSC_CHAIN_ID
      && isAddress(normalizedWallet)
      && String(profile?.wallet || "").toLowerCase() === normalizedWallet
      && smartMoneyTagsAreClean(profile?.tags)
      && Number.isFinite(statsCheckedAt)
      && statsCheckedAt <= nowMs + ATTRIBUTION_FUTURE_TOLERANCE_MS
      && nowMs - statsCheckedAt <= maximumStatsAgeMs
      && Number.isFinite(feedObservedAt)
      && feedObservedAt <= nowMs + ATTRIBUTION_FUTURE_TOLERANCE_MS
      && nowMs - feedObservedAt <= smartMoneyCandidateRetentionMs
      && Number.isFinite(createdAt)
      && createdAt <= nowMs - smartMoneyQualificationOptions.minimumWalletAgeMs
      && Number.isSafeInteger(Number(profile?.createdTokenCount))
      && Number(profile.createdTokenCount) <= smartMoneyQualificationOptions.maximumCreatedTokens
      && smartWindowPass(profile?.windows?.["7d"], "7d")
      && smartWindowPass(profile?.windows?.["30d"], "30d");
  }

  function smartWalletProfileFresh(profile, wallet, nowMs) {
    return smartWalletProfileWithinAge(profile, wallet, nowMs, smartMoneyMaxStatsAgeMs);
  }

  function smartWalletProfileLastKnownGood(profile, wallet, nowMs) {
    return smartWalletProfileWithinAge(profile, wallet, nowMs, smartMoneyLastKnownGoodGraceMs);
  }

  function smartCandidateHasLastKnownGood(candidate, nowMs) {
    const status = String(candidate?.profileStatus || "");
    return ["qualified", "qualified_degraded_stats", "qualified_degraded_rate_limited"].includes(status)
      && smartWalletProfileLastKnownGood(candidate?.walletProfile, candidate?.wallet, nowMs);
  }

  function smartRosterEntryUsable(entry, nowMs) {
    const wallet = String(entry?.wallet || "").toLowerCase();
    return entry?.monitorKind === "smart_money_performance"
      && entry?.source === SMART_MONEY_SOURCE_ID
      && entry?.eoaVerified === true
      && String(entry?.walletCode || "").toLowerCase() === "0x"
      && freshTimestamp(entry?.eoaCheckedAt, nowMs, smartMoneyLastKnownGoodGraceMs)
      && smartWalletProfileLastKnownGood(entry?.walletProfile, wallet, nowMs);
  }

  function smartRosterEntryFresh(entry, nowMs) {
    const wallet = String(entry?.wallet || "").toLowerCase();
    return smartRosterEntryUsable(entry, nowMs)
      && freshTimestamp(entry.eoaCheckedAt, nowMs, smartMoneyMaxStatsAgeMs)
      && smartWalletProfileFresh(entry.walletProfile, wallet, nowMs);
  }

  function smartRosterEntryFromCandidate(candidate, walletProfile, eoaCheckedAt) {
    const wallet = String(candidate?.wallet || walletProfile?.wallet || "").toLowerCase();
    return {
      monitorKind: "smart_money_performance",
      wallet,
      baseAddress: wallet,
      walletProfile,
      lastTradeAt: candidate?.lastTradeAt,
      eoaVerified: true,
      eoaCheckedAt,
      walletCode: "0x",
      source: SMART_MONEY_SOURCE_ID,
      sourceClassification: smartMoneySourceClassification(walletProfile?.tags, candidate?.tags),
    };
  }

  function smartQualificationSnapshot(smartMoney, nowMs) {
    const admitted = Object.values(smartMoney.roster || {}).filter((entry) => smartRosterEntryUsable(entry, nowMs));
    const fresh = admitted.filter((entry) => smartRosterEntryFresh(entry, nowMs)).length;
    const lastKnownGood = Math.max(0, admitted.length - fresh);
    return {
      status: admitted.length === 0 ? "empty" : (lastKnownGood ? "last_known_good" : "healthy"),
      admitted: admitted.length,
      fresh,
      lastKnownGood,
      checkedAt: new Date(nowMs).toISOString(),
    };
  }

  function updateSmartQualificationCoverage(smartMoney, nowMs) {
    const next = smartQualificationSnapshot(smartMoney, nowMs);
    const previous = smartMoney.qualificationCoverage || {};
    if (["status", "admitted", "fresh", "lastKnownGood"]
      .some((field) => !Object.is(previous[field], next[field]))) markTelemetryTransition();
    smartMoney.qualificationCoverage = next;
    return next;
  }

  async function waitForSmartMoneyStatsSlot() {
    const currentWallAt = Number(wallNow());
    const delayMs = Math.max(0, lastSmartMoneyStatsRequestWallAt + smartMoneyStatsRequestIntervalMs - currentWallAt);
    if (delayMs) await sleep(delayMs);
    lastSmartMoneyStatsRequestWallAt = Number(wallNow());
  }

  async function readSmartMoneyStats(wallet, period, checkedAtMs) {
    await waitForSmartMoneyStatsSlot();
    const result = await fetchSmartMoneyStats(wallet, period, checkedAtMs);
    if (result?.period === period && String(result?.wallet || "").toLowerCase() === wallet) return result;
    return parseGmgnWalletStats(result, { wallet, period, checkedAtMs });
  }

  function noteSmartCandidate(smartMoney, trade, nowMs) {
    const wallet = String(trade.wallet || "").toLowerCase();
    if (!isAddress(wallet) || !smartMoneyTagsAreClean(trade.tags)) return;
    const previous = smartMoney.candidates[wallet] || {};
    const next = {
      ...previous,
      wallet,
      tags: [...new Set([...normalizedTags(previous.tags), ...normalizedTags(trade.tags)])],
      firstSeenAt: Number(previous.firstSeenAt || nowMs),
      lastSeenAt: nowMs,
      lastTradeAt: trade.timestampMs,
      feedObservedAt: trade.observedAt || new Date(nowMs).toISOString(),
      latestTrade: trade,
    };
    smartMoney.candidates[wallet] = next;
    if (smartCandidateMaterial(previous) !== smartCandidateMaterial(next)) markDurableState();
  }

  function deletePendingSmartTradesForWallet(smartMoney, walletValue) {
    const wallet = String(walletValue || "").toLowerCase();
    for (const [key, pending] of Object.entries(smartMoney.pendingTrades || {})) {
      if (String(pending?.wallet || "").toLowerCase() === wallet) {
        delete smartMoney.pendingTrades[key];
        markDurableState();
      }
    }
  }

  function boundSmartPendingTrades(smartMoney, nowMs) {
    const previousKeys = new Set(Object.keys(smartMoney.pendingTrades || {}));
    const admittedWallets = new Set(Object.entries(smartMoney.roster || {})
      .filter(([, profile]) => smartRosterEntryUsable(profile, nowMs))
      .map(([wallet]) => wallet));
    const admitted = [];
    const unknown = [];
    for (const [key, trade] of Object.entries(smartMoney.pendingTrades || {})) {
      const timestampMs = Number(trade?.timestampMs || trade?.firstSeenAt || 0);
      if (!fresh({ timestampMs }, nowMs, maximumSignalAgeMs)) continue;
      const wallet = String(trade?.wallet || "").toLowerCase();
      const status = String(smartMoney.candidates?.[wallet]?.profileStatus || "");
      if (/^(?:rejected_|revoked_)/.test(status)) continue;
      (admittedWallets.has(wallet) ? admitted : unknown).push([key, trade]);
    }
    admitted.sort(([, left], [, right]) => Number(left?.timestampMs || left?.firstSeenAt || 0)
      - Number(right?.timestampMs || right?.firstSeenAt || 0));
    const unknownPairs = new Map();
    for (const entry of unknown) {
      const [, trade] = entry;
      const pair = `${String(trade?.wallet || "").toLowerCase()}:${String(trade?.token || "").toLowerCase()}`;
      const timestampMs = Number(trade?.timestampMs || trade?.firstSeenAt || 0);
      const existing = unknownPairs.get(pair);
      unknownPairs.set(pair, {
        earliest: !existing || timestampMs < existing.earliestAt ? entry : existing.earliest,
        earliestAt: !existing ? timestampMs : Math.min(existing.earliestAt, timestampMs),
        latestAt: !existing ? timestampMs : Math.max(existing.latestAt, timestampMs),
      });
    }
    const compactUnknown = [...unknownPairs.values()]
      .sort((left, right) => right.latestAt - left.latestAt)
      .map((item) => item.earliest);
    const nextPending = Object.fromEntries([...admitted, ...compactUnknown].slice(0, 500));
    const nextKeys = Object.keys(nextPending);
    if (nextKeys.length !== previousKeys.size || nextKeys.some((key) => !previousKeys.has(key))) markDurableState();
    smartMoney.pendingTrades = nextPending;
  }

  function revokeSmartCandidate(smartMoney, trade, nowMs) {
    const wallet = String(trade?.wallet || "").toLowerCase();
    if (!isAddress(wallet)) return;
    delete smartMoney.roster[wallet];
    smartMoney.admittedWallets = smartMoney.admittedWallets.filter((candidate) => candidate !== wallet);
    const previous = smartMoney.candidates[wallet] || {};
    smartMoney.candidates[wallet] = {
      ...previous,
      wallet,
      tags: [...new Set([...normalizedTags(previous.tags), ...normalizedTags(trade.tags)])],
      firstSeenAt: Number(previous.firstSeenAt || nowMs),
      lastSeenAt: nowMs,
      lastTradeAt: trade.timestampMs,
      feedObservedAt: trade.observedAt || new Date(nowMs).toISOString(),
      latestTrade: trade,
      profileStatus: "revoked_blocked_tag",
    };
    setSmartStatsSchedule(smartMoney.candidates[wallet], nowMs, nowMs + smartMoneyRejectedCacheMs);
    markDurableState();
    deletePendingSmartTradesForWallet(smartMoney, wallet);
  }

  async function refreshSmartMoneyFeed(state, nowMs) {
    const smartMoney = ensureSmartMoneyState(state);
    if (!smartMoneyEnabled) {
      setTelemetryField(smartMoney, "feedStatus", "disabled");
      setTelemetryField(smartMoney, "statsStatus", "disabled");
      if (smartMoney.admittedWallets.length) markDurableState();
      smartMoney.admittedWallets = [];
      return "disabled";
    }
    const rateLimitedUntil = Date.parse(smartMoney.rateLimitedUntil || "");
    if (Number.isFinite(rateLimitedUntil) && nowMs < rateLimitedUntil) {
      setTelemetryField(smartMoney, "feedStatus", "rate_limited");
      return "partial";
    }
    if (Number.isFinite(rateLimitedUntil) && nowMs >= rateLimitedUntil) {
      setSmartRateLimitedUntil(smartMoney, null);
    }
    const feedNextRetryAt = Date.parse(smartMoney.feedNextRetryAt || "");
    if (Number.isFinite(feedNextRetryAt) && nowMs < feedNextRetryAt) {
      setTelemetryField(smartMoney, "feedStatus", "partial");
      return "partial";
    }
    const checkedAt = Date.parse(smartMoney.feedCheckedAt || "");
    if (Number.isFinite(checkedAt) && nowMs - checkedAt < smartMoneyDiscoveryIntervalMs) return smartMoney.feedStatus;
    try {
      await waitForSmartMoneyStatsSlot();
      const discovered = await discoverSmartMoneyTrades(nowMs);
      const trades = Array.isArray(discovered)
        ? discovered.filter((trade) => trade?.scheme === "gmgn_smartmoney_trade_v1")
        : parseGmgnBscSmartMoneyBuys(discovered, { observedAtMs: nowMs });
      const eligibleTrades = [];
      for (const trade of trades) {
        if (trade?.eligible === false || !smartMoneyTagsAreClean(trade.tags)) revokeSmartCandidate(smartMoney, trade, nowMs);
        else {
          noteSmartCandidate(smartMoney, trade, nowMs);
          eligibleTrades.push(trade);
        }
      }
      if (!smartMoney.feedInitializedAt && eligibleTrades.length) {
        for (const trade of trades) smartMoney.seenTrades[smartTradeKey(trade)] = nowMs;
        smartMoney.feedInitializedAt = new Date(nowMs).toISOString();
        smartMoney.baseline = {
          mode: "silent_first_nonempty_feed",
          tradeCount: eligibleTrades.length,
          walletCount: new Set(eligibleTrades.map((trade) => trade.wallet)).size,
          newestOccurredAt: eligibleTrades.at(-1)?.occurredAt || null,
          observedAt: new Date(nowMs).toISOString(),
        };
        markDurableState();
      } else if (smartMoney.feedInitializedAt) {
        for (const trade of trades) {
          const key = smartTradeKey(trade);
          if (smartMoney.seenTrades[key]) continue;
          smartMoney.seenTrades[key] = nowMs;
          markDurableState();
          if (trade?.eligible !== false && smartMoneyTagsAreClean(trade.tags)
            && fresh({ timestampMs: trade.timestampMs }, nowMs, maximumSignalAgeMs)) {
            smartMoney.pendingTrades[key] = { ...trade, firstSeenAt: nowMs, attempts: 0 };
            markDurableState();
          }
        }
      }
      smartMoney.seenTrades = Object.fromEntries(Object.entries(smartMoney.seenTrades)
        .sort(([, left], [, right]) => Number(right || 0) - Number(left || 0)).slice(0, 5_000));
      boundSmartPendingTrades(smartMoney, nowMs);
      const previousCandidateCount = Object.keys(smartMoney.candidates).length;
      const candidates = Object.values(smartMoney.candidates)
        .filter((candidate) => nowMs - Number(candidate.lastSeenAt || 0) <= smartMoneyCandidateRetentionMs)
        .sort((left, right) => Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0))
        .slice(0, smartMoneyCandidateLimit);
      if (candidates.length !== previousCandidateCount) markDurableState();
      smartMoney.candidates = Object.fromEntries(candidates.map((candidate) => [candidate.wallet, candidate]));
      smartMoney.feedCheckedAt = new Date(nowMs).toISOString();
      setTelemetryField(smartMoney, "feedStatus", trades.length ? "healthy" : "empty");
      setTelemetryField(smartMoney, "feedError", null);
      setTelemetryField(smartMoney, "feedFailureCount", 0);
      setTelemetryField(smartMoney, "feedNextRetryAt", null);
      smartMoney.lastFeedSuccessAt = new Date(nowMs).toISOString();
      if (!smartMoney.initializedAt) {
        smartMoney.initializedAt = new Date(nowMs).toISOString();
        markDurableState();
      }
      return smartMoney.feedStatus;
    } catch (error) {
      smartMoney.feedCheckedAt = new Date(nowMs).toISOString();
      setTelemetryField(smartMoney, "feedStatus", "partial");
      setTelemetryField(smartMoney, "feedError", String(error?.message || error).slice(0, 180));
      const resetAt = gmgnRateLimitResetMs(error, nowMs);
      const failureCount = Number(smartMoney.feedFailureCount || 0) + 1;
      const backoffMs = SMART_MONEY_FEED_BACKOFF_MS[Math.min(failureCount - 1, SMART_MONEY_FEED_BACKOFF_MS.length - 1)];
      setTelemetryField(smartMoney, "feedFailureCount", failureCount);
      setTelemetryField(smartMoney, "feedNextRetryAt", new Date(resetAt || nowMs + backoffMs).toISOString());
      if (resetAt) {
        setSmartRateLimitedUntil(smartMoney, new Date(resetAt).toISOString());
      }
      logger.error(`[fomo-call][smart-money-feed] ${smartMoney.feedError}; retaining cached roster`);
      return "partial";
    }
  }

  async function refreshSmartMoneyStats(state, nowMs) {
    const smartMoney = ensureSmartMoneyState(state);
    if (!smartMoneyEnabled) return "disabled";
    const rateLimitedUntil = Date.parse(smartMoney.rateLimitedUntil || "");
    if (Number.isFinite(rateLimitedUntil) && nowMs < rateLimitedUntil) {
      setTelemetryField(smartMoney, "statsStatus", "rate_limited");
      updateSmartQualificationCoverage(smartMoney, nowMs);
      return "partial";
    }
    if (Number.isFinite(rateLimitedUntil) && nowMs >= rateLimitedUntil) {
      setSmartRateLimitedUntil(smartMoney, null);
    }
    for (const candidate of Object.values(smartMoney.candidates || {})) {
      const wallet = String(candidate?.wallet || "").toLowerCase();
      if (smartMoney.roster[wallet]
        || /^(?:rejected_|revoked_)/.test(String(candidate?.profileStatus || ""))
        || candidate?.eoaVerified !== true
        || String(candidate?.walletCode || "").toLowerCase() !== "0x"
        || !freshTimestamp(candidate?.eoaCheckedAt, nowMs, smartMoneyLastKnownGoodGraceMs)
        || !smartCandidateHasLastKnownGood(candidate, nowMs)) continue;
      smartMoney.roster[wallet] = smartRosterEntryFromCandidate(
        candidate,
        candidate.walletProfile,
        candidate.eoaCheckedAt,
      );
      markDurableState();
    }
    const pendingWallets = new Set(Object.values(smartMoney.pendingTrades).map((trade) => String(trade.wallet || "").toLowerCase()));
    const candidates = Object.values(smartMoney.candidates)
      .filter((candidate) => isAddress(String(candidate.wallet || "")) && smartMoneyTagsAreClean(candidate.tags))
      .filter((candidate) => !Number.isFinite(Number(candidate.nextStatsAttemptAt)) || nowMs >= Number(candidate.nextStatsAttemptAt))
      // Refresh known-good wallets first so a constantly changing public feed
      // cannot starve the small admitted roster. Pending new trades are next;
      // each tier is oldest-attempt-first for bounded, restart-safe fairness.
      .sort((left, right) => {
        const priority = (candidate) => smartCandidateHasLastKnownGood(candidate, nowMs)
          ? 2 : (pendingWallets.has(candidate.wallet) ? 1 : 0);
        const lastAttempt = (candidate) => Number.isFinite(Number(candidate?.lastStatsAttemptAt))
          ? Number(candidate.lastStatsAttemptAt) : Number.NEGATIVE_INFINITY;
        return priority(right) - priority(left)
          || lastAttempt(left) - lastAttempt(right)
          || Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0);
      })
      .slice(0, smartMoneyStatsBatchLimit);
    let succeeded = 0;
    let failed = 0;
    for (const candidate of candidates) {
      const wallet = String(candidate.wallet).toLowerCase();
      let eoaCheckAttempted = false;
      try {
        const sevenDay = await readSmartMoneyStats(wallet, "7d", nowMs);
        if (!sevenDay || !smartStatsRecordValid(sevenDay, wallet, "7d", nowMs)) {
          throw new Error("GMGN 7d stats unavailable, incomplete, or invalid");
        }
        if (!smartWindowPass(sevenDay, "7d")) {
          setSmartProfileStatus(candidate, "rejected_7d");
          setSmartStatsFailureCount(candidate, 0);
          setSmartStatsSchedule(candidate, nowMs, nowMs + smartMoneyRejectedCacheMs);
          if (Object.prototype.hasOwnProperty.call(smartMoney.roster, wallet)) {
            delete smartMoney.roster[wallet];
            markDurableState();
          }
          deletePendingSmartTradesForWallet(smartMoney, wallet);
          succeeded += 1;
          continue;
        }
        const thirtyDay = await readSmartMoneyStats(wallet, "30d", nowMs);
        if (!thirtyDay || !smartStatsRecordValid(thirtyDay, wallet, "30d", nowMs)) {
          throw new Error("GMGN 30d stats unavailable, incomplete, or invalid");
        }
        let walletProfile = qualifyGmgnSmartMoneyWallet(sevenDay, thirtyDay, { nowMs, ...smartMoneyQualificationOptions });
        if (walletProfile) {
          eoaCheckAttempted = true;
          const code = await evmRpcFallback(bscBatchReceiptRpcUrls, "eth_getCode", [wallet, "latest"]);
          if (String(code || "").toLowerCase() !== "0x") walletProfile = null;
        }
        if (!walletProfile) {
          setSmartProfileStatus(candidate, "rejected_30d_or_wallet");
          setSmartStatsFailureCount(candidate, 0);
          setSmartStatsSchedule(candidate, nowMs, nowMs + smartMoneyRejectedCacheMs);
          if (Object.prototype.hasOwnProperty.call(smartMoney.roster, wallet)) {
            delete smartMoney.roster[wallet];
            markDurableState();
          }
          deletePendingSmartTradesForWallet(smartMoney, wallet);
          succeeded += 1;
          continue;
        }
        walletProfile.feedObservedAt = candidate.feedObservedAt || new Date(nowMs).toISOString();
        const previousWalletProfile = candidate.walletProfile;
        const previousRoster = smartMoney.roster[wallet];
        const previousCandidateEoa = candidate.eoaVerified === true
          && candidate.walletCode === "0x" && Boolean(candidate.eoaCheckedAt);
        const eoaCheckedAt = new Date(nowMs).toISOString();
        const nextRoster = smartRosterEntryFromCandidate(candidate, walletProfile, eoaCheckedAt);
        smartMoney.roster[wallet] = nextRoster;
        setSmartProfileStatus(candidate, "qualified");
        setSmartStatsFailureCount(candidate, 0);
        setSmartStatsSchedule(candidate, nowMs, nowMs + smartMoneyQualifiedCacheMs);
        candidate.walletProfile = walletProfile;
        candidate.eoaVerified = true;
        candidate.eoaCheckedAt = eoaCheckedAt;
        candidate.walletCode = "0x";
        if (smartWalletProfileMaterial(previousWalletProfile) !== smartWalletProfileMaterial(walletProfile)
          || smartRosterMaterial(previousRoster) !== smartRosterMaterial(nextRoster)
          || !previousCandidateEoa) markDurableState();
        succeeded += 1;
      } catch (error) {
        failed += 1;
        const resetAt = gmgnRateLimitResetMs(error, nowMs);
        const hasLastKnownGood = smartCandidateHasLastKnownGood(candidate, nowMs);
        setSmartProfileStatus(candidate, hasLastKnownGood
          ? (resetAt ? "qualified_degraded_rate_limited" : "qualified_degraded_stats")
          : (resetAt ? "rate_limited" : "stats_error"));
        const previousFailureCount = Number(candidate.statsFailureCount || 0);
        const failureCount = (Number.isSafeInteger(previousFailureCount) && previousFailureCount >= 0
          ? previousFailureCount : 0) + 1;
        setSmartStatsFailureCount(candidate, failureCount);
        const transientRetryMs = SMART_MONEY_STATS_BACKOFF_MS[
          Math.min(failureCount - 1, SMART_MONEY_STATS_BACKOFF_MS.length - 1)
        ];
        setSmartStatsSchedule(candidate, nowMs, resetAt || nowMs + transientRetryMs);
        setTelemetryField(smartMoney, "statsError", String(error?.message || error).slice(0, 180));
        // A state written by the old all-or-nothing cleanup may retain the
        // qualified profile but no roster entry. Re-prove only the immutable
        // EOA gate; the performance profile itself must already pass every LKG
        // gate and is never refreshed from a malformed stats response.
        if (hasLastKnownGood && !smartMoney.roster[wallet] && !eoaCheckAttempted) {
          try {
            const code = await evmRpcFallback(bscBatchReceiptRpcUrls, "eth_getCode", [wallet, "latest"]);
            if (String(code || "").toLowerCase() === "0x") {
              const eoaCheckedAt = new Date(nowMs).toISOString();
              candidate.eoaVerified = true;
              candidate.eoaCheckedAt = eoaCheckedAt;
              candidate.walletCode = "0x";
              smartMoney.roster[wallet] = smartRosterEntryFromCandidate(candidate, candidate.walletProfile, eoaCheckedAt);
              markDurableState();
            }
          } catch (restoreError) {
            logger.error(`[fomo-call][smart-money-lkg] ${wallet} EOA recheck failed: ${String(restoreError?.message || restoreError).slice(0, 140)}`);
          }
        }
        if (resetAt) {
          setSmartRateLimitedUntil(smartMoney, new Date(resetAt).toISOString());
          break;
        }
      }
    }
    for (const [wallet, profile] of Object.entries(smartMoney.roster)) {
      const candidate = smartMoney.candidates[wallet];
      if (!candidate || nowMs - Number(candidate.lastSeenAt || 0) > smartMoneyCandidateRetentionMs
        || !smartCandidateHasLastKnownGood(candidate, nowMs)
        || !smartRosterEntryUsable(profile, nowMs)) {
        delete smartMoney.roster[wallet];
        markDurableState();
      }
    }
    const ranked = Object.values(smartMoney.roster)
      .filter((profile) => smartRosterEntryUsable(profile, nowMs))
      .sort((left, right) => Number(right.walletProfile?.windows?.["30d"]?.realizedProfitUsd || 0)
        - Number(left.walletProfile?.windows?.["30d"]?.realizedProfitUsd || 0))
      .slice(0, smartMoneyMaxWallets);
    const nextRoster = Object.fromEntries(ranked.map((profile) => [profile.wallet, profile]));
    const nextAdmittedWallets = ranked.map((profile) => profile.wallet);
    if (Object.keys(nextRoster).length !== Object.keys(smartMoney.roster).length
      || nextAdmittedWallets.some((wallet, index) => smartMoney.admittedWallets[index] !== wallet)
      || nextAdmittedWallets.length !== smartMoney.admittedWallets.length) markDurableState();
    smartMoney.roster = nextRoster;
    smartMoney.admittedWallets = nextAdmittedWallets;
    smartMoney.statsCheckedAt = new Date(nowMs).toISOString();
    const qualificationCoverage = updateSmartQualificationCoverage(smartMoney, nowMs);
    const statsStatus = failed
      ? (qualificationCoverage.admitted ? "partial" : "degraded")
      : (qualificationCoverage.status === "healthy" ? "healthy"
        : (qualificationCoverage.status === "last_known_good" ? "partial" : "degraded"));
    setTelemetryField(smartMoney, "statsStatus", statsStatus);
    if (!failed && statsStatus === "healthy") setTelemetryField(smartMoney, "statsError", null);
    else if (!failed && qualificationCoverage.status === "empty") {
      setTelemetryField(smartMoney, "statsError", "no fresh or last-known-good qualified wallets");
    }
    return smartMoney.statsStatus === "healthy" ? "healthy" : "partial";
  }

  async function refreshFromSharedXCallRoster(state, nowMs) {
    if (!sharedRosterEnabled) return null;
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(sharedRosterFile, "utf8"));
    } catch (error) {
      const reason = error?.code === "ENOENT" ? "shared_fomo_x_call_state_missing" : `shared_fomo_x_call_state_unreadable:${error.message}`;
      state.publicOnchain.sharedRoster = {
        status: "stale",
        checkedAt: new Date(nowMs).toISOString(),
        sourceCheckedAt: null,
        admitted: 0,
        reason,
      };
      if (sharedRosterRequired) throw new Error(reason);
      return null;
    }
    const selected = selectFreshFomoXCallRoster(parsed, {
      nowMs,
      maximumStateAgeMs: sharedRosterMaxAgeMs,
      maximumProofAgeMs: sharedProofMaxAgeMs,
      minimumFollowers: minimumXFollowers,
    });
    state.publicOnchain.sharedRoster = {
      status: selected.status,
      checkedAt: new Date(nowMs).toISOString(),
      sourceCheckedAt: selected.checkedAt || null,
      admitted: selected.profiles.length,
      reason: selected.reason,
    };
    if (selected.status !== "healthy") {
      if (sharedRosterRequired) throw new Error(selected.reason || "shared_fomo_x_call_roster_not_healthy");
      return null;
    }
    const topBloggers = selectVerifiedBscKols(selected.profiles, {
      minimumFollowers: minimumXFollowers,
      requireTwitter: true,
      allowGmgnObservedWallets,
      requireBscActivity: true,
      requireRecentIdentity: true,
      requireFreshProofs: true,
      maxIdentityAgeMs: sharedProofMaxAgeMs,
      maxXProfileAgeMs: sharedProofMaxAgeMs,
      maxAttributionAgeMs: sharedProofMaxAgeMs,
      nowMs,
    });
    if (!topBloggers.length) {
      state.publicOnchain.sharedRoster.status = "empty";
      state.publicOnchain.sharedRoster.reason = "shared_roster_failed_final_wallet_selection";
      if (sharedRosterRequired) throw new Error(state.publicOnchain.sharedRoster.reason);
      return null;
    }
    const previousWallets = new Set((state.topBloggers || [])
      .map((entry) => String(entry.baseAddress || "").toLowerCase()).filter(Boolean));
    const addedWallets = topBloggers
      .map((entry) => String(entry.baseAddress || "").toLowerCase())
      .filter((wallet) => wallet && !previousWallets.has(wallet));
    const baselineEstablished = state.publicOnchain.bscSilentBaselinePending === false
      && Number.isSafeInteger(Number(state.publicOnchain.bscNextBlock));
    if (baselineEstablished && addedWallets.length && newWalletLookbackBlocks > 0) {
      state.publicOnchain.bscLookbackRequested = true;
      state.publicOnchain.lastWalletExpansion = {
        addedCount: addedWallets.length,
        lookbackBlocks: newWalletLookbackBlocks,
        observedAt: new Date(nowMs).toISOString(),
      };
    }
    state.publicOnchain.profiles = Object.fromEntries(topBloggers.map((profile) => [profile.handle.toLowerCase(), profile]));
    state.publicOnchain.candidateHandles = topBloggers.map((profile) => profile.handle);
    state.publicOnchain.discoveryCheckedAt = selected.checkedAt || new Date(nowMs).toISOString();
    state.publicOnchain.discoveryStatus = "healthy_shared_roster";
    state.publicOnchain.discoveryError = null;
    state.publicOnchain.profilesCheckedAt = new Date(nowMs).toISOString();
    state.publicOnchain.profileCoverage = "healthy";
    state.topBloggers = topBloggers;
    state.watchlist = { id: "public-onchain", name: "fomo-shared-x-admitted-bsc-kols", handles: topBloggers.map((entry) => entry.handle) };
    state.leaderboardCheckedAt = new Date(nowMs).toISOString();
    markDurableState();
    return "healthy";
  }

  function candidateHandles(state, nowMs) {
    const dynamic = Object.values(state.publicOnchain.dynamicCandidates || {})
      .filter((candidate) => nowMs - Number(candidate.lastSeenAt || 0) <= dynamicCandidateRetentionMs)
      .filter((candidate) => gmgnTagsAreClean(candidate.tags)
        && candidate.ambiguousIdentity !== true
        && candidate.ambiguousWallets !== true
        && candidate.ambiguousHandles !== true)
      .filter((candidate) => !Number.isFinite(Number(candidate.nextProfileAttemptAt)) || nowMs >= Number(candidate.nextProfileAttemptAt))
      .sort((left, right) => {
        const leftAttempted = Number.isFinite(Number(left.lastProfileAttemptAt));
        const rightAttempted = Number.isFinite(Number(right.lastProfileAttemptAt));
        if (leftAttempted !== rightAttempted) return leftAttempted ? 1 : -1;
        if (leftAttempted && Number(left.lastProfileAttemptAt) !== Number(right.lastProfileAttemptAt)) {
          return Number(left.lastProfileAttemptAt) - Number(right.lastProfileAttemptAt);
        }
        return Number(right.lastSeenAt || 0) - Number(left.lastSeenAt || 0);
      })
      .map((candidate) => candidate.handle);
    return [...new Map([...configuredPublicHandles, ...dynamic].map((handle) => [handle.toLowerCase(), handle])).values()];
  }

  async function refreshDynamicRoster(state, nowMs) {
    state.publicOnchain.dynamicCandidates ||= {};
    if (!dynamicDiscoveryEnabled) {
      state.publicOnchain.discoveryStatus = "disabled";
      state.publicOnchain.discoveryError = null;
      state.publicOnchain.candidateHandles = candidateHandles(state, nowMs);
      return "disabled";
    }
    const checkedAt = Date.parse(state.publicOnchain.discoveryCheckedAt || "");
    if (Number.isFinite(checkedAt) && nowMs - checkedAt < dynamicDiscoveryIntervalMs) {
      state.publicOnchain.candidateHandles = candidateHandles(state, nowMs);
      return state.publicOnchain.discoveryStatus || "partial";
    }
    const previousHandles = new Set(candidateHandles(state, nowMs).map((handle) => handle.toLowerCase()));
    try {
      const discovered = await discoverBscKolCandidates();
      for (const candidate of discovered.slice(0, dynamicCandidateLimit)) {
        const key = String(candidate.handle || "").toLowerCase();
        if (!HANDLE.test(candidate.handle || "") || !key || !gmgnTagsAreClean(candidate.tags)
          || candidate.ambiguousIdentity === true || candidate.ambiguousWallets === true || candidate.ambiguousHandles === true) continue;
        const previous = state.publicOnchain.dynamicCandidates[key] || {};
        state.publicOnchain.dynamicCandidates[key] = {
          ...previous,
          ...candidate,
          firstSeenAt: previous.firstSeenAt || nowMs,
          lastSeenAt: nowMs,
        };
        markDurableState();
      }
      for (const [key, candidate] of Object.entries(state.publicOnchain.dynamicCandidates)) {
        if (nowMs - Number(candidate.lastSeenAt || 0) > dynamicCandidateRetentionMs) {
          delete state.publicOnchain.dynamicCandidates[key];
          markDurableState();
        }
      }
      state.publicOnchain.discoveryCheckedAt = new Date(nowMs).toISOString();
      state.publicOnchain.discoveryStatus = "healthy";
      state.publicOnchain.discoveryError = null;
    } catch (error) {
      state.publicOnchain.discoveryCheckedAt = new Date(nowMs).toISOString();
      state.publicOnchain.discoveryStatus = "partial";
      state.publicOnchain.discoveryError = String(error.message || error).slice(0, 180);
      logger.error(`[fomo-call][roster-discovery] ${state.publicOnchain.discoveryError}; retaining the last verified roster`);
    }
    const handles = candidateHandles(state, nowMs);
    state.publicOnchain.candidateHandles = handles;
    if (handles.some((handle) => !previousHandles.has(handle.toLowerCase()))) state.publicOnchain.profilesCheckedAt = null;
    return state.publicOnchain.discoveryStatus;
  }

  async function refreshBscActivity(profiles, nowMs) {
    if (!requireBscActivity) return "disabled";
    const candidates = profiles.filter((profile) => publicWalletBindingKind(profile, allowGmgnObservedWallets, nowMs, gmgnAttributionMaxAgeMs) && isAddress(String(profile.baseAddress || "")));
    let succeeded = 0;
    for (let index = 0; index < candidates.length; index += 40) {
      const group = candidates.slice(index, index + 40);
      const counts = await evmRpcBatchFallback(bscReceiptRpcUrls, group.map((profile) => ({
        method: "eth_getTransactionCount",
        params: [profile.baseAddress, "latest"],
      })));
      counts.forEach((count, itemIndex) => {
        if (!/^0x[0-9a-f]+$/i.test(String(count || ""))) return;
        group[itemIndex].bscTransactionCount = Number(BigInt(count));
        group[itemIndex].bscActivityCheckedAt = new Date(nowMs).toISOString();
        succeeded += 1;
        markDurableState();
      });
    }
    return succeeded === candidates.length ? "healthy" : "partial";
  }

  async function refreshXProfiles(profiles, nowMs) {
    const targets = profiles.filter((profile) => (profile.twitterIdentityVerified === true || profile.twitterIdentityObserved === true)
      && HANDLE.test(String(profile.twitterHandle || "")));
    if (!targets.length) return "not_configured";
    const results = await mapConcurrent(targets, 4, async (profile) => {
      const checkedAt = Date.parse(profile.xProfile?.checkedAt || "");
      if (Number.isFinite(checkedAt) && nowMs - checkedAt < xProfileIntervalMs) return profile.xProfile;
      const payload = await publicJson(`${fxTwitterApiBase}/2/profile/${encodeURIComponent(profile.twitterHandle)}`, {
        headers: { "user-agent": "robinhood-chain-monitor/0.1 (public KOL identity verification)" },
      });
      const parsed = parseFxTwitterProfile(payload, profile.twitterHandle);
      if (!parsed) throw new Error(`FxTwitter profile mismatch for @${profile.twitterHandle}`);
      return { ...parsed, checkedAt: new Date(nowMs).toISOString() };
    });
    let failures = 0;
    results.forEach((result, index) => {
      const profile = targets[index];
      if (result.status === "fulfilled") {
        const priorCheckedAt = profile.xProfile?.checkedAt || null;
        profile.xProfile = result.value;
        profile.xFollowers = result.value.followers;
        profile.xProfileError = null;
        if (result.value.checkedAt !== priorCheckedAt) markDurableState();
        return;
      }
      failures += 1;
      profile.xProfileError = String(result.reason?.message || result.reason).slice(0, 160);
      profile.xProfileLastFailureAt = new Date(nowMs).toISOString();
    });
    return failures ? "partial" : "healthy";
  }

  async function fetchFomoProfile(handle, dynamicCandidate = null) {
    let directError = null;
    try {
      const payload = await publicJson(`${fomoScanApiBase}/get-user/${encodeURIComponent(handle)}`);
      const profile = parseFomoScanProfile(payload, handle);
      if (profile && (!dynamicCandidate || profile.twitterHandle?.toLowerCase() === handle.toLowerCase())) return profile;
    } catch (error) {
      directError = error;
    }
    if (!dynamicCandidate) throw directError || new Error(`FomoScan profile mismatch for ${handle}`);
    const search = await publicJson(`${fomoScanApiBase}/search?q=${encodeURIComponent(handle)}&limit=10`);
    const usernames = arrayFrom(search, ["results", "items"])
      .map((row) => String(row?.username || row?.handle || "").replace(/^@/, "").trim())
      .filter((username, index, values) => HANDLE.test(username) && values.findIndex((value) => value.toLowerCase() === username.toLowerCase()) === index)
      .slice(0, 5);
    const matches = await mapConcurrent(usernames, 3, async (username) => {
      const payload = await publicJson(`${fomoScanApiBase}/get-user/${encodeURIComponent(username)}`);
      return parseFomoScanProfile(payload, username);
    });
    const profile = matches
      .filter((result) => result.status === "fulfilled" && result.value)
      .map((result) => result.value)
      .find((candidate) => candidate.twitterHandle?.toLowerCase() === handle.toLowerCase());
    if (!profile) throw directError || new Error(`no Fomo profile is publicly bound to X @${handle}`);
    return profile;
  }

  async function refreshPublicProfiles(state, nowMs) {
    const sharedStatus = await refreshFromSharedXCallRoster(state, nowMs);
    if (sharedStatus) return sharedStatus;
    const discoveryStatus = await refreshDynamicRoster(state, nowMs);
    const handles = state.publicOnchain.candidateHandles || candidateHandles(state, nowMs);
    const checkedAt = Date.parse(state.publicOnchain.profilesCheckedAt || "");
    const refreshAfterMs = state.publicOnchain.profileCoverage === "partial" ? 60_000 : publicProfileIntervalMs;
    const missingProfile = handles.some((handle) => !state.publicOnchain.profiles?.[handle.toLowerCase()]);
    if (!missingProfile && state.topBloggers.length && Number.isFinite(checkedAt) && nowMs - checkedAt < refreshAfterMs) {
      return discoveryStatus === "partial" || state.publicOnchain.profileCoverage === "partial" ? "partial" : "healthy";
    }
    if (!handles.length) throw new Error("public Fomo candidate handle pool is empty");
    const configuredKeys = new Set(configuredPublicHandles.map((handle) => handle.toLowerCase()));
    const configuredToFetch = handles.filter((handle) => configuredKeys.has(handle.toLowerCase()));
    const dynamicToFetch = handles
      .filter((handle) => !configuredKeys.has(handle.toLowerCase()))
      .sort((left, right) => {
        const leftProfile = state.publicOnchain.profiles?.[left.toLowerCase()];
        const rightProfile = state.publicOnchain.profiles?.[right.toLowerCase()];
        if (Boolean(leftProfile) !== Boolean(rightProfile)) return leftProfile ? 1 : -1;
        return Date.parse(leftProfile?.sourceCheckedAt || "") - Date.parse(rightProfile?.sourceCheckedAt || "");
      })
      .slice(0, dynamicProfileBatchLimit);
    const handlesToFetch = [...configuredToFetch, ...dynamicToFetch];
    const results = await mapConcurrent(handlesToFetch, 6, async (handle) => {
      const dynamicCandidate = state.publicOnchain.dynamicCandidates[handle.toLowerCase()] || null;
      try {
        const profile = await fetchFomoProfile(handle, dynamicCandidate);
        if (allowGmgnObservedWallets && dynamicCandidate && !profile.baseAddress) {
          return attachGmgnObservedWallet(dynamicCandidate, profile, nowMs, { maxAttributionAgeMs: gmgnAttributionMaxAgeMs }) || profile;
        }
        return profile;
      } catch (error) {
        if (allowGmgnObservedWallets && dynamicCandidate) {
          const observed = attachGmgnObservedWallet(dynamicCandidate, null, nowMs, { maxAttributionAgeMs: gmgnAttributionMaxAgeMs });
          if (observed) return observed;
        }
        throw error;
      }
    });
    state.publicOnchain.profiles ||= {};
    if (handlesToFetch.length) markDurableState();
    for (const previous of state.topBloggers || []) state.publicOnchain.profiles[previous.handle.toLowerCase()] ||= previous;
    results.forEach((result, index) => {
      const key = handlesToFetch[index].toLowerCase();
      const dynamicCandidate = state.publicOnchain.dynamicCandidates[key] || null;
      if (result.status !== "fulfilled" || !result.value) {
        if (dynamicCandidate && !configuredPublicHandles.some((handle) => handle.toLowerCase() === key)) {
          state.publicOnchain.dynamicCandidates[key] = {
            ...dynamicCandidate,
            profileStatus: "unresolved",
            lastProfileAttemptAt: nowMs,
            nextProfileAttemptAt: nowMs + unresolvedCandidateRetryMs,
          };
        }
        return;
      }
      const previous = state.publicOnchain.profiles[key] || {};
      const sameWallet = String(previous.baseAddress || "").toLowerCase() === String(result.value.baseAddress || "").toLowerCase();
      const sameTwitter = String(previous.twitterHandle || "").toLowerCase() === String(result.value.twitterHandle || "").toLowerCase();
      const followerAt = Date.parse(result.value.followersSyncedAt || "");
      const walletAt = Date.parse(result.value.walletBinding?.lastCheckedAt || result.value.walletBinding?.verifiedAt || "");
      const timestampsCurrent = Number.isFinite(followerAt) && Number.isFinite(walletAt)
        && nowMs - followerAt <= maxIdentityAgeMs && nowMs - walletAt <= maxIdentityAgeMs;
      const dynamic = state.publicOnchain.dynamicCandidates[key] || null;
      if (dynamic) {
        state.publicOnchain.dynamicCandidates[key] = {
          ...dynamic,
          profileStatus: "resolved",
          lastProfileAttemptAt: nowMs,
          nextProfileAttemptAt: null,
        };
      }
      state.publicOnchain.profiles[key] = {
        ...previous,
        ...result.value,
        ...(sameWallet ? {} : { bscTransactionCount: null, bscActivityCheckedAt: null }),
        ...(sameTwitter && result.value.twitterHandle ? {} : { xProfile: null, xFollowers: null, xProfileError: null }),
        profileFreshness: timestampsCurrent ? "fresh" : result.value.profileFreshness,
        discovery: dynamic ? {
          source: dynamic.source,
          observedWallet: dynamic.wallet,
          walletMatched: String(dynamic.wallet || "").toLowerCase() === String(result.value.baseAddress || "").toLowerCase(),
          tags: dynamic.tags || [],
          firstSeenAt: dynamic.firstSeenAt,
          lastSeenAt: dynamic.lastSeenAt,
        } : { source: "configured_public_roster" },
        sourceCheckedAt: new Date(nowMs).toISOString(),
      };
    });
    const activeHandles = candidateHandles(state, nowMs);
    state.publicOnchain.candidateHandles = activeHandles;
    const profiles = activeHandles.map((handle) => state.publicOnchain.profiles[handle.toLowerCase()]).filter(Boolean);
    let xProfileStatus = "not_configured";
    try {
      xProfileStatus = await refreshXProfiles(profiles, nowMs);
    } catch (error) {
      xProfileStatus = "partial";
      logger.error(`[fomo-call][x-profiles] ${error.message}; retaining last verified X follower counts`);
    }
    let activityStatus = "disabled";
    try {
      activityStatus = await refreshBscActivity(profiles, nowMs);
    } catch (error) {
      activityStatus = "partial";
      logger.error(`[fomo-call][bsc-roster] ${error.message}; retaining last BSC activity proofs`);
    }
    const previousWallets = new Set((state.topBloggers || []).map((entry) => String(entry.baseAddress || "").toLowerCase()).filter(Boolean));
    const topBloggers = monitorAllEligible
      ? selectVerifiedBscKols(profiles, {
        minimumFollowers: minimumXFollowers,
        requireTwitter: requireTwitterIdentity,
        allowGmgnObservedWallets,
        requireBscActivity,
        requireRecentIdentity,
        maxIdentityAgeMs,
        maxXProfileAgeMs,
        maxAttributionAgeMs: gmgnAttributionMaxAgeMs,
        nowMs,
      })
      : selectTopTrafficBloggers(profiles, {
        limit: publicTopLimit,
        minimumTrades: config.fomoCallMinBloggerTrades ?? 20,
        minimumVolume: config.fomoCallMinBloggerVolumeUsd ?? 100_000,
      });
    if (!topBloggers.length) throw new Error("public sources returned no qualified Fomo/GMGN BSC identity-linked wallets");
    const addedWallets = topBloggers
      .map((entry) => String(entry.baseAddress || "").toLowerCase())
      .filter((wallet) => wallet && !previousWallets.has(wallet));
    const baselineEstablished = state.publicOnchain.bscSilentBaselinePending === false
      && Number.isSafeInteger(Number(state.publicOnchain.bscNextBlock));
    if (monitorAllEligible && baselineEstablished && addedWallets.length && newWalletLookbackBlocks > 0) {
      state.publicOnchain.bscLookbackRequested = true;
      state.publicOnchain.lastWalletExpansion = {
        addedCount: addedWallets.length,
        lookbackBlocks: newWalletLookbackBlocks,
        observedAt: new Date(nowMs).toISOString(),
      };
    }
    const selectedHandles = topBloggers.map((entry) => entry.handle);
    state.topBloggers = topBloggers;
    state.watchlist = { id: "public-onchain", name: monitorAllEligible ? "fomo-public-all-qualified-bsc-kols" : "fomo-public-top-traffic", handles: selectedHandles };
    state.leaderboardCheckedAt = new Date(nowMs).toISOString();
    state.publicOnchain.profilesCheckedAt = new Date(nowMs).toISOString();
    const profileRefreshFailed = results.some((result) => result.status !== "fulfilled" || !result.value);
    const profilesHealthy = !profileRefreshFailed
      && activeHandles.every((handle) => state.publicOnchain.profiles[handle.toLowerCase()])
      && activityStatus !== "partial" && xProfileStatus !== "partial";
    state.publicOnchain.profileCoverage = profilesHealthy && discoveryStatus !== "partial" ? "healthy" : "partial";
    markDurableState();
    return state.publicOnchain.profileCoverage;
  }

  const curveSourceFailureKind = (error) => {
    const status = Number(error?.status);
    if (status === 403 || /\bHTTP\s*403\b/i.test(String(error?.message || ""))) return "http_403";
    if (status === 429 || /\bHTTP\s*429\b/i.test(String(error?.message || ""))) return "http_429";
    if (["AbortError", "TimeoutError"].includes(error?.name)
      || /timed?\s*out|timeout/i.test(String(error?.message || ""))) return "timeout";
    return "error";
  };

  const retryAfterDelayMs = (value, nowMs) => {
    const raw = String(value || "").trim();
    if (!raw) return null;
    if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.max(0, Math.ceil(Number(raw) * 1_000));
    const retryAt = Date.parse(raw);
    return Number.isFinite(retryAt) && retryAt > nowMs ? retryAt - nowMs : null;
  };

  const curveSourceBackoff = (error, previous, nowMs) => {
    const reason = curveSourceFailureKind(error);
    const priorCount = Number(previous?.failureCount);
    const failureCount = previous?.reason === reason && Number.isSafeInteger(priorCount) && priorCount >= 0
      ? priorCount + 1
      : 1;
    let delayMs;
    if (reason === "http_403") {
      delayMs = CURVE_SOURCE_403_BACKOFF_MS[Math.min(failureCount - 1, CURVE_SOURCE_403_BACKOFF_MS.length - 1)];
    } else if (reason === "http_429") {
      delayMs = retryAfterDelayMs(error?.retryAfter, nowMs)
        ?? CURVE_SOURCE_403_BACKOFF_MS[Math.min(failureCount - 1, CURVE_SOURCE_403_BACKOFF_MS.length - 1)];
    } else if (reason === "timeout") {
      delayMs = CURVE_SOURCE_TIMEOUT_BACKOFF_MS[Math.min(failureCount - 1, CURVE_SOURCE_TIMEOUT_BACKOFF_MS.length - 1)];
    } else delayMs = CURVE_SOURCE_FALLBACK_BACKOFF_MS;
    return { reason, failureCount, delayMs };
  };

  async function refreshCurveSources(state, nowMs) {
    state.publicOnchain.curveSourceControls ||= {};
    const previousControl = state.publicOnchain.curveSourceControls[FOUR_MEME_ADDRESS_URL] || null;
    const previousRetryAt = Date.parse(previousControl?.nextRetryAt || "");
    if (Number.isFinite(previousRetryAt) && nowMs < previousRetryAt) {
      state.publicOnchain.curveSourcesStatus = "partial";
      state.publicOnchain.curveSourcesError = previousControl.lastError || previousControl.reason || "curve source circuit open";
      state.publicOnchain.curveSourcesNextRetryAt = previousControl.nextRetryAt;
      return "partial";
    }
    const checkedAt = Date.parse(state.publicOnchain.curveSourcesCheckedAt || "");
    const refreshAfterMs = state.publicOnchain.curveSourcesStatus === "partial" ? 60_000 : 10 * 60_000;
    if (!previousControl && Number.isFinite(checkedAt) && nowMs - checkedAt < refreshAfterMs) {
      return state.publicOnchain.curveSourcesStatus === "partial" ? "partial" : "healthy";
    }
    try {
      const payload = await publicJson(FOUR_MEME_ADDRESS_URL);
      if (payload?.code !== 0 || !Array.isArray(payload?.data)) throw new Error("invalid Four.Meme address inventory");
      const managers = payload.data
        .filter((entry) => String(entry?.networkCode || "").toUpperCase() === "BSC")
        .filter((entry) => /^TokenManager(?:$|[A-Z0-9])/i.test(String(entry?.name || "")))
        .map((entry) => String(entry.address || "").toLowerCase())
        .filter((address) => isAddress(address));
      if (!managers.length) throw new Error("Four.Meme inventory contained no BSC TokenManager");
      const nextManagers = [...new Set([...DEFAULT_FOUR_MEME_MANAGERS, ...managers])];
      if (nextManagers.length !== (state.publicOnchain.fourMemeManagers || []).length
        || nextManagers.some((manager) => !state.publicOnchain.fourMemeManagers.includes(manager))) markDurableState();
      state.publicOnchain.fourMemeManagers = nextManagers;
      state.publicOnchain.curveSourcesCheckedAt = new Date(nowMs).toISOString();
      state.publicOnchain.curveSourcesStatus = "healthy";
      state.publicOnchain.curveSourcesError = null;
      state.publicOnchain.curveSourcesNextRetryAt = null;
      if (previousControl) {
        delete state.publicOnchain.curveSourceControls[FOUR_MEME_ADDRESS_URL];
        markDurableState();
        await persistDurableState(state, "curve-source-recovered");
        logger.info?.(`[fomo-call][curve-sources] ${FOUR_MEME_ADDRESS_URL} recovered; official manager inventory is healthy`);
      }
      return "healthy";
    } catch (error) {
      const nextManagers = [...new Set([
        ...DEFAULT_FOUR_MEME_MANAGERS,
        ...(state.publicOnchain.fourMemeManagers || []),
      ])];
      if (nextManagers.length !== (state.publicOnchain.fourMemeManagers || []).length) markDurableState();
      state.publicOnchain.fourMemeManagers = nextManagers;
      const { reason, failureCount, delayMs } = curveSourceBackoff(error, previousControl, nowMs);
      const nextRetryAt = new Date(nowMs + delayMs).toISOString();
      const message = String(error?.message || error).slice(0, 180);
      state.publicOnchain.curveSourceControls[FOUR_MEME_ADDRESS_URL] = {
        status: "open",
        reason,
        failureCount,
        lastAttemptAt: new Date(nowMs).toISOString(),
        lastFailureAt: new Date(nowMs).toISOString(),
        lastError: message,
        nextRetryAt,
        retryAfterMs: delayMs,
      };
      state.publicOnchain.curveSourcesCheckedAt = new Date(nowMs).toISOString();
      state.publicOnchain.curveSourcesStatus = "partial";
      state.publicOnchain.curveSourcesError = message;
      state.publicOnchain.curveSourcesNextRetryAt = nextRetryAt;
      markDurableState();
      await persistDurableState(state, "curve-source-circuit");
      logger.error(`[fomo-call][curve-sources] ${message}; ${reason} circuit open until ${nextRetryAt}; using last verified official manager set`);
      return "partial";
    }
  }

  const numericLogIndex = (value, fallback = null) => {
    try {
      const number = typeof value === "string" && /^0x[0-9a-f]+$/i.test(value) ? Number(BigInt(value)) : Number(value);
      return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
    } catch { return fallback; }
  };

  function smartTransactionEvidence(call, transaction, receipt, smartProfile, nowMs, feedTrade = null, candidate = null) {
    const wallet = String(smartProfile?.wallet || smartProfile?.baseAddress || "").toLowerCase();
    const token = String(call?.token || "").toLowerCase();
    const transactionHash = exactTransactionHash(call?.transactionHash);
    const executionPools = [...new Set((Array.isArray(call?.executionPools) ? call.executionPools : [])
      .map((pool) => String(pool || "").toLowerCase())
      .filter((pool) => isAddress(pool)))];
    const executionPool = String(call?.executionPool || "").toLowerCase();
    const exactCurveExecution = call?.curveBuyVerified === true
      && executionPools.length === 1
      && executionPool === executionPools[0]
      && executionPool === String(call?.launchpad?.launcher || "").toLowerCase();
    const exactSwapExecution = call?.curveBuyVerified !== true
      && call?.swapVerified === true
      && executionPools.length === 1
      && executionPool === executionPools[0];
    const gmgnTags = normalizedTagUnion(
      smartProfile?.walletProfile?.tags,
      smartProfile?.sourceClassification?.gmgnTags,
      candidate?.tags,
      feedTrade?.tags,
    );
    if (!smartWalletProfileFresh(smartProfile?.walletProfile, wallet, nowMs)
      || smartProfile?.eoaVerified !== true
      || String(smartProfile?.walletCode || "").toLowerCase() !== "0x"
      || !freshTimestamp(smartProfile?.eoaCheckedAt, nowMs, smartMoneyMaxStatsAgeMs)
      || !isAddress(token) || !transactionHash
      || String(transaction?.from || "").toLowerCase() !== wallet
      || exactTransactionHash(transaction?.hash) !== transactionHash
      || Number(receipt?.status) !== 1
      || (receipt?.transactionHash && exactTransactionHash(receipt.transactionHash) !== transactionHash)
      || (!exactSwapExecution && !exactCurveExecution)
      || !rawPositive(call?.paymentRaw)
      || !smartMoneyTagsAreClean(gmgnTags)) return null;
    if (feedTrade && (exactTransactionHash(feedTrade.transactionHash) !== transactionHash
      || String(feedTrade.wallet || "").toLowerCase() !== wallet
      || String(feedTrade.token || "").toLowerCase() !== token
      || String(feedTrade.side || "").toLowerCase() !== "buy"
      || !smartMoneyTagsAreClean(feedTrade.tags))) return null;
    const deltas = evmTransferDeltas(receipt, wallet);
    const tokenDelta = deltas.get(token) || 0n;
    if (tokenDelta <= 0n) return null;
    const outputLog = (receipt.logs || []).map((log, index) => ({ log, index })).find(({ log }) =>
      String(log?.address || "").toLowerCase() === token
      && String(log?.topics?.[0] || "").toLowerCase() === TRANSFER_TOPIC
      && topicAddress(log?.topics?.[2]) === wallet
      && rawPositive(log?.data));
    if (!outputLog) return null;
    const logIndex = numericLogIndex(outputLog.log.logIndex, outputLog.index);
    const blockNumber = Number(call.blockNumber);
    if (!Number.isSafeInteger(blockNumber) || blockNumber < 0
      || Number(call.positionProof?.blockNumber) !== blockNumber
      || call.positionProof?.status !== "verified"
      || call.positionProof?.complete !== true
      || call.positionProof?.phase !== "previous_block"
      || String(call.positionProof?.wallet || "").toLowerCase() !== wallet
      || String(call.positionProof?.token || "").toLowerCase() !== token
      || exactTransactionHash(call.positionProof?.transactionHash) !== transactionHash) return null;
    const sourceTrade = {
      scheme: "gmgn_smartmoney_trade_v1",
      wallet,
      token,
      transactionHash,
      logIndex,
      blockNumber,
      side: "buy",
      occurredAt: new Date(call.timestampMs).toISOString(),
      observedAt: new Date(nowMs).toISOString(),
      tags: gmgnTags,
      transactionFrom: wallet,
      receiptStatus: 1,
      paymentRaw: String(call.paymentRaw),
      tokenDeltaRaw: tokenDelta.toString(),
      swapVerified: call.swapVerified === true,
      curveBuyVerified: call.curveBuyVerified === true,
      executionPool,
      executionPoolCount: 1,
      executionPoolReceiptVerified: true,
      detectionSource: feedTrade ? "gmgn_smartmoney_feed+local_bsc_receipt" : "local_bsc_block_scan",
    };
    const transactionProof = {
      scheme: "evm_wallet_buy_proof_v1",
      chainId: BSC_CHAIN_ID,
      wallet,
      token,
      transactionHash,
      blockNumber,
      logIndex,
      transactionFrom: wallet,
      receiptStatus: 1,
      paymentRaw: String(call.paymentRaw),
      tokenDeltaRaw: tokenDelta.toString(),
      swapVerified: call.swapVerified === true,
      curveBuyVerified: call.curveBuyVerified === true,
      executionPool,
      executionPoolCount: 1,
      executionPoolReceiptVerified: true,
      eoaVerified: true,
      eoaCheckedAt: smartProfile.eoaCheckedAt,
      walletCode: "0x",
      positionProof: call.positionProof,
    };
    return { sourceTrade, transactionProof };
  }

  function queuePublicCall(state, call, blogger, nowMs, context = {}) {
    if (call.kind === "top_blogger_first_buy" && call.chain?.slug === "solana" && !hasExactSolanaFirstPosition(call)) return;
    const smartMoneyProfile = blogger?.monitorKind === "smart_money_performance" ? blogger : null;
    let enriched;
    if (smartMoneyProfile) {
      if (Number(call.chain?.id) !== BSC_CHAIN_ID) return;
      const smartCandidate = state.publicOnchain.smartMoney?.candidates?.[
        String(smartMoneyProfile.wallet || smartMoneyProfile.baseAddress || "").toLowerCase()
      ] || null;
      const evidence = smartTransactionEvidence(
        call,
        context.transaction,
        context.receipt,
        smartMoneyProfile,
        nowMs,
        context.feedTrade,
        smartCandidate,
      );
      if (!evidence) return;
      enriched = {
        ...call,
        kind: SMART_MONEY_SIGNAL_KIND,
        source: {
          id: SMART_MONEY_SOURCE_ID,
          name: "GMGN 公开高收益钱包画像 + 本机 BSC 建仓证明",
          trust: SMART_MONEY_SOURCE_TRUST,
          url: "https://gmgn.ai",
        },
        sourceClassification: smartMoneySourceClassification(evidence.sourceTrade.tags),
        walletProfile: smartMoneyProfile.walletProfile,
        sourceTrade: evidence.sourceTrade,
        transactionProof: evidence.transactionProof,
      };
      delete enriched.handle;
      delete enriched.blogger;
    } else {
      const gmgnObserved = publicWalletBindingKind(blogger, allowGmgnObservedWallets, nowMs, gmgnAttributionMaxAgeMs) === "gmgn_observed";
      const source = {
        id: gmgnObserved ? "gmgn_kol_onchain" : "fomoscan_onchain",
        name: gmgnObserved ? "GMGN Fomo KOL 公开关联钱包 + 本机链上首仓" : "FomoScan 已验证钱包 + 本机链上 Swap/官方曲线买入",
        trust: gmgnObserved ? "public_onchain_attributed" : "public_onchain_verified",
        url: gmgnObserved ? "https://gmgn.ai" : "https://chromewebstore.google.com/detail/fomoscan/kglmlphpicjdcdccldljnogaahjhjgee",
      };
      enriched = { ...call, handle: blogger.handle, source };
    }
    if (state.seenCalls[enriched.callId]) return;
    state.seenCalls[enriched.callId] = nowMs;
    markDurableState();
    if (!fresh(enriched, nowMs, maximumSignalAgeMs)) return;
    state.pending[`public:${enriched.callId}`] = {
      call: enriched,
      firstSeenAt: nowMs,
      firstBuyVerified: smartMoneyProfile ? false : true,
      ...(smartMoneyProfile ? {
        positionSemantics: {
          id: "new_position_after_previous_block_zero",
          label: "前一区块零仓后的新建仓",
          proofBoundary: "previous_block",
          lifetimeFirstBuyVerified: false,
          transactionImmediatePreBalanceVerified: false,
        },
      } : {}),
      ...(smartMoneyProfile ? { smartMoney: true } : {}),
    };
    markDurableState();
  }

  async function collectExactSmartMoneyFeedTrades(state, nowMs, options = {}) {
    const smartMoney = ensureSmartMoneyState(state);
    if (!smartMoneyEnabled || !Object.keys(smartMoney.pendingTrades).length) return "not_configured";
    boundSmartPendingTrades(smartMoney, nowMs);
    if (!Object.keys(smartMoney.pendingTrades).length) return "healthy";
    let failed = 0;
    const admittedEntries = [];
    const walletFilter = options.wallets instanceof Set ? options.wallets : null;
    const keyFilter = options.keys instanceof Set ? options.keys : null;
    for (const [key, trade] of Object.entries(smartMoney.pendingTrades)
      .sort(([, left], [, right]) => Number(left.timestampMs || left.firstSeenAt || 0)
        - Number(right.timestampMs || right.firstSeenAt || 0))) {
      if (keyFilter && !keyFilter.has(key)) continue;
      if (!fresh({ timestampMs: trade.timestampMs }, nowMs, maximumSignalAgeMs)) {
        delete smartMoney.pendingTrades[key];
        markDurableState();
        continue;
      }
      const wallet = String(trade.wallet || "").toLowerCase();
      if (walletFilter && !walletFilter.has(wallet)) continue;
      const candidateStatus = String(smartMoney.candidates?.[wallet]?.profileStatus || "");
      if (/^(?:rejected_|revoked_)/.test(candidateStatus)) {
        delete smartMoney.pendingTrades[key];
        markDurableState();
        continue;
      }
      const smartProfile = smartMoney.roster[wallet];
      if (!smartProfile || !smartRosterEntryFresh(smartProfile, nowMs)) continue;
      admittedEntries.push([key, trade, smartProfile]);
    }
    if (!admittedEntries.length) return "healthy";
    const exactStartedAt = Number(wallNow());
    let safeHead;
    try {
      const latestHex = await evmRpcFallback(bscRpcUrls, "eth_blockNumber", []);
      const latestBlock = strictEvmHeadNumber(latestHex);
      if (latestBlock === null) throw new Error("BNB Chain exact head is not a canonical hex quantity");
      safeHead = Math.max(0, latestBlock - publicBscConfirmations);
    } catch (error) {
      setTelemetryField(smartMoney, "feedError", `exact_trade_head:${String(error?.message || error).slice(0, 140)}`);
      return "partial";
    }
    let budgetExhausted = false;
    for (const [key, trade, smartProfile] of admittedEntries.slice(0, SMART_MONEY_EXACT_MAX_PER_CHECK)) {
      const elapsedMs = Math.max(0, Number(wallNow()) - exactStartedAt);
      const remainingMs = SMART_MONEY_EXACT_BUDGET_MS - elapsedMs;
      if (remainingMs <= 0) {
        budgetExhausted = true;
        break;
      }
      try {
        // Keep the timed work side-effect free. If the outer budget expires,
        // late RPC completions cannot enqueue a stale alert after this check.
        const verified = await withTimeout((async () => {
          const [transaction, receipt] = await Promise.all([
            evmRpcFallback(bscBatchReceiptRpcUrls, "eth_getTransactionByHash", [trade.transactionHash]),
            evmRpcFallback(bscBatchReceiptRpcUrls, "eth_getTransactionReceipt", [trade.transactionHash]),
          ]);
          if (!transaction || !receipt) throw new Error("GMGN feed transaction or receipt is not available yet");
          const requestedHash = exactTransactionHash(trade.transactionHash);
          if (!requestedHash || exactTransactionHash(transaction.hash) !== requestedHash
            || exactTransactionHash(receipt.transactionHash) !== requestedHash) {
            throw new Error("GMGN feed transaction or receipt hash does not match the requested trade");
          }
          const transactionFrom = String(transaction.from || "").toLowerCase();
          if (!isAddress(transactionFrom)) throw new Error("GMGN feed transaction sender is missing or invalid");
          if (transactionFrom !== String(trade.wallet || "").toLowerCase()) return { discard: true };
          const transactionBlock = strictEvmBlockNumber(transaction.blockNumber);
          const receiptBlock = strictEvmBlockNumber(receipt.blockNumber);
          if (transactionBlock === null || receiptBlock === null || transactionBlock !== receiptBlock) {
            throw new Error("GMGN feed transaction and receipt block numbers do not match");
          }
          const blockNumber = transactionBlock;
          if (blockNumber > safeHead) return null;
          const rawBlock = `0x${blockNumber.toString(16)}`;
          const transactionBlockHash = exactTransactionHash(transaction.blockHash);
          const receiptBlockHash = exactTransactionHash(receipt.blockHash);
          if (!transactionBlockHash || !receiptBlockHash || transactionBlockHash !== receiptBlockHash) {
            throw new Error("GMGN feed transaction and receipt block hashes are missing or mismatched");
          }
          const block = await evmRpcFallback(bscBatchReceiptRpcUrls, "eth_getBlockByNumber", [rawBlock, false]);
          const returnedBlockNumber = strictEvmBlockNumber(block?.number);
          const returnedBlockHash = exactTransactionHash(block?.hash);
          const blockTimestampMs = epochMs(block?.timestamp);
          if (!block || returnedBlockNumber !== blockNumber || returnedBlockHash !== transactionBlockHash || blockTimestampMs === null
            || blockTimestampMs > nowMs + 60_000
            || Math.abs(blockTimestampMs - Number(trade.timestampMs)) > 5 * 60_000) {
            throw new Error("GMGN feed block identity or timestamp is unavailable or mismatched");
          }
          const receiptStatus = strictEvmReceiptStatus(receipt.status);
          if (receiptStatus === null) throw new Error("GMGN feed receipt status is missing, invalid, or unsupported");
          const receiptFrom = String(receipt.from || "").toLowerCase();
          if (!isAddress(receiptFrom) || receiptFrom !== transactionFrom) {
            throw new Error("GMGN feed receipt sender is missing, invalid, or mismatched");
          }
          if (!Array.isArray(receipt.logs)) throw new Error("GMGN feed receipt logs are missing or malformed");
          if (receipt.logs.some((log) => !evmLogIdentityMatches(log, {
            transactionHash: requestedHash,
            blockNumber,
            blockHash: transactionBlockHash,
          }))) throw new Error("GMGN feed receipt log identity is mismatched");
          if (receiptStatus === 0) {
            if (receipt.logs.length) throw new Error("GMGN feed failed receipt unexpectedly contains logs");
            return { discard: true };
          }
          if (!receipt.logs.length) throw new Error("GMGN feed successful buy receipt logs are unexpectedly empty");
          const proofProvider = {
            failOnProofError: true,
            call: (request) => withTimeout(bscHistoricalProvider.call(request), 8_000, "BNB Chain feed historical token proof"),
            getCode: (address, blockTag) => withTimeout(bscHistoricalProvider.getCode(address, blockTag), 8_000, "BNB Chain feed token code proof"),
          };
          const curveCalls = await detectOfficialBscCurveBuys(
            proofProvider,
            transaction,
            receipt,
            block,
            smartProfile.wallet,
            state.publicOnchain.fourMemeManagers || DEFAULT_FOUR_MEME_MANAGERS,
          );
          const curveTokens = new Set(curveCalls.map((call) => call.token.toLowerCase()));
          const swapCalls = await detectEvmFirstBuys(proofProvider, transaction, receipt, block, smartProfile.wallet, "bsc");
          const calls = [...curveCalls, ...swapCalls.filter((call) => !curveTokens.has(call.token.toLowerCase()))]
            .filter((call) => call.token.toLowerCase() === String(trade.token).toLowerCase());
          return { transaction, receipt, calls };
        })(), Math.max(1, remainingMs), "GMGN exact smart-money trade budget");
        if (verified === null) continue;
        if (!verified.discard) {
          for (const call of verified.calls) queuePublicCall(state, call, smartProfile, nowMs, {
            transaction: verified.transaction,
            receipt: verified.receipt,
            feedTrade: trade,
          });
        }
        delete smartMoney.pendingTrades[key];
        markDurableState();
      } catch (error) {
        trade.attempts = Number(trade.attempts || 0) + 1;
        trade.lastError = String(error?.message || error).slice(0, 160);
        trade.lastAttemptAt = nowMs;
        markDurableState();
        failed += 1;
      }
    }
    const qualifiedRemain = Object.values(smartMoney.pendingTrades).some((trade) => {
      const profile = smartMoney.roster[String(trade?.wallet || "").toLowerCase()];
      return profile && smartRosterEntryUsable(profile, nowMs);
    });
    return failed || budgetExhausted || qualifiedRemain ? "partial" : "healthy";
  }

  async function collectPublicSolana(state, nowMs) {
    const bloggers = state.topBloggers.filter((entry) => entry.solanaAddress);
    if (!bloggers.length || !verifySolanaFirstPosition) return "not_configured";
    const results = await mapConcurrent(bloggers, 4, async (blogger) => {
      const wallet = blogger.solanaAddress;
      const hasBaseline = Object.prototype.hasOwnProperty.call(state.publicOnchain.solanaCursors, wallet);
      if (!hasBaseline) {
        const latest = await solanaRpc("getSignaturesForAddress", [wallet, { limit: 1, commitment: "confirmed" }]);
        setDurableField(state.publicOnchain.solanaCursors, wallet,
          Array.isArray(latest) && latest[0]?.signature ? latest[0].signature : null);
        return true;
      }
      const cursor = state.publicOnchain.solanaCursors[wallet];
      if (!state.publicOnchain.solanaFailures) {
        state.publicOnchain.solanaFailures = {};
        markDurableState();
      }
      if (!state.publicOnchain.solanaFailures[wallet]) {
        state.publicOnchain.solanaFailures[wallet] = {};
        markDurableState();
      }
      const walletFailures = state.publicOnchain.solanaFailures[wallet];
      const signatures = [];
      let before;
      let truncated = false;
      for (let page = 0; page < 8; page += 1) {
        const options = { limit: 25, commitment: "confirmed" };
        if (cursor) options.until = cursor;
        if (before) options.before = before;
        const batch = await solanaRpc("getSignaturesForAddress", [wallet, options]);
        if (!Array.isArray(batch)) throw new Error("malformed signatures response");
        signatures.push(...batch);
        if (batch.length < options.limit) break;
        before = batch.at(-1)?.signature;
        if (!before) break;
        if (page === 7) {
          const probeOptions = { limit: 1, commitment: "confirmed", before };
          if (cursor) probeOptions.until = cursor;
          const overflow = await solanaRpc("getSignaturesForAddress", [wallet, probeOptions]);
          if (!Array.isArray(overflow)) throw new Error("malformed Solana overflow probe");
          truncated = overflow.length > 0;
        }
      }
      const transactions = signatures.slice().reverse().filter((item) => item?.signature && !item.err);
      const fetched = await mapConcurrent(transactions, 4, async (item) => {
        const transaction = await solanaRpc("getTransaction", [item.signature, {
          encoding: "jsonParsed",
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        }]);
        if (!transaction) throw new Error(`${item.signature}: transaction unavailable`);
        const candidates = solanaFirstBuyCandidates(transaction, wallet, item.signature);
        if (!candidates.length) return;
        const proofs = new Map();
        await Promise.all(candidates.map(async (candidate) => {
          const proof = await verifySolanaFirstPosition({
            wallet,
            mint: candidate.token,
            signature: item.signature,
            slot: candidate.slot,
            netAcquiredRaw: candidate.receivedRaw,
            transaction,
          });
          if (proof) proofs.set(candidate.token, proof);
        }));
        for (const call of detectSolanaFirstBuys(transaction, wallet, item.signature, proofs)) {
          queuePublicCall(state, call, blogger, nowMs);
        }
      });
      let retryableFailure = false;
      fetched.forEach((result, index) => {
        const signature = transactions[index]?.signature;
        if (!signature) return;
        if (result.status === "fulfilled") {
          if (Object.prototype.hasOwnProperty.call(walletFailures, signature)) {
            delete walletFailures[signature];
            markDurableState();
          }
          return;
        }
        const attempts = Number(walletFailures[signature] || 0) + 1;
        walletFailures[signature] = attempts;
        markDurableState();
        logger.error(`[fomo-call][solana][${blogger.handle}] ${result.reason?.message || result.reason}; attempt ${attempts}/3`);
        if (attempts < 3) {
          retryableFailure = true;
          return;
        }
        state.publicOnchain.coverageGaps ||= [];
        state.publicOnchain.coverageGaps.push({
          chain: "solana",
          wallet,
          signature,
          reason: "transaction_unavailable_after_3_attempts",
          observedAt: new Date(nowMs).toISOString(),
        });
        delete walletFailures[signature];
        markDurableState();
      });
      if (retryableFailure) return false;
      if (truncated) {
        state.publicOnchain.coverageGaps ||= [];
        state.publicOnchain.coverageGaps.push({
          chain: "solana",
          wallet,
          fromSignature: cursor,
          toSignature: signatures.at(-1)?.signature || null,
          reason: "signature_backlog_exceeded_200",
          observedAt: new Date(nowMs).toISOString(),
        });
        markDurableState();
      }
      if (signatures[0]?.signature) setDurableField(state.publicOnchain.solanaCursors, wallet, signatures[0].signature);
      return !truncated;
    });
    let succeeded = 0;
    let failed = 0;
    results.forEach((result, index) => {
      if (result.status === "fulfilled" && result.value) succeeded += 1;
      else {
        failed += 1;
        if (result.status === "rejected") logger.error(`[fomo-call][solana][${bloggers[index].handle}] ${result.reason?.message || result.reason}`);
      }
    });
    if (!succeeded) return "degraded";
    return failed ? "partial" : "healthy";
  }

  function bscGapSourceSnapshot(state, nowMs) {
    const smartMoney = ensureSmartMoneyState(state);
    const admittedWallets = [...new Set((smartMoney.admittedWallets || [])
      .map((wallet) => String(wallet || "").toLowerCase())
      .filter((wallet) => isAddress(wallet)))];
    const usableRoster = Object.values(smartMoney.roster || {})
      .filter((entry) => smartRosterEntryUsable(entry, nowMs));
    const freshRoster = usableRoster.filter((entry) => smartRosterEntryFresh(entry, nowMs));
    const freshWallets = new Set(freshRoster.map((entry) => String(entry.wallet || "").toLowerCase()));
    const lastFeedSuccessAtMs = Date.parse(smartMoney.lastFeedSuccessAt || "");
    const feedFresh = Number.isFinite(lastFeedSuccessAtMs)
      && lastFeedSuccessAtMs <= nowMs + ATTRIBUTION_FUTURE_TOLERANCE_MS
      && nowMs - lastFeedSuccessAtMs <= Math.max(60_000, smartMoneyDiscoveryIntervalMs * 2);
    const qualification = smartMoney.qualificationCoverage || {};
    const complete = smartMoneyEnabled
      && !legacyBuyEnabled
      && ["healthy", "empty"].includes(String(smartMoney.feedStatus || ""))
      && feedFresh
      && qualification.status === "healthy"
      && admittedWallets.length > 0
      && freshRoster.length === admittedWallets.length
      && admittedWallets.every((wallet) => freshWallets.has(wallet));
    return {
      complete,
      reason: complete ? null : (smartMoneyEnabled ? "unrecoverable_feed_gap" : "unrecoverable_roster_gap"),
      feedStatus: smartMoney.feedStatus || null,
      feedCheckedAt: smartMoney.feedCheckedAt || null,
      lastFeedSuccessAt: smartMoney.lastFeedSuccessAt || null,
      qualificationStatus: qualification.status || null,
      admittedCount: admittedWallets.length,
      freshCount: freshRoster.length,
      wallets: usableRoster.map((entry) => String(entry.wallet || "").toLowerCase()),
    };
  }

  function terminalizeBscBacklogGap(gap, nowMs, sourceCoverage = null) {
    const fromBlock = safeCheckpointNumber(Number(gap?.fromBlock));
    const toBlock = safeCheckpointNumber(Number(gap?.toBlock));
    const validRange = fromBlock !== null && toBlock !== null && fromBlock <= toBlock;
    const recovery = gap?.recovery;
    const durableExpired = recovery?.version === BSC_COVERAGE_RECOVERY_VERSION
      && recovery.status === "expired"
      && recovery.nextBlock == null
      && typeof recovery.resolutionReason === "string" && recovery.resolutionReason.length > 0
      && strictIsoTimestamp(recovery.expiredAt || recovery.resolvedAt);
    if (durableExpired) return false;
    const legacyWithoutSnapshot = !sourceCoverage;
    const source = sourceCoverage || {
      complete: false,
      reason: "legacy_gap_without_feed_and_roster_snapshot",
      wallets: [],
    };
    const resolutionReason = !validRange
      ? "fail_closed_invalid_gap_range"
      : (recovery
        ? "fail_closed_unverified_gap_resolution"
        : (legacyWithoutSnapshot
          ? (smartMoneyEnabled ? "unrecoverable_feed_gap" : "unrecoverable_roster_gap")
          : (source.complete
            ? "backlog_outside_realtime_window_not_replayed"
            : (source.reason || "unrecoverable_feed_gap"))));
    gap.recovery = {
      version: BSC_COVERAGE_RECOVERY_VERSION,
      status: "expired",
      expiredAt: new Date(nowMs).toISOString(),
      resolutionReason,
      signalPolicy: "never_enqueue_or_deliver_after_max_signal_age",
      maximumSignalAgeMs,
      sourceCoverage: {
        complete: source.complete === true,
        reason: source.reason || (source.complete ? null : resolutionReason),
        feedStatus: source.feedStatus || null,
        feedCheckedAt: source.feedCheckedAt || null,
        lastFeedSuccessAt: source.lastFeedSuccessAt || null,
        qualificationStatus: source.qualificationStatus || null,
        admittedCount: Number(source.admittedCount || 0),
        freshCount: Number(source.freshCount || 0),
      },
      rosterSnapshot: Array.isArray(source.wallets) ? [...source.wallets] : [],
    };
    markDurableState();
    return true;
  }

  function recordBscBacklogGap(state, fromBlock, toBlock, nowMs) {
    state.publicOnchain.coverageGaps ||= [];
    const existing = state.publicOnchain.coverageGaps.find((gap) => gap?.chain === "bsc"
      && gap?.reason === "backlog_exceeded_signal_window"
      && Number(gap.fromBlock) === fromBlock
      && Number(gap.toBlock) === toBlock);
    if (existing) return existing;
    const observedAt = new Date(nowMs).toISOString();
    const gap = {
      chain: "bsc",
      fromBlock,
      toBlock,
      reason: "backlog_exceeded_signal_window",
      observedAt,
    };
    state.publicOnchain.coverageGaps.push(gap);
    markDurableState();
    terminalizeBscBacklogGap(gap, nowMs, bscGapSourceSnapshot(state, nowMs));
    return gap;
  }

  function terminalizePersistedBscBacklogGaps(state, nowMs) {
    for (const gap of state.publicOnchain.coverageGaps || []) {
      if (gap?.chain === "bsc" && gap?.reason === "backlog_exceeded_signal_window") {
        terminalizeBscBacklogGap(gap, nowMs);
      }
    }
  }

  async function collectPublicEvm(state, nowMs, options) {
    const { provider, rpcUrl, chain, cursorField, confirmations, maxCatchup } = options;
    const bloggers = new Map((legacyBuyEnabled ? state.topBloggers : [])
      .filter((entry) => entry.baseAddress)
      .map((entry) => [entry.baseAddress.toLowerCase(), entry]));
    const smartMoney = ensureSmartMoneyState(state);
    const smartWallets = chain.id === BSC_CHAIN_ID && smartMoneyEnabled
      ? new Map(Object.values(smartMoney.roster || {})
        .filter((entry) => smartRosterEntryFresh(entry, nowMs))
        .map((entry) => [entry.wallet.toLowerCase(), entry]))
      : new Map();
    if (!bloggers.size && !smartWallets.size) return "not_configured";
    const latestHex = await evmRpc(rpcUrl, "eth_blockNumber", []);
    const latestBlock = strictEvmHeadNumber(latestHex);
    if (latestBlock === null) throw new Error(`${chain.name} returned an invalid head`);
    const safeHead = Math.max(0, latestBlock - confirmations);
    const rawSavedCursor = state.publicOnchain[cursorField];
    const savedCursor = rawSavedCursor === null || rawSavedCursor === undefined ? null : Number(rawSavedCursor);
    const bscSilentBootstrap = chain.id === BSC_CHAIN_ID && state.publicOnchain.bscSilentBaselinePending !== false;
    if (bscSilentBootstrap) {
      setOnchainCursor(state, chain, cursorField, safeHead + 1);
      activePersistence.bscBaselineAfterCheckpoint = {
        mode: "silent_activation_baseline",
        previousCursor: Number.isSafeInteger(savedCursor) ? savedCursor : null,
        safeHead,
        nextBlock: safeHead + 1,
        observedAt: new Date(nowMs).toISOString(),
      };
      for (const [key, item] of Object.entries(state.pending || {})) {
        if (Number(item?.call?.chain?.id) === BSC_CHAIN_ID) {
          delete state.pending[key];
          markDurableState();
        }
      }
      return "healthy";
    }
    const requestedLookback = chain.id === BSC_CHAIN_ID
      && state.publicOnchain.bscLookbackRequested === true
      && newWalletLookbackBlocks > 0;
    if (state.publicOnchain[cursorField] === null && !requestedLookback) {
        setOnchainCursor(state, chain, cursorField, safeHead + 1);
        return "healthy";
    }
    if (requestedLookback) {
      const rewindBlock = Math.max(0, safeHead - Math.min(maxCatchup, newWalletLookbackBlocks) + 1);
      setOnchainCursor(state, chain, cursorField, state.publicOnchain[cursorField] === null
        ? rewindBlock
        : Math.min(Number(state.publicOnchain[cursorField]), rewindBlock));
      if (activePersistence?.state === state) activePersistence.bscLookbackConsumed = true;
    }
    let start = Math.max(0, Number(state.publicOnchain[cursorField]));
    let skipped = false;
    const relevantStart = Math.max(0, safeHead - maxCatchup + 1);
    if (start < relevantStart) {
      if (chain.id === BSC_CHAIN_ID) recordBscBacklogGap(state, start, relevantStart - 1, nowMs);
      else {
        state.publicOnchain.coverageGaps ||= [];
        state.publicOnchain.coverageGaps.push({
          chain: chain.slug,
          fromBlock: start,
          toBlock: relevantStart - 1,
          reason: "backlog_exceeded_signal_window",
          observedAt: new Date(nowMs).toISOString(),
        });
      }
      start = relevantStart;
      setOnchainCursor(state, chain, cursorField, start);
      markDurableState();
      skipped = true;
    }
    const perCheckLimit = chain.id === BSC_CHAIN_ID ? Math.min(maxCatchup, 120) : Math.min(maxCatchup, 60);
    const end = Math.min(safeHead, start + perCheckLimit - 1);
    const catchingUp = end < safeHead;
    const blockNumbers = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => start + index);
    const batchSize = chain.id === BSC_CHAIN_ID ? 20 : 10;
    const groups = [];
    for (let index = 0; index < blockNumbers.length; index += batchSize) groups.push(blockNumbers.slice(index, index + batchSize));
    const batchResults = await mapConcurrent(groups, 6, async (group) => {
      const rpcCandidates = chain.id === BSC_CHAIN_ID
        ? [...new Set([rpcUrl, ...bscReceiptRpcUrls])]
        : [...new Set([rpcUrl, "https://base-rpc.publicnode.com", "https://base-mainnet.public.blastapi.io"] )];
      const blocks = await evmRpcBatchFallback(rpcCandidates, group.map((blockNumber) => ({
        method: "eth_getBlockByNumber",
        params: [`0x${blockNumber.toString(16)}`, true],
      })));
      return blocks.map((block, index) => {
        const blockNumber = group[index];
        if (!block || !Array.isArray(block.transactions)) throw new Error(`${chain.name} block ${blockNumber} unavailable`);
        if (strictEvmBlockNumber(block.number) !== blockNumber) throw new Error(`${chain.name} block ${blockNumber} identity mismatch`);
        if (chain.id === BSC_CHAIN_ID) {
          const blockHash = exactTransactionHash(block.hash);
          const blockTimestampMs = epochMs(block.timestamp);
          if (!blockHash || blockTimestampMs === null || blockTimestampMs > nowMs + 60_000) {
            throw new Error(`${chain.name} block ${blockNumber} hash or timestamp is missing, invalid, or future-dated`);
          }
        }
        if (block.transactions.some((transaction) => !transaction || typeof transaction !== "object")) {
          throw new Error(`${chain.name} block ${blockNumber} did not return full transactions`);
        }
        if (chain.id === BSC_CHAIN_ID && block.transactions.some((transaction) => {
          const from = String(transaction.from || "").toLowerCase();
          return !exactTransactionHash(transaction.hash) || !isAddress(from)
            || strictEvmBlockNumber(transaction.blockNumber) !== blockNumber
            || exactTransactionHash(transaction.blockHash) !== exactTransactionHash(block.hash);
        })) throw new Error(`${chain.name} block ${blockNumber} contains an incomplete or mismatched transaction identity`);
        return block;
      });
    });
    const fetched = [];
    batchResults.forEach((result, groupIndex) => {
      const group = groups[groupIndex];
      if (result.status === "fulfilled") {
        result.value.forEach((block) => fetched.push({ status: "fulfilled", value: block }));
      } else {
        group.forEach(() => fetched.push({ status: "rejected", reason: result.reason }));
      }
    });
    const bscReceipts = new Map();
    if (chain.id === BSC_CHAIN_ID) {
      const matchingTransactions = [];
      for (const result of fetched) {
        if (result.status !== "fulfilled") continue;
        const block = result.value;
        const blockNumber = strictEvmBlockNumber(block.number);
        const blockHash = exactTransactionHash(block.hash);
        for (const transaction of result.value.transactions) {
          const from = String(transaction?.from || "").toLowerCase();
          if (!smartWallets.has(from) && !bloggers.has(from)) continue;
          const transactionHash = exactTransactionHash(transaction.hash);
          const transactionBlockNumber = strictEvmBlockNumber(transaction.blockNumber);
          const transactionBlockHash = exactTransactionHash(transaction.blockHash);
          if (!isAddress(from) || !transactionHash || transactionBlockNumber !== blockNumber
            || !transactionBlockHash || transactionBlockHash !== blockHash) {
            throw new Error(`BNB Chain monitored transaction identity is missing or mismatched in block ${blockNumber}`);
          }
          matchingTransactions.push(transaction);
        }
      }
      const receiptGroups = [];
      for (let index = 0; index < matchingTransactions.length; index += 20) {
        receiptGroups.push(matchingTransactions.slice(index, index + 20));
      }
      const receiptResults = await mapConcurrent(receiptGroups, 3, async (transactions) => {
        const receipts = await evmRpcBatchFallback(bscBatchReceiptRpcUrls, transactions.map((transaction) => ({
          method: "eth_getTransactionReceipt",
          params: [transaction.hash],
        })));
        if (receipts.length !== transactions.length || receipts.some((receipt) => !receipt)) {
          throw new Error("BNB Chain receipt batch was incomplete");
        }
        return transactions.map((transaction, index) => [String(transaction.hash).toLowerCase(), receipts[index]]);
      });
      for (const result of receiptResults) {
        if (result.status === "rejected") throw result.reason;
        for (const [transactionHash, receipt] of result.value) bscReceipts.set(transactionHash, receipt);
      }
    }
    const boundedSmartBscProofs = chain.id === BSC_CHAIN_ID && smartMoneyEnabled && !legacyBuyEnabled;
    const proofStartedAt = Number(wallNow());
    let smartBscProofCount = 0;
    for (let index = 0; index < blockNumbers.length; index += 1) {
      const blockNumber = blockNumbers[index];
      const result = fetched[index];
      if (result.status === "rejected") throw result.reason;
      const block = result.value;
      const transactions = block.transactions;
      const blockHash = exactTransactionHash(block.hash);
      for (const transaction of transactions) {
        const from = String(transaction?.from || "").toLowerCase();
        const blogger = smartWallets.get(from) || bloggers.get(from);
        if (!blogger) continue;
        const transactionHash = exactTransactionHash(transaction.hash);
        const transactionBlockNumber = strictEvmBlockNumber(transaction.blockNumber);
        const transactionBlockHash = exactTransactionHash(transaction.blockHash);
        if (!transactionHash || !isAddress(from) || transactionBlockNumber !== blockNumber
          || !transactionBlockHash || transactionBlockHash !== blockHash) {
          throw new Error(`BNB Chain monitored transaction identity is missing or mismatched in block ${blockNumber}`);
        }
        if (boundedSmartBscProofs && smartMoney.chainProofedTransactions[transactionHash]) continue;
        const receipt = chain.id === BSC_CHAIN_ID
          ? bscReceipts.get(transactionHash)
          : await evmRpc(rpcUrl, "eth_getTransactionReceipt", [transaction.hash]);
        if (!receipt) throw new Error(`${chain.name} receipt ${transaction.hash} unavailable`);
        if (chain.id === BSC_CHAIN_ID) {
          const receiptTransactionHash = exactTransactionHash(receipt.transactionHash);
          const receiptBlockNumber = strictEvmBlockNumber(receipt.blockNumber);
          const receiptBlockHash = exactTransactionHash(receipt.blockHash);
          if (!receiptTransactionHash || receiptTransactionHash !== transactionHash) {
            throw new Error(`BNB Chain receipt hash mismatch for ${transaction.hash}`);
          }
          if (receiptBlockNumber !== blockNumber || !receiptBlockHash || receiptBlockHash !== blockHash) {
            throw new Error(`BNB Chain receipt block identity mismatch for ${transaction.hash}`);
          }
          if (!Array.isArray(receipt.logs)) {
            throw new Error(`BNB Chain receipt logs are missing or malformed for ${transaction.hash}`);
          }
          if (receipt.logs.some((log) => !evmLogIdentityMatches(log, {
            transactionHash,
            blockNumber,
            blockHash,
          }))) throw new Error(`BNB Chain receipt log identity mismatch for ${transaction.hash}`);
          const receiptStatus = strictEvmReceiptStatus(receipt.status);
          if (receiptStatus === null) throw new Error(`BNB Chain receipt status is missing, invalid, or unsupported for ${transaction.hash}`);
          const receiptFrom = String(receipt.from || "").toLowerCase();
          if (!isAddress(receiptFrom) || receiptFrom !== from) {
            throw new Error(`BNB Chain receipt sender mismatch for ${transaction.hash}`);
          }
          if (receiptStatus === 0) {
            if (receipt.logs.length) throw new Error(`BNB Chain failed receipt unexpectedly contains logs for ${transaction.hash}`);
            continue;
          }
          if (receipt.logs.length === 0) continue;
          const hasPositiveTokenInbound = receipt.logs.some((log) => isAddress(String(log?.address || "").toLowerCase())
            && String(log?.topics?.[0] || "").toLowerCase() === TRANSFER_TOPIC
            && topicAddress(log?.topics?.[2]) === from
            && rawPositive(log?.data));
          if (!hasPositiveTokenInbound) continue;
        }
        let proofBudgetMs = null;
        if (boundedSmartBscProofs) {
          proofBudgetMs = SMART_MONEY_EXACT_BUDGET_MS - Math.max(0, Number(wallNow()) - proofStartedAt);
          if (smartBscProofCount >= SMART_MONEY_EXACT_MAX_PER_CHECK || proofBudgetMs <= 0) {
            setOnchainCursor(state, chain, cursorField, blockNumber);
            return "partial";
          }
          smartBscProofCount += 1;
        }
        const proofProvider = {
          failOnProofError: true,
          call: (request) => withTimeout(provider.call(request), 8_000, `${chain.name} historical token proof`),
          getCode: (address, blockTag) => withTimeout(provider.getCode(address, blockTag), 8_000, `${chain.name} historical token code proof`),
        };
        try {
          const detected = await (boundedSmartBscProofs
            ? withTimeout((async () => {
              const curveCalls = await detectOfficialBscCurveBuys(
                proofProvider,
                transaction,
                receipt,
                block,
                blogger.baseAddress,
                state.publicOnchain.fourMemeManagers || DEFAULT_FOUR_MEME_MANAGERS,
              );
              const curveTokens = new Set(curveCalls.map((call) => call.token.toLowerCase()));
              const swapCalls = await detectEvmFirstBuys(proofProvider, transaction, receipt, block, blogger.baseAddress, chain.slug);
              return [...curveCalls, ...swapCalls.filter((item) => !curveTokens.has(item.token.toLowerCase()))];
            })(), Math.max(1, proofBudgetMs), "BNB Chain smart-wallet proof budget")
            : (async () => {
              const curveCalls = chain.id === BSC_CHAIN_ID
                ? await detectOfficialBscCurveBuys(
                  proofProvider,
                  transaction,
                  receipt,
                  block,
                  blogger.baseAddress,
                  state.publicOnchain.fourMemeManagers || DEFAULT_FOUR_MEME_MANAGERS,
                )
                : [];
              const curveTokens = new Set(curveCalls.map((call) => call.token.toLowerCase()));
              const swapCalls = await detectEvmFirstBuys(proofProvider, transaction, receipt, block, blogger.baseAddress, chain.slug);
              return [...curveCalls, ...swapCalls.filter((item) => !curveTokens.has(item.token.toLowerCase()))];
            })());
          for (const call of detected) queuePublicCall(state, call, blogger, nowMs, { transaction, receipt });
          if (boundedSmartBscProofs) {
            smartMoney.chainProofedTransactions[transactionHash] = nowMs;
            markDurableState();
          }
        } catch (error) {
          if (!boundedSmartBscProofs) throw error;
          setOnchainCursor(state, chain, cursorField, blockNumber);
          return "partial";
        }
      }
      setOnchainCursor(state, chain, cursorField, blockNumber + 1);
    }
    return skipped || catchingUp ? "partial" : "healthy";
  }

  const collectPublicBase = (state, nowMs) => collectPublicEvm(state, nowMs, {
    provider: baseProvider,
    rpcUrl: config.fomoCallBaseRpcUrl || "https://mainnet.base.org",
    chain: chainProfile("base"),
    cursorField: "baseNextBlock",
    confirmations: publicBaseConfirmations,
    maxCatchup: publicBaseMaxCatchup,
  });

  const collectPublicBsc = (state, nowMs) => collectPublicEvm(state, nowMs, {
    provider: bscHistoricalProvider,
    rpcUrl: config.fomoCallBscRpcUrl || "https://bsc-rpc.publicnode.com",
    chain: chainProfile("bsc"),
    cursorField: "bscNextBlock",
    confirmations: publicBscConfirmations,
    maxCatchup: publicBscMaxCatchup,
  });

  async function collectPublicOnchain(state, nowMs) {
    // Old backlog records had no feed/roster snapshot and therefore cannot be
    // reconstructed honestly. Terminalize them before source work so the lost
    // interval remains durable even when the current BSC roster is empty.
    terminalizePersistedBscBacklogGaps(state, nowMs);
    let profileCoverage = "disabled";
    if (legacyBuyEnabled) {
      profileCoverage = "healthy";
      try {
        profileCoverage = await refreshPublicProfiles(state, nowMs);
      } catch (error) {
        if (!smartMoneyEnabled && (!state.topBloggers.length || state.watchlist?.id !== "public-onchain")) throw error;
        profileCoverage = "partial";
        logger.error(`[fomo-call][profiles] ${error.message}; continuing with cached public/smart-money rosters`);
      }
    }
    const curveCoverage = await refreshCurveSources(state, nowMs);
    const [solana, base, bsc] = await Promise.allSettled([
      bscOnly || !legacyBuyEnabled ? Promise.resolve("not_configured") : collectPublicSolana(state, nowMs),
      bscOnly || !legacyBuyEnabled ? Promise.resolve("not_configured") : collectPublicBase(state, nowMs),
      collectPublicBsc(state, nowMs),
    ]);
    const solanaCoverage = solana.status === "fulfilled" ? solana.value : "degraded";
    const baseCoverage = base.status === "fulfilled" ? base.value : "degraded";
    const bscCoverage = bsc.status === "fulfilled" ? bsc.value : "degraded";
    if (solana.status === "rejected") logger.error(`[fomo-call][solana] ${solana.reason.message}`);
    if (base.status === "rejected") logger.error(`[fomo-call][base] ${base.reason.message}`);
    if (bsc.status === "rejected") logger.error(`[fomo-call][bsc] ${bsc.reason.message}`);
    const smartRosterReady = ensureSmartMoneyState(state).admittedWallets.length > 0;
    let effectiveBscCoverage = curveCoverage === "partial" && bscCoverage === "healthy" ? "partial" : bscCoverage;
    if (smartRosterReady && effectiveBscCoverage === "not_configured") effectiveBscCoverage = "partial";
    const smartMoney = ensureSmartMoneyState(state);
    state.publicOnchain.coverage = {
      profiles: profileCoverage,
      curves: curveCoverage,
      solana: solanaCoverage,
      base: baseCoverage,
      bsc: effectiveBscCoverage,
      smartMoney: smartMoneyEnabled ? {
        sourceClassification: "gmgn_public_performance_wallet",
        feed: smartMoney.feedStatus,
        stats: smartMoney.statsStatus,
        qualification: smartMoney.qualificationCoverage?.status || "initializing",
        fresh: Number(smartMoney.qualificationCoverage?.fresh || 0),
        lastKnownGood: Number(smartMoney.qualificationCoverage?.lastKnownGood || 0),
        exactTrades: smartMoney.exactTradeStatus || "initializing",
        admitted: smartMoney.admittedWallets.length,
      } : {
        feed: "disabled", stats: "disabled", qualification: "disabled",
        fresh: 0, lastKnownGood: 0, exactTrades: "disabled", admitted: 0,
      },
    };
    if (!state.publicOnchain.initializedAt) {
      state.publicOnchain.initializedAt = new Date(nowMs).toISOString();
      markDurableState();
    }
    const active = [solanaCoverage, baseCoverage, effectiveBscCoverage].filter((status) => status !== "not_configured");
    if ((!active.length || active.every((status) => status === "degraded")) && !smartMoneyEnabled) throw new Error("all public on-chain call sources are degraded");
    return !active.length || active.some((status) => status !== "healthy")
      || (legacyBuyEnabled && profileCoverage !== "healthy") ? "partial" : "healthy";
  }

  async function ensureTopWatchlist(state) {
    const leaderboardPayload = await api("/v1/leaderboard?timeframe=7d&limit=100");
    const entries = parseCopeLeaderboard(leaderboardPayload);
    const topBloggers = selectTopTrafficBloggers(entries, {
      limit: config.fomoCallTopBloggerLimit || 10,
      minimumTrades: config.fomoCallMinBloggerTrades ?? 20,
      minimumVolume: config.fomoCallMinBloggerVolumeUsd ?? 100_000,
    });
    if (!topBloggers.length) throw new Error("Cope leaderboard contained no qualified follower-ranked traders");
    const handles = topBloggers.map((entry) => entry.handle);
    const watchlists = listFromWatchlists(await api("/v1/watchlists"));
    let watchlist = watchlists.find((entry) => entry?.id === state.watchlist?.id)
      || watchlists.find((entry) => entry?.name === "fomo-top-traffic");
    if (!watchlist) {
      watchlist = await api("/v1/watchlists", { method: "POST", body: { name: "fomo-top-traffic", handles } });
      watchlist = watchlist?.watchlist || watchlist?.data || watchlist;
    } else {
      const existing = Array.isArray(watchlist.handles) ? watchlist.handles.map((handle) => String(handle).toLowerCase()).sort() : [];
      const expected = handles.map((handle) => handle.toLowerCase()).sort();
      if (JSON.stringify(existing) !== JSON.stringify(expected)) {
        const updated = await api(`/v1/watchlists/${encodeURIComponent(watchlist.id)}`, { method: "PUT", body: { name: "fomo-top-traffic", handles } });
        watchlist = updated?.watchlist || updated?.data || { ...watchlist, handles };
      }
    }
    if (!watchlist?.id) throw new Error("Cope watchlist response missing id");
    state.topBloggers = topBloggers;
    state.watchlist = { id: String(watchlist.id), name: "fomo-top-traffic", handles };
    state.leaderboardCheckedAt = new Date(now()).toISOString();
    markDurableState();
  }

  async function tokenUsdPrice(chain, token) {
    const normalizedToken = chain.evm ? String(token).toLowerCase() : String(token);
    const cacheKey = `${chain.slug}:${normalizedToken}`;
    const cached = nativePriceCache.get(cacheKey);
    if (cached?.value && now() - cached.checkedAt < 60_000) return cached.value;
    const response = await fetchImpl(`${DEX_SCREENER_BASE}/${chain.slug}/${token}`, {
      headers: { accept: "application/json", "user-agent": "robinhood-launchpad-monitor" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`DEX Screener ${chain.name} price HTTP ${response.status}`);
    const payload = await response.json();
    const normalizeAddress = (value) => chain.evm ? String(value || "").toLowerCase() : String(value || "");
    const trusted = PRICE_COUNTERPARTIES[chain.slug] || new Set();
    const candidates = (Array.isArray(payload) ? payload : payload?.pairs || [])
      .filter((pair) => String(pair?.chainId || "").toLowerCase() === chain.slug)
      .map((pair) => {
        const base = normalizeAddress(pair?.baseToken?.address);
        const quote = normalizeAddress(pair?.quoteToken?.address);
        let price;
        let counterparty;
        if (base === normalizedToken) {
          price = finite(pair?.priceUsd);
          counterparty = quote;
        } else if (quote === normalizedToken) {
          const baseUsd = finite(pair?.priceUsd);
          const baseInQuote = finite(pair?.priceNative);
          price = baseUsd && baseInQuote ? baseUsd / baseInQuote : null;
          counterparty = base;
        } else return null;
        const liquidity = finite(pair?.liquidity?.usd) || 0;
        if (!trusted.has(counterparty) || !price || price <= 0 || liquidity < 100_000) return null;
        return { price, liquidity, pairAddress: String(pair?.pairAddress || "").toLowerCase(), counterparty };
      })
      .filter(Boolean)
      .sort((left, right) => right.liquidity - left.liquidity);
    if (!candidates.length) throw new Error(`${chain.name} trusted USD price unavailable`);
    const primary = candidates[0];
    const secondary = candidates.find((candidate) => candidate.pairAddress && candidate.pairAddress !== primary.pairAddress);
    if (!secondary && primary.liquidity < 1_000_000) throw new Error(`${chain.name} USD price lacks independent liquidity`);
    if (secondary && Math.abs(primary.price - secondary.price) / primary.price > 0.12) {
      throw new Error(`${chain.name} USD price sources disagree by more than 12%`);
    }
    const value = {
      price: secondary ? (primary.price + secondary.price) / 2 : primary.price,
      liquidityUsd: primary.liquidity,
      sources: secondary ? 2 : 1,
    };
    nativePriceCache.set(cacheKey, { value, checkedAt: now() });
    return value;
  }

  async function nativeUsdPrice(chain) {
    const token = chain.id === BSC_CHAIN_ID ? BSC_WBNB : chain.id === SOLANA_CHAIN_ID ? SOLANA_WSOL : BASE_WETH;
    return (await tokenUsdPrice(chain, token)).price;
  }

  async function bscQuoteDetails(token) {
    if (!token || token === ZERO_ADDRESS) {
      const price = await tokenUsdPrice(chainProfile("bsc"), BSC_WBNB);
      return { token: ZERO_ADDRESS, symbol: "BNB", decimals: 18, ...price };
    }
    if (!isAddress(token)) throw new Error("invalid BSC curve quote token");
    const [decimalsRaw, symbolRaw, price] = await Promise.all([
      withTimeout(bscProvider.call({ to: token, data: ERC20.encodeFunctionData("decimals") }), 5_000, "curve quote decimals"),
      withTimeout(bscProvider.call({ to: token, data: ERC20.encodeFunctionData("symbol") }), 5_000, "curve quote symbol").catch(() => null),
      tokenUsdPrice(chainProfile("bsc"), token),
    ]);
    const decimals = Number(ERC20.decodeFunctionResult("decimals", decimalsRaw)[0]);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("invalid BSC curve quote decimals");
    let symbol = "QUOTE";
    if (symbolRaw) {
      try { symbol = String(ERC20.decodeFunctionResult("symbol", symbolRaw)[0]).trim().slice(0, 20) || symbol; }
      catch { /* Symbol is display-only. */ }
    }
    return { token: token.toLowerCase(), symbol, decimals, ...price };
  }

  async function evmPaymentDetails(chain, token) {
    if (!chain?.evm) throw new Error("payment details require an EVM chain");
    if (!token || token === ZERO_ADDRESS) {
      const price = await tokenUsdPrice(chain, chain.id === BSC_CHAIN_ID ? BSC_WBNB : BASE_WETH);
      return { token: ZERO_ADDRESS, symbol: chain.id === BSC_CHAIN_ID ? "BNB" : "ETH", decimals: 18, ...price };
    }
    if (!isAddress(token)) throw new Error("invalid EVM payment token");
    const provider = chain.id === BSC_CHAIN_ID ? bscProvider : baseProvider;
    const [decimalsRaw, symbolRaw, price] = await Promise.all([
      withTimeout(provider.call({ to: token, data: ERC20.encodeFunctionData("decimals") }), 5_000, "payment token decimals"),
      withTimeout(provider.call({ to: token, data: ERC20.encodeFunctionData("symbol") }), 5_000, "payment token symbol").catch(() => null),
      tokenUsdPrice(chain, token),
    ]);
    const decimals = Number(ERC20.decodeFunctionResult("decimals", decimalsRaw)[0]);
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) throw new Error("invalid payment token decimals");
    let symbol = "QUOTE";
    if (symbolRaw) {
      try { symbol = String(ERC20.decodeFunctionResult("symbol", symbolRaw)[0]).trim().slice(0, 20) || symbol; }
      catch { /* Symbol is display-only. */ }
    }
    return { token: token.toLowerCase(), symbol, decimals, ...price };
  }

  function curveSoldToken(log, call) {
    const topic = String(log?.topics?.[0] || "").toLowerCase();
    try {
      if (call.launchpad.id === "flap" && topic === FLAP_CURVE.getEvent("TokenSold").topicHash.toLowerCase()) {
        return String(FLAP_CURVE.parseLog(log).args.token).toLowerCase();
      }
      if (call.launchpad.id === "fourmeme" && topic === FOUR_CURVE_V1.getEvent("TokenSale").topicHash.toLowerCase()) {
        return String(FOUR_CURVE_V1.parseLog(log).args.token).toLowerCase();
      }
      if (call.launchpad.id === "fourmeme" && topic === FOUR_CURVE_V2.getEvent("TokenSale").topicHash.toLowerCase()) {
        return String(FOUR_CURVE_V2.parseLog(log).args.token).toLowerCase();
      }
    } catch { return null; }
    return null;
  }

  async function curveSellObserved(call) {
    const topics = call.launchpad.id === "flap"
      ? [FLAP_CURVE.getEvent("TokenSold").topicHash]
      : [FOUR_CURVE_V1.getEvent("TokenSale").topicHash, FOUR_CURVE_V2.getEvent("TokenSale").topicHash];
    let lastError;
    for (const rpcUrl of new Set(["https://bsc-rpc.publicnode.com", ...bscRpcUrls])) {
      try {
        const latestHex = await evmRpc(rpcUrl, "eth_blockNumber", []);
        const latest = Number(BigInt(latestHex));
        const fromBlock = Math.max(0, Math.min(Number(call.blockNumber || latest), latest) - publicBscMaxCatchup);
        const logs = await evmRpc(rpcUrl, "eth_getLogs", [{
          fromBlock: `0x${fromBlock.toString(16)}`,
          toBlock: "latest",
          address: call.launchpad.launcher,
          topics: [topics],
        }]);
        if (!Array.isArray(logs)) throw new Error("malformed curve sell logs");
        const matching = logs.find((log) => curveSoldToken(log, call) === call.token.toLowerCase());
        return matching ? { observed: true, transactionHash: matching.transactionHash || null } : { observed: false };
      } catch (error) { lastError = error; }
    }
    throw lastError || new Error("curve sell evidence unavailable");
  }

  async function curveMarketAndSafety(call) {
    if (call.curveVersion === "four-v1") {
      return { decision: "block", reason: "Four.Meme legacy V1 已停止创建新币，不属于早期新发射" };
    }
    const paymentToken = call.paymentToken || (Number.isFinite(call.amountNative) ? ZERO_ADDRESS : null);
    if (!paymentToken) return { decision: "block", reason: "曲线事件缺少可验证的实际支出资产" };
    const payment = await bscQuoteDetails(paymentToken);
    const paymentAmount = call.paymentRaw
      ? Number(formatUnits(BigInt(call.paymentRaw), payment.decimals))
      : call.amountNative;
    if (!Number.isFinite(paymentAmount) || paymentAmount <= 0) return { decision: "block", reason: "曲线事件实际支出无效" };
    call.amountNative = paymentToken === ZERO_ADDRESS ? paymentAmount : null;
    call.amountUsd = paymentAmount * payment.price;
    call.paymentAmount = paymentAmount;
    call.paymentSymbol = payment.symbol;
    call.valuationBasis = "verified_curve_payment";
    const sell = await curveSellObserved(call);
    if (!sell.observed) return { decision: "pending", reason: "官方曲线尚未观察到该代币真实卖出" };
    const code = await withTimeout(bscProvider.getCode(call.token), 8_000, "BNB Chain curve token code");
    if (!code || code === "0x") return { decision: "block", reason: "曲线代币代码缺失" };
    let curveReserveUsd = null;
    let curveProof;
    let curveQuote;
    if (call.launchpad.id === "flap") {
      const stateRaw = await withTimeout(bscProvider.call({
        to: call.launchpad.launcher,
        data: FLAP_TOKEN_STATE.encodeFunctionData("getTokenV5", [call.token]),
      }), 8_000, "Flap curve state");
      const state = FLAP_TOKEN_STATE.decodeFunctionResult("getTokenV5", stateRaw)[0];
      const quoteToken = String(state.quoteTokenAddress).toLowerCase();
      if (!isAddress(quoteToken) || Number(state.status) !== 1 || BigInt(state.reserve) <= 0n) {
        return { decision: "block", reason: "Flap 官方曲线当前不可交易或储备为空" };
      }
      if (call.curveQuoteToken && call.curveQuoteToken.toLowerCase() !== quoteToken) {
        return { decision: "block", reason: "Flap 官方曲线报价资产发生不一致" };
      }
      curveQuote = await bscQuoteDetails(quoteToken);
      curveReserveUsd = Number(formatUnits(state.reserve, curveQuote.decimals)) * curveQuote.price;
      const previewRaw = await withTimeout(bscProvider.call({
        to: call.launchpad.launcher,
        data: FLAP_CURVE.encodeFunctionData("previewSell", [call.token, BigInt(call.receivedRaw)]),
      }), 8_000, "Flap previewSell");
      const preview = FLAP_CURVE.decodeFunctionResult("previewSell", previewRaw)[0];
      if (preview <= 0n) return { decision: "block", reason: "Flap previewSell 未返回可卖出金额" };
      curveProof = `status Tradable · previewSell ${Number(formatUnits(preview, curveQuote.decimals)).toFixed(4)} ${curveQuote.symbol}`;
    } else if (call.curveVersion === "four-v2") {
      const [raw, haltRaw] = await Promise.all([
        withTimeout(bscProvider.call({
          to: call.launchpad.launcher,
          data: FOUR_TOKEN_INFO.encodeFunctionData("_tokenInfos", [call.token]),
        }), 8_000, "Four.Meme curve state"),
        withTimeout(bscProvider.call({
          to: call.launchpad.launcher,
          data: FOUR_TOKEN_INFO.encodeFunctionData("_tradingHalt"),
        }), 8_000, "Four.Meme global trading state"),
      ]);
      const info = FOUR_TOKEN_INFO.decodeFunctionResult("_tokenInfos", raw);
      const tradingHalt = FOUR_TOKEN_INFO.decodeFunctionResult("_tradingHalt", haltRaw)[0];
      const quote = String(info.quote).toLowerCase();
      const launchStarted = Number(info.launchTime) <= Math.floor(now() / 1_000);
      if (String(info.base).toLowerCase() !== call.token.toLowerCase() || !isAddress(quote) || info.funds <= 0n || Number(info.status) !== 0 || tradingHalt || !launchStarted) {
        return { decision: "block", reason: "Four.Meme 官方曲线当前不可交易、储备为空或代币不匹配" };
      }
      if (call.curveQuoteToken && call.curveQuoteToken.toLowerCase() !== quote) {
        return { decision: "block", reason: "Four.Meme 官方曲线报价资产发生不一致" };
      }
      curveQuote = await bscQuoteDetails(quote);
      curveReserveUsd = Number(formatUnits(info.funds, curveQuote.decimals)) * curveQuote.price;
      curveProof = `template ${info.template} · status Trading · global active · ${curveQuote.symbol} funds $${Math.round(curveReserveUsd).toLocaleString("en-US")}`;
    } else {
      return { decision: "block", reason: "未知官方曲线版本" };
    }
    if (!Number.isFinite(curveReserveUsd) || curveReserveUsd <= 0) return { decision: "block", reason: "官方曲线储备美元价值无法确认" };
    try {
      const symbolRaw = await withTimeout(bscProvider.call({ to: call.token, data: ERC20.encodeFunctionData("symbol") }), 5_000, "curve token symbol");
      call.symbol = String(ERC20.decodeFunctionResult("symbol", symbolRaw)[0]).trim().slice(0, 30) || "?";
    } catch { /* Symbol is optional and never weakens the safety gate. */ }
    const market = {
      curveVerified: true,
      curvePlatform: call.launchpad.name,
      curveReserveUsd,
      liquidityUsd: curveReserveUsd || 0,
      volumeM5: 0,
      buysM5: 0,
      sellsM5: 1,
      paymentToken: payment.token,
      paymentSymbol: payment.symbol,
      paymentAmount,
      paymentPriceUsd: payment.price,
      paymentPriceSources: payment.sources,
      paymentVerification: call.paymentVerification || "official_event",
      valuationBasis: call.valuationBasis,
      executionPool: call.executionPool || call.launchpad.launcher,
      executionDex: call.launchpad.name,
      executionPairVerified: true,
      exactExecutionPoolVerified: true,
      curveQuoteToken: curveQuote.token,
      curveQuoteSymbol: curveQuote.symbol,
      curveQuotePriceUsd: curveQuote.price,
      url: call.launchpad.evidenceUrl,
      twitter: call.launchpad.id === "flap" ? "https://x.com/flapdotsh" : "https://x.com/four_meme_",
    };
    const security = {
      decision: "pass",
      label: "官方曲线本地初筛通过",
      reasons: [],
      warnings: ["已验证官方买入事件、零仓位、曲线状态/预览及同币真实卖出；仍不代表无价格或团队风险"],
      metrics: {
        liquidityConfirmed: true,
        sellObserved: true,
        officialCurve: true,
        previousBalanceZero: true,
        actualSpendVerified: true,
        paymentVerification: call.paymentVerification || "official_event",
        paymentPriceSources: payment.sources,
        curveQuotePriceSources: curveQuote.sources,
        curveProof,
        sellTransactionHash: sell.transactionHash,
      },
      checkedAt: new Date(now()).toISOString(),
      source: "official_curve_local_onchain",
    };
    return { decision: "pass", reason: security.label, market, security };
  }

  async function marketAndLocalSafety(call) {
    if (call.curveBuyVerified) return curveMarketAndSafety(call);
    const marketResponse = await fetchImpl(`${DEX_SCREENER_BASE}/${call.chain.slug}/${encodeURIComponent(call.token)}`, {
      headers: { accept: "application/json", "user-agent": "robinhood-launchpad-monitor" },
      signal: AbortSignal.timeout(10_000),
    });
    if (!marketResponse.ok) throw new Error(`DEX Screener HTTP ${marketResponse.status}`);
    const marketPayload = await marketResponse.json();
    const market = parseDexScreenerMarket(marketPayload, call.chain, call.token, call.executionPool);
    if (!market) return { decision: "pending", reason: "尚无可验证交易池" };
    if (!call.symbol || call.symbol === "?") call.symbol = market.tokenSymbol || "?";
    const exactExecutionPair = Boolean(call.executionPool && sameToken(call.chain, call.executionPool, market.pairAddress));
    if (call.kind === SMART_MONEY_SIGNAL_KIND) {
      const executionPools = [...new Set((Array.isArray(call.executionPools) ? call.executionPools : [])
        .map((pool) => String(pool || "").toLowerCase())
        .filter((pool) => isAddress(pool)))];
      if (call.swapVerified !== true || call.curveBuyVerified === true || executionPools.length !== 1
        || String(call.executionPool || "").toLowerCase() !== executionPools[0] || !exactExecutionPair) {
        return { decision: "block", reason: "Smart Money 买入缺少唯一且与市场数据一致的执行池证明" };
      }
    }
    call.executionDex = exactExecutionPair ? market.dexId : (call.executionDex || null);
    if (!call.amountUsd && call.chain.evm && call.paymentToken && call.paymentRaw) {
      try {
        const payment = await evmPaymentDetails(call.chain, call.paymentToken);
        const paymentAmount = Number(formatUnits(BigInt(call.paymentRaw), payment.decimals));
        if (Number.isFinite(paymentAmount) && paymentAmount > 0) {
          call.paymentAmount = paymentAmount;
          call.paymentSymbol = payment.symbol;
          call.amountNative = call.paymentToken === ZERO_ADDRESS ? paymentAmount : null;
          call.amountUsd = paymentAmount * payment.price;
          market.paymentToken = payment.token;
          market.paymentSymbol = payment.symbol;
          market.paymentAmount = paymentAmount;
          market.paymentPriceUsd = payment.price;
          market.paymentPriceSources = payment.sources;
        }
      } catch { /* A verified raw outflow can remain present even when its USD quote is unavailable. */ }
    }
    if (!call.amountUsd && call.amountNative) {
      call.amountUsd = call.amountNative * await nativeUsdPrice(call.chain);
      call.valuationBasis ||= "transaction_native_balance_delta";
    }
    if (!call.amountUsd && call.tokenAmount && market.priceUsd) {
      call.amountUsd = call.tokenAmount * market.priceUsd;
      call.valuationBasis = "estimated_received_token_value";
    }
    market.executionPool = call.executionPool || market.pairAddress;
    market.executionDex = call.executionDex || market.dexId;
    market.executionPairVerified = exactExecutionPair;
    market.exactExecutionPoolVerified = exactExecutionPair;
    market.paymentVerification = call.paymentVerification || null;
    market.valuationBasis = call.valuationBasis || (call.amountUsd ? "source_reported_usd" : null);
    if (call.kind === "top_blogger_first_buy" && ["public_onchain_verified", "public_onchain_attributed", SMART_MONEY_SOURCE_TRUST].includes(call.source?.trust)
      && (!rawPositive(call.paymentRaw) || !(Number(call.tokenAmount) > 0))) {
      return { decision: "block", reason: "链上买入缺少正支付或正代币增量证明" };
    }
    const age = market.pairCreatedAt === null ? null : now() - market.pairCreatedAt;
    if (market.liquidityUsd < minimumLiquidityUsd) return { decision: "pending", reason: `流动性低于 $${minimumLiquidityUsd}` };
    if (market.sellsM5 < 1) return { decision: "pending", reason: "最近 5 分钟尚无真实卖出" };
    if (age === null || age < -60_000 || age > maximumPairAgeMs) return { decision: "block", reason: "不是早期新池" };
    if (STABLE_OR_WRAPPED.has(String(call.symbol || "").toUpperCase())) return { decision: "block", reason: "稳定币/主流包装资产" };
    let security;
    if (call.chain.evm) {
      const provider = call.chain.id === BSC_CHAIN_ID ? bscProvider : baseProvider;
      security = await withTimeout(
        assessEvmSecurity(provider, call.token, [{ pool: market.pairAddress, kind: market.kind }]),
        12_000,
        `${call.chain.name} local security check`,
      );
      security = {
        ...security,
        metrics: { ...(security.metrics || {}), sellObserved: market.sellsM5 >= 1 },
        warnings: [...(security.warnings || []), "DEX 池最近 5 分钟已观察到真实卖出"],
      };
    } else {
      security = await assessSolanaSecurity(fetchImpl, config.fomoCallSolanaRpcUrl || "https://api.mainnet-beta.solana.com", call.token, market);
    }
    if (security.decision === "unknown") return { decision: "pending", reason: security.reasons?.[0] || security.label, market, security };
    return { decision: security.decision === "pass" ? "pass" : "block", reason: security.reasons?.[0] || security.label, market, security };
  }

  async function goPlusBscSecurity(token, market) {
    const key = String(token || "").toLowerCase();
    const cached = goPlusCache.get(key);
    if (cached && now() - cached.checkedAt < goPlusCacheMs) return cached.value;
    let value;
    try {
      const url = `${goPlusApiBase}/${GOPLUS_BSC_CHAIN_ID}?contract_addresses=${encodeURIComponent(key)}`;
      const response = await fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": "robinhood-chain-monitor/0.1 (Fomo BSC safety)" },
        signal: AbortSignal.timeout(goPlusTimeoutMs),
      });
      if (!response.ok) {
        value = { decision: "pending", reason: `GoPlus HTTP ${response.status}` };
      } else {
        value = evaluateGoPlusBscTokenSecurity(await response.json(), key, {
          maximumTax: goPlusMaximumTax,
          observedSell: Number(market?.sellsM5 || 0) >= 1,
        });
      }
    } catch (error) {
      value = { decision: "pending", reason: `GoPlus 检查失败: ${String(error?.message || error).slice(0, 120)}` };
    }
    goPlusCache.set(key, { checkedAt: now(), value });
    return value;
  }

  async function marketAndSafety(call) {
    const checked = await marketAndLocalSafety(call);
    if (checked?.decision !== "pass") return checked;
    if (checked.security?.decision !== "pass" || checked.security?.metrics?.liquidityConfirmed !== true) {
      return { ...checked, decision: "pending", reason: "本地安全结论或流动性证明不完整" };
    }
    if (Number(call.chain?.id) !== BSC_CHAIN_ID || !goPlusEnabled) return checked;
    const goPlus = await goPlusBscSecurity(call.token, checked.market);
    if (goPlus.decision !== "pass") {
      return {
        ...checked,
        decision: goPlus.decision === "block" ? "block" : "pending",
        reason: goPlus.reason,
      };
    }
    const localCoverage = checked.security?.metrics?.coverage || {};
    const combinedSecurity = {
      ...checked.security,
      decision: "pass",
      label: "本地链上 + GoPlus 严格安全门通过",
      warnings: [...new Set([...(checked.security?.warnings || []), "GoPlus 动态结果仍不代表无价格、团队或未来治理风险"])],
      metrics: {
        ...(checked.security?.metrics || {}),
        liquidityConfirmed: true,
        sellObserved: checked.security?.metrics?.sellObserved === true,
        sellabilityVerified: true,
        buySellTaxVerified: true,
        ownerPrivilegeSafe: true,
        proxySafe: true,
        mintSafe: true,
        goPlus: goPlus.metrics,
        coverage: {
          ...localCoverage,
          owner: "verified_renounced_goplus",
          proxy: "verified_not_proxy_goplus",
          mint: "verified_not_mintable_goplus",
          sellability: goPlus.metrics?.cannotSellAllEvidence === "supplemented_by_observed_sell"
            ? "supplemented_by_observed_sell"
            : "verified_goplus_honeypot_and_sell_all",
          buySellTax: "verified_goplus_at_or_below_limit",
        },
      },
      checkedAt: new Date(now()).toISOString(),
      source: `${checked.security?.source || "local_onchain"}+goplus_token_security_v1`,
    };
    return { ...checked, decision: "pass", reason: combinedSecurity.label, security: combinedSecurity };
  }

  async function verifyFirstBuy(call) {
    const payload = await api(`/v1/handle/${encodeURIComponent(call.handle)}/positions?status=all&chain=${call.chain.slug}`);
    return matchingFirstPosition(payload, call);
  }

  async function thesisFor(call, state) {
    if (["public_onchain_verified", "public_onchain_attributed", SMART_MONEY_SOURCE_TRUST].includes(call.source?.trust)) return null;
    const topHandles = new Set([
      ...state.topBloggers,
      ...(state.copeContext?.topBloggers || []),
    ].map((entry) => entry.handle.toLowerCase()));
    try {
      if (call.handle) {
        const payload = await api(`/v1/handle/${encodeURIComponent(call.handle)}/theses`);
        return parseOpenThesis(payload, call, topHandles);
      }
      const payload = await api(`/v1/tokens/${encodeURIComponent(call.token)}/thesis?chain=${call.chain.slug}&limit=10`);
      return parseOpenThesis(payload, call, topHandles);
    } catch { return null; }
  }

  async function discardPending(state, key, reason) {
    if (!Object.prototype.hasOwnProperty.call(state.pending, key)) return;
    delete state.pending[key];
    markDurableState();
    await persistDurableState(state, reason);
  }

  async function emitBestPending(state, nowMs) {
    // A discovered call must exist on disk before any irreversible delivery
    // attempt. Accepted/suppressed outcomes are checkpointed below before the
    // next candidate is considered.
    await persistDurableState(state, "pending-before-delivery");
    const bloggers = profileMap(state);
    const smartRoster = ensureSmartMoneyState(state).roster || {};
    const pending = Object.entries(state.pending)
      .map(([key, item]) => {
        const call = item.call;
        const smartProfile = call.kind === SMART_MONEY_SIGNAL_KIND
          ? smartRoster[String(call.walletAddress || call.walletProfile?.wallet || "").toLowerCase()] || null
          : null;
        const blogger = smartProfile ? null : (call.blogger || (call.handle ? bloggers.get(call.handle.toLowerCase()) : null));
        return { key, item, call, blogger, smartProfile };
      })
      .filter(({ call, blogger, smartProfile }) => fresh(call, nowMs, maximumSignalAgeMs)
        && (call.kind === "top_blogger_convergence" || blogger || smartProfile))
      .sort((left, right) => {
        if (left.call.kind === SMART_MONEY_SIGNAL_KIND && right.call.kind === SMART_MONEY_SIGNAL_KIND) {
          return Number(left.call.timestampMs || 0) - Number(right.call.timestampMs || 0)
            || Number(left.call.blockNumber || 0) - Number(right.call.blockNumber || 0)
            || Number(left.call.sourceTrade?.logIndex || 0) - Number(right.call.sourceTrade?.logIndex || 0);
        }
        return callScore(right.call, right.blogger) - callScore(left.call, left.blogger);
      });

    const emitted = [];
    for (const candidate of pending) {
      if (emitted.length >= maxEmitsPerCheck) break;
      const { key, call, blogger, smartProfile } = candidate;
      const smartMoneyCall = call.kind === SMART_MONEY_SIGNAL_KIND;
      if (call.source?.id === "fomoscan_onchain" && call.chain?.slug === "solana" && !hasExactSolanaFirstPosition(call)) {
        await discardPending(state, key, "pending-invalid-proof");
        continue;
      }
      if (state.alertedTokens[tokenKey(call.chain, call.token)]) {
        await discardPending(state, key, "pending-already-alerted");
        continue;
      }
      if (call.kind === "top_blogger_first_buy" && !candidate.item.firstBuyVerified) {
        try {
          if (!await verifyFirstBuy(call)) {
            await discardPending(state, key, "pending-first-buy-rejected");
            continue;
          }
          candidate.item.firstBuyVerified = true;
          call.positionProof ||= {
            status: "verified",
            complete: false,
            phase: "source_reported_position_summary",
            source: "cope_capital_positions",
            transactionHash: call.transactionHash || null,
            blockNumber: call.blockNumber ?? null,
          };
          markDurableState();
        } catch { continue; }
      }
      let checked;
      try { checked = await marketAndSafety(call); }
      catch { continue; }
      if (checked.decision === "pending") continue;
      if (checked.decision !== "pass") {
        await discardPending(state, key, "pending-safety-rejected");
        continue;
      }
      if (smartMoneyCall) {
        const executionPool = String(call.executionPool || "").toLowerCase();
        const exactSmartExecutionPool = call.curveBuyVerified === true
          ? checked.market?.curveVerified === true
            && checked.market?.exactExecutionPoolVerified === true
            && sameToken(call.chain, executionPool, checked.market?.executionPool)
          : call.swapVerified === true
            && Array.isArray(call.executionPools)
            && call.executionPools.length === 1
            && checked.market?.executionPairVerified === true
            && checked.market?.exactExecutionPoolVerified === true
            && sameToken(call.chain, executionPool, checked.market?.pairAddress);
        if (!exactSmartExecutionPool) {
          await discardPending(state, key, "pending-execution-pool-rejected");
          continue;
        }
        for (const evidence of [call.sourceTrade, call.transactionProof]) {
          evidence.executionPool = executionPool;
          evidence.executionPoolCount = 1;
          evidence.executionPoolReceiptVerified = true;
          evidence.executionPairVerified = true;
          evidence.exactExecutionPoolVerified = true;
        }
        markDurableState();
      }
      const thesis = await thesisFor(call, state);
      const bindingKind = !smartMoneyCall && blogger ? publicWalletBindingKind(blogger, allowGmgnObservedWallets, nowMs, gmgnAttributionMaxAgeMs) : null;
      const candidateSource = bindingKind === "fomoscan_verified" ? "fomoscan_verified_profile"
        : bindingKind === "gmgn_observed" ? "gmgn_bsc_kol_feed" : null;
      const xProfileId = String(blogger?.xProfile?.id || "");
      const proof = call.positionProof;
      const smartSourceTrade = call.sourceTrade || {};
      const smartTransactionProof = call.transactionProof || {};
      const smartWallet = String(call.walletAddress || call.walletProfile?.wallet || "").toLowerCase();
      const exactSmartMoneyProvenance = smartMoneyCall
        && call.source?.id === SMART_MONEY_SOURCE_ID
        && call.source?.trust === SMART_MONEY_SOURCE_TRUST
        && smartWalletProfileFresh(call.walletProfile, smartWallet, nowMs)
        && smartWalletProfileFresh(smartProfile?.walletProfile, smartWallet, nowMs)
        && JSON.stringify(call.walletProfile) === JSON.stringify(smartProfile?.walletProfile)
        && proof?.status === "verified"
        && proof?.complete === true
        && proof?.phase === "previous_block"
        && String(proof?.previousBalanceRaw ?? "") === "0"
        && String(proof?.wallet || "").toLowerCase() === smartWallet
        && String(proof?.token || "").toLowerCase() === String(call.token || "").toLowerCase()
        && exactTransactionHash(proof?.transactionHash) === exactTransactionHash(call.transactionHash)
        && Number(proof?.blockNumber) === Number(call.blockNumber)
        && smartSourceTrade?.scheme === "gmgn_smartmoney_trade_v1"
        && String(smartSourceTrade?.wallet || "").toLowerCase() === smartWallet
        && String(smartSourceTrade?.token || "").toLowerCase() === String(call.token || "").toLowerCase()
        && exactTransactionHash(smartSourceTrade?.transactionHash) === exactTransactionHash(call.transactionHash)
        && String(smartSourceTrade?.transactionFrom || "").toLowerCase() === smartWallet
        && Number(smartSourceTrade?.receiptStatus) === 1
        && Number(smartSourceTrade?.blockNumber) === Number(call.blockNumber)
        && String(smartSourceTrade?.side || "").toLowerCase() === "buy"
        && (smartSourceTrade?.swapVerified === true || smartSourceTrade?.curveBuyVerified === true)
        && smartSourceTrade?.executionPoolCount === 1
        && smartSourceTrade?.executionPoolReceiptVerified === true
        && smartSourceTrade?.executionPairVerified === true
        && smartSourceTrade?.exactExecutionPoolVerified === true
        && String(smartSourceTrade?.executionPool || "").toLowerCase() === String(call.executionPool || "").toLowerCase()
        && rawPositive(smartSourceTrade?.paymentRaw)
        && rawPositive(smartSourceTrade?.tokenDeltaRaw)
        && smartTransactionProof?.scheme === "evm_wallet_buy_proof_v1"
        && String(smartTransactionProof?.wallet || "").toLowerCase() === smartWallet
        && String(smartTransactionProof?.token || "").toLowerCase() === String(call.token || "").toLowerCase()
        && exactTransactionHash(smartTransactionProof?.transactionHash) === exactTransactionHash(call.transactionHash)
        && String(smartTransactionProof?.transactionFrom || "").toLowerCase() === smartWallet
        && Number(smartTransactionProof?.receiptStatus) === 1
        && Number(smartTransactionProof?.blockNumber) === Number(call.blockNumber)
        && Number(smartTransactionProof?.logIndex) === Number(smartSourceTrade?.logIndex)
        && smartTransactionProof?.eoaVerified === true
        && smartTransactionProof?.walletCode === "0x"
        && freshTimestamp(smartTransactionProof?.eoaCheckedAt, nowMs, smartMoneyMaxStatsAgeMs)
        && (smartTransactionProof?.swapVerified === true || smartTransactionProof?.curveBuyVerified === true)
        && smartTransactionProof?.executionPoolCount === 1
        && smartTransactionProof?.executionPoolReceiptVerified === true
        && smartTransactionProof?.executionPairVerified === true
        && smartTransactionProof?.exactExecutionPoolVerified === true
        && String(smartTransactionProof?.executionPool || "").toLowerCase() === String(call.executionPool || "").toLowerCase()
        && rawPositive(smartTransactionProof?.paymentRaw)
        && rawPositive(smartTransactionProof?.tokenDeltaRaw);
      const exactFreshBscProvenance = smartMoneyCall ? exactSmartMoneyProvenance : (Number(call.chain?.id) !== BSC_CHAIN_ID || (
        call.kind === "top_blogger_first_buy"
        && proof?.status === "verified"
        && proof?.complete === true
        && proof?.phase === "previous_block"
        && String(proof?.wallet || "").toLowerCase() === String(call.walletAddress || blogger?.baseAddress || "").toLowerCase()
        && String(proof?.token || "").toLowerCase() === String(call.token || "").toLowerCase()
        && String(proof?.transactionHash || "").toLowerCase() === String(call.transactionHash || "").toLowerCase()
        && Number.isSafeInteger(Number(call.blockNumber))
        && Number(proof?.blockNumber) === Number(call.blockNumber)
        && /^\d+$/.test(xProfileId)
        && freshTimestamp(blogger?.xProfile?.checkedAt, nowMs, sharedProofMaxAgeMs)
        && Number(blogger?.bscTransactionCount) > 0
        && freshTimestamp(blogger?.bscActivityCheckedAt, nowMs, sharedProofMaxAgeMs)
        && blogger?.ambiguousIdentity !== true
        && blogger?.ambiguousWallets !== true
        && blogger?.ambiguousHandles !== true
        && (bindingKind === "fomoscan_verified"
          ? (blogger?.candidateSource === "fomoscan_verified_profile"
            && freshTimestamp(blogger?.walletBinding?.checkedAt || blogger?.walletBinding?.lastCheckedAt, nowMs, sharedProofMaxAgeMs)
            && String(blogger?.walletBinding?.wallet || "").toLowerCase() === String(call.walletAddress || blogger?.baseAddress || "").toLowerCase()
            && String(blogger?.walletBinding?.handle || blogger?.walletBinding?.twitterHandle || "").toLowerCase() === String(blogger?.handle || "").toLowerCase())
          : bindingKind === "gmgn_observed"
            ? (blogger?.candidateSource === "gmgn_bsc_kol_feed"
              && gmgnTagsAreClean(blogger?.walletBinding?.tags)
              && blogger?.walletBinding?.ambiguousIdentity === false
              && blogger?.walletBinding?.ambiguousWallets === false
              && blogger?.walletBinding?.ambiguousHandles === false)
            : false)
      ));
      if ((smartMoneyCall || (strictBuyProvenance && call.kind === "top_blogger_first_buy")) && !exactFreshBscProvenance) {
        await discardPending(state, key, "pending-provenance-rejected");
        continue;
      }
      const caller = blogger ? {
        handle: blogger.handle,
        displayName: blogger.displayName,
        followers: blogger.followers,
        trafficRank: blogger.trafficRank,
        leaderboardRank: blogger.leaderboardRank,
        pnl7d: blogger.pnl,
        twitter: blogger.twitter,
        followersSyncedAt: blogger.xProfile?.checkedAt || null,
        identitySource: blogger.xProfile?.source === "fxtwitter_public_profile"
          ? (bindingKind === "gmgn_observed" ? "gmgn+fxtwitter" : "fomoscan+fxtwitter")
          : null,
        xProfileId: /^\d+$/.test(xProfileId) ? xProfileId : null,
        bscTransactionCount: blogger.bscTransactionCount ?? null,
        bscActivityCheckedAt: blogger.bscActivityCheckedAt || null,
        candidateSource,
        origin: candidateSource,
        ambiguousIdentity: false,
        ambiguousWallets: false,
        ambiguousHandles: false,
      } : null;
      const topHandles = new Set(state.topBloggers.map((entry) => entry.handle.toLowerCase()));
      // Cope collection temporarily owns state.topBloggers, then restores the
      // independent public-onchain roster. Persist the exact qualified
      // participant bindings with a convergence so delayed delivery cannot
      // accidentally rebuild evidence from that unrelated restored roster.
      const callers = call.kind === "top_blogger_convergence"
        ? (Array.isArray(call.participantBindings) ? call.participantBindings : []).map((participant) => ({ ...participant }))
        : (call.wallets || []).filter((wallet) => topHandles.has(wallet.handle.toLowerCase())).map((wallet) => {
          const profile = bloggers.get(wallet.handle.toLowerCase());
          return {
            ...wallet,
            followers: profile?.followers || null,
            trafficRank: profile?.trafficRank || null,
            walletAddress: call.chain?.slug === "solana" ? profile?.solanaAddress || null : profile?.baseAddress || null,
          };
        });
      const profileHandle = blogger?.source?.startsWith("fomoscan")
        ? (caller?.handle || callers[0]?.handle || thesis?.handle || null)
        : null;
      const walletAddress = call.walletAddress || (blogger
        ? (call.chain.slug === "solana" ? blogger.solanaAddress : blogger.baseAddress)
        : null) || null;
      const transactionHash = call.transactionHash || null;
      const observedAt = new Date(nowMs).toISOString();
      const eventLogIndex = smartMoneyCall ? Number(call.sourceTrade?.logIndex ?? 0) : null;
      const event = {
        type: "fomo_family_top_call",
        eventKey: smartMoneyCall
          ? `smart-wallet-buy:bsc:${transactionHash}:${eventLogIndex}:${walletAddress}:${call.token}`.toLowerCase()
          : `fomo-call:${call.kind}:${call.callId}`.toLowerCase(),
        qualified: true,
        strong: true,
        signalKind: call.kind,
        activity: "buy",
        trade: "buy",
        action: "buy",
        side: "buy",
        callId: call.callId,
        platform: smartMoneyCall
          ? { id: "smart-money", name: "高收益高胜率公开钱包" }
          : { id: "fomo", name: "fomo.family", website: FOMO_PLATFORM_URL, twitter: "https://x.com/fomo" },
        launchpad: call.launchpad || null,
        source: call.source || { id: "cope_capital", name: "Cope Capital Fomo 社交图谱链上 API", trust: "authorized_public_api", url: "https://api.cope.capital/docs" },
        sourceTrust: call.source?.trust || null,
        ...(smartMoneyCall ? {
          sourceClassification: call.sourceClassification || {
            ...smartMoneySourceClassification(call.walletProfile?.tags, call.sourceTrade?.tags),
          },
          positionSemantics: call.positionSemantics || {
            id: "new_position_after_previous_block_zero",
            label: "前一区块零仓后的新建仓",
            proofBoundary: "previous_block",
            lifetimeFirstBuyVerified: false,
            transactionImmediatePreBalanceVerified: false,
          },
        } : {}),
        chain: call.chain,
        chainId: call.chain.id,
        token: call.token,
        contractAddress: call.token,
        tokenSymbol: call.symbol,
        tokenAmount: call.tokenAmount ?? null,
        caller,
        callers,
        candidateSource,
        origin: candidateSource,
        ambiguousIdentity: false,
        ambiguousWallets: false,
        ambiguousHandles: false,
        walletAddress,
        walletBinding: bindingKind === "fomoscan_verified" && blogger?.xProfile?.source === "fxtwitter_public_profile" ? {
          ...blogger.walletBinding,
          wallet: blogger.baseAddress || walletAddress,
          handle: blogger.handle,
          twitterHandle: blogger.twitterHandle || null,
          xProfileId,
          checkedAt: blogger.walletBinding?.checkedAt || blogger.walletBinding?.lastCheckedAt || null,
          bscActivityCheckedAt: blogger.bscActivityCheckedAt || null,
          bscTransactionCount: blogger.bscTransactionCount ?? null,
          ambiguousIdentity: false,
          ambiguousWallets: false,
          ambiguousHandles: false,
          candidateSource: "fomoscan_verified_profile",
        } : null,
        walletAttribution: bindingKind === "gmgn_observed" && blogger?.xProfile?.source === "fxtwitter_public_profile" ? {
          scheme: "gmgn_x_maker_observation_v1",
          status: "observed",
          verified: false,
          monitoringWallet: blogger.baseAddress || walletAddress,
          xHandle: blogger.twitterHandle || blogger.handle,
          fomoTagged: blogger.walletBinding?.tags?.includes("fomo") === true,
          tags: blogger.walletBinding?.tags || [],
          observedAt: blogger.walletBinding?.observedAt || null,
          source: "gmgn_bsc_kol_feed",
          candidateSource: "gmgn_bsc_kol_feed",
          xProfileId: blogger.xProfile?.id || null,
          xFollowersCheckedAt: blogger.xProfile?.checkedAt || null,
          bscActivityCheckedAt: blogger.bscActivityCheckedAt || null,
          bscTransactionCount: blogger.bscTransactionCount ?? null,
          ambiguousIdentity: false,
          ambiguousWallets: false,
          ambiguousHandles: false,
        } : null,
        amountUsd: call.amountUsd || null,
        totalUsd: call.totalUsd || call.amountUsd || null,
        buyerCount: call.buyerCount || 1,
        paymentToken: call.paymentToken || checked.market?.paymentToken || null,
        paymentRaw: call.paymentRaw || null,
        paymentAmount: call.paymentAmount ?? checked.market?.paymentAmount ?? null,
        paymentSymbol: call.paymentSymbol || checked.market?.paymentSymbol || null,
        paymentVerification: call.paymentVerification || checked.market?.paymentVerification || null,
        valuationBasis: call.valuationBasis || checked.market?.valuationBasis || null,
        transactionHash,
        transactionUrl: transactionHash && call.chain.transactionExplorer ? `${call.chain.transactionExplorer}${transactionHash}` : null,
        blockNumber: call.blockNumber ?? call.slot ?? null,
        ...(smartMoneyCall ? {
          logIndex: eventLogIndex,
          walletProfile: call.walletProfile,
          sourceTrade: call.sourceTrade,
          transactionProof: call.transactionProof,
        } : {}),
        executionPool: call.executionPool || checked.market?.executionPool || checked.market?.pairAddress || null,
        executionDex: call.executionDex || checked.market?.executionDex || checked.market?.dexId || call.launchpad?.name || null,
        executionPairVerified: checked.market?.executionPairVerified ?? Boolean(call.curveBuyVerified),
        exactExecutionPoolVerified: checked.market?.exactExecutionPoolVerified ?? Boolean(call.curveBuyVerified),
        marketCapAtDetection: call.marketCapAtDetection ?? null,
        publishedAt: new Date(call.timestampMs).toISOString(),
        market: checked.market,
        security: checked.security,
        positionProof: call.positionProof || null,
        candidatePoolSize: state.coverageSummary?.candidatePoolSize ?? state.publicOnchain?.candidateHandles?.length ?? configuredPublicHandles.length,
        monitoredTopCount: state.coverageSummary?.monitoredTopCount ?? state.topBloggers.length,
        coverage: state.coverageSummary || null,
        thesis,
        ...(!smartMoneyCall ? {
          fomoUrl: `${FOMO_PLATFORM_URL}/coin?address=${encodeURIComponent(call.token)}&chainId=${call.chain.id}&source=share_link`,
          profileUrl: profileHandle ? `${FOMO_PLATFORM_URL}/profile/${encodeURIComponent(profileHandle)}` : null,
        } : {}),
        explorerUrl: `${call.chain.explorer}${call.token}`,
        observedAt,
      };
      await persistDurableState(state, "alert-pre-send");
      const delivery = await alertSender(config, event);
      if (classifyFomoAlertDelivery(delivery) === "suppressed") {
        await discardPending(state, key, "alert-suppressed");
        continue;
      }
      state.alertedTokens[tokenKey(call.chain, call.token)] = nowMs;
      delete state.pending[key];
      markDurableState();
      await persistDurableState(state, "alert-accepted");
      emitted.push(event);
    }
    if (!emitted.length) return null;
    return emitted.length === 1 ? emitted[0] : emitted;
  }

  async function collectActivity(state, nowMs) {
    const query = new URLSearchParams({ watchlist_id: state.watchlist.id, action: "buy" });
    if (state.cursor !== null && state.cursor !== undefined) query.set("since", String(state.cursor));
    const poll = await api(`/v1/activity/poll?${query.toString()}`);
    const count = Math.max(0, Math.trunc(finite(poll?.count ?? poll?.data?.count) || 0));
    const latest = rawCursor(poll?.latest_at ?? poll?.latestAt ?? poll?.data?.latest_at);
    if (!state.initializedAt) {
      setDurableField(state, "cursor", latest ?? nowMs);
      setDurableField(state, "initializedAt", new Date(nowMs).toISOString());
      return;
    }
    if (!count) {
      setDurableField(state, "cursor", cursorMax(state.cursor, latest));
      return;
    }
    query.set("limit", "100");
    const calls = parseCopeActivities(await api(`/v1/activity?${query.toString()}`));
    const bloggers = profileMap(state);
    for (const call of calls.sort((left, right) => left.timestampMs - right.timestampMs)) {
      setDurableField(state, "cursor", cursorMax(state.cursor, cursorValue(call)));
      if (state.seenCalls[call.callId]) continue;
      state.seenCalls[call.callId] = nowMs;
      markDurableState();
      const blogger = bloggers.get(call.handle.toLowerCase());
      if (!blogger || !fresh(call, nowMs, maximumSignalAgeMs)) continue;
      const key = `activity:${call.callId}`;
      state.pending[key] = { call: { ...call, blogger }, firstSeenAt: nowMs, firstBuyVerified: false };
      markDurableState();
    }
    setDurableField(state, "cursor", cursorMax(state.cursor, latest));
  }

  async function collectConvergences(state, nowMs) {
    const lastChecked = Date.parse(state.convergenceCheckedAt || "");
    if (Number.isFinite(lastChecked) && nowMs - lastChecked < convergenceIntervalMs) return;
    const since = state.convergenceInitializedAt ? nowMs - maximumSignalAgeMs : nowMs - 24 * 60 * 60 * 1_000;
    const calls = parseCopeConvergences(await api(`/v1/convergence?since=${since}&limit=50`));
    const bloggers = profileMap(state);
    for (const call of calls) {
      const topWallets = [...new Map(call.wallets
        .filter((wallet) => bloggers.has(wallet.handle.toLowerCase()))
        .map((wallet) => [wallet.handle.toLowerCase(), wallet])).values()];
      const participantBindings = topWallets.map((wallet) => {
        const profile = bloggers.get(wallet.handle.toLowerCase());
        const walletAddress = String(call.chain?.slug === "solana" ? profile?.solanaAddress || "" : profile?.baseAddress || "");
        if (!validToken(call.chain, walletAddress)) return null;
        return {
          ...wallet,
          handle: profile.handle,
          displayName: profile.displayName || profile.handle,
          followers: profile.followers || null,
          trafficRank: profile.trafficRank || null,
          leaderboardRank: profile.leaderboardRank || null,
          walletAddress,
        };
      }).filter(Boolean);
      const topFollowers = Math.max(0, ...participantBindings.map((participant) => participant.followers || 0));
      const distinctWallets = new Set(participantBindings.map((participant) => participant.walletAddress.toLowerCase()));
      const qualified = call.totalUsd >= minimumConvergenceUsd && participantBindings.length >= 2 && distinctWallets.size >= 2;
      if (!state.convergenceInitializedAt) {
        state.seenConvergences[call.callId] = nowMs;
        markDurableState();
        continue;
      }
      if (state.seenConvergences[call.callId]) continue;
      state.seenConvergences[call.callId] = nowMs;
      markDurableState();
      if (!qualified || !fresh(call, nowMs, maximumSignalAgeMs)) continue;
      const key = `convergence:${call.callId}`;
      state.pending[key] = { call: { ...call, topFollowers, participantBindings }, firstSeenAt: nowMs };
      markDurableState();
    }
    if (!state.convergenceInitializedAt) {
      state.convergenceInitializedAt = new Date(nowMs).toISOString();
      markDurableState();
    }
    state.convergenceCheckedAt = new Date(nowMs).toISOString();
  }

  async function collectCopeContext(state, nowMs) {
    const fields = ["initializedAt", "cursor", "watchlist", "topBloggers", "leaderboardCheckedAt", "convergenceInitializedAt", "convergenceCheckedAt"];
    const publicContext = Object.fromEntries(fields.map((field) => [field, state[field]]));
    const cope = state.copeContext || {};
    fields.forEach((field) => { state[field] = cope[field] ?? defaultState()[field]; });
    try {
      const leaderboardAt = Date.parse(state.leaderboardCheckedAt || "");
      if (!state.watchlist?.id || !state.topBloggers.length || !Number.isFinite(leaderboardAt) || nowMs - leaderboardAt >= leaderboardIntervalMs) {
        await ensureTopWatchlist(state);
      }
      await collectActivity(state, nowMs);
      await collectConvergences(state, nowMs);
    } finally {
      const nextContext = { ...cope };
      fields.forEach((field) => { nextContext[field] = state[field]; });
      state.copeContext = nextContext;
      fields.forEach((field) => { state[field] = publicContext[field]; });
    }
  }

  async function check() {
    if (processLeaseBlocked || stopping) return null;
    if (running) return null;
    running = true;
    let settleActiveCheck;
    activeCheckDone = new Promise((resolve) => { settleActiveCheck = resolve; });
    try {
      const loadedState = await readStateWithCheckpoint();
      const state = loadedState.state;
      const nowMs = Number(now());
      const persistedCheckedAtMs = Date.parse(state.health?.checkedAt || "");
      activePersistence = {
        state,
        durableDirty: false,
        telemetryTransitionDirty: false,
        checkpointDirty: false,
        bscLookbackConsumed: false,
        bscBaselineAfterCheckpoint: null,
        persistedCheckpoint: loadedState.checkpoint,
        persistedHealth: materialHealthState(state.health),
        persistedSourceHealth: materialSourceHealthState(state),
        lastPersistedAtMs: Number.isFinite(persistedCheckedAtMs) ? persistedCheckedAtMs : null,
      };
      try {
        if (!config.fomoCallEnabled) {
          state.health = { ...state.health, status: "disabled", checkedAt: new Date(nowMs).toISOString(), checkStartedAt: null, lastError: null };
          await persistTelemetryState(state, nowMs);
          return null;
        }
      if (!legacyBuyEnabled) {
        for (const [key, item] of Object.entries(state.pending || {})) {
          if (item?.call?.kind !== SMART_MONEY_SIGNAL_KIND) {
            delete state.pending[key];
            markDurableState();
          }
        }
      }
      let source = legacyBuyEnabled ? "fomoscan_onchain" : SMART_MONEY_SOURCE_ID;
      let sourceWarning = null;
      let convergenceAvailable = false;
      let convergenceReason = legacyBuyEnabled && config.copeApiKey ? "source_unavailable" : (legacyBuyEnabled ? "cope_not_configured" : "disabled");
      const emittedEvents = [];
      const smartMoney = ensureSmartMoneyState(state);
      let smartFeedStatus = "disabled";
      let smartStatsStatus = "disabled";
      let smartStatsPreflightRan = false;
      if (smartMoneyEnabled) {
        smartFeedStatus = await refreshSmartMoneyFeed(state, Number(now()));
        const preflightAtMs = Number(now());
        const qualificationBeforeExact = updateSmartQualificationCoverage(smartMoney, preflightAtMs);
        const recoverableLastKnownGood = Object.values(smartMoney.candidates || {}).some((candidate) =>
          smartCandidateHasLastKnownGood(candidate, preflightAtMs));
        // When every admitted profile crossed the strict freshness boundary,
        // revalidate before exact-feed or block scanning. The LKG roster keeps
        // cursors and candidates intact, but can never emit a stale
        // "high-profit/high-win-rate" alert.
        if (qualificationBeforeExact.fresh === 0
          && (qualificationBeforeExact.admitted > 0 || recoverableLastKnownGood)) {
          smartStatsStatus = await refreshSmartMoneyStats(state, Number(now()));
          smartStatsPreflightRan = true;
        }
        const feedExactStatus = await collectExactSmartMoneyFeedTrades(state, Number(now()));
        setTelemetryField(ensureSmartMoneyState(state), "exactTradeStatus", feedExactStatus);
      } else {
        setTelemetryField(smartMoney, "feedStatus", "disabled");
        setTelemetryField(smartMoney, "statsStatus", "disabled");
        setTelemetryField(smartMoney, "exactTradeStatus", "disabled");
      }
      await persistDurableState(state, "smart-money-feed-exact");
      await persistCheckpoint(state, "smart-money-feed-exact");
      const feedExactEmitted = await emitBestPending(state, Number(now()));
      if (Array.isArray(feedExactEmitted)) emittedEvents.push(...feedExactEmitted);
      else if (feedExactEmitted) emittedEvents.push(feedExactEmitted);

      let coverageStatus = await collectPublicOnchain(state, Number(now()));
      await persistDurableState(state, "onchain-cursors-pending");
      await persistCheckpoint(state, "onchain-cursors-pending");
      await finalizeBscCheckpointControls(state);
      const realtimeEmitted = await emitBestPending(state, Number(now()));
      if (Array.isArray(realtimeEmitted)) emittedEvents.push(...realtimeEmitted);
      else if (realtimeEmitted) emittedEvents.push(realtimeEmitted);

      const admittedBeforeProfiles = new Set(ensureSmartMoneyState(state).admittedWallets);
      if (smartMoneyEnabled && !smartStatsPreflightRan) smartStatsStatus = await refreshSmartMoneyStats(state, Number(now()));
      const newlyAdmitted = new Set(ensureSmartMoneyState(state).admittedWallets
        .filter((wallet) => !admittedBeforeProfiles.has(wallet)));
      if (newlyAdmitted.size) {
        const postStatsExact = await collectExactSmartMoneyFeedTrades(state, Number(now()), { wallets: newlyAdmitted });
        const smartMoney = ensureSmartMoneyState(state);
        setTelemetryField(smartMoney, "exactTradeStatus",
          [smartMoney.exactTradeStatus, postStatsExact].includes("partial") ? "partial" : postStatsExact);
      }
      const finalSmartMoney = ensureSmartMoneyState(state);
      state.publicOnchain.coverage.smartMoney = {
        sourceClassification: "gmgn_public_performance_wallet",
        feed: smartFeedStatus,
        stats: smartStatsStatus,
        qualification: finalSmartMoney.qualificationCoverage?.status || "initializing",
        fresh: Number(finalSmartMoney.qualificationCoverage?.fresh || 0),
        lastKnownGood: Number(finalSmartMoney.qualificationCoverage?.lastKnownGood || 0),
        exactTrades: finalSmartMoney.exactTradeStatus,
        admitted: finalSmartMoney.admittedWallets.length,
      };
      const smartMoneyCoverage = [smartFeedStatus, smartStatsStatus, finalSmartMoney.exactTradeStatus]
        .some((status) => ["partial", "degraded", "rate_limited"].includes(status)) ? "partial" : "healthy";
      if ((smartMoneyCoverage === "partial" || finalSmartMoney.qualificationCoverage?.status !== "healthy")
        && coverageStatus === "healthy") coverageStatus = "partial";
      await persistDurableState(state, "smart-money-roster-exact");
      await persistCheckpoint(state, "smart-money-roster-exact");
      const postStatsEmitted = await emitBestPending(state, Number(now()));
      if (Array.isArray(postStatsEmitted)) emittedEvents.push(...postStatsEmitted);
      else if (postStatsEmitted) emittedEvents.push(postStatsEmitted);
      if (legacyBuyEnabled && config.copeApiKey) {
        const nextAttemptAt = Date.parse(state.copeContext?.nextAttemptAt || "");
        if (!Number.isFinite(nextAttemptAt) || nowMs >= nextAttemptAt) {
          try {
            await collectCopeContext(state, Number(now()));
            setDurableField(state.copeContext, "nextAttemptAt", null);
            setDurableField(state.copeContext, "lastError", null);
            source = "fomoscan_onchain+cope_capital";
            convergenceAvailable = true;
            convergenceReason = null;
            fallbackLogged = false;
          } catch (error) {
            sourceWarning = `Cope unavailable: ${error.message.slice(0, 140)}`;
            convergenceReason = "cope_unavailable";
            setDurableField(state.copeContext, "nextAttemptAt", new Date(nowMs + 15 * 60_000).toISOString());
            setDurableField(state.copeContext, "lastError", sourceWarning);
            if (coverageStatus === "healthy") coverageStatus = "partial";
            if (!fallbackLogged) {
              logger.error(`[fomo-call][public-fallback] ${sourceWarning}; local Base/BNB monitoring remains active`);
              fallbackLogged = true;
            }
          }
        } else {
          sourceWarning = state.copeContext.lastError || "Cope is in temporary backoff";
          convergenceReason = "cope_backoff";
          if (coverageStatus === "healthy") coverageStatus = "partial";
        }
      } else if (legacyBuyEnabled) {
        if (!fallbackLogged) {
          logger.error("[fomo-call][public-fallback] COPE_API_KEY is not configured; using qualified public identity-linked wallets and local on-chain swaps");
          fallbackLogged = true;
        }
      }
      await persistDurableState(state, "cope-cursor-pending");
      const summaryNowMs = Number(now());
      state.coverageSummary = buildCoverageSummary(state, { nowMs: summaryNowMs, convergenceAvailable, convergenceReason });
      if (coverageStatus === "healthy" && !state.coverageSummary.complete) coverageStatus = "partial";
      const remainingEmitted = await emitBestPending(state, Number(now()));
      if (Array.isArray(remainingEmitted)) emittedEvents.push(...remainingEmitted);
      else if (remainingEmitted) emittedEvents.push(remainingEmitted);
      const pruneNowMs = Number(now());
      if (smartMoneyEnabled) boundSmartPendingTrades(ensureSmartMoneyState(state), pruneNowMs);
      if (pruneState(state, pruneNowMs)) markDurableState();
      const finishedAtMs = Number(now());
      state.health = {
        status: coverageStatus,
        source,
        checkedAt: new Date(finishedAtMs).toISOString(),
        checkStartedAt: null,
        lastSuccessAt: new Date(finishedAtMs).toISOString(),
        lastError: sourceWarning,
        consecutiveFailures: 0,
        durationMs: Math.max(0, finishedAtMs - nowMs),
      };
      await persistTelemetryState(state, finishedAtMs);
      if (!emittedEvents.length) return null;
      return emittedEvents.length === 1 ? emittedEvents[0] : emittedEvents;
      } catch (error) {
        const finishedAtMs = Number(now());
        state.coverageSummary = buildCoverageSummary(state, {
          nowMs: finishedAtMs,
          convergenceAvailable: false,
          convergenceReason: legacyBuyEnabled
            ? (config.copeApiKey ? "check_failed" : "cope_not_configured")
            : "disabled",
        });
        state.health = {
          ...state.health,
          status: "degraded",
          checkedAt: new Date(finishedAtMs).toISOString(),
          checkStartedAt: null,
          lastError: error.message.slice(0, 200),
          consecutiveFailures: Number(state.health?.consecutiveFailures || 0) + 1,
          durationMs: Math.max(0, finishedAtMs - nowMs),
        };
        if (pruneState(state, nowMs)) markDurableState();
        await persistTelemetryState(state, finishedAtMs).catch(() => {});
        logger.error(`[fomo-call] ${error.message}`);
        return null;
      } finally {
        activePersistence = null;
      }
    } finally {
      running = false;
      settleActiveCheck();
    }
  }

  if (autoStart && !processLeaseBlocked) void check();
  const interval = Math.max(6_000, Number(config.fomoCallPollIntervalMs || 12_000));
  const timer = autoStart && !processLeaseBlocked ? setInterval(check, interval) : null;
  timer?.unref();
  return {
    check,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopping = true;
      if (timer) clearInterval(timer);
      const stopAttempt = (async () => {
        await gmgnSharedClient?.stop();
        await activeCheckDone;
        try {
          await checkpointWriteQueue;
          await absorbDurableCheckpoint();
        } finally {
          if (!resourcesClosed) {
            resourcesClosed = true;
            releaseProcessLease?.();
            await Promise.allSettled([
              ...(!dependencies.baseProvider ? [Promise.resolve().then(() => baseProvider.destroy())] : []),
              ...(!dependencies.bscProvider ? [Promise.resolve().then(() => bscProvider.destroy())] : []),
            ]);
          }
        }
      })();
      stopPromise = stopAttempt;
      void stopAttempt.catch(() => {
        if (stopPromise === stopAttempt) stopPromise = null;
      });
      return stopAttempt;
    },
    stateFile,
    checkpointFile,
  };
}
