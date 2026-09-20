#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readonlyMarket } from '../src/gmgn-readonly-market.js';
import { createResearchTeamReport, renderResearchTeamBrief } from '../src/ai-research-team.js';
import { qualifiesGmgnFlowWallet } from '../src/gmgn-flow-signal.js';
import { resolveGmgnFlowNarrative } from '../src/gmgn-flow-narrative.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = path.join(PROJECT, 'dashboard');
const PAPER_DIR = process.env.PAPER_100_DATA_DIR || path.resolve(PROJECT, '..', 'robinhood-chain-monitor-paper-100');
const FLOW_STATE_FILE = path.join(PROJECT, 'data', 'gmgn-flow-state.json');
const FOMO_OUTBOX_FILE = path.join(PROJECT, 'data', 'fomo-alerts', 'alert-outbox.json');
const MIME = Object.freeze({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8' });
const safeFile = requestPath => {
  const decoded = decodeURIComponent(requestPath.split('?')[0]);
  const relative = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const file = path.resolve(DASHBOARD, relative);
  if (file !== DASHBOARD && !file.startsWith(`${DASHBOARD}${path.sep}`)) return null;
  return file;
};

async function readPaperState() {
  try {
    const file = path.join(PAPER_DIR, 'paper-100-state.json'); const raw = JSON.parse(await fs.readFile(file, 'utf8')); const account = raw?.account;
    return { status: 'ok', mode: account?.mode || 'paper', execution: account?.executable === true, updatedAt: raw?.updatedAt || null,
      account: account ? { cashUsdMicros: account.cashUsdMicros, realizedPnlUsdMicros: account.realizedPnlUsdMicros, positions: Object.keys(account.positions || {}).length } : null };
  } catch { return { status: 'local_only', mode: 'paper', execution: false, account: null }; }
}

function json(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': MIME['.json'] });
  response.end(JSON.stringify(body));
}

async function readJsonFile(file, maximumBytes) {
  try {
    const stat = await fs.stat(file);
    if (!Number.isFinite(stat.size) || stat.size > maximumBytes) return null;
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch { return null; }
}

async function readFlowEvidence({ chain, address, nowMs = Date.now() } = {}) {
  const state = await readJsonFile(FLOW_STATE_FILE, 24 * 1024 * 1024);
  const chainState = state?.chains?.[chain];
  const stateAt = Date.parse(chainState?.lastSuccessAt || state?.updatedAt || '');
  const fresh = Number.isFinite(stateAt) && nowMs - stateAt <= 2 * 60_000 && chainState?.status === 'healthy';
  const rows = Array.isArray(state?.trades?.[chain])
    ? state.trades[chain].filter(row => String(row?.tokenAddress || '').toLowerCase() === String(address || '').toLowerCase()
      && Number.isFinite(Number(row?.at)) && Number(row.at) >= nowMs - 5 * 60_000 && row.side === 'buy')
    : [];
  const wallets = new Map();
  for (const row of rows) {
    const wallet = String(row.wallet || '').toLowerCase();
    if (!wallet) continue;
    const item = wallets.get(wallet) || { wallet, buyUsd: 0, tags: new Set() };
    item.buyUsd += Number(row.amountUsd) || 0;
    for (const tag of Array.isArray(row.tags) ? row.tags : []) item.tags.add(String(tag).toLowerCase());
    wallets.set(wallet, item);
  }
  const buyers = [...wallets.values()].filter(item => item.buyUsd >= 100);
  const highProfitCount = fresh ? buyers.filter(item => qualifiesGmgnFlowWallet(state?.profiles?.[`${chain}:${item.wallet}`], chain, item.wallet, nowMs)).length : null;
  const fomoCount = fresh ? buyers.filter(item => item.tags.has('fomo')).length : null;
  const uniqueBuyerCount = fresh ? buyers.length : null;
  const netBuyUsd = fresh ? buyers.reduce((sum, item) => sum + item.buyUsd, 0) : null;
  return {
    fresh, observedAt: Number.isFinite(stateAt) ? new Date(stateAt).toISOString() : null,
    highProfitCount, fomoCount, uniqueBuyerCount, netBuyUsd,
    status: chainState?.status || 'unavailable', coverageGap: chainState?.coverageGap || null,
  };
}

async function readNarrativeEvidence({ chain, address, token, nowMs = Date.now() } = {}) {
  const outbox = await readJsonFile(FOMO_OUTBOX_FILE, 8 * 1024 * 1024);
  const events = Object.values(outbox?.events || {}).slice(-1000);
  return resolveGmgnFlowNarrative({ chain, tokenAddress: address, tokenInfo: token, events, nowMs });
}

async function researchTeamSnapshot({ market, chain, address } = {}) {
  const requestedChain = String(chain || 'bsc').toLowerCase();
  let marketSnapshot;
  try {
    marketSnapshot = await market.trending({ chain: requestedChain, interval: '1m', limit: 20 });
  } catch {
    marketSnapshot = { status: 'unavailable', source: 'gmgn-cli', chain: requestedChain, tokens: [], observedAt: null };
  }
  const tokens = Array.isArray(marketSnapshot?.tokens) ? marketSnapshot.tokens : [];
  const normalizedAddress = String(address || '').toLowerCase();
  const token = (normalizedAddress
    ? tokens.find(item => String(item?.address || '').toLowerCase() === normalizedAddress)
    : tokens[0]) || null;
  let candles = [];
  if (token?.address && typeof market.kline === 'function') {
    try {
      // Round the window to a minute so a market refresh and a team refresh
      // share the same read-only cache key instead of creating a new call on
      // every browser render.
      const to = Math.floor(Date.now() / 60_000) * 60;
      const kline = await market.kline({ chain: requestedChain, address: token.address, resolution: '1m', from: to - 60 * 60, to });
      candles = Array.isArray(kline?.candles) ? kline.candles : [];
    } catch { candles = []; }
  }
  const nowMs = Date.now();
  const flow = token?.address ? await readFlowEvidence({ chain: requestedChain, address: token.address, nowMs }) : {};
  const narrative = token?.address ? await readNarrativeEvidence({ chain: requestedChain, address: token.address, token, nowMs }) : null;
  const report = createResearchTeamReport({
    chain: requestedChain,
    token: token || { address: address || null },
    candles,
    marketStatus: marketSnapshot?.status || 'unavailable',
    observedAt: marketSnapshot?.observedAt || null,
    // Narrative sources are deliberately not guessed from ticker/name.  A
    // future source adapter can pass a CA-bound evidence object here.
    narrative: narrative || marketSnapshot?.narrative || null,
    flow,
    nowMs,
  });
  return {
    status: marketSnapshot?.status || 'unavailable',
    source: 'gmgn-cli',
    chain: requestedChain,
    observedAt: marketSnapshot?.observedAt || null,
    token,
    report,
    brief: renderResearchTeamBrief(report),
  };
}

export function createDashboardServer({ host = '127.0.0.1', port = 4173, market = readonlyMarket } = {}) {
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      const url = new URL(request.url || '/', `http://${request.headers.host || '127.0.0.1'}`);
      if (url.pathname === '/api/paper-state') { json(response, await readPaperState()); return; }
      if (url.pathname === '/api/market') {
        const chain = (url.searchParams.get('chain') || 'bsc').toLowerCase();
        const interval = (url.searchParams.get('interval') || '1m').toLowerCase();
        const limit = Number(url.searchParams.get('limit') || 20);
        try { json(response, await market.trending({ chain, interval, limit })); } catch { json(response, { status: 'unavailable', source: 'gmgn-cli', reason: 'invalid_request', tokens: [] }, 400); }
        return;
      }
      if (url.pathname === '/api/kline') {
        const chain = (url.searchParams.get('chain') || 'bsc').toLowerCase();
        const address = url.searchParams.get('address') || '';
        const resolution = (url.searchParams.get('resolution') || '1m').toLowerCase();
        const now = Math.floor(Date.now() / 1000);
        const hours = Math.min(24 * 7, Math.max(1, Number(url.searchParams.get('hours') || 6)));
        try { json(response, await market.kline({ chain, address, resolution, from: now - hours * 3600, to: now })); } catch { json(response, { status: 'unavailable', source: 'gmgn-cli', reason: 'invalid_request', candles: [] }, 400); }
        return;
      }
      if (url.pathname === '/api/research-team') {
        const chain = (url.searchParams.get('chain') || 'bsc').toLowerCase();
        const address = url.searchParams.get('address') || '';
        try {
          json(response, await researchTeamSnapshot({ market, chain, address }));
        } catch {
          json(response, { status: 'unavailable', source: 'gmgn-cli', chain, token: null, report: null, brief: '投研团队：真实数据暂不可用' }, 400);
        }
        return;
      }
      const file = safeFile(request.url || '/'); if (!file) { response.writeHead(400); response.end('bad request'); return; }
      const body = await fs.readFile(file); response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); response.end(body);
    } catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(error.code === 'ENOENT' ? 'not found' : 'dashboard error'); }
  });
  return { server, listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address())); }), close: () => new Promise(resolve => server.close(() => resolve())) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.DASHBOARD_PORT || 4173); const app = createDashboardServer({ port });
  app.listen().then(address => console.log(`yesp atm 模拟盘：http://${address.address}:${address.port}（仅模拟盘）`)).catch(error => { console.error(`dashboard failed: ${error.message}`); process.exitCode = 1; });
}
