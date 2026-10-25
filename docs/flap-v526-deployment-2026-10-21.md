# Flap v5.26.0 适配、部署与游标恢复验收 — 2026-10-21

检查窗口：UTC 2026-10-21 10:13–10:55。链上身份与接口兼容性证据见[固定区块核验报告](./flap-v526-compatibility-evidence-2026-10-21.md)及[JSON](./flap-v526-deployment-2026-10-21.json)；本次机器验收快照见[JSON](./flap-v526-deployment-2026-10-21.json)。

## 结果

Flap 适配器已从 v5.25.0 精确升级为 v5.26.0 身份，专项回归和仓库顶层测试通过，并经主进程正常排空后由 LaunchAgent 拉起新进程。之后多次运行态检查确认 v5.26.0 身份、健康状态及单调递增的 Flap 游标；共享 RPC 冷却/超时会间歇性阻塞周期，但随后自然周期恢复。双源链头快照显示 Flap 扫描落后从约 7,813 块降至 19 块，Four 最近快照落后 10 块。**这是有时间戳的有限观测窗口，不表示当前永远零落后、连续在线或 RPC 429/容量等待已经消失。**

## 适配依据和限制

- 固定区块 128920137 的两路 RPC 身份、升级交易及 `eth_call` 兼容性证据见兼容报告。适配保留精确 v5.25.0 迁移前驱；未知区间 128914122–128914178 仍不作身份推断。
- 共享 pin、状态验证、source gate 与 Flap 报价读取使用同一身份；旧版本测试改为拒绝 v5.25/v5.24/v5.23，v5.27 用作未知身份反例。事件、receipt、规范区块及双源校验门槛未放宽。
- 官方部署地址文档仍列旧版本；v5.26.0 实现源码及 source-to-bytecode 对应关系尚未验证。因此这里是对链上身份和指定只读接口的兼容性适配，不是实现源码审计或合约安全审计。小额样本报价不能代表所有 token/金额均可卖。

## 测试

- 变更相关测试：`node --test test/flap-portal-pins.test.js test/flap-quote-monitor.test.js test/paper-internal-depth.test.js test/bsc-inner-trade-events.test.js test/bsc-inner-trade-monitor.test.js`：344/344 通过。
- 仓库顶层测试：`node --test --test-concurrency=2 --test-reporter=spec test/*.test.js`：4,363 通过、0 失败、0 取消；`git diff --check` 通过。
- `npm test` 默认递归到 `data/backups/` 下无配套源文件的归档测试并出现模块缺失；归档未改动。验收采用明确限定为顶层 `test/*.test.js` 的完整现行测试集。

## 部署与采集观察

