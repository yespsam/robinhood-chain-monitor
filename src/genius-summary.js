// Presentation only: never changes source identity, admission, or chain trust.
const object = value => value && typeof value === "object" && !Array.isArray(value);
const text = value => String(value ?? "").replace(/\s+/gu, " ").trim();
const ADDRESS = /^0x[0-9a-f]{40}$/iu;
const TECHNICAL = /(?:^|\.)(?:hash|bytecodeHash|runtimeCodeHash|codeHash|abiHash|commit|commitHash|gitCommit|gitSha|build|buildId|buildHash|builtAt|generatedAt|updatedAt|snapshot|snapshotId|snapshotHash|snapshotBlock|checksum|integrity|sha|sha256|schemaVersion|abiVersion)$/iu;

function leaves(changes) {
  const result = [];
  function visit(field, before, after, depth = 0) {
    if (result.length >= 10_000) { result.truncated = true; return; }
    if (depth < 10 && (object(before) || object(after)) && (before == null || object(before)) && (after == null || object(after))) {
      const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])].sort();
      if (!keys.length) result.push({ field, before: before ?? null, after: after ?? null });
      for (const key of keys) {
        if (JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key])) visit(`${field}.${key}`, before?.[key], after?.[key], depth + 1);
      }
    } else result.push({ field, before: before ?? null, after: after ?? null });
  }
  for (const change of Array.isArray(changes) ? changes.slice(0, 2000) : []) {
    if (typeof change?.field === "string") visit(change.field, change.before, change.after);
  }
  return result;
}

export function isGeniusTechnicalChange(change) {
  const field = String(change?.field || "");
  if (change?.before != null && typeof change.before === "object" || change?.after != null && typeof change.after === "object") return false;
  if (ADDRESS.test(text(change?.before)) || ADDRESS.test(text(change?.after))) return false;
  if (field === "document") {
    const values = [change.before, change.after].filter(value => value != null).map(text);
    return values.length > 0 && values.every(value => !/0x[0-9a-f]{40}\b/iu.test(value)
      && (/^(?:build(?:\s+(?:hash|id))?|(?:source\s+)?commit(?:\s+hash)?|snapshot(?:\s+(?:hash|id))?|(?:bytecode|runtime)\s+hash|ABI\s+version|release|stack|index\s+from\s+block)\s*[:=]?\s+(?:[a-f0-9]{7,128}|(?=[A-Za-z0-9_.:+-]*\d)[A-Za-z0-9_.:+-]{3,160})$/iu.test(value)
        || /^Raw forge output, one JSON array per contract, for ABI \d+(?:\.\d+){1,3}\. errors\.json merges every custom error; checksums\.json carries the keccak256 the manifest pins\. Names are the Pons v2 names\.$/u.test(value)));
  }
  if (/(?:^|\.)(?:abiChecksums|checksums)\.[^.]+$/iu.test(field)
    && [change.before, change.after].filter(value => value != null).every(value => /^(?:0x)?[a-f0-9]{64}$/iu.test(text(value)))) return true;
  return TECHNICAL.test(field) || /^(?:release\.)?(?:version|name)$/iu.test(field)
    || /(?:^|\.)(?:TokenFactory\.version|abi\.version)$/iu.test(field);
}

export function hasGeniusBusinessChanges(changes) {
  // Unknown fields stay observable. Silence is reserved for known metadata.
  if (!Array.isArray(changes) || changes.length > 2000 || changes.some(change => typeof change?.field !== "string")) return true;
  const flattened = leaves(changes);
  return flattened.truncated === true || flattened.some(change => !isGeniusTechnicalChange(change));
}

export function compactGeniusText(value, maximum = 195) {
  const original = text(value);
  if (original.length <= maximum) return original;
  let end = original.lastIndexOf(" ", maximum - 1);
  if (end < maximum / 2) end = maximum - 1;
  for (const match of original.matchAll(/0x[0-9a-f]{40,64}\b|https:\/\/[^\s<>]+|@[A-Za-z0-9_]{1,15}\b/giu)) {
    if (match.index < end && match.index + match[0].length > end) end = match.index;
  }
  return `${original.slice(0, end).trim()}…`;
}

