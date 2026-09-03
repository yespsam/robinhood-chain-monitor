import { createHash } from "node:crypto";
import {
  collectTechnicalEventLiterals,
  decodeAlertDisplayEntities,
  translateAlertLines,
} from "./chinese-localizer.js";
import { deriveAlertChangeModel, renderAlertChangeLines } from "./alert-change-model.js";
import {
  interpretBinanceOfficialUpdate,
  interpretGithubWeb3Change,
  interpretPlatformPoolChange,
  interpretTwitterWeb3Update,
} from "./web3-alert-interpreter.js";
import { isTradingPriority, tradingPriorityForEvent } from "./trading-priority.js";

export const BILINGUAL_RENDER_VERSION = 19;
const MAX_CARD_LINES = 2;
const MAX_LINE_LENGTH = 230;
const MAX_DISPLAY_LINE_LENGTH = 138;
const MAX_TARGET_LINE_LENGTH = 118;
const MAX_TELEGRAM_NARRATIVE_LENGTH = 800;

const EVENT_TITLES = {
  bsc_launchpad_update: "BSC launchpad structural update",
  evm_launchpad_update: "Morph launchpad structural update",
  fomo_family_top_call: "FOMO BSC KOL first buy",
  fomo_monitor_health_update: "Fomo monitoring health transition",
  uniswap_official_update: "Uniswap official update",
  ai_official_update: "X / xAI / Grok official product update",
  platform_capability_update: "Official platform capability update",
  twitter_update: "Official X platform update",
  github_module_update: "Official GitHub module update",
  github_monitor_gap: "GitHub monitoring coverage gap",
  github_repository_discovered: "Official repository discovery",
  github_repository_verified: "GitHub repository verified",
  launchpad_site_update: "Official website capability update",
  binance_official_update: "Binance official update",
  pon_fun_update: "pon.fun official update",
  pons_v2_factory_discovered: "Pons v2 factory discovery",
  pons_v2_factory_status_update: "Pons v2 factory status update",
  early_activity_alert: "Early activity signal",
  official_activity: "Official address activity",
  token_launch: "Launchpad token event",
  contract_deployed: "Contract deployment",
  telegram_news_update: "Channel lead",
};

const EVENT_TITLES_ZH = {
  bsc_launchpad_update: "BSC 发射台结构更新",
  evm_launchpad_update: "Morph 发射台结构更新",
  fomo_family_top_call: "FOMO BSC KOL 首次买入",
  fomo_monitor_health_update: "Fomo 监控健康转场",
  uniswap_official_update: "Uniswap 官方更新",
  ai_official_update: "X / xAI / Grok 官方产品更新",
  platform_capability_update: "官方平台能力更新",
  twitter_update: "官方 X 平台更新",
  github_module_update: "官方 GitHub 模块更新",
  github_monitor_gap: "GitHub 监控覆盖缺口",
  github_repository_discovered: "发现官方代码仓库",
  github_repository_verified: "GitHub 仓库认证更新",
  launchpad_site_update: "发射台官网能力更新",
  binance_official_update: "Binance 官方更新",
  pon_fun_update: "pon.fun 官方更新",
  pons_v2_factory_discovered: "Pons v2 Factory 发现",
  pons_v2_factory_status_update: "Pons v2 Factory 状态更新",
  early_activity_alert: "早期量能信号",
  official_activity: "官方地址交易行为",
  token_launch: "发射台代币事件",
  contract_deployed: "合约部署",
  telegram_news_update: "频道线索",
};

function eventTitle(event, language = "en") {
  if (event?.type === "fomo_family_top_call" && event?.signalKind === "high_profit_high_winrate_wallet_buy") {
    return language === "zh" ? "高收益高胜率钱包买入" : "High-profit/high-win-rate wallet buy";
  }
  if (event?.type === "fomo_family_top_call" && event?.signalKind === "fomo_x_call") {
    return language === "zh" ? "Fomo 关联 KOL X 喊单" : "Fomo-linked KOL X call";
  }
  if (event?.type === "fomo_family_top_call" && event?.signalKind === "fomo_published_call") {
    return language === "zh" ? "Fomo 热门 KOL 平台喊单" : "Fomo KOL published Trade Thesis";
  }
  return language === "zh"
    ? EVENT_TITLES_ZH[event?.type] || "监控更新"
    : EVENT_TITLES[event?.type] || "Verified monitoring update";
}

function structuredDisplayParts(value, prefix = "", output = [], depth = 0) {
  if (output.length >= 6 || value == null || depth > 3) return output;
  if (["string", "number", "boolean", "bigint"].includes(typeof value)) {
    const rendered = String(value).replace(/\s+/g, " ").trim();
    if (rendered) output.push(prefix ? `${prefix}=${rendered}` : rendered);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      structuredDisplayParts(item, prefix, output, depth + 1);
      if (output.length >= 6) break;
    }
    return output;
  }
  if (typeof value !== "object") return output;
  for (const [key, item] of Object.entries(value).filter(([, item]) => item != null && item !== "")) {
    structuredDisplayParts(item, prefix ? `${prefix}.${key}` : key, output, depth + 1);
    if (output.length >= 6) break;
  }
  return output;
}

function replaceRawJsonPayload(value) {
  const source = String(value || "").trim();
  const starts = [source.indexOf("{"), source.indexOf("[")].filter((index) => index >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const candidate = source.slice(start).replace(/^```json\s*/i, "").replace(/```$/, "").trim();
    try {
      const parsed = JSON.parse(candidate);
      const facts = structuredDisplayParts(parsed);
      if (facts.length) return `${source.slice(0, start)}${facts.join(" · ")}`.trim();
    } catch {
      // Ordinary prose can contain braces. Only replace a complete JSON payload.
    }
  }
  return source;
}

function oneLine(value, maximum = MAX_LINE_LENGTH) {
  const line = replaceRawJsonPayload(decodeAlertDisplayEntities(value).replace(/\s+/g, " ").trim());
  if (line.length <= maximum) return line;
  const literals = technicalLiterals(line);
  const naturalCut = (limit) => {
    const window = line.slice(0, Math.max(1, limit));
    const minimum = Math.floor(limit * 0.55);
    const punctuation = [...window.matchAll(/[.!?。！？;；](?:\s|$)/g)].at(-1);
    if (punctuation && punctuation.index >= minimum) {
      return window.slice(0, punctuation.index + punctuation[0].trimEnd().length).trimEnd();
    }
    const boundary = Math.max(
      window.lastIndexOf(" "),
      window.lastIndexOf("，"),
      window.lastIndexOf(","),
      window.lastIndexOf("；"),
      window.lastIndexOf(";"),
    );
    return boundary >= minimum ? window.slice(0, boundary).trimEnd() : window.trimEnd();
  };
  let prefix = naturalCut(maximum - 1);
  let missing = literals.filter((literal) => !prefix.includes(literal));
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const suffix = missing.length ? ` · ${missing.join(" · ")}` : "";
    if (!suffix || suffix.length >= maximum - 24) break;
    const next = naturalCut(maximum - suffix.length - 1);
    if (next === prefix) break;
    prefix = next;
    missing = literals.filter((literal) => !prefix.includes(literal));
  }
  missing = literals.filter((literal) => !prefix.includes(literal));
  const suffix = missing.length ? ` · ${missing.join(" · ")}` : "";
  if (suffix.length < maximum - 24) {
    return `${prefix}…${suffix}`;
  }
  return `${prefix}…`;
}

function condenseCardLines(value, maximumLines = MAX_CARD_LINES) {
  const lines = String(value || "").split(/\r?\n/).map((line) => oneLine(line)).filter(Boolean);
  while (lines.length > maximumLines) {
    let best = null;
    for (let index = 1; index < lines.length - 2; index += 1) {
      const merged = `${lines[index]} · ${lines[index + 1]}`;
      if (merged.length > MAX_LINE_LENGTH) continue;
      if (!best || merged.length < best.merged.length) best = { index, merged };
    }
    if (!best) {
      const index = Math.max(1, lines.length - 3);
      best = { index, merged: oneLine(`${lines[index]} · ${lines[index + 1]}`) };
    }
    lines.splice(best.index, 2, best.merged);
  }
  return lines;
}

function normalizeTwoFieldLines(lines, language) {
  const values = list(lines)
    .map((line) => oneLine(line, 10_000))
    .filter(Boolean);
  const compacted = values.length <= MAX_CARD_LINES
    ? values.slice(0, MAX_CARD_LINES)
    : condenseCardLines(values.join("\n"), MAX_CARD_LINES);
  const zh = language === "zh";
  if (compacted[0]) {
    const platform = compacted[0].replace(/^(?:平台|Platform)[:：]\s*/iu, "");
    compacted[0] = `${zh ? "平台：" : "Platform: "}${platform}`;
  }
  if (compacted[1]) {
    const changed = compacted[1].replace(/^(?:更新了什么|What changed)[:：]\s*/iu, "");
    compacted[1] = `${zh ? "更新了什么：" : "What changed: "}${changed}`;
  }
  return compacted;
}

function protectedTerms(event) {
  const repositoryName = typeof event?.repository === "string" ? event.repository.split("/").filter(Boolean).at(-1) : null;
  const atom = (label, value) => value == null || value === "" ? null : `${label}=${value}`;
  return [
    event?.project?.name,
    event?.project?.id,
    event?.platform?.name,
    event?.platform?.id,
    event?.launchpad?.name,
    typeof event?.launchpad === "string" ? event.launchpad : null,
    event?.chain?.name,
    event?.chain?.slug,
    atom("chainId", event?.chain?.id ?? event?.chainId),
    event?.tokenSymbol,
    event?.repository,
    repositoryName,
    event?.repositoryMetadata?.fullName,
    event?.commit,
    event?.transactionHash,
    event?.signal?.transactionHash,
    event?.contract,
    event?.token,
    event?.signal?.tokenAddress,
    event?.factory,
    event?.launcher,
    event?.walletAddress,
    event?.selector,
    event?.entrySelector,
    atom("templateId", event?.templateId),
    atom("presetId", event?.presetId),
    atom("poolId", event?.poolId),
    event?.launchAt,
    event?.launchTime,
    event?.tradingStartsAt,
    event?.listingAt,
    event?.callId,
    event?.stableId,
    atom("tokenVersion", event?.tokenVersion),
    atom("modeId", event?.mode?.id),
    atom("templateId", event?.mode?.templateId),
    atom("presetId", event?.mode?.presetId),
    atom("modeId", event?.signal?.modeId),
    atom("tokenVersion", event?.signal?.tokenVersion),
    bscModeFacts(event)?.name,
    event?.tokens?.[0]?.metadata?.name,
    event?.tokens?.[0]?.metadata?.symbol,
    securityDecision(event) ? `security=${securityDecision(event)}` : null,
    typeof event?.security?.metrics?.liquidityConfirmed === "boolean"
      ? `liquidityConfirmed=${event.security.metrics.liquidityConfirmed}`
      : null,
    event?.caller?.handle ? `@${event.caller.handle}` : null,
    event?.tweet?.handle ? `@${event.tweet.handle}` : null,
    event?.type === "telegram_news_update" ? telegramNewsSourceMarker(event) : null,
    hooklistRegistryFacts(event)?.hookName,
    githubRepresentativeFile(event),
    ...collectTechnicalEventLiterals(event),
    "Factory", "VaultFactory", "Hook", "CREATE", "CREATE2", "BSC", "BNB", "GMGN", "Fomo", "Flap", "Four.Meme", "Uniswap", "Robinhood",
    "Binance Wallet", "Binance Charity", "Giggle", "Giggle Academy", "Trade Thesis", "TaxToken9",
  ]
    .map((value) => String(value || "").trim())
    // A bare scalar such as version=1 collected as just `1` can replace every
    // digit in an amount or date with a translation marker. Numeric semantics
    // are validated separately; protect only contextual technical atoms.
    .filter((value) => value.length >= 2 && !/^[+-]?\d+(?:[.,]\d+)*$/u.test(value));
}

