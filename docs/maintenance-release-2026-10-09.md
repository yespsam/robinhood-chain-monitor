# 2026-10-09 维护发布说明

本次发布整理代码仓库、验证入口与部署说明，保留现有监控和模拟盘的安全边界。上传私有 GitHub 仓库只发布代码，不等于重启服务、启用新数据源、恢复历史积压或执行交易。生产部署须另行完成单活和状态保全验收。

## 本轮仓库维护

- 汇总此前未提交的扫描、付费 RPC 接线、Four/Flap 机制代次、模拟盘、GMGN/X、地址研究和看板改动；不复制现机运行状态。
- 配置模板默认关闭 `FOMO_PUBLISHED_CALL_ENABLED`，保留共用 worker；实际节点配置未改动。
- 两个本地维护脚本改用自身文件位置解析项目/相邻项目路径，移除写死的个人目录；历史报告中的备份位置改为相对路径，证据与本地备份不删除。
- 完整回归发现并修复普通 Binance 公告误入“重要官方新闻”例外通道：保留 `strong` 官方 T2 新闻通知，普通 T2/T3 继续静默；来源、新鲜度和不执行交易的限制不变。原“四条送达”断言保留，补充重要性、伪造来源和时效回归。
- 新增 `.github/workflows/verify.yml`：Node.js 24、锁定依赖、提交空白检查、完整测试和公开资产构建。CI 只读仓库、不使用生产密钥，也不运行监控、发送消息或自动部署。
- 完成依赖审计（`npm audit --omit=dev`：0 项已知漏洞）、公开看板临时目录构建（12 个白名单资产）、62 份 JSON 解析和暂存范围检查；完整业务回归以最终验收记录为准。

## 最终本地验收（北京时间 2026-10-10）

- 完整隔离回归：**3919 / 3919 通过，0 失败、0 跳过、0 取消**，退出码 0，耗时约 323.8 秒。单并发执行，禁止外网、真实 `.env`/秘密/运行数据内容读取和仓库写入；只允许测试所需的路径元数据与本机回环服务。
- 告警优先级、去重及来源取消定向回归：135 项通过；原普通公告“四条送达”断言没有放宽。
- 253 个源码、工具及看板 JavaScript 文件语法检查通过；JSON、工作流 YAML、公开资产构建和暂存空白检查通过。
- 上传内容为 400 个代码、测试、模板及脱敏文档文件；忽略的运行数据、完整凭证和本机备份没有加入 Git 索引。未删除生产数据或修改账本，也未重启监控。
- 只读抽查时 main、BSC、GMGN/X 共用进程均存活且心跳近期更新；这不代表全天在线、队列无拥塞或已完成生产端到端性能验收。GitHub Actions 结果应另行查看对应提交运行记录。

## 发布时必须保留的行为

| 范围 | 行为与限制 |
| --- | --- |
| BSC RPC | 已审核消费者按需加载本地付费配置并优先选用；固定双源证明读取保留独立来源。共享协调器按物理主机跨进程门控，最多两个物理请求、其中后台最多一个，不因付费优先而增加限额。 |
| Four / Flap 首三 CA | 每次已核实的新模板或新底池机制代次，按区块、交易序号、日志序号取最早三个不同 CA。不按榜单名次取样，不以第四名替补，不因重复配置、重启或补款重开名额。 |
| 模拟准入 | 首三候选可进入现有 focused 补证/报价队列，不必等待 K 线或额外推文；但必须满足 canonical 归属、事件时效、独立安全与可卖性、税率、有效深度、费用、报价、现金和仓位检查。仅模拟，不签名、不广播。 |
| FOMO 与共享 worker | FOMO 平台来源保持关闭；GMGN、公开 X 与已有退出优先级维持原设置。`fomo-worker` 名称不等于平台开启，不能用关闭共享 worker 代替来源控制。 |
| BSC 扫描 | 正常扫链与旧积压暂停边界隔离。旧 pending/deferred、缺口、canonical 证据、快照/WAL 和去重信息保留，不用清空队列或推进历史游标伪造覆盖。 |

实现依据：[`bsc-private-rpc.js`](../src/bsc-private-rpc.js)、[`rpc-host-coordinator.js`](../src/rpc-host-coordinator.js)、[`paper-pool-signal.js`](../src/paper-pool-signal.js)、[`paper-launch-policy.js`](../src/paper-launch-policy.js)、[`monitor-source-policy.js`](../src/monitor-source-policy.js) 和 [`bsc-live-scan-policy.js`](../src/bsc-live-scan-policy.js)。

## 配置与数据保全

`.env.example` 是可提交的模板，不是生产配置快照。`FOMO_CALL_ENABLED=true` 和 `FOMO_CALL_STANDALONE=true` 保留共用 worker；模板中 `FOMO_PUBLISHED_CALL_ENABLED=false`、`FOMO_BUY_MONITOR_ENABLED=false` 不开启平台喊单/买入来源，`GMGN_FLOW_MONITOR_ENABLED=false` 也不会自动启用外部 CLI。实际运行范围还受下列本机文件控制：