const percent = value => /^\d+(?:\.\d+)?$/u.test(text(value)) ? `${Number(value) / 100}%` : null;
const scalar = value => value === null ? "∅" : typeof value === "object" ? null : text(value);
function valueChange(change, format = scalar) {
  const before = format(change.before), after = format(change.after);
  if (change.after == null) return { zh: `移除${before ? ` ${before}` : ""}`, en: `removed${before ? ` ${before}` : ""}` };
  if (change.before == null) return { zh: after || "新增", en: after || "added" };
  return { zh: `${before || "原值"} → ${after || "新值"}`, en: `${before || "previous"} → ${after || "new"}` };
}
const fact = (id, priority, zh, en, addresses = []) => ({ id, priority, zh, en, addresses: addresses.filter(value => ADDRESS.test(text(value))) });
const scope = field => field.match(/(?:^|\.)stacks\.([^.]+(?:\.\d+)?)/iu)?.[1] || null;

function describeField(change) {
  const field = change.field, last = field.split(".").at(-1), key = field.toLowerCase();
  const stack = scope(field), prefixZh = stack ? `${stack}：` : "", prefixEn = stack ? `${stack}: ` : "";
  const delta = valueChange(change);
  if (/(?:^|\.)factory(?:\.address)?$/iu.test(field) && (ADDRESS.test(text(change.after)) || ADDRESS.test(text(change.before)))) {
    return fact(field, 100, `${prefixZh}官方公布${change.before == null ? "新" : "变更"}发币工厂合约 Factory；生效待链上核实`,
      `${prefixEn}official ${change.before == null ? "new" : "changed"} Factory; activation needs chain verification`, [change.before, change.after]);
  }
  if (last === "status" && typeof change.after === "string" && /active|legacy|deprecated|inactive|disabled/iu.test(change.after)) {
    const statuses = { active: "新版启用", legacy: "旧版保留", deprecated: "弃用", inactive: "非活跃", disabled: "禁用" };
    return fact(field, 85, `${prefixZh}官方清单标记为“${statuses[change.after.toLowerCase()] || change.after}”`, `${prefixEn}manifest marks status ${change.after}`);
  }
  if (/launchEnabled$/iu.test(field) && typeof change.after === "boolean") return fact(field, 95,
    `${prefixZh}${change.after ? "允许新币发行" : "暂停新币发行"}（清单配置）`, `${prefixEn}${change.after ? "new token launches enabled" : "new token launches disabled"} in manifest`);
  if (/launchEnabledAtDeploy$/iu.test(field) && typeof change.after === "boolean") return fact(field, 60,
    `${prefixZh}部署时发币开关默认${change.after ? "开启" : "关闭"}；不是当前开关状态`,
    `${prefixEn}launching defaults to ${change.after ? "enabled" : "disabled"} at deployment; not the current switch state`);
  if (/updatesApplyTo$/iu.test(field) && change.after === "new-launches-only") return fact(field, 97,
    `${prefixZh}参数更新仅适用于之后发行的新币，不回改已发行代币`,
    `${prefixEn}parameter updates apply to new launches only, not already-created tokens`);
  if (/(?:snipe.*(?:bps|tax)|(?:start|initial).*tax.*bps)$/iu.test(field) && percent(change.after)) {
    const p = valueChange(change, percent);
    return fact(field, 84, `${prefixZh}开盘狙击税起始参数 ${p.zh}；不是实收税率`, `${prefixEn}opening anti-snipe tax parameter ${p.en}; not the effective charge`);
  }
  if (/snipe.*(?:seconds|duration|window)|secondsWindow$/iu.test(field) && /^\d+$/u.test(text(change.after))) return fact(field, 83,
    `${prefixZh}开盘狙击税时段 ${delta.zh} 秒`, `${prefixEn}opening anti-snipe window ${delta.en} seconds`);
  if (/bps$/iu.test(last) && percent(change.after)) {
    const p = valueChange(change, percent);
    const name = /max.*creator/iu.test(field) ? ["创作者税上限", "creator tax cap"]
      : /base/iu.test(field) ? ["基础费率参数", "base fee parameter"]
        : /creator/iu.test(field) ? ["创作者费率参数", "creator fee parameter"] : ["费率参数", "fee parameter"];
    return fact(field, 75, `${prefixZh}${name[0]} ${p.zh}`, `${prefixEn}${name[1]} ${p.en}`);
  }
  if (/launchFee$/iu.test(last) && /^\d+$/u.test(text(change.after))) return fact(field, 70,
    `${prefixZh}发币费用参数 ${delta.zh}（原始单位；未换算实收费用）`, `${prefixEn}launch-fee parameter ${delta.en} (raw units; not an effective-fee quote)`);
  if (/buybackEnabled$/iu.test(field) && typeof change.after === "boolean") return fact(field, 85,
    `${prefixZh}${change.after ? "启用" : "停用"}回购机制配置；不代表已执行回购`, `${prefixEn}buyback configuration ${change.after ? "enabled" : "disabled"}; no executed buyback implied`);
  if (/(?:pairToken|quoteToken|quoteAsset)/iu.test(field) && /approved|enabled$/iu.test(last) && typeof change.after === "boolean") {
    const ca = field.match(/0x[0-9a-f]{40}\b/iu)?.[0];
    return fact(field, 80, `${prefixZh}${change.after ? "允许" : "停止允许"}该资产用于发币报价`, `${prefixEn}quote asset ${change.after ? "approved" : "unapproved"} for launches`, [ca]);
  }
  if (/graduationThreshold$/iu.test(last) && /^\d+$/u.test(text(change.after))) return fact(field, 70,
    `${prefixZh}毕业所需资金参数 ${delta.zh}（原始单位）`, `${prefixEn}graduation funding parameter ${delta.en} (raw units)`);
  if (/creatorFeeRecipient|feeRecipient|controller|owner$/iu.test(last) && (ADDRESS.test(text(change.after)) || ADDRESS.test(text(change.before)))) return fact(field, 70,
    `${prefixZh}${/recipient/iu.test(last) ? "手续费接收地址" : "管理地址"}变更`, `${prefixEn}${/recipient/iu.test(last) ? "fee recipient" : "administrative address"} changed`, [change.before, change.after]);
  if (/implementation(?:\.address)?$/iu.test(field) && ADDRESS.test(text(change.after))) return fact(field, 65,
    `${prefixZh}官方公布实现合约变更；具体新增功能未确认`, `${prefixEn}implementation address changed; new functionality not established`, [change.before, change.after]);
  if (/^(?:factory|pairToken|quoteToken)$/iu.test(last) && ADDRESS.test(text(change.after))) return fact(field, 65,
    /factory/iu.test(last) ? "官方公布 Factory 变更；生效待核实" : "官方公布报价资产地址变更", /factory/iu.test(last) ? "Official Factory change; activation unverified" : "Official quote-asset address changed", [change.before, change.after]);
  // Parameter/metadata structure alone is not evidence of a feature launch.
  if (isGeniusTechnicalChange(change) || /^(?:stackId|id)$/iu.test(last)) return null;
  if (scalar(change.before) !== null && scalar(change.after) !== null) return fact(field, 10,
    `已观测配置原文 ${last}: ${delta.zh}`, `Observed configuration text ${last}: ${delta.en}`, [change.before, change.after]);
  return fact(field, 5, "官方资料结构变更；具体业务影响未确认", "Official data structure changed; business impact unconfirmed");
}

