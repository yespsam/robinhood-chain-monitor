import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sendAlerts } from "./alerts.js";

export const TELEGRAM_NEWS_PREVIEW_URL = "https://t.me/s/maxguruai";
export const TELEGRAM_NEWS_CHAT_ID = "-1002540748528";
export const TELEGRAM_NEWS_VIEW_CHAT_ID = -2540748528;
export const TELEGRAM_NEWS_USERNAME = "maxguruai";

const DEFAULT_POLL_INTERVAL_MS = 4_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_MAX_BACKOFF_MS = 15 * 60_000;
const DEFAULT_CHANNEL_TITLE = "@maxguruai";
const MAX_MESSAGES = 2_000;
const MAX_STORIES = 1_000;
const MAX_HEADLINE_LENGTH = 180;
const MAX_SUMMARY_LENGTH = 320;
const MAX_EXTERNAL_URLS = 6;
const STORY_DEDUP_WINDOW_MS = 24 * 60 * 60 * 1_000;
const STORY_ANCHOR_FUTURE_TOLERANCE_MS = 60_000;

// The first line is the editorial claim. Classify it before looking at any
// explanatory prose so a summary mentioning an API/product cannot steal a
// market, macro, listing, or security story through first-match ordering.
const CATEGORY_PATTERNS = [
  ["security", /\b(?:hack(?:ed|ing)?|exploit(?:ed|ing)?|vulnerabilit(?:y|ies)|breach(?:ed)?|attack(?:ed)?|drain(?:ed)?|stolen|theft|compromis(?:e|ed)|phishing|malware|incident|quantum[- ]resistant)\b|黑客|攻击|漏洞|被盗|盗取|入侵|安全事件|钓鱼|恶意软件|宕机|抗量子/i],
  ["listing", /\b(?:will\s+(?:list|delist)|list(?:s|ed|ing)?\s+(?:on|at)|delist(?:s|ed|ing)?|trading\s+(?:is\s+)?(?:now\s+)?live|opens?\s+trading|spot\s+listing|perpetual\s+contract)\b|(?:上币|下架|退市|开放交易|上线交易|合约上线|现货上市)/i],
  ["market", /\b(?:etf\s+(?:inflow|outflow)|inflows?|outflows?|trading\s+volume|transaction\s+count|open\s+interest|liquidations?|market\s+cap|tvl|price\s+(?:breaks?|falls?|rises?|hits?)|all[- ]time\s+high|record\s+(?:high|low)|supply\s+(?:burn|unlock))\b|资金流入|资金流出|交易量|交易笔数|未平仓|清算|市值|锁仓量|价格突破|跌破|创下.{0,12}(?:新高|新低|纪录)|供应量.{0,12}(?:销毁|解锁)/i],
  ["macro", /\b(?:federal reserve|\bfed\b|fomc|central bank|interest rates?|rate (?:cut|hike)|cpi|inflation|payrolls?|gdp|treasur(?:y|ies)|congress|senate|regulat(?:or|ion|ory)|legislation|stablecoin (?:bill|law)|sec|cftc)\b|美联储|央行|利率|降息|加息|通胀|非农|国内生产总值|国会|参议院|监管|法案|立法/i],
  ["governance", /\b(?:governance|proposal|vote|voting|dao|quorum|delegate)\b|治理|提案|投票|法定人数|代表票|重新分配/i],
  ["funding", /\b(?:funding|fundraise|fundraising|raises?|raised|seed round|series [a-f]|investment|acquisition|acquires?|acquired|credit facility)\b|融资|募资|筹集|投资|收购|并购|种子轮|[A-F]轮|信贷额度/i],
  ["on_chain", /\b(?:on[ -]?chain|mainnet|testnet|smart contract|contract deployment|validator|rollup|layer[ -]?2|\bL2\b)\b|链上|主网|测试网|智能合约|验证者|部署合约|二层网络/i],
  ["ai", /\b(?:artificial intelligence|AI|LLM|agentic|AI agents?|agent\s+os|machine learning|GPT|Claude|Gemini|Grok)\b|人工智能|大模型|智能体|机器学习/i],
  ["product", /\b(?:product|feature|wallet|exchange|api|sdk|protocol|integration|upgrade|release|launch)\b|产品|功能|钱包|交易所|接口|协议|集成|升级|发布|推出/i],
  ["crypto", /\b(?:crypto|bitcoin|btc|ethereum|eth|solana|sol|blockchain|token|stablecoin|defi|dex|cex|layer[ -]?1|web3|optimism|arbitrum|bnb chain)\b|加密货币|比特币|以太坊|区块链|代币|稳定币|去中心化金融|公链|币安链/i],
];

