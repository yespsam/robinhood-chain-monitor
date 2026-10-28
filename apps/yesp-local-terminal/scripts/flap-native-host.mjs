import {safeFunding,safeBudget} from '../extension/funding-model.js';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, createPublicKey } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { safeOfficialIdentity } from '../public/official-error-catalog.js';
import { isOfficialSigninUrl } from '../extension/signin-policy.js';
import { FOUR_METHODS, validateFourParams } from '../extension/four-policy.js';
import { PANEL_METHODS, validatePanelParams } from '../extension/trade-policy.js';
import { createFlapMarketReader, validateFlapInspect } from '../server/flap-market.mjs';

export const HOST_NAME = 'com.yesp.flap_wallet';
export const MAX_FRAME_BYTES = 1024 * 1024;
const METHODS = new Set(['status', 'prepare', 'trade', 'signin', 'verify','walletStatus','transferPrepare','transfer','transferReconcile','flapInspect',...FOUR_METHODS,...PANEL_METHODS]);
const WRITES = new Set(['trade', 'signin', 'verify','transferPrepare','transfer','transferReconcile','fourPrepare','fourExecute','fourReconcile','panelPrepare','panelExecute','panelReconcile']);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
const context = new AsyncLocalStorage();
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (code, message) => Object.assign(new Error(message), { code });

export function extensionIdFromKey(key) {
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(key) || key.length > 8192)
    throw error('INVALID_EXTENSION_KEY', 'Extension public key is invalid.');
  const der = Buffer.from(key, 'base64');
  if (der.toString('base64') !== key) throw error('INVALID_EXTENSION_KEY', 'Extension public key is invalid.');
  createPublicKey({ key: der, format: 'der', type: 'spki' });
  return [...createHash('sha256').update(der).digest('hex').slice(0, 32)]
    .map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

export async function loadExtensionIdentity(root = ROOT) {
  const key = (await readFile(resolve(root, 'extension/extension-public-key.txt'), 'utf8')).trim();
  const manifest = JSON.parse(await readFile(resolve(root, 'extension/manifest.json'), 'utf8'));
  if (manifest.key !== key || manifest.manifest_version !== 3 || !manifest.permissions?.includes('nativeMessaging'))
    throw error('EXTENSION_IDENTITY_MISMATCH', 'Extension manifest does not match the installed public key.');
  return { key, extensionId: extensionIdFromKey(key), manifest };
}

export function verifyCallerOrigin(origin, extensionId) {
  if (!/^[a-p]{32}$/.test(extensionId) || typeof origin !== 'string'
      || ![`${'chrome-extension://'}${extensionId}/`, `${'chrome-extension://'}${extensionId}`].includes(origin))
    throw error('CALLER_NOT_ALLOWED', 'Native host only accepts its registered Chrome extension.');
  return true;
}

export function verifyHostArguments(args, extensionId, platform = process.platform) {
  if (!Array.isArray(args) || args.length < 1 || args.length > (platform === 'win32' ? 2 : 1))
    throw error('CALLER_NOT_ALLOWED', 'Unexpected native host arguments.');
  verifyCallerOrigin(args[0], extensionId);
  if (args.length === 2 && !/^--parent-window=[0-9]{1,20}$/.test(args[1]))
    throw error('CALLER_NOT_ALLOWED', 'Unexpected native host arguments.');
  return true;
}

export function encodeFrame(value, maxBytes = MAX_FRAME_BYTES) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  if (!body.length || body.length > maxBytes) throw error('FRAME_TOO_LARGE', 'Native message exceeds the size limit.');
  const prefix = Buffer.alloc(4); prefix.writeUInt32LE(body.length);
  return Buffer.concat([prefix, body]);
}

