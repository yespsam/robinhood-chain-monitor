#!/usr/bin/env node
// One explicit, paper-only cleanup. Never extends the original timed target.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readonlyMarket } from '../src/gmgn-readonly-market.js';
import { diagnosticSell } from '../src/paper-diagnostic.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const archive = path.resolve(process.argv[2] || '');
if (path.dirname(archive) !== path.join(root, 'data') || !/^paper-diagnostic-[0-9TZ.-]+\.json$/.test(path.basename(archive))) throw Error('必须指定 data 中的精确诊断账本');
if (!(await fs.lstat(archive)).isFile()) throw Error('账本必须为普通文件');
const lockPath = path.join(root, 'data', 'paper-diagnostic.lock');
const lock = await fs.open(lockPath, 'wx', 0o600);
try {
  await lock.writeFile(JSON.stringify({ pid: process.pid, purpose: 'late_paper_settlement' }));
  const display = path.join(root, 'dashboard', 'paper-diagnostic-status.json');
  const state = JSON.parse(await fs.readFile(archive, 'utf8'));
  const visible = JSON.parse(await fs.readFile(display, 'utf8'));
  if (state.schema !== 'yesp_paper_diagnostic_v1' || state.status !== 'incomplete_open_position' || !state.position
    || state.startedAt !== visible.startedAt || Date.parse(state.deadlineAt) > Date.now()) throw Error('该轮不符合截止后收尾条件');
  const quote = await readonlyMarket.quote({ ...state.position, purpose: 'exit' });
  diagnosticSell(state, quote, Date.now(), { settleAfterDeadline: true });
  state.timedFillCount = state.trades.filter(t => Date.parse(t.at) < Date.parse(state.deadlineAt)).length;
  state.settlementFills = state.trades.filter(t => t.lateSettlement === true).length;
  state.status = 'incomplete'; state.settledAt = new Date().toISOString(); state.updatedAt = state.settledAt;
  state.issues.push({ at: state.settledAt, text: `已用新的真实报价退出遗留仓位；限时内 ${state.timedFillCount}/${state.targetFills} 笔，截止后 ${state.settlementFills} 笔另记，未达成限时目标。` });
  for (const file of [archive, display]) {
    await fs.writeFile(`${file}.tmp`, JSON.stringify(state, null, 2), { mode: 0o600 });
    await fs.rename(`${file}.tmp`, file);
  }
  console.log(JSON.stringify({ status: state.status, timedFills: state.timedFillCount, settlementFills: state.settlementFills,
    position: state.position, cash: state.cash, pnl: state.realizedPnl, settledAt: state.settledAt, archive }));
} finally { await lock.close(); await fs.unlink(lockPath); }
