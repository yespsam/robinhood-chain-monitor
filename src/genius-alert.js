import { createHash } from "node:crypto";
import { decodeAlertDisplayEntities, translateAlertLines } from "./chinese-localizer.js";
import { isGeniusHistorical, isGeniusOfficialEvent } from "./genius-source-policy.js";
import { compactGeniusText, summarizeGeniusEvent } from "./genius-summary.js";

const LABELS = Object.freeze({
  manifest_update: ["官方配置更新", "Official configuration update"],
  docs_update: ["官方说明更新", "Official documentation update"],
  official_announcement: ["已观测官方原文", "Observed official statement"],
  official_token_launch: ["官方地址关联发币", "Official-wallet-associated token launch"],
  official_token_lifecycle: ["关联代币状态变更", "Associated token lifecycle changed"],
  factory_config: ["Factory 参数变更", "Factory configuration changed"],
});
const clean = (value) => decodeAlertDisplayEntities(String(value ?? "")).replace(/\s+/g, " ").trim();
const literals = (value) => [...new Set(String(value || "").match(/0x[0-9a-f]{40,64}\b|https:\/\/[^\s<>]+|@[A-Za-z0-9_]{1,15}\b|\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+)+\b/g) || [])];

// Never cut an address/URL/technical identifier in half. Facts omitted from
// the compact narrative remain accessible through the exact official source.
function compactNarrative(value, maximum = 420) {
  const original = clean(value);
  if (original.length <= maximum) return original;
  let end = original.lastIndexOf(" ", maximum);
  if (end < maximum / 2) end = maximum;
  for (const literal of literals(original)) {
    const start = original.indexOf(literal);
    if (start < end && start + literal.length > end) end = start;
  }
  return `${original.slice(0, end).trim()}…`;
}

export function geniusAlertNarrative(event) {
  if (event.sourceId === "genius_x") return compactNarrative(event.tweet?.text);
  const summary = summarizeGeniusEvent(event);
  return summary.facts.map(item => item.zh).join("；") || "仅技术资料变更；未确认新功能";
}

function narrativeLines(event, language = "zh") {
  if (event.sourceId !== "genius_x") {
    const summary = summarizeGeniusEvent(event);
    const lines = summary.facts.map(item => compactGeniusText(item[language], 195));
    if (!lines.length) return [language === "zh" ? "仅技术资料变更；未确认新功能" : "Technical metadata only; no new feature established"];
    if (summary.omittedBusinessCount > 0) lines[lines.length - 1] = `${compactGeniusText(lines.at(-1), 150)}${language === "zh" ? "；完整变更见来源" : "; full changes in source"}`;
    return lines;
  }
  const narrative = geniusAlertNarrative(event);
  if (narrative.length <= 200) return [narrative];
  let end = narrative.lastIndexOf(" ", 200);
  if (end < 100) end = 200;
  for (const literal of literals(narrative)) {
    const start = narrative.indexOf(literal);
    if (start < end && start + literal.length > end) end = start;
  }
  return [narrative.slice(0, end).trim(), compactNarrative(narrative.slice(end).trim(), 200)].filter(Boolean);
}

function originalTime(event) {
  if (event.sourceOccurredAt || event.publishedAt || event.tweet?.createdAt) return event.sourceOccurredAt || event.publishedAt || event.tweet.createdAt;
  if (event.blockTimestamp != null) {
    const number = Number(event.blockTimestamp);
    if (Number.isFinite(number)) return new Date(number < 10_000_000_000 ? number * 1000 : number).toISOString();
  }
  return null;
}

function cst(value) {
  const time = Date.parse(String(value || ""));
  if (!Number.isFinite(time)) return "—";
  return new Date(time + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19) + " CST";
}

