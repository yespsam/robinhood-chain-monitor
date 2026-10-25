# Solana D/E 最新页增量与模拟退出对照（2026-10-21 18:57 上海）

检查时间：2026-10-21 11:09 UTC。对象仍是待验证研究参考，不是已确认庄家或自动跟单教师。轮次 93，按 BSC → Solana 轮换，本轮仅推进“D/E 的新头页是否出现共同 CA 活动、并核对纸面退出对照”这一有界问题。

## 采集覆盖

- 先完成 GMGN config 检查，再通过 `src/gmgn-flow-client.js` 的共享门控、默认优先级 0 读取；3 次业务请求均成功：D 最新页、E 最新页、D 一页连接续页。共 5 次 config check（含客户端内部检查），0 次公开 RPC，0 次模型请求；没有 429、BUSY 或超时。D 本轮已到每钱包 2 页上限，E 1 页；不循环重试。
- D：最新页 20 条、续页 20 条，逐笔身份返回为预期 SOL 钱包，合计 40 条新增、0 条重叠。头页成功读取 `2026-10-21T10:59:12.975Z`，最新活动时间 `10:36:10Z`，该续页在 `11:01:44.245Z` 再提供 20 条新行；续页游标为 `NDU5MDg2MTkwMDAwNDkwMDg6MDo6`。本轮没有找到旧连接锚点 `24nZM9…`；续页最老记录约 `2026-10-20T06:26:21Z`，旧样本最后已知为 `05:25:34Z`，约一小时连接缺口仍待补。历史 `paginationGap.resumeCursor` 原样保留。
- E：最新页 20 条、14 条新增、6 条重叠，预期钱包/链身份匹配；头页成功读取 `10:59:37.937Z`，最新活动时间 `10:36:10Z`。找到之前锚点 `2grEr…`（`2026-10-20T23:32:41Z`），因此这次最新页与前页连接；更早的历史分页缺口仍未解决，不能据此宣称全历史完整。
- 新增行合计 54、重叠 6、新增研究地址 0。成功读取旧数据不更新 `lastNewEvidenceAt`；上述新增行才更新各钱包的证据时间。交易哈希本轮没有额外公开 RPC 收据核验。

## 同步行为样本与反例

按链、CA、钱包、交易哈希去重；共同秒级行为只作一对一观察，不把一笔交易重复配对。以下差额仅是 GMGN 返回的对应买入/卖出 `cost_usd` 之差，非完整钱包净盈亏，未校验全库存、转仓、费用或收据：

| CA | D 与 E 的同 CA 时间行为 | D 的返回值差 | E 的返回值差 | 观察 |
|---|---|---:|---:|---|
| `7cMb9wn3QwCsMtMwYNiq9oJZwoakW8cEAQ7Cz6qMpump`（LARPMAS） | 10:00:30 买、10:01:53 卖 | -16.38 USD | +8.88 USD | 同步时点但符号相反，不能将一方退出直接套给另一方。 |
| `6mKg8AQCU4U32mxguTzy1uhRjxVcmV4GS6e8Xj6epump`（SHMÜNK） | 09:55:25 买、09:55:35 卖 | -36.38 USD | -5.13 USD | 10 秒内卖出，两边均为负向返回差，是快速失败反例。 |
| `trenwBK2XLodJFJJHKgnsRd3L371UriwZkX9zWvBK1j`（Trencher） | 10:25:19 买、10:25:29 卖 | +52.82 USD | +17.19 USD | 两边同向为正，但幅度明显不同；不是稳定性或可复制性证据。 |
| `DtXVXXE2APKQ6mHA5AoepfvZW8QKVBfvMecz7QYrabcd`（DtXV） | 10:32:14 买、10:36:10 卖 | -48.49 USD | -61.29 USD | 两钱包最新页在同秒卖出；返回值均负，仍不是完整 P&L。 |

