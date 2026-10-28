// Display-only classification of official source evidence. It never selects a
// contract, declares a first token, or authorizes a trade.
export function describeModeUpdate(report){
 const evidence=[report.title,report.description,...(report.files||[]).map(f=>f.name)].filter(Boolean).join('\n').toLowerCase();
 if(report.platform!=='gang')return null;
 if(report.sourceId==='gang-deployments'||report.id==='gang-deployments')return {title:'Gang 官方链上模式目录',kind:'registry',note:'按官方注册目录发现合约，再校验已审阅的代码与模块关系。下方显示连续发行历史的首币结果；未审阅的新合约只报告。'};
 if(/buy[-\s]?back|splitter|回购/.test(evidence)&&/payee|收款地址|buyback.*v2/.test(evidence))return {title:'Gang 回购 v2 · 自定义收款地址',kind:'buyback-v2',note:'v2 允许创建者指定和修改非回购部分的收款地址；回购比例规则与内盘买卖路径沿用原机制。v1、v2 按各自官方工厂分别判定首币，结果见下方。'};
 if(/buy[-\s]?back|splitter|回购|销毁/.test(evidence))return {title:'Gang 回购销毁模块更新',kind:'buyback',note:'官方代码出现回购分配模块线索。Gang V3 内盘查询与交易已接入；具体代币是否启用回购，以链上税费接收合约为准。链上核验与首币结果见下方。'};
 if(/\bbond\b|债券/.test(evidence))return {title:'Gang Bond 模块更新',kind:'bond',note:'检测到新模块代码线索，尚未接入此机制的交易与首币判定。查看官方内容后再决定后续接入。'};
 if(/registry|注册/.test(evidence))return {title:'Gang 合约注册目录更新',kind:'registry',note:'检测到注册目录变更；目录中的新地址只作为核验线索，不自动获得交易权限。'};
 if(/\bv3\b|merged|合并/.test(evidence))return {title:'Gang V3 / 合并发行合约更新',kind:'v3',note:'已接入经核验的 V3 内盘合约。合并合约中的打新销售是另一种机制，不能当作 V3 内盘交易；链上核验与首币结果见下方。'};
 return {title:'Gang 官方版本更新',kind:'other',note:'已记录官方版本变化，查看提交说明和文件差异。版本变化本身不证明发布了新交易模式。'};
}
