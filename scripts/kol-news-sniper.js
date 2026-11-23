#!/usr/bin/env node
// PAPER-only KOL news sniper (CZ / 何一). Never trades live.
//   node scripts/kol-news-sniper.js --replay [--hours 24]   回放本机数据
//   node scripts/kol-news-sniper.js                         常驻纸盘（每 15s）
import path from 'node:path';
import fs from 'node:fs/promises';
import '../src/live-env-loader.js';
import 'dotenv/config';
import { evaluateKolEntry, evaluateKolExit, kolNewsSniperEnabled, loadKolFavorites, createKolNewsPaperLedger, KOL_POLICY, assetKey } from '../src/kol-news-sniper.js';
import { loadKolTweets, loadKolLaneTokens, fetchKolMark } from '../src/kol-news-data.js';

const dataDir = path.resolve(process.env.DATA_DIR || 'data');
const args = process.argv.slice(2);
const sh = (ms) => new Date(ms + 8 * 3600_000).toISOString().slice(5, 19).replace('T', ' ');
const MARK_MAX_AGE_MS = Number(process.env.KOL_NEWS_MARK_MAX_AGE_MS || 120_000);
const allowUnknownLiquidity = process.env.KOL_NEWS_PAPER_ALLOW_UNKNOWN_LIQ !== 'false';

