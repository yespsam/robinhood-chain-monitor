# Robinhood Chain 发射台与合约部署监控

## 100 美元模拟交易脚本（2026-09-20）

新增独立的 `paper:100`，从现有监控 outbox 只读获取 GMGN 增量信号，账户总初始现金为 100 美元，**不是实盘，也不代表已收到资金或已经盈利**。默认离线检查一次，不增加常驻进程，不发送 Telegram，不读取私钥、不签名、不授权、不广播交易。

```sh
npm run paper:100 -- --once
npm run paper:100 -- --status
npm run test:paper-100
```

每笔模拟投入 10 美元，最多 2 个持仓，现金实际扣减、禁止重复信号开仓。池内费用以只读报价为准，另按每边 0.20 美元 gas、1% 输出折减作保守成本假设；这些不是实时成交成本。净值触发 -20% 止损、+40% 止盈或持仓 30 分钟退出，按当时能取得的有效报价计价，不假装能按触发价成交。UTC 单日累计已实现亏损达到 5 美元、累计亏损达到 10 美元时停止新开仓；这不是损失上限保证。

第一版报价仅支持 BSC PancakeSwap V2（WBNB/USDT/USDC 报价币）。GMGN 的盈利地址/FOMO 标签不能替代独立的钱包群体、LP、持仓分布、控制权限与卖出验证；缺少这些证据时保持观察。官方更新或 Factory 地址不直接生成买入。只有提供精确绑定的独立模拟审核证据，并显式允许只读公网报价，才可能产生模拟成交。详见 [使用说明与未完成事项](docs/paper-100.md)。此功能使用独立现金账本，不启用旧版无限累计名义敞口的影子意向通道。

## Genius.fun 官方监控（2026-09-18）

新增独立、显式启用的 Genius.fun 通道：官方部署清单、接入/机制文档、两个固定数字身份的官方 X 账号、BNB Chain Factory 事件，以及已核实官方地址关联代币的生命周期。官方测试币声明和 CA 会被捕获，但不把同名社区币或一般官方提及误认成官方发行。详见 [Genius.fun 接入说明](docs/genius-monitor.md) 与 [官方来源核验](docs/genius-official-evidence.md)。

## AI 投研团队（2026-09-20）

`yesp atm` 模拟盘新增独立只读投研层。链路、叙事、筹码/资金流、合约安全、行情结构和投委会风控六个部门共享同一份 GMGN 快照，再由总控输出“可模拟 / 观察 / 不买”。叙事必须绑定精确链和 CA；Top10 只作为筹码风险代理，不冒充完整持仓分布；蜜罐、洗量、过期行情或未知可卖性会 fail-closed，不能触发新增模拟。

研究接口为 `GET /api/research-team?chain=bsc&address=<CA>`，页面中的“AI 投研团队”区域展示每个部门的结论、证据新鲜度和纸上交易逻辑。该层不连接钱包、不签名、不广播，也不会单独触发自动交易；自动模拟仍遵守原有仓位、止损、分段回收和最长持仓规则。

## 0.2.0 运行与筛选升级（2026-09-17）

本轮变更、2,086 项测试结果、上线实测与仍存在的数据源限制见 [升级记录](docs/upgrade-2026-09-17.md)。Flap 已在多源身份核验后迁移到 v5.23.1，原游标与基线保留；pon.fun 的跨重启退避与失败计数也已修复。

BSC 满载队列现在根据实际空位恢复历史补扫；实时 RPC 报错不再让队列排空与实时扫描相互等待。所有未补齐的区块和待确认交易继续保留，覆盖缺口不会因升级被清空。

币安普通/Web3 文档请求复用跨重启的限流退避，完整筛选差异后再压缩播报。新增、修订和移除分别表述，接口修订显示旧值与新值；每组文档报告成功页数、总页数和阻断页数。单页断档不会被其他页面成功掩盖。

500 人 KOL 候选筛选支持逐条原子断点、过期证据重试、最久未尝试优先和跨账号数字 ID 冲突隔离。资料核验、人工角色审核与实时监控是不同阶段；500 候选不表示 500 人已审核或已实时覆盖。Fomo X 的重复轮询共享在途任务，避免慢请求形成无限待执行队列。

本机诊断会读取 macOS LaunchAgent、匹配进程 PID 的心跳，以及全部业务状态与播报队列，不再用 Linux 服务名判断 Mac 是否正常：

```sh
npm run health
npm run health -- --json
npm run health -- --no-write
```

默认按需刷新 `data/health.json`，`--no-write` 只读取状态，`--json` 输出完整报告；不调用 Telegram，也不发送外部健康心跳。报告分别展示 `operationalHealthy`（进程/调度）、`coverageComplete`（数据覆盖）、`deliveryComplete`（投递）。只有进程或实际调度故障返回非零退出码；源限流、缺凭据、没有合格跟踪对象仍明确列为覆盖不足。Fomo 空名单只有在最新采集状态与实际空名单相互吻合时，才不把静止链游标误报为卡死。

Ubuntu 的 `deploy/health-check.mjs` 仍默认使用 systemd 和 ACTIVE 标记；本机命令在 macOS 上显式选择 launchd，未改变服务器切主流程。

## 当前生产范围（focus3）

当前 `.env` 使用 `MONITOR_SCOPE=focus3`。Telegram 的通用发射台结构性更新只允许以下 3 个核心平台进入告警队列；pon.fun 采用独立、显式启用的官方身份通道，Morph 另有一条只接受 Long 官方身份和 Flap 官方链上入口的窄通道，Binance 以及 X/xAI/Grok 也保留固定官方身份白名单：

- Flap（含官方 `flap-sh` 代码、官网能力和链上新模式）；
- Four.Meme / OpenFour（含官方配置、模板、平台能力和已认证代码源）；
- Uniswap / Pools.trade（Liquidity Launcher、官方发布、X、官网及限定的 launch/hook/pool 仓库）。

“新东西”限定为首次出现的新 Factory/入口、新模式或新机制、新合约/部署地址、新功能/版本、官方新仓库，以及明确发布这些变化的官方公告或 X。普通代币、普通底池、交易/转账、量能、营销活动、GitHub 的修复/回滚/测试/文档提交、站点单独出现的 V2/V3 关键词均不推送。Pons 与其他未获准的 BSC/Robinhood 发射台、官方地址买卖和早期量能监控均已停用；pon.fun、Binance/Binance Wallet/Binance Futures 使用各自独立的严格官方白名单通道，Fomo 使用独立 worker。历史状态和游标保留，不会因重启清空或回放。

链上首次出现的未知模式先只写入后台候选，第二个独立样本确认同一结构后才进入 Telegram；这份首样本、区块、Factory、模式指纹与证据会保留，作为后续狙击工具的数据基础。GitHub、官网、X 与链上会生成统一语义 ID，30 天内同一个新功能只播报最早捕获到的来源；如果一条更新同时包含“已见功能 + 未见功能”，仍会播报一次，不会把未见功能误删。

