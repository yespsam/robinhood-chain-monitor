// Read-only ABI from the verified Flap Agent Bonding Curve Portal.
// No wallet credentials, signing, approval, or transaction submission belongs here.
export const QUOTE_BUY_SELECTOR = '0x34259b1b';
const UINT256_MAX = (1n << 256n) - 1n;

export class AllocationQuoteError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AllocationQuoteError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new AllocationQuoteError(code, message, details);
}

function uint(value, name) {
  if (typeof value !== 'bigint' && !(typeof value === 'string' && /^(0|[1-9]\d*)$/.test(value))) {
    fail('INVALID_INPUT', `${name} must be an unsigned BigInt or decimal string.`);
  }
  const result = BigInt(value);
  if (result < 0n || result > UINT256_MAX) fail('INVALID_INPUT', `${name} is outside uint256.`);
  return result;
}

function fixedBlock(value) {
  if (typeof value !== 'string' || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value)) {
    fail('INVALID_INPUT', 'A fixed hexadecimal block number is required.');
  }
  return value.toLowerCase();
}

function address(value, name) {
  if (typeof value !== 'string' || !/^0x[0-9a-f]{40}$/i.test(value) || /^0x0{40}$/i.test(value)) {
    fail('INVALID_INPUT', `${name} must be a nonzero address.`);
  }
  return value.toLowerCase();
}

function normalizeQuote(value, grossRaw, blockTag) {
  if (!value || typeof value !== 'object') fail('INVALID_QUOTE', 'The quote is missing.');
  const acceptedGrossRaw = uint(value.acceptedGrossRaw, 'acceptedGrossRaw');
  const feeRaw = uint(value.feeRaw, 'feeRaw');
  const refundRaw = uint(value.refundRaw, 'refundRaw');
  const sharesRaw = uint(value.sharesRaw, 'sharesRaw');
  if (acceptedGrossRaw + refundRaw !== grossRaw || feeRaw > acceptedGrossRaw) {
    fail('INVALID_QUOTE', 'The quote does not conserve submitted funds.');
  }
  if (value.blockTag !== undefined && fixedBlock(value.blockTag) !== blockTag) {
    fail('BLOCK_MISMATCH', 'The quote belongs to a different block.');
  }
  return { grossRaw, acceptedGrossRaw, feeRaw, refundRaw, sharesRaw, blockTag };
}

/** An eth_call-only adapter. rpc(method, params, { signal }) must reject RPC errors. */
export function createPortalQuoteReader({ rpc, portal, market, wallet }) {
  if (typeof rpc !== 'function') fail('INVALID_INPUT', 'rpc must be a function.');
  const to = address(portal, 'portal');
  const marketWord = address(market, 'market').slice(2).padStart(64, '0');
  const walletAddress = address(wallet, 'wallet');
  const walletWord = walletAddress.slice(2).padStart(64, '0');
  return async function quoteBuy(gross, { blockTag, signal } = {}) {
    const grossRaw = uint(gross, 'grossRaw');
    const block = fixedBlock(blockTag);
    const data = `${QUOTE_BUY_SELECTOR}${marketWord}${walletWord}${grossRaw.toString(16).padStart(64, '0')}`;
    const result = await rpc('eth_call', [{ from: walletAddress, to, data }, block], { signal });
    if (typeof result !== 'string' || !/^0x[0-9a-f]{256}$/i.test(result)) {
      fail('INVALID_QUOTE', 'quoteBuy must return exactly four ABI uint256 words.');
    }
    const words = Array.from({ length: 4 }, (_, i) => BigInt(`0x${result.slice(2 + i * 64, 66 + i * 64)}`));
    return normalizeQuote({ acceptedGrossRaw: words[0], feeRaw: words[1], refundRaw: words[2], sharesRaw: words[3], blockTag: block }, grossRaw, block);
  };
}

// Signed division rounded down, unlike BigInt's truncation toward zero.
function floorDiv(a, b) {
  if (b < 0n) { a = -a; b = -b; }
  const q = a / b;
  return a < 0n && a % b !== 0n ? q - 1n : q;
}

function distance(a, b) { return a > b ? a - b : b - a; }

function rationalCandidate(points, target) {
  // Inverse fractional-linear interpolation is exact for an unrounded constant
  // product curve. It is only a guess: every candidate still requires eth_call.
  const distinct = [];
  for (const p of [...points].sort((a, b) => distance(a.sharesRaw, target) < distance(b.sharesRaw, target) ? -1 : 1)) {
    if (!distinct.some(q => q.sharesRaw === p.sharesRaw)) distinct.push(p);
    if (distinct.length === 3) break;
  }
  if (distinct.length < 3) return null;
  const [a, b, c] = distinct;
  const r = (target - a.sharesRaw) * (b.sharesRaw - c.sharesRaw) * (b.grossRaw - a.grossRaw);
  const d = (target - c.sharesRaw) * (b.sharesRaw - a.sharesRaw) * (b.grossRaw - c.grossRaw);
  if (d === r) return null;
  return floorDiv(a.grossRaw * d - c.grossRaw * r, d - r);
}

/**
 * Find an actually quoted amount at or below a fixed share allocation.
 * snapshotAtMs is the timestamp of the pinned block, not the time a cache was read.
 * maxGrossRaw is a read-only search ceiling; it is NOT spending authorization.
 * A successful result can be unaffordable and must then never be submitted.
 * All raw amounts and returned quote fields are BigInts.
 */
