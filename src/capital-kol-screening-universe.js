import { createHash } from "node:crypto";

import {
  findReviewedCapitalKolByHandle,
  listReviewedCapitalKols,
  verifyCapitalKolCatalogIntegrity,
} from "./capital-kol-catalog.js";

const HANDLE = /^[A-Za-z0-9_]{1,15}$/u;
const X_USER_ID = /^[1-9]\d{0,20}$/u;
const FUTURE_TOLERANCE_MS = 60_000;
const OBSERVATION_MAXIMUM_AGE_MS = 24 * 60 * 60 * 1_000;

export const CAPITAL_KOL_SCREENING_SCHEMA_VERSION = 1;
export const CAPITAL_KOL_SCREENING_VERSION = "2026-09-06.1";
export const CAPITAL_KOL_SCREENING_PUBLISHED_AT = "2026-09-06T18:40:00.000Z";
export const CAPITAL_KOL_SCREENING_TARGET_COUNT = 500;

export const CAPITAL_KOL_SCREENING_POLICY = Object.freeze({
  purpose: "discovery_and_manual_screening_only",
  candidateMonitoringEligible: false,
  automaticPromotion: false,
  requiredPromotionStages: Object.freeze([
    "official_role_verified",
    "official_handle_linked",
    "numeric_x_id_corroborated",
    "manual_primary_source_reviewed",
  ]),
  followers: "display_and_queue_priority_only",
  followersAffectIdentity: false,
  followersAffectAdmission: false,
  followersAffectTrading: false,
});

const SOURCE_DEFINITIONS = Object.freeze({
  reviewed_priority: Object.freeze({
    url: "local://capital-kol-catalog",
    kind: "reviewed_priority_seed",
    authority: "reviewed_catalog_reference",
    retrievedAt: CAPITAL_KOL_SCREENING_PUBLISHED_AT,
  }),
  crypto_twitter_favorites_2025: Object.freeze({
    url: "https://github.com/guildxyz/crypto-twitter-favorites",
    kind: "community_curated_crypto_accounts",
    authority: "discovery_only",
    retrievedAt: CAPITAL_KOL_SCREENING_PUBLISHED_AT,
  }),
  founder_ally_investors_2026: Object.freeze({
    url: "https://github.com/futureforumx/founder-s-ally",
    kind: "community_investor_directory",
    authority: "discovery_only",
    retrievedAt: CAPITAL_KOL_SCREENING_PUBLISHED_AT,
  }),
  ai_angels_2026: Object.freeze({
    url: "https://github.com/conorbronsdon/ai-angels",
    kind: "community_ai_investor_directory",
    authority: "discovery_only",
    retrievedAt: CAPITAL_KOL_SCREENING_PUBLISHED_AT,
  }),
  awesome_tech_accounts_2026: Object.freeze({
    url: "https://github.com/shanmukh05/awesome-tech-twitter-accounts",
    kind: "community_tech_accounts",
    authority: "discovery_only",
    retrievedAt: CAPITAL_KOL_SCREENING_PUBLISHED_AT,
  }),
  legacy_investor_backfill: Object.freeze({
    url: "https://github.com/nyddle/angelrob/blob/master/topinvestors",
    kind: "historical_investor_directory",
    authority: "discovery_only_stale",
    retrievedAt: CAPITAL_KOL_SCREENING_PUBLISHED_AT,
  }),
});