export class FrameDecoder {
  constructor({ onMessage, maxBytes = MAX_FRAME_BYTES } = {}) {
    this.onMessage = onMessage; this.maxBytes = maxBytes; this.buffer = Buffer.alloc(0); this.failed = false;
  }
  push(chunk) {
    if (this.failed) throw error('PROTOCOL_CLOSED', 'Native input is closed.');
    try {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      while (this.buffer.length >= 4) {
        const size = this.buffer.readUInt32LE(0);
        if (!size || size > this.maxBytes) throw error('INVALID_FRAME_LENGTH', 'Invalid native message length.');
        if (this.buffer.length < size + 4) return;
        const body = this.buffer.subarray(4, size + 4); this.buffer = this.buffer.subarray(size + 4);
        let value;
        try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
        catch { throw error('INVALID_JSON', 'Native message is not valid UTF-8 JSON.'); }
        this.onMessage(value);
      }
    } catch (e) { this.failed = true; this.buffer = Buffer.alloc(0); throw e; }
  }
  finish() {
    if (this.buffer.length) throw error('TRUNCATED_FRAME', 'Native message ended before its frame was complete.');
  }
}

export function validateRequest(request) {
  if (!object(request) || Object.keys(request).some(k => !['id', 'method', 'params'].includes(k))
      || typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(request.id)
      || !METHODS.has(request.method) || !object(request.params ?? {}))
    throw error('INVALID_REQUEST', 'Expected an identified, supported wallet request.');
  const params = request.params ?? {};
  if(PANEL_METHODS.has(request.method)){validatePanelParams(request.method,params);return {id:request.id,method:request.method,params};}
  if(request.method==='flapInspect'){validateFlapInspect(params);return {id:request.id,method:request.method,params};}
  if(FOUR_METHODS.has(request.method)){validateFourParams(request.method,params);return {id:request.id,method:request.method,params};}
  if (['walletStatus','transferPrepare','transfer','transferReconcile'].includes(request.method)) {
    const fields={walletStatus:[],transferPrepare:['recipient','tokenAddress','amount'],transfer:['previewId','intentId'],transferReconcile:['intentId','txHash']}[request.method];
    if(params.profile!=='heyi' || Object.keys(params).some(k=>!['profile',...fields].includes(k))
      || fields.some(k=>typeof params[k]!=='string' || params[k].length>128)) throw error('INVALID_REQUEST');
    return {id:request.id,method:request.method,params};
  }
  if (Object.keys(params).some(k => !['profile', 'action', 'intentId', 'deadlineMs', 'expectedMarket','expectedToken'].includes(k))
      || ['expectedMarket','expectedToken'].some(k=>params[k]!==undefined&&(!/^0x[\da-f]{40}$/i.test(params[k])||/^0x0{40}$/i.test(params[k])))
      || ['prepare','trade'].includes(request.method)&&(!params.expectedMarket||!params.expectedToken)
      || (params.profile !== undefined && params.profile !== 'heyi')
      || (params.action !== undefined && !['buy', 'sell', 'claim'].includes(params.action))
      || (params.intentId !== undefined && (typeof params.intentId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(params.intentId)))
      || (params.deadlineMs !== undefined && (!Number.isInteger(params.deadlineMs) || params.deadlineMs < 1 || params.deadlineMs > 15000)))
    throw error('INVALID_REQUEST', 'Unsupported wallet request fields.');
  return { id: request.id, method: request.method, params };
}

