# Windows 安装、迁移和故障排查

适用：Windows 10/11 x64；本机测试环境为 Windows x64 / Node 24.13.0。代码允许官方 Windows ARM64 Node 使用，但本次未验证 ARM64。浏览器安装目标为 Google Chrome，不包含 Edge 自动注册。

## 安装位置与组件

在项目目录运行 `npm.cmd ci` 安装锁定依赖，再运行 `npm.cmd test`。`pretest` 会编译 Windows 文件权限辅助程序，不注册浏览器、不读取真实钱包。

`npm.cmd run extension:install -- --dry-run` 只报告拟使用路径和扩展 ID，不创建文件或改注册表。执行 `npm.cmd run extension:install` 才应用安装。

安装产生的文件：

| 路径 | 用途 |
|---|---|
| `.generated/yesp-private-files.exe` | 当前用户权限下的 ACL 检查及账本文件提交 |
| `.generated/native-host/flap-native-host.exe` | Chrome 与固定 Node 宿主之间的二进制消息桥接 |
| `.generated/native-host/com.yesp.flap_wallet.json` | Chrome Native Messaging Host 配置 |
| `.private/` | 本机私有配置及账本的父目录，设置为当前用户与 SYSTEM 可访问 |

可审查的辅助程序源文件位于 `scripts/windows/`；安装器使用 Windows .NET Framework 的 `csc.exe` 编译，不下载预制启动器，不创建服务或计划任务。

注册项为：

```text
HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.yesp.flap_wallet
```

默认值指向上述 JSON 的绝对路径。安装器写入并核验 32/64 位视图；相同宿主名的旧注册项会被指向此次安装目录。若已有部署，先保留并核验其未决账本，再切换目录。

Chrome 只需加载 `extension` 文件夹。移动工程、改变 Node 路径、更新源码后，应关闭使用该面板的网页，重新运行安装器，再重新加载扩展；如 Windows 提示辅助程序正在占用，先退出 Chrome 后重试。

## 配置与迁移

示例 profile 不是可交易配置：钱包和核验区块是占位值，哈希/代理映射为空，报价初值为 0。必须根据实际链上核验结果填写；不要据此编造配置。

不要将 macOS 钥匙串或其他电脑的登录凭据复制到 Windows。使用币安官方扫码流程重新连接。不要将真实 profile、账本或登录资料加入要分享的源码包。

已有账本迁移时，将原操作记录保留为完整副本。在完成 Windows 安装、建立受保护目录后，再复制已核验记录；新建文件应继承目标目录 ACL。若报 `JOURNAL_UNSAFE`，需要核验所有者、访问权限及链接类型，不应通过关闭检查或删除历史记录恢复交易。

本版拒绝 UNC 网络路径、非本机固定 NTFS 卷、符号链接/联接路径。请选用自己拥有的普通目录，不在磁盘根目录或共享文件夹部署。建议目录保持较短，避免系统旧版 .NET/Win32 的长路径限制。

## 常见错误

| 错误或现象 | 处理方式 |
|---|---|
| `WINDOWS_COMPILER_MISSING` | 安装或启用系统 .NET Framework 4.x；检查 Framework/Framework64 下的 v4.0.30319/csc.exe |
| `WINDOWS_HELPER_MISSING` | 在工程目录执行 `npm.cmd run build:windows`，然后重新加载扩展 |
| `WINDOWS_NTFS_REQUIRED` / `WINDOWS_LOCAL_PATH_REQUIRED` | 换到当前用户拥有的本机固定 NTFS 目录 |
| `JOURNAL_UNSAFE` | 核验账本目录和文件 ACL、所有者、硬链接、符号链接及目录联接；不要清空历史 |
| `JOURNAL_COMMIT_FAILED` | 检查文件占用、防病毒软件、磁盘及权限；先核验交易状态，避免重发 |
| `NATIVE_UNAVAILABLE` | 核对 Chrome 加载的扩展 ID、注册项和绝对路径，重新运行安装器 |
| `CLI_NOT_AVAILABLE` | 检查 `npm.cmd ci` 是否成功，以及钱包依赖是否为锁定的 1.11.0 |
| 缺少 profile / `PROFILE_REVIEW_REQUIRED` | 本包不含可交易配置，需要完成钱包及链上合约核验 |
| `UNRESOLVED_TRADE_LOCK` / 未决订单 | 保留账本并核验结果；本次移植没有加入强行解锁或自动重发 |

若 PowerShell 限制 npm.ps1，使用文档中的 `npm.cmd`，无需修改全局 PowerShell 执行策略。

## 卸载

先在 Chrome 扩展管理页移除扩展，再删除该宿主的当前用户注册项。确认默认值指向要卸载的版本后运行：

```powershell
reg.exe query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.yesp.flap_wallet" /ve /reg:32
reg.exe query "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.yesp.flap_wallet" /ve /reg:64
reg.exe delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.yesp.flap_wallet" /f /reg:32
reg.exe delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.yesp.flap_wallet" /f /reg:64
```

两种视图在部分系统上可能共享条目，第二次查询/删除提示不存在可据实际情况判断。保留 `.private/flap/operations/` 和钱包资料，直到全部交易核验完成。卸载插件不撤销链上授权或远端订单。

## 实现依据

- [Chrome Native Messaging：Windows 注册、启动参数与二进制协议](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)
- [Microsoft MoveFileExW：文件替换与 WRITE_THROUGH](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw)
- [Node.js 文件系统：Windows 文件权限与标志的差异](https://nodejs.org/api/fs.html)
