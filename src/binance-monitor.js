import fs from "node:fs/promises";
import path from "node:path";
import { createHash, createHmac, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { sendAlerts } from "./alerts.js";

export const BINANCE_ANNOUNCEMENT_URLS = [
  "https://www.binance.com/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=50",
  "https://www.binance.info/bapi/composite/v1/public/cms/article/list/query?type=1&pageNo=1&pageSize=50",
];
export const BINANCE_ANNOUNCEMENT_DETAIL_BASE_URLS = [
  "https://www.binance.com/bapi/composite/v1/public/cms/article/detail/query?articleCode=",
  "https://www.binance.info/bapi/composite/v1/public/cms/article/detail/query?articleCode=",
];
export const BINANCE_LAUNCHPOOL_URLS = [
  "https://www.binance.com/bapi/earn/v1/public/launchpool/project/list",
  "https://www.binance.info/bapi/earn/v1/public/launchpool/project/list",
];
export const BINANCE_MEME_RUSH_URL = "https://web3.binance.com/bapi/defi/v1/public/wallet-direct/buw/wallet/market/token/pulse/rank/list/ai";
export const BINANCE_SKILLS_URL = "https://www.binance.com/en/skills/detail/binance-web3/meme-rush";
export const BINANCE_SQUARE_PROFILE_URL = "https://www.binance.com/en/square/profile/binance_square_official";
export const BINANCE_SQUARE_FEED_URL = "https://www.binance.com/bapi/composite/v2/friendly/pgc/content/queryUserProfilePageContentsWithFilter?targetSquareUid=Na1B6PUjBNGQfhvh1T_yig&timeOffset=-1&filterType=ALL";
export const BINANCE_DEVELOPER_DOC_URLS = [
  "https://developers.binance.com/en/docs/llms.txt",
  "https://developers.binance.com/en/docs/agent-native/overview.md",
  "https://developers.binance.com/en/docs/agent-native/mcp-server.md",
  "https://developers.binance.com/en/docs/agent-native/mcp-server/agentic.md",
  "https://developers.binance.com/en/docs/products/wallet/change-log.md",
  "https://developers.binance.com/en/docs/products/alpha/change-log.md",
  "https://developers.binance.com/en/docs/products/copy-trading/change-log.md",
  "https://developers.binance.com/en/docs/products/w3w-prediction/change-log.md",
  "https://developers.binance.com/en/docs/products/spot/CHANGELOG.md",
  "https://developers.binance.com/en/docs/products/announcements/cms-log.md",
  "https://developers.binance.com/en/docs/products/wallet-skills/supported-skills.md",
];
export const BINANCE_AGENT_NATIVE_DOC_URLS = BINANCE_DEVELOPER_DOC_URLS.filter((url) => (
  url.endsWith("/llms.txt") || url.includes("/agent-native/")
));
const BINANCE_GENERAL_DEVELOPER_DOC_URLS = BINANCE_DEVELOPER_DOC_URLS.filter((url) => (
  !BINANCE_AGENT_NATIVE_DOC_URLS.includes(url)
));
export const BINANCE_AGENT_OS_PAGE_URL = "https://www.binance.com/agent-os";
export const BINANCE_AGENT_OS_READER_URL = "https://r.jina.ai/http://www.binance.com/en/agent-os";
export const BINANCE_ANNOUNCEMENT_STREAM_URL = "wss://api.binance.com/sapi/wss";
export const BINANCE_ANNOUNCEMENT_STREAM_TOPIC = "com_announcement_en";

export const DEFAULT_MEME_RUSH_TARGETS = [
  { chainId: "56", rankType: 10 },
  { chainId: "CT_501", rankType: 10 },
  { chainId: "8453", rankType: 10 },
  { chainId: "56", rankType: 20 },
  { chainId: "CT_501", rankType: 20 },
  { chainId: "8453", rankType: 20 },
  { chainId: "56", rankType: 30 },
  { chainId: "CT_501", rankType: 30 },
  { chainId: "8453", rankType: 30 },
];
const MEME_RUSH_PAGE_LIMIT = 200;
export const MEME_RUSH_TOKEN_INDEX_LIMIT = 3_000;

const PROTOCOL_NAMES = new Map([
  ["1001", "Pump.fun"],
  ["1002", "Moonit"],
  ["1003", "Pump AMM"],
  ["1004", "Launch Lab"],
  ["1005", "Raydium V4"],
  ["1006", "Raydium CPMM"],
  ["1007", "Raydium CLMM"],
  ["1008", "BONK"],
  ["1009", "Dynamic BC"],
  ["1010", "Moonshot"],
  ["1011", "Jup Studio"],
  ["1012", "Bags"],
  ["1013", "Believer"],
  ["1014", "Meteora DAMM V2"],
  ["1015", "Meteora Pools"],
  ["1016", "Orca"],
  ["2001", "Four.Meme"],
  ["2002", "Flap"],
  ["2004", "OpenFour (Four.Meme)"],
  ["3001", "Clanker"],
  ["3002", "Doppler"],
  ["3003", "Zora Creator Coin"],
  ["3004", "Zora Content Coin"],
  ["3006", "Flaunch"],
  ["3009", "Virtuals"],
  ["3010", "Base B20"],
]);
const DOCUMENTED_MEME_RUSH_PROTOCOLS = new Set([
  "1001", "1002", "1003", "1004", "1005", "1006", "1007", "1008", "1009", "1010", "1011", "1012", "1013", "1014", "1015", "1016", "2001", "2002",
]);

const BINANCE_CATALOGS = Object.freeze({
  listing: 48,
  news: 49,
  activities: 93,
  fiat: 50,
  delisting: 161,
  maintenance: 157,
  api: 51,
  airdrop: 128,
});
const PRODUCT_ACTION = /\b(?:introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)?|announce(?:s|d|ment)?|updates?|updated|updating|enhanc(?:e|es|ed|ing)|rolls?\s+out|releas(?:e|es|ed|ing)|deploy(?:s|ed|ing)?|supports?|now\s+supports?|add(?:s|ed|ing)?(?:\s+support)?|integrat(?:e|es|ed|ing|ion)|expand(?:s|ed|ing)|revamp(?:s|ed)?|upgrade(?:s|d)?|migrat(?:e|es|ed|ing|ion)|new\s+(?:feature|mode|model|chain|network|launchpad|protocol|pool|filter|api|sdk|module|hub|wallet|extension|product))\b/i;
const WALLET_STRUCTURAL_SIGNAL = /\b(?:bonding\s+curve|migration|launchpad|protocol|chain|network|pool|router|api|sdk|module|mode|model|smart\s+contract|security|keyless|prediction\s+markets?|secure\s+auto\s+sign|tee|mpc)\b/i;
const WALLET_CONTEXT = /\b(?:binance\s+(?:(?:web3\s+)?wallet|alpha)|web3\s+wallet|meme\s+rush|alpha\s+(?:2\.0|box|earn\s+hub)|dex\s+pro|agentic\s+wallet|keyless\s+wallet|prediction\s+markets?)\b/i;
const EXPLICIT_WALLET_MODE = /\b(?:meme\s+rush|alpha\s+(?:2\.0|box|earn\s+hub)|pre[- ]tge\s+prime\s+sale|buildkey\s+tge|bonding\s+curve(?:-based)?\s+(?:token\s+generation\s+event|tge)|dex\s+pro|agentic\s+wallet|prediction\s+markets?(?:\s+api)?|web3\s+api|event\s+rush|security\s+(?:center|scan)|multiple\s+keyless\s+wallets?|web3\s+loan|wallet\s+extension)\b/i;
const BINANCE_SOCIAL_TRADING_CONTEXT = /\b(?:binance\s+square|square\s+(?:creator|kol|call|signal)|kol\s+(?:buy|call|signal)|creator\s+(?:buy|call|signal)|smart\s+money\s+(?:signal|copy)|trade\s+sharing|share\s+(?:a\s+)?trade|social\s+trading|signal\s+(?:copy|sharing)|copy\s+(?:a\s+)?(?:signal|trade)|follow\s+(?:a\s+)?(?:kol|creator|trader))\b/i;
const BINANCE_SOCIAL_TRADING_ACTION = /\b(?:introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)?|rolls?\s+out|releas(?:e|es|ed|ing)|enabl(?:e|es|ed|ing)|add(?:s|ed|ing)?|support(?:s|ed|ing)?|available|live|coming\s+soon|beta)\b/i;
const BINANCE_SQUARE_CONTENT_PROMOTION = /\b(?:watch\s+trading\s+live|live\s+(?:trading|stream|interview)|stream(?:ing)?|incubation\s+group|sign\s+up|join\s+(?:the\s+)?group|set\s+a\s+reminder|ama\b|interview|episode|schedule)\b/i;
const STOCK_OR_SECURITIES = /\b(?:bstocks?|binance\s+stocks?|stock\s+trading|tokenized\s+securit(?:y|ies)|tokenized\s+stocks?|tradfi\s+(?:perpetual|contract)|equity|dividend)\b/i;
const MARKETING_OR_REWARD = [
  /\b(?:trading|deposit|referral|airdrop|points?|meme\s+rush)\s+(?:competition|campaign|carnival)\b/i,
  /\b(?:tournament|monthly\s+challenge|word\s+of\s+the\s+day|leaderboard|affiliate|referral|refer\s+(?:a\s+)?friend|invite\s+friends?)\b/i,
  /\b(?:share|win|unlock)\b.{0,80}\b(?:rewards?|prize|voucher)\b/i,
  /\b(?:earn|enjoy)\s+up\s+to\s+[\d.]+%\s+apr\b/i,
  /\b(?:earn|yield|subscription|rewards?)\b.{0,80}\b[\d.]+%\s+apr\b|\b[\d.]+%\s+apr\b.{0,80}\b(?:earn|yield|subscription|rewards?)\b/i,
  /\b(?:yield\s+arena|limited[- ]time\s+offers?|token\s+vouchers?|prize\s+pool)\b/i,
  /\b(?:promotion|giveaway|sign[- ]up\s+bonus|zero[- ]fee|fee\s+waiver)\b/i,
  /\bairdrop\b(?!\s+tracking)/i,
];
const ORDINARY_WALLET_TOKEN = [
  /\bwill\s+be\s+available\s+on\s+binance\s+alpha\b/i,
  /\b(?:was|is|has\s+been)\s+added\s+to\s+binance\s+alpha\b/i,
  /\bbinance\s+alpha\b[^.!?]{0,100}\b(?:lists?|listed|listing|adds?|added|available|starts?\s+trading)\b[^.!?]{0,100}\b(?:token|coin|asset|\([A-Z0-9]{2,15}\))/i,
  /\b(?:trade|buy|sell)\s+[^.!?]{1,100}\b(?:using|with)\s+(?:market\s+(?:and|&)\s+limit|limit\s+(?:and|&)\s+market)\s+orders?\b/i,
  /\bfirst\s+platform\s+to\s+feature\b/i,
  /\bbinance\s+(?:alpha|wallet)\s+will\s+(?:feature|list|remove)\b/i,
  /\bbinance\s+alpha\s+(?:adds?|features?|lists?|removes?)\b/i,
  /\bintroducing\s+.+\([a-z0-9]+\)\s+on\s+binance\s+(?:launchpool|megadrop)\b/i,
  /\bparticipate\s+in\s+the\s+exclusive\s+.+\([a-z0-9]+\)\s+(?:booster|token\s+generation\s+event|tge)\b/i,
  /\bmeme\s+rush\b.{0,80}\b(?:features?|lists?|adds?)\b.{0,80}\b(?:tokens?|coins?)\b/i,
  /\b(?:features?|lists?|adds?)\b.{0,80}\b(?:tokens?|coins?)\b.{0,80}\bmeme\s+rush\b/i,
];
const SPOT_FIRST_LISTING = /\bbinance\s+will\s+list\s+(?!new\s+trading\s+pairs?)[^.!]{1,120}(?:seed\s+tag|innovation\s+zone|on\s+spot|\bon\s+\d{4}|$)/i;
const FULL_TOKEN_DELISTING = /\bbinance\s+will\s+delist\s+(?!.*\b(?:spot|margin|futures)\s+trading\s+pairs?\b)[^.!]{1,160}\bon\s+\d{4}/i;
const ORDINARY_MARKET_ADDITION = /\b(?:futures\s+will\s+(?:launch|convert)|new\s+trading\s+pairs?|adds?\s+.+\s+trading\s+pairs?|trading\s+bots?\s+services?|removal\s+of\s+(?:spot|margin|futures)\s+trading\s+pairs?)\b/i;
const TRADING_RULE_UPDATE = /\b(?:tick\s+size|collateral\s+ratio|leverage\s*(?:&|and)\s*margin\s+tiers?|margin\s+tiers?|position\s+limits?|funding\s+rate|trading\s+rules?|risk\s+control|price\s+limit|minimum\s+order|fee\s+schedule)\b/i;
const EXCHANGE_MAINTENANCE = /\b(?:wallet\s+maintenance|network\s+upgrade|hard\s+fork|scheduled\s+maintenance|infrastructure\s+upgrade|discontinue\s+mainnet\s+support|token\s+swap|redenomination|asset\s+migration|deposit(?:s)?\s+and\s+withdrawal(?:s)?|suspend(?:s|ed|ing)?\s+(?:deposit|withdrawal|trading)|resume(?:s|d|ing)?\s+(?:deposit|withdrawal|trading))\b/i;
const SECURITY_OR_EMERGENCY = /\b(?:security\s+(?:incident|breach|risk|alert)|exploit|hack(?:ed|ing)?|unauthori[sz]ed|emergency|critical|abnormal|temporary\s+suspension|suspend(?:s|ed|ing)?\s+(?:all\s+)?(?:deposit|withdrawal|trading))\b/i;
const BREAKING_API_CHANGE = /\b(?:breaking\s+change|deprecat(?:e|es|ed|ion)|sunset|discontinu(?:e|es|ed|ation)|mandatory\s+migration|remove(?:s|d)?\s+(?:an?\s+)?(?:api|endpoint)|api\s+key\s+(?:security|migration))\b/i;
const EXCHANGE_PRODUCT_UPDATE = /\b(?:introducing\s+binance\s+(?!.*\b(?:launchpool|megadrop)\b)|binance\s+(?:launches|introduces)\s+(?!.*\b(?:competition|campaign|tournament)\b)|new\s+binance\s+(?:product|service|feature)|proof\s+of\s+reserves?)\b/i;
const FUTURES_PRODUCT_UPDATE = /\b(?:new\s+on\s+binance\s+futures|binance\s+futures\s+(?:adds?|updates?|upgrades?|introduces?|enables?|supports?)\b[^\n]{0,140}\b(?:feature|view|history|position|order|api|interface|risk|margin|funding|fee|tool|mode))\b/i;
const LAUNCH_PRODUCT_STRUCTURAL = /\b(?:revamp(?:s|ed)?\s+launchpool|launchpool\s+supports?\s+defi|new\s+launchpool\s+(?:mode|model|feature)|binance\s+launches\s+pre[- ]market|new\s+megadrop\s+(?:mode|model|feature))\b/i;

const RELEVANT_SCHEMA_KEY = /(?:protocol|version|launch|migrat|tax|sniper|curve|creator|tradeStart|pairAnchor|exclusive)/i;
const ANNOUNCEMENT_RETENTION = 2_000;
const HISTORICAL_LAUNCHPOOL_ASSETS = ["BNB", "BUSD", "FDUSD", "TUSD", "USDC", "USDT", "U", "USD1"];
const HISTORICAL_LAUNCHPOOL_STATUSES = ["PREHEATING", "SUBSCRIBABLE", "SUBSCRIBED", "REDEEMABLE", "REDEEMED", "UPCOMING", "ONGOING", "COMPLETED"];

function hash(value) {
  const normalized = typeof value === "string" ? value : JSON.stringify(value);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

function iso(now) {
  const value = typeof now === "function" ? now() : Date.now();
  return new Date(value instanceof Date ? value.getTime() : value).toISOString();
}

function criticalSourceDeliverySla(startedAt, pollAllowanceMs = 0) {
  const timestamp = Date.parse(startedAt || "");
  if (!Number.isFinite(timestamp)) return null;
  const allowance = Math.max(0, Math.min(4_500, Number(pollAllowanceMs) || 0));
  return {
    startedAt: new Date(timestamp).toISOString(),
    deadlineAt: new Date(timestamp + 5_000 - allowance).toISOString(),
    budgetMs: 5_000,
    pollAllowanceMs: allowance,
    basis: "critical_source_poll",
  };
}

function targetKey(target) {
  return `${target.chainId}:${target.rankType}`;
}

function projectProfile(id) {
  return id === "binance-wallet"
    ? {
        id,
        name: "Binance Wallet",
        website: "https://web3.binance.com",
        twitter: "https://x.com/BinanceWallet",
      }
    : {
        id: "binance",
        name: "Binance",
        website: "https://www.binance.com",
        twitter: "https://x.com/binance",
      };
}

function articleCatalogIds(article = {}) {
  return new Set([
    ...(Array.isArray(article.catalogs) ? article.catalogs.map((catalog) => Number(catalog.id ?? catalog.catalogId)) : []),
    Number(article.catalogId),
  ].filter(Number.isFinite));
}

function classified(labels, { project = "binance", strong = false, category = "平台更新" } = {}) {
  return {
    relevant: true,
    labels: [...new Set(labels)],
    project,
    scope: project === "binance-wallet" ? "wallet" : "exchange",
    category,
    strong,
  };
}

const MAJOR_LAUNCH_ACTION = /\b(?:introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)?|announc(?:e|es|ed|ing)|rolls?\s+out|releas(?:e|es|ed|ing)|deploy(?:s|ed|ing)?|integrat(?:e|es|ed|ing|ion)|migrat(?:e|es|ed|ing|ion)|revamp(?:s|ed|ing)?|upgrade(?:s|d|ing)?)\b/i;
const LAUNCH_MODE_OBJECT = /\b(?:meme\s+rush|launchpad|bonding\s+curve|buildkey|prime\s+sale|token\s+generation\s+event|tge|new\s+(?:launchpad|platform|mode|model|protocol))\b/i;
const PRESENTATION_ONLY_CHANGE = /\b(?:search|filters?|interface|portfolio|documentation|help\s+cent(?:er|re)|display|labels?|icons?)\b/i;
const EXPLICIT_MECHANISM_CHANGE = /\b(?:mode|model|protocol|mechanism|migration|smart\s+contract|new\s+launchpad|new\s+platform)\b/i;
const MEME_RUSH_LAUNCH_SOURCE_CHANGE = /(?:\bmeme\s+rush\b.{0,140}\b(?:add(?:s|ed|ing)?|integrat(?:e|es|ed|ing)|support(?:s|ed|ing)?)\b.{0,140}\b(?:as\s+(?:an?\s+)?|from\s+(?:an?\s+)?)?(?:new\s+)?(?:launchpad|launch\s+source|protocol|platform)\b|\b(?:launchpad|launch\s+source|protocol|platform)\b.{0,140}\b(?:add(?:s|ed|ing)?|integrat(?:e|es|ed|ing)|support(?:s|ed|ing)?)\b.{0,140}\bmeme\s+rush\b)/i;

function walletLaunchModeChange(text) {
  if (PRESENTATION_ONLY_CHANGE.test(text) && !EXPLICIT_MECHANISM_CHANGE.test(text)) return false;
  return MEME_RUSH_LAUNCH_SOURCE_CHANGE.test(text)
    || nearbySignals(text, MAJOR_LAUNCH_ACTION, LAUNCH_MODE_OBJECT);
}

function nearbySignals(text, left, right, maximumDistance = 180) {
  const indexes = (pattern) => [...String(text).matchAll(new RegExp(pattern.source, pattern.flags.includes("i") ? "gi" : "g"))]
    .slice(0, 100)
    .map((match) => match.index || 0);
  const leftIndexes = indexes(left);
  const rightIndexes = indexes(right);
  return leftIndexes.some((leftIndex) => rightIndexes.some((rightIndex) => Math.abs(leftIndex - rightIndex) <= maximumDistance));
}

function bodyText(body) {
  let value = body;
  if (typeof value === "string") {
    try { value = JSON.parse(value); }
    catch { return value.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
  }
  const fragments = [];
  const visit = (node) => {
    if (!node || fragments.length >= 5_000) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child);
      return;
    }
    if (typeof node !== "object") return;
    if (typeof node.text === "string" && (node.node === "text" || node.node == null)) fragments.push(node.text);
    for (const [key, child] of Object.entries(node)) if (key !== "attr" && key !== "text") visit(child);
  };
  visit(value);
  return fragments.join(" ").replace(/\s+/g, " ").trim();
}

const MATERIAL_ANNOUNCEMENT_FACT = /\b(?:security\s+(?:incident|breach|risk|alert)|exploit|emergency|suspend(?:s|ed|ing)?|resume(?:s|d|ing)?|maintenance|upgrade|hard\s+fork|migration|deprecat(?:e|es|ed|ion)|sunset|api|endpoint|websocket|tick\s+size|collateral\s+ratio|leverage|margin\s+tier|funding\s+rate|position\s+limit|will\s+list|will\s+delist|meme\s+rush|bonding\s+curve|launchpad|new\s+(?:chain|network|protocol|mode)|takes?\s+effect|effective\s+(?:at|on)|affected)\b/i;
const ANNOUNCEMENT_FACT_SIGNAL = /\b(?:will|now|new|adds?|added|introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)?|support(?:s|ed|ing)?|upgrad(?:e|es|ed|ing)|migrat(?:e|es|ed|ing|ion)|suspend(?:s|ed|ing)?|resume(?:s|d|ing)?|deprecat(?:e|es|ed|ing|ion)|remove(?:s|d|ing)?|available|effective|takes?\s+effect|api|endpoint|network|chain|wallet|square|kol|signal|copy\s+trad(?:e|ing))\b/i;
const ANNOUNCEMENT_FACT_BOILERPLATE = /^(?:fellow\s+binancians|note\b|notes?\b|disclaimer\b|risk\s+warning\b|this\s+is\s+a\s+general\s+announcement|where\s+any\s+discrepancy|terms\s+and\s+conditions\s+apply|products?\s+may\s+not\s+be\s+available\s+in\s+your\s+region|binance\s+reserves\s+the\s+right)\b/i;

function materialAnnouncementHash(body) {
  const text = bodyText(body);
  if (!text) return null;
  const facts = text.split(/(?<=[.!?。！？])\s+|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence && MATERIAL_ANNOUNCEMENT_FACT.test(sentence))
    .slice(0, 120);
  return facts.length ? hash(facts) : null;
}

function conciseAnnouncementSentence(value, maximum = 210) {
  const sentence = String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s*•▪◦‣●○◆◇\-–—]+/u, "")
    .trim();
  if (!sentence) return "";
  return sentence.length <= maximum ? sentence : `${sentence.slice(0, maximum - 1).trimEnd()}…`;
}

function compactDisplayList(values, maximum = 5) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => conciseAnnouncementSentence(value))
    .filter(Boolean))].slice(0, maximum);
}

function changedSnapshotFields(previousSnapshot, currentSnapshot) {
  const previous = previousSnapshot && typeof previousSnapshot === "object" ? previousSnapshot : {};
  const current = currentSnapshot && typeof currentSnapshot === "object" ? currentSnapshot : {};
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])]
    .filter((field) => JSON.stringify(previous[field] ?? null) !== JSON.stringify(current[field] ?? null));
}

export function extractBinanceAnnouncementFacts(detail = null, title = "", maximum = 3) {
  const content = [detail?.seoDesc, bodyText(detail?.body)].filter(Boolean).join(" ");
  if (!content) return [];
  const normalizedTitle = String(title || detail?.title || "").toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, " ").trim();
  const candidates = content
    .replace(/(?:<br\s*\/?\s*>|<\/p>|<\/li>)/gi, ". ")
    .split(/(?<=[.!?。！？;；])\s+|\n+/)
    .map((sentence) => conciseAnnouncementSentence(sentence))
    .filter((sentence) => sentence.length >= 24
      && !ANNOUNCEMENT_FACT_BOILERPLATE.test(sentence)
      && ANNOUNCEMENT_FACT_SIGNAL.test(sentence));
  const selected = [];
  for (const sentence of candidates) {
    const key = sentence.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, " ").trim();
    if (!key || key === normalizedTitle || normalizedTitle.includes(key) || selected.some((value) => value.toLowerCase().replace(/[^a-z0-9\u3400-\u9fff]+/g, " ").trim() === key)) continue;
    selected.push(sentence);
    if (selected.length >= maximum) break;
  }
  return selected;
}

const INTERVAL_HOUR_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  six: 6,
  eight: 8,
  twelve: 12,
  twentyfour: 24,
};

function intervalHours(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const parsed = /^\d+$/.test(normalized) ? Number(normalized) : INTERVAL_HOUR_WORDS[normalized];
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 24 ? parsed : null;
}

export function extractBinanceAnnouncementDetails(detail = null, title = "") {
  const content = [title || detail?.title, detail?.seoDesc, bodyText(detail?.body)].filter(Boolean).join(" ");
  if (!content) return null;
  const interval = content.match(/funding\s+interval\s+of\s+([A-Z0-9Ⓢ._-]+)\s+Perpetual\s+Contract\s+from\s+every\s+([a-z0-9-]+)\s+hours?\s+to\s+every\s+([a-z0-9-]+)\s+hours?/iu);
  if (!interval) return null;
  const previousHours = intervalHours(interval[2]);
  const currentHours = intervalHours(interval[3]);
  if (!previousHours || !currentHours) return null;
  const effective = content.match(/Effective\s+from\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:\s*\(UTC\))?/iu);
  const effectiveAt = effective ? new Date(`${effective[1]}T${effective[2]}:00Z`) : null;
  const fundingRate = content.match(/Max\s+Funding\s+Rate\s+.*?([+-]\d+(?:\.\d+)?%)\s*\/\s*([+-]\d+(?:\.\d+)?%)/iu);
  return {
    kind: "funding_interval",
    instrument: interval[1],
    previousHours,
    currentHours,
    ...(effectiveAt && !Number.isNaN(effectiveAt.getTime()) ? { effectiveAt: effectiveAt.toISOString() } : {}),
    ...(fundingRate ? { fundingRateCap: fundingRate[1], fundingRateFloor: fundingRate[2] } : {}),
  };
}