export function sanitizeBridgeData(value, allowPairingCode = false) {
  if (Array.isArray(value)) return value.map(v => sanitizeBridgeData(v, allowPairingCode));
  if (object(value)) return Object.fromEntries(Object.entries(value).filter(([key]) =>
    !/client.?id|secret|password|passphrase|mnemonic|seed|private.?key|authorization|cookie|api.?key|access.?token|refresh.?token|session.?id|session.?token|qr.?code.?id/i.test(key)
      && (allowPairingCode || !/pairing.?code|^qrImage$|^urlForWeb$/i.test(key)))
    .map(([key, item]) => [key, allowPairingCode && key==='urlForWeb' && isOfficialSigninUrl(item)
      ? item : sanitizeBridgeData(item, allowPairingCode)]));
  if (typeof value === 'string') return value
    .replace(/\b(?:agentSessionId|clientId|apiKey|accessToken|refreshToken)\s*[=:]\s*[^\s;,]+/gi, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '[REDACTED]');
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function safeError(e, auth = false) {
  const identity=auth?safeOfficialIdentity(e):{};
  const code = identity.officialName || (typeof e?.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code) ? e.code : 'HOST_ERROR');
  // Engine errors are typed and deliberately contain no CLI stderr. Never forward
  // arbitrary exception messages, stacks, process arguments, or filesystem paths.
  const messages = {
    INVALID_REQUEST: '请求参数无效。', INVALID_JSON: '消息 JSON 无效。', INVALID_FRAME_LENGTH: '消息长度无效。',
    TRUNCATED_FRAME: '消息未完整送达。', FRAME_TOO_LARGE: '返回消息过大。', REQUEST_ID_REUSED: '请求编号已使用，不会再次执行。',
    CHANNEL_CLOSED: '连接已断开；未开始的操作已取消。', TOO_MANY_REQUESTS: '请求过多，请重新连接并核验状态。'
  };
  return { code, message: messages[code] ?? '操作未完成，请查看状态；提交结果不明时不要重复发送。',...(code==='INSUFFICIENT_BALANCE'&&safeFunding(e.details?.funding)?{funding:safeFunding(e.details.funding)}:{}),...(code==='FUNDING_BUDGET_EXCEEDED'&&safeBudget(e.details?.budget)?{budget:safeBudget(e.details.budget)}:{}) };
}

// The accepted transaction's promise is allowed to finish after stdin EOF or a
// broken output pipe. The bridge never retries it. A browser/OS hard kill still
// requires the engine's durable journal to reconcile the outcome on reconnect.
export function createNativeConnection({ input, output, handle, onLog = () => {}, maxFrameBytes = MAX_FRAME_BYTES }) {
  let connected = true, ended = false, settled = false, mutationTail = Promise.resolve();
  const tasks = new Set(), requests = new Map();
  let resolveDrained;
  const drained = new Promise(resolve => { resolveDrained = resolve; });
  const checkDrained = () => { if (ended && tasks.size === 0 && !settled) { settled = true; resolveDrained(); } };
  const log = code => onLog(`flap-native-host: ${code}`);
  const send = value => {
    if (!connected) return false;
    try { output.write(encodeFrame(value, maxFrameBytes)); return true; }
    catch (e) { disconnect(); log(e?.code === 'FRAME_TOO_LARGE' ? 'FRAME_TOO_LARGE' : 'OUTPUT_CLOSED'); return false; }
  };
  const disconnect = () => {
    if (ended) return;
    connected = false; ended = true;
    input.removeListener('data', receive); input.pause?.(); checkDrained();
  };
  const progress = data => {
    const id = context.getStore()?.id;
    send({ event: 'progress', ...(id ? { id } : {}), data: sanitizeBridgeData(data) });
  };
  const dispatch = raw => {
    let request;
    try { request = validateRequest(raw); }
    catch (e) { send({ id: typeof raw?.id === 'string' ? raw.id.slice(0, 128) : null, ok: false, error: safeError(e),
      ...(['trade','transfer','fourExecute','panelExecute'].includes(raw?.method)?{submissionNotStarted:true}:{}) }); return; }
    const { id, method, params } = request;
    if (requests.has(id)) { send({ id, ok: false, error: safeError(error('REQUEST_ID_REUSED')) }); return; }
    if (requests.size >= 10000 || tasks.size >= 64) { send({ id, ok: false, error: safeError(error('TOO_MANY_REQUESTS')) }); return; }
    requests.set(id, true);
    const run = async () => {
      if (!connected && WRITES.has(method)) return;
      return context.run({ id }, async () => {
        try { const data = await handle(method, params); send({ id, ok: true, data: sanitizeBridgeData(data, method === 'signin') }); }
        catch (e) { const failure=safeError(e,method==='signin'||method==='verify');send({ id, ok: false, error: failure, ...(['trade','transfer','fourExecute','panelExecute'].includes(method)&&e.submissionNotStarted===true?{submissionNotStarted:true}:{}) }); log(failure.code); }
      });
    };
    const task = WRITES.has(method) ? mutationTail.then(run) : Promise.resolve().then(run);
    if (WRITES.has(method)) mutationTail = task.catch(() => {});
    tasks.add(task);
    task.finally(() => { tasks.delete(task); if(!WRITES.has(method))requests.delete(id); checkDrained(); });
  };
  const decoder = new FrameDecoder({ onMessage: dispatch, maxBytes: maxFrameBytes });
  const receive = chunk => {
    try { decoder.push(chunk); }
    catch (e) { send({ id: null, ok: false, error: safeError(e) }); log(safeError(e).code); disconnect(); }
  };
  input.on('data', receive);
  input.once('end', () => {
    try { decoder.finish(); } catch (e) { send({ id: null, ok: false, error: safeError(e) }); log(safeError(e).code); }
    disconnect();
  });
  input.once('error', () => { log('INPUT_CLOSED'); disconnect(); });
  output.on('error', () => { log('OUTPUT_CLOSED'); disconnect(); });
  return { progress, drained, disconnect, get connected() { return connected; } };
}

