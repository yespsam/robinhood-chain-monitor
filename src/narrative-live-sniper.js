// Hotspot match is another LIVE entry signal. It does not wait for a paper
// position in that token, and it does not have its own enable switch, ticket
// size, or daily cap. Authorization is checkGates (daily-loss guard,
// consecutive-loss pause, paper SQN). Size is the shared fixed 10 U ticket.
// The stop is the shared 0.8 / 1.4 ladder. Decisions append to live-decisions.jsonl.
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { isTradeBotRawAmount } from "./trade-bot-protocol.js";
import { paperTaxScreen } from "./paper-safety-policy.js";
import { PAPER_FIXED_ENTRY_USD, paperPositionSize } from "./paper-position-sizing.js";
import { checkGates } from "./live-entry-gates.js";
import { createLiveLadder } from "./live-ladder-breakeven.js";
import { buildGmgnStopReplacePlan, createGmgnCliStopClient, gmgnAmendEnabled, runGmgnStopAmend } from "./gmgn-stop-amend.js";
import { createHotNarrativeStore } from "./hot-narrative-record.js";
import { createFastDevStore, fastDevSignal, isRugDev, listRugDevs, normalizeDevWallet, rankFastDevs, recordFastDevLaunch } from "./fast-dev-registry.js";
import { resolvePaperLedgerPath } from "./paper-sqn.js";

export const NARRATIVE_LIVE_DECISION_FILE = "live-decisions.jsonl";
export const NARRATIVE_LIVE_DEFAULT_QUOTES = Object.freeze({
  bsc: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
  sol: "So11111111111111111111111111111111111111112",
});

const EVM = /^0x[0-9a-fA-F]{40}$/;
const SOL = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BUY_SLIPPAGE_PERCENT = 1;
// Aggressive default so a 何一 / CZ snipe pays to land before the copy bots.
// normal < high < turbo. BSC value is gwei. SOL values are SOL.
export const NARRATIVE_LIVE_GAS_TIERS = Object.freeze({
  normal: { bscGasGwei: 0.1, solPriorityFee: 0.00005, solTipFee: 0.00005, bscTipFee: null },
  high: { bscGasGwei: 1, solPriorityFee: 0.0005, solTipFee: 0.0005, bscTipFee: 0.0005 },
  turbo: { bscGasGwei: 5, solPriorityFee: 0.002, solTipFee: 0.002, bscTipFee: 0.002 },
});
const LAUNCH_TYPES = new Set([
  "bsc_launchpad_update",
  "flap_pool_launch",
  "token_created",
  "pump_create",
  "pump_fun_create",
  "four_token_created",
]);

function onFlag(raw) {
  return ["1", "true", "on", "yes"].includes(String(raw ?? "").trim().toLowerCase());
}

function offFlag(raw) {
  return ["0", "false", "off", "no"].includes(String(raw ?? "").trim().toLowerCase());
}

function readInt(raw, fallback, max, min = 1) {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) return null;
  return value;
}

export function narrativeLiveConfig(env = process.env) {
  const priorityRaw = env?.NARRATIVE_LIVE_PRIORITY_ONLY;
  return {
    sizeUsd: PAPER_FIXED_ENTRY_USD,
    windowMs: readInt(env?.NARRATIVE_LIVE_WINDOW_MS, 600_000, 86_400_000),
    priorityOnly: priorityRaw === undefined || priorityRaw === null || priorityRaw === "" ? true : !offFlag(priorityRaw),
    requireFastDev: onFlag(env?.NARRATIVE_LIVE_REQUIRE_FAST_DEV),
    blockRugDevs: onFlag(env?.NARRATIVE_LIVE_BLOCK_RUG_DEVS),
    fastDevMinLaunches: readInt(env?.NARRATIVE_FAST_DEV_MIN_LAUNCHES, 2, 100),
    fastDevMaxMedianSeconds: readInt(env?.NARRATIVE_FAST_DEV_MAX_MEDIAN_SECONDS, 180, 3_600),
    gasLevel: narrativeLiveGasLevel(env),
  };
}

export function narrativeLiveGasLevel(env = process.env) {
  const raw = String(env?.NARRATIVE_LIVE_GAS_LEVEL ?? "").trim().toLowerCase();
  if (raw === "normal" || raw === "high" || raw === "turbo") return raw;
  return "turbo";
}

export function narrativeLiveGasTier(env = process.env) {
  return NARRATIVE_LIVE_GAS_TIERS[narrativeLiveGasLevel(env)];
}

