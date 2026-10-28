const $=id=>document.getElementById(id);
const num=(s,max=5)=>{if(s===null||s===undefined)return '—';const n=Number(s);if(!Number.isFinite(n))return '—';if(n!==0&&Math.abs(n)<0.00001)return n.toExponential(2);return n.toLocaleString('zh-CN',{maximumFractionDigits:max});};
const el=(tag,text,cls)=>{const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;};
function link(text,href){const a=el('a',text);a.href=href;a.target='_blank';a.rel='noopener noreferrer';return a;}
function safeLink(s){try{const u=new URL(s);return u.protocol==='https:'&&!u.username&&!u.password?u.href:null;}catch{return null;}}
function field(list,label,value){const row=el('div',undefined,'scan-field');row.append(el('dt',label),el('dd',value??'未核验'));list.append(row);}
export function scanLane(row){
 const phase=row.phase??row.info?.phase,label=row.info?.phaseLabel||row.mode||'';
 if(phase===3||phase===undefined&&(label==='已毕业'||label==='Agent 已毕业'))return 'launched';
 if(phase===4||phase===5)return 'new';
 const raw=row.progressBps??row.info?.progressBps,progress=raw===null||raw===undefined?NaN:Number(raw);
 if(phase===2||label==='待迁移'||label==='毕业处理中'||label==='Agent 毕业处理中'||Number.isFinite(progress)&&progress>=8000&&progress<10000)return 'near';
 if(Number.isFinite(progress)&&progress>=10000&&phase!==4&&phase!==5)return 'near';
 return 'new';
}
export function scanSelection(rows,filter,{search='',sort='newest'}={}){
 const query=search.trim().toLowerCase(),matching=rows.filter(r=>(r.phase??r.info?.phase)!==4&&(filter==='all'||r.platform===filter)&&(!query||[r.symbol,r.name,r.tokenAddress].some(v=>String(v||'').toLowerCase().includes(query))));
 matching.sort((a,b)=>(b.blockNumber??0)-(a.blockNumber??0)||(b.creationId??0)-(a.creationId??0));
 if(sort==='progress')matching.sort((a,b)=>Number(b.progressBps??b.info?.progressBps??-1)-Number(a.progressBps??a.info?.progressBps??-1));
 const counts={new:0,near:0,launched:0},shown=matching.filter(r=>++counts[scanLane(r)]<=100);
 return {shown,counts};
}
export function createScanRows(onSelect){
 const expanded=new Set(),broken=new Map(),entries=new Map(),lanes={},countsUI={},more={},limits={new:20,near:20,launched:20};let latest=null,selectionKey=null;
 function render(rows,filter,{search='',sort='newest'}={}){const body=$('new-tokens');latest={rows,filter,search,sort};
  const nextKey=JSON.stringify([filter,search,sort]);if(nextKey!==selectionKey){for(const id of Object.keys(limits)){limits[id]=20;if(lanes[id])lanes[id].scrollTop=0;}selectionKey=nextKey;}
  const {shown,counts}=scanSelection(rows,filter,{search,sort});
  if(!Object.keys(lanes).length)for(const [id,title,description]of [['new','新创建','内盘市场 · 创建顺序'],['near','即将开盘','内盘 ≥80% / 迁移中'],['launched','已开盘','Four.meme / Flap / Gang · 已毕业外盘']]){const column=el('section',undefined,'trench-column'),head=el('header'),list=el('div',undefined,'trench-list');list.dataset.lane=id;
   const titleBox=el('div'),count=el('span','0','lane-count'),button=el('button','再显示 20 个','scan-more');button.type='button';button.addEventListener('click',()=>{limits[id]=Math.min(100,limits[id]+20);if(latest)render(latest.rows,latest.filter,latest);});titleBox.append(el('h3',title),count);head.append(titleBox,el('p',description));column.append(head,list,button);body.append(column);lanes[id]=list;countsUI[id]=count;more[id]=button;}
  const positions={new:0,near:0,launched:0},keep=new Set(),allKeys=new Set(rows.map(r=>r.platform+':'+r.tokenAddress.toLowerCase()));
  for(const key of expanded)if(!allKeys.has(key))expanded.delete(key);
  for(const [url,at]of broken)if(Date.now()-at>60000)broken.delete(url);
  for(const r of shown){const lane=scanLane(r);if(positions[lane]>=limits[lane])continue;
   const info=r.info||{state:'loading'},d=info.dividends,key=r.platform+':'+r.tokenAddress.toLowerCase(),has=info.state==='ready',signature=JSON.stringify(r),old=entries.get(key);keep.add(key);
   if(old?.signature===signature){place(old.node,lane,positions[lane]++);continue;}
   const tr=el('article',undefined,'trench-token'),name=el('div',undefined,'scan-token');tr.dataset.platform=r.platform;
   const identity=el('div',undefined,'scan-identity'),avatar=el('span',(r.symbol||'?').slice(0,2), 'scan-avatar');
   if(/^\/api\/token-image\/[a-f\d]{64}$/.test(info.imageUrl||'')&&!broken.has(info.imageUrl)){const img=old?.imageUrl===info.imageUrl?old.node.querySelector('img')||el('img'):el('img');if(!img.src){img.loading='lazy';img.decoding='async';img.width=58;img.height=58;img.src=info.imageUrl;img.addEventListener('error',()=>{broken.set(info.imageUrl,Date.now());img.remove();});}img.alt=r.symbol+' 头像';avatar.append(img);}
   const title=el('div'),b=el('button',r.symbol+' · '+r.name,'token-link');b.title='查看 K 线与买卖';b.addEventListener('click',e=>{if(e.isTrusted)onSelect(r.tokenAddress);});title.append(b,el('span',r.platform+' · '+(info.phaseLabel||r.mode),'scan-sub'));identity.append(avatar,title);name.append(identity);
   const address=el('div',undefined,'scan-address'),code=el('code',r.tokenAddress.slice(0,6)+'…'+r.tokenAddress.slice(-6));code.title=r.tokenAddress;
   const copy=el('button','复制 CA','copy-ca');copy.type='button';copy.setAttribute('aria-label','复制 '+r.symbol+' 合约地址');copy.addEventListener('click',async e=>{if(!e.isTrusted)return;try{await navigator.clipboard.writeText(r.tokenAddress);copy.textContent='已复制';}catch{copy.textContent='请从详情复制';}});address.append(code,copy);name.append(address);
   const desc=info.description||(info.error&&!has?'简介暂不可用':info.metadataStatus==='loading'||!has?'简介读取中…':info.metadataStatus==='unavailable'?'简介暂不可用':info.metadataStatus==='unsupported'?'简介来源尚未支持':'未提供简介');name.append(el('p',desc,'scan-description'));
   const socials=el('div',undefined,'scan-socials');for(const x of info.links||[]){const href=safeLink(x.url);if(href)socials.append(link(x.label+' ↗',href));}name.append(socials);
   const details=el('details',undefined,'scan-details');details.open=expanded.has(key);details.append(el('summary','信息与分配明细'));let detailsBuilt=false;
   function fillDetails(){if(detailsBuilt)return;detailsBuilt=true;
   if(info.description)details.append(el('p','项目方简介：'+info.description,'scan-full-description'));
   const data=el('dl',undefined,'scan-fields');field(data,'完整 CA',r.tokenAddress);field(data,'创建者',info.creator||r.creator);field(data,'结算资产',info.quote?.symbol);field(data,'创建总量',info.totalSupply?num(info.totalSupply)+' '+(info.baseSymbol||r.symbol):null);field(data,'单钱包上限',info.maxWallet?num(info.maxWallet)+' '+(info.baseSymbol||r.symbol):null);
   if(d){field(data,'分红资产',d.asset?d.asset+'（'+d.assetAddress+'）':null);field(data,'最低持币门槛',d.minHolding!==null?num(d.minHolding)+' '+r.symbol:null);
    field(data,'累计计入持有人分红',d.allocated!==null?num(d.allocated)+' '+d.asset:null);field(data,'累计已领取',d.claimed!==null?num(d.claimed)+' '+d.asset:null);field(data,'累计收取代币税',d.totalTax!==null?num(d.totalTax)+' '+d.asset:null);field(data,'社区追加分红累计',d.manualRewards!==null?num(d.manualRewards)+' '+d.asset:null);
    field(data,d.allocationLabel,(d.splits||[]).map(x=>x.label+' '+num(x.percent,2)+'%').join(' / '));
   }
   if(info.buyback?.status==='configured'){field(data,'回购模块版本',info.buyback.moduleType);if(info.buyback.payee)field(data,'非回购部分收款地址（创建者可修改）',info.buyback.payee);}
   field(data,'数据区块',info.snapshotBlock?String(info.snapshotBlock):null);details.append(data);
   if(d?.note)details.append(el('p',d.note,'muted'));if(d?.sourceUrl&&safeLink(d.sourceUrl))details.append(link('查看机制来源 ↗',d.sourceUrl));}
   details.addEventListener('toggle',()=>{if(!details.isConnected)return;if(details.open){expanded.add(key);fillDetails();}else expanded.delete(key);});if(details.open)fillDetails();
   const dividends=el('div',undefined,'scan-dividends');
   dividends.append(el('strong',!d?info.error?'分红读取未完成':'分红读取中…':d.allocationPercent>0?(d.status==='configured'?'分红配置 ':'分红权重 ')+num(d.allocationPercent,2)+'%':'未配置持币分红',d?.allocationPercent>0?'scan-dividend-positive':'scan-muted'));
   if(info.buyback?.status==='configured')dividends.append(el('strong','回购销毁 '+num(info.buyback.buybackPercent,2)+'%（接收方所得）','scan-dividend-positive'));
   if(d){dividends.append(el('p',(r.platform==='Flap'?'发行税配置：':r.variant==='v3'?'毕业后代币税：':'代币税：')+'买 '+num(d.buyTaxPercent,2)+'% / 卖 '+num(d.sellTaxPercent,2)+'%'));if(d.agentFeePercent!==undefined)dividends.append(el('p','Agent 费用 '+num(d.agentFeePercent,2)+'%'));
    dividends.append(el('small',d.status==='configured'?'配置不代表当前已派发':d.status==='enabled'?'按有效份额分配，不是收益率':'持有人分配比例为 0'));
   }
   const market=el('div',undefined,'scan-market');market.append(el('strong',r.phase!==undefined?r.mode:info.phaseLabel||r.mode));const rawProgress=r.progressBps??info.progressBps,progress=rawProgress===null||rawProgress===undefined?NaN:Number(rawProgress);if(Number.isFinite(progress)){const meter=el('progress');meter.max=10000;meter.value=Math.min(10000,Math.max(0,progress));meter.setAttribute('aria-label','内盘进度');market.append(el('p','进度 '+num(progress/100,2)+'%'),meter);}
   if(has)market.append(el('p',`${num(info.pool)} / ${num(info.cap)} ${info.quote?.symbol||''}`));if(info.holderCount!==undefined)market.append(el('p',`持有人 ${num(info.holderCount,0)}${info.statsComplete?'':'（部分统计）'}`));if(r.buyCount!==undefined||info.buyCount!==undefined)market.append(el('p',`买 ${num(r.buyCount??info.buyCount,0)} · 卖 ${num(r.sellCount??info.sellCount,0)}`));
   const status=el('div',undefined,'scan-status');status.append(el('strong',r.creationId?'市场 #'+r.creationId:r.chainTimestamp?new Date(r.chainTimestamp).toLocaleString('zh-CN',{hour12:false}):'区块 '+(r.blockNumber??'—')),el('p',r.stale?'目录待刷新':['flap-agent-directory','four-agent-directory','gang-agent-directory'].includes(r.source)?'目录已核验':r.confirmed?'创建已确认':'创建待确认'));
   if(r.platform==='Gang')status.append(link('Gang ↗','https://gang.fun/token/'+r.tokenAddress));
   if(r.platform==='Four.meme')status.append(link(scanLane(r)==='launched'?'Four.meme 外盘 ↗':'Four.meme ↗','https://four.meme/zh-TW/token/'+r.tokenAddress));
   if(info.error||info.stale)status.append(el('p',info.error?(info.chainUpdatedAt?'详情读取失败 · 保留上次数据':'详情读取失败 · 等待重试'):'详情待刷新','scan-warning'));if(info.chainUpdatedAt)status.append(el('small','详情 '+new Date(info.chainUpdatedAt).toLocaleTimeString('zh-CN',{hour12:false})));
   if(/^0x[\da-f]{64}$/i.test(r.txHash||''))status.append(link('创建交易 ↗','https://bscscan.com/tx/'+r.txHash));else if(/^0x[\da-f]{40}$/i.test(r.marketAddress||''))status.append(link('市场合约 ↗','https://bscscan.com/address/'+r.marketAddress));
   const facts=el('div',undefined,'scan-facts');facts.append(dividends,market);const open=el('button','K 线 / 交易 ↗','scan-open');open.addEventListener('click',e=>{if(e.isTrusted)onSelect(r.tokenAddress);});status.append(open);tr.append(name,facts,status,details);old?.node.remove();entries.set(key,{node:tr,signature,imageUrl:info.imageUrl});place(tr,lane,positions[lane]++);
  }
  for(const [key,entry]of entries)if(!keep.has(key)){entry.node.remove();entries.delete(key);}
  for(const [id,list]of Object.entries(lanes)){const empty=list.querySelector('.lane-empty');if(positions[id])empty?.remove();else if(!empty)list.append(el('p','暂无符合条件的代币','lane-empty'));countsUI[id].textContent=positions[id]===counts[id]?String(counts[id]):positions[id]+' / '+counts[id];more[id].hidden=positions[id]>=Math.min(counts[id],100);}
  $('scan-empty').hidden=shown.length>0;
 }
 function place(node,lane,index){const list=lanes[lane];if(list.children[index]!==node)list.insertBefore(node,list.children[index]||null);}
 return render;
}
