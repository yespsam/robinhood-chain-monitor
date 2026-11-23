# 证据分级成本预算 + 可追门控（2026-10-30）

仅影响 **paper 模拟主盘**；不开启 execution / signing / broadcast，不重置现金，不改历史账本。

## 改了什么
1. **无叙事出主盘**：主盘唯一记账入口（`advancePaperStrategyAccount`）新增 `paperChaseGate` 检查。
   叙事未达标（`narrativeAssessment.eligible!==true`、evidenceScore < 50 或独立出处 < 1）→ `shadow_only`，不占主盘现金。
   这对 `minimalEntryMode` 同样生效——最小门槛模式不再能绕过叙事旁路进主盘；exploratory 研究、影子/学习账本（`account.variant`）不受影响，可继续记录。
   说明：确认型 PVP 的 entryTier 一律是 `exploratory`，所以判断依据是叙事证据本身，而不是 tier 字符串。
2. **可追门控**：`canChaseBreakout = narrativeOk && controlOk`。
   突破类入场（无路由的确认型 PVP 追涨、`external_breakout`、`external_trend`）只有在叙事 + 控盘都达标时才允许进主盘；
   叙事达标但控盘不足/未知 → 只能做非突破路线（如回踩、事件），否则不进主盘。没有全局禁追高、没有用熔断当主手段。
3. **证据分级摩擦预算**（往返成本 / 单笔预算，Gas 口径沿用 `admissionCosts`）。

## 常量（`src/paper-chase-gate.js`、`src/paper-control-score.js`）
| 常量 | 值 | 含义 |
|---|---|---|
| `NARRATIVE_MEDIUM_MIN_SCORE` | 50 | 叙事 evidenceScore 下限 |
| `NARRATIVE_MEDIUM_MIN_SOURCES` | 1 | 独立出处下限 |
| `FRICTION_BUDGET.shadow_only` | 0 | 弱证据：主盘预算 0 |
| `FRICTION_BUDGET.base` | 4% | 叙事达标、控盘未达标 |
| `FRICTION_BUDGET.chase` | 8% | 叙事 + 控盘齐，可追突破 |
| `CHAIN_FRICTION_BONUS.bsc` | +1% | BSC 中位成本更高 |
| `CONTROL_TOP10_BAND` | 25%–60% | Top10 控盘加分区间（>60% 仍由安全策略拦截） |
| `CONTROL_MAX_BUNDLER_RATE` / `CONTROL_MAX_DEV_RATE` | 30% / 20% | 打包 / 开发持仓可接受上限 |
| `CONTROL_MIN_NET_BUY_USD` / `CONTROL_MIN_BUYERS` | $500 / 2 | 净买入一致性 |
| `CONTROL_OK_SCORE` | 60 | 控盘分达标线（且必须在 Top10 区间内） |

控盘分缺 Top10 字段时为 `unknown`，不假装控盘。主盘成交会把 `chaseGate`（tier、预算、成本率、叙事/控盘明细）写进 `entryEvidence`，便于之后按档复盘期望值再调参。

## 开关
- 引擎/运行时参数 `evidenceTierGate`（默认 false，保持旧测试与旧调用不变）。
- `scripts/dashboard-server.js` 默认开启：`PAPER_EVIDENCE_TIER_GATE=0` 可回退旧行为。

## 如何验证
```
node --test test/paper-chase-gate.test.js test/paper-strategy-engine.test.js test/paper-confirmed-policy.test.js test/paper-strategy-runtime.test.js test/paper-cost-policy.test.js
```
需要 Node ≥ 22（依赖 `node:sqlite`）。

## 已知后续
- 被拒的主盘候选目前只是不成交，尚未单独写入影子账本条目；可在 runtime 层把 `chaseGate.shadowOnly` 的行转发到 narrative-shadow-ledger。
- 阈值是初值，需要跑一段时间后按 tier 统计扣成本期望再调。
