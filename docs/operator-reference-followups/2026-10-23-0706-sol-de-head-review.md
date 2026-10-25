# Solana D/E 最新活动页增量复核（2026-10-23）

## 范围与请求

- 第 103 轮，按轮换检查 Solana D/E；仅各读一页最新活动，不补历史页、不新增研究地址。
- `gmgn-cli config --check` 与共享 flow client 配置检查通过；默认优先级 0，业务请求 2 次且均成功，D/E 各 20 行。未调用统计画像；公开 RPC 抽查 1 次，模型 0 次。
- GMGN 响应没有可用钱包身份回显。每页完整重叠数和新行数未能保留为可复核集合，故记 null；不得用页面读取成功推断全页去重完成。

## D：同 CA 快速买卖样本（待链上核验）

D（`9bwzwZvTyB8yXdCi2Bz7TATM5nVcSGnNyB2KqhUj8Zqp`）最新页中出现 CA `6TAtbaZAExDVoC3R3MD7dCKc7jmZvCjwQz23cZ2fpump`（GMGN 符号 `Lala`）的一买一卖，哈希与既有最新锚及已保存哈希不同，时间相隔 6 秒：

- 买入 `4pmeUY9efuXhmRLAfQrTW8nrSeXpNznwoMMfVqhbMZ9DxeRSaJM7zTtJszczvdE2jBjy594bdwUSrMgCAdXn4KNo`，2026-10-23 01:18:12Z，GMGN `cost_usd` 140.544242，数量 22,361,218.550721。
- 卖出 `uykHWdP4XHE7LjqH1ZeJDLZpMor6rcZ7kbQgohNk9tGqP9rgjjpsepN3ahq7yu6rpUrowKJ9BzNjbUtS2MoHUxd`，2026-10-23 01:18:18Z，GMGN `cost_usd` 96.891995，数量同为 22,361,218.550721。

同量、同 CA、六秒间隔提示一次快速往返行为，但 GMGN `cost_usd` 的差额不是已验证净盈亏。为核验买入交易发起地址及成功状态，调用一次 Solana 公共 mainnet RPC `getTransaction(finalized)`；端点返回错误码 `-32015`，未得到交易结果，因此链上 signer、成功状态和 token balance 变化均未确认；按预算停止，没有重试第二笔。当前只保留为两条 GMGN 新交易证据，不作盈利归因或入场触发，也不推断买入动机。

E（`8jY86w2GVQQ79TW8EnU9CVswUyk6x66FJnWcVADCDuwj`）头页请求成功返回 20 行，但本轮结构化摘要未能完整留存；新行/重叠/最新活动时间因此均记 null，保留前次已知最新活动时间，不声称本轮没有新活动。E 后续应在到期头页复核中重新核对，不补旧页。

## Four/Flap 只读健康截面

- Four 双源链头证明于 07:08:02Z：tips 129279205/129279204，spread 1，safe head 129279201；证明时 cursor nextBlock=129279180，按 nextBlock 为下一个未处理块计，落后 22 块。随后本地 registry cursor 到 07:08:52Z 的 nextBlock=129279306。Flap 的 07:08:36Z 同链双源证明 safe head=129279279，使用相同两个 source IDs；07:08:52Z 的 Four cursor 已越过该证明头 27 块。这个截面说明游标曾追过验证安全头，不足以代表此后当前落后为零；当前 lag 记 null，未证明持续积压缩小。
- Flap 身份/运行时仍核验为 v5.26.0。双源证明于 07:08:36Z：tips 129279282/129279283，spread 1，safe head 129279279；证明时 cursor nextBlock=129279262，落后 18 块。Flap 实际 quote cursor 于 07:08:37Z 到 nextBlock=129279283（相对证明游标 +21）；07:09:34Z 随后因 `public-bsc.nownodes.io` 的共享 host/method 冷却报 `FLAP_QUOTE_FINALIZED_LANE_UNAVAILABLE`，状态降级，当前 lag 未知。没有绕过共享 RPC 冷却。
- `/api/strategy-state` 本地只读请求在 2.5 秒上限内超时；`quoteOpportunityScheduler` 与面板状态未核实。进程/心跳只作本地观测，不用来证明整段连续在线。

## 模拟盘增量

只读 `review-paper-forward.js` 与主账本显示 313/末 ID `1792717327956:312` 后新增 4 笔成交并闭合 2 轮：

| 入场 ID / 链 / 路线 | CA | 净损益（含模拟费用） | 费用模型 |
|---|---|---:|---:|
| `1792735289326:313` / Solana / external_breakout | `8idEA8QovsZJka6d9Z35fejE5MbL37BJxvw5k5r6pump` | -0.987757 USD | 0.173919 USD |
| `1792737270435:315` / Robinhood / external_breakout | `0x60633794df09856b339eea8bd741d749596b5230` | -0.486257 USD | 0.200561 USD |

两轮均为失败退出样本，合计净损失 1.474014 USD；费用、滑点与 Gas 均为模拟模型。4 笔主账本与 multiarm artifact 检查点同为 317/末 ID `1792737997699:316`，hash `d633c40279c3a8b569972e80606825d7d5ca097a7da73e4dfab91f1fb0884ec9`。但 artifact 显示 0 条 observations、0 个可核报价缺口，故没有可核验的新增共同 multiarm 回合；不可把它解释为“无缺口”。

07:10:32Z 最终纸盘读取时，3 个在仓标记均为 fresh，合计浮动损益 -8.980999 USD、NLV 52.984262 USD；这是模型估值，不是实际可成交报价。补款不是盈利。

## 结论与下一步

D 的快速往返是待核实的行为样本，当前缺少链上成功/signer 证明和可配平成本；E 本轮页级数据摘要不完整，不能写成无活动。下一轮轮换 BSC，并按既有到期机制检查参考钱包头页；Four/Flap 需再取得同窗双源头证明，且先等待共享 RPC 冷却解除，面板读数仍待解决。Binance 官方规则的下一检查点为 07:15:17Z；本轮未提前刷新官方来源或做全链扫描，候选数为 null，不推断没有候选。

本轮只读；未买卖、签名、广播、跟单、重启进程、修改策略或历史账本。
