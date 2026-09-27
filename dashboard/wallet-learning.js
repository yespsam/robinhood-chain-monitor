const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const number = n => Number.isFinite(n) ? n.toLocaleString('zh-CN', { maximumFractionDigits: 1 }) : '—';
const money = n => Number.isFinite(n) ? `$${n.toFixed(2)}` : '—';
const chainName = chain => ({ robinhood: 'Robinhood', bsc: '币安链', sol: 'Solana', base: 'Base', eth: '以太坊' })[chain] || '未知链';
const roleName = role => ({ teacher: '盈利教师', comparison: '对照观察', unverified: '盈利待验证', excluded: '排除训练' })[role] || '待验证';
export function renderWalletLearning(report, pair) {
  if (!report) return '<p class="section-note">等待真实钱包交易记录。</p>';
  const sampled = (report.wallets || []).filter(w => w.checkedAt).length;
  const summary = `<p>发现候选 ${number(report.candidateCount)} / ${number(report.capacity?.candidates ?? 500)} 个 · 深度研究 ${number(report.walletCount)} / ${number(report.capacity?.deepWallets ?? 80)} 个（${number(sampled)} 个已取得活动页）· ${number(report.activityRecords)} 条真实记录。</p><p class="section-note">盈利教师 ${number(report.qualifiedNow)} 个 · 对照观察 ${number(report.roles?.comparison)} 个 · 盈利待验证 ${number(report.roles?.unverified)} 个 · 含 GMGN FOMO 标签 ${number(report.fomoWalletCount)} 个。候选数量不等于已采样数量，更不等于合格教师数量。</p>`;
  const stage = `<p class="section-note">${report.lastError ? '本轮采集异常，保留历史记录，暂停新增蒸馏开仓。' : report.status === 'shadow_ready' ? '已有分组达标；对照链也达标后开启同期模拟对照。' : '正在积累样本，尚未启用蒸馏开仓。'}主账户执行多链原策略，蒸馏对照仍限 ${escape(chainName(pair?.chain || 'robinhood'))}，不另增多链对照本金。每两分钟执行一项活动页采样或统计核验，不是每个地址每两分钟更新；交易检查仍为秒级。FOMO 是 GMGN 标签，不代表已确认官方身份。</p>`;
  const collection = report.profileCollection;
  const health = collection ? `<p class="section-note">画像采集：${collection.singleWalletChains?.length ? `${escape(collection.singleWalletChains.map(chainName).join('、'))}已启用逐地址兼容查询` : '逐项核对批量返回地址'}；统计异常 ${number(collection.incompleteWallets)} 个，接口漏回待补 ${number(collection.missingWallets)} 个。保留既有记录，分轮补齐；采集缺失不代表钱包亏损。</p>` : '';
  const leaders = report.profitLeaderboard;
  const leaderboard = leaders ? `<p class="section-note">盈利榜地址：${number(leaders.candidates)} 个已进入候选池，${number(leaders.dualProfiles)} 个完成新鲜双周期核验，${number(leaders.qualified)} 个达到现有盈利门槛；${number(leaders.waitingForActivitySlot)} 个尚无深度活动采样名额。来源为单币盈利交易员榜抽样，不是全链总榜；有排名不等于合格教师。未占深研名额的榜单地址也会轮询统计，原有交易样本不删除。</p>` : '';
  const coverage = (report.chainCoverage || []).map(c => `${escape(chainName(c.chain))}：${number(c.candidates)} 候选 / ${number(c.deepWallets)} 深研 / ${number(c.sampledWallets)} 已采样`).join('；');
  const personas = (report.personaCatalog || []).map(p => {
    const members = (report.wallets || []).filter(w => w.persona?.labels?.some(l => l.id === p.id));
    if (!members.length) return '';
    const ready = (report.personaGroups || []).filter(g => g.personaId === p.id && g.ready).map(g => chainName(g.chain));
    return `<article class="lane-detail"><h3>${escape(p.label)} · ${number(members.length)} 个观察样本</h3><p>可借鉴点（待验证）：${escape(p.strength)}。</p><p>局限与弊端：${escape(p.weakness)}。</p><p class="section-note">${ready.length ? `已达研究门槛：${escape([...new Set(ready)].join('、'))}；仅配置的对照链达标才进入蒸馏模拟。` : p.adoptable ? '尚待同链多钱包样本达标，不据此直接开仓。' : '仅作为对照研究，不进入自动蒸馏。'}</p></article>`;
  }).join('');
  const rows = (report.wallets || []).slice(0, 8).map(w => {
    const h = w.habits || {}, address = `${w.wallet.slice(0, 8)}…${w.wallet.slice(-6)}`;
    if (!w.checkedAt) return `<p><strong>${escape(chainName(w.chain))} · ${escape(address)}</strong>：${w.lastError ? '上次请求未完成，等待轮询重试。' : '等待首个有效活动页。'}</p>`;
    const labels = w.persona?.labels?.map(p => p.label).join('、') || '风格待确认';
    const flaws = w.persona?.drawbacks?.slice(0, 3).join('；') || '尚无足够证据归纳具体弊端';
    const performance = w.performance;
    const percentage = n => Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—';
    return `<p><strong>${escape(chainName(w.chain))} · ${escape(address)} · ${escape(roleName(w.role))}</strong>：${escape(labels)}。配对卖出 ${number(h.matchedSells)} 笔，持仓中位 ${number(h.medianHoldMs === null ? null : h.medianHoldMs / 1000)} 秒，加仓 ${number(h.adds)} 次，分批卖出 ${number(h.partialSells)} 次；排除超快卖出 ${number(h.tooFastSells)} 笔、归因不明代币 ${number(h.excludedTokens)} 个。${w.historyGap ? '历史覆盖断档，仅展示、不训练。' : ''}</p><p class="section-note">最近已取得统计：7日 / 30日胜率 ${percentage(performance?.['7d']?.winRate)} / ${percentage(performance?.['30d']?.winRate)}；7日已实现盈亏 ${money(performance?.['7d']?.realizedProfitUsd)}。已观察局限：${escape(flaws)}。画像置信度：${escape(w.persona?.confidence || '等待样本')}。</p>`;
  }).join('');
  const groups = (report.groups || []).filter(g => g.teacherCount > 0).map(g => `<p class="section-note">${escape(chainName(g.chain))} / ${g.group === 'gmgn_fomo' ? 'FOMO 标签组' : '盈利聪明钱组'}：有效教师 ${number(g.usableTeachers)}/3，配对卖出 ${number(g.matchedSells)}/30，代币 ${number(g.tokens)}/10，跨度 ${number(g.spanMs / 86400000)}/3 天。</p>`).join('');
  const comparison = pair?.student ? `<p>同期原策略净盈亏 ${money(pair.control?.netPnl)}（${number(pair.control?.exits)} 次平仓） · 蒸馏策略净盈亏 ${money(pair.student.netPnl)}（${number(pair.student.exits)} 次平仓）。</p><p class="section-note">各自独立 100 美元虚拟本金，不计入主账户；净盈亏包含模拟成本。价格过期仓位：原策略 ${number(pair.control?.stalePositions)}，蒸馏策略 ${number(pair.student.stalePositions)}。未自动替换主策略。</p>` : '<p class="section-note">同期对照尚未启动；原模拟账户继续运行。只在同链分组样本达标后启用持仓期限与亏损退出幅度，不模仿仓位规模，不降低原筛选门槛。</p>';
  return summary + stage + health + leaderboard + `<p class="section-note">${coverage}</p>` + (personas ? `<h3>已观察交易人格 · 允许多种风格重叠</h3>${personas}` : '<p>尚无足够样本识别交易风格，不虚构人格。</p>')
    + '<h3>钱包实例 · 最多展示 8 个，后台按深度研究名单轮询</h3>' + rows + groups + comparison
    + '<p class="section-note">画像是行为分类，不代表心理或真实身份；多个地址也不一定是独立交易者。买点、行情适应性、完整回撤仍待额外证据。仅将达标人格的持仓期限与亏损退出规则送入同一组前向模拟对照，不自动加仓、抄仓位或替换主策略。历史配对毛收益不是可复制净收益。</p>';
}
