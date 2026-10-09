# 100 美元纸面交易脚本

这是一个隔离的纸面实验账户，不连接钱包，不签名、不发送链上交易，不保证盈利。默认仅观察真实监控事件；不会把 GMGN 标签当成安全审查，也不会使用演示 fixture 自动开仓。

## 使用

```sh
node scripts/paper-100.js --once
node scripts/paper-100.js --status
```

`--once` 是默认行为，读取现有 GMGN 播报事件并把观察结论写入独立账户。不开启 `--live-quotes` 时不访问网络。`--status` 只读取已有状态，不创建目录、锁或账户。

默认输入为项目 `data/alert-outbox.json` 和 `data/fomo-alerts/alert-outbox.json`。可用 `--main-outbox`、`--fomo-outbox`，或显式环境变量 `PAPER_100_MAIN_OUTBOX`、`PAPER_100_FOMO_OUTBOX` 修改；脚本不加载整个监控 `.env`。

默认输出目录：项目相邻的 `../robinhood-chain-monitor-paper-100`。账户及观察记录位于 `paper-100-state.json`，文件权限 `0600`，原子替换并执行 fsync。`--data-dir` 或 `PAPER_100_DATA_DIR` 可指定其他隔离目录。输出不能包含或位于生产数据/输入文件目录，路径不能经由符号链接。

## 固定实验规则

| 项目 | 规则 |
| --- | --- |
| 初始现金 | $100，仅首次建账；恢复状态不会充值 |
| 每次模拟买入 | $10 + 假设入场 gas $0.20 |
| 同时持仓 | 最多 2 个；已有持仓未能新鲜估价时不新增 |
| 现金保留 | $20，并预留退出 gas |
| 费用假设 | AMM 报价已含池费；另外每边假设 gas $0.20、输出数量/价值再减 1% |
| 退出 | 按费用后实际观察报价，亏损 20%、盈利 40% 或持有 30 分钟触发 |
| 入场熔断 | 当日已实现亏损累计 $5，或总已实现亏损累计 $10 |

这些是未经收益验证的实验参数。Gas 和 1% 折减不是实际成交成本；止损不是成交保证。无法获得有效卖出报价时保持未估价持仓，不编造退出价格或盈利。利润、亏损、现金和待估价持仓分别显示。

当日亏损按 UTC 日界线累计。亏损额度仅暂停新入场，不是硬损失上限，也不会阻止已有持仓继续尝试退出；价格跳变或无法报价仍可能造成更大损失。

## 独立审查证据

常规 GMGN 事件没有完整的独立安全证据，因此默认结论为观察。仅通过 GMGN 的原始证据重算还不够：必须额外提供人工/独立研究形成的纸面审查文件。文件声明只是用户提供的审查记录，脚本不会声称已独立核实其中事实。

自动独立安全证据采集尚未实现。审查文件缺失、损坏或过期会阻止新入场，但不阻止已有持仓的只读估价与退出检查。

格式为：

```json
{
  "version": 1,
  "mode": "independent_paper_review",
  "reviewer": "审查者或研究记录标识",
  "reviewedAt": "实际审查时间，完整 ISO 时间戳",
  "reviews": [{
    "eventKey": "原始 GMGN eventKey",
    "eventDigest": "--once 结果给出的完整 eventDigest",
    "chainId": 56,
    "ca": "精确小写代币地址",
    "poolAddress": "精确小写池地址",
    "evidence": {
      "observedAt": "证据采集时间，完整 ISO 时间戳",
      "sourceUrls": ["https://可核查的证据来源"],
      "sellSimulationPassed": false,
      "contractControlsReviewed": false,
      "lpLockOrBurnVerified": false,
      "holderDistributionReviewed": false,
      "independentWalletClusterVerified": false,
      "buyTaxBps": null,
      "sellTaxBps": null,
      "liquidityUsd": null
    }
  }]
}
```

上面故意没有伪造通过项，不能直接用来开仓。仅在有出处且审查真实完成时填写字段。要求精确事件摘要、链、CA、池绑定；原信号在 5 分钟内，安全证据在 60 秒内，零买卖转账税、流动性至少 $25,000、全部安全核验明确通过。叙事仍采用原始事件中的有来源内容，项目自述和未知叙事不能通过入场门。

审查文件放在账户目录之外。来源 URL 仅作为可追溯证据，不由此脚本自动下载或执行。

## 可选实时只读报价

```sh
PAPER_100_BSC_RPC_URLS='https://你的第一个只读RPC,https://不同服务商的第二个只读RPC' \
  node scripts/paper-100.js --once --live-quotes --review-file /绝对路径/paper-review.json
```

只在完整审查通过的候选或已有持仓上请求报价。使用项目已有的严格只读报价模块，双 RPC 核验同一确认区块、池工厂、储备和 Chainlink；随后再次检查报价区块是否一致。RPC 分歧、报价超过 5 秒、身份不符或报价失败均不模拟成交。

已有持仓先重验原始入场报价的区块和哈希，再获取并核验新卖出报价。入场锚发生重组或无法确认时保留未定价状态，不产生纸面平仓或利润。

目前仅支持 BSC 的 PancakeSwap V2，报价币为 WBNB、USDT、USDC。其他 GMGN 链仍可显示观察结论，但不能假装已支持交易模拟。没有私钥、钱包导入、GMGN swap、代币授权或自动交易入口。

## GMGN 只读实时终端

本地页面可用真实 GMGN CLI 行情做观察和纸上成交演练：

```bash
gmgn-cli config --check
npm run dashboard
```

打开 `http://127.0.0.1:4173/` 后，排行来自 `market trending`，价格图来自 `market kline`；支持 BSC、Base、Ethereum、Solana 的链切换，以及排行窗口和 K 线周期切换。页面会明确显示 `GMGN REAL FEED`、观测时间和只读来源。CLI 请求失败时页面清空行情并标记不可用，不用随机或演示数据顶替。

右侧 BUY/SELL 只写入当前浏览器的本地模拟账本，使用页面显示的真实价格快照；它不会改变 CLI `paper-100` 状态，也不会调用钱包、签名器或广播交易。CLI `paper-100` 仍是独立的观察型账户。

可显式选择 `--watch --interval-seconds 60`，周期最短 60 秒，前台运行，用 Ctrl-C 停止。本文档及测试不会自动启动常驻任务，不创建系统服务，不发送 Telegram。

## 恢复与限制

单进程持有 `.paper-100.lock`；第二个写入者直接拒绝。异常退出留下锁时不会自动抢占或删除：先确认旧进程已终止、核对账户文件，再人工处理锁。不要为了重新开始而覆盖旧账户，使用新的隔离目录。

账户损坏、策略不匹配、现金不守恒、重复事件内容变化或不可信输入均失败关闭；纸面成交按原始事件 ID 去重。输入缺失或不完整会作为覆盖问题记录。

单轮最多处理最近 100 个有效 GMGN 事件；截断会明示覆盖不足。历史记录有容量限制，达到上限停止而不悄悄清空去重记录。事件来源、审查声明、数学报价和实际可成交性是不同层次，模拟结果不能当成真实盈利历史。

测试位于 `test/paper-100-runner.test.js` 和 `test/paper-100-ledger.test.js`，使用明确的离线 fixture 与 mock 报价，不访问生产网络、不代表实际收益。
