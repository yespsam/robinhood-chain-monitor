#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfirmedPaperSession, paperSessionLedgerFile } from '../src/paper-account-session.js';

const [flag, id, ...extra] = process.argv.slice(2);
if (flag !== '--create-confirmed-100' || !id || extra.length) throw new Error('用法：node scripts/create-confirmed-paper-session.js --create-confirmed-100 confirmed-pvp-v2-日期');
const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const session = await createConfirmedPaperSession({ dataDir, id });
console.log(JSON.stringify({ sessionId: session.id, label: session.label, ledger: paperSessionLedgerFile(session),
  legacy: session.legacy, note: '独立虚拟账户已选择；未修改旧账本，重复执行不会补款。请通过本机控制接口启动。' }, null, 2));
