import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { isTerminalAlertSuppression, sendAlerts } from "./alerts.js";
import { extractChainSupportSignals } from "./chain-support.js";
import { isMonitoringSourceEnabled } from "./source-controls.js";

export const DEFAULT_REPOSITORIES = [
  {
    repository: "ponsdotdev/ponsfamily",
    launchpad: "pons",
    sourceTrust: "unverified_candidate",
    baselineOnly: true,
  },
  {
    repository: "ponsdotfamily/ponsdotfamily",
    launchpad: "pons",
    sourceTrust: "unverified_candidate",
    baselineOnly: true,
  },
  { repository: "Virtual-Protocol/protocol-contracts", launchpad: "Virtuals" },
  { repository: "Virtual-Protocol/virtuals-python", launchpad: "Virtuals" },
  { repository: "BankrBot/tokenized-agents", launchpad: "Bankr" },
  { repository: "BankrBot/skills", launchpad: "Bankr" },
  { repository: "flap-sh/FlapVaultExample", launchpad: "Flap", sourceTrust: "official_verified" },
  { repository: "flap-sh/flap-vault-component-template", launchpad: "Flap", sourceTrust: "official_verified" },
  { repository: "flap-sh/flap-skills", launchpad: "Flap", sourceTrust: "official_verified" },
  {
    repository: "Four-Meme/Four-Smart-Contracts",
    launchpad: "Four.meme",
    sourceTrust: "unverified_candidate",
    baselineOnly: true,
  },
  { repository: "four-meme-community/openfour-docs", launchpad: "Four.meme", sourceTrust: "official_verified" },
  { repository: "four-meme-community/four-meme-ai", launchpad: "Four.meme", sourceTrust: "official_verified" },
  {
    repository: "binance/binance-skills-hub",
    launchpad: "Binance Wallet",
    priority: true,
    sourceTrust: "official_verified",
    baselineOnly: true,
    officialEvidence: { source: "official_binance_skills", url: "https://www.binance.com/en/skills" },
  },
  {
    repository: "binance/binance-web3-connector-js",
    launchpad: "Binance Wallet",
    priority: true,
    sourceTrust: "official_verified",
    baselineOnly: true,
    officialEvidence: { source: "official_binance_github", url: "https://github.com/binance" },
  },
  ...[
    "binance/binance-web3-connector-python",
    "binance/binance-web3-connector-java",
    "binance/binance-cli",
    "binance/binance-spot-api-docs",
    "binance/binance-api-swagger",
    "binance/binance-connector-js",
    "binance/binance-connector-python",
    "binance/binance-connector-go",
  ].map((repository) => ({
    repository,
    launchpad: repository.includes("web3") ? "Binance Wallet" : "Binance",
    sourceTrust: "official_verified",
    baselineOnly: true,
    officialEvidence: { source: "official_binance_github", url: "https://github.com/binance" },
  })),
  ...[
    ["xai-org/grok-build", "xAI / Grok", true],
    ["xai-org/grok-build-plugin-cc", "xAI / Grok", false],
    ["xai-org/plugin-marketplace", "xAI / Grok", true],
    ["xai-org/xai-sdk-python", "xAI / Grok", true],
    ["xai-org/xai-proto", "xAI / Grok", false],
    ["xai-org/x-algorithm", "X", false],
    ["xai-org/grok-prompts", "xAI / Grok", false],
    ["xdevplatform/chat-xdk", "X", false],
    ["xdevplatform/xurl", "X", false],
    ["xdevplatform/xmcp", "X", false],
    ["xdevplatform/xdk", "X", true],
    ["xdevplatform/xdk-python", "X", false],
    ["xdevplatform/xdk-typescript", "X", false],
  ].map(([repository, launchpad, priority]) => ({
    repository,
    product: repository === "xai-org/x-algorithm"
      ? { id: "x", name: "X" }
      : repository.startsWith("xdevplatform/")
        ? { id: "x-api", name: "X API / Developer Platform" }
        : { id: "grok", name: "xAI / Grok" },
    launchpad,
    ...(priority ? { priority: true } : {}),
    sourceTrust: "official_verified",
    baselineOnly: true,
    xaiOfficial: true,
    officialEvidence: { source: "official_x_github_allowlist", url: `https://github.com/${repository}` },
  })),
  {
    repository: "Uniswap/liquidity-launcher",
    launchpad: "Uniswap / Pools.trade",
    priority: true,
    sourceTrust: "official_verified",
    baselineOnly: true,
    uniswapOfficial: true,
    officialEvidence: { source: "official_uniswap_github", url: "https://github.com/Uniswap/liquidity-launcher" },
  },
  {
    repository: "Uniswap/v4-hooks-public",
    launchpad: "Uniswap",
    priority: true,
    sourceTrust: "official_verified",
    baselineOnly: true,
    uniswapOfficial: true,
    officialEvidence: { source: "official_uniswap_github", url: "https://github.com/Uniswap" },
  },
  {
    repository: "Uniswap/hooklist",
    launchpad: "Uniswap",
    priority: true,
    sourceTrust: "official_verified",
    baselineOnly: true,
    uniswapOfficial: true,
    officialEvidence: { source: "official_uniswap_github", url: "https://github.com/Uniswap/hooklist" },
  },
  {
    repository: "Uniswap/protocol-fees",
    launchpad: "Uniswap",
    priority: true,
    sourceTrust: "official_verified",
    baselineOnly: true,
    uniswapOfficial: true,
    officialEvidence: { source: "official_uniswap_github", url: "https://github.com/Uniswap/protocol-fees" },
  },
  {
    repository: "Uniswap/contracts",
    launchpad: "Uniswap",
    priority: true,
    sourceTrust: "official_verified",
    baselineOnly: true,
    uniswapOfficial: true,
    officialEvidence: { source: "official_uniswap_github", url: "https://github.com/Uniswap/contracts" },
  },
  {
    repository: "Uniswap/UniswapX",
    launchpad: "UniswapX",
    priority: true,
    sourceTrust: "official_verified",
    baselineOnly: true,
    uniswapOfficial: true,
    officialEvidence: { source: "official_uniswap_github", url: "https://github.com/Uniswap/UniswapX" },
  },
  {
    repository: "Uniswap/v4-periphery",
    launchpad: "Uniswap",
    sourceTrust: "official_verified",
    baselineOnly: true,
    uniswapOfficial: true,
    officialEvidence: { source: "official_uniswap_github", url: "https://github.com/Uniswap" },
  },
  {
    repository: "Uniswap/universal-router",
    launchpad: "Uniswap",
    sourceTrust: "official_verified",
    baselineOnly: true,
    uniswapOfficial: true,
    officialEvidence: { source: "official_uniswap_github", url: "https://github.com/Uniswap" },
  },
  { repository: "hodldance/hodl-dance", launchpad: "HODL.DANCE", sourceTrust: "official_verified", baselineOnly: true },
  { repository: "moonsaleapp/moonsaleapp", launchpad: "MoonSale", sourceTrust: "official_verified", baselineOnly: true },
  { repository: "huksdotfun/bsc-contracts", launchpad: "Huks.fun", sourceTrust: "official_verified", baselineOnly: true },
  { repository: "fetchai/agent-launch-toolkit", launchpad: "Agent Launch", sourceTrust: "official_verified", baselineOnly: true },
  { repository: "Flazepad-xyz/Flazepad-Core", launchpad: "Flazepad", sourceTrust: "official_verified", baselineOnly: true },
  { repository: "karmafionbnb/karmafi", launchpad: "KarmaFi", sourceTrust: "official_verified", baselineOnly: true },
  { repository: "pqchase/rugspull", launchpad: "Rugspull", sourceTrust: "official_verified", baselineOnly: true },
  { repository: "createtokenco/bep20standardtoken", launchpad: "Create Token", sourceTrust: "official_verified", baselineOnly: true },
  { repository: "Onchain365/magic-mint-contracts", launchpad: "MagicMint", sourceTrust: "official_verified", baselineOnly: true },
  { repository: "Codeless-Dev/Codelessdev-contracts", launchpad: "CodelessDev", sourceTrust: "official_verified", baselineOnly: true },
  { repository: "xbsc-402/402bnb-contract", launchpad: "XFOUR", sourceTrust: "unverified_candidate", baselineOnly: true },
  {
    repository: "1v1me-me/foundry",
    launchpad: "1V1MEME",
    sourceTrust: "multi_source_corroborated",
    baselineOnly: true,
    officialEvidence: { source: "brand_repo_plus_exact_chain_deployments", url: "https://1v1me.me" },
  },
  {
    repository: "zhangjichao1717/bnbs-meme-token-template",
    launchpad: "BNBS Launchpad",
    sourceTrust: "multi_source_corroborated",
    baselineOnly: true,
    officialEvidence: { source: "live_site_abi_plus_brand_repo", url: "https://bnbs.meme" },
  },
  {
    repository: "bfun-ai/bfun-ai",
    launchpad: "B.Fun",
    sourceTrust: "official_verified",
    baselineOnly: true,
    officialEvidence: { source: "official_docs_and_exact_chain_addresses", url: "https://docs.b.fun/agent-skill" },
  },
];

export const PRIORITY_REPOSITORIES = new Set([
  "flap-sh/flapvaultexample",
  "flap-sh/flap-vault-component-template",
  "flap-sh/flap-skills",
  "four-meme-community/openfour-docs",
  "four-meme-community/four-meme-ai",
  "binance/binance-skills-hub",
  "binance/binance-web3-connector-js",
  "binance/binance-web3-connector-python",
  "binance/binance-web3-connector-java",
  "binance/binance-cli",
  "binance/binance-spot-api-docs",
  "binance/binance-api-swagger",
  "xai-org/grok-build",
  "xai-org/plugin-marketplace",
  "xai-org/xai-sdk-python",
  "xdevplatform/xdk",
  "uniswap/liquidity-launcher",
  "uniswap/v4-hooks-public",
  "uniswap/hooklist",
  "uniswap/protocol-fees",
  "uniswap/contracts",
  "uniswap/uniswapx",
]);

// This immutable snapshot is the explicit, high-signal fast lane. Organization
// discovery can surface dozens of related repositories, but discovering a repo
// does not by itself make it a five-second priority target.
const CORE_PRIORITY_REPOSITORIES = new Set(PRIORITY_REPOSITORIES);

// Pull requests expose new launch mechanics before they reach the default
// branch. Keep this list deliberately small so public, unauthenticated GitHub
// monitoring remains comfortably below the 60 requests/hour limit.
export const GITHUB_PULL_REQUEST_TARGETS = [
  "flap-sh/FlapVaultExample",
  "flap-sh/flap-skills",
  "four-meme-community/openfour-docs",
  "four-meme-community/four-meme-ai",
  "Uniswap/liquidity-launcher",
  "binance/binance-skills-hub",
  "binance/binance-web3-connector-js",
  "binance/binance-spot-api-docs",
];

// Neither repository is reciprocally linked by the Pons website or docs. Their
// self-description is not enough to treat reference code as an official release.
const UNVERIFIED_PONS_REPOSITORIES = new Set([
  "ponsdotdev/ponsfamily",
  "ponsdotfamily/ponsdotfamily",
]);
const UNVERIFIED_CANDIDATE_REPOSITORIES = new Set([
  ...UNVERIFIED_PONS_REPOSITORIES,
  "four-meme/four-smart-contracts",
  "xbsc-402/402bnb-contract",
]);

export function isUnverifiedPonsRepository(repository) {
  return UNVERIFIED_PONS_REPOSITORIES.has(repository?.toLowerCase());
}

export function extractGithubRepositories(value = "") {
  const repositories = [];
  const pattern = /https?:\/\/(?:www\.)?github\.com\/([a-z0-9_.-]+)\/([a-z0-9_.-]+?)(?:\.git)?(?=[\s/?#"'<>)]|$)/gi;
  for (const match of String(value).matchAll(pattern)) {
    const repository = `${match[1]}/${match[2]}`;
    if (!repositories.some((item) => item.toLowerCase() === repository.toLowerCase())) repositories.push(repository);
  }
  return repositories;
}

function sourceTrust(entry) {
  if (entry?.sourceTrust === "official_verified") return "official_verified";
  return UNVERIFIED_CANDIDATE_REPOSITORIES.has(entry?.repository?.toLowerCase())
    ? "unverified_candidate"
    : (entry?.sourceTrust || "configured_source");
}

export function isAcceptedAiGithubAlertDelivery(result) {
  if (result === undefined) return true;
  if (!result || typeof result !== "object") return false;
  const status = String(result.status || "").trim().toLowerCase();
  if (status === "suppressed") return isTerminalAlertSuppression(result);
  const reason = String(result.reason || result.disabledReason || "").trim().toLowerCase();
  if (/source[_ -]?disabled|monitoring[_ -]?source[_ -]?disabled|not[_ -]?relevant|blocked/.test(reason)) return false;
  if (["failed", "error", "rejected", "dropped"].includes(status)) return false;
  return ["queued", "delivered"].includes(status);
}

const RELEVANT = [
  /(^|\/)(contracts?|src|script|scripts|deploy|deployments|modules?|skills?|sdk|integrations?|chains?|config)(\/|$)/i,
  /(^|\/)(abi|contract-meta|addresses|chains|networks?|foundry|hardhat)[^/]*\.(json|ya?ml|toml|ts|js|sol)$/i,
  /(^|\/)SKILL\.md$/i,
  /\.(sol|vy)$/i,
];

const FOUR_MEME_CONTENT_REPOSITORIES = new Set([
  "four-meme/four-smart-contracts",
  "four-meme-community/openfour-docs",
  "four-meme-community/four-meme-ai",
]);
const FLAP_SKILLS_REPOSITORY = "flap-sh/flap-skills";
const FLAP_SKILL_FUNCTIONAL_FILE = /^[^/]+\/(?:SKILL\.md|references\/[^/]+\.md)$/i;
const FLAP_SKILL_CONTENT_FILE = /\.md$/i;

const FOUR_MEME_CONTENT_FILE = /\.(?:md|sol|vy|ts|js|json|ya?ml|toml)$/i;
const FOUR_MEME_SEMANTIC_SIGNAL = /(?:0x[a-f0-9]{40}|\bv\d+(?:\.\d+){0,3}\b|factory|contract|deploy|quote\s*token|raised?\s*token|UUSD|NVDAB|USDC|USD1|tax\s*mode|tax\s*token|TaxToken\d+|charit(?:y|able)\s+(?:donation|recipient|badge|dashboard|tax)|donation\s+(?:feature|mode|tax|recipient)|Giggle\s+Charity|Binance\s+Charity|open\s*four|subscription|campaign|fee|threshold|module|integration)/i;
const BINANCE_SKILLS_REPOSITORY = "binance/binance-skills-hub";
const BINANCE_CONNECTOR_REPOSITORY = "binance/binance-web3-connector-js";
const isOfficialBinanceRepositoryName = (repository) => String(repository || "").toLowerCase().startsWith("binance/");
const UNISWAP_OFFICIAL_REPOSITORIES = new Set([
  "uniswap/liquidity-launcher",
  "uniswap/v4-hooks-public",
  "uniswap/hooklist",
  "uniswap/protocol-fees",
  "uniswap/contracts",
  "uniswap/uniswapx",
  "uniswap/v4-periphery",
  "uniswap/universal-router",
]);
const UNISWAP_CONTENT_FILE = /(?:^|\/)(?:README|CHANGELOG|SECURITY|DEPLOYMENTS?|CONTRACTS?)\.(?:md|json)$|\.(?:md|sol|vy|ts|tsx|js|mjs|json|ya?ml|toml)$/i;
const UNISWAP_HIGH_SIGNAL = /(?:\bliquidity[ -]launcher\b|\binstant\s*launch\b|\bcrowd\s*launch\b|\blaunch(?:pad|es|er)?\b|\bbonding\s*curve\b|\bauction\b|\bnew\s+(?:hook|pool|strategy|router|reactor|factory|contract|deployment|chain|version)\b|\bdualpool\b|\bprotocol\s+fees?\b|\bfee\s+(?:switch|adapter|policy|splitter)\b|\brobinhood\b|\bchain\s*id\s*[:=]?\s*4663\b|\bmainnet\s+deploy(?:ment|ed)?\b|\bsecurity\s+(?:incident|advisory|audit|fix)\b|\bcritical\s+(?:fix|vulnerability)\b|\buniswapx\s+(?:reactor|order|deployment|version)\b|\buniversalrouterstrategy\b|\binstantlaunchstrategy\b)/i;
const UNISWAP_NOISE_ONLY = /^(?:chore|ci|docs?|test|style|format|refactor|build|deps?|dependabot)(?:\([^)]*\))?\s*[:\-]/i;
const isOfficialUniswapRepositoryName = (repository) => UNISWAP_OFFICIAL_REPOSITORIES.has(String(repository || "").toLowerCase())
  || String(repository || "").toLowerCase().startsWith("uniswap/");
const BSC_DEPLOYMENT_DOCUMENT_REPOSITORIES = new Set([
  "hodldance/hodl-dance",
  "moonsaleapp/moonsaleapp",
  "huksdotfun/bsc-contracts",
  "fetchai/agent-launch-toolkit",
  "flazepad-xyz/flazepad-core",
  "karmafionbnb/karmafi",
  "pqchase/rugspull",
  "createtokenco/bep20standardtoken",
  "onchain365/magic-mint-contracts",
  "codeless-dev/codelessdev-contracts",
  "1v1me-me/foundry",
  "zhangjichao1717/bnbs-meme-token-template",
  "bfun-ai/bfun-ai",
]);
const BINANCE_FOCUS_SKILL_PATH = /^skills\/binance-web3\/(?:meme-rush|binance-agentic-wallet|crypto-market-rank|binance-trading-signal|binance-wallet-tracker|trading-signal)(?:\/|$)|^skills\/binance\/references\/alpha\.md$/i;
const BINANCE_SKILL_SEMANTIC_SIGNAL = /(?:meme\s*rush|launchpad|bonding\s*curve|migrat(?:e|ion)|token\s*generation|\btge\b|booster|alpha|wallet|binance\s+square|\bkol\b|trade\s+sharing|smart\s+money\s+signal|copy\s+trad(?:e|ing)|signal\s+copy|multi[- ]signal|decision[- ]fusion|onchain[- ]pay|action_ref|on[- ]chain\s+anchor|agent\s*os|agent\s*native|mcp\s+server|agent(?:ic)?\s+runtime|new\s+(?:chain|network|protocol|mode|module|api)|four\.?meme|flap|anti[- ]sniper|tokenVersion)/i;
const BINANCE_CONNECTOR_FILE = /^clients\/web3-wallet\//i;
const BINANCE_REPOSITORY_CONTENT_FILE = /(?:^|\/)(?:README|CHANGELOG|SECURITY|MIGRATION|UPGRADE)\.(?:md|mdx)$|(?:^|\/)go\.mod$|\.(?:md|mdx|ts|tsx|js|mjs|py|java|go|rs|json|ya?ml|toml|proto)$/i;
const BINANCE_GITHUB_HIGH_SIGNAL = /(?:\bbreaking\s+change\b|\bdeprecat(?:e|es|ed|ion)\b|\bsunset\b|\bmandatory\s+migration\b|\bagent\s*os\b|\bagent\s*native\b|\bmcp\s+server\b|\bagent(?:ic)?\s+runtime\b|\bnew\s+(?:endpoint|stream|api|module|product|feature|chain|network|protocol|wallet|skill|connector)\b|\b(?:add|introduc(?:e|es|ed|ing)|implement(?:s|ed|ing)?|support(?:s|ed|ing)?|launch(?:es|ed|ing)?|publish(?:es|ed|ing)?|release(?:s|d|ing)?)\b[^\n]{0,100}\b(?:endpoint|websocket|api|module|wallet|alpha|square|kol|signal|copy\s+trad(?:e|ing)|meme\s+rush|agentic|agent\s*os|agent\s*native|mcp\s+server|agent\s+runtime|launchpool|security|sbe|fix)\b|\bbinance\s+square\b|\bsmart\s+money\s+(?:signal|copy)\b|\btrade\s+sharing\b|\bcopy\s+trad(?:e|ing)\b|\bsecurity\s+(?:incident|advisory|fix|update)\b|\bcritical\s+(?:fix|vulnerability)\b)/i;
const BINANCE_GITHUB_NOISE_ONLY = /^(?:chore|ci|docs?|test|style|format|refactor|build|deps?|dependabot)(?:\([^)]*\))?\s*[:\-]/i;
const AI_OFFICIAL_REPOSITORIES = new Set([
  "xai-org/grok-build",
  "xai-org/grok-build-plugin-cc",
  "xai-org/plugin-marketplace",
  "xai-org/xai-sdk-python",
  "xai-org/xai-proto",
  "xai-org/x-algorithm",
  "xai-org/grok-prompts",
  "xdevplatform/chat-xdk",
  "xdevplatform/xurl",
  "xdevplatform/xmcp",
  "xdevplatform/xdk",
  "xdevplatform/xdk-python",
  "xdevplatform/xdk-typescript",
]);
const AI_REPOSITORY_CONTENT_FILE = /(?:^|\/)(?:Dockerfile|CHANGELOG|RELEASES?|SECURITY|MIGRATION|DEPRECATIONS?|VERSION)(?:\.[^/]*)?$|\.(?:md|mdx|py|pyi|proto|ts|tsx|js|mjs|cjs|go|rs|java|kt|kts|swift|cc|cpp|cxx|h|hpp|json|jsonc|ya?ml|toml|graphql|sh)$/i;
const AI_MAINTENANCE_ONLY_FILE = /(?:^|\/)(?:tests?|testdata|mocks?|fixtures?|snapshots?|benchmarks?|coverage)(?:\/|$)|(?:^|\/)\.github(?:\/|$)|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock)$/i;
const AI_CHANGE_OBJECT = "(?:models?|products?|apis?|sdks?|endpoints?|features?|plugins?|marketplaces?|algorithms?|chat(?:bot|s|ting)?|grok|xdk)";
const AI_NEW_ACTION = "(?:add(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)?|releas(?:e|es|ed|ing)|ship(?:s|ped|ping)|publish(?:es|ed|ing)?|enabl(?:e|es|ed|ing)|support(?:s|ed|ing)?|implement(?:s|ed|ing)?|expos(?:e|es|ed|ing)|integrat(?:e|es|ed|ing)|upgrad(?:e|es|ed|ing))";
const AI_EXPLICIT_PRODUCT_CHANGE = new RegExp(`(?:\\bnew\\s+${AI_CHANGE_OBJECT}\\b|\\b${AI_NEW_ACTION}\\b[^\\n]{0,120}\\b${AI_CHANGE_OBJECT}\\b|^feat(?:\\([^)]*\\))?\\s*[:\\-][^\\n]{0,160}\\b${AI_CHANGE_OBJECT}\\b)`, "i");
const AI_BREAKING_OR_DEPRECATION = /\b(?:breaking\s+change|deprecat(?:e|es|ed|ing|ion)|sunset(?:s|ted|ting)?|mandatory\s+migration|remov(?:e|es|ed|ing)\b[^\n]{0,50}\b(?:api|sdk|endpoint|model|feature))\b/i;
const AI_IMPORTANT_SECURITY_CHANGE = /(?:\bsecurity\s+(?:incident|advisory|bulletin|update|fix)\b|\bcritical\s+(?:fix|vulnerability)\b|\bhigh[- ]severity\s+vulnerability\b|\bauth(?:entication|orization)?\s+bypass\b|\bremote\s+code\s+execution\b|\bCVE-\d{4}-\d{4,}\b|\b(?:fix|patch|resolv(?:e|es|ed|ing))\b[^\n]{0,50}\b(?:security\s+(?:flaw|issue)|vulnerability|CVE-\d{4}-\d{4,})\b)/i;
const AI_VERSION_RELEASE = /(?:\brelease\b[^\n]{0,30}\bv?\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.-]+)?\b|\bpublish(?:es|ed|ing)?\b[^\n]{0,30}\bv?\d+\.\d+(?:\.\d+)?(?:[-+][a-z0-9.-]+)?\b|^v?\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$|\bv?\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?\b[^\n]{0,60}\b(?:release|sdk|api|xdk|grok)\b)/i;
const AI_GITHUB_NOISE_ONLY = /^(?:chore|ci|docs?|test|style|format|refactor|build|deps?|dependabot|maintenance)(?:\([^)]*\))?\s*[:\-]/i;
const AI_TRIVIAL_MAINTENANCE = /\b(?:typo|spelling|grammar|whitespace|formatting|lint(?:ing)?|readme\s+(?:wording|cleanup)|comment\s+(?:cleanup|format)|snapshot\s+update|test\s+coverage|dependency\s+bump|bump\s+dependenc(?:y|ies)|routine\s+maintenance)\b/i;
const AI_IDENTIFIER_SIGNAL = /\b(?:grok[-\s]+\d+(?:\.\d+)*(?:[-\s]+(?:fast|mini|heavy|preview|beta))?|grok[-\s]+(?:bot|build|imagine|voice|code)(?:[-\s]+(?:image|video|fast|mini|preview|beta|\d+(?:\.\d+)*)){0,3}|x\s+activity\s+api|responses\s+api|batch\s+api|files\s+api|plugin\s+marketplace|api|sdk|xdk|mcp|websocket|webhook|oauth\s*2(?:\.0)?|[a-z][a-z0-9]*(?:_[a-z0-9]+){1,4})\b/gi;
const AI_OFFICIAL_GITHUB_ORGANIZATIONS = new Set(["xai-org", "xdevplatform"]);
const AI_REPOSITORY_DISCOVERY_SIGNAL = /(?:^|[^a-z0-9])(?:products?|models?|apis?|sdks?|plugins?|algorithms?|grok|xdk)(?:$|[^a-z0-9])/i;
const BINANCE_REPOSITORY_DISCOVERY_SIGNAL = /(?:^|[^a-z0-9])(?:agent\s*os|agent\s*native|agentic|mcp|skills?|wallet|web3|apis?|connectors?|trading|alpha)(?:$|[^a-z0-9])/i;
const isOfficialAiRepositoryName = (repository) => AI_OFFICIAL_REPOSITORIES.has(String(repository || "").toLowerCase());