function announcementDisplaySnapshot(article = {}, detail = null, signal = null) {
  const facts = extractBinanceAnnouncementFacts(detail, article.title);
  const details = extractBinanceAnnouncementDetails(detail, article.title);
  return {
    title: conciseAnnouncementSentence(article.title, 180),
    ...(facts.length ? { facts: compactDisplayList(facts, 3) } : {}),
    ...(details ? { details } : {}),
    ...(detail?.version ? { version: String(detail.version) } : {}),
    ...(signal?.category ? { category: String(signal.category) } : {}),
    ...(signal?.labels?.length ? { labels: compactDisplayList(signal.labels, 4) } : {}),
  };
}

function announcementSnapshotFromRecord(record = {}) {
  if (record.displaySnapshot && typeof record.displaySnapshot === "object") return record.displaySnapshot;
  return {
    ...(record.title ? { title: conciseAnnouncementSentence(record.title, 180) } : {}),
    ...(record.version ? { version: String(record.version) } : {}),
    ...(record.category ? { category: String(record.category) } : {}),
  };
}

function squareDisplaySnapshot(post = {}, signal = null) {
  const extracted = extractBinanceAnnouncementFacts({ body: post.body }, post.title);
  const facts = extracted.length ? extracted : [conciseAnnouncementSentence(post.body)].filter(Boolean);
  return {
    title: conciseAnnouncementSentence(post.title, 180),
    ...(facts.length ? { facts: compactDisplayList(facts, 3) } : {}),
    editCount: Number(post.editCount || 0),
    ...(signal?.category ? { category: String(signal.category) } : {}),
  };
}

function squareSnapshotFromRecord(record = {}) {
  if (record.displaySnapshot && typeof record.displaySnapshot === "object") return record.displaySnapshot;
  return {
    ...(record.title ? { title: conciseAnnouncementSentence(record.title, 180) } : {}),
    editCount: Number(record.editCount || 0),
  };
}

function developerDisplaySnapshot(signals = [], metadata = {}) {
  const normalized = compactDisplayList(signals, 8);
  return {
    signalCount: Array.isArray(signals) ? signals.length : 0,
    ...(Number.isFinite(Number(metadata.totalSignals)) ? { totalSignals: Number(metadata.totalSignals) } : {}),
    ...(metadata.truncated === true ? { truncated: true } : {}),
    signalDigest: hash([...(Array.isArray(signals) ? signals : [])].sort()),
    signals: normalized,
  };
}

function signalHash(signal) {
  return hash({ scope: signal.scope, category: signal.category, strong: signal.strong, labels: signal.labels || [] });
}

export function classifyBinanceAnnouncement(article = {}, detail = null) {
  const title = String(detail?.title || article.title || "").replace(/\s+/g, " ").trim();
  const seo = [detail?.seoKeywords, detail?.seoDesc].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
  const body = typeof detail?.body === "string" ? detail.body : detail?.body ? JSON.stringify(detail.body) : "";
  const headline = `${title} ${seo}`.trim();
  const analysisText = `${headline} ${body.slice(0, 20_000)}`.trim();
  if (!headline) return { relevant: false, labels: [] };
  const catalogs = articleCatalogIds(article);
  // Footer navigation and recommendation modules contain unrelated product
  // names. Hard exclusions must come from the title/SEO facts, not arbitrary
  // body text, or valid API/maintenance announcements are silently discarded.
  if (STOCK_OR_SECURITIES.test(headline)) return { relevant: false, labels: [] };

  const marketing = MARKETING_OR_REWARD.some((pattern) => pattern.test(headline))
    || MARKETING_OR_REWARD.some((pattern) => pattern.test(analysisText));
  const explicitWalletMode = EXPLICIT_WALLET_MODE.test(analysisText);
  const structuralWalletChange = explicitWalletMode && nearbySignals(analysisText, PRODUCT_ACTION, WALLET_STRUCTURAL_SIGNAL);
  if (marketing && !structuralWalletChange) return { relevant: false, labels: [] };

  const agentNativeSignal = classifyAgentNativeOfficialText(headline);
  if (agentNativeSignal.relevant) return agentNativeSignal;

  const lowValueCatalog = catalogs.has(BINANCE_CATALOGS.fiat)
    || catalogs.has(BINANCE_CATALOGS.activities)
    || catalogs.has(BINANCE_CATALOGS.airdrop);
  if (lowValueCatalog && !structuralWalletChange && !SECURITY_OR_EMERGENCY.test(headline)) return { relevant: false, labels: [] };

  const exchangeWalletMaintenance = /^wallet\s+maintenance\b/i.test(title);
  const walletContext = !exchangeWalletMaintenance && (WALLET_CONTEXT.test(analysisText) || explicitWalletMode);
  const socialTradingFeature = BINANCE_SOCIAL_TRADING_CONTEXT.test(analysisText)
    && BINANCE_SOCIAL_TRADING_ACTION.test(analysisText)
    && !BINANCE_SQUARE_CONTENT_PROMOTION.test(analysisText);
  if (socialTradingFeature) {
    return classified(["Square/KOL 喊单与跟单功能"], {
      project: walletContext ? "binance-wallet" : "binance",
      strong: true,
      category: "社交交易新功能",
    });
  }
  if (walletContext) {
    if (ORDINARY_WALLET_TOKEN.some((pattern) => pattern.test(analysisText)) && !structuralWalletChange) return { relevant: false, labels: [] };
    if (!PRODUCT_ACTION.test(analysisText) && !structuralWalletChange) return { relevant: false, labels: [] };
    const labels = [];
    if (walletLaunchModeChange(analysisText)) labels.push("Wallet 发射新模式");
    if (nearbySignals(analysisText, PRODUCT_ACTION, /\b(?:api|sdk|developer|module)\b/i)) labels.push("Wallet API/开发能力");
    if (nearbySignals(analysisText, PRODUCT_ACTION, /\b(?:security|keyless|anti[- ]sniper|smart\s+contract|secure\s+auto\s+sign|tee|mpc)\b/i)) labels.push("Wallet 安全更新");
    if (/\b(?:new\s+chain|new\s+network|adds?\s+support\s+for|integrat(?:e|es|ed|ing|ion))\b/i.test(analysisText)) labels.push("Wallet 新链/协议");
    if (!labels.length) labels.push("Wallet 功能更新");
    const strong = labels.some((label) => ["Wallet 发射新模式", "Wallet API/开发能力", "Wallet 安全更新", "Wallet 新链/协议"].includes(label));
    return classified(labels, { project: "binance-wallet", strong, category: labels[0] });
  }

  if (SPOT_FIRST_LISTING.test(title)) return classified(["现货首次上币"], { strong: true, category: "现货上币" });
  if (FULL_TOKEN_DELISTING.test(title)) return classified(["整币下架"], { strong: true, category: "整币下架" });
  if (ORDINARY_MARKET_ADDITION.test(title)) return { relevant: false, labels: [] };
  if (catalogs.has(BINANCE_CATALOGS.api) || /\bbinance\s+(?:spot|futures)?\s*api\s+update/i.test(title)) {
    return classified(["交易所 API 更新"], { strong: BREAKING_API_CHANGE.test(headline), category: "API 更新" });
  }
  if (LAUNCH_PRODUCT_STRUCTURAL.test(headline)) return classified(["发射产品机制更新"], { strong: true, category: "发射产品" });
  if (SECURITY_OR_EMERGENCY.test(headline)) return classified(["安全/紧急公告"], { strong: true, category: "安全/紧急" });
  if (TRADING_RULE_UPDATE.test(headline)) return classified(["交易规则调整"], { category: "交易规则" });
  if (EXCHANGE_MAINTENANCE.test(headline)) return classified(["充提/网络维护"], { category: "维护更新" });
  if (FUTURES_PRODUCT_UPDATE.test(headline)) return classified(["Futures 功能更新"], { category: "Futures 产品更新" });
  if (EXCHANGE_PRODUCT_UPDATE.test(headline)) return classified(["交易所新产品/功能"], { category: "产品更新" });
  return { relevant: false, labels: [] };
}

export function classifyBinanceOfficialText(text = "") {
  return classifyBinanceAnnouncement({ title: text });
}

export function parseBinanceAnnouncements(payload) {
  if (payload?.code !== "000000" || !Array.isArray(payload?.data?.catalogs)) throw new Error(`Binance announcements business error ${payload?.code || "invalid_payload"}`);
  const articles = new Map();
  for (const catalog of payload.data.catalogs) {
    for (const article of catalog.articles || []) {
      if (!article?.code || !article?.title) continue;
      const code = String(article.code);
      const previous = articles.get(code);
      const catalogRecord = { id: Number(catalog.catalogId), name: catalog.catalogName || null };
      articles.set(code, {
        ...previous,
        id: article.id,
        code,
        title: String(article.title),
        releaseDate: Number(article.releaseDate) || null,
        catalogId: previous?.catalogId ?? catalog.catalogId,
        catalogName: catalog.catalogName || null,
        catalogs: [...new Map([...(previous?.catalogs || []), catalogRecord].map((item) => [item.id, item])).values()],
        url: `https://www.binance.com/en/support/announcement/detail/${article.code}`,
      });
    }
  }
  return [...articles.values()]
    .sort((left, right) => Number(left.releaseDate || left.id || 0) - Number(right.releaseDate || right.id || 0));
}

export function parseBinanceAnnouncementDetail(payload, expectedCode = null) {
  if (payload?.code !== "000000" || !payload?.data || typeof payload.data !== "object") {
    throw new Error(`Binance announcement detail business error ${payload?.code || "invalid_payload"}`);
  }
  const data = payload.data;
  const code = String(data.code || expectedCode || "");
  if (!code || (expectedCode && code !== String(expectedCode))) throw new Error("Binance announcement detail code mismatch");
  const body = typeof data.body === "string" || (data.body && typeof data.body === "object") ? data.body : "";
  return {
    code,
    title: String(data.title || ""),
    publishDate: Number(data.publishDate) || null,
    lastUpdateTime: Number(data.lastUpdateTime) || null,
    version: data.version == null ? null : String(data.version),
    seoKeywords: String(data.seoKeywords || ""),
    seoDesc: String(data.seoDesc || ""),
    body,
    semanticHash: hash({ title: data.title || "", seoKeywords: data.seoKeywords || "", seoDesc: data.seoDesc || "" }),
    materialHash: materialAnnouncementHash(body),
    contentHash: hash({ title: data.title || "", seoKeywords: data.seoKeywords || "", seoDesc: data.seoDesc || "", body, version: data.version ?? null }),
  };
}

export function parseBinanceSquarePosts(payload) {
  if (payload?.code !== "000000" || !Array.isArray(payload?.data?.contents)) {
    throw new Error(`Binance Square business error ${payload?.code || "invalid_payload"}`);
  }
  return payload.data.contents
    .filter((item) => item?.id != null && String(item.squareUid || "") === "Na1B6PUjBNGQfhvh1T_yig")
    .map((item) => {
      const id = String(item.id);
      const body = String(item.bodyTextOnly || item.title || "").replace(/\s+/g, " ").trim();
      const title = String(item.title || "").replace(/\s+/g, " ").trim()
        || conciseAnnouncementSentence(body, 180);
      return {
        id,
        title,
        body,
        firstReleaseTime: Number(item.firstReleaseTime) || null,
        editCount: Number(item.editCount) || 0,
        editTime: Number(item.editTime) || null,
        contentHash: hash({ title, body }),
        url: /^https:\/\/www\.binance\.com\/en\/square\/post\/\d+$/i.test(String(item.webLink || ""))
          ? String(item.webLink)
          : `https://www.binance.com/en/square/post/${id}`,
      };
    })
    .sort((left, right) => Number(left.firstReleaseTime || 0) - Number(right.firstReleaseTime || 0));
}

export function parseBinanceAnnouncementStreamMessage(value) {
  const envelope = JSON.parse(Buffer.isBuffer(value) ? value.toString("utf8") : String(value));
  if (envelope?.type !== "DATA" || envelope?.topic !== BINANCE_ANNOUNCEMENT_STREAM_TOPIC) return null;
  const data = typeof envelope.data === "string" ? JSON.parse(envelope.data) : envelope.data;
  const title = String(data?.title || "").replace(/\s+/g, " ").trim();
  const publishDate = Number(data?.publishDate);
  if (!title || !Number.isFinite(publishDate)) throw new Error("Binance announcement stream payload is missing title/publishDate");
  return {
    catalogId: Number(data.catalogId) || null,
    catalogName: data.catalogName ? String(data.catalogName) : null,
    publishDate,
    title,
    body: data.body || "",
    disclaimer: data.disclaimer || "",
  };
}

export function buildBinanceAnnouncementStreamUrl(secret, timestamp = Date.now(), random = randomBytes(16).toString("hex")) {
  const params = new URLSearchParams({
    random: String(random),
    topic: BINANCE_ANNOUNCEMENT_STREAM_TOPIC,
    recvWindow: "30000",
    timestamp: String(timestamp),
  });
  const signature = createHmac("sha256", secret).update(params.toString()).digest("hex");
  params.set("signature", signature);
  return `${BINANCE_ANNOUNCEMENT_STREAM_URL}?${params.toString()}`;
}

