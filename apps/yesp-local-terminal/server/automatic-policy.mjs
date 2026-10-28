import {validatePanelParams} from '../extension/trade-policy.js';
import {validateSlippageBps} from '../extension/slippage-policy.js';
import {fault} from './flap-reader.mjs';
export const AUTO_ACTIONS=new Set(['panelAutoBuy','panelAutoSell']);
export function validateAutomatic(p){
 if(!p||typeof p!=='object'||Array.isArray(p)||Object.keys(p).some(k=>!['profile','tokenAddress','action','amount','sellPercent','slippageBps','swapSlippageBps','maxBnb','fundingMode','wallet','intentId'].includes(k))||p.profile!=='unified'||!['buy','sell'].includes(p.action)||!/^0x[\da-f]{40}$/i.test(p.wallet||'')||/^0x0{40}$/i.test(p.wallet)||! /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(p.intentId||''))throw fault('INVALID_REQUEST');
 if(p.fundingMode!==undefined&&(p.fundingMode!=='quantity'||p.action!=='buy'||p.maxBnb!==undefined))throw fault('INVALID_REQUEST');
 validatePanelParams('panelPrepare',{profile:'unified',tokenAddress:p.tokenAddress,action:p.action,...(p.sellPercent!==undefined?{sellPercent:p.sellPercent}:{amount:p.amount}),slippageBps:p.slippageBps,...(p.action==='buy'?{buyMode:'tokenAmount',funding:{...(p.fundingMode==='quantity'?{mode:'quantity'}:{maxBnb:p.maxBnb}),slippageBps:p.swapSlippageBps}}:{})});
 validateSlippageBps(p.swapSlippageBps);if(p.action==='sell'&&p.maxBnb!==undefined)throw fault('INVALID_REQUEST');return p;
}
