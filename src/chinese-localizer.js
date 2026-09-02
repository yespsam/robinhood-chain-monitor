const DEFAULT_TRANSLATION_URL = "https://translate.googleapis.com/translate_a/single";
const DEFAULT_TIMEOUT_MS = 1_800;
const MAX_CACHE_ENTRIES = 500;
const translationCache = new Map();
const alertLineTranslationCache = new Map();

const LOCALIZED_EVENT_TYPES = new Set([
  "twitter_update",
  "github_module_update",
  "github_repository_discovered",
  "platform_capability_update",
  "binance_official_update",
  "bsc_launchpad_update",
  "fomo_family_top_call",
  "launchpad_site_update",
  "uniswap_official_update",
  "ai_official_update",
]);

function oneLine(value) {
  return String(value || "")
    .replace(/\bShow more\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function markerSuffix(index) {
  let value = Number(index) + 1;
  let suffix = "";
  while (value > 0) {
    value -= 1;
    suffix = String.fromCharCode(65 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  }
  return suffix;
}

function contextualTechnicalNumbers(text) {
  const source = oneLine(text);
  const pattern = /\b(?:chain|network|protocol|template|preset|pool)[._\s-]*id\b\s*(?::|=|#)?\s*["']?(\d{1,15})\b/gi;
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function canonicalDecimal(value, multiplier = 1) {
  const numeric = Number(String(value || "").replace(/,/g, ""));
  if (!Number.isFinite(numeric)) return null;
  const scaled = numeric * multiplier;
  if (!Number.isFinite(scaled)) return null;
  return scaled.toLocaleString("en-US", {
    useGrouping: false,
    maximumSignificantDigits: 15,
  });
}

function canonicalSignedDecimal(value, multiplier = 1, explicitSign = "") {
  const raw = String(value || "").trim();
  const embeddedSign = /^[+-]/u.test(raw) ? raw[0] : "";
  const sign = explicitSign || embeddedSign;
  const magnitude = canonicalDecimal(raw.replace(/^[+-]/u, ""), multiplier);
  if (magnitude === null) return null;
  return sign === "-" ? `-${magnitude}` : sign === "+" ? `+${magnitude}` : magnitude;
}

function amountSign(...candidates) {
  const signs = candidates.filter((value) => value === "+" || value === "-");
  // A malformed double-sign amount must remain distinguishable instead of
  // being silently normalized into an unsigned value.
  return signs.length > 1 ? "invalid" : signs[0] || "";
}

function quantityMultiplier(value) {
  const unit = String(value || "").toLowerCase();
  if (unit === "万") return 10_000;
  if (unit === "thousand" || unit === "k") return 1_000;
  if (unit === "亿") return 100_000_000;
  if (["million", "mn", "m"].includes(unit)) return 1_000_000;
  if (["billion", "bn", "b"].includes(unit)) return 1_000_000_000;
  return 1;
}

const ENGLISH_MONTH_NUMBER = new Map([
  ["january", 1], ["jan", 1], ["february", 2], ["feb", 2], ["march", 3], ["mar", 3],
  ["april", 4], ["apr", 4], ["may", 5], ["june", 6], ["jun", 6], ["july", 7], ["jul", 7],
  ["august", 8], ["aug", 8], ["september", 9], ["sept", 9], ["sep", 9], ["october", 10],
  ["oct", 10], ["november", 11], ["nov", 11], ["december", 12], ["dec", 12],
]);

function canonicalMonthDay(monthValue, dayValue) {
  const month = Number(monthValue);
  const day = Number(dayValue);
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
  const date = new Date(Date.UTC(2000, month - 1, day));
  if (date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return null;
  return `${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/**
 * Translation providers are allowed to localize units (for example
 * `1亿美元` -> `$100 million`) but never to change their value.  Keep a
 * language-neutral multiset of monetary amounts, percentages and remaining
 * numeric facts so a fluent-looking mistranslation cannot pass validation.
 */
function numericMeaning(value) {
  const source = oneLine(value);
  const masked = source.split("");
  const occupied = Array(source.length).fill(false);
  const amounts = [];
  const percentages = [];
  const tokenCounts = [];
  const dates = [];
  const mask = (match) => {
    const start = match.index || 0;
    for (let index = start; index < start + match[0].length; index += 1) {
      masked[index] = " ";
      occupied[index] = true;
    }
  };
  const record = (pattern, output, normalize) => {
    for (const match of source.matchAll(pattern)) {
      const start = match.index || 0;
      if (occupied.slice(start, start + match[0].length).some(Boolean)) continue;
      const normalized = normalize(match);
      if (!normalized) continue;
      output.push(normalized);
      mask(match);
    }
  };

  record(/(\d{1,2})月(\d{1,2})日/gu, dates, (match) => canonicalMonthDay(match[1], match[2]));
  record(
    /\b(January|February|March|April|May|June|July|August|September|Sept|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/giu,
    dates,
    (match) => canonicalMonthDay(ENGLISH_MONTH_NUMBER.get(match[1].toLowerCase()), match[2]),
  );
  record(
    /\b(\d{1,2})(?:st|nd|rd|th)?\s+(January|February|March|April|May|June|July|August|September|Sept|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\.?\b/giu,
    dates,
    (match) => canonicalMonthDay(ENGLISH_MONTH_NUMBER.get(match[2].toLowerCase()), match[1]),
  );

  record(
    /([+-]?)(?:US\$|\$|USD\s*)?([+-]?)(\d[\d,]*(?:\.\d+)?)\s*(万|亿)\s*(?:美元|美金|USD|USDT|USDC)/giu,
    amounts,
    (match) => {
      const sign = amountSign(match[1], match[2]);
      return `USD:${sign === "invalid" ? "invalid-sign" : canonicalSignedDecimal(match[3], quantityMultiplier(match[4]), sign)}`;
    },
  );
  record(
    /([+-]?)(?:CNY\s*|RMB\s*)?([+-]?)(\d[\d,]*(?:\.\d+)?)\s*(万|亿)\s*(?:元?人民币|CNY|RMB|元)(?![A-Za-z0-9])/giu,
    amounts,
    (match) => {
      const sign = amountSign(match[1], match[2]);
      return `CNY:${sign === "invalid" ? "invalid-sign" : canonicalSignedDecimal(match[3], quantityMultiplier(match[4]), sign)}`;
    },
  );
  record(
    /([+-]?)(?:US\$|\$|USD\s*)([+-]?)(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|mn|bn|[kmb])?\b/giu,
    amounts,
    (match) => {
      const sign = amountSign(match[1], match[2]);
      return `USD:${sign === "invalid" ? "invalid-sign" : canonicalSignedDecimal(match[3], quantityMultiplier(match[4]), sign)}`;
    },
  );
  record(
    /([+-]?)(?:CNY|RMB)\s*([+-]?)(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|mn|bn|[kmb])?\b/giu,
    amounts,
    (match) => {
      const sign = amountSign(match[1], match[2]);
      return `CNY:${sign === "invalid" ? "invalid-sign" : canonicalSignedDecimal(match[3], quantityMultiplier(match[4]), sign)}`;
    },
  );
  record(
    /([+-]?)(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion)\s+(?:US\s+dollars?|USD)\b/giu,
    amounts,
    (match) => {
      return `USD:${canonicalSignedDecimal(match[2], quantityMultiplier(match[3]), match[1])}`;
    },
  );
  record(
    /([+-]?)(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion)\s+(?:Chinese\s+yuan|yuan|renminbi|CNY|RMB)\b/giu,
    amounts,
    (match) => `CNY:${canonicalSignedDecimal(match[2], quantityMultiplier(match[3]), match[1])}`,
  );
  record(
    /([+-]?)(\d[\d,]*(?:\.\d+)?)\s*(?:美元|美金|USD)(?![A-Za-z0-9])/giu,
    amounts,
    (match) => `USD:${canonicalSignedDecimal(match[2], 1, match[1])}`,
  );
  record(
    /([+-]?)(\d[\d,]*(?:\.\d+)?)\s*(?:元?人民币|CNY|RMB|元)(?![A-Za-z0-9])/giu,
    amounts,
    (match) => `CNY:${canonicalSignedDecimal(match[2], 1, match[1])}`,
  );
  record(
    /(?:\b[A-Z][A-Z0-9]{0,11}\b|比特币|以太坊|索拉纳|狗狗币)\s*(?:的?价格)?\s*(?:跌破|跌至|下探|涨破|升至|上探)\s*([+-]?)(\d[\d,]*(?:\.\d+)?)\s*(万|亿)?(?![\d,.万亿]|\s*(?:%|％|bps?\b|基点|元?人民币|CNY|RMB|元|美元|美金|USD))/gu,
    amounts,
    (match) => `USD:${canonicalSignedDecimal(match[2], quantityMultiplier(match[3]), match[1])}`,
  );
  record(
    /(?:(?:\$[A-Z][A-Z0-9]{0,11}|\b[A-Z][A-Z0-9]{0,11})\b|\b(?:[Bb]itcoin|[Ee]thereum|[Ss]olana|[Dd]ogecoin)\b)(?:'s)?\s+(?:(?:price|trades?|trading|is|was|remains?|moves?|moved|now)\s+){0,3}(?:fell|falls?|fallen|falling|dropped|drops?|dropping|rose|rises?|risen|rising|climbed|climbs?|climbing|above|below)\s*(?:by|to|at)?\s*([+-]?)(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|mn|bn|[kmb])?(?![\d,.A-Za-z]|\s*(?:%|％|bps?\b))/gu,
    amounts,
    (match) => `USD:${canonicalSignedDecimal(match[2], quantityMultiplier(match[3]), match[1])}`,
  );
  record(
    /([+-]?)(\d[\d,]*(?:\.\d+)?)\s*(万|亿)\s*(?:枚|个)?代币/giu,
    tokenCounts,
    (match) => canonicalSignedDecimal(match[2], quantityMultiplier(match[3]), match[1]),
  );
  record(
    /([+-]?)(\d[\d,]*(?:\.\d+)?)\s*(thousand|million|billion|[kmb])?\s*(?:tokens?|枚代币|个代币)(?![A-Za-z])/giu,
    tokenCounts,
    (match) => canonicalSignedDecimal(match[2], quantityMultiplier(match[3]), match[1]),
  );
  record(
    /([+-]?\d+(?:\.\d+)?)\s*(%|％|bps?\b|基点)/giu,
    percentages,
    (match) => {
      const unit = /bps?|基点/iu.test(match[2]) ? "bps" : "%";
      return `${unit}:${canonicalSignedDecimal(match[1])}`;
    },
  );

  const numbers = (masked.join("").match(/(?<![A-Za-z0-9])[-+]?\d+(?:[,.]\d+)*(?![A-Za-z0-9])/g) || [])
    .map((number) => canonicalSignedDecimal(number))
    .filter(Boolean);
  const sorted = (items) => items.sort((left, right) => left.localeCompare(right));
  return {
    amounts: sorted(amounts),
    percentages: sorted(percentages),
    tokenCounts: sorted(tokenCounts),
    dates: sorted(dates),
    numbers: sorted(numbers),
  };
}

function financialFlowMeaning(value) {
  const source = oneLine(value);
  const count = (pattern) => [...source.matchAll(pattern)].length;
  return {
    outflow: count(/(?:净\s*)?流出|资金外流|(?:net\s+)?outflows?|\bflows?\s+out\b/giu),
    inflow: count(/(?:净\s*)?流入|资金流入|(?:net\s+)?inflows?|\bflows?\s+in\b/giu),
  };
}

const NUMERIC_DIRECTION_CONTEXTS = [
  ["price", /\bprices?\b|价格/iu],
  ["market_cap", /\bmarket\s+cap(?:italization)?\b|市值/iu],
  ["supply", /\b(?:token\s+)?supply\b|供应量/iu],
  ["funding_rate", /\bfunding\s+rate\b|资金费率/iu],
  ["interest_rate", /\binterest\s+rate\b|利率/iu],
  ["rate", /\brate\b|比率/iu],
  ["volume", /\b(?:trading\s+)?volume\b|交易量/iu],
  ["open_interest", /\bopen\s+interest\b|未平仓/iu],
  ["tvl", /\btvl\b|锁仓量/iu],
  ["liquidity", /\bliquidity\b|流动性/iu],
  ["revenue", /\brevenue\b|收入/iu],
  ["fees", /\bfees?\b|费用/iu],
  ["reserves", /\breserves?\b|储备/iu],
  ["balance", /\bbalance\b|余额/iu],
  ["value", /\bvalue\b|价值/iu],
  ["cost", /\bcost\b|成本/iu],
  ["yield", /\byield\b|收益率/iu],
  ["apr", /\bapr\b/iu],
  ["apy", /\bapy\b/iu],
  ["inflation", /\binflation\b|通胀/iu],
];
const ENGLISH_NUMERIC_UP = /\b(?:ris(?:e|es|ing|en)|rose|climb(?:s|ed|ing)?|increas(?:e|es|ed|ing)|gain(?:s|ed|ing)?)\b/iu;
const ENGLISH_NUMERIC_DOWN = /\b(?:fall(?:s|ing|en)?|fell|decreas(?:e|es|ed|ing)|drop(?:s|ped|ping)?)\b/iu;
const ENGLISH_CONTEXTUAL_UP = /(?:\bup\b\s*(?:by|to)?\s*[+$€£¥-]?\d|[+$€£¥-]?\d[\d,.]*\s*(?:%|percent(?:age)?|pct|bps?)?\s+\bup\b)/iu;
const ENGLISH_CONTEXTUAL_DOWN = /(?:\bdown\b\s*(?:by|to)?\s*[+$€£¥-]?\d|[+$€£¥-]?\d[\d,.]*\s*(?:%|percent(?:age)?|pct|bps?)?\s+\bdown\b)/iu;
const CHINESE_ASSET_PRICE_DIRECTION = /(?:\b[A-Z][A-Z0-9]{0,11}\b|比特币|以太坊|索拉纳|狗狗币)\s*(?:的?价格)?\s*(?:跌破|跌至|下探|涨破|升至|上探)/u;
const ENGLISH_ASSET_PRICE_DIRECTION = /(?:\b[A-Z][A-Z0-9]{0,11}\b|\b(?:[Bb]itcoin|[Ee]thereum|[Ss]olana|[Dd]ogecoin)\b)(?:'s)?\s+(?:(?:price|trades?|trading|is|was|remains?|moves?|moved|now)\s+){0,3}(?:fell|falls?|fallen|falling|dropped|drops?|dropping|rose|rises?|risen|rising|climbed|climbs?|climbing|above|below)\b/u;

function numericDirectionMeaning(value) {
  const meanings = [];
  const clauses = oneLine(value).split(/[；;。！？!?，、]|(?<!\d),|,(?!\d)|(?<=\.)\s+(?=[A-Z])|\s+(?:and|while|whereas)\s+(?=(?:the\s+)?(?:(?:\$[A-Z][A-Z0-9]{0,11}|\b[A-Z][A-Z0-9]{0,11})\b|\b(?:[Bb]itcoin|[Ee]thereum|[Ss]olana|[Dd]ogecoin)\b)(?:'s)?\s+(?:(?:price|trades?|trading|is|was|remains?|moves?|moved|now)\s+){0,3}(?:fell|falls?|fallen|falling|dropped|drops?|dropping|rose|rises?|risen|rising|climbed|climbs?|climbing|above|below)\b)|(?:并且|且)\s*(?=(?:(?:\$[A-Z][A-Z0-9]{0,11}|\b[A-Z][A-Z0-9]{0,11})\b|比特币|以太坊|索拉纳|狗狗币)\s*(?:的?价格)?\s*(?:跌破|跌至|下探|涨破|升至|上探))/u);
  for (const clause of clauses) {
    if (!/\d/u.test(clause)) continue;
    const facts = numericMeaning(clause);
    const assetPriceContext = facts.amounts.length > 0
      && (CHINESE_ASSET_PRICE_DIRECTION.test(clause) || ENGLISH_ASSET_PRICE_DIRECTION.test(clause));
    const matchedContexts = NUMERIC_DIRECTION_CONTEXTS
      .filter(([, pattern]) => pattern.test(clause))
      .map(([context]) => context);
    if (assetPriceContext && !matchedContexts.includes("price")) matchedContexts.push("price");
    const contexts = matchedContexts
      .filter((context) => context !== "rate"
        || (!matchedContexts.includes("funding_rate") && !matchedContexts.includes("interest_rate")))
      .sort();
    if (!contexts.length) continue;
    const directions = [];
    if (/(?:上涨|上升|增加|上调|涨破|升至|上探)/u.test(clause)
      || ENGLISH_NUMERIC_UP.test(clause)
      || ENGLISH_CONTEXTUAL_UP.test(clause)
      || (assetPriceContext && /\babove\b/iu.test(clause))) directions.push("up");
    if (/(?:下跌|下降|减少|下调|跌破|跌至|下探)/u.test(clause)
      || ENGLISH_NUMERIC_DOWN.test(clause)
      || ENGLISH_CONTEXTUAL_DOWN.test(clause)
      || (assetPriceContext && /\bbelow\b/iu.test(clause))) directions.push("down");
    if (!directions.length) continue;
    meanings.push(JSON.stringify({
      contexts,
      directions,
      amounts: facts.amounts,
      percentages: facts.percentages,
      tokenCounts: facts.tokenCounts,
      numbers: facts.numbers,
    }));
  }
  return meanings.sort((left, right) => left.localeCompare(right));
}

function assertNumericMeaningUnchanged(source, translated) {
  const before = numericMeaning(source);
  const after = numericMeaning(translated);
  for (const field of ["amounts", "percentages", "tokenCounts", "dates", "numbers"]) {
    if (JSON.stringify(before[field]) !== JSON.stringify(after[field])) {
      throw new Error(`translation changed ${field === "amounts" ? "a monetary amount" : field === "percentages" ? "a percentage" : field === "tokenCounts" ? "a token count" : field === "dates" ? "a date" : "a numeric fact"}`);
    }
  }
  const beforeFlow = financialFlowMeaning(source);
  if ((beforeFlow.outflow > 0 || beforeFlow.inflow > 0)
    && JSON.stringify(beforeFlow) !== JSON.stringify(financialFlowMeaning(translated))) {
    throw new Error("translation changed a financial flow direction");
  }
  const beforeDirection = numericDirectionMeaning(source);
  if (JSON.stringify(beforeDirection) !== JSON.stringify(numericDirectionMeaning(translated))) {
    throw new Error("translation changed a numeric direction");
  }
}

function isTechnicalScalarKey(key, parentKey) {
  const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  const parent = String(parentKey || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (normalized === "id" && ["chain", "network"].includes(parent)) return true;
  return /^(?:chainid|networkid|protocolid|protocol|templateid|presetid|poolid|tokenversion|version|fromversion|toversion|selector|entryselector|symbol|ticker)$/.test(normalized);
}

export function collectTechnicalEventLiterals(event) {
  const literals = [];
  const visited = new WeakSet();
  const visit = (value, parentKey = "") => {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    for (const [key, nested] of Object.entries(value)) {
      if (isTechnicalScalarKey(key, parentKey) && ["string", "number", "bigint"].includes(typeof nested)) {
        const literal = oneLine(nested);
        if (literal) literals.push(literal);
      }
      if (nested && typeof nested === "object") visit(nested, key);
    }
  };
  visit(event);
  return [...new Set(literals)];
}

function importantLiterals(text, protectedTerms = []) {
  const source = oneLine(text);
  const slashLiterals = (source.match(/\b[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+\b/g) || [])
    .filter((value) => !/^(?:buy\/sell|input\/output|read\/write|and\/or)$/i.test(value))
    .filter((value) => {
      const parts = value.split("/");
      return parts.length >= 3
        || /^(?:src|lib|test|tests|docs|api|packages?|apps?|deploy)\//i.test(value)
        || value.includes("-")
        || /\.[a-z0-9]{1,8}$/i.test(parts.at(-1) || "");
    });
  const hexadecimalLiterals = (source.match(/\b[a-fA-F0-9]{7,40}\b/g) || [])
    .filter((value) => /[a-f]/i.test(value) && /\d/.test(value));
  const literals = [
    ...(source.match(/https?:\/\/[^\s<>"']+/gi) || []).map((value) => value.replace(/[),.;!?]+$/, "")),
    ...(source.match(/\b0x[a-fA-F0-9]{8,}\b/g) || []),
    ...(source.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g) || []),
    ...(source.match(/@[A-Za-z0-9_]{1,15}\b/g) || []),
    ...(source.match(/#[A-Za-z][A-Za-z0-9_]{1,63}\b/g) || []),
    ...(source.match(/\$[A-Z][A-Z0-9]{1,11}\b/g) || []),
    ...(source.match(/\b(?:v\d+(?:\.\d+){0,3}|\d+\.\d+\.\d+(?:\.\d+)?)(?:-[A-Za-z0-9.-]+)?\b/gi) || []),
    ...hexadecimalLiterals,
    ...(source.match(/\b[A-Z][A-Z0-9]{1,11}\b/g) || [])
      .filter((value) => !/^(?:USD|CNY|RMB)$/u.test(value)),
    ...slashLiterals,
    ...(source.match(/\b(?:[A-Za-z0-9]+_[A-Za-z0-9_]+|[A-Za-z0-9]*[a-z][A-Z][A-Za-z0-9]*)\b/g) || []),
    ...(source.match(/\b[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\()/g) || []),
    ...contextualTechnicalNumbers(source),
    ...protectedTerms.map(oneLine),
  ].filter((value) => value && source.includes(value));
  return [...new Set(literals)].sort((left, right) => right.length - left.length);
}

function assertTechnicalIdentifiersUnchanged(source, translated, protectedTerms = []) {
  const required = importantLiterals(source, protectedTerms);
  const missing = required.filter((literal) => !translated.includes(literal));
  if (missing.length) throw new Error(`translation changed a protected literal: ${missing[0]}`);

  const allowedTechnicalNumbers = new Set([
    ...contextualTechnicalNumbers(source),
    ...protectedTerms.map(oneLine).filter((literal) => /^\d{1,15}$/.test(literal)),
  ]);
  const rewritten = contextualTechnicalNumbers(translated)
    .find((literal) => !allowedTechnicalNumbers.has(literal));
  if (rewritten) throw new Error(`translation introduced an unknown technical ID: ${rewritten}`);
}

function shorten(value, maximum, literals = []) {
  const source = oneLine(value);
  if (source.length <= maximum) return source;
  const window = source.slice(0, maximum);
  const boundaries = [...window.matchAll(/[.!?。！？](?:\s|$)/g)];
  const lastBoundary = boundaries.at(-1);
  const minimumUseful = Math.floor(maximum * 0.55);
  const wordBoundary = Math.max(window.lastIndexOf(" "), window.lastIndexOf("，"), window.lastIndexOf(","), window.lastIndexOf("；"), window.lastIndexOf(";"));
  const cutAt = lastBoundary && lastBoundary.index >= minimumUseful
    ? lastBoundary.index + lastBoundary[0].trimEnd().length
    : wordBoundary >= minimumUseful ? wordBoundary : maximum;
  let compact = `${window.slice(0, cutAt).trimEnd()}…`;
  for (const literal of literals.slice(0, 8)) {
    if (!compact.includes(literal)) compact += ` ${literal}`;
  }
  return compact;
}

function needsEnglishTranslation(value, protectedTerms = []) {
  let source = oneLine(value);
  for (const literal of importantLiterals(source, protectedTerms)) source = source.replaceAll(literal, " ");
  const latinWords = source.match(/[A-Za-z][A-Za-z'-]*/g) || [];
  const chineseCharacters = source.match(/[\u3400-\u9fff]/g) || [];
  if (latinWords.join("").length < 4) return false;
  return chineseCharacters.length < latinWords.join("").length / 2;
}

function protectText(text, protectedTerms) {
  const literals = importantLiterals(text, protectedTerms);
  let protectedText = text;
  const replacements = [];
  for (const literal of literals) {
    // Letter-only sentinels survive both Google GTX and MyMemory. Underscore
    // markers are reformatted by some translation engines and cannot be restored.
    const marker = `ZXQKEEP${markerSuffix(replacements.length)}QXZ`;
    const pattern = new RegExp(escapeRegExp(literal), "g");
    if (!pattern.test(protectedText)) continue;
    protectedText = protectedText.replace(pattern, marker);
    replacements.push({ marker, literal });
  }
  return { protectedText, replacements, literals };
}

function restoreText(text, replacements) {
  let restored = String(text || "");
  for (const { marker, literal } of replacements) {
    if (!restored.includes(marker)) throw new Error("translation removed a protected literal");
    restored = restored.replaceAll(marker, literal);
  }
  return restored;
}

function parseGoogleTranslation(payload) {
  if (!Array.isArray(payload?.[0])) throw new Error("translation response shape invalid");
  const translated = payload[0].map((part) => Array.isArray(part) ? part[0] : "").join("").trim();
  if (!translated) throw new Error("translation response empty");
  return translated;
}

function parseMyMemoryTranslation(payload) {
  if (Number(payload?.responseStatus) !== 200) throw new Error(`MyMemory response ${payload?.responseStatus || "invalid"}`);
  const translated = decodeAlertDisplayEntities(payload?.responseData?.translatedText).trim();
  if (!translated) throw new Error("MyMemory response empty");
  return translated;
}

function byteLength(value) {
  return new TextEncoder().encode(value).length;
}

function myMemoryChunks(source, lineBreakMarker, maximumBytes = 470) {
  if (!lineBreakMarker || !source.includes(lineBreakMarker)) {
    if (byteLength(source) > maximumBytes) throw new Error("MyMemory segment exceeds 500-byte limit");
    return [source];
  }
  const chunks = [];
  let current = "";
  for (const part of source.split(lineBreakMarker).map((value) => value.trim())) {
    if (byteLength(part) > maximumBytes) throw new Error("MyMemory segment exceeds 500-byte limit");
    const candidate = current ? `${current} ${lineBreakMarker} ${part}` : part;
    if (current && byteLength(candidate) > maximumBytes) {
      chunks.push(current);
      current = part;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

async function googleAlertTranslation({ endpoint, source, targetLanguage, fetchImpl, signal, replacements }) {
  const url = new URL(endpoint);
  url.searchParams.set("client", "gtx");
  url.searchParams.set("sl", "auto");
  url.searchParams.set("tl", targetLanguage);
  url.searchParams.set("dt", "t");
  url.searchParams.set("q", source);
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "user-agent": "launchpad-monitor-bilingual/1.0" },
    signal,
  });
  if (!response?.ok) throw new Error(`Google translation HTTP ${response?.status || "unknown"}`);
  const body = await response.text();
  if (body.length > 200_000) throw new Error("Google translation response too large");
  return { text: restoreText(parseGoogleTranslation(JSON.parse(body)), replacements), provider: "google_gtx_public" };
}

async function myMemoryAlertTranslation({ endpoint, source, targetLanguage, fetchImpl, signal, replacements }) {
  const chunks = myMemoryChunks(source, null);
  const translatedChunks = await Promise.all(chunks.map(async (chunk) => {
    const url = new URL(endpoint);
    url.searchParams.set("q", chunk);
    url.searchParams.set("langpair", targetLanguage === "en" ? "zh-CN|en" : "en|zh-CN");
    url.searchParams.set("mt", "1");
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "launchpad-monitor-bilingual/1.0" },
      signal,
    });
    if (!response?.ok) throw new Error(`MyMemory translation HTTP ${response?.status || "unknown"}`);
    const body = await response.text();
    if (body.length > 200_000) throw new Error("MyMemory translation response too large");
    return parseMyMemoryTranslation(JSON.parse(body));
  }));
  return {
    text: restoreText(translatedChunks.join(" "), replacements),
    provider: "mymemory_public",
  };
}

function rememberTranslation(key, value) {
  if (translationCache.size >= MAX_CACHE_ENTRIES) translationCache.delete(translationCache.keys().next().value);
  translationCache.set(key, value);
}

function rememberAlertLineTranslation(key, value) {
  if (alertLineTranslationCache.size >= MAX_CACHE_ENTRIES) alertLineTranslationCache.delete(alertLineTranslationCache.keys().next().value);
  alertLineTranslationCache.set(key, value);
}

export function decodeAlertDisplayEntities(value) {
  const named = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  return String(value || "")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (match, name) => named[name.toLowerCase()] ?? match)
    .replace(/&#(\d+);/g, (match, decimal) => {
      const codePoint = Number(decimal);
      return Number.isSafeInteger(codePoint) && codePoint >= 32 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    })
    .replace(/&#x([0-9a-f]+);/gi, (match, hexadecimal) => {
      const codePoint = Number.parseInt(hexadecimal, 16);
      return Number.isSafeInteger(codePoint) && codePoint >= 32 && codePoint <= 0x10ffff
        ? String.fromCodePoint(codePoint)
        : match;
    });
}

export async function translateNarrativeToChinese(value, options = {}) {
  const source = oneLine(value);
  if (!source || !needsEnglishTranslation(source, options.protectedTerms || [])) return { text: source, status: "not_needed" };

  const sourceLiterals = importantLiterals(source, options.protectedTerms || []);
  const conciseSource = shorten(source, options.maxSourceLength || 560, sourceLiterals);
  const { protectedText, replacements, literals } = protectText(conciseSource, options.protectedTerms || []);
  const endpoint = options.endpoint || DEFAULT_TRANSLATION_URL;
  const cacheKey = JSON.stringify([endpoint, protectedText, replacements.map(({ literal }) => literal)]);
  const cached = translationCache.get(cacheKey);
  if (cached) return { text: cached, status: "translated_cached" };

  try {
    const url = new URL(endpoint);
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl", "auto");
    url.searchParams.set("tl", "zh-CN");
    url.searchParams.set("dt", "t");
    url.searchParams.set("q", protectedText);
    const fetchImpl = options.fetchImpl || globalThis.fetch;
    const response = await fetchImpl(url, {
      headers: { accept: "application/json", "user-agent": "launchpad-monitor-translation/1.0" },
      signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
    });
    if (!response?.ok) throw new Error(`translation HTTP ${response?.status || "unknown"}`);
    const body = await response.text();
    if (body.length > 200_000) throw new Error("translation response too large");
    const translated = restoreText(parseGoogleTranslation(JSON.parse(body)), replacements);
    if (!/[\u3400-\u9fff]/.test(translated)) throw new Error("translation did not return Chinese text");
    const concise = shorten(translated, options.maxOutputLength || 220, literals);
    rememberTranslation(cacheKey, concise);
    return { text: concise, status: "translated" };
  } catch (error) {
    const fallback = shorten(source, options.fallbackLength || 180, sourceLiterals);
    return { text: `翻译暂不可用：${fallback}`, status: "fallback_english", error: error?.message || "translation failed" };
  }
}

function requiresChineseNarrative(value, protectedTerms = []) {
  let source = oneLine(value);
  for (const literal of importantLiterals(source, protectedTerms)) source = source.replaceAll(literal, " ");
  // Source/identifier rows deliberately keep these protocol labels in English.
  // They are technical notation, not untranslated user-facing narrative.
  source = source.replace(/\b(?:commit|sha|pr|ca|tx|factory|contract|quote|post|launcher|chain\s*id|x\s*post|block|position\s*proof|true|false)\b/gi, " ");
  // Short action words such as "Add" and "Fix" carry the actual change meaning in
  // GitHub cards, so they must not be mistaken for protected technical literals.
  return (source.match(/[A-Za-z][A-Za-z'-]*/g) || []).join("").length >= 3;
}

function safeTranslationError(error) {
  const messages = error instanceof AggregateError
    ? error.errors.map((item) => item?.message || item).filter(Boolean).join(" | ")
    : error?.message || error || "translation failed";
  return oneLine(messages).slice(0, 240);
}

const ENGLISH_ALERT_LABELS = new Map([
  ["变化类型", "Change type"],
  ["原有", "Before"],
  ["更新后", "After"],
  ["对比依据", "Comparison basis"],
  ["具体更新", "Update"],
  ["关键变化", "Key changes"],
  ["关键差异", "Key changes"],
  ["具体内容", "Details"],
  ["结论", "Conclusion"],
  ["重点", "Key"],
  ["变化", "Change"],
  ["范围", "Scope"],
  ["标识 / 来源", "ID / Source"],
  ["状态", "Status"],
  ["状态 / 时间", "Status / Time"],
  ["阶段 / 时间", "Stage / Time"],
  ["证据", "Evidence"],
  ["风险", "Risk"],
  ["时间", "Time"],
  ["仓库", "Repository"],
  ["发射台", "Launchpad"],
  ["用途", "Purpose"],
  ["创建", "Created"],
  ["来源", "Source"],
  ["网络", "Network"],
  ["首币", "First token"],
  ["合约", "Contract"],
  ["地址", "Address"],
  ["市场", "Market"],
  ["模块", "Module"],
  ["代码", "Code"],
  ["处理", "Action"],
  ["监控", "Monitoring"],
]);

function alertTranslationPlan(line, targetLanguage) {
  const labelled = line.match(/^(.{1,28}?)[：:]\s*(.+)$/u);
  if (!labelled) return { prefix: "", fragment: line };
  if (targetLanguage === "zh-CN" && /[\u3400-\u9fff]/.test(labelled[1])) {
    return { prefix: `${labelled[1]}: `, fragment: labelled[2] };
  }
  if (targetLanguage === "en") {
    const canonical = ENGLISH_ALERT_LABELS.get(labelled[1].trim());
    if (canonical) return { prefix: `${canonical}: `, fragment: labelled[2] };
  }
  return { prefix: "", fragment: line };
}

function normalizeCanonicalAlertTranslation(source, value, targetLanguage, protectedTerms = []) {
  let output = decodeAlertDisplayEntities(value).replace(/\s+/g, " ").trim();
  if (targetLanguage === "zh-CN") {
    // Normalize a small set of product phrases before masking protected brand
    // names. Replacements retain every protected literal byte-for-byte.
    output = output
      .replace(/\bBinance Wallet\s+introduces\s+KOL\s+Trade Thesis\s+sharing\s+after\s+an?\s+on-chain\s+buy\b/gi,
        "Binance Wallet 推出 KOL 买入后发布 Trade Thesis 的喊单功能")
      .replace(/\bBinance Wallet\s+introduces\b/gi, "Binance Wallet 推出")
      .replace(/\bKOL\s+Trade Thesis\s+sharing\b/gi, "KOL Trade Thesis 喊单分享")
      .replace(/\bEligible\s+KOLs?\s+can\s+publish\s+a\s+Trade Thesis\s+after\s+buying\b/gi, "符合条件的 KOL 买入后可发布 Trade Thesis")
      .replace(/\bTaxToken9\s+Charity Donation\s+feature\s+is\s+now\s+live\b/gi, "TaxToken9 慈善捐赠功能现已上线")
      .replace(/\bTransaction\s+taxes\s+can\s+go\s+to\s+Giggle\s+or\s+Binance Charity\b/gi, "交易税可捐赠给 Giggle 或 Binance Charity");
  }
  const preserved = [];
  for (const literal of protectedTerms.map(oneLine).filter(Boolean).sort((left, right) => right.length - left.length)) {
    if (!output.includes(literal)) continue;
    const marker = `ZXQNORM${markerSuffix(preserved.length)}QXZ`;
    output = output.replaceAll(literal, marker);
    preserved.push({ marker, literal });
  }
  if (targetLanguage === "zh-CN") {
    output = output
      .replace(/\s*\/\s*(?:NEW\s+POOL|POOL\s+UPDATE)\s*:?[：]?\s*/gi, ": ")
      .replace(/\bbuy\s*\/\s*sell\s+tax(?:es)?\b/gi, "买入/卖出税费")
      .replace(/\bseed\s+phrase\b/gi, "助记词")
      .replace(/\bfeat(?:ure)?\s*:\s*add(?:s|ed|ing)?\b/gi, "功能：新增")
      .replace(/\bfeat(?:ure)?\s*:/gi, "功能：")
      .replace(/\bcharity\s+donation\s+feature\b/gi, "慈善捐赠功能")
      .replace(/\bBinance Wallet\s+introduces\b/gi, "Binance Wallet 推出")
      .replace(/\bKOL\s+Trade Thesis\s+sharing\b/gi, "KOL Trade Thesis 喊单分享")
      .replace(/\bafter\s+an?\s+on-chain\s+buy\b/gi, "在链上买入后")
      .replace(/\bEligible\s+KOLs?\s+can\s+publish\s+a\s+Trade Thesis\s+after\s+buying\b/gi, "符合条件的 KOL 买入后可发布 Trade Thesis")
      .replace(/\bFollowers?\s+can\s+open\s+the\s+token\s+page\s+from\s+the\s+call\b/gi, "关注者可从喊单直接打开代币页面")
      .replace(/\bTaxToken9\s+Charity Donation\s+feature\s+is\s+now\s+live\b/gi, "TaxToken9 慈善捐赠功能现已上线")
      .replace(/\bTransaction\s+taxes\s+can\s+go\s+to\s+Giggle\s+or\s+Binance Charity\b/gi, "交易税可捐赠给 Giggle 或 Binance Charity")
      .replace(/\bCharity Badge\s+added\b/gi, "新增 Charity Badge")
      .replace(/\bOn-chain\s+Charity Dashboard\s+added\b/gi, "新增链上 Charity Dashboard");
    output = output.replace(/(现已上线|Binance Charity)\.\s*/g, "$1。");
  } else {
    output = output
      .replace(/\bofficial\s+abilit(?:y|ies)\s+updates?\b/gi, "official capability update")
      .replace(/\bofficial\s+dynamics?\b/gi, "official update")
      .replace(/\bofficial\s+(?:news|development)\b/gi, "official update")
      .replace(/\bfirst\s+release\b/gi, "FIRST PUBLISHED")
      .replace(/\bnew\s+social\s+trading\s+function\b/gi, "social trading feature")
      .replace(/\bnew\s+(?:pot|bottom\s+pool|base\s+pool)\b/gi, "new pool")
      .replace(/\bnew\s+pool\s*\/\s*NEW\s+POOL\b/gi, "new pool")
      .replace(/\bpool\s+update\s*\/\s*POOL\s+UPDATE\b/gi, "pool update")
      .replace(/^specific\s+updates?\s*:/i, "Update:")
      .replace(/^creation\s*:/i, "Created:");
    const localEnglishTerms = [
      [/KOL\s*买入后可发布\s*(ZXQNORM[A-Z]+QXZ)\s*·\s*社交交易新功能/g, "KOL post-buy $1 social trading feature"],
      [/🟢\s*新增/g, "🟢 Added"],
      [/🟡\s*修改/g, "🟡 MODIFIED"],
      [/🟠\s*修改/g, "🟠 Modified"],
      [/🔴\s*移除/g, "🔴 Removed"],
      [/🔵\s*首次发布/g, "🔵 FIRST PUBLISHED"],
      [/🔵\s*发布/g, "🔵 Published"],
      [/🟣\s*升级/g, "🟣 Upgraded"],
      [/🟡\s*状态变化/g, "🟡 Status changed"],
      [/此前监控基线未记录/g, "not recorded in the prior monitoring baseline"],
      [/旧值暂不可得/g, "previous value unavailable"],
      [/精确前后快照/g, "exact before/after snapshot"],
      [/精确旧快照/g, "exact previous snapshot"],
      [/官方声明/g, "official claim"],
      [/官方原文声明/g, "explicit official statement"],
      [/监控基线/g, "monitoring baseline"],
      [/新增底池/g, "New pool"],
      [/新底池/g, "New pool"],
      [/底池配置更新/g, "Pool configuration update"],
      [/底池更新/g, "Pool update"],
      [/报价资产/g, "quote asset"],
      [/报价/g, "Quote"],
      [/官方能力更新/g, "official capability update"],
      [/官方代码更新/g, "official code update"],
      [/官方动态/g, "official update"],
      [/官方 X 明示已上线/g, "Official X states the feature is live"],
      [/链上\/合约启用尚未独立核验/g, "on-chain/contract activation is not independently verified"],
      [/官方页面已记录/g, "Official page recorded"],
      [/链上部署\/实际启用尚未确认/g, "on-chain deployment or activation is not yet verified"],
      [/链上启用尚未独立核验/g, "on-chain activation is not independently verified"],
      [/监控信号已确认/g, "Verified monitoring signal"],
      [/部署或启用状态仍需核验/g, "deployment or activation still requires verification"],
      [/官方来源已验证/g, "Verified official source"],
      [/产品是否启用仍需确认/g, "product activation still requires confirmation"],
      [/官方来源已记录该变化/g, "Official source records this change"],
      [/部署或启用状态尚未核验/g, "deployment or activation is not yet verified"],
      [/延迟\s*(\d+)秒/g, "delay $1s"],
      [/延迟\s*(\d+)分钟/g, "delay $1m"],
      [/未取得/g, "not available"],
      [/另有\s*(\d+)项/g, "$1 more items"],
    ];
    for (const [pattern, replacement] of localEnglishTerms) output = output.replace(pattern, replacement);
    if (/仓库|GitHub/i.test(source)) output = output.replace(/\bwarehouses?\b/gi, "repository");
    if (/发射台/.test(source)) output = output.replace(/\btransmitters?\b/gi, "launchpad");
    if (/底池/.test(source)) output = output.replace(/\bpot\b/gi, "pool");
    if (/报价/.test(source)) output = output.replace(/\b(?:quotation|quoted)\s+(asset|token)\b/gi, "quote $1");
    output = output
      .replace(/;\s*whether\s+(?:it\s+is\s+)?released,?\s+deployed\s+or\s+enabled\s+(?:is\s+)?not\s+(?:yet\s+)?confirmed\.?$/i,
        "; release, deployment, or activation is not yet confirmed.")
      .replace(/\s+Not confirmed(?: yet)?\.?$/i, "; not yet confirmed.");
  }
  if (targetLanguage === "en") {
    output = output.replaceAll("；", "; ").replaceAll("，", ", ").replaceAll("：", ": ").replaceAll("。", ".");
  }
  output = output.replace(/\s+([,.;:!?])/g, "$1").replace(/([:：])\s*\1+/g, "$1 ").replace(/\s{2,}/g, " ").trim();
  for (const { marker, literal } of preserved) output = output.replaceAll(marker, literal);
  if (targetLanguage === "zh-CN") output = output.replace(/Binance Charity\.\s*/g, "Binance Charity。");
  return output;
}

function validateAlertLanguage(source, translated, targetLanguage, protectedTerms = []) {
  if (/ZXQ(?:KEEP|NORM)[A-Z0-9]+QXZ/i.test(translated)) {
    throw new Error("internal translation marker leaked");
  }
  let narrative = translated;
  for (const literal of importantLiterals(source, protectedTerms)) narrative = narrative.replaceAll(literal, " ");
  const chineseCount = (narrative.match(/[\u3400-\u9fff]/g) || []).length;
  const latinCount = (narrative.match(/[A-Za-z]/g) || []).length;
  assertNumericMeaningUnchanged(source, translated);
  if (targetLanguage === "en") {
    if (latinCount < 3) throw new Error("translation did not return English text");
    if (chineseCount > Math.max(4, Math.floor(latinCount * 0.18))) {
      throw new Error("translation left too much Chinese narrative");
    }
  } else {
    if (chineseCount < 1) throw new Error("translation did not return Chinese text");
    const sourceLatinCount = (source.match(/[A-Za-z]/g) || []).length;
    if (sourceLatinCount >= 12
      && oneLine(source).toLowerCase() === oneLine(translated).toLowerCase()) {
      throw new Error("translation returned the source text unchanged");
    }
    if (latinCount > Math.max(12, Math.floor(chineseCount * 1.25))) {
      throw new Error("translation left too much English narrative");
    }
  }
}

function fallbackAlertLine(plan, targetLanguage, protectedTerms) {
  const factParts = String(plan.fragment || "").split(/｜|\s\|\s/u).map(oneLine).filter(Boolean);
  const firstFact = /^(?:标题|Headline)[:：]?\s*(?:未取得|unavailable)$/iu.test(factParts[0] || "")
    ? factParts[1] || factParts[0]
    : factParts[0] || plan.fragment;
  let narrative = oneLine(firstFact);
  for (const literal of importantLiterals(narrative, protectedTerms)) narrative = narrative.replaceAll(literal, " ");
  narrative = narrative.replace(/\b(?:commit|sha|pr|ca|tx|factory|contract|quote|post|launcher|chain\s*id|x\s*post|block|position\s*proof|true|false)\b/gi, " ");
  const chineseCharacters = (narrative.match(/[\u3400-\u9fff]/g) || []).length;
  const englishWords = (narrative.match(/[A-Za-z][A-Za-z'-]*/g) || []).length;
  const sourceLanguage = chineseCharacters >= 2 && chineseCharacters / 2 >= englishWords
    ? "zh-CN"
    : englishWords >= 3 && englishWords > chineseCharacters / 2 ? "en" : null;
  if (sourceLanguage === targetLanguage) return `${plan.prefix}${plan.fragment}`.trim();
  const literals = importantLiterals(plan.fragment, protectedTerms)
    .filter((literal) => !/^(?:CST|UTC|GMT)$/iu.test(literal))
    .slice(0, 6);
  const evidence = literals.length ? ` · ${literals.join(" · ")}` : "";
  if (targetLanguage === "zh-CN") return `${plan.prefix}中文翻译暂不可用；请看英文原文${evidence}`.trim();
  return `${plan.prefix}English translation unavailable; see verified Chinese facts${evidence}`.trim();
}

export async function translateAlertLines(values, options = {}) {
  const startedAt = Date.now();
  const targetLanguage = options.targetLanguage === "en" ? "en" : "zh-CN";
  const protectedTerms = [...new Set((options.protectedTerms || []).map(oneLine).filter(Boolean))];
  const lines = (Array.isArray(values) ? values : String(values || "").split(/\r?\n/))
    .map((value) => decodeAlertDisplayEntities(value).replace(/\s+/g, " ").trim())
    .map((line) => targetLanguage === "zh-CN"
      ? normalizeCanonicalAlertTranslation(line, line, targetLanguage, protectedTerms)
      : line);
  const plans = [];
  let locallyRendered = 0;

  lines.forEach((line, index) => {
    const needsTranslation = targetLanguage === "en"
      ? /[\u3400-\u9fff]/.test(line)
      : requiresChineseNarrative(line, protectedTerms);
    if (!needsTranslation) return;
    const { prefix, fragment } = alertTranslationPlan(line, targetLanguage);
    if (!oneLine(fragment)) return;
    if (targetLanguage === "en" && prefix) {
      const local = normalizeCanonicalAlertTranslation(fragment, fragment, targetLanguage, protectedTerms);
      if (!/[\u3400-\u9fff]/.test(local)) {
        try {
          assertTechnicalIdentifiersUnchanged(fragment, local, protectedTerms);
          lines[index] = `${prefix}${local}`.trim();
          locallyRendered += 1;
          return;
        } catch {
          // Continue through the protected provider path when a glossary rule
          // would rewrite a project name or another technical literal.
        }
      }
    }
    plans.push({ index, line, prefix, fragment });
  });

  if (!plans.length) {
    return {
      lines,
      status: locallyRendered ? "translated_local" : "not_needed",
      provider: "local_glossary",
      latencyMs: Date.now() - startedAt,
      error: null,
    };
  }

  const endpoint = options.endpoint || DEFAULT_TRANSLATION_URL;
  const fallbackEndpoint = options.fallbackEndpoint || null;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  let rejectDeadline;
  const deadline = new Promise((_, reject) => { rejectDeadline = reject; });
  const timeout = setTimeout(() => {
    const error = new Error(`translation timeout after ${timeoutMs}ms`);
    controller.abort(error);
    rejectDeadline(error);
  }, timeoutMs);
  // In-flight requests are shared only within this alert. A short-timeout alert
  // must never abort another alert translating the same text with a larger budget.
  const inFlightTranslations = new Map();

  const translatePlan = async (plan) => {
    const { protectedText, replacements } = protectText(plan.fragment, protectedTerms);
    const cacheKey = JSON.stringify(["alert-line-v4", endpoint, fallbackEndpoint, targetLanguage, protectedText, replacements.map(({ literal }) => literal)]);
    const cached = alertLineTranslationCache.get(cacheKey);
    if (cached) return { ...cached, cached: true };
    let inFlight = inFlightTranslations.get(cacheKey);
    if (!inFlight) {
      const validateResult = async (request) => {
        const result = await request;
        const normalized = normalizeCanonicalAlertTranslation(plan.fragment, result.text, targetLanguage, protectedTerms);
        validateAlertLanguage(plan.fragment, normalized, targetLanguage, protectedTerms);
        assertTechnicalIdentifiersUnchanged(plan.fragment, normalized, protectedTerms);
        return { ...result, text: normalized };
      };
      const providerAttempt = (async () => {
        try {
          return await validateResult(googleAlertTranslation({
            endpoint,
            source: protectedText,
            targetLanguage,
            fetchImpl,
            signal: controller.signal,
            replacements,
          }));
        } catch (primaryError) {
          if (!fallbackEndpoint) throw primaryError;
          try {
            return await validateResult(myMemoryAlertTranslation({
              endpoint: fallbackEndpoint,
              source: protectedText,
              targetLanguage,
              fetchImpl,
              signal: controller.signal,
              replacements,
            }));
          } catch (fallbackError) {
            throw new AggregateError([primaryError, fallbackError], "all translation providers failed");
          }
        }
      })();
      // Public providers or injected fetch implementations can ignore abort.
      // Race the cached provider attempt itself against the hard deadline so a
      // hung promise cannot remain in the global in-flight map indefinitely.
      inFlight = Promise.race([providerAttempt, deadline])
        .finally(() => inFlightTranslations.delete(cacheKey));
      inFlightTranslations.set(cacheKey, inFlight);
    }
    const translation = await Promise.race([inFlight, deadline]);
    rememberAlertLineTranslation(cacheKey, translation);
    return { ...translation, cached: false };
  };

  try {
    const settled = await Promise.allSettled(plans.map(translatePlan));
    const output = [...lines];
    const errors = [];
    const providers = new Set();
    let successes = 0;
    let cachedSuccesses = 0;
    settled.forEach((result, index) => {
      const plan = plans[index];
      if (result.status === "fulfilled") {
        successes += 1;
        if (result.value.cached) cachedSuccesses += 1;
        providers.add(result.value.provider);
        output[plan.index] = `${plan.prefix}${result.value.text}`.trim();
      } else {
        errors.push(`line ${plan.index + 1}: ${safeTranslationError(result.reason)}`);
        output[plan.index] = fallbackAlertLine(plan, targetLanguage, protectedTerms);
      }
    });
    const failures = plans.length - successes;
    return {
      lines: output,
      status: failures === plans.length ? "fallback_source" : failures > 0 ? "partial_fallback" : cachedSuccesses === plans.length ? "translated_cached" : "translated",
      provider: [locallyRendered ? "local_glossary" : null, ...providers].filter(Boolean).join("+")
        || (fallbackEndpoint ? "google_gtx_public+mymemory_public" : "google_gtx_public"),
      latencyMs: Date.now() - startedAt,
      error: errors.length ? oneLine(errors.join(" | ")).slice(0, 240) : null,
    };
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}

function protectedProjectTerms(event) {
  return [
    event.project?.name,
    event.project?.id,
    event.launchpad?.name,
    typeof event.launchpad === "string" ? event.launchpad : null,
    event.platform?.name,
    event.platform?.id,
    event.chain?.name,
    event.tokenSymbol,
    event.tweet?.handle ? `@${event.tweet.handle}` : null,
    event.caller?.handle ? `@${event.caller.handle}` : null,
    event.thesis?.handle ? `@${event.thesis.handle}` : null,
    ...collectTechnicalEventLiterals(event),
  ].filter(Boolean);
}

async function localizeField(value, config, event, limits) {
  return translateNarrativeToChinese(value, {
    endpoint: config.alertTranslationUrl,
    timeoutMs: config.alertTranslationTimeoutMs,
    fetchImpl: config.alertTranslationFetchImpl,
    protectedTerms: protectedProjectTerms(event),
    ...limits,
  });
}

export async function localizeAlertEvent(config, event) {
  if (config.alertChineseTranslationEnabled !== true || !LOCALIZED_EVENT_TYPES.has(event?.type)) return event;
  try {
    if (event.type === "twitter_update" && event.tweet?.text) {
      const keyChanges = (event.signal?.keyChanges || []).slice(0, 5);
      const headline = event.signal?.headline || null;
      const localized = await Promise.all([
        localizeField(event.tweet.text, config, event, { maxSourceLength: 560, maxOutputLength: 220, fallbackLength: 180 }),
        ...(headline ? [localizeField(headline, config, event, { maxSourceLength: 260, maxOutputLength: 150, fallbackLength: 135 })] : []),
        ...keyChanges.map((value) => localizeField(value, config, event, { maxSourceLength: 220, maxOutputLength: 150, fallbackLength: 130 })),
      ]);
      const result = localized[0];
      const localizedHeadline = headline ? localized[1] : null;
      const localizedChanges = localized.slice(headline ? 2 : 1);
      return {
        ...event,
        tweet: { ...event.tweet, text: result.text },
        ...(headline || keyChanges.length ? {
          signal: {
            ...event.signal,
            ...(localizedHeadline ? { headline: localizedHeadline.text } : {}),
            ...(keyChanges.length ? { keyChanges: localizedChanges.map((item) => item.text) } : {}),
          },
        } : {}),
        localization: { field: headline || keyChanges.length ? "tweet.text+signal.changeFacts" : "tweet.text", status: result.status },
      };
    }
    if (event.type === "github_module_update" && event.message) {
      const result = await localizeField(event.message, config, event, { maxSourceLength: 300, maxOutputLength: 160, fallbackLength: 150 });
      return { ...event, message: result.text, localization: { field: "message", status: result.status } };
    }
    if (event.type === "github_repository_discovered" && event.repositoryMetadata?.description) {
      const result = await localizeField(event.repositoryMetadata.description, config, event, { maxSourceLength: 260, maxOutputLength: 160, fallbackLength: 140 });
      return {
        ...event,
        repositoryMetadata: { ...event.repositoryMetadata, description: result.text },
        localization: { field: "repositoryMetadata.description", status: result.status },
      };
    }
    if (event.type === "platform_capability_update") {
      const fields = ["newModules", "removedModules", "newAnnouncements", "newCampaigns", "removedAnnouncements", "removedCampaigns"];
      const changes = { ...(event.changes || {}) };
      const statuses = [];
      for (const field of fields) {
        if (!Array.isArray(changes[field]) || !changes[field].length) continue;
        const localized = await Promise.all(changes[field].slice(0, 8).map((value) => localizeField(value, config, event, { maxSourceLength: 220, maxOutputLength: 130, fallbackLength: 115 })));
        changes[field] = [...localized.map((item) => item.text), ...changes[field].slice(localized.length)];
        statuses.push(...localized.map((item) => item.status));
      }
      return { ...event, changes, localization: { field: "changes", status: statuses.some((value) => value === "translated") ? "translated" : "not_needed" } };
    }
    if (["uniswap_official_update", "ai_official_update"].includes(event.type) && (event.summary || event.title)) {
      const [title, summary] = await Promise.all([
        event.title ? localizeField(event.title, config, event, { maxSourceLength: 300, maxOutputLength: 150, fallbackLength: 140 }) : null,
        (event.summary || event.description || event.factSummary)
          ? localizeField(event.summary || event.description || event.factSummary, config, event, { maxSourceLength: 420, maxOutputLength: 180, fallbackLength: 160 })
          : null,
      ]);
      return {
        ...event,
        ...(title ? { title: title.text } : {}),
        ...(summary ? { summary: summary.text } : {}),
        localization: { field: title && summary ? "title+summary" : title ? "title" : "summary", status: summary?.status || title?.status },
      };
    }
    if (event.type === "binance_official_update" && event.kind === "announcement" && event.title) {
      const keyChanges = (event.keyChanges || []).slice(0, 3);
      const localized = await Promise.all([
        localizeField(event.title, config, event, { maxSourceLength: 260, maxOutputLength: 140, fallbackLength: 140 }),
        ...keyChanges.map((value) => localizeField(value, config, event, { maxSourceLength: 360, maxOutputLength: 170, fallbackLength: 155 })),
      ]);
      const [title, ...changes] = localized;
      return {
        ...event,
        title: title.text,
        ...(keyChanges.length ? { keyChanges: changes.map((item) => item.text), factSummary: changes.map((item) => item.text).join("；") } : {}),
        localization: {
          field: keyChanges.length ? "title+keyChanges" : "title",
          status: localized.some((item) => item.status === "translated") ? "translated" : title.status,
        },
      };
    }
    if (event.type === "bsc_launchpad_update" && event.mode?.selector === "official-template" && event.mode?.template?.description) {
      const result = await localizeField(event.mode.template.description, config, event, { maxSourceLength: 420, maxOutputLength: 180, fallbackLength: 160 });
      return {
        ...event,
        mode: { ...event.mode, template: { ...event.mode.template, description: result.text } },
        localization: { field: "mode.template.description", status: result.status },
      };
    }
    if (event.type === "fomo_family_top_call" && event.thesis?.text) {
      const result = await localizeField(event.thesis.text, config, event, { maxSourceLength: 300, maxOutputLength: 150, fallbackLength: 130 });
      return {
        ...event,
        thesis: { ...event.thesis, text: result.text },
        localization: { field: "thesis.text", status: result.status },
      };
    }
    if (event.type === "launchpad_site_update") {
      const model = event.launchpad?.model
        ? await localizeField(event.launchpad.model, config, event, { maxSourceLength: 260, maxOutputLength: 140, fallbackLength: 130 })
        : null;
      const localizedFeatures = Array.isArray(event.newFeatures)
        ? await Promise.all(event.newFeatures.slice(0, 8).map((value) => localizeField(value, config, event, { maxSourceLength: 220, maxOutputLength: 130, fallbackLength: 115 })))
        : [];
      return {
        ...event,
        ...(model ? { launchpad: { ...event.launchpad, model: model.text } } : {}),
        ...(localizedFeatures.length ? { newFeatures: [...localizedFeatures.map((item) => item.text), ...event.newFeatures.slice(localizedFeatures.length)] } : {}),
        localization: { field: model && localizedFeatures.length ? "launchpad.model+newFeatures" : model ? "launchpad.model" : "newFeatures", status: model?.status || localizedFeatures[0]?.status || "not_needed" },
      };
    }
    return event;
  } catch {
    return event;
  }
}

export function clearTranslationCache() {
  translationCache.clear();
  alertLineTranslationCache.clear();
}
