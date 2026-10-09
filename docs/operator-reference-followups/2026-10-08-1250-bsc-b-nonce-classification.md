# BSC B：后续 nonce 分类核验

证据核验时间：2026-10-08 12:50–12:54（Asia/Shanghai）。用户同意后的临时只读补查，不推进四小时轮换。

地址：`0x8fa9e760bdd3f767f4cb36bd3d87a8056a43da1c`，仍为待验证研究参考，不是已确认庄家或跟单教师。

## 结果

上轮已知交易 nonce=157，而公开 RPC 在 2026-10-08 04:38:16Z 返回账户计数 162。本轮按发送地址、哈希、nonce、状态核对 158–161：**1 次授权、1 笔失败兑换、2 笔 BNB 转出，0 笔新增成功买卖**。均发生于 10 月 2 日，是新核实的历史账户活动，不是今天的新成交。

| nonce | UTC 时间（10 月 2 日） | 分类与结果 | BNB 数值 / Gas | 证据 |
|---|---|---|---|---|
| 158 | 11:08:09 | PairLab 授权成功 | 0 / 0.000293976 | [交易](https://bscscan.com/tx/0x879f0cfa0b36af77316251ed8f57016cff62f2226b27dc8e7218c1ae69f4892f) |
| 159 | 11:08:09 | swap 失败，浏览器显示 insufficient balance | 0 / 0.000321324 | [交易](https://bscscan.com/tx/0x4ad8443a7f6e69d74b5922000631aaaecca1805ceb974ce0c2eb44b0192abeb9) |
| 160 | 14:32:33 | 原生 BNB 转出成功，input=0x | 1.465291589318413441 / 0.00000252 | [交易](https://bscscan.com/tx/0xad944af3f4cfadce46671eb0acba653b30e05e9a5241fbcb9f314f7eccb23400) |
| 161 | 15:56:13 | 原生 BNB 转出成功，input=0x | 0.258578385099124198 / 0.00000252 | [交易](https://bscscan.com/tx/0xb60214008ab7d0343a13317a5675dc34870b483c77b36f247d4ace8a6aa3dd56) |

PairLab CA：`0x7a3f00299a61ca38c4d5981c34661f6bda4a7777`。授权 spender 与失败 swap 目标均为 `0x1de460f363af910f51726def188f9004276bf4bc`；失败 swap 输入含 PairLab 与 WBNB 地址，不算成交，不据此倒推完整卖出动机。

两笔 BNB 接收方为 `0x9665949db972d53aa98b5075981b2e2a65d27e82` 和 `0x1212830741ba649b8871f842b276d7ae54fb09e4`。只确认直接转账事实，不判定同控、内部转仓、交易所或买卖所得，不扩充研究名册。合计转出 1.723869974417537639 BNB 不是亏损；四笔显示 Gas 合计 0.000620340 BNB，也不是整个策略成本或净盈亏。

## 学到的失败反例与边界

参考钱包同样存在余额不足导致的失败兑换，并消耗 Gas。授权、失败执行、资金划转、成功买卖必须分开，不能把 nonce 递增当聪明钱买入信号。没有库存与成本配平，不作盈利归因。

本次状态与错误文案来自 BscScan，未新增独立 RPC 回执/trace，不推断失败根因是重复卖出。这处 nonce 差异不能证明 GMGN 漏了成功买卖；买卖活动页本来也不必展示授权、失败执行和原生转账。不据此证明 GMGN 整体完整、地址不活跃或交易系统已修好。A 的同类差异仍未核验，不能套用 B 结论。

## 请求与检查点

GMGN 业务请求 0，RPC 0；公开浏览器列表及四个交易详情，另一次未成功网页读取。安全检查页自动完成后读取，未操作验证码。未刷新 GMGN：providerHeadCheckedAt、providerLatestActivityAt、lastNewEvidenceAt、重叠/新增行及到期时间不变，独立研究证据另存。

保留 round=34、lastGroup=bsc、nextGroup=sol、旧游标、lastRound 与名册；仅追加核验和 gap resolution。策略、账本、余额、主学习名单和监控进程未改，FOMO 平台来源未恢复。

下一步：按原轮换继续 Sol；下次 BSC 优先到期 C 头页，再有界核实 A 的 nonce 差异。

[机器可读证据](./2026-10-08-1250-bsc-b-nonce-classification.json)
