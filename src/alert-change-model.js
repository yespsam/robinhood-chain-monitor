const BASIS = new Set(["exact_snapshot", "official_claim", "monitoring_baseline"]);
const STATES = new Set(["known", "not_observed", "unknown"]);

const KIND_LABELS = Object.freeze({
  addition: { zh: "🟢 新增", en: "🟢 ADDED" },
  modification: { zh: "🟡 修改", en: "🟡 MODIFIED" },
  removal: { zh: "🔴 移除", en: "🔴 REMOVED" },
  publication: { zh: "🔵 首次发布", en: "🔵 FIRST PUBLISHED" },
  escalation: { zh: "🟠 指标升级", en: "🟠 ESCALATED" },
  discovery: { zh: "🔎 首次发现", en: "🔎 DISCOVERED" },
  verification: { zh: "✅ 认证", en: "✅ VERIFIED" },
});

const BASIS_LABELS = Object.freeze({
  exact_snapshot: { zh: "精确前后快照", en: "exact before/after snapshot" },
  official_claim: { zh: "官方声明", en: "official claim" },
  monitoring_baseline: { zh: "监控基线", en: "monitoring baseline" },
});

const UNKNOWN = Object.freeze({
  zh: "旧值暂不可得",
  en: "Previous value unavailable",
});

const NOT_OBSERVED = Object.freeze({
  zh: "此前监控基线未记录",
  en: "Not recorded in prior monitoring baseline",
});

function oneLine(value, maximum = 180) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const characters = [...text];
  return characters.length <= maximum ? text : `${characters.slice(0, Math.max(1, maximum - 1)).join("")}…`;
}

function structuredValueParts(value, prefix = "", output = [], depth = 0) {
  if (output.length >= 6 || value == null || depth > 3) return output;
  if (["string", "number", "boolean", "bigint"].includes(typeof value)) {
    const rendered = oneLine(value, 100);
    if (rendered) output.push(prefix ? `${prefix}=${rendered}` : rendered);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      structuredValueParts(item, prefix, output, depth + 1);
      if (output.length >= 6) break;
    }
    return output;
  }
  if (typeof value !== "object") return output;
  const priority = new Map([
    ["name", 0], ["symbol", 1], ["category", 2], ["type", 3],
    ["address", 4], ["factoryAddress", 5], ["vaultFactory", 6],
    ["quoteAddress", 7], ["quoteTokenAddress", 8], ["chainId", 9],
    ["id", 10], ["version", 11], ["stage", 12], ["url", 13],
  ]);
  const entries = Object.entries(value)
    .filter(([, item]) => item != null && item !== "")
    .sort(([left], [right]) => (priority.get(left) ?? 100) - (priority.get(right) ?? 100)
      || left.localeCompare(right, "en"));
  for (const [key, item] of entries) {
    structuredValueParts(item, prefix ? `${prefix}.${key}` : key, output, depth + 1);
    if (output.length >= 6) break;
  }
  return output;
}

function stableValue(value) {
  if (value == null) return "";
  if (["string", "number", "boolean", "bigint"].includes(typeof value)) return oneLine(value, 120);
  if (Array.isArray(value)) return value.map(stableValue).filter(Boolean).sort().join("+");
  const preferred = [
    value.symbol,
    value.name,
    value.selectorName,
    value.selector,
    value.componentMode,
    value.version,
    value.stage,
    value.address,
    value.url,
  ].filter((item) => item != null && String(item).trim());
  const structured = structuredValueParts(value);
  if (structured.length) return oneLine(structured.join(" · "), 180);
  if (preferred.length) return oneLine(preferred.map(stableValue).join(" / "), 150);
  return "结构化字段未解析";
}

function changedLeaves(before, after, prefix = "", output = []) {
  if (output.length >= 6) return output;
  const beforeObject = before && typeof before === "object" && !Array.isArray(before);
  const afterObject = after && typeof after === "object" && !Array.isArray(after);
  if (beforeObject || afterObject) {
    const keys = [...new Set([
      ...Object.keys(beforeObject ? before : {}),
      ...Object.keys(afterObject ? after : {}),
    ])].sort();
    for (const key of keys) {
      changedLeaves(beforeObject ? before[key] : undefined, afterObject ? after[key] : undefined, prefix ? `${prefix}.${key}` : key, output);
      if (output.length >= 6) break;
    }
    return output;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) output.push({ field: prefix || "value", before, after });
  return output;
}

function uniqueSorted(items) {
  return [...new Set((items || []).map((item) => item && typeof item === "object"
    ? stableValue(item)
    : oneLine(item, 180)).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "en"));
}

function side(state, items = [], text = "") {
  const normalizedState = STATES.has(state) ? state : "unknown";
  const normalizedItems = uniqueSorted(items);
  return Object.freeze({
    state: normalizedState,
    text: oneLine(text || normalizedItems.join("；"), 180),
    items: Object.freeze(normalizedItems),
  });
}

function model({ kind, basis, before, after, evidence = [], deltas = [] }) {
  const normalizedBasis = BASIS.has(basis) ? basis : "monitoring_baseline";
  return Object.freeze({
    kind: KIND_LABELS[kind] ? kind : "modification",
    confidence: normalizedBasis === "exact_snapshot" ? "exact" : normalizedBasis === "official_claim" ? "official" : "observed",
    basis: normalizedBasis,
    before: side(before?.state, before?.items, before?.text),
    after: side(after?.state || "known", after?.items, after?.text),
    evidence: Object.freeze(uniqueSorted(evidence)),
    deltas: Object.freeze(deltas.map((delta) => Object.freeze({ ...delta }))),
  });
}

function array(value) {
  return Array.isArray(value) ? value : [];
}

function objectPair(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (!("before" in value) || !("after" in value)) return null;
  return value;
}

function explicitPair(event) {
  const candidates = [
    { before: event?.before, after: event?.after },
    { before: event?.previous, after: event?.current },
    { before: event?.signal?.before, after: event?.signal?.after },
    objectPair(event?.change),
    objectPair(event?.changes),
  ].filter(Boolean);
  return candidates.find((candidate) => candidate.before != null && candidate.after != null) || null;
}

function namedValue(label, value) {
  const rendered = stableValue(value);
  return rendered ? `${label}: ${rendered}` : "";
}

