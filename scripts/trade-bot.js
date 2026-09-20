#!/usr/bin/env node
import { mkdtemp, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runTradeBotDemo, readTradeBotReplayStatus } from '../src/trade-bot-replay.js';

const help = `交易机器人开发演练（离线，不连接钱包）
  npm run bot:replay -- [--scenario roundtrip|timeout] [--data-dir /absolute/new-directory]
  npm run bot:status -- --data-dir /absolute/existing-directory
未指定演练目录时创建隔离临时目录。没有实盘、导入私钥或自动签名开关。`;
async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help')) { console.log(help); return; }
  let mode, directory, scenario = 'roundtrip';
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (seen.has(key)) throw new Error('duplicate_option'); seen.add(key);
    if (key === '--demo' || key === '--status') {
      if (mode) throw new Error('conflicting_modes'); mode = key;
    } else if (key === '--data-dir' || key === '--scenario') {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error('missing_option_value');
      if (key === '--data-dir') directory = value; else scenario = value;
    } else throw new Error('unsupported_option');
  }
  if (!mode) throw new Error('explicit_mode_required');
  if (directory && !path.isAbsolute(directory)) throw new Error('absolute_data_directory_required');
  if (mode === '--status' && (!directory || seen.has('--scenario'))) throw new Error('status_requires_directory_only');
  if (mode === '--demo' && !directory) {
    const tempRoot = await realpath(os.tmpdir());
    directory = await mkdtemp(path.join(tempRoot, 'trade-bot-offline-'));
  }
  const result = mode === '--status' ? await readTradeBotReplayStatus(directory)
    : await runTradeBotDemo({ directory, scenario });
  console.log(JSON.stringify(result, null, 2));
}
main().catch(() => {
  // Do not echo arbitrary arguments, provider responses, keys or environment.
  console.error('操作未完成：检查参数、独立数据目录和故障锁。未执行真实交易。参见 docs/trade-bot-development.md。');
  process.exitCode = 1;
});
