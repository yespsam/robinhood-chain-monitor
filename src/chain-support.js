const CHAIN_DEFINITIONS = [
  { id: "ethereum", name: "Ethereum", mainnetChainId: 1, ids: { 1: "mainnet", 11155111: "testnet", 5: "testnet" }, pattern: /\b(?:ethereum|eth\s+mainnet|ethereum\s+sepolia)\b/i, codes: ["eth", "ethereum"] },
  { id: "bnb-chain", name: "BNB Chain", mainnetChainId: 56, ids: { 56: "mainnet", 97: "testnet" }, pattern: /\b(?:bnb\s*(?:smart\s*)?chain|bsc|bnb\s+testnet)(?:\s+(?:mainnet|testnet|chapel))?\b/i, codes: ["bnb", "bsc", "bnbchain"] },
  { id: "base", name: "Base", mainnetChainId: 8453, ids: { 8453: "mainnet", 84532: "testnet" }, pattern: /\b(?:Base(?:\s+(?:mainnet|sepolia|testnet|chain|network))?|base\s+(?:mainnet|sepolia|testnet|chain|network))\b/, codes: ["base"] },
  { id: "arbitrum", name: "Arbitrum", mainnetChainId: 42161, ids: { 42161: "mainnet", 421614: "testnet" }, pattern: /\barbitrum(?:\s+(?:one|mainnet|sepolia|testnet|chain|network))?\b/i, codes: ["arb", "arbitrum", "arbitrumone"] },
  { id: "optimism", name: "Optimism", mainnetChainId: 10, ids: { 10: "mainnet", 11155420: "testnet" }, pattern: /\b(?:optimism|op\s+mainnet|optimism\s+sepolia)(?:\s+(?:mainnet|testnet|chain|network))?\b/i, codes: ["op", "optimism"] },
  { id: "polygon", name: "Polygon", mainnetChainId: 137, ids: { 137: "mainnet", 80002: "testnet", 80001: "testnet" }, pattern: /\bpolygon(?:\s+(?:pos|mainnet|amoy|testnet|chain|network))?\b/i, codes: ["matic", "polygon", "polygonpos"] },
  { id: "avalanche", name: "Avalanche", mainnetChainId: 43114, ids: { 43114: "mainnet", 43113: "testnet" }, pattern: /\bavalanche(?:\s+c[ -]?chain|\s+(?:mainnet|fuji|testnet|network))?\b/i, codes: ["avax", "avalanche"] },
  { id: "unichain", name: "Unichain", mainnetChainId: 130, ids: { 130: "mainnet", 1301: "testnet" }, pattern: /\bunichain(?:\s+(?:mainnet|sepolia|testnet|chain|network))?\b/i, codes: ["unichain"] },
  { id: "robinhood-chain", name: "Robinhood Chain", mainnetChainId: 4663, ids: { 4663: "mainnet" }, pattern: /\brobinhood(?:\s+chain)?(?:\s+(?:mainnet|testnet|network))?\b/i, codes: ["robinhood", "robinhoodchain"] },
  { id: "morph", name: "Morph", mainnetChainId: 2818, ids: { 2818: "mainnet" }, pattern: /\bmorph(?:\s+(?:mainnet|holesky|hoodi|testnet|chain|network))?\b/i, codes: ["morph", "morphl2"] },
  { id: "ink", name: "Ink", mainnetChainId: 57073, ids: { 57073: "mainnet" }, pattern: /\bink(?:\s+(?:mainnet|chain|network))?\b/i, codes: ["ink"] },
  { id: "opbnb", name: "opBNB", mainnetChainId: 204, ids: { 204: "mainnet", 5611: "testnet" }, pattern: /\bopbnb(?:\s+(?:mainnet|testnet|chain|network))?\b/i, codes: ["opbnb"] },
  { id: "zksync-era", name: "zkSync Era", mainnetChainId: 324, ids: { 324: "mainnet", 300: "testnet" }, pattern: /\bzksync(?:\s+era)?(?:\s+(?:mainnet|sepolia|testnet|chain|network))?\b/i, codes: ["zksync", "zksyncera"] },
  { id: "linea", name: "Linea", mainnetChainId: 59144, ids: { 59144: "mainnet", 59141: "testnet" }, pattern: /\blinea(?:\s+(?:mainnet|sepolia|testnet|chain|network))?\b/i, codes: ["linea"] },
  { id: "scroll", name: "Scroll", mainnetChainId: 534352, ids: { 534352: "mainnet", 534351: "testnet" }, pattern: /\bScroll(?:\s+(?:mainnet|sepolia|testnet|chain|network))?\b/, codes: ["scroll"] },
  { id: "blast", name: "Blast", mainnetChainId: 81457, ids: { 81457: "mainnet", 168587773: "testnet" }, pattern: /\bBlast(?:\s+(?:mainnet|sepolia|testnet|chain|network))?\b/, codes: ["blast"] },
  { id: "mantle", name: "Mantle", mainnetChainId: 5000, ids: { 5000: "mainnet", 5003: "testnet" }, pattern: /\bMantle(?:\s+(?:mainnet|sepolia|testnet|chain|network))?\b/, codes: ["mantle"] },
  { id: "sonic", name: "Sonic", mainnetChainId: 146, ids: { 146: "mainnet", 57054: "testnet" }, pattern: /\bSonic(?:\s+(?:mainnet|testnet|chain|network))?\b/, codes: ["sonic"] },
  { id: "berachain", name: "Berachain", mainnetChainId: 80094, ids: { 80094: "mainnet", 80069: "testnet" }, pattern: /\bberachain(?:\s+(?:mainnet|bepolia|testnet|chain|network))?\b/i, codes: ["bera", "berachain"] },
  { id: "world-chain", name: "World Chain", mainnetChainId: 480, ids: { 480: "mainnet", 4801: "testnet" }, pattern: /\bworld\s+chain(?:\s+(?:mainnet|sepolia|testnet|network))?\b/i, codes: ["world", "worldchain"] },
  { id: "solana", name: "Solana", mainnetChainId: null, ids: {}, pattern: /\bsolana(?:\s+(?:mainnet|devnet|testnet|network))?\b/i, codes: ["sol", "solana"] },
  { id: "sui", name: "Sui", mainnetChainId: null, ids: {}, pattern: /\bSui(?:\s+(?:mainnet|devnet|testnet|network))?\b/, codes: ["sui"] },
  { id: "aptos", name: "Aptos", mainnetChainId: null, ids: {}, pattern: /\baptos(?:\s+(?:mainnet|devnet|testnet|network))?\b/i, codes: ["aptos"] },
  { id: "monad", name: "Monad", mainnetChainId: null, ids: {}, pattern: /\bmonad(?:\s+(?:mainnet|testnet|devnet|chain|network))?\b/i, codes: ["monad"] },
];

