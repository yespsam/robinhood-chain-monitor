# 2026-11-23 04:42 UTC — 常规来源与数据覆盖复核

## 检查窗口

- 本次检查 `2026-11-23T04:42:55Z`，距离上次 `2026-11-23T00:42:52Z` 为 4 小时 3 秒。只是低频离散采样，不代表持续在线。
- 读取公开 Git refs 和已有本地健康/快照元数据。未请求实时行情/链上数据，未启动采集器，未读取钱包、秘密或原始资金流记录。

## 上游增量

监控中的主分支与 Four.Meme AI 待审分支 SHA 均未变：

| Repo/ref | SHA |
|---|---|
| `binance/binance-skills-hub` `main` | `7d1b1f78d525f9e653b96819f91a549302fda1da` |
| `four-meme-community/four-meme-ai` `main` | `3918818c064878f577159c0a144323d38c55612b` |
| `four-meme-community/four-meme-ai` `codex/openfour-create` | `8e7e92b2e8d9830d20d3df136dd04f7e2bf9670a` |
| `four-meme-community/fourmeme-docs` `main` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` |
| `four-meme-community/openfour-docs` `main` | `079a45e9c3358c9f357c84f336c7d915c9f0e9fc` |
| `flap-sh/flap-skills` `main` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` |

五个仓库 tag refs 均为 0。Latest-release API 沿用前次结果，本轮未重试：三个 repo 上次 HTTP 403，两个 HTTP 404；403 仍表示未核实，不推断“无 release”。本地文档快照未记录新正文变化。

## 上游来源覆盖状态

- Flap：4/5 health endpoints healthy；sitemap 404；59/59 legacy body routes failed，最后成功正文 `2026-11-03T18:03:43.843Z`。这是抓取覆盖缺口，不代表官方文档整体不可用。
- Four.Meme：13/13 health sources healthy；8/10 body pages healthy、2 failed；最近变更仍记录于 `2026-11-18T18:31:10.073Z`。
- HyperEVM：5/8 health endpoints healthy、3 degraded；10/10 body pages healthy；最近变更仍记录于 `2026-11-18T18:44:43.339Z`。
- 前次报告的 `flap-sh/flap-skills` 本地 `official_verified` 标签问题未有新证据或代码变更；维持人工复核项，本轮不重复提醒。

## 本地市场与资金流快照

这些分类只表示数据覆盖，不代表交易机会：

- `marketData.status = invalid_timestamp`。`data/studio/market.json` 文件 mtime 很新（`2026-11-23T04:42:06Z`，检查时约 49 秒前），但两条数值报价都没有逐条 `observedAt`。因此 mtime 不能证明价格新鲜，BSC/Solana 仍为 `invalid_timestamp`；HyperEVM、Four.Meme、Flap 为 `not_checked`。没有实时价格请求。
- `flowData.status = stale`。GMGN 快照仍为 `2026-11-20T08:41:31.617Z`（约 68 小时），总体 `partial`；BSC/Solana/Robinhood 部分覆盖，Base/Ethereum 为 backoff，最近成功仍在 10 月 3 日。Binance flow 快照为 `2026-11-20T08:41:45.186Z`（约 68 小时），模式 readonly；这些是旧快照状态，不代表本轮重新采集。HyperEVM flow `not_checked`。
- 市场报价的无时间戳与资金流 stale 已在上一轮通知，本轮状态分类未改变，因此不重复提醒。未因无交易信号判 stale；flow stale 仅基于明确的快照时间。

## 本地兼容性

无新增上游变化或本地兼容性回归。静态本地路径边界未变：GMGN live gate 限定 BSC/SOL，HyperEVM 只有 chain metadata，Flap Pool Launch 解析限定 BNB Chain 56。未运行测试；没有连接钱包、读取秘密、签名、广播、下单、改策略、部署/重启或 push/merge。
