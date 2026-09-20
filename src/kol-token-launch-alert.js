import {
  capitalKolCatalogFreshness,
  verifyCapitalKolEventSnapshot,
} from "./capital-kol-catalog.js";

const MAX_LINE_LENGTH = 150;
const BSC_CHAIN_ID = 56;
const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/u;
const X_ID = /^[1-9]\d{0,20}$/u;
const X_POST_URL = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d{0,20})\/?(?:[?#].*)?$/iu;
const X_PROFILE_URL = /^https:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?(?:[?#].*)?$/iu;
const BACKGROUND_STATUSES = new Set(["primary_verified", "self_described", "unverified"]);
const SECURITY_DECISIONS = new Set(["pass", "watch", "block", "unknown"]);
const CAPITAL_KOL_IDENTITY_SOURCE = "reviewed_catalog+fxtwitter";
const FIRST_PERSON_LAUNCH_WORDS = /(?:\b(?:(?:i|we)(?:['’]ve|\s+have)?\s+(?:just\s+)?(?:launched|created|deployed|issued|released)\s+(?:(?:my|our)\s+)?(?:new\s+)?(?:token|coin|memecoin|meme\s+coin)|(?:my|our)\s+(?:new\s+)?(?:token|coin|memecoin|meme\s+coin)\s+(?:is\s+)?(?:live|launched|deployed))\b|(?:我|我们)(?:刚刚|刚|今天|今日|现已|已经|已|正式)?(?:(?:发了|发行了?|创建了?|部署了?|上线了?)(?:一个|一枚|这个|我的|我们的)?(?:新)?(?:代币|币|土狗|meme(?:币)?)|发币)|(?:这是)?(?:我|我们)(?:刚刚|刚)?发(?:行)?的(?:新)?(?:代币|币|meme(?:币)?)|(?:我的|我们的)(?:新)?(?:代币|币|meme(?:币)?)(?:已经|正式)?(?:上线|发行|发布))/iu;
const NEGATIVE_LAUNCH_WORDS = /(?:\b(?:(?:do\s+not|don['’]?t|dont|not|never|avoid|stop)\s+(?:buy(?:ing)?|ape|enter|long|accumulat\w*)|(?:sell(?:ing)?|sold|dump(?:ed|ing)?|exit(?:ed|ing)?|closed?\s+(?:my\s+)?position|short(?:ed|ing)?|scam(?:\s+warning)?|warning|warn(?:ing)?|beware|honeypot|rug(?:ged|ging)?))\b|不要买|别买|勿买|别冲|卖出|卖了|清仓|止损|做空|骗局|诈骗|警告|谨防|貔貅|跑路)/iu;
const CONTRACT = /(?<![0-9A-Fa-f])0x[0-9A-Fa-f]{40}(?![0-9A-Fa-f])/gu;
const EXPLICIT_CA_CONTRACT = /(?:\bCA\b|\bcontract\s+address\b|\btoken\s+address\b|(?:代币)?合约地址)\s*(?::|：|=|-|is|是)?\s*(0x[0-9A-Fa-f]{40})(?![0-9A-Fa-f])/giu;
const RECENT_LAUNCH_CONTEXT = /(?:\b(?:just|now|today|newly|live)\b|刚刚|刚|今天|今日|现已|正式上线|刚上线)/iu;
const NARROW_SELF_LAUNCH_OPENING = /^(?:\s*)(?:(?:i|we)(?:['’]ve|\s+have)?\s+(?:just\s+)?(?:launched|created|deployed|issued|released)\s+(?:my|our)\s+(?:new\s+)?(?:token|coin|memecoin|meme\s+coin)\b|(?:我|我们)(?:刚刚|刚|今天|今日|现已|正式)?(?:(?:发了|发行了?|创建了?|部署了?)(?:一个|一枚|我的|我们的|这个)?(?:新)?(?:代币|币|土狗|meme(?:币)?)|发币))/iu;
const EXACT_ENGLISH_PERSON_DECLARATION = /^\s*i(?:['’]ve|\s+have)?\s+(?:just\s+)?(?:launched|created|deployed|issued|released)\s+my\s+(?:new\s+)?(?:token|coin|memecoin|meme\s+coin)(?:\s+\$[A-Za-z0-9_]{1,16})?(?:\s+(?:today|now))?\s+on\s+(?:BSC|BNB\s+(?:Smart\s+)?Chain)(?:\s+(?:today|now))?\s*[.!;,]\s*(?:official\s+)?(?:CA|contract\s+address|token\s+address)\s*(?:(?::|=|is)\s*)?0x[0-9a-f]{40}\s*[.!]?\s*$/iu;
const EXACT_CHINESE_PERSON_DECLARATION = /^\s*我(?:刚刚|刚|今天|今日|现已|正式)?(?:(?:发了|发行了?|创建了?|部署了?)(?:一个|一枚|我的|这个)?(?:新)?(?:代币|币|土狗|meme(?:币)?)|发币)(?:\s*\$?[A-Za-z0-9_]{1,16})?[，,\s]*(?:今天|今日)?(?:在|于)\s*(?:BSC|BNB\s+(?:Smart\s+)?Chain|BNB链|币安智能链)\s*(?:上)?\s*(?:正式)?\s*(?:上线)?[。.!；;，,\s]*(?:官方)?(?:CA|代币合约地址|合约地址)\s*(?:(?::|：|=|是)\s*)?0x[0-9a-f]{40}\s*[。.!]?\s*$/iu;
const ATTRIBUTED_OR_HYPOTHETICAL = /(?:(?:^|\s)RT\s+@[A-Za-z0-9_]{1,15}\s*:|\b(?:quot(?:e|ed|ing)|repost(?:ed|ing)?|retweet(?:ed|ing)?|according\s+to|impersonat(?:e|ed|ing)|scammer|a\s+report|report\s*:|(?:@[A-Za-z0-9_]{1,15}|[A-Za-z][A-Za-z0-9_.-]{0,31}|founder|someone|they|he|she)\s+(?:said|says|wrote|posted|claimed|announced))\b[\s\S]{0,220}\b(?:i|we)\b|\b(?:if\s+(?:i|we)|imagine\s+(?:i|we)|pretend\s+(?:i|we)|had\s+(?:i|we)|on\s+behalf\s+of|for\s+(?:a|our|my)\s+client|as\s+(?:a|an)\s+(?:contractor|agency|launch\s+service))\b[\s\S]{0,180}\b(?:launch(?:ed)?|issu(?:e|ed)|deploy(?:ed)?)\b|(?:转述|引用|转载|冒充|假冒|骗子|报告|报道|某人|创始人|有人|他说|她说)[\s\S]{0,80}(?:说|称|表示|写道|宣布|：|:)[\s\S]{0,180}(?:我|我们)|(?:如果|假如|假设|要是|想象|代客户|替客户|受托|代发服务商|客户项目)[\s\S]{0,180}(?:我|我们|发币|发行|上线))/iu;
const QUOTED_FIRST_PERSON_LAUNCH = /["“‘][^"”’\n]{0,260}(?:\b(?:i|we)\b|我|我们)[^"”’\n]{0,220}(?:launch(?:ed)?|deploy(?:ed)?|issu(?:e|ed)|发币|发了|发行|上线)[^"”’\n]{0,100}["”’]/iu;
const THIRD_PARTY_LAUNCH_SERVICE = /(?:\b(?:as\s+(?:a|an)\s+(?:contractor|agency|launch\s+service)|on\s+behalf\s+of|for\s+(?:a|our|my|the)\s+client)\b|作为?(?:代发服务商|承包商|代理机构)|代客户|替客户|客户项目)/iu;
const DENIAL_CONTEXT = /(?:\b(?:not\s+true|false\s*[:,-]|is\s+a\s+lie|that(?:'s|\s+is)\s+a\s+lie|i\s+(?:deny|denied)|we\s+(?:deny|denied)|did\s+not\s+launch|didn['’]?t\s+launch|never\s+launched|not\s+(?:my|our)\s+token)\b|我(?:要)?否认|我们(?:要)?否认|不是我(?:们)?发的|我(?:们)?没(?:有)?发币|不是真的|这是谎言|是假的)/iu;
const TESTNET_CONTEXT = /(?:\b(?:testnet|test\s+network|devnet|sepolia|holesky)\b|测试网|开发网)/iu;
const BSC_CONTEXT = /(?:\bBSC\b|\bBNB\s+(?:Smart\s+)?Chain\b|币安智能链|BNB链)/iu;
const OTHER_CHAIN_CONTEXT = /(?:\bEthereum\b|\bETH\s+(?:chain|mainnet|network)\b|\bBase\b|\bArbitrum\b|\bOptimism\b|\bPolygon\b|\bAvalanche\b|\bSolana\b|\bSui\b|\bAptos\b|\bTRON\b|\bTron\s+(?:chain|mainnet|network)\b|\bTON\b|\bTON\s+(?:chain|mainnet|network)\b|\bTelegram\s+Open\s+Network\b|以太坊|Base链|Solana链|索拉纳|Arbitrum链|波场|TON链)/iu;
const HISTORICAL_LAUNCH_CONTEXT = /(?:\b(?:since|back\s+in|in)\s+(?:19|20)\d{2}\b|\b(?:last\s+(?:month|year)|months?\s+ago|years?\s+ago|historical(?:ly)?|previously|old\s+post|archiv(?:e|ed|ing))\b|自(?:19|20)\d{2}年|(?:19|20)\d{2}年(?:时|就|已)|上个月|去年|多年前|历史上|曾经|旧帖|归档)/iu;
const NON_LITERAL_LAUNCH_CONTEXT = /(?:\b(?:joke|joking|just\s+kidding|sarcasm|sarcastic|example|demo|fictional|parody|satire|pretend|april\s+fools?)\b|玩笑|开玩笑|反讽|举例|示例|虚构|恶搞|整活|愚人节)/iu;
const ADDRESS_DISCLAIMER_CONTEXT = /(?:\b(?:wrong|old|former|treasury|deployer|donation)\b[^\n]{0,48}\b(?:CA|contract(?:\s+address)?|token\s+address)\b|\b(?:do\s+not|don['’]?t|never)\s+use\b[^\n]{0,72}\b(?:CA|contract(?:\s+address)?|token\s+address)\b|\b(?:CA|contract(?:\s+address)?|token\s+address)\b[^\n]{0,72}\b(?:wrong|old|former|treasury|deployer|donation|wallet|tbd|to\s+follow|later|do\s+not\s+use)\b|(?:错误|旧|原|金库|部署者|捐赠)(?:的)?合约地址|(?:不要使用|别用|勿用)[^\n]{0,48}(?:CA|合约地址)|(?:CA|合约地址)[^\n]{0,48}(?:错误|旧|金库|部署者|捐赠|钱包|待定|稍后|不要使用|别用|勿用))/iu;
const BSC_NEGATION_OR_DELAY = /(?:\b(?:not|isn['’]?t|is\s+not)\s+(?:on\s+)?BSC\b|\bBSC\b[^\n]{0,40}\b(?:later|soon|to\s+follow|not\s+yet)\b|(?:不在|不是|尚未|还未)(?:BNB链|币安智能链|BSC)|(?:BNB链|币安智能链|BSC)[^\n]{0,24}(?:稍后|之后|待定|尚未))/iu;

export const KOL_SELF_LAUNCH_SIGNAL_KIND = "kol_self_launch";
export const KOL_TOKEN_LAUNCH_ALERT_MAX_LINE_LENGTH = MAX_LINE_LENGTH;

const cleanHandle = (value) => String(value || "").trim().replace(/^@/u, "");
const lowerAddress = (value) => String(value || "").trim().toLowerCase();
const validIso = (value) => Number.isFinite(Date.parse(value || ""));
const isContractAddress = (value) => ADDRESS.test(value) && !/^0x0{40}$/u.test(value);

const presentClaims = (values) => values
  .filter((value) => value !== undefined && value !== null && String(value).trim() !== "");

function consistentClaim(values, normalize = (value) => String(value).trim()) {
  const present = presentClaims(values);
  const normalized = present.map(normalize);
  return {
    present,
    value: normalized[0] ?? null,
    consistent: normalized.length > 0 && new Set(normalized).size === 1,
  };
}

const oneLine = (value, maximum = 96) => {
  const normalized = String(value || "").replace(/\s+/gu, " ").trim();
  if (normalized.length <= maximum) return normalized;
  return `${normalized.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`;
};

const integer = (value) => Number.isSafeInteger(value) && value >= 0
  ? value.toLocaleString("en-US")
  : null;

const compactUsd = (value) => {
  if (value == null || value === "") return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return null;
  if (number >= 1_000_000) return `$${(number / 1_000_000).toFixed(number >= 10_000_000 ? 0 : 1)}M`;
  if (number >= 1_000) return `$${(number / 1_000).toFixed(number >= 100_000 ? 0 : 1)}k`;
  return `$${number.toFixed(number >= 100 ? 0 : 2)}`;
};

function cstTime(value, language) {
  const time = Date.parse(value || "");
  if (!Number.isFinite(time)) return language === "zh" ? "时间未取得" : "time unavailable";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(time));
  const get = (type) => parts.find((part) => part.type === type)?.value || "00";
  return `${get("month")}-${get("day")} ${get("hour")}:${get("minute")} CST`;
}

function line(value) {
  const normalized = String(value || "").replace(/\s+/gu, " ").trim();
  if (normalized.length > MAX_LINE_LENGTH) {
    throw new RangeError(`KOL launch alert line exceeds ${MAX_LINE_LENGTH} characters`);
  }
  return normalized;
}

function sourceTimes(event) {
  return {
    occurredAt: event?.tweet?.createdAt || event?.sourceOccurredAt || event?.publishedAt,
    observedAt: event?.observedAt,
  };
}

function identityParts(event) {
  const handle = cleanHandle(event?.caller?.handle || event?.handle || event?.tweet?.handle);
  const xUserId = String(event?.caller?.xProfileId || event?.caller?.xUserId || "").trim();
  const tweetId = String(event?.tweet?.id || event?.callId || event?.stableId || "").trim();
  const chainId = Number(event?.chain?.id ?? event?.chain?.chainId ?? event?.chainId);
  const ca = lowerAddress(event?.token || event?.contractAddress);
  return { handle, xUserId, tweetId, chainId, ca };
}

function strictIdentityParts(event) {
  const handle = consistentClaim([
    event?.caller?.handle,
    event?.handle,
    event?.tweet?.handle,
  ], (value) => cleanHandle(value).toLowerCase());
  const xUserId = consistentClaim([
    event?.caller?.xProfileId,
    event?.caller?.xUserId,
    event?.tweet?.xUserId,
    event?.tweet?.authorId,
  ]);
  const tweetId = consistentClaim([
    event?.tweet?.id,
    event?.callId,
    event?.stableId,
  ]);
  const chainId = consistentClaim([
    event?.chain?.id,
    event?.chain?.chainId,
    event?.chainId,
  ], (value) => Number(value));
  const ca = consistentClaim([
    event?.token,
    event?.contractAddress,
  ], lowerAddress);
  return {
    handle: handle.value || "",
    xUserId: xUserId.value || "",
    tweetId: tweetId.value || "",
    chainId: chainId.value,
    ca: ca.value || "",
    consistent: handle.consistent && xUserId.consistent && tweetId.consistent
      && chainId.consistent && ca.consistent,
  };
}

export function classifyKolSelfLaunchText(text) {
  const source = String(text || "");
  if (NEGATIVE_LAUNCH_WORDS.test(source)) {
    return { relevant: false, launchLanguage: false, reason: "negative_exit_or_warning_language", token: null };
  }
  const launchLanguage = FIRST_PERSON_LAUNCH_WORDS.test(source);
  if (!launchLanguage) {
    return { relevant: false, launchLanguage: false, reason: "missing_first_person_launch_language", token: null };
  }
  if (DENIAL_CONTEXT.test(source)) {
    return { relevant: false, launchLanguage: true, reason: "denied_launch_language", token: null };
  }
  if (ATTRIBUTED_OR_HYPOTHETICAL.test(source)
    || QUOTED_FIRST_PERSON_LAUNCH.test(source)
    || THIRD_PARTY_LAUNCH_SERVICE.test(source)) {
    return { relevant: false, launchLanguage: true, reason: "reported_or_hypothetical_launch_language", token: null };
  }
  if (HISTORICAL_LAUNCH_CONTEXT.test(source)) {
    return { relevant: false, launchLanguage: true, reason: "historical_launch_language", token: null };
  }
  if (NON_LITERAL_LAUNCH_CONTEXT.test(source)) {
    return { relevant: false, launchLanguage: true, reason: "non_literal_launch_language", token: null };
  }
  if (!NARROW_SELF_LAUNCH_OPENING.test(source)) {
    return { relevant: false, launchLanguage: true, reason: "not_exact_person_self_declaration", token: null };
  }
  if (!RECENT_LAUNCH_CONTEXT.test(source)) {
    return { relevant: false, launchLanguage: true, reason: "missing_recent_launch_context", token: null };
  }
  if (TESTNET_CONTEXT.test(source)) {
    return { relevant: false, launchLanguage: true, reason: "testnet_launch_not_supported", token: null };
  }
  if (!BSC_CONTEXT.test(source) || OTHER_CHAIN_CONTEXT.test(source) || BSC_NEGATION_OR_DELAY.test(source)) {
    return {
      relevant: false,
      launchLanguage: true,
      reason: OTHER_CHAIN_CONTEXT.test(source) ? "ambiguous_or_unsupported_chain" : "missing_explicit_bsc_chain",
      token: null,
    };
  }
  if (ADDRESS_DISCLAIMER_CONTEXT.test(source)) {
    return { relevant: false, launchLanguage: true, reason: "address_disclaimed_or_not_token_contract", token: null };
  }
  const addresses = [...new Set((source.match(CONTRACT) || []).map(lowerAddress))];
  if (addresses.length !== 1) {
    return {
      relevant: false,
      launchLanguage: true,
      reason: addresses.length ? "ambiguous_contract_addresses" : "missing_contract_address",
      token: null,
    };
  }
  if (!isContractAddress(addresses[0])) {
    return { relevant: false, launchLanguage: true, reason: "invalid_zero_contract_address", token: null };
  }
  const labeledAddresses = [...new Set([...source.matchAll(EXPLICIT_CA_CONTRACT)]
    .map((match) => lowerAddress(match[1])))];
  if (labeledAddresses.length !== 1 || labeledAddresses[0] !== addresses[0]) {
    return { relevant: false, launchLanguage: true, reason: "contract_not_explicitly_labeled_ca", token: null };
  }
  if (!EXACT_ENGLISH_PERSON_DECLARATION.test(source)
    && !EXACT_CHINESE_PERSON_DECLARATION.test(source)) {
    return { relevant: false, launchLanguage: true, reason: "not_exact_person_self_declaration", token: null };
  }
  return {
    relevant: true,
    launchLanguage: true,
    reason: "self_declared_launch_with_exact_contract",
    token: addresses[0],
  };
}

export function isKolSelfLaunchEvent(event) {
  return event?.type === "fomo_family_top_call"
    && event?.signalKind === KOL_SELF_LAUNCH_SIGNAL_KIND;
}

export function kolTokenLaunchEventKey(event) {
  const { xUserId, tweetId, chainId, ca, consistent } = strictIdentityParts(event);
  if (!consistent) return null;
  if (!X_ID.test(xUserId) || !X_ID.test(tweetId)
    || !Number.isSafeInteger(chainId) || chainId < 1 || !isContractAddress(ca)) return null;
  return `kol-self-launch:${xUserId}:${tweetId}:${chainId}:${ca}`;
}

export function kolTokenLaunchCanonicalSignalId(event) {
  const { xUserId, chainId, ca, consistent } = strictIdentityParts(event);
  if (!consistent) return null;
  if (!X_ID.test(xUserId) || !Number.isSafeInteger(chainId) || chainId < 1 || !isContractAddress(ca)) return null;
  return `kol:token-launch:${chainId}:${ca}:x:${xUserId}`;
}

export function kolTokenLaunchCanonicalSignalIds(event) {
  const root = kolTokenLaunchCanonicalSignalId(event);
  return root ? [root, `${root}:self-declared`] : [];
}

/**
 * Closed admission gate for a public X first-person launch declaration.
 * This proves only what the account stated. It deliberately rejects creator
 * attribution and every executable shadow decision. Followers are required
 * for display, but never enter a key, threshold, score, or decision.
 */
export function verifyKolTokenLaunchEvent(event) {
  const reasons = [];
  const fail = (condition, reason) => { if (!condition) reasons.push(reason); };
  const identity = strictIdentityParts(event);
  const { handle, xUserId, tweetId, chainId, ca } = identity;
  const postMatch = String(event?.tweet?.url || "").trim().match(X_POST_URL);
  const profileMatch = String(event?.caller?.twitter || "").trim().match(X_PROFILE_URL);
  const declarationText = consistentClaim([
    event?.tweet?.text,
    event?.body,
    event?.thesis?.text,
  ], (value) => String(value).replace(/\s+/gu, " ").trim());
  const classification = classifyKolSelfLaunchText(event?.tweet?.text);
  const { occurredAt, observedAt } = sourceTimes(event);
  const occurredMs = Date.parse(occurredAt || "");
  const observedMs = Date.parse(observedAt || "");
  const occurrenceClaims = presentClaims([
    event?.sourceOccurredAt,
    event?.tweet?.createdAt,
    event?.publishedAt,
    event?.timestamp,
  ]).map((value) => Date.parse(value));
  const occurrenceClaimsValid = occurrenceClaims.length > 0
    && occurrenceClaims.every(Number.isFinite)
    && Math.max(...occurrenceClaims) - Math.min(...occurrenceClaims) <= 1_000;
  const followerMs = Date.parse(event?.caller?.followersSyncedAt || "");
  const background = event?.caller?.background || {};
  const backgroundAt = Date.parse(background.observedAt || background.checkedAt || "");
  const backgroundProfileMatch = String(background.sourceUrl || "").trim().match(X_PROFILE_URL);
  const identitySource = String(event?.caller?.identitySource || "").toLowerCase();
  const capitalCatalogIdentity = identitySource === CAPITAL_KOL_IDENTITY_SOURCE;
  const capitalCatalogVerification = capitalCatalogIdentity
    ? verifyCapitalKolEventSnapshot(event)
    : { valid: false, reasons: ["not_catalog_identity"], entry: null };
  const callerCapitalSnapshot = event?.caller?.capitalKolSnapshot || null;
  const eventCapitalSnapshot = event?.capitalKolSnapshot || null;
  const capitalSnapshot = callerCapitalSnapshot || eventCapitalSnapshot;
  const callerCapitalBinding = event?.caller?.capitalKolBinding || null;
  const eventCapitalBinding = event?.capitalKolBinding || null;
  const officialBackgroundEvidence = capitalSnapshot?.backgroundEvidence?.find?.((item) => item?.kind === "official_role") || null;
  const poolClaim = consistentClaim([
    event?.market?.poolAddress,
    event?.market?.pairAddress,
    event?.market?.pool,
  ], lowerAddress);
  const expectedEventKey = kolTokenLaunchEventKey(event);
  const expectedCanonicalSignalId = kolTokenLaunchCanonicalSignalId(event);
  const expectedCanonicalSignalIds = kolTokenLaunchCanonicalSignalIds(event);

  fail(isKolSelfLaunchEvent(event), "wrong_event_kind");
  fail(identity.consistent, "identity_claim_conflict");
  fail(event?.launchClaim?.status === "self_declared"
    && event?.launchClaim?.explicitIssuerLanguage === true, "not_explicit_self_declaration");
  fail(declarationText.consistent
    && classification.relevant === true
    && classification.launchLanguage === true
    && classification.token === ca, "self_declaration_text_invalid");
  fail(event?.launchClaim?.onchainCreatorVerified === false
    && !event?.launchClaim?.creator
    && [undefined, null, "not_onchain_verified"].includes(event?.launchClaim?.creatorAttribution),
  "creator_attribution_must_remain_unverified");
  fail(event?.shadow?.decision === "watch"
    && event?.shadow?.executable === false
    && event?.simulationOnly === true
    && event?.shadow?.automaticExecution !== true
    && event?.shadow?.signing !== true
    && event?.shadow?.broadcast !== true, "shadow_must_be_watch_only");
  fail(event?.qualified === false && event?.socialClaimVerified === true,
    "social_claim_must_not_be_trade_qualified");
  fail(event?.shadow?.score == null, "shadow_score_must_be_null");
  fail(event?.strong === false, "kol_launch_must_not_be_strong");

  fail(X_HANDLE.test(handle), "invalid_x_handle");
  fail(X_ID.test(xUserId), "invalid_x_user_id");
  fail(X_ID.test(tweetId), "invalid_tweet_id");
  fail(postMatch?.[1]?.toLowerCase() === handle.toLowerCase() && postMatch?.[2] === tweetId,
    "tweet_url_mismatch");
  fail(profileMatch?.[1]?.toLowerCase() === handle.toLowerCase(), "profile_url_mismatch");
  fail(event?.tweet?.sourceVerifiedBy === "official_x_oembed", "tweet_not_officially_verified");
  fail(event?.tweet?.isQuote !== true && event?.tweet?.isRepost !== true, "quoted_or_reposted_declaration");
  fail(["fomoscan+fxtwitter", "gmgn+fxtwitter"].includes(identitySource)
    || (capitalCatalogIdentity && capitalCatalogVerification.valid
      && capitalKolCatalogFreshness({ nowMs: observedMs }).valid), "identity_source_not_admitted");
  fail(event?.source?.id === "fomo_linked_x_post"
    && event?.source?.trust === "public_x_identity_linked"
    && event?.sourceTrust === "public_x_identity_linked"
    && event?.source?.url === event?.tweet?.url, "untrusted_declaration_source");

  fail(chainId === BSC_CHAIN_ID && String(event?.chain?.slug || "").toLowerCase() === "bsc", "unsupported_chain");
  fail(isContractAddress(ca), "invalid_contract_address");
  fail(event?.launchClaim?.caSource === "official_x_oembed", "invalid_ca_source");
  fail(event?.launchClaim?.chainVerification === "declared_only"
    && event?.launchClaim?.chainSource === "declared_bsc_in_x_post", "invalid_chain_source");
  fail(event?.explorerUrl === `https://bscscan.com/token/${ca}`, "explorer_url_mismatch");
  fail(poolClaim.present.length === 0
    || (poolClaim.consistent && isContractAddress(poolClaim.value)), "pool_identity_invalid");

  fail(Number.isSafeInteger(event?.caller?.followers) && event.caller.followers >= 0, "followers_snapshot_missing");
  fail(validIso(event?.caller?.followersSyncedAt)
    && Number.isFinite(observedMs)
    && followerMs <= observedMs + 60_000
    && observedMs - followerMs <= 86_400_000, "followers_snapshot_stale");
  fail(BACKGROUND_STATUSES.has(background.status), "background_status_missing");
  if (capitalCatalogIdentity) {
    fail(capitalCatalogVerification.valid, "capital_catalog_snapshot_invalid");
    fail(Boolean(callerCapitalSnapshot)
      && Boolean(eventCapitalSnapshot)
      && JSON.stringify(callerCapitalSnapshot) === JSON.stringify(eventCapitalSnapshot),
    "capital_catalog_snapshot_claim_conflict");
    fail(Boolean(callerCapitalBinding)
      && Boolean(eventCapitalBinding)
      && JSON.stringify(callerCapitalBinding) === JSON.stringify(eventCapitalBinding)
      && cleanHandle(callerCapitalBinding.handle).toLowerCase() === handle.toLowerCase()
      && String(callerCapitalBinding.xUserId || "") === xUserId
      && callerCapitalBinding.source === "fxtwitter_public_profile"
      && callerCapitalBinding.observedAt === event?.caller?.followersSyncedAt
      && validIso(callerCapitalBinding.observedAt)
      && Date.parse(callerCapitalBinding.observedAt) <= observedMs + 60_000
      && observedMs - Date.parse(callerCapitalBinding.observedAt) <= 86_400_000,
    "capital_catalog_runtime_binding_invalid");
    fail(background.status === "primary_verified"
      && background.source === "reviewed_capital_person_catalog"
      && background.textZh === capitalSnapshot?.background?.zh
      && background.textEn === capitalSnapshot?.background?.en
      && background.text === capitalSnapshot?.background?.zh
      && background.sourceUrl === officialBackgroundEvidence?.url
      && background.checkedAt === officialBackgroundEvidence?.checkedAt
      && background.catalogVersion === capitalSnapshot?.catalogVersion
      && background.catalogHash === capitalSnapshot?.catalogHash,
    "capital_catalog_background_invalid");
  } else {
    fail(["self_described", "unverified"].includes(background.status), "background_status_missing");
    fail(background.status === "unverified" || Boolean(oneLine(background.text, 500)), "background_text_missing");
    fail(background.source === "fxtwitter_public_profile"
      && backgroundProfileMatch?.[1]?.toLowerCase() === handle.toLowerCase(), "background_source_missing");
  }
  fail(Number.isFinite(backgroundAt) && Number.isFinite(observedMs)
    && backgroundAt <= observedMs + 60_000 && observedMs - backgroundAt <= 86_400_000,
  "background_evidence_stale");

  fail(occurrenceClaimsValid && Number.isFinite(occurredMs) && Number.isFinite(observedMs)
    && occurredMs <= observedMs + 60_000 && observedMs - occurredMs <= 300_000,
  "declaration_time_invalid");
  fail(SECURITY_DECISIONS.has(String(event?.security?.decision || "unknown")), "security_decision_invalid");
  fail(Array.isArray(event?.shadow?.reasonCodes)
    && event.shadow.reasonCodes.includes("creator_not_onchain_verified"), "creator_watch_reason_missing");

  fail(Boolean(expectedEventKey), "event_identity_incomplete");
  if (event?.eventKey != null) fail(event.eventKey === expectedEventKey, "event_key_mismatch");
  if (event?.canonicalSignalId != null) {
    fail(event.canonicalSignalId === expectedCanonicalSignalId, "canonical_signal_id_mismatch");
  }
  if (event?.canonicalSignalIds != null) {
    fail(Array.isArray(event.canonicalSignalIds)
      && event.canonicalSignalIds.length === expectedCanonicalSignalIds.length
      && expectedCanonicalSignalIds.every((value) => event.canonicalSignalIds.includes(value)),
    "canonical_signal_ids_mismatch");
  }

  return {
    valid: reasons.length === 0,
    reasons,
    eventKey: expectedEventKey,
    canonicalSignalId: expectedCanonicalSignalId,
    canonicalSignalIds: expectedCanonicalSignalIds,
  };
}

function backgroundLabel(background, language) {
  if (background?.status === "primary_verified") {
    return language === "zh" ? "官方资料" : "official source";
  }
  if (background?.status === "self_described") {
    return language === "zh" ? "X 简介" : "X bio";
  }
  return language === "zh" ? "暂无资料" : "unavailable";
}

/** Six mirrored, local-only Telegram fact lines. */
export function renderKolTokenLaunchLanguageLines(event, language = "zh") {
  const zh = language === "zh";
  const caller = event?.caller || {};
  const market = event?.market || {};
  const { handle, xUserId, tweetId, chainId, ca } = identityParts(event);
  const followers = integer(caller.followers);
  const canonicalName = oneLine(caller.capitalKolSnapshot?.canonicalName || caller.displayName, 36);
  const person = canonicalName && canonicalName.toLowerCase() !== handle.toLowerCase()
    ? `${canonicalName} (@${handle || "unknown"})`
    : `@${handle || "unknown"}`;
  const background = oneLine(zh
    ? (caller.background?.textZh || caller.background?.text)
    : (caller.background?.textEn || caller.background?.text), 68)
    || (zh ? "暂无可核背景资料" : "No sourced background available");
  const symbol = oneLine(event?.tokenSymbol || event?.symbol || "?", 16);
  const chain = oneLine(event?.chain?.name || (chainId === BSC_CHAIN_ID ? "BNB Smart Chain" : "Unknown chain"), 30);
  const poolAddress = lowerAddress(market.poolAddress || market.pairAddress || market.pool);
  const liquidity = compactUsd(market.liquidityUsd);
  const occurredAt = sourceTimes(event).occurredAt;
  const poolSeparator = zh ? "｜" : " | ";
  const poolFact = isContractAddress(poolAddress)
    ? `${poolAddress}${liquidity ? `${poolSeparator}${zh ? "流动性" : "Liquidity"} ${liquidity}` : `${poolSeparator}${zh ? "流动性未随事件提供" : "liquidity not included in this event"}`}`
    : (zh ? "当前仅有代币 CA；无底池地址及流动性数值" : "Token CA only; no pool address or liquidity value");

  return zh ? [
    line(`人物：${person}｜粉丝 ${followers ?? "未取得"}`),
    line(`背景（${backgroundLabel(caller.background, language)}）：${background}`),
    line(`事件：该账号原帖声明发行 $${symbol}`),
    line(`链：${chain} (${Number.isSafeInteger(chainId) ? chainId : "?"})｜CA：${ca || "未取得"}`),
    line(`底池/流动性：${poolFact}`),
    line(`原帖：Tweet ${tweetId || "未取得"}｜X ID ${xUserId || "未取得"}｜${cstTime(occurredAt, language)}`),
  ] : [
    line(`Person: ${person} | ${followers ?? "unavailable"} followers`),
    line(`Background (${backgroundLabel(caller.background, language)}): ${background}`),
    line(`Event: the account post announces $${symbol}`),
    line(`Chain: ${chain} (${Number.isSafeInteger(chainId) ? chainId : "?"}) | CA: ${ca || "unavailable"}`),
    line(`Pool/Liquidity: ${poolFact}`),
    line(`Post: Tweet ${tweetId || "unavailable"} | X ID ${xUserId || "unavailable"} | ${cstTime(occurredAt, language)}`),
  ];
}
