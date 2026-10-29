# YESP 统一交易面板：交易机制与支持范围

1.0.0 已改为本地部署。当前入口是 `http://127.0.0.1:8717`，使用方法见 [本地面板](LOCAL_TERMINAL.md)。下面原扩展入口作为兼容方式保留，交易机制由两种入口共用。

点击 Chrome 工具栏 YESP 图标进入 `trade.html`。同一页面内获取币安登录二维码、验证连接、粘贴 CA、查询、买入、卖出。原钱包转出页保留，使用同一个本机 Binance Agentic Wallet 会话。Four 和 Flap 不另建钱包或登录账户；合约要求的 Agent ID 资格、开发者模式、余额和授权仍分别检查。

## 操作

1. 更新后在 `chrome://extensions` 对 YESP 点击重新加载，再点击工具栏 YESP 图标。原网站浮窗需刷新网页。
2. 未登录时点击“连接钱包”，获取二维码，用币安 App 扫码，核对配对码，然后“已扫码，验证连接”。二维码和配对信息只保留在本页面内存。
3. 粘贴完整 BSC CA，或 Four/Flap 代币页链接，点击“识别代币”。Flap Agent 的预测代币 CA 也可识别，无需粘贴 Market 地址，不再绑定 Heyi.ai。
4. 买入填代币数量。快捷键为 100、1K、10K 和可买上限；上限按钮先重新读取。卖出填数量，或选择 25%、50%、75%、100%；比例按钮也先刷新实际持仓。
5. 点击“核对买入 / 卖出”，检查钱包、完整 CA、结算币、数量、滑点、最高支付 / 固定投入、最低到账及币安预演。勾选后才可提交。授权单单独确认，授权上链后必须重新核对买卖。
6. 已提交但结果未明时保留记录，面板阻止重复提交。可填入币安已有交易哈希核验；核验不会重发交易。

## 路由和支持范围

| 市场 | 识别与交易 | 限额与数量 |
| --- | --- | --- |
| Four 经典 V2 普通内盘 | Helper 验证 TokenManager，`tryBuy/trySell` 报价，`buyToken/sellToken` 交易 | 买入目标数量、含费最高支付；数量按合约 1e9 原始单位步长 |
| OpenFour Binance Agent ID 专属内盘 | Registry + Core + Tools + 动态模块绑定；`Core.buy/sell` | 读取创建总量的 1% 持仓上限、当前持仓及剩余供应；卖出不依赖 Pancake 池 |
| Flap Agent 虚拟份额内盘 | 官方 Factory 的 `marketOfToken(CA)`，Reader/Portal/Market/Probe 交叉绑定 | 虚拟份额余额、Agent ID 资格及持仓额度；BNB `buy`，ERC20 报价资产 `buyWithQuote`，`sellBps` 卖出 |
| Flap 普通内盘 | 官方 Portal `getTokenV8Safe`、`quoteExactInput`、`swapExactInput` | 读取 `maxBuyPerOrigin/buyQuotaOf`，累计额度按当前钱包查询；卖出不会恢复累计额度 |
| Flap Agent 毕业 | 真实代币进入普通 Flap 路由，同时显示可领取资产 | 未领取的虚拟份额不能当 ERC20 余额卖；领取单独预演和确认 |

Flap 的公开接口主要是固定投入交易。面板用同一区块的实际链上报价反算接近目标数量的投入；不是保证精确输出。确认页显示预计和最低收到，市场变化时成交数量可不同，不自动补买。Agent 卖出按持仓万分比向下取整，最小 0.01% 持仓步长，核对页显示实际份额。BNB/BNCB 等结算资产按市场原币种处理，不自动将卖出所得再换成 BNB。

已迁移到 DEX 的池、Four V1、经典 Four X / 部分税费模板和动态防狙击模式、其他未接入 OpenFour preset 仍只读或明确拒绝交易。本版不承诺覆盖所有新模式，不使用错误内盘合约作为降级。Flap 的迁移目标可能是 V2、V3、Pancake Infinity 或 Uniswap V4，不能仅凭 `LaunchedToDEX.pool` 非零就认为存在可用 Pancake V2 池。

## 实现与验证

