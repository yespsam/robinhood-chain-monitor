import { Denied } from './auth.mjs';
import { validContract, formatUnits, NATIVE } from './model.mjs';

// Public deployments verified against the official PTAH frontend at ptah.trade.
// These identify protocols, never a user's wallet, inventory, or transactions.
export const BSC_CONTRACTS = Object.freeze({
  usdt: '0x55d398326f99059fF775485246999027B3197955',
  ptah: '0x5E188BE77bBCA3F5371C4f974e82e1b5dD0A015A',
  relic: '0xe8C6b38b5E63377a96b268319B66638f772254bb',
  loom: '0x94C7e58e1412593eEE7456982EFC6F75BB08D02e',
  mining: '0xCd99EA61210c61fC0E7D3F09234d790C76810cF6'
});
export const BSC_RPC_ENDPOINTS = Object.freeze(['https://bsc-dataseed.bnbchain.org', 'https://bsc-rpc.publicnode.com']);
const SOURCE = 'BSC public JSON-RPC';
const SELECTOR = Object.freeze({ balanceOf: '0x70a08231', decimals: '0x313ce567', emissionStartTime: '0xb55e511d',
  reserve: '0xcd3293de', claimable: '0x402914f5', weightOf: '0xdd4bc101', totalWeight: '0x96c82e57' });
const MESSAGES = Object.freeze({ RPC_UNAVAILABLE: '公共链节点暂时不可用', RPC_INVALID_RESPONSE: '链节点响应格式无效',
  RPC_READ_FAILED: '链上读取失败', RPC_WRONG_CHAIN: '节点返回的网络不匹配', RPC_STALE_BLOCK: '节点区块时间过旧或异常',
  RPC_SNAPSHOT_CHANGED: '读取期间区块发生变化，请刷新', RPC_INVALID_DECIMALS: '代币精度未能核实',
  RPC_DEPENDENCY_UNAVAILABLE: '依赖的代币精度未能读取' });
class ReadFailure extends Error { constructor(code) { super(code); this.code = code; } }
const failureCode = error => Object.hasOwn(MESSAGES, error?.code) ? error.code : 'RPC_READ_FAILED';
const hexQuantity = value => {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]{0,63})$/.test(value)) throw new ReadFailure('RPC_INVALID_RESPONSE');
  return BigInt(value);
};
const uint256 = value => {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw new ReadFailure('RPC_INVALID_RESPONSE');
  return BigInt(value).toString();
};
function validateRpcRead(method, params) {
  if (!Array.isArray(params)) throw new Denied('RPC_METHOD_NOT_ALLOWED', 400);
  const tag = x => typeof x === 'string' && /^0x[0-9a-fA-F]{1,16}$/.test(x);
  if (['eth_chainId', 'eth_blockNumber'].includes(method) && params.length === 0) return;
  if (method === 'eth_getBlockByNumber' && params.length === 2 && tag(params[0]) && params[1] === false) return;
  if (method === 'eth_getBalance' && params.length === 2 && tag(params[1])) { validContract('56', params[0]); return; }
  if (method === 'eth_call' && params.length === 2 && tag(params[1])) {
    const call = params[0];
    if (call && Object.keys(call).length === 2 && typeof call.to === 'string' && typeof call.data === 'string' &&
        Object.values(BSC_CONTRACTS).some(a => a.toLowerCase() === call.to.toLowerCase()) &&
        Object.values(SELECTOR).some(s => call.data.startsWith(s)) && /^0x[0-9a-fA-F]{8}(?:[0-9a-fA-F]{64})?$/.test(call.data)) return;
  }
  throw new Denied('RPC_METHOD_NOT_ALLOWED', 400);
}

