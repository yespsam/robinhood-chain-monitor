# 主模拟盘：Gas 计入账本，不作为入场否决条件

用户授权：所有 Gas 按链上数据，不能仅因 Gas 高拒绝潜在机会。只应用于主模拟盘后续新仓，不启用实盘，不改写旧成交、旧仓成本或独立对照盘。

## 费用从哪里来

- ETH / BSC：读取近期公开 swap 回执中的 `gasUsed × effectiveGasPrice`。
- Base：在上述执行费用之外加入回执的 `l1Fee`，不漏掉 L1 数据费用。若出现未实现的非零 operator fee 计费规则，标记不支持，不擅自算零。
- Robinhood：Nitro 回执中的 gasUsed 已含父链费用，不重复加 gasUsedForL1。
- SOL：读取已确认交易的 `meta.fee`（含网络优先费）。独立小费、账户租金、平台服务费不在 meta.fee 中，不冒称已涵盖。
- 原生币美元换算读取主网 Chainlink ETH/USD、BNB/USD、SOL/USD；校验主网身份、feed 描述、精度、round 和更新时间。ETH feed 最长一小时，BNB/SOL 最长一天，公开保留原始更新时间，不声称是逐秒成交价格。

每链最多取三笔近期链上成交费用的中位数，GMGN 既有公开交易哈希优先；缺样本的 EVM 链可读近期区块的 swap 回执。校验链、交易、发起地址、CA 转账和区块时间。读取区块时退后两块，避免 L2 最新块时间略领先本机造成未来证据。无新增 GMGN 行情请求，无签名、广播或私钥访问。

**这是“真实链上样本支持的模拟费用估算”，不是本订单的实际路由报价。** 未广播的模拟交易没有自己的实际 gasUsed。不同 CA、路由、授权、账户创建和拥堵可能产生不同费用；不能把链级样本称为精确的本次手续费。

## 入场和记账分离

- 普通、内盘、外盘结构、Alpha 与监控事件入口统一采用 `gas_accounting_not_admission_v1`：Gas 不参与 5% / 15% 的比例门槛，也不参与结构空间入场否决；平台费、滑点、税费的原检查仍在。
- 完整含 Gas 的成本、保本价格、净盈亏情景仍保留；不能把“允许模拟”说成“预计盈利”。
- 串行成交重新校验费用证据并足额扣账；Gas 已耗尽预算时没有可买数量，不能制造负余额。
- 新仓退出使用退出当时的新鲜费用样本，不锁死成买入时 Gas；旧仓继续原口径。
- 缺失、过期、跨链或无效费用不是零。无法记账时等待证据；未知与费用昂贵是不同状态。
- 采集单飞、每轮至少间隔 30 秒、最多两条链同时采集；样本最多五分钟、获取结果最多 90 秒有效。持仓报价与 TG 不等待费用网络请求。

## 验证

相关回归测试覆盖高 Gas 下的结构 / Alpha / 消息入口、Gas 足额入账、余额不足、过期与跨链证据、退出费用刷新、重启恢复，以及对照盘不继承主盘授权。

上线验收：676 项相关测试通过。北京时间 21:46 主模拟盘五条链均返回 `gasEvidenceReady=true`，入场费用口径均为 `gas_accounting_not_admission_v1`，服务无错误、无签名或广播权限。公开只读站点已同步新成本说明。重载前备份的 145 条历史成交完全保留；原口径旧仓自然卖出不冒称新规则成交。主 TG 与 FOMO worker 均保持原进程运行。

## 资料

- [Ethereum JSON-RPC](https://ethereum.org/developers/docs/apis/json-rpc/)
- [Base 网络费用](https://docs.base.org/specifications/transactions/network-fees)
- [Arbitrum Gas](https://docs.arbitrum.io/how-arbitrum-works/gas-fees)
- [Solana getTransaction](https://solana.com/docs/rpc/http/gettransaction)
- [Chainlink BNB/USD](https://data.chain.link/feeds/ethereum/mainnet/bnb-usd) 与 [SOL/USD](https://data.chain.link/feeds/ethereum/mainnet/sol-usd)
- [Robinhood 官方网络资料](https://robinhood.com/us/en/support/articles/robinhood-chain-testnet/)
