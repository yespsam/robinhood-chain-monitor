import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { sendAlerts } from "./alerts.js";
import { extractChainSupportSignals } from "./chain-support.js";

const FOUR_MEME_CONFIG_URL = "https://four.meme/meme-api/v1/public/config";
const FOUR_MEME_NPM_URL = "https://registry.npmjs.org/@four-meme%2Ffour-meme-ai/latest";
const FOUR_MEME_STOCK_DOC_URLS = [
  "https://four-meme.gitbook.io/four.meme/stock-meme/about-stock-meme-en",
  "https://four-meme.gitbook.io/four.meme/stock-meme/about-stock-meme-cn",
];
const FLAP_BOARD_URL = "https://flap.sh/board";
const FLAP_MORPH_BOARD_URL = "https://flap.sh/morph/board";
const FLAP_BOARD_STABLE_OBSERVATIONS = 2;
const FLAP_QUOTE_METADATA_MAX_PER_CHECK = 2;
const FLAP_QUOTE_METADATA_RETRY_BASE_MS = 15_000;
const FLAP_QUOTE_METADATA_RETRY_MAX_MS = 15 * 60_000;
const FLAP_QUOTE_METADATA_NOTIFICATION_VERSION = 1;
const FLAP_QUOTE_BOARD_OBSERVED_KIND = "flap_quote_asset_board_observed";
const FLAP_SITEMAP_URL = "https://docs.flap.sh/sitemap.xml";
const FLAP_DOC_URLS = [
  "https://docs.flap.sh/flap/developers/deployed-contract-addresses",
  "https://docs.flap.sh/flap/developers/vault-developers/vault-and-vaultfactory-specification",
  FLAP_SITEMAP_URL,
];
const FOUR_MEME_LIVE_URLS = [
  "https://four.meme/en",
  "https://four.meme/en/create-token",
  "https://four.meme/en/announcement",
  "https://four.meme/en/campaign",
  "https://four.meme/en/agentic",
  "https://four.meme/en/advanced",
];
const FOUR_MEME_OPTIONAL_WEB_CIRCUIT_STEPS_MS = [
  15 * 60_000,
  60 * 60_000,
  6 * 60 * 60_000,
  24 * 60 * 60_000,
];
const CAPABILITY_ARRAY_KEYS = [
  "quoteTokens",
  "quoteConfigs",
  "flapPools",
  "contracts",
  "versions",
  "modules",
  "chains",
  "pages",
  "pageMetadata",
  "announcements",
  "campaigns",
  "packages",
  "sourceFingerprints",
];
const SIMPLE_CAPABILITY_KEYS = ["quoteTokens", "contracts", "versions", "modules", "pages", "announcements", "campaigns"];
const QUOTES = ["BNB", "WBNB", "USDT", "USD1", "ASTER", "U", "USDC", "CAKE", "FDUSD", "BTCB", "ETH"];
const MODULES = [
  ["Vault V2", /VaultFactoryBaseV2|vaultDataSchema/i],
  [
    "Vault V3（ERC20 报价资产）",
    /VaultBaseV3|ERC-?20\s+quote(?:\s+token)?\s+(?:support|vault)|quote[- ]agnostic\s+(?:reference|vault)|vaultQuoteToken\s*\(|isQuoteTokenSupported\s*\(|factorySpecVersion[\s\S]{0,80}\bv?2\.3\b/i,
  ],
  ["Tax Token V3", /Tax Token V3|TaxTokenV3/i],
  ["AI Oracle", /FlapAIProvider|AI Oracle/i],
  ["X Mode", /\bX Mode\b/i],
  ["多底池交易", /Multi-Token Trading/i],
  ["PancakeSwap V3", /PancakeSwap V3/i],
  ["PancakeSwap V2", /PancakeSwap V2/i],
];

const CHAIN_CATALOG = [
  { name: "Ethereum", aliases: ["Ethereum"], codes: ["ETH", "ETHEREUM"], ids: { "1": "mainnet", "11155111": "testnet", "5": "testnet" } },
  { name: "BNB Chain", aliases: ["BNB Smart Chain", "BNB Chain", "BNB Testnet", "BSC"], codes: ["BSC", "BNB", "BNBCHAIN"], ids: { "56": "mainnet", "97": "testnet" } },
  { name: "Base", aliases: ["Base"], codes: ["BASE"], ids: { "8453": "mainnet", "84532": "testnet" } },
  { name: "Solana", aliases: ["Solana"], codes: ["SOL", "SOLANA"], ids: {} },
  { name: "Arbitrum", aliases: ["Arbitrum One", "Arbitrum"], codes: ["ARB", "ARBITRUM"], ids: { "42161": "mainnet", "421614": "testnet" } },
  { name: "Optimism", aliases: ["OP Mainnet", "Optimism"], codes: ["OP", "OPTIMISM"], ids: { "10": "mainnet", "11155420": "testnet" } },
  { name: "Polygon", aliases: ["Polygon PoS", "Polygon"], codes: ["MATIC", "POLYGON"], ids: { "137": "mainnet", "80002": "testnet", "80001": "testnet" } },
  { name: "Avalanche", aliases: ["Avalanche C-Chain", "Avalanche"], codes: ["AVAX", "AVALANCHE"], ids: { "43114": "mainnet", "43113": "testnet" } },
  { name: "Robinhood Chain", aliases: ["Robinhood Chain", "Robinhood"], codes: ["ROBINHOOD"], ids: { "4663": "mainnet" } },
  { name: "Morph", aliases: ["Morph", "Morph Mainnet", "MorphL2", "Muffun"], codes: ["MORPH", "MORPHL2", "MUFFUN"], ids: { "2818": "mainnet" } },
  { name: "opBNB", aliases: ["opBNB"], codes: ["OPBNB"], ids: { "204": "mainnet", "5611": "testnet" } },
  { name: "Linea", aliases: ["Linea"], codes: ["LINEA"], ids: { "59144": "mainnet", "59141": "testnet" } },
  { name: "Unichain", aliases: ["Unichain"], codes: ["UNICHAIN"], ids: { "130": "mainnet", "1301": "testnet" } },
  { name: "Scroll", aliases: ["Scroll"], codes: ["SCROLL"], ids: { "534352": "mainnet", "534351": "testnet" } },
  { name: "Sonic", aliases: ["Sonic"], codes: ["SONIC"], ids: { "146": "mainnet", "57054": "testnet" } },
  { name: "Blast", aliases: ["Blast"], codes: ["BLAST"], ids: { "81457": "mainnet", "168587773": "testnet" } },
  { name: "Mantle", aliases: ["Mantle"], codes: ["MANTLE"], ids: { "5000": "mainnet", "5003": "testnet" } },
  { name: "Berachain", aliases: ["Berachain"], codes: ["BERA", "BERACHAIN"], ids: { "80094": "mainnet", "80069": "testnet" } },
  { name: "zkSync Era", aliases: ["zkSync Era", "zkSync"], codes: ["ZKSYNC"], ids: { "324": "mainnet", "300": "testnet" } },
];
const CHAIN_BY_ID = new Map(CHAIN_CATALOG.flatMap((chain) => Object.entries(chain.ids).map(([chainId, environment]) => [chainId, { chain, environment }])));
const CHAIN_BY_CODE = new Map(CHAIN_CATALOG.flatMap((chain) => chain.codes.map((code) => [code, chain])));
const CHAIN_STAGE_RANK = { configured: 1, supported: 2, deployed: 3 };
const CASE_SENSITIVE_CHAIN_NAMES = new Set(["Base", "Scroll", "Blast", "Mantle", "Sonic", "Sui"]);
const CHAIN_TESTNET_SIGNAL = /\b(?:testnet|sepolia|goerli|chapel|amoy|fuji|devnet)\b/i;
const CHAIN_DEPLOYMENT_SIGNAL = /\b(?:deploy(?:ed|ment|ing)?|contracts?\s+(?:are\s+)?(?:live|deployed)|live\s+on|launch(?:ed)?\s+on|production\s+launch|deployed\s+contract\s+addresses?)\b/i;
const CHAIN_SUPPORT_SIGNAL = /\b(?:add(?:s|ed|ing)?\s+support|support(?:s|ed|ing)?|enable(?:s|d|ing)?|available\s+on|integrat(?:e|es|ed|ing|ion)|expand(?:s|ed|ing)?\s+to|multi[- ]chain|now\s+on)\b/i;
const CHAIN_CONFIG_SIGNAL = /\b(?:chain[-_ ]?id|network[-_ ]?code|supported[-_ ]?(?:chains|networks)|rpc(?:url)?|network\s+config(?:uration)?|deployed\s+contract\s+addresses?)\b/i;
const CHAIN_FUTURE_OR_NEGATIVE = /\b(?:not\s+(?:yet\s+)?supported|unsupported|coming\s+soon|roadmap|proposal|proposed|consider(?:ing)?|may\s+support|will\s+(?:support|deploy|launch)|plan(?:s|ned)?\s+to)\b/i;
const CHAIN_PRESENTATION_NOISE = /\b(?:icon|logo|image|asset|svg|png|webp|favicon|sort(?:ed|ing)?|order(?:ed|ing)?|alphabetic(?:al)?|wording|copy\s*(?:edit|change)?|typo|spelling|translation|locali[sz]ation|css|color|layout)\b/i;
const CHAIN_PRESENTATION_ONLY = /\b(?:add|update|fix|change|replace|reorder|sort)\w*\b[^.!?;]{0,100}\b(?:icon|logo|image|asset|svg|png|webp|favicon|order|wording|copy|typo|spelling|translation|locali[sz]ation|css|color|layout)\b/i;
const CHAIN_DEPLOYED_CONTRACT_SIGNAL = /\b(?:portal|factory|router|manager|launcher|launchpad|vault|implementation|proxy|core\s+contract)\b[^.!?;]{0,80}\b0x[a-fA-F0-9]{40}\b/i;

const emptyCapabilities = () => Object.fromEntries(CAPABILITY_ARRAY_KEYS.map((key) => [key, []]));

const stableValue = (value) => {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
};

const stableStringify = (value) => JSON.stringify(stableValue(value));
const fingerprint = (value) => createHash("sha256").update(typeof value === "string" ? value : stableStringify(value)).digest("hex");
const uniqueStrings = (values) => [...new Set(values.filter((value) => typeof value === "string" && value.length))].sort();
const uniqueObjects = (values, identity = stableStringify) => [...new Map(values.filter(Boolean).map((value) => [identity(value), value])).values()]
  .sort((left, right) => identity(left).localeCompare(identity(right)));

const normalizeChainId = (value) => {
  const normalized = String(value ?? "").trim();
  if (!/^\d{1,15}$/.test(normalized)) return null;
  const numeric = Number(normalized);
  return Number.isSafeInteger(numeric) ? numeric : normalized;
};

export const contractDiscoveryChainId = (signal) => normalizeChainId(signal?.chainId);

const normalizeChainName = (value) => String(value || "")
  .replace(/^["'`\s]+|["'`\s,.;:]+$/g, "")
  .replace(/^the\s+/i, "")
  .replace(/\s+(?:mainnet|testnet|network)$/i, "")
  .replace(/\s+/g, " ")
  .trim();

const catalogChainByName = (value) => {
  const normalized = normalizeChainName(value).toLowerCase();
  return CHAIN_CATALOG.find((chain) => [chain.name, ...chain.aliases].some((alias) => alias.toLowerCase() === normalized)) || null;
};

const normalizeChainSource = (value) => {
  if (!value || typeof value !== "object" || typeof value.url !== "string" || !value.url.trim()) return null;
  return { kind: typeof value.kind === "string" ? value.kind : "docs", url: canonicalUrl(value.url) };
};

const chainIdentity = (chain) => [
  String(chain?.name || "").toLowerCase(),
  chain?.chainId == null ? "" : String(chain.chainId),
  chain?.environment || "mainnet",
  chain?.stage || "supported",
].join(":");

const chainNetworkIdentity = (chain) => [
  String(chain?.name || "").toLowerCase(),
  chain?.chainId == null ? "" : String(chain.chainId),
  chain?.environment || "unknown",
].join(":");

const mergeChainRecords = (values = []) => {
  const grouped = new Map();
  for (const value of values.filter(Boolean)) {
    const catalogChain = catalogChainByName(value.name);
    const name = catalogChain?.name || normalizeChainName(value.name);
    if (!name || name.length > 80) continue;
    const chainId = normalizeChainId(value.chainId);
    const mapped = chainId == null ? null : CHAIN_BY_ID.get(String(chainId));
    const environment = mapped?.environment === "testnet"
      ? "testnet"
      : ["mainnet", "testnet", "unknown"].includes(value.environment)
        ? value.environment
        : mapped?.environment || "unknown";
    const stage = Object.hasOwn(CHAIN_STAGE_RANK, value.stage) ? value.stage : "supported";
    const normalized = {
      name: catalogChain?.name || mapped?.chain?.name || name,
      chainId,
      environment,
      stage,
      evidence: typeof value.evidence === "string" && value.evidence ? value.evidence : "official_capability",
    };
    const sources = [value.source, ...(Array.isArray(value.sources) ? value.sources : [])].map(normalizeChainSource).filter(Boolean);
    const key = chainNetworkIdentity(normalized);
    const prior = grouped.get(key);
    const strongest = !prior || (CHAIN_STAGE_RANK[normalized.stage] || 0) > (CHAIN_STAGE_RANK[prior.stage] || 0)
      ? normalized
      : prior;
    grouped.set(key, {
      ...strongest,
      evidence: uniqueStrings([...(prior?.evidence ? prior.evidence.split(",") : []), normalized.evidence]).join(","),
      sources: uniqueObjects([...(prior?.sources || []), ...sources], (source) => `${source.kind}:${source.url}`),
    });
  }
  const records = [...grouped.values()];
  const specificNames = new Set(records.filter((record) => record.environment !== "unknown").map((record) => record.name.toLowerCase()));
  return records
    .filter((record) => record.environment !== "unknown" || !specificNames.has(record.name.toLowerCase()))
    .map((record) => ({
      ...record,
      ...(record.sources.length ? { source: record.sources[0] } : {}),
    }))
    .sort((left, right) => chainIdentity(left).localeCompare(chainIdentity(right)));
};

const normalizeCapabilities = (capabilities = {}) => ({
  ...emptyCapabilities(),
  ...Object.fromEntries(CAPABILITY_ARRAY_KEYS.filter((key) => !["chains", "flapPools"].includes(key))
    .map((key) => [key, Array.isArray(capabilities[key]) ? capabilities[key] : []])),
  flapPools: uniqueObjects((Array.isArray(capabilities.flapPools) ? capabilities.flapPools : []).map(normalizeFlapPool), flapPoolIdentity),
  chains: mergeChainRecords(Array.isArray(capabilities.chains) ? capabilities.chains : []),
});

const canonicalUrl = (value) => {
  try {
    const url = new URL(String(value).trim());
    url.hash = "";
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString();
  } catch {
    return String(value).trim().replace(/\/+$/, "");
  }
};

const decodeXml = (value) => value
  .replace(/&amp;/g, "&")
  .replace(/&lt;/g, "<")
  .replace(/&gt;/g, ">")
  .replace(/&quot;/g, "\"")
  .replace(/&#39;/g, "'");

const normalizeFingerprintContent = (text) => {
  const trimmed = String(text).trim();
  try {
    return stableStringify(JSON.parse(trimmed));
  } catch {
    return trimmed
      .replace(/\r\n?/g, "\n")
      .replace(/\bnonce=(["'])[^"']+\1/gi, "nonce=\"\"")
      .replace(/"buildId"\s*:\s*"[^"]+"/g, "\"buildId\":\"\"")
      .replace(/\s+/g, " ")
      .trim();
  }
};

export const PLATFORM_CAPABILITY_TARGETS = [
  {
    id: "flap", name: "Flap", website: "https://flap.sh", twitter: "https://x.com/flapdotsh",
    capabilitySchemaVersion: 4,
    sources: FLAP_DOC_URLS,
    marketSources: [
      { url: FLAP_BOARD_URL, chainId: 56, requiredForBaseline: true },
      { url: FLAP_MORPH_BOARD_URL, chainId: 2818, requiredForBaseline: false },
    ],
    pagePattern: /\/flap\/(?:developers|skills|product-update)(?:\/|$)/i,
    schemaMigration: {
      sourceFingerprints: [FLAP_BOARD_URL, FLAP_MORPH_BOARD_URL, ...FLAP_DOC_URLS],
      added: { pages: FLAP_DOC_URLS, modules: [FLAP_MORPH_BOARD_URL] },
      removed: { quoteTokens: [FLAP_BOARD_URL] },
    },
    fallbackOfficialSources: [
      { name: "Flap 开发文档", url: "https://docs.flap.sh/flap", coveredBy: "platform-capability-monitor" },
      { name: "Flap 官方看板", url: FLAP_BOARD_URL, coveredBy: "platform-capability-monitor" },
      { name: "Flap Morph 看板", url: FLAP_MORPH_BOARD_URL, coveredBy: "platform-capability-monitor" },
      { name: "Flap GitHub", url: "https://github.com/flap-sh", coveredBy: "github-monitor" },
    ],
  },
  {
    id: "fourmeme", name: "Four.meme", website: "https://four.meme", twitter: null,
    // v3 stopped treating published quote assets as platform contracts; v4
    // retires stock-issuance documentation without presenting it as a feature.
    capabilitySchemaVersion: 4,
    sources: [
      "https://four-meme.gitbook.io/four.meme",
      "https://four-meme.gitbook.io/four.meme/guide/how-it-works",
      "https://four-meme.gitbook.io/four.meme/brand/protocol-integration",
      "https://four-meme.gitbook.io/four.meme/product-update",
      "https://four-meme.gitbook.io/four.meme/sitemap.xml",
    ],
    liveSources: FOUR_MEME_LIVE_URLS,
    apiSources: [{ url: FOUR_MEME_CONFIG_URL, parser: "fourmeme-config", authoritativeQuotes: true, requiredForBaseline: true }],
    packageSources: [{ url: FOUR_MEME_NPM_URL, parser: "fourmeme-npm" }],
    pagePattern: /\/(?:product-update|brand\/protocol-integration|guide\/how-it-works|en\/(?:agentic|announcement|campaign|create-token|advanced))/i,
    schemaMigration: {
      sourceFingerprints: FOUR_MEME_LIVE_URLS,
      removed: {
        quoteTokens: FOUR_MEME_STOCK_DOC_URLS,
        contracts: [FOUR_MEME_CONFIG_URL, ...FOUR_MEME_LIVE_URLS, ...FOUR_MEME_STOCK_DOC_URLS],
        versions: FOUR_MEME_STOCK_DOC_URLS,
        modules: [...FOUR_MEME_LIVE_URLS, ...FOUR_MEME_STOCK_DOC_URLS],
        // Sitemap-derived pages carry the sitemap root as provenance. Including
        // it here makes retiring stock-meme pages a silent v4 baseline cleanup.
        pages: [...FOUR_MEME_STOCK_DOC_URLS, "https://four-meme.gitbook.io/four.meme/sitemap.xml"],
        announcements: FOUR_MEME_STOCK_DOC_URLS,
        campaigns: FOUR_MEME_STOCK_DOC_URLS,
      },
    },
  },
];

export function extractPlatformCapabilities(text, pagePattern = /$a/) {
  const visible = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&(?:nbsp|amp|quot|#39);/g, " ");
  const quoteContexts = [...visible.matchAll(/(?:quote\s*token|quoteToken|supported tokens?|trading pair|raised token|multi-token trading)[\s\S]{0,500}?(?=[.!?]|$)/gi)].map((match) => match[0]).join(" ");
  const namedQuotes = QUOTES.filter((symbol) => symbol === "U" ? /\$U\b/.test(quoteContexts) : new RegExp(`(?:\\$|\\b)${symbol}\\b`, "i").test(quoteContexts));
  const dollarQuotes = [...quoteContexts.matchAll(/\$([A-Z][A-Z0-9]{1,9})\b/g)].map((match) => match[1]);
  const quoteTokens = uniqueStrings([...namedQuotes, ...dollarQuotes].map((symbol) => symbol === "WBNB" ? "BNB" : symbol));
  const contracts = uniqueStrings([...visible.matchAll(/0x[a-fA-F0-9]{40}/g)].flatMap((match) => {
    const before = visible.slice(Math.max(0, match.index - 160), match.index).split(/[\n.!?;]/).at(-1) || "";
    const after = visible.slice(match.index + match[0].length, match.index + match[0].length + 120).split(/[\n.!?;]/)[0] || "";
    const context = `${before} ${match[0]} ${after}`;
    const platformRole = /\b(?:factory|launcher|launchpad|portal|vault\s*portal|vault\s*factory|router|hook|token\s*manager|manager|deployer|implementation|proxy|core\s*contract|platform\s*contract)\b/i.test(context);
    const tokenOnlyRole = /\b(?:token|coin|ticker|contract\s+address|\bca\b|quote\s*token|payment\s*token|wallet|owner|creator|recipient)\b/i.test(context)
      && !platformRole;
    return platformRole && !tokenOnlyRole ? [match[0].toLowerCase()] : [];
  }));
  const versions = uniqueStrings([...visible.matchAll(/\bv\d+(?:\.\d+){1,3}\b/gi)].map((match) => match[0].toLowerCase()));
  const modules = MODULES.filter(([, pattern]) => pattern.test(visible)).map(([name]) => name).sort();
  const chains = extractChainCapabilities(text);
  const normalizedPages = [...text.matchAll(/https?:\/\/[^\s<"']+/g)].map((match) => match[0].replace(/\\+$/g, "").replace(/&amp;|[),.;]+$/g, "").replace(/\/$/, ""));
  const pages = uniqueStrings(normalizedPages.filter((url) => pagePattern.test(url) && !/\.(?:md|xml)$/i.test(url)).map(canonicalUrl));
  return { ...emptyCapabilities(), quoteTokens, contracts, versions, modules, chains, pages };
}

const EVM_ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const ZERO_EVM_ADDRESS = `0x${"0".repeat(40)}`;
const isNonZeroEvmAddress = (value) => {
  const address = String(value || "").trim().toLowerCase();
  return EVM_ADDRESS_PATTERN.test(address) && address !== ZERO_EVM_ADDRESS;
};
const KNOWN_FLAP_STOCK_QUOTE_ASSETS = new Set([
  // Alphabet tokenized bStock observed on the official Flap BSC board. Keep
  // the address rule even when a public RPC temporarily cannot return ERC-20
  // metadata, so the same stock quote cannot re-enter as an unknown symbol.
  "0x3f53de71c126bdabae20f9cd64848d317f6c3238",
  // Leveraged semiconductor ETF quotes observed on the official Flap BSC
  // board. Address classification keeps them out of automatic activation even
  // when the first metadata RPC attempt is unavailable.
  "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf", // SOXLB
  "0xe28cd11c99af2df76bb8ada4cd0ef3904378280f", // SOXSB
]);
const FLAP_STOCK_CLASSIFICATION = /(?:\bbstocks?\b|\bstocks?\b|\brwa\b|\betfs?\b|\btokeni[sz]ed\s+(?:stocks?|equities|securit(?:y|ies))\b|\b(?:stocks?|equities)\s+token\b|股票|证券|股权)/i;
const KNOWN_BSTOCK_SYMBOL = /^(?:AAPL|AMZN|COIN|GOOGL|META|MSFT|MSTR|NFLX|NVDA|QQQ|SOXL|SOXS|SPY|TSLA)B$/i;
const isFlapStockClassification = (value) => FLAP_STOCK_CLASSIFICATION.test(String(value || "").replace(/[_-]+/g, " "));

const normalizedFlapMetadataText = (value, maximum = 96) => {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text && text.length <= maximum ? text : null;
};

export function isExcludedFlapQuoteAsset(value = {}) {
  const address = normalizeFlapAddress(value.quoteAddress || value.address);
  if (address && KNOWN_FLAP_STOCK_QUOTE_ASSETS.has(address)) return true;
  const symbol = normalizedFlapMetadataText(value.quoteSymbol || value.symbol, 24);
  if (symbol && KNOWN_BSTOCK_SYMBOL.test(symbol)) return true;
  const classification = [
    value.quoteName,
    value.name,
    value.quoteClassification,
    value.classification,
    value.assetClass,
    value.category,
    value.type,
    ...(Array.isArray(value.quoteTags) ? value.quoteTags : []),
    ...(Array.isArray(value.tags) ? value.tags : []),
  ].filter(Boolean).join(" ");
  return isFlapStockClassification(classification);
}

const normalizeFlapCategory = (value) => {
  const category = String(value || "").trim().replace(/[^a-zA-Z0-9_-]/g, "").toUpperCase();
  return category && category.length <= 48 ? category : null;
};

const normalizeFlapAddress = (value) => {
  const address = String(value || "").trim();
  return EVM_ADDRESS_PATTERN.test(address) ? address.toLowerCase() : null;
};

export function orderedFlapQuoteMetadataRpcUrls(primary, fallbacks = []) {
  return [...new Set([primary, ...(Array.isArray(fallbacks) ? fallbacks : [])]
    .map((value) => String(value || "").trim())
    .filter(Boolean))];
}

const flapMetadataErrorText = (error) => String(error?.message || error || "unknown error")
  .replace(/\s+/g, " ")
  .slice(0, 240);

const withFlapMetadataTimeout = async (task, timeoutMs) => {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(task),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`metadata endpoint timed out after ${timeoutMs}ms`);
          error.code = "FLAP_QUOTE_METADATA_TIMEOUT";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const numericRpcChainId = (value) => {
  try { return Number(typeof value === "string" ? BigInt(value) : value); }
  catch { return Number.NaN; }
};

export async function resolveFlapQuoteAssetMetadataAcrossRpcUrls({
  address,
  chainId,
  rpcUrls,
  providerForUrl,
  readMetadata,
  attemptTimeoutMs = 1_500,
  totalTimeoutMs = 4_500,
  shouldStop = () => false,
}) {
  const quoteAddress = normalizeFlapAddress(address);
  const numericChain = Number(chainId);
  const endpoints = orderedFlapQuoteMetadataRpcUrls(null, rpcUrls);
  const fail = (message, details = {}) => {
    const error = new Error(message);
    error.code = "FLAP_QUOTE_METADATA_UNAVAILABLE";
    error.details = { address: quoteAddress || String(address || ""), chainId: numericChain, ...details };
    return error;
  };
  if (!quoteAddress) throw fail("Flap quote metadata rejected an invalid address");
  if (!Number.isSafeInteger(numericChain) || numericChain <= 0) throw fail("Flap quote metadata rejected an invalid chain ID");
  if (!endpoints.length) throw fail(`Flap quote metadata has no RPC endpoint for chain ${numericChain}`);
  if (typeof providerForUrl !== "function" || typeof readMetadata !== "function") {
    throw fail("Flap quote metadata resolver dependencies are unavailable");
  }

  const endpointTimeoutMs = Math.max(100, Math.min(10_000, Number(attemptTimeoutMs) || 1_500));
  const overallTimeoutMs = Math.max(endpointTimeoutMs, Math.min(30_000, Number(totalTimeoutMs) || 4_500));
  const deadlineAt = Date.now() + overallTimeoutMs;
  const failures = [];
  let attemptedEndpoints = 0;

  for (let index = 0; index < endpoints.length && !shouldStop(); index += 1) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) break;
    attemptedEndpoints += 1;
    try {
      const provider = providerForUrl(endpoints[index], numericChain);
      if (!provider || typeof provider.send !== "function" || typeof provider.getCode !== "function") {
        throw new Error("RPC provider is incomplete");
      }
      const [reportedChainId, code, metadata] = await withFlapMetadataTimeout(() => Promise.all([
        provider.send("eth_chainId", []),
        provider.getCode(quoteAddress, "latest"),
        readMetadata(provider, quoteAddress, "latest"),
      ]), Math.max(1, Math.min(endpointTimeoutMs, remainingMs)));
      const remoteChain = numericRpcChainId(reportedChainId);
      if (remoteChain !== numericChain) throw new Error(`RPC chain ID ${reportedChainId} != expected ${numericChain}`);
      if (typeof code !== "string" || !/^0x(?:[0-9a-fA-F]{2})+$/.test(code)) throw new Error("quote contract code is unavailable");
      const name = typeof metadata?.name === "string" ? metadata.name.trim() : "";
      const symbol = typeof metadata?.symbol === "string" ? metadata.symbol.trim() : "";
      const decimals = Number(metadata?.decimals);
      if (!name || name.length > 256) throw new Error("quote token name is unavailable or invalid");
      if (!symbol || symbol.length > 24) throw new Error("quote token symbol is unavailable or invalid");
      if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) throw new Error("quote token decimals are unavailable or invalid");
      return { ...metadata, name, symbol, decimals };
    } catch (error) {
      failures.push({
        endpoint: index + 1,
        code: String(error?.code || "RPC_ERROR"),
        message: flapMetadataErrorText(error),
      });
    }
  }

  const failureSummary = failures.slice(0, 3)
    .map(({ endpoint, code, message }) => `#${endpoint} ${code}: ${message}`)
    .join(" | ");
  throw fail(
    `Flap quote metadata failed on ${attemptedEndpoints}/${endpoints.length} RPC endpoints${failureSummary ? `; ${failureSummary}` : ""}`,
    { attemptedEndpoints, endpointCount: endpoints.length, failures },
  );
}

const flapPoolIdentity = (item) => {
  const chain = item?.chainId == null ? "" : `chain-${item.chainId}:`;
  return item?.kind === "quote_asset"
    ? `${chain}quote:${item.quoteAddress || ""}`
    : `${chain}vault:${item?.category || ""}:${item?.vaultFactory || ""}`;
};

const flapPoolIdentityWithoutChain = (item) => item?.kind === "quote_asset"
  ? `quote:${item.quoteAddress || ""}`
  : `vault:${item?.category || ""}:${item?.vaultFactory || ""}`;

const flapPoolObservationFingerprint = (item) => fingerprint({
  chainId: item?.chainId || null,
  kind: item?.kind || null,
  category: item?.category || null,
  vaultFactory: item?.vaultFactory || null,
  quoteAddress: item?.quoteAddress || null,
});

const normalizeFlapPool = (value) => {
  const category = normalizeFlapCategory(value?.category);
  const vaultFactory = normalizeFlapAddress(value?.vaultFactory);
  const quoteAddress = normalizeFlapAddress(value?.quoteAddress);
  const kind = value?.kind === "quote_asset" || (!category && !vaultFactory && quoteAddress)
    ? "quote_asset"
    : "vault_factory";
  if (kind === "quote_asset" && !quoteAddress) return null;
  if (kind === "vault_factory" && (!category || !vaultFactory)) return null;
  const record = {
    kind,
    category: kind === "vault_factory" ? category : null,
    vaultFactory: kind === "vault_factory" ? vaultFactory : null,
    quoteAddress,
    quoteSymbol: typeof value?.quoteSymbol === "string" && /^[A-Za-z0-9_$.-]{1,24}$/.test(value.quoteSymbol.trim())
      ? value.quoteSymbol.trim()
      : null,
    sourceUrl: canonicalUrl(value?.sourceUrl || FLAP_BOARD_URL),
    ...(normalizeChainId(value?.chainId) == null ? {} : { chainId: normalizeChainId(value.chainId) }),
  };
  const quoteName = normalizedFlapMetadataText(value?.quoteName || value?.name);
  const quoteClassification = normalizedFlapMetadataText(value?.quoteClassification || value?.classification || value?.assetClass);
  const quoteTags = uniqueStrings(Array.isArray(value?.quoteTags) ? value.quoteTags.map((item) => normalizedFlapMetadataText(item, 48)).filter(Boolean) : []).slice(0, 8);
  if (quoteName) record.quoteName = quoteName;
  if (quoteClassification) record.quoteClassification = quoteClassification;
  if (quoteTags.length) record.quoteTags = quoteTags;
  return { identity: flapPoolIdentity(record), ...record };
};

const isLegacyBscBoardFlapPool = (item) => item?.chainId == null
  && canonicalUrl(item?.sourceUrl || FLAP_BOARD_URL) === canonicalUrl(FLAP_BOARD_URL);

const scopeLegacyBscBoardFlapPool = (value, enabled) => {
  const normalized = normalizeFlapPool(value);
  if (!normalized || !enabled || !isLegacyBscBoardFlapPool(normalized)) return normalized;
  return normalizeFlapPool({ ...normalized, chainId: 56 });
};

const mergeFlapPoolCandidateRecords = (left, right) => {
  if (!left) return { ...right };
  const firstObservedAt = [left.firstObservedAt, right.firstObservedAt].filter(Boolean).sort()[0] || null;
  const lastObservedAt = [left.lastObservedAt, right.lastObservedAt].filter(Boolean).sort().at(-1) || null;
  return {
    ...left,
    ...right,
    observations: Math.max(Number(left.observations || 0), Number(right.observations || 0)),
    pendingObservations: Math.max(Number(left.pendingObservations || 0), Number(right.pendingObservations || 0)),
    confirmed: left.confirmed === true || right.confirmed === true,
    ...(firstObservedAt ? { firstObservedAt } : {}),
    ...(lastObservedAt ? { lastObservedAt } : {}),
  };
};

const extractBalancedJsonObject = (text, start) => {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") quoted = false;
      continue;
    }
    if (character === "\"") quoted = true;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return text.slice(start, index + 1);
  }
  return null;
};

const embeddedFlapPayloads = (text) => {
  const decoded = decodeEmbeddedText(text);
  const payloads = [];
  try { payloads.push(JSON.parse(decoded)); } catch {}
  const marker = /"initialBoard"\s*:/g;
  for (const match of decoded.matchAll(marker)) {
    const start = decoded.indexOf("{", match.index + match[0].length);
    if (start === -1) continue;
    const object = extractBalancedJsonObject(decoded, start);
    if (!object) continue;
    try { payloads.push(JSON.parse(object)); } catch {}
  }
  return { decoded, payloads };
};

export function extractFlapMarketCapabilities(text, sourceUrl = FLAP_BOARD_URL, chainId = null) {
  // Only structured board fields are capabilities. In particular, coin.address
  // and image/catalog paths belong to rotating token cards and are ignored.
  const { decoded, payloads } = embeddedFlapPayloads(text);
  const pools = [];
  const categories = new Set();
  const visited = new WeakSet();
  const metadataVisited = new WeakSet();
  const metadataByAddress = new Map();
  const addressFromValue = (value) => normalizeFlapAddress(typeof value === "object" && value
    ? value.address || value.tokenAddress || value.contractAddress
    : value);
  const metadataFromValue = (value = {}) => ({
    quoteName: normalizedFlapMetadataText(value.name || value.tokenName || value.assetName),
    quoteSymbol: normalizedFlapMetadataText(value.symbol || value.tokenSymbol || value.ticker, 24),
    quoteClassification: normalizedFlapMetadataText(value.assetClass || value.classification || value.assetType || value.type || value.category),
    quoteTags: Array.isArray(value.tags) ? value.tags : [],
  });
  const mergeMetadata = (...values) => {
    const merged = {};
    for (const value of values.filter(Boolean)) {
      if (!merged.quoteName && value.quoteName) merged.quoteName = value.quoteName;
      if (!merged.quoteSymbol && value.quoteSymbol) merged.quoteSymbol = value.quoteSymbol;
      if (!merged.quoteClassification && value.quoteClassification) merged.quoteClassification = value.quoteClassification;
      merged.quoteTags = uniqueStrings([...(merged.quoteTags || []), ...(value.quoteTags || [])]);
    }
    return merged;
  };
  const collectMetadata = (value) => {
    if (!value || typeof value !== "object" || metadataVisited.has(value)) return;
    metadataVisited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) collectMetadata(item);
      return;
    }
    const address = addressFromValue(value);
    if (address) metadataByAddress.set(address, mergeMetadata(metadataByAddress.get(address), metadataFromValue(value)));
    for (const child of Object.values(value)) collectMetadata(child);
  };
  for (const payload of payloads) collectMetadata(payload);
  const quoteMetadata = (value, container = {}) => {
    const address = addressFromValue(value);
    const inline = typeof value === "object" && value ? metadataFromValue(value) : null;
    const contextual = {
      quoteName: normalizedFlapMetadataText(container.quoteName || container.quoteTokenName || container.quoteAssetName),
      quoteSymbol: normalizedFlapMetadataText(container.quoteSymbol || container.quoteTokenSymbol || container.quoteAssetSymbol, 24),
      quoteClassification: normalizedFlapMetadataText(container.quoteClassification || container.quoteAssetClass || container.quoteTokenType),
      quoteTags: Array.isArray(container.quoteTags) ? container.quoteTags : [],
    };
    return mergeMetadata(address ? metadataByAddress.get(address) : null, inline, contextual);
  };
  const addQuote = (value, container = {}) => {
    const quoteAddress = addressFromValue(value);
    if (!quoteAddress) return;
    pools.push(normalizeFlapPool({ kind: "quote_asset", quoteAddress, ...quoteMetadata(value, container), sourceUrl, chainId }));
  };
  const addVault = (value, inheritedQuoteAddress = null) => {
    const vaultFactory = normalizeFlapAddress(value?.vaultFactory);
    const quoteAddress = addressFromValue(value?.quoteToken || inheritedQuoteAddress);
    const values = Array.isArray(value?.vaultFactoryCategory)
      ? value.vaultFactoryCategory
      : [value?.vaultFactoryCategory];
    for (const candidate of values) {
      const category = normalizeFlapCategory(candidate);
      if (!category) continue;
      categories.add(category);
      if (vaultFactory) pools.push(normalizeFlapPool({
        kind: "vault_factory",
        category,
        vaultFactory,
        quoteAddress,
        ...quoteMetadata(value?.quoteToken || quoteAddress, value),
        sourceUrl,
        chainId,
      }));
    }
  };
  const visit = (value, inheritedQuoteAddress = null) => {
    if (!value || typeof value !== "object") return;
    if (visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const item of value) visit(item, inheritedQuoteAddress);
      return;
    }
    const quoteAddress = addressFromValue(value.quoteToken) || inheritedQuoteAddress;
    if (value.quoteToken) addQuote(value.quoteToken, value);
    addVault(value, quoteAddress);
    if (value.vault && typeof value.vault === "object") addVault(value.vault, quoteAddress);
    for (const child of Object.values(value)) visit(child, quoteAddress);
  };
  for (const payload of payloads) visit(payload);

  // Keep a narrow fallback for Flight/fixture fragments that are not complete
  // JSON. Exact field names prevent ordinary coin/token addresses from leaking
  // into capability state.
  for (const match of decoded.matchAll(/"quoteToken"\s*:\s*"(0x[a-fA-F0-9]{40})"/g)) addQuote(match[1]);
  for (const match of decoded.matchAll(/"?vaultFactoryCategory"?\s*:\s*\[([^\]]*)\]/g)) {
    for (const item of match[1].matchAll(/"([a-zA-Z0-9_-]+)"/g)) {
      const category = normalizeFlapCategory(item[1]);
      if (category) categories.add(category);
    }
  }
  for (const match of decoded.matchAll(/"vaultFactory"\s*:\s*"(0x[a-fA-F0-9]{40})"/g)) {
    const window = decoded.slice(match.index, match.index + 600);
    const categoryBlock = window.match(/"vaultFactoryCategory"\s*:\s*\[([^\]]*)\]/)?.[1];
    for (const item of categoryBlock?.matchAll(/"([a-zA-Z0-9_-]+)"/g) || []) {
      const category = normalizeFlapCategory(item[1]);
      if (!category) continue;
      const fallbackPool = normalizeFlapPool({
        kind: "vault_factory",
        category,
        vaultFactory: match[1],
        sourceUrl,
        chainId,
      });
      // Structured payloads retain the quote/vault relationship. The narrow
      // text fallback must not overwrite that richer record with quoteAddress
      // null when `uniqueObjects` folds the duplicate identity below.
      if (fallbackPool && !pools.some((pool) => flapPoolIdentity(pool) === flapPoolIdentity(fallbackPool))) {
        pools.push(fallbackPool);
      }
    }
  }

  return {
    ...emptyCapabilities(),
    flapPools: uniqueObjects(pools, flapPoolIdentity),
    modules: uniqueStrings([...categories]
      .filter((category) => !isFlapStockClassification(category))
      .map((category) => `Vault ${category}`)),
  };
}

const normalizeContractName = (value) => value
  .replace(/(?:Address|Contract)$/i, "")
  .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
  .replace(/[^A-Za-z0-9]+/g, "_")
  .replace(/^_+|_+$/g, "")
  .toUpperCase();

const decodeEmbeddedText = (text) => String(text)
  .replace(/\\{2,}"/g, "\"")
  .replace(/\\"/g, "\"")
  .replace(/\\u0026/g, "&")
  .replace(/\\n/g, " ");

const literalNameMatcher = (value, flags = "gi") => new RegExp(
  `(?<![A-Za-z0-9])${String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`,
  flags,
);

const boundedChainContext = (text, index, length, radius = 220) => {
  const floor = Math.max(0, index - radius);
  const ceiling = Math.min(text.length, index + length + radius);
  const before = text.slice(floor, index);
  const after = text.slice(index + length, ceiling);
  const leftBoundary = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf(";"), before.lastIndexOf("\n"));
  const rightCandidates = [after.indexOf("."), after.indexOf("!"), after.indexOf("?"), after.indexOf(";"), after.indexOf("\n")].filter((value) => value >= 0);
  const start = leftBoundary >= 0 ? floor + leftBoundary + 1 : floor;
  const end = rightCandidates.length ? index + length + Math.min(...rightCandidates) : ceiling;
  return text.slice(start, end);
};