告警出口还会再次执行同一份 fail-closed 白名单，因此旧队列中的非 focus3 消息也不会在重启后补发。官网普通功能词、Tokenomics/Fair Launch 文案和页面结构变化不进入告警，只有可验证的新平台合约地址才可从站点通道触发。

### X / xAI / Grok 官方更新

独立监控 X API Changelog、xAI Release Notes 与 xAI News，首次启动仅静默记录当前条目，之后只推送新模型、API/SDK/端点、新产品能力、访问范围/定价、弃用和重大安全更新。融资、招聘、合作宣传、普通 Grok 回复和已有条目的文案改动不会播报。

官方 X 账号使用不可变 user ID 校验：`@X`、`@SpaceXAI`（旧 `@xai` 已重定向）、`@grok` 和 `@API`。账号页无法同时验证 handle 与 user ID 时会失败关闭，不使用模糊结果推进游标。官网、文档、X 与官方 GitHub 的同一能力在 24 小时内合并；预览→正式可用、弃用→移除仍视为不同阶段分别提醒。

实时扫描 Robinhood Chain 主网，记录：

- 所有顶层合约部署；
- 同一交易内出现 ERC-20 铸币与 Uniswap V2/V3 建池的代币发射；
- 未知 launcher/factory 的首次出现与重复活动；
- 已知发射台工厂活动；
- 相对 GMGN 集成清单的缺口候选；
- 同一发射台出现新的函数选择器、日志组合、池类型或部署结构；
- 发射第一枚币之前的疑似 Factory/实现合约部署；
- Telegram 与通用 Webhook 告警。

Robinhood Chain 的主链循环按 1 秒调度。BSC 与 Morph 同样使用 1 秒 HTTP 区块头兜底，并由 WebSocket 负责低延迟唤醒；BSC 官方配置/API 每 5 秒检查。pon.fun Factory 默认每 3 秒进入一次单飞检查，官网 API 的单请求上限为 10 秒；Factory 事件、官网快照和最终区块锚在同一个事务周期内闭环，任一证据暂不可用都会保留原游标并重试，不会把未闭环变化提前当成已确认更新。Flap/Four.meme 平台能力、核心 GitHub 仓库和重点官方 X 账号均进入 5 秒优先通道，其中 X 调度器每 1 秒检查一次到期账号。官网、Uniswap 博客/治理、X API Changelog、xAI Release Notes、Binance 公告详情/开发者源和 Morph 官方页面等主要官方源统一按 10 秒检查；xAI News 保留 30 秒，X 的 Jina 降级源保留 5 分钟最短间隔以避免限流。以上是本地调度目标，实际发现时间仍受上游发布时间、缓存和网络响应影响。

## 快速开始

```bash
npm install
cp .env.example .env
npm run sync:gmgn
npm start
```

结果写入 `data/events.jsonl`，断点和工厂统计写入 `data/state.json`。首次启动默认从安全区块头开始；历史回扫可设置 `START_BLOCK=区块号`。

默认最多追赶 `MAX_CATCHUP_BLOCKS=10000` 个历史区块，并按每批最多 200 个区块补扫。RPC短暂中断或服务重启后不再因为只保留 10 个区块而轻易漏掉中断期间的新 Factory；积压超过约 10000 个区块时才会优先恢复实时监控。

### AI 叙事狙击（影子版）

这一版把“已验证新闻/新底池事实”“叙事评分”“实时市场与安全证据”“影子意向台账”和“双语卡片”分开处理。它会把现有官方新闻事件与 Flap、Four.Meme、pon.fun 的精确新底池身份连接起来；股票、ETF 或其他映射资产只用于解释公司业务和梗，绝不会被当成要买的新币地址。只有精确目标 CA、真实交易池、数据覆盖、可卖性、流动性和保守滑点全部通过，且新闻来源、主体匹配、时效与市场确认达到门槛时，才会生成不可执行的 `shadow` 影子意向；任何 AI 分数都不能绕过硬门。

实时安全证据首版只对 BSC 上身份完整的 V2 池开放：DEX pair 必须精确匹配目标 CA 和池地址，本地合约检查及 GoPlus 字段必须完整且新鲜，单候选总外部请求预算为 5 秒。缺字段、超时、跨链、地址冲突、V3/V4、无法验证可卖性或过期证据一律降为观察/拒绝，不会产生影子意向。pon.fun 的新闻、市场身份和公司叙事可以正常连接，但 Robinhood Chain 的实时滑点/安全适配器尚未实现，因此当前只会观察，不会进入可做状态。

该功能默认关闭。启用本地影子链路：

```bash
NARRATIVE_SNIPER_ENABLED=true npm start
```

接入后，原始监控告警仍走原有 durable outbox；叙事候选同时写入 `data/narrative-sniper-state.json`。通过全部硬门的影子意向写入 `data/narrative-shadow-ledger.json` 及其 checksummed WAL，并以稳定 decision hash 保证重启幂等。影子生命周期 worker 已支持在可信、只读报价证据下完成虚拟开仓、定时估值、止盈、止损、时间退出、重组作废与 PnL 统计；任何未知、过期、冲突或超时证据都只会阻断。

生产影子报价首版只支持 BSC PancakeSwap V2 中目标币与 WBNB、USDT 或 USDC 组成的池。每次报价会从两个不同 RPC 提供商选择共同确认区块，分别重验 pair 的 factory、token 顺序、reserves、decimals、Pancake factory `getPair` 回指，并在同一区块读取审核过的 Chainlink USD feed；两侧结果不一致、区块变化、oracle 过期或自定义 quote asset 都返回 `unknown`。现有保留状态中约三成已核 Flap V2 池为 WBNB 路由；股票等自定义新底池仍只做叙事观察，绝不猜美元成交价。

要同时运行完整影子生命周期，两个开关都必须显式开启：

```bash
NARRATIVE_SNIPER_ENABLED=true NARRATIVE_SHADOW_SIMULATOR_ENABLED=true npm start
```

该路径复用 `BSC_CAUSAL_CLASSIFICATION_RPC_URLS` 中前两个不同提供商根域。默认单 RPC 超时 5 秒、双源证据预算 25 秒、模拟器外层硬超时 30 秒；这是为了完整校验而接受的延迟，不适合作为真实成交执行器。

本实现没有钱包、私钥、签名器、授权、Swap 路由或交易广播代码。`NARRATIVE_SNIPER_ENABLED=true` 也只会产生本地审计记录及 Telegram 影子候选卡，不会真实买入。

运行内置的确定性模拟场景：

```bash
npm run demo:narrative-sniper
npm run demo:narrative-sniper -- --scenario=watch
npm run demo:narrative-sniper -- --scenario=reject
npm run demo:narrative-sniper -- --json
npm run demo:shadow-lifecycle
npm run demo:shadow-lifecycle -- --json
```