function aiProductForRepository(repository) {
  const normalized = String(repository || "").toLowerCase();
  if (normalized === "xai-org/x-algorithm") return { id: "x", name: "X" };
  if (normalized.startsWith("xdevplatform/")) return { id: "x-api", name: "X API / Developer Platform" };
  return { id: "grok", name: "xAI / Grok" };
}

function isOfficialAiRepositoryEntry(entry) {
  if (entry?.xaiOfficial !== true) return false;
  const normalized = String(entry.repository || "").toLowerCase();
  if (isOfficialAiRepositoryName(normalized)) return true;
  const owner = normalized.split("/")[0];
  return AI_OFFICIAL_GITHUB_ORGANIZATIONS.has(owner)
    && String(entry.officialOrganization || "").toLowerCase() === owner
    && entry.sourceTrust === "official_verified"
    && entry.officialEvidence?.source === "official_x_github_organization"
    && entry.officialEvidence?.url === `https://github.com/${owner}`;
}

function aiRepositoryDiscoverySignal(repository, metadata = {}) {
  const name = String(repository || "").split("/").at(-1) || "";
  const content = [
    name.replace(/[-_.]+/g, " "),
    metadata.description,
    ...(Array.isArray(metadata.topics) ? metadata.topics : []),
  ].filter(Boolean).join("\n");
  return AI_REPOSITORY_DISCOVERY_SIGNAL.test(content);
}

function binanceRepositoryDiscoverySignal(repository, metadata = {}) {
  const name = String(repository || "").split("/").at(-1) || "";
  const content = [
    name.replace(/[-_.]+/g, " "),
    metadata.description,
    ...(Array.isArray(metadata.topics) ? metadata.topics : []),
  ].filter(Boolean).join("\n");
  return BINANCE_REPOSITORY_DISCOVERY_SIGNAL.test(content);
}

const ORGANIZATION_TARGETS = [
  { organization: "Four-Meme", launchpad: "Four.meme", sourceTrust: "unverified_candidate", baselineOnly: true },
  {
    organization: "four-meme-community",
    launchpad: "Four.meme",
    sourceTrust: "official_verified",
    baselineOnly: true,
    officialEvidence: { source: "official_site", url: "https://four.meme/en/agentic" },
  },
  {
    organization: "flap-sh",
    launchpad: "Flap",
    sourceTrust: "official_verified",
    baselineOnly: true,
    officialEvidence: { source: "official_docs", url: "https://docs.flap.sh/flap" },
  },
  {
    organization: "Uniswap",
    launchpad: "Uniswap",
    sourceTrust: "official_verified",
    baselineOnly: true,
    discoverOnly: true,
    repositoryPattern: /(?:launch|hook|pool|protocol|router|uniswapx|robinhood|governance|contract|auction|bonding|factory|continuous[-_]?clearing|uerc20|(?:^|[-_.])ai(?:$|[-_.]))|^(?:deploy|chain|network)/i,
    officialEvidence: { source: "official_uniswap_github", url: "https://github.com/Uniswap" },
  },
  {
    organization: "binance",
    launchpad: "Binance",
    sourceTrust: "official_verified",
    baselineOnly: true,
    discoverOnly: true,
    repositoryPattern: /(?:skills|web3|wallet|spot-api|api-swagger|connector|cli|announcement|trading|alpha|agent)/i,
    officialEvidence: { source: "official_binance_github", url: "https://github.com/binance" },
  },
  {
    organization: "xai-org",
    launchpad: "xAI / Grok",
    sourceTrust: "official_verified",
    baselineOnly: true,
    xaiOfficial: true,
    officialEvidence: { source: "official_x_github_organization", url: "https://github.com/xai-org" },
  },
  {
    organization: "xdevplatform",
    launchpad: "X",
    sourceTrust: "official_verified",
    baselineOnly: true,
    xaiOfficial: true,
    officialEvidence: { source: "official_x_github_organization", url: "https://github.com/xdevplatform" },
  },
];
const INITIAL_CATCHUP_MAX_COMMITS = 8;
const INITIAL_CATCHUP_MS = 7 * 24 * 60 * 60 * 1_000;
const PRIORITY_POLL_CONCURRENCY = 4;
const GITHUB_GAP_RECOVERY_MAX_PAGES = 10;
const GITHUB_GAP_COMPACT_EVIDENCE_SCHEMA_VERSION = 1;
const GITHUB_GAP_SELECTED_FACT_LIMIT = 2;
const GITHUB_HEALTH_SCHEMA_VERSION = 1;
const GITHUB_PULL_REQUEST_SCHEMA_VERSION = 1;
const GITHUB_PUBLIC_PR_MIN_INTERVAL_MS = 10 * 60_000;
const GITHUB_TOKEN_PR_MIN_INTERVAL_MS = 60_000;
const GITHUB_DYNAMIC_POLL_MIN_INTERVAL_MS = 60_000;
const GITHUB_DYNAMIC_POLL_MAX_INTERVAL_MS = 10 * 60_000;
const GITHUB_DYNAMIC_POLL_DEFAULT_INTERVAL_MS = 5 * 60_000;
const GITHUB_ORGANIZATION_MIN_INTERVAL_MS = 60_000;
const GITHUB_ORGANIZATION_MAX_INTERVAL_MS = 10 * 60_000;
const GITHUB_REPOSITORY_SCHEDULER_MIN_INTERVAL_MS = 60_000;
const GITHUB_PRIORITY_PHASE_OFFSET_MS = 30_000;
const GITHUB_REST_CIRCUIT_DEFAULT_MS = 60 * 60_000;
const GITHUB_REST_CIRCUITS = new WeakMap();

const GITHUB_CHANGE_OBJECT = "(?:factory|launcher|launchpad|module|plugin|bonding[ -]?curve|graduation|migration|pool|hook|router|reactor|strategy|vault|portal|deployer|adapter|policy|integration|auction|presale|fair[ -]?launch|subscription|quote[ -]?token|tax[ -]?(?:mode|token)|TaxToken\\d+|charity[ -]?(?:donation|badge|dashboard|tax)|donation[ -]?(?:feature|mode|tax)|open[ -]?four|proxy|version|v[2-9])";
const GITHUB_NEW_ACTION = "(?:add(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|launch(?:es|ed|ing)?|deploy(?:s|ed|ing)?|releas(?:e|es|ed|ing)|enabl(?:e|es|ed|ing)|support(?:s|ed|ing)?|implement(?:s|ed|ing)?|creat(?:e|es|ed|ing)|ship(?:s|ped|ping)|upgrad(?:e|es|ed|ing))";
const EXPLICIT_NEW_MODE_SIGNAL = new RegExp(`(?:\\bnew\\s+${GITHUB_CHANGE_OBJECT}\\b|\\b${GITHUB_NEW_ACTION}\\b[^\\n]{0,80}\\b${GITHUB_CHANGE_OBJECT}\\b|^feat(?:\\([^)]*\\))?\\s*[:\\-]?\\s*[^\\n]{0,80}\\b${GITHUB_CHANGE_OBJECT}\\b)`, "i");
const GITHUB_NON_NEW_PREFIX = /^(?:revert|fix(?:es|ed)?|bugfix|hotfix|test(?:s|ed|ing)?|chore|docs?|ci|style|format|refactor|perf|build|deps?|dependabot|remove(?:s|d)?|delet(?:e|es|ed|ing)|deprecat(?:e|es|ed|ing|ion))(?:\([^)]*\))?(?:\s*[:\-]|\s+)\s*/i;
const GITHUB_TEST_OR_DOC_ADDITION = /^(?:feat(?:\([^)]*\))?\s*[:\-]\s*)?add(?:s|ed|ing)?\s+(?:(?:unit|integration|e2e)\s+)?(?:tests?|docs?|documentation|readme)\b/i;
const GITHUB_NON_PRODUCTION_FILE = /(?:^|\/)(?:tests?|mocks?|fixtures?)(?:\/|$)|(?:^|\/)[^/]+\.(?:t|test|spec)\.(?:sol|vy|ts|tsx|js|mjs)$/i;
const GITHUB_PR_TRIVIAL_NOISE = /(?:\b(?:broken|remote|external)\s+(?:image|img|link|url)\b|\b(?:image|badge|svg|png|screenshot)\b[^\n]{0,40}\b(?:fix|security|sanitize|replace|update)\b|\b(?:typo|spelling|grammar|whitespace|formatting|lint|snapshot|regression\s+test|dependency\s+bump)\b)/i;
const GITHUB_PR_STRUCTURAL_SIGNAL = /(?:\b(?:VaultBaseV[2-9]|FreeCoinV[2-9]Beacon|factorySpecVersion|vaultQuoteToken|isQuoteTokenSupported|TaxToken\d+)\b|\b(?:ERC-?20|custom|multiple?)\s+quote\s+(?:token|vault)\b|\bquote[- ]agnostic\s+(?:vault|factory|launch)\b|\bcharity\s+(?:donation|badge|dashboard|tax)\b|\b(?:add|introduc(?:e|es|ed|ing)|implement(?:s|ed|ing)?|support(?:s|ed|ing)?|launch(?:es|ed|ing)?|deploy(?:s|ed|ing)?|ship(?:s|ped|ping))\b[^\n]{0,100}\b(?:factory|launcher|launchpad|module|bonding[ -]?curve|graduation|migration|pool|hook|router|reactor|strategy|vault|deployer|adapter|policy|auction|presale|fair[ -]?launch|subscription|campaign|quote[ -]?token|tax[ -]?(?:mode|token)|charity\s+(?:donation|badge|dashboard|tax)|donation\s+(?:feature|mode|tax)|open[ -]?four|v[2-9])\b)/i;
const GITHUB_FOCUS3_CHAIN_REPOSITORY = /^(?:flap-sh|four-meme-community|uniswap)\//i;
const GITHUB_CHAIN_SUPPORT_NOISE_FILE = /(?:^|\/)(?:README(?:\.[^/]*)?|CHANGELOG|LICENSE|SECURITY)\.md$|(?:^|\/)(?:package-lock\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|Cargo\.lock|foundry\.lock)$|\.(?:md|mdx|png|jpe?g|gif|webp|svg|ico|lock)$/i;
const GITHUB_CHAIN_SUPPORT_STRUCTURAL_FILE = /(?:^|\/)(?:chains?|networks?|deploy(?:ments?)?|scripts?|config|addresses?|contracts?)(?:\/|[._-]|$)|(?:^|\/)(?:hardhat|foundry|truffle|wagmi|viem)[^/]*\.(?:json|ya?ml|toml|ts|tsx|js|mjs|cjs)$|\.(?:sol|vy|s\.sol)$/i;
const GITHUB_CHAIN_SUPPORT_PATH_CONTEXT = /(?:^|\/)(?:chains?|networks?|deploy(?:ments?)?|scripts?|config|addresses?)(?:\/|[._-]|$)|(?:^|\/)(?:hardhat|foundry|truffle|wagmi|viem)[^/]*\.(?:json|ya?ml|toml|ts|tsx|js|mjs|cjs)$/i;
const GITHUB_CHAIN_SUPPORT_HEADLINE = /\b(?:support(?:s|ed|ing)?|deploy(?:s|ed|ing)?|expand(?:s|ed|ing)?|port(?:s|ed|ing)?)\b|\b(?:add(?:s|ed|ing)?|introduc(?:e|es|ed|ing)|enable(?:s|d|ing)?)\b[^\n]{0,100}\b(?:chain|network|mainnet|testnet|sepolia|amoy|fuji|support|deployment|multi[- ]chain|cross[- ]chain)\b|\b(?:chain|network|mainnet|testnet)\b[^\n]{0,100}\b(?:support|deployment|integration)\b/i;
const GITHUB_CHAIN_METADATA_NOISE_LINE = /^\s*["']?(?:_[a-z0-9]+|mined(?:at|for|zerobytes)|schemaversion)["']?\s*[:=]/i;
const GITHUB_TRANSPORT_FAILURE = /(?:fetch failed|network|timed?\s*out|timeout|aborted|EADDRNOTAVAIL|ECONN[A-Z]*|ENETUNREACH|EHOSTUNREACH|socket\s+hang\s+up)/i;
const GITHUB_TRANSPORT_RETRY_MAX_MS = 60_000;
const GITHUB_FOCUS3_OFFICIAL_REPOSITORY = /^(?:flap-sh|four-meme-community|uniswap)\//i;

function boundedInterval(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(parsed) && parsed > 0 ? parsed : fallback));
}

function isOrganizationDynamicRepository(entry) {
  return entry?.pollingClass === "organization_dynamic";
}

function organizationTargetFor(organization) {
  const normalized = String(organization || "").toLowerCase();
  return ORGANIZATION_TARGETS.find((target) => target.organization.toLowerCase() === normalized) || null;
}

function repositoryMatchesOrganizationTarget(repository, target) {
  if (!target?.discoverOnly || !target.repositoryPattern) return true;
  const name = String(repository || "").split("/").at(-1) || "";
  target.repositoryPattern.lastIndex = 0;
  const matches = target.repositoryPattern.test(name);
  target.repositoryPattern.lastIndex = 0;
  return matches;
}

function successfulOrganizationSnapshot(organizations, organization) {
  if (!organizations || !organization) return null;
  const normalized = String(organization).toLowerCase();
  const snapshot = organizations[organization]
    || Object.entries(organizations).find(([name]) => name.toLowerCase() === normalized)?.[1];
  return snapshot?.lastSuccessAt && Array.isArray(snapshot.repositories) ? snapshot : null;
}

function organizationSnapshotAdmission(organizations, repository, entry) {
  if (!isOrganizationDynamicRepository(entry) || !entry.officialOrganization) return null;
  const target = organizationTargetFor(entry.officialOrganization);
  const snapshot = successfulOrganizationSnapshot(organizations, target?.organization || entry.officialOrganization);
  if (!target || !snapshot) return null;
  const normalized = String(repository || entry.repository || "").toLowerCase();
  const listed = snapshot.repositories.some((candidate) => String(candidate).toLowerCase() === normalized);
  const matchesDiscoveryFilter = repositoryMatchesOrganizationTarget(repository || entry.repository, target);
  return {
    active: listed && matchesDiscoveryFilter,
    inactiveReason: listed ? "organization_discovery_filter" : "organization_repository_absent",
    snapshotAt: snapshot.lastSuccessAt,
  };
}

function isGithubTransportFailure(value) {
  const status = Number(value?.status ?? value?.lastErrorStatus);
  if ([403, 429].includes(status)) return false;
  const message = [value?.message, value?.lastError, value?.code, value?.cause?.code, value?.cause?.message]
    .filter(Boolean).join(" ");
  return GITHUB_TRANSPORT_FAILURE.test(message);
}

function responseRetryAfterMs(response, currentTime = Date.now()) {
  const retryAfter = response.headers?.get?.("retry-after");
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
    const timestamp = Date.parse(retryAfter);
    if (Number.isFinite(timestamp)) return Math.max(0, timestamp - currentTime);
  }
  const rateLimitReset = Number(response.headers?.get?.("x-ratelimit-reset"));
  return Number.isFinite(rateLimitReset) && rateLimitReset > 0
    ? Math.max(0, rateLimitReset * 1_000 - currentTime)
    : null;
}

function requestTimeoutMs(config) {
  return Math.max(1_000, Number(config?.githubRequestTimeoutMs) || 8_000);
}

function githubRestCircuit(config) {
  let circuit = GITHUB_REST_CIRCUITS.get(config);
  if (!circuit) {
    circuit = { blockedUntil: 0, status: null };
    GITHUB_REST_CIRCUITS.set(config, circuit);
  }
  return circuit;
}

function githubRestCircuitError(pathname, circuit, currentTime) {
  const retryAfterMs = Math.max(1_000, circuit.blockedUntil - currentTime);
  const error = new Error(`GitHub REST circuit is open for ${pathname}`);
  error.name = "GithubRestCircuitOpenError";
  error.code = "GITHUB_REST_CIRCUIT_OPEN";
  error.status = circuit.status || 429;
  error.retryAfterMs = retryAfterMs;
  return error;
}

async function githubRestFetch(config, pathname, { headers, withoutToken = false } = {}) {
  const circuit = githubRestCircuit(config);
  const currentTime = Date.now();
  if (circuit.blockedUntil > currentTime) throw githubRestCircuitError(pathname, circuit, currentTime);
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs(config)),
  });
  const authenticated = Boolean(config.githubToken && !withoutToken);
  if (!authenticated && [403, 429].includes(response.status)) {
    const responseDelay = responseRetryAfterMs(response, currentTime);
    const delay = Number.isFinite(responseDelay) && responseDelay > 0
      ? responseDelay
      : GITHUB_REST_CIRCUIT_DEFAULT_MS;
    circuit.blockedUntil = Math.max(circuit.blockedUntil, currentTime + delay);
    circuit.status = response.status;
  }
  return response;
}

async function github(config, pathname, { withoutToken = false } = {}) {
  const headers = { accept: "application/vnd.github+json", "user-agent": "robinhood-launchpad-monitor" };
  if (config.githubToken && !withoutToken) headers.authorization = `Bearer ${config.githubToken}`;
  const response = await githubRestFetch(config, pathname, { headers, withoutToken });
  if (!response.ok) {
    const error = new Error(`GitHub ${pathname} returned HTTP ${response.status}`);
    error.status = response.status;
    const circuit = githubRestCircuit(config);
    error.retryAfterMs = circuit.blockedUntil > Date.now()
      ? circuit.blockedUntil - Date.now()
      : responseRetryAfterMs(response);
    throw error;
  }
  return response.json();
}

async function githubCommitPage(config, repository, page = 1, { etag = null, withoutToken = false } = {}) {
  const encoded = repository.split("/").map(encodeURIComponent).join("/");
  const pathname = `/repos/${encoded}/commits?per_page=100&page=${page}`;
  const headers = { accept: "application/vnd.github+json", "user-agent": "robinhood-launchpad-monitor" };
  if (config.githubToken && !withoutToken) headers.authorization = `Bearer ${config.githubToken}`;
  if (etag) headers["if-none-match"] = etag;
  const response = await githubRestFetch(config, pathname, { headers, withoutToken });
  if (response.status === 304) {
    return {
      commits: [],
      commitApi: {
        etag: response.headers?.get?.("etag") || etag,
        notModified: true,
      },
    };
  }
  if (!response.ok) {
    const error = new Error(`GitHub ${pathname} returned HTTP ${response.status}`);
    error.status = response.status;
    const circuit = githubRestCircuit(config);
    error.retryAfterMs = circuit.blockedUntil > Date.now()
      ? circuit.blockedUntil - Date.now()
      : responseRetryAfterMs(response);
    throw error;
  }
  const commits = await response.json();
  if (!Array.isArray(commits)) throw new Error(`GitHub ${pathname} returned an invalid commit list`);
  return {
    commits,
    commitApi: {
      etag: response.headers?.get?.("etag") || null,
      notModified: false,
    },
  };
}

