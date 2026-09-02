function values(value) {
  return Array.isArray(value) ? value.filter(Boolean) : value == null ? [] : [value];
}

function text(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function allGithubFacts(event, selected) {
  const facts = [selected, event?.githubChange?.primaryFact, ...values(event?.githubChange?.facts), ...values(event?.changeEvidence)]
    .filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const fact of facts) {
    const key = JSON.stringify([fact?.file, fact?.kind, fact?.subject, fact?.before, fact?.after, fact?.action]);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(fact);
  }
  return unique;
}

function normalizedScope(value) {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function fileScope(pathname) {
  const parts = text(pathname).split("/").filter(Boolean);
  for (const marker of ["clients", "examples"]) {
    const index = parts.findIndex((part) => part.toLowerCase() === marker);
    if (index >= 0 && parts[index + 1]) return normalizedScope(parts[index + 1]);
  }
  const src = parts.findIndex((part) => part.toLowerCase() === "src");
  if (src >= 0 && parts[src + 1] && !["main", "test", "tests"].includes(parts[src + 1].toLowerCase())) {
    return normalizedScope(parts[src + 1]);
  }
  return null;
}

function scopedGithubFacts(event, selected, moduleSlug) {
  const facts = allGithubFacts(event, selected);
  const selectedFile = text(selected?.file);
  const scope = normalizedScope(moduleSlug) || fileScope(selectedFile);
  if (!selectedFile || !scope || scope === "sdk") return facts.filter((fact) => fact === selected || text(fact?.file) === selectedFile);
  const scoped = facts.filter((fact) => {
    if (fact === selected || text(fact?.file) === selectedFile) return true;
    const candidate = normalizedScope(fact?.file);
    return candidate.includes(scope);
  });
  return scoped.length ? scoped : [selected].filter(Boolean);
}

function factCorpus(event, facts) {
  return [
    event?.repository,
    event?.message,
    event?.githubChange?.summary,
    ...facts.flatMap((fact) => [
      fact?.file, fact?.kind, fact?.subject, fact?.before, fact?.after, fact?.action,
    ]),
  ].map(text).filter(Boolean).join(" \n ");
}

function compactTransition(change) {
  if (!change) return "";
  const before = text(change.before);
  const after = text(change.after);
  const subject = text(change.subject || change.file || change.kind);
  if (before && after) return `${before} → ${after}`;
  if (after) return after;
  if (before) return before;
  return subject;
}

function firstMatch(source, patterns) {
  for (const pattern of patterns) {
    const match = source.match(pattern);
    if (match) return match[0];
  }
  return null;
}

function compactCallTransition(before, after) {
  const left = text(before).match(/^([A-Za-z_$][A-Za-z0-9_$.]*)\((.*)\)$/);
  const right = text(after).match(/^([A-Za-z_$][A-Za-z0-9_$.]*)\((.*)\)$/);
  if (!left || !right || left[1] !== right[1]) return null;
  const split = (source) => source.split(",").map((value) => value.trim()).filter(Boolean);
  const beforeArgs = split(left[2]);
  const afterArgs = split(right[2]);
  const added = afterArgs.filter((value) => !beforeArgs.includes(value));
  const removed = beforeArgs.filter((value) => !afterArgs.includes(value));
  if (added.length && !removed.length) return `${left[1]} +${added.join(",")}`;
  if (removed.length && !added.length) return `${left[1]} -${removed.join(",")}`;
  if (added.length || removed.length) return `${left[1]} ${left[2]}→${right[2]}`;
  return `${left[1]} signature changed`;
}

function compactChangedIdentifiers(before, after, subject = "") {
  const tokens = (value) => [...new Set((text(value).match(/[A-Za-z_$][A-Za-z0-9_$.]*/g) || [])
    .map((token) => token.split(".").at(-1))
    .filter((token) => !/^(?:this|equals|default|true|false|null|undefined)$/i.test(token)))];
  const left = tokens(before);
  const right = tokens(after);
  const removed = left.filter((token) => !right.includes(token));
  const added = right.filter((token) => !left.includes(token));
  if (!removed.length || !added.length || removed.length > 2 || added.length > 2) return null;
  const common = left.filter((token) => right.includes(token) && token.length >= 5)
    .find((token) => !/^(?:string|number|option|serde|rename)$/i.test(token));
  const anchor = common || (/\.(?:md|ts|js|java|go|rs)$/i.test(subject) ? "" : text(subject));
  const transition = `${removed.join(",")} → ${added.join(",")}`;
  return anchor && !transition.includes(anchor) ? `${anchor} ${transition}` : transition;
}

function technicalFact(event, change, corpus) {
  const before = text(change?.before);
  const after = text(change?.after);
  const subject = text(change?.subject);
  if (before && after) {
    const callTransition = change?.kind === "api_call_signature" ? compactCallTransition(before, after) : null;
    const identifierTransition = compactChangedIdentifiers(before, after, subject);
    const compactTransition = [callTransition, identifierTransition].filter(Boolean)
      .sort((left, right) => left.length - right.length)[0];
    const transition = compactTransition || (change?.kind === "api_call_signature" || before.includes(subject)
      ? `${before} → ${after}`
      : `${subject ? `${subject} ` : ""}${before} → ${after}`);
    if (transition.length <= 110) return transition;
  }
  const endpoint = firstMatch(corpus, [
    /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_{}<>.\-/]+/i,
    /\/(?:sapi|api|fapi|dapi|eapi|vapi)\/v?\d?\/?[A-Za-z0-9_{}<>.\-/]+/i,
    /\b(?:x-api|docs-api)\/[A-Za-z0-9_{}<>.\-/]+/i,
  ]);
  if (endpoint) return endpoint;
  const protectedIdentifier = firstMatch(corpus, [
    /\bneedBalanceDetail\b/,
    /\bproductType\b/,
    /\b(?:dynamicFee|quoteToken|quoteAsset|quoteAmt|msg\.value|action_ref|triggerFeeUpdate)\b/,
    /\b[A-Za-z_$][A-Za-z0-9_$]{2,}\([^\n()]{0,100}\)/,
  ]);
  if (protectedIdentifier) return protectedIdentifier;
  const transition = compactTransition(change);
  if (transition && transition.length <= 126) return transition;
  if (subject && subject.length <= 100) return subject;
  const file = text(change?.file).split("/").at(-1);
  return file && file.length <= 100 ? file : "exact diff retained in event";
}

