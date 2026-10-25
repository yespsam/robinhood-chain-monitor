# Solana TIKTOK 退出与账户抽查｜2026-10-10 09:19（北京时间）

本轮 D/E 各新增 20 条去重活动，共 **40 条、40 个不同交易哈希**；没有旧页重叠，最新页尚未衔接上轮锚点。新增独立证据为两个已知 TIKTOK 代币账户的同一时点状态；E 的退出交易体仍未取得。

## TIKTOK：取得了什么，仍缺什么

链 Solana；CA：`BwBU7KVXigH7DKunJynowQCQ3oiEuYv26f4A2F8tABR4`。上轮已证实 D→E 转仓 5,107,456.922757 枚，本轮不重复计为新交易。

公开 RPC `getMultipleAccounts` 于 2026-10-10T01:20:37.678Z 以 finalized 返回 context slot **455071640**：

| 历史 owner | 已知代币账户 | 本次结果 |
| --- | --- | --- |
| D | `3NfdkkguWLAGuWKp3a4sATMiZcUSUvYU8Nei4WtWUNha` | null（该时点不存在） |
| E | `994fu4n8rrbQPbg5hZ24tupkQEtQjWJi6n7okhQCTX55` | null（该时点不存在） |

两个账户使用同一 context，未将不同时点余额相加。**null 不是整个钱包持仓为零的证据**：未枚举其他同 mint 账户，未核验关闭时间、关闭交易或之后换账户持有；也不能据此推断清仓方式及盈亏。因此 balanceRaw 保持 null，不填 0。

[E 平台所列退出交易](https://solscan.io/tx/2H79D3yC9ApDA7VAs4HAUNE9ALvKiT9dBTkXFEk7g4s8kWjj7jKvRpeicYxmFeqQSZF4TtfJbkQg39ohPUQENhUC)的查询返回 RPC -32015：交易版本1不被本轮版本0参数接受。项目已有版本1研究检查点，本轮未正确复用，这是本地请求参数兼容性缺口；不是链上交易失败、节点离线或 GMGN 故障的证据。两次 RPC 预算已用完，没有追加重试，后续明确使用已记录的版本1参数核验签名、owner、净退出量和成功状态。

## 新页保留的失败反例

新活动覆盖 2026-10-09T21:53:01.000Z 至 2026-10-10T00:50:57.000Z。其中 Longboi（CA `5mXnbBAKPaEzC7Yd9JfvgqDmVsf8L4hXGbgiA2NEpump`）在平台页中，D/E 均于 00:50:32Z 买入、00:50:57Z 卖出，各自数量相等：

- D：平台买入金额约143.45美元，卖出约131.92美元。
- E：平台买入金额约136.08美元，卖出约131.73美元。

按该 CA、方向与秒分别一对一配对，仅有买入和卖出各一对，不重复配对。这是“同步、25秒退出仍出现负向金额差”的失败线索，说明快进快出本身不保证盈利。未逐笔独立核验回执、费用或中间转仓，不将金额差当完整净亏损，不相加 D/E 盈亏，也不据此推断同控或买入动机。

## 请求、覆盖与检查点

config --check 1 次成功；共享客户端默认优先级0的 GMGN 业务2次成功，各一页20条；公开RPC共2次，账户快照成功1次、交易版本参数错误1次。无重试，无画像刷新，无新增关联地址。活动按链/CA/钱包/哈希去重，返回行身份均匹配；root 身份字段缺省，以请求绑定和显式行校验为限。

D头页成功 2026-10-10T01:20:11.744Z，E 2026-10-10T01:20:17.241Z；最新返回交易均为 2026-10-10T00:50:57Z。两头页都没有到达旧锚点 2026-10-09T16:21:34Z，本轮将新头页游标和连接锚点独立追加，**不覆盖旧历史分页游标**。未补第二页，不宣称头页之间完整覆盖；最新活动新鲜度仍未由独立全链索引核对。

D/E 的 lastNewProviderEvidenceAt 仅因本轮40条新活动更新；lastNewEvidenceAt 另记录随后账户状态证据来源。不存在账户状态不用于虚构当前余额或浮盈。历史亏损案例保留；只作本轮时点抽查，不能宣称休眠、断网或轮次间持续在线。

下一轮轮换 BSC：下轮BSC优先最旧到期头页C/A；FVG第一笔买入已验成功和回执净入账，其余三买仍未验。优先在预算内核对C当前FVG库存及精度，再衔接完整转账/成本；保留躺平买入回执、A nonce158–161分类与旧分页缺口。

后续 Sol：下轮Sol先核对到期头页；TIKTOK E退出哈希2H79D3yC9ApDA7VAs4HAUNE9ALvKiT9dBTkXFEk7g4s8kWjj7jKvRpeicYxmFeqQSZF4TtfJbkQg39ohPUQENhUC重查时必须沿用rpcResearchHints.solVersionedTransaction.requestMaxSupportedTransactionVersion=1（本轮误用0失败），核验成功状态、owner和净退出量；两个旧账户当前null不当钱包清仓证据。保留本轮头页到旧锚点的新游标及全部历史分页缺口。

依照 gmgn-portfolio 与 web3-security-trading，只读核验并维持“观察”；不修改策略、源码、账本或监控进程，不恢复FOMO来源；已完成的日终复盘不重复执行。[对应 JSON](./2026-10-10-0919-sol-tiktok-exit.json)