const SUBSTANTIVE_ACTION = /\b(?:announce(?:d|s)?|launch(?:ed|es)?|release(?:d|s)?|deploy(?:ed|s)?|upgrade(?:d|s)?|update(?:d|s)?|integrat(?:e|ed|es)|support(?:s|ed)?|approve(?:d|s)?|pass(?:ed|es)?|vote(?:d|s)?|propos(?:e|ed|al)|rais(?:e|ed|es)|fund(?:ed|ing)?|acquir(?:e|ed|es)|exploit(?:ed|ing)?|hack(?:ed)?|breach(?:ed)?|patch(?:ed|es)?|migrat(?:e|ed|es)|reallocat(?:e|ed|es)|suspend(?:ed|s)?|resume(?:d|s)?|enable(?:d|s)?|disable(?:d|s)?|partner(?:ed|s)?|add(?:ed|s)?|remov(?:e|ed|es)|chang(?:e|ed|es)|list(?:s|ed|ing)?|delist(?:s|ed|ing)?|opens?|closes?|halts?|falls?|rises?|hits?|breaks?|exceeds?|provides?)\b|发布|推出|上线|下架|退市|开放交易|部署|升级|更新|集成|支持|通过|批准|投票|提案|融资|募资|筹集|投资|收购|攻击|漏洞|被盗|盗走|修复|迁移|重新分配|暂停|宕机|恢复|启用|禁用|合作|新增|移除|改变|突破|跌破|流入|流出|提供|主网|测试网/i;
const POLITICAL_CONTENT = /\b(?:president|prime minister|trump|biden|election|congress|senate|democrat|republican|geopolitic|tariffs?|ukraine|russia|israel|hamas|war)\b|总统|总理|特朗普|拜登|选举|国会|参议院|民主党|共和党|关税|乌克兰|俄罗斯|以色列|哈马斯|战争|地缘政治/i;
const MARKETING_CONTENT = /\b(?:giveaway|promo(?:tion)?|promo code|discount|limited offer|referral|affiliate|subscribe now|join (?:our|the) (?:group|channel)|follow and retweet|like and share|click here)\b|抽奖|赠品|优惠|折扣|促销码|邀请码|返佣|限时(?:优惠|活动)|关注.{0,12}转发|点赞.{0,12}转发|加入.{0,12}(?:群|频道)|点击领取/i;
const TOKEN_CALL_CONTENT = /\b(?:ape in|buy now|entry price|target price|take profit|stop loss|100x|gem call|pump signal|moonshot)\b|立即买入|现在买入|梭哈|冲土狗|百倍币|目标价|止盈|止损|喊单|金狗|合约地址.{0,8}0x[a-f0-9]{40}|稳赚/i;
const TRANSLATION_FAILURE = /\b(?:translation (?:failed|unavailable|pending)|unable to translate|original text pending)\b|翻译失败|无法翻译|暂无翻译|等待翻译|原文待翻译|无法(?:直接)?访问.{0,20}链接|没有可翻译的(?:文本|内容)|看不到需要(?:翻译|重写)的内容/i;
const CRYPTO_OR_AI_ENTITY = /\b(?:crypto|bitcoin|btc|ethereum|eth|solana|blockchain|token|stablecoin|defi|web3|optimism|arbitrum|bnb chain|artificial intelligence|AI|LLM|agentic|AI agents?|GPT|Claude|Gemini|Grok)\b|加密货币|比特币|以太坊|区块链|代币|稳定币|去中心化金融|公链|人工智能|大模型|智能体/i;
const EDITORIAL_COLLECTION_HEADLINE = /\b(?:daily|weekly|monthly|roundup|recap|digest|newsletter|today(?:'s)?|this\s+week|week\s+in\s+review|quick\s+look|what\s+moved|top\s+\d+|best\s+\d*|rankings?|listicle|seo|aeo|guide|explainer|review|comparison|everything\s+you\s+need\s+to\s+know)\b|(?:每日|日报|日更|每周|周报|本周|月报|今日|今天|速览|一览|摘要|回顾|盘点|合集|榜单|排行|排名|新鲜洞察|隔夜|导读|指南|科普|测评|对比|最佳|SEO|AEO)/i;
const PAYMENT_CARD_HEADLINE = /\b(?:(?:crypto|debit|credit|payment|consumer|bank)\s+)?cards?\b|(?:加密卡|支付卡|借记卡|信用卡|消费卡|银行卡|卡片)/i;
const BULLET_LINE = /^(?:[-*•▪◦‣→]|\d{1,2}[.)、]|[一二三四五六七八九十]+[、.])/u;
const STAGE_PATTERNS = [
  ["patched", /\b(?:patch(?:ed)?|fixed|remediat(?:ed|ion))\b|修复|补丁/i],
  ["resumed", /\b(?:resum(?:e|ed)|restor(?:e|ed)|back\s+online|reopen(?:ed)?)\b|恢复|重新开放/i],
  ["paused", /\b(?:paus(?:e|ed)|suspend(?:ed)?|halt(?:ed)?|outage|offline)\b|暂停|中止|宕机|停止/i],
  ["rejected", /\b(?:reject(?:ed)?|fail(?:ed)?\s+(?:to\s+)?pass|veto(?:ed)?)\b|否决|驳回|未通过/i],
  ["approved", /\b(?:approv(?:e|ed)|pass(?:ed)?|adopt(?:ed)?)\b|通过|批准|获批/i],
  ["scheduled", /\b(?:will\s+(?:launch|list|delist|open)|scheduled|upcoming|set\s+to|plans?\s+to)\b|将于|计划|预定|拟于/i],
  ["live", /\b(?:is\s+(?:now\s+)?live|goes?\s+live|launched|released|deployed|available\s+now|opens?\s+trading)\b|正式上线|已上线|现已开放|已经发布|完成部署/i],
  ["proposed", /\b(?:propos(?:e|ed|al)|draft|consultation)\b|提案|草案|征求意见/i],
  ["incident", /\b(?:hack(?:ed)?|exploit(?:ed|ing)?|breach(?:ed)?|attack(?:ed)?|drain(?:ed)?|stolen|theft|incident)\b|黑客|攻击|被盗|盗走|安全事件/i],
];

const nowMilliseconds = (now) => {
  const value = typeof now === "function" ? now() : now;
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw new Error("Telegram news monitor now() returned an invalid timestamp");
  return milliseconds;
};

const iso = (milliseconds) => new Date(milliseconds).toISOString();

const decodeEntity = (entity) => {
  const named = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ",
    ndash: "–", mdash: "—", hellip: "…",
  };
  if (entity[0] === "#") {
    const hexadecimal = /^#x/i.test(entity);
    const codePoint = Number.parseInt(entity.slice(hexadecimal ? 2 : 1), hexadecimal ? 16 : 10);
    if (Number.isSafeInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff) {
      try { return String.fromCodePoint(codePoint); } catch {}
    }
    return `&${entity};`;
  }
  return named[entity.toLowerCase()] ?? `&${entity};`;
};

