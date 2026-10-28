import {open,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {secureDirectory,openPrivateRead,checkPrivateFile,commitFile,syncDirectory} from './platform-files.mjs';
import {fault} from './flap-reader.mjs';
export class ModeStore {
 constructor(directory=fileURLToPath(new URL('../.private/mode-watch/',import.meta.url))){this.directory=directory;this.tail=Promise.resolve();}
 async read(){await secureDirectory(this.directory);let f;try{f=await openPrivateRead(join(this.directory,'state.json'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
  try{if((await checkPrivateFile(join(this.directory,'state.json'),f)).size>3000000)throw fault('MODE_STORE_INVALID');const value=JSON.parse(await f.readFile('utf8'));
   if(value?.version!==1||!Number.isSafeInteger(value.sequence)||!Array.isArray(value.modes)||value.modes.length>2000||!Array.isArray(value.sources))throw fault('MODE_STORE_INVALID');return value;
  }finally{await f.close();}}
 save(value){const content=JSON.stringify(value)+'\n';if(Buffer.byteLength(content)>3000000)throw fault('MODE_STORE_INVALID');
  const run=async()=>{await secureDirectory(this.directory);const path=join(this.directory,'state.json'),tmp=path+'.'+randomUUID()+'.tmp';const f=await open(tmp,'wx',0o600);
   try{try{await checkPrivateFile(tmp,f);await f.writeFile(content);await f.sync();}finally{await f.close();}await commitFile(tmp,path);await syncDirectory(this.directory);}finally{await rm(tmp,{force:true});}};
  const result=this.tail.then(run);this.tail=result.catch(()=>{});return result;
 }
}
