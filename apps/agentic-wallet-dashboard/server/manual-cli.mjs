import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { resolveCliInstallation, DOCUMENTED_CLI_VERSION } from './official-cli.mjs';
import { validChain, validContract, decimal, addressKey, CORE_CHAINS } from './model.mjs';
import { Denied } from './auth.mjs';
import { safeOfficialIdentity } from '../public/official-error-catalog.js';

const runFile = promisify(execFile);
export const MANUAL_CHAINS = Object.freeze(CORE_CHAINS.map(c => c.id));
export const AUDIT_ENDPOINT = 'https://web3.binance.com/bapi/defi/v1/public/wallet-direct/security/token/audit';
export const AUDIT_DOCUMENTATION = 'https://github.com/binance/binance-skills-hub/blob/main/skills/binance-web3/query-token-audit/SKILL.md';
const SOURCE = 'Binance Agentic Wallet CLI';
const fixedMessages = Object.freeze({ CLI_NOT_AVAILABLE: '已审查的官方 CLI 不可用。', CLI_START_FAILED: '官方 CLI 未能启动。',
  OFFICIAL_REJECTED: '官方服务已拒绝此次请求。', SUBMISSION_UNKNOWN: '提交结果未知，请核对官方订单；禁止自动重试。',
  READ_FAILED: '官方读取失败，请稍后重新查询状态。', INVALID_RESPONSE: '官方响应未能通过格式或身份校验。' });
export class ManualCliError extends Error {
  constructor(code, identity = {}) {
    super(fixedMessages[code] || fixedMessages.READ_FAILED); this.code = code; Object.assign(this, safeOfficialIdentity(identity));
  }
}
const plain = (v, max = 512) => typeof v === 'string' && v.length <= max && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
const amountText = v => {
  try { return decimal(v, { zero: true }); } catch { return null; }
};
const checkedChain = chain => {
  validChain(chain); if (!MANUAL_CHAINS.includes(chain)) throw new Denied('MANUAL_CHAIN_UNSUPPORTED', 400); return chain;
};
const orderIdText = value => typeof value === 'string' && /^[0-9]{1,64}$/.test(value) ? value : null;
function fields(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)))
    throw new Denied('INVALID_MANUAL_FIELDS', 400);
}
function swapArguments(trade) {
  fields(trade, ['chainId', 'fromToken', 'toToken', 'amount', 'slippage']);
  const { chainId, fromToken, toToken, amount, slippage } = trade;
  checkedChain(chainId); validContract(chainId, fromToken); validContract(chainId, toToken);
  if (addressKey(chainId, fromToken) === addressKey(chainId, toToken)) throw new Denied('IDENTICAL_TOKEN_PAIR', 400);
  decimal(amount); decimal(slippage, { zero: true });
  if (Number(slippage) > 100) throw new Denied('INVALID_SLIPPAGE', 400);
  return ['market-order', 'swap', '--fromTokenQty', amount, '--fromToken', fromToken, '--toToken', toToken,
    '--binanceChainId', chainId, '--slippage', slippage, '--mev', 'true', '--gasLevel', 'MEDIUM'];
}
function rejectionIdentity(value) {
  return safeOfficialIdentity({ officialName: value?.error?.name, officialCode: value?.error?.code });
}
// A generic service failure may occur after acceptance. Only explicit local /
// validation / authentication failures establish that submission was rejected.
const definitelyRejected = identity => ['INVALID_PARAMS', 'NOT_LOGGED_IN', 'UNAUTHORIZED',
  'SESSION_EXPIRED', 'SESSION_NOT_FOUND', 'WALLET_NOT_EXIST', 'WALLET_CREATING', 'NOT_IMPLEMENTED'].includes(identity.officialName);
function cleanHash(chainId, value) {
  return typeof value === 'string' && (chainId === 'CT_501' ? /^[1-9A-HJ-NP-Za-km-z]{64,100}$/ : /^0x[0-9a-fA-F]{64}$/).test(value) ? value : null;
}
function cleanDate(value) { return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : null; }

