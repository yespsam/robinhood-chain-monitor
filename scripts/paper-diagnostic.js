#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readonlyMarket } from '../src/gmgn-readonly-market.js';
import { createPaperDiagnosticRunner } from '../src/paper-diagnostic-runner.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deadline = Date.parse(process.argv[2] || '');
const targetFills = Number(process.argv[3] || 10);
if (!Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 600000) throw Error('需要未来十分钟内的明确截止时间');
if (![2, 10, 20].includes(targetFills)) throw Error('目标必须为 2、10 或 20 笔买卖成交；2 笔为一次 10U 虚拟买卖流程');
const lockPath = path.join(root, 'data', 'paper-diagnostic.lock');
const lock = await fs.open(lockPath, 'wx', 0o600);
const startedAt = new Date().toISOString();
const archive = path.join(root, 'data', `paper-diagnostic-${startedAt.replace(/[:.]/g, '-')}.json`);
const display = path.join(root, 'dashboard', 'paper-diagnostic-status.json');
const initialState = { schema: 'yesp_paper_diagnostic_v1', mode: 'paper_diagnostic', execution: false, signing: false, broadcast: false,
  status: 'running', entriesEnabled: true, startedAt, deadlineAt: new Date(deadline).toISOString(), initialCash: 100, cash: 100, realizedPnl: 0,
  targetFills, position: null, trades: [], issues: [],
  note: `${targetFills === 2 ? '一次 10U 虚拟买入、卖出流程测试。' : ''}独立 $100 虚拟诊断账户，不计入正式策略成绩。真实 GMGN 参考价格，非链上成交报价；费用、gas、滑点为模型假设。` };
async function persist(state) {
  const body = JSON.stringify(state, null, 2);
  for (const file of [archive, display]) { await fs.writeFile(`${file}.tmp`, body, { mode: 0o600 }); await fs.rename(`${file}.tmp`, file); }
}
async function snapshotNow() {
  const response = await fetch('http://127.0.0.1:4173/api/strategy-state', { signal: AbortSignal.timeout(6000) });
  if (!response.ok) throw Error('策略状态读取失败');
  const snapshot = await response.json();
  if (snapshot.mode !== 'paper' || snapshot.execution !== false || snapshot.signing !== false || snapshot.broadcast !== false) throw Error('仅允许读取模拟引擎候选');
  return snapshot;
}
let runner, stopped = false, fatal = false;
const stop = () => { stopped = true; void runner?.stopEntries().catch(() => { fatal = true; }); };
process.once('SIGTERM', stop); process.once('SIGINT', stop);
try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt, deadlineAt: initialState.deadlineAt }));
  const prior = await fs.readFile(display, 'utf8').then(JSON.parse).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
  if (prior?.position || prior?.status === 'running') throw Error('上轮诊断尚未收尾，禁止覆盖其持仓或运行状态');
  if (prior) await fs.copyFile(display, `${archive}.previous-display.json`, fs.constants.COPYFILE_EXCL);
  runner = createPaperDiagnosticRunner({ initialState, market: readonlyMarket, loadSnapshot: snapshotNow, persist });
  if (stopped) await runner.stopEntries(); else await runner.checkpoint();
  let nextEntry = 0, nextExit = 0, fills = 0;
  while (!runner.done() && !fatal) {
    await runner.checkpoint();
    const at = Date.now();
    if (at >= nextExit) { nextExit = at + 3000; void runner.exitOnce().catch(() => { fatal = true; stop(); }); }
    if (at >= nextEntry) { nextEntry = at + 5000; void runner.entryOnce().catch(() => { fatal = true; stop(); }); }
    const state = runner.snapshot();
    if (state.trades.length !== fills) {
      fills = state.trades.length;
      console.log(JSON.stringify({ fills, side: state.trades.at(-1)?.side, cash: state.cash, pnl: state.realizedPnl }));
    }
    await delay(1000);
  }
  await runner.idle();
  const state = runner.snapshot();
  if (state.status !== 'completed' || fatal) process.exitCode = 2;
  console.log(JSON.stringify({ status: state.status, fills: state.trades.length, cash: state.cash, realizedPnl: state.realizedPnl, archive,
    ...(fatal ? { error: '诊断账本保存失败，已停止；请检查持久化记录和遗留持仓' } : {}) }));
} finally { await lock.close(); await fs.unlink(lockPath); }
