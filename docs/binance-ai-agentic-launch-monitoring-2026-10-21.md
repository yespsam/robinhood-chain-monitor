# Binance AI Pro / Agentic Wallet 发射方式观察

核对时间：2026-10-21 15:40 UTC  
下次复核：沿用当前每四小时心跳（检查点记为 2026-10-21T18:55:11.851Z）；未新增自动化或唤醒。  
范围：只读核对 Binance、Four.Meme、Flap 官方内容及一条第三方发射线索；没有连接钱包、调用交易/RPC接口或改变模拟盘。

## 结论

你的方向有一个真实、值得持续盯的分支：Agentic Wallet / Agent ID（.ai）可能被第三方项目用作发行资格门槛。但截至本次核对，证据支持的是“Agent 钱包身份门控实验”，还不支持“Four.Meme 或 Flap 官方推出了只有 Binance AI Pro 钱包能参与的统一发射模式”。

关键是把三个东西分开：

- **Binance AI Pro**：Binance 的 AI 代理/策略产品，2026-10-19 起开始全球推出。
- **Agentic Wallet**：独立的 keyless 链上钱包，有单独余额和权限控制；官方称支持 BNB Smart Chain、Solana、Ethereum、Base，并为 AI Pro 预置钱包技能。
- **Agent ID**：绑定 Agentic Wallet 的可读 .ai 身份。官方宣传把它与 AI Pro 发布同时推广，但“AI Pro 产品用户”与“持有 Agentic Wallet/Agent ID 的地址”不是同一类资格。

## 已核到的发射与资格机制

1. **Four.Meme × Binance Wallet Exclusive / Meme Rush**：官方既有机制把早期 New/Finalizing 阶段限定给 Binance Wallet Keyless 用户；迁移后的代币可转让并进入开放市场。它是“钱包类型/发行阶段”限制，不是“必须开通 AI Pro”。
2. **Flap × bStocks Booster（页面显示活动期 2026-10-19 至 2026-11-02 UTC）**：要求 Binance Wallet MPC 钱包和至少 2 个 Alpha Points；Flap 交易任务还绑定同一钱包及符合条件的 bStock 配对、BNB 支付。这是活动参与和奖励归因规则，不是 AI Pro 独占，也不能据此推断 Flap 所有新币都被钱包白名单限制。
3. **Four.Meme 新发行产品**：官方 Four.Meme 页面近期展示 TapeFour 挖矿型发行模型，以及 4Stock/bStock 相关机制更新；这些是发行/代币经济模型变化，目前核到的公告未写 AI Pro/Agent ID 独占。
4. **第三方 DOTAI 线索**：dotaibsc.com 自称只接受 Binance Agent ID（.ai）钱包、每地址最多 mint 5 次，达到 100 次后由合约调用 Flap 创建 DOTAI 并买入曲线。这是当前最贴近你猜测的实例，但项目页本身不是 Binance、Four.Meme 或 Flap 的官方公告，不能表述成官方合作或平台政策。

## 验证缺口与处理

- DOTAI 项目页给出的 BSC 合约为 0xB9324424Fe969840c090f8a72edF2fb47D730354，但本次区块浏览器读取返回 403，尚未核实其代码是否真的检查 Agent ID、是否调用 Flap 创建，以及调用/资金路径。
- 项目页实时数值当时为空并显示“无 inscriptions”；搜索索引摘要却曾显示 100/100。该冲突更可能意味着索引或动态数据时效不一致，但目前不能据此认定已发行或已完成迁移。
- 未找到 Four.Meme/Flap 官方公告称“只有 Binance AI Pro 钱包可以参与”。目前最准确的说法是：**第三方尝试把 Binance Agent ID/Agentic Wallet 用作准入凭据；平台级独占尚未证实。**

## 后续监测规则

沿用现有四小时覆盖复核，不增加唤醒或外部请求频率。监控 Binance AI Pro、Agent OS、Agentic Wallet、Agent ID（.ai）、Four.Meme、Flap 的正式公告、活动条款和发射合约；每个新线索分成“官方政策”“第三方项目规则”“链上已验证”三档。只有官方规则与链上 allowlist/身份校验、创建事件和 CA 顺序相互吻合时，才报告为已验证的受限发射；仍按现有最早三个不同 CA、双源证明、时效与安全门槛处理，不把第四个补入。

这只是监测范围扩充：保持模拟盘，不买卖、不签名、不广播，不因 Agent ID 或 AI Pro 标签放宽合约/流动性校验，不改历史账本、策略参数或既有覆盖优先级。

## 2026-10-22 触发条件补充

用户明确：监测目标不是“有 Agentic Wallet 资格即可”，而是候选首发代币必须由 Binance Agentic Wallet 实际买入。故后续只有同时核实钱包地址身份和成功链上买入交易（链、CA、交易哈希、时间与买入方向）时，才记录为命中；仅 AI Pro 使用、Agent ID（.ai）、参与资格、mint/创建事件或第三方声称均不触发。身份或买入性质不明时保留为待核验，不触发模拟入场。

本次只是更新研究判据，没有新增链上样本或验证新的 Agentic Wallet 买入。监测仍为观察用途：不连接钱包、不签名/广播、不执行 0.2 BNB 实盘买入，也不改既有模拟策略或历史账本。

## 来源

- [Binance AI Pro 官方发布](https://www.binance.com/en/square/post/378961974502219)
- [Binance Agentic Wallet 官方公告](https://www.binance.com/en/square/post/315968775419586)
- [Binance Wallet 官方主页（Agent ID 与 Flap 活动公告）](https://www.binance.com/en/square/profile/binancewallet)
- [Binance Wallet × Four.Meme Meme Rush 官方说明](https://www.binance.com/en/square/post/10-09-2025-binance-wallet-launches-meme-rush-exclusive-to-keyless-users-unlocking-early-access-to-high-potential-meme-tokens-30775657895250)
- [Four.Meme 官方动态](https://www.binance.com/en/square/profile/four_meme)
- [Flap × bStocks Booster 活动页](https://flap.sh/event/bstocks?lang=en)
- [DOTAI 项目页（第三方，未作链上核实）](https://dotaibsc.com/)
