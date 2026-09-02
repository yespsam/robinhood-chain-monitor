# Ubuntu 24.04 单活部署

这套部署把代码、凭证和持久状态严格分离：

- 代码发布：`/opt/robinhood-chain-monitor/releases/<release-id>`，`current` 是原子切换的只读软链接；
- 机密环境：`/etc/robinhood-chain-monitor/monitor.env`，必须 `root:root`、权限 `0600`；
- 固定运行参数：`/etc/robinhood-chain-monitor/runtime.env`，安装器强制 `DATA_DIR=/var/lib/robinhood-chain-monitor` 和 `FOMO_CALL_STANDALONE=true`；
- 持久状态：`/var/lib/robinhood-chain-monitor`，属于无登录权限的 `robinhood-monitor` 用户；
- 日志：systemd journal；健康快照：`/var/lib/robinhood-chain-monitor/health.json`。

> **禁止双活：** Mac 和云服务器不能同时运行。两个节点各自拥有 outbox 时，Telegram 可能重复推送。安装后的云服务器默认是 `INACTIVE`，只有 `robinhood-activate --confirm-old-node-stopped` 才会启动。
>
> `ACTIVE` 只是本机的人工流程锁，**不是跨机器 fencing 或分布式租约**，无法从技术上证明另一台机器已经停机。当前防双活依赖“旧节点持久 disable → 验证进程退出 → 最终同步 → 激活新节点”的人工顺序。若以后实现自动故障转移，必须先增加外部分布式租约；不得仅复制或删除 ACTIVE 文件来切主。

## 1. 服务器与前置条件

生产机直接建议使用 **4 vCPU / 8 GiB RAM / 80 GiB SSD** 的 Ubuntu 24.04。2 vCPU / 4 GiB / 40 GiB 只是硬性最低线；使用最低配置前必须降低 main/Fomo 的 V8 heap、完成持续压力测试并验证不会触发 OOM，否则不要上线。

systemd 固定执行 `/usr/bin/node`，发布器固定使用 `/usr/bin/npm`，两者必须来自同一套 Node.js 22+ 系统级安装。只有 nvm、asdf 或用户私有目录中的 Node/npm 会被安装器拒绝，避免安装检查通过但 systemd 启动失败。还需安装 rsync 和 git，并确认服务器可以直接访问 Telegram、GitHub、Binance、BSC RPC、Flap/Four 与 X 降级源。

安装脚本会创建非 root 用户、安装固定版本 `gmgn-cli@1.5.4`、安装 systemd 单元和管理命令，但**不会启动监控，也不会创建真实密钥文件**：

```bash
cd /path/to/robinhood-chain-monitor
sudo bash deploy/bin/install-ubuntu.sh
release_id="$(sudo robinhood-release "$PWD")"
sudo robinhood-switch-release "$release_id"
```

将真实配置安全传到服务器，不要通过 Git、聊天或 shell history 粘贴密钥：

```bash
sudo install -o root -g root -m 0600 /secure/staging/monitor.env \
  /etc/robinhood-chain-monitor/monitor.env
sudo rm -f -- /secure/staging/monitor.env
```

`monitor.env` 可以从 `/etc/robinhood-chain-monitor/monitor.env.example` 开始填写。不要加入 `export`。`DATA_DIR`、`ONCE`、`FOMO_CALL_STANDALONE` 和 `FOMO_CALL_GMGN_CLI_PATH` 由安装器生成的 `runtime.env` 最终覆盖，不应写入密钥文件。

上线前还必须配置一个独立于该服务器和 Telegram Bot 的 HTTPS dead-man heartbeat（例如外部 uptime 服务的专用 ping URL）。URL 本身视作密钥，不得提交 Git：

```bash
sudoedit /etc/robinhood-chain-monitor/health.env
# 新增一行；不要在等号两侧留空格，也不要加引号：
HEALTH_HEARTBEAT_URL=https://heartbeat-provider.example/unique-secret-path
sudo chown root:root /etc/robinhood-chain-monitor/health.env
sudo chmod 0600 /etc/robinhood-chain-monitor/health.env
```

