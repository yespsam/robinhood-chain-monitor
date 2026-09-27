import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { atomicWriteRuntimeHeartbeat } from "./runtime-heartbeat.js";
import { GIWA_NETWORK, GIWA_SOURCES, GIWA_TESTNET_FACTORIES, GIWA_PENDING_LEADS } from "./giwa-catalog.js";
import { readGiwaOfficialX, verifyGiwaOembed } from "./giwa-x-source.js";

const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unique = (items) => [...new Set(items)].sort().slice(0, 80);
const clean = (s) => String(s || "").replace(/<[^>]*>/g, " ").replace(/&(?:nbsp|amp|quot|lt|gt);/g, " ").replace(/\s+/g, " ").trim();
const plain = (s) => clean(s).replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ");

export function extractGiwaSnapshot(source, body) {
  // Scripts are never evaluated. GitBook's appended agent instructions are
  // not network facts and must not become part of a monitored announcement.
  const raw = String(body).split(/^# Agent Instructions\s*$/m)[0];
  if (raw.length < 50 || /<title>\s*(?:Just a moment|Access denied|Attention Required)/i.test(raw)) throw new Error("unusable_source_response");
  const visible = raw.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  const statusText = clean(visible);
  const statusLabels = [
    /\bGIWA\s+(?:Sepolia|Testnet)\b/i.test(statusText) ? "页面含 GIWA 测试网标识" : null,
    /\b(?:preview\s*[·-]?\s*not live yet|mock interfaces|demo data)\b/i.test(statusText) ? "页面注明演示预览或模拟数据" : null,
    /\bcoming soon\b/i.test(statusText) ? "页面含即将上线预告" : null,
  ].filter(Boolean);
  const title = plain(raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || raw.match(/^# (.+)$/m)?.[1] || "").slice(0, 180);
  const descriptionTag = [...raw.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]).find((m) => /(?:name|property)=["'](?:description|og:description)["']/i.test(m));
  const description = plain(descriptionTag?.match(/content=["']([^"']*)["']/i)?.[1]).slice(0, 350);
  let networkNotice = "";
  if (source.kind === "network") {
    networkNotice = plain(raw.match(/## GIWA Mainnet\s*([\s\S]*?)(?=\n## |$)/)?.[1]).slice(0, 1000);
    if (!networkNotice || !/GIWA/i.test(raw)) throw new Error("network_document_shape_changed");
  }
  const contractText = source.kind === "deployments"
    ? raw.split("\n").filter((line) => /GIWA|Sepolia|91342/.test(line)).join("\n")
    : visible;
  const contracts = unique((contractText.match(/\b0x[0-9a-fA-F]{40}\b/g) || []).map((s) => s.toLowerCase()));
  const links = unique([...raw.matchAll(/https:\/\/[^\s<>"'`\\)]+/g)].map((m) => m[0]).filter((u) => {
    try { const p = new URL(u); return u.length < 700 && !p.username && !p.password && !p.search && !p.hash && /(?:giwa|gasok|joseon|gazua|memefab|vezta|x\.com|t\.me)/i.test(p.hostname) && !/\.(?:png|jpg|webp|svg|woff2?)$/i.test(p.pathname); } catch { return false; }
  }));
  const scripts = unique([...raw.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)].flatMap((m) => {
    try { const p = new URL(m[1], source.url); return p.origin === new URL(source.url).origin && /\/(?:assets\/index-|_next\/static\/chunks\/app\/)/.test(p.pathname) ? [p.pathname] : []; } catch { return []; }
  }));
  if (!title && !description && !networkNotice && !contracts.length) throw new Error("empty_semantic_snapshot");
  return { title, description, networkNotice, contracts, links, scripts, statusLabels };
}

export function giwaChanges(before, after) {
  const result = [];
  for (const post of after.officialPosts || []) {
    if ((before.officialPosts || []).some((old) => old.id === post.id && old.text === post.text)) continue;
    const denial = /(?:haven[’']t launched our mainnet yet|DO NOT have our mainnet running currently)/i.test(post.text);
    const summary = denial ? "官方声明主网尚未上线" : `官方新帖（原文）：${plain(post.text).slice(0, 380)}`;
    result.push(`${summary}；发布时间 ${post.publishedAt}；${post.url}`);
  }
  // The first parser upgrade only enriches the baseline, not a fake site change.
  if (Array.isArray(before.statusLabels) && JSON.stringify(before.statusLabels) !== JSON.stringify(after.statusLabels)) {
    result.push(`页面阶段标识：${before.statusLabels.join("、") || "未列出"} → ${(after.statusLabels || []).join("、") || "未列出（不代表已上线）"}`);
  }
  for (const [key, label] of [["title", "页面标题"], ["description", "页面说明"], ["networkNotice", "官方主网说明"]]) {
    if (before[key] !== after[key]) result.push(`${label}：${plain(before[key] || "未列出").slice(0, 160)} → ${plain(after[key] || "未列出").slice(0, 220)}`);
  }
  for (const [key, label] of [["contracts", "页面合约地址（用途待核验）"], ["links", "页面链接"]]) {
    for (const v of (after[key] || []).filter((v) => !(before[key] || []).includes(v)).slice(0, 4)) result.push(`${label}新增：${v}`);
    for (const v of (before[key] || []).filter((v) => !(after[key] || []).includes(v)).slice(0, 2)) result.push(`${label}移除：${v}`);
  }
  if (JSON.stringify(before.scripts) !== JSON.stringify(after.scripts)) result.push("前端部署文件变化；具体功能和是否开放交易尚未核验");
  return result.slice(0, 12);
}

export function createGiwaEvent(source, before, after, observedAt, previousObservedAt) {
  const event = {
    type: "giwa_ecosystem_update", sourceId: source.id, sourceUrl: source.url,
    observedAt, previousObservedAt, before, after,
    chain: "giwa", networkStatus: "mainnet_unverified", autoTradeEligible: false,
    coverage: "public_source_changes_only", changes: giwaChanges(before, after),
  };
  // Include the prior observation time: a genuine A→B change after B→A must
  // not be permanently suppressed as the first A→B transition.
  event.eventKey = `giwa:${source.id}:${hash({ before, after, previousObservedAt })}`;
  event.renderedZh = renderGiwaEvent(event);
  return event;
}

export function renderGiwaEvent(event) {
  const source = GIWA_SOURCES.find((s) => s.id === event.sourceId);
  return [
    `🛰 GIWA 生态更新｜${source?.name || "未知来源"}`,
    source?.kind === "official_x" ? "范围：已核对原文的官方公告；不自动启用交易" : "范围：官网/部署资料变化；主网状态待核实",
    ...(source?.stageNote ? [`登记备注：${source.stageNote}`] : []),
    ...event.changes.map((s) => `· ${s}`),
    `观测时间：${event.observedAt}（不是公告发布时间）`,
    `来源：${event.sourceUrl}`,
  ].join("\n");
}

export function isGiwaEvent(event) {
  try {
    const source = GIWA_SOURCES.find((s) => s.id === event?.sourceId);
    if (!source || event.type !== "giwa_ecosystem_update" || event.sourceUrl !== source.url
      || event.chain !== "giwa" || event.networkStatus !== "mainnet_unverified"
      || event.autoTradeEligible !== false || event.coverage !== "public_source_changes_only"
      || !Number.isFinite(Date.parse(event.observedAt)) || !Number.isFinite(Date.parse(event.previousObservedAt))
      || Date.parse(event.previousObservedAt) > Date.parse(event.observedAt)
      || !event.before || !event.after || hash(event.before) === hash(event.after)) return false;
    if (source.kind === "official_x") {
      for (const snapshot of [event.before, event.after]) {
        if (!Array.isArray(snapshot.officialPosts) || !snapshot.officialPosts.length) return false;
        for (const post of snapshot.officialPosts) {
          const verified = verifyGiwaOembed(post.id, post.oembed, Date.parse(event.observedAt));
          if (post.text !== verified.text || post.url !== verified.url || post.publishedAt !== verified.publishedAt) return false;
        }
      }
    }
    const expected = createGiwaEvent(source, event.before, event.after, event.observedAt, event.previousObservedAt);
    return expected.changes.length > 0 && expected.eventKey === event.eventKey
      && JSON.stringify(expected.changes) === JSON.stringify(event.changes)
      && expected.renderedZh === event.renderedZh;
  } catch { return false; }
}

async function limitedText(response, maxBytes = 2_000_000) {
  let bytes = 0;
  const chunks = [];
  if (!response.body) throw new Error("empty_http_body");
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error("source_response_too_large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function createGiwaMonitor({ dataDir, sendAlert, fetchImpl = fetch, now = Date.now,
  sources = GIWA_SOURCES, writeAtomic = atomicWriteRuntimeHeartbeat, rpcEnabled = true } = {}) {
  const file = path.join(dataDir, "state.json");
  let state;
  try { state = JSON.parse(await fs.readFile(file, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; state = { version: 1, sources: {}, pending: [], receipts: [] }; }
  if (state.version !== 1 || !state.sources || !Array.isArray(state.pending) || !Array.isArray(state.receipts)) throw new Error("invalid_giwa_state");
  let active = null;
  let stopped = false;
  const save = () => writeAtomic(file, state);
  const iso = () => new Date(now()).toISOString();
  const fetchText = async (url, options = {}) => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(8_000), ...options });
    if (!response.ok) { await response.body?.cancel?.(); throw new Error(`http_${response.status}`); }
    if (!options.method && response.url && new URL(response.url).origin !== new URL(url).origin) throw new Error("cross_origin_redirect");
    return limitedText(response);
  };
  async function rpc(method, params) {
    const result = JSON.parse(await fetchText(GIWA_NETWORK.rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }));
    if (result.error || result.result == null) throw new Error("rpc_response_error");
    return result.result;
  }
  async function checkTestnet() {
    if (!rpcEnabled || Date.parse(state.testnet?.nextCheckAt || 0) > now()) return;
    try {
      const chainId = Number(BigInt(await rpc("eth_chainId", [])));
      if (chainId !== GIWA_NETWORK.chainId) throw new Error("rpc_chain_identity_mismatch");
      const block = await rpc("eth_blockNumber", []);
      const contracts = [];
      for (const factory of GIWA_TESTNET_FACTORIES) {
        const code = await rpc("eth_getCode", [factory.address, "latest"]);
        if (!/^0x(?:[a-fA-F0-9]{2})*$/.test(code)) throw new Error("invalid_contract_code");
        contracts.push({ ...factory, chainId, hasCode: code !== "0x", codeHash: hash(code), checkedAt: iso() });
      }
      state.testnet = { status: contracts.every((c) => c.hasCode) ? "healthy" : "missing_contract_code", chainId, block, contracts, checkedAt: iso(), nextCheckAt: new Date(now() + 600_000).toISOString() };
    } catch (error) {
      state.testnet = { ...state.testnet, status: "degraded", error: error.message, attemptedAt: iso(), nextCheckAt: new Date(now() + 600_000).toISOString() };
    }
    await save();
  }
  async function drain() {
    if (!sendAlert) return;
    // A prior failed fsync may have left newer in-memory state. Never deliver
    // even on the next cycle until this producer state is durable again.
    if (state.pending.length) await save();
    for (const event of [...state.pending].slice(0, 10)) {
      if (!isGiwaEvent(event)) throw new Error("invalid_pending_giwa_event");
      let receipt;
      try { receipt = await sendAlert(event); } catch { break; }
      // Only hand off after durable outbox admission. A source-policy rejection
      // is not delivery and must remain visible for repair.
      if (receipt?.persisted !== true || !["delivered", "queued", "suppressed"].includes(receipt.status)) break;
      state.pending = state.pending.filter((item) => item.eventKey !== event.eventKey);
      state.receipts.push({ eventKey: event.eventKey, status: receipt.status, reason: receipt.reason, eventId: receipt.eventId, at: iso() });
      state.receipts = state.receipts.slice(-100);
      await save();
    }
  }
  async function cycle() {
    await drain();
    // Sequential, low-volume fetches avoid starving the existing TG and GMGN
    // workers. The public testnet RPC is health-only, not a production scanner.
    for (const source of sources) {
      if (stopped) break;
      if (!GIWA_SOURCES.some((s) => s.id === source.id && s.url === source.url)) throw new Error("unregistered_giwa_source");
      const prior = state.sources[source.id] || {};
      if (Date.parse(prior.nextCheckAt || 0) > now()) continue;
      try {
        if (state.pending.length >= 200) throw new Error("pending_delivery_capacity");
        const snapshot = source.kind === "official_x"
          ? { title: "GIWA 官方公告", description: "", networkNotice: "", contracts: [], links: [], scripts: [],
            officialPosts: await readGiwaOfficialX(fetchText, prior.snapshot?.officialPosts, now()) }
          : extractGiwaSnapshot(source, await fetchText(source.url));
        const observedAt = iso();
        if (prior.snapshot && hash(prior.snapshot) !== hash(snapshot)) {
          const event = createGiwaEvent(source, prior.snapshot, snapshot, observedAt, prior.observedAt);
          if (event.changes.length) state.pending.push(event);
        }
        state.sources[source.id] = { sourceUrl: source.url, snapshot, observedAt, firstObservedAt: prior.firstObservedAt || observedAt, status: "healthy", failures: 0, nextCheckAt: new Date(now() + 90_000).toISOString() };
      } catch (error) {
        const failures = (prior.failures || 0) + 1;
        state.sources[source.id] = { ...prior, sourceUrl: source.url, status: "degraded", error: error.message, failures, attemptedAt: iso(), nextCheckAt: new Date(now() + Math.min(3_600_000, 90_000 * 2 ** Math.min(failures, 6))).toISOString() };
      }
      // Commit baseline and event together BEFORE any external delivery.
      await save();
    }
    if (!stopped) await checkTestnet();
    state.updatedAt = iso();
    state.coverage = {
      network: GIWA_NETWORK, mode: "public_sources_and_testnet_contract_health",
      tokenLaunchScanning: false, allLaunchpadsCovered: false,
      registeredSources: GIWA_SOURCES.length,
      healthySources: Object.values(state.sources).filter((s) => s.status === "healthy").length,
      pendingLeads: GIWA_PENDING_LEADS,
      blocker: "GIWA 主网 chainId/RPC/发射工厂尚未由官方核实；网站监控不等于全链新币监控",
    };
    await save();
    await drain();
    return structuredClone(state);
  }
  return {
    check() {
      if (stopped) return Promise.resolve(structuredClone(state));
      if (!active) active = cycle().finally(() => { active = null; });
      return active;
    },
    async stop() { stopped = true; await active; },
    snapshot() { return structuredClone(state); },
  };
}