const SOURCE_HANDLE_TEXT = Object.freeze({
  reviewed_priority: `
VitalikButerin brian_armstrong _RichardTeng pmarca cdixon elonmusk satyanadella sama CathieDWood saylor
haydenzadams StaniKulechov IOHK_Charles SergeyNazarov el33th4xor tyler cameron kris bhorowitz dan_pantera
veradittakit hosseeb KyleSamani sundarpichai LisaSu DarioAmodei ajassy Benioff BillAckman TruthGundlach
`,
  crypto_twitter_favorites_2025: `
0mllwntrmt3 0xangelfish 0xDesigner 0xfoobar 0xJoshuaSL 0xMaki 0xMert_ 0xmons 0xpratik 0xSisyphus 0xsmac 0xtuba 0xWenMoon 33b345 a1lon9 abruzuc adam3us adamscochran Adam_Tehc AlamedaTrabucco AlexMasmej AlexOnchain AlgodTrading alistairmilne AltcoinPsycho ameensol anambroid AndreCronjeTech andy8052 AngeloBTC anildelphi antiprosynth apolynya APompliano arjunbhuptani arjunblj Arthur_0x AshAEgan ASvanevik austingriffith AutismCapital AviFelman Awawat_Trades AWice awrigh01 ayyyeandy balajis bantg baoskee BarrySilbert based16z basedkarbon basileus_eth beast_ico benjaminion_xyz benroy_x binji_x blknoiz06 blockchainjames blueclarityone bneiluj bobbyong Bonecondor BoredElonMusk BrantlyMillegan BrennerSpear brian_armstrong brockjelmore buyerofponzi calchulus Cbb0fe cburniske cdixon ChainLinkGod chainyoda CharlotteFang77 chooserich CL207 cmsholdings cobie coffeebreak_YT coinfessions cointelegraph cointradernik Cokedupoptions CryptoCapo_ CryptoDonAlt CryptoKaleo Cryptoyieldinfo crypto_bitlord7 crypto_condom Crypto_Ed_NL crypto_thai Cupojoseph cz_binance d0unbug dabit3 dankrad danrobinson Darrenlautf DCbuild3r dcfgod DeeZe DeFiDave22 defiprime DeFi_Dad DegenerateNews DegenPing DegenSpartan deltaxbt Dennahz DennisonBertram devloper_xyz devops199fan dhof Dogetoshi drakefjustin dwr DylanAbruscato dystopiabreaker eddylazzarin egirl_capital emilyxlai EmperorBTC ErikVoorhees eshita EthereumJesus evabeylin Evan_ss6 evan_van_ness EvgenyGaevoy FatManTerra FEhrsam Fiskantes fomosaurus FreddieFarmer FreddieRaynolds fredwilson functi0nZer0 funghibull gabusch gainzy222 gakonst gametheorizing gammichan garyvee gmoneyNFT goodalexander grugcapital GwartyGwart hal2001 hasufl haydenzadams hentaiavenger66 hosseeb HsakaTrades hudsonjameson HugoMartingale iamDCinvestor iampaulgrewal icebergy intern intocryptoast inversebrah IterIntellectus j0hnwang jackbutcher jbrukh jchervinsky jessepollak jessewldn jmj john_c_palmer josephdelong js_horne justinsuntron kaiynne kirbxbt kmoney_69 knowerofmarkets koeppelmann krugermacro KyleSamani lakshmansankar laurashin lawmaster lay2000lbs LefterisJP lex_node liamihorne libevm lightclients litcapital ljxie LucaNetz m1guelpf MacroMate8 MartinShkreli matthuang medhakothari Melt_Dem mevalphaleak mevcollector mhdempsey mikedemarais MonetSupply MoonOverlord MPtherealmvp Mudit__Gupta MustStopMurad nanexcool naniXBT networkspirits nic__carter nikokampouris nnnnicholas NomiChef NostalgiaFolder notsofast notthreadguy novogratz NTmoney officer_cia officialmcafee OlimpioCrypto OnchainDataNerd OnChainWizard PacmanBlur parabolictrav parisrouz Pentos1h pet3rpan_ peter_szilagyi pete_rizzo_ pierskicks PixOnChain poordart pplpleasr1 preston_vanloon PrimordialAA protolambda pseudotheos pumatheuma punk6529 Punk9277 rasmr_eth Rewkang rleshner RookieXBT RyanSAdams RyanWatkins_ S4mmyEth samczsun sandeepnailwal santiagoroel sassal0x satsdart saylor SBF_FTX scupytrooples seedphrase Selkis_2028 serpinxbt seyitaylor Shaughnessy119 SHL0MS SizeChad SOLBigBrain soona spencernoon sreeramkannan stablekwon StaniKulechov tarunchitra testinprodcap Tetranode thattallguy TheCryptoDog thecryptomonk TheDeFinvestor TheEylon TheFlowHorse thiccyth0t ThinkingUSD tier10k TimBeiko TimshelXYZ toghrulmaharram tomhschmidt Tradermayne trading_axe transmissions11 trent_vanepps TrustlessState Tyler_Did_It udiWertheimer ValidatorEth valkenburgh ViktorBunin VirtualElena VitalikButerin waleswoosh WarcMeinstein wassiecapital wassielawyer WatcherGuru WhalePanda WillPapper will__price worthalter yanivgraph zachxbt Zenca zhusu zooko zoomerfied _tessr
`,
  founder_ally_investors_2026: `
aaref AdamDraper adamgries adamvalkin adwane aehartz123 ai aileenlee ajhodls albertwenger aldaleudennis alemartcard alexchangsf alex_gurevich Alfred_Lin amishjani anaganath anamitra anandc andrewogawa annappatterson annimaniac anrahman anya apartovi ariellezuck arjanschutte arjunsethi arlanhamilton ashaegan ashmeetsidana AstasiaMyers atshruti avidan bandrew BarryEggers bdeeter bedy bencasnocha benyu_sierra BessemerVP Besvinick bfeld bling0 bogiebalkansky bqueener bradgillespie bradsvrluga brandonfarwell briannekimmel brianspaly buckymoore c10n CatDizonTx ceonyc chadbyers chandna chazard chetanp chrisfhoward christinetsai christine_tsai christophersaum chriswfarmer chudson chunxia clara_brenner CleanVC cmoldow cofreedman csbeirne daisydwolf damirbecirovic DanielDarling danrose999 darian314 davemorin davemuni davidbeisel davidcohen davidcowan davidsze davidu David_Mort davthack daynagrayson dchertok deborahquazzo deenashakir deepnishar devdutt ditzikow dougleone edithyeung Eisenberg eldsjal elizabeth ElizabethTurner everettrandle finoverse_ halkoss hirschb jkopelman john___forbes katrina_lake kirstynathoo magnushagsater mitchellcandrew morganbeller mrosenbloom nissimva omridrory patmatthews pejmannozad rahulvohra ryanfreedman_ sama saranormous satyap schreier spartina startupman tono_osio wallstreetpaper _changxu
`,
  ai_angels_2026: `
amasad anjneymidha auchenberg balajis bentossell ConorBronsdon danielgross grinich idlivada immad Jason jsngr justinkan karrisaarinen kiwicopple kvogt lachygroom levie loyaltyarm luketucker MrAhmadAwais natfriedman naval OfficialLoganK rauchg shl swyx Thom_Wolf tobi zeeg zenorocha zoink zperret __nikitha
`,
  awesome_tech_accounts_2026: `
1x_tech archiexzzz athleticKoder deedydas dylan522p Figure_robot goyal__pramod highyieldyt JeffDean jsuarez5341 jukan05 karpathy levelsio lithos_graphein maharshii manthanguptaa marctuinier OpenBioAI phuctm97 physical_int priyansh_31dec real_deep_ml satyaa striver_79 tbpn the_nof1 thinkymachines upen946 yuchenj_uw zephyr_z9
`,
  legacy_investor_backfill: `
1klomp 2pasc 37angelsny 4McP AaronBertinetti aaronwh aarrieta abhishekmgupta abhishekrungta Ablordesays abrams ace_company AChanMan Adam8Knight AdamDraper adamjacksonsf AdamL AdamRothenberg adharni afalk agentbillo ahoppin akarelin akbarian akselvr alexcalic AliBHamed alilling Alirezam allantear allisonbhusri Allison_Baum alokebajpai AmitMukherjee amitvedand amolsarva anandlunia anandsw anandx anand_raj andreazurek AndreBliznyuk andresbarreto andrewbusey andrewogawa andryharyanto andyhpalmer andyyangstar Angel_Atlanta anigam anrahman anthonysoohoo antonber apatzer apoapostolakis arampell arikorhonen arjunsethi arteeninLA asagakian asenkut ashfontana ashishbhatia ash_patel ataussig athorvaldsen avelan AviKarnani Avi_Fogel bandrew BarbaraCorcoran Baris BasGodska batmelon batsonjay bazaarbrett bedy benhuh Benlin0000 berdakin bertn bevanc bfeld bgarlinghouse bgoldman86 bhorowitz blackpanda95131 bling0 bmcloughlin BobBrinker BobDavisHCP boblesko boboramason bogartjosh bonanzinga Bpofcher bradharrison1 bragiel bredo BrettdeM brettrjackson brianlaungaoaeh brianp brianscohen bstroh btkutz bussgang bwats bwertz byosko byuric b_tompkins calsimmons CalWells cameronjohnson camyuill cangurorico cankut_durgun CapitalistGreen CarlaMValdes carlrydbeck carsonmehl CaseyABerman ccherndon ccoc ccschweiger cdking cebersweiler cee CEOsherpa chadnitschke chamath CharlesSmithC chengmatt chijs chrija chrisarsenault chrisfhoward ChrisHollod chrisonan christine christophermu christopherpomm chungwng cjensen25 CJHalabi cjhammontree cliffordtong cohenim cohnhead coinnetwork collinrwest conorstan cpxceo craiglauer CredoVentures crovitz CTANAngels ctaylorgreene CurtisMacDonal CustEx cyantist Dachnik daegloe danielgoldfarb danieltomov danmartell danvk davegcarlson davejohnson daveknox DaveLouisCooper davemcclure davemorin davemosk davenemetz davetisch DavidBookspan DavidCohen davejchie davidkoehn DavidSacks davidschachne davidsze davidzonabay DavWald day25 dba dcstalder dcvcjen ddebow Debbie_Levi defreezer dens devongall dfjjosh dgwhorton dharmesh dherman76 dillonmcdonald DineshAgarwal Dingman_CAN ditlev djmkerr djtokyo dmbaggett dminamid DonGooding donlayden DrSogair dspector DSZKLY dteten Dude_Br0 dundeevc dunn dwyper dzhou d_blomquist
`,
});

