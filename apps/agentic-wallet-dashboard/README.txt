【历史资料：0.3.5 原始快照】
以下是原版本记录，不代表 0.4.0 的功能、当前登录状态或交易授权。当前说明请见 README.md 与 SOURCE_ANALYSIS.md。

Agentic Wallet 本机工作台 0.3.5

当前阻塞（2026-10-23）：本人已确认返回授权链接同时触发域名与路径不匹配。官方文档未列出完整授权地址范围，项目停止放宽校验。钱包尚未连接，真实交易与自动策略禁用；待确认项见 待官方确认.txt。

0.3.5 授权地址诊断（2026-10-23）
本人在 0.3.4 的实际诊断为 AUTH_URL_REVIEW_REQUIRED / SIGNIN；后续只读核对返回 UNCONNECTED，不能称为连接成功。
旧诊断未说明 URL 哪一项不符。现只保留固定类别：解析、协议、域名、路径、用户信息、端口、片段；不保存或输出实际地址内容。
本版保持原授权地址校验，未因排障放宽域名或拼接链接。官方文档示例与实际响应是否一致仍待核验。

0.3.4 限流循环修复（2026-10-23）
原先核对官方状态也会重设 10 秒授权冷却，导致核对后立即连接再次被本地限流。
现已分开处理：只读状态核对不消耗或延长 signin 冷却；真正生成授权请求仍受冷却与并发保护。
若仍在前次 signin 冷却内，顶部和卡片显示相同秒数，自动恢复按钮；倒计时结束不会自动发起授权。
模拟测试已验证失败 → 立即核对状态 → 冷却倒计时 → 可再次连接；真实官方授权结果须由本人继续验证。

0.3.3 网络兼容修复（2026-10-23）
本人在 0.3.2 点击连接后，实际得到 SIGNIN / REQUEST_TIMEOUT / 50001002，未返回扫码授权链接。
只读检测：官方域名 DNS 成功、直连 TCP 443 超时；Windows 已有代理，但 Node 子进程没有代理环境。
现在仅为官方 CLI 子进程沿用 Windows 已配置的单一本机 HTTP(S) 代理；不改变系统配置、不新建代理、不推测地址或端口、不降低 TLS 校验。
IPv4 通配绕过规则转换成 Node 文档支持的 IP 范围；已有显式代理环境和 NO_PROXY 保留。不自动接纳远程、带凭证、SOCKS、PAC 或分协议代理。
本机 Node v24.13.0 支持 NODE_USE_ENV_PROXY=1；此适配仅对 Windows / Node 24+ 启用，较旧版本保持原环境。
通过现有代理访问 web3.binance.com 与 www.binance.com 公开主页均收到 HTTP 202。该检查只证明公开 HTTP 连通性，不证明授权 API、账户资格或钱包连接成功。
官方授权仍由本人在页面发起并在 App 确认。真实交易和自动策略继续禁用。
回退本次网络适配：server/main.mjs 将 walletChildEnvironment({ enabled: true }) 改成 enabled: false 后重启。无需改系统代理。
运行时官方依据：
https://nodejs.org/download/release/v24.13.0/docs/api/cli.html#node_use_env_proxy1
https://nodejs.org/download/release/v24.13.0/docs/api/http.html#built-in-proxy-support
https://learn.microsoft.com/en-us/windows/win32/wininet/enabling-internet-functionality

0.3.2 诊断修复（2026-10-23）
旧版把 AUTH_REJECTED 以外的官方错误合并为 OFFICIAL_ERROR，无法据此定位失败原因；已丢弃的原始错误不能恢复。
新版保留已与官方 CLI 1.11.0 发行包核对的错误名称/代码对、有限连接错误标识及显式 HTTP 错误状态。不保留原始消息、链接、凭证或文件内容。
未知错误只保留范围受限的数字错误码，具体含义标记未确认；不据此推断账户资格或要求额外 API Key。
诊断格式 schema=2，diagnosticScope 区分 CURRENT_FAILURE（当前失败）、PREVIOUS_FAILURE（上次失败）和 NONE，phase/stage 为当前状态。
诊断增强已通过模拟测试；本人的真实 SIGNIN 失败结果及后续网络修复见上方 0.3.3 记录。无需重装依赖。

打开 http://127.0.0.1:51769/，无需看板密码。
已开放：官方 App 钱包连接、完整地址确认绑定、余额/历史/待处理/Swap 订单/挂单/EVM 授权读取、真实 Swap 报价。
未开放：Swap 真实购买提交、转账、链上撤销、限价创建或取消、自动策略与离线运行。
原因：官方 market-order quote 文档没有价格影响、完整 Gas、逐笔费用及授权额度方案，无法满足既定的提交前审阅要求。不是官方没有 swap 命令。

