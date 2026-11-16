// 低市值波段 (low-cap swing) PAPER-ONLY runtime. Separate process, separate ledger,
// no imports from live trading modules and no wallet/keys. See docs/swing-paper.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import { loadConfig, mcapBucket, curveLocalCheck, curveStateCheck, breakdown, universeCheck, securityCheck, pullbackSignal, openPosition, exitDecision, closeTrade, shadowStep, summarize } from './swing-signal.js';
import { headBlock, getTrades, bnbUsd as fetchBnbUsd, curveStates, symbols as curveSymbols, CurveBook, flapStats } from './swing-flap.js';

const UA = { 'user-agent': 'swing-paper/1.0', accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString();
const N = v => { const n = Number(v); return v !== null && v !== undefined && v !== '' && Number.isFinite(n) ? n : null; };

// ---- minimal per-host throttle with exponential 429 backoff (free public APIs) ----
const lastCall = new Map(), penalty = new Map(), stats = { ds429: 0, gt429: 0, gp429: 0, gtCalls: 0, dsCalls: 0, gpCalls: 0 };
export const apiStats = stats;
export const hostCoolingDown = host => (lastCall.get(host) || 0) > Date.now();
async function throttled(host, minGapMs, url) {
  const wait = (lastCall.get(host) || 0) + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(host, Date.now()); stats[`${host}Calls`]++;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) });
  if (res.status === 429) {
    const pen = Math.min(300e3, (penalty.get(host) || 15e3) * 2); penalty.set(host, pen); stats[`${host}429`]++;
    lastCall.set(host, Date.now() + pen); throw new Error(`429 ${host} (backoff ${Math.round(pen / 1000)}s)`);
  }
  if (!res.ok) throw new Error(`${res.status} ${host}`);
  penalty.set(host, 0);
  return res.json();
}
const ds = url => throttled('ds', 250, url);
const gt = url => throttled('gt', 3000, url);
const gp = url => throttled('gp', 2500, url);

// ---- data adapters ----
const GT = 'https://api.geckoterminal.com/api/v2/networks/bsc';
export async function gtPools(pathQuery) {
  const j = await gt(`${GT}/${pathQuery}`);
  return (j?.data || []).map(p => {
    const a = p.attributes || {}, nm = String(a.name || '').replace(/\s+[\d.]+%$/, '').split(' / ');
    const base = p.relationships?.base_token?.data?.id?.replace('bsc_', '')?.toLowerCase();
    return base ? { addr: base, pool: String(a.address).toLowerCase(), symbol: nm[0], quote: nm[nm.length - 1], dex: p.relationships?.dex?.data?.id || '',
      mcapUsd: N(a.market_cap_usd) || N(a.fdv_usd) || 0, liquidityUsd: N(a.reserve_in_usd) || 0,
      vol: { h1: N(a.volume_usd?.h1) || 0, h24: N(a.volume_usd?.h24) || 0 }, createdAt: Date.parse(a.pool_created_at) || null } : null;
  }).filter(Boolean);
}
/** DexScreener snapshot -> Map(addr -> features). Prefers the GT-discovered pool, else the deepest non-flapsh pair. */
export async function dexSnapshot(addrs, poolOf = {}) {
  const out = new Map();
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    let pairs = [];
    try { pairs = await ds(`https://api.dexscreener.com/tokens/v1/bsc/${chunk.join(',')}`); } catch (e) { console.error(ts(), 'ds', e.message); continue; }
    for (const p of pairs || []) {
      const a = p?.baseToken?.address?.toLowerCase();
      if (!a || !chunk.includes(a) || p.dexId === 'flapsh') continue;
      const liq = N(p.liquidity?.usd) || 0, isPool = poolOf[a] && String(p.pairAddress).toLowerCase() === poolOf[a];
      const cur = out.get(a);
      if (cur && (cur.isPool || cur.liquidityUsd >= liq) && !isPool) continue;
      out.set(a, { addr: a, symbol: p.baseToken.symbol, quote: p.quoteToken?.symbol, pair: p.pairAddress, dex: p.dexId, isPool: !!isPool,
        price: N(p.priceUsd), liquidityUsd: liq, mcapUsd: N(p.marketCap) ?? N(p.fdv) ?? 0, pairCreatedAt: N(p.pairCreatedAt),
        vol: { m5: N(p.volume?.m5) || 0, h1: N(p.volume?.h1) || 0, h6: N(p.volume?.h6) || 0, h24: N(p.volume?.h24) || 0 },
        chg: { h1: N(p.priceChange?.h1), h6: N(p.priceChange?.h6) }, at: Date.now() });
    }
  }
  return out;
}
export async function goplusSecurity(addr) {
  const j = await gp(`https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${addr}`);
  const r = j?.result?.[addr.toLowerCase()];
  if (!r) return null;
  const pct = v => (v === '' || v == null ? null : (N(v) ?? null) === null ? null : N(v) * 100);
  return { honeypot: r.is_honeypot === '1', cannotBuy: r.cannot_buy === '1', cannotSellAll: r.cannot_sell_all === '1',
    buyTaxPct: pct(r.buy_tax), sellTaxPct: pct(r.sell_tax), openSource: r.is_open_source == null ? null : r.is_open_source === '1',
    hiddenOwner: r.hidden_owner === '1', ownerChangeBalance: r.owner_change_balance === '1', holders: N(r.holder_count), at: Date.now() };
}
export async function gt5mBars(pool, limit = 100) {
  const j = await gt(`${GT}/pools/${pool}/ohlcv/minute?aggregate=5&limit=${limit}&currency=usd`);
  const list = j?.data?.attributes?.ohlcv_list || [];
  return list.map(r => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] })).sort((a, b) => a.t - b.t);
}


