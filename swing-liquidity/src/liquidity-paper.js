// Liquidity-first low-cap swing PAPER runtime.
// No wallet, no signing, no live-entry gate, no import from the live trading modules.
// The legacy book (strategy paper-lowcap-swing, directory name "swing") is refused.
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  assertConfig, assertIsolatedLedger, closeTrade, costEstimate, curveActivityFromBook, dayKey, entryBlock,
  evaluateCurveEntry, exitDecision, freshSellPct, impactAssessment, mcapBucket, minLiquidityRequired,
  noteClose, openPosition, poolScreen, rankCandidates, securityCheck, swingConfirm, summarize,
} from './liquidity-signal.js';

const UA = { 'user-agent': 'swing-liquidity-paper/1.0', accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const iso = () => new Date().toISOString();
const N = v => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null; };
const tally = (bag, reasons) => { for (const r of reasons) bag[r] = (bag[r] || 0) + 1; };

const lastCall = new Map();
const penalty = new Map();
export const apiStats = { ds429: 0, gt429: 0, gp429: 0, dsCalls: 0, gtCalls: 0, gpCalls: 0 };
const hostCoolingDown = host => (lastCall.get(host) || 0) > Date.now();

async function throttled(host, minGapMs, url) {
  const wait = (lastCall.get(host) || 0) + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(host, Date.now());
  apiStats[`${host}Calls`]++;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20_000) });
  if (res.status === 429) {
    const pen = Math.min(300_000, (penalty.get(host) || 15_000) * 2);
    penalty.set(host, pen);
    apiStats[`${host}429`]++;
    lastCall.set(host, Date.now() + pen);
    throw new Error(`429 ${host}`);
  }
  if (!res.ok) throw new Error(`${res.status} ${host}`);
  penalty.set(host, 0);
  return res.json();
}

const ds = url => throttled('ds', 250, url);
const gt = url => throttled('gt', 3000, url);
const gp = url => throttled('gp', 2500, url);
const GT = 'https://api.geckoterminal.com/api/v2/networks/bsc';

function normTxn(t) {
  if (!t || t.buys == null || t.sells == null) return null;
  const buys = Number(t.buys);
  const sells = Number(t.sells);
  if (!Number.isFinite(buys) || !Number.isFinite(sells)) return null;
  return { buys, sells };
}

export async function dexSnapshot(addrs, poolOf = {}) {
  const out = new Map();
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    let pairs = [];
    try { pairs = await ds(`https://api.dexscreener.com/tokens/v1/bsc/${chunk.join(',')}`); }
    catch (e) { console.error(iso(), 'ds', e.message); continue; }
    for (const p of pairs || []) {
      const a = p?.baseToken?.address?.toLowerCase();
      if (!a || !chunk.includes(a) || p.dexId === 'flapsh') continue;
      const liq = N(p.liquidity?.usd) || 0;
      const isPool = poolOf[a] && String(p.pairAddress).toLowerCase() === poolOf[a];
      const cur = out.get(a);
      if (cur && (cur.isPool || cur.liquidityUsd >= liq) && !isPool) continue;
      out.set(a, {
        addr: a, symbol: p.baseToken.symbol, quote: p.quoteToken?.symbol, pair: p.pairAddress, dex: p.dexId, isPool: !!isPool,
        price: N(p.priceUsd), liquidityUsd: liq, mcapUsd: N(p.marketCap) ?? N(p.fdv) ?? 0, pairCreatedAt: N(p.pairCreatedAt),
        vol: { m5: N(p.volume?.m5) || 0, h1: N(p.volume?.h1) || 0, h6: N(p.volume?.h6) || 0, h24: N(p.volume?.h24) || 0 },
        txns: { m5: normTxn(p.txns?.m5), h1: normTxn(p.txns?.h1), h6: normTxn(p.txns?.h6), h24: normTxn(p.txns?.h24) },
        at: Date.now(),
      });
    }
  }
  return out;
}

const DS_QUERIES = ['pancakeswap', 'WBNB', 'USDT bsc', 'BNB', 'meme', 'bsc meme', 'pepe', 'ai agent', 'dog', 'cat', 'binance', 'pump', 'moon', 'baby', 'doge', 'inu'];

function pairFeat(p) {
  return {
    addr: p.baseToken.address.toLowerCase(), pool: String(p.pairAddress).toLowerCase(), symbol: p.baseToken.symbol,
    quote: p.quoteToken?.symbol, dex: p.dexId, mcapUsd: N(p.marketCap) ?? N(p.fdv) ?? 0,
    liquidityUsd: N(p.liquidity?.usd) || 0,
    vol: { h1: N(p.volume?.h1) || 0, h6: N(p.volume?.h6) || 0, h24: N(p.volume?.h24) || 0 },
    createdAt: N(p.pairCreatedAt),
  };
}

