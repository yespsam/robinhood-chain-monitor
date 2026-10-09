// Private RPC configuration: never export credentials through status objects.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';

export const PRIVATE_BSC_RPC_FILE='private-bsc-rpc.json';
export const CHAINSTACK_BSC_HOST='bsc-mainnet.core.chainstack.com';
const PUBLIC_HOSTS=new Set(['bsc-rpc.publicnode.com','public-bsc.nownodes.io','bsc.rpc.sentio.xyz']);
const protectedValues=new Set();
const failure=code=>Object.assign(new Error(code),{code});

function validateUrl(raw,protocol,privateOnly=false) {
  if(typeof raw!=='string'||raw.length>2048||raw.trim()!==raw||/[\s\\\u0000-\u001f]/u.test(raw))throw failure('INVALID_BSC_RPC_ENDPOINT');
  let url;try{url=new URL(raw);}catch{throw failure('INVALID_BSC_RPC_ENDPOINT');}
  if(url.protocol!==protocol||url.username||url.password||url.port||url.search||url.hash
    ||raw.includes('%')||raw.includes('/../')||raw.includes('/./'))throw failure('INVALID_BSC_RPC_ENDPOINT');
  if(url.hostname===CHAINSTACK_BSC_HOST) {
    if(!/^\/[A-Za-z0-9_-]{16,256}\/?$/u.test(url.pathname))throw failure('INVALID_BSC_RPC_ENDPOINT');
    protectedValues.add(url.pathname.replace(/^\/|\/$/gu,''));
    protectedValues.add(raw);
  }else if(privateOnly||!PUBLIC_HOSTS.has(url.hostname)||url.pathname!=='/'||protocol!=='https:') {
    throw failure('INVALID_BSC_RPC_ENDPOINT');
  }
  return url;
}

export function validateBscRpcEndpoints(endpoints) {
  if(!Array.isArray(endpoints)||endpoints.length<1||endpoints.length>4)throw failure('INVALID_BSC_RPC_ENDPOINTS');
  const seen=new Set();
  return Object.freeze(endpoints.map(value=>{
    if(!value||typeof value!=='object'||Array.isArray(value)
      ||Object.keys(value).some(k=>!['host','url','preferred'].includes(k))
      ||value.preferred!==undefined&&typeof value.preferred!=='boolean')throw failure('INVALID_BSC_RPC_ENDPOINT');
    const url=validateUrl(value.url,'https:');
    if(value.host!==url.hostname||seen.has(value.host))throw failure('INVALID_BSC_RPC_ENDPOINT');
    seen.add(value.host);
    return Object.freeze({host:value.host,url:value.url,...(value.preferred===true?{preferred:true}:{})});
  }));
}

function privateConfig(value) {
  if(!value||typeof value!=='object'||Array.isArray(value)||value.version!==1
    ||Object.keys(value).sort().join(',')!=='httpUrl,version,wsUrl')throw failure('INVALID_PRIVATE_BSC_RPC_CONFIG');
  const http=validateUrl(value.httpUrl,'https:',true),ws=validateUrl(value.wsUrl,'wss:',true);
  if(http.hostname!==ws.hostname||http.pathname!==ws.pathname)throw failure('INVALID_PRIVATE_BSC_RPC_CONFIG');
  return Object.freeze({httpUrl:value.httpUrl,wsUrl:value.wsUrl,host:http.hostname});
}

export function loadPrivateBscRpcConfig({dataDir}={}) {
  if(typeof dataDir!=='string'||!dataDir)throw failure('INVALID_PRIVATE_BSC_RPC_DIRECTORY');
  const file=path.join(dataDir,PRIVATE_BSC_RPC_FILE);let fd;
  try {
    fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const st=fs.fstatSync(fd);
    if(!st.isFile()||st.size>4096||(st.mode&0o077)!==0
      ||process.getuid&&st.uid!==process.getuid())throw failure('UNSAFE_PRIVATE_BSC_RPC_CONFIG');
    return privateConfig(JSON.parse(fs.readFileSync(fd,'utf8')));
  }catch(error){
    if(error.code==='ENOENT')return null;
    throw failure(error.code==='UNSAFE_PRIVATE_BSC_RPC_CONFIG'?'UNSAFE_PRIVATE_BSC_RPC_CONFIG':'INVALID_PRIVATE_BSC_RPC_CONFIG');
  }finally{if(fd!==undefined)fs.closeSync(fd);}
}

