# Flap v5.25.0 只读兼容性证据 — 2026-10-21

核查截止：北京时间 2026-10-21 01:06:30（UTC 2026-10-20 17:06:30）。原始紧凑结果见 [JSON](./flap-v525-compatibility-evidence-2026-10-21.json)。

## 结论与身份

PublicNode 与 NodeReal 在同一固定区块 **128782994**、相同前后区块哈希 `0x856db3146470b28410d177aa419ff4655205e1efedbe623f6c7806aa72f6fda4`，独立确认 BSC 56 的既有 Portal 返回 v5.25.0：

- Portal：`0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0`
- implementation：`0xE13227370996f892a56d2Ff4a30f6026887B48Fb`
- implementation runtime hash：`0xf8d56fe09f2ec5e3eeaabdbfeeb0faf55e4ed8996a55bc1b69a78e62dbb792e4`（20347 字节）
- proxy runtime hash：`0x0a3fe6f701ee3cb432f45912e054896327ce5902337eae4d62d01406005a91c3`（2882 字节，与旧 proxy 相同）

这支持精确元组适配的测试；不是任意 v5.25 字符串放行，更不是部署或收益验收。

## ABI 与 type 7 同块验证

[官方 IPortal 不可变提交](https://github.com/flap-sh/FlapVaultExample/blob/f4bf1d9d19483915dd9970447158cd3f26a3827b/src/flap/IPortal.sol) SHA-256 为 `6de1991040667e4bf6e31db1d96d50b81a1e072378fed91beaca131f8683dcd9`。本地使用的状态、配置、报价参数和事件声明仍匹配；方法 selector 在已固定新实现 runtime 中存在。未取得已验证实现源码或 source-to-bytecode 对应证明，不把接口声明当全面审计。

在上述同一区块，PublicNode 对 CA `0x16d4a9abe0c494263234b9eb312bcbbaa63a7777`、报价资产 `0x4902c5ebc598265ed2212b559b042de8a5eeec3f` 的实际返回为：

| 只读项 | 原始单位结果 |
| --- | --- |
| getTokenV8Safe | 精确 18 字段；Tradable；circulation=46525556261406890553893；转换开启 |
| getQuoteTokenConfiguration | [1,50,50,7,0]（精确 5 字段） |
| BNB 输入 | 1000000000000 wei |
| 买入报价 | 204916575645624193727 token（小于既有 circulation） |
| 该 token 数量卖为 quote | 139219268119736 |
| 该 token 数量卖为 BNB | 965161644435 wei |

调用全部是 eth_call；前后区块哈希相同。此单例证明新实现中该 type 7 读报价路径可双向返回，**不证明所有 type 7 资产可卖，也不构成实际成交或盈利**。每个 CA、金额、时点仍必须重取同块双向报价与现有安全、税费、深度和时效检查。

保留失败反例：较早固定区块 128782536，用 1e16 wei 输入得到 2044117487586652064404597 token，超过该块既有 circulation；尝试卖回 quote 时 Panic(17)。不能删除这个失败、降低安全条件或把小额成功推广到原预算。

## 仍缺证据与恢复边界

- 未取得准确 Upgraded receipt/激活交易。128501895 是已知首次观察新实现的区块：新实现至迟已在该块存在，**不是准确激活块，更不是激活下界**。
- 官方事件声明与本地解码器匹配，但对应 topic 字面值未出现在主 implementation runtime，本轮也未独立取得新事件 receipt；不能据此宣称完整事件产生路径已验证。部署必须保持规范链、地址、topic、精确布局与 receipt 校验。
- 官方地址页仍写旧版本，BscScan 403，Sourcify 无该实现验证记录。归档 missing trie、48.club storage 不支持、共享容量等待与方法冷却均保留在 JSON；未手删锁、改限速或绕过冷却。
- 原游标 128103371、锚点 128103370 必须保留。补扫不得冒充实时发现，超过 120 秒旧币不得补追。
- 共 53 次逻辑 RPC 方法调用，45 次成功、8 次错误/本地拒绝；这不是精确网络传输计数。使用原 RPC pool 与共享协调器、后台优先级、单并发，没有启动采集进程。
- 本审查未改源码/运行状态/账本，未签名、广播、实盘交易。部署与持续游标推进另由主任务验收。
