# Solana D 历史失败执行核验

D/E最新页40条全部重复，没有新增成功买卖。本轮新增核验1笔历史失败执行：D签名，相关angel代币余额不变，手续费实际扣除。两钱包仍是待验证研究参考，结论保持观察，不升级为跟单教师。

触发2026-10-11 01:22:43 UTC（北京时间09:22），完成2026-10-11T01:26:51Z。沿用基线摘要和检查点；一次性日终复盘已reported=true，跳过。未刷新7天/30天画像。

## 头页与覆盖

D于2026-10-11T01:24:00.922Z、E于2026-10-11T01:24:13.937Z成功刷新；各20条、重叠20、新增0，链与钱包字段逐条一致，按链/CA/钱包/哈希去重，均连接旧锚点。最新返回仍为2026-10-10 05:10:31 UTC的Benny’s退出，CA `EwYudQcf96PAGanfLA9q4Q8QSAUk1QzkbiC3jrbppump`。没有重新累计同秒同步样本。

公开RPC getSignaturesForAddress对D返回最近20个finalized签名，首条与GMGN最新哈希一致；只能说明这次有限签名快照一致，不能证明钱包持续不活跃、所有代币账户齐全或GMGN整体完整。E未做独立签名抽查，保持provider_freshness_unverified。所有历史游标及连接缺口保留。

## 新增失败反例

- 钱包D：9bwzwZvTyB8yXdCi2Bz7TATM5nVcSGnNyB2KqhUj8Zqp；链Solana；相关CA：7LVuFpj1vYiBvD4kp6oNHxwQ6AStGyFZGHWyUZ57pump（平台同CA符号angel）。
- [交易回执](https://solscan.io/tx/2MNTF92KtQdH4CFCFwLLjEMFNAFeuU4BQfiPySZ8i12osMVfFt37QeRzPBMZ9Mkr47LxxRi7khkTrZjBQmv1BMY8)：2026-10-10T00:14:01.000Z，slot 455053345，version1，finalized。返回签名和D的signer身份一致。
- meta.err为InstructionError[1, Custom100]；日志仅显示FLASHX程序以0x64失败，未取得可解释错误含义的接口定义，不能说余额不足、滑点、重复卖出或安全拦截。
- D对应代币账户GQjEE7ckYK9pVpzdq2mfqiEnK31oyfYEHX8gybd7gTp2，原始余额0→0（6位小数）。D原生余额减少15000 lamports，恰与meta.fee一致，即0.000015 SOL；不重复扣费，不计算整段策略盈亏，也不把失败计为成交。
- 同签名页还有2个失败状态条目，本轮未取交易正文，CA/类型/根因留待核验；不并入新增成功交易或完整失败成本。

失败发生于10月10日，是本轮新核实的历史证据，不是今天的新买卖。该签名未出现在已有研究报告/检查点，也不在本轮GMGN活动页中；活动接口不展示失败执行本身不能证明其漏掉成功成交。买卖动机、同控及盈利能力均不能由此推导。

## 保存及下一步

只推进上述覆盖/失败分类问题：config --check 1次、GMGN业务2次、公开RPC 2次，每钱包1页，新地址0。D lastNewEvidenceAt仅因新回执核验推进至2026-10-11T01:25:04.791Z；E该字段不变，两者lastNewProviderEvidenceAt均不因旧页刷新而推进。下次头页应查D=2026-10-11T09:24:00.922Z、E=2026-10-11T09:24:13.937Z。

学习点：成功成交榜单不呈现全部执行成本，失败样本必须单独保留；快速执行不保证成功或盈利。下轮BSC优先最久未查的到期头页（C及排序下一只）；保留A后续nonce分类和C FVG库存/成本缺口，只推进一个有界问题。 后续Sol问题：下轮Sol先按到期时间核对D/E头页，再在预算内核验D剩余失败签名或补旧分页连接；未解码Custom100之前不猜失败根因，失败不计成功买卖。

遵循gmgn-portfolio只读及web3-security-trading观察边界；未改源码、策略、名单、账本、余额、历史、进程或自动化。FOMO平台来源仍关闭，不声称两轮间持续在线。

[原始响应与紧凑证据](./2026-10-11-0922-sol-failed-instruction.json)