function technicalNumericLiterals(value) {
  const source = String(value || "");
  const pattern = /\b(?:chain|network|protocol|template|preset|pool)[._\s-]*id\b\s*(?::|=|#)?\s*["']?(\d{1,15})\b/gi;
  return [...source.matchAll(pattern)].map((match) => match[1]);
}

function technicalLiterals(value) {
  const source = String(value || "");
  const slashLiterals = (source.match(/\b[A-Za-z][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)+\b/g) || [])
    .filter((literal) => {
      const parts = literal.split("/");
      return parts.length >= 3
        || /^(?:src|lib|test|tests|docs|api|packages?|apps?|deploy)\//i.test(literal)
        || literal.includes("-")
        || /\.[a-z0-9]{1,8}$/i.test(parts.at(-1) || "");
    });
  const hexadecimalLiterals = (source.match(/\b[a-fA-F0-9]{7,40}\b/g) || [])
    .filter((literal) => /[a-f]/i.test(literal) && /\d/.test(literal));
  const patterns = [
    /https?:\/\/[^\s<>"']+/gi,
    /\b0x[a-fA-F0-9]{8,}\b/g,
    /@[A-Za-z0-9_]{1,15}\b/g,
    /#[A-Za-z][A-Za-z0-9_]{1,63}\b/g,
    /\$[A-Z][A-Z0-9]{1,11}\b/g,
    /\bv\d+(?:\.\d+){0,3}(?:-[A-Za-z0-9.-]+)?\b/gi,
    /\b\d+\.\d+\.\d+(?:\.\d+)?(?:-[A-Za-z0-9.-]+)?\b/g,
    /\b[A-Za-z_$][A-Za-z0-9_$]*\s*\(\)/g,
    /\b[A-Za-z_$][A-Za-z0-9_$]*(?=\s*\()/g,
  ];
  const literals = [...new Set([
    ...patterns.flatMap((pattern) => source.match(pattern) || []),
    ...hexadecimalLiterals,
    ...slashLiterals,
    ...technicalNumericLiterals(source),
  ])]
    .sort((left, right) => right.length - left.length);
  return literals.filter((literal, index) => !literals.slice(0, index).some((parent) => parent.includes(literal)));
}

function requiredTechnicalLiterals(baseLines, event) {
  const technicalSource = baseLines.flatMap((line) => String(line).split(/｜|\s\|\s/u))
    .filter((part) => !/^(?:交易|Trade)[:=：]/u.test(part.trim()))
    .join("\n");
  const chainControlledProseValues = new Set([
    bscModeFacts(event)?.name,
    event?.tokens?.[0]?.metadata?.name,
  ].filter(Boolean).map(String));
  // An ERC-20 name immediately followed by `(SYMBOL)` resembles a function call
  // to the generic literal detector. Names and human-readable mode labels are
  // untrusted display prose and may be shortened; the symbol itself remains an
  // exact protected identifier.
  const technical = technicalLiterals(technicalSource).filter((literal) => !chainControlledProseValues.has(literal));
  const occursAsDisplayedValue = (literal) => {
    if (!/^\d+$/u.test(literal)) return technicalSource.includes(literal);
    return new RegExp(`(?<![A-Za-z0-9])${literal}(?![A-Za-z0-9])`, "u").test(technicalSource);
  };
  const candidates = [...new Set([
    ...technical,
    ...protectedTerms(event)
      .map(String)
      // Token/mode display names are chain-controlled prose, not stable
      // technical identifiers. URLs, repositories, addresses and other
      // detected technical literals remain byte-exact regardless of length.
      .filter((literal) => !chainControlledProseValues.has(literal))
      .filter((literal) => literal.length <= 80 || technical.includes(literal))
      .filter(occursAsDisplayedValue),
  ])].sort((left, right) => right.length - left.length);
  // A chain id such as `56` can occur accidentally inside a selector. Keep the
  // enclosing exact identifier once instead of re-appending nested fragments.
  return candidates.filter((literal, index) => !candidates.slice(0, index).some((parent) => parent.includes(literal)));
}

function ensureTechnicalLiterals(lines, required, language) {
  const compacted = normalizeTwoFieldLines(lines, language);
  const current = compacted.join("\n");
  const missing = required.filter((literal) => !current.includes(literal));
  if (!missing.length) return compacted;

  // The two-field layout keeps every identifier inside "What changed". Never
  // spill a CA, tx hash, endpoint or function name into the platform field.
  const referenceIndex = compacted.length > 1 ? 1 : 0;
  const label = language === "zh" ? "标识" : "ID";
  for (const literal of missing) {
    const targets = [referenceIndex].filter((index) => index < compacted.length);
    let placed = false;
    for (const index of targets) {
      const hasLabel = new RegExp(`(?:${label}|来源|Source)[:：]`, "i").test(compacted[index]);
      const suffix = hasLabel ? ` · ${literal}` : ` · ${label}: ${literal}`;
      if (`${compacted[index]}${suffix}`.length > MAX_LINE_LENGTH) continue;
      compacted[index] += suffix;
      placed = true;
      break;
    }
    if (!placed) compacted[referenceIndex] += ` · ${literal}`;
  }
  return compacted;
}

function eventProject(event) {
  return event?.platform?.name || event?.project?.name || event?.launchpad?.name
    || (typeof event?.launchpad === "string" ? event.launchpad : null) || null;
}

function rawEnglishNarrative(event) {
  const candidates = [
    event?.thesis?.text,
    event?.body,
    event?.signal?.headline,
    event?.title,
    event?.message,
    event?.tweet?.text,
    event?.summary,
    event?.description,
    event?.repositoryMetadata?.description,
    event?.mode?.template?.description,
    event?.launchpad?.model,
  ];
  return candidates.map((value) => oneLine(value, 210)).find((value) => (value.match(/[A-Za-z][A-Za-z'-]*/g) || []).join("").length >= 8) || null;
}

function eventTime(event) {
  return event?.publishedAt || event?.timestamp || event?.blockTimestamp || event?.tweet?.createdAt
    || event?.committedAt
    || (event?.type === "platform_capability_update" ? event?.sourceOccurredAt : null)
    || event?.observedAt || event?.alertQueuedAt || null;
}

function telegramNewsUsername(event) {
  const candidates = [
    event?.channel?.username,
    event?.username,
    event?.source?.username,
    event?.source?.handle,
  ];
  try {
    const url = new URL(String(event?.messageUrl || ""));
    if (["t.me", "www.t.me", "telegram.me", "www.telegram.me"].includes(url.hostname.toLowerCase())) {
      const parts = url.pathname.split("/").filter(Boolean);
      candidates.push(parts[0] === "s" ? parts[1] : parts[0]);
    }
  } catch {
    // A malformed URL cannot become source evidence.
  }
  for (const candidate of candidates) {
    const username = String(candidate || "").replace(/^@/, "").trim();
    if (/^[A-Za-z0-9_]{1,32}$/.test(username)) return username;
  }
  return "maxguruai";
}

function telegramNewsMessageId(event) {
  const candidates = [event?.messageId, event?.telegram?.messageId, event?.source?.messageId];
  try {
    const url = new URL(String(event?.messageUrl || ""));
    candidates.push(url.pathname.split("/").filter(Boolean).at(-1));
  } catch {
    // Ignore malformed URLs and show an honest unavailable marker below.
  }
  return candidates.map((value) => String(value ?? "").trim()).find((value) => /^\d+$/.test(value)) || "unknown";
}

function telegramNewsSourceMarker(event) {
  return `@${telegramNewsUsername(event)}#${telegramNewsMessageId(event)}`;
}

function telegramNewsCategoryLabel(value, language = "zh") {
  const source = oneLine(value, 42);
  const key = source.toLowerCase().replace(/[\s_-]+/g, " ").trim();
  const labels = {
    governance: ["治理", "Governance"],
    security: ["安全", "Security"],
    ai: ["AI", "AI"],
    macro: ["宏观", "Macro"],
    market: ["市场", "Market"],
    funding: ["融资", "Funding"],
    product: ["产品", "Product"],
    listing: ["上币/下架", "Listing/delisting"],
    protocol: ["协议", "Protocol"],
    "协议更新": ["协议更新", "Protocol update"],
    "ai agent": ["AI Agent", "AI Agent"],
  };
  const mapped = labels[key];
  if (mapped) return mapped[language === "zh" ? 0 : 1];
  if (!source) return language === "zh" ? "未分类" : "Unclassified";
  if (language === "en" && /[\u3400-\u9fff]/u.test(source)) return "Unclassified";
  return source;
}

function dominantNarrativeLanguage(...values) {
  const source = values.flat().map((value) => String(value || "")).join(" ");
  const chinese = (source.match(/[\u3400-\u9fff]/g) || []).length;
  const latin = (source.match(/[A-Za-z]/g) || []).length;
  if (chinese >= 2 && chinese >= Math.max(2, Math.floor(latin * 0.18))) return "zh";
  if (latin >= 4) return "en";
  return chinese ? "zh" : "en";
}

function publishedFomoCallDetails(event) {
  if (event?.type !== "fomo_family_top_call"
    || !["fomo_published_call", "fomo_x_call"].includes(event?.signalKind)) return null;
  const rawSource = event?.thesis?.text || event?.body;
  const source = oneLine(rawSource, 112);
  if (!source) return null;
  const sourceLanguage = dominantNarrativeLanguage(source);
  const target = [event?.tokenSymbol, event?.marketSymbol, event?.symbol, event?.token, event?.contractAddress]
    .map((value) => String(value || "").trim())
    .find(Boolean) || null;
  return {
    source,
    sourceLanguage,
    target,
    sourceField: event?.thesis?.text ? "thesis.text" : "body",
    zh: sourceLanguage === "zh" ? `观点：${source}` : `英文原文：${source}`,
    en: sourceLanguage === "en" ? `Thesis: ${source}` : `Chinese original: ${source}`,
  };
}

function telegramNewsFacts(event, language = "zh") {
  const zh = language === "zh";
  const headline = oneLine(event?.news?.headline, MAX_TELEGRAM_NARRATIVE_LENGTH)
    || (zh ? "标题未取得" : "Headline unavailable");
  const summary = oneLine(event?.news?.summary, MAX_TELEGRAM_NARRATIVE_LENGTH);
  return {
    category: telegramNewsCategoryLabel(event?.news?.category, language),
    headline,
    summary: summary && summary !== headline
      ? summary
      : (zh ? "暂无独立摘要" : "No separate summary"),
    sourceMarker: telegramNewsSourceMarker(event),
  };
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function factValue(value) {
  if (value === null || value === undefined || value === "") return "not set";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (["string", "number", "bigint"].includes(typeof value)) return oneLine(value, 90);
  return oneLine(value?.name || value?.symbol || value?.id || value?.address || value?.version || "unresolved", 90);
}

function chainFactLabel(change) {
  const chain = change?.after || change || {};
  const name = chain.name || change?.name || chain.slug || chain.id || "Chain";
  const chainId = chain.chainId ?? chain.id ?? change?.chainId;
  const environment = chain.environment ? ` ${chain.environment}` : "";
  return `${name}${environment}${chainId && /^\d+$/.test(String(chainId)) ? ` (Chain ID ${chainId})` : ""}`;
}

function leafTransitions(before, after, prefix = "", output = []) {
  if (output.length >= 4) return output;
  const beforeObject = before && typeof before === "object" && !Array.isArray(before);
  const afterObject = after && typeof after === "object" && !Array.isArray(after);
  if (beforeObject || afterObject) {
    const keys = new Set([...Object.keys(beforeObject ? before : {}), ...Object.keys(afterObject ? after : {})]);
    for (const key of keys) {
      leafTransitions(beforeObject ? before[key] : undefined, afterObject ? after[key] : undefined, prefix ? `${prefix}.${key}` : key, output);
      if (output.length >= 4) break;
    }
    return output;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    output.push(`${prefix || "value"} ${factValue(before)}→${factValue(after)}`);
  }
  return output;
}

function structuredModules(event) {
  const changes = event?.changes || {};
  const added = [
    ...list(changes.newModules),
    ...list(changes.newPackages).map((item) => `${item?.name || "package"}${item?.version ? `@${item.version}` : ""}`),
    ...list(changes.newProtocols).map((item) => `${item?.name || "protocol"}${item?.protocol ? ` ${item.chainId || "?"}/${item.protocol}` : ""}`),
    event?.module?.name || event?.module?.id,
    event?.mode?.officialName,
  ].filter(Boolean).map(factValue);
  const removed = list(changes.removedModules).filter(Boolean).map(factValue);
  const parts = [];
  if (added.length) parts.push(`added ${[...new Set(added)].slice(0, 3).join(" · ")}`);
  if (removed.length) parts.push(`removed ${[...new Set(removed)].slice(0, 3).join(" · ")}`);
  return parts;
}

function flapQuotePairDetails(event) {
  const platform = String(event?.platform?.id || event?.project?.id || "").toLowerCase();
  if (platform !== "flap") return null;
  const signal = event?.signal?.quotePairChange;
  const pools = [
    ...list(event?.changes?.newFlapPools),
    ...list(event?.changes?.updatedFlapPools),
    ...list(event?.changes?.flapPoolChanges).map((change) => change?.after || change),
  ].filter((pool) => pool?.kind === "quote_asset");
  if (signal?.assetClass !== "bstock_quote" && !pools.length) return null;
  const rawAssets = [
    ...list(signal?.assets),
    ...pools.map((pool) => ({
      symbol: pool?.quoteSymbol,
      name: pool?.quoteName,
      address: pool?.quoteAddress,
      chainId: pool?.chainId,
      classification: pool?.quoteClassification,
      tags: pool?.quoteTags,
    })),
  ];
  const assets = [];
  const seen = new Set();
  for (const asset of rawAssets) {
    const symbol = String(asset?.symbol || "").trim();
    const address = String(asset?.address || "").trim();
    const identity = symbol.toLowerCase() || address.toLowerCase();
    if (!identity || seen.has(identity)) continue;
    seen.add(identity);
    assets.push({
      symbol: symbol || null,
      name: String(asset?.name || "").replace(/\s+/g, " ").trim() || null,
      address: /^0x[a-fA-F0-9]{40}$/.test(address) ? address : null,
      chainId: Number.isSafeInteger(Number(asset?.chainId)) ? Number(asset.chainId) : null,
      bstock: signal?.assetClass === "bstock_quote"
        || /(?:bstock|stock|equity|ETF|证券|股票)/iu.test([
          asset?.classification,
          asset?.name,
          ...(Array.isArray(asset?.tags) ? asset.tags : []),
        ].filter(Boolean).join(" ")),
    });
  }
  if (!assets.length) return null;
  const onchain = Boolean(event?.transactionHash || event?.onchainProof || event?.receiptProof);
  const stage = ["announced", "live", "observed"].includes(signal?.stage)
    ? signal.stage
    : pools.length > 0 && !onchain ? "observed"
      : pools.some((pool) => pool?.quoteSymbol) ? "live" : "observed";
  const delayedRecovery = event?.type === "platform_capability_update"
    && event?.kind === "flap_quote_asset_enabled"
    && event?.delayedRecovery?.version === 1
    && event.delayedRecovery?.reason === "monitoring_gap_recovery";
  const firstObservedAfterGap = event?.type === "platform_capability_update"
    && event?.kind === "flap_quote_asset_first_observed_after_gap"
    && event?.changeType === "observed"
    && stage === "observed"
    && event?.delayedRecovery?.version === 1
    && event.delayedRecovery?.reason === "first_observed_after_gap";
  return {
    assets: assets.slice(0, 8),
    stage,
    bstock: assets.some((asset) => asset.bstock),
    onchain,
    board: pools.length > 0,
    delayedRecovery,
    firstObservedAfterGap,
    boardMetadataDelayed: stage === "observed"
      && pools.length > 0
      && event?.tradingPriority?.tier === "T2",
    recovery: delayedRecovery || firstObservedAfterGap,
    recoveryLagMs: event?.delayedRecovery?.lagMs,
    deliveryLagMs: event?.freshness?.deliveryLagMs,
    deliveryEvaluatedAt: event?.freshness?.deliveryEvaluatedAt,
  };
}

function flapTrackedTokenRevisionDetails(event, ordinal, token, generation) {
  const revision = event?.canonicalRevision;
  if (revision == null) return null;
  const keys = [
    "version", "reason", "ordinal", "replacesEventKey", "replacesBlockHash",
    "replacesTokenAddress",
  ];
  if (typeof revision !== "object"
    || Array.isArray(revision)
    || Object.keys(revision).length !== keys.length
    || !keys.every((key) => Object.prototype.hasOwnProperty.call(revision, key))) return false;
  const prefix = `bsc-flap-pool-token:${generation}:${ordinal}:`;
  const replacesEventKey = String(revision.replacesEventKey || "");
  const replacedTail = replacesEventKey.startsWith(prefix) ? replacesEventKey.slice(prefix.length) : "";
  const replacedCandidate = /^(0x[a-f0-9]{64}):(0|[1-9]\d*):(0x[a-f0-9]{40})(?::canonical-revision:(0x[a-f0-9]{64}))?$/.exec(replacedTail);
  const blockHash = String(event?.blockHash || "").toLowerCase();
  const eventKeyBase = `${prefix}${String(event?.transactionHash || "").toLowerCase()}:${Number(event?.logIndex)}:${token.toLowerCase()}`;
  if (revision.version !== 1
    || revision.reason !== "token_created_reorg"
    || Number(revision.ordinal) !== ordinal
    || !replacedCandidate
    || replacedCandidate[3] !== String(revision.replacesTokenAddress || "").toLowerCase()
    || !/^0x[a-f0-9]{64}$/.test(String(revision.replacesBlockHash || "").toLowerCase())
    || (replacedCandidate[4]
      && replacedCandidate[4] !== String(revision.replacesBlockHash).toLowerCase())
    || String(revision.replacesBlockHash).toLowerCase() === blockHash
    || !/^0x[a-f0-9]{64}$/.test(blockHash)
    || event?.eventKey !== `${eventKeyBase}:canonical-revision:${blockHash}`) return false;
  return {
    replacesTokenAddress: String(revision.replacesTokenAddress).toLowerCase(),
    replacesBlockHash: String(revision.replacesBlockHash).toLowerCase(),
    newBlockHash: blockHash,
  };
}

function flapTrackedPoolTokenDetails(event) {
  const platform = String(event?.platform?.id || event?.featurePlatform || "").toLowerCase();
  const ordinal = Number(event?.featureTokenOrdinal);
  const target = Number(event?.featureTokenTarget);
  const tokenEntry = event?.tokens?.[0] || {};
  const token = String(tokenEntry?.token || "").trim();
  const quoteAsset = String(event?.mode?.quoteAsset || "").trim();
  const quoteSymbol = String(event?.mode?.quoteSymbol || "").replace(/\s+/g, " ").trim();
  const quoteName = String(event?.mode?.quoteName || "").replace(/\s+/g, " ").trim();
  const rawGeneration = event?.featureGenerationKey
    ?? event?.generation
    ?? event?.generationKey
    ?? event?.featureTokenGeneration
    ?? event?.featureActivationGeneration;
  if (event?.type !== "bsc_launchpad_update"
    || event?.kind !== "flap_pool_token"
    || event?.featureTrackedToken !== true
    || platform !== "flap"
    || String(event?.platform?.trust || "").toLowerCase() !== "official_verified"
    || !Number.isSafeInteger(ordinal) || ordinal < 1 || ordinal > 3
    || target !== 3
    || !/^0x[a-fA-F0-9]{40}$/.test(token)
    || !/^0x[a-fA-F0-9]{40}$/.test(quoteAsset)
    || !quoteSymbol
    || !String(event?.featureActivationKey || "").trim()
    || rawGeneration == null || !String(rawGeneration).trim()
    || String(event.featureActivationKey).trim() !== String(rawGeneration).trim()
    || event?.informationalOnly !== true
    || event?.autoTradeEligible !== false
    || event?.automaticExecution !== false) return null;
  const revision = flapTrackedTokenRevisionDetails(event, ordinal, token, String(rawGeneration).trim());
  if (revision === false) return null;
  const metadata = tokenEntry?.metadata || {};
  const name = String(metadata?.name || "").replace(/\s+/g, " ").trim();
  const symbol = String(metadata?.symbol || "").replace(/\s+/g, " ").trim();
  const label = name && symbol && name.toLowerCase() !== symbol.toLowerCase()
    ? `${name} (${symbol})`
    : name || symbol || null;
  const security = ["pass", "block"].includes(String(event?.security?.decision || "").toLowerCase())
    ? String(event.security.decision).toLowerCase()
    : "unknown";
  const producerDelayedRecovery = event?.delayedRecovery?.version === 1
    && event.delayedRecovery.reason === "verified_generation_archive_catch_up"
    && event.delayedRecovery.continuousCoverage === true;
  const deliveryLagMs = Number(event?.freshness?.deliveryLagMs);
  const realtimeMaxAgeMs = Number(event?.freshness?.realtimeMaxAgeMs);
  const delayedDelivery = ["late", "suppress"].includes(event?.freshness?.deliveryDecision)
    && Number.isFinite(deliveryLagMs)
    && Number.isFinite(realtimeMaxAgeMs)
    && deliveryLagMs > realtimeMaxAgeMs;
  return {
    ordinal,
    target,
    token,
    tokenLabel: label ? oneLine(label, 64) : null,
    quoteAsset,
    quoteSymbol: oneLine(quoteSymbol, 32),
    quoteName: quoteName ? oneLine(quoteName, 64) : null,
    security,
    canonicalRevision: revision,
    delayKind: delayedDelivery ? "delivery" : producerDelayedRecovery ? "recovery" : null,
  };
}

function renderFlapTrackedPoolTokenLines(focusModel, language = "zh") {
  const details = focusModel?.flapTrackedToken;
  if (!details) return null;
  const zh = language === "zh";
  const tokenLabel = details.tokenLabel || (zh ? "未命名代币" : "Unnamed token");
  const safetyDecision = details.security === "pass"
    ? (zh
        ? "观察；静态初筛通过，可卖性仍待验证"
        : "Watch; static screening passed; sellability still unverified")
    : details.security === "block"
      ? (zh ? "⛔ 不买；安全门已拦截" : "⛔ Do not buy; safety gate blocked")
      : (zh ? "安全未完成｜不买" : "Safety incomplete | do not buy");
  const delayPrefix = details.delayKind === "delivery"
    ? (zh ? "延迟送达｜勿追价" : "Delayed delivery | do not chase")
    : details.delayKind === "recovery"
      ? (zh ? "延迟补报｜勿追价" : "Delayed recovery | do not chase")
      : null;
  const decision = details.canonicalRevision
    ? (zh
        ? "链重组修订｜以本条 CA 为准｜不买"
        : "Chain-reorg revision | use this CA as canonical | do not buy")
    : delayPrefix
      ? `${delayPrefix}${zh ? "｜" : " | "}${safetyDecision}`
      : safetyDecision;
  const time = localizedCstTime(focusModel?.time?.[language], language);
  return zh
    ? [
        `平台：Flap｜${details.quoteSymbol} 底池｜第 ${details.ordinal}/${details.target} 个代币`,
        `代币：${tokenLabel}｜CA ${details.token}`,
        `结论：${decision}`,
        `确认：官方 TokenCreated + ${details.quoteSymbol} 配对`,
        `风险/时间：${details.delayKind ? "勿追价｜" : ""}非自动交易｜${time}`,
      ]
    : [
        `Platform: Flap | ${details.quoteSymbol} pool | Token ${details.ordinal}/${details.target}`,
        `Token: ${tokenLabel} | CA ${details.token}`,
        `Decision: ${decision}`,
        `Proof: Official TokenCreated + ${details.quoteSymbol} pair`,
        `Risk/Time: ${details.delayKind ? "Do not chase | " : ""}No automatic trading | ${time}`,
      ];
}

function structuredPoolFacts(event, language = "en") {
  const changes = event?.changes || {};
  const zh = language === "zh";
  const output = [];
  const render = (pool, label) => {
    const category = factValue(pool?.category || pool?.vaultFactoryCategory || pool?.poolCategory || pool?.poolType || "quote");
    const factory = pool?.factoryAddress || pool?.factory?.address || pool?.vaultFactoryAddress
      || pool?.vaultFactory?.address || pool?.vaultFactory || pool?.factory;
    const quote = pool?.quoteAddress || pool?.quoteTokenAddress || pool?.quoteAssetAddress
      || pool?.quoteToken?.address || pool?.quoteAsset?.address || pool?.quoteAsset || pool?.quoteToken;
    const quoteSymbol = String(pool?.quoteSymbol || pool?.quoteToken?.symbol || "").trim();
    const quoteName = String(pool?.quoteName || pool?.quoteToken?.name || "").replace(/\s+/g, " ").trim();
    const quoteLabel = [quoteSymbol, quoteName].filter(Boolean).join(" · ");
    output.push(`${label}: ${category}${quoteLabel ? ` · ${factValue(quoteLabel)}` : ""}${factory ? ` · Factory ${factValue(factory)}` : ""}${quote ? ` · Quote ${factValue(quote)}` : ""}`);
  };
  for (const pool of list(changes.newFlapPools).slice(0, 2)) render(pool, zh ? "新增底池" : "New pool");
  for (const change of list(changes.flapPoolChanges).slice(0, Math.max(0, 2 - output.length))) {
    const before = change?.before || {};
    const after = change?.after || change || {};
    const category = factValue(after?.category || after?.vaultFactoryCategory || after?.poolCategory || after?.poolType || "quote");
    const factory = after?.factoryAddress || after?.factory?.address || after?.vaultFactoryAddress
      || after?.vaultFactory?.address || after?.vaultFactory || after?.factory;
    const quoteOf = (pool) => pool?.quoteAddress || pool?.quoteTokenAddress || pool?.quoteAssetAddress
      || pool?.quoteToken?.address || pool?.quoteAsset?.address || pool?.quoteAsset || pool?.quoteToken;
    const beforeQuote = quoteOf(before);
    const afterQuote = quoteOf(after);
    if (beforeQuote && afterQuote && String(beforeQuote) !== String(afterQuote)) {
      output.push(`${zh ? "底池更新" : "Pool update"}: ${category}${factory ? ` · Factory ${factValue(factory)}` : ""} · Quote ${factValue(beforeQuote)}→${factValue(afterQuote)}`);
    } else {
      render(after, zh ? "底池更新" : "Pool update");
    }
  }
  return output;
}

function structuredRepositoryFacts(event) {
  if (!event?.repository) return [];
  const output = [`Repository: ${event.repository}`];
  const description = repositoryPurpose(event);
  if (description) output.push(`Purpose: ${oneLine(description, 170)}`);
  return output;
}

function structuredLaunchFacts(event) {
  if (!["bsc_launchpad_update", "evm_launchpad_update"].includes(event?.type)) return [];
  const output = [];
  const mode = event?.mode?.componentMode || event?.mode?.officialName || event?.mode?.selectorName || event?.mode?.selector;
  const token = event?.tokens?.[0] || {};
  const metadata = token?.metadata || {};
  if (mode) output.push(`Mode: ${factValue(mode)}`);
  if (token?.token) {
    const label = [metadata.name, metadata.symbol ? `(${metadata.symbol})` : null].filter(Boolean).join(" ") || "first verified sample";
    const tracked = flapTrackedPoolTokenDetails(event);
    output.push(tracked
      ? `Token ${tracked.ordinal}/${tracked.target}: ${label} · CA ${token.token}`
      : `First token: ${label} · CA ${token.token}`);
  }
  const decision = event?.security?.decision;
  if (decision === "pass") output.push("Safety: local contract and trading gates passed; not a buy recommendation.");
  if (decision === "block") output.push(`Safety: blocked by local gates${list(event?.security?.reasons).length ? ` · ${list(event.security.reasons).slice(0, 2).join(" · ")}` : ""}.`);
  return output;
}

function structuredTransitions(event) {
  const changes = event?.changes || {};
  const transitions = [];
  for (const change of list(changes.packageVersionChanges)) {
    transitions.push(`${change?.name || "package"} ${factValue(change?.fromVersion)}→${factValue(change?.toVersion)}`);
  }
  for (const change of list(changes.chainStageChanges)) {
    transitions.push(`${chainFactLabel(change)} status ${factValue(change?.fromStage)}→${factValue(change?.toStage)}`);
  }
  for (const change of list(changes.quoteConfigChanges)) {
    transitions.push(...leafTransitions(change?.before, change?.after, change?.symbol || "quote"));
  }
  const handled = new Set(["packageVersionChanges", "chainStageChanges", "quoteConfigChanges"]);
  for (const [key, change] of Object.entries(changes)) {
    if (handled.has(key) || !change || Array.isArray(change) || typeof change !== "object") continue;
    if (Object.hasOwn(change, "before") || Object.hasOwn(change, "after")) {
      transitions.push(`${key} ${factValue(change.before)}→${factValue(change.after)}`);
    }
  }
  for (const change of [...list(event?.signal?.keyChanges), ...list(event?.keyChanges)]) {
    if (!change || typeof change !== "object" || (!Object.hasOwn(change, "before") && !Object.hasOwn(change, "after"))) continue;
    transitions.push(`${factValue(change.subject || change.field || "value")} ${factValue(change.before)}→${factValue(change.after)}`);
  }
  return [...new Set(transitions)].slice(0, 4);
}

function structuredAddresses(event) {
  const addresses = [];
  const visited = new WeakSet();
  const visit = (value) => {
    if (typeof value === "string") {
      addresses.push(...(value.match(/\b0x[a-fA-F0-9]{40}\b/g) || []));
      return;
    }
    if (!value || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    for (const nested of Object.values(value)) visit(nested);
  };
  if (event?.type === "platform_capability_update") {
    // Capability events retain full previous/current snapshots for durable
    // comparison. Those historical addresses are not part of the update and
    // made compact fallback cards list unrelated contracts. Only render the
    // actual diff plus explicit top-level evidence addresses.
    visit(event.changes);
    visit({
      contract: event.contract,
      factory: event.factory,
      launcher: event.launcher,
      pool: event.pool,
      mode: event.mode,
    });
  } else {
    visit(event);
  }
  return [...new Set(addresses)].slice(0, 4);
}

function officialSourceKind(event) {
  const source = [...list(event?.sources), event?.source?.name, event?.source?.id, event?.source, event?.url]
    .filter((value) => typeof value === "string").join(" ").toLowerCase();
  if (/github\.com|githubusercontent\.com/.test(source)) return "Official GitHub source";
  if (/\/api\/|meme-api|graphql/.test(source)) return "Official API";
  if (/docs?\.|gitbook|\/docs?(?:\/|$)/.test(source)) return "Official documentation";
  return "Official monitored source";
}

function structuredStatus(event, language = "en") {
  const zh = language === "zh";
  if (event?.type === "platform_capability_update") {
    const deployed = list(event?.changes?.chainStageChanges).some((item) => item?.toStage === "deployed")
      || list(event?.changes?.newChains).some((item) => item?.stage === "deployed");
    if (deployed) return zh
      ? "官方来源记录为已部署；链上入口尚未独立核验。"
      : `${officialSourceKind(event)} reports deployed; the on-chain entry is not independently verified.`;
    if (list(event?.changes?.newContracts).length) return zh
      ? "官方来源列出该地址；角色及启用状态尚未核验。"
      : `${officialSourceKind(event)} lists the address; its role and activation are not yet verified.`;
    return zh
      ? "官方来源已记录该变化；部署或启用状态尚未核验。"
      : `${officialSourceKind(event)} records the change; deployment or activation is not yet verified.`;
  }
  if (event?.pullRequest) return zh
    ? `PR #${event.pullRequest.number || "?"} 当前为${event.pullRequest.draft ? "草稿" : "开放"}；尚未合并或部署。`
    : `PR #${event.pullRequest.number || "?"} is ${event.pullRequest.draft ? "draft" : "open"}; not merged or deployed.`;
  const explicit = event?.stageLabel || event?.status || event?.attribution?.status || event?.verification?.status;
  if (explicit) return factValue(explicit);
  if (event?.sourceTrust === "official_verified") return zh
    ? "官方来源已验证；产品是否启用仍需确认。"
    : "Verified official source; product activation may still require confirmation.";
  return zh
    ? "监控信号已确认；部署或启用状态仍需核验。"
    : "Verified monitoring signal; deployment or activation may still require confirmation.";
}

function structuredRisk(event, language = "en") {
  const zh = language === "zh";
  const security = event?.security?.decision;
  if (security === "pass") return zh
    ? "已通过本地安全门槛，但不构成买入建议。"
    : "Local safety gates passed, but this is not a buy recommendation.";
  if (security === "block") return zh
    ? "本地安全门槛已拦截该事件。"
    : "The local safety gate blocked this event.";
  return zh
    ? "仅为监控信号；部署状态和代币安全仍需核验。"
    : "This is a monitoring signal; deployment and token safety may still require verification.";
}

function structuredFallbackModel(event, language = "en") {
  const zh = language === "zh";
  return {
    title: `${eventProject(event) ? `${eventProject(event)} · ` : ""}${eventTitle(event, zh ? "zh" : "en")}`,
    modules: structuredModules(event),
    transitions: structuredTransitions(event),
    facts: [
      ...structuredPoolFacts(event),
      ...structuredRepositoryFacts(event),
      ...structuredLaunchFacts(event),
    ].slice(0, 4),
    narrative: rawEnglishNarrative(event),
    status: structuredStatus(event, language),
    addresses: structuredAddresses(event),
    risk: structuredRisk(event, language),
    time: eventTime(event) || "not available",
  };
}

function labelledValue(line) {
  return String(line || "").replace(/^.{1,32}?[:：]\s*/u, "").trim();
}

function compactChangeLine(changeModel, language = "zh", event = null) {
  const locale = language === "en" ? "en" : "zh";
  const poolFacts = event?.type === "platform_capability_update"
    ? structuredPoolFacts(event, locale)
    : [];
  const priority = (value) => {
    const text = String(value || "");
    if (/^(?:模块|module)(?:\s|[:：])/i.test(text)) return 0;
    if (/^(?:软件包|package)(?:\s|[:：])/i.test(text)) return 1;
    if (/^(?:网络|network)(?:\s|[:：])/i.test(text)) return 2;
    if (/^(?:合约|contract|地址|address)(?:\s|[:：])/i.test(text)) return 3;
    return 4;
  };
  const displayModel = {
    ...changeModel,
    before: { ...changeModel.before, items: [...changeModel.before.items].sort((a, b) => priority(a) - priority(b)) },
    after: { ...changeModel.after, items: [...changeModel.after.items].sort((a, b) => priority(a) - priority(b)) },
  };
  const [kindLine, beforeLine, afterLine] = renderAlertChangeLines(displayModel, { locale, maxItems: 3 });
  const kind = labelledValue(kindLine);
  const binanceWalletTradeThesis = event?.type === "binance_official_update"
    && event?.signal?.scope === "wallet"
    && /Trade Thesis|社交交易/u.test([
      event?.title,
      event?.signal?.category,
      ...list(event?.signal?.labels),
      ...list(event?.keyChanges),
    ].filter(Boolean).join(" "));
  if (binanceWalletTradeThesis) {
    const fact = locale === "zh"
      ? "KOL 买入后可发布 Trade Thesis · 社交交易新功能"
      : "KOL post-buy Trade Thesis social trading feature";
    return `${locale === "zh" ? "变化" : "Change"}: ${kind} · ${fact}`;
  }
  if (poolFacts.length) {
    return oneLine(`${locale === "zh" ? "变化" : "Change"}: ${kind} · ${poolFacts.join(locale === "zh" ? "；" : "; ")}`, MAX_LINE_LENGTH);
  }
  const before = labelledValue(beforeLine);
  const after = labelledValue(afterLine);
  const hasExactBefore = changeModel.before.state === "known" && before;
  const transition = hasExactBefore && ["modification", "escalation", "verification"].includes(changeModel.kind);
  const value = transition
    ? `${kind} · ${before} → ${after}`
    : changeModel.kind === "removal" && hasExactBefore
      ? `${kind} · ${before}`
      : `${kind} · ${after}`;
  const normalizedValue = locale === "zh"
    ? value.replace(/新底池\s*\/\s*NEW\s+POOL\s*:?[：]?\s*/gi, "新底池: ")
    : value.replace(/new\s+pool\s*\/\s*NEW\s+POOL\s*:?[：]?\s*/gi, "new pool: ");
  return oneLine(`${locale === "zh" ? "变化" : "Change"}: ${normalizedValue}`, MAX_LINE_LENGTH);
}

function sourceObjectValues(value) {
  if (!value) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(sourceObjectValues);
  if (typeof value !== "object") return [String(value)];
  return [value.name, value.id, value.url, value.trust].filter(Boolean).map(String);
}

function eventReferenceValues(event, changeModel, sourceLines = [], represented = "") {
  const labelledReferences = sourceLines
    .filter((line) => /^(?:来源|代码|仓库|合约|地址|CA|交易|网络|Factory|Launcher|Source|Code|Repository|Contract|Address|Transaction)[:：]/iu.test(line))
    .map(labelledValue);
  const candidates = [
    ...labelledReferences,
    event?.repository,
    event?.commit && `commit ${event.commit}`,
    event?.pullRequest?.number && `PR #${event.pullRequest.number}`,
    event?.tweet?.url,
    event?.url,
    event?.sourceUrl,
    event?.transactionHash,
    event?.contract,
    event?.token,
    event?.factory,
    event?.launcher,
    ...sourceObjectValues(event?.source),
    ...sourceObjectValues(event?.sources),
    ...list(changeModel?.evidence),
  ].filter(Boolean).map((value) => oneLine(value, 210));
  const project = eventProject(event);
  const redundantNamedSources = new Set(
    [event?.source, ...list(event?.sources)]
      .filter((source) => source && typeof source === "object" && !Array.isArray(source) && source.url)
      .flatMap((source) => [source.name, source.id])
      .filter((value) => value && project && represented.includes(project) && String(value).includes(project))
      .map(String),
  );
  const unique = [...new Set(candidates)]
    .filter((value) => !represented.includes(value) && !redundantNamedSources.has(value));
  return unique.slice(0, 3);
}

function compactReferenceLine(event, changeModel, language = "zh", sourceLines = [], represented = "") {
  const locale = language === "en" ? "en" : "zh";
  const references = eventReferenceValues(event, changeModel, sourceLines, represented);
  const fallback = locale === "zh" ? "官方监控源" : "verified monitored source";
  return oneLine(`${locale === "zh" ? "标识 / 来源" : "ID / Source"}: ${references.join(" · ") || fallback}`, MAX_LINE_LENGTH);
}

function securityRiskIsRelevant(event) {
  return ["pass", "block"].includes(event?.security?.decision);
}

function compactClosingLine(event, language = "zh", values = {}) {
  const locale = language === "en" ? "en" : "zh";
  const fallback = structuredFallbackModel(event, locale);
  const status = oneLine(values.status || fallback.status, 135);
  const risk = securityRiskIsRelevant(event) ? oneLine(values.risk || fallback.risk, 95) : "";
  const time = oneLine(values.time || fallback.time || "not available", 70);
  return oneLine(`${locale === "zh" ? "状态 / 时间" : "Status / Time"}: ${[status, risk, time].filter(Boolean).join(" · ")}`, MAX_LINE_LENGTH);
}

function usableTranslatedClosing(line, language) {
  const value = oneLine(line);
  if (!value || /(?:Source fact \(translation pending\)|英文原文|翻译暂不可用)/i.test(value)) return null;
  if (language === "en" && (value.match(/[\u3400-\u9fff]/g) || []).length > 3) return null;
  if (language === "zh" && !/[\u3400-\u9fff]/u.test(value)) return null;
  return value;
}

function mirroredTimeFromClosing(baseClosing, language) {
  const parts = labelledValue(baseClosing).split(/\s*·\s*/u).map((item) => item.trim()).filter(Boolean);
  const timeParts = parts.filter((item) => /(?:\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}:\d{2}|延迟|delay)/iu.test(item));
  const value = timeParts.join(" · ");
  if (language !== "en") return value;
  return englishDelay(value);
}

function compactStructuredLines(event, changeModel, language = "zh", options = {}) {
  const locale = language === "en" ? "en" : "zh";
  const fallback = structuredFallbackModel(event, locale);
  const title = oneLine(fallback.title, 150);
  const change = compactChangeLine(changeModel, locale, event);
  const lines = [
    title,
    change,
    compactReferenceLine(event, changeModel, locale, [], `${title}\n${change}`),
    compactClosingLine(event, locale),
  ];
  const preferred = usableTranslatedClosing(options.translatedClosing, locale);
  if (preferred) {
    lines[3] = preferred;
  } else if (options.baseClosing) {
    const mirroredTime = mirroredTimeFromClosing(options.baseClosing, locale);
    if (mirroredTime) lines[3] = compactClosingLine(event, locale, { time: mirroredTime });
  }
  return lines;
}

function fallbackEnglishLines(event, baseLines, _required = [], changeModel = deriveAlertChangeModel(event), translatedLines = []) {
  return compactStructuredLines(event, changeModel, "en", {
    baseClosing: baseLines?.[3],
    translatedClosing: translatedLines?.[3],
  });
}

function fallbackChineseLines(event, baseLines, changeModel = deriveAlertChangeModel(event), translatedLines = []) {
  return compactStructuredLines(event, changeModel, "zh", {
    baseClosing: baseLines?.[3],
    translatedClosing: translatedLines?.[3],
  });
}

function isPonFunRenderEvent(event) {
  return event?.type === "pon_fun_update"
    || (event?.type === "twitter_update"
      && String(event?.project?.id || "").toLowerCase() === "ponfun"
      && event?.signal?.ponFunOfficial === true);
}

function ponFunKind(event) {
  return event?.type === "twitter_update" ? event?.signal?.ponKind : event?.kind;
}

function ponFunSnapshotValue(value) {
  if (value == null) return "∅";
  if (["string", "number", "boolean", "bigint"].includes(typeof value)) return String(value);
  if (typeof value === "object") {
    return [value.symbol, value.ticker, value.address, value.coin, value.stockToken]
      .filter(Boolean).map(String).join("/") || "structured-value";
  }
  return String(value);
}

function ponFunChangePairs(event, language = "zh", maximum = 3) {
  const zh = language === "zh";
  return Object.entries(event?.changes || {})
    .filter(([, value]) => value && typeof value === "object" && "before" in value && "after" in value)
    .slice(0, maximum)
    .map(([field, value]) => {
      const before = ponFunSnapshotValue(value.before);
      const after = ponFunSnapshotValue(value.after);
      const longIdentifierTransition = [before, after].some((item) => /^0x[a-f0-9]{40,64}$/i.test(item))
        || before.length + after.length > 96;
      return longIdentifierTransition
        ? `${field} ${zh ? "已变更" : "changed"}`
        : `${field} ${before}→${after}`;
    });
}

function ponFunRecoveryLag(value, language = "zh") {
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return language === "zh" ? "未知" : "unknown";
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return language === "zh" ? `${minutes}分钟` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return language === "zh"
    ? `${hours}小时${minutes % 60 ? `${minutes % 60}分` : ""}`
    : `${hours}h${minutes % 60 ? `${minutes % 60}m` : ""}`;
  const days = Math.floor(hours / 24);
  return language === "zh" ? `${days}天${hours % 24 ? `${hours % 24}小时` : ""}` : `${days}d${hours % 24 ? `${hours % 24}h` : ""}`;
}

function flapRecoveryLagSummary(details, language = "zh") {
  const zh = language === "zh";
  const monitorLagMs = Number(details?.recoveryLagMs);
  const deliveryLagMs = Number(details?.deliveryLagMs);
  const monitorLag = ponFunRecoveryLag(monitorLagMs, language);
  if (!Number.isFinite(deliveryLagMs) || deliveryLagMs <= 0) {
    return zh
      ? `监控缺口 ${monitorLag} · 总延迟 ${monitorLag}`
      : `monitor gap ${monitorLag} · total delay ${monitorLag}`;
  }
  const deliveryLag = ponFunRecoveryLag(deliveryLagMs, language);
  const totalLag = ponFunRecoveryLag(
    Number.isFinite(monitorLagMs) && monitorLagMs >= 0 ? monitorLagMs + deliveryLagMs : deliveryLagMs,
    language,
  );
  return zh
    ? `监控缺口 ${monitorLag} · 送达等待 ${deliveryLag} · 总延迟 ${totalLag}`
    : `monitor gap ${monitorLag} · delivery wait ${deliveryLag} · total delay ${totalLag}`;
}

function ponFunFocusKey(event, language = "zh") {
  const zh = language === "zh";
  if (event?.delayedRecovery?.version === 1
    && event.delayedRecovery?.reason === "monitoring_gap_recovery") {
    const original = { ...event };
    delete original.delayedRecovery;
    return `${zh ? "监控恢复补报" : "Delayed recovery"} · ${ponFunFocusKey(original, language)}`;
  }
  const kind = ponFunKind(event);
  const market = event?.market || event?.currentSnapshot || {};
  const symbol = market.symbol || event?.symbol || market.ticker || event?.ticker || "?";
  const ticker = market.ticker || event?.ticker;
  const changes = ponFunChangePairs(event, language).join(" · ");
  if (event?.type === "twitter_update") {
    const stage = event?.signal?.ponStage;
    if (stage === "platform_token_live") return zh ? "$PONFUN 正式上线" : "$PONFUN is live";
    if (stage === "supply_burned") return zh ? "$PONFUN Dev supply 已销毁" : "$PONFUN dev supply burned";
    if (stage === "paused") return zh ? "Factory/协议已暂停" : "Factory/protocol paused";
    if (stage === "recovered") return zh ? "Factory/平台运行已恢复" : "Factory/platform operations recovered";
    const claim = event?.signal?.headline || event?.signal?.keyChanges?.[0] || event?.tweet?.text;
    return firstFocusClause(claim || (zh ? "官方 X 更新" : "Official X update"));
  }
  if (kind === "market_created") return zh
    ? `新市场 ${symbol}${ticker && ticker !== symbol ? ` / ${ticker}` : ""}`
    : `New market ${symbol}${ticker && ticker !== symbol ? ` / ${ticker}` : ""}`;
  if (kind === "stock_listing") return `${zh ? "股票映射" : "Stock mapping"} ${ticker || symbol}${changes ? ` · ${changes}` : ""}`;
  if (kind === "market_lifecycle") return `${zh ? "市场生命周期" : "Market lifecycle"} ${symbol} · ${changes || (zh ? "状态已更新" : "state updated")}`;
  const labels = {
    factory_config: { zh: "Factory 配置", en: "Factory config" },
    curve_params: { zh: "曲线参数", en: "Curve params" },
    factory_paused: { zh: "Factory 已暂停", en: "Factory paused" },
    factory_unpaused: { zh: "Factory 已恢复", en: "Factory recovered" },
    ownership_transfer_started: { zh: "所有权转移已发起", en: "Ownership transfer started" },
    ownership_transferred: { zh: "所有权已转移", en: "Ownership transferred" },
    platform_token_update: { zh: "$PONFUN 资料", en: "$PONFUN metadata" },
  };
  const label = labels[kind]?.[language] || (zh ? "官方更新" : "Official update");
  return `${label}${changes ? ` · ${changes}` : ""}`;
}

function ponFunFocusEvidence(event) {
  const token = event?.signal?.tokenAddress || event?.token || event?.contractAddress;
  const transactionHash = event?.signal?.transactionHash || event?.transactionHash;
  const transaction = transactionHash
    ? `Tx ${transactionHash}${event?.blockNumber != null ? `#${event.blockNumber}` : ""}`
    : null;
  if (event?.type === "twitter_update") {
    const post = event?.tweet?.id ? `@pondotfun · X#${event.tweet.id}` : "@pondotfun";
    return [
      token ? { zh: `CA ${token}`, en: `CA ${token}` } : null,
      transaction ? { zh: transaction, en: transaction } : { zh: post, en: post },
    ].filter(Boolean);
  }
  return [
    token ? { zh: `CA ${token}`, en: `CA ${token}` } : null,
    transaction
      ? { zh: transaction, en: transaction }
      : event?.factory ? { zh: `Factory ${event.factory}`, en: `Factory ${event.factory}` } : null,
    !token && event?.factory && transaction
      ? { zh: `Factory ${event.factory}`, en: `Factory ${event.factory}` } : null,
  ].filter(Boolean).slice(0, 2);
}

function ponFunRiskBoundary(event, language = "zh") {
  const zh = language === "zh";
  const stockLinked = ["market_created", "market_lifecycle", "stock_listing"].includes(ponFunKind(event));
  if (stockLinked) return zh
    ? "coin 不是股票；非自动交易"
    : "coin is not the stock; no automatic trading";
  return zh ? "非自动交易" : "no automatic trading";
}

function ponFunVerificationFact(event, language = "zh") {
  const zh = language === "zh";
  if (event?.delayedRecovery?.version === 1
    && event.delayedRecovery?.reason === "monitoring_gap_recovery") {
    const lag = ponFunRecoveryLag(event.delayedRecovery.lagMs, language);
    return zh
      ? `监控缺口恢复后补报 · 延迟 ${lag} · 勿追价；原始证据已保留`
      : `Recovered after a monitoring gap · ${lag} late · do not chase; original proof retained`;
  }
  if (event?.type === "twitter_update") return zh
    ? `官方 X 身份已核；${event?.signal?.transactionHash ? "交易仍需链上复核" : "链上结果待确认"}`
    : `Official X identity checked; ${event?.signal?.transactionHash ? "transaction still needs on-chain review" : "on-chain result pending"}`;
  if (event?.transactionHash) return zh
    ? "Factory receipt 已核"
    : "Factory receipt checked";
  return zh
    ? "官方 API 与 Factory 指纹绑定"
    : "Official API bound to Factory fingerprint";
}

function ponFunFocusStage(event, language = "zh") {
  return [ponFunVerificationFact(event, language), ponFunRiskBoundary(event, language)]
    .filter(Boolean).join(language === "zh" ? "；" : "; ");
}

function focusProject(event) {
  if (isPonFunRenderEvent(event)) return "pon.fun";
  return eventProject(event)
    || event?.product?.name
    || (event?.type === "uniswap_official_update" ? "Uniswap" : null)
    || (event?.type === "binance_official_update" ? "Binance" : null)
    || (event?.type === "ai_official_update" ? "xAI / Grok" : null)
    || (event?.type === "fomo_family_top_call" ? "Fomo" : null)
    || "监控";
}

function hooklistRegistryFacts(event) {
  if (String(event?.repository || "").toLowerCase() !== "uniswap/hooklist" || event?.pullRequest) return null;
  const registryFile = list(event?.files).find((file) => file?.status === "added"
    && /^hooks\/robinhood\/0x[a-f0-9]{40}\.json$/i.test(String(file?.filename || "")));
  if (!registryFile) return null;
  const hookAddress = String(registryFile.filename).match(/\/(0x[a-f0-9]{40})\.json$/i)?.[1] || null;
  const hookName = String(event?.message || "").match(/^Add\s+(.+?)\s+hook\s+on\s+robinhood\b/i)?.[1] || "Hook";
  const evidence = list(event?.changeEvidence);
  const chainId = event?.chainId
    ?? evidence.find((item) => String(item?.subject || "").toLowerCase() === "chainid")?.after
    ?? 4663;
  const dynamicFeeRaw = evidence.find((item) => String(item?.subject || "").toLowerCase() === "dynamicfee")?.after;
  const dynamicFee = dynamicFeeRaw === undefined || dynamicFeeRaw === null ? null : String(dynamicFeeRaw).toLowerCase();
  const relatedAddresses = list(event?.newContracts)
    .map(String)
    .filter((address) => /^0x[a-f0-9]{40}$/i.test(address) && address.toLowerCase() !== hookAddress?.toLowerCase());
  const commit = String(event?.headCommit || event?.commit || "");
  return {
    hookName,
    hookAddress,
    chainId,
    dynamicFee,
    relatedAddresses,
    shortSha: /^[a-f0-9]{7,40}$/i.test(commit) ? commit.slice(0, 8) : commit.slice(0, 16),
  };
}

function shortGithubRevision(event) {
  const revision = String(event?.headCommit || event?.commit || event?.gap?.newestSha || "");
  return /^[a-f0-9]{7,40}$/i.test(revision) ? revision.slice(0, 8) : revision.slice(0, 16);
}

const BINANCE_INTERVAL_HOUR_WORDS = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  six: 6,
  eight: 8,
  twelve: 12,
  twentyfour: 24,
};

function binanceIntervalHours(value) {
  const normalized = String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const parsed = /^\d+$/.test(normalized) ? Number(normalized) : BINANCE_INTERVAL_HOUR_WORDS[normalized];
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 24 ? parsed : null;
}

function binanceAnnouncementDetails(event) {
  if (event?.type !== "binance_official_update" || event?.kind !== "announcement") return null;
  const persisted = event?.announcementDetails || event?.currentSnapshot?.details;
  if (persisted?.kind === "instrument_change" && Array.isArray(persisted?.instruments)
    && persisted.instruments.some((item) => String(item?.symbol || "").trim())) return persisted;
  if (persisted?.kind === "funding_interval" && persisted?.instrument
    && Number(persisted?.previousHours) > 0 && Number(persisted?.currentHours) > 0) return persisted;
  const content = [
    event?.title,
    ...list(event?.keyChanges),
    ...list(event?.currentSnapshot?.facts),
  ].filter(Boolean).join(" ");
  const interval = content.match(/funding\s+interval\s+of\s+([A-Z0-9Ⓢ._-]+)\s+Perpetual\s+Contract\s+from\s+every\s+([a-z0-9-]+)\s+hours?\s+to\s+every\s+([a-z0-9-]+)\s+hours?/iu);
  if (!interval) return null;
  const previousHours = binanceIntervalHours(interval[2]);
  const currentHours = binanceIntervalHours(interval[3]);
  if (!previousHours || !currentHours) return null;
  const effective = content.match(/Effective\s+from\s+(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:\s*\(UTC\))?/iu);
  const effectiveAt = effective ? new Date(`${effective[1]}T${effective[2]}:00Z`) : null;
  return {
    kind: "funding_interval",
    instrument: interval[1],
    previousHours,
    currentHours,
    ...(effectiveAt && !Number.isNaN(effectiveAt.getTime()) ? { effectiveAt: effectiveAt.toISOString() } : {}),
  };
}

function binanceMeaningfulFact(event) {
  const facts = [...list(event?.keyChanges), ...list(event?.currentSnapshot?.facts)];
  return facts.find((value) => {
    const text = String(value || "").trim();
    return text && !/^(?:Products? and services|Products? may not|This is a general|Fellow Binancians)/iu.test(text);
  }) || event?.title || null;
}

function binanceAgentNativeDetails(event) {
  const developerDelta = event?.type === "binance_official_update" && event?.kind === "developer_update"
    ? [
      ...list(event?.addedSignals),
      ...list(event?.keyChanges).filter((value) => !/^\s*Removed\s*:/iu.test(String(value || ""))),
    ]
    : [];
  const facts = developerDelta.length ? developerDelta : [
    event?.title,
    event?.message,
    event?.summary,
    event?.factSummary,
    event?.tweet?.text,
    event?.signal?.headline,
    ...list(event?.signal?.keyChanges),
    ...list(event?.keyChanges),
    event?.repository,
  ];
  const text = facts.filter(Boolean).join("\n");
  const agentNative = /\bAgent\s+(?:OS|Native|REST\s+API)\b|\/agent-native\/|\bBinance\s+MCP\s+Server\b/iu.test(text);
  if (!agentNative) return null;
  const exactLaunch = event?.type === "twitter_update"
    && String(event?.tweet?.id || "") === "2090380033013764166"
    && String(event?.tweet?.handle || "").replace(/^@/, "").toLowerCase() === "binance";
  const launch = exactLaunch || (/\bAgent\s+OS\b/iu.test(text) && (
    (event?.type === "twitter_update" && /\b(?:build|deploy|use)\b/iu.test(text))
    || (event?.type === "binance_official_update" && event?.kind === "announcement"
      && /\b(?:launch(?:ed)?|available|live)\b|正式发布|已上线/iu.test(text))
  ));
  const mcp = /\bMCP\b|\/mcp-server(?:\b|\/)/iu.test(text);
  return {
    launch,
    developer: event?.type === "binance_official_update" && event?.kind === "developer_update",
    mcp,
  };
}

function focusAgentSkillDetails(event) {
  if (event?.type !== "twitter_update") return null;
  const project = String(event?.project?.id || "").toLowerCase();
  if (!["flap", "fourmeme"].includes(project)) return null;
  const labels = list(event?.signal?.labels).map(String);
  if (event?.signal?.reason !== "agentic_skill_integration" && !labels.includes("Agent/Skill 集成")) return null;
  const text = String(event?.tweet?.text || "");
  return {
    project,
    bstock: /\bBStock\b/i.test(text),
  };
}

function beijingMinute(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return `${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function utcMinute(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(5, 16).replace("T", " ");
}

function localizedCstTime(value, language = "zh") {
  const source = String(value || "").trim();
  if (!source) return language === "zh" ? "时间未取得" : "Time unavailable";
  if (/时间未取得|未取得|unavailable/iu.test(source)) {
    return language === "zh" ? "时间未取得" : "Time unavailable";
  }
  if (/\bCST\b|北京时间/iu.test(source)) {
    const rendered = source.replace(/北京时间/gu, "CST");
    return language === "en" ? englishDelay(rendered) : rendered;
  }
  const zoned = source.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})/u)?.[0];
  if (zoned) {
    const cst = beijingMinute(zoned);
    const utc = utcMinute(zoned);
    const suffix = source.replace(zoned, "").replace(/^\s*[·|｜]\s*/u, "").trim();
    const base = cst && utc ? `${cst} CST (${utc} UTC)` : source;
    const localizedSuffix = language === "en" ? englishDelay(suffix) : suffix;
    return [base, localizedSuffix].filter(Boolean).join(" · ");
  }
  const local = source.match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?/u);
  if (local) {
    const suffix = source.slice((local.index || 0) + local[0].length).replace(/^\s*[·|｜]\s*/u, "").trim();
    const localizedSuffix = language === "en" ? englishDelay(suffix) : suffix;
    return [`${local[2]}-${local[3]} ${local[4]}:${local[5]} CST`, localizedSuffix].filter(Boolean).join(" · ");
  }
  return language === "en" ? englishDelay(source) : source;
}

function flapAgenticFirstTokenCandidate(event) {
  return event?.type === "bsc_launchpad_update"
    && String(event?.platform?.id || event?.featurePlatform || "").toLowerCase() === "flap"
    && event?.mode?.candidateKind === "flap_agentic_wallet_skill_first_token";
}

function focusTitle(event, language = "zh") {
  const zh = language === "zh";
  if (isPonFunRenderEvent(event)) return `pon.fun｜${zh ? "官方更新" : "Official update"}`;
  const trackedToken = flapTrackedPoolTokenDetails(event);
  if (trackedToken) return zh
    ? `Flap｜${trackedToken.quoteSymbol} 底池｜第 ${trackedToken.ordinal}/${trackedToken.target} 个代币`
    : `Flap | ${trackedToken.quoteSymbol} pool | Token ${trackedToken.ordinal}/${trackedToken.target}`;
  const flapQuote = flapQuotePairDetails(event);
  if (flapQuote) return flapQuote.firstObservedAfterGap
    ? (zh ? "Flap｜补扫首次观察" : "Flap｜First observed after gap")
    : flapQuote.delayedRecovery
    ? (zh ? "Flap｜断线恢复补报" : "Flap｜Delayed recovery")
    : (zh ? "Flap｜报价底池更新" : "Flap｜Quote-pool update");
  if (event?.type === "telegram_news_update") return zh ? "频道线索" : "Channel lead";
  if (flapAgenticFirstTokenCandidate(event)) return zh
    ? "Flap｜Skill首币候选"
    : "Flap｜Skill token candidate";
  const agentNative = binanceAgentNativeDetails(event);
  if (agentNative?.launch) return zh ? "Binance Agent OS｜正式发布" : "Binance Agent OS｜Official launch";
  if (agentNative?.developer) return zh ? "Binance Agent Native｜Developer 更新" : "Binance Agent Native｜Developer update";
  if (agentNative) return zh ? "Binance Agent Native｜官方更新" : "Binance Agent Native｜Official update";
  const agentSkill = focusAgentSkillDetails(event);
  if (agentSkill) {
    const project = agentSkill.project === "flap" ? "Flap" : "Four.Meme";
    return zh ? `${project}｜Agent 发币入口` : `${project}｜Agent launch integration`;
  }
  if (hooklistRegistryFacts(event)) return zh ? "Uniswap hooklist｜新增登记" : "Uniswap hooklist｜Registry entry";
  if (event?.type === "uniswap_official_update" && event?.kind === "github_release") {
    return zh ? "Uniswap｜GitHub Release" : "Uniswap｜GitHub Release";
  }
  if (event?.type === "uniswap_official_update" && event?.kind === "blog") {
    return zh ? "Uniswap｜官方文章" : "Uniswap｜Official article";
  }
  if (event?.type === "fomo_family_top_call") {
    if (event?.signalKind === "high_profit_high_winrate_wallet_buy") {
      return zh ? "高收益高胜率钱包｜买入" : "High-profit/high-win-rate wallet｜Buy";
    }
    const handle = String(event?.caller?.handle || event?.handle || event?.thesis?.handle || "").replace(/^@/, "");
    if (event?.signalKind === "fomo_x_call") {
      return `Fomo｜${handle ? `@${handle} ` : ""}${zh ? "X 喊单" : "X call"}`;
    }
    if (event?.signalKind === "fomo_published_call") {
      return `Fomo｜${handle ? `@${handle} ` : ""}${zh ? "新喊单" : "New call"}`;
    }
    const convergence = /convergence/i.test(String(event?.signalKind || ""));
    return convergence
      ? (zh ? "Fomo｜KOL 链上共振" : "Fomo｜KOL on-chain convergence")
      : (zh ? "Fomo｜KOL 链上首买" : "Fomo｜KOL on-chain first buy");
  }
  const rawProject = isGithubSkillUpdate(event) ? "Binance Skills" : focusProject(event);
  const project = !zh && rawProject === "监控" ? "Monitor" : rawProject;
  let label;
  if (event?.type === "github_module_update") label = githubCategoryLabel(event, language);
  else if (event?.type === "github_monitor_gap") label = zh ? "GitHub 缺口" : "GitHub gap";
  else if (event?.type === "github_repository_discovered") label = zh ? "新仓库" : "New repository";
  else if (event?.type === "github_repository_verified") label = zh ? "仓库认证" : "Repository verified";
  else if (event?.type === "platform_capability_update") {
    const pool = list(event?.changes?.newFlapPools).length || list(event?.changes?.flapPoolChanges).length;
    label = pool ? (zh ? "底池更新" : "Pool update") : (zh ? "能力更新" : "Capability update");
  } else if (event?.type === "twitter_update") label = zh ? "X 更新" : "X update";
  else if (event?.type === "binance_official_update") {
    const details = binanceAnnouncementDetails(event);
    if (details?.kind === "funding_interval") return zh ? "Binance Futures｜资金费率调整" : "Binance Futures｜Funding interval update";
    label = event?.signal?.scope === "wallet"
      ? (zh ? "新功能" : "New feature")
      : (zh ? "官方更新" : "Official update");
  }
  else if (event?.type === "uniswap_official_update") label = zh ? "官方更新" : "Official update";
  else if (event?.type === "ai_official_update") label = zh ? "产品更新" : "Product update";
  else if (event?.type === "bsc_launchpad_update") {
    const tracked = flapTrackedPoolTokenDetails(event);
    if (tracked) label = zh ? `第 ${tracked.ordinal}/${tracked.target} 个代币` : `Token ${tracked.ordinal}/${tracked.target}`;
    else if (event?.featureFirstToken || event?.officialFirstToken) label = zh ? "首个代币" : "First token";
    else if (["new_launchpad", "new_factory"].includes(event?.kind)) label = zh ? "新发射台" : "New launchpad";
    else label = zh ? "新模式" : "New mode";
  } else if (event?.type === "evm_launchpad_update") label = zh ? "新模式" : "New mode";
  else if (event?.type === "early_activity_alert") label = zh ? "早期异动" : "Early signal";
  else if (event?.type === "official_activity") label = zh ? "官方地址行为" : "Official activity";
  else if (event?.type === "token_launch") label = zh ? "代币事件" : "Token event";
  else if (event?.type === "contract_deployed") label = zh ? "合约部署" : "Contract deployment";
  else label = zh ? "更新" : "Update";
  return `${project}｜${label}`;
}

function stripFocusOverflow(value) {
  return String(value || "")
    .replace(/[；;]\s*(?:另有\d+项|\+\d+\s+more|and\s+\d+\s+more(?:\s+items)?).*$/iu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function firstFocusClause(value) {
  const text = stripFocusOverflow(value);
  const [first] = text.split(/；|[。！？]|[;.!?]\s+(?=[A-Z@])/u);
  return first?.trim() || text;
}

function githubChangedFilePaths(event) {
  return list(event?.files).map((file) => typeof file === "string" ? file : file?.filename || file?.name)
    .map((value) => String(value || "").trim())
    .filter(Boolean);
}

function isBinanceGithubUpdate(event) {
  if (event?.type !== "github_module_update") return false;
  const repository = String(event?.repository || "");
  const launchpad = typeof event?.launchpad === "string" ? event.launchpad : event?.launchpad?.name;
  return /^binance\//i.test(repository) || /\bBinance\b/i.test(String(launchpad || ""));
}

function githubSkillUpdateDetails(event, paths = githubChangedFilePaths(event)) {
  if (event?.type !== "github_module_update") return null;
  const repository = String(event?.repository || "");
  const skillPaths = paths.filter((pathname) => /(?:^|\/)skills\//i.test(String(pathname || "")));
  if (!/skills?-hub/i.test(repository) && !skillPaths.length) return null;
  const skillManifest = skillPaths.find((pathname) => /(?:^|\/)SKILL\.md$/i.test(pathname));
  const sourcePath = skillManifest || skillPaths[0] || "";
  const parts = sourcePath.split("/").filter(Boolean);
  const skillIndex = parts.findIndex((part) => part.toLowerCase() === "skills");
  let slug = skillManifest ? parts.at(-2) : null;
  if (!slug && skillIndex >= 0) slug = parts[skillIndex + 2] || parts[skillIndex + 1] || null;
  const name = String(slug || "").toLowerCase() === "aiko" ? "Aiko" : slug;
  const message = String(event?.message || "").replace(/\s+/g, " ").trim();
  const manifestAdded = list(event?.files).some((file) => {
    const filename = String(typeof file === "string" ? file : file?.filename || file?.name || "");
    const status = String(typeof file === "string" ? "" : file?.status || "").toLowerCase();
    return /(?:^|\/)SKILL\.md$/i.test(filename) && ["added", "created"].includes(status);
  });
  return {
    name,
    message,
    primaryFact: event?.githubChange?.primaryFact || null,
    added: manifestAdded || /^add\b.*\bskill\b/i.test(message),
  };
}

function isGithubSkillUpdate(event) {
  return Boolean(githubSkillUpdateDetails(event));
}

function githubSkillAdditionFocus(details, language = "zh") {
  if (!details?.added) return null;
  const zh = language === "zh";
  const name = details.name || (zh ? "新" : "new");
  const primaryText = [
    details.primaryFact?.subject,
    details.primaryFact?.before,
    details.primaryFact?.after,
  ].filter((value) => value != null).join(" ");
  if (/action[_-]?ref/i.test(`${name} ${primaryText}`) && /\banchor\b/i.test(primaryText)) {
    return zh
      ? `新增 ${name} 技能：派生 action_ref 并核验链上 anchor`
      : `Added ${name} skill: derives action_ref and verifies its on-chain anchor`;
  }
  const purpose = details.message.match(/^add\s+[^:]+:\s*(.+?)(?:\s+skill)?$/i)?.[1]?.trim() || "";
  const normalizedPurpose = purpose.replace(/\s+skill$/i, "").replace(/decision-fusion/gi, "decision fusion");
  const localizedPurpose = /^multi-signal decision fusion$/i.test(normalizedPurpose)
    ? (zh ? "多信号决策融合" : "multi-signal decision fusion")
    : normalizedPurpose;
  if (localizedPurpose) return zh
    ? `新增 ${name} 技能：${localizedPurpose}`
    : `Added ${name} skill: ${localizedPurpose}`;
  return zh ? `新增 ${name} 技能` : `Added ${name} skill`;
}

function githubCodeFile(pathname) {
  const path = String(pathname || "");
  if (!path || /(?:^|\/)(?:CHANGELOG|README|LICENSE|NOTICE)(?:\.|$)/i.test(path)) return false;
  if (/(?:^|\/)(?:docs?|examples?)(?:\/|$)/i.test(path)) return false;
  return /(?:^|\/)src(?:\/|$)/i.test(path)
    || /\.(?:c|cc|cpp|cs|go|h|hpp|java|js|jsx|kt|kts|mjs|php|proto|py|rb|rs|sol|swift|ts|tsx)$/i.test(path);
}

const GITHUB_DETAIL_KINDS = new Set([
  "config_value", "dependency_version", "api_call_signature", "response_schema",
  "contract", "interface", "class", "function", "list_item", "code_assignment",
  "code_line", "documentation_item", "file_change",
]);

function githubFileCategory(pathname) {
  const path = String(pathname || "");
  if (/(?:^|\/)(?:docs?|README|CHANGELOG)(?:\/|\.|$)|\.(?:md|mdx|rst)$/i.test(path)) return "docs";
  if (/(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|go\.sum|Cargo\.(?:toml|lock)|pyproject\.toml|requirements[^/]*\.txt)$/i.test(path)) return "dependency";
  if (/(?:^|\/)(?:config|configs?)(?:\/|\.)|\.(?:json|ya?ml|toml|ini|env)$/i.test(path)) return "config";
  return "code";
}

function githubChangeCategory(change) {
  if (change?.kind === "dependency_version") return "dependency";
  if (change?.kind === "documentation_item") return "docs";
  if (["config_value", "list_item", "code_assignment"].includes(change?.kind)) return "config";
  if (change?.kind === "file_change") return githubFileCategory(change?.file || change?.filename);
  return "code";
}

function githubChangePriority(change) {
  const priorities = {
    response_schema: 0,
    api_call_signature: 0,
    contract: 1,
    interface: 1,
    class: 1,
    function: 1,
    config_value: 2,
    code_assignment: 2,
    list_item: 3,
    documentation_item: 3,
    dependency_version: 4,
    code_line: 5,
    file_change: 6,
  };
  return priorities[change?.kind] ?? 20;
}

function githubStructuredEvidence(event) {
  const primary = event?.githubChange?.primaryFact;
  const candidates = [primary, ...list(event?.githubChange?.facts), ...list(event?.changeEvidence)]
    .filter(Boolean)
    .map((change) => ({
      ...change,
      kind: change.kind || (change.subject || change.before != null || change.after != null ? "config_value" : "file_change"),
      _primary: change === primary,
    }))
    .filter((change) => change && GITHUB_DETAIL_KINDS.has(change.kind))
    .filter((change, index, values) => values.findIndex((candidate) => JSON.stringify([
      candidate.kind, candidate.file, candidate.filename, candidate.subject,
      candidate.before, candidate.after, candidate.action,
    ]) === JSON.stringify([
      change.kind, change.file, change.filename, change.subject,
      change.before, change.after, change.action,
    ])) === index)
    .map((change, index) => ({ ...change, _sourceIndex: index }))
    .sort((left, right) => Number(right._primary) - Number(left._primary)
      || githubChangePriority(left) - githubChangePriority(right)
      || left._sourceIndex - right._sourceIndex);
  return candidates;
}

function githubPrimaryCategory(event) {
  const classification = String(event?.githubChange?.classification || "").toLowerCase();
  if (classification === "documentation") return "docs";
  if (classification === "dependency_maintenance") return "dependency";
  const primary = githubStructuredEvidence(event)[0];
  if (primary) return githubChangeCategory(primary);
  return githubFileCategory(githubChangedFilePaths(event)[0]);
}

function githubCategoryLabel(event, language = "zh") {
  const labels = {
    code: { zh: "GitHub 代码更新", en: "GitHub code update" },
    config: { zh: "GitHub 配置更新", en: "GitHub config update" },
    dependency: { zh: "GitHub 依赖更新", en: "GitHub dependency update" },
    docs: { zh: "GitHub 文档更新", en: "GitHub docs update" },
  };
  return labels[githubPrimaryCategory(event)]?.[language === "zh" ? "zh" : "en"]
    || (language === "zh" ? "GitHub 更新" : "GitHub update");
}

function githubModuleSlug(event, paths = githubChangedFilePaths(event)) {
  for (const path of paths) {
    const matched = path.match(/(?:^|\/)clients\/([^/]+)/i);
    if (matched) return matched[1];
  }
  const release = String(event?.message || "").match(/^Release\s+([A-Za-z0-9._-]+)\s+v?\d/i);
  return release?.[1] || null;
}

function githubModuleLabel(slug) {
  const normalized = String(slug || "").toLowerCase();
  const known = {
    alpha: "Alpha",
    copytrading: "Copy Trading",
    wallet: "Wallet",
  };
  if (known[normalized]) return known[normalized];
  return String(slug || "SDK").split(/[-_]/).filter(Boolean)
    .map((part) => part.replace(/^./, (value) => value.toUpperCase())).join(" ") || "SDK";
}

function githubReleaseVersion(event) {
  return String(event?.message || "").match(/\bv\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?\b/i)?.[0] || null;
}

function githubFileSurface(pathname) {
  const path = String(pathname || "");
  if (/(?:^|\/)restapi(?:\/|$)|(?:^|\/)rest_api\.[^/]+$/i.test(path)) return "REST API";
  if (/(?:^|\/)websocketstreams?(?:\/|$)/i.test(path)) return "WebSocket Streams";
  if (/(?:^|\/)websocketapi(?:\/|$)/i.test(path)) return "WebSocket API";
  return "SDK";
}

function githubVersionEvidence(event) {
  return list(event?.changeEvidence).find((change) => {
    if (change?.before == null || change?.after == null) return false;
    return /version/i.test(String(change?.subject || ""))
      || /(?:^|\/)(?:pyproject\.toml|package\.json|[^/]+\.gemspec)$/i.test(String(change?.file || ""));
  }) || null;
}

function githubSemanticEvidence(event) {
  const version = githubVersionEvidence(event);
  return githubStructuredEvidence(event).filter((change) => {
    if (!change || change === version || change.kind === "dependency_version") return false;
    return change.before != null || change.after != null || change.action === "added"
      || ["contract", "interface", "class", "function", "code_line", "file_change"].includes(change.kind);
  })[0] || null;
}

function githubRepresentativeFile(event) {
  const paths = githubChangedFilePaths(event);
  if (event?.binanceChange?.classification === "sdk_maintenance") {
    const maintenanceFile = String(githubStructuredEvidence(event).find((change) => change.kind === "dependency_version")?.file || "").trim();
    if (maintenanceFile) return maintenanceFile;
  }
  const semanticFile = String(githubSemanticEvidence(event)?.file || "").trim();
  if (semanticFile) return semanticFile;
  const dependencyFile = String(list(event?.changeEvidence).find((change) => change?.kind === "dependency_version")?.file || "").trim();
  if (dependencyFile) return dependencyFile;
  const codeFile = paths.find(githubCodeFile);
  if (codeFile) return codeFile;
  const versionFile = String(githubVersionEvidence(event)?.file || "").trim();
  if (versionFile) return versionFile;
  return paths.find((path) => !/(?:^|\/)CHANGELOG(?:\.|$)/i.test(path)) || paths[0] || null;
}

function githubWeb3Interpretation(event, language = "zh") {
  if (event?.type !== "github_module_update") return null;
  const paths = githubChangedFilePaths(event);
  const moduleSlug = githubModuleSlug(event, paths);
  const module = githubModuleLabel(moduleSlug);
  const version = githubReleaseVersion(event);
  const evidence = githubStructuredEvidence(event);
  const semantic = evidence.find((change) => change.kind !== "dependency_version")
    || evidence[0]
    || event?.githubChange?.primaryFact
    || null;
  return interpretGithubWeb3Change(event, semantic, { language, module, moduleSlug, version });
}

function githubConcreteFocus(event, language = "zh") {
  if (event?.type !== "github_module_update") return null;
  const zh = language === "zh";
  const paths = githubChangedFilePaths(event);
  const binance = isBinanceGithubUpdate(event);
  const skillUpdate = githubSkillUpdateDetails(event, paths);
  const module = githubModuleLabel(githubModuleSlug(event, paths));
  const version = githubReleaseVersion(event);
  const context = skillUpdate
    ? (skillUpdate.name ? `${skillUpdate.name}${zh ? " 技能" : " skill"}` : "Binance Skills")
    : binance ? [module, version].filter(Boolean).join(" ") : "";
  const prefix = context ? `${context}${zh ? "：" : ": "}` : "";
  const evidence = githubStructuredEvidence(event);
  const semantic = evidence.find((change) => change.kind !== "dependency_version") || null;
  const dependency = evidence.find((change) => change.kind === "dependency_version");
  const skillAddition = githubSkillAdditionFocus(skillUpdate, language);
  if (skillAddition) return skillAddition;
  if (skillUpdate && /\bWindows\b/i.test(skillUpdate.message) && /\b(?:no|zero) output\b/i.test(skillUpdate.message)) {
    return zh
      ? "Binance Skills CLI：新增 isDirectExecution，修复 Windows 无输出"
      : "Binance Skills CLI: added isDirectExecution; fixed no output on Windows";
  }
  if (!skillUpdate && event?.binanceChange?.classification === "sdk_maintenance") {
    if (dependency) {
      const transition = dependency.before != null
        ? `${factValue(dependency.before)} → ${factValue(dependency.after)}`
        : `→ ${factValue(dependency.after)}`;
      return zh
        ? `${module} SDK 维护：${factValue(dependency.subject)} ${transition}（无产品新功能）`
        : `${module} SDK maintenance: ${factValue(dependency.subject)} ${transition} (no product feature)`;
    }
    const versionChange = githubVersionEvidence(event);
    if (versionChange) {
      const file = String(versionChange.file || "").split("/").at(-1) || "package metadata";
      return zh
        ? `${module} SDK 维护（${file}）：${factValue(versionChange.before)} → ${factValue(versionChange.after)}，无产品新功能`
        : `${module} SDK maintenance (${file}): ${factValue(versionChange.before)} → ${factValue(versionChange.after)}; no product feature`;
    }
    return zh
      ? `${context}：SDK 维护发布，未发现产品新功能`
      : `${context}: SDK maintenance release; no product feature found`;
  }
  const web3Interpretation = githubWeb3Interpretation(event, language);
  if (web3Interpretation?.summary) return web3Interpretation.summary;
  if (dependency && !semantic) {
    const subject = factValue(dependency.subject || dependency.file || "dependency");
    if (dependency.before != null && dependency.after != null) return zh
      ? `依赖 ${subject} ${factValue(dependency.before)} → ${factValue(dependency.after)}（维护更新）`
      : `Dependency ${subject} ${factValue(dependency.before)} → ${factValue(dependency.after)} (maintenance)`;
    if (dependency.after != null) return zh
      ? `新增依赖 ${subject} ${factValue(dependency.after)}`
      : `Added dependency ${subject} ${factValue(dependency.after)}`;
    if (dependency.before != null) return zh
      ? `移除依赖 ${subject} ${factValue(dependency.before)}`
      : `Removed dependency ${subject} ${factValue(dependency.before)}`;
  }
  if (semantic) {
    if (semantic.kind === "api_call_signature") {
      return zh
        ? `${prefix}调用签名 ${factValue(semantic.before)} → ${factValue(semantic.after)}`
        : `${prefix}call signature ${factValue(semantic.before)} → ${factValue(semantic.after)}`;
    }
    if (semantic.kind === "response_schema") {
      const subject = factValue(semantic.subject).replace(/\s+response$/i, "");
      return zh
        ? `${prefix}${subject} 响应字段 ${factValue(semantic.before)} → ${factValue(semantic.after)}`
        : `${prefix}${subject} response field ${factValue(semantic.before)} → ${factValue(semantic.after)}`;
    }
    const declarationLabels = {
      contract: { zh: "合约", en: "contract" },
      interface: { zh: "接口", en: "interface" },
      class: { zh: "类", en: "class" },
      function: { zh: "函数", en: "function" },
    };
    const subject = factValue(semantic.subject || semantic.kind || semantic.file || "代码项");
    if (semantic.before != null && semantic.after != null) {
      return `${prefix}${subject} ${factValue(semantic.before)} → ${factValue(semantic.after)}`;
    }
    if (semantic.action === "removed" || (semantic.before != null && semantic.after == null)) return zh
      ? `${prefix}移除 ${declarationLabels[semantic.kind]?.zh || "代码项"} ${subject}${semantic.before != null ? ` ${factValue(semantic.before)}` : ""}`
      : `${prefix}Removed ${declarationLabels[semantic.kind]?.en || "code item"} ${subject}${semantic.before != null ? ` ${factValue(semantic.before)}` : ""}`;
    if (semantic.action === "added" || semantic.after != null
      || ["contract", "interface", "class", "function"].includes(semantic.kind)) {
      const label = declarationLabels[semantic.kind];
      return zh
        ? `${prefix}新增 ${label?.zh ? `${label.zh} ` : ""}${subject}${semantic.after != null ? ` ${factValue(semantic.after)}` : ""}`
        : `${prefix}Added ${label?.en ? `${label.en} ` : ""}${subject}${semantic.after != null ? ` ${factValue(semantic.after)}` : ""}`;
    }
  }

  const codeFiles = paths.filter(githubCodeFile);
  if (codeFiles.length) {
    return zh
      ? `${prefix}${codeFiles[0]} 已修改；精确差异未解析`
      : `${prefix}${codeFiles[0]} changed; exact delta unresolved`;
  }

  const versionChange = githubVersionEvidence(event);
  if (versionChange) {
    const file = String(versionChange.file || "").split("/").at(-1) || "package metadata";
    return zh
      ? `${skillUpdate ? "Binance Skills " : binance ? `${module} ` : ""}包元数据（${file}）：${factValue(versionChange.before)} → ${factValue(versionChange.after)}`
      : `${skillUpdate ? "Binance Skills " : binance ? `${module} ` : ""}package metadata (${file}): ${factValue(versionChange.before)} → ${factValue(versionChange.after)}`;
  }

  const file = githubRepresentativeFile(event);
  if (file) {
    const metadata = list(event?.files).find((item) => String(item?.filename || item?.name || "") === file) || {};
    const status = String(metadata.status || "modified").toLowerCase();
    const stats = event?.diffStatsAvailable !== false
      && (Number(metadata.additions) > 0 || Number(metadata.deletions) > 0)
      ? ` +${Number(metadata.additions) || 0} -${Number(metadata.deletions) || 0}`
      : "";
    if (["added", "created"].includes(status)) return zh
      ? `${file} 已新增${stats}；精确内容未解析`
      : `${file} added${stats}; exact content unresolved`;
    if (["removed", "deleted"].includes(status)) return zh
      ? `${file} 已删除${stats}；精确内容未解析`
      : `${file} removed${stats}; exact content unresolved`;
    return zh
      ? `${file} 已修改${stats}；精确差异未解析`
      : `${file} changed${stats}; exact delta unresolved`;
  }
  return zh ? "提交已记录；精确差异未解析" : "Commit recorded; exact delta unresolved";
}

function poolFocusKey(event, language) {
  const zh = language === "zh";
  const quotePair = flapQuotePairDetails(event);
  if (quotePair) {
    const labels = quotePair.assets.map((asset) => [asset.symbol, asset.name].filter(Boolean).join(" · "));
    return zh
      ? `Flap 报价底池已启用：${labels.join("；")}`
      : `Flap quote pools enabled: ${labels.join("; ")}`;
  }
  const interpreted = interpretPlatformPoolChange(event, language);
  if (interpreted) return interpreted;
  const added = list(event?.changes?.newFlapPools)[0];
  if (added) {
    const category = factValue(added.category || added.vaultFactoryCategory || added.poolCategory || added.poolType || "quote");
    return zh ? `新增 ${category} 底池` : `New ${category} pool`;
  }
  const changed = list(event?.changes?.flapPoolChanges)[0];
  if (!changed) return null;
  const before = changed.before || {};
  const after = changed.after || changed;
  const category = factValue(after.category || after.vaultFactoryCategory || after.poolCategory || after.poolType || "quote");
  const quoteOf = (pool) => pool.quoteAddress || pool.quoteTokenAddress || pool.quoteAssetAddress
    || pool.quoteToken?.address || pool.quoteAsset?.address || pool.quoteAsset || pool.quoteToken;
  const beforeQuote = quoteOf(before);
  const afterQuote = quoteOf(after);
  if (beforeQuote && afterQuote && String(beforeQuote) !== String(afterQuote)) {
    return `${category} Quote ${factValue(beforeQuote)}→${factValue(afterQuote)}`;
  }
  return zh ? `${category} 底池配置更新` : `${category} pool configuration updated`;
}

function compactUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function compactPerformanceUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  const absolute = Math.abs(amount);
  if (absolute >= 1_000_000) return `${sign}$${(absolute / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (absolute >= 1_000) return `${sign}$${(absolute / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${sign}$${absolute.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function compactMarketUsd(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return null;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `$${amount.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function firstTokenLabel(event) {
  const token = event?.tokens?.[0] || {};
  const metadata = token?.metadata || {};
  const name = metadata.name || token.name || event?.tokenName;
  const symbol = metadata.symbol || token.symbol || event?.tokenSymbol || event?.symbol;
  if (name && symbol && String(name).toLowerCase() !== String(symbol).toLowerCase()) return `${name} (${symbol})`;
  return name || symbol || null;
}

function bscModeFacts(event) {
  const mode = event?.mode || {};
  const novelty = mode?.novelty || {};
  const template = mode?.template || novelty?.template || event?.currentTemplate || {};
  const name = [
    mode.officialName,
    mode.componentMode,
    template.name,
    novelty.officialName,
    novelty.componentMode,
    novelty.selectorName,
    mode.selectorName,
  ].map((value) => String(value || "").trim()).find((value) => value && !/^0x[a-f0-9]{40}$/i.test(value));
  const templateId = event?.templateId ?? mode.templateId ?? novelty.templateId
    ?? (/^\d+$/.test(String(template?.id || "")) ? template.id : null);
  const presetId = event?.presetId ?? mode.presetId ?? novelty.presetId;
  const selector = event?.selector || mode.selector || novelty.selector;
  return { name: name || null, templateId, presetId, selector: selector || null };
}

function bscFocusKey(event, language) {
  if (event?.type !== "bsc_launchpad_update") return null;
  const zh = language === "zh";
  const tracked = flapTrackedPoolTokenDetails(event);
  if (tracked) return zh
    ? `${tracked.quoteSymbol} 底池第 ${tracked.ordinal}/${tracked.target} 个代币 ${tracked.tokenLabel || "未命名代币"}`
    : `${tracked.quoteSymbol} pool token ${tracked.ordinal}/${tracked.target}: ${tracked.tokenLabel || "Unnamed token"}`;
  const mode = bscModeFacts(event);
  const identity = mode.name
    || (mode.templateId != null ? `templateId=${mode.templateId}` : null)
    || (mode.presetId != null ? `presetId=${mode.presetId}` : null)
    || (mode.selector ? `selector=${mode.selector}` : null);
  const token = firstTokenLabel(event);
  if (token && identity) return zh ? `${identity} · 首币 ${token}` : `${identity} · First token ${token}`;
  if (token) return zh ? `首币 ${token}` : `First token ${token}`;
  if (identity) return zh ? `新增模式 ${identity}` : `New mode ${identity}`;
  return zh ? "链上发现新模式" : "New on-chain mode detected";
}

function fomoHandles(event) {
  const values = [
    event?.caller?.handle,
    event?.handle,
    ...list(event?.callers).map((item) => item?.handle),
    ...list(event?.wallets).map((item) => item?.handle),
  ].map((value) => String(value || "").replace(/^@/, "").trim()).filter(Boolean);
  return [...new Set(values)].slice(0, 2).map((value) => `@${value}`);
}

function fomoInferredKey(event, language) {
  const zh = language === "zh";
  if (event?.signalKind === "high_profit_high_winrate_wallet_buy") {
    const stats = event?.walletProfile?.windows?.["30d"] || {};
    const profit = compactPerformanceUsd(stats.realizedProfitUsd) || (zh ? "待核" : "pending");
    const winRate = Number(stats.winRate);
    const tokenCount = Number(stats.tokenCount);
    const performance = Number.isFinite(winRate) && Number.isFinite(tokenCount)
      ? `${(winRate * 100).toFixed(1)}%/${tokenCount}${zh ? "币" : " tokens"}`
      : (zh ? "胜率待核" : "win rate pending");
    const symbol = event?.tokenSymbol || event?.symbol || "?";
    return zh
      ? `30D ${profit} · 胜率${performance} · ${symbol}`
      : `30d ${profit} · win ${performance} · ${symbol}`;
  }
  const convergence = /convergence/i.test(String(event?.signalKind || ""));
  const handles = fomoHandles(event);
  const amount = compactUsd(convergence ? event?.totalUsd : event?.amountUsd)
    || (event?.paymentAmount != null && event?.paymentSymbol
      ? `${event.paymentAmount} ${event.paymentSymbol}`
      : null);
  if (convergence) {
    const buyers = Number(event?.buyerCount) || list(event?.callers).length || list(event?.wallets).length;
    const actor = handles.length ? handles.join("+") : `${buyers || "?"} KOL`;
    return `${actor} · ${zh ? "共振买入" : "Convergent buys"}${amount ? ` ${amount}` : ""}`;
  }
  const actor = handles[0] || "@?";
  return `${actor} · ${zh ? "买入" : "Bought"}${amount ? ` ${amount}` : ""}`;
}

function focusItemPriority(value) {
  const text = String(value || "");
  if (/^(?:模块|module|功能|feature)(?:\s|[:：])/iu.test(text)) return 0;
  if (/^(?:软件包|package|版本|version)(?:\s|[:：])/iu.test(text)) return 1;
  if (/^(?:网络|network|chain)(?:\s|[:：])/iu.test(text)) return 2;
  if (/^(?:底池|pool|报价|quote)(?:\s|[:：])/iu.test(text)) return 3;
  if (/^(?:合约|contract|地址|address|CA)(?:\s|[:：])/iu.test(text)) return 4;
  return 5;
}

function focusSideValue(side, language) {
  if (side?.state === "unknown") return language === "zh" ? "旧值未知" : "previous value unknown";
  if (side?.state === "not_observed") return "";
  const selected = [...list(side?.items)].sort((a, b) => focusItemPriority(a) - focusItemPriority(b))[0] || side?.text;
  if (!selected) return "";
  const model = {
    kind: "modification",
    basis: "monitoring_baseline",
    before: { state: "not_observed", text: "", items: [] },
    after: { state: "known", text: String(selected), items: [String(selected)] },
    evidence: [],
  };
  const afterLine = renderAlertChangeLines(model, { locale: language === "en" ? "en" : "zh", maxItems: 1 })[2];
  return firstFocusClause(labelledValue(afterLine));
}

function repositoryPurpose(event) {
  const description = event?.repositoryMetadata?.description ?? event?.repositoryMetadata?.purpose
    ?? event?.purpose ?? event?.description;
  if (typeof description === "string") return oneLine(description, 135);
  if (!description || typeof description !== "object") return "";
  return oneLine(description.purpose || description.summary || description.description || description.name, 135);
}

function uniswapGithubReleaseFocus(event, language = "zh") {
  if (event?.type !== "uniswap_official_update" || event?.kind !== "github_release") return null;
  const summary = String(event?.summary || "").replace(/\r\n/g, "\n");
  const candidates = [];
  for (const match of summary.matchAll(/(?:^|\n|[;；])\s*(?:[-*]\s*)?(Breaking(?:\s+Changes?)?|Added|Changed)\s*[:：-]\s*([^\n;；]+)/giu)) {
    if (match[2]?.trim()) candidates.push({ index: match.index || 0, label: match[1], detail: match[2].trim() });
  }
  const selected = candidates.sort((left, right) => left.index - right.index)[0];
  if (selected) {
    const key = /^breaking/i.test(selected.label) ? "breaking" : selected.label.toLowerCase();
    const labels = {
      breaking: { zh: "Breaking", en: "Breaking" },
      added: { zh: "新增", en: "Added" },
      changed: { zh: "变更", en: "Changed" },
    };
    let detail = firstFocusClause(selected.detail);
    if (language === "zh") {
      detail = detail
        .replace(/\bRobinhood\s+hooks?\s+support\b/iu, "Robinhood Hooks 支持")
        .replace(/\bsupport\s+for\s+([A-Za-z0-9_.-]+)/giu, "支持 $1")
        .replace(/\bdefault\s+fee\s+validation\b/giu, "默认费率校验");
    }
    return `${labels[key]?.[language === "zh" ? "zh" : "en"] || selected.label}: ${detail}`;
  }
  const version = String(event?.tag || event?.title || "").match(/\bv?\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?\b/i)?.[0]
    || String(event?.tag || "").trim();
  return language === "zh"
    ? `${version || "该版本"}：Release 详情未取得`
    : `${version || "This release"}: release details unavailable`;
}

function focusKey(event, changeModel, language = "zh", priority = null) {
  const zh = language === "zh";
  if (priority?.category === "binance_security_emergency") {
    const text = [event?.title, event?.signal?.headline, event?.message].filter(Boolean).join(" ");
    const actions = [
      /withdraw|提现/iu.test(text) ? (zh ? "提现" : "withdrawals") : null,
      /deposit|充值/iu.test(text) ? (zh ? "充值" : "deposits") : null,
      /trading|交易/iu.test(text) ? (zh ? "交易" : "trading") : null,
    ].filter(Boolean);
    return zh
      ? `Binance 确认安全事件${actions.length ? `并暂停${actions.join("/")}` : ""}`
      : `Binance confirmed a security incident${actions.length ? ` and suspended ${actions.join("/")}` : ""}`;
  }
  if (isPonFunRenderEvent(event)) return ponFunFocusKey(event, language);
  const flapQuote = flapQuotePairDetails(event);
  if (flapQuote) {
    const labels = flapQuote.assets.map((asset) => [asset.symbol, asset.name].filter(Boolean).join(" · "));
    const assets = labels.join(zh ? "；" : "; ");
    if (flapQuote.firstObservedAfterGap) {
      // The strict fallback contains one asset. Keep its state boundary ahead
      // of the descriptive name so Telegram compaction cannot truncate the
      // crucial "currently" / "0→1 unproven" qualifiers. Name and CA remain
      // on the adjacent evidence row.
      const symbols = flapQuote.assets.map((asset) => asset.symbol || asset.name).filter(Boolean)
        .join(zh ? "；" : "; ");
      return zh
        ? `补扫首次观察：${symbols} 当前确认启用；此前是否新增/0→1 未证`
        : `First observed after gap: ${symbols}; currently confirmed enabled; prior listing/0→1 unproven`;
    }
    if (flapQuote.stage === "announced") return zh
      ? `Flap 预告新增报价底池：${assets}`
      : `Flap announced new quote pools: ${assets}`;
    if (flapQuote.stage === "live") return flapQuote.delayedRecovery
      ? (zh
          ? `断线恢复补报：Flap 报价底池已启用：${assets}`
          : `Delayed recovery: Flap quote pools enabled: ${assets}`)
      : (zh
          ? `Flap 报价底池已启用：${assets}`
          : `Flap quote pools enabled: ${assets}`);
    return zh ? `Flap 报价底池已发现：${assets}` : `Flap quote pools observed: ${assets}`;
  }
  if (flapAgenticFirstTokenCandidate(event)) {
    const token = firstTokenLabel(event) || "chAIn";
    const quoteAmount = String(event?.mode?.quoteAmountDisplay || "1.283 NVDAB");
    return `${token} · V3 · ${quoteAmount}`;
  }
  const uniswapRelease = uniswapGithubReleaseFocus(event, language);
  if (uniswapRelease) return uniswapRelease;
  const agentNative = binanceAgentNativeDetails(event);
  if (agentNative?.launch) return zh
    ? "AI Agent 可接入行情、支付、链上数据与交易能力"
    : "AI agents can access market intelligence, payments, on-chain data, and trading";
  if (agentNative?.developer && agentNative.mcp) return zh
    ? "Agent Native 新增 Binance MCP Server 文档入口"
    : "Agent Native added a Binance MCP Server docs entry";
  if (agentNative?.developer) return zh
    ? "Agent Native Developer 文档新增入口"
    : "Agent Native Developer docs added an entry";
  if (agentNative?.mcp) return zh ? "Binance MCP Server 出现官方更新" : "Official Binance MCP Server update detected";
  const agentSkill = focusAgentSkillDetails(event);
  if (agentSkill?.project === "flap") return zh
    ? `接入 Binance Agentic Wallet；Flap token-launch skill 可对话发币${agentSkill.bstock ? "，支持 BStock 报价" : ""}`
    : `Binance Agentic Wallet now supports chat-based launches through the Flap token-launch skill${agentSkill.bstock ? " with BStock quotes" : ""}`;
  if (agentSkill) return zh
    ? "Agentic Wallet/AI Agent 新增平台发币 skill 入口"
    : "Agentic Wallet/AI Agent added a platform token-launch skill entry";
  const twitterUpdate = interpretTwitterWeb3Update(event, language);
  if (twitterUpdate) return twitterUpdate;
  const hooklist = hooklistRegistryFacts(event);
  if (hooklist) {
    const chain = `chainId=${hooklist.chainId}`;
    const dynamicFee = hooklist.dynamicFee === true || String(hooklist.dynamicFee).toLowerCase() === "true";
    const fee = hooklist.dynamicFee === null
      ? null
      : zh
        ? `${dynamicFee ? "动态费率" : "固定费率"}(dynamicFee=${hooklist.dynamicFee})`
        : `${dynamicFee ? "dynamic fee" : "fixed fee"}(dynamicFee=${hooklist.dynamicFee})`;
    return zh
      ? `${hooklist.hookName}→Robinhood${fee ? `·${fee}` : ""}·${chain}`
      : `${hooklist.hookName}→Robinhood${fee ? `·${fee}` : ""}·${chain}`;
  }
  if (event?.type === "uniswap_official_update" && event?.kind === "blog") {
    return firstFocusClause(event?.title || event?.summary || event?.description || (zh ? "官方文章更新" : "Official article updated"));
  }
  if (event?.type === "fomo_family_top_call") {
    if (["fomo_published_call", "fomo_x_call"].includes(event?.signalKind)) {
      const handle = String(event?.caller?.handle || event?.handle || event?.thesis?.handle || "").replace(/^@/, "");
      const label = event?.signalKind === "fomo_x_call"
        ? (zh ? "X 喊单" : "X call")
        : (zh ? "新喊单" : "New call");
      const target = [event?.tokenSymbol, event?.marketSymbol, event?.symbol, event?.token, event?.contractAddress]
        .map((value) => String(value || "").trim())
        .find(Boolean);
      return zh
        ? `${handle ? `@${handle} ` : ""}${label}${target ? ` · 标的 ${target}` : ""}`
        : `${handle ? `@${handle} ` : ""}${label}${target ? ` · target ${target}` : ""}`;
    }
    return fomoInferredKey(event, language);
  }
  const bsc = bscFocusKey(event, language);
  if (bsc) return bsc;
  const binanceDetails = binanceAnnouncementDetails(event);
  if (binanceDetails?.kind === "funding_interval") {
    const rates = binanceDetails.fundingRateCap && binanceDetails.fundingRateFloor
      ? `${binanceDetails.fundingRateCap}/${binanceDetails.fundingRateFloor}`
      : null;
    return zh
      ? `${binanceDetails.instrument} 永续：${binanceDetails.previousHours}小时→${binanceDetails.currentHours}小时${rates ? `，费率上下限 ${rates}` : ""}`
      : `${binanceDetails.instrument} perpetual: ${binanceDetails.previousHours}h→${binanceDetails.currentHours}h${rates ? `, funding cap/floor ${rates}` : ""}`;
  }
  const walletThesis = event?.type === "binance_official_update"
    && event?.signal?.scope === "wallet"
    && /Trade Thesis|社交交易/u.test([
      event?.title,
      event?.signal?.category,
      ...list(event?.signal?.labels),
      ...list(event?.keyChanges),
    ].filter(Boolean).join(" "));
  if (walletThesis) return zh
    ? "KOL 买入后可发布 Trade Thesis"
    : "KOL can publish a post-buy Trade Thesis";

  const binanceOfficial = interpretBinanceOfficialUpdate(event, language);
  if (binanceOfficial) {
    // The interpreter's legacy Alpha fallback is Chinese in both directions.
    // With no structured target, state the unresolved boundary locally rather
    // than leaking 新代币 into English or implying that an asset was parsed.
    if (/新代币/u.test(binanceOfficial)) {
      return zh ? "Binance Alpha 上新；标的待解析" : "Binance Alpha listing; unresolved target";
    }
    return binanceOfficial;
  }

  const snapshotBefore = event?.previousSnapshot;
  const snapshotAfter = event?.currentSnapshot;
  if (snapshotBefore?.title && snapshotAfter?.title && snapshotBefore.title !== snapshotAfter.title) {
    return `${factValue(snapshotBefore.title)} → ${factValue(snapshotAfter.title)}`;
  }
  if (event?.type === "binance_official_update" && event?.kind === "announcement") {
    return firstFocusClause(binanceMeaningfulFact(event) || (zh ? "官方公告更新" : "Official announcement update"));
  }

  const pool = event?.type === "platform_capability_update" ? poolFocusKey(event, language) : null;
  if (pool) return pool;
  const addedModule = event?.type === "platform_capability_update" ? list(event?.changes?.newModules)[0] : null;
  if (addedModule) return zh ? `新增 ${factValue(addedModule)}` : `Added ${factValue(addedModule)}`;

  const githubChange = githubConcreteFocus(event, language);
  if (githubChange) return githubChange;
  if (event?.type === "github_repository_discovered") return zh
    ? repositoryPurpose(event) ? `仓库描述：${repositoryPurpose(event)}` : "发现新官方仓库"
    : repositoryPurpose(event) ? `Repository description: ${repositoryPurpose(event)}` : "New official repository discovered";
  if (event?.type === "github_repository_verified") return zh
    ? "官方归属已确认"
    : "Official ownership verified";
  const before = focusSideValue(changeModel.before, language);
  const after = focusSideValue(changeModel.after, language)
    || (zh ? "已确认更新，细节待解析" : "Update confirmed; details pending");
  const exactTransition = changeModel.before.state === "known"
    && ["modification", "escalation", "verification"].includes(changeModel.kind)
    && before;
  const value = exactTransition ? `${before} → ${after}` : after;
  // Evidence is rendered on its own row. Source-only events sometimes append
  // Factory/Quote/CA to the update prose; remove that suffix from the single
  // focus fact instead of repeating the same identifier on two rows.
  const compact = oneLine(value, 155)
    .replace(/\s*[·|]\s*(?:Factory|Quote|CA)\s+.+$/iu, "")
    .trim();
  return zh
    ? compact.replace(/新底池\s*\/\s*NEW\s+POOL\s*:?[：]?\s*/gi, "新底池: ")
    : compact.replace(/new\s+pool\s*\/\s*NEW\s+POOL\s*:?[：]?\s*/gi, "New pool: ");
}

function poolEvidence(event) {
  const pools = [
    ...list(event?.changes?.newFlapPools),
    ...(event?.kind === "flap_quote_asset_first_observed_after_gap"
      ? list(event?.changes?.updatedFlapPools)
      : []),
    ...list(event?.changes?.flapPoolChanges).map((item) => item?.after || item),
  ].filter(Boolean);
  if (!pools.length) return [];
  const quoteAssets = pools.filter((pool) => pool?.kind === "quote_asset");
  if (quoteAssets.length) {
    return quoteAssets.slice(0, 2).map((pool) => {
      const symbol = String(pool?.quoteSymbol || "").trim();
      const name = String(pool?.quoteName || "").replace(/\s+/g, " ").trim();
      const address = pool?.quoteAddress || pool?.quoteTokenAddress || pool?.quoteAssetAddress;
      const chainId = pool?.chainId ?? event?.chainId ?? event?.chain?.id;
      const label = [symbol, name].filter(Boolean).join(" · ");
      const value = [
        label || "Quote",
        address ? `CA ${factValue(address)}` : null,
        chainId != null ? `chainId=${factValue(chainId)}` : null,
      ].filter(Boolean).join(" · ");
      return { zh: value, en: value };
    });
  }
  const changedQuote = list(event?.changes?.flapPoolChanges).some((item) => {
    const before = item?.before || {};
    const after = item?.after || item || {};
    const quoteOf = (pool) => pool.quoteAddress || pool.quoteTokenAddress || pool.quoteAssetAddress
      || pool.quoteToken?.address || pool.quoteAsset?.address || pool.quoteAsset || pool.quoteToken;
    return quoteOf(before) && quoteOf(after) && String(quoteOf(before)) !== String(quoteOf(after));
  });
  const factory = pools.map((pool) => pool.factoryAddress || pool.factory?.address || pool.vaultFactoryAddress
    || pool.vaultFactory?.address || pool.vaultFactory || pool.factory).find(Boolean);
  const quote = changedQuote ? null : pools.map((pool) => pool.quoteAddress || pool.quoteTokenAddress || pool.quoteAssetAddress
    || pool.quoteToken?.address || pool.quoteAsset?.address || pool.quoteAsset || pool.quoteToken).find(Boolean);
  const chainId = pools.map((pool) => pool.chainId || pool.chain?.id).find((value) => value != null)
    ?? event?.chainId
    ?? event?.chain?.id;
  const chain = chainId != null ? `chainId=${factValue(chainId)}` : null;
  return [
    factory ? {
      zh: ["Factory", factValue(factory), chain].filter(Boolean).join(" "),
      en: ["Factory", factValue(factory), chain].filter(Boolean).join(" "),
    } : null,
    quote ? {
      zh: ["Quote", factValue(quote), factory ? null : chain].filter(Boolean).join(" "),
      en: ["Quote", factValue(quote), factory ? null : chain].filter(Boolean).join(" "),
    } : null,
  ].filter(Boolean);
}

function firstTokenAddress(event) {
  return event?.tokens?.[0]?.token || event?.token || event?.entry?.token || null;
}

function fomoPositionProofEvidence(event) {
  const proof = event?.positionProof || {};
  if (proof.status === "verified") return { zh: "仓位证明已核验", en: "Position proof verified" };
  if (proof.status) return { zh: `仓位证明 ${proof.status}`, en: `Position proof ${proof.status}` };
  const convergence = /convergence/i.test(String(event?.signalKind || ""));
  if (convergence) {
    const count = Number(event?.buyerCount) || list(event?.callers).length || list(event?.wallets).length;
    return count ? { zh: `链上聚合 ${count} KOL`, en: `On-chain aggregate ${count} KOL` } : null;
  }
  return { zh: "仓位证明未完整", en: "Position proof incomplete" };
}

function focusEvidence(event) {
  if (isPonFunRenderEvent(event)) return ponFunFocusEvidence(event);
  const pool = event?.type === "platform_capability_update" ? poolEvidence(event) : [];
  if (pool.length) return pool.slice(0, 2);

  if (flapAgenticFirstTokenCandidate(event)) {
    const token = firstTokenAddress(event);
    const transactionHash = String(event?.transactionHash || "").trim();
    return [{
      zh: `CA ${token} · Tx ${transactionHash}`,
      en: `CA ${token} · Tx ${transactionHash}`,
    }];
  }

  const hooklist = hooklistRegistryFacts(event);
  if (hooklist) {
    const revision = `Uniswap/hooklist${hooklist.shortSha ? `#${hooklist.shortSha}` : ""}`;
    if (hooklist.hookAddress && hooklist.relatedAddresses.length) {
      const related = hooklist.relatedAddresses.join(" · ");
      return [{
        zh: `Hook ${hooklist.hookAddress} · 关联 ${related}（角色待核）· #${hooklist.shortSha}`,
        en: `Hook ${hooklist.hookAddress} · Related ${related} (role pending) · #${hooklist.shortSha}`,
      }];
    }
    return [
      hooklist.hookAddress ? { zh: `Hook ${hooklist.hookAddress}`, en: `Hook ${hooklist.hookAddress}` } : null,
      { zh: revision, en: revision },
    ].filter(Boolean).slice(0, 2);
  }

  const agentNative = binanceAgentNativeDetails(event);
  if (agentNative?.launch) {
    const handle = String(event?.tweet?.handle || "binance").replace(/^@/, "");
    const postId = String(event?.tweet?.id || "").trim();
    const evidence = `@${handle}${postId ? ` · X#${postId}` : " · 官方 X"}`;
    return [{ zh: evidence, en: evidence }];
  }
  if (agentNative?.developer) return [{
    zh: "官方 Developer 文档 · llms.txt",
    en: "Official Developer docs · llms.txt",
  }];

  if (event?.type === "github_module_update") {
    const repository = event?.repository;
    const sha = shortGithubRevision(event);
    const file = githubRepresentativeFile(event);
    const interpretedZh = githubWeb3Interpretation(event, "zh");
    const interpretedEn = githubWeb3Interpretation(event, "en");
    const candidateTechnical = String(interpretedZh?.technical || interpretedEn?.technical || "").trim();
    const versionTransition = candidateTechnical.match(/^([^\s]+)\s+(v?\d+(?:\.\d+){1,3})\s*→\s*(v?\d+(?:\.\d+){1,3})$/);
    const technicalAlreadyInKey = event?.binanceChange?.classification === "sdk_maintenance"
      || (Boolean(versionTransition)
      && [interpretedZh?.summary, interpretedEn?.summary].every((summary) => {
        const rendered = String(summary || "");
        return versionTransition.slice(1).every((literal) => rendered.includes(literal));
      }));
    const technicalZh = technicalAlreadyInKey ? "" : String(interpretedZh?.technical || "").trim();
    const technicalEn = technicalAlreadyInKey ? "" : String(interpretedEn?.technical || interpretedZh?.technical || "").trim();
    const revision = repository && sha ? `${repository}#${sha}` : repository;
    const contract = event?.contract || list(event?.newContracts)[0];
    const commitTechnicalHint = String(event?.message || "").match(/\b[A-Za-z_$][A-Za-z0-9_$]*\([^\n()]{0,100}\)/)?.[0] || null;
    const supplemental = technicalZh || technicalEn
      ? null
      : commitTechnicalHint ? `Commit ref ${commitTechnicalHint}` : null;
    return [
      revision ? { zh: revision, en: revision } : null,
      technicalZh || technicalEn ? {
        zh: technicalZh ? `技术 ${technicalZh}` : `技术 ${technicalEn}`,
        en: technicalEn ? `Technical ${technicalEn}` : `Technical ${technicalZh}`,
      } : null,
      contract ? { zh: `CA ${contract}`, en: `CA ${contract}` } : null,
      supplemental ? { zh: supplemental, en: supplemental } : null,
      file ? { zh: file, en: file } : null,
    ].filter(Boolean);
  }
  if (event?.type === "github_monitor_gap") {
    const repository = event?.repository;
    const sha = shortGithubRevision(event);
    if (repository && sha) return [{ zh: `${repository}#${sha}`, en: `${repository}#${sha}` }];
    if (repository) {
      const contract = event?.contract || list(event?.changes?.newContracts)[0];
      return [
        { zh: repository, en: repository },
        contract ? { zh: `CA ${contract}`, en: `CA ${contract}` } : null,
      ].filter(Boolean).slice(0, 2);
    }
  }
  if (["github_repository_discovered", "github_repository_verified"].includes(event?.type) && event?.repository) {
    return [{ zh: event.repository, en: event.repository }];
  }

  if (event?.type === "twitter_update") {
    const handle = event?.tweet?.handle ? `@${event.tweet.handle}` : null;
    const post = event?.tweet?.id ? { zh: `Post ${event.tweet.id}`, en: `Post ${event.tweet.id}` } : null;
    return [handle ? { zh: handle, en: handle } : null, post].filter(Boolean).slice(0, 2);
  }

  const token = firstTokenAddress(event);
  if (event?.type === "bsc_launchpad_update") {
    const tracked = flapTrackedPoolTokenDetails(event);
    if (tracked) return [{ zh: `CA ${tracked.token}`, en: `CA ${tracked.token}` }];
    const mode = bscModeFacts(event);
    const technical = mode.templateId != null
      ? { zh: `templateId=${mode.templateId}`, en: `templateId=${mode.templateId}` }
      : mode.presetId != null
        ? { zh: `presetId=${mode.presetId}`, en: `presetId=${mode.presetId}` }
        : mode.selector
          ? { zh: `selector=${mode.selector}`, en: `selector=${mode.selector}` }
          : null;
    const factory = event?.factory || event?.launcher || event?.mode?.factory || event?.mode?.launcher;
    return [
      token ? { zh: `CA ${token}`, en: `CA ${token}` } : null,
      technical || (factory ? { zh: `Factory ${factory}`, en: `Factory ${factory}` } : null),
    ].filter(Boolean).slice(0, 2);
  }
  if (["evm_launchpad_update", "token_launch", "contract_deployed"].includes(event?.type)) {
    const factory = event?.factory || event?.launcher || event?.mode?.factory || event?.mode?.launcher;
    return [
      token ? { zh: `CA ${token}`, en: `CA ${token}` } : null,
      factory ? { zh: `Factory ${factory}`, en: `Factory ${factory}` } : null,
    ].filter(Boolean).slice(0, 2);
  }
  if (event?.type === "fomo_family_top_call") {
    const published = event?.signalKind === "fomo_published_call";
    const xCall = event?.signalKind === "fomo_x_call";
    const callId = event?.callId || event?.stableId || event?.thesis?.id;
    if (event?.signalKind === "high_profit_high_winrate_wallet_buy") {
      const wallet = event?.walletAddress;
      if (event?.tradingPriority) {
        const buyAmount = Number(event?.amountUsd) > 0 ? compactUsd(event.amountUsd) : null;
        const liquidity = compactMarketUsd(event?.market?.liquidityUsd);
        const marketCap = compactMarketUsd(event?.market?.marketCap);
        const risk = event?.security?.decision || "unknown";
        const market = [
          buyAmount && `Buy ${buyAmount}`,
          liquidity && `Liq ${liquidity}`,
          marketCap && `MC ${marketCap}`,
          `risk=${risk}`,
        ].filter(Boolean).join(" · ");
        return [
          token ? { zh: `CA ${token}`, en: `CA ${token}` } : null,
          market ? { zh: market, en: market } : null,
        ].filter(Boolean).slice(0, 2);
      }
      return [
        token ? { zh: `CA ${token}`, en: `CA ${token}` } : null,
        wallet ? { zh: `钱包 ${wallet}`, en: `Wallet ${wallet}` } : null,
      ].filter(Boolean).slice(0, 2);
    }
    if (xCall) {
      const observed = event?.walletAttribution?.status === "observed" && event?.walletAttribution?.verified === false;
      const wallet = event?.walletAddress;
      const postId = event?.tweet?.id;
      return [
        token ? { zh: `CA ${token}`, en: `CA ${token}` } : null,
        wallet ? {
          zh: `${observed ? "观测钱包" : "绑定钱包"} ${wallet}${postId ? ` · X#${postId}` : ""}`,
          en: `${observed ? "Observed wallet" : "Linked wallet"} ${wallet}${postId ? ` · X#${postId}` : ""}`,
        } : postId ? { zh: `X#${postId}`, en: `X#${postId}` } : null,
      ].filter(Boolean).slice(0, 2);
    }
    return [
      token ? { zh: `CA ${token}`, en: `CA ${token}` } : null,
      published && callId
        ? { zh: `callId=${callId}`, en: `callId=${callId}` }
        : fomoPositionProofEvidence(event),
    ].filter(Boolean).slice(0, 2);
  }
  if (event?.type === "early_activity_alert") {
    return [token ? { zh: `CA ${token}`, en: `CA ${token}` } : null].filter(Boolean);
  }
  if (event?.type === "binance_official_update") {
    if (event?.kind === "developer_update") {
      const developerCorpus = [event?.title, ...list(event?.keyChanges), ...list(event?.signal?.keyChanges)]
        .filter(Boolean).join(" ").replaceAll("\\", "").replaceAll("`", "");
      const endpoint = developerCorpus.match(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_{}<>.\-/]+/i)?.[0];
      if (endpoint) return [{ zh: `API ${endpoint}`, en: `API ${endpoint}` }];
    }
    const code = event?.article?.code;
    return [{
      zh: code ? `官方公告 · ${String(code).slice(0, 8)}` : "官方公告",
      en: code ? `Official notice · ${String(code).slice(0, 8)}` : "Official announcement",
    }];
  }
  if (event?.type === "uniswap_official_update" && event?.kind === "blog") {
    return [{ zh: "官方博客", en: "Official blog" }];
  }

  if (event?.type === "platform_capability_update") {
    const contract = list(event?.changes?.newContracts)[0] || event?.contract;
    const factory = event?.factory || event?.launcher;
    const url = event?.url || event?.sourceUrl
      || (event?.source && typeof event.source === "object" ? event.source.url : null)
      || list(event?.sources)[0];
    return [
      contract ? { zh: `Contract ${contract}`, en: `Contract ${contract}` } : null,
      factory ? { zh: `Factory ${factory}`, en: `Factory ${factory}` } : null,
      !contract && !factory && url ? { zh: url, en: url } : null,
    ].filter(Boolean).slice(0, 2);
  }

  const url = event?.url || event?.sourceUrl || event?.tweet?.url
    || (event?.source && typeof event.source === "object" ? event.source.url : null);
  const address = event?.contract || token;
  const factory = event?.factory || event?.launcher;
  const evidence = [
    address ? { zh: `CA ${address}`, en: `CA ${address}` } : null,
    factory ? { zh: `Factory ${factory}`, en: `Factory ${factory}` } : null,
    url ? { zh: url, en: url } : null,
  ].filter(Boolean);
  if (evidence.length) return evidence.slice(0, 2);
  return [{ zh: "官方来源", en: "Official source" }];
}

function selectEvidenceForCard(evidence) {
  const selected = [];
  let bilingualCost = 0;
  for (const item of list(evidence)) {
    const zh = String(item?.zh || "").trim();
    const en = String(item?.en || zh).trim();
    if (!zh && !en) continue;
    const cost = zh.length + en.length + 6;
    // Evidence is atomic: keep repo#sha, function/endpoint, CA or file whole,
    // in that order. If the next item would exceed the card's evidence budget,
    // omit the entire lower-priority item rather than truncating an identifier.
    if (selected.length && bilingualCost + cost > 400) break;
    selected.push({ zh, en });
    bilingualCost += cost;
    if (selected.length >= 3) break;
  }
  return selected;
}

function securityDecision(event) {
  return event?.security?.decision || event?.entry?.security?.decision || event?.entry?.securityDecision || null;
}

function tokenLikeEvent(event) {
  return Boolean(firstTokenAddress(event)) || ["token_launch", "early_activity_alert", "fomo_family_top_call"].includes(event?.type);
}

function fomoSafetyBoundary(event, language) {
  const zh = language === "zh";
  const security = securityDecision(event);
  if (security === "pass") return zh ? "安全初筛通过，非买入建议" : "Safety screened; not a buy recommendation";
  if (security === "block") return zh ? "本地安全门已拦截，非买入建议" : "Blocked by local safety gate; not a buy recommendation";
  return zh ? "安全状态待核，非买入建议" : "Safety pending; not a buy recommendation";
}

function fomoPositionTier(event, language) {
  const zh = language === "zh";
  const proof = event?.positionProof || {};
  const zero = proof.totalWalletPreRaw === "0" || proof.previousBalanceRaw === "0";
  if (proof.status !== "verified" || !zero) return zh ? "零仓位证明不完整" : "Zero-position proof incomplete";
  if (proof.phase === "immediately_before_transaction" && proof.totalWalletPreRaw === "0") {
    return zh ? "交易前全钱包零仓位" : "Whole-wallet zero position pre-transaction";
  }
  if (proof.phase === "previous_block" && proof.totalWalletPreRaw === "0") {
    return zh ? "前一区块全钱包零仓位" : "Whole-wallet zero position at previous block";
  }
  if (proof.phase === "previous_block") {
    return zh ? "前一区块代币零仓位" : "Token zero position at previous block";
  }
  return zh ? "来源仓位摘要已核验" : "Source position summary verified";
}

function fomoVerificationFact(event, language) {
  const zh = language === "zh";
  const separator = zh ? "；" : "; ";
  if (event?.signalKind === "high_profit_high_winrate_wallet_buy") {
    return [
      zh ? "链上买入确认" : "On-chain buy confirmed",
      fomoPositionTier(event, language),
      zh ? "GMGN 公开画像；钱包归属未验证" : "Public GMGN profile; wallet ownership unverified",
    ].join(separator);
  }
  if (event?.signalKind === "fomo_x_call") {
    const observed = event?.walletAttribution?.status === "observed" && event?.walletAttribution?.verified === false;
    const identity = observed
      ? (zh ? "GMGN 钱包关联仅观测" : "GMGN wallet link observed")
      : (zh ? "FomoScan 资料绑定" : "FomoScan profile link");
    return [
      zh ? "X 已核；非 Fomo 官方" : "X verified; not Fomo-official",
      identity,
    ].join(separator);
  }
  if (event?.signalKind === "fomo_published_call") {
    const official = event?.source?.trust === "official_authenticated_api";
    return official
      ? (zh ? "Fomo 认证 Feed 发布" : "Authenticated Fomo feed")
      : (zh ? "FomoScan 可信中继；非 Fomo 官方" : "Trusted FomoScan relay; not Fomo-official");
  }
  const convergence = /convergence/i.test(String(event?.signalKind || ""));
  return [
    zh ? "链上推断，非 Fomo 官方喊单" : "On-chain inference, not an official Fomo call",
    convergence
      ? (zh ? "多钱包链上聚合" : "Multi-wallet on-chain aggregate")
      : fomoPositionTier(event, language),
  ].join(separator);
}

function fomoStage(event, language) {
  const zh = language === "zh";
  const separator = zh ? "；" : "; ";
  return `${fomoVerificationFact(event, language)}${separator}${fomoSafetyBoundary(event, language)}`;
}

function bscStage(event, language) {
  const zh = language === "zh";
  const tracked = flapTrackedPoolTokenDetails(event);
  if (tracked) return zh
    ? `官方 TokenCreated + ${tracked.quoteSymbol} 配对；非自动交易`
    : `Official TokenCreated + ${tracked.quoteSymbol} pair; no automatic trading`;
  const onchain = Boolean(event?.transactionHash || event?.blockNumber != null || event?.featureFirstToken || event?.officialFirstToken);
  const security = securityDecision(event) || "unknown";
  const liquidity = typeof event?.security?.metrics?.liquidityConfirmed === "boolean"
    ? String(event.security.metrics.liquidityConfirmed)
    : "unknown";
  const boundary = security === "pass"
    ? (zh ? "安全初筛通过，非买入建议" : "Safety screening passed; not a buy recommendation")
    : security === "block"
      ? (zh ? "本地安全门已拦截" : "Blocked by local safety gate")
      : (zh ? "安全待核" : "safety pending");
  return `${boundary} · ${onchain ? (zh ? "链上已确认" : "On-chain confirmed") : (zh ? "官方模式已记录，链上待核" : "Official mode recorded; on-chain pending")} · security=${security} · liquidityConfirmed=${liquidity}`;
}

function focusStage(event, language = "zh", sourceStatus = "") {
  const zh = language === "zh";
  if (isPonFunRenderEvent(event)) return ponFunFocusStage(event, language);
  const flapQuote = flapQuotePairDetails(event);
  if (flapQuote) {
    if (flapQuote.firstObservedAfterGap) {
      const lag = flapRecoveryLagSummary(flapQuote, language);
      return zh
        ? `补扫首次观察 · ${lag} · 当前 Portal 配置与 ERC-20 元数据已核验；前一块状态无双源证明`
        : `First observed after a gap · ${lag} · current Portal config and ERC-20 metadata verified; prior-block state lacks two-source proof`;
    }
    if (flapQuote.delayedRecovery) {
      const lag = flapRecoveryLagSummary(flapQuote, language);
      return zh
        ? `断线恢复补报 · ${lag} · 原始 Portal 回执与 ERC-20 元数据已核验`
        : `Delayed recovery after disconnect · ${lag} · original Portal receipt and ERC-20 metadata verified`;
    }
    if (flapQuote.onchain) return zh
      ? "Portal 交易回执与 ERC-20 元数据已核验；后续播报该池第1–3个代币CA"
      : "Portal receipt and ERC-20 metadata verified; next: report token CAs #1–#3 from this pool";
    if (flapQuote.board && flapQuote.stage === "observed") return zh
      ? "Flap 官方看板首次确认观察到报价资产；名称/符号已解析，Portal 0→1 待确认"
      : "Flap official Board first confirmed the quote asset; name/symbol resolved, Portal 0→1 pending";
    if (flapQuote.board && flapQuote.stage === "live") return zh
      ? "Flap 官方看板与 ERC-20 元数据已核验"
      : "Flap official board and ERC-20 metadata verified";
    return zh
      ? "Flap 官方 X 已发布；Portal/看板启用待确认"
      : "Flap official X published; Portal/board enablement pending";
  }
  if (flapAgenticFirstTokenCandidate(event)) {
    const block = Number.isSafeInteger(Number(event?.blockNumber)) ? Number(event.blockNumber) : "?";
    return zh
      ? `newTokenV6#${block}；Agentic未归因，非买入建议`
      : `newTokenV6#${block}; Agentic unverified; not buy advice`;
  }
  const agentNative = binanceAgentNativeDetails(event);
  if (agentNative?.launch) return zh ? "官方已发布" : "Officially published";
  if (agentNative?.developer) return zh
    ? "官方文档入口已出现；产品可用范围待确认"
    : "Official docs entry published; product availability unconfirmed";
  if (agentNative) return zh ? "官方更新已确认；产品可用范围待确认" : "Official update confirmed; product availability unconfirmed";
  if (focusAgentSkillDetails(event)) return zh
    ? "官方 X 已发布；首个链上实币待确认"
    : "Official X post published; first live on-chain token unconfirmed";
  if (hooklistRegistryFacts(event)) return zh
    ? "归属/链上待核"
    : "Origin/on-chain pending";
  if (event?.type === "uniswap_official_update" && event?.kind === "blog") return zh
    ? "文章已发布；功能上线未证实"
    : "Article published; feature launch unverified";
  if (event?.type === "uniswap_official_update" && event?.kind === "github_release") return zh
    ? "GitHub Release 已发布；产品部署未确认"
    : "GitHub Release published; product deployment unconfirmed";
  if (event?.type === "fomo_family_top_call") return fomoStage(event, language);
  if (event?.type === "bsc_launchpad_update") return bscStage(event, language);
  const binanceDetails = binanceAnnouncementDetails(event);
  if (binanceDetails?.effectiveAt) {
    const effective = beijingMinute(binanceDetails.effectiveAt);
    if (effective) return language === "zh"
      ? `北京时间 ${effective} 生效`
      : `Effective ${effective} Beijing time`;
  }
  const security = securityDecision(event);
  if (security === "block") return zh ? "本地安全门已拦截" : "Blocked by local safety gate";
  if (security === "pass") return zh ? "安全初筛通过，非买入建议" : "Safety screening passed; not a buy recommendation";
  if (event?.pullRequest) {
    const association = String(event.pullRequest.authorAssociation || event.authorAssociation || "").toUpperCase();
    const trusted = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
    if (!trusted.has(association)) return zh
      ? "外部 PR，未合并"
      : "External PR; unmerged";
    return zh
      ? `PR ${event.pullRequest.draft ? "草稿" : "开放"}，未合并`
      : `PR ${event.pullRequest.draft ? "draft" : "open"}; not merged`;
  }
  if (event?.type === "github_module_update" && event?.binanceChange?.classification === "sdk_maintenance") return zh
    ? "SDK 维护发布已记录"
    : "SDK maintenance release recorded";
  const githubInterpretation = githubWeb3Interpretation(event, language);
  if (githubInterpretation?.maintenance) return zh
    ? "SDK/依赖维护已记录；未确认 Web3 产品功能变化"
    : "SDK/dependency maintenance recorded; no Web3 product change confirmed";
  if (githubInterpretation?.domain === "documentation") return zh
    ? "文档或示例已更新；链上行为未确认"
    : "Docs or examples updated; on-chain behavior unconfirmed";
  if (githubInterpretation?.domain === "api-deprecation") return zh
    ? "接口弃用已提交；集成方需迁移，发布状态待确认"
    : "API deprecation committed; integrations must migrate; release unconfirmed";
  if (event?.type === "github_module_update" && event?.binanceChange?.classification === "api_or_schema_change") return zh
    ? "API/schema 变更已提交，下游兼容性待验证"
    : "API/schema change committed; downstream compatibility pending";
  if (event?.type === "github_module_update") return zh ? "代码已提交，未确认上线" : "Code committed; release unconfirmed";
  if (event?.type === "github_monitor_gap") return zh ? "监控缺口待补齐" : "Monitoring gap unresolved";
  if (event?.type === "github_repository_discovered") return zh ? "仓库已发现，归属待核验" : "Repository found; ownership pending";
  if (event?.type === "github_repository_verified") return zh ? "官方归属已确认" : "Official ownership verified";
  if (event?.type === "platform_capability_update") {
    const deployed = list(event?.changes?.chainStageChanges).some((item) => item?.toStage === "deployed")
      || list(event?.changes?.newChains).some((item) => item?.stage === "deployed");
    return deployed
      ? (zh ? "官方称已部署，链上入口待核验" : "Officially reported deployed; on-chain entry pending")
      : (zh ? "官方来源已记录，启用待核验" : "Official source recorded it; activation pending");
  }
  if (event?.type === "contract_deployed") return zh ? "链上部署已确认" : "On-chain deployment confirmed";
  if (tokenLikeEvent(event)) return zh ? "安全状态待核验" : "Safety status pending";
  const explicitLive = /(?:已上线|现已上线|已发布|\blive\b|\bavailable\b)/iu.test(String(sourceStatus || ""));
  if (explicitLive) return zh ? "官方称已上线" : "Officially stated live";
  return zh ? "官方来源已确认" : "Official source confirmed";
}

function englishDelay(value) {
  return String(value || "")
    .replace(/延迟\s*(\d+)\s*天(?:(\d+)\s*小时)?/gu, (_match, days, hours) => `${days}d${hours ? `${hours}h` : ""} delay`)
    .replace(/延迟\s*(\d+)\s*小时(?:(\d+)\s*分)?/gu, (_match, hours, minutes) => `${hours}h${minutes ? `${minutes}m` : ""} delay`)
    .replace(/延迟\s*(\d+)\s*分钟/gu, "$1m delay")
    .replace(/延迟\s*(\d+)\s*秒/gu, "$1s delay");
}

function focusTime(event, sourceTime, language = "zh") {
  const flapQuote = flapQuotePairDetails(event);
  if (flapQuote?.recovery) {
    const occurred = beijingMinute(event?.delayedRecovery?.sourceOccurredAt || event?.occurredAt);
    const recovered = beijingMinute(event?.delayedRecovery?.recoveredAt || event?.observedAt);
    const delivery = beijingMinute(flapQuote.deliveryEvaluatedAt);
    return language === "zh"
      ? `原始发生=${occurred || "未取得"} CST · 恢复=${recovered || "未取得"} CST${delivery ? ` · 送达重试=${delivery} CST` : ""}`
      : `Original=${occurred || "unavailable"} CST · recovered=${recovered || "unavailable"} CST${delivery ? ` · delivery retry=${delivery} CST` : ""}`;
  }
  if (event?.type === "uniswap_official_update" && event?.kind === "blog" && !event?.publishedAt) {
    return language === "zh" ? "原文时间未取得" : "Source publication time unavailable";
  }
  const value = labelledValue(sourceTime) || eventTime(event) || (language === "zh" ? "时间未取得" : "Time unavailable");
  return localizedCstTime(value, language);
}

function buildFocusModel(event, changeModel, sourceLines, tradingPriority, showPriority) {
  const statusLine = sourceLines.slice(1).find((line) => /^状态[:：]/u.test(line));
  const timeLine = sourceLines.slice(1).find((line) => /^时间[:：]/u.test(line));
  const sourceStatus = statusLine ? labelledValue(statusLine) : "";
  if (event?.type === "fomo_monitor_health_update") {
    const summary = event.summary || {};
    const healthLabel = (status, language) => {
      const labels = language === "zh"
        ? { healthy: "正常", degraded: "降级", critical: "严重降级", disabled: "未启用", unknown: "未确认" }
        : { healthy: "healthy", degraded: "degraded", critical: "critical", disabled: "disabled", unknown: "unknown" };
      return labels[String(status || "unknown")] || labels.unknown;
    };
    const recovered = event.transition === "recovered";
    const updated = event.transition === "updated";
    const renderFacts = (language) => {
      const zh = language === "zh";
      const smart = summary.smartMoney || {};
      const x = summary.x || {};
      const outbox = summary.outbox || {};
      const prefix = recovered
        ? (zh ? "聚合监控已恢复稳定" : "Aggregate monitoring recovered and is stable")
        : updated
          ? (zh ? "严重降级范围已扩大" : "Critical degradation scope expanded")
          : (zh ? "持续严重降级已确认" : "Sustained critical degradation confirmed");
      const open = zh ? "（" : " (";
      const close = zh ? "）" : ")";
      return {
        transition: prefix,
        smartMoney: `Smart Money ${healthLabel(smart.status, language)}${open}${zh ? "准入" : "admitted"} ${Number(smart.admitted || 0)} / ${zh ? "新鲜" : "fresh"} ${Number(smart.fresh || 0)} / LKG ${Number(smart.lastKnownGood || 0)}${close}`,
        network: `BSC ${healthLabel(summary.bsc?.status, language)} · X ${healthLabel(x.status, language)}${open}${zh ? "在线" : "live"} ${Number(x.live || 0)}/${Number(x.eligible || 0)}${close}`,
        pipeline: `Thesis ${healthLabel(summary.thesis?.status, language)} · Fomo outbox ${healthLabel(outbox.status, language)}${open}${zh ? "待发" : "pending"} ${Number(outbox.pending || 0)} / ${zh ? "失败" : "failed"} ${Number(outbox.failed || 0)}${close}`,
      };
    };
    const zhHealth = renderFacts("zh");
    const enHealth = renderFacts("en");
    const healthText = (facts, language) => [facts.transition, facts.smartMoney, facts.network, facts.pipeline]
      .join(language === "zh" ? "｜" : " | ");
    return {
      eventType: event.type,
      priority: tradingPriority,
      showPriority,
      platform: { zh: "Fomo 监控 · 聚合健康", en: "Fomo Monitor · Aggregate health" },
      health: { zh: healthText(zhHealth, "zh"), en: healthText(enHealth, "en") },
      healthFacts: { zh: zhHealth, en: enHealth },
      time: {
        zh: focusTime(event, timeLine, "zh"),
        en: focusTime(event, timeLine, "en"),
      },
    };
  }
  if (event?.type === "telegram_news_update") {
    const zhFacts = telegramNewsFacts(event, "zh");
    const enFacts = telegramNewsFacts(event, "en");
    const sourceLanguage = dominantNarrativeLanguage(event?.news?.headline, event?.news?.summary);
    const occurredAt = event?.sourceOccurredAt || eventTime(event) || "时间未取得";
    return {
      eventType: event.type,
      priority: tradingPriority,
      showPriority,
      platform: {
        zh: `Telegram · @${String(event?.username || event?.channel?.username || "maxguruai").replace(/^@/, "")}`,
        en: `Telegram · @${String(event?.username || event?.channel?.username || "maxguruai").replace(/^@/, "")}`,
      },
      title: { zh: "频道线索", en: "Channel lead" },
      key: {
        zh: zhFacts.headline,
        en: enFacts.headline,
      },
      evidence: [
        { zh: `摘要：${zhFacts.summary}`, en: `Summary: ${enFacts.summary}` },
        { zh: `类型：${zhFacts.category} · ${zhFacts.sourceMarker}`, en: `Type: ${enFacts.category} · ${enFacts.sourceMarker}` },
      ],
      stage: {
        zh: "公开频道观察，待官方核实",
        en: "Public-channel observation; awaiting official verification",
      },
      time: {
        zh: localizedCstTime(occurredAt, "zh"),
        en: localizedCstTime(occurredAt, "en"),
      },
      telegramNews: {
        sourceMarker: zhFacts.sourceMarker,
        messageUrl: String(event?.messageUrl || ""),
        sourceLanguage,
        headline: { zh: zhFacts.headline, en: enFacts.headline },
        summary: { zh: zhFacts.summary, en: enFacts.summary },
        category: { zh: zhFacts.category, en: enFacts.category },
      },
    };
  }
  const rawPlatform = isGithubSkillUpdate(event) ? "Binance Skills" : focusProject(event);
  const trackedToken = flapTrackedPoolTokenDetails(event);
  const profitableWallet = event?.type === "fomo_family_top_call"
    && event?.signalKind === "high_profit_high_winrate_wallet_buy";
  const platform = profitableWallet
    ? { zh: rawPlatform, en: "High-profit/high-win-rate public wallet" }
    : rawPlatform === "监控" ? { zh: "监控", en: "Monitor" } : { zh: rawPlatform, en: rawPlatform };
  const announcementDetails = binanceAnnouncementDetails(event);
  const callThesis = publishedFomoCallDetails(event);
  const fomo = event?.type === "fomo_family_top_call"
    ? {
        verification: {
          zh: fomoVerificationFact(event, "zh"),
          en: fomoVerificationFact(event, "en"),
        },
        risk: {
          zh: fomoSafetyBoundary(event, "zh"),
          en: fomoSafetyBoundary(event, "en"),
        },
      }
    : null;
  const pon = isPonFunRenderEvent(event)
    ? {
        verification: {
          zh: ponFunVerificationFact(event, "zh"),
          en: ponFunVerificationFact(event, "en"),
        },
        risk: {
          zh: ponFunRiskBoundary(event, "zh"),
          en: ponFunRiskBoundary(event, "en"),
        },
      }
    : null;
  const flapQuoteDetails = flapQuotePairDetails(event);
  const flapQuote = flapQuoteDetails
    ? {
        verification: {
          zh: flapQuoteDetails.firstObservedAfterGap
            ? `补扫首次观察 · ${flapRecoveryLagSummary(flapQuoteDetails, "zh")} · 当前 Portal 回执已核验；此前是否新增/0→1 未证`
            : flapQuoteDetails.delayedRecovery
            ? `断线恢复补报 · ${flapRecoveryLagSummary(flapQuoteDetails, "zh")} · 原始 Portal 回执已核验`
            : flapQuoteDetails.onchain
            ? "Portal 回执 + ERC-20 元数据已核验；后续播报该池第1–3个代币CA"
            : flapQuoteDetails.board && flapQuoteDetails.stage === "observed"
              ? "官方看板首次确认观察到报价资产 + 名称/符号已解析；Portal 0→1 待确认"
            : flapQuoteDetails.board && flapQuoteDetails.stage === "live"
              ? "官方看板 + ERC-20 元数据已核验"
              : "官方 X 已验证；链上启用待确认",
          en: flapQuoteDetails.firstObservedAfterGap
            ? `First observed after a gap · ${flapRecoveryLagSummary(flapQuoteDetails, "en")} · current Portal receipt verified; prior listing/0→1 unproven`
            : flapQuoteDetails.delayedRecovery
            ? `Delayed recovery · ${flapRecoveryLagSummary(flapQuoteDetails, "en")} · original Portal receipt verified`
            : flapQuoteDetails.onchain
            ? "Portal receipt + ERC-20 metadata verified; next: report token CAs #1–#3 from this pool"
            : flapQuoteDetails.board && flapQuoteDetails.stage === "observed"
              ? "Official Board first confirmed the quote asset + name/symbol resolved; Portal 0→1 pending"
            : flapQuoteDetails.board && flapQuoteDetails.stage === "live"
              ? "Official board + ERC-20 metadata verified"
              : "Official X verified; on-chain enablement pending",
        },
        risk: {
          zh: flapQuoteDetails.firstObservedAfterGap
            ? flapQuoteDetails.bstock
              ? "仅确认当前启用；此前新增/0→1 未证；勿追价；bStock 代币不等于 ETF/股票所有权；非自动交易"
              : "仅确认当前启用；此前新增/0→1 未证；勿追价；报价代币有合约/流动性/可卖性风险；非自动交易"
            : flapQuoteDetails.delayedRecovery
            ? flapQuoteDetails.bstock
              ? "补报可能已被市场消化，勿追价；bStock 报价代币不等于 ETF/股票所有权；非自动交易"
              : "补报可能已被市场消化，勿追价；报价代币仍有合约、流动性与可卖性风险；非自动交易"
            : flapQuoteDetails.board && flapQuoteDetails.stage === "observed"
            ? `${flapQuoteDetails.boardMetadataDelayed ? "元数据延迟补齐，勿追价；" : ""}看板观察≠Portal 0→1；${flapQuoteDetails.bstock
              ? "bStock 不等于 ETF/股票所有权；核对预言机/背书/流动性/可卖性；非自动交易"
              : "报价代币仍有合约、流动性与可卖性风险；非自动交易"}`
            : flapQuoteDetails.bstock
            ? "bStock 报价代币不等于 ETF/股票所有权；仍需核对预言机、背书、流动性与可卖性；非自动交易"
            : "报价代币仍有合约、流动性与可卖性风险；非自动交易",
          en: flapQuoteDetails.firstObservedAfterGap
            ? flapQuoteDetails.bstock
              ? "Current state only; prior listing/0→1 unproven; do not chase; bStock token ≠ ETF/share ownership; no automatic trading"
              : "Current state only; prior listing/0→1 unproven; do not chase; quote-token contract/liquidity/sellability risk; no automatic trading"
            : flapQuoteDetails.delayedRecovery
            ? flapQuoteDetails.bstock
              ? "The recovery may already be priced in; do not chase; a bStock quote token is not ETF/share ownership; no automatic trading"
              : "The recovery may already be priced in; do not chase; quote-token contract, liquidity, and sellability risks remain; no automatic trading"
            : flapQuoteDetails.board && flapQuoteDetails.stage === "observed"
            ? `${flapQuoteDetails.boardMetadataDelayed ? "Late metadata; do not chase; " : ""}Board ≠ Portal 0→1; ${flapQuoteDetails.bstock
              ? "bStock is not ETF/share ownership; oracle/backing/liquidity risk; no automatic trading"
              : "quote-token contract/liquidity/sellability risk; no automatic trading"}`
            : flapQuoteDetails.bstock
            ? "A bStock quote token is not ETF/share ownership; verify oracle, backing, liquidity, and sellability; no automatic trading"
            : "Quote-token contract, liquidity, and sellability risks remain; no automatic trading",
        },
      }
    : null;
  return {
    eventType: event?.type,
    priority: tradingPriority,
    showPriority,
    platform,
    title: { zh: focusTitle(event, "zh"), en: focusTitle(event, "en") },
    key: {
      zh: focusKey(event, changeModel, "zh", tradingPriority),
      en: focusKey(event, changeModel, "en", tradingPriority),
    },
    evidence: selectEvidenceForCard(focusEvidence(event)),
    stage: { zh: focusStage(event, "zh", sourceStatus), en: focusStage(event, "en", sourceStatus) },
    time: { zh: focusTime(event, timeLine, "zh"), en: focusTime(event, timeLine, "en") },
    ...(announcementDetails?.kind === "instrument_change" ? { instrumentChange: announcementDetails } : {}),
    ...(callThesis ? { callThesis } : {}),
    ...(fomo ? { fomo } : {}),
    ...(pon ? { pon } : {}),
    ...(flapQuote ? { flapQuote } : {}),
    ...(trackedToken ? { flapTrackedToken: trackedToken } : {}),
  };
}

function tradingBrief(priority, language = "zh") {
  const zh = language === "zh";
  const plan = priority?.plan || {};
  const conclusion = plan.conclusion?.[language] || (zh ? "不做" : "Do not trade");
  if (["T0", "T1"].includes(priority?.tier)) {
    const perpetualMarket = priority.category === "binance_market_catalyst"
      && /(?:永续盘口|永续下架|资金费率|基差|Perpetual order book|Perpetual delisting|funding|basis)/iu.test([
        plan.capitalPath?.zh,
        plan.capitalPath?.en,
      ].filter(Boolean).join(" "));
    const tradFiPerpetual = perpetualMarket
      && /(?:现货股票|cash equity)/iu.test([plan.risk?.zh, plan.risk?.en].filter(Boolean).join(" "));
    const perpetualDelist = perpetualMarket
      && /(?:永续下架|perpetual delisting)/iu.test([plan.mainline?.zh, plan.mainline?.en].filter(Boolean).join(" "));
    const compact = priority.category === "pon_structural"
      ? {
          zh: ["平台注意力→后续市场", "标的+流动性+可卖性", "回滚/无承接"],
          en: ["platform attention→markets", "target+liquidity+sellability", "rollback/no support"],
        }
      : priority.category === "binance_security_emergency"
        ? {
            zh: ["平台风险→充提/交易/流动性", "核对范围+链上异常+恢复条件", "未恢复/风险扩大"],
            en: ["venue risk→funding/trading/liquidity", "verify scope+on-chain anomalies+recovery", "not recovered/risk expands"],
          }
      : priority.category === "binance_market_catalyst"
      ? perpetualMarket
        ? perpetualDelist
          ? {
              zh: ["永续下架→仓位/保证金/结算", "不新增仓位+核对生效", "未平仓/结算异常"],
              en: ["perpetual delist→position/margin/settlement", "no new position+verify timing", "open positions/settlement risk"],
            }
          : tradFiPerpetual
            ? {
                zh: ["永续→深度/持仓/资金费率/基差", "开盘深度+成交+持仓", "永续≠股票/深度不足"],
                en: ["perpetual→depth/OI/funding/basis", "depth+volume+OI", "perpetual≠stock/weak depth"],
              }
            : {
                zh: ["永续→深度/持仓/资金费率", "开盘深度+成交+持仓", "深度不足/费率失真"],
                en: ["perpetual→depth/OI/funding", "depth+volume+OI", "weak depth/distorted funding"],
              }
        : {
            zh: [
              oneLine(plan.capitalPath?.zh || "现货开盘→成交深度与价格发现", 70),
              oneLine(plan.entryCondition?.zh || "核对成交深度与价格发现", 70),
              oneLine(plan.invalidation?.zh || "深度不足或价格失真", 58),
            ],
            en: [
              oneLine(plan.capitalPath?.en || "Spot launch→trading depth and price discovery", 70),
              oneLine(plan.entryCondition?.en || "Verify trading depth and price discovery", 70),
              oneLine(plan.invalidation?.en || "Weak depth or distorted pricing", 58),
            ],
          }
      : priority.category === "binance_product"
        ? {
            zh: ["产品→资金入口", "标的+采用", "无直接资金流"],
            en: ["product→capital access", "target+adoption", "no direct flow"],
          }
      : priority.category?.startsWith("fomo_")
        ? {
            zh: ["钱包→流动性", priority.tier === "T0" ? "共振量价" : "第二钱包", "卖出受阻"],
            en: ["wallet→liquidity", priority.tier === "T0" ? "convergence+price-volume" : "second wallet", "sell blocked"],
          }
        : {
            zh: ["新模式→首币", "安全+量价", "回滚/无首币"],
            en: ["new mode→first token", "safety+price-volume", "rollback/no token"],
          };
    const [capitalPath, condition, invalidation] = compact[language];
    return zh
      ? `交易=${conclusion}；资金路径=${capitalPath}；入场=${condition}；失效=${invalidation}；非自动交易`
      : `Trade=${conclusion}; flow=${capitalPath}; entry=${condition}; invalid=${invalidation}; no auto-trading`;
  }
  return zh
    ? `交易：结论=${conclusion}；${priority?.tier === "T3" ? "仅摘要记录" : "等待精确标的与直接资金路径"}`
    : `Trade: conclusion=${conclusion}; ${priority?.tier === "T3" ? "digest only" : "wait for an exact target and direct capital path"}`;
}

function priorityFlashTime(value, language = "zh", priority = null) {
  if (priority?.category === "binance_market_catalyst"
    && priority?.window?.basis === "launchAt"
    && priority.window.launchAt) {
    const launchAt = new Date(priority.window.launchAt);
    if (!Number.isNaN(launchAt.getTime())) {
      const cst = beijingMinute(launchAt);
      const utc = launchAt.toISOString().slice(5, 16).replace("T", " ");
      return language === "zh"
        ? `开盘=${cst} CST（${utc} UTC）`
        : `Launch=${cst} CST (${utc} UTC)`;
    }
  }
  const source = String(value || "");
  // focusTime() may already have converted the source instant to an explicit
  // CST/UTC pair. Preserve that date and zone instead of reducing it to a
  // bare HH:mm clock below.
  if (/\bCST\b|北京时间/iu.test(source)) {
    return language === "zh" ? `发生=${source}` : `Occurred=${source}`;
  }
  const isoInstant = source.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})/u)?.[0];
  if (isoInstant) {
    const cst = beijingMinute(isoInstant);
    if (cst) return language === "zh" ? `发生=${cst} CST` : `Occurred=${cst} CST`;
  }
  const localMinute = source.match(/(?:^|\s)(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})/u);
  if (localMinute) {
    const cst = `${localMinute[2]}-${localMinute[3]} ${localMinute[4]}`;
    return language === "zh" ? `发生=${cst} CST` : `Occurred=${cst} CST`;
  }
  const clock = source.match(/(?:^|[T\s])(\d{2}:\d{2})(?::\d{2})?/u)?.[1];
  if (clock) return language === "zh" ? `时效=${clock}` : `Time:${clock}`;
  return language === "zh" ? "时效=见证据" : "Time:see evidence";
}

function renderFocusLines(focusModel, language = "zh") {
  const zh = language === "zh";
  const tier = focusModel.priority?.tier || "T2";
  const prioritySuffix = focusModel.showPriority ? ` · ${tier}` : "";
  const trackedTokenLines = renderFlapTrackedPoolTokenLines(focusModel, language);
  if (trackedTokenLines) return trackedTokenLines;
  if (focusModel.eventType === "fomo_monitor_health_update") {
    return [
      `${zh ? "平台：" : "Platform: "}${focusModel.platform[language]}${prioritySuffix}`,
      `${zh ? "更新了什么：" : "What changed: "}${focusModel.health[language]}`,
    ];
  }
  const evidence = focusModel.evidence.map((item) => item[language]).filter(Boolean);
  const separator = zh ? "｜" : " | ";
  const changed = [
    oneLine(focusModel.key[language], 10_000),
    focusModel.callThesis?.[language] ? oneLine(focusModel.callThesis[language], 10_000) : null,
    evidence.join(" · ") || (zh ? "官方来源" : "Official source"),
    focusModel.showPriority ? tradingBrief(focusModel.priority, language) : null,
    oneLine(focusModel.stage[language], 10_000),
    oneLine(focusModel.showPriority
      ? priorityFlashTime(focusModel.time[language], language, focusModel.priority)
      : focusModel.time[language], 10_000),
  ].filter(Boolean).join(separator);
  return [
    oneLine(`${zh ? "平台：" : "Platform: "}${focusModel.platform?.[language] || focusModel.title[language]}${prioritySuffix}`, 70),
    `${zh ? "更新了什么：" : "What changed: "}${changed}`,
  ];
}

// Keep the persisted retry bundle compact, but do not sacrifice the event
// mechanism or an exact target merely to preserve the retired 600-character
// display contract. Telegram delivery expands this into bounded fact lines.
const TWO_FIELD_COMBINED_BLOCK_BUDGET = 620;

function compactTextKeepingRequired(value, maximum, required = []) {
  const source = String(value || "");
  if (source.length <= maximum) return source;
  const retained = required
    .filter((literal) => source.includes(literal))
    .sort((left, right) => right.length - left.length);
  if (!retained.length) return oneLine(source, maximum);

  let prose = source;
  for (const literal of retained) prose = prose.replaceAll(literal, " ");
  prose = prose
    .replace(/\s*[·|｜]\s*(?=[·|｜]|$)/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  const suffix = ` · ${retained.join(" · ")}`;
  const room = maximum - suffix.length;
  // Protected literals take precedence over the prose budget. Returning a
  // slightly longer component is intentional; the bilingual fitter can take
  // that space from the other language or from non-technical components.
  return `${oneLine(prose, Math.max(18, room - 1))}${suffix}`.trim();
}

function compactEvidenceKeepingRequired(value, maximum, required = []) {
  const source = String(value || "").trim();
  if (source.length <= maximum) return source;
  const atoms = source.split(/\s+·\s+|｜|\s\|\s/u).map((atom) => atom.trim()).filter(Boolean);
  if (atoms.length < 2) return compactTextKeepingRequired(source, maximum, required);
  const literals = required.filter((literal) => source.includes(literal));
  const mandatory = new Set(atoms
    .map((atom, index) => literals.some((literal) => atom.includes(literal)) ? index : -1)
    .filter((index) => index >= 0));
  if (!mandatory.size) return oneLine(source, maximum);

  const render = (selected) => atoms.filter((_atom, index) => selected.has(index)).join(" · ");
  const selected = new Set(mandatory);
  const mandatoryText = render(selected);
  // Never detach `CA`/`selector=` (or another evidence label) from its value.
  // If exact evidence alone needs more room, the caller can reclaim it from
  // prose components or from the other language block.
  if (mandatoryText.length > maximum) return mandatoryText;
  for (let index = 0; index < atoms.length; index += 1) {
    if (selected.has(index)) continue;
    const candidate = new Set([...selected, index]);
    if (render(candidate).length <= maximum) selected.add(index);
  }
  return render(selected);
}

function compactTwoFieldLine(value, maximum, required = []) {
  const line = String(value || "");
  if (line.length <= maximum) return line;
  const prefix = line.match(/^(?:更新了什么|What changed)[:：]\s*/u)?.[0] || "";
  if (!prefix) return compactTextKeepingRequired(line, maximum, required);

  const body = line.slice(prefix.length);
  const separator = body.includes("｜") ? "｜" : body.includes(" | ") ? " | " : null;
  if (!separator) {
    return `${prefix}${compactTextKeepingRequired(
      body,
      Math.max(24, maximum - prefix.length),
      required,
    )}`;
  }

  const parts = body.split(separator);
  if (parts.length < 3) {
    return `${prefix}${compactTextKeepingRequired(
      body,
      Math.max(24, maximum - prefix.length),
      required,
    )}`;
  }

  const key = parts.shift() || "";
  const time = parts.pop() || "";
  const stage = parts.pop() || "";
  const tradeIndex = parts.findIndex((part) => /^(?:交易|Trade)[:=：]/u.test(part));
  const trade = tradeIndex >= 0 ? parts.splice(tradeIndex, 1)[0] : "";
  const evidence = parts.join(separator);

  // Preserve the proven v15 compaction path byte-for-byte for cards that do
  // not carry a production trading flash. This keeps compound evidence such
  // as repository#revision atomic while the new branch below budgets a fifth
  // trade component.
  if (!trade) {
    const compacted = [key, evidence, stage, time];
    const render = () => `${prefix}${compacted.filter(Boolean).join(separator)}`;
    const minimums = [30, 0, 24, 20];
    for (const index of [3, 2, 0]) {
      if (render().length <= maximum) break;
      const excess = render().length - maximum;
      const nextMaximum = Math.max(minimums[index], compacted[index].length - excess);
      compacted[index] = oneLine(compacted[index], nextMaximum);
    }
    let output = render();
    const missing = required.filter((literal) => line.includes(literal) && !output.includes(literal));
    if (missing.length) {
      compacted[1] = [compacted[1], missing.join(" · ")].filter(Boolean).join(" · ");
      output = render();
    }
    if (output.length <= maximum) return output;
    const fixedLength = prefix.length
      + compacted[0].length + compacted[2].length + compacted[3].length
      + (separator.length * 3);
    compacted[1] = compactTextKeepingRequired(
      compacted[1],
      Math.max(24, maximum - fixedLength),
      required.filter((literal) => line.includes(literal)),
    );
    return render();
  }

  let compacted = [key, evidence, trade, stage, time];
  const render = () => `${prefix}${compacted.filter(Boolean).join(separator)}`;

  const compactTrade = (value) => {
    const conclusion = String(value).match(/(?:结论|conclusion)=([^；;]+)/iu)?.[1]?.trim();
    return value.startsWith("交易")
      ? `交易=${conclusion || "观察"}；非自动交易`
      : `Trade=${conclusion || "Watch"}; no auto-trading`;
  };
  const timeMinimum = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z/u.test(time)
    ? time.length
    : Math.min(time.length, 10);
  const originals = [key, evidence, trade, stage, time];
  const requiredFor = (index) => required.filter((literal) => originals[index].includes(literal));
  const minimums = [40, 0, trade ? compactTrade(trade).length : 0, 24, timeMinimum];
  for (const index of [4, 2, 3, 0]) {
    if (render().length <= maximum) break;
    if (index === 2 && compacted[index]) {
      compacted[index] = compactTrade(compacted[index]);
      continue;
    }
    const excess = render().length - maximum;
    const nextMaximum = Math.max(minimums[index], compacted[index].length - excess);
    compacted[index] = compactTextKeepingRequired(compacted[index], nextMaximum, requiredFor(index));
  }

  let output = render();
  const missing = required.filter((literal) => line.includes(literal) && !output.includes(literal));
  if (missing.length) {
    compacted[1] = [compacted[1], missing.join(" · ")].filter(Boolean).join(" · ");
    output = render();
  }
  if (output.length <= maximum) return output;

  const fixedLength = prefix.length
    + compacted[0].length + compacted[2].length + compacted[3].length + compacted[4].length
    + (separator.length * compacted.filter(Boolean).length - separator.length);
  compacted[1] = compactEvidenceKeepingRequired(
    compacted[1],
    Math.max(24, maximum - fixedLength),
    required.filter((literal) => line.includes(literal)),
  );
  output = render();
  if (output.length <= maximum) return output;

  // Missing required evidence may have expanded the line after the first key
  // pass. Reclaim the exact excess from chain-controlled display prose while
  // retaining bounded symbols and every technical literal atomically.
  const keyMaximum = Math.max(24, compacted[0].length - (output.length - maximum));
  compacted[0] = compactTextKeepingRequired(compacted[0], keyMaximum, requiredFor(0));
  return render();
}

function fitTwoFieldBilingualLines(chineseLines, englishLines, chineseRequired = [], englishRequired = [], maximum = TWO_FIELD_COMBINED_BLOCK_BUDGET) {
  const originals = [chineseLines, englishLines].map((lines) => lines.slice(0, MAX_CARD_LINES).map(String));
  const required = [chineseRequired, englishRequired];
  const length = (blocks) => blocks.reduce((total, lines) => total + lines.join("\n").length, 0);
  let blocks = originals.map((lines) => lines.slice());
  if (length(blocks) <= maximum) return blocks;

  const changedMinimum = 100;
  while (length(blocks) > maximum) {
    const candidate = [0, 1]
      .filter((block) => blocks[block]?.[1]?.length > changedMinimum)
      .sort((left, right) => blocks[right][1].length - blocks[left][1].length)[0];
    if (candidate === undefined) break;
    const excess = length(blocks) - maximum;
    const previous = blocks[candidate][1];
    blocks[candidate][1] = compactTwoFieldLine(
      blocks[candidate][1],
      Math.max(changedMinimum, blocks[candidate][1].length - Math.min(12, excess)),
      required[candidate],
    );
    if (blocks[candidate][1] === previous) break;
  }
  if (length(blocks) <= maximum) return blocks;

  const platformMinimum = 24;
  while (length(blocks) > maximum) {
    const candidate = [0, 1]
      .filter((block) => blocks[block]?.[0]?.length > platformMinimum)
      .sort((left, right) => blocks[right][0].length - blocks[left][0].length)[0];
    if (candidate === undefined) break;
    const excess = length(blocks) - maximum;
    blocks[candidate][0] = oneLine(
      blocks[candidate][0],
      Math.max(platformMinimum, blocks[candidate][0].length - Math.min(8, excess)),
    );
  }
  return blocks;
}

function normalizePublishedCallChineseFallback(lines, baseLines, event, status) {
  const publishedCall = event?.type === "fomo_family_top_call"
    && ["fomo_published_call", "fomo_x_call"].includes(event?.signalKind);
  return lines.map((line, index) => {
    const value = String(line || "");
    if (index !== 1) {
      // Title, evidence and stage are deterministic local facts. Translation
      // outages must not label these already-localized rows as English prose.
      return value.replace(/^((?:证据|阶段\/时间)\s*[:：]\s*)英文原文\s*[:：]\s*/u, "$1")
        .replace(/^英文原文\s*[:：]\s*/u, "");
    }
    if (!publishedCall) return value;
    // Published/X calls are rendered locally. Their explicit 原文 label is a
    // fact about provenance, not a translation-failure wrapper around the
    // whole card, so keep it attached to the bounded thesis.
    if (/(?:英文原文|观点)[:：]/u.test(value)) {
      return value.replace(/英文原文\s*:\s*/u, "英文原文：");
    }
    const sourceNarrative = String(event?.thesis?.text || event?.body || "").trim();
    const sourceFocus = firstFocusClause(sourceNarrative);
    const sourceLatin = (sourceNarrative.match(/[A-Za-z]/g) || []).length;
    const sourceChinese = (sourceNarrative.match(/[\u3400-\u9fff]/g) || []).length;
    const narrative = labelledValue(value);
    const latin = (narrative.match(/[A-Za-z]/g) || []).length;
    const chinese = (narrative.match(/[\u3400-\u9fff]/g) || []).length;
    const fellBack = ["fallback_source", "partial_fallback"].includes(status);
    if (fellBack
      && sourceNarrative
      && sourceLatin >= 8
      && sourceChinese < Math.max(2, Math.floor(sourceLatin * 0.12))
      && sourceFocus
      && value.includes(sourceFocus)
      && !value.includes(`原文：${sourceFocus}`)) {
      return value.replace(sourceFocus, `原文：${sourceFocus}`);
    }
    if (fellBack && latin >= 8 && chinese < Math.max(2, Math.floor(latin * 0.12))) {
      return `更新了什么：原文：${labelledValue(baseLines[index]) || narrative}`;
    }
    return line;
  });
}

function telegramNewsLeadWithRequiredLiterals(line, required, fixedLines, maximum = 140) {
  let output = oneLine(line, maximum);
  const fixed = fixedLines.join("\n");
  const requiredInLead = required.filter((literal) => !fixed.includes(literal));
  const missing = requiredInLead.filter((literal) => !output.includes(literal));
  if (!missing.length) return output;

  // Translation validation normally guarantees this set is empty. If a public
  // provider fails or expands the prose, retain every technical literal in the
  // fact row without changing any source/trust field.
  const retained = [...new Set(requiredInLead)];
  let narrative = String(line || "");
  for (const literal of retained.sort((left, right) => right.length - left.length)) {
    narrative = narrative.replaceAll(literal, " ");
  }
  narrative = narrative.replace(/\s*[·|｜]\s*(?=[·|｜]|$)/gu, " ").replace(/\s+/g, " ").trim();
  const suffix = retained.join(" · ");
  const room = Math.max(28, maximum - suffix.length - 3);
  output = `${oneLine(narrative, room)} · ${suffix}`.trim();
  return output;
}

function telegramSourceNarrativeResult(focusModel, language) {
  const sourceLanguage = focusModel.telegramNews?.sourceLanguage || "en";
  return {
    lines: [
      focusModel.telegramNews?.headline?.[sourceLanguage] || focusModel.key?.[sourceLanguage],
      focusModel.telegramNews?.summary?.[sourceLanguage],
    ].map((value) => String(value || "").trim()),
    status: "not_needed",
    provider: "telegram_source_narrative",
    latencyMs: 0,
    error: null,
    language,
  };
}

async function translateTelegramNewsNarrative(focusModel, options, language) {
  const sourceLanguage = focusModel.telegramNews?.sourceLanguage || "en";
  const source = telegramSourceNarrativeResult(focusModel, sourceLanguage);
  if (language === sourceLanguage) return source;
  const narrative = source.lines.join("\n");
  const narrativeTerms = list(options.protectedTerms)
    .filter((literal) => narrative.includes(String(literal)));
  return translateAlertLines(source.lines, {
    ...options,
    protectedTerms: narrativeTerms,
    targetLanguage: language === "zh" ? "zh-CN" : "en",
  });
}

function resolvedTelegramNewsNarrative(result, focusModel, language) {
  const zh = language === "zh";
  const sourceLanguage = focusModel.telegramNews?.sourceLanguage || "en";
  const sourceSide = language === sourceLanguage;
  const unavailable = !sourceSide && ["fallback_source", "partial_fallback"].includes(result?.status);
  const source = telegramSourceNarrativeResult(focusModel, sourceLanguage).lines;
  return {
    headline: unavailable
      ? (zh
          ? "中文翻译暂不可用；英文原文已保留在下方英文区"
          : "English translation unavailable; Chinese source retained in the Chinese section above")
      : oneLine(sourceSide ? source[0] : result?.lines?.[0], MAX_TELEGRAM_NARRATIVE_LENGTH),
    summary: unavailable ? null : oneLine(sourceSide ? source[1] : result?.lines?.[1], MAX_TELEGRAM_NARRATIVE_LENGTH),
    unavailable,
  };
}

function finalizeTelegramNewsLines(result, focusModel, language, required) {
  const zh = language === "zh";
  const narrative = resolvedTelegramNewsNarrative(result, focusModel, language);
  const headline = narrative.headline;
  const summary = narrative.summary;
  const separator = zh ? "｜" : " | ";
  const category = focusModel.telegramNews?.category?.[language] || (zh ? "未分类" : "Unclassified");
  const facts = [
    headline || (zh ? "标题未取得" : "Headline unavailable"),
    summary ? `${zh ? "摘要：" : "Summary: "}${summary}` : null,
    `${zh ? "类型：" : "Type: "}${category} · ${focusModel.telegramNews?.sourceMarker}`,
    focusModel.showPriority ? tradingBrief(focusModel.priority, language) : null,
    focusModel.stage?.[language],
    focusModel.time?.[language],
  ].filter(Boolean).join(separator);
  const visibleRequired = required.filter((literal) => !/^(?:CST|UTC|GMT)$/iu.test(String(literal)));
  return ensureTechnicalLiterals([
    `${zh ? "平台：" : "Platform: "}${focusModel.platform?.[language]}`,
    `${zh ? "更新了什么：" : "What changed: "}${facts}`,
  ], visibleRequired, language);
}

function compactTelegramUsd(value, unit = "") {
  const normalizedUnit = String(unit || "").toLowerCase();
  const suffix = ["million", "mn", "m"].includes(normalizedUnit)
    ? "m"
    : ["billion", "bn", "b"].includes(normalizedUnit)
      ? "b"
      : ["thousand", "k"].includes(normalizedUnit)
        ? "k"
        : normalizedUnit;
  return `$${String(value || "").replace(/\s+/g, "")}${suffix}`;
}

function compactChineseTelegramUsd(value, unit) {
  const amount = Number(String(value || "").replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const millions = unit === "亿" ? amount * 100 : amount / 100;
  const compact = (number) => Number(number.toPrecision(12)).toLocaleString("en-US", {
    useGrouping: false,
    maximumFractionDigits: 6,
  });
  if (millions >= 1) return `$${compact(millions)}m`;
  if (millions * 1_000 >= 1) return `$${compact(millions * 1_000)}k`;
  return `$${compact(millions * 1_000_000)}`;
}

function telegramUsdAmountKey(value, unit = "") {
  const amount = Number(String(value || "").replace(/,/g, ""));
  if (!Number.isFinite(amount)) return null;
  const normalizedUnit = String(unit || "").toLowerCase();
  const multiplier = normalizedUnit === "万" ? 10_000
    : normalizedUnit === "亿" ? 100_000_000
      : ["thousand", "k"].includes(normalizedUnit) ? 1_000
        : ["million", "mn", "m"].includes(normalizedUnit) ? 1_000_000
          : ["billion", "bn", "b"].includes(normalizedUnit) ? 1_000_000_000
            : 1;
  return String(Number((amount * multiplier).toPrecision(12)));
}

function telegramPriceDisplay(value, unit = "") {
  if (["万", "亿"].includes(unit)) return compactChineseTelegramUsd(value, unit);
  if (unit) return compactTelegramUsd(value, unit);
  return String(value || "").replace(/\s+/g, "");
}

function telegramNewsNumericAtoms(values, language = "zh") {
  const zh = language === "zh";
  const source = values.map((value) => String(value || "")).filter(Boolean).join("；");
  if (!source) return [];
  const atoms = [];
  const seen = new Set();
  const add = (value) => {
    const atom = String(value || "").trim();
    if (!atom || seen.has(atom.toLowerCase())) return;
    seen.add(atom.toLowerCase());
    atoms.push(atom);
  };
  const priceValues = new Set();
  const directionFor = (value) => {
    if (/下跌|跌至|跌破|下探|下降|回落|\b(?:fell|falls?|down|dropped?|declined?|slid)\b/iu.test(value)) {
      return zh ? "下跌" : "down";
    }
    if (/上涨|涨至|涨破|升至|上探|突破|\b(?:rose|rises?|up|gained?|climbed?|surged?)\b/iu.test(value)) {
      return zh ? "上涨" : "up";
    }
    return "";
  };
  for (const [symbol, alias] of [
    ["BTC", "(?:BTC|Bitcoin|比特币)"],
    ["ETH", "(?:ETH|Ethereum|以太坊)"],
  ]) {
    const pattern = new RegExp(`${alias}.{0,48}?(?:跌至|跌到|跌破|涨至|涨破|升至|下探|上探|报|为|价格(?:为|报)?|(?:fell|falls?|dropped?|declined?|slid)\\s+(?:to|below)|(?:rose|rises?|gained?|climbed?|surged?)\\s+(?:to|above)|traded\\s+at|at|to|around)\\s*(?:约|about\\s+|around\\s+|approximately\\s+)?(?:US\\$|\\$|USD\\s*)?(\\d[\\d,]*(?:\\.\\d+)?)\\s*(万|亿|thousand|million|billion|mn|bn|[kmb])?\\s*(?:美元|美金)?`, "giu");
    const matches = [...source.matchAll(pattern)];
    for (const item of matches) {
      const key = telegramUsdAmountKey(item[1], item[2]);
      if (key) priceValues.add(key);
    }
    // Prefer a point price (fell/rose to) over a headline boundary (below/above).
    // The latter is still retained when it is the only price, but must not
    // displace a more precise spot value from the source summary.
    const pointPrices = matches.filter((item) => !/(?:跌破|涨破|\b(?:below|above)\b)/iu.test(item[0]));
    const candidates = pointPrices.length ? pointPrices : matches;
    const precise = candidates.filter((item) => item[1].includes(","))
      .sort((left, right) => left[0].length - right[0].length);
    const match = precise[0] || candidates.sort((left, right) => left[0].length - right[0].length)[0];
    if (!match) continue;
    const price = telegramPriceDisplay(match[1], match[2]);
    const direction = directionFor(match[0]) || directionFor(source);
    add([symbol, direction, price].filter(Boolean).join(" "));
  }
  const clauses = source.split(/[。；;]\s*|(?<!\d)\.\s+/u).filter(Boolean);
  for (const clause of clauses) {
    const flow = /净?流出|\b(?:net\s+)?outflows?\b/iu.test(clause)
      ? (zh ? "净流出" : "outflow")
      : /净?流入|\b(?:net\s+)?inflows?\b/iu.test(clause)
        ? (zh ? "净流入" : "inflow")
        : "";
    for (const match of clause.matchAll(/(?:US\$|\$|USD\s*)\s*(\d[\d,]*(?:\.\d+)?)\s*(million|billion|thousand|mn|bn|[kmb])?\b/giu)) {
      if (priceValues.has(telegramUsdAmountKey(match[1], match[2]))) continue;
      add([flow, compactTelegramUsd(match[1], match[2])].filter(Boolean).join(" "));
    }
    for (const match of clause.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(万|亿)\s*(?:美元|美金)/gu)) {
      if (priceValues.has(telegramUsdAmountKey(match[1], match[2]))) continue;
      const compact = compactChineseTelegramUsd(match[1], match[2]);
      if (compact) add([flow, compact].filter(Boolean).join(" "));
    }
  }
  for (const match of source.matchAll(/(?<![A-Za-z0-9.])(\d+(?:\.\d+)?)\s*(x|倍|times?|%|％)(?![A-Za-z0-9])/giu)) {
    const unit = /^(?:x|倍|times?)$/iu.test(match[2]) ? "x" : "%";
    add(`${match[1]}${unit}`);
  }
  return atoms;
}

function telegramNumericFactLines(atoms, language = "zh") {
  const zh = language === "zh";
  const delimiter = " · ";
  const groups = [[]];
  for (const atom of atoms) {
    const group = groups.at(-1);
    const label = groups.length === 1 ? (zh ? "数字：" : "Numbers: ") : (zh ? "数字续：" : "Numbers cont.: ");
    const candidate = [...group, atom].join(delimiter);
    if (group.length && label.length + candidate.length > MAX_TARGET_LINE_LENGTH && groups.length < 2) groups.push([atom]);
    else group.push(atom);
  }
  return groups.filter((group) => group.length).map((group, index) => {
    const label = index === 0 ? (zh ? "数字：" : "Numbers: ") : (zh ? "数字续：" : "Numbers cont.: ");
    return `${label}${group.join(delimiter)}`;
  });
}

function translationMeta(result, fallbackStatus = null) {
  return {
    status: fallbackStatus || result.status,
    provider: result.provider,
    latencyMs: result.latencyMs,
    error: result.error || null,
  };
}

function usesLocalStructuredChineseFocus(event) {
  return event?.type === "github_module_update"
    && isBinanceGithubUpdate(event)
    && Boolean(event?.binanceChange?.classification);
}

function usesLocalStructuredBilingualFocus(event) {
  return event?.type === "fomo_monitor_health_update"
    || Boolean(flapTrackedPoolTokenDetails(event))
    || Boolean(publishedFomoCallDetails(event))
    || isPonFunRenderEvent(event)
    || event?.type === "github_module_update"
    || event?.type === "uniswap_official_update"
    || Boolean(binanceAgentNativeDetails(event))
    || flapAgenticFirstTokenCandidate(event)
    || flapQuotePairDetails(event)?.recovery === true
    || Boolean(interpretPlatformPoolChange(event, "zh"))
    || Boolean(interpretTwitterWeb3Update(event, "zh"))
    || Boolean(interpretBinanceOfficialUpdate(event, "zh"));
}

function localStructuredResult(lines, { language = "zh", deliveryBudgetFallback = false, event = null } = {}) {
  const publishedCall = Boolean(publishedFomoCallDetails(event));
  const rendered = lines.map((line, index) => {
    const value = oneLine(line, index === 1 ? 10_000 : 70);
    if (language !== "zh" || !deliveryBudgetFallback || index !== 1) return value;
    if (publishedCall) return value;
    const narrative = labelledValue(value);
    const latin = (narrative.match(/[A-Za-z]/g) || []).length;
    const chinese = (narrative.match(/[\u3400-\u9fff]/g) || []).length;
    if (latin < 8 || chinese >= Math.max(2, Math.floor(latin * 0.12))) return value;
    return value.replace(/^((?:更新了什么|What changed)\s*[:：]\s*)/u, "$1英文原文: ");
  });
  const sourceNarrative = String(event?.thesis?.text || event?.body || "").trim();
  const sourceLatin = (sourceNarrative.match(/[A-Za-z]/g) || []).length;
  const sourceChinese = (sourceNarrative.match(/[\u3400-\u9fff]/g) || []).length;
  const untranslatedFomoCall = publishedCall
    && sourceLatin >= 8
    && sourceChinese < Math.max(2, Math.floor(sourceLatin * 0.12));
  const untranslatedSource = deliveryBudgetFallback
    && language === "zh"
    && (rendered.some((line) => /英文原文\s*[:：]/u.test(line)) || untranslatedFomoCall);
  return {
    lines: rendered,
    status: untranslatedSource ? "fallback_source" : "not_needed",
    provider: "local_structured",
    latencyMs: 0,
    error: untranslatedSource ? "translation skipped for critical delivery budget" : null,
  };
}

export async function buildBilingualAlertBundle(config, event, baseMessage) {
  const rawLines = String(baseMessage || "").split(/\r?\n/)
    .map((line) => decodeAlertDisplayEntities(line).replace(/\s+/g, " ").trim())
    .filter(Boolean);
  let changeModel = deriveAlertChangeModel(event);
  // Parse every original fact before selecting the four compact output rows.
  // Condensing here would merge/drop status or time before we can prioritize it.
  const sourceLines = rawLines.map((line) => oneLine(line));
  const sourceUpdate = event?.type === "telegram_news_update"
    ? null
    : sourceLines.slice(1).find((line) => /^(?:具体更新|关键变化|关键差异|结论|变化|事件|重点|内容|范围)[:：]/u.test(line));
  if (sourceUpdate) {
    const text = replaceRawJsonPayload(sourceUpdate.replace(/^.{1,28}?[:：]\s*/u, ""));
    const comparableFact = (value) => String(value || "")
      .replace(/^.{1,28}?[:：]\s*/u, "")
      .replace(/[…\s；;·]/gu, "")
      .toLowerCase();
    const comparableText = comparableFact(text);
    const modelHasNarrative = changeModel.after.items.some((item) => {
      const comparableItem = comparableFact(item);
      const minimum = Math.min(comparableItem.length, comparableText.length, 72);
      return item.includes(text) || text.includes(item)
        || (minimum >= 24 && comparableItem.slice(0, minimum) === comparableText.slice(0, minimum));
    });
    const unresolvedPlatformModel = event?.type === "platform_capability_update"
      && changeModel.after.items.length <= 1
      && changeModel.after.items.every((item) => /能力快照变化.*(?:未解析|待解析)/u.test(String(item)));
    // Platform events normally trust their exact structured diff. A source-only
    // event has no usable diff, so retain its concise verified update instead of
    // showing the generic "snapshot changed" placeholder.
    if ((event?.type !== "platform_capability_update" || unresolvedPlatformModel) && !modelHasNarrative) {
      const remainingItems = (unresolvedPlatformModel ? [] : changeModel.after.items).filter((item) => {
        const value = item.replace(/^.{1,36}?[:：]\s*/u, "").replace(/（[^）]*）/gu, "").trim();
        return !value || !text.includes(value);
      });
      changeModel = {
        ...changeModel,
        after: {
          state: "known",
          text: [text, ...remainingItems].join("；"),
          items: [text, ...remainingItems],
        },
      };
    }
  }
  const showPriority = isTradingPriority(event?.tradingPriority);
  const tradingPriority = tradingPriorityForEvent(event);
  const focusModel = buildFocusModel(event, changeModel, sourceLines, tradingPriority, showPriority);
  const chineseBaseLines = renderFocusLines(focusModel, "zh");
  const englishBaseLines = renderFocusLines(focusModel, "en");
  // The compact renderer intentionally validates only the one or two identifiers selected into
  // the focus card. The immutable event and Telegram buttons retain the full
  // evidence set without re-expanding it into the notification body.
  const delayedPonRecovery = isPonFunRenderEvent(event)
    && event?.delayedRecovery?.version === 1
    && event.delayedRecovery?.reason === "monitoring_gap_recovery";
  const flapQuoteRecovery = flapQuotePairDetails(event);
  const delayedFlapRecovery = flapQuoteRecovery?.delayedRecovery === true;
  const firstObservedFlapRecovery = flapQuoteRecovery?.firstObservedAfterGap === true;
  const delayedRequiredLiterals = (lines) => requiredTechnicalLiterals(lines, event)
    .filter((literal) => !delayedPonRecovery
      || event?.type !== "pon_fun_update"
      || !new Set(["factory", String(event?.factory || "").toLowerCase()])
        .has(String(literal).toLowerCase()));
  const chineseRequired = [
    ...delayedRequiredLiterals(chineseBaseLines),
    ...(delayedPonRecovery ? ["监控恢复补报", "勿追价"] : []),
    ...(delayedFlapRecovery ? ["断线恢复补报", "勿追价", "非自动交易"] : []),
    ...(firstObservedFlapRecovery ? ["补扫首次观察", "0→1", "勿追价", "非自动交易"] : []),
  ];
  const englishRequired = [
    ...delayedRequiredLiterals(englishBaseLines),
    ...(delayedPonRecovery ? ["Delayed recovery", "do not chase"] : []),
    ...(delayedFlapRecovery ? ["Delayed recovery", "do not chase", "no automatic trading"] : []),
    ...(firstObservedFlapRecovery ? ["First observed", "0→1", "do not chase", "no automatic trading"] : []),
  ];
  const options = {
    endpoint: config.alertTranslationUrl,
    fallbackEndpoint: config.alertTranslationFallbackUrl,
    timeoutMs: config.alertTranslationTimeoutMs,
    fetchImpl: config.alertTranslationFetchImpl,
    protectedTerms: protectedTerms(event),
  };
  const criticalTradingTier = showPriority && ["T0", "T1"].includes(tradingPriority.tier);
  const localBilingual = criticalTradingTier
    || config?.alertForceLocalStructured === true
    || usesLocalStructuredBilingualFocus(event);
  const [chinese, english] = event?.type === "telegram_news_update"
    ? await Promise.all([
        translateTelegramNewsNarrative(focusModel, options, "zh"),
        translateTelegramNewsNarrative(focusModel, options, "en"),
      ])
    : await Promise.all([
        usesLocalStructuredChineseFocus(event) || localBilingual
          ? Promise.resolve(localStructuredResult(chineseBaseLines, {
            language: "zh",
            deliveryBudgetFallback: criticalTradingTier || config?.alertForceLocalStructured === true,
            event,
          }))
          : translateAlertLines(chineseBaseLines, { ...options, targetLanguage: "zh-CN" }),
        localBilingual
          ? Promise.resolve(localStructuredResult(englishBaseLines, { language: "en", event }))
          : translateAlertLines(englishBaseLines, { ...options, targetLanguage: "en" }),
      ]);

  let chineseLines;
  let englishLines;
  if (event?.type === "telegram_news_update") {
    // Persist the exact post-translation narrative separately from the legacy
    // two-field envelope. Final Telegram rendering can then split important
    // numeric facts into atomic rows without reparsing already-compacted prose.
    focusModel.telegramNews.localized = {
      zh: resolvedTelegramNewsNarrative(chinese, focusModel, "zh"),
      en: resolvedTelegramNewsNarrative(english, focusModel, "en"),
    };
    chineseLines = finalizeTelegramNewsLines(chinese, focusModel, "zh", chineseRequired);
    englishLines = finalizeTelegramNewsLines(english, focusModel, "en", englishRequired);
  } else {
    chineseLines = ensureTechnicalLiterals(
      normalizePublishedCallChineseFallback(chinese.lines, chineseBaseLines, event, chinese.status),
      chineseRequired,
      "zh",
    );
    englishLines = ensureTechnicalLiterals(
      english.lines,
      englishRequired,
      "en",
    );
  }
  [chineseLines, englishLines] = fitTwoFieldBilingualLines(
    chineseLines,
    englishLines,
    chineseRequired,
    englishRequired,
    publishedFomoCallDetails(event)
      ? 1_000
      : showPriority
        ? TWO_FIELD_COMBINED_BLOCK_BUDGET - (delayedPonRecovery || delayedFlapRecovery ? 48 : 12)
        : TWO_FIELD_COMBINED_BLOCK_BUDGET,
  );
  const sourceHash = createHash("sha256")
    .update(`${chineseBaseLines.join("\n")}\n---\n${englishBaseLines.join("\n")}`)
    .digest("hex");

  return {
    version: BILINGUAL_RENDER_VERSION,
    format: "telegram_zh_en_compact_v13",
    ...(event?.type === "telegram_news_update" ? { eventType: event.type } : {}),
    sourceHash,
    generatedAt: new Date().toISOString(),
    changeModel,
    focusModel,
    priority: tradingPriority,
    zh: {
      text: chineseLines.join("\n"),
      ...translationMeta(chinese),
    },
    en: {
      text: englishLines.join("\n"),
      ...translationMeta(english),
    },
  };
}

export function renderBilingualTelegramText(bundle, strong = false) {
  const telegramNews = bundle?.eventType === "telegram_news_update"
    || bundle?.focusModel?.eventType === "telegram_news_update";
  const severity = strong && !telegramNews ? "🔴 强提醒 | STRONG ALERT" : "🔔 监控提醒 | MONITOR ALERT";
  const displayBlock = (text, language) => {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const zh = language === "zh";
    const focusModel = bundle?.focusModel || {};
    const tier = focusModel.priority?.tier || bundle?.priority?.tier;
    const fallbackPlatform = focusModel.platform?.[language] || focusModel.title?.[language]
      || (zh ? "监控" : "Monitor");
    const platform = lines[0]
      || `${zh ? "平台：" : "Platform: "}${fallbackPlatform}${focusModel.showPriority && tier ? ` · ${tier}` : ""}`;
    const field = (label, value, maximum = MAX_DISPLAY_LINE_LENGTH) => {
      const normalized = String(value || "")
        .replace(/^(?:平台|Platform|更新了什么|What changed)[:：]\s*/iu, "")
        .trim();
      return `${label}${oneLine(normalized || (zh ? "未取得" : "Unavailable"), maximum)}`;
    };

    const trackedTokenLines = renderFlapTrackedPoolTokenLines(focusModel, language);
    if (trackedTokenLines) return trackedTokenLines.join("\n");

    if (focusModel.eventType === "fomo_monitor_health_update") {
      const facts = focusModel.healthFacts?.[language] || {};
      return [
        platform,
        field(zh ? "状态：" : "Status: ", facts.transition || focusModel.health?.[language], 112),
        field("", facts.smartMoney, 120),
        field(zh ? "网络：" : "Network: ", facts.network, 120),
        field(zh ? "队列：" : "Pipeline: ", facts.pipeline, 120),
        field(zh ? "时间：" : "Time: ", localizedCstTime(focusModel.time?.[language], language), 104),
      ].join("\n");
    }

    if (focusModel.eventType === "telegram_news_update") {
      const narrative = focusModel.telegramNews?.localized?.[language] || {};
      const headline = String(narrative.headline || focusModel.telegramNews?.headline?.[language] || "").trim();
      const summary = String(narrative.summary || "").trim();
      const numericNarrative = narrative.unavailable
        ? telegramSourceNarrativeResult(
            focusModel,
            focusModel.telegramNews?.sourceLanguage || "en",
          ).lines
        : [headline, summary];
      const numericLines = telegramNumericFactLines(
        telegramNewsNumericAtoms(numericNarrative, language),
        language,
      );
      const narrativeValue = numericLines.length
        ? [headline, summary].filter(Boolean).join(" · ")
        : headline;
      const source = [
        focusModel.telegramNews?.category?.[language],
        focusModel.telegramNews?.sourceMarker,
      ].filter(Boolean).join(" · ");
      return [
        platform,
        field(zh ? "事件：" : "Event: ", narrativeValue, 112),
        numericLines.length || narrative.unavailable
          ? null
          : field(zh ? "摘要：" : "Summary: ", summary || (zh ? "暂无独立摘要" : "No separate summary"), 108),
        ...numericLines,
        field(zh ? "来源：" : "Source: ", source, 108),
        field(zh ? "验证：" : "Verification: ", focusModel.stage?.[language], 108),
        field(zh ? "时间：" : "Time: ", localizedCstTime(focusModel.time?.[language], language), 104),
      ].filter(Boolean).join("\n");
    }

    const prefix = lines[1]?.match(/^(?:更新了什么|What changed)[:：]\s*/u)?.[0];
    const body = prefix ? lines[1].slice(prefix.length) : lines.slice(1).join(" · ");
    const separator = body.includes("｜") ? "｜" : body.includes(" | ") ? " | " : null;
    const parts = separator ? body.split(separator).map((part) => part.trim()).filter(Boolean) : [];
    const parsed = parts.length >= 3;
    let key = parsed ? parts.shift() || "" : body;
    let time = parsed ? parts.pop() || "" : "";
    let stage = parsed ? parts.pop() || "" : "";
    const tradeIndex = parts.findIndex((part) => /^(?:交易|Trade)[:=：]/u.test(part));
    let trade = tradeIndex >= 0 ? parts.splice(tradeIndex, 1)[0] : "";
    let evidence = parts.join(" · ");
    if (!parsed) {
      const fellBack = ["fallback_source", "partial_fallback"].includes(bundle?.[language]?.status);
      evidence = fellBack && focusModel.eventType === "telegram_news_update"
        ? focusModel.telegramNews?.sourceMarker || ""
        : focusModel.evidence?.map((item) => item?.[language]).filter(Boolean).join(" · ") || evidence;
      stage = focusModel.stage?.[language] || stage;
      time = focusModel.showPriority
        ? priorityFlashTime(focusModel.time?.[language], language, focusModel.priority)
        : focusModel.time?.[language] || time;
      if (focusModel.showPriority) trade = tradingBrief(focusModel.priority, language);
    }
    // The persisted two-field bundle may compact a long trading brief down to
    // its conclusion. Rebuild the deterministic brief for display so a T0/T1
    // card never loses its capital path, entry condition, or invalidation.
    if (focusModel.showPriority
      && (!/(?:资金路径|flow)=/iu.test(trade)
        || !/(?:入场|entry)=/iu.test(trade)
        || !/(?:失效|invalid)=/iu.test(trade))) {
      trade = tradingBrief(focusModel.priority, language);
    }
    key = key.replace(/\s+·\s+(?:CST|UTC|GMT)\s*$/iu, "");

    const instrument = focusModel.instrumentChange;
    let target = "";
    if (instrument?.kind === "instrument_change") {
      const instruments = list(instrument.instruments)
        .filter((item) => String(item?.symbol || "").trim());
      const market = {
        usd_m_perpetual: zh ? "USDⓈ-M 永续合约" : "USDⓈ-M perpetual contracts",
        coin_m_perpetual: zh ? "币本位永续合约" : "COIN-M perpetual contracts",
        spot: zh ? "现货资产" : "spot assets",
        spot_pair: zh ? "现货交易对" : "spot pairs",
      }[instrument.market] || (zh ? "市场标的" : "market instruments");
      const compactMarket = !zh && instrument.market === "usd_m_perpetual"
        ? "USDⓈ-M perpetuals"
        : market;
      const action = instrument.action === "delist"
        ? (zh ? "下架" : "Delist")
        : instrument.action === "list"
          ? (zh ? "上币" : "List")
          : (zh ? "上线" : "Launch");
      const count = instruments.length > 1 ? `${instruments.length}${zh ? "个" : ""} ` : "";
      key = `${action} ${count}${compactMarket}`.replace(/\s+/g, " ").trim();
      target = instruments.map((item) => String(item.symbol).trim()).join(zh ? "、" : ", ");
      stage = instrument.action === "delist"
        ? (zh ? "官方时间表；待生效核验" : "Official schedule; verify at effective time")
        : (zh ? "官方时间表；待开盘核验" : "Official schedule; verify at launch");
      const timeField = instrument.action === "delist" ? "effectiveAt" : "launchAt";
      const scheduled = instruments.map((item) => item?.[timeField]).filter(Boolean)
        .map((value) => new Date(value)).filter((date) => !Number.isNaN(date.getTime()))
        .sort((left, right) => left - right)[0];
      if (scheduled) {
        const cst = beijingMinute(scheduled);
        const utc = utcMinute(scheduled);
        time = zh
          ? `首批${instrument.action === "delist" ? "生效" : "开盘"}=${cst} CST（${utc} UTC）`
          : `First ${instrument.action === "delist" ? "effective" : "launch"}=${cst} CST (${utc} UTC)`;
      }
    }

    const targetFactLines = () => {
      if (!target) {
        return [field(zh ? "证据：" : "Evidence: ", evidence || (zh ? "官方来源" : "Official source"), MAX_DISPLAY_LINE_LENGTH)];
      }
      const delimiter = zh ? "、" : ", ";
      const items = target.split(delimiter).map((item) => item.trim()).filter(Boolean);
      const joined = items.join(delimiter);
      const firstLabel = zh ? "标的：" : "Targets: ";
      if ((firstLabel.length + joined.length) <= MAX_TARGET_LINE_LENGTH) {
        return [`${firstLabel}${joined}`];
      }
      // Keep each exact target atomic and use at most three short rows. A
      // three-row batch reclaims the separate event row below, so the block
      // still satisfies Telegram's 4–7 fact-line contract.
      const groups = [[]];
      for (const item of items) {
        const group = groups.at(-1);
        const label = groups.length === 1 ? firstLabel : (zh ? "标的续：" : "Targets cont.: ");
        const candidate = [...group, item].join(delimiter);
        if (group.length && label.length + candidate.length > MAX_TARGET_LINE_LENGTH && groups.length < 3) {
          groups.push([item]);
        } else {
          group.push(item);
        }
      }
      return groups.filter((group) => group.length).map((group, index) => {
        const value = group.join(delimiter);
        const label = index === 0 ? firstLabel : (zh ? "标的续：" : "Targets cont.: ");
        return `${label}${value}`;
      });
    };

    const conclusion = trade.match(/(?:结论|conclusion)=([^；;]+)/iu)?.[1]?.trim();
    const flow = trade.match(/(?:资金路径|flow)=([^；;]+)/iu)?.[1]?.trim();
    const entry = trade.match(/(?:入场|entry)=([^；;]+)/iu)?.[1]?.trim();
    const invalid = trade.match(/(?:失效|invalid)=([^；;]+)/iu)?.[1]?.trim();
    const hasTrade = Boolean(trade || focusModel.showPriority);
    const decision = zh
      ? [conclusion || "观察", flow ? `路径=${flow}` : null].filter(Boolean).join("；")
      : [conclusion || "Watch", flow ? `flow=${flow}` : null].filter(Boolean).join("; ");
    const fomo = focusModel.fomo;
    const pon = focusModel.pon;
    const atomicBoundary = fomo || pon || focusModel.flapQuote;
    const displayDecision = atomicBoundary && hasTrade
      ? (zh
          ? [conclusion || "观察", flow ? `路径=${flow}` : null, entry ? `入场=${entry}` : null, invalid ? `失效=${invalid}` : null]
            .filter(Boolean).join("；")
          : [conclusion || "Watch", flow ? `flow=${flow}` : null, entry ? `entry=${entry}` : null, invalid ? `invalid=${invalid}` : null]
            .filter(Boolean).join("; "))
      : decision;
    const verification = zh
      ? [entry ? `入场=${entry}` : null, invalid ? `失效=${invalid}` : null, stage].filter(Boolean).join("；")
      : [entry ? `entry=${entry}` : null, invalid ? `invalid=${invalid}` : null, stage].filter(Boolean).join("; ");
    const displayTimeSource = instrument?.kind === "instrument_change" && time
      ? time
      : focusModel.showPriority
        ? focusModel.time?.[language] || time
        : time || focusModel.time?.[language];
    const displayTime = localizedCstTime(
      String(displayTimeSource || "")
        .replace(/^(?:时效|时间|发生|Time|Occurred|Launch)\s*[:=：]\s*/iu, ""),
      language,
    );
    const displayTargetLines = targetFactLines();

    const callThesis = focusModel.callThesis;
    if (callThesis?.source) {
      const thesisLabel = zh
        ? (callThesis.sourceLanguage === "zh" ? "观点：" : "英文原文：")
        : (callThesis.sourceLanguage === "en" ? "Thesis: " : "Chinese original: ");
      const signalAtoms = [
        focusModel.key?.[language] || key,
        ...list(focusModel.evidence).map((item) => item?.[language]),
      ].map((value) => String(value || "").trim()).filter(Boolean);
      const signalGroups = [[]];
      for (const atom of signalAtoms) {
        const current = signalGroups.at(-1);
        const candidate = [...current, atom].join(" · ");
        if (current.length && candidate.length > 138 && signalGroups.length < 2) signalGroups.push([atom]);
        else current.push(atom);
      }
      const signalLines = signalGroups.filter((group) => group.length).map((group, index) => {
        const label = index === 0
          ? (zh ? "信号：" : "Signal: ")
          : (zh ? "证据：" : "Evidence: ");
        // These are already-selected atomic identifiers. Do not route them
        // through prose shortening, which could cut the trailing X post ID.
        return `${label}${group.join(" · ")}`;
      });
      return [
        platform,
        hasTrade ? field(zh ? "结论：" : "Decision: ", displayDecision, 136) : null,
        field(thesisLabel, callThesis.source, 112),
        ...signalLines,
        field(
          zh ? "验证：" : "Verification: ",
          [fomo?.verification?.[language] || stage, fomo?.risk?.[language]].filter(Boolean).join(zh ? "；" : "; ")
            || (zh ? "状态待核" : "Status pending"),
          136,
        ),
        field(zh ? "时间：" : "Time: ", displayTime, 112),
      ].filter(Boolean).join("\n");
    }

    if (atomicBoundary) {
      return [
        platform,
        hasTrade ? field(zh ? "结论：" : "Decision: ", displayDecision, 136) : null,
        field(zh ? "事件：" : "Event: ", key, MAX_DISPLAY_LINE_LENGTH),
        ...displayTargetLines,
        field(zh ? "验证：" : "Verification: ", atomicBoundary.verification?.[language] || (zh ? "状态待核" : "Status pending"), 136),
        field(zh ? "风险：" : "Risk: ", atomicBoundary.risk?.[language] || (zh ? "非自动交易" : "No automatic trading"), 136),
        field(zh ? "时间：" : "Time: ", displayTime, 112),
      ].filter(Boolean).join("\n");
    }

    const mergeEventIntoDecision = hasTrade && displayTargetLines.length >= 3;
    const boundedDecision = mergeEventIntoDecision
      ? (zh ? `${displayDecision}；事件=${key}` : `${displayDecision}; event=${key}`)
      : displayDecision;
    return [
      platform,
      hasTrade ? field(zh ? "结论：" : "Decision: ", boundedDecision, 136) : null,
      mergeEventIntoDecision ? null : field(zh ? "事件：" : "Event: ", key, MAX_DISPLAY_LINE_LENGTH),
      ...displayTargetLines,
      field(zh ? "验证：" : "Verification: ", hasTrade ? verification : stage || (zh ? "状态待核" : "Status pending"), MAX_DISPLAY_LINE_LENGTH),
      field(zh ? "时间：" : "Time: ", displayTime, 112),
    ].filter(Boolean).join("\n");
  };
  return `${severity}\n🇨🇳 中文\n${displayBlock(bundle.zh.text, "zh")}\n\n🇬🇧 English\n${displayBlock(bundle.en.text, "en")}`;
}