export function renderGeniusAlertLines(event, language = "zh", narrative = null, fallback = false) {
  const zh = language === "zh";
  const hasFallback = Array.isArray(fallback) ? fallback.some(Boolean) : fallback;
  const summary = summarizeGeniusEvent(event);
  const historical = isGeniusHistorical(event);
  const label = LABELS[event.kind]?.[zh ? 0 : 1] || (zh ? "官方更新" : "Official update");
  const sourceTime = originalTime(event);
  const mentioned = event.sourceId === "genius_x" && Array.isArray(event.mentionedAddresses) ? event.mentionedAddresses : [];
  const mentionOnly = event.token?.classification === "official_mentioned" || mentioned.length > 0;
  const denial = event.sourceId === "genius_x" && (event.disclaimsAffiliation === true
    || /\b(?:not\s+(?:affiliated|associated|our|official)|unaffiliated|did\s+not\s+(?:issue|launch)|didn['’]?t\s+(?:issue|launch))\b|不是官方|无关|非官方/i.test(event.tweet?.text || ""));
  const evidenceStatus = denial
    ? (zh ? "官方否认关联；不认定官方代币" : "Official denial of affiliation; not classified as an official token")
    : event.sourceId === "genius_x" && event.mediaOnly === true
    ? (zh ? "官方媒体帖；图片/视频内容未解析，请查看原帖" : "Official media post; image/video content not parsed, see original")
    : mentionOnly
    ? (zh ? "官方原文提及；代币归属未确认" : "Mentioned by official account; issuer unconfirmed")
    : event.token?.classification === "official_wallet_associated"
      ? (zh ? "链上官方地址关联；未认定官方测试币" : "On-chain official-wallet association; not classified as official test token")
      : event.sourceId === "genius_chain"
        ? (zh ? "双来源链上核验" : "Verified against two independent chain readers")
        : event.sourceId === "genius_x"
          ? (zh ? "数字账号身份及官方原帖核验" : "Numeric account identity and official post verified")
          : (zh ? "官方资料说明；不代表新部署已完成链上核验" : "Official documentation; new deployment is not yet chain-verified");
  const state = (historical ? (zh ? "历史记录补发现，非刚发行" : "Historical record discovered; not a new launch") : evidenceStatus)
    + (hasFallback ? (zh ? "；译文暂缺" : "; translation unavailable") : "");
  const observed = cst(event.observedAt);
  const narrativeRows = (narrative == null ? narrativeLines(event, language) : Array.isArray(narrative) ? narrative : [narrative]).slice(0, 3);
  const addresses = [...new Set([event.token?.address, ...mentioned, ...summary.addresses].filter(Boolean))];
  const factoryAddresses = new Set(summary.facts.filter(item => /(?:^|\.)factory(?:\.address)?$/iu.test(item.id)).flatMap(item => item.addresses));
  const factoryAddress = event.sourceId !== "genius_x" && addresses.length > 0 && addresses.every(address => factoryAddresses.has(address));
  const statusLine = `${zh ? "状态：" : "Status: "}${state}${historical && (denial || mentionOnly) ? (denial ? (zh ? "；官方否认关联" : "; official denial of affiliation") : (zh ? "；仅原文提及" : "; mention only")) : ""}`;
  return [
    `${zh ? "平台：" : "Platform: "}Genius.fun · ${label}`,
    ...narrativeRows.map((row, index) => `${index ? (zh ? "补充：" : "More: ") : (zh ? "具体变化：" : "Change: ")}${(Array.isArray(fallback) ? fallback[index] : fallback) ? (zh ? "原文 " : "Source ") : ""}${compactGeniusText(row, 205)}`),
    addresses.length
      ? `${factoryAddress ? (zh ? "工厂合约（不是代币）" : "Factory contract (not a token)") : "CA"} (${addresses.length}): ${addresses.slice(0, 2).join(" · ")}${addresses.length > 2 ? ` (+${addresses.length - 2})` : ""} · ${event.sourceId === "genius_x" ? (zh ? "链未核实" : "chain unverified") : "BNB Chain (56)"}`
      : `${zh ? "监控范围：" : "Scope: "}BNB Chain (56)`,
    ...(narrativeRows.length < 3 ? [statusLine] : []),
    `${zh ? "来源：" : "Source: "}${event.sourceUrl}`,
    `${zh ? "时间：" : "Time: "}${sourceTime ? `${cst(sourceTime)} · ${zh ? "发现" : "observed"} ${observed}` : `${zh ? "发现" : "observed"} ${observed}`}${narrativeRows.length === 3 ? ` · ${state}` : ""}`,
  ];
}

export async function buildGeniusAlertBundle(config, event, version) {
  if (!isGeniusOfficialEvent(event)) throw new TypeError("Invalid Genius official event");
  const summary = summarizeGeniusEvent(event);
  const narratives = narrativeLines(event, "zh");
  const narrative = narratives.join("\n");
  const terms = [...new Set(["Genius.fun", "GeniusTerminal", "GeniusFDN", "BNB Chain", ...literals(narrative)].filter(Boolean))];
  const disabled = config.alertChineseTranslationEnabled === false || config.alertForceLocalStructured === true;
  const options = {
    protectedTerms: terms,
    timeoutMs: Math.min(2_000, Math.max(1, Number(config.alertTranslationTimeoutMs) || 1_200)),
    fetchImpl: config.alertTranslationFetchImpl,
    endpoint: config.alertChineseTranslationUrl,
  };
  // Business facts are authored deterministically in both languages; only
  // observed source prose needs translation. Translation cannot invent facts.
  const prose = summary.isRawAnnouncement ? narratives : summary.facts.filter(item => item.rawText).map(item => compactGeniusText(item.rawText, 165));
  const sourceResults = !prose.length ? null : disabled
    ? ["zh-CN", "en"].map((language) => ({ status: "fallback_source", provider: "local_structured", latencyMs: 0, error: null,
      lines: prose, unavailable: language === "en" ? /[\u3400-\u9fff]/u.test(prose.join(" ")) : /\b[a-z]{3,}\b/i.test(prose.join(" ").replace(/0x[0-9a-f]+/gi, "")) }))
    : await Promise.all(["zh-CN", "en"].map((targetLanguage) => translateAlertLines(prose, { ...options, targetLanguage })));
  const results = ["zh", "en"].map((language, index) => {
    const result = sourceResults?.[index];
    if (!result) return { lines: narrativeLines(event, language), status: "not_needed", provider: "local_structured", latencyMs: 0, error: null, unavailable: false };
    if (summary.isRawAnnouncement) return result;
    let rawIndex = 0;
    const lines = summary.facts.map(item => item.rawText
      ? `${item.removed ? (language === "zh" ? "文档移除原文：" : "Removed source text: ") : (language === "zh" ? "文档新增原文：" : "Added source text: ")}${compactGeniusText(result.lines[rawIndex++] || item.rawText, 165)}`
      : item[language]);
    if (summary.omittedBusinessCount > 0) lines[lines.length - 1] = `${compactGeniusText(lines.at(-1), 150)}${language === "zh" ? "；完整变更见来源" : "; full changes in source"}`;
    return { ...result, lines };
  });
  const blocks = results.map((result, index) => ({
    text: renderGeniusAlertLines(event, index ? "en" : "zh", result.lines, summary.isRawAnnouncement
      ? result.unavailable ?? result.status.includes("fallback")
      : summary.facts.map(item => Boolean(item.rawText) && (result.unavailable ?? result.status.includes("fallback")))).join("\n"),
    status: result.status, provider: result.provider, latencyMs: result.latencyMs, error: result.error,
  }));
  return {
    version, format: "telegram_zh_en_genius_v2", eventType: event.type,
    sourceHash: createHash("sha256").update(JSON.stringify({ narrative, sourceUrl: event.sourceUrl, eventKey: event.eventKey })).digest("hex"),
    generatedAt: new Date().toISOString(), changeModel: null,
    focusModel: { eventType: event.type, priority: null, showPriority: false }, priority: null,
    zh: blocks[0], en: blocks[1],
  };
}
