# 2026-10-23 23:07Z — BSC A/B 头页与 Four.Meme / Flap Agentic Wallet 规则复核

检查窗口：2026-10-23T23:07:22Z–23:13Z（Asia/Shanghai 2026-10-24 07:07–07:13）。本轮轮换 BSC，仅推进“刷新 A/B 最新页并做同秒同步核验”；并复核官方 Four.Meme / Flap / Binance Agentic Wallet 资格差异及现有纸盘、覆盖检查点。

## 钱包头页（GMGN 只读）

- `gmgn-cli config --check` 在业务请求前通过；共享 `src/gmgn-flow-client.js` 默认优先级 0，A、B 各成功读取一页（各 20 条），合计 2 次业务请求；没有 429、忙碌或超时。公开 RPC 0 次。
- A：`0x452b8fd1edd95184fa7f9123da2e441d323a9fd7`；B：`0x8fa9e760bdd3f767f4cb36bd3d87a8056a43da1c`。两页返回的 40 条记录均为同一 BSC CA `0x7a3f00299a61ca38c4d5981c34661f6bda4a7777` 的卖出。交易时间范围 `2026-10-02T09:18:04Z`–`2026-10-02T11:08:09Z`；按 `(CA, side, 秒)` 一对一匹配可得 20 个候选同秒配对、跨 16 个不同秒。代表性最新一对：A `0x136d7a2b58d81ccf6ab7ca79dbea68cbb2c76bbf819a76d28f1e2072e36e4868`、B `0x276ed1a8787a851f66bf341a62bd62728028d53b19a22ea8a69fa6b3f7857f6d`，均为 `2026-10-02T11:08:09Z`，哈希不同。
- 两个响应只含 `activities` 与 `next`，没有回显链/钱包身份。各自的已知最新交易锚点命中，但完整页哈希基线缺失；因此 `pageOverlap/newRows` 仍为 `null`，不能将 40 条计为新增去重证据，也不更新 `lastNewEvidenceAt`。返回的 `next` 游标未保留；历史续页游标与既有缺口保持不变。
- 观察性假设：若响应确实归属各请求钱包，A/B 对单一 CA 的集中卖出与 20 个同秒配对值得后续复核；这只是同步行为线索，不证明同控、共同资金源或获利。未链上验证 40 个哈希，不做完整库存/成本/盈亏归因，也未新增关联地址。

## Four.Meme / Flap 与 Agentic Wallet 资格

- Binance 官方 FAQ（本次抓取页面注明 2026-08-26 更新）将 Agentic Wallet 定义为 Binance 账户下独立的 keyless 钱包，并说支持 MCP/tool-use 的其他 Agent 框架也可安装 Wallet Skills；AI Pro 的区别是预装 Skills，不等于平台只允许 AI Pro。开发文档最近修改日为 2026-10-23，列出 BSC、Ethereum、Base、Solana 支持。
- Four.Meme 官方 Agent Skill 页写明适用于能运行终端并载入环境的通用 Agent，提供创建、买卖、链上事件等能力；其签名执行配置涉及 `.env` 私钥。此轮未安装、未执行、未连接钱包。另有 Binance Wallet Exclusive 发射公告，但措辞指向 Binance Wallet 用户，不足以证明仅 Binance Agentic Wallet 或 `.ai` 身份可参与。
- Flap 目前公开的 bStocks × Booster 活动期为 2026-10-19 至 2026-11-02 UTC；页面要求 Binance Wallet MPC、至少 2 个 Alpha Points，并以加入时同一个 Wallet 完成任务。FAQ 写的是符合条件的 Binance Wallet 用户，属于活动准入/任务归因，不等同 Agentic Wallet 独占发行。
- Flap Apps 页列出 `ID AGENT CURVE` 预发射应用；其公开详情页没有显示 Creator/Token，也没有 Agentic Wallet / Agent ID 资格条件。Flap `$ai` / “Agent ID” 页面显示 CA `0xae545bfea9a1b3b8f749c6480bc83d8fe1017777`、创建时间 `2026-10-21 10:49:46`，页面描述是 Agent ID 名称；这是项目/标签页面，不是官方钱包归属或限制铸造的证明。当前 DOTAI 仍是第三方待核验线索，没有补到 Agentic Wallet 身份和成功买入双证据。
- 本轮候选范围为上述官方页面与一个 Flap 列表页，不是全链扫描；`qualifyingCandidateBuys=null`，表示无充分覆盖/双证据，不能解释成零候选。