function parsedClientVersion(value) {
  const match = text(value).match(/([A-Za-z0-9_.-]*(?:binance|connector|sdk|client)[A-Za-z0-9_.-]*)\/(v?\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.-]+)?)(?=\b|[\s(])/i);
  return match ? { product: match[1], version: match[2] } : null;
}

function isSdkVersionFact(fact) {
  const before = parsedClientVersion(fact?.before);
  const after = parsedClientVersion(fact?.after);
  return Boolean(before && after && before.product === after.product && before.version !== after.version);
}

function sdkVersionTransition(facts) {
  return facts.find(isSdkVersionFact) || null;
}

function documentationSurface(change, event) {
  const file = text(change?.file);
  if (/(?:^|\/)examples?(?:\/|$)/i.test(file)) return true;
  const docsPath = /(?:^|\/)docs?(?:\/|$)|\.(?:md|mdx|rst)$/i.test(file);
  const substantiveApiFact = ["api_call_signature", "response_schema"].includes(change?.kind)
    && (event?.binanceChange?.substantive === true || event?.githubChange?.classification === "substantive");
  return event?.githubChange?.classification === "documentation" || (docsPath && !substantiveApiFact);
}

function selectedSemanticFact(facts, selected) {
  if (!isSdkVersionFact(selected)) return selected;
  return facts.find((fact) => fact !== selected
    && fact?.kind !== "dependency_version"
    && !isSdkVersionFact(fact)
    && !documentationSurface(fact, {})) || selected;
}

function result(summary, technical, domain, maintenance = false) {
  return { summary, technical: technical || "exact diff retained in event", maintenance, domain };
}