演示不访问网络、不读取私钥、不签名、不广播，也不会连接真实交易账户。叙事演示输出 `可做 / 观察 / 不做`、双语理由和可复现的虚拟订单；生命周期演示进一步用固定 fixture 行情走完入场、估值、退出与 PnL。实时链路同样保持 shadow-only，但会读取公开的市场与安全证据；来源不可用时失败关闭。

实时扫描优先索引 Uniswap V2/V3 建池，以及当前已启用发射台的稀疏核心事件，再读取命中交易的完整收据并解析铸币。只有进程启动时会跳过超出恢复窗口的旧积压，正常运行期间按 200 区块批次连续追赶、不主动跳块。若需要无遗漏地覆盖未知内部曲线平台，应配置 Alchemy/QuickNode 专用 RPC。

Docker Compose 同时定义主监控进程 `monitor` 与独立 `fomo-worker`，使 `FOMO_CALL_STANDALONE=true` 时的 X/Fomo 扫描不会因主进程跳过 worker 而形成监控盲区。大V发币 lane 仍不会被部署动作自动打开，必须显式设置 `KOL_LAUNCH_MONITOR_ENABLED=true`；默认 `false` 保持只读代码就绪、运行未启用：

```bash
docker compose up -d --build
docker compose logs -f monitor
docker compose logs -f fomo-worker
```

云端生产环境仍请按 [Ubuntu 24.04 单活部署](deploy/README.md) 同时运行主服务与 Fomo 服务，并执行旧节点停机、状态增量同步、ACTIVE 标记切换。生产规格直接建议 4 vCPU / 8 GiB / 80 GiB；2 vCPU / 4 GiB 仅是降低 heap 并通过压力测试后的最低线。生产环境还应把 `RPC_URL` 换成 Alchemy/QuickNode 等专用 Robinhood Chain RPC，官方公共 RPC 有频率限制。

本机 launchd 部署同时安装 `com.qohfq.robinhood-monitor-log-rotate`，每 15 分钟检查运行日志。单个日志达到 64 MiB 时先压缩到 `data/logs/archive/`，确认压缩文件写入成功后再清空原日志；链上事件、断点、outbox 和监控状态不会被轮转。

## 判定逻辑

“所有部署”是交易收据中可直接观察到的顶层 `CREATE`。发射台通常通过内部 `CREATE/CREATE2` 生成代币，因此监控不依赖内部 trace，而是寻找同一成功交易中的：

1. `Transfer(0x0, recipient, amount)` 铸币日志；
2. Uniswap V2 `PairCreated` 或 V3 `PoolCreated`；
3. 新币地址确实属于新池的 token0/token1。

满足三项标为高置信度发射。调用目标地址会成为 launcher 候选；后续再次产生发射活动时继续累计。这个方法能自动发现尚未录入的新平台，但无法保证识别“只部署工厂、尚未发射任何币”的平台，因为链上没有通用的 launchpad 标准。

没有立即建池、但由合约调用并产生 ERC-20 初始铸币，且该 Token 在前一区块还没有字节码的交易，会标记为低置信度 `new_creation_or_curve`，用于发现 GMGN Trenches 类的内部曲线模式。包装 ETH 的 deposit mint 已明确排除；候选仍需要后续交易或建池事件确认。

## GMGN 差异与新模式

在 `.env` 的 `GMGN_INTEGRATED_FACTORIES` 中维护 GMGN 已覆盖的工厂地址。任何不在该集合中的 launcher 都标记为 `gmgn_gap_candidate`。

跨链成交额突增＋高盈利地址＋FOMO 地址联合播报为独立 opt-in 通道，配置、阈值、叙事出处和链覆盖边界见 [GMGN flow monitor](docs/gmgn-flow-monitor.md)。沿用现有 Fomo worker，不额外启动浏览器或模型常驻进程。

运行 `npm run sync:gmgn` 会通过官方 `gmgn-cli` 拉取 Robinhood Trenches 的三个生命周期列表，生成 `data/gmgn-baseline.json`。监控优先逐币匹配该实时基线，并以 Factory 地址表作为补充。建议通过 cron 每分钟刷新一次；新币刚出现但 GMGN 尚未完成索引时会先保持为缺口候选。

截至本项目最近一次同步，GMGN Robinhood 返回的平台标签包括 `bankr`、`noxa`、`virtuals_v2`、`pool_uniswap_v2`、`pool_uniswap_v3`、`pool_uniswap_v4`。

系统为每个 launcher 记录模式指纹，包含入口函数 selector、池类型、铸币数量、日志/发射器数量及事件 topic 集合。已有 launcher 首次出现不同指纹时标记为 `new_mode_candidate`。模式指纹比单纯比较工厂地址更适合发现 V2→V3/V4、直接建池→曲线毕业、代理升级后事件变化等情况。

### pon.fun 官方更新

`PON_MONITOR_ENABLED=true` 启用完全独立的 pon.fun 通道；它与 Pons / pons.family 没有身份、地址、状态或开关继承关系。监控固定 Robinhood Chain `chainId=4663`、Factory `0xF698d13348686C1529c2DC54847C123424d9DAE0`、Factory runtime hash、部署交易，以及官网 `api/health`、`api/markets`、`api/ponfun`、`tokenlist.json` 和官方 X `@pondotfun` 的 numeric user ID。该信任等级表示“官网绑定 + 链上代码指纹”，不表示源码已验证或合约已经审计。

首次启用只静默记录现有市场和 X 游标，不回放历史。之后播报 Factory 配置、曲线、暂停/恢复、所有权、股票映射、平台币资料和市场生命周期变化；新市场必须同时通过 Factory 精确事件、成功交易回执、区块、官网 markets/token list 与 Factory getter 对账。官网暂未收录时事件会先进入持久待核队列，绝不因 API 缺项猜测删除或错误推进告警状态。PON coin 是股票锚定的链上代币，不是股票本身；当前所有 pon.fun 事件最高只到 T1，普通市场/RWA 更新为 T2，不会自动交易。

### Pons 类早期发现

`PONS_MONITOR_ENABLED` 是 Pons 总开关；设为 `false` 时会同时停用 Pons 链上版本、GitHub、X、官网、官方地址和告警出口，但保留 `pons-version-state.json`、GitHub/X/官网基线及游标，之后恢复不会从空状态重放。当前运行环境已设为 `false`。

Pons 的链上版本、官网、X、GitHub 与官方地址监控代码仍保留，但当前全部不启动；已有状态文件也不删除。之后如果重新开启，会沿用原游标，不回放停用前的历史。重新启用后普通代币仍静默，只保留新 Factory、新迁移与结构性新模块提醒。

### Uniswap 重点监控

Uniswap 已提升为重点源，并采用独立、互不阻塞的监控链：

