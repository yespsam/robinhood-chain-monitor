# Four.Meme 公共配置采集降级：增量复核

- 检查完成：2026-11-16 12:47:28 UTC；上次完整检查：2026-11-15 09:30:04 UTC；间隔 27 小时 17 分 24 秒，超过四小时目标约 23 小时 17 分。此为低频采样，期间存在明确观察空档，不代表连续在线。
- 结论：所有被跟踪的官方平台仓库 main SHA 与上轮一致、未发现 tag。Four.Meme 必需的 public-config 采集端点本轮在 12:40Z 返回 HTTP 403，之前成功时间为 2026-11-15 11:35:05Z；仅一次失败，collector 已安排 15 分钟退避，故目前是监控覆盖降级，不是交易或链故障证据。其他官方文档没有确认新的交易协议变化。

## 上游 refs 与增量代码

本轮 `git ls-remote --heads --tags`（约 12:43Z）观察到以下 main/tag 状态，均与 2026-11-15 09:30Z 检查一致；未列到 tag：

| 官方/跟踪来源 | main SHA |
|---|---|
| `binance/binance-skills-hub` | `7d1b1f78d525f9e653b96819f91a549302fda1da` |
| `four-meme-community/four-meme-ai` | `3918818c064878f577159c0a144323d38c55612b` |
| `four-meme-community/fourmeme-docs` | `5f7f589b042e4e3b41c2c214d0fe3a81b36725a9` |
| `four-meme-community/openfour-docs` | `8ca5554df22ad511126d8547c212fa161ecf19ee` |
| `flap-sh/flap-skills` | `07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a` |
| 项目 GitHub `main` | `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1` |

额外检查到两个非 main 分支：

- Binance `wallet_rm_agent_id` 为 `4fc14e4c0b526c28e7cb1ec130a02a5f7bd99387`，相对 main 落后一条提交、没有 branch-ahead 改动；移除 Agent ID 独占交易流的提交已包含于 main `7d1b1f78`，不是新变化。
- Four.Meme AI `codex/fix-issue-3-events-bigint` 为 `7987396e3db0710fe36c986d1fffc5c810d98846`，与 main 分叉各一条提交。该分支改动是 BSC 事件 CLI 将 `uint256` 序列化为十进制字符串并改用支持 `eth_getLogs` 的 PublicNode 默认端点；这不是新 main 提交或平台规则。main 的对应事件精度/日志查询变更已在上一份 [Four.Meme AI 事件精度复核](2026-11-14-1735-fourmeme-ai-event-precision.md) 记录为 `3918818c`。当地对应的 `src/bsc-inner-trade-events.js` BigInt 原始值字符串化及 `src/fomo-call-monitor.js` PublicNode 使用、既有 fixture 测试已在该报告中核验；本轮未重复运行测试。

来源归属仍按既有交叉证据：Binance 官方文档链接 Skills Hub；Four.Meme `/en/agentic` 链接 `four-meme-community/four-meme-ai`；Flap 官方导航链接 `flap-sh/flap-skills`。OpenFour 本轮未重新交叉验证归属，继续按 community/reference，不将其当平台规则。

## 官方页面与监控覆盖

- [Binance Agentic Wallet 官方文档](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)：本轮直连返回 HTTP 202，未可靠获得可比对的正文；上一轮显示支持链列表不含 HyperEVM，当前内容变化未验证。Skills Hub main 未变化。
- [Four.Meme Agentic 页面](https://four.meme/en/agentic)：直连 HTTP 200。官方[公告页](https://four.meme/en/announcement) 的本轮 curl 返回 HTTP 200 HTML 外壳，但未提取出公告记录；网页读取工具仍返回 HTTP 403。因此公告列表和最新日期仍未验证，不能把 HTTP 200 外壳当作内容覆盖恢复。
- Four.Meme 本地结构化采集状态来自 `data/platform-capability-state.json`：必需来源 `https://four.meme/meme-api/v1/public/config` 在 `2026-11-16T12:40:08Z` 失败为 HTTP 403；最近成功是 `2026-11-15T11:35:05.946Z`，单次连续失败，退避 900 秒、下一次应于 `12:55:08Z` 后重试。约 12:45Z 聚合状态仍为 `partial`；期间其他文档/首页抓取成功不能清除这个 endpoint-specific 状态。故该接口提供的 quote-token/config 能力数据可能已陈旧。本次没有把该 403 解释为交易接口不可用。
- Four.Meme 页面观察器仍有 6 条较早（2026-10-23 至 2026-11-01）正文摘要变化处于 `pending_verification`；本轮没有新增正文变化，但其中的旧差异不能据此视为已核验。10 个跟踪页面中有历史失败页面，公告当前内容覆盖仍不完整。
- [Flap Agent Skills](https://docs.flap.sh/en/flap/v2/developers/agent-skills)、[Apps](https://docs.flap.sh/en/flap/v2/developers/flap-apps) 与 [FSI](https://docs.flap.sh/en/flap/v2/developers/flap-infrastructures/flap-shared-indexer)：直连均返回 HTTP 200；来源聚合仍 `partial`，既知问题包括 sitemap 404 和 Flap board/morph-board 403。本轮没有新协议正文变化被确认。
- [HyperEVM 概览](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm) 和 [JSON-RPC 文档](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/hyperevm/json-rpc)：本轮直连 HTTP 200；本地概览正文最近尝试于 12:44Z，未记录正文变化。JSON-RPC 子页的本地页面观察器在 12:40Z 标为失败，但 aggregate health 于 12:41Z 为 healthy，单次直连也返回 HTTP 200；这是观察器/传输状态不一致，需后续样本确认。此前官方记录仍为主网 999、测试网 998、原生 gas HYPE；本轮无新链或路由变化。

## 本地影响与边界

- 未发现新的上游 main/ref 变化映射到本地买入或卖出路径；没有交易构造、安全门槛、授权、滑点、nonce/pending、失败重试或链路的新增兼容差异证据。
- 本项目远端 main 仍是 `96f13fb6321ed6195c7363bbdea0093d8a3ad3d1`；本地工作树有大量既存改动，且运行中服务 revision 未验证。本轮仅做只读 source/snapshot 对照，不将远端 main 等同于实际运行版本。
- 未运行测试：无新的 main 交易行为需要做兼容测试；本轮的直接 HTTP 检查与 refs 比对不触碰钱包或交易执行。
- 未连接钱包、未读取秘密或 `.env`、未签名/广播/下单、未改代码/配置/策略、未部署/重启、未 push/merge。

## 覆盖缺口与后续

下一次应观察 12:55Z 后 public-config 自动退避是否解除，并确认关键 quote/config 内容是否恢复；如仍连续受限，需人工检查获准的公开来源或 collector 状态，不要绕过访问控制。若 HyperEVM JSON-RPC 子页仍被标为失败，也应核查页面观察器状态与直接 200 的差异。当前证据不验证实盘交易是否可用，也不证明任何 CA 可交易。
