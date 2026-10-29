import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Denied } from './auth.mjs';
import { WalletGate, DEVELOPMENT } from './policy.mjs';
import { OfficialWallet, cliVersionInfo } from './official-cli.mjs';
import { demoSnapshot, demoQuote } from './fixtures.mjs';
import { reviewBlockers, validChain, estimateAssets } from './model.mjs';
import { LocalWalletAccess, LOCAL_CAPABILITIES } from './local-wallet.mjs';
import { safeDiagnostic } from './diagnostics.mjs';

const files = new Map([['/', ['index.html', 'text/html']], ['/app.js', ['app.js', 'text/javascript']],
  ['/favicon.svg', ['favicon.svg', 'image/svg+xml']],
  ['/wallet.js', ['wallet.js', 'text/javascript']],
  ['/auth-qr.js', ['auth-qr.js', 'text/javascript']],
  ['/session-recovery.js', ['session-recovery.js', 'text/javascript']],
  ['/vendor/qrcode.mjs', ['vendor/qrcode.mjs', 'text/javascript']],
  ['/vendor/qrcode_UTF8.mjs', ['vendor/qrcode_UTF8.mjs', 'text/javascript']],
  ['/connection-state.js', ['connection-state.js', 'text/javascript']],
  ['/official-error-catalog.js', ['official-error-catalog.js', 'text/javascript']],
  ['/style.css', ['style.css', 'text/css']], ['/research.json', ['research.json', 'application/json']],
  ['/mint.css', ['mint.css', 'text/css']],
  ['/official-checklist.txt', ['official-checklist.txt', 'text/plain']]]);