function cleanDeveloperDocLine(value) {
  return String(value || "")
    .replace(/^#{1,6}\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\[([^\]]+)]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const AGENT_NATIVE_IDENTITY = /\b(?:binance\s+)?(?:agent\s*os|agent\s+native|agentic\s+wallet|mcp\s+server|agent\s+rest\s+api)\b/i;
const AGENT_NATIVE_MATERIAL_SIGNAL = /(?:\b(?:mcp\s+endpoint|endpoint|rest\s+api|api\s+keys?|oauth|authenticat(?:e|ion)|authoriz(?:e|ation)|permissions?|scopes?|read[- ]only|no\s+withdrawal|emergency\s+stop|sub[- ]account|market\s+data|order\s+books?|balances?|positions?|trade|spot|margin|convert|futures|payments?|x402|on[- ]chain|wallets?|transfer|send|receive|settle|portfolio)\b|https:\/\/agent\.binance\.com\/mcp\/agentic|\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[a-z0-9_{}./-]+)/i;
const AGENT_NATIVE_FUNCTIONAL_CHANGE = /\b(?:add(?:s|ed|ing)?|allow(?:s|ed|ing)?|authoriz(?:e|es|ed|ing)|deprecat(?:e|es|ed|ing|ion)|disabl(?:e|es|ed|ing)|enabl(?:e|es|ed|ing)|grant(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)?|migrat(?:e|es|ed|ing)|new|now|remov(?:e|es|ed|ing)|requir(?:e|es|ed|ing)|support(?:s|ed|ing)?|updat(?:e|es|ed|ing)|upgrad(?:e|es|ed|ing))\b/i;
const DEVELOPER_SIGNAL_NOISE = /^(?:table of contents|resources|support|privacy|terms|related|getting help)$/i;

function classifyAgentNativeOfficialText(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  const relevant = AGENT_NATIVE_IDENTITY.test(text)
    && (AGENT_NATIVE_MATERIAL_SIGNAL.test(text) || AGENT_NATIVE_FUNCTIONAL_CHANGE.test(text));
  return relevant
    ? classified(["Binance Agent OS / Agent Native"], {
        project: "binance",
        strong: true,
        category: "agent_native",
      })
    : { relevant: false, labels: [] };
}

function agentNativeTitleSemantic(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function appendDeveloperSignal(signals, value) {
  const line = cleanDeveloperDocLine(value);
  if (line.length < 4 || line.length > 300 || DEVELOPER_SIGNAL_NOISE.test(line) || signals.includes(line)) return;
  signals.push(line);
}

function developerMdxProps(raw) {
  const props = {};
  const pattern = /\b(title|label|value|description|outcome|quote)\s*=\s*(?:\{\s*)?["'`]([^"'`]{2,500})["'`]\s*\}?/gi;
  for (const match of String(raw || "").matchAll(pattern)) props[match[1].toLowerCase()] = match[2];
  return props;
}

export function extractBinanceDeveloperSignalSnapshot(markdown, maximum = 1_200) {
  const limit = Math.max(1, Number(maximum) || 1_200);
  const candidates = [];
  let paragraph = [];
  let mdxProps = {};
  let inCodeFence = false;

  const flushParagraph = () => {
    const value = cleanDeveloperDocLine(paragraph.join(" "));
    paragraph = [];
    if (AGENT_NATIVE_IDENTITY.test(value) || (AGENT_NATIVE_MATERIAL_SIGNAL.test(value) && /\bagent(?:ic|s?)?\b|\bmcp\b/i.test(value))) {
      appendDeveloperSignal(candidates, value);
    }
  };
  const flushMdxProps = () => {
    const props = mdxProps;
    mdxProps = {};
    const name = props.label || props.title;
    const detail = props.value || props.description || props.outcome || props.quote;
    if (name && detail && (AGENT_NATIVE_IDENTITY.test(`${name} ${detail}`) || AGENT_NATIVE_MATERIAL_SIGNAL.test(`${name} ${detail}`))) {
      appendDeveloperSignal(candidates, `${name}: ${detail}`);
      return;
    }
    for (const value of Object.values(props)) {
      if (AGENT_NATIVE_IDENTITY.test(value) || AGENT_NATIVE_MATERIAL_SIGNAL.test(value)) appendDeveloperSignal(candidates, value);
    }
  };

  for (const raw of String(markdown || "").split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (/^```/.test(trimmed)) {
      flushParagraph();
      if (inCodeFence) flushMdxProps();
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) {
      if (AGENT_NATIVE_MATERIAL_SIGNAL.test(trimmed)) appendDeveloperSignal(candidates, `Code: ${trimmed}`);
      continue;
    }

    if (/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+)/.test(raw)) {
      flushParagraph();
      flushMdxProps();
      appendDeveloperSignal(candidates, raw);
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(raw) && !/^\s*\|?(?:\s*:?-{3,}:?\s*\|)+\s*$/.test(raw)) {
      flushParagraph();
      flushMdxProps();
      const cells = raw.split("|").map(cleanDeveloperDocLine).filter(Boolean);
      if (cells.length) appendDeveloperSignal(candidates, cells.join(" | "));
      continue;
    }

    const props = developerMdxProps(raw);
    if (Object.keys(props).length) {
      flushParagraph();
      Object.assign(mdxProps, props);
      if (/\/>\s*$/.test(trimmed)) flushMdxProps();
      continue;
    }
    if (/^<\/?[A-Za-z]/.test(trimmed) || /^(?:import|export)\s/.test(trimmed)) {
      flushParagraph();
      if (/\/>\s*$/.test(trimmed) || /^<\//.test(trimmed)) flushMdxProps();
      continue;
    }
    if (!trimmed) {
      flushParagraph();
      flushMdxProps();
      continue;
    }
    paragraph.push(trimmed);
  }
  flushParagraph();
  flushMdxProps();

  // Keep Agent OS / Agent Native discoveries even when a large directory has
  // more than the persisted 1,200-signal window. Priority signals already in
  // the window do not change the semantic set; a newly appended Agent link is
  // pulled into the bounded snapshot and can be reported as an addition.
  const priority = candidates.filter((value) => AGENT_NATIVE_IDENTITY.test(value)
    || /\/(?:agent-native|agent-os)(?:\/|\b)/i.test(value));
  const selected = [];
  for (const value of [...priority, ...candidates]) {
    if (!selected.includes(value)) selected.push(value);
    if (selected.length >= limit) break;
  }

  return {
    signals: selected,
    totalSignals: candidates.length,
    // Reaching the storage bound is treated as saturated. Even if the source
    // currently has exactly `limit` signals, a later insertion can evict the
    // tail and must not be reported as a real removal.
    truncated: candidates.length >= limit,
  };
}

export function extractBinanceDeveloperSignals(markdown, maximum = 1_200) {
  return extractBinanceDeveloperSignalSnapshot(markdown, maximum).signals;
}

function developerPageProfile(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  if (pathname.endsWith("/llms.txt")) return { label: "Developer 文档目录", project: "binance", strong: true };
  if (pathname.includes("/agent-native/")) return {
    label: "Binance Agent OS / Agent Native",
    project: "binance",
    strong: true,
    category: "agent_native",
  };
  if (pathname.includes("/wallet-skills/")) return { label: "Wallet Skills", project: "binance-wallet", strong: true };
  if (pathname.includes("/copy-trading/")) return { label: "Copy Trading API", project: "binance", strong: true };
  if (pathname.includes("/w3w-prediction/")) return { label: "Prediction Trading API", project: "binance-wallet", strong: true };
  if (pathname.includes("/alpha/")) return { label: "Binance Alpha API", project: "binance-wallet", strong: true };
  if (pathname.includes("/wallet/")) return { label: "Binance Wallet API", project: "binance-wallet", strong: true };
  if (pathname.includes("/announcements/")) return { label: "公告 API", project: "binance", strong: true };
  return { label: "Spot API", project: "binance", strong: false };
}

function classifyDeveloperDelta(url, added = [], removed = []) {
  const base = developerPageProfile(url);
  const delta = [...added, ...removed].join("\n");
  const agentNative = base.category === "agent_native" || AGENT_NATIVE_IDENTITY.test(delta)
    || /\/agent-native\/|\/agent-os\b/i.test(delta);
  if (!agentNative) return { ...base, relevant: added.length + removed.length > 0 };
  const material = AGENT_NATIVE_MATERIAL_SIGNAL.test(delta)
    || /\/agent-native\/(?:mcp-server|agent-rest-api)|\/agent-os\b/i.test(delta)
    || (AGENT_NATIVE_IDENTITY.test(delta) && AGENT_NATIVE_FUNCTIONAL_CHANGE.test(delta));
  return {
    ...base,
    label: "Binance Agent OS / Agent Native",
    project: "binance",
    category: "agent_native",
    strong: true,
    relevant: material,
  };
}

function responseHeader(response, name) {
  const value = response?.headers?.get?.(name);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function retryAfterMilliseconds(response, current, fallbackMs, maximumMs) {
  const value = responseHeader(response, "retry-after");
  let requestedMs = null;
  if (/^\d+(?:\.\d+)?$/.test(value || "")) {
    requestedMs = Math.ceil(Number(value) * 1_000);
  } else {
    const timestamp = Date.parse(value || "");
    if (Number.isFinite(timestamp)) requestedMs = Math.max(0, timestamp - current);
  }
  const boundedFallback = Math.max(1_000, Math.min(maximumMs, Number(fallbackMs) || 60_000));
  if (!Number.isFinite(requestedMs)) return boundedFallback;
  // Honour an upstream Retry-After even when it is longer than our local
  // exponential fallback. The 24-hour ceiling only protects corrupted dates.
  return Math.max(boundedFallback, Math.min(86_400_000, requestedMs));
}

function prefixedSourceError(prefix, error) {
  const wrapped = new Error(`${prefix}: ${error?.message || error}`);
  for (const key of [
    "status",
    "sourceUrl",
    "sourceRateLimited",
    "wafBlocked",
    "sourceCircuitOpen",
    "retryAt",
    "suppressLog",
    "slaUnavailable",
  ]) {
    if (error?.[key] != null) wrapped[key] = error[key];
  }
  return wrapped;
}

function responseLastModified(response, observedAt) {
  const value = responseHeader(response, "last-modified");
  const timestamp = Date.parse(value || "");
  const observed = Date.parse(observedAt || "");
  if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
  if (Number.isFinite(observed) && timestamp > observed + 300_000) return null;
  return new Date(timestamp).toISOString();
}

function isOfficialAgentOsUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const hostname = url.hostname.toLowerCase().replace(/^www\./, "");
    return ["http:", "https:"].includes(url.protocol)
      && hostname === "binance.com"
      && /^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?agent-os\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function isTrustedAgentOsReaderUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "r.jina.ai"
      && /^\/http:\/\/www\.binance\.com\/en\/agent-os\/?$/i.test(url.pathname);
  } catch {
    return false;
  }
}

function cleanAgentOsHtml(value) {
  return String(value || "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "\n")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "\n")
    .replace(/<[^>]+>/g, "\n")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/\r/g, "");
}

function extractAgentOsPageSignals(content, maximum = 1_200) {
  const limit = Math.max(1, Number(maximum) || 1_200);
  const generic = extractBinanceDeveloperSignalSnapshot(content, limit * 2).signals;
  const signals = [];
  const knownCapability = /^(?:BINANCE AGENT OS|CONNECT YOUR AI AGENTS|What is Binance Agent OS\??|CONNECT|BUILD|CONTROL|Trade|Pay\s*&\s*settle|Read the Market|Track Your Portfolio|Operate On-Chain|Answer Your Questions|Binance MCP Server|Binance Agentic Wallet|Web3 APIs?|Agent REST API)$/i;
  for (const value of generic) appendDeveloperSignal(signals, value);
  for (const raw of String(content || "").split(/\r?\n/)) {
    const value = cleanDeveloperDocLine(raw);
    if (knownCapability.test(value)
      || AGENT_NATIVE_IDENTITY.test(value)
      || (AGENT_NATIVE_MATERIAL_SIGNAL.test(value) && /\bagent(?:ic|s?)?\b|\bmcp\b/i.test(value))) {
      appendDeveloperSignal(signals, value);
    }
  }
  return {
    signals: signals.slice(0, limit),
    totalSignals: signals.length,
    truncated: signals.length > limit,
  };
}

function parseVerifiedAgentOsPage(body, { reader = false, responseUrl = null } = {}) {
  let content = String(body || "");
  let verifiedSourceUrl = responseUrl || BINANCE_AGENT_OS_PAGE_URL;
  if (reader) {
    const title = content.match(/^Title:\s*(.+)$/im)?.[1]?.trim() || "";
    const sourceUrl = content.match(/^URL Source:\s*(.+)$/im)?.[1]?.trim() || "";
    const marker = content.search(/^Markdown Content:\s*$/im);
    if (!/\b(?:MCP Server for Crypto AI Agents|Binance Agent OS)\b/i.test(title)) {
      throw new Error("Agent OS reader title verification failed");
    }
    if (!isOfficialAgentOsUrl(sourceUrl)) throw new Error("Agent OS reader source URL verification failed");
    if (marker < 0) throw new Error("Agent OS reader markdown marker missing");
    verifiedSourceUrl = sourceUrl;
    content = content.slice(marker).replace(/^Markdown Content:\s*/i, "");
  } else {
    if (responseUrl && !isOfficialAgentOsUrl(responseUrl)) throw new Error("Agent OS canonical redirect left binance.com");
    content = cleanAgentOsHtml(content);
  }
  if (!/\bBINANCE\s+AGENT\s+OS\b/i.test(content) || !/What\s+is\s+Binance\s+Agent\s+OS/i.test(content)) {
    throw new Error("Agent OS official identity markers missing");
  }
  const snapshot = extractAgentOsPageSignals(content);
  if (snapshot.signals.length < 6) throw new Error("Agent OS page produced insufficient verified signals");
  return { ...snapshot, verifiedSourceUrl };
}

async function fetchAgentOsPage(fetchImpl, previous, observedAt, requestTimeoutMs = 12_000) {
  const errors = [];
  const timeoutMs = Math.max(250, Number(requestTimeoutMs) || 12_000);
  // Start the verified reader at the same time as the canonical request. The
  // canonical page is WAF-challenged in production; sequential timeouts would
  // consume the entire five-second discovery budget before fallback begins.
  const readerAttempt = Promise.allSettled([(async () => {
    const readerHeaders = {
      accept: "text/plain,*/*;q=0.1",
      "user-agent": "robinhood-launchpad-monitor/0.1",
    };
    if (previous?.retrievalMode === "verified_reader" && previous?.etag) readerHeaders["if-none-match"] = previous.etag;
    if (previous?.retrievalMode === "verified_reader" && previous?.lastModified) readerHeaders["if-modified-since"] = previous.lastModified;
    const response = await fetchImpl(BINANCE_AGENT_OS_READER_URL, {
      headers: readerHeaders,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response?.status === 304 && previous?.retrievalMode === "verified_reader") {
      return {
        notModified: true,
        retrievalMode: "verified_reader",
        sourceUrl: BINANCE_AGENT_OS_PAGE_URL,
        retrievalUrl: BINANCE_AGENT_OS_READER_URL,
      };
    }
    if (!response?.ok || response?.status !== 200) throw new Error(`reader returned HTTP ${response?.status ?? "unknown"}`);
    if (response.url && !isTrustedAgentOsReaderUrl(response.url)) throw new Error("reader redirect left the verified Jina source");
    const body = await response.text();
    if (!body.trim()) throw new Error("reader returned an empty response");
    const parsed = parseVerifiedAgentOsPage(body, { reader: true });
    return {
      ...parsed,
      semanticHash: hash([...parsed.signals].sort()),
      retrievalMode: "verified_reader",
      sourceUrl: BINANCE_AGENT_OS_PAGE_URL,
      retrievalUrl: BINANCE_AGENT_OS_READER_URL,
      etag: responseHeader(response, "etag"),
      lastModified: responseHeader(response, "last-modified"),
      sourceOccurredAt: responseLastModified(response, observedAt),
    };
  })()]).then(([result]) => result);
  const directHeaders = {
    accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    "accept-language": "en-US,en;q=0.9",
    "user-agent": "Mozilla/5.0 (compatible; robinhood-launchpad-monitor/0.1)",
  };
  if (previous?.retrievalMode === "canonical" && previous?.etag) directHeaders["if-none-match"] = previous.etag;
  if (previous?.retrievalMode === "canonical" && previous?.lastModified) directHeaders["if-modified-since"] = previous.lastModified;
  try {
    const response = await fetchImpl(BINANCE_AGENT_OS_PAGE_URL, {
      headers: directHeaders,
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    const wafAction = responseHeader(response, "x-amzn-waf-action");
    if (response?.status === 304 && previous?.retrievalMode === "canonical") {
      const readerResult = await readerAttempt;
      if (readerResult.status === "rejected") errors.push(prefixedSourceError("verified reader", readerResult.reason));
      return { notModified: true, retrievalMode: "canonical", sourceUrl: BINANCE_AGENT_OS_PAGE_URL, errors };
    }
    if (wafAction || response?.status === 202) throw new Error(`canonical WAF ${wafAction || "challenge"}`);
    if (!response?.ok || response?.status !== 200) throw new Error(`canonical returned HTTP ${response?.status ?? "unknown"}`);
    const body = await response.text();
    if (!body.trim()) throw new Error("canonical returned an empty response");
    const parsed = parseVerifiedAgentOsPage(body, { responseUrl: response.url || BINANCE_AGENT_OS_PAGE_URL });
    // The reader starts concurrently so WAF fallback is immediate. Always let
    // that attempt settle before returning, otherwise a late 429 mutates the
    // in-memory circuit after the state file has already been committed.
    const readerResult = await readerAttempt;
    if (readerResult.status === "rejected") errors.push(prefixedSourceError("verified reader", readerResult.reason));
    return {
      ...parsed,
      semanticHash: hash([...parsed.signals].sort()),
      retrievalMode: "canonical",
      sourceUrl: BINANCE_AGENT_OS_PAGE_URL,
      etag: responseHeader(response, "etag"),
      lastModified: responseHeader(response, "last-modified"),
      sourceOccurredAt: responseLastModified(response, observedAt),
      errors,
    };
  } catch (error) {
    errors.push(prefixedSourceError("canonical", error));
  }

  const readerResult = await readerAttempt;
  if (readerResult.status === "fulfilled") return { ...readerResult.value, errors };
  errors.push(prefixedSourceError("verified reader", readerResult.reason));
  const failure = new Error(errors.map((error) => error.message).join("; "));
  failure.causes = errors;
  failure.sourceRateLimited = errors.some((error) => error.sourceRateLimited === true);
  failure.wafBlocked = errors.some((error) => error.wafBlocked === true);
  failure.sourceCircuitOpen = errors.every((error) => error.sourceCircuitOpen === true);
  failure.slaUnavailable = errors.some((error) => error.slaUnavailable === true);
  failure.suppressLog = errors.every((error) => error.suppressLog === true);
  const retryTimes = errors.map((error) => Date.parse(error.retryAt || "")).filter(Number.isFinite);
  if (retryTimes.length) failure.retryAt = new Date(Math.min(...retryTimes)).toISOString();
  throw failure;
}

function responseData(payload, label) {
  if (payload?.code !== "000000") throw new Error(`${label} business error ${payload?.code || "invalid_payload"}`);
  return payload.data;
}

export function extractMemeRushCapabilities(payload, target) {
  const raw = responseData(payload, "Meme Rush");
  const items = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
  const protocols = new Map();
  const versions = new Map();
  const tokens = new Map();
  const schemaKeys = new Set();
  for (const item of items) {
    for (const key of Object.keys(item || {})) if (RELEVANT_SCHEMA_KEY.test(key)) schemaKeys.add(key);
    const token = normalizeMemeRushToken(item, target);
    if (token) {
      const key = `${token.chainId}:${token.contractAddress}`;
      tokens.set(key, mergeMemeRushToken(tokens.get(key), token));
    }
    if (item?.protocol != null) {
      const protocol = String(item.protocol);
      const key = `${item.chainId || target.chainId}:${protocol}`;
      const record = protocols.get(key) || {
        chainId: String(item.chainId || target.chainId),
        protocol,
        name: PROTOCOL_NAMES.get(protocol) || null,
        examples: [],
        tokenVersions: [],
        latestCreateTime: null,
      };
      if (item.contractAddress && record.examples.length < 3 && !record.examples.includes(item.contractAddress)) record.examples.push(item.contractAddress);
      if (item.tokenVersion != null && String(item.tokenVersion) !== "" && !record.tokenVersions.includes(String(item.tokenVersion))) record.tokenVersions.push(String(item.tokenVersion));
      const createTime = Number(item.createTime);
      if (Number.isFinite(createTime) && createTime > Number(record.latestCreateTime || 0)) record.latestCreateTime = createTime;
      protocols.set(key, record);
      if (item.tokenVersion != null && String(item.tokenVersion) !== "") {
        const version = String(item.tokenVersion);
        const versionKey = `${record.chainId}:${protocol}:${version}`;
        const versionRecord = versions.get(versionKey) || { chainId: record.chainId, protocol, protocolName: record.name, version, contracts: [] };
        if (item.contractAddress && !versionRecord.contracts.includes(item.contractAddress)) versionRecord.contracts.push(item.contractAddress);
        versions.set(versionKey, versionRecord);
      }
    }
  }
  return {
    items: items.length,
    protocols: [...protocols.values()],
    versions: [...versions.values()],
    tokens: [...tokens.values()],
    schemaKeys: [...schemaKeys].sort(),
  };
}

function normalizedString(value) {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizedNumber(value) {
  if (value == null || value === "") return null;
  const normalized = Number(value);
  return Number.isFinite(normalized) ? normalized : null;
}

function normalizeSocials(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const socials = {};
  for (const key of ["website", "twitter", "telegram"]) {
    const normalized = normalizedString(value[key]);
    if (normalized) socials[key] = normalized;
  }
  return Object.keys(socials).length ? socials : null;
}

function normalizeMemeRushToken(item, target = {}) {
  if (!item || typeof item !== "object") return null;
  const chainId = normalizedString(item.chainId ?? target.chainId);
  const contractAddress = normalizedString(item.contractAddress)?.toLowerCase();
  if (!chainId || !contractAddress) return null;

  const protocol = normalizedString(item.protocol);
  const token = {
    chainId,
    contractAddress,
    sourceId: "binance_wallet_meme_rush",
  };
  if (protocol) {
    token.protocol = protocol;
    token.protocolName = PROTOCOL_NAMES.get(protocol) || normalizedString(item.protocolName);
  }
  const tokenVersion = normalizedString(item.tokenVersion);
  if (tokenVersion) token.tokenVersion = tokenVersion;
  const rankType = normalizedString(target.rankType);
  if (rankType) token.rankTypes = [rankType];

  for (const field of ["name", "symbol", "description", "icon", "devAddress", "pairAnchorAddress", "twitterHandle"]) {
    const value = normalizedString(item[field]);
    if (value) token[field] = /Address$/.test(field) ? value.toLowerCase() : value;
  }
  for (const field of ["createTime", "createHeight", "migrateStatus", "migrateTime", "tradeStartAt", "antiSniperEndBlock", "antiSniperEndTime", "creatorType", "exclusive"]) {
    const value = normalizedNumber(item[field]);
    if (value != null) token[field] = value;
  }
  for (const field of ["launchTaxEnable", "antiSniperTaxType", "taxRateBuy", "taxRateSell"]) {
    const value = item[field];
    if (value !== undefined && value !== null && value !== "") token[field] = value;
  }
  const socials = normalizeSocials(item.socials);
  if (socials) token.socials = socials;
  return token;
}

function mergeMemeRushToken(previous, current) {
  if (!previous) return current;
  return {
    ...previous,
    ...current,
    ...(previous.socials || current.socials ? { socials: { ...(previous.socials || {}), ...(current.socials || {}) } } : {}),
    rankTypes: [...new Set([...(previous.rankTypes || []), ...(current.rankTypes || [])])].sort(),
  };
}

function pruneMemeRushTokenIndex(index, limit) {
  const entries = Object.entries(index);
  if (entries.length <= limit) return index;
  entries.sort(([leftKey, left], [rightKey, right]) => {
    const createDelta = Number(right.createTime || 0) - Number(left.createTime || 0);
    if (createDelta) return createDelta;
    const seenDelta = Date.parse(right.lastSeenAt || 0) - Date.parse(left.lastSeenAt || 0);
    return seenDelta || leftKey.localeCompare(rightKey);
  });
  return Object.fromEntries(entries.slice(0, limit));
}

function updateMemeRushTokenIndex(state, tokens, nowValue, limit) {
  const current = state.memeRush.tokenIndex;
  const index = current && typeof current === "object" && !Array.isArray(current) ? current : {};
  for (const token of tokens) {
    const key = `${token.chainId}:${token.contractAddress}`;
    const previous = index[key];
    index[key] = {
      ...mergeMemeRushToken(previous, token),
      firstSeenAt: previous?.firstSeenAt || nowValue,
      lastSeenAt: nowValue,
    };
  }
  state.memeRush.tokenIndex = pruneMemeRushTokenIndex(index, limit);
}

export function extractLaunchpoolCapabilities(payload) {
  const data = responseData(payload, "Launchpool");
  if (!data || typeof data !== "object") throw new Error("Launchpool payload missing data");
  const buckets = [];
  const items = [];
  for (const [name, value] of Object.entries(data)) {
    if (!value || typeof value !== "object" || !Array.isArray(value.list)) continue;
    buckets.push(name);
    items.push(...value.list);
  }
  return {
    buckets: [...new Set(buckets)].sort(),
    assets: [...new Set(items.map((item) => item?.asset).filter(Boolean).map(String))].sort(),
    statuses: [...new Set(items.map((item) => item?.status).filter(Boolean).map(String))].sort(),
    fields: [...new Set(items.flatMap((item) => Object.keys(item || {})))].sort(),
  };
}

function emptyState() {
  return {
    version: 2,
    announcements: { articles: {} },
    square: { posts: {} },
    developerDocs: { pages: {} },
    memeRush: { baselinedTargets: [], protocols: {}, versions: {}, schemaKeys: [], versionCandidates: {}, tokenIndex: {}, cursor: 0 },
    launchpool: {},
    _health: {},
  };
}

function mainStateHealth(value) {
  const health = value && typeof value === "object" && !Array.isArray(value) ? { ...value } : {};
  // Agent OS is owned by binance-agent-native-state.json. Keeping the old
  // fast-lane snapshot here makes health audits read a stale, second truth.
  delete health.agentOsPage;
  return health;
}

async function enforceOwnerOnlyFile(file, fsImpl = fs) {
  const details = await fsImpl.stat(file);
  if ((details.mode & 0o777) !== 0o600) await fsImpl.chmod(file, 0o600);
}

async function readState(file, fsImpl = fs) {
  try {
    await enforceOwnerOnlyFile(file, fsImpl);
    const parsed = JSON.parse(await fsImpl.readFile(file, "utf8"));
    const baseline = emptyState();
    return {
      ...baseline,
      ...parsed,
      version: baseline.version,
      announcements: { ...baseline.announcements, ...(parsed.announcements || {}), articles: parsed.announcements?.articles || {} },
      square: { ...baseline.square, ...(parsed.square || {}), posts: parsed.square?.posts || {} },
      developerDocs: { ...baseline.developerDocs, ...(parsed.developerDocs || {}), pages: parsed.developerDocs?.pages || {} },
      memeRush: { ...baseline.memeRush, ...(parsed.memeRush || {}) },
      launchpool: { ...baseline.launchpool, ...(parsed.launchpool || {}) },
      _health: mainStateHealth(parsed._health),
    };
  } catch (error) {
    if (error.code === "ENOENT") return emptyState();
    throw error;
  }
}

async function fsyncDirectory(directory, fsImpl = fs) {
  let handle;
  let failure = null;
  try {
    handle = await fsImpl.open(directory, "r");
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    try { await handle?.close(); } catch (closeError) {
      failure = failure
        ? new AggregateError([failure, closeError], "directory fsync failed and its handle did not close cleanly")
        : closeError;
    }
  }
  if (failure) throw failure;
}

async function atomicWrite(file, state, fsImpl = fs) {
  const directory = path.dirname(file);
  await fsImpl.mkdir(directory, { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  let handle;
  let renamed = false;
  let failure = null;
  try {
    handle = await fsImpl.open(temporary, "wx", 0o600);
    await handle.chmod(0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsImpl.rename(temporary, file);
    renamed = true;
    await fsImpl.chmod(file, 0o600);
    await fsyncDirectory(directory, fsImpl);
  } catch (error) {
    failure = error;
  } finally {
    try { await handle?.close(); } catch (closeError) {
      failure = failure
        ? new AggregateError([failure, closeError], "atomic write failed and its temporary handle did not close cleanly")
        : closeError;
    }
    await fsImpl.rm(temporary, { force: true }).catch(() => {});
  }
  if (failure) {
    failure.atomicRenameCompleted = renamed;
    throw failure;
  }
}

async function readJsonResponse(response, label) {
  if (!response?.ok) throw new Error(`${label} returned HTTP ${response?.status ?? "unknown"}`);
  const text = typeof response.text === "function" ? await response.text() : "";
  if (!text && typeof response.json === "function") return response.json();
  if (!text) throw new Error(`${label} returned an empty response`);
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} returned invalid JSON`); }
}

async function fetchWithFallback(urls, fetchImpl, label) {
  const errors = [];
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; robinhood-launchpad-monitor/0.1)",
          accept: "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.9",
          referer: "https://www.binance.com/en/support/announcement",
        },
        signal: AbortSignal.timeout(12_000),
      });
      return { payload: await readJsonResponse(response, label), url };
    } catch (error) { errors.push(`${new URL(url).host}: ${error.message}`); }
  }
  throw new Error(errors.join("; ") || `${label} has no configured source`);
}

function prioritizeActiveSource(urls, activeSource) {
  if (!activeSource) return urls;
  let activeHost;
  try { activeHost = new URL(activeSource).host; }
  catch { return urls; }
  return [...urls].sort((left, right) => Number(new URL(right).host === activeHost) - Number(new URL(left).host === activeHost));
}

function due(record, intervalMs, current) {
  if (!record?.checkedAt) return true;
  return current - Date.parse(record.checkedAt) >= intervalMs;
}

function sourceHealth(state, source) {
  state._health[source] ||= { status: "unknown", consecutiveFailures: 0 };
  return state._health[source];
}

function markHealthy(health, nowValue, details = {}) {
  health.status = "healthy";
  health.checkedAt = nowValue;
  health.lastSuccessAt = nowValue;
  health.consecutiveFailures = 0;
  Object.assign(health, details);
  delete health.lastError;
  delete health.lastErrorAt;
  delete health.detailFailures;
}

function markFailed(health, error, nowValue) {
  health.status = "error";
  health.checkedAt = nowValue;
  health.lastErrorAt = nowValue;
  health.lastError = error.message;
  health.consecutiveFailures = Number(health.consecutiveFailures || 0) + 1;
}

function markDegraded(health, errors, nowValue) {
  health.status = "degraded";
  health.checkedAt = nowValue;
  health.lastErrorAt = nowValue;
  health.lastError = errors.map((error) => error.message).join("; ").slice(0, 1_000);
  health.detailFailures = errors.length;
  health.consecutiveFailures = Number(health.consecutiveFailures || 0) + 1;
}

function pruneArticles(articles) {
  const entries = Object.entries(articles);
  if (entries.length <= ANNOUNCEMENT_RETENTION) return articles;
  entries.sort(([, left], [, right]) => Number(right.releaseDate || 0) - Number(left.releaseDate || 0));
  return Object.fromEntries(entries.slice(0, ANNOUNCEMENT_RETENTION));
}

export function createBinanceMonitor(config, dependencies = {}) {
  const fetchImpl = dependencies.fetchImpl || fetch;
  const alertSender = dependencies.sendAlertsImpl || sendAlerts;
  const logger = dependencies.logger || console;
  const now = dependencies.now || Date.now;
  const autoStart = dependencies.autoStart !== false;
  const memeRushTargets = dependencies.memeRushTargets || DEFAULT_MEME_RUSH_TARGETS;
  const WebSocketImpl = dependencies.WebSocketImpl || WebSocket;
  const memeRushTokenIndexLimit = Math.max(1, Number(dependencies.memeRushTokenIndexLimit) || MEME_RUSH_TOKEN_INDEX_LIMIT);
  const stateFile = path.join(config.dataDir, "binance-state.json");
  const mainSchedulerCheckpointFile = path.join(config.dataDir, "binance-main-scheduler-checkpoint.json");
  const agentNativeStateFile = path.join(config.dataDir, "binance-agent-native-state.json");
  const agentNativeCheckpointFile = path.join(config.dataDir, "binance-agent-native-checkpoint.json");
  const requestedAgentNativePollIntervalMs = Number(
    dependencies.agentNativePollIntervalMs
      ?? config.binanceAgentNativePollIntervalMs
      ?? Math.min(1_000, config.binanceDeveloperPollIntervalMs ?? 1_000),
  );
  const agentNativePollIntervalMs = Math.max(500, Math.min(
    4_000,
    Number.isFinite(requestedAgentNativePollIntervalMs) ? requestedAgentNativePollIntervalMs : 1_000,
  ));
  const fastLaneResponseBudgetMs = Math.max(500, 4_800 - agentNativePollIntervalMs);
  const agentNativeRequestTimeoutMs = Math.max(250, Math.min(
    fastLaneResponseBudgetMs,
    Number(dependencies.agentNativeRequestTimeoutMs) || 2_500,
  ));
  // Agent OS canonical and verified-reader requests run concurrently, so one
  // response budget covers both without sacrificing the WAF fallback.
  const agentOsRequestTimeoutMs = Math.max(250, Math.min(
    fastLaneResponseBudgetMs,
    Number(dependencies.agentOsRequestTimeoutMs) || 2_500,
  ));
  // The scheduler still wakes every second, but it no longer fans that tick
  // out to every public endpoint. One conditional Developer page is rotated
  // per tick, CMS is sampled once per three seconds, and the verified Agent OS
  // reader once per five seconds. After the canonical WAF circuit opens this
  // is ~1.53 requests/second instead of the previous 8 requests/second.
  const agentNativeDeveloperPagesPerCycle = Math.max(1, Math.min(
    BINANCE_AGENT_NATIVE_DOC_URLS.length,
    Number(dependencies.agentNativeDeveloperPagesPerCycle) || 1,
  ));
  const agentNativeCmsPollIntervalMs = Math.max(
    agentNativePollIntervalMs,
    Number(dependencies.agentNativeCmsPollIntervalMs) || 3_000,
  );
  const agentOsPagePollIntervalMs = Math.max(
    agentNativePollIntervalMs,
    Number(dependencies.agentOsPagePollIntervalMs) || 5_000,
  );
  const sourceRateLimitBaseMs = Math.max(5_000, Number(dependencies.agentNativeRateLimitBaseMs) || 60_000);
  const sourceRateLimitMaximumMs = Math.max(sourceRateLimitBaseMs, Number(dependencies.agentNativeRateLimitMaximumMs) || 900_000);
  const sourceWafBackoffMs = Math.max(60_000, Number(dependencies.agentNativeWafBackoffMs) || 900_000);
  const agentNativeDeveloperPerUrlCadenceMs = agentNativePollIntervalMs * Math.ceil(
    BINANCE_AGENT_NATIVE_DOC_URLS.length / agentNativeDeveloperPagesPerCycle,
  );
  let activeCheck = null;
  let activeAgentNativeCheck = null;
  let agentNativeRerunRequested = false;
  let agentNativeRerunStartedAt = null;
  let rerunRequested = false;
  let streamSocket = null;
  let streamPingTimer = null;
  let streamReconnectTimer = null;
  let streamStopped = false;
  let streamFailures = 0;
  let streamMissingCredentialsLogged = false;
  let stateWriteQueue = Promise.resolve();
  let agentNativeStateWriteQueue = Promise.resolve();
  let agentNativeTelemetryTimer = null;
  let pendingAgentNativeTelemetry = null;
  let agentNativeCheckpointWarning = null;
  let agentNativeCheckpointWriteUncertain = false;
  let agentNativeStateWriteUncertain = false;
  const agentNativeStateContexts = new WeakMap();
  let mainStateTelemetryTimer = null;
  let pendingMainStateTelemetry = null;
  let mainSchedulerCheckpointWarning = null;
  let mainSchedulerCheckpointWriteUncertain = false;
  let mainStateWriteUncertain = false;
  const mainSchedulerStateContexts = new WeakMap();
  let stopPromise = null;
  let persistedAnnouncementStreamControl = null;
  const mainStateTelemetryFlushMs = Math.max(1_000, Math.min(
    60_000,
    Number(dependencies.mainStateTelemetryFlushMs) || 60_000,
  ));
  const setTelemetryTimer = dependencies.mainStateSetTimeoutImpl || setTimeout;
  const clearTelemetryTimer = dependencies.mainStateClearTimeoutImpl || clearTimeout;
  const mainStateFs = dependencies.mainStateFsImpl || fs;
  const mainStateAtomicWrite = dependencies.mainStateAtomicWriteImpl
    || ((file, state) => atomicWrite(file, state, mainStateFs));
  const mainSchedulerCheckpointFs = dependencies.mainSchedulerCheckpointFsImpl || mainStateFs;
  const mainSchedulerCheckpointAtomicWrite = dependencies.mainSchedulerCheckpointAtomicWriteImpl
    || ((file, state) => atomicWrite(file, state, mainSchedulerCheckpointFs));
  const agentNativeStateFs = dependencies.agentNativeStateFsImpl || fs;
  const agentNativeStateAtomicWrite = dependencies.agentNativeStateAtomicWriteImpl
    || ((file, state) => atomicWrite(file, state, agentNativeStateFs));
  const agentNativeCheckpointAtomicWrite = dependencies.agentNativeCheckpointAtomicWriteImpl
    || ((file, state) => atomicWrite(file, state, agentNativeStateFs));
  const agentNativeTelemetryFlushMs = Math.max(1_000, Math.min(
    30_000,
    Number(dependencies.agentNativeTelemetryFlushMs) || 30_000,
  ));
  const setAgentNativeTelemetryTimer = dependencies.agentNativeTelemetrySetTimeoutImpl || setTimeout;
  const clearAgentNativeTelemetryTimer = dependencies.agentNativeTelemetryClearTimeoutImpl || clearTimeout;

  async function commitMainState(state) {
    try {
      await mainStateAtomicWrite(stateFile, state);
      mainStateWriteUncertain = false;
    } catch (error) {
      mainStateWriteUncertain = true;
      throw error;
    }
  }

  async function commitAgentNativeState(state) {
    try {
      await agentNativeStateAtomicWrite(agentNativeStateFile, state);
      agentNativeStateWriteUncertain = false;
    } catch (error) {
      agentNativeStateWriteUncertain = true;
      throw error;
    }
  }
  const missingStreamCredentials = [
    !config.binanceApiKey && "BINANCE_API_KEY",
    !config.binanceApiSecret && "BINANCE_API_SECRET",
  ].filter(Boolean);
  const announcementStreamHealth = {
    status: config.binanceAnnouncementStreamEnabled !== true
      ? "disabled"
      : missingStreamCredentials.length
        ? "polling_fallback"
        : "idle",
    streamStatus: config.binanceAnnouncementStreamEnabled !== true
      ? "disabled"
      : missingStreamCredentials.length
        ? "disabled_missing_credentials"
        : "idle",
    enabled: config.binanceAnnouncementStreamEnabled === true,
    configured: missingStreamCredentials.length === 0,
    connected: false,
    websocketObserved: false,
    ...(missingStreamCredentials.length ? {
      missingCredentials: missingStreamCredentials,
      pollingFallbackActive: true,
    } : {}),
  };

  function updateAnnouncementStreamHealth(details) {
    Object.assign(announcementStreamHealth, details, { checkedAt: iso(now) });
  }

  function applyAnnouncementStreamHealth(state) {
    const health = sourceHealth(state, "announcementStream");
    Object.assign(health, announcementStreamHealth);
    const pollingHealth = state._health?.announcements || {};
    const pollingObserved = Boolean(pollingHealth.lastSuccessAt);
    const pollingAvailable = pollingHealth.status === "healthy"
      || (pollingHealth.status === "degraded" && pollingObserved);
    if (announcementStreamHealth.enabled && !announcementStreamHealth.configured) {
      health.status = "polling_fallback";
      health.streamStatus = "disabled_missing_credentials";
      health.pollingFallbackActive = true;
      health.coverage = {
        status: pollingAvailable
          ? "covered_by_polling"
          : pollingHealth.status === "error"
            ? "polling_unavailable"
            : "polling_pending",
        available: pollingAvailable,
        mode: "rest_cms_polling",
        pollingStatus: pollingHealth.status || "unknown",
        ...(pollingHealth.lastSuccessAt ? { lastPollingSuccessAt: pollingHealth.lastSuccessAt } : {}),
      };
      health.sla = {
        status: pollingAvailable
          ? "best_effort_polling"
          : pollingHealth.status === "error"
            ? "degraded"
            : "pending",
        mode: "polling_only",
        websocketAvailable: false,
        hardRealtime: false,
      };
    } else if (announcementStreamHealth.enabled) {
      const streamAvailable = announcementStreamHealth.connected === true;
      health.coverage = {
        status: streamAvailable
          ? "websocket_active"
          : pollingAvailable
            ? "covered_by_polling"
            : "polling_unavailable",
        available: streamAvailable || pollingAvailable,
        mode: streamAvailable ? "official_websocket" : "rest_cms_polling",
      };
      health.sla = {
        status: streamAvailable ? "realtime_stream" : pollingAvailable ? "best_effort_polling" : "degraded",
        mode: streamAvailable ? "websocket" : "polling_fallback",
        websocketAvailable: streamAvailable,
        hardRealtime: streamAvailable,
      };
    }
    return health;
  }

  function enqueueStateWrite(operation) {
    const pending = stateWriteQueue.then(operation, operation);
    stateWriteQueue = pending.catch(() => {});
    return pending;
  }

  const BINANCE_MAIN_SCHEDULER_CHECKPOINT_VERSION = 1;
  const BINANCE_MAIN_SCHEDULER_FIELDS = [
    "memeRushCursor",
    "announcementDetailCheckedAt",
  ];
  const validMainSchedulerIso = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

  function binanceMainSchedulerFields(scheduler = {}, { strict = false } = {}) {
    const rawCursor = Number(scheduler.memeRushCursor);
    if (strict && (!Number.isSafeInteger(scheduler.memeRushCursor) || scheduler.memeRushCursor < 0)) return null;
    const fields = {
      memeRushCursor: Number.isSafeInteger(rawCursor) && rawCursor >= 0
        ? rawCursor % Math.max(1, memeRushTargets.length)
        : 0,
    };
    if (scheduler.announcementDetailCheckedAt != null) {
      if (!validMainSchedulerIso(scheduler.announcementDetailCheckedAt)) {
        if (strict) return null;
      } else {
        fields.announcementDetailCheckedAt = new Date(
          Date.parse(scheduler.announcementDetailCheckedAt),
        ).toISOString();
      }
    }
    return fields;
  }

  function mainStateSchedulerCheckpoint(state) {
    const scheduler = state.scheduler && typeof state.scheduler === "object" && !Array.isArray(state.scheduler)
      ? state.scheduler
      : {};
    const hasCheckpoint = scheduler.checkpointRevision != null || scheduler.checkpointUpdatedAt != null;
    const revision = Number(scheduler.checkpointRevision);
    const checkpointFields = hasCheckpoint ? binanceMainSchedulerFields(scheduler, { strict: true }) : null;
    const validCheckpoint = hasCheckpoint
      && checkpointFields
      && Number.isSafeInteger(revision)
      && revision >= 0
      && validMainSchedulerIso(scheduler.checkpointUpdatedAt);
    const fields = validCheckpoint
      ? checkpointFields
      : binanceMainSchedulerFields({
          memeRushCursor: state.memeRush?.cursor,
          announcementDetailCheckedAt: state.announcements?.detailCheckedAt,
        });
    const candidateTimes = [
      fields.announcementDetailCheckedAt,
    ].filter(validMainSchedulerIso).map((value) => Date.parse(value));
    return {
      version: BINANCE_MAIN_SCHEDULER_CHECKPOINT_VERSION,
      revision: validCheckpoint ? revision : 0,
      updatedAt: validCheckpoint
        ? new Date(Date.parse(scheduler.checkpointUpdatedAt)).toISOString()
        : candidateTimes.length
          ? new Date(Math.max(...candidateTimes)).toISOString()
          : new Date(0).toISOString(),
      scheduler: fields,
    };
  }

  function normalizeMainSchedulerCheckpoint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    if (Object.keys(value).some((key) => !["version", "revision", "updatedAt", "scheduler"].includes(key))
      || value.version !== BINANCE_MAIN_SCHEDULER_CHECKPOINT_VERSION
      || !Number.isSafeInteger(value.revision)
      || value.revision < 0
      || !validMainSchedulerIso(value.updatedAt)
      || !value.scheduler
      || typeof value.scheduler !== "object"
      || Array.isArray(value.scheduler)
      || Object.keys(value.scheduler).some((key) => !BINANCE_MAIN_SCHEDULER_FIELDS.includes(key))) return null;
    const scheduler = binanceMainSchedulerFields(value.scheduler, { strict: true });
    if (!scheduler) return null;
    return {
      version: BINANCE_MAIN_SCHEDULER_CHECKPOINT_VERSION,
      revision: value.revision,
      updatedAt: new Date(Date.parse(value.updatedAt)).toISOString(),
      scheduler,
    };
  }

  const mainSchedulerCheckpointKey = (checkpoint) => checkpoint ? JSON.stringify(checkpoint) : null;
  const mainSchedulerFieldKey = (checkpoint) => JSON.stringify(checkpoint?.scheduler || {});
  const cloneMainSchedulerCheckpoint = (checkpoint) => checkpoint ? structuredClone(checkpoint) : null;

  function mainSchedulerCheckpointsConflict(left, right) {
    return Boolean(left && right
      && left.revision === right.revision
      && left.updatedAt === right.updatedAt
      && mainSchedulerFieldKey(left) !== mainSchedulerFieldKey(right));
  }

  function newerMainSchedulerCheckpoint(left, right) {
    if (!left) return right;
    if (!right) return left;
    if (left.revision !== right.revision) return left.revision > right.revision ? left : right;
    return Date.parse(left.updatedAt) >= Date.parse(right.updatedAt) ? left : right;
  }

  function installMainSchedulerCheckpoint(state, checkpoint) {
    if (!state.scheduler || typeof state.scheduler !== "object" || Array.isArray(state.scheduler)) state.scheduler = {};
    for (const field of BINANCE_MAIN_SCHEDULER_FIELDS) delete state.scheduler[field];
    Object.assign(state.scheduler, checkpoint.scheduler, {
      checkpointRevision: checkpoint.revision,
      checkpointUpdatedAt: checkpoint.updatedAt,
    });
    state.memeRush.cursor = checkpoint.scheduler.memeRushCursor;
    if (checkpoint.scheduler.announcementDetailCheckedAt) {
      state.announcements.detailCheckedAt = checkpoint.scheduler.announcementDetailCheckedAt;
    } else {
      delete state.announcements.detailCheckedAt;
    }
  }

  async function readMainSchedulerCheckpoint() {
    try {
      if (mainSchedulerCheckpointWriteUncertain) return null;
      await enforceOwnerOnlyFile(mainSchedulerCheckpointFile, mainSchedulerCheckpointFs);
      const readFile = typeof mainSchedulerCheckpointFs.readFile === "function"
        ? mainSchedulerCheckpointFs.readFile.bind(mainSchedulerCheckpointFs)
        : fs.readFile.bind(fs);
      const parsed = JSON.parse(await readFile(mainSchedulerCheckpointFile, "utf8"));
      const checkpoint = normalizeMainSchedulerCheckpoint(parsed);
      if (!checkpoint) {
        const error = new Error("invalid Binance main scheduler checkpoint schema");
        error.code = "BINANCE_MAIN_SCHEDULER_CHECKPOINT_INVALID";
        throw error;
      }
      mainSchedulerCheckpointWarning = null;
      return checkpoint;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      const recoverable = error instanceof SyntaxError
        || error.code === "BINANCE_MAIN_SCHEDULER_CHECKPOINT_INVALID";
      if (!recoverable) throw error;
      const warning = `${error.code || "invalid"}:${error.message}`;
      if (warning !== mainSchedulerCheckpointWarning) {
        logger.error(`[binance][main-scheduler-checkpoint] ${error.message}; using main-state scheduler`);
        mainSchedulerCheckpointWarning = warning;
      }
      return null;
    }
  }

  async function readMainState() {
    const state = await readState(stateFile, mainStateFs);
    const mainCheckpoint = mainStateSchedulerCheckpoint(state);
    const sidecarCheckpoint = await readMainSchedulerCheckpoint();
    if (mainSchedulerCheckpointsConflict(mainCheckpoint, sidecarCheckpoint)) {
      const error = new Error("Binance main scheduler checkpoint conflict at the same revision and timestamp");
      error.code = "BINANCE_MAIN_SCHEDULER_CHECKPOINT_CONFLICT";
      throw error;
    }
    const selectedCheckpoint = newerMainSchedulerCheckpoint(sidecarCheckpoint, mainCheckpoint);
    installMainSchedulerCheckpoint(state, selectedCheckpoint);
    mainSchedulerStateContexts.set(state, {
      persistedCheckpoint: cloneMainSchedulerCheckpoint(selectedCheckpoint),
      persistedSidecar: cloneMainSchedulerCheckpoint(sidecarCheckpoint),
    });
    return state;
  }

  function desiredMainSchedulerCheckpoint(state, context) {
    const fields = binanceMainSchedulerFields(state.scheduler);
    const persisted = context.persistedCheckpoint || mainStateSchedulerCheckpoint(state);
    if (JSON.stringify(fields) === mainSchedulerFieldKey(persisted)) {
      installMainSchedulerCheckpoint(state, persisted);
      return cloneMainSchedulerCheckpoint(persisted);
    }
    const stateRevision = Number(state.scheduler?.checkpointRevision);
    const canReuseDraft = Number.isSafeInteger(stateRevision)
      && stateRevision > persisted.revision
      && validMainSchedulerIso(state.scheduler?.checkpointUpdatedAt);
    const checkpoint = {
      version: BINANCE_MAIN_SCHEDULER_CHECKPOINT_VERSION,
      revision: canReuseDraft ? stateRevision : persisted.revision + 1,
      updatedAt: canReuseDraft
        ? new Date(Date.parse(state.scheduler.checkpointUpdatedAt)).toISOString()
        : iso(now),
      scheduler: fields,
    };
    installMainSchedulerCheckpoint(state, checkpoint);
    return checkpoint;
  }

  async function persistMainSchedulerCheckpoint(state) {
    const context = mainSchedulerStateContexts.get(state);
    if (!context) throw new Error("Binance main scheduler checkpoint context missing");
    const desired = desiredMainSchedulerCheckpoint(state, context);
    await enqueueStateWrite(async () => {
      if (mainSchedulerCheckpointKey(desired) !== mainSchedulerCheckpointKey(context.persistedSidecar)) {
        try {
          await mainSchedulerCheckpointAtomicWrite(mainSchedulerCheckpointFile, desired);
          mainSchedulerCheckpointWriteUncertain = false;
        } catch (error) {
          mainSchedulerCheckpointWriteUncertain = true;
          throw error;
        }
        context.persistedSidecar = cloneMainSchedulerCheckpoint(desired);
      }
      context.persistedCheckpoint = cloneMainSchedulerCheckpoint(desired);
    });
  }

  function snapshotWithPersistedMainScheduler(state) {
    const context = mainSchedulerStateContexts.get(state);
    if (!context) throw new Error("Binance main scheduler checkpoint context missing");
    const snapshot = structuredClone(state);
    installMainSchedulerCheckpoint(snapshot, context.persistedCheckpoint);
    return snapshot;
  }

  const telemetryRecordTime = (record = {}) => Math.max(
    ...["checkedAt", "lastSuccessAt", "lastErrorAt", "lastMessageAt", "connectedAt", "disconnectedAt"]
      .map((field) => Date.parse(record?.[field] || ""))
      .filter(Number.isFinite),
    0,
  );

  const healthErrorClass = (record = {}) => {
    const error = String(record.lastError || "");
    if (/\b429\b|rate.?limit/i.test(error)) return "rate_limited";
    if (/\bwaf\b|challenge/i.test(error)) return "waf_blocked";
    if (/timed?\s*out|timeout|aborted/i.test(error)) return "timeout";
    return error ? "other" : null;
  };

  function healthControlKey(health = {}) {
    // Only the small control plane is compared. Never stringify/hash the
    // multi-megabyte article, Developer, or Meme Rush trees just to decide
    // whether a health-only write can wait.
    const controls = Object.fromEntries(Object.entries(mainStateHealth(health))
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, record = {}]) => [source, {
        status: record.status || null,
        streamStatus: record.streamStatus || null,
        connected: record.connected ?? null,
        pollingFallbackActive: record.pollingFallbackActive ?? null,
        nextRetryAt: record.nextRetryAt || null,
        retryAfter: record.retryAfter || null,
        retryAfterMs: record.retryAfterMs ?? null,
        backoffUntil: record.backoffUntil || null,
        circuitUntil: record.circuitUntil || null,
        rateLimited: record.rateLimited ?? null,
        wafBlocked: record.wafBlocked ?? null,
        coverageStatus: record.coverage?.status || null,
        slaStatus: record.sla?.status || null,
        errorClass: healthErrorClass(record),
      }]));
    return JSON.stringify(controls);
  }

  function announcementStreamControlKey() {
    return healthControlKey({ announcementStream: announcementStreamHealth });
  }

  function captureMainStateTelemetry(state, {
    memeRushMetadata = false,
    announcementDetailCodes = [],
  } = {}) {
    const memeRushObservedAt = state.memeRush?.metadataUpdatedAt
      || state._health?.memeRush?.checkedAt
      || null;
    return {
      health: structuredClone(mainStateHealth(state._health)),
      developerPageChecks: Object.fromEntries(Object.entries(state.developerDocs?.pages || {})
        .filter(([, page]) => page?.checkedAt)
        .map(([url, page]) => [url, page.checkedAt])),
      announcementStream: true,
      ...(memeRushMetadata && validMainSchedulerIso(memeRushObservedAt) ? {
        memeRushMetadata: {
          observedAt: memeRushObservedAt,
          tokenIndex: structuredClone(state.memeRush?.tokenIndex || {}),
        },
      } : {}),
      announcementRecords: Object.fromEntries([...announcementDetailCodes]
        .flatMap((code) => {
          const record = state.announcements?.articles?.[code];
          return record && validMainSchedulerIso(record.detailCheckedAt)
            ? [[code, { observedAt: record.detailCheckedAt, record: structuredClone(record) }]]
            : [];
        })),
    };
  }

  function mergeTelemetryPatch(target, incoming) {
    if (!incoming) return target;
    const merged = target || {
      health: {},
      developerPageChecks: {},
      announcementStream: false,
      announcementRecords: {},
    };
    for (const [source, record] of Object.entries(incoming.health || {})) {
      const previous = merged.health[source];
      if (!previous || telemetryRecordTime(record) >= telemetryRecordTime(previous)) {
        merged.health[source] = structuredClone(record);
      }
    }
    for (const [url, checkedAt] of Object.entries(incoming.developerPageChecks || {})) {
      if (!merged.developerPageChecks[url]
        || Date.parse(checkedAt || "") >= Date.parse(merged.developerPageChecks[url] || "")) {
        merged.developerPageChecks[url] = checkedAt;
      }
    }
    merged.announcementStream ||= incoming.announcementStream === true;
    if (incoming.memeRushMetadata
      && (!merged.memeRushMetadata
        || Date.parse(incoming.memeRushMetadata.observedAt) >= Date.parse(merged.memeRushMetadata.observedAt))) {
      merged.memeRushMetadata = structuredClone(incoming.memeRushMetadata);
    }
    for (const [code, patch] of Object.entries(incoming.announcementRecords || {})) {
      const previous = merged.announcementRecords[code];
      if (!previous || Date.parse(patch.observedAt) >= Date.parse(previous.observedAt)) {
        merged.announcementRecords[code] = structuredClone(patch);
      }
    }
    return merged;
  }

  function applyMainStateTelemetry(state, telemetry) {
    if (!telemetry) return state;
    state._health = mainStateHealth(state._health);
    for (const [source, record] of Object.entries(telemetry.health || {})) {
      const previous = state._health[source];
      // A durable control transition wins ties. A queued healthy telemetry
      // sample can have the same fake-clock/millisecond timestamp as a newer
      // error or recovery; accepting it on equality would roll the durable
      // control plane backwards when the telemetry batch eventually flushes.
      if (!previous || telemetryRecordTime(record) > telemetryRecordTime(previous)) {
        state._health[source] = structuredClone(record);
      }
    }
    for (const [url, checkedAt] of Object.entries(telemetry.developerPageChecks || {})) {
      const page = state.developerDocs?.pages?.[url];
      if (page && (!page.checkedAt || Date.parse(checkedAt || "") >= Date.parse(page.checkedAt || ""))) {
        page.checkedAt = checkedAt;
      }
    }
    if (telemetry.memeRushMetadata) {
      const incomingTime = Date.parse(telemetry.memeRushMetadata.observedAt);
      const durableTime = Date.parse(state.memeRush?.metadataUpdatedAt || "");
      if (!Number.isFinite(durableTime) || incomingTime > durableTime) {
        state.memeRush.tokenIndex = structuredClone(telemetry.memeRushMetadata.tokenIndex || {});
        state.memeRush.metadataUpdatedAt = telemetry.memeRushMetadata.observedAt;
      } else if (incomingTime === durableTime) {
        // Multiple targets in one polling round intentionally share one
        // observedAt. Union equal-time attribution metadata so a material save
        // after target one cannot discard target two/three from the coalesced
        // patch. This does not affect protocol/version detection evidence.
        const mergedIndex = structuredClone(state.memeRush.tokenIndex || {});
        for (const [key, incoming] of Object.entries(telemetry.memeRushMetadata.tokenIndex || {})) {
          const durable = mergedIndex[key];
          if (!durable) {
            mergedIndex[key] = structuredClone(incoming);
            continue;
          }
          const firstSeenAt = [durable.firstSeenAt, incoming.firstSeenAt]
            .filter(validMainSchedulerIso)
            .sort()[0];
          const lastSeenAt = [durable.lastSeenAt, incoming.lastSeenAt]
            .filter(validMainSchedulerIso)
            .sort().at(-1);
          mergedIndex[key] = {
            ...mergeMemeRushToken(durable, incoming),
            ...(firstSeenAt ? { firstSeenAt } : {}),
            ...(lastSeenAt ? { lastSeenAt } : {}),
          };
        }
        state.memeRush.tokenIndex = pruneMemeRushTokenIndex(mergedIndex, memeRushTokenIndexLimit);
      }
    }
    for (const [code, patch] of Object.entries(telemetry.announcementRecords || {})) {
      const current = state.announcements?.articles?.[code];
      if (current && (!validMainSchedulerIso(current.detailCheckedAt)
        || Date.parse(patch.observedAt) > Date.parse(current.detailCheckedAt))) {
        state.announcements.articles[code] = structuredClone(patch.record);
      }
    }
    if (telemetry.announcementStream) applyAnnouncementStreamHealth(state);
    return state;
  }

  function takePendingMainStateTelemetry() {
    if (mainStateTelemetryTimer) clearTelemetryTimer(mainStateTelemetryTimer);
    mainStateTelemetryTimer = null;
    const pending = pendingMainStateTelemetry;
    pendingMainStateTelemetry = null;
    return pending;
  }

  function scheduleMainStateTelemetryFlush() {
    if (mainStateTelemetryTimer) return;
    mainStateTelemetryTimer = setTelemetryTimer(() => {
      mainStateTelemetryTimer = null;
      void flushMainStateTelemetry().catch((error) => {
        logger.error(`[binance][state-telemetry] ${error.message}`);
      });
    }, mainStateTelemetryFlushMs);
    mainStateTelemetryTimer?.unref?.();
  }

  function queueMainStateTelemetry(state = null, options = {}) {
    const { announcementStream = false } = options;
    const telemetry = state
      ? captureMainStateTelemetry(state, options)
      : { health: {}, developerPageChecks: {}, announcementStream, announcementRecords: {} };
    telemetry.announcementStream ||= announcementStream;
    pendingMainStateTelemetry = mergeTelemetryPatch(pendingMainStateTelemetry, telemetry);
    scheduleMainStateTelemetryFlush();
  }

  async function flushMainStateTelemetry() {
    const telemetry = takePendingMainStateTelemetry();
    if (!telemetry && !mainStateWriteUncertain) return;
    try {
      await enqueueStateWrite(async () => {
        const latest = await readMainState();
        applyMainStateTelemetry(latest, telemetry);
        applyAnnouncementStreamHealth(latest);
        await commitMainState(latest);
        persistedAnnouncementStreamControl = announcementStreamControlKey();
      });
    } catch (error) {
      pendingMainStateTelemetry = mergeTelemetryPatch(pendingMainStateTelemetry, telemetry);
      scheduleMainStateTelemetryFlush();
      throw error;
    }
  }

  function applyPendingMainStateTelemetry(state) {
    applyMainStateTelemetry(state, pendingMainStateTelemetry);
    applyAnnouncementStreamHealth(state);
    return state;
  }

  function writeState(state) {
    const telemetry = takePendingMainStateTelemetry();
    applyMainStateTelemetry(state, telemetry);
    const snapshot = snapshotWithPersistedMainScheduler(state);
    return enqueueStateWrite(async () => {
      snapshot._health = mainStateHealth(snapshot._health);
      applyAnnouncementStreamHealth(snapshot);
      try {
        await commitMainState(snapshot);
        persistedAnnouncementStreamControl = announcementStreamControlKey();
      } catch (error) {
        pendingMainStateTelemetry = mergeTelemetryPatch(pendingMainStateTelemetry, telemetry);
        if (pendingMainStateTelemetry) scheduleMainStateTelemetryFlush();
        throw error;
      }
    });
  }

  function createCycleSave(state) {
    let persistedHealthControl = healthControlKey(state._health);
    const save = async () => {
      await writeState(state);
      persistedHealthControl = healthControlKey(state._health);
    };
    save.telemetry = async (options = {}) => {
      applyAnnouncementStreamHealth(state);
      const currentHealthControl = healthControlKey(state._health);
      if (currentHealthControl !== persistedHealthControl) {
        await save();
        return;
      }
      queueMainStateTelemetry(state, options);
    };
    return save;
  }

  function persistAnnouncementStreamHealth() {
    const currentControl = announcementStreamControlKey();
    if (persistedAnnouncementStreamControl === currentControl) {
      queueMainStateTelemetry(null, { announcementStream: true });
      return Promise.resolve();
    }
    const telemetry = takePendingMainStateTelemetry();
    return enqueueStateWrite(async () => {
      const state = await readMainState();
      applyMainStateTelemetry(state, telemetry);
      applyAnnouncementStreamHealth(state);
      try {
        await commitMainState(state);
        persistedAnnouncementStreamControl = currentControl;
      } catch (error) {
        pendingMainStateTelemetry = mergeTelemetryPatch(pendingMainStateTelemetry, telemetry);
        if (pendingMainStateTelemetry) scheduleMainStateTelemetryFlush();
        throw error;
      }
    });
  }

  function persistAnnouncementStreamHealthInBackground() {
    void persistAnnouncementStreamHealth().catch((error) => {
      logger.error(`[binance][announcement-stream-health] ${error.message}`);
    });
  }

  async function deliver(event) {
    const result = await alertSender(config, event);
    if (result?.status === "suppressed" && ["monitoring_source_disabled", "not_relevant", "blocked_event"].includes(result.reason)) {
      const error = new Error(`Binance alert was suppressed before durable queueing: ${result.reason}`);
      error.code = "BINANCE_ALERT_NOT_QUEUED";
      throw error;
    }
    return result;
  }

  async function handleAnnouncementStreamMessage(raw) {
    const receivedAt = iso(now);
    const announcement = parseBinanceAnnouncementStreamMessage(raw);
    if (!announcement) return;
    const article = {
      code: `live-${hash({ title: announcement.title, publishDate: announcement.publishDate })}`,
      title: announcement.title,
      releaseDate: announcement.publishDate,
      catalogId: announcement.catalogId,
      catalogName: announcement.catalogName,
      catalogs: announcement.catalogId == null ? [] : [{ id: announcement.catalogId, name: announcement.catalogName }],
      url: "https://www.binance.com/en/support/announcement",
    };
    const detail = {
      title: announcement.title,
      publishDate: announcement.publishDate,
      body: announcement.body,
      seoDesc: announcement.disclaimer,
    };
    const signal = classifyBinanceAnnouncement(article, detail);
    if (!signal.relevant) return;
    const keyChanges = extractBinanceAnnouncementFacts(detail, announcement.title);
    const announcementDetails = extractBinanceAnnouncementDetails(detail, announcement.title);
    await deliver({
      type: "binance_official_update",
      kind: "announcement",
      eventKey: `binance-announcement-live:${hash({ title: announcement.title.toLowerCase(), publishDate: announcement.publishDate })}`,
      project: projectProfile(signal.project),
      signal,
      article,
      title: announcement.title,
      ...(keyChanges.length ? { keyChanges, factSummary: keyChanges.join("；") } : {}),
      ...(announcementDetails ? { announcementDetails } : {}),
      changeType: "published",
      strong: signal.strong,
      source: {
        id: "binance_announcement_websocket",
        name: "Binance 官方公告 WebSocket",
        url: "https://developers.binance.com/en/docs/products/announcements/announcement",
      },
      url: article.url,
      publishedAt: new Date(announcement.publishDate).toISOString(),
      ...(signal.category === "agent_native" ? { deliverySla: criticalSourceDeliverySla(receivedAt) } : {}),
      observedAt: receivedAt,
    });
  }

  function stopAnnouncementStreamSocket() {
    if (streamPingTimer) clearInterval(streamPingTimer);
    streamPingTimer = null;
    if (streamReconnectTimer) clearTimeout(streamReconnectTimer);
    streamReconnectTimer = null;
    const socket = streamSocket;
    streamSocket = null;
    if (socket && socket.readyState < WebSocketImpl.CLOSING) socket.close(1000, "monitor stopping");
  }

  function scheduleAnnouncementStreamReconnect() {
    if (streamStopped || streamReconnectTimer) return;
    const delay = Math.min(60_000, 1_000 * (2 ** Math.min(streamFailures, 6)));
    streamReconnectTimer = setTimeout(() => {
      streamReconnectTimer = null;
      connectAnnouncementStream();
    }, delay);
    streamReconnectTimer.unref?.();
  }

  function connectAnnouncementStream() {
    if (streamStopped || config.binanceAnnouncementStreamEnabled !== true) return;
    if (missingStreamCredentials.length) {
      updateAnnouncementStreamHealth({
        status: "polling_fallback",
        streamStatus: "disabled_missing_credentials",
        connected: false,
        websocketObserved: false,
        missingCredentials: missingStreamCredentials,
        pollingFallbackActive: true,
      });
      persistAnnouncementStreamHealthInBackground();
      if (!streamMissingCredentialsLogged) {
        streamMissingCredentialsLogged = true;
        logger.info?.(`[binance][announcement-stream] polling_fallback_missing_credentials: set ${missingStreamCredentials.join(" and ")}; REST/CMS polling remains active`);
      }
      return;
    }
    updateAnnouncementStreamHealth({
      status: "connecting",
      streamStatus: "connecting",
      connected: false,
      lastAttemptAt: iso(now),
      consecutiveFailures: streamFailures,
    });
    persistAnnouncementStreamHealthInBackground();
    try {
      const socket = new WebSocketImpl(buildBinanceAnnouncementStreamUrl(config.binanceApiSecret), {
        headers: { "X-MBX-APIKEY": config.binanceApiKey },
      });
      streamSocket = socket;
      socket.on("open", () => {
        streamFailures = 0;
        updateAnnouncementStreamHealth({
          status: "connected",
          streamStatus: "connected",
          connected: true,
          websocketObserved: true,
          connectedAt: iso(now),
          consecutiveFailures: 0,
        });
        delete announcementStreamHealth.lastError;
        delete announcementStreamHealth.lastErrorAt;
        persistAnnouncementStreamHealthInBackground();
        socket.send(JSON.stringify({ command: "SUBSCRIBE", value: BINANCE_ANNOUNCEMENT_STREAM_TOPIC }));
        if (streamPingTimer) clearInterval(streamPingTimer);
        streamPingTimer = setInterval(() => {
          if (socket.readyState === WebSocketImpl.OPEN) socket.ping();
        }, 30_000);
        streamPingTimer.unref?.();
      });
      socket.on("message", (data) => {
        updateAnnouncementStreamHealth({
          status: "healthy",
          streamStatus: "healthy",
          connected: true,
          websocketObserved: true,
          lastMessageAt: iso(now),
        });
        persistAnnouncementStreamHealthInBackground();
        void handleAnnouncementStreamMessage(data).catch((error) => logger.error(`[binance][announcement-stream-message] ${error.message}`));
      });
      socket.on("error", (error) => {
        updateAnnouncementStreamHealth({
          status: "error",
          streamStatus: "error",
          lastErrorAt: iso(now),
          lastError: error.message,
        });
        persistAnnouncementStreamHealthInBackground();
        logger.error(`[binance][announcement-stream] ${error.message}`);
      });
      socket.on("close", (code, reason) => {
        if (streamSocket === socket) streamSocket = null;
        if (streamPingTimer) clearInterval(streamPingTimer);
        streamPingTimer = null;
        streamFailures += 1;
        updateAnnouncementStreamHealth({
          status: streamStopped ? "stopped" : "backoff",
          streamStatus: streamStopped ? "stopped" : "backoff",
          connected: false,
          disconnectedAt: iso(now),
          closeCode: Number(code) || null,
          closeReason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason || ""),
          consecutiveFailures: streamFailures,
        });
        persistAnnouncementStreamHealthInBackground();
        scheduleAnnouncementStreamReconnect();
      });
    } catch (error) {
      streamFailures += 1;
      updateAnnouncementStreamHealth({
        status: "error",
        streamStatus: "error",
        connected: false,
        lastErrorAt: iso(now),
        lastError: error.message,
        consecutiveFailures: streamFailures,
      });
      persistAnnouncementStreamHealthInBackground();
      logger.error(`[binance][announcement-stream-connect] ${error.message}`);
      scheduleAnnouncementStreamReconnect();
    }
  }

  async function fetchAnnouncementDetail(article, activeSource) {
    const urls = prioritizeActiveSource(
      BINANCE_ANNOUNCEMENT_DETAIL_BASE_URLS.map((base) => `${base}${encodeURIComponent(article.code)}`),
      activeSource,
    );
    const { payload, url } = await fetchWithFallback(urls, fetchImpl, "Binance announcement detail");
    return { detail: parseBinanceAnnouncementDetail(payload, article.code), url };
  }

  function announcementEvent(article, detail, signal, {
    changeType,
    detailSource,
    nowValue,
    revisionHash = null,
    revisionRealtimeTrusted = false,
    previousSnapshot = null,
    currentSnapshot = announcementDisplaySnapshot(article, detail, signal),
  }) {
    const project = projectProfile(signal.project);
    const publishedAt = detail?.publishDate || article.releaseDate;
    const keyChanges = extractBinanceAnnouncementFacts(detail, article.title);
    const announcementDetails = extractBinanceAnnouncementDetails(detail, article.title);
    return {
      type: "binance_official_update",
      kind: "announcement",
      eventKey: changeType === "revised"
        ? `binance-announcement:${article.code}:${revisionHash || hash(article.title)}`
        : `binance-announcement:${article.code}`,
      project,
      signal,
      article: {
        ...article,
        ...(detail?.version ? { version: detail.version } : {}),
        ...(detail?.lastUpdateTime ? { lastUpdateTime: detail.lastUpdateTime } : {}),
      },
      title: article.title,
      ...(keyChanges.length ? { keyChanges, factSummary: keyChanges.join("；") } : {}),
      ...(announcementDetails ? { announcementDetails } : {}),
      changeType,
      comparisonBasis: changeType === "revised" ? "exact_snapshot" : "monitoring_baseline",
      ...(changeType === "published" ? { baselineStatus: "not_recorded" } : {}),
      ...(changeType === "revised" ? { previousSnapshot } : {}),
      currentSnapshot,
      changedFields: changedSnapshotFields(previousSnapshot, currentSnapshot),
      strong: signal.strong,
      source: {
        id: signal.scope === "wallet" ? "binance_wallet_cms" : "binance_exchange_cms",
        name: signal.scope === "wallet" ? "Binance Wallet 官方公告" : "Binance 交易所官方公告",
        url: article.url,
      },
      url: article.url,
      publishedAt: publishedAt ? new Date(publishedAt).toISOString() : null,
      updatedAt: detail?.lastUpdateTime ? new Date(detail.lastUpdateTime).toISOString() : null,
      ...(changeType === "revised" ? { revisionRealtimeTrusted } : {}),
      ...(detailSource ? { detailSource } : {}),
      ...(signal.category === "agent_native" ? {
        deliverySla: criticalSourceDeliverySla(nowValue, agentNativePollIntervalMs),
      } : {}),
      observedAt: nowValue,
    };
  }

  async function checkAnnouncements(state, save, current, nowValue) {
    const health = sourceHealth(state, "announcements");
    const exchangeHealth = sourceHealth(state, "exchangeAnnouncements");
    const walletHealth = sourceHealth(state, "walletAnnouncements");
    if (!due(health, config.binanceAnnouncementPollIntervalMs ?? 15_000, current)) return;
    const priorSuccessAt = Date.parse(health.lastSuccessAt || "");
    const continuousCoverageWindowMs = Math.max(
      2 * (config.binanceAnnouncementPollIntervalMs ?? 15_000),
      2 * (config.binanceAnnouncementDetailPollIntervalMs ?? 60_000),
    );
    const revisionRealtimeTrusted = Number.isFinite(priorSuccessAt)
      && current - priorSuccessAt <= continuousCoverageWindowMs;
    let businessDirty = false;
    const announcementDetailCodes = new Set();
    try {
      const announcementUrls = prioritizeActiveSource(BINANCE_ANNOUNCEMENT_URLS, health.activeSource);
      const { payload, url: activeSource } = await fetchWithFallback(announcementUrls, fetchImpl, "Binance announcements");
      const articles = parseBinanceAnnouncements(payload);
      const articlesByCode = new Map(articles.map((article) => [article.code, article]));
      const detailsAttempted = new Set();
      const detailFailures = [];
      if (!state.announcements.initializedAt) {
        for (const article of articles) {
          state.announcements.articles[article.code] = {
            title: article.title,
            listTitle: article.title,
            releaseDate: article.releaseDate,
            catalogs: article.catalogs,
            displaySnapshot: announcementDisplaySnapshot(article),
          };
        }
        state.announcements.initializedAt = nowValue;
        businessDirty = true;
      } else {
        for (const article of articles) {
          const previous = state.announcements.articles[article.code];
          const exactTitleRevision = previous && (previous.listTitle || previous.title) !== article.title;
          const revised = exactTitleRevision && !(
            classifyAgentNativeOfficialText(article.title).relevant
            && agentNativeTitleSemantic(previous.listTitle || previous.title) === agentNativeTitleSemantic(article.title)
          );
          if (!previous || revised) {
            const preliminary = classifyBinanceAnnouncement(article);
            const catalogs = articleCatalogIds(article);
            const needsDetail = preliminary.relevant
              || WALLET_CONTEXT.test(article.title)
              || EXPLICIT_WALLET_MODE.test(article.title)
              || [BINANCE_CATALOGS.news, BINANCE_CATALOGS.activities, BINANCE_CATALOGS.maintenance]
                .some((catalogId) => catalogs.has(catalogId));
            let detail = null;
            let detailSource = null;
            if (needsDetail) {
              detailsAttempted.add(article.code);
              try {
                ({ detail, url: detailSource } = await fetchAnnouncementDetail(article, activeSource));
              } catch (error) {
                const failure = new Error(`${article.code}: ${error.message}`);
                detailFailures.push(failure);
                logger.error(`[binance][announcement-detail] ${failure.message}`);
                // A title that is already conclusive is delivered immediately. Articles
                // that need detail evidence remain unseen and are retried next poll.
                if (!preliminary.relevant) continue;
              }
            }
            const effectiveArticle = detail?.title ? { ...article, title: detail.title } : article;
            const signal = detail ? classifyBinanceAnnouncement(effectiveArticle, detail) : preliminary;
            const effectiveRevised = Boolean(previous && previous.title !== effectiveArticle.title);
            const previousSnapshot = previous ? announcementSnapshotFromRecord(previous) : null;
            const currentSnapshot = announcementDisplaySnapshot(effectiveArticle, detail, signal);
            if (signal.relevant && (!previous || effectiveRevised)) {
              await deliver(announcementEvent(effectiveArticle, detail, signal, {
                changeType: effectiveRevised ? "revised" : "published",
                detailSource,
                nowValue,
                revisionRealtimeTrusted,
                previousSnapshot,
                currentSnapshot,
              }));
            }
            state.announcements.articles[article.code] = {
              title: effectiveArticle.title,
              listTitle: article.title,
              releaseDate: detail?.publishDate || article.releaseDate,
              catalogs: article.catalogs,
              relevant: signal.relevant,
              detailCheckedAt: detail ? nowValue : null,
              detailPending: Boolean(needsDetail && !detail),
              ...(signal.relevant ? { scope: signal.scope, category: signal.category } : {}),
              ...(detail ? {
                version: detail.version,
                lastUpdateTime: detail.lastUpdateTime,
                semanticHash: detail.semanticHash,
                materialHash: detail.materialHash,
                signalHash: signalHash(signal),
                contentHash: detail.contentHash,
              } : {}),
              displaySnapshot: currentSnapshot,
            };
            await save();
            businessDirty = false;
          }
        }

        const refreshIntervalMs = config.binanceAnnouncementDetailPollIntervalMs ?? 60_000;
        if (due({ checkedAt: state.announcements.detailCheckedAt }, refreshIntervalMs, current)) {
          state.announcements.detailCheckedAt = nowValue;
          state.scheduler.announcementDetailCheckedAt = nowValue;
          const refreshCandidate = Object.entries(state.announcements.articles)
            .filter(([code, record]) => record?.relevant === true
              && articlesByCode.has(code)
              && !detailsAttempted.has(code)
              && Number(record.releaseDate || 0) >= current - 14 * 24 * 60 * 60 * 1_000)
            .sort(([, left], [, right]) => {
              const checkedDelta = (Date.parse(left.detailCheckedAt || "") || 0) - (Date.parse(right.detailCheckedAt || "") || 0);
              return checkedDelta || Number(right.releaseDate || 0) - Number(left.releaseDate || 0);
            })[0];
          if (refreshCandidate) {
            const [code, previous] = refreshCandidate;
            const listArticle = articlesByCode.get(code);
            try {
              const { detail, url: detailSource } = await fetchAnnouncementDetail(listArticle, activeSource);
              const effectiveArticle = detail.title ? { ...listArticle, title: detail.title } : listArticle;
              const signal = classifyBinanceAnnouncement(effectiveArticle, detail);
              const semanticRevision = Boolean(previous.semanticHash && previous.semanticHash !== detail.semanticHash);
              const titleRevision = previous.title !== effectiveArticle.title;
              const materialRevision = previous.materialHash !== undefined
                && previous.materialHash !== detail.materialHash
                && Boolean(previous.materialHash || detail.materialHash);
              const nextSignalHash = signalHash(signal);
              const classificationRevision = Boolean(previous.signalHash && previous.signalHash !== nextSignalHash);
              const actualRevision = semanticRevision || titleRevision || materialRevision || classificationRevision;
              const previousSnapshot = announcementSnapshotFromRecord(previous);
              const currentSnapshot = announcementDisplaySnapshot(effectiveArticle, detail, signal);
              if (previous.contentHash && signal.relevant && actualRevision) {
                await deliver(announcementEvent(effectiveArticle, detail, signal, {
                  changeType: "revised",
                  detailSource,
                  nowValue,
                  revisionHash: detail.contentHash,
                  revisionRealtimeTrusted,
                  previousSnapshot,
                  currentSnapshot,
                }));
              }
              const updatedRecord = {
                ...previous,
                title: effectiveArticle.title,
                listTitle: listArticle.title,
                releaseDate: detail.publishDate || listArticle.releaseDate,
                catalogs: listArticle.catalogs,
                relevant: signal.relevant,
                detailCheckedAt: nowValue,
                detailPending: false,
                ...(signal.relevant ? { scope: signal.scope, category: signal.category } : {}),
                version: detail.version,
                lastUpdateTime: detail.lastUpdateTime,
                semanticHash: detail.semanticHash,
                materialHash: detail.materialHash,
                signalHash: nextSignalHash,
                contentHash: detail.contentHash,
                displaySnapshot: currentSnapshot,
              };
              delete updatedRecord.lastDetailError;
              delete updatedRecord.lastDetailErrorAt;
              delete updatedRecord.detailFailureCount;
              state.announcements.articles[code] = updatedRecord;
              announcementDetailCodes.add(code);
              const detailControlRecovered = previous.detailPending === true
                || previous.lastDetailError != null
                || previous.lastDetailErrorAt != null;
              if (!previous.contentHash || actualRevision || detailControlRecovered) {
                await save();
                businessDirty = false;
              }
            } catch (error) {
              const failure = new Error(`${code}: ${error.message}`);
              detailFailures.push(failure);
              logger.error(`[binance][announcement-detail] ${failure.message}`);
              state.announcements.articles[code] = {
                ...previous,
                detailCheckedAt: nowValue,
                detailPending: true,
                lastDetailError: error.message,
                lastDetailErrorAt: nowValue,
                detailFailureCount: Number(previous.detailFailureCount || 0) + 1,
              };
              announcementDetailCodes.add(code);
              const detailErrorTransition = previous.detailPending !== true
                || previous.lastDetailError !== error.message;
              if (detailErrorTransition) {
                await save();
                businessDirty = false;
              }
            }
          }
          // The small owner-only checkpoint makes the detail sweep cadence
          // crash durable without rewriting the multi-megabyte article tree.
          // If this rename fails, the old checkpoint remains authoritative and
          // restart safely rechecks rather than skipping an unseen revision.
          await persistMainSchedulerCheckpoint(state);
        }
      }
      const prunedArticles = pruneArticles(state.announcements.articles);
      if (prunedArticles !== state.announcements.articles) businessDirty = true;
      state.announcements.articles = prunedArticles;
      const healthDetails = {
        activeSource,
        articles: articles.length,
        catalogs: [...new Set(articles.flatMap((article) => article.catalogs?.map((catalog) => catalog.id) || []))].sort((left, right) => left - right),
        pendingDetails: Object.values(state.announcements.articles).filter((record) => record?.detailPending === true).length,
      };
      markHealthy(health, nowValue, healthDetails);
      markHealthy(exchangeHealth, nowValue, healthDetails);
      markHealthy(walletHealth, nowValue, healthDetails);
      const coverageErrors = detailFailures.length
        ? detailFailures
        : healthDetails.pendingDetails
          ? [new Error(`${healthDetails.pendingDetails} announcement detail checks pending`)]
          : [];
      if (coverageErrors.length) {
        markDegraded(health, coverageErrors, nowValue);
        markDegraded(exchangeHealth, coverageErrors, nowValue);
        markDegraded(walletHealth, coverageErrors, nowValue);
      }
    } catch (error) {
      markFailed(health, error, nowValue);
      markFailed(exchangeHealth, error, nowValue);
      markFailed(walletHealth, error, nowValue);
      logger.error(`[binance][announcements] ${error.message}`);
    }
    if (businessDirty) await save();
    else await save.telemetry({ announcementDetailCodes });
  }

  async function fetchMemeRush(target, limit = MEME_RUSH_PAGE_LIMIT) {
    const response = await fetchImpl(BINANCE_MEME_RUSH_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept-encoding": "identity",
        "user-agent": "binance-web3/2.0 (Skill)",
      },
      body: JSON.stringify({ chainId: target.chainId, rankType: target.rankType, limit }),
      signal: AbortSignal.timeout(12_000),
    });
    return extractMemeRushCapabilities(await readJsonResponse(response, "Binance Wallet Meme Rush"), target);
  }

  async function checkMemeRush(state, save, current, nowValue) {
    const health = sourceHealth(state, "memeRush");
    if (!due(health, config.binanceMemeRushPollIntervalMs ?? 5_000, current)) return;
    const baseline = new Set(state.memeRush.baselinedTargets || []);
    const selected = baseline.size === 0
      ? memeRushTargets
      : Array.from(
          { length: Math.min(3, memeRushTargets.length) },
          (_, offset) => memeRushTargets[(Number(state.memeRush.cursor || 0) + offset) % memeRushTargets.length],
        );
    let successes = 0;
    let durableDirty = false;
    try {
      const results = await Promise.allSettled(selected.map(async (target) => ({ target, capabilities: await fetchMemeRush(target) })));
      for (const result of results) {
        if (result.status === "rejected") {
          logger.error(`[binance][meme-rush] ${result.reason?.message || result.reason}`);
          continue;
        }
        successes += 1;
        const { target, capabilities } = result.value;
        const key = targetKey(target);
        const firstTargetObservation = !baseline.has(key);
        const globallyInitialized = Boolean(state.memeRush.initializedAt);
        const candidateProtocols = capabilities.protocols.filter((item) => !state.memeRush.protocols[`${item.chainId}:${item.protocol}`]);
        const newSchemaKeys = capabilities.schemaKeys.filter((item) => !state.memeRush.schemaKeys.includes(item));
        const newlyConfirmedVersions = [];
        let alertAccepted = false;

        for (const version of capabilities.versions) {
          const versionKey = `${version.chainId}:${version.protocol}:${version.version}`;
          if (state.memeRush.versions[versionKey]) continue;
          const previousCandidate = state.memeRush.versionCandidates[versionKey];
          const contracts = [...new Set([...(previousCandidate?.contracts || []), ...version.contracts])].slice(0, 10);
          const evidenceChanged = !previousCandidate
            || JSON.stringify(contracts) !== JSON.stringify(previousCandidate.contracts || []);
          const candidate = evidenceChanged
            ? { ...(previousCandidate || version), contracts, lastSeenAt: nowValue }
            : previousCandidate;
          if (evidenceChanged) {
            state.memeRush.versionCandidates[versionKey] = candidate;
            durableDirty = true;
          }
          if (candidate.contracts.length >= 2) newlyConfirmedVersions.push(candidate);
        }

        const recentBaselineProtocols = !globallyInitialized
          ? candidateProtocols.filter((item) => item.chainId === "56"
            && !DOCUMENTED_MEME_RUSH_PROTOCOLS.has(item.protocol)
            && Number(item.latestCreateTime || 0) >= current - 24 * 60 * 60 * 1_000
            && item.tokenVersions.some((version) => /^openfour\.meme\./i.test(version)))
          : [];
        if (recentBaselineProtocols.length) {
          const protocolKeys = new Set(recentBaselineProtocols.map((item) => `${item.chainId}:${item.protocol}`));
          const changes = {
            newProtocols: recentBaselineProtocols,
            newVersions: newlyConfirmedVersions
              .filter((item) => protocolKeys.has(`${item.chainId}:${item.protocol}`))
              .map(({ contracts, ...item }) => ({ ...item, evidenceCount: contracts.length })),
            newSchemaKeys: [],
          };
          await deliver({
            type: "binance_official_update",
            kind: "meme_rush_capability",
            eventKey: `binance-meme-rush-baseline-gap:${recentBaselineProtocols.map((item) => `${item.chainId}:${item.protocol}`).join(",")}`,
            project: projectProfile("binance-wallet"),
            signal: { relevant: true, labels: ["Meme Rush 新平台/新模式"] },
            changes,
            baselineDiscovery: true,
            strong: true,
            source: { id: "meme_rush_api", name: "Binance Wallet Meme Rush 官方接口", url: BINANCE_SKILLS_URL },
            url: BINANCE_SKILLS_URL,
            observedAt: nowValue,
          });
          alertAccepted = true;
        }

        const shouldNotify = globallyInitialized && !firstTargetObservation && (candidateProtocols.length || newlyConfirmedVersions.length || newSchemaKeys.length);
        if (shouldNotify) {
          const changes = {
            newProtocols: candidateProtocols,
            newVersions: newlyConfirmedVersions.map(({ contracts, ...item }) => ({ ...item, evidenceCount: contracts.length })),
            newSchemaKeys,
          };
          await deliver({
            type: "binance_official_update",
            kind: "meme_rush_capability",
            eventKey: `binance-meme-rush:${hash(changes)}`,
            project: projectProfile("binance-wallet"),
            signal: { relevant: true, labels: ["Meme Rush 新平台/新模式"] },
            changes,
            strong: true,
            source: { id: "meme_rush_api", name: "Binance Wallet Meme Rush 官方接口", url: BINANCE_SKILLS_URL },
            url: BINANCE_SKILLS_URL,
            observedAt: nowValue,
          });
          alertAccepted = true;
        }

        // A protocol's first official observation is durable detection evidence.
        // Later rank pages rotate examples, latestCreateTime and tokenVersions;
        // overwriting the first record with those presentation-only snapshots
        // caused a multi-megabyte write every five seconds without improving
        // new-protocol or new-version detection.
        for (const protocol of capabilities.protocols) {
          const protocolKey = `${protocol.chainId}:${protocol.protocol}`;
          if (!state.memeRush.protocols[protocolKey]) {
            state.memeRush.protocols[protocolKey] = protocol;
            durableDirty = true;
          }
        }
        // This bounded official-feed snapshot is attribution metadata only. Contract safety
        // decisions remain entirely outside the Binance monitor. It is merged
        // into the next <=60s telemetry checkpoint rather than forcing a full
        // state rewrite on every rank rotation.
        updateMemeRushTokenIndex(state, capabilities.tokens, nowValue, memeRushTokenIndexLimit);
        state.memeRush.metadataUpdatedAt = nowValue;
        for (const version of capabilities.versions) {
          const versionKey = `${version.chainId}:${version.protocol}:${version.version}`;
          const candidate = state.memeRush.versionCandidates[versionKey];
          if (!globallyInitialized || candidate?.contracts?.length >= 2) {
            if (!state.memeRush.versions[versionKey]) {
              state.memeRush.versions[versionKey] = { chainId: version.chainId, protocol: version.protocol, protocolName: version.protocolName, version: version.version };
              durableDirty = true;
            }
            delete state.memeRush.versionCandidates[versionKey];
          }
        }
        if (newSchemaKeys.length) {
          state.memeRush.schemaKeys = [...new Set([...state.memeRush.schemaKeys, ...newSchemaKeys])].sort();
          durableDirty = true;
        }
        if (firstTargetObservation) {
          baseline.add(key);
          state.memeRush.baselinedTargets = [...baseline].sort();
          durableDirty = true;
        }
        // Alert acceptance is followed by a durable evidence write before the
        // next target is processed. The scheduler cursor itself is committed
        // separately only after all material evidence is safe.
        if (alertAccepted) {
          await save();
          durableDirty = false;
        }
      }
      if (!successes) throw new Error("all Meme Rush probes failed");
      if (memeRushTargets.every((target) => baseline.has(targetKey(target))) && !state.memeRush.initializedAt) {
        state.memeRush.initializedAt = nowValue;
        durableDirty = true;
      }
      // Content/proof is committed with the old durable cursor first. A failed
      // sidecar rename therefore causes a safe re-fetch after restart, while
      // the already accepted alert evidence prevents a replay.
      if (durableDirty) {
        await save();
        durableDirty = false;
      }
      if (baseline.size > 0) {
        const cursor = (Number(state.memeRush.cursor || 0) + Math.max(1, selected.length)) % memeRushTargets.length;
        state.memeRush.cursor = cursor;
        state.scheduler.memeRushCursor = cursor;
        await persistMainSchedulerCheckpoint(state);
      }
      markHealthy(health, nowValue, { targetsChecked: successes, baselineTargets: baseline.size });
    } catch (error) {
      markFailed(health, error, nowValue);
      logger.error(`[binance][meme-rush] ${error.message}`);
    }
    if (durableDirty) await save();
    else await save.telemetry({ memeRushMetadata: successes > 0 });
  }

  async function checkSquare(state, save, current, nowValue) {
    if (config.binanceSquareMonitorEnabled !== true) return;
    const health = sourceHealth(state, "square");
    if (!due(health, config.binanceSquarePollIntervalMs ?? 10_000, current)) return;
    const priorSuccessAt = Date.parse(health.lastSuccessAt || "");
    const revisionRealtimeTrusted = Number.isFinite(priorSuccessAt)
      && current - priorSuccessAt <= 2 * (config.binanceSquarePollIntervalMs ?? 10_000);
    let businessDirty = false;
    try {
      const response = await fetchImpl(BINANCE_SQUARE_FEED_URL, {
        headers: { accept: "application/json", "user-agent": "robinhood-launchpad-monitor/0.1" },
        signal: AbortSignal.timeout(12_000),
      });
      const posts = parseBinanceSquarePosts(await readJsonResponse(response, "Binance Square"));
      if (!state.square.initializedAt) {
        for (const post of posts) {
          state.square.posts[post.id] = {
            title: post.title,
            contentHash: post.contentHash,
            firstReleaseTime: post.firstReleaseTime,
            editCount: post.editCount,
            displaySnapshot: squareDisplaySnapshot(post),
          };
        }
        state.square.initializedAt = nowValue;
        businessDirty = true;
      } else {
        for (const post of posts) {
          const previous = state.square.posts[post.id];
          const revised = Boolean(previous && previous.contentHash !== post.contentHash && post.editCount > Number(previous.editCount || 0));
          let currentSnapshot = previous?.displaySnapshot || squareDisplaySnapshot(post);
          let alertAccepted = false;
          if (!previous || revised) {
            const signal = classifyBinanceOfficialText(`${post.title}\n${post.body.slice(0, 8_000)}`);
            currentSnapshot = squareDisplaySnapshot(post, signal);
            if (signal.relevant) {
              const extractedChanges = extractBinanceAnnouncementFacts({ body: post.body }, post.title);
              const keyChanges = extractedChanges.length
                ? extractedChanges
                : [conciseAnnouncementSentence(post.body)].filter(Boolean);
              const previousSnapshot = previous ? squareSnapshotFromRecord(previous) : null;
              await deliver({
                type: "binance_official_update",
                kind: "announcement",
                eventKey: revised ? `binance-square:${post.id}:${post.contentHash}` : `binance-square:${post.id}`,
                project: projectProfile(signal.project || "binance"),
                signal,
                article: { code: `square-${post.id}`, title: post.title, url: post.url },
                title: post.title,
                ...(keyChanges.length ? { keyChanges, factSummary: keyChanges.join("；") } : {}),
                changeType: revised ? "revised" : "published",
                comparisonBasis: revised ? "exact_snapshot" : "monitoring_baseline",
                ...(!revised ? { baselineStatus: "not_recorded" } : { previousSnapshot }),
                currentSnapshot,
                changedFields: changedSnapshotFields(previousSnapshot, currentSnapshot),
                strong: signal.strong,
                source: { id: "binance_square_cms", name: "Binance Square 官方主页", url: BINANCE_SQUARE_PROFILE_URL },
                url: post.url,
                detailSource: BINANCE_SQUARE_FEED_URL,
                publishedAt: post.firstReleaseTime ? new Date(post.firstReleaseTime).toISOString() : null,
                updatedAt: post.editTime ? new Date(post.editTime).toISOString() : null,
                revisionRealtimeTrusted,
                observedAt: nowValue,
              });
              alertAccepted = true;
            }
          }
          const nextRecord = {
            title: post.title,
            contentHash: post.contentHash,
            firstReleaseTime: post.firstReleaseTime,
            editCount: post.editCount,
            displaySnapshot: currentSnapshot,
          };
          const recordChanged = !previous
            || previous.title !== nextRecord.title
            || previous.contentHash !== nextRecord.contentHash
            || previous.firstReleaseTime !== nextRecord.firstReleaseTime
            || previous.editCount !== nextRecord.editCount
            || JSON.stringify(previous.displaySnapshot ?? null) !== JSON.stringify(nextRecord.displaySnapshot ?? null);
          state.square.posts[post.id] = nextRecord;
          businessDirty ||= recordChanged;
          if (alertAccepted) {
            await save();
            businessDirty = false;
          }
        }
        const previousPostCount = Object.keys(state.square.posts).length;
        const retained = Object.entries(state.square.posts)
          .sort(([, left], [, right]) => Number(right.firstReleaseTime || 0) - Number(left.firstReleaseTime || 0))
          .slice(0, 500);
        state.square.posts = Object.fromEntries(retained);
        businessDirty ||= retained.length !== previousPostCount;
      }
      markHealthy(health, nowValue, { posts: posts.length, activeSource: BINANCE_SQUARE_FEED_URL });
    } catch (error) {
      markFailed(health, error, nowValue);
      logger.error(`[binance][square] ${error.message}`);
    }
    if (businessDirty) await save();
    else await save.telemetry();
  }

  async function checkDeveloperDocs(state, save, current, nowValue) {
    if (config.binanceDeveloperMonitorEnabled !== true) return;
    const health = sourceHealth(state, "developerDocs");
    const intervalMs = config.binanceDeveloperPollIntervalMs ?? 30_000;
    if (!due(health, intervalMs, current)) return;
    const previousSuccessAt = Date.parse(health.lastSuccessAt || "");
    const continuousCoverage = Number.isFinite(previousSuccessAt) && current - previousSuccessAt <= 2 * intervalMs;
    const wasInitialized = Boolean(state.developerDocs.initializedAt);
    const failures = [];
    let successes = 0;
    const results = await Promise.allSettled(BINANCE_GENERAL_DEVELOPER_DOC_URLS.map(async (url) => {
      const previous = state.developerDocs.pages[url];
      const headers = { accept: "text/plain,text/markdown;q=0.9,*/*;q=0.1", "user-agent": "robinhood-launchpad-monitor/0.1" };
      if (previous?.etag) headers["if-none-match"] = previous.etag;
      if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
      const response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(12_000) });
      if (response.status === 304) return { url, notModified: true };
      if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
      const markdown = await response.text();
      const snapshot = extractBinanceDeveloperSignalSnapshot(markdown);
      if (Array.isArray(previous?.signals) && previous.signals.length && !snapshot.signals.length) {
        throw new Error(`${url} schema produced no developer signals`);
      }
      return {
        url,
        ...snapshot,
        // Ordering-only documentation edits must not look like a product change.
        semanticHash: hash([...snapshot.signals].sort()),
        etag: responseHeader(response, "etag"),
        lastModified: responseHeader(response, "last-modified"),
        sourceOccurredAt: responseLastModified(response, nowValue),
      };
    }));

    const processDeveloperPage = async ({
      url,
      currentPage,
      sourceId = "binance_developer_docs",
      sourceName = "Binance Developer 官方文档",
    }) => {
      const previous = state.developerDocs.pages[url];
      if (currentPage.notModified) {
        if (previous) previous.checkedAt = nowValue;
        return;
      }
      const previousSignals = Array.isArray(previous?.signals) ? previous.signals : [];
      const previousSignalSet = new Set(previousSignals);
      const currentSignalSet = new Set(currentPage.signals);
      const saturated = Boolean(previous && (
        previous.truncated === true
        || previousSignals.length >= 1_200
        || currentPage.truncated === true
        || currentPage.signals.length >= 1_200
      ));
      const added = previous ? currentPage.signals.filter((line) => !previousSignalSet.has(line)).slice(0, 8) : [];
      const removed = previous && !saturated
        ? previousSignals.filter((line) => !currentSignalSet.has(line)).slice(0, 8)
        : [];
      const profile = classifyDeveloperDelta(url, added, removed);
      const previousSnapshot = previous?.displaySnapshot || (previous
        ? developerDisplaySnapshot(previousSignals, previous)
        : null);
      const currentSnapshot = developerDisplaySnapshot(currentPage.signals, currentPage);
      if (previous
        && continuousCoverage
        && previous.semanticHash !== currentPage.semanticHash
        && (added.length || removed.length)
        && profile.relevant) {
        const critical = added.some((line) => BREAKING_API_CHANGE.test(line)
          || SECURITY_OR_EMERGENCY.test(line)
          || BINANCE_SOCIAL_TRADING_CONTEXT.test(line))
          || removed.some((line) => BREAKING_API_CHANGE.test(line)
            || SECURITY_OR_EMERGENCY.test(line)
            || BINANCE_SOCIAL_TRADING_CONTEXT.test(line));
        const keyChanges = [
          ...added,
          ...removed.map((line) => `Removed: ${line}`),
        ];
        const strong = profile.strong || critical;
        await deliver({
          type: "binance_official_update",
          kind: "developer_update",
          eventKey: `binance-developer:${hash({ url, semanticHash: currentPage.semanticHash })}`,
          project: projectProfile(profile.project),
          signal: {
            relevant: true,
            labels: [`${profile.label} 更新`],
            project: profile.project,
            scope: profile.project === "binance-wallet" ? "wallet" : "exchange",
            category: profile.category || "官方开发文档",
            strong,
          },
          title: `${profile.label} 官方更新`,
          keyChanges,
          factSummary: keyChanges.join("；"),
          addedSignals: added,
          removedSignals: removed,
          changeType: "revised",
          comparisonBasis: saturated ? "bounded_additions_only" : "exact_snapshot",
          ...(saturated ? { removalInferenceSuppressed: true } : {}),
          previousSnapshot,
          currentSnapshot,
          changedFields: changedSnapshotFields(previousSnapshot, currentSnapshot),
          strong,
          source: { id: sourceId, name: sourceName, url },
          url,
          ...(currentPage.sourceOccurredAt ? {
            sourceOccurredAt: currentPage.sourceOccurredAt,
            publishedAt: currentPage.sourceOccurredAt,
          } : {}),
          observedAt: nowValue,
        });
      }
      state.developerDocs.pages[url] = {
        semanticHash: currentPage.semanticHash,
        signals: currentPage.signals,
        totalSignals: currentPage.totalSignals,
        truncated: currentPage.truncated === true,
        etag: currentPage.etag,
        lastModified: currentPage.lastModified,
        sourceOccurredAt: currentPage.sourceOccurredAt || previous?.sourceOccurredAt || null,
        ...(currentPage.retrievalMode ? { retrievalMode: currentPage.retrievalMode } : {}),
        ...(currentPage.retrievalUrl ? { retrievalUrl: currentPage.retrievalUrl } : {}),
        ...(currentPage.verifiedSourceUrl ? { verifiedSourceUrl: currentPage.verifiedSourceUrl } : {}),
        checkedAt: nowValue,
        displaySnapshot: currentSnapshot,
      };
      await save();
    };

    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      const url = BINANCE_GENERAL_DEVELOPER_DOC_URLS[index];
      if (result.status === "rejected") {
        failures.push(new Error(`${url}: ${result.reason?.message || result.reason}`));
        continue;
      }
      successes += 1;
      const currentPage = result.value;
      await processDeveloperPage({ url, currentPage });
    }
    state.developerDocs.initializedAt ||= nowValue;
    if (!successes) {
      markFailed(health, failures[0] || new Error("all Binance Developer probes failed"), nowValue);
    } else if (failures.length) {
      markDegraded(health, failures, nowValue);
      health.lastSuccessAt = nowValue;
      health.pagesChecked = successes;
    } else {
      markHealthy(health, nowValue, { pagesChecked: successes });
    }
    if (!wasInitialized) await save();
    else await save.telemetry();
  }

  const AGENT_NATIVE_CHECKPOINT_VERSION = 1;
  const AGENT_NATIVE_SCHEDULER_FIELDS = [
    "developerCursor",
    "agentOsLastProbeAt",
    "cmsLastProbeAt",
    "cmsActiveSource",
  ];

  const validIsoTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

  function schedulerCheckpointFields(scheduler = {}, { strict = false } = {}) {
    const cursor = Number(scheduler.developerCursor);
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor >= BINANCE_AGENT_NATIVE_DOC_URLS.length) {
      if (strict) return null;
    }
    const fields = {
      developerCursor: Number.isSafeInteger(cursor) && cursor >= 0
        ? cursor % BINANCE_AGENT_NATIVE_DOC_URLS.length
        : 0,
    };
    for (const field of ["agentOsLastProbeAt", "cmsLastProbeAt"]) {
      if (scheduler[field] == null) continue;
      if (!validIsoTime(scheduler[field])) {
        if (strict) return null;
        continue;
      }
      fields[field] = scheduler[field];
    }
    if (scheduler.cmsActiveSource != null) {
      if (!BINANCE_ANNOUNCEMENT_URLS.includes(scheduler.cmsActiveSource)) {
        if (strict) return null;
      } else fields.cmsActiveSource = scheduler.cmsActiveSource;
    }
    return fields;
  }

  function mainSchedulerCheckpoint(scheduler = {}) {
    const revision = Number(scheduler.checkpointRevision);
    const candidateTimes = [
      scheduler.checkpointUpdatedAt,
      scheduler.agentOsLastProbeAt,
      scheduler.cmsLastProbeAt,
    ].filter(validIsoTime).map((value) => Date.parse(value));
    return {
      version: AGENT_NATIVE_CHECKPOINT_VERSION,
      revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : 0,
      updatedAt: candidateTimes.length
        ? new Date(Math.max(...candidateTimes)).toISOString()
        : new Date(0).toISOString(),
      scheduler: schedulerCheckpointFields(scheduler),
    };
  }

  function normalizeAgentNativeCheckpoint(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const topLevelKeys = Object.keys(value);
    if (topLevelKeys.some((key) => !["version", "revision", "updatedAt", "scheduler"].includes(key))) return null;
    if (value.version !== AGENT_NATIVE_CHECKPOINT_VERSION
      || !Number.isSafeInteger(value.revision)
      || value.revision < 0
      || !validIsoTime(value.updatedAt)
      || !value.scheduler
      || typeof value.scheduler !== "object"
      || Array.isArray(value.scheduler)
      || Object.keys(value.scheduler).some((key) => !AGENT_NATIVE_SCHEDULER_FIELDS.includes(key))) return null;
    const scheduler = schedulerCheckpointFields(value.scheduler, { strict: true });
    if (!scheduler) return null;
    return {
      version: AGENT_NATIVE_CHECKPOINT_VERSION,
      revision: value.revision,
      updatedAt: new Date(Date.parse(value.updatedAt)).toISOString(),
      scheduler,
    };
  }

  const checkpointKey = (checkpoint) => checkpoint ? JSON.stringify(checkpoint) : null;
  const checkpointFieldKey = (checkpoint) => JSON.stringify(checkpoint?.scheduler || {});
  const cloneCheckpoint = (checkpoint) => checkpoint ? structuredClone(checkpoint) : null;

  function agentNativeCheckpointsConflict(left, right) {
    return Boolean(left && right
      && left.revision === right.revision
      && left.updatedAt === right.updatedAt
      && checkpointFieldKey(left) !== checkpointFieldKey(right));
  }

  function newerCheckpoint(left, right) {
    if (!left) return right;
    if (!right) return left;
    if (left.revision !== right.revision) return left.revision > right.revision ? left : right;
    return Date.parse(left.updatedAt) >= Date.parse(right.updatedAt) ? left : right;
  }

  function installSchedulerCheckpoint(state, checkpoint) {
    state.scheduler ||= {};
    for (const field of AGENT_NATIVE_SCHEDULER_FIELDS) delete state.scheduler[field];
    Object.assign(state.scheduler, checkpoint.scheduler, {
      checkpointRevision: checkpoint.revision,
      checkpointUpdatedAt: checkpoint.updatedAt,
    });
  }

  async function readAgentNativeCheckpoint() {
    try {
      if (agentNativeCheckpointWriteUncertain) return null;
      await enforceOwnerOnlyFile(agentNativeCheckpointFile, agentNativeStateFs);
      const parsed = JSON.parse(await agentNativeStateFs.readFile(agentNativeCheckpointFile, "utf8"));
      const checkpoint = normalizeAgentNativeCheckpoint(parsed);
      if (!checkpoint) {
        const error = new Error("invalid Agent Native checkpoint schema");
        error.code = "BINANCE_AGENT_NATIVE_CHECKPOINT_INVALID";
        throw error;
      }
      agentNativeCheckpointWarning = null;
      return checkpoint;
    } catch (error) {
      if (error.code === "ENOENT") return null;
      const recoverable = error instanceof SyntaxError
        || error.code === "BINANCE_AGENT_NATIVE_CHECKPOINT_INVALID";
      if (!recoverable) throw error;
      const warning = `${error.code || "invalid"}:${error.message}`;
      if (warning !== agentNativeCheckpointWarning) {
        logger.error(`[binance][agent-native-checkpoint] ${error.message}; using main-state scheduler`);
        agentNativeCheckpointWarning = warning;
      }
      return null;
    }
  }

  const agentNativeTelemetryRecordTime = (record = {}) => Math.max(
    ...[
      "checkedAt", "lastSuccessAt", "lastErrorAt", "lastStartedAt", "startedAt",
      "lastAttemptAt", "lastFailureAt", "lastLimitedAt", "lastLoggedAt", "lastLoggedErrorAt",
    ].map((field) => Date.parse(record?.[field] || "")).filter(Number.isFinite),
    0,
  );

  function sourceControlTelemetry(record = {}) {
    const telemetry = {};
    for (const field of ["lastAttemptAt", "lastSuccessAt", "lastFailureAt", "lastLimitedAt", "lastLoggedAt"]) {
      if (validIsoTime(record[field])) telemetry[field] = record[field];
    }
    if (Number.isFinite(Number(record.totalAttempts))) telemetry.totalAttempts = Number(record.totalAttempts);
    for (const field of ["latencyMs", "lastLatencyMs", "responseTimeMs"]) {
      if (Number.isFinite(Number(record[field]))) telemetry[field] = Number(record[field]);
    }
    return telemetry;
  }

  function captureAgentNativeTelemetry(state) {
    return {
      health: structuredClone(state._health || {}),
      pageChecks: Object.fromEntries(Object.entries(state.pages || {})
        .filter(([, page]) => validIsoTime(page?.checkedAt))
        .map(([url, page]) => [url, page.checkedAt])),
      sourceControls: Object.fromEntries(Object.entries(state.sourceControls || {})
        .map(([url, record]) => [url, sourceControlTelemetry(record)])),
    };
  }

  function mergeAgentNativeTelemetry(target, incoming) {
    if (!incoming) return target;
    const merged = target || { health: {}, pageChecks: {}, sourceControls: {} };
    for (const [source, record] of Object.entries(incoming.health || {})) {
      const previous = merged.health[source];
      if (!previous || agentNativeTelemetryRecordTime(record) >= agentNativeTelemetryRecordTime(previous)) {
        merged.health[source] = structuredClone(record);
      }
    }
    for (const [url, checkedAt] of Object.entries(incoming.pageChecks || {})) {
      if (!merged.pageChecks[url] || Date.parse(checkedAt) >= Date.parse(merged.pageChecks[url])) {
        merged.pageChecks[url] = checkedAt;
      }
    }
    for (const [url, record] of Object.entries(incoming.sourceControls || {})) {
      const previous = merged.sourceControls[url];
      if (!previous || agentNativeTelemetryRecordTime(record) >= agentNativeTelemetryRecordTime(previous)) {
        merged.sourceControls[url] = { ...(previous || {}), ...record };
      }
    }
    return merged;
  }

  function applyAgentNativeTelemetry(state, telemetry) {
    if (!telemetry) return state;
    state._health ||= {};
    for (const [source, record] of Object.entries(telemetry.health || {})) {
      const previous = state._health[source];
      if (!previous || agentNativeTelemetryRecordTime(record) > agentNativeTelemetryRecordTime(previous)) {
        state._health[source] = structuredClone(record);
      }
    }
    for (const [url, checkedAt] of Object.entries(telemetry.pageChecks || {})) {
      const page = state.pages?.[url];
      if (page && (!page.checkedAt || Date.parse(checkedAt) > Date.parse(page.checkedAt))) page.checkedAt = checkedAt;
    }
    state.sourceControls ||= {};
    for (const [url, record] of Object.entries(telemetry.sourceControls || {})) {
      const control = sourceControl(state, url);
      for (const field of ["lastAttemptAt", "lastSuccessAt", "lastFailureAt", "lastLimitedAt", "lastLoggedAt"]) {
        if (record[field] && (!control[field] || Date.parse(record[field]) > Date.parse(control[field]))) control[field] = record[field];
      }
      if (Number(record.totalAttempts) > Number(control.totalAttempts || 0)) control.totalAttempts = Number(record.totalAttempts);
      if (agentNativeTelemetryRecordTime(record) >= agentNativeTelemetryRecordTime(control)) {
        for (const field of ["latencyMs", "lastLatencyMs", "responseTimeMs"]) {
          if (record[field] != null) control[field] = record[field];
        }
      }
    }
    return state;
  }

  function agentNativeControlKey(state) {
    const health = Object.fromEntries(Object.entries(state._health || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([source, record = {}]) => [source, {
        status: record.status || null,
        errorClass: healthErrorClass(record),
        coverageStatus: record.coverage?.status || null,
        coverageAvailable: record.coverage?.available ?? null,
        slaStatus: record.sla?.status || null,
        sourceLimited: record.sla?.sourceLimited ?? null,
        sourceRateLimited: record.sourceRateLimited ?? null,
        slaUnavailable: record.slaUnavailable ?? null,
        nextRetryAt: record.nextRetryAt || record.sla?.nextRetryAt || null,
        fallbackActive: record.fallbackActive || null,
        retrievalMode: record.retrievalMode || null,
        canonicalSourceDegraded: record.canonicalSourceDegraded ?? null,
        rateLimitedSources: record.rateLimitedSources || [],
        wafBlockedSources: record.wafBlockedSources || [],
        hardFiveSecondGuarantee: record.hardFiveSecondGuarantee ?? null,
        slaMode: record.slaMode || null,
      }]));
    const controls = Object.fromEntries(Object.entries(state.sourceControls || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([url, record = {}]) => [url, {
        status: record.status || null,
        reason: record.reason || null,
        blockedUntil: record.blockedUntil || null,
        retryAfterMs: record.retryAfterMs ?? null,
        consecutiveRateLimits: Number(record.consecutiveRateLimits || 0),
        sourceRateLimited: record.sourceRateLimited ?? null,
        slaUnavailable: record.slaUnavailable ?? null,
        errorClass: healthErrorClass(record),
      }]));
    return JSON.stringify({ health, controls });
  }

  function enqueueAgentNativeStateWrite(operation) {
    const pending = agentNativeStateWriteQueue.then(operation, operation);
    agentNativeStateWriteQueue = pending.catch(() => {});
    return pending;
  }

  function takePendingAgentNativeTelemetry() {
    if (agentNativeTelemetryTimer) clearAgentNativeTelemetryTimer(agentNativeTelemetryTimer);
    agentNativeTelemetryTimer = null;
    const pending = pendingAgentNativeTelemetry;
    pendingAgentNativeTelemetry = null;
    return pending;
  }

  function scheduleAgentNativeTelemetryFlush() {
    if (agentNativeTelemetryTimer) return;
    agentNativeTelemetryTimer = setAgentNativeTelemetryTimer(() => {
      agentNativeTelemetryTimer = null;
      void flushAgentNativeTelemetry().catch((error) => {
        logger.error(`[binance][agent-native-telemetry] ${error.message}`);
      });
    }, agentNativeTelemetryFlushMs);
    agentNativeTelemetryTimer?.unref?.();
  }

  function queueAgentNativeTelemetry(state) {
    pendingAgentNativeTelemetry = mergeAgentNativeTelemetry(
      pendingAgentNativeTelemetry,
      captureAgentNativeTelemetry(state),
    );
    scheduleAgentNativeTelemetryFlush();
  }

  async function flushAgentNativeTelemetry() {
    const telemetry = takePendingAgentNativeTelemetry();
    if (!telemetry && !agentNativeStateWriteUncertain) return;
    try {
      await enqueueAgentNativeStateWrite(async () => {
        const latest = await readAgentNativeState();
        applyAgentNativeTelemetry(latest, telemetry);
        await commitAgentNativeState(latest);
      });
    } catch (error) {
      pendingAgentNativeTelemetry = mergeAgentNativeTelemetry(pendingAgentNativeTelemetry, telemetry);
      scheduleAgentNativeTelemetryFlush();
      throw error;
    }
  }

  function desiredAgentNativeCheckpoint(state, context) {
    const fields = schedulerCheckpointFields(state.scheduler);
    const persisted = context.persistedCheckpoint || mainSchedulerCheckpoint(state.scheduler);
    if (JSON.stringify(fields) === checkpointFieldKey(persisted)) {
      installSchedulerCheckpoint(state, persisted);
      return cloneCheckpoint(persisted);
    }
    const stateRevision = Number(state.scheduler?.checkpointRevision);
    const canReuseDraft = Number.isSafeInteger(stateRevision)
      && stateRevision > persisted.revision
      && validIsoTime(state.scheduler?.checkpointUpdatedAt);
    const checkpoint = {
      version: AGENT_NATIVE_CHECKPOINT_VERSION,
      revision: canReuseDraft ? stateRevision : persisted.revision + 1,
      updatedAt: canReuseDraft
        ? new Date(Date.parse(state.scheduler.checkpointUpdatedAt)).toISOString()
        : iso(now),
      scheduler: fields,
    };
    installSchedulerCheckpoint(state, checkpoint);
    return checkpoint;
  }

  async function persistAgentNativeCheckpointNow(state, context, desired = desiredAgentNativeCheckpoint(state, context)) {
    if (checkpointKey(desired) === checkpointKey(context.persistedSidecar)) {
      context.persistedCheckpoint = cloneCheckpoint(desired);
      return;
    }
    try {
      await agentNativeCheckpointAtomicWrite(agentNativeCheckpointFile, desired);
      agentNativeCheckpointWriteUncertain = false;
    } catch (error) {
      agentNativeCheckpointWriteUncertain = true;
      throw error;
    }
    context.persistedCheckpoint = cloneCheckpoint(desired);
    context.persistedSidecar = cloneCheckpoint(desired);
  }

  function snapshotWithAgentNativeCheckpoint(state, checkpoint) {
    const snapshot = structuredClone(state);
    installSchedulerCheckpoint(snapshot, checkpoint);
    return snapshot;
  }

  async function writeAgentNativeState(state) {
    const context = agentNativeStateContexts.get(state);
    if (!context) throw new Error("Agent Native state checkpoint context missing");
    const telemetry = takePendingAgentNativeTelemetry();
    applyAgentNativeTelemetry(state, telemetry);
    const desired = desiredAgentNativeCheckpoint(state, context);
    // Content/control state is committed with the last durable scheduler first.
    // If the following sidecar rename fails, restart safely re-probes from that
    // older cursor instead of skipping work while retaining the content update.
    const snapshot = snapshotWithAgentNativeCheckpoint(state, context.persistedCheckpoint);
    let mainPersisted = false;
    try {
      await enqueueAgentNativeStateWrite(async () => {
        await commitAgentNativeState(snapshot);
        mainPersisted = true;
        context.persistedMainControlKey = agentNativeControlKey(snapshot);
        await persistAgentNativeCheckpointNow(state, context, desired);
      });
    } catch (error) {
      if (!mainPersisted) {
        pendingAgentNativeTelemetry = mergeAgentNativeTelemetry(pendingAgentNativeTelemetry, telemetry);
        if (pendingAgentNativeTelemetry) scheduleAgentNativeTelemetryFlush();
      }
      throw error;
    }
  }

  async function persistAgentNativeCheckpoint(state) {
    const context = agentNativeStateContexts.get(state);
    if (!context) throw new Error("Agent Native state checkpoint context missing");
    const desired = desiredAgentNativeCheckpoint(state, context);
    await enqueueAgentNativeStateWrite(() => persistAgentNativeCheckpointNow(state, context, desired));
  }

  function createAgentNativeCycleSave(state) {
    const context = agentNativeStateContexts.get(state);
    let persistedControl = context?.persistedMainControlKey || agentNativeControlKey(state);
    const save = async () => {
      try {
        await writeAgentNativeState(state);
      } finally {
        if (context?.persistedMainControlKey) persistedControl = context.persistedMainControlKey;
      }
    };
    save.telemetry = async () => {
      const currentControl = agentNativeControlKey(state);
      if (currentControl !== persistedControl) {
        await save();
        return;
      }
      await persistAgentNativeCheckpoint(state);
      queueAgentNativeTelemetry(state);
    };
    return save;
  }

  function emptyAgentNativeState() {
    return {
      version: 2,
      pages: {},
      cms: { articles: {} },
      scheduler: { developerCursor: 0 },
      sourceControls: {},
      _health: {},
    };
  }

  async function readAgentNativeMainState() {
    try {
      await enforceOwnerOnlyFile(agentNativeStateFile, agentNativeStateFs);
      const parsed = JSON.parse(await agentNativeStateFs.readFile(agentNativeStateFile, "utf8"));
      const baseline = emptyAgentNativeState();
      return {
        ...baseline,
        ...parsed,
        version: baseline.version,
        pages: parsed.pages || {},
        cms: { ...baseline.cms, ...(parsed.cms || {}), articles: parsed.cms?.articles || {} },
        scheduler: { ...baseline.scheduler, ...(parsed.scheduler || {}) },
        sourceControls: parsed.sourceControls || {},
        _health: parsed._health || {},
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // Preserve the existing production cursors when the fast lane is first
      // deployed, so the first two-second tick can compare rather than losing
      // a change to a fresh silent baseline.
      const legacy = await readState(stateFile, mainStateFs);
      const pages = Object.fromEntries([
        ...BINANCE_AGENT_NATIVE_DOC_URLS,
        BINANCE_AGENT_OS_PAGE_URL,
      ].flatMap((url) => legacy.developerDocs.pages[url] ? [[url, legacy.developerDocs.pages[url]]] : []));
      return {
        ...emptyAgentNativeState(),
        migratedAt: iso(now),
        pages,
        cms: {
          initializedAt: legacy.announcements.initializedAt || null,
          articles: legacy.announcements.articles || {},
        },
        _health: {
          developerDocs: { ...(legacy._health.developerDocs || {}) },
          agentOsPage: { ...(legacy._health.agentOsPage || {}) },
          cms: { ...(legacy._health.announcements || {}) },
        },
      };
    }
  }

  async function readAgentNativeState() {
    const state = await readAgentNativeMainState();
    const mainCheckpoint = mainSchedulerCheckpoint(state.scheduler);
    const sidecarCheckpoint = await readAgentNativeCheckpoint();
    if (agentNativeCheckpointsConflict(mainCheckpoint, sidecarCheckpoint)) {
      const error = new Error("Agent Native checkpoint conflict at the same revision and timestamp");
      error.code = "BINANCE_AGENT_NATIVE_CHECKPOINT_CONFLICT";
      throw error;
    }
    const selectedCheckpoint = newerCheckpoint(sidecarCheckpoint, mainCheckpoint);
    installSchedulerCheckpoint(state, selectedCheckpoint);
    agentNativeStateContexts.set(state, {
      persistedCheckpoint: cloneCheckpoint(selectedCheckpoint),
      persistedSidecar: cloneCheckpoint(sidecarCheckpoint),
      persistedMainControlKey: agentNativeControlKey(state),
    });
    return state;
  }

  function sourceControl(state, url) {
    state.sourceControls[url] ||= {
      status: "unknown",
      consecutiveRateLimits: 0,
      totalAttempts: 0,
    };
    return state.sourceControls[url];
  }

  function sourceBlocked(state, url, current = Number(now())) {
    const control = sourceControl(state, url);
    const blockedUntil = Date.parse(control.blockedUntil || "");
    return Number.isFinite(blockedUntil) && current < blockedUntil;
  }

  function sourceProbeDue(state, url, current, intervalMs = 0) {
    if (sourceBlocked(state, url, current)) return false;
    const previousAttempt = Date.parse(sourceControl(state, url).lastAttemptAt || "");
    return !Number.isFinite(previousAttempt) || current - previousAttempt >= intervalMs;
  }

  function circuitOpenError(state, url) {
    const control = sourceControl(state, url);
    const reason = control.reason === "waf_challenge"
      ? "WAF circuit open"
      : control.reason === "http_403"
        ? "access-denied circuit open"
        : "rate-limit circuit open";
    const error = new Error(`${url} ${reason} until ${control.blockedUntil || "next probe"}`);
    error.sourceUrl = url;
    error.status = control.lastStatus || null;
    error.sourceRateLimited = control.reason === "http_429";
    error.wafBlocked = control.reason === "waf_challenge" || control.reason === "http_403";
    error.sourceCircuitOpen = true;
    error.retryAt = control.blockedUntil || null;
    error.suppressLog = true;
    error.slaUnavailable = true;
    return error;
  }

  function setSourceCircuit(state, url, response, reason, current) {
    const control = sourceControl(state, url);
    const observedAt = new Date(current).toISOString();
    const nextFailure = Number(control.consecutiveRateLimits || 0) + 1;
    const exponentialMs = Math.min(
      sourceRateLimitMaximumMs,
      sourceRateLimitBaseMs * (2 ** Math.min(8, nextFailure - 1)),
    );
    const backoffMs = reason === "waf_challenge" || reason === "http_403"
      ? sourceWafBackoffMs
      : retryAfterMilliseconds(response, current, exponentialMs, sourceRateLimitMaximumMs);
    const blockedUntil = new Date(current + backoffMs).toISOString();
    const priorLoggedAt = Date.parse(control.lastLoggedAt || "");
    Object.assign(control, {
      status: reason === "waf_challenge"
        ? "waf_blocked"
        : reason === "http_403"
          ? "access_blocked"
          : "rate_limited",
      reason,
      sourceRateLimited: reason === "http_429",
      slaUnavailable: true,
      lastStatus: Number(response?.status) || null,
      lastLimitedAt: observedAt,
      lastFailureAt: observedAt,
      blockedUntil,
      retryAfterMs: backoffMs,
      consecutiveRateLimits: nextFailure,
    });
    const logCooldownMs = Math.max(sourceRateLimitMaximumMs, sourceWafBackoffMs);
    if (control.lastLoggedReason !== reason
      || !Number.isFinite(priorLoggedAt)
      || current - priorLoggedAt >= logCooldownMs) {
      logger.error(`[binance][agent-native-fast][source-circuit] ${url} ${reason}; retry at ${blockedUntil}`);
      control.lastLoggedAt = observedAt;
      control.lastLoggedReason = reason;
    }
    return circuitOpenError(state, url);
  }

  function markSourceSuccess(state, url, response, current) {
    const control = sourceControl(state, url);
    Object.assign(control, {
      status: "healthy",
      lastStatus: Number(response?.status) || 200,
      lastSuccessAt: new Date(current).toISOString(),
      consecutiveRateLimits: 0,
      sourceRateLimited: false,
      slaUnavailable: false,
    });
    delete control.reason;
    delete control.blockedUntil;
    delete control.retryAfterMs;
    delete control.lastError;
  }

  async function controlledSourceFetch(state, url, options = {}, { wafAware = false } = {}) {
    const currentRaw = now();
    const current = currentRaw instanceof Date ? currentRaw.getTime() : Number(currentRaw);
    if (sourceBlocked(state, url, current)) throw circuitOpenError(state, url);
    const control = sourceControl(state, url);
    control.lastAttemptAt = new Date(current).toISOString();
    control.totalAttempts = Number(control.totalAttempts || 0) + 1;
    let response;
    try {
      response = await fetchImpl(url, options);
    } catch (error) {
      control.status = "error";
      control.lastFailureAt = iso(now);
      control.lastError = error.message;
      throw error;
    }
    const responseCurrentRaw = now();
    const responseCurrent = responseCurrentRaw instanceof Date ? responseCurrentRaw.getTime() : Number(responseCurrentRaw);
    if (response?.status === 429) throw setSourceCircuit(state, url, response, "http_429", responseCurrent);
    const wafAction = responseHeader(response, "x-amzn-waf-action");
    if (wafAction || (wafAware && response?.status === 202)) {
      throw setSourceCircuit(state, url, response, "waf_challenge", responseCurrent);
    }
    if (response?.status === 403) {
      throw setSourceCircuit(state, url, response, wafAware ? "waf_challenge" : "http_403", responseCurrent);
    }
    if (response?.ok || response?.status === 304) markSourceSuccess(state, url, response, responseCurrent);
    else {
      control.status = "error";
      control.lastStatus = Number(response?.status) || null;
      control.lastFailureAt = new Date(responseCurrent).toISOString();
      control.lastError = `HTTP ${response?.status ?? "unknown"}`;
    }
    return response;
  }

  function selectDeveloperProbeUrls(state, current) {
    const selected = [];
    let cursor = Math.max(0, Number(state.scheduler.developerCursor) || 0) % BINANCE_AGENT_NATIVE_DOC_URLS.length;
    for (let inspected = 0; inspected < BINANCE_AGENT_NATIVE_DOC_URLS.length && selected.length < agentNativeDeveloperPagesPerCycle; inspected += 1) {
      const index = (cursor + inspected) % BINANCE_AGENT_NATIVE_DOC_URLS.length;
      const url = BINANCE_AGENT_NATIVE_DOC_URLS[index];
      if (sourceProbeDue(state, url, current, agentNativeDeveloperPerUrlCadenceMs)) selected.push(url);
    }
    if (selected.length) {
      const finalIndex = BINANCE_AGENT_NATIVE_DOC_URLS.indexOf(selected[selected.length - 1]);
      cursor = (finalIndex + 1) % BINANCE_AGENT_NATIVE_DOC_URLS.length;
    }
    state.scheduler.developerCursor = cursor;
    return selected;
  }

  async function fetchFastDeveloperPage(state, url, previous) {
    const headers = {
      accept: "text/plain,text/markdown;q=0.9,*/*;q=0.1",
      "user-agent": "robinhood-launchpad-monitor/0.1",
    };
    if (previous?.etag) headers["if-none-match"] = previous.etag;
    if (previous?.lastModified) headers["if-modified-since"] = previous.lastModified;
    const response = await controlledSourceFetch(state, url, {
      headers,
      signal: AbortSignal.timeout(agentNativeRequestTimeoutMs),
    }, { wafAware: true });
    if (response?.status === 304) return { url, notModified: true };
    if (!response?.ok) throw new Error(`${url} returned HTTP ${response?.status ?? "unknown"}`);
    const markdown = await response.text();
    const snapshot = extractBinanceDeveloperSignalSnapshot(markdown);
    if (Array.isArray(previous?.signals) && previous.signals.length && !snapshot.signals.length) {
      throw new Error(`${url} schema produced no developer signals`);
    }
    const observedAt = iso(now);
    return {
      url,
      ...snapshot,
      semanticHash: hash([...snapshot.signals].sort()),
      etag: responseHeader(response, "etag"),
      lastModified: responseHeader(response, "last-modified"),
      sourceOccurredAt: responseLastModified(response, observedAt),
    };
  }

  async function fetchFastAgentNativeCms(state) {
    const activeSource = state.scheduler.cmsActiveSource;
    const candidates = prioritizeActiveSource(BINANCE_ANNOUNCEMENT_URLS, activeSource)
      .filter((url) => !sourceBlocked(state, url));
    const errors = [];
    for (const url of candidates) {
      try {
        const response = await controlledSourceFetch(state, url, {
        headers: {
          "user-agent": "Mozilla/5.0 (compatible; robinhood-launchpad-monitor/0.1)",
          accept: "application/json, text/plain, */*",
          "accept-language": "en-US,en;q=0.9",
          referer: "https://www.binance.com/en/support/announcement",
        },
        signal: AbortSignal.timeout(agentNativeRequestTimeoutMs),
        }, { wafAware: true });
        const payload = await readJsonResponse(response, "Binance Agent Native CMS");
        state.scheduler.cmsActiveSource = url;
        return { articles: parseBinanceAnnouncements(payload), url };
      } catch (error) {
        errors.push(error);
      }
    }
    const failure = new Error(errors.map((error) => error.message).join("; ") || "all Binance Agent Native CMS source circuits are open");
    failure.sourceRateLimited = errors.some((error) => error.sourceRateLimited === true);
    failure.sourceCircuitOpen = errors.length > 0 && errors.every((error) => error.sourceCircuitOpen === true);
    failure.suppressLog = errors.length > 0 && errors.every((error) => error.suppressLog === true);
    failure.slaUnavailable = failure.sourceRateLimited || failure.sourceCircuitOpen;
    throw failure;
  }

  async function processFastDeveloperPage(state, currentPage, {
    url,
    observedAt,
    deliverySla,
    save,
    sourceId = "binance_developer_docs",
    sourceName = "Binance Developer 官方文档",
    coverageWindowMs = 2 * agentNativePollIntervalMs * Math.ceil(
      BINANCE_AGENT_NATIVE_DOC_URLS.length / agentNativeDeveloperPagesPerCycle,
    ),
  }) {
    const previous = state.pages[url];
    if (currentPage.notModified) {
      if (previous) previous.checkedAt = observedAt;
      await save.telemetry();
      return;
    }
    const previousSignals = Array.isArray(previous?.signals) ? previous.signals : [];
    const previousSignalSet = new Set(previousSignals);
    const currentSignalSet = new Set(currentPage.signals);
    const saturated = Boolean(previous && (
      previous.truncated === true
      || previousSignals.length >= 1_200
      || currentPage.truncated === true
      || currentPage.signals.length >= 1_200
    ));
    const added = previous ? currentPage.signals.filter((line) => !previousSignalSet.has(line)).slice(0, 8) : [];
    const removed = previous && !saturated
      ? previousSignals.filter((line) => !currentSignalSet.has(line)).slice(0, 8)
      : [];
    const profile = classifyDeveloperDelta(url, added, removed);
    const previousSnapshot = previous?.displaySnapshot || (previous
      ? developerDisplaySnapshot(previousSignals, previous)
      : null);
    const currentSnapshot = developerDisplaySnapshot(currentPage.signals, currentPage);
    const observedMs = Date.parse(observedAt);
    const previousCoverageAt = Date.parse(previous?.checkedAt
      || state._health.developerDocs?.lastSuccessAt
      || "");
    const effectiveCoverageWindowMs = Math.max(
      coverageWindowMs,
      state.migratedAt ? 2 * (config.binanceDeveloperPollIntervalMs ?? 10_000) : 0,
    );
    const continuousCoverage = Number.isFinite(previousCoverageAt)
      && observedMs - previousCoverageAt <= effectiveCoverageWindowMs;
    if (previous
      && continuousCoverage
      && previous.semanticHash !== currentPage.semanticHash
      && (added.length || removed.length)
      && profile.relevant) {
      const critical = added.some((line) => BREAKING_API_CHANGE.test(line)
        || SECURITY_OR_EMERGENCY.test(line)
        || BINANCE_SOCIAL_TRADING_CONTEXT.test(line))
        || removed.some((line) => BREAKING_API_CHANGE.test(line)
          || SECURITY_OR_EMERGENCY.test(line)
          || BINANCE_SOCIAL_TRADING_CONTEXT.test(line));
      const keyChanges = [...added, ...removed.map((line) => `Removed: ${line}`)];
      const strong = profile.strong || critical;
      await deliver({
        type: "binance_official_update",
        kind: "developer_update",
        eventKey: `binance-developer:${hash({ url, semanticHash: currentPage.semanticHash })}`,
        project: projectProfile(profile.project),
        signal: {
          relevant: true,
          labels: [`${profile.label} 更新`],
          project: profile.project,
          scope: profile.project === "binance-wallet" ? "wallet" : "exchange",
          category: profile.category || "官方开发文档",
          strong,
        },
        title: `${profile.label} 官方更新`,
        keyChanges,
        factSummary: keyChanges.join("；"),
        addedSignals: added,
        removedSignals: removed,
        changeType: "revised",
        comparisonBasis: saturated ? "bounded_additions_only" : "exact_snapshot",
        ...(saturated ? { removalInferenceSuppressed: true } : {}),
        previousSnapshot,
        currentSnapshot,
        changedFields: changedSnapshotFields(previousSnapshot, currentSnapshot),
        strong,
        fastLane: "agent_native",
        deliverySla,
        source: { id: sourceId, name: sourceName, url },
        url,
        ...(currentPage.sourceOccurredAt ? {
          sourceOccurredAt: currentPage.sourceOccurredAt,
          publishedAt: currentPage.sourceOccurredAt,
        } : {}),
        observedAt,
      });
    }
    const nextPage = {
      semanticHash: currentPage.semanticHash,
      signals: currentPage.signals,
      totalSignals: currentPage.totalSignals,
      truncated: currentPage.truncated === true,
      etag: currentPage.etag,
      lastModified: currentPage.lastModified,
      sourceOccurredAt: currentPage.sourceOccurredAt || previous?.sourceOccurredAt || null,
      ...(currentPage.retrievalMode ? { retrievalMode: currentPage.retrievalMode } : {}),
      ...(currentPage.retrievalUrl ? { retrievalUrl: currentPage.retrievalUrl } : {}),
      ...(currentPage.verifiedSourceUrl ? { verifiedSourceUrl: currentPage.verifiedSourceUrl } : {}),
      checkedAt: observedAt,
      displaySnapshot: currentSnapshot,
    };
    const pageChanged = !previous
      || previous.semanticHash !== nextPage.semanticHash
      || JSON.stringify(previous.signals || []) !== JSON.stringify(nextPage.signals || [])
      || previous.totalSignals !== nextPage.totalSignals
      || previous.truncated !== nextPage.truncated
      || previous.etag !== nextPage.etag
      || previous.lastModified !== nextPage.lastModified
      || previous.sourceOccurredAt !== nextPage.sourceOccurredAt
      || previous.retrievalMode !== nextPage.retrievalMode
      || previous.retrievalUrl !== nextPage.retrievalUrl
      || previous.verifiedSourceUrl !== nextPage.verifiedSourceUrl
      || JSON.stringify(previous.displaySnapshot || null) !== JSON.stringify(nextPage.displaySnapshot || null);
    state.pages[url] = nextPage;
    if (pageChanged) await save();
    else await save.telemetry();
  }

  async function processFastAgentNativeCms(state, articles, activeSource, observedAt, deliverySla, save) {
    const previousSuccessAt = Date.parse(state._health.cms?.lastSuccessAt || "");
    const revisionRealtimeTrusted = Number.isFinite(previousSuccessAt)
      && Date.parse(observedAt) - previousSuccessAt <= 2 * agentNativeCmsPollIntervalMs;
    let businessDirty = false;
    if (!state.cms.initializedAt) {
      for (const article of articles) {
        state.cms.articles[article.code] = {
          title: article.title,
          listTitle: article.title,
          releaseDate: article.releaseDate,
          catalogs: article.catalogs,
          displaySnapshot: announcementDisplaySnapshot(article),
        };
      }
      state.cms.initializedAt = observedAt;
      businessDirty = true;
    } else {
      for (const article of articles) {
        const previous = state.cms.articles[article.code];
        const exactTitleRevision = Boolean(previous && (previous.listTitle || previous.title) !== article.title);
        const revised = exactTitleRevision && !(
          classifyAgentNativeOfficialText(article.title).relevant
          && agentNativeTitleSemantic(previous.listTitle || previous.title) === agentNativeTitleSemantic(article.title)
        );
        const signal = classifyBinanceAnnouncement(article);
        const previousSnapshot = previous ? announcementSnapshotFromRecord(previous) : null;
        const currentSnapshot = announcementDisplaySnapshot(article, null, signal);
        let alertAccepted = false;
        if ((!previous || revised) && signal.relevant && signal.category === "agent_native") {
          await deliver({
            ...announcementEvent(article, null, signal, {
              changeType: revised ? "revised" : "published",
              detailSource: activeSource,
              nowValue: observedAt,
              revisionHash: revised ? hash(article.title) : null,
              revisionRealtimeTrusted,
              previousSnapshot,
              currentSnapshot,
            }),
            fastLane: "agent_native",
            deliverySla,
          });
          alertAccepted = true;
        }
        const nextRecord = {
          title: article.title,
          listTitle: article.title,
          releaseDate: article.releaseDate,
          catalogs: article.catalogs,
          relevant: signal.relevant,
          titleSemantic: agentNativeTitleSemantic(article.title),
          ...(signal.relevant ? { scope: signal.scope, category: signal.category } : {}),
          displaySnapshot: currentSnapshot,
        };
        const recordChanged = !previous || JSON.stringify(previous) !== JSON.stringify(nextRecord);
        state.cms.articles[article.code] = nextRecord;
        businessDirty ||= recordChanged;
        if (alertAccepted) {
          await save();
          businessDirty = false;
        }
      }
    }
    const prunedArticles = pruneArticles(state.cms.articles);
    if (prunedArticles !== state.cms.articles) businessDirty = true;
    state.cms.articles = prunedArticles;
    if (businessDirty) await save();
    else await save.telemetry();
  }

  function applyCircuitAvailability(state, finishedAt) {
    const current = Date.parse(finishedAt);
    const summary = (urls) => {
      const controls = urls.map((url) => ({ url, control: sourceControl(state, url) }));
      const blocked = controls
        .filter(({ control }) => {
          const blockedUntil = Date.parse(control.blockedUntil || "");
          return Number.isFinite(blockedUntil) && current < blockedUntil;
        });
      const rateLimited = blocked.filter(({ control }) => control.reason === "http_429");
      const wafBlocked = blocked.filter(({ control }) => (
        control.reason === "waf_challenge" || control.reason === "http_403"
      ));
      const retryTimes = blocked.map(({ control }) => Date.parse(control.blockedUntil || "")).filter(Number.isFinite);
      return {
        totalSources: urls.length,
        availableSourceCount: Math.max(0, urls.length - blocked.length),
        healthyAvailableSourceCount: controls.filter(({ url, control }) => (
          control.status === "healthy"
          && !blocked.some(({ url: blockedUrl }) => blockedUrl === url)
        )).length,
        blocked,
        rateLimited,
        wafBlocked,
        nextRetryAt: retryTimes.length ? new Date(Math.min(...retryTimes)).toISOString() : null,
      };
    };
    const developer = summary(BINANCE_AGENT_NATIVE_DOC_URLS);
    const agentOs = summary([BINANCE_AGENT_OS_PAGE_URL, BINANCE_AGENT_OS_READER_URL]);
    const cms = summary(BINANCE_ANNOUNCEMENT_URLS);
    const developerHealth = sourceHealth(state, "developerDocs");
    const agentOsHealth = sourceHealth(state, "agentOsPage");
    const cmsHealth = sourceHealth(state, "cms");

    const sourceWasObserved = (health, sourceSummary) => health.status === "healthy"
      || (health.status === "degraded" && Boolean(health.lastSuccessAt))
      || sourceSummary.healthyAvailableSourceCount > 0;
    const developerAvailable = developer.availableSourceCount > 0 && sourceWasObserved(developerHealth, developer);
    const cmsAvailable = cms.availableSourceCount > 0 && sourceWasObserved(cmsHealth, cms);
    const agentOsDirectAvailable = agentOs.availableSourceCount > 0 && sourceWasObserved(agentOsHealth, agentOs);
    const agentOsAvailable = agentOsDirectAvailable || developerAvailable;

    const coverageFor = (kind, sourceSummary, available) => {
      const partial = sourceSummary.blocked.length > 0 && sourceSummary.availableSourceCount > 0;
      let status = available ? (partial ? "partial" : "complete") : "unavailable";
      let mode = "official_public_polling";
      if (kind === "cms" && available && partial) {
        status = "complete_via_mirror_fallback";
        mode = "official_cms_mirror_fallback";
      }
      if (kind === "agent_os" && available) {
        if (agentOsDirectAvailable && agentOsHealth.retrievalMode === "verified_reader") {
          status = "verified_reader_fallback";
          mode = "verified_reader";
        } else if (!agentOsDirectAvailable && developerAvailable) {
          status = "developer_docs_fallback";
          mode = "official_developer_docs_fallback";
        } else if (partial) {
          status = "partial";
        }
      }
      const selectedHealth = kind === "developer" ? developerHealth : kind === "cms" ? cmsHealth : agentOsHealth;
      if (!available && !sourceWasObserved(selectedHealth, sourceSummary)) {
        status = sourceSummary.blocked.length >= sourceSummary.totalSources ? "unavailable" : "pending";
      }
      return {
        status,
        available,
        mode,
        totalSources: sourceSummary.totalSources,
        availableSourceCount: sourceSummary.availableSourceCount,
        blockedSources: sourceSummary.blocked.map(({ url }) => url),
        ...(sourceSummary.nextRetryAt ? { nextRetryAt: sourceSummary.nextRetryAt } : {}),
      };
    };

    const apply = (health, sourceSummary, coverage) => {
      const rateLimitedSources = sourceSummary.rateLimited.map(({ url }) => url);
      const wafBlockedSources = sourceSummary.wafBlocked.map(({ url }) => url);
      health.coverage = coverage;
      health.slaUnavailable = !coverage.available;
      health.sourceRateLimited = rateLimitedSources.length > 0;
      health.sla = {
        status: !coverage.available
          ? "unavailable"
          : coverage.status === "complete"
            ? "best_effort"
            : "degraded",
        mode: coverage.mode,
        hardRealtime: false,
        sourceLimited: sourceSummary.blocked.length > 0,
        ...(sourceSummary.nextRetryAt ? { nextRetryAt: sourceSummary.nextRetryAt } : {}),
      };
      if (!coverage.available) {
        health.slaReason = rateLimitedSources.length ? "official_source_rate_limited" : "official_source_unavailable";
        health.nextRetryAt = sourceSummary.nextRetryAt;
        if (health.status === "healthy") health.status = "degraded";
      } else {
        delete health.slaReason;
        delete health.nextRetryAt;
        if (sourceSummary.blocked.length > 0 && health.status === "error") health.status = "degraded";
      }
      if (rateLimitedSources.length) health.rateLimitedSources = rateLimitedSources;
      else delete health.rateLimitedSources;
      if (wafBlockedSources.length) health.wafBlockedSources = wafBlockedSources;
      else delete health.wafBlockedSources;
    };

    const developerCoverage = coverageFor("developer", developer, developerAvailable);
    const agentOsCoverage = coverageFor("agent_os", agentOs, agentOsAvailable);
    const cmsCoverage = coverageFor("cms", cms, cmsAvailable);
    apply(developerHealth, developer, developerCoverage);
    apply(agentOsHealth, agentOs, agentOsCoverage);
    apply(cmsHealth, cms, cmsCoverage);

    const laneHealth = sourceHealth(state, "lane");
    const coverageGroups = [developerCoverage, agentOsCoverage, cmsCoverage];
    const availableGroups = coverageGroups.filter((coverage) => coverage.available).length;
    const laneAvailable = availableGroups > 0;
    const laneComplete = availableGroups === coverageGroups.length
      && coverageGroups.every((coverage) => !["partial", "pending", "unavailable"].includes(coverage.status));
    const laneBlocked = {
      totalSources: developer.totalSources + agentOs.totalSources + cms.totalSources,
      availableSourceCount: developer.availableSourceCount + agentOs.availableSourceCount + cms.availableSourceCount,
      blocked: [...developer.blocked, ...agentOs.blocked, ...cms.blocked],
      rateLimited: [...developer.rateLimited, ...agentOs.rateLimited, ...cms.rateLimited],
      wafBlocked: [...agentOs.wafBlocked, ...developer.wafBlocked, ...cms.wafBlocked],
      nextRetryAt: [developer.nextRetryAt, agentOs.nextRetryAt, cms.nextRetryAt]
        .filter(Boolean)
        .sort()[0] || null,
    };
    const laneCoverage = {
      status: !laneAvailable ? "unavailable" : laneComplete ? "complete" : "partial",
      available: laneAvailable,
      mode: "independent_official_fallbacks",
      availableGroups,
      totalGroups: coverageGroups.length,
      groups: {
        developerDocs: developerCoverage.status,
        agentOsPage: agentOsCoverage.status,
        cms: cmsCoverage.status,
      },
      totalSources: laneBlocked.totalSources,
      availableSourceCount: laneBlocked.availableSourceCount,
      blockedSources: laneBlocked.blocked.map(({ url }) => url),
      ...(laneBlocked.nextRetryAt ? { nextRetryAt: laneBlocked.nextRetryAt } : {}),
    };
    apply(laneHealth, laneBlocked, laneCoverage);
    laneHealth.requestPlan = {
      schedulerIntervalMs: agentNativePollIntervalMs,
      developerPagesPerCycle: agentNativeDeveloperPagesPerCycle,
      developerPageCount: BINANCE_AGENT_NATIVE_DOC_URLS.length,
      developerPerUrlCadenceMs: agentNativeDeveloperPerUrlCadenceMs,
      cmsIntervalMs: agentNativeCmsPollIntervalMs,
      cmsRequestsPerProbe: 1,
      agentOsIntervalMs: agentOsPagePollIntervalMs,
      agentOsSteadyRequestsPerProbe: 1,
      conditionalRequests: true,
    };
    const controllableBudgets = {
      developerMs: laneHealth.requestPlan.developerPerUrlCadenceMs + agentNativeRequestTimeoutMs,
      cmsMs: agentNativeCmsPollIntervalMs + agentNativeRequestTimeoutMs,
      agentOsMs: agentOsPagePollIntervalMs + agentOsRequestTimeoutMs,
    };
    laneHealth.controllableDetectionBudgets = controllableBudgets;
    laneHealth.hardFiveSecondGuarantee = Object.values(controllableBudgets).every((value) => value <= 5_000)
      && laneCoverage.status === "complete"
      && !laneHealth.slaUnavailable;
    laneHealth.slaMode = laneCoverage.status === "complete"
      ? "best_effort_public_sources"
      : laneCoverage.available
        ? "degraded_public_source_coverage"
        : "official_sources_unavailable";
  }

  const runAgentNativeCycle = async (force = false, scheduledAt = null) => {
      const state = applyAgentNativeTelemetry(await readAgentNativeState(), pendingAgentNativeTelemetry);
      const currentRaw = now();
      const current = currentRaw instanceof Date ? currentRaw.getTime() : Number(currentRaw);
      const laneHealth = sourceHealth(state, "lane");
      if (!force && !due({ checkedAt: laneHealth.lastStartedAt || laneHealth.checkedAt }, agentNativePollIntervalMs, current)) return;
      const migratedFromMainState = Boolean(state.migratedAt);
      const scheduledMs = Date.parse(scheduledAt || "");
      const startedAt = Number.isFinite(scheduledMs) ? new Date(scheduledMs).toISOString() : iso(() => current);
      const developerProbeCadenceMs = agentNativeDeveloperPerUrlCadenceMs;
      const developerDeliverySla = criticalSourceDeliverySla(startedAt, developerProbeCadenceMs);
      const agentOsDeliverySla = criticalSourceDeliverySla(startedAt, agentOsPagePollIntervalMs);
      const cmsDeliverySla = criticalSourceDeliverySla(startedAt, agentNativeCmsPollIntervalMs);
      laneHealth.startedAt = startedAt;
      laneHealth.lastStartedAt = startedAt;
      let mutationQueue = Promise.resolve();
      const mutate = (operation) => {
        const pending = mutationQueue.then(operation, operation);
        mutationQueue = pending.catch(() => {});
        return pending;
      };
      const save = createAgentNativeCycleSave(state);

      const developerResults = [];
      const selectedDeveloperUrls = selectDeveloperProbeUrls(state, current);
      const developerTasks = selectedDeveloperUrls.map(async (url) => {
        try {
          const currentPage = await fetchFastDeveloperPage(state, url, state.pages[url]);
          const observedAt = iso(now);
          await mutate(() => processFastDeveloperPage(state, currentPage, {
            url,
            observedAt,
            deliverySla: developerDeliverySla,
            save,
          }));
          developerResults.push({ url, ok: true });
        } catch (error) {
          developerResults.push({ url, ok: false, error });
        }
      });

      const agentOsDue = due(
        { checkedAt: state.scheduler.agentOsLastProbeAt },
        agentOsPagePollIntervalMs,
        current,
      ) && [BINANCE_AGENT_OS_PAGE_URL, BINANCE_AGENT_OS_READER_URL]
        .some((url) => !sourceBlocked(state, url, current));
      if (agentOsDue) state.scheduler.agentOsLastProbeAt = new Date(current).toISOString();
      const agentOsTask = agentOsDue ? (async () => {
        try {
          const currentPage = await fetchAgentOsPage(
            (url, options) => controlledSourceFetch(state, url, options, {
              wafAware: true,
            }),
            state.pages[BINANCE_AGENT_OS_PAGE_URL],
            iso(now),
            agentOsRequestTimeoutMs,
          );
          const observedAt = iso(now);
          await mutate(() => processFastDeveloperPage(state, currentPage, {
            url: BINANCE_AGENT_OS_PAGE_URL,
            observedAt,
            deliverySla: agentOsDeliverySla,
            save,
            sourceId: "binance_agent_os_page",
            sourceName: "Binance Agent OS 官方页面",
            coverageWindowMs: 2 * agentOsPagePollIntervalMs,
          }));
          return { ok: true, currentPage };
        } catch (error) {
          return { ok: false, error };
        }
      })() : Promise.resolve(null);

      const cmsDue = due(
        { checkedAt: state.scheduler.cmsLastProbeAt },
        agentNativeCmsPollIntervalMs,
        current,
      ) && BINANCE_ANNOUNCEMENT_URLS.some((url) => !sourceBlocked(state, url, current));
      if (cmsDue) state.scheduler.cmsLastProbeAt = new Date(current).toISOString();
      const cmsTask = cmsDue ? (async () => {
        try {
          const result = await fetchFastAgentNativeCms(state);
          const observedAt = iso(now);
          await mutate(() => processFastAgentNativeCms(
            state,
            result.articles,
            result.url,
            observedAt,
            cmsDeliverySla,
            save,
          ));
          return { ok: true, ...result };
        } catch (error) {
          return { ok: false, error };
        }
      })() : Promise.resolve(null);

      const [, agentOsResult, cmsResult] = await Promise.all([
        Promise.all(developerTasks),
        agentOsTask,
        cmsTask,
      ]);
      await mutationQueue;
      const finishedAt = iso(now);
      const developerHealth = sourceHealth(state, "developerDocs");
      const developerFailures = developerResults.filter((result) => !result.ok).map((result) => result.error);
      const developerSuccesses = developerResults.length - developerFailures.length;
      if (!developerSuccesses && developerFailures.length) markFailed(developerHealth, developerFailures[0], finishedAt);
      else if (developerFailures.length) {
        markDegraded(developerHealth, developerFailures, finishedAt);
        developerHealth.lastSuccessAt = finishedAt;
        developerHealth.pagesChecked = developerSuccesses;
      } else if (developerSuccesses) markHealthy(developerHealth, finishedAt, {
        pagesChecked: developerSuccesses,
        pageRotationCursor: state.scheduler.developerCursor,
      });

      const agentOsHealth = sourceHealth(state, "agentOsPage");
      if (agentOsResult && !agentOsResult.ok) {
        markDegraded(agentOsHealth, [agentOsResult.error], finishedAt);
        Object.assign(agentOsHealth, {
          canonicalSource: BINANCE_AGENT_OS_PAGE_URL,
          fallbackActive: "binance_developer_docs",
          relyingOnOfficialDeveloperDocs: true,
        });
        const previousLogAt = Date.parse(agentOsHealth.lastLoggedErrorAt || "");
        if (!agentOsResult.error.suppressLog && (
          !Number.isFinite(previousLogAt) || Date.parse(finishedAt) - previousLogAt >= 60_000
        )) {
          logger.error(`[binance][agent-native-fast][agent-os-page] ${agentOsResult.error.message}`);
          agentOsHealth.lastLoggedErrorAt = finishedAt;
        }
      } else if (agentOsResult?.ok) {
        const currentPage = agentOsResult.currentPage;
        const healthDetails = {
          canonicalSource: BINANCE_AGENT_OS_PAGE_URL,
          activeSource: currentPage.retrievalUrl || currentPage.sourceUrl || BINANCE_AGENT_OS_PAGE_URL,
          verifiedOfficialUrl: currentPage.verifiedSourceUrl
            || state.pages[BINANCE_AGENT_OS_PAGE_URL]?.verifiedSourceUrl
            || BINANCE_AGENT_OS_PAGE_URL,
          retrievalMode: currentPage.retrievalMode
            || state.pages[BINANCE_AGENT_OS_PAGE_URL]?.retrievalMode
            || "canonical",
        };
        if (currentPage.retrievalMode === "verified_reader") {
          markHealthy(agentOsHealth, finishedAt, healthDetails);
          Object.assign(agentOsHealth, healthDetails, {
            fallbackActive: "verified_reader",
            canonicalSourceDegraded: Boolean(currentPage.errors?.length),
            sourceDegradations: currentPage.errors?.length || 0,
          });
          delete agentOsHealth.relyingOnOfficialDeveloperDocs;
        } else {
          markHealthy(agentOsHealth, finishedAt, healthDetails);
          delete agentOsHealth.fallbackActive;
          delete agentOsHealth.relyingOnOfficialDeveloperDocs;
          delete agentOsHealth.canonicalSourceDegraded;
          delete agentOsHealth.sourceDegradations;
        }
      }

      const cmsHealth = sourceHealth(state, "cms");
      if (cmsResult?.ok) markHealthy(cmsHealth, finishedAt, { activeSource: cmsResult.url, articles: cmsResult.articles.length });
      else if (cmsResult && !cmsResult.ok) markFailed(cmsHealth, cmsResult.error, finishedAt);

      const failures = [
        ...developerFailures,
        ...(agentOsResult && !agentOsResult.ok ? [agentOsResult.error] : []),
        ...(cmsResult && !cmsResult.ok ? [cmsResult.error] : []),
      ];
      if (developerSuccesses || agentOsResult?.ok || cmsResult?.ok) {
        if (failures.length) {
          markDegraded(laneHealth, failures, finishedAt);
          laneHealth.lastSuccessAt = finishedAt;
        } else markHealthy(laneHealth, finishedAt);
      } else if (failures.length) markFailed(laneHealth, failures[0], finishedAt);
      Object.assign(laneHealth, {
        intervalMs: agentNativePollIntervalMs,
        requestTimeoutMs: agentNativeRequestTimeoutMs,
        agentOsLegTimeoutMs: agentOsRequestTimeoutMs,
        localDetectionBudgetMs: Math.max(
          developerProbeCadenceMs + agentNativeRequestTimeoutMs,
          agentNativeCmsPollIntervalMs + agentNativeRequestTimeoutMs,
          agentOsPagePollIntervalMs + agentOsRequestTimeoutMs,
        ),
      });
      applyCircuitAvailability(state, finishedAt);
      delete state.migratedAt;
      if (migratedFromMainState) await save();
      else await save.telemetry();
  };

  const checkAgentNativeLane = () => {
    if (streamStopped || config.binanceDeveloperMonitorEnabled !== true) return Promise.resolve();
    if (activeAgentNativeCheck) {
      // A timer that lands during an active HTTP round requests one immediate
      // catch-up. This prevents a slow sibling from stretching the next
      // observation window to two scheduler periods.
      agentNativeRerunRequested = true;
      agentNativeRerunStartedAt ||= iso(now);
      return activeAgentNativeCheck;
    }
    activeAgentNativeCheck = (async () => {
      for (let cycle = 0; cycle < 2 && !streamStopped; cycle += 1) {
        const scheduledAt = cycle > 0 ? agentNativeRerunStartedAt : null;
        agentNativeRerunRequested = false;
        agentNativeRerunStartedAt = null;
        await runAgentNativeCycle(cycle > 0, scheduledAt);
        if (!agentNativeRerunRequested) break;
      }
      agentNativeRerunRequested = false;
      agentNativeRerunStartedAt = null;
    })().catch((error) => {
      logger.error(`[binance][agent-native-fast] ${error.message}`);
    }).finally(() => {
      activeAgentNativeCheck = null;
    });
    return activeAgentNativeCheck;
  };

  async function checkLaunchpool(state, save, current, nowValue) {
    const health = sourceHealth(state, "launchpool");
    if (!due(health, config.binanceLaunchpoolPollIntervalMs ?? 15_000, current)) return;
    let businessDirty = false;
    try {
      const { payload, url: activeSource } = await fetchWithFallback(BINANCE_LAUNCHPOOL_URLS, fetchImpl, "Binance Launchpool");
      const capabilities = extractLaunchpoolCapabilities(payload);
      if (!state.launchpool.initializedAt) {
        Object.assign(state.launchpool, capabilities, {
          assets: [...new Set([...HISTORICAL_LAUNCHPOOL_ASSETS, ...capabilities.assets])].sort(),
          statuses: [...new Set([...HISTORICAL_LAUNCHPOOL_STATUSES, ...capabilities.statuses])].sort(),
          initializedAt: nowValue,
        });
        businessDirty = true;
      } else {
        const capabilitiesChanged = ["assets", "statuses", "buckets", "fields"]
          .some((field) => JSON.stringify(state.launchpool[field] || []) !== JSON.stringify(capabilities[field] || []));
        const changes = {
          newStakeAssets: capabilities.assets.filter((item) => !(state.launchpool.assets || []).includes(item)),
          newStatuses: capabilities.statuses.filter((item) => !(state.launchpool.statuses || []).includes(item)),
          newBuckets: capabilities.buckets.filter((item) => !(state.launchpool.buckets || []).includes(item)),
          newFields: capabilities.fields.filter((item) => !(state.launchpool.fields || []).includes(item)),
        };
        if (Object.values(changes).some((items) => items.length)) {
          await deliver({
            type: "binance_official_update",
            kind: "launchpool_capability",
            eventKey: `binance-launchpool:${hash(changes)}`,
            project: projectProfile("binance"),
            signal: { relevant: true, labels: ["Launchpool 能力变化"] },
            changes,
            strong: Boolean(changes.newBuckets.length || changes.newStatuses.length || changes.newFields.length),
            source: { id: "launchpool_api", name: "Binance Launchpool 官方接口", url: "https://www.binance.com/en/launchpool" },
            url: "https://www.binance.com/en/launchpool",
            observedAt: nowValue,
          });
        }
        Object.assign(state.launchpool, capabilities);
        businessDirty ||= capabilitiesChanged;
      }
      markHealthy(health, nowValue, { activeSource });
    } catch (error) {
      markFailed(health, error, nowValue);
      logger.error(`[binance][launchpool] ${error.message}`);
    }
    if (businessDirty) await save();
    else await save.telemetry();
  }

  const check = () => {
    const fastLaneRun = checkAgentNativeLane();
    if (streamStopped) return fastLaneRun;
    if (activeCheck) {
      rerunRequested = true;
      return Promise.all([activeCheck, fastLaneRun]).then(() => undefined);
    }
    activeCheck = (async () => {
      // Preserve one immediate catch-up when a tick lands during an active
      // cycle, but never let a short interval keep this loop alive forever.
      // A later timer tick can start a fresh cycle after this promise settles.
      for (let cycle = 0; cycle < 2 && !streamStopped; cycle += 1) {
        rerunRequested = false;
        try {
          const state = applyPendingMainStateTelemetry(await readMainState());
          const save = createCycleSave(state);
          const currentRaw = now();
          const current = currentRaw instanceof Date ? currentRaw.getTime() : Number(currentRaw);
          const nowValue = iso(() => current);
          await checkAnnouncements(state, save, current, nowValue);
          await checkLaunchpool(state, save, current, nowValue);
          await checkMemeRush(state, save, current, nowValue);
          await checkSquare(state, save, current, nowValue);
          await checkDeveloperDocs(state, save, current, nowValue);
        } catch (error) {
          logger.error(`[binance] check: ${error.message}`);
        }
        if (!rerunRequested) break;
      }
      rerunRequested = false;
    })().finally(() => { activeCheck = null; });
    return Promise.all([activeCheck, fastLaneRun]).then(() => undefined);
  };

  if (autoStart) {
    void check();
    connectAnnouncementStream();
  }
  const interval = Math.max(1_000, Math.min(
    config.binanceMemeRushPollIntervalMs ?? 5_000,
    config.binanceSquarePollIntervalMs ?? 10_000,
    config.binanceDeveloperPollIntervalMs ?? 30_000,
    config.binanceAnnouncementPollIntervalMs ?? 15_000,
    config.binanceLaunchpoolPollIntervalMs ?? 15_000,
  ));
  const timer = autoStart ? setInterval(check, interval) : null;
  timer?.unref();
  const agentNativeTimer = autoStart ? setInterval(checkAgentNativeLane, agentNativePollIntervalMs) : null;
  agentNativeTimer?.unref();
  return {
    check,
    checkAgentNative: checkAgentNativeLane,
    stop: () => {
      if (stopPromise) return stopPromise;
      if (timer) clearInterval(timer);
      if (agentNativeTimer) clearInterval(agentNativeTimer);
      streamStopped = true;
      stopAnnouncementStreamSocket();
      const stopAttempt = (async () => {
        if (activeCheck) await activeCheck;
        if (activeAgentNativeCheck) await activeAgentNativeCheck;
        await flushMainStateTelemetry();
        await flushAgentNativeTelemetry();
        await stateWriteQueue;
        await agentNativeStateWriteQueue;
      })();
      stopPromise = stopAttempt;
      void stopAttempt.catch(() => {
        if (stopPromise === stopAttempt) stopPromise = null;
      });
      return stopAttempt;
    },
    stateFile,
    mainSchedulerCheckpointFile,
    agentNativeStateFile,
    agentNativeCheckpointFile,
    agentNativePollIntervalMs,
    agentNativeLocalDetectionBudgetMs: Math.max(
      agentNativeDeveloperPerUrlCadenceMs + agentNativeRequestTimeoutMs,
      agentNativeCmsPollIntervalMs + agentNativeRequestTimeoutMs,
      agentOsPagePollIntervalMs + agentOsRequestTimeoutMs,
    ),
    agentNativeLocalDetectionBudgets: {
      developerMs: agentNativeDeveloperPerUrlCadenceMs + agentNativeRequestTimeoutMs,
      cmsMs: agentNativeCmsPollIntervalMs + agentNativeRequestTimeoutMs,
      agentOsMs: agentOsPagePollIntervalMs + agentOsRequestTimeoutMs,
    },
  };
}
