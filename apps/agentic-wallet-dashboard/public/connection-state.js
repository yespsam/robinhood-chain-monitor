export const PHASES = Object.freeze({ DISCONNECTED: '未连接', CHECKING: '核验中', STARTING: '请求授权中',
  WAITING: '等待 App 确认', VERIFYING: '核验中', REVIEW: '核验中 · 待本人核对地址', CONNECTED: '已连接',
  FAILED: '失败', TIMEOUT: '超时', PAUSED: '已停止本页等待' });
export const activePhases = ['CHECKING', 'STARTING', 'WAITING', 'VERIFYING'];
const codes = new Set(['CLI_START_FAILED', 'CLI_EXIT_FAILED', 'CLI_TIMEOUT', 'CLI_PARSE_FAILED', 'OFFICIAL_ERROR', 'AUTH_REJECTED',
  'OFFICIAL_RESPONSE_INVALID', 'OFFICIAL_CLI_NOT_INSTALLED', 'CLI_VERSION_REVIEW_REQUIRED', 'AUTH_URL_REVIEW_REQUIRED',
  'INVALID_OFFICIAL_AUTH_RESPONSE', 'INVALID_AUTH_FLOW', 'WALLET_AUTH_INVALID', 'WALLET_AUTH_EXPIRED', 'WALLET_ADDRESS_UNCONFIRMED',
  'WALLET_IDENTITY_MISMATCH', 'AUTH_STATUS_UNCONFIRMED', 'AUTH_IN_PROGRESS', 'AUTH_RATE_LIMIT', 'LOCAL_SESSION_EXPIRED',
  'LOCAL_SERVICE_UNAVAILABLE', 'LOCAL_RESPONSE_PARSE_FAILED', 'INTERNAL_ERROR']);
const categories = new Set(['PROCESS_START', 'PROCESS_EXIT', 'TIMEOUT', 'PARSE', 'OFFICIAL', 'RESPONSE', 'CONFIGURATION', 'AUTH_STATE', 'IDENTITY', 'LOCAL_FLOW', 'LOCAL_HTTP', 'NETWORK', 'LOCAL_STORAGE']);
export const STAGES = Object.freeze({ SIGNIN: '生成官方授权链接', VERIFY: '等待 App 确认', STATUS: '核对官方连接状态',
  SETTINGS: '核对授权期限', CHAINS: '核对网络', ADDRESSES: '核对钱包身份', BIND: '绑定本人确认的地址',
  READ: '账户查询', QUOTE: '报价查询', SIGNOUT: '退出官方 CLI', LOCAL: '本页会话', HTTP: '本机接口连接' });
export function safeDiagnosticExport(value) {
  if (!value) return null;
  const d = { code: codes.has(value.code) ? value.code : 'INTERNAL_ERROR', category: categories.has(value.category) ? value.category : 'LOCAL_FLOW',
    stage: Object.hasOwn(STAGES, value.stage) ? value.stage : 'LOCAL' };
  if (typeof value.at === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.at)) d.at = value.at;
  if ([25000, 310000].includes(value.timeoutMs)) d.timeoutMs = value.timeoutMs;
  if (Number.isInteger(value.exitCode) && Math.abs(value.exitCode) < 65536) d.exitCode = value.exitCode;
  Object.assign(d, safeOfficialIdentity(value));
  const signals = safeConnectionSignals(value.connectionSignals); if (signals.length) d.connectionSignals = signals;
  if (Number.isInteger(value.httpStatus) && value.httpStatus >= 400 && value.httpStatus <= 599) d.httpStatus = value.httpStatus;
  if (d.code === 'AUTH_URL_REVIEW_REQUIRED') { const issues = safeAuthUrlIssues(value.authUrlIssues); if (issues.length) d.authUrlIssues = issues; }
  return d;
}
export function diagnosticText(state, lastDiagnostic, testMode = false, cli = {}) {
  const version = v => typeof v === 'string' && /^\d+\.\d+\.\d+(-[a-zA-Z0-9.-]+)?$/.test(v) ? v : '未确认';
  return JSON.stringify({ schema: 2, appVersion: '0.4.0', environment: testMode ? 'SIMULATED_TEST_ONLY' : 'local',
    installedCli: version(cli.installedVersion), skillRequiredCli: version(cli.skillRequiredVersion), latestCli: '未确认', minimumSupportedCli: '未确认',
    phase: Object.hasOwn(PHASES, state?.phase) ? state.phase : 'DISCONNECTED', stage: Object.hasOwn(STAGES, state?.stage) ? state.stage : 'LOCAL',
    diagnosticScope: !lastDiagnostic ? 'NONE' : state?.diagnostic === lastDiagnostic ? 'CURRENT_FAILURE' : 'PREVIOUS_FAILURE', diagnostic: safeDiagnosticExport(lastDiagnostic),
    liveTrades: state?.capabilities?.liveTrades === true, manualTrades: state?.capabilities?.manualTrades === true, automation: false }, null, 2);
}
import { safeOfficialIdentity, safeConnectionSignals, safeAuthUrlIssues } from './official-error-catalog.js';