function platformChangeModel(event) {
  const changes = event.changes || {};
  const before = [];
  const after = [];
  const add = [];
  const remove = [];
  const paired = [];

  const pairs = [
    ...array(changes.quoteConfigChanges).map((item) => ({ label: `报价配置 ${item.symbol || item.after?.symbol || "?"}`, ...item })),
    ...array(changes.flapPoolChanges).map((item) => ({ label: `底池 ${item.identity || item.after?.symbol || item.after?.name || "?"}`, ...item })),
    ...array(changes.chainStageChanges).map((item) => {
      const chainId = item.after?.chainId ?? item.before?.chainId ?? item.chainId;
      const environment = item.after?.environment || item.before?.environment;
      return {
        label: `网络 ${item.name || item.after?.name || chainId || "?"}${environment ? ` ${environment}` : ""}${chainId != null ? ` (Chain ID ${chainId})` : ""}`,
        before: item.before?.stage ?? item.fromStage,
        after: item.after?.stage ?? item.toStage,
      };
    }),
    ...array(changes.packageVersionChanges).map((item) => ({ label: `软件包 ${item.name || "?"}`, before: item.before?.version ?? item.fromVersion, after: item.after?.version ?? item.toVersion })),
  ];
  for (const item of pairs) {
    const leaves = changedLeaves(item.before, item.after);
    if (leaves.length && (typeof item.before === "object" || typeof item.after === "object")) {
      for (const leaf of leaves) {
        before.push(`${item.label}.${leaf.field}: ${stableValue(leaf.before) || "未设置"}`);
        after.push(`${item.label}.${leaf.field}: ${stableValue(leaf.after) || "已移除"}`);
      }
    } else {
      const oldValue = stableValue(item.before);
      const newValue = stableValue(item.after);
      if (oldValue) before.push(`${item.label}: ${oldValue}`);
      if (newValue) after.push(`${item.label}: ${newValue}`);
    }
    paired.push(item.label);
  }

  const definitions = [
    ["newModules", "模块", "removedModules"],
    ["newQuoteTokens", "报价资产", "removedQuoteTokens"],
    ["newQuoteConfigs", "报价配置", "removedQuoteConfigs"],
    ["newFlapPools", "底池", "removedFlapPools"],
    ["newChains", "网络", "removedChains"],
    ["newPackages", "软件包", "removedPackages"],
    ["newVersions", "版本", "removedVersions"],
    ["newContracts", "合约", "removedContracts"],
    ["newPages", "页面", "removedPages"],
    ["newAnnouncements", "公告", "removedAnnouncements"],
    ["newCampaigns", "活动", "removedCampaigns"],
  ];
  const updatedPages = new Set(array(changes.updatedPages).map(String));
  for (const [addedKey, label, removedKey] of definitions) {
    for (const value of array(changes[addedKey])) {
      if (addedKey === "newPages" && updatedPages.has(String(value))) continue;
      add.push(namedValue(label, value));
    }
    for (const value of array(changes[removedKey])) remove.push(namedValue(label, value));
  }
  for (const page of updatedPages) {
    before.push(`页面: ${stableValue(page)}（旧内容）`);
    after.push(`页面: ${stableValue(page)}（已更新）`);
    paired.push(page);
  }
  before.push(...remove);
  after.push(...add, ...remove.map((item) => `${item}（已移除）`));
  const hasPaired = paired.length > 0;
  const kind = hasPaired || (add.length && remove.length) ? "modification" : remove.length ? "removal" : "addition";
  return model({
    kind,
    basis: "exact_snapshot",
    before: before.length ? { state: "known", items: before } : { state: add.length ? "not_observed" : "unknown" },
    after: { state: "known", items: after.length ? after : ["检测到能力快照变化，字段尚未解析"] },
    evidence: [event.source, ...array(event.sources), event.platform?.name].filter(Boolean),
  });
}

function morphPortalModel(event) {
  const mode = event.mode || {};
  const oldItems = [namedValue("Implementation", mode.previousImplementation), namedValue("Version", mode.previousVersion)].filter(Boolean);
  const newItems = [namedValue("Implementation", mode.implementation), namedValue("Version", mode.version)].filter(Boolean);
  return model({
    kind: "modification",
    basis: "exact_snapshot",
    before: oldItems.length ? { state: "known", items: oldItems } : { state: "unknown" },
    after: { state: "known", items: newItems.length ? newItems : ["Portal implementation 已变化"] },
    evidence: [event.launcher, event.transactionHash, event.blockNumber && `block ${event.blockNumber}`].filter(Boolean),
  });
}