- 每 10 秒检查官方博客 sitemap，只对新 canonical URL 的发射机制、新底池、部署、协议费或安全更新提醒；`lastmod` 单独变化只更新状态，不当作新内容；
- 每 10 秒检查治理论坛的新 post ID，只播报正式提案和明确的阶段/执行变化，普通回复、Grant 与社区闲聊静默；
- 每 10 秒检查 `Uniswap/liquidity-launcher` Release；`liquidity-launcher`、`v4-hooks-public`、`hooklist`、`v4-periphery`、`universal-router` 的提交进入 5 秒 GitHub 核心通道，同时发现官方组织中新出现的 launch/hook/pool/auction/bonding/Robinhood 仓库；`protocol-fees`、`contracts` 与 `UniswapX` 在 focus3 下不进入监控；
- 官方 X `@Uniswap` 与 Pools.trade `@TradePools` 首次只建基线，之后仅推送发射台、新策略、新底池/Hook、协议部署、治理费率、安全和版本变化；普通币、Swap 与营销内容静默；
- Robinhood Chain 已登记 Pools.trade 的 LiquidityLauncher、LBPStrategy、InstantLaunchStrategy 与 UniversalRouterStrategy 地址。普通代币发行仍静默，只有后续出现不同入口或池型的结构性新模式才提醒。

当前 Pools.trade 支持 Crowd Launch（4 小时 TWAP 拍卖）和 Instant Launch（bonding curve），最终进入 Uniswap v4 永久锁池并自动复投。首次上线会对博客、治理、Release、X 与 GitHub 统一建立静默基线，避免把 8 月 5 日之前的内容当成实时消息补发。

保留的 Pons 实现包括：

- 每 5 秒读取 `https://docs.ponsfamily.com/v2` 的官方合约表；
- 每 5 秒读取已确认 pons 部署者的新建合约并用 v2 Factory 接口特征复核；
- 链上直接订阅 v2 新签名 `TokenLaunched(address,address,address,address,uint256,uint256)`，即使文档尚未来得及公布 Factory，也能从首笔发行完成归因；
- 新 v2 Factory、迁移与结构模式可以在将来重新启用；普通 pons 发行保持静默。

官方 v2 文档目前已公布 Meme Hook `0x8e99D2009D60A917e9B1c00C04C077b8c0c3a044` 与 Fee Escrow `0xbc39B6502E1a6Ab36E4A5c5026A35F08342A0A9c`；它们明确排除在 Factory 候选外，避免误报。

### 发射台 GitHub 新模式监控

监控器检查 Flap、Four.meme、Uniswap/Pools.trade 以及 X/xAI/Grok 严格白名单内的公开仓库。核心白名单仓库按 5 秒优先调度并最多并发检查 24 个仓库；其他固定仓库默认 60 秒，动态候选默认 5 分钟，组织新仓库枚举默认 10 分钟。只有新增生产合约/模块文件、提交标题明确表达新增/发布/部署平台机制，或补入新的官方部署地址时才推送；`fix`、`revert`、`test`、普通 `docs`、`refactor`、依赖更新和仅在旧路径中出现 V2/V3 的提交静默。Pons、Virtuals、Bankr 及任意借用平台显示名称的第三方仓库不会进入 Telegram；Binance 使用独立官方白名单通道。GitHub 未公开代码时无法通过仓库侧发现。

### X / xAI / Grok 官方更新

X、xAI 与 Grok 使用独立的严格官方通道，不会因为名字包含 `X`、`xAI` 或 `Grok` 就放行。首次启用只静默建立基线，之后交叉检查 X API Changelog RSS、xAI Developer Release Notes、xAI News、固定用户 ID 的 `@X`、`@SpaceXAI`、`@grok`、`@API`，以及 `xai-org` / `xdevplatform` 的官方代码仓库。X API Changelog 与 xAI Developer Release Notes 每 10 秒检查，xAI News 每 30 秒；重点官方 X 账号使用 5 秒最短抓取间隔和 1 秒调度器，Jina 降级源最短间隔为 5 分钟；GitHub 核心仓库按 5 秒优先调度，其他固定仓库默认 60 秒。

只推送新的模型、产品功能、API/SDK/端点、插件、算法、重大安全、弃用/移除和定价变化。融资、估值、收购、合作、招聘、会议、营销活动、客户案例、文档错字、测试、依赖与普通维护保持静默。相同功能在官网、X 和 GitHub 重复出现时使用 24 小时语义去重；预览、正式可用、弃用与移除视为不同阶段，可以各提醒一次。所有 Telegram 消息沿用同一中英双语短卡片并保留模型名、API 名、仓库、提交和 URL 等技术标识。

代币安全门不依赖 GMGN。监控器直接从 Robinhood Chain RPC 检查合约字节码、owner、EIP-1967 代理、增发/黑名单/暂停/税费/交易开关入口以及池子的实际流动性。未知数据按风险处理；静态检查通过也不等于已经证明可以卖出。

TG 代币提醒采用平台事件去重：已知 Factory 只有首次出现新的结构模式时推送；普通模式、普通代币和单纯 `gmgn_gap_candidate` 保持静默。未知 Launcher 首发只有同时通过本地安全门、确认真实流动性、具备官网/社交身份，并有高强度平台结构证据时才推送；否则先在后台观察，第二次独立发行确认其可复用后再决定是否播报。

新 Factory 首发结构门要求：入口参数不少于 64 bytes、Launcher 代码不少于 10000 bytes、使用 CREATE2、存在官网/社交证据，并且至少满足“引用 3 项 DEX 基础设施”或“与已知 Factory selector 相似度不低于 75%”之一。安全结论为 block、流动性未确认、测试/单项目启动合约和只有模糊相似度的候选不推送。GitHub 仅推有效模块变更；官网普通文案和 X 上普通代币宣传不推送。

### Flap / Four.meme 平台能力监控

每 5 秒读取 Flap 与 Four.meme 官方开发文档、运行时页面、公告、活动、递归 sitemap、Four.meme `public/config` 和 `@four-meme/four-meme-ai` npm 最新版本，只监控平台级变化，不监控普通代币发行。Four.meme 报价币以官方 API 中 `MEME/BSC/PUBLISH` 条目为准；Flap 看板的 Trending/分页代币卡片不再当成报价币能力；Four.meme 首页的普通代币 `{name,address}` 也不会当成平台合约。Flap/Four.meme 所有通过有效性过滤的平台提醒统一使用红色非静音强提醒，包括新增、参数更新和下线变化。Flap 看板独有的 Vault 分类必须连续成功观测两次才确认，单次出现、消失和重新出现不会反复播报。解析器升级会静默清理旧噪音。

Flap BSC 报价资产另有一条 3 秒最终区块通道，固定校验官方 Portal 的代理代码、实现、版本和事件回执。日志必须由两个不同来源的固定 RPC 对同一区间返回完全一致的结果，任一来源超时、返回空值冲突或链身份不符都会保留游标重试。只有链上前态经两条独立状态源明确为禁用、当前态明确为启用的 `0→1` 变化才称为“新增”；配置刷新和重复启用只写审计。首次启动只建立静默基线，不回放历史资产；网络中断超过实时窗口后，若公共节点已经裁掉前态，系统会降为 T2 报告“恢复后首次确认当前启用”，明确说明 `0→1` 未证、勿追价，而不会伪装成实时上新或卡死游标。

