import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import { BSC_NATIVE_BNB, BSC_USDT, buildConditionOrders, chainCfg, checkGates as checkOrderGates, checkLiveEvidence, preSubmitQuote, readLedger } from "./live-gmgn-trader.js";
import { checkGates as checkEntryGates } from "./live-entry-gates.js";
import { closedPaperRounds } from "./paper-sqn.js";

export const LIVE_APPROVAL_TTL_MS = 15_000;
export const LIVE_APPROVAL_CONFIRMATION = "I_CONFIRM_THIS_TRADE";
// The current paper strategy publishes an eligible entry as "可模拟"; that is
// the strategy's positive signal consumed by the manual live approval route.
const BUY_DECISIONS = new Set(["可模拟", "买入", "买"]);
const EVM = /^0x[0-9a-fA-F]{40}$/;
const execFileAsync = promisify(execFile);

export function createGmgnManualClient({ env = process.env, binary = env.GMGN_CLI_PATH || "gmgn-cli", exec = execFileAsync } = {}) {
  async function run(args) {
    try {
      const { stdout } = await exec(binary, args, { encoding: "utf8", timeout: 20_000, maxBuffer: 1_000_000, shell: false, env });
      let raw = null;
      try { raw = JSON.parse(String(stdout || "")); } catch {}
      return { raw };
    } catch {
      // Never forward CLI stderr/stdout: either may contain sensitive auth diagnostics.
      throw new Error("GMGN CLI 命令失败");
    }
  }
  return {
    run,
    async configCheck() {
      await run(["config", "--check"]);
      return true;
    },
  };
}

function timestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1000 : value;
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function addressKey(chain, address) {
  const value = String(address ?? "").trim();
  return chain === "sol" ? value : value.toLowerCase();
}

export function strategyCandidateId(evaluation = {}) {
  const token = evaluation.token || {};
  const chain = String(token.chain || evaluation.chain || "").toLowerCase();
  const address = addressKey(chain, token.address || evaluation.address);
  const at = timestamp(evaluation.at || evaluation.observedAt || token.observedAt);
  const strategy = String(evaluation.strategyId || evaluation.label || "");
  if (!chain || !address || at === null || !strategy) return null;
  return createHash("sha256").update(`${chain}:${address}:${at}:${strategy}`).digest("hex").slice(0, 24);
}

function selectedCandidate(strategy, candidateId, nowMs, cfg) {
  const evaluations = Array.isArray(strategy?.evaluations) ? strategy.evaluations : [];
  const evaluation = evaluations.find((row) => strategyCandidateId(row) === candidateId);
  if (!evaluation) return { ok: false, reason: "策略候选已变化或已过期，请刷新" };
  if (!BUY_DECISIONS.has(String(evaluation.decision || ""))) return { ok: false, reason: "当前策略没有给出买入结论" };
  const token = evaluation.token || {};
  const chain = String(token.chain || evaluation.chain || "").toLowerCase();
  const address = addressKey(chain, token.address || evaluation.address);
  if (chain !== "bsc" || !EVM.test(address)) return { ok: false, reason: "逐笔确认入口目前仅支持 BSC EVM 候选" };
  const signalAt = timestamp(evaluation.at || evaluation.observedAt || token.observedAt);
  if (signalAt === null || nowMs < signalAt || nowMs - signalAt > (cfg.maxSignalAgeMs ?? 90_000)) {
    return { ok: false, reason: "策略信号时间无效或已过期" };
  }
  const usd = Number(evaluation.entryUsd);
  if (!(usd > 0) || !Number.isFinite(usd)) return { ok: false, reason: "策略未提供有效的单笔计划金额" };
  const strategyId = String(evaluation.strategyId || evaluation.label || "");
  if (!strategyId) return { ok: false, reason: "策略 ID 缺失" };
  if (!evaluation.evidence || typeof evaluation.evidence !== "object") return { ok: false, reason: "缺少策略安全证据" };
  return {
    ok: true,
    evaluation,
    order: {
      source: cfg.signalSource,
      strategyId,
      paperStrategyId: strategyId,
      paperStrategyLabel: evaluation.label || strategyId,
      paperSessionId: strategy?.session?.id || null,
      paperTradeId: null,
      signalAt,
      token: address,
      chain,
      usd,
      paperPrice: Number(token.price ?? evaluation.price) || null,
      entryEvidence: evaluation.evidence,
    },
  };
}

