// Mirrors NEW paper ATM confirmed-pvp-v2 buys to the default-OFF live trader.
// While LIVE_TRADING_ENABLED!=true this does nothing (no RPC, no CLI).
import fs from "node:fs";
import path from "node:path";
import { redactText } from "./live-redact.js";
import { paperChaseGate } from "./paper-chase-gate.js";
import { checkGates as checkLiveEntryGates } from "./live-entry-gates.js";
import { closedPaperRounds } from "./paper-sqn.js";
import { createLiveTrader, loadLiveConfig, BSC_USDT, normChain, checkLiveEvidence } from "./live-gmgn-trader.js";
import { readVerifiedBnbBalance, readVerifiedUsdtBalance, redactObservationError } from "./bsc-balance-read.js";
export { redactObservationError };

// Append-only audit of every live mirror decision (studio "Grok 思考" feed). Never throws.
export function logLiveDecision(cfg, entry) {
  try {
    const file = path.join(path.dirname(cfg.ledgerPath), "live-decisions.jsonl");
    const safe = { ...entry };
    if (safe.reason) safe.reason = redactText(safe.reason, 800);
    if (safe.result) safe.result = redactText(safe.result, 400);
    fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...safe }) + "\n");
  } catch {}
}

// Evidence tier for audit (same derivation as paper-cost-policy). null when paper sent no evidence.
export function evidenceTierOf(t) {
  const ev = t?.entryEvidence;
  if (!ev || typeof ev !== "object") return { evidenceTier: null, evidenceTierGateVersion: null, evidenceMainAllowed: null };
  try { const g = paperChaseGate(ev, { chain: t.chain, costRate: 0 }); return { evidenceTier: ev.evidenceTier ?? g.tier ?? null, evidenceTierGateVersion: g.version ?? null, evidenceMainAllowed: g.mainAllowed ?? null }; }
  catch { return { evidenceTier: ev.evidenceTier ?? null, evidenceTierGateVersion: null, evidenceMainAllowed: null }; }
}

export const LIVE_MIRROR_SOURCE = "paper-atm-confirmed-pvp-v2";
// Every price/balance read is bounded; a hung RPC must not let an old signal submit later.
export const READ_TIMEOUT_MS = 8_000;
const timed = (fetchImpl) => (url, init = {}) => fetchImpl(url, { ...init, signal: AbortSignal.timeout(READ_TIMEOUT_MS) });
const finitePos = (v, what) => { const n = Number(v); if (!Number.isFinite(n) || n < 0) throw new Error(`bad ${what}`); return n; };

export async function readBnbBalance(wallet, fetchImpl = fetch, options) {
  return readVerifiedBnbBalance(wallet, fetchImpl, options);
}

export async function readBnbPriceUsd(fetchImpl = fetch) {
  const res = await timed(fetchImpl)("https://api.binance.com/api/v3/ticker/price?symbol=BNBUSDT");
  const p = Number((await res.json()).price);
  if (!(p > 0) || !Number.isFinite(p)) throw new Error("bad BNB price");
  return p;
}

const SOL_RPC = "https://api.mainnet-beta.solana.com";
export async function readSolBalance(wallet, fetchImpl = fetch) {
  const res = await timed(fetchImpl)(SOL_RPC, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [wallet] }) });
  const j = await res.json();
  return finitePos(Number(j?.result?.value) / 1e9, "SOL balance");
}
export async function readSolPriceUsd(fetchImpl = fetch) {
  const res = await timed(fetchImpl)("https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT");
  const p = Number((await res.json()).price);
  if (!(p > 0) || !Number.isFinite(p)) throw new Error("bad SOL price");
  return p;
}

export async function readUsdtBalanceUsd(wallet, fetchImpl = fetch, options) {
  return readVerifiedUsdtBalance(wallet, fetchImpl, { ...options, token: BSC_USDT });
}

export function newConfirmedBuys(beforeCount, account, session, chains = ["bsc"]) {
  if (!/^confirmed-pvp-v2-/.test(session?.id || "")) return [];
  return (account?.trades || []).slice(beforeCount).filter((t) => t.side === "buy" && chains.includes(normChain(t.chain)));
}