Flap 官方 X 的报价对预告与链上/看板的正式启用分开建模：预告和上线各最多提醒一次。卡片优先展示报价符号、名称、合约地址、阶段和证据；暂时取不到 metadata 时先保留地址并持久重试，解析成功后补全身份。bStock、ETF 或其他 RWA 报价资产允许作为平台能力更新播报，但会明确提示“报价资产不等于股票所有权、仅监控、不自动交易”，且不会触发首币自动激活。

递归 sitemap 的子节点独立容错：一个子 sitemap 失败时保留它上次成功的页面，同时继续处理健康子节点。网页只对解析后的稳定能力做语义指纹，普通构建号、nonce 和文案抖动不会触发能力提醒。

GitHub 会枚举 `flap-sh`、`four-meme-community` 与 `Four-Meme` 账号，当前覆盖 Flap 的 3 个公开仓库（包括 `flap-skills`）及 Four.meme 相关仓库；`SKILL.md`、Solidity、Vault、Factory、部署脚本、ABI、底池配置和新模块优先处理。Four.meme 官方 Agentic 页面直接链接的 `four-meme-community/four-meme-ai` 按已认证源处理；没有官网反向链接的 `Four-Meme/Four-Smart-Contracts` 降为未认证候选，不触发官方级强提醒。配置 Token 时读取完整 GitHub API；未配置 Token 时优先使用公开 Atom 提交流，Atom 出现 HTTP 503 或网络传输失败会在同一轮立即回退官方 commits REST API，并分别保存 Atom/API 的 ETag，避免进入长退避而延迟更新。README、图片和普通维护文件不推送。

链上归因已登记 Flap Robinhood Portal `0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09` 与 VaultPortal `0xe9F7AB7DE8FB8756acbB6a1cd13316a43308197B`。只有这两个发行入口按 Flap 识别；TaxTokenV3 实现、普通转账和股票 Token 增发不会因此增加提醒。

### Morph：Flap 与 Long

Morph 使用独立状态文件 `data/morph-launchpad-state.json` 和持久游标，固定校验主网 `chainId=2818`；WebSocket 用于低延迟唤醒，1 秒 HTTP 定向补扫负责断线恢复，Long/Flap 官方页面每 10 秒检查。错误链、错误 topic、非 canonical 回执、RPC 不完整或安全结论未知时均失败关闭，不推进告警状态。

Flap 只认官方 Morph Portal `0x4267F317adee7C6478a5EE92985c2BD5D855E274` 及其精确 `TokenCreated` 日志，并持续校验 EIP-1967 实现和版本。普通发币静默；仅 Portal 升级、新语义模式的第一枚代币，以及升级后的第一枚代币进入强提醒。卡片提供可复制 Portal/代币地址、Morph Explorer 与官方看板链接，不生成未经验证的 GMGN 路由。

Long 当前官方应用尚未公布可验证的 Morph Factory/Portal。监控先对 `@longdotxyz`、`app.long.xyz` 和官方配置做静默基线；只有稳定观测到 Morph/2818 的明确部署信息，并通过链上字节码复核后才发送部署提醒并登记链上根。不会根据项目名、同名代币、创始人个人仓库或通用 Doppler 仓库猜测 Long 合约。

### BSC 新发射台监控

BSC 使用独立 WebSocket 与状态文件 `data/bsc-launchpad-state.json`，不会被 Robinhood RPC 故障阻塞；WebSocket 负责低延迟唤醒，HTTP 区块头每 1 秒对账，官方配置/API 每 5 秒检查。默认等待 2 个区块确认；实时订阅 ERC-20 首次铸造、PancakeSwap V2/V3/Infinity、Uniswap V2/V3/V4 建池，以及已验证发射台的精确创建/升级事件。OpenFourCore、经典 Four.Meme TokenManager 与 Presale TokenManager 使用各自的精确创建 ABI；购买、进度、税费和普通生命周期日志不参与模式指纹。共享 TokenManager 地址只有在 Four.Meme 官方 Token API 同时证明 `BSC + V3` 时才归属 Four.Meme，SpringBoard V9 保持静默。每个确认区块都会用完整回执对账，因此 WS 断线或日志订阅静默失效不会永久漏报。NFT 铸造、LP Token、已有代币增发、普通建池、单项目部署和同一平台的普通发行均保持静默。

已知基线覆盖 Flap、Four.Meme/OpenFour、GraFun、DxSale、TokenFi、HODL.DANCE、MoonSale、Huks.fun、Agent Launch、Flazepad、KarmaFi、Rugspull、Create Token、POO.MEME、BNBpump、MagicMint、CodelessDev 与 XFOUR 候选；FlyPad 保持“官方文档已确认、Factory 待公开”。辅助 Router、Registry、TokenFabric、报价币、测试网地址、迁移器和 DEX Factory 只用于归因或排除。未知 Controller 必须有 2 枚不同新币、2 笔因果创建交易、2 个独立调用者、同一机制结构和本地安全门，才发送一次“新发射台首次确认”；只有普通代币生成能力、没有池/曲线/迁移等发行机制的工厂保持静默。V4/Infinity Hook 还要求两枚安全新币和两个真实池。

归因会交叉使用官方合约清单/API、官方 GitHub 部署文件、官网/机器可读文档、BNB Chain DappBay、Binance Wallet 生产 token feed、BscScan 精确源码与创建交易、Sourcify 和 DEX Screener。第三方目录或代币资料单独只能成为候选；官方 GitHub/文档中的 Factory/Manager/Portal/Hook 地址必须再与链上因果创建事件和本地安全门吻合，才允许在首枚币强提醒。普通未知来源仍坚持双样本确认。v4→v5 升级只对旧 launcher 的已知 token 交易做静默定向重建，不做 12,000 区块泛回放，也不会重复推送历史模式。

Four.Meme 官方 `public/address`、`token_template/search`、Registry 状态与 Token API 每 5 秒检查；新 TokenManager/OpenFour 根、新发布模板或已发布模板的税费、订阅金额、Vault、曲线等语义机制变化必须连续两次一致后强提醒。新模板或新报价模式确认后会回放激活点附近的精确创建日志，按链上顺序跳过未通过本地权限与交易安全初筛的代币，只为第一枚通过的代币推送一次；普通 V3 发行和重复币保持静默。实时通道会持久保存最近 30 分钟、最多 2,000 条 Four/OpenFour/Presale 精确创建事件，activation 优先从热索引定位首币；热索引缺失时先用 PublicNode 对官方地址与精确 topic 做 2,400 区块定向查询，1.8 秒超时或任何异常都不推进游标并自动退回 10 区块完整回放。Registry 模板要求 `active/createEnabled`，Presale 等不走 Registry 的模板则要求官方 Token API 返回完全相同的 `templateId` 与机制指纹。共享 Manager 的任何匹配还必须由官方 Token API 证明为 `V3+BSC`；官方地址清单新增的 `TokenManagerPresale*` 会自动进入 Presale 精确事件范围。回放以持久游标分段续扫，RPC 暂时缺少归档状态时可用最新状态复核，失败不会错误关闭任务。部署数、点赞数、评论、图片和数组顺序不参与指纹。Rugspull 官方 API 会分页重建 factory→child 图，链上 `RugCreated` 仍是主证据；waifu.fun 只有新机制指纹首次出现且 `createTxHash` 回执确属 Flap 创建事件时才推送，同模式普通代币不再重复。

