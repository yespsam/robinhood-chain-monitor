import {createHash} from 'node:crypto';
import {fault} from './flap-reader.mjs';
const gateways=['https://gateway.pinata.cloud','https://ipfs.filebase.io','https://flap.mypinata.cloud','https://magenta-naval-penguin-822.mypinata.cloud'];
const cid=/^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{20,126})$/;
const clean=(v,max=500)=>typeof v==='string'?v.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,' ').trim().slice(0,max):'';
export function assetUrls(input,kind='metadata'){
 if(typeof input!=='string'||input.length>1600||/[\s\\?#]/.test(input))return [];
 let ref=input.replace(/^ipfs:\/\//,'').replace(/^ipfs\//,'');
 if(input.startsWith('https://')){let u;try{u=new URL(input);}catch{return [];}
  if(u.username||u.password||u.port||u.search||u.hash)return [];
  if(kind==='image'&&u.hostname==='gang.fun'&&/^\/api\/logos\/[a-f\d]{16,64}\.(png|jpe?g|webp|gif)$/.test(u.pathname))return [u.href];
  if(kind==='image'&&u.hostname==='cdn.gang.fun'&&/^\/ipfs\/[A-Za-z0-9]+$/.test(u.pathname)&&cid.test(u.pathname.slice(6)))return [u.href];
  if(u.hostname==='static.four.meme'&&(kind==='metadata'?/^\/token-info\/bsc\/[\w-]+\.json$/:/^\/(?:market|token-info)\/[\w./-]+$/).test(u.pathname)&&!input.includes('..')&&!input.includes('%'))return [u.href];
  if(!u.pathname.startsWith('/ipfs/'))return [];ref=u.pathname.slice(6);
 }
 const [id,...path]=ref.split('/');if(!cid.test(id)||path.some(p=>!p||p==='.'||p==='..'||!/^[A-Za-z0-9._~-]+$/.test(p))||path.join('/').length>512)return [];
 return gateways.map(g=>g+'/ipfs/'+[id,...path].join('/'));
}
export function socialUrl(value){
 try{if(typeof value!=='string'||value.length>1500||/[\s\\]/.test(value))return null;const u=new URL(value);
  if(u.protocol!=='https:'||u.username||u.password||u.port||!u.hostname.includes('.')||/^[\d.]+$/.test(u.hostname)||u.hostname.includes(':')||/(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(u.hostname))return null;return u.href;
 }catch{return null;}
}
export function metadataFields(json){
 if(!json||typeof json!=='object'||Array.isArray(json))throw fault('METADATA_INVALID');
 const links=[],nested=json.links&&typeof json.links==='object'&&!Array.isArray(json.links)?json.links:{};
 for(const [key,label]of [['website','官网'],['twitter','X'],['telegram','Telegram'],['discord','Discord'],['github','GitHub']]){const url=socialUrl(json[key]||nested[key]);if(url)links.push({label,url});}
 return {description:clean(json.description,2000),links,imageUrls:assetUrls(json.image,'image')};
}
async function bounded(url,fetcher,max,signal){
 const r=await fetcher(url,{method:'GET',redirect:'error',credentials:'omit',headers:{'User-Agent':'YESP-Local-Terminal/1.4','Accept':'application/json,image/png,image/jpeg,image/webp,image/gif,text/plain'},signal:AbortSignal.any([signal,AbortSignal.timeout(4500)])});
 if(!r.ok){await r.body?.cancel();throw fault('METADATA_UNAVAILABLE');}
 if(Number(r.headers.get('content-length')||0)>max){await r.body?.cancel();throw fault('METADATA_TOO_LARGE');}
 let size=0,parts=[];for await(const p of r.body){size+=p.length;if(size>max)throw fault('METADATA_TOO_LARGE');parts.push(Buffer.from(p));}return {body:Buffer.concat(parts),type:r.headers.get('content-type')?.split(';')[0]?.toLowerCase()};
}
export function imageMime(body,type){
 if(!['image/png','image/jpeg','image/gif','image/webp','application/octet-stream'].includes(type))throw fault('IMAGE_FORMAT_UNSUPPORTED');
 if(body.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))return 'image/png';
 if(body[0]===255&&body[1]===216&&body[2]===255)return 'image/jpeg';
 if(/^GIF8[79]a$/.test(body.subarray(0,6).toString()))return 'image/gif';
 if(body.subarray(0,4).toString()==='RIFF'&&body.subarray(8,12).toString()==='WEBP')return 'image/webp';
 throw fault('IMAGE_FORMAT_UNSUPPORTED');
}
export function createScanMetadata({fetcher=fetch,clock=Date.now}={}){
 const cache=new Map(),refs=new Map(),images=new Map(),pending=new Map(),waiters=[];let imageBytes=0,imageActive=0;
 async function imageSlot(fn){if(imageActive>=4)await new Promise(r=>waiters.push(r));else imageActive++;try{return await fn();}finally{const next=waiters.shift();if(next)next();else imageActive--;}}
 async function fromUrls(urls,kind){const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);try{
  for(const url of urls){if(controller.signal.aborted)break;try{const data=await bounded(url,fetcher,kind==='image'?3*1024*1024:65536,controller.signal);if(kind==='image'){data.type=imageMime(data.body,data.type);return data;}return metadataFields(JSON.parse(data.body.toString('utf8')));}catch{}}
  throw fault(kind==='image'?'IMAGE_UNAVAILABLE':'METADATA_UNAVAILABLE');
 }finally{clearTimeout(timer);}}
 async function read(ref,{kind='metadata'}={}){const urls=assetUrls(ref,kind);if(!urls.length)return {metadataStatus:ref?'unsupported':'missing',description:'',links:[],imageUrl:null};
  if(kind==='image'){const id=createHash('sha256').update(urls[0]).digest('hex');refs.set(id,urls);while(refs.size>600)refs.delete(refs.keys().next().value);return {metadataStatus:'ready',description:'',links:[],imageUrl:'/api/token-image/'+id,metadataUpdatedAt:clock()};}
  const key=urls[0],old=cache.get(key);if(old&&clock()<old.until)return old.value;
  let value;try{const fields=await fromUrls(urls,'metadata');let imageUrl=null;if(fields.imageUrls.length){const id=createHash('sha256').update(fields.imageUrls[0]).digest('hex');refs.set(id,fields.imageUrls);while(refs.size>600)refs.delete(refs.keys().next().value);imageUrl='/api/token-image/'+id;}
   value={metadataStatus:'ready',description:fields.description,links:fields.links,imageUrl,metadataUpdatedAt:clock()};
  }catch{value={metadataStatus:'unavailable',description:'',links:[],imageUrl:null};}
  cache.set(key,{until:clock()+(value.metadataStatus==='ready'?600000:60000),value});while(cache.size>400)cache.delete(cache.keys().next().value);return value;
 }
 async function image(id){if(!/^[a-f\d]{64}$/.test(id)||!refs.has(id))throw fault('IMAGE_NOT_FOUND');const old=images.get(id);if(old){images.delete(id);images.set(id,old);return old;}if(pending.has(id))return pending.get(id);if(pending.size>=64)throw fault('IMAGE_BUSY');
  const urls=refs.get(id),promise=imageSlot(()=>fromUrls(urls,'image')).then(result=>{images.set(id,result);imageBytes+=result.body.length;while(imageBytes>16*1024*1024){const key=images.keys().next().value;imageBytes-=images.get(key).body.length;images.delete(key);}return result;}).finally(()=>pending.delete(id));pending.set(id,promise);return promise;
 }
 return {read,image};
}
