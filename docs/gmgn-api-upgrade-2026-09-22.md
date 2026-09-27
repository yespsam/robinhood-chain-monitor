# GMGN 接口客户端升级核验（2026-09-22）

核验时间：北京时间 02:07–02:15。模式保持模拟盘；没有钱包登录、签名、广播或实盘交易。

## 已完成

- 本机全局 `gmgn-cli` 从 `1.5.4` 升级到 npm 当时的最新版 `1.6.6`，版本固定安装，禁用安装脚本。
- 先在隔离目录安装、检查配置、验证真实回包，再通过现有跨进程请求锁替换全局客户端。没有停止主监控、资金流监控、旧模拟盘或页面服务；后续子进程调用直接使用新版。
- 原客户端备份：`/tmp/yesp-gmgn-upgrade.CVvh6Y/backup-gmgn-cli-1.5.4`（临时目录，不保证永久保留）。没有复制或修改密钥文件。
- `node --test test/gmgn-*.test.js test/paper-strategy-*.test.js`：174 项通过，0 失败。日志在 `/tmp/yesp-gmgn-166-regression.log`。
- 升级后行情、内盘及资金流均观察到继续刷新。页面模拟账户仍为 $100、0 持仓、0 成交，自动模拟开仓开关开启；真实执行、签名、广播均关闭。

## 真实回包的结论

| 检查 | 实测 | 对系统的意义 |
| --- | --- | --- |
| Robinhood 公开聪明钱流 | 请求 200 条，返回 100 条，无后续游标；100 条通过现有逐笔解析 | 新版没有消除来源流截断，不能宣称全链或五分钟窗口完整 |
| Robinhood 完整画像 `portfolio stats` | 两个地址只返回一个；第一个地址能解析为画像，第二个缺失 | 保留已有单地址降级，不恢复盲目批量画像 |
| 新版 `portfolio profits` | 两个地址返回两条且地址逐一匹配 | 可批量查询盈亏，但不包含完整画像所需的胜率、钱包年龄等，不能直接替换 `stats` |
| 币安公开聪明钱信号 | Robinhood（4663）及 BSC（56）各请求 5 条，均 HTTP 200、业务成功、返回 5 条 | 当前网络能读取这两条链的公开信号；不是逐笔流连续覆盖验证 |

新版还取消了内盘默认平台的客户端固定白名单，改用服务端默认支持范围。此次没有修改策略门槛、重置模拟账本、清空资金流状态或绕过冷却。

## 尚未实施及边界

- 没有切换或接入币安作为生产资金流源，没有安装或授权币安交易钱包。
- 新增批量盈亏接口仅做了兼容性验证，尚未进入自动筛选路径。
- 币安的公开 Smart Money/KOL 查询与交易钱包授权是不同能力；币安广场的已保存凭证也不是钱包凭证。
- 官方追踪文档列有 Robinhood、BSC、Solana、Base、Ethereum；但是链支持、逐笔字段、窗口完整性、钱包盈亏口径仍需分别验证，不能仅凭一个接口成功就认定整体兼容。
- 币安 Smart Money WebSocket 包含同一 `signalId` 的重复状态更新；必须去重，不能把每次推送累计成新买入或新资金。
- 下一步若接入双源，应先并行只读验证逐笔标识、重连缺口、同链同 CA、价格新鲜度及画像口径，保持来源分离，验收后再纳入模拟盘判定。

官方参考：

- [GMGN CLI / Skills](https://github.com/GMGNAI/gmgn-skills)
- [GMGN 钱包接口说明](https://github.com/GMGNAI/gmgn-skills/blob/main/skills/gmgn-portfolio/SKILL.md)
- [币安钱包追踪接口说明](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-wallet-tracker/SKILL.md)
- [币安追踪命令、免授权查询及推送语义](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-wallet-tracker/references/cli.md)