外部服务应在连续 60 秒未收到 heartbeat 时通知至少一个独立渠道。`robinhood-activate` 会拒绝没有 HTTPS heartbeat URL 的节点。默认 heartbeat 表示服务、文件和关键游标仍在运行（`operationalHealthy=true`）；主机断电、网络中断、服务退出或关键游标停滞会停止心跳。上游 403/429、BSC 历史缺口、X 覆盖受限、Thesis 缺凭据及普通 outbox 积压会在 `health.json` 中降低 `coverageComplete`/`deliveryComplete`，但默认不会伪装成进程死亡。若希望这些覆盖或投递问题也停止 heartbeat，可在 `health.env` 设置 `HEALTH_HEARTBEAT_REQUIRE_COVERAGE_COMPLETE=true`。

## 2. 零重复切换

先做一次在线预同步以缩短最终停机时间；此时云端仍不得激活：

先在云端为 SSH 用户创建私有暂存目录，再同步：

```bash
ssh cloud-user@cloud-host 'install -d -m 0700 "$HOME/robinhood-state-import"'
rsync -a --exclude='logs/' /local/project/data/ \
  cloud-user@cloud-host:robinhood-state-import/
```

随后严格按顺序执行：

1. 在 Mac 停止三个 launchd 任务，并确认两个 Node 进程都已退出：

   ```bash
   launchctl disable "gui/$(id -u)/com.qohfq.robinhood-launchpad-monitor"
   launchctl disable "gui/$(id -u)/com.qohfq.fomo-call-monitor"
   launchctl disable "gui/$(id -u)/com.qohfq.robinhood-monitor-log-rotate"
   launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.qohfq.robinhood-launchpad-monitor.plist"
   launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.qohfq.fomo-call-monitor.plist"
   launchctl bootout "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.qohfq.robinhood-monitor-log-rotate.plist"
   pgrep -fl 'robinhood-chain-monitor/src/(index|fomo-worker)\.js' || true
   launchctl print-disabled "gui/$(id -u)" | grep -E 'robinhood|fomo'
   ```

   `launchctl disable` 是防止 Mac 下次登录后自动恢复旧节点的持久保护；只做 `bootout` 不足以防止未来双活。

2. 只有上一步没有监控进程后，做最后一次增量同步：

   ```bash
   rsync -a --delete --exclude='logs/' /local/project/data/ \
     cloud-user@cloud-host:robinhood-state-import/
   ```

3. 在云服务器上导入状态并修正权限。目标路径必须是下面这个精确目录：

   ```bash
   sudo rsync -a --delete "$HOME/robinhood-state-import/" /var/lib/robinhood-chain-monitor/
   sudo chown -R robinhood-monitor:robinhood-monitor /var/lib/robinhood-chain-monitor
   sudo chmod 0700 /var/lib/robinhood-chain-monitor
   ```

4. 激活命令会在确认服务未运行后删除复制来的旧 Fomo PID 锁，并写入本机 `ACTIVE` 标记：

   ```bash
   sudo robinhood-activate --confirm-old-node-stopped
   systemctl is-active robinhood-monitor.service robinhood-fomo.service
   sudo systemctl start robinhood-health.service
   sudo cat /var/lib/robinhood-chain-monitor/health.json
   ```

若云端验证失败，先运行 `sudo robinhood-deactivate --confirm`，再决定是否恢复 Mac。绝不能在云端仍为 ACTIVE 时启动 Mac。确认云端已退役后，Mac 回滚命令为：

```bash
launchctl enable "gui/$(id -u)/com.qohfq.robinhood-launchpad-monitor"
launchctl enable "gui/$(id -u)/com.qohfq.fomo-call-monitor"
launchctl enable "gui/$(id -u)/com.qohfq.robinhood-monitor-log-rotate"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.qohfq.robinhood-launchpad-monitor.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.qohfq.fomo-call-monitor.plist"
launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/com.qohfq.robinhood-monitor-log-rotate.plist"
```

## 3. 发布、切换和回滚

从私有 GitHub 拉取新代码后先创建不可变发布；发布命令不会碰 `.env` 或 `data/`，也不会自动重启：

