import {setupGangLaunchUI} from './gang-launch-ui.js';
import {createScanRows} from './scan-ui.js';
import {slippageBps} from './slippage-policy.js';
import {setupModeUI,modeReasons,modePhase} from './mode-ui.js';
const $=id=>document.getElementById(id),ZERO='0x'+'0'.repeat(40);
const labels={ARMED:'监控中',SUBMITTING:'正在提交一次买入',FINISHED:'本次提交已结束',PAUSED:'已暂停',CANCELLED:'已取消',EXPIRED:'已到期'};
const reasons={...modeReasons,SNIPE_GAS_RESERVE_EXCEEDED:'兑换步骤未提供精确 Gas 预估，按 0.005 BNB 预留筛选；高于你填写的筛选上限，尚未提交此步骤。',SNIPE_GANG_BNB_REQUIRED:'Gang 首币任务以 BNB 计价，请将结算资产设为零地址。',MODE_MODULE_BINDING_PENDING:'首币已锁定，等待官方回购模块绑定；不会换成下一个币。',INVALID_SLIPPAGE:'滑点范围为 0.01% 至 99.99%，最多两位小数。',SNIPE_APPROVAL_REQUIRED:'需要先手动完成结算币授权，再重新启用。',SNIPE_BUDGET_EXCEEDED:'所需支付超过你确认的最高支付。',SNIPE_GAS_EXCEEDED:'预计网络费超过设定值。',SNIPE_QUOTE_CHANGED:'结算资产与预先确认的币种不同。',SNIPE_REVIEW_REQUIRED:'币安预演需要人工核对风险或手机确认。',SERVER_RESTARTED:'服务重启后不会自动恢复买入，请重新设置。',SERVER_STOPPED:'服务已停止。',LOGIN_REQUIRED:'请先连接钱包。',WALLET_CHANGED:'当前钱包已变化，请重新核对。',NOT_FOUR_TOKEN:'等待目标 CA 创建或开放交易。',NOT_OPENFOUR_TOKEN:'等待目标 CA 创建或开放交易。',OPENFOUR_TOKEN_NOT_FOUND:'等待目标 CA 创建或开放交易。',FLAP_STAGED_TOKEN:'代币已预告，等待开放。',FOUR_NOT_LAUNCHED:'等待开盘时间。',SNIPE_ALREADY_ACTIVE:'已有一个狙击任务在运行，请先取消。'};
export function setupLocalFeatures({client,onSelect,onActive,getSelected}){
 if(!client.local)return;
 for(const id of ['view-new','view-snipe','view-gang'])$(id).hidden=false;
 $('brand-mode').textContent='LOCAL TERMINAL';$('intro-tag').textContent='本地交易 · 新币扫描 · 单次狙击';$('app-mode').textContent='YESP Local';
 let legacyActive=false,gangActive=false;const reportActive=()=>onActive(legacyActive||gangActive);
 let filter='all',scan=null,jobs=null,draft=null,working=false,paused=false,scanTimer=null,modeUI;
 const call=async(method,params={})=>{const r=await client.sendMessage({id:crypto.randomUUID(),method,params});if(!r.ok)throw Error(r.error?.code||'LOCAL_REQUEST_FAILED');return r.data;};
 function show(view){document.body.dataset.view=view;$('lookup').hidden=view!=='trade';$('recent').hidden=view!=='trade';document.querySelector('.intro h1').textContent=view==='gang'?'Gang 新币，买 1%，翻倍卖半。':view==='snipe'?'先报告更新，由你决定是否狙击。':view==='new'?'Agent 新币，链上核验。':'一个 CA，一个交易入口。';document.querySelector('.intro p').textContent=view==='gang'?'逐币记账，达到目标只卖一半，余仓保留。':view==='snipe'?'查看官方更新，选择对应模式，确认后才等待首币。':view==='new'?'Four.meme、Flap 与 Gang 官方市场目录。':'识别内盘或通用 Swap，按数量买入，按持仓卖出，同页转出。';for(const key of ['trade','new','snipe','gang']){$(key+'-view').hidden=key!==view;$('view-'+key).classList.toggle('nav-active',key===view);}
  if(view==='new'&&scan)renderScan(scan);
  if(view==='snipe'){modeUI?.refreshView();const m=getSelected();if(m&&$('snipe-strategy').value!=='first-mode'&&!$('snipe-ca').value){$('snipe-ca').value=m.tokenAddress;$('snipe-quote').value=m.quote.address;}}}
 for(const view of ['trade','new','snipe','gang'])$('view-'+view).addEventListener('click',e=>{if(e.isTrusted)show(view);});
 function note(message){$('snipe-note').textContent=message;}
 function rowCell(text,mono=false){const td=document.createElement('td');td.textContent=text;if(mono)td.className='mono';return td;}
 const renderScanRows=createScanRows(ca=>{show('trade');onSelect(ca);});
 function renderScan(s){scan=s;if(paused||document.hidden||$('new-view').hidden)return;$('scan-state').textContent=s.error?`创建事件读取失败（${s.error}），保留最后事件；平台目录状态见下方`:s.catchingUp?'正在回溯最近创建事件…':`持续扫描 · 区块 ${s.head??'—'} · 本次读取 ${s.latencyMs} ms`;
  const g=s.gangDirectory;if($('gang-directory-state'))$('gang-directory-state').textContent=g?.error?`Gang 目录读取未完成（${g.error}），保留上次已核验列表。`:g?.updatedAt?`Gang：已核验 ${g.shown} / ${g.total} 个代币，其中外盘 ${g.externalShown} 个。`:'Gang 主网目录正在核验…';
  const f=s.fourDirectory;$('four-directory-state').textContent=f?.error?`Four.meme 目录读取未完成（${f.error}），保留上次已核验列表。`:f?.updatedAt?`Four.meme Agent：已核验 ${f.shown} 个代币，其中外盘 ${f.externalShown} 个。${f.unverified?' '+f.unverified+' 个核验失败，等待重试。':''}${f.rejected?' '+f.rejected+' 个未通过模式核验，已排除。':''} 更新于 ${new Date(f.updatedAt).toLocaleTimeString('zh-CN',{hour12:false})}`:'Four.meme 内盘 / 外盘目录正在核验…';
  $('scan-time').textContent=s.updatedAt?`更新于 ${new Date(s.updatedAt).toLocaleTimeString('zh-CN',{hour12:false})}`:'等待链上数据';const d=s.flapDirectory;$('flap-directory-state').textContent=d?(d.error?`Flap 目录读取未完成（${d.error}），保留上次已核验列表。`:`Flap Agent 官方目录：共 ${d.total??'—'} 个市场，显示最新 ${d.shown} 个。${d.updatedAt?` 更新于 ${new Date(d.updatedAt).toLocaleTimeString('zh-CN',{hour12:false})}`:''}`):'Flap Agent 目录正在读取…';renderScanRows(s.rows,filter,{search:$('scan-search').value,sort:$('scan-sort').value});
 }
 $('scan-filter').addEventListener('change',()=>{filter=$('scan-filter').value;if(scan)renderScan(scan);});
 for(const id of ['scan-search','scan-sort'])$(id).addEventListener(id==='scan-search'?'input':'change',()=>{if(scan&&!paused)renderScan(scan);});
 $('scan-pause').addEventListener('click',()=>{paused=!paused;$('scan-pause').textContent=paused?'继续列表':'暂停列表';$('scan-pause').setAttribute('aria-pressed',String(paused));for(const id of ['scan-filter','scan-search','scan-sort'])$(id).disabled=paused;if(paused)$('scan-state').textContent='列表已暂停 · 后台扫描和狙击任务继续运行';else if(scan)renderScan(scan);});
 function renderJobs(s){jobs=s;legacyActive=s.jobs.some(j=>['ARMED','SUBMITTING'].includes(j.state));reportActive();const list=$('snipe-jobs');list.replaceChildren();
  $('snipe-empty').hidden=s.jobs.length>0;const blocked=working||s.jobs.some(j=>['ARMED','SUBMITTING'].includes(j.state));$('snipe-prepare').dataset.busy=String(blocked);$('snipe-prepare').disabled=blocked||$('snipe-prepare').dataset.modeBlocked==='true';
  for(const j of s.jobs.slice(0,20)){const section=document.createElement('article');section.className='snipe-job';
   const title=document.createElement('strong');title.textContent=(labels[j.state]||j.state)+(modePhase(j)?' · '+modePhase(j):'');const ca=document.createElement('code');ca.textContent=j.tokenAddress||'等待新模式的首币 CA';
   const detail=document.createElement('p');detail.textContent=`数量 ${j.amount} · 最高支付 ${j.maxSpend} ${j.quoteSymbol||(j.quoteTokenAddress===ZERO?'BNB':j.quoteTokenAddress)} · 检查 ${j.checks} 次 · 截止 ${new Date(j.validUntil).toLocaleString('zh-CN',{hour12:false})}`;
   const reason=document.createElement('p');reason.textContent=j.error?(reasons[j.error]||`状态代码：${j.error}`):j.operationStatus?`提交状态：${j.operationStatus}，本任务不会再买入。`:'等待可交易条件及预算检查通过。';section.append(title,ca,detail,reason);
   if(['ARMED','PAUSED'].includes(j.state)){const b=document.createElement('button');b.textContent='取消任务';b.addEventListener('click',async e=>{if(!e.isTrusted||working)return;working=true;try{await call('sniperCancel',{id:j.id});note('任务已取消，不会再自动提交。');renderJobs((await call('sniperStatus')).sniper);}catch(e){note(reasons[e.message]||e.message);}finally{working=false;if(jobs)renderJobs(jobs);}});section.append(b);}
   if(/^0x[\da-f]{64}$/i.test(j.txHash||'')){const a=document.createElement('a');a.href=`https://bscscan.com/tx/${j.txHash}`;a.textContent='查看成交 ↗';a.target='_blank';a.rel='noopener noreferrer';section.append(a);}list.append(section);
  }
 }
 function invalidate(){draft=null;$('snipe-ack').checked=false;$('snipe-arm').disabled=true;if($('snipe-review').open)$('snipe-review').close();}
 setupGangLaunchUI({client,call,onActive:value=>{gangActive=value;reportActive();}});
 modeUI=setupModeUI({client,call,note,invalidate,onOpenReport:()=>show('snipe'),onOpenToken:ca=>{show('trade');onSelect(ca);}});
 for(const id of ['snipe-ca','snipe-amount','snipe-budget','snipe-quote','snipe-slip','snipe-swap-slip','snipe-seconds','snipe-gas'])$(id).addEventListener('input',invalidate);
 $('snipe-form').addEventListener('submit',async e=>{e.preventDefault();if(!e.isTrusted||working)return;working=true;invalidate();$('snipe-prepare').dataset.busy='true';$('snipe-prepare').disabled=true;note('正在核对钱包与任务参数。');
  try{const bps=slippageBps($('snipe-slip').value.trim());
   const d=await call('sniperDraft',{...modeUI.params(),amount:$('snipe-amount').value.trim(),maxSpend:$('snipe-budget').value.trim(),quoteTokenAddress:$('snipe-quote').value.trim(),slippageBps:bps,...(!$('snipe-swap-field').hidden?{swapSlippageBps:slippageBps($('snipe-swap-slip').value.trim())}:{}),validForSeconds:Number($('snipe-seconds').value),gasEstimateLimit:$('snipe-gas').value.trim()});
   draft=d.snipeDraft;const facts=$('snipe-facts');facts.replaceChildren();
   for(const [key,value]of [['钱包',draft.wallet],[draft.strategy==='first-mode'?'目标规则':'目标 CA',draft.strategy==='first-mode'?`${draft.modeName} · ${draft.modeId} · 仅第 1 个代币`:draft.tokenAddress],...(draft.strategy==='first-mode'?[['官方更新',`${draft.report?.sourceName||''} · ${draft.report?.title||''}`],['授权版本',draft.report?.revision||'—'],['首币最长等待',draft.firstMaxAgeSeconds+' 秒；错过或无法证明首币则停止，不买第二个']]:[]),['买入数量',draft.amount],['结算资产',draft.quoteTokenAddress===ZERO?'BNB':draft.quoteTokenAddress],['最高支付（不含 Gas）',draft.maxSpend],['滑点',Number(draft.slippageBps)/100+'%'],...(draft.report?.platform==='gang'?[['BNB 兑换滑点',Number(draft.swapSlippageBps)/100+'%']]:[]),['每步网络费筛选上限',draft.gasEstimateLimit+' BNB（兑换按预留费用筛选）'],['有效期',draft.validForSeconds+' 秒'],['执行次数',draft.report?.platform==='gang'?'最多买入一次；本次授权覆盖兑换结算币、本次数量授权和买入。手机确认仍由钱包决定。':'整个任务最多买入一次；授权、风险提示需要人工处理']]){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=key;dd.textContent=value;facts.append(dt,dd);}
   $('snipe-review').showModal();note(draft.strategy==='first-mode'?'核对后授权本次更新和所选模式。若首币已出现或来源再次更新，任务会停止。':'核对后启用。若目标已经可交易，启用后即可触发。');
  }catch(err){note(reasons[err.message]||`参数未通过（${err.message}）`);}finally{working=false;if(jobs)renderJobs(jobs);else {$('snipe-prepare').dataset.busy='false';$('snipe-prepare').disabled=$('snipe-prepare').dataset.modeBlocked==='true';}}
 });
 $('snipe-ack').addEventListener('change',()=>{$('snipe-arm').disabled=!draft||!$('snipe-ack').checked||Date.now()>=draft.expiresAt;});
 $('snipe-close').addEventListener('click',e=>{if(e.isTrusted&&!working)invalidate();});$('snipe-review').addEventListener('cancel',e=>{if(working)e.preventDefault();else invalidate();});
 $('snipe-arm').addEventListener('click',async e=>{if(!e.isTrusted||working||!draft||$('snipe-arm').disabled||Date.now()>=draft.expiresAt)return;const draftId=draft.draftId;working=true;invalidate();
  try{await call('sniperArm',{draftId});note('监控已启用。满足条件后自动买入一次；关闭网页不会停止任务，可点击取消。');renderJobs((await call('sniperStatus')).sniper);}catch(err){note(reasons[err.message]||`启用未完成（${err.message}）`);}finally{working=false;if(jobs)renderJobs(jobs);}
 });
 // Keep only the latest snapshot during metadata bursts. Never rebuild hidden lists.
 client.subscribe('scanner',s=>{scan=s;if(scanTimer||paused||document.hidden||$('new-view').hidden)return;scanTimer=setTimeout(()=>{scanTimer=null;if(scan)renderScan(scan);},350);});client.subscribe('sniper',renderJobs);client.subscribe('metrics',m=>{$('speed').textContent=(m.lastOperationMs?`最近请求 ${m.lastOperationMs} ms · RPC ${m.lastMs??0} ms`:`RPC 最近批次 ${m.lastMs??0} ms`)+(m.rpcNode?` · ${m.rpcNode}`:'');});
 document.addEventListener('visibilitychange',()=>{if(document.hidden){clearTimeout(scanTimer);scanTimer=null;}else if(scan)renderScan(scan);});
 client.init().then(async()=>{renderScan((await call('scannerStatus')).scanner);renderJobs((await call('sniperStatus')).sniper);}).catch(e=>note('本机服务状态未读取完成（'+e.message+'）'));
 show('new');
 setInterval(()=>{if(draft&&Date.now()>=draft.expiresAt){invalidate();note('任务确认已过期，请重新核对。');}},1000);
}
