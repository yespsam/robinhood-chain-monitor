import { createHash } from "node:crypto";
import { translateAlertLines } from "./chinese-localizer.js";
import { isGmgnFlowEvent } from "./gmgn-flow-signal.js";

const clean = (value) => String(value ?? "").replace(/\s+/gu, " ").trim();
const usd = (value) => `$${Number(value).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
const instant = (value) => new Date(Date.parse(value) + 8 * 3_600_000).toISOString().slice(5, 19).replace("T", " ") + " CST";
const protectedTerms = (text) => [...new Set(text.match(/0x[0-9a-f]{40,64}\b|https:\/\/[^\s<>]+|@[A-Za-z0-9_]{1,15}\b|[1-9A-HJ-NP-Za-km-z]{32,44}/giu) || [])];
function narrativeExcerpt(value) {
  const original = clean(value);
  if (original.length <= 160) return original;
  let end = 159;
  for (const literal of protectedTerms(original)) {
    const start = original.indexOf(literal);
    if (start < end && start + literal.length > end) end = start;
  }
  return `${original.slice(0, end).trim()}…`;
}

export function renderGmgnFlowAlertLines(event, language = "zh", narrative = event.narrative?.text, fallback = false) {
  const zh = language === "zh", s = event.signal, n = event.narrative;
  const label = n.status === "sourced" ? (zh ? "已绑定原帖" : "Source-linked")
    : n.status === "project_claim" ? (zh ? "项目自述，未独立证实" : "Project claim; unverified")
      : (zh ? "待核实" : "Unverified");
  const story = n.status === "unverified" ? (zh ? "未找到可按链和 CA 绑定的叙事出处" : "No narrative source bound to this chain and CA")
    : `${fallback ? (zh ? "原文（译文暂缺）：" : "Source (translation unavailable): ") : ""}${narrativeExcerpt(narrative)}`;
  return [
    `${zh ? "平台：" : "Platform: "}GMGN · ${event.chain.name} · ${clean(event.token.symbol || event.token.name || "Token")}`,
    `${zh ? "5 分钟成交：" : "5m volume: "}${usd(s.volumeUsd)} · ${s.volumeMultiple.toFixed(1)}× · ${zh ? "基线" : "baseline"} ${usd(s.baselineVolumeUsd)}`,
    `${zh ? "进入地址：高盈利 " : "Buyers: high-profit "}${s.highProfitCount} · FOMO ${s.fomoCount} · ${zh ? "去重" : "unique"} ${s.uniqueBuyerCount} (${zh ? "重叠" : "overlap"} ${s.overlapCount}) · ${zh ? "观测净买" : "observed net buy"} ${usd(s.netBuyUsd)}`,
    `CA: ${event.token.address}`,
    `${zh ? "叙事" : "Narrative"} [${label}]: ${story}`,
    `${zh ? "出处：" : "Source: "}${n.sourceUrl || event.source.url}`,
    `${zh ? "窗口：" : "Window: "}${instant(s.windowEndAt)} · ${zh ? "GMGN 数据；FOMO 为平台标签" : "GMGN-reported; FOMO is a provider tag"}${fallback ? (zh ? "；译文暂缺" : "; translation unavailable") : ""}`,
  ];
}

export async function buildGmgnFlowAlertBundle(config, event, version) {
  if (!isGmgnFlowEvent(event)) throw new TypeError("Invalid GMGN flow event");
  const original = narrativeExcerpt(event.narrative.text);
  const noStory = event.narrative.status === "unverified";
  const disabled = config.alertChineseTranslationEnabled === false || config.alertForceLocalStructured === true || noStory;
  const options = { protectedTerms: [event.token.address, event.token.symbol, ...protectedTerms(original)].filter(Boolean),
    timeoutMs: Math.min(1_200, Math.max(1, Number(config.alertTranslationTimeoutMs) || 1_200)),
    fetchImpl: config.alertTranslationFetchImpl, endpoint: config.alertChineseTranslationUrl };
  const results = disabled ? ["zh", "en"].map(language => ({ lines: [original], status: "not_needed", provider: "local_structured", latencyMs: 0, error: null,
    unavailable: !noStory && (language === "zh" ? /[a-z]{3,}/iu.test(original.replace(/0x[0-9a-f]+/giu, "")) : /[\u3400-\u9fff]/u.test(original)) }))
    : await Promise.all(["zh-CN", "en"].map(targetLanguage => translateAlertLines([original], { ...options, targetLanguage })));
  const blocks = results.map((result, i) => {
    const oversized = clean(result.lines.join(" ")).length > 160;
    const fallback = oversized || (result.unavailable ?? result.status.includes("fallback"));
    return { ...result, ...(oversized ? { status: "fallback_source", provider: "local_structured" } : {}),
      text: renderGmgnFlowAlertLines(event, i ? "en" : "zh", oversized ? original : result.lines.join(" "), fallback).join("\n") };
  });
  return { version, format: "telegram_zh_en_gmgn_flow_v1", eventType: event.type,
    sourceHash: createHash("sha256").update(JSON.stringify({ eventKey: event.eventKey, narrative: event.narrative })).digest("hex"),
    generatedAt: new Date().toISOString(), changeModel: null, priority: null,
    focusModel: { eventType: event.type, priority: null, showPriority: false }, zh: blocks[0], en: blocks[1] };
}
