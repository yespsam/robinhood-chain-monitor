# Solana TIKTOK 库存核验｜2026-10-09 16:41（北京时间）

D/E头页40条均重复，新增GMGN交易0。新增独立证据：D已知TIKTOK卖出成功，该交易中代币账户由23,909,126.419197枚变为0；此前5,107,456.922757枚算术差不能当真实剩余仓位。发现买入和卖出之间1个未分类代币账户活动哈希；D→E直接转仓仍未证实。

## 新增证据

链：Solana。CA：`BwBU7KVXigH7DKunJynowQCQ3oiEuYv26f4A2F8tABR4`。研究对象D：`9bwzwZvTyB8yXdCi2Bz7TATM5nVcSGnNyB2KqhUj8Zqp`。

1. [D已知卖出](https://solscan.io/tx/36zV5MjUXw1AxRFcmssFbnHU3qrdydRyaXU6rYcxbo91jX8aUHBpDgCAUqaynvQDRKCCA6ZE3t2LQsU7GXMwjfUX)在2026-10-08T20:12:58Z、slot 454648159成功执行（finalized、meta.err=null），签名与D签名者身份匹配。代币账户`3NfdkkguWLAGuWKp3a4sATMiZcUSUvYU8Nei4WtWUNha`的owner为D，交易前23,909,126.419197枚，交易后为0；transferChecked同量流向交易池相关代币账户。该交易的目标币余额和指令中未确认D→E转账。
2. 对同一代币账户、以上述卖出为before查询签名，返回已知买入和一个此前研究记录中没有的[中间活动哈希](https://solscan.io/tx/2yPxKX9RRH6TB5oznR83Ewaq4Cb2eDptnEduu4A8DFRBZUZTm9oTVdUUaqZz7yEPL1tZwQCUZtX2FVj2GGeLK1H9)：2026-10-08T20:09:49Z，slot 454647482，索引状态finalized/err=null。其交易体、收款owner、数量和类型尚未取得，**不能算作已确认转仓或新增成功买卖**。

## 纠正的库存边界

上轮平台页D买入减卖出的5,107,456.922757枚，只是缺少中间活动时的算术差。本轮已证明在已查卖出交易结束时，该代币账户并未留下这部分余额。这个事实推进了库存核验，但不能证明D整个钱包当前持仓为0，也不能直接证明差额被转给E。

可学习的反例：只用买卖页会把中间转账或其他活动遗漏为“持仓”或“盈利”；先补全直接筹码证据，再讨论分批退出和收益。仍不相加D/E平台盈亏，不推断同控、操纵或买入叙事。结论：观察。

## 最新页、请求与覆盖

- config检查1次；共享客户端默认优先级0的GMGN业务2次成功，各1页20条；40条全重复，新增平台交易0，两页连接旧锚点。
- D头页成功时间2026-10-09T08:43:01.965Z；E为2026-10-09T08:43:06.770Z。最新返回交易均仍为2026-10-08T20:41:00Z，不代表之后没有活动。
- 公开RPC共2次成功，用于上述历史交易与签名索引，预算已用尽，不追加调用；新核验历史卖出1笔、待分类活动哈希1个，不将二者重复计为新成交。
- 返回头页root身份字段缺省，以请求绑定和显式行字段校验为限。D新发现的中间哈希未在本轮头页中出现，覆盖差异待分类；不据此认定GMGN整体故障。E最新活动新鲜度仍未独立验证。
- D的lastNewEvidenceAt因新发现且去重的链上候选证据更新，并明确记录来源；E仅重读旧页，该时间不变。二者lastTrade不变，历史分页游标全部保留。无画像刷新、无新增研究地址。

## 下一步

下一轮按原轮换检查BSC，优先C。Solana后续：下轮Sol优先到期头页；用getTransaction核验TIKTOK代币账户候选哈希2yPxKX9RRH6TB5oznR83Ewaq4Cb2eDptnEduu4A8DFRBZUZTm9oTVdUUaqZz7yEPL1tZwQCUZtX2FVj2GGeLK1H9的源/目的账户、owner、数量与净变动，确认或否定D→E转仓；不能仅靠库存对称认定，保留Cinnamon/NFLX路由和旧分页缺口。

只作时间点抽样，不能证明期间持续在线。已完成的一次性日终复盘不重报；未修改交易/策略/账本/监控或FOMO关闭状态，技能的证据门槛使本轮保持观察、不升级买入信号。

[对应JSON](./2026-10-09-1641-sol-tiktok-inventory.json)
