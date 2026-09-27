# 决策大脑：扫描与视觉升级

## 设计

视觉主张：石墨黑仪器台，写实烟熏玻璃大脑，单一浅玉绿信号色。
内容顺序：当前任务 → 六个研究模块 / 当前 CA 证据 → 实测速度 → 动作记录。
交互主张：点击节点查看模块事实，选择精确链＋CA，跳转完整依据；只读，不触发订单。
大脑是装饰性状态映射，不是模型私有思维或真实脑成像；无 WebGL、无额外轮询。

## 性能改动

- 每轮为 GMGN、币安逐笔流及叙事事件建立按链和 CA 的索引；不缓存新鲜度结论、不省略原验证。
- 分批完成候选纯计算，8 ms / 16 个操作预算后让出主线程；保留单写入队列，避免页面和行情回包长时间得不到处理。
- token-info 与 security 两项独立只读请求同时进入既有队列。账号并发、优先级、Plus 节流、429 冷却不变；返回后仍检查两者身份，整体时间取较旧请求时间。
- 折叠研究区继续记录 CA 状态变更，但不反复重建隐藏列表；展开立即用最新快照渲染。
- API 仍返回完整证据，未裁剪 CA、账本或历史。无重置、实盘、签名或广播改动。

## 实测（不是延迟承诺）

改动前本地完整 API 约 10 MB，观测到 3.9–4.5 秒返回、1.56–1.60 秒扫描间隔。
改动后一次连续三次本地读取为 762 / 501 / 547 ms，扫描间隔 1002 / 1208 / 1208 ms。
前后市场候选数量不同、并行监控负载波动，不能把这些样本当成严格同负载倍数测试。
同一份本地证据、同样的 190 个 CA：直接整理约 27.9 ms；索引后约 4.1 ms（含索引建立）。

上游仍观测到约 50 秒报价排队，部分链行情年龄超过两分钟；未把它隐藏或伪装为实时。
页面分开显示本地扫描间隔、计算耗时、最近报价排队及各链源数据年龄。
秒级本地判断不等于每个 CA 的数据每秒更新；Plus 的共享配额与请求耗时仍构成限制。

## 素材

使用内置 image_gen 生成，项目文件：`dashboard/generated-designs/neural-core-v2.png`。
提示词：textless hero visual for a dark Chinese trading-research dashboard; photorealistic 3D anatomical human brain sculpture, slightly above three-quarter front angle, detailed cortical folds, graphite and translucent smoked glass, restrained jade light inside sulci, silver highlights, black studio fading to black edges; whole brain centered; no text, numbers, UI, logos, charts or props; decorative visualization, not a real brain scan.

测试覆盖索引与原路径输出等价、未来 / 过期证据、并行资料时间边界、原入场退出规则、账本恢复、前端未知 / 离线状态与安全转义。
TG / FOMO / GIWA 保持原进程运行；只有看板与模拟运行时做温和重载。

最终相关回归：556 项通过，0 失败。桌面 1280px / 手机 390px 无横向溢出，六模块切换、逐币依据跳转和成交筛选已实测。
重载后 API 为 ok，仍为 paper，execution / signing / broadcast 均为 false。
主账本 144 条交易的 SHA-256 在重载前后相同，现金未修改；三个监控 PID 未变，心跳新鲜。