FlyPad 使用 `llms.txt` 与 Markdown 页面监控文档目录、AI/匿名发行、Squads、空投、Tokenomics、预售、锁仓等机制语义；新增页面或机制才提醒，普通措辞变化只更新后台基线。

```env
BSC_MONITOR_ENABLED=true
BSC_RPC_URLS=https://bsc-rpc.publicnode.com,https://bsc-dataseed.nariox.org,https://bsc-dataseed.defibit.io,https://bsc-dataseed.ninicoin.io,https://bsc.nodereal.io,https://bsc-dataseed-public.bnbchain.org,https://bsc-dataseed.bnbchain.org,https://bsc.rpc.blxrbdn.com
BSC_ARCHIVE_RPC_URLS=https://bsc.rpc.blxrbdn.com,https://rpc.48.club,https://bsc-mainnet.public.blastapi.io,https://bsc.blockrazor.xyz
BSC_REALTIME_RPC_URLS=https://rpc.48.club,https://bsc.blockrazor.xyz,https://bsc-rpc.publicnode.com,https://bsc-mainnet.public.blastapi.io,https://bsc.rpc.blxrbdn.com
BSC_REALTIME_RPC_CONCURRENCY=4
BSC_REALTIME_RPC_REQUEST_TIMEOUT_MS=4000
BSC_WS_URL=wss://bsc-rpc.publicnode.com
BSC_CONFIRMATIONS=2
BSC_MAX_CATCHUP_BLOCKS=240
BSC_NEAR_HEAD_RECOVERY_BATCH_SIZE=20
BSC_NEAR_HEAD_RECOVERY_SEGMENT_SIZE=2000
BSC_HTTP_HEAD_POLL_INTERVAL_MS=1000
BSC_OFFICIAL_POLL_INTERVAL_MS=5000
```

### Fomo 平台喊单（Trade Thesis）

Fomo 的钱包买入推断链路已经弃用并默认关闭；系统不会再把 KOL 买币、转账或钱包首仓当作“喊单”。只有 fomo.family 平台实际发布的 Trade Thesis（官方 Feed 的 `thesis_created` / `thesis`）才会进入喊单候选。

数据源优先使用 FomoScan Partner Thesis Feed，并配置人工发放的 `FOMOSCAN_THESIS_TOKEN`；正式 API 地址为 `https://api.fomoscan.sh`。`FOMO_OFFICIAL_BEARER_TOKEN` 只允许用于已取得 FOMO Labs 明确书面授权的开发者接入，普通用户登录会话不得用于自动监控。两者都没有有效凭证时监控会 fail-closed，健康状态明确标记凭证缺失，不发送告警，也绝不回退到钱包买入推断。凭证请只写入本机 `.env`，不要提交到仓库。

当前只接收 BSC Thesis，每 5 秒轮询一次，只处理发布后 2 分钟内的新信号。首次启动会静默建立基线，不回放历史喊单；后续以平台的 `thesisExternalId` 作为稳定去重键，同一 Thesis 只播报一次。Telegram 卡片保留 KOL、原始 Thesis、代币与安全结论，并附 Fomo、X、GMGN 和合约快捷入口。

### 大V本人发币声明（监控默认关闭）

`KOL_LAUNCH_MONITOR_ENABLED=false` 是默认值。大V本人发币声明与普通喊单分开建模：即使帖子包含明确的第一人称发行语义和唯一 BSC CA，社交声明也只证明“该账号这样说过”，不能证明链上 `creator` 属于该账号。未取得精确创建日志和 creator 钱包匹配时，结果固定为 `watch-only`，粉丝数仅展示且不参与交易评分。

启用该 lane 时，`KOL_CAPITAL_ROSTER_ENABLED=true` 会接入版本化人工复核名录，覆盖加密协议创始人、交易所高管、加密 VC/基金合伙人，以及 Web2 科技、AI 和金融资本负责人。名录人物不需要钱包绑定或“本人钱包有 BSC 活动”，也不受粉丝阈值限制；但运行时必须同时匹配精确 X handle、名录固定 numeric X ID、numeric-ID timeline 和官方 X oEmbed 原帖。只有本人近期明确声明在 BSC/BNB Smart Chain 发币且正文仅含一个显式标注的 CA 才会播报；普通买入/看多文案会被忽略。背景取自名录中一手机构来源的中英双语证据，未知人物、ID 变化、名录篡改或名录过期全部隔离并 fail-closed。`KOL_CAPITAL_CATEGORIES` 可按类别精确过滤，留空表示全部人工复核类别。

人物发现现分为两层：`capital-kol-screening-universe` 固定保存 500 个待筛选账号，但它本身没有告警、台账或交易权限；`capital-kol-catalog` 只保存已经完成人工一手来源审核的人物，当前首批为 30 人。候选必须依次通过官方角色、官方账号关联、numeric X ID 旁证和人工复核后才能晋级。粉丝数只用于卡片展示和人工复核队列排序，不能改变身份、告警准入或交易评分。社区名单、媒体榜单和历史投资人目录只用于发现，不能作为“大V身份已核验”的证据。

查看 500 人筛选概况（完全离线、不会发消息）：

```bash
npm run kol:screen -- --limit=25
```

如需抓取公开 X 镜像资料做第一阶段身份旁证，必须显式加 `--live`；单次最多 50 人、并发最多 2、失败不重试，结果仍然只会进入“待官方角色人工复核”，不会自动晋级：

```bash
npm run kol:screen -- --live --offset=0 --limit=25
```

先用内置虚构 fixture 查看中英双语模板：

```bash
npm run demo:kol-launch
npm run --silent demo:kol-launch -- --json
```

演示中的人物、numeric X ID、粉丝数、X 简介自述、帖子和 BSC CA 全部是确定性的虚构数据。脚本只构造事件并调用现有告警 renderer；它不读取实时 X、GMGN、Fomo、RPC 或 Telegram，不加载私钥，不启动生产监控，不发送消息，不签名，也不广播交易。`--json` 输出同一个 fixture 事件、持久化格式的双语 render bundle 与最终模板，便于验收和后续回归测试。

如以后显式打开 `KOL_LAUNCH_MONITOR_ENABLED=true`，当前阶段仍只允许生成观察证据；`creator 未链上核验`、安全/流动性/可卖性证据不完整或来源过期时必须失败关闭，不能升级为模拟买入，更不能触发真实交易。

### Binance / Binance Wallet 平台能力监控

Binance、Binance Wallet 与 Binance Futures 在 `focus3` 外使用严格官方白名单通道；名称相似的第三方账号、域名和仓库不会放行。公告 CMS、Square、开发者文档、Meme Rush、Launchpool、GitHub 与官方 X 独立交叉验证并共享语义去重：

