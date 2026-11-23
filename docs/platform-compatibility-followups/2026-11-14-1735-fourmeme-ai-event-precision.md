# Four.Meme 官方集成仓库增量：事件读取与精度

- 检查完成：2026-11-14 17:41:25 UTC；上次检查完成：13:35:07 UTC；间隔 4 小时 06 分 18 秒，比四小时目标晚 6 分 18 秒。抽样监控，不代表连续在线。
- 结论：发现一项新上游集成提交，未发现本地交易/安全回归。Four.Meme AI 仓库在上次采样后的 15:28:43 UTC 更新；变化限于 BSC 事件读取、BigInt JSON 精度、CLI 文档及测试，没有更改交易 ABI/买卖实现、税费、滑点、批准或链支持。

## 上游变更

Four.Meme [官方 Agentic 页面](https://four.meme/en/agentic) 当前仍链接到 `four-meme-community/four-meme-ai`（官方来源交叉确认）；对应新提交：[`3918818c064878f577159c0a144323d38c55612b`](https://github.com/four-meme-community/four-meme-ai/commit/3918818c064878f577159c0a144323d38c55612b)，父提交 `0a07b65468caa73f552dd6a13013ef5071065996`，作者时间 2026-11-14 23:28:43 +0800。此仓库作为 Four.Meme 官方集成仓库监控；OpenFour 仍按 community/reference。

本次 GitHub 页面与提交 patch 显示 10 个文件变化（`README.md`、`bin/fourmeme.cjs`、`package.json`、`skills/four-meme-integration/SKILL.md`、`references/event-listening.md`、`get-recent-events.ts`、`verify-events.ts`、测试/fixture、`.gitignore`）：

- 事件与 `verify` 默认 BSC RPC 从 `https://bsc-dataseed.binance.org` 切到 `https://bsc-rpc.publicnode.com`；说明要求任何覆盖用 `BSC_RPC_URL` 的端点支持 `eth_getLogs`。这是事件查询要求，不是买卖交易路由变化。
- 两个事件输出脚本加入 JSON replacer，将 `uint256` BigInt 转为十进制字符串，避免 JSON 序列化异常并保留大整数精度。新增 mock 测试验证两个大数精确字符串及 verify 有事件场景。
- README / SKILL 文档改为说明 CLI 会从当前工作目录加载 `.env`；该 patch 没有改 loader 实现代码，本轮只记录为文档提示，不推断运行时实现刚发生改变。未启动 CLI、未读取任何本机 `.env` 或秘密。

## 与本地路径对照

- 相关本地入口：[src/fomo-call-monitor.js](/Users/qohfq/Documents/Playground/robinhood-chain-monitor/src/fomo-call-monitor.js) 默认也使用 PublicNode，并调用 `eth_getLogs`；Four.Meme 交易事件的独立解码在 [src/bsc-inner-trade-events.js](/Users/qohfq/Documents/Playground/robinhood-chain-monitor/src/bsc-inner-trade-events.js)，使用严格固定 ABI/字节布局并以 BigInt 解码，原始数量通过 `.toString()` 输出。没有发现项目对 `@four-meme/four-meme-ai` CLI 的运行时依赖。
- 最小模拟验证：`node --test test/bsc-inner-trade-events.test.js`，17 passed、0 failed。该套件用本地确定性 fixture 验证 Four.Meme/Flap 事件解码、ABI 字节边界与 raw amount 字符串；未连接 RPC，也未触及生产数据、配置或密钥。未运行上游仓库测试。
- 本地兼容判断：新默认 RPC 与本地已有 BSC PublicNode 默认一致；本地 raw `uint256` 保留路径已有 BigInt + 十进制字符串测试覆盖。因此本提交没有确认出本地缺口，也不代表所有 RPC 均支持事件查询。
- 覆盖边界：本次未做真实链端点请求、端到端钱包/买卖或线上告警投递测试。监控器的最近持久采集快照仍为约 13:34Z：Flap 为 59/59 正文失败及 sitemap 404（既有覆盖缺口），Four.Meme 8/10 页面可读且聚合结构化来源健康，HyperEVM 10/10 页面可读。该快照不能代表 17:35Z 的实时源健康。

## 其余重点源

本轮 `git ls-remote --heads --tags`（核对时间约 17:29–17:31 UTC）显示，除 Four.Meme AI 外，其余 refs/tag 与上轮一致；本轮发现 tag 0：

- `binance/binance-skills-hub`: `7d1b1f78d525f9e653b96819f91a549302fda1da`
- `four-meme-community/fourmeme-docs`: `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`
- `four-meme-community/openfour-docs`: `8ca5554df22ad511126d8547c212fa161ecf19ee`
- `flap-sh/flap-skills`: `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`
- 项目 GitHub `main`: `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`

官方页面复核：[Binance Agentic Wallet](https://developers.binance.com/en/docs/products/agentic-wallet/welcome) 仍列 BSC 56、Ethereum 1、Base 8453、Solana `CT_501`，未列 HyperEVM；[Four.Meme announcements](https://four.meme/en/announcement) 可读，最新显示 2026-02-02；[Flap Apps](https://docs.flap.sh/en/flap/v2/developers/flap-apps) 仍是 Draft/Coming，[Flap Agent Skills](https://docs.flap.sh/en/flap/v2/developers/agent-skills) 为 BNB Tax Token V3 发射说明，[FSI](https://docs.flap.sh/en/flap/v2/developers/flap-infrastructures/flap-shared-indexer) 仍为 Beta 且 endpoint 未公开；[HyperEVM overview](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) 仍列 chain ID 999/998、HYPE 原生 gas，[JSON-RPC 文档](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc) 限制未见改变。上述平台/仓库说明均不证明本地已具备对应新链或交易支持。

未连接钱包、未读取秘密、未签名/广播/下单，未改源代码/配置/策略，未部署/重启/推送/合并。
