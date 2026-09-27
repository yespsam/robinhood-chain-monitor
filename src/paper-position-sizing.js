// Paper budgets only. Cash excludes open-position marks and unrealized gains.
export const PAPER_SIZING_VERSION = 'cash_fraction_v1';
export const PAPER_FIXED_SIZING_VERSION = 'fixed_ten_v1';
export const PAPER_RECOVERY_SIZING_VERSION = 'cash_tenth_cap_ten_v1';
export const PAPER_FIXED_ENTRY_USD = 10;
export const PAPER_LIQUIDITY_CAP_RATE = .001;
const validMoney = n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER / 100;

export function paperPositionSize({ cash, liquidity, baseEntryUsd, maxBudgetUsd = null, fixedEntryUsd = null, recoverySizing = false } = {}) {
  if (!validMoney(cash) || !validMoney(liquidity) || liquidity <= 0 || ![2, 4, 5, 8].includes(baseEntryUsd)
    || maxBudgetUsd !== null && !validMoney(maxBudgetUsd)
    || fixedEntryUsd !== null && fixedEntryUsd !== PAPER_FIXED_ENTRY_USD || typeof recoverySizing!=='boolean') return null;
  if(recoverySizing) {
    const liquidityCapUsd=liquidity*PAPER_LIQUIDITY_CAP_RATE,requestedBudgetUsd=Math.min(10,cash*.1);
    const budgetUsd=Math.floor((Math.min(requestedBudgetUsd,liquidityCapUsd,maxBudgetUsd??cash)+1e-9)*100)/100;
    return {version:PAPER_RECOVERY_SIZING_VERSION,mode:'cash_fraction_cap',fixedEntryUsd:null,
      cashBeforeEntry:cash,entryFraction:.1,maxEntryUsd:10,liquidityUsd:liquidity,
      liquidityCapRate:PAPER_LIQUIDITY_CAP_RATE,liquidityCapUsd,requestedBudgetUsd,signalBudgetCapUsd:maxBudgetUsd,budgetUsd};
  }
  if (fixedEntryUsd !== null) {
    const liquidityCapUsd = liquidity * PAPER_LIQUIDITY_CAP_RATE;
    // Exact ticket or no entry: never shrink back into fee-heavy small orders,
    // borrow, top up cash, or increase an older signal's evaluated budget.
    const budgetUsd = Math.min(cash, liquidityCapUsd, maxBudgetUsd ?? cash) >= fixedEntryUsd ? fixedEntryUsd : 0;
    return { version: PAPER_FIXED_SIZING_VERSION, mode: 'fixed', fixedEntryUsd,
      cashBeforeEntry: cash, entryFraction: null, liquidityUsd: liquidity,
      liquidityCapRate: PAPER_LIQUIDITY_CAP_RATE, liquidityCapUsd,
      requestedBudgetUsd: fixedEntryUsd, signalBudgetCapUsd: maxBudgetUsd, budgetUsd };
  }
  const entryFraction = baseEntryUsd / 100;
  const requestedBudgetUsd = cash * entryFraction, liquidityCapUsd = liquidity * PAPER_LIQUIDITY_CAP_RATE;
  const budgetUsd = Math.floor((Math.min(cash, requestedBudgetUsd, liquidityCapUsd, maxBudgetUsd ?? cash) + 1e-9) * 100) / 100;
  return { version: PAPER_SIZING_VERSION, mode: 'cash_fraction', cashBeforeEntry: cash, entryFraction,
    liquidityUsd: liquidity, liquidityCapRate: PAPER_LIQUIDITY_CAP_RATE, liquidityCapUsd,
    requestedBudgetUsd, signalBudgetCapUsd: maxBudgetUsd, budgetUsd };
}

export function validPaperPositionSize(size, baseEntryUsd, budgetUsd, liquidity) {
  if (!size || size.liquidityUsd !== liquidity || size.budgetUsd !== budgetUsd || budgetUsd <= 0) return false;
  if (size.version !== PAPER_FIXED_SIZING_VERSION && size.fixedEntryUsd != null) return false;
  const expected = paperPositionSize({ cash: size.cashBeforeEntry, liquidity, baseEntryUsd, maxBudgetUsd: size.signalBudgetCapUsd,
    fixedEntryUsd: size.version === PAPER_FIXED_SIZING_VERSION ? size.fixedEntryUsd : null,
    recoverySizing:size.version===PAPER_RECOVERY_SIZING_VERSION });
  return !!expected && Object.entries(expected).every(([key, value]) => size[key] === value);
}

export function paperSizingText(size) {
  if(size?.version===PAPER_RECOVERY_SIZING_VERSION)return `恢复期试仓：可用现金的 10%、最高 10U，本笔 ${size.budgetUsd.toFixed(2)}U（含买入模型成本），不使用浮盈或自动补款。`;
  if (size?.version === PAPER_FIXED_SIZING_VERSION) return `固定单笔 ${size.fixedEntryUsd.toFixed(2)} U：本笔总预算 $${size.budgetUsd.toFixed(2)}（含买入模型成本）；余额或流动性额度不足则不下单，不自动缩小或补款。`;
  return size ? `滚仓：可用余额 $${size.cashBeforeEntry.toFixed(2)} × ${(size.entryFraction * 100).toFixed(0)}%，本笔总预算 $${size.budgetUsd.toFixed(2)}（含模型成本；不超过已观察流动性的 0.1%）。` : '';
}
