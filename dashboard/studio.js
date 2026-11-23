import { deriveLivePipelineDiagnosis, extractTransactionHash, isObservationFresh, liveSwitchStatus, normalizeStudioSnapshot, observationLabel, observationsFresh, realizedLedgerSummary } from './studio-model.js';

const $ = id => document.getElementById(id);
const esc = value => String(value ?? '—').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const promptText = value => String(value ?? '—').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200);
const num = value => value != null && value !== '' && Number.isFinite(Number(value));
const n = (value, digits = 2) => num(value) ? Number(value).toFixed(digits) : '—';
const usd = value => num(value) ? `${Number(value) < 0 ? '-$' : '$'}${Math.abs(Number(value)).toFixed(2)}` : '—';
const sgn = value => num(value) ? `<span class="${value > 0 ? 'up' : value < 0 ? 'down' : 'mute'}">${value > 0 ? '+' : ''}${usd(value)}</span>` : '<span class="mute">—</span>';
const t = value => {
  if (!value || !Number.isFinite(new Date(value).getTime())) return '—';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
};
const set = (id, html) => { const element = $(id); if (element) element.innerHTML = html; };
const short = address => address ? `${String(address).slice(0, 6)}…${String(address).slice(-4)}` : '—';
const table = (head, rows, empty) => rows.length
  ? `<table class="st-table"><tr>${head.map(column => `<th class="${column[1] || ''}">${column[0]}</th>`).join('')}</tr>${rows.map(row => `<tr>${row.map((cell, index) => `<td class="${head[index][1] || ''}">${cell}</td>`).join('')}</tr>`).join('')}</table>`
  : `<div class="trade-empty">${empty}</div>`;