export function createPublicBscRpc({ fetchImpl = globalThis.fetch, timeoutMs = 6000 } = {}) {
  let sequence = 0;
  return async (method, params) => {
    validateRpcRead(method, params);
    for (const endpoint of BSC_RPC_ENDPOINTS) {
      const id = ++sequence;
      try {
        const response = await fetchImpl(endpoint, { method: 'POST', redirect: 'error',
          headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(timeoutMs),
          body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
        if (!response.ok) continue;
        // No arbitrary server response can allocate an unbounded string.
        const reader = response.body.getReader(); let size = 0; const chunks = [];
        try {
          for (;;) {
            const { value, done } = await reader.read(); if (done) break;
            size += value.byteLength; if (size > 256 * 1024) throw new ReadFailure('RPC_INVALID_RESPONSE');
            chunks.push(Buffer.from(value));
          }
        } finally { await reader.cancel().catch(() => {}); }
        const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (json.jsonrpc !== '2.0' || json.id !== id || json.error || !Object.hasOwn(json, 'result')) continue;
        return json.result;
      } catch { /* Fixed public fallback only; never expose raw provider text or request data. */ }
    }
    throw new ReadFailure('RPC_UNAVAILABLE');
  };
}
async function boundedMap(items, operation) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, async () => {
    for (;;) { const index = next++; if (index >= items.length) return; await operation(items[index]); }
  }));
}
function checkedBlock(raw, number, now) {
  if (!raw || hexQuantity(raw.number) !== number || typeof raw.hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(raw.hash))
    throw new ReadFailure('RPC_INVALID_RESPONSE');
  const seconds = hexQuantity(raw.timestamp);
  if (seconds > BigInt(Math.floor(now / 1000) + 30) || seconds < BigInt(Math.floor(now / 1000) - 180)) throw new ReadFailure('RPC_STALE_BLOCK');
  return { number: number.toString(), hash: raw.hash, timestamp: new Date(Number(seconds) * 1000).toISOString() };
}

