import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {open,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {secureDirectory,openPrivateRead,checkPrivateFile,commitFile,syncDirectory} from './platform-files.mjs';
import {fault} from './flap-reader.mjs';
export const emptyGangLaunch=()=>({version:1,run:null,positions:[],seen:[],events:[]});
export class GangLaunchStore{
 constructor(directory=fileURLToPath(new URL('../.private/gang-launch/',import.meta.url))){this.directory=directory;this.tail=Promise.resolve();}
 async read(){await secureDirectory(this.directory);const path=join(this.directory,'state.json');let f;try{f=await openPrivateRead(path);}catch(e){if(e.code==='ENOENT')return emptyGangLaunch();throw e;}
  try{if((await checkPrivateFile(path,f)).size>2000000)throw fault('GANG_STORE_INVALID');const s=JSON.parse(await f.readFile('utf8'));if(s.version!==1||!Array.isArray(s.positions)||s.positions.length>100||!Array.isArray(s.seen)||s.seen.length>10000||!Array.isArray(s.events)||s.events.length>100)throw fault('GANG_STORE_INVALID');return s;}finally{await f.close();}
 }
 save(state){const text=JSON.stringify(state)+'\n';if(text.length>2000000)throw fault('GANG_STORE_INVALID');const write=async()=>{await secureDirectory(this.directory);const target=join(this.directory,'state.json'),tmp=target+'.'+randomUUID()+'.tmp',f=await open(tmp,'wx',0o600);try{try{await checkPrivateFile(tmp,f);await f.writeFile(text);await f.sync();}finally{await f.close();}await commitFile(tmp,target);await syncDirectory(this.directory);}finally{await rm(tmp,{force:true});}};const p=this.tail.then(write);this.tail=p.catch(()=>{});return p;}
}