function securitySummary(response) {
  const root = response?.raw && typeof response.raw === "object" ? response.raw : response;
  const data = root?.data && typeof root.data === "object" ? root.data : root;
  const honeypot = String(data?.is_honeypot ?? "").trim().toLowerCase();
  const rawRugRatio = data?.rug_ratio;
  if (!(["number", "string"].includes(typeof rawRugRatio)) || String(rawRugRatio).trim() === "") {
    return { ok: false, reason: "GMGN rug_ratio 缺失，拒绝提交" };
  }
  const rugRatio = Number(rawRugRatio);
  if (!["no", "false", "0"].includes(honeypot)) return { ok: false, reason: "GMGN 未明确证明 is_honeypot=false" };
  if (!Number.isFinite(rugRatio) || rugRatio < 0 || rugRatio > 0.3) return { ok: false, reason: "GMGN rug_ratio 缺失或高于 0.3；拒绝提交" };
  return { ok: true, isHoneypot: false, rugRatio };
}

function slippageLabel(value) {
  const match = /^auto(?::(.+))?$/.exec(String(value || ""));
  if (match) return match[1] ? `GMGN 自动滑点（报价 ${match[1]}%）` : "GMGN 自动滑点（按报价执行）";
  return `${value}%（固定）`;
}

function freshReadiness(live) {
  if (!live || live.enabled !== true || live.killed === true) return { ok: false, reason: live?.killed ? "急停文件存在" : "实盘总开关未启用" };
  if (live.observations?.bnb?.status !== "fresh" || live.observations?.bnbPriceUsd?.status !== "fresh") {
    return { ok: false, reason: "BNB 余额或价格观察缺失/过期" };
  }
  if (live.spendAsset === "usdt" && live.observations?.spendBalance?.status !== "fresh") return { ok: false, reason: "USDT 余额观察缺失/过期" };
  if (![live.bnb, live.bnbPriceUsd, live.balanceUsd].every((value) => Number.isFinite(Number(value)))) {
    return { ok: false, reason: "实盘余额或 BNB 价格不可用" };
  }
  return { ok: true };
}

function liveState(live) {
  return {
    balanceBnb: Number(live.bnb),
    balanceUsd: Number(live.balanceUsd),
  };
}

/**
 * Strategy-driven, user-confirmed BSC entry flow. Signals only create candidates;
 * no order is sent until the explicit dashboard confirmation token is supplied.
 */