## 纸盘与监控覆盖

- `node scripts/review-paper-forward.js`：相对上次 19:13Z 检查，成交数仍 321，末 ID `1792761076261:320`；没有新增成交或完整回合。Multiarm 游标一致、没有新完整配对，累计报价缺口仍 322（本轮增量 0）；2x/3x/5x 本轮净收益为 `null`，调度器运行态字段仍 `null`。
- 主进程心跳于 `23:10:34Z` 更新，PID 48659，起始时间记录为 `2026-10-21T10:38:45Z`；这不证明检查间持续在线。BSC 尾部采集在 `23:11:23Z` 读取到确认头 129407622、尾部覆盖至 129407513、滞后 109 块，但最近一轮 `eth_getLogs` 因 BSC RPC 超时失败；累计覆盖仍标记 critical，约 9,534,487 块距离主覆盖游标、18,346 unresolved gaps，近头恢复队列仍有约 20,699 gaps / 6,458,099 pending blocks。未重启或修改进程。
- Four Registry 状态文件最后更新时间为 `12:59:59Z`，`nextBlock=129326094`；相较 `23:11Z` BSC 确认头 129407622，游标差 81,528 块。因没有同窗 Four Registry 头证明，这只是本地游标差，不等于经双源确认的当前遗漏数。
- Flap Quote 状态 `v5.26.0` 最近快照 `23:07:21Z` 为 degraded，累计 113 次连续失败、最后成功 `13:11:24Z`，错误 `FLAP_QUOTE_CHAIN_ID_UNAVAILABLE`（所有 BSC RPC 的 `eth_chainId` 查询超时）；`nextBlock=129316431`。将近头差值视作未核实，`currentLagBlocks=null`，不绕过冷却或重试机制。

## 检查点与下一轮

- 轮次 106；最后检查 BSC，下一轮轮换 Solana D/E。GMGN 2 次成功、0 失败，RPC 0、模型 0；没有买卖、签名、广播、策略/账本改动。
- 保留 A/B 的 `providerLatestActivityAt=2026-10-02T11:08:09Z` 与 `lastNewEvidenceAt` 原值；不将相同头页解释成“不活跃”。下一轮优先检查 D/E 到期最新页，同时关注 Four/Flap 官方 Agentic Wallet 专属规则、新首发 CA；只有“官方钱包身份证据 + 该地址对候选 CA 的成功链上买入”同时可核验才记为命中。GIWA 本轮未检查，维持关闭。

## 来源

- [Binance Agentic Wallet FAQ](https://www.binance.com/en-IN/support/faq/detail/3ff00e2d488a41c4aaa4aabb6fc36763)
- [Binance Agentic Wallet 开发文档](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)
- [Four.Meme Agent Skill](https://www.four.meme/en/agentic)
- [Four.Meme Binance Wallet Exclusive 公告](https://www.binance.com/en/square/post/30772514003738)
- [Flap bStocks × Booster 活动](https://flap.sh/event/bstocks?lang=en)
- [Flap Apps](https://flap.sh/apps) 与 [`ID AGENT CURVE` 详情](https://flap.sh/apps/agent-bonding-curve)
- [Flap `$ai` / Agent ID 项目页](https://flap.sh/bnb/0xae545bfea9a1b3b8f749c6480bc83d8fe1017777)
- [Flap Degen ID（只读地址画像）](https://flap.sh/event/degen-id)