const AUTOMATIC_QUARANTINE = Object.freeze(new Map([
  ["alamedatrabucco", "former_or_disqualified_role_requires_manual_review"],
  ["cointelegraph", "organization_or_media_account"],
  ["degeneratenews", "organization_or_media_account"],
  ["officialmcafee", "subject_identity_not_current"],
  ["sbf_ftx", "former_or_disqualified_role_requires_manual_review"],
  ["stablekwon", "former_or_disqualified_role_requires_manual_review"],
  ["watcherguru", "organization_or_media_account"],
  ["bessemervp", "organization_or_fund_account"],
  ["cleanvc", "organization_or_fund_account"],
  ["figure_robot", "organization_account"],
  ["openbioai", "organization_account"],
  ["thinkymachines", "organization_account"],
]));

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

function sha256(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex")}`;
}

function handlesFrom(text) {
  return String(text || "").trim().split(/\s+/u).filter(Boolean);
}

function buildUniverse() {
  const byHandle = new Map();
  const sourceOrder = Object.keys(SOURCE_HANDLE_TEXT);
  for (const [sourceIndex, sourceId] of sourceOrder.entries()) {
    for (const handle of handlesFrom(SOURCE_HANDLE_TEXT[sourceId])) {
      if (!HANDLE.test(handle)) continue;
      const key = handle.toLowerCase();
      const existing = byHandle.get(key);
      if (existing) {
        if (!existing.sourceIds.includes(sourceId)) existing.sourceIds.push(sourceId);
        continue;
      }
      byHandle.set(key, {
        candidateId: `capital-kol-candidate:x:${key}`,
        handle,
        handleKey: key,
        claimedSubjectType: "person_candidate",
        identityStatus: "unverified",
        roleStatus: "unverified",
        candidateMonitoringEligible: false,
        automaticPromotion: false,
        sourcePriority: sourceIndex + 1,
        sourceIds: [sourceId],
      });
    }
  }
  return [...byHandle.values()]
    .sort((left, right) => left.sourcePriority - right.sourcePriority || left.handleKey.localeCompare(right.handleKey))
    .slice(0, CAPITAL_KOL_SCREENING_TARGET_COUNT)
    .map((candidate, index) => deepFreeze({ ...candidate, queuePosition: index + 1 }));
}

