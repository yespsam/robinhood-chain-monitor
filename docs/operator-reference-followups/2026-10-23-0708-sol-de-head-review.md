# Solana D/E 头页与快速往返核验（2026-10-23 07:08 Asia/Shanghai）

检查时间：2026-10-22T23:15:17Z。研究范围仅为 D/E 两个既有公共参考钱包的各一页最新活动；不补历史页、不新增地址、不执行交易或签名。

## 请求与覆盖

- `gmgn-cli config --check` 在业务请求前通过；共享客户端配置检查也通过。
- GMGN 业务请求 2 次（D、E 各 1 次，默认优先级、串行），成功 2 次；公开 Solana RPC `getTransaction` 2 次，模型请求 0 次。未重试。
- 两个 GMGN 响应各含 20 条活动和 `next` 游标。响应未带可确认查询身份的回显；请求目标为对应名单钱包。精确整页重叠/新增数仍未知；本轮新发现的两条 D 交易哈希与既有去重键均不同，因此可确认 2 条新增唯一交易证据，其他行的去重数保留为 null。
- D/E 原历史恢复游标及既有历史/头页缺口均保留；本轮没有补页。E 头页未返回与 D 新事件相匹配的交易。

## D：同一 CA 两秒买入、两秒后卖出

D（`9bwzwZvTyB8yXdCi2Bz7TATM5nVcSGnNyB2KqhUj8Zqp`）本轮头页新增同一 CA `6TAtbaZAExDVoC3R3MD7dCKc7jmZvCjwQz23cZ2fpump` 的一买一卖。交易发生于 2026-10-22 03:13:01Z 与 03:13:03Z；这是本轮新收录到检查点的证据，不是刚发生的实时买入。

1. 买入：[`4pmeUY9efuXhmRLAfQrTW8nrSeXpNznwoMMfVqhbMZ9DxeRSaJM7zTtJszczvdE2jBjy594bdwUSrMgCAdXn4KNo`](https://solscan.io/tx/4pmeUY9efuXhmRLAfQrTW8nrSeXpNznwoMMfVqhbMZ9DxeRSaJM7zTtJszczvdE2jBjy594bdwUSrMgCAdXn4KNo)
2. 卖出：[`66fm2stCWTSZvaaqLeLNTjCymNEWv64FK5ASnqWPMhwHssqFwEzvyijgVhVnEfyKbH9X1MXCu3Ke5AotTa1e1Vsx`](https://solscan.io/tx/66fm2stCWTSZvaaqLeLNTjCymNEWv64FK5ASnqWPMhwHssqFwEzvyijgVhVnEfyKbH9X1MXCu3Ke5AotTa1e1Vsx)

两笔交易均由 Solana mainnet-beta 公共 RPC 以 finalized `getTransaction` 返回成功，slot 分别为 459878250、459878256，version 1，`meta.err=null`；D 是签名者。目标 token 持仓变化为 0 → 7,775,126.904530 → 0（6 位小数）。GMGN 两条记录的 `cost_usd` 分别为 25.7766665 与 25.774222，但其字段不能单独构成净收益。两笔交易的 owner 原生币余额合计变化为 -12,588,843 lamports（约 -0.012588843 SOL）；该差额可能含网络费、租金或其他交易影响，不能直接定性为已实现盈亏。报价路径、完整费用/账户流和钱包全量库存未核实，因此净 PnL=null。

这是 D 在该 CA 上的快速全仓往返样本；可能减少持仓暴露时间，但同时存在约 0.01259 SOL 的净原生币流出且无法据此归因。单一案例不足以判断其为优点或稳定行为。未发现 D/E 同步或直接转账证据；不据此推断同控、操纵、叙事或动机。

## Four/Flap、纸面账本及 Agentic Wallet 观察

- Four 最近一组同窗双源链头证明（23:10:29Z）：源 tip 129215548/129215547，safe head 129215544；证明时 cursor `nextBlock=129215533`，落后 12 块。随后读取到 cursor `129215764`，但此时面板观察头约 129215695、safe head 129215692 且 `liveHeadVerified=false`，游标已越过旧证明；当前落后块数记为 null，不把它说成归零或继续减少。
- Flap 最近一组同窗双源证明（23:11:02Z）：源 tip 129215624/129215623，safe head 129215620；证明时 cursor `nextBlock=129215592`，落后 29 块。随后 cursor 到 129215703，健康降级并出现 `FLAP_QUOTE_FINALIZED_LANE_UNAVAILABLE`；共享 RPC 协调器处于冷却/容量等待，当前 lag=null，等待未确认解决。未绕过限频或双源门控。
- `/api/strategy-state` 最近可用快照（23:13:10Z）仍为 paper，execution/signing/broadcast 均 false；账本 311 笔、末 ID `1792647072099:310`，本轮新增成交与新增平仓均为 0。多臂本地持久化游标与主账本一致（305 基线、311/末 ID 310），无新完整共同回合；累计 quote gap 105（missing 58、pre-entry 6、out-of-order 39、stale 2），observer interruptionCount=1。`quoteOpportunityScheduler` 字段缺失。3 个未平仓头寸的最新面板估值为 null，浮动损益记 null，不视作零。
- Binance 官方 Agentic Wallet FAQ 说明兼容 MCP/tool-use 的外部 agent 框架也可使用相关技能，AI Pro 是内置集成之一；Four.Meme 官方路线图提及未来 Agentic Mode/AI 身份化发射，但未给出 Binance AI Pro/Agentic Wallet 独占门槛。Flap bStocks 活动列的是 Binance Wallet MPC 与至少 2 Alpha Points 的活动资格/任务条件，并非 Agentic Wallet 身份门槛或仅 AI Pro 钱包可买的首发规则。当前没有本轮可核验的“候选代币成功买入 + 买入地址由官方身份资料确认为 Binance Agentic Wallet”成对证据；没有全链候选扫描，本观察触发条件未满足。

来源：[Binance Agentic Wallet FAQ](https://www.binance.com/en/support/faq/detail/3ff00e2d488a41c4aaa4aabb6fc36763)、[Four.Meme 官方路线图](https://www.binance.com/en/square/post/297600375569202)、[Flap bStocks 活动规则](https://flap.sh/event/bstocks?lang=en)。

## 下一步与边界

下一轮按既有轮换回 BSC，优先到期参考钱包头页；复用本地 Four/Flap 链头、纸面账本与 Agentic Wallet 检查点，不以过期证明外推当前 lag。当前 D/E 两笔样本保留为待验证研究证据，不作为交易信号/模拟入场触发器。电脑在线与否及检查点之间的连续覆盖无法从本次快照证明。整轮约 13 分 30 秒，明显超过 5 分钟目标；业务请求仍限于 2 次 GMGN 与 2 次公开 RPC，未补历史页或追加重试。

本轮没有改代码、策略、钱包名单、模拟账本/余额、进程或调度；未连接钱包、签名、广播、买卖或调用额外模型。
