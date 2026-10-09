import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEstimatedPaperSession } from '../src/paper-account-session.js';
import { readTypesafeKey } from '../src/typesafe-local-key.js';
import { createJevResearchPilot } from '../src/jev-research-pilot.js';

const dataDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../data');
const session = await loadEstimatedPaperSession(dataDir);
if (!session || !await readTypesafeKey()) throw Error('需要现有独立模拟盘和已保存的 Jev 密钥');
const overnight = process.argv.includes('--overnight');
const state = await createJevResearchPilot({ dataDir, sessionId: session.id, ...(overnight ? { durationMs: 8 * 3600000 } : {}) });
console.log(JSON.stringify({ status: 'created', sessionId: state.sessionId, maxCalls: state.maxCalls,
  durationMs: state.durationMs, expiresAt: new Date(state.expiresAt).toISOString(), researchOnly: true, canExecute: false }));