const candidateUniverse = deepFreeze(buildUniverse());
const computedUniverseHash = sha256({
  schemaVersion: CAPITAL_KOL_SCREENING_SCHEMA_VERSION,
  version: CAPITAL_KOL_SCREENING_VERSION,
  publishedAt: CAPITAL_KOL_SCREENING_PUBLISHED_AT,
  policy: CAPITAL_KOL_SCREENING_POLICY,
  candidates: candidateUniverse,
});

// Patched after reviewing the static discovery snapshot. Candidate integrity
// never grants runtime admission; it only protects the screening queue.
export const EXPECTED_CAPITAL_KOL_SCREENING_HASH = "sha256:48cd13066ea430188bf83392391a369aea59f529cf11a8a2f00821152dfa8f79";

export function verifyCapitalKolScreeningUniverseIntegrity() {
  const reasons = [];
  if (candidateUniverse.length !== CAPITAL_KOL_SCREENING_TARGET_COUNT) reasons.push("candidate_count_mismatch");
  const ids = new Set();
  const handles = new Set();
  for (const candidate of candidateUniverse) {
    if (!HANDLE.test(candidate.handle)) reasons.push(`invalid_handle:${candidate.candidateId}`);
    if (ids.has(candidate.candidateId)) reasons.push(`duplicate_id:${candidate.candidateId}`);
    if (handles.has(candidate.handleKey)) reasons.push(`duplicate_handle:${candidate.handleKey}`);
    if (candidate.candidateMonitoringEligible !== false || candidate.automaticPromotion !== false) {
      reasons.push(`unsafe_candidate_capability:${candidate.candidateId}`);
    }
    if (!candidate.sourceIds.every((sourceId) => Boolean(SOURCE_DEFINITIONS[sourceId]))) {
      reasons.push(`unknown_source:${candidate.candidateId}`);
    }
    ids.add(candidate.candidateId);
    handles.add(candidate.handleKey);
  }
  if (computedUniverseHash !== EXPECTED_CAPITAL_KOL_SCREENING_HASH) reasons.push("candidate_hash_mismatch");
  return deepFreeze({
    valid: reasons.length === 0,
    reasons,
    expectedHash: EXPECTED_CAPITAL_KOL_SCREENING_HASH,
    actualHash: computedUniverseHash,
    count: candidateUniverse.length,
  });
}