// Deliberately separate from the read-only adapter: the private runner is never
// exported and accepts no caller-supplied argv. Invocation requires the separate
// application's review/confirmation/journal gate. No automatic retries exist.
export function createManualCli({ execute = runFile, resolveInstallation = resolveCliInstallation,
  childEnv = process.env, clock = Date.now } = {}) {
  async function run(args, submitting = false) {
    let installation;
    try {
      installation = await resolveInstallation();
      const m = installation.metadata;
      if (m?.name !== '@binance/agentic-wallet' || m.version !== DOCUMENTED_CLI_VERSION || m.bin?.baw !== 'dist/index.js' ||
          typeof installation.entryPath !== 'string' || !installation.entryPath.endsWith('/dist/index.js')) throw Error('unreviewed');
    } catch { return { kind: 'not-started', code: 'CLI_NOT_AVAILABLE' }; }
    let stdout;
    try {
      ({ stdout } = await execute(process.execPath, [installation.entryPath, ...args, '--json'], {
        shell: false, windowsHide: true, timeout: submitting ? 90_000 : 25_000, maxBuffer: 4 * 1024 * 1024, env: childEnv
      }));
    } catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM', 'ENOEXEC'].includes(error.code)) return { kind: 'not-started', code: 'CLI_START_FAILED' };
      if (error.killed || error.code === 'ETIMEDOUT' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return { kind: 'unknown', code: 'SUBMISSION_UNKNOWN' };
      stdout = error.stdout;
    }
    let value;
    try { value = JSON.parse(stdout); } catch { return { kind: 'unknown', code: 'SUBMISSION_UNKNOWN' }; }
    if (value?.success === false) {
      const identity = rejectionIdentity(value);
      return { kind: definitelyRejected(identity) ? 'rejected' : 'unknown', identity,
        code: definitelyRejected(identity) ? 'OFFICIAL_REJECTED' : 'SUBMISSION_UNKNOWN' };
    }
    if (value?.success !== true || !value.data || typeof value.data !== 'object' || Array.isArray(value.data))
      return { kind: 'unknown', code: 'SUBMISSION_UNKNOWN' };
    return { kind: 'success', data: value.data };
  }
  async function read(args) {
    const result = await run(args);
    if (result.kind !== 'success') throw new ManualCliError(result.kind === 'not-started' ? result.code : 'READ_FAILED', result.identity);
    return result.data;
  }
  return {
    async executeSwap(trade) {
      const args = swapArguments(trade); // Validation happens before metadata or process access.
      const result = await run(args, true), observedAt = new Date(clock()).toISOString();
      const orderId = result.kind === 'success' ? orderIdText(result.data.orderId) : null;
      const status = orderId ? 'SUBMITTED' : ['not-started', 'rejected'].includes(result.kind) ? 'REJECTED' : 'UNKNOWN';
      const code = status === 'SUBMITTED' ? 'ORDER_SUBMITTED' : status === 'UNKNOWN' ? 'SUBMISSION_UNKNOWN' : result.code;
      return { status, outcome: status, orderId, code, ...result.identity, submitted: status === 'SUBMITTED' ? true : status === 'REJECTED' ? false : null,
        retryAllowed: false, message: status === 'SUBMITTED' ? '订单已提交，尚未确认成交。' : fixedMessages[code], source: SOURCE, observedAt };
    },
    async readOrder(request) {
      fields(request, ['orderId', 'chainId']); const chainId = checkedChain(request.chainId), orderId = orderIdText(request.orderId);
      if (!orderId) throw new Denied('INVALID_ORDER_ID', 400);
      const data = await read(['market-order', 'list', '--orderId', orderId]);
      if (!Array.isArray(data.list) || data.list.length > 1) throw new ManualCliError('INVALID_RESPONSE');
      const list = data.list.map(row => {
        if (!row || row.orderId !== orderId || row.chain !== chainId || !['PENDING', 'FINISHED', 'FAILED'].includes(row.status))
          throw new ManualCliError('INVALID_RESPONSE');
        try { validContract(chainId, row.fromToken); validContract(chainId, row.toToken); } catch { throw new ManualCliError('INVALID_RESPONSE'); }
        return { orderId, chain: chainId, chainId, orderType: 'market', status: row.status, fromToken: row.fromToken, toToken: row.toToken,
          fromTokenQty: amountText(row.fromTokenQty), toTokenQty: amountText(row.toTokenQty), toTokenActualQty: amountText(row.toTokenActualQty),
          fromTokenName: plain(row.fromTokenName, 80), toTokenName: plain(row.toTokenName, 80),
          txHash: cleanHash(chainId, row.txHash), slippage: amountText(row.slippage), bookTime: cleanDate(row.bookTime), updatedTime: cleanDate(row.updatedTime) };
      });
      return { list, total: list.length, source: SOURCE, observedAt: new Date(clock()).toISOString() };
    },
    async txLock(chainId) {
      checkedChain(chainId); const data = await read(['wallet', 'tx-lock', '--binanceChainId', chainId]);
      if (!['LOCKED', 'UNLOCKED'].includes(data.status)) throw new ManualCliError('INVALID_RESPONSE');
      return { status: data.status, chainId, source: SOURCE, observedAt: new Date(clock()).toISOString() };
    },
    async gasPrice(chainId) {
      checkedChain(chainId); const data = await read(['wallet', 'gas-price', '--binanceChainId', chainId]);
      const output = { chainId, baseFeePerGas: amountText(data.baseFeePerGas), unit: chainId === 'CT_501' ? 'micro-lamports' : 'gwei',
        source: SOURCE, observedAt: new Date(clock()).toISOString(), totalGasCost: null };
      for (const level of ['low', 'medium', 'high']) {
        const row = data[level]; if (!row || typeof row !== 'object') throw new ManualCliError('INVALID_RESPONSE');
        const gasPrice = amountText(row.gasPrice), maxFeePerGas = amountText(row.maxFeePerGas), maxPriorityFeePerGas = amountText(row.maxPriorityFeePerGas);
        if (gasPrice === null || Number(gasPrice) <= 0 || chainId !== 'CT_501' && (maxFeePerGas === null || maxPriorityFeePerGas === null))
          throw new ManualCliError('INVALID_RESPONSE');
        output[level] = { gasPrice, maxFeePerGas, maxPriorityFeePerGas, tipAmount: amountText(row.tipAmount),
          waitTimeEstimate: Number.isSafeInteger(row.waitTimeEstimate) && row.waitTimeEstimate >= 0 ? row.waitTimeEstimate : null };
      }
      return output;
    }
  };
}

