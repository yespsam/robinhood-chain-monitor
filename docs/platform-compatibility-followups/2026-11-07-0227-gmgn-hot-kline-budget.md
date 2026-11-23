# 项目主分支 GMGN 热点 K 线预算变更复核 — 2026-11-07 02:27 UTC

## 结论

项目 GitHub `main` 新增一个 GMGN 只读行情/模拟研究预算改动，未发现签名、买入/卖出交易构造、滑点或钱包路由改动。新增预算把热点 K 线数据抓取提前于低优先级背景读取；单独环境开关可请求 1 秒 K 线，但代码文档和测试仍限定模拟入场使用 1 分钟收盘线。共享账户门控在设计上保留出场优先级与真实请求限速。

当前本地 checkout 并非该提交的完整镜像：14 个关键源码/测试 blob 中仅 7 个与远端 commit 相同、7 个不同；checkout 仍为旧 HEAD `817ff9fc8a79a12137e1658cfb45b343e4c7f46e`，且工作区存在大量预有改动。故不能据 GitHub main 推断本地运行实例已获得这些预算/队列行为，也不应自动合并。

## 上游 refs 与项目提交

检查时间：2026-11-07 02:20–02:27 UTC。

- Binance skills hub：`96563daf34fa5a87af5d76c2f1107d697ae7ce07`，未变化。
- Four.Meme AI：`0a07b65468caa73f552dd6a13013ef5071065996`，未变化。
- Four.Meme docs：`5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`，未变化。
- OpenFour docs：`6f7efd5d3f14ed280cf471f70675ffba6d319943`，未变化，仍为 community/reference。
- Flap skills：`07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`，未变化。
- 本项目 `main` 从 `ab1456672a9dc44504616d390db6f4f082a6f6b9` 前进至 `96a45bfcd8edc7eb04c5d1bbdcb244c09fc501e1`。
- 对六个仓库做了只读 `git ls-remote --tags --refs`，没有返回 tag refs。

项目提交：[96a45bf](https://github.com/yespsam/robinhood-chain-monitor/commit/96a45bfcd8edc7eb04c5d1bbdcb244c09fc501e1)，标题 `Raise hot K-line budget ahead of background reads. (#9)`，提交时间 2026-11-07 02:09 UTC。相关变化集中于 `src/gmgn-account-gate.js`、`src/gmgn-flow-client.js`、`src/gmgn-readonly-market.js`、`src/gmgn-readonly-pacing.js`、`src/readonly-admission-policy.js`、`src/paper-research-budget.js`、`src/paper-entry-funnel.js` 和 `src/paper-strategy-runtime.js`。

## 行为与兼容性对照

- Plus 高频模拟研究的默认图表预算提高到最多 3 个本地 chart 并行槽、每轮 3 张、1.5 秒派发间隔；等待候选/入场重点或候选报价时让出为单槽。Free 默认仍为 1 张、5 秒间隔。可选环境预算范围更高，但共享 GMGN account gate 仍是实际并发/间隔门控；不能将本地预算参数当作服务端套餐认证或越过 429 冷却的许可。
- `GMGN_ONE_SECOND_KLINE=1` 才允许只读市场客户端请求 `resolution=1s`；默认关闭。提交说明及本地测试将模拟入场决策继续绑定 `1m` 收盘 K 线。该功能不证明 Pro 账户资格或任何代币可交易。
- 只读排队将 `market:kline` 类别提升到地址笔记和部分普通背景读取之前；priority-2 出场仍更高。针对热点 K 线/普通报价同为较高优先级时的等待公平性，仍需结合真实请求队列遥测验证；本轮没有发起 GMGN 业务请求。
- `summarizeChartHealth` 的统计只作监控提示，不放宽入场条件。没有发现新签名、交易执行、授权、滑点或买卖路径行为。

## 本地版本验证与测试

远端 main 与本地 blob 对比：`src/gmgn-account-gate.js`、`src/gmgn-readonly-market.js`、`src/gmgn-readonly-pacing.js`、`src/readonly-admission-policy.js` 及相应队列/市场测试样本中部分文件匹配；`src/gmgn-flow-client.js`、`src/paper-entry-funnel.js`、`src/paper-research-budget.js`、`src/paper-strategy-runtime.js` 及其测试样本均有差异。当前运行实例 revision 未知。

本地只运行了相关的离线单测子集：160 tests 中 157 pass、3 fail，三项均在 `test/paper-strategy-runtime.test.js`，涉及 BSC 扫描覆盖字段、focus simulator 快照字段及 recovery narrative admission gate。由于当前本地源与远端 commit 不一致且工作区很脏，不能将这 3 个失败归因到新 main 提交，也不能据此宣称新功能验证通过。

平台状态仍为 Four.Meme 结构化来源 13/13 healthy，Flap 4/5（sitemap 404）；文档 watcher Flap 0/59、Four.Meme 8/10（仍为旧 canonical 路径重定向拒绝）。Four.Meme 配置事件近期反复只改变 `thresholds.totalBAmount`；累计复核中未见费用、报价地址、交易档位、合约、版本、模块、链或页面更新，按滚动阈值数据处理，不归类为新的交易规则。

本轮未读取 `.env`/密钥或私有配置，未连接钱包、签名、广播、买卖、改源码/策略、部署、重启、push 或 merge。建议后续由人工确认当前本地分支/运行实例与 GitHub main 的关系，并复核相关三项失败的代码—测试版本对齐；本任务不自动合并或更改交易路径。