const decodeXml = (value = "") => value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function publicText(url, config) {
  const response = await fetch(url, {
    headers: { "user-agent": "robinhood-launchpad-monitor" },
    signal: AbortSignal.timeout(requestTimeoutMs(config)),
  });
  if (!response.ok) {
    const error = new Error(`${url} returned HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfterMs = responseRetryAfterMs(response);
    throw error;
  }
  return response.text();
}

async function githubAtom(config, repository, branch, { etag = null } = {}) {
  const url = `https://github.com/${repository}/commits/${branch}.atom`;
  const headers = { "user-agent": "robinhood-launchpad-monitor" };
  if (etag) headers["if-none-match"] = etag;
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(requestTimeoutMs(config)),
  });
  if (response.status === 304) {
    return {
      commits: [],
      atom: {
        branch,
        etag: response.headers?.get?.("etag") || etag,
        notModified: true,
      },
    };
  }
  if (!response.ok) {
    const error = new Error(`${url} returned HTTP ${response.status}`);
    error.status = response.status;
    error.retryAfterMs = responseRetryAfterMs(response);
    throw error;
  }
  return {
    commits: parseGithubAtom(await response.text()),
    atom: {
      branch,
      etag: response.headers?.get?.("etag") || null,
      notModified: false,
    },
  };
}

export function parseGithubAtom(xml) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => {
    const entry = match[1];
    const sha = entry.match(/<id>tag:github\.com,2008:Grit::Commit\/(?:\d+:)?([a-f0-9]+)<\/id>/i)?.[1];
    const url = entry.match(/<link[^>]+href="([^"]+)"/)?.[1];
    const title = decodeXml(entry.match(/<title[^>]*>([\s\S]*?)<\/title>/)?.[1]?.trim());
    const author = decodeXml(entry.match(/<author>[\s\S]*?<name>([\s\S]*?)<\/name>/)?.[1]?.trim());
    const committedAt = entry.match(/<(?:updated|published)>([^<]+)<\/(?:updated|published)>/i)?.[1] || null;
    return sha ? {
      sha,
      html_url: url || null,
      commit: {
        message: title || "GitHub commit",
        author: { name: author || "unknown", date: committedAt },
        committer: { date: committedAt },
      },
      atomFallback: true,
    } : null;
  }).filter(Boolean);
}

export function parseGithubPatchFiles(patch) {
  return String(patch || "").split(/^diff --git /m).slice(1).map((block) => {
    const filename = block.match(/^a\/(.*?) b\/(.*?)$/m)?.[2];
    if (!filename) return null;
    const patchLimit = 20_000;
    const patchText = block.slice(0, patchLimit);
    let additions = 0;
    let deletions = 0;
    for (const line of block.split("\n")) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions += 1;
      if (line.startsWith("-") && !line.startsWith("---")) deletions += 1;
    }
    return {
      filename,
      status: /\nnew file mode /.test(`\n${block}`) ? "added" : /\ndeleted file mode /.test(`\n${block}`) ? "removed" : "modified",
      additions,
      deletions,
      patch: patchText,
      patchComplete: block.length <= patchLimit,
      ...(block.length > patchLimit ? { patchTruncated: true } : {}),
    };
  }).filter(Boolean);
}

export function parseGithubPatchMessage(patch) {
  const source = String(patch || "").replace(/\r\n/g, "\n");
  const subject = source.match(/^Subject:\s*(?:\[PATCH[^\]]*\]\s*)?(.+)$/m)?.[1]?.trim() || "";
  const headerEnd = source.indexOf("\n\n");
  const divider = headerEnd >= 0 ? source.indexOf("\n---\n", headerEnd + 2) : -1;
  const body = headerEnd >= 0 && divider > headerEnd
    ? source.slice(headerEnd + 2, divider).trim()
    : "";
  return [subject, body].filter(Boolean).join("\n\n");
}

const CHANGE_EVIDENCE_SUBJECT = /(?:vault|quote|royalt|fee|tax|factory|router|hook|pool|chain|network|module|strategy|template|mode|version|subscription|migration|graduation|launch)/i;
const CHANGE_EVIDENCE_SECRET = /(?:private|secret|password|api.?key|auth|credential|mnemonic)/i;
const GITHUB_CODE_FILE = /\.(?:c|cc|cpp|cxx|cs|go|h|hpp|java|js|jsx|kt|kts|mjs|cjs|php|py|pyi|rb|rs|sol|swift|ts|tsx|vy)$/i;
const GITHUB_DOC_FILE = /(?:^|\/)(?:docs?|documentation)(?:\/|$)|\.(?:md|mdx|rst|adoc)$/i;
const GITHUB_CONFIG_FILE = /(?:^|\/)(?:config|configs|deploy|deployments|chains?|networks?)(?:\/|$)|\.(?:json|jsonc|ya?ml|toml|ini)$/i;
const GITHUB_DEPENDENCY_FILE = /(?:^|\/)(?:go\.mod|package\.json|pyproject\.toml|requirements(?:-[^/]+)?\.txt|Cargo\.toml|pom\.xml|build\.gradle(?:\.kts)?)$/i;
const GITHUB_LOW_VALUE_FILE = /(?:^|\/)(?:tests?|testdata|mocks?|fixtures?|snapshots?|__snapshots__|benchmarks?|coverage|generated|vendor)(?:\/|$)|(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.ya?ml|yarn\.lock|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|Cargo\.lock)$/i;

function githubFileProfile(filename) {
  const value = String(filename || "");
  const basename = path.posix.basename(value);
  if (GITHUB_LOW_VALUE_FILE.test(value)) return { scope: "test_or_generated", rank: 5 };
  if (/^SKILL\.md$/i.test(basename)) return { scope: "skill_manifest", rank: 105 };
  if (/(?:^|\/)(?:script|scripts|deploy|deployments)(?:\/|$)/i.test(value)) return { scope: "tooling", rank: 55 };
  if (/(?:^|\/)(?:interfaces?|api|apis|schema|schemas|models?|dto)(?:\/|$)/i.test(value) && GITHUB_CODE_FILE.test(value)) {
    return { scope: "api", rank: 100 };
  }
  if (/(?:^|\/)(?:src|contracts?|programs?|sdk|clients?|packages?)(?:\/|$)/i.test(value) && GITHUB_CODE_FILE.test(value)) {
    return { scope: "production", rank: 90 };
  }
  if (GITHUB_DEPENDENCY_FILE.test(value)) return { scope: "dependency", rank: 65 };
  if (GITHUB_CONFIG_FILE.test(value)) return { scope: "config", rank: 60 };
  if (GITHUB_CODE_FILE.test(value)) return { scope: "code", rank: 75 };
  if (GITHUB_DOC_FILE.test(value) || /(?:^|\/)(?:README|CHANGELOG|SECURITY|MIGRATION|UPGRADE)\.[^/]+$/i.test(value)) {
    return { scope: "documentation", rank: 50 };
  }
  return { scope: "metadata", rank: 25 };
}

function safePatchText(value, maximum = 140) {
  let text = String(value || "").replace(/\s+/g, " ").trim().replace(/[,;]\s*$/, "");
  if (!text || CHANGE_EVIDENCE_SECRET.test(text.split(/[:=]/, 1)[0] || "")) return null;
  text = text.replace(/0x[a-fA-F0-9]{40,64}/g, (hex) => hex.length === 42
    ? hex
    : `${hex.slice(0, 10)}…${hex.slice(-8)}`);
  if (text.length > maximum) text = `${text.slice(0, maximum - 1).trimEnd()}…`;
  return text;
}