- `DATA_DIR/monitor-source-policy.json`：来源取消策略。已有节点的 `fomoPlatformSourcesEnabled: false` 必须保留。文件缺失时源码默认平台策略为开启，不能把丢失策略文件当作关闭；损坏文件则失败关闭。
- `DATA_DIR/bsc-scan-policy.json`：`live_only` 历史暂停边界。缺少控制文件时可从已有持久策略恢复；无已有策略的新节点默认 `all`。已有节点不可通过删文件、清空状态或重建游标恢复旧积压。
- `DATA_DIR/trading-scan-scope.json`：模拟盘新机会扫描范围；不以旧账本的链字段推断当前范围。既有仓位管理与新仓扫描不是同一件事，详见 [BSC 单链交易扫描](bsc-only-trading-scan-2026-10-04.md)。
- `private-bsc-rpc.json`：本地付费 HTTP/WSS 配置。扫描器在其运行目录读取，当前 dashboard 接线读取项目 `data/`。加载器要求当前用户所有、仅所有者可访问的普通文件，并校验 HTTPS/WSS 的主机与路径一致；保存 API 使用 `0600` 且不覆盖已有文件。迁移要核对各消费者使用的目录，不能仅修改一份环境变量就假定全部生效。

Git 发布不携带这些文件。`.gitignore` 排除 `.env`、其他 `.env.*`（仅放行 `.env.example`）、`data/`、日志、密钥容器和本地发布产物。忽略规则不会移除已经被跟踪的文件；发布审核仍须核对实际暂存文件，禁止强制加入运行数据、模拟账本、队列、状态备份、完整私有 RPC URL、Bot Token、API 凭证、Cookie、会话或私钥。私有仓库不是凭证存储。

## 验证入口

源码使用 `node:sqlite`，建议使用 Node.js 24。依赖安装 `npm ci` 会访问包仓库但不会启动监控；应按锁文件安装，不把维护检查顺便升级为依赖大版本更新。

离线回归应在不含 `.env` 和 `data/` 的独立代码副本或 CI 中执行，只使用测试夹具与注入 transport。不要在生产工作目录直接启动业务入口来证明代码可用。核心回归入口包括：

```sh
node --test test/bsc-private-rpc.test.js test/bsc-paid-rpc-wiring.test.js test/rpc-host-coordinator.test.js
node --test test/bsc-live-scan-policy.test.js test/bsc-queue-pressure.test.js test/bsc-proof-throughput.test.js
node --test test/four-registry-generations.test.js test/four-registry-pipeline.test.js test/flap-canonical-projection.test.js test/paper-launch-generation.test.js
```

完整回归入口为 `npm test`。`npm run build:public` 只用于在隔离输出目录核验公开静态产物，不等于部署；`publish:public` 是外部写入动作，不能作为普通构建验证。测试数和结果应以本次运行的日志为准，不沿用旧维护报告中的通过数量。

维护检查不自动运行 `npm start`、`npm run once`、`npm run dashboard`、`sync:gmgn`、`test:telegram`、付费 RPC 探针、模型研究或在线行情请求。其中 `once` 仍是一次真实监控周期，不是离线测试；启动 dashboard 也可能启动模拟盘后台研究，不能只按“打开网页”理解。

## 部署与回滚验收

1. 先核对发布内容只含代码、测试、模板和脱敏文档，保存已审阅的版本标识。代码发布不覆盖现机 `.env`、状态文件或账本。
2. 已有生产节点按 [Ubuntu 单活部署](../deploy/README.md) 或 [macOS 守护说明](../deploy/macos/README.md)选择相应流程。跨节点切换须先停旧节点、验证进程退出、最终同步状态，再激活新节点；`ACTIVE` 只是本机流程锁，不是跨机器租约。
3. 在获准的部署窗口内使用现有服务监督器平滑重载；不能启动第二个扫描器、强杀进程或手删锁来绕过退出流程。保留可回退的代码版本及受保护的状态备份，不把备份上传 Git。
4. 部署后由有权限的运维执行 `npm run health -- --no-write --json` 读取本地状态。该命令不启动服务、不发送 Telegram 或外部心跳，但会加载本机 `.env` 并读取运行数据，不属于纯源码离线检查；禁止读取秘密配置的审查流程不要运行此命令。
5. 分别验收进程/调度 `operationalHealthy`、数据覆盖 `coverageComplete`、投递 `deliveryComplete`；确认付费读取实际消费者、Four/Flap producer 与 canonical 投影、新鲜度、实时队列占用、历史暂停边界和原账本不变。需要读取状态时采用快照与 WAL 的权威合并视图，不能仅用可能滞后的原 JSON 判断当前进度。
6. 回滚先确认旧代码兼容当前状态格式；不以恢复旧账本、清空队列或回退成交历史代替代码回滚。迁移过的 producer 状态须按该版本的迁移边界复核。

## 已知限制与验收标准

[2026-10-09 首三 CA 记录](four-flap-launch-generation-2026-10-09.md)最后一次验收仍显示实时保留队列接近容量上限、尾扫落后以及付费主机 `shared RPC coordinator: capacity wait deadline`。该错误表示本地共享请求槽位排队超时，不能据此认定付费节点未接入，也不能直接当作上游 429。已有修复解除部分可证明的错误依赖和阻塞，不代表持续实时覆盖已经恢复。

首三机制仍受 120 秒事件时效、链上证明完整度、价格与深度适配范围约束。仅网站/Board 模板消息、无法精确归属预设的独立 Hook，以及尚未覆盖的任意 V4/自定义 ABI 不能直接进入模拟。迟到补扫不追买；明确终态的通知抑制保留原序号，不伪造发送成功，也不补第四个 CA。

验收必须区分：发现平台更新、核实创建顺序、证据送入模拟盘、获得新鲜报价、通过安全/费用门、模拟成交和实际盈利。前一步成功不保证后一步成功，离线测试也不能证明全天在线、没有漏扫或未来盈利。当前未达到“持续捕获每次新模板/新池首三 CA”的端到端保证，不通过提高限额、清空证据或无条件补单掩盖缺口。
