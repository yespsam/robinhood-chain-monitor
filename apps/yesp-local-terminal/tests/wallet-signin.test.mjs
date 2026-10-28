import test from 'node:test';
import assert from 'node:assert/strict';
import {PNG} from 'pngjs';
import {signinDisplay} from '../server/wallet-signin.mjs';
import {sanitizeBridgeData} from '../scripts/flap-native-host.mjs';
import {isOfficialSigninUrl} from '../extension/signin-policy.js';
const data=()=>({urlForWeb:'https://web3.binance.com/en/agent-login?url=example%2Bopaque%26v%3D1',pairingCode:'aB123f',expireAt:Date.now()+60000});
test('login QR is generated locally from the unmodified vendor URL and survives native framing sanitization',async()=>{
  const input=data();let encoded;
  await signinDisplay(input,{encode:async text=>{encoded=text;return 'data:image/png;base64,AA==';}});assert.equal(encoded,input.urlForWeb);
  const result=await signinDisplay(input),png=PNG.sync.read(Buffer.from(result.qrImage.split(',')[1],'base64'));
  assert.equal(png.width,320);assert.equal(png.height,320);assert.ok(png.data.some(x=>x===0));
  assert.deepEqual(sanitizeBridgeData(result,true),result);
  assert.equal(sanitizeBridgeData(result).qrImage,undefined);assert.equal(sanitizeBridgeData(result).urlForWeb,undefined);
});
test('QR encoding failure preserves the clickable official URL; expired and unreviewed codes fail closed',async()=>{
  const input=data();assert.deepEqual(await signinDisplay(input,{encode:async()=>{throw Error();}}),{...input,qrUnavailable:true});
  await assert.rejects(signinDisplay({...input,expireAt:Date.now()-1}),{code:'QR_CODE_EXPIRED'});
  await assert.rejects(signinDisplay({...input,urlForWeb:'https://evil.test/'}),{code:'AUTH_URL_REVIEW_REQUIRED'});
  assert.deepEqual(await signinDisplay({connected:true}),{connected:true});
});
test('shared login URL policy permits exact official hosts and rejects credentials, controls and lookalikes',()=>{
  for(const host of ['web3.binance.com','www.binance.com','app.binance.com'])assert.equal(isOfficialSigninUrl(`https://${host}/vendor-login?opaque=%2B%3D`),true);
  for(const url of ['https://web3.binance.com.evil.test/','http://web3.binance.com/','https://name:pass@web3.binance.com/',
    'https://web3.binance.com:8443/','https://web3.binance.com/#fragment','https://web3.binance.com/\\bad','https://web3.binance.com/\n'])assert.equal(isOfficialSigninUrl(url),false);
});
