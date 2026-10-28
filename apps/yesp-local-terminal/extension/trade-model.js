export function parseCA(text){
 const value=String(text).trim();if(/^0x[\da-f]{40}$/i.test(value)&&!/^0x0{40}$/i.test(value))return value;
 try{const u=new URL(value);if(u.protocol!=='https:'||u.username||u.password||!['four.meme','flap.sh','gang.fun','www.gang.fun'].includes(u.hostname))return null;
  const candidates=[...u.pathname.matchAll(/0x[\da-f]{40}(?![\da-f])/ig)].map(x=>x[0]);
  for(const key of ['token','tokenAddress','ca']){const a=u.searchParams.get(key);if(/^0x[\da-f]{40}$/i.test(a||''))candidates.push(a);}
  const unique=[...new Set(candidates.map(x=>x.toLowerCase()))];return unique.length===1&&!/^0x0{40}$/i.test(unique[0])?unique[0]:null;
 }catch{return null;}
}
export function toRaw(text,decimals){if(!Number.isInteger(decimals)||decimals<0||decimals>36||!/^\d+(?:\.\d+)?$/.test(text))throw Error('AMOUNT_PRECISION');const [whole,f='']=text.split('.');if(f.length>decimals)throw Error('AMOUNT_PRECISION');return BigInt(whole)*10n**BigInt(decimals)+BigInt(f.padEnd(decimals,'0')||0);}
export function fromRaw(raw,decimals){const s=BigInt(raw).toString().padStart(decimals+1,'0');return decimals?(s.slice(0,-decimals)+'.'+s.slice(-decimals)).replace(/\.?0+$/,''):s;}
export function percentAmount(text,decimals,percent,classic=false){let n=toRaw(text,decimals)*BigInt(percent)/100n;if(classic)n=n/1000000000n*1000000000n;return fromRaw(n,decimals)||'0';}
export {slippageBps} from './slippage-policy.js';
export function transferBlocked(m){
 if(m?.protocol==='gang-curve'&&m.transferLocked)return 'Gang 内盘代币锁定转账，毕业解锁后才能转出；内盘仍可买卖。';
 if(m?.protocol==='flap-agent')return 'Flap 毕业前持仓是虚拟份额，不能转账。毕业并领取真实代币后才能转出。';
 if(m?.protocol==='openfour-agent'&&m.transferLocked)return 'Four Agent ID 内盘锁定钱包间转账，需迁移后才能转出；当前仍可按规则买卖。';
 return null;
}
export const terminal=new Set(['COMPLETE','FAILED','REJECTED','CANCELLED']);
export function buyRoom(m,h){if(m?.protocol==='dex-swap')return null;return h?.buyableTokenAmount??h?.buyable??(h?m?.offers:null)??null;}
