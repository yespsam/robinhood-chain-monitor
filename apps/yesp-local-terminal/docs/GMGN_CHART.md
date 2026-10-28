# GMGN 行情与战壕界面 · 1.6.0

在“交易”页的 K 线区展开 **GMGN 数据设置**，粘贴已有的 GMGN API Key，点击“保存并使用”。输入框随后清空。识别 BSC CA 后自动读取行情；不用填写钱包私钥，也不用另装 gmgn-cli。

设置保存在本机 `.private/gmgn/settings.json`，沿用本项目的私有文件及 Windows 账户权限检查，不写入浏览器 localStorage、不回显密钥、不记录请求正文，也不放进分发压缩包。更换电脑需要重新填写。清除按钮只清除这份行情 Key，不影响币安钱包登录。

## 数据来源

参考用户提供的 `yespsam/robinhood-chain-monitor` 源码中 `src/gmgn-readonly-market.js` 的 `kline()`：该项目调用官方 `gmgn-cli market kline`。本版核对了官方 CLI 的 `OpenApiClient.getTokenKline`，在本机服务直接调用同一个只读接口：

- `GET https://openapi.gmgn.ai/v1/market/token_kline`
- 固定 `chain=bsc`，`address` 为当前 CA；周期为 `1m / 5m / 15m / 1h`。
- `from/to` 使用毫秒，认证 `timestamp` 使用秒；每次新生成 `client_id`，Key 放在 `X-APIKEY` 头部，禁止重定向。
- 价格为 USD；`volume` 是代币数量，`amount` 是 USD 成交额。没有成交笔数字段就不显示笔数，不把成交额冒充数量。

图表请求和自动刷新只读行情，不参与交易报价、钱包授权、预演或自动狙击条件。首次读取最多约 300 根，支持更早历史，单次请求窗口不超过约 7 天；内存展示最多 1600 根。按 CA 与周期隔离缓存、去重进行中的请求，短期复用；429 按服务端重置时间暂停，至少暂停一分钟，冷却持久化到本机。凭据或套餐拒绝后停止请求，直到重新保存设置。

GMGN 尚未收录的新币或没有成交的 CA 可能没有 K 线。默认 **GMGN 优先 · 链上备用**：GMGN 不可用时尝试原有 Agent 内盘链上图，并明确标注原因及结算币单位。两种来源不会合并到同一组蜡烛。可以手动选择只看 GMGN 或只看链上图。网络失败保留旧数据时会明确提示；时间范围是已读取区间，并不保证上游成交完整。

官方依据：

- [GMGN Agent API：行情查询仅需要 API Key](https://docs.gmgn.ai/index/gmgn-agent-api)
- [GMGN 官方客户端接口和认证](https://github.com/GMGNAI/gmgn-skills/blob/main/src/client/OpenApiClient.ts)
- [官方 K 线命令](https://github.com/GMGNAI/gmgn-skills/blob/main/src/commands/market.ts)

## 三栏战壕

界面参照用户提供的 GMGN 战壕截图重做：紧凑深色栏、代币头像、名称 / CA、社交资料、税费与分红、进度、持有人、买卖次数和链上状态。默认打开战壕页，支持名称 / CA 搜索、平台筛选、进度排序、暂停列表、复制 CA 和进入交易。

- **新创建**：未接近毕业的内盘市场，以及尚待核验的记录；其中包含官方目录里的较早市场，未知创建时间使用真实市场序号。
- **即将开盘**：内盘进度至少 80% 或已进入迁移阶段，并不保证何时毕业。
- **已开盘**：链上阶段明确为已毕业。内盘币也可能已可买卖，列标题不是交易开关。

仍只收录原有 Four Agent ID 专属 preset 和 Flap Agent Factory 目录，不因外观变更扩展成全部普通币。头像与简介为项目元数据，分红是配置 / 已核验统计，不是收益率。缺失信息不虚构。暂停列表只冻结画面，后台扫描与已授权任务继续；狙击仍先报告更新、由用户明确授权一次。

## 验证范围

已验证接口参数、数据身份和价格量纲、历史合并、限流冷却、凭据隔离与来源回退；浏览器用隔离的模拟响应核对交互。真实 GMGN 回包需用户在本机填写有效 Key 后验证，不把模拟结果当作已接通。测试不发起真实买卖、转账或狙击授权。
