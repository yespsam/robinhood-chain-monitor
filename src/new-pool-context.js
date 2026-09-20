import { createHash } from "node:crypto";

export const NEW_POOL_CONTEXT_VERSION = 2;

const ADDRESS_RE = /^0x[a-f0-9]{40}$/u;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;
const REVIEWED_AT = "2026-09-06";
const RESEARCH_REVIEWED_AT = "2026-09-11";
const BSC = 56;
const PON_CHAIN = 4663;
const FLAP_BOARD_URL = "https://flap.sh/board";
const FOUR_MEME_CONFIG_URL = "https://four.meme/meme-api/v1/public/config";
const PON_MARKETS_URL = "https://www.pon.fun/api/markets";
const PON_TOKEN_LIST_URL = "https://www.pon.fun/tokenlist.json";

const SPACE_X_BNB_ADDRESS_SOURCE = Object.freeze({
  id: "bnb_chain_spcxb_exact_address",
  kind: "ecosystem_exact_address_reference",
  label: "BNB Chain SPCXB exact-address listing",
  url: "https://www.bnbchain.org/en/blog/bnb-street-is-open-24-7-access-709-tokenized-stocks-of-the-worlds-largest-companies-on-bnb-chain",
  chainId: BSC,
  address: "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1",
});

const SPACE_X_BUSINESS_SOURCE = Object.freeze({
  label: "SpaceX IPO closing release",
  url: "https://ir.spacex.com/updates/releases-details/2026/Space-Exploration-Technologies-Corp--Announces-Closing-of-Initial-Public-Offering-Including-Full-Exercise-of-Underwriters-Option-to-Purchase-Additional-Shares-2026-RgoR-Y1Vwh/default.aspx",
  corroborating: [Object.freeze({
    label: "SpaceX SEC filing",
    url: "https://www.sec.gov/Archives/edgar/data/1181412/000162828026052535/spcx-20260630.htm",
  })],
});

function assetKey(chainId, address) {
  const numericChainId = chainId;
  const normalizedAddress = String(address || "").trim().toLowerCase();
  if (!Number.isSafeInteger(numericChainId)
    || numericChainId <= 0
    || !ADDRESS_RE.test(normalizedAddress)
    || normalizedAddress === ZERO_ADDRESS) return null;
  return `eip155:${numericChainId}/erc20:${normalizedAddress}`;
}

