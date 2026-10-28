import {validateSlippageBps} from './slippage-policy.js';
export const FOUR_METHODS = new Set(['fourStatus','fourQuery','fourPrepare','fourExecute','fourReconcile']);
export const FOUR_ACTIONS = new Set(['fourBuy','fourSell','fourApprove']);
export function isFourPage(value) {
  try {const u=new URL(value);return u.origin==='https://four.meme'&&!u.username&&!u.password;}catch{return false;}
}
export function isOwnFourPage(value,id){try{const u=new URL(value);return u.protocol==='chrome-extension:'&&u.hostname===id&&u.pathname==='/four.html'&&!u.search;}catch{return false;}}
export function validateFourParams(method,p) {
  const fields={fourStatus:[],fourQuery:['tokenAddress'],fourPrepare:['tokenAddress','action','amount','slippageBps'],fourExecute:['previewId','intentId'],fourReconcile:['intentId','txHash']}[method];
  const fail=()=>{throw Object.assign(new Error('Four.meme request invalid.'),{code:'INVALID_REQUEST'});};
  const optional=method==='fourPrepare'?['buyMode']:[];
  if(!fields||!p||typeof p!=='object'||Array.isArray(p)||p.profile!=='fourmeme'||Object.keys(p).some(k=>!['profile',...fields,...optional].includes(k))
    ||fields.some(k=>typeof p[k]!=='string'||p[k].length>128))fail();
  if(fields.includes('tokenAddress')&&(!/^0x[\da-f]{40}$/i.test(p.tokenAddress)||/^0x0{40}$/i.test(p.tokenAddress)))fail();
  for(const k of ['previewId','intentId'])if(fields.includes(k)&&!/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(p[k]))fail();
  if(method==='fourPrepare'){
    if(!['buy','sell'].includes(p.action)||!/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(p.amount)||!/[1-9]/.test(p.amount))fail();
    validateSlippageBps(p.slippageBps);
  }
  // Old loaded panels omit this field and retain their original quote-budget units.
  if(p.buyMode!==undefined&&(method!=='fourPrepare'||p.action!=='buy'||p.buyMode!=='tokenAmount'))fail();
  if(method==='fourReconcile'&&!/^0x[\da-f]{64}$/i.test(p.txHash))fail();
  return p;
}