export function createLiveMirror({ cfg = loadLiveConfig(), trader, readBalance, readPrice = readBnbPriceUsd, readSolBal = readSolBalance, readSolPrice = readSolPriceUsd, env = process.env, now = Date.now, log = console } = {}) {
  const chains = cfg.chains || [cfg.chain];
  const bnb = cfg.spendAsset === "bnb";
  readBalance ||= bnb ? readBnbBalance : readUsdtBalanceUsd;
  trader ||= createLiveTrader(cfg, { log });
  let reconciled = null;
  // H1: periodic TP/SL close sync so realized PnL reaches the daily loss stop without waiting for a new buy.
  if (cfg.enabled === true && trader.syncClosed && Number(cfg.closeSyncMs) > 0) {
    const timer = setInterval(() => { trader.syncClosed().then((r) => { for (const c of r?.closed || []) { const { id, token, pnl, estimated, ...detail } = c; logLiveDecision(cfg, { kind: "close", token, positionId: id, pnlUsd: pnl, pnlEstimate: estimated, ...detail, reason: c.estimated ? "条件单已结束但缺成交统计，按全亏保守记账" : "条件单止盈/止损已成交，盈亏入当日账" }); } }).catch((e) => log.warn?.(`[live-gmgn] close sync: ${e.message}`)); }, cfg.closeSyncMs);
    timer.unref?.();
  }
  const mirror = async function mirror(beforeCount, account, session) {
    if (cfg.enabled !== true) return [];
    // First call after (re)start: reconcile pending/uncertain orders before anything new.
    if (!reconciled && trader.reconcile) reconciled = trader.reconcile().then((left) => {
      if (left?.length) logLiveDecision(cfg, { kind: "reconcile", reason: `仍有 ${left.length} 笔未决实盘订单，新单暂停直到对账`, unresolved: left.map((p) => ({ id: p.id, orderId: p.orderId, status: p.status, token: p.token })) });
    }).catch((e) => { log.warn?.(`[live-gmgn] reconcile failed: ${e.message}`); reconciled = null; });
    if (reconciled) await reconciled;
    const buys = newConfirmedBuys(beforeCount, account, session, chains);
    // Promotion quality is measured from the paper ledger itself, not from
    // historical LIVE eligibility annotations that older paper rows lack.
    const closedTrades = closedPaperRounds(account?.trades || [])
      .map((round) => ({ realizedPnl: round.pnl, closedAtMs: round.at }));
    const promotion = checkLiveEntryGates({
      closedTrades,
      trades: Array.isArray(account?.trades) ? account.trades : null,
      sessionPresent: /^confirmed-pvp-v2-/.test(session?.id || ""),
      nowMs: now(), env,
    });
    if (/^confirmed-pvp-v2-/.test(session?.id || "")) for (const t of (account?.trades || []).slice(beforeCount)) {
      if (t.side === "buy" && !chains.includes(normChain(t.chain))) logLiveDecision(cfg, { kind: "skip", token: t.address, symbol: t.symbol, chain: t.chain, paperUsd: t.costBasisUsd, reason: `信号在 ${t.chain} 链，实盘只跟 ${chains.join("/")}，不跟`, entryReasons: t.entryReasons });
    }
    const out = [];
    for (const t of buys) {
      const identity = { paperStrategyId: t.strategyId ?? null, paperStrategyLabel: t.strategyLabel ?? null, paperSessionId: session?.id ?? null, paperTradeId: t.id ?? null, signalAt: t.atMs ?? null, ...evidenceTierOf(t) };
      if (!promotion.allow) {
        const reason = `LIVE 晋级门控：${promotion.reason || "未通过"}`;
        out.push({ ok: false, reason, gate: promotion.gate });
        logLiveDecision(cfg, { ...identity, kind: "refused", token: t.address, symbol: t.symbol, chain: t.chain, paperUsd: t.costBasisUsd, reason });
        continue;
      }
      const usd = Math.min(Number(t.costBasisUsd || cfg.maxPerTradeUsd), cfg.maxPerTradeUsd);
      let extra = { balanceUsd: undefined }, bnbPriceUsd, solPriceUsd;
      const chain = normChain(t.chain);
      try {
        if (chain === "sol") {
          solPriceUsd = await readSolPrice();
          const balanceSol = await readSolBal(cfg.solWallet);
          extra = { balanceSol, balanceUsd: Math.max(0, balanceSol - cfg.gasReserveSol) * solPriceUsd };
        } else if (bnb) {
          bnbPriceUsd = await readPrice();
          const balanceBnb = await readBalance(cfg.wallet);
          extra = { balanceBnb, balanceUsd: Math.max(0, balanceBnb - cfg.gasReserveBnb) * bnbPriceUsd };
        } else extra = { balanceUsd: await readBalance(cfg.wallet) };
      } catch (e) { log.warn?.(`[live-gmgn] balance/price read failed: ${e.message}`); }
      if (cfg.requireEvidence !== false) {
        const ev = checkLiveEvidence(cfg, t.entryEvidence);
        if (!ev.ok) { out.push({ ok: false, reason: `live evidence gate: ${ev.reason}` }); logLiveDecision(cfg, { ...identity, kind: "refused", token: t.address, symbol: t.symbol, chain: t.chain, paperUsd: t.costBasisUsd, reason: `实盘证据门控：${ev.reason}` }); continue; }
      }
      const base = { ...identity, token: t.address, symbol: t.symbol, chain: t.chain, paperUsd: t.costBasisUsd, usd, bnbPriceUsd, solPriceUsd, balanceBnb: extra.balanceBnb, balanceSol: extra.balanceSol, entryReasons: t.entryReasons };
      try {
        const r = await trader.buy({ source: LIVE_MIRROR_SOURCE, ...identity, paperPrice: t.price, usd, token: t.address, chain, bnbPriceUsd, solPriceUsd }, extra);
        out.push(r);
        logLiveDecision(cfg, { ...base, kind: r.ok ? "buy" : "refused", reason: r.reason || r.ledgerWriteError || null, positionId: r.positionId, orderId: r.ok ? r.result?.orderId : undefined, orderStatus: r.ok ? r.result?.status : undefined, txHash: r.ok ? (r.result?.raw?.hash || r.result?.raw?.tx_hash || r.result?.raw?.data?.hash) : undefined, result: r.ok ? JSON.stringify(r.result?.raw ?? r.result ?? "").slice(0, 400) : undefined });
      } catch (e) { log.error?.(`[live-gmgn] buy failed: ${e.message}`); out.push({ ok: false, reason: e.message }); logLiveDecision(cfg, { ...base, kind: e.orderState === "uncertain" ? "uncertain" : "error", orderId: e.orderId, reason: e.message.slice(0, 800) }); }
    }
    return out;
  };
  mirror.cfg = cfg;
  mirror.trader = trader;
  return mirror;
}