function dayStartMs(nowMs) {
  return Math.floor(nowMs / 86_400_000) * 86_400_000;
}

// Same 10% daily / round / cash stop the paper engine feeds to checkGates.
export function sharedDailyLoss(account, nowMs) {
  if (!account || typeof account !== "object") return { allow: true, reason: null };
  const initial = Number(account.initialCash);
  if (!(initial > 0)) return { allow: true, reason: null };
  const dailyRealizedPnl = (Array.isArray(account.trades) ? account.trades : [])
    .filter((trade) => trade?.atMs >= dayStartMs(nowMs) && trade.atMs <= nowMs)
    .reduce((sum, trade) => sum + (Number(trade.realizedPnl) || 0), 0);
  const tripped = dailyRealizedPnl <= -initial * 0.1
    || Number(account.realizedPnl) <= -initial * 0.1
    || Number(account.cash) <= initial * 0.1;
  if (!tripped) return { allow: true, reason: null };
  return { allow: false, reason: "UTC 当日或累计亏损保护已触发，拒绝 LIVE 新开仓" };
}

function sharedTicket(account, token, sizeUsd) {
  const cash = Number(account?.cash);
  const liquidity = Number(token?.liquidity);
  if (!Number.isFinite(cash) || !Number.isFinite(liquidity)) return { sizeUsd, sizing: null };
  const sizing = paperPositionSize({ cash, liquidity, baseEntryUsd: 4, fixedEntryUsd: sizeUsd });
  if (!sizing || !(sizing.budgetUsd > 0)) return { sizeUsd: 0, sizing };
  return { sizeUsd: sizing.budgetUsd, sizing };
}

export function narrativeTokenKey(chain, address) {
  const name = String(chain || "").toLowerCase();
  if (name === "sol") return `sol:${String(address || "").trim()}`;
  return `${name}:${String(address || "").trim().toLowerCase()}`;
}

function addressOk(chain, value) {
  if (chain === "sol") return SOL.test(String(value || ""));
  return EVM.test(String(value || ""));
}

export function usdToRawAmount(sizeUsd, quoteUsd, decimals) {
  if (!(Number(sizeUsd) > 0) || !(Number(quoteUsd) > 0)) return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) return null;
  const quoteScaled = BigInt(Math.round(Number(quoteUsd) * 1e8));
  const sizeScaled = BigInt(Math.round(Number(sizeUsd) * 1e8));
  if (quoteScaled <= 0n || sizeScaled <= 0n) return null;
  const raw = (sizeScaled * (10n ** BigInt(decimals)) + quoteScaled / 2n) / quoteScaled;
  if (raw <= 0n) return null;
  const text = raw.toString();
  return isTradeBotRawAmount(text) ? text : null;
}

function taxFraction(token, key) {
  if (token?.[key] != null && token[key] !== "") return token[key];
  const bps = Number(token?.[`${key}Bps`]);
  return Number.isFinite(bps) ? bps / 10_000 : undefined;
}

export function narrativeLiveSecurityDecision(token = {}) {
  if (token.isHoneypot === true || token.honeypot === true || token.cannotSell === true) {
    return { allow: false, gate: "honeypot", reason: "检测到貔貅或不可卖，拒绝 LIVE" };
  }
  const sellVerified = token.isHoneypot === false || token.honeypot === false || (token.sellable === true && token.cannotSell === false);
  if (!sellVerified) return { allow: false, gate: "honeypot", reason: "可卖性尚未验证，拒绝 LIVE" };
  for (const [field, label] of [["isBlacklisted", "黑名单"], ["canMint", "可任意增发"], ["canFreeze", "可任意冻结"], ["canPause", "可任意暂停"]]) {
    if (token[field] === true) return { allow: false, gate: "security", reason: `${label}，拒绝 LIVE` };
  }
  const screened = paperTaxScreen({ buyTax: taxFraction(token, "buyTax"), sellTax: taxFraction(token, "sellTax") });
  if (screened.blocked) return { allow: false, gate: "tax", reason: screened.reasons.join("；") };
  if (screened.missing.length) return { allow: false, gate: "tax", reason: "税率未知，拒绝 LIVE" };
  const level = String(token.riskLevel || "").toLowerCase();
  if (token.highRisk === true || level === "high" || level === "critical" || token.securityDecision === "block" || token.goPlusDecision === "block") {
    return { allow: false, gate: "security", reason: "安全检查未通过，拒绝 LIVE" };
  }
  const pass = level === "low" || level === "medium" || token.securityDecision === "pass" || token.goPlusDecision === "pass" || token.sellable === true;
  if (!pass) return { allow: false, gate: "security", reason: "安全检查未通过，拒绝 LIVE" };
  return { allow: true, gate: null, reason: null };
}