async function dsSearchPairs(q) {
  const j = await ds(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
  return (j?.pairs || []).filter(p => p.chainId === 'bsc' && p.baseToken?.address && p.dexId !== 'flapsh').map(pairFeat);
}

async function dsFeedTokens() {
  const out = new Set();
  for (const u of ['token-profiles/latest/v1', 'token-boosts/latest/v1', 'token-boosts/top/v1']) {
    try {
      const j = await ds(`https://api.dexscreener.com/${u}`);
      for (const x of Array.isArray(j) ? j : []) if (x.chainId === 'bsc' && x.tokenAddress) out.add(String(x.tokenAddress).toLowerCase());
    } catch (e) { console.error(iso(), 'ds feed', u, e.message); }
  }
  return [...out];
}

async function gtPools(pathQuery) {
  const j = await gt(`${GT}/${pathQuery}`);
  return (j?.data || []).map(p => {
    const a = p.attributes || {};
    const nm = String(a.name || '').replace(/\s+[\d.]+%$/, '').split(' / ');
    const base = p.relationships?.base_token?.data?.id?.replace('bsc_', '')?.toLowerCase();
    return base ? {
      addr: base, pool: String(a.address).toLowerCase(), symbol: nm[0], quote: nm[nm.length - 1],
      mcapUsd: N(a.market_cap_usd) || N(a.fdv_usd) || 0, liquidityUsd: N(a.reserve_in_usd) || 0,
      vol: { h1: N(a.volume_usd?.h1) || 0, h6: N(a.volume_usd?.h6) || 0, h24: N(a.volume_usd?.h24) || 0 },
      createdAt: Date.parse(a.pool_created_at) || null,
    } : null;
  }).filter(Boolean);
}

export async function gt5mBars(pool, limit = 100) {
  const j = await gt(`${GT}/pools/${pool}/ohlcv/minute?aggregate=5&limit=${limit}&currency=usd`);
  const list = j?.data?.attributes?.ohlcv_list || [];
  return list.map(r => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] })).sort((a, b) => a.t - b.t);
}

export async function goplusSecurity(addr) {
  const j = await gp(`https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${addr}`);
  const r = j?.result?.[addr.toLowerCase()];
  if (!r) return null;
  const pct = v => (v === '' || v == null ? null : N(v) == null ? null : N(v) * 100);
  const bit = v => (v == null || v === '' ? null : v === '1');
  return {
    honeypot: bit(r.is_honeypot), cannotBuy: bit(r.cannot_buy), cannotSellAll: bit(r.cannot_sell_all),
    buyTaxPct: pct(r.buy_tax), sellTaxPct: pct(r.sell_tax),
    openSource: r.is_open_source == null || r.is_open_source === '' ? null : r.is_open_source === '1',
    hiddenOwner: bit(r.hidden_owner), ownerChangeBalance: bit(r.owner_change_balance), at: Date.now(),
  };
}

function freshState() {
  return {
    watch: {}, positions: {}, closed: [], entriesByDay: {}, cooldown: {}, knifeBan: {}, stopTimes: {},
    curveCursor: null, curveSym: {}, curvePersist: {}, startedAt: iso(), startedAtMs: Date.now(),
  };
}

async function writeJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(obj));
  await fs.rename(tmp, file);
}

