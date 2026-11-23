// 老盘重启 (old-token revival) PAPER-ONLY runtime. Separate process, separate ledger,
// no imports from live trading modules and no wallet/keys. See docs/old-revival-paper.md.
import fs from 'node:fs/promises';
import path from 'node:path';
import { STRATEGY_ID, loadConfig, isFlapAddress, chartShape, evaluate, volumeSpike,
  openPosition, exitDecision, sellProceeds } from './old-revival-signal.js';

const UA = { 'user-agent': 'old-revival-paper/1.0', accept: 'application/json' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const ts = () => new Date().toISOString();

// ---- minimal per-host throttle (free public APIs) ----
const lastCall = new Map();
async function throttled(host, minGapMs, url, init = {}) {
  const wait = (lastCall.get(host) || 0) + minGapMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(host, Date.now());
  const res = await fetch(url, { ...init, headers: { ...UA, ...(init.headers || {}) }, signal: AbortSignal.timeout(20000) });
  if (res.status === 429) { lastCall.set(host, Date.now() + 15000); throw new Error(`429 ${host}`); }
  if (!res.ok) throw new Error(`${res.status} ${host}`);
  return res.json();
}
const ds = url => throttled('ds', 250, url);
const gt = url => throttled('gt', 2300, url);        // GeckoTerminal ~30/min
const gp = url => throttled('gp', 2300, url);        // GoPlus
const bn = (body) => throttled('bn', 1000, 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/rank/list/ai',
  { method: 'POST', headers: { 'content-type': 'application/json', 'accept-encoding': 'identity' }, body: JSON.stringify(body) });

const N = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ---- data adapters ----
export async function binanceMigrated() {
  const j = await bn({ chainId: '56', rankType: 30, protocol: [2002], limit: 100 });
  return (j?.data || []).map(t => ({
    addr: String(t.contractAddress).toLowerCase(), symbol: t.symbol, name: t.name,
    createdAt: N(t.createTime), migratedAt: N(t.migrateTime), holders: N(t.holders), netBuy: N(t.netBuy),
    smartHolders: N(t.smartMoneyHolders) || 0, kolHolders: N(t.kolHolders) || 0,
    taxBuy: N(t.taxRateBuy), taxSell: N(t.taxRateSell), devSell: N(t.devSellPercent),
    washTag: !!(t.tagDevWashTrading || t.tagInsiderWashTrading), pair: t.pairAnchorAddress || null,
  }));
}
export async function gtPoolAddrs() {
  const out = new Set();
  const pages = ['trending_pools?page=1', 'trending_pools?page=2', 'pools?page=1&sort=h24_volume_usd_desc', 'pools?page=2&sort=h24_volume_usd_desc'];
  for (const p of pages) {
    try {
      const j = await gt(`https://api.geckoterminal.com/api/v2/networks/bsc/${p}`);
      for (const pool of j?.data || []) {
        const b = pool?.relationships?.base_token?.data?.id?.replace('bsc_', '');
        if (b) out.add(b.toLowerCase());
      }
    } catch (e) { console.error(ts(), 'gt discovery', p, e.message); }
  }
  return [...out];
}
/** DexScreener snapshot for many tokens -> Map(addr -> best pancake pair features). */
export async function dexSnapshot(addrs) {
  const out = new Map();
  for (let i = 0; i < addrs.length; i += 30) {
    const chunk = addrs.slice(i, i + 30);
    let pairs = [];
    try { pairs = await ds(`https://api.dexscreener.com/tokens/v1/bsc/${chunk.join(',')}`); } catch (e) { console.error(ts(), 'ds', e.message); continue; }
    for (const p of pairs || []) {
      const a = p?.baseToken?.address?.toLowerCase();
      if (!a || !chunk.includes(a) || p.dexId === 'flapsh') continue;
      const liq = N(p.liquidity?.usd) || 0;
      const cur = out.get(a);
      if (cur && cur.liquidityUsd >= liq) continue;
      out.set(a, {
        addr: a, symbol: p.baseToken.symbol, name: p.baseToken.name, pair: p.pairAddress, dex: p.dexId,
        price: N(p.priceUsd), liquidityUsd: liq, mcapUsd: N(p.marketCap) ?? N(p.fdv) ?? 0, pairCreatedAt: N(p.pairCreatedAt),
        vol: { m5: N(p.volume?.m5) || 0, h1: N(p.volume?.h1) || 0, h6: N(p.volume?.h6) || 0, h24: N(p.volume?.h24) || 0 },
        buys: N(p.txns?.h1?.buys) ?? 0, sells: N(p.txns?.h1?.sells) ?? 0,
        buys5: N(p.txns?.m5?.buys) ?? 0, sells5: N(p.txns?.m5?.sells) ?? 0, at: Date.now(),
      });
    }
  }
  return out;
}
export async function goplusSecurity(addr) {
  const j = await gp(`https://api.gopluslabs.io/api/v1/token_security/56?contract_addresses=${addr}`);
  const r = j?.result?.[addr.toLowerCase()];
  if (!r) return null;
  return { honeypot: r.is_honeypot === '1', cannotSellAll: r.cannot_sell_all === '1',
    buyTaxPct: (N(r.buy_tax) || 0) * 100, sellTaxPct: (N(r.sell_tax) || 0) * 100,
    holders: N(r.holder_count), at: Date.now() };
}
export async function gtHourlyBars(pool) {
  const j = await gt(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${pool}/ohlcv/hour?aggregate=1&limit=1000&currency=usd`);
  const list = j?.data?.attributes?.ohlcv_list || [];
  return list.map(r => ({ t: r[0] * 1000, o: r[1], h: r[2], l: r[3], c: r[4], v: r[5] })).sort((a, b) => a.t - b.t);
}
export async function gtPoolTx(pool) {
  const j = await gt(`https://api.geckoterminal.com/api/v2/networks/bsc/pools/${pool}`);
  const t = j?.data?.attributes?.transactions?.h24;
  if (!t) return null;
  const wallets = (t.buyers || 0) + (t.sellers || 0);
  return wallets > 0 ? (t.buys + t.sells) / wallets : null;
}

// ---- persistence ----
async function readJson(f, d) { try { return JSON.parse(await fs.readFile(f, 'utf8')); } catch { return d; } }
async function writeJson(f, o) { const tmp = `${f}.${process.pid}.tmp`; await fs.writeFile(tmp, JSON.stringify(o)); await fs.rename(tmp, f); }

export function createOldRevival({ cfg = loadConfig(), dataDir, log = console.log, dry = false } = {}) {
  if (cfg.live) throw new Error('OLD_REVIVAL_LIVE=true is not supported: this strategy is paper-only');
  const dir = dataDir || cfg.dataDir || path.resolve('data', 'old-revival');
  const stateFile = path.join(dir, 'state.json'), ledgerFile = path.join(dir, 'ledger.jsonl'),
    signalFile = path.join(dir, 'signals.jsonl'), statusFile = path.join(dir, 'status.json');
  let st = { watch: {}, positions: {}, closed: [], cash: cfg.cashUsd, realizedUsd: 0, entriesByDay: {}, cooldown: {}, startedAt: ts() };
  const nearLog = new Map();
  let lastDiscovery = 0, bnMap = new Map();

  const append = async (file, o) => { if (!dry) await fs.appendFile(file, JSON.stringify({ ts: ts(), strategyId: cfg.strategyId, ...o }) + '\n'); };
  const day = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10);

  async function load() { await fs.mkdir(dir, { recursive: true }); st = { ...st, ...(await readJson(stateFile, {})) }; }
  async function save() { if (!dry) await writeJson(stateFile, st); await writeStatus(); }

  async function writeStatus() {
    const closed = st.closed, wins = closed.filter(c => c.pnlUsd > 0).length;
    const open = Object.values(st.positions);
    const s = { strategyId: cfg.strategyId, mode: 'paper', live: false, updatedAt: ts(), pid: process.pid,
      cashUsd: +st.cash.toFixed(2), realizedUsd: +st.realizedUsd.toFixed(2), openCount: open.length,
      closedCount: closed.length, winRate: closed.length ? +(wins / closed.length).toFixed(3) : null,
      watchCount: Object.keys(st.watch).length, open: open.map(p => ({ addr: p.addr, symbol: p.symbol, entryPrice: p.entryPrice, lastPrice: p.lastPrice, tp1Done: p.tp1Done })) };
    if (!dry) await writeJson(statusFile, s);
    return s;
  }

  async function discover() {
    lastDiscovery = Date.now();
    const add = (addr, extra = {}) => {
      addr = addr.toLowerCase();
      if (cfg.requireFlapSuffix && !isFlapAddress(addr)) return;
      st.watch[addr] = { addr, addedAt: Date.now(), holdersHist: [], ...(st.watch[addr] || {}), ...extra };
    };
    try { const list = await binanceMigrated(); bnMap = new Map(list.map(t => [t.addr, t]));
      for (const t of list) add(t.addr, { symbol: t.symbol, createdAt: t.createdAt || st.watch[t.addr]?.createdAt || null }); }
    catch (e) { log(ts(), 'binance discovery failed', e.message); }
    for (const a of await gtPoolAddrs()) add(a);
    // cap watchlist: drop oldest-seen non-position entries
    const keys = Object.keys(st.watch);
    if (keys.length > cfg.maxWatch) {
      keys.filter(k => !st.positions[k]).sort((a, b) => (st.watch[a].lastSeen || 0) - (st.watch[b].lastSeen || 0))
        .slice(0, keys.length - cfg.maxWatch).forEach(k => delete st.watch[k]);
    }
    log(ts(), `discovery: watch=${Object.keys(st.watch).length} binance=${bnMap.size}`);
  }

  async function ensureChart(w, snap) {
    if (w.chartAt && Date.now() - w.chartAt < 15 * 60e3 && w.bars) {
      // patch current bar with latest snapshot price
      const bars = w.bars.slice(); const last = { ...bars[bars.length - 1] };
      const hourStart = Math.floor(Date.now() / 3600e3) * 3600e3;
      if (last.t === hourStart) { last.c = snap.price; last.h = Math.max(last.h, snap.price); last.l = Math.min(last.l, snap.price); bars[bars.length - 1] = last; }
      return bars;
    }
    w.bars = await gtHourlyBars(snap.pair); w.chartAt = Date.now();
    return w.bars;
  }
  async function ensureSecurity(w) {
    if (w.sec && Date.now() - w.sec.at < 3600e3) return w.sec;
    try { w.sec = await goplusSecurity(w.addr); } catch (e) { log(ts(), 'goplus', e.message); }
    return w.sec || null;
  }
  async function sampleHolders(w, snap) {
    const last = w.holdersHist[w.holdersHist.length - 1];
    if (last && Date.now() - last.t < 20 * 60e3) return;
    if (snap.liquidityUsd < cfg.minLiquidityUsd * 0.5) return;
    try { const sec = await goplusSecurity(w.addr); if (sec?.holders) { w.holdersHist.push({ t: Date.now(), n: sec.holders }); w.holdersHist = w.holdersHist.slice(-60); w.sec = sec; } } catch {}
  }
  const holdersRise = w => {
    const h = w.holdersHist, now = Date.now(); if (h.length < 2) return null;
    const cur = h[h.length - 1];
    const old = h.find(x => now - x.t <= 6 * 3600e3 && now - x.t >= 50 * 60e3) || null;   // earliest sample within 50min–6h
    return old ? (cur.n / old.n - 1) * 100 : null;
  };

  async function considerEntry(w, snap, opts = {}) {
    const age = (Date.now() - (w.createdAt || snap.pairCreatedAt || Date.now())) / 3600e3;
    // cheap prefilters before spending rate-limited calls
    const sp = volumeSpike(snap.vol);
    const pre = age >= cfg.minAgeHours && age <= cfg.maxAgeDays * 24 && snap.liquidityUsd >= cfg.minLiquidityUsd && snap.mcapUsd >= cfg.minMcapUsd
      && (sp.r5 >= cfg.spike5m || sp.r1 >= cfg.spike1h) && snap.vol.h1 >= cfg.minH1VolUsd;
    if (!pre && !opts.force) return null;
    let bars = null; try { bars = await ensureChart(w, snap); } catch (e) { log(ts(), 'chart', w.symbol, e.message); }
    if (w.txAt == null || Date.now() - w.txAt > 10 * 60e3) { try { w.txPerWallet = await gtPoolTx(snap.pair); w.txAt = Date.now(); } catch {} }
    const sec = await ensureSecurity(w);
    const b = bnMap.get(w.addr);
    const f = { ageHours: age, liquidityUsd: snap.liquidityUsd, mcapUsd: snap.mcapUsd, vol: snap.vol, vol24: snap.vol.h24,
      buys: snap.buys, sells: snap.sells, txPerWallet: w.txPerWallet ?? null, chart: chartShape(bars || [], cfg),
      holdersRisePct: holdersRise(w), netBuyUsd: b?.netBuy ?? null, smartHolders: b?.smartHolders || 0, kolHolders: b?.kolHolders || 0,
      security: sec ? { ...sec, buyTaxPct: Math.max(sec.buyTaxPct, b?.taxBuy || 0), sellTaxPct: Math.max(sec.sellTaxPct, b?.taxSell || 0) } : null };
    if (b?.washTag) f.txPerWallet = Math.max(f.txPerWallet || 0, 999);
    const ev = evaluate(f, cfg);
    return { f, ev };
  }

  async function openPaper(w, snap, res) {
    const day0 = day();
    if (Object.keys(st.positions).length >= cfg.maxPositions) return 'max_positions';
    if ((st.entriesByDay[day0] || 0) >= cfg.maxDailyEntries) return 'daily_cap';
    if (st.cash < cfg.sizeUsd) return 'no_cash';
    if ((st.cooldown[w.addr] || 0) > Date.now()) return 'cooldown';
    const pos = openPosition({ price: snap.price, liquidityUsd: snap.liquidityUsd, cfg, now: Date.now() });
    Object.assign(pos, { addr: w.addr, symbol: snap.symbol, pair: snap.pair, lastPrice: snap.price, score: res.ev.score, bonus: res.ev.bonus });
    st.cash -= cfg.sizeUsd; st.positions[w.addr] = pos; st.entriesByDay[day0] = (st.entriesByDay[day0] || 0) + 1;
    await append(ledgerFile, { type: 'open', addr: w.addr, symbol: snap.symbol, price: snap.price, fill: pos.entryPrice, sizeUsd: cfg.sizeUsd,
      stopPrice: pos.stopPrice, liquidityUsd: snap.liquidityUsd, mcapUsd: snap.mcapUsd, score: res.ev.score, bonus: res.ev.bonus,
      spike: res.ev.spike, chart: { ath: res.f.chart.ath, dd: res.f.chart.maxDrawdownPct, base: res.f.chart.baseRange, rebound: res.f.chart.reboundFromLow },
      holdersRisePct: res.f.holdersRisePct });
    log(ts(), `[OPEN paper] ${snap.symbol} ${w.addr} @${snap.price} score=${res.ev.score}`);
    return 'opened';
  }

  async function manage(snaps) {
    for (const p of Object.values(st.positions)) {
      const snap = snaps.get(p.addr); if (!snap?.price) continue;
      p.lastPrice = snap.price;
      const d = exitDecision(p, { price: snap.price, liquidityUsd: snap.liquidityUsd }, cfg, Date.now());
      p.peak = d.peak;
      if (d.type !== 'sell') continue;
      const qty = p.qtyOpen * d.fraction, proceeds = sellProceeds(qty, d.fillPrice, cfg);
      p.qtyOpen -= qty; p.proceedsUsd += proceeds; st.cash += proceeds;
      if (d.reason === 'tp1') { p.tp1Done = true; if (d.setBreakeven) p.stopPrice = p.entryPrice; }
      await append(ledgerFile, { type: p.qtyOpen > 1e-12 ? 'partial' : 'close', addr: p.addr, symbol: p.symbol, reason: d.reason, price: snap.price,
        fill: d.fillPrice, fraction: d.fraction, proceedsUsd: +proceeds.toFixed(4) });
      if (p.qtyOpen <= 1e-12 || d.fraction === 1) {
        const pnl = p.proceedsUsd - p.costUsd;
        st.realizedUsd += pnl; st.closed.push({ addr: p.addr, symbol: p.symbol, pnlUsd: +pnl.toFixed(4), pnlPct: +(pnl / p.costUsd * 100).toFixed(2),
          reason: d.reason, entryAt: p.entryAt, closedAt: Date.now() });
        st.closed = st.closed.slice(-500);
        st.cooldown[p.addr] = Date.now() + cfg.cooldownHours * 3600e3;
        delete st.positions[p.addr];
        await append(ledgerFile, { type: 'summary', addr: p.addr, symbol: p.symbol, pnlUsd: +pnl.toFixed(4), pnlPct: +(pnl / p.costUsd * 100).toFixed(2), reason: d.reason });
        log(ts(), `[CLOSE paper] ${p.symbol} ${d.reason} pnl=${pnl.toFixed(2)}U`);
      }
    }
  }

  async function tick() {
    if (Date.now() - lastDiscovery > cfg.discoverySec * 1000 || !lastDiscovery) await discover();
    const addrs = [...new Set([...Object.keys(st.watch), ...Object.keys(st.positions)])];
    const snaps = await dexSnapshot(addrs);
    for (const [a, s] of snaps) if (st.watch[a]) { st.watch[a].lastSeen = Date.now(); st.watch[a].symbol = s.symbol; st.watch[a].pair = s.pair; }
    await manage(snaps);
    const report = [];
    for (const [a, snap] of snaps) {
      const w = st.watch[a]; if (!w || st.positions[a] || !snap.price) continue;
      await sampleHolders(w, snap);
      const res = await considerEntry(w, snap).catch(e => { log(ts(), 'eval', snap.symbol, e.message); return null; });
      if (!res) continue;
      report.push({ symbol: snap.symbol, addr: a, pass: res.ev.pass, reasons: res.ev.reasons });
      if (res.ev.pass) {
        await append(signalFile, { type: 'signal', addr: a, symbol: snap.symbol, price: snap.price, score: res.ev.score, bonus: res.ev.bonus, spike: res.ev.spike, dry });
        if (!dry) { const r = await openPaper(w, snap, res); if (r !== 'opened') log(ts(), `signal ${snap.symbol} skipped: ${r}`); }
        else log(ts(), `[DRY signal] ${snap.symbol} ${a} score=${res.ev.score}`);
      } else if (res.ev.reasons.length <= 1 && Date.now() - (nearLog.get(a) || 0) > 30 * 60e3) {
        nearLog.set(a, Date.now());
        await append(signalFile, { type: 'near_miss', addr: a, symbol: snap.symbol, reasons: res.ev.reasons, price: snap.price });
      }
    }
    await save();
    return { watch: addrs.length, snaps: snaps.size, evaluated: report };
  }

  async function run() {
    await load();
    log(ts(), `old-revival paper started pid=${process.pid} strategy=${cfg.strategyId} live=false dir=${dir}`);
    for (;;) {
      try { await tick(); } catch (e) { log(ts(), 'tick error', e.stack || e.message); }
      await sleep(cfg.pollSec * 1000);
    }
  }
  return { cfg, run, tick, load, discover, considerEntry, dexSnapshot, state: () => st, writeStatus };
}
