#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { gzip } from 'node:zlib';
import { readonlyMarket, GMGN_CHAINS } from '../src/gmgn-readonly-market.js';
import { createResearchTeamReport, renderResearchTeamBrief } from '../src/ai-research-team.js';
import { gmgnFlowAddress } from '../src/gmgn-flow-signal.js';
import { buildPaperFlowEvidence, buildPaperNarrativeEvidence, loadPaperEvidence } from '../src/paper-strategy-evidence.js';
import { createPaperStrategyRuntime } from '../src/paper-strategy-runtime.js';
import {createInternalDepthProbe} from '../src/paper-internal-depth.js';
import {createInnerTradeMonitor} from '../src/bsc-inner-trade-monitor.js';
import {loadPrivateBscRpcConfig,privateBscRpcEndpoints} from '../src/bsc-private-rpc.js';
import { createGmgnSocialMonitor } from '../src/gmgn-social-monitor.js';
import { createAlphaCatalogMonitor } from '../src/binance-alpha-catalog.js';
import { createSquareKeyStore } from '../src/square-key-store.js';
import { createSquareKeyRoute } from '../src/square-key-route.js';
import { createSquarePreview } from '../src/square-preview.js';
import { createWalletLearningMonitor } from '../src/wallet-learning-monitor.js';
import { loadPaperSession, loadEstimatedPaperSession, paperSessionLedgerFile } from '../src/paper-account-session.js';
import { loadPaperLossGuardPolicy } from '../src/paper-loss-guard.js';
import { ESTIMATED_COST_VERSION } from '../src/paper-estimated-cost.js';
import { createTwitterNarrativeMonitor } from '../src/twitter-narrative-monitor.js';
import { createEthGasMonitor } from '../src/paper-eth-gas.js';
import { createChainGasMonitor } from '../src/paper-chain-gas.js';
import { createJevResearchMonitor } from '../src/jev-research-pilot.js';

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DASHBOARD = path.join(PROJECT, 'dashboard');
const PAPER_DIR = process.env.PAPER_100_DATA_DIR || path.resolve(PROJECT, '..', 'robinhood-chain-monitor-paper-100');
const MIME = Object.freeze({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webp': 'image/webp' });
const compressSnapshot = promisify(gzip);
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

async function strategyJson(request, response, body) {
  const serialized = JSON.stringify(body);
  const gzipAccepted = String(request.headers['accept-encoding'] || '').split(',').some(item => {
    const [encoding, ...parameters] = item.trim().toLowerCase().split(';');
    return encoding === 'gzip' && !parameters.some(value => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(value));
  });
  response.setHeader('Vary', 'Accept-Encoding');
  if (!gzipAccepted || Buffer.byteLength(serialized) < 4096) {
    response.writeHead(200, { 'Content-Type': MIME['.json'] }); response.end(serialized); return;
  }
  // Preserve every CA and its evidence; compress repeated evidence rather than
  // dropping research from the one-second dashboard feed. Async compression
  // keeps the ledger/exit event loop available.
  const compressed = await compressSnapshot(serialized, { level: 1 });
  response.writeHead(200, { 'Content-Type': MIME['.json'], 'Content-Encoding': 'gzip', 'Content-Length': compressed.length });
  response.end(compressed);
}

async function researchTeamSnapshot({ market, chain, address } = {}) {
  const requestedChain = String(chain || 'robinhood').toLowerCase();
  let marketSnapshot;
  try {
    marketSnapshot = await market.trending({ chain: requestedChain, interval: '1m', limit: 20 });
  } catch {
    marketSnapshot = { status: 'unavailable', source: 'gmgn-cli', chain: requestedChain, tokens: [], observedAt: null };
  }
  const tokens = Array.isArray(marketSnapshot?.tokens) ? marketSnapshot.tokens : [];
  const normalizedAddress = gmgnFlowAddress(requestedChain, address);
  const token = (normalizedAddress
    ? tokens.find(item => gmgnFlowAddress(requestedChain, item?.address) === normalizedAddress)
    : address ? null : tokens[0]) || null;
  let candles = [];
  if (token?.address && typeof market.kline === 'function') {
    try {
      // Round the window to a minute so a market refresh and a team refresh
      // share the same read-only cache key instead of creating a new call on
      // every browser render.
      const to = Math.floor(Date.now() / 60_000) * 60;
      const kline = await market.kline({ chain: requestedChain, address: token.address, resolution: '1m', from: to - 60 * 60, to });
      candles = kline?.status === 'ok' && Array.isArray(kline?.candles) ? kline.candles : [];
    } catch { candles = []; }
  }
  const nowMs = Date.now();
  const evidence = await loadPaperEvidence(path.join(PROJECT, 'data'));
  const flow = token?.address ? buildPaperFlowEvidence({ state: evidence.flowState, chain: requestedChain, address: token.address, nowMs }) : {};
  const narrative = token?.address ? buildPaperNarrativeEvidence({ chain: requestedChain, address: token.address, token, events: evidence.events, nowMs }) : null;
  const report = createResearchTeamReport({
    chain: requestedChain,
    token: token || { address: address || null },
    candles,
    marketStatus: marketSnapshot?.status || 'unavailable',
    observedAt: marketSnapshot?.observedAt || null,
    narrative,
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

export function createDashboardServer({ host = '127.0.0.1', port = 4173, market = readonlyMarket, strategyRuntime = null, mainPaperSnapshot = null, squareKeyStore = createSquareKeyStore({ publicationReceiptFile: path.join(PROJECT, 'data', 'binance-square-test-20260922.json') }) } = {}) {
  const squareKeyRoute = createSquareKeyRoute(squareKeyStore);
  const server = http.createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store'); response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    try {
      const authority = new URL(`http://${request.headers.host || '127.0.0.1'}`);
      const url = new URL(request.url || '/', authority);
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(authority.hostname) || url.origin !== authority.origin) { json(response, { error: '仅允许本机访问' }, 403); return; }
      if (await squareKeyRoute(request, response, url)) return;
      if (url.pathname === '/api/square-preview') {
        if (request.method !== 'GET') { json(response, { error: '仅支持本地只读预览' }, 405); return; }
        if (url.search || (request.headers.origin && request.headers.origin !== url.origin) || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) { json(response, { error: '仅允许本机同源预览' }, 403); return; }
        json(response, createSquarePreview(strategyRuntime?.snapshot())); return;
      }
      if (url.pathname === '/api/strategy-state') {
        if (request.method !== 'GET') { json(response, { error: '只读接口' }, 405); return; }
        await strategyJson(request, response, strategyRuntime?.snapshot() || { status: 'loading', mode: 'paper', execution: false, signing: false, broadcast: false, account: null, strategies: [], lastError: '模拟引擎未启动' }); return;
      }
      if(url.pathname==='/api/main-paper-state'){
        if(request.method!=='GET'){json(response,{error:'原主盘只读'},405);return;}
        json(response,mainPaperSnapshot?await mainPaperSnapshot():strategyRuntime?.snapshot());return;
      }
      if (['/api/strategy-control', '/api/paper-cash-reset'].includes(url.pathname)) {
        if (request.method !== 'POST') { json(response, { error: '仅支持 POST' }, 405); return; }
        if ((request.headers.origin && request.headers.origin !== url.origin) || (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site']))) { json(response, { error: '不允许跨站修改' }, 403); return; }
        if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { json(response, { error: '需要 JSON 请求' }, 415); return; }
        if (!strategyRuntime) { json(response, { error: '模拟引擎未启动' }, 503); return; }
        let body = '', size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 1024) { json(response, { error: '请求过大' }, 413); return; } body += chunk; }
        let payload;
        try { payload = JSON.parse(body); } catch { json(response, { error: '无效 JSON' }, 400); return; }
        if (url.pathname === '/api/paper-cash-reset') {
          if (payload?.confirm !== 'reset_main_paper_cash_to_100_preserve_history'
            || typeof payload.operationId !== 'string' || !/^[a-z0-9_-]{8,80}$/.test(payload.operationId)
            || Object.keys(payload).some(key => !['confirm', 'operationId'].includes(key))) {
            json(response, { error: '需要明确确认主模拟盘补回 100 U 并保留历史' }, 400); return;
          }
          json(response, await strategyRuntime.resetCash(payload.operationId)); return;
        }
        if (typeof payload?.enabled !== 'boolean' || Object.keys(payload).some(key => key !== 'enabled')) { json(response, { error: '只接受 enabled 布尔值' }, 400); return; }
        try { json(response, await strategyRuntime.setEnabled(payload.enabled)); }
        catch(error) { if(!['PAPER_ORDER_FEES_UNAVAILABLE','PAPER_LOSS_GUARD_ACTIVE'].includes(error.code))throw error;json(response,{error:error.message,code:error.code},409); }
        return;
      }
      if (!['GET', 'HEAD'].includes(request.method)) { json(response, { error: '只读接口' }, 405); return; }
      if (url.pathname === '/api/paper-state') { json(response, await readPaperState()); return; }
      if (url.pathname === '/api/market') {
        const chain = (url.searchParams.get('chain') || 'robinhood').toLowerCase();
        const interval = (url.searchParams.get('interval') || '1m').toLowerCase();
        const limit = Number(url.searchParams.get('limit') || 20);
        try { json(response, await market.trending({ chain, interval, limit })); } catch { json(response, { status: 'unavailable', source: 'gmgn-cli', reason: 'invalid_request', tokens: [] }, 400); }
        return;
      }
      if (url.pathname === '/api/kline') {
        const chain = (url.searchParams.get('chain') || 'robinhood').toLowerCase();
        const address = url.searchParams.get('address') || '';
        const resolution = (url.searchParams.get('resolution') || '1m').toLowerCase();
        const now = Math.floor(Date.now() / 60_000) * 60;
        const hours = Math.min(24 * 7, Math.max(1, Number(url.searchParams.get('hours') || 6)));
        try { json(response, await market.kline({ chain, address, resolution, from: now - hours * 3600, to: now })); } catch { json(response, { status: 'unavailable', source: 'gmgn-cli', reason: 'invalid_request', candles: [] }, 400); }
        return;
      }
      if (url.pathname === '/api/research-team') {
        const chain = (url.searchParams.get('chain') || 'robinhood').toLowerCase();
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
  return { server, listen: () => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address())); }),
    close: () => new Promise(resolve => {
      // Browser requests may outlive their upstream fetch. Bound HTTP draining
      // only; shutdown still separately awaits strategy/learning ledger writes.
      const drainTimer = setTimeout(() => server.closeAllConnections(), 5000);
      drainTimer.unref?.();
      server.close(() => { clearTimeout(drainTimer); resolve(); });
    }) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const port = Number(process.env.DASHBOARD_PORT || 4173);
  const mainSession=await loadPaperSession(path.join(PROJECT,'data'));
  const session = await loadEstimatedPaperSession(path.join(PROJECT,'data')) || mainSession;
  const estimatedFeeMode=session?.costModel===ESTIMATED_COST_VERSION;
  if(estimatedFeeMode){
    if(!mainSession||session.legacy.file!==paperSessionLedgerFile(mainSession))throw Error('原主盘引用不一致，估算盘未启动');
    const raw=await fs.readFile(path.join(PROJECT,'data',session.legacy.file),'utf8'),main=JSON.parse(raw);
    if(createHash('sha256').update(raw).digest('hex')!==session.legacy.sha256||main.enabled!==false||Object.keys(main.account.positions).length)throw Error('原主盘快照已改变，估算盘未启动');
  }
  const learner = createWalletLearningMonitor({ dataDir: path.join(PROJECT, 'data'),
    researchContextLoader:()=>strategyRuntime.walletResearchContext(),researchChartLoader:query=>readonlyMarket.kline(query) });
  const socialMonitor=process.env.PAPER_GMGN_SOCIAL_MONITOR==='0'?null:createGmgnSocialMonitor({dataDir:path.join(PROJECT,'data')});
  const alphaMonitor=process.env.PAPER_ALPHA_MONITOR==='0'?null:createAlphaCatalogMonitor({dataDir:path.join(PROJECT,'data')});
  const twitterNarrativeMonitor=createTwitterNarrativeMonitor({dataDir:path.join(PROJECT,'data')});
  const chain = session?.chain || process.env.PAPER_STRATEGY_CHAIN || 'robinhood';
  const confirmedMode = process.env.PAPER_PVP_MODE !== '0' && process.env.PAPER_EXPLORATORY_ENTRIES !== '0';
  const chains = session?.chains || (process.env.PAPER_STRATEGY_CHAINS ? process.env.PAPER_STRATEGY_CHAINS.split(',').map(value => value.trim()) : [chain, ...GMGN_CHAINS.filter(value => value !== chain)]);
  const chainGasAccounting=!estimatedFeeMode && confirmedMode && process.env.PAPER_MULTI_SETUP_MODE !== '0' && process.env.PAPER_CONTINUOUS_MODE !== '0' && process.env.PAPER_MEME_EXIT_MODE !== '0';
  const gasMonitor = estimatedFeeMode?null:chainGasAccounting?createChainGasMonitor({chains}):createEthGasMonitor();
  const jevResearch = createJevResearchMonitor({ dataDir: path.join(PROJECT, 'data'), sessionId: session?.id || 'default' });
  const internalRpcEndpoints=privateBscRpcEndpoints(loadPrivateBscRpcConfig({dataDir:path.join(PROJECT,'data')}));
  const strategyRuntime = createPaperStrategyRuntime({ market: readonlyMarket, gasMonitor, jevResearch, chainGasAccounting,
    internalDepthProbe:estimatedFeeMode?createInternalDepthProbe({dataDir:path.join(PROJECT,'data'),rpcEndpoints:internalRpcEndpoints}):null,
    internalTradeMonitor:estimatedFeeMode?createInnerTradeMonitor({dataDir:path.join(PROJECT,'data'),rpcEndpoints:internalRpcEndpoints}):null,
    discoveryMode:'gmgn_three_lists_v1', enforceLossGuards:await loadPaperLossGuardPolicy(path.join(PROJECT,'data'),session),
    lossRepairMode:(estimatedFeeMode || chainGasAccounting) && process.env.PAPER_RECOVERY_MODE !== '0', dataDir: path.join(PROJECT, 'data'), session, chain, chains,
    twitterNarrativeSnapshot:twitterNarrativeMonitor.snapshot,
    allowExploratory: process.env.PAPER_EXPLORATORY_ENTRIES !== '0', compoundEntries: process.env.PAPER_COMPOUNDING !== '0',
    pvpMode: process.env.PAPER_PVP_MODE !== '0',
    // The unbounded v1 engineering probe is retired, including stale launch environments.
    diagnosticMode: false,
    confirmedMode, fixedEntryUsd: confirmedMode ? 10 : null, evidenceHoldMode: confirmedMode,
    tradeReviewEvery: 100,
    higherFrequencyResearch: confirmedMode && process.env.PAPER_MULTI_SETUP_MODE !== '0',
    minimalEntryMode: confirmedMode && process.env.PAPER_MINIMAL_ENTRY === '1',
    evidenceGapExitMode: process.env.PAPER_EVIDENCE_GAP_EXIT !== '0',
    memeExitMode: confirmedMode && process.env.PAPER_MULTI_SETUP_MODE !== '0' && process.env.PAPER_CONTINUOUS_MODE !== '0' && process.env.PAPER_MEME_EXIT_MODE !== '0',
    recoveryMode: confirmedMode && process.env.PAPER_MULTI_SETUP_MODE !== '0' && process.env.PAPER_CONTINUOUS_MODE !== '0' && process.env.PAPER_MEME_EXIT_MODE !== '0' && process.env.PAPER_RECOVERY_MODE !== '0',
    continuousPaperMode: confirmedMode && process.env.PAPER_CONTINUOUS_MODE !== '0',
    opportunityMode: confirmedMode && process.env.PAPER_MULTI_SETUP_MODE !== '0',
    thesisExitExperiment: !estimatedFeeMode && confirmedMode && process.env.PAPER_MULTI_SETUP_MODE !== '0' && process.env.PAPER_CONTINUOUS_MODE !== '0' && process.env.PAPER_EXIT_COMPARISON !== '0',
    activeEntrySampling: !estimatedFeeMode && confirmedMode && process.env.PAPER_MULTI_SETUP_MODE !== '0' && process.env.PAPER_CONTINUOUS_MODE !== '0' && process.env.PAPER_EXIT_COMPARISON !== '0' && process.env.PAPER_ACTIVE_ENTRY_SAMPLING !== '0',
    upsideMode: process.env.PAPER_PVP_MODE === '0' && process.env.PAPER_UPSIDE_MODE !== '0',
    learningLoader: estimatedFeeMode ? learner.tradingEvidence : learner.snapshot,
    learningReportSnapshot: estimatedFeeMode ? learner.snapshot : null });
  const mainPaperSnapshot=estimatedFeeMode?async()=>{
    const old=JSON.parse(await fs.readFile(path.join(PROJECT,'data',paperSessionLedgerFile(mainSession)),'utf8'));
    return {status:'retained_readonly',mode:'paper',execution:false,signing:false,broadcast:false,
      enabled:old.enabled,session:old.session,account:old.account,updatedAt:old.account.updatedAt,
      costModel:'原主盘只读保留；估算费用测试盘为独立账本，不合并成绩'};
  }:null;
  const app = createDashboardServer({ port, strategyRuntime,mainPaperSnapshot });
  app.listen().then(async address => {
    console.log(`yesp atm 模拟盘：http://${address.address}:${address.port}（仅模拟盘）`);
    try { await strategyRuntime.start(); await socialMonitor?.start(); await alphaMonitor?.start(); twitterNarrativeMonitor.start(); } catch (error) { console.error(`模拟引擎/消息发现启动失败：${error.message}`); }
    try { await learner.start(); } catch { console.error('钱包学习启动失败，原模拟引擎继续运行；请检查学习账本及锁'); }
  }).catch(error => { console.error(`dashboard failed: ${error.message}`); process.exitCode = 1; });
  let closing = false;
  const shutdown = async () => { if (closing) return; closing = true; await Promise.all([app.close(), strategyRuntime.stop(), learner.stop(),socialMonitor?.stop(),alphaMonitor?.stop(),twitterNarrativeMonitor.stop(),gasMonitor?.stop()]); await readonlyMarket.close(); };
  process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
}
