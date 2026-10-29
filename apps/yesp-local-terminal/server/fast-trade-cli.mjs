import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, dirname } from 'node:path';
import { getAddress } from 'ethers';
import { resolveCliInstallation, DOCUMENTED_CLI_VERSION, OFFICIAL_AUTH_HOSTS } from './official-cli.mjs';
import { validChain, validContract, decimal, addressKey } from './model.mjs';
import { safeOfficialIdentity } from '../public/official-error-catalog.js';

const runFile = promisify(execFile);
const messages = Object.freeze({
  INVALID_REQUEST: 'Invalid typed wallet request.',
  CLI_NOT_AVAILABLE: 'The reviewed official wallet CLI is unavailable.',
  CLI_START_FAILED: 'The official CLI did not start.',
  READ_FAILED: 'The official wallet read did not complete.',
  WALLET_NETWORK_ERROR: 'The official wallet service could not be reached.',
  WALLET_READ_TIMEOUT: 'The official wallet read timed out.',
  INVALID_RESPONSE: 'The official response could not be verified.',
  PREVIEW_REJECTED: 'The official preview was rejected.',
  PREVIEW_UNKNOWN: 'The preview result is unavailable.',
  PREVIEW_NOT_EXECUTABLE: 'A successful, unexpired preview from this runner is required.',
  WRITES_DISABLED: 'Financial submission is disabled for this runner.',
  AUTH_DISABLED: 'Wallet login is disabled for this runner.',
  AUTH_URL_REVIEW_REQUIRED: 'The returned login URL is outside the reviewed official origin policy.',
  SWAP_PENDING: 'A swap is unresolved; reconcile it before another submission.',
  OFFICIAL_REJECTED: 'The official CLI explicitly rejected the request.',
  SUBMISSION_UNKNOWN: 'Submission outcome is unknown; reconcile without resubmitting.'
});
export class FastTradeCliError extends Error {
  constructor(code, identity = {}) {
    super(messages[code] || messages.INVALID_RESPONSE);
    this.name = 'FastTradeCliError'; this.code = code;
    Object.assign(this, safeOfficialIdentity(identity));
  }
}
const sensitiveKey = /client.?id|secret|password|passphrase|mnemonic|seed|private.?key|authorization|cookie|api.?key|access.?token|refresh.?token|session|pairing.?code|qr.?code/i;
// Preserve the full parsed transaction, simulation and risks, excluding credential
// fields. Error strings and process stderr are never returned by this adapter.
export function sanitizeFastTradeData(value) {
  if (Array.isArray(value)) return value.map(sanitizeFastTradeData);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !sensitiveKey.test(key) || key === 'sessionExpireTime')
    .map(([key, item]) => [key, sanitizeFastTradeData(item)]));
  if (typeof value === 'string') return value
    .replace(/\b(?:agentSessionId|clientId|apiKey|accessToken|refreshToken)\s*[=:]\s*[^\s;,]+/gi, '[REDACTED]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_.=-]+/gi, '[REDACTED]');
  return value;
}
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function fields(value, names) {
  if (!object(value) || Object.keys(value).some(key => !names.includes(key))) throw new FastTradeCliError('INVALID_REQUEST');
}
function chain(value) {
  try { return validChain(value); } catch { throw new FastTradeCliError('INVALID_REQUEST'); }
}
function previewArguments(tx) {
  fields(tx, ['chainId', 'from', 'to', 'value', 'inputData']);
  const chainId = chain(tx.chainId);
  if (chainId === 'CT_501') throw new FastTradeCliError('INVALID_REQUEST');
  try { validContract(chainId, tx.from); validContract(chainId, tx.to); }
  catch { throw new FastTradeCliError('INVALID_REQUEST'); }
  const value = tx.value ?? '0', inputData = tx.inputData ?? '0x';
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*|0x[0-9a-fA-F]+)$/.test(value)
      || value.length > 80 || BigInt(value) >= 1n << 256n
      || typeof inputData !== 'string' || !/^0x(?:[\da-fA-F]{2})*$/.test(inputData) || inputData.length > 262146)
    throw new FastTradeCliError('INVALID_REQUEST');
  return ['contract-call', 'preview', '--binanceChainId', chainId, '--from', tx.from, '--to', tx.to,
    '--value', value, '--inputData', inputData];
}
function swapArguments(trade, operation) {
  fields(trade, ['chainId', 'fromToken', 'toToken', 'amount', 'slippage']);
  const chainId = chain(trade.chainId);
  try {
    validContract(chainId, trade.fromToken); validContract(chainId, trade.toToken);
    decimal(trade.amount); decimal(trade.slippage, { zero: true });
    if (addressKey(chainId, trade.fromToken) === addressKey(chainId, trade.toToken) || Number(trade.slippage) >= 100) throw new Error();
  } catch { throw new FastTradeCliError('INVALID_REQUEST'); }
  return ['market-order', operation, '--fromTokenQty', trade.amount, '--fromToken', trade.fromToken, '--toToken', trade.toToken,
    '--binanceChainId', chainId, '--slippage', trade.slippage,
    ...(operation === 'swap' ? ['--mev', 'true', '--gasLevel', 'MEDIUM'] : [])];
}
export function transferArguments(transfer) {
  fields(transfer, ['chainId', 'recipient', 'tokenAddress', 'amount']);
  if (transfer.chainId !== '56') throw new FastTradeCliError('INVALID_REQUEST');
  try {
    for (const value of [transfer.recipient, transfer.tokenAddress]) {
      if (typeof value !== 'string' || getAddress(value) === '0x0000000000000000000000000000000000000000') throw new Error();
    }
    if (typeof transfer.amount !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(transfer.amount)
        || transfer.amount.length > 115 || !/[1-9]/.test(transfer.amount)) throw new Error();
  } catch { throw new FastTradeCliError('INVALID_REQUEST'); }
  return ['wallet', 'send', '--binanceChainId', '56', '--recipient', transfer.recipient,
    '--tokenAddress', transfer.tokenAddress, '--amount', transfer.amount, '--gasLevel', 'MEDIUM'];
}
function normalizedAmount(value) {
  decimal(value, { zero: true });
  const [whole, fraction = ''] = value.split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}
