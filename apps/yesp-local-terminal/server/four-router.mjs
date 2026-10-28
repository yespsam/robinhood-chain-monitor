import {createFlapRpc} from './flap-reader.mjs';
import {createFourReader} from './four-reader.mjs';
import {createOpenFourReader} from './openfour-reader.mjs';
export function createFourRouter({rpc=createFlapRpc({timeoutMs:10000}),clock=Date.now}={}){
  const classic=createFourReader({rpc,clock}),open=createOpenFourReader({rpc,clock});
  const reader=m=>m.protocol==='openfour-agent'?open:classic;
  async function inspect(address){try{return await classic.inspect(address);}catch(e){if(e.code!=='NOT_FOUR_TOKEN')throw e;return open.inspect(address);}}
  return {rpc,inspect,holdings:(m,w)=>reader(m).holdings(m,w),recheck:p=>reader(p).recheck(p),
    async build(p,w){const m=await inspect(p.tokenAddress);return reader(m).build(p,w);}};
}
