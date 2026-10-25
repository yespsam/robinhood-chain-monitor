# Solana E 的最新未匹配签名属于关户返还

北京时间2026年10月12日01时25分例行研究。E比GMGN最新活动晚140秒的签名，已核实是关闭两只零余额代币账户并收回账户保留的SOL，不是遗漏的新买卖。D/E最新页共40条全部重复；本轮新增1笔历史交易体核验，保持观察，不形成跟单或买入信号。

## 从未分类签名到直接证据

钱包E为`8jY86w2GVQQ79TW8EnU9CVswUyk6x66FJnWcVADCDuwj`。[交易](https://solscan.io/tx/2wjffznoKKMRaJMaUx2sNkr73jzj2icZn5LqEmSb2o2orpktN6DSFAQEXDJ9uiCn8c7dz44HCmTmZ8RanBvcq1w3)发生于UTC 2026-10-11 04:28:52，slot 455519291，本轮于UTC17:26:27.599用公开Solana RPC取得finalized交易体。返回首签名与请求一致，E确为签名者，meta.err=null。全部指令为ComputeBudget、两次Token-2022 closeAccount及一次System转账，无内部指令或swap。

两个关闭账户的所有者和收款者均为E，关闭前代币数量都是0，账户原生余额各1513840 lamports，关闭后均为0：

| CA | 被关闭的代币账户 |
| --- | --- |
| `8VWgGPDZm9KJFpQ6yrTpZfP21F98GQP81kenCzE2pump` | `A1hkkXsdyFTqvcn5F7BV9iBHD24DqWQfm1yTzkPffc9D` |
| `6mXdFAUs2rxsq7iLRR2FMSeHEGWbaAzLrHoQjf4hpump` | `D4vx1uE5ky6fm3b2V2VsDz57vPX3VoNPHHFaFAwenSSN` |

这两个CA在已有平台记录中同名Veria，不能合并。这里只证明这两个具体账户当时空仓并被关闭，不证明E其他账户或当前全钱包库存为零。

## 返还本金不是买卖收入

两账户共返还3027680 lamports。E另向本交易手续费付款地址转出40785 lamports，故E原生余额净增2986895 lamports，即0.002986895 SOL，与pre/postBalances一致。

手续费付款地址为`AxiomRYAid8ZDhS1bJUAzEaNSr69aTWB9ATfdDLfUbnc`，不是E；回执网络费16618 lamports，由该地址支付，该地址净增24167 lamports与40785减16618一致。不能再把网络费重复从E的已核实净变化中扣除。40785转账的商业用途未验证，不以地址名称推断平台身份或同控，不新增关联研究地址。

此处关户返还属于回收账户保留余额，不能当作代币卖出收入或策略盈利；本轮不计算完整收益，也不将两个关联参考钱包的平台盈亏相加。

## 最新页与剩余覆盖缺口

D/E原头页到期时间分别为UTC17:27:40.865与17:27:52.520；按到期时间从默认优先级0共享队列读取，成功时间分别为17:27:58.977与17:28:12.208。各20条，按链、CA、钱包、哈希与检查点及前次头页去重后，新记录0条、重复40条，最新平台活动仍为UTC04:26:32。仅更新头页成功时间，不更新新增平台证据时间，所有历史游标和缺口保留。

E最新20条finalized签名在UTC17:26:28.039抽查时仍以该关户交易为首，未出现比前次签名页更晚的签名。当前这一个“晚于平台”差异已经解释为非买卖口径，不能据此断言GMGN漏买卖或整体故障。另4条未匹配签名尚未获取交易体，因此总体仍保留provider_coverage_gap_pending_classification。D本轮未独立抽查最新链上签名，保持provider_freshness_unverified。上述有限页和时间点不能证明持续在线、长期不活跃或全量覆盖。

## 本轮学习与下一步

可学习的是成交后清理空代币账户、回收保留余额这一可观察行为；不能由此证明两笔Veria交易盈利。失败反例是把SOL余额增加一概记为盈利，或把平台未列出的签名一概视为漏掉买卖。

GMGN config检查1次，业务请求2次，公开RPC2次，均成功。无画像刷新、历史分页、新地址或额外模型调用；一次性日终复盘reported=true，本轮跳过。

下轮轮换BSC，优先最旧到期头页A，随后在预算内补C第四笔完整日志或nonce22。后续Sol轮次分类E其余4条签名之一；D剩余失败签名和旧分页继续保留。未改源码、策略、主钱包名单、账本、余额或历史，未买卖、签名、广播、发送TG/广场或重启进程。FOMO平台保持关闭，GMGN/X监控不变。

[结构化证据与原始只读返回](./2026-10-12-0125-sol-close-accounts.json)

