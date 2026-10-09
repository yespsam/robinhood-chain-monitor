const FALLBACK_MS=30_000;

// Absolute coordinator deadline, never a timer duration. Respect an upstream
// Retry-After even when it exceeds our own backoff policy; only absent,
// malformed or unrepresentable values use the local 30-second fallback.
export function rpcRetryAfterUntil(retryAfter,nowMs) {
  if(!Number.isSafeInteger(nowMs)||nowMs<0||nowMs>Number.MAX_SAFE_INTEGER-FALLBACK_MS)
    throw new TypeError('RPC Retry-After requires a safe current timestamp');
  const raw=typeof retryAfter==='string'?retryAfter.trim():typeof retryAfter==='number'?String(retryAfter):'';
  let deadline=NaN;
  if(/^\d+(?:\.\d+)?$/.test(raw))deadline=nowMs+Number(raw)*1000;
  // HTTP-date includes the standard weekday/comma form and both obsolete
  // forms. Do not interpret malformed numeric strings such as "-1" as dates.
  else if(/^[a-z]+,\s/i.test(raw))deadline=Date.parse(raw);
  // asctime has no timezone suffix but HTTP still defines it as GMT, not
  // the host machine's timezone (plain Date.parse would use local time).
  else if(/^[a-z]{3}\s+[a-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/i.test(raw))deadline=Date.parse(`${raw} GMT`);
  const rounded=Math.ceil(deadline);
  return Number.isSafeInteger(rounded)?Math.max(nowMs,rounded):nowMs+FALLBACK_MS;
}
