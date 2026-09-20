import { isNarrativeTradeSignal } from "./narrative-trade-signal.js";

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/gu;
const MAX_LINE_LENGTH = 150;

function text(value) {
  return String(value ?? "").replace(/\s+/gu, " ").trim();
}

function scalar(value) {
  if (typeof value === "string" || typeof value === "number") return text(value);
  return "";
}

function localized(segment, language, fallback = "") {
  if (segment && typeof segment === "object") {
    const candidate = text(segment[language]);
    if (candidate) return candidate;
  }
  return text(fallback);
}

function firstAddress(...values) {
  for (const value of values) {
    const match = text(value).match(ADDRESS_RE)?.[0];
    if (match) return match;
  }
  return null;
}

function boundedLine(label, value) {
  const prefix = String(label ?? "").replace(/\s+/gu, " ");
  const body = text(value) || "—";
  const line = `${prefix}${body}`;
  if (line.length <= MAX_LINE_LENGTH) return line;
  const available = Math.max(8, MAX_LINE_LENGTH - prefix.length - 1);
  return `${prefix}${body.slice(0, available).trimEnd()}…`.slice(0, MAX_LINE_LENGTH);
}

function decisionLabel(decision, language) {
  const zh = language === "zh";
  if (decision === "do") return zh ? "符合策略" : "Strategy match";
  if (decision === "watch") return zh ? "继续观察" : "Keep watching";
  return zh ? "不符合策略" : "No strategy match";
}

function platformName(signal) {
  const raw = scalar(signal?.event?.platform)
    || scalar(signal?.event?.platformName)
    || scalar(signal?.platform);
  const normalized = raw.toLowerCase().replace(/[^a-z0-9]/gu, "");
  if (normalized === "flap") return "Flap";
  if (normalized === "fourmeme") return "Four.Meme";
  if (normalized === "ponfun") return "pon.fun";
  return raw;
}

function withoutSectionPrefix(value, language, section) {
  const raw = text(value);
  const prefixes = {
    event: language === "zh" ? ["已核验事件｜", "未核验事件｜"] : ["Verified event | ", "Unverified event | "],
    mechanism: language === "zh" ? ["机制｜"] : ["Mechanism | "],
    target: language === "zh" ? ["交易标的｜"] : ["Trade target | "],
    confirmation: language === "zh" ? ["确认｜"] : ["Confirmation | "],
  };
  for (const prefix of prefixes[section] || []) {
    if (raw.startsWith(prefix)) return raw.slice(prefix.length);
  }
  return raw;
}

function targetAddress(signal) {
  return firstAddress(
    signal?.target?.ca,
    signal?.target?.address,
    signal?.target?.tokenAddress,
    signal?.target?.contractAddress,
    signal?.shadowOrder?.ca,
    signal?.shadowOrder?.tokenAddress,
    signal?.shadowOrder?.targetAddress,
    signal?.target?.zh,
    signal?.target?.en,
  );
}

function cstTime(value, language) {
  const parsed = Date.parse(scalar(value));
  if (!Number.isFinite(parsed)) {
    return language === "zh" ? "信号未提供有效时间" : "Signal has no valid timestamp";
  }
  const cst = new Date(parsed + 8 * 60 * 60 * 1_000);
  const part = (method) => String(cst[method]()).padStart(2, "0");
  const month = String(cst.getUTCMonth() + 1).padStart(2, "0");
  return `${month}-${part("getUTCDate")} ${part("getUTCHours")}:${part("getUTCMinutes")} CST`;
}

function narrativePath(signal, language) {
  const mechanism = withoutSectionPrefix(localized(signal?.mechanism, language), language, "mechanism");
  const capitalFlow = localized(signal?.mechanism?.capitalFlow, language);
  return capitalFlow || mechanism;
}

function eventFact(signal, language) {
  return withoutSectionPrefix(localized(signal?.event, language), language, "event")
    .replace(language === "zh" ? /[｜|]\s*新鲜$/u : /\s*[|｜]\s*fresh$/iu, "")
    .trim();
}

function confirmationFact(signal, language) {
  return withoutSectionPrefix(localized(signal?.confirmation, language), language, "confirmation")
    .replace(/；\s*/gu, "｜")
    .replace(/;\s*/gu, " | ")
    .replace(/窗口\s*open/giu, "窗口已开启")
    .replace(/window\s+open/giu, "entry window open");
}

function targetFact(signal, language, address) {
  const zh = language === "zh";
  const target = signal?.target || {};
  const raw = withoutSectionPrefix(localized(target, language), language, "target");
  const firstLabel = raw.split(/\s*[｜|]\s*/u).map(text).find((value) => value
    && !/^chainId=/iu.test(value)
    && !/^CA\s+/iu.test(value));
  const chainId = Number(target.chainId);
  return [
    address || (zh ? "信号未提供目标 CA" : "Target CA not included in signal"),
    Number.isSafeInteger(chainId) && chainId > 0 ? `chainId=${chainId}` : null,
    scalar(target.symbol) || firstLabel,
  ].filter(Boolean).join(zh ? "｜" : " | ");
}

function renderLanguage(signal, language) {
  const zh = language === "zh";
  const address = targetAddress(signal);
  const score = Number.isFinite(Number(signal?.score)) ? Math.round(Number(signal.score)) : null;
  const confirmation = withoutSectionPrefix(localized(signal?.confirmation, language), language, "confirmation");
  const platform = platformName(signal) || (zh ? "信号未提供平台" : "Platform not included in signal");
  return [
    boundedLine(zh ? "平台：" : "Platform: ", `${platform}${zh ? "｜AI 叙事分析" : " | AI narrative analysis"}`),
    boundedLine(zh ? "结果：" : "Result: ", `${decisionLabel(signal?.decision, language)}${score == null ? "" : `${zh ? "｜评分 " : " | score "}${score}/100`}`),
    boundedLine(zh ? "事件：" : "Event: ", eventFact(signal, language) || (zh ? "信号未提供事件描述" : "Signal has no event description")),
    boundedLine(zh ? "资金路径：" : "Capital path: ", narrativePath(signal, language) || (zh ? "信号未提供资金路径" : "Signal has no capital path")),
    boundedLine(zh ? "目标 CA：" : "Target CA: ", targetFact(signal, language, address)),
    boundedLine(zh ? "触发条件：" : "Trigger: ", confirmationFact(signal, language) || confirmation || (zh ? "信号未提供触发条件" : "Signal has no trigger condition")),
    boundedLine(zh ? "时间：" : "Time: ", cstTime(signal?.asOf || signal?.event?.asOf, language)),
  ];
}

export function renderNarrativeTradeSignalLanguageLines(signal, language) {
  if (!isNarrativeTradeSignal(signal)) {
    throw new TypeError("a deterministic narrative trade signal is required");
  }
  if (!new Set(["zh", "en"]).has(language)) {
    throw new TypeError("language must be zh or en");
  }
  return renderLanguage(signal, language);
}

export function renderNarrativeTradeSignalText(signal, { strong = signal?.decision === "do" } = {}) {
  if (!isNarrativeTradeSignal(signal)) {
    throw new TypeError("a deterministic narrative trade signal is required");
  }
  const header = strong ? "🔴 强提醒 | STRONG ALERT" : "🔔 监控提醒 | MONITOR ALERT";
  return [
    header,
    "🇨🇳 中文",
    ...renderNarrativeTradeSignalLanguageLines(signal, "zh"),
    "",
    "🇬🇧 English",
    ...renderNarrativeTradeSignalLanguageLines(signal, "en"),
  ].join("\n");
}
