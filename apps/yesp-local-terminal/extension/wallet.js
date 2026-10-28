import {client} from './client-bridge.js';
import { isOfficialSigninUrl } from './signin-policy.js';
const $=id=>document.getElementById(id);
const terminal=new Set(['COMPLETE','FAILED','REJECTED','CANCELLED']);
const messages={INVALID_ADDRESS:'地址无效或大小写校验失败，请重新核对完整地址。',INVALID_AMOUNT:'请输入大于零的普通十进制数量。',
  AMOUNT_PRECISION:'数量小数位超过代币精度，请减少小数位。',INSUFFICIENT_BALANCE:'所选代币余额不足。',INSUFFICIENT_GAS:'BNB 不足，请留足网络费。',
  SELF_TRANSFER:'收款地址与当前钱包相同，请核对。',LOGIN_REQUIRED:'请先扫码连接币安钱包。',LOGIN_FLOW_REQUIRED:'请先点击扫码连接，再验证连接。',
  WALLET_LOCKED:'币安钱包有待处理交易，请在币安 App 中完成确认或拒绝后刷新。',PENDING_TRANSACTION:'钱包有待确认交易，请先等待确认。',
  PREVIEW_EXPIRED:'转出信息已过期或钱包状态发生变化，请重新核对。',UNRESOLVED_TRADE_EXISTS:'已有操作结果待核验，请先处理上一笔。',
  TRADE_PENDING:'已有操作结果待核验，请先处理上一笔。',NATIVE_UNAVAILABLE:'本机连接程序不可用，请检查安装并刷新。',
  TOKEN_NOT_CONTRACT:'此地址不是 BSC 代币合约。',TOKEN_DECIMALS_UNSUPPORTED:'暂不支持此代币精度。',
  TOKEN_BALANCE_UNAVAILABLE:'币安未返回该代币余额；价值低于 0.01 美元的资产可能被隐藏，请在币安 App 处理。',
  TOKEN_UNIT_MISMATCH:'币安显示数量与链上数量不同，可能为 RWA 换算资产或余额尚未同步；本页停止转出，请在币安 App 处理。',
  WALLET_CHANGED:'当前钱包已变化，请重新核对。',WRONG_NETWORK:'节点网络不匹配，已停止操作。',STALE_BLOCK:'链上数据过期，请稍后刷新。',
  RPC_UNAVAILABLE:'BSC 节点暂不可用，请稍后重试读取。',RPC_CALL_FAILED:'链上检查未通过，可能是余额不足或代币限制转出。',
  TRANSFER_IDENTITY_MISMATCH:'交易与本次转出记录不符，已拒绝绑定，请核对交易哈希。',TRANSACTION_NOT_FOUND:'尚未找到该交易，请稍后核验。',
  TIMEOUT:'读取超时，请刷新状态。',UNKNOWN:'提交结果待核验，请勿再次提交。',SUBMISSION_UNKNOWN:'提交结果待核验，请在币安 App 查看记录。',
  READ_FAILED:'钱包状态读取失败，请检查网络或重新扫码连接。',OFFICIAL_REJECTED:'币安拒绝了请求，请检查钱包状态和地址簿。',
  AUTH_URL_REVIEW_REQUIRED:'币安返回的登录链接未通过校验，已停止打开。',QR_CODE_EXPIRED:'登录二维码已过期，请重新获取。',
  QR_CODE_INVALID:'登录二维码已失效，请重新获取。',QR_CODE_GENERATE_FAILED:'币安未能生成登录二维码，请稍后重新获取。',
  AUTH_REJECTED:'币安未接受本次登录，请重新获取二维码并在 App 中确认。',
  LOGIN_API_ERROR:'币安登录接口返回错误，请稍后重新获取二维码。',VERIFY_API_ERROR:'币安登录验证失败，请重新获取二维码。',
  NETWORK_ERROR:'连接币安失败，请检查网络代理后重新获取二维码。',REQUEST_TIMEOUT:'币安请求超时，请稍后重新获取二维码。',
  UNRESOLVED_TRADE_LOCK:'本机有未结束的操作，请等待；若程序异常退出，请保留记录后联系维护者核验。'};