- 新页面专属类型化消息：`panelStatus/Query/Prepare/Execute/Reconcile`。网页和原钱包转出页不能直接调用这些交易方法；扩展顶层来源、参数和预览 ID 都校验。
- 所有市场与转出共用持久账本和提交锁。提交前复核钱包、Nonce、市场阶段、额度、合约代码、代理实现、原始 calldata 和 Gas；只执行此前币安预演持有的请求，不接受网页提供交易地址或 calldata。
- 只读 RPC 层不允许签名或广播；确认后由官方 CLI 执行。确认期间出现未知结果不会自动重试或清空账本。
- UI 使用交易方向切换、数量快捷键、持仓比例、滑点及复核弹窗，参考 GMGN 常见交易组织方式；未接入 GMGN 的账户、托管、自动跟单或止盈止损。
- 新增路由、额度、份额卖出、授权目标、代理变更、领取、跨市场重复提交与消息边界测试。隔离 Chrome 测试使用模拟钱包，不连接真实钱包，覆盖过期、钱包断开、CA 切换、确认和窄屏布局。
- 公共 BSC 只读验证：用户的 Four Agent 币、Flap Agent BNB 市场、普通 Flap BNB 内盘通过数量报价、Gas 模拟和提交前复查；BNCB/UUSD 余额不足会拒绝。没有发起真实授权、买卖、领取或转账。

## 官方依据（读取日期 2026-10-25）

- [Four 经典交易指南](https://github.com/four-meme-community/fourmeme-docs/blob/main/docs/trade-guide.md)
- [OpenFour Agent ID 模式](https://github.com/four-meme-community/openfour-docs/blob/main/docs/mechanisms/binance-agent-id-exclusive.md)
- [OpenFour 集成指南](https://github.com/four-meme-community/openfour-docs/blob/main/integration-guide.md)
- [Flap 合约地址](https://docs.flap.sh/flap/developers/deployed-contract-addresses)
- [Flap 代币状态](https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/inspect-a-token)
- [Flap 交易接口](https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/trade-tokens)
- [Flap 累计买入额度](https://docs.flap.sh/flap/developers/preview/recent-release/v5.14.16-buy-quota)：官方标注预览文档，已同时验证主网读取接口。
- [Flap 迁移目标说明](https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/token-migration)
- [Flap Agent 官方应用](https://flap.sh/apps/agent-bonding-curve)：ABI 取自应用组件 `v20261023134909522_agent-bonding-curve_8b26639fea52`，源文件 SHA256 `08545080fdc1e4c8d86e827cb56a3d1f748d8369d905e29b1b1b98b374ddc83f`。只解析文本并验证链上绑定，未执行下载的组件。
- [GMGN 交易交互参考](https://docs.gmgn.ai/index/auto-trading-quick-buy-take-profit-stop-loss)：参考布局与参数组织，不移植其中的自动交易策略。


## 1.11.3 查询可用性

`panelQuery` 可传入布尔值 `marketOnly: true`，仅读取当前 CA 的公开链上市场，完全不调用钱包服务。完整查询中的钱包或持仓故障分别放在 `wallet.error`、`holdingsError`，余额为 null 而非零。链上合约绑定失败仍返回错误；该只读参数不能用于准备或提交交易。界面先绘制市场，再更新持仓，丢弃旧 CA 或旧钱包的迟到响应。钱包恢复后刷新状态会重取持仓。并发显示请求合并同一次钱包读取，签名检查不使用此结果。

普通 Flap 的 `TokenBought` / `TokenSold` 事件用于链上备用 K 线。事件 CA 未 indexed，因此首屏读取最近 1,200 个区块，每次日志请求最多 200 个区块，在解码后核对完整 CA，只缓存该代币的成交与时间戳。买入报价金额计入事件手续费、卖出事件金额已扣费；图表按结算资产标价，不与 GMGN 的美元 K 线混合。

新币扫描仍按已选择的 Agent 市场范围；普通 Flap 币可以直接粘贴 CA 查询，无需先出现在 Agent 扫描目录。

GMGN 的当前接口返回 `volume` 为美元成交额、`amount` 为代币数量；旧字段表与其顶部说明冲突，已结合实时返回核对并修正映射，避免将一百多万枚代币显示成一百多万美元成交额。参考：https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-market/SKILL.md 。
