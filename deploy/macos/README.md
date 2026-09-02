# macOS 本机稳定性守护

这一目录只增加三个非 root LaunchAgent，不修改现有生产监控的 plist：

- `com.qohfq.robinhood-ac-sleep-guard` 执行系统自带的 `/usr/bin/caffeinate -s`。`-s` 只在交流电供电时声明 system-sleep assertion；拔掉电源后不会阻止正常休眠，也不会修改 `pmset` 的持久系统设置。
- `com.qohfq.robinhood-local-watchdog` 每 60 秒检查 main/Fomo 的 launchd PID 与各进程自己写入的 runtime heartbeat。仅当 heartbeat 年龄连续两次都大于 120 秒、网络路由可达且不处于明确的 `source_limited`/`rate_limited`/`offline`/`degraded`/`partial` 状态时，才会重启对应进程。每个服务重启后有 10 分钟冷却，同一轮最多重启一个服务。
- `com.qohfq.robinhood-vpn-watchdog` 每 30 秒独立检查系统中由 `com.vpn.cat` 配置的快喵 VPN。它不读取、不重启也不向 main/Fomo 发信号。

注意：`caffeinate -s` 不能保证 MacBook 合盖后仍保持运行；本机作为生产节点时应保持开盖并接通交流电，或迁移到不会睡眠的服务器。

runtime heartbeat 每约 30 秒由对应 Node 进程在本地原子写入，独立于 Binance、BSC RPC、X 和 Telegram 请求结果。默认使用：

- main：`data/main-runtime-heartbeat.json`；
- Fomo：`data/fomo-runtime-heartbeat.json`。

因此普通 API 403/429、RPC 降级或没有新事件不会自动触发重启。断网、VPN 只有残留路由但无法完成 Telegram TLS 握手，或者系统无法确认网络时也不会重启。连通性探针最长 4 秒，不发送 Bot Token 或消息。若以后有独立的小健康报告，可在 watchdog plist 中设置 `MAIN_HEALTH_REPORT` 或 `FOMO_HEALTH_REPORT`；最近 120 秒内刷新且 JSON 顶层的 `sourceStatus`（或 `status`）为 `source_limited`、`rate_limited`、`offline`、`degraded` 或 `partial` 时会显式禁止重启。过期报告不会永久掩盖真正卡死。

## 快喵 VPN 恢复边界

VPN 守护默认启用，但只有 `scutil --nc list` 中恰好存在一个已启用且标签精确为 `[VPN:com.vpn.cat]` 的 NetworkExtension 服务时才工作。服务 UUID 每轮动态读取，不硬编码名称或 UUID；缺失、禁用、重复或格式异常都会以 `not_configured` 失败关闭。

仅当系统状态明确为 `Disconnected`，默认路由是 `enN` 物理接口，并且绑定该接口的国内 HTTPS 探针可达时，才累计一次有效断开。连续两次后只执行一次 `scutil --nc start <动态 UUID>`；不会先 stop，也不会杀死或重新打开快喵应用。`Connecting`、`Disconnecting`、`Reasserting` 和未知状态均不动作。

首版不会因为 RPC、Telegram、X 或其他应用接口报错去重置一个显示为 `Connected` 的 VPN，也不会尝试修复所谓“黑洞隧道”。底层连通性探针不使用 `curl --fail`，因此有效的 HTTP 403、429 或 5xx 都算网络可达，不会被误认为断网。探针不携带业务 URL 参数、Token 或 Cookie。

每次 start 尝试都有 10 分钟冷却；一小时内最多三次，第三次后打开完整一小时 circuit。尝试次数、冷却和 circuit 会在调用 `scutil start` 前先原子写入权限 `0600` 的状态文件并执行持久化屏障，因此命令发出后即使脚本被强杀，也不会在下一轮丢失限额并形成重连风暴。日志只记录动作类型与结果，不记录 IP、探针 URL、VPN 节点或密钥。

## 安装

先检查将要生成的完整 plist，不做任何写入或 launchctl 操作：

```sh
./deploy/macos/install.sh --dry-run
```

安装并加载三个新守护任务：

```sh
./deploy/macos/install.sh
```

如需先落盘审核、暂不加载：

```sh
./deploy/macos/install.sh --no-load
```

第一次从旧版本启用 watchdog 时，应先用 `--no-load` 落盘，在计划内重启 main/Fomo 让新代码开始产生上述两个 runtime heartbeat，并确认它们持续刷新后，再重新运行安装器加载 LaunchAgent。这样不会把尚未加载 heartbeat 代码的旧进程误判为卡死。

安装器必须由当前登录用户执行，拒绝 root。脚本副本、状态和报告存放在权限 `0700` 的 `~/Library/Application Support/robinhood-chain-monitor/`；plist 权限为 `0600`。生产密钥不会被复制或写进 plist。

两个 watchdog 的小报告分别在：

```text
~/Library/Application Support/robinhood-chain-monitor/watchdog/health.json
~/Library/Application Support/robinhood-chain-monitor/vpn-watchdog/health.json
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

卸载只 bootout 并删除这一安装器管理的三个 plist 和两个 watchdog 脚本，不触碰两个生产 plist。历史 watchdog 报告和日志若非空会保留，以便诊断。

## 离线验证

测试全部在 `mktemp` 夹具中运行，使用假的 launchctl、scutil、curl、route、kill、date、sleep 和 sync，不会加载任务、修改系统设置、重启生产、连接 VPN 或访问网络：

```sh
./deploy/macos/test-offline.sh
./deploy/macos/test-vpn-offline.sh
```
