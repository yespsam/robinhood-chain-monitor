# Flap / Agentic Wallet 兼容性增量检查 — 2026-11-04 06:16 UTC

## 结果

- 六个受监控 GitHub 主分支相较 02:15Z 均未变化：Binance Skills Hub `96563daf34fa5a87af5d76c2f1107d697ae7ce07`；Four.Meme AI `0a07b65468caa73f552dd6a13013ef5071065996`；Four.Meme docs `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`；OpenFour community docs `6f7efd5d3f14ed280cf471f70675ffba6d319943`；Flap skills `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`；项目 GitHub main `bb559cd5316090c37a578f56c2f5fe4655f09ee1`。
- Flap 文档采集故障仍未恢复。`data/platform-capability-state.json` 在 06:15:54Z 附近记录 59/59 Flap 跟踪页失败：58 个 `redirect_rejected`、1 个 `document_http_404`。Robinhood integration guide 最后成功为 `2026-11-03T17:57:33.591Z`；06:15:54Z 时连续失败 286 次，下一重试时间为 06:17:54Z（约 120 秒后）。
- 本轮独立只读请求重现了根因：旧 sitemap 风格 URL 返回 308，`Location: /en/flap/...`；locale canonical URL 返回 200。`src/platform-document-watch.js` 对该平台设置 `/flap/...` 路径 allowlist，并以 `redirect: 'manual'` 拒绝 3xx；因此不是官网文档页面不可用，而是本地路径/重定向处理不兼容。
- 故障会持续产生低价值重试：每页连续失败后当前退避上限为 120 秒，见 `applyPlatformDocumentResult` 默认 `retryMaxMs`。59 页仍全部失败时，建议先修复受信 sitemap 的 canonical URL 处理，再避免对确定的同源 locale redirect 无限按 2 分钟节奏重试；任何调整必须保留拒绝外站、协议降级、路径穿越和非预期重定向的安全边界。本轮按监控范围未改源码。
- 当前可读的 [Flap Robinhood Integration Guide](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide) 仍列出两类受支持 token、`V2_MIGRATOR`、原生 ETH 报价与 Portal/阶段性交易限制；与前轮记录一致，不是新发布。页面的 `minOutputAmount: 0` 示例不应作为实际交易保护参数。官方[部署地址表](https://docs.flap.sh/en/flap/developers/deployed-contract-addresses)仍展示 Robinhood Portal，但不等同于本地报价观察器或钱包买卖支持已通过验证。
- 本地未提交的 `src/flap-quote-monitor.js` v5.26 predecessor-pin 差异仍在；其固定身份与 2026-10-21 证据一致。本轮聚焦离线验证：Flap Portal pin/状态迁移 7/7 通过；redirect 安全测试 1/1 通过。后者确认防护仍拒绝 redirect，但没有覆盖同源 `/en/flap/` canonicalization，因此不表示文档采集恢复。
- BNB 观察器与 chainId 56 仍是现有范围，Robinhood Chain 4663 的观察覆盖缺口未解决；没有新增 RPC、钱包、ABI、报价、mint 或交易测试。

## 安全边界与下次检查

六个仓库归属沿用已建立的官方来源交叉核验记录；本轮主分支 SHA 无变化。未读取秘密配置，未连接钱包、签名、广播、买卖、部署、重启或更改用户工作树。下轮确认文档采集是否恢复，并重点检查同源 locale allowlist、redirect 来源验证与失败退避是否修复且有测试；不要将文档/Portal 地址清单等同交易可用性。
