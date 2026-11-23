# 项目主分支叙事狙击变更复核 — 2026-11-06 14:32 UTC

## 结论

项目 GitHub `main` 新增了一条可进入 GMGN 下单路径的叙事狙击实现。当前重点风险是 He Yi 的无关引用帖可能被错误关联到最近七天内 CZ 的任意短帖；本次测试明确把 He Yi 引用 Elon Musk 的问题贴关联到 CZ 回复的数字 `4`。此外，未配置或填入非法 gas 等级时默认使用 `turbo`。这些属于本项目变更，不是 Binance、Four.Meme 或 Flap 上游规则更新。

本地工作区的三个相关源码/测试 blob 与新 GitHub commit 完全相同，但本地 HEAD 仍为旧提交，且工作区有大量既存 staged、unstaged 和 untracked 改动。是否有外部运行器正在加载该代码、是否已经发生实际 LIVE 下单，当前无法从此检查确认。发现模块内有真实 GMGN 调用能力，但在本次检索范围（`src/`、`scripts/`、`dashboard/`、`package.json`）未找到生产启动入口；外部启动器/部署配置不在已验证范围。

## 上游与本地版本

检查时间：2026-11-06 14:19–14:33 UTC；六个只读 `git ls-remote` 检查均成功。

- Binance skills hub：`96563daf34fa5a87af5d76c2f1107d697ae7ce07`，未变化。
- Four.Meme AI：`0a07b65468caa73f552dd6a13013ef5071065996`，未变化。
- Four.Meme docs：`5f7f589b042e4e3b41c2c214d0fe3a81b36725a9`，未变化。
- OpenFour community docs：`6f7efd5d3f14ed280cf471f70675ffba6d319943`，未变化；仍按 community/reference 对待，未确认官方背书。
- Flap skills：`07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a`，未变化。
- 项目 `yespsam/robinhood-chain-monitor` `main` 从 `12316231628f6efd5a2b477138dc8f2b8e33887e` 前进至 `ab1456672a9dc44504616d390db6f4f082a6f6b9`。

项目提交：[ab145667](https://github.com/yespsam/robinhood-chain-monitor/commit/ab1456672a9dc44504616d390db6f4f082a6f6b9)，标题 `Record every He Yi and CZ post and snipe their memes with turbo gas. (#8)`，提交时间为 2026-11-06 10:22 UTC。改动涉及 `.env.example`、`dashboard/fast-devs.js`、`src/hot-narrative-record.js`、`src/narrative-live-sniper.js` 和 `test/narrative-live-sniper.test.js`。本地三个相关文件的 Git blob SHA 与该 commit 对应版本一致：

| 文件 | 本地/远端 blob SHA | 结果 |
| --- | --- | --- |
| `src/hot-narrative-record.js` | `722ffb9efb6365e188e543dfbe564f983577fb1d` | 一致 |
| `src/narrative-live-sniper.js` | `a0cf03f8bc9350f9061f8fcc7dc4a1f25ce0f62c` | 一致 |
| `test/narrative-live-sniper.test.js` | `f080f1067f0bbe11db8b3849c96079b31c403f4e` | 一致 |

## LIVE 信号与成本风险

1. `linkCzMeme()` 在引用帖没有自身 meme/ticker、也没有与先前 CZ 贴文关键词命中时，会退回选择七天窗口内最近的 CZ 短帖。测试中 CZ 回复 `4`，随后 He Yi 引用 Elon Musk 的 “Which colored pill do you choose?”，测试仍断言 `linkedKeyword === "4"`。引用作者是 Elon Musk，正文也没有 `4`；这是内容关联证据不足导致的确定性误配，不是推测。短数字或普通词成为候选会扩大误配面。
2. 本地同一测试显示该错误关联会生成热点。若随后存在符合其余 LIVE 门槛的 token/CA，该逻辑可能把不相关叙事当成买入线索。此处只确认误配信号，不推断已经产生订单或亏损。
3. gas 级别在配置缺失/无效时默认为 `turbo`：BSC 5 gwei 与 0.002 BNB tip；Solana priority fee 与 tip 各 0.002 SOL。`normal` 和 `high` 也可选，但不是缺省。固定买入滑点为 1%，票面使用固定 10U 基准；本次没有实时费用/余额数据，不能计算实际成本或断言下单成功。
4. `createNarrativeLiveRuntime` 内存在调用 GMGN CLI 的实际下单实现。测试为 mock/offline，不验证生产启用状态，也不证明资产/代币安全或成交能力。

建议的最小待审修复：删除“最近 CZ 短帖”兜底，只在引用作者明确为 CZ 或帖子正文/链接具备可验证的精确关联时建立联系；为数字、功能词和极短词提高歧义门槛，并增加无关引用的负向测试。gas 缺省应避免隐式 turbo，并要求显式、受边界验证的配置/报价。交易路径相关代码不得由此心跳自动修改、启用或部署。

## 平台来源健康与兼容性范围

六个上游仓库 ref 未变化；本次没有证据显示 Binance、Four.Meme 或 Flap 上游交易接口/规则发生变化。平台状态文件在 14:33 UTC 记录 Flap 5/5 与 Four.Meme 13/13 结构化来源为 degraded，失败类型为 transport/timeout；跟踪页为 Flap 59/59、Four.Meme 10/10 failed。最近成功时间分别为 Flap 11:50:10 UTC、Four.Meme 12:54:22 UTC。此问题表现为本地/采集请求超时，但根因尚未定位。

独立只读抽样中，`https://docs.flap.sh/en/flap/developers`、`https://flap.sh/board` 与 Four.Meme OpenFour 集成 canonical 页返回 HTTP 200；Four.Meme 根路径返回 302。单次 200 只证明这些端点在本次抽样可访问，不代表全量 watcher 正常，也不据此确认页面内容没有变化。此前已记录的 Flap locale canonical allowlist 和 Four.Meme 路径重定向缺口继续保留。

## 验证与操作边界

- `node --test test/narrative-live-sniper.test.js`：10 passed、0 failed。覆盖是本地 fixture/mock 测试，其中一个通过测试恰好编码了上述错误关联。
- 直接调用 `linkCzMeme()` 的离线复现返回 `{"hotspotId":"cz-unrelated-4","keyword":"4","author":"cz_binance"}`。
- 本次只读了公共 Git refs/patch、仓库源码与公开页面；未读取 `.env` 或秘密配置，未连接钱包、签名、广播、买卖、部署、重启、push 或 merge。未修改交易源码或策略。

人工需确认该新 LIVE 信号是否被外部运行器启用；在误关联逻辑经审查和负向测试修正前，不应把该测试结果当作有效叙事信号或策略验证。当前实际 runtime revision、环境配置和订单状态均为未知。