function githubUpdateModel(event) {
  const before = [];
  const after = [];
  const deltas = [];
  let hasAddition = false;
  let hasRemoval = false;
  let hasModification = false;
  const supportedKinds = new Set([
    "config_value", "dependency_version", "api_call_signature", "response_schema",
    "contract", "interface", "class", "function", "list_item", "code_assignment",
    "code_line", "documentation_item", "file_change",
  ]);
  const githubChangeBasis = String(event?.githubChange?.basis || "").toLowerCase();
  const metadataOnlyGithubChange = event?.githubChange?.completeness === "metadata_only"
    || githubChangeBasis.includes("metadata");
  const deltaBasisFor = (change) => {
    const confidence = String(change?.confidence || "").toLowerCase();
    const declaredBasis = String(change?.basis || "").toLowerCase();
    return metadataOnlyGithubChange || confidence.includes("metadata") || declaredBasis.includes("metadata")
      ? "metadata_only"
      : "exact_patch";
  };
  const categoryFor = (change) => {
    if (change.kind === "dependency_version") return "dependency";
    if (change.kind === "documentation_item") return "docs";
    if (["config_value", "list_item", "code_assignment"].includes(change.kind)) return "config";
    if (change.kind === "file_change") {
      const filename = String(change.file || change.filename || "");
      if (/(?:^|\/)(?:docs?|README|CHANGELOG)(?:\/|\.|$)|\.(?:md|mdx|rst)$/i.test(filename)) return "docs";
      if (/(?:^|\/)(?:package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|go\.mod|go\.sum|Cargo\.(?:toml|lock)|pyproject\.toml|requirements[^/]*\.txt)$/i.test(filename)) return "dependency";
      if (/(?:^|\/)(?:config|configs?)(?:\/|\.)|\.(?:json|ya?ml|toml|ini|env)$/i.test(filename)) return "config";
    }
    return "code";
  };
  const changeCandidates = [event?.githubChange?.primaryFact, ...array(event?.githubChange?.facts), ...array(event.changeEvidence)]
    .filter((change, index, values) => change && values.findIndex((candidate) => JSON.stringify([
      candidate?.kind, candidate?.file, candidate?.filename, candidate?.subject,
      candidate?.before, candidate?.after, candidate?.action,
    ]) === JSON.stringify([
      change.kind, change.file, change.filename, change.subject,
      change.before, change.after, change.action,
    ])) === index)
    .map((change) => ({
      ...change,
      kind: change.kind || (change.subject || change.before != null || change.after != null ? "config_value" : "file_change"),
    }));
  for (const change of changeCandidates) {
    if (!change || !supportedKinds.has(change.kind)) continue;
    const label = [change.file, change.subject].filter(Boolean).join(" · ") || "代码项";
    const declarationAdded = ["contract", "interface", "class", "function"].includes(change.kind);
    const action = change.action === "removed" || (change.before != null && change.after == null && !declarationAdded)
      ? "removed"
      : change.action === "added" || (change.before == null && (change.after != null || declarationAdded))
        ? "added"
        : "modified";
    deltas.push({
      category: categoryFor(change),
      action,
      kind: change.kind,
      file: change.file || change.filename || null,
      subject: change.subject || null,
      before: change.before ?? null,
      after: change.after ?? null,
      basis: deltaBasisFor(change),
    });
    if (change.before != null) before.push(namedValue(label, change.before));
    if (action === "removed") {
      hasRemoval = true;
      after.push(`${label}（已移除）`);
    } else if (change.after != null) {
      after.push(namedValue(label, change.after));
      if (action === "added") hasAddition = true;
      else hasModification = true;
    } else if (action === "added" || declarationAdded) {
      hasAddition = true;
      after.push(`${label}（新增 ${change.kind || "声明"}）`);
    }
  }
  for (const file of array(event.files)) {
    const name = stableValue(file.filename || file.name);
    if (!name) continue;
    const fileAction = file.status === "added" ? "added" : file.status === "removed" ? "removed" : "modified";
    if (!deltas.some((delta) => delta.file === name)) {
      deltas.push({
        category: categoryFor({ kind: "file_change", file: name }),
        action: fileAction,
        kind: "file_change",
        file: name,
        subject: name,
        before: null,
        after: null,
        basis: "file_metadata",
        additions: Number.isFinite(Number(file.additions)) ? Number(file.additions) : null,
        deletions: Number.isFinite(Number(file.deletions)) ? Number(file.deletions) : null,
      });
    }
    if (file.status === "added") {
      hasAddition = true;
      after.push(`文件: ${name}（新增）`);
    } else if (file.status === "removed") {
      hasRemoval = true;
      before.push(`文件: ${name}`);
      after.push(`文件: ${name}（已移除）`);
    } else {
      hasModification = true;
      before.push(`文件: ${name}（修改前）`);
      const additions = Number(file.additions);
      const deletions = Number(file.deletions);
      const hasUsefulStats = event.diffStatsAvailable !== false
        && Number.isFinite(additions) && Number.isFinite(deletions)
        && (additions > 0 || deletions > 0);
      after.push(`文件: ${name}（已修改${hasUsefulStats ? ` +${additions} -${deletions}` : ""}）`);
    }
  }
  for (const address of array(event.newContracts)) {
    hasAddition = true;
    after.push(`合约: ${address}（新增）`);
  }
  if (event.contract) after.push(`合约: ${event.contract}`);
  const kind = hasModification || (hasAddition && hasRemoval) ? "modification" : hasRemoval ? "removal" : "addition";
  const hasStructuredDelta = deltas.some((delta) => delta.basis === "exact_patch");
  const representative = deltas[0];
  const fallback = representative?.file
    ? `文件: ${representative.file}（${representative.action === "added" ? "已新增；精确内容未解析" : representative.action === "removed" ? "已删除；精确内容未解析" : "已修改；精确差异未解析"}）`
    : "GitHub 提交已记录；精确差异未解析";
  return model({
    kind,
    basis: hasStructuredDelta ? "exact_snapshot" : "monitoring_baseline",
    before: before.length ? { state: "known", items: before } : { state: hasAddition ? "not_observed" : "unknown" },
    after: { state: "known", items: hasStructuredDelta && after.length ? after : [fallback] },
    evidence: [event.repository, event.commit && `commit ${event.commit}`, event.pullRequest?.number && `PR #${event.pullRequest.number}`].filter(Boolean),
    deltas,
  });
}

function githubGapModel(event) {
  const gap = event.gap || {};
  return model({
    kind: "modification",
    basis: "exact_snapshot",
    before: gap.previousSha ? { state: "known", items: [`监控游标: ${gap.previousSha}`] } : { state: "unknown" },
    after: { state: "known", items: [`最新提交: ${gap.newestSha || "未知"}`, `覆盖状态: ${gap.status || "gap_unresolved"}`] },
    evidence: [event.repository, gap.fetchedCommits != null && `已拉取 ${gap.fetchedCommits} 条`].filter(Boolean),
  });
}

function repositoryModel(event) {
  const repository = event.repository || "仓库名称未取得";
  if (event.type === "github_repository_verified") {
    return model({
      kind: "verification",
      basis: "official_claim",
      before: { state: "known", items: [`${repository}: 官方归属未确认`] },
      after: { state: "known", items: [`${repository}: 官方归属已确认`] },
      evidence: [event.evidence?.source, event.evidence?.url, event.url].filter(Boolean),
    });
  }
  const official = event.sourceTrust === "official_verified";
  return model({
    kind: "discovery",
    basis: official ? "official_claim" : "monitoring_baseline",
    before: { state: "not_observed" },
    after: { state: "known", items: [`仓库: ${repository}`, event.repositoryMetadata?.description || event.description].filter(Boolean) },
    evidence: [official ? "官方组织/官方来源" : "仓库候选发现", event.url].filter(Boolean),
  });
}