function safePatchScalar(value) {
  let scalar = String(value || "").replace(/\s+(?:\/\/|#).*$/, "").replace(/[,;]\s*$/, "").trim();
  if ((scalar.startsWith('"') && scalar.endsWith('"')) || (scalar.startsWith("'") && scalar.endsWith("'"))) scalar = scalar.slice(1, -1).trim();
  if (!scalar || scalar.length > 60 || /https?:\/\//i.test(scalar) || /\s{2,}/.test(scalar)) return null;
  if (/^0x[a-fA-F0-9]{40}$/.test(scalar)) return scalar;
  if (/^(?:true|false|null|undefined|-?\d+(?:\.\d+)?|v?\d+(?:\.\d+){0,3}|[A-Za-z_$@][A-Za-z0-9_.$@/() -]{0,58})$/.test(scalar)) return scalar;
  return null;
}

function patchAssignment(line) {
  const source = line.replace(/^[+-]\s*/, "").trim();
  const property = source.match(/^(?:["']([^"']+)["']|([A-Za-z_$][\w$.-]*))\s*:\s*(.+)$/);
  const assignment = source.match(/^(?:(?:export\s+)?(?:const|let|var)\s+)?([A-Za-z_$][\w$.-]*)\s*=\s*(.+)$/);
  const match = property || assignment;
  if (!match) return null;
  const subject = property ? (match[1] || match[2]) : match[1];
  const rawValue = property ? match[3] : match[2];
  if (CHANGE_EVIDENCE_SECRET.test(subject)) return null;
  const value = safePatchScalar(rawValue);
  const expression = value || safePatchText(rawValue, 100);
  if (!expression || /^[{[]$/.test(expression)) return null;
  return { subject, value: expression };
}

function dependencyFacts(filename, patch) {
  if (!GITHUB_DEPENDENCY_FILE.test(filename)) return [];
  const removed = new Map();
  const added = new Map();
  for (const line of String(patch || "").split("\n")) {
    const prefix = line[0];
    if (!/[+-]/.test(prefix) || line.startsWith("+++") || line.startsWith("---")) continue;
    const source = line.slice(1).trim().replace(/,$/, "");
    let match = source.match(/^([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\s+(v\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?)$/i);
    if (!match) match = source.match(/^["']([^"']+)["']\s*:\s*["'~^<>= ]*(v?\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?)["']$/i);
    if (!match) match = source.match(/^([A-Za-z0-9_.-]+)\s*(?:==|~=|>=|=)\s*(v?\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?)$/i);
    if (!match || /^version$/i.test(match[1]) || CHANGE_EVIDENCE_SECRET.test(match[1])) continue;
    (prefix === "+" ? added : removed).set(match[1], match[2]);
  }
  return [...added].flatMap(([subject, after]) => {
    const before = removed.get(subject) ?? null;
    return before === after ? [] : [{ file: filename, kind: "dependency_version", subject, before, after }];
  });
}

function codeDeclaration(line, filename) {
  if (!GITHUB_CODE_FILE.test(filename)) return null;
  const source = line.replace(/^[+-]\s*/, "").trim();
  let match = source.match(/^(?:(?:export|public|private|internal|external|abstract|async|default|final|sealed)\s+)*(contract|interface|class|library)\s+([A-Za-z_$][\w$]*)(?=\s*(?:\{|is\b|extends\b|implements\b|$))/i);
  if (match) return { kind: match[1].toLowerCase() === "library" ? "class" : match[1].toLowerCase(), subject: match[2], signature: safePatchText(source, 120) };
  match = source.match(/^(?:(?:export|public|private|internal|external|async|default|virtual|override|static)\s+)*function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)/i);
  if (match) return { kind: "function", subject: match[1], signature: safePatchText(match[0], 120) };
  match = source.match(/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)/);
  if (match) return { kind: "function", subject: match[1], signature: safePatchText(match[0], 120) };
  match = source.match(/^def\s+([A-Za-z_][\w]*)\s*\([^)]*\)/);
  if (match) return { kind: "function", subject: match[1], signature: safePatchText(match[0], 120) };
  match = source.match(/^func\s+(?:\([^)]*\)\s*)?([A-Za-z_][\w]*)\s*\([^)]*\)/);
  if (match) return { kind: "function", subject: match[1], signature: safePatchText(match[0], 120) };
  return null;
}

function patchListItem(line) {
  const match = line.match(/^[+-]\s*["']([^"'\n]{1,160})["']\s*,?\s*$/);
  if (!match || CHANGE_EVIDENCE_SECRET.test(match[1])) return null;
  return safePatchText(match[1], 120);
}

function patchDocumentationItem(line) {
  const source = line.replace(/^[+-]\s*/, "").trim();
  const match = source.match(/^(?:#{1,5}\s+|[-*]\s+|\|\s*|`)(.{2,180}?)(?:`|\s*\|)?$/);
  return match ? safePatchText(match[1], 120) : null;
}

function evidenceKey(item) {
  return `${item.kind}:${item.file}:${item.subject}:${item.before ?? ""}:${item.after ?? ""}:${item.action ?? ""}`;
}

function evidenceRank(item, order = 0) {
  const file = githubFileProfile(item.file);
  const kind = {
    response_schema: 35,
    api_call_signature: 34,
    contract: 33,
    interface: 33,
    class: 31,
    function: 30,
    config_value: 28,
    dependency_version: 27,
    code_assignment: 26,
    list_item: 24,
    documentation_item: 22,
    code_line: 15,
    file_change: 10,
  }[item.kind] || 0;
  const configPriority = file.scope === "config" && item.kind === "config_value" ? 20 : 0;
  const manifestPriority = file.scope === "skill_manifest"
    ? (item.kind === "documentation_item" ? 70 : item.kind === "file_change" ? 50 : 0)
    : 0;
  const apiFunctionPriority = file.scope === "api" && item.kind === "function" ? 10 : 0;
  const exactLinePriority = item.kind === "code_line" && item.before != null && item.after != null ? 20 : 0;
  return (file.rank * 100) + kind + configPriority + manifestPriority + apiFunctionPriority + exactLinePriority - (order / 10_000);
}

function skillManifestFact(filename, patch, context = {}) {
  if (!/^SKILL\.md$/i.test(path.posix.basename(filename))) return null;
  const slug = path.posix.basename(path.posix.dirname(filename));
  const addedRaw = String(patch || "").split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1));
  const added = addedRaw.map((line) => line.trim());
  const descriptionIndex = added.findIndex((line) => /^description\s*:/i.test(line));
  const inlineDescription = descriptionIndex >= 0
    ? added[descriptionIndex].match(/^description\s*:\s*["']?(.+?)["']?\s*$/i)?.[1]
    : null;
  const blockLines = [];
  if (descriptionIndex >= 0 && /^[|>]$/.test(String(inlineDescription || "").trim())) {
    for (const raw of addedRaw.slice(descriptionIndex + 1)) {
      if (!raw.trim()) continue;
      if (!/^\s+/.test(raw) || /^\s*[A-Za-z_$][\w$.-]*\s*:/.test(raw) && !/^\s{2,}/.test(raw)) break;
      blockLines.push(raw.trim());
      if (blockLines.join(" ").length >= 600) break;
    }
  }
  const description = blockLines.length ? blockLines.join(" ") : inlineDescription;
  const anchorClause = String(description || "").match(/checks?\s+(?:it\s+)?against\s+an?\s+on[- ]chain\s+anchor[^.]{0,80}/i)?.[0];
  const actionReferenceLead = String(description || "").match(/^(.{0,90}?\baction_ref\b)/i)?.[1];
  const focusedDescription = anchorClause && actionReferenceLead
    ? `${actionReferenceLead}; ${anchorClause}`
    : description;
  const heading = added.map((line) => line.match(/^#{1,4}\s+(.+)$/)?.[1]).find(Boolean);
  const title = String(context?.commitMessage || "").split("\n")[0]
    .replace(/^(?:feat|fix|docs?|chore)(?:\([^)]*\))?\s*[:\-]\s*/i, "")
    .replace(/^add\s+/i, "")
    .trim();
  const detail = safePatchText(focusedDescription || title || heading || slug, 140);
  return detail ? {
    file: filename,
    kind: "documentation_item",
    subject: `skill:${slug}`,
    after: detail,
    action: "added",
  } : null;
}

function comparableCodeLine(line, filename) {
  const source = String(line || "").trim();
  if (!source || patchAssignment(`+${source}`) || codeDeclaration(`+${source}`, filename)) return null;
  if (/^(?:[{}()[\],;]|\/\/|\/\*|\*|import\b|package\b|pragma\b|using\b|break\b|continue\b)/.test(source)) return null;
  return safePatchText(source, 120);
}

function changedCodeLineFact(filename, patch) {
  if (!GITHUB_CODE_FILE.test(filename)) return null;
  const patchLines = String(patch || "").split("\n");
  const addedFunctionNames = new Set(patchLines
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => codeDeclaration(line, filename))
    .filter((declaration) => declaration?.kind === "function")
    .map((declaration) => declaration.subject));
  const removed = patchLines
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .map((line) => comparableCodeLine(line.slice(1), filename)).filter(Boolean);
  const added = patchLines
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => comparableCodeLine(line.slice(1), filename)).filter(Boolean);
  for (const before of removed) {
    const prefix = before.match(/^[A-Za-z_$][\w$]*/)?.[0]?.toLowerCase();
    const scored = added.map((candidate) => {
      const candidatePrefix = candidate.match(/^[A-Za-z_$][\w$]*/)?.[0]?.toLowerCase();
      const oldTokens = new Set(before.toLowerCase().match(/[a-z_$][\w$]*/g) || []);
      const newTokens = new Set(candidate.toLowerCase().match(/[a-z_$][\w$]*/g) || []);
      const overlap = [...oldTokens].filter((token) => newTokens.has(token)).length;
      const invokedAddedFunction = [...addedFunctionNames]
        .find((name) => new RegExp(`\\b${name}\\s*\\(`).test(candidate)) || null;
      const score = (invokedAddedFunction ? 100 : 0)
        + (prefix && prefix === candidatePrefix ? 10 : 0)
        + overlap
        + (overlap / Math.max(oldTokens.size, newTokens.size, 1));
      return { candidate, invokedAddedFunction, score };
    }).filter(({ score }) => score >= 2).sort((left, right) => right.score - left.score);
    const selected = scored[0] || null;
    let after = selected?.candidate || null;
    if (after && selected.invokedAddedFunction) {
      const declarationIndex = patchLines.findIndex((line) => line.startsWith("+")
        && codeDeclaration(line, filename)?.subject === selected.invokedAddedFunction);
      const implementation = declarationIndex >= 0
        ? patchLines.slice(declarationIndex + 1, declarationIndex + 12)
          .find((line) => /^\+\s*return\b/.test(line))
        : null;
      if (implementation) after = safePatchText(`${after} via ${implementation.slice(1).trim()}`, 140);
    }
    if (after && before !== after) {
      return { file: filename, kind: "code_line", subject: path.posix.basename(filename), before, after };
    }
  }
  return null;
}

function extractGenericGithubChangeEvidence(files = [], context = {}) {
  const collected = [];
  let order = 0;
  const add = (item) => {
    if (!item || CHANGE_EVIDENCE_SECRET.test(String(item.subject || ""))) return;
    collected.push({ item, order: order += 1 });
  };
  for (const file of files) {
    const filename = String(file.filename || "");
    const fileFactStart = collected.length;
    const profile = githubFileProfile(filename);
    const patch = String(file.patch || "");
    const oldValues = new Map();
    const newValues = new Map();
    const oldDeclarations = new Map();
    const newDeclarations = new Map();
    const removedList = [];
    const addedList = [];
    const meaningfulCodeLines = [];
    for (const item of dependencyFacts(filename, patch)) add(item);
    if (file.status === "added") add(skillManifestFact(filename, patch, context));
    for (const line of patch.split("\n")) {
      if (!/^[+-]/.test(line) || /^\+\+\+|^---/.test(line)) continue;
      const assignment = patchAssignment(line);
      if (assignment) (line.startsWith("+") ? newValues : oldValues).set(assignment.subject, assignment.value);
      const declaration = codeDeclaration(line, filename);
      if (declaration) (line.startsWith("+") ? newDeclarations : oldDeclarations).set(`${declaration.kind}:${declaration.subject}`, declaration);
      const listItem = patchListItem(line);
      if (listItem) (line.startsWith("+") ? addedList : removedList).push(listItem);
      if (line.startsWith("+") && GITHUB_CODE_FILE.test(filename)) {
        const source = line.slice(1).trim();
        if (source && !/^(?:[{}()[\],;]|\/\/|\/\*|\*|import\b|package\b|pragma\b|using\b|return\b|throw\b|break\b|continue\b)/.test(source)) meaningfulCodeLines.push(source);
      }
    }
    for (const [key, declaration] of newDeclarations) {
      const previous = oldDeclarations.get(key);
      if (previous && previous.signature !== declaration.signature) {
        add({ file: filename, kind: "api_call_signature", subject: declaration.subject, before: previous.signature, after: declaration.signature });
      } else if (!previous) {
        add({ file: filename, kind: declaration.kind, subject: declaration.subject, action: "added" });
      }
    }
    for (const [key, declaration] of oldDeclarations) {
      if (!newDeclarations.has(key)) add({ file: filename, kind: declaration.kind, subject: declaration.subject, action: "removed" });
    }

    if (GITHUB_CODE_FILE.test(filename)) {
      const removedCalls = changedCallExpressions(patch, "-");
      const addedCalls = changedCallExpressions(patch, "+");
      for (const [subject, after] of addedCalls) {
        const before = removedCalls.get(subject);
        if (!before || before === after || newDeclarations.has(`function:${subject}`)) continue;
        add({ file: filename, kind: "api_call_signature", subject, before, after });
      }
      add(changedCodeLineFact(filename, patch));
    }

    const schemaPath = /(?:^|\/)(?:api|schemas?|models?|types?|dto|responses?)(?:\/|$)/i.test(filename);
    if (schemaPath && oldValues.size === 1 && newValues.size === 1) {
      const [[beforeName, beforeValue]] = oldValues;
      const [[afterName, afterValue]] = newValues;
      if (beforeName !== afterName && beforeValue === afterValue) {
        add({ file: filename, kind: "response_schema", subject: `${path.posix.basename(filename)} schema`, before: beforeName, after: afterName });
      }
    }
    for (const [subject, after] of newValues) {
      const before = oldValues.get(subject) ?? null;
      if (before === after) continue;
      const kind = profile.scope === "config" || profile.scope === "dependency" || CHANGE_EVIDENCE_SUBJECT.test(subject)
        ? "config_value"
        : "code_assignment";
      add({ file: filename, kind, subject, before, after });
    }

    const listSubject = path.posix.basename(filename) || filename;
    for (const value of addedList.filter((value) => !removedList.includes(value))) {
      add({ file: filename, kind: "list_item", subject: listSubject, after: value, action: "added" });
    }
    for (const value of removedList.filter((value) => !addedList.includes(value))) {
      add({ file: filename, kind: "list_item", subject: listSubject, before: value, action: "removed" });
    }

    if (profile.scope === "documentation") {
      for (const line of patch.split("\n")) {
        if (!/^[+-]/.test(line) || /^\+\+\+|^---/.test(line) || patchListItem(line)) continue;
        const value = patchDocumentationItem(line);
        if (!value) continue;
        add({
          file: filename,
          kind: "documentation_item",
          subject: listSubject,
          ...(line.startsWith("+") ? { after: value, action: "added" } : { before: value, action: "removed" }),
        });
      }
    }

    const hasPreciseFileFact = collected.slice(fileFactStart).some(({ item }) => item.kind !== "file_change");
    const unmatchedCodeLine = meaningfulCodeLines.find((line) => {
      if (patchAssignment(`+${line}`) || codeDeclaration(`+${line}`, filename)) return false;
      return safePatchText(line, 120);
    });
    if (unmatchedCodeLine) {
      add({ file: filename, kind: "code_line", subject: path.posix.basename(filename), after: safePatchText(unmatchedCodeLine, 120), action: "added" });
    }
    if (/^SKILL\.md$/i.test(path.posix.basename(filename)) || (!hasPreciseFileFact && !unmatchedCodeLine) || !patch) {
      add({
        file: filename,
        kind: "file_change",
        subject: filename,
        action: ["added", "removed"].includes(file.status) ? file.status : "modified",
        ...(!patch ? { confidence: "metadata_only" } : {}),
      });
    }
  }
  const deduped = new Map();
  for (const entry of collected) {
    const key = evidenceKey(entry.item);
    if (!deduped.has(key)) deduped.set(key, entry);
  }
  return [...deduped.values()]
    .sort((left, right) => {
      const headline = String(context?.commitMessage || "").split("\n")[0].toLowerCase();
      const headlineBoost = (entry) => {
        const subject = String(entry.item?.subject || "").toLowerCase();
        return subject.length >= 4 && headline.includes(subject) ? 25 : 0;
      };
      return (evidenceRank(right.item, right.order) + headlineBoost(right))
        - (evidenceRank(left.item, left.order) + headlineBoost(left));
    })
    .map(({ item }) => item);
}

function isBinanceConnectorSdkRepository(repository) {
  return /^binance\/binance-(?:web3-)?connector-(?:go|java|js|python)$/i.test(String(repository || ""));
}

function changedCallExpressions(patch, prefix) {
  const calls = new Map();
  for (const line of String(patch || "").split("\n")) {
    if (!line.startsWith(prefix) || line.startsWith(`${prefix}${prefix}`)) continue;
    const source = line.slice(1);
    for (const match of source.matchAll(/\b([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^()\n]{0,100})\)/g)) {
      const subject = match[1];
      if (/^(?:if|for|switch|func)$/i.test(subject)) continue;
      calls.set(subject, `${subject}(${match[2].trim()})`);
    }
  }
  return calls;
}

function binanceResponseSchemaEvidence(commitMessage, files) {
  const source = String(commitMessage || "");
  const response = source.match(/Modified response for\s+`([^`]+)`(?:\s+\(`([^`]+)`\))?([\s\S]{0,600})/i);
  if (!response) return null;
  const added = response[3].match(/property\s+`?([A-Za-z_$][\w$.-]*)`?\s+added/i)?.[1];
  const removed = response[3].match(/property\s+`?([A-Za-z_$][\w$.-]*)`?\s+(?:deleted|removed)/i)?.[1];
  if (!added || !removed || added === removed) return null;
  const changelog = files.find((file) => /(?:^|\/)CHANGELOG\.md$/i.test(String(file?.filename || "")))?.filename || "";
  return {
    file: changelog,
    kind: "response_schema",
    subject: `${response[1]} response`,
    before: removed,
    after: added,
    ...(response[2] ? { endpoint: response[2] } : {}),
  };
}

export function extractBinanceConnectorChangeEvidence(files = [], commitMessage = "", maximum = 4) {
  const substantive = [];
  const maintenance = [];
  for (const file of files) {
    const filename = String(file?.filename || "");
    const patch = String(file?.patch || "");
    const removedDependencies = new Map();
    const addedDependencies = new Map();
    for (const line of patch.split("\n")) {
      const dependency = line.match(/^([+-])\s*([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+)\s+(v\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?)\s*$/i);
      if (!dependency) continue;
      (dependency[1] === "+" ? addedDependencies : removedDependencies).set(dependency[2], dependency[3]);
    }
    for (const [subject, after] of addedDependencies) {
      const before = removedDependencies.get(subject) ?? null;
      if (before === after) continue;
      maintenance.push({ file: filename, kind: "dependency_version", subject, before, after });
    }

    const removedCalls = changedCallExpressions(patch, "-");
    const addedCalls = changedCallExpressions(patch, "+");
    for (const [subject, after] of addedCalls) {
      const before = removedCalls.get(subject);
      if (!before || before === after) continue;
      substantive.push({ file: filename, kind: "api_call_signature", subject, before, after });
    }
  }

  const schema = binanceResponseSchemaEvidence(commitMessage, files);
  if (schema) substantive.unshift(schema);

  const dependencyClaim = String(commitMessage || "").match(/Updated\s+`([^`]+)`\s+library\s+to\s+version\s+`?(v?\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?)`?/i);
  if (dependencyClaim && !maintenance.some((item) => item.subject === dependencyClaim[1])) {
    const changelog = files.find((file) => /(?:^|\/)CHANGELOG\.md$/i.test(String(file?.filename || "")))?.filename || "";
    maintenance.push({
      file: changelog,
      kind: "dependency_version",
      subject: dependencyClaim[1],
      before: null,
      after: dependencyClaim[2].startsWith("v") ? dependencyClaim[2] : `v${dependencyClaim[2]}`,
    });
  }

  const deduped = [];
  for (const item of [...substantive, ...maintenance]) {
    const key = `${item.kind}:${item.file}:${item.subject}:${item.before}:${item.after}`;
    if (!deduped.some((existing) => existing.key === key)) deduped.push({ key, item });
  }
  return deduped.slice(0, maximum).map(({ item }) => item);
}

export function extractGithubChangeEvidence(files = [], maximum = 4, context = {}) {
  const generic = extractGenericGithubChangeEvidence(files, context);
  const binance = isBinanceConnectorSdkRepository(context?.repository)
    ? extractBinanceConnectorChangeEvidence(files, context?.commitMessage, maximum)
    : [];
  const evidence = [];
  for (const item of [...binance, ...generic]) {
    const key = evidenceKey(item);
    if (evidence.some((existing) => existing.key === key)) continue;
    evidence.push({ key, item });
  }
  return evidence.slice(0, maximum).map(({ item }) => item);
}

function githubChangeSummary(fact) {
  if (!fact) return "Changed files were reported without an available semantic patch";
  if (fact.before != null || fact.after != null) {
    return `${fact.subject}: ${fact.before ?? "not present"} -> ${fact.after ?? "removed"}`;
  }
  return `${fact.action || "changed"} ${fact.subject}`;
}

export function summarizeGithubChange(files = [], context = {}, maximum = 4) {
  const facts = extractGithubChangeEvidence(files, maximum, context);
  const patches = files.map((file) => String(file?.patch || ""));
  const completePatchCount = files.filter((file) => String(file?.patch || "") && file?.patchTruncated !== true && file?.patchComplete !== false).length;
  const inferredCompleteness = !files.length || !patches.some(Boolean)
    ? "metadata_only"
    : completePatchCount === files.length ? "complete" : "partial";
  const completeness = ["complete", "partial", "metadata_only"].includes(context?.completeness)
    ? context.completeness
    : inferredCompleteness;
  const primaryFact = facts[0] || null;
  const dependencyOnly = facts.length > 0 && facts.every((item) => item.kind === "dependency_version"
    || (item.kind === "config_value" && /version/i.test(String(item.subject || "")))
    || (item.kind === "file_change" && GITHUB_DEPENDENCY_FILE.test(String(item.file || ""))));
  const documentationOnly = facts.length > 0 && facts.every((item) => ["list_item", "documentation_item"].includes(item.kind)
    || (item.kind === "file_change" && githubFileProfile(item.file).scope === "documentation"));
  const substantive = facts.some((item) => {
    const profile = githubFileProfile(item.file);
    if (["api_call_signature", "response_schema", "contract", "interface", "class", "function", "code_assignment", "code_line", "config_value"].includes(item.kind)) {
      return !["test_or_generated", "documentation", "dependency"].includes(profile.scope);
    }
    return item.kind === "file_change" && item.action === "added"
      && ["skill_manifest", "api", "production", "code"].includes(profile.scope);
  });
  const classification = dependencyOnly
    ? "dependency_maintenance"
    : documentationOnly ? "documentation" : substantive ? "substantive" : "file_change";
  const fingerprintInput = facts.length
    ? facts.map((fact) => evidenceKey(fact))
    : files.map((file) => `${file?.status || "modified"}:${file?.filename || ""}`);
  return {
    scheme: "github_change_v1",
    stage: context?.stage === "pull_request" ? "pull_request" : "commit",
    basis: context?.basis || (context?.stage === "pull_request" ? "pull_request_snapshot" : "api_patch"),
    completeness,
    classification,
    substantive,
    primaryFact,
    facts,
    summary: githubChangeSummary(primaryFact),
    fingerprint: createHash("sha256").update(JSON.stringify(fingerprintInput)).digest("hex").slice(0, 24),
    ...(completeness !== "complete" ? {
      fallbackReason: completeness === "metadata_only" ? "patch_unavailable" : "one_or_more_patches_missing_or_truncated",
    } : {}),
  };
}

export function classifyBinanceGithubChange(repository, commitMessage, files = [], evidence = []) {
  if (!isOfficialBinanceRepositoryName(repository)) return null;
  const connector = isBinanceConnectorSdkRepository(repository);
  const substantiveKinds = new Set(["api_call_signature", "response_schema", "contract", "interface", "class", "function", "code_assignment", "code_line"]);
  const substantive = evidence.find((item) => substantiveKinds.has(item?.kind)
    || (item?.kind === "config_value" && !/version/i.test(String(item?.subject || "")))
    || (item?.kind === "file_change" && item?.action === "added"
      && ["skill_manifest", "api", "production", "code"].includes(githubFileProfile(item?.file).scope)));
  const dependency = evidence.find((item) => item?.kind === "dependency_version");
  const versionOnly = evidence.length > 0 && evidence.every((item) => item?.kind === "dependency_version"
    || (item?.kind === "config_value" && /version/i.test(String(item?.subject || ""))));
  const release = /^Release\s+.+\bv?\d+(?:\.\d+){1,3}/i.test(String(commitMessage || "").split("\n")[0]);
  const classification = substantive
    ? "api_or_schema_change"
    : (dependency || versionOnly || release)
      ? "sdk_maintenance"
      : connector ? "connector_code_change" : "official_repository_change";
  return {
    scheme: connector ? "binance_connector_diff_v1" : "binance_github_diff_v1",
    classification,
    substantive: classification === "api_or_schema_change",
    productFeature: !connector && Boolean(substantive)
      && files.some((file) => /^skills\/[^/]+\/[^/]+\/SKILL\.md$/i.test(String(file?.filename || "")) && file?.status === "added"),
    reason: substantive?.kind || dependency?.kind || (versionOnly ? "package_version" : release ? "release_only" : "unclassified_code_change"),
  };
}

export function parseGithubRepositoryPage(html, owner) {
  const escaped = String(owner).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`href=["']/(${escaped})/([A-Za-z0-9_.-]+)(?:["'/?#])`, "gi");
  const repositories = new Map();
  for (const match of String(html).matchAll(pattern)) {
    const fullName = `${match[1]}/${match[2]}`;
    repositories.set(fullName.toLowerCase(), { full_name: fullName, archived: false, htmlFallback: true });
  }
  return [...repositories.values()];
}

function isGithubAtomRestFallbackEligible(error) {
  return Number(error?.status) === 503 || isGithubTransportFailure(error);
}

function atomRestFallbackReason(error) {
  return Number(error?.status) === 503 ? "atom_http_503" : "atom_transport_failure";
}

async function githubCommitRestFallback(config, repository, page, etag, atomError) {
  const result = await githubCommitPage(config, repository, page, { etag });
  // Preserve the public-feed processing contract: downstream file inspection
  // continues through the public commit patch instead of silently changing the
  // event fields just because the commit list came from REST for this poll.
  result.commits = result.commits.map((commit) => ({ ...commit, atomFallback: true }));
  result.commitApi.fallbackReason = atomRestFallbackReason(atomError);
  return result;
}

async function listCommits(config, repository, page = 1, {
  atomEtag = null,
  atomBranch = null,
  commitApiEtag = null,
} = {}) {
  if (!config.githubToken) {
    if (page > 1) return { commits: [], atom: null };
    try {
      return await githubAtom(config, repository, "main", {
        etag: atomBranch === "main" ? atomEtag : null,
      });
    } catch (error) {
      if (isGithubAtomRestFallbackEligible(error)) {
        return githubCommitRestFallback(config, repository, page, commitApiEtag, error);
      }
      if (error.status !== 404) throw error;
      try {
        return await githubAtom(config, repository, "master", {
          etag: atomBranch === "master" ? atomEtag : null,
        });
      } catch (masterError) {
        if (isGithubAtomRestFallbackEligible(masterError)) {
          return githubCommitRestFallback(config, repository, page, commitApiEtag, masterError);
        }
        throw masterError;
      }
    }
  }
  try {
    return await githubCommitPage(config, repository, page, {
      etag: page === 1 ? commitApiEtag : null,
    });
  }
  catch (error) {
    if ([403, 429].includes(Number(error?.status))) throw error;
    if (page > 1) return { commits: [], atom: null };
    console.error(`[github-fallback] ${repository}: ${error.message}`);
    return githubAtom(config, repository, "main", {
      etag: atomBranch === "main" ? atomEtag : null,
    });
  }
}

async function recoverCommitsThroughAnchorWithoutToken(config, repository, lastSha) {
  const encoded = repository.split("/").map(encodeURIComponent).join("/");
  const commits = [];
  const seen = new Set();
  let pages = 0;
  for (let page = 1; page <= GITHUB_GAP_RECOVERY_MAX_PAGES; page += 1) {
    const response = await github(config, `/repos/${encoded}/commits?per_page=100&page=${page}`, { withoutToken: true });
    if (!Array.isArray(response)) throw new Error(`GitHub gap recovery for ${repository} returned an invalid commit list`);
    const batch = response.map((commit) => ({ ...commit, atomFallback: true }));
    pages = page;
    for (const commit of batch) {
      if (!commit?.sha || seen.has(commit.sha)) continue;
      seen.add(commit.sha);
      commits.push(commit);
    }
    if (batch.some((commit) => commit.sha === lastSha)) {
      return { commits, anchorFound: true, pages, status: "anchor_recovered_via_unauthenticated_api" };
    }
    if (batch.length < 100) break;
  }
  return {
    commits,
    anchorFound: false,
    pages,
    status: "anchor_not_found_via_unauthenticated_api",
  };
}

function boundedGapEvidenceText(value, maximum) {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, maximum)
    : null;
}

function gapRecoveryCommitFact(commit, position) {
  const committedAt = commit?.commit?.committer?.date || commit?.commit?.author?.date || null;
  const message = String(commit?.commit?.message || "").split("\n")[0];
  return {
    position,
    sha: boundedGapEvidenceText(commit?.sha, 80),
    ...(boundedGapEvidenceText(committedAt, 64) ? { committedAt: boundedGapEvidenceText(committedAt, 64) } : {}),
    ...(boundedGapEvidenceText(message, 160) ? { message: boundedGapEvidenceText(message, 160) } : {}),
  };
}

function compactPersistedGapRecovery(gap, cursorSha, observedAt) {
  const recovery = gap?.recovery;
  if (!recovery || typeof recovery !== "object" || !Array.isArray(recovery.commits)) return gap;

  // Only discard commit payloads whose lifecycle is provably over. Unknown,
  // malformed, or partially consumed recovery records stay byte-for-byte intact
  // so a future version can resume them without losing unprocessed commits.
  const commitsValid = recovery.commits.every((commit) => commit
    && typeof commit === "object"
    && typeof commit.sha === "string"
    && /^[a-f0-9]{4,80}$/i.test(commit.sha));
  const pagesValid = Number.isSafeInteger(recovery.pages)
    && recovery.pages >= 1
    && recovery.pages <= GITHUB_GAP_RECOVERY_MAX_PAGES;
  if (!commitsValid || !pagesValid) return gap;
  const newestSha = recovery.commits[0]?.sha || null;
  const oldestSha = recovery.commits.at(-1)?.sha || null;
  const uniqueCommitCount = new Set(recovery.commits.map((commit) => commit.sha)).size;
  const declaredFetchedCommits = Number(gap.fetchedCommits);
  const rangeConsistent = recovery.commits.length > 0
    && recovery.commits.length <= recovery.pages * 100
    && uniqueCommitCount === recovery.commits.length
    && gap.newestSha === newestSha
    && Number.isSafeInteger(declaredFetchedCommits)
    && declaredFetchedCommits >= 1
    && declaredFetchedCommits <= recovery.commits.length
    && gap.oldestFetchedSha === recovery.commits[declaredFetchedCommits - 1]?.sha;
  if (!rangeConsistent) return gap;
  const requestedAnchorPresent = typeof gap.previousSha === "string"
    && recovery.commits.some((commit) => commit.sha === gap.previousSha);
  const terminalAnchorMiss = gap.status === "anchor_not_in_bounded_history"
    && recovery.status === "anchor_not_found_via_unauthenticated_api"
    && recovery.anchorFound === false
    && typeof gap.previousSha === "string"
    && gap.previousSha === cursorSha
    && !requestedAnchorPresent;
  const fullyConsumed = gap.status === "anchor_not_in_bounded_history"
    && recovery.status === "anchor_recovered_via_unauthenticated_api"
    && recovery.anchorFound === true
    && requestedAnchorPresent
    && newestSha
    && newestSha === cursorSha;
  if (!terminalAnchorMiss && !fullyConsumed) return gap;

  let serialized;
  try {
    serialized = JSON.stringify(recovery.commits);
  } catch {
    return gap;
  }
  const selectedFacts = [];
  if (recovery.commits.length > 0) selectedFacts.push(gapRecoveryCommitFact(recovery.commits[0], "newest"));
  if (recovery.commits.length > 1 && selectedFacts.length < GITHUB_GAP_SELECTED_FACT_LIMIT) {
    selectedFacts.push(gapRecoveryCommitFact(recovery.commits.at(-1), "oldest"));
  }
  const compactEvidence = {
    schemaVersion: GITHUB_GAP_COMPACT_EVIDENCE_SCHEMA_VERSION,
    classification: terminalAnchorMiss ? "terminal_anchor_not_found" : "fully_consumed",
    observedAt: boundedGapEvidenceText(observedAt, 64),
    anchorRange: {
      requestedSha: boundedGapEvidenceText(gap.previousSha, 80),
      newestFetchedSha: boundedGapEvidenceText(newestSha, 80),
      oldestFetchedSha: boundedGapEvidenceText(oldestSha, 80),
      found: recovery.anchorFound === true,
    },
    count: recovery.commits.length,
    rawBytes: Buffer.byteLength(serialized),
    digest: `sha256:${createHash("sha256").update(serialized).digest("hex")}`,
    selectedFacts,
  };
  return {
    ...gap,
    recovery: {
      status: recovery.status,
      anchorFound: recovery.anchorFound,
      ...(Number.isSafeInteger(recovery.pages) && recovery.pages >= 0
        ? { pages: Math.min(recovery.pages, GITHUB_GAP_RECOVERY_MAX_PAGES) }
        : {}),
      compactEvidence,
    },
  };
}

async function listOrganizationRepositories(config, organization) {
  const encoded = encodeURIComponent(organization);
  const request = async (pathname) => {
    try {
      return await github(config, pathname);
    } catch (error) {
      if (!config.githubToken || ![401, 403].includes(error.status)) throw error;
      return github(config, pathname, { withoutToken: true });
    }
  };
  const htmlFallback = async () => {
    const pages = [
      `https://github.com/orgs/${encoded}/repositories`,
      `https://github.com/${encoded}?tab=repositories`,
    ];
    let lastError;
    for (const page of pages) {
      try {
        const repositories = parseGithubRepositoryPage(await publicText(page, config), organization);
        if (repositories.length) return repositories;
      } catch (error) { lastError = error; }
    }
    if (lastError) throw lastError;
    const error = new Error(`GitHub public repository page for ${organization} contained no repositories`);
    error.status = 502;
    throw error;
  };
  try {
    return await request(`/orgs/${encoded}/repos?per_page=100&type=public&sort=pushed`);
  } catch (error) {
    if ([401, 403, 429].includes(error.status)) return htmlFallback();
    if (error.status !== 404) throw error;
    try {
      return await request(`/users/${encoded}/repos?per_page=100&type=owner&sort=pushed`);
    } catch (userError) {
      if ([401, 403, 429].includes(userError.status)) return htmlFallback();
      throw userError;
    }
  }
}

async function runBounded(items, concurrency, task) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      await task(items[index]);
    }
  });
  return Promise.allSettled(workers);
}

async function commitFiles(config, repository, commit) {
  if (!commit.atomFallback) {
    const files = [];
    let complete = false;
    for (let pageNumber = 1; pageNumber <= 30; pageNumber += 1) {
      const detail = await github(config, `/repos/${repository}/commits/${commit.sha}?per_page=100&page=${pageNumber}`);
      const pageFiles = Array.isArray(detail?.files) ? detail.files : [];
      files.push(...pageFiles);
      if (pageFiles.length < 100) {
        complete = true;
        break;
      }
    }
    Object.defineProperty(files, "githubCompleteness", {
      value: complete ? null : "partial",
      enumerable: false,
    });
    return files;
  }
  const patch = await publicText(`https://github.com/${repository}/commit/${commit.sha}.patch`, config);
  commit.patchMessage = parseGithubPatchMessage(patch) || commit.commit?.message || "";
  const files = parseGithubPatchFiles(patch);
  Object.defineProperty(files, "githubCompleteness", {
    value: files.some((file) => file.patchTruncated === true) ? "partial" : null,
    enumerable: false,
  });
  return files;
}

async function githubPublicRepositoryRequest(config, pathname) {
  try {
    return await github(config, pathname);
  } catch (error) {
    if (!config.githubToken || ![401, 403].includes(error.status)) throw error;
    return github(config, pathname, { withoutToken: true });
  }
}

async function listOpenPullRequests(config, repository) {
  const encoded = repository.split("/").map(encodeURIComponent).join("/");
  const response = await githubPublicRepositoryRequest(
    config,
    `/repos/${encoded}/pulls?state=open&sort=updated&direction=desc&per_page=30`,
  );
  if (!Array.isArray(response)) throw new Error(`GitHub pull request list for ${repository} was invalid`);
  return response;
}

async function pullRequestFiles(config, repository, number) {
  const encoded = repository.split("/").map(encodeURIComponent).join("/");
  const files = [];
  let complete = false;
  for (let pageNumber = 1; pageNumber <= 30; pageNumber += 1) {
    const response = await githubPublicRepositoryRequest(config, `/repos/${encoded}/pulls/${number}/files?per_page=100&page=${pageNumber}`);
    if (!Array.isArray(response)) throw new Error(`GitHub pull request files for ${repository}#${number} were invalid`);
    files.push(...response);
    if (response.length < 100) {
      complete = true;
      break;
    }
  }
  Object.defineProperty(files, "githubCompleteness", {
    value: complete ? null : "partial",
    enumerable: false,
  });
  return files;
}

