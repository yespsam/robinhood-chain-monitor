// Input is already identity-bound, deduplicated and coverage-checked by its provider.
export function paperFlowPulse(rows, nowMs) {
  const recent = rows.filter(r => Number.isFinite(r.at) && r.at <= nowMs && r.at >= nowMs - 90_000);
  const wallets = new Map();
  for (const r of recent) {
    if (!['buy', 'sell'].includes(r.side) || !Number.isFinite(r.amountUsd) || r.amountUsd <= 0) continue;
    wallets.set(r.wallet, (wallets.get(r.wallet) || 0) + (r.side === 'buy' ? r.amountUsd : -r.amountUsd));
  }
  const meaningfulBuys = recent.filter(r => r.side === 'buy' && r.amountUsd >= 100 && wallets.get(r.wallet) >= 100);
  const lastBuyAt = meaningfulBuys.length ? Math.max(...meaningfulBuys.map(r => r.at)) : null;
  return { windowMs: 90_000, recentBuyerCount: [...wallets.values()].filter(v => v >= 100).length,
    recentNetBuyUsd: [...wallets.values()].reduce((a, b) => a + b, 0), lastBuyAt };
}
