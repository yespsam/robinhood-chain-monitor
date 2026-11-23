# 2026-11-23 12:47 UTC — 常规来源/本地新鲜度复核

## 检查窗口

- 本次检查于 `2026-11-23T12:47:25Z` 完成，与前次 `2026-11-23T08:43:58Z` 间隔 4 小时 3 分 27 秒。存在采样间隔，不表示连续观察。
- 限于公开 Git refs 与既有本地健康/快照状态字段。没有实时价格/链上扫描、collector 启停、钱包/秘密访问或交易。

## 上游检查

监控的五个 GitHub 仓库默认分支及 Four.Meme AI 的待审功能分支未变：

| Repo/ref | SHA |
|---|---|
| `binance/binance-skills-hub` `main` | `7d1b1f78d525f9e653b96819f91a549302fda1da` |
| `four-meme-community/four-meme-ai` `main` | `3918818c064878f577159c0a144323d38c55612b` |
| `four-meme-community/four-meme-ai` `codex/openfour-create` | `8e7e92b2e8d9830d20d3df136dd04f7e2bf9670a` |
| `four-meme-community/fourmeme-docs` `main` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` |
| `four-meme-community/openfour-docs` `main` | `079a45e9c3358c9f357c84f336c7d915c9f0e9fc` |
| `flap-sh/flap-skills` `main` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` |

Tag ref count remains zero for all five repositories. Release endpoint was not retried after the prior sample's 403/404 mixture; 403 remains unverified, not “no release.” Persisted body watcher recorded no new content changes.

## 来源覆盖状态

- Flap: 4/5 source-health endpoints healthy, sitemap 404, 59/59 legacy body pages failed; last successful body read `2026-11-03T18:03:43.843Z`.
- Four.Meme: 13/13 health endpoints healthy; 8/10 watched bodies healthy; latest recorded body change `2026-11-18T18:31:10.073Z`.
- HyperEVM: 5/8 source-health endpoints healthy; all 10 watched bodies succeeded; latest recorded body change `2026-11-18T18:44:43.339Z`.
- These are coverage signals only. The earlier Flap GitHub source-trust overclaim remains open without new evidence; no repeated alert this cycle.

## 本地 marketData / flowData

只描述数据覆盖，不评价交易机会。

- `marketData.status = invalid_timestamp`：`data/studio/market.json` 文件 mtime 是 `2026-11-23T12:47:07Z`（检查前 18 秒），但两条数值报价没有逐项 `observedAt`。文件被近期写入并不代表行情数据新鲜。BSC/Solana 仍为 `invalid_timestamp`；HyperEVM/Four.Meme/Flap 无对应 market snapshot，记 `not_checked`。未发起实时行情请求。
- `flowData.status = stale`：GMGN 状态快照 `updatedAt=2026-11-20T08:41:31.617Z`，年龄 `273953383` ms（约 76 小时），总状态 `partial`；BSC/Solana/Robinhood 部分覆盖，Base/Ethereum backoff，最近成功在 10 月 3 日。Binance flow 状态 `updatedAt=2026-11-20T08:41:45.186Z`，年龄 `273939814` ms、模式 readonly；仅为旧样本。HyperEVM flow `not_checked`。
- Flow 的 stale 来自明确快照时间，不是没有交易行。该 stale 和缺报价时间戳此前已通知，分类没有变化，本轮不重复提醒。

## 本地兼容性

没有上游差异或新兼容性影响。本地 live GMGN 链/资产限制仍为 BSC/SOL；HyperEVM 仍只是链元数据；Flap Pool Launch 仍是 BNB Chain 56 事件解析。未运行测试，也没有改代码或执行任何交易/签名/部署操作。
