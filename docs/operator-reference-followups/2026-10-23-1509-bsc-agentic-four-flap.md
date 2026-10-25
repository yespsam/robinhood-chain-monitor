# 2026-10-23 15:09 UTC — BSC A/B 头页、Four/Flap 与 Agentic 线索复核

## 本轮范围

按既有轮换检查 BSC A/B 各一页最新活动，并复核本地 Four/Flap、模拟盘与利润保留对照检查点；另核对 Four.Meme、Flap、Binance 官方公开规则。计划唤醒时间为 `2026-10-23T15:09:50.992Z`，面板/退出检查成功时间为 `2026-10-23T15:17:07.213Z`。本轮累计耗时约 7 分钟，超过目标 5 分钟；不补跑历史页，也不额外重试。

## BSC 钱包头页

GMGN `config --check` 通过后，经 `src/gmgn-flow-client.js` 默认优先级 0 顺序刷新 A/B，各 1 次，共 2 次成功业务请求，0 次公开 RPC、0 次模型请求。两次各返回 20 条，头页最新时间仍约为 `2026-10-02T11:08:09Z`，与既有最后已知时间相同。响应包装只有 `activities` 与 `next`；抽样行带 BSC 与对应钱包字段，但未逐行验证完整身份，也没有保存本轮每条交易哈希，故 `pageOverlap`、`newRows` 均为 `null`，不能把重复页记成新证据。

A/B 的 `lastNewEvidenceAt` 保持原值，不更新 `providerLatestActivityAt` 之外的历史证据；历史分页缺口、旧游标和 B 的 nonce 分类缺口均保留。此次没有确认新增买卖，也不据此认定钱包不活跃。下一次需要在保持限频的前提下保留头页返回的游标与哈希集合，才能给出可核对的去重统计。

## Four / Flap 采集健康

- Four：本地双源链头证明在 `13:00:05Z`，safe head `129326125`，证明时扫描游标 `129326094`，落后 32 块；当前时刻没有更新的链头证明，故当前落后块数为 `null`。registry 状态最近更新时间同为 `12:59:59Z`，不能把旧证明当作当前链头。
- Flap：最近双源链头证明在 `11:17:03Z`，证明时落后 18 块。quote 状态在 `15:14:44Z` 仍可读，游标已到 `129316431`，但对应链头证明过旧，当前落后块数仍为 `null`。该状态为 `degraded`，连续失败 28 次，最近错误 `FLAP_QUOTE_CHAIN_ID_UNAVAILABLE`（全部 BSC RPC 的 `eth_chainId` 查询失败/超时）；下次本地退避检查为 `15:19:44Z`。本轮没有发起额外 RPC。
- 本机 `/api/strategy-state` 的首次 5 秒只读请求超时；后续请求在 `15:17:07Z` 成功。报价机会调度器版本为 `evidence_preserving_event_lease_v1`，记忆中的 lease 数为 0；退出监控正在运行、间隔 1 秒、累计 96,988 次检查、无 stale quote、无错误。主进程 PID `48659` 与 BSC PID `30967` 在本机进程表中存在；这不证明检查间持续在线，未重启进程。

## 模拟前向与独立 2x/3x/5x 对照

只读复核脚本在 `15:13:47Z` 生成快照：模拟账本从上一检查的 317 笔增至 321 笔，新增成交 ID `317`–`320`，对应两个新平仓回合：

- `1792747849174:317`（BSC，CA `0x4237e9d772a46f54abea96e157430b6aeb7e7777`）：扣费净收益 `-$1.491774`。
- `1792758835045:319`（BSC，CA `0x0c6302401aa5325c2e36f170f52c00b1d220b405`）：扣费净收益 `+$0.278495`。

这两笔实际前向回合合计 `-$1.213279`。当前版累计为 26 个完整回合、净收益 `-$6.718546`、模拟成本 `$8.342110`，仍属收集样本，不与旧版或多臂假设相加。快照中 3 个未平仓头寸有新鲜估值（`15:13Z`），浮动净损益约 `-$8.993780`；补款不作利润。

