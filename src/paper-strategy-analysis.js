/** Rule-based, source-grounded research. Scores measure evidence, never win probability. */
import { gmgnFlowAddress } from './gmgn-flow-signal.js';

const MINUTE = 60_000;
export const STRATEGY_ANALYSIS_VERSION = 'narrative_structure_v2';
export const CHART_MISSING = '新鲜且足够的 K 线';
const num = value => value === null || value === undefined || typeof value === 'boolean' || String(value).trim() === '' ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const positive = value => num(value) > 0 ? num(value) : null;
const clean = value => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
const stamp = value => typeof value === 'number' ? (value < 1e10 ? value * 1000 : value) : /^\d{10,13}$/.test(String(value)) ? stamp(Number(value)) : Date.parse(value || '');
const iso = value => new Date(value).toISOString();
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
export const priceText = price => positive(price) ? `$${Number(price.toPrecision(7)).toString()}` : '待确认';
const sourceUrl = value => { try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.port ? url : null; } catch { return null; } };

const THEMES = [
  ['AI / 智能体', /\b(?:AI|agents?|LLM)\b|智能体|人工智能/i],
  ['链生态 / 产品上线', /mainnet|testnet|launch|release|roadmap|上线|主网|测试网|发布|产品/i],
  ['现实资产 / 支付', /\b(?:RWA|payments?|stablecoin)\b|现实资产|支付|稳定币/i],
  ['游戏 / 社区文化', /games?|gaming|meme|community|游戏|迷因|社区|文化/i],
];