const CHAIN_BY_ID = new Map(CHAIN_DEFINITIONS.flatMap((definition) => Object.entries(definition.ids)
  .map(([chainId, environment]) => [Number(chainId), { definition, environment }])));
const CHAIN_BY_CODE = new Map(CHAIN_DEFINITIONS.flatMap((definition) => definition.codes.map((code) => [code, definition])));
const CHAIN_STAGE_RANK = { configured: 1, announced: 2, supported: 3, deployed: 4 };
const CHAIN_ACTION = /\b(?:add(?:s|ed|ing)?(?:\s+support)?|support(?:s|ed|ing)?|enable(?:s|d|ing)?|integrat(?:e|es|ed|ing|ion)|expand(?:s|ed|ing)?|launch(?:es|ed|ing)?|deploy(?:s|ed|ing|ment)?|available|live|roll(?:s|ed|ing)?\s+out|coming)\b/i;
const EXPLICIT_NETWORK_ACTION = /\b(?:now\s+)?(?:live|available|launched|deployed)\s+(?:on|to)\b|\b(?:support|integration|deployment|expansion)\s+(?:for|on|to|with)\b|\b(?:add(?:s|ed|ing)?|enable(?:s|d|ing)?|expand(?:s|ed|ing)?)\s+(?:support\s+for\s+)?(?:a\s+)?(?:new\s+)?(?:chain|network|mainnet|testnet)\b/i;
const GENERIC_NEW_CHAIN = /\b(?:new|another|additional)\s+(?:chain|network)\s+(?:support|integration|deployment|launch)\b|\b(?:multi|cross)[ -]?chain\s+(?:support|expansion|deployment|launch)\b|\b(?:deploy(?:s|ed|ing)?|deployment|launch(?:es|ed|ing)?|expand(?:s|ed|ing)?)\b[^\n]{0,60}\b(?:on|to)\s+(?:a\s+)?new\s+(?:chain|network)\b/i;
const PLATFORM_CONTEXT = /\b(?:flap|four\.?meme|open\s*four|uniswap|long(?:\.xyz)?|pools?\.trade|liquidity[ -]launcher|launchpad|launcher|platform|protocol|factory|router|vault|token\s+manager|contracts?|app)\b/i;
const NETWORK_LIST_CONTEXT = /\b(?:supported|available|enabled)\s+(?:chains?|networks?)\b|\b(?:chains?|networks?)\s*(?::|are\s+)?(?:supported|available|enabled)\b/i;
const TESTNET = /\b(?:testnet|sepolia|chapel|amoy|fuji|devnet|bepolia)\b/i;
const MAINNET = /\bmainnet\b/i;
const NEGATIVE_OR_REMOVAL = /\b(?:no\s+longer|does\s+not|doesn't|do\s+not|not\s+(?:yet\s+)?support(?:ed|ing)?|unsupported|remove(?:s|d|ing)?|disable(?:s|d|ing)?|sunset(?:s|ted|ting)?|deprecat(?:e|ed|ing|ion)|end(?:s|ed|ing)?\s+support)\b/i;
const FUTURE_ONLY = /\b(?:coming\s+soon|coming\s+(?:to|on)|roadmap|proposal|proposed|plan(?:s|ned|ning)?(?:\s+to)?|intend(?:s|ed|ing)?\s+to|will\s+(?:support|launch|deploy|enable|integrate)|vote\s+is\s+live\s+for)\b/i;
const PRESENTATION_NOISE = /\b(?:icon|logo|selector|dropdown|toggle|settings?\s+panel|copy|wording|typo|spelling|translation|locali[sz]ation|documentation|docs?|readme|image|asset|svg|css|layout)\b/i;
const PRESENTATION_CHANGE = /\b(?:add|update|fix|change|replace|reorder|sort|document)\w*\b/i;

const normalizeChainId = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
};

