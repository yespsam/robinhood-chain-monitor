import { renderNarrativeDesk } from './narrative-thesis.js';
const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=v=>Number.isFinite(Date.parse(v))?new Date(v).toLocaleString('zh-CN',{hour12:false}):'未记录';
const link=(url,text)=>{try{const u=new URL(url);if(u.protocol==='https:'&&!u.username&&!u.password&&!u.port)
  return `<a href="${escape(u.href)}" target="_blank" rel="noopener noreferrer">${escape(text)}</a>`;}catch{}return escape(text);};
export function renderNewsWire(wire,desk=null,expanded=new Set()){
  if(!wire)return '<p class="section-note">消息对照初始化中；Telegram 监控由独立进程负责。</p>';
  const status=(value,at)=>value==='healthy'&&Date.parse(wire.updatedAt)-Date.parse(at)<=30000?'连接正常':value==='checking'?'请求中':value==='backoff'?'退避重试':'等待连接';
  const chains=['sol','bsc'].map(chain=>`${chain==='sol'?'Solana':'币安链'}：${status(wire.gmgnChains?.[chain]?.status,wire.gmgnChains?.[chain]?.lastSuccessAt)}`).join(' · ');
  const labels={gmgn_platform_call:'GMGN 平台喊单（非完整推文）',own_verified:'自有监控 · 已核对出处',own_telegram:'自有 TG 新闻 · 内容待核实'};
  const alpha=wire.alphaCatalog;
  const alphaHtml=alpha?`<article class="research-department"><div><strong>币安 Alpha 官方上新</strong><span>${alpha.fresh?'目录连接正常':'目录待更新'}</span></div>
    <p>支持链目录 ${escape(alpha.count)} 个；24 小时内可研究事件 ${escape(alpha.activeSignals)} 个。每轮完成后 5 秒读取，网络延迟另计。刚上新快线不等普通趋势形态；过了五分钟只做当前行情跟随，不补造旧成交。</p>
    ${(alpha.latest||[]).slice(0,2).map(t=>`<p>${escape(t.symbol)} · ${escape(t.chain)} · ${escape(t.phase)} · 上新 ${escape(time(t.listingAt))}</p><p class="contract-address">${escape(t.address)}</p>`).join('')}
    <p>${link(alpha.sourceUrl,'官方目录出处')} · 最近成功 ${escape(time(alpha.lastSuccessAt))}${alpha.lastError?` · ${escape(alpha.lastError)}`:''}</p></article>`:'';
  const themes=(wire.themeCandidates||[]).slice(0,6).map(t=>`<article class="research-department"><div><strong>${escape(t.symbol)} · 无 CA 主题候选</strong><span>${t.selected?'优先候选 · 成交状态见账本':'备选研究'}</span></div><p>${escape(t.explanation)}</p><p>匹配 ${escape(t.matchedTerms.join(' / '))} · 流动性 ${Number.isFinite(t.liquidity)?'$'+escape(t.liquidity.toFixed(2)):'未知'} · ${t.phase==='launch'?'新消息窗口':'后续行情跟随，非首发狙击'}</p><p class="contract-address">${escape(t.chain)} · ${escape(t.address)}</p><p>${link(t.sourceUrl,'原始推文')} · ${escape(time(t.sourceAt))}</p></article>`).join('');
  const binding={direct_ca:'原文明确 CA',project_permalink:'项目资料引用该原帖',historical_topic_permalink:'同一作者、同一题材的历史原帖关联',name_tag_only:'仅名字 / 标签匹配'};
  const eventHtml=(wire.twitterEvents?.reports||[]).slice(0,8).map(e=>`<article class="research-department"><div><strong>推特事件 → 叙事 → CA</strong><span>${escape(e.decision)}</span></div>
    <p>@${escape(e.author)}：${escape(e.text)}</p><p>${escape(e.event.label)} · ${escape(e.event.claim)}</p><p>${escape(e.event.mechanism)}</p>
    <p>${link(e.sourceUrl,'原始推文')} · ${escape(time(e.sourceAt))} · 找到 ${escape(e.candidateCount)} 个候选</p>
    ${(e.candidates||[]).slice(0,4).map(c=>`<p><strong>${escape(c.symbol||c.name)} · ${escape(c.chain)}</strong> · ${escape(binding[c.binding])}</p>
      <p>名字：${escape(c.matchedNames.join(' / ')||'未直接匹配')}；标签：${escape(c.matchedTags.join(' / ')||'未提供匹配标签')}；概念：${escape(c.concepts.join(' / ')||'原文词语匹配')}</p>
      <p class="contract-address">${escape(c.address)}</p>${c.anchor?`<p>${link(c.anchor.url,'历史关联原帖')}（社区关联，不是名人背书）</p>`:''}
      <p>${escape(c.blocks.length?c.blocks.join('；'):c.checks?`${c.checks.decision}：${[...c.checks.missing,...c.checks.reasons].join('；')}`:'关联已通过，等待本轮资金与行情检查')}</p>`).join('')}
    </article>`).join('');
  return `${renderNarrativeDesk(desk,expanded)}${eventHtml}${alphaHtml}${themes}<p class="section-note">${escape(chains)}。近 24 小时本地保留：自有消息 ${escape(wire.ownDocumentCount)} 条、GMGN 喊单 ${escape(wire.gmgnSignalCount)} 条，非全量覆盖。待研究线索 ${escape(wire.freshHints)} 个；同 CA 双路出现 ${escape(wire.dualSourceHints)} 个，不代表两份独立证据。直接消息两分钟快线；无 CA 主题可研究一小时，后续跟随需要报价重新走强。</p>
    <p class="section-note">GMGN 完整推特流尚未接通，目前接入的是平台喊单接口。主页链接不能代替推文；无 CA 消息需比较主题候选，名称相同本身不构成买入信号。${wire.entryRules?escape(wire.entryRules):wire.monitorEntryEnabled?`主模拟盘已启用监控事件快线：两分钟内精确 CA 消息，一次新鲜报价可试仓；已核实原帖的主题候选另需项目资料引用同一原帖，后续跟随需报价重新走强。当前未消费 ${escape(wire.unconsumedPaperSignals)} 个。缺失审计不拦截，未知不等于安全，明确不可交易标记仍拦截。`:'监控事件快线未启用，消息仅供研究。'}不会新增 TG 刷屏播报。</p>
    ${(wire.latest||[]).slice(0,12).map(item=>`<article class="research-department"><div><strong>${escape(labels[item.source]||'待核实来源')}</strong><span>${item.fresh?'新鲜线索':'历史消息'}</span></div>
      <p>${escape(item.text)}</p>${item.address?`<p class="contract-address">${escape(item.symbol||'代币')} · ${escape(item.chain)} · ${escape(item.address)}</p>`:''}
      <p>${link(item.url,'查看出处')} · 消息时间 ${escape(time(item.sourceAt))}${Number.isFinite(item.arrivalLagMs)?` · 首次采集距触发 ${Math.round(item.arrivalLagMs/1000)} 秒`:''}</p>
      ${item.contacts?.length?`<p>GMGN 返回的 X 账号：${item.contacts.slice(0,6).map(c=>link(c.url,`@${c.handle}${c.kind==='profile_only'?'（主页）':'（待核实链接）'}`)).join(' · ')}</p>`:''}</article>`).join('')||'<p class="section-note">当前没有可展示的新消息；继续等待上游，不伪造叙事。</p>'}`;
}