const decisionKinds = {
  buy: ['CLI 调用返回成功 · 待链上核验', 'buy'],
  close: ['平仓结果已记账', 'sell'],
  refused: ['闸门拒绝', 'sell'],
  skip: ['跳过', 'sell'],
  error: ['调用出错', 'sell'],
};
const decisionClass = decision => /买/.test(decision) && !/不买/.test(decision) ? 'go' : decision === '观察' ? 'watch' : 'no';
const thoughtCard = item => `<div class="thought"><header><span class="dec ${decisionClass(item.decision)}">${esc(item.decision)}</span><b>${esc(item.symbol || short(item.address))}</b><span class="mute">${esc(String(item.chain || '').toUpperCase())} · ${esc(item.strategy)}${num(item.score) ? ` · 分 ${n(item.score, 1)}` : ''}${num(item.entryUsd) ? ` · 评估金额 ${usd(item.entryUsd)}` : ''}${item.at ? ` · ${t(item.at)}` : ''}</span></header>${item.reasons?.length ? `<ul>${item.reasons.map(reason => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}${item.missing?.length ? `<div class="miss">还缺：${item.missing.map(esc).join('、')}</div>` : ''}${item.noted?.length ? `<div class="miss">备注钱包：${item.noted.map(wallet => `${esc(wallet.label)}${wallet.follow ? `（${esc(wallet.follow)}）` : ''}`).join('、')}</div>` : ''}</div>`;

let lastSnapshot = null;
let inFlight = false;
setInterval(() => { $('clock').textContent = new Date().toLocaleTimeString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }); }, 1000);

const LIVE_CONFIRMATION = 'I_CONFIRM_THIS_TRADE';
let manualApproval = null;
let manualRequestBusy = false;
let manualCandidates = [];
let manualRouteReady = false;
const manualPost = async (url, payload) => {
  const response = await fetch(url, {
    method: 'POST', cache: 'no-store',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || body.reason || `HTTP ${response.status}`);
  return body;
};

function renderManualCandidates(candidates) {
  const rows = Array.isArray(candidates) ? candidates : [];
  manualCandidates = rows;
  set('manualCandidates', rows.length ? rows.map((candidate) => `<article class="manual-candidate">
    <div><b>${esc(candidate.symbol || short(candidate.address))}</b><span class="manual-mono">${esc(candidate.chain.toUpperCase())} · ${esc(candidate.strategy || '策略')}</span></div>
    <div class="manual-mono manual-address">${esc(candidate.address)}</div>
    <div class="manual-candidate-meta"><span>计划金额 ${usd(candidate.amountUsd)}</span><span>分数 ${n(candidate.score, 1)}</span><span>信号 ${t(candidate.at)}</span></div>
    ${candidate.reasons?.length ? `<ul>${candidate.reasons.map((reason) => `<li>${esc(reason)}</li>`).join('')}</ul>` : ''}
    <button type="button" class="manual-button" data-manual-prepare="${esc(candidate.id)}" ${manualRequestBusy || manualApproval || !manualRouteReady ? 'disabled' : ''}>检查安全并预览报价</button>
  </article>`).join('') : '<div class="trade-empty">当前没有 BSC 策略买入候选。候选缺失不会触发自动下单。</div>');
}

function renderManualApproval(approval) {
  const box = $('manualApproval');
  if (!approval) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const conditions = Array.isArray(approval.conditionOrders) ? approval.conditionOrders : [];
  const conditionText = conditions.map((condition) => {
    const label = condition.order_type === 'loss_stop' ? `止损 −${condition.price_scale}%`
      : condition.order_type === 'profit_stop_trace' ? `追踪止盈激活 +${condition.price_scale}% / 回撤 ${condition.drawdown_rate}%`
        : `止盈 +${condition.price_scale}%`;
    return `${esc(label)} · 卖出 ${esc(condition.sell_ratio)}%`;
  }).join('<br>');
  box.innerHTML = `<h3>确认单：${esc(approval.symbol)} <small>剩余 <span id="manualCountdown">15</span> 秒</small></h3>
    <dl class="manual-approval-grid">
      <div><dt>网络 / 钱包</dt><dd>${esc(approval.chain.toUpperCase())} · <span class="manual-mono">${esc(approval.wallet)}</span></dd></div>
      <div><dt>交易对</dt><dd>${esc(approval.spendAsset.toUpperCase())} <span class="manual-mono">${esc(approval.inputToken)}</span> → ${esc(approval.symbol)} <span class="manual-mono">${esc(approval.address)}</span></dd></div>
      <div><dt>策略计划金额</dt><dd>${usd(approval.amountUsd)}</dd></div>
      <div><dt>策略 / 信号时间</dt><dd>${esc(approval.strategyId)} · ${t(approval.signalAt)}</dd></div>
      <div><dt>GMGN 安全预检</dt><dd>honeypot=${esc(String(approval.security?.isHoneypot))} · rug_ratio=${n(approval.security?.rugRatio, 4)}</dd></div>
      <div><dt>滑点 / 防夹 / Gas</dt><dd>${esc(approval.slippage)} · 防夹 ${approval.antiMev ? '开' : '关'} · ${n(approval.gasPriceGwei, 2)} Gwei · 预留 ${n(approval.gasReserveBnb, 5)} BNB</dd></div>
      <div><dt>报价输入（GMGN 原始单位）</dt><dd class="manual-mono">${esc(approval.inputAmount)}</dd></div>
      <div><dt>预期输出（GMGN 原始单位）</dt><dd class="manual-mono">${esc(approval.outputAmount)}</dd></div>
      <div><dt>最低输出（GMGN 原始单位）</dt><dd class="manual-mono">${esc(approval.minOutputAmount)}</dd></div>
      <div class="manual-condition"><dt>附加条件单</dt><dd>${conditionText || '无'}</dd></div>
    </dl>
    <p class="manual-warning">${esc(approval.warning)} 订单结果、代币精度与链上成交仍须在 GMGN/区块浏览器核验；该确认不保证可成交或盈利。</p>
    <div class="manual-actions"><button type="button" class="manual-button manual-submit" id="manualConfirm" ${manualRequestBusy || !manualRouteReady ? 'disabled' : ''}>确认并提交本笔实盘</button><button type="button" class="manual-button manual-cancel" id="manualCancel" ${manualRequestBusy ? 'disabled' : ''}>取消</button></div>`;
}

async function refreshManualCandidates() {
  if (manualRequestBusy) return;
  try {
    const response = await fetch('/api/live-approval/candidates', { cache: 'no-store', headers: { accept: 'application/json' } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || body.reason || `HTTP ${response.status}`);
    manualRouteReady = body.enabled === true;
    $('manualLiveStatus').textContent = manualRouteReady ? `${body.candidates?.length || 0} 个候选 · BSC` : '实盘确认被门控';
    if (!manualApproval) $('manualLiveMessage').textContent = manualRouteReady
      ? '自动镜像已关闭。策略只提供候选；确认单需你逐笔核对并点击提交。'
      : (body.reason || '手动确认入口当前不可用');
    else if (!manualRouteReady) {
      $('manualLiveMessage').textContent = body.reason || '确认门控已关闭';
      const confirm = $('manualConfirm');
      if (confirm) confirm.disabled = true;
    }
    renderManualCandidates(body.candidates);
  } catch (error) {
    manualRouteReady = false;
    $('manualLiveStatus').textContent = '候选接口不可用';
    $('manualLiveMessage').textContent = `未能读取候选：${error.message}。不会据此自动下单。`;
    renderManualCandidates([]);
  }
}

document.addEventListener('click', async (event) => {
  const prepareButton = event.target.closest('[data-manual-prepare]');
  const confirmButton = event.target.closest('#manualConfirm');
  const cancelButton = event.target.closest('#manualCancel');
  if (!prepareButton && !confirmButton && !cancelButton) return;
  if (manualRequestBusy) return;
  manualRequestBusy = true;
  try {
    if (prepareButton) {
      prepareButton.disabled = true;
      $('manualLiveMessage').textContent = '正在重查现有风控、账本、安全信息并获取报价；此步骤不会提交买单。';
      const body = await manualPost('/api/live-approval/prepare', { candidateId: prepareButton.dataset.manualPrepare });
      if (!body.ok || !body.approval) throw new Error(body.reason || '无法创建确认单');
      manualApproval = body.approval;
      renderManualApproval(manualApproval);
      $('manualLiveMessage').textContent = '请核对上方全部参数。只有你在有效期内点击“确认并提交本笔实盘”并再次确认，才会尝试提交。';
    } else if (confirmButton && manualApproval) {
      const conditions = manualApproval.conditionOrders.map((item) => {
        const scale = item.order_type === 'loss_stop' ? `止损 −${item.price_scale}%`
          : item.order_type === 'profit_stop_trace' ? `追踪止盈激活 +${item.price_scale}% / 回撤 ${item.drawdown_rate}%`
            : `止盈 +${item.price_scale}%`;
        return promptText(`${scale} · 卖出 ${item.sell_ratio}%`);
      }).join('\n');
      const summary = `${promptText(manualApproval.chain).toUpperCase()}\n钱包：${promptText(manualApproval.wallet)}\n代币：${promptText(manualApproval.symbol)} ${promptText(manualApproval.address)}\n策略：${promptText(manualApproval.strategyId)} · 信号 ${t(manualApproval.signalAt)}\n金额：${usd(manualApproval.amountUsd)}\n输入：${promptText(manualApproval.inputAmount)}\n预期输出：${promptText(manualApproval.outputAmount)}\n最低输出：${promptText(manualApproval.minOutputAmount)}\n安全：honeypot=${promptText(manualApproval.security.isHoneypot)}, rug_ratio=${promptText(manualApproval.security.rugRatio)}\n滑点：${promptText(manualApproval.slippage)}\n防夹：${manualApproval.antiMev ? '开' : '关'} · Gas ${promptText(manualApproval.gasPriceGwei)} Gwei · 预留 ${promptText(manualApproval.gasReserveBnb)} BNB\n条件单：\n${conditions}\n\n报价可能变化；提交时会重新检查，发生变化即拒绝。仍要提交这一笔吗？`;
      if (!window.confirm(summary)) return;
      const result = await manualPost('/api/live-approval/confirm', { approvalId: manualApproval.id, confirmation: LIVE_CONFIRMATION });
      if (!result.ok) throw new Error(result.reason || '实盘门控拒绝提交');
      $('manualLiveMessage').textContent = `已向 GMGN 提交订单 ${result.orderId || '（无订单号）'}，状态 ${result.status || '未知'}；请核对订单详情与链上回执。`;
      manualApproval = null;
      renderManualApproval(null);
    } else if (cancelButton && manualApproval) {
      await manualPost('/api/live-approval/cancel', { approvalId: manualApproval.id });
      manualApproval = null;
      renderManualApproval(null);
      $('manualLiveMessage').textContent = '确认单已取消。';
    }
  } catch (error) {
    $('manualLiveMessage').textContent = `未提交 / 操作失败：${error.message}`;
    manualApproval = null;
    renderManualApproval(null);
  } finally {
    manualRequestBusy = false;
    if (manualApproval) renderManualApproval(manualApproval);
    else renderManualCandidates(manualCandidates);
    refreshManualCandidates();
  }
});

setInterval(() => {
  if (!manualApproval) return;
  const remaining = Math.max(0, Math.ceil((new Date(manualApproval.expiresAt).getTime() - Date.now()) / 1000));
  const countdown = $('manualCountdown');
  if (countdown) countdown.textContent = String(remaining);
  if (!remaining) {
    manualApproval = null;
    renderManualApproval(null);
    $('manualLiveMessage').textContent = '报价确认单已过期；请重新预览，旧报价不能提交。';
    refreshManualCandidates();
  }
}, 1000);

function render(snapshot) {
  const s = normalizeStudioSnapshot(snapshot);
  const live = s.live;
  const think = s.think;
  const state = live.manualOnly && live.enabled && !live.killed
    ? { key: 'on', label: '实盘许可已开 · 逐笔确认' }
    : live.mirrorEnabled && live.enabled && !live.killed
      ? { key: 'on', label: '自动实盘已开启' }
      : liveSwitchStatus(live);
  const liveState = $('liveState');
  liveState.dataset.s = state.key;
  liveState.textContent = state.label;
  $('chainLabel').textContent = `${String(live.chain || '—').toUpperCase()} · 只读`;

  let pipeline = deriveLivePipelineDiagnosis(s);
  if (live.manualOnly) {
    const counts = think.scan.counts || {};
    const buyCount = Number(counts['买入'] || 0) + Number(counts['买'] || 0);
    const ready = live.enabled && !live.killed && observationsFresh(live);
    pipeline = {
      key: live.killed || !live.enabled ? 'blocked' : buyCount ? 'candidate' : 'waiting',
      title: live.killed ? '急停阻止实盘确认' : !live.enabled ? '实盘总开关关闭' : buyCount ? `策略有 ${buyCount} 个买入评估` : '等待策略买入评估',
      detail: live.killed ? 'data/live-kill 存在；不会解除急停或提交订单。' : !live.enabled ? '实盘许可总开关未启用；自动镜像已禁用。' : `自动镜像已禁用；BSC 策略信号只进入逐笔候选。${ready ? '余额/价格观察新鲜；仍需重新检查安全与报价并由你确认。' : '余额/价格观察不新鲜；预览会被风险门控拒绝。'}`,
      sourceLabel: '策略候选 · 人工逐笔确认', scopeLabel: 'BSC · 自动镜像关闭',
      latestSummary: think.last ? `${think.last.decision || '未知'} · ${String(think.last.chain || '').toUpperCase()} · ${t(think.last.at)}` : '暂无最近策略评估',
      executionSummary: '没有用户确认单就不会调用买入执行器',
    };
  }
  const pipelineStatus = $('pipelineStatus');
  pipelineStatus.dataset.state = pipeline.key;
  $('pipelineTitle').textContent = pipeline.title;
  $('pipelineDetail').textContent = pipeline.detail;
  $('pipelineSource').textContent = pipeline.sourceLabel;
  $('pipelineScope').textContent = pipeline.scopeLabel;
  $('pipelineLatest').textContent = pipeline.latestSummary;
  $('pipelineExecution').textContent = pipeline.executionSummary;

  set('walletAddr', esc(live.wallet ? `${live.wallet.slice(0, 8)}…${live.wallet.slice(-4)}` : '钱包未配置'));
  const observations = live.observations || {};
  const bnbObservation = observations.bnb;
  const priceObservation = observations.bnbPriceUsd;
  const spendObservation = observations.spendBalance;
  const liveDataFresh = observationsFresh(live);
  const safeBnb = isObservationFresh(bnbObservation) ? live.bnb : null;
  const safePrice = isObservationFresh(priceObservation) ? live.bnbPriceUsd : null;
  const safeBalance = liveDataFresh ? live.balanceUsd : null;
  set('mBnb', `${n(safeBnb, 5)}<span class="mute"> ${esc(observationLabel(bnbObservation))}</span>`);
  set('mUsable', `${usd(safeBalance)}<span class="mute"> ${esc(String(live.spendAsset || '').toUpperCase())} · ${esc(observationLabel(spendObservation))}</span>`);
  set('mToday', `${sgn(live.todayRealizedUsd)}<span class="mute"> 账本</span>`);
  const realized = realizedLedgerSummary(live);
  set('mRealizedAll', `${sgn(realized.value)}<span class="mute"> ${realized.count} 笔已平仓账本记录；非全链核验</span>`);
  set('mExposure', `${usd(live.exposureUsd)}<span class="mute"> / ${usd(live.maxTotalUsd)}</span>`);
  set('mCaps', `${usd(live.maxPerTradeUsd)}<span class="mute"> / ${usd(live.dailyLossStopUsd)}</span>`);
  set('liveChips', `花费 ${esc(String(live.spendAsset || '—').toUpperCase())} · gas 预留 ${n(live.gasReserveBnb, 4)} BNB · 防夹 ${live.antiMev ? '开' : '关'} · 最多 ${live.maxOpenPositions ?? '—'} 仓 · 来源 ${esc(live.signalSource || '—')}`);
  set('bnbPrice', `BNB ${usd(safePrice)} · ${esc(observationLabel(priceObservation))}`);

  const positions = live.positions;
  set('posCount', `${positions.length} 条账本记录`);
  set('posList', positions.length
    ? table([['代币 / CA'], ['记录金额', 'r'], ['记录 BNB', 'r'], ['账本时间'], ['记录状态']], positions.map(position => [
      `${esc(position.symbol || '未知代币')}<br><span class="mute">${esc(position.token || 'CA 未记录')}</span>`,
      usd(position.usd), n(position.bnb, 5), t(position.at), esc(position.status || '未知'),
    ]), '')
    : '<div class="focus-empty">暂无实盘账本持仓<span>空账本不等于链上余额为零；请分别核验钱包和交易记录。</span></div>');

  set('decisions', table([['时间'], ['事件'], ['代币 / CA'], ['金额', 'r'], ['原因 / 状态']], think.decisions.map(decision => {
    const [label, tone] = decisionKinds[decision.kind] || [esc(decision.kind || '未知'), ''];
    const txHash = extractTransactionHash(decision);
    let detail = decision.reasonZh || decision.reason || (decision.entryReasons || []).join('；') || '—';
    if (decision.kind === 'buy') detail = decision.orderId ? `GMGN 订单 ${decision.orderId} 状态=${decision.orderStatus || '?'}（已轮询 order get）` : 'CLI 调用返回成功；尚无链上回执核验';
    else if (decision.kind === 'error' && /AUTH_IP_BLOCKED/.test(decision.reason || '')) detail = 'GMGN 拒绝：出口 IP 未加白名单（AUTH_IP_BLOCKED）。' + detail;
    return [
      t(decision.at), `<span class="side ${tone}">${label}</span>`,
      `${esc(decision.symbol || short(decision.token))}<br><span class="mute">${esc(String(decision.chain || '').toUpperCase())} · ${esc(decision.token || 'CA 未记录')}</span>`,
      usd(decision.kind === 'close' ? decision.pnlUsd : decision.usd ?? decision.paperUsd),
      `${esc(detail)}${txHash ? /bsc/i.test(String(decision.chain || '')) ? `<br><a href="https://bscscan.com/tx/${txHash}" target="_blank" rel="noopener noreferrer">核对链上交易 ${esc(short(txHash))}</a>` : `<br><span class="mute">Tx ${esc(txHash)}</span>` : ''}`,
    ];
  }), '暂无可核验的执行日志。开关状态和策略信号都不能证明执行器健康或订单已成交。'));

  const gate = think.gate;
  const gateVerdict = $('gateVerdict');
  const gateEffectiveOk = Boolean(gate.ok && (!live.enabled || liveDataFresh));
  gateVerdict.className = `gate-verdict ${gateEffectiveOk ? 'ok' : 'no'}`;
  gateVerdict.textContent = gateEffectiveOk
    ? '当前配置闸门预检通过；仅为只读计算，不代表报价、交易模拟或成交。'
    : `当前配置闸门预检阻止：${live.enabled && !liveDataFresh ? 'API 未提供可验证的新鲜余额/报价时间戳' : gate.reason || '状态不可用'}`;
  set('gTicket', n(live.maxPerTradeUsd, 2));
  const freshnessChecks = [{ ok: liveDataFresh, name: '余额/报价新鲜度', detail: liveDataFresh ? '采样时间有效' : '时间戳缺失、过期或读取失败' }];
  const sourceChecks = (gate.checks || []).map(check => {
    if (!liveDataFresh && /余额|balance|BNB/i.test(String(check.name))) {
      return { ...check, ok: false, detail: '接口未提供新鲜时间戳；金额已隐藏，未核验' };
    }
    return check;
  });
  set('gateChecks', [...sourceChecks, ...freshnessChecks].map(check => `<li class="${check.ok ? 'ok' : 'no'}"><span>${esc(check.name)}</span><span>${esc(check.detail)}</span></li>`).join('') || '<li class="no"><span>闸门数据</span><span>不可用</span></li>');
  const warnings = [...(gate.monitorWarnings || [])];
  if (live.enabled && !liveDataFresh) warnings.unshift({ ok: false, name: '余额与报价数据未核验', detail: '当前接口未提供足够的新鲜度证据，相关金额已隐藏' });
  set('gateWarnings', warnings.map(warning => `<div class="gate-verdict ${warning.ok ? 'ok' : 'no'}"><b>${warning.ok ? '观察正常' : '监控提示'}</b> · ${esc(warning.name)}：${esc(warning.detail)}<span class="mute">（不改变交易执行逻辑）</span></div>`).join(''));

  const scan = think.scan;
  set('scanMeta', `扫描间隔 ${num(scan.intervalMs) ? `${scan.intervalMs / 1000} 秒` : '未知'} · 评估 ${scan.total ?? 0} 个 · ${Object.entries(scan.counts || {}).map(([key, value]) => `${esc(key)} ${value}`).join(' / ') || '暂无计数'} · 引擎状态 ${esc(scan.engineStatus || '未知')}`);
  set('lastThought', think.last ? thoughtCard(think.last) : '<div class="trade-empty">暂无最近策略评估</div>');
  set('topReasons', (scan.topReasons || []).map(reason => `<li>${esc(reason.reason)}<b>×${esc(reason.count)}</b></li>`).join('') || '<li class="mute">暂无拒绝理由统计</li>');
  set('cands', think.candidates.map(thoughtCard).join('') || '<div class="trade-empty">信号源暂无候选</div>');
  set('signalBuys', table([['时间'], ['代币 / CA'], ['信号仓', 'r'], ['链/会话范围'], ['理由']], think.signalBuys.map(buy => [
    t(buy.at), `${esc(buy.symbol || short(buy.address))}<br><span class="mute">${esc(String(buy.chain || '').toUpperCase())} · ${esc(buy.address || 'CA 未记录')}</span>`,
    usd(buy.usd), (buy.scopeMatch ?? buy.wouldMirror) ? '<span class="side buy">链/会话范围匹配 · 闸门未核验</span>' : '<span class="side sell">不在当前实盘范围</span>', esc((buy.reasons || []).join('；') || '—'),
  ]), '信号源暂无买入样本；此区仅展示评估，不是订单。'));

  $('streamStatus').dataset.status = 'ok';
  $('streamLabel').textContent = `快照 ${t(s.now).slice(-8)}`;
  const notice = $('studioNotice');
  notice.hidden = false;
  notice.textContent = live.killed
    ? '急停文件已触发；自动镜像和逐笔确认入口都会拒绝新单。'
    : live.enabled
      ? live.mirrorEnabled
        ? '自动实盘已开启：新的合格策略买入通过风控后自动执行。历史信号不会补买，成交以订单回执为准。'
        : '实盘许可配置已启用，但自动镜像已禁用；只能由本页逐笔确认尝试提交。订单/CLI 状态不等于链上成交，须核对交易哈希和回执。'
      : '实盘总开关关闭；自动镜像已禁用。本页仍可查看策略评估与历史账本。';
}

async function tick() {
  if (inFlight) return;
  inFlight = true;
  try {
    const response = await fetch('/api/studio', { cache: 'no-store', headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const snapshot = normalizeStudioSnapshot(await response.json());
    render(snapshot);
    lastSnapshot = snapshot;
  } catch (error) {
    $('streamStatus').dataset.status = '';
    $('streamLabel').textContent = lastSnapshot ? `连接中断 · 上次 ${t(lastSnapshot.now).slice(-8)}` : '接口不可用';
    const notice = $('studioNotice');
    notice.hidden = false;
    notice.textContent = `工作室状态快照读取失败：${error.message}。${lastSnapshot ? `画面保留的是 ${t(lastSnapshot.now)} 的旧快照，请勿当作实时状态。` : '尚无可展示的有效快照。'}`;
  } finally {
    inFlight = false;
  }
}

tick();
setInterval(tick, 5000);
refreshManualCandidates();
setInterval(refreshManualCandidates, 5000);