const decodeHtml = (value) => String(value || "").replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z][a-z0-9]+);/gi, (_match, entity) => decodeEntity(entity));

const normalizeLines = (value) => String(value || "")
  .split(/\n+/)
  .map((line) => line.replace(/\s+/g, " ").trim())
  .filter(Boolean)
  .join("\n")
  .trim();

const visibleText = (html) => normalizeLines(decodeHtml(String(html || "")
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
  .replace(/<br\s*\/?>/gi, "\n")
  .replace(/<\/(?:p|li|blockquote|h[1-6])>/gi, "\n")
  .replace(/<[^>]+>/g, " ")));

const truncate = (value, maximum) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
};

const attributes = (tag) => Object.fromEntries([...String(tag || "").matchAll(/\b([:\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)]
  .map((match) => [match[1].toLowerCase(), decodeHtml(match[2] ?? match[3] ?? "")]));

const classNames = (tag) => new Set(String(attributes(tag).class || "").split(/\s+/).filter(Boolean));

const strictIso = (value) => {
  if (!value || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(String(value))) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
};

const decodeDataView = (value) => {
  const encoded = String(value || "");
  if (!/^[A-Za-z0-9_-]{8,2048}={0,2}$/.test(encoded)) return null;
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

const messageTextHtml = (block) => {
  for (const match of String(block).matchAll(/<div\b[^>]*>/gi)) {
    if (!classNames(match[0]).has("js-message_text")) continue;
    const start = (match.index || 0) + match[0].length;
    const end = block.indexOf("</div>", start);
    return end >= start ? block.slice(start, end) : null;
  }
  return null;
};

const canonicalExternalUrl = (value) => {
  try {
    const url = new URL(String(value || "").trim());
    const hostname = url.hostname.toLowerCase();
    const ipLiteral = /^\[.*\]$/.test(hostname) || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname);
    if (url.protocol !== "https:" || url.username || url.password || url.port
      || !hostname.includes(".") || ipLiteral
      || /(?:^|\.)(?:localhost|local|internal)$/i.test(hostname)
      || /^(?:www\.)?(?:t\.me|telegram\.me)$/i.test(hostname)) return null;
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/^(?:utm_.+|fbclid|gclid|ref|ref_src)$/i.test(key)) url.searchParams.delete(key);
    }
    const result = url.toString();
    return result.length <= 600 ? result : null;
  } catch {
    return null;
  }
};

