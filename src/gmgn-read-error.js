// Reduce private CLI diagnostics to an allowlisted category. Never return
// provider text, command strings, URLs, headers or credentials to callers.
export const GMGN_READ_ERROR_CODES=Object.freeze(['GMGN_NETWORK_FAILED','GMGN_AUTH_FAILED',
  'GMGN_UPSTREAM_FAILED','GMGN_CONFIG_FAILED','GMGN_INVALID_RESPONSE']);
export function classifyGmgnReadError(error) {
  if(GMGN_READ_ERROR_CODES.includes(error?.code))return error.code;
  const text=[error?.code,error?.message,error?.stderr,error?.stdout].filter(v=>typeof v==='string').join(' ');
  if(/\b(?:ENOTFOUND|EAI_AGAIN|ECONNRESET|ECONNREFUSED|ENETUNREACH|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT)\b|fetch failed|network (?:error|unreachable)/i.test(text))return 'GMGN_NETWORK_FAILED';
  if(/\b(?:HTTP(?: status)?\s*[:=]?\s*(?:401|403)|unauthorized|forbidden|invalid api key|api key expired)\b/i.test(text))return 'GMGN_AUTH_FAILED';
  if(/\bHTTP(?: status)?\s*[:=]?\s*5\d\d\b|bad gateway|service unavailable|gateway timeout/i.test(text))return 'GMGN_UPSTREAM_FAILED';
  return null;
}
