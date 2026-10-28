# YESP 网页交易扩展（Chrome / Windows、macOS）

0.3.0 的 `https://four.meme/*` 顶层页面面板与独立 `four.html` 交易台，支持查询、经典 V2 普通币对及 OpenFour Agent ID 专属模式的买卖确认。`wallet.html` 为共享的 Binance Agentic Wallet 扫码及代币转出入口，并提供币安官方 Agent ID 链接。Four 使用独立参数校验、一次性 60 秒预演和精确授权确认，和转出、Flap 共用持久账本及防重复提交锁。参见 [FOUR_MEME.md](FOUR_MEME.md)。以下 Flap 说明仅适用于原 Heyi.ai 流程。

Windows 安装、路径、ACL 与迁移说明见 [WINDOWS.md](WINDOWS.md)。以下 macOS 注册路径只适用于 macOS；Windows 使用当前用户注册表与 `.exe` 启动器。0.1.4 的独立钱包页面会显示本机生成的登录二维码、原始官方链接、配对码和有效期。

这是仅连接本机 Agentic Wallet 的 Chrome Manifest V3 扩展。界面显示在 `https://flap.sh/apps/agent-bonding-curve` 上，支持已核验的 Heyi.ai 市场买入、卖出、领取。这里的“领取”是领取该市场已发行的代币。未绑定的新市场不会自动接受网页传入的合约。

安装、加载、刷新扩展都不会买卖、授权或领取。交易由扩展界面上的明确操作触发，原来已经取消的交易不会恢复。

## 安装

项目要求 Node.js 22 或更新版本。先在项目目录执行：

```sh
node scripts/install-flap-extension.mjs --dry-run
node scripts/install-flap-extension.mjs
```

安装器只注册用户级 Native Messaging Host，并生成固定 Node 路径与固定宿主脚本路径的启动器。它不会修改 Chrome Preferences、关闭浏览器安全保护或提交钱包交易。

接着在 Chrome 完成：

1. 打开 `chrome://extensions`，开启“开发者模式”。
2. 点击“加载已解压的扩展程序”，选择此项目的 `extension` 文件夹。
3. 核对扩展 ID 为 `elekekjeabljofoefoccekebfdalomfp`。
4. 打开或刷新 Flap 的 Agent Bonding Curve 网页，在扩展界面检查钱包、市场、余额与准备状态。

公钥保存在 `extension/extension-public-key.txt`，用于固定扩展 ID。没有保存生成时的私钥；该公钥也不是钱包密钥。Native Host 注册文件的位置是：

```text
~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.yesp.flap_wallet.json
```

移动项目目录或更换 Node 安装位置后，重新运行安装器。若更新源码，在扩展管理页面点击扩展的“重新加载”。

## 速度和执行状态

常驻 Native Messaging 连接可以省去对话、重复选择市场和每次建立浏览器连接的时间。能否在 5 秒内提交仍取决于登录是否有效、余额与授权是否足够、报价和模拟响应速度，以及币安是否要求 App 确认。链上确认时间与“已提交”不同，界面应分别展示。

准备步骤与交易提交分开。最新报价、份额上限、模拟和官方要求的确认仍然有效；不能为了时限绕过失败预演或把“已发起”当作“已成交”。需要补币、授权或 App 确认时会显示具体阶段。

不要通过重复点击、刷新或断开连接重试一个结果未明的交易。宿主会保留已开始的操作并尝试完成；Chrome 或操作系统强制终止进程时，必须依靠本机持久账本核验结果。重新连接时先检查状态，未知结果不能重新下单。

提交期限从点击触发引擎请求开始计时。超过 15 秒便停止发起新的买入或准备交易，已广播的交易继续核验；已确认的卖出所得兑换 BNB 属于该次卖出后续步骤。兑换或授权先成功而买入尚未提交时，界面会说明已完成的步骤，下一次点击重新核验后继续。

当前官方 CLI 对合约交易可能仅返回 App 待确认订单而没有交易哈希，也没有提供合约交易结果查询命令。这种情况会保留待核验状态并阻止重复交易，不能把 App 确认视为链上成交。需拿到交易哈希并核验后才能解除，当前版本不提供自动猜测或清空记录按钮。

开发时只读实测：完整市场准备查询约 1.73 秒，本机通信到钱包状态返回约 2.35 秒。这不是实盘成交或提交速度；没有为测速动用资金。未登录时先使用“扫码连接”，App 要求的确认仍需本人完成。

## 本机边界

- 扩展仅能调用固定的方法；钱包页面额外提供 `walletStatus`、`transferPrepare`、`transfer`、`transferReconcile`。转出方法只接受本扩展的顶层钱包页面，需先核对预览再确认；没有通用命令、脚本路径或 CLI 参数接口。
- Chrome 只向登记的扩展开放此宿主。宿主还会核对启动参数中的扩展来源和本地公钥派生 ID；直接无来源启动会被拒绝。
- 网页内容不能直接调用钱包命令。扩展服务线程须验证来源，再把结构化参数发给本机引擎。
- 钱包密钥和登录凭据不进入网页或扩展存储；显示给用户的官方扫码登录链接及配对码只用于明确的登录请求。
- `stdout` 仅包含长度前缀的 JSON 消息，诊断只输出脱敏的错误代码到 `stderr`。
- 所有测试使用假引擎、临时目录和合成数据，没有广播真实交易。

## 卸载

在 `chrome://extensions` 移除此扩展，再删除上面的 `com.yesp.flap_wallet.json` 注册文件即可。不要删除钱包登录数据或交易账本。无需更改 Chrome 全局设置。

协议依据：[Chrome 官方 Native Messaging 文档](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging)。