const slug = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const normalizedCode = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function sentenceRange(text, index, length) {
  const floor = Math.max(0, index - 260);
  const ceiling = Math.min(text.length, index + length + 260);
  const before = text.slice(floor, index);
  const after = text.slice(index + length, ceiling);
  // A bare dot is common inside official brands and URLs (Pools.trade,
  // blog.uniswap.org). Only treat a period followed by whitespace/end as a
  // sentence boundary so the brand context is not detached from the action.
  const boundaries = (value) => [...value.matchAll(/[!?;\n]|\.(?=\s|$)/g)].map((match) => match.index);
  const leftBoundaries = boundaries(before);
  const right = boundaries(after);
  const left = leftBoundaries.length ? leftBoundaries.at(-1) : -1;
  return {
    start: left >= 0 ? floor + left + 1 : floor,
    end: right.length ? index + length + Math.min(...right) : ceiling,
  };
}

function environmentFor(text) {
  if (TESTNET.test(text)) return "testnet";
  if (MAINNET.test(text)) return "mainnet";
  return "unknown";
}

function lifecycleStageFor(text) {
  if (FUTURE_ONLY.test(text)) return "announced";
  if (/\b(?:deploy(?:s|ed|ing|ment)?|(?:now\s+)?live\s+(?:on|to)|launch(?:es|ed|ing)?\s+(?:on|to)|production\s+launch)\b/i.test(text)) return "deployed";
  if (/\b(?:support(?:s|ed|ing)?|add(?:s|ed|ing)?\s+support|enable(?:s|d|ing)?|integrat(?:e|es|ed|ing|ion)|expand(?:s|ed|ing)?|available|multi[ -]?chain|cross[ -]?chain)\b/i.test(text)) return "supported";
  return "configured";
}