function latestBuyByToken(priorBuys = []) {
  const byToken = new Map();
  for (const row of priorBuys) {
    if (!row || (row.ok !== true && row.submitted !== true)) continue;
    const key = narrativeTokenKey(row.chain, row.address);
    if (!key || key.endsWith(":")) continue;
    byToken.set(key, row);
  }
  return [...byToken.values()];
}

function paperLiveClosedTrades(account) {
  const open = new Map();
  const closed = [];
  for (const trade of account?.trades || []) {
    if (!trade || typeof trade !== "object") continue;
    const key = `${trade.chain}:${trade.address}`;
    if (trade.side === "buy") {
      open.set(key, { pnl: 0, left: Number(trade.quantity), quantity: Number(trade.quantity), entry: trade });
    } else {
      const lot = open.get(key);
      if (!lot) continue;
      lot.pnl += Number(trade.realizedPnl) || 0;
      lot.left -= Number(trade.quantity) || 0;
      if (lot.left <= lot.quantity * 1e-9) {
        if (lot.entry?.entryEvidence?.liveEntryGate?.allow === true) closed.push({ realizedPnl: lot.pnl, closedAtMs: trade.atMs });
        open.delete(key);
      }
    }
  }
  return closed;
}

async function loadPaperBook(dataDir, fsImpl) {
  try {
    const ledgerPath = await resolvePaperLedgerPath({ dataDir });
    if (!ledgerPath) return { account: null, enabled: true };
    const doc = JSON.parse(await fsImpl.readFile(ledgerPath, "utf8"));
    const account = doc?.account && typeof doc.account === "object" ? doc.account : null;
    const enabled = typeof doc?.enabled === "boolean" ? doc.enabled : true;
    return { account, enabled };
  } catch {
    return { account: null, enabled: true };
  }
}

export function narrativeLiveClosedTrades(decisions = []) {
  return decisions.filter((row) => row?.kind === "narrative_live_close" && (Number.isFinite(Number(row.realizedPnl)) || Number.isFinite(Number(row.pnl))))
    .map((row) => ({
      realizedPnl: Number.isFinite(Number(row.realizedPnl)) ? Number(row.realizedPnl) : Number(row.pnl),
      closedAtMs: Number(row.closedAtMs ?? row.atMs),
    }));
}

function quoteTokenFor(chain, token, env) {
  const shared = typeof env?.LIVE_GMGN_QUOTE_TOKEN === "string" ? env.LIVE_GMGN_QUOTE_TOKEN.trim() : "";
  const candidate = token?.quoteToken || (addressOk(chain, shared) ? shared : "") || NARRATIVE_LIVE_DEFAULT_QUOTES[chain];
  return addressOk(chain, candidate) ? (chain === "sol" ? candidate : candidate.toLowerCase()) : null;
}

function amountFor(token, chain, sizeUsd) {
  if (isTradeBotRawAmount(token?.amountRaw)) return token.amountRaw;
  const native = !token?.quoteToken || String(token.quoteToken).toLowerCase() === NARRATIVE_LIVE_DEFAULT_QUOTES[chain];
  const decimals = Number.isInteger(token?.quoteDecimals) ? token.quoteDecimals : (native ? (chain === "sol" ? 9 : 18) : null);
  if (decimals === null) return null;
  return usdToRawAmount(sizeUsd, token?.quoteUsd, decimals);
}