利润保留 shadow 的三组 cursor 都与源账本一致，指向 321 笔、末 ID `1792761076261:320`、同一前缀哈希；状态 `observing`，8 个已完成 pair、0 个开放 pair、无错误。相对已报告 pair IDs `305/307/309/311`，本次新增完整 ID 为 `313/315/317/319`。对 2x、3x、5x，各自独立假设结果相同：扣费净收益 `-$2.687293`，对原退出差额 `$0`，回本恢复本金 `0` 次、未触发 `4` 次、负收益失败 `3` 次、盈亏平衡 `0` 次；最高回撤 `$2.965788`。四个 CA 各一回合，唯一正贡献 CA `0x0c6302401aa5325c2e36f170f52c00b1d220b405` 占正收益 `100%`；剔除它后净收益 `-$2.965788`。退出后没有足够的后续报价窗口，提前卖飞损失记为 `null`，不是 0。

四个新增 pair 均保留报价覆盖缺口；累计 gap 从已报 127 增至 322，本次增加 195（missing quote 64、pre-entry 9、out-of-order 116、stale 6）。三组假设共用同一批报价，不把 gap 或收益乘三，不选赢家、不切换主盘。shadow 仅模拟观察，执行/签名/广播关闭。

## Four.Meme / Flap 与 Binance Agentic Wallet 规则

本轮官方资料没有发现“只有 Binance AI Pro / Agentic Wallet 才能在 Four.Meme 或 Flap 发射”的官方条款：

- Four.Meme 官方 Agent Skill 面向可运行终端并加载技能的通用 agent；官方 Phase 1 说明可让用户 agent 创建代币、交互内部市场。它不是 Binance Agentic Wallet 专属。
- Binance 官方 FAQ 将 Agentic Wallet 定义为 Binance 账户下独立 keyless 钱包，并说明可由支持 MCP/tool-use 的不同 agent framework 使用；AI Pro 只是预置技能的一种接入方式，不能把 AI Pro 订阅、Agent ID（`.ai`）与钱包归属混同。
- Flap 当前 bStocks Booster 活动（`2026-10-19` 至 `2026-11-02 UTC`）要求 Binance Wallet MPC 与至少 2 个 Alpha Points，活动交易任务还要求同一钱包及指定配对/支付条件。这是钱包活动资格与任务归因，不是 Agentic Wallet 独占发射规则。
- DOTAI 仍是第三方 mint gate 线索：Flap 项目页列出 CA `0xd4c14b32e4b49e5b8acbf499f156ee5d09ba7777`，创建时间 `2026-10-21T08:38:02Z`；页面/项目官网的 `.ai` wallet、inscription 描述不是 Binance/Four/Flap 官方规则。未验证合约的 registry 校验、mint 地址集合、Agentic Wallet 身份或成功买入哈希。因此 `qualifyingCandidateBuys=null`，不触发模拟入场，也不推断不存在其他候选。

来源：

- [Binance Agentic Wallet FAQ](https://www.binance.com/en-IN/support/faq/detail/3ff00e2d488a41c4aaa4aabb6fc36763)
- [Binance Agentic Wallet Developer Docs](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)
- [Four.Meme Agent Skill](https://www.four.meme/en/agentic)
- [Four.Meme AI Agent Series Phase 1](https://www.binance.com/en-IN/square/post/297852176171602)
- [Flap x bStocks Booster 活动规则](https://flap.sh/event/bstocks?lang=en)
- [Flap DOTAI 项目页（第三方元数据/待核验）](https://flap.sh/bnb/0xd4c14b32e4b49e5b8acbf499f156ee5d09ba7777)

## 边界与下一步

GIWA 不在本轮检查范围，继续按用户指示保持停用。无连接钱包、无签名/广播、无买卖、无代码/策略/账本修改、无重启。下一轮轮换 Solana；Four/Flap 仍需等待有时间戳的双源头证明，Flap RPC 链身份超时需观察既有退避恢复情况；Agentic 命中仍须同时满足官方钱包归属证据和成功链上买入交易证据。