function telegramNewsUsername(event) {
  const candidates = [
    event?.channel?.username,
    event?.username,
    event?.source?.username,
    event?.source?.handle,
  ];
  try {
    const url = new URL(String(event?.messageUrl || ""));
    if (["t.me", "www.t.me", "telegram.me", "www.telegram.me"].includes(url.hostname.toLowerCase())) {
      const parts = url.pathname.split("/").filter(Boolean);
      candidates.push(parts[0] === "s" ? parts[1] : parts[0]);
    }
  } catch {
    // A malformed URL is not source evidence. The configured channel identity
    // below remains an observation label, never an authenticity claim.
  }
  for (const candidate of candidates) {
    const username = String(candidate || "").replace(/^@/, "").trim();
    if (/^[A-Za-z0-9_]{1,32}$/.test(username)) return username;
  }
  return "maxguruai";
}

function telegramNewsMessageId(event) {
  const candidates = [event?.messageId, event?.telegram?.messageId, event?.source?.messageId];
  try {
    const url = new URL(String(event?.messageUrl || ""));
    candidates.push(url.pathname.split("/").filter(Boolean).at(-1));
  } catch {
    // Ignore malformed URLs; an absent ID is rendered honestly as unavailable.
  }
  const id = candidates.map((value) => String(value ?? "").trim()).find((value) => /^\d+$/.test(value));
  return id || "unknown";
}

function telegramNewsSourceMarker(event) {
  return `@${telegramNewsUsername(event)}#${telegramNewsMessageId(event)}`;
}

function telegramNewsModel(event) {
  const category = oneLine(event?.news?.category, 42) || "未分类";
  const summary = oneLine(event?.news?.summary || event?.news?.headline, 118) || "摘要未取得";
  return model({
    kind: "publication",
    basis: "monitoring_baseline",
    before: { state: "not_observed" },
    after: { state: "known", items: [`分类 ${category}: ${summary}`] },
    evidence: [telegramNewsSourceMarker(event)],
  });
}

function twitterModel(event) {
  const claimPairs = [...array(event.signal?.keyChanges), ...array(event.signal?.claims), ...array(event.keyChanges)]
    .filter((value) => objectPair(value));
  const pair = explicitPair(event);
  const pairs = pair ? [pair] : claimPairs;
  if (pairs.length) {
    const before = pairs.map((item) => item.subject || item.field ? namedValue(item.subject || item.field, item.before) : stableValue(item.before)).filter(Boolean);
    const after = pairs.map((item) => item.subject || item.field ? namedValue(item.subject || item.field, item.after) : stableValue(item.after)).filter(Boolean);
    return model({
      kind: "modification",
      basis: "official_claim",
      before: { state: "known", items: before },
      after: { state: "known", items: after },
      evidence: [event.tweet?.url, event.tweet?.id && `X post ${event.tweet.id}`, event.project?.name].filter(Boolean),
    });
  }
  return model({
    kind: "publication",
    basis: "official_claim",
    before: { state: "not_observed" },
    after: { state: "known", items: [event.headline, ...array(event.keyChanges), event.tweet?.text].filter(Boolean) },
    evidence: [event.tweet?.url, event.tweet?.id && `X post ${event.tweet.id}`, event.tweet?.handle && `@${event.tweet.handle}`].filter(Boolean),
  });
}

function modeText(value) {
  if (!value) return "";
  const modes = array(value).length ? value : [value];
  return modes.map((item) => [item.selectorName || item.selector, item.componentMode, array(item.poolKinds).join("+")].filter(Boolean).join(" / "))
    .filter(Boolean).sort().join("；");
}

function tokenModeModel(event) {
  const difference = event.modeDifference || {};
  const previous = modeText(difference.previous);
  const current = modeText(difference.current || event.mode);
  return model({
    kind: "modification",
    basis: "exact_snapshot",
    before: previous ? { state: "known", items: [previous] } : { state: "unknown" },
    after: { state: "known", items: [current || "新模式结构已确认"] },
    evidence: [event.launcher, event.transactionHash, event.tokens?.[0]?.token].filter(Boolean),
  });
}

function volumeModel(event) {
  const entry = event.entry || {};
  const symbol = entry.quoteSymbol || "quote";
  const previous = event.previousVolumeInMinute;
  const current = event.volumeInMinute;
  return model({
    kind: "escalation",
    basis: "exact_snapshot",
    before: previous != null ? { state: "known", items: [`1分钟量: ${previous} ${symbol}`] } : { state: "unknown" },
    after: { state: "known", items: [current != null ? `1分钟量: ${current} ${symbol}` : "当前量能已触发门槛", `级别: L${event.stage ?? "?"}`, event.volumeAcceleration != null && `加速: ${event.volumeAcceleration}x`].filter(Boolean) },
    evidence: [entry.token, event.stageCriteria && `门槛 ${stableValue(event.stageCriteria)}`].filter(Boolean),
  });
}

function metadataEnrichmentModel(event) {
  const additions = event.additions && typeof event.additions === "object" ? event.additions : {};
  const fields = Object.keys(additions).sort();
  const before = fields.map((field) => `${field}: 未设置`);
  const after = fields.map((field) => namedValue(field, additions[field])).filter(Boolean);
  return model({
    kind: "addition",
    basis: "exact_snapshot",
    before: before.length ? { state: "known", items: before } : { state: "unknown" },
    after: { state: "known", items: after.length ? after : ["项目资料已补全，字段值暂未解析"] },
    evidence: [event.entry?.token, event.entry?.launchpad?.name, event.observedAt].filter(Boolean),
  });
}

function officialActivityModel(event) {
  const activityLabels = {
    buy: "本次买入",
    sell: "本次卖出",
    burn: "本次销毁",
  };
  const tokenLabel = event.tokenMetadata?.symbol || event.tokenMetadata?.name || event.token;
  const amount = event.amount != null
    ? `${event.amount}${tokenLabel ? ` ${tokenLabel}` : ""}`
    : tokenLabel || "数量暂未解析";
  return model({
    kind: event.activity === "buy" ? "addition" : "removal",
    basis: "monitoring_baseline",
    before: { state: "unknown" },
    after: {
      state: "known",
      items: [
        `${activityLabels[event.activity] || "本次链上行为"}: ${amount}`,
        event.actor && `官方地址: ${event.actor}`,
        event.token && `CA ${event.token}`,
      ].filter(Boolean),
    },
    evidence: [event.transactionHash, event.blockNumber != null && `block ${event.blockNumber}`, event.tradeVerified === true && "swap receipt verified"].filter(Boolean),
  });
}

