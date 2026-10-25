# Solana D/E 头页新鲜度、Agentic Wallet 门槛与 Four/Flap 覆盖复核

检查完成：2026-10-21T19:05:01.369Z（2026-10-22 03:05 上海），轮次 95。主研究问题：D/E 到期头页刷新是否带来可确认的新同步买卖样本。BSC/Solana 五个参考地址仍只是待验证研究对象，不是已确认庄家或自动跟单教师。

## D/E 头页

- 先通过 `gmgn-cli config --check`，再用 `src/gmgn-flow-client.js` 的共享门控和默认优先级 0 各取 D、E 一页：2 次业务请求成功，0 次手动公开 RPC，0 次重试。两页各返回 20 行；两钱包的 `next` 游标与上轮各自的头页游标相同。
- 返回体仅有 `activities`、`next`，没有回显查询钱包地址；本轮简化输出也没有可用的买卖方向字段。行级 CA/哈希重叠数无法从保留的响应摘要重算，因此 `newRows` 与 `pageOverlap` 记为 `null`，不把页大小误作新增样本。D/E 的 `providerLatestActivityAt` 保留上轮已知的 `2026-10-21T10:36:10Z`，`lastNewEvidenceAt` 不前移；头页成功读取时间分别记为 `19:00:10.461Z`、`19:00:14.648Z`。
- 响应最新时间字段显示早于已存交易时间锚点，且身份回显与方向缺失，故状态为 `provider_freshness_unverified`。不据此判定钱包不活跃，不建立同秒买卖配对，也不作盈亏归因。历史页连接缺口保持原游标，不被本次头页覆盖。

## Binance AI Pro / Agentic Wallet / Agent ID

- 本轮没有发现符合触发条件的事件：没有“身份经官方证据确认的 Binance Agentic Wallet 地址，对候选首发 CA 的成功链上买入”样本；因此 0 个合格买入、0 个模拟入场。Agent ID（.ai）、AI Pro 使用、资格、mint/创建事件均不触发。
- Binance 官方资料将 Agentic Wallet 描述为独立的 keyless 链上钱包，并说明 AI Pro 与钱包技能的关系；这不能推出 Four.Meme 或 Flap 的发射机制只允许 AI Pro/Agentic Wallet。Flap 当前可核验的 bStocks 活动规则是 Binance Wallet MPC 钱包与 Alpha Points 条件，属于活动资格，不是 Agentic Wallet 独占发行。Four.Meme 的 Binance Wallet Exclusive/Meme Rush 早期阶段同样不能等同于 AI Pro 专属。
- DOTAI 仍是未验证的第三方线索：没有完成 Agent ID registry、发射合约和实际买入交易核验。无新官方合作或平台规则证据，不升级为 Binance/Four/Flap 官方集成。

官方资料： [Binance Agentic Wallet](https://www.binance.com/en/square/post/317689081214801)、[Binance AI Pro](https://www.binance.com/en/square/post/378961974502219)、[Binance Wallet 官方账号](https://www.binance.com/en/square/profile/binancewallet)、[Flap bStocks 活动规则](https://flap.sh/event/bstocks?lang=en)、[Four.Meme](https://four.meme/)。Four.Meme 页面本轮正文访问受限；没有用该站点访问失败推断不存在新规则。

## Four / Flap 与前向对照

- `launchUpdateCoverage` 在 `2026-10-21T19:03:59.513Z` 的同窗双源快照无 `readErrors`，两链头证明均 `verified`。Four：head/safeHead `128990751/128990748`，游标 `128990742`，头差 10、确认深度后待扫 7 块。Flap：head/safeHead `128990738/128990735`，游标 `128990716`，头差 23、确认深度后待扫 20 块。对照前一已验证快照（15:07Z 的头差 14/25），分别收窄 4/2 块；仍未追平。Flap v5.26.0 的运行身份已验证，19:03:05Z 曾有一次 Portal identity/getBlock 失败，随后 19:03:33Z 自动恢复为 healthy 并推进游标；没有手动重试或绕过冷却。
- 同一 API 快照的 `quoteOpportunityScheduler` 仍为 `null`，是独立面板/调度覆盖缺口；`launchUpdateCoverage` 总体仍为 `coverage_limited`。进程心跳显示 main pid 48659、BSC pid 48662 当时有更新，但心跳不证明检查间连续在线。
- 模拟前向账本为 paper，交易游标仍为 309 / `1792567338823:308`；多臂观察器在 `19:05:01.369Z` 持久化相同游标/前缀，当前影子对照 2 个已闭合配对、0 个开放配对，本轮无新增完整配对 ID。报价调度器字段仍缺失；最新已成功 API 暴露的累计共享报价缺口为 45（19:01:48Z），没有用它推断新利润。另有一次 2 秒本地读取上限内的大型 API 响应超时；未重试，沿用稍早成功的筛选快照。

## 结论与下一步

本轮无新增证据，保留上轮结论：D/E 头页成功重读不等于新交易；Agentic Wallet 触发门槛没有合格买入样本；Four/Flap 游标确实推进且当前面板可给出经验证的落后块数，但 Flap 仍有 20 块待扫，报价调度字段缺失。下一轮按轮换检查 BSC 最旧到期头页并保持 C 的 nonce 22/23 分类缺口；D/E 头页最早约在 2026-10-22T03:00Z 再到期。继续只观察，不连接钱包、不买卖、不签名/广播、不改策略或历史账本，不恢复已暂停积压。
