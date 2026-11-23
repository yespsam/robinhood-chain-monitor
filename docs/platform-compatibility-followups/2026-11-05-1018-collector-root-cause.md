# 上游与采集器根因核查 — 2026-11-05 10:18 UTC

## 上游增量

六个受跟踪 GitHub 引用未变：Binance Skills Hub `96563daf34fa5a87af5d76c2f1107d697ae7ce07`、Four.Meme AI `0a07b65468caa73f552dd6a13013ef5071065996`、Four.Meme docs `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`、OpenFour community/reference docs `6f7efd5d3f14ed280cf471f70675ffba6d319943`、Flap skills `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`、项目 main `25335e6443128a099307b33fdd57844b3df65821`。OpenFour 仍未确认官方归属。

抽查 Flap RH guide 仍只列 `TOKEN_V2_PERMIT`/`newTokenV5`、`TOKEN_TAXED_V3`/`newTokenV6` 和 `V2_MIGRATOR`；没有据此推断任意 CA 或 Robinhood Chain 交易兼容。

## 本地采集故障与复现

状态快照截至约 `2026-11-05T10:18Z`：Flap 所跟踪 59/59 文档页失败、传输健康连续失败计数 3,254，最近成功时间仍为 `2026-11-04T14:26:01.597Z`；Four.Meme 10/10 文档页失败、健康连续失败计数 2,145，最近成功时间仍为 `2026-11-04T13:47:18.750Z`。

Flap 的本地发现/URL策略存在可复现的不兼容：

1. 当前 policy seeds 与 `path` allowlist 使用 `https://docs.flap.sh/flap/...`，见 `src/platform-document-watch.js` 的 `POLICIES.flap` 和 `allowedPlatformDocumentUrl`。
2. 直接 GET `https://docs.flap.sh/flap/developers/deployed-contract-addresses` 返回 `308 Location: /en/flap/developers/deployed-contract-addresses`；`https://docs.flap.sh/flap/developers` 同样重定向至 `/en/flap/developers`。
3. `fetchPlatformDocument` 使用 `redirect: 'manual'` 并拒绝重定向；这是安全边界，避免无验证地跟随外部跳转。
4. 本次直接 GET `/sitemap.xml` 和 `/en/sitemap.xml` 均返回 404；所以当前 sitemap 路径不能提供更新后的目录。
5. 当前 `/en/flap/developers/token-launcher-developers/robinhood-integration-guide` 直接返回 200，但 `allowedPlatformDocumentUrl` 以 `^/flap/...` 做 path 校验，将此 canonical `/en/flap/...` URL 拒绝为 `source_not_allowed`。

最小安全修复候选是确认并登记官方 `/en/flap/...` canonical seeds/path pattern，查明可用的官方目录来源后再扩展目录；保留手动重定向拒绝规则，不能用允许任意跟随 3xx 来绕过问题。未修改代码。

Four.Meme 的通用传输故障尚未复现：持久状态将页面错误记为 `document_fetch_failed`/无 HTTP 状态，整体 source health 报 timeout；但用当前 checkout 的同一 `fetchPlatformDocument` 函数访问配置的 `https://four-meme.gitbook.io/four.meme` 页面，在本 shell 成功（HTTP 200，提取正文 859 字符）。这表明上游页面此刻可读且当前进程路径能访问；后台 worker 的运行版本/网络上下文与一次性 shell 请求是否一致尚未知，不能断言根因。建议增加脱敏的错误类别与耗时诊断（例如 abort/timeout、TLS/DNS、HTTP status），不记录原始 URL 凭证或敏感头。

## 验证与边界

- `node --test test/platform-document-watch.test.js`：12 passed、0 failed；这些是 fixture/mock 测试，不验证生产监控进程。
- 一次性只读复现：Flap canonical `/en` 页面 HTTP 200 但当前 allowlist 拒绝；旧路径 308，当前实现拒绝重定向。Four.Meme base GitBook URL 经当前 helper 成功。
- 当前本地 checkout `codex/paper-focus-forward-simulation` / `817ff9f...` 含用户修改；执行中的 worker revision 未确认。未读取 `.env` 或秘密、未检查服务环境变量，也未停止/重启进程。
- 本轮未连接钱包、签名、广播、买卖、改策略/风险门槛、部署、push 或 merge。
