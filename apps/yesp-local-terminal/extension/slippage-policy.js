// One basis point precision. Keep the minimum output positive before rounding;
// zero-output plans are separately rejected by each trading route.
export const MAX_SLIPPAGE_BPS=9999n;
export function validateSlippageBps(value){
 if(typeof value!=='string'||!/^\d{1,4}$/.test(value)||BigInt(value)<1n||BigInt(value)>MAX_SLIPPAGE_BPS)throw Object.assign(Error('INVALID_SLIPPAGE'),{code:'INVALID_SLIPPAGE'});
 return BigInt(value);
}
export function slippageBps(value){
 if(typeof value!=='string'||!/^\d{1,2}(?:\.\d{1,2})?$/.test(value))throw Object.assign(Error('INVALID_SLIPPAGE'),{code:'INVALID_SLIPPAGE'});
 const [whole,decimals='']=value.split('.'),raw=String(Number(whole)*100+Number(decimals.padEnd(2,'0')));
 validateSlippageBps(raw);return raw;
}