export async function solveAllocation({
  quoteBuy, blockTag, snapshotAtMs, targetSharesRaw, initialGrossRaw, maxGrossRaw,
  availableBalanceRaw, maxCalls = 8, maxAgeMs = 10_000,
  maxShortfallRaw = 1_000_000_000n, maxFutureSkewMs = 2000, now = Date.now, signal,
}) {
  if (typeof quoteBuy !== 'function' || typeof now !== 'function') fail('INVALID_INPUT', 'quoteBuy and now must be functions.');
  const block = fixedBlock(blockTag);
  const target = uint(targetSharesRaw, 'targetSharesRaw');
  const initial = uint(initialGrossRaw, 'initialGrossRaw');
  const ceiling = uint(maxGrossRaw, 'maxGrossRaw');
  const balance = uint(availableBalanceRaw, 'availableBalanceRaw');
  const tolerance = uint(maxShortfallRaw, 'maxShortfallRaw');
  if (target === 0n || initial === 0n || ceiling === 0n || tolerance >= target) fail('INVALID_INPUT', 'Target, hint, ceiling, and tolerance are invalid.');
  if (!Number.isInteger(maxCalls) || maxCalls < 1 || maxCalls > 8) fail('INVALID_INPUT', 'maxCalls must be between 1 and 8.');
  if (!Number.isSafeInteger(snapshotAtMs) || !Number.isSafeInteger(maxAgeMs) || maxAgeMs <= 0 || maxAgeMs > 120_000) {
    fail('INVALID_INPUT', 'Valid block timestamp and freshness limit are required.');
  }
  if (!Number.isSafeInteger(maxFutureSkewMs) || maxFutureSkewMs < 0 || maxFutureSkewMs > 5000) {
    fail('INVALID_INPUT', 'Clock skew tolerance must be between 0 and 5000 ms.');
  }
  const fresh = () => {
    if (signal?.aborted) fail('ABORTED', 'Quote search was cancelled.');
    const time = now();
    if (!Number.isSafeInteger(time) || time + maxFutureSkewMs < snapshotAtMs || time - snapshotAtMs > maxAgeMs) {
      fail('STALE_QUOTE', 'The pinned block is too old; no amount may be submitted.');
    }
    return time;
  };
  fresh();
  const points = [{ grossRaw: 0n, sharesRaw: 0n }];
  let lower = points[0], upper = null, calls = 0;
  let candidate = initial < ceiling ? initial : ceiling;

  while (calls < maxCalls) {
    fresh();
    calls++;
    const quote = normalizeQuote(await quoteBuy(candidate, { blockTag: block, signal }), candidate, block);
    fresh();
    for (const p of points) {
      if ((p.grossRaw < candidate && p.sharesRaw > quote.sharesRaw) ||
          (p.grossRaw > candidate && p.sharesRaw < quote.sharesRaw)) {
        fail('NON_MONOTONIC', 'Fixed-block quotes are not monotonic.', { calls });
      }
    }
    points.push(quote);
    if (quote.sharesRaw <= target && quote.grossRaw > lower.grossRaw) lower = quote;
    if (quote.sharesRaw > target && (!upper || quote.grossRaw < upper.grossRaw)) upper = quote;
    if (lower.sharesRaw > 0n && target - lower.sharesRaw <= tolerance) {
      const requiredFundingRaw = lower.grossRaw > balance ? lower.grossRaw - balance : 0n;
      return {
        ...lower, targetSharesRaw: target, shortfallSharesRaw: target - lower.sharesRaw,
        calls, snapshotAtMs, quotedAtMs: fresh(), affordable: requiredFundingRaw === 0n,
        availableBalanceRaw: balance, requiredFundingRaw,
      };
    }
    if (upper && upper.grossRaw - lower.grossRaw <= 1n) break;
    if (!upper && lower.grossRaw === ceiling) {
      fail('SEARCH_CEILING', 'The search ceiling cannot fill the allocation.', {
        calls, ceilingRaw: ceiling, quotedSharesRaw: lower.sharesRaw,
        targetSharesRaw: target, affordable: false, requiredFundingRaw: null,
      });
    }

    let next = rationalCandidate(points, target);
    const valid = value => value !== null && value > lower.grossRaw && value <= ceiling &&
      (!upper || value < upper.grossRaw) && !points.some(p => p.grossRaw === value);
    if (!valid(next)) {
      if (upper) {
        const width = upper.grossRaw - lower.grossRaw;
        const rise = upper.sharesRaw - lower.sharesRaw;
        next = lower.grossRaw + (target - lower.sharesRaw) * width / rise;
        if (!valid(next)) next = lower.grossRaw + width / 2n;
      } else {
        // Establish a real upper quote quickly. This estimate is never a result.
        next = lower.sharesRaw > 0n ? lower.grossRaw * target * 102n / (lower.sharesRaw * 100n) + 1n : lower.grossRaw * 2n;
        if (next <= lower.grossRaw) next = lower.grossRaw + 1n;
        if (next > ceiling) next = ceiling;
      }
    }
    if (!valid(next)) break;
    candidate = next;
  }
  fail('NOT_CONVERGED', 'Eight bounded quotes did not establish the requested allocation; do not submit.', {
    calls, targetSharesRaw: target, bestQuotedGrossRaw: lower.grossRaw,
    bestQuotedSharesRaw: lower.sharesRaw, shortfallSharesRaw: target - lower.sharesRaw,
  });
}