export function interpretGithubWeb3Change(event, change, {
  language = "zh",
  module = "SDK",
  moduleSlug = null,
  version = null,
} = {}) {
  if (event?.type !== "github_module_update") return null;
  const zh = language === "zh";
  let facts = scopedGithubFacts(event, change, moduleSlug);
  if (!change && !facts.length) return null;
  change = selectedSemanticFact(facts, change);
  facts = scopedGithubFacts(event, change, moduleSlug);
  const corpus = factCorpus(event, facts);
  const lower = corpus.toLowerCase();
  const technical = technicalFact(event, change, corpus);
  const surface = [module, version].filter(Boolean).join(" ") || "SDK";

  const dependency = facts.find((fact) => fact?.kind === "dependency_version");
  const docsSurface = documentationSurface(change, event);
  const deprecated = /\bdeprecated\b|\bdeprecation\b/i.test(corpus);
  if (deprecated) {
    const identifier = firstMatch(corpus, [
      /\b(?:Cancel|Get|Create|Update|Delete|Query|List|Remove|Fulfil|Preview)[A-Za-z0-9_]{3,}\b/,
      /\b[A-Za-z_$][A-Za-z0-9_$]{2,}\([^\n()]{0,80}\)/,
    ]) || text(change?.subject) || "API";
    return result(
      zh
        ? `${surface} 接口 ${identifier} 已标记弃用；集成方需迁移`
        : `${surface} endpoint ${identifier} is deprecated; integrations must migrate`,
      `${identifier} · Deprecated`,
      "api-deprecation",
    );
  }

  if (/needbalancedetail/i.test(corpus)) return result(
    zh ? `${surface}：钱包余额查询新增明细开关；SDK 调用方需适配` : `${surface}: wallet balance queries added a detail flag; SDK callers must adapt`,
    "needBalanceDetail",
    "wallet-balance",
  );

  if (/sub.?account|sub_account/i.test(lower) && /producttype/i.test(corpus)) {
    const limitChange = /\b1000\s*(?:→|->)\s*100\b|\b1000\b[\s\S]{0,100}\b100\b/.test(corpus);
    return result(
      zh
        ? `子账户划转记录新增 productType 过滤${limitChange ? "，默认结果由 1000 缩至 100 条；分页逻辑需调整" : "；调用方需适配筛选条件"}`
        : `Sub-account transfer history added productType filtering${limitChange ? "; the default result limit fell from 1000 to 100, so pagination must adapt" : "; callers must adapt the filter"}`,
      limitChange ? `productType · 1000 → 100` : "productType",
      "account-api",
    );
  }

  if (/auto_borrow_repay/i.test(corpus)) return result(
    zh
      ? `${surface} 新增 AUTO_BORROW_REPAY 保证金下单选项；API 生效状态待官方发布确认`
      : `${surface} added the AUTO_BORROW_REPAY margin-order option; API availability awaits an official release`,
    "AUTO_BORROW_REPAY",
    "margin-order",
  );

  if (/serde\s*\(\s*rename\s*=\s*["']all["']|contracttype/i.test(lower)) return result(
    zh
      ? `${surface} 合约市场类型/查询维度调整；客户端枚举与请求参数需适配`
      : `${surface} contract-market types or query dimensions changed; client enums and parameters must adapt`,
    technical,
    "derivatives-market-data",
  );

  if (change?.kind === "api_call_signature" && /\bid\s*\(\s*id\s+string\s*\)/i.test(text(change?.before))) return result(
    zh
      ? `${surface} WebSocket 请求 ID 类型由 string 改为 int32；客户端存在兼容性变更`
      : `${surface} WebSocket request IDs changed from string to int32, creating a client compatibility change`,
    technical,
    "websocket-schema",
  );

  if (docsSurface) {
    const chainConfiguration = /chainid|deployment|deployed|network/i.test(lower);
    return result(
      chainConfiguration
        ? (zh
          ? "文档或示例中的链配置已更新；不等同于链上合约已部署"
          : "Chain settings changed in docs or examples; this does not prove an on-chain deployment")
        : (zh
          ? "文档或示例代码已更新；不代表 Web3 功能已部署或启用"
          : "Docs or example code changed; this does not prove a Web3 feature was deployed or enabled"),
      technical,
      "documentation",
    );
  }

  const apiSignature = facts.find((fact) => fact?.kind === "api_call_signature");
  const responseSchema = facts.find((fact) => fact?.kind === "response_schema");
  if (responseSchema) {
    const transition = compactTransition(responseSchema);
    return result(
      zh ? `${surface} API 响应字段调整；下游解析与类型定义需适配` : `${surface} API response fields changed; downstream parsers and types must adapt`,
      transition,
      "api-schema",
    );
  }
  if (change?.kind === "api_call_signature" || apiSignature === change) {
    return result(
      zh ? `${surface} API 调用参数发生变化；SDK 调用方需适配` : `${surface} API call parameters changed; SDK callers must adapt`,
      technical,
      "api-schema",
    );
  }

  const sdkVersion = sdkVersionTransition(facts);
  if (sdkVersion) {
    const before = parsedClientVersion(sdkVersion.before);
    const after = parsedClientVersion(sdkVersion.after);
    const versionTechnical = `${before.product} ${before.version} → ${after.version}`;
    return result(
      zh
        ? `${before.product} SDK 版本 ${before.version}→${after.version}；未确认 Web3 产品功能`
        : `${before.product} SDK version ${before.version}→${after.version}; no Web3 feature confirmed`,
      versionTechnical,
      "sdk-maintenance",
      true,
    );
  }

  if (/otc|blocktrade|block.?trade/i.test(lower)) return result(
    zh ? `${surface} 新增预测市场 OTC 大宗交易能力；覆盖订单创建、撮合或查询接口` : `${surface} added prediction-market OTC block-trade capabilities across order creation, fulfilment, or queries`,
    technical,
    "trading-api",
  );

  if (/quote.?token|quote.?asset|quoteamt|quote.?tokens/i.test(lower)) return result(
    zh ? `发币流程的报价资产选择或结算参数发生变化；交易构造方需适配` : `Launch quote-asset selection or settlement parameters changed; transaction builders must adapt`,
    technical,
    "quote-asset",
  );
  if (/\b(?:buy|sell|transfer)[_-]?tax\b|taxed|tax.?token/i.test(lower)) return result(
    zh ? `代币买卖税或税费路由发生变化；需复核税率、收款方与豁免规则` : `Token trading-tax or tax routing changed; verify rates, recipients, and exemptions`,
    technical,
    "tax",
  );
  if (/dividend|distribution|reward.?pool|claim.?reward/i.test(lower)) return result(
    zh ? `持币分红或奖励分发机制发生变化；需复核分配资产、比例与领取路径` : `Holder-dividend or reward distribution changed; verify payout asset, share, and claim path`,
    technical,
    "dividend",
  );
  if (/migrator|migration|graduate|graduation/i.test(lower)) return result(
    zh ? `代币或流动性迁移路径发生变化；需复核触发条件与目标池` : `Token or liquidity migration changed; verify its trigger and destination pool`,
    technical,
    "migrator",
  );
  if (/hook|before.?swap|after.?swap|triggerfeeupdate/i.test(lower)) return result(
    zh ? `DEX Hook 回调或费率控制逻辑发生变化；需复核 swap 执行与权限影响` : `DEX Hook callbacks or fee controls changed; verify swap execution and permissions`,
    technical,
    "hook",
  );
  if (/liquidity|createpool|poolmanager|compound|position/i.test(lower)) return result(
    zh ? `流动性池创建、头寸或复投逻辑发生变化；LP 与集成方需复核执行路径` : `Pool creation, positions, or compounding changed; LPs and integrations must verify the execution path`,
    technical,
    "liquidity",
  );
  if (/factory|launcher|launchpad|create.?token|newtoken/i.test(lower)) return result(
    zh ? `发币工厂或代币创建流程变更；链上部署待核` : `Token-factory or launch flow changed; on-chain deployment unconfirmed`,
    technical,
    "token-factory",
  );
  if (/\bfee\b|fee[_-]?(?:rate|split|recipient)|protocolfee/i.test(lower)) return result(
    zh ? `协议费率、分账或收款路径发生变化；需复核交易成本与费用归属` : `Protocol fee rate, split, or recipient changed; verify trading costs and fee ownership`,
    technical,
    "fee",
  );
  if (/chainid|deployment|deployed|network/i.test(lower)) return result(
    zh ? `链配置或部署清单发生变化；不等同于链上合约已部署` : `Chain configuration or deployment manifests changed; this does not prove an on-chain deployment`,
    technical,
    docsSurface ? "documentation" : "chain-config",
  );

  if (dependency) return result(
    zh ? `${surface} 依赖版本维护；未确认 Web3 产品功能变化` : `${surface} dependency maintenance; no Web3 product change confirmed`,
    [text(dependency.subject), compactTransition(dependency)].filter(Boolean).join(" "),
    "sdk-maintenance",
    true,
  );

  return result(
    zh ? "代码已更新；当前差异不足以可靠判断 Web3 业务影响" : "Code changed; the diff is insufficient for a reliable Web3 business impact",
    technical,
    "unknown",
  );
}

function firstPool(event) {
  return values(event?.changes?.newFlapPools)[0]
    || values(event?.changes?.flapPoolChanges)[0]?.after
    || values(event?.changes?.flapPoolChanges)[0]
    || null;
}

export function interpretPlatformPoolChange(event, language = "zh") {
  if (event?.type !== "platform_capability_update") return null;
  // Existing renderer keeps an exact old→new quote transition for mutations;
  // this interpreter only supplies the missing business purpose for additions.
  if (values(event?.changes?.flapPoolChanges).length) return null;
  const pool = firstPool(event);
  if (!pool) return null;
  const zh = language === "zh";
  const category = text(pool.category || pool.vaultFactoryCategory || pool.poolCategory || pool.poolType).toUpperCase();
  const kind = text(pool.kind).toLowerCase();
  if (kind === "quote_asset" || !category || category === "QUOTE") return zh
    ? "新增发币报价资产；可作为新币定价与结算币种"
    : "Added a launch quote asset for pricing and settling new tokens";
  const factoryName = category ? `${category} Vault Factory` : "Vault Factory";
  if (category === "DIVIDEND") return zh
    ? `新增 ${factoryName} 登记；用于配置持币奖励分配，链上启用待核`
    : `Registered a ${factoryName} for holder-reward distribution; on-chain activation remains unverified`;
  if (category === "DISTRIBUTION") return zh
    ? `新增 ${factoryName} 登记；用于代币或奖励分发，链上启用待核`
    : `Registered a ${factoryName} for token or reward distribution; on-chain activation remains unverified`;
  if (category === "INDEX") return zh
    ? `新增 ${factoryName} 登记；资产篮子规则与链上启用待核`
    : `Registered an ${factoryName}; basket rules and on-chain activation remain unverified`;
  return zh
    ? `新增 ${factoryName} 登记；具体用途与链上启用待核`
    : `Registered a ${factoryName}; its purpose and on-chain activation remain unverified`;
}

export function interpretTwitterWeb3Update(event, language = "zh") {
  if (event?.type !== "twitter_update") return null;
  const zh = language === "zh";
  // Classifier labels are routing metadata, not publishable facts. Only text
  // and structured claims from the official post may trigger a business claim.
  const corpus = [event?.tweet?.text, event?.signal?.headline, ...values(event?.signal?.claims), ...values(event?.signal?.keyChanges)]
    .map(text).filter(Boolean).join(" \n ");
  const structuredTicker = text(event?.tokenSymbol || event?.signal?.tokenSymbol || event?.signal?.quoteToken?.symbol);
  const dollarTicker = corpus.match(/\$[A-Z][A-Z0-9]{1,14}\b/)?.[0];
  const liveTicker = corpus.match(/\b([A-Z][A-Z0-9]{1,14})\s+(?:is\s+)?(?:now\s+)?live\b/)?.[1];
  const quoteTicker = structuredTicker || dollarTicker || liveTicker || null;
  const explicitQuoteLaunch = /quote token|quote.?asset|报价代币/i.test(corpus)
    && /\b(?:added|adds|supported|supports|available|live)\b|新增|支持|上线/i.test(corpus);
  if (explicitQuoteLaunch) return zh
    ? `${quoteTicker ? `${quoteTicker} ` : ""}新增为发币报价资产；可用于新币定价与结算`
    : `${quoteTicker ? `${quoteTicker} ` : ""}added as a launch quote asset for pricing and settling new tokens`;
  if (/charity donation|慈善|捐赠/i.test(corpus) && /live|上线|on-chain/i.test(corpus)) return zh
    ? "Charity Donation 已上线；可把链上活动产生的资金持续导向公益捐赠"
    : "Charity Donation is live, routing proceeds from on-chain activity into recurring charitable donations";
  if (/agentic wallet|ai agent/i.test(corpus) && /token-launch|launching a token|发币/i.test(corpus)) return zh
    ? "Agentic Wallet 新增对话式发币入口；可调用 launch skill 构造发币交易"
    : "Agentic Wallet added a conversational token-launch entry that invokes a launch skill to build the transaction";
  const taxCapability = /(?:tax token|token tax)[^.!?\n]{0,120}\b(?:evolved|upgrad(?:e|ed)|updated?|new|live|introduc(?:e|ed)|launch(?:ed)?)\b|\b(?:evolved|upgrad(?:e|ed)|updated?|new|introduc(?:e|ed)|launch(?:ed)?)\b[^.!?\n]{0,120}(?:tax token|token tax)|(?:交易税|税费型代币)[^。！？\n]{0,80}(?:新增|上线|推出|升级|更新)/i.test(corpus);
  const taxCampaign = /\b(?:arena|leaderboard|giveaway|competition|trade eligible|prize pool)\b|排行榜|交易赛|瓜分|抽奖/i.test(corpus);
  if (taxCapability && !taxCampaign) return zh
    ? "税费型代币能力更新；买卖税或税费用途需按官方参数复核"
    : "Tax-token capability updated; verify trading-tax rates and usage against official parameters";
  return null;
}

function officialEndpoints(event) {
  const corpus = [event?.title, ...values(event?.keyChanges), ...values(event?.signal?.keyChanges)].map(text).join(" \n ");
  const endpoints = [...corpus.matchAll(/\b(?:GET|POST|PUT|PATCH|DELETE)\s+`?\\?<*\/?[A-Za-z0-9_{}<>.\\\-/]+/gi)]
    .map((match) => match[0].replaceAll("\\", "").replaceAll("`", ""));
  return { corpus, endpoints: [...new Set(endpoints)] };
}

function utcMinute(value) {
  const parsed = new Date(value || "");
  if (Number.isNaN(parsed.getTime())) return "";
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function interpretBinanceInstrumentChange(details, language, category = "") {
  if (details?.kind !== "instrument_change") return null;
  const instruments = values(details.instruments)
    .map((item) => ({
      ...item,
      symbol: text(item?.symbol),
      name: text(item?.name),
      pairs: values(item?.pairs).map(text).filter(Boolean),
    }))
    .filter((item) => item.symbol);
  if (!instruments.length) return null;
  const zh = language === "zh";
  const timeField = details.action === "delist" ? "effectiveAt" : "launchAt";
  const times = instruments.map((item) => utcMinute(item[timeField])).filter(Boolean);
  const sharedTime = times.length === instruments.length && new Set(times).size === 1 ? times[0] : "";
  const displaySymbols = instruments.map((item) => {
    const label = `${item.symbol}${item.name && item.name.toUpperCase() !== item.symbol.toUpperCase()
      ? zh ? `（${item.name}）` : ` (${item.name})`
      : ""}`;
    const instant = sharedTime ? "" : utcMinute(item[timeField]);
    return `${label}${instant ? zh ? `（${instant}）` : ` (${instant})` : ""}`;
  });
  const symbolList = displaySymbols.join(zh ? "、" : ", ");
  const timeSuffix = sharedTime
    ? zh
      ? `；${details.action === "delist" ? "生效" : "上线"} ${sharedTime}`
      : `; ${details.action === "delist" ? "effective" : "launch"} ${sharedTime}`
    : "";

  if (["usd_m_perpetual", "coin_m_perpetual"].includes(details.market)) {
    const marketZh = details.market === "coin_m_perpetual" ? "币本位" : "USDⓈ-M";
    const marketEn = details.market === "coin_m_perpetual" ? "COIN-M" : "USDⓈ-M";
    const countZh = instruments.length > 1 ? `${instruments.length} 个 ` : "";
    const countEn = instruments.length > 1 ? `${instruments.length} ` : "";
    return details.action === "delist"
      ? zh
        ? `下架 ${countZh}${marketZh} 永续合约：${symbolList}${timeSuffix}`
        : `Delisting ${countEn}${marketEn} perpetual contract${instruments.length > 1 ? "s" : ""}: ${symbolList}${timeSuffix}`
      : zh
        ? `新增 ${countZh}${marketZh} 永续合约：${symbolList}${timeSuffix}`
        : `Launching ${countEn}${marketEn} perpetual contract${instruments.length > 1 ? "s" : ""}: ${symbolList}${timeSuffix}`;
  }

  if (details.market === "spot") {
    const pairs = [...new Set(instruments.flatMap((item) => item.pairs))];
    const pairSuffix = pairs.length
      ? zh ? `；交易对 ${pairs.join("、")}` : `; pairs ${pairs.join(", ")}`
      : "";
    const alphaListing = details.action === "list" && /alpha\s*上新|alpha[_\s-]*listing/iu.test(category);
    if (alphaListing) return zh
      ? `Binance Alpha 上新：${symbolList}${timeSuffix}`
      : `Binance Alpha listing: ${symbolList}${timeSuffix}`;
    return details.action === "delist"
      ? zh
        ? `现货下架${instruments.length > 1 ? ` ${instruments.length} 个资产` : ""}：${symbolList}${timeSuffix}`
        : `Spot delisting${instruments.length > 1 ? ` ${instruments.length} assets` : ""}: ${symbolList}${timeSuffix}`
      : zh
        ? `现货上币：${symbolList}${pairSuffix}${timeSuffix}`
        : `Spot listing: ${symbolList}${pairSuffix}${timeSuffix}`;
  }

  if (details.market === "spot_pair") return details.action === "delist"
    ? zh
      ? `移除现货交易对：${symbolList}${timeSuffix}`
      : `Removing spot pairs: ${symbolList}${timeSuffix}`
    : zh
      ? `新增现货交易对：${symbolList}${timeSuffix}`
      : `Adding spot pairs: ${symbolList}${timeSuffix}`;
  return null;
}

export function interpretBinanceOfficialUpdate(event, language = "zh") {
  if (event?.type !== "binance_official_update") return null;
  const zh = language === "zh";
  if (event?.kind === "announcement") {
    const title = text(event?.title || event?.article?.title || event?.signal?.headline);
    const category = text(event?.signal?.category || values(event?.signal?.labels)[0]).toLowerCase();
    const structuredInstrumentChange = interpretBinanceInstrumentChange(
      event?.announcementDetails || event?.currentSnapshot?.details,
      language,
      category,
    );
    if (structuredInstrumentChange) return structuredInstrumentChange;
    const spot = title.match(/\b(?:will\s+list|lists?|introducing)\s+(.+?)\s*\(([A-Z0-9]{2,15})\)/i);
    if (/现货上币|现货首次上币|spot[_\s-]*listing/i.test(category) || spot) {
      const name = text(spot?.[1]);
      const symbol = text(spot?.[2]) || text(title.match(/\b([A-Z0-9]{2,15})\b/)?.[1]);
      const distinctName = name && name.toUpperCase() !== symbol.toUpperCase() ? name : "";
      const assetZh = `${symbol}${distinctName ? `（${distinctName}）` : ""}` || "新资产";
      const assetEn = `${symbol}${distinctName ? ` (${distinctName})` : ""}` || "new asset";
      const seed = /seed\s+tag/i.test(title);
      return zh
        ? `现货新增 ${assetZh}${seed ? "；带 Seed Tag" : ""}`
        : `Spot lists ${assetEn}${seed ? "; Seed Tag applied" : ""}`;
    }

    const perpetual = title.match(/([\p{L}\p{N}\p{M}][\p{L}\p{N}\p{M}._-]{0,63}(?:USDT|USDC|FDUSD|TUSD|USD1|USD))/iu);
    if (/新合约上线|futures[_\s-]*contract[_\s-]*listing/i.test(category)
      || /\b(?:will\s+launch|launches?)\b.*\bperpetual\s+contract\b/i.test(title)) {
      const instrument = text(perpetual?.[1]).toUpperCase();
      const margin = /USDⓈ|USDT|USDC|FDUSD/i.test(title) ? (zh ? "U 本位" : "USDⓈ-M") : "";
      if (!instrument) return zh
        ? `新增${margin ? ` ${margin}` : ""}永续合约；标的待核`
        : `Added ${margin ? `${margin} ` : ""}perpetual contract(s); exact instruments pending verification`;
      return zh
        ? `新增 ${instrument} ${margin}永续合约`
        : `Added the ${instrument} ${margin} perpetual contract`;
    }

    const alphaAdded = title.match(/^(.+?)\s+(?:was\s+)?added\s+to\s+Binance\s+Alpha\b/i)
      || title.match(/Binance\s+Alpha\s+(?:will\s+add|adds?|launches?)\s+(.+?)(?:[.;]|$)/i);
    if (/alpha\s*上新|alpha[_\s-]*listing/i.test(category) || alphaAdded) {
      const asset = text(alphaAdded?.[1]).replace(/^Binance\s+/i, "") || "新代币";
      const orderTypes = /market\s+and\s+limit\s+orders?/i.test(title);
      return zh
        ? `Binance Alpha 新增 ${asset}${orderTypes ? "；支持市价与限价交易" : ""}`
        : `Binance Alpha added ${asset}${orderTypes ? "; market and limit orders supported" : ""}`;
    }

    if (/活动公告|campaign|competition|reward|airdrop/i.test(category)) {
      const competition = title.match(/(?:Binance\s+)?(?:Alpha\s+)?Trading\s+Competition\s*:\s*Trade\s+([A-Z0-9]{2,15})\s+to\s+Share\s+([0-9,.]+\s+[A-Z0-9]{2,15})/i);
      if (competition) return zh
        ? `Alpha 交易赛：交易 ${competition[1].toUpperCase()}，瓜分 ${competition[2].toUpperCase()}`
        : `Alpha trading competition: trade ${competition[1].toUpperCase()} to share ${competition[2].toUpperCase()}`;
      const deposit = title.match(/Deposit\s+([A-Z0-9]{2,15}).*?Share\s+([^.;]+)/i);
      if (deposit) return zh
        ? `充值活动：存入 ${deposit[1].toUpperCase()}，瓜分 ${text(deposit[2])}`
        : `Deposit campaign: deposit ${deposit[1].toUpperCase()} to share ${text(deposit[2])}`;
    }

    if (/wallet api|web3 api/i.test(category) && /\bweb3\s+api\b/i.test(title)) return zh
      ? "Binance Wallet 上线 Web3 API；开发者可接入钱包基础设施"
      : "Binance Wallet launched a Web3 API for developer access to wallet infrastructure";

    const maintenance = title.match(/(?:Notice\s+on\s+)?(.+?)\s+(?:API\s+)?Maintenance\b/i);
    if (maintenance) return zh
      ? `${text(maintenance[1])}${/api/i.test(title) ? " API" : ""} 维护公告`
      : `${text(maintenance[1])}${/api/i.test(title) ? " API" : ""} maintenance notice`;
    if (/new\s+trading\s+pairs?/i.test(title)) return zh
      ? "新增现货交易对与交易机器人服务"
      : "Added spot trading pairs and Trading Bots services";
    if (/removal\s+of\s+spot\s+trading\s+pairs?/i.test(title)) return zh
      ? "移除部分现货交易对"
      : "Removing selected spot trading pairs";
    return null;
  }
  if (event?.kind !== "developer_update") return null;
  const { corpus, endpoints } = officialEndpoints(event);
  const endpoint = endpoints[0] || null;
  if (/prediction|otc\/blocktrade|blocktrade/i.test(corpus)) {
    const paths = endpoints.map((value) => value.split(/\s+/).at(-1).toLowerCase());
    const actions = [
      paths.some((path) => /\/create\b/.test(path)) ? { zh: "创建", en: "creation" } : null,
      paths.some((path) => /\/preview\b/.test(path)) ? { zh: "预览", en: "preview" } : null,
      paths.some((path) => /\/(?:fulfil|fill)\b/.test(path)) ? { zh: "成交", en: "fulfilment" } : null,
      paths.some((path) => /\/(?:remove|cancel)\b/.test(path)) ? { zh: "撤单", en: "cancellation" } : null,
      paths.some((path) => /\/(?:list|detail|events|reserved)\b/.test(path)) ? { zh: "查询", en: "queries" } : null,
    ].filter(Boolean);
    if (actions.length === 1) return zh
      ? `Prediction OTC 大宗交易${actions[0].zh}接口更新`
      : `Prediction OTC block-trade ${actions[0].en} endpoint updated`;
    if (actions.length > 1) return zh
      ? `Prediction OTC 大宗交易 API 更新；涉及${actions.map((item) => item.zh).join("、")}`
      : `Prediction OTC block-trade APIs updated across ${actions.map((item) => item.en).join(", ")}`;
    return zh ? "Prediction OTC 大宗交易 API 更新；具体接口能力待核" : "Prediction OTC block-trade API updated; exact endpoint capabilities remain to be verified";
  }
  if (/copytrading\/futures\/leadsymbol/i.test(corpus)) return zh
    ? "新增合约带单标的白名单查询；策略可预检可带单交易对"
    : "Added a futures lead-trading symbol allowlist query so strategies can pre-check eligible pairs";
  if (/copytrading\/futures\/userstatus/i.test(corpus)) return zh
    ? "新增合约带单员状态查询；可在跟单前核验账户资格"
    : "Added a futures lead-trader status query for eligibility checks before copy trading";
  if (/kline/i.test(corpus) && /alpha/i.test(corpus)) return zh
    ? "Alpha Kline WebSocket 订阅格式调整；客户端需更新 stream 名称"
    : "Alpha Kline WebSocket subscription format changed; clients must update the stream name";
  if (endpoint) return zh
    ? `开发者 API 接口更新；集成方需核对请求参数与响应结构（${endpoint}）`
    : `Developer API endpoint updated; integrations must verify request parameters and response schema (${endpoint})`;
  return null;
}