const externalUrlsFromHtml = (html) => [...new Set([...String(html || "").matchAll(/<a\b[^>]*\bhref=(?:"([^"]+)"|'([^']+)')[^>]*>/gi)]
  .map((match) => canonicalExternalUrl(decodeHtml(match[1] ?? match[2] ?? "")))
  .filter(Boolean))].slice(0, MAX_EXTERNAL_URLS);

const channelTitleFromPage = (html) => {
  const match = String(html || "").match(/<div\b[^>]*class=(?:"[^"]*\btgme_channel_info_header_title\b[^"]*"|'[^']*\btgme_channel_info_header_title\b[^']*')[^>]*>([\s\S]*?)<\/div>/i);
  return truncate(visibleText(match?.[1] || ""), 120) || DEFAULT_CHANNEL_TITLE;
};

const digestContent = (text, urls) => createHash("sha256")
  .update(`${normalizeLines(text)}\n${urls.join("\n")}`)
  .digest("hex");

/**
 * Parse Telegram's public preview without trusting its visible handle. Every
 * accepted card must independently prove the fixed numeric channel in
 * data-view and the exact username/message tuple in data-post.
 */
export function parseTelegramPublicPreview(html) {
  const source = String(html || "");
  const openings = [...source.matchAll(/<div\b[^>]*>/gi)]
    .filter((match) => classNames(match[0]).has("js-widget_message") && attributes(match[0])["data-post"]);
  const title = channelTitleFromPage(source);
  const records = [];

  for (let index = 0; index < openings.length; index += 1) {
    const opening = openings[index];
    const attrs = attributes(opening[0]);
    const post = String(attrs["data-post"] || "");
    const postMatch = post.match(/^maxguruai\/(\d+)$/);
    if (!postMatch) continue;
    const messageId = Number(postMatch[1]);
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || `${messageId}` !== postMatch[1]) continue;
    const view = decodeDataView(attrs["data-view"]);
    if (!view || !Number.isSafeInteger(view.c) || view.c !== TELEGRAM_NEWS_VIEW_CHAT_ID
      || !Number.isSafeInteger(view.p) || view.p !== messageId) continue;

    const start = opening.index || 0;
    const end = openings[index + 1]?.index ?? source.length;
    const block = source.slice(start, end);
    const textHtml = messageTextHtml(block);
    const text = visibleText(textHtml || "");
    const sourceOccurredAt = strictIso(block.match(/<time\b[^>]*\bdatetime=(?:"([^"]+)"|'([^']+)')/i)?.slice(1).find(Boolean));
    if (!textHtml || !text || !sourceOccurredAt) continue;
    const externalUrls = externalUrlsFromHtml(textHtml);
    records.push({
      messageId,
      messageUrl: `https://t.me/${TELEGRAM_NEWS_USERNAME}/${messageId}`,
      sourceOccurredAt,
      text,
      externalUrls,
      contentDigest: digestContent(text, externalUrls),
      channelTitle: title,
    });
  }

  return [...new Map(records.map((record) => [record.messageId, record])).values()]
    .sort((left, right) => left.messageId - right.messageId);
}

const cleanHeadlineLine = (value) => String(value || "")
  .replace(/\*{0,2}(?:链接|link|source|原文)\*{0,2}\s*$/i, "")
  .replace(/[\s–—-]+$/g, "")
  .replace(/^\s*(?:breaking|快讯|突发)\s*[：:]\s*/i, "")
  .trim();

const splitHeadlineAndSummary = (text) => {
  const lines = normalizeLines(text).split("\n").filter(Boolean);
  let headline = cleanHeadlineLine(lines.shift() || "");
  let remainder = lines.join(" ").trim();
  if (!remainder && headline.length > 60) {
    const boundary = [...headline.matchAll(/[。！？.!?](?:\s|$)/g)]
      .map((match) => (match.index || 0) + match[0].trimEnd().length)
      .find((position) => position >= 20 && position <= MAX_HEADLINE_LENGTH);
    const splitAt = boundary || Math.min(MAX_HEADLINE_LENGTH, Math.max(40, Math.floor(headline.length * 0.38)));
    remainder = headline.slice(splitAt).trim();
    headline = headline.slice(0, splitAt).trim();
  } else if (headline.length > MAX_HEADLINE_LENGTH) {
    remainder = `${headline.slice(MAX_HEADLINE_LENGTH)} ${remainder}`.trim();
    headline = headline.slice(0, MAX_HEADLINE_LENGTH).trim();
  }
  const summary = truncate(remainder.replace(/^重要性\s*[：:]\s*/i, "重要性："), MAX_SUMMARY_LENGTH);
  return { headline: truncate(headline, MAX_HEADLINE_LENGTH), summary };
};

const categoryFor = (headline) => CATEGORY_PATTERNS.find(([, pattern]) => pattern.test(headline))?.[0] || null;

const stageFor = (headline) => STAGE_PATTERNS.find(([, pattern]) => pattern.test(headline))?.[0] || "observed";

const semanticHeadline = (headline) => String(headline || "")
  .normalize("NFKC")
  .toLowerCase()
  .replace(/https?:\/\/\S+/g, " ")
  .replace(/\b(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, " # ")
  .replace(/(?:[$€£¥]|usd|usdt|usdc|btc|eth)?\s*\d[\d,.]*(?:\s*(?:million|billion|trillion|m|bn|k|万|亿|%))?/gi, " # ")
  .replace(/(?:链接|link|source|原文)$/i, " ")
  .replace(/[^\p{L}\p{N}#]+/gu, " ")
  .replace(/\s+/g, " ")
  .trim();

const NUMERIC_STORY_CATEGORIES = new Set([
  "market", "macro", "funding", "security", "listing", "on_chain", "product", "governance", "ai", "crypto",
]);
const SIGNIFICANT_NUMERIC_FACT = /(?:(?:[$€£¥]|usd|usdt|usdc|fdusd|tusd|cny|rmb|eur|gbp|jpy|btc|eth|bnb|sol)\s*)?[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:\s*(?:%|percent(?:age)?|pct|basis\s+points?|bps?|k|m|b|bn|tn|million|billion|trillion|万|亿|万亿|usd|usdt|usdc|fdusd|tusd|cny|rmb|eur|gbp|jpy|btc|eth|bnb|sol|dollars?|美元|美金|人民币|元|枚(?:代币)?|个代币))?/giu;

const numericStorySignature = (category, headline) => {
  if (!NUMERIC_STORY_CATEGORIES.has(category)) return "";
  // Calendar formatting is distribution metadata; amounts, percentages,
  // version digits, proposal IDs, and alphanumeric ticker suffixes are story
  // identity. Strip full dates before extracting every remaining number.
  const numericSource = String(headline || "").normalize("NFKC")
    .replace(/\b(?:19|20)\d{2}[-/.]\d{1,2}[-/.]\d{1,2}\b/g, " ");
  const facts = numericSource.match(SIGNIFICANT_NUMERIC_FACT) || [];
  return [...new Set(facts.map((fact) => fact
    .toLowerCase()
    .replace(/percentage|percent|pct/g, "%")
    .replace(/basis\s+points?|bps?/g, "bp")
    .replace(/trillion/g, "tn")
    .replace(/billion/g, "bn")
    .replace(/million/g, "m")
    .replace(/dollars?|美元|美金/g, "usd")
    .replace(/人民币/g, "cny")
    .replace(/[\s,]+/g, "")))].join("|");
};

const storyKeyFor = (category, stage, headline) => {
  // URLs are mutable distribution metadata, not story identity. Key the
  // subject/action wording plus lifecycle stage so mirrors collapse while a
  // genuine proposed→approved or incident→patched transition stays distinct.
  const numericSignature = numericStorySignature(category, headline);
  const evidence = `${category}:${stage}:${semanticHeadline(headline)}${numericSignature ? `:numbers:${numericSignature}` : ""}`;
  return `telegram-news:${category}:${stage}:${createHash("sha256").update(evidence).digest("hex").slice(0, 24)}`;
};

const collectionReason = (text, headline, externalUrls) => {
  if (PAYMENT_CARD_HEADLINE.test(headline)) return "card_content";
  if (EDITORIAL_COLLECTION_HEADLINE.test(headline)) return "editorial_collection";
  if (externalUrls.length >= 3) return "multi_topic_collection";
  const bulletCount = normalizeLines(text).split("\n").filter((line) => BULLET_LINE.test(line)).length;
  const numberedItems = (text.match(/(?:^|\n)\s*(?:\d{1,2}[.)、]|[一二三四五六七八九十]+[、.])/gu) || []).length;
  if (bulletCount >= 3 || numberedItems >= 3) return "multi_topic_collection";
  return null;
};

export function classifyTelegramNews(record) {
  const text = normalizeLines(record?.text || "");
  const externalUrls = Array.isArray(record?.externalUrls)
    ? [...new Set(record.externalUrls.map(canonicalExternalUrl).filter(Boolean))].slice(0, MAX_EXTERNAL_URLS)
    : [];
  if (text.length < 60) return { accepted: false, reason: "insufficient_content" };
  if (TRANSLATION_FAILURE.test(text)) return { accepted: false, reason: "translation_failed" };
  if (POLITICAL_CONTENT.test(text) && !CRYPTO_OR_AI_ENTITY.test(text)) return { accepted: false, reason: "politics" };
  if (MARKETING_CONTENT.test(text)) return { accepted: false, reason: "marketing" };
  if (TOKEN_CALL_CONTENT.test(text)) return { accepted: false, reason: "token_call" };
  const { headline, summary } = splitHeadlineAndSummary(text);
  const rejectedCollection = collectionReason(text, headline, externalUrls);
  if (rejectedCollection) return { accepted: false, reason: rejectedCollection };
  const category = categoryFor(headline);
  if (!category || !SUBSTANTIVE_ACTION.test(headline)) return { accepted: false, reason: "not_substantive_news" };
  if (headline.length < 8 || summary.length < 24 || headline.toLowerCase() === summary.toLowerCase()) {
    return { accepted: false, reason: "insufficient_story_fields" };
  }
  const stage = stageFor(headline);
  return {
    accepted: true,
    news: {
      category,
      stage,
      headline,
      summary,
      externalUrls,
      storyKey: storyKeyFor(category, stage, headline),
      confidence: "observed",
    },
  };
}

const emptyHealth = () => ({
  status: "idle",
  consecutiveFailures: 0,
  lastAttemptAt: null,
  lastSuccessAt: null,
  lastErrorAt: null,
  lastError: null,
  nextAttemptAt: null,
  lastResponseStatus: null,
});

const emptyState = () => ({
  version: 1,
  initializedAt: null,
  identity: {
    chatId: TELEGRAM_NEWS_CHAT_ID,
    username: TELEGRAM_NEWS_USERNAME,
    visibility: "public",
  },
  messages: {},
  stories: {},
  http: { etag: null, lastModified: null },
  health: emptyHealth(),
});

const validDigest = (value) => /^[a-f0-9]{64}$/.test(String(value || ""));

const recentStoryAnchor = (record, observedAt) => {
  const anchorAt = Date.parse(record?.lastSeenAt || "");
  const current = Date.parse(observedAt || "");
  if (!Number.isFinite(anchorAt) || !Number.isFinite(current)) return false;
  const ageMs = current - anchorAt;
  return ageMs >= -STORY_ANCHOR_FUTURE_TOLERANCE_MS && ageMs <= STORY_DEDUP_WINDOW_MS;
};

const boundedMap = (object, maximum, keySelector) => Object.fromEntries(Object.entries(object || {})
  .sort((left, right) => keySelector(right).localeCompare(keySelector(left)))
  .slice(0, maximum));

const normalizeState = (loaded) => {
  const base = emptyState();
  const messages = Object.fromEntries(Object.entries(loaded?.messages || {}).filter(([messageId, record]) => {
    const numericId = Number(messageId);
    return Number.isSafeInteger(numericId) && numericId > 0 && validDigest(record?.digest);
  }).map(([messageId, record]) => [messageId, {
    digest: record.digest,
    sourceOccurredAt: strictIso(record.sourceOccurredAt),
    accepted: record.accepted === true,
    ...(record.category ? { category: truncate(record.category, 40) } : {}),
    ...(record.stage ? { stage: truncate(record.stage, 40) }
      : record.accepted === true && record.headline ? { stage: stageFor(record.headline) } : {}),
    ...(record.headline ? { headline: truncate(record.headline, MAX_HEADLINE_LENGTH) } : {}),
    ...(record.summary ? { summary: truncate(record.summary, MAX_SUMMARY_LENGTH) } : {}),
    ...(record.storyKey ? { storyKey: truncate(record.storyKey, 100) } : {}),
  }]));
  const stories = Object.fromEntries(Object.entries(loaded?.stories || {}).filter(([storyKey, record]) => (
    storyKey.length <= 100 && Number.isSafeInteger(Number(record?.messageId)) && validDigest(record?.digest)
  )).map(([storyKey, record]) => [storyKey, {
    messageId: Number(record.messageId),
    digest: record.digest,
    lastSeenAt: strictIso(record.lastSeenAt),
  }]));
  return {
    ...base,
    version: 1,
    initializedAt: strictIso(loaded?.initializedAt),
    messages: boundedMap(messages, MAX_MESSAGES, ([id]) => String(Number(id)).padStart(20, "0")),
    stories: boundedMap(stories, MAX_STORIES, ([, record]) => String(record.lastSeenAt || "")),
    http: {
      etag: typeof loaded?.http?.etag === "string" ? truncate(loaded.http.etag, 500) : null,
      lastModified: typeof loaded?.http?.lastModified === "string" ? truncate(loaded.http.lastModified, 500) : null,
    },
    health: { ...emptyHealth(), ...(loaded?.health || {}) },
  };
};

export async function atomicWriteTelegramNewsState(file, value, fsImpl = fs) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fsImpl.rename(temporary, file);
  } catch (error) {
    try { await fsImpl.unlink?.(temporary); } catch {}
    throw error;
  }
}

const responseHeader = (response, name) => {
  const value = response?.headers?.get?.(name) ?? response?.headers?.get?.(name.toLowerCase())
    ?? response?.headers?.[name] ?? response?.headers?.[name.toLowerCase()];
  return typeof value === "string" && value.trim() ? value.trim() : null;
};

const retryAfterMilliseconds = (value, current) => {
  if (!value) return null;
  if (/^\d+$/.test(value)) return Number(value) * 1_000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - current) : null;
};