function json(res, status, value) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); }
async function readBody(req, maxBytes = 8192) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') throw new Denied('JSON_REQUIRED', 415);
  if (Number(req.headers['content-length']) > maxBytes) throw new Denied('BODY_TOO_LARGE', 413);
  let size = 0; const chunks = [];
  for await (const part of req) { size += part.length; if (size > maxBytes) throw new Denied('BODY_TOO_LARGE', 413); chunks.push(part); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString()); if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(); return value; }
  catch { throw new Denied('INVALID_JSON', 400); }
}
export async function createApplication({ sessions, wallet = new OfficialWallet(), binding = null, port = 0, localAccess = false, walletAccess = false, localAccessKey = null, manualTradeFactory = null, mintFactory = null, contractCallFactory = null } = {}) {
  if (localAccessKey !== null && !/^[a-f0-9]{64}$/.test(localAccessKey)) throw new Error('INVALID_LOCAL_ACCESS_KEY');
  if (localAccess && (binding !== null || Object.values(DEVELOPMENT).some(Boolean))) throw new Error('LOCAL_ACCESS_REQUIRES_DEMO_ONLY');
  const gate = new WalletGate({ sessions, wallet, binding });
  const localWallet = localAccess && walletAccess ? new LocalWalletAccess(wallet) : null;
  if (manualTradeFactory && (!localWallet || !localAccessKey)) throw new Error('MANUAL_TRADES_REQUIRE_LOCAL_ACCESS_KEY');
  if (mintFactory && (!localWallet || !localAccessKey)) throw new Error('MINTING_REQUIRES_LOCAL_ACCESS_KEY');
  if (contractCallFactory && (!localWallet || !localAccessKey)) throw new Error('CONTRACT_CALLS_REQUIRE_LOCAL_ACCESS_KEY');
  const manualTrades = manualTradeFactory ? manualTradeFactory({ wallet, gate: localWallet.gate }) : null;
  const mints = mintFactory ? mintFactory({ wallet, gate: localWallet.gate }) : null;
  const contractCalls = contractCallFactory ? contractCallFactory({ wallet, gate: localWallet.gate }) : null;
  if (localWallet) localWallet.tradeService = manualTrades;
  if (localWallet) localWallet.mintService = mints;
  if (localWallet) localWallet.contractCallService = contractCalls;
  const cli = await cliVersionInfo();
  let origin, cookieName;
  const streams = new Map();
  sessions.onInvalidate(key => {
    const records = streams.get(key); streams.delete(key);
    for (const record of records || []) { record.intentional = true; record.res.end('event: locked\ndata: {}\n\n'); }
  });
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (!origin || req.headers.host !== new URL(origin).host) throw new Denied('HOST_REJECTED');
      if (req.headers.origin && req.headers.origin !== origin) throw new Denied('ORIGIN_REJECTED');
      if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw new Denied('ORIGIN_REJECTED');
      if (!['GET', 'POST'].includes(req.method)) throw new Denied('METHOD_REJECTED', 405);
      if (req.method === 'POST' && req.headers.origin !== origin) throw new Denied('ORIGIN_REQUIRED');
      const url = new URL(req.url, origin); if (url.search) throw new Denied('QUERY_FIELDS_REJECTED', 400);
      const cookie = (req.headers.cookie || '').split(';').map(x => x.trim()).filter(x => x.startsWith(cookieName + '='));
      const token = cookie.length === 1 ? cookie[0].slice(cookieName.length + 1) : '';
      if (req.method === 'GET' && files.has(url.pathname)) {
        const [file, type] = files.get(url.pathname); const data = await readFile(new URL('../public/' + file, import.meta.url));
        res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); res.end(data); return;
      }
      if (url.pathname === '/api/status' && req.method === 'GET') {
        if (localAccess) {
          json(res, 200, { product: 'yesp-wallet', version: '0.4.0', localAccessRequired: localAccessKey !== null, accessMode: 'local', loginRequired: false, authenticated: false, identityVerified: false,
            walletConnected: false, mode: localWallet ? 'wallet-read-quote' : 'development', capabilities: localWallet ? { ...LOCAL_CAPABILITIES, manualTrades: !!manualTrades, liveTrades: !!manualTrades, tokenMinting: !!mints, customContractCalls: !!contractCalls } : DEVELOPMENT, cli }); return;
        }
        let state = { authenticated: false }; try {
          const current = sessions.fromToken(token); sessions.checkCsrf(current, req.headers['x-csrf-token']);
          state = sessions.publicState(current);
        } catch { /* Cookie alone cannot recover the in-memory session proof. */ }
        json(res, 200, { ...state, configured: sessions.configured, walletConnected: false, mode: 'development', capabilities: DEVELOPMENT }); return;
      }
      // Production bootstrap requires a launch capability stored in an owner-only local file.
      // This capability is never a Binance credential and never appears in an HTTP URL.
      if (localAccess && url.pathname.startsWith('/api/')) {
        if (url.pathname === '/api/local/session' && localAccessKey !== null) {
          const candidate = req.headers['x-local-access'];
          if (typeof candidate !== 'string' || !/^[a-f0-9]{64}$/.test(candidate)
            || !timingSafeEqual(Buffer.from(candidate), Buffer.from(localAccessKey))) throw new Denied('LOCAL_ACCESS_REQUIRED', 401);
        }
        if (url.pathname === '/api/demo' && req.method === 'GET') { json(res, 200, demoSnapshot()); return; }
        if (url.pathname === '/api/demo/quote' && req.method === 'POST') {
          const quote = demoQuote(await readBody(req)); json(res, 200, { ...quote, blockers: reviewBlockers(quote) }); return;
        }
        if (localWallet && req.method === 'POST') {
          const key = req.headers['x-local-session'], body = await readBody(req, url.pathname.startsWith('/api/contract-call/') ? 65_536 : 8192);
          const tradeMethod = new Map([['/api/trade/preview', 'preview'], ['/api/trade/submit', 'submit'], ['/api/trade/status', 'status'], ['/api/trade/list', 'list']]).get(url.pathname);
          if (manualTrades && tradeMethod) {
            localWallet.check(key); localWallet.touch(key);
            json(res, 200, await manualTrades[tradeMethod](key, body)); return;
          }
          const mintMethod = new Map([['/api/mint/preview', 'preview'], ['/api/mint/submit', 'submit'], ['/api/mint/status', 'status'], ['/api/mint/list', 'list']]).get(url.pathname);
          if (mints && mintMethod) {
            localWallet.check(key); localWallet.touch(key);
            json(res, 200, await mints[mintMethod](key, body)); return;
          }
          const contractCallMethod = new Map([['/api/contract-call/preview', 'preview'], ['/api/contract-call/submit', 'submit'],
            ['/api/contract-call/status', 'status'], ['/api/contract-call/list', 'list']]).get(url.pathname);
          if (contractCalls && contractCallMethod) {
            localWallet.check(key); localWallet.touch(key);
            json(res, 200, await contractCalls[contractCallMethod](key, body)); return;
          }
          json(res, 200, await localWallet.handle(url.pathname, key, body, { reuseSession: localAccessKey !== null })); return;
        }
        throw new Denied('LOCAL_ACCESS_DEMO_ONLY');
      }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        const body = await readBody(req);
        if (Object.keys(body).some(k => !['username', 'password'].includes(k))) throw new Denied('INVALID_LOGIN', 400);
        const login = await sessions.login(body.username, body.password); body.password = '';
        res.setHeader('Set-Cookie', `${cookieName}=${login.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
        json(res, 200, sessions.publicState(login.session)); return;
      }
      if (!url.pathname.startsWith('/api/')) throw new Denied('NOT_FOUND', 404);
      const session = sessions.fromToken(token);
      // Require the proof held only in this tab's memory for reads AND writes.
      // Host cookies are shared across ports; a cookie alone must not regain authorization.
      sessions.checkCsrf(session, req.headers['x-csrf-token']);
      if (url.pathname === '/api/events' && req.method === 'GET') {
        const record = { res, intentional: false };
        if (!streams.has(session.key)) streams.set(session.key, new Set()); streams.get(session.key).add(record);
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive' }); res.write('event: ready\ndata: {}\n\n');
        req.on('close', () => { streams.get(session.key)?.delete(record); if (!record.intentional) {
          try { sessions.byKey(session.key); sessions.invalidateAll('SESSION_CHANNEL_CLOSED'); } catch { /* already invalid */ }
        } }); return;
      }
      if (url.pathname === '/api/demo' && req.method === 'GET') { json(res, 200, demoSnapshot()); return; }
      if (req.method !== 'POST') throw new Denied('NOT_FOUND', 404);
      const body = await readBody(req); sessions.byKey(session.key);
      if (['/api/logout', '/api/lock'].includes(url.pathname)) {
        sessions.invalidateAll('DASHBOARD_LOCKED'); res.setHeader('Set-Cookie', `${cookieName}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
        json(res, 200, { locked: true, walletSignedOut: false, tokenApprovalsRevoked: false, remoteStrategyStopped: false }); return;
      }
      if (url.pathname === '/api/session/touch') { sessions.touch(session.key); json(res, 200, sessions.publicState(session)); return; }
      if (url.pathname === '/api/demo/quote') { const q = demoQuote(body); json(res, 200, { ...q, blockers: reviewBlockers(q) }); return; }
      // All actual authorization changes and financial writes are blocked BEFORE calling the vendor CLI.
      if (['/api/wallet/signin', '/api/wallet/verify', '/api/wallet/signout', '/api/trade/submit', '/api/limit/submit',
        '/api/limit/cancel', '/api/approval/revoke', '/api/trade/enable', '/api/mint/submit', '/api/strategy/start', '/api/strategy/stop'].includes(url.pathname)) gate.rejectWrite(session.key);
      if (url.pathname === '/api/wallet/read') {
        if (Object.keys(body).some(k => !['chainId', 'contract', 'kind'].includes(k))) throw new Denied('CLIENT_WALLET_REJECTED', 400);
        const chain = validChain(body.chainId);
        const data = await gate.read(session.key, chain, async bound => {
          if (body.kind === 'assets') return { ...bound, ...estimateAssets(await wallet.balance(chain, body.contract)), source: 'Binance CLI', totalComplete: false,
            coverage: 'CLI hides tokens valued below USD 0.01; missing data does not imply zero balance' };
          if (body.kind === 'transactions') return wallet.transactions(chain);
          if (body.kind === 'pending') return wallet.transactions(chain, 'pending');
          if (body.kind === 'orders') return wallet.orders(chain, 'limit');
          if (body.kind === 'marketOrders') return wallet.orders(chain, 'market');
          if (body.kind === 'approvals') return wallet.approvals(chain);
          throw new Denied('INVALID_READ_KIND', 400);
        }); json(res, 200, data); return;
      }
      if (url.pathname === '/api/wallet/quote') {
        if (Object.keys(body).some(k => !['chainId', 'fromToken', 'toToken', 'amount', 'slippage'].includes(k))) throw new Denied('CLIENT_WALLET_REJECTED', 400);
        const quote = await gate.read(session.key, validChain(body.chainId), async bound => ({ ...await wallet.quote(body), wallet: bound.walletAddress }));
        json(res, 200, { ...quote, blockers: reviewBlockers(quote) }); return;
      }
      throw new Denied('NOT_FOUND', 404);
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      // Never expose stderr, CLI raw JSON, cookies, passwords, or session-file contents.
      json(res, error instanceof Denied ? error.status : 500, { error: error instanceof Denied ? error.code : 'INTERNAL_ERROR', diagnostic: safeDiagnostic(error) });
    }
  });
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  origin = `http://127.0.0.1:${server.address().port}`; cookieName = `aw_dashboard_${server.address().port}`;
  const timer = setInterval(() => { for (const key of sessions.items.keys()) {
    try { sessions.byKey(key); for (const stream of streams.get(key) || []) stream.res.write(': heartbeat\n\n'); } catch { /* expired */ }
  } }, 1000); timer.unref();
  return { origin, sessions, gate, server, localWallet, manualTrades, mints, contractCalls, async close() { clearInterval(timer); localWallet?.lock(); sessions.invalidateAll('SERVER_STOPPED'); server.closeAllConnections(); await new Promise(r => server.close(r)); } };
}