export function createLiveManualApproval({
  cfg,
  trader,
  strategyProvider,
  readinessProvider,
  gmgn,
  env = process.env,
  fsx = fs,
  readLedgerImpl = readLedger,
  audit = () => {},
  now = Date.now,
  monotonicNow = () => performance.now(),
  id = randomUUID,
} = {}) {
  if (!cfg || !trader || typeof strategyProvider !== "function" || typeof readinessProvider !== "function" || !gmgn) {
    throw new TypeError("cfg, trader, strategyProvider, readinessProvider, gmgn are required");
  }
  const prepared = new Map();
  const preparedByCandidate = new Map();
  const consumedCandidates = new Set();
  const rememberConsumed = (candidateId) => {
    consumedCandidates.add(candidateId);
    while (consumedCandidates.size > 1000) consumedCandidates.delete(consumedCandidates.values().next().value);
  };

  function status() {
    if (cfg.enabled !== true) return { ready: false, reason: "实盘总开关关闭" };
    if (fsx.existsSync(cfg.killFile)) return { ready: false, reason: "急停文件存在；不会自动解除" };
    if (cfg.preSubmitQuote === false) return { ready: false, reason: "提交前报价校验已关闭，逐笔确认不可用" };
    if (!(cfg.chains || [cfg.chain]).includes("bsc")) return { ready: false, reason: "当前实盘范围未启用 BSC" };
    if (!EVM.test(cfg.wallet || "") || !["bnb", "usdt"].includes(cfg.spendAsset)) return { ready: false, reason: "BSC 钱包或花费资产配置无效" };
    return { ready: true, reason: "需逐笔安全检查与人工确认" };
  }

  async function resolveCandidate(candidateId) {
    const strategy = await strategyProvider();
    const selected = selectedCandidate(strategy, candidateId, now(), cfg);
    if (!selected.ok) return selected;
    const ev = selected.evaluation;
    const promotion = checkEntryGates({
      closedTrades: closedPaperRounds(strategy?.account?.trades || []),
      trades: Array.isArray(strategy?.account?.trades) ? strategy.account.trades : null,
      sessionPresent: Boolean(strategy?.session?.id),
      nowMs: now(),
      env,
    });
    if (!promotion.allow) return { ok: false, reason: `策略晋级门控：${promotion.reason || "未通过"}` };
    const evidence = checkLiveEvidence(cfg, ev.evidence, { now: now() });
    if (!evidence.ok) return { ok: false, reason: `实盘安全证据门控：${evidence.reason}` };
    return { ...selected, strategy };
  }

  async function readinessAndGates(order) {
    if (!(cfg.chains || [cfg.chain]).includes("bsc")) return { ok: false, reason: "LIVE 配置未启用 BSC" };
    if (!cfg.wallet || !EVM.test(cfg.wallet) || !["bnb", "usdt"].includes(cfg.spendAsset)) return { ok: false, reason: "BSC 钱包或花费资产配置无效" };
    const readiness = await readinessProvider();
    const live = readiness?.live || readiness;
    const fresh = freshReadiness(live);
    if (!fresh.ok) return { ok: false, reason: fresh.reason };
    // Reconcile before the preview gate so exited GMGN condition orders can
    // release their existing reservations and realized PnL reaches the loss cap.
    // The caller's config check must succeed before any business CLI calls.
    try {
      await gmgn.configCheck();
      await trader.reconcile?.();
      await trader.syncClosed?.();
    } catch {
      return { ok: false, reason: "GMGN 对账/退出同步失败，拒绝新单" };
    }
    let ledger;
    try { ledger = readLedgerImpl(cfg.ledgerPath, fsx); }
    catch { return { ok: false, reason: "实盘账本不可读，拒绝新单" }; }
    if (order.manualCandidateId && ledger.positions.some((position) => position.manualCandidateId === order.manualCandidateId)) {
      return { ok: false, reason: "此策略信号已有实盘提交记录，拒绝重复确认" };
    }
    if (ledger.positions.some((position) =>
      position && position.status && ["submitting", "pending", "uncertain", "open"].includes(position.status)
      && String(position.chain || "").toLowerCase() === "bsc"
      && String(position.token || "").toLowerCase() === String(order.token).toLowerCase())) {
      return { ok: false, reason: "该 BSC 代币已有未平仓实盘仓位，拒绝重复加仓" };
    }
    const chainConfig = chainCfg(cfg, "bsc");
    const gate = checkOrderGates(chainConfig, { ...order, bnbPriceUsd: Number(live.bnbPriceUsd) }, {
      ...ledger,
      ...liveState(live),
    }, { now: now(), fsx });
    if (!gate.ok) return { ok: false, reason: gate.reason };
    return { ok: true, live, extraState: { ...liveState(live), bnbPriceUsd: Number(live.bnbPriceUsd) }, chainConfig };
  }

  async function checkSecurity(chain, address) {
    await gmgn.configCheck();
    const result = await gmgn.run(["token", "security", "--chain", chain, "--address", address, "--raw"]);
    return securitySummary(result);
  }

  async function listCandidates() {
    const strategy = await strategyProvider();
    const rows = Array.isArray(strategy?.evaluations) ? strategy.evaluations : [];
    const seen = new Set();
    return rows.filter((row) => BUY_DECISIONS.has(String(row?.decision || ""))).map((row) => {
      const id = strategyCandidateId(row);
      if (!id || seen.has(id)) return null;
      seen.add(id);
      return {
        id,
        chain: String(row.token?.chain || row.chain || "").toLowerCase(),
        address: addressKey(String(row.token?.chain || row.chain || "").toLowerCase(), row.token?.address || row.address),
        symbol: row.token?.symbol || row.symbol || null,
        strategy: row.label || row.strategyId || null,
        score: Number.isFinite(Number(row.score)) ? Number(row.score) : null,
        amountUsd: Number.isFinite(Number(row.entryUsd)) ? Number(row.entryUsd) : null,
        at: timestamp(row.at || row.observedAt || row.token?.observedAt),
        reasons: Array.isArray(row.reasons) ? row.reasons.slice(0, 4).map((reason) => String(reason).slice(0, 120)) : [],
      };
    }).filter((row) => row && row.chain === "bsc").slice(0, 20);
  }

  async function prepare(candidateId) {
    if (typeof candidateId !== "string" || !/^[a-f0-9]{24}$/.test(candidateId)) return { ok: false, reason: "候选 ID 无效" };
    if (cfg.preSubmitQuote === false) return { ok: false, reason: "实盘提交前报价校验已关闭，拒绝创建确认单" };
    if (consumedCandidates.has(candidateId)) return { ok: false, reason: "此策略信号已提交过一次，拒绝重复确认" };
    const selected = await resolveCandidate(candidateId);
    if (!selected.ok) return selected;
    const readiness = await readinessAndGates(selected.order);
    if (!readiness.ok) return readiness;
    const security = await checkSecurity("bsc", selected.order.token);
    if (!security.ok) return security;
    let quote;
    try {
      await gmgn.configCheck();
      quote = await preSubmitQuote(readiness.chainConfig, { ...selected.order, bnbPriceUsd: readiness.extraState.bnbPriceUsd }, { run: gmgn.run });
    }
    catch { return { ok: false, reason: "GMGN 报价失败，未创建确认单" }; }
    if (!quote.ok || !quote.quote?.inputAmount || !quote.quote?.outputAmount || !quote.quote?.minOutputAmount || quote.quote?.slippage == null) {
      return { ok: false, reason: quote.reason || "GMGN 报价字段不完整，拒绝创建确认单" };
    }
    const approvalId = id();
    const expiresAt = now() + LIVE_APPROVAL_TTL_MS;
    const expiresAtMonotonic = monotonicNow() + LIVE_APPROVAL_TTL_MS;
    const order = { ...selected.order, manualCandidateId: candidateId, bnbPriceUsd: readiness.extraState.bnbPriceUsd, approvedQuote: quote.quote, manualApprovalId: approvalId };
    const previous = preparedByCandidate.get(candidateId);
    if (previous) prepared.delete(previous);
    for (const [key, value] of prepared) if (value.expiresAtMonotonic <= monotonicNow()) {
      prepared.delete(key);
      if (preparedByCandidate.get(value.candidateId) === key) preparedByCandidate.delete(value.candidateId);
    }
    if (prepared.size >= 20) return { ok: false, reason: "待确认单过多，请先取消或等待过期" };
    prepared.set(approvalId, { candidateId, order, quote: quote.quote, expiresAt, expiresAtMonotonic, createdAt: now() });
    preparedByCandidate.set(candidateId, approvalId);
    return {
      ok: true,
      approval: {
        id: approvalId,
        expiresAt,
        chain: "bsc",
        wallet: cfg.wallet,
        symbol: selected.evaluation.token?.symbol || selected.evaluation.symbol || "未知代币",
        strategyId: selected.order.strategyId,
        signalAt: selected.order.signalAt,
        address: selected.order.token,
        inputToken: cfg.spendAsset === "bnb" ? BSC_NATIVE_BNB : BSC_USDT,
        spendAsset: cfg.spendAsset,
        amountUsd: selected.order.usd,
        slippage: slippageLabel(quote.quote.slippage),
        inputAmount: quote.quote.inputAmount,
        outputAmount: quote.quote.outputAmount,
        minOutputAmount: quote.quote.minOutputAmount,
        gasPriceGwei: readiness.chainConfig.gasPriceGwei,
        gasReserveBnb: readiness.chainConfig.gasReserveBnb,
        antiMev: readiness.chainConfig.antiMev === true,
        security: { isHoneypot: security.isHoneypot, rugRatio: security.rugRatio },
        conditionOrders: buildConditionOrders(readiness.chainConfig),
        warning: "预览仅代表报价时点；确认后若报价变化将拒绝提交并要求重新预览。止盈止损参数沿用当前 LIVE 配置。",
      },
    };
  }

  async function confirm(approvalId, confirmation) {
    if (confirmation !== LIVE_APPROVAL_CONFIRMATION) return { ok: false, reason: "需要本机页面逐笔明确确认" };
    const pending = prepared.get(approvalId);
    if (!pending) return { ok: false, reason: "确认单不存在、已使用或已过期" };
    prepared.delete(approvalId); // one-shot before any side effect
    if (preparedByCandidate.get(pending.candidateId) === approvalId) preparedByCandidate.delete(pending.candidateId);
    if (monotonicNow() >= pending.expiresAtMonotonic) return { ok: false, reason: "报价已过期，请重新预览" };
    if (consumedCandidates.has(pending.candidateId)) return { ok: false, reason: "此策略信号已提交过一次，拒绝重复确认" };
    const selected = await resolveCandidate(pending.candidateId);
    if (!selected.ok) return selected;
    const readiness = await readinessAndGates(selected.order);
    if (!readiness.ok) return readiness;
    const security = await checkSecurity("bsc", selected.order.token);
    if (!security.ok) return security;
    try { await gmgn.configCheck(); } catch { return { ok: false, reason: "GMGN 配置检查失败，拒绝提交" }; }
    // From this point the CLI submission may have an uncertain outcome; never
    // allow a second approval for the same signal, even if the response fails.
    rememberConsumed(pending.candidateId);
    let result;
    try {
      result = await trader.buy({
        ...selected.order,
        manualCandidateId: pending.candidateId,
        bnbPriceUsd: readiness.extraState.bnbPriceUsd,
        approvedQuote: pending.quote,
        manualApprovalId: approvalId,
        manualConfirmedAt: now(),
      }, readiness.extraState);
    } catch {
      // A thrown error may follow an accepted-but-unconfirmed submission.
      // Keep the signal consumed unless the ledger proves no reservation exists.
      try {
        const ledger = readLedgerImpl(cfg.ledgerPath, fsx);
        if (!ledger.positions.some((position) => position.manualCandidateId === pending.candidateId)) consumedCandidates.delete(pending.candidateId);
      } catch {}
      try { audit({ kind: "uncertain", chain: "bsc", token: selected.order.token, usd: selected.order.usd, manualApprovalId: approvalId, manualCandidateId: pending.candidateId, reason: "逐笔确认后执行结果未确认；必须先对账" }); } catch {}
      return { ok: false, reason: "执行结果未确认；请先核对 GMGN 订单和账本，禁止直接重试" };
    }
    if (!result?.ok) {
      try {
        const ledger = readLedgerImpl(cfg.ledgerPath, fsx);
        if (!ledger.positions.some((position) => position.manualCandidateId === pending.candidateId)) consumedCandidates.delete(pending.candidateId);
      } catch {}
      try { audit({ kind: "refused", chain: "bsc", token: selected.order.token, usd: selected.order.usd, manualApprovalId: approvalId, manualCandidateId: pending.candidateId, reason: result?.reason || "实盘执行器拒绝订单" }); } catch {}
      return { ok: false, reason: result?.reason || "实盘订单被交易门控拒绝" };
    }
    try { audit({ kind: "buy", chain: "bsc", token: selected.order.token, usd: selected.order.usd, manualApprovalId: approvalId, manualCandidateId: pending.candidateId, orderId: result.result?.orderId || null, orderStatus: result.result?.status || null, reason: "本机逐笔确认后已提交 GMGN；链上成交待核验" }); } catch {}
    return { ok: true, orderId: result.result?.orderId || null, status: result.result?.status || null };
  }

  function cancel(approvalId) {
    const pending = prepared.get(approvalId);
    const removed = prepared.delete(approvalId);
    if (pending && preparedByCandidate.get(pending.candidateId) === approvalId) preparedByCandidate.delete(pending.candidateId);
    return { ok: removed };
  }

  return { status, listCandidates, prepare, confirm, cancel };
}