- 部署前主进程 PID 23653、LaunchAgent `gui/501/com.qohfq.robinhood-launchpad-monitor` 在线。按共享 RPC 协调器当时的门控，经正常 SIGTERM 排空；UTC 10:34:54.776 发出信号，UTC 10:38:45.093 日志确认 shutdown complete。未强杀、手动删除锁、提高并发/限额或改变 cooldown。LaunchAgent 于 UTC 10:38:45 拉起主进程 PID 48659；模拟面板 PID 1275 未重启，独立 GMGN/X 进程未操作。上述正常停机约 230 秒是采集覆盖缺口，不计为连续在线。
- 迁移后首次有效状态保留 `baselineEstablishedAt=2026-09-03T09:53:09.737Z`、quoteAssets=24、pendingEnableCandidates=0、processedEventKeys=30、eventRecords=30、finalizedCheckpoints=128、auditTrail=4。迁移只通过精确 v5.25.0 元组和当时双源身份校验，不重置研究基线/资产事件记录。
- UTC 10:41:13.309 状态 cursor.nextBlock=128923777；UTC 10:43:07.440 为 128924024；UTC 10:44:46.600 为 128924243。末次状态的身份 v5.26.0、verifiedBlock=128924242，`_health.status=healthy`、`consecutiveFailures=0`、`lastError=null`。多次推进说明不是仅更新了展示状态。
- Flap 双源链头观察于 UTC 10:27 的窗口起点记录 safeHead=128921935、扫描游标 nextBlock=128914122，约落后 7,813 块。中间 UTC 10:44:44.222 双源快照记录 safeHead=128924233、游标 nextBlock=128924216，落后 17 块。状态随后于 UTC 10:44:46.600 推进至 nextBlock=128924243 / verifiedBlock=128924242；UTC 10:47:23.045 到 nextBlock=128924595 / verifiedBlock=128924594。UTC 10:47:49.679 的一次扫描因 Sentio `getBlock` host/method cooldown 失败，游标保持；UTC 10:48:44.094 自然周期恢复健康并到 nextBlock=128924773 / verifiedBlock=128924772。UTC 10:49:25.145 再遇 NOWNodes finalized-lane timeout，游标未提交；UTC 10:49:59.413 自然周期再次恢复健康并推进到 nextBlock=128924946 / verifiedBlock=128924945。
- 最新 Flap 运行态快照 UTC 10:55:24.026 显示 v5.26.0、cursor.nextBlock=128925659、verifiedBlock=128925658、health=healthy、无错误。UTC 10:54:38.550 的双源观察 safeHead=128925554、同一快照 cursor.nextBlock=128925535、lag=19。相对窗口起点 lag=7,813 已减少 7,794 块；短时 lag 会随链头增速波动，不宣称每一采样都单调缩小。
- Four 双源快照 UTC 10:43:35.312：safeHead=128924080、cursor.nextBlock=128924072、lag=8。UTC 10:47:32.677 快照 lag=11、UTC 10:49:45.696 lag=15、UTC 10:52:01.945 lag=12；最新 UTC 10:54:35.098 为 safeHead=128925545、cursor.nextBlock=128925535、lag=10。Four 游标从 UTC 10:27:39 的 128921954 到最新快照增加 3,581 块。两 collector 使用相同的两路来源 ID，分别保留快照时间，不把异时链头伪装为同块比较。
- 重启后仍遇到共享 RPC host/method cooldown、容量等待及 NOWNodes timeout；失败周期未写入游标。之后既有调度自然重试并恢复健康、推进，不需放宽门控。本次没有移除冷却或绕过资源仲裁；间歇容量等待仍是剩余风险。
- 本地 `/api/strategy-state` HTTP 200，但该 payload 不包含 Flap monitor 字段；面板链头观察是 display-only 文件，不能替代直接读取的运行态游标，也不能作为交易许可。报告中的游标一致性以同一时戳的状态文件和 `cursorObservedAt` 链头快照为证。

## 模拟盘与历史保护

- 主账本仍为 `paper`，`execution=false`、`signing=false`、`broadcast=false`。主成交 309 笔，末 ID `1792567338823:308`；部署前后用于核对的成交数组 SHA-256 为 `806a982c95c465aae2568fc44797e1e989752fabfcf92271b996ab7a20d1da20`。
- 封存历史账本 `data/yesp-atm-confirmed-pvp-v2-20260923.json` 的既有 SHA-256 为 `09d472310b1ce816bf02875d2988ab67ee5d657ee1f66905001dcba84ec60e36`，与 session.legacy 声明一致。账本未被重建或回写；旧暂停 BSC 积压未恢复，未执行交易、签名、广播。

## 后续检查

继续沿用原四小时检查节奏，复核 Flap/Four 的双源链头时间戳、游标锚点与成功/错误状态，以及 RPC 共享容量等待和 cooldown。若后续无成功证据，保持 lag 为未知，不从旧快照外推；不扩大重试/并发或改变限频、双源和交易安全门槛。此轮观察到积压显著下降，不代表所有中断区间都已逐事件补齐，也不证明任何策略盈利。