连接步骤
1. 点击顶部或原卡片的“连接 Agentic Wallet”。后端先核对官方 wallet status；只有 UNCONNECTED 才调用 auth signin，已有连接仍须核对地址。
2. 链接就绪后，主动点击“打开官方授权页面”，在 App 核对配对码与授权范围后由本人确认。不会使用异步 window.open；不猜测或拼接链接。
3. 后端保持 auth verify 等待，只有 wallet status 确认为 CONNECTED 才展示候选地址。
4. 在 App 核对各网络完整地址，勾选确认并绑定。本页只获得应用内部只读能力；不能声称官方凭据只含只读权限。
5. 选择官方返回网络查询资产，或填写完整代币合约、数量、滑点获取真实 Swap 报价。
已有 CLI 连接仍须核对地址。拒绝使用前端传入的钱包标识。没有你确认就不显示真实账户数据。
测试阶段未触发实际 auth signin/verify/signout、未读取本人钱包、未提交交易；这些步骤须由本人在页面实际完成。

状态、超时和诊断
顶部固定入口在工作台及接入核查页共用原卡片状态。打开授权页面不等于连接成功。
官方文档说明 auth verify 最多等待 5 分钟；其本地保护时限为 310 秒。signin、status 等保留本地 25 秒上限，文档没有承诺这些步骤的官方时限。
失败/超时后，“核对状态后重试”只检查官方状态，不会直接再发起 signin/verify；未连接时，再次由本人点击连接申请新码。
“停止本页等待”清理浏览器轮询及链接，保留已有 verify 子进程等待官方完成；不代表取消远端授权。前次操作未结束时拒绝重复启动。
启动失败、进程异常退出、超时、解析失败、官方错误分别提示阶段和下一步。复制脱敏诊断只包含白名单字段，不含地址、配对码、授权链接、命令行、凭证或原始输出。
在官方授权页面仍须自行完成 App 操作；本版不代填密码或验证码、不打开官方会话文件。

版本与开通前提
本机安装：@binance/agentic-wallet 1.11.0；本次官方技能 requiredCliVersion：1.11.0；本项目审查固定版本：1.11.0。
“最新发布版本”和“通用最低支持版本”未确认，不能把 requiredCliVersion 当成它们。
官方开通指南要求 Binance 账户及 Binance App 中的 MPC Wallet；本人是否满足仍未确认。当前官方 CLI 接入不要求额外填写 API Key。

官方依据
https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/SKILL.md
https://developers.binance.com/en/docs/products/agentic-wallet/quickstart/install-agentic-wallet
https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/authentication.md
https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/wallet-view.md
https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/wallet-setting.md
https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-agentic-wallet/references/market-order.md
https://www.binance.com/en/support/faq/detail/87cbb1ca0df34a348eaecb73c26167d7

安全边界
仅监听 127.0.0.1，无公网/局域网监听与防火墙例外。不开看板密码意味着本机其他进程或能使用本机的用户仍可能访问；依赖 Windows 账号与设备安全，不能保证只识别某个自然人。
只接受精确 Host/Origin、同源 JSON；浏览器能力凭据只在当前页面内存，服务端内存绑定。无 Cookie、浏览器持久存储、密钥收集或登录令牌读取。
页面凭据闲置 10 分钟、最长 1 小时失效；新页生成能力凭据使旧页失效。后台轮询不延长期限。
每次账户读取/报价前后检查本页会话、官方状态、授权期限、网络和钱包地址。异常不返回过期私有数据。
断开本页与退出官方 CLI 分开；页面断开不撤单、不撤销代币授权，也不停止外部策略。
CLI 自行管理官方会话。本项目不打开官方会话文件。CLI 会话的独立隔离和正式只读授权能力仍待官方确认，同一系统用户下其他 CLI 工具可能共享其状态。
应用连接只允许读取和报价，不放行 CLI 的 swap/send/approve/revoke/limit 写操作。服务费 FAQ 不等于完整逐笔交易费用。

启动 / 撤销
Node.js 22+，本机 v24.13.0。依赖固定 @binance/agentic-wallet 1.11.0，符合当前官方 requiredCliVersion。
源码 ZIP 首次解压执行 npm ci --ignore-scripts --no-audit --no-fund；启动 npm start 或 .\start.ps1。
“断开本页连接”只废弃本页会话；“退出官方 CLI”独立确认后调用官方 signout，并显示实际结果。
如需撤销链上授权，在官方入口核查处理；本页面不执行链上撤销。
停止服务：前台 Ctrl+C；隐藏进程只停止本项目的 PID，不终止所有 Node 进程。
恢复纯模拟：server/main.mjs 中将 walletAccess: true 改为 false 后重启；真实接口会被后端拒绝。
恢复旧版本可使用先前保存的 0.2 源码包；不要覆盖或删除官方 CLI 会话文件。
测试 npm test；替身只用于测试，生产启动不注入替身钱包。