const auditText = value => typeof value === 'string' ? value.replace(/<[^>]*>/g, '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 600) : '';
const auditUnknown = (chainId, contractAddress, code, clock) => ({ status: 'UNKNOWN', hasResult: false, isSupported: false, blocked: false,
  riskLevel: null, riskLevelEnum: null, riskItems: [], buyTax: null, sellTax: null, isVerified: null,
  requiresAcknowledgment: true, code, chainId, contractAddress, source: 'Binance public token audit', observedAt: new Date(clock()).toISOString() });

export async function evaluateTargetAudit(request, { fetchImpl = globalThis.fetch, clock = Date.now, uuid = randomUUID } = {}) {
  fields(request, ['chainId', 'contractAddress']); const { chainId, contractAddress } = request;
  validChain(chainId); validContract(chainId, contractAddress);
  if (!MANUAL_CHAINS.includes(chainId)) return auditUnknown(chainId, contractAddress, 'AUDIT_CHAIN_UNSUPPORTED', clock);
  const requestId = uuid();
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)) throw new Denied('INVALID_AUDIT_REQUEST_ID', 400);
  let response;
  try {
    const result = await fetchImpl(AUDIT_ENDPOINT, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12_000),
      headers: { 'Content-Type': 'application/json', source: 'agent', 'Accept-Encoding': 'identity', 'User-Agent': 'binance-web3/1.4 (Skill)' },
      body: JSON.stringify({ binanceChainId: chainId, contractAddress, requestId }) });
    if (!result.ok) return auditUnknown(chainId, contractAddress, 'AUDIT_UNAVAILABLE', clock);
    const reader = result.body.getReader(); let length = 0; const chunks = [];
    try { for (;;) { const { done, value } = await reader.read(); if (done) break;
      length += value.byteLength; if (length > 256 * 1024) throw Error('oversized'); chunks.push(Buffer.from(value));
    } } finally { await reader.cancel().catch(() => {}); }
    response = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return auditUnknown(chainId, contractAddress, 'AUDIT_UNAVAILABLE', clock); }
  const data = response?.data;
  if (response?.success !== true || response.code !== '000000' || !data || data.requestId !== requestId)
    return auditUnknown(chainId, contractAddress, 'AUDIT_INVALID_RESPONSE', clock);
  if (data.hasResult !== true || data.isSupported !== true) {
    return { ...auditUnknown(chainId, contractAddress, 'AUDIT_DATA_UNAVAILABLE', clock), hasResult: data.hasResult === true, isSupported: data.isSupported === true };
  }
  const riskLevel = typeof data.riskLevel === 'string' && /^[0-5]$/.test(data.riskLevel) ? Number(data.riskLevel) : data.riskLevel;
  const validLevel = Number.isInteger(riskLevel) && riskLevel >= 0 && riskLevel <= 5;
  const validGroups = Array.isArray(data.riskItems) && data.riskItems.length <= 20;
  const riskItems = []; let malformed = !validLevel || !validGroups;
  for (const group of validGroups ? data.riskItems : []) {
    if (!group || !Array.isArray(group.details) || group.details.length > 100) { malformed = true; continue; }
    for (const item of group.details) {
      if (!item || typeof item.isHit !== 'boolean' || !['RISK', 'CAUTION'].includes(item.riskType)) { malformed = true; continue; }
      const category = ['CONTRACT_RISK', 'TRADE_RISK', 'SCAM_RISK'].includes(group.id) ? group.id : 'OTHER_RISK';
      riskItems.push({ code: category, title: auditText(item.title), description: auditText(item.description), isHit: item.isHit, riskType: item.riskType });
    }
  }
  const buyTax = amountText(data.extraInfo?.buyTax), sellTax = amountText(data.extraInfo?.sellTax);
  const blocked = validLevel && riskLevel >= 4 || riskItems.some(i => i.isHit && i.riskType === 'RISK') || [buyTax, sellTax].some(v => v !== null && Number(v) > 10);
  const recognizedLevel = riskLevel <= 1 ? data.riskLevelEnum === 'LOW' : riskLevel <= 3 ? ['MID', 'MEDIUM'].includes(data.riskLevelEnum) : data.riskLevelEnum === 'HIGH';
  if (!blocked && (malformed || !recognizedLevel || data.isHidden === true)) return auditUnknown(chainId, contractAddress, 'AUDIT_INVALID_RESPONSE', clock);
  const warning = riskLevel >= 2 || riskItems.some(i => i.isHit) || [buyTax, sellTax].some(v => v !== null && Number(v) >= 5) || buyTax === null || sellTax === null;
  return { status: blocked ? 'BLOCKED' : warning ? 'WARNING' : 'CLEAR', hasResult: true, isSupported: true, blocked,
    riskLevel: validLevel ? riskLevel : null, riskLevelEnum: validLevel ? riskLevel <= 1 ? 'LOW' : riskLevel <= 3 ? 'MEDIUM' : 'HIGH' : null, riskItems, buyTax, sellTax,
    isVerified: typeof data.extraInfo?.isVerified === 'boolean' ? data.extraInfo.isVerified : null,
    requiresAcknowledgment: !blocked && warning, code: blocked ? 'AUDIT_CRITICAL_RISK' : warning ? 'AUDIT_WARNING' : 'AUDIT_NO_CRITICAL_RISK_REPORTED',
    chainId, contractAddress, source: 'Binance public token audit', observedAt: new Date(clock()).toISOString(),
    disclaimer: '审计是时点信息，不代表安全保证；请自行研究。' };
}
export const auditTarget = evaluateTargetAudit;