const chainEvidenceWindows = (text, signal) => {
  const catalogChain = catalogChainByName(signal.name);
  const needles = catalogChain ? uniqueStrings([catalogChain.name, ...catalogChain.aliases]) : [];
  if (!needles.length && signal.chainId) needles.push(String(signal.chainId));
  const windows = [];
  for (const needle of needles) {
    const matcher = literalNameMatcher(needle);
    for (const match of text.matchAll(matcher)) {
      windows.push(boundedChainContext(text, match.index, match[0].length));
    }
  }
  return windows.length ? windows : [text.slice(0, 800)];
};

const explicitChainIdIn = (text) => normalizeChainId(
  text.match(/\bchain(?:[-_ ]?id)["']?\s*(?::|#|-|={1,2})\s*["']?(\d{1,15})\b/i)?.[1],
);

const explicitChainIdNearSignal = (context, signal) => {
  const ids = [...context.matchAll(/\bchain(?:[-_ ]?id)["']?\s*(?::|#|-|={1,2})\s*["']?(\d{1,15})\b/gi)];
  if (!ids.length) return null;
  const catalogChain = catalogChainByName(signal.name);
  const names = uniqueStrings([signal.name, ...(catalogChain?.aliases || [])]);
  const positions = names.flatMap((name) => [...context.matchAll(literalNameMatcher(name))].map((match) => match.index));
  if (!positions.length) return normalizeChainId(ids[0][1]);
  const nearest = ids.reduce((best, match) => {
    const distance = Math.min(...positions.map((position) => Math.abs(position - match.index)));
    return !best || distance < best.distance ? { match, distance } : best;
  }, null);
  return normalizeChainId(nearest.match[1]);
};

const explicitChainIdNearIndex = (text, index, length, radius = 180) => {
  const parenthetical = text.slice(index + length, index + length + 60).match(/^\s*(?:mainnet|testnet)?\s*\(\s*(\d{1,15})\s*\)/i)?.[1];
  if (parenthetical) return normalizeChainId(parenthetical);
  const ids = [...text.matchAll(/\bchain(?:[-_ ]?id)["']?\s*(?::|#|-|={1,2})\s*["']?(\d{1,15})\b/gi)]
    .filter((match) => Math.abs(match.index - index) <= radius);
  if (!ids.length) return null;
  const nearest = ids.reduce((best, match) => Math.abs(match.index - index) < Math.abs(best.index - index) ? match : best);
  return normalizeChainId(nearest[1]);
};

const environmentNearAlias = (text, index, alias) => {
  if (CHAIN_TESTNET_SIGNAL.test(alias)) return "testnet";
  const escaped = String(alias).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const context = text.slice(Math.max(0, index - 30), Math.min(text.length, index + alias.length + 30));
  const match = context.match(new RegExp(`\\b(mainnet|testnet|sepolia|goerli|chapel|amoy|fuji|devnet)\\s+${escaped}\\b|\\b${escaped}\\s+(mainnet|testnet|sepolia|goerli|chapel|amoy|fuji|devnet)\\b`, "i"));
  const marker = match?.[1] || match?.[2];
  return marker ? (CHAIN_TESTNET_SIGNAL.test(marker) ? "testnet" : "mainnet") : "unknown";
};

const chainStageFor = (context) => CHAIN_DEPLOYMENT_SIGNAL.test(context)
  ? "deployed"
  : CHAIN_SUPPORT_SIGNAL.test(context)
    ? "supported"
    : "configured";

const chainEvidenceFor = (stage, environment) => stage === "deployed"
  ? `${environment === "testnet" ? "testnet" : environment === "mainnet" ? "mainnet" : "network"}_deployment`
  : stage === "supported"
    ? "supported_network"
    : "network_config";

const actionableChainContext = (context) => {
  if (CHAIN_FUTURE_OR_NEGATIVE.test(context)) return false;
  if (CHAIN_PRESENTATION_ONLY.test(context)) return false;
  return CHAIN_DEPLOYMENT_SIGNAL.test(context)
    || CHAIN_SUPPORT_SIGNAL.test(context)
    || (CHAIN_CONFIG_SIGNAL.test(context) && explicitChainIdIn(context) != null)
    || CHAIN_DEPLOYED_CONTRACT_SIGNAL.test(context);
};

/**
 * Extract durable platform-level chain capabilities. The shared signal parser
 * keeps naming consistent with X/governance monitoring, while the stricter
 * context checks here reject future plans and presentation-only churn.
 */
export function extractChainCapabilities(input, options = {}) {
  const raw = typeof input === "string" ? input : JSON.stringify(input ?? {});
  const decoded = decodeEmbeddedText(raw);
  const visible = decoded
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(?:nbsp|amp|quot|#39);/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const source = options.sourceUrl ? { kind: options.sourceKind || "docs", url: options.sourceUrl } : null;
  const candidates = [];
  const add = (value) => candidates.push({ ...value, ...(source ? { source } : {}) });

  const directlyExtractedNames = new Set();
  for (const catalogChain of CHAIN_CATALOG) {
    for (const alias of uniqueStrings([catalogChain.name, ...catalogChain.aliases])) {
      const flags = CASE_SENSITIVE_CHAIN_NAMES.has(catalogChain.name) ? "g" : "gi";
      for (const match of visible.matchAll(literalNameMatcher(alias, flags))) {
        const context = boundedChainContext(visible, match.index, match[0].length, 320);
        if (!actionableChainContext(context)) continue;
        const explicitChainId = explicitChainIdNearIndex(visible, match.index, match[0].length);
        const mapped = explicitChainId == null ? null : CHAIN_BY_ID.get(String(explicitChainId));
        const aliasEnvironment = environmentNearAlias(visible, match.index, match[0]);
        const catalogEnvironments = uniqueStrings(Object.values(catalogChain.ids));
        const environment = mapped?.environment
          || (aliasEnvironment !== "unknown" ? aliasEnvironment : catalogEnvironments.length === 1 ? catalogEnvironments[0] : "unknown");
        const inferredId = Object.entries(catalogChain.ids).find(([, candidateEnvironment]) => candidateEnvironment === environment)?.[0];
        const deployedContract = CHAIN_DEPLOYED_CONTRACT_SIGNAL.test(context);
        const stage = deployedContract ? "deployed" : chainStageFor(context);
        add({
          name: mapped?.chain?.name || catalogChain.name,
          chainId: explicitChainId ?? normalizeChainId(inferredId),
          environment,
          stage,
          evidence: deployedContract ? "deployed_contract" : chainEvidenceFor(stage, environment),
        });
        directlyExtractedNames.add(catalogChain.name.toLowerCase());
      }
    }
  }

  for (const signal of extractChainSupportSignals(visible)) {
    if (directlyExtractedNames.has(signal.name.toLowerCase())) continue;
    const contexts = chainEvidenceWindows(visible, signal);
    const context = contexts.find(actionableChainContext);
    if (!context) continue;
    const explicitChainId = explicitChainIdNearSignal(context, signal);
    const mapped = explicitChainId == null ? null : CHAIN_BY_ID.get(String(explicitChainId));
    const environment = CHAIN_TESTNET_SIGNAL.test(context)
      ? "testnet"
      : /\bmainnet\b/i.test(context)
        ? "mainnet"
        : mapped?.environment || signal.environment || "unknown";
    const stage = chainStageFor(context);
    add({
      name: mapped?.chain?.name || signal.name,
      chainId: explicitChainId ?? signal.chainId ?? null,
      environment,
      stage,
      evidence: chainEvidenceFor(stage, environment),
    });
  }

  // A literal chainId/network configuration is sufficient evidence even when
  // an unfamiliar chain is not yet present in the shared name catalog. Token
  // feed objects are explicitly excluded so rotating cards cannot add chains.
  for (const match of decoded.matchAll(/\bchain(?:[-_ ]?id)["']?\s*(?::|#|-|={1,2})\s*["']?(\d{1,15})\b/gi)) {
    const chainId = normalizeChainId(match[1]);
    if (chainId == null) continue;
    const context = boundedChainContext(decoded, match.index, match[0].length, 280);
    const tokenFeedObject = /\b(?:tokenAddress|creatorAddress|marketCap|price|ticker|symbol)\b/i.test(context)
      && !/\b(?:rpc(?:Url)?|networkName|chainName|networkCode|nativeCurrency|blockExplorer|supportedChains|supportedNetworks|factory|router|launchpad)\b/i.test(context);
    if (tokenFeedObject || CHAIN_FUTURE_OR_NEGATIVE.test(context) || CHAIN_PRESENTATION_NOISE.test(context)) continue;
    const mapped = CHAIN_BY_ID.get(String(chainId));
    const configuredName = context.match(/["'](?:networkName|chainName)["']\s*:\s*["']([^"']{2,80})["']/i)?.[1];
    const namedCatalog = configuredName ? catalogChainByName(configuredName) : null;
    const environment = CHAIN_TESTNET_SIGNAL.test(context) ? "testnet" : mapped?.environment || (/\bmainnet\b/i.test(context) ? "mainnet" : "unknown");
    const stage = CHAIN_DEPLOYMENT_SIGNAL.test(context) ? "deployed" : "configured";
    add({
      name: mapped?.chain?.name || namedCatalog?.name || configuredName || `Chain ID ${chainId}`,
      chainId,
      environment,
      stage,
      evidence: chainEvidenceFor(stage, environment),
    });
  }

  for (const match of decoded.matchAll(/["']?(supportedChains|supportedNetworks)["']?\s*:\s*\[([^\]]{1,1000})\]/gi)) {
    if (CHAIN_PRESENTATION_NOISE.test(match[0])) continue;
    const values = [...match[2].matchAll(/["']([^"']{1,80})["']|\b(\d{1,15})\b/g)].map((item) => item[1] || item[2]);
    for (const value of values) {
      const explicitId = normalizeChainId(value);
      const mapped = explicitId == null ? null : CHAIN_BY_ID.get(String(explicitId));
      const catalogChain = mapped?.chain || CHAIN_BY_CODE.get(String(value).replace(/[^A-Za-z0-9]/g, "").toUpperCase()) || catalogChainByName(value);
      const name = mapped?.chain?.name || catalogChain?.name || normalizeChainName(value);
      if (!name || (!catalogChain && explicitId == null && !/^[A-Za-z][A-Za-z0-9 .-]{1,60}$/.test(name))) continue;
      const inferredMainnetId = catalogChain
        ? Object.entries(catalogChain.ids).find(([, environment]) => environment === "mainnet")?.[0]
        : null;
      const chainId = explicitId ?? normalizeChainId(inferredMainnetId);
      const environment = mapped?.environment || (CHAIN_TESTNET_SIGNAL.test(value) ? "testnet" : "mainnet");
      add({ name, chainId, environment, stage: "supported", evidence: "supported_network_config" });
    }
  }

  return mergeChainRecords(candidates);
}

export function extractFourMemeLiveCapabilities(text) {
  const normalized = decodeEmbeddedText(text);
  const signalText = normalized.replace(
    /"(?:AIAgentMode|CreatorMode|alphaMode|rushMode|taxMode|presale|openFour|skillRoyalty|xMode)"\s*:\s*(?:false|null|0|"false"|"0")/gi,
    "",
  );
  const signals = [
    ["Agentic", /href="\/en\/agentic"|Agentic launch|Agent Skill/i],
    ["X Mode", /"X Mode"|modeHintX|"xMode"\s*:\s*(?:true|"true")/i],
    ["AI Agent Mode", /"AIAgentMode"\s*:\s*(?!false|null|0|"false"|"0")|AI Agent Mode/i],
    ["Creator Mode", /"CreatorMode"\s*:\s*(?!false|null|0|"false"|"0")|Creator Mode/i],
    ["Alpha Mode", /"alphaMode"\s*:\s*(?:true|"true")|Alpha Mode/i],
    ["Rush Mode", /"rushMode"\s*:\s*(?:true|"true")|Rush Mode/i],
    ["Tax Mode", /"taxMode"\s*:\s*(?:true|"true")|Tax Mode is Live/i],
    ["Presale", /Presale Start Time|Presale Whitelist|"presale"\s*:\s*(?:true|"true")/i],
    ["OpenFour", /OpenFour|"openFour"\s*:\s*(?:true|"true")/i],
    ["Skill Royalty", /Skill Royality|Skill Royalty|"skillRoyalty"\s*:\s*(?:true|"true")/i],
    ["EIP-8004", /EIP-8004|Register 8004/i],
    ["Binance Square integration", /Binance Square Post|Post to Binance Square/i],
  ];
  const modules = signals.filter(([, pattern]) => pattern.test(signalText)).map(([name]) => name);
  const namedContracts = [];
  for (const objectMatch of normalized.matchAll(/\{[^{}]{0,1600}\}/g)) {
    const objectText = objectMatch[0];
    const address = objectText.match(/"(?:address|contractAddress)"\s*:\s*"(0x[a-fA-F0-9]{40})"/i)?.[1];
    // Generic {name,address} objects on the homepage are rotating token cards.
    // Only the explicit contractName schema is platform-contract evidence.
    const name = objectText.match(/"contractName"\s*:\s*"([A-Za-z][A-Za-z0-9_-]{1,100})"/i)?.[1];
    if (address && name) namedContracts.push([normalizeContractName(name), address.toLowerCase()]);
  }
  for (const match of normalized.matchAll(/"([A-Za-z][A-Za-z0-9_]{1,100})"\s*:\s*"(0x[a-fA-F0-9]{40})"/g)) {
    if (/^(?:address|contractAddress|symbolAddress|walletAddress|userAddress|creatorAddress|tokenAddress|ownerAddress|accountAddress|recipientAddress)$/i.test(match[1])) continue;
    if (!/(?:address|contract|manager|creator|keeper|helper|executor|router|factory|tagger|place)/i.test(match[1])) continue;
    const normalizedName = normalizeContractName(match[1]);
    if (/^(?:TOKEN|CREATOR|OWNER|USER|WALLET|ACCOUNT|RECIPIENT)$/.test(normalizedName)) continue;
    namedContracts.push([normalizedName, match[2].toLowerCase()]);
  }
  for (const [name] of namedContracts) if (name) modules.push(`Contract ${name}`);
  const announcements = [];
  for (const objectMatch of normalized.matchAll(/\{[^{}]{0,2000}\}/g)) {
    const objectText = objectMatch[0];
    const id = objectText.match(/"(?:id|announcementId)"\s*:\s*"?(\d{3,})"?/i)?.[1];
    const title = objectText.match(/"(?:title|announcementTitle)"\s*:\s*"((?:\\.|[^"\\]){2,200})"/i)?.[1];
    if (id && title && !/^\d+$/.test(title)) announcements.push(`${id}:${title.replace(/\\"/g, "\"").trim()}`);
  }
  for (const match of normalized.matchAll(/"(?:id|announcementId)"\s*:\s*"?(\d{3,})"?/gi)) {
    const window = normalized.slice(match.index, match.index + 1200);
    const title = window.match(/"(?:title|announcementTitle)"\s*:\s*"((?:\\.|[^"\\]){2,200})"/i)?.[1];
    if (title && !/^\d+$/.test(title)) announcements.push(`${match[1]}:${title.replace(/\\"/g, "\"").trim()}`);
  }
  const campaigns = [];
  for (const objectMatch of normalized.matchAll(/\{[^{}]{0,2000}\}/g)) {
    const objectText = objectMatch[0];
    const id = objectText.match(/"(?:campaignId|activityId)"\s*:\s*"?([A-Za-z0-9_-]{2,100})"?/i)?.[1];
    const title = objectText.match(/"(?:title|name|campaignName)"\s*:\s*"((?:\\.|[^"\\]){2,200})"/i)?.[1];
    const status = objectText.match(/"status"\s*:\s*"([A-Za-z0-9_-]{2,40})"/i)?.[1];
    if (id) campaigns.push([id, title, status].filter(Boolean).join(":"));
  }
  for (const match of normalized.matchAll(/"(?:campaignId|activityId)"\s*:\s*"?([A-Za-z0-9_-]{2,100})"?/gi)) {
    const window = normalized.slice(match.index, match.index + 1200);
    const title = window.match(/"(?:title|name|campaignName)"\s*:\s*"((?:\\.|[^"\\]){2,200})"/i)?.[1];
    const status = window.match(/"status"\s*:\s*"([A-Za-z0-9_-]{2,40})"/i)?.[1];
    campaigns.push([match[1], title, status].filter(Boolean).join(":"));
  }
  return {
    ...emptyCapabilities(),
    contracts: uniqueStrings(namedContracts.map(([, address]) => address)),
    modules: uniqueStrings(modules),
    chains: extractChainCapabilities(text),
    announcements: uniqueStrings(announcements),
    campaigns: uniqueStrings(campaigns),
  };
}

const requireObject = (value, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} schema: expected object`);
  return value;
};

export function extractFourMemeConfigCapabilities(input, sourceUrl = FOUR_MEME_CONFIG_URL) {
  let payload;
  try { payload = typeof input === "string" ? JSON.parse(input) : input; }
  catch { throw new Error("Four.meme config schema: invalid JSON"); }
  requireObject(payload, "Four.meme config");
  if (payload.code !== 0 || !Array.isArray(payload.data)) throw new Error("Four.meme config schema: expected code=0 and data array");
  const publishedNetworks = payload.data.filter((item) => item && item.platform === "MEME" && item.status === "PUBLISH" && typeof item.networkCode === "string");
  const published = publishedNetworks.filter((item) => item.networkCode === "BSC");
  if (!published.length) throw new Error("Four.meme config schema: no MEME/BSC PUBLISH entries");
  const quoteConfigs = published.flatMap((item) => {
    if (typeof item.symbol !== "string" || !item.symbol.trim()) throw new Error("Four.meme config schema: published entry missing symbol");
    if (!/^0x[a-fA-F0-9]{40}$/.test(item.symbolAddress || "")) throw new Error(`Four.meme config schema: ${item.symbol} missing valid symbolAddress`);
    const symbol = item.symbol.trim().toUpperCase();
    const address = item.symbolAddress.toLowerCase();
    // Four.Meme represents the native BNB quote with the zero-address sentinel.
    // It is a valid source capability but never an ERC-20 pool identity.
    if (address === ZERO_EVM_ADDRESS && symbol === "BNB") return [];
    if (!isNonZeroEvmAddress(address)) throw new Error(`Four.meme config schema: ${symbol} missing non-zero symbolAddress`);
    return [{
      symbol,
      nativeSymbol: typeof item.nativeSymbol === "string" ? item.nativeSymbol : null,
      address,
      status: item.status,
      platform: item.platform,
      networkCode: item.networkCode,
      fees: {
        deployCost: item.deployCost ?? null,
        buyFee: item.buyFee ?? null,
        sellFee: item.sellFee ?? null,
        minTradeFee: item.minTradeFee ?? null,
      },
      thresholds: {
        b0Amount: item.b0Amount ?? null,
        totalBAmount: item.totalBAmount ?? null,
        totalAmount: item.totalAmount ?? null,
        saleRate: item.saleRate ?? null,
        reservedNumber: item.reservedNumber ?? null,
        tradeLevel: Array.isArray(item.tradeLevel) ? item.tradeLevel.map(String) : [],
      },
      source: { kind: "api", url: sourceUrl },
    }];
  }).sort((left, right) => left.symbol.localeCompare(right.symbol));
  const chains = mergeChainRecords(publishedNetworks.map((item) => {
    const code = item.networkCode.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
    const catalogChain = CHAIN_BY_CODE.get(code);
    const explicitChainId = normalizeChainId(item.chainId ?? item.chainID ?? item.networkId);
    const mapped = explicitChainId == null ? null : CHAIN_BY_ID.get(String(explicitChainId));
    const inferredMainnetId = catalogChain
      ? Object.entries(catalogChain.ids).find(([, environment]) => environment === "mainnet")?.[0]
      : null;
    const environmentText = `${item.environment || ""} ${item.networkType || ""} ${item.networkCode}`;
    return {
      name: mapped?.chain?.name || catalogChain?.name || item.networkName || item.networkCode,
      chainId: explicitChainId ?? normalizeChainId(inferredMainnetId),
      environment: mapped?.environment || (CHAIN_TESTNET_SIGNAL.test(environmentText) ? "testnet" : "mainnet"),
      stage: "supported",
      evidence: "published_network_config",
      source: { kind: "api", url: sourceUrl },
    };
  }));
  return {
    ...emptyCapabilities(),
    quoteTokens: quoteConfigs.map((item) => item.symbol),
    quoteConfigs,
    // Quote assets are mode inputs, not platform factories/components. Their
    // addresses stay in quoteConfigs and must never enter contract discovery.
    contracts: [],
    chains,
  };
}

export function extractNpmPackageCapabilities(input, sourceUrl = FOUR_MEME_NPM_URL) {
  let payload;
  try { payload = typeof input === "string" ? JSON.parse(input) : input; }
  catch { throw new Error("Four.meme npm schema: invalid JSON"); }
  requireObject(payload, "Four.meme npm");
  if (payload.name !== "@four-meme/four-meme-ai" || typeof payload.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(payload.version)) {
    throw new Error("Four.meme npm schema: unexpected name or version");
  }
  const repository = typeof payload.repository === "string" ? payload.repository : payload.repository?.url;
  const packageInfo = {
    name: payload.name,
    version: payload.version,
    homepage: typeof payload.homepage === "string" ? payload.homepage : null,
    repository: typeof repository === "string" ? repository.replace(/^git\+/, "").replace(/\.git$/, "") : null,
    source: { kind: "package", url: sourceUrl },
  };
  return { ...emptyCapabilities(), versions: [`v${payload.version}`], packages: [packageInfo] };
}

const extractSitemapBlocks = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))].map((match) => match[1]);
const extractXmlValue = (block, tag) => {
  const value = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1];
  return value ? decodeXml(value.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim()) : null;
};

async function settleBounded(items, concurrency, task) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, Number(concurrency) || 1), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try { results[index] = { status: "fulfilled", value: await task(items[index], index) }; }
      catch (reason) { results[index] = { status: "rejected", reason }; }
    }
  });
  await Promise.all(workers);
  return results;
}

function platformResponseRetryAfterMs(response, currentTimeMs = Date.now()) {
  const value = response?.headers?.get?.("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - currentTimeMs) : null;
}

async function fetchResponse(
  url,
  fetchImpl,
  accept,
  timeoutMs = 20_000,
  deadlineMs = Date.now() + Math.max(1_000, Number(timeoutMs) || 20_000),
  options = {},
) {
  const remainingMs = Math.max(1, deadlineMs - Date.now());
  const headers = {
    accept,
    "accept-language": "en-US,en;q=0.9",
    // Four.Meme intermittently challenges obvious bot user agents even though
    // the same public pages remain available to ordinary browsers.
    "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
  };
  if (options.etag) headers["if-none-match"] = options.etag;
  if (options.lastModified) headers["if-modified-since"] = options.lastModified;
  const response = await fetchImpl(url, {
    headers,
    signal: AbortSignal.timeout(remainingMs),
  });
  if (response?.status === 304 && options.allowNotModified) {
    return {
      text: null,
      notModified: true,
      etag: response.headers?.get?.("etag") || options.etag || null,
      lastModified: response.headers?.get?.("last-modified") || options.lastModified || null,
    };
  }
  if (!response?.ok) {
    const error = new Error(`${response?.url || url} HTTP ${response?.status ?? "unknown"}`);
    error.status = Number.isInteger(response?.status) ? response.status : null;
    error.retryAfterMs = platformResponseRetryAfterMs(response, Number(options.currentTimeMs) || Date.now());
    throw error;
  }
  return {
    text: await response.text(),
    notModified: false,
    etag: response.headers?.get?.("etag") || null,
    lastModified: response.headers?.get?.("last-modified") || null,
  };
}

async function fetchResponseText(url, fetchImpl, accept, timeoutMs = 20_000, deadlineMs = Date.now() + Math.max(1_000, Number(timeoutMs) || 20_000)) {
  return (await fetchResponse(url, fetchImpl, accept, timeoutMs, deadlineMs)).text;
}

const isPlatformTransportFailure = (value) => {
  const status = Number(value?.status ?? value?.lastErrorStatus);
  if ([403, 429].includes(status)) return false;
  return /fetch failed|network|timed?\s*out|timeout|aborted|eaddrnotavail|econn(?:reset|refused|aborted)|socket/i
    .test(String(value?.message || value?.lastError || value || ""));
};

export async function crawlSitemap(
  rootUrl,
  fetchImpl = globalThis.fetch,
  pagePattern = /./,
  initialText,
  timeoutMs = 20_000,
  deadlineMs = Date.now() + Math.max(1_000, Number(timeoutMs) || 20_000),
) {
  const seen = new Set();
  const pages = new Map();
  const failures = [];
  const crawl = async (url, suppliedText, depth, ancestry = []) => {
    const canonical = canonicalUrl(url);
    if (seen.has(canonical)) return;
    if (depth > 5 || seen.size >= 100) throw new Error(`sitemap recursion limit reached at ${canonical}`);
    seen.add(canonical);
    const xml = suppliedText ?? await fetchResponseText(canonical, fetchImpl, "application/xml,text/xml", timeoutMs, deadlineMs);
    if (!/<(?:sitemapindex|urlset)\b/i.test(xml)) throw new Error(`sitemap schema: ${canonical} is not a sitemap`);
    const sitemapBlocks = extractSitemapBlocks(xml, "sitemap");
    if (sitemapBlocks.length) {
      const children = sitemapBlocks.map((block) => extractXmlValue(block, "loc")).filter(Boolean);
      const results = await settleBounded(
        children,
        3,
        (child) => crawl(child, undefined, depth + 1, [...ancestry, canonical]),
      );
      results.forEach((result, index) => {
        if (result.status === "rejected") failures.push({
          url: canonicalUrl(children[index]),
          path: [...ancestry, canonical, canonicalUrl(children[index])],
          error: result.reason?.message || String(result.reason),
        });
      });
      if (children.length && results.every((result) => result.status === "rejected")) {
        throw new Error(`all child sitemaps failed under ${canonical}`);
      }
      return;
    }
    for (const block of extractSitemapBlocks(xml, "url")) {
      const location = extractXmlValue(block, "loc");
      if (!location) continue;
      const pageUrl = canonicalUrl(location);
      if (!pagePattern.test(pageUrl) || /\.(?:md|xml)$/i.test(pageUrl)) continue;
      const lastmod = extractXmlValue(block, "lastmod");
      pages.set(pageUrl, {
        url: pageUrl,
        lastmod: lastmod || null,
        source: { kind: "sitemap", url: rootUrl, sitemap: canonical, path: [...ancestry, canonical] },
      });
    }
  };
  await crawl(rootUrl, initialText, 0);
  const result = [...pages.values()].sort((left, right) => left.url.localeCompare(right.url));
  Object.defineProperty(result, "failures", { value: failures, enumerable: false });
  return result;
}

export const sourceDescriptors = (platform) => {
  const descriptors = [];
  const add = (kind, value, defaults = {}) => {
    const entries = Array.isArray(value) ? value : [];
    for (const entry of entries) {
      const descriptor = typeof entry === "string" ? { url: entry } : entry;
      descriptors.push({ kind, ...defaults, ...descriptor, key: `${kind}:${descriptor.url}` });
    }
  };
  // A Flap Board snapshot is the only structured source for quote assets and
  // VaultFactory categories.  Do not establish a cold-start baseline from the
  // slower documentation sources while the Board schema is unavailable.
  add("market", platform.marketSources, { requiredForBaseline: platform.id === "flap" });
  add("api", platform.apiSources);
  add("package", platform.packageSources);
  add("live", platform.liveSources, { optionalForHealth: platform.id === "fourmeme" });
  // Documentation and sitemap crawls are valuable for new product language,
  // but structured Board/config/package sources are the first-detection lane.
  add("docs", platform.sources, { optionalForHealth: platform.id === "fourmeme" });
  return [...new Map(descriptors.map((descriptor) => [descriptor.key, descriptor])).values()];
};

export function isPlatformStructuredFastSource(platform, descriptor) {
  if (platform?.id === "flap" && descriptor?.kind === "market") {
    const url = canonicalUrl(descriptor.url);
    return url === canonicalUrl(FLAP_BOARD_URL) || url === canonicalUrl(FLAP_MORPH_BOARD_URL);
  }
  return platform?.id === "fourmeme"
    && descriptor?.kind === "api"
    && descriptor?.parser === "fourmeme-config"
    && canonicalUrl(descriptor.url) === canonicalUrl(FOUR_MEME_CONFIG_URL);
}

function isFourMemeOptionalWebSource(platform, descriptor) {
  return platform?.id === "fourmeme"
    && descriptor?.requiredForBaseline !== true
    && descriptor?.optionalForHealth === true
    && ["live", "docs"].includes(descriptor?.kind);
}

function fourMemeOptionalWebCircuitBackoffMs(consecutiveFailures) {
  const index = Math.min(
    FOUR_MEME_OPTIONAL_WEB_CIRCUIT_STEPS_MS.length - 1,
    Math.max(0, Number(consecutiveFailures || 1) - 1),
  );
  return FOUR_MEME_OPTIONAL_WEB_CIRCUIT_STEPS_MS[index];
}

export async function fetchPlatformSource(platform, descriptor, fetchImpl = globalThis.fetch, timeoutMs = 20_000, options = {}) {
  const deadlineMs = Date.now() + Math.max(1_000, Number(timeoutMs) || 20_000);
  const accepts = descriptor.kind === "api" || descriptor.kind === "package"
    ? "application/json"
    : descriptor.kind === "docs"
      ? "text/html,text/markdown,application/xml"
      : "text/html";
  const fetched = await fetchResponse(descriptor.url, fetchImpl, accepts, timeoutMs, deadlineMs, {
    etag: options.etag,
    lastModified: options.lastModified,
    allowNotModified: options.allowNotModified === true,
    currentTimeMs: options.currentTimeMs,
  });
  if (fetched.notModified) {
    if (!options.priorSource?.initialized) {
      const error = new Error(`${descriptor.url} returned HTTP 304 without an initialized baseline`);
      error.code = "not_modified_without_baseline";
      throw error;
    }
    return {
      key: descriptor.key,
      url: descriptor.url,
      kind: descriptor.kind,
      notModified: true,
      etag: fetched.etag,
      lastModified: fetched.lastModified,
    };
  }
  const text = fetched.text;
  let capabilities;
  let contentForFingerprint = normalizeFingerprintContent(text);
  if (descriptor.parser === "fourmeme-config") {
    capabilities = extractFourMemeConfigCapabilities(text, descriptor.url);
    contentForFingerprint = stableStringify(capabilities.quoteConfigs);
  } else if (descriptor.parser === "fourmeme-npm") {
    capabilities = extractNpmPackageCapabilities(text, descriptor.url);
    contentForFingerprint = stableStringify(capabilities.packages);
  } else if (descriptor.kind === "market") {
    capabilities = extractFlapMarketCapabilities(text, descriptor.url, descriptor.chainId);
    if (platform.id === "flap"
      && !(capabilities.flapPools || []).length
      && !(capabilities.modules || []).length
      && descriptor.requiredForBaseline !== false) {
      const error = new Error("Flap Board schema_empty: no structured quote assets or vault categories");
      error.code = "schema_empty";
      throw error;
    }
    // A newly enabled chain can have a valid Flap board route before its first
    // quote asset or VaultFactory exists. The exact chain route/selector is
    // still verified by the configured descriptor; treating that optional
    // board as a healthy empty snapshot keeps it on the fast poll interval so
    // the first real pool is observed immediately. The required BSC board
    // remains fail-closed above.
    if (platform.id === "flap"
      && descriptor.requiredForBaseline === false
      && !(capabilities.flapPools || []).length
      && !(capabilities.modules || []).length) {
      const expectedChain = normalizeChainId(descriptor.chainId);
      const routeVerified = expectedChain === 2818
        && canonicalUrl(descriptor.url) === canonicalUrl(FLAP_MORPH_BOARD_URL)
        && /aria-label=["']Current chain:\s*MORPH["']/i.test(text)
        && /href=["']\/morph\/board["']/i.test(text)
        && /<title>Flap\s+—\s+The Programmable Token Launchpad<\/title>/i.test(text);
      if (!routeVerified) {
        const error = new Error("Flap optional Board schema_empty: route identity could not be verified");
        error.code = "schema_empty";
        throw error;
      }
    }
  } else if (descriptor.kind === "live") {
    capabilities = extractFourMemeLiveCapabilities(text);
  } else if (/<(?:sitemapindex|urlset)\b/i.test(text) || /sitemap\.xml(?:$|\?)/i.test(descriptor.url)) {
    const pageMetadata = await crawlSitemap(descriptor.url, fetchImpl, platform.pagePattern, text, timeoutMs, deadlineMs);
    capabilities = { ...emptyCapabilities(), pages: pageMetadata.map((item) => item.url), pageMetadata };
    contentForFingerprint = stableStringify(pageMetadata);
  } else {
    capabilities = extractPlatformCapabilities(text, platform.pagePattern);
  }
  capabilities = {
    ...capabilities,
    chains: mergeChainRecords((capabilities.chains || []).map((chain) => ({
      ...chain,
      source: chain.source || { kind: descriptor.kind, url: descriptor.url },
    }))),
  };
  if (!["fourmeme-config", "fourmeme-npm"].includes(descriptor.parser) && !/(?:sitemap\.xml(?:$|\?)|<(?:sitemapindex|urlset)\b)/i.test(`${descriptor.url}\n${text}`)) {
    contentForFingerprint = stableStringify(normalizeCapabilities(capabilities));
  }
  return {
    key: descriptor.key,
    url: descriptor.url,
    kind: descriptor.kind,
    chainId: normalizeChainId(descriptor.chainId),
    parser: descriptor.parser || null,
    authoritativeQuotes: Boolean(descriptor.authoritativeQuotes),
    requiredForBaseline: Boolean(descriptor.requiredForBaseline),
    optionalForHealth: Boolean(descriptor.optionalForHealth),
    fingerprint: fingerprint(contentForFingerprint),
    capabilities: normalizeCapabilities(capabilities),
    partialFailures: capabilities.pageMetadata?.failures || [],
    etag: fetched.etag,
    lastModified: fetched.lastModified,
    notModified: false,
  };
}

const aggregateSources = (platform, sources) => {
  const initialized = Object.values(sources || {}).filter((source) => source?.initialized);
  const authoritativeQuoteSources = initialized.filter((source) => source.authoritativeQuotes);
  const quoteSources = authoritativeQuoteSources.length ? authoritativeQuoteSources : initialized;
  const result = emptyCapabilities();
  for (const key of SIMPLE_CAPABILITY_KEYS) {
    const selected = key === "quoteTokens" ? quoteSources : initialized;
    result[key] = uniqueStrings(selected.flatMap((source) => source.capabilities?.[key] || []));
  }
  result.quoteConfigs = uniqueObjects(
    quoteSources.flatMap((source) => source.capabilities?.quoteConfigs || []),
    (item) => `${item.symbol}:${stableStringify(item)}`,
  );
  result.flapPools = uniqueObjects(
    initialized.flatMap((source) => source.capabilities?.flapPools || []).map(normalizeFlapPool),
    flapPoolIdentity,
  );
  result.pageMetadata = uniqueObjects(
    initialized.flatMap((source) => source.capabilities?.pageMetadata || []),
    (item) => `${item.url}:${item.lastmod || ""}:${item.source?.url || ""}`,
  );
  result.packages = uniqueObjects(
    initialized.flatMap((source) => source.capabilities?.packages || []),
    (item) => `${item.name}:${item.version}:${item.source?.url || ""}`,
  );
  result.chains = mergeChainRecords(initialized.flatMap((source) => source.capabilities?.chains || []));
  result.sourceFingerprints = initialized.map((source) => ({
    url: source.url,
    kind: source.kind,
    fingerprint: source.fingerprint,
  })).sort((left, right) => left.url.localeCompare(right.url));
  const sourceProvenance = {};
  for (const key of SIMPLE_CAPABILITY_KEYS) {
    sourceProvenance[key] = {};
    for (const source of initialized) {
      if (key === "quoteTokens" && !quoteSources.includes(source)) continue;
      for (const value of source.capabilities?.[key] || []) {
        sourceProvenance[key][value] ||= [];
        sourceProvenance[key][value].push(source.url);
      }
    }
    for (const value of Object.keys(sourceProvenance[key])) sourceProvenance[key][value] = uniqueStrings(sourceProvenance[key][value]);
  }
  result.sourceProvenance = sourceProvenance;
  return result;
};

const byIdentity = (items, identity) => new Map((items || []).map((item) => [identity(item), item]));

export function diffCapabilities(previousInput, currentInput) {
  const previous = normalizeCapabilities(previousInput);
  const current = normalizeCapabilities(currentInput);
  const added = (key) => current[key].filter((value) => !previous[key].includes(value));
  const removed = (key) => previous[key].filter((value) => !current[key].includes(value));
  const previousQuotes = byIdentity(previous.quoteConfigs, (item) => item.symbol);
  const currentQuotes = byIdentity(current.quoteConfigs, (item) => item.symbol);
  const previousFlapPools = byIdentity(previous.flapPools, flapPoolIdentity);
  const currentFlapPools = byIdentity(current.flapPools, flapPoolIdentity);
  const previousPages = byIdentity(previous.pageMetadata, (item) => item.url);
  const currentPages = byIdentity(current.pageMetadata, (item) => item.url);
  const previousPackages = byIdentity(previous.packages, (item) => item.name);
  const currentPackages = byIdentity(current.packages, (item) => item.name);
  const previousChains = byIdentity(previous.chains, chainNetworkIdentity);
  const currentChains = byIdentity(current.chains, chainNetworkIdentity);
  const previousSources = byIdentity(previous.sourceFingerprints, (item) => item.url);
  const currentSources = byIdentity(current.sourceFingerprints, (item) => item.url);
  const changedSources = [...currentSources].filter(([url, item]) => previousSources.has(url) && previousSources.get(url).fingerprint !== item.fingerprint).map(([url]) => url).sort();
  const updatedPages = [...currentPages].filter(([url, item]) => previousPages.has(url) && stableStringify(previousPages.get(url)) !== stableStringify(item)).map(([url]) => url).sort();
  const quoteConfigChanges = [...currentQuotes]
    .filter(([symbol, item]) => previousQuotes.has(symbol) && stableStringify(previousQuotes.get(symbol)) !== stableStringify(item))
    .map(([symbol, after]) => ({ symbol, before: previousQuotes.get(symbol), after }));
  const flapPoolChanges = [...currentFlapPools]
    .filter(([identity, item]) => previousFlapPools.has(identity)
      && stableStringify(previousFlapPools.get(identity)) !== stableStringify(item))
    .map(([identity, after]) => ({ identity, before: previousFlapPools.get(identity), after }));
  const packageVersionChanges = [...currentPackages]
    .filter(([name, item]) => previousPackages.has(name) && stableStringify(previousPackages.get(name)) !== stableStringify(item))
    .map(([name, after]) => ({
      name,
      fromVersion: previousPackages.get(name)?.version || null,
      toVersion: after?.version || null,
      before: previousPackages.get(name),
      after,
    }));
  const chainStageChanges = [...currentChains]
    .filter(([identity, item]) => previousChains.has(identity) && previousChains.get(identity).stage !== item.stage)
    .map(([identity, after]) => {
      const before = previousChains.get(identity);
      return {
        name: after.name,
        chainId: after.chainId,
        environment: after.environment,
        fromStage: before.stage,
        toStage: after.stage,
        direction: (CHAIN_STAGE_RANK[after.stage] || 0) > (CHAIN_STAGE_RANK[before.stage] || 0) ? "upgrade" : "downgrade",
        before,
        after,
      };
    });
  // Keep the established updated* fields for downstream compatibility while
  // also retaining the previous value needed to explain the exact change.
  const updatedQuoteConfigs = quoteConfigChanges.map(({ after }) => after);
  const updatedPackages = packageVersionChanges.map(({ after }) => after);
  return {
    newQuoteTokens: added("quoteTokens"),
    removedQuoteTokens: removed("quoteTokens"),
    newQuoteConfigs: [...currentQuotes].filter(([symbol]) => !previousQuotes.has(symbol)).map(([, item]) => item),
    removedQuoteConfigs: [...previousQuotes].filter(([symbol]) => !currentQuotes.has(symbol)).map(([, item]) => item),
    updatedQuoteConfigs,
    quoteConfigChanges,
    newFlapPools: [...currentFlapPools].filter(([identity]) => !previousFlapPools.has(identity)).map(([, item]) => item),
    removedFlapPools: [...previousFlapPools].filter(([identity]) => !currentFlapPools.has(identity)).map(([, item]) => item),
    updatedFlapPools: flapPoolChanges.map(({ after }) => after),
    flapPoolChanges,
    newContracts: added("contracts"),
    removedContracts: removed("contracts"),
    newVersions: added("versions"),
    removedVersions: removed("versions"),
    newModules: added("modules"),
    removedModules: removed("modules"),
    newChains: [...currentChains].filter(([identity]) => !previousChains.has(identity)).map(([, item]) => item),
    removedChains: [...previousChains].filter(([identity]) => !currentChains.has(identity)).map(([, item]) => item),
    chainStageChanges,
    newPages: uniqueStrings([...added("pages"), ...updatedPages]),
    removedPages: removed("pages"),
    updatedPages,
    newAnnouncements: added("announcements"),
    removedAnnouncements: removed("announcements"),
    newCampaigns: added("campaigns"),
    removedCampaigns: removed("campaigns"),
    newPackages: [...currentPackages].filter(([name]) => !previousPackages.has(name)).map(([, item]) => item),
    removedPackages: [...previousPackages].filter(([name]) => !currentPackages.has(name)).map(([, item]) => item),
    updatedPackages,
    packageVersionChanges,
    changedSources,
    newContentFingerprints: changedSources.map((url) => `${url}#${currentSources.get(url).fingerprint}`),
  };
}

const emptyChanges = () => diffCapabilities(emptyCapabilities(), emptyCapabilities());
const NON_SEMANTIC_CHANGE_KEYS = new Set(["removedChains", "changedSources", "newContentFingerprints"]);
const meaningful = (changes) => Object.entries(changes)
  .some(([key, items]) => !NON_SEMANTIC_CHANGE_KEYS.has(key) && Array.isArray(items) && items.length > 0);

const isNovelChainCapability = (candidate, observed) => {
  if (observed.some((item) => chainIdentity(item) === chainIdentity(candidate))) return false;
  const related = observed.filter((item) => item.name.toLowerCase() === candidate.name.toLowerCase()
    && item.environment === candidate.environment
    && (candidate.chainId == null || item.chainId == null || String(item.chainId) === String(candidate.chainId)));
  if (!related.length) return true;
  const candidateRank = CHAIN_STAGE_RANK[candidate.stage] || 0;
  // Losing a chainId or falling back from deployed -> supported/configured is
  // a documentation downgrade, not a new platform capability.
  return !related.some((item) => (candidate.chainId == null && item.chainId != null)
    || (String(item.chainId ?? "") === String(candidate.chainId ?? "") && (CHAIN_STAGE_RANK[item.stage] || 0) >= candidateRank));
};

const finalizeChainChanges = (previousEntry, current, changes) => {
  const previousCapabilities = previousEntry?.capabilities || {};
  const chainSchemaInitialized = Object.hasOwn(previousCapabilities, "chains");
  const observedChains = mergeChainRecords(previousEntry?.observedChains || previousCapabilities.chains || []);
  const filtered = { ...changes };
  filtered.newChains = chainSchemaInitialized
    ? (changes.newChains || []).filter((item) => isNovelChainCapability(item, observedChains))
    : [];
  filtered.chainStageChanges = chainSchemaInitialized
    ? (changes.chainStageChanges || []).filter(({ after }) => {
      const observed = observedChains.find((item) => chainNetworkIdentity(item) === chainNetworkIdentity(after));
      return observed && (CHAIN_STAGE_RANK[after.stage] || 0) > (CHAIN_STAGE_RANK[observed.stage] || 0);
    })
    : [];
  if (!chainSchemaInitialized) filtered.removedChains = [];

  const hasOtherSemanticChange = Object.entries(filtered).some(([key, items]) => ![
    "newChains",
    "chainStageChanges",
    "removedChains",
    "changedSources",
    "newContentFingerprints",
  ].includes(key) && Array.isArray(items) && items.length > 0);
  if (!filtered.newChains.length && !filtered.chainStageChanges.length && !hasOtherSemanticChange) {
    // Parser rollout, chain removal, reordering and an already-seen re-add can
    // change a source fingerprint; none of those should emit an alert.
    filtered.changedSources = [];
    filtered.newContentFingerprints = [];
  }
  return {
    changes: filtered,
    observedChains: mergeChainRecords([...observedChains, ...(current.chains || [])]),
  };
};

const capabilityChangeKeys = {
  quoteTokens: { added: "newQuoteTokens", removed: "removedQuoteTokens" },
  contracts: { added: "newContracts", removed: "removedContracts" },
  versions: { added: "newVersions", removed: "removedVersions" },
  modules: { added: "newModules", removed: "removedModules" },
  pages: { added: "newPages", removed: "removedPages" },
  announcements: { added: "newAnnouncements", removed: "removedAnnouncements" },
  campaigns: { added: "newCampaigns", removed: "removedCampaigns" },
};

const backedOnlyBy = (capabilities, capability, value, ignoredSources) => {
  const sources = capabilities?.sourceProvenance?.[capability]?.[value] || [];
  return sources.length > 0 && sources.every((url) => ignoredSources.has(url));
};

const cloneSourceProvenance = (capabilities) => Object.fromEntries(SIMPLE_CAPABILITY_KEYS.map((capability) => [
  capability,
  Object.fromEntries(Object.entries(capabilities?.sourceProvenance?.[capability] || {}).map(([value, urls]) => [value, [...urls]])),
]));

const sourceFingerprintUrl = (value) => {
  const separator = value.indexOf("#");
  return separator === -1 ? value : value.slice(0, separator);
};

const marketCapabilityRetiredByMigration = (platform, capability, marketUrls) => {
  const retiredSources = new Set((platform.schemaMigration?.removed?.[capability] || []).map(canonicalUrl));
  return marketUrls.size > 0 && [...marketUrls].every((url) => retiredSources.has(url));
};

const stabilizeFlapPoolCandidates = ({
  platform,
  previousEntry,
  current,
  freshMarketSources,
  hasFreshMarketObservation,
  observedAt,
}) => {
  const previousCapabilities = previousEntry?.capabilities || {};
  const scopeLegacyBsc = Number(platform?.capabilitySchemaVersion || 1) >= 4;
  const normalizeStatePool = (pool) => scopeLegacyBscBoardFlapPool(pool, scopeLegacyBsc);
  const schemaInitialized = Object.hasOwn(previousCapabilities, "flapPools");
  const schemaMigrationBaseline = Boolean(previousEntry)
    && Number(previousEntry.capabilitySchemaVersion || 1) < Number(platform?.capabilitySchemaVersion || 1);
  const previouslyInitializedMarketUrls = new Set(Object.values(previousEntry?.sources || {})
    .filter((source) => source?.kind === "market" && source.initialized)
    .map((source) => canonicalUrl(source.url)));
  const previousItems = byIdentity((previousCapabilities.flapPools || []).map(normalizeStatePool).filter(Boolean), flapPoolIdentity);
  const currentItems = byIdentity((current.flapPools || []).map(normalizeStatePool).filter(Boolean), flapPoolIdentity);
  const freshItems = byIdentity(
    freshMarketSources.flatMap((source) => source.capabilities?.flapPools || []).map(normalizeStatePool).filter(Boolean),
    flapPoolIdentity,
  );
  const previousRecords = {};
  for (const [identity, record] of Object.entries(previousEntry?.boardCandidateState?.flapPools || {})) {
    const scopedIdentity = scopeLegacyBsc && /^(?:quote|vault):/.test(identity)
      ? `chain-56:${identity}`
      : identity;
    previousRecords[scopedIdentity] = mergeFlapPoolCandidateRecords(previousRecords[scopedIdentity], record);
  }
  for (const [identity, item] of previousItems) {
    if (previousRecords[identity]?.confirmed) {
      previousRecords[identity].confirmedFingerprint = flapPoolObservationFingerprint(item);
    }
  }
  const accepted = new Map();
  const records = {};
  const identities = new Set([...previousItems.keys(), ...currentItems.keys(), ...freshItems.keys(), ...Object.keys(previousRecords)]);

  const confirm = (identity, item, prior = {}, observations = FLAP_BOARD_STABLE_OBSERVATIONS) => {
    const normalized = normalizeFlapPool(item);
    if (!normalized) return;
    accepted.set(identity, normalized);
    records[identity] = {
      observations: Math.max(FLAP_BOARD_STABLE_OBSERVATIONS, Number(observations) || 0),
      confirmed: true,
      confirmedFingerprint: flapPoolObservationFingerprint(normalized),
      firstObservedAt: prior.firstObservedAt || observedAt,
      lastObservedAt: observedAt,
    };
  };

  for (const identity of identities) {
    const previousItem = previousItems.get(identity);
    const currentItem = currentItems.get(identity);
    const freshItem = freshItems.get(identity);
    const prior = previousRecords[identity];

    // Cold start and the v2 -> v3 rollout establish a quiet baseline. This is
    // deliberately separate from normal discovery so historical board items
    // never activate the first-token callback during parser deployment.
    const firstObservationFromNewBoard = freshItem
      && !previouslyInitializedMarketUrls.has(canonicalUrl(freshItem.sourceUrl));
    if ((!previousEntry || !schemaInitialized || schemaMigrationBaseline || firstObservationFromNewBoard)
      && (currentItem || freshItem)) {
      confirm(identity, currentItem || freshItem, prior, FLAP_BOARD_STABLE_OBSERVATIONS);
      continue;
    }

    if (prior?.confirmed || previousItem) {
      const durableItem = previousItem || currentItem;
      const confirmedFingerprint = prior?.confirmedFingerprint
        || (durableItem ? flapPoolObservationFingerprint(durableItem) : null);
      if (!freshItem) {
        if (durableItem) accepted.set(identity, normalizeFlapPool(durableItem));
        if (prior) records[identity] = prior;
        else if (durableItem) confirm(identity, durableItem, prior, FLAP_BOARD_STABLE_OBSERVATIONS);
        continue;
      }

      const freshFingerprint = flapPoolObservationFingerprint(freshItem);
      if (freshFingerprint === confirmedFingerprint) {
        confirm(identity, freshItem, prior, prior?.observations || FLAP_BOARD_STABLE_OBSERVATIONS);
        continue;
      }

      const samePendingObservation = prior?.pendingFingerprint === freshFingerprint;
      const observations = samePendingObservation ? Number(prior.pendingObservations || 0) + 1 : 1;
      if (observations >= FLAP_BOARD_STABLE_OBSERVATIONS) {
        // A confirmed identity can later change its structured configuration
        // (for example a VaultFactory switching quote assets).  The activation
        // window must start at the first observation of that new fingerprint,
        // not at the original pool's historical discovery time.
        confirm(identity, freshItem, {
          ...prior,
          firstObservedAt: prior?.pendingFirstObservedAt || observedAt,
        }, observations);
      } else {
        if (durableItem) accepted.set(identity, normalizeFlapPool(durableItem));
        records[identity] = {
          ...(prior || {}),
          observations: Math.max(FLAP_BOARD_STABLE_OBSERVATIONS, Number(prior?.observations) || 0),
          confirmed: true,
          confirmedFingerprint,
          firstObservedAt: prior?.firstObservedAt || previousEntry?.checkedAt || observedAt,
          pendingFingerprint: freshFingerprint,
          pendingObservations: observations,
          pendingFirstObservedAt: samePendingObservation ? prior.pendingFirstObservedAt : observedAt,
          lastObservedAt: observedAt,
        };
      }
      continue;
    }

    if (freshItem) {
      const observationFingerprint = flapPoolObservationFingerprint(freshItem);
      const sameObservation = prior?.observationFingerprint === observationFingerprint;
      const observations = sameObservation ? Number(prior.observations || 0) + 1 : 1;
      const candidate = {
        observations,
        confirmed: observations >= FLAP_BOARD_STABLE_OBSERVATIONS,
        observationFingerprint,
        firstObservedAt: sameObservation ? prior.firstObservedAt : observedAt,
        lastObservedAt: observedAt,
      };
      if (candidate.confirmed) confirm(identity, freshItem, candidate, observations);
      else records[identity] = candidate;
      continue;
    }

    // A board transport failure is not a negative observation. A successful
    // page where the candidate vanished is pagination churn and resets only an
    // unconfirmed streak; confirmed values were handled above and are durable.
    if (!hasFreshMarketObservation && prior) records[identity] = prior;
  }

  return {
    flapPools: uniqueObjects([...accepted.values()], flapPoolIdentity),
    records,
  };
};

function stabilizeFlapBoardCandidates(platform, previousEntry, current, nextSources, successfulKeys, observedAt) {
  if (platform.id !== "flap" || !(platform.marketSources || []).length) {
    return { capabilities: current, boardCandidateState: previousEntry?.boardCandidateState };
  }

  const marketUrls = new Set((platform.marketSources || []).map((entry) => canonicalUrl(typeof entry === "string" ? entry : entry.url)));
  const successful = new Set(successfulKeys);
  const freshMarketSources = Object.values(nextSources).filter((source) => source?.kind === "market" && successful.has(source.key));
  const hasFreshMarketObservation = freshMarketSources.length > 0;
  const previousCapabilities = previousEntry?.capabilities;
  const previousCandidateState = previousEntry?.boardCandidateState || {};
  const boardCandidateState = {};
  const stabilized = {
    ...current,
    sourceProvenance: cloneSourceProvenance(current),
  };

  for (const capability of SIMPLE_CAPABILITY_KEYS) {
    // A parser migration may explicitly declare an old board-derived field as
    // noise (Flap quote-token icons are one example). Do not turn such legacy
    // values into permanently confirmed board candidates.
    if (marketCapabilityRetiredByMigration(platform, capability, marketUrls)) continue;
    const previousValues = new Set(previousCapabilities?.[capability] || []);
    const currentValues = new Set(current[capability] || []);
    const freshMarketValues = new Set(freshMarketSources.flatMap((source) => source.capabilities?.[capability] || []));
    const records = { ...(previousCandidateState[capability] || {}) };

    // Existing board-only values predate this stability state. Treating the
    // durable capability snapshot as confirmed prevents a deployment upgrade
    // from turning an old category into a fresh alert or removal loop.
    for (const value of previousValues) {
      if (!records[value] && backedOnlyBy(previousCapabilities, capability, value, marketUrls)) {
        records[value] = {
          consecutiveObservations: FLAP_BOARD_STABLE_OBSERVATIONS,
          confirmed: true,
          firstObservedAt: previousEntry?.checkedAt || observedAt,
          lastObservedAt: previousEntry?.checkedAt || observedAt,
        };
      }
    }

    const values = new Set([...currentValues, ...Object.keys(records)]);
    const accepted = new Set();
    const nextRecords = {};
    for (const value of values) {
      const provenance = current.sourceProvenance?.[capability]?.[value] || [];
      const hasOfficialEvidence = provenance.some((url) => !marketUrls.has(canonicalUrl(url)));
      const boardOnlyNow = provenance.length > 0 && provenance.every((url) => marketUrls.has(canonicalUrl(url)));
      const prior = records[value];

      if (hasOfficialEvidence) {
        accepted.add(value);
        if (prior?.confirmed) nextRecords[value] = prior;
        continue;
      }

      if (prior?.confirmed) {
        accepted.add(value);
        nextRecords[value] = {
          ...prior,
          ...(freshMarketValues.has(value) ? { lastObservedAt: observedAt } : {}),
        };
        continue;
      }

      // The first baseline is intentionally quiet. Its board values are
      // considered established so later viewport churn cannot re-add them.
      if (!previousEntry && boardOnlyNow) {
        accepted.add(value);
        nextRecords[value] = {
          consecutiveObservations: FLAP_BOARD_STABLE_OBSERVATIONS,
          confirmed: true,
          firstObservedAt: observedAt,
          lastObservedAt: observedAt,
        };
        continue;
      }

      // A value already committed to the durable capability snapshot is not a
      // new board candidate. This also covers a formerly documented value that
      // remains visible on the board after its docs source changes.
      if (previousValues.has(value) && boardOnlyNow) {
        accepted.add(value);
        nextRecords[value] = {
          consecutiveObservations: FLAP_BOARD_STABLE_OBSERVATIONS,
          confirmed: true,
          firstObservedAt: previousEntry?.checkedAt || observedAt,
          lastObservedAt: freshMarketValues.has(value) ? observedAt : previousEntry?.checkedAt || observedAt,
        };
        continue;
      }

      if (freshMarketValues.has(value)) {
        const consecutiveObservations = Number(prior?.consecutiveObservations || 0) + 1;
        const confirmed = consecutiveObservations >= FLAP_BOARD_STABLE_OBSERVATIONS;
        nextRecords[value] = {
          consecutiveObservations,
          confirmed,
          firstObservedAt: prior?.firstObservedAt || observedAt,
          lastObservedAt: observedAt,
        };
        if (confirmed) accepted.add(value);
        continue;
      }

      // A failed board request is not a negative observation. Preserve a
      // pending streak, but do not advance it from cached source contents.
      if (!hasFreshMarketObservation && prior) nextRecords[value] = prior;
    }

    stabilized[capability] = uniqueStrings([...accepted]);
    stabilized.sourceProvenance[capability] = Object.fromEntries([...accepted].map((value) => {
      const currentSources = current.sourceProvenance?.[capability]?.[value];
      const previousSources = previousCapabilities?.sourceProvenance?.[capability]?.[value];
      return [value, uniqueStrings(currentSources?.length ? currentSources : previousSources?.length ? previousSources : [...marketUrls])];
    }));
    if (Object.keys(nextRecords).length) boardCandidateState[capability] = nextRecords;
  }

  const poolCandidates = stabilizeFlapPoolCandidates({
    platform,
    previousEntry,
    current,
    freshMarketSources,
    hasFreshMarketObservation,
    observedAt,
  });
  stabilized.flapPools = poolCandidates.flapPools;
  if (Object.keys(poolCandidates.records).length) boardCandidateState.flapPools = poolCandidates.records;

  return { capabilities: stabilized, boardCandidateState };
}

function suppressFlapBoardChurn(platform, previous, changes) {
  if (platform.id !== "flap" || !(platform.marketSources || []).length) return changes;
  const marketUrls = new Set((platform.marketSources || []).map((entry) => canonicalUrl(typeof entry === "string" ? entry : entry.url)));
  const filtered = { ...changes };
  for (const [capability, keys] of Object.entries(capabilityChangeKeys)) {
    if (marketCapabilityRetiredByMigration(platform, capability, marketUrls)) continue;
    if (!Array.isArray(filtered[keys.removed])) continue;
    filtered[keys.removed] = filtered[keys.removed].filter((value) => !backedOnlyBy(previous, capability, value, marketUrls));
  }
  filtered.changedSources = (filtered.changedSources || []).filter((url) => !marketUrls.has(canonicalUrl(url)));
  filtered.newContentFingerprints = (filtered.newContentFingerprints || []).filter((value) => !marketUrls.has(canonicalUrl(sourceFingerprintUrl(value))));
  return filtered;
}

const finalizeFlapPoolChanges = (platform, previousEntry, current, changes) => {
  if (platform.id !== "flap") return changes;
  const filtered = { ...changes };
  const previousLegacyBscIdentities = new Set((previousEntry?.capabilities?.flapPools || [])
    .map(normalizeFlapPool)
    .filter((pool) => pool && isLegacyBscBoardFlapPool(pool))
    .map(flapPoolIdentityWithoutChain));
  const scopedBscIdentities = new Set((current.flapPools || [])
    .filter((pool) => pool?.chainId === 56)
    .map(flapPoolIdentityWithoutChain));
  filtered.newFlapPools = (filtered.newFlapPools || []).filter((pool) => !(
    pool?.chainId === 56
    && previousLegacyBscIdentities.has(flapPoolIdentityWithoutChain(pool))
  ));
  filtered.removedFlapPools = (filtered.removedFlapPools || []).filter((pool) => !(
    isLegacyBscBoardFlapPool(pool)
    && scopedBscIdentities.has(flapPoolIdentityWithoutChain(pool))
  ));
  if (!Object.hasOwn(previousEntry?.capabilities || {}, "flapPools")) {
    // The first v3 observation seeds existing live pools into state. Only pools
    // that appear after this migration baseline are eligible for activation.
    filtered.newFlapPools = [];
    filtered.removedFlapPools = [];
    filtered.updatedFlapPools = [];
    filtered.flapPoolChanges = [];
  }
  return filtered;
};

const flapPoolNeedsQuoteMetadata = (pool) => pool?.kind === "quote_asset"
  && (!normalizedFlapMetadataText(pool.quoteName) || !normalizedFlapMetadataText(pool.quoteSymbol, 24));

const flapPoolHasCompleteQuoteMetadata = (pool) => pool?.kind === "quote_asset"
  && !flapPoolNeedsQuoteMetadata(pool);

const isBscFlapBoardQuoteNotificationPool = (pool) => pool?.kind === "quote_asset"
  && (pool.chainId == null || Number(pool.chainId) === 56)
  && canonicalUrl(pool.sourceUrl || FLAP_BOARD_URL) === canonicalUrl(FLAP_BOARD_URL);

const normalizedFlapQuoteMetadataPending = (value, identity) => {
  const scopedIdentity = String(identity || "").match(/^chain-(\d+):quote:(0x[a-f0-9]{40})$/);
  const legacyIdentity = String(identity || "").match(/^quote:(0x[a-f0-9]{40})$/);
  const quoteAddress = normalizeFlapAddress(value?.quoteAddress);
  const chainId = normalizeChainId(value?.chainId);
  const sourceUrl = canonicalUrl(value?.sourceUrl || FLAP_BOARD_URL);
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.version !== FLAP_QUOTE_METADATA_NOTIFICATION_VERSION
    || value.status !== "pending_metadata"
    || value.identity !== identity
    || (!scopedIdentity && !legacyIdentity)
    || !quoteAddress
    || quoteAddress !== (scopedIdentity?.[2] || legacyIdentity?.[1])
    || chainId !== 56
    || sourceUrl !== canonicalUrl(FLAP_BOARD_URL)
    || !Number.isFinite(Date.parse(value.firstObservedAt || ""))) return null;
  if ((scopedIdentity && Number(scopedIdentity[1]) !== chainId)
    || (legacyIdentity && chainId !== 56)) return null;
  return {
    version: FLAP_QUOTE_METADATA_NOTIFICATION_VERSION,
    status: "pending_metadata",
    identity,
    quoteAddress,
    chainId,
    sourceUrl,
    firstObservedAt: new Date(Date.parse(value.firstObservedAt)).toISOString(),
    stage: "observed",
  };
};

const normalizedFlapQuoteMetadataPendingMap = (value) => Object.fromEntries(
  Object.entries(value || {}).map(([identity, record]) => [
    identity,
    normalizedFlapQuoteMetadataPending(record, identity),
  ]).filter(([, record]) => record),
);

const flapQuoteMetadataRetryDelayMs = (attempts) => attempts <= 1
  ? 0
  : Math.min(FLAP_QUOTE_METADATA_RETRY_MAX_MS, FLAP_QUOTE_METADATA_RETRY_BASE_MS * (2 ** Math.min(10, attempts - 2)));

async function enrichNewFlapQuoteAssets(platform, previousEntry, current, boardCandidateState, dependencies, logger, observedAt) {
  const nextBoardCandidateState = { ...(boardCandidateState || {}) };
  if (platform.id !== "flap" || !Array.isArray(current.flapPools) || !current.flapPools.length) {
    return { capabilities: current, boardCandidateState: nextBoardCandidateState };
  }
  const previousPools = (previousEntry?.capabilities?.flapPools || [])
    .map(normalizeFlapPool)
    .filter(Boolean);
  const previousByIdentity = byIdentity(previousPools, flapPoolIdentity);
  const baseCurrent = {
    ...current,
    // RPC metadata is durable evidence. A later board snapshot may expose only
    // the address; preserve the resolved name/classification instead of
    // oscillating the capability record on every poll.
    flapPools: current.flapPools.map((pool) => {
      const normalized = normalizeFlapPool(pool);
      const previous = normalized ? previousByIdentity.get(flapPoolIdentity(normalized)) : null;
      return normalizeFlapPool({
        ...normalized,
        quoteName: normalized?.quoteName || previous?.quoteName,
        quoteSymbol: normalized?.quoteSymbol || previous?.quoteSymbol,
        quoteClassification: normalized?.quoteClassification || previous?.quoteClassification,
        quoteTags: uniqueStrings([...(normalized?.quoteTags || []), ...(previous?.quoteTags || [])]),
      });
    }).filter(Boolean),
  };
  // Cold start remains a quiet baseline. Once that baseline is durable, every
  // confirmed address with incomplete metadata is retryable so a transient RPC
  // outage cannot permanently freeze a raw address into state.
  if (!previousEntry?.capabilities || !Object.hasOwn(previousEntry.capabilities, "flapPools")) {
    return { capabilities: baseCurrent, boardCandidateState: nextBoardCandidateState };
  }
  const retryState = { ...(previousEntry?.boardCandidateState?.flapQuoteMetadataRetries || {}) };
  const notificationPending = normalizedFlapQuoteMetadataPendingMap(
    previousEntry?.boardCandidateState?.flapQuoteMetadataNotificationPending,
  );
  const confirmedQuotes = baseCurrent.flapPools
    .map(normalizeFlapPool)
    .filter((pool) => pool?.kind === "quote_asset" && pool.quoteAddress)
    .filter((pool) => nextBoardCandidateState.flapPools?.[flapPoolIdentity(pool)]?.confirmed === true);
  const confirmedMissing = confirmedQuotes.filter(flapPoolNeedsQuoteMetadata);
  const confirmedMissingIdentities = new Set(confirmedMissing.map(flapPoolIdentity));
  for (const identity of Object.keys(retryState)) {
    if (!confirmedMissingIdentities.has(identity)) delete retryState[identity];
  }
  const previousLegacyBscIdentities = new Set(previousPools
    .filter((pool) => pool.chainId == null)
    .map(flapPoolIdentityWithoutChain));
  for (const pool of confirmedQuotes.filter(isBscFlapBoardQuoteNotificationPool)) {
    const identity = flapPoolIdentity(pool);
    const legacyBscEquivalent = pool.chainId === 56
      && previousLegacyBscIdentities.has(flapPoolIdentityWithoutChain(pool));
    if (notificationPending[identity] || previousByIdentity.has(identity) || legacyBscEquivalent) continue;
    const candidate = nextBoardCandidateState.flapPools?.[identity] || {};
    const firstObservedMs = Date.parse(candidate.firstObservedAt || "");
    notificationPending[identity] = {
      version: FLAP_QUOTE_METADATA_NOTIFICATION_VERSION,
      status: "pending_metadata",
      identity,
      quoteAddress: pool.quoteAddress,
      chainId: pool.chainId == null ? 56 : pool.chainId,
      sourceUrl: pool.sourceUrl || FLAP_BOARD_URL,
      firstObservedAt: Number.isFinite(firstObservedMs)
        ? new Date(firstObservedMs).toISOString()
        : new Date(Date.parse(observedAt)).toISOString(),
      stage: "observed",
    };
  }
  if (Object.keys(notificationPending).length) {
    nextBoardCandidateState.flapQuoteMetadataNotificationPending = notificationPending;
  } else {
    delete nextBoardCandidateState.flapQuoteMetadataNotificationPending;
  }
  if (!confirmedMissing.length || typeof dependencies.resolveFlapQuoteAssetMetadata !== "function") {
    if (Object.keys(retryState).length) nextBoardCandidateState.flapQuoteMetadataRetries = retryState;
    else delete nextBoardCandidateState.flapQuoteMetadataRetries;
    return { capabilities: baseCurrent, boardCandidateState: nextBoardCandidateState };
  }

  const observedMs = Date.parse(observedAt || "");
  const currentTimeMs = Number.isFinite(observedMs) ? observedMs : Date.now();
  const retryDueAt = (pool) => {
    const nextAttemptMs = Date.parse(retryState[flapPoolIdentity(pool)]?.nextAttemptAt || "");
    return Number.isFinite(nextAttemptMs) ? nextAttemptMs : 0;
  };
  const requests = [...new Map(confirmedMissing.map((pool) => [flapPoolIdentity(pool), pool])).values()]
    .filter((pool) => retryDueAt(pool) <= currentTimeMs)
    .sort((left, right) => retryDueAt(left) - retryDueAt(right)
      || flapPoolIdentity(left).localeCompare(flapPoolIdentity(right)))
    .slice(0, FLAP_QUOTE_METADATA_MAX_PER_CHECK);
  const results = await settleBounded(requests, 2, async (pool) => ({
    identity: flapPoolIdentity(pool),
    address: pool.quoteAddress,
    metadata: await dependencies.resolveFlapQuoteAssetMetadata({
      address: pool.quoteAddress,
      chainId: pool.chainId == null ? 56 : pool.chainId,
      sourceUrl: pool.sourceUrl,
    }),
  }));
  const metadataByIdentity = new Map();
  const recordFailure = (pool, error) => {
    const identity = flapPoolIdentity(pool);
    const attempts = Number(retryState[identity]?.attempts || 0) + 1;
    const delayMs = flapQuoteMetadataRetryDelayMs(attempts);
    retryState[identity] = {
      attempts,
      lastAttemptAt: new Date(currentTimeMs).toISOString(),
      nextAttemptAt: new Date(currentTimeMs + delayMs).toISOString(),
      errorCode: String(error?.code || "FLAP_QUOTE_METADATA_UNAVAILABLE"),
      lastError: flapMetadataErrorText(error),
    };
    logger?.error?.(`[platform-capability] flap quote metadata ${identity}: ${flapMetadataErrorText(error)}`);
  };
  results.forEach((result, index) => {
    const pool = requests[index];
    if (result.status === "fulfilled" && result.value?.metadata) {
      metadataByIdentity.set(flapPoolIdentity(pool), result.value.metadata);
      return;
    }
    const error = result.status === "rejected"
      ? result.reason
      : Object.assign(new Error("quote metadata resolver returned no metadata"), { code: "FLAP_QUOTE_METADATA_EMPTY" });
    recordFailure(pool, error);
  });

  const enrichedPools = baseCurrent.flapPools.map((pool) => {
      const normalized = normalizeFlapPool(pool);
      const identity = normalized ? flapPoolIdentity(normalized) : null;
      const metadata = identity ? metadataByIdentity.get(identity) : null;
      if (!metadata) return normalized;
      const enriched = normalizeFlapPool({
        ...normalized,
        quoteName: normalized.quoteName || metadata.name || metadata.quoteName,
        quoteSymbol: normalized.quoteSymbol || metadata.symbol || metadata.quoteSymbol,
        quoteClassification: normalized.quoteClassification
          || metadata.classification || metadata.assetClass || metadata.type || metadata.quoteClassification,
        quoteTags: uniqueStrings([...(normalized.quoteTags || []), ...(metadata.tags || metadata.quoteTags || [])]),
      });
      if (flapPoolNeedsQuoteMetadata(enriched)) {
        recordFailure(normalized, Object.assign(new Error("quote metadata remained incomplete after enrichment"), {
          code: "FLAP_QUOTE_METADATA_INCOMPLETE",
        }));
      } else {
        delete retryState[identity];
      }
      return enriched;
    }).filter(Boolean);
  if (Object.keys(retryState).length) nextBoardCandidateState.flapQuoteMetadataRetries = retryState;
  else delete nextBoardCandidateState.flapQuoteMetadataRetries;
  return {
    capabilities: { ...baseCurrent, flapPools: enrichedPools },
    boardCandidateState: nextBoardCandidateState,
  };
}

const flapQuoteMetadataOnlyChange = (change) => {
  const before = normalizeFlapPool(change?.before);
  const after = normalizeFlapPool(change?.after);
  if (!before || !after
    || before.kind !== "quote_asset"
    || after.kind !== "quote_asset"
    || flapPoolIdentity(before) !== flapPoolIdentity(after)) return false;
  const withoutMetadata = (pool) => ({
    identity: pool.identity,
    kind: pool.kind,
    category: pool.category,
    vaultFactory: pool.vaultFactory,
    quoteAddress: pool.quoteAddress,
    sourceUrl: pool.sourceUrl,
    chainId: pool.chainId ?? null,
  });
  return stableStringify(withoutMetadata(before)) === stableStringify(withoutMetadata(after));
};

function finalizeFlapQuoteMetadataNotifications(platform, current, boardCandidateState, changes) {
  if (platform.id !== "flap") {
    return { changes, pendingNotifications: [] };
  }
  const pending = normalizedFlapQuoteMetadataPendingMap(
    boardCandidateState?.flapQuoteMetadataNotificationPending,
  );
  const pendingAddresses = new Set(Object.values(pending).map(({ quoteAddress }) => quoteAddress));
  const linkedToPendingQuote = (value) => {
    const pool = normalizeFlapPool(value);
    return pool?.kind === "vault_factory" && pendingAddresses.has(pool.quoteAddress);
  };
  const completedPending = new Set();
  const suppressUpdated = new Set();
  const currentByIdentity = byIdentity(current.flapPools || [], flapPoolIdentity);

  for (const change of changes.flapPoolChanges || []) {
    const after = normalizeFlapPool(change?.after);
    if (!after) continue;
    const identity = flapPoolIdentity(after);
    if (linkedToPendingQuote(after)) {
      suppressUpdated.add(identity);
      continue;
    }
    if (after.kind !== "quote_asset") continue;
    if (pending[identity]) {
      suppressUpdated.add(identity);
      if (flapPoolHasCompleteQuoteMetadata(after)) completedPending.add(identity);
      continue;
    }
    // A metadata-only null -> resolved transition without our durable pending
    // marker predates this lifecycle rollout. It is state repair, not a new
    // market event, so checkpoint it silently instead of claiming enablement.
    if (flapQuoteMetadataOnlyChange(change)) suppressUpdated.add(identity);
  }

  const keptNew = [];
  for (const value of changes.newFlapPools || []) {
    const pool = normalizeFlapPool(value);
    if (!pool) {
      keptNew.push(value);
      continue;
    }
    if (linkedToPendingQuote(pool)) continue;
    if (pool.kind !== "quote_asset") {
      keptNew.push(pool);
      continue;
    }
    if (!isBscFlapBoardQuoteNotificationPool(pool)) {
      keptNew.push(pool);
      continue;
    }
    const identity = flapPoolIdentity(pool);
    if (!flapPoolHasCompleteQuoteMetadata(pool)) continue;
    if (pending[identity]) {
      completedPending.add(identity);
    }
    // Every post-baseline quote discovery must be owned by a persisted
    // identity-level notification intent. An unowned quote is fail-closed: it
    // cannot fall through to the generic batch event or activation callback.
    continue;
  }

  // A persisted pending record is the delivery intent. If metadata and the
  // capability snapshot ever become durable in separate crash windows, rebuild
  // the same one-shot event rather than losing it or inventing a new timestamp.
  for (const [identity] of Object.entries(pending)) {
    const pool = normalizeFlapPool(currentByIdentity.get(identity));
    if (!flapPoolHasCompleteQuoteMetadata(pool)) continue;
    completedPending.add(identity);
  }

  const filtered = {
    ...changes,
    newFlapPools: uniqueObjects(keptNew, flapPoolIdentity),
    updatedFlapPools: (changes.updatedFlapPools || []).filter((value) => {
      const pool = normalizeFlapPool(value);
      return !pool || (!linkedToPendingQuote(pool)
        && !suppressUpdated.has(flapPoolIdentity(pool))
        && !(isBscFlapBoardQuoteNotificationPool(pool) && flapPoolNeedsQuoteMetadata(pool)));
    }),
    flapPoolChanges: (changes.flapPoolChanges || []).filter((change) => {
      const after = normalizeFlapPool(change?.after);
      if (!after) return true;
      if (linkedToPendingQuote(after) || suppressUpdated.has(flapPoolIdentity(after))) return false;
      return !isBscFlapBoardQuoteNotificationPool(after) || !flapPoolNeedsQuoteMetadata(after);
    }),
  };
  const pendingNotifications = [...completedPending].sort().map((identity) => ({
    identity,
    pending: pending[identity],
    pool: normalizeFlapPool(currentByIdentity.get(identity)),
  })).filter(({ pending: record, pool }) => record && flapPoolHasCompleteQuoteMetadata(pool));
  return {
    changes: filtered,
    pendingNotifications,
  };
}

function clearCompletedFlapQuoteMetadataNotifications(boardCandidateState, identities) {
  if (!identities?.length) return;
  const pending = normalizedFlapQuoteMetadataPendingMap(
    boardCandidateState?.flapQuoteMetadataNotificationPending,
  );
  for (const identity of identities) delete pending[identity];
  if (Object.keys(pending).length) boardCandidateState.flapQuoteMetadataNotificationPending = pending;
  else delete boardCandidateState.flapQuoteMetadataNotificationPending;
}

function flapQuoteMetadataNotificationEvent({ platform, previous, current, pool, pending, observedAt }) {
  const eventPool = normalizeFlapPool({
    ...pool,
    chainId: pool.chainId ?? pending.chainId,
  });
  const changes = emptyChanges();
  changes.newFlapPools = [eventPool];
  const quoteAsset = {
    symbol: eventPool.quoteSymbol,
    name: eventPool.quoteName,
    address: eventPool.quoteAddress,
    chainId: eventPool.chainId ?? null,
    ...(eventPool.quoteClassification ? { classification: eventPool.quoteClassification } : {}),
    ...(eventPool.quoteTags?.length ? { tags: eventPool.quoteTags } : {}),
  };
  const eventKey = `platform-capability:flap:board-observed:${fingerprint({
    version: pending.version,
    identity: pending.identity,
    firstObservedAt: pending.firstObservedAt,
  })}`;
  return {
    type: "platform_capability_update",
    kind: FLAP_QUOTE_BOARD_OBSERVED_KIND,
    changeType: "observed",
    eventKey,
    platform,
    previous,
    current,
    changes,
    source: FLAP_BOARD_URL,
    sources: [FLAP_BOARD_URL],
    url: FLAP_BOARD_URL,
    sourceOccurredAt: pending.firstObservedAt,
    observedAt,
    signal: {
      strong: false,
      platformStructural: true,
      category: "Flap quote asset observed on official Board",
      headline: `Flap official Board first confirmed ${quoteAsset.symbol} as a quote asset`,
      quotePairChange: {
        stage: "observed",
        assetClass: "quote_asset",
        assets: [quoteAsset],
      },
    },
  };
}

const isOfficialBscFlapBoardQuoteAsset = (pool) => pool?.kind === "quote_asset"
  && Number(pool.chainId) === 56
  && canonicalUrl(pool.sourceUrl || "") === canonicalUrl(FLAP_BOARD_URL);

function suppressExcludedFlapStockAssets(platform, changes) {
  if (platform.id !== "flap") return changes;
  const poolValues = [
    ...(changes.newFlapPools || []),
    ...(changes.removedFlapPools || []),
    ...(changes.updatedFlapPools || []),
    ...(changes.flapPoolChanges || []).flatMap((change) => [change.before, change.after]),
  ].filter(Boolean);
  const excludedAddresses = new Set(poolValues
    .filter(isExcludedFlapQuoteAsset)
    .map((pool) => normalizeFlapAddress(pool.quoteAddress))
    .filter(Boolean));
  const excluded = (pool) => !isOfficialBscFlapBoardQuoteAsset(pool) && (
    isExcludedFlapQuoteAsset(pool)
    || excludedAddresses.has(normalizeFlapAddress(pool?.quoteAddress))
  );
  return {
    ...changes,
    newFlapPools: (changes.newFlapPools || []).filter((pool) => !excluded(pool)),
    removedFlapPools: (changes.removedFlapPools || []).filter((pool) => !excluded(pool)),
    updatedFlapPools: (changes.updatedFlapPools || []).filter((pool) => !excluded(pool)),
    flapPoolChanges: (changes.flapPoolChanges || []).filter((change) => !excluded(change.before) && !excluded(change.after)),
    newModules: (changes.newModules || []).filter((module) => !isFlapStockClassification(module)),
    removedModules: (changes.removedModules || []).filter((module) => !isFlapStockClassification(module)),
  };
}

function suppressSchemaMigrationNoise(platform, previous, current, changes) {
  const migration = platform.schemaMigration;
  if (!migration) return changes;
  const filtered = { ...changes };
  for (const direction of ["added", "removed"]) {
    const capabilities = direction === "added" ? current : previous;
    for (const [capability, urls] of Object.entries(migration[direction] || {})) {
      const changeKey = capabilityChangeKeys[capability]?.[direction];
      if (!changeKey || !Array.isArray(filtered[changeKey])) continue;
      const ignoredSources = new Set(urls);
      filtered[changeKey] = filtered[changeKey].filter((value) => !backedOnlyBy(capabilities, capability, value, ignoredSources));
      if (capability === "pages" && direction === "added") {
        filtered.updatedPages = (filtered.updatedPages || []).filter((value) => !backedOnlyBy(current, capability, value, ignoredSources));
      }
    }
  }
  const ignoredFingerprints = new Set(migration.sourceFingerprints || []);
  filtered.changedSources = (filtered.changedSources || []).filter((url) => !ignoredFingerprints.has(url));
  filtered.newContentFingerprints = (filtered.newContentFingerprints || []).filter((item) => {
    const separator = item.indexOf("#");
    return !ignoredFingerprints.has(separator === -1 ? item : item.slice(0, separator));
  });
  return filtered;
}

const migrationCatchupChanges = (previous, current, apiCapabilities) => {
  const changes = emptyChanges();
  const previousQuotes = new Set(previous?.quoteTokens || []);
  changes.newQuoteTokens = (apiCapabilities?.quoteTokens || []).filter((symbol) => !previousQuotes.has(symbol));
  const newSymbols = new Set(changes.newQuoteTokens);
  changes.newQuoteConfigs = (apiCapabilities?.quoteConfigs || []).filter((item) => newSymbols.has(item.symbol));
  const previousContracts = new Set(previous?.contracts || []);
  changes.newContracts = uniqueStrings(changes.newQuoteConfigs.map((item) => item.address).filter((address) => !previousContracts.has(address)));
  return changes;
};

const sourceHealth = (sources) => Object.fromEntries(Object.entries(sources || {}).map(([key, source]) => [key, {
  url: source.url,
  kind: source.kind,
  status: source.status || (source.lastError ? "degraded" : "healthy"),
  initialized: Boolean(source.initialized),
  lastAttemptAt: source.lastAttemptAt || null,
  lastSuccessAt: source.lastSuccessAt || null,
  lastErrorAt: source.lastErrorAt || null,
  consecutiveFailures: Number(source.consecutiveFailures || 0),
  lastError: source.lastError || null,
  lastErrorStatus: source.lastErrorStatus ?? null,
  failureKind: source.failureKind || null,
  backoffMs: Number(source.backoffMs || 0),
  nextAttemptAt: source.nextAttemptAt || null,
  etag: source.etag || null,
  lastModified: source.lastModified || null,
  lastNotModifiedAt: source.lastNotModifiedAt || null,
  sourceRateLimited: source.sourceRateLimited === true,
  retryAfterMs: Number(source.retryAfterMs || 0),
  rateLimitResetAt: source.rateLimitResetAt || null,
  partialFailures: source.partialFailures || [],
  optionalForHealth: source.optionalForHealth === true,
  circuitOpen: source.circuitOpen === true,
  circuitOpenedAt: source.circuitOpenedAt || null,
  circuitReason: source.circuitReason || null,
}]));

const PLATFORM_SOURCE_TELEMETRY_FIELDS = new Set([
  "checkedAt",
  "lastAttemptAt",
  "lastSuccessAt",
  "lastNotModifiedAt",
  "lastContentChangedAt",
]);
const PLATFORM_HEALTH_TELEMETRY_FIELDS = new Set(["lastAttemptAt", "lastSuccessAt"]);

const withoutTopLevelFields = (value, fields) => Object.fromEntries(
  Object.entries(value || {}).filter(([key]) => !fields.has(key)),
);

const platformSourceDurablyChanged = (before, after) => stableStringify(
  withoutTopLevelFields(before, PLATFORM_SOURCE_TELEMETRY_FIELDS),
) !== stableStringify(withoutTopLevelFields(after, PLATFORM_SOURCE_TELEMETRY_FIELDS));

const platformHealthDurablyChanged = (before, after) => stableStringify(
  withoutTopLevelFields(before, PLATFORM_HEALTH_TELEMETRY_FIELDS),
) !== stableStringify(withoutTopLevelFields(after, PLATFORM_HEALTH_TELEMETRY_FIELDS));

const platformBoardDurableValue = (value) => {
  if (Array.isArray(value)) return value.map(platformBoardDurableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== "lastObservedAt")
    .map(([key, nested]) => [key, platformBoardDurableValue(nested)]));
};

function normalizedPlatformDeliverySla(value) {
  const startedAtMs = Date.parse(value?.startedAt || "");
  const deadlineAtMs = Date.parse(value?.deadlineAt || "");
  const budgetMs = Number(value?.budgetMs);
  const pollAllowanceMs = Number(value?.pollAllowanceMs);
  if (!Number.isFinite(startedAtMs)
    || !Number.isFinite(deadlineAtMs)
    || !Number.isFinite(budgetMs)
    || !Number.isFinite(pollAllowanceMs)
    || budgetMs !== 5_000
    || pollAllowanceMs !== 1_500
    || deadlineAtMs < startedAtMs
    || deadlineAtMs - startedAtMs + pollAllowanceMs > budgetMs
    || value?.basis !== "critical_source_poll") return null;
  return {
    startedAt: new Date(startedAtMs).toISOString(),
    deadlineAt: new Date(deadlineAtMs).toISOString(),
    budgetMs,
    pollAllowanceMs,
    basis: "critical_source_poll",
  };
}

function platformEventDeliverySla(platform, changes, boardCandidateState, fallback) {
  const normalizedFallback = normalizedPlatformDeliverySla(fallback);
  if (!normalizedFallback || platform.id !== "flap") return normalizedFallback;
  const candidateTimes = [];
  for (const pool of [...(changes.newFlapPools || []), ...(changes.updatedFlapPools || [])]) {
    const record = boardCandidateState?.flapPools?.[flapPoolIdentity(pool)];
    if (record?.firstObservedAt) candidateTimes.push(record.firstObservedAt);
  }
  const simpleChanges = {
    quoteTokens: changes.newQuoteTokens,
    modules: changes.newModules,
  };
  for (const [key, values] of Object.entries(simpleChanges)) {
    for (const value of values || []) {
      const record = boardCandidateState?.[key]?.[value];
      if (record?.firstObservedAt) candidateTimes.push(record.firstObservedAt);
    }
  }
  const earliest = candidateTimes.map((value) => Date.parse(value)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  if (!Number.isFinite(earliest)) return normalizedFallback;
  return {
    ...normalizedFallback,
    startedAt: new Date(earliest).toISOString(),
    deadlineAt: new Date(earliest + normalizedFallback.budgetMs - normalizedFallback.pollAllowanceMs).toISOString(),
  };
}

const eventSources = (changes, current) => {
  const urls = new Set(changes.changedSources || []);
  const additions = {
    quoteTokens: changes.newQuoteTokens,
    contracts: changes.newContracts,
    versions: changes.newVersions,
    modules: changes.newModules,
    pages: changes.newPages,
    announcements: changes.newAnnouncements,
    campaigns: changes.newCampaigns,
  };
  for (const [capability, values] of Object.entries(additions)) {
    for (const value of values || []) {
      for (const url of current.sourceProvenance?.[capability]?.[value] || []) urls.add(url);
    }
  }
  for (const chain of changes.newChains || []) {
    if (chain.source?.url) urls.add(chain.source.url);
    for (const source of chain.sources || []) if (source?.url) urls.add(source.url);
  }
  for (const change of changes.chainStageChanges || []) {
    const chain = change.after;
    if (chain?.source?.url) urls.add(chain.source.url);
    for (const source of chain?.sources || []) if (source?.url) urls.add(source.url);
  }
  for (const item of [...(changes.newQuoteConfigs || []), ...(changes.updatedQuoteConfigs || [])]) if (item.source?.url) urls.add(item.source.url);
  for (const item of [...(changes.newFlapPools || []), ...(changes.updatedFlapPools || [])]) if (item.sourceUrl) urls.add(item.sourceUrl);
  for (const item of [...(changes.newPackages || []), ...(changes.updatedPackages || [])]) if (item.source?.url) urls.add(item.source.url);
  return [...urls].sort();
};

function platformAlertChangeSets(platform, changes) {
  const flapPools = Array.isArray(changes?.newFlapPools) ? changes.newFlapPools : [];
  if (platform?.id === "flap" && flapPools.length) {
    const residualFlapPools = [];
    const poolChangeSets = [];
    for (const pool of flapPools) {
      const validPool = pool?.kind === "quote_asset"
        ? isNonZeroEvmAddress(pool?.quoteAddress)
        : isNonZeroEvmAddress(pool?.vaultFactory) && isNonZeroEvmAddress(pool?.quoteAddress);
      if (!validPool) {
        residualFlapPools.push(pool);
        continue;
      }
      const poolChanges = emptyChanges();
      poolChanges.newFlapPools = [pool];
      poolChangeSets.push(poolChanges);
    }
    if (!poolChangeSets.length) return [changes];
    const residualChanges = { ...changes, newFlapPools: residualFlapPools };
    return [
      ...poolChangeSets,
      ...(meaningful(residualChanges) ? [residualChanges] : []),
    ];
  }

  const quoteConfigs = Array.isArray(changes?.newQuoteConfigs) ? changes.newQuoteConfigs : [];
  if (platform?.id !== "fourmeme" || !quoteConfigs.length) return [changes];

  const quoteTokens = Array.isArray(changes.newQuoteTokens) ? changes.newQuoteTokens : [];
  const consumedQuoteTokens = new Set();
  const residualQuoteConfigs = [];
  const quoteChangeSets = [];
  for (const quoteConfig of quoteConfigs) {
    const symbol = typeof quoteConfig?.symbol === "string" ? quoteConfig.symbol : "";
    if (!symbol || !isNonZeroEvmAddress(quoteConfig?.address)) {
      // The official parser rejects this shape. If a migrated state somehow
      // contains it, retain the evidence in the generic event instead of
      // claiming that it is a verified quote pool.
      residualQuoteConfigs.push(quoteConfig);
      continue;
    }
    const matchingQuoteTokens = quoteTokens.filter((candidate) => candidate === symbol);
    for (const token of matchingQuoteTokens) consumedQuoteTokens.add(token);
    const quoteChanges = emptyChanges();
    quoteChanges.newQuoteTokens = matchingQuoteTokens;
    quoteChanges.newQuoteConfigs = [quoteConfig];
    quoteChangeSets.push(quoteChanges);
  }
  if (!quoteChangeSets.length) return [changes];

  const residualChanges = {
    ...changes,
    newQuoteTokens: quoteTokens.filter((token) => !consumedQuoteTokens.has(token)),
    newQuoteConfigs: residualQuoteConfigs,
  };
  return [
    ...quoteChangeSets,
    ...(meaningful(residualChanges) ? [residualChanges] : []),
  ];
}

const contractDiscoveryBatches = (platform, addresses, current, sources) => {
  if (platform.id === "fourmeme") return [{ chainId: 56, addresses: uniqueStrings(addresses) }];
  if (platform.id !== "flap") return [];

  const sourceChains = new Map();
  for (const source of Object.values(sources || {}).filter((item) => item?.initialized)) {
    const sourceUrl = canonicalUrl(source.url);
    const chainIds = sourceChains.get(sourceUrl) || new Set();
    for (const chainId of [
      normalizeChainId(source.chainId),
      ...(source.capabilities?.chains || []).map((chain) => normalizeChainId(chain.chainId)),
    ].filter((chainId) => chainId != null)) chainIds.add(chainId);
    sourceChains.set(sourceUrl, chainIds);
  }

  const grouped = new Map();
  for (const address of uniqueStrings(addresses)) {
    const chainIds = new Set();
    for (const sourceUrl of current.sourceProvenance?.contracts?.[address] || []) {
      for (const chainId of sourceChains.get(canonicalUrl(sourceUrl)) || []) chainIds.add(chainId);
    }
    // Contract pages can list several networks in one document. Without a
    // unique source-level chain attribution, injecting the address into any
    // chain scanner would be a cross-chain false positive.
    if (chainIds.size !== 1) continue;
    const [chainId] = chainIds;
    if (!grouped.has(chainId)) grouped.set(chainId, []);
    grouped.get(chainId).push(address);
  }
  return [...grouped.entries()]
    .map(([chainId, batchAddresses]) => ({ chainId, addresses: uniqueStrings(batchAddresses) }))
    .sort((left, right) => Number(left.chainId) - Number(right.chainId));
};

export async function atomicWriteJson(file, value, fsImpl = fs) {
  await fsImpl.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    await fsImpl.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await fsImpl.rename(temporary, file);
  } catch (error) {
    try { await fsImpl.unlink(temporary); } catch {}
    throw error;
  }
}

const appendAudit = async (auditFile, fsImpl, record) => {
  await fsImpl.mkdir(path.dirname(auditFile), { recursive: true });
  await fsImpl.appendFile(auditFile, `${JSON.stringify(record)}\n`);
};

const flapQuoteNotificationDeliveryCommitted = (delivery) => delivery?.status === "delivered"
  || (delivery?.status === "suppressed"
    && delivery?.reason === "semantic_duplicate"
    && delivery?.persisted === true
    && delivery?.canonicalOwnerDelivered === true);

const platformAlertDeliveryDurablyAccepted = (delivery) => {
  // Lightweight injected senders historically return void/a primitive. The
  // production sender returns the structured cases below.
  if (!delivery || typeof delivery !== "object" || Array.isArray(delivery)) return true;
  if (delivery.status === "delivered") return true;
  if (delivery.status === "queued" && delivery.persisted === true) return true;
  return delivery.status === "suppressed"
    && delivery.reason === "semantic_duplicate"
    && delivery.persisted === true
    && delivery.canonicalOwnerDelivered === true;
};

async function readPlatformCapabilityState(stateFile, fsImpl) {
  let state = {};
  try { state = JSON.parse(await fsImpl.readFile(stateFile, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  state._health ||= { platforms: {} };
  state._health.platforms ||= {};
  return state;
}

function createPlatformStateCoordinator() {
  let queue = Promise.resolve();
  return {
    run(operation) {
      const running = queue.catch(() => {}).then(operation);
      queue = running.catch(() => {});
      return running;
    },
  };
}

function descriptorsForPlatformLane(platform, lane, selectedKeys) {
  const descriptors = sourceDescriptors(platform);
  if (selectedKeys?.size) return descriptors.filter((descriptor) => selectedKeys.has(descriptor.key));
  if (lane === "fast") return descriptors.filter((descriptor) => isPlatformStructuredFastSource(platform, descriptor));
  if (lane === "slow") return descriptors.filter((descriptor) => !isPlatformStructuredFastSource(platform, descriptor));
  return descriptors;
}

function platformSourceCoverage(platform, descriptors, sources) {
  const descriptorByKey = new Map(descriptors.map((descriptor) => [descriptor.key, descriptor]));
  const sourceEntries = Object.entries(sources || {}).map(([key, source]) => ({
    key,
    source,
    descriptor: descriptorByKey.get(key),
  }));
  const fastDescriptors = descriptors.filter((descriptor) => isPlatformStructuredFastSource(platform, descriptor));
  const structuredFastHealthy = fastDescriptors.length > 0 && fastDescriptors.every((descriptor) => {
    const source = sources?.[descriptor.key];
    return source?.initialized === true && source?.status === "healthy";
  });
  const requiredCoverageUnavailable = descriptors.some((descriptor) => {
    if (!descriptor.requiredForBaseline) return false;
    const source = sources?.[descriptor.key];
    return source?.initialized !== true || source?.status !== "healthy";
  });
  const degraded = sourceEntries
    .filter(({ source }) => source?.status === "degraded")
    .sort((left, right) => Number(Boolean(right.descriptor?.requiredForBaseline)) - Number(Boolean(left.descriptor?.requiredForBaseline))
      || left.key.localeCompare(right.key, "en"));
  const optionalCircuits = degraded.filter(({ source, descriptor }) => (
    isFourMemeOptionalWebSource(platform, descriptor)
      && source.lastErrorStatus === 403
      && (source.circuitOpen === true || Number(source.consecutiveFailures || 0) >= 2)
  ));
  const toleratedOptionalKeys = new Set((structuredFastHealthy ? optionalCircuits : []).map(({ key }) => key));
  return {
    structuredFastHealthy,
    requiredCoverageUnavailable,
    degraded,
    blockingDegraded: degraded.filter(({ key }) => !toleratedOptionalKeys.has(key)),
    optionalCircuits,
  };
}

function platformHealthDiagnostics(coverage) {
  return {
    coverageStatus: coverage.requiredCoverageUnavailable || coverage.blockingDegraded.length ? "partial" : "complete",
    optionalCircuitOpenCount: coverage.optionalCircuits.length,
    optionalCircuitUrls: coverage.optionalCircuits.map(({ source }) => source.url).filter(Boolean).slice(0, 12),
  };
}

function logPlatformSourceFailures(logger, sourceLane, platform, descriptorCount, failures, allSelectedFailed = false) {
  const loggable = failures.filter((failure) => failure.loggable !== false);
  if (!loggable.length) return;
  const material = loggable.filter((failure) => !failure.optionalWeb403);
  if (material.length) {
    const messages = uniqueStrings(material.map(({ message }) => message)).slice(0, 3);
    logger.error(`[platform-capability][${sourceLane}] ${platform.id}: ${allSelectedFailed ? "all" : `${material.length}/${descriptorCount}`} selected sources failed; ${messages.join(" | ")}`);
    return;
  }
  logger.error(`[platform-capability][${sourceLane}] ${platform.id}: optional web HTTP 403 circuit opened for ${loggable.length} source(s); persisted low-frequency probes remain enabled`);
}

export async function runPlatformCapabilityCheck(config, dependencies = {}) {
  const fsImpl = dependencies.fsImpl || fs;
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const alertSender = dependencies.sendAlertsImpl || sendAlerts;
  const targets = dependencies.targets || PLATFORM_CAPABILITY_TARGETS;
  const now = dependencies.now || (() => new Date());
  const logger = dependencies.logger || console;
  const stateFile = dependencies.stateFile || path.join(config.dataDir, "platform-capability-state.json");
  const auditFile = dependencies.auditFile || path.join(config.dataDir, "platform-capability-events.jsonl");
  const sourceLane = ["fast", "slow"].includes(dependencies.sourceLane) ? dependencies.sourceLane : "all";
  const selectedKeys = Array.isArray(dependencies.descriptorKeys) ? new Set(dependencies.descriptorKeys) : null;
  const stateCoordinator = dependencies.stateCoordinator || createPlatformStateCoordinator();
  const retryBaseMs = Math.max(1_000, Number(sourceLane === "fast"
    ? config.platformCapabilityFastSourceIntervalMs
    : config.platformCapabilityPollIntervalMs) || 30_000);
  const retryMaxMs = Math.max(retryBaseMs, Number(config.platformCapabilityRetryMaxMs) || 120_000);
  const telemetryPersistIntervalMs = Math.max(1_000, Number(dependencies.telemetryPersistIntervalMs) || 30_000);
  const writeState = dependencies.atomicWriteJsonImpl || atomicWriteJson;
  let latestState = await readPlatformCapabilityState(stateFile, fsImpl);

  for (const platform of targets) {
    const observedAt = now().toISOString();
    const observedMs = Date.parse(observedAt);
    const snapshot = await readPlatformCapabilityState(stateFile, fsImpl);
    const platformHealth = snapshot._health.platforms[platform.id] || {};
    const nextAttemptAt = Date.parse(platformHealth.nextAttemptAt || "");
    const startupTransportProbe = dependencies.ignoreTransportBackoff
      && (platformHealth.failureKind === "transport"
        || (!platformHealth.failureKind && isPlatformTransportFailure(platformHealth)));
    if (sourceLane === "all"
      && !startupTransportProbe
      && Number.isFinite(nextAttemptAt)
      && observedMs < nextAttemptAt) continue;
    const snapshotSources = {
      ...(snapshot[platform.id]?.sources || {}),
      ...(snapshot._health.pendingSources?.[platform.id] || {}),
    };
    const allDescriptors = sourceDescriptors(platform);
    const descriptors = descriptorsForPlatformLane(platform, sourceLane, selectedKeys);
    if (!descriptors.length) continue;
    const results = await settleBounded(
      descriptors,
      sourceLane === "fast" ? 1 : Math.max(1, Number(config.platformCapabilityConcurrency) || 3),
      (descriptor) => {
      const prior = snapshotSources[descriptor.key];
      const sourceNextAttemptAt = Date.parse(prior?.nextAttemptAt || "");
      const optionalFlapMorphEmptyMigration = platform.id === "flap"
        && descriptor.requiredForBaseline === false
        && canonicalUrl(descriptor.url) === canonicalUrl(FLAP_MORPH_BOARD_URL)
        && prior?.failureKind === "schema_empty";
      const sourceStartupTransportProbe = dependencies.ignoreTransportBackoff
        && (prior?.failureKind === "transport"
          || (!prior?.failureKind && isPlatformTransportFailure(prior)));
      if (!sourceStartupTransportProbe
        && !optionalFlapMorphEmptyMigration
        && Number.isFinite(sourceNextAttemptAt)
        && observedMs < sourceNextAttemptAt) {
        return { skippedForBackoff: true };
      }
      return fetchPlatformSource(
        platform,
        descriptor,
        fetchImpl,
        sourceLane === "fast"
          ? Math.max(1_000, Number(config.platformCapabilityFastRequestTimeoutMs) || 2_000)
          : config.platformCapabilityRequestTimeoutMs,
        sourceLane === "fast" ? {
          etag: prior?.etag,
          lastModified: prior?.lastModified,
          priorSource: prior,
          allowNotModified: true,
          currentTimeMs: observedMs,
        } : {},
      );
      },
    );
    latestState = await stateCoordinator.run(async () => {
      const state = await readPlatformCapabilityState(stateFile, fsImpl);
      const freshPlatformHealth = state._health.platforms[platform.id] || {};
      const previousEntry = state[platform.id];
      const previousSources = {
        ...(previousEntry?.sources || {}),
        ...(state._health.pendingSources?.[platform.id] || {}),
      };
      const nextSources = { ...previousSources };
      const successfulKeys = [];
      const attemptedKeys = [];
      const failures = [];

      for (let index = 0; index < descriptors.length; index += 1) {
        const descriptor = descriptors[index];
        const result = results[index];
        const prior = previousSources[descriptor.key];
        if (result.status === "fulfilled" && result.value?.skippedForBackoff) continue;
        attemptedKeys.push(descriptor.key);
        if (result.status === "fulfilled") {
          successfulKeys.push(descriptor.key);
          const notModified = result.value.notModified === true;
          let sourceValue = notModified ? {
            ...prior,
            key: descriptor.key,
            url: descriptor.url,
            kind: descriptor.kind,
            etag: result.value.etag || prior?.etag || null,
            lastModified: result.value.lastModified || prior?.lastModified || null,
          } : result.value;
          const partialFailures = sourceValue.partialFailures || [];
          if (partialFailures.length && prior?.initialized) {
            const failedUrls = new Set(partialFailures.map((failure) => canonicalUrl(failure.url)));
            const priorPages = prior.capabilities?.pageMetadata || [];
            const preserved = priorPages.filter((page) => {
              const sourcePath = page.source?.path || [];
              if (!sourcePath.length) return true;
              return sourcePath.some((url) => failedUrls.has(canonicalUrl(url)));
            });
            const pageMetadata = uniqueObjects(
              [...(sourceValue.capabilities?.pageMetadata || []), ...preserved],
              (item) => item.url,
            );
            const capabilities = {
              ...sourceValue.capabilities,
              pages: uniqueStrings(pageMetadata.map((item) => item.url)),
              pageMetadata,
            };
            sourceValue = { ...sourceValue, capabilities, fingerprint: fingerprint(stableStringify(pageMetadata)) };
          }
          nextSources[descriptor.key] = {
            ...sourceValue,
            status: "healthy",
            initialized: true,
            checkedAt: observedAt,
            lastAttemptAt: observedAt,
            lastSuccessAt: observedAt,
            ...(notModified ? { lastNotModifiedAt: observedAt } : { lastContentChangedAt: observedAt }),
            lastErrorAt: prior?.lastErrorAt || null,
            lastError: null,
            lastErrorStatus: null,
            failureKind: null,
            consecutiveFailures: 0,
            backoffMs: 0,
            nextAttemptAt: null,
            sourceRateLimited: false,
            retryAfterMs: 0,
            rateLimitResetAt: null,
            partialFailures,
            optionalForHealth: isFourMemeOptionalWebSource(platform, descriptor),
            circuitOpen: false,
            circuitOpenedAt: null,
            circuitReason: null,
          };
        } else {
          const errorMessage = result.reason?.message || String(result.reason);
          const failureStatus = Number.isInteger(result.reason?.status) ? result.reason.status : null;
          const transportFailure = isPlatformTransportFailure(result.reason);
          const failureKind = result.reason?.code === "schema_empty"
            ? "schema_empty"
            : transportFailure ? "transport" : "policy_or_source";
          const consecutiveFailures = Number(prior?.consecutiveFailures || 0) + 1;
          const retryAfterMs = Math.max(0, Number(result.reason?.retryAfterMs) || 0);
          const optionalWeb403 = failureStatus === 403 && isFourMemeOptionalWebSource(platform, descriptor);
          const localBackoffMs = optionalWeb403
            ? fourMemeOptionalWebCircuitBackoffMs(consecutiveFailures)
            : [403, 429].includes(failureStatus)
              ? 15 * 60_000
            : Math.min(transportFailure ? 60_000 : retryMaxMs, retryBaseMs * (2 ** Math.min(20, consecutiveFailures - 1)));
          const failureBackoffMs = Math.max(localBackoffMs, retryAfterMs);
          const rateLimitResetAt = failureStatus === 429
            ? new Date(observedMs + failureBackoffMs).toISOString()
            : null;
          failures.push({
            kind: descriptor.kind,
            message: errorMessage,
            status: failureStatus,
            transport: transportFailure,
            failureKind,
            optionalWeb403,
            loggable: !optionalWeb403 || prior?.circuitOpen !== true || prior?.lastErrorStatus !== 403,
            backoffMs: failureBackoffMs,
          });
          nextSources[descriptor.key] = {
            ...(prior || {
              key: descriptor.key,
              url: descriptor.url,
              kind: descriptor.kind,
              parser: descriptor.parser || null,
              authoritativeQuotes: Boolean(descriptor.authoritativeQuotes),
              requiredForBaseline: Boolean(descriptor.requiredForBaseline),
              initialized: false,
              lastSuccessAt: null,
            }),
            status: "degraded",
            lastAttemptAt: observedAt,
            lastErrorAt: observedAt,
            lastError: errorMessage,
            lastErrorStatus: failureStatus,
            failureKind,
            consecutiveFailures,
            backoffMs: failureBackoffMs,
            nextAttemptAt: new Date(observedMs + failureBackoffMs).toISOString(),
            sourceRateLimited: failureStatus === 429,
            retryAfterMs,
            rateLimitResetAt,
            optionalForHealth: isFourMemeOptionalWebSource(platform, descriptor),
            circuitOpen: optionalWeb403,
            circuitOpenedAt: optionalWeb403 ? prior?.circuitOpenedAt || observedAt : null,
            circuitReason: optionalWeb403 ? "http_403" : null,
          };
        }
      }

      if (!attemptedKeys.length) return state;

      const coverage = platformSourceCoverage(platform, allDescriptors, nextSources);
      const blockingSources = coverage.blockingDegraded.map(({ source }) => source);
      const degradedFailureKind = blockingSources.length > 0
        && blockingSources.every((source) => source.failureKind === blockingSources[0].failureKind)
        ? blockingSources[0].failureKind
        : blockingSources.length ? "policy_or_source" : null;
      const degradedMessages = uniqueStrings(blockingSources.map((source) => source.lastError).filter(Boolean)).slice(0, 3);
      const degradedStatuses = blockingSources.map((source) => source.lastErrorStatus).filter(Number.isInteger);
      const degradedErrorTimes = blockingSources.map((source) => source.lastErrorAt).filter(Boolean).sort();
      const healthDiagnostics = platformHealthDiagnostics(coverage);

      // Stable successful polls only advance observability timestamps. Keep
      // every source fresh on disk at least once per bounded interval, while
      // avoiding a full ~200KB atomic rewrite on every 304/unchanged response.
      // All semantic/source-policy transitions remain outside this telemetry
      // path and are persisted immediately below.
      const sourceDurableChange = attemptedKeys.some((key) => platformSourceDurablyChanged(
        previousSources[key],
        nextSources[key],
      ));
      const sourceTelemetryDue = attemptedKeys.some((key) => {
        const persistedAt = Date.parse(previousSources[key]?.checkedAt
          || previousSources[key]?.lastAttemptAt
          || "");
        return !Number.isFinite(persistedAt) || observedMs - persistedAt >= telemetryPersistIntervalMs;
      });
      const persistPlatformState = async ({ durable = false } = {}) => {
        const healthDurableChange = platformHealthDurablyChanged(
          freshPlatformHealth,
          state._health.platforms[platform.id],
        );
        if (durable || sourceDurableChange || healthDurableChange || sourceTelemetryDue) {
          await writeState(stateFile, state, fsImpl);
        }
        return state;
      };

      const persistUnavailableSources = async ({ durable = false } = {}) => {
        if (previousEntry) {
          state[platform.id] = { ...previousEntry, sources: nextSources, sourceHealth: sourceHealth(nextSources), lastAttemptAt: observedAt };
        } else {
          state._health.pendingSources ||= {};
          state._health.pendingSources[platform.id] = nextSources;
        }
        return persistPlatformState({ durable: durable || !previousEntry });
      };

      if (!successfulKeys.length) {
        const optionalCircuitOnly = failures.length > 0
          && failures.every((failure) => failure.optionalWeb403)
          && coverage.blockingDegraded.length === 0
          && coverage.structuredFastHealthy;
        if (optionalCircuitOnly) {
          state._health.platforms[platform.id] = {
            ...freshPlatformHealth,
            status: "healthy",
            failureKind: null,
            consecutiveFailures: 0,
            lastAttemptAt: observedAt,
            lastErrorAt: null,
            lastError: null,
            lastErrorStatus: null,
            backoffMs: 0,
            nextAttemptAt: null,
            ...healthDiagnostics,
          };
          logPlatformSourceFailures(logger, sourceLane, platform, descriptors.length, failures, true);
          return persistUnavailableSources({ durable: true });
        }
        const consecutiveFailures = Math.max(0, Number(freshPlatformHealth.consecutiveFailures) || 0) + 1;
        const backoffMs = Math.min(retryMaxMs, retryBaseMs * (2 ** Math.min(20, consecutiveFailures - 1)));
        const messages = degradedMessages.length
          ? degradedMessages
          : uniqueStrings(failures.map(({ message }) => message)).slice(0, 3);
        const failureKind = failures.length > 0 && failures.every((failure) => failure.failureKind === "transport")
          ? "transport"
          : failures.length > 0 && failures.every((failure) => failure.failureKind === "schema_empty")
            ? "schema_empty"
            : "policy_or_source";
        state._health.platforms[platform.id] = {
          ...freshPlatformHealth,
          status: platform.id === "fourmeme" && previousEntry ? "partial" : "degraded",
          failureKind,
          consecutiveFailures,
          lastAttemptAt: observedAt,
          lastErrorAt: observedAt,
          lastError: messages.join(" | "),
          lastErrorStatus: failures.find(({ status }) => Number.isInteger(status))?.status || null,
          backoffMs: sourceLane === "all" ? backoffMs : 0,
          nextAttemptAt: sourceLane === "all" ? new Date(observedMs + backoffMs).toISOString() : null,
          ...healthDiagnostics,
        };
        logPlatformSourceFailures(logger, sourceLane, platform, descriptors.length, failures, true);
        return persistUnavailableSources({ durable: true });
      }

      state._health.platforms[platform.id] = {
        status: blockingSources.length ? "partial" : "healthy",
        failureKind: degradedFailureKind,
        consecutiveFailures: 0,
        lastAttemptAt: observedAt,
        lastSuccessAt: observedAt,
        lastErrorAt: degradedErrorTimes.at(-1) || null,
        lastError: degradedMessages.length ? degradedMessages.join(" | ") : null,
        lastErrorStatus: degradedStatuses[0] ?? null,
        backoffMs: 0,
        nextAttemptAt: null,
        ...healthDiagnostics,
      };
      logPlatformSourceFailures(logger, sourceLane, platform, descriptors.length, failures, false);

      const requiredUnavailable = allDescriptors.some((descriptor) => descriptor.requiredForBaseline
        && !nextSources[descriptor.key]?.initialized);
      if (requiredUnavailable) {
        if (previousEntry) {
          state[platform.id] = { ...previousEntry, sources: nextSources, sourceHealth: sourceHealth(nextSources), lastAttemptAt: observedAt };
        } else {
          state._health.pendingSources ||= {};
          state._health.pendingSources[platform.id] = nextSources;
        }
        return persistPlatformState({ durable: !previousEntry });
      }

      const aggregated = aggregateSources(platform, nextSources);
      const stabilizedBoard = stabilizeFlapBoardCandidates(platform, previousEntry, aggregated, nextSources, successfulKeys, observedAt);
      const enrichedBoard = await enrichNewFlapQuoteAssets(
        platform,
        previousEntry,
        stabilizedBoard.capabilities,
        stabilizedBoard.boardCandidateState,
        dependencies,
        logger,
        observedAt,
      );
      const current = enrichedBoard.capabilities;
      stabilizedBoard.boardCandidateState = enrichedBoard.boardCandidateState;
      let changes = null;
      let flapQuoteMetadataNotification = {
        pendingNotifications: [],
      };
      let observedChains = mergeChainRecords(current.chains || []);
      if (previousEntry?.capabilities) {
        changes = diffCapabilities(previousEntry.capabilities, current);
        const previousSchemaVersion = Number(previousEntry.capabilitySchemaVersion || 1);
        const currentSchemaVersion = Number(platform.capabilitySchemaVersion || 1);
        if (previousSchemaVersion !== currentSchemaVersion) {
          changes = suppressSchemaMigrationNoise(platform, previousEntry.capabilities, current, changes);
        }
        changes = suppressFlapBoardChurn(platform, previousEntry.capabilities, changes);
        changes = finalizeFlapPoolChanges(platform, previousEntry, current, changes);
        flapQuoteMetadataNotification = finalizeFlapQuoteMetadataNotifications(
          platform,
          current,
          stabilizedBoard.boardCandidateState,
          changes,
        );
        changes = flapQuoteMetadataNotification.changes;
        changes = suppressExcludedFlapStockAssets(platform, changes);
        const finalizedChains = finalizeChainChanges(previousEntry, current, changes);
        changes = finalizedChains.changes;
        observedChains = finalizedChains.observedChains;
      }

      const nextEntry = {
        capabilitySchemaVersion: Number(platform.capabilitySchemaVersion || 1),
        capabilities: current,
        sources: nextSources,
        sourceHealth: sourceHealth(nextSources),
        observedChains,
        checkedAt: observedAt,
        lastAttemptAt: observedAt,
        ...(stabilizedBoard.boardCandidateState ? { boardCandidateState: stabilizedBoard.boardCandidateState } : {}),
      };
      const removedPendingSources = Boolean(state._health.pendingSources?.[platform.id]);
      if (state._health.pendingSources) delete state._health.pendingSources[platform.id];
      const entryDurableChange = !previousEntry
        || Number(previousEntry.capabilitySchemaVersion || 1) !== Number(nextEntry.capabilitySchemaVersion || 1)
        || stableStringify(previousEntry.capabilities || {}) !== stableStringify(nextEntry.capabilities || {})
        || stableStringify(previousEntry.observedChains || []) !== stableStringify(nextEntry.observedChains || [])
        || stableStringify(platformBoardDurableValue(previousEntry.boardCandidateState || null))
          !== stableStringify(platformBoardDurableValue(nextEntry.boardCandidateState || null))
        || removedPendingSources;

      const committedNotificationEventKeys = [];
      let notificationStateChanged = false;
      for (const notification of flapQuoteMetadataNotification.pendingNotifications) {
        const event = flapQuoteMetadataNotificationEvent({
          platform,
          previous: previousEntry.capabilities,
          current,
          pool: notification.pool,
          pending: notification.pending,
          observedAt,
        });
        const notificationDeliverySla = sourceLane === "fast"
          ? platformEventDeliverySla(
            platform,
            event.changes,
            stabilizedBoard.boardCandidateState,
            dependencies.deliverySla,
          )
          : null;
        if (notificationDeliverySla) event.deliverySla = notificationDeliverySla;
        const auditBase = {
          eventKey: event.eventKey,
          type: event.type,
          platform: platform.id,
          source: event.source,
          sources: event.sources,
          changes: event.changes,
          observedAt,
        };
        await appendAudit(auditFile, fsImpl, { ...auditBase, delivery: { status: "pending", baselineCommitted: false } });
        let delivery;
        try {
          delivery = await alertSender(config, event);
          await appendAudit(auditFile, fsImpl, {
            ...auditBase,
            delivery: { status: delivery?.status || "unknown", eventId: delivery?.eventId || event.eventKey, baselineCommitted: false },
          });
        } catch (error) {
          await appendAudit(auditFile, fsImpl, { ...auditBase, delivery: { status: "failed", baselineCommitted: false, error: error.message } });
          logger.error(`[platform-capability] flap quote metadata delivery: ${error.message}`);
          continue;
        }
        if (!flapQuoteNotificationDeliveryCommitted(delivery)) continue;

        clearCompletedFlapQuoteMetadataNotifications(
          stabilizedBoard.boardCandidateState,
          [notification.identity],
        );
        committedNotificationEventKeys.push(event.eventKey);
        notificationStateChanged = true;
      }

      const emittedEventKeys = [];
      if (changes && meaningful(changes)) {
        const batchSources = eventSources(changes, current);
        const batchSource = batchSources[0] || platform.apiSources?.[0]?.url || platform.sources?.[0] || platform.website;
        const alertRecords = platformAlertChangeSets(platform, changes).map((eventChanges) => {
          const sources = eventSources(eventChanges, current);
          const source = sources[0] || batchSource;
          const eventKey = `platform-capability:${platform.id}:${fingerprint({ changes: eventChanges, source })}`;
          const deliverySla = sourceLane === "fast"
            ? platformEventDeliverySla(platform, eventChanges, stabilizedBoard.boardCandidateState, dependencies.deliverySla)
            : null;
          const event = {
            type: "platform_capability_update",
            eventKey,
            platform,
            previous: previousEntry.capabilities,
            current,
            changes: eventChanges,
            source,
            sources,
            url: source,
            observedAt,
            ...(deliverySla ? { deliverySla } : {}),
          };
          return {
            event,
            auditBase: {
              eventKey,
              type: event.type,
              platform: platform.id,
              source,
              sources,
              changes: eventChanges,
              observedAt,
            },
            fourMemeQuoteChild: platform.id === "fourmeme"
              && eventChanges.newQuoteConfigs?.length === 1,
          };
        });
        emittedEventKeys.push(...alertRecords.map(({ event }) => event.eventKey));
        for (const { auditBase } of alertRecords) {
          await appendAudit(auditFile, fsImpl, { ...auditBase, delivery: { status: "pending", baselineCommitted: false } });
        }

        // Every event shares the source poll's deadline. Start their durable
        // alert handoffs together so a batch of new quote pools does not turn
        // the five-second source SLA into N sequential delivery windows.
        const deliveryResults = await Promise.allSettled(alertRecords.map(({ event }) => (
          Promise.resolve().then(() => alertSender(config, event))
        )));
        let deliveryFailed = false;
        for (let index = 0; index < alertRecords.length; index += 1) {
          const { event, auditBase, fourMemeQuoteChild } = alertRecords[index];
          const result = deliveryResults[index];
          if (result.status === "fulfilled") {
            const delivery = result.value;
            await appendAudit(auditFile, fsImpl, {
              ...auditBase,
              delivery: { status: delivery?.status || "delivered", eventId: delivery?.eventId || event.eventKey, baselineCommitted: false },
            });
            if (fourMemeQuoteChild && !platformAlertDeliveryDurablyAccepted(delivery)) {
              deliveryFailed = true;
              logger.error(`[platform-capability] ${platform.id} delivery was not durably accepted: ${delivery?.reason || delivery?.status || "unknown"}`);
            }
            continue;
          }
          deliveryFailed = true;
          await appendAudit(auditFile, fsImpl, {
            ...auditBase,
            delivery: { status: "failed", baselineCommitted: false, error: result.reason?.message || String(result.reason) },
          });
          logger.error(`[platform-capability] ${platform.id} delivery: ${result.reason?.message || result.reason}`);
        }
        if (deliveryFailed) return state;

        const auditBase = alertRecords[0].auditBase;
        if (changes.newContracts?.length && dependencies.onContractDiscovery) {
          const discoveryBatches = contractDiscoveryBatches(platform, changes.newContracts, current, nextSources);
          try {
            for (const batch of discoveryBatches) {
              await Promise.resolve(dependencies.onContractDiscovery({
                addresses: batch.addresses,
                platformName: platform.name,
                sourceTrust: "official_verified",
                sourceId: `platform-capability:${platform.id}`,
                sourceUrl: batchSource,
                chainId: batch.chainId,
                observedAt,
              }));
            }
          } catch (error) {
            await appendAudit(auditFile, fsImpl, { ...auditBase, delivery: { status: "discovery_failed", baselineCommitted: false, error: error?.message || String(error) } });
            logger.error(`[platform-capability] ${platform.id} contract discovery: ${error?.message || error}`);
            return state;
          }
        }
        if (platform.id === "flap"
          && ((changes.newFlapPools || []).length || (changes.updatedFlapPools || []).length)
          && dependencies.onFlapFeatureActivation) {
          const records = [
            ...(changes.newFlapPools || []).map((pool) => ({ pool, changeType: "new_flap_pool" })),
            ...(changes.updatedFlapPools || []).map((pool) => ({ pool, changeType: "updated_flap_pool" })),
          ].filter(({ pool }) => pool.kind === "vault_factory" && !isExcludedFlapQuoteAsset(pool)).map(({ pool, changeType }) => {
            const identity = flapPoolIdentity(pool);
            const confirmation = stabilizedBoard.boardCandidateState?.flapPools?.[identity] || {};
            return {
              identity,
              category: pool.category || null,
              vaultFactory: pool.vaultFactory || null,
              quoteAddress: pool.quoteAddress || null,
              quoteSymbol: pool.quoteSymbol || null,
              sourceUrl: pool.sourceUrl || FLAP_BOARD_URL,
              chainId: pool.chainId || null,
              confirmed: confirmation.confirmed === true,
              observations: Number(confirmation.observations || 0),
              changeType,
              observedAt,
              firstObservedAt: confirmation.firstObservedAt || observedAt,
            };
          }).filter((record) => record.confirmed && record.observations >= FLAP_BOARD_STABLE_OBSERVATIONS);
          if (records.length) {
            try { await Promise.resolve(dependencies.onFlapFeatureActivation(records)); }
            catch (error) {
              await appendAudit(auditFile, fsImpl, { ...auditBase, delivery: { status: "feature_activation_failed", baselineCommitted: false, error: error?.message || String(error) } });
              logger.error(`[platform-capability] flap feature activation: ${error?.message || error}`);
              return state;
            }
          }
        }
        if (platform.id === "fourmeme" && (changes.newQuoteConfigs || []).length && dependencies.onFourMemeFeatureActivation) {
          try {
            await Promise.resolve(dependencies.onFourMemeFeatureActivation(changes.newQuoteConfigs.map((quoteConfig) => ({
              quoteConfig,
              changeType: "new_published_quote",
              observedAt,
              firstObservedAt: observedAt,
              sourceUrl: quoteConfig.source?.url || batchSource,
            }))));
          } catch (error) {
            await appendAudit(auditFile, fsImpl, { ...auditBase, delivery: { status: "feature_activation_failed", baselineCommitted: false, error: error?.message || String(error) } });
            logger.error(`[platform-capability] fourmeme feature activation: ${error?.message || error}`);
            return state;
          }
        }
      }
      state[platform.id] = nextEntry;
      for (const eventKey of committedNotificationEventKeys) {
        await appendAudit(auditFile, fsImpl, {
          eventKey,
          type: "platform_capability_update",
          platform: platform.id,
          observedAt,
          delivery: { status: "checkpoint_committed", baselineCommitted: true },
        });
      }
      for (const eventKey of emittedEventKeys) {
        await appendAudit(auditFile, fsImpl, {
          eventKey,
          type: "platform_capability_update",
          platform: platform.id,
          observedAt,
          delivery: { status: "checkpoint_committed", baselineCommitted: true },
        });
      }
      return persistPlatformState({
        durable: entryDurableChange || notificationStateChanged || Boolean(changes && meaningful(changes)),
      });
    });
  }
  return latestState;
}

export function createPlatformCapabilityMonitor(config, dependencies = {}) {
  const targets = dependencies.targets || PLATFORM_CAPABILITY_TARGETS;
  const logger = dependencies.logger || console;
  const now = dependencies.now || (() => new Date());
  const stateCoordinator = dependencies.stateCoordinator || createPlatformStateCoordinator();
  const fastTargets = targets.flatMap((platform) => sourceDescriptors(platform)
    .filter((descriptor) => isPlatformStructuredFastSource(platform, descriptor))
    .map((descriptor) => ({ platform, descriptor })));
  const hasFastLane = fastTargets.length > 0;
  let running = false;
  let runningPromise = null;
  let scheduledDrainPromise = null;
  let scheduledRerunRequested = false;
  let startupProbe = true;
  let stopped = false;
  let stopPromise = null;
  const check = () => {
    if (stopped || runningPromise) return Promise.resolve();
    running = true;
    const ignoreTransportBackoff = startupProbe;
    startupProbe = false;
    runningPromise = (async () => {
      try {
        await runPlatformCapabilityCheck(config, {
          ...dependencies,
          targets,
          stateCoordinator,
          sourceLane: hasFastLane ? "slow" : "all",
          ignoreTransportBackoff,
        });
      }
      catch (error) { logger.error(`[platform-capability] check: ${error.message}`); }
    })().finally(() => {
      running = false;
      runningPromise = null;
      // A timer can fire while a manually requested check owns the single-flight
      // slot. Start its one coalesced catch-up cycle as soon as that check exits.
      if (!stopped && scheduledRerunRequested && !scheduledDrainPromise) void requestScheduledCheck();
    });
    return runningPromise;
  };

  function requestScheduledCheck() {
    if (stopped) return scheduledDrainPromise || runningPromise || Promise.resolve();
    if (running || scheduledDrainPromise) {
      scheduledRerunRequested = true;
      return scheduledDrainPromise || runningPromise;
    }
    scheduledDrainPromise = (async () => {
      // Run the scheduled cycle plus at most one coalesced catch-up. Dropping
      // further overlapping ticks is intentional: the next interval will
      // retry, while an unbounded drain can self-saturate the process.
      for (let cycle = 0; cycle < 2 && !stopped; cycle += 1) {
        scheduledRerunRequested = false;
        await check();
        if (!scheduledRerunRequested) break;
      }
      scheduledRerunRequested = false;
    })().finally(() => {
      scheduledDrainPromise = null;
    });
    return scheduledDrainPromise;
  }

  const fastSchedulerIntervalMs = Math.max(100, Number(config.platformCapabilityFastSchedulerIntervalMs) || 500);
  const fastSourceIntervalMs = Math.max(1_500, Number(config.platformCapabilityFastSourceIntervalMs) || 1_500);
  const fastPollAllowanceMs = 1_500;
  const fastDeliveryBudgetMs = 5_000;
  const fastLastStartedAt = new Map();
  let fastCursor = 0;
  let fastRunningPromise = null;
  let fastRerunRequested = false;

  const nextDueFastTarget = (scheduledAtMs) => {
    for (let offset = 0; offset < fastTargets.length; offset += 1) {
      const index = (fastCursor + offset) % fastTargets.length;
      const candidate = fastTargets[index];
      const key = `${candidate.platform.id}:${candidate.descriptor.key}`;
      const lastStartedAt = fastLastStartedAt.get(key);
      if (Number.isFinite(lastStartedAt) && scheduledAtMs - lastStartedAt < fastSourceIntervalMs) continue;
      fastCursor = (index + 1) % fastTargets.length;
      fastLastStartedAt.set(key, scheduledAtMs);
      return candidate;
    }
    return null;
  };

  const runOneFastSource = async () => {
    const scheduledAt = now();
    const scheduledAtMs = scheduledAt.getTime();
    const target = nextDueFastTarget(scheduledAtMs);
    if (!target) return { skipped: true, reason: "minimum_interval" };
    const deliverySla = {
      startedAt: scheduledAt.toISOString(),
      deadlineAt: new Date(scheduledAtMs + fastDeliveryBudgetMs - fastPollAllowanceMs).toISOString(),
      budgetMs: fastDeliveryBudgetMs,
      pollAllowanceMs: fastPollAllowanceMs,
      basis: "critical_source_poll",
    };
    return runPlatformCapabilityCheck(config, {
      ...dependencies,
      targets: [target.platform],
      descriptorKeys: [target.descriptor.key],
      stateCoordinator,
      sourceLane: "fast",
      deliverySla,
    });
  };

  function requestFastCheck() {
    if (!hasFastLane || stopped) return fastRunningPromise;
    if (fastRunningPromise) {
      fastRerunRequested = true;
      return fastRunningPromise;
    }
    fastRunningPromise = (async () => {
      for (let cycle = 0; cycle < 2 && !stopped; cycle += 1) {
        fastRerunRequested = false;
        await runOneFastSource();
        if (!fastRerunRequested) break;
      }
      fastRerunRequested = false;
    })().catch((error) => {
      logger.error(`[platform-capability][fast] ${error.message}`);
    }).finally(() => {
      fastRunningPromise = null;
    });
    return fastRunningPromise;
  }

  let timer = null;
  let fastTimer = null;
  if (dependencies.autoStart !== false) {
    void requestScheduledCheck();
    timer = setInterval(requestScheduledCheck, config.platformCapabilityPollIntervalMs);
    timer.unref?.();
    if (hasFastLane) {
      void requestFastCheck();
      fastTimer = setInterval(requestFastCheck, fastSchedulerIntervalMs);
      fastTimer.unref?.();
    }
  }
  return {
    check,
    checkFast: requestFastCheck,
    fastLane: {
      schedulerIntervalMs: fastSchedulerIntervalMs,
      sourceIntervalMs: fastSourceIntervalMs,
      sourceCount: fastTargets.length,
    },
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      scheduledRerunRequested = false;
      fastRerunRequested = false;
      if (timer) clearInterval(timer);
      if (fastTimer) clearInterval(fastTimer);
      timer = null;
      fastTimer = null;
      const inFlight = [runningPromise, scheduledDrainPromise, fastRunningPromise].filter(Boolean);
      stopPromise = Promise.allSettled(inFlight).then(() => undefined);
      return stopPromise;
    },
  };
}
