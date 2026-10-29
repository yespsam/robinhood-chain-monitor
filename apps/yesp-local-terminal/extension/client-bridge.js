const local=location.protocol==='http:'&&location.hostname==='127.0.0.1';
const listeners=new Set(),streams=new Map();let session=null,events=null,initialized=false,suspended=false;
function closeEvents(){events?.close();events=null;}
function syncEvents(){
 if(document.hidden||suspended){closeEvents();return;}if(events||!initialized)return;
 events=new EventSource('/api/events');
 for(const name of ['scanner','sniper','modes','metrics','trade','gangLaunch'])events.addEventListener(name,e=>{let data;try{data=JSON.parse(e.data);}catch{return;}for(const fn of streams.get(name)||[])fn(data);});
 events.onerror=()=>{for(const fn of listeners)fn({connection:'disconnected'});};
}
async function csrf(){session??=fetch('/api/session',{cache:'no-store'}).then(async r=>{if(!r.ok)throw Error('LOCAL_SERVER_UNAVAILABLE');return (await r.json()).csrf;}).catch(e=>{session=null;throw e;});return session;}
export const client={local,version:()=>local?'1.11.2':chrome.runtime.getManifest().version,
 async sendMessage(message){if(!local)return chrome.runtime.sendMessage(message);
  const response=await fetch('/api/request',{method:'POST',headers:{'content-type':'application/json','x-yesp-csrf':await csrf()},body:JSON.stringify(message)});
  if(response.status===403){session=null;throw Error('LOCAL_SESSION_CHANGED');}const result=await response.json();if(result.ok&&['/wallet.html','/trade.html'].includes(result.data?.navigate))location.assign(result.data.navigate);return result;
 },
 storage:{async get(key){if(!local)return chrome.storage.local.get(key);try{return {[key]:JSON.parse(localStorage.getItem(key))};}catch{return {}; }},async set(values){if(!local)return chrome.storage.local.set(values);for(const [k,v]of Object.entries(values))localStorage.setItem(k,JSON.stringify(v));}},
 onProgress(fn){if(!local){chrome.runtime.onMessage.addListener((m,s)=>{if(s.id===chrome.runtime.id&&m?.event==='progress')fn(m.data);});return;}listeners.add(fn);},
 subscribe(name,fn){if(!local)return ()=>{};if(!streams.has(name))streams.set(name,new Set());streams.get(name).add(fn);return ()=>streams.get(name)?.delete(fn);},
 async init(){if(!local)return;await csrf();if(initialized)return;initialized=true;
  // The server sends current snapshots on reconnect; hidden tabs need no event queue.
  document.addEventListener('visibilitychange',syncEvents);
  window.addEventListener('pagehide',()=>{suspended=true;closeEvents();});
  window.addEventListener('pageshow',()=>{suspended=false;syncEvents();});syncEvents();
 }
};
