// Semantic narrative layer for paper entry. Two tiers:
//  1) LLM (xAI Grok or OpenAI-compatible) when NARRATIVE_LLM_API_KEY / XAI_API_KEY / OPENAI_API_KEY is set.
//     Calls are async + cached; assessPaperNarrative stays synchronous and reads the cache,
//     so the first tick uses heuristics and later ticks use the LLM verdict.
//  2) Heuristic fallback (always available). Health is surfaced in data/paper-narrative-llm-health.json.
// Paper only. A verdict is a research label, never a buy signal by itself.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const NARRATIVE_SEMANTIC_VERSION = 'narrative_semantic_v1';
const clean = v => typeof v === 'string' ? v.replace(/\s+/gu, ' ').trim() : '';
const strip = t => clean(t).replace(/https?:\/\/\S+|0x[\da-f]{40}|[1-9A-HJ-NP-Za-km-z]{32,44}/giu, '').trim();

export const SEMANTIC_THEMES = [
  ['AI / 智能体', /\b(?:AI|agents?|LLM|GPT|grok)\b|智能体|人工智能/i],
  ['链生态 / 产品上线', /mainnet|testnet|launch|release|roadmap|listing|上线|主网|测试网|发布|产品|上币/i],
  ['现实资产 / 支付', /\b(?:RWA|payments?|stablecoin|bStocks?)\b|现实资产|支付|稳定币/i],
  ['游戏 / 社区文化', /games?|gaming|meme|community|游戏|迷因|社区|文化/i],
  ['名人 / 大佬喊话', /\b(?:CZ|elon|musk|heyi|yi he|trump)\b|何一|大佬|名人/i],
  ['动物 / 角色梗', /\b(?:dog|doge|cat|frog|pepe|shiba|bear|bull|monkey|ape|penguin)\b|狗|猫|蛙|熊|牛|猴|企鹅|角色/i],
  ['中文梗 / 情绪', /币安人生|梗|笑死|躺平|发财|牛市|信仰|中文|华语|建设|build|人生|老子|兄弟|韭菜|上岸|财富密码|整活|抽象|显眼包|打工人|破防|格局|吃瓜|内卷/i],
];
const EVENT = /launch(?:ed|ing)?|releas(?:e|ed)|announc|partnership|integrat|list(?:ed|ing)|upgrade|testnet|mainnet|adoption|roadmap|tweet(?:ed)?|post(?:ed)?|said|reply|replied|发布|上线|推出|合作|集成|上市|升级|测试|主网|路线图|增长|事件|新梗|发推|回复|喊话|提到/i;
const SCAM = /\b(?:fake|scam|rug(?:ged)?|honeypot|unaffiliated|denied|cancelled|not official|impersonat\w*|phishing|drainer)\b|假币|仿盘|骗局|非官方|否认|取消发布|钓鱼|貔貅|跑路/i;
const SLOGAN = /\b(?:moon|pump|100x|1000x|gem|lfg|wagmi|ape in|send it|buy now|don'?t miss)\b|起飞|冲|梭哈|百倍|千倍|暴涨/i;

/** Heuristic semantics: theme, event stage, scam, slogan-noise, human-narrative verdict. */
export function heuristicNarrativeSemantics(text, { reputableAuthor = false, nameMatched = false } = {}) {
  const body = strip(text);
  const themes = SEMANTIC_THEMES.filter(([, p]) => p.test(body)).map(([l]) => l);
  if (!themes.length && reputableAuthor && nameMatched) themes.push('名人 / 大佬喊话');
  const scam = SCAM.test(body);
  const sloganHits = (body.match(new RegExp(SLOGAN.source, 'giu')) || []).length;
  const letters = body.replace(/[^\p{L}\p{N}]/gu, '').length;
  const noise = letters < 12 || (sloganHits > 0 && letters - sloganHits * 6 < 30 && !EVENT.test(body));
  const eventful = EVENT.test(body);
  // A reputable account explicitly naming the token is itself the "event" (CZ/何一/Elon 发推出梗).
  const isNarrative = !scam && !noise && (themes.length > 0 && eventful || reputableAuthor && nameMatched && letters >= 8);
  const score = Math.max(0, Math.min(100, (themes.length ? 30 : 0) + (eventful ? 25 : 0) + (reputableAuthor ? 25 : 0) + (nameMatched ? 15 : 0) - (sloganHits * 10) - (scam ? 100 : 0)));
  return { version: NARRATIVE_SEMANTIC_VERSION, method: 'heuristic', themes, stage: eventful ? 'event' : 'chatter', scam, noise, isNarrative, score,
    reason: scam ? '含诈骗/否认词' : noise ? '只有口号或过短' : isNarrative ? (reputableAuthor && nameMatched ? '知名账号点名该币/梗' : '主题+具体事件') : '无具体主题事件' };
}

// ---- LLM client (optional) ----
const PROMPT = `You judge crypto meme/token narratives for a PAPER-trading research bot. Given a social post and the token (symbol/name/chain), answer strict JSON:
{"isNarrative":bool,"themes":[string],"stage":"pre_event|event|spreading|stale","scam":bool,"noise":bool,"score":0-100,"reason":"<=40 Chinese chars"}
isNarrative=true only if a human trader would say this post gives the token a real story/catalyst/meme origin (not just shilling, slogans, or price hype). scam=true for impersonation, denial, rug, fake. noise=true for pure slogans/spam.`;

export function createNarrativeLlmClassifier({ env = process.env, dataDir = null, fetchImpl = globalThis.fetch, maxConcurrent = 2, maxCache = 2000 } = {}) {
  const key = env.NARRATIVE_LLM_API_KEY || env.XAI_API_KEY || env.OPENAI_API_KEY || '';
  const xai = !env.NARRATIVE_LLM_API_KEY && !!env.XAI_API_KEY || /x\.ai/.test(env.NARRATIVE_LLM_BASE_URL || '');
  const baseUrl = (env.NARRATIVE_LLM_BASE_URL || (xai || env.XAI_API_KEY ? 'https://api.x.ai/v1' : 'https://api.openai.com/v1')).replace(/\/$/, '');
  const model = env.NARRATIVE_LLM_MODEL || (baseUrl.includes('x.ai') ? 'grok-3-mini' : 'gpt-4o-mini');
  const disabled = env.NARRATIVE_LLM_ENABLED === 'false';
  const cache = new Map(), inflight = new Set();
  const health = { version: NARRATIVE_SEMANTIC_VERSION, status: disabled ? 'disabled' : key ? 'idle' : 'search_rules_no_key', provider: key ? baseUrl : null, model: key ? model : null,
    note: key ? null : '无 API key：叙事语义走「检索+规则」路径（已核实推特/Fomo 帖子语料多信号交叉印证），不是 LLM', ok: 0, errors: 0, lastError: null, lastSuccessAt: null, updatedAt: new Date().toISOString() };
  const cacheFile = dataDir ? path.join(dataDir, 'paper-narrative-llm-cache.json') : null;
  const healthFile = dataDir ? path.join(dataDir, 'paper-narrative-llm-health.json') : null;
  try { if (cacheFile) for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).items || {})) cache.set(k, v); } catch {}
  const persist = () => {
    health.updatedAt = new Date().toISOString();
    try { if (healthFile) fs.writeFileSync(healthFile, JSON.stringify(health, null, 2)); } catch {}
    try { if (cacheFile) fs.writeFileSync(cacheFile, JSON.stringify({ version: NARRATIVE_SEMANTIC_VERSION, items: Object.fromEntries([...cache].slice(-maxCache)) })); } catch {}
  };
  persist();
  const digest = (text, token) => crypto.createHash('sha256').update(`${clean(text)}|${token?.chain}|${token?.symbol}|${token?.name}`).digest('hex').slice(0, 32);
  async function classify(text, token = {}) {
    const id = digest(text, token);
    if (cache.has(id)) return cache.get(id);
    if (!key || disabled || inflight.has(id) || inflight.size >= maxConcurrent || typeof fetchImpl !== 'function') return null;
    inflight.add(id);
    try {
      const res = await fetchImpl(`${baseUrl}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, temperature: 0, response_format: { type: 'json_object' }, messages: [
          { role: 'system', content: PROMPT },
          { role: 'user', content: JSON.stringify({ token: { chain: token.chain, symbol: token.symbol, name: token.name }, post: clean(text).slice(0, 1500) }) }] }) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const raw = JSON.parse(String(body?.choices?.[0]?.message?.content || '').replace(/^```(?:json)?|```$/g, ''));
      const verdict = { version: NARRATIVE_SEMANTIC_VERSION, method: 'llm', model, isNarrative: raw.isNarrative === true, scam: raw.scam === true, noise: raw.noise === true,
        themes: Array.isArray(raw.themes) ? raw.themes.map(String).slice(0, 4) : [], stage: String(raw.stage || 'unknown'),
        score: Math.max(0, Math.min(100, Number(raw.score) || 0)), reason: clean(String(raw.reason || '')).slice(0, 80) };
      cache.set(id, verdict); health.status = 'ok'; health.ok++; health.lastSuccessAt = new Date().toISOString(); persist();
      return verdict;
    } catch (error) {
      health.status = 'error'; health.errors++; health.lastError = String(error?.message || error).slice(0, 160); persist();
      return null;
    } finally { inflight.delete(id); }
  }
  return { classify, lookup: (text, token) => cache.get(digest(text, token)) || null, health: () => ({ ...health }), enabled: !!key && !disabled };
}

// ---- No-key "search + rules" tier (NOT an LLM) ----
// Uses the already-collected, identity-verified posts about this token (twitter-narrative monitor via
// fxtwitter + official oEmbed; Fomo X calls) as a local search corpus, and scores multi-signal evidence:
// independent author count, reputable/official authors, CA co-occurrence, theme/event agreement across posts.
export function searchCorroboratedSemantics(base, corpus = []) {
  const rows = (Array.isArray(corpus) ? corpus : []).filter(r => r && typeof (r.text || r.sourceText) === 'string');
  const authors = new Set(), reputable = new Set(), caAuthors = new Set(), themeVotes = new Map(), bodies = new Set();
  let scamPosts = 0, eventPosts = 0;
  for (const r of rows) {
    const text = r.text || r.sourceText, a = String(r.authorKey || r.authorLabel || '').toLowerCase();
    const body = strip(text).replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
    if (!a || bodies.has(body)) continue; // copy-paste shills are not independent
    bodies.add(body);
    const h = heuristicNarrativeSemantics(text, { reputableAuthor: !!r.reputableAuthor, nameMatched: true });
    if (h.scam) scamPosts++;
    if (h.noise) continue;
    authors.add(a);
    if (r.reputableAuthor) reputable.add(a);
    if (r.matchKind === 'ca') caAuthors.add(a);
    if (h.stage === 'event') eventPosts++;
    for (const t of h.themes) themeVotes.set(t, (themeVotes.get(t) || 0) + 1);
  }
  const themes = [...new Set([...base.themes, ...[...themeVotes].sort((x, y) => y[1] - x[1]).map(([t]) => t)])].slice(0, 4);
  const sharedTheme = [...themeVotes.values()].some(v => v >= 2);
  const scam = base.scam || scamPosts > 0;
  const corroborated = authors.size >= 2 && (caAuthors.size >= 2 || reputable.size >= 1 || sharedTheme && caAuthors.size >= 1);
  const score = Math.max(0, Math.min(100, base.score + Math.min(30, (authors.size - 1) * 10) + reputable.size * 10 + caAuthors.size * 5 + (sharedTheme ? 10 : 0) + Math.min(10, eventPosts * 5) - (scam ? 100 : 0)));
  const isNarrative = !scam && (base.isNarrative || corroborated && themes.length > 0 && (eventPosts > 0 || reputable.size > 0));
  return { ...base, method: 'search_rules', themes, scam, isNarrative, score,
    corroboration: { independentAuthors: authors.size, reputableAuthors: reputable.size, caAuthors: caAuthors.size, eventPosts, scamPosts, sharedTheme },
    reason: scam ? '检索语料含诈骗/否认' : isNarrative ? (base.isNarrative ? base.reason : `多账号交叉印证（${authors.size} 个独立作者）`) : base.reason,
    note: '检索+规则（本地已核实帖子语料），不是 LLM' };
}

let shared = null;
export function setNarrativeLlmClassifier(c) { shared = c; }
export function narrativeLlmClassifier() { return shared; }

/** Sync: LLM verdict if cached (and schedule one if missing), else heuristic. LLM can veto; heuristic scam always vetoes. */
export function narrativeSemantics(text, token = {}, context = {}) {
  const h = heuristicNarrativeSemantics(text, context);
  const llm = shared?.lookup?.(text, token);
  if (!llm && shared?.enabled) shared.classify(text, token).catch(() => {});
  if (!llm) return { ...searchCorroboratedSemantics(h, context.corpus), llmStatus: shared?.enabled ? 'pending' : 'unavailable_search_rules' };
  return { ...llm, scam: llm.scam || h.scam, isNarrative: llm.isNarrative && !llm.scam && !llm.noise && !h.scam,
    themes: llm.themes.length ? llm.themes : h.themes, heuristic: h, llmStatus: 'ok' };
}