function fomoModel(event) {
  if (event.signalKind === "high_profit_high_winrate_wallet_buy") {
    const stats = event.walletProfile?.windows?.["30d"] || {};
    const profit = Number(stats.realizedProfitUsd);
    const winRate = Number(stats.winRate);
    const tokenCount = Number(stats.tokenCount);
    const symbol = event.tokenSymbol || event.symbol || "代币";
    const proofBoundary = event.positionSemantics?.proofBoundary || event.positionProof?.phase;
    const zeroPositionLabel = proofBoundary === "previous_block"
      ? "前一区块仓位: 0"
      : proofBoundary === "immediately_before_transaction" ? "交易前仓位: 0" : "零仓位证明: 已核验";
    return model({
      kind: "addition",
      basis: "exact_snapshot",
      before: { state: "known", items: [zeroPositionLabel] },
      after: {
        state: "known",
        items: [
          `高收益高胜率钱包买入 ${symbol}`,
          Number.isFinite(profit) && Number.isFinite(winRate) && Number.isFinite(tokenCount)
            ? `30D 已实现盈利 $${profit} · 胜率 ${(winRate * 100).toFixed(1)}% · ${tokenCount}币样本`
            : null,
          event.token && `CA ${event.token}`,
        ].filter(Boolean),
      },
      evidence: [event.transactionHash, event.walletAddress, event.source?.id].filter(Boolean),
    });
  }
  if (event.signalKind === "fomo_x_call") {
    const handle = event.caller?.handle || event.handle || event.tweet?.handle || "?";
    const postId = event.tweet?.id || event.callId || event.stableId;
    return model({
      kind: "publication",
      // The post belongs to the linked KOL, not to Fomo itself. Keep the
      // audit basis observational so it can never be read as a Fomo claim.
      basis: "monitoring_baseline",
      before: { state: "not_observed" },
      after: {
        state: "known",
        items: [
          `@${handle} X 喊单: ${event.thesis?.text || event.body || event.tweet?.text || "公开 X 原帖"}`,
          event.token && `CA ${event.token}`,
        ].filter(Boolean),
      },
      evidence: [event.source?.id, postId && `X post ${postId}`, event.tweet?.url].filter(Boolean),
    });
  }
  if (event.signalKind === "fomo_published_call") {
    return model({
      kind: "publication",
      basis: "official_claim",
      before: { state: "not_observed" },
      after: { state: "known", items: [`@${event.caller?.handle || event.handle || "?"}: ${event.thesis?.text || event.body || "发布新喊单"}`, event.token && `CA ${event.token}`].filter(Boolean) },
      evidence: [event.source?.id, event.source?.trust, event.callId].filter(Boolean),
    });
  }
  const proof = event.positionProof || {};
  const exactZero = proof.status === "verified" && (proof.totalWalletPreRaw === "0" || proof.previousBalanceRaw === "0");
  return model({
    kind: event.signalKind === "top_blogger_convergence" ? "escalation" : "addition",
    basis: exactZero ? "exact_snapshot" : "monitoring_baseline",
    before: exactZero ? { state: "known", items: [proof.phase === "immediately_before_transaction" ? "交易前仓位: 0" : "前一区块仓位: 0"] } : { state: "unknown" },
    after: { state: "known", items: [event.signalKind === "top_blogger_convergence" ? `${event.buyerCount || array(event.callers).length} 位 KOL 共振` : `@${event.caller?.handle || "?"} 首仓买入`, event.amountUsd != null && `金额: $${event.amountUsd}`, event.token && `CA ${event.token}`].filter(Boolean) },
    evidence: [event.transactionHash, proof.status && `position proof: ${proof.status}`, event.source?.id].filter(Boolean),
  });
}

function siteModel(event) {
  const additions = event.signalDelta?.added || {};
  const changes = [
    ...array(event.newChains).map((item) => namedValue("网络", item)),
    ...array(event.newSocials).map((item) => namedValue("官方外链", item)),
    ...array(event.newContracts).map((item) => namedValue("合约", item)),
    ...array(event.newFeatures).map((item) => namedValue("功能", item)),
    ...array(event.newPages).map((item) => namedValue("页面", item)),
    ...array(event.newKeywords).map((item) => namedValue("关键词", item)),
    ...array(event.newAssets).map((item) => namedValue("前端资源", item)),
    ...Object.entries(additions).flatMap(([field, values]) => array(values).map((item) => namedValue(field, item))),
  ].filter(Boolean);
  return model({
    kind: "addition",
    basis: "monitoring_baseline",
    before: { state: "not_observed" },
    after: { state: "known", items: changes.length ? changes : ["官网内容发生变化，具体字段尚未解析"] },
    evidence: [event.url, event.launchpad?.name].filter(Boolean),
  });
}

function fourMemeTemplateModel(event) {
  const previous = event.previousTemplate;
  const current = event.currentTemplate || event.mode?.template;
  const fields = array(event.changedFields);
  const before = [];
  const after = [];
  for (const field of fields) {
    if (field === "template" && !previous) continue;
    before.push(namedValue(field, previous?.[field]));
    after.push(namedValue(field, current?.[field]));
  }
  if (!after.length && current) after.push(namedValue("模板", current));
  return model({
    kind: previous ? "modification" : "addition",
    basis: previous ? "exact_snapshot" : "monitoring_baseline",
    before: previous ? { state: "known", items: before.filter(Boolean) } : { state: "not_observed" },
    after: { state: "known", items: after.filter(Boolean) },
    evidence: [event.sourceUrl, event.mode?.sourceUrl, event.launcher].filter(Boolean),
  });
}

function explicitSnapshotModel(event) {
  const previous = event.previousSnapshot;
  const current = event.currentSnapshot;
  const fields = array(event.changedFields);
  const before = [];
  const after = [];
  for (const field of fields) {
    if (previous && Object.hasOwn(previous, field)) before.push(namedValue(field, previous[field]));
    if (current && Object.hasOwn(current, field)) after.push(namedValue(field, current[field]));
  }
  if (!after.length && current) after.push(...Object.entries(current).map(([field, value]) => namedValue(field, value)).filter(Boolean));
  const hasPrevious = previous && typeof previous === "object";
  return model({
    kind: hasPrevious ? "modification" : "publication",
    basis: hasPrevious ? "exact_snapshot" : event.comparisonBasis || "monitoring_baseline",
    before: hasPrevious ? { state: "known", items: before } : event.baselineStatus === "not_recorded" ? { state: "not_observed" } : { state: "unknown" },
    after: { state: "known", items: after },
    evidence: [event.url, event.source?.url, event.source?.name].filter(Boolean),
  });
}

