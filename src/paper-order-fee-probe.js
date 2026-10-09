// Read-only diagnostic. Never authorizes a paper fill and never signs/sends.
// eth_simulateV1 uses ephemeral state: https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-eth
import { createHash } from 'node:crypto';

export const ORDER_FEE_PROBE_VERSION = 'order_bound_roundtrip_probe_v1';
const NETWORKS = Object.freeze({
  bsc: { id: 56, rpc: 'https://bsc-dataseed.bnbchain.org' },
  eth: { id: 1, rpc: 'https://ethereum-rpc.publicnode.com' },
});
const ZERO = '0x' + '0'.repeat(40);
const ADDRESS = /^0x[0-9a-f]{40}$/i;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function uint(value) {
  if (typeof value !== 'string' || !/^(0x[0-9a-f]+|[0-9]+)$/i.test(value)) throw Error('invalid_quantity');
  return BigInt(value);
}
function same(a, b) { return typeof a === 'string' && a.toLowerCase() === b.toLowerCase(); }
function requireQuote(q, expected, now) {
  const t = q?.tx;
  if (!t) throw Error('quote_binding_tx');
  const checks = { chain: t.chain_id === expected.chainId, wallet: same(t.from_address, expected.wallet),
    input: same(t.input_token_address, expected.input), output: same(t.output_token_address, expected.output),
    amount: uint(t.amount_in) === BigInt(expected.amount), router: ADDRESS.test(t.to),
    calldata: /^0x[0-9a-f]{8}(?:[0-9a-f]{2})+$/i.test(t.data || '') && t.data.length <= 200000,
    // Live GMGN sell routes return metadata deadline=0. Do not manufacture a
    // future expiry: the pinned EVM call must still succeed and our request
    // age is bounded independently. Positive expired deadlines are rejected.
    deadline: Number.isSafeInteger(t.deadline) && (t.deadline === 0 || t.deadline * 1000 > now),
    approvals: Array.isArray(t.approve_txs) && t.approve_txs.length <= 2,
    value: uint(t.value) === (expected.input === ZERO ? BigInt(expected.amount) : 0n) };
  const failure = Object.entries(checks).find(([, ok]) => !ok);
  if (failure) throw Error(`quote_binding_${failure[0]}`);
  // Amounts are validated separately from calldata; a hash retains the exact
  // route identity, but the raw unsigned transaction is not exposed in output.
  if (uint(t.amount_out) <= 0n || uint(t.amount_min_out) <= 0n || uint(t.amount_min_out) > uint(t.amount_out)) throw Error('quote_output');
  if (expected.input === ZERO && t.approve_txs.length) throw Error('unexpected_buy_approval');
  const approvals = t.approve_txs.map(a => {
    if (!same(a.from, expected.wallet) || !same(a.to, expected.input) || uint(a.value) !== 0n
      || !/^0x095ea7b3[0-9a-f]{128}$/i.test(a.data || '')
      || !same('0x' + a.data.slice(34, 74), t.to)
      || uint('0x' + a.data.slice(10, 74)) >> 160n
      || uint('0x' + a.data.slice(74)) < BigInt(expected.amount)) throw Error('approval_binding');
    return { from: expected.wallet, to: a.to, data: a.data, value: '0x0' };
  });
  return { tx: { from: expected.wallet, to: t.to, data: t.data, value: '0x' + uint(t.value).toString(16) }, approvals };
}