export function createPortfolioReader({ rpc = createPublicBscRpc(), clock = Date.now } = {}) {
  return async ({ chainId, walletAddress }) => {
    if (chainId !== '56') throw new Denied('PORTFOLIO_CHAIN_UNSUPPORTED', 400);
    validContract('56', walletAddress);
    const addressWord = walletAddress.slice(2).toLowerCase().padStart(64, '0');
    const values = {}, errors = [], codes = {};
    let block = null;
    const addError = (field, error) => {
      const code = failureCode(error); codes[field] = code; errors.push({ field, code, message: MESSAGES[code] });
    };
    const call = (to, selector, address = false) => ['eth_call', [{ to, data: selector + (address ? addressWord : '') }]];
    const jobs = [
      ['bnb', ['eth_getBalance', [walletAddress]], x => hexQuantity(x).toString()],
      ['usdt', call(BSC_CONTRACTS.usdt, SELECTOR.balanceOf, true)],
      ['usdtDecimals', call(BSC_CONTRACTS.usdt, SELECTOR.decimals)],
      ['ptah', call(BSC_CONTRACTS.ptah, SELECTOR.balanceOf, true)],
      ['ptahDecimals', call(BSC_CONTRACTS.ptah, SELECTOR.decimals)],
      ['relic', call(BSC_CONTRACTS.relic, SELECTOR.balanceOf, true)],
      ['loom', call(BSC_CONTRACTS.loom, SELECTOR.balanceOf, true)],
      ['emissionStartTime', call(BSC_CONTRACTS.mining, SELECTOR.emissionStartTime)],
      ['reserve', call(BSC_CONTRACTS.mining, SELECTOR.reserve)],
      ['claimable', call(BSC_CONTRACTS.mining, SELECTOR.claimable, true)],
      ['weight', call(BSC_CONTRACTS.mining, SELECTOR.weightOf, true)],
      ['totalWeight', call(BSC_CONTRACTS.mining, SELECTOR.totalWeight)]
    ];
    try {
      if (hexQuantity(await rpc('eth_chainId', [])) !== 56n) throw new ReadFailure('RPC_WRONG_CHAIN');
      const head = hexQuantity(await rpc('eth_blockNumber', []));
      const number = head > 2n ? head - 2n : head, tag = '0x' + number.toString(16);
      block = checkedBlock(await rpc('eth_getBlockByNumber', [tag, false]), number, clock());
      await boundedMap(jobs, async ([key, [method, params], parse = uint256]) => {
        try { values[key] = parse(await rpc(method, [...params, tag])); }
        catch (error) { addError(key, error); }
      });
      const after = checkedBlock(await rpc('eth_getBlockByNumber', [tag, false]), number, clock());
      if (after.hash !== block.hash || after.timestamp !== block.timestamp) throw new ReadFailure('RPC_SNAPSHOT_CHANGED');
    } catch (error) {
      addError('snapshot', error); for (const key of Object.keys(values)) delete values[key]; block = null;
    }
    const observedAt = new Date(clock()).toISOString();
    const decimals = key => {
      if (values[key] === undefined) return null;
      const n = BigInt(values[key]);
      if (n > 255n) { addError(key, new ReadFailure('RPC_INVALID_DECIMALS')); return null; }
      return Number(n);
    };
    const usdtDecimals = decimals('usdtDecimals'), ptahDecimals = decimals('ptahDecimals');
    const quantity = key => values[key] ?? null;
    const human = (key, precision) => quantity(key) === null || precision === null ? null : formatUnits(quantity(key), precision);
    const codeFor = key => codes[key] || codes.snapshot || null;
    const asset = (key, symbol, name, contract, precision) => {
      const balance = human(key, precision);
      return { symbol, name, contract, chainId, decimals: precision, rawBalance: quantity(key), balance,
        priceUsd: null, valueUsd: null, status: balance === null ? 'unavailable' : 'ok', source: SOURCE, observedAt,
        errorCode: balance === null ? codeFor(key) || codes[key + 'Decimals'] || 'RPC_DEPENDENCY_UNAVAILABLE' : null };
    };
    const assets = [asset('bnb', 'BNB', 'BNB', NATIVE, 18), asset('usdt', 'USDT', 'Tether USD', BSC_CONTRACTS.usdt, usdtDecimals),
      asset('ptah', 'PTAH', 'PTAH', BSC_CONTRACTS.ptah, ptahDecimals)];
    const nfts = [['relic', 'RELIC', 'PTAH Relic'], ['loom', 'LOOM', 'PTAH Loom']].map(([key, symbol, name]) => ({
      symbol, name, contract: BSC_CONTRACTS[key], quantity: quantity(key), status: quantity(key) === null ? 'unavailable' : 'ok',
      source: SOURCE, observedAt, errorCode: codeFor(key)
    }));
    const start = quantity('emissionStartTime');
    let emissionStartAt = null, emissionStarted = null;
    if (start !== null && block) {
      const seconds = BigInt(start);
      emissionStarted = seconds > 0n && seconds <= BigInt(Math.floor(Date.parse(block.timestamp) / 1000));
      if (seconds > 0n && seconds <= 8640000000000n) emissionStartAt = new Date(Number(seconds) * 1000).toISOString();
    }
    const mining = { contract: BSC_CONTRACTS.mining, emissionStartTime: start, emissionStartAt, emissionStarted,
      reserveRaw: quantity('reserve'), reserve: human('reserve', ptahDecimals), claimableRaw: quantity('claimable'),
      claimable: human('claimable', ptahDecimals), weight: quantity('weight'), totalWeight: quantity('totalWeight'),
      status: ['emissionStartTime', 'reserve', 'claimable', 'weight', 'totalWeight'].every(k => quantity(k) !== null) && ptahDecimals !== null ? 'ok' : 'unavailable',
      source: SOURCE, observedAt };
    return { mode: 'live', chainId, walletAddress, observedAt, block,
      status: block === null || Object.keys(values).length === 0 ? 'unavailable' : errors.length ? 'partial' : 'ok', complete: errors.length === 0,
      assets, nfts, mining, errors, source: SOURCE, totalComplete: false, knownValueUsd: null, pnl: null,
      coverage: '仅跟踪 BSC 的 BNB、USDT、PTAH、Relic 与 Loom；不代表钱包全部资产。未接入可靠市价，未计算估值。',
      pnlReason: '缺少成本和完整资金流数据，未计算盈亏' };
  };
}