- Binance 官方公告 CMS 每 10 秒一次拉取 7 个官方目录，并提取正文中最多 3 条具体变化。交易所侧播报现货首次上币/整币下架、API、核心交易规则、新产品、充提与网络维护；普通永续合约、普通交易对/机器人、活动奖励、法币/空投和股票/bStocks 不推送。首次上币、整币下架和安全紧急事件使用强提醒，计划维护、Tick Size、保证金与普通 API 更新使用静音提醒。
- Binance Wallet 没有独立公告目录，因此新文章会立即读取官方详情的标题、SEO 摘要和正文，已见文章的详情每 10 秒复核，识别 Wallet、Meme Rush、Alpha、DEX、API/SDK、新链/协议和安全架构。新发射模式、API、新链与安全变化强提醒；普通 UI 更新静音；单币推荐、Alpha 加币、空投、APR、比赛和营销活动过滤。详情限流按文章隔离，不会阻断同批后续公告；官方摘要的实质修订最多形成一个独立修订事件，正文排版变化只更新状态不重复推送。
- Binance Square 官方主页每 5 秒读取一次，按 post ID、发布时间、编辑次数和正文指纹识别新发与实质修订；KOL 买入分享、跟单、交易信号和其他社交交易能力属于强提醒，访谈与普通内容静默。
- Binance Developer 的机器可读目录及 Wallet、Alpha、Copy Trading、Prediction、Spot、Announcements 变更页使用 ETag/Last-Modified 检查；只有新增产品/API/端点/能力进入提醒。
- Binance 官方 Web3 Developer 页面独立以不低于 60 秒的周期检查，覆盖 Web3 DApp 接入与上架、Web3 Connect/provider、Task Verification、Open Platform、Agentic Wallet 和 Wallet Skills。首次接入或旧快照升级只建立静默基线；之后仅播报结构化能力、接口、provider 与流程变化，普通文案调整和营销活动静默。
- Binance Wallet Meme Rush 官方接口每 5 秒并发轮询 3 个“链 × 生命周期”目标并读取前 200 条；BSC、Solana、Base 的新创建榜每 15 秒内检查一次，9 个目标约 15 秒完整覆盖一轮。普通代币不推送，只有新协议、新 `tokenVersion`、迁移/曲线/税费/防狙击等平台字段变化才提醒；新版本必须至少由 2 个不同合约确认。
- 首次启动默认只建立静默基线。唯一例外是官方生产接口中最近 24 小时仍在活动、尚未进入官方 Skills 文档且能由模式命名确认的新协议，此类实时文档缺口只补发一次强提醒。
- Launchpool 官方接口每 10 秒检查质押资产、生命周期状态、数据分组和字段能力，只播报结构变化，不播报普通新项目。
- 官方 `binance` GitHub 组织会发现新仓库；Skills Hub、Web3 connectors、CLI、Spot API docs、Swagger 与连接器提交按优先级检查，关键仓库还监控 PR。只有 Wallet、发射、KOL/交易信号、Copy Trading、新 API/端点和安全结构变化提醒；修复、测试、排版与普通依赖升级静默。
- `@binance`、`@BinanceWallet`、`@BinanceFutures` 都是优先官方 X 源；公告 CMS、Square、Meme Rush、Launchpool、开发者文档与 GitHub 可在 X 免费源限流时继续独立工作。
- 官方 Announcement WebSocket 通道已实现；配置专用的 `BINANCE_API_KEY` 与 `BINANCE_API_SECRET` 后使用 `com_announcement_en` 实时流。没有凭证时自动由 10 秒 CMS 通道覆盖，不会尝试伪造或借用交易凭证。

首次部署和旧状态升级都只继承静默基线，不回放历史公告。推送使用同一条中英双语精简卡片并附“查看官方公告”；Flap/Four.meme 仍保持最高优先级。

启动时会从 Robinhood 官方 RHJ 资产接口同步全部股票/ETF Token 地址，并把 Robinhood L2 协议合约以及 Pons、LaunchHood、LootPad 官方文档确认的 Factory、Locker、Router、Hook 等写入 `data/official-addresses.json`。股票 Token 增发不播报；普通 ERC-20 转账永不播报。发射台 owner/treasury 等运营地址只有在该地址本身提交交易、交易内存在 Swap、且收付方向能证明真实买卖时才提醒；手续费、分红和奖励的被动转入不再误标为“官方买入”。同一“官方地址 + Token”六小时最多提醒一次。

在 `data/blocked-contracts.json` 的 `addresses` 数组中加入 Token、Factory、Launcher 或 Pool 地址即可屏蔽提醒，最多 5 秒热更新，无需重启。屏蔽只影响 TG/Webhook 推送，原始链上事件仍保留在 `events.jsonl`。

每个新 Factory 的首枚代币会进入 `data/early-watchlist.json`，持续快速观察 24 小时。每 15 秒检查新 Swap，按 1 分钟成交笔数和 WETH/USDG 报价成交量分三级记录；L1 和资料补全只写后台，只有本地安全门通过且达到 L2/L3 才进入 Telegram。阶段号写入去重键，因此 L1 后首次升级 L2 不会再被错误去重吞掉。

Launcher 代码归因会区分公开发射台与单项目启动合约：已知 Factory 精确匹配；重复发行证明可复用；首次调用若入口无参数则标记为 `single_project_launcher`，不再称为新发射台。提醒中展示入口 selector、参数长度、最接近的已知 Factory 及选择器相似度。

- Active: `0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB`
- Legacy: `0x0c37a24F5D23A486FA692d1500881d698B1F77a4`

每个新部署合约都会提取函数 selector 集合、CREATE2 使用情况，以及 WETH、Uniswap V3 Factory、Position Manager、Router 等基础设施常量。与 pons/其他已知 Factory 的 selector Jaccard 相似度达到阈值，或同时引用多项 DEX 基础设施时，会在尚未发射首币前标记为 `earlyLaunchpad.candidate`。

## 告警

