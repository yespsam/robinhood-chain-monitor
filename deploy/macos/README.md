# macOS 本机稳定性守护

这一目录只增加两个非 root LaunchAgent，不修改现有生产监控的 plist：

- `com.qohfq.robinhood-ac-sleep-guard` 执行系统自带的 `/usr/bin/caffeinate -s`。`-s` 只在交流电供电时声明 system-sleep assertion；拔掉电源后不会阻止正常休眠，也不会修改 `pmset` 的持久系统设置。
- `com.qohfq.robinhood-local-watchdog` 每 60 秒检查 main/Fomo 的 launchd PID 与各进程自己写入的 runtime heartbeat。仅当 heartbeat 年龄连续两次都大于 120 秒、网络路由可达且不处于明确的 `source_limited`/`rate_limited`/`offline`/`degraded`/`partial` 状态时，才会重启对应进程。每个服务重启后有 10 分钟冷却，同一轮最多重启一个服务。

注意：`caffeinate -s` 不能保证 MacBook 合盖后仍保持运行；本机作为生产节点时应保持开盖并接通交流电，或迁移到不会睡眠的服务器。

runtime heartbeat 每约 30 秒由对应 Node 进程在本地原子写入，独立于 Binance、BSC RPC、X 和 Telegram 请求结果。默认使用：

- main：`data/main-runtime-heartbeat.json`；
- Fomo：`data/fomo-runtime-heartbeat.json`。

因此普通 API 403/429、RPC 降级或没有新事件不会自动触发重启。断网、VPN 只有残留路由但无法完成 Telegram TLS 握手，或者系统无法确认网络时也不会重启。连通性探针最长 4 秒，不发送 Bot Token 或消息。若以后有独立的小健康报告，可在 watchdog plist 中设置 `MAIN_HEALTH_REPORT` 或 `FOMO_HEALTH_REPORT`；最近 120 秒内刷新且 JSON 顶层的 `sourceStatus`（或 `status`）为 `source_limited`、`rate_limited`、`offline`、`degraded` 或 `partial` 时会显式禁止重启。过期报告不会永久掩盖真正卡死。

## 安装

先检查将要生成的完整 plist，不做任何写入或 launchctl 操作：

```sh
./deploy/macos/install.sh --dry-run
```

安装并加载两个新守护任务：

```sh
./deploy/macos/install.sh
```

如需先落盘审核、暂不加载：

```sh
./deploy/macos/install.sh --no-load
```

第一次从旧版本启用 watchdog 时，应先用 `--no-load` 落盘，在计划内重启 main/Fomo 让新代码开始产生上述两个 runtime heartbeat，并确认它们持续刷新后，再重新运行安装器加载 LaunchAgent。这样不会把尚未加载 heartbeat 代码的旧进程误判为卡死。

安装器必须由当前登录用户执行，拒绝 root。脚本副本、状态和报告存放在权限 `0700` 的 `~/Library/Application Support/robinhood-chain-monitor/`；plist 权限为 `0600`。生产密钥不会被复制或写进 plist。

watchdog 的小报告在：

```text
~/Library/Application Support/robinhood-chain-monitor/watchdog/health.json
```

## 卸载

先预览：

```sh
./deploy/macos/install.sh --uninstall --dry-run
```

再卸载：

```sh
./deploy/macos/install.sh --uninstall
```

卸载只 bootout 并删除这一安装器管理的两个 plist 和 watchdog 脚本，不触碰两个生产 plist。历史 watchdog 报告和日志若非空会保留，以便诊断。

## 离线验证

测试全部在 `mktemp` 夹具中运行，使用假的 launchctl/kill/scutil，不会加载任务、修改系统设置、重启生产或访问网络：

```sh
./deploy/macos/test-offline.sh
```