// ---- DexScreener discovery (primary; keeps GeckoTerminal for OHLCV only) ----
const DS_QUERIES = ['pancakeswap', 'WBNB', 'USDT bsc', 'BNB', 'flap', 'four meme', 'meme', 'bsc meme', 'pepe', 'ai agent', 'dog', 'cat', 'binance', 'cz', '币安', '币安人生',
  'pump', 'moon', 'baby', 'elon', 'trump', 'doge', 'shib', 'gem', 'coin', 'token', 'inu', 'wojak', 'frog', 'king', 'pancakeswap v3', 'pancakeswap v2', 'USDC bsc', 'agent',
  'grok', 'x402', 'giggle', 'tiger', 'rich', 'life', 'dragon', 'panda', 'monkey', 'bull', 'bear', 'gold', 'fire', 'star', 'sun', 'coinbase', 'ape', 'chad', 'sol bsc', 'musk',
  '马', '龙', '猫', '狗', '中国', '牛', '特朗普'];
const pairFeat = p => ({ addr: p.baseToken.address.toLowerCase(), pool: String(p.pairAddress).toLowerCase(), symbol: p.baseToken.symbol, quote: p.quoteToken?.symbol, dex: p.dexId,
  mcapUsd: N(p.marketCap) ?? N(p.fdv) ?? 0, liquidityUsd: N(p.liquidity?.usd) || 0, vol: { h1: N(p.volume?.h1) || 0, h24: N(p.volume?.h24) || 0 }, createdAt: N(p.pairCreatedAt) });
export async function dsSearchPairs(q) {
  const j = await ds(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`);
  return (j?.pairs || []).filter(p => p.chainId === 'bsc' && p.baseToken?.address && p.dexId !== 'flapsh').map(pairFeat);
}
export async function dsFeedTokens() {
  const out = new Set();
  for (const u of ['token-profiles/latest/v1', 'token-boosts/latest/v1', 'token-boosts/top/v1']) {
    try { const j = await ds(`https://api.dexscreener.com/${u}`); for (const x of Array.isArray(j) ? j : []) if (x.chainId === 'bsc' && x.tokenAddress) out.add(String(x.tokenAddress).toLowerCase()); }
    catch (e) { console.error(ts(), 'ds feed', u, e.message); }
  }
  return [...out];
}