export async function main() {
  const { extensionId } = await loadExtensionIdentity();
  verifyHostArguments(process.argv.slice(2), extensionId);
  // Dynamic import happens only after the Chrome caller is verified.
  const { createFlapTrader } = await import('../server/flap-trader.mjs');
  const { createWalletTransfer } = await import('../server/wallet-transfer.mjs');
  const { createFastTradeCli } = await import('../server/fast-trade-cli.mjs');
  const { signinDisplay } = await import('../server/wallet-signin.mjs');
  const { createFourTrader } = await import('../server/four-trader.mjs');
  const { createPanelRouter } = await import('../server/panel-router.mjs');
  let connection;
  const cli=createFastTradeCli({allowWrites:true,allowAuth:true,readTimeoutMs:15000});
  const trader = createFlapTrader({ cli, allowWrites: true, allowAuth: true, onProgress: data => connection?.progress(data) });
  const wallet = createWalletTransfer({cli,allowWrites:true});
  const four = createFourTrader({cli,allowWrites:true});
  const panel = createFourTrader({cli,allowWrites:true,reader:createPanelRouter(),panel:true});
  const flapMarkets = createFlapMarketReader();
  connection = createNativeConnection({ input: process.stdin, output: process.stdout,
    handle: async (method, params) => {
      if(PANEL_METHODS.has(method))return panel.handle(method,params);
      if(method==='flapInspect')return flapMarkets.inspect(params);
      if(FOUR_METHODS.has(method))return four.handle(method,params);
      if(['walletStatus','transferPrepare','transfer','transferReconcile'].includes(method)) return wallet.handle(method,params);
      try {const result=await trader.handle(method,params);return method==='signin'?await signinDisplay(result):result;}
      catch(e) {
        if(method!=='status' || !['ENOENT','PROFILE_REVIEW_REQUIRED'].includes(e.code)) throw e;
        const result=await wallet.handle('walletStatus',{profile:'heyi'});
        return {...result,state:{connected:result.wallet.connected},readiness:{buy:false,sell:false,claim:false,blockers:['PROFILE_REVIEW_REQUIRED']},
          marketError:'PROFILE_REVIEW_REQUIRED',message:'市场配置尚未核验；钱包转出可独立使用。'};
      }
    }, onLog: message => process.stderr.write(`${message}\n`) });
  const stop = () => connection.disconnect();
  process.on('SIGTERM', stop); process.on('SIGINT', stop); process.on('SIGHUP', stop);
  await connection.drained;
  await trader.close?.();
  process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop); process.removeListener('SIGHUP', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(e => { process.stderr.write(`flap-native-host: ${safeError(e).code}\n`); process.exitCode = 1; });
}
