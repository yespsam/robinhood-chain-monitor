import { parseOfficialXOembed } from './twitter-monitor.js';

export function narrativeLearningPermalink(value) {
  try {
    const u=new URL(value);
    return u.protocol==='https:'&&!u.username&&!u.password&&!u.port
      && ['x.com','twitter.com','www.x.com','www.twitter.com'].includes(u.hostname)
      && /^\/[A-Za-z0-9_]{1,15}\/status\/\d{1,25}$/.test(u.pathname)
      ? `https://x.com${u.pathname.toLowerCase()}` : null;
  } catch { return null; }
}

// Only an exact public post already linked by GMGN is read. No arbitrary host,
// login, API secret, page scripts, or promotion to issuer/KOL identity.
export async function readNarrativeLearningSource(url,{fetchImpl=fetch,now=Date.now}={}) {
  const canonical=narrativeLearningPermalink(url);
  if(!canonical)return {url,status:'unavailable',observedAt:now(),reason:'invalid_public_post_link'};
  const [,handle,,id]=new URL(canonical).pathname.split('/');
  try {
    const response=await fetchImpl(`https://publish.x.com/oembed?omit_script=true&dnt=true&url=${encodeURIComponent(canonical)}`,
      {redirect:'error',signal:AbortSignal.timeout(8000),headers:{Accept:'application/json'}});
    if(!response.ok)throw new Error('source_unavailable');
    if(Number(response.headers.get('content-length'))>131072)throw new Error('source_too_large');
    const reader=response.body.getReader(),chunks=[];let size=0;
    try { for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>131072)throw new Error('source_too_large');chunks.push(Buffer.from(value));} }
    finally { await reader.cancel().catch(()=>{}); }
    const text=parseOfficialXOembed(Buffer.concat(chunks).toString('utf8'),handle,id);
    const at=Number((BigInt(id)>>22n)+1288834974657n),observedAt=now();
    if(!Number.isSafeInteger(at)||at>observedAt||observedAt-at>7*86400000)throw new Error('source_time_unusable');
    return {status:'ok',url:canonical,author:handle,text:text.slice(0,4000),at,observedAt,
      sourceVerifiedBy:'official_x_oembed',timestampKind:'x_snowflake',replyQuoteStatus:'unknown'};
  } catch { return {status:'unavailable',url:canonical,observedAt:now(),reason:'原文核验失败、过期或接口不可用；不生成替代文案'}; }
}
