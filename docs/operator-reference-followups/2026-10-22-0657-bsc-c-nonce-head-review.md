# BSC C 头页与 nonce 分类；Four/Flap 面板和 Agentic Wallet 复核

检查窗口：2026-10-21T22:57:14Z–23:01:56Z（北京时间 2026-10-22 06:57–07:01），第 96 轮。当前研究问题：BSC C 到期头页及已知 nonce 22/23 后续差异能否分类。A/B 未在本轮刷新：其记录的头页到期时间约 23:01Z，刷新启动时尚未到期。所有五个初始地址仍只是待验证研究参考。

## BSC C

- `gmgn-cli config --check` 先通过；随后通过 `src/gmgn-flow-client.js` 默认优先级 0、共享账户门控请求 C 最新页 1 次。请求成功返回 16 行、空 `next`，没有重试；另用 2 次只读 BSC 公共 RPC 核验，不新增地址。返回未回显钱包身份，方向字段缺失；首行交易哈希与已知锚点相同，但保留响应摘要不足以逐行计算全部重叠，故 `newRows`、`pageOverlap` 均记为 `null`，不把它们记成零。
- 已知最新交易仍为 2026-10-09T03:39:12Z、CA `0xfcaab8a2b629dbe59a2ec8632a50288e0e837777`、哈希 [`0x764070…722d86`](https://bscscan.com/tx/0x764070b3bef3dec495963a881a946fa92dc7730f42b5f1828c797d2abc722d86)。本轮页面没有提供比它更新的可确认行；`lastNewEvidenceAt` 不前移。
- 公共 RPC 在同一 BSC 公共端点读取已知交易与账户当前 nonce：已知交易 nonce `0x15` (=21)，当前 `eth_getTransactionCount` 为 `0x18` (=24)，差额为后续 nonce 22、23。交易回执、这两个 nonce 对应的哈希、成功状态、类型和是否买卖均未核实；这是账户 nonce 进展，不是两笔买入/卖出的证据。继续标记 `provider_coverage_gap_pending_classification`。

## Four / Flap 覆盖

- `data/four-registry-state.json` 与 `data/flap-quote-state.json` 的 BSC 游标在本轮窗口内继续推进；Flap 身份仍为 v5.26.0。Flap 约 22:59:07Z 遇到共享 RPC coordinator 的 host/method 冷却错误，之后本地状态恢复成功；没有手动重试、提高并发或绕过限频。
- 本机只读 `/api/strategy-state` 快照（23:00:26.919Z）总体 `coverage_limited`，`readErrors`/`headReadErrors` 为空，但链头证据已过时，面板将两路 `headLagBlocks` 和 `scanBacklogBlocks` 设为 `null`、`liveHeadVerified=false`，状态均为 `cursor_ahead_of_observation`。最近可见的旧头快照：Four head/safe `129022198/129022195`，其观测游标 `129022187`（当时观测落后 12/安全积压 9）；Flap head/safe `129022208/129022205`，观测游标 `129022190`（当时观测落后 19/安全积压 16）。这不是当前真实落后数，不能外推为追平或积压缩小。
- 同窗 API 的运行游标 `129022266/129022269` 已超过旧观测游标，随后持久化文件截至 23:01:39–23:01:56 又推进到 Four `129022479`、Flap `129022457`。由于对应链头证明仍旧且双源当前头校验未通过，本轮只能报告游标有进展、真实落后块数未知；面板/持久化观察点的差异是待核覆盖缺口。API 没有提供 `quoteOpportunityScheduler` 字段；不补造状态。
- 当时 main/BSC 心跳 PID 分别为 48659/55241；API 显示 BSC scanner 在运行。心跳及游标样本不能证明检查间连续在线。

## Binance AI Pro / Agentic Wallet

- Binance 官方将 AI Pro 描述为金融策略 AI 产品；官方 Agentic Wallet FAQ 将 Agentic Wallet 描述为账户下独立的 keyless/MPC 钱包。二者有关联但不是同一个概念，也没有由产品介绍推出“只有 AI Pro 钱包能参与发射”的依据： [AI Pro 公告](https://www.binance.com/en/square/post/378961974502219)、[Agentic Wallet FAQ](https://www.binance.com/en/support/faq/detail/3ff00e2d488a41c4aaa4aabb6fc36763)。
- Flap 官方 bStocks 活动页显示活动期 2026-10-19 至 2026-11-02；可参与者为持有至少 2 Alpha Points 的 Binance Wallet 用户，交易任务要求使用同一 Binance Wallet，以 BNB 累积购买符合条件的 bStocks 配对 Flap meme token（累计门槛 $10）。这是活动任务/资格，不是 AI Pro 或 Agentic Wallet 独占首发： [Flap 活动规则](https://flap.sh/event/bstocks?lang=en)。
- Four.Meme 官网本轮直接打开返回 403；搜索未提供可确认的新官方门槛，不能把访问失败解释成规则不存在。本轮没有发现经官方身份/注册证据确认的 Agentic Wallet 地址对候选首发 CA 成功买入；合格事件 0、模拟入场 0。Agent ID、AI Pro、资格、mint/创建仍不触发。

## 前向模拟盘与边界

- `review-paper-forward.js` 与本地影子工件/API 游标一致：主账本 309 笔，末 ID `1792567338823:308`；相较上轮无新增成交。多臂仍为 2 个已闭合配对、0 个开放配对，当前报告窗口无新增完整配对 ID；不重算旧净收益，不改账本。
- 报价缺口累计 45（理由沿用上次分类）；`quoteOpportunityScheduler` 字段缺失。模拟模式保持不变：无实盘交易、钱包连接、签名/广播、参数或历史改动。

结论：C 的两个后续 nonce 尚待逐交易分类；Four/Flap 游标有进度但当前真实落后数未知，双源头证明未通过；没有 Agentic Wallet 合格买入触发。下一轮按轮换检查 Solana D/E 到期头页，并保留 A/B/C 分类缺口及当前 Four/Flap head-proof 缺口。
