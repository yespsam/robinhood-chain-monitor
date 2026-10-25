# Flap v5.25.0 适配与部署验收

## 原因与变更

链上既有 BSC Portal 已返回 v5.25.0，但本地固定 v5.24.0 的版本、实现地址和代码哈希。拒绝继续是身份校验的保护行为，不应只跳过版本检查或删除状态来恢复。

本次把共享 pin 更新为经双源固定区块确认的完整 v5.25.0 元组，并将唯一允许的持久化状态迁移前驱改为精确 v5.24.0。生产迁移仍须双源同块身份与日志通道区块哈希校验，并原子提交；保留原游标、基线、待处理项、事件和旧证明，不重新初始化到链头。

source gate 单独保留精确旧身份的有界历史证明窗口，不改写历史证明；未知元组、拼接身份及未核实的版本区间仍拒绝。模拟盘深度/内盘成交读取随共享 pin 加载新版本，原每 CA、金额、双向报价、税费、仓位、120 秒和最早三个不同 CA 约束不变。

兼容性证据见 [固定区块报告](./flap-v525-compatibility-evidence-2026-10-21.md) 与 [原始 JSON](./flap-v525-compatibility-evidence-2026-10-21.json)。PublicNode/NodeReal 于固定块 128782994 确认版本、实现及哈希；type 7 小额读报价双向成功。保留大额 Panic(17) 反例，不将小额结果推广为正常预算可卖性。

## 部署前基线

UTC 2026-10-20T17:05:58.591Z（北京时间 10-21 01:05:58）：

- 主进程 PID 815，BSC 子进程 1048；模拟面板 PID 814；独立 GMGN/X PID 829。
- Flap cursor.nextBlock=128103371，anchor=128103370，baselineEstablishedAt=2026-09-03T09:53:09.737Z。
- quoteAssets=24，processedEventKeys=30，eventRecords=30，finalizedCheckpoints=128，auditTrail=4，pending=0。
- 最近成功 2026-10-17T04:05:48.028Z；当前错误 `FLAP_QUOTE_PORTAL_VERSION_MISMATCH`。期间还观察到共享 RPC 冷却/容量等待，不以版本修复代表网络问题已消失。
- 模拟模式 paper，execution/signing/broadcast 均 false。原成交 307 笔，末 ID `1792275648715:306`，成交数组 SHA-256 `75aecaa369d070f9962bc192f796b44df34012d67af6e15747f8ef84c001f437`。
- 封存旧账本 `data/yesp-atm-confirmed-pvp-v2-20260923.json` SHA-256 `09d472310b1ce816bf02875d2988ab67ee5d657ee1f66905001dcba84ec60e36`，与 session.legacy.sha256 相符。
- 状态、主模拟账本、封存旧账本、multiarm 与发布源码归档保存在 `data/backups/flap-v525-20261021-u7wdN4/`。

## 测试与部署状态

专项回归已通过；全量命令 `node --test --test-concurrency=2 --test-reporter=spec`：**4185/4185 通过，0 失败、跳过或取消**，耗时 301213.760375ms。`git diff --check` 通过。

UTC 2026-10-20T17:12:22Z 对 `gui/501/com.qohfq.robinhood-launchpad-monitor` 发送 SIGTERM，17:13:52.607Z 日志确认正常排空完成；新主进程 PID 76849 于 17:13:53.218Z 开始心跳，BSC 子进程 PID 76850。未强杀、删锁或跳过写入。排空约 90.4 秒，该间隔不算连续采集。

17:15:25Z 对模拟面板 `gui/501/com.qohfq.yesp-atm-dashboard` 发送 SIGTERM，launchd 正常拉起新 PID 77576（17:16:10Z）。独立 GMGN/X PID 829 未变，未操作其进程。

17:14:38.284Z Flap 双源身份迁移成功：新实现与 v5.25.0 哈希匹配，verifiedBlock=128784266。17:16:15Z 与部署前备份逐项比较，cursor、quoteAssets、pendingEnableCandidates、processedEventKeys、reorgOrphanedEventKeys、eventRecords、finalizedCheckpoints、auditTrail 全部原样保留。迁移后只读核对原 307 笔成交数组哈希和封存旧账本全文哈希均未变。

17:18:04Z 本地 `/api/strategy-state` 返回 HTTP 200，mode=paper，execution/signing/broadcast=false；退出监控 running=true、lastError=null；报价调度 `evidence_preserving_event_lease_v1`；独立对照 `profit_retention_multiarm_v3` observing、error=null、pendingWrite=false，原 baseline=305、cursor=307 保留。

### 恢复验收尚未通过

版本问题已经解决，**不等于实际补扫已经恢复**。自然重试中分别遇到 Sentio `eth_getLogs` HTTP 429、NodeReal 共享容量等待和 NOWNodes host/method 冷却。最终 17:22:23.849Z（北京时间 01:22:23）cursor 仍为 **128103371**，尚无新增成功扫描区间。迁移后已累计 7 次失败，最近一次为 Sentio 的 `FLAP_QUOTE_GET_LOGS_FAILED` / HTTP 429；既有调度下一次尝试时间为 17:25:08.403Z。迁移时记录的 lastSuccessAt 仅证明该次身份迁移，不能用于宣称游标已推进。

17:21:27.934Z 再次校验：模拟模式和三项执行禁用边界保持，仍为 307 笔成交；原成交数组哈希、封存旧账本全文哈希均与部署前相同。此次交付状态为 **版本适配及部署完成，采集恢复验收被 RPC 可用性阻塞**，不是全面恢复。下一项应处理采集 RPC 的容量/限频及独立来源可用性，不能靠更改版本号、跳头、删锁或降低双源门槛解决。

保持原双源要求、后台优先级、共享限频与共同冷却，未增设通道、调高并发、改账户/仓位/策略、重建数据或跳过历史区间。进程继续依原调度自然重试，完整补扫和实时覆盖仍待实际证据。

## 不能据此推断的事项

未获得准确升级交易/激活区块，也未独立取得新版本产生的新配置事件 receipt；首次观察区块不是激活区块。事件生产路径继续按地址、topic、精确布局、交易 receipt 与规范链校验，不以官网或进程在线替代证据。旧游标补扫不是实时发现，采集开始推进不代表数日断档已补齐，更不代表保证第一时间狙击或盈利。