function authResponse(data, clock) {
  if (data.status === 'ALREADY_CONNECTED') return { status: 'ALREADY_CONNECTED' };
  const { urlForWeb, pairingCode, qrCodeId, expireAt } = data;
  let url;
  try {
    if (typeof urlForWeb !== 'string' || urlForWeb.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(urlForWeb)) throw new Error();
    url = new URL(urlForWeb);
    if (url.protocol !== 'https:' || !OFFICIAL_AUTH_HOSTS.includes(url.hostname) || url.username || url.password || url.port || url.hash) throw new Error();
  } catch { throw new FastTradeCliError('AUTH_URL_REVIEW_REQUIRED'); }
  if (typeof pairingCode !== 'string' || !/^[A-Za-z0-9]{1,64}$/.test(pairingCode)
      || typeof qrCodeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(qrCodeId)
      || !Number.isSafeInteger(Number(expireAt)) || Number(expireAt) <= clock()) throw new FastTradeCliError('INVALID_RESPONSE');
  // Pairing fields intentionally cross the boundary only for this explicit login
  // operation. Return the vendor URL and code verbatim, never reconstruct them.
  return { urlForWeb, pairingCode, qrCodeId, expireAt };
}
const requestIdValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/.test(value);
const orderIdValid = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const definiteRejection = identity => ['INVALID_PARAMS', 'INVALID_JSON', 'NOT_LOGGED_IN', 'UNAUTHORIZED',
  'SESSION_EXPIRED', 'SESSION_NOT_FOUND', 'WALLET_NOT_EXIST', 'WALLET_CREATING', 'NOT_IMPLEMENTED'].includes(identity.officialName);
