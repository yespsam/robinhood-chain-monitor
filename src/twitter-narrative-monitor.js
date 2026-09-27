import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseFxTwitterTimeline } from './twitter-monitor.js';
import { readNarrativeLearningSource } from './paper-narrative-learning-source.js';

// Public profile IDs checked on 2026-09-26 at api.fxtwitter.com/<handle>.
// These are source identities, not verified token issuers or wallet owners.
export const TWITTER_NARRATIVE_TARGETS = Object.freeze([
  { handle: 'beffjezos', id: '1556550048862928898', role: '事件人物' },
  { handle: 'UsePaid', id: '2092336225583861760', role: '平台来源' },
]);
const VERSION='twitter_narrative_watch_v1', WEEK=7*86400000;
const key=p=>`${p.author.toLowerCase()}:${p.id}`;
const targetFor=p=>TWITTER_NARRATIVE_TARGETS.find(t=>t.handle.toLowerCase()===p?.author?.toLowerCase());
function validPost(p,nowMs) {
  const target=targetFor(p);
  return target && p.userId===target.id && /^\d{1,25}$/.test(p.id)
    && p.url===`https://x.com/${p.author}/status/${p.id}` && typeof p.text==='string' && p.text.length<=4000
    && Number.isFinite(p.at) && Number.isFinite(p.observedAt) && p.at<=p.observedAt && p.observedAt<=nowMs
    && nowMs-p.at<=WEEK && p.verifiedBy==='official_x_oembed'
    && typeof p.isReply==='boolean' && typeof p.isQuote==='boolean';
}
async function boundedJson(response) {
  if(!response.ok)throw new Error(`公开时间线 HTTP ${response.status}`);
  const reader=response.body.getReader(),parts=[];let size=0;
  try {for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;
    if(size>524288)throw new Error('时间线响应过大');parts.push(Buffer.from(value));}}
  finally {await reader.cancel().catch(()=>{});}
  return JSON.parse(Buffer.concat(parts).toString('utf8'));
}
export function createTwitterNarrativeMonitor({dataDir,fetchImpl=fetch,sourceReader=readNarrativeLearningSource,now=Date.now}={}) {
  const file=path.join(dataDir,'twitter-narrative-state.json');
  let posts=[],health={},loaded=false,job=null,timer=null,stopped=false,started=false,lastError=null;
  async function initialize() {
    if(loaded)return;
    try {const stat=await fs.stat(file);if(stat.size>2*1024*1024)throw new Error('叙事文件过大');
      const saved=JSON.parse(await fs.readFile(file,'utf8'));
      if(saved.version!==VERSION||!Array.isArray(saved.posts))throw new Error('叙事文件格式错误');
      posts=saved.posts.filter(p=>validPost(p,now()));
    }catch(error){if(error.code!=='ENOENT')throw error;}
    loaded=true;
  }
  async function persist() {
    const temp=`${file}.${randomUUID()}.tmp`;
    await fs.mkdir(dataDir,{recursive:true});
    const h=await fs.open(temp,'wx',0o600);
    try {await h.writeFile(JSON.stringify({version:VERSION,posts,health}));await h.sync();}
    finally {await h.close();}
    await fs.rename(temp,file);
  }
  async function check(target) {
    const checkedAt=now(),prior=health[target.handle]||{};
    if(prior.retryAt>checkedAt)return;
    try {
      const response=await fetchImpl(`https://api.fxtwitter.com/2/profile/id:${target.id}/statuses?count=40`,
        {redirect:'error',signal:AbortSignal.timeout(8000)});
      const tweets=parseFxTwitterTimeline(await boundedJson(response),target.handle,target.id);
      const pending=tweets.filter(t=>{const at=Date.parse(t.createdAt);return Number.isFinite(at)&&at<=now()&&now()-at<=86400000
        &&!posts.some(p=>p.id===t.id&&p.userId===target.id);}).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt));
      let verified=0,failed=0;
      // Bound oEmbed work; next pass resumes unseen posts without blocking trading.
      for(const tweet of pending.slice(0,4)) {
        const result=await sourceReader(tweet.url,{fetchImpl,now});
        if(result.status!=='ok'||result.author?.toLowerCase()!==target.handle.toLowerCase()
          ||result.sourceVerifiedBy!=='official_x_oembed'||result.url.toLowerCase()!==tweet.url.toLowerCase()
          ||Math.abs(result.at-Date.parse(tweet.createdAt))>1000){failed++;continue;}
        const p={id:tweet.id,userId:target.id,author:result.author,url:result.url,text:result.text,
          at:result.at,observedAt:result.observedAt,verifiedBy:result.sourceVerifiedBy,
          isReply:tweet.isReply===true,isQuote:tweet.isQuote===true,simulationOnly:true};
        if(validPost(p,now())){posts.push(p);verified++;}else failed++;
      }
      health[target.handle]={status:failed?'partial':'ok',checkedAt,lastSuccessAt:now(),verified,
        pending:pending.length-verified,failed,retryAt:failed?now()+30000:null};
    }catch(error){health[target.handle]={...prior,status:'error',checkedAt,error:String(error.message).slice(0,160),retryAt:now()+30000};}
  }
  const snapshot=()=>{
    const at=now(),valid=posts.filter(p=>validPost(p,at)).sort((a,b)=>b.at-a.at);
    return {version:VERSION,mode:'research_only',execution:false,intervalMs:10000,lastError,
      targets:TWITTER_NARRATIVE_TARGETS.map(t=>({...t,...health[t.handle],
        fresh:health[t.handle]?.status==='ok'&&at-health[t.handle].lastSuccessAt<=120000})),
      posts:valid.slice(0,30),count:valid.length,
      contextPending:valid.filter(p=>p.isReply||p.isQuote).length,
      // Replies/quotes are retained for research, not detached into a buy claim.
      documents:valid.filter(p=>!p.isReply&&!p.isQuote).slice(0,200).map(p=>({id:p.url,url:p.url,text:p.text,at:p.at,
        observedAt:p.observedAt,author:p.author,authorId:p.userId,verifiedBy:p.verifiedBy,
        isReply:false,isQuote:false,authenticated:true,kind:'independent_x_research'})),
      note:'独立读取人物 / 平台推特，无需 GMGN 喊单或 BSC 钱包。回复与引用保留但上下文待核实，不自动认定认领或背书；历史补采不冒充首发买点。'};
  };
  function runOnce(){if(stopped)return Promise.resolve();if(job)return job;
    job=(async()=>{await initialize();await Promise.all(TWITTER_NARRATIVE_TARGETS.map(check));
      posts=[...new Map(posts.filter(p=>validPost(p,now())).map(p=>[key(p),p])).values()].sort((a,b)=>b.at-a.at).slice(0,300);
      await persist();lastError=null;return snapshot();})().catch(error=>{lastError=String(error.message).slice(0,160);throw error;}).finally(()=>{job=null;});return job;}
  function schedule(){if(stopped)return;timer=setTimeout(()=>{void runOnce().catch(()=>{}).finally(schedule);},10000);timer.unref?.();}
  return {snapshot,runOnce,start:()=>{if(started||stopped)return;started=true;void runOnce().catch(()=>{}).finally(schedule);},
    stop:async()=>{stopped=true;clearTimeout(timer);await job?.catch(()=>{});}};
}
