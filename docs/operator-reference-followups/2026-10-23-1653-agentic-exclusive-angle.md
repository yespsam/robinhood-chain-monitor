# Four.Meme / Flap：Binance Agentic Wallet 限定角度增量核验

核验时间：2026-10-23 08:53 UTC（16:53 Asia/Shanghai）  
范围：Four.Meme 与 Flap 的近期 AI/Agent 发射方式、Binance Agentic Wallet / Agent ID 门槛；不做全链候选扫描，不连接钱包、不签名、不广播、不交易。

## 本轮新增证据

1. **Four.Meme AI Agent Series / Agent Skill Framework**：Four.Meme 官方账号近期称 Phase 1 已上线，AI agents 可集成 Four.Meme 创建代币并与内部市场交互。其 Agent Skill 页面列有创建、查询、报价、买卖、链上事件和 EIP-8004 等能力，并面向可运行相应工具的通用 agent。当前核到的官方表述没有把 Binance Agentic Wallet、AI Pro 或 `.ai` 设为唯一资格。Four.Meme 页面本次被 robots/403 阻挡，能力细节仅按公开官方账号与其公开 Skill 文档记载。
2. **Flap × bStocks Booster**：活动页标示活动期 2026-10-19 至 2026-11-02 UTC，要求 Binance Wallet MPC 钱包及至少 2 个 Alpha Points；Flap 交易任务是用 BNB 购买符合资格的 bStocks 配对 meme token，购买额度累计，并须使用报名的同一 Binance Wallet。这属于活动奖励/归因门槛，不是 Binance Agentic Wallet 专属首发规则。
3. **DOTAI（Flap / BNB Chain）待核验项目线索**：Flap 代币页显示 CA `0xd4c14b32e4b49e5b8acbf499f156ee5d09ba7777`，创建时间为 2026-10-21 08:38:02 UTC，创建地址缩写为 `0xb932...0354`；页内项目描述称“100 AI agents inscribed ... by Binance .ai wallets”。项目官网进一步声称 mint 仅接受 Binance Agent ID（`.ai`）钱包、每地址最多 5 次、每次 0.05 BNB，达到 100 次后自动在 Flap 创建 DOTAI。

## 证据分级与结论

- **官方产品/平台政策**：Binance 官方说明 Agentic Wallet 是面向 AI agent 的独立 keyless 钱包；AI Pro 默认预置相关技能，但其他 agent 框架也可接入 Binance Wallet 技能。这不等于“只有 AI Pro 用户/钱包可用”。Four.Meme 的 Agent Skill 发布则指向通用 agent 集成。
- **活动资格**：Flap bStocks 活动限定的是 Binance Wallet MPC + Alpha Points + 同钱包任务归因；没有证据把它等同于 Agentic Wallet 专属发射。
- **第三方项目门槛**：DOTAI 是目前与用户假设最贴近的项目方线索；Flap 页面承载的项目描述与项目官网口径相互呼应，但二者都不能单独证明合约实际执行了 `.ai` 注册校验或所有 mint 地址身份真实属于 Binance Agentic Wallet。
- **链上验证**：本轮没有核验 DOTAI 合约字节码/注册表调用、100 次 mint 的地址列表、Flap 创建事件对应交易，也没有验证任何买入地址属于 Binance Agentic Wallet。因此 `qualifyingCandidateBuys=null`，不是 0；本轮没有符合触发条件的已验证买入样本。

用户此前明确的观察触发仍适用：必须同时具备（1）Binance Agentic Wallet 地址的官方身份/注册依据，（2）该地址对候选 CA 的成功链上买入交易（链、CA、哈希、时间、方向）。`.ai` 名称、AI Pro 使用、mint/创建、资格宣传、项目方自述或代币页面创建记录均不能替代成功买入证据。没有这两类证据的线索只留待核验，不触发模拟入场。`0.2 BNB` 仅是历史提出的研究参考，不授权真实买入，也不改变模拟策略。

## GIWA 范围变更

按用户 2026-10-23 指示，停止 GIWA 监控且不再纳入本跟进。独立 LaunchAgent `com.qohfq.giwa-monitor` 已执行 `launchctl disable` 和 `launchctl bootout`；本次没有删除其 plist、历史报告或数据。Four.Meme / Flap 研究与 GIWA 运行彼此独立。

## 来源

- [Four.Meme 官方 AI Agent Series 发布](https://www.binance.com/en-IN/square/post/297852176171602)
- [Four.Meme Agent Skill 页面](https://www.four.meme/en/agentic)（本次网页抓取返回 403；内容通过搜索索引可见）
- [Four.Meme 官方社区 Agent Skill 文档](https://github.com/four-meme-community/four-meme-ai/blob/main/skills/four-meme-integration/SKILL.md)
- [Flap × bStocks 活动页](https://flap.sh/event/bstocks?lang=en)
- [Flap 上的 DOTAI 项目页](https://flap.sh/bnb/0xd4c14b32e4b49e5b8acbf499f156ee5d09ba7777)
- [DOTAI 项目官网（第三方项目规则，尚未链上验证）](https://dotaibsc.com/)
- [Binance Agentic Wallet 官方公告](https://www.binance.com/en/square/post/315968775419586)
- [Binance Agentic Wallet 开发者文档](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)