function ponFunUpdateModel(event) {
  const pairs = Object.entries(event?.changes || {})
    .filter(([, value]) => objectPair(value))
    .map(([field, value]) => ({ field, before: value.before, after: value.after }));
  const before = pairs
    .filter((item) => item.before != null)
    .map((item) => namedValue(item.field, item.before))
    .filter(Boolean);
  const after = pairs
    .filter((item) => item.after != null)
    .map((item) => namedValue(item.field, item.after))
    .filter(Boolean);
  if (!after.length && event.currentSnapshot) {
    after.push(...Object.entries(event.currentSnapshot)
      .map(([field, value]) => namedValue(field, value))
      .filter(Boolean));
  }
  const addition = ["market_created", "stock_listing"].includes(event.kind)
    && !pairs.some((item) => item.before != null);
  return model({
    kind: addition ? "addition" : "modification",
    basis: "exact_snapshot",
    before: before.length ? { state: "known", items: before } : { state: "not_observed" },
    after: { state: "known", items: after.length ? after : [event.title || "pon.fun 更新已确认"] },
    evidence: [
      event.transactionHash && `${event.transactionHash}${event.blockNumber != null ? `#${event.blockNumber}` : ""}`,
      event.factory && `Factory ${event.factory}`,
      event.source?.url,
    ].filter(Boolean),
    deltas: pairs.map((item) => ({
      category: ["factory_config", "curve_params"].includes(event.kind) ? "config" : "state",
      action: item.before == null ? "added" : item.after == null ? "removed" : "modified",
      kind: "config_value",
      file: null,
      subject: item.field,
      before: item.before ?? null,
      after: item.after ?? null,
      basis: "exact_snapshot",
    })),
  });
}

function developerUpdateModel(event) {
  const added = array(event.addedSignals).map((value) => oneLine(value, 180)).filter(Boolean);
  const removed = array(event.removedSignals).map((value) => oneLine(value, 180)).filter(Boolean);
  const keyChanges = array(event.keyChanges).map((value) => oneLine(value, 180)).filter(Boolean);
  const additions = added.length
    ? added
    : keyChanges.filter((value) => !/^\s*Removed\s*:/iu.test(value));
  const removals = removed.length
    ? removed
    : keyChanges.filter((value) => /^\s*Removed\s*:/iu.test(value))
      .map((value) => value.replace(/^\s*Removed\s*:\s*/iu, ""));
  const after = [
    ...additions,
    ...removals.map((value) => `${value}（已移除）`),
  ].filter((value) => !/signalDigest/iu.test(value));
  return model({
    kind: additions.length && removals.length ? "modification" : removals.length ? "removal" : "addition",
    basis: event.comparisonBasis || "exact_snapshot",
    before: removals.length
      ? { state: "known", items: removals }
      : { state: "not_observed" },
    after: {
      state: "known",
      items: after.length ? after : ["Developer 文档内容已变更，具体条目待解析"],
    },
    evidence: [event.url, event.source?.url, event.source?.name].filter(Boolean),
  });
}

function collectionDeltaModel(event) {
  const changes = event.changes && typeof event.changes === "object" && !Array.isArray(event.changes)
    ? event.changes
    : {};
  const additions = [];
  const removals = [];
  for (const [field, values] of Object.entries(changes).sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (!Array.isArray(values)) continue;
    if (/^(?:new|added)/i.test(field)) {
      additions.push(...values.map((value) => namedValue(field, value)).filter(Boolean));
    } else if (/^(?:removed|deleted)/i.test(field)) {
      removals.push(...values.map((value) => namedValue(field, value)).filter(Boolean));
    }
  }
  if (!additions.length && !removals.length) return null;
  return model({
    kind: additions.length && removals.length ? "modification" : removals.length ? "removal" : "addition",
    basis: event.comparisonBasis || "exact_snapshot",
    before: removals.length
      ? { state: "known", items: removals }
      : { state: "not_observed" },
    after: {
      state: "known",
      items: [
        ...additions,
        ...removals.map((item) => `${item}（已移除）`),
      ],
    },
    evidence: [event.url, event.source?.url, event.source?.name, event.project?.name].filter(Boolean),
  });
}

function genericPublishedModel(event) {
  const pair = explicitPair(event);
  if (pair) {
    return model({
      kind: "modification",
      basis: "exact_snapshot",
      before: { state: "known", items: [stableValue(pair.before)] },
      after: { state: "known", items: [stableValue(pair.after)] },
      evidence: [event.url, event.source?.url, event.source?.name].filter(Boolean),
    });
  }
  const directPairs = Object.entries(event.changes || {})
    .filter(([, value]) => objectPair(value))
    .map(([field, value]) => ({ field, ...value }));
  if (directPairs.length) {
    return model({
      kind: "modification",
      basis: "exact_snapshot",
      before: { state: "known", items: directPairs.map((item) => namedValue(item.field, item.before)) },
      after: { state: "known", items: directPairs.map((item) => namedValue(item.field, item.after)) },
      evidence: [event.url, event.source?.url, event.factory, event.launcher].filter(Boolean),
    });
  }
  const revised = event.changeType === "revised" || event.kind === "revised";
  const oldValue = event.previousTitle || event.previousSummary || event.previousVersion;
  const additions = Object.entries(event.changes || {}).flatMap(([field, value]) => {
    if (!/^new|^added/i.test(field)) return [];
    return array(value).map((item) => namedValue(field, item));
  });
  const currentFacts = [
    event.title,
    ...array(event.keyChanges),
    event.summary,
    event.description,
    event.message,
    event.mode?.officialName,
    event.mode?.componentMode,
    event.mode?.selectorName,
    event.mode?.selector,
    event.tag && `版本 ${event.tag}`,
    event.launcher && `Launcher ${event.launcher}`,
    event.factory && `Factory ${event.factory}`,
    event.contract && `Contract ${event.contract}`,
    event.token && `CA ${event.token}`,
    event.tokens?.[0]?.token && `首个样本 ${event.tokens[0].token}`,
    event.featureFirstToken || event.officialFirstToken
      ? event.security?.decision === "pass" && event.security?.metrics?.liquidityConfirmed === true
        ? "首个通过本地权限与交易安全初筛的代币"
        : "仅用于识别新功能，未通过安全门槛/不可买"
      : null,
    ...additions,
  ].filter(Boolean);
  const structuralAddition = ["new_factory", "new_mode", "official_deployment"].includes(event.kind)
    || ["contract_deployed", "token_launch", "pons_v2_factory_discovered"].includes(event.type);
  return model({
    kind: revised ? "modification" : structuralAddition ? "addition" : "publication",
    basis: revised ? "official_claim" : event.comparisonBasis || (event.type === "ai_official_update" || event.type === "uniswap_official_update" || event.type === "binance_official_update" ? "official_claim" : "monitoring_baseline"),
    before: oldValue ? { state: "known", items: [oldValue] } : revised ? { state: "unknown" } : { state: "not_observed" },
    after: { state: "known", items: currentFacts.length ? currentFacts : ["已确认发生更新，具体字段暂未解析"] },
    evidence: [event.url, event.source?.url, event.source?.name, event.repository, event.sourceUrl, event.transactionHash].filter(Boolean),
  });
}