export function assessPaperNarrative({ narrative = {}, chain, address, nowMs = Date.now() } = {}) {
  const ca = gmgnFlowAddress(chain, address);
  const rows = Array.isArray(narrative.sources) ? narrative.sources : [narrative];
  const byUrl = new Map();
  for (const row of rows) {
    if (!row || row.sourceAuthenticated !== true || !['authenticated_x', 'authenticated_call'].includes(row.sourceKind)
      || !ca || row.chain !== chain || gmgnFlowAddress(chain, row.tokenAddress || row.address) !== ca) continue;
    const url = sourceUrl(row.sourceUrl), at = stamp(row.sourceAt);
    if (!url || !Number.isFinite(at) || at > nowMs) continue;
    const body = clean(row.sourceText || row.text).slice(0, 4000);
    if (!body) continue;
    url.search = ''; url.hash = '';
    const item = { text: body, sourceUrl: url.toString(), sourceId: clean(row.sourceId) || null, sourceAt: iso(at), authorKey: clean(row.authorKey) || null, authorLabel: clean(row.authorLabel) || null, sourceKind: row.sourceKind, contentConflict: row.contentConflict === true };
    // Fomo may provide only a profile URL; its authenticated immutable call ID distinguishes posts.
    const key = row.sourceKind === 'authenticated_call' && item.sourceId ? item.sourceId : item.sourceUrl;
    const prior = byUrl.get(key);
    const conflict = item.contentConflict || prior?.contentConflict || prior && prior.text !== item.text;
    if (!prior || at < stamp(prior.sourceAt)) byUrl.set(key, { ...item, contentConflict: !!conflict });
    else if (conflict) byUrl.set(key, { ...prior, contentConflict: true });
  }
  const sources = [...byUrl.values()].filter(row => nowMs - stamp(row.sourceAt) <= 24 * 60 * MINUTE).sort((a, b) => stamp(b.sourceAt) - stamp(a.sourceAt)).slice(0, 12);
  // Copied wording from different accounts is not independent confirmation.
  const authors = new Set(), bodies = new Set(), independent = [];
  for (const row of sources) {
    const body = row.text.replace(/https?:\/\/\S+|0x[\da-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/giu, '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    if (!row.authorKey || authors.has(row.authorKey) || bodies.has(body)) continue;
    authors.add(row.authorKey); bodies.add(body); independent.push(row);
  }
  const latest = sources[0];
  const ageMs = latest ? nowMs - stamp(latest.sourceAt) : null;
  const phase = ageMs === null ? '待核实' : ageMs <= 30 * MINUTE ? '新鲜催化' : ageMs <= 6 * 60 * MINUTE ? '传播阶段' : '旧叙事';
  const text = latest?.text || '';
  const themes = THEMES.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  const stripped = text.replace(/https?:\/\/\S+|0x[\da-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/giu, '').trim();
  const eventful = /launch(?:ed|ing)|releas(?:e|ed)|announc|partnership|integrat|list(?:ed|ing)|upgrade|testnet|mainnet|adoption|roadmap|发布|上线|推出|合作|集成|上市|升级|测试|主网|路线图|增长|事件|新梗/i.test(stripped);
  const substantive = stripped.length >= 24 && themes.length > 0 && eventful;
  const caution = sources.some(row => nowMs - stamp(row.sourceAt) <= 6 * 60 * MINUTE && /\b(?:fake|scam|unaffiliated|denied|cancelled|not official)\b|假币|仿盘|骗局|非官方|否认|取消发布/i.test(row.text));
  const conflict = sources.some(row => row.contentConflict);
  const eligible = narrative.caBound === true && !!latest && ageMs <= 6 * 60 * MINUTE && substantive && !caution && !conflict && independent.length > 0;
  const gaps = [];
  if (!latest) gaps.push('缺少经过身份校验、绑定精确 CA 的原始内容');
  if (latest && !substantive) gaps.push('原文只有口号或无法识别具体事件，不能建立交易主线');
  if (ageMs > 6 * 60 * MINUTE) gaps.push('叙事超过六小时，等待新的可核实催化');
  if (caution) gaps.push('原文含否认或争议信号，需复核，不能当作利好');
  if (conflict) gaps.push('同一出处的原文存在冲突，等待复核');
  if (latest && !independent.length) gaps.push('来源作者身份不足');
  if (narrative.caBound !== true) gaps.push('精确链与合约绑定未通过');
  const quality = !latest ? narrative.status === 'project_claim' ? '项目自述，未独立核实' : '无可用出处' : independent.length >= 2 ? '多账号来源，仍非事实核验' : '单一已校验账号，未交叉证实';
  return { version: STRATEGY_ANALYSIS_VERSION, eligible, quality, phase, ageMs,
    theme: themes.join(' / ') || '未确认主线', event: latest ? text : clean(narrative.text) || '暂无可核实事件',
    mechanism: latest ? '研究假设：事件可能带来关注；是否转化为买盘，必须由新鲜净流入与价格结构另行确认。' : '没有原始出处，不根据币名推断资金逻辑。',
    independentSourceCount: independent.length, sourceCount: sources.length, sources, gaps,
    evidenceScore: Math.min(100, (latest ? 30 : 0) + (ageMs !== null && ageMs <= 6 * 60 * MINUTE ? 20 : 0) + (substantive ? 20 : 0) + (independent.length >= 2 ? 20 : 0)),
    scoreMeaning: '来源完整度，非胜率；身份校验不代表官方发行或内容为真',
    invalidation: '来源被否认、CA 对应关系不成立或催化过期时停止叙事开仓；未知数据不冒充证伪。' };
}

/** GMGN time is candle OPEN time. Only contiguous, completed 1m OHLCV can confirm an entry. */
export function analyzePaperChart({ candles = [], klineStatus, nowMs = Date.now() } = {}) {
  const unknown = reason => ({ ready: false, change: null, rising: false, reason, rows: [] });
  if (klineStatus !== 'ok' || !Array.isArray(candles)) return unknown('等待真实一分钟 OHLCV');
  const mapped = candles.map(row => ({ time: stamp(row?.time ?? row?.timestamp), open: positive(row?.open), high: positive(row?.high), low: positive(row?.low), close: positive(row?.close), volume: num(row?.volume) }));
  if (mapped.some(row => !Number.isFinite(row.time) || row.time > nowMs)) return unknown('K 线存在无效或未来时间');
  const rows = mapped.filter(row => row.time + MINUTE <= nowMs && row.time >= nowMs - 20 * MINUTE).sort((a, b) => a.time - b.time).slice(-12);
  if (rows.length < 8 || nowMs - (rows.at(-1).time + MINUTE) > 90_000) return unknown('至少需要八根连续且新鲜的已收盘一分钟 K 线');
  if (rows.some((row, i) => !row.open || !row.high || !row.low || !row.close || row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close) || row.low > row.high
    || row.volume === null || row.volume < 0 || i > 0 && row.time - rows[i - 1].time !== MINUTE)) return unknown('OHLCV 缺失、时间重复、断档或高低价冲突');
  const trueRanges = rows.slice(1).map((row, i) => Math.max(row.high - row.low, Math.abs(row.high - rows[i].close), Math.abs(row.low - rows[i].close)));
  const atr = mean(trueRanges.slice(-5));
  const base = rows.slice(0, -2), previous = rows.at(-2), last = rows.at(-1);
  const support = Math.min(...base.map(row => row.low)), resistance = Math.max(...base.map(row => row.high));
  const baseVolume = mean(base.map(row => row.volume));
  const change = (last.close / rows.at(-5).close - 1) * 100;
  return { ready: true, rows, atr, support, resistance, baseVolume, previous, last,
    change, rising: last.close > previous.close, observedAt: iso(last.time + MINUTE),
    relativeVolume: baseVolume > 0 ? last.volume / baseVolume : null,
    volumeMeaning: '同一源 volume 字段的相对量，不标为美元；与行情成交额分开',
    upperWickRatio: last.high > last.low ? (last.high - Math.max(last.open, last.close)) / (last.high - last.low) : 0 };
}

export function buildPaperEntryPlan({ chart, price, policy, costs } = {}) {
  const plan = { version: STRATEGY_ANALYSIS_VERSION, eligible: false, setup: '等待形态', reasons: [],
    entryZone: null, stopPrice: null, targetPrice: null, netRewardRisk: null, targetKind: null };
  if (!chart?.ready || !positive(price)) return { ...plan, summary: chart?.reason || '等待行情与已收盘 K 线' };
  const { rows, previous, last, support, resistance, atr, baseVolume } = chart;
  const breakout = previous.close > resistance * 1.002 && previous.volume >= baseVolume * 1.5 && last.low >= resistance * .98 && last.low <= resistance * 1.03
    && last.close >= previous.close * .99 && last.close >= resistance && last.close >= last.open && last.volume >= baseVolume * .8;
  const pullback = rows.at(-3).close > rows[0].close * 1.02 && previous.close < rows.at(-3).close && previous.volume < baseVolume * .9
    && previous.low >= support && last.close > previous.high && last.close > last.open && last.volume >= baseVolume * 1.2 && price < resistance;
  const setup = breakout ? '放量突破后回踩确认' : pullback ? '缩量回踩后重新走强' : '等待突破回踩或缩量回踩确认';
  const level = breakout ? resistance : previous.high;
  const stopPrice = (breakout ? Math.min(last.low, resistance) : Math.min(previous.low, last.low)) - atr * .25;
  // An observed resistance caps the pullback target; a breakout's measured move is explicitly a scenario.
  const measuredTarget = breakout ? resistance + (resistance - support) : resistance;
  const targetPrice = Math.min(measuredTarget, price * 2);
  const proposedZone = { low: Math.max(level * .995, last.close * .98), high: Math.min(level * 1.08, last.close * 1.02) };
  // Disjoint constraints mean NO confirmation zone, not a reversed interval.
  const entryZone = proposedZone.low <= proposedZone.high ? proposedZone : null;
  const reasons = [];
  if (!breakout && !pullback) reasons.push('尚未形成已收盘的突破回踩或缩量回踩买点');
  if (baseVolume <= 0 || !Number.isFinite(atr) || atr <= 0) reasons.push('量能或波动基准不足');
  if (!entryZone) reasons.push('买点约束区间无交集，尚无有效确认区');
  else if (price < entryZone.low || price > entryZone.high) reasons.push('现价已偏离确认区间，不追价');
  if (chart.upperWickRatio > .45) reasons.push('确认 K 线上影过长，等待抛压消化');
  const stopDistance = (price - stopPrice) / price;
  if (stopPrice <= 0 || stopDistance > policy.stopLoss || stopDistance < Math.max(.005, atr * .5 / price)) reasons.push('结构止损过宽或落在短线噪声内');
  const quantity = positive(costs?.notionalUsd) ? costs.notionalUsd / price : null;
  const sellRate = num(costs?.feeRate) + num(costs?.slippageRate) + num(costs?.sellTax);
  const netAt = value => quantity * value * (1 - sellRate) - costs.gasUsd;
  const lossUsd = quantity ? policy.entryUsd - netAt(stopPrice) : null;
  const gainUsd = quantity ? netAt(targetPrice) - policy.entryUsd : null;
  const netRewardRisk = lossUsd > 0 && gainUsd > 0 ? gainUsd / lossUsd : null;
  if (netRewardRisk === null || !Number.isFinite(netRewardRisk) || netRewardRisk < 1.5) reasons.push('计入模拟双边成本后，目标空间不足 1.5 倍止损损失');
  const targetKind = `${breakout ? '区间等幅推演，非预测' : '已观察前高，非保证触达'}${measuredTarget > price * 2 ? '；首档封顶 2 倍入场价' : ''}`;
  return { ...plan, eligible: reasons.length === 0, setup, reasons, support, resistance, atr, entryZone, stopPrice, targetPrice, targetKind,
    netRewardRisk: Number.isFinite(netRewardRisk) ? netRewardRisk : null, estimatedStopLossUsd: lossUsd,
    confirmedAt: chart.observedAt, relativeVolume: chart.relativeVolume,
    summary: `${setup}；${entryZone ? `确认区 ${priceText(entryZone.low)}–${priceText(entryZone.high)}` : '暂无有效确认区（约束无交集）'}；结构止损 ${priceText(stopPrice)}；参考目标 ${priceText(targetPrice)}（${targetKind}）。` };
}
