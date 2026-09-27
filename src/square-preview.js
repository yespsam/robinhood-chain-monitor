import { createHash } from 'node:crypto';
import { STRATEGY_POLICIES, validatePaperStrategyAccount } from './paper-strategy-engine.js';

const CHAINS = Object.freeze({ robinhood: 'Robinhood Chain', bsc: 'BNB Chain', base: 'Base', eth: 'Ethereum', sol: 'Solana' });
const clean = (value, limit = 450) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit) : '';
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const money = value => numeric(value) ? `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '未记录';
const count = value => Number.isInteger(value) && value >= 0 ? String(value) : '未记录';
const date = value => new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
const hash = text => createHash('sha256').update(text).digest('hex');
const unavailable = reason => ({ status: 'unavailable', mode: 'preview_only', publishingEnabled: false, reason, drafts: [] });

function validSource(value) {
  if (typeof value !== 'string' || value.length > 700 || /[\s\x00-\x1f\x7f]/.test(value)) return null;
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? value : null; }
  catch { return null; }
}

export function renderSquareBuyPreview(trade) {
  const validAddress = trade?.chain === 'sol' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trade.address) : /^0x[\da-f]{40}$/i.test(trade?.address || '');
  const policy = STRATEGY_POLICIES.find(item => item.id === trade?.strategyId);
  if (!trade || trade.side !== 'buy' || !CHAINS[trade.chain] || !validAddress || !policy || !clean(trade.id)
      || !numeric(trade.atMs) || trade.atMs < 0 || trade.atMs > 8.64e15
      || !numeric(trade.price) || trade.price <= 0 || !numeric(trade.netUsd) || trade.netUsd >= 0
      || !numeric(trade.costsUsd) || trade.costsUsd < 0) return null;
  // Use only evidence saved with this exact execution. Never borrow a current
  // candidate or a later position, which may represent a different re-entry.
  const proof = trade.entryEvidence || {};
  const source = proof.narrativeFresh === true ? validSource(proof.narrativeSource) : null;
  const narrative = source ? clean(proof.narrativeText, 300) : '';
  const flow = proof.flowFresh === true && proof.paperEligible === true ? proof.flow : null;
  const flowText = flow ? `盈利新买地址 ${count(flow.highProfitCount)} 个；聪明钱 ${count(flow.smartMoneyCount)} 个；FOMO 地址 ${count(flow.fomoCount)} 个；独立买家 ${count(flow.uniqueBuyerCount)} 个；已观察净流入 ${money(flow.netBuyUsd)}。` : '该笔成交未保存完整资金流证据，不补写地址数或净流入。';
  const stage = { internal: '内盘', near_completion: '临近毕业', external: '外盘' }[proof.marketStage] || '阶段未记录';
  const lines = [
    'yesp atm｜模拟买入（非实盘）',
    `币种：${clean(trade.symbol, 60) || '未命名'}｜${CHAINS[trade.chain]}｜${policy.label}`,
    `合约：${trade.address}`,
    `成交时间：${date(trade.atMs)}（北京时间）`,
    `模拟投入：${money(-trade.netUsd)}（含模型成本 ${money(trade.costsUsd)}）；参考成交价 $${trade.price.toPrecision(8)}。`,
    `叙事：${narrative || '没有该笔成交时绑定此合约的已核实叙事，不按币名猜测。'}`,
    ...(narrative ? [`叙事来源：${source}`] : []),
    ...(proof.narrativeAssessment ? [`叙事判断：${clean(proof.narrativeAssessment.quality, 100)}；${clean(proof.narrativeAssessment.phase, 30)}。来源身份不等于内容真实，主题分类是规则判断。`] : []),
    `入场资金：${flowText}`,
    `入场行情：${stage}；流动性 ${money(proof.liquidity)}。`,
    `买入逻辑：${clean(trade.entryLogic || trade.reason, 500) || '该笔成交未记录。'}`,
    `退出条件：${clean(trade.exitLogic, 400) || '该笔成交未保存退出条件，不套用当前策略参数。'}`,
    '本条为模拟成交记录；费用、滑点和 gas 为模型估算，没有链上买入。',
  ];
  const text = lines.join('\n');
  if (text.length > 3600) return null;
  return { kind: 'paper_buy', eventId: `paper-buy:${trade.chain}:${trade.address}:${trade.id}`, digest: hash(text), tradeId: trade.id, text, evidenceComplete: Boolean(flow && narrative && clean(trade.exitLogic)) };
}

export function createSquarePreview(snapshot, { nowMs = Date.now() } = {}) {
  if (!numeric(nowMs) || !snapshot || snapshot.status !== 'ok' || snapshot.mode !== 'paper'
      || snapshot.execution !== false || snapshot.signing !== false || snapshot.broadcast !== false) return unavailable('模拟账本尚未就绪，暂不生成草稿。');
  const updatedMs = Date.parse(snapshot.updatedAt);
  if (!Number.isFinite(updatedMs) || updatedMs > nowMs || nowMs - updatedMs > 120_000) return unavailable('账本快照已过期，等待新一轮数据后再生成草稿。');
  const account = snapshot.account;
  try { validatePaperStrategyAccount(account); } catch { return unavailable('账本校验未通过，不生成草稿。'); }
  if (account.trades.some(trade => !numeric(trade.atMs) || trade.atMs < 0 || trade.atMs > updatedMs)) return unavailable('成交时间与账本快照不一致，不生成草稿。');
  const buys = account.trades.filter(trade => trade.side === 'buy');
  if (!buys.length && (account.trades.length || Object.keys(account.positions).length)) return unavailable('存在持仓或卖出但缺少买入记录，请先核对账本。');
  const drafts = [...buys].sort((a, b) => b.atMs - a.atMs || String(b.id).localeCompare(String(a.id))).slice(0, 10).map(renderSquareBuyPreview);
  if (drafts.some(draft => !draft) || new Set(buys.map(trade => trade.id)).size !== buys.length) return unavailable('买入记录身份不完整或重复，请先核对账本。');
  if (!buys.length) {
    // This is a status/test draft, not a fabricated purchase or API success.
    const text = [
      'yesp atm｜模拟盘运行测试（非实盘）',
      `账本时间：${date(updatedMs)}（北京时间）`,
      `模拟初始资金：${money(account.initialCash)}。`,
      `当前持仓：${Object.keys(account.positions).length} 个；累计模拟成交：${account.trades.length} 笔。`,
      `已实现模拟净盈亏：${money(account.realizedPnl)}。`,
      snapshot.enabled === true ? '自动模拟开仓已开启，尚无买入记录。' : '自动模拟开仓已暂停，尚无买入记录。',
      '未来买入记录将附完整合约地址、叙事来源、资金证据、投入金额与退出条件。',
      '本条仅用于播报格式测试，不代表真实买入。',
    ].join('\n');
    drafts.push({ kind: 'system_test', eventId: `paper-test:${snapshot.updatedAt}`, digest: hash(text), tradeId: null, text, evidenceComplete: false });
  }
  return { status: 'ok', mode: 'preview_only', publishingEnabled: false, updatedAt: snapshot.updatedAt, buyCount: buys.length, drafts,
    reason: buys.length ? '最近 10 笔模拟买入的本地草稿，未公开发布。' : '尚无模拟买入，仅显示运行测试草稿。' };
}
