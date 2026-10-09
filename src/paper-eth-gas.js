// Read-only ETH fee environment. Gas UNITS remain a disclosed paper assumption;
// this is neither a swap quote nor eth_estimateGas for a specific transaction.
import { Interface } from 'ethers';
export const ETH_RPC = 'https://ethereum-rpc.publicnode.com';
export const ETH_USD_FEED = '0x5f4ec3df9cbd43714fe2740f5e3616155c5b8419';
export const ETH_GAS_VERSION = 'eth_rpc_fee_environment_v1';
const abi = new Interface(['function decimals() view returns (uint8)', 'function description() view returns (string)',
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)']);
const MAX_AGE = 90000, PRICE_MAX_AGE = 3600000;
export function validEthGas(value, nowMs) {
  const at = Date.parse(value?.observedAt), blockAt = Date.parse(value?.blockAt), priceAt = Date.parse(value?.priceObservedAt);
  return value?.version === ETH_GAS_VERSION && value.chain === 'eth' && value.status === 'ok'
    && [at, blockAt].every(t => Number.isFinite(t) && t <= nowMs && nowMs - t <= MAX_AGE)
    && Number.isFinite(priceAt) && priceAt <= nowMs && nowMs - priceAt <= PRICE_MAX_AGE
    && Number.isFinite(value.gasPriceWei) && value.gasPriceWei > 0 && value.gasPriceWei <= 1e13
    && Number.isFinite(value.nativeUsd) && value.nativeUsd > 0 && value.nativeUsd < 1e7
    && value.gasUnits === 250000 && value.buffer === 1.25;
}
export function ethGasUsd(value, nowMs) {
  return validEthGas(value, nowMs) ? value.gasPriceWei / 1e18 * value.gasUnits * value.nativeUsd * value.buffer : null;
}
export function createEthGasMonitor({ fetchImpl = fetch, now = Date.now } = {}) {
  let value = { version: ETH_GAS_VERSION, chain: 'eth', status: 'waiting' }, pending, nextAt = 0, stopped = false;
  function snapshot() {
    return structuredClone(validEthGas(value, now()) ? value : { ...value, status: value.status === 'ok' ? 'stale' : value.status });
  }
  function refresh() {
    if (stopped || pending || now() < nextAt) return pending || Promise.resolve(snapshot());
    nextAt = now() + 30000;
    pending = (async () => {
      const observedAt = now();
      const calls = [['eth_chainId', []], ['eth_gasPrice', []], ['eth_getBlockByNumber', ['latest', false]],
        ...['decimals', 'description', 'latestRoundData'].map(name => ['eth_call', [{ to: ETH_USD_FEED, data: abi.encodeFunctionData(name) }, 'latest']])];
      const r = await fetchImpl(ETH_RPC, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(calls.map(([method, params], i) => ({ jsonrpc: '2.0', id: i + 1, method, params }))), signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('eth_fee_http');
      const rows = await r.json();
      if (!Array.isArray(rows) || rows.length !== calls.length || new Set(rows.map(x => x.id)).size !== calls.length) throw new Error('eth_fee_schema');
      const result = id => { const x = rows.find(x => x.id === id); if (!x || x.error || x.result == null) throw new Error('eth_fee_rpc'); return x.result; };
      if (BigInt(result(1)) !== 1n) throw new Error('eth_fee_chain');
      const block = result(3), decimals = Number(abi.decodeFunctionResult('decimals', result(4))[0]);
      if (decimals !== 8 || abi.decodeFunctionResult('description', result(5))[0] !== 'ETH / USD') throw new Error('eth_fee_feed');
      const [round, answer, , updatedAt, answeredInRound] = abi.decodeFunctionResult('latestRoundData', result(6));
      if (answer <= 0n || answeredInRound < round) throw new Error('eth_fee_round');
      const next = { version: ETH_GAS_VERSION, chain: 'eth', status: 'ok', observedAt: new Date(observedAt).toISOString(),
        blockAt: new Date(Number(BigInt(block.timestamp)) * 1000).toISOString(), blockNumber: Number(BigInt(block.number)),
        priceObservedAt: new Date(Number(updatedAt) * 1000).toISOString(), gasPriceWei: Number(BigInt(result(2))), nativeUsd: Number(answer) / 1e8,
        gasUnits: 250000, buffer: 1.25, source: 'ethereum_rpc_chainlink', gasUnitsSource: 'assumption_not_route_estimate' };
      if (!validEthGas(next, now())) throw new Error('eth_fee_stale');
      value = next; return snapshot();
    })().catch(() => { value = { ...value, status: 'unavailable' }; return snapshot(); }).finally(() => { pending = null; });
    return pending;
  }
  return { snapshot, refresh, stop: async () => { stopped = true; await pending; } };
}
