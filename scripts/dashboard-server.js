#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readonlyMarket } from '../src/gmgn-readonly-market.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = path.join(PROJECT, 'dashboard');
const PAPER_DIR = process.env.PAPER_100_DATA_DIR || path.resolve(PROJECT, '..', 'robinhood-chain-monitor-paper-100');
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
      const file = safeFile(request.url || '/'); if (!file) { response.writeHead(400); response.end('bad request'); return; }
      const body = await fs.readFile(file); response.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }); response.end(body);
    } catch (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(error.code === 'ENOENT' ? 'not found' : 'dashboard error'); }
  });
  return { server, listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address())); }), close: () => new Promise(resolve => server.close(() => resolve())) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.DASHBOARD_PORT || 4173); const app = createDashboardServer({ port });
  app.listen().then(address => console.log(`GMGN-style paper terminal: http://${address.address}:${address.port} (simulation only)`)).catch(error => { console.error(`dashboard failed: ${error.message}`); process.exitCode = 1; });
}