export function listCapitalKolScreeningCandidates(options = {}) {
  const offset = Math.max(0, Number.isSafeInteger(options.offset) ? options.offset : 0);
  const limit = Math.min(CAPITAL_KOL_SCREENING_TARGET_COUNT,
    Math.max(0, Number.isSafeInteger(options.limit) ? options.limit : CAPITAL_KOL_SCREENING_TARGET_COUNT));
  const sourceId = String(options.sourceId || "").trim();
  const selected = sourceId
    ? candidateUniverse.filter((candidate) => candidate.sourceIds.includes(sourceId))
    : candidateUniverse;
  return selected.slice(offset, offset + limit);
}

export function findCapitalKolScreeningCandidate(handle) {
  const key = String(handle || "").trim().replace(/^@/u, "").toLowerCase();
  if (!HANDLE.test(key)) return null;
  return candidateUniverse.find((candidate) => candidate.handleKey === key) || null;
}

function observationFor(candidate, observations) {
  if (!Array.isArray(observations)) return null;
  const matches = observations.filter((observation) => {
    const candidateId = String(observation?.candidateId || "").trim();
    if (candidateId) return candidateId === candidate.candidateId;
    const handle = String(observation?.handle || observation?.screen_name || "").trim().replace(/^@/u, "").toLowerCase();
    return handle === candidate.handleKey;
  });
  return matches.length === 1 ? matches[0] : matches.length > 1 ? { conflict: true } : null;
}

