import test from 'node:test';
import assert from 'node:assert/strict';
import { tweetToKolRecord, nameTermsIn, evaluateKolEntry, evaluateKolExit, kolNewsSniperEnabled } from '../src/kol-news-sniper.js';

const T = 1793638478825;
const cz = tweetToKolRecord({ author: 'cz_binance', userId: '902926941413453824', id: '2117299356747604211', text: '我就不存了，额度留给兄弟们', at: T, isQuote: true });
const tok = (o) => ({ address: '0xabc', chain: 'bsc', symbol: 'CZ', createdAt: T + 60_000, liquidityUsd: 5000, trades: [
  { wallet: 'a', side: 'buy', amountUsd: 50, at: T + 90_000 }, { wallet: 'b', side: 'buy', amountUsd: 60, at: T + 100_000 }], ...o });

test('quotes become kol_tweet records; impostor ids rejected', () => {
  assert.equal(cz.sourceType, 'kol_tweet'); assert.equal(cz.isQuote, true);
  assert.equal(tweetToKolRecord({ author: 'cz_binance', userId: '1', id: '5', text: 'x', at: T }), null);
});
test('lane names: binance is NOT generic here, short latin needs boundaries', () => {
  assert.ok(nameTermsIn('币安之家').includes('币安')); assert.ok(nameTermsIn('BINANCE').includes('binance'));
  assert.deepEqual(nameTermsIn('czech'), []); assert.ok(nameTermsIn('$SAFU').includes('safu'));
});
test('entry: new launch + 2 wallets inside 25m fires; outside window/low liq/caps block', () => {
  assert.equal(evaluateKolEntry({ record: cz, token: tok(), nowMs: T + 120_000 }).enter, true);
  assert.ok(evaluateKolEntry({ record: cz, token: tok(), nowMs: T + 26 * 60_000 }).reasons.includes('outside_25m_window'));
  assert.ok(evaluateKolEntry({ record: cz, token: tok({ liquidityUsd: 2000 }), nowMs: T + 120_000 }).reasons.includes('liquidity_below_3k'));
  assert.ok(evaluateKolEntry({ record: cz, token: tok({ trades: [{ wallet: 'a', side: 'buy', amountUsd: 100, at: T + 90_000 }] }), nowMs: T + 120_000 }).reasons.includes('smart_money_unconfirmed'));
  assert.ok(evaluateKolEntry({ record: cz, token: tok({ symbol: 'PEPE' }), nowMs: T + 120_000 }).reasons.includes('name_not_in_kol_lane'));
  const ledger = { positions: [{ address: '0x1', tweetId: cz.tweetId, day: 'x' }, { address: '0x2', tweetId: cz.tweetId, day: 'x' }] };
  assert.ok(evaluateKolEntry({ record: cz, token: tok(), nowMs: T + 120_000, ledger }).reasons.includes('max_2_per_tweet'));
});
test('exit: take principal at +60%, trail 35% off peak, hard/soft stops', () => {
  const p = { entryPrice: 1, peakMultiple: 1, principalTaken: false, openedAt: 0 };
  assert.equal(evaluateKolExit(p, { price: 1.7, nowMs: 1000 }).action, 'sell_principal');
  assert.equal(evaluateKolExit(p, { price: 0.69, nowMs: 1000 }).action, 'stop_all');
  assert.equal(evaluateKolExit(p, { price: 0.79, nowMs: 200_000, lastSellAt: null }).reason, 'soft_stop_-20%_no_sell_3m');
  assert.equal(evaluateKolExit(p, { price: 0.79, nowMs: 200_000, lastSellAt: 150_000 }).action, 'hold');
  const r = { ...p, principalTaken: true, principalTakenAt: 0, peakMultiple: 3 };
  assert.equal(evaluateKolExit(r, { price: 1.9, nowMs: 1000 }).reason, 'trail_35%_off_peak');
  assert.equal(evaluateKolExit(r, { price: 2.9, nowMs: 31 * 60_000 }).reason, 'remainder_30m');
});
test('switch defaults on, can be disabled', () => {
  assert.equal(kolNewsSniperEnabled({}), true); assert.equal(kolNewsSniperEnabled({ KOL_NEWS_SNIPER_ENABLED: 'false' }), false);
});

// ---- Medium 4/5/6 ----
import { assetKey, KOL_POLICY } from '../src/kol-news-sniper.js';
test('M5: closed positions still count toward per-day / per-tweet limits; same tweet+token not re-bought', () => {
  const day = new Date(T + 120_000 + 8 * 3600_000).toISOString().slice(0, 10);
  const closed = [1, 2, 3, 4].map((i) => ({ address: '0x' + String(i).repeat(40), chain: 'bsc', tweetId: 't' + i, day }));
  assert.ok(evaluateKolEntry({ record: cz, token: tok(), nowMs: T + 120_000, ledger: { positions: [], closed } }).reasons.includes('max_4_per_day'));
  const again = { positions: [], closed: [{ address: '0xabc', chain: 'bsc', tweetId: cz.tweetId, day: 'x' }] };
  assert.ok(evaluateKolEntry({ record: cz, token: tok(), nowMs: T + 120_000, ledger: again }).reasons.includes('tweet_token_already_consumed'));
});
test('M6: principal sale at 1.6x actually recovers >= 100% of stake', () => {
  const e = evaluateKolExit({ entryPrice: 1, peakMultiple: 1, principalTaken: false, openedAt: 0 }, { price: KOL_POLICY.takeProfitMultiple, nowMs: 1 });
  assert.equal(e.action, 'sell_principal');
  assert.ok(e.fraction * e.multiple >= 1, `recovered ${e.fraction * e.multiple}`);
});
test('M4: solana addresses keep case; EVM case-insensitive; chain is part of identity', () => {
  const s = 'BngAfLZxaWN2QvpFhRbUHydYGr8zA7YTSA178G8Epump';
  assert.equal(assetKey('solana', s), 'sol:' + s);
  assert.notEqual(assetKey('sol', s), assetKey('sol', s.toLowerCase()));
  assert.equal(assetKey('bsc', '0xABCDEFabcdef0000000000000000000000000000'), assetKey('bsc', '0xabcdefabcdef0000000000000000000000000000'));
  assert.notEqual(assetKey('bsc', '0x' + '1'.repeat(40)), assetKey('base', '0x' + '1'.repeat(40)));
});
