# Four.meme 接入 · YESP 0.3.2

## 使用

在 Chrome 扩展管理页重新加载 YESP，再刷新 Four.meme 代币页。面板可查询代币、填写买卖数量与滑点、核对币安预演并确认。“Agentic Wallet · 扫码 / 转出”打开共享钱包页面；钱包页也能打开独立 Four 交易台。查询无需登录。提交需要已连接 Binance Agentic Wallet，并由用户在币安 App 手动启用开发者模式和核对限额。

0.3.2 的买入输入单位改为代币数量。点击“核对报价与交易”，按当前内盘报价计算预计支付和含滑点、交易费的最高支付。Agent ID 模式的“填入可买上限”会重新查询链上持仓及库存，仅填写数量，不预演或提交交易。余额还需足以覆盖最高支付及网络费。普通 V2 不套用 Agent ID 的 1% 限额。

## OpenFour Agent ID 专属模式

接入 presetId 1778027615735 的 Trading 内盘阶段。按官方 Registry 查找 Core/Tools，再核验 Core、Vault、报价资产、模式版本与专属模块标签。Core 固定为已核验的官方地址；未知模式、版本、暂停、创建区块预售和迁移后的外盘不提交。经典 Helper 未识别代币时才查询 OpenFour；节点错误不会被当成协议切换信号。

