import { createHash } from "node:crypto";

const HANDLE = /^[A-Za-z0-9_]{1,15}$/u;
const X_USER_ID = /^[1-9]\d{0,20}$/u;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const X_PROFILE_URL = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/?$/iu;
const X_POST_URL = /^https:\/\/x\.com\/([A-Za-z0-9_]{1,15})\/status\/([1-9]\d{0,20})\/?$/iu;
const HTTPS_URL = /^https:\/\//iu;
const DAY_MS = 86_400_000;
const DEFAULT_CATALOG_MAXIMUM_AGE_MS = 180 * DAY_MS;
const DEFAULT_OBSERVATION_MAXIMUM_AGE_MS = DAY_MS;
const FUTURE_TOLERANCE_MS = 60_000;

export const CAPITAL_KOL_CATALOG_SCHEMA_VERSION = 1;
export const CAPITAL_KOL_CATALOG_VERSION = "2026-09-06.3";
export const CAPITAL_KOL_CATALOG_PUBLISHED_AT = "2026-09-06T18:38:13.000Z";

export const CAPITAL_KOL_CATEGORIES = Object.freeze([
  "crypto_founder",
  "crypto_exchange",
  "crypto_vc_fund",
  "web2_tech",
  "web2_ai",
  "web2_finance_capital",
]);

export const CAPITAL_KOL_ELIGIBILITY_BASES = Object.freeze([
  "major_protocol_founder",
  "major_crypto_exchange_executive",
  "major_venture_fund_general_partner",
  "major_crypto_fund_managing_partner",
  "major_technology_company_ceo",
  "frontier_ai_company_ceo",
  "investment_manager_ceo_cio",
  "public_company_capital_allocator",
]);

export const CAPITAL_KOL_ELIGIBILITY_POLICY = Object.freeze({
  scope: "crypto_or_web2_capital_leader",
  followers: "display_only",
  followersAffectIdentity: false,
  followersAffectAdmission: false,
  followersAffectScoring: false,
  unknownCandidates: "quarantine",
  requiredIdentityClaims: Object.freeze(["exact_handle", "expected_x_user_id"]),
  requiredEvidence: Object.freeze(["x_profile", "numeric_x_identity", "official_role"]),
});

const REVIEWED_AT = "2026-09-06T18:38:13.000Z";
const CHECKED_ON = "2026-09-06";

