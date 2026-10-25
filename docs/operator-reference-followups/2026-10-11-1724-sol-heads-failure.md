# Solana 最新活动与失败手续费核验

2026年10月11日北京时间17时24分例行研究。D/E各返回20条未见于既有去重集的活动，共新增40条；另核验D的一笔历史失败回执。最新页均未连接上旧交易锚点，因此不是这段期间的完整流水。

## 新增活动

D页覆盖UTC 2026-10-11 02:59:18至04:26:32，E页覆盖02:06:26至04:26:32；成功读取时间分别为09:27:40.865与09:27:52.520。已核对每条返回的链与钱包身份，按链、CA、钱包、交易哈希去重，重复0条。完整新行、签名和来源见[对应JSON](./2026-10-11-1724-sol-heads-failure.json)。

本页按CA、方向、时间进行一对一匹配，共14组同秒行为、6个不同CA，不重复使用同一条记录。两个名为Veria的代币分别是：
- `6mXdFAUs2rxsq7iLRR2FMSeHEGWbaAzLrHoQjf4hpump`，双方平台买卖标记间隔86秒。
- `8VWgGPDZm9KJFpQ6yrTpZfP21F98GQP81kenCzE2pump`，双方平台买卖标记间隔10秒。

这说明本页包含很短的买卖时间间隔，不证明同控、买入动机或盈利，更不意味着普通跟随者能复制成交。未配平全部库存、成本和转仓，不合并D/E平台盈亏。

## 链上覆盖仍有缺口

E钱包 `8jY86w2GVQQ79TW8EnU9CVswUyk6x66FJnWcVADCDuwj` 的公开RPC最新20条finalized签名中，包含平台最新卖出签名，同时最新签名发生于UTC04:28:52，晚平台最新记录140秒。[该签名](https://solscan.io/tx/2wjffznoKKMRaJMaUx2sNkr73jzj2icZn5LqEmSb2o2orpktN6DSFAQEXDJ9uiCn8c7dz44HCmTmZ8RanBvcq1w3)只有元数据，未获取交易体，CA、钱包在交易中的角色及活动类型待确认，不能称为漏掉一次买卖。

20条签名中5条未匹配本次平台头页；可能是不同活动口径，不能直接认定GMGN整体故障。E标记为provider_coverage_gap_pending_classification；D未做本轮独立最新签名检查，标记provider_freshness_unverified。两者新头页游标和旧交易锚点单独保存，全部旧分页缺口保留。不以本次成功读取证明期间持续在线。

## 失败反例

D钱包 `9bwzwZvTyB8yXdCi2Bz7TATM5nVcSGnNyB2KqhUj8Zqp` 的[另一笔历史失败交易](https://solscan.io/tx/4DvmeBzYYTuvNBKKHDTCitTkrqA2EEDsdETb9GPoVM7pTQEQoWukEBznnZw3uCUkzawnsRSRMUmndtAkHX1vfMR1)发生于UTC 2026-10-10 00:14:01，CA为`7LVuFpj1vYiBvD4kp6oNHxwQ6AStGyFZGHWyUZ57pump`（已有平台记录名angel）。签名与签名者身份一致，finalized回执显示InstructionError索引1、Custom100，失败程序为`FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9`。

本笔手续费15000 lamports（0.000015 SOL）；D原生余额减少15000 lamports，目标代币账户原始数量0→0。指令列出的后续10000 lamports转账不能当作已执行费用相加。该交易不是成功买卖，不能产生交易收益；本轮只新增核验这一笔，不重复计算上轮已核验失败费用。Custom100具体含义尚未解码，不能据此猜测滑点、余额不足或重试意图。

学习重点是将“出现交易签名”“成功成交”和“计入费用后的收益”分别核验。短周期操作不能掩盖失败成本，研究样本也不自动升级为教师或买入信号。

## 检查点与下一步

GMGN config检查1次、业务请求2次均成功；公开RPC2次均成功，无画像刷新、无历史分页、无新增研究地址。一次性日终复盘reported=true，本轮跳过。调用共享客户端默认优先级0，未修改队列、锁、限频或监控。

下轮轮换BSC；下个Sol轮次优先分类E最新未匹配签名，随后在预算内补D剩余失败交易及新旧分页连接。保持观察，不改源码、策略、名单、账本或余额，不交易、不重启进程。FOMO平台来源保持关闭，GMGN聪明钱和推特监控不变。

