// Deterministic market view for the offline paper rehearsal. No network and no invented curve reserves.
import os from 'node:os';
import path from 'node:path';
import { BAR_MS, loadConfig } from './liquidity-signal.js';
import { createLiquiditySwing } from './liquidity-paper.js';

export function buildSwingBars(now, opts = {}) {
  const n = opts.n ?? 60;
  const lastT = now - BAR_MS - 30_000;
  const start = lastT - (n - 1) * BAR_MS;
  const highAt = Math.max(1, Math.min(n - 8, Math.floor(n * 0.45)));
  const bars = [];
  for (let i = 0; i < n; i++) {
    const t = start + i * BAR_MS;
    let close;
    if (opts.flat) close = i % 2 ? 0.996 : 1;
    else if (i <= highAt) close = 0.75 + 0.25 * (i / highAt);
    else if (i < n - 6) {
      const span = Math.max(1, n - 6 - highAt);
      close = 1 + (0.90 - 1) * ((i - highAt) / span);
    } else close = [0.90, 0.89, 0.885, 0.88, 0.875, 0.89][i - (n - 6)] ?? 0.89;
    if (opts.crash && i >= n - 6) close = [0.95, 0.90, 0.84, 0.78, 0.74, 0.76][i - (n - 6)];
    const open = i === n - 1
      ? (opts.crash ? 0.74 : opts.flat ? 0.994 : 0.875)
      : (i === 0 ? close * 0.99 : bars[i - 1].c);
    const c = opts.flat && i === n - 1 ? 0.998 : close;
    const o = opts.flat && i === n - 1 ? 0.994 : open;
    const wick = opts.wick && i === (opts.wickAt ?? 20);
    const h = wick ? Math.max(o, c) * 5 : Math.max(o, c) * 1.01;
    const l = Math.min(o, c) * 0.99;
    bars.push({ t, o, h, l, c, v: i === n - 1 ? 120 : 100 });
  }
  if (opts.dropFrom != null) bars.splice(opts.dropFrom, opts.dropCount ?? 3);
  const last = bars[bars.length - 1];
  return { bars, lastClose: last.c, lastT: last.t };
}

export function goodSecurity(now) {
  return {
    honeypot: false, cannotBuy: false, cannotSellAll: false, buyTaxPct: 0, sellTaxPct: 1,
    openSource: true, hiddenOwner: false, ownerChangeBalance: false, at: now,
  };
}

function txns(h1b, h1s, h6b, h6s) {
  return { h1: { buys: h1b, sells: h1s }, h6: { buys: h6b, sells: h6s } };
}

export function buildFixtureMarket(now = Date.UTC(2026, 10, 16, 4, 0, 0)) {
  const swing = buildSwingBars(now);
  const wick = buildSwingBars(now, { flat: true, wick: true });
  const snap = (addr, symbol, liquidityUsd, vol24, at, bars) => ({
    addr, symbol, quote: 'WBNB', price: bars.lastClose * 1.001, liquidityUsd, mcapUsd: 400_000, at,
    vol: { h1: Math.max(5_000, vol24 / 20), h6: Math.max(10_000, vol24 / 5), h24: vol24 },
    txns: txns(20, 16, 80, 64),
    pair: `0xpool${addr.slice(2, 6)}`,
  });
  const deepBars = swing;
  const midBars = buildSwingBars(now);
  const deep = snap('0x' + 'd'.repeat(40), 'DEEP', 200_000, 80_000, now, deepBars);
  const mid = snap('0x' + 'b'.repeat(40), 'MID', 40_000, 400_000, now, midBars);
  const shallow = snap('0x' + 'a'.repeat(40), 'SHALLOW', 8_000, 900_000, now, swing);
  const stale = { ...snap('0x' + 'e'.repeat(40), 'STALE', 180_000, 70_000, now - 10 * 60_000, swing) };
  const wicky = snap('0x' + 'c'.repeat(40), 'WICK', 150_000, 60_000, now, wick);
  const security = Object.fromEntries([deep, mid, shallow, stale, wicky].map(s => [s.addr, goodSecurity(now)]));
  return {
    now,
    snapshots: [mid, shallow, stale, wicky, deep],
    bars: { [deep.addr]: deepBars.bars, [mid.addr]: midBars.bars, [shallow.addr]: swing.bars, [stale.addr]: swing.bars, [wicky.addr]: wick.bars },
    security,
    curve: { ok: false, error: 'bnb_usd_unavailable', entries: [{ addr: '0x' + '1'.repeat(40), activity: null, state: null }] },
  };
}

/** One offline tick. Writes nothing. Throws if a market adapter is touched. */
export async function runOfflineDry(env = {}) {
  const cfg = loadConfig({ ...env, SWING_LIVE: env.SWING_LIVE });
  const market = buildFixtureMarket();
  const dir = path.join(os.tmpdir(), `swing-liq-offline-${process.pid}-${Date.now()}`);
  const boom = () => { throw new Error('offline dry-run tried to use the network'); };
  const rt = createLiquiditySwing({
    cfg, dataDir: dir, dry: true, log() {},
    io: { dexSnapshot: boom, dsSearchPairs: boom, gtPools: boom, gt5mBars: boom, goplusSecurity: boom },
  });
  const status = await rt.tick(market);
  return { status, dir, market };
}
