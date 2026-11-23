// Tracks movements of noted addresses. Read-only: piggybacks on wallet-learning activity rows
// (already fetched from GMGN) and early-watchlist launches. No extra signer / swap / RPC writes.
import fs from "node:fs";
import path from "node:path";
import { createGmgnFlowClient } from "./gmgn-flow-client.js";
import { parseWalletActivity } from "./wallet-learning.js";
import { listNotes, loadAddressNotes, normalizeAddress } from "./address-notes.js";

const MAX_ACTIVITIES = 500;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const writeJson = (f, v) => { const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v, null, 2)); fs.renameSync(t, f); };
const SIDE_ZH = { buy: "买入", sell: "卖出", deploy: "部署", unattributable: "转账/未识别" };

export function formatAddressNoteAlert(a) {
  const amt = a.usd != null ? ` $${Number(a.usd).toFixed(a.usd >= 100 ? 0 : 2)}` : "";
  return `📌 [${a.label}] ${SIDE_ZH[a.side] || a.side} ${a.symbol || a.token.slice(0, 10)}${amt}\n` +
    `链:${a.chain} 类别:${a.category}/${a.follow}\n钱包:${a.wallet}\n代币:${a.token}${a.hash ? `\ntx:${a.hash}` : ""}`;
}

export function createAddressNotesMonitor(config = {}, deps = {}) {
  const dataDir = path.resolve(config.dataDir || "data");
  const actFile = path.join(dataDir, "address-notes-activity.json");
  const intervalMs = Math.max(15_000, Number(config.addressNotesPollIntervalMs) || 60_000);
  const minAlertUsd = Number(config.addressNotesMinAlertUsd ?? 50);
  const alertsEnabled = config.addressNotesAlertsEnabled === true;
  const now = deps.now || Date.now;
  const log = deps.logger || console;
  const send = deps.sendTelegram || (async (text) => {
    if (!config.telegramToken || !config.telegramChatId) return;
    const r = await fetch(`https://api.telegram.org/bot${config.telegramToken}/sendMessage`, { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: config.telegramChatId, text, disable_web_page_preview: true }) });
    if (!r.ok) throw new Error(`telegram ${r.status}`);
  });
  let timer = null;
  // Direct GMGN activity polling for noted wallets NOT covered by wallet-learning (shared rate gate, 1 wallet/fetch).
  const fetchPerTick = Math.max(0, Number(config.addressNotesFetchPerTick ?? 2));
  const fetchIntervalMs = Math.max(10_000, Number(config.addressNotesFetchIntervalMs) || 20_000);
  let client = deps.gmgnClient || null; let fetchTimer = null; let cursor = 0; const fetched = new Map();
  async function fetchSome() {
    if (!fetchPerTick) return;
    { const nodeDir = path.dirname(process.execPath); const parts = String(process.env.PATH || "").split(":"); for (const d of [nodeDir, "/opt/homebrew/bin"]) if (!parts.includes(d)) parts.unshift(d); process.env.PATH = parts.filter(Boolean).join(":"); }
    client ||= createGmgnFlowClient({ ...config, gmgnFlowCliPath: process.env.ADDRESS_NOTES_GMGN_CLI_PATH || (fs.existsSync("/opt/homebrew/bin/gmgn-cli") ? "/opt/homebrew/bin/gmgn-cli" : config.gmgnFlowCliPath) });
    const covered = new Set(Object.values(readJson(path.join(dataDir, "wallet-learning-state.json"))?.wallets || {}).map((w) => normalizeAddress(w.wallet)));
    const queue = listNotes({ dataDir }).filter((n) => n.category !== "official" && n.category !== "dev" && !covered.has(n.address))
      .sort((a, b) => (a.follow === "boost" ? 0 : 1) - (b.follow === "boost" ? 0 : 1));
    for (let i = 0; i < fetchPerTick && queue.length; i++) {
      const n = queue[cursor++ % queue.length];
      try { const payload = await client.activity(n.chain, n.address, { limit: 50 });
        fetched.set(n.address, parseWalletActivity(payload, n.chain, n.address, now()).rows);
      } catch (e) { log.error(`[address-notes] fetch ${n.chain}:${n.address.slice(0, 8)} ${e.code || e.message}`); }
    }
  }

  async function tick() {
    loadAddressNotes(dataDir);
    const notes = new Map(listNotes({ dataDir }).filter((n) => n.follow !== "avoid" || n.category !== "official").map((n) => [n.address, n]));
    const state = readJson(actFile) || { schema: "address_notes_activity_v1", seen: [], activities: [], baselineAt: null };
    const seen = new Set(state.seen || []);
    const first = !state.baselineAt;
    const fresh = [];
    const push = (a) => { if (!(a.at >= now() - 3 * 86400_000)) return; const k = `${a.hash || a.side}:${a.wallet}:${a.token}`; if (seen.has(k)) return; seen.add(k); fresh.push(a); };
    for (const w of Object.values(readJson(path.join(dataDir, "wallet-learning-state.json"))?.wallets || {})) {
      const n = notes.get(normalizeAddress(w.wallet)); if (!n) continue;
      for (const r of w.rows || []) push({ at: r.at, chain: r.chain, wallet: n.address, label: n.label, category: n.category, follow: n.follow,
        side: r.side, token: r.token, symbol: r.symbol, usd: r.usd, hash: r.hash, source: "wallet-learning" });
    }
    for (const [addr, rows] of fetched) { const n = notes.get(addr); if (!n) continue;
      for (const r of rows) push({ at: r.at, chain: r.chain, wallet: n.address, label: n.label, category: n.category, follow: n.follow,
        side: r.side, token: r.token, symbol: r.symbol, usd: r.usd, hash: r.hash, source: "gmgn-activity" });
    }
    fetched.clear();
    for (const t of Object.values(readJson(path.join(dataDir, "early-watchlist.json"))?.tokens || {})) {
      const n = notes.get(normalizeAddress(t.launcher)); if (!n) continue;
      push({ at: Date.parse(t.firstSeenAt) || now(), chain: "robinhood", wallet: n.address, label: n.label, category: n.category, follow: n.follow,
        side: "deploy", token: String(t.token).toLowerCase(), symbol: t.symbol, usd: null, hash: t.launchTransactionHash || null, source: "early-watchlist" });
    }
    fresh.sort((a, b) => a.at - b.at);
    const recentCut = now() - 2 * 3600_000;
    const alertable = first ? [] : fresh.filter((a) => a.at >= recentCut && (a.side === "deploy" || (a.usd ?? 0) >= minAlertUsd || a.side === "unattributable"));
    const next = { schema: "address_notes_activity_v1", baselineAt: state.baselineAt || new Date(now()).toISOString(),
      updatedAt: new Date(now()).toISOString(), notesCount: notes.size,
      seen: [...seen].slice(-20000), activities: [...(state.activities || []), ...fresh].sort((a, b) => a.at - b.at).slice(-MAX_ACTIVITIES) };
    writeJson(actFile, next);
    if (alertsEnabled) for (const a of alertable.slice(-10)) {
      try { await send(formatAddressNoteAlert(a)); } catch (e) { log.error(`[address-notes] alert failed: ${e.message}`); }
    }
    if (fresh.length) log.log(`[address-notes] +${fresh.length} activity (${alertable.length} alerts)${first ? " baseline" : ""}`);
    return { fresh: fresh.length, alerts: alertable.length };
  }
  return {
    tick, fetchSome,
    start() { const run = () => tick().catch((e) => log.error(`[address-notes] ${e.message}`)); void run(); timer = setInterval(run, intervalMs); timer.unref?.();
      fetchTimer = setInterval(() => fetchSome().catch((e) => log.error(`[address-notes] fetch ${e.message}`)), fetchIntervalMs); fetchTimer.unref?.(); },
    stop() { if (timer) clearInterval(timer); if (fetchTimer) clearInterval(fetchTimer); timer = fetchTimer = null; },
  };
}
