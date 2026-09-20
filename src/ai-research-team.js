/**
 * Deterministic, read-only research team for the yesp atm paper dashboard.
 *
 * This module intentionally has no network, wallet, alert, signing, or
 * execution dependencies.  It turns one shared market snapshot into several
 * small department reports and a fail-closed committee decision.  “AI” in the
 * UI means the departments can be replaced or enriched by an LLM later; the
 * safety gates and the final decision remain deterministic.
 */

export const RESEARCH_TEAM_SCHEMA = 'yesp_atm_research_team_v1';
export const RESEARCH_TEAM_DEPARTMENTS = Object.freeze([
  Object.freeze({ id: 'chain', label: '链路研究部', shortLabel: '链路' }),
  Object.freeze({ id: 'narrative', label: '叙事研究部', shortLabel: '叙事' }),
  Object.freeze({ id: 'flow', label: '筹码资金部', shortLabel: '筹码' }),
  Object.freeze({ id: 'security', label: '合约安全部', shortLabel: '安全' }),
  Object.freeze({ id: 'market', label: '行情结构部', shortLabel: '行情' }),
  Object.freeze({ id: 'risk', label: '投委会风控部', shortLabel: '总控' }),
]);
export const RESEARCH_TEAM_DECISIONS = Object.freeze(['可模拟', '观察', '不买']);

const CHAIN_ALIASES = Object.freeze({
  solana: 'sol', sol: 'sol',
  bsc: 'bsc', '56': 'bsc',
  base: 'base', '8453': 'base',
  eth: 'eth', ethereum: 'eth', '1': 'eth',
  robinhood: 'robinhood', '4663': 'robinhood',
});
const CHAIN_LABELS = Object.freeze({ sol: 'Solana', bsc: 'BSC', base: 'Base', eth: 'Ethereum', robinhood: 'Robinhood Chain' });
const CHAIN_NATIVE = Object.freeze({ sol: 'SOL', bsc: 'BNB', base: 'ETH', eth: 'ETH', robinhood: 'ETH' });
const CHAIN_IDS = Object.freeze({ sol: '非 EVM', bsc: 56, base: 8453, eth: 1, robinhood: 4663 });
const DEFAULT_MAX_MARKET_AGE_MS = 2 * 60 * 1_000;
const MAX_NARRATIVE_AGE_MS = 24 * 60 * 60 * 1_000;
const MIN_LIQUIDITY_USD = 50_000;

const clean = value => String(value ?? '').replace(/\s+/gu, ' ').trim();
const finite = value => {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
};
const bool = value => value === true || value === 1 || value === '1' || String(value).toLowerCase() === 'true'
  ? true
  : value === false || value === 0 || value === '0' || String(value).toLowerCase() === 'false'
    ? false
    : null;
const numberOr = (value, fallback = null) => finite(value) ?? fallback;
const clamp = (value, low = 0, high = 100) => Math.min(high, Math.max(low, value));
const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
};
const percent = value => {
  const number = finite(value);
  if (number == null) return null;
  return number >= 0 && number <= 1 ? number * 100 : number;
};

