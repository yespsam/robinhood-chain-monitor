import {readFileSync} from 'node:fs';
import {fault,same} from './flap-reader.mjs';
import {FLAP_MARKET} from './flap-market.mjs';
import {tokenAddress} from './four-reader.mjs';
// Local release configuration, never populated from downloaded GitHub content.
export function reviewedFlapDeployments(){
 const p=JSON.parse(readFileSync(new URL('../config/reviewed-modes.json',import.meta.url),'utf8'));
 if(p.version!==1||!Array.isArray(p.flap)||p.flap.length>20)throw fault('MODE_CONFIG_INVALID');
 const extra=p.flap.map(d=>{
  if(d.adapter!=='flap-agent-v1'||!d.name||typeof d.name!=='string'||d.name.length>80||!d.fingerprints||typeof d.fingerprints!=='object')throw fault('MODE_CONFIG_INVALID');
  const out={adapter:d.adapter,name:d.name,sourceUrl:d.sourceUrl,reviewedFingerprints:d.fingerprints};for(const k of ['factory','portal','reader'])out[k]=tokenAddress(d[k]);
  if(!/^https:\/\/(?:docs\.flap\.sh\/|flap\.sh\/|github\.com\/flap-sh\/)/.test(d.sourceUrl||''))throw fault('MODE_CONFIG_INVALID');
  if(Object.keys(d.fingerprints).length<3||Object.keys(d.fingerprints).length>50||['factory','portal','reader'].some(k=>!d.fingerprints[out[k].toLowerCase()]))throw fault('MODE_CONFIG_INVALID');
  return out;
 });
 const rows=[{...FLAP_MARKET,adapter:'flap-agent-v1',name:'Flap ID AGENT CURVE',sourceUrl:'https://flap.sh/apps/agent-bonding-curve?lang=zh'},...extra];
 if(new Set(rows.map(x=>x.factory.toLowerCase())).size!==rows.length)throw fault('MODE_CONFIG_INVALID');return rows;
}
export const agentPresetKeys=['version','validator','tokenModuleId','vaultModuleId','curveModuleId','tradeModuleId','migrateModuleId','tokenImplId','customDataId'];
export function sameAgentPreset(p,reference){return p.version==='1.0.0'&&agentPresetKeys.every(k=>String(p[k]).toLowerCase()===String(reference[k]).toLowerCase());}
