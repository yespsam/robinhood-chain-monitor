# 上游 K 线预算与 OpenFour 工具包增量复核 — 2026-11-07 06:19 UTC

## 结论

GitHub 项目 `main` 从 `96a45bf` 前进到 `96f13fb`（[#10](https://github.com/yespsam/robinhood-chain-monitor/commit/96f13fb6321ed6195c7363bbdea0093d8a3ad3d1)）。改动把未请求 K 线与已请求空响应拆分统计，并给热点/钱包名单的首次 K 线读取相对于普通详情一个有界优先窗口；研究专用报价不再压缩 K 线预算。代码 diff 未涉及 Agentic Wallet、钱包路由、报价/交易构造、授权、签名或买卖逻辑。共享只读队列仍保留出场请求高于研究请求的规则。

本地当前 checkout 仍是 `codex/paper-focus-forward-simulation` / `817ff9fc8a79a12137e1658cfb45b343e4c7f46e`，且 `paper-entry-funnel.js`、`paper-strategy-runtime.js` 等 K 线相关文件存在未提交改动；运行实例 revision 未知。本轮未合并、改源码、部署或重启，不能认为上游 #10 已在本机运行。

## 上游增量

只读 `git ls-remote` 检查了五个监测平台仓库和本项目 main；六个仓库均未公布 tag refs。官方平台仓库 refs 未变：

- Binance Skills Hub：`96563daf34fa5a87af5d76c2f1107d697ae7ce07`
- Four.Meme AI：`0a07b65468caa73f552dd6a13013ef5071065996`
- Four.Meme docs：`5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`
- Flap skills：`07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`
- OpenFour docs：从 `6f7efd5d3f14ed280cf471f70675ffba6d319943` 前进到 `8a75373a0be50c5acd1bd52fc618d632e8666ea4`。新提交将 Royalty / ForwardVault 开发模块及预设加入 BSC Testnet fork 工具包。沿用既有证据分类：OpenFour community/reference，未确认为 Four.Meme 平台规则；本轮没有执行其部署步骤。

项目 #10 主要改动 `src/paper-entry-funnel.js`、`src/paper-research-budget.js`、`src/paper-strategy-runtime.js`、公开状态字段及对应测试/文档。首个热点 K 线请求可以越过普通详情轮转配额，但仍受 focused 并发、派发预算和共享账号门控约束；等待队列测试仍验证出场请求会越过研究请求。没有将 1 秒 K 线变成模拟入场条件；文档仍限定模拟结构判断使用 1 分钟收盘线。

Flap 官方 [Robinhood Chain 集成指南](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide) 本轮直接可读：当前页面列出 `TOKEN_V2_PERMIT`/`newTokenV5` 与 `TOKEN_TAXED_V3`/`newTokenV6`、`V2_MIGRATOR` 和原生 ETH 报价，并要求集成方核验 live config。未发现本轮该指南发生版本变化；本轮没有 RPC 或交易验证。

## 验证

在临时 clone 的上游 `main` 版本运行：

```text
node --test test/paper-entry-funnel.test.js test/paper-research-budget.test.js test/paper-discovery-scope.test.js test/readonly-priority-queue.test.js
22 passed, 0 failed
```

测试使用清空环境变量的 Node 进程和 `/tmp` clone，未复制 `.env` 或 `data/`；只将依赖目录复制到临时 clone。该验证覆盖模拟/诊断与排队 fixtures，不代表实时 GMGN 数据新鲜度，也不证明当前运行服务 revision。

## 覆盖边界

未连接钱包、未读取密钥/`.env`、未调用签名或广播、未下单、未查链上 RPC、未改配置、未重启服务、未 push/merge。下一轮只读核对 #10 是否与本机 dirty K 线/runtime 改动冲突；人工确认前不自动整合。
