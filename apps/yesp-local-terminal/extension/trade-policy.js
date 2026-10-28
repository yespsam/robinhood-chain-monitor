import {validateFourParams} from './four-policy.js';
import {validateSlippageBps} from './slippage-policy.js';
export const PANEL_METHODS=new Set(['panelStatus','panelQuery','panelPrepare','panelExecute','panelReconcile']);
export const PANEL_ACTIONS=new Set(['panelBuy','panelSell','panelApprove','panelClaim','panelWrap','panelFund','panelConvert']);
export function isTradePage(url,id){try{const u=new URL(url);return u.protocol==='chrome-extension:'&&u.hostname===id&&u.pathname==='/trade.html'&&!u.search;}catch{return false;}}
export function validatePanelParams(method,p){
 if(!PANEL_METHODS.has(method)||p?.profile!=='unified')throw Object.assign(new Error('Invalid panel request'),{code:'INVALID_REQUEST'});
 const mapped=method.replace('panel','four'),copy={...p,profile:'fourmeme'};
 if(p.funding!==undefined){const f=p.funding;
  const quantity=f?.mode==='quantity'&&Object.keys(f).length===2&&Object.hasOwn(f,'slippageBps');
  const budgeted=f&&typeof f==='object'&&!Array.isArray(f)&&Object.keys(f).length===2&&Object.hasOwn(f,'maxBnb')&&Object.hasOwn(f,'slippageBps')&&typeof f.maxBnb==='string'&&/^(?:0|[1-9]\d{0,5})(?:\.\d{1,18})?$/.test(f.maxBnb)&&/[1-9]/.test(f.maxBnb);
  if(method!=='panelPrepare'||p.action!=='buy'||!f||typeof f!=='object'||Array.isArray(f)||!quantity&&!budgeted)throw Object.assign(new Error('Invalid funding request'),{code:'INVALID_REQUEST'});
  validateSlippageBps(f.slippageBps);delete copy.funding;
 }
 if(p.sellPercent!==undefined){
  if(method!=='panelPrepare'||p.action!=='sell'||!['25','50','75','100'].includes(p.sellPercent)||p.amount!==undefined||p.buyMode!==undefined)throw Object.assign(new Error('Invalid percentage order'),{code:'INVALID_REQUEST'});
  delete copy.sellPercent;copy.amount='1';
 }
 if(method==='panelPrepare'&&p.action==='claim')copy.action='sell';
 validateFourParams(mapped,copy);
 if(method==='panelPrepare'&&p.action==='buy'&&p.buyMode!=='tokenAmount')throw Object.assign(new Error('Quantity required'),{code:'INVALID_REQUEST'});
 return p;
}
