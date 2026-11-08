// Redaction for anything that may reach a network-visible surface (mobile board, decisions log).
// Keeps addresses/tx hashes (public) but strips URLs' query strings, bearer/api keys, long secrets,
// home paths and IPs, and maps raw CLI errors to a short category.
export function redactText(text, max = 240) {
  let s = String(text ?? "");
  s = s.replace(/(https?:\/\/[^\s?#"']+)[?#][^\s"']*/gi, "$1?…");
  s = s.replace(/\b(bearer|authorization|api[_-]?key|x-api-key|apikey|secret|token|private[_-]?key|password|signature)\b\s*[:=]\s*["']?[^\s"',;|]+/gi, "$1=[redacted]");
  s = s.replace(/\b[A-Za-z0-9+/_-]{48,}={0,2}\b/g, (m) => (/^(0x)?[0-9a-fA-F]{64}$/.test(m) || /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m) ? m : "[redacted]"));
  s = s.replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, "[redacted-key]");
  s = s.replace(/\/(Users|home)\/[^\s/]+/g, "/~");
  s = s.replace(/\b(\d{1,3}\.){3}\d{1,3}\b/g, "[ip]");
  return s.length > max ? s.slice(0, max) + "…" : s;
}
export function errorCategory(text) {
  const s = String(text || "");
  if (/AUTH_IP_BLOCKED|source ip blocked/i.test(s)) return "ip_blocked";
  if (/tip_fee|priority_fee|BAD_REQUEST|HTTP 4\d\d/i.test(s)) return "rejected_by_api";
  if (/timeout|ETIMEDOUT|ECONNRESET|socket hang up|ENOTFOUND|fetch failed/i.test(s)) return "network";
  if (/insufficient|balance/i.test(s)) return "balance";
  if (/stale|evidence|gate|refused|exceeds|max open|daily loss|kill/i.test(s)) return "risk_gate";
  return s ? "other" : null;
}
const PUBLIC_DECISION_FIELDS = ["at", "kind", "chain", "symbol", "token", "usd", "paperUsd", "orderStatus", "txHash", "positionId", "paperStrategyId", "paperStrategyLabel", "pnlUsd", "pnlEstimate", "bnbPriceUsd", "solPriceUsd"];
export function publicDecision(d) {
  const out = {};
  for (const k of PUBLIC_DECISION_FIELDS) if (d?.[k] !== undefined) out[k] = d[k];
  if (d?.reason) { out.reason = redactText(d.reason, 160); out.errorCategory = errorCategory(d.reason); }
  return out;
}
