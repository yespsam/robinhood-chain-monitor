# Flap / Agentic Wallet 兼容性增量检查 — 2026-11-04 02:15 UTC

## 结论

- 六个受监控 GitHub 主分支头部与 2026-11-03 22:12Z 检查点一致：Binance Skills Hub `96563daf34fa5a87af5d76c2f1107d697ae7ce07`、Four.Meme AI `0a07b65468caa73f552dd6a13013ef5071065996`、Four.Meme docs `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`、OpenFour community docs `6f7efd5d3f14ed280cf471f70675ffba6d319943`、Flap skills `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`、本项目 GitHub main `bb559cd5316090c37a578f56c2f5fe4655f09ee1`。
- 本地 Flap 文档监控故障持续。`data/platform-capability-state.json` 在约 02:13:28Z 的快照中，59 个已跟踪 Flap 页面全部为 failed：58 个 `redirect_rejected`、1 个 `document_http_404`。Robinhood guide 的最后成功时间仍为 `2026-11-03T17:57:33.591Z`；截至该快照连续失败计数为 189。直接探测验证 sitemap 风格 URL 返回 HTTP 308、`Location: /en/flap/...`；同源 `/en/flap/...` canonical URL 返回 200。已读官方页面并不代表本地采集器已恢复。
- 根因仍与前轮一致：`src/platform-document-watch.js` 的 Flap 路径策略允许 `/flap/...`、请求使用 `redirect: 'manual'` 并拒绝 3xx，且 `/en/flap/...` 不在允许路径内。当前 59 页监控覆盖不能用于判断文档内容是否变化。最小修复建议是仅将来自受信 sitemap 的 Flap URL 规范化到 canonical `/en/flap/...`，或严谨地允许同源 locale path；仍须拒绝外站、降级协议、路径穿越及非预期跳转，并加回归测试。本轮未改代码。
- 当前可直接读取的 [Flap Robinhood Integration Guide](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide) 列出：仅 `TOKEN_V2_PERMIT`/`newTokenV5` 与 `TOKEN_TAXED_V3`/`newTokenV6`；仅 `V2_MIGRATOR`；Robinhood Chain 当前以原生 ETH 作为唯一启用报价资产（要求集成方实际核验链上实时配置）；迁移为 Uniswap V2。指南说明预毕业阶段注册池交易受限，毕业后反农民窗口只放行 mainPool，窗口过后恢复常规 V2 路由。其示例的 `minOutputAmount: 0` 仅为文档示例，不应复制为真实执行下限。页面自身未显示比前轮已记录内容更新的版本日期；本轮不是发现新发布。
- 本地相关工作树有一项未提交差异：`src/flap-quote-monitor.js` 将 BNB Portal 的“previous verified”身份从 v5.25.0 改为 v5.26.0（实现 `0x7a94f37b61a82c395f9812CF266b444783cC5e8c`，代码哈希 `0x3db27f98826706ac5ddedb919594d4670151874482dff23e31d2186858635194`）。值与 2026-10-21 的本地 [v5.26 compatibility evidence](../flap-v526-compatibility-evidence-2026-10-21.md) 相符；聚焦离线测试通过 7/7。此差异不是上游本轮更新，且只验证身份/状态迁移路径，不验证 Flap 交易 ABI、报价、mint 或所有 token 的买卖能力。本轮未改动该差异。
- Flap BNB/RH 部署页面仍标注 v5.23.1；此前保存的本地固定块/双 RPC 证据记录 BNB Portal 实现 v5.27.2。该文档/链上版本表述差异仍未解决；此轮未做新的 RPC 请求。
- 本地 Robinhood 观察器仍不覆盖 chainId `4663`，仅用于 BNB Chain 56；这属于覆盖缺口，不代表 Agentic Wallet 或 Flap 在 Robinhood 上不能交易。

## 核验范围与测试

- 当前六个 GitHub `HEAD` 以只读 `git ls-remote` 复核，SHA 均无变化。
- Flap 官方 canonical Robinhood guide 和部署地址页面本轮可读；sitemap endpoint 经当前 web reader 不可访问。本地 sitemap-derived state 仍记录 lastmod `2026-07-13T06:18:57.575Z`。
- `node --test --test-name-pattern='v5\\.26\\.0|chain ID and every pinned Portal implementation identity' test/flap-quote-monitor.test.js test/flap-portal-pins.test.js`：7 passed, 0 failed。仅测试模拟的链/实现身份与状态迁移。
- `node --test --test-name-pattern='redirect' test/platform-document-watch.test.js`：1 passed, 0 failed。该用例确认通用重定向拒绝仍工作，但没有覆盖 Flap 同源 308 到 `/en/flap/` 的规范化恢复。
- 未访问钱包、未读取秘密配置、未签名、未广播、未执行买卖、未部署或重启服务。

## 下次问题

确认 Flap 文档采集器是否有经审查的修复；若有，仅验证 same-origin canonicalization 与外站/降级/路径穿越拦截。继续跟踪六个主分支；分别核对 RH 4663 路由与 BNB 56 观察器，不将文档支持表述当成 live wallet/route 兼容证明。
