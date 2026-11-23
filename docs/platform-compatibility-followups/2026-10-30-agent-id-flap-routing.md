# Agentic Wallet / Four.Meme / Flap 兼容性增量复核

- 检查时间：2026-10-29 17:41:55 UTC（2026-10-30 Asia/Shanghai 本地日期）
- 上次检查点：未找到 `data/platform-compatibility-monitor-state.json`，因此本次作为新基线；不推断此前持续在线。
- 模式：只读上游仓库/官方文档检查 + 本地静态兼容性对照。未连接钱包、读取秘密、签名、广播、交易、改策略或部署。
- 工作区：请求目录 `/Users/qohfq/Documents/Playground/robinhood-chain-monitor` 的 `main` 分支当时为 ahead 1 / behind 19 且含未提交改动；该 checkout 没有 `apps/agentic-wallet-dashboard`。兼容性对照使用 GitHub main 合并提交 `bb559cd5316090c37a578f56c2f5fe4655f09ee1` 及干净功能工作树 `/private/tmp/robinhood-chain-monitor-wallet-mint-swap-20261029`。没有覆盖或清理脏工作区。

## 上游变化与归属

| 来源 | 官方归属 | 本次相关变化 |
|---|---|---|
| [Binance skills hub commit 96563da](https://github.com/binance/binance-skills-hub/commit/96563daf34fa5a87af5d76c2f1107d697ae7ce07) | 已由 [Binance Developer Docs](https://developers.binance.com/en/docs/products/agentic-wallet/welcome) 指向该仓库 | 2026-10-26 更新至 Agentic Wallet skill 1.15.0，要求 CLI 1.12.0；调整 Agent ID 独占代币、market/limit order 路由指引。BSC CA 后缀 `4444`/`ffff` 只作为调用 `agent-id-exclusive-token-launches.mjs info` 的发现线索，不单独证明代币独占。若路由识别为 Agent ID 独占 inner curve 且需 `contract-call`，不能套普通 market/limit order；暂停/迁移中按官方路由等待，禁止盲试。
| [Four.Meme official Agentic page](https://www.four.meme/en/agentic) / [four-meme-ai commit 0a07b65](https://github.com/four-meme-community/four-meme-ai/commit/0a07b65468caa73f552dd6a13013ef5071065996) | 官方页面直接链接仓库，归属已确认 | 2026-10-25 发布 1.0.9。此前 2026-10-24 的 `f37aab9` 移除脚本 shell execution；当前钱包 dashboard 未见依赖该 CLI，故没有证据显示本地交易链路被该提交直接影响。
| [Four.Meme docs commit 5f7f589](https://github.com/four-meme-community/fourmeme-docs/commit/5f7f589b042e4e3b41c2c214d0fe3a81b36725a9) | 归属已确认 | 最新相关资料仍为 2026-08-18；本次未发现更晚相关规则更新。
| [OpenFour docs commit 6e1b1c3](https://github.com/four-meme-community/openfour-docs/commit/6e1b1c3a3c77be383784e23f5f01198d34690f1e) | 官方反向链接未验证；按社区参考而非平台规则 | 2026-10-24 新增 Agent ID Exclusive 指引。其迁移前/后交易差异仅作为线索；与 Binance 官方 skill 交叉核对，不据此单独作平台规则结论。
| [Flap skills commit 07fee4b](https://github.com/flap-sh/flap-skills/commit/07fee4b49dc7d6c9a04a8e754051aa0a258f8d0a) | [Flap 官方 Skills 文档](https://docs.flap.sh/flap/skills) 指向该仓库，归属已确认 | 2026-10-27 新增 `launch-bnb-token-on-flap` 与 `trade-flap-token`。当前 launch 指引为 Tax Token V3 / `Portal.newTokenV6` 或 `VaultPortal.newTokenV6WithVault`，quote token 来自动态列表；非原生 ERC-20 quote 要窄范围授权。交易分标准内盘、Agent ID gate 内盘、毕业后 market-order 三路。skill 提示报价/请求约 60 秒有效，过期应重新报价；不可盲目重试。Flap 文档提到 BAW 模拟器内部约 5M gas ceiling，revert 只作为错误诊断，不构成绕过模拟/安全检查的理由。

## 本地影响对照

检查对象是 GitHub 合并后的 `apps/agentic-wallet-dashboard`，但当前请求目录的脏 `main` checkout 尚未包含该目录，因此下列本地代码结论来自独立干净功能工作树，不能表述为已同步到此 checkout。

1. **Binance Agent ID 路由缺口（高）**：dashboard 静态检索未发现 `agent-id-exclusive`、`nftGate`、`migrateStatus`、`4444`、`ffff` 等路由识别/处理。当前通用 BSC market-order 不足以处理某些迁移前 Agent ID 独占 inner-curve 路由，可能无法成交或走错执行路径。不能仅按 suffix 自动放行；必须先读官方 `info` 路由，再选择普通 swap、精确 Portal contract-call 或 fail-closed 等待。
2. **Flap 内盘/毕业路由缺口（高）**：Flap 当前技能要求按代币状态在普通 inner curve、Agent ID gated curve、毕业后市场单间分流。dashboard 未见对应 route-aware 检查/调度；仅有通用市场单会漏掉前两类专属路由。
3. **Flap Mint 版本兼容未验证（高）**：`server/flap-mint.mjs` 固定 BSC 56、Portal 地址 `0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0`、selector `2ca9cd6d`（Standard）。与当前官方 Tax Token V3 / `newTokenV6` 指引不一致，且未做链上 ABI/部署版本核验；因此标记为兼容性未验证，不宣称地址必然错误或所有 mint 失败。
4. **SDK/CLI 版本差距（中）**：dashboard package/README 固定 `@binance/agentic-wallet@1.11.0`，而最新 skill 要求 CLI 1.12.0。需做升级兼容验证，不能在本轮直接升级。
5. **自定义合约安全边界**：`server/custom-contract-call.mjs` 保持模拟成功、目标/调用值校验，并阻断权限/allowance 变更及高权限方法。此 fail-closed 是保护措施，不应为追求“所有 CA 都能买卖”而放宽；税费、黑名单、暂停、流动性与合约自定义限制仍可能令交易不可执行。

## 验证与覆盖范围

- 本轮未运行测试（目标 checkout 缺 dashboard 目录，干净功能树也只做静态代码对照）；没有 RPC、链上调用或部署 ABI 验证。
- 未改代码，未更改风险门槛、滑点、授权、签名或广播行为。
- 当前结论是明确的**路由覆盖缺口 / 版本兼容待验证**，不是“资产一定不能交易”的链上复现，也不是“所有 CA 可交易”的承诺。

## 建议的最小待审修复

1. 增加明确的路由探测结果类型：`standard_curve`、`agent_id_exclusive_curve`、`graduated_dex`、`migrating_or_paused`、`unsupported_or_unknown`；unknown/error 必须拒绝执行。
2. 按平台官方 skill 实现独立适配器：Agent ID exclusive Portal 精确调用、Flap 标准/Agent ID 内盘、毕业后市场单。CA 后缀只触发探测，不能作为授权依据。
3. 将 Flap mint 升级作为单独待审工作：验证当前 Tax Token V3 ABI、动态 quote 列表、最小成交/精度、窄额授权、估价 freshness 和 gas；在通过离线 fixture 与官方 simulator 前不替换现有路径。
4. 添加离线 fixture 覆盖：标准曲线、独占曲线、迁移/暂停、毕业代币、过期报价、未知 selector、税费/卖出模拟失败、nonce/pending 状态未知。买入与卖出都须验证失败关闭和状态一致性。

这些修改涉及交易构造/批准/调用路径，应作为独立代码补丁审查并测试；本自动化不实施、不推送、不部署。

## 2026-10-29T21:39:26.759Z 后续增量检查

- 对比上一检查 `2026-10-29T17:41:55.742Z`：Binance skills hub、Four.Meme AI、Four.Meme docs、OpenFour docs、Flap skills 的可见最新相关提交 SHA 均未变化；GitHub 项目 `main` 仍为 `bb559cd5316090c37a578f56c2f5fe4655f09ee1`。
- Binance 当前官方 `SKILL.md` 再次确认版本 1.15.0 / CLI 要求 1.12.0；未发现本次轮询新增的交易路由规则。上次报告中的 Agent ID 路由缺口、Flap V3 兼容未验证与 SDK/CLI 版本差距仍未解决。
- 请求目录工作区仍为脏且落后，钱包 dashboard 目录仍不在该 checkout；没有改写或清理用户文件，也没有进行链上/RPC 检查。
- 本轮无新增上游或兼容性变化，保持上轮结论；下次检查不早于 `2026-10-30T01:39:26.759Z`。结构化状态见 `data/platform-compatibility-monitor-state.json`。

## 2026-10-30T01:43:57.344Z 后续增量检查

- 对比上一检查 `2026-10-29T21:39:26.759Z`，五个上游仓库最新相关 SHA 未变；项目 GitHub `main` 仍为 `bb559cd5316090c37a578f56c2f5fe4655f09ee1`。
- Binance 官方 skill 文件仍为 1.15.0 / CLI 1.12.0 要求；`wallet agent-id` 和 Agent ID exclusive 路由说明未发生新增变化。Flap Skills 与 Four.Meme/OpenFour 相关 commit 也无增量。
- 本地 checkout 仍 dirty 且 ahead 1 / behind 19，dashboard 路径缺失；本轮没有本地代码变化，没有链上/RPC 验证。
- 本轮无新增证据；既有 Agent ID 路由缺口、Flap V3 兼容未验证和 CLI 版本差距仍待单独审查，不需要因本轮触发人工动作。下次检查不早于 `2026-10-30T05:43:57.344Z`。

## 检查点

结构化上游版本、缺口 ID、下一检查问题及观察限制见 [`data/platform-compatibility-monitor-state.json`](../../data/platform-compatibility-monitor-state.json)。

## 2026-10-30T09:40:03Z 后续增量检查

- 对比上次检查 `2026-10-30T01:43:57.344Z`：Binance Skills Hub `main` 仍为 `96563daf34fa5a87af5d76c2f1107d697ae7ce07`，其中 Agentic Wallet skill 的相关 release commit 仍为 `aa627bdb0cfddde85f38d2339361f3ca4b7bf3d8`；Four.Meme AI (`0a07b65`)、Four.Meme docs (`5f7f589`)、OpenFour docs (`6e1b1c3`) 与 Flap skills (`07fee4b`) 的相关 HEAD 均未变化。OpenFour 仍属未验证官方归属的社区参考。
- 官方 Binance Developer Docs 目前标注 Agentic Wallet 支持 BSC 56、Ethereum 1、Base 8453、Solana `CT_501`；技能参考说明 market swap 有自定义滑点/MEV 选项，limit order 仅列 BSC 与 Solana。当前 dashboard 的 swap 构造显式传滑点和 `--mev true`；本轮未发现新本地交易路由回归。文档页面标注 2026-10-30 更新，但其能力范围与既有 skill/本地实现的检查点一致，不能据“更新日期”推断新链或新 ABI。
- 新发现 Binance 官方仓库中的 [Issue #395](https://github.com/binance/binance-skills-hub/issues/395)：报告称 2026-10-28 Agentic Wallet App recovery/sign-in 路径遇到过期 x509 证书，作者使用 CLI 1.12.0；截至本次读取仍为 open，更新时间 2026-10-29 22:07:37Z。它是官方仓库中的用户报告，并非 Binance 已确认的根因或公告，也不证明当前仍在故障；本地配对/登录未尝试。由于本地 dashboard 依赖 `baw auth signin`，若同类错误复现会阻断连接并进而阻断所有需要钱包的交易路径。当前 dashboard 包版本仍 pin `@binance/agentic-wallet` 1.11.0，而官方 skill 要求 CLI 1.12.0；不能假定单纯升级可消除此报告，因为报告本身来自 1.12.0。
- 对照另两项已公开 issue：[#375](https://github.com/binance/binance-skills-hub/issues/375) 描述 view call 预览可能假报成功；本地 custom call parser 明确拒绝 `view`/`pure`，故该具体复现面被挡在 CLI 预览前。[#381](https://github.com/binance/binance-skills-hub/issues/381) 报告 CLI raw calldata 验证问题；本地 UI 通过 ABI 与规范函数签名用 ethers 生成 calldata，不直接信任任意输入 calldata。均为 open 报告，不是平台确认；仍不能据离线测试证明链上预览一定正确。
- 在干净功能工作树 `codex/agentic-wallet-mint-ui`（HEAD `77144d4160d251857bc03805e05504ebd0b6f2d7`，无未提交改动）运行 `node --test tests/custom-contract-call.test.mjs tests/custom-contract-route.test.mjs`：8/8 通过，覆盖 view/特权函数阻断、simulation fail-closed、目标/权限/授权差异阻断与路由会话门槛。当前请求 checkout 是用户有改动的 `codex/paper-focus-forward-simulation`，其中 dashboard 路径不存在；保持未触碰。
- 未连接钱包、未读秘密、未跑 CLI auth、未做 RPC/链上调用、未签名/广播/交易。最重要的待观察点是上游 #395 是否被关闭或修复，以及 CLI 版本差距；本地认证表现仍待用户真实遇到时凭不含凭据的错误信息核验。既有 Agent ID 路由与 Flap Tax Token V3/交易路由缺口保持未解决。

官方来源：[Binance Agentic Wallet overview](https://developers.binance.com/en/docs/products/agentic-wallet/welcome)、[skills reference](https://developers.binance.com/en/docs/products/agentic-wallet/reference/skills)、[issue #395](https://github.com/binance/binance-skills-hub/issues/395)、[issue #375](https://github.com/binance/binance-skills-hub/issues/375)、[issue #381](https://github.com/binance/binance-skills-hub/issues/381)。

## 2026-10-30T13:47:59.257Z 后续增量检查

- 对比 `2026-10-30T09:40:03.839Z`：Binance Skills Hub（含 Agentic Wallet skill）、Four.Meme AI、Four.Meme docs、OpenFour docs、Flap skills 的最新可见提交 SHA 均未变化；GitHub 项目 `main` 仍为 `bb559cd5316090c37a578f56c2f5fe4655f09ee1`。OpenFour 仍按社区参考处理，未发现官方反向链接。
- 官方 Binance 文档仍列 BSC、Ethereum、Base、Solana 四条支持链；Flap 官方 skills 页面仍标示 Tax Token V3 与动态 quote token；Four.Meme 官方 Agentic 页面仍定位为可由通用 agent 使用的 skill，而非 Agentic Wallet 独占规则。
- GitHub issue [#395](https://github.com/binance/binance-skills-hub/issues/395) 仍 open，最后更新时间仍为 `2026-10-29T22:07:37Z`；[#375](https://github.com/binance/binance-skills-hub/issues/375) 与 [#381](https://github.com/binance/binance-skills-hub/issues/381) 也仍 open。它们仍是仓库中的用户报告，不是平台确认根因；未尝试登录或在线配对。
- 本地新增 [Flap v5.27.2 兼容性证据](./flap-v5272-compatibility-evidence-2026-10-30.md) 并在 `src/flap-portal-pins.js` 增加当前 v5.27.2 身份窗口，同时保留 v5.26 历史区间。证据文件记录 Chainstack/Sentio 对升级回执与区块哈希的一致性；本轮没有重新查询 RPC。`node --test test/flap-portal-pins.test.js` 在当前工作区 3/3 通过，验证窗口边界与不完整/拼接身份拒绝。
- 这只改善 Portal 实现版本识别/状态迁移证据，不验证 Flap V3 Mint selector、Agent ID 路由、实际买卖 ABI 或交易可执行性；此前 Flap 内盘分流和 Binance CLI 版本差距仍未解决。本检查没有改应用代码、连钱包、读秘密、签名、广播或交易。
- 当前 checkout 保持脏工作区；上述 v5.27.2 文件属于本地工作区变化，本检查未提交或推送。详见 [`data/platform-compatibility-monitor-state.json`](../../data/platform-compatibility-monitor-state.json)。下一检查不早于 `2026-10-30T17:47:59.257Z`。

## 2026-10-30T21:43:31.218Z 后续增量检查

- Binance Skills Hub、Four.Meme AI、Four.Meme docs、OpenFour docs、Flap skills 及本项目 GitHub `main` 的远端 `main` 分支 SHA 与上一检查点相同；因此没有发现新的已合并上游交易/链支持规则。官方归属仍与上一节记录一致：Binance/Four.Meme/Flap 官方站点指向各自资料；OpenFour 仍未验证官方归属，按社区参考处理。
- Binance 官方文档当前仍列 BSC、Ethereum、Base、Solana；Flap 官方 Skills 仍说明 Tax Token V3 与动态 quote token；Four.Meme 官方 Agentic 页面仍描述通用 Agent Skill。页面检查未发现影响本地交易路由的新规则。
- 新发现 Binance 官方仓库 issue [#402](https://github.com/binance/binance-skills-hub/issues/402)：用户报告 CLI 1.12.0 在 App 确认配对后，`baw auth verify` 返回 `SERVICE_ERROR` code 2 / `illegal parameter`，钱包保持 `UNCONNECTED`。页面显示 issue 为 open。报告仅记录一次尝试，未确认根因或可重复性；它是外部用户报告，不是 Binance 已确认故障。由于本地钱包功能依赖认证，若此错误在目标环境复现，会阻断所有需要已连接钱包的操作；但本轮没有进行登录、重试或本地复现，也未读取认证信息。
- 同一官方仓库中 [#390](https://github.com/binance/binance-skills-hub/issues/390) 报告受限 Linux 环境的 `os.networkInterfaces()` 失败，导致配对码生成前即中断；[#395](https://github.com/binance/binance-skills-hub/issues/395) 报告恢复/登录证书过期；[#400](https://github.com/binance/binance-skills-hub/issues/400) 报告某 dApp 的 EIP-712 `sign-message preview` 不支持。页面均显示 open。它们是不同阶段、不同环境的问题；#400 并非 swap 买卖失败证据，不应合并成单一根因。
- #375/#381 的 contract-call preview/InputData 报告仍 open。既有离线测试只能说明本地解析/限制逻辑，不能证明上游模拟器或真实链调用正确。Flap v5.27.2 本地识别窗口测试仍为上一轮 3/3；此次未因未变更而重复运行。
- 方法与限制：GitHub REST API 本轮连接失败；改由 `git ls-remote` 核实各仓库 `main` SHA，并用可访问的官方文档及 GitHub issue 页面核对规则和问题状态。没有钱包连接、认证、签名、RPC 或链上检查；本项目 checkout 继续保持未触碰的脏工作区。
- 结构化状态及下一检查项见 [`data/platform-compatibility-monitor-state.json`](../../data/platform-compatibility-monitor-state.json)。下一检查不早于 `2026-10-31T01:43:31.218Z`。