export function buildNarrativeGmgnBuyPlan({
  chain, wallet, inputToken, outputToken, amountRaw, slippagePercent, env = process.env,
} = {}) {
  const name = String(chain || "").toLowerCase();
  const errors = [];
  if (name !== "bsc" && name !== "sol") errors.push("unsupported_chain");
  if (!addressOk(name, wallet)) errors.push("missing_wallet");
  if (!addressOk(name, inputToken)) errors.push("missing_quote_token");
  if (!addressOk(name, outputToken)) errors.push("missing_base_token");
  if (addressOk(name, inputToken) && addressOk(name, outputToken) && String(inputToken).toLowerCase() === String(outputToken).toLowerCase()) {
    errors.push("quote_is_base");
  }
  if (!isTradeBotRawAmount(amountRaw)) errors.push("invalid_amount");
  if (!Number.isInteger(slippagePercent) || slippagePercent < 1 || slippagePercent > 20) errors.push("invalid_slippage");
  const gasLevel = narrativeLiveGasLevel(env);
  const tier = NARRATIVE_LIVE_GAS_TIERS[gasLevel];
  let feeArgs = [];
  let priorityFee = null;
  let tipFee = null;
  let gasPrice = null;
  if (name === "sol") {
    priorityFee = String(tier.solPriorityFee);
    tipFee = String(tier.solTipFee);
    feeArgs = ["--priority-fee", priorityFee, "--tip-fee", tipFee];
  } else if (name === "bsc") {
    gasPrice = String(tier.bscGasGwei);
    feeArgs = ["--gas-price", gasPrice];
    if (tier.bscTipFee != null) {
      tipFee = String(tier.bscTipFee);
      feeArgs.push("--tip-fee", tipFee);
    }
  }
  return {
    errors,
    binary: "gmgn-cli",
    gasLevel,
    args: [
      "swap", "--chain", name, "--from", wallet || "",
      "--input-token", inputToken || "", "--output-token", outputToken || "",
      "--amount", amountRaw || "", "--slippage", String(slippagePercent ?? ""),
      "--anti-mev", ...feeArgs, "--raw",
    ],
    slippagePercent: slippagePercent ?? null,
    priorityFee,
    tipFee,
    gasPrice,
  };
}

function refuse(base, gate, reason) {
  return { allow: false, gate, reason, plan: null, decision: { ...base, kind: "narrative_live_refused", ok: false, submitted: false, gate, reason } };
}

function positionOpen(account, chain, address) {
  const positions = account?.positions;
  if (!positions || typeof positions !== "object") return false;
  const key = narrativeTokenKey(chain, address);
  return Object.values(positions).some((position) => narrativeTokenKey(position?.chain, position?.address) === key);
}