function pullRequestHeadSha(pullRequest) {
  return String(pullRequest?.head?.sha || "").trim();
}

function pullRequestCursor(pullRequest) {
  const headSha = pullRequestHeadSha(pullRequest);
  if (!headSha) return null;
  // Head commits are the meaningful PR revision. Comments and review activity
  // update `updated_at`, but must not create another user alert.
  return createHash("sha256").update(`${pullRequest.number}:${headSha}`).digest("hex");
}

export function isRelevantModuleFile(filename) {
  return RELEVANT.some((pattern) => pattern.test(filename));
}

export function isRelevantRepositoryFile(repository, filename) {
  const normalized = repository.toLowerCase();
  // A Flap skill is an executable instruction bundle: its SKILL.md and the
  // referenced Markdown steps jointly define what the wallet agent can do.
  // Keep README-only follow-ups visible to the narrow semantic classifier,
  // but never treat Markdown from unrelated repositories as executable code.
  if (normalized === FLAP_SKILLS_REPOSITORY) return FLAP_SKILL_CONTENT_FILE.test(filename) || isRelevantModuleFile(filename);
  if (normalized === BINANCE_CONNECTOR_REPOSITORY) return BINANCE_CONNECTOR_FILE.test(filename) && /\.(?:md|ts|tsx|js|mjs|json|ya?ml)$/i.test(filename);
  if (isOfficialBinanceRepositoryName(normalized)) return isRelevantModuleFile(filename) || BINANCE_REPOSITORY_CONTENT_FILE.test(filename);
  if (isOfficialAiRepositoryName(normalized)) return isRelevantModuleFile(filename) || AI_REPOSITORY_CONTENT_FILE.test(filename);
  if (isOfficialUniswapRepositoryName(normalized)) {
    if (normalized === "uniswap/hooklist" && /^(?:hooks\/(?:robinhood|bnb|mainnet)\/[^/]+\.json|hooklist\.json)$/i.test(filename)) return true;
    return isRelevantModuleFile(filename) || UNISWAP_CONTENT_FILE.test(filename);
  }
  return isRelevantModuleFile(filename)
    || (FOUR_MEME_CONTENT_REPOSITORIES.has(normalized) && FOUR_MEME_CONTENT_FILE.test(filename))
    || (BSC_DEPLOYMENT_DOCUMENT_REPOSITORIES.has(normalized) && (
      /^(?:README|SECURITY(?:-REVIEW)?|DEPLOYMENTS?|CONTRACTS?)\.md$/i.test(filename)
      || /^docs\/(?:INTEGRATION|SECURITY|DEPLOYMENTS?|CONTRACTS?|ADDRESSES)\.md$/i.test(filename)
    ));
}

function normalizedDiffValue(value = "") {
  return String(value).trim().replace(/\s+/g, " ");
}

function meaningfulAddedLines(file) {
  const patch = String(file?.patch || "");
  const removed = new Set(patch.split("\n")
    .filter((line) => line.startsWith("-") && !line.startsWith("---"))
    .map((line) => normalizedDiffValue(line.slice(1)))
    .filter(Boolean));
  return patch.split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1).trim())
    .filter((line) => line && !removed.has(normalizedDiffValue(line)));
}

function chainEvidence(filename, value) {
  const detail = normalizedDiffValue(value).slice(0, 180);
  if (!filename) return detail ? `提交信息：${detail}` : "提交信息中的新增链支持";
  return detail ? `${filename}: ${detail}` : `新增链部署/配置文件：${filename}`;
}

function extractChainIdValues(value, { allowBareId = false } = {}) {
  const ids = [];
  const labelled = /(?:chain[-_.\s]*id|network[-_.\s]*id|block\.chainid|eip[-_.\s]*155|supported[-_.\s]*chains?(?:[-_.\s]*ids?)?)[^0-9a-f]{0,30}(0x[0-9a-f]+|\d{1,10})/gi;
  for (const match of value.matchAll(labelled)) {
    const parsed = Number(match[1].toLowerCase().startsWith("0x") ? BigInt(match[1]) : match[1]);
    if (Number.isSafeInteger(parsed) && parsed > 0) ids.push(parsed);
  }
  if (allowBareId) {
    // Bare IDs are accepted only as an explicit `id` value or a numeric
    // object key. Numeric string values (timestamps, byte counts, comments)
    // must never become chain IDs.
    const bare = /(?:^|[,{\s])(?:["']?id["']?\s*[:=]\s*["']?(0x[0-9a-f]+|\d{1,10})["']?|["'](0x[0-9a-f]+|\d{1,10})["']\s*:)/gi;
    for (const match of value.matchAll(bare)) {
      const raw = match[1] || match[2];
      const parsed = Number(raw.toLowerCase().startsWith("0x") ? BigInt(raw) : raw);
      if (Number.isSafeInteger(parsed) && parsed > 0) ids.push(parsed);
    }
  }
  return [...new Set(ids)];
}

function extractStructuralChainSignals(repository, filename, value, { allowPathId = false, assumeStructural = true } = {}) {
  const evidenceValue = String(value || "");
  const platformContext = /^flap-sh\//i.test(repository)
    ? "Flap"
    : /^four-meme-community\//i.test(repository) ? "Four.Meme" : "Uniswap";
  const humanizedFilename = String(filename || "")
    .replace(/[^a-z0-9]+/gi, " ")
    .replace(/\b[a-z]/g, (letter) => letter.toUpperCase());
  const humanizedValue = evidenceValue.replace(/\b(base|arbitrum|optimism|ethereum|unichain|polygon|avalanche|solana)(Sepolia|Mainnet|Testnet|Devnet|Amoy|Fuji)\b/gi, "$1 $2");
  const source = `${platformContext} ${repository} ${filename} ${humanizedFilename} ${evidenceValue} ${humanizedValue}`;
  const ids = extractChainIdValues(source, { allowBareId: allowPathId });
  if (allowPathId) {
    for (const match of filename.matchAll(/(?:^|\/)(\d{2,10})(?=\/|\.|$)/g)) {
      const parsed = Number(match[1]);
      if (Number.isSafeInteger(parsed) && parsed > 0) ids.push(parsed);
    }
  }
  const signals = extractChainSupportSignals(source, { assumePublicationAction: assumeStructural });
  const environment = /\b(?:testnet|devnet|sepolia|chapel|amoy|fuji)\b/i.test(source)
    ? "testnet"
    : /\bmainnet\b/i.test(source) ? "mainnet" : "unknown";
  for (const chainId of new Set(ids)) {
    if (signals.some((signal) => signal.chainId === chainId)) continue;
    const fallback = extractChainSupportSignals(
      `${repository} protocol deployment is live on a new network, chainId: ${chainId}${environment === "unknown" ? "" : ` ${environment}`}`,
    )[0];
    if (fallback) signals.push(fallback);
  }
  return signals.map((signal) => ({
    name: signal.name,
    chainId: signal.chainId,
    environment: signal.environment,
    evidence: chainEvidence(filename, evidenceValue),
  }));
}

export function detectGithubChainSupportChange(repository, message, files, { stage = "commit" } = {}) {
  const normalizedRepository = String(repository || "").toLowerCase();
  if (!GITHUB_FOCUS3_CHAIN_REPOSITORY.test(normalizedRepository)) return { candidate: false, chains: [], stage };
  const structuralFiles = (files || []).filter((file) => file?.status !== "removed"
    && !GITHUB_CHAIN_SUPPORT_NOISE_FILE.test(file?.filename || "")
    && !GITHUB_NON_PRODUCTION_FILE.test(file?.filename || "")
    && GITHUB_CHAIN_SUPPORT_STRUCTURAL_FILE.test(file?.filename || ""));
  if (!structuralFiles.length) return { candidate: false, chains: [], stage };

  const chains = [];
  for (const file of structuralFiles) {
    const filename = String(file.filename || "");
    const pathCarriesChainContext = GITHUB_CHAIN_SUPPORT_PATH_CONTEXT.test(filename);
    for (const line of meaningfulAddedLines(file)) {
      if (GITHUB_CHAIN_METADATA_NOISE_LINE.test(line)) continue;
      const lineCarriesChainContext = /(?:chain[-_.\s]*id|network[-_.\s]*id|block\.chainid|supported[-_.\s]*chains?|(?:viem|wagmi)\/chains|\b(?:mainnet|testnet|devnet|sepolia)\b)/i.test(line);
      chains.push(...extractStructuralChainSignals(repository, filename, line, {
        allowPathId: /(?:chains?|networks?|deploy(?:ments?)?|addresses?)/i.test(filename),
        assumeStructural: pathCarriesChainContext || lineCarriesChainContext,
      }));
    }
    if (file.status === "added" && pathCarriesChainContext) {
      chains.push(...extractStructuralChainSignals(repository, filename, filename, { allowPathId: true }));
    }
  }
  const headline = String(message || "").split("\n")[0].trim();
  if (GITHUB_CHAIN_SUPPORT_HEADLINE.test(headline)) {
    chains.push(...extractStructuralChainSignals(repository, "", headline, { assumeStructural: false }));
  }

  const hasConcreteChain = chains.some((chain) => chain.chainId != null || chain.name !== "新链（名称待确认）");
  const deduplicated = [];
  const conflicted = new Set();
  const effectiveEnvironment = (chain) => chain.environment === "testnet" ? "testnet" : "mainnet";
  const specificity = (chain) => (chain.environment === "unknown" ? 0 : 4)
    + (chain.chainId != null ? 2 : 0)
    + (/^Chain ID\b/i.test(chain.name) ? 0 : 1);
  for (const chain of chains) {
    if (hasConcreteChain && chain.chainId == null && chain.name === "新链（名称待确认）") continue;
    const chainEnvironment = effectiveEnvironment(chain);
    const index = deduplicated.findIndex((existing) => effectiveEnvironment(existing) === chainEnvironment
      && ((existing.chainId != null && chain.chainId != null && existing.chainId === chain.chainId)
        || existing.name.toLowerCase() === chain.name.toLowerCase()));
    const conflictKey = `${chain.name.toLowerCase()}:${chainEnvironment}`;
    if (conflicted.has(conflictKey)) continue;
    if (index < 0) {
      deduplicated.push(chain);
      continue;
    }
    const existing = deduplicated[index];
    if (existing.chainId != null && chain.chainId != null && existing.chainId !== chain.chainId) {
      deduplicated.splice(index, 1);
      conflicted.add(conflictKey);
      continue;
    }
    if (specificity(chain) > specificity(existing)) deduplicated[index] = chain;
  }
  return { candidate: deduplicated.length > 0, chains: deduplicated, stage };
}

function singleChainSupportContext(chainSupportChange) {
  const chains = Array.isArray(chainSupportChange?.chains) ? chainSupportChange.chains : [];
  if (chains.length !== 1) return null;
  const chainId = Number(chains[0]?.chainId);
  const environment = String(chains[0]?.environment || "").trim().toLowerCase();
  return {
    ...(Number.isSafeInteger(chainId) && chainId > 0 ? { chainId } : {}),
    ...(environment ? { environment } : {}),
  };
}

function githubEventChainContext(entry, chainSupportChange) {
  if (chainSupportChange?.candidate === true) return singleChainSupportContext(chainSupportChange) || {};
  const configuredChainId = Number(entry?.chainId);
  if (entry?.uniswapOfficial === true || !Number.isSafeInteger(configuredChainId) || configuredChainId <= 0) return {};
  return { chainId: configuredChainId };
}

function githubBscDiscoveryChainId(entry, chainSupportChange) {
  if (chainSupportChange?.candidate === true) return singleChainSupportContext(chainSupportChange)?.chainId || null;
  if (entry?.uniswapOfficial === true) return null;
  const configuredChainId = Number(entry?.chainId);
  return Number.isSafeInteger(configuredChainId) && configuredChainId > 0 ? configuredChainId : 56;
}

export function isSemanticallyRelevantFourMemeChange(repository, commit, files) {
  if (!FOUR_MEME_CONTENT_REPOSITORIES.has(repository.toLowerCase())) return true;
  const content = [commit.commit?.message || "", ...files.map((file) => `${file.filename}\n${file.patch || ""}`)].join("\n");
  return files.some((file) => isRelevantModuleFile(file.filename)) || FOUR_MEME_SEMANTIC_SIGNAL.test(content);
}

export function isSemanticallyRelevantBinanceChange(repository, commit, files) {
  const normalized = repository.toLowerCase();
  if (!isOfficialBinanceRepositoryName(normalized)) return true;
  const message = String(commit.patchMessage || commit.commit?.message || "");
  const content = [message, ...files.map((file) => `${file.filename}\n${file.patch || ""}`)].join("\n");
  if (isBinanceConnectorSdkRepository(normalized)) {
    const evidence = extractGithubChangeEvidence(files, 4, { repository: normalized, commitMessage: message });
    const classification = classifyBinanceGithubChange(normalized, message, files, evidence);
    if (["api_or_schema_change", "sdk_maintenance"].includes(classification?.classification)) return true;
  }
  if (normalized === BINANCE_CONNECTOR_REPOSITORY) {
    return files.some((file) => BINANCE_CONNECTOR_FILE.test(file.filename))
      && (!BINANCE_GITHUB_NOISE_ONLY.test(message) || BINANCE_GITHUB_HIGH_SIGNAL.test(content))
      && BINANCE_GITHUB_HIGH_SIGNAL.test(content);
  }
  if (files.some((file) => BINANCE_FOCUS_SKILL_PATH.test(file.filename))) return true;
  if (normalized === BINANCE_SKILLS_REPOSITORY) {
    const addedOfficialSkill = files.some((file) => file.status === "added"
      && /^skills\/binance(?:-web3)?\/[^/]+\/SKILL\.md$/i.test(file.filename));
    if (addedOfficialSkill) return BINANCE_SKILL_SEMANTIC_SIGNAL.test(content);
    const productionCliFix = /^(?:fix|feat)(?:\([^)]*\))?\s*[:\-]?[^\n]{0,120}\b(?:cli|script|windows|output|execution)\b/i.test(message)
      && files.some((file) => /(?:^|\/)scripts?\/[^/]+\.(?:mjs|cjs|js|ts|py)$/i.test(String(file?.filename || ""))
        && !GITHUB_LOW_VALUE_FILE.test(String(file?.filename || "")));
    return productionCliFix && summarizeGithubChange(files, {
      repository: normalized,
      commitMessage: message,
    }).substantive === true;
  }
  if (BINANCE_GITHUB_NOISE_ONLY.test(message) && !BINANCE_GITHUB_HIGH_SIGNAL.test(content)) return false;
  return BINANCE_GITHUB_HIGH_SIGNAL.test(content);
}

function classifyAiProductChange(repository, commit, files = [], { official = isOfficialAiRepositoryName(repository) } = {}) {
  if (!official) {
    return { candidate: false, category: null, labels: [], reason: "not_official_ai_repository" };
  }
  const headline = String(commit?.commit?.message || "").split("\n")[0].trim();
  const addedContent = files.flatMap((file) => meaningfulAddedLines(file)).join("\n");
  const filenames = files.map((file) => `${file.status || "modified"} ${file.filename || ""}`).join("\n");
  const content = [headline, filenames, addedContent].filter(Boolean).join("\n");
  if (!files.length || files.every((file) => AI_MAINTENANCE_ONLY_FILE.test(file.filename || ""))) {
    return { candidate: false, category: null, labels: [], reason: "test_dependency_or_automation_only" };
  }

  const breakingOrDeprecation = AI_BREAKING_OR_DEPRECATION.test(content)
    || /^[a-z]+(?:\([^)]*\))?!\s*[:\-]/i.test(headline);
  const security = AI_IMPORTANT_SECURITY_CHANGE.test(content);
  const release = AI_VERSION_RELEASE.test(content);
  const featureHeadline = /^feat(?:\([^)]*\))?\s*[:\-]/i.test(headline)
    && (new RegExp(`\\b${AI_CHANGE_OBJECT}\\b`, "i").test(headline)
      || files.some((file) => !AI_MAINTENANCE_ONLY_FILE.test(file.filename || "")
        && new RegExp(`(?:^|[/_.-])${AI_CHANGE_OBJECT}(?:[/_.-]|$)`, "i").test(file.filename || "")));
  const explicitProductChange = AI_EXPLICIT_PRODUCT_CHANGE.test(headline) || featureHeadline;
  const criticalOverride = breakingOrDeprecation || security || release;
  if (AI_TRIVIAL_MAINTENANCE.test(content) && !criticalOverride) {
    return { candidate: false, category: null, labels: [], reason: "trivial_maintenance" };
  }
  if (AI_GITHUB_NOISE_ONLY.test(headline) && !criticalOverride) {
    const documentationAnnouncesProductChange = /^docs?(?:\([^)]*\))?\s*[:\-]/i.test(headline)
      && explicitProductChange;
    if (!documentationAnnouncesProductChange) {
      return { candidate: false, category: null, labels: [], reason: "ordinary_maintenance" };
    }
  }
  if (!explicitProductChange && !criticalOverride) {
    return { candidate: false, category: null, labels: [], reason: "no_material_product_signal" };
  }

  const labels = [];
  if (security) labels.push("security");
  if (breakingOrDeprecation) labels.push(/deprecat|sunset/i.test(content) ? "deprecation" : "breaking_change");
  if (release) labels.push("release");
  for (const [label, pattern] of [
    ["model", /\bmodels?\b|\bgrok\b/i],
    ["api", /\bapis?\b|\bendpoints?\b/i],
    ["sdk", /\bsdks?\b|\bxdk\b/i],
    ["plugin", /\bplugins?\b|\bmarketplaces?\b/i],
    ["algorithm", /\balgorithms?\b/i],
    ["chat", /\bchat(?:bot|s|ting)?\b/i],
    ["feature", /\bproducts?\b|\bfeatures?\b/i],
  ]) {
    if (pattern.test(content) && !labels.includes(label)) labels.push(label);
  }
  const category = labels[0] || "product_feature";
  const identifiers = [];
  const seenIdentifiers = new Set();
  for (const match of content.matchAll(AI_IDENTIFIER_SIGNAL)) {
    const identifier = String(match[0] || "").replace(/\s+/g, " ").trim();
    const key = identifier.toLowerCase();
    if (!identifier || seenIdentifiers.has(key)) continue;
    seenIdentifiers.add(key);
    identifiers.push(identifier);
    if (identifiers.length >= 8) break;
  }
  const deprecated = /\b(?:deprecat(?:e|es|ed|ing|ion)|sunset(?:s|ted|ting)?)\b/i.test(content);
  const stage = security ? "security" : deprecated ? "deprecated" : release ? "released" : "code_change";
  return {
    candidate: true,
    category,
    labels,
    identifiers,
    stage,
    reason: security
      ? "important_security_change"
      : breakingOrDeprecation
        ? "breaking_or_deprecation_change"
        : release
          ? "important_version_release"
          : "new_ai_product_or_feature",
  };
}

export function isSemanticallyRelevantAiChange(repository, commit, files, options = {}) {
  if (!options.official && !isOfficialAiRepositoryName(repository)) return true;
  return classifyAiProductChange(repository, commit, files, options).candidate;
}

