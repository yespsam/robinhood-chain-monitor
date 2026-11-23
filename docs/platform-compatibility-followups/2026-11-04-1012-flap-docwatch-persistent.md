# 平台兼容性增量复核 — 2026-11-04 10:12 UTC

## 结论

- 六个受监控 GitHub 主分支当前 SHA 与 06:17 UTC 检查点一致：Binance Skills Hub `96563daf34fa5a87af5d76c2f1107d697ae7ce07`；Four.Meme AI `0a07b65468caa73f552dd6a13013ef5071065996`；Four.Meme docs `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`；OpenFour community docs `6f7efd5d3f14ed280cf471f70675ffba6d319943`；Flap skills `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`；项目 GitHub main `bb559cd5316090c37a578f56c2f5fe4655f09ee1`。本轮未发现上游仓库新提交。
- Flap 文档采集仍未恢复。`data/platform-capability-state.json` 的 10:10:13.795Z 快照为 59/59 个跟踪页 `failed`（58 `redirect_rejected`，1 `document_http_404`）；Robinhood integration guide 连续失败 378 次，最后成功仍是 `2026-11-03T17:57:33.591Z`，下次尝试约在 10:10:38Z。Flap sitemap 条目截至 10:08:52Z 已连续 474 次 HTTP 404，退避 120 秒。
- 独立只读 HTTP 复核重现来源：旧 sitemap 风格指南 URL 返回 308，`Location: /en/flap/developers/token-launcher-developers/robinhood-integration-guide`；canonical URL 返回 200；`https://docs.flap.sh/sitemap.xml`、`/llms.txt` 与 `/en/llms.txt` 当前均返回 404。故障在本地采集入口/URL 策略，不等于 Flap 指南不可读。官网当前指南与已存内容相符：Robinhood Chain 仅列 `TOKEN_V2_PERMIT`/`newTokenV5` 与 `TOKEN_TAXED_V3`/`newTokenV6`、`V2_MIGRATOR`、原生 ETH quote 和阶段性限制；其中 `minOutputAmount: 0` 仅是示例，不能当作真实成交保护。
- Four.Meme 页面覆盖也不完整：本地记录 `four.meme` 市场/官网源为 partial，首页、advanced、agentic 等六个可选 URL 开 circuit；独立请求确认 `/en`、`/en/advanced`、`/en/agentic` 均 HTTP 403。其文档观察器 10 页中 8 页 healthy、2 页 redirect rejected。官方 GitHub refs 未变化；官方 GitBook 的 How-it-works 页面可读取，当前多交易对文字含 meme tokens，最新本地正文差异记录于 11 月 1 日，未见本轮新变更。[Four.Meme How-it-works](https://four-meme.gitbook.io/four.meme/guide/how-it-works)
- Flap 官方部署页仍列 Robinhood Portal `0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09`（标签 v5.23.1）；直接页可读，但这不证明本地已覆盖 chainId 4663 或能执行所有 CA 交易。[Flap Robinhood guide](https://docs.flap.sh/en/flap/developers/token-launcher-developers/robinhood-integration-guide) · [Flap deployed contracts](https://docs.flap.sh/en/flap/developers/deployed-contract-addresses)
- 本地改动仍只有用户工作树中的 `src/flap-quote-monitor.js` v5.26.0 predecessor-pin 差异；本轮未编辑任何源码或交易状态。离线 focused tests：Portal identity/state-migration 7/7 通过；redirect 安全测试 1/1 通过。后一个测试只证明不安全 redirect 仍被拒绝，不覆盖信任的同源 `/en/flap/` locale canonicalization，因此不代表采集恢复。

## 处理建议与边界

最小待审修复是将受信 sitemap 路径规范化到官网同源 `/en/flap/...`，或仅允许严格验证后的同源 `/en/flap/` locale 路径，并为确定性的 sitemap 404/locale redirect 故障采用非 2 分钟级重复退避。必须保留拒绝外站、HTTPS 降级、路径穿越和意外 host 的测试。Four.Meme 主站 403 时可继续读其已确认官方的仓库及 GitBook 文档，但应标注首页/动态源覆盖不完整。

本轮仅做了公开网页、Git refs 和本地状态/离线测试核对；未连接钱包、读取秘密配置、签名、广播、mint、买卖、部署、重启或改策略。Flap 的 BNB quote observer 仍不覆盖 Robinhood chainId 4663；这是观察/兼容验证缺口，不是“不能交易”或“任何 CA 均可交易”的结论。
