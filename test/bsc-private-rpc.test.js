import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {CHAINSTACK_BSC_HOST,PRIVATE_BSC_RPC_FILE,validateBscRpcEndpoints,loadPrivateBscRpcConfig,
  savePrivateBscRpcConfig,privateBscRpcEndpoints,sanitizeBscRpcError} from '../src/bsc-private-rpc.js';
const token='0123456789abcdef0123456789abcdef';
const httpUrl=`https://${CHAINSTACK_BSC_HOST}/${token}`,wsUrl=`wss://${CHAINSTACK_BSC_HOST}/${token}`;
const directory=t=>{const p=fs.mkdtempSync(path.join(os.tmpdir(),'bsc-private-rpc-test-'));t.after(()=>fs.rmSync(p,{recursive:true,force:true}));return p;};
test('private config absent is backwards compatible, saved config has 0600 and cannot overwrite',t=>{
  const dataDir=directory(t);assert.equal(loadPrivateBscRpcConfig({dataDir}),null);
  assert.deepEqual(savePrivateBscRpcConfig({dataDir,httpUrl,wsUrl}),{saved:true,host:CHAINSTACK_BSC_HOST,mode:'0600'});
  assert.equal(fs.statSync(path.join(dataDir,PRIVATE_BSC_RPC_FILE)).mode&0o777,0o600);
  const config=loadPrivateBscRpcConfig({dataDir});assert.equal(config.httpUrl,httpUrl);assert.equal(config.wsUrl,wsUrl);
  assert.throws(()=>savePrivateBscRpcConfig({dataDir,httpUrl,wsUrl}),/PRIVATE_BSC_RPC_CONFIG_EXISTS/);
  assert.equal(fs.readdirSync(dataDir).length,1);
  assert.equal(privateBscRpcEndpoints(config)[0].preferred,true);assert.equal(privateBscRpcEndpoints(null).length,3);
});
test('reject weak permissions, symbolic links, malformed config without echoing input',t=>{
  const dataDir=directory(t),file=path.join(dataDir,PRIVATE_BSC_RPC_FILE);
  fs.writeFileSync(file,JSON.stringify({version:1,httpUrl,wsUrl}),{mode:0o644});
  assert.throws(()=>loadPrivateBscRpcConfig({dataDir}),/UNSAFE_PRIVATE_BSC_RPC_CONFIG/);
  fs.chmodSync(file,0o600);fs.writeFileSync(file,'not json '+token);
  assert.throws(()=>loadPrivateBscRpcConfig({dataDir}),e=>!e.message.includes(token));
  fs.unlinkSync(file);fs.symlinkSync(path.join(dataDir,'elsewhere'),file);
  assert.throws(()=>loadPrivateBscRpcConfig({dataDir}),/INVALID_PRIVATE_BSC_RPC_CONFIG/);
});
test('endpoint admission is explicit and cannot rotate duplicate-host keys',()=>{
  assert.equal(validateBscRpcEndpoints([{host:CHAINSTACK_BSC_HOST,url:httpUrl}])[0].url,httpUrl);
  for(const url of ['http://'+CHAINSTACK_BSC_HOST+'/'+token,'https://evil.test/'+token,
    httpUrl+'?key=x',httpUrl+'#x','https://u:p@'+CHAINSTACK_BSC_HOST+'/'+token,
    'https://'+CHAINSTACK_BSC_HOST+'/foo/../'+token,'https://'+CHAINSTACK_BSC_HOST+'/%31'+token,
    'https://bsc-rpc.publicnode.com/'+token])assert.throws(()=>validateBscRpcEndpoints([{host:new URL(url).hostname,url}]));
  assert.throws(()=>validateBscRpcEndpoints([{host:CHAINSTACK_BSC_HOST,url:httpUrl},{host:CHAINSTACK_BSC_HOST,url:httpUrl}]));
  assert.throws(()=>validateBscRpcEndpoints([{host:'bsc-rpc.publicnode.com',url:httpUrl}]));
});
test('paired endpoints must match identity and secrets never escape sanitized diagnostics',t=>{
  const dataDir=directory(t);assert.throws(()=>savePrivateBscRpcConfig({dataDir,httpUrl,wsUrl:wsUrl+'other'}));
  validateBscRpcEndpoints([{host:CHAINSTACK_BSC_HOST,url:httpUrl}]);
  const error=Object.assign(new TypeError(`fetch ${httpUrl} failed token ${token}`),{code:'TIMEOUT',status:429,retryAfter:'120',
    info:{error:{message:`missing trie node at ${wsUrl}`}},cause:new Error('timeout '+token)});
  const result=sanitizeBscRpcError(error);assert.equal(result.code,'TIMEOUT');assert.equal(result.status,429);
  assert.equal(result.retryAfter,'120');assert.equal(result.name,'TypeError');assert.match(result.message,/missing trie node/);
  assert.ok(!JSON.stringify(result).includes(token));assert.equal(result.cause,undefined);
  assert.equal(sanitizeBscRpcError({retryAfter:token}).retryAfter,undefined);
  const numericToken='12345678901234567890123456789012';
  validateBscRpcEndpoints([{host:CHAINSTACK_BSC_HOST,url:`https://${CHAINSTACK_BSC_HOST}/${numericToken}`}]);
  assert.equal(sanitizeBscRpcError({retryAfter:numericToken}).retryAfter,undefined);
  assert.ok(!sanitizeBscRpcError({message:'https://unknown.test/secret-token?key=value'}).message.includes('secret-token'));
});