function explicitIds(text, start, end) {
  const region = text.slice(start, end);
  const matches = [];
  for (const match of region.matchAll(/\bchain(?:\s*id|id)["']?\s*(?::|#|-|={1,2})?\s*["']?(\d{1,15})\b/gi)) {
    const chainId = normalizeChainId(match[1]);
    if (chainId) matches.push({ chainId, index: start + match.index });
  }
  for (const match of region.matchAll(/\(\s*(\d{1,15})\s*\)/g)) {
    const chainId = normalizeChainId(match[1]);
    if (chainId) matches.push({ chainId, index: start + match.index });
  }
  return matches;
}

function validateNamedChain(definition, explicitId, explicitEnvironment) {
  if (!explicitId) return { ok: true, mappedEnvironment: null };
  const mapped = CHAIN_BY_ID.get(explicitId);
  if (!mapped || mapped.definition.id !== definition.id) return { ok: false, mappedEnvironment: null };
  if (explicitEnvironment !== "unknown" && mapped.environment !== explicitEnvironment) return { ok: false, mappedEnvironment: mapped.environment };
  return { ok: true, mappedEnvironment: mapped.environment };
}

function shouldRejectContext(context) {
  if (NEGATIVE_OR_REMOVAL.test(context)) return true;
  return PRESENTATION_NOISE.test(context) && PRESENTATION_CHANGE.test(context);
}

function definitionMatches(text) {
  const matches = [];
  for (const definition of CHAIN_DEFINITIONS) {
    const flags = definition.pattern.flags.includes("g") ? definition.pattern.flags : `${definition.pattern.flags}g`;
    for (const match of text.matchAll(new RegExp(definition.pattern.source, flags))) {
      matches.push({ definition, index: match.index, length: match[0].length, text: match[0] });
    }
  }
  return matches.sort((left, right) => left.index - right.index || right.length - left.length);
}

function extractProseSignals(text, options) {
  const matches = definitionMatches(text);
  const results = [];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index];
    const range = sentenceRange(text, match.index, match.length);
    const context = text.slice(range.start, range.end);
    if (shouldRejectContext(context)) continue;
    const publicationAction = options.assumePublicationAction === true && PLATFORM_CONTEXT.test(text);
    const actionable = (CHAIN_ACTION.test(context) && (PLATFORM_CONTEXT.test(context) || EXPLICIT_NETWORK_ACTION.test(context)))
      || (options.allowNetworkList === true && NETWORK_LIST_CONTEXT.test(context))
      || publicationAction;
    if (!actionable) continue;

    const previous = matches[index - 1];
    const next = matches[index + 1];
    const regionStart = previous && previous.index >= range.start
      ? Math.floor((previous.index + previous.length + match.index) / 2)
      : range.start;
    const regionEnd = next && next.index < range.end
      ? Math.ceil((match.index + match.length + next.index) / 2)
      : range.end;
    const local = text.slice(regionStart, regionEnd);
    const explicitEnvironment = environmentFor(match.text) !== "unknown" ? environmentFor(match.text) : environmentFor(local);
    const sentenceMatches = matches.filter((candidate) => candidate.index >= range.start && candidate.index < range.end);
    const ids = explicitIds(text, range.start, range.end).filter((candidate) => {
      const nearestChain = sentenceMatches.reduce((best, chain) => {
        const distance = Math.abs(candidate.index - chain.index);
        return !best || distance < best.distance ? { chain, distance } : best;
      }, null)?.chain;
      return nearestChain === match;
    });
    const nearestId = ids.length
      ? ids.reduce((best, candidate) => Math.abs(candidate.index - match.index) < Math.abs(best.index - match.index) ? candidate : best).chainId
      : null;
    const validation = validateNamedChain(match.definition, nearestId, explicitEnvironment);
    if (!validation.ok) continue;
    const listDefaultsToMainnet = options.allowNetworkList === true && NETWORK_LIST_CONTEXT.test(context) && explicitEnvironment === "unknown";
    const environment = explicitEnvironment !== "unknown"
      ? explicitEnvironment
      : validation.mappedEnvironment || (listDefaultsToMainnet ? "mainnet" : "unknown");
    const stage = lifecycleStageFor(context);
    if (stage === "announced" && options.includeAnnounced !== true) continue;
    results.push({
      id: match.definition.id,
      name: match.definition.name,
      chainId: nearestId || (environment === "mainnet" ? match.definition.mainnetChainId : null),
      environment,
      stage,
    });
  }
  return results;
}

function definitionForToken(value) {
  const code = normalizedCode(value.replace(/\b(?:mainnet|testnet|sepolia|chapel|amoy|fuji|devnet|network|chain)\b/gi, ""));
  return CHAIN_BY_CODE.get(code) || null;
}