export function createLiquiditySwing({ cfg, dataDir, dry = false, log = console.log, io = {} } = {}) {
  if (!cfg) throw new Error('cfg required');
  assertConfig(cfg);
  if (cfg.liveRequested || cfg.live !== false) throw new Error('SWING_LIVE=true is not supported: this strategy is paper-only');
  const dir = dataDir || cfg.dataDir || path.resolve('data', 'swing-liquidity');
  if (path.basename(path.resolve(dir)) === 'swing') {
    const err = new Error(`refusing legacy data directory ${dir}`);
    err.code = 'LEGACY_LEDGER';
    throw err;
  }
  const ohlcvDir = path.join(dir, 'ohlcv');
  const stateFile = path.join(dir, 'state.json');
  const ledgerFile = path.join(dir, 'ledger.jsonl');
  const signalFile = path.join(dir, 'signals.jsonl');
  const statusFile = path.join(dir, 'status.json');
  let st = freshState();
  let loaded = false;
  const mem = new Map();
  let lastDiscovery = 0;
  let qCursor = 0;
  let lastGt = 0;
  let flapMod = null;
  const bookHolder = { book: null, cache: new Map(), backfilled: false, fx: null, fxAt: 0 };

  const append = async (file, row) => {
    if (dry) return;
    await fs.appendFile(file, JSON.stringify({ ts: iso(), strategyId: cfg.strategyId, ...row }) + '\n');
  };

  async function load() {
    if (loaded) return st;
    const gate = await assertIsolatedLedger(dir, cfg.strategyId, fs);
    if (!dry) await fs.mkdir(ohlcvDir, { recursive: true });
    const prior = gate.state || {};
    st = { ...freshState(), ...prior, strategyId: cfg.strategyId };
    st.positions = prior.positions || {};
    st.closed = prior.closed || [];
    st.watch = prior.watch || {};
    st.entriesByDay = prior.entriesByDay || {};
    st.cooldown = prior.cooldown || {};
    st.knifeBan = prior.knifeBan || {};
    st.stopTimes = prior.stopTimes || {};
    st.startedAtMs = prior.startedAtMs || Date.parse(prior.startedAt) || Date.now();
    st.startedAt = prior.startedAt || new Date(st.startedAtMs).toISOString();
    loaded = true;
    return st;
  }

  async function save(status) {
    if (dry) return status;
    st.strategyId = cfg.strategyId;
    await writeJson(stateFile, st);
    await writeJson(statusFile, status);
    return status;
  }

  function marksFromMarket(market, snapshots) {
    const marks = new Map();
    for (const s of snapshots) marks.set(s.addr, s);
    for (const [addr, mark] of Object.entries(market.curve?.marks || {})) {
      if (mark) marks.set(addr, { ...marks.get(addr), ...mark, addr });
    }
    return marks;
  }

  function observationOf(pos, snap, now) {
    const price = snap?.price ?? null;
    const at = snap?.at;
    const stale = !(price > 0) || !Number.isFinite(at) || now - at > cfg.maxSnapAgeSec * 1000;
    let impact = null;
    if (!stale) {
      const input = { sizeUsd: cfg.sizeUsd };
      if (snap.executableSource != null || snap.executableAt != null || snap.executableBuyImpactPct != null || snap.executableSellImpactPct != null) {
        input.executableBuyImpactPct = snap.executableBuyImpactPct;
        input.executableSellImpactPct = snap.executableSellImpactPct;
        input.executableAt = snap.executableAt ?? snap.at;
        input.executableSource = snap.executableSource || 'executable_quote';
      } else if (snap.quoteReserveUsd != null || pos.venue === 'curve') {
        input.quoteReserveUsd = snap.quoteReserveUsd ?? null;
      } else {
        input.totalLiquidityUsd = snap.liquidityUsd ?? null;
      }
      impact = impactAssessment(input, cfg, now);
    }
    return {
      price: stale ? null : price,
      at: stale ? null : at,
      stale,
      liquidityUsd: snap?.liquidityUsd ?? null,
      impactPct: impact?.impactPct ?? null,
      impactSellPct: impact?.impactSellPct ?? null,
      impactFresh: impact?.ok === true,
      impactSource: impact?.impactSource ?? null,
      sellable: snap?.sellable,
    };
  }

  async function closePosition(pos, obs, decision, now) {
    const stop = !!decision.stop;
    const writeoff = !!(decision.writeoff || decision.reason === 'unpriceable_writeoff' || decision.reason === 'unsellable_writeoff');
    let result;
    let exitBasis;
    if (writeoff) {
      result = closeTrade(pos, 0, null, { writeoff: true });
      exitBasis = 'writeoff_no_invented_price';
    } else {
      const sellPct = decision.sellPct ?? freshSellPct(pos, obs, cfg, stop);
      if (sellPct == null || !(obs.price > 0)) {
        result = closeTrade(pos, 0, null, { writeoff: true });
        exitBasis = 'writeoff_missing_sell_cost';
      } else {
        result = closeTrade(pos, obs.price, sellPct);
        exitBasis = obs.impactFresh ? (obs.impactSource || 'fresh_impact') : (stop ? 'model_without_fresh_reserve' : 'unlabeled');
      }
    }
    const rec = {
      addr: pos.addr, symbol: pos.symbol, venue: pos.venue || 'dex', bucket: pos.bucket || null,
      netUsd: +result.netUsd.toFixed(4), netPct: result.netPct == null ? null : +result.netPct.toFixed(4),
      grossUsd: result.grossUsd == null ? null : +result.grossUsd.toFixed(4),
      grossPct: result.grossPct == null ? null : +result.grossPct.toFixed(4),
      reason: decision.reason, entryAt: pos.entryAt, closedAt: now,
      exitBasis, sellPct: result.sellPct, writeoff: result.writeoff,
      quoteBacked: pos.cost?.quoteBacked === true, modelReserveAssumption: pos.cost?.modelReserveAssumption === true,
    };
    st.closed.push(rec);
    st.closed = st.closed.slice(-5000);
    noteClose(st, pos.addr, decision.reason, cfg, now);
    delete st.positions[pos.addr];
    await append(ledgerFile, { type: 'close', ...rec, price: obs.price ?? null });
    log(iso(), `[CLOSE paper ${rec.venue}] ${pos.symbol} ${decision.reason} net=${rec.netPct} gross=${rec.grossPct} basis=${exitBasis}`);
    return rec;
  }

  async function manage(now, marks) {
    const closed = [];
    for (const pos of Object.values(st.positions)) {
      const snap = marks.get(pos.addr) || null;
      if (snap?.graduated && pos.venue === 'curve') {
        pos.venue = 'dex';
        pos.graduatedAt = now;
        if (snap.liquidityUsd > 0) pos.liqAtEntry = snap.liquidityUsd;
        if (pos.cost) {
          pos.cost.lpFeePct = cfg.modelLpFeePct;
          pos.cost.lpFeeSource = 'model';
        }
        await append(ledgerFile, { type: 'graduated', addr: pos.addr, symbol: pos.symbol, price: snap.price, liquidityUsd: snap.liquidityUsd ?? null });
        log(iso(), `[GRADUATED paper] ${pos.symbol} ${pos.addr} mark moved to a DEX snapshot`);
      }
      const obs = observationOf(pos, snap, now);
      if (obs.price > 0) {
        pos.lastPrice = obs.price;
        pos.trough = Math.min(pos.trough ?? obs.price, obs.price);
      }
      const decision = exitDecision(pos, obs, cfg, now);
      pos.peak = decision.peak;
      if (decision.type === 'sell') closed.push(await closePosition(pos, obs, decision, now));
      else if (decision.reason === 'stale_or_missing_price' && now - pos.entryAt > (cfg.maxHoldHours + cfg.writeOffAfterHours) * 3600e3) {
        closed.push(await closePosition(pos, obs, { type: 'sell', reason: 'unpriceable_writeoff', stop: true, writeoff: true, peak: decision.peak }, now));
      }
    }
    return closed;
  }

  function pushSkip(list, row) { list.push(row); }

  async function consider(c, now, securityOf, injected, secBudget, skips, signals) {
    const block = entryBlock(c.addr, st, cfg, now);
    if (block) { pushSkip(skips, { addr: c.addr, symbol: c.symbol, reason: block }); return null; }
    let sec = c.security;
    if (sec === undefined) sec = securityOf ? securityOf(c.addr) : undefined;
    if (!sec || (Number.isFinite(sec.at) && now - sec.at > 3600e3)) {
      if (injected) {
        pushSkip(skips, { addr: c.addr, symbol: c.symbol, reason: sec ? 'security_stale' : 'security_missing' });
        return null;
      }
      if (secBudget.n >= cfg.securityPerTick) return null;
      secBudget.n += 1;
      try { sec = await (io.goplusSecurity || goplusSecurity)(c.addr); }
      catch (e) { pushSkip(skips, { addr: c.addr, symbol: c.symbol, reason: `goplus_error:${e.message}` }); return null; }
    }
    const verdict = securityCheck(sec, cfg);
    if (!verdict.ok || (Number.isFinite(sec?.at) && now - sec.at > 3600e3)) {
      const reasons = verdict.ok ? ['security_stale'] : verdict.reasons;
      pushSkip(skips, { addr: c.addr, symbol: c.symbol, reason: 'skip_security', reasons });
      await append(signalFile, { type: 'skip_security', addr: c.addr, symbol: c.symbol, reasons });
      return null;
    }
    const cost = costEstimate({
      sizeUsd: cfg.sizeUsd,
      totalLiquidityUsd: c.venue === 'curve' ? undefined : c.snap.liquidityUsd,
      quoteReserveUsd: c.venue === 'curve' ? c.reserveUsd : c.snap.quoteReserveUsd,
      executableBuyImpactPct: c.snap.executableBuyImpactPct,
      executableSellImpactPct: c.snap.executableSellImpactPct,
      executableAt: c.snap.executableAt,
      executableSource: c.snap.executableSource,
      knownBuyFeePct: c.venue === 'curve' ? c.buyFeePct : sec.buyTaxPct,
      knownSellFeePct: c.venue === 'curve' ? c.sellFeePct : sec.sellTaxPct,
      knownLpFeePct: c.venue === 'curve' ? 0 : null,
    }, cfg, now);
    if (!cost.ok) { pushSkip(skips, { addr: c.addr, symbol: c.symbol, reason: 'cost', reasons: cost.reasons }); return null; }
    const signal = {
      type: 'signal', venue: c.venue, addr: c.addr, symbol: c.symbol, price: c.snap.price,
      pullbackPct: +c.sig.pullbackPct.toFixed(2), score: +c.quality.score.toFixed(4),
      liquidityUsd: c.liquidityUsd, impactPct: cost.impactPct, impactSource: cost.impactSource,
      quoteBacked: cost.quoteBacked, modelReserveAssumption: cost.modelReserveAssumption,
      appliedBuyPct: cost.appliedBuyPct, appliedSellPct: cost.appliedSellPct, dry,
    };
    signals.push(signal);
    await append(signalFile, signal);
    if (dry) {
      log(iso(), `[DRY signal ${c.venue}] ${c.symbol} score=${signal.score} impact=${cost.impactPct?.toFixed?.(3)} source=${cost.impactSource}`);
      return null;
    }
    const pos = openPosition({
      spot: c.snap.price, cost, cfg, now, venue: c.venue,
      liquidityUsd: c.snap.liquidityUsd ?? c.reserveUsd ?? null,
      quoteReserveUsd: c.reserveUsd ?? cost.reserveUsed ?? null,
    });
    Object.assign(pos, {
      addr: c.addr, symbol: c.symbol, pair: c.snap.pair || null, pool: c.pool || null,
      lastPrice: c.snap.price, barT: c.sig.barT, bucket: mcapBucket(c.snap.mcapUsd || 0),
    });
    st.positions[c.addr] = pos;
    st.entriesByDay[dayKey(now)] = (st.entriesByDay[dayKey(now)] || 0) + 1;
    await append(ledgerFile, {
      type: 'open', venue: c.venue, bucket: pos.bucket, addr: c.addr, symbol: c.symbol,
      price: c.snap.price, fill: pos.entryPrice, sizeUsd: cfg.sizeUsd, tpPrice: pos.tpPrice, stopPrice: pos.stopPrice,
      liquidityUsd: pos.liqAtEntry, quoteReserveUsd: pos.quoteReserveAtEntry, mcapUsd: c.snap.mcapUsd,
      pullbackPct: signal.pullbackPct, score: signal.score,
      impactPct: cost.impactPct, impactSource: cost.impactSource, reserveBasis: cost.reserveBasis,
      quoteBacked: cost.quoteBacked, modelReserveAssumption: cost.modelReserveAssumption,
      lpFeePct: cost.lpFeePct, lpFeeSource: cost.lpFeeSource,
      modelCushionBuyPct: cost.modelCushionBuyPct, modelCushionSellPct: cost.modelCushionSellPct,
      appliedBuyPct: cost.appliedBuyPct, appliedSellPct: cost.appliedSellPct,
      targetNetPct: cfg.targetNetPct,
    });
    log(iso(), `[OPEN paper ${c.venue}] ${c.symbol} ${c.addr} spot=${c.snap.price} impact=${cost.impactPct?.toFixed?.(3)}% source=${cost.impactSource}`);
    return pos;
  }

  function curveCandidates(report, barsOf, now, rejected) {
    const out = [];
    if (!report || report.ok !== true) return out;
    for (const entry of report.entries || []) {
      const judged = evaluateCurveEntry(entry, cfg, now);
      if (!judged.ok) { tally(rejected, judged.reasons.map(r => `curve:${r}`)); continue; }
      const bars = entry.bars || barsOf(entry.addr) || [];
      const price = judged.state.priceUsd;
      const sig = swingConfirm(bars, cfg, now, price);
      if (!sig.ok) { tally(rejected, sig.reasons.map(r => `curve:${r}`)); continue; }
      out.push({
        addr: entry.addr, symbol: entry.symbol || entry.addr.slice(0, 8), venue: 'curve', pool: null,
        snap: {
          addr: entry.addr, symbol: entry.symbol, price, liquidityUsd: judged.state.reserveUsd,
          quoteReserveUsd: judged.state.reserveUsd, mcapUsd: judged.state.mcapUsd, at: entry.state.at, quote: 'BNB',
        },
        reserveUsd: judged.state.reserveUsd,
        buyFeePct: entry.state.buyFeeBps / 100,
        sellFeePct: entry.state.sellFeeBps / 100,
        sig, liquidityUsd: judged.state.reserveUsd,
        impactPct: judged.impact.impactPct,
        sideBalance: judged.activity.sideBalance,
        persistence: sig.activeBarFraction,
        security: entry.security,
      });
    }
    return out;
  }

  async function liveCurve(now, dexSnaps) {
    if (!cfg.curveEnabled) return { enabled: false, ok: false, error: null, entries: [], marks: {}, reported: true, reason: 'disabled' };
    try {
      if (!flapMod) flapMod = await import('../vendor/original-swing/src/swing-flap.js');
    } catch (e) {
      return { enabled: true, ok: false, error: `curve_module:${e.message}`, entries: [], marks: {}, reported: true };
    }
    const { CurveBook, headBlock, getTrades, bnbUsd, curveStates, symbols, flapStats } = flapMod;
    if (!bookHolder.book) bookHolder.book = new CurveBook();
    const book = bookHolder.book;
    try {
      if (!bookHolder.fx || now - bookHolder.fxAt > 60_000) { bookHolder.fx = await bnbUsd(); bookHolder.fxAt = now; }
    } catch (e) {
      return { enabled: true, ok: false, error: `bnb_usd:${e.message}`, entries: [], marks: {}, reported: true, rpcErrors: flapStats?.rpcErrors ?? null };
    }
    if (!(bookHolder.fx > 0)) return { enabled: true, ok: false, error: 'bnb_usd_unavailable', entries: [], marks: {}, reported: true };
    try {
      const head = await headBlock();
      const backfill = Math.ceil(cfg.curveBackfillHours * 3600 * 2.3);
      let from = bookHolder.backfilled && st.curveCursor != null ? st.curveCursor + 1 : head - backfill;
      if (head - from > backfill) from = head - backfill;
      if (from <= head) {
        const trades = await getTrades(from, head);
        book.ingest(trades, bookHolder.fx);
        st.curveCursor = head;
        bookHolder.backfilled = true;
      }
      book.prune(now);
      const entries = [];
      const addrs = [];
      for (const addr of book.tokens.keys()) {
        const activity = curveActivityFromBook(book, addr, now);
        if (!activity || (activity.lastT != null && now - activity.lastT > 3600e3)) continue;
        addrs.push(addr);
        entries.push({ addr, activity, bars: book.bars(addr).filter(b => b.t + 300_000 <= now) });
      }
      const posAddrs = Object.values(st.positions).filter(p => p.venue === 'curve' && !p.graduatedAt).map(p => p.addr);
      const need = [...new Set([...addrs.filter(a => {
        const hit = bookHolder.cache.get(a);
        return !hit || now - hit.at > cfg.curveStateTtlSec * 1000;
      }).slice(0, cfg.curveMaxStateChecks), ...posAddrs])];
      if (need.length) {
        const fetched = await curveStates(need);
        for (const [a, v] of fetched) bookHolder.cache.set(a, v);
      }
      const missingSym = addrs.filter(a => !st.curveSym[a]).slice(0, 60);
      if (missingSym.length) {
        try { for (const [a, sy] of await symbols(missingSym)) st.curveSym[a] = sy; } catch (e) { log(iso(), 'curve symbols', e.message); }
      }
      const out = [];
      for (const row of entries) {
        const state = bookHolder.cache.get(row.addr);
        out.push({ ...row, symbol: st.curveSym[row.addr] || row.addr.slice(0, 8), state: state || null, bnbUsd: bookHolder.fx });
        if (!dry && state) {
          const done = row.bars.filter(b => b.t > (st.curvePersist[row.addr] || 0));
          if (done.length) {
            await fs.appendFile(path.join(ohlcvDir, `curve_${row.addr}.jsonl`), done.map(b => JSON.stringify([b.t, b.o, b.h, b.l, b.c, +Number(b.v).toFixed(2), b.fx ?? bookHolder.fx])).join('\n') + '\n');
            st.curvePersist[row.addr] = done[done.length - 1].t;
          }
        }
      }
      const marks = {};
      for (const addr of posAddrs) {
        const cs = bookHolder.cache.get(addr);
        if (cs && cs.status === 1 && cs.priceBnb > 0 && cs.reserveBnb > 0 && now - cs.at <= cfg.curveStateTtlSec * 1000) {
          marks[addr] = { addr, price: cs.priceBnb * bookHolder.fx, liquidityUsd: cs.reserveBnb * bookHolder.fx, quoteReserveUsd: cs.reserveBnb * bookHolder.fx, at: cs.at, sellable: true };
        } else if (cs && cs.status !== 1) {
          const dex = dexSnaps.get(addr);
          if (dex?.price > 0 && Number.isFinite(dex.at)) marks[addr] = { ...dex, graduated: true, sellable: true };
        }
      }
      return {
        enabled: true, ok: true, error: null, entries: out, marks, reported: true, bnbUsd: bookHolder.fx,
        tokensInBook: book.size(), scanned: entries.length, rpcErrors: flapStats?.rpcErrors ?? 0,
      };
    } catch (e) {
      return { enabled: true, ok: false, error: e.message, entries: [], marks: {}, reported: true };
    }
  }

  const watchAdd = c => {
    if (!(c.liquidityUsd >= minLiquidityRequired(cfg) * 0.5)) return;
    if (!(c.mcapUsd >= cfg.minMcapUsd * 0.5 && c.mcapUsd <= cfg.maxMcapUsd)) return;
    const cur = st.watch[c.addr];
    if (cur && cur.poolLiq >= c.liquidityUsd) { cur.lastDisc = Date.now(); return; }
    st.watch[c.addr] = { ...(cur || {}), addr: c.addr, pool: c.pool, poolLiq: c.liquidityUsd, symbol: c.symbol, addedAt: cur?.addedAt || Date.now(), lastDisc: Date.now(), src: cur?.src || c.src };
  };

  async function discover(now) {
    lastDiscovery = now;
    for (let i = 0; i < cfg.dsQueriesPerCycle; i++) {
      const q = DS_QUERIES[(qCursor + i) % DS_QUERIES.length];
      try { for (const c of await (io.dsSearchPairs || dsSearchPairs)(q)) watchAdd({ ...c, src: 'ds_search' }); }
      catch (e) { log(iso(), 'ds search', q, e.message); }
    }
    qCursor = (qCursor + cfg.dsQueriesPerCycle) % DS_QUERIES.length;
    if (now - lastGt > cfg.gtDiscoverySec * 1000 && !hostCoolingDown('gt')) {
      lastGt = now;
      try {
        const list = await (io.gtPools || gtPools)('pools?sort=h24_volume_usd_desc&page=1');
        for (const c of list) watchAdd({ ...c, src: 'gt' });
      } catch (e) { log(iso(), 'gt discovery', e.message); }
    }
    const keys = Object.keys(st.watch);
    if (keys.length > cfg.maxWatch) {
      keys.filter(k => !st.positions[k]).sort((a, b) => (st.watch[a].lastDisc || 0) - (st.watch[b].lastDisc || 0))
        .slice(0, keys.length - cfg.maxWatch).forEach(k => { delete st.watch[k]; mem.delete(k); });
    }
  }

  async function refreshCharts(cands, now) {
    const t0 = Date.now();
    const need = cands.filter(c => c.pool && (!mem.get(c.addr) || now - mem.get(c.addr).barsAt >= cfg.chartMinGapSec * 1000));
    let n = 0;
    for (const c of need) {
      if (Date.now() - t0 > cfg.chartBudgetMs || hostCoolingDown('gt')) break;
      try {
        const bars = await (io.gt5mBars || gt5mBars)(c.pool, mem.get(c.addr) ? 40 : 100);
        const merged = [...new Map([...(mem.get(c.addr)?.bars || []), ...bars].map(b => [b.t, b])).values()].sort((a, b) => a.t - b.t).slice(-180);
        mem.set(c.addr, { bars: merged, barsAt: now });
        if (!dry) {
          const done = merged.filter(b => b.t + 300_000 <= now && b.t > (st.watch[c.addr]?.persistT || 0));
          if (done.length && st.watch[c.addr]) {
            await fs.appendFile(path.join(ohlcvDir, `${c.pool}.jsonl`), done.map(b => JSON.stringify([b.t, b.o, b.h, b.l, b.c, b.v])).join('\n') + '\n');
            st.watch[c.addr].persistT = done[done.length - 1].t;
          }
        }
        n++;
      } catch (e) { log(iso(), 'chart', c.symbol, e.message); }
    }
    return n;
  }

  async function tick(market) {
    await load();
    const injected = !!market;
    const now = market?.now ?? Date.now();
    const rejected = {};
    let snapshots = [];
    let curveReport;
    const barsOf = addr => (injected ? market.bars?.[addr] : mem.get(addr)?.bars) || [];
    const securityOf = addr => (injected ? market.security?.[addr] : undefined);
    if (injected) {
      snapshots = market.snapshots || [];
      if (market.curve === undefined) curveReport = { enabled: cfg.curveEnabled, ok: false, reported: false, reason: 'curve_not_in_market_view', error: null, entries: [] };
      else curveReport = { reported: true, entries: [], marks: {}, ...market.curve };
      if (curveReport.ok !== true) curveReport.entries = [];
    } else {
      if (!lastDiscovery || now - lastDiscovery > cfg.discoverySec * 1000) await discover(now);
      const addrs = [...new Set([...Object.keys(st.watch), ...Object.keys(st.positions)])];
      const poolOf = Object.fromEntries(Object.values(st.watch).map(w => [w.addr, w.pool]));
      const snapMap = await (io.dexSnapshot || dexSnapshot)(addrs, poolOf);
      snapshots = [...snapMap.values()];
      curveReport = await liveCurve(now, snapMap);
    }
    const marks = injected ? marksFromMarket(market, snapshots) : new Map(snapshots.map(s => [s.addr, s]));
    if (!injected && curveReport.marks) for (const [a, m] of Object.entries(curveReport.marks)) marks.set(a, { ...marks.get(a), ...m });
    const closedNow = await manage(now, marks);
    const dexRows = [];
    for (const snap of snapshots) {
      if (st.positions[snap.addr]) { tally(rejected, ['duplicate']); continue; }
      const screen = poolScreen(snap, cfg, now);
      if (!screen.ok) { tally(rejected, screen.reasons); continue; }
      const bars = barsOf(snap.addr);
      const sig = swingConfirm(bars, cfg, now, snap.price);
      if (!sig.ok) { tally(rejected, sig.reasons); continue; }
      dexRows.push({
        addr: snap.addr, symbol: snap.symbol, venue: 'dex', pool: st.watch[snap.addr]?.pool || snap.pair || null, snap, sig,
        liquidityUsd: screen.liquidityUsd, impactPct: screen.impact.impactPct, sideBalance: screen.sideBalance,
        persistence: sig.activeBarFraction, reserveUsd: snap.quoteReserveUsd,
      });
    }
    if (!injected) {
      const rankedForCharts = rankCandidates(dexRows, cfg).slice(0, 25);
      await refreshCharts(rankedForCharts.map(r => ({ ...r, pool: st.watch[r.addr]?.pool || r.pool })), now);
      for (const row of dexRows) {
        const bars = barsOf(row.addr);
        const sig = swingConfirm(bars, cfg, now, row.snap.price);
        row.sig = sig;
        row.persistence = sig.ok ? sig.activeBarFraction : 0;
        if (!sig.ok) row._drop = sig.reasons;
      }
    }
    const curveRows = curveCandidates(curveReport, barsOf, now, rejected);
    const passingDex = dexRows.filter(r => r.sig?.ok && !r._drop);
    for (const row of dexRows) if (row._drop) tally(rejected, row._drop);
    const ranked = rankCandidates([...passingDex, ...curveRows], cfg);
    const skips = [];
    const signals = [];
    const opened = [];
    const secBudget = { n: 0 };
    if (Object.keys(st.positions).length < cfg.maxPositions && (st.entriesByDay[dayKey(now)] || 0) < cfg.maxDailyEntries) {
      for (const c of ranked) {
        if (Object.keys(st.positions).length >= cfg.maxPositions) break;
        const pos = await consider(c, now, securityOf, injected, secBudget, skips, signals);
        if (pos) opened.push({ addr: pos.addr, symbol: pos.symbol, venue: pos.venue });
      }
    }
    const status = {
      strategyId: cfg.strategyId, mode: 'paper', live: false, orders: false, wallet: false,
      updatedAt: iso(), dataDir: dir, dry, now,
      openCount: Object.keys(st.positions).length,
      opened: opened.map(o => o.addr),
      signals: signals.map(s => ({ addr: s.addr, symbol: s.symbol, venue: s.venue, score: s.score, impactSource: s.impactSource, quoteBacked: s.quoteBacked })),
      skips,
      rejected,
      ranked: ranked.map(r => ({ addr: r.addr, symbol: r.symbol, venue: r.venue, score: +r.quality.score.toFixed(4), liquidityUsd: r.liquidityUsd, impactPct: r.impactPct })),
      curve: { reported: curveReport?.reported !== false, ok: curveReport?.ok === true, error: curveReport?.error || null, reason: curveReport?.reason || null, eligible: curveRows.length },
      closedNow: closedNow.map(c => ({ addr: c.addr, reason: c.reason, netPct: c.netPct, grossPct: c.grossPct })),
      ...summarize(st.closed, st.startedAtMs, now, cfg),
      params: {
        sizeUsd: cfg.sizeUsd, maxPositions: cfg.maxPositions, targetNetPct: cfg.targetNetPct, slSpotPct: cfg.slSpotPct,
        minLiquidityUsd: minLiquidityRequired(cfg), maxImpactPct: cfg.maxImpactPct, quoteReserveFraction: cfg.quoteReserveFraction,
        modelCushionBuyPct: cfg.modelCushionBuyPct, modelCushionSellPct: cfg.modelCushionSellPct, modelLpFeePct: cfg.modelLpFeePct,
        pullbackBand: [cfg.pullbackMinPct, cfg.pullbackMaxPct],
      },
    };
    await save(status);
    return status;
  }

  async function run() {
    await load();
    log(iso(), `liquidity swing paper started strategy=${cfg.strategyId} live=false dir=${dir}`);
    for (;;) {
      try { await tick(); } catch (e) { log(iso(), 'tick error', e.stack || e.message); }
      await sleep(cfg.pollSec * 1000);
    }
  }

  return { cfg, dir, dry, load, tick, run, state: () => st };
}
