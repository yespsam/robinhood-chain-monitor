import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { Denied } from './auth.mjs';
import { validChain, validContract, decimal, decimalExceedsInteger, addressKey } from './model.mjs';
import { WalletFailure, officialFailure, stageFor } from './diagnostics.mjs';

const runFile = promisify(execFile);
const packageRoot = new URL('../node_modules/@binance/agentic-wallet/', import.meta.url);
export const DOCUMENTED_CLI_VERSION = '1.11.0';
// The vendor documents urlForWeb as a verbatim, server-generated link, not a
// fixed example path. Exact official domains only; never a suffix wildcard.
export const OFFICIAL_AUTH_HOSTS = Object.freeze(['web3.binance.com', 'www.binance.com', 'app.binance.com']);
// Inspect public package metadata only. Prefer the existing macOS installation so
// its working native keychain dependency is reused; never inspect session files.
export const CLI_PACKAGE_ROOTS = Object.freeze([
  ...(process.platform === 'darwin' ? [new URL('file:///opt/homebrew/lib/node_modules/@binance/agentic-wallet/'),
    new URL('file:///usr/local/lib/node_modules/@binance/agentic-wallet/')] : []), packageRoot
]);
const reviewed = m => m?.name === '@binance/agentic-wallet' && m.version === DOCUMENTED_CLI_VERSION && m.bin?.baw === 'dist/index.js';
export async function resolveCliInstallation({ roots = CLI_PACKAGE_ROOTS,
  readMetadataAt = async url => JSON.parse(await readFile(url, 'utf8')) } = {}) {
  for (const root of roots) {
    let metadata;
    try { metadata = await readMetadataAt(new URL('package.json', root)); }
    catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new WalletFailure('CLI_VERSION_REVIEW_REQUIRED', 'LOCAL');
    }
    if (!reviewed(metadata)) throw new WalletFailure('CLI_VERSION_REVIEW_REQUIRED', 'LOCAL');
    return { root, metadata, entryPath: fileURLToPath(new URL('dist/index.js', root)) };
  }
  throw new WalletFailure('OFFICIAL_CLI_NOT_INSTALLED', 'LOCAL');
}
export async function cliVersionInfo() {
  let installedVersion = null;
  try {
    const { metadata: v } = await resolveCliInstallation();
    if (v.name === '@binance/agentic-wallet' && typeof v.version === 'string' && /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(v.version)) installedVersion = v.version;
  } catch { /* Absent/invalid is unknown, not a claimed installed version. */ }
  return { installedVersion, skillRequiredVersion: DOCUMENTED_CLI_VERSION, reviewedVersion: DOCUMENTED_CLI_VERSION,
    latestVersion: null, minimumSupportedVersion: null };
}