export function evaluateNarrativeLiveEntry({
  hotspot, token = {}, matchedKeywords = [], nowMs = Date.now(), env = process.env,
  priorBuys = [], closedTrades = [], dev = null, account = null, enabled = true, trades = null,
} = {}) {
  const config = narrativeLiveConfig(env);
  const chain = String(token.chain || "").toLowerCase();
  const address = chain === "sol" ? String(token.address || "").trim() : String(token.address || "").trim().toLowerCase();
  const lagMs = Number(token.launchedAt) - Number(hotspot?.publishedAt);
  const wallet = typeof env?.LIVE_GMGN_WALLET === "string" ? env.LIVE_GMGN_WALLET.trim() : "";
  const book = account && typeof account === "object" ? account : null;
  const ticket = sharedTicket(book, token, config.sizeUsd);
  const sessionTrades = book?.trades ?? trades;
  const sessionPresent = book != null || trades != null;
  const liveGate = checkGates({
    closedTrades, trades: sessionTrades, sessionPresent, nowMs, env,
    dailyLoss: sharedDailyLoss(book, nowMs),
  });
  const base = {
    atMs: nowMs,
    chain,
    address,
    symbol: token.symbol || null,
    name: token.name || null,
    hotspotId: hotspot?.id || null,
    sourceUrl: hotspot?.url || null,
    author: hotspot?.author || null,
    hook: hotspot?.hook || null,
    prioritySource: hotspot?.priority === true,
    keywords: matchedKeywords,
    lagSeconds: Number.isFinite(lagMs) ? Math.max(0, Math.round(lagMs / 1000)) : null,
    creator: token.creator || null,
    sizeUsd: ticket.sizeUsd || config.sizeUsd,
    windowMs: config.windowMs,
    signal: "hot_narrative",
    fastDev: dev?.knownFast === true ? {
      wallet: dev.wallet, rank: dev.rank, count: dev.count, medianLagSeconds: dev.medianLagSeconds,
    } : null,
    rugDev: dev?.rug === true,
  };
  if ([config.windowMs, config.fastDevMinLaunches, config.fastDevMaxMedianSeconds].some((value) => value == null)) {
    return refuse(base, "config", "热点窗口或快开发阈值超出允许范围");
  }
  if (config.priorityOnly && hotspot?.priority !== true) return refuse(base, "priority_source", "当前只允许何一或 CZ 的帖子、引用和回复触发 LIVE");
  if (!matchedKeywords.length) return refuse(base, "match", "代币名称未命中热点关键词");
  if (!Number.isFinite(nowMs) || !Number.isFinite(Number(hotspot?.publishedAt)) || !Number.isFinite(Number(token.launchedAt))) {
    return refuse(base, "window", "热点或发射时间无效");
  }
  if (lagMs < 0 || lagMs > config.windowMs || nowMs - hotspot.publishedAt > config.windowMs || nowMs - token.launchedAt > config.windowMs) {
    return refuse(base, "window", `超出热点后 ${Math.round(config.windowMs / 1000)} 秒窗口`);
  }
  const security = narrativeLiveSecurityDecision(token);
  if (!security.allow) return refuse(base, security.gate, security.reason);
  if (config.blockRugDevs && dev?.rug === true) return refuse(base, "rug_dev", "创建者在已知跑路开发钱包名单中");
  const buys = latestBuyByToken(priorBuys);
  if (buys.some((row) => narrativeTokenKey(row.chain, row.address) === narrativeTokenKey(chain, address)) || positionOpen(book, chain, address)) {
    return refuse(base, "dedupe", "同一代币已有 LIVE 买入或持仓，拒绝重复下单");
  }
  if (enabled === false) return refuse(base, "enabled", "策略引擎已暂停新开仓，热点信号不单独放行");
  if (!liveGate.allow) return refuse(base, liveGate.gate, liveGate.reason);
  if (!(ticket.sizeUsd > 0)) return refuse(base, "sizing", "余额或流动性额度不够固定 10 U，沿用现有仓位规则拒绝开仓");
  if (config.requireFastDev && dev?.knownFast !== true) return refuse(base, "fast_dev", "未由已知快开发钱包发射");
  if (chain !== "bsc" && chain !== "sol") return refuse(base, "unsupported_chain", "叙事 LIVE 目前只下 BSC 与 SOL");
  if (!addressOk(chain, address)) return refuse(base, "token", "代币地址无效");
  const quoteToken = quoteTokenFor(chain, token, env);
  if (!quoteToken) return refuse(base, "quote", "缺少可用的报价代币");
  if (!addressOk(chain, wallet)) return refuse(base, "wallet", "缺少 LIVE_GMGN_WALLET");
  const amountRaw = amountFor(token, chain, ticket.sizeUsd);
  if (!amountRaw) return refuse(base, "amount", "无法把下单金额换算成报价代币数量");
  const plan = buildNarrativeGmgnBuyPlan({
    chain, wallet, inputToken: quoteToken, outputToken: address, amountRaw, slippagePercent: BUY_SLIPPAGE_PERCENT, env,
  });
  if (plan.errors.length) return refuse(base, "plan", plan.errors[0]);
  const entryPrice = Number(token.entryPrice ?? token.price);
  const liveLadder = createLiveLadder({
    entryPrice, chain, baseToken: address, quoteToken, wallet,
  });
  const decision = {
    ...base,
    kind: "narrative_live_buy",
    ok: false,
    submitted: false,
    gate: null,
    reason: null,
    sizeUsd: ticket.sizeUsd,
    quoteToken,
    amountRaw,
    wallet,
    slippagePercent: BUY_SLIPPAGE_PERCENT,
    gasLevel: plan.gasLevel,
    gasPrice: plan.gasPrice,
    priorityFee: plan.priorityFee,
    tipFee: plan.tipFee,
    liveLadder,
    consecutiveLosses: liveGate.consecutive?.streak ?? null,
    paperClosed: liveGate.promotion?.closed ?? null,
    paperSqn: liveGate.promotion?.sqn ?? null,
  };
  return { allow: true, gate: null, reason: null, plan, decision };
}

function parseBuy(result) {
  const stdout = typeof result?.stdout === "string" ? result.stdout : "";
  let body = null;
  try { body = JSON.parse(stdout); } catch { body = null; }
  const exitCode = Number(result?.exitCode);
  if (!body || !Number.isInteger(exitCode)) return { ok: false, error: "gmgn_invalid_json", orderId: null };
  const data = body.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : body;
  const orderId = typeof data.order_id === "string" ? data.order_id : null;
  const codeOk = body.code === undefined || body.code === 0 || body.code === "0";
  if (exitCode !== 0 || !codeOk) {
    const message = typeof body.msg === "string" ? body.msg : (typeof body.error === "string" ? body.error : "gmgn_rejected");
    return { ok: false, error: message.slice(0, 200), orderId };
  }
  return { ok: true, orderId, error: null };
}

