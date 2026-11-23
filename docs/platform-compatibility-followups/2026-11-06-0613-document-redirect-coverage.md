# 平台源恢复、文档规范 URL 覆盖缺口 — 2026-11-06 06:13–06:18 UTC

## 摘要

相较 02:20 UTC 的检查，后台平台结构化来源已恢复读取：Four.Meme 当前 13/13 个记录来源为健康；Flap 的看板、主要开发文档种子均健康，唯一仍失败的是其 404 sitemap，因此总体为 partial。主进程心跳在 06:12:52 UTC 更新，sequence 2580。

文档正文监控仍不完整，且本轮把超时问题分离为规范 URL/重定向拒绝：Flap 59 个跟踪页中 58 个 `redirect_rejected`、1 个 sitemap-era 子页为 `document_http_404`，健康 0/59；Four.Meme 10 页中 8 健康、2 个 `redirect_rejected`。这不是平台普遍不可达：重定向目标在同一官方 origin，直接请求已验证为 200。监控器拒绝重定向是既有安全策略；问题在旧路径及本地允许路径未随官方 canonical URL 迁移更新。

## 可复现证据

检查时间 2026-11-06 06:13–06:18 UTC。`src/platform-document-watch.js` 中的 `fetchPlatformDocument` 使用 `redirect: "manual"`，并明确拒绝 3xx；`allowedPlatformDocumentUrl` 只接受当前配置的路径模式。实际读取结果：

| 旧官方 URL | 手动重定向响应 | 已核实 canonical URL | Canonical 响应 |
| --- | --- | --- | --- |
| `https://docs.flap.sh/flap/developers` | 308 → `/en/flap/developers` | `https://docs.flap.sh/en/flap/developers` | 200 |
| `https://docs.flap.sh/flap/developers/wallet-and-terminal-and-bot-developers/trade-tokens` | 308 → `/en/flap/developers/wallet-and-terminal-and-bot-developers/trade-tokens` | 同源 `/en/...` 路径 | 200 |
| `https://four-meme.gitbook.io/four.meme/product-update` | 307 → `/four.meme/product-update/6-product-update-25-10-30` | `https://four-meme.gitbook.io/four.meme/product-update/6-product-update-25-10-30` | 200 |
| `https://four-meme.gitbook.io/four.meme/brand/protocol-integration` | 307 → `/four.meme/developer/openfour-integration` | `https://four-meme.gitbook.io/four.meme/developer/openfour-integration` | 200 |

Four.Meme `sitemap.xml` 返回站点 sitemap index，再指向 `sitemap-pages.xml`；后者返回 36 个页面，明确列出 Product Update #6 与 OpenFour Integration 两个 canonical URL。Flap 根 `sitemap.xml` 仍为 404。当前允许路径函数拒绝 Flap 的 `/en/flap/...` 和 Four.Meme 的 `/developer/openfour-integration`；Product Update #6 的 `/product-update/...` 已在允许范围且已被正常跟踪。

## 上游内容与交易链路影响

- GitHub 只读 `git ls-remote` 核对六个 main refs：Binance skills、Four.Meme AI/docs、OpenFour docs、Flap skills 和本项目 main 均与上一检查点相同；此次未见提交变化，refs/tags 无输出。GitHub REST API 对六个仓库均返回 403，因此本次不声称已独立核实 release 元数据；commit/ref 核对由 git transport 成功完成。
- Four.Meme Product Update #6 canonical 页的本地基线为 2026-10-10，`lastContentChangedAt` 仍为 null；本轮是已存在正文的成功重读，不是新增内容。该历史页面描述 X Mode（Fair Mode 更名）对所有钱包开放、交易费逐区块下降，以及成功迁移后的部分费用用于回购销毁；未给出具体逐块费率。本地 `src/platform-capability-monitor.js` 已有 X Mode 能力标记。`src/fomo-call-monitor.js` 的 Four V2 安全分支读取 `_tokenInfos` / `_tradingHalt` 并要求观察到真实曲线卖出事件；本轮未验证实际 CA、动态费参数或任何买卖，因此不据该历史文案推断现行 token 费用或可交易性。
- `developer/openfour-integration` 页面在 Four.Meme 官方 GitBook sitemap 中出现，但被本地 `path` 白名单排除，无法作为正文基线；当前旧 `brand/protocol-integration` 种子只会被安全地拒绝重定向。
- `node --test test/platform-document-watch.test.js`: **12 passed, 0 failed**。该套测试确认重定向会被拒绝；测试是本地 fixture/mock，不验证平台的所有 canonical 页，也不证明交易执行兼容。

## 最小修复建议与安全边界

将已验证的官方 canonical 地址纳入狭窄 allowlist：对 Flap 仅允许当前同源 `/en/flap/(developers|skills|product-update)` 已验证子路径，或逐项迁移现有白名单种子；对 Four.Meme 将 Sitemap 明列的 `/developer/openfour-integration` 纳入允许范围，并让 Product Update 根路径由 sitemap 中的最新具体页面覆盖。保留 `redirect: "manual"` 和任意/跨域重定向拒绝，不做通用自动跟随；补测试覆盖 308/307 不跟随、允许的同源 canonical 页面与 sitemap provenance。

本轮未改代码、策略、配置或账本；未连接钱包、读秘密、签名、广播、买卖、部署、重启、push 或 merge。动态费用需要逐笔报价/链上状态证据，未知时继续 fail-closed。