// Only the vendor-documented CLI is used. No guessed HTTP endpoints, cookie extraction or key reading.
// The adapter NEVER provides swap/send/limit placement/revoke execution or a shell escape hatch.
export const CLI_TIMEOUTS = Object.freeze({ verify: 310_000, other: 25_000 });
// Validate the complete argument vector even if an internal caller bypasses the
// typed adapter. No arbitrary flags, executable path, financial write or shell.
export function assertAllowedCliArgs(args) {
  if (!Array.isArray(args) || args.some(x => typeof x !== 'string' || x.length > 512) || args.length < 2)
    throw new Denied('CLI_COMMAND_NOT_ALLOWED', 400);
  const command = args.slice(0, 2).join(' '), flags = new Map();
  for (let i = 2; i < args.length; i += 2) {
    if (!args[i]?.startsWith('--') || args[i + 1] === undefined || args[i + 1].startsWith('-') || flags.has(args[i])) throw new Denied('CLI_COMMAND_NOT_ALLOWED', 400);
    flags.set(args[i], args[i + 1]);
  }
  const exact = (required, optional = []) => {
    if (required.some(k => !flags.has(k)) || [...flags.keys()].some(k => ![...required, ...optional].includes(k)))
      throw new Denied('CLI_COMMAND_NOT_ALLOWED', 400);
  };
  const chain = () => validChain(flags.get('--binanceChainId'));
  if (['wallet status', 'wallet address', 'wallet chains', 'wallet settings', 'auth signin', 'auth signout'].includes(command)) exact([]);
  else if (command === 'auth verify') {
    exact(['--qrCodeId']); if (!/^[a-zA-Z0-9_-]{1,128}$/.test(flags.get('--qrCodeId'))) throw new Denied('INVALID_AUTH_FLOW', 400);
  } else if (command === 'wallet balance') {
    exact(['--binanceChainId'], ['--tokenAddress']); chain();
    if (flags.has('--tokenAddress')) validContract(chain(), flags.get('--tokenAddress'));
  } else if (command === 'wallet tx-history') {
    exact(['--binanceChainId', '--type', '--size']); chain();
    if (!['all', 'pending', 'confirmed'].includes(flags.get('--type')) || flags.get('--size') !== '20') throw new Denied('INVALID_FILTER', 400);
  } else if (['market-order list', 'limit-order list'].includes(command)) {
    exact(['--binanceChainId', '--pageSize']); chain();
    if (flags.get('--pageSize') !== '20' || command === 'limit-order list' && !['56', 'CT_501'].includes(chain())) throw new Denied('INVALID_FILTER', 400);
  } else if (command === 'approvals list') {
    exact(['--binanceChainId']); if (chain() === 'CT_501') throw new Denied('APPROVALS_EVM_ONLY', 400);
  } else if (command === 'market-order quote') {
    exact(['--fromTokenQty', '--fromToken', '--toToken', '--binanceChainId', '--slippage']);
    validContract(chain(), flags.get('--fromToken')); validContract(chain(), flags.get('--toToken'));
    decimal(flags.get('--fromTokenQty')); decimal(flags.get('--slippage'), { zero: true });
    if (decimalExceedsInteger(flags.get('--slippage'), '100')) throw new Denied('INVALID_SLIPPAGE', 400);
  } else throw new Denied('CLI_COMMAND_NOT_ALLOWED', 400);
  return args;
}
export function createCliRunner({ execute = runFile, childEnv = process.env, readMetadata,
  resolveInstallation = resolveCliInstallation } = {}) {
  return async args => {
    assertAllowedCliArgs(args);
    const stage = stageFor(args), timeoutMs = stage === 'VERIFY' ? CLI_TIMEOUTS.verify : CLI_TIMEOUTS.other;
    let metadata, stdout, entryPath;
    try {
      if (readMetadata) { metadata = await readMetadata(); entryPath = fileURLToPath(new URL('dist/index.js', packageRoot)); }
      else ({ metadata, entryPath } = await resolveInstallation());
    } catch (error) {
      throw new WalletFailure(error.code === 'CLI_VERSION_REVIEW_REQUIRED' ? error.code : 'OFFICIAL_CLI_NOT_INSTALLED', stage);
    }
    if (!reviewed(metadata))
      throw new WalletFailure('CLI_VERSION_REVIEW_REQUIRED', stage);
    try {
      ({ stdout } = await execute(process.execPath, [entryPath, ...args, '--json'],
        { shell: false, windowsHide: true, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, env: childEnv }));
    } catch (error) {
      if (error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' && (error.killed === true || error.code === 'ETIMEDOUT'))
        throw new WalletFailure('CLI_TIMEOUT', stage, { timeoutMs });
      if (['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(error.code)) throw new WalletFailure('CLI_START_FAILED', stage);
      // A nonzero exit may still carry a structured official rejection. Never expose raw output.
      let value; try { value = JSON.parse(error.stdout); } catch { /* not structured */ }
      if (value?.success === false) throw officialFailure(value, stage, { exitCode: error.code });
      throw new WalletFailure('CLI_EXIT_FAILED', stage, { exitCode: error.code });
    }
    try { return JSON.parse(stdout); }
    catch { throw new WalletFailure('CLI_PARSE_FAILED', stage); }
  };
}
const text = value => typeof value === 'string' && value.length <= 512 && !/[\u0000-\u001f\u007f]/.test(value) ? value : null;
const list = value => {
  if (!Array.isArray(value) || value.some(x => !x || typeof x !== 'object' || Array.isArray(x))) throw new Denied('OFFICIAL_RESPONSE_INVALID', 503);
  return value;
};
const quota = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function scopedRows(rows, chain, field) {
  if (rows.some(x => x?.[field] !== chain)) throw new Denied('OFFICIAL_RESPONSE_CHAIN_MISMATCH', 503);
  return rows;
}
export class OfficialWallet {
  constructor(run = createCliRunner()) { this.run = run; }
  async call(args) {
    const result = await this.run(args);
    if (result?.success === false) throw officialFailure(result, stageFor(args));
    if (result?.success !== true) throw new WalletFailure('OFFICIAL_RESPONSE_INVALID', stageFor(args));
    return result.data;
  }
  async status() {
    const value = await this.call(['wallet', 'status']);
    return ['CONNECTED', 'UNCONNECTED', 'CREATING'].includes(value?.status) ? value.status : 'UNKNOWN';
  }
  async chains() {
    return list(await this.call(['wallet', 'chains'])).map(x => ({ id: text(x.binanceChainId), name: text(x.name) })).filter(x => x.id && x.name);
  }
  async addresses() {
    const value = await this.call(['wallet', 'address']);
    return list(value?.addresses).map(x => ({ chainId: text(x.binanceChainId), chainName: text(x.chainName), address: text(x.address) })).filter(x => x.chainId && x.address);
  }
  async settings() {
    const v = await this.call(['wallet', 'settings']);
    return { sessionExpireTime: text(v?.sessionExpireTime), inactiveSignOutTime: text(v?.inactiveSignOutTime),
      dailyLimit: quota(v?.dailyLimit), quotaLeft: quota(v?.quotaLeft), tradeAllTokens: v?.tradeAllTokens === true,
      abnormalTxnHandling: ['AutoReject', 'NeedConfirmation'].includes(v?.abnormalTxnHandling) ? v.abnormalTxnHandling : null,
      devMode: { enabled: v?.devMode?.enabled === true, balanceExceeded: v?.devMode?.balanceExceeded === true } };
  }
  async balance(chain, contract) {
    const args = ['wallet', 'balance', '--binanceChainId', validChain(chain)];
    if (contract) args.push('--tokenAddress', validContract(chain, contract));
    const rows = scopedRows(list(await this.call(args)), chain, 'binanceChainId');
    if (contract && rows.some(x => !x.address || addressKey(chain, x.address) !== addressKey(chain, contract))) throw new Denied('OFFICIAL_RESPONSE_TOKEN_MISMATCH', 503);
    return rows.map(x => ({ symbol: text(x.symbol), contract: text(x.address), chainId: text(x.binanceChainId),
      balance: text(x.balance), priceUsd: text(x.price), priceSource: 'Binance Agentic Wallet CLI', observedAt: new Date().toISOString() }));
  }
  async transactions(chain, type = 'all') {
    if (!['all', 'pending', 'confirmed'].includes(type)) throw new Denied('INVALID_FILTER', 400);
    const v = await this.call(['wallet', 'tx-history', '--binanceChainId', validChain(chain), '--type', type, '--size', '20']);
    return { transactions: scopedRows(list(v?.transactions), chain, 'binanceChainId').map(x => ({ chainId: text(x.binanceChainId), txHash: text(x.txHash),
      type: text(x.txType), time: text(x.txTime), status: text(x.status) })), hasMore: v?.hasMore === true };
  }
  async orders(chain, kind = 'market') {
    if (!['market', 'limit'].includes(kind)) throw new Denied('INVALID_ORDER_KIND', 400);
    if (kind === 'limit' && !['56', 'CT_501'].includes(chain)) throw new Denied('LIMIT_CHAIN_UNSUPPORTED', 400);
    const v = await this.call([kind + '-order', 'list', '--binanceChainId', validChain(chain), '--pageSize', '20']);
    return { list: scopedRows(list(v?.list), chain, 'chain').map(x => ({ chainId: text(x.chain), orderId: text(x.orderId || x.strategyId), type: kind,
      fromToken: text(x.fromToken), toToken: text(x.toToken), amount: text(x.fromTokenQty), status: text(x.status), txHash: text(x.txHash) })), total: Number.isSafeInteger(v?.total) ? v.total : null };
  }
  async approvals(chain) {
    if (chain === 'CT_501') throw new Denied('APPROVALS_EVM_ONLY', 400);
    const v = await this.call(['approvals', 'list', '--binanceChainId', validChain(chain)]);
    return scopedRows(list(v?.list), chain, 'binanceChainId').map(x => ({ chainId: text(x.binanceChainId), contract: text(x.tokenContract), spender: text(x.spender),
      amount: text(x.amount), type: text(x.type), symbol: text(x.tokenSymbol) }));
  }
  async quote({ chainId, fromToken, toToken, amount, slippage }) {
    decimal(amount); decimal(slippage, { zero: true });
    if (decimalExceedsInteger(slippage, '100')) throw new Denied('INVALID_SLIPPAGE', 400);
    const v = await this.call(['market-order', 'quote', '--fromTokenQty', amount, '--fromToken', validContract(chainId, fromToken),
      '--toToken', validContract(chainId, toToken), '--binanceChainId', validChain(chainId), '--slippage', slippage]);
    return { mode: 'official-quote', chainId, fromToken, toToken, amount, slippagePercent: slippage,
      fromSymbol: text(v?.fromCoinSymbol), toSymbol: text(v?.toCoinSymbol), estimatedOut: text(v?.toCoinAmount), observedAt: new Date().toISOString(),
      priceImpactPercent: null, gasTotal: null, knownFees: null, approvalPlan: null, immutableQuoteId: null, expiresAt: null };
  }
  // Invoked only by explicit same-origin wallet connection / sign-out controls.
  // No vendor session file is opened by this application.
  async beginOfficialSignIn() {
    const v = await this.call(['auth', 'signin']);
    if (v?.status === 'ALREADY_CONNECTED') return { alreadyConnected: true };
    if (typeof v?.urlForWeb !== 'string' || typeof v?.pairingCode !== 'string' || typeof v?.qrCodeId !== 'string')
      throw new Denied('INVALID_OFFICIAL_AUTH_RESPONSE', 503);
    let url; try {
      if (v.urlForWeb.length > 8192 || /[\u0000-\u0020\u007f\\]/.test(v.urlForWeb)) throw new Error();
      url = new URL(v.urlForWeb);
    } catch { throw new WalletFailure('AUTH_URL_REVIEW_REQUIRED', 'SIGNIN', { authUrlIssues: ['INVALID_URL'] }); }
    const authUrlIssues = [url.protocol !== 'https:' && 'SCHEME_MISMATCH', !OFFICIAL_AUTH_HOSTS.includes(url.hostname) && 'HOST_MISMATCH',
      (url.username || url.password) && 'EMBEDDED_CREDENTIALS',
      url.port && 'NONSTANDARD_PORT', url.hash && 'FRAGMENT_PRESENT'].filter(Boolean);
    if (authUrlIssues.length) throw new WalletFailure('AUTH_URL_REVIEW_REQUIRED', 'SIGNIN', { authUrlIssues });
    return { urlForWeb: v.urlForWeb, pairingCode: v.pairingCode, qrCodeId: v.qrCodeId, expireAt: v.expireAt };
  }
  async verifyOfficialSignIn(qrCodeId) {
    if (typeof qrCodeId !== 'string' || !/^[a-zA-Z0-9-]{1,128}$/.test(qrCodeId)) throw new Denied('INVALID_AUTH_FLOW', 400);
    const v = await this.call(['auth', 'verify', '--qrCodeId', qrCodeId]);
    return { verified: v?.status === 'SUCCESS' && await this.status() === 'CONNECTED' };
  }
  async officialSignOut() {
    const v = await this.call(['auth', 'signout']);
    return { localSessionCleared: v?.status === 'LOGGED_OUT', remoteOrdersCanceled: false, onchainApprovalsRevoked: false };
  }
}
