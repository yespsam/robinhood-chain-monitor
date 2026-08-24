const ADDRESS = /^0x[0-9a-f]{40}$/i;
const TRANSACTION = /^0x[0-9a-f]{64}$/i;
const SOLIDITY_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (entity, decimal) => {
      const point = Number(decimal);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    })
    .replace(/&#x([0-9a-f]+);/gi, (entity, hexadecimal) => {
      const point = Number.parseInt(hexadecimal, 16);
      return Number.isInteger(point) && point >= 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff)
        ? String.fromCodePoint(point)
        : entity;
    })
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function contentHtml(value) {
  return String(value || "")
    .replace(/<(?:script|style|noscript|template)\b[^>]*>[\s\S]*?<\/(?:script|style|noscript|template)>/gi, " ");
}

function renderedText(value) {
  return decodeHtml(String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(?:div|p|li|tr|td|th|section|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " "))
    .replace(/\r/g, "")
    .replace(/[\t \f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function lowerAddress(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ADDRESS.test(normalized) ? normalized : null;
}

function lowerTransaction(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return TRANSACTION.test(normalized) ? normalized : null;
}

function hrefMatch(section, kind, pattern) {
  const escapedKind = kind.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = String(section || "").match(new RegExp(
    `href\\s*=\\s*["'](?:https:\\/\\/(?:www\\.)?bscscan\\.com)?\\/${escapedKind}\\/(${pattern})(?:[?#][^"']*)?["']`,
    "i",
  ));
  return match?.[1] || null;
}

function contractCreatorSection(html) {
  const marker = html.search(/Contract(?:\s|&nbsp;|<[^>]+>)*Creator\b/i);
  if (marker < 0) return "";
  const tail = html.slice(marker, marker + 2_500);
  const boundary = tail.slice(80).search(
    /Contract(?:\s|&nbsp;|<[^>]+>)*(?:Creation Code|Name|Source Code)|Token Tracker|More Info|<hr\b|<\/tr\s*>/i,
  );
  return boundary >= 0 ? tail.slice(0, boundary + 80) : tail.slice(0, 1_500);
}

function parseContractName(html) {
  const marker = html.search(/Contract(?:\s|&nbsp;|<[^>]+>)*Name(?:\s|&nbsp;|<[^>]+>)*:?/i);
  if (marker < 0) return null;
  const tail = html.slice(marker, marker + 1_200);
  const text = renderedText(tail);
  const match = text.match(/Contract[ \t]*Name[ \t]*:?[ \t]*(?:\n[ \t]*)?([^\n]{1,160})/i);
  const candidate = match?.[1]?.trim() || null;
  return candidate && SOLIDITY_IDENTIFIER.test(candidate) ? candidate : null;
}

function sourceCodeSection(html) {
  const marker = html.search(/id\s*=\s*["']ContentPlaceHolder1_contractCodeDiv["']/i);
  return marker >= 0 ? { html: html.slice(marker, marker + 30_000), structured: true } : { html, structured: false };
}

/**
 * Parse only structured attribution fields from a BscScan contract page.
 * This is intentionally conservative: unrelated address/transaction links and
 * generic "verified" copy elsewhere on the page do not count as evidence.
 */
export function parseBscScanAttribution(input) {
  const html = contentHtml(input);
  const creatorSection = contractCreatorSection(html);
  const creator = lowerAddress(hrefMatch(creatorSection, "address", "0x[0-9a-f]{40}"));
  const creationTransaction = lowerTransaction(hrefMatch(creatorSection, "tx", "0x[0-9a-f]{64}"));
  const contractName = parseContractName(html);
  const sourceSection = sourceCodeSection(html);
  const sourceText = renderedText(sourceSection.html);
  const hasVerifiedHeading = sourceSection.structured
    ? /\bSource Code Verified\b/i.test(sourceText)
    : /\bContract Source Code Verified\b/i.test(sourceText);
  const hasExactMatch = /\bExact Match\b/i.test(sourceText);
  const hasNegativeHeading = /\b(?:Contract Source Code Not Verified|Source Code Not Verified|Unable to locate ContractCode)\b/i.test(sourceText);

  return {
    creationTransaction,
    creator,
    contractName,
    verifiedSource: Boolean(contractName && hasVerifiedHeading && hasExactMatch && !hasNegativeHeading),
  };
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanText(value, maximum = 160) {
  const text = String(value || "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maximum) : null;
}

function publicHttpsUrl(value, { allowedHosts = null } = {}) {
  try {
    if (typeof value !== "string" || value.length > 2_048) return null;
    const url = new URL(value.trim());
    if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) return null;
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (hostname === "localhost" || /^(?:127\.|10\.|192\.168\.|169\.254\.)/.test(hostname)) return null;
    if (/^172\.(?:1[6-9]|2\d|3[01])\./.test(hostname)) return null;
    if (allowedHosts && !allowedHosts.has(hostname.replace(/^www\./, ""))) return null;
    url.hostname = hostname;
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function cleanTwitter(value) {
  const safe = publicHttpsUrl(value, { allowedHosts: new Set(["x.com", "twitter.com"]) });
  if (!safe) return null;
  const url = new URL(safe);
  const handle = url.pathname.split("/").filter(Boolean)[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle || "") || /^(?:home|intent|share|search|explore|i)$/i.test(handle)) return null;
  return `https://x.com/${handle}`;
}

function cleanTelegram(value) {
  const safe = publicHttpsUrl(value, { allowedHosts: new Set(["t.me", "telegram.me"]) });
  if (!safe) return null;
  const url = new URL(safe);
  const channel = url.pathname.split("/").filter(Boolean)[0];
  if (!/^(?:[A-Za-z0-9_]{4,64}|\+[A-Za-z0-9_-]{8,64})$/.test(channel || "")) return null;
  return `https://t.me/${channel}`;
}

function pairSocials(pair) {
  const websites = Array.isArray(pair?.info?.websites) ? pair.info.websites : [];
  const socials = Array.isArray(pair?.info?.socials) ? pair.info.socials : [];
  const website = websites
    .map((entry) => publicHttpsUrl(typeof entry === "string" ? entry : entry?.url))
    .find(Boolean) || null;
  let twitter = null;
  let telegram = null;
  for (const entry of socials) {
    const type = String(entry?.type || "").trim().toLowerCase();
    if (!twitter && (type === "twitter" || type === "x")) twitter = cleanTwitter(entry?.url);
    if (!telegram && (type === "telegram" || type === "tg")) telegram = cleanTelegram(entry?.url);
  }
  return { website, twitter, telegram };
}

function normalizedToken(value) {
  const address = lowerAddress(value?.address);
  if (!address) return null;
  return {
    address,
    name: cleanText(value?.name),
    symbol: cleanText(value?.symbol, 40),
  };
}

function normalizePair(pair, target) {
  if (!pair || String(pair.chainId || "").toLowerCase() !== "bsc") return null;
  const baseToken = normalizedToken(pair.baseToken);
  const quoteToken = normalizedToken(pair.quoteToken);
  if (!baseToken || !quoteToken || (baseToken.address !== target && quoteToken.address !== target)) return null;
  const pairCreatedAtValue = finiteNumber(pair.pairCreatedAt);
  const liquidityValue = finiteNumber(pair?.liquidity?.usd);
  const socials = pairSocials(pair);
  return {
    chainId: "bsc",
    dexId: cleanText(pair.dexId, 80),
    pairAddress: lowerAddress(pair.pairAddress),
    url: publicHttpsUrl(pair.url),
    labels: Array.isArray(pair.labels) ? [...new Set(pair.labels.map((label) => cleanText(label, 80)).filter(Boolean))] : [],
    baseToken,
    quoteToken,
    pairCreatedAt: pairCreatedAtValue !== null && pairCreatedAtValue >= 0 ? pairCreatedAtValue : null,
    liquidityUsd: liquidityValue !== null && liquidityValue >= 0 ? liquidityValue : null,
    website: socials.website,
    twitter: socials.twitter,
    telegram: socials.telegram,
    socials,
  };
}

function earliestPair(left, right) {
  const leftTime = left.pairCreatedAt ?? Number.POSITIVE_INFINITY;
  const rightTime = right.pairCreatedAt ?? Number.POSITIVE_INFINITY;
  return leftTime - rightTime
    || String(left.pairAddress || "").localeCompare(String(right.pairAddress || ""));
}

function liquidPair(left, right) {
  return (right.liquidityUsd ?? 0) - (left.liquidityUsd ?? 0) || earliestPair(left, right);
}

/** Parse the public DEX Screener response without trusting its launchpad labels. */
export function parseDexScreenerTokenPairs(payload, token) {
  const target = lowerAddress(token);
  const rawPairs = Array.isArray(payload) ? payload : Array.isArray(payload?.pairs) ? payload.pairs : [];
  const pairs = target ? rawPairs.map((pair) => normalizePair(pair, target)).filter(Boolean) : [];
  const firstPair = [...pairs].sort(earliestPair)[0] || null;
  const bestPair = [...pairs].sort(liquidPair)[0] || null;
  const socialOrder = [bestPair, firstPair, ...pairs].filter(Boolean);
  const socials = {
    website: socialOrder.map((pair) => pair.website).find(Boolean) || null,
    twitter: socialOrder.map((pair) => pair.twitter).find(Boolean) || null,
    telegram: socialOrder.map((pair) => pair.telegram).find(Boolean) || null,
  };

  return {
    token: target,
    pairCount: pairs.length,
    pairs,
    firstPair,
    bestPair,
    ...socials,
    socials,
  };
}

function platformFrom(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const name = cleanText(value, 100);
    const id = name?.toLowerCase().replace(/[^a-z0-9]+/g, "") || null;
    return id ? { id, name } : null;
  }
  const name = cleanText(value.name || value.protocolName || value.label || value.id || value.platform, 100);
  const rawId = cleanText(value.id || value.slug || value.platformId || name, 100);
  const id = rawId?.toLowerCase().replace(/[^a-z0-9]+/g, "") || null;
  if (!id) return null;
  const result = { id, name: name || rawId };
  for (const field of ["website", "twitter", "telegram"]) {
    if (typeof value[field] === "string") result[field] = value[field];
  }
  return result;
}

function evidencePlatform(value) {
  if (!value) return null;
  return platformFrom(value.platform || value.launchpad || value.family || value.protocolName || value.label);
}

function evidenceRecord(kind, trust, input, fallbackSourceId) {
  const platform = evidencePlatform(input);
  const sourceId = cleanText(input?.sourceId || input?.source || fallbackSourceId, 120) || fallbackSourceId;
  const record = { kind, sourceId, trust, platform };
  const address = lowerAddress(input?.address || input?.factory || input?.emitter || input?.contractAddress);
  const blockNumber = finiteNumber(input?.blockNumber);
  if (address) record.address = address;
  if (blockNumber !== null && blockNumber >= 0) record.blockNumber = Math.trunc(blockNumber);
  if (typeof input?.observedAt === "string" && input.observedAt.trim()) record.observedAt = input.observedAt.trim();
  const detail = cleanText(input?.detail || input?.match || input?.contractName || input?.version || input?.label, 180);
  if (detail) record.detail = detail;
  return record;
}

function asList(value) {
  if (value === null || value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function binancePlatform(record) {
  return platformFrom(record?.platform || record?.launchpad || record?.protocolName || record?.protocol);
}

function collectEvidence(input) {
  const records = [];
  const add = (record) => {
    if (!record?.platform) return;
    const key = [record.kind, record.sourceId, record.platform.id, record.address || "", record.detail || ""].join("|");
    if (!records.some((item) => item._key === key)) records.push({ ...record, _key: key });
  };

  for (const item of [...asList(input?.officialFactory), ...asList(input?.officialFactories)]) {
    const record = evidenceRecord("official_factory", "official_verified", item, "official-contract-inventory");
    if (record.address) add(record);
  }
  for (const item of [...asList(input?.binanceTokenRecord), ...asList(input?.binanceTokenRecords)]) {
    const platform = binancePlatform(item);
    if (platform) add(evidenceRecord("binance_wallet_token_record", "official_record", { ...item, platform }, "binance-wallet-production-feed"));
  }
  for (const item of [...asList(input?.verifiedSourceFamily), ...asList(input?.verifiedSourceFamilies)]) {
    if (item?.verifiedSource === false) continue;
    add(evidenceRecord("verified_source_family", "verified_source", item, "verified-contract-source"));
  }
  for (const item of [...asList(input?.causalEvidence), ...asList(input?.causal)]) {
    add(evidenceRecord("causal_event", "onchain_causal", item, "transaction-receipt"));
  }
  for (const item of [...asList(input?.externalEvidence), ...asList(input?.external)]) {
    add(evidenceRecord("external_attribution", "external", item, "external-attribution"));
  }
  for (const item of [...asList(input?.thirdPartyLabels), ...asList(input?.thirdPartyLabel)]) {
    add(evidenceRecord("third_party_label", "third_party", item, "third-party-label"));
  }

  for (const item of asList(input?.evidence)) {
    const kind = String(item?.kind || "").toLowerCase();
    if (/^(?:exact_)?official_factory$/.test(kind) && item?.trust === "official_verified") {
      const record = evidenceRecord("official_factory", "official_verified", item, item.sourceId || "official-contract-inventory");
      if (record.address) add(record);
    } else if (/^binance(?:_wallet)?_token_record$/.test(kind) && item?.trust === "official_record") {
      add(evidenceRecord("binance_wallet_token_record", "official_record", item, item.sourceId || "binance-wallet-production-feed"));
    } else if (/^(?:verified_)?source_family$/.test(kind) && (item?.verifiedSource === true || item?.trust === "verified_source")) {
      add(evidenceRecord("verified_source_family", "verified_source", item, item.sourceId || "verified-contract-source"));
    } else if (/^(?:causal_event|causal_token_event|token_event_emitter)$/.test(kind) && item?.trust === "onchain_causal") {
      add(evidenceRecord("causal_event", "onchain_causal", item, item.sourceId || "transaction-receipt"));
    } else if (kind) {
      add(evidenceRecord("third_party_label", "third_party", item, item.sourceId || "third-party-label"));
    }
  }
  return records.map(({ _key, ...record }) => record);
}

function groupEvidence(evidence) {
  const groups = new Map();
  for (const item of evidence) {
    const id = item.platform.id;
    const group = groups.get(id) || { platform: item.platform, evidence: [] };
    group.platform = { ...group.platform, ...item.platform };
    group.evidence.push(item);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    const official = group.evidence.some((item) => item.kind === "official_factory");
    const sourceFamilies = group.evidence.filter((item) => item.kind === "verified_source_family");
    const support = group.evidence.filter((item) => [
      "causal_event",
      "external_attribution",
      "binance_wallet_token_record",
      "third_party_label",
    ].includes(item.kind));
    const independentlySupported = sourceFamilies.some((family) => support.some((item) => item.sourceId !== family.sourceId));
    group.level = official ? 3 : independentlySupported ? 2 : group.evidence.length ? 1 : 0;
    group.status = ["unknown", "candidate", "corroborated", "verified"][group.level];
  }
  return [...groups.values()];
}

function conflictRecord(group) {
  return {
    platform: group.platform,
    status: group.status,
    evidence: group.evidence.map((item) => ({ kind: item.kind, sourceId: item.sourceId })),
  };
}

/**
 * Infer attribution from already-collected evidence. It performs no network or
 * safety checks. Only an exact official factory can produce `verified`.
 */
export function inferBscLaunchpadAttribution(input = {}) {
  const evidence = collectEvidence(input);
  const groups = groupEvidence(evidence);
  if (!groups.length) return { status: "unknown", platform: null, match: null, evidence, conflicts: [] };

  const highestLevel = Math.max(...groups.map((group) => group.level));
  const leaders = groups.filter((group) => group.level === highestLevel);
  if (leaders.length > 1) {
    return {
      status: "ambiguous",
      platform: null,
      match: `conflicting_${leaders[0].status}_evidence`,
      evidence,
      conflicts: leaders.map(conflictRecord),
    };
  }

  const winner = leaders[0];
  const conflicts = groups.filter((group) => group !== winner).map(conflictRecord);
  let match = null;
  if (winner.status === "verified") match = "official_factory";
  else if (winner.status === "corroborated") {
    match = winner.evidence.some((item) => item.kind === "causal_event")
      ? "verified_source_family+causal_event"
      : "verified_source_family+independent_external";
  } else {
    const kinds = [...new Set(winner.evidence.map((item) => item.kind))];
    match = kinds.join("+") || "supporting_evidence";
  }
  return { status: winner.status, platform: winner.platform, match, evidence, conflicts };
}
