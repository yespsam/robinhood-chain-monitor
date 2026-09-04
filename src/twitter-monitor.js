import fs from "node:fs/promises";
import path from "node:path";
import { monitoredLaunchpads } from "./launchpad-catalog.js";
import { isTerminalAlertSuppression, sendAlerts } from "./alerts.js";
import { PLATFORM_CAPABILITY_TARGETS } from "./platform-capability-monitor.js";
import { extractGithubRepositories } from "./github-monitor.js";
import { classifyBinanceOfficialText } from "./binance-monitor.js";
import { parseXDirectTimeline } from "./x-direct-timeline.js";
import { recoverFourTwitterPolicyFixes } from "./four-twitter-policy-recovery.js";
import {
  classifyFlapQuotePairSignalCore,
  classifyFourMemeOfficialSignalCore,
  classifyPonFunSignalCore,
  isMonitoringSourceEnabled,
  isThreePlatformScope,
} from "./source-controls.js";
import { extractChainSupportSignals } from "./chain-support.js";

const SIGNALS = [
  ["新发射/新模式", /\b(new\s+(?:launch|launchpad|factory|mode|module)|bonding curve|graduat(?:e|ion)|migrat(?:e|ion)|v[2-9](?:\s+(?:is\s+)?(?:live|launch|upgrade|coming|soon))?)\b/i],
  ["合约/部署", /\b(contract\s+(?:address|deployed|live|upgrade)|deployed\s+(?:on|to)\s+(?:mainnet|robinhood)|mainnet\s+(?:launch|deployment)|new\s+(?:router|pool|hook)|open.source\s+(?:contracts?|code))\b/i],
  ["代币事件", /\b(trading\s+(?:is\s+)?live|fair\s+launch|token\s+launch|claim\s+(?:is\s+)?live|liquidity\s+(?:added|migration))\b/i],
  ["订阅功能", /(?:\bsubscription(?:s)?\b|\bsubscrib(?:e|ed|ing)\b|订阅|会员)/i],
  ["OpenFour", /\bopen\s*four\b/i],
  ["税收/募资/报价代币", /(?:\btax(?:ed|es|ation)?\b|\braised?\s+tokens?\b|\bquote\s+tokens?\b|\bUUSD\b|税率|税收|征税|募资代币|募集代币|报价代币|计价代币)/i],
  ["慈善捐赠/交易税模式", /(?:\bTaxToken\d+\b|\bcharit(?:y|able)\s+(?:donation|recipient|badge|dashboard|tax)\b|\bdonation\s+(?:feature|mode|tax|recipient)\b|\b(?:Giggle|Binance)\s+Charity\b|慈善(?:捐赠|徽章|面板|税)|公益(?:捐赠|税))/i],
  ["活动/费用变更", /(?:\bcampaigns?\b|(?:platform|trading|protocol|creation|launch|subscription)\s+fees?\b|\bfees?\s+(?:change|changes|changed|update|updated|adjust|adjusted|reduc(?:e|ed|tion)|waiv(?:e|ed|er)|structure)\b|活动(?:上线|开始|更新|变更|调整)|费用(?:变更|调整|更新|减免)|手续费(?:变更|调整|更新|减免)|费率(?:变更|调整|更新))/i],
  ["擂台/赛事新玩法", /\b(?:tournament|bracket|fighter|head[- ]to[- ]head|registration(?:s)?\s+(?:open|live)|match(?:es)?\s+(?:open|live|start(?:ed)?))\b/i],
];

const UNISWAP_SIGNAL_PATTERNS = [
  ["Uniswap 新发射/新模式", /\b(?:liquidity[ -]launcher|launchpad|launch(?:es)?\s+(?:tab|aggregator)|crowd\s+launch|instant\s+launch|twap\s+(?:auction|bid)|bonding\s+curve|new\s+launch\s+(?:mechanism|strategy|mode))\b/i],
  ["Uniswap 新底池/Hook", /\b(?:dualpool|new\s+(?:pool|hook)\s+(?:mode|design|type)|v4\s+hook|erc-?4626|jit\s+liquidity|permissioned\s+pools?)\b/i],
  ["Uniswap 协议/合约部署", /\b(?:new\s+(?:contract|deployment|router|strategy|reactor)|(?:contract|protocol)\s+(?:deployed|deployment|upgrade)|mainnet\s+(?:deployment|support)|robinhood\s+chain|universalrouterstrategy|instantlaunchstrategy|feesplitter)\b/i],
  ["Uniswap 治理/费用", /\b(?:protocol\s+fees?|fee\s+switch|governance\s+(?:proposal|vote|execution)|proposal\s+(?:created|queued|executed|canceled)|temperature\s+check|onchain\s+vote)\b/i],
  ["Uniswap 安全/版本", /\b(?:security\s+(?:incident|advisory|audit|fix)|critical\s+(?:fix|vulnerability)|liquidity[ -]launcher\s+v\d|uniswapx\s+v\d|v4\s+(?:release|upgrade))\b/i],
];

const FOCUS_PLATFORM_COMPONENT = /\b(?:factory|launcher|launchpad|portal|vault(?:\s+factory)?|token\s+manager|router|manager|core|implementation|proxy|platform\s+contract|contract\s+template|module|plugin|strategy|mechanism|bonding\s+curve|graduation|migration|tax\s+mode|tax\s+token|quote\s+token|token\s+template|charity\s+(?:donation|badge|dashboard|tax)|donation\s+(?:feature|mode|tax)|sdk|api)\b/i;
const FOCUS_PLATFORM_CHANGE_ACTION = /\b(?:new|add(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)?|deploy(?:s|ed|ing)?|releas(?:e|es|ed|ing)|enabl(?:e|es|ed|ing)|support(?:s|ed|ing)?|upgrad(?:e|es|ed|ing)|available|live)\b/i;
const FOCUS_PLATFORM_EXPLICIT_OBJECT = /\b(?:new\s+(?:factory|launcher|launchpad|portal|vault|module|plugin|strategy|mechanism|bonding\s+curve|graduation|migration|tax\s+mode|tax\s+token|quote\s+token|token\s+template|charity\s+(?:donation|badge|dashboard|tax)|donation\s+(?:feature|mode|tax)|sdk|api)|(?:pool|hook)\s+(?:mode|type|design|template|module|mechanism)|(?:v4|infinity)\s+(?:pool|hook)\s+(?:support|mode|type)|open\s*four|TaxToken\d+)\b/i;
const FOCUS_PLATFORM_CHARITY_MODE = /(?:\bTaxToken\d+\b|\bcharity\s+donation\s+(?:feature|mode)\b|\bcharity\s+(?:badge|dashboard|tax)\b|慈善(?:捐赠模式|捐赠功能|徽章|面板|税))/i;
const FOCUS_PLATFORM_VERSION = /\b(?:flap|four\.?meme|open\s*four|platform|launchpad)\s+v[2-9](?:\.\d+){0,2}\b[^\n]{0,50}\b(?:live|launch(?:ed)?|released?|upgrade(?:d)?|coming)\b/i;
const FOCUS_PLATFORM_SUBSCRIPTION = /(?:\b(?:flap|four\.?meme|open\s*four|platform|launchpad|product|module|feature)\b[^\n]{0,60}\bsubscriptions?\b|\bsubscriptions?\b[^\n]{0,60}\b(?:flap|four\.?meme|open\s*four|platform|launchpad|product|module|feature)\b)/i;
const FOCUS_PROMOTIONAL_CAMPAIGN = /(?:\b(?:trade\s*(?:&|and)\s*win|trading\s+competition|bonus\s+pool|prize\s+pool|reward\s+pool|giveaway|airdrop|contest|compete\s+for|trading\s+volume|profit\s*(?:>|&gt;)|leaderboard)\b|交易(?:大赛|竞赛|赢奖)|奖金池|奖池|交易量|收益(?:大于|超过))/i;
const FOCUS_PLATFORM_CHAIN_ACTION = /(?:\b(?:flap|four\.?meme|open\s*four|we|our\s+(?:platform|launchpad|app)|(?:the\s+)?(?:platform|launchpad|protocol|app))\b[^.!?\n]{0,140}\b(?:is\s+)?(?:now\s+)?(?:live|available|launch(?:es|ed|ing)?|deploy(?:s|ed|ing)?|support(?:s|ed|ing)?|expand(?:s|ed|ing)?|integrat(?:e|es|ed|ing)?|roll(?:s|ed|ing)?\s+out)\b|\b(?:add(?:s|ed|ing)?\s+support|support(?:s|ed|ing)?|expand(?:s|ed|ing)?|integrat(?:e|es|ed|ing)?)\b[^.!?\n]{0,80}\b(?:chain|network|mainnet|testnet)\b)/i;
// An official launchpad skill inside an agentic wallet is a new product
// distribution/integration surface, not an ordinary token launch. Require all
// three anchors so generic AI chatter, wallet marketing, and token promotions
// remain filtered.
const FOCUS_PLATFORM_AGENT_SKILL = /(?=[\s\S]*\b(?:flap|four\.?meme|open\s*four)\b)(?=[\s\S]*(?:\b(?:agentic\s+wallet|ai\s+agent)\b|智能代理|代理钱包))(?=[\s\S]*(?:\b(?:token[- ]launch|launchpad)\s+skills?\b|代币发行技能))[\s\S]*/i;

const CHANGE_LIST_PREFIX = /^(?:[-*•▪◦‣●○◆◇]|✅|☑️?|✔️?|🔹|🔸|➤|➡️?|(?:\d{1,2}[.)：:]|[①-⑳]|[1-9]\ufe0f?\u20e3))\s*/u;
const PREVIOUS_CLAIM = /^(?:previous(?:ly)?|before|old)\s*(?:[:：]|[-–—])\s*(.+)$/i;
const CURRENT_CLAIM = /^(?:now|after|new|current(?:ly)?)\s*(?:[:：]|[-–—])\s*(.+)$/i;
const EXPLICIT_CHANGE_CLAIM = /(?:\b(?:is|are|'s)\s+now\s+(?:live|available|supported|enabled|deployed)|\b(?:is|are)\s+(?:live|available)|\b(?:now\s+)?(?:supports?|adds?|added|adding|introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)|releas(?:e|es|ed|ing)|enabl(?:e|es|ed|ing)|deploy(?:s|ed|ing)|updat(?:e|es|ed|ing)|upgrad(?:e|es|ed|ing)|expand(?:s|ed|ing)|integrat(?:e|es|ed|ing)|switch(?:es|ed|ing)|accept(?:s|ed|ing))\b|\bavailable\s+as\b)/i;
const FACTUAL_SENTENCE = /\b(?:is|are|was|were|has|have|had|can|will|supports?|adds?|added|introduc(?:e|es|ed)|launch(?:es|ed)|releas(?:e|es|ed)|enabl(?:e|es|ed)|deploy(?:s|ed)|updat(?:e|es|ed)|upgrad(?:e|es|ed)|expand(?:s|ed)|integrat(?:e|es|ed)|switch(?:es|ed)|accept(?:s|ed))\b/i;

function normalizeClaim(value, { stripListPrefix = true } = {}) {
  let normalized = String(value || "")
    .replace(/\[([^\]]+)]\(https?:\/\/[^)]+\)/gi, "$1")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/^\s*(?:show more|read more)\s*/i, "")
    .replace(/[ \t]+/g, " ")
    .trim();
  if (stripListPrefix) normalized = normalized.replace(CHANGE_LIST_PREFIX, "").trim();
  return normalized.replace(/\s+(?:show more|read more)\s*$/i, "").trim();
}

function changeClaimSegments(text) {
  const prepared = String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+(?=(?:\d{1,2}[.)]|[①-⑳]|[1-9]\ufe0f?\u20e3)\s+)/gu, "\n")
    .replace(/(?<!\d)([.!?。！？])(?=\s|$)/g, "$1\n");
  return prepared.split(/\n+/).map((raw, index) => {
    const trimmed = normalizeClaim(raw, { stripListPrefix: false });
    return {
      index,
      raw: trimmed,
      text: normalizeClaim(trimmed),
      listed: CHANGE_LIST_PREFIX.test(trimmed),
    };
  }).filter(({ text }) => text.length > 2);
}

function appendOfficialClaims(signal, text) {
  if (!signal?.relevant) return signal;
  const segments = changeClaimSegments(text);
  const headline = segments.find((segment) => !segment.listed
    && !PREVIOUS_CLAIM.test(segment.text)
    && !CURRENT_CLAIM.test(segment.text)
    && EXPLICIT_CHANGE_CLAIM.test(segment.text))?.text || null;
  const candidates = [];
  const consumed = new Set();
  const add = (claim, keyChange = claim, priority = 0) => {
    const normalizedClaim = normalizeClaim(claim);
    const normalizedChange = normalizeClaim(keyChange);
    if (!normalizedClaim || !normalizedChange) return;
    candidates.push({ claim: normalizedClaim, keyChange: normalizedChange, priority, order: candidates.length });
  };

  // Preserve an explicit before/after comparison as one change instead of two
  // disconnected snippets. The arrow is formatting only; both facts remain
  // verbatim from the post.
  for (let index = 0; index < segments.length - 1; index += 1) {
    const previous = segments[index].text.match(PREVIOUS_CLAIM);
    const current = segments[index + 1].text.match(CURRENT_CLAIM);
    if (!previous || !current) continue;
    add(
      `${segments[index].text} ${segments[index + 1].text}`,
      `${segments[index].text} → ${segments[index + 1].text}`,
      4,
    );
    consumed.add(segments[index].index);
    consumed.add(segments[index + 1].index);
    index += 1;
  }

  for (const segment of segments) {
    if (consumed.has(segment.index)) continue;
    if (segment.listed) add(segment.text, segment.text, 3);
    else if (/(?:→|⇒|⟶|--?>)/u.test(segment.text)) add(segment.text, segment.text, 4);
    else if (EXPLICIT_CHANGE_CLAIM.test(segment.text)) add(segment.text, segment.text, 2);
  }

  if (!candidates.length) {
    const completeEvidence = ({ text: claim }) => (
      /[.!?。！？]$/.test(claim)
      && !/^(?:read|learn|click|join|watch|try)\b/i.test(claim)
    );
    const fallback = segments.find(({ text: claim }) => completeEvidence({ text: claim }) && FACTUAL_SENTENCE.test(claim))
      || segments.find(({ text: claim }) => completeEvidence({ text: claim }) && (
        SIGNALS.some(([, pattern]) => pattern.test(claim))
        || UNISWAP_SIGNAL_PATTERNS.some(([, pattern]) => pattern.test(claim))
      ))
      || segments.find(({ text: claim }) => FACTUAL_SENTENCE.test(claim));
    if (fallback) add(fallback.text, fallback.text, 1);
  }

  const selected = candidates
    .sort((left, right) => right.priority - left.priority || left.order - right.order)
    .filter((candidate, index, values) => {
      const key = candidate.keyChange.toLowerCase().replace(/[.!?。！？]+$/g, "");
      return values.findIndex((other) => other.keyChange.toLowerCase().replace(/[.!?。！？]+$/g, "") === key) === index;
    })
    .slice(0, 5);
  if (!selected.length) return signal;
  return {
    ...signal,
    ...(headline ? { headline } : {}),
    claims: selected.map(({ claim }) => claim),
    keyChanges: selected.map(({ keyChange }) => keyChange),
  };
}

export function classifyUniswapOfficialText(text = "") {
  const source = String(text || "");
  if (/\b(?:equity\s*launch|stocks?\s+(?:issuance|offering|tokenization|tokens?)|tokenized\s+(?:stocks?|equities|securities)|security[- ]+tokens?|securities?\s+offering)\b/i.test(source)) {
    return { relevant: false, strong: false, labels: [], reason: "equity_or_stock_issuance" };
  }
  const labels = UNISWAP_SIGNAL_PATTERNS.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
  const chainSupport = extractChainSupportSignals(source);
  if (chainSupport.length) labels.push("Uniswap 新链支持");
  return appendOfficialClaims({
    relevant: labels.length > 0,
    strong: labels.length > 0,
    labels: [...new Set(labels)],
    ...(chainSupport.length ? { chainSupport } : {}),
  }, source);
}

const AI_PRODUCT_OBJECT = /\b(?:grok(?:[- ]?(?:build|imagine|voice|bot|code))?|xai|space\s*xai|x\s+(?:api|activity\s+api|chat|premium|money|articles?|spaces?)|xdk|sdk|api|endpoint|model|tool|connector|workflow|automation|plugin|marketplace|voice|speech[- ]to[- ](?:text|speech)|text[- ]to[- ]speech|image|video|search|developer\s+console|community\s+notes)\b/i;
const AI_PRODUCT_ACTION = /\b(?:introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)?|releas(?:e|es|ed|ing)|ship(?:s|ped|ping)?|roll(?:s|ed|ing)?\s+out|is\s+now\s+(?:available|live)|now\s+(?:available|supports?)|add(?:s|ed|ing)?|support(?:s|ed|ing)?|upgrad(?:e|es|ed|ing)|open[- ]source(?:s|d|ing)?|public\s+(?:beta|preview)|general(?:ly)?\s+available|deprecat(?:e|es|ed|ing|ion)|sunset|remov(?:e|es|ed|ing)|breaking\s+change|security\s+(?:incident|advisory|fix)|critical\s+(?:fix|vulnerability)|pricing\s+(?:update|change)|price\s+(?:cut|drop|change))\b/i;
const AI_CORPORATE_NOISE = /\b(?:funding|fundrais(?:e|ing)|series\s+[a-z]|valuat(?:ion|ed)|acquir(?:e|es|ed|ing)|joins?\s+(?:space\s*x|xai)|hiring|career|job\s+opening|award|partnership|partner(?:s|ed|ing)?\s+with|government\s+contract|data\s+cent(?:er|re)|compute\s+cluster)\b/i;
const AI_MARKETING_OR_EVENT_NOISE = /\b(?:giveaway|airdrop|contest|competition|hackathon|conference|keynote|livestream|live\s+stream|webinar|meetup|merch(?:andise)?|shop|swag|customer\s+story|case\s+study|follow\s+us|subscribe|watch\s+(?:now|live)|join\s+us)\b/i;
const AI_REGIONAL_ROLLOUT = /\b(?:available|launch(?:es|ed|ing)?)\s+(?:now\s+)?in\s+(?:[A-Z][A-Za-z.-]+(?:\s+[A-Z][A-Za-z.-]+){0,2}|\d+\s+(?:countries|markets|regions))\b/;
const AI_MODEL_SIGNAL = /\b(?:grok[- ]?[0-9]+(?:\.[0-9]+)*(?:[- ](?:fast|mini|heavy|preview))?|grok[- ](?:code|voice|imagine|build)[- a-z0-9.]*|new\s+(?:flagship\s+)?model|model\s+(?:is\s+)?(?:available|released|launched))\b/i;
const AI_API_SIGNAL = /\b(?:api|endpoint|websocket|webhook|sdk|xdk|mcp|developer\s+console|function\s+calling|tool\s+use|context\s+window|rate\s+limit|batch\s+api|responses\s+api|files\s+api|activity\s+api)\b/i;
const AI_X_PRODUCT_SIGNAL = /(?:\bx\s+(?:chat|premium|money|articles?|spaces?)\b|\bcommunity\s+notes\b)/i;
const AI_GROK_PRODUCT_SIGNAL = /(?:\bgrok[- ](?:build|imagine|voice|code|bot)\b|\b(?:workflow|automation|connector|plugin|marketplace)\b)/i;
const AI_LIFECYCLE_SIGNAL = /\b(?:deprecat(?:e|es|ed|ing|ion)|sunset|breaking\s+change|remov(?:e|es|ed|ing|al))\b/i;
const AI_MAJOR_SECURITY_SIGNAL = /\b(?:security\s+(?:incident|advisory|fix)|critical\s+(?:fix|vulnerability)|cve-\d{4}-\d+|credential\s+(?:leak|exposure)|data\s+(?:leak|exposure))\b/i;
const AI_PRICING_SIGNAL = /(?:\b(?:pricing|price)\s+(?:update|change|cut|drop|reduction)|\b(?:input|output|cached)\s+tokens?\b[^\n]{0,50}\b(?:price|pricing|cost|per\s+(?:million|1m))\b|\$\s*\d+(?:\.\d+)?\s*(?:\/|per)\s*(?:million|1m)\s+tokens?)/i;
const AI_SECURITY_OR_LIFECYCLE = new RegExp(`(?:${AI_LIFECYCLE_SIGNAL.source}|${AI_MAJOR_SECURITY_SIGNAL.source}|${AI_PRICING_SIGNAL.source})`, "i");