// One-time provisioning API. Called with endpoint values kept inside the local
// browser runtime; it neither prints them nor modifies .env or other accounts.
export function savePrivateBscRpcConfig({dataDir,httpUrl,wsUrl}={}) {
  if(typeof dataDir!=='string'||!dataDir)throw failure('INVALID_PRIVATE_BSC_RPC_DIRECTORY');
  const config=privateConfig({version:1,httpUrl,wsUrl});
  const dir=fs.lstatSync(dataDir);
  if(!dir.isDirectory()||dir.isSymbolicLink())throw failure('INVALID_PRIVATE_BSC_RPC_DIRECTORY');
  const file=path.join(dataDir,PRIVATE_BSC_RPC_FILE);
  const temporary=path.join(dataDir,`.private-bsc-rpc-${randomBytes(12).toString('hex')}.tmp`);
  let fd;
  try {
    fd=fs.openSync(temporary,'wx',0o600);
    fs.writeFileSync(fd,JSON.stringify({version:1,httpUrl:config.httpUrl,wsUrl:config.wsUrl})+'\n');
    fs.fsyncSync(fd);fs.closeSync(fd);fd=undefined;
    // link is atomic and cannot overwrite another configuration.
    fs.linkSync(temporary,file);
    return {saved:true,host:config.host,mode:'0600'};
  }catch(error){throw failure(error.code==='EEXIST'?'PRIVATE_BSC_RPC_CONFIG_EXISTS':'PRIVATE_BSC_RPC_SAVE_FAILED');}
  finally{if(fd!==undefined)fs.closeSync(fd);try{fs.unlinkSync(temporary);}catch(error){if(error.code!=='ENOENT')throw failure('PRIVATE_BSC_RPC_TEMP_CLEANUP_FAILED');}}
}

export function privateBscRpcEndpoints(config) {
  return validateBscRpcEndpoints([
    ...(config?[{host:config.host,url:config.httpUrl,preferred:true}]:[]),
    ...[...PUBLIC_HOSTS].map(host=>({host,url:`https://${host}`})),
  ]);
}

// Apply only to a consumer-owned configuration copy. Unreviewed consumers of
// the global config must not inherit a paid endpoint or spend its quota.
export function applyPrivateBscRpcConfig(target, privateRpc) {
  if (!privateRpc) return target;
  const prepend = (urls = []) => [...new Set([privateRpc.httpUrl, ...urls].filter(Boolean))];
  target.bscRpcUrls = prepend(target.bscRpcUrls || [target.bscRpcUrl]);
  target.bscRealtimeRpcUrls = prepend(target.bscRealtimeRpcUrls);
  target.bscArchiveRpcUrls = prepend(target.bscArchiveRpcUrls);
  target.bscCausalClassificationRpcUrls = prepend(target.bscCausalClassificationRpcUrls);
  target.bscRpcUrl = privateRpc.httpUrl;
  target.bscWsUrl = privateRpc.wsUrl;
  target.bscPreferredRpcHosts = [privateRpc.host];
  return target;
}

function scrub(value) {
  let text=String(value??'');
  for(const secret of [...protectedValues].sort((a,b)=>b.length-a.length))text=text.split(secret).join('[redacted]');
  text=text.replace(/(?:https?|wss?):\/\/[^\s<>"')\]}]+/giu,raw=>{
    try{return `${new URL(raw).protocol}//${new URL(raw).hostname}/[redacted]`;}catch{return '[redacted-url]';}
  });
  return text.replace(/\b(?:api[-_]?key|authorization|password|secret|access[-_]?token)\s*[=:]\s*[^\s,;]+/giu,'credential=[redacted]')
    .replace(/(?:https?|wss?)%3A%2F%2F[^\s<>"']+/giu,'[redacted-url]');
}

export function sanitizeBscRpcError(error) {
  const messages=[error?.shortMessage,error?.message,error?.reason,error?.error?.message,error?.info?.error?.message,
    error?.cause?.message].filter(x=>typeof x==='string'&&x);
  const code=typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{0,47}$/u.test(error.code)&&scrub(error.code)===error.code
    ?error.code:'RPC_READ_FAILED';
  const status=Number(error?.status??error?.statusCode);
  const retry=String(error?.retryAfter??'');
  const retryAfter=(/^\d+(?:\.\d+)?$/u.test(retry)||/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z, ]{0,5}\s[\w :,\-]+$/u.test(retry))
    &&retry.length<=128&&scrub(retry)===retry&&Number.isFinite(/^\d/.test(retry)?Number(retry):Date.parse(retry))?retry:undefined;
  return {name:['TypeError','AbortError'].includes(error?.name)?error.name:'Error',code,
    message:scrub([...new Set(messages)].join('; ')||'BSC RPC request failed').slice(0,600),
    ...(Number.isInteger(status)&&status>=100&&status<=599?{status}:{}),...(retryAfter!==undefined?{retryAfter}:{})};
}
