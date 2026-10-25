# Flap v5.26.0 只读兼容性证据 — 2026-10-21

核验时间：2026-10-21T10:13:58Z（固定区块），升级 receipt 交叉核验至 10:18:11Z。结构化记录见 [JSON](./flap-v526-compatibility-evidence-2026-10-21.json)。

## 固定区块身份（两路独立 RPC）

在 BSC chainId 56 的固定区块 **128920137**，PublicNode 与 BNB Chain Data Seed 返回一致的区块哈希，前后复核哈希均为 `0x3a8a8b7d2f6e7f5395d21a61b4bddb2ca53c149cf5560e7ba6cd99e0e27df7f0`。两路在同块确认：

- Portal：`0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0`；runtime hash `0x0a3fe6f701ee3cb432f45912e054896327ce5902337eae4d62d01406005a91c3`（2882 bytes）。
- EIP-1967 implementation：`0x7a94f37b61a82c395f9812CF266b444783cC5e8c`；`version()` 返回 `v5.26.0`；runtime hash `0x3db27f98826706ac5ddedb919594d4670151874482dff23e31d2186858635194`（20347 bytes）。
- token `0x16d4a9abe0c494263234b9eb312bcbbaa63a7777` 的 `getTokenV8Safe` 返回 18 个字段；quote `0x4902C5ebc598265Ed2212b559B042De8a5Eeec3f` 的配置为 `[1,50,50,7,0]`。

同块 `eth_call` 双向样本：买入 `1000000000000` wei 得 `193548545363204546601` token；将该数量卖回原生币得 `965161664547` wei，卖回 quote 得 `131495888133605`。原始数值和完整字段数在两路输出中逐项相同。该样本只证明固定 CA、金额和时点的只读方法兼容，不证明所有资产可卖、无税/滑点风险、实现源码安全或实际盈利。

## 升级边界与历史窗口

PublicNode 在 Portal 的 `Upgraded(address)` 日志中发现精确升级交易；BNB Data Seed 独立返回同一交易成功 receipt 和规范区块头：

- 激活区块：`128914179`；hash `0x025425840e296cff96ca378705da73882429d0b8cff3276c81bec26494e07616`。
- 交易：`0x04791db127459ee67718e1ce7610fc87c90483a94411b8c143d97db1bb8cd702`；receipt status `1`；`Upgraded(address)` 指向上述实现。
- PublicNode 的日志读取与 BNB Data Seed 的 receipt/区块头是不同证据；BNB Data Seed 未配置日志接口，因此不声称两家都独立查询了该日志。

先前 v5.25.0 持久化检查点是 block `128914121`，其游标为 `nextBlock=128914122`。兼容窗口将 v5.25 历史证明封顶在 `128914121`，v5.26 从精确升级块 `128914179` 开始；`128914122..128914178` 保持未知，不把任一版本证明外推到这 57 个区块。状态迁移只接受精确 v5.25.0 地址与 runtime hash，并保留游标；v5.24/v5.23.1 不可直接跨级迁移。双源身份不一致或无法验证时仍停止且不提交游标。

官方[部署地址文档](https://docs.flap.sh/flap/developers/deployed-contract-addresses)仍显示旧版本；官方 [IPortal 不可变提交](https://github.com/flap-sh/FlapVaultExample/blob/f4bf1d9d19483915dd9970447158cd3f26a3827b/src/flap/IPortal.sol)可用于核对接口声明，但没有已验证实现源码及 source-to-bytecode 对应证明。此次是精确链上身份与方法兼容性适配，不是完整安全审计。

所有链上读取均经既有 RPC pool 与共享协调器、background lane；没有增加 endpoint、并发或限频额度，没有绕过 429/cooldown，也没有使用签名或广播接口。