export function classifyAiOfficialText(text = "") {
  const source = String(text || "").replace(/&amp;/gi, "&");
  if (AI_CORPORATE_NOISE.test(source)) {
    return { relevant: false, strong: false, labels: [], reason: "corporate_funding_or_partnership_noise" };
  }
  if (!AI_PRODUCT_OBJECT.test(source)) {
    return { relevant: false, strong: false, labels: [], reason: "ordinary_post_or_no_product_action" };
  }
  const action = AI_PRODUCT_ACTION.test(source);
  const modelChange = action && AI_MODEL_SIGNAL.test(source);
  const xProductChange = action && AI_X_PRODUCT_SIGNAL.test(source);
  const apiChange = action && AI_API_SIGNAL.test(source);
  const grokProductChange = action && AI_GROK_PRODUCT_SIGNAL.test(source);
  const lifecycleChange = AI_LIFECYCLE_SIGNAL.test(source) && (AI_API_SIGNAL.test(source)
    || AI_MODEL_SIGNAL.test(source) || AI_X_PRODUCT_SIGNAL.test(source) || AI_GROK_PRODUCT_SIGNAL.test(source));
  const securityChange = AI_MAJOR_SECURITY_SIGNAL.test(source);
  const pricingChange = AI_PRICING_SIGNAL.test(source);
  const structural = modelChange || xProductChange || apiChange || grokProductChange
    || lifecycleChange || securityChange || pricingChange;
  if (!structural) {
    return { relevant: false, strong: false, labels: [], reason: "ordinary_post_or_no_product_action" };
  }
  if ((AI_MARKETING_OR_EVENT_NOISE.test(source) || AI_REGIONAL_ROLLOUT.test(source))
    && !modelChange && !lifecycleChange && !securityChange && !pricingChange) {
    return { relevant: false, strong: false, labels: [], reason: "marketing_event_or_regional_noise" };
  }
  const labels = [];
  if (xProductChange) labels.push("X 产品新功能");
  if (/\bx\s+(?:api|activity\s+api)\b|\bxdk\b/i.test(source)) labels.push("X API 更新");
  if (modelChange) labels.push("Grok 新模型/能力");
  if (apiChange && !labels.includes("X API 更新")) labels.push("xAI/Grok API 更新");
  if (grokProductChange) labels.push("Grok 产品新功能");
  if (AI_SECURITY_OR_LIFECYCLE.test(source)) labels.push("定价/弃用/安全");
  if (!labels.length) labels.push("X/xAI/Grok 产品更新");
  return appendOfficialClaims({
    relevant: true,
    strong: true,
    labels: [...new Set(labels)],
    productStructural: true,
    reason: "official_product_model_or_api_change",
  }, source);
}

export function classifyPonFunOfficialText(text = "") {
  const source = String(text || "").replace(/&amp;/gi, "&");
  const signal = classifyPonFunSignalCore(source);
  return signal.relevant ? appendOfficialClaims(signal, source) : signal;
}

const BINANCE_CRITICAL_X_MAX_AGE_MS = 2 * 60 * 60 * 1_000;
const FOCUS_CRITICAL_X_MAX_AGE_MS = 10 * 60 * 1_000;
const CRITICAL_X_TARGET_PROFILES = new Map([
  ["binance", "binance_product"],
  ["binancewallet", "binance_product"],
  ["flapdotsh", "focus_launchpad"],
  ["fourdotmemezh", "focus_launchpad"],
  ["pondotfun", "pon_fun"],
]);
const BINANCE_CRITICAL_AGENT_PRODUCT = /\b(?:binance\s+)?(?:agent\s*os|agent[- ]native|mcp(?:\s+server)?|model\s+context\s+protocol)\b/i;
const BINANCE_CRITICAL_PRODUCT_ACTION = /\b(?:meet|introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)?|unveil(?:s|ed|ing)?|releas(?:e|es|ed|ing)|roll(?:s|ed|ing)?\s+out|deploy(?:s|ed|ing)?|debut(?:s|ed|ing)?|is\s+now\s+(?:live|available)|now\s+(?:live|available)|general(?:ly)?\s+available|public\s+(?:beta|preview))\b/i;
const BINANCE_CRITICAL_NEW_PRODUCT = /\b(?:(?:new|next[- ]generation)\s+(?:binance\s+)?(?:product|platform|service|system|developer\s+platform|agent\s+platform|protocol|infrastructure|operating\s+system|wallet\s+architecture)|developer\s+platform\s+for\s+(?:ai\s+)?agents?)\b/i;
const BINANCE_CRITICAL_STRUCTURAL_OBJECT = /\b(?:developer\s+platform|agentic\s+wallet|mcp(?:\s+server)?|api\s+(?:platform|suite|gateway)|sdk|protocol|infrastructure|wallet\s+architecture|custody\s+(?:architecture|model)|account\s+(?:architecture|model)|isolated\s+(?:agentic\s+)?sub-?accounts?|permission\s+(?:architecture|model|system)|execution\s+engine|on[- ]chain\s+framework|payments?\s+rail|settlement\s+layer|emergency\s+stop)\b/i;
const BINANCE_CRITICAL_STRUCTURAL_ACTION = /\b(?:add(?:s|ed|ing)?|enabl(?:e|es|ed|ing)|support(?:s|ed|ing)?|connect(?:s|ed|ing)?|integrat(?:e|es|ed|ing)|upgrad(?:e|es|ed|ing)|replac(?:e|es|ed|ing)|migrat(?:e|es|ed|ing)|open(?:s|ed|ing)?|expand(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)?|releas(?:e|es|ed|ing)|now\s+supports?)\b/i;
const BINANCE_CRITICAL_X_NOISE = /(?:\b(?:campaign|competition|tournament|giveaway|airdrop|reward(?:s)?|voucher|promotion|referral|affiliate|apr|ama|livestream|webinar|sign[- ]?up\s+bonus|trade\s*(?:&|and)\s*win)\b|\b(?:will\s+list|will\s+delist|listed\s+on|token\s+listing|new\s+trading\s+pairs?|perpetual\s+contract|launchpool|megadrop|token\s+generation\s+event|\btge\b|meme\s+rush\s+token|tokenized\s+(?:stocks?|equities|securities)|equity\s+(?:issuance|offering)|stock\s+(?:issuance|offering))\b|\b(?:scheduled\s+maintenance|wallet\s+maintenance|network\s+upgrade|deposit(?:s)?\s+and\s+withdrawal(?:s)?|adjust(?:s|ed|ing)?\s+(?:leverage|margin|collateral|tick\s+size|fees?))\b)/i;

// This classifier deliberately does not reuse the broad Binance announcement
// policy.  It is the fail-closed lane that remains active when ordinary X
// monitoring is off, so only a product launch or a structural capability can
// pass; tokens, campaigns, trading activity and routine notices cannot.
export function classifyBinanceCriticalProductText(text = "") {
  const source = String(text || "").replace(/&amp;/gi, "&");
  const officialMarketSignal = classifyBinanceOfficialText(source);
  const priorityMarketLabels = new Set([
    "现货首次上币",
    "新合约上线",
    "Alpha 上新",
    "Launchpool/Megadrop 新币",
  ]);
  if (officialMarketSignal.relevant
    && officialMarketSignal.labels?.some((label) => priorityMarketLabels.has(label))) {
    return appendOfficialClaims({
      ...officialMarketSignal,
      strong: true,
      productStructural: true,
      criticalBinanceMarket: true,
      reason: "official_priority_listing_contract_or_alpha",
    }, source);
  }
  if (!source.trim() || BINANCE_CRITICAL_X_NOISE.test(source)) {
    return { relevant: false, strong: false, labels: [], reason: "marketing_token_trading_or_routine_noise" };
  }
  const agentProduct = BINANCE_CRITICAL_AGENT_PRODUCT.test(source);
  const productLaunch = BINANCE_CRITICAL_PRODUCT_ACTION.test(source)
    && (agentProduct || BINANCE_CRITICAL_NEW_PRODUCT.test(source));
  const structuralChange = BINANCE_CRITICAL_STRUCTURAL_ACTION.test(source)
    && BINANCE_CRITICAL_STRUCTURAL_OBJECT.test(source)
    && (agentProduct || /\b(?:binance|binance\s+wallet)\b/i.test(source));
  if (!productLaunch && !structuralChange) {
    return { relevant: false, strong: false, labels: [], reason: "not_a_major_binance_product_change" };
  }
  const labels = agentProduct
    ? ["Binance Agent OS/Agent Native/MCP"]
    : productLaunch ? ["Binance 重大新产品"] : ["Binance 重大结构功能"];
  return appendOfficialClaims({
    relevant: true,
    strong: true,
    productStructural: true,
    criticalBinanceProduct: true,
    labels,
    reason: agentProduct ? "official_agent_product_launch_or_structure" : productLaunch ? "official_major_product_launch" : "official_major_structural_feature",
  }, source);
}

export const OFFICIAL_TWITTER_TARGETS = [
  {
    id: "flap",
    name: "Flap",
    website: "https://flap.sh",
    docs: "https://docs.flap.sh/flap",
    twitter: "https://x.com/flapdotsh",
    handle: "flapdotsh",
    xUserId: "1749114887807320064",
    match: "official_x",
    priority: true,
    backfillOnFirstSeen: true,
    fallbackOfficialSources: [
      { name: "Flap 开发文档", url: "https://docs.flap.sh/flap", coveredBy: "platform-capability-monitor" },
      { name: "Flap 官方看板", url: "https://flap.sh/board", coveredBy: "platform-capability-monitor" },
      { name: "Flap GitHub", url: "https://github.com/flap-sh", coveredBy: "github-monitor" },
    ],
  },
  {
    id: "long",
    name: "Long",
    website: "https://app.long.xyz",
    twitter: "https://x.com/longdotxyz",
    handle: "longdotxyz",
    xUserId: "1877005968774397953",
    match: "official_x",
    priority: true,
    // Long has not published an official Morph contract yet. Start from the
    // current official cursor and alert only future structural/deployment news;
    // never replay its rotating stock-token catalogue as launch signals.
    baselineOnFirstSeen: true,
    fallbackOfficialSources: [
      { name: "Long 官网", url: "https://long.xyz", coveredBy: "morph-launchpad-monitor" },
      { name: "Long 应用", url: "https://app.long.xyz", coveredBy: "morph-launchpad-monitor" },
    ],
  },
  {
    id: "fourmeme",
    name: "Four.meme",
    website: "https://four.meme",
    twitter: "https://x.com/fourdotmemezh",
    handle: "fourdotmemezh",
    xUserId: "1816036559864619011",
    match: "official_x",
    priority: true,
    backfillOnFirstSeen: true,
    fallbackOfficialSources: [
      { name: "Four.Meme 公告", url: "https://four.meme/en/announcement", coveredBy: "platform-capability-monitor" },
      { name: "Four.Meme 产品配置", url: "https://four.meme/meme-api/v1/public/config", coveredBy: "platform-capability-monitor" },
    ],
  },
  {
    id: "ponfun",
    name: "pon.fun",
    website: "https://www.pon.fun",
    twitter: "https://x.com/pondotfun",
    handle: "pondotfun",
    xUserId: "2094048312772993024",
    match: "official_x",
    signalProfile: "pon_fun",
    priority: true,
    criticalFastLane: true,
    criticalProfile: "pon_fun",
    // The existing four posts establish identity and history only. Never replay
    // them during rollout; alert only tweets newer than this durable cursor.
    baselineOnFirstSeen: true,
    backfillOnFirstSeen: false,
    fallbackOfficialSources: [
      { name: "pon.fun official API", url: "https://www.pon.fun/api/health", coveredBy: "pon-monitor" },
      { name: "pon.fun Factory", url: "https://robinhoodchain.blockscout.com/address/0xF698d13348686C1529c2DC54847C123424d9DAE0", coveredBy: "pon-monitor" },
    ],
  },
  {
    id: "pons",
    name: "Pons",
    website: "https://ponsfamily.com",
    docs: "https://docs.ponsfamily.com",
    twitter: "https://x.com/ponsdotfamily",
    handle: "ponsdotfamily",
    match: "official_x",
    priority: false,
    backfillOnFirstSeen: true,
    fallbackOfficialSources: [
      { name: "Pons 官网", url: "https://ponsfamily.com", coveredBy: "site-monitor" },
      { name: "Pons 文档", url: "https://docs.ponsfamily.com", coveredBy: "pons-version-monitor" },
    ],
  },
  {
    id: "flypad-bsc",
    name: "FlyPad",
    website: "https://docs.flypad.app",
    docs: "https://docs.flypad.app/technical/detailed-feature-list",
    twitter: "https://x.com/flypad_app",
    handle: "flypad_app",
    match: "official_x",
    priority: false,
    baselineOnFirstSeen: true,
    fallbackOfficialSources: [
      { name: "FlyPad 技术文档", url: "https://docs.flypad.app/technical/detailed-feature-list", coveredBy: "site-monitor" },
      { name: "FlyPad AI/匿名发行文档", url: "https://docs.flypad.app/technical/ai-and-anonymous-launching", coveredBy: "site-monitor" },
    ],
  },
  {
    id: "bltx-bsc",
    name: "BLTX.FUN",
    website: "https://bltx.fun",
    docs: "https://bltx.fun/docs",
    twitter: "https://x.com/Bltxdotfun",
    handle: "Bltxdotfun",
    match: "official_x",
    priority: false,
    baselineOnFirstSeen: true,
    fallbackOfficialSources: [
      { name: "BLTX 官网", url: "https://bltx.fun", coveredBy: "site-monitor" },
      { name: "BLTX 文档", url: "https://bltx.fun/docs", coveredBy: "site-monitor" },
    ],
  },
  {
    id: "fabi-bsc",
    name: "Fabi 发币",
    website: "https://www.fabibsc.com",
    twitter: "https://x.com/FabiBsc",
    handle: "FabiBsc",
    match: "official_x",
    priority: false,
    baselineOnFirstSeen: true,
    fallbackOfficialSources: [
      { name: "Fabi 官网", url: "https://www.fabibsc.com", coveredBy: "site-monitor" },
    ],
  },
  {
    id: "eaglefun-bsc",
    name: "Eagle FUN / Eagle Launch",
    website: "https://eagleworld.fun",
    docs: "https://eagleworld.fun/docs",
    twitter: "https://x.com/EagleSwapHQ",
    handle: "EagleSwapHQ",
    match: "official_x",
    priority: false,
    baselineOnFirstSeen: true,
    fallbackOfficialSources: [
      { name: "Eagle FUN 官网", url: "https://eagleworld.fun", coveredBy: "site-monitor" },
      { name: "Eagle FUN 合约文档", url: "https://eagleworld.fun/docs", coveredBy: "site-monitor" },
    ],
  },
  {
    id: "onevone-bsc",
    name: "1V1MEME",
    website: "https://1v1me.me",
    docs: "https://github.com/1v1me-me/foundry",
    twitter: "https://x.com/1v1meme",
    handle: "1v1meme",
    match: "official_x",
    priority: false,
    baselineOnFirstSeen: true,
    fallbackOfficialSources: [
      { name: "1V1MEME 官网", url: "https://1v1me.me", coveredBy: "site-monitor" },
      { name: "1V1MEME 合约仓库", url: "https://github.com/1v1me-me/foundry", coveredBy: "github-monitor" },
    ],
  },
  {
    id: "bfun-bsc",
    name: "B.Fun",
    website: "https://b.fun",
    docs: "https://docs.b.fun",
    twitter: "https://x.com/BdotFun",
    handle: "BdotFun",
    match: "official_x",
    priority: false,
    baselineOnFirstSeen: true,
    fallbackOfficialSources: [
      { name: "B.Fun 开发文档", url: "https://docs.b.fun/for-developers/contracts-and-abi", coveredBy: "site-monitor" },
      { name: "B.Fun 官方工具仓库", url: "https://github.com/bfun-ai/bfun-ai", coveredBy: "github-monitor" },
    ],
  },
  {
    id: "singularry-bsc",
    name: "Singularry Launchpad",
    website: "https://launch.singularry.org",
    docs: "https://docs.singularry.org/launchpad/overview",
    twitter: "https://x.com/singularryai",
    handle: "singularryai",
    match: "official_x",
    priority: false,
    baselineOnFirstSeen: true,
    fallbackOfficialSources: [
      { name: "Singularry Launchpad", url: "https://launch.singularry.org", coveredBy: "site-monitor" },
      { name: "Singularry Launchpad 文档", url: "https://docs.singularry.org/launchpad/overview", coveredBy: "site-monitor" },
    ],
  },
  {
    id: "x",
    name: "X",
    website: "https://x.com",
    docs: "https://help.x.com/en/using-x",
    twitter: "https://x.com/X",
    handle: "X",
    xUserId: "783214",
    match: "official_x",
    priority: true,
    baselineOnFirstSeen: true,
    signalProfile: "ai",
    fallbackOfficialSources: [
      { name: "X API Changelog", url: "https://docs.x.com/changelog", coveredBy: "xai-official-monitor" },
    ],
  },
  {
    id: "xai",
    name: "xAI",
    website: "https://x.ai",
    docs: "https://docs.x.ai",
    twitter: "https://x.com/SpaceXAI",
    handle: "SpaceXAI",
    xUserId: "1661523610111193088",
    match: "official_x",
    priority: true,
    baselineOnFirstSeen: true,
    signalProfile: "ai",
    fallbackOfficialSources: [
      { name: "xAI News", url: "https://x.ai/news", coveredBy: "xai-official-monitor" },
      { name: "xAI Release Notes", url: "https://docs.x.ai/developers/release-notes", coveredBy: "xai-official-monitor" },
      { name: "xAI GitHub", url: "https://github.com/xai-org", coveredBy: "github-monitor" },
    ],
  },
  {
    id: "grok",
    name: "Grok",
    website: "https://grok.com",
    docs: "https://docs.x.ai",
    twitter: "https://x.com/grok",
    handle: "grok",
    xUserId: "1720665183188922368",
    match: "official_x",
    priority: true,
    baselineOnFirstSeen: true,
    signalProfile: "ai",
    fallbackOfficialSources: [
      { name: "xAI News", url: "https://x.ai/news", coveredBy: "xai-official-monitor" },
      { name: "xAI Release Notes", url: "https://docs.x.ai/developers/release-notes", coveredBy: "xai-official-monitor" },
    ],
  },
  {
    id: "x-api",
    name: "X API",
    website: "https://docs.x.com",
    docs: "https://docs.x.com/changelog",
    twitter: "https://x.com/API",
    handle: "API",
    xUserId: "6253282",
    match: "official_x",
    priority: true,
    baselineOnFirstSeen: true,
    signalProfile: "ai",
    fallbackOfficialSources: [
      { name: "X API Changelog", url: "https://docs.x.com/changelog", coveredBy: "xai-official-monitor" },
    ],
  },
  {
    id: "binance-wallet",
    name: "Binance Wallet",
    website: "https://web3.binance.com",
    twitter: "https://x.com/BinanceWallet",
    handle: "BinanceWallet",
    xUserId: "1400391752368992260",
    match: "official_x",
    priority: true,
    baselineOnFirstSeen: true,
    signalProfile: "binance",
    fallbackOfficialSources: [
      { name: "Binance 官方公告", url: "https://www.binance.com/en/support/announcement", coveredBy: "binance-monitor" },
      { name: "Binance Skills Hub", url: "https://www.binance.com/en/skills", coveredBy: "github-monitor" },
      { name: "Meme Rush 官方接口", url: "https://web3.binance.com", coveredBy: "binance-monitor" },
    ],
  },
  {
    id: "binance",
    name: "Binance",
    website: "https://www.binance.com",
    twitter: "https://x.com/binance",
    handle: "binance",
    xUserId: "877807935493033984",
    match: "official_x",
    priority: true,
    baselineOnFirstSeen: true,
    signalProfile: "binance",
    fallbackOfficialSources: [
      { name: "Binance 官方公告", url: "https://www.binance.com/en/support/announcement", coveredBy: "binance-monitor" },
      { name: "Binance Launchpool", url: "https://www.binance.com/en/launchpool", coveredBy: "binance-monitor" },
    ],
  },
  {
    id: "binance-futures",
    name: "Binance Futures",
    website: "https://www.binance.com/en/futures",
    twitter: "https://x.com/BinanceFutures",
    handle: "BinanceFutures",
    xUserId: "1426142483822518274",
    match: "official_x",
    priority: true,
    baselineOnFirstSeen: true,
    signalProfile: "binance",
    fallbackOfficialSources: [
      { name: "Binance 官方公告", url: "https://www.binance.com/en/support/announcement", coveredBy: "binance-monitor" },
      { name: "Binance Futures API 文档", url: "https://developers.binance.com/en/docs/derivatives", coveredBy: "binance-monitor" },
    ],
  },
  {
    id: "uniswap",
    name: "Uniswap",
    website: "https://app.uniswap.org",
    docs: "https://developers.uniswap.org",
    twitter: "https://x.com/Uniswap",
    handle: "Uniswap",
    xUserId: "984188226826010624",
    match: "official_x",
    priority: true,
    baselineOnFirstSeen: true,
    signalProfile: "uniswap",
    fallbackOfficialSources: [
      { name: "Uniswap 官方博客", url: "https://blog.uniswap.org/sitemap.xml", coveredBy: "uniswap-monitor" },
      { name: "Uniswap 官方 GitHub", url: "https://github.com/Uniswap", coveredBy: "github-monitor" },
      { name: "Uniswap 治理论坛", url: "https://gov.uniswap.org/latest.json", coveredBy: "uniswap-monitor" },
    ],
  },
  {
    id: "uniswap-pools",
    name: "Pools.trade",
    website: "https://pools.trade",
    docs: "https://developers.uniswap.org/docs/liquidity/liquidity-launchpad/",
    twitter: "https://x.com/TradePools",
    handle: "TradePools",
    xUserId: "2080394757721735168",
    match: "official_x",
    priority: true,
    baselineOnFirstSeen: true,
    signalProfile: "uniswap-pools",
    fallbackOfficialSources: [
      { name: "Pools.trade 官方页面", url: "https://pools.trade", coveredBy: "site-monitor" },
      { name: "Uniswap Liquidity Launcher", url: "https://github.com/Uniswap/liquidity-launcher", coveredBy: "github-monitor" },
    ],
  },
];

