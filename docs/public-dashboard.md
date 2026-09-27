# yesp atm 公开只读看板

公开网站只部署静态界面与快照存储，不启动交易引擎、钱包、TG 监控或 GMGN 采集器。本机系统继续作为唯一账本来源。用户已同意公开模拟盘余额和逐笔成交，GitHub 源码仓库仍为私有。

## 发布范围

- `npm run build:public` 仅复制 11 个明确允许的文件到 `dist-public/`。不会发布整个 dashboard、工作区或 data。
- `src/public-dashboard-state.js` 对本机和云端两次执行字段白名单；拒绝实盘或未明确禁用签名/广播的快照。
- 公开模拟账户、最近 500 笔成交、最多 100 个重点 CA 的核心依据、模块计数和实际采集时间。累计成交/成本统计来自完整账本。
- 手动虚拟资金调整单独显示，不算盈利；不生成演示成交。
- 不上传配置、API key、用户钱包资料、学习钱包明细、错误原文、原始第三方响应。来源 URL 移除查询和片段。
- 无公开交易、重置余额、广场密钥或钱包接口。

## Netlify

仓库根目录 `netlify.toml`，Node 22；静态目录 `dist-public/`，函数目录 `netlify/functions/`。安装依赖后执行 `npm run build:public`，再 `netlify deploy --build` 验证预览，确认后 `netlify deploy --build --prod`。发布前 `netlify status` 核实选中的站点。

两个函数路由：`GET /api/strategy-state` 公开读取最后快照；`POST /api/publish-state` 必须使用独立 `PUBLIC_PUBLISH_TOKEN`。后者只可写脱敏模拟快照，不能操控本机。数据保存在本站 Netlify Blobs，不跨站共享。凭证只在函数环境和本地 `data/public-publisher.json`（权限 600，Git 忽略）保存。

显式配置命令：`node scripts/configure-public-publisher.js <site-id> <https://site.netlify.app>`。CLI 必须已登录。命令静默导入独立随机凭证，不使用交易/API 密钥。

## 本机同步

`npm run publish:public` 启动独立发布器。也可 `node scripts/publish-public-dashboard.js --once` 验证单次同步。每次只读本机 `/api/strategy-state`；正常完成后等待 15 秒再上传，单次最长两个 10 秒请求，无并行堆积、不增加上游 GMGN 请求。失败指数退避至 120 秒。

macOS 常驻服务名 `com.qohfq.yesp-atm-public-publisher`，运行状态写入忽略文件 `data/public-publisher-status.json`。它与原交易/监控服务独立；停止发布器不停止 TG 或模拟引擎。

公开页面每 15 秒读云端，切后台时不轮询；来源快照超过 60 秒标记过期。电脑休眠、关机、断网或本机引擎停机都会中断同步；公网只保留带时间戳的最后记录，不能据此声称 24 小时云端交易。

测试：`node --test test/public-dashboard.test.js test/brain-desk.test.js test/ca-desk.test.js`。