export function createNarrativeGmgnBuyClient({ env = process.env, execFile = execFileSync } = {}) {
  return {
    run(args) {
      const bin = env.GMGN_CLI_PATH || "gmgn-cli";
      try {
        const stdout = execFile(bin, args, { encoding: "utf8", timeout: 20_000, env, stdio: ["ignore", "pipe", "pipe"], shell: false });
        return { exitCode: 0, stdout: String(stdout || ""), stderr: "" };
      } catch (error) {
        return {
          exitCode: Number.isInteger(error?.status) ? error.status : 1,
          stdout: String(error?.stdout || ""),
          stderr: String(error?.stderr || error?.message || "gmgn_cli_unavailable").slice(0, 300),
        };
      }
    },
  };
}

export async function readLiveDecisions(file, fsImpl = fs) {
  try {
    const raw = await fsImpl.readFile(file, "utf8");
    if (raw.length > 4_000_000) throw new Error("live decision log is too large");
    const rows = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const row = JSON.parse(line);
        if (row && typeof row === "object") rows.push(row);
      } catch {
        // Skip a torn line.
      }
    }
    return rows;
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function appendDecision(file, decision, fsImpl) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  await fsImpl.appendFile(file, `${JSON.stringify(decision)}\n`, { encoding: "utf8", mode: 0o600 });
}

function instantMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeChain(value) {
  const text = String(value ?? "").toLowerCase();
  if (text === "56" || text === "bsc" || text === "bnb") return "bsc";
  if (text === "sol" || text === "solana" || text === "501") return "sol";
  if (text === "eth" || text === "1" || text === "ethereum") return "eth";
  if (text === "base" || text === "8453") return "base";
  return null;
}

export function launchFromAlert(event) {
  if (!event || typeof event !== "object") return null;
  const type = String(event.type || "");
  const kind = String(event.kind || "");
  const launchish = LAUNCH_TYPES.has(type) || LAUNCH_TYPES.has(kind) || /token_created|pool_launch|pump_create/u.test(`${type}:${kind}`);
  if (!launchish) return null;
  const token = (Array.isArray(event.tokens) ? event.tokens[0] : null) || event.token || {};
  const chain = normalizeChain(event.chain || token.chain || event.chainId);
  const address = token.token || token.address || event.ca || event.address || null;
  const name = token.name || token.metadata?.name || event.name || "";
  const symbol = token.symbol || token.metadata?.symbol || event.symbol || "";
  if (!chain || !address || (!name && !symbol)) return null;
  const launchedAt = instantMs(event.launchedAt ?? event.blockTimestamp ?? token.creationTimestamp ?? event.timestamp ?? event.observedAt);
  if (launchedAt === null) return null;
  const creator = event.creator || event.devWallet || event.dev || token.creator || token.dev || event.deployer || null;
  return {
    chain,
    address: String(address),
    name: String(name || ""),
    symbol: String(symbol || ""),
    creator: creator ? String(creator) : null,
    launchedAt,
    buyTax: token.buyTax ?? event.buyTax,
    sellTax: token.sellTax ?? event.sellTax,
    buyTaxBps: token.buyTaxBps ?? event.buyTaxBps,
    sellTaxBps: token.sellTaxBps ?? event.sellTaxBps,
    isHoneypot: token.isHoneypot ?? event.isHoneypot,
    honeypot: token.honeypot ?? event.honeypot,
    cannotSell: token.cannotSell ?? event.cannotSell,
    sellable: token.sellable ?? event.sellable,
    isBlacklisted: token.isBlacklisted ?? event.isBlacklisted,
    canMint: token.canMint ?? event.canMint,
    canFreeze: token.canFreeze ?? event.canFreeze,
    canPause: token.canPause ?? event.canPause,
    riskLevel: token.riskLevel ?? event.riskLevel,
    highRisk: token.highRisk ?? event.highRisk,
    securityDecision: token.securityDecision ?? event.securityDecision ?? token.goPlusDecision ?? event.goPlusDecision,
    goPlusDecision: token.goPlusDecision ?? event.goPlusDecision,
    quoteToken: token.quoteToken || token.quoteAddress || event.quoteToken || null,
    quoteUsd: token.quoteUsd ?? event.quoteUsd,
    quoteDecimals: token.quoteDecimals ?? event.quoteDecimals,
    entryPrice: token.price ?? token.entryPrice ?? event.price ?? null,
    amountRaw: token.amountRaw || event.amountRaw || null,
  };
}

