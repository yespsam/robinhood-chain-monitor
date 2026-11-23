# OpenFour 创建能力分支与 Four.Meme 来源恢复：增量复核

- 检查完成：2026-11-16 16:44:33 UTC；上次完成：12:47:28 UTC；间隔 3 小时 57 分 05 秒，距四小时目标早 2 分 55 秒。低频抽样，不是连续监控。
- 结论：受跟踪仓库 main/tag 无变化。现在对已观察到的 `four-meme-ai` 非 main 分支 `codex/openfour-create` 做了内容核查：分支新增的是 BSC OpenFour token 创建 CLI 候选，不是已合并的 main 更新、官方公告或已核实的生产发布。此候选不是新的链，也不含 OpenFour 买卖执行路径。当前本地工作树已有 OpenFour Registry/Core 创建事件观察器，但没有找到该创建 CLI 或 OpenFour 买卖执行适配器。Four.Meme public-config 端点在上轮 403 后已于本轮成功读取；期间 16:00Z 还记录过一次错误事件（错误码未保留），因此属于曾间歇失败、当前恢复，不能据此宣称稳定无故障。

## refs 与候选分支

本轮 `git ls-remote --heads --tags` 约 16:40Z：五个平台仓库及项目远端 `main` SHA 与上一轮相同，无 tag。main SHA 分别为：

- `binance/binance-skills-hub`: `7d1b1f78d525f9e653b96819f91a549302fda1da`
- `four-meme-community/four-meme-ai`: `3918818c064878f577159c0a144323d38c55612b`
- `four-meme-community/fourmeme-docs`: `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`
- `four-meme-community/openfour-docs`: `8ca5554df22ad511126d8547c212fa161ecf19ee`
- `flap-sh/flap-skills`: `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`
- 项目远端 `main`: `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`

[`four-meme-ai` 的非 main 分支提交 `028b49cda4f9fc38c38aa17d268e59b204e3f344`](https://github.com/four-meme-community/four-meme-ai/commit/028b49cda4f9fc38c38aa17d268e59b204e3f344)（作者日期 2026-11-16 10:18 +0800）主题为 `feat: add BSC OpenFour token creation flow`。ref 已在前次 12:43Z ls-remote 中出现；本轮是首次阅读其具体 diff，故不是本轮新推送。官方 [Four.Meme Agentic 页](https://four.meme/en/agentic) 曾交叉链接该集成仓库，但这不能把任意非 main 分支当成官方产品规则或已发布功能。

该分支差异新增 `openfour-create.md`、`openfour-abi.ts`、`openfour-cli.ts`、`openfour.ts` 和测试等 11 个文件/改动，约 1,517 行。分支文档称其为 BSC mainnet 独立创建流程；代码固定检查 chain ID 56、从 Registry `0x912cef0c3ae9ab6eb3ec87cab69371cfb317ab94` 读取 Core/Tools、按 template schema 与 quote 配置组装参数。API 返回签名的 `createArg`；单独链上步骤会调用 `OpenFourCore.createToken`，若 presale quote 是 ERC-20 可能先批准。quote asset 是模板配置选择项，分支未规定单一报价币。CLI 命令是 template/schema/preview/quote/create-api/create-chain/create-instant；没有 OpenFour buy/sell 命令。

来源边界：此为 first-party-linked 集成仓库中的候选实现，不是 main、release/tag 或官方公告。其 ABI 注释指向 `four-meme-community/openfour-docs`；该 docs 仓库的官方归属尚未通过本轮官方站点交叉确认，仍标作 community/reference。Registry/Core 地址及 ABI 本轮没有通过链上 RPC 或可验证的官方部署目录核验，不将分支文本当作链上事实。

## 本地兼容性对照

- 当前本地工作树的 [src/four-registry-monitor.js](/Users/qohfq/Documents/Playground/robinhood-chain-monitor/src/four-registry-monitor.js:7) 跟踪 BSC chain ID 56 与同一 Registry 地址，读取 `openFourCore()`；[src/bsc-launchpad-monitor.js](/Users/qohfq/Documents/Playground/robinhood-chain-monitor/src/bsc-launchpad-monitor.js:977) 含 OpenFour Registry/Core 地址和 `TokenCreated` 解析，现有 fixture/test 覆盖该创建事件的观察/解析。此为本地 checkout 中的代码证据，不证明服务正在运行该 revision。
- 对指定的本地交易入口文件做只读搜索，未发现 OpenFour 创建 CLI、签名/广播适配或 OpenFour 买卖执行接口。现有对应功能是创建事件/Registry 能力监视，不等同于发币交易支持。
- 因分支非 main，且它描述的 create flow 会签名、可能授权并提交链上交易，本轮没有运行或模拟该 CLI、没有调用 RPC，也没有运行本地交易测试。未证实本地交易路径受到影响；若要移植，须先核验官方 contract/ABI、quote/fee/expiry、allowance/gas、交易状态和失败映射，再做隔离模拟测试并人工审查。

## 其他官方来源状态

- Four.Meme public-config：本地结构化快照 `data/platform-capability-state.json` 记录上轮 12:40Z HTTP 403；本轮于 `2026-11-16T16:42:13Z` 成功，source health 为 healthy、连续失败归零；最新快照显示 129 个 quote token/config 项。期间 `16:00:01Z` 有历史错误时间戳，但成功后错误码已清空，无法确认该次错误类型。因前后配置内容指纹未在本次采样保存为比较对，不能声称配置内容未变。
- Four.Meme `/en/agentic` 与 `/en/announcement` 的直接请求均为 HTTP 200；公告返回的是 HTML 页面，未独立解析列表/最新条目，因此公告内容仍有核验缺口。Web 阅读器上轮对公告返回 403。
- Flap Agent Skills、Apps、FSI 页面直连为 HTTP 200；本地 aggregate 仍 partial，既知 sitemap HTTP 404。HyperEVM overview/JSON-RPC 页面直连 HTTP 200，collector aggregate healthy，正文变化数为 0；此前 JSON-RPC 单页 watcher 状态与直接 HTTP 200 有过不一致，继续观察。
- Binance 文档直连本轮返回 HTTP 202，未取得可比对正文；Skills Hub main SHA 未变。OpenFour 继续按 community/reference。没有确认任何新链或正式上线的新 launchpad。

## 状态与覆盖边界

- 未连接钱包、未读取秘密或 `.env`、未签名/广播/下单、未改代码/配置/策略、未部署/重启、未 push/merge。
- 本地工作树已有大量 staged/unstaged 改动；运行中服务 revision 未验证。本轮证据只描述当前 checkout 代码与远端 main/ref，不推断生产状态。
- 下一轮关注 OpenFour 创建分支是否合并/发布、Four.Meme public-config 是否继续稳定，以及 HyperEVM watcher 单页状态是否恢复一致。该分支内容不是安全性或可交易性背书，也不保证任何 token 可买卖。
