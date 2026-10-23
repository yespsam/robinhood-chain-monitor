# Binance Agentic Wallet 技能

本目录保存已安装的 Binance Agentic Wallet 技能文档快照，供监控、研究和模拟交易项目按需查阅。

- 技能版本：`1.13.0`。
- 最低 CLI 版本：`1.11.0`（`@binance/agentic-wallet`）。
- 技能入口：[SKILL.md](SKILL.md)。
- 来源与处理说明：[UPSTREAM.md](UPSTREAM.md)。

## 使用范围

钱包余额、交易记录、报价等能力可用于只读核查；`contract-call preview`、`sign-message preview` 和 `defi preview` 提供预演入口。预演不代表链上成交。

该技能同时包含真实转账、兑换、授权和签名命令。需要执行这些命令时，遵循技能中的用户授权、风险检查和预演流程。本次上传只是文档归档，现有监控与模拟盘没有接入钱包执行器，也没有新增自动任务。

登录需在使用者本机通过币安 App 完成；仓库中的登录 URL、二维码 ID 和配对码都是占位符，不能用于登录。

## 文件边界

本目录仅包含技能说明、参考文档及来源说明，不包含钱包状态、登录会话、密码、私钥、助记词、API 密钥、Cookie、真实二维码、交易账本、持仓或本机配置。不要将这些内容提交到 Git，即使仓库是私有的。

## 参考入口

- [CLI 与连接检查](references/preflight.md)
- [登录流程](references/authentication.md)
- [钱包查询](references/wallet-view.md)
- [报价与市价交易](references/market-order.md)
- [合约与签名预演](references/external-sign.md)
- [交易安全检查](references/security.md)

完整能力和对应参考文件见 [SKILL.md](SKILL.md)。