export function isSemanticallyRelevantUniswapChange(repository, commit, files) {
  const normalized = String(repository || "").toLowerCase();
  if (!isOfficialUniswapRepositoryName(normalized)) return true;
  const message = String(commit?.commit?.message || "").split("\n")[0];
  const content = [message, ...files.map((file) => `${file.status || "modified"} ${file.filename}\n${file.patch || ""}`)].join("\n");
  const chainSupportChange = detectGithubChainSupportChange(repository, message, files);
  if (chainSupportChange.candidate) return true;
  const documentationOnly = files.length > 0 && files.every((file) => GITHUB_NON_PRODUCTION_FILE.test(file.filename));
  const explicitDeploymentAddress = extractGithubDeploymentAddresses(files.map((file) => file.patch || "").join("\n")).length > 0;
  const criticalDocumentation = /\b(?:security\s+(?:incident|advisory)|critical\s+(?:fix|vulnerability)|mainnet\s+deploy(?:ment|ed)?)\b/i.test(content);
  if (documentationOnly && UNISWAP_NOISE_ONLY.test(message)
    && !explicitDeploymentAddress && !criticalDocumentation) return false;
  if (/\b(?:equity\s*launch|stocks?\s+(?:issuance|offering|tokenization|tokens?)|tokenized\s+(?:stocks?|equities|securities)|security[- ]+tokens?)\b/i.test(content)
    && !UNISWAP_HIGH_SIGNAL.test(content.replace(/\b(?:equity\s*launch|stocks?\s+(?:issuance|offering|tokenization|tokens?)|tokenized\s+(?:stocks?|equities|securities)|security[- ]+tokens?)\b/ig, ""))) return false;
  if (normalized === "uniswap/hooklist") {
    if (files.every((file) => /^(?:hooklist\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$/i.test(file.filename))) return false;
    return files.some((file) => file.status === "added" && /^hooks\/(?:robinhood|bnb|mainnet)\/[^/]+\.json$/i.test(file.filename))
      && !/\b(?:equity\s*launch|stocks?|tokenized\s+(?:stocks?|equities|securities)|security[- ]+tokens?)\b/i.test(content);
  }
  const addedProtocolComponent = files.some((file) => file.status === "added"
    && /(?:^|\/)[^/]*(?:launch|strategy|hook|router|reactor|factory|deployer|adapter|policy|pool)[^/]*\.(?:sol|vy|ts|js|json)$/i.test(file.filename));
  const robinhoodDeployment = /(?:robinhood|chain[- _]?id[^\n]{0,12}4663|\/4663(?:\/|\.)|[-_.]4663\.)/i.test(content)
    && /(?:deploy|address|contract|router|factory|hook|strategy|adapter|policy)/i.test(content);
  if (addedProtocolComponent || robinhoodDeployment || UNISWAP_HIGH_SIGNAL.test(content)) return true;
  if (UNISWAP_NOISE_ONLY.test(message)) return false;
  return false;
}

export function classifyGithubModeChange(message, files) {
  const headline = String(message || "").split("\n")[0].trim();
  const content = [headline, ...(files || []).map((file) => `${file.filename || ""}\n${file.patch || ""}`)].join("\n");
  const fourMemeCharityMode = /(?:\bTaxToken\d+\b|\bcharit(?:y|able)\s+(?:donation|recipient|badge|dashboard|tax)\b|\bdonation\s+(?:feature|mode|tax|recipient)\b|\b(?:Giggle|Binance)\s+Charity\b)/i.test(content);
  const addedModule = files.some((file) => file.status === "added"
    && !GITHUB_NON_PRODUCTION_FILE.test(file.filename)
    && /(?:(?:^|\/)(?:contracts?|modules?|plugins?|deployments?|integrations?|strategies?|hooks?)(?:\/|$)|\.(?:sol|vy)$)/i.test(file.filename));
  const explicitNewMode = !GITHUB_NON_NEW_PREFIX.test(headline)
    && !GITHUB_TEST_OR_DOC_ADDITION.test(headline)
    && EXPLICIT_NEW_MODE_SIGNAL.test(headline);
  return {
    candidate: fourMemeCharityMode || addedModule || explicitNewMode,
    reason: fourMemeCharityMode ? "charity_donation_tax_mode" : addedModule ? "new_contract_or_module_file" : explicitNewMode ? "explicit_new_mode_action" : "relevant_code_change",
    ...(fourMemeCharityMode ? { labels: ["charity_donation", "transaction_tax"], identifiers: [...new Set(content.match(/\bTaxToken\d+\b/gi) || [])] } : {}),
  };
}

function flapSkillChangedText(files, prefix) {
  return files
    .filter((file) => FLAP_SKILL_FUNCTIONAL_FILE.test(String(file?.filename || "")))
    .flatMap((file) => String(file?.patch || "").split("\n")
      .filter((line) => line.startsWith(prefix) && !line.startsWith(`${prefix}${prefix}`))
      .map((line) => line.slice(1)))
    .join("\n");
}

// Flap publishes wallet-agent behavior as a SKILL.md plus Markdown reference
// steps.  Those files are executable product instructions even though they are
// not source-code extensions.  Classify only concrete before/after capability
// deltas; README wording, examples that merely repeat an existing capability,
// and ordinary token announcements remain non-structural.
export function classifyFlapSkillChange(repository, message, files = []) {
  if (String(repository || "").toLowerCase() !== FLAP_SKILLS_REPOSITORY) return null;
  const functionalFiles = files.filter((file) => FLAP_SKILL_FUNCTIONAL_FILE.test(String(file?.filename || "")));
  const added = flapSkillChangedText(functionalFiles, "+");
  const removed = flapSkillChangedText(functionalFiles, "-");
  const skillPatch = functionalFiles.find((file) => /\/SKILL\.md$/i.test(String(file?.filename || "")))?.patch || "";
  const skillAdded = flapSkillChangedText([{ filename: "skill/SKILL.md", patch: skillPatch }], "+");

  const taxV3Only = /\bTOKEN_TAXED_V3\b/i.test(added)
    && /(?:\bTOKEN_V2_PERMIT\b|\bstandard\s+(?:\(non-tax\)\s+)?token|tax\s+token\s+or\s+standard)/i.test(removed)
    && /(?:only\s+launch(?:es|ed)?|every\s+token\s+launched|out\s+of\s+scope)/i.test(added);
  const quoteReferenceAdded = functionalFiles.some((file) => file.status === "added"
    && /\/references\/quote-tokens\.md$/i.test(String(file.filename || ""))
    && /\/api\/launch\/quote-tokens|GET\s+https:\/\/flap\.sh\/api\/launch\/quote-tokens/i.test(String(file.patch || "")));
  const quoteSelectionWired = /references\/quote-tokens\.md/i.test(skillAdded)
    && /(?:which\s+quote\s+token|supported\s+quote\s+tokens?)[\s\S]{0,260}(?:quoteToken|decimals)|(?:quoteToken|decimals)[\s\S]{0,260}(?:which\s+quote\s+token|supported\s+quote\s+tokens?)/i.test(skillAdded);
  const configurableQuoteTokens = quoteReferenceAdded && quoteSelectionWired;
  const nativeOnlyRemoved = /(?:parseEther\(quoteAmtBnb\)|amount\s+of\s+BNB|both\s+the\s+`?quoteAmt`?\s+field\s+and\s+the\s+`?msg\.value`?)/i.test(removed);
  const erc20QuoteAdded = /\bERC-?20\b/i.test(added)
    && /\bapprove\b/i.test(added)
    && /msg\.value[^\n]{0,80}(?:0|zero)|(?:0|zero)[^\n]{0,80}msg\.value/i.test(added);
  const transactionValueChanged = nativeOnlyRemoved && erc20QuoteAdded;

  const facts = [];
  if (taxV3Only) facts.push({
    file: functionalFiles.find((file) => /\/SKILL\.md$/i.test(String(file.filename || "")))?.filename || "launch-bnb-token-on-flap/SKILL.md",
    kind: "config_value",
    subject: "launch token type",
    before: "TOKEN_V2_PERMIT or TOKEN_TAXED_V3",
    after: "TOKEN_TAXED_V3 only",
  });
  if (configurableQuoteTokens) facts.push({
    file: functionalFiles.find((file) => /\/references\/quote-tokens\.md$/i.test(String(file.filename || "")))?.filename || "launch-bnb-token-on-flap/references/quote-tokens.md",
    kind: "api_call_signature",
    subject: "GET /api/launch/quote-tokens",
    before: null,
    after: "chainId=56 quoteToken + decimals",
  });
  if (transactionValueChanged) facts.push({
    file: functionalFiles.find((file) => /\/references\/construct-tx\.md$/i.test(String(file.filename || "")))?.filename || "launch-bnb-token-on-flap/references/construct-tx.md",
    kind: "code_assignment",
    subject: "transaction value",
    before: "native BNB quoteAmt as msg.value",
    after: "native quoteAmt; ERC-20 msg.value=0 after approve",
  });

  const candidate = facts.length > 0;
  const fingerprint = candidate
    ? createHash("sha256").update(JSON.stringify(facts.map(evidenceKey))).digest("hex").slice(0, 24)
    : null;
  return {
    scheme: "flap_skill_change_v1",
    candidate,
    classification: candidate ? "skill_capability_change" : "documentation_or_non_structural",
    reason: candidate ? "flap_agentic_skill_capability_change" : "no_executable_skill_capability_delta",
    labels: [
      taxV3Only ? "Tax Token V3 only" : null,
      configurableQuoteTokens ? "configurable quote tokens" : null,
      transactionValueChanged ? "ERC-20 quote approval flow" : null,
    ].filter(Boolean),
    identifiers: [
      taxV3Only ? "TOKEN_TAXED_V3" : null,
      configurableQuoteTokens ? "GET /api/launch/quote-tokens" : null,
      configurableQuoteTokens ? "chainId=56" : null,
    ].filter(Boolean),
    facts,
    fingerprint,
    files: functionalFiles.map((file) => String(file.filename || "")),
    // Only short-circuit repository-level documentation. Unknown executable
    // files must continue through the existing generic GitHub classifier so a
    // new contract/module or deployment address is never hidden merely because
    // it is outside the known skill directory layout.
    documentationOnly: files.length > 0 && files.every((file) => /^(?:README(?:\.[^/]+)?|docs\/)/i.test(String(file?.filename || ""))),
    headline: String(message || "").split("\n")[0].trim() || null,
  };
}

function mergeFlapSkillGithubChange(githubChange, flapSkillChange) {
  if (!flapSkillChange?.candidate || !flapSkillChange.facts?.length) return githubChange;
  const facts = [];
  for (const fact of [...flapSkillChange.facts, ...(githubChange?.facts || [])]) {
    if (!facts.some((existing) => evidenceKey(existing) === evidenceKey(fact))) facts.push(fact);
  }
  const primaryFact = facts[0];
  return {
    ...githubChange,
    classification: "substantive",
    substantive: true,
    primaryFact,
    facts,
    summary: githubChangeSummary(primaryFact),
    fingerprint: createHash("sha256").update(JSON.stringify(facts.map(evidenceKey))).digest("hex").slice(0, 24),
  };
}

export function extractGithubDeploymentAddresses(addedPatch = "") {
  const lines = String(addedPatch).split("\n");
  const result = [];
  const role = /\b(?:factory|launcher|portal|manager|deployer|implementation|proxy|router|hook|vault|core|presale|fair[- ]?launch|token[- _]?sale)\b/i;
  const nonContractRole = /\b(?:quote(?:[- _]+token)?|base[- _]+token|payment[- _]+token|token\b(?![- _]+sale\b)|owner|creator|user|wallet|treasury|fee[- _]+recipient|beneficiary|admin|multisig)\b/i;
  const testnet = /\b(?:testnet|chapel|chain[- _]?id\s*[:=]?\s*97)\b/i;
  const mainnet = /\b(?:mainnet|chain[- _]?id\s*[:=]?\s*56)\b/i;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!role.test(line)) continue;
    if (nonContractRole.test(line)) continue;
    if (testnet.test(line) && !mainnet.test(line)) continue;
    for (const match of line.matchAll(/0x[a-fA-F0-9]{40}/g)) result.push(match[0].toLowerCase());
  }
  return [...new Set(result)];
}

