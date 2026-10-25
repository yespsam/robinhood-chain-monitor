# 第100轮：BSC A/B 头页与 Four/Flap 覆盖复核

- 计划时间：2026-10-22 19:06:48 UTC；检查完成：2026-10-22 19:12:13 UTC（上海时间 2026-10-23 03:12:13）。
- 本轮检查约 5 分 25 秒，略超目标 5 分钟；未为赶时长绕过共享限频或追加重试。
- 轮换组：BSC A/B。有限问题：最新活动页是否已越过已知 PairLab 卖出记录，以及本地 Four/Flap 链头证明能否与随后游标配对。
- GMGN：`config --check` 通过；经共享 `src/gmgn-flow-client.js` 默认优先级 0 顺序读取 A、B 头页各一次，2/2 成功，业务请求共 2 次。每页解析 20 行并匹配既有请求身份及锚点。A/B 返回的最新活动仍为 2026-10-02 11:08:09 UTC、CA `0x7a3f00299a61ca38c4d5981c34661f6bda4a7777` 的卖出；未保存足够的逐行哈希供精确页交集计算，因此 `pageOverlap`、`newRows` 均为 `null`，不把成功重读当作新证据。`next` 游标存在但本轮没有保留其值，原历史游标不变。
- A/B 仍是待验证研究参考。A 已知 nonce 157 后活动的类型仍未核验；B 的 nonce 158–161 旧分类继续保留。无新交易哈希供公开 RPC 抽查（本轮公开 RPC 业务请求 0 次），不把 A/B 的相同旧 CA/卖出锚点升级成新的同步样本、同控结论或不活跃判断。`lastNewEvidenceAt` 保持原值。

## Four / Flap 链头与容量状态

- Four 最近成功的双源头证明：19:09:08.725 UTC，来源头高 `[129183376, 129183377]`，spread 1，safe head `129183373`；该证明同时记录 cursor `nextBlock=129183364`，按 `safeHead-(nextBlock-1)` 计算证明时落后 10 块。19:10:17.462 UTC 后续头部读取失败（`CHAIN_HEAD_RPC_FAILED`）。本地 registry 游标随后于 19:10:55.428 UTC 推进到 `129183600`，但它晚于头证明且没有同步链头，当前落后块数为 `null`。
- Flap 最近成功的双源头证明：19:10:10.326 UTC，来源头高 `[129183511, 129183514]`，spread 3，safe head `129183508`；该证明记录 cursor `nextBlock=129183489`，证明时落后 20 块。随后 quote worker 游标于 19:11:04.639 UTC 推进到 `129183609`，但健康状态已降为 `degraded`，错误 `FLAP_QUOTE_PORTAL_IDENTITY_UNAVAILABLE`，内容为 BSC RPC providers cooling down（当时提示 retry in 29336ms）。因游标与链头不同时，当前落后数为 `null`；共享 RPC 冷却/等待仍未解除，不能声称积压已逐步缩小。
- 这些都是本地只读状态快照；进程心跳不证明中间连续在线。没有修改扫描器、门控或交易策略，也没有重启进程。

## 模拟盘与多臂前向检查

- 主账本保持模拟模式：`mode=paper`，execution/signing/broadcast 均为 `false`；交易数 311、末 ID `1792647072099:310`，本轮新增成交 0。现金 `44.348991189490235 U`，累计已实现净盈亏 `-135.46948229910913 U`；这些是主盘累计状态，不是本轮收益。
- Multiarm v3 的持久化游标与主账本一致（311 / `1792647072099:310`，哈希前缀 `09770ca4861e7107…`），沿用已报告完整回合 ID `1792274973724:305`、`1792567092580:307`、`1792645698811:309`，本轮无新完整共同回合；增量各臂指标为 `null`。累计共享报价覆盖缺口仍为 105（missing 58、pre-entry 6、out-of-order 39、stale 2），未将三臂收益相加。API 的 `quoteOpportunityScheduler` 仍为 `null`，作为面板字段缺口记录。

## Binance Agentic Wallet / Four.Meme / Flap 有界规则核验

本轮复核 Binance 与 Binance Wallet 官方文档、Four.Meme Agent Skill 页面及 Flap bStocks 活动页；未找到 AI Pro 独占的 Four/Flap 发射规则。Binance 说明 AI Pro 预置 Agentic Wallet 技能，但其它兼容 MCP/tool-use 的 agent 框架也可使用；Four.Meme 的 Agent Skill 亦描述多种 agent 运行方式；Flap bStocks 页面描述的是 Binance Wallet MPC 与 Alpha Points 活动资格，而不是 AI Pro 或 Agent ID 独占首发规则。没有对全链新币或候选钱包进行扫描。

仍按既定触发标准：只有“候选 CA 的成功链上买入”且“发起地址有官方证据确认属于 Binance Agentic Wallet”并具备双源核验，才进入观察触发；本轮无该证据组合。未连接钱包、未签名、未广播、未实盘或模拟下单。

官方来源：

- [Binance Agentic Wallet FAQ](https://www.binance.com/en/support/faq/detail/3ff00e2d488a41c4aaa4aabb6fc36763)
- [Binance Developer Agentic Wallet 文档](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)
- [Four.Meme Agent Skill](https://www.four.meme/en/agentic)
- [Flap bStocks 活动页](https://flap.sh/event/bstocks?lang=en)

## 结论与缺口

本轮没有新增钱包交易证据，A/B 头页仍停留在已知 10 月 2 日活动；准确页交集和新行数未知，不能据此判定无活动。Four/Flap 游标都在推进，但链头证据较早、随后游标已越过快照；Four 头读取失败、Flap RPC 冷却，故当前 lag 与积压下降均未验证。下一轮轮换 Solana D/E 头页；Four/Flap 仍需在不绕过共享限频的前提下取得同窗双源链头与游标快照，并检查面板 `quoteOpportunityScheduler` 字段。

研究边界：仅本地/公开只读验证；模拟盘不变；不碰历史账本、策略参数、密钥或绑定钱包；不启动新采集进程、不恢复已暂停旧积压。
