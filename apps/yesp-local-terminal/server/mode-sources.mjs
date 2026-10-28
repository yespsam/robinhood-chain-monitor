import {createHash} from 'node:crypto';
import {fault} from './flap-reader.mjs';
export const MODE_SOURCES=[
 {id:'four-open',platform:'four',name:'OpenFour 官方 GitHub',url:'https://github.com/four-meme-community/openfour-docs',api:'https://api.github.com/repos/four-meme-community/openfour-docs/commits?per_page=1',kind:'github'},
 {id:'four-classic',platform:'four',name:'Four.meme 官方 GitHub',url:'https://github.com/four-meme-community/fourmeme-docs',api:'https://api.github.com/repos/four-meme-community/fourmeme-docs/commits?per_page=1',kind:'github'},
 {id:'flap-runtime',platform:'flap',name:'Flap 官方组件 GitHub',url:'https://github.com/flap-sh/flap-vault-component-template',api:'https://api.github.com/repos/flap-sh/flap-vault-component-template/commits?per_page=1',kind:'github'},
 {id:'flap-vault',platform:'flap',name:'Flap 官方合约示例 GitHub',url:'https://github.com/flap-sh/FlapVaultExample',api:'https://api.github.com/repos/flap-sh/FlapVaultExample/commits?per_page=1',kind:'github'},
 {id:'flap-deployments',platform:'flap',name:'Flap 官方部署文档',url:'https://docs.flap.sh/flap/developers/deployed-contract-addresses.md',kind:'document'},
 {id:'flap-agent-app',platform:'flap',name:'Flap Agent 官方应用',url:'https://flap.sh/apps/agent-bonding-curve?lang=zh',kind:'artifact'},
 {id:'gang-contracts',platform:'gang',name:'Gang 官方合约 GitHub',url:'https://github.com/gangfun/gang-launchpad',api:'https://api.github.com/repos/gangfun/gang-launchpad/commits?per_page=1',kind:'github'},
 {id:'gang-cli',platform:'gang',name:'Gang 官方 CLI GitHub',url:'https://github.com/gangfun/cli',api:'https://api.github.com/repos/gangfun/cli/commits?per_page=1',kind:'github'}
];
const sha=text=>createHash('sha256').update(text).digest('hex');
const blobHosts=new Set(['lulxnvty7pwl9d1n.public.blob.vercel-storage.com','ev6a7r1khns6shhh.public.blob.vercel-storage.com']);
export async function boundedText(url,{fetcher=fetch,headers={}}={}){
 const r=await fetcher(url,{headers:{'User-Agent':'YESP-Local-Terminal','Accept':'application/json,text/plain,text/html',...headers},redirect:'error',signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw fault(r.status===403||r.status===429?'SOURCE_RATE_LIMITED':'SOURCE_UNAVAILABLE');
 let bytes=0,parts=[];for await(const part of r.body){bytes+=part.length;if(bytes>2000000)throw fault('SOURCE_TOO_LARGE');parts.push(Buffer.from(part));}
 return Buffer.concat(parts).toString('utf8');
}
export function parseFlapArtifact(html){
 const fragments=[...html.matchAll(/self\.__next_f\.push\(\[1,("(?:\\.|[^"\\])*")\]\)/g)].map(m=>JSON.parse(m[1]));const text=fragments.join('\n');
 const url=text.match(/"componentUrl":"(https:[^"]+\/agent-bonding-curve[^\s"]*\/component\.mjs)"/)?.[1]
  ||text.match(/"componentUrl":"(https:[^"]+\/[^\s"]*agent-bonding-curve[^\s"]*\/component\.mjs)"/)?.[1];
 const hash=text.match(/"componentSha256":"([a-f\d]{64})"/)?.[1];
 if(!url||!hash)throw fault('FLAP_ARTIFACT_UNAVAILABLE');const u=new URL(url);
 if(u.protocol!=='https:'||u.username||u.password||!blobHosts.has(u.hostname)||u.search||u.hash||!u.pathname.endsWith('/component.mjs'))throw fault('SOURCE_ORIGIN_INVALID');return {url,hash};
}
export function deploymentFromComponent(source){
 const values={};for(const [key,label]of [['factory','FACTORY_ADDRESS'],['portal','PORTAL_ADDRESS'],['reader','READER_ADDRESS']]){
  const matches=[...source.matchAll(new RegExp('(?:var|const) '+label+' = "(0x[0-9a-fA-F]{40})"','g'))];if(matches.length!==1)throw fault('FLAP_DEPLOYMENT_UNRECOGNIZED');values[key]=matches[0][1];}
 return values;
}
export function parseGithubAtom(text,source){
 const entry=text.match(/<entry>([\s\S]*?)<\/entry>/)?.[1],revision=entry?.match(/<id>tag:github\.com,2008:Grit::Commit\/([a-f\d]{40})<\/id>/i)?.[1];
 if(!revision||!entry.includes('href="'+source.url+'/commit/'+revision+'"')||!text.includes('href="'+source.url+'/commits/main.atom"'))throw fault('SOURCE_INVALID');
 const clean=s=>String(s||'').replace(/&#(x[\da-f]+|\d+);|&(amp|lt|gt|quot|apos);/gi,(_,n,k)=>{if(k)return {amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"}[k.toLowerCase()];const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return v>0&&v<=0x10ffff?String.fromCodePoint(v):'';}).replace(/<[^>]*>/g,'').trim();
 const title=clean(entry.match(/<title>([\s\S]*?)<\/title>/)?.[1]);if(!title)throw fault('SOURCE_INVALID');
 return {revision,link:source.url+'/commit/'+revision,title:title.slice(0,160),description:clean(entry.match(/<content[^>]*>([\s\S]*?)<\/content>/)?.[1]).slice(0,3000),publishedAt:entry.match(/<updated>([^<]*)<\/updated>/)?.[1]||null,transport:'github-atom'};
}
export function createSourceReader({fetcher=fetch,clock=Date.now}={}){
 const get=url=>boundedText(url,{fetcher});
 let apiRateLimitedUntil=0;
 return {async read(source,previous){
  if(!MODE_SOURCES.some(s=>s.id===source.id&&s.url===source.url))throw fault('SOURCE_ORIGIN_INVALID');
  if(source.kind==='github'){let result;
   if(clock()>=apiRateLimitedUntil)try{const rows=JSON.parse(await get(source.api)),c=rows?.[0];if(!/^[a-f\d]{40}$/i.test(c?.sha||'')||c.html_url!==source.url+'/commit/'+c.sha)throw fault('SOURCE_INVALID');
    result={revision:c.sha,link:c.html_url,title:String(c.commit?.message||'').split('\n')[0].slice(0,160),description:String(c.commit?.message||'').slice(0,3000),publishedAt:c.commit?.committer?.date||null,transport:'github-api'};
   }catch(e){if(e.code!=='SOURCE_RATE_LIMITED')throw e;apiRateLimitedUntil=clock()+3600000;}
   result??=parseGithubAtom(await get(source.url+'/commits/main.atom'),source);
   if(previous?.revision!==result.revision&&/^[a-f\d]{40}$/i.test(previous?.revision||'')){
    result.compareUrl=source.url+'/compare/'+previous.revision+'...'+result.revision;
    try{if(clock()<apiRateLimitedUntil)throw fault('SOURCE_RATE_LIMITED');const diff=JSON.parse(await get(source.api.split('/commits?')[0]+'/compare/'+previous.revision+'...'+result.revision));
     result.files=(diff.files||[]).slice(0,40).map(f=>({name:String(f.filename||'').slice(0,300),status:String(f.status||'').slice(0,30)}));result.commitCount=Number.isSafeInteger(diff.total_commits)?diff.total_commits:null;
    }catch{result.detailsUnavailable=true;}
   }return result;}
  const text=await get(source.url);
  if(source.kind==='artifact'){const artifact=parseFlapArtifact(text);if(previous?.revision===artifact.hash)return {revision:artifact.hash,link:source.url,title:previous.title,deployment:previous.deployment};
   const body=await get(artifact.url);if(sha(body)!==artifact.hash)throw fault('SOURCE_HASH_MISMATCH');
   let deployment=null;try{deployment=deploymentFromComponent(body);}catch{/* A changed app is evidence to review, never executable instructions. */}
   return {revision:artifact.hash,link:source.url,title:'官方应用组件 '+artifact.hash.slice(0,12),deployment};}
  if(!text.includes('Deployed Contract Addresses')||!text.includes('BNB Chain'))throw fault('SOURCE_INVALID');
  return {revision:sha(text),link:source.url,title:'部署文档内容指纹'};
 }};
}
