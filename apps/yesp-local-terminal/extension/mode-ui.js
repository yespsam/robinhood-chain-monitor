const $=id=>document.getElementById(id);
export const modeReasons={MODE_REPORT_REQUIRED:'请先选择一条官方更新报告。',MODE_REPORT_TARGET_INVALID:'请对照报告选择已核验的新模式；不能授权未来任意模式。',MODE_REPORT_SUPERSEDED:'该来源已有后续更新，旧授权停止，请查看新报告。',MODE_SOURCE_STALE:'所选官方来源暂未读取完成，不能继续自动买入。',MODE_ADAPTER_REQUIRED:'新模式已锁定，交易适配待接入；不会跳到其他模式。',MODE_FIRST_MISSED:'首币超过你确认的新鲜度窗口，本次停止。',MODE_FIRST_ALREADY_EXISTS:'该模式首币已存在，无法抢其首次发行；本次停止。',MODE_HISTORY_UNVERIFIED:'首币历史证据不完整，本次停止。',MODE_DEFINITION_CHANGED:'模式合约或规则变化，需要重新核验。',MODE_FIRST_CHANGED:'首币证据发生变化，本次停止。',MODE_PREVIEW_MISMATCH:'交易报价与已锁定模式不一致。',MODE_BASELINE_UNAVAILABLE:'平台目录暂未核验完成，请等待监控状态恢复。',MODE_CATALOG_STALE:'平台目录读取中断，本次暂停。',MODE_NOT_OPEN:'新模式尚未开放，等待开放。',MODE_REORG:'链上证据发生重组，需要重新核验。',MODE_HISTORY_INCOMPLETE:'创建历史读取不完整，不能判断首币。'};
const phases={WAITING_MODE:'等待新模式',MODE_LOCKED:'新模式已锁定',WAITING_ADAPTER:'待接入交易适配',WAITING_FIRST:'等待首币创建',FIRST_LOCKED:'首币已锁定'};
export const modePhase=j=>j.strategy==='first-mode'?`${phases[j.phase]||'新模式首币'}${j.modeName?' · '+j.modeName:''}`:'';
export function setupModeUI({client,call,note,invalidate,onOpenReport,onOpenToken}){
 let snapshot={changes:[],modes:[]},selection='',reportLimit=8;
 const selected=()=>snapshot.changes.find(c=>c.id===selection);
 const eligible=c=>c&&!['SUPERSEDED','BASELINE_UNAVAILABLE','SOURCE_UNAVAILABLE','ADAPTER_REVIEW_REQUIRED','FIRST_ALREADY_EXISTS','HISTORY_SYNCING'].includes(c.reviewState);
 const platform=p=>p==='four'?'Four.meme':p==='gang'?'Gang':'Flap';
 const node=(tag,text,cls)=>{const e=document.createElement(tag);e.textContent=text;if(cls)e.className=cls;return e;};
 const link=(url,text)=>{try{const u=new URL(url);if(u.protocol!=='https:'||u.username||u.password||!['github.com','docs.flap.sh','flap.sh'].includes(u.hostname))return node('span','链接未核验');const a=node('a',text);a.href=u.href;a.target='_blank';a.rel='noopener noreferrer';return a;}catch{return node('span','');}};
 function choices(){const select=$('snipe-mode'),previous=select.value,c=selected();select.replaceChildren(new Option('选择本次更新对应的新模式',''));
  for(const m of snapshot.modes.filter(m=>c?.candidateIds?.includes(m.id))){const o=new Option(`${platform(m.platform)} · ${m.name}${!m.adapter?' · 待接入':m.first||m.firstAlreadyExists?' · 首币已出现':m.platform==='gang'&&!m.historyComplete?' · 正在核对历史':''}`,m.id);o.disabled=!m.adapter||m.definitionChanged||!!m.first||!!m.firstAlreadyExists||!!m.chainError||m.reason==='MODE_REMOVED'||m.platform==='gang'&&!m.historyComplete;select.append(o);}
  if([...select.options].some(o=>o.value===previous&&!o.disabled))select.value=previous;
  if(previous!==select.value)invalidate();select.disabled=!eligible(c);
  $('snipe-report-selected').textContent=c?`${c.sourceName||platform(c.platform)}：${c.title||c.revision}（${c.revision?.slice(0,12)}）${eligible(c)?'':' · 此报告暂不能授权，请重新核对'}`:'请先在上方报告中选择一条官方更新。';
  $('snipe-mode-hint').textContent=c?.candidateIds?.length?(c.platform==='gang'?'这些模式已关联本次官方版本或链上注册报告。回购首币按官方模块对应的连续发行记录判定；已发行的首币不能再启用首次狙击。':'这些是同一平台、版本检查区间内发现的候选；请对照官方内容选择对应模式。提交前仍会核验首币尚未出现。'):'尚未发现可关联的新模式，继续报告和监控，暂不能授权买入。';
  fundingFields();updateButton();
 }
 function fundingFields(){const gang=first()&&snapshot.modes.find(m=>m.id===$('snipe-mode').value)?.platform==='gang';$('snipe-quote').readOnly=gang;if(gang)$('snipe-quote').value='0x'+'0'.repeat(40);$('snipe-swap-field').hidden=!gang;$('snipe-swap-slip').required=gang;$('snipe-gas-hint').textContent=gang?'一次授权覆盖兑换结算币、按本次数量授权和买入。每步按 Gas 预估筛选；兑换步骤按 0.005 BNB 网络费预留筛选，均不是最终扣费硬上限。手机确认仍由钱包决定。':'Gas 数值用于提交前筛选，不是钱包最终扣费的硬上限。需要授权、额度不足或预演风险提示时会暂停。';}
 function firstEvidence(m){const box=node('div','','mode-first-evidence');box.append(node('strong',m.name));if(!m.first){box.append(node('p',!m.adapter?'合约尚未审阅，仅报告':m.chainError?(modeReasons[m.chainError]||m.chainError):m.historyComplete?'连续历史已核验，尚未出现首币':`正在从部署区块核对历史${m.coveredThrough?' · 已核对至 '+m.coveredThrough:''}`));return box;}
  const f=m.first;box.append(node('p','首币已出现 · 不会用后续币替代'),node('code',f.tokenAddress));
  const proof=f.proof==='factory-index-zero'?'官方工厂 markets(0)，序号 1':f.proof==='gang-official-module-contiguous-creations'?'从模块部署区块连续核对发行事件，并验证官方模块来源、克隆代码与创建人':f.proof==='gang-v3-contiguous-creations'?'从 V3 部署区块连续核对内盘发行事件':'从模式未注册区块连续核对创建事件';
  box.append(node('p',`证据：${proof}${f.createdAt?' · '+new Date(f.createdAt).toLocaleString('zh-CN',{hour12:false}):''}`));
  const actions=node('div','','report-actions');if(/^0x[\da-f]{40}$/i.test(f.tokenAddress||'')&&onOpenToken){const b=node('button','查看首币');b.type='button';b.addEventListener('click',e=>{if(e.isTrusted)onOpenToken(f.tokenAddress);});actions.append(b);}if(/^0x[\da-f]{64}$/i.test(f.txHash||'')){const a=node('a','发行交易 ↗');a.href='https://bscscan.com/tx/'+f.txHash;a.target='_blank';a.rel='noopener noreferrer';actions.append(a);}box.append(actions);return box;
 }
 function updateButton(){const missing=first()&&(!eligible(selected())||!$('snipe-mode').value);$('snipe-prepare').dataset.modeBlocked=String(missing);$('snipe-prepare').disabled=missing||$('snipe-prepare').dataset.busy==='true';$('snipe-prepare').textContent=first()?'核对这次更新的狙击参数':'核对自动买入参数';}
 const first=()=>$('snipe-strategy').value==='first-mode';
 function change(){const active=first();$('snipe-ca-field').hidden=active;$('snipe-ca').required=!active;$('snipe-age-field').hidden=!active;$('snipe-age').required=active;
  $('snipe-seconds-label').textContent=active?'有效期（秒，30 至 604800，最多 7 天）':'有效期（秒，30 至 1800）';$('snipe-seconds').value=active?'86400':'300';
  $('snipe-report-fields').hidden=!active;$('snipe-mode').required=active;
  $('snipe-strategy-help').textContent=active?'先看官方更新报告，选择对应模式并授权；只等待该模式的首币，整个任务最多买入一次。':'填写目标 CA，达到可交易条件后自动买入一次。';invalidate();fundingFields();updateButton();}
 $('snipe-strategy').addEventListener('change',change);change();
 for(const id of ['snipe-strategy','snipe-age'])$(id).addEventListener('input',invalidate);
 $('snipe-mode').addEventListener('change',()=>{invalidate();fundingFields();updateButton();});
 $('mode-update-banner').addEventListener('click',e=>{if(!e.isTrusted)return;onOpenReport();$('mode-report-section').scrollIntoView({behavior:'smooth',block:'start'});});
 // A separate trusted callback opens the report tab; this button never arms a job.
 $('mode-refresh').addEventListener('click',async e=>{if(!e.isTrusted)return;const b=e.currentTarget;b.disabled=true;try{render((await call('modeRefresh')).modes);}catch(err){note('更新报告暂未读取（'+err.message+'）');}finally{b.disabled=false;}});
 function render(s){
  snapshot=s;if(first()&&selection&&!eligible(selected()))invalidate();
  const platforms=Object.entries(s.platforms||{}),failures=(s.sources||[]).filter(x=>x.error).length;
  const count=(s.changes||[]).filter(c=>!['SUPERSEDED','BASELINE_UNAVAILABLE'].includes(c.reviewState)).length,latest=(s.changes||[]).find(c=>!['SUPERSEDED','BASELINE_UNAVAILABLE'].includes(c.reviewState)),unhealthy=failures+platforms.filter(([,p])=>p.error).length;
  $('mode-update-banner').hidden=!count&&!unhealthy;$('mode-update-banner').textContent=unhealthy?`监控有 ${unhealthy} 项读取异常 · 点击查看原因`:`${latest?.summary?.title||'官方资料有更新'} · ${count} 条最新报告 · 点击查看`;
  // Keep new report notifications live without rebuilding an invisible catalog.
  if(document.hidden||$('snipe-view').hidden)return;
  $('mode-monitor-state').textContent=`Four.meme / Flap / Gang 官方资料监控${s.running?'运行中':'未运行'}${failures?' · '+failures+' 个来源读取失败':''}。Gang 同时核对官方注册目录、已审阅的模块代码和连续发行历史。未知合约先报告，审阅接入后才可授权。`;
  const body=$('mode-sources');body.replaceChildren();
  for(const source of s.sources||[]){const item=document.createElement('article');item.className='mode-source';const title=document.createElement('strong');title.textContent=source.name;
   const p=document.createElement('p');p.textContent=source.error?`读取未完成（${source.error}）`:`${source.revision?.slice(0,12)||'—'} · 最近成功检查 ${source.updatedAt?new Date(source.updatedAt).toLocaleString('zh-CN',{hour12:false}):'尚未读取'}`;item.append(title,p);
   if(source.title)item.append(node('p',source.summary?.title||source.title));body.append(item);}
  const list=$('mode-list');list.replaceChildren();
  for(const m of [...(s.modes||[])].sort((a,b)=>Number(b.newMode)-Number(a.newMode)||b.sequence-a.sequence)){
   const item=document.createElement('article');item.className='snipe-job';const h=document.createElement('strong');h.textContent=`${platform(m.platform)} · ${m.name}`;
   const p=document.createElement('p');p.textContent=(m.newMode?'监控期间发现的新模式':'基线已有模式')+' · '+(m.definitionChanged?'规则变化待核验':!m.adapter?'待接入适配':m.ready?'已有交易适配':'尚未开放')+(m.firstAlreadyExists?' · 首币已存在':'');item.append(h,p);
   if(m.first||m.platform==='gang')item.append(firstEvidence(m));
   if(m.chainError){const p=document.createElement('p');p.textContent=modeReasons[m.chainError]||m.chainError;item.append(p);}list.append(item);
  }
  const changes=$('mode-changes');changes.replaceChildren();for(const c of (s.changes||[]).slice(0,reportLimit)){
   const item=node('article','',c.id===selection?'mode-report selected-report':'mode-report');item.append(node('span',`${platform(c.platform)} · 检测于 ${new Date(c.at).toLocaleString('zh-CN',{hour12:false})}`,'eyebrow'),node('h3',c.summary?.title||c.title||c.sourceId));
   if(c.summary){item.append(node('p',c.summary.note),node('p','原始提交：'+c.title,'muted'));}
   const states={ADAPTER_REVIEW_REQUIRED:'更新已检测 · 模式适配待核验，尚未授权自动交易',HISTORY_SYNCING:'正在连续核对发行历史 · 完成前不能授权',FIRST_ALREADY_EXISTS:'首币已发行 · 可查看记录，不能再狙击首次发行',WAITING_MODE:'已报告 · 等待链上新模式',REVIEW_REQUIRED:'已报告 · 请核对模式与参数；已授权任务状态见下方',SUPERSEDED:'已有后续版本 · 此条保留作为历史记录',BASELINE_UNAVAILABLE:'旧记录缺少基线 · 仅供查看',SOURCE_UNAVAILABLE:'来源或链上目录读取失败 · 暂不能授权'};
   item.append(node('p',states[c.reviewState]||'仅报告 · 尚未授权'),node('code',`${c.previousRevision?.slice(0,12)||'—'} → ${c.revision?.slice(0,12)||'—'}`));
   if(c.description)item.append(node('p',c.description,'report-description'));
   if(c.files?.length){const d=node('details',''),ul=node('ul','');d.append(node('summary',`变更文件（显示 ${c.files.length} 项${c.commitCount?' · '+c.commitCount+' 次提交':''}）`));for(const f of c.files)ul.append(node('li',f.name+' · '+f.status));d.append(ul);item.append(d);}
   if(c.detailsUnavailable)item.append(node('p','变更文件暂未读取，可打开官方对比页查看。'));
   for(const m of snapshot.modes.filter(m=>c.candidateIds?.includes(m.id)))item.append(firstEvidence(m));
   const actions=node('div','','report-actions');actions.append(link(c.link,'官方原文 ↗'));if(c.compareUrl)actions.append(link(c.compareUrl,'查看版本差异 ↗'));
   const b=node('button',c.id===selection?'已选择 · 继续核对下方参数':'选择这次更新');b.disabled=!eligible(c);b.addEventListener('click',e=>{if(!e.isTrusted)return;selection=c.id;invalidate();render(snapshot);$('snipe-report-fields').scrollIntoView({behavior:'smooth',block:'center'});});actions.append(b);item.append(actions);changes.append(item);
  }
  if(!changes.childNodes.length)changes.textContent='尚未发现相对基线的官方资料更新。';
  if((s.changes||[]).length>reportLimit){const more=node('button',`显示更多历史报告（还有 ${s.changes.length-reportLimit} 条）`);more.type='button';more.addEventListener('click',e=>{if(e.isTrusted){reportLimit+=8;render(snapshot);}});changes.append(more);}
  $('mode-report-count').textContent=count?`${count} 条最新更新待查看；下方保留历史记录。发现更新本身不会启用交易。`:'持续监控 Four.meme / Flap / Gang，检测到官方更新会先在此报告。';choices();
  for(const [name,p]of platforms.filter(([,p])=>p.error)){const line=document.createElement('p');line.textContent=`${name} 目录：${p.error}`;body.append(line);}
 }
 client.subscribe('modes',render);client.init().then(()=>call('modeStatus')).then(r=>render(r.modes)).catch(e=>note('模式监控状态未读取完成（'+e.message+'）'));
 document.addEventListener('visibilitychange',()=>{if(!document.hidden&&!$('snipe-view').hidden)render(snapshot);});
 return {refreshView:()=>render(snapshot),params:()=>{if(!first())return {strategy:'token',tokenAddress:$('snipe-ca').value.trim()};if(!eligible(selected()))throw Error('MODE_REPORT_REQUIRED');if(!$('snipe-mode').value)throw Error('MODE_REPORT_TARGET_INVALID');return {strategy:'first-mode',reportId:selection,modeId:$('snipe-mode').value,firstMaxAgeSeconds:Number($('snipe-age').value)};}};
}