const DISABLED_TWITTER_HANDLES = new Set(["four_meme_"]);
const DEFAULT_BACKFILL_LIMIT = 8;
const DEFAULT_BACKFILL_SCAN_LIMIT = 40;
const DEFAULT_BACKFILL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_FAILURE_BACKOFF_MS = 15_000;
const MAX_FAILURE_BACKOFF_MS = 5 * 60 * 1_000;
const DEFAULT_RATE_LIMIT_BACKOFF_MS = 15 * 60 * 1_000;
const MAX_RATE_LIMIT_BACKOFF_MS = 60 * 60 * 1_000;
const DEFAULT_FAILURE_LOG_SUMMARY_INTERVAL_MS = 15 * 60 * 1_000;
const DEFAULT_TELEMETRY_PERSIST_INTERVAL_MS = 30_000;
const DEFAULT_STATE_WRITE_RETRY_MS = 1_000;
const DIRECT_X_BASE = "https://x.com/{handle}";
const FXTWITTER_TIMELINE_PATH = "/2/profile/id:{userId}/statuses?count=40";
const MIN_FXTWITTER_POLL_INTERVAL_MS = 5_000;
const OFFICIAL_X_OEMBED_BASE = "https://publish.x.com/oembed";
const BROWSER_USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36";

// These values do not move a tweet cursor or change delivery/circuit policy.
// Keep this allow-list narrow: every field not named here is durable control
// state. nextPollAt is intentionally a bounded scheduling hint; losing at most
// 30 seconds of it on a crash can cause one early startup probe, never a skip.
const TWITTER_TELEMETRY_FIELDS = new Set([
  "checkedAt",
  "lastAttemptAt",
  "lastSuccessAt",
  "lastErrorAt",
  "lastLatencyMs",
  "latencyMs",
  "responseTimeMs",
  "durationMs",
  "slaCheckedAt",
  "scheduledUntil",
  "nextPollAt",
  "timelineItems",
  "verifiedCandidates",
  "timeoutBudgetMs",
  "circuitClosedAt",
  "lastGapResolvedAt",
  "lastLoggedAt",
  "lastTransitionAt",
]);

function twitterControlValue(value) {
  if (Array.isArray(value)) return value.map(twitterControlValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !TWITTER_TELEMETRY_FIELDS.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, child]) => [key, twitterControlValue(child)]));
}

export function twitterStateControlKey(state = {}) {
  // Compare only Twitter's small cursor/health control plane. This deliberately
  // avoids hashing or serializing the complete state file on every fast tick.
  const accounts = Object.fromEntries(Object.entries(state)
    .filter(([key]) => key !== "_health" && key !== "_meta")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, record]) => [key, twitterControlValue(record)]));
  return JSON.stringify({
    accounts,
    health: twitterControlValue(state._health || {}),
    meta: twitterControlValue(state._meta || {}),
  });
}

export async function atomicWriteTwitterState(file, snapshot, fsImpl = fs, metadata = {}) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  const suffix = metadata.suffix
    || `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const temporary = `${file}.${suffix}.tmp`;
  const serialized = typeof snapshot === "string"
    ? snapshot
    : `${JSON.stringify(snapshot, null, 2)}\n`;
  try {
    await fsImpl.writeFile(temporary, serialized, { mode: 0o600 });
    await fsImpl.rename(temporary, file);
    // A pre-existing state file may have been created by an older version with
    // broader permissions. Enforce the final mode as well as the temp mode.
    await fsImpl.chmod?.(file, 0o600);
  } catch (error) {
    await fsImpl.rm?.(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export function twitterHandle(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  const match = trimmed.match(/(?:https?:\/\/(?:www\.)?(?:x|twitter)\.com\/|^@)([A-Za-z0-9_]{1,15})(?:\/|$)/i);
  const handle = match?.[1] || (/^[A-Za-z0-9_]{1,15}$/.test(trimmed) ? trimmed : null);
  return handle && !["home", "share", "intent", "search", "you", "i"].includes(handle.toLowerCase()) ? handle : null;
}

export function classifyTweet(text = "", profile = "launchpad") {
  if (profile === "binance") return classifyBinanceOfficialText(text);
  if (profile === "uniswap" || profile === "uniswap-pools") return classifyUniswapOfficialText(text);
  if (profile === "ai") return classifyAiOfficialText(text);
  const labels = SIGNALS.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  return { relevant: labels.length > 0, labels };
}

export function classifyFocusLaunchpadText(text = "") {
  const source = String(text || "");
  const labels = SIGNALS.filter(([, pattern]) => pattern.test(source)).map(([label]) => label);
  const quotePairChange = classifyFlapQuotePairSignalCore(source);
  if (quotePairChange) labels.push("税收/募资/报价代币");
  const bstockMention = /\bbstocks?\b/i.test(source);
  const detectedChainSupport = extractChainSupportSignals(source);
  // Official accounts also publish token competitions on a chain they already
  // use. A chain name next to "launched tokens" or a prize pool is not product
  // expansion; require an explicit platform-level support/deployment action.
  const chainSupport = FOCUS_PLATFORM_CHAIN_ACTION.test(source)
    && (!FOCUS_PROMOTIONAL_CAMPAIGN.test(source)
      || /\b(?:add(?:s|ed|ing)?\s+support|support(?:s|ed|ing)?|expand(?:s|ed|ing)?|integrat(?:e|es|ed|ing)?|(?:platform|launchpad|app)\s+(?:is\s+)?now\s+(?:live|available))\b/i.test(source))
    ? detectedChainSupport
    : [];
  if (chainSupport.length) labels.push("新增链支持");
  const charityMode = FOCUS_PLATFORM_CHARITY_MODE.test(source)
    && (FOCUS_PLATFORM_CHANGE_ACTION.test(source) || /\bTaxToken\d+\b/i.test(source));
  const agentSkillIntegration = FOCUS_PLATFORM_AGENT_SKILL.test(source)
    && !FOCUS_PROMOTIONAL_CAMPAIGN.test(source);
  if (agentSkillIntegration) labels.push("Agent/Skill 集成");
  const platformStructural = Boolean(quotePairChange) || chainSupport.length > 0 || charityMode || agentSkillIntegration || (!bstockMention && labels.length > 0 && (
    FOCUS_PLATFORM_EXPLICIT_OBJECT.test(source)
    || FOCUS_PLATFORM_VERSION.test(source)
    || (FOCUS_PLATFORM_SUBSCRIPTION.test(source) && FOCUS_PLATFORM_CHANGE_ACTION.test(source))
    || (FOCUS_PLATFORM_COMPONENT.test(source) && FOCUS_PLATFORM_CHANGE_ACTION.test(source))
  ));
  return appendOfficialClaims({
    relevant: platformStructural,
    strong: platformStructural,
    platformStructural,
    labels: platformStructural ? [...new Set(labels)] : [],
    ...(quotePairChange ? { quotePairChange } : {}),
    ...(chainSupport.length ? { chainSupport } : {}),
    reason: quotePairChange
      ? `flap_bstock_quote_pair_${quotePairChange.stage}`
      : chainSupport.length
        ? "new_chain_support"
        : charityMode
          ? "charity_donation_tax_mode"
          : agentSkillIntegration
            ? "agentic_skill_integration"
            : platformStructural
              ? "platform_structural_change"
              : "ordinary_token_or_non_structural_post",
  }, source);
}

export function classifyFourMemeOfficialText(text = "") {
  return classifyFourMemeOfficialSignalCore(text) || classifyFocusLaunchpadText(text);
}

function classifyProjectTweet(text, project, config, expandedUrls = []) {
  const ponEvidenceText = [text, ...(Array.isArray(expandedUrls) ? expandedUrls : [])].filter(Boolean).join("\n");
  if (project?.criticalFastLane) {
    if (project.criticalProfile === "binance_product") return classifyBinanceCriticalProductText(text);
    if (project.criticalProfile === "focus_launchpad") {
      return project.id === "fourmeme" ? classifyFourMemeOfficialText(text) : classifyFocusLaunchpadText(text);
    }
    if (project.criticalProfile === "pon_fun") return classifyPonFunOfficialText(ponEvidenceText);
    return { relevant: false, strong: false, labels: [], reason: "unknown_critical_x_profile" };
  }
  if (project?.id === "ponfun") return classifyPonFunOfficialText(ponEvidenceText);
  if (isThreePlatformScope(config) && ["flap", "fourmeme", "long"].includes(project?.id)) {
    return project.id === "fourmeme" ? classifyFourMemeOfficialText(text) : classifyFocusLaunchpadText(text);
  }
  return classifyTweet(text, project?.signalProfile);
}

export function parseTimelineHtml(html, expectedHandle) {
  const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (!match) throw new Error("X timeline JSON missing");
  const data = JSON.parse(match[1]);
  const entries = data?.props?.pageProps?.timeline?.entries || [];
  return entries.filter((entry) => entry.type === "tweet").map((entry) => {
    const tweet = entry.content?.tweet || {};
    const handle = tweet.user?.screen_name || expectedHandle;
    const authorId = tweet.user?.id_str || (tweet.user?.id === undefined || tweet.user?.id === null ? null : String(tweet.user.id));
    const expandedUrls = (tweet.entities?.urls || []).map((item) => item.expanded_url || item.unwound_url || item.url).filter(Boolean);
    const id = tweet.id_str || entry.entry_id?.replace(/^tweet-/, "");
    const rawUrl = tweet.permalink || "";
    const url = /^https:\/\//i.test(rawUrl)
      ? rawUrl
      : rawUrl.startsWith("/")
        ? `https://x.com${rawUrl}`
        : `https://x.com/${handle}/status/${id}`;
    return {
      id,
      text: tweet.full_text || tweet.text || "",
      createdAt: tweet.created_at || null,
      authorName: tweet.user?.name || handle,
      handle,
      ...(authorId ? { xUserId: authorId, authorId } : {}),
      replies: tweet.reply_count || 0,
      reposts: tweet.retweet_count || 0,
      likes: tweet.favorite_count || 0,
      url,
      isReply: Boolean(tweet.in_reply_to_status_id_str),
      ...(expandedUrls.length ? { expandedUrls } : {}),
    };
  }).filter((tweet) => tweet.id);
}

function exactStatusUrl(value, expectedHandle, expectedId) {
  try {
    const url = new URL(String(value || ""));
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const match = url.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/(\d+)\/?$/);
    return ["x.com", "twitter.com"].includes(host)
      && match?.[1]?.toLowerCase() === String(expectedHandle || "").toLowerCase()
      && match?.[2] === String(expectedId || "");
  } catch {
    return false;
  }
}

export function parseFxTwitterTimeline(input, expectedHandle, expectedUserId) {
  const payload = typeof input === "string" ? JSON.parse(input) : input;
  const expectedId = String(expectedUserId || "");
  const expected = String(expectedHandle || "").replace(/^@/, "").toLowerCase();
  if (Number(payload?.code) !== 200 || !expectedId || !expected || !Array.isArray(payload?.results)) {
    throw new Error("FxTwitter timeline schema or immutable identity missing");
  }
  const tweets = [];
  for (const item of payload.results) {
    const authorId = String(item?.author?.id || "");
    const authorHandle = String(item?.author?.screen_name || "").replace(/^@/, "");
    const repostedById = String(item?.reposted_by?.id || "");
    if (repostedById) {
      if (repostedById !== expectedId) throw new Error(`FxTwitter repost identity mismatch for @${expectedHandle}`);
      continue;
    }
    if (authorId !== expectedId || authorHandle.toLowerCase() !== expected) {
      throw new Error(`FxTwitter immutable identity mismatch for @${expectedHandle}`);
    }
    const id = String(item?.id || "");
    if (!/^\d+$/.test(id) || !exactStatusUrl(item?.url, expectedHandle, id)) {
      throw new Error(`FxTwitter canonical status mismatch for @${expectedHandle}`);
    }
    const createdTimestamp = Number(item?.created_timestamp);
    const createdAt = Number.isFinite(createdTimestamp) && createdTimestamp > 0
      ? new Date(createdTimestamp * 1_000).toISOString()
      : snowflakeTimestamp(id);
    const expandedUrls = (item?.raw_text?.facets || [])
      .filter((facet) => facet?.type === "url" && /^https?:\/\//i.test(String(facet?.replacement || "")))
      .map((facet) => facet.replacement);
    tweets.push({
      id,
      text: String(item?.text || item?.raw_text?.text || ""),
      createdAt,
      authorName: String(item?.author?.name || authorHandle),
      handle: authorHandle,
      xUserId: authorId,
      authorId,
      replies: Number.isFinite(Number(item?.replies)) ? Number(item.replies) : null,
      reposts: Number.isFinite(Number(item?.reposts)) ? Number(item.reposts) : null,
      likes: Number.isFinite(Number(item?.likes)) ? Number(item.likes) : null,
      url: `https://x.com/${authorHandle}/status/${id}`,
      isReply: item?.replying_to !== null && item?.replying_to !== undefined,
      ...(expandedUrls.length ? { expandedUrls: [...new Set(expandedUrls)] } : {}),
    });
  }
  return tweets;
}

export function parseFxTwitterExactStatus(input, expectedHandle, expectedUserId, expectedTweetId) {
  const payload = typeof input === "string" ? JSON.parse(input) : input;
  const tweet = payload?.tweet;
  const expected = String(expectedHandle || "").replace(/^@/, "").toLowerCase();
  const expectedId = String(expectedUserId || "");
  const expectedStatusId = String(expectedTweetId || "");
  const authorHandle = String(tweet?.author?.screen_name || "").replace(/^@/, "");
  const authorId = String(tweet?.author?.id || "");
  const id = String(tweet?.id || "");
  if (Number(payload?.code) !== 200 || !tweet || !expected || !expectedId || !/^\d+$/.test(expectedStatusId)) {
    throw new Error("FxTwitter exact-status schema or expected identity missing");
  }
  if (id !== expectedStatusId
    || authorId !== expectedId
    || authorHandle.toLowerCase() !== expected
    || !exactStatusUrl(tweet.url, expectedHandle, expectedStatusId)
    || tweet.reposted_by
    || (tweet.replying_to !== null && tweet.replying_to !== undefined)) {
    throw new Error(`FxTwitter exact-status identity mismatch for @${expectedHandle}/status/${expectedStatusId}`);
  }
  const text = String(tweet.text || tweet.raw_text?.text || "").trim();
  if (!text) throw new Error(`FxTwitter exact-status text missing for @${expectedHandle}/status/${expectedStatusId}`);
  const createdTimestamp = Number(tweet.created_timestamp);
  const createdAt = Number.isFinite(createdTimestamp) && createdTimestamp > 0
    ? new Date(createdTimestamp * 1_000).toISOString()
    : snowflakeTimestamp(id);
  const expandedUrls = (tweet.raw_text?.facets || [])
    .filter((facet) => facet?.type === "url" && /^https?:\/\//i.test(String(facet?.replacement || "")))
    .map((facet) => facet.replacement);
  return {
    id,
    text,
    createdAt,
    authorName: String(tweet.author?.name || authorHandle),
    handle: authorHandle,
    xUserId: authorId,
    authorId,
    replies: Number.isFinite(Number(tweet.replies)) ? Number(tweet.replies) : null,
    reposts: Number.isFinite(Number(tweet.retweets ?? tweet.reposts)) ? Number(tweet.retweets ?? tweet.reposts) : null,
    likes: Number.isFinite(Number(tweet.likes)) ? Number(tweet.likes) : null,
    url: `https://x.com/${authorHandle}/status/${id}`,
    isReply: false,
    ...(expandedUrls.length ? { expandedUrls: [...new Set(expandedUrls)] } : {}),
  };
}

function decodeOembedText(value) {
  return String(value || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_match, href, label) => (
      /pic\.(?:twitter|x)\.com/i.test(label) ? "" : href
    ))
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, number) => String.fromCodePoint(Number(number)))
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