export function screenCapitalKolProfileObservation(candidate, observation, nowMs = Date.now()) {
  const quarantineReason = AUTOMATIC_QUARANTINE.get(candidate.handleKey);
  if (quarantineReason) return { disposition: "quarantined", reasons: [quarantineReason] };
  if (!observation) return { disposition: "awaiting_identity_and_role_review", reasons: ["profile_not_observed"] };
  if (observation.conflict) return { disposition: "quarantined", reasons: ["duplicate_profile_observations"] };

  const reasons = [];
  const handle = String(observation.handle || observation.screen_name || "").trim().replace(/^@/u, "");
  const xUserId = String(observation.xUserId || observation.id || "").trim();
  const observedMs = Date.parse(observation.observedAt || observation.checkedAt || "");
  const subjectType = String(observation.subjectType || "").trim();
  if (handle.toLowerCase() !== candidate.handleKey) reasons.push("profile_handle_mismatch");
  if (observation.candidateId && observation.candidateId !== candidate.candidateId) reasons.push("profile_candidate_id_mismatch");
  if (!X_USER_ID.test(xUserId)) reasons.push("numeric_x_user_id_missing_or_invalid");
  if (typeof (observation.xUserId ?? observation.id) === "number"
    && !Number.isSafeInteger(observation.xUserId ?? observation.id)) reasons.push("numeric_x_user_id_precision_lost");
  if (subjectType && subjectType !== "person") reasons.push("profile_not_a_person");
  if (observation.protected === true) reasons.push("profile_protected");
  if (observation.suspended === true || observation.deleted === true) reasons.push("profile_unavailable");
  if (!Number.isFinite(observedMs)
    || observedMs > nowMs + FUTURE_TOLERANCE_MS
    || nowMs - observedMs > OBSERVATION_MAXIMUM_AGE_MS) reasons.push("profile_observation_stale_or_invalid");
  const followers = observation.followers;
  if (followers != null && (!Number.isSafeInteger(followers) || followers < 0)) reasons.push("followers_invalid");
  if (reasons.length > 0) return { disposition: "quarantined", reasons };
  return {
    disposition: "identity_corroborated_role_review_required",
    reasons: ["official_role_and_handle_linkage_not_yet_reviewed"],
    xUserId,
    followers: followers ?? null,
  };
}

