# Solana E 的账户维护核验与新增头页

北京时间2026年10月12日09时26分例行研究。D/E最新页各新增20条平台活动，共40条；另核验E一条历史未匹配签名，确认它是关闭Philosopher与Bentley的零余额代币账户，而不是买卖。D的最新链上签名仍晚于平台头页，需继续分类，保持观察。

## 新增平台样本

D页覆盖UTC 2026-10-11 21:54:37至23:39:40，E页覆盖21:28:37至23:39:40；分别于2026-10-12 01:28:10.536和01:28:24.275成功读取。均在各自八小时检查期限之后发起，使用共享默认优先级0。

逐条返回链与钱包身份一致。按链、CA、钱包、哈希，与检查点及前次头页去重，40条均为首次保存，重复0条。最新一行均为平台标记的inu卖出，CA为`FD9ZGJ1BpKBPin5mN9FdkrfcmVv4ZCffeZqSvbbRpump`，时间UTC23:39:40。两只钱包这一对同秒记录各使用一次，不由同步交易推断同控、动机或盈利。

两页均未接回上一交易锚点。新的头页游标及连接锚点已单独保存，每只钱包原有3项头页缺口保留并新增第4项；不是完整期间流水。没有把持有数量、未知浮盈或成本缺口补为零。

## E 的未匹配交易确为关户

E钱包`8jY86w2GVQQ79TW8EnU9CVswUyk6x66FJnWcVADCDuwj`的[该交易](https://solscan.io/tx/Fx2tj2pybko6GNmebJnxpGNVm6EyUFa6cbT1nDeTsPPpQkgMQN2MXwKEsnbt2R1wubrSSy8z9UQZLyhM7dTBKFe)发生于UTC 2026-10-11 04:19:37，本轮于2026-10-12 01:27:33.684取得finalized交易体。首签名、E签名者身份及成功状态一致；全部指令为ComputeBudget、两次Token-2022 closeAccount和一次System转账，无内部或swap指令。

| 代币 CA | 关闭的账户 | 关闭前代币 raw |
| --- | --- | --- |
| `81p8jnbXJKX9N36VxEkSfH4gtR97zYmSBLcbeGN8pump`（已有平台名Philosopher） | `8crsiR4a4UtCGsP5kgMwszRWSxERZYizPQw6PhoTJyMb` | 0 |
| `HLPwkRLxkMW9Dt8PCLTSUAQnkR7ZZXfLoXCo18A4pump`（已有平台名Bentley） | `AifXHyXA1ywebGfUwNfDJBkcwGasEDcKpJiSFaVXCkhs` | 0 |

这两只账户的所有者和返还接收者均为E，原生余额各1513840 lamports，关闭后均为0。两账户共返还3027680 lamports，E另转出40785 lamports，原生余额净增2986895 lamports（0.002986895 SOL），与pre/postBalances吻合。

手续费付款地址并非E，网络费16618 lamports已从该付款地址扣除；不能重复从E的已核实净变化中扣减。转账用途未验证，不以付款地址名称或共同服务证明同控，不新增关联钱包。此笔与上轮Veria关户交易哈希不同，即使金额相同也须分开去重；本轮不重复计上轮返还，更不把任何关户返还当交易盈利。

可学习的是清理空账户并核实返还的操作。它不证明此前卖出盈利，不证明当前全钱包清仓；E尚余3条旧未匹配签名，不能假定也属于关户。

## D 出现新的未分类签名

公开RPC于UTC 2026-10-12 01:27:33.811返回D的最新20条finalized签名，覆盖UTC 2026-10-11 22:49:14至2026-10-12 00:07:59，包含本轮平台头页的最新卖出签名。

最新[链上签名](https://solscan.io/tx/2TbxS8gMn34c7T6JvVx56WoJydCXW6eg964CxYSCQhakMoHv8u2GDqsMM551pfGnEvunEERbJ7EuqpdTqGZk8RYQ)比平台最新记录晚1699秒（28分19秒）。20条中7条未匹配当前平台头页，其中1条元数据显示InstructionError索引3、Custom100。仅取得签名元数据，没有这些交易的交易体，CA、钱包在每笔交易中的角色及具体操作仍未知；不能说是7笔买卖，也不能把失败签名当失败swap。

D标记provider_coverage_gap_pending_classification，保留上述待查签名。当前差异可能包含账户维护等非买卖口径，但不能把E已核验的关户类型外推给D，也不能据此断言GMGN整体故障。E本轮未重新独立读取最新签名页；仍保留旧未分类签名与分页缺口。

## 检查点与下一步

GMGN配置检查1次、业务请求2次；公开RPC2次，均成功。无画像刷新、额外历史分页、新研究地址或模型调用；一次性日终复盘reported=true，本轮跳过。采样成功不代表期间持续在线。

下轮轮换BSC，先检查C最旧到期头页，再预算内核验nonce22或FVG后续筹码去向。下个Sol轮次优先获取D最新未分类签名交易体；E剩余3条、D旧失败样本及所有新旧游标继续保留。不做完整盈亏归因，不把参考钱包升级为教师或买入信号。

未改源码、策略、主名单、账本、余额或历史，未交易、签名、广播、发送TG/广场消息或重启进程。FOMO平台来源保持关闭，GMGN/X监控不变。

[结构化证据与只读原始返回](./2026-10-12-0926-sol-closure-classification.json)

