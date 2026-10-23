// Error-name/code pairs verified in the installed official @binance/agentic-wallet
// 1.11.0 distribution. This is an error allowlist, not an API/endpoint definition.
const rows = {
  UNKNOWN_ERROR: [1001001, 'OFFICIAL', 'CLI 报告未知错误。'],
  INVALID_PARAMS: [1001002, 'RESPONSE', 'CLI 报告参数无效。'],
  INVALID_JSON: [1001003, 'PARSE', 'CLI 报告 JSON 无法解析。'],
  LOGIN_API_ERROR: [10001001, 'OFFICIAL', 'CLI 报告登录接口调用失败；底层原因未确认。'],
  QR_CODE_GENERATE_FAILED: [10001002, 'OFFICIAL', 'CLI 报告二维码生成失败。'],
  QR_CODE_EXPIRED: [10001003, 'AUTH_STATE', 'CLI 报告二维码已过期。'],
  QR_CODE_INVALID: [10001004, 'AUTH_STATE', 'CLI 报告二维码标识无效。'],
  POLLING_TIMEOUT: [10001005, 'TIMEOUT', 'CLI 报告轮询超时；远端授权结果未确认。'],
  VERIFY_API_ERROR: [10002001, 'OFFICIAL', 'CLI 报告验证接口调用失败。'],
  MISSING_QR_CODE_ID: [10002002, 'RESPONSE', 'CLI 报告缺少配对标识。'],
  AUTH_REJECTED: [10002004, 'OFFICIAL', 'CLI 报告授权失败；可能为拒绝或二维码失效，具体原因未确认。'],
  NOT_LOGGED_IN: [10003000, 'AUTH_STATE', 'CLI 报告尚未登录。'],
  UNAUTHORIZED: [10003001, 'AUTH_STATE', 'CLI 报告未获授权。'],
  SESSION_EXPIRED: [10003002, 'AUTH_STATE', 'CLI 报告会话过期。'],
  SESSION_NOT_FOUND: [10003003, 'AUTH_STATE', 'CLI 报告未找到会话。'],
  SESSION_READ_FAILED: [10003004, 'LOCAL_STORAGE', 'CLI 报告本机会话读取失败。'],
  SESSION_WRITE_FAILED: [10003005, 'LOCAL_STORAGE', 'CLI 报告本机会话保存失败。'],
  COOKIE_PARSE_FAILED: [10003006, 'RESPONSE', 'CLI 报告其内部认证数据解析失败；看板未读取该数据。'],
  WALLET_NOT_EXIST: [20001001, 'AUTH_STATE', 'CLI 报告钱包不存在。'],
  WALLET_CREATING: [20001002, 'AUTH_STATE', 'CLI 报告钱包正在创建。'],
  WALLET_STATUS_ERROR: [20001003, 'AUTH_STATE', 'CLI 报告钱包状态异常。'],
  WALLET_API_ERROR: [20001004, 'OFFICIAL', 'CLI 报告钱包接口调用失败。'],
  NETWORK_ERROR: [50001001, 'NETWORK', 'CLI 报告网络连接失败。'],
  REQUEST_TIMEOUT: [50001002, 'TIMEOUT', 'CLI 报告网络请求超时；远端结果未确认。'],
  SERVICE_UNAVAILABLE: [50001003, 'NETWORK', 'CLI 报告服务不可用。'],
  DNS_RESOLVE_FAILED: [50001004, 'NETWORK', 'CLI 报告 DNS 解析失败。'],
  SSL_ERROR: [50001005, 'NETWORK', 'CLI 报告 TLS / SSL 证书错误。'],
  FILE_READ_ERROR: [50002001, 'LOCAL_STORAGE', 'CLI 报告本地文件读取失败。'],
  FILE_WRITE_ERROR: [50002002, 'LOCAL_STORAGE', 'CLI 报告本地文件写入失败。'],
  DIR_CREATE_ERROR: [50002003, 'LOCAL_STORAGE', 'CLI 报告本地目录创建失败。'],
  INTERNAL_ERROR: [50003001, 'OFFICIAL', 'CLI 报告内部错误。'],
  CONFIG_ERROR: [50003002, 'CONFIGURATION', 'CLI 报告配置错误。'],
  NOT_IMPLEMENTED: [50003003, 'OFFICIAL', 'CLI 报告该功能尚未实现。']
};
export const OFFICIAL_ERRORS = Object.freeze(Object.fromEntries(Object.entries(rows).map(([name, [code, category, message]]) => [name, Object.freeze({ code, category, message })])));
// Never copy arbitrary provider names/messages. A bounded numeric error code is
// retained even when its meaning is unknown, so Binance can identify the failure.
export function safeOfficialIdentity(value) {
  const out = {};
  if (Number.isInteger(value?.officialCode) && value.officialCode >= 0 && value.officialCode <= 99999999) out.officialCode = value.officialCode;
  const name = value?.officialName;
  if (typeof name === 'string' && ((Object.hasOwn(OFFICIAL_ERRORS, name) && OFFICIAL_ERRORS[name].code === out.officialCode) || (name === 'SERVICE_ERROR' && out.officialCode !== undefined))) out.officialName = name;
  return out;
}
export const CONNECTION_SIGNALS = Object.freeze(['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);
export function safeConnectionSignals(value) {
  return Array.isArray(value) ? CONNECTION_SIGNALS.filter(x => value.includes(x)) : [];
}
// Fixed rejection reasons only: never copy a returned URL, hostname, path or query.
export const AUTH_URL_ISSUES = Object.freeze({
  INVALID_URL: '地址无法解析', SCHEME_MISMATCH: '不是已核验的 HTTPS 地址',
  HOST_MISMATCH: '域名与官方文档示例不一致', PATH_MISMATCH: '路径与官方文档示例不一致',
  EMBEDDED_CREDENTIALS: '地址包含用户信息', NONSTANDARD_PORT: '地址包含非标准端口',
  FRAGMENT_PRESENT: '地址包含片段'
});
export function safeAuthUrlIssues(value) {
  return Array.isArray(value) ? [...new Set(value.filter(x => typeof x === 'string' && Object.hasOwn(AUTH_URL_ISSUES, x)))] : [];
}

