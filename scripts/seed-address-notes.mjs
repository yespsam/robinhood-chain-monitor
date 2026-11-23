// Seeds data/address-notes.json by distilling high-profit wallets from existing project data.
// Preserves manual entries (source:"manual"). Thresholds below are the documented policy.
import fs from "node:fs"; import { execFileSync } from "node:child_process";
const D = "data", now = new Date().toISOString(), out = new Map();
const MIN_PROFIT_USD = 1000;      // 30d realized profit floor
const BOOST_WINRATE = 0.5;        // >= -> boost
const MIN_WINRATE = 0.25;         // below this only kept if profit >= ELITE_PROFIT_USD
const ELITE_PROFIT_USD = 20000;
const TRACKED_CAP = 700;          // excluding official
const DEV_CAP = 30;
const read = (f) => { try { return JSON.parse(fs.readFileSync(`${D}/${f}`, "utf8")); } catch { return null; } };
const tracked = () => [...out.values()].filter(n => n.category !== "official").length;
const add = (e) => { const a = String(e.address || "").toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a) || out.has(a)) return false; out.set(a, { ...e, address: a, addedAt: e.addedAt || now }); return true; };
for (const n of read("address-notes.json")?.notes || []) if (n.source === "manual") add(n);
for (const c of read("official-addresses.json")?.officialContracts || []) add({ address: c.address, chain: "robinhood", label: `官方:${c.project}/${c.role}`, category: "official", source: "official-addresses", note: c.type, follow: "avoid" });
// Candidate pool: learning wallets/universe (freshest) + sqlite latest 30d profiles.
const cand = new Map();
const consider = (chain, wallet, p, tags, source) => { if (!["bsc", "robinhood"].includes(chain) || !p) return; const k = String(wallet).toLowerCase();
  const prev = cand.get(k); if (prev && Date.parse(prev.p.checkedAt || 0) >= Date.parse(p.checkedAt || 0)) return; cand.set(k, { chain, wallet: k, p, tags: tags || p.tags || [], source }); };
const wl = read("wallet-learning-state.json");
for (const w of [...Object.values(wl?.wallets || {}), ...Object.values(wl?.universe || {})]) consider(w.chain, w.wallet, w.profile?.["30d"], w.tags, "wallet-learning");
try { const rows = execFileSync("sqlite3", ["-json", `${D}/wallet-address-library.sqlite`,
  "with l as (select key,payload,row_number() over (partition by key order by checked_at desc) rn from profiles where period='30d' and (key like 'bsc:%' or key like 'robinhood:%')) select key,payload from l where rn=1"], { encoding: "utf8", maxBuffer: 1 << 28 });
  for (const r of JSON.parse(rows || "[]")) { const p = JSON.parse(r.payload); consider(p.chain, p.wallet, p, p.tags, "wallet-address-library"); }
} catch (e) { console.error("sqlite distill skipped:", e.message); }
const ranked = [...cand.values()].filter(({ p }) => (p.realizedProfitUsd || 0) >= MIN_PROFIT_USD && ((p.winRate || 0) >= MIN_WINRATE || p.realizedProfitUsd >= ELITE_PROFIT_USD))
  .sort((a, b) => b.p.realizedProfitUsd - a.p.realizedProfitUsd);
for (const c of ranked) { if (tracked() >= TRACKED_CAP - DEV_CAP) break; const { p } = c; const kol = c.tags.includes("kol");
  add({ address: c.wallet, chain: c.chain, label: `${kol ? "KOL" : "聪明钱"}-${c.wallet.slice(2, 6)}-$${Math.round(p.realizedProfitUsd / 1000)}k`, category: kol ? "kol" : "smart", source: c.source,
    note: `30d盈利$${Math.round(p.realizedProfitUsd)} 胜率${Math.round((p.winRate || 0) * 100)}% ROI${Math.round((p.realizedRoi || 0) * 100)}% 档案${String(p.checkedAt || "").slice(0, 10)} tags:${c.tags.join(",")}`,
    follow: (p.winRate || 0) >= BOOST_WINRATE ? "boost" : "watch", profit30dUsd: Math.round(p.realizedProfitUsd), winRate30d: p.winRate ?? null }); }
const ew = Object.values(read("early-watchlist.json")?.tokens || {}).sort((a, b) => Date.parse(b.firstSeenAt || 0) - Date.parse(a.firstSeenAt || 0));
let devs = 0; for (const t of ew) { if (devs >= DEV_CAP) break; if (add({ address: t.launcher, chain: "robinhood", label: `Dev:${t.symbol || t.name || "?"}`, category: "dev", source: "early-watchlist", note: `部署了 ${t.symbol} ${t.token}`, follow: "watch" })) devs++; }
const notes = [...out.values()];
fs.writeFileSync(`${D}/address-notes.json`, JSON.stringify({ schema: "address_notes_v1", updatedAt: now, thresholds: { MIN_PROFIT_USD, BOOST_WINRATE, MIN_WINRATE, ELITE_PROFIT_USD, TRACKED_CAP, DEV_CAP }, candidates: cand.size, notes }, null, 2));
const c = {}; notes.forEach(n => { const k = `${n.category}/${n.follow}`; c[k] = (c[k] || 0) + 1; }); console.log("total", notes.length, "tracked", tracked(), "candidates", cand.size, "qualified", ranked.length, c);
console.log(notes.filter(n => n.follow === "boost").sort((a, b) => b.profit30dUsd - a.profit30dUsd).slice(0, 5).map(n => `${n.label} ${n.chain} ${n.address} ${n.note.split(" tags")[0]}`).join("\n"));