export function screenCapitalKolCandidates(options = {}) {
  const nowMs = Number.isFinite(Number(options.nowMs)) ? Number(options.nowMs) : Date.now();
  const observations = Array.isArray(options.profileObservations) ? options.profileObservations : [];
  const observationErrors = new Map((Array.isArray(options.profileObservationErrors) ? options.profileObservationErrors : [])
    .filter((error) => error && typeof error.candidateId === "string")
    .map((error) => [error.candidateId, error]));
  const handlesByUserId = new Map();
  // Include the reviewed catalog when detecting identity collisions. Discovery
  // evidence must not claim another person's pinned numeric X identity.
  for (const entry of listReviewedCapitalKols()) {
    handlesByUserId.set(String(entry.expectedXUserId), new Set([entry.handle.toLowerCase()]));
  }
  for (const observation of observations) {
    const userId = String(observation?.xUserId || observation?.id || "").trim();
    const handle = String(observation?.handle || observation?.screen_name || "").trim().replace(/^@/u, "").toLowerCase();
    if (!X_USER_ID.test(userId) || !HANDLE.test(handle)) continue;
    if (!handlesByUserId.has(userId)) handlesByUserId.set(userId, new Set());
    handlesByUserId.get(userId).add(handle);
  }
  const universeIntegrity = verifyCapitalKolScreeningUniverseIntegrity();
  const reviewedIntegrity = verifyCapitalKolCatalogIntegrity();
  if (!universeIntegrity.valid || !reviewedIntegrity.valid) {
    return deepFreeze({
      schema: "capital_kol_screening_report_v1",
      status: "blocked",
      asOf: new Date(nowMs).toISOString(),
      reasons: [...universeIntegrity.reasons, ...reviewedIntegrity.reasons],
      counts: { total: candidateUniverse.length, reviewed: 0, pending: 0, quarantined: 0 },
      results: [],
    });
  }

  const results = candidateUniverse.map((candidate) => {
    const reviewed = findReviewedCapitalKolByHandle(candidate.handle);
    if (reviewed) {
      return deepFreeze({
        candidateId: candidate.candidateId,
        handle: candidate.handle,
        queuePosition: candidate.queuePosition,
        disposition: "manual_reviewed_runtime_catalog",
        candidateMonitoringEligible: false,
        runtimeAdmissionSource: "capital-kol-catalog",
        reviewedCatalogId: reviewed.id,
        reasons: [],
      });
    }
    const screened = screenCapitalKolProfileObservation(candidate, observationFor(candidate, observations), nowMs);
    if (screened.xUserId && handlesByUserId.get(screened.xUserId)?.size > 1) {
      screened.disposition = "quarantined";
      screened.reasons = ["numeric_x_user_id_shared_by_handles"];
    }
    const observationError = observationErrors.get(candidate.candidateId);
    if (observationError) {
      // Retain prior evidence for audit, but an unresolved refresh failure
      // cannot prove the current profile is ready for the next review stage.
      if (screened.disposition !== "quarantined") screened.disposition = "awaiting_identity_and_role_review";
      screened.reasons = [...screened.reasons, "latest_profile_observation_failed"];
      screened.profileObservationFailure = {
        checkedAt: observationError.checkedAt || null,
        error: String(observationError.error || "profile_screen_failed").slice(0, 160),
      };
    }
    return deepFreeze({
      candidateId: candidate.candidateId,
      handle: candidate.handle,
      queuePosition: candidate.queuePosition,
      candidateMonitoringEligible: false,
      runtimeAdmissionSource: null,
      ...screened,
    });
  });

  const count = (disposition) => results.filter((result) => result.disposition === disposition).length;
  const reviewed = count("manual_reviewed_runtime_catalog");
  const quarantined = count("quarantined");
  const identityReady = count("identity_corroborated_role_review_required");
  const awaiting = count("awaiting_identity_and_role_review");
  return deepFreeze({
    schema: "capital_kol_screening_report_v1",
    status: "complete",
    asOf: new Date(nowMs).toISOString(),
    universe: {
      version: CAPITAL_KOL_SCREENING_VERSION,
      hash: EXPECTED_CAPITAL_KOL_SCREENING_HASH,
      count: candidateUniverse.length,
    },
    reviewedCatalog: {
      count: listReviewedCapitalKols().length,
      runtimeAdmissionIsSeparate: true,
    },
    counts: {
      total: results.length,
      reviewed,
      identityReady,
      awaiting,
      quarantined,
      rejected: 0,
    },
    progress: {
      screeningPassComplete: true,
      manualReviewComplete: reviewed === results.length,
      manualReviewRemaining: results.length - reviewed,
      reviewedPercent: Math.round(reviewed / results.length * 10_000) / 100,
      identityReadyIsNotRuntimeAdmission: true,
      profileObservationFailures: candidateUniverse.filter((candidate) => observationErrors.has(candidate.candidateId)).length,
    },
    policy: CAPITAL_KOL_SCREENING_POLICY,
    results,
  });
}

export function getCapitalKolScreeningManifest() {
  const bySource = Object.fromEntries(Object.keys(SOURCE_DEFINITIONS).map((sourceId) => [
    sourceId,
    candidateUniverse.filter((candidate) => candidate.sourceIds.includes(sourceId)).length,
  ]));
  return deepFreeze({
    schemaVersion: CAPITAL_KOL_SCREENING_SCHEMA_VERSION,
    version: CAPITAL_KOL_SCREENING_VERSION,
    publishedAt: CAPITAL_KOL_SCREENING_PUBLISHED_AT,
    hash: EXPECTED_CAPITAL_KOL_SCREENING_HASH,
    count: candidateUniverse.length,
    targetCount: CAPITAL_KOL_SCREENING_TARGET_COUNT,
    bySource,
    sources: SOURCE_DEFINITIONS,
    policy: CAPITAL_KOL_SCREENING_POLICY,
  });
}