function parseTime(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' && Number.isFinite(value)) return value < 10_000_000_000 ? value * 1_000 : value;
  const text = clean(value);
  if (/^\d{10,13}$/u.test(text)) {
    const number = Number(text);
    return text.length === 10 ? number * 1_000 : number;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function canonicalChain(value) {
  const key = clean(typeof value === 'object' ? value?.chain || value?.slug || value?.id : value).toLowerCase();
  return CHAIN_ALIASES[key] || null;
}

function ageMs(value, nowMs) {
  const timestamp = parseTime(value);
  return timestamp == null || !Number.isFinite(nowMs) ? null : Math.max(0, nowMs - timestamp);
}

function freshnessState({ marketStatus, observedAt, nowMs, maxAgeMs = DEFAULT_MAX_MARKET_AGE_MS } = {}) {
  const age = ageMs(observedAt, nowMs);
  const fresh = marketStatus === 'ok' && age != null && age <= maxAgeMs;
  const stale = marketStatus === 'stale' || (age != null && age > maxAgeMs);
  return {
    status: fresh ? 'fresh' : stale ? 'stale' : 'unknown',
    ageMs: age,
    fresh,
    stale,
  };
}

function evidence(text, value = null, level = 'info') {
  return { text: clean(text), value, level };
}

function narrativeReport({ narrative = {}, nowMs } = {}) {
  const sourceStatus = clean(narrative?.status).toLowerCase();
  const text = clean(narrative?.text || narrative?.headline || narrative?.summary);
  const sourceUrl = clean(narrative?.sourceUrl || narrative?.url);
  const sourceAt = parseTime(narrative?.sourceAt || narrative?.publishedAt || narrative?.createdAt);
  const age = sourceAt == null ? null : Math.max(0, nowMs - sourceAt);
  const sourceAllowed = sourceUrl.startsWith('https://') || sourceUrl.startsWith('http://');
  const subjectBound = narrative?.subjectMatch === true || narrative?.caBound === true || narrative?.tokenAddressMatch === true;
  const verified = ['sourced', 'verified'].includes(sourceStatus) && Boolean(text) && sourceAllowed && subjectBound
    && age != null && age <= MAX_NARRATIVE_AGE_MS;
  const projectClaim = sourceStatus === 'project_claim' && Boolean(text) && sourceAllowed;
  const status = verified ? '通过' : projectClaim ? '部分' : '观察';
  const score = verified ? 15 : projectClaim ? 7 : 0;
  const missing = [];
  if (!text) missing.push('可验证叙事文本');
  if (!sourceAllowed) missing.push('来源链接');
  if (!subjectBound) missing.push('精确 CA 绑定');
  if (sourceAt == null) missing.push('来源时间');
  if (sourceAt != null && age > MAX_NARRATIVE_AGE_MS) missing.push('新鲜叙事');
  return {
    id: 'narrative', label: '叙事研究部', status, score, maxScore: 15,
    conclusion: verified ? '叙事已绑定 CA，可作为催化剂' : projectClaim ? '项目自述，未独立证实' : '叙事未核实，不按名称猜故事',
    facts: [
      evidence(verified ? '来源已绑定当前 CA' : '来源不足或未绑定当前 CA', sourceUrl || null, verified ? 'good' : 'warn'),
      evidence(text ? text.slice(0, 140) : '无可核实叙事文本', null, text ? 'info' : 'warn'),
    ],
    source: sourceUrl || null,
    sourceAt: sourceAt == null ? null : new Date(sourceAt).toISOString(),
    freshness: age == null ? 'unknown' : age <= MAX_NARRATIVE_AGE_MS ? 'fresh' : 'stale',
    missing,
    thesis: {
      event: clean(narrative?.event || narrative?.catalyst) || '待确认事件',
      mechanism: clean(narrative?.mechanism) || '待确认传导机制',
      target: clean(narrative?.target) || '待确认受益对象',
      confirmation: clean(narrative?.confirmation) || '等待官方或链上二次确认',
      invalidation: clean(narrative?.invalidation) || '来源失效、主体不匹配或催化剂未兑现',
    },
  };
}

function chainReport({ chain, freshness, marketStatus } = {}) {
  const slug = canonicalChain(chain);
  const supported = Boolean(slug);
  const status = !supported ? '观察' : freshness.fresh ? '通过' : '观察';
  const score = !supported ? 0 : freshness.fresh ? 15 : 6;
  const missing = [];
  if (!supported) missing.push('GMGN 支持链');
  if (!freshness.fresh) missing.push('新鲜链上行情快照');
  return {
    id: 'chain', label: '链路研究部', status, score, maxScore: 15,
    conclusion: !supported ? '当前链不在 GMGN 只读覆盖范围' : freshness.fresh ? `${CHAIN_LABELS[slug]} · GMGN 数据新鲜` : `${CHAIN_LABELS[slug]} · 数据需要刷新`,
    facts: [
      evidence(supported ? `${CHAIN_LABELS[slug]} · 原生资产 ${CHAIN_NATIVE[slug]} · 链 ID ${CHAIN_IDS[slug]}` : '未知链', slug || chain || null, supported ? 'good' : 'warn'),
      ...(slug === 'robinhood' ? [evidence('重点覆盖：GMGN 行情 + Robinhood 链上/官方监控', 'market_and_chain_monitors', 'info')] : []),
      evidence(`行情状态：${marketStatus || 'unknown'} · 数据年龄：${freshness.ageMs == null ? '未知' : `${Math.round(freshness.ageMs / 1000)}秒`}`, freshness.ageMs, freshness.fresh ? 'good' : 'warn'),
    ],
    missing,
    chain: slug || clean(chain) || null,
  };
}

function flowReport({ token = {}, flow = {} } = {}) {
  const liquidity = finite(token.liquidity);
  const volume = finite(token.volume);
  const smart = finite(token.smartDegenCount ?? flow.smartMoneyCount ?? flow.smartDegenCount);
  const renowned = finite(token.renownedCount ?? flow.renownedCount ?? flow.kolCount);
  const holders = finite(token.holders);
  const top10 = percent(token.top10HolderRate);
  const buys = finite(token.buys ?? flow.buys);
  const sells = finite(token.sells ?? flow.sells);
  const botRate = percent(token.botDegenRate);
  const bundler = percent(token.bundlerRate);
  const lockPercent = percent(token.lockPercent);
  const devTeamHoldRate = percent(token.devTeamHoldRate);
  const top70SniperHoldRate = percent(token.top70SniperHoldRate);
  const ratTraderAmountRate = percent(token.ratTraderAmountRate);
  const bluechipOwnerPercentage = percent(token.bluechipOwnerPercentage);
  const entrapmentRatio = percent(token.entrapmentRatio);
  const sniperCount = finite(token.sniperCount);
  const ctoFlag = bool(token.ctoFlag);
  const flowStatus = clean(flow.status).toLowerCase();
  const coverageGap = clean(flow.coverageGap);
  const wash = bool(token.isWashTrading);
  const highProfit = finite(flow.highProfitCount);
  const fomo = finite(flow.fomoCount);
  const uniqueBuyers = finite(flow.uniqueBuyerCount);
  const netBuyUsd = finite(flow.netBuyUsd);
  const flowFresh = flow.fresh !== false;
  const missing = [];
  const facts = [];
  if (smart == null) missing.push('聪明钱数量');
  if (holders == null) missing.push('持有人数量');
  if (top10 == null) missing.push('Top10 集中度');
  if (liquidity == null) missing.push('流动性');
  if (highProfit == null || fomo == null || uniqueBuyers == null || netBuyUsd == null) missing.push('高盈利/FOMO 资金流');
  if (!flowFresh) missing.push('新鲜资金流快照');
  if (wash === true) {
    return {
      id: 'flow', label: '筹码资金部', status: '拦截', score: 0, maxScore: 20,
      conclusion: '检测到洗量标记，资金流不可信',
      facts: [evidence('GMGN 标记为洗量', true, 'bad')], missing, hardBlock: true,
    };
  }
  let score = 0;
  if (smart != null) score += clamp(smart * 2, 0, 8);
  if (renowned != null) score += clamp(renowned * 2, 0, 4);
  if (highProfit != null) score += clamp(highProfit, 0, 3);
  if (fomo != null) score += clamp(fomo, 0, 2);
  if (uniqueBuyers != null && uniqueBuyers >= 6) score += 1;
  if (netBuyUsd != null && netBuyUsd >= 10_000) score += 1;
  if (buys != null && sells != null && buys + sells > 0) score += buys >= sells ? 3 : 0;
  if (liquidity != null && liquidity >= MIN_LIQUIDITY_USD) score += 3;
  if (volume != null && liquidity != null && liquidity > 0 && volume / liquidity >= .5) score += 2;
  const concentrationRisk = top10 != null && top10 >= 60;
  const botRisk = (botRate != null && botRate >= 50) || (bundler != null && bundler >= 30);
  if (concentrationRisk) missing.push('较低 Top10 集中度');
  if (botRisk) missing.push('机器人/打包地址风险');
  const flowSignalPass = flowFresh && highProfit != null && fomo != null && uniqueBuyers != null && netBuyUsd != null
    && highProfit >= 5 && fomo >= 3 && uniqueBuyers >= 6 && netBuyUsd >= 10_000;
  const activitySummary = `高盈利 ${highProfit == null ? '未知' : highProfit} · FOMO ${fomo == null ? '未知' : fomo} · 独立买家 ${uniqueBuyers == null ? '未知' : uniqueBuyers}`;
  const flowStatusText = ({ healthy: '健康', partial: '部分覆盖', stale: '过期', unavailable: '不可用', rate_limited: '限流' })[flowStatus] || flowStatus || '未知';
  const coverageSummary = flowStatus && flowStatus !== 'healthy'
    ? `资金流${flowStatus === 'partial' ? '部分覆盖' : flowStatus}${coverageGap ? `（${coverageGap}）` : ''} · `
    : '';
  facts.push(evidence(`聪明钱 ${smart == null ? '未知' : smart} · 知名地址 ${renowned == null ? '未知' : renowned}`, { smart, renowned }, smart != null ? 'good' : 'warn'));
  facts.push(evidence(`高盈利 ${highProfit == null ? '未知' : highProfit} · FOMO ${fomo == null ? '未知' : fomo} · 独立买家 ${uniqueBuyers == null ? '未知' : uniqueBuyers}`, { highProfit, fomo, uniqueBuyers, netBuyUsd }, highProfit != null || fomo != null ? 'info' : 'warn'));
  facts.push(evidence(`持有人 ${holders == null ? '未知' : holders.toLocaleString()} · Top10 ${top10 == null ? '未知' : `${round(top10)}%`}`, { holders, top10 }, top10 == null || concentrationRisk ? 'warn' : 'good'));
  facts.push(evidence(`买/卖 ${buys == null || sells == null ? '未知' : `${buys}/${sells}`} · 流动性 ${liquidity == null ? '未知' : `$${Math.round(liquidity).toLocaleString()}`}`, { buys, sells, liquidity }, liquidity != null ? 'good' : 'warn'));
  if (flowStatus || coverageGap) facts.push(evidence(`资金流状态：${flowStatusText}${coverageGap ? ` · 缺口：${coverageGap}` : ''}`, { status: flowStatus || null, coverageGap: coverageGap || null }, flowStatus === 'healthy' && !coverageGap ? 'good' : 'warn'));
  const chipFacts = [];
  if (devTeamHoldRate != null) chipFacts.push(`开发团队 ${round(devTeamHoldRate)}%`);
  if (top70SniperHoldRate != null) chipFacts.push(`Top70 狙击 ${round(top70SniperHoldRate)}%`);
  if (ratTraderAmountRate != null) chipFacts.push(`鼠仓 ${round(ratTraderAmountRate)}%`);
  if (bluechipOwnerPercentage != null) chipFacts.push(`蓝筹地址 ${round(bluechipOwnerPercentage)}%`);
  if (lockPercent != null) chipFacts.push(`锁仓 ${round(lockPercent)}%`);
  if (sniperCount != null) chipFacts.push(`狙击地址 ${sniperCount}`);
  if (entrapmentRatio != null) chipFacts.push(`陷阱比 ${round(entrapmentRatio)}%`);
  if (ctoFlag === true) chipFacts.push('CTO 标记');
  if (chipFacts.length) facts.push(evidence(`GMGN 筹码字段：${chipFacts.join(' · ')}`, { lockPercent, devTeamHoldRate, top70SniperHoldRate, ratTraderAmountRate, bluechipOwnerPercentage, entrapmentRatio, sniperCount, ctoFlag }, 'info'));
  return {
    id: 'flow', label: '筹码资金部', status: score >= 14 && flowSignalPass && !concentrationRisk && !botRisk && missing.length === 0 ? '通过' : '部分', score: Math.min(20, round(score, 1)), maxScore: 20,
    conclusion: botRisk ? `${coverageSummary}机器人/打包占比偏高，资金流降级 · ${activitySummary}` : concentrationRisk ? `${coverageSummary}Top10 偏集中，仅作风险代理 · ${activitySummary}` : !flowFresh ? `${coverageSummary}资金流快照已过期，不升级结论 · ${activitySummary}` : !flowSignalPass ? `${coverageSummary}高盈利/FOMO 地址未达到共振线 · ${activitySummary}` : score >= 14 ? `${coverageSummary}聪明钱与流动性达到纸上筛选线 · ${activitySummary}` : `${coverageSummary}筹码证据不完整，继续观察 · ${activitySummary}`,
    facts, missing, proxy: top10 != null ? 'Top10 仅为筹码风险代理，不等同完整持仓分布' : '完整持仓分布未接入，暂无法计算筹码风险代理',
    metrics: { liquidity, volume, smart, renowned, holders, top10, buys, sells, botRate, bundler, lockPercent, devTeamHoldRate, top70SniperHoldRate, ratTraderAmountRate, bluechipOwnerPercentage, entrapmentRatio, sniperCount, ctoFlag, highProfit, fomo, uniqueBuyers, netBuyUsd, flowFresh, flowStatus, coverageGap: coverageGap || null },
  };
}

function securityReport({ token = {}, chain } = {}) {
  const honeypot = bool(token.isHoneypot);
  const wash = bool(token.isWashTrading);
  const rugRatio = finite(token.rugRatio);
  const buyTax = percent(token.buyTax);
  const sellTax = percent(token.sellTax);
  const creatorClose = bool(token.creatorClose);
  const openSource = bool(token.isOpenSource);
  const renounced = bool(token.isRenounced);
  const hardBlock = honeypot === true || wash === true || (rugRatio != null && rugRatio > .3) || (sellTax != null && sellTax > 10);
  const missing = [];
  if (honeypot == null) missing.push('可卖性/蜜罐验证');
  if (creatorClose == null) missing.push('创建者行为');
  if (buyTax == null || sellTax == null) missing.push('税费');
  if (chain === 'sol' && (token.renouncedMint == null || token.renouncedFreezeAccount == null)) missing.push('Solana mint/freeze 权限');
  if (chain !== 'sol' && openSource == null) missing.push('合约源码');
  if (hardBlock) {
    const reasons = [];
    if (honeypot === true) reasons.push('蜜罐');
    if (wash === true) reasons.push('洗量');
    if (rugRatio != null && rugRatio > .3) reasons.push(`Rug ${round(rugRatio * 100)}%`);
    if (sellTax != null && sellTax > 10) reasons.push(`卖出税 ${round(sellTax)}%`);
    return {
      id: 'security', label: '合约安全部', status: '拦截', score: 0, maxScore: 25,
      conclusion: `硬风险拦截：${reasons.join('、')}`, facts: [evidence(reasons.join('、'), null, 'bad')], missing, hardBlock: true,
    };
  }
  const verified = honeypot === false && wash === false && rugRatio != null && rugRatio <= .2 && sellTax != null && sellTax <= 10 && creatorClose === true;
  const score = verified ? 25 : 10;
  return {
    id: 'security', label: '合约安全部', status: verified ? '通过' : '观察', score, maxScore: 25,
    conclusion: verified ? '基础风险门通过，可进入纸上候选' : '安全证据不完整，未知不等于安全',
    facts: [
      evidence(`蜜罐：${honeypot == null ? '未知' : honeypot ? '是' : '否'} · Rug：${rugRatio == null ? '未知' : `${round(rugRatio * 100)}%`}`, { honeypot, rugRatio }, honeypot === false && rugRatio != null ? 'good' : 'warn'),
      evidence(`创建者关闭：${creatorClose == null ? '未知' : creatorClose ? '是' : '否'} · 卖出税：${sellTax == null ? '未知' : `${round(sellTax)}%`}`, { creatorClose, sellTax }, verified ? 'good' : 'warn'),
    ], missing,
    metrics: { honeypot, wash, rugRatio, buyTax, sellTax, creatorClose, openSource, renounced },
  };
}

function candlesReport({ token = {}, candles = [], freshness } = {}) {
  const price = finite(token.price);
  const change = finite(token.change);
  const liquidity = finite(token.liquidity);
  const volume = finite(token.volume);
  const cleanCandles = (Array.isArray(candles) ? candles : []).filter(item => finite(item?.close) != null);
  const first = finite(cleanCandles[0]?.close);
  const last = finite(cleanCandles.at(-1)?.close);
  const klineChange = first && last ? last / first - 1 : null;
  const missing = [];
  if (price == null || price <= 0) missing.push('价格');
  if (change == null) missing.push('涨跌幅');
  if (liquidity == null) missing.push('流动性');
  if (cleanCandles.length < 2) missing.push('有效 K 线');
  const positive = change != null && change >= 0 && (klineChange == null || klineChange >= -.05);
  const threshold = price != null && liquidity != null && liquidity >= MIN_LIQUIDITY_USD && positive && freshness.fresh;
  const score = threshold ? 15 : price != null && liquidity != null ? 7 : 0;
  return {
    id: 'market', label: '行情结构部', status: threshold ? '通过' : '观察', score, maxScore: 15,
    conclusion: !freshness.fresh ? '行情不是新鲜快照，不触发新增模拟' : threshold ? '价格、流动性与短线结构满足筛选线' : '行情结构未同时满足筛选线',
    facts: [
      evidence(`价格 ${price == null ? '未知' : price} · 当前涨跌 ${change == null ? '未知' : `${round(change)}%`}`, { price, change }, price != null ? 'good' : 'warn'),
      evidence(`流动性 ${liquidity == null ? '未知' : `$${Math.round(liquidity).toLocaleString()}`} · 成交额 ${volume == null ? '未知' : `$${Math.round(volume).toLocaleString()}`}`, { liquidity, volume }, liquidity != null ? 'good' : 'warn'),
      evidence(`K线 ${cleanCandles.length < 2 ? '不足' : `${cleanCandles.length} 根`} · 区间 ${klineChange == null ? '未知' : `${round(klineChange * 100)}%`}`, { candleCount: cleanCandles.length, klineChange }, cleanCandles.length >= 2 ? 'info' : 'warn'),
    ], missing, metrics: { price, change, liquidity, volume, klineChange },
  };
}

function riskReport({ departments, freshness } = {}) {
  const hardBlock = departments.some(department => department.hardBlock);
  const missing = [...new Set(departments.flatMap(department => department.missing || []))];
  const criticalMissing = ['可卖性/蜜罐验证', '精确 CA 绑定', '完整持仓分布', '新鲜链上行情快照'].filter(item => missing.includes(item));
  const status = hardBlock ? '拦截' : missing.length || criticalMissing.length || !freshness.fresh ? '观察' : '通过';
  const score = hardBlock ? 0 : status === '通过' ? 10 : 5;
  return {
    id: 'risk', label: '投委会风控部', status, score, maxScore: 10,
    conclusion: hardBlock ? '存在硬风险，禁止纸上买入' : status === '通过' ? '证据链完整，允许总控评估纸上候选' : '证据不完整，保持观察，不升级结论',
    facts: [
      evidence(`数据新鲜度：${freshness.status === 'fresh' ? '新鲜' : freshness.status === 'stale' ? '过期' : '未知'}`, freshness.ageMs, freshness.fresh ? 'good' : 'warn'),
      evidence(missing.length ? `缺失：${missing.slice(0, 4).join('、')}` : '关键字段齐全', missing, missing.length ? 'warn' : 'good'),
    ],
    missing, hardBlock,
  };
}

function committee({ departments, token, freshness } = {}) {
  const hardBlock = departments.some(department => department.hardBlock);
  const total = departments.reduce((sum, department) => sum + numberOr(department.score, 0), 0);
  const max = departments.reduce((sum, department) => sum + numberOr(department.maxScore, 0), 0) || 100;
  const opportunityScore = round(clamp(total / max * 100), 1);
  const criticalPass = ['chain', 'narrative', 'flow', 'security', 'market'].every(id => departments.find(department => department.id === id)?.status === '通过');
  const missing = [...new Set(departments.flatMap(department => department.missing || []))];
  const decision = hardBlock ? '不买' : freshness.fresh && criticalPass && opportunityScore >= 70 ? '可模拟' : '观察';
  const riskScore = hardBlock ? 100 : Math.min(100, Math.round((missing.length ? 55 : 15) + (freshness.fresh ? 0 : 25)));
  const confidenceScore = hardBlock ? 0 : Math.min(100, Math.round(opportunityScore * (freshness.fresh ? 1 : .6) * (missing.length ? .75 : 1)));
  const confidence = confidenceScore >= 80 ? '高' : confidenceScore >= 60 ? '中' : '低';
  const symbol = clean(token?.symbol) || '当前对象';
  const reasons = [];
  if (hardBlock) reasons.push('存在硬风险，直接拦截');
  if (!freshness.fresh) reasons.push('行情不是新鲜快照，不触发新增模拟');
  if (departments.find(department => department.id === 'narrative')?.status !== '通过') reasons.push('叙事未完成精确 CA 绑定');
  if (!criticalPass && !hardBlock) reasons.push('关键部门尚未全部通过');
  if (decision === '可模拟') reasons.push('六部门证据链通过，可进入纸上观察仓');
  if (!reasons.length) reasons.push(`${symbol} 暂无满足全部条件的纸上机会`);
  const narrative = departments.find(department => department.id === 'narrative');
  return {
    decision, score: opportunityScore, opportunityScore, riskScore, confidenceScore, confidence,
    reasons, missing, paperOnly: true, executable: false, signing: false, broadcast: false,
    tradeLogic: {
      entryWindow: decision === '可模拟' ? '只在新鲜快照且六部门通过时，以纸上小仓观察' : '不新增模拟仓，等待缺失证据补齐',
      sizeUsd: 10,
      exits: '硬止损 -20% · 盈利 +50% 后追踪回撤 30% · 2倍/5倍/10倍分段回收 · 最长 2 小时',
      invalidation: narrative?.thesis?.invalidation || '安全、流动性、叙事或数据新鲜度失效',
    },
  };
}

export function createResearchTeamReport(input = {}) {
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const token = input.token && typeof input.token === 'object' ? input.token : {};
  const chain = canonicalChain(input.chain || token.chain);
  const freshness = freshnessState({ marketStatus: input.marketStatus || input.status, observedAt: input.observedAt, nowMs, maxAgeMs: input.maxMarketAgeMs });
  const narrative = narrativeReport({ narrative: input.narrative, nowMs });
  const departments = [
    chainReport({ chain, freshness, marketStatus: input.marketStatus || input.status }),
    narrative,
    flowReport({ token, flow: input.flow }),
    securityReport({ token, chain }),
    candlesReport({ token, candles: input.candles, freshness }),
  ];
  const risk = riskReport({ departments, freshness });
  departments.push(risk);
  const decision = committee({ departments, token, freshness });
  return Object.freeze({
    schema: RESEARCH_TEAM_SCHEMA,
    generatedAt: new Date(nowMs).toISOString(),
    observedAt: parseTime(input.observedAt) == null ? null : new Date(parseTime(input.observedAt)).toISOString(),
    chain: chain || clean(input.chain || token.chain) || null,
    token: { symbol: clean(token.symbol) || 'UNKNOWN', address: clean(token.address) || null },
    freshness,
    departments: Object.fromEntries(departments.map(department => [department.id, department])),
    ...decision,
  });
}

export function renderResearchTeamBrief(report) {
  if (!report || typeof report !== 'object') return '投研团队：暂无报告';
  const decision = clean(report.decision) || '观察';
  const token = clean(report.token?.symbol) || '当前对象';
  const lead = report.reasons?.[0] || '等待研究证据';
  const narrative = report.departments?.narrative?.conclusion || '叙事未核实';
  const flow = report.departments?.flow?.conclusion || '筹码数据不足';
  const security = report.departments?.security?.conclusion || '安全数据不足';
  return [
    `结论：${decision} · ${token} · 机会分 ${report.opportunityScore ?? '—'} · 置信度 ${report.confidence || '低'}`,
    `主线：${narrative}`,
    `资金路径：${flow}`,
    `安全：${security}`,
    `买入逻辑：${report.tradeLogic?.entryWindow || '不新增模拟仓'}`,
    `失效条件：${report.tradeLogic?.invalidation || '证据或数据新鲜度失效'}`,
    `总控：${lead}`,
  ].join('\n');
}