const seedEntries = [
  {
    id: "vitalik-buterin",
    subjectType: "person",
    handle: "VitalikButerin",
    expectedXUserId: "295218901",
    canonicalName: "Vitalik Buterin",
    category: "crypto_founder",
    affiliation: { name: "Ethereum", officialDomains: ["ethereum.org"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_protocol_founder", evidenceUrl: "https://ethereum.org/ethereum-history-founder-and-ownership/" },
    background: {
      zh: "以太坊的提出者与联合创始人，长期参与以太坊协议与生态方向讨论。",
      en: "Originator and co-founder of Ethereum who remains active in protocol and ecosystem discussions.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/VitalikButerin", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/VitalikButerin", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://ethereum.org/ethereum-history-founder-and-ownership/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "brian-armstrong",
    subjectType: "person",
    handle: "brian_armstrong",
    expectedXUserId: "14379660",
    canonicalName: "Brian Armstrong",
    category: "crypto_exchange",
    affiliation: { name: "Coinbase", officialDomains: ["coinbase.com", "help.coinbase.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_crypto_exchange_executive", evidenceUrl: "https://www.coinbase.com/about" },
    background: {
      zh: "Coinbase 联合创始人兼首席执行官，业务横跨加密交易、托管与链上基础设施。",
      en: "Co-founder and CEO of Coinbase, spanning crypto trading, custody, and onchain infrastructure.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/brian_armstrong", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/brian_armstrong", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://www.coinbase.com/about", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
      { kind: "official_handle_directory", url: "https://help.coinbase.com/en/coinbase/other-topics/other/is-coinbase-present-on-social-media", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle", "canonical_name"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "richard-teng",
    subjectType: "person",
    handle: "_RichardTeng",
    expectedXUserId: "1395261244769112065",
    canonicalName: "Richard Teng",
    category: "crypto_exchange",
    affiliation: { name: "Binance", officialDomains: ["binance.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_crypto_exchange_executive", evidenceUrl: "https://www.binance.com/en/blog/from-our-ceo/4582493092274482304" },
    background: {
      zh: "Binance 联席首席执行官，曾任金融监管机构与交易所高管。",
      en: "Co-CEO of Binance with prior senior leadership experience in financial regulation and exchanges.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/_RichardTeng", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/_RichardTeng", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://www.binance.com/en/blog/from-our-ceo/4582493092274482304", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "marc-andreessen",
    subjectType: "person",
    handle: "pmarca",
    expectedXUserId: "5943622",
    canonicalName: "Marc Andreessen",
    category: "crypto_vc_fund",
    affiliation: { name: "Andreessen Horowitz", officialDomains: ["a16z.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_venture_fund_general_partner", evidenceUrl: "https://a16z.com/what-ive-been-up-to-lately/" },
    background: {
      zh: "Andreessen Horowitz 联合创始人兼普通合伙人，长期投资科技与加密网络。",
      en: "Co-founder and general partner at Andreessen Horowitz, investing across technology and crypto networks.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/pmarca", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/pmarca", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://a16z.com/what-ive-been-up-to-lately/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle", "canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "chris-dixon",
    subjectType: "person",
    handle: "cdixon",
    expectedXUserId: "2529971",
    canonicalName: "Chris Dixon",
    category: "crypto_vc_fund",
    affiliation: { name: "a16z crypto", officialDomains: ["a16z.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_crypto_fund_managing_partner", evidenceUrl: "https://a16z.com/ai-crypto-internet-chris-dixon/" },
    background: {
      zh: "a16z crypto 创始负责人及管理合伙人，聚焦加密网络与 Web3 投资。",
      en: "Founder and managing partner of a16z crypto, focused on crypto networks and Web3 investing.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/cdixon", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/cdixon", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://a16z.com/ai-crypto-internet-chris-dixon/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle", "canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "elon-musk",
    subjectType: "person",
    handle: "elonmusk",
    expectedXUserId: "44196397",
    canonicalName: "Elon Musk",
    category: "web2_tech",
    affiliation: { name: "Tesla", officialDomains: ["tesla.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_technology_company_ceo", evidenceUrl: "https://www.tesla.com/elon-musk" },
    background: {
      zh: "Tesla 首席执行官，并领导或创办多家航天、人工智能及基础设施企业。",
      en: "CEO of Tesla and a leader or founder of major space, AI, and infrastructure companies.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/elonmusk", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/elonmusk", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://www.tesla.com/elon-musk", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "satya-nadella",
    subjectType: "person",
    handle: "satyanadella",
    expectedXUserId: "20571756",
    canonicalName: "Satya Nadella",
    category: "web2_tech",
    affiliation: { name: "Microsoft", officialDomains: ["microsoft.com", "news.microsoft.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_technology_company_ceo", evidenceUrl: "https://news.microsoft.com/source/leadership" },
    background: {
      zh: "Microsoft 董事长兼首席执行官，负责云计算、企业软件与人工智能战略。",
      en: "Chairman and CEO of Microsoft, overseeing cloud, enterprise software, and AI strategy.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/satyanadella", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/satyanadella", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://news.microsoft.com/source/leadership", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "sam-altman",
    subjectType: "person",
    handle: "sama",
    expectedXUserId: "1605",
    canonicalName: "Sam Altman",
    category: "web2_ai",
    affiliation: { name: "OpenAI", officialDomains: ["openai.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "frontier_ai_company_ceo", evidenceUrl: "https://openai.com/index/amazon-partnership/" },
    background: {
      zh: "OpenAI 联合创始人兼首席执行官，聚焦前沿人工智能产品与基础设施。",
      en: "Co-founder and CEO of OpenAI, focused on frontier AI products and infrastructure.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/sama", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/sama", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://openai.com/index/amazon-partnership/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "cathie-wood",
    subjectType: "person",
    handle: "CathieDWood",
    expectedXUserId: "2361631088",
    canonicalName: "Cathie Wood",
    category: "web2_finance_capital",
    affiliation: { name: "ARK Investment Management", officialDomains: ["ark-invest.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "investment_manager_ceo_cio", evidenceUrl: "https://www.ark-invest.com/our-team" },
    background: {
      zh: "ARK Invest 创始人、首席执行官兼首席投资官，投资重点包括颠覆式创新、人工智能与区块链。",
      en: "Founder, CEO, and CIO of ARK Invest, focused on disruptive innovation including AI and blockchain.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/CathieDWood", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/CathieDWood", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://www.ark-invest.com/our-team", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
      { kind: "official_handle_directory", url: "https://www.ark-invest.com/faq", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "michael-saylor",
    subjectType: "person",
    handle: "saylor",
    expectedXUserId: "244647486",
    canonicalName: "Michael Saylor",
    category: "web2_finance_capital",
    affiliation: { name: "Strategy", officialDomains: ["strategy.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "public_company_capital_allocator", evidenceUrl: "https://www.strategy.com/investor-relations/executive-team/michael-saylor" },
    background: {
      zh: "Strategy 创始人兼执行董事长，以企业资本配置和比特币储备策略著称。",
      en: "Founder and executive chairman of Strategy, known for corporate capital allocation and Bitcoin treasury strategy.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/saylor", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/saylor", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://www.strategy.com/investor-relations/executive-team/michael-saylor", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "hayden-adams",
    subjectType: "person",
    handle: "haydenzadams",
    expectedXUserId: "702654540387127296",
    canonicalName: "Hayden Adams",
    category: "crypto_founder",
    affiliation: { name: "Uniswap Labs", officialDomains: ["about.uniswap.org", "uniswap.org"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_protocol_founder", evidenceUrl: "https://about.uniswap.org/" },
    background: {
      zh: "Uniswap Labs 创始人兼首席执行官，创建 Uniswap 协议并领导其交易与基础设施产品。",
      en: "Founder and CEO of Uniswap Labs who created the Uniswap Protocol and leads its trading and infrastructure products.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/haydenzadams", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/haydenzadams", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://about.uniswap.org/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "stani-kulechov",
    subjectType: "person",
    handle: "StaniKulechov",
    expectedXUserId: "952921795316912133",
    canonicalName: "Stani Kulechov",
    category: "crypto_founder",
    affiliation: { name: "Avara", officialDomains: ["avara.xyz"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_protocol_founder", evidenceUrl: "https://avara.xyz/blog/family-accounts" },
    background: {
      zh: "Avara 创始人兼首席执行官，创建 Aave 协议并领导其 Web3 产品生态。",
      en: "Founder and CEO of Avara who created the Aave Protocol and leads its Web3 product ecosystem.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/StaniKulechov", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/StaniKulechov", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://avara.xyz/blog/family-accounts", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "charles-hoskinson",
    subjectType: "person",
    handle: "IOHK_Charles",
    expectedXUserId: "1376161898",
    canonicalName: "Charles Hoskinson",
    category: "crypto_founder",
    affiliation: { name: "Input Output Group", officialDomains: ["iog.io"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_protocol_founder", evidenceUrl: "https://www.iog.io/leadership" },
    background: {
      zh: "Input Output Group 创始人兼首席执行官，是 Cardano 背后公司的核心领导者及以太坊联合创始人。",
      en: "Founder and CEO of Input Output Group, the company behind Cardano, and a co-founder of Ethereum.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/IOHK_Charles", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/IOHK_Charles", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://www.iog.io/leadership", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "sergey-nazarov",
    subjectType: "person",
    handle: "SergeyNazarov",
    expectedXUserId: "46238620",
    canonicalName: "Sergey Nazarov",
    category: "crypto_founder",
    affiliation: { name: "Chainlink", officialDomains: ["chain.link", "chainlinklabs.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_protocol_founder", evidenceUrl: "https://chain.link/block-stories" },
    background: {
      zh: "Chainlink 联合创始人兼 Chainlink Labs 首席执行官，领导预言机、互操作与链上资本市场基础设施。",
      en: "Co-founder of Chainlink and CEO of Chainlink Labs, leading oracle, interoperability, and onchain capital-markets infrastructure.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/SergeyNazarov", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/SergeyNazarov", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://chain.link/block-stories", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "emin-gun-sirer",
    subjectType: "person",
    handle: "el33th4xor",
    expectedXUserId: "399412477",
    canonicalName: "Emin Gün Sirer",
    category: "crypto_founder",
    affiliation: { name: "Ava Labs", officialDomains: ["avalabs.org", "avax.network", "docs.avax.network"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_protocol_founder", evidenceUrl: "https://docs.avax.network/blog/delegatecall-incident" },
    background: {
      zh: "Ava Labs 创始人兼首席执行官，领导 Avalanche 核心技术与生态基础设施开发。",
      en: "Founder and CEO of Ava Labs, leading core technology and ecosystem infrastructure for Avalanche.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/el33th4xor", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/el33th4xor", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://docs.avax.network/blog/delegatecall-incident", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "tyler-winklevoss",
    subjectType: "person",
    handle: "tyler",
    expectedXUserId: "24222556",
    canonicalName: "Tyler Winklevoss",
    category: "crypto_exchange",
    affiliation: { name: "Gemini", officialDomains: ["gemini.com", "investors.gemini.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_crypto_exchange_executive", evidenceUrl: "https://investors.gemini.com/corporate-governance/management-team" },
    background: {
      zh: "Gemini 联合创始人、首席执行官兼董事，领导受监管的加密交易及托管业务。",
      en: "Co-founder, CEO, and director of Gemini, leading its regulated crypto trading and custody businesses.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/tyler", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/tyler", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://investors.gemini.com/corporate-governance/management-team", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "cameron-winklevoss",
    subjectType: "person",
    handle: "cameron",
    expectedXUserId: "250980843",
    canonicalName: "Cameron Winklevoss",
    category: "crypto_exchange",
    affiliation: { name: "Gemini", officialDomains: ["gemini.com", "investors.gemini.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_crypto_exchange_executive", evidenceUrl: "https://investors.gemini.com/corporate-governance/management-team" },
    background: {
      zh: "Gemini 联合创始人、总裁兼董事，负责加密交易平台及相关资本业务。",
      en: "Co-founder, president, and director of Gemini, overseeing its crypto exchange and related capital businesses.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/cameron", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/cameron", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://investors.gemini.com/corporate-governance/management-team", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "kris-marszalek",
    subjectType: "person",
    handle: "kris",
    expectedXUserId: "84850888",
    canonicalName: "Kris Marszalek",
    category: "crypto_exchange",
    affiliation: { name: "Crypto.com", officialDomains: ["crypto.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_crypto_exchange_executive", evidenceUrl: "https://crypto.com/us/about/" },
    background: {
      zh: "Crypto.com 联合创始人兼首席执行官，领导加密交易、支付与托管平台。",
      en: "Co-founder and CEO of Crypto.com, leading its crypto trading, payments, and custody platform.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/kris", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/kris", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://crypto.com/us/about/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "ben-horowitz",
    subjectType: "person",
    handle: "bhorowitz",
    expectedXUserId: "16242081",
    canonicalName: "Ben Horowitz",
    category: "crypto_vc_fund",
    affiliation: { name: "Andreessen Horowitz", officialDomains: ["a16z.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_venture_fund_general_partner", evidenceUrl: "https://a16z.com/books/the-hard-thing-about-hard-things/" },
    background: {
      zh: "Andreessen Horowitz 联合创始人兼普通合伙人，投资科技、人工智能与加密网络。",
      en: "Co-founder and general partner at Andreessen Horowitz, investing across technology, AI, and crypto networks.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/bhorowitz", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/bhorowitz", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://a16z.com/books/the-hard-thing-about-hard-things/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "dan-morehead",
    subjectType: "person",
    handle: "dan_pantera",
    expectedXUserId: "385162204",
    canonicalName: "Dan Morehead",
    category: "crypto_vc_fund",
    affiliation: { name: "Pantera Capital", officialDomains: ["panteracapital.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_crypto_fund_managing_partner", evidenceUrl: "https://panteracapital.com/team/" },
    background: {
      zh: "Pantera Capital 创始人兼管理合伙人，领导专注区块链资产的机构投资平台。",
      en: "Founder and managing partner of Pantera Capital, leading an institutional investment platform focused on blockchain assets.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/dan_pantera", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/dan_pantera", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://panteracapital.com/team/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "paul-veradittakit",
    subjectType: "person",
    handle: "veradittakit",
    expectedXUserId: "60860700",
    canonicalName: "Paul Veradittakit",
    category: "crypto_vc_fund",
    affiliation: { name: "Pantera Capital", officialDomains: ["panteracapital.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_crypto_fund_managing_partner", evidenceUrl: "https://panteracapital.com/team/" },
    background: {
      zh: "Pantera Capital 管理合伙人，负责区块链公司的战略投资与投资组合建设。",
      en: "Managing partner at Pantera Capital, focused on strategic investments and portfolio building across blockchain companies.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/veradittakit", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/veradittakit", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://panteracapital.com/team/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "haseeb-qureshi",
    subjectType: "person",
    handle: "hosseeb",
    expectedXUserId: "231208649",
    canonicalName: "Haseeb Qureshi",
    category: "crypto_vc_fund",
    affiliation: { name: "Dragonfly", officialDomains: ["dragonfly.xyz"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_crypto_fund_managing_partner", evidenceUrl: "https://www.dragonfly.xyz/" },
    background: {
      zh: "Dragonfly 管理合伙人，负责全球加密项目的早期及成长阶段投资。",
      en: "Managing partner at Dragonfly, investing in crypto projects globally from early through growth stages.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/hosseeb", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/hosseeb", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://www.dragonfly.xyz/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "kyle-samani",
    subjectType: "person",
    handle: "KyleSamani",
    expectedXUserId: "46332443",
    canonicalName: "Kyle Samani",
    category: "crypto_vc_fund",
    affiliation: { name: "Multicoin Capital", officialDomains: ["multicoin.capital"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_crypto_fund_managing_partner", evidenceUrl: "https://multicoin.capital/2024/12/13/highlights-from-the-2024-multicoin-summit/" },
    background: {
      zh: "Multicoin Capital 联合创始人兼管理合伙人，投资代币、协议及区块链公司。",
      en: "Co-founder and managing partner of Multicoin Capital, investing in tokens, protocols, and blockchain companies.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/KyleSamani", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/KyleSamani", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://multicoin.capital/2024/12/13/highlights-from-the-2024-multicoin-summit/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "sundar-pichai",
    subjectType: "person",
    handle: "sundarpichai",
    expectedXUserId: "14130366",
    canonicalName: "Sundar Pichai",
    category: "web2_tech",
    affiliation: { name: "Google and Alphabet", officialDomains: ["about.google", "google.com", "abc.xyz"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_technology_company_ceo", evidenceUrl: "https://about.google/company-info/" },
    background: {
      zh: "Google 与 Alphabet 首席执行官，主导搜索、云计算与人工智能战略。",
      en: "CEO of Google and Alphabet, leading strategy across search, cloud computing, and artificial intelligence.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/sundarpichai", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/sundarpichai", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://about.google/company-info/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "lisa-su",
    subjectType: "person",
    handle: "LisaSu",
    expectedXUserId: "836224570013138944",
    canonicalName: "Lisa Su",
    category: "web2_tech",
    affiliation: { name: "AMD", officialDomains: ["amd.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_technology_company_ceo", evidenceUrl: "https://www.amd.com/en/corporate/leadership/lisa-su.html" },
    background: {
      zh: "AMD 董事长兼首席执行官，领导高性能计算、数据中心与人工智能芯片战略。",
      en: "Chair and CEO of AMD, leading high-performance computing, data-center, and AI semiconductor strategy.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/LisaSu", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/LisaSu", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://www.amd.com/en/corporate/leadership/lisa-su.html", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "dario-amodei",
    subjectType: "person",
    handle: "DarioAmodei",
    expectedXUserId: "874126509245476864",
    canonicalName: "Dario Amodei",
    category: "web2_ai",
    affiliation: { name: "Anthropic", officialDomains: ["anthropic.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "frontier_ai_company_ceo", evidenceUrl: "https://www.anthropic.com/company/leadership" },
    background: {
      zh: "Anthropic 联合创始人兼首席执行官，领导前沿人工智能研究、产品与公司战略。",
      en: "Co-founder and CEO of Anthropic, leading frontier AI research, products, and corporate strategy.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/DarioAmodei", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/DarioAmodei", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://www.anthropic.com/company/leadership", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "andy-jassy",
    subjectType: "person",
    handle: "ajassy",
    expectedXUserId: "26389359",
    canonicalName: "Andy Jassy",
    category: "web2_tech",
    affiliation: { name: "Amazon", officialDomains: ["amazon.com", "aboutamazon.com", "ir.aboutamazon.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_technology_company_ceo", evidenceUrl: "https://ir.aboutamazon.com/officers-and-directors/default.aspx" },
    background: {
      zh: "Amazon 总裁兼首席执行官，领导电商、AWS 云服务与人工智能业务。",
      en: "President and CEO of Amazon, leading commerce, AWS cloud services, and artificial intelligence businesses.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/ajassy", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/ajassy", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://ir.aboutamazon.com/officers-and-directors/default.aspx", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "marc-benioff",
    subjectType: "person",
    handle: "Benioff",
    expectedXUserId: "22330739",
    canonicalName: "Marc Benioff",
    category: "web2_tech",
    affiliation: { name: "Salesforce", officialDomains: ["salesforce.com", "investor.salesforce.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "major_technology_company_ceo", evidenceUrl: "https://investor.salesforce.com/governance/board-of-directors/default.aspx" },
    background: {
      zh: "Salesforce 董事长、首席执行官兼联合创始人，领导企业云软件与智能体人工智能战略。",
      en: "Chair, CEO, and co-founder of Salesforce, leading enterprise cloud software and agentic AI strategy.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/Benioff", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/Benioff", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://investor.salesforce.com/governance/board-of-directors/default.aspx", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "bill-ackman",
    subjectType: "person",
    handle: "BillAckman",
    expectedXUserId: "880412538625810432",
    canonicalName: "Bill Ackman",
    category: "web2_finance_capital",
    affiliation: { name: "Pershing Square", officialDomains: ["pershingsquareholdings.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "investment_manager_ceo_cio", evidenceUrl: "https://pershingsquareholdings.com/pershing-square-holdings-ltd-notes-additional-quarterly-communications/" },
    background: {
      zh: "Pershing Square 首席执行官兼投资组合经理，负责集中式公开市场投资与资本配置。",
      en: "CEO and portfolio manager of Pershing Square, responsible for concentrated public-market investing and capital allocation.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/BillAckman", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/BillAckman", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://pershingsquareholdings.com/pershing-square-holdings-ltd-notes-additional-quarterly-communications/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
  {
    id: "jeffrey-gundlach",
    subjectType: "person",
    handle: "TruthGundlach",
    expectedXUserId: "861619895485726722",
    canonicalName: "Jeffrey Gundlach",
    category: "web2_finance_capital",
    affiliation: { name: "DoubleLine", officialDomains: ["doubleline.com"] },
    eligibility: { status: "reviewed_big_cap_leader", basis: "investment_manager_ceo_cio", evidenceUrl: "https://doubleline.com/leadership/" },
    background: {
      zh: "DoubleLine 首席执行官兼首席投资官，领导固定收益与多资产投资管理。",
      en: "CEO and CIO of DoubleLine, leading fixed-income and multi-asset investment management.",
    },
    evidence: [
      { kind: "x_profile", url: "https://x.com/TruthGundlach", authority: "subject_controlled", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["exact_handle"] },
      { kind: "numeric_x_identity", url: "https://api.fxtwitter.com/TruthGundlach", authority: "public_profile_mirror", status: "corroborated", checkedAt: CHECKED_ON, supports: ["exact_handle", "expected_x_user_id"] },
      { kind: "official_role", url: "https://doubleline.com/leadership/", authority: "official_organization", status: "primary_verified", checkedAt: CHECKED_ON, supports: ["canonical_name", "category", "background"] },
    ],
    review: { status: "reviewed", method: "manual_primary_source_review", reviewedAt: REVIEWED_AT },
  },
];

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function contentHash(entries) {
  const payload = stableValue({
    schemaVersion: CAPITAL_KOL_CATALOG_SCHEMA_VERSION,
    version: CAPITAL_KOL_CATALOG_VERSION,
    publishedAt: CAPITAL_KOL_CATALOG_PUBLISHED_AT,
    entries,
  });
  return `sha256:${createHash("sha256").update(JSON.stringify(payload)).digest("hex")}`;
}

const reviewedEntries = deepFreeze(seedEntries);
const computedCatalogHash = contentHash(reviewedEntries);

// This literal is intentionally patched after reviewing the seed. Runtime
// admission checks it so an accidental catalog edit fails closed.
export const EXPECTED_CAPITAL_KOL_CATALOG_HASH = "sha256:2916b223b0b368ea8328b681890ed242c3ed0199b2f89ccd3ff16c39dfb0670e";
export const CAPITAL_KOL_CATALOG_HASH = EXPECTED_CAPITAL_KOL_CATALOG_HASH;

function cleanHandle(value) {
  return String(value || "").trim().replace(/^@/u, "");
}

function validDate(value) {
  return ISO_DATE.test(String(value || "")) && Number.isFinite(Date.parse(`${value}T00:00:00.000Z`));
}

function forbiddenFollowerField(value) {
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => /followers?|audience(?:Count)?/iu.test(key)
    || forbiddenFollowerField(child));
}

function validEvidenceUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function evidenceHostname(value) {
  try {
    return new URL(value).hostname.toLowerCase().replace(/^www\./u, "");
  } catch {
    return "";
  }
}

function exactNumericEvidenceUrl(value, handle) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "api.fxtwitter.com"
      && url.pathname.replace(/^\/+|\/+$/gu, "").toLowerCase() === handle.toLowerCase()
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

export function validateCapitalKolCatalog(entries = reviewedEntries) {
  const reasons = [];
  const add = (condition, reason) => { if (!condition) reasons.push(reason); };
  add(Array.isArray(entries) && entries.length > 0, "catalog_empty_or_invalid");
  if (!Array.isArray(entries)) return { valid: false, reasons, hash: null };

  const ids = new Set();
  const handles = new Set();
  const expectedIds = new Set();
  for (const [index, entry] of entries.entries()) {
    const prefix = `entry_${index}`;
    const handle = cleanHandle(entry?.handle);
    const handleKey = handle.toLowerCase();
    add(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(String(entry?.id || "")), `${prefix}:invalid_id`);
    add(entry?.subjectType === "person", `${prefix}:subject_must_be_person`);
    add(!ids.has(entry?.id), `${prefix}:duplicate_id`);
    ids.add(entry?.id);
    add(HANDLE.test(handle), `${prefix}:invalid_handle`);
    add(!handles.has(handleKey), `${prefix}:duplicate_handle`);
    handles.add(handleKey);
    add(X_USER_ID.test(String(entry?.expectedXUserId || "")), `${prefix}:missing_or_invalid_expected_x_user_id`);
    add(!expectedIds.has(String(entry?.expectedXUserId || "")), `${prefix}:duplicate_expected_x_user_id`);
    expectedIds.add(String(entry?.expectedXUserId || ""));
    add(typeof entry?.canonicalName === "string" && entry.canonicalName.trim().length >= 3, `${prefix}:invalid_canonical_name`);
    add(CAPITAL_KOL_CATEGORIES.includes(entry?.category), `${prefix}:invalid_category`);
    const officialDomains = Array.isArray(entry?.affiliation?.officialDomains)
      ? entry.affiliation.officialDomains.map((value) => String(value).toLowerCase().replace(/^www\./u, ""))
      : [];
    add(typeof entry?.affiliation?.name === "string" && entry.affiliation.name.trim().length >= 2
      && officialDomains.length > 0
      && officialDomains.every((domain) => /^[a-z0-9.-]+\.[a-z]{2,}$/u.test(domain)), `${prefix}:invalid_affiliation`);
    add(entry?.eligibility?.status === "reviewed_big_cap_leader"
      && CAPITAL_KOL_ELIGIBILITY_BASES.includes(entry?.eligibility?.basis)
      && validEvidenceUrl(entry?.eligibility?.evidenceUrl)
      && officialDomains.includes(evidenceHostname(entry?.eligibility?.evidenceUrl)), `${prefix}:invalid_big_cap_eligibility`);
    add(typeof entry?.background?.zh === "string" && entry.background.zh.trim().length >= 12, `${prefix}:invalid_background_zh`);
    add(typeof entry?.background?.en === "string" && entry.background.en.trim().length >= 24, `${prefix}:invalid_background_en`);
    add(entry?.review?.status === "reviewed" && entry?.review?.method === "manual_primary_source_review"
      && entry?.review?.reviewedAt === CAPITAL_KOL_CATALOG_PUBLISHED_AT, `${prefix}:not_manually_reviewed`);
    add(!forbiddenFollowerField(entry), `${prefix}:followers_must_not_be_catalog_identity_data`);

    const evidence = Array.isArray(entry?.evidence) ? entry.evidence : [];
    const xProfile = evidence.find((item) => item?.kind === "x_profile");
    const numericIdentity = evidence.find((item) => item?.kind === "numeric_x_identity");
    const officialRole = evidence.find((item) => item?.kind === "official_role");
    const xMatch = String(xProfile?.url || "").match(X_PROFILE_URL);
    add(xMatch?.[1]?.toLowerCase() === handleKey
      && xProfile?.authority === "subject_controlled"
      && xProfile?.status === "primary_verified"
      && xProfile?.supports?.includes("exact_handle"), `${prefix}:x_profile_evidence_invalid`);
    add(numericIdentity?.authority === "public_profile_mirror"
      && numericIdentity?.status === "corroborated"
      && evidenceHostname(numericIdentity?.url) === "api.fxtwitter.com"
      && exactNumericEvidenceUrl(numericIdentity?.url, handle)
      && numericIdentity?.supports?.includes("exact_handle")
      && numericIdentity?.supports?.includes("expected_x_user_id"), `${prefix}:numeric_x_identity_evidence_invalid`);
    add(officialRole?.authority === "official_organization"
      && officialRole?.status === "primary_verified"
      && officialDomains.includes(evidenceHostname(officialRole?.url))
      && officialRole?.supports?.includes("canonical_name")
      && officialRole?.supports?.includes("category")
      && officialRole?.supports?.includes("background"), `${prefix}:official_role_evidence_invalid`);
    add(entry?.eligibility?.evidenceUrl === officialRole?.url, `${prefix}:eligibility_evidence_not_official_role`);
    for (const item of evidence) {
      add(validEvidenceUrl(item?.url) && HTTPS_URL.test(item.url), `${prefix}:evidence_url_invalid`);
      add(validDate(item?.checkedAt), `${prefix}:evidence_checked_at_invalid`);
      add(item?.checkedAt === CAPITAL_KOL_CATALOG_PUBLISHED_AT.slice(0, 10), `${prefix}:evidence_not_bound_to_catalog_version_date`);
    }
  }
  return { valid: reasons.length === 0, reasons, hash: contentHash(entries) };
}

export function verifyCapitalKolCatalogIntegrity() {
  const validation = validateCapitalKolCatalog(reviewedEntries);
  const hashMatches = computedCatalogHash === EXPECTED_CAPITAL_KOL_CATALOG_HASH;
  return deepFreeze({
    valid: validation.valid && hashMatches,
    reasons: [...validation.reasons, ...(!hashMatches ? ["catalog_hash_mismatch"] : [])],
    expectedHash: EXPECTED_CAPITAL_KOL_CATALOG_HASH,
    actualHash: computedCatalogHash,
  });
}

export function capitalKolCatalogFreshness(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const requestedMaximumAgeMs = Number(options.maximumAgeMs);
  const maximumAgeMs = Math.min(DEFAULT_CATALOG_MAXIMUM_AGE_MS, Math.max(DAY_MS,
    Number.isFinite(requestedMaximumAgeMs) ? requestedMaximumAgeMs : DEFAULT_CATALOG_MAXIMUM_AGE_MS));
  const publishedMs = Date.parse(CAPITAL_KOL_CATALOG_PUBLISHED_AT);
  const ageMs = nowMs - publishedMs;
  return deepFreeze({
    valid: Number.isFinite(publishedMs) && ageMs >= -FUTURE_TOLERANCE_MS && ageMs <= maximumAgeMs,
    ageMs,
    maximumAgeMs,
  });
}

export function listReviewedCapitalKols(options = {}) {
  const category = String(options.category || "").trim();
  if (category && !CAPITAL_KOL_CATEGORIES.includes(category)) return [];
  return category ? reviewedEntries.filter((entry) => entry.category === category) : [...reviewedEntries];
}

export function findReviewedCapitalKolByHandle(handle) {
  const normalized = cleanHandle(handle).toLowerCase();
  if (!HANDLE.test(cleanHandle(handle))) return null;
  return reviewedEntries.find((entry) => entry.handle.toLowerCase() === normalized) || null;
}

export function findReviewedCapitalKolByXUserId(xUserId) {
  const normalized = String(xUserId || "").trim();
  if (!X_USER_ID.test(normalized)) return null;
  return reviewedEntries.find((entry) => entry.expectedXUserId === normalized) || null;
}

function backgroundEvidence(entry) {
  return entry.evidence
    .filter((item) => item.supports.includes("background"))
    .map((item) => ({ kind: item.kind, url: item.url, status: item.status, checkedAt: item.checkedAt }));
}

export function createCapitalKolEventSnapshot(entryOrHandle) {
  const entry = typeof entryOrHandle === "string"
    ? findReviewedCapitalKolByHandle(entryOrHandle)
    : findReviewedCapitalKolByHandle(entryOrHandle?.handle);
  if (!entry || entry.expectedXUserId !== String(entryOrHandle?.expectedXUserId || entry.expectedXUserId)) return null;
  if (!verifyCapitalKolCatalogIntegrity().valid) return null;
  return deepFreeze({
    schemaVersion: CAPITAL_KOL_CATALOG_SCHEMA_VERSION,
    catalogVersion: CAPITAL_KOL_CATALOG_VERSION,
    catalogPublishedAt: CAPITAL_KOL_CATALOG_PUBLISHED_AT,
    catalogHash: CAPITAL_KOL_CATALOG_HASH,
    catalogId: entry.id,
    subjectType: entry.subjectType,
    handle: entry.handle,
    xUserId: entry.expectedXUserId,
    canonicalName: entry.canonicalName,
    category: entry.category,
    affiliation: { name: entry.affiliation.name, officialDomains: [...entry.affiliation.officialDomains] },
    eligibility: { ...entry.eligibility },
    background: { ...entry.background },
    backgroundEvidence: backgroundEvidence(entry),
    reviewStatus: entry.review.status,
    identityKey: `capital-kol:x:${entry.expectedXUserId}`,
  });
}

function quarantine(reason, candidate) {
  return deepFreeze({
    status: "quarantined",
    monitorEligible: false,
    reason,
    handle: cleanHandle(candidate?.handle || candidate?.observedHandle) || null,
    xUserId: String(candidate?.xUserId || candidate?.id || "").trim() || null,
  });
}

/**
 * Binds a fresh public profile observation only when both immutable catalog
 * claims match. A follower count may be carried for display but cannot change
 * the admission result, identity key, catalog hash, or any score.
 */
export function bindCapitalKolRuntimeIdentity(observation, options = {}) {
  const integrity = verifyCapitalKolCatalogIntegrity();
  if (!integrity.valid) return quarantine("catalog_integrity_failed", observation);
  const freshness = capitalKolCatalogFreshness({
    nowMs: options.nowMs,
    maximumAgeMs: options.catalogMaximumAgeMs,
  });
  if (!freshness.valid) return quarantine("catalog_stale", observation);

  const handle = cleanHandle(observation?.handle);
  const observedHandle = cleanHandle(observation?.observedHandle);
  const xUserId = String(observation?.xUserId || observation?.id || "").trim();
  const entry = findReviewedCapitalKolByHandle(handle);
  if (!entry) return quarantine("unknown_handle", observation);
  if (observation?.subjectType !== "person") return quarantine("institution_not_person", observation);
  if (observedHandle.toLowerCase() !== entry.handle.toLowerCase()) return quarantine("observed_handle_mismatch", observation);
  if (!X_USER_ID.test(xUserId) || xUserId !== entry.expectedXUserId) return quarantine("expected_x_user_id_mismatch", observation);
  if (observation?.canonicalName != null && String(observation.canonicalName).trim() !== entry.canonicalName) {
    return quarantine("canonical_name_mismatch", observation);
  }
  const profileMatch = String(observation?.profileUrl || "").trim().match(X_PROFILE_URL);
  if (profileMatch?.[1]?.toLowerCase() !== entry.handle.toLowerCase()) return quarantine("profile_url_mismatch", observation);
  if (!["official_x_api_v2_user", "fxtwitter_public_profile"].includes(observation?.source)) {
    return quarantine("identity_source_not_admitted", observation);
  }
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const observedMs = Date.parse(observation?.observedAt || observation?.checkedAt || "");
  const requestedMaximumAgeMs = Number(options.observationMaximumAgeMs);
  const maximumAgeMs = Math.min(DEFAULT_OBSERVATION_MAXIMUM_AGE_MS, Math.max(60_000,
    Number.isFinite(requestedMaximumAgeMs) ? requestedMaximumAgeMs : DEFAULT_OBSERVATION_MAXIMUM_AGE_MS));
  if (!Number.isFinite(observedMs) || observedMs > nowMs + FUTURE_TOLERANCE_MS || nowMs - observedMs > maximumAgeMs) {
    return quarantine("identity_observation_stale_or_invalid", observation);
  }

  const followerCount = Number.isSafeInteger(observation?.followers) && observation.followers >= 0
    ? observation.followers
    : null;
  return deepFreeze({
    status: "admitted",
    monitorEligible: true,
    reason: "reviewed_exact_handle_and_x_user_id",
    identityKey: `capital-kol:x:${entry.expectedXUserId}`,
    entry,
    snapshot: createCapitalKolEventSnapshot(entry),
    binding: {
      handle: entry.handle,
      xUserId: entry.expectedXUserId,
      source: observation.source,
      observedAt: new Date(observedMs).toISOString(),
    },
    display: {
      followers: followerCount,
      policy: "display_only",
    },
  });
}

function sameJson(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

/** Verifies a launch/call event against the exact reviewed catalog snapshot. */
export function verifyCapitalKolEventSnapshot(event) {
  const reasons = [];
  const fail = (condition, reason) => { if (!condition) reasons.push(reason); };
  const snapshot = event?.capitalKolSnapshot || event?.caller?.capitalKolSnapshot || null;
  fail(Boolean(snapshot), "missing_catalog_snapshot");
  const entry = snapshot ? findReviewedCapitalKolByHandle(snapshot.handle) : null;
  fail(Boolean(entry), "unknown_catalog_handle");
  if (!snapshot || !entry) return deepFreeze({ valid: false, reasons, entry: null });

  const expected = createCapitalKolEventSnapshot(entry);
  fail(Boolean(expected), "catalog_integrity_failed");
  fail(snapshot.schemaVersion === CAPITAL_KOL_CATALOG_SCHEMA_VERSION, "catalog_schema_version_mismatch");
  fail(snapshot.catalogVersion === CAPITAL_KOL_CATALOG_VERSION, "catalog_version_mismatch");
  fail(snapshot.catalogPublishedAt === CAPITAL_KOL_CATALOG_PUBLISHED_AT, "catalog_published_at_mismatch");
  fail(snapshot.catalogHash === CAPITAL_KOL_CATALOG_HASH, "catalog_hash_mismatch");
  fail(snapshot.catalogId === entry.id, "catalog_id_mismatch");
  fail(snapshot.subjectType === "person", "subject_type_mismatch");
  fail(cleanHandle(snapshot.handle).toLowerCase() === entry.handle.toLowerCase(), "snapshot_handle_mismatch");
  fail(String(snapshot.xUserId || "") === entry.expectedXUserId, "snapshot_x_user_id_mismatch");
  fail(snapshot.canonicalName === entry.canonicalName, "canonical_name_mismatch");
  fail(snapshot.category === entry.category, "category_mismatch");
  fail(sameJson(snapshot.affiliation, entry.affiliation), "affiliation_mismatch");
  fail(sameJson(snapshot.eligibility, entry.eligibility), "eligibility_mismatch");
  fail(snapshot.reviewStatus === "reviewed", "snapshot_not_reviewed");
  fail(snapshot.identityKey === `capital-kol:x:${entry.expectedXUserId}`, "identity_key_mismatch");
  fail(sameJson(snapshot.background, entry.background), "background_mismatch");
  fail(sameJson(snapshot.backgroundEvidence, backgroundEvidence(entry)), "background_evidence_mismatch");
  fail(Boolean(expected) && sameJson(snapshot, expected), "catalog_snapshot_not_exact");

  const handleClaims = [event?.caller?.handle, event?.handle, event?.tweet?.handle]
    .filter((value) => value != null && String(value).trim() !== "")
    .map((value) => cleanHandle(value).toLowerCase());
  const idClaims = [
    event?.caller?.xProfileId,
    event?.caller?.xUserId,
    event?.tweet?.xUserId,
    event?.tweet?.authorId,
  ].filter((value) => value != null && String(value).trim() !== "").map(String);
  fail(handleClaims.length > 0 && handleClaims.every((value) => value === entry.handle.toLowerCase()), "event_handle_mismatch");
  fail(idClaims.length > 0 && idClaims.every((value) => value === entry.expectedXUserId), "event_x_user_id_mismatch");

  return deepFreeze({ valid: reasons.length === 0, reasons, entry: reasons.length === 0 ? entry : null });
}

export function getCapitalKolCatalogManifest() {
  return deepFreeze({
    schemaVersion: CAPITAL_KOL_CATALOG_SCHEMA_VERSION,
    version: CAPITAL_KOL_CATALOG_VERSION,
    publishedAt: CAPITAL_KOL_CATALOG_PUBLISHED_AT,
    hash: CAPITAL_KOL_CATALOG_HASH,
    count: reviewedEntries.length,
    categories: [...CAPITAL_KOL_CATEGORIES],
    followersPolicy: CAPITAL_KOL_ELIGIBILITY_POLICY.followers,
  });
}
