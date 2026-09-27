# GIWA 生态监控（2026-09-27）

本次只增加监控，不启用 GIWA 模拟单、实盘、签名或跨链。既有 TG/FOMO/交易进程不重启。

## 15:18 官方公告复核与扩容

2026-09-27 北京时间 14:09、15:18，GIWA 官方账号连续声明主网尚未上线，否认主网 RPC 公开/泄露传闻。通过 X 官方 oEmbed 接口复核作者、原文、帖子 ID；主页 `giwa.io/home` 直接链接该账号。原文：

- https://x.com/GIWA_by_Upbit/status/2104091017901433017
- https://x.com/GIWA_by_Upbit/status/2104108336228843590

当前扩至 **18 个来源、11 个平台**（含尚未开放及访问异常的平台）。新增 Lucrari 官网/文档、HAMR、CookHouse、GAMA、Kachi、GIWA 官方 GASOK 页面和官方 X。平台登记不代表已部署或正常覆盖。

官方 X 通过固定数值 ID 获取帖子线索，再以 X 官方 oEmbed 校验作者、URL、原文；镜像文字不作为播报原文。保留近三条作者本人帖子，排除转推，首次仅建立基线。网页增加测试网/演示/即将上线阶段标识变化检测；示例成交不进入真实行情或交易系统。

新增平台状态（核对时）：Lucrari 明示测试网；HAMR 官网显示 Robinhood，GIWA 待核验；CookHouse 明示 preview/mock；GAMA 是候补名单；Kachi 是 Coming soon 并返回 HTTP 503（记 degraded，不能冒充在线）。社区入口未验证的名单还剩 7 项；MAPAE 与 mapae.io 是不同项目，不混用。

## 第一轮已接入与未覆盖

- 10 个公共来源：GIWA 官网和网络文档；GIWA.MARKETS 官网及部署说明；Gasok 官网及网络说明；Joseon.fun、GAZUA、MemeFab 官网；Vezta 发射台文档（访问失败时明确记为 degraded）。
- 上述对应 6 个平台，不代表 GIWA 全部发射台。9 个社区发现线索保存在 `GIWA_PENDING_LEADS`，尚未验证，不计作覆盖。
- 官网每 90 秒检查；首轮只建立基线，后续标题/说明、官方主网说明、地址/链接、前端部署文件变化才发中文 TG。前端文件变化不是交易开放证明。
- 公共测试网 RPC 每 10 分钟仅做 chainId、区块、两家已公开合约代码健康检查。该 RPC 官方注明限流且不适合生产，因此不拿它做高频全链扫描。
- **未接入全链发币/交易事件扫描**。目前官方文档仍为 GIWA Sepolia `91342`，主网参数未核实。第三方 JS 中的主网预设值不能作为权威链 ID。
- GIWA.MARKETS 的 Robinhood 链代币/部署，不会因名称含 GIWA 就归入 GIWA 网络。

## 后台与恢复

`npm run monitor:giwa` 启动独立进程，读取既有 Telegram 配置。状态和耐久发件箱独立放在 `data/giwa-monitor/`，不污染主监控游标。`runtime-heartbeat.json` 每 30 秒更新。

`npm run monitor:giwa -- --once --no-send` 做独立临时目录只读诊断，不推进生产基线，不发送 TG。诊断目录保留供检查。

macOS 服务：`com.qohfq.giwa-monitor`。本机 `127.0.0.1:19134` 是内核级单实例占位端口，不提供 HTTP 或钱包 API。启停该服务不影响既有服务。

HTTP 失败指数退避、保留上一份有效快照。变化与游标先原子持久化，再投递；发送失败由独立 outbox 重试。事件绑定注册源 URL、前后快照、变化明细和固定中文卡片。无变化不发消息；不定时唤醒 AI。

## 开通主网扫描前必须补齐

1. GIWA 官方上线公告、准确 chainId、生产 RPC / explorer。
2. 每个平台的主网 factory 地址、ABI/创建事件、部署区块及链上代码校验。
3. 接入日志扫描、断线回补、重组/去重测试；公开来源清单不能冒充“全链覆盖”。

核对来源：<https://docs.giwa.io/giwa-chain/en/get-started/connect-to-giwa>、<https://giwa.io/home>、<https://github.com/giupy997/launch-pad>、<https://gasok.fun/terms>。
