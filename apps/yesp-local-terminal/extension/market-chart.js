const $=id=>document.getElementById(id);
const timeText=time=>new Date(time*1000).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const number=n=>!Number.isFinite(n)?'—':n===0?'0':Math.abs(n)<0.0001?n.toExponential(4):new Intl.NumberFormat('en-US',{maximumSignificantDigits:7}).format(n);
const messages={CHART_UNSUPPORTED_MODE:'K 线目前支持 Four Agent ID 和 Flap Agent 内盘。',CHART_REORG:'区块正在更新，稍后重新读取。',CHART_LOG_LIMIT:'该区间成交过多，暂时无法完整读取。',RPC_UNAVAILABLE:'行情节点暂时不可用。',RPC_INVALID_RESPONSE:'行情节点返回异常。',STALE_BLOCK:'行情节点数据滞后。',CHART_MARKET_CHANGED:'市场信息已变化，请重新识别 CA。'};
Object.assign(messages,{GMGN_NOT_CONFIGURED:'请展开“GMGN 数据设置”填写 API Key。',GMGN_INVALID_KEY:'GMGN 拒绝了凭据，请检查 Key 和账户访问权限。',GMGN_PLAN_REQUIRED:'当前 GMGN 套餐不支持此接口。',GMGN_RATE_LIMITED:'GMGN 达到请求限额，已暂停请求并等待配额恢复。',GMGN_NO_DATA:'GMGN 暂无这个 CA 的 K 线，可能尚未收录或尚无成交。',GMGN_INVALID_RESPONSE:'GMGN 返回的数据未通过校验。',GMGN_UNAVAILABLE:'GMGN 行情暂时不可用，请检查网络。',GMGN_BUSY:'正在读取其他行情，请稍候。',GMGN_CONFIG_CHANGED:'GMGN 设置已变化，正在重新读取。',GMGN_CONFIG_INVALID:'本机 GMGN 设置无法读取，请重新保存。'});
const chainCaption='链上图按真实成交的支付 / 到账金额除以数量聚合，含费用影响；价格使用原结算币。';