async function replay(hours) {
  const favorites = await loadKolFavorites(dataDir);
  const tweets = await loadKolTweets(dataDir), tokens = await loadKolLaneTokens(dataDir, favorites);
  const now = Date.now(), from = now - hours * 3600_000;
  const ledger = { positions: [] }, rows = [];
  for (const record of tweets.filter((t) => t.at >= from)) {
    for (let step = 0; step <= KOL_POLICY.windowMs; step += 30_000) {
      const at = record.at + step;
      for (const token of tokens) {
        const view = { ...token, trades: token.trades.filter((t) => t.at <= at) };
        const d = evaluateKolEntry({ record, token: view, nowMs: at, favorites, ledger, allowUnknownLiquidity });
        if (d.enter) { ledger.positions.push({ address: token.address, chain: token.chain, tweetId: record.tweetId, day: d.day });
          rows.push({ tweet: `${record.label} ${sh(record.at)} ${record.text.slice(0, 30).replace(/\s+/g, ' ')}`, token: `${token.symbol} ${token.address}`,
            enterAt: sh(at), afterTweet: `${Math.round(step / 60000)}m`, trigger: d.trigger, smartMoney: d.smartMoney, liquidityUnverified: d.liquidityUnverified }); }
      }
    }
  }
  const nearMiss = [];
  for (const token of tokens) if (!rows.some((r) => r.token.endsWith(token.address))) {
    const near = tweets.filter((r) => r.at >= from).map((record) => ({ record, d: evaluateKolEntry({ record, token, nowMs: Math.min(now, record.at + KOL_POLICY.windowMs), favorites, ledger: { positions: [] }, allowUnknownLiquidity }) }))
      .sort((a, b) => a.d.reasons.length - b.d.reasons.length)[0];
    nearMiss.push({ token: `${token.symbol} ${token.address}`, createdAt: token.createdAt ? sh(token.createdAt) : null, smBuys: token.trades.filter((t) => t.side === 'buy').length, bestTweet: near ? `${near.record.label} ${sh(near.record.at)}` : null, reasons: near?.d.reasons });
  }
  const out = { generatedAt: new Date().toISOString(), hours, tweets: tweets.filter((t) => t.at >= from).length, laneTokens: tokens.length, fired: rows, notFired: nearMiss };
  await fs.writeFile(path.join(dataDir, 'kol-news-replay.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}

async function loop() {
  if (!kolNewsSniperEnabled()) { console.log('KOL_NEWS_SNIPER_ENABLED=false，退出'); return; }
  const ledgerStore = createKolNewsPaperLedger({ dataDir });
  for (;;) {
    try {
      const favorites = await loadKolFavorites(dataDir);
      const now = Date.now(), tweets = (await loadKolTweets(dataDir)).filter((t) => now - t.at <= KOL_POLICY.windowMs);
      const s = await ledgerStore.read();
      if (tweets.length) {
        const tokens = await loadKolLaneTokens(dataDir, favorites);
        for (const record of tweets) for (const token of tokens) {
          const pre = evaluateKolEntry({ record, token, nowMs: Date.now(), favorites, ledger: s, allowUnknownLiquidity: true });
          if (!pre.enter) continue;
          const mark = await fetchKolMark(token); if (Number.isFinite(mark?.liquidityUsd)) token.liquidityUsd = mark.liquidityUsd;
          // Re-read the clock AFTER network quotes: the 25m window and record time must be current.
          const now = Date.now();
          const d = evaluateKolEntry({ record, token, nowMs: now, favorites, ledger: s, allowUnknownLiquidity });
          const stale = mark && !(now - Number(mark.at) <= MARK_MAX_AGE_MS);
          if (!d.enter || !mark?.priceUsd || stale) { s.decisions.push({ at: now, kind: 'skip', address: token.address, chain: token.chain, tweetId: record.tweetId, reasons: !d.enter ? d.reasons : stale ? ['stale_price_mark'] : ['no_price_mark'] }); continue; }
          s.positions.push({ address: token.address, chain: token.chain, symbol: token.symbol, tweetId: record.tweetId, handle: record.handle, day: d.day, sizeUsd: d.sizeUsd,
            entryPrice: mark.priceUsd, entryMarkSource: mark.source, entryMarkAt: new Date(Number(mark.at)).toISOString(), entryLiquidityUsd: token.liquidityUsd, peakMultiple: 1, principalTaken: false, openedAt: now, trigger: d.trigger, smartMoney: d.smartMoney, mode: 'paper' });
          s.decisions.push({ at: now, kind: 'open', address: token.address, symbol: token.symbol, tweetId: record.tweetId, trigger: d.trigger });
          console.log(`[纸盘开仓] ${token.symbol} ${token.address} ← ${record.label} 推文 ${record.tweetId}`);
        }
      }
      for (const p of [...s.positions]) {
        const laneTok = (await loadKolLaneTokens(dataDir, [])).find((t) => assetKey(t.chain, t.address) === assetKey(p.chain, p.address));
        const mark = await fetchKolMark({ address: p.address, chain: p.chain, trades: laneTok?.trades });
        if (!mark?.priceUsd || !(Date.now() - Number(mark.at) <= MARK_MAX_AGE_MS)) { p.markMissingAt = Date.now(); continue; }
        // Keep the SOURCE quote time (UTC ISO); observedAt is our local read time.
        p.lastMark = { priceUsd: mark.priceUsd, liquidityUsd: mark.liquidityUsd ?? null, source: mark.source, at: new Date(Number(mark.at)).toISOString(), observedAt: new Date().toISOString() };
        const sells = laneTok?.trades.filter((t) => t.side === 'sell') || [];
        const e = evaluateKolExit(p, { price: mark.priceUsd, nowMs: Date.now(), lastSellAt: sells.at(-1)?.at ?? null });
        p.peakMultiple = e.peak; p.lastMultiple = e.multiple;
        if (e.action === 'sell_principal') { p.realizedUsd = (p.realizedUsd || 0) + p.sizeUsd * e.fraction * e.multiple; p.remainingFraction = 1 - e.fraction;
          // Only flag principal recovered when cumulative proceeds actually cover the stake.
          p.principalTaken = p.realizedUsd >= p.sizeUsd; p.principalTakenAt = Date.now(); }
        if (e.action === 'stop_all' || e.action === 'sell_rest') {
          const rest = p.principalTaken ? p.remainingFraction : 1; p.realizedUsd = (p.realizedUsd || 0) + p.sizeUsd * rest * e.multiple;
          p.closedAt = Date.now(); p.exitReason = e.reason; p.pnlUsd = p.realizedUsd - p.sizeUsd;
          s.closed.push(p); s.positions = s.positions.filter((x) => x !== p);
        }
        if (e.action !== 'hold') s.decisions.push({ at: Date.now(), kind: e.action, address: p.address, multiple: e.multiple, reason: e.reason });
      }
      s.decisions = s.decisions.slice(-500); s.heartbeatAt = new Date().toISOString(); s.mode = 'paper';
      await ledgerStore.write(s);
    } catch (error) { console.error('[kol-news] tick error', error.message); }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

if (args.includes('--replay')) await replay(Number(args[args.indexOf('--hours') + 1]) || 24); else await loop();
