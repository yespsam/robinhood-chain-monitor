# 2026-10-22 11:01（上海）Sol D/E 头页与限定发行复核

检查窗口：2026-10-22 03:01:44–03:11:20 UTC。第 97 轮，轮换 Solana；本轮只处理一个有界问题：D/E 到期头页是否出现新的跨钱包同秒卖出，以及当前 Four/Flap 面板和 Agentic Wallet 发行观察是否有实质变化。

## D/E 新观察

先执行 `gmgn-cli config --check` 成功，再经 `src/gmgn-flow-client.js` 的默认优先级 0 共享客户端顺序读取 D、E 各 1 页（每页 20 行，共 2 次 GMGN 业务请求；没有历史翻页或重试）。两次返回的钱包身份均与查询身份一致，原已知头页锚点均在页内；完整页级 `newRows/pageOverlap` 仍为 `null`，因为不能从锚点命中推算整页重叠量。两条新的最新活动哈希均不在既有去重集合中：

| 钱包 | GMGN 最新活动 | 时间 / CA | 观察到的交易哈希 |
|---|---|---|---|
| D `9bwzwZvTyB8yXdCi2Bz7TATM5nVcSGnNyB2KqhUj8Zqp` | sell | 2026-10-21 22:57:10Z / `4Kee4JuLWTGFR9r9N4iZ9E9K4B297uDgbYt2psy7pump` | `Kgnexit28xqnr4ANkZQjFqJ5LqnCCSupAaam3XmoXZPwHZUhvcB91FqcT3fuT9r8RyXSywrqR2WANK2WobRHRQv` |
| E `8jY86w2GVQQ79TW8EnU9CVswUyk6x66FJnWcVADCDuwj` | sell | 2026-10-21 22:57:10Z / 同 CA | `HY7s4f1WdhMDcSTaVADasDMFdTPWPizYfWvm3JcXBHT8EpCyViCjf8x2rBB12bb5fhRaeFbmqHiQRfdAFxqraiN` |

这是按 `(Solana, CA, 时间, side)` 做的一对一同步候选（1 对、1 个不同 CA），不是同控或操纵证据。各用 1 次公开只读 RPC `getTransaction` 抽查后，均收到 HTTP 200 但 JSON-RPC `-32015`（transaction version unsupported）；RPC 预算 2/2 已用，不重试、不绕过。故交易成功状态、签名者归属、目标 token balance 变化及买入成本均未确认；GMGN 的 sell 标签不能代替链上成功回执，也不能据此计算完整盈亏或触发模拟入场。更老的头页分页/连接缺口仍保留。

## Four / Flap 与模拟盘前向复核

本地只读面板快照时间 03:05:57Z，覆盖状态 `coverage_limited`。Four `nextBlock=129055001`，观察头 `129054958`、safe head `129054955`；游标已在观察头前方，因此当前真实 lag/backlog 为 `null`，不能把旧的 16/13 块观察当成当前值。Flap v5.26.0 在 03:05:40Z 的已核验头为 `129054976`（safe `129054973`），游标 `129054938`，面板 lag 39、scan backlog 36；随后的 03:05:49Z 状态为 degraded，错误 `FLAP_QUOTE_REORG_CHECK_FAILED`，最近成功时间 03:05:20Z，下一次尝试为 03:06:18Z。该快照只能说明当时仍有积压与重组检查错误，不代表连续在线或后续已恢复。

同一 API 快照中 `quoteOpportunityScheduler` 仍缺失。模拟账本只读核对为 309 条、末 ID `1792567338823:308`，本轮新增成交 0；2/3/5 倍影子观察仍为 2 个已闭合对照、0 个新增完整回合，保留既有报价缺口（最近已知 45 条，计数时间为前一快照 23:00:17Z，本轮无新精确计数）。mode 仍为 paper，execution/signing/broadcast 均 false；历史账本和进程均未改动/重启。

## Binance AI Pro / Agentic Wallet 发射观察

本轮有限核对的官方材料： [Binance Agentic Wallet FAQ](https://www.binance.com/en/support/faq/detail/3ff00e2d488a41c4aaa4aabb6fc36763)、[Binance AI Pro 公告](https://www.binance.com/en/support/announcement/detail/c50ffc85804f45f08d0d7727ea508157)、[Four.Meme](https://four.meme/) 及 [Flap bStocks 活动页](https://flap.sh/event/bstocks?lang=en)。材料把 AI Pro（AI 代理产品）与 Agentic Wallet（独立 keyless 链上钱包）区分开；Flap bStocks 页的 Binance Wallet MPC、至少 2 Alpha Points 与 BNB 任务属于活动门槛，不能外推为 AI Pro 独占的发射规则。Four.Meme 已核对页面没有显示 AI Pro 独占要求；这只是本次有限页面检查，不证明任何临时活动都不存在。

没有发现符合用户设定触发条件的候选：必须同时具备“首发 CA 的成功链上买入”与“买入发起地址由官方身份/注册证据确认属于 Binance Agentic Wallet”。AI Pro 订阅、Agent ID（.ai）、资格声明、mint/create 事件和第三方声称都不触发；DOTAI 仍是未核实第三方线索。本轮未连接钱包、未签名/广播、未交易，也未改变策略或历史账本。

## 缺口与下一步

- D/E 候选卖出要在 RPC 支持对应交易版本后，按现有公开只读路径再核实成功状态、签名者身份与 token balance delta；本轮已耗尽 2 次 RPC 额度，不在本轮继续尝试。
- 下一轮按轮换回 BSC，优先最旧到期的 A/B 头页，并保留 nonce/历史页分类缺口。
- Four 当前头证明与面板读取仍不完整，落后块数必须保持未知；Flap 需观察 `FLAP_QUOTE_REORG_CHECK_FAILED` 是否恢复，以及积压是否真实缩小。
- 监控间隔不是连续在线保证；本轮工作超过 5 分钟，未补跑历史轮次。