function documentFacts(event) {
  const changes = leaves(event.changes), facts = [], factory = { before: null, after: null };
  for (const change of changes) {
    if (isGeniusTechnicalChange(change)) continue;
    if (change.field !== "document") {
      const item = describeField(change); if (item) facts.push(item); continue;
    }
    const value = text(change.after || change.before), removed = change.after == null;
    if (!value) continue;
    const added = change.after != null;
    const factoryLine = value.match(/^GeniusLaunchFactory (0x[0-9a-f]{40})$/iu);
    if (factoryLine) { factory[added ? "after" : "before"] = factoryLine[1]; continue; }
    const limits = added && value.match(/^Creator tax · snipe tax Factory limits in basis points: the most a creator may charge, and the rate the launch window opens at\. Each launch freezes both; zero means it never applies (\d+) · (\d+)$/u);
    if (limits) {
      facts.push(fact("document_fee_limits", 98,
        `接入文档：创作者税上限 ${percent(limits[1])}，开盘额外买费起始参数 ${percent(limits[2])}；参数在单币发行时固定，不等同实收费`,
        `Integration docs: creator tax cap ${percent(limits[1])}; opening extra-buy-fee parameter ${percent(limits[2])}. Fixed per launch; not an effective-fee quote`));
      continue;
    }
    const detailedWindow = event.sourceId === "genius_about" && added
      && /first\s+15\s+seconds/iu.test(value) && /every buy that is not exempt pays a launch-window fee/iu.test(value)
      && /on top of the ordinary trading fee/iu.test(value) && /opens at 97% of the amount spent/iu.test(value)
      && /halves fourteen times/iu.test(value) && /Sells are never charged it/iu.test(value)
      && /nothing is charged from the end of the window/iu.test(value);
    if (detailedWindow) {
      facts.push(fact("about_launch_window", 110,
        "官网说明：新币开盘前 15 秒，非豁免买入另收费用，起始为买入金额 97%（不含普通交易费）",
        "Official docs: first 15 seconds after launch, non-exempt buys pay an extra fee starting at 97% of spend, excluding ordinary trading fees"));
      facts.push(fact("about_launch_decay", 109,
        "额外买费在窗口内减半 14 次，15 秒后归零；卖出不收这项费用",
        "The extra buy fee halves 14 times during the window, ends after 15 seconds, and never applies to sells"));
      if (/change the opening rate and the length of the window for launches created afterwards, never for a launch already created/iu.test(value)
        && /launches created before this fee took effect never carry it/iu.test(value)) facts.push(fact("about_launch_scope", 108,
          "参数调整仅影响后续新币；已发行币不追改，机制生效前的旧币不收此费",
          "Parameter updates affect future launches only; existing launches stay unchanged and tokens predating this fee never carry it"));
      continue;
    }
    // Partial or differently qualified prose remains quoted rather than being
    // elevated into an effective-fee claim with missing scope or exemptions.
    if (added && /(?:only|exclusively)[^.。]{0,45}(?:new|future)\s+(?:token|launch)|(?:new|future)\s+(?:token|launch)[^.。]{0,45}only|仅.{0,16}新(?:发|币)|只.{0,16}新发行/iu.test(value)) {
      facts.push(fact("new_launches_only", 93, "官方说明：仅适用于新发行代币；不代表旧币自动迁移", "Officially stated scope: new launches only; existing tokens are not automatically migrated"));
    }
    if (added && /(?:existing|legacy|old)\s+tokens?[^.。]{0,65}(?:unchanged|unaffected|retain\s+(?:their\s+)?(?:existing|old|previous)|remain\s+on\s+(?:their\s+)?(?:existing|old|previous)|not.{0,12}migrat)|旧(?:币|版)[^.。]{0,35}(?:原有机制|不变|不受影响|不.{0,6}迁移)/iu.test(value)) {
      facts.push(fact("legacy_tokens", 90, "官方说明旧币继续使用原有机制", "Official documentation says existing tokens retain their existing mechanism"));
    }
    facts.push({ ...fact(`document:${value}`, 30,
      `${removed ? "文档移除原文" : "文档新增原文"}：${compactGeniusText(value, 165)}`,
      `${removed ? "Removed source text" : "Added source text"}: ${compactGeniusText(value, 165)}`), rawText: value, removed });
  }
  if (factory.before || factory.after) facts.push(fact("document.factory.address", 100,
    `官方接入文档${factory.after ? (factory.before ? "替换" : "新增") : "移除"}发币工厂合约 Factory 地址；生效待链上核实`,
    `Official integration docs ${factory.after ? (factory.before ? "replace" : "add") : "remove"} the Factory address; activation needs chain verification`,
    [factory.before, factory.after]));
  return facts;
}

