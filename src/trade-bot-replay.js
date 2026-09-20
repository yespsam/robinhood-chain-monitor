import { createTradeBotState, createTradeBotReplayController, pauseTradeBotEntries,
  tradeBotSummary, TRADE_BOT_USDC, validateTradeBotState } from './trade-bot-engine.js';
import { createTradeBotStore, readTradeBotState } from './trade-bot-store.js';

// These are synthetic test identities. Never use this data as investment evidence.
const wallet = `0x${'1'.repeat(40)}`, token = `0x${'a'.repeat(40)}`, pool = `0x${'b'.repeat(40)}`;
const e18 = amount => String(BigInt(amount) * 10n ** 18n);
const later = (now, seconds) => new Date(Date.parse(now) + seconds * 1000).toISOString();
function fixtureQuote(now, sell = false) {
  return { source: 'offline_fixture', chain: 'bsc', wallet,
    inputToken: sell ? token : TRADE_BOT_USDC, outputToken: sell ? TRADE_BOT_USDC : token,
    inputAmountRaw: e18(sell ? 100 : 10), outputAmountRaw: e18(sell ? 15 : 100),
    minOutputAmountRaw: String(BigInt(e18(sell ? 15 : 100)) * 99n / 100n),
    inputDecimals: 18, outputDecimals: 18, gasUsdMicros: 150_000,
    observedAt: now, validUntil: later(now, 5) };
}
function fixtureCandidate(now) {
  return { eventKey: 'OFFLINE-SYNTHETIC-DEMO-ONLY', chainId: 56, ca: token, poolAddress: pool, observedAt: now,
    narrative: { status: 'sourced', sourceUrl: 'https://example.invalid/fixture', text: '虚构演练叙事，不是真实代币或交易信号。' },
    evidence: { observedAt: now, sourceUrls: ['https://example.invalid/fixture'], sellSimulationPassed: true,
      contractControlsReviewed: true, lpLockOrBurnVerified: true, holderDistributionReviewed: true,
      independentWalletClusterVerified: true, buyTaxBps: 0, sellTaxBps: 0, liquidityUsd: 30_000 } };
}
function fixtureReceipt(order) {
  const sell = order.side === 'sell';
  return { order_id: sell ? 'fixture-sell-1' : 'fixture-buy-1', hash: `0x${(sell ? '2' : '1').repeat(64)}`,
    status: 'successful', state: 30, report: { swap_mode: 'ExactIn', input_token: order.intent.inputToken,
      output_token: order.intent.outputToken, input_amount: order.intent.amountRaw, output_amount: e18(sell ? 15 : 100),
      input_token_decimals: 18, output_token_decimals: 18, gas_usd: '0.15' } };
}
export async function readTradeBotReplayStatus(directory) {
  const state = await readTradeBotState(directory, validateTradeBotState);
  return { label: '离线演练状态；不是实盘账户或实际收益', stateExists: Boolean(state),
    ...(state ? { summary: tradeBotSummary(state), updatedAt: state.updatedAt } : {}) };
}
export async function runTradeBotDemo({ directory, now = new Date().toISOString(), scenario = 'roundtrip' }) {
  if (!['roundtrip', 'timeout'].includes(scenario)) throw new Error('unsupported_demo_scenario');
  const store = createTradeBotStore({ directory, validate: validateTradeBotState });
  const calls = { submit: 0, query: 0 }, events = [];
  await store.open();
  try {
    if (await store.read()) throw new Error('replay_requires_new_empty_state_directory');
    await store.save(createTradeBotState({ wallet, now }));
    const broker = { mode: 'offline_fixture',
      async submit(order) {
        calls.submit++;
        if (scenario === 'timeout') throw new Error('synthetic_timeout');
        return { order_id: order.side === 'buy' ? 'fixture-buy-1' : 'fixture-sell-1', status: 'pending' };
      },
      async query(order) { calls.query++; return fixtureReceipt(order); },
    };
    let controller = createTradeBotReplayController({ store, broker });
    const entry = await controller.enter(fixtureCandidate(now), fixtureQuote(now), now);
    events.push({ step: 'entry_submit', decision: entry.decision });
    // A fresh controller demonstrates recovery from durable state, not memory.
    controller = createTradeBotReplayController({ store, broker });
    await controller.reconcile(later(now, 1));
    if (scenario === 'roundtrip') {
      let state = await store.read();
      events.push({ step: 'entry_reconcile', status: state.orders[0].status });
      state = pauseTradeBotEntries(state, true, later(now, 2)); await store.save(state);
      const exit = await controller.exit(state.orders[0].id, fixtureQuote(later(now, 2), true), later(now, 2));
      events.push({ step: 'automatic_exit_while_entries_paused', decision: exit.decision,
        reason: exit.state.orders[1]?.exitReason });
      await controller.reconcile(later(now, 3));
    } else {
      const second = await controller.enter(fixtureCandidate(later(now, 2)), fixtureQuote(later(now, 2)), later(now, 2));
      events.push({ step: 'attempt_after_timeout', decision: second.decision, reasons: second.reasons });
    }
    const state = await store.read();
    return { label: '纯离线合成数据演练；收益数字人为设置，不代表盈利能力', scenario, directory,
      networkCalls: 0, realOrdersSubmitted: 0, fixtureCalls: calls, events, summary: tradeBotSummary(state) };
  } finally { await store.close(); }
}