```bash
git -C /srv/robinhood-chain-monitor fetch --prune origin
git -C /srv/robinhood-chain-monitor checkout --detach <reviewed-commit>
release_id="$(sudo robinhood-release /srv/robinhood-chain-monitor)"
sudo robinhood-switch-release "$release_id" --restart
```

若更新包含 `deploy/systemd/` 或 `deploy/bin/`，仅创建 release 不会更新 `/etc/systemd/system` 与 `/usr/local/sbin` 中的已安装副本。必须先退役节点，重新运行 `sudo bash deploy/bin/install-ubuntu.sh`，检查单元差异，再重新激活；安装器会拒绝覆盖正在 ACTIVE 的节点。

切换会先优雅停止两个服务、原子更换 `current` 链接，再一起启动。回滚时使用同一命令选择旧 release ID：

```bash
ls -1 /opt/robinhood-chain-monitor/releases
sudo robinhood-switch-release <previous-release-id> --restart
```

不要删除当前 release。清理旧 release 前应先核对 `readlink -f /opt/robinhood-chain-monitor/current`，并至少保留一个已验证的回滚版本。

## 4. 日志与健康检查

```bash
journalctl -u robinhood-monitor.service -u robinhood-fomo.service -f
journalctl -u robinhood-health.service --since '15 minutes ago'
systemctl status robinhood-monitor.target robinhood-health.timer
```

健康计时器每 15 秒独立检查以下 lane，不再用“任意一个文件最新”掩盖另一条停滞链路：

- Robinhood `state.json`；
- Binance 公告进度与 WebSocket/轮询覆盖；
- BSC 的 WAL 或权威 snapshot；
- `github-state.json`；
- `platform-capability-state.json`；
- Fomo 状态、checkpoint、X 状态和 Thesis 状态；
- 两个 durable outbox 的解析、失败记录与积压时间；
- ACTIVE 标记、两个 systemd 服务，以及外部 HTTPS heartbeat。

每条 lane 的 `operationalHealthy`、`coverageComplete`、权威文件、文件年龄、阈值和原因都会写入 `health.json`；顶层另有 `deliveryComplete`。阈值在 `/etc/robinhood-chain-monitor/health.env`；该文件包含 heartbeat URL，必须保持 `root:root`、`0600` 且不得提交 Git。生产默认要求所有四条 Fomo lane；只有对应业务在 `monitor.env` 中被明确关闭时，才可在 `health.env` 把相应 `HEALTH_REQUIRE_FOMO_STATE`、`HEALTH_REQUIRE_FOMO_CHECKPOINT`、`HEALTH_REQUIRE_FOMO_X` 或 `HEALTH_REQUIRE_FOMO_THESIS` 改为 `false`，并在变更记录中写明原因。

运行或关键游标停滞（`operationalHealthy=false`）会以非零状态写入 journal 并停止外部 heartbeat，同时始终更新不含密钥和 heartbeat URL 的 `health.json`。默认情况下，仅覆盖不完整或投递积压会把总状态降为 `degraded`，但 CLI 仍为零且 heartbeat 继续；设置 `HEALTH_HEARTBEAT_REQUIRE_COVERAGE_COMPLETE=true` 后，`coverageComplete=false` 或 `deliveryComplete=false` 也会停止 heartbeat。**健康检查只报警，不会因状态停滞自动重启服务**；这样可以避免上游全网故障时形成重启风暴。

systemd 已配置 `Restart=on-failure`、`RestartSec=5s`、`UMask=0077`、`LimitNOFILE=65536`、90 秒优雅停止窗口和只允许写入状态目录的文件系统沙箱。网络中断时进程不会被无意义地重启；网络恢复后现有重试和 durable outbox 会继续工作。若状态长期不推进，应先检查上游连通性与 RPC 限流，再人工重启，避免在全网故障时制造重启风暴。

## 5. 主动退役节点

```bash
sudo robinhood-deactivate --confirm
systemctl is-active robinhood-monitor.service robinhood-fomo.service || true
test ! -e /etc/robinhood-chain-monitor/ACTIVE
```

只有上述检查通过后，才允许把最终状态复制到新节点并激活新节点。
