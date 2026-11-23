# 2026-11-22 监控覆盖与数据新鲜度分层

## 改动

- 将本地行情/资金流健康状态改为机器可读分层：`fresh`、`stale`、`degraded`、`partial`、`waiting`、`invalid_timestamp`、`unverified`。每链保留状态、观测时间与年龄；汇总分别提供 `marketData` 和 `flowData`。
- “没有买点/候选”与采集是否新鲜是两个维度。仪表盘摘要明确指出数据覆盖状态不代表交易机会。
- `/api/strategy-state` 可附带可选的只读 `launchUpdateCoverage` 快照；快照读取失败只映射为 `{status:"unavailable"}`，不泄露底层异常，也不修改策略/账本快照。
- 更新现有四小时 heartbeat：增补来源覆盖与本地市场数据新鲜度分开记录规则，要求缺失快照为 `not_checked`，并禁止为观察而启动服务、读取秘密、请求实时行情或做链扫描。保留原周期、来源范围及安全限制。

## 代码与测试

- `dashboard/coverage-status.js`、`scripts/dashboard-server.js`、`test/coverage-status.test.js`
- `src/platform-document-watch.js` 与 `src/launch-update-coverage.js` 已有的来源健康/覆盖分类作为上游基础；本轮没有修改这两个用户已有编辑的文件。
- 验证命令：`node --test test/coverage-status.test.js test/platform-document-watch.test.js test/launch-update-coverage.test.js test/chain-head-coverage.test.js test/live-gmgn-trader.test.js test/live-manual-approval.test.js test/flap-pool-launch.test.js test/chain-support.test.js test/hyperevm-telegram.test.js`
- 结果：122 tests passed，0 failed；`git diff --check` 通过。测试为离线/本地投影测试，没有访问价格源、连接钱包或广播交易。

## 覆盖边界

本轮未刷新外部上游源或本地行情/资金流快照，因此没有声称这些数据当前新鲜或覆盖连续。机器状态改进仅提升“已采集的证据如何被标注和呈现”，不会自行补足采集缺口，也不改变任何交易策略、限额或风险阈值。此前交易执行 fail-closed 修复仍待人工审查，未在本轮上线或放宽。
