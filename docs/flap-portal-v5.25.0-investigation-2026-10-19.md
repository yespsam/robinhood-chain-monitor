# Flap v5.25.0 身份与适配核查 — 2026-10-19

核查截止：2026-10-19 05:58:26 UTC（北京时间 13:58）。状态：`blocked_evidence`。

## 结论

BSC 的同一 Flap Portal 已由两个独立公共 RPC 在同一固定区块确认返回 v5.25.0，并且 implementation 地址与代码哈希一致。当前程序仍精确固定 v5.24.0，因此停止接受新身份是安全门控生效，不应仅修改版本字符串放行。

本轮没有修改 Flap pin、运行状态、历史游标或策略；未重启进程。已知新身份不等于接口与报价路径已经完成运行验收。结构化证据见 [对应 JSON](./flap-portal-v5.25.0-investigation-2026-10-19.json)。

## 双源固定区块证据

核验时间为 05:56:14.808 UTC。使用项目现有 RPC pool 与共享协调器，后台优先级、每池并发 1；未改限频或冷却。BNB Chain 官方公共端点和 PublicNode 对以下字段完全一致，查询前后区块哈希未变化：

| 字段 | 结果 |
| --- | --- |
| 链与 Portal | BSC 56；`0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0` |
| 固定区块 | `128501895`（`0x7a8c887`），2026-10-19 05:55:38 UTC |
| 区块哈希 | `0x52cdebb172266fec725d0a78a5b31a5826663f96816fcb32330fc973066a766b` |
| version() | `v5.25.0` |
| EIP-1967 implementation | `0xE13227370996f892a56d2Ff4a30f6026887B48Fb` |
| Proxy runtime hash | `0x0a3fe6f701ee3cb432f45912e054896327ce5902337eae4d62d01406005a91c3`（2882 字节，与原固定值一致） |
| Implementation runtime hash | `0xf8d56fe09f2ec5e3eeaabdbfeeb0faf55e4ed8996a55bc1b69a78e62dbb792e4`（20347 字节） |

共完成 16 次显式只读方法调用（含初始 chain/head）；该数字是逻辑调用数，不冒充底层传输请求精确计数。

## 接口审查与未解决项

[官方地址文档](https://docs.flap.sh/flap/developers/deployed-contract-addresses)仍标注 v5.23.1，不能据其版本文字确认 v5.25 的实现兼容性。

[官方 IPortal 接口](https://raw.githubusercontent.com/flap-sh/FlapVaultExample/main/src/flap/IPortal.sol)的当前主分支仍保留本地使用的五字段报价配置、TokenCreated/TokenBought/TokenSold 事件、18 字段 TokenStateV8Safe 和 quoteExactInput 三字段参数结构。这支持“接口表面可能兼容”的假设，但该主分支文件尚未绑定到本轮实现代码哈希，不是完整适配证明。尤其公开枚举只说明 nativeToQuoteSwapType 0–6，本地 type 7 能力证据来自旧 v5.24 的固定区块，不能移用为 v5.25 的授权。

05:56:50 UTC 对旧游标起始的首个 5,000 区块尝试查询 Upgraded 日志：官方 BNB 池本地排除了不支持日志的端点；PublicNode 返回 403，并由共享客户端给出约 60 秒冷却。随即停止所有后续 RPC，没有循环重试或换通道绕过。此范围未覆盖整个停扫区间，且没有成功返回，不能据此说“没有升级日志”。公开 [BscScan implementation 页面](https://bscscan.com/address/0xE13227370996f892a56d2Ff4a30f6026887B48Fb#code)本次也无法读取，未取得已验证源码或升级交易链接。

仍缺：

1. 成功的升级 receipt、规范区块交易包含证明及准确激活区块。
2. 与新 implementation 绑定的代码/ABI兼容证据，覆盖报价配置、创建/买卖事件和 token 状态布局。
3. 现用报价路径（尤其 type 7）的同区块买卖双向能力验证。形状相同不保证经济语义相同。
4. 保留历史证据与全部队列的 v5.24 → v5.25 显式迁移回归。

## 安全适配方案（尚未实施）

证据齐全后，更新完整 version/address/hash 元组；只接受已知 v5.24 前驱，保留已有 v5.23.1 → v5.24 升级证据，未知身份继续拒绝。迁移仅在当前双源身份核验与原子持久化成功后确认，并测试写失败、重启和分叉处理。

现有游标保持 `nextBlock=128103371`、锚点 `128103370`，基线时间保持 `2026-09-03T09:53:09.737Z`。后续必须从该游标继续，不能跳到最新区块，不能将补扫描述成实时发现；超过 120 秒的旧币不能补追模拟入场。此报告不代表 Flap 已恢复，也不代表停扫缺口已补齐。