export function createPaperOrderFeeProbe({ quote, fetchImpl = fetch, now = Date.now } = {}) {
  if (typeof quote !== 'function') throw TypeError('readonly quote function required');
  async function rpc(network, method, params) {
    // Static method allow-list: this module has no transaction submission path.
    if (!['eth_chainId', 'eth_getBlockByNumber', 'eth_gasPrice', 'eth_simulateV1'].includes(method)) throw Error('readonly_method');
    const r = await fetchImpl(network.rpc, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(12000) });
    if (!r.ok) throw Error(`rpc_http_${r.status}`);
    const text = await r.text();
    if (text.length > 4000000) throw Error('rpc_response_large');
    const v = JSON.parse(text);
    if (v.id !== 1 || v.error || v.result == null) throw Error(`rpc_${method}_unavailable`);
    return v.result;
  }
  async function run({ chain, address, wallet, inputAmount }) {
    const network = NETWORKS[chain], started = now();
    if (!network || !ADDRESS.test(address) || !ADDRESS.test(wallet) || same(address, ZERO)
      || uint(inputAmount) <= 0n || uint(inputAmount) > 10n ** 18n) throw Error('invalid_probe_request');
    const request = { chain, address: address.toLowerCase(), inputAmount };
    const base = { version: ORDER_FEE_PROBE_VERSION, ...request, accountingEligible: false,
      execution: false, signing: false, broadcast: false, scope: 'same_block_roundtrip_diagnostic_only' };
    const ensureFresh = () => { if (now() < started || now() - started > 60000) throw Error('probe_stale'); };
    try {
      const identity = await rpc(network, 'eth_chainId', []);
      if (uint(identity) !== BigInt(network.id)) throw Error('wrong_rpc_chain');
      const buy = await quote({ chain, wallet, input: ZERO, output: address, amount: inputAmount });
      const b = requireQuote(buy, { chainId: network.id, wallet, input: ZERO, output: address, amount: inputAmount }, now());
      const block = await rpc(network, 'eth_getBlockByNumber', ['latest', false]);
      if (!/^0x[0-9a-f]{64}$/i.test(block.hash || '') || uint(block.number) <= 0n
        || Number(uint(block.timestamp)) * 1000 > now() + 5000
        || now() - Number(uint(block.timestamp)) * 1000 > 60000) throw Error('stale_block');
      const gasPrice = uint(await rpc(network, 'eth_gasPrice', []));
      if (gasPrice <= 0n || gasPrice > 10n ** 13n) throw Error('invalid_gas_price');
      const balanceCall = { from: wallet, to: address, data: '0x70a08231' + wallet.slice(2).padStart(64, '0'), value: '0x0' };
      // Only the native balance is ephemeral; token storage/code is not changed.
      const simulate = async calls => {
        ensureFresh();
        const result = await rpc(network, 'eth_simulateV1', [{ blockStateCalls: [{
          stateOverrides: { [wallet]: { balance: '0x' + (uint(inputAmount) + 10n ** 18n).toString(16) } }, calls,
        }], validation: false }, block.number]);
        const outcomes = result?.[0]?.calls;
        if (result?.length !== 1 || !Array.isArray(outcomes) || outcomes.length !== calls.length
          || outcomes.some(c => c.status !== '0x1' || c.error || uint(c.gasUsed) <= 0n)) throw Error('simulation_failed');
        return outcomes;
      };
      const first = await simulate([balanceCall, b.tx, balanceCall]);
      const before = uint(first[0].returnData), received = uint(first[2].returnData) - before;
      if (received <= 0n || received < uint(buy.tx.amount_min_out)) throw Error('received_output_mismatch');
      const sellAmount = received.toString();
      const sell = await quote({ chain, wallet, input: address, output: ZERO, amount: sellAmount });
      const s = requireQuote(sell, { chainId: network.id, wallet, input: address, output: ZERO, amount: sellAmount }, now());
      const calls = [balanceCall, b.tx, balanceCall, ...s.approvals, s.tx, balanceCall];
      const result = await simulate(calls);
      if (uint(result[0].returnData) !== before || uint(result[2].returnData) - before !== received
        || uint(result.at(-1).returnData) !== before) throw Error('roundtrip_balance_mismatch');
      const head = await rpc(network, 'eth_getBlockByNumber', [block.number, false]);
      if (head.hash !== block.hash) throw Error('block_reorganized');
      ensureFresh();
      const nativeUsd = Number(buy.tx.token_in_usd_price);
      if (!Number.isFinite(nativeUsd) || nativeUsd <= 0 || nativeUsd > 1e7) throw Error('native_quote_price');
      const fee = c => ({ simulatedGasUsed: uint(c.gasUsed).toString(),
        estimatedNative: Number(uint(c.gasUsed) * gasPrice) / 1e18,
        estimatedUsd: Number(uint(c.gasUsed) * gasPrice) / 1e18 * nativeUsd });
      const legs = { buy: fee(result[1]), approvals: result.slice(3, -2).map(fee), sell: fee(result.at(-2)) };
      return { ...base, status: 'roundtrip_simulated', observedAt: new Date(now()).toISOString(),
        block: { number: block.number, hash: block.hash }, routeHash: hash({ chain, b, s, inputAmount, sellAmount }),
        receivedTokenRaw: sellAmount, gasPriceWei: gasPrice.toString(), nativeUsd, nativeUsdSource: 'gmgn_order_quote',
        gasPriceSource: 'eth_gasPrice', legs,
        roundtripEstimatedGasUsd: [legs.buy, ...legs.approvals, legs.sell].reduce((n, v) => n + v.estimatedUsd, 0),
        note: '相同区块、临时余额下的买入/授权/卖出 Gas 估算；非实付、非未来退出报价。未接主账本，不含独立小费；不能据此恢复新仓。' };
    } catch (error) {
      // Do not persist upstream CLI stderr (could contain credential metadata).
      const known = /^(quote_binding_[a-z]+|quote_output|approval_binding|unexpected_buy_approval|wrong_rpc_chain|stale_block|invalid_gas_price|probe_stale|simulation_failed|received_output_mismatch|roundtrip_balance_mismatch|block_reorganized|native_quote_price|invalid_quantity|rpc_[a-zA-Z0-9_]+)$/;
      return { ...base, status: 'unavailable', observedAt: new Date(now()).toISOString(),
        reason: known.test(error.message) ? error.message : 'readonly_probe_failed' };
    }
  }
  return { run };
}