const due = (health, current) => !health?.nextAttemptAt || (Date.parse(health.nextAttemptAt) || 0) <= current;

export function createTelegramNewsMonitor(config = {}, dependencies = {}) {
  if (!config.dataDir && !dependencies.stateFile) throw new Error("Telegram news monitor requires config.dataDir or dependencies.stateFile");
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const alertSender = dependencies.sendAlertsImpl || sendAlerts;
  const fsImpl = dependencies.fsImpl || fs;
  const now = dependencies.now || Date.now;
  const logger = dependencies.logger || console;
  const autoStart = dependencies.autoStart !== false;
  const stateFile = dependencies.stateFile || path.join(config.dataDir, "telegram-news-state.json");
  const pollIntervalMs = Math.min(5_000, Math.max(3_000, Number(config.telegramNewsPollIntervalMs) || DEFAULT_POLL_INTERVAL_MS));
  const requestTimeoutMs = Math.min(5_000, Math.max(1_000, Number(config.telegramNewsRequestTimeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS));
  const maximumBackoffMs = Math.max(60_000, Number(config.telegramNewsMaxBackoffMs) || DEFAULT_MAX_BACKOFF_MS);
  let state = emptyState();
  let initialized = false;
  let running = false;
  let activeCheckPromise = null;
  let stopped = false;
  let stopPromise = null;
  let timer = null;
  let writeQueue = Promise.resolve();

  const save = () => {
    writeQueue = writeQueue.catch(() => {}).then(() => atomicWriteTelegramNewsState(stateFile, state, fsImpl));
    return writeQueue;
  };

  const initialize = async () => {
    if (initialized) return;
    try {
      state = normalizeState(JSON.parse(await fsImpl.readFile(stateFile, "utf8")));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    initialized = true;
  };

  const remember = (record, classification, observedAt) => {
    state.messages[String(record.messageId)] = {
      digest: record.contentDigest,
      sourceOccurredAt: record.sourceOccurredAt,
      accepted: classification?.accepted === true,
      ...(classification?.news ? {
        category: classification.news.category,
        stage: classification.news.stage,
        headline: classification.news.headline,
        summary: classification.news.summary,
        storyKey: classification.news.storyKey,
      } : {}),
    };
    const existingStory = classification?.news ? state.stories[classification.news.storyKey] : null;
    if (classification?.news && (!existingStory
      || existingStory.messageId === record.messageId
      || !recentStoryAnchor(existingStory, observedAt))) {
      state.stories[classification.news.storyKey] = {
        messageId: record.messageId,
        digest: record.contentDigest,
        lastSeenAt: observedAt,
      };
    }
    state.messages = boundedMap(state.messages, MAX_MESSAGES, ([id]) => String(Number(id)).padStart(20, "0"));
    state.stories = boundedMap(state.stories, MAX_STORIES, ([, item]) => String(item.lastSeenAt || ""));
  };

  const eventFor = (record, news, observedAt) => ({
    type: "telegram_news_update",
    eventKey: `telegram-news:${TELEGRAM_NEWS_CHAT_ID}:${record.messageId}:${record.contentDigest.slice(0, 16)}`,
    source: {
      id: "telegram_public_channel",
      name: `Telegram 公开频道 · @${TELEGRAM_NEWS_USERNAME}`,
      url: TELEGRAM_NEWS_PREVIEW_URL,
      trust: "public_telegram_observed",
    },
    sourceTrust: "public_telegram_observed",
    channel: {
      chatId: TELEGRAM_NEWS_CHAT_ID,
      username: TELEGRAM_NEWS_USERNAME,
      title: record.channelTitle || DEFAULT_CHANNEL_TITLE,
      visibility: "public",
    },
    chatId: TELEGRAM_NEWS_CHAT_ID,
    username: TELEGRAM_NEWS_USERNAME,
    title: news.headline,
    messageId: record.messageId,
    messageUrl: record.messageUrl,
    sourceOccurredAt: record.sourceOccurredAt,
    news,
    contentDigest: record.contentDigest,
    strong: false,
    observedAt,
  });

  const markHealthy = (current, status = 200) => {
    state.health.status = "healthy";
    state.health.consecutiveFailures = 0;
    state.health.lastSuccessAt = iso(current);
    state.health.lastError = null;
    state.health.nextAttemptAt = iso(current + pollIntervalMs);
    state.health.lastResponseStatus = status;
  };

  const markFailure = (error, current, status = null, retryAfter = null) => {
    state.health.consecutiveFailures = Number(state.health.consecutiveFailures || 0) + 1;
    const exponential = Math.min(maximumBackoffMs, pollIntervalMs * (2 ** Math.max(0, state.health.consecutiveFailures - 1)));
    const waitMs = Math.max(pollIntervalMs, retryAfter ?? exponential);
    state.health.status = status === 403 || status === 429 ? "rate_limited" : "backoff";
    state.health.lastErrorAt = iso(current);
    state.health.lastError = truncate(error?.message || error, 300);
    state.health.nextAttemptAt = iso(current + waitMs);
    state.health.lastResponseStatus = status;
  };

  const runCheckCycle = async () => {
    running = true;
    try {
      await initialize();
      const current = nowMilliseconds(now);
      const observedAt = iso(current);
      if (!due(state.health, current)) return { skipped: true, reason: "circuit_open", nextAttemptAt: state.health.nextAttemptAt };
      state.health.status = "checking";
      state.health.lastAttemptAt = observedAt;
      await save();

      const headers = {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "robinhood-chain-monitor/telegram-public-news",
        ...(state.http.etag ? { "if-none-match": state.http.etag } : {}),
        ...(state.http.lastModified ? { "if-modified-since": state.http.lastModified } : {}),
      };
      const response = await fetchImpl(TELEGRAM_NEWS_PREVIEW_URL, {
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      const status = Number(response?.status || 0);
      if (status === 304) {
        if (!state.initializedAt) {
          state.http.etag = null;
          state.http.lastModified = null;
          throw new Error("Telegram preview returned 304 before a verified baseline");
        }
        markHealthy(current, 304);
        await save();
        return { ok: true, notModified: true };
      }
      if (status === 403 || status === 429) {
        const retryAfter = retryAfterMilliseconds(responseHeader(response, "retry-after"), current);
        markFailure(new Error(`Telegram preview HTTP ${status}`), current, status, retryAfter ?? 60_000);
        await save();
        return { ok: false, reason: `http_${status}`, nextAttemptAt: state.health.nextAttemptAt };
      }
      if (!response?.ok) throw Object.assign(new Error(`Telegram preview HTTP ${status || "unknown"}`), { status });
      if (response.url) {
        const finalUrl = new URL(response.url);
        if (finalUrl.origin !== "https://t.me" || finalUrl.pathname.replace(/\/+$/, "") !== "/s/maxguruai") {
          throw new Error("Telegram preview redirected outside the fixed public channel");
        }
      }
      const contentType = responseHeader(response, "content-type");
      if (contentType && !/\btext\/html\b/i.test(contentType)) throw new Error("Telegram preview returned a non-HTML response");
      const html = await response.text();
      const records = parseTelegramPublicPreview(html);
      if (!records.length) throw new Error("Telegram preview identity verification produced no valid messages");

      if (!state.initializedAt) {
        if (records.length) {
          for (const record of records) remember(record, classifyTelegramNews(record), observedAt);
          state.initializedAt = observedAt;
        }
      } else {
        for (const record of records) {
          const previous = state.messages[String(record.messageId)];
          if (previous?.digest === record.contentDigest) continue;
          const classification = classifyTelegramNews(record);
          if (!classification.accepted) {
            remember(record, classification, observedAt);
            await save();
            continue;
          }
          const sameMessageStage = previous?.accepted === true
            && previous.stage === classification.news.stage;
          const storyAnchor = state.stories[classification.news.storyKey];
          const duplicateStory = recentStoryAnchor(storyAnchor, observedAt) ? storyAnchor : null;
          if (!sameMessageStage && !duplicateStory) {
            await alertSender(config, eventFor(record, classification.news, observedAt));
          }
          remember(record, classification, observedAt);
          await save();
        }
      }

      // Conditional validators are advanced only after every new revision has
      // been durably enqueued or deliberately classified as non-news.
      state.http.etag = responseHeader(response, "etag") || state.http.etag;
      state.http.lastModified = responseHeader(response, "last-modified") || state.http.lastModified;
      markHealthy(current, status || 200);
      await save();
      return { ok: true, count: records.length, initialized: Boolean(state.initializedAt) };
    } catch (error) {
      const current = nowMilliseconds(now);
      markFailure(error, current, Number(error?.status || 0) || null);
      await save();
      logger.error?.(`[telegram-news] ${error.message}`);
      return { ok: false, error: error.message };
    } finally {
      running = false;
    }
  };

  const check = () => {
    if (stopped) return activeCheckPromise || Promise.resolve({ skipped: true, reason: "stopped" });
    if (activeCheckPromise) return Promise.resolve({ skipped: true, reason: "running" });
    activeCheckPromise = runCheckCycle().finally(() => {
      activeCheckPromise = null;
    });
    return activeCheckPromise;
  };

  if (autoStart) {
    void check();
    timer = setInterval(() => { void check(); }, pollIntervalMs);
    timer.unref?.();
  }

  return {
    check,
    state: () => state,
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      const inFlight = [activeCheckPromise, writeQueue].filter(Boolean);
      stopPromise = Promise.allSettled(inFlight).then(() => undefined);
      return stopPromise;
    },
  };
}