Telegram:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
TELEGRAM_STRONG_ALERTS=true
ALERT_BILINGUAL_ENABLED=true
ALERT_TRANSLATION_URL=https://translate.googleapis.com/translate_a/single
ALERT_TRANSLATION_FALLBACK_URL=https://api.mymemory.translated.net/get
ALERT_TRANSLATION_TIMEOUT_MS=3000
```

填写后发送测试消息：

```bash
npm run test:telegram
```

Telegram 当前推送 Flap/Four.meme 平台结构变化、Uniswap/Pools.trade 的发射/策略/底池/Hook/部署/Release/限定 GitHub、Morph 上经官方证实的 Flap/Long 结构变化，以及独立验证的 pon.fun Factory/API/X 更新。Robinhood 链上的通用发现仍只允许 3 个核心平台已知入口首次出现不同结构模式的证据通过；pon.fun 只能走其固定 Factory 和官方身份门，普通 PON 同名代币、普通股票/RWA、合约部署、普通发币/底池、量能、官方地址行为和被动转账不会借此进入队列，但历史数据仍保留在 `data/`。

所有进入 Telegram 的事件在最终发送层统一排成一条双语差异卡片：先显示 `🇨🇳 中文`，再显示 `🇬🇧 English`，每块固定按“变化类型 → 原有 → 更新后 → 对比依据”展示，随后最多保留状态/风险和时间。旧状态严格区分“已知旧值”“此前监控基线未记录”和“旧值暂不可得”，不会把取不到旧值伪装成此前不存在；新增、修改、移除、发布、升级和状态变化使用不同颜色标记。合约、钱包、交易哈希、Git SHA、仓库、函数名、版本、URL 和 X 账号不会被翻译或截断。Google GTX 与 [MyMemory 官方免费 REST API](https://mymemory.translated.net/doc/spec.php) 在同一个 3 秒总预算内竞争，先通过语言和技术标识校验的结果生效；MyMemory 匿名额度以其[官方使用限制](https://mymemory.translated.net/doc/usagelimits.php)为准。差异模型和双语结果先持久化到 outbox，发送失败重试时直接复用，不会重复调用翻译服务，也不会改变原始事件、去重键、安全门、强提醒级别或按钮。两个接口都不可用时仍会按固定双语结构发送，中文区明确标记保留的英文原文，英文区改用可验证的结构化事实兜底；单条消息最多 18 行，避免 Telegram 卡片过长。

X/Twitter 使用公开时间线接口，无需 API Key 或登录。focus3 轮询 Flap `@flapdotsh`、Four.Meme `@fourdotmemezh`、Uniswap `@Uniswap`、Pools.trade `@TradePools`，Morph 窄通道另固定轮询 Long `@longdotxyz`；启用 pon.fun 时还会独立轮询 `@pondotfun`。重点账号必须同时通过固定 numeric user ID、精确状态页作者和 X 官方 oEmbed 验证，官网临时出现的其他账号不会被动态加入。只推送有效时间窗内、明确包含平台新模式、Factory/合约部署、新底池/Hook、报价机制、新功能、Morph 上线或 pon.fun 结构变化的推文；普通代币宣传和过期补抓不会进入 Telegram。

带合约地址的 TG 提醒底部包含 Telegram 原生“📋 一键复制合约”按钮；代币提醒同时提供无返佣的“📈 一键打开 GMGN”Robinhood Token 深链和 Blockscout 交易按钮。平台能力或官网一次发现多个新合约时，会分别提供最多 3 个复制按钮。

### 合约安全门

非 pons 代币在机会提醒前通过本地 Robinhood 链上安全门，不依赖 GMGN 的安全标签。检查项包括实际字节码、owner、EIP-1967 代理、可增发/黑名单/暂停/动态税费/交易开关入口和池子实际流动性；任一高风险能力或流动性未确认都会拦截。静态检查通过仍不等于已证明可以卖出，不构成买入建议。

推送会附带发射台名称、官网、X/Twitter、文档、机制说明和匹配方式。未知候选不会猜测社交账号，而是明确显示“待发现/待确认”。已录入档案目前包括 pons、LaunchHood、LootPad、Noxa、Bankr 和 Virtuals。

pons 普通代币发射一律不推送；v2 新 Factory、发行配置、迁移模式以及经官方反向认证的新模块才会强提醒。

Pons 不使用 `ponsdotdev/ponsfamily` 或 `ponsdotfamily/ponsdotfamily` 作为官方发布依据：Pons 官网和文档没有反向认证这些仓库，其中的 v2 内容属于参考实现。两个仓库降为普通 60 秒的未认证情报源，变化只在后台记录，不进入 Telegram；Pons 官方文档或 `@ponsdotfamily` 若直接发布 GitHub 仓库链接，系统才会自动升级为 15 秒官方源并播报。

Pons v2 的确认以官方文档、官方部署者、官方 V2 Hook 的链上 `factory()` 指针和链上核心事件为准。V2 Hook 每 5 秒读取一次；Factory 指针首次出现或变更后会验证 Hook/Factory 双向 getter、实际字节码与 V2 接口，不依赖 GitHub 是否公开。`TokenLaunched` 只用于静默维护生命周期；`launchEnabled()`、`launchConfigCount()`、新 Factory 和首个 `TokenMigrated` 才进入强提醒。

为避免高频普通发行拖慢首报，已知发射台先走轻量模式指纹检测：普通已知模式不读取代币扩展资料、不执行安全扫描；只有首次新模式或新发射台候选才补全资料并进入本地安全门。Pons 普通发行也不写入事件日志。

Flap 与 Four.meme 官网运行时能力、公告和官方合约配置每 5 秒检查一次；官方 GitHub 合约、部署、ABI、SDK、Skill 和模块文件走 5 秒核心优先通道，其他固定仓库默认每 1 分钟检查。系统还每 10 分钟枚举 `flap-sh`、`Four-Meme` 与 `four-meme-community` 组织的新公开仓库。新接入仓库追补最近 7 天、最多 8 条相关提交；若历史 SHA 已离开可读取窗口，会发送覆盖缺口提醒并在状态中持久记录，不会静默推进。

Flap `@flapdotsh` 与 Four.Meme `@fourdotmemezh` 使用 5 秒最短抓取间隔、1 秒调度器、独立优先轮询和账号级退避，一个账号 429 不再暂停另一个重点账号。Jina 只作为限流时的降级源，最短间隔保持 5 分钟；Pons 与其他账号改走普通轮转。新接入账号仍做有界扫描，但 Telegram 只接受 6 小时内的平台级有效推文；追补截断和数据源故障写入 `twitter-state.json` 健康/覆盖信息。官网、公告、配置和 pons v2 文档作为独立官方备用来源。

所有需要推送的事件先原子写入 `data/alert-outbox.json`，再提交 GitHub/X/平台/链上游标。Telegram 或 Webhook 临时失败时后台按退避重放；队列优先处理 Flap/Four.meme，再处理重要链上事件。超过 6 小时的 X 积压会标记为 suppressed，不在恢复后补发旧闻。多渠道部分成功只重试失败渠道；Telegram 只有返回 JSON `ok=true` 且带 `message_id` 才算送达。

强提醒默认开启。Flap/Four.meme 的所有有效提醒，以及满足严格证据门的链上重要事件，会发送带红色标记的非静音 Telegram 消息；普通代币发行仍被过滤。设置 `TELEGRAM_STRONG_ALERTS=false` 会把所有消息改为静默。

通用 webhook 会收到完整事件 JSON：

```env
WEBHOOK_URL=https://example.com/robinhood-alert
```

## 已录入工厂

- LaunchHood: `0x62B33A039D289CBDa50EbeB72Fe4261449E61Bcf`
- LootPad V3: `0x280996bdDCd10A6eEc637Bfb55bD60131f31aa59`

可通过 `KNOWN_FACTORIES` 追加，使用逗号分隔。