function digest(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function reviewedExactAddressSource({ id, kind, label, url, chainId, address }) {
  const key = assetKey(chainId, address);
  if (!key) throw new TypeError(`reviewed exact-address source is invalid: ${id || "unknown"}`);
  const source = Object.freeze({
    id,
    kind,
    label,
    url,
    chainId,
    address: String(address).toLowerCase(),
  });
  return [key, Object.freeze([source])];
}

// These sources bind an external issuer/exchange/launchpad statement to one
// exact chain/address key. They are independent of the runtime Flap/Four.Meme
// producer observation and are never consulted by symbol or name.
const REVIEWED_EXACT_ADDRESS_SOURCES = new Map([
  reviewedExactAddressSource(SPACE_X_BNB_ADDRESS_SOURCE),
  reviewedExactAddressSource({
    id: "binance_himsb_exact_address",
    kind: "exchange_exact_address_reference",
    label: "Binance HIMSB exact-address announcement",
    url: "https://www.binance.com/zh-CN/support/announcement/detail/7880bcb7f4744d8bbbba88cbbcd43124",
    chainId: BSC,
    address: "0xee6f4bcc88c2c8583d5a65c7d0c877b464100711",
  }),
  reviewedExactAddressSource({
    id: "ondo_fxion_exact_address",
    kind: "issuer_exact_address_reference",
    label: "Ondo FXIon exact-address asset page",
    url: "https://app.ondo.finance/assets/fxion",
    chainId: BSC,
    address: "0x9b8e987e6fec8cf1380c4dca7071e2c7853aeea1",
  }),
  reviewedExactAddressSource({
    id: "four_meme_bnc4_exact_address",
    kind: "launchpad_exact_address_reference",
    label: "Four.Meme verified BNC4 exact-address post",
    url: "https://www.binance.com/en/square/profile/Four_meme",
    chainId: BSC,
    address: "0x7c8d5502b544ddaf8852fc46d1174e34876d545c",
  }),
  reviewedExactAddressSource({
    id: "hemi_token_exact_address",
    kind: "issuer_exact_address_reference",
    label: "Hemi official token contract details",
    url: "https://docs.hemi.xyz/discover/token-contract-details",
    chainId: BSC,
    address: "0x5ffd0eadc186af9512542d0d5e5eafc65d5afc5b",
  }),
  reviewedExactAddressSource({
    id: "binance_koma_exact_address",
    kind: "exchange_exact_address_reference",
    label: "Binance KOMA exact-address announcement",
    url: "https://www.binance.com/en-NG/support/announcement/detail/08c08f06bec24d91a60a0ce8c48a3a76",
    chainId: BSC,
    address: "0xd5eaaac47bd1993d661bc087e15dfb079a7f3c19",
  }),
  reviewedExactAddressSource({
    id: "wlfi_token_exact_address",
    kind: "issuer_exact_address_reference",
    label: "World Liberty Financial official WLFI contract addresses",
    url: "https://docs.worldlibertyfinancial.com/wlfi-token/contract-addresses",
    chainId: BSC,
    address: "0x47474747477b199288bf72a1d702f7fe0fb1deea",
  }),
  reviewedExactAddressSource({
    id: "forty_eight_club_koge_exact_address",
    kind: "issuer_exact_address_reference",
    label: "48 Club official KOGE token details",
    url: "https://docs.48.club/koge-token",
    chainId: BSC,
    address: "0xe6df05ce8c8301223373cf5b969afcb1498c5528",
  }),
  reviewedExactAddressSource({
    id: "ondo_slvon_exact_address",
    kind: "issuer_exact_address_reference",
    label: "Ondo SLVon exact-address asset page",
    url: "https://app.ondo.finance/assets/slvon",
    chainId: BSC,
    address: "0x8b872732b07be325a8803cdb480d9d20b6f8d11b",
  }),
  reviewedExactAddressSource({
    id: "binance_marscoin_exact_address",
    kind: "exchange_exact_address_reference",
    label: "Binance MarsCoin exact-address announcement",
    url: "https://www.binance.com/en/support/announcement/detail/c2eaa763831745b2b1701dab45e20225",
    chainId: BSC,
    address: "0xfe189e97832da1573e4e4ff034f4ffc3a15c7777",
  }),
  reviewedExactAddressSource({
    id: "binance_trx_exact_address",
    kind: "exchange_exact_address_reference",
    label: "Binance TRX BEP-20 exact-address notice",
    url: "https://www.binance.com/en/support/announcement/detail/26ebedbedc5540edbdae11d7c7e1e43f",
    chainId: BSC,
    address: "0xce7de646e7208a4ef112cb6ed5038fa6cc6b12e3",
  }),
  reviewedExactAddressSource({
    id: "ondo_pddon_exact_address",
    kind: "issuer_exact_address_reference",
    label: "Ondo PDDon exact-address asset page",
    url: "https://app.ondo.finance/assets/pddon",
    chainId: BSC,
    address: "0xf3e82ea164cb344b2b11bad4c24b0ea4f7ba4714",
  }),
  reviewedExactAddressSource({
    id: "ondo_bilion_exact_address",
    kind: "issuer_exact_address_reference",
    label: "Ondo BILIon exact-address asset page",
    url: "https://app.ondo.finance/assets/bilion",
    chainId: BSC,
    address: "0x91fc7371d6de682a1e8cfcb4eb7da693312a03a4",
  }),
  reviewedExactAddressSource({
    id: "binance_bmnrb_exact_address",
    kind: "exchange_exact_address_reference",
    label: "Binance BMNRB exact-address bStocks announcement",
    url: "https://www.binance.com/en/support/announcement/detail/ae96da838d754f91bced1501de728f03",
    chainId: BSC,
    address: "0x3548da95a9effe481e8604664d75e95821e557f5",
  }),
]);

const reviewedIdentity = (symbol, name, { symbols = [], names = [] } = {}) => Object.freeze({
  canonicalDisplaySymbol: symbol,
  canonicalDisplayName: name,
  symbols: [...new Set([symbol, ...symbols])],
  names: [...new Set([name, ...names])],
});

const REVIEWED_ERC20_IDENTITIES = new Map([
  [assetKey(BSC, "0x000ae314e2a2172a039b26378814c252734f556a"), reviewedIdentity("ASTER", "Aster")],
  [assetKey(BSC, "0x02fca66c1d1afb4e2a7884261eb00f63598a7436"), reviewedIdentity("NVDAB", "NVIDIA Corp", { names: ["NVIDIA Corporation"] })],
  [assetKey(BSC, "0x205812cdbed920aff76c6580abd681a46d11efc7"), reviewedIdentity("QQQB", "Invesco QQQ", { names: ["Invesqo QQQ", "QQQ"] })],
  [assetKey(BSC, "0x3f53de71c126bdabae20f9cd64848d317f6c3238"), reviewedIdentity("GOOGLB", "Alphabet")],
  [assetKey(BSC, "0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a"), reviewedIdentity("AAPLB", "Apple")],
  [assetKey(BSC, "0x46ceefda28dd7207059ed19b0acdc026955bb15c"), reviewedIdentity("GMEB", "GameStop")],
  [assetKey(BSC, "0x4af1d41cd9dd950dca43984b43aaa2a8702714ac"), reviewedIdentity("FLNCB", "Fluence Energy")],
  [assetKey(BSC, "0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec"), reviewedIdentity("BABAB", "Alibaba")],
  [assetKey(BSC, "0x5b1910eaad6450e50f816082aa078c41f10c292f"), reviewedIdentity("TSLAB", "Tesla, Inc.", { names: ["Tesla"] })],
  [assetKey(BSC, "0x5fd86da9b05abe396fe9d02a4a213a7c00556503"), reviewedIdentity("MRNAB", "Moderna")],
  [assetKey(BSC, "0x21caef8a43163eea865baee23b9c2e327696a3bf"), reviewedIdentity("XAUt", "Tether Gold")],
  [assetKey(BSC, "0x55d398326f99059ff775485246999027b3197955"), reviewedIdentity("USDT", "Tether USD")],
  [assetKey(BSC, "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c"), reviewedIdentity("BTCB", "BTCB Token")],
  [assetKey(BSC, "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8"), reviewedIdentity("SPYB", "SPY")],
  [assetKey(BSC, "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1"), reviewedIdentity("SPCXB", "SpaceX")],
  [assetKey(BSC, "0xca750ef65f295bbecd685abf54e82caf297bdb61"), reviewedIdentity("SKHYB", "SK Hynix", { names: ["SK hynix"] })],
  [assetKey(BSC, "0xd6829ea836b6fa224d099d40e54b31262f874631"), reviewedIdentity("NFLXB", "Netflix")],
  [assetKey(BSC, "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf"), reviewedIdentity("SOXLB", "Semicon Bull 3X ETF")],
  [assetKey(BSC, "0xe28cd11c99af2df76bb8ada4cd0ef3904378280f"), reviewedIdentity("SOXSB", "Direxion Semiconductor Bear 3X ETF")],
  [assetKey(BSC, "0xe87afb3076aeb0f9b14e368de8145ae6a2826a14"), reviewedIdentity("MSTRB", "Strategy Inc.")],
  [assetKey(BSC, "0xf2ec508422174ee564de98187db9359d318afb6b"), reviewedIdentity("DJTB", "Trump Media & Technology Group Corp")],
  [assetKey(PON_CHAIN, "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b"), reviewedIdentity("AMC", "AMC Entertainment • Robinhood Token")],
  [assetKey(PON_CHAIN, "0x62200915e7deab1ec7f79fb246dadbb80eacddd0"), reviewedIdentity("CLOV", "Clover Health Investments • Robinhood Token")],
  [assetKey(BSC, "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d"), reviewedIdentity("USD1", "World Liberty Financial USD")],
  [assetKey(BSC, "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c"), reviewedIdentity("WBNB", "Wrapped BNB")],
  [assetKey(BSC, "0xee6f4bcc88c2c8583d5a65c7d0c877b464100711"), reviewedIdentity("HIMSB", "Hims & Hers", { names: ["Hims & Hers Health"] })],
  [assetKey(BSC, "0x9b8e987e6fec8cf1380c4dca7071e2c7853aeea1"), reviewedIdentity("FXIon", "iShares China Large-Cap ETF (Ondo Tokenized)")],
  [assetKey(BSC, "0x7c8d5502b544ddaf8852fc46d1174e34876d545c"), reviewedIdentity("BNC4", "Cea Industries", { names: ["CEA Industries"] })],
  [assetKey(BSC, "0x5ffd0eadc186af9512542d0d5e5eafc65d5afc5b"), reviewedIdentity("HEMI", "Hemi")],
  [assetKey(BSC, "0xd5eaaac47bd1993d661bc087e15dfb079a7f3c19"), reviewedIdentity("KOMA", "Koma Inu")],
  [assetKey(BSC, "0x47474747477b199288bf72a1d702f7fe0fb1deea"), reviewedIdentity("WLFI", "World Liberty Financial")],
  [assetKey(BSC, "0xe6df05ce8c8301223373cf5b969afcb1498c5528"), reviewedIdentity("KOGE", "BNB48 Club Token")],
  [assetKey(BSC, "0x8b872732b07be325a8803cdb480d9d20b6f8d11b"), reviewedIdentity("SLVon", "iShares Silver Trust (Ondo Tokenized)")],
  [assetKey(BSC, "0xfe189e97832da1573e4e4ff034f4ffc3a15c7777"), reviewedIdentity("MarsCoin", "MarsCoin")],
  [assetKey(BSC, "0xce7de646e7208a4ef112cb6ed5038fa6cc6b12e3"), reviewedIdentity("TRX", "TRON")],
  [assetKey(BSC, "0xf3e82ea164cb344b2b11bad4c24b0ea4f7ba4714"), reviewedIdentity("PDDon", "PDD Holdings (Ondo Tokenized)")],
  [assetKey(BSC, "0x91fc7371d6de682a1e8cfcb4eb7da693312a03a4"), reviewedIdentity("BILIon", "Bilibili (Ondo Tokenized)")],
  [assetKey(BSC, "0x3548da95a9effe481e8604664d75e95821e557f5"), reviewedIdentity("BMNRB", "BitMine Immersion Technologies")],
]);

const BSC_PLATFORM_EVIDENCE_ROUTES = Object.freeze([
  Object.freeze({
    platform: "flap",
    kind: "official_platform_producer_route",
    role: "runtime_observation_schema",
    url: FLAP_BOARD_URL,
    chainField: "changes.newFlapPools[].chainId",
    addressField: "changes.newFlapPools[].quoteAddress",
    symbolField: "changes.newFlapPools[].quoteSymbol",
    nameField: "changes.newFlapPools[].quoteName",
  }),
  Object.freeze({
    platform: "fourmeme",
    kind: "official_platform_producer_route",
    role: "runtime_observation_schema",
    url: FOUR_MEME_CONFIG_URL,
    chainField: "changes.newQuoteConfigs[].networkCode=BSC",
    addressField: "changes.newQuoteConfigs[].address",
    symbolField: "changes.newQuoteConfigs[].symbol",
  }),
]);

const PON_PLATFORM_EVIDENCE_ROUTES = Object.freeze([
  Object.freeze({
    platform: "ponfun",
    kind: "official_platform_producer_route",
    role: "runtime_observation_schema",
    urls: [PON_MARKETS_URL, PON_TOKEN_LIST_URL],
    chainField: "event.chainId",
    addressField: "market.stockToken",
    symbolField: "market.ticker",
  }),
]);

function profileMappingEvidence(key, chainId, address, reviewedAt) {
  const normalizedAddress = String(address).toLowerCase();
  const onchainIdentity = REVIEWED_ERC20_IDENTITIES.get(key);
  if (!onchainIdentity) throw new TypeError(`reviewed pool context is missing ERC-20 identity evidence for ${key}`);
  const evidence = {
    status: "reviewed_exact_address",
    basis: "exact_chain_address_plus_expected_erc20_identity",
    addressEvidence: {
      namespace: "eip155",
      chainId,
      tokenStandard: "erc20",
      address: normalizedAddress,
      assetKey: key,
    },
    expectedOnchainIdentity: onchainIdentity,
    platformSources: chainId === PON_CHAIN ? PON_PLATFORM_EVIDENCE_ROUTES : BSC_PLATFORM_EVIDENCE_ROUTES,
    independentSources: REVIEWED_EXACT_ADDRESS_SOURCES.get(key) || [],
    reviewedAt,
  };
  return Object.freeze({ ...evidence, evidenceHash: digest(evidence) });
}

function reviewedProfile({
  chainId,
  address,
  assetClass,
  ticker,
  subject,
  business,
  meme,
  source,
  reviewedAt = REVIEWED_AT,
}) {
  const key = assetKey(chainId, address);
  if (!key) throw new TypeError("reviewed pool context requires an exact chain and ERC-20 address");
  const mappingEvidence = profileMappingEvidence(key, chainId, address, reviewedAt);
  const profile = {
    version: NEW_POOL_CONTEXT_VERSION,
    assetKey: key,
    resolution: "verified_complete",
    assetClass,
    canonicalTicker: ticker || null,
    subject,
    business,
    meme: {
      kind: "editorial",
      status: "reviewed",
      ...meme,
    },
    mappingEvidence,
    businessSource: source,
    reviewedAt,
  };
  return Object.freeze({ ...profile, sourceHash: digest(profile) });
}

const REVIEWED_PROFILES = [
  reviewedProfile({
    chainId: BSC,
    address: "0x000ae314e2a2172a039b26378814c252734f556a",
    assetClass: "crypto_asset",
    ticker: "ASTER",
    subject: { zh: "加密资产｜ASTER · Aster", en: "Crypto asset | ASTER · Aster" },
    business: { zh: "Aster DEX 生态代币，用于治理、增长激励与参与奖励", en: "Aster DEX ecosystem token used for governance, growth incentives, and participation rewards" },
    meme: { zh: "链上永续、隐藏单与空投积分叙事", en: "On-chain perps, hidden orders, and airdrop-points lore" },
    source: { label: "Aster official docs", url: "https://docs.asterdex.com/usdaster/overview" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x02fca66c1d1afb4e2a7884261eb00f63598a7436",
    assetClass: "public_equity_reference",
    ticker: "NVDA",
    subject: { zh: "美股映射｜NVDA · NVIDIA", en: "U.S. equity reference | NVDA · NVIDIA" },
    business: { zh: "设计 AI 与加速计算所需的芯片、系统和软件", en: "Builds chips, systems, and software for AI and accelerated computing" },
    meme: { zh: "AI 淘金潮的“卖铲人”｜黄仁勋皮衣与显卡", en: "The AI gold-rush “shovel seller” | Jensen's leather jacket and GPUs" },
    source: { label: "NVIDIA official", url: "https://www.nvidia.com/en-us/about-nvidia/" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x205812cdbed920aff76c6580abd681a46d11efc7",
    assetClass: "index_etf_reference",
    ticker: "QQQ",
    subject: { zh: "指数 ETF 映射｜QQQ · Nasdaq-100", en: "Index ETF reference | QQQ · Nasdaq-100" },
    business: { zh: "跟踪 Nasdaq-100 的大型非金融公司敞口；不是一家公司", en: "Exposure to large non-financial Nasdaq-100 companies; not a company" },
    meme: { zh: "“科技七巨头”与逢跌买入的科技成长篮子", en: "The mega-cap-tech basket and buy-the-dip growth trade" },
    source: { label: "Invesco QQQ official", url: "https://www.invesco.com/qqq-etf/en/about.html" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x3f53de71c126bdabae20f9cd64848d317f6c3238",
    assetClass: "public_equity_reference",
    ticker: "GOOGL",
    subject: { zh: "美股映射｜GOOGL · Alphabet", en: "U.S. equity reference | GOOGL · Alphabet" },
    business: { zh: "Search、YouTube、广告、Cloud 与 AI 产品", en: "Search, YouTube, ads, Cloud, and AI products" },
    meme: { zh: "“谷歌一下”＋Android 生态＋Gemini AI 竞赛", en: "“Just Google it,” Android, and the Gemini AI race" },
    source: { label: "Alphabet Investor Relations", url: "https://abc.xyz/investor/faqs-and-general-information/default.aspx" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a",
    assetClass: "public_equity_reference",
    ticker: "AAPL",
    subject: { zh: "美股映射｜AAPL · Apple", en: "U.S. equity reference | AAPL · Apple" },
    business: { zh: "iPhone、Mac、iPad、可穿戴设备与 Services 生态", en: "iPhone, Mac, iPad, wearables, and the Services ecosystem" },
    meme: { zh: "“One more thing”｜果粉、发布会与围墙花园", en: "“One more thing” | launch events, Apple fandom, and the walled garden" },
    source: { label: "Apple official", url: "https://www.apple.com/newsroom/2025/09/apple-debuts-iphone-17/" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x46ceefda28dd7207059ed19b0acdc026955bb15c",
    assetClass: "public_equity_reference",
    ticker: "GME",
    subject: { zh: "美股映射｜GME · GameStop", en: "U.S. equity reference | GME · GameStop" },
    business: { zh: "电子游戏、主机与收藏品零售商", en: "Retailer of video games, consoles, and collectibles" },
    meme: { zh: "Roaring Kitty、Apes、钻石手与 2021 逼空", en: "Roaring Kitty, apes, diamond hands, and the 2021 short squeeze" },
    source: { label: "GameStop Investor Relations", url: "https://investor.gamestop.com/overview/" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x4af1d41cd9dd950dca43984b43aaa2a8702714ac",
    assetClass: "public_equity_reference",
    ticker: "FLNC",
    subject: { zh: "美股映射｜FLNC · Fluence Energy", en: "U.S. equity reference | FLNC · Fluence Energy" },
    business: { zh: "电网级储能产品、服务与能源优化软件", en: "Grid-scale energy storage products, services, and optimization software" },
    meme: { zh: "AI 用电潮背后的“电网电池”与储能铲子股", en: "The grid-battery and storage “picks-and-shovels” angle behind AI power demand" },
    source: { label: "Fluence Investor Relations", url: "https://ir.fluenceenergy.com/" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x4ef9d3062c7f6eba4aae4990c5036598c6eff4ec",
    assetClass: "adr_reference",
    ticker: "BABA",
    subject: { zh: "美股 ADR 映射｜BABA · Alibaba", en: "U.S.-listed ADR reference | BABA · Alibaba" },
    business: { zh: "电商与云计算为核心；BABA 是 ADS，发行人并非美国公司", en: "Centers on commerce and cloud; BABA is an ADS and the issuer is not a U.S. company" },
    meme: { zh: "双十一、马云与“中国科技反弹”叙事", en: "Singles' Day, Jack Ma, and the China-tech rebound narrative" },
    source: { label: "Alibaba investor FAQ", url: "https://www.alibabagroup.com/en-US/faqs-investor-information" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x5b1910eaad6450e50f816082aa078c41f10c292f",
    assetClass: "public_equity_reference",
    ticker: "TSLA",
    subject: { zh: "美股映射｜TSLA · Tesla", en: "U.S. equity reference | TSLA · Tesla" },
    business: { zh: "电动车、储能、太阳能与相关软件", en: "Electric vehicles, energy storage, solar, and related software" },
    meme: { zh: "马斯克、Robotaxi、火星与“to the moon”", en: "Musk, Robotaxi, Mars, and “to the moon”" },
    source: { label: "Tesla official", url: "https://www.tesla.com/about" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x5fd86da9b05abe396fe9d02a4a213a7c00556503",
    assetClass: "public_equity_reference",
    ticker: "MRNA",
    subject: { zh: "美股映射｜MRNA · Moderna", en: "U.S. equity reference | MRNA · Moderna" },
    business: { zh: "以 mRNA 技术开发疫苗与药物", en: "Develops vaccines and medicines using mRNA technology" },
    meme: { zh: "疫苗周期与“可编程药物”想象", en: "Vaccine cycles and the “programmable medicine” narrative" },
    source: { label: "Moderna official", url: "https://www.modernatx.com/en-US/about-us/our-mission" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x21caef8a43163eea865baee23b9c2e327696a3bf",
    assetClass: "gold_backed_token",
    ticker: "XAUT",
    subject: { zh: "黄金支持代币｜XAUT · Tether Gold", en: "Gold-backed token | XAUT · Tether Gold" },
    business: { zh: "发行方称每枚 XAUT 代表一金衡盎司合格实物黄金的所有权份额", en: "The issuer says each XAUT represents ownership of one fine troy ounce of qualifying physical gold" },
    meme: { zh: "“链上黄金”、避险与 gold-bug 叙事", en: "On-chain gold, flight-to-safety, and gold-bug lore" },
    source: { label: "Tether Gold official", url: "https://gold.tether.to/faq" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x55d398326f99059ff775485246999027b3197955",
    assetClass: "fiat_backed_stablecoin",
    ticker: "USDT",
    subject: { zh: "美元稳定币｜USDT · Tether", en: "Dollar stablecoin | USDT · Tether" },
    business: { zh: "发行方称 USDT 按 1:1 锚定美元并由储备支持", en: "The issuer states USDT is pegged 1:1 to USD and backed by reserves" },
    meme: { zh: "加密市场的“数字美元”与场外弹药", en: "Crypto's digital dollar and deployable dry powder" },
    source: { label: "Tether transparency", url: "https://tether.to/en/transparency/?tab=usdt" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x7130d2a12b9bcbfae4f2634d864a1ee1ce3ead9c",
    assetClass: "wrapped_crypto_asset",
    ticker: "BTCB",
    subject: { zh: "封装加密资产｜BTCB · Bitcoin", en: "Wrapped crypto asset | BTCB · Bitcoin" },
    business: { zh: "BNB Chain 官方资料称 BTCB 与 BTC 1:1 锚定", en: "BNB Chain's official material describes BTCB as pegged 1:1 to BTC" },
    meme: { zh: "把橙色币 HODL 叙事搬上 BNB Chain", en: "The orange-coin HODL story carried onto BNB Chain" },
    source: { label: "BNB Chain BTCB official", url: "https://www.bnbchain.org/en/blog/btcb-on-binance-smart-chain-101" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x7138b48df7d98d7e3cc221bfe7192d0a178182d8",
    assetClass: "index_etf_reference",
    ticker: "SPY",
    subject: { zh: "指数 ETF 映射｜SPY · S&P 500", en: "Index ETF reference | SPY · S&P 500" },
    business: { zh: "跟踪 S&P 500 大盘股敞口；不是一家公司", en: "Tracks broad S&P 500 large-cap exposure; not a company" },
    meme: { zh: "“美股大盘”代理、逢跌买入与 0DTE 文化", en: "The U.S.-market proxy, buy-the-dip, and 0DTE culture" },
    source: { label: "SPDR SPY official", url: "https://www.ssga.com/us/en/intermediary/etfs/spdr-sp-500-etf-trust-spy" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xbe9d156892e55e7154bcd3cb0fea677f9d3103e1",
    assetClass: "public_equity_reference",
    ticker: "SPCX",
    subject: { zh: "美股映射｜SPCX · SpaceX", en: "U.S. equity reference | SPCX · SpaceX" },
    business: { zh: "可复用火箭、航天器与 Starlink；2026-06-12 起以 SPCX 上市", en: "Reusable rockets, spacecraft, and Starlink; publicly listed as SPCX since 2026-06-12" },
    meme: { zh: "马斯克、火星与字面意义上的“火箭升空”", en: "Musk, Mars, and a literal rocket launch “to the moon”" },
    source: SPACE_X_BUSINESS_SOURCE,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xca750ef65f295bbecd685abf54e82caf297bdb61",
    assetClass: "foreign_equity_reference",
    ticker: "000660.KS",
    subject: { zh: "韩国股票映射｜SK hynix", en: "Korean equity reference | SK hynix" },
    business: { zh: "韩国存储芯片公司，重点产品包括 HBM、DRAM 与企业级 SSD", en: "Korean memory-chip company focused on HBM, DRAM, and enterprise SSDs" },
    meme: { zh: "AI 的 HBM“军火竞赛”与显存短缺叙事", en: "The AI HBM arms race and memory-scarcity trade" },
    source: { label: "SK hynix fact sheet", url: "https://news.skhynix.com/corporate/fact-sheet/" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xd6829ea836b6fa224d099d40e54b31262f874631",
    assetClass: "public_equity_reference",
    ticker: "NFLX",
    subject: { zh: "美股映射｜NFLX · Netflix", en: "U.S. equity reference | NFLX · Netflix" },
    business: { zh: "流媒体娱乐、影视内容与游戏", en: "Streaming entertainment, film/TV content, and games" },
    meme: { zh: "追剧、爆款剧与“Netflix and chill”", en: "Binge-watching, breakout shows, and “Netflix and chill”" },
    source: { label: "Netflix Investor Relations", url: "https://ir.netflix.net/ir-overview/profile/default.aspx" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xd97d097a89113fa59b76c572e5b2eb647e8eefaf",
    assetClass: "leveraged_etf_reference",
    ticker: "SOXL",
    subject: { zh: "3×杠杆 ETF 映射｜SOXL · 半导体多头", en: "3× leveraged ETF reference | SOXL · semiconductor bull" },
    business: { zh: "追求半导体指数单日 +300% 表现；每日重置，不是一家公司", en: "Targets +300% of a semiconductor index for one day; resets daily and is not a company" },
    meme: { zh: "AI 芯片牛市的三倍放大器｜高波动“过山车”", en: "A 3× amplifier for the AI-chip bull case | a high-volatility roller coaster" },
    source: { label: "Direxion SOXL official", url: "https://www.direxion.com/product/daily-semiconductor-bull-bear-3x-etfs" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xe28cd11c99af2df76bb8ada4cd0ef3904378280f",
    assetClass: "inverse_leveraged_etf_reference",
    ticker: "SOXS",
    subject: { zh: "-3×反向 ETF 映射｜SOXS · 半导体空头", en: "-3× inverse ETF reference | SOXS · semiconductor bear" },
    business: { zh: "追求半导体指数单日 -300% 表现；每日重置，不是一家公司", en: "Targets -300% of a semiconductor index for one day; resets daily and is not a company" },
    meme: { zh: "芯片熊市的三倍对冲器｜“做空 AI 狂热”", en: "A 3× hedge for a chip downturn | “short the AI hype”" },
    source: { label: "Direxion SOXS official", url: "https://www.direxion.com/product/daily-semiconductor-bull-bear-3x-etfs" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xe87afb3076aeb0f9b14e368de8145ae6a2826a14",
    assetClass: "public_equity_reference",
    ticker: "MSTR",
    subject: { zh: "美股映射｜MSTR · Strategy", en: "U.S. equity reference | MSTR · Strategy" },
    business: { zh: "企业分析软件与比特币财库策略", en: "Enterprise analytics software and a Bitcoin treasury strategy" },
    meme: { zh: "Michael Saylor、激光眼与“带杠杆的 BTC 代理”", en: "Michael Saylor, laser eyes, and the “leveraged BTC proxy” trade" },
    source: { label: "Strategy official", url: "https://www.strategy.com/company" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xf2ec508422174ee564de98187db9359d318afb6b",
    assetClass: "public_equity_reference",
    ticker: "DJT",
    subject: { zh: "美股映射｜DJT · Trump Media", en: "U.S. equity reference | DJT · Trump Media" },
    business: { zh: "Truth Social 社交平台与媒体科技业务", en: "Truth Social and media-technology operations" },
    meme: { zh: "特朗普、选举新闻与高度政治化的行情", en: "Trump, election headlines, and a highly politicized trade" },
    source: { label: "Trump Media Investor Relations", url: "https://ir.tmtgcorp.com/" },
  }),
  reviewedProfile({
    chainId: PON_CHAIN,
    address: "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b",
    assetClass: "public_equity_reference",
    ticker: "AMC",
    subject: { zh: "美股映射｜AMC · AMC Entertainment", en: "U.S. equity reference | AMC · AMC Entertainment" },
    business: { zh: "电影院线与院内食品饮料业务", en: "Movie-theatre exhibition and in-theatre food and beverage" },
    meme: { zh: "Apes、爆米花、钻石手与 2021 Meme Stock", en: "Apes, popcorn, diamond hands, and the 2021 meme-stock cycle" },
    source: { label: "AMC Investor Relations", url: "https://investor.amctheatres.com/company-information" },
  }),
  reviewedProfile({
    chainId: PON_CHAIN,
    address: "0x62200915e7deab1ec7f79fb246dadbb80eacddd0",
    assetClass: "public_equity_reference",
    ticker: "CLOV",
    subject: { zh: "美股映射｜CLOV · Clover Health", en: "U.S. equity reference | CLOV · Clover Health" },
    business: { zh: "面向 Medicare 人群的健康保险与数据辅助护理", en: "Health insurance and data-assisted care for Medicare populations" },
    meme: { zh: "2021 零售抱团、SPAC 与高空头兴趣叙事", en: "The 2021 retail, SPAC, and high-short-interest narrative" },
    source: { label: "Clover Health Investor Relations", url: "https://investors.cloverhealth.com/about/" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x8d0d000ee44948fc98c9b98a4fa4921476f08b0d",
    assetClass: "fiat_backed_stablecoin",
    ticker: "USD1",
    subject: { zh: "美元稳定币｜USD1 · World Liberty Financial", en: "Dollar stablecoin | USD1 · World Liberty Financial" },
    business: { zh: "项目方称 USD1 可兑美元并公布储备报告", en: "The project states USD1 is USD-redeemable and publishes reserve reports" },
    meme: { zh: "“链上美元”叠加 WLFI/Trump 品牌叙事", en: "An on-chain-dollar story layered with the WLFI/Trump brand" },
    source: { label: "USD1 official", url: "https://worldlibertyfinancial.com/usd1" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c",
    assetClass: "wrapped_native_asset",
    ticker: "BNB",
    subject: { zh: "链原生资产映射｜WBNB · BNB", en: "Native-asset wrapper | WBNB · BNB" },
    business: { zh: "BNB 的 BEP-20 封装形式，用于 BNB Chain 交易、Gas 与 DeFi", en: "BEP-20 wrapped BNB used across BNB Chain trading, gas, and DeFi" },
    meme: { zh: "BNB Chain“燃料”与发射台流动性基准", en: "BNB Chain's fuel and the launchpad-liquidity benchmark" },
    source: { label: "BNB Chain official", url: "https://www.bnbchain.org/en/bnb-token" },
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xee6f4bcc88c2c8583d5a65c7d0c877b464100711",
    assetClass: "public_equity_reference",
    ticker: "HIMS",
    subject: { zh: "代币化美股映射｜HIMS · Hims & Hers Health", en: "Tokenized U.S. equity reference | HIMS · Hims & Hers Health" },
    business: { zh: "面向消费者的数字医疗平台，连接远程问诊、电子处方与药房履约，覆盖脱发、性健康和减重等领域", en: "Consumer digital health connecting telehealth, e-prescriptions, and pharmacy fulfillment across hair loss, sexual health, and weight management" },
    meme: { zh: "高频广告、“秃头与减重”订阅、GLP-1 热潮", en: "Ubiquitous ads, hair-loss and weight-loss subscriptions, and the GLP-1 boom" },
    source: { label: "Hims & Hers 2025 Form 10-K", url: "https://www.sec.gov/Archives/edgar/data/1773751/000177375126000022/hims-20251231.htm" },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x9b8e987e6fec8cf1380c4dca7071e2c7853aeea1",
    assetClass: "index_etf_reference",
    ticker: "FXI",
    subject: { zh: "代币化 ETF 映射｜FXI · iShares China Large-Cap ETF", en: "Tokenized ETF reference | FXI · iShares China Large-Cap ETF" },
    business: { zh: "跟踪在香港上市的中国大型股指数敞口；不是一家公司", en: "Tracks large-cap Chinese equities listed in Hong Kong; not a company" },
    meme: { zh: "“中国大盘/港股龙头篮子”与单一国家反弹交易", en: "The China large-cap/Hong Kong bellwether basket and single-country rebound trade" },
    source: { label: "iShares FXI official", url: "https://www.ishares.com/us/products/239536/ishares-china-large-cap-etf" },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x7c8d5502b544ddaf8852fc46d1174e34876d545c",
    assetClass: "public_equity_reference",
    ticker: "BNC",
    subject: { zh: "代币化美股映射｜BNC · CEA Industries", en: "Tokenized U.S. equity reference | BNC · CEA Industries" },
    business: { zh: "以 BNB 为核心的上市公司数字资产财库，并保留规模较小的传统零售业务", en: "A public-company digital-asset treasury centered on BNB, alongside smaller legacy retail operations" },
    meme: { zh: "“BNB 版 Strategy/MicroStrategy”＋Four.Meme 首个 4Stock", en: "The “BNB version of Strategy/MicroStrategy” plus Four.Meme's first 4Stock" },
    source: {
      label: "CEA Industries 2026 Form 10-K",
      url: "https://www.sec.gov/Archives/edgar/data/1482541/000148254126000019/bncww-20260430.htm",
      corroborating: [{ label: "Four.Meme 4Stock docs", url: "https://four-meme.gitbook.io/four.meme/stock-meme/4stock" }],
    },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x5ffd0eadc186af9512542d0d5e5eafc65d5afc5b",
    assetClass: "crypto_asset",
    ticker: "HEMI",
    subject: { zh: "加密资产｜HEMI · Hemi", en: "Crypto asset | HEMI · Hemi" },
    business: { zh: "结合比特币安全性与以太坊可编程性的模块化 Layer 2，面向 BTC DeFi 与跨链应用", en: "A modular Layer 2 combining Bitcoin security with Ethereum programmability for BTC DeFi and cross-chain apps" },
    meme: { zh: "“BTC＋ETH 超级网络”与把完整比特币节点塞进 EVM", en: "The “BTC + ETH supernetwork” and a full Bitcoin node inside the EVM" },
    source: { label: "Hemi official docs", url: "https://docs.hemi.xyz/" },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xd5eaaac47bd1993d661bc087e15dfb079a7f3c19",
    assetClass: "crypto_asset",
    ticker: "KOMA",
    subject: { zh: "BNB Chain Meme｜KOMA · Koma Inu", en: "BNB Chain meme | KOMA · Koma Inu" },
    business: { zh: "社区驱动的 BNB Chain 狗狗主题 Meme 代币", en: "A community-driven, dog-themed meme token on BNB Chain" },
    meme: { zh: "“Shib 之子、BNB 守护者”的狗狗币宇宙", en: "The “son of Shib, protector of BNB” dog-coin lore" },
    source: { label: "Koma Inu official", url: "https://komabnb.com" },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x47474747477b199288bf72a1d702f7fe0fb1deea",
    assetClass: "crypto_asset",
    ticker: "WLFI",
    subject: { zh: "治理代币｜WLFI · World Liberty Financial", en: "Governance token | WLFI · World Liberty Financial" },
    business: { zh: "World Liberty Financial 协议治理代币，用于提案、讨论与投票", en: "Governance token for proposing, discussing, and voting on World Liberty Financial protocol matters" },
    meme: { zh: "特朗普品牌、链上金融与 USD1 生态叙事", en: "The Trump brand, on-chain finance, and USD1 ecosystem narrative" },
    source: { label: "WLFI governance docs", url: "https://docs.worldlibertyfinancial.com/wlfi-token/wlfi-governance" },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xe6df05ce8c8301223373cf5b969afcb1498c5528",
    assetClass: "crypto_asset",
    ticker: "KOGE",
    subject: { zh: "社区代币｜KOGE · BNB48 Club Token", en: "Community token | KOGE · BNB48 Club Token" },
    business: { zh: "48 Club 在 BNB Chain 上的权益与会员福利代币", en: "The BNB Chain token representing rights and membership benefits in 48 Club" },
    meme: { zh: "BNB 老牌 DAO 与“Richest DAO on BNB”社区身份", en: "Legacy BNB DAO lore and the “Richest DAO on BNB” community identity" },
    source: { label: "48 Club official KOGE docs", url: "https://docs.48.club/koge-token" },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x8b872732b07be325a8803cdb480d9d20b6f8d11b",
    assetClass: "index_etf_reference",
    ticker: "SLV",
    subject: { zh: "代币化 ETF 映射｜SLV · iShares Silver Trust", en: "Tokenized ETF reference | SLV · iShares Silver Trust" },
    business: { zh: "通过 iShares Silver Trust 映射白银价格敞口；不是一家公司", en: "Tracks silver-price exposure through iShares Silver Trust; not a company" },
    meme: { zh: "链上白银与贵金属避险交易", en: "On-chain silver and the precious-metals hedge trade" },
    source: { label: "iShares SLV official", url: "https://www.ishares.com/us/products/239855/ishares-silver-trust" },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xfe189e97832da1573e4e4ff034f4ffc3a15c7777",
    assetClass: "crypto_asset",
    ticker: "MarsCoin",
    subject: { zh: "BNB Chain Meme｜MarsCoin", en: "BNB Chain meme | MarsCoin" },
    business: { zh: "BNB Chain 上以太空与火星为主题的 Meme 代币", en: "A space-and-Mars-themed meme token on BNB Chain" },
    meme: { zh: "CZ × 马斯克“火星币”＋火箭/火星叙事", en: "CZ × Musk MarsCoin lore plus rockets and Mars" },
    source: { label: "Binance MarsCoin listing", url: "https://www.binance.com/en/support/announcement/detail/c2eaa763831745b2b1701dab45e20225" },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xce7de646e7208a4ef112cb6ed5038fa6cc6b12e3",
    assetClass: "wrapped_crypto_asset",
    ticker: "TRX",
    subject: { zh: "封装加密资产｜TRX · TRON", en: "Wrapped crypto asset | TRX · TRON" },
    business: { zh: "TRON 原生 TRX 在 BNB Chain 上的 BEP-20 表示；TRX 用于手续费、质押与治理", en: "The BNB Chain BEP-20 representation of TRON's native TRX, used for fees, staking, and governance" },
    meme: { zh: "TRON 生态燃料与稳定币支付轨道", en: "TRON ecosystem fuel and stablecoin-payment rails" },
    source: { label: "TRON TRX official docs", url: "https://developers.tron.network/docs/token-standards-trx" },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0xf3e82ea164cb344b2b11bad4c24b0ea4f7ba4714",
    assetClass: "adr_reference",
    ticker: "PDD",
    subject: { zh: "代币化美股 ADR 映射｜PDD · PDD Holdings", en: "Tokenized U.S.-listed ADR reference | PDD · PDD Holdings" },
    business: { zh: "跨国电商集团，旗下平台包括拼多多与 Temu", en: "A multinational commerce group whose platforms include Pinduoduo and Temu" },
    meme: { zh: "拼多多“砍一刀”社交裂变与 Temu 全球低价电商叙事", en: "Pinduoduo's social-shopping virality and Temu's global bargain-commerce narrative" },
    source: { label: "PDD Holdings 2025 Form 20-F", url: "https://investor.pddholdings.com/static-files/e15edea4-5e6d-4740-808a-63a3dd1b2ce4" },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x91fc7371d6de682a1e8cfcb4eb7da693312a03a4",
    assetClass: "adr_reference",
    ticker: "BILI",
    subject: { zh: "代币化美股 ADR 映射｜BILI · 哔哩哔哩", en: "Tokenized U.S.-listed ADR reference | BILI · Bilibili" },
    business: { zh: "面向中国年轻一代的视频社区，覆盖 PUGV、直播、OGV、游戏与增值服务", en: "A video community for China's younger generations spanning PUGV, live streaming, OGV, games, and value-added services" },
    meme: { zh: "“小破站”、弹幕与二次元社区文化", en: "The ‘B-site’ nickname, bullet comments, and ACG community culture" },
    source: { label: "Bilibili corporate profile", url: "https://ir.bilibili.com/cn/corporate-information/?tab=company-profile" },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
  reviewedProfile({
    chainId: BSC,
    address: "0x3548da95a9effe481e8604664d75e95821e557f5",
    assetClass: "public_equity_reference",
    ticker: "BMNR",
    subject: { zh: "代币化美股映射｜BMNR · BitMine Immersion Technologies", en: "Tokenized U.S. equity reference | BMNR · BitMine Immersion Technologies" },
    business: { zh: "以 ETH 为主要储备资产，运营机构级质押与验证基础设施，并保留比特币挖矿业务", en: "Uses ETH as its primary treasury reserve asset, operates institutional staking and validation infrastructure, and retains bitcoin mining operations" },
    meme: { zh: "美股“ETH 财库代理”与“Alchemy of 5%”口号", en: "The U.S.-listed ‘ETH treasury proxy’ and its ‘Alchemy of 5%’ slogan" },
    source: {
      label: "BitMine fiscal 2026 Form 10-Q",
      url: "https://www.sec.gov/Archives/edgar/data/1829311/000162828026048157/bmnr-20260531.htm",
      corroborating: [{ label: "BitMine official company profile", url: "https://www.bitminetech.io/about" }],
    },
    reviewedAt: RESEARCH_REVIEWED_AT,
  }),
];

const PROFILE_BY_KEY = new Map(REVIEWED_PROFILES.map((profile) => [profile.assetKey, profile]));

// These are editorial subject aliases, not token metadata and not fuzzy-search
// hints.  Every entry is pinned to a reviewed chain/address key so a matching
// company name can only select an asset that already exists in this catalog.
const REVIEWED_NEWS_ALIASES = new Map([
  [assetKey(BSC, "0x02fca66c1d1afb4e2a7884261eb00f63598a7436"), ["NVIDIA"]],
  [assetKey(BSC, "0x431a3bee82e2ca41e49895cbece5bb0f76a89b7a"), ["Apple Inc.", "Apple Inc"]],
  [assetKey(BSC, "0x3f53de71c126bdabae20f9cd64848d317f6c3238"), ["Alphabet Inc.", "Alphabet Inc"]],
  [assetKey(BSC, "0xf2ec508422174ee564de98187db9359d318afb6b"), ["Trump Media & Technology Group"]],
]);

function normalizedMatchText(value, { foldCase = false } = {}) {
  if (typeof value !== "string") return "";
  const normalized = value.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return foldCase ? normalized.toLocaleLowerCase("en-US") : normalized;
}

function subjectTokenCharacter(value) {
  return Boolean(value && /[\p{L}\p{N}_]/u.test(value));
}

function exactSubjectTokenMatch(text, needle, { caseSensitive = false } = {}) {
  const source = normalizedMatchText(text, { foldCase: !caseSensitive });
  const candidate = normalizedMatchText(needle, { foldCase: !caseSensitive });
  if (!source || !candidate) return false;
  let offset = source.indexOf(candidate);
  while (offset !== -1) {
    const before = offset > 0 ? source[offset - 1] : "";
    const afterOffset = offset + candidate.length;
    const after = afterOffset < source.length ? source[afterOffset] : "";
    if (!subjectTokenCharacter(before) && !subjectTokenCharacter(after)) return true;
    offset = source.indexOf(candidate, offset + 1);
  }
  return false;
}

const REVIEWED_NEWS_MATCH_CATALOG = Object.freeze(REVIEWED_PROFILES
  .map((profile) => {
    const identity = profile.mappingEvidence?.expectedOnchainIdentity;
    const aliases = [...new Set([
      ...(Array.isArray(identity?.names) ? identity.names : []),
      ...(REVIEWED_NEWS_ALIASES.get(profile.assetKey) || []),
    ].map((value) => normalizedMatchText(value)).filter(Boolean))].sort((left, right) => left.localeCompare(right, "en"));
    const tickers = [...new Set([profile.canonicalTicker]
      .map((value) => normalizedMatchText(value))
      .filter(Boolean))].sort((left, right) => left.localeCompare(right, "en"));
    return Object.freeze({ assetKey: profile.assetKey, tickers: Object.freeze(tickers), aliases: Object.freeze(aliases) });
  })
  .sort((left, right) => left.assetKey.localeCompare(right.assetKey)));

/**
 * Resolve news text only to reviewed pool assets. Tickers are case-sensitive
 * and require complete Unicode token boundaries; reviewed names/aliases are
 * case-insensitive but use the same complete-token rule. There is deliberately
 * no stemming, edit-distance, substring, symbol-only, or network lookup path.
 */
export function matchReviewedPoolAssetKeys(text, { chainId = null } = {}) {
  if (typeof text !== "string" || !text.trim()) return [];
  if (chainId !== null && (!Number.isSafeInteger(chainId) || chainId <= 0)) return [];
  return REVIEWED_NEWS_MATCH_CATALOG.flatMap((entry) => {
    const entryChainId = Number(/^eip155:(\d+)\//u.exec(entry.assetKey)?.[1]);
    if (chainId !== null && entryChainId !== chainId) return [];
    const tickerMatched = entry.tickers.some((ticker) => exactSubjectTokenMatch(text, ticker, { caseSensitive: true }));
    const aliasMatched = entry.aliases.some((alias) => exactSubjectTokenMatch(text, alias));
    return tickerMatched || aliasMatched ? [entry.assetKey] : [];
  });
}

function unresolvedProfile(chainId, address) {
  const key = assetKey(chainId, address);
  const normalizedAddress = String(address || "").trim().toLowerCase();
  const mappingEvidence = {
    status: "unresolved",
    basis: key ? "exact_chain_and_erc20_address_not_in_reviewed_catalog" : "invalid_or_missing_asset_key",
    ...(key ? {
      addressEvidence: {
        namespace: "eip155",
        chainId,
        tokenStandard: "erc20",
        address: normalizedAddress,
        assetKey: key,
      },
    } : {}),
    expectedOnchainIdentity: null,
    platformSources: [],
    independentSources: [],
    reviewedAt: REVIEWED_AT,
  };
  const profile = {
    version: NEW_POOL_CONTEXT_VERSION,
    assetKey: key,
    resolution: "unresolved",
    assetClass: "unknown",
    canonicalTicker: null,
    subject: { zh: "底层资产资料待核验", en: "Underlying asset profile pending verification" },
    business: {
      zh: "不根据名称或代码猜测公司/产品",
      en: "No company or product is inferred from a name or ticker",
    },
    meme: {
      kind: "editorial",
      status: "unresolved",
      zh: "暂无已审核梗，不猜",
      en: "No reviewed meme angle; no guessing",
    },
    mappingEvidence: { ...mappingEvidence, evidenceHash: digest(mappingEvidence) },
    businessSource: null,
    reviewedAt: REVIEWED_AT,
  };
  return { ...profile, sourceHash: digest(profile) };
}

export function resolveVerifiedPoolAssetContext({ chainId, address } = {}) {
  const key = assetKey(chainId, address);
  const profile = key ? PROFILE_BY_KEY.get(key) : null;
  return structuredClone(profile || unresolvedProfile(chainId, address));
}

function list(value) {
  return Array.isArray(value) ? value : [];
}

function strictChainId(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function exactAddress(value) {
  const address = typeof value === "string" ? value.trim() : "";
  const normalized = address.toLowerCase();
  return ADDRESS_RE.test(normalized) && normalized !== ZERO_ADDRESS ? address : null;
}

function identityLabel(value) {
  if (typeof value !== "string") return null;
  return value.normalize("NFKC").replace(/\s+/gu, " ").trim() || null;
}

function identityComparable(value) {
  return identityLabel(value)?.toLocaleLowerCase("en-US") || null;
}

function sourceReference(value, field) {
  if (typeof value === "string" && value.trim()) return { field, url: value.trim() };
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const url = typeof value.url === "string" && value.url.trim() ? value.url.trim() : null;
  if (!url) return null;
  return {
    field,
    ...(typeof value.id === "string" && value.id ? { id: value.id } : {}),
    ...(typeof value.kind === "string" && value.kind ? { kind: value.kind } : {}),
    url,
    ...(value.official === true ? { official: true } : {}),
  };
}

function matchingChainClaims(event, expectedChainId) {
  const claims = [
    ["event.chainId", event?.chainId],
    ["event.chain.id", event?.chain?.id],
    ["event.chain.chainId", event?.chain?.chainId],
    ["event.platform.chainId", event?.platform?.chainId],
    ["event.evidence.chainId", event?.evidence?.chainId],
    ["event.onchainProof.chainId", event?.onchainProof?.chainId],
  ].filter(([, value]) => value !== undefined && value !== null);
  return claims.every(([, value]) => strictChainId(value) === expectedChainId);
}

function identityAssessment(profile, observedSymbol, observedName, { compareName = true } = {}) {
  const expected = profile?.resolution === "verified_complete"
    ? profile.mappingEvidence?.expectedOnchainIdentity
    : null;
  const canonicalDisplaySymbol = identityLabel(expected?.canonicalDisplaySymbol);
  const canonicalDisplayName = identityLabel(expected?.canonicalDisplayName);
  if (!expected || !canonicalDisplaySymbol || !canonicalDisplayName) {
    return {
      identityStatus: "unverified",
      identityMismatches: [],
      identityComparedFields: [],
      canonicalDisplaySymbol: null,
      canonicalDisplayName: null,
    };
  }

  const comparisons = [
    {
      field: "symbol",
      observed: observedSymbol,
      expected: list(expected.symbols).map(identityLabel).filter(Boolean),
      enabled: true,
    },
    {
      field: "name",
      observed: observedName,
      expected: list(expected.names).map(identityLabel).filter(Boolean),
      enabled: compareName,
    },
  ].filter((comparison) => comparison.enabled && comparison.observed);
  const identityMismatches = comparisons.filter((comparison) => {
    const observed = identityComparable(comparison.observed);
    return !comparison.expected.some((candidate) => identityComparable(candidate) === observed);
  }).map((comparison) => ({
    field: comparison.field,
    observed: comparison.observed,
    expected: comparison.expected,
  }));

  return {
    identityStatus: identityMismatches.length ? "mismatch" : comparisons.length ? "matched" : "unverified",
    identityMismatches,
    identityComparedFields: comparisons.map((comparison) => comparison.field),
    canonicalDisplaySymbol,
    canonicalDisplayName,
  };
}

function contextAsset({
  chainId,
  address,
  symbol,
  name,
  poolTokenAddress = null,
  compareObservedName = true,
  producerObservation,
}) {
  const numericChainId = strictChainId(chainId);
  const referenceAddress = exactAddress(address);
  const exactPoolTokenAddress = poolTokenAddress == null ? null : exactAddress(poolTokenAddress);
  if (!numericChainId || !referenceAddress || (poolTokenAddress != null && !exactPoolTokenAddress)) return null;

  const observedDisplaySymbol = identityLabel(symbol);
  const observedDisplayName = identityLabel(name);
  const profile = resolveVerifiedPoolAssetContext({ chainId: numericChainId, address: referenceAddress });
  const identity = identityAssessment(profile, observedDisplaySymbol, observedDisplayName, {
    compareName: compareObservedName,
  });
  const observation = {
    status: "producer_observed",
    ...producerObservation,
    chainId: numericChainId,
    address: referenceAddress.toLowerCase(),
  };
  const mappingEvidence = {
    status: profile.resolution === "verified_complete"
      ? "reviewed_catalog_plus_producer_observation"
      : "producer_observation_only",
    assetKey: profile.assetKey,
    catalogEvidenceHash: profile.mappingEvidence?.evidenceHash || null,
    producerObservation: { ...observation, evidenceHash: digest(observation) },
  };

  return {
    chainId: numericChainId,
    referenceAddress,
    poolTokenAddress: exactPoolTokenAddress,
    observedDisplaySymbol,
    observedDisplayName,
    canonicalDisplaySymbol: identity.canonicalDisplaySymbol,
    canonicalDisplayName: identity.canonicalDisplayName,
    displaySymbol: identity.canonicalDisplaySymbol || observedDisplaySymbol,
    displayName: identity.canonicalDisplayName || observedDisplayName,
    identityStatus: identity.identityStatus,
    identityMismatches: identity.identityMismatches,
    identityComparedFields: identity.identityComparedFields,
    mappingEvidence: { ...mappingEvidence, evidenceHash: digest(mappingEvidence) },
    profile,
  };
}

export function deriveNewPoolContext(event, { flapQuote = null } = {}) {
  let kind = null;
  let platform = null;
  let status = null;
  let assets = [];

  const flapPlatform = String(event?.platform?.id || event?.project?.id || "").toLowerCase() === "flap";
  const flapPools = list(event?.changes?.newFlapPools).filter((pool) => pool?.kind === "quote_asset");
  if (event?.type === "platform_capability_update" && flapPlatform && flapPools.length) {
    const invalidFlapPool = flapPools.some((pool) => {
      const chainId = strictChainId(pool?.chainId);
      return !chainId || !exactAddress(pool?.quoteAddress) || !matchingChainClaims(event, chainId);
    });
    if (invalidFlapPool) return null;
    kind = "flap_quote_pool";
    platform = { zh: "Flap", en: "Flap" };
    const recovered = flapQuote?.delayedRecovery === true;
    const producerStage = event?.signal?.quotePairChange?.stage;
    const flapStage = ["observed", "live"].includes(flapQuote?.stage)
      ? flapQuote.stage
      : ["observed", "live"].includes(producerStage)
        ? producerStage
        : null;
    const onchain = flapQuote?.onchain === true || flapStage === "live";
    status = recovered
      ? {
          zh: "断线恢复补报｜Portal 0→1 与回执已核；勿追价",
          en: "Delayed recovery | Portal 0→1 and receipt verified; do not chase",
        }
      : onchain
        ? {
            zh: "Portal 0→1 已确认｜已开启该底池前三个 CA 跟踪",
            en: "Portal 0→1 confirmed | first-three-CA tracking opened for this pool",
          }
        : {
            zh: "官方底池资料已观察｜Portal 0→1 仍待确认",
            en: "Official pool metadata observed | Portal 0→1 still pending",
          };
    assets = flapPools.map((pool) => contextAsset({
      chainId: pool.chainId,
      address: pool?.quoteAddress,
      symbol: pool?.quoteSymbol,
      name: pool?.quoteName,
      producerObservation: {
        platform: "flap",
        stage: flapStage,
        chainField: "changes.newFlapPools[].chainId",
        addressField: "changes.newFlapPools[].quoteAddress",
        symbolField: "changes.newFlapPools[].quoteSymbol",
        nameField: "changes.newFlapPools[].quoteName",
        sources: [
          sourceReference(pool?.sourceUrl, "changes.newFlapPools[].sourceUrl"),
          sourceReference(event?.source, "event.source"),
          sourceReference(event?.sourceUrl, "event.sourceUrl"),
        ].filter(Boolean),
      },
    }));
  }

  const fourConfigs = list(event?.changes?.newQuoteConfigs);
  const fourPlatform = String(event?.platform?.id || event?.project?.id || "").toLowerCase();
  if (!kind && event?.type === "platform_capability_update"
    && ["fourmeme", "four.meme", "four_meme"].includes(fourPlatform)
    && fourConfigs.length) {
    const invalidFourConfig = fourConfigs.some((config) => config?.platform !== "MEME"
      || config?.status !== "PUBLISH"
      || config?.networkCode !== "BSC"
      || !exactAddress(config?.address)
      || !matchingChainClaims(event, BSC)
      || (config?.chainId != null && strictChainId(config.chainId) !== BSC)
      || (config?.networkId != null && strictChainId(config.networkId) !== BSC));
    if (invalidFourConfig) return null;
    kind = "four_quote_pool";
    platform = { zh: "Four.Meme", en: "Four.Meme" };
    status = {
      zh: "官方报价配置已发布｜链上启用与首个 TokenCreated CA 待确认",
      en: "Official quote configuration published | on-chain activation and first TokenCreated CA pending",
    };
    assets = fourConfigs.map((config) => contextAsset({
      chainId: BSC,
      address: config.address,
      symbol: config.symbol || config.nativeSymbol,
      name: config.name,
      producerObservation: {
        platform: "fourmeme",
        stage: "published",
        networkField: "changes.newQuoteConfigs[].networkCode",
        networkCode: config.networkCode,
        chainDerivation: "Four.Meme networkCode=BSC => eip155:56",
        addressField: "changes.newQuoteConfigs[].address",
        symbolField: "changes.newQuoteConfigs[].symbol",
        sources: [sourceReference(config?.source, "changes.newQuoteConfigs[].source")].filter(Boolean),
      },
    }));
  }

  const market = event?.market || event?.currentSnapshot;
  const ponPlatform = String(event?.platform?.id || "").toLowerCase() === "ponfun";
  if (!kind && event?.type === "pon_fun_update" && event?.kind === "market_created" && ponPlatform && market) {
    const chainId = strictChainId(event?.chainId);
    const coinClaims = [
      event?.market?.coin,
      event?.currentSnapshot?.coin,
      event?.token,
      event?.contractAddress,
    ].filter((value) => value !== undefined && value !== null && value !== "");
    const coinAddresses = coinClaims.map(exactAddress);
    const stockTokenClaims = [event?.market?.stockToken, event?.currentSnapshot?.stockToken]
      .filter((value) => value !== undefined && value !== null && value !== "");
    const stockTokenAddresses = stockTokenClaims.map(exactAddress);
    const tickerClaims = [event?.market?.ticker, event?.currentSnapshot?.ticker]
      .filter((value) => value !== undefined && value !== null && value !== "");
    const normalizedTickers = tickerClaims.map(identityComparable);
    const coinAddress = coinAddresses[0] || null;
    const stockTokenAddress = stockTokenAddresses[0] || null;
    const observedTicker = identityLabel(tickerClaims[0]);
    if (chainId !== PON_CHAIN
      || !matchingChainClaims(event, PON_CHAIN)
      || !coinClaims.length
      || coinAddresses.some((address) => !address)
      || new Set(coinAddresses.map((address) => address.toLowerCase())).size !== 1
      || !stockTokenClaims.length
      || stockTokenAddresses.some((address) => !address)
      || new Set(stockTokenAddresses.map((address) => address.toLowerCase())).size !== 1
      || normalizedTickers.some((ticker) => !ticker)
      || new Set(normalizedTickers).size > 1) return null;
    kind = "pon_stock_market";
    platform = { zh: "pon.fun", en: "pon.fun" };
    status = {
      zh: "MarketCreated 回执 + 官方 markets API + Factory 绑定已核",
      en: "MarketCreated receipt + official markets API + Factory binding verified",
    };
    assets = [contextAsset({
      chainId,
      address: stockTokenAddress,
      symbol: observedTicker,
      name: market.name,
      poolTokenAddress: coinAddress,
      compareObservedName: false,
      producerObservation: {
        platform: "ponfun",
        stage: "live",
        chainField: "event.chainId",
        addressField: "market.stockToken",
        symbolField: "market.ticker",
        nameField: "market.name (market label; not stockToken ERC-20 name)",
        sources: [
          sourceReference(event?.evidence?.api?.marketsUrl, "event.evidence.api.marketsUrl"),
          sourceReference(event?.evidence?.api?.tokenListUrl, "event.evidence.api.tokenListUrl"),
          sourceReference(event?.source, "event.source"),
        ].filter(Boolean),
      },
    })];
  }

  if (!kind || !assets.length || assets.some((asset) => !asset)) return null;
  const context = {
    version: NEW_POOL_CONTEXT_VERSION,
    kind,
    platform,
    status,
    ...(kind === "flap_quote_pool" ? {
      stage: assets[0]?.mappingEvidence?.producerObservation?.stage || null,
      bstock: flapQuote?.bstock === true,
      recovery: flapQuote?.recovery === true,
      boardMetadataDelayed: flapQuote?.boardMetadataDelayed === true,
      recoveryLagMs: Number.isFinite(Number(flapQuote?.recoveryLagMs)) ? Number(flapQuote.recoveryLagMs) : null,
      deliveryLagMs: Number.isFinite(Number(flapQuote?.deliveryLagMs)) ? Number(flapQuote.deliveryLagMs) : null,
    } : {}),
    assets,
    overflowCount: Math.max(0, assets.length - 2),
  };
  return { ...context, sourceHash: digest(context) };
}
