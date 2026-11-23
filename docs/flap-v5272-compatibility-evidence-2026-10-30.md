# Flap Portal v5.27.2 compatibility evidence

核验时间：2026-10-30T10:01:04.777Z（升级区块 129871644）。结构化记录见 [JSON](./flap-v5272-compatibility-evidence-2026-10-30.json)。

## 身份

- version: `v5.27.2`
- implementation: `0x6FC1ac64c90A5A6d9E7EFc0d4064452AF3FC9968`
- implementation code hash: `0x90b3b19ddc87293d5bbd33167d7d977adf1cda5c078549b8cada05c6f9b3fa75`
- portal runtime code hash: `0x0a3fe6f701ee3cb432f45912e054896327ce5902337eae4d62d01406005a91c3`（与 v5.26 代理 runtime 相同）

## 双源升级收据

- block: `129871644`
- blockHash: `0xc4f242d2d4d38c73108c2196f25a7ea0ae03c0c99e05ec75b58eb3a2f5107914`
- tx: `0x749ff286fa0b6caccdf2974e71e8d164fe752ab5b8af4ef578ca68f901090441`
- primary: `bsc-mainnet.core.chainstack.com` receipt status `0x1`
- second: `bsc.rpc.sentio.xyz` receipt status `0x1`, same blockHash

## 接口抽查

- `getTokenV8Safe(address)` 对样本 token 的 `eth_call` 成功返回 576 bytes。