function chainFacts(event) {
  const { eventName: name, args = {} } = event.evidence || {};
  const p = value => percent(value) || text(value);
  const items = {
    LaunchEnabledUpdated: [`${args.enabled ? "开启" : "暂停"}新币发行`, `New token launches ${args.enabled ? "enabled" : "disabled"}`],
    LaunchFeeUpdated: [`发币费用参数改为 ${text(args.launchFee)}（原始单位）`, `Launch-fee parameter set to ${text(args.launchFee)} (raw units)`],
    MaxCreatorTaxUpdated: [`创作者税上限改为 ${p(args.bps)}`, `Creator tax cap set to ${p(args.bps)}`],
    SnipeTaxStartBpsUpdated: [`开盘狙击税起始参数改为 ${p(args.bps)}；不等同实收税率`, `Opening anti-snipe parameter set to ${p(args.bps)}; not the effective charge`],
    SnipeTaxSecondsUpdated: [`开盘狙击税时段改为 ${text(args.secondsWindow)} 秒`, `Opening anti-snipe window set to ${text(args.secondsWindow)} seconds`],
    BuybackEnabledUpdated: [`${args.enabled ? "启用" : "停用"}回购机制；不代表已执行回购`, `Buyback ${args.enabled ? "enabled" : "disabled"}; no executed buyback implied`],
    PairTokenApprovalUpdated: [`${args.approved ? "允许" : "停止允许"}该资产作为发币报价资产`, `Asset ${args.approved ? "approved" : "unapproved"} as a launch quote asset`],
    PoolGraduated: ["该币完成毕业并建立后续流动性仓位", "Token graduated and a subsequent liquidity position was created"],
    TokenLaunched: ["已核实官方关联地址创建新币；不是官方测试币认证", "Verified official-associated address launched a token; not an official test-token certification"],
    CreatorFeeRecipientUpdated: ["创作者费用改付新的接收地址", "Creator fees redirected to a new recipient"],
    CreatorFeeRecipientChangeProposed: ["提出创作者费用接收地址变更；尚未确认生效", "Creator fee recipient change proposed; activation not confirmed"],
    CreatorFeeRecipientChangeCancelled: ["取消创作者费用接收地址变更提议", "Creator fee recipient change proposal cancelled"],
    OwnershipTransferStarted: ["已提出工厂管理权转移；尚未完成接管", "Factory ownership transfer proposed; acceptance not yet confirmed"],
    OwnershipTransferred: ["工厂管理权已转交新地址", "Factory ownership transferred to a new address"],
    LaunchConfigAdded: [`新增发币配置 ${text(args.id)}；具体参数需查看原交易`, `Launch configuration ${text(args.id)} added; consult the transaction for parameters`],
    LaunchConfigUpdated: [`更新发币配置 ${text(args.id)}；不能仅据此认定新功能`, `Launch configuration ${text(args.id)} updated; a new feature is not implied`],
  };
  const pair = items[name] || ["已观测链上配置原文；具体业务影响需核实", "Observed on-chain configuration; business impact requires verification"];
  const addresses = [args.pairToken, args.previousRecipient, args.newRecipient, args.previousOwner, args.newOwner].filter(v => ADDRESS.test(text(v)));
  return [fact(name || "chain", 100, pair[0], pair[1], addresses)];
}