export function createGithubMonitor(config, dependencies = {}) {
  const configuredRepositories = new Map((dependencies.repositories || DEFAULT_REPOSITORIES)
    .filter((item) => isMonitoringSourceEnabled(config, item))
    .map((item) => [item.repository.toLowerCase(), item]));
  const repositories = new Map(configuredRepositories);
  for (const [normalized, entry] of repositories) {
    if (entry.priority === true && !isOrganizationDynamicRepository(entry)) PRIORITY_REPOSITORIES.add(normalized);
  }
  const pullRequestRepositories = new Set((dependencies.pullRequestRepositories || GITHUB_PULL_REQUEST_TARGETS)
    .map((repository) => String(repository).toLowerCase()));
  const stateFile = path.join(config.dataDir, "github-state.json");
  const alertSender = dependencies.sendAlertsImpl || sendAlerts;
  const stateFs = dependencies.stateFs || fs;
  const now = dependencies.now || (() => new Date());
  const random = dependencies.random || Math.random;
  const setIntervalImpl = dependencies.setIntervalImpl || setInterval;
  const clearIntervalImpl = dependencies.clearIntervalImpl || clearInterval;
  const setTimeoutImpl = dependencies.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = dependencies.clearTimeoutImpl || clearTimeout;
  const retryBaseMs = Math.max(1_000, Number(config.githubRetryBaseMs) || 60_000);
  const retryMaxMs = Math.max(retryBaseMs, Number(config.githubRetryMaxMs) || 3_600_000);
  const regularPollConcurrency = Math.max(1, Number(config.githubPollConcurrency) || 4);
  const priorityPollIntervalMs = Math.max(
    GITHUB_REPOSITORY_SCHEDULER_MIN_INTERVAL_MS,
    Number(config.githubPriorityPollIntervalMs) || GITHUB_REPOSITORY_SCHEDULER_MIN_INTERVAL_MS,
  );
  const dynamicPollIntervalMs = boundedInterval(
    config.githubDynamicPollIntervalMs,
    GITHUB_DYNAMIC_POLL_DEFAULT_INTERVAL_MS,
    GITHUB_DYNAMIC_POLL_MIN_INTERVAL_MS,
    GITHUB_DYNAMIC_POLL_MAX_INTERVAL_MS,
  );
  const organizationPollIntervalMs = boundedInterval(
    config.githubOrganizationPollIntervalMs,
    GITHUB_ORGANIZATION_MAX_INTERVAL_MS,
    GITHUB_ORGANIZATION_MIN_INTERVAL_MS,
    GITHUB_ORGANIZATION_MAX_INTERVAL_MS,
  );
  const regularSchedulerIntervalMs = Math.max(
    GITHUB_REPOSITORY_SCHEDULER_MIN_INTERVAL_MS,
    Math.min(Number(config.githubPollIntervalMs) || 60_000, dynamicPollIntervalMs),
  );
  const requestedPullRequestIntervalMs = Math.max(1_000, Number(config.githubPrPollIntervalMs) || GITHUB_TOKEN_PR_MIN_INTERVAL_MS);
  const pullRequestPollIntervalMs = Math.max(
    config.githubToken ? GITHUB_TOKEN_PR_MIN_INTERVAL_MS : GITHUB_PUBLIC_PR_MIN_INTERVAL_MS,
    requestedPullRequestIntervalMs,
  );
  let state = null;
  let statePromise = null;
  let writeQueue = Promise.resolve();
  const repositoryLocks = new Map();
  const startupTransportProbePending = new Set();
  const startupPullRequestTransportProbePending = new Set();
  let startupTransportProbesInitialized = false;
  const checkLanes = {
    priority: { runningPromise: null, rerunRequested: false },
    regular: { runningPromise: null, rerunRequested: false },
  };
  let runningOrganizations = false;
  let runningPullRequests = false;
  let organizationPromise = null;
  let pullRequestsPromise = null;
  const externalOperations = new Set();
  let stopped = false;
  let stopPromise = null;

  async function ensureState() {
    if (state) return state;
    statePromise ||= (async () => {
      try { state = JSON.parse(await stateFs.readFile(stateFile, "utf8")); }
      catch (error) { if (error.code === "ENOENT") state = {}; else throw error; }
      state._repositories ||= {};
      state._organizations ||= {};
      state._health ||= {};
      state._health.schemaVersion = GITHUB_HEALTH_SCHEMA_VERSION;
      state._health.repositories ||= {};
      state._pullRequests ||= {};
      state._pullRequests.schemaVersion = GITHUB_PULL_REQUEST_SCHEMA_VERSION;
      state._pullRequests.repositories ||= {};
      state._pullRequests.effectivePollIntervalMs = pullRequestPollIntervalMs;
      let gapRecoveryMigrated = false;
      const migrationObservedAt = now().toISOString();
      for (const [repository, record] of Object.entries(state)) {
        if (repository.startsWith("_") || !record || typeof record !== "object") continue;
        const compactGap = compactPersistedGapRecovery(record.gap, record.sha, migrationObservedAt);
        if (compactGap === record.gap) continue;
        state[repository] = { ...record, gap: compactGap };
        gapRecoveryMigrated = true;
      }
      let repositoryClassMigrated = false;
      let repositoryActivationMigrated = false;
      for (const [repository, entry] of Object.entries(state._repositories)) {
        const normalized = repository.toLowerCase();
        const configured = configuredRepositories.get(normalized);
        const merged = { ...configured, ...entry };
        const explicitlyConfigured = Boolean(configured
          && !configured.officialOrganization
          && !isOrganizationDynamicRepository(configured));
        const explicitlyPriority = CORE_PRIORITY_REPOSITORIES.has(normalized)
          || (explicitlyConfigured && configured?.priority === true);
        const legacyOrganizationDynamic = Boolean(merged.officialOrganization)
          && !CORE_PRIORITY_REPOSITORIES.has(normalized);
        if (explicitlyPriority) {
          merged.pollingClass = "core_priority";
          merged.priority = true;
          PRIORITY_REPOSITORIES.add(normalized);
        } else if (explicitlyConfigured) {
          merged.pollingClass = "configured";
          merged.priority = false;
          PRIORITY_REPOSITORIES.delete(normalized);
        } else if (legacyOrganizationDynamic || isOrganizationDynamicRepository(merged)) {
          merged.pollingClass = "organization_dynamic";
          merged.priority = false;
          PRIORITY_REPOSITORIES.delete(normalized);
        }
        if (entry.priority !== merged.priority || entry.pollingClass !== merged.pollingClass) {
          state._repositories[repository] = merged;
          repositoryClassMigrated = true;
          const health = state._health.repositories[normalized];
          if (explicitlyConfigured && health?.pollingClass === "organization_dynamic") {
            const policyBackoffActive = health.status === "degraded"
              || Number(health.consecutiveFailures) > 0;
            state._health.repositories[normalized] = {
              ...health,
              priority: merged.priority,
              pollingClass: "core_or_configured",
              nextAttemptAt: policyBackoffActive ? health.nextAttemptAt || null : null,
            };
          }
        }
        const snapshotAdmission = organizationSnapshotAdmission(state._organizations, repository, merged);
        const remainsInactiveWithoutSnapshot = isOrganizationDynamicRepository(merged)
          && entry.active === false
          && snapshotAdmission?.active !== true;
        if (snapshotAdmission?.active === false || remainsInactiveWithoutSnapshot) {
          const inactiveReason = snapshotAdmission?.inactiveReason
            || entry.inactiveReason
            || "organization_repository_inactive";
          const inactiveSnapshotAt = snapshotAdmission?.snapshotAt
            || entry.inactiveOrganizationSnapshotAt
            || null;
          const inactiveEntry = {
            ...merged,
            active: false,
            inactiveReason,
            inactiveAt: entry.inactiveAt || inactiveSnapshotAt || migrationObservedAt,
            ...(inactiveSnapshotAt ? { inactiveOrganizationSnapshotAt: inactiveSnapshotAt } : {}),
          };
          if (entry.active !== false
            || entry.inactiveReason !== inactiveEntry.inactiveReason
            || entry.inactiveAt !== inactiveEntry.inactiveAt
            || entry.inactiveOrganizationSnapshotAt !== inactiveEntry.inactiveOrganizationSnapshotAt
            || entry.priority !== inactiveEntry.priority
            || entry.pollingClass !== inactiveEntry.pollingClass) repositoryActivationMigrated = true;
          state._repositories[repository] = inactiveEntry;
          repositories.delete(normalized);
          PRIORITY_REPOSITORIES.delete(normalized);
          continue;
        }
        if (Object.hasOwn(merged, "active")
          || Object.hasOwn(merged, "inactiveReason")
          || Object.hasOwn(merged, "inactiveAt")
          || Object.hasOwn(merged, "inactiveOrganizationSnapshotAt")) {
          delete merged.active;
          delete merged.inactiveReason;
          delete merged.inactiveAt;
          delete merged.inactiveOrganizationSnapshotAt;
          repositoryActivationMigrated = true;
        }
        // Persisted records may now be intentionally outside the active scope.
        // Classify them before this gate so stale priority flags cannot make the
        // state file claim that disabled repositories are using the fast lane.
        if (!isMonitoringSourceEnabled(config, { ...merged, repository })) continue;
        if (isUnverifiedPonsRepository(repository) && merged.sourceTrust !== "official_verified") continue;
        if (configured?.sourceTrust === "official_verified") {
          merged.sourceTrust = "official_verified";
          merged.launchpad = configured.launchpad || merged.launchpad;
          merged.officialEvidence = configured.officialEvidence || merged.officialEvidence;
          if (configured.baselineOnly === true) {
            merged.baselineOnly = true;
            delete merged.initialCatchupRequired;
          }
        } else if (UNVERIFIED_CANDIDATE_REPOSITORIES.has(normalized) && entry.sourceTrust !== "official_verified") {
          merged.sourceTrust = "unverified_candidate";
          merged.baselineOnly = true;
        }
        if (configured?.xaiOfficial === true && isOfficialAiRepositoryName(normalized)) {
          merged.xaiOfficial = true;
          merged.product = configured.product;
          merged.launchpad = configured.launchpad;
          merged.baselineOnly = true;
        }
        if (merged.uniswapOfficial === true) {
          delete merged.chainId;
          delete state._repositories[repository].chainId;
        }
        state._repositories[repository] = merged;
        repositories.set(normalized, merged);
        if (merged.priority) PRIORITY_REPOSITORIES.add(normalized);
      }
      if (repositoryClassMigrated || repositoryActivationMigrated || gapRecoveryMigrated) await writeState();
      if (!startupTransportProbesInitialized) {
        for (const [normalized, entry] of repositories) {
          const health = state._health.repositories[normalized];
          if (sourceTrust(entry) === "official_verified"
            && PRIORITY_REPOSITORIES.has(normalized)
            && GITHUB_FOCUS3_OFFICIAL_REPOSITORY.test(normalized)
            && isGithubTransportFailure(health)) startupTransportProbePending.add(normalized);
          const pullRequestHealth = state._pullRequests.repositories[normalized];
          if (pullRequestRepositories.has(normalized)
            && sourceTrust(entry) === "official_verified"
            && GITHUB_FOCUS3_OFFICIAL_REPOSITORY.test(normalized)
            && isGithubTransportFailure(pullRequestHealth)) startupPullRequestTransportProbePending.add(normalized);
        }
        startupTransportProbesInitialized = true;
      }
      return state;
    })();
    return statePromise;
  }

  function writeState() {
    const operation = writeQueue.catch(() => {}).then(async () => {
      await stateFs.mkdir(path.dirname(stateFile), { recursive: true });
      const temporary = `${stateFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
      try {
        await stateFs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
        await stateFs.rename(temporary, stateFile);
      } catch (error) {
        await stateFs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    });
    writeQueue = operation;
    return operation;
  }

  async function withRepositoryLock(repository, task) {
    const key = repository.toLowerCase();
    const previous = repositoryLocks.get(key) || Promise.resolve();
    const operation = previous.catch(() => {}).then(task);
    repositoryLocks.set(key, operation);
    try {
      return await operation;
    } finally {
      if (repositoryLocks.get(key) === operation) repositoryLocks.delete(key);
    }
  }

  function repositoryHealth(repository) {
    return state._health.repositories[repository.toLowerCase()] || null;
  }

  function organizationPushChanged(entry, health = repositoryHealth(entry.repository)) {
    const pushedAt = entry.organizationPushedAt;
    const lastAttemptedPushedAt = health?.lastAttemptedOrganizationPushedAt
      || health?.lastOrganizationPushedAt;
    return isOrganizationDynamicRepository(entry)
      && Boolean(pushedAt)
      && pushedAt !== lastAttemptedPushedAt;
  }

  function organizationPushGateIsFresh(entry) {
    if (!isOrganizationDynamicRepository(entry) || !entry.organizationPushedAt) return false;
    const health = repositoryHealth(entry.repository);
    return entry.organizationPushedAt === health?.lastOrganizationPushedAt;
  }

  function canAttemptRepository(entry) {
    const key = entry.repository.toLowerCase();
    if (startupTransportProbePending.delete(key)) return true;
    const health = repositoryHealth(entry.repository);
    if (organizationPushChanged(entry, health)) return true;
    const nextAttemptAt = Date.parse(health?.nextAttemptAt || "");
    return !Number.isFinite(nextAttemptAt) || now().getTime() >= nextAttemptAt;
  }

  function markRepositorySuccess(entry, outcome = {}) {
    const key = entry.repository.toLowerCase();
    const previous = repositoryHealth(entry.repository) || {};
    const timestampValue = now();
    const timestamp = timestampValue.toISOString();
    const organizationDynamic = isOrganizationDynamicRepository(entry);
    const commitRead = outcome.commitRead !== false;
    state._health.repositories[key] = {
      ...previous,
      repository: entry.repository,
      launchpad: entry.launchpad,
      priority: PRIORITY_REPOSITORIES.has(key),
      pollingClass: organizationDynamic ? "organization_dynamic" : "core_or_configured",
      status: "healthy",
      lastAttemptAt: timestamp,
      lastSuccessAt: timestamp,
      ...(commitRead ? { lastCommitReadAt: timestamp } : {}),
      ...(commitRead && entry.organizationPushedAt
        ? {
          lastOrganizationPushedAt: entry.organizationPushedAt,
          lastAttemptedOrganizationPushedAt: entry.organizationPushedAt,
        }
        : {}),
      ...(organizationDynamic
        ? { organizationPushGate: commitRead ? "commit_read" : "pushed_at_unchanged" }
        : {}),
      ...(outcome.atom
        ? {
          atomBranch: outcome.atom.branch,
          atomEtag: outcome.atom.etag || null,
          lastAtomReadAt: timestamp,
          ...(outcome.atom.notModified ? { lastAtomNotModifiedAt: timestamp } : {}),
          lastCommitSource: "atom",
        }
        : {}),
      ...(outcome.commitApi
        ? {
          commitApiEtag: outcome.commitApi.etag || null,
          lastCommitApiReadAt: timestamp,
          ...(outcome.commitApi.notModified ? { lastCommitApiNotModifiedAt: timestamp } : {}),
          ...(outcome.commitApi.fallbackReason
            ? {
              lastAtomRestFallbackAt: timestamp,
              lastAtomRestFallbackReason: outcome.commitApi.fallbackReason,
            }
            : {}),
          lastCommitSource: outcome.commitApi.fallbackReason ? "rest_api_fallback" : "rest_api",
        }
        : {}),
      ...(previous.consecutiveFailures > 0 ? { lastRecoveredAt: timestamp } : {}),
      consecutiveFailures: 0,
      nextAttemptAt: organizationDynamic
        ? new Date(timestampValue.getTime() + dynamicPollIntervalMs).toISOString()
        : null,
      backoffMs: 0,
      lastErrorAt: null,
      lastError: null,
      lastErrorStatus: null,
    };
  }

  function markRepositoryFailure(entry, error) {
    const key = entry.repository.toLowerCase();
    const previous = repositoryHealth(entry.repository) || {};
    const timestamp = now();
    const consecutiveFailures = Math.max(0, Number(previous.consecutiveFailures) || 0) + 1;
    const requestedDelay = Number(error?.retryAfterMs);
    const transportFailure = isGithubTransportFailure(error)
      && !(Number.isFinite(requestedDelay) && requestedDelay > 0);
    const maximumBackoff = transportFailure ? GITHUB_TRANSPORT_RETRY_MAX_MS : retryMaxMs;
    const exponential = Math.min(maximumBackoff, retryBaseMs * (2 ** Math.min(20, consecutiveFailures - 1)));
    const jittered = Math.min(maximumBackoff, Math.max(1_000, Math.round(exponential * (0.8 + (Math.max(0, Math.min(1, random())) * 0.4)))));
    const backoffMs = Number.isFinite(requestedDelay) && requestedDelay > 0
      ? Math.max(jittered, requestedDelay)
      : jittered;
    state._health.repositories[key] = {
      ...previous,
      repository: entry.repository,
      launchpad: entry.launchpad,
      priority: PRIORITY_REPOSITORIES.has(key),
      status: "degraded",
      lastAttemptAt: timestamp.toISOString(),
      firstFailureAt: previous.consecutiveFailures > 0 ? previous.firstFailureAt : timestamp.toISOString(),
      lastErrorAt: timestamp.toISOString(),
      lastError: error?.message || String(error),
      lastErrorStatus: Number.isInteger(error?.status) ? error.status : null,
      consecutiveFailures,
      ...(isOrganizationDynamicRepository(entry) && entry.organizationPushedAt
        ? { lastAttemptedOrganizationPushedAt: entry.organizationPushedAt }
        : {}),
      backoffMs,
      nextAttemptAt: new Date(timestamp.getTime() + backoffMs).toISOString(),
    };
  }

  async function commitsThroughAnchor(repository, lastSha, validators = {}) {
    const commits = [];
    let anchorFound = !lastSha;
    let atom = null;
    let commitApi = null;
    for (let page = 1; page <= 5; page += 1) {
      const result = await listCommits(config, repository, page, page === 1 ? validators : {});
      const batch = result.commits;
      atom ||= result.atom;
      commitApi ||= result.commitApi;
      if (result.atom?.notModified || result.commitApi?.notModified) {
        anchorFound = true;
        break;
      }
      if (!batch.length) break;
      commits.push(...batch);
      if (lastSha && batch.some((commit) => commit.sha === lastSha)) {
        anchorFound = true;
        break;
      }
      if (!config.githubToken || batch.length < 100) break;
    }
    return { commits, anchorFound, atom, commitApi };
  }

  async function processCommit(entry, commit) {
    const { repository, launchpad } = entry;
    const aiOfficial = isOfficialAiRepositoryEntry(entry);
    const binanceOfficial = isOfficialBinanceRepositoryName(repository);
    const fetchedFiles = await commitFiles(config, repository, commit);
    const rawFiles = fetchedFiles
      .filter((file) => aiOfficial
        ? isRelevantModuleFile(file.filename) || AI_REPOSITORY_CONTENT_FILE.test(file.filename)
        : isRelevantRepositoryFile(repository, file.filename));
    if (!rawFiles.length
      || !isSemanticallyRelevantFourMemeChange(repository, commit, rawFiles)
      || !isSemanticallyRelevantBinanceChange(repository, commit, rawFiles)
      || !isSemanticallyRelevantAiChange(repository, commit, rawFiles, { official: aiOfficial })
      || !isSemanticallyRelevantUniswapChange(repository, commit, rawFiles)) return;
    const flapSkillChange = classifyFlapSkillChange(repository, commit.patchMessage || commit.commit.message, rawFiles);
    if (flapSkillChange?.documentationOnly) return;
    const files = rawFiles.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }));
    const modeChange = aiOfficial ? null : classifyGithubModeChange(commit.commit.message, rawFiles);
    const productChange = aiOfficial ? classifyAiProductChange(repository, commit, rawFiles, { official: true }) : null;
    const chainSupportChange = detectGithubChainSupportChange(repository, commit.commit.message, rawFiles, { stage: "commit" });
    const trust = sourceTrust(entry);
    const addedPatch = rawFiles.map((file) => String(file.patch || "").split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .join("\n")).join("\n");
    const newContracts = aiOfficial ? [] : extractGithubDeploymentAddresses(addedPatch);
    const commitEvidenceMessage = commit.patchMessage || commit.commit.message;
    let githubChange = summarizeGithubChange(rawFiles, {
      repository,
      commitMessage: commitEvidenceMessage,
      stage: "commit",
      basis: commit.atomFallback ? "exact_patch" : "api_patch",
      ...(fetchedFiles.githubCompleteness ? { completeness: fetchedFiles.githubCompleteness } : {}),
    });
    githubChange = mergeFlapSkillGithubChange(githubChange, flapSkillChange);
    const changeEvidence = githubChange.facts;
    const binanceChange = binanceOfficial
      ? classifyBinanceGithubChange(repository, commitEvidenceMessage, rawFiles, changeEvidence)
      : null;
    if (newContracts.length && !modeChange?.candidate) {
      modeChange.candidate = true;
      modeChange.reason = "new_contract_address";
    }
    if (chainSupportChange.candidate && modeChange) {
      modeChange.candidate = true;
      modeChange.reason = "new_chain_support";
    }
    if (flapSkillChange?.candidate && modeChange) {
      modeChange.candidate = true;
      modeChange.reason = flapSkillChange.reason;
      modeChange.labels = flapSkillChange.labels;
      modeChange.identifiers = flapSkillChange.identifiers;
    }
    if (trust === "unverified_candidate" && !modeChange?.candidate && !newContracts.length) return;
    const eventChainContext = githubEventChainContext(entry, chainSupportChange);
    const event = {
      type: "github_module_update",
      launchpad,
      repository,
      sourceTrust: trust,
      verification: trust === "official_verified"
        ? { status: "official_verified", evidence: entry.officialEvidence || null }
        : { status: "unverified", reason: "repository_not_backlinked_by_official_sources" },
      commit: commit.sha,
      message: commit.commit.message.split("\n")[0],
      author: commit.commit.author?.name || commit.author?.login || "unknown",
      committedAt: commit.commit.committer?.date || commit.commit.author?.date || null,
      files,
      diffStatsAvailable: !commit.atomFallback,
      newContracts,
      changeEvidence,
      githubChange,
      ...(flapSkillChange ? { flapSkillChange } : {}),
      ...(flapSkillChange?.candidate ? { eventKey: `github:${repository.toLowerCase()}:flap-skill:${flapSkillChange.fingerprint}` } : {}),
      ...(binanceChange ? { binanceChange } : {}),
      ...(modeChange ? { modeChange } : {}),
      ...eventChainContext,
      ...(entry.uniswapOfficial ? { uniswapOfficial: true, strong: modeChange.candidate || newContracts.length > 0 } : {}),
      ...(binanceOfficial ? {
        binanceOfficial: true,
        strong: binanceChange
          ? binanceChange.substantive === true
          : modeChange.candidate || BINANCE_GITHUB_HIGH_SIGNAL.test(`${commit.commit.message}\n${addedPatch}`),
      } : {}),
      ...(aiOfficial ? {
        xaiOfficial: true,
        product: aiProductForRepository(repository),
        productChange,
        strong: true,
        ...(entry.officialOrganization ? { officialOrganization: entry.officialOrganization } : {}),
      } : {}),
      ...(chainSupportChange.candidate ? { chainSupportChange, strong: true } : {}),
      ...(flapSkillChange?.candidate ? { strong: true } : {}),
      url: commit.html_url || `https://github.com/${repository}/commit/${commit.sha}`,
      observedAt: now().toISOString(),
    };
    const alertResult = await alertSender(config, event);
    if ((aiOfficial || binanceOfficial) && !isAcceptedAiGithubAlertDelivery(alertResult)) {
      const status = typeof alertResult === "object" && alertResult
        ? String(alertResult.status || alertResult.reason || "unknown")
        : String(alertResult);
      const error = new Error(`Official GitHub alert was not durably accepted for ${repository}@${commit.sha}: ${status}`);
      error.name = "GithubAlertDurabilityError";
      error.delivery = alertResult;
      throw error;
    }
    const discoveryChainId = githubBscDiscoveryChainId(entry, chainSupportChange);
    if (newContracts.length && dependencies.onContractDiscovery && discoveryChainId === 56) {
      try {
        await Promise.resolve(dependencies.onContractDiscovery({
          addresses: newContracts,
          platformName: launchpad,
          sourceTrust: trust,
          sourceId: `github:${repository.toLowerCase()}`,
          sourceUrl: event.url,
          chainId: discoveryChainId,
          observedAt: event.observedAt,
        }));
      } catch (error) {
        const failure = new Error(`GitHub contract discovery failed for ${repository}: ${error?.message || error}`);
        failure.cause = error;
        failure.retryAfterMs = error?.retryAfterMs;
        throw failure;
      }
    }
  }

  async function processPullRequest(entry, pullRequest) {
    const { repository, launchpad } = entry;
    const number = Number(pullRequest?.number);
    const headSha = pullRequestHeadSha(pullRequest);
    if (!Number.isSafeInteger(number) || number <= 0 || !headSha) return false;
    const message = String(pullRequest.title || "GitHub pull request").trim();
    const syntheticCommit = { commit: { message: `${message}\n${pullRequest.body || ""}` } };
    const fetchedFiles = await pullRequestFiles(config, repository, number);
    const rawFiles = fetchedFiles
      .filter((file) => isRelevantRepositoryFile(repository, file.filename));
    if (!rawFiles.length
      || !isSemanticallyRelevantFourMemeChange(repository, syntheticCommit, rawFiles)
      || !isSemanticallyRelevantBinanceChange(repository, syntheticCommit, rawFiles)
      || !isSemanticallyRelevantUniswapChange(repository, syntheticCommit, rawFiles)) return false;
    const flapSkillChange = classifyFlapSkillChange(repository, `${message}\n${pullRequest.body || ""}`, rawFiles);
    if (flapSkillChange?.documentationOnly) return false;

    const files = rawFiles.map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
    }));
    const content = [message, pullRequest.body || "", ...rawFiles.map((file) => `${file.filename}\n${file.patch || ""}`)].join("\n");
    const addedPatch = rawFiles.map((file) => String(file.patch || "").split("\n")
      .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
      .join("\n")).join("\n");
    const newContracts = extractGithubDeploymentAddresses(addedPatch);
    let githubChange = summarizeGithubChange(rawFiles, {
      repository,
      commitMessage: `${message}\n${pullRequest.body || ""}`,
      stage: "pull_request",
      basis: "pull_request_snapshot",
      ...(fetchedFiles.githubCompleteness ? { completeness: fetchedFiles.githubCompleteness } : {}),
    });
    githubChange = mergeFlapSkillGithubChange(githubChange, flapSkillChange);
    const changeEvidence = githubChange.facts;
    const binanceChange = isOfficialBinanceRepositoryName(repository)
      ? classifyBinanceGithubChange(repository, `${message}\n${pullRequest.body || ""}`, rawFiles, changeEvidence)
      : null;
    const modeChange = classifyGithubModeChange(message, rawFiles);
    const chainSupportChange = detectGithubChainSupportChange(repository, `${message}\n${pullRequest.body || ""}`, rawFiles, { stage: "pr" });
    const structuralSignal = GITHUB_PR_STRUCTURAL_SIGNAL.test(content);
    const binanceStructuralSignal = isOfficialBinanceRepositoryName(repository) && BINANCE_GITHUB_HIGH_SIGNAL.test(content);
    if (GITHUB_PR_TRIVIAL_NOISE.test(content) && !structuralSignal && !newContracts.length && !chainSupportChange.candidate) return false;
    if (!modeChange.candidate && structuralSignal) {
      modeChange.candidate = true;
      modeChange.reason = "pull_request_structural_feature";
    }
    if (!modeChange.candidate && binanceStructuralSignal) {
      modeChange.candidate = true;
      modeChange.reason = "binance_official_product_or_api_change";
    }
    if (!modeChange.candidate && binanceChange?.substantive === true) {
      modeChange.candidate = true;
      modeChange.reason = "binance_structured_semantic_diff";
    }
    if (newContracts.length && !modeChange.candidate) {
      modeChange.candidate = true;
      modeChange.reason = "pull_request_contract_address";
    }
    if (chainSupportChange.candidate) {
      modeChange.candidate = true;
      modeChange.reason = "new_chain_support";
    }
    if (flapSkillChange?.candidate) {
      modeChange.candidate = true;
      modeChange.reason = flapSkillChange.reason;
      modeChange.labels = flapSkillChange.labels;
      modeChange.identifiers = flapSkillChange.identifiers;
    }
    if (!modeChange.candidate && !newContracts.length && !chainSupportChange.candidate) return false;

    const trust = sourceTrust(entry);
    if (trust !== "official_verified") return false;
    const cursor = pullRequestCursor(pullRequest);
    const eventChainContext = githubEventChainContext(entry, chainSupportChange);
    const event = {
      type: "github_module_update",
      launchpad,
      repository,
      sourceTrust: trust,
      verification: { status: "official_verified", evidence: entry.officialEvidence || null },
      commit: `pr-${number}-${cursor.slice(0, 12)}`,
      headCommit: headSha,
      message,
      author: pullRequest.user?.login || "unknown",
      committedAt: pullRequest.updated_at || pullRequest.created_at || null,
      files,
      diffStatsAvailable: true,
      newContracts,
      changeEvidence,
      githubChange,
      ...(flapSkillChange ? { flapSkillChange } : {}),
      ...(flapSkillChange?.candidate ? { eventKey: `github:${repository.toLowerCase()}:flap-skill:${flapSkillChange.fingerprint}` } : {}),
      authorAssociation: pullRequest.author_association || null,
      ...(binanceChange ? { binanceChange } : {}),
      modeChange,
      developmentStage: "pull_request",
      pullRequest: {
        number,
        state: pullRequest.state || "open",
        draft: pullRequest.draft === true,
        createdAt: pullRequest.created_at || null,
        updatedAt: pullRequest.updated_at || null,
        headCommit: headSha,
        authorAssociation: pullRequest.author_association || null,
      },
      onchainConfirmed: false,
      ...eventChainContext,
      ...(entry.uniswapOfficial ? { uniswapOfficial: true, strong: true } : { strong: true }),
      ...(isOfficialBinanceRepositoryName(repository) ? {
        binanceOfficial: true,
        strong: binanceChange?.substantive === true,
      } : {}),
      ...(chainSupportChange.candidate ? { chainSupportChange } : {}),
      url: pullRequest.html_url || `https://github.com/${repository}/pull/${number}`,
      observedAt: now().toISOString(),
    };
    await alertSender(config, event);
    const discoveryChainId = githubBscDiscoveryChainId(entry, chainSupportChange);
    if (trust === "official_verified"
      && newContracts.length
      && dependencies.onContractDiscovery
      && discoveryChainId === 56) {
      try {
        await Promise.resolve(dependencies.onContractDiscovery({
          addresses: newContracts,
          platformName: launchpad,
          sourceTrust: trust,
          sourceId: `github:${repository.toLowerCase()}`,
          sourceUrl: event.url,
          chainId: discoveryChainId,
          observedAt: event.observedAt,
        }));
      } catch (error) {
        const failure = new Error(`GitHub pull request contract discovery failed for ${repository}: ${error?.message || error}`);
        failure.cause = error;
        failure.retryAfterMs = error?.retryAfterMs;
        throw failure;
      }
    }
    return true;
  }

  function pullRequestRepositoryState(repository) {
    return state._pullRequests.repositories[repository.toLowerCase()] || null;
  }

  function canAttemptPullRequestRepository(repository) {
    const key = repository.toLowerCase();
    if (startupPullRequestTransportProbePending.delete(key)) return true;
    const nextAttemptAt = Date.parse(pullRequestRepositoryState(repository)?.nextAttemptAt || "");
    return !Number.isFinite(nextAttemptAt) || now().getTime() >= nextAttemptAt;
  }

  function markPullRequestRepositoryFailure(entry, error) {
    const key = entry.repository.toLowerCase();
    const previous = pullRequestRepositoryState(entry.repository) || {};
    const timestamp = now();
    const consecutiveFailures = Math.max(0, Number(previous.consecutiveFailures) || 0) + 1;
    const requestedDelay = Number(error?.retryAfterMs);
    const transportFailure = isGithubTransportFailure(error)
      && !(Number.isFinite(requestedDelay) && requestedDelay > 0);
    const maximumBackoff = transportFailure ? GITHUB_TRANSPORT_RETRY_MAX_MS : 3_600_000;
    const exponential = Math.min(maximumBackoff, 60_000 * (2 ** Math.min(6, consecutiveFailures - 1)));
    const backoffMs = Number.isFinite(requestedDelay) && requestedDelay > 0
      ? Math.max(exponential, requestedDelay)
      : exponential;
    state._pullRequests.repositories[key] = {
      ...previous,
      repository: entry.repository,
      launchpad: entry.launchpad,
      status: "degraded",
      consecutiveFailures,
      lastAttemptAt: timestamp.toISOString(),
      lastErrorAt: timestamp.toISOString(),
      lastError: error?.message || String(error),
      lastErrorStatus: Number.isInteger(error?.status) ? error.status : null,
      backoffMs,
      nextAttemptAt: new Date(timestamp.getTime() + backoffMs).toISOString(),
    };
  }

  async function checkPullRequestRepository(entry) {
    const key = entry.repository.toLowerCase();
    const previous = pullRequestRepositoryState(entry.repository);
    const pullRequests = await listOpenPullRequests(config, entry.repository);
    const initialized = Boolean(previous?.initializedAt);
    const revisions = { ...(previous?.pullRequests || {}) };

    if (initialized) {
      const changed = pullRequests.filter((pullRequest) => {
        const cursor = pullRequestCursor(pullRequest);
        return cursor && revisions[String(pullRequest.number)]?.cursor !== cursor;
      }).reverse();
      for (const pullRequest of changed) {
        const actionable = await processPullRequest(entry, pullRequest);
        revisions[String(pullRequest.number)] = {
          cursor: pullRequestCursor(pullRequest),
          headSha: pullRequestHeadSha(pullRequest),
          title: String(pullRequest.title || ""),
          updatedAt: pullRequest.updated_at || null,
          lastEvaluatedAt: now().toISOString(),
          actionable,
        };
      }
    } else {
      for (const pullRequest of pullRequests) {
        const cursor = pullRequestCursor(pullRequest);
        if (!cursor) continue;
        revisions[String(pullRequest.number)] = {
          cursor,
          headSha: pullRequestHeadSha(pullRequest),
          title: String(pullRequest.title || ""),
          updatedAt: pullRequest.updated_at || null,
          lastEvaluatedAt: now().toISOString(),
          actionable: null,
        };
      }
    }

    const timestamp = now();
    state._pullRequests.repositories[key] = {
      ...previous,
      repository: entry.repository,
      launchpad: entry.launchpad,
      sourceTrust: sourceTrust(entry),
      initializedAt: previous?.initializedAt || timestamp.toISOString(),
      baselineCount: previous?.baselineCount ?? pullRequests.length,
      pullRequests: revisions,
      openNumbers: pullRequests.map((pullRequest) => Number(pullRequest.number)).filter(Number.isSafeInteger),
      status: "healthy",
      consecutiveFailures: 0,
      lastAttemptAt: timestamp.toISOString(),
      lastSuccessAt: timestamp.toISOString(),
      lastErrorAt: null,
      lastError: null,
      lastErrorStatus: null,
      backoffMs: pullRequestPollIntervalMs,
      nextAttemptAt: new Date(timestamp.getTime() + pullRequestPollIntervalMs).toISOString(),
    };
  }

  async function runPullRequestCheck() {
    if (runningPullRequests) return;
    runningPullRequests = true;
    try {
      await ensureState();
      for (const repository of pullRequestRepositories) {
        const entry = repositories.get(repository);
        if (!entry || sourceTrust(entry) !== "official_verified") continue;
        await withRepositoryLock(entry.repository, async () => {
          if (!canAttemptPullRequestRepository(entry.repository)) return;
          try {
            await checkPullRequestRepository(entry);
          } catch (error) {
            markPullRequestRepositoryFailure(entry, error);
            console.error(`[github-pr] ${entry.repository}: ${error.message}`);
          }
          await writeState();
        });
      }
    } catch (error) {
      console.error(`[github-pr] ${error.message}`);
    } finally {
      runningPullRequests = false;
    }
  }

  function checkPullRequests() {
    if (stopped) return pullRequestsPromise || Promise.resolve();
    if (pullRequestsPromise) return pullRequestsPromise;
    pullRequestsPromise = runPullRequestCheck().finally(() => {
      pullRequestsPromise = null;
    });
    return pullRequestsPromise;
  }

  async function checkRepository(entry) {
    const { repository, launchpad } = entry;
    if (organizationPushGateIsFresh(entry)) return { commitRead: false };
    const record = state[repository] || state[repository.toLowerCase()] || null;
    const lastSha = record?.sha;
    const health = repositoryHealth(repository);
    let { commits, anchorFound, atom, commitApi } = await commitsThroughAnchor(repository, lastSha, record ? {
      atomEtag: health?.atomEtag || null,
      atomBranch: health?.atomBranch || null,
      commitApiEtag: health?.commitApiEtag || null,
    } : {});
    if (atom?.notModified || commitApi?.notModified) return { commitRead: true, atom, commitApi };
    let gapRecovery = null;
    if (lastSha && !anchorFound && !config.githubToken) {
      try {
        gapRecovery = await recoverCommitsThroughAnchorWithoutToken(config, repository, lastSha);
        if (gapRecovery.anchorFound) {
          commits = gapRecovery.commits;
          anchorFound = true;
        }
      } catch (error) {
        gapRecovery = {
          status: "unauthenticated_api_recovery_failed",
          anchorFound: false,
          error: error.message,
          retryAfterMs: Number.isFinite(Number(error.retryAfterMs)) ? Number(error.retryAfterMs) : null,
        };
      }
    }
    if (!commits.length) return {
      commitRead: true,
      ...(record && atom ? { atom } : {}),
      ...(record && commitApi ? { commitApi } : {}),
    };
    if (!lastSha) {
      if (entry.baselineOnly && entry.initialCatchupRequired !== true) {
        state[repository] = {
          sha: commits[0].sha,
          checkedAt: now().toISOString(),
          coverage: { status: "baseline_only", scanned: 0 },
        };
        await writeState();
        return { commitRead: true, atom, commitApi };
      }
      const cutoff = now().getTime() - INITIAL_CATCHUP_MS;
      const catchup = commits.filter((commit, index) => {
        if (index >= INITIAL_CATCHUP_MAX_COMMITS) return false;
        const timestamp = new Date(commit.commit?.committer?.date || commit.commit?.author?.date || 0).getTime();
        return !timestamp || timestamp >= cutoff;
      });
      for (const commit of catchup.reverse()) await processCommit(entry, commit);
      state[repository] = {
        sha: commits[0].sha,
        checkedAt: now().toISOString(),
        initialCatchup: {
          completedAt: now().toISOString(),
          scanned: catchup.length,
          maxCommits: INITIAL_CATCHUP_MAX_COMMITS,
          cutoff: new Date(cutoff).toISOString(),
        },
        coverage: {
          status: "initial_bounded_catchup",
          scanned: catchup.length,
          maxCommits: INITIAL_CATCHUP_MAX_COMMITS,
          cutoff: new Date(cutoff).toISOString(),
        },
      };
      await writeState();
      return { commitRead: true, atom, commitApi };
    }

    const unseen = [];
    for (const commit of commits) {
      if (commit.sha === lastSha) break;
      unseen.push(commit);
    }
    if (!anchorFound) {
      const gap = {
        previousSha: lastSha,
        oldestFetchedSha: commits.at(-1)?.sha || null,
        newestSha: commits[0].sha,
        detectedAt: record?.gap?.detectedAt || now().toISOString(),
        fetchedCommits: commits.length,
        status: "anchor_not_in_bounded_history",
        recovery: gapRecovery || {
          status: config.githubToken ? "authenticated_history_exhausted" : "unauthenticated_recovery_unavailable",
          anchorFound: false,
        },
      };
      if (record?.gap?.newestSha !== gap.newestSha || record?.gap?.previousSha !== gap.previousSha) {
        const trust = sourceTrust(entry);
        const normalizedRepository = repository.toLowerCase();
        const alertObservedAt = now().toISOString();
        // Keep the complete recovery payload in monitor memory/state until the
        // alert boundary has resolved, but never copy a proven-terminal,
        // multi-megabyte commit history into the 30-day durable outbox. The
        // bounded projection retains its range, count, digest, and selected
        // facts, which are all the renderer and delivery retry path require.
        const alertGap = compactPersistedGapRecovery(gap, lastSha, alertObservedAt);
        await alertSender(config, {
          type: "github_monitor_gap",
          eventKey: `github-gap:${repository}:${lastSha}:${commits[0].sha}`,
          repository,
          launchpad,
          sourceTrust: trust,
          verification: trust === "official_verified"
            ? { status: "official_verified", evidence: entry.officialEvidence || null }
            : { status: "unverified", reason: "repository_not_backlinked_by_official_sources" },
          priority: PRIORITY_REPOSITORIES.has(normalizedRepository),
          pollingClass: entry.pollingClass || (PRIORITY_REPOSITORIES.has(normalizedRepository) ? "core_priority" : "configured"),
          ...(entry.officialOrganization ? { officialOrganization: entry.officialOrganization } : {}),
          ...(entry.uniswapOfficial === true ? { uniswapOfficial: true } : {}),
          gap: alertGap,
          url: `https://github.com/${repository}/commits`,
          observedAt: alertObservedAt,
        });
      }
      // Only after the delivery boundary resolves do we replace a proven
      // terminal payload in durable monitor state. Active/unknown recovery
      // payloads remain intact so a future version can resume them.
      const persistedGap = compactPersistedGapRecovery(gap, lastSha, now().toISOString());
      state[repository] = {
        ...record,
        checkedAt: now().toISOString(),
        gap: persistedGap,
        coverage: { status: "gap_unresolved", fetchedCommits: commits.length },
      };
      await writeState();
      const error = new Error(`GitHub coverage gap for ${repository}; cursor remains at ${lastSha}`);
      error.name = "GithubCoverageGapError";
      error.retryAfterMs = gapRecovery?.retryAfterMs;
      throw error;
    }
    for (const commit of unseen.reverse()) {
      await processCommit(entry, commit);
      state[repository] = {
        ...state[repository],
        sha: commit.sha,
        checkedAt: now().toISOString(),
        coverage: { status: anchorFound ? "continuous" : "gap_recorded", fetchedCommits: commits.length },
      };
      await writeState();
    }
    state[repository] = {
      ...state[repository],
      sha: commits[0].sha,
      checkedAt: now().toISOString(),
      ...(anchorFound ? { gap: null, coverage: { status: "continuous", fetchedCommits: commits.length } } : {}),
    };
    await writeState();
    return { commitRead: true, atom, commitApi };
  }

  async function runCheckCycle(priorityOnly) {
    try {
      await ensureState();
      const selected = [];
      for (const entry of repositories.values()) {
        const { repository } = entry;
        const priority = PRIORITY_REPOSITORIES.has(repository.toLowerCase());
        if (priorityOnly !== priority) continue;
        selected.push(entry);
      }
      if (priorityOnly) {
        selected.sort((left, right) => Number(isUnverifiedPonsRepository(left.repository)) - Number(isUnverifiedPonsRepository(right.repository)));
      }
      let healthDirty = false;
      const inspect = async (entry) => {
        const { repository } = entry;
        await withRepositoryLock(repository, async () => {
          const currentEntry = repositories.get(repository.toLowerCase()) || entry;
          const currentlyPriority = PRIORITY_REPOSITORIES.has(repository.toLowerCase());
          if (priorityOnly !== currentlyPriority) return;
          if (!canAttemptRepository(currentEntry)) return;
          try {
            const outcome = await checkRepository(currentEntry);
            markRepositorySuccess(currentEntry, outcome);
            healthDirty = true;
          } catch (error) {
            markRepositoryFailure(currentEntry, error);
            healthDirty = true;
            console.error(`[github] ${repository}: ${error.message}`);
          }
        });
      };
      await runBounded(
        selected,
        priorityOnly
          ? Math.max(1, Number(config.githubPriorityPollConcurrency) || PRIORITY_POLL_CONCURRENCY)
          : regularPollConcurrency,
        inspect,
      );
      if (healthDirty) await writeState();
    } catch (error) {
      console.error(`[github] ${error.message}`);
    }
  }

  function check(priorityOnly = false) {
    const lane = priorityOnly ? checkLanes.priority : checkLanes.regular;
    if (stopped) return lane.runningPromise || Promise.resolve();
    if (lane.runningPromise) {
      lane.rerunRequested = true;
      return lane.runningPromise;
    }
    lane.runningPromise = (async () => {
      // Keep one immediate catch-up when a timer fires during a slow cycle,
      // but do not let a short poll interval hold this lane in a permanent
      // zero-delay loop while an upstream source is degraded.
      for (let cycle = 0; cycle < 2 && !stopped; cycle += 1) {
        lane.rerunRequested = false;
        await runCheckCycle(priorityOnly);
        if (!lane.rerunRequested) break;
      }
      lane.rerunRequested = false;
    })().finally(() => { lane.runningPromise = null; });
    return lane.runningPromise;
  }

  async function runOrganizationCheck() {
    if (runningOrganizations) return;
    runningOrganizations = true;
    let dynamicActivityDetected = false;
    try {
      await ensureState();
      for (const { organization, launchpad, sourceTrust: organizationTrust, baselineOnly, officialEvidence, xaiOfficial } of ORGANIZATION_TARGETS) {
        try {
          const listed = await listOrganizationRepositories(config, organization);
          const visibleRepositories = listed.filter((item) => !item.archived && item.full_name);
          const names = visibleRepositories.map((item) => item.full_name);
          const target = organizationTargetFor(organization);
          const eligibleRepositories = visibleRepositories.filter((item) => repositoryMatchesOrganizationTarget(item.full_name, target));
          const visibleNames = new Set(names.map((repository) => repository.toLowerCase()));
          const eligibleNames = new Set(eligibleRepositories.map((item) => item.full_name.toLowerCase()));
          const listedByName = new Map(visibleRepositories.map((item) => [item.full_name.toLowerCase(), item]));
          const previous = new Set(state._organizations[organization]?.repositories || []);
          const initial = !state._organizations[organization];
          for (const { full_name: repository } of eligibleRepositories) {
            await withRepositoryLock(repository, async () => {
              const normalized = repository.toLowerCase();
              const persistedRecord = Object.entries(state._repositories)
                .find(([candidate]) => candidate.toLowerCase() === normalized);
              const persistedKey = persistedRecord?.[0] || repository;
              const current = repositories.get(normalized) || persistedRecord?.[1];
              const newlyDiscovered = !initial && !previous.has(repository);
              const repositoryInfo = listedByName.get(normalized) || {};
              const repositoryMetadata = {
                description: repositoryInfo.description || null,
                createdAt: repositoryInfo.created_at || null,
                pushedAt: repositoryInfo.pushed_at || repositoryInfo.updated_at || null,
                language: repositoryInfo.language || null,
                topics: Array.isArray(repositoryInfo.topics) ? repositoryInfo.topics.slice(0, 12) : [],
                homepage: repositoryInfo.homepage || null,
              };
              const listedPushedAt = repositoryInfo.pushed_at || repositoryInfo.updated_at || null;
              const configured = configuredRepositories.get(normalized);
              const explicitlyConfigured = Boolean(configured
                && !configured.officialOrganization
                && !isOrganizationDynamicRepository(configured));
              const explicitlyPriority = CORE_PRIORITY_REPOSITORIES.has(normalized)
                || (explicitlyConfigured && configured?.priority === true);
              const entry = {
                ...current,
                repository,
                launchpad: configured?.launchpad || launchpad,
                priority: explicitlyPriority,
                pollingClass: explicitlyPriority ? "core_priority" : explicitlyConfigured ? "configured" : "organization_dynamic",
                officialOrganization: organization,
                sourceTrust: configured?.sourceTrust || organizationTrust,
                organizationPushedAt: listedPushedAt || current?.organizationPushedAt || null,
                organizationMetadataAt: listedPushedAt ? now().toISOString() : (current?.organizationMetadataAt || null),
                ...(organization.toLowerCase() === "uniswap" ? { uniswapOfficial: true } : {}),
                ...(xaiOfficial ? {
                  xaiOfficial: true,
                  product: aiProductForRepository(repository),
                  repositoryMetadata,
                } : {}),
                ...(configured?.baselineOnly === true || baselineOnly ? { baselineOnly: true } : {}),
                ...(newlyDiscovered && !explicitlyConfigured && organizationTrust === "official_verified"
                  ? { initialCatchupRequired: true }
                  : {}),
                ...(configured?.officialEvidence || officialEvidence
                  ? { officialEvidence: configured?.officialEvidence || officialEvidence }
                  : {}),
              };
              delete entry.active;
              delete entry.inactiveReason;
              delete entry.inactiveAt;
              delete entry.inactiveOrganizationSnapshotAt;
              if (explicitlyConfigured && configured?.baselineOnly === true) delete entry.initialCatchupRequired;
              const sourceEnabled = isMonitoringSourceEnabled(config, entry)
                || (xaiOfficial === true
                  && config.xaiOfficialMonitorEnabled === true
                  && isOfficialAiRepositoryEntry(entry));
              if (!sourceEnabled) return;
              if (isOrganizationDynamicRepository(entry)
                && current
                && listedPushedAt
                && listedPushedAt !== current.organizationPushedAt) dynamicActivityDetected = true;
              repositories.set(normalized, entry);
              if (explicitlyPriority) PRIORITY_REPOSITORIES.add(normalized);
              else PRIORITY_REPOSITORIES.delete(normalized);
              state._repositories[persistedKey] = entry;
              if (newlyDiscovered) {
                // A repository discovered after the organization baseline is a
                // source event, not a cold-start baseline. Read its bounded
                // first commits immediately; each commit keeps its own source
                // timestamp so stale recovery remains freshness-suppressed.
                dynamicActivityDetected = true;
                if (xaiOfficial && !aiRepositoryDiscoverySignal(repository, repositoryMetadata)) {
                  return;
                }
                const binanceOfficial = organization.toLowerCase() === "binance"
                  && organizationTrust === "official_verified";
                const binanceProductRepository = binanceOfficial
                  && binanceRepositoryDiscoverySignal(repository, repositoryMetadata);
                await alertSender(config, {
                  type: "github_repository_discovered",
                  launchpad,
                  repository,
                  sourceTrust: organizationTrust,
                  ...(organizationTrust === "official_verified" ? {
                    officialOrganization: organization,
                    officialEvidence,
                  } : {}),
                  ...(binanceProductRepository ? {
                    product: { id: "binance-agent-platform", name: "Binance Agent Platform" },
                    strong: true,
                  } : {}),
                  ...(xaiOfficial ? {
                    xaiOfficial: true,
                    officialOrganization: organization,
                    officialEvidence,
                    product: aiProductForRepository(repository),
                    strong: true,
                  } : {}),
                  address: null,
                  createdAt: repositoryMetadata.createdAt,
                  repositoryMetadata,
                  url: repositoryInfo.html_url || `https://github.com/${repository}`,
                  observedAt: now().toISOString(),
                });
              }
            });
          }
          const organizationObservedAt = now().toISOString();
          for (const [repository, persistedEntry] of Object.entries(state._repositories)) {
            const normalized = repository.toLowerCase();
            if (String(persistedEntry?.officialOrganization || "").toLowerCase() !== organization.toLowerCase()) continue;
            const configured = configuredRepositories.get(normalized);
            const explicitlyConfigured = Boolean(configured
              && !configured.officialOrganization
              && !isOrganizationDynamicRepository(configured));
            if (CORE_PRIORITY_REPOSITORIES.has(normalized) || explicitlyConfigured) continue;
            const current = repositories.get(normalized) || persistedEntry;
            if (!isOrganizationDynamicRepository(current) || eligibleNames.has(normalized)) continue;
            await withRepositoryLock(repository, async () => {
              const latest = repositories.get(normalized) || state._repositories[repository] || persistedEntry;
              if (!isOrganizationDynamicRepository(latest)) return;
              repositories.delete(normalized);
              PRIORITY_REPOSITORIES.delete(normalized);
              state._repositories[repository] = {
                ...latest,
                priority: false,
                pollingClass: "organization_dynamic",
                active: false,
                inactiveReason: visibleNames.has(normalized)
                  ? "organization_discovery_filter"
                  : "organization_repository_absent",
                inactiveAt: latest.inactiveAt || organizationObservedAt,
                inactiveOrganizationSnapshotAt: organizationObservedAt,
              };
            });
          }
          state._organizations[organization] = {
            repositories: names.sort(),
            checkedAt: organizationObservedAt,
            lastSuccessAt: organizationObservedAt,
            lastError: null,
          };
          await writeState();
        } catch (error) {
          state._organizations[organization] = {
            ...state._organizations[organization],
            checkedAt: now().toISOString(),
            lastErrorAt: now().toISOString(),
            lastError: error.message,
          };
          await writeState();
          console.error(`[github-org] ${organization}: ${error.message}`);
        }
      }
    } finally {
      runningOrganizations = false;
    }
    if (dynamicActivityDetected) await check(false);
  }

  function checkOrganizations() {
    if (stopped) return organizationPromise || Promise.resolve();
    if (organizationPromise) return organizationPromise;
    organizationPromise = runOrganizationCheck().finally(() => {
      organizationPromise = null;
    });
    return organizationPromise;
  }

  async function runContractDiscovery(address, launchpad = "未知候选") {
    if (!config.githubToken || !address || !isMonitoringSourceEnabled(config, launchpad)) return [];
    try {
      const result = await github(config, `/search/code?q=${encodeURIComponent(`\"${address}\"`) }&per_page=10`);
      const found = [];
      for (const item of result.items || []) {
        const repository = item.repository?.full_name;
        if (!repository || isUnverifiedPonsRepository(repository) || repositories.has(repository.toLowerCase())) continue;
        const entry = { repository, launchpad };
        repositories.set(repository.toLowerCase(), entry);
        await ensureState();
        state._repositories[repository] = entry;
        await writeState();
        found.push(entry);
        await alertSender(config, { type: "github_repository_discovered", launchpad, repository, address, url: item.repository.html_url, observedAt: now().toISOString() });
      }
      return found;
    } catch (error) {
      console.error(`[github-discovery] ${address}: ${error.message}`);
      return [];
    }
  }

  function discoverByContract(address, launchpad = "未知候选") {
    if (stopped) return Promise.resolve([]);
    const operation = runContractDiscovery(address, launchpad);
    externalOperations.add(operation);
    void operation.then(
      () => externalOperations.delete(operation),
      () => externalOperations.delete(operation),
    );
    return operation;
  }

  async function runOfficialRepositoryConfirmation(repository, evidence = {}) {
    if (!/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/i.test(repository || "")) return null;
    await ensureState();
    return withRepositoryLock(repository, async () => {
      const normalized = repository.toLowerCase();
      const current = repositories.get(normalized);
      const launchpad = String(evidence.launchpad || current?.launchpad || "pons").trim() || "pons";
      if (!isMonitoringSourceEnabled(config, { ...current, repository, launchpad })) return null;
      const launchpadName = String(evidence.launchpadName || current?.launchpadName || launchpad).trim() || launchpad;
      const wasVerified = current?.sourceTrust === "official_verified";
      if (wasVerified
        && current.launchpad === launchpad
        && current.officialEvidence?.source === (evidence.source || "official_platform_source")
        && current.officialEvidence?.url === (evidence.url || null)) {
        return current;
      }
      const entry = {
        ...current,
        repository,
        launchpad,
        launchpadName,
        priority: true,
        baselineOnly: current?.baselineOnly ?? true,
        sourceTrust: "official_verified",
        officialEvidence: {
          source: evidence.source || "official_platform_source",
          url: evidence.url || null,
          observedAt: evidence.observedAt || now().toISOString(),
        },
      };
      repositories.set(normalized, entry);
      PRIORITY_REPOSITORIES.add(normalized);
      state._repositories[repository] = entry;
      await writeState();
      if (!wasVerified && evidence.suppressAlert !== true) {
        await alertSender(config, {
          type: "github_repository_verified",
          launchpad,
          launchpadName,
          repository,
          sourceTrust: "official_verified",
          evidence: entry.officialEvidence,
          url: `https://github.com/${repository}`,
          observedAt: now().toISOString(),
        });
      }
      return entry;
    });
  }

  function confirmOfficialRepository(repository, evidence = {}) {
    if (stopped) return Promise.resolve(null);
    const operation = runOfficialRepositoryConfirmation(repository, evidence);
    externalOperations.add(operation);
    void operation.then(
      () => externalOperations.delete(operation),
      () => externalOperations.delete(operation),
    );
    return operation;
  }

  let timer = null;
  let priorityTimer = null;
  let priorityPhaseTimer = null;
  let organizationTimer = null;
  let pullRequestTimer = null;
  if (dependencies.autoStart !== false) {
    void check(false);
    void check(true);
    void checkOrganizations();
    void checkPullRequests();
    timer = setIntervalImpl(() => check(false), regularSchedulerIntervalMs);
    timer.unref();
    // Keep both startup probes immediate, then spread recurring repository
    // traffic evenly across the minute without weakening either lane.
    priorityPhaseTimer = setTimeoutImpl(() => {
      priorityPhaseTimer = null;
      if (stopped) return;
      const checking = check(true);
      priorityTimer = setIntervalImpl(() => check(true), priorityPollIntervalMs);
      priorityTimer.unref();
      return checking;
    }, GITHUB_PRIORITY_PHASE_OFFSET_MS);
    priorityPhaseTimer.unref?.();
    organizationTimer = setIntervalImpl(() => void checkOrganizations(), organizationPollIntervalMs);
    organizationTimer.unref();
    // Wake every minute so transport failures recover quickly. Healthy public
    // repositories retain their per-repository ten-minute due time.
    pullRequestTimer = setIntervalImpl(() => void checkPullRequests(), GITHUB_TOKEN_PR_MIN_INTERVAL_MS);
    pullRequestTimer.unref();
  }
  return {
    check,
    checkOrganizations,
    checkPullRequests,
    discoverByContract,
    confirmOfficialRepository,
    pollingIntervals: {
      priorityRepositoryMs: priorityPollIntervalMs,
      regularSchedulerMs: regularSchedulerIntervalMs,
      dynamicRepositoryMs: dynamicPollIntervalMs,
      organizationMs: organizationPollIntervalMs,
      requestTimeoutMs: requestTimeoutMs(config),
    },
    stop: () => {
      if (stopPromise) return stopPromise;
      stopped = true;
      checkLanes.priority.rerunRequested = false;
      checkLanes.regular.rerunRequested = false;
      if (timer) clearIntervalImpl(timer);
      if (priorityTimer) clearIntervalImpl(priorityTimer);
      if (priorityPhaseTimer) clearTimeoutImpl(priorityPhaseTimer);
      if (organizationTimer) clearIntervalImpl(organizationTimer);
      if (pullRequestTimer) clearIntervalImpl(pullRequestTimer);
      timer = null;
      priorityTimer = null;
      priorityPhaseTimer = null;
      organizationTimer = null;
      pullRequestTimer = null;
      const inFlight = [
        checkLanes.priority.runningPromise,
        checkLanes.regular.runningPromise,
        organizationPromise,
        pullRequestsPromise,
        ...externalOperations,
      ].filter(Boolean);
      stopPromise = (async () => {
        await Promise.allSettled(inFlight);
        await Promise.allSettled([...repositoryLocks.values()]);
        await writeQueue;
      })();
      return stopPromise;
    },
  };
}