function flapTrackedPoolTokenModel(event) {
  const ordinal = Number(event?.featureTokenOrdinal);
  const target = Number(event?.featureTokenTarget);
  const tokenEntry = event?.tokens?.[0] || {};
  const token = String(tokenEntry?.token || "").trim();
  const metadata = tokenEntry?.metadata || {};
  const name = String(metadata?.name || "").replace(/\s+/g, " ").trim();
  const symbol = String(metadata?.symbol || "").replace(/\s+/g, " ").trim();
  const label = name && symbol && name.toLowerCase() !== symbol.toLowerCase()
    ? `${name} (${symbol})`
    : name || symbol || "未命名代币";
  const quote = String(event?.mode?.quoteSymbol || event?.mode?.quoteName || event?.mode?.quoteAsset || "Flap").trim();
  const ordinalLabel = Number.isSafeInteger(ordinal) && ordinal >= 1 && target === 3
    ? `第 ${ordinal}/${target} 个代币`
    : "追踪代币";
  const revision = event?.canonicalRevision;
  const canonicalRevision = revision?.version === 1
    && revision?.reason === "token_created_reorg"
    && Number(revision?.ordinal) === ordinal
    && /^0x[a-fA-F0-9]{64}$/.test(String(revision?.replacesBlockHash || ""))
    && /^0x[a-fA-F0-9]{40}$/.test(String(revision?.replacesTokenAddress || ""));
  return model({
    kind: canonicalRevision ? "modification" : "addition",
    basis: "exact_snapshot",
    before: canonicalRevision
      ? { state: "known", items: [`${ordinalLabel}（被链重组替换） · CA ${revision.replacesTokenAddress}`] }
      : { state: "not_observed" },
    after: {
      state: "known",
      items: [`${ordinalLabel}: ${label} · CA ${token} · ${quote} 配对${canonicalRevision ? "（以本条为准）" : ""}`],
    },
    evidence: [
      event?.transactionHash && Number.isSafeInteger(Number(event?.blockNumber))
        ? `${event.transactionHash}#${Number(event.blockNumber)}`
        : event?.transactionHash,
      event?.mode?.quoteAsset ? `Quote ${event.mode.quoteAsset}` : null,
    ].filter(Boolean),
  });
}

export function deriveAlertChangeModel(event = {}) {
  if (event.type === "pon_fun_update") return ponFunUpdateModel(event);
  if (event.type === "platform_capability_update") return platformChangeModel(event);
  if (event.type === "bsc_launchpad_update"
    && event.kind === "flap_pool_token"
    && event.featureTrackedToken === true) return flapTrackedPoolTokenModel(event);
  if (event.type === "bsc_launchpad_update" && event.mode?.selector === "official-template") return fourMemeTemplateModel(event);
  if (event.type === "binance_official_update" && event.kind === "developer_update") return developerUpdateModel(event);
  if (event.currentSnapshot && typeof event.currentSnapshot === "object") return explicitSnapshotModel(event);
  if (event.kind === "portal_upgrade" && (event.chain?.slug === "morph" || event.platform?.id === "flap")) return morphPortalModel(event);
  if (event.type === "github_module_update") return githubUpdateModel(event);
  if (event.type === "github_monitor_gap") return githubGapModel(event);
  if (["github_repository_discovered", "github_repository_verified"].includes(event.type)) return repositoryModel(event);
  if (event.type === "telegram_news_update") return telegramNewsModel(event);
  if (event.type === "twitter_update") return twitterModel(event);
  if (event.type === "token_launch" && event.modeDifference) return tokenModeModel(event);
  if (event.type === "early_activity_alert" && event.activity === "volume_anomaly") return volumeModel(event);
  if (event.type === "early_activity_alert" && event.activity === "metadata_enriched") return metadataEnrichmentModel(event);
  if (event.type === "official_activity") return officialActivityModel(event);
  if (event.type === "fomo_family_top_call") return fomoModel(event);
  if (event.type === "launchpad_site_update") return siteModel(event);
  const collectionDelta = collectionDeltaModel(event);
  if (collectionDelta) return collectionDelta;
  return genericPublishedModel(event);
}

function sideText(value, locale, maxItems) {
  if (value.state === "unknown") return UNKNOWN[locale];
  if (value.state === "not_observed") return NOT_OBSERVED[locale];
  const items = value.items.slice(0, maxItems);
  const extra = value.items.length - items.length;
  const content = items.length ? items.join("；") : value.text;
  if (!extra) return content || (locale === "zh" ? "已确认，详情待解析" : "Confirmed; details pending");
  return `${content}${locale === "zh" ? `；另有${extra}项` : `; +${extra} more`}`;
}

function boundedLine(label, value) {
  return oneLine(`${label}: ${value}`, 220);
}

