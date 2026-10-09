import { CHAIN_GAS_VERSION, GAS_NETWORKS } from '../../src/paper-chain-gas.js';
export function gasFixture(chain,nowMs,usd=2) {
  return {version:CHAIN_GAS_VERSION,chain,native:GAS_NETWORKS[chain].native,status:'ok',observedAt:new Date(nowMs).toISOString(),
    priceObservedAt:new Date(nowMs-1000).toISOString(),nativeUsd:100,gasUsd:usd,scope:'recent_chain_swaps_not_exact_route',
    samples:[{hash:chain==='sol'?'1'.repeat(88):'0x'+'1'.repeat(64),at:new Date(nowMs-2000).toISOString(),feeNative:usd/100}]};
}