export function summarizeGeniusEvent(event) {
  if (event.sourceId === "genius_x") return { facts: [], hasBusinessContent: true, isRawAnnouncement: true, addresses: [] };
  const raw = event.sourceId === "genius_chain" ? chainFacts(event) : documentFacts(event);
  const feeGroups = new Map(), other = [];
  for (const item of raw) {
    if (event.sourceId !== "genius_chain" && !item.rawText && /snipe|(?:base|creator).*bps/iu.test(item.id)) {
      const key = scope(item.id) || "";
      const items = feeGroups.get(key) || []; items.push(item); feeGroups.set(key, items);
    } else other.push(item);
  }
  for (const [key, items] of feeGroups) {
    const labels = language => items.sort((a, b) => b.priority - a.priority).map(item => {
      const label = key ? item[language].replace(language === "zh" ? `${key}：` : `${key}: `, "") : item[language];
      return language === "en" ? label.replace("opening anti-snipe tax parameter", "anti-snipe parameter").replace("opening anti-snipe window", "window") : label;
    }).join(language === "zh" ? "；" : "; ");
    // Core opening-window settings take precedence over administrative status.
    // Ancillary fee splits stay in the original event, not ahead of the window.
    if (items.some(item => /snipe/iu.test(item.id))) {
      const core = items.filter(item => /snipe|base.*bps/iu.test(item.id));
      items.splice(0, items.length, ...[...new Map(core.map(item => [item.zh.replace(/^.*?：/u, ""), item])).values()]);
    }
    other.push(fact(`fees:${key}`, key ? 98 : 94,
      `${key ? `${key}：` : ""}${labels("zh")}`, `${key ? `${key}: ` : ""}${labels("en")}`));
  }
  const unique = [...new Map(other.map(item => [item.id, item])).values()].sort((a, b) => b.priority - a.priority);
  const hasBusinessContent = event.sourceId === "genius_chain" || hasGeniusBusinessChanges(event.changes);
  const facts = unique.slice(0, 3);
  return { facts, hasBusinessContent, isRawAnnouncement: false, omittedBusinessCount: Math.max(0, unique.length - facts.length),
    addresses: [...new Set(facts.flatMap(item => item.addresses))] };
}