function parseOfficialJson(source) {
  // Raw token amounts must not pass through an imprecise JavaScript Number.
  // This cannot recover precision already lost by the upstream CLI itself.
  let out = '', quoted = false, escaped = false;
  for (let i = 0; i < source.length;) {
    const char = source[i];
    if (quoted) {
      out += char; i++;
      if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; out += char; i++; continue; }
    if (char === '-' || /\d/.test(char)) {
      const match = source.slice(i).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
      if (match) {
        const token = match[0], number = Number(token);
        out += !Number.isFinite(number) || Math.abs(number) > Number.MAX_SAFE_INTEGER ? JSON.stringify(token) : token;
        i += token.length; continue;
      }
    }
    out += char; i++;
  }
  return JSON.parse(out);
}

// All invocations use the documented CLI. No credentials, private endpoints,
// automatic retries or arbitrary argument vectors are exposed. Login has its own
// disabled-by-default capability, separate from financial write permission.
export function createFastTradeCli({ execute = runFile, resolveInstallation = resolveCliInstallation,
  childEnv = process.env, clock = Date.now, allowWrites = false, allowAuth = false,
  readTimeoutMs = 5000, previewTimeoutMs = 7000, executeTimeoutMs = 90000, verifyTimeoutMs = 310000 } = {}) {
  for (const timeout of [readTimeoutMs, previewTimeoutMs, executeTimeoutMs, verifyTimeoutMs]) {
    if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 310000) throw new FastTradeCliError('INVALID_REQUEST');
  }
  if (typeof allowWrites !== 'boolean' || typeof allowAuth !== 'boolean') throw new FastTradeCliError('INVALID_REQUEST');
  let installationPromise;
  const previews = new Map();
  const verifying = new Map();
  let activeSwap = null;
  async function installation() {
    installationPromise ??= Promise.resolve().then(resolveInstallation).then(found => {
      const m = found?.metadata;
      if (m?.name !== '@binance/agentic-wallet' || m.version !== DOCUMENTED_CLI_VERSION || m.bin?.baw !== 'dist/index.js'
          || typeof found?.entryPath !== 'string' || basename(found.entryPath) !== 'index.js' || basename(dirname(found.entryPath)) !== 'dist') throw new Error();
      return found;
    });
    return installationPromise;
  }
  async function run(args, timeout, projectData = sanitizeFastTradeData, arrayData = false) {
    let found; try { found = await installation(); }
    catch { return { kind: 'not-started', code: 'CLI_NOT_AVAILABLE' }; }
    let stdout;
    try {
      ({ stdout } = await execute(process.execPath, [found.entryPath, ...args, '--json'], {
        shell: false, windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, env: childEnv
      }));
    } catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(error.code)) return { kind: 'not-started', code: 'CLI_START_FAILED' };
      if (error.killed || error.code === 'ETIMEDOUT') return { kind: 'unknown', timedOut: true };
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { kind: 'unknown' };
      stdout = error.stdout;
    }
    let value; try { value = parseOfficialJson(stdout); } catch { return { kind: 'unknown' }; }
    if (value?.success === false) {
      const identity = safeOfficialIdentity({ officialName: value.error?.name, officialCode: value.error?.code });
      return { kind: definiteRejection(identity) ? 'rejected' : 'unknown', identity, explicitFailure: true };
    }
    if (value?.success !== true || !(arrayData ? Array.isArray(value.data) : object(value.data))) return { kind: 'unknown' };
    return { kind: 'success', data: projectData(value.data) };
  }
  async function read(args, valid) {
    const result = await run(args, readTimeoutMs);
    if (result.kind !== 'success') {
      const network=['NETWORK_ERROR','SERVICE_UNAVAILABLE','DNS_RESOLVE_FAILED','SSL_ERROR'].includes(result.identity?.officialName);
      const timeout=result.timedOut||result.identity?.officialName==='REQUEST_TIMEOUT';
      throw new FastTradeCliError(result.code || (timeout?'WALLET_READ_TIMEOUT':network?'WALLET_NETWORK_ERROR':'READ_FAILED'), result.identity);
    }
    if (!valid(result.data)) throw new FastTradeCliError('INVALID_RESPONSE');
    return result.data;
  }
  return {
    status: () => read(['wallet', 'status'], data => ['CONNECTED', 'UNCONNECTED', 'CREATING'].includes(data.status)),
    addresses: () => read(['wallet', 'address'], data => Array.isArray(data.addresses) && data.addresses.every(row =>
      object(row) && typeof row.binanceChainId === 'string' && typeof row.address === 'string')),
    settings: () => read(['wallet', 'settings'], data => typeof data.sessionExpireTime === 'string'
      && typeof data.inactiveSignOutTime === 'string'),
    txLock: (chainId = '56') => read(['wallet', 'tx-lock', '--binanceChainId', chain(chainId)], data => ['LOCKED', 'UNLOCKED'].includes(data.status)),
    async recentTransactions(request) {
      fields(request,['chainId','since']);
      if(request.chainId!=='56'||!Number.isSafeInteger(request.since)||request.since<0)throw new FastTradeCliError('INVALID_REQUEST');
      const data=await read(['wallet','tx-history','--binanceChainId','56','--type','all','--size','20','--startTime',String(request.since)], result=>
        Array.isArray(result.transactions)&&result.transactions.length<=20&&result.transactions.every(row=>object(row)&&row.binanceChainId==='56'
          &&(row.txHashList===undefined||Array.isArray(row.txHashList)&&row.txHashList.length<=32&&row.txHashList.every(x=>object(x)&&x.binanceChainId==='56'))));
      return [...new Set(data.transactions.flatMap(row=>[row.txHash,...(row.txHashList||[]).map(x=>x.txHash)])
        .filter(hash=>typeof hash==='string'&&/^0x[\da-f]{64}$/i.test(hash)).map(hash=>hash.toLowerCase()))].slice(0,32);
    },
    async transferBalance(tokenAddress) {
      try { getAddress(tokenAddress); } catch { throw new FastTradeCliError('INVALID_REQUEST'); }
      const result = await run(['wallet','balance','--binanceChainId','56','--tokenAddress',tokenAddress],readTimeoutMs,sanitizeFastTradeData,true);
      if(result.kind!=='success') throw new FastTradeCliError(result.code||'READ_FAILED',result.identity);
      if(result.data.length!==1) throw new FastTradeCliError('TOKEN_BALANCE_UNAVAILABLE');
      const row=result.data[0];
      if(row.binanceChainId!=='56' || typeof row.address!=='string' || row.address.toLowerCase()!==tokenAddress.toLowerCase()
        || typeof row.balance!=='string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,36})?$/.test(row.balance) || row.balance.length>115)
        throw new FastTradeCliError('INVALID_RESPONSE');
      return row.balance;
    },
    async sendTransfer(transfer) {
      const args = transferArguments(transfer);
      if (!allowWrites) return { outcome: 'REJECTED', code: 'WRITES_DISABLED', submitted: false };
      // Caller must persist its intent before this one-shot invocation. No retry.
      const result = await run(args, executeTimeoutMs);
      if (result.kind === 'not-started' || result.kind === 'rejected') return {
        outcome: 'REJECTED', code: result.code || 'OFFICIAL_REJECTED', ...result.identity, submitted: false };
      if (result.kind !== 'success' || !/^0x[\da-f]{64}$/i.test(result.data?.txHash || '')) return {
        outcome: 'UNKNOWN', code: 'SUBMISSION_UNKNOWN', ...result.identity, submitted: null };
      return { outcome: 'SUBMITTED', data: { txHash: result.data.txHash }, submitted: true };
    },
    async signin() {
      if (!allowAuth) throw new FastTradeCliError('AUTH_DISABLED');
      const result = await run(['auth', 'signin'], readTimeoutMs, data => authResponse(data, clock));
      if (result.kind !== 'success') throw new FastTradeCliError(result.code || 'READ_FAILED', result.identity);
      return result.data;
    },
    async verify(qrCodeId) {
      if (!allowAuth) throw new FastTradeCliError('AUTH_DISABLED');
      if (typeof qrCodeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(qrCodeId)) throw new FastTradeCliError('INVALID_REQUEST');
      if (!verifying.has(qrCodeId)) verifying.set(qrCodeId, (async () => {
        const result = await run(['auth', 'verify', '--qrCodeId', qrCodeId], verifyTimeoutMs);
        if (result.kind !== 'success') throw new FastTradeCliError(result.code || 'READ_FAILED', result.identity);
        if (result.data.status !== 'SUCCESS') throw new FastTradeCliError('INVALID_RESPONSE');
        const status = await read(['wallet', 'status'], data => ['CONNECTED', 'UNCONNECTED', 'CREATING'].includes(data.status));
        return { status: 'SUCCESS', verified: status.status === 'CONNECTED' };
      })());
      // The same pairing flow is never restarted by a duplicate HTTP/UI request.
      return verifying.get(qrCodeId);
    },
    async quoteSwap(trade) {
      return read(swapArguments(trade, 'quote'), data => {
        try { decimal(data.toCoinAmount); return normalizedAmount(data.fromCoinAmount) === normalizedAmount(trade.amount); } catch { return false; }
      });
    },
    async executeSwap(trade) {
      const args = swapArguments(trade, 'swap');
      if (!allowWrites) return { outcome: 'REJECTED', code: 'WRITES_DISABLED', retryAllowed: false, submitted: false };
      const key = JSON.stringify(args);
      if (activeSwap) return activeSwap.key === key ? activeSwap.promise
        : { outcome: 'REJECTED', code: 'SWAP_PENDING', retryAllowed: false, submitted: false };
      const marker = { key, chainId: trade.chainId, fromToken: trade.fromToken, toToken: trade.toToken, amount: trade.amount, orderId: null, promise: null }; activeSwap = marker;
      marker.promise = (async () => {
        const result = await run(args, executeTimeoutMs);
        if (result.kind === 'not-started' || result.kind === 'rejected') {
          if (activeSwap === marker) activeSwap = null;
          return { outcome: 'REJECTED', code: result.code || 'OFFICIAL_REJECTED', ...result.identity, retryAllowed: false, submitted: false };
        }
        if (result.kind !== 'success' || !orderIdValid(result.data?.orderId))
          return { outcome: 'UNKNOWN', code: 'SUBMISSION_UNKNOWN', ...result.identity, retryAllowed: false, submitted: null };
        marker.orderId = result.data.orderId;
        return { outcome: result.data.status === 'PENDING_CONFIRMATION' ? 'PENDING_CONFIRMATION' : 'SUBMITTED',
          data: result.data, retryAllowed: false, submitted: true };
      })();
      return marker.promise;
    },
    async readOrder(request) {
      fields(request, ['chainId', 'orderId']); const chainId = chain(request.chainId);
      if (!orderIdValid(request.orderId)) throw new FastTradeCliError('INVALID_REQUEST');
      const data = await read(['market-order', 'list', '--orderId', request.orderId], result => {
        if (!Array.isArray(result.list) || result.list.length > 1) return false;
        return result.list.every(row => {
          if (!object(row) || row.orderId !== request.orderId || row.chain !== chainId || !['PENDING', 'PENDING_CONFIRMATION', 'FINISHED', 'FAILED'].includes(row.status)) return false;
          try { validContract(chainId, row.fromToken); validContract(chainId, row.toToken); decimal(row.fromTokenQty); } catch { return false; }
          if (activeSwap?.orderId === request.orderId && (activeSwap.chainId !== chainId
              || addressKey(chainId, row.fromToken) !== addressKey(chainId, activeSwap.fromToken)
              || addressKey(chainId, row.toToken) !== addressKey(chainId, activeSwap.toToken)
              || normalizedAmount(row.fromTokenQty) !== normalizedAmount(activeSwap.amount))) return false;
          if (row.status === 'FINISHED' && (typeof row.txHash !== 'string'
              || !(chainId === 'CT_501' ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/ : /^0x[\da-fA-F]{64}$/).test(row.txHash))) return false;
          return true;
        });
      });
      if (activeSwap?.orderId === request.orderId && activeSwap.chainId === chainId
          && data.list.length === 1 && ['FINISHED', 'FAILED'].includes(data.list[0].status)) activeSwap = null;
      return data;
    },
    async previewContract(tx) {
      const args = previewArguments(tx), result = await run(args, previewTimeoutMs);
      if (result.kind !== 'success') return { outcome: result.explicitFailure || result.kind === 'not-started' ? 'REJECTED' : 'UNKNOWN',
        code: result.code || (result.explicitFailure ? 'PREVIEW_REJECTED' : 'PREVIEW_UNKNOWN'), ...result.identity, retryAllowed: false };
      const data = result.data, expiresAt = Number(data.expiresAt);
      if (!requestIdValid(data.requestId) || !object(data.parsedTx) || !object(data.simulationResult) || !object(data.risks)
          || data.simulationResult.simulationCode !== '000000000' || data.simulationResult.simulationErrorDetail
          || !Number.isSafeInteger(expiresAt) || expiresAt <= clock())
        return { outcome: 'REJECTED', code: 'INVALID_RESPONSE', data, retryAllowed: false };
      // An ID cannot be rearmed by an identical second preview response after use.
      if (previews.has(data.requestId)) return { outcome: 'REJECTED', code: 'PREVIEW_NOT_EXECUTABLE', retryAllowed: false };
      previews.set(data.requestId, { expiresAt, used: false });
      return { outcome: 'PREVIEWED', data, retryAllowed: false };
    },
    async executePreview(requestId) {
      if (!allowWrites) return { outcome: 'REJECTED', code: 'WRITES_DISABLED', retryAllowed: false, submitted: false };
      const preview = requestIdValid(requestId) ? previews.get(requestId) : null;
      if (!preview || preview.used || clock() >= preview.expiresAt)
        return { outcome: 'REJECTED', code: 'PREVIEW_NOT_EXECUTABLE', retryAllowed: false, submitted: false };
      // Consume synchronously before awaiting so concurrent callers cannot resend.
      preview.used = true;
      const result = await run(['contract-call', 'execute', '--requestId', requestId], executeTimeoutMs);
      if (result.kind === 'not-started' || result.kind === 'rejected') return { outcome: 'REJECTED', code: result.code || 'OFFICIAL_REJECTED',
        ...result.identity, retryAllowed: false, submitted: false };
      if (result.kind !== 'success') return { outcome: 'UNKNOWN', code: 'SUBMISSION_UNKNOWN', ...result.identity, retryAllowed: false, submitted: null };
      const data = result.data;
      if (!orderIdValid(data.orderId)) return { outcome: 'UNKNOWN', code: 'SUBMISSION_UNKNOWN', retryAllowed: false, submitted: null };
      if (data.status === 'PENDING_CONFIRMATION') return { outcome: 'PENDING_CONFIRMATION', data, retryAllowed: false, submitted: true };
      if (data.status !== 'BROADCASTED' || typeof data.txHash !== 'string' || !/^0x[\da-fA-F]{64}$/.test(data.txHash))
        return { outcome: 'UNKNOWN', code: 'SUBMISSION_UNKNOWN', data, retryAllowed: false, submitted: null };
      return { outcome: 'SUBMITTED', data, retryAllowed: false, submitted: true };
    }
  };
}
