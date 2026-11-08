// Paper-only "control quality" score. Concentration is no longer only a risk
// veto: a concentrated-but-not-extreme book with consistent net buying can be
// evidence of an organised (庄家控盘) move. Missing fields stay `unknown`; we
// never pretend control exists without data.
export const PAPER_CONTROL_SCORE_VERSION = 'paper_control_score_v1';
export const CONTROL_TOP10_BAND = Object.freeze({ low: .25, high: .6 }); // 控盘加分区间（高于 high 由安全策略拦截）
export const CONTROL_MAX_BUNDLER_RATE = .3;
export const CONTROL_MAX_DEV_RATE = .2;
export const CONTROL_MIN_NET_BUY_USD = 500;
export const CONTROL_MIN_BUYERS = 2;
export const CONTROL_OK_SCORE = 60;

const num = v => v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null;

export function paperControlScore(evidence = {}) {
  const m = evidence.safety?.metrics || {}, flow = evidence.flow || {};
  const top10 = num(m.top10HolderRate), bundler = num(m.bundlerRate), dev = num(m.devTeamHoldRate);
  const netBuy = num(flow.netBuyUsd), buyers = num(flow.uniqueBuyerCount), smart = num(flow.smartMoneyCount);
  const parts = [], unknown = [];
  let score = 0, inBand = false;
  if (top10 === null) unknown.push('Top10 集中度');
  else if (top10 >= CONTROL_TOP10_BAND.low && top10 <= CONTROL_TOP10_BAND.high) { score += 35; inBand = true; parts.push('Top10 集中度处于控盘区间'); }
  else if (top10 > CONTROL_TOP10_BAND.high) parts.push('集中度过高，按风险处理');
  else parts.push('筹码分散，不视为控盘');
  if (bundler === null) unknown.push('打包买入占比');
  else if (bundler <= CONTROL_MAX_BUNDLER_RATE) { score += 10; parts.push('打包占比可接受'); }
  if (dev === null) unknown.push('开发团队持仓');
  else if (dev <= CONTROL_MAX_DEV_RATE) { score += 10; parts.push('开发团队持仓可接受'); }
  if (netBuy === null || buyers === null) unknown.push('净买入一致性');
  else if (netBuy >= CONTROL_MIN_NET_BUY_USD && buyers >= CONTROL_MIN_BUYERS) { score += 30; parts.push('净买入与多地址一致'); }
  if (smart !== null && smart >= 1) { score += 15; parts.push('有聪明钱标签参与'); }
  const status = top10 === null ? 'unknown' : inBand && score >= CONTROL_OK_SCORE ? 'ok' : 'weak';
  return { version: PAPER_CONTROL_SCORE_VERSION, status, ok: status === 'ok', score, parts, unknown,
    meaning: '控盘质量分是规则估算，不代表庄家意图或收益；缺字段一律 unknown。' };
}