- 普通买入需要带有 Agent ID 的 Binance Agentic Wallet；卖出允许创建者或满足资格的钱包。扫码连接并不证明拥有 Agent ID。核对报价和提交前均通过官方交易模块的只读 evaluate 检查，随后进行 Tools 报价和原始调用预演。
- [币安官方 Agent ID 入口](https://web3.binance.com/agent-id)。插件只提供链接，不申请身份、不铸造 NFT、不代替用户确认登录或手机操作。旧文档中经典 Agent NFT 的说明不能用于判断这一 OpenFour 模式的资格。
- 普通买入持仓上限为每个代币创建时 maxSupply / 100，不使用销毁后的流通总量。当前可买量 = min(持仓上限 - 已有持仓, 内盘剩余可售量)，最低为 0。请求超出额度、库存或报价缩减目标数量时，要求用户重新核对。
- 按数量买入：Tools.estimateBuy(token, wallet, tokenAmount, 0, 0x) 通过 eth_call 只读报价；Core.buy(token, tokenAmount, maxQuotePay, 0, 0x)，maxQuotePay = ceil(userPays × (10000 + slippageBps) / 10000)。BNB value 等于最高支付；ERC20 报价资产需要已有余额与单独确认的最高支付数量授权；不使用 Zap 自动换币。
- 新面板显式传 buyMode=tokenAmount，避免与旧面板的报价资产预算混淆。未重新加载的旧面板仍保持原预算语义，既有日志和回执按原计划核验；更新后须重新加载扩展和网页。
- 卖出调用 sell(token, amount, minNetQuote, 0, 0x)。最低净到账以 Tools 的 userReceives 扣滑点计算，已经扣除代币税、协议等费用；WBNB 报价默认收到 BNB。没有经典 V2 的 GWEI 数量限制。
- 确认页显示目标购买数量、预计支付、含滑点与交易费的最高支付、税费合计及网络费估算。卖出仍显示最低净到账。税率从合约读取；Tools 包含协议、开发者与防狙击等费用，不把代币税误当成总费用。
- 内盘阶段只允许合约买入交付、卖出收币，普通钱包间转账受限；插件的“转出”功能不能解除此限制。
- 提交前重读资格、阶段、余额、nonce、税费配置及合约指纹；有效费率上升（整数舍入误差除外）、数量不再可买或最新含费报价超过已核对的最高支付时，要求重新核对。指纹覆盖 Registry/Core/Tools/FeeRouter、代币与模块、报价资产、注册的 beacon/实现、EIP-1967 和标准 EIP-1167 代理实现。指纹用于检测核对期间变更，不代表完整安全审计。
- TradeExecuted 回执单独核验 token/trader/preset/vault/quote、方向、请求数量、实际成交数量、支付上限和费用一致性。OpenFour 精确数量买入仍可能因成交时的限额/库存改变而被合约缩减；页面按实际成交显示并标明部分成交，不自动补买，不把目标量当成最低保证到账。超出请求数量或支付上限的回执不会被误记为完成。

## 经典 Four V2

- BSC 56 普通币对买卖，支持原生 BNB 与 ERC20 报价。
- V1、已迁移、X Mode、经典 TaxToken/TaxToken8/TaxToken9 与动态防狙击费用模式仍只查询。
- 数量买入先调用 Helper3.tryBuy(token, amount, 0)，然后调用 buyToken(token, amount, maxGrossCost)。maxGrossCost 对曲线成本上浮滑点；支付/授权上限另计协议费（包括最低费用）和 Helper 返回的固定附加支付。普通买入及卖出遵守 GWEI 数量精度。滑点默认 1%，范围 0.01%–99.99%。
- 经典 V2 卖出最低金额约束扣费前曲线收入，页面明确标记，与 OpenFour 的净到账约束区分；额外路由费为 0。

## 提交与恢复

余额不足时不提交；授权不足时单独预演并确认精确数量，非零旧授权不足需先单独清零。授权确认后不自动买卖，必须重新核对报价并确认。

币安风险提示、完整交易参数和授权变更保留展示。预演最长 60 秒且最多执行一次。Flap、转出和 Four 共用持久账本及浏览器锁。超时、手机待确认或未知结果都保留未决状态，不自动重发或清理记录。

回执核验链、发送方、目标、完整调用数据、value、nonce、规范区块哈希、事件和至少 3 个区块确认。手动粘贴交易哈希只核验已有交易，不会发送交易。Gas 为估算，实际费用以链上为准。

## 验证与接口依据

0.3.2（2026-10-25）：196 项通过、0 失败、1 项 Windows 符号链接权限跳过。新增覆盖数量与报价资产精度不同、每币不同上限、持仓及库存扣减、刷新后填入额度、价格超最高支付、精确授权、部分成交及超量回执拒绝。对币安智能（0xece3…ffff）和 Super Inu（0xb8b7…ffff）各做 100 代币数量买入的只读 RPC 报价、eth_estimateGas 和 recheck，均通过；未签名、授权或广播，未进行真实资金成交验证。浏览器运行版本须用户重新加载至 0.3.2。

0.3.0 历史验证（2026-10-25）：断网自动化测试 177 项通过、0 失败、1 项 Windows 符号链接权限跳过。覆盖资格、持仓上限、含税预算、净到账滑点、授权、代理升级、报价变化、未决恢复、部分成交回执，以及原 Flap/转出/二维码回归。真实验证仅查询公开 BSC 合约与已安装 Native Messaging 程序的状态：正确识别用户提供的 Super Inu，指纹覆盖 26 个相关合约，测试地址返回 Agent ID 资格错误。当时钱包未登录，未发送登录请求、授权、买卖或转账。

OpenFour ABI 与机制依据固定提交 6e1b1c3a3c77be383784e23f5f01198d34690f1e：

- [OpenFour 集成文档](https://github.com/four-meme-community/openfour-docs/blob/6e1b1c3a3c77be383784e23f5f01198d34690f1e/docs/integration-guide.md)
- [Agent ID 专属模式](https://github.com/four-meme-community/openfour-docs/blob/6e1b1c3a3c77be383784e23f5f01198d34690f1e/docs/mechanisms/binance-agent-id-exclusive.md)
- [官方交易示例](https://github.com/four-meme-community/openfour-docs/blob/6e1b1c3a3c77be383784e23f5f01198d34690f1e/scripts/trade/tradeFlow.js)
- [Binance Agentic Wallet / AI Pro](https://web3.binance.com/en/dev-docs/products/agentic-wallet/ai-pro)
- [经典 Four 交易说明](https://github.com/four-meme-community/fourmeme-docs/blob/main/docs/trade-guide.md)
- [币安合约预演与提交](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/external-sign.md)

经典 Helper3：0xF251F83e40a78868FcfA3FA4599Dad6494E46034；经典 V2：0x5c952063c7fc8610FFDB798152D69F0B9550762b。OpenFour Registry：0x912CEf0C3aE9Ab6eB3Ec87cab69371cFb317Ab94；Core：0xebe7b6C1089D9F72aD07f34E36d898e44E5e27f3。交易继续通过币安预演/确认接口，不安装使用 PRIVATE_KEY 的 Four CLI。