let wallet={connected:false},preview=null,operation=null,guard=null,busy=false,polling=false,signinFlow=null,loginNotice=false;
function message(title,text){$('status-title').textContent=title;$('status-message').textContent=text;}
function clearSignin(){
  signinFlow=null;$('signin-details').hidden=true;$('signin-qr').hidden=true;$('signin-qr').removeAttribute('src');
  $('signin-link').hidden=true;$('signin-link').removeAttribute('href');$('pairing').hidden=true;$('pairing-code').textContent='';
}
function showSignin(data){
  clearSignin();
  if(!isOfficialSigninUrl(data?.urlForWeb)||!Number.isSafeInteger(Number(data.expireAt))||Number(data.expireAt)<=Date.now()
    ||typeof data.pairingCode!=='string'||!/^[A-Za-z0-9]{1,64}$/.test(data.pairingCode)) {
    message('登录信息不可用','请重新获取登录二维码；若仍失败，请检查页面底部的错误提示。');return false;
  }
  signinFlow={expiresAt:Number(data.expireAt)};
  $('signin-details').hidden=false;$('signin-link').href=data.urlForWeb;$('signin-link').hidden=false;
  $('pairing-code').textContent=data.pairingCode;$('pairing').hidden=false;
  const image=data.qrImage;
  if(typeof image==='string'&&image.length<500000&&/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(image)){
    $('signin-qr').src=image;$('signin-qr').hidden=false;
  }
  message('请扫码连接钱包',$('signin-qr').hidden?'请点击上方“打开币安官方扫码页面”查看二维码。':'请用币安 App 扫描上方二维码，核对配对码并确认登录。');
  $('signin-details').scrollIntoView({block:'nearest',behavior:'smooth'});return true;
}
function invalidate(){preview=null;$('review').hidden=true;$('acknowledge').checked=false;render();}
function pending(){return Boolean(guard)||Boolean(operation&&!terminal.has(operation.status));}
function render(){
  $('connection').textContent=wallet.connected?'本机钱包已连接':'钱包尚未连接';
  $('wallet-address').textContent=wallet.address||'请使用下方按钮扫码连接';$('login').hidden=wallet.connected;
  $('custom-token').hidden=$('token').value!=='custom';
  for(const id of ['token','contract','recipient','amount']) $(id).disabled=busy;
  $('prepare').disabled=busy||!wallet.connected||pending();
  $('send').disabled=busy||!preview||!$('acknowledge').checked||Date.now()>=preview.expiresAt||pending();
  if(signinFlow&&Date.now()>=signinFlow.expiresAt){clearSignin();loginNotice=true;message('登录二维码已过期','请点击“获取登录二维码”重新连接。');}
  $('signin').disabled=$('cancel').disabled=$('reconcile').disabled=busy;
  $('verify').disabled=busy||!signinFlow;
  $('signin').textContent=signinFlow?'重新获取二维码':'获取登录二维码';
  if(signinFlow)$('signin-expiry').textContent=`二维码 ${Math.max(0,Math.ceil((signinFlow.expiresAt-Date.now())/1000))} 秒后过期，请保持此页面打开。`;
  $('refresh').disabled=busy||polling;
  const hash=operation?.txHash||guard?.txHash;
  $('transaction-link').hidden=!/^0x[\da-f]{64}$/i.test(hash||'');
  if(!$('transaction-link').hidden)$('transaction-link').href=`https://bscscan.com/tx/${hash}`;
  $('recover').hidden=operation?.action!=='transfer'||terminal.has(operation?.status)||Boolean(hash);
  if(preview){const seconds=Math.max(0,Math.ceil((preview.expiresAt-Date.now())/1000));$('expiry').textContent=seconds?`本次核对信息 ${seconds} 秒后过期。`:'核对信息已过期，请返回重新核对。';}
}
function absorb(data){
  if(data?.wallet) wallet=data.wallet;
  if(Object.hasOwn(data||{},'operation')) operation=data.operation;
  if(wallet.connected){clearSignin();loginNotice=false;}
  if(data?.reconcileError) message('结果仍待核验',messages[data.reconcileError.code]||`核验未完成（${data.reconcileError.code}），请勿重复转出。`);
  else if(operation) message(terminal.has(operation.status)?operation.status==='COMPLETE'?'转出已确认':'操作已结束':'操作处理中',operation.message||operation.status);
  render();
}
async function request(method,params={}){
  let response;
  try{response=await client.sendMessage({id:crypto.randomUUID(),method,params:{profile:'heyi',...params}});}
  catch{if(method==='transfer') guard={intentId:params.intentId,status:'UNKNOWN'};message('连接未完成',method==='transfer'?messages.UNKNOWN:messages.NATIVE_UNAVAILABLE);render();return null;}
  if(response?.guard!==undefined)guard=response.guard;
  if(!response?.ok){
    const code=response?.error?.officialName||response?.error?.code||'UNKNOWN';
    if(['signin','verify'].includes(method)){
      loginNotice=true;
      if(['AUTH_REJECTED','QR_CODE_EXPIRED','QR_CODE_INVALID','LOGIN_FLOW_REQUIRED','NATIVE_UNAVAILABLE'].includes(code))clearSignin();
    }
    message('操作未完成',`${messages[code]||'操作未完成，请核对状态；提交后切勿重复发送。'}（${code}）`);render();return null;
  }
  absorb(response.data);return response.data;
}
async function refresh(){if(busy||polling)return;polling=true;render();try{const result=await request('walletStatus');if(result&&!result.operation&&!signinFlow&&!loginNotice&&!busy)message(wallet.connected?'钱包已就绪':'请连接钱包',wallet.connected?'选择资产并填写收款信息后核对。':'点击“获取登录二维码”，在币安 App 中完成登录。');}finally{polling=false;render();}}
function showPreview(p){
  preview=p;$('acknowledge').checked=false;const dl=$('review-details');dl.replaceChildren();
  for(const [label,value] of [['网络','BNB Smart Chain（56）'],['转出钱包',p.wallet],['收款地址',p.recipient],['代币',p.symbol],['合约地址',p.tokenAddress],['转出数量',`${p.amount} ${p.symbol}`],['代币余额',p.balance],['预估网络费',`${p.estimatedFee} BNB`],['BNB 预留检查',`${p.gasReserve} BNB（不是最终费用上限）`]]){
    const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;dl.append(dt,dd);
  }
  $('review').hidden=false;$('review').scrollIntoView({block:'center',behavior:'smooth'});render();
}
for(const id of ['token','contract','recipient','amount'])$(id).addEventListener('input',invalidate);
$('token').addEventListener('change',invalidate);
$('transfer-form').addEventListener('submit',async e=>{
  e.preventDefault();if(!e.isTrusted||busy||$('prepare').disabled)return;invalidate();busy=true;render();message('正在核对','读取钱包、余额、代币精度与网络费。');
  try{const result=await request('transferPrepare',{recipient:$('recipient').value.trim(),tokenAddress:$('token').value==='custom'?$('contract').value.trim():$('token').value,amount:$('amount').value.trim()});
    if(result?.transferPreview){showPreview(result.transferPreview);message('请核对转出信息','核对完整地址、网络、合约与数量后，点击确认转出。');}}
  finally{busy=false;render();}
});
$('acknowledge').addEventListener('change',render);
$('cancel').addEventListener('click',e=>{if(e.isTrusted&&!busy)invalidate();});
$('send').addEventListener('click',async e=>{
  if(!e.isTrusted||$('send').disabled||!preview||busy)return;
  const previewId=preview.previewId,intentId=crypto.randomUUID();guard={intentId,status:'PENDING'};busy=true;invalidate();render();message('正在提交','请勿重复点击；若币安 App 要求确认，请在手机上处理。');
  try{await request('transfer',{previewId,intentId});}finally{busy=false;render();}await refresh();
});
$('signin').addEventListener('click',async e=>{
  if(!e.isTrusted||busy)return;clearSignin();loginNotice=true;busy=true;render();message('正在获取二维码','正在连接币安，请稍候…');
  let connected=false;
  try{const result=await request('signin');if(result?.urlForWeb)showSignin(result);else if(result?.connected)connected=true;}
  finally{busy=false;render();}
  if(connected){loginNotice=false;await refresh();}
});
$('verify').addEventListener('click',async e=>{
  if(!e.isTrusted||busy||$('verify').disabled)return;busy=true;loginNotice=true;render();message('等待扫码确认','请在手机上完成登录；验证最多等待 5 分钟，请保持此页面打开。');
  let result;try{result=await request('verify');}finally{busy=false;render();}
  if(result?.connected){clearSignin();loginNotice=false;await refresh();}
  else if(result){clearSignin();message('尚未连接成功','本机尚未确认登录，请重新获取二维码后再连接。');render();}
});
$('refresh').addEventListener('click',e=>{if(e.isTrusted){loginNotice=false;refresh();}});
$('open-four').addEventListener('click',e=>{if(e.isTrusted)request('openFour');});
$('reconcile').addEventListener('click',async e=>{if(!e.isTrusted||busy||!operation?.intentId)return;busy=true;render();try{await request('transferReconcile',{intentId:operation.intentId,txHash:$('recover-hash').value.trim()});}finally{busy=false;render();}});
client.onProgress(data=>{const m={data};{if(m.data?.guard!==undefined)guard=m.data.guard;if(m.data?.connection==='disconnected'){clearSignin();loginNotice=true;message('连接已中断','请重新获取登录二维码。');}render();}});
render();refresh();setInterval(()=>{render();if(!document.hidden)refresh();},15000);setInterval(render,1000);
