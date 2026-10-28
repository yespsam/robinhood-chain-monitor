import { Denied } from './auth.mjs';
import { OFFICIAL_ERRORS, CONNECTION_SIGNALS, safeOfficialIdentity, safeConnectionSignals, safeAuthUrlIssues } from '../public/official-error-catalog.js';

// All text is application-owned. Raw command lines, stdout/stderr, URLs and provider
// messages are deliberately excluded; even an upstream error can contain credentials.
const definitions = {
  CLI_START_FAILED: ['PROCESS_START', '本地 CLI 进程未能启动。', '检查 Node、已安装 CLI 文件及运行权限；无需填写 API Key。'],
  CLI_EXIT_FAILED: ['PROCESS_EXIT', 'CLI 进程异常退出。', '先核对官方状态，再检查本地运行环境；不能据此判定账户不符合条件。'],
  CLI_TIMEOUT: ['TIMEOUT', '本地等待达到时限，远端授权结果未确认。', '先核对官方状态；不要沿用旧配对码或重复发起验证。'],
  CLI_PARSE_FAILED: ['PARSE', 'CLI 返回内容无法解析为 JSON。', '检查 CLI 版本及输出兼容性；原始输出不会写入诊断。'],
  OFFICIAL_ERROR: ['OFFICIAL', '官方 CLI 返回错误，具体原因未确认。', '核对 Binance App 的提示，并先查询官方状态；不推断为网络或账户资格问题。'],
  AUTH_REJECTED: ['OFFICIAL', '官方返回 AUTH_REJECTED：可能为拒绝、配对码失效或其他授权失败。', '先核对官方状态；未连接时再申请新配对码，不重用旧码。'],
  OFFICIAL_RESPONSE_INVALID: ['RESPONSE', '官方响应结构不符合已核验文档。', '停止当前流程，核对官方文档与所装版本。'],
  OFFICIAL_CLI_NOT_INSTALLED: ['CONFIGURATION', '未找到本项目要求的官方 CLI。', '核对项目依赖安装状态；本页面不会自动安装。'],
  CLI_VERSION_REVIEW_REQUIRED: ['CONFIGURATION', '本机 CLI 与本项目已审查版本不一致。', '核对版本兼容性；不代表该版本不受 Binance 支持。'],
  AUTH_URL_REVIEW_REQUIRED: ['RESPONSE', '返回的授权地址不在已核验的官方范围内。', '不要打开该地址，先核对官方认证文档。'],
  INVALID_OFFICIAL_AUTH_RESPONSE: ['RESPONSE', '官方授权响应缺少必要字段。', '核对版本和官方响应格式，不拼接授权链接。'],
  INVALID_AUTH_FLOW: ['RESPONSE', '官方响应中的配对标识无法通过本地格式校验。', '停止验证并核对 CLI 输出格式；不要修改配对标识或重复提交。'],
  WALLET_AUTH_INVALID: ['AUTH_STATE', '官方状态尚未确认已连接。', '核对 App 状态后点击核对官方状态；打开链接不等于连接成功。'],
  WALLET_AUTH_EXPIRED: ['AUTH_STATE', '官方授权已过期或有效期无法核验。', '到官方 App 检查授权，再核对状态。'],
  WALLET_ADDRESS_UNCONFIRMED: ['IDENTITY', '无法核验钱包完整地址。', '停止绑定，并在 Binance App 核对目标钱包。'],
  WALLET_IDENTITY_MISMATCH: ['IDENTITY', '钱包地址与绑定不一致。', '重新核对目标钱包；不得使用其他钱包替代。'],
  AUTH_STATUS_UNCONFIRMED: ['AUTH_STATE', '官方钱包状态尚未确定，未创建新授权。', '稍后手动核对状态；不要重复生成配对码。'],
  AUTH_IN_PROGRESS: ['LOCAL_FLOW', '前一次官方操作仍在运行。', '等待其结束后手动核对状态；停止本页等待不会撤销远端授权。'],
  AUTH_RATE_LIMIT: ['LOCAL_FLOW', '请求过于频繁，未创建新授权。', '稍等片刻后核对官方状态。'],
  LOCAL_SESSION_EXPIRED: ['LOCAL_FLOW', '本页会话已失效。', '重新建立本页连接，然后先核对官方状态。'],
  INTERNAL_ERROR: ['LOCAL_FLOW', '本地流程未完成，原因未确认。', '复制脱敏诊断并核对运行环境；不要重复提交授权。']
};
const stages = new Set(['SIGNIN', 'VERIFY', 'STATUS', 'SETTINGS', 'CHAINS', 'ADDRESSES', 'BIND', 'READ', 'QUOTE', 'SIGNOUT', 'LOCAL']);
export function stageFor(args) {
  return ({ 'auth signin': 'SIGNIN', 'auth verify': 'VERIFY', 'auth signout': 'SIGNOUT', 'wallet status': 'STATUS',
    'wallet settings': 'SETTINGS', 'wallet chains': 'CHAINS', 'wallet address': 'ADDRESSES', 'market-order quote': 'QUOTE' })[args.slice(0, 2).join(' ')] || 'READ';
}
export function diagnostic(code, stage = 'LOCAL', details = {}) {
  const safeCode = Object.hasOwn(definitions, code) ? code : 'INTERNAL_ERROR';
  const [category, message, nextStep] = definitions[safeCode];
  const result = { code: safeCode, category, stage: stages.has(stage) ? stage : 'LOCAL', message, nextStep, at: new Date().toISOString() };
  if ([25_000, 310_000].includes(details.timeoutMs)) result.timeoutMs = details.timeoutMs;
  if (Number.isInteger(details.exitCode) && Math.abs(details.exitCode) < 65536) result.exitCode = details.exitCode;
  Object.assign(result, safeOfficialIdentity(details));
  const official = OFFICIAL_ERRORS[result.officialName];
  if (official && ['OFFICIAL_ERROR', 'AUTH_REJECTED'].includes(safeCode)) {
    result.category = official.category; result.message = official.message;
    if (official.category === 'NETWORK') result.nextStep = '检查本机到官方服务的网络连接；保持证书校验。恢复后先核对状态，不直接重复授权。';
    else if (official.category === 'LOCAL_STORAGE') result.nextStep = '检查启动服务的系统用户和文件权限；不读取、复制或删除官方凭证文件。';
    else if (official.category === 'TIMEOUT') result.nextStep = definitions.CLI_TIMEOUT[2];
  }
  if (result.officialName === 'SERVICE_ERROR') result.message = 'CLI 转述服务端错误；错误码已保留，具体含义未确认。';
  const signals = safeConnectionSignals(details.connectionSignals);
  if (signals.length) result.connectionSignals = signals;
  if (Number.isInteger(details.httpStatus) && details.httpStatus >= 400 && details.httpStatus <= 599) result.httpStatus = details.httpStatus;
  if (safeCode === 'AUTH_URL_REVIEW_REQUIRED') { const issues = safeAuthUrlIssues(details.authUrlIssues); if (issues.length) result.authUrlIssues = issues; }
  return result;
}
export class WalletFailure extends Denied {
  constructor(code, stage, details) { super(code, code === 'CLI_TIMEOUT' ? 504 : 503); this.diagnostic = diagnostic(code, stage, details); }
}
export function safeDiagnostic(error, fallbackStage = 'LOCAL') {
  return diagnostic(error?.diagnostic?.code || error?.code, error?.diagnostic?.stage || fallbackStage, error?.diagnostic || {});
}
export function officialFailure(value, stage, details = {}) {
  const known = value?.error?.name === 'AUTH_REJECTED' && value?.error?.code === 10002004;
  const identity = safeOfficialIdentity({ officialName: value?.error?.name, officialCode: value?.error?.code });
  const message = typeof value?.error?.message === 'string' ? value.error.message.slice(0, 8192) : '';
  const connectionSignals = CONNECTION_SIGNALS.filter(x => new RegExp('\\b' + x + '\\b').test(message));
  const httpMatch = message.match(/\b(?:HTTP(?: status)?|status code)\s*[:=]?\s*(4\d\d|5\d\d)\b/i);
  return new WalletFailure(known ? 'AUTH_REJECTED' : 'OFFICIAL_ERROR', stage, { ...details, ...identity, connectionSignals, ...(httpMatch ? { httpStatus: Number(httpMatch[1]) } : {}) });
}