export function parseOfficialXOembed(input, expectedHandle, expectedId) {
  const payload = typeof input === "string" ? JSON.parse(input) : input;
  const expectedProfile = `https://x.com/${expectedHandle}`.toLowerCase();
  if (String(payload?.author_url || "").replace(/\/$/, "").toLowerCase() !== expectedProfile
    || !exactStatusUrl(payload?.url, expectedHandle, expectedId)) {
    throw new Error(`official X oEmbed identity mismatch for @${expectedHandle}/status/${expectedId}`);
  }
  const block = String(payload?.html || "").match(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/i)?.[1] || "";
  const paragraph = block.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] || "";
  const statusLinks = [...block.matchAll(/href=["'](https:\/\/(?:x|twitter)\.com\/[^"']+\/status\/\d+[^"']*)["']/ig)]
    .map((match) => match[1].replace(/\?[^#]*/, ""));
  if (!statusLinks.some((url) => exactStatusUrl(url, expectedHandle, expectedId))) {
    throw new Error(`official X oEmbed canonical link missing for @${expectedHandle}/status/${expectedId}`);
  }
  const text = decodeOembedText(paragraph);
  if (!text) throw new Error(`official X oEmbed text missing for @${expectedHandle}/status/${expectedId}`);
  return text;
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function snowflakeTimestamp(id) {
  try {
    return new Date(Number((BigInt(id) >> 22n) + 1_288_834_974_657n)).toISOString();
  } catch {
    return null;
  }
}

function isCriticalTweetFresh(tweet, currentTime, maximumAgeMs) {
  const publishedAt = Date.parse(tweet?.createdAt || snowflakeTimestamp(tweet?.id) || "");
  const ageMs = Number.isFinite(publishedAt) ? currentTime - publishedAt : Number.POSITIVE_INFINITY;
  return ageMs >= -5 * 60 * 1_000 && ageMs < maximumAgeMs;
}

function jinaTweetText(block, statusMatch, expectedHandle) {
  const statusLinkEnd = block.indexOf(")", statusMatch.index + statusMatch[0].length);
  if (statusLinkEnd < 0) return "";
  let statusLinkStart = block.lastIndexOf("[", statusMatch.index);
  const linkPrefix = block.slice(Math.max(0, statusLinkStart), statusMatch.index);
  const linkSuffix = block.slice(statusMatch.index + statusMatch[0].length, statusLinkEnd);
  const mediaStatusLink = /!\[[^\]]*$/i.test(linkPrefix) || /\/(?:photo|video)\//i.test(linkSuffix);
  if (mediaStatusLink) {
    const imageLinkStart = block.lastIndexOf("[![", statusMatch.index);
    if (imageLinkStart >= 0) statusLinkStart = imageLinkStart;
  }
  let text;
  if (mediaStatusLink) {
    const prefix = block.slice(0, statusLinkStart >= 0 ? statusLinkStart : statusMatch.index);
    const profileClosePattern = new RegExp(`\\]\\(https?:\\/\\/(?:www\\.)?(?:x|twitter)\\.com\\/${regexEscape(expectedHandle)}\\/?\\)`, "ig");
    let profileEnd = 0;
    for (const match of prefix.matchAll(profileClosePattern)) profileEnd = match.index + match[0].length;
    text = prefix.slice(profileEnd);
  } else {
    text = block.slice(statusLinkEnd + 1);
    const mediaIndex = [text.indexOf("[![Image"), text.indexOf("![Image")].filter((index) => index >= 0).sort((a, b) => a - b)[0];
    if (mediaIndex !== undefined) text = text.slice(0, mediaIndex);
  }
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s*(?:Show more|·)+\s*/i, "")
    .replace(/\n\s*(?:\d+(?:\.\d+)?[KMB]?\s*){2,}$/i, "")
    .replace(/\\([_*`])/g, "$1")
    .replace(/^\s*\*\s*/, "")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function jinaExpandedUrls(block, expectedHandle) {
  const values = [];
  for (const match of block.matchAll(/\]\((https?:\/\/[^)\s]+)[^)]*\)/ig)) {
    try {
      const url = new URL(match[1]);
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (["x.com", "twitter.com"].includes(host)) continue;
      if (host === "pbs.twimg.com" || host === "abs.twimg.com") continue;
      values.push(url.href);
    } catch { /* Ignore malformed Reader links. */ }
  }
  return [...new Set(values)];
}

export function parseJinaReaderContent(content, expectedHandle, { includePinned = false } = {}) {
  if (typeof content !== "string") throw new Error("Jina Reader schema: data.content must be a string");
  const escapedHandle = regexEscape(expectedHandle);
  const profilePattern = new RegExp(`https?:\\/\\/(?:www\\.)?(?:x|twitter)\\.com\\/${escapedHandle}(?:[/?#)]|$)`, "i");
  const statusPattern = new RegExp(`https?:\\/\\/(?:www\\.)?(?:x|twitter)\\.com\\/${escapedHandle}\\/status\\/(\\d+)`, "ig");
  const tweets = [];
  const seen = new Set();
  for (const rawBlock of content.split(/\n(?=\s*\*\s)/)) {
    const block = rawBlock.split(/\n## Log in or sign up for X\b/i)[0];
    if (!profilePattern.test(block) || (!includePinned && /^\s*\*\s*Pinned\b/i.test(block))) continue;
    statusPattern.lastIndex = 0;
    const statusMatch = statusPattern.exec(block);
    if (!statusMatch || seen.has(statusMatch[1])) continue;
    const id = statusMatch[1];
    const text = jinaTweetText(block, statusMatch, expectedHandle);
    if (!text) continue;
    seen.add(id);
    const expandedUrls = jinaExpandedUrls(block, expectedHandle);
    tweets.push({
      id,
      text,
      createdAt: snowflakeTimestamp(id),
      authorName: expectedHandle,
      handle: expectedHandle,
      replies: null,
      reposts: null,
      likes: null,
      url: `https://x.com/${expectedHandle}/status/${id}`,
      isReply: /\bReplying to\s+@/i.test(block),
      ...(expandedUrls.length ? { expandedUrls } : {}),
    });
  }
  return tweets;
}

export function parseJinaReaderPayload(input, expectedHandle, options = {}) {
  const payload = typeof input === "string" ? JSON.parse(input) : input;
  return parseJinaReaderContent(payload?.data?.content, expectedHandle, options);
}

// X's public SSR can change presentation details without changing the
// canonical status anchors. Critical discovery treats these IDs as untrusted
// hints only; Fx exact-status and official oEmbed must both verify each ID
// before any item is merged or classified.
export function parseCriticalXDirectDiscovery(html, expectedHandle) {
  const handle = String(expectedHandle || "").replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle) || typeof html !== "string") return [];
  const escaped = regexEscape(handle);
  const pattern = new RegExp(`data-href=["']\/${escaped}\/status\/(\\d+)["'][^>]*>\\s*<article\\b[^>]*\\bdata-tweet-id=["']\\1["']`, "gi");
  const tweets = [];
  const seen = new Set();
  for (const match of html.matchAll(pattern)) {
    const id = match[1];
    if (seen.has(id)) continue;
    seen.add(id);
    tweets.push({
      id,
      text: "",
      createdAt: snowflakeTimestamp(id),
      authorName: handle,
      handle,
      replies: null,
      reposts: null,
      likes: null,
      url: `https://x.com/${handle}/status/${id}`,
      isReply: false,
      discoveredBy: "x_direct_profile",
    });
  }
  return tweets;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function criticalLatencySettings(config) {
  // One non-extendable budget starts with the critical scheduler cycle and is
  // handed to sendAlerts. A conservative one-second allowance accounts for a
  // post appearing just after the previous source attempt; the current cycle
  // must finish within the remaining four seconds without backdating startedAt.
  const localBudgetMs = Math.min(5_000, Math.max(2_000, positiveInteger(config.binanceCriticalXLocalBudgetMs, 5_000)));
  const pollAllowanceMs = Math.min(
    1_000,
    Math.max(100, positiveInteger(config.binanceCriticalXPollAllowanceMs, 1_000)),
  );
  const attemptBudgetMs = Math.max(1_000, localBudgetMs - pollAllowanceMs);
  const deliveryReserveMs = Math.min(750, Math.max(250, Math.floor(attemptBudgetMs / 5)));
  const minimumVerifyReserveMs = 500;
  const schedulerIntervalMs = Math.min(
    positiveInteger(config.binanceCriticalXSchedulerIntervalMs, 250),
    1_000,
  );
  const discoveryIntervalMs = Math.min(
    positiveInteger(config.binanceCriticalXDiscoveryIntervalMs, 500),
    1_000,
  );
  const networkBudgetMs = Math.max(1_000, attemptBudgetMs - deliveryReserveMs);
  const discoveryTimeoutMs = Math.min(
    positiveInteger(config.binanceCriticalXDiscoveryTimeoutMs, 2_000),
    Math.max(500, networkBudgetMs - minimumVerifyReserveMs),
  );
  // This is a ceiling, not a pre-reserved fixed slice. A fast discovery can
  // use more verification time; a slow discovery receives only what remains
  // before the same delivery deadline.
  const verifyTimeoutMs = Math.min(
    positiveInteger(config.binanceCriticalXVerifyTimeoutMs, 1_750),
    Math.max(500, networkBudgetMs),
  );
  return {
    localBudgetMs,
    pollAllowanceMs,
    attemptBudgetMs,
    deliveryReserveMs,
    minimumVerifyReserveMs,
    schedulerIntervalMs,
    discoveryIntervalMs,
    discoveryTimeoutMs,
    verifyTimeoutMs,
  };
}

function isCriticalFastLane(project) {
  return project?.criticalFastLane === true;
}

function isPonFunFastLane(project) {
  return project?.id === "ponfun" && project?.criticalProfile === "pon_fun";
}

function isCanonicalXStatusId(value) {
  return /^[1-9]\d{5,}$/.test(String(value || ""));
}

function ponFunRecoveryGapSince(health, previous, currentTime, maximumAgeMs) {
  const explicitGap = Date.parse(health?.gapSince || "");
  if (Number.isFinite(explicitGap)) return new Date(explicitGap).toISOString();
  const checkpoint = Date.parse(health?.lastSuccessAt || previous?.checkedAt || "");
  if (!Number.isFinite(checkpoint) || currentTime - checkpoint <= maximumAgeMs) return null;
  return new Date(checkpoint).toISOString();
}

function ponFunDelayedRecovery(signal, tweet, previous, gapSince, observedAt, maximumAgeMs) {
  const sourceOccurredAtMs = Date.parse(tweet?.createdAt || "");
  const recoveredAtMs = Date.parse(observedAt || "");
  const lagMs = Number.isFinite(sourceOccurredAtMs) && Number.isFinite(recoveredAtMs)
    ? Math.max(0, recoveredAtMs - sourceOccurredAtMs)
    : null;
  if (!gapSince
    || !Number.isSafeInteger(lagMs)
    || lagMs <= Math.max(maximumAgeMs, FOCUS_CRITICAL_X_MAX_AGE_MS)
    || signal?.ponPriority !== "T1"
    || signal?.majorProductUpdate !== true
    || signal?.platformStructural !== true
    || !isCanonicalXStatusId(previous?.latestId)) return null;
  return {
    version: 1,
    reason: "monitoring_gap_recovery",
    gapSince,
    sourceOccurredAt: tweet.createdAt,
    recoveredAt: observedAt,
    lagMs,
    cursor: {
      latestIdAtRecovery: previous.latestId,
      tweetId: tweet.id,
    },
  };
}

function criticalTweetMaxAgeMs(config, project) {
  if (isPonFunFastLane(project)) return FOCUS_CRITICAL_X_MAX_AGE_MS;
  return project?.criticalProfile === "binance_product"
    ? positiveInteger(config.binanceCriticalXMaxAgeMs, BINANCE_CRITICAL_X_MAX_AGE_MS)
    : positiveInteger(config.focusCriticalXMaxAgeMs, FOCUS_CRITICAL_X_MAX_AGE_MS);
}

function timestamp(now) {
  return new Date(now()).toISOString();
}

function compareTweetIds(left, right) {
  try {
    const a = BigInt(left);
    const b = BigInt(right);
    return a === b ? 0 : a < b ? -1 : 1;
  } catch {
    return String(left).localeCompare(String(right), "en", { numeric: true });
  }
}

export function classifyTwitterAlertDelivery(result, { strictPonFun = false } = {}) {
  // A large body of monitor unit tests predates structured delivery receipts.
  // Keep undefined/truthy primitive mocks compatible; production sendAlerts
  // always returns a status object and therefore follows the strict branches.
  if (result === undefined) return strictPonFun ? "retry" : "accepted";
  if (result === false || result === null) return "retry";
  if (typeof result !== "object") return strictPonFun ? "retry" : result ? "accepted" : "retry";
  if (["delivered", "queued"].includes(String(result.status || "").toLowerCase())) return "accepted";
  const reason = String(result.reason || result.disabledReason || "").toLowerCase();
  if (String(result.status || "").toLowerCase() === "suppressed" && /semantic[_ -]duplicate/.test(reason)) {
    return "semantic_duplicate";
  }
  if (strictPonFun) {
    return String(result.status || "").toLowerCase() === "suppressed"
      && reason === "blocked_event"
      && isTerminalAlertSuppression(result)
      ? "accepted"
      : "retry";
  }
  if (isTerminalAlertSuppression(result)) return "accepted";
  return "retry";
}

function retryAfterMs(response, now) {
  const current = now();
  const candidates = [];
  const value = response.headers.get("retry-after");
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds > 0) candidates.push(seconds * 1_000);
  else {
    const date = Date.parse(value || "");
    if (Number.isFinite(date) && date > current) candidates.push(date - current);
  }
  const resetSeconds = Number(response.headers.get("x-rate-limit-reset"));
  if (Number.isFinite(resetSeconds) && resetSeconds > 0) candidates.push(resetSeconds * 1_000 - current);
  const requested = candidates.filter((duration) => duration > 0).reduce((maximum, duration) => Math.max(maximum, duration), 0);
  return Math.min(MAX_RATE_LIMIT_BACKOFF_MS, Math.max(DEFAULT_RATE_LIMIT_BACKOFF_MS, requested));
}

function sourceBases(config, project) {
  const fallback = Array.isArray(config.twitterFallbackApiBases)
    ? config.twitterFallbackApiBases
    : String(config.twitterFallbackApiBases || "").split(",");
  // The critical fast lane uses X SSR as an untrusted discovery feed in parallel
  // with Jina. Keeping it out of the primary identity list prevents a layout
  // change from delaying the numeric-ID Fx lane.
  const direct = config.twitterDirectXEnabled === true && project?.xUserId && !isCriticalFastLane(project) ? [DIRECT_X_BASE] : [];
  const fxTwitter = config.twitterFxTwitterEnabled === true && project?.xUserId && config.twitterFxTwitterApiBase
    ? [`${String(config.twitterFxTwitterApiBase).trim().replace(/\/$/, "")}${FXTWITTER_TIMELINE_PATH}`]
    : [];
  const identitySafeFallback = (project?.signalProfile === "ai" || isCriticalFastLane(project))
    ? fallback.filter((item) => !isJinaReaderSource(String(item || "")))
    : fallback;
  // The critical lane accepts only a numeric-ID Fx timeline followed by
  // official oEmbed, or the separately dual-verified discovery path below.
  // A generic syndication fallback is not sufficient identity evidence.
  if (isCriticalFastLane(project)) return fxTwitter;
  return [...new Set([...fxTwitter, ...direct, config.twitterApiBase, ...identitySafeFallback].map((item) => String(item || "").trim().replace(/\/$/, "")).filter(Boolean))];
}

function criticalJinaDiscoveryBases(config) {
  const fallback = Array.isArray(config.twitterFallbackApiBases)
    ? config.twitterFallbackApiBases
    : String(config.twitterFallbackApiBases || "").split(",");
  // The x.com Reader route currently returns 403 for this account. Keep the
  // cross-scan pinned to the working canonical twitter.com profile route and
  // never put it into the ordinary identity-bearing source list.
  return [...new Set(fallback
    .map((item) => String(item || "").trim().replace(/\/$/, ""))
    .filter((item) => /^https:\/\/r\.jina\.ai\/https:\/\/twitter\.com\/\{handle\}$/i.test(item)))];
}

function criticalDiscoverySources(config, project) {
  return [
    ...(config.twitterDirectXEnabled === true && project?.xUserId
      ? [{ base: DIRECT_X_BASE, kind: "x_direct_profile" }]
      : []),
    ...criticalJinaDiscoveryBases(config).map((base) => ({ base, kind: "jina_twitter_profile" })),
  ];
}

function sourceUrl(base, project) {
  const handle = typeof project === "string" ? project : project?.handle;
  const userId = typeof project === "object" ? project?.xUserId : null;
  if (base.includes("{userId}")) return base.replaceAll("{userId}", encodeURIComponent(String(userId || "")));
  return base.includes("{handle}") ? base.replaceAll("{handle}", encodeURIComponent(handle)) : `${base}/${encodeURIComponent(handle)}`;
}

function isJinaReaderSource(base) {
  return /^https:\/\/r\.jina\.ai\/https?:\/\/(?:x|twitter)\.com\//i.test(base);
}

function isDirectXSource(base) {
  return base === DIRECT_X_BASE;
}

function isFxTwitterSource(base) {
  return /\/2\/profile\/id:\{userId\}\/statuses\?count=\d+$/i.test(base);
}

function sourceAttemptAt(source = {}) {
  const parsed = (value) => {
    const time = Date.parse(value || "");
    return Number.isFinite(time) ? time : 0;
  };
  return Math.max(
    parsed(source.circuitUntil),
    parsed(source.retryAfter),
    parsed(source.nextPollAt),
  );
}

const isTransportFailure = (value) => /fetch failed|network|timed?\s*out|timeout|aborted|eaddrnotavail|econn(?:reset|refused|aborted)|socket/i
  .test(String(value?.message || value || ""));

function sourceAvailable(health, base, currentTime, startupRecoveryProbe = false) {
  const source = health.sources?.[base];
  const circuitUntil = Date.parse(source?.circuitUntil || "");
  // New source circuits are durable by design. Keep the one-time startup
  // transport probe only for legacy state written before circuitUntil existed.
  if (Number.isFinite(circuitUntil) && circuitUntil > currentTime) return false;
  return sourceAttemptAt(source) <= currentTime
    || (startupRecoveryProbe && !source?.circuitUntil && isTransportFailure(source?.lastError));
}

function hasAvailableSource(health, bases, currentTime, startupRecoveryProbe = false) {
  return bases.some((base) => sourceAvailable(health, base, currentTime, startupRecoveryProbe));
}

function hasAvailableCriticalDiscoverySource(config, project, health, currentTime, startupRecoveryProbe = false) {
  return isCriticalFastLane(project)
    && criticalDiscoverySources(config, project)
      .some(({ base }) => sourceAvailable(health, base, currentTime, startupRecoveryProbe));
}

function updateCriticalSlaStatus(config, project, health, currentTime) {
  if (!isCriticalFastLane(project)) return;
  const discovery = criticalDiscoverySources(config, project);
  const limitedDiscovery = discovery.filter(({ base }) => health.sources?.[base]?.status !== "healthy");
  const fxBase = sourceBases(config, project)[0] || null;
  const fxStatus = fxBase ? health.sources?.[fxBase]?.status || "unknown" : "disabled";
  const reasons = [];
  if (!discovery.length) reasons.push("no_public_discovery_source_configured");
  if (limitedDiscovery.length) {
    reasons.push(`public_discovery_limited:${limitedDiscovery.map(({ kind }) => kind).join(",")}`);
  }
  if (fxStatus !== "healthy") reasons.push(`numeric_identity_timeline:${fxStatus}`);
  if (health.criticalVerification?.status === "error") reasons.push("dual_verification:error");
  health.slaStatus = reasons.length ? "source_limited" : "best_effort";
  health.slaStatusReason = reasons.join(";") || "external_publication_and_delivery_latency_not_hard_guaranteed";
  health.slaHardGuarantee = false;
  health.slaCheckedAt = new Date(currentTime).toISOString();
}

function targetList(dynamic, siteState, config) {
  const targets = new Map();
  const criticalOnly = config.twitterMonitorEnabled === false
    && (config.binanceCriticalXMonitorEnabled === true
      || config.focusCriticalXMonitorEnabled === true
      || config.ponMonitorEnabled === true);
  const enabledCriticalProfiles = new Map(
    [...CRITICAL_X_TARGET_PROFILES].filter(([handle, profile]) => (
      profile === "binance_product"
        ? config.binanceCriticalXMonitorEnabled === true
        : profile === "pon_fun"
          ? config.ponMonitorEnabled === true
          : config.focusCriticalXMonitorEnabled === true
    )),
  );
  const projects = criticalOnly
    ? OFFICIAL_TWITTER_TARGETS
      .filter((project) => enabledCriticalProfiles.has(project.handle.toLowerCase()))
      .map((project) => ({
        ...project,
        criticalFastLane: true,
        criticalProfile: enabledCriticalProfiles.get(project.handle.toLowerCase()),
        priority: true,
        backfillOnFirstSeen: false,
        baselineOnFirstSeen: true,
      }))
    : [
        ...monitoredLaunchpads(),
        ...PLATFORM_CAPABILITY_TARGETS,
        ...(isThreePlatformScope(config) ? [] : dynamic),
        ...OFFICIAL_TWITTER_TARGETS,
      ];

  const add = (project, handle, overrides = {}) => {
    const key = handle.toLowerCase();
    if (DISABLED_TWITTER_HANDLES.has(key)) return;
    const existing = targets.get(key) || {};
    targets.set(key, {
      ...existing,
      ...project,
      ...overrides,
      handle,
      priority: Boolean(existing.priority || project.priority || overrides.priority),
      backfillOnFirstSeen: Boolean(existing.backfillOnFirstSeen || project.backfillOnFirstSeen || overrides.backfillOnFirstSeen),
      fallbackOfficialSources: project.fallbackOfficialSources || existing.fallbackOfficialSources || [],
    });
  };

  for (const project of projects) {
    if (!project || typeof project !== "object" || !isMonitoringSourceEnabled(config, project)) continue;
    const handle = twitterHandle(project.twitter);
    if (handle) add(project, handle);
    for (const social of isThreePlatformScope(config) ? [] : (siteState[project.id]?.signals?.socials || [])) {
      const discoveredHandle = twitterHandle(social);
      if (discoveredHandle) {
        add({ ...project, priority: false, backfillOnFirstSeen: false }, discoveredHandle, { twitter: social, match: "website_discovery" });
      }
    }
  }
  return [...targets.values()];
}

function firstSeenPlan(tweets, config, now, classify = (text) => classifyTweet(text)) {
  const limit = positiveInteger(config.twitterBackfillLimit, DEFAULT_BACKFILL_LIMIT);
  const scanLimit = positiveInteger(config.twitterBackfillScanLimit, DEFAULT_BACKFILL_SCAN_LIMIT);
  const maxAgeMs = positiveInteger(config.twitterBackfillMaxAgeMs, DEFAULT_BACKFILL_MAX_AGE_MS);
  const scanned = tweets.slice(0, scanLimit);
  const scannedRelevant = scanned.filter((tweet) => classify(tweet.text).relevant);
  const eligible = scanned.filter((tweet) => {
    const createdAt = Date.parse(tweet.createdAt || "");
    return !Number.isFinite(createdAt) || now() - createdAt <= maxAgeMs;
  });
  const relevant = eligible.filter((tweet) => classify(tweet.text).relevant);
  const selected = relevant.slice(0, limit);
  const commonCoverage = {
    scanned: scanned.length,
    relevant: relevant.length,
    outsideWindowRelevant: Math.max(0, scannedRelevant.length - relevant.length),
    unscannedItems: Math.max(0, tweets.length - scanned.length),
  };
  if (!selected.length) {
    return {
      tweets: tweets[0] ? [tweets[0]] : [],
      coverage: { ...commonCoverage, selected: 0, omittedRelevant: 0, status: "complete" },
    };
  }
  const oldestSelected = selected.reduce((oldest, tweet) => compareTweetIds(tweet.id, oldest.id) < 0 ? tweet : oldest);
  const planned = tweets.filter((tweet) => compareTweetIds(tweet.id, oldestSelected.id) >= 0).sort((a, b) => compareTweetIds(a.id, b.id));
  return {
    tweets: planned,
    coverage: {
      ...commonCoverage,
      selected: selected.length,
      omittedRelevant: Math.max(0, relevant.length - selected.length),
      status: "in_progress",
    },
  };
}

function updateGlobalHealth(state, targets, now) {
  const accounts = targets.map((project) => ({
    project,
    health: state._health?.[project.handle.toLowerCase()] || { status: "unknown" },
  }));
  const healthy = accounts.filter(({ health }) => health.status === "healthy").length;
  const fallback = accounts.filter(({ health }) => health.status === "degraded").length;
  const covered = healthy + fallback;
  const successes = accounts.map(({ health }) => health.lastSuccessAt).filter(Boolean).sort();
  const priority = accounts.filter(({ project }) => project.priority);
  const priorityCovered = priority.filter(({ health }) => ["healthy", "degraded"].includes(health.status)).length;
  state._meta ||= {};
  state._meta.health = {
    status: accounts.length > 0 && healthy === accounts.length
      ? "healthy"
      : covered > 0 ? "partial" : "degraded",
    checkedAt: timestamp(now),
    lastSuccessAt: successes.at(-1) || state._meta.health?.lastSuccessAt || null,
    coverageAccounts: {
      total: accounts.length,
      covered,
      healthy,
      fallback,
      unavailable: Math.max(0, accounts.length - covered),
      priorityTotal: priority.length,
      priorityCovered,
    },
  };
}

export function createTwitterMonitor(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const sendAlertsImpl = dependencies.sendAlertsImpl || sendAlerts;
  const recoverFourTwitterPolicyFixesImpl = dependencies.recoverFourTwitterPolicyFixesImpl
    || recoverFourTwitterPolicyFixes;
  const onOfficialRepository = dependencies.onOfficialRepository || (async () => {});
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const autoStart = dependencies.autoStart !== false;
  const stateFile = path.join(config.dataDir, "twitter-state.json");
  const siteWatchlistFile = path.join(config.dataDir, "site-watchlist.json");
  const siteStateFile = path.join(config.dataDir, "site-state.json");
  let runningPromise = null;
  let rerunRequested = false;
  let startupRecoveryProbePending = true;
  let writeCounter = 0;
  let writeQueue = Promise.resolve();
  let liveState = null;
  let requestedControlKey = null;
  let committedRevision = 0;
  let requestedRevision = 0;
  let lastStateWriteAtMs = null;
  let pendingTelemetry = false;
  let telemetryTimer = null;
  let telemetryFlushInFlight = null;
  let retryRecord = null;
  let retryTimer = null;
  let retryInFlight = null;
  let retryFailures = 0;
  let lastStateWriteError = null;
  let schedulerTimer = null;
  let stopping = false;
  let stopPromise = null;
  const telemetryPersistIntervalMs = Math.max(1_000, Math.min(
    DEFAULT_TELEMETRY_PERSIST_INTERVAL_MS,
    Number(dependencies.twitterTelemetryPersistIntervalMs) || DEFAULT_TELEMETRY_PERSIST_INTERVAL_MS,
  ));
  const stateWriteRetryMs = Math.max(100, Number(dependencies.twitterStateWriteRetryMs) || DEFAULT_STATE_WRITE_RETRY_MS);
  const setTelemetryTimeout = dependencies.twitterTelemetrySetTimeoutImpl || setTimeout;
  const clearTelemetryTimeout = dependencies.twitterTelemetryClearTimeoutImpl || clearTimeout;
  const setRetryTimeout = dependencies.twitterStateRetrySetTimeoutImpl || setTimeout;
  const clearRetryTimeout = dependencies.twitterStateRetryClearTimeoutImpl || clearTimeout;
  const atomicWriteState = dependencies.twitterStateAtomicWriteImpl
    || ((file, snapshot, metadata) => atomicWriteTwitterState(file, snapshot, fs, metadata));
  const criticalFailureMinBackoffMs = positiveInteger(
    config.twitterCriticalDiscoveryFailureMinBackoffMs,
    DEFAULT_FAILURE_BACKOFF_MS,
  );
  const criticalFailureMaxBackoffMs = Math.max(
    criticalFailureMinBackoffMs,
    positiveInteger(config.twitterCriticalDiscoveryFailureMaxBackoffMs, MAX_FAILURE_BACKOFF_MS),
  );
  const failureLogSummaryIntervalMs = positiveInteger(
    config.twitterFailureLogSummaryIntervalMs,
    DEFAULT_FAILURE_LOG_SUMMARY_INTERVAL_MS,
  );

  const failureCategory = (error) => {
    const message = String(error?.message || error || "unknown failure");
    if (/\b429\b|rate.?limit/i.test(message)) return "rate_limit";
    if (isTransportFailure(error)) return "transport";
    if (/returned no exact-handle|returned no .*timeline items|no exact-handle status anchors/i.test(message)) return "empty_or_unparseable";
    if (/identity|verification|oembed|exact-status/i.test(message)) return "identity_verification";
    if (/delivery SLA exhausted|deadline|budget/i.test(message)) return "deadline";
    if (/HTTP 5\d\d/i.test(message)) return "upstream_5xx";
    if (/HTTP 4\d\d/i.test(message)) return "upstream_4xx";
    return "other";
  };

  function failureLogDecision(previousLog, previousState, nextState, error) {
    const currentTime = now();
    const checkedAt = new Date(currentTime).toISOString();
    const signature = `${nextState}:${failureCategory(error)}`;
    const transitioned = previousState !== "open" || previousLog?.signature !== signature;
    const lastLoggedAtMs = Date.parse(previousLog?.lastLoggedAt || "");
    const summaryDue = !transitioned && (!Number.isFinite(lastLoggedAtMs)
      || currentTime - lastLoggedAtMs >= failureLogSummaryIntervalMs);
    const shouldLog = transitioned || summaryDue;
    const suppressed = Number(previousLog?.suppressed || 0) + (shouldLog ? 0 : 1);
    return {
      shouldLog,
      summaryDue,
      suppressedBeforeLog: shouldLog ? Number(previousLog?.suppressed || 0) : 0,
      value: {
        state: "open",
        signature,
        category: failureCategory(error),
        lastTransitionAt: transitioned ? checkedAt : previousLog?.lastTransitionAt || checkedAt,
        lastLoggedAt: shouldLog ? checkedAt : previousLog?.lastLoggedAt || null,
        suppressed: shouldLog ? 0 : suppressed,
      },
    };
  }

  function openCircuit(previous, {
    error,
    status,
    minimumBackoffMs = DEFAULT_FAILURE_BACKOFF_MS,
    maximumBackoffMs = MAX_FAILURE_BACKOFF_MS,
    fields = {},
    logPrefix = null,
  }) {
    const failures = Number(previous?.consecutiveFailures || 0) + 1;
    const exponentialBackoffMs = Math.min(
      maximumBackoffMs,
      minimumBackoffMs * 2 ** Math.min(failures - 1, 10),
    );
    // Retry-After is authoritative even when it exceeds the local exponential
    // ceiling (the parser already applies the one-hour safety cap).
    const backoffMs = Math.max(Number(error?.retryMs || 0), exponentialBackoffMs);
    const checkedAt = timestamp(now);
    const circuitUntil = new Date(now() + backoffMs).toISOString();
    const log = failureLogDecision(previous?.failureLog, previous?.circuitState, "open", error);
    if (log.shouldLog && logPrefix) {
      const summary = log.summaryDue && log.suppressedBeforeLog > 0
        ? `; suppressed ${log.suppressedBeforeLog} repeated failures since last summary`
        : "";
      logger.error(`${logPrefix}: ${error.message}; circuit open until ${circuitUntil}${summary}`);
    }
    const next = {
      ...(previous || {}),
      ...fields,
      status,
      checkedAt,
      lastErrorAt: checkedAt,
      lastError: error.message,
      consecutiveFailures: failures,
      retryAfter: circuitUntil,
      circuitState: "open",
      circuitUntil,
      failureLog: log.value,
    };
    delete next.nextPollAt;
    return next;
  }

  function closeCircuit(previous, next, logPrefix = null) {
    const checkedAt = next.checkedAt || timestamp(now);
    if (previous?.circuitState === "open" && logPrefix) {
      logger.info?.(`${logPrefix}: recovered after ${Number(previous.consecutiveFailures || 0)} consecutive failures`);
    }
    return {
      ...next,
      circuitState: "closed",
      circuitClosedAt: checkedAt,
      ...(previous?.failureLog ? {
        failureLog: {
          ...previous.failureLog,
          state: "closed",
          lastTransitionAt: checkedAt,
          suppressed: 0,
        },
      } : {}),
    };
  }

  function logAggregateFailure(health, project, error) {
    const log = failureLogDecision(
      health.aggregateFailureLog,
      health.aggregateFailureLog?.state,
      "open",
      error,
    );
    health.aggregateFailureLog = log.value;
    if (!log.shouldLog) return;
    const fallback = (project.fallbackOfficialSources || []).map((source) => source.url).join(", ") || "none configured";
    const summary = log.summaryDue && log.suppressedBeforeLog > 0
      ? `; suppressed ${log.suppressedBeforeLog} repeated failures since last summary`
      : "";
    logger.error(`[twitter][${health.status}] @${project.handle}: ${error.message}; retry ${health.retryAfter}; official fallbacks: ${fallback}${summary}`);
  }

  function closeAggregateFailureLog(health, project) {
    if (health.aggregateFailureLog?.state !== "open") return;
    logger.info?.(`[twitter][recovered] @${project.handle}: verified X coverage restored`);
    health.aggregateFailureLog = {
      ...health.aggregateFailureLog,
      state: "closed",
      lastTransitionAt: timestamp(now),
      suppressed: 0,
    };
  }

  async function verifyThirdPartyTweets(project, tweets, timeoutMs) {
    // Critical candidates share one wall-clock SLA, so queued verification
    // batches cannot be allowed to multiply the timeout. Ordinary X keeps its
    // configured public-endpoint concurrency.
    const concurrency = isCriticalFastLane(project)
      ? Math.max(1, tweets.length)
      : Math.max(1, positiveInteger(config.twitterOfficialOembedConcurrency, 4));
    const results = await settleBounded(tweets, concurrency, async (tweet) => {
      const requested = `https://x.com/${project.handle}/status/${tweet.id}`;
      const url = `${OFFICIAL_X_OEMBED_BASE}?omit_script=true&dnt=true&url=${encodeURIComponent(requested)}`;
      const response = await fetchImpl(url, {
        headers: { accept: "application/json", "user-agent": BROWSER_USER_AGENT },
        signal: AbortSignal.timeout(isCriticalFastLane(project)
          ? Math.max(1, timeoutMs)
          : Math.max(500, timeoutMs)),
      });
      if (!response.ok) {
        const error = new Error(`official X oEmbed HTTP ${response.status}`);
        if (response.status === 429) error.retryMs = retryAfterMs(response, now);
        throw error;
      }
      // oEmbed proves the canonical status/author pair, but its paragraph is a
      // presentation preview and may end in an ellipsis for long posts. Keep
      // the immutable-ID Fx timeline text as the event body after the proof
      // succeeds; using the preview here can silently remove the decisive
      // lines from a product announcement before classification.
      parseOfficialXOembed(await response.text(), project.handle, tweet.id);
      return { ...tweet, sourceVerifiedBy: "official_x_oembed" };
    });
    const failed = results.find((result) => result.status === "rejected");
    if (failed) throw failed.reason;
    return results.map((result) => result.value);
  }

  async function verifyCriticalJinaTweets(project, tweets, timeoutMs) {
    if (config.twitterFxTwitterEnabled !== true || !config.twitterFxTwitterApiBase || !project.xUserId) {
      throw new Error("critical Jina discovery requires FxTwitter exact-status numeric identity");
    }
    // Run the small fresh-candidate set in one wall-clock batch. Each item
    // still performs both independent checks. Only the contiguous verified
    // prefix may advance, so a failed older ID can never be skipped by moving
    // the durable cursor to a newer candidate.
    const concurrency = Math.max(1, tweets.length);
    const fxBase = String(config.twitterFxTwitterApiBase).trim().replace(/\/$/, "");
    const verifiedResults = await settleBounded(tweets, concurrency, async (tweet) => {
      const exactUrl = `${fxBase}/${encodeURIComponent(project.handle)}/status/${encodeURIComponent(tweet.id)}`;
      const requested = `https://x.com/${project.handle}/status/${tweet.id}`;
      const oembedUrl = `${OFFICIAL_X_OEMBED_BASE}?omit_script=true&dnt=true&url=${encodeURIComponent(requested)}`;
      // The two independent identity checks run together. Both must succeed;
      // concurrency reduces latency but never weakens the fail-closed gate.
      const [exactResponse, oembedResponse] = await Promise.all([
        fetchImpl(exactUrl, {
          headers: { accept: "application/json", "user-agent": "robinhood-launchpad-monitor/0.1" },
          signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
        }),
        fetchImpl(oembedUrl, {
          headers: { accept: "application/json", "user-agent": BROWSER_USER_AGENT },
          signal: AbortSignal.timeout(Math.max(1, timeoutMs)),
        }),
      ]);
      if (!exactResponse.ok) {
        const error = new Error(`FxTwitter exact-status HTTP ${exactResponse.status}`);
        if (exactResponse.status === 429) error.retryMs = retryAfterMs(exactResponse, now);
        throw error;
      }
      if (!oembedResponse.ok) {
        const error = new Error(`official X oEmbed HTTP ${oembedResponse.status}`);
        if (oembedResponse.status === 429) error.retryMs = retryAfterMs(oembedResponse, now);
        throw error;
      }
      const exact = parseFxTwitterExactStatus(await exactResponse.text(), project.handle, project.xUserId, tweet.id);
      // The exact Fx response supplies the complete text and independently
      // binds it to the expected numeric author/status. oEmbed remains the
      // second fail-closed identity proof only; never let its truncated
      // presentation text replace or extend the exact response body.
      parseOfficialXOembed(await oembedResponse.text(), project.handle, tweet.id);
      return {
        ...exact,
        handle: project.handle,
        xUserId: String(project.xUserId),
        authorId: String(project.xUserId),
        sourceVerifiedBy: "official_x_oembed",
        identityVerifiedBy: "fxtwitter_exact_numeric_id",
        discoveredBy: tweet.discoveredBy || "critical_public_discovery",
      };
    });
    const firstFailure = verifiedResults.findIndex((result) => result.status === "rejected");
    const verified = verifiedResults
      .slice(0, firstFailure < 0 ? verifiedResults.length : firstFailure)
      .map((result) => result.value);
    if (!verified.length) {
      const failure = verifiedResults.find((result) => result.status === "rejected");
      throw failure?.reason || new Error("critical X dual verification returned no verified candidates");
    }
    return verified;
  }

  async function fetchCriticalJinaDiscovery(
    project,
    health,
    previousLatestId,
    startupRecoveryProbe,
    verifiedPrimaryIds = new Set(),
    criticalDeadlineAtMs = null,
  ) {
    if (!isCriticalFastLane(project)) return { tweets: [], degraded: false, errors: [] };
    const sources = criticalDiscoverySources(config, project);
    if (!sources.length) return { tweets: [], degraded: false, errors: [] };
    const timing = criticalLatencySettings(config);
    const errors = [];
    const observations = await Promise.all(sources.map(async ({ base, kind }) => {
      const previousSource = health.sources[base] || {};
      if (!sourceAvailable(health, base, now(), startupRecoveryProbe)) {
        if (previousSource.status && previousSource.status !== "healthy") {
          errors.push({
            source: base,
            message: previousSource.lastError || "source circuit active",
            retryAfter: previousSource.circuitUntil || previousSource.retryAfter || null,
          });
        }
        return { base, kind, tweets: [], skipped: true };
      }
      const pollStartedAt = now();
      try {
        const remainingDiscoveryMs = Number.isFinite(criticalDeadlineAtMs)
          ? criticalDeadlineAtMs - now() - timing.minimumVerifyReserveMs - timing.deliveryReserveMs
          : timing.discoveryTimeoutMs;
        if (remainingDiscoveryMs <= 0) throw new Error("critical X delivery SLA exhausted before discovery");
        const response = await fetchImpl(sourceUrl(base, project), {
          headers: kind === "x_direct_profile"
            ? {
                accept: "text/html,application/xhtml+xml",
                "accept-language": "en-US,en;q=0.9",
                "user-agent": BROWSER_USER_AGENT,
              }
            : { accept: "application/json", "user-agent": "robinhood-launchpad-monitor/0.1" },
          signal: AbortSignal.timeout(Math.max(1, Math.min(timing.discoveryTimeoutMs, remainingDiscoveryMs))),
        });
        if (response.status === 429) {
          const error = new Error("HTTP 429");
          error.retryMs = retryAfterMs(response, now);
          throw error;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        const parsed = (kind === "x_direct_profile"
          ? parseCriticalXDirectDiscovery(body, project.handle)
          : parseJinaReaderPayload(body, project.handle, { includePinned: true }))
          .filter((tweet) => !tweet.isReply)
          .map((tweet) => ({ ...tweet, discoveredBy: kind }));
        if (!parsed.length) throw new Error(`${kind} returned no exact-handle status anchors`);
        const completedAt = now();
        const checkedAt = new Date(completedAt).toISOString();
        health.sources[base] = closeCircuit(previousSource, {
          status: "healthy",
          source: `${kind}_discovery_only`,
          identitySource: false,
          checkedAt,
          lastSuccessAt: checkedAt,
          timelineItems: parsed.length,
          nextPollAt: new Date(Math.max(pollStartedAt + timing.discoveryIntervalMs, completedAt)).toISOString(),
        }, `[twitter][critical-discovery-recovered] @${project.handle}/${kind}`);
        return { base, kind, tweets: parsed, skipped: false };
      } catch (error) {
        health.sources[base] = openCircuit(previousSource, {
          error,
          status: error.message === "HTTP 429" ? "backoff" : "error",
          minimumBackoffMs: criticalFailureMinBackoffMs,
          maximumBackoffMs: criticalFailureMaxBackoffMs,
          fields: { source: `${kind}_discovery_only`, identitySource: false },
          logPrefix: `[twitter][critical-discovery] @${project.handle}/${kind}`,
        });
        const retryAfter = health.sources[base].circuitUntil;
        errors.push({ source: base, message: error.message, retryAfter });
        return { base, kind, tweets: [], skipped: false, error };
      }
    }));

    const maximumAgeMs = criticalTweetMaxAgeMs(config, project);
    const candidatesById = new Map();
    for (const observation of observations) {
      for (const tweet of observation.tweets) {
        if ((previousLatestId && compareTweetIds(tweet.id, previousLatestId) <= 0)
          || verifiedPrimaryIds.has(tweet.id)
          || !isCriticalTweetFresh(tweet, now(), maximumAgeMs)) continue;
        const previous = candidatesById.get(tweet.id);
        if (!previous) candidatesById.set(tweet.id, tweet);
        else {
          const sourcesForId = new Set(String(previous.discoveredBy || "").split("+").filter(Boolean));
          sourcesForId.add(tweet.discoveredBy);
          previous.discoveredBy = [...sourcesForId].sort().join("+");
        }
      }
    }
    const candidates = [...candidatesById.values()].sort((left, right) => compareTweetIds(left.id, right.id));
    if (!candidates.length) {
      return {
        tweets: [],
        degraded: errors.length > 0,
        errors,
        source: observations.find((item) => !item.error && !item.skipped)?.base || null,
      };
    }
    const previousVerification = health.criticalVerification || {};
    if (sourceAttemptAt(previousVerification) > now()) {
      const retryAfter = previousVerification.circuitUntil || previousVerification.retryAfter;
      errors.push({
        source: "critical_dual_verification",
        message: previousVerification.lastError || "critical dual-verification circuit active",
        retryAfter,
      });
      return { tweets: [], degraded: true, errors, source: null };
    }
    try {
      const remainingVerificationMs = Number.isFinite(criticalDeadlineAtMs)
        ? criticalDeadlineAtMs - now() - timing.deliveryReserveMs
        : timing.verifyTimeoutMs;
      if (remainingVerificationMs <= 0) throw new Error("critical X delivery SLA exhausted before dual verification");
      const verified = await verifyCriticalJinaTweets(
        project,
        candidates,
        Math.min(timing.verifyTimeoutMs, remainingVerificationMs),
      );
      health.criticalVerification = closeCircuit(previousVerification, {
        status: "healthy",
        checkedAt: timestamp(now),
        lastSuccessAt: timestamp(now),
        verifiedCandidates: verified.length,
        timeoutBudgetMs: Math.min(timing.verifyTimeoutMs, remainingVerificationMs),
        identity: "fxtwitter_exact_numeric_id+official_x_oembed",
      }, `[twitter][critical-verification-recovered] @${project.handle}`);
      return {
        tweets: verified,
        degraded: errors.length > 0,
        errors,
        source: observations.find((item) => !item.error && !item.skipped)?.base || null,
      };
    } catch (error) {
      health.criticalVerification = openCircuit(previousVerification, {
        error,
        status: "error",
        minimumBackoffMs: criticalFailureMinBackoffMs,
        maximumBackoffMs: criticalFailureMaxBackoffMs,
        fields: { identity: "fxtwitter_exact_numeric_id+official_x_oembed" },
        logPrefix: `[twitter][critical-verification] @${project.handle}`,
      });
      const retryAfter = health.criticalVerification.circuitUntil;
      errors.push({ source: "critical_dual_verification", message: error.message, retryAfter });
      return { tweets: [], degraded: true, errors, source: null };
    }
  }

  async function settleBounded(items, concurrency, task) {
    const results = new Array(items.length);
    let cursor = 0;
    const workers = Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor += 1;
        try { results[index] = { status: "fulfilled", value: await task(items[index]) }; }
        catch (reason) { results[index] = { status: "rejected", reason }; }
      }
    });
    await Promise.all(workers);
    return results;
  }

  async function readJson(file, fallback) {
    try { return JSON.parse(await fs.readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
  }

  async function isDurablyAcceptedAlert(result, { strictPonFun = false } = {}) {
    const classification = classifyTwitterAlertDelivery(result, { strictPonFun });
    if (classification === "accepted") return true;
    if (classification === "semantic_duplicate" && (result?.persisted === true || result?.terminal === true)) return true;
    if (!result?.eventId || String(result.status || "").toLowerCase() !== "suppressed") return false;
    const outbox = await readJson(path.join(config.dataDir, "alert-outbox.json"), null);
    const entry = outbox?.events?.[result.eventId];
    if (!entry || entry.status !== "suppressed") return false;
    const destinations = Object.values(entry.destinations || {});
    return destinations.some((destination) => destination?.disabledReason === "semantic_duplicate")
      && destinations.every((destination) => !["pending", "failed", "sending"].includes(destination?.status));
  }

  function clearTelemetryFlushTimer() {
    if (telemetryTimer) clearTelemetryTimeout(telemetryTimer);
    telemetryTimer = null;
  }

  function clearStateRetryTimer() {
    if (retryTimer) clearRetryTimeout(retryTimer);
    retryTimer = null;
  }

  function scheduleStateRetry() {
    if (stopping || retryTimer || retryInFlight || !retryRecord) return;
    const delay = Math.min(30_000, stateWriteRetryMs * 2 ** Math.min(retryFailures, 5));
    retryTimer = setRetryTimeout(() => {
      retryTimer = null;
      void retryPendingStateWrite().catch((error) => {
        logger.error(`[twitter][state-persist] ${error.message}`);
      });
    }, delay);
    retryTimer?.unref?.();
  }

  function enqueueStateWrite(record) {
    const operation = async () => {
      if (record.revision <= committedRevision) {
        if (retryRecord?.revision <= committedRevision) retryRecord = null;
        return;
      }
      try {
        await atomicWriteState(stateFile, record.snapshot, {
          revision: record.revision,
          kind: record.kind,
          suffix: `${process.pid}.${now()}.${writeCounter++}`,
        });
        committedRevision = record.revision;
        lastStateWriteAtMs = now();
        retryFailures = 0;
        if (retryRecord?.revision <= committedRevision) retryRecord = null;
        if (!retryRecord) clearStateRetryTimer();
        if (pendingTelemetry) scheduleTelemetryFlush();
      } catch (error) {
        retryFailures += 1;
        lastStateWriteError = error;
        if (!retryRecord || record.revision >= retryRecord.revision) retryRecord = record;
        scheduleStateRetry();
        throw error;
      }
    };
    const pending = writeQueue.then(operation, operation);
    writeQueue = pending.catch(() => {});
    return pending;
  }

  function durableStateWrite(state, controlKey, kind = "durable") {
    pendingTelemetry = false;
    clearTelemetryFlushTimer();
    requestedControlKey = controlKey;
    const record = {
      revision: ++requestedRevision,
      kind,
      controlKey,
      snapshot: `${JSON.stringify(state, null, 2)}\n`,
    };
    return enqueueStateWrite(record);
  }

  function scheduleTelemetryFlush() {
    if (telemetryTimer || telemetryFlushInFlight || retryRecord || stopping || !pendingTelemetry) return;
    const elapsed = lastStateWriteAtMs == null ? 0 : Math.max(0, now() - lastStateWriteAtMs);
    const delay = Math.max(0, telemetryPersistIntervalMs - elapsed);
    telemetryTimer = setTelemetryTimeout(() => {
      telemetryTimer = null;
      void flushTelemetry().catch((error) => {
        logger.error(`[twitter][state-telemetry] ${error.message}`);
      });
    }, delay);
    telemetryTimer?.unref?.();
  }

  function flushTelemetry() {
    if (telemetryFlushInFlight) return telemetryFlushInFlight;
    if (!pendingTelemetry || !liveState) return Promise.resolve();
    pendingTelemetry = false;
    clearTelemetryFlushTimer();
    const controlKey = twitterStateControlKey(liveState);
    // A transition that happened while the timer was pending is promoted to a
    // durable write. Its newer revision therefore wins even at the same clock.
    telemetryFlushInFlight = durableStateWrite(
      liveState,
      controlKey,
      controlKey === requestedControlKey ? "telemetry" : "durable",
    ).finally(() => {
      telemetryFlushInFlight = null;
      if (pendingTelemetry) scheduleTelemetryFlush();
    });
    return telemetryFlushInFlight;
  }

  function persistState(state, { durable = false } = {}) {
    liveState = state;
    const controlKey = twitterStateControlKey(state);
    if (requestedControlKey == null) requestedControlKey = controlKey;
    if (durable || controlKey !== requestedControlKey) {
      return durableStateWrite(state, controlKey);
    }
    pendingTelemetry = true;
    scheduleTelemetryFlush();
    return Promise.resolve();
  }

  function retryPendingStateWrite() {
    if (retryInFlight) return retryInFlight;
    const record = retryRecord;
    if (!record) return Promise.resolve();
    retryInFlight = enqueueStateWrite(record).finally(() => {
      retryInFlight = null;
      if (retryRecord) scheduleStateRetry();
    });
    return retryInFlight;
  }

  function healthFor(state, project) {
    state._health ||= {};
    const key = project.handle.toLowerCase();
    state._health[key] ||= {
      status: "unknown",
      consecutiveFailures: 0,
      priority: Boolean(project.priority),
      fallbackOfficialSources: project.fallbackOfficialSources || [],
      sources: {},
    };
    const health = state._health[key];
    health.priority = Boolean(project.priority);
    health.fallbackOfficialSources = project.fallbackOfficialSources || [];
    health.sources ||= {};
    return health;
  }

  async function fetchTweets(
    project,
    health,
    previousLatestId = null,
    startupRecoveryProbe = false,
    criticalDeadlineAtMs = null,
  ) {
    const errors = [];
    let attempted = 0;
    const bases = sourceBases(config, project);
    const primaryBase = bases[0] || null;
    const criticalTiming = isCriticalFastLane(project) ? criticalLatencySettings(config) : null;
    // Discovery begins before the primary timeline request. X direct/Jina are
    // ID hints only; every candidate still needs concurrent Fx exact-status
    // numeric identity and official X oEmbed verification.
    const criticalDiscoveryPromise = isCriticalFastLane(project)
      ? fetchCriticalJinaDiscovery(
          project,
          health,
          previousLatestId,
          startupRecoveryProbe,
          new Set(),
          criticalDeadlineAtMs,
        )
      : Promise.resolve({ tweets: [], degraded: false, errors: [], source: null });
    let criticalDiscoveryResult;
    const criticalDiscovery = async () => {
      if (!criticalDiscoveryResult) criticalDiscoveryResult = await criticalDiscoveryPromise;
      return criticalDiscoveryResult;
    };
    const discoveryFetchResult = (discovery, inheritedErrors = []) => {
      if (isPonFunFastLane(project) && previousLatestId) {
        health.coverage ||= {};
        health.coverage.cursorGap = {
          status: "incomplete",
          reason: "discovery_only_cannot_prove_durable_cursor_continuity",
          cursorId: previousLatestId,
          newestSeenId: discovery.tweets[0]?.id || null,
          oldestSeenId: discovery.tweets.at(-1)?.id || null,
          detectedAt: timestamp(now),
          source: discovery.source || "critical_verified_discovery",
        };
        const error = new Error("Pon discovery-only fallback cannot prove the durable cursor");
        error.code = "TWITTER_PON_CURSOR_GAP";
        throw error;
      }
      return {
        tweets: discovery.tweets,
        source: discovery.source,
        sourceId: "critical_verified_discovery",
        degraded: inheritedErrors.length > 0 || discovery.degraded,
        errors: [...inheritedErrors, ...discovery.errors],
      };
    };
    const auxiliaryFetchResult = (discovery) => ({
      tweets: [],
      source: primaryBase,
      sourceId: health.sources?.[primaryBase]?.source || "fxtwitter_numeric_id",
      auxiliaryOnly: true,
      degraded: true,
      errors: discovery.errors,
    });
    const targetBudgetMs = positiveInteger(
      project.priority ? config.twitterPriorityTargetBudgetMs : config.twitterStandardTargetBudgetMs,
      project.priority ? 12_000 : 15_000,
    );
    const deadline = isCriticalFastLane(project) && Number.isFinite(criticalDeadlineAtMs)
      ? Math.min(now() + targetBudgetMs, criticalDeadlineAtMs - criticalTiming.deliveryReserveMs)
      : now() + targetBudgetMs;
    for (const base of bases) {
      const previousSource = health.sources[base] || {};
      if (!sourceAvailable(health, base, now(), startupRecoveryProbe)) continue;
      const remainingBudgetMs = deadline - now();
      if (remainingBudgetMs <= 0) break;
      attempted += 1;
      try {
        const directX = isDirectXSource(base);
        const fxTwitter = isFxTwitterSource(base);
        const jinaReader = isJinaReaderSource(base);
        const configuredTimeoutMs = positiveInteger(
          directX ? config.twitterDirectRequestTimeoutMs
            : fxTwitter ? config.twitterRequestTimeoutMs
              : jinaReader ? config.twitterJinaRequestTimeoutMs
                : config.twitterSyndicationRequestTimeoutMs,
          directX ? 4_000 : jinaReader ? 8_000 : 6_000,
        );
        const effectiveTimeoutMs = isCriticalFastLane(project)
          ? Math.min(configuredTimeoutMs, criticalTiming.discoveryTimeoutMs)
          : configuredTimeoutMs;
        const headers = {
          "user-agent": directX ? BROWSER_USER_AGENT : "robinhood-launchpad-monitor/0.1",
          ...(directX ? { accept: "text/html,application/xhtml+xml", "accept-language": "en-US,en;q=0.9" } : {}),
          ...(jinaReader || fxTwitter ? { accept: "application/json" } : {}),
          ...(jinaReader && project.priority ? { "x-no-cache": "true", "x-cache-tolerance": "0" } : {}),
        };
        const sourcePollStartedAt = now();
        const response = await fetchImpl(sourceUrl(base, project), {
          headers,
          signal: AbortSignal.timeout(Math.max(250, Math.min(effectiveTimeoutMs, remainingBudgetMs))),
        });
        if (response.status === 429) {
          const error = new Error("HTTP 429");
          error.retryMs = retryAfterMs(response, now);
          throw error;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const body = await response.text();
        const immutableIdentityRequired = project.signalProfile === "ai" || isCriticalFastLane(project);
        if (immutableIdentityRequired && jinaReader) {
          throw new Error(project.signalProfile === "ai"
            ? "AI official identity cannot be verified by Jina Reader"
            : "critical-X identity cannot be verified by Jina Reader");
        }
        let parsedTweets = directX
          ? parseXDirectTimeline(body, project.handle, project.xUserId)
          : fxTwitter
            ? parseFxTwitterTimeline(body, project.handle, project.xUserId)
          : jinaReader
            ? parseJinaReaderPayload(body, project.handle)
            : parseTimelineHtml(body, project.handle);
        const sourceLabel = directX ? "X direct" : fxTwitter ? "FxTwitter numeric-ID timeline" : jinaReader ? "Jina Reader" : "X syndication";
        if (!parsedTweets.length) throw new Error(`${sourceLabel} returned no exact-handle timeline items`);
        if (immutableIdentityRequired) {
          const expectedUserId = String(project.xUserId || "");
          const expectedHandle = project.handle.toLowerCase();
          const identityMismatch = !expectedUserId || parsedTweets.some((tweet) => (
            String(tweet.authorId || tweet.xUserId || "") !== expectedUserId
            || String(tweet.handle || "").toLowerCase() !== expectedHandle
          ));
          if (identityMismatch) throw new Error(project.signalProfile === "ai"
            ? `AI official immutable identity mismatch for @${project.handle}`
            : `critical-X immutable identity mismatch for @${project.handle}`);
        }
        parsedTweets = parsedTweets.filter((tweet) => !tweet.isReply);
        if (fxTwitter) {
          const relevantForCursor = parsedTweets
            .sort((left, right) => compareTweetIds(right.id, left.id))
            .filter((tweet) => !previousLatestId || compareTweetIds(tweet.id, previousLatestId) > 0);
          if (!previousLatestId || relevantForCursor.length) {
            const verifyCandidates = isCriticalFastLane(project)
              ? (previousLatestId
                  ? (isPonFunFastLane(project) && health.gapSince
                      ? [...relevantForCursor]
                        .sort((left, right) => compareTweetIds(left.id, right.id))
                        .slice(0, 1)
                      : relevantForCursor.filter((tweet) => {
                        return isCriticalTweetFresh(
                          tweet,
                          now(),
                          criticalTweetMaxAgeMs(config, project),
                        );
                      }))
                  : parsedTweets.slice(0, 1))
              : (relevantForCursor.length ? relevantForCursor : parsedTweets.slice(0, 1));
            if (verifyCandidates.length) {
              const verifyBudgetMs = isCriticalFastLane(project)
                ? Math.min(criticalTiming.verifyTimeoutMs, deadline - now())
                : Math.max(500, deadline - now());
              if (isCriticalFastLane(project) && verifyBudgetMs <= 0) {
                throw new Error("critical X delivery SLA exhausted before primary verification");
              }
              const verifiedCandidates = isPonFunFastLane(project)
                ? await verifyCriticalJinaTweets(project, verifyCandidates, verifyBudgetMs)
                : await verifyThirdPartyTweets(project, verifyCandidates, verifyBudgetMs);
              if (isCriticalFastLane(project)) {
                health.criticalVerification = {
                  status: "healthy",
                  checkedAt: timestamp(now),
                  lastSuccessAt: timestamp(now),
                  verifiedCandidates: verifiedCandidates.length,
                  timeoutBudgetMs: verifyBudgetMs,
                  identity: isPonFunFastLane(project)
                    ? "fxtwitter_exact_numeric_id+official_x_oembed"
                    : "fxtwitter_numeric_id+official_x_oembed",
                };
              }
              const verifiedById = new Map(verifiedCandidates.map((tweet) => [tweet.id, tweet]));
              parsedTweets = parsedTweets.map((tweet) => verifiedById.get(tweet.id) || tweet);
            }
          }
        }
        const discovery = await criticalDiscovery();
        if (discovery.tweets.length) {
          const merged = new Map(parsedTweets.map((tweet) => [tweet.id, tweet]));
          for (const tweet of discovery.tweets) merged.set(tweet.id, tweet);
          parsedTweets = [...merged.values()].sort((left, right) => compareTweetIds(right.id, left.id));
        }
        const tweets = parsedTweets;
        if (directX && !previousLatestId && project.backfillOnFirstSeen) {
          throw new Error("X direct timeline is too shallow for first-seen backfill");
        }
        if (directX && previousLatestId && !isCriticalFastLane(project) && !tweets.some((tweet) => compareTweetIds(tweet.id, previousLatestId) === 0)) {
          throw new Error("X direct timeline does not cover the durable cursor");
        }
        if (fxTwitter && previousLatestId && isPonFunFastLane(project)
          && !tweets.some((tweet) => compareTweetIds(tweet.id, previousLatestId) === 0)) {
          health.coverage ||= {};
          health.coverage.cursorGap = {
            status: "incomplete",
            reason: "durable_cursor_not_in_numeric_id_timeline",
            cursorId: previousLatestId,
            newestSeenId: tweets[0]?.id || null,
            oldestSeenId: tweets.at(-1)?.id || null,
            detectedAt: timestamp(now),
            source: base,
          };
          const error = new Error("Pon FxTwitter timeline does not cover the durable cursor");
          error.code = "TWITTER_PON_CURSOR_GAP";
          throw error;
        }
        if (fxTwitter && previousLatestId && !isCriticalFastLane(project) && tweets[0]
          && compareTweetIds(tweets[0].id, previousLatestId) > 0
          && !tweets.some((tweet) => compareTweetIds(tweet.id, previousLatestId) === 0)) {
          throw new Error("FxTwitter timeline does not cover the durable cursor");
        }
        const sourcePollCompletedAt = now();
        const checkedAt = new Date(sourcePollCompletedAt).toISOString();
        const configuredFxTwitterPollIntervalMs = ["flap", "fourmeme", "ponfun"].includes(project.id)
          ? positiveInteger(config.twitterCriticalFxTwitterMinIntervalMs, MIN_FXTWITTER_POLL_INTERVAL_MS)
          : positiveInteger(config.twitterFxTwitterMinIntervalMs, MIN_FXTWITTER_POLL_INTERVAL_MS);
        const fxTwitterPollIntervalMs = Math.max(MIN_FXTWITTER_POLL_INTERVAL_MS, configuredFxTwitterPollIntervalMs);
        // Anchor healthy-source cadence to request start, not completion. This
        // keeps FxTwitter start-to-start spacing at its safe five-second floor
        // without adding network/oEmbed latency after every successful poll.
        // The serialized scheduler still prevents overlapping account polls.
        const fxTwitterNextPollAt = Math.max(
          sourcePollStartedAt + fxTwitterPollIntervalMs,
          sourcePollCompletedAt,
        );
        health.sources[base] = closeCircuit(previousSource, {
          status: "healthy",
          source: directX ? "x_direct_ssr" : fxTwitter ? "fxtwitter_numeric_id" : jinaReader ? "jina_reader" : "syndication",
          checkedAt,
          lastSuccessAt: checkedAt,
          timelineItems: tweets.length,
          ...(fxTwitter ? { nextPollAt: new Date(fxTwitterNextPollAt).toISOString() } : {}),
          ...(jinaReader ? { nextPollAt: new Date(sourcePollCompletedAt + positiveInteger(config.twitterJinaMinIntervalMs, 300_000)).toISOString() } : {}),
        }, isCriticalFastLane(project) ? `[twitter][source-recovered] @${project.handle}/${fxTwitter ? "fxtwitter" : directX ? "direct" : "source"}` : null);
        return {
          tweets,
          source: base,
          sourceId: directX ? "x_direct_ssr" : fxTwitter ? "fxtwitter_numeric_id" : jinaReader ? "jina_reader" : "syndication",
          degraded: errors.length > 0 || base !== bases[0] || discovery.degraded,
          errors: [...errors, ...discovery.errors],
        };
      } catch (error) {
        const failureMaximumMs = isTransportFailure(error) ? Math.min(MAX_FAILURE_BACKOFF_MS, 60_000) : MAX_FAILURE_BACKOFF_MS;
        health.sources[base] = openCircuit(previousSource, {
          error,
          status: error.message === "HTTP 429" ? "backoff" : "error",
          minimumBackoffMs: DEFAULT_FAILURE_BACKOFF_MS,
          maximumBackoffMs: failureMaximumMs,
          logPrefix: isCriticalFastLane(project)
            ? `[twitter][source] @${project.handle}/${isFxTwitterSource(base) ? "fxtwitter" : isJinaReaderSource(base) ? "jina" : "direct"}`
            : null,
        });
        const retryAfter = health.sources[base].circuitUntil;
        if (error.code === "TWITTER_PON_CURSOR_GAP") error.retryAfter = retryAfter;
        errors.push({ source: base, message: error.message, retryAfter });
        if (error.code === "TWITTER_PON_CURSOR_GAP") throw error;
        if (isCriticalFastLane(project)) {
          const discovery = await criticalDiscovery();
          if (discovery.tweets.length) return discoveryFetchResult(discovery, errors);
          break;
        }
      }
    }
    if (isCriticalFastLane(project)) {
      const discovery = await criticalDiscovery();
      if (discovery.tweets.length) return discoveryFetchResult(discovery, errors);
      const primarySource = primaryBase ? health.sources?.[primaryBase] : null;
      if (attempted === 0 && primarySource?.status === "healthy" && sourceAttemptAt(primarySource) > now()) {
        return auxiliaryFetchResult(discovery);
      }
    }
    const error = new Error(attempted ? errors.map((item) => `${item.source}: ${item.message}`).join("; ") : "all X sources are in backoff");
    if (isCriticalFastLane(project) && ((Number.isFinite(criticalDeadlineAtMs) && now() >= criticalDeadlineAtMs)
      || errors.some((item) => /delivery SLA exhausted/i.test(item.message)))) {
      error.code = "TWITTER_CRITICAL_SLA_EXHAUSTED";
    }
    const retryTimes = Object.values(health.sources).map(sourceAttemptAt).filter((value) => value > now());
    error.retryAfter = retryTimes.length ? new Date(Math.min(...retryTimes)).toISOString() : new Date(now() + DEFAULT_FAILURE_BACKOFF_MS).toISOString();
    error.sourceErrors = errors;
    throw error;
  }

  async function enrichJinaTweet(project, tweet, base) {
    const profileUrl = sourceUrl(base, project).replace(/\/$/, "");
    const response = await fetchImpl(`${profileUrl}/status/${tweet.id}`, {
      headers: {
        accept: "application/json",
        "user-agent": "robinhood-launchpad-monitor/0.1",
        ...(project.priority ? { "x-no-cache": "true", "x-cache-tolerance": "0" } : {}),
      },
      signal: AbortSignal.timeout(positiveInteger(config.twitterJinaRequestTimeoutMs, 8_000)),
    });
    if (!response.ok) throw new Error(`Jina status HTTP ${response.status}`);
    const exact = parseJinaReaderPayload(await response.text(), project.handle)
      .find((item) => item.id === tweet.id);
    if (!exact?.text || /\bShow more\b/i.test(exact.text)) throw new Error("Jina status did not return complete exact-handle text");
    return {
      ...tweet,
      ...exact,
      createdAt: tweet.createdAt || exact.createdAt,
      expandedUrls: [...new Set([...(tweet.expandedUrls || []), ...(exact.expandedUrls || [])])],
      textTruncated: false,
      detailSource: "jina_status",
    };
  }

  async function pollTarget(project, state, startupRecoveryProbe = false, schedulerCycleStartedAtMs = null) {
    const key = project.handle.toLowerCase();
    const health = healthFor(state, project);
    const bases = sourceBases(config, project);
    const criticalTiming = isCriticalFastLane(project) ? criticalLatencySettings(config) : null;
    const criticalStartedAtMs = isCriticalFastLane(project)
      ? (Number.isFinite(schedulerCycleStartedAtMs) ? schedulerCycleStartedAtMs : now())
      : null;
    const criticalDeadlineAtMs = isCriticalFastLane(project)
      ? criticalStartedAtMs + criticalTiming.attemptBudgetMs
      : null;
    const deliverySla = isCriticalFastLane(project)
      ? {
          startedAt: new Date(criticalStartedAtMs).toISOString(),
          deadlineAt: new Date(criticalDeadlineAtMs).toISOString(),
          budgetMs: criticalTiming.localBudgetMs,
          pollAllowanceMs: criticalTiming.pollAllowanceMs,
          basis: "critical_source_poll",
        }
      : null;
    const refreshCriticalSlaStatus = () => updateCriticalSlaStatus(config, project, health, now());
    const criticalDiscoveryAvailable = hasAvailableCriticalDiscoverySource(
      config,
      project,
      health,
      now(),
      startupRecoveryProbe,
    );
    const deliveryResumeAt = Date.parse(health.deliveryRetryAfter || "");
    if (Number.isFinite(deliveryResumeAt) && deliveryResumeAt > now()) {
      health.status = "degraded";
      health.checkedAt = timestamp(now);
      health.scheduledUntil = new Date(deliveryResumeAt).toISOString();
      refreshCriticalSlaStatus();
      return { ok: false, skipped: true, scheduled: true };
    }
    const activeSourceState = health.activeSource ? health.sources?.[health.activeSource] : null;
    const activeSourceResumeAt = activeSourceState?.status === "healthy" ? sourceAttemptAt(activeSourceState) : 0;
    const activeSourceIndex = health.activeSource ? bases.indexOf(health.activeSource) : -1;
    const higherPrioritySourceAvailable = activeSourceIndex > 0
      && bases.slice(0, activeSourceIndex).some((base) => sourceAttemptAt(health.sources?.[base]) <= now());
    if (activeSourceResumeAt > now() && activeSourceIndex >= 0 && !higherPrioritySourceAvailable && !criticalDiscoveryAvailable) {
      refreshCriticalSlaStatus();
      health.status = health.activeSource === bases[0]
        ? (isCriticalFastLane(project) && health.slaStatus === "source_limited" ? "degraded" : "healthy")
        : "degraded";
      health.checkedAt = timestamp(now);
      health.scheduledUntil = new Date(activeSourceResumeAt).toISOString();
      health.consecutiveFailures = 0;
      delete health.retryAfter;
      delete health.lastError;
      delete health.lastErrorAt;
      return { ok: false, skipped: true, scheduled: true };
    }
    if (!hasAvailableSource(health, bases, now(), startupRecoveryProbe) && !criticalDiscoveryAvailable) {
      refreshCriticalSlaStatus();
      return { ok: false, skipped: true };
    }

    try {
      const priorCursor = state[key];
      if (isPonFunFastLane(project) && priorCursor?.latestId && !health.gapSince) {
        const inferredGapSince = ponFunRecoveryGapSince(
          health,
          priorCursor,
          now(),
          criticalTweetMaxAgeMs(config, project),
        );
        if (inferredGapSince) {
          health.gapSince = inferredGapSince;
          health.coverage ||= {};
          health.coverage.delayedRecovery = {
            status: "in_progress",
            reason: "stale_durable_coverage_checkpoint",
            gapSince: inferredGapSince,
            startedAt: timestamp(now),
          };
        }
      }
      const result = await fetchTweets(
        project,
        health,
        state[key]?.latestId || null,
        startupRecoveryProbe,
        criticalDeadlineAtMs,
      );
      if (result.auxiliaryOnly) {
        const primarySource = result.source ? health.sources?.[result.source] : null;
        health.status = "degraded";
        health.checkedAt = timestamp(now);
        health.scheduledUntil = primarySource ? new Date(sourceAttemptAt(primarySource)).toISOString() : null;
        health.consecutiveFailures = 0;
        delete health.retryAfter;
        delete health.lastError;
        delete health.lastErrorAt;
        if (!isPonFunFastLane(project)) delete health.gapSince;
        closeAggregateFailureLog(health, project);
        refreshCriticalSlaStatus();
        await persistState(state);
        return { ok: true, skipped: false, auxiliaryOnly: true, degraded: true };
      }
      const tweets = result.tweets.sort((a, b) => compareTweetIds(b.id, a.id));
      const recoveryCursorId = state[key]?.latestId || null;
      const policyRecoveryRecentTweets = recoveryCursorId
        ? tweets.filter((tweet) => compareTweetIds(tweet.id, recoveryCursorId) <= 0)
        : [];
      let previous = state[key];
      let candidates;
      if (previous?.latestId) {
        candidates = tweets.filter((tweet) => compareTweetIds(tweet.id, previous.latestId) > 0).sort((a, b) => compareTweetIds(a.id, b.id));
      } else if (project.backfillOnFirstSeen) {
        const plan = firstSeenPlan(tweets, config, now, (text) => classifyProjectTweet(text, project, config));
        candidates = plan.tweets;
        health.coverage = { ...(health.coverage || {}), firstSeenBackfill: { ...plan.coverage, startedAt: timestamp(now) } };
        if (plan.coverage.omittedRelevant > 0 || plan.coverage.outsideWindowRelevant > 0 || plan.coverage.unscannedItems > 0) {
          logger.error(`[twitter][coverage] @${project.handle}: bounded first-seen coverage omitted=${plan.coverage.omittedRelevant}, outside-window=${plan.coverage.outsideWindowRelevant}, unscanned=${plan.coverage.unscannedItems}; details saved in twitter-state.json`);
        }
      } else if (project.baselineOnFirstSeen) {
        candidates = [];
        if (tweets[0]) {
          previous = {
            latestId: tweets[0].id,
            checkedAt: timestamp(now),
            profile: { name: tweets[0].authorName, handle: tweets[0].handle },
          };
          state[key] = previous;
        }
      } else {
        candidates = tweets[0] ? [tweets[0]] : [];
      }

      const ponRecoveryGap = isPonFunFastLane(project) && previous?.latestId
        ? health.gapSince || null
        : null;
      let ponRecoveryRemaining = false;
      if (ponRecoveryGap && candidates.length) {
        const firstRecoveryTweet = candidates[0];
        const firstRecoveryCreatedAt = Date.parse(firstRecoveryTweet?.createdAt || "");
        const backfillMaxAgeMs = Math.min(
          positiveInteger(config.twitterBackfillMaxAgeMs, DEFAULT_BACKFILL_MAX_AGE_MS),
          DEFAULT_BACKFILL_MAX_AGE_MS,
        );
        if (!Number.isFinite(firstRecoveryCreatedAt) || now() - firstRecoveryCreatedAt > backfillMaxAgeMs) {
          health.coverage ||= {};
          health.coverage.delayedRecovery = {
            ...(health.coverage.delayedRecovery || {}),
            status: "incomplete",
            reason: "oldest_unprocessed_tweet_outside_bounded_recovery_window",
            gapSince: ponRecoveryGap,
            cursorId: previous.latestId,
            blockedTweetId: firstRecoveryTweet?.id || null,
            checkedAt: timestamp(now),
          };
          const error = new Error(`Pon delayed recovery exceeds bounded backfill window at status/${firstRecoveryTweet?.id || "unknown"}`);
          error.code = "TWITTER_PON_RECOVERY_WINDOW_EXCEEDED";
          throw error;
        }
        ponRecoveryRemaining = candidates.length > 1;
        // Exact-status + oEmbed verification is intentionally bounded to one
        // oldest item per cycle. Advancing in ID order makes restart safe and
        // prevents a newer alert from skipping an unverified predecessor.
        candidates = candidates.slice(0, 1);
      }

      let detailRequests = 0;
      let detailDegraded = false;
      const detailLimit = positiveInteger(config.twitterJinaDetailLimit, 4);
      for (const candidateTweet of candidates) {
        let tweet = candidateTweet;
        if (result.sourceId === "jina_reader" && /\bShow more\b/i.test(tweet.text || "")) {
          if (detailRequests < detailLimit) {
            detailRequests += 1;
            try {
              tweet = await enrichJinaTweet(project, tweet, result.source);
              health.detailCoverage = {
                status: "complete",
                checkedAt: timestamp(now),
                lastSuccessAt: timestamp(now),
                tweetId: tweet.id,
              };
            } catch (error) {
              detailDegraded = true;
              tweet = { ...tweet, textTruncated: true, detailError: error.message };
              health.detailCoverage = {
                status: "partial",
                checkedAt: timestamp(now),
                lastError: error.message,
                tweetId: tweet.id,
              };
              logger.error(`[twitter][detail] @${project.handle}/${tweet.id}: ${error.message}`);
            }
          } else {
            detailDegraded = true;
            tweet = { ...tweet, textTruncated: true, detailError: "per-poll detail limit reached" };
          }
        }
        const repositoryText = [tweet.text, ...(tweet.expandedUrls || [])].join("\n");
        const repositories = extractGithubRepositories(repositoryText);
        const repositoryClaim = repositories.length > 0
          && (/\b(?:source|code|contracts?|github|repositor(?:y|ies)|repo)\b/i.test(tweet.text)
            || (tweet.expandedUrls || []).some((url) => /^https:\/\/github\.com\//i.test(url)));
        if (project.match === "official_x" && repositoryClaim) {
          for (const repository of repositories) {
            await onOfficialRepository(repository, {
              source: "official_x",
              url: tweet.url,
              observedAt: timestamp(now),
              launchpad: project.id,
              launchpadName: project.name,
            });
          }
        }
        const criticalMaxAgeMs = criticalTweetMaxAgeMs(config, project);
        const criticalFresh = !isCriticalFastLane(project)
          || isCriticalTweetFresh(tweet, now(), criticalMaxAgeMs);
        const classifiedSignal = classifyProjectTweet(tweet.text, project, config, tweet.expandedUrls);
        const observedAt = timestamp(now);
        const delayedRecovery = !criticalFresh && isPonFunFastLane(project)
          ? ponFunDelayedRecovery(
              classifiedSignal,
              tweet,
              previous,
              ponRecoveryGap,
              observedAt,
              criticalMaxAgeMs,
            )
          : null;
        const signal = criticalFresh || delayedRecovery
          ? classifiedSignal
          : { relevant: false, strong: false, labels: [], reason: "outside_critical_x_freshness_window" };
        if (signal.relevant) {
          const namedMode = signal.namedMode;
          const fourMemeNamedMode = project.id === "fourmeme" && namedMode?.version === 1
            ? {
                mode: {
                  officialName: namedMode.name,
                  componentMode: namedMode.name,
                  parentMode: namedMode.parent,
                },
                productLifecycle: {
                  product: namedMode.id,
                  stage: namedMode.stage,
                  key: `fourmeme:lifecycle:${namedMode.id}:${namedMode.stage}`,
                },
              }
            : {};
          let delivery;
          try {
            if (isCriticalFastLane(project) && !delayedRecovery && now() >= criticalDeadlineAtMs) {
              const error = new Error(`critical X shared delivery SLA expired before sendAlerts for @${project.handle}/status/${tweet.id}`);
              error.code = "TWITTER_CRITICAL_SLA_EXHAUSTED";
              throw error;
            }
            delivery = await sendAlertsImpl(config, {
              type: "twitter_update",
              project,
              tweet,
              signal,
              ...fourMemeNamedMode,
              observedAt,
              ...(delayedRecovery ? { delayedRecovery } : {}),
              ...(deliverySla && !delayedRecovery ? { deliverySla } : {}),
            });
            if (isCriticalFastLane(project) && !delayedRecovery && now() > criticalDeadlineAtMs) {
              const error = new Error(`critical X shared delivery SLA exceeded by sendAlerts for @${project.handle}/status/${tweet.id}`);
              error.code = "TWITTER_CRITICAL_SLA_EXHAUSTED";
              throw error;
            }
          } catch (cause) {
            const error = new Error(`alert delivery failed for @${project.handle}/status/${tweet.id}: ${cause?.message || cause}`);
            error.code = "TWITTER_ALERT_NOT_DURABLE";
            error.cause = cause;
            throw error;
          }
          if (!await isDurablyAcceptedAlert(delivery, { strictPonFun: isPonFunFastLane(project) })) {
            const error = new Error(`alert was not durably accepted for @${project.handle}/status/${tweet.id}`);
            error.code = "TWITTER_ALERT_NOT_DURABLE";
            error.delivery = delivery;
            throw error;
          }
        }
        previous = {
          latestId: tweet.id,
          checkedAt: timestamp(now),
          profile: { name: tweet.authorName, handle: tweet.handle },
        };
        state[key] = previous;
        await persistState(state, { durable: true });
      }

      if (project.id === "fourmeme" && config.fourTwitterPolicyRecoveryEnabled !== false) {
        const recovery = await recoverFourTwitterPolicyFixesImpl({
          config,
          project,
          state,
          recentTweets: policyRecoveryRecentTweets,
          classifyTweetImpl: (text, exactProject, exactConfig, expandedUrls) => (
            classifyProjectTweet(text, exactProject, exactConfig, expandedUrls)
          ),
          verifyExactTweetImpl: async (exactProject, tweetId, sourceTweet) => {
            const [verified] = await verifyCriticalJinaTweets(
              exactProject,
              [{ ...sourceTweet, id: tweetId }],
              criticalTiming?.verifyTimeoutMs || criticalLatencySettings(config).verifyTimeoutMs,
            );
            if (!verified || String(verified.id) !== String(tweetId)) {
              throw new Error(`Four policy recovery exact-status verification missed status/${tweetId}`);
            }
            return verified;
          },
          sendAlertsImpl,
          persistStateImpl: persistState,
          now,
        });
        if (recovery?.recovered?.length) {
          health.coverage ||= {};
          health.coverage.fourPolicyFixRecovery = {
            status: recovery.status,
            recovered: recovery.recovered.map((item) => item.eventKey),
            checkedAt: timestamp(now),
          };
        }
      }

      if (!candidates.length && tweets[0] && previous) {
        state[key] = {
          ...previous,
          checkedAt: timestamp(now),
          profile: { name: tweets[0].authorName, handle: tweets[0].handle },
        };
      }
      if (health.coverage?.firstSeenBackfill?.status === "in_progress") {
        health.coverage.firstSeenBackfill.status = "complete";
        health.coverage.firstSeenBackfill.completedAt = timestamp(now);
      }
      const priorGap = health.gapSince;
      if (health.coverage?.cursorGap?.status === "incomplete") {
        health.coverage.cursorGap = {
          ...health.coverage.cursorGap,
          status: "complete",
          resolvedAt: timestamp(now),
        };
      }
      if (priorGap) {
        health.coverage ||= {};
        health.coverage.delayedRecovery = {
          ...(health.coverage.delayedRecovery || {}),
          status: ponRecoveryRemaining ? "in_progress" : "complete",
          gapSince: priorGap,
          cursorId: state[key]?.latestId || null,
          ...(ponRecoveryRemaining ? { checkedAt: timestamp(now) } : { completedAt: timestamp(now) }),
        };
      }
      refreshCriticalSlaStatus();
      health.status = result.degraded || detailDegraded
        || ponRecoveryRemaining
        || (isCriticalFastLane(project) && health.slaStatus === "source_limited")
        ? "degraded"
        : "healthy";
      health.checkedAt = timestamp(now);
      health.lastSuccessAt = timestamp(now);
      health.activeSource = result.source;
      health.activeSourceId = result.sourceId;
      health.scheduledUntil = health.sources?.[result.source]?.nextPollAt || null;
      health.timelineItems = tweets.length;
      health.consecutiveFailures = 0;
      delete health.retryAfter;
      delete health.lastError;
      delete health.lastErrorAt;
      delete health.deliveryRetryAfter;
      if (!ponRecoveryRemaining) delete health.gapSince;
      if (priorGap && !ponRecoveryRemaining) health.lastGapResolvedAt = timestamp(now);
      closeAggregateFailureLog(health, project);
      await persistState(state);
      return { ok: true };
    } catch (error) {
      const deliveryRetry = error.code === "TWITTER_ALERT_NOT_DURABLE";
      const criticalSlaRetry = error.code === "TWITTER_CRITICAL_SLA_EXHAUSTED"
        || error.cause?.code === "TWITTER_CRITICAL_SLA_EXHAUSTED";
      health.status = deliveryRetry ? "degraded" : error.message.includes("429") || error.message.includes("backoff") ? "backoff" : "error";
      health.checkedAt = timestamp(now);
      health.lastErrorAt = timestamp(now);
      health.lastError = error.message;
      health.consecutiveFailures = Number(health.consecutiveFailures || 0) + 1;
      health.retryAfter = error.retryAfter || new Date(now() + (criticalSlaRetry
        ? criticalFailureMinBackoffMs
        : Math.min(MAX_FAILURE_BACKOFF_MS, DEFAULT_FAILURE_BACKOFF_MS * 2 ** Math.min(health.consecutiveFailures - 1, 5)))).toISOString();
      if (deliveryRetry) health.deliveryRetryAfter = health.retryAfter;
      health.gapSince ||= timestamp(now);
      refreshCriticalSlaStatus();
      logAggregateFailure(health, project, error);
      await persistState(state, { durable: true });
      return { ok: false, skipped: false };
    }
  }

  const runCycle = async () => {
    const schedulerCycleStartedAtMs = now();
    try {
      const [state, dynamic, siteState] = await Promise.all([
        liveState ? Promise.resolve(liveState) : readJson(stateFile, {}),
        readJson(siteWatchlistFile, []),
        readJson(siteStateFile, {}),
      ]);
      if (!liveState) {
        liveState = state;
        requestedControlKey = twitterStateControlKey(state);
        lastStateWriteAtMs = now();
      }
      state._meta ||= {};
      // Migrate away from the legacy global 429 switch. Account health owns backoff now.
      delete state._meta.retryAfter;
      const targets = targetList(Array.isArray(dynamic) ? dynamic : [], siteState, config);
      if (!targets.length) return;
      const startupRecoveryProbe = startupRecoveryProbePending;
      startupRecoveryProbePending = false;
      const priority = targets.filter((project) => project.priority);
      // Free X fallbacks can each occupy a socket until timeout. Bound the
      // priority lane so seven official accounts cannot starve BSC RPC; Flap
      // and Four.Meme remain first in the stable target order.
      const priorityPromise = settleBounded(
        priority,
        positiveInteger(config.twitterPriorityPollConcurrency, 2),
        (project) => pollTarget(project, state, startupRecoveryProbe, schedulerCycleStartedAtMs),
      );

      const standard = targets.filter((project) => !project.priority);
      const selected = [];
      if (standard.length) {
        const configuredConcurrency = positiveInteger(config.twitterStandardPollConcurrency, 3);
        const concurrency = Math.min(configuredConcurrency, standard.length);
        const storedCursor = Number(state._meta.cursor || 0);
        const cursor = Number.isSafeInteger(storedCursor) && storedCursor >= 0 ? storedCursor % standard.length : 0;
        for (let offset = 0; offset < standard.length && selected.length < concurrency; offset += 1) {
          const index = (cursor + offset) % standard.length;
          const candidate = standard[index];
          const health = healthFor(state, candidate);
          if (hasAvailableSource(health, sourceBases(config, candidate), now(), startupRecoveryProbe)) {
            selected.push({ project: candidate, index });
          }
        }
      }

      const standardPromise = Promise.allSettled(selected.map(({ project }) => (
        pollTarget(project, state, startupRecoveryProbe, schedulerCycleStartedAtMs)
      )));
      const [priorityResults, standardResults] = await Promise.all([priorityPromise, standardPromise]);
      for (const [index, result] of priorityResults.entries()) {
        if (result.status === "rejected") logger.error(`[twitter][state-error] @${priority[index].handle}: ${result.reason?.message || result.reason}`);
      }
      for (const [index, result] of standardResults.entries()) {
        if (result.status === "rejected") logger.error(`[twitter][state-error] @${selected[index].project.handle}: ${result.reason?.message || result.reason}`);
      }
      // Advance past every account offered this round. A failing account keeps its own
      // backoff and durable tweet cursor, but cannot stall the shared fair scheduler.
      if (standard.length && selected.length) state._meta.cursor = (selected.at(-1).index + 1) % standard.length;
      updateGlobalHealth(state, targets, now);
      await persistState(state);
    } finally { /* The serialized scheduler owns lifecycle cleanup. */ }
  };

  const check = () => {
    if (stopping) return runningPromise || Promise.resolve();
    if (runningPromise) {
      rerunRequested = true;
      return runningPromise;
    }
    runningPromise = (async () => {
      // Coalesce overlap into at most one immediate catch-up. Otherwise a
      // one-second scheduler can keep this promise alive indefinitely when a
      // degraded source takes longer than the interval.
      for (let cycle = 0; cycle < 2; cycle += 1) {
        rerunRequested = false;
        await runCycle();
        if (stopping || !rerunRequested) break;
      }
      rerunRequested = false;
    })().finally(() => { runningPromise = null; });
    return runningPromise;
  };

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    rerunRequested = false;
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
    stopPromise = (async () => {
      let activeError = null;
      try {
        if (runningPromise) await runningPromise;
      } catch (error) {
        activeError = error;
      }
      const activePersistenceFailure = Boolean(activeError && activeError === lastStateWriteError);
      clearTelemetryFlushTimer();
      clearStateRetryTimer();
      let flushError = null;
      try { await flushTelemetry(); }
      catch (error) { flushError = error; }
      if (retryInFlight) await retryInFlight.catch((error) => { flushError ||= error; });
      if (retryRecord) {
        try { await retryPendingStateWrite(); }
        catch (error) { flushError ||= error; }
      }
      await writeQueue;
      if (retryRecord) throw flushError || activeError || lastStateWriteError
        || new Error("Twitter state persistence did not drain during stop");
      if (activeError && !activePersistenceFailure) throw activeError;
    })();
    return stopPromise;
  };

  if (autoStart) void check().catch((error) => logger.error(`[twitter][scheduler] ${error.message}`));
  const criticalOnly = config.twitterMonitorEnabled === false
    && (config.binanceCriticalXMonitorEnabled === true
      || config.focusCriticalXMonitorEnabled === true
      || config.ponMonitorEnabled === true);
  const schedulerIntervalMs = criticalOnly
    ? criticalLatencySettings(config).schedulerIntervalMs
    : config.twitterPollIntervalMs;
  schedulerTimer = autoStart ? setInterval(() => {
    void check().catch((error) => logger.error(`[twitter][scheduler] ${error.message}`));
  }, schedulerIntervalMs) : null;
  schedulerTimer?.unref();
  return { check, stop, stateFile };
}
