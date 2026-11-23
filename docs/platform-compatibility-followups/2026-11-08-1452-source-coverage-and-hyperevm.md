# 官方平台来源与 HyperEVM 兼容性增量复核 — 2026-11-08 14:52 UTC

## 结果

六个受监测 GitHub `main` refs 与 2026-11-08 10:30Z 检查点相同，五个平台仓库本轮没有 tag/release refs。没有确认新的官方链、新发射台或发行机制。

发现一个仍需人工处理的**本地来源采集故障**：持久化运行状态在约 14:50Z 显示 Flap 文档 59/59 页失败，最后成功正文仍是 2026-11-03T18:03:43.843Z；Four.Meme GitBook 文档 10/10 页失败、6 条历史待核变化仍在队列中，13/13 来源健康项 degraded。最近一次尝试分别到 14:50Z 左右。官方网页可通过独立只读浏览访问（Four.Meme announcement 可读；Flap skills / Hyperliquid docs 可读），因此不能把本地 `fetch failed` 解释为平台宕机。

## refs 与来源归属

只读 `git ls-remote` 核对的 heads：

- `binance/binance-skills-hub`: `96563daf34fa5a87af5d76c2f1107d697ae7ce07`
- `four-meme-community/four-meme-ai`: `0a07b65468caa73f552dd6a13013ef5071065996`
- `four-meme-community/fourmeme-docs`: `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`
- `four-meme-community/openfour-docs`: `84dc55c7f4710544430ef4939ef36e4e514017bb`（未从 Four.Meme 官方站点找到该确切仓库的归属反链，仍是 community/reference）
- `flap-sh/flap-skills`: `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`
- 项目 GitHub `main`: `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`

五个平台仓库的 `git ls-remote --tags --refs` 均返回 0 个 refs。Flap 官方技能说明直接链接到 `flap-sh/flap-skills` 与 `binance/binance-skills-hub`，可作为这两个仓库的官方站点交叉确认依据：[Flap skills](https://docs.flap.sh/en/flap/skills)、[Flap × Binance Agentic Wallet 指南](https://docs.flap.sh/en/flap/skills/using-with-binance-agentic-wallet)。

Four.Meme 官方域名的 `/en/agentic` 搜索索引列出 `npx skills add four-meme-community/four-meme-ai`，并描述创建、报价和执行买卖等 agent 功能；但该索引显示约两个月前抓取，本轮直接打开 `/en/agentic` 返回 403。故它可作为官方站点的历史交叉链接线索，不能当作本轮新发布或实时核实的功能声明。`four-meme-ai` main SHA 本轮未变。该技能的交易/签名能力不等于本地监控器已集成；没有安装/执行 CLI，也没有读取任何 `.env` 或密钥。

Four.Meme 官方公告页本轮可读，页面最新条目日期仍为 2026-02-02（“FOUR.MEME Tax Mode is Live”）：[公告](https://four.meme/en/announcement)。其 GitBook “How it works”正文说明多报价资产用于 Four.Meme 内盘池及迁移；这本身不代表任意 CA 或本地路径兼容：[官方机制页](https://four-meme.gitbook.io/four.meme/guide/how-it-works)。

## HyperEVM 当前限制与本地边界

Hyperliquid 官方页面本轮直接打开，HyperEVM 与 HyperCore 仍明确分属不同执行/交易环境。HyperEVM 主网 chain ID `999`、RPC `https://rpc.hyperliquid.xyz/evm`；测试网 `998`、RPC `https://rpc.hyperliquid-testnet.xyz/evm`；原生 gas 资产为 HYPE（18 位）。默认 RPC 不支持 WebSocket JSON-RPC；默认 JSON-RPC 对历史状态只支持 latest；`eth_getLogs` 最多 4 个 topics、最多 50 个 blocks；主网 EVM RPC 默认每 IP 每分钟最多 100 个请求。官方 JSON-RPC 页还列出边界错误 `10055` 可包含 nonce、余额不足、重复交易哈希或 replacement underpriced：[HyperEVM](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm)、[JSON-RPC](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc)、[rate limits](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits)。

本机 `data/platform-capability-state.json` 的 HyperEVM 文档采集为 10/10 healthy、0 failed、0 unreported changes，最新成功正文约 14:47Z；未核到官方 HyperEVM launchpad/发行合约。源码 `src/chain-support.js` 识别 999/998 是发现/分类能力，不等于执行接入；未验证本地 HyperEVM 买卖适配。Flap 本地 quote watcher 仍固定 BNB chain ID 56（`src/flap-quote-monitor.js`），Pool Launch 观察器也固定 chain ID 56（`src/flap-pool-launch.js`）；本轮没有交易、ABI 或报价验证。

## 覆盖与缺口

- Flap 文档 watch：59 tracked / 59 failed；最后正文成功 2026-11-03T18:03:43.843Z；本轮尝试约 14:50Z 仍失败。独立官方 Flap skills 页面和其 Binance 指南可读，表明页面可读不等于本地收集器已恢复。
- Four.Meme：source health 13/13 degraded；GitBook watch 10 tracked / 10 failed，最近持久化成功正文 2026-11-08T12:35:42.883Z，6 条历史待核变化；Four.Meme `/en/agentic` 直接 403，搜索索引只能作过时线索。不能据此断言该间隔没有平台更新。
- HyperEVM：10 tracked / 10 healthy，0 failed，正文未见变化；没有经官方核验的新 launchpad。
- 受监测项目本地 checkout 仍处于 `codex/paper-focus-forward-simulation`、HEAD `817ff9fc8a79a12137e1658cfb45b343e4c7f46e` 且工作区大量 dirty；运行服务所用 commit/config 未核验。

本轮只读检查官方网页、远端 refs 与现有持久化状态；未运行应用测试、未读取秘密、未连接钱包、未签名/广播/下单、未修改交易代码或配置、未重启/部署、未 push/merge。