function structuredArraySignals(raw, options) {
  if (options.allowNetworkList !== true) return [];
  const results = [];
  for (const match of raw.matchAll(/["']?(supportedChains|supportedNetworks|chains|networks)["']?\s*(?::|=)\s*\[([^\]]{0,2000})\]/gi)) {
    const key = match[1].toLowerCase();
    const stage = key.startsWith("supported") ? "supported" : "configured";
    const body = match[2];
    for (const objectMatch of body.matchAll(/\{[^{}]{1,1000}\}/g)) {
      const objectText = objectMatch[0];
      const chainId = normalizeChainId(objectText.match(/["']?chain(?:\s*id|id)["']?\s*(?::|=)\s*["']?(\d{1,15})/i)?.[1]);
      const name = objectText.match(/["']?(?:name|networkName|chainName|networkCode)["']?\s*(?::|=)\s*["']([^"']{1,80})["']/i)?.[1] || null;
      if (!chainId && !name) continue;
      const definition = name ? definitionForToken(name) : CHAIN_BY_ID.get(chainId)?.definition;
      const explicitEnvironment = environmentFor(name || "");
      if (definition && chainId) {
        const validation = validateNamedChain(definition, chainId, explicitEnvironment);
        if (!validation.ok) continue;
      }
      const mapped = chainId ? CHAIN_BY_ID.get(chainId) : null;
      const environment = explicitEnvironment !== "unknown" ? explicitEnvironment : mapped?.environment || "mainnet";
      results.push(definition ? {
        id: definition.id,
        name: definition.name,
        chainId: chainId || (environment === "mainnet" ? definition.mainnetChainId : null),
        environment,
        stage,
      } : {
        id: chainId ? `chain-${chainId}` : slug(name) || "unspecified-new-chain",
        name: name || `Chain ID ${chainId}`,
        chainId,
        environment: mapped?.environment || explicitEnvironment,
        stage,
      });
    }
    const scalarBody = body.replace(/\{[^{}]{1,1000}\}/g, "");
    for (const part of scalarBody.split(",")) {
      const value = part.trim().replace(/^["'`\s]+|["'`\s]+$/g, "");
      if (!value || /[{}:]/.test(value)) continue;
      const chainId = normalizeChainId(value);
      if (chainId) {
        const mapped = CHAIN_BY_ID.get(chainId);
        results.push({
          id: mapped?.definition.id || `chain-${chainId}`,
          name: mapped?.definition.name || `Chain ID ${chainId}`,
          chainId,
          environment: mapped?.environment || "unknown",
          stage,
        });
        continue;
      }
      const definition = definitionForToken(value);
      const environment = TESTNET.test(value) ? "testnet" : "mainnet";
      results.push(definition ? {
        id: definition.id,
        name: definition.name,
        chainId: environment === "mainnet" ? definition.mainnetChainId : null,
        environment,
        stage,
      } : {
        id: slug(value) || "unspecified-new-chain",
        name: value,
        chainId: null,
        environment,
        stage,
      });
    }
  }
  return results;
}

function structuredObjectSignals(raw, options) {
  if (options.allowNetworkList !== true) return [];
  const results = [];
  for (const match of raw.matchAll(/\{[^{}]{0,2000}\}/g)) {
    const objectText = match[0];
    const idMatch = objectText.match(/["']?chain(?:\s*id|id)["']?\s*(?::|=)\s*["']?(\d{1,15})/i);
    const chainId = normalizeChainId(idMatch?.[1]);
    if (!chainId) continue;
    const hasNetworkSchema = /["']?(?:networkName|chainName|networkCode|rpcUrl|rpcUrls|blockExplorer|nativeCurrency|networkType|environment|supported|isSupported)["']?\s*(?::|=)/i.test(objectText);
    if (!hasNetworkSchema) continue;
    const name = objectText.match(/["']?(?:networkName|chainName|networkCode)["']?\s*:\s*["']([^"']{1,80})["']/i)?.[1]
      || objectText.match(/\b(?:networkName|chainName|networkCode)\s*=\s*["']([^"']{1,80})["']/i)?.[1]
      || null;
    const definition = name ? definitionForToken(name) : CHAIN_BY_ID.get(chainId)?.definition;
    const explicitEnvironment = environmentFor(`${name || ""} ${objectText.match(/["'](?:environment|networkType)["']\s*:\s*["']([^"']+)["']/i)?.[1] || ""}`);
    if (definition) {
      const validation = validateNamedChain(definition, chainId, explicitEnvironment);
      if (!validation.ok) continue;
      const mapped = CHAIN_BY_ID.get(chainId);
      results.push({
        id: definition.id,
        name: definition.name,
        chainId,
        environment: explicitEnvironment !== "unknown" ? explicitEnvironment : mapped?.environment || "unknown",
        stage: /\b(?:deployed|deployment|live)\b/i.test(objectText) ? "deployed" : /["']?(?:supported|isSupported)["']?\s*:\s*(?:true|["'](?:true|supported|live)["'])/i.test(objectText) ? "supported" : "configured",
      });
      continue;
    }
    results.push({
      id: `chain-${chainId}`,
      name: name || `Chain ID ${chainId}`,
      chainId,
      environment: explicitEnvironment,
      stage: "configured",
    });
  }
  return results;
}

export function mergeChainSupportSignals(values = []) {
  const merged = new Map();
  const conflicts = new Set();
  for (const item of values.filter(Boolean)) {
    const key = `${item.id}:${item.environment}`;
    if (conflicts.has(key)) continue;
    const prior = merged.get(key);
    if (prior?.chainId && item.chainId && prior.chainId !== item.chainId) {
      merged.delete(key);
      conflicts.add(key);
      continue;
    }
    const strongest = !prior || (CHAIN_STAGE_RANK[item.stage] || 0) > (CHAIN_STAGE_RANK[prior.stage] || 0) ? item : prior;
    merged.set(key, { ...strongest, chainId: prior?.chainId || item.chainId || null });
  }
  return [...merged.values()].sort((left, right) => `${left.name}:${left.environment}:${left.chainId || ""}`.localeCompare(`${right.name}:${right.environment}:${right.chainId || ""}`));
}

/**
 * Extract explicit platform-level chain expansion signals. `includeAnnounced`
 * is opt-in so roadmap/proposal language cannot become a strong live-chain
 * signal in existing X, site and Uniswap callers.
 */
export function extractChainSupportSignals(value = "", options = {}) {
  const raw = String(value || "").replace(/\\{1,2}"/g, "\"");
  const text = raw.replace(/[-_]+/g, " ");
  const results = [
    ...(options.structuredOnly === true ? [] : extractProseSignals(text, options)),
    ...structuredArraySignals(raw, options),
    ...structuredObjectSignals(raw, options),
  ];

  if (options.structuredOnly !== true && !results.length && !shouldRejectContext(text)
    && (GENERIC_NEW_CHAIN.test(text) || (EXPLICIT_NETWORK_ACTION.test(text) && /\b(?:chain|network)\b/i.test(text)))) {
    const explicitId = text.match(/\bchain(?:\s*id|id)\s*(?::|#|-|={1,2})?\s*(\d{1,15})\b/i)?.[1];
    const chainId = normalizeChainId(explicitId);
    const mapped = chainId ? CHAIN_BY_ID.get(chainId) : null;
    const stage = lifecycleStageFor(text);
    if (stage !== "announced" || options.includeAnnounced === true) {
      results.push({
        id: mapped?.definition.id || (chainId ? `chain-${chainId}` : "unspecified-new-chain"),
        name: mapped?.definition.name || (chainId ? `Chain ID ${chainId}` : "新链（名称待确认）"),
        chainId,
        environment: mapped?.environment || environmentFor(text),
        stage,
      });
    }
  }

  return mergeChainSupportSignals(results);
}

export function chainSupportLabel(item) {
  if (!item) return "新链（名称待确认）";
  const environment = item.environment === "testnet" ? "测试网" : item.environment === "mainnet" ? "主网" : null;
  const stage = { configured: "已配置", announced: "已公告", supported: "已支持", deployed: "已部署", development: "开发中" }[item.stage] || null;
  return `${item.name || "新链（名称待确认）"}${item.chainId ? ` (${item.chainId})` : ""}${environment ? ` · ${environment}` : ""}${stage ? ` · ${stage}` : ""}`;
}
