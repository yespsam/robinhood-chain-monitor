# Sol D/E 增量研究：Benny’s 快进快出反例

- 触发：2026-10-10 17:20:41 UTC（北京时间 10-11 01:20）；报告完成：2026-10-10T17:26:55Z。最后回执采样为17:24:19 UTC；本地检查点格式校验重试使总耗时约373秒，超出约5分钟目标，未追加业务请求。
- 本轮一个问题：到期D/E头页是否有新增活动，并用两次公开RPC核验D的Benny’s 73秒退出失败样本。
- 只读：config --check 1次，GMGN业务2次、公开RPC 2次；每钱包1页、无新增地址。一次性日终复盘已reported=true，本轮跳过。

## 新增与重复

D/E最新页各20条，身份字段逐条匹配目标链和钱包，按链/CA/钱包/哈希去重后40条均重复、各自连接旧头页锚点。最新返回交易仍为2026-10-10 05:10:31 UTC。头页检查D=2026-10-10T17:23:34.183Z、E=2026-10-10T17:23:53.321Z。没有新增交易；本轮新增的是两笔历史交易的独立回执核验。历史分页游标与缺口全部保留；本轮不重新统计同秒配对。

## 新证据：D 的 Benny’s

- 链：Solana；CA：EwYudQcf96PAGanfLA9q4Q8QSAUk1QzkbiC3jrbppump。
- D：9bwzwZvTyB8yXdCi2Bz7TATM5nVcSGnNyB2KqhUj8Zqp。
- [买入](https://solscan.io/tx/3Djep24WK2HMMC9MA4h45Ukt7tySiCkdemmk6QtbE2dED1x9DnpDJFMLES4F388Qsu7L5B5riaw8kaNDLZKd1tfz)：finalized slot 455134521，05:09:18 UTC；[退出](https://solscan.io/tx/5frV1Gtf7xVceLH45rXxKq9ThX8dDwb42mbW2nDqXMwSuWiGjJAynXao6wWpTcH6Y7QuXRUj7LFw7xhikRZGa2nR)：slot 455134856，05:10:31 UTC。返回哈希、D签名身份、mint均匹配，meta.err均为null，版本1。
- 同一代币账户 7KWsdEjtTdyDeat8v1ZFNduHbHKT26T5S9hKU5rZwEGc：买入后原始量 10171816862233（6位小数）；73秒后卖出前数量相同、卖出后明确为0。买入前余额列表未包含该账户，不能把未返回字段写成零；两端数量一致也不能排除期间转出转入。
- 两笔D钱包原生SOL余额分别变化 -1.742609822 和 +1.041042921 SOL，合计 -0.701566901 SOL。这是两笔回执的净余额影响，已包含各笔交易内现金流；不能再机械叠加费用，亦不等同完整策略净盈亏。该结果补强先前平台买卖金额差为负的失败样本，不相加D/E平台收益。

## 学到什么、还缺什么

快速退出是真实行为，但73秒的短持仓不保证盈利；不能只凭同步、速度或榜单收益筛选可跟随教师。尚缺期间完整转账、成本及全钱包当前库存，不推断买入动机、同控或稳定盈利。两笔历史回执不验证头页之后是否还有活动，D/E均保持provider_freshness_unverified；成功重读只更新headCheckedAt，E的lastNewEvidenceAt不变，D仅因新回执证据推进。

本轮只确认上述采样时刻，不证明两轮之间连续在线。没有修改策略、源码、账本、余额、学习名单、进程或自动化；FOMO平台来源保持关闭。

下一轮：下轮BSC先检查到期头页，最多选成功检查最旧两只；保留A nonce覆盖分类、C FVG后续库存/成本缺口，不把旧头页重复当新增。

原始响应及紧凑核验见同名JSON。