DtXV 两笔卖出签名可分别在 [Solscan D](https://solscan.io/tx/2cTPMmhZ4Ygo2SKta6FPU178z2k3fP7iuRCLkC8HiqD2QHPdrTMp7RocvdxknH5SdkXKt5Guufm9zQoLyKv7fxQf) 与 [Solscan E](https://solscan.io/tx/232MFf5dJv2rpjT5u4CVMo8ymf6aMiLGwwKdP6WAFeQCGBmLBneb7EpagAUUUktmqtG9KhdBUgKY6QaDaMmi83r4) 查询；本轮未请求 Solana RPC，链接只供后续独立核验，不能把 GMGN 返回当作已核实收据。

**可验证结论：** D/E 在多个不同 CA 上出现紧邻时间的买卖，但 LARPMAS 的返回差方向相反、SHMÜNK 与 DtXV 为负向样本；因此时间同步不是同控证据，也不构成自动交易规则。未发现新增直接资金关系或转仓证据。

## 只读模拟盘前向复核

`node scripts/review-paper-forward.js` 生成时间 `2026-10-21T11:06:21.691Z`；本地账本完整性为 `read_only_inventory_cash_and_realized_reconciled`，309 条成交，最后 ID `1792567338823:308`。相对上次已报告的 307 笔（末 ID `1792275648715:306`），新增买入 `1792567092580:307` 与卖出 `1792567338823:308`，组成 1 个新闭合回合：SOL `external_breakout`、CA `Cbkg5w7V7W2J2sUmecnyN825CbvwvXwasfhduVtNpump`（PHP），07:18:12.580–07:22:18.823Z，扣模型费用净收益 **-0.9336 USD**；模型费用约 0.1834 USD，不是链上实际费用。

独立 2x/3x/5x 影子组共享同一入场和报价，该回合三组都由原退出在阈值触发前平仓：每组净收益 -0.9336 USD、相对原退出差额 0、未触发 1、失败 0；提前卖飞损失为“不适用/阈值未触发”，不是 0 盈利机会。三个假设不相加、不并入主盘。新回合有 15 个报价覆盖缺口（缺报价 4、入场前报价 2、乱序 9）；全部已观察配对累计 45 个缺口，报价完整性仍受限。主盘未改，回合样本仍很少，不能证明盈利能力。

在 `11:09:22Z` 状态快照时，现有持仓的可用估值已过期/未被新鲜行情确认，因此浮动损益记为 `null`，不当作零或延续前一轮报价。

本次 `/api/strategy-state` 快照（`11:09:22Z`）显示 `mode=paper`、execution/signing/broadcast 均为 false；`profitRetentionShadow` 游标推进到 309 笔、2 个完整配对、无错误，但读取瞬间 `pendingWrite=true`。随后只读复核影子账本文件在 `11:15:30.466Z` 已保存游标 309、末 ID `1792567338823:308` 与对应前缀哈希，确认该次写入已落盘。`quoteOpportunityScheduler` 在 API 快照中为 null（状态缺口）；exit monitor 当时运行、无错误、0 个 stale quote。`11:15:55Z` 再读本地 API 端点连接失败；未重启或干预服务。前三 CA 路线仍为 0 笔实买，不能用配置代替成交。

## Four/Flap 与覆盖缺口

- 只读健康投影在 `2026-10-21T11:08:20Z` 没有 `readErrors`。Four registry 游标为 `128927383`，outbox 0、processed keys 78；Flap v5.26.0 的投影游标为 `128927385`。游标均持续推进。
- 同时链头快照显示 Four 的观测游标 `128927282`、safe head `128927291`；Flap 观测游标 `128927360`、safe head `128927373`。两条扫描游标已分别领先这些旧快照，因此投影正确标记 `cursor_ahead_of_observation`、当前 `headLagBlocks=null`。null 不是零落后；本轮不能据此声称当前真实落后块数已测出或积压持续缩小。Flap 前一组游标与头快照匹配时的观测滞后为 17 块/扫描积压约 14 块，但后续继续前进后这一数值已过期。
- Flap 文档覆盖仍为部分：58/59 个正文页新鲜，2 项变更待核实，X 来源受限，适配范围仍是 BSC pinned Portal quote adapter，不代表未来所有 schema；Four 的 Robinhood 部署仍未核实/未适配。`quoteOpportunityScheduler=null` 也是本轮面板状态缺口。
- 心跳进程 PID 48659（主进程）与 48662（BSC worker）未变，startedAt 为 10:38:45/46Z；存活不证明全程在线。共享 RPC 容量等待、快照时差和报价缺口仍要继续观察；不提高并发、不绕过冷却或双源校验、不恢复已暂停 BSC 积压。

下一轮按轮换回到 BSC，优先 A 的到期头页；继续检查 Four/Flap 面板投影是否追上实际游标，并在观测游标与处理游标同一时间窗内再计算当前滞后块数。
