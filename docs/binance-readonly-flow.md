# 币安只读资金流接入

## 范围

2026-09-22 接入公开逐笔数据，保留 GMGN 盈利画像和原模拟策略。全程无钱包登录、私钥、签名、广播或实盘执行，也不使用币安广场凭证。

端点来自官方 `@binance/agentic-wallet@1.10.0` 的公开追踪实现，仅开放以下查询：

`POST https://www.binance.com/bapi/defi/v1/public/wallet-direct/tracker/wallet/address/query`

请求仅包括 `chainId`、`tagType`（聪明钱 2 / KOL 1）、`enableFilterRiskTokens: false`。保留风险相关交易是为了不把被过滤的卖出误认为不存在，合约筛选仍在独立策略入口执行。HTTP 明确不带凭证、不跟随重定向，十秒超时，最大回包 4 MiB。

## 实测与能力边界

- Robinhood 4663、Solana CT_501、BSC 56、Base 8453、Ethereum 1 的公开查询均实测成功。
- 上线时 Robinhood 聪明钱逐笔返回空列表，KOL 有实际记录。空列表保持“暂无可验证记录”，不宣称该来源窗口完整。
- 最新页最多观察到 80 条，接口没有游标；通过持续重叠轮询保留观察窗口，不声称取得全历史或全链数据。
- `ts` 使用秒；交易身份使用链 + `txHash` + `logId`。只解释 11/19 为买入，21/29 为卖出；100001/100002 等未确认类型不猜测语义，而是隔离该币直到相关窗口过期。
- 这里只使用逐笔查询，**没有把 Smart Money 信号状态推送接入成交统计**；重复 `signalId` 更新不是新买单。

## 运行、状态与恢复

- 与 `src/fomo-worker.js` 同生命周期、同关闭流程，不启动另一个交易进程。主 GMGN 开启时默认启用，可通过 `BINANCE_FLOW_MONITOR_ENABLED=false` 关闭备用采集。
- 文件 `data/binance-flow-state.json`（0600）使用独立进程锁和原子写入。损坏文件不自动清空；错误不会写入 GMGN 状态或模拟账本。
- 秒级检查升级后每 2.5 秒尝试一个链的两类查询，Robinhood 与其他链交替：健康时重点链约五秒，其余各约二十秒；慢请求会增加周期。同一时刻只运行一个采集轮次，同一客户端请求至少间隔一秒。429 遵守 Retry-After；403/418 至少冷却十五分钟，冷却写盘并在重启后保留，不绕过限制。
- 五分钟连续窗口以本机首次成功采集为起点，保留十秒索引缓冲。超过九十秒、页断开、请求失败或进程重启会重新建立窗口。每类来源每链最多保留 4000 条、最近十分钟数据；本机截断影响窗口时拒绝完整标记。
- `GET /api/strategy-state` 的 `coverage.flow.sources` 展示三个独立来源状态；策略和买入证据记录 `provider`。来源不会加总，持仓不会用另一个来源确认撤退。
- 采集五条链不等于五条链都自动模拟开仓：当前统一模拟账户仍重点运行原有 Robinhood 策略，没有扩大交易范围。

## 验证

离线测试使用 `OFFLINE_FIXTURE` 和临时目录，包含重复日志、USD 修订、身份冲突、未知类型、源切换、空列表、重启/断档、限频持久化、无凭证请求、状态损坏以及模拟盘联动。2026-09-22 上线前全量 2551 项通过。

上线后于北京时间 2026-09-22 02:39 核验：五链十个采集通道均请求成功且数据新鲜，其中九个建立了连续五分钟观察窗口；Robinhood 聪明钱通道仍为空，继续标记未验证。模拟盘接口已采用可用的 Robinhood 币安 KOL 来源；这只代表该来源采集连续，不代表任意代币已满足开仓条件。此时模拟现金 100 美元、持仓 0、成交 0，页面账户与磁盘账本一致，执行/签名/广播均关闭。

上线前备份原模拟账本、GMGN 状态和冷却文件到 `/tmp/yesp-dual-flow-backup.TgGEqa`。这是临时备份，不保证永久保留；未重置任何原运行账本。

官方参考：[钱包追踪](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-wallet-tracker/SKILL.md)、[逐笔字段及推送语义](https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/binance-wallet-tracker/references/cli.md)。