// ---- persistence ----
async function readJson(f, d) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } }
async function writeJson(f, o) { const tmp = `${f}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(o)); await fs.rename(tmp, f); }

export function createSwing({ cfg = loadConfig(), dataDir, log = console.log, dry = false } = {}) {
  if (cfg.liveRequested) throw new Error('SWING_LIVE=true is not supported: this strategy is paper-only');
  const dir = dataDir || cfg.dataDir || path.resolve('data', 'swing');
  const ohlcvDir = path.join(dir, 'ohlcv');
  const stateFile = path.join(dir, 'state.json'), ledgerFile = path.join(dir, 'ledger.jsonl'),
    signalFile = path.join(dir, 'signals.jsonl'), statusFile = path.join(dir, 'status.json');
  let st = { watch: {}, positions: {}, closed: [], shadows: {}, shadowDone: [], entriesByDay: {}, cooldown: {}, curveCursor: null, curveSym: {}, curvePersist: {}, startedAt: ts(), startedAtMs: Date.now() };
  const mem = new Map();            // addr -> { bars, barsAt }
  const logAt = new Map();          // throttle noisy signal logs
  let lastDiscovery = 0, lastTickInfo = {};
  const book = new CurveBook(), curveW = new Map(), curveCache = new Map();   // curveW: addr -> {addr, symbol, sec, lastSigBar}
  let fx = null, fxAt = 0, curveBackfilled = false;

  const append = async (file, o) => { if (!dry) await fs.appendFile(file, JSON.stringify({ ts: ts(), strategyId: cfg.strategyId, ...o }) + '\n'); };
  const once = (key, ms) => { if (Date.now() - (logAt.get(key) || 0) < ms) return false; logAt.set(key, Date.now()); return true; };
  const day = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

  async function load() { if (!dry) await fs.mkdir(ohlcvDir, { recursive: true }); st = { ...st, ...(await readJson(stateFile, {})) };
    st.startedAtMs = st.startedAtMs || Date.parse(st.startedAt) || Date.now(); }
  async function save() { if (!dry) await writeJson(stateFile, st); await writeStatus(); }

  async function writeStatus() {
    const sm = summarize(st.closed, st.startedAtMs, Date.now(), cfg, st.shadowDone);
    const open = Object.values(st.positions);
    const s = { strategyId: cfg.strategyId, mode: 'paper', live: false, updatedAt: ts(), pid: process.pid, startedAt: st.startedAt,
      openCount: open.length, open: open.map(p => ({ addr: p.addr, symbol: p.symbol, venue: p.venue || 'dex', bucket: p.bucket || null, graduatedAt: p.graduatedAt ? new Date(p.graduatedAt).toISOString() : null, entryPrice: p.entryPrice, lastPrice: p.lastPrice,
        pnlPctNow: p.lastPrice ? +((p.lastPrice * (1 - cfg.sellSlippagePct / 100) / p.entryPrice - 1) * 100).toFixed(2) : null, entryAt: new Date(p.entryAt).toISOString() })),
      ...sm, venueStats: breakdown(st.closed), openByVenue: open.reduce((o, p) => { const v = p.venue || 'dex'; o[v] = (o[v] || 0) + 1; return o; }, {}),
      watchCount: Object.keys(st.watch).length, ...lastTickInfo,
      params: { pullbackPct: cfg.pullbackPct, tpPct: cfg.tpPct, slPct: cfg.slPct, maxHoldHours: cfg.maxHoldHours, sizeUsd: cfg.sizeUsd, maxPositions: cfg.maxPositions,
        maxMcapUsd: cfg.maxMcapUsd, minLiquidityUsd: cfg.minLiquidityUsd, buySlip: cfg.buySlippagePct, sellSlip: cfg.sellSlippagePct, stopExtra: cfg.stopExtraSlippagePct } };
    if (!dry) await writeJson(statusFile, s);
    return s;
  }

  let qCursor = 0, lastGtDiscovery = 0;
  const watchAdd = (c, src) => {
    if (!universeCheck({ ...c, vol: { h24: c.vol.h24 } }, cfg, 0.8).ok) return 0;   // 1h volume is judged on the live DexScreener snapshot, not at discovery
    const cur = st.watch[c.addr];
    if (cur && cur.poolLiq >= c.liquidityUsd) { cur.lastDisc = Date.now(); return 0; }  // keep deepest pool per token
    st.watch[c.addr] = { ...(cur || {}), addr: c.addr, pool: c.pool, poolLiq: c.liquidityUsd, symbol: c.symbol, addedAt: cur?.addedAt || Date.now(), lastDisc: Date.now(), createdAt: c.createdAt, src: cur?.src || src };
    return cur ? 0 : 1;
  };
  async function discover() {
    lastDiscovery = Date.now();
    let seen = 0, added = 0; const bySrc = { ds_search: 0, ds_feed: 0, gt: 0 };
    // 1) DexScreener search (rotating query window)
    for (let i = 0; i < cfg.dsQueriesPerCycle; i++) {
      const q = DS_QUERIES[(qCursor + i) % DS_QUERIES.length];
      try { for (const c of await dsSearchPairs(q)) { seen++; const n = watchAdd(c, 'ds_search'); added += n; bySrc.ds_search += n; } }
      catch (e) { log(ts(), 'ds search', q, e.message); }
    }
    qCursor = (qCursor + cfg.dsQueriesPerCycle) % DS_QUERIES.length;
    // 2) DexScreener profile/boost feeds -> snapshot -> filter
    try {
      const toks = (await dsFeedTokens()).filter(a => !st.watch[a]);
      const snaps = await dexSnapshot(toks, {});
      for (const s of snaps.values()) { seen++; const n = watchAdd({ addr: s.addr, pool: String(s.pair).toLowerCase(), symbol: s.symbol, quote: s.quote, mcapUsd: s.mcapUsd, liquidityUsd: s.liquidityUsd, vol: s.vol, createdAt: s.pairCreatedAt }, 'ds_feed'); added += n; bySrc.ds_feed += n; }
    } catch (e) { log(ts(), 'ds feed', e.message); }
    // 3) GeckoTerminal lists: secondary, infrequent, skipped while GT is in 429 backoff
    if (Date.now() - lastGtDiscovery > cfg.gtDiscoverySec * 1000 && !hostCoolingDown('gt')) {
      lastGtDiscovery = Date.now();
      for (const p of ['trending_pools?duration=24h&page=1', 'new_pools?page=1', 'new_pools?page=2', 'pools?sort=h24_tx_count_desc&page=1', 'pools?sort=h24_tx_count_desc&page=2']) {
        if (hostCoolingDown('gt')) break;
        let list = []; try { list = await gtPools(p); } catch (e) { log(ts(), 'gt discovery', p, e.message); continue; }
        for (const c of list) { seen++; const n = watchAdd(c, 'gt'); added += n; bySrc.gt += n; }
      }
    }
    const keys = Object.keys(st.watch);
    if (keys.length > cfg.maxWatch) {
      keys.filter(k => !st.positions[k]).sort((a, b) => (st.watch[a].lastDisc || 0) - (st.watch[b].lastDisc || 0))
        .slice(0, keys.length - cfg.maxWatch).forEach(k => { delete st.watch[k]; mem.delete(k); });
    }
    lastTickInfo.discovery = { at: ts(), seen, added, bySrc };
    log(ts(), `discovery: seen=${seen} added=${added} ${JSON.stringify(bySrc)} watch=${Object.keys(st.watch).length}`);
  }

  async function persistBars(w, bars) {
    if (dry) return;
    const now = Date.now(), done = bars.filter(b => b.t + 300e3 <= now && b.t > (w.persistT || 0));
    if (!done.length) return;
    await fs.appendFile(path.join(ohlcvDir, `${w.pool}.jsonl`), done.map(b => JSON.stringify([b.t, b.o, b.h, b.l, b.c, b.v])).join('\n') + '\n');
    w.persistT = done[done.length - 1].t;
  }
  async function refreshCharts(cands, snaps) {
    const t0 = Date.now(); let n = 0;
    const hot = w => { const c = snaps.get(w.addr)?.chg; return c && Math.min(c.h1 ?? 0, c.h6 ?? 0) <= -15 ? 0 : 1; };   // likely mid-pullback first
    const need = cands.filter(w => (w.noBarsUntil || 0) < Date.now() && (!mem.get(w.addr) || Date.now() - mem.get(w.addr).barsAt >= cfg.chartMinGapSec * 1000))
      .sort((a, b) => hot(a) - hot(b) || (mem.get(a.addr)?.barsAt || 0) - (mem.get(b.addr)?.barsAt || 0));
    for (const w of need) {
      if (Date.now() - t0 > cfg.chartBudgetMs || hostCoolingDown('gt')) break;
      try { const bars = await gt5mBars(w.pool, mem.get(w.addr) ? 40 : 100); const old = mem.get(w.addr)?.bars || [];
        const m = new Map([...old, ...bars].map(b => [b.t, b])); const merged = [...m.values()].sort((a, b) => a.t - b.t).slice(-150);
        mem.set(w.addr, { bars: merged, barsAt: Date.now() }); await persistBars(w, merged); n++; }
      catch (e) { log(ts(), 'chart', w.symbol, e.message); if (/^404/.test(e.message)) w.noBarsUntil = Date.now() + 3600e3; }
    }
    return n;
  }
  async function ensureSecurity(w) {
    const ttl = w.sec?.ok ? 3600e3 : 600e3;       // retry failures after 10 min
    if (w.sec && Date.now() - w.sec.at < ttl) return w.sec;
    let raw = null, err = null;
    try { raw = await goplusSecurity(w.addr); } catch (e) { err = e.message; }
    const v = raw ? securityCheck(raw, cfg) : { ok: false, reasons: [err ? `goplus_error:${err}` : 'security_unknown'] };
    w.sec = { at: Date.now(), ok: v.ok, reasons: v.reasons, raw };
    return w.sec;
  }

  async function openPaper(w, snap, sig, v = {}) {
    if (Object.keys(st.positions).length >= cfg.maxPositions) return 'max_positions';
    if ((st.entriesByDay[day()] || 0) >= cfg.maxDailyEntries) return 'daily_cap';
    if ((st.cooldown[w.addr] || 0) > Date.now()) return 'cooldown';
    const venue = v.venue || 'dex';
    const pos = openPosition({ price: snap.price, liquidityUsd: snap.liquidityUsd, cfg, now: Date.now(), venue,
      ...(venue === 'curve' ? { feePct: v.buyFeePct, exitFeePct: v.sellFeePct } : {}) });
    Object.assign(pos, { addr: w.addr, symbol: snap.symbol, pair: snap.pair, pool: w.pool, lastPrice: snap.price, barT: sig.barT, bucket: mcapBucket(snap.mcapUsd), curveSellFeePct: venue === 'curve' ? v.sellFeePct : 0 });
    st.positions[w.addr] = pos; st.entriesByDay[day()] = (st.entriesByDay[day()] || 0) + 1;
    st.shadows[w.addr + ':' + pos.entryAt] = { addr: w.addr, symbol: snap.symbol, venue, entryPrice: pos.entryPrice, stopPrice: pos.stopPrice, entryAt: pos.entryAt, peak: snap.price, hits: {}, done: false };
    await append(ledgerFile, { type: 'open', venue, bucket: pos.bucket, addr: w.addr, symbol: snap.symbol, price: snap.price, fill: pos.entryPrice, sizeUsd: cfg.sizeUsd, tpPrice: pos.tpPrice, stopPrice: pos.stopPrice,
      liquidityUsd: snap.liquidityUsd, mcapUsd: snap.mcapUsd, high4h: sig.high, pullbackPct: +sig.pullbackPct.toFixed(1), entryFeePct: pos.entryFeeUsd / cfg.sizeUsd * 100, exitFeePct: pos.exitFeePct,
      ...(venue === 'curve' ? { progressPct: +v.progressPct.toFixed(1) } : {}) });
    log(ts(), `[OPEN paper ${venue}] ${snap.symbol} ${w.addr} @${snap.price} pullback=${sig.pullbackPct.toFixed(1)}%`);
    return 'opened';
  }

  // price source per venue. curve: on-chain Portal state; after graduation (status != 1) the DEX pair price takes over.
  const markOf = (addr, venue, snaps, cstates) => {
    if (venue === 'curve') {
      const cs = cstates.get(addr);
      if (cs && cs.status === 1 && fx) return { price: cs.priceBnb * fx, liquidityUsd: cs.reserveBnb * fx };
      const dsn = snaps.get(addr);
      if (cs && cs.status !== 1 && dsn?.price) return { ...dsn, graduated: true };
      if (!cs && dsn?.price) return dsn;
      return null;
    }
    return snaps.get(addr) || null;
  };

  async function closePosition(p, price, stop, reason, snapLike) {
    const r = price > 0 ? closeTrade(p, price, stop, cfg) : { fill: 0, proceeds: 0, netUsd: -p.costUsd, netPct: -100, grossUsd: -p.costUsd, grossPct: -100 };
    const rec = { addr: p.addr, symbol: p.symbol, venue: p.venue || 'dex', bucket: p.bucket || null, graduated: !!p.graduatedAt,
      netUsd: +r.netUsd.toFixed(4), netPct: +r.netPct.toFixed(2), grossUsd: +r.grossUsd.toFixed(4), grossPct: +r.grossPct.toFixed(2),
      reason, entryAt: p.entryAt, closedAt: Date.now(), peakPct: +((p.peak / p.entryPrice - 1) * 100).toFixed(1), troughPct: +((p.trough / p.entryPrice - 1) * 100).toFixed(1) };
    st.closed.push(rec); st.closed = st.closed.slice(-5000);
    st.cooldown[p.addr] = Date.now() + cfg.cooldownHours * 3600e3;
    delete st.positions[p.addr];
    await append(ledgerFile, { type: 'close', ...rec, price, fill: r.fill, proceedsUsd: +r.proceeds.toFixed(4) });
    log(ts(), `[CLOSE paper ${rec.venue}] ${p.symbol} ${reason} net=${r.netUsd.toFixed(2)}U (${r.netPct.toFixed(1)}%) gross=${r.grossPct.toFixed(1)}%`);
  }

  async function manage(snaps, cstates = new Map()) {
    for (const p of Object.values(st.positions)) {
      const snap = markOf(p.addr, p.venue || 'dex', snaps, cstates);
      if (!snap?.price) {
        if (Date.now() - p.entryAt > (cfg.maxHoldHours + cfg.writeOffAfterHours) * 3600e3) await closePosition(p, 0, true, 'unpriceable_writeoff');
        continue;
      }
      if (snap.graduated && p.venue === 'curve') {                    // curve -> DEX: keep tracking on DEX price
        p.venue = 'dex'; p.graduatedAt = Date.now(); p.liqAtEntry = snap.liquidityUsd; p.exitFeePct = cfg.feePct + (p.curveSellFeePct || 0);
        await append(ledgerFile, { type: 'graduated', addr: p.addr, symbol: p.symbol, price: snap.price, liquidityUsd: snap.liquidityUsd });
        log(ts(), `[GRADUATED] ${p.symbol} ${p.addr} now tracked on DEX @${snap.price}`);
      }
      p.lastPrice = snap.price; p.trough = Math.min(p.trough ?? snap.price, snap.price);
      const d = exitDecision(p, { price: snap.price, liquidityUsd: snap.liquidityUsd }, cfg, Date.now());
      p.peak = d.peak;
      if (d.type === 'sell') await closePosition(p, snap.price, d.stop, d.reason);
    }
    for (const [k, sh] of Object.entries(st.shadows)) {          // shadow TP30/TP50 tracking (info only)
      const snap = markOf(sh.addr, sh.venue || 'dex', snaps, cstates); if (snap?.price) shadowStep(sh, snap.price, cfg, Date.now());
      else if (Date.now() - sh.entryAt >= cfg.maxHoldHours * 3600e3) { sh.done = true; sh.endedBy = 'time'; }
      if (sh.done) { st.shadowDone.push({ addr: sh.addr, symbol: sh.symbol, venue: sh.venue || 'dex', hits: sh.hits, endedBy: sh.endedBy, peakPct: +((sh.peak / sh.entryPrice - 1) * 100).toFixed(1) });
        st.shadowDone = st.shadowDone.slice(-5000); delete st.shadows[k];
        await append(ledgerFile, { type: 'shadow', venue: sh.venue || 'dex', addr: sh.addr, symbol: sh.symbol, hits: sh.hits, endedBy: sh.endedBy, peakPct: +((sh.peak / sh.entryPrice - 1) * 100).toFixed(1) }); }
    }
  }

  // ---------- curve (内盘) venue ----------
  const completed = (bars, now) => bars.filter(b => b.t + 300e3 <= now);
  async function persistCurve(addr, sym, now) {
    if (dry) return;
    const done = book.bars(addr).filter(b => b.t + 300e3 <= now && b.t > (st.curvePersist[addr] || 0));
    if (!done.length) return;
    await fs.appendFile(path.join(ohlcvDir, `curve_${addr}.jsonl`), done.map(b => JSON.stringify([b.t, b.o, b.h, b.l, b.c, +b.v.toFixed(2), b.fx])).join('\n') + '\n');   // USD prices; col 7 = BNB/USD used
    st.curvePersist[addr] = done[done.length - 1].t;
  }
  async function curveIngest(now) {
    if (!fx || now - fxAt > 60e3) { try { fx = await fetchBnbUsd(); fxAt = now; } catch (e) { log(ts(), 'bnbUsd', e.message); } }
    if (!fx) return { ok: false, err: 'no_bnb_usd' };
    const head = await headBlock();
    const backfill = Math.ceil(cfg.curveBackfillHours * 3600 * 2.3);
    let from = curveBackfilled && st.curveCursor != null ? st.curveCursor + 1 : head - backfill;   // after a process restart the in-memory book is rebuilt from the full backfill window
    if (head - from > backfill) from = head - backfill;
    let n = 0;
    if (from <= head) { const trades = await getTrades(from, head); book.ingest(trades, fx); n = trades.length; st.curveCursor = head; }
    book.prune(now);
    if (!curveBackfilled) { curveBackfilled = true; log(ts(), `curve backfill: blocks ${from}..${head} trades=${n} tokens=${book.size()}`); }
    return { ok: true, head, newTrades: n };
  }
  async function curveScan(now, rejected) {
    const info = { enabled: true };
    try { Object.assign(info, await curveIngest(now)); } catch (e) { log(ts(), 'curve ingest', e.message); return { info: { ...info, ok: false, err: e.message }, entries: [], cstates: new Map() }; }
    if (!info.ok) return { info, entries: [], cstates: new Map() };
    const cands = [], localRej = {};
    for (const a of book.tokens.keys()) {
      const s = book.stats(a, now); if (!s || now - s.lastT > 3600e3) continue;
      const c = curveLocalCheck(s, cfg);
      if (c.ok) cands.push(a); else for (const r of c.reasons) localRej[r] = (localRej[r] || 0) + 1;
    }
    // chain state for candidates (TTL cache) + open curve positions / shadows (fresh every tick)
    const posAddrs = [...Object.values(st.positions), ...Object.values(st.shadows)].filter(x => (x.venue || 'dex') === 'curve').map(x => x.addr);
    const need = [...new Set([...cands.filter(a => !curveCache.get(a) || now - curveCache.get(a).at > cfg.curveStateTtlSec * 1000).slice(0, cfg.curveMaxStateChecks), ...posAddrs])];
    let fetched = 0;
    try { const m = await curveStates(need); for (const [a, v] of m) curveCache.set(a, v); fetched = m.size; } catch (e) { log(ts(), 'curve states', e.message); }
    const cstates = new Map(posAddrs.map(a => [a, curveCache.get(a)]).filter(([, v]) => v));
    const noSym = cands.filter(a => !st.curveSym[a]).slice(0, 60);
    if (noSym.length) { try { for (const [a, sy] of await curveSymbols(noSym)) st.curveSym[a] = sy; } catch {} }
    const entries = [], rej = {}; const bucketCount = { 'lt300k': 0, '300k-1M': 0, '1M-3M': 0 };
    for (const a of cands) {
      const cs = curveCache.get(a); const v = curveStateCheck(cs, fx, cfg);
      if (!v.ok) { for (const r of v.reasons) { const k = r.replace(/\(.*\)/, ''); rej[k] = (rej[k] || 0) + 1; } continue; }
      let w = curveW.get(a); if (!w) { w = { addr: a, symbol: st.curveSym[a] || a.slice(0, 8), sec: null, lastSigBar: null }; curveW.set(a, w); }
      w.symbol = st.curveSym[a] || w.symbol; bucketCount[mcapBucket(v.mcapUsd)]++;
      entries.push({ w, venue: 'curve', snap: { addr: a, symbol: w.symbol, price: v.priceUsd, liquidityUsd: v.reserveUsd, mcapUsd: v.mcapUsd, vol: { h1: book.stats(a, now).vol1hUsd } },
        bars: completed(book.bars(a), now), buyFeePct: cs.buyFeeBps / 100, sellFeePct: cs.sellFeeBps / 100, progressPct: v.progressPct });
      await persistCurve(a, w.symbol, now);
    }
    for (const [k, c] of Object.entries(localRej)) rejected[k] = c;
    return { entries, cstates, info: { ...info, bnbUsd: +fx.toFixed(2), tokensInBook: book.size(), active1h: book.activeCount(now), localCandidates: cands.length, stateFetched: fetched,
      eligible: entries.length, eligibleByBucket: bucketCount, localRejected: localRej, stateRejected: rej, cursorBlock: st.curveCursor, rpcCalls: flapStats.rpcCalls, rpcErrors: flapStats.rpcErrors,
      filters: { minVol1hUsd: cfg.curveMinVol1hUsd, minBuys1h: cfg.curveMinBuys1h, minBuyers1h: cfg.curveMinBuyers1h, minAgeMin: cfg.curveMinAgeMin, progress: [cfg.curveProgressMin, cfg.curveProgressMax], minReserveUsd: cfg.curveMinReserveUsd, maxFeePct: cfg.curveMaxTaxPct } } };
  }

  async function tick() {
    if (!lastDiscovery || Date.now() - lastDiscovery > cfg.discoverySec * 1000) await discover();
    const addrs = [...new Set([...Object.keys(st.watch), ...Object.keys(st.positions)])];
    const poolOf = Object.fromEntries(Object.values(st.watch).map(w => [w.addr, w.pool]));
    const snaps = await dexSnapshot(addrs, poolOf);
    for (const [a, s] of snaps) if (st.watch[a]) { st.watch[a].lastSeen = Date.now(); st.watch[a].symbol = s.symbol; }
    // eligible = passes the strict universe filter right now
    const eligible = [], rejected = {};
    for (const [a, s] of snaps) {
      const w = st.watch[a]; if (!w || !s.price) continue;
      const u = universeCheck(s, cfg); w.uni = u.ok;
      if (u.ok) eligible.push(w); else for (const r of u.reasons) rejected[r] = (rejected[r] || 0) + 1;
    }
    const cur = cfg.curveEnabled ? await curveScan(Date.now(), {}).catch(e => { log(ts(), 'curve scan', e.message); return { info: { enabled: true, ok: false, err: e.message }, entries: [], cstates: new Map() }; }) : { info: { enabled: false }, entries: [], cstates: new Map() };
    await manage(snaps, cur.cstates);
    const charts = await refreshCharts(eligible, snaps);
    const entries = [...eligible.map(w => ({ w, venue: 'dex', snap: snaps.get(w.addr), bars: completed(mem.get(w.addr)?.bars || [], Date.now()) })), ...cur.entries];
    let candidates = 0, secChecks = 0, opened = 0;
    if (Object.keys(st.positions).length < cfg.maxPositions && (st.entriesByDay[day()] || 0) < cfg.maxDailyEntries) {
      for (const en of entries) {
        const { w, snap, venue } = en;
        if (st.positions[w.addr] || (st.cooldown[w.addr] || 0) > Date.now() || !en.bars.length) continue;
        const sig = pullbackSignal(en.bars, cfg, Date.now(), snap.price);
        if (!sig.ok || w.lastSigBar === sig.barT) continue;
        candidates++;
        if (!w.sec || Date.now() - w.sec.at >= (w.sec.ok ? 3600e3 : 600e3)) { if (secChecks >= cfg.securityPerTick) continue; secChecks++; }
        const sec = await ensureSecurity(w);
        if (!sec.ok) { if (once('sec:' + w.addr, 1800e3)) await append(signalFile, { type: 'skip_security', venue, addr: w.addr, symbol: snap.symbol, reasons: sec.reasons, price: snap.price, pullbackPct: +sig.pullbackPct.toFixed(1) }); continue; }
        w.lastSigBar = sig.barT;
        await append(signalFile, { type: 'signal', venue, bucket: mcapBucket(snap.mcapUsd), addr: w.addr, symbol: snap.symbol, price: snap.price, pullbackPct: +sig.pullbackPct.toFixed(1), high4h: sig.high, mcapUsd: snap.mcapUsd, liquidityUsd: snap.liquidityUsd, dry });
        if (dry) { log(ts(), `[DRY signal ${venue}] ${snap.symbol} ${w.addr} pullback=${sig.pullbackPct.toFixed(1)}%`); continue; }
        const r = await openPaper(w, snap, sig, { venue, buyFeePct: en.buyFeePct, sellFeePct: en.sellFeePct, progressPct: en.progressPct });
        if (r === 'opened') { opened++; if (Object.keys(st.positions).length >= cfg.maxPositions) break; } else log(ts(), `signal ${snap.symbol} skipped: ${r}`);
      }
    }
    const dexBuckets = eligible.reduce((o, w) => { const b = mcapBucket(snaps.get(w.addr).mcapUsd); o[b] = (o[b] || 0) + 1; return o; }, { 'lt300k': 0, '300k-1M': 0, '1M-3M': 0 });
    lastTickInfo = { ...lastTickInfo, lastTickAt: ts(), universeSize: eligible.length + cur.entries.length, universeDex: eligible.length, universeCurve: cur.entries.length, snapshots: snaps.size, chartRefreshes: charts, entryCandidates: candidates, securityChecks: secChecks, opened,
      universeBuckets: Object.fromEntries(Object.keys(dexBuckets).map(k => [k, dexBuckets[k] + (cur.info.eligibleByBucket?.[k] || 0)])), universeBucketsDex: dexBuckets, universeBucketsCurve: cur.info.eligibleByBucket || null,
      curve: cur.info,
      api429: { ds: apiStats.ds429, gt: apiStats.gt429, gp: apiStats.gp429 }, apiCalls: { ds: apiStats.dsCalls, gt: apiStats.gtCalls, gp: apiStats.gpCalls }, gtCoolingDown: hostCoolingDown('gt'),
      watchBySrc: Object.values(st.watch).reduce((o, w) => { o[w.src || 'gt'] = (o[w.src || 'gt'] || 0) + 1; return o; }, {}),
      rejectedTop: Object.fromEntries(Object.entries(rejected).sort((a, b) => b[1] - a[1]).slice(0, 6)),
      barsCached: [...mem.values()].filter(m => m.bars.length).length };
    await save();
    return { watch: addrs.length, snaps: snaps.size, ...lastTickInfo };
  }

  async function run() {
    await load();
    log(ts(), `swing paper started pid=${process.pid} strategy=${cfg.strategyId} live=false dir=${dir}`);
    for (;;) {
      try { await tick(); } catch (e) { log(ts(), 'tick error', e.stack || e.message); }
      await sleep(cfg.pollSec * 1000);
    }
  }
  return { cfg, run, tick, load, discover, state: () => st, writeStatus };
}