function devView(registry, token, config, env) {
  const signal = fastDevSignal(registry, {
    chain: token.chain,
    wallet: token.creator,
    minLaunches: config.fastDevMinLaunches ?? 2,
    maxMedianSeconds: config.fastDevMaxMedianSeconds ?? 180,
  });
  const rug = isRugDev(registry, { chain: token.chain, wallet: token.creator }, env);
  if (rug) return { ...signal, knownFast: false, rug: true, rank: null };
  return { ...signal, rug: false };
}

export function createNarrativeLiveRuntime({
  dataDir, env = process.env, now = Date.now, fs: fsImpl = fs, buyClient = null, stopClient = null,
} = {}) {
  if (!dataDir) throw new TypeError("dataDir is required");
  const hotspots = createHotNarrativeStore({ dataDir, fs: fsImpl, now });
  const devs = createFastDevStore({ dataDir, fs: fsImpl });
  const decisionFile = path.join(dataDir, NARRATIVE_LIVE_DECISION_FILE);
  let queue = Promise.resolve();
  let stopped = false;
  const enqueue = (fn) => {
    const run = queue.then(fn, fn);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  async function place(verdict) {
    const pending = { ...verdict.decision, kind: "narrative_live_buy", ok: false, submitted: true, stage: "submitting" };
    await appendDecision(decisionFile, pending, fsImpl);
    const client = buyClient || createNarrativeGmgnBuyClient({ env });
    let result;
    try { result = parseBuy(client.run(verdict.plan.args)); }
    catch (error) { result = { ok: false, error: "gmgn_buy_threw", orderId: null, detail: String(error?.message || error).slice(0, 200) }; }
    let stop = null;
    if (result.ok && verdict.decision.liveLadder?.entryPrice && gmgnAmendEnabled(env)) {
      const stopPlan = buildGmgnStopReplacePlan({
        chain: verdict.decision.chain,
        wallet: verdict.decision.wallet,
        baseToken: verdict.decision.address,
        quoteToken: verdict.decision.quoteToken,
        entryPrice: verdict.decision.liveLadder.entryPrice,
        stopPriceScale: verdict.decision.liveLadder.stopPriceScale,
        previousOrderId: null,
        env,
      });
      const runner = stopClient?.run ? stopClient.run.bind(stopClient) : createGmgnCliStopClient({ env }).run;
      try { stop = runGmgnStopAmend(stopPlan, runner); }
      catch (error) { stop = { ok: false, error: "gmgn_stop_threw", orderId: null, detail: String(error?.message || error).slice(0, 200) }; }
    }
    const finalDecision = {
      ...verdict.decision,
      kind: "narrative_live_buy",
      ok: result.ok === true,
      submitted: true,
      stage: "result",
      orderId: result.orderId || null,
      error: result.ok ? null : (result.error || "gmgn_rejected"),
      stop: stop ? { ok: stop.ok === true, error: stop.ok ? null : (stop.error || "gmgn_stop_failed"), orderId: stop.orderId || null } : null,
    };
    await appendDecision(decisionFile, finalDecision, fsImpl);
    return { ...verdict, allow: result.ok === true, decision: finalDecision };
  }

  async function consider(token, hotspot, matchedKeywords) {
    const config = narrativeLiveConfig(env);
    if (token?.creator && Number.isFinite(Number(token.launchedAt)) && Number.isFinite(Number(hotspot?.publishedAt))) {
      const lagSeconds = Math.round((Number(token.launchedAt) - Number(hotspot.publishedAt)) / 1000);
      await devs.update((registry) => recordLaunch(registry, token, hotspot, lagSeconds));
    }
    const decisions = await readLiveDecisions(decisionFile, fsImpl);
    const registry = await devs.load();
    const book = await loadPaperBook(dataDir, fsImpl);
    const verdict = evaluateNarrativeLiveEntry({
      hotspot, token, matchedKeywords, nowMs: now(), env,
      priorBuys: decisions.filter((row) => row.kind === "narrative_live_buy"),
      closedTrades: [...paperLiveClosedTrades(book.account), ...narrativeLiveClosedTrades(decisions)],
      dev: devView(registry, token, config, env),
      account: book.account,
      enabled: book.enabled,
    });
    if (!verdict.allow) {
      await appendDecision(decisionFile, verdict.decision, fsImpl);
      return verdict;
    }
    return place(verdict);
  }

  async function handleLaunch(launch) {
    if (stopped) return { status: "stopped" };
    await hotspots.load();
    const config = narrativeLiveConfig(env);
    const hit = hotspots.findMatch(launch, now(), config.windowMs ?? 600_000);
    if (!hit) return { status: "unmatched" };
    const chain = String(launch.chain || "").toLowerCase();
    const address = chain === "sol" ? String(launch.address || "") : String(launch.address || "").toLowerCase();
    await hotspots.recordMatch({
      hotspotId: hit.hotspot.id,
      chain,
      address,
      symbol: launch.symbol || null,
      name: launch.name || null,
      creator: normalizeDevWallet(chain, launch.creator),
      launchedAt: launch.launchedAt,
      lagSeconds: Math.max(0, Math.round((Number(launch.launchedAt) - hit.hotspot.publishedAt) / 1000)),
      keywords: hit.keywords,
      atMs: now(),
    });
    const result = await consider({ ...launch, chain, address }, hit.hotspot, hit.keywords);
    return { status: result.allow ? "bought" : "refused", ...result };
  }

  return {
    observePost(post) {
      return enqueue(async () => {
        if (stopped) return { status: "stopped" };
        return hotspots.recordPost(post);
      });
    },
    observeLaunch(launch) {
      return enqueue(() => handleLaunch(launch));
    },
    observeEvent(event) {
      return enqueue(async () => {
        const launch = launchFromAlert(event);
        if (!launch) return { status: "ignored" };
        return handleLaunch(launch);
      });
    },
    recordClose(entry) {
      return enqueue(async () => {
        const decision = {
          kind: "narrative_live_close",
          atMs: now(),
          ok: true,
          chain: entry?.chain || null,
          address: entry?.address || null,
          realizedPnl: Number(entry?.realizedPnl),
          closedAtMs: Number(entry?.closedAtMs ?? now()),
        };
        await appendDecision(decisionFile, decision, fsImpl);
        return decision;
      });
    },
    snapshot() {
      return enqueue(async () => {
        const [hot, registry, decisions] = await Promise.all([
          hotspots.snapshot(),
          devs.load(),
          readLiveDecisions(decisionFile, fsImpl),
        ]);
        return { hotspots: hot, registry, decisions };
      });
    },
    stop() {
      stopped = true;
      return queue;
    },
    decisionFile,
  };
}

function recordLaunch(registry, token, hotspot, lagSeconds) {
  return recordFastDevLaunch(registry, {
    chain: token.chain,
    wallet: token.creator,
    address: token.address,
    hotspotId: hotspot.id,
    lagSeconds,
    atMs: token.launchedAt,
  });
}

export async function readFastDevDashboard(dataDir, env = process.env) {
  const store = createFastDevStore({ dataDir });
  let registry = { version: 1, wallets: {} };
  try { registry = await store.load(); } catch { registry = { version: 1, wallets: {} }; }
  const config = narrativeLiveConfig(env);
  const minLaunches = config.fastDevMinLaunches ?? 2;
  const maxMedianSeconds = config.fastDevMaxMedianSeconds ?? 180;
  return {
    version: 1,
    execution: false,
    signing: false,
    broadcast: false,
    minLaunches,
    maxMedianSeconds,
    ranked: rankFastDevs(registry, { minLaunches, maxMedianSeconds }).slice(0, 50),
    rugs: listRugDevs(registry).slice(0, 20),
  };
}

export async function readHotNarrativeDashboard(dataDir) {
  const store = createHotNarrativeStore({ dataDir });
  let snapshot = { version: 1, hotspots: [] };
  try { snapshot = await store.snapshot(); } catch { snapshot = { version: 1, hotspots: [] }; }
  const hotspots = [...snapshot.hotspots].sort((left, right) => right.publishedAt - left.publishedAt).slice(0, 30).map((hotspot) => ({
    id: hotspot.id,
    author: hotspot.author,
    url: hotspot.url,
    text: String(hotspot.text || "").slice(0, 280),
    keywords: (hotspot.keywords || []).map((item) => (typeof item === "string" ? item : item.text)),
    linkedKeyword: hotspot.linkedKeyword || null,
    publishedAt: hotspot.publishedAt,
    hook: hotspot.hook,
    priority: hotspot.priority === true,
    matches: (hotspot.matches || []).slice(-10).map((match) => ({
      chain: match.chain,
      address: match.address,
      symbol: match.symbol || null,
      name: match.name || null,
      creator: match.creator || null,
      lagSeconds: match.lagSeconds,
    })),
  }));
  return { version: 1, execution: false, signing: false, broadcast: false, hotspots };
}
