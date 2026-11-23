# 2026-11-22 20:47 UTC — 来源与本地数据新鲜度

## 检查窗口与边界

- 本次检查于 `2026-11-22T20:47:24Z` 完成；与前次 `2026-11-22T16:41:47Z` 间隔 4 小时 5 分 37 秒。样本点之间存在观察间隔，不代表持续在线。
- 读取了公开 Git refs、现有本地来源健康/文档快照、本地市场与资金流快照的时间戳/状态字段；未读取原始 flow 交易行、钱包/秘密数据，未请求实时价格或链上数据，未启动服务。

## 上游变化

Git 默认分支与已监视功能分支 SHA 与前次相同：

| 仓库 / ref | SHA |
|---|---|
| `binance/binance-skills-hub` `main` | `7d1b1f78d525f9e653b96819f91a549302fda1da` |
| `four-meme-community/four-meme-ai` `main` | `3918818c064878f577159c0a144323d38c55612b` |
| `four-meme-community/four-meme-ai` `codex/openfour-create` | `8e7e92b2e8d9830d20d3df136dd04f7e2bf9670a` |
| `four-meme-community/fourmeme-docs` `main` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` |
| `four-meme-community/openfour-docs` `main` | `079a45e9c3358c9f357c84f336c7d915c9f0e9fc` |
| `flap-sh/flap-skills` `main` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` |

`git ls-remote --tags --refs` 返回五个仓库均 0 个 tag ref。Latest-release endpoint 对 Binance Skills Hub、OpenFour docs、Flap Skills 返回 HTTP 403；对 Four.Meme AI 和 fourmeme-docs 返回 404。403 代表 release 查询覆盖缺口，不能解读为没有 release；所有默认分支 ref 查询成功且无变化。

本地官方文档 watcher 快照：

- Flap：4/5 health sources healthy，sitemap 仍 HTTP 404；59/59 旧 body routes 失败，最后成功正文在 `2026-11-03T18:03:43.843Z`。此为旧路由/覆盖缺口，不代表整个官方文档不可访问；本周期前段直接读取的 Flap v2 canonical 页成功。
- Four.Meme：13/13 health sources healthy；10 个正文路由中 8 成功、2 失败/redirect-rejected。最新记录变更仍为 `2026-11-18T18:31:10.073Z`。
- HyperEVM：8 个 endpoints 中 5 healthy、3 degraded；10/10 body routes 成功，最新正文样本 `2026-11-22T20:43:34.754Z`。最新记录页面变化仍为 `2026-11-18T18:44:43.339Z`。

上述是来源覆盖状态；不据此推断代币可交易或新链已适配。前一周期报告的 `flap-sh/flap-skills` 本地 `official_verified` 来源标记尚未有新的官方 GitHub 直链证据，本轮不重复告警；仍待人工核验。

## 本地市场/资金流新鲜度

这是数据覆盖状态，不是交易机会判断；没有请求新的市场数据。

- `marketData.status = invalid_timestamp`：`data/studio/market.json` 存在，mtime 为 `2026-11-19T12:45:47Z`，距检查约 288,097,000 ms（80 小时 1 分 37 秒）。其中两条数值报价没有逐项 `observedAt`，因此不能由文件 mtime 证明报价本身在该时刻采集或仍新鲜。BSC 与 Solana quote rows 标 `invalid_timestamp`；HyperEVM、Four.Meme、Flap 没有该快照覆盖，标 `not_checked`。
- `flowData.status = stale`：只读快照 `data/gmgn-flow-state.json` 最新 `updatedAt` 为 `2026-11-20T08:41:31.617Z`，距检查约 216,352,383 ms（60 小时 5 分 52 秒）；快照总状态为 `partial`。BSC/Solana/Robinhood 的 GMGN 行为 partial；Base/Ethereum 为 backoff，最近成功时间分别在 2026-10-03。`data/binance-flow-state.json` 最新更新时间为 `2026-11-20T08:41:45.186Z`，距检查约 216,338,814 ms，状态模式为 readonly；BSC/Solana/Robinhood 上次快照 feed 状态为 ok，Base/Ethereum 为 warming。所有这些时间都是历史 snapshot，不代表本轮新采集，也不因没有交易行就判 stale。
- 资金流各链按明确的最近快照时间标记 `stale`；HyperEVM 没有对应资金流快照，标记 `not_checked`。本轮没有重启/调用 collector 来刷新。

## 本地兼容性

未发现上游 ref 或已记录正文变化，因此没有新增链/发射台/ABI 对本地交易路径的兼容变化。静态检查仍显示本地 GMGN live gate 限定 BSC/SOL 与已审 spend pair；HyperEVM 999/998 仅是 chain metadata；Flap Pool Launch parser 仍绑定 BNB Chain 56。没有运行测试。

## 需要注意

本周期首次按新要求计算到本地资金流快照约 60 小时未更新，且行情数字缺少逐项时间戳。这个通知代表数据覆盖不足，不代表市场安静或出现交易机会。建议由人工检查现有 collector 运维/采集状态；本监控没有启动服务、读取秘密、连接钱包、做实时扫描或交易。