export function setupMarketChart({client}){
 const canvas=$('price-chart'),ctx=canvas.getContext('2d');
 let selected=null,data=null,interval=60,generation=0,busy=false,viewBars=75,endBucket=null,hover=null,drag=null,layout=null,source='auto';
 function note(text){$('chart-status').textContent=text;}
 function buttons(){for(const b of document.querySelectorAll('[data-chart-interval]'))b.classList.toggle('active',Number(b.dataset.chartInterval)===interval);
  $('chart-older').disabled=busy||!data?.hasOlder;$('chart-refresh').disabled=busy||!selected;}
 function latestBucket(){return data?.candles.length?Math.floor(data.candles.at(-1).time/interval):null;}
 function facts(c){$('chart-ohlc').textContent=c?`${timeText(c.time)}  O ${number(c.open)}  H ${number(c.high)}  L ${number(c.low)}  C ${number(c.close)}  · 成交量 ${number(c.volume)}${data?.source==='gmgn'?` · 成交额 $${number(c.quoteVolume)}`:` · ${c.trades} 笔`}${c.partial?' · 当前周期未完整':''}`:'移动到蜡烛上查看开、高、低、收及成交量';}
 let frame=null;
 function draw(){if(frame===null)frame=requestAnimationFrame(()=>{frame=null;paint();});}
 function paint(){
  if(document.hidden)return;
  const rect=canvas.getBoundingClientRect();if(rect.width<10)return;
  const width=Math.round(rect.width),height=360,ratio=window.devicePixelRatio||1;
  const pixelWidth=Math.round(width*ratio),pixelHeight=Math.round(height*ratio);
  if(canvas.width!==pixelWidth)canvas.width=pixelWidth;if(canvas.height!==pixelHeight)canvas.height=pixelHeight;
  ctx.setTransform(ratio,0,0,ratio,0,0);ctx.clearRect(0,0,width,height);
  const left=8,right=Math.min(100,width*0.25),top=20,priceBottom=250,volumeTop=275,bottom=329,plotW=width-left-right;
  ctx.font='11px Segoe UI, Microsoft YaHei, sans-serif';ctx.lineWidth=1;ctx.fillStyle='#8b98a6';layout=null;
  if(!data?.candles.length){ctx.textAlign='center';ctx.fillText(selected?(busy?'正在读取行情…':'暂无 K 线，请查看下方数据状态'):'输入 CA，识别代币后显示 K 线',width/2,170);facts(null);return;}
  const last=latestBucket(),end=endBucket??last+1,start=end-viewBars,step=plotW/viewBars;
  const visible=data.candles.filter(c=>c.time/interval>=start&&c.time/interval<end);
  if(!visible.length){ctx.textAlign='center';ctx.fillText('此时间段暂无成交，拖动或点击“最新”',width/2,170);return;}
  let low=Math.min(...visible.map(c=>c.low)),high=Math.max(...visible.map(c=>c.high));const spread=Math.max(high-low,high*0.015,Number.MIN_VALUE)*0.12;low=Math.max(0,low-spread);high+=spread;
  const y=value=>priceBottom-(value-low)/(high-low)*(priceBottom-top),x=time=>left+(time/interval-start+0.5)*step;
  ctx.strokeStyle='#29313a';ctx.textAlign='left';
  for(let i=0;i<=4;i++){const value=low+(high-low)*i/4,yy=y(value);ctx.beginPath();ctx.moveTo(left,yy);ctx.lineTo(width-right,yy);ctx.stroke();ctx.fillText(number(value),width-right+7,yy+4);}
  const maxVolume=Math.max(1,...visible.map(c=>c.volume));
  for(const c of visible){const xx=x(c.time),color=c.close>=c.open?'#82e9b0':'#ff8b99',w=Math.max(1,Math.min(step*0.64,15));ctx.strokeStyle=color;ctx.fillStyle=color;
   ctx.beginPath();ctx.moveTo(xx,y(c.high));ctx.lineTo(xx,y(c.low));ctx.stroke();ctx.fillRect(xx-w/2,Math.min(y(c.open),y(c.close)),w,Math.max(1,Math.abs(y(c.open)-y(c.close))));
   ctx.globalAlpha=0.42;ctx.fillRect(xx-w/2,bottom-(c.volume/maxVolume)*(bottom-volumeTop),w,(c.volume/maxVolume)*(bottom-volumeTop));ctx.globalAlpha=1;
  }
  ctx.fillStyle='#8b98a6';ctx.fillText('成交量',left,volumeTop-7);
  const labelCount=width<500?2:4;ctx.textAlign='center';
  for(let i=0;i<labelCount;i++){const bucket=Math.floor(start+viewBars*(i+0.5)/labelCount);ctx.fillText(timeText(bucket*interval).slice(6),x(bucket*interval),350);}
  layout={left,right,plotW,step,start,end,x,y,width,height};
  const target=hover===null?null:visible.find(c=>Math.floor(c.time/interval)===Math.floor(start+(hover-left)/step));
  facts(target||visible.at(-1));
  if(target){const xx=x(target.time);ctx.strokeStyle='#8b98a6';ctx.setLineDash([3,4]);ctx.beginPath();ctx.moveTo(xx,top);ctx.lineTo(xx,bottom);ctx.stroke();ctx.setLineDash([]);}
 }
 async function load(older=false){
  if(!selected||busy||!client.local)return;const rev=generation,ca=selected.tokenAddress,period=interval;busy=true;buttons();if(!data)draw();note(older?'正在读取更早的 K 线…':'正在更新行情…');
  try{const result=await client.sendMessage({id:crypto.randomUUID(),method:'chartQuery',params:{tokenAddress:ca,interval:period,source,...(older?{older:true}:{})}});
   if(rev!==generation)return;if(!result.ok)throw Error(result.error?.code||'CHART_UNAVAILABLE');
   const next=result.data?.chart;if(!next||next.tokenAddress.toLowerCase()!==ca.toLowerCase()||next.interval!==period)throw Error('CHART_RESPONSE_MISMATCH');
   if(data&&data.source!==next.source){endBucket=null;hover=null;}data=next;$('chart-unit').textContent=`${next.quoteSymbol} / ${selected.base.symbol}`;$('chart-last').textContent=next.candles.length?number(next.candles.at(-1).close):'—';
   $('chart-caption').textContent=next.source==='gmgn'?'GMGN 美元行情 · 成交量为代币数量，成交额为 USD。仅供看图，买卖仍以平台合约报价为准。':chainCaption;
   note(`${next.source==='gmgn'?`GMGN · ${next.candles.length} 根 K 线`:`链上成交 ${next.tradeCount} 笔`} · ${timeText(next.fromTime)} — ${timeText(next.toTime)}${next.truncated?' · 已截取最近 1600 根 K 线':''}${next.fallbackReason?` · 已使用链上图：${messages[next.fallbackReason]||next.fallbackReason}`:''}`);draw();
  }catch(e){if(rev!==generation)return;note(`${messages[e.message]||'K 线读取未完成'}（${e.message}）${data?' · 保留上次数据':''}`);}
  finally{if(rev===generation){busy=false;buttons();draw();}}
 }
 function select(m){
  if(selected?.tokenAddress.toLowerCase()===m?.tokenAddress.toLowerCase())return;
  selected=m;generation++;busy=false;data=null;hover=null;endBucket=null;$('chart-last').textContent='—';$('chart-unit').textContent=m?`${m.quote.symbol} / ${m.base.symbol}`:'选择代币';
  $('chart-caption').textContent='优先读取 GMGN 美元行情；新币尚未收录时可查看 Agent 内盘链上成交。';note(m?'正在读取行情…':'输入 CA 后读取图表；GMGN 数据设置可在下方填写。');buttons();draw();if(m)void load();
 }
 function reset(){generation++;busy=false;data=null;hover=null;endBucket=null;$('chart-last').textContent='—';$('chart-unit').textContent=selected?'等待行情':'选择代币';buttons();draw();void load();}
 $('chart-source').addEventListener('change',()=>{source=$('chart-source').value;reset();});
 async function setting(method,params={}){const result=await client.sendMessage({id:crypto.randomUUID(),method,params});if(!result.ok)throw Error(result.error?.code||'LOCAL_REQUEST_FAILED');return result.data.gmgn;}
 function configStatus(v){$('gmgn-config-status').textContent=v?.configured?'API Key 已保存到本机；识别 CA 后检验行情连接。':'尚未配置 GMGN API Key。';$('gmgn-clear').disabled=!v?.configured;}
 async function saveConfig(apiKey){$('gmgn-save').disabled=true;$('gmgn-clear').disabled=true;
  try{configStatus(await setting('gmgnConfigure',{apiKey}));$('gmgn-key').value='';reset();}
  catch(e){$('gmgn-config-status').textContent=`${messages[e.message]||'设置未保存，请重试'}（${e.message}）`;}
  finally{$('gmgn-save').disabled=false;}
 }
 $('gmgn-config-form').addEventListener('submit',e=>{e.preventDefault();const key=$('gmgn-key').value.trim();if(!key){$('gmgn-config-status').textContent='请填写 API Key。';return;}void saveConfig(key);});
 $('gmgn-clear').addEventListener('click',()=>void saveConfig(''));
 if(client.local)void setting('gmgnStatus').then(configStatus).catch(e=>{$('gmgn-config-status').textContent=`无法读取 GMGN 设置（${e.message}）`;});
 else {$('gmgn-settings').hidden=true;$('chart-source').disabled=true;}
 for(const button of document.querySelectorAll('[data-chart-interval]'))button.addEventListener('click',()=>{const next=Number(button.dataset.chartInterval);if(interval===next)return;interval=next;generation++;busy=false;data=null;endBucket=null;buttons();draw();void load();});
 $('chart-refresh').addEventListener('click',()=>void load());$('chart-older').addEventListener('click',()=>void load(true));$('chart-latest').addEventListener('click',()=>{endBucket=null;viewBars=75;draw();});
 canvas.addEventListener('pointermove',e=>{hover=e.clientX-canvas.getBoundingClientRect().left;if(drag&&layout){endBucket=Math.round(drag.end-(e.clientX-drag.x)/layout.step);const last=latestBucket();endBucket=Math.min(last+viewBars/2,Math.max(Math.floor(data.candles[0].time/interval)+1,endBucket));}draw();});
 canvas.addEventListener('pointerleave',()=>{hover=null;if(!drag)draw();});
 canvas.addEventListener('pointerdown',e=>{if(layout){drag={x:e.clientX,end:layout.end};canvas.setPointerCapture(e.pointerId);}});
 const release=()=>{drag=null;};canvas.addEventListener('pointerup',release);canvas.addEventListener('pointercancel',release);
 canvas.addEventListener('wheel',e=>{if(!data?.candles.length)return;e.preventDefault();viewBars=Math.max(15,Math.min(400,Math.round(viewBars*(e.deltaY>0?1.2:0.8))));draw();},{passive:false});
 new ResizeObserver(draw).observe(canvas);buttons();draw();
 setInterval(()=>{if(!document.hidden&&canvas.clientWidth>0)void load();},6000);
 return {select};
}