function englishFact(value) {
  return String(value || "")
    .replace(/官方组织\/官方来源/g, "official organization/source")
    .replace(/新增底池/g, "New pool")
    .replace(/新底池/g, "new pool")
    .replace(/底池配置更新/g, "Pool configuration update")
    .replace(/底池更新/g, "Pool update")
    .replace(/新增仓库/g, "added repository")
    .replace(/（新增）/g, " (added)")
    .replace(/（已移除）/g, " (removed)")
    .replace(/（修改前）/g, " (before modification)")
    .replace(/（已修改([^）]*)）/g, " (modified$1)")
    .replace(/（旧内容）/g, " (previous content)")
    .replace(/（已更新）/g, " (updated)")
    .replace(/（新增\s*([^）]+)）/g, " (added $1)")
    .replace(/官方归属未确认/g, "official ownership unverified")
    .replace(/官方归属已确认/g, "official ownership verified")
    .replace(/检测到能力快照变化，字段尚未解析/g, "Capability snapshot changed; exact field unresolved")
    .replace(/官网内容发生变化，具体字段尚未解析/g, "Official site changed; exact field unresolved")
    .replace(/已确认发生更新，具体字段暂未解析/g, "Update confirmed; exact field unresolved")
    .replace(/项目资料已补全，字段值暂未解析/g, "Project metadata enriched; field values unresolved")
    .replace(/已确认，详情待解析/g, "Confirmed; details pending")
    .replace(/本次买入/g, "this buy")
    .replace(/本次卖出/g, "this sell")
    .replace(/本次销毁/g, "this burn")
    .replace(/本次链上行为/g, "this on-chain action")
    .replace(/官方地址/g, "official address")
    .replace(/数量暂未解析/g, "amount unresolved")
    .replace(/新增合约地址/g, "new contract address")
    .replace(/角色未解析/g, "role unresolved")
    .replace(/主网状态/g, "mainnet status")
    .replace(/已支持/g, "supported")
    .replace(/已部署/g, "deployed")
    .replace(/旧内容/g, "previous content")
    .replace(/已更新/g, "updated")
    .replace(/已移除/g, "removed")
    .replace(/未设置/g, "not set")
    .replace(/新增/g, "added")
    .replace(/修改前/g, "before modification")
    .replace(/已修改/g, "modified")
    .replace(/监控游标/g, "monitoring cursor")
    .replace(/最新提交/g, "latest commit")
    .replace(/覆盖状态/g, "coverage status")
    .replace(/已拉取\s*(\d+)\s*条/g, "$1 commits fetched")
    .replace(/交易前仓位/g, "pre-transaction position")
    .replace(/前一区块仓位/g, "previous-block position")
    .replace(/首仓买入/g, "first-position buy")
    .replace(/X 喊单/g, "X call")
    .replace(/公开 X 原帖/g, "public X post")
    .replace(/位 KOL 共振/g, " KOL convergence")
    .replace(/金额/g, "amount")
    .replace(/当前量能已触发门槛/g, "Current volume crossed the threshold")
    .replace(/级别/g, "level")
    .replace(/加速/g, "acceleration")
    .replace(/1分钟量/g, "1m volume")
    .replace(/报价配置/g, "quote config")
    .replace(/报价资产/g, "quote asset")
    .replace(/报价/g, "Quote")
    .replace(/官方外链/g, "official link")
    .replace(/前端资源/g, "frontend asset")
    .replace(/软件包/g, "package")
    .replace(/底池/g, "pool")
    .replace(/网络/g, "network")
    .replace(/模块/g, "module")
    .replace(/合约/g, "contract")
    .replace(/页面/g, "page")
    .replace(/公告/g, "announcement")
    .replace(/活动/g, "campaign")
    .replace(/版本/g, "version")
    .replace(/文件/g, "file")
    .replace(/仓库/g, "repository")
    .replace(/功能/g, "feature")
    .replace(/关键词/g, "keyword")
    .replace(/模板/g, "template")
    .replace(/字段/g, "field")
    .replace(/参数/g, "parameter")
    .replace(/首个样本/g, "first sample")
    .replace(/首币/g, "first token")
    .replace(/第\s*(\d+)\/(\d+)\s*个代币/g, "Token $1/$2")
    .replace(/被链重组替换/g, "replaced by chain reorg")
    .replace(/以本条为准/g, "this record is canonical")
    .replace(/另有(\d+)项/g, "+$1 more")
    .replaceAll("；", "; ")
    .replaceAll("：", ": ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function evidenceAlreadyRepresented(value, sides) {
  const source = String(value || "");
  if (!source) return true;
  if (sides.includes(source)) return true;
  const basename = source.includes("/") ? source.split("/").filter(Boolean).at(-1) : "";
  return Boolean(basename && basename.length >= 5 && sides.includes(basename));
}

export function renderAlertChangeLines(changeModel, { locale = "zh", maxItems = 3 } = {}) {
  const selectedLocale = locale === "en" ? "en" : "zh";
  const limit = Math.max(1, Math.min(20, Number(maxItems) || 3));
  const sideSource = `${changeModel.before.text} ${changeModel.before.items.join(" ")} ${changeModel.after.text} ${changeModel.after.items.join(" ")}`;
  const evidence = changeModel.evidence.filter((value) => !evidenceAlreadyRepresented(value, sideSource)).slice(0, limit);
  const evidenceExtra = changeModel.evidence.length - evidence.length;
  const localEvidence = selectedLocale === "en" ? evidence.map(englishFact) : evidence;
  const evidenceText = [BASIS_LABELS[changeModel.basis]?.[selectedLocale] || BASIS_LABELS.monitoring_baseline[selectedLocale], ...localEvidence].join(" · ")
    + (evidenceExtra > 0 ? (selectedLocale === "zh" ? ` · 另有${evidenceExtra}项` : ` · +${evidenceExtra} more`) : "");
  const labels = selectedLocale === "zh"
    ? ["变化类型", "原有", "更新后", "对比依据"]
    : ["Change type", "Before", "After", "Comparison basis"];
  return Object.freeze([
    boundedLine(labels[0], KIND_LABELS[changeModel.kind]?.[selectedLocale] || KIND_LABELS.modification[selectedLocale]),
    boundedLine(labels[1], selectedLocale === "en" ? englishFact(sideText(changeModel.before, selectedLocale, limit)) : sideText(changeModel.before, selectedLocale, limit)),
    boundedLine(labels[2], selectedLocale === "en" ? englishFact(sideText(changeModel.after, selectedLocale, limit)) : sideText(changeModel.after, selectedLocale, limit)),
    boundedLine(labels[3], evidenceText),
  ]);
}

export function changeModelSummary(eventOrModel, options = {}) {
  const changeModel = eventOrModel?.before && eventOrModel?.after && eventOrModel?.basis
    ? eventOrModel
    : deriveAlertChangeModel(eventOrModel);
  return renderAlertChangeLines(changeModel, options).join("\n");
}
