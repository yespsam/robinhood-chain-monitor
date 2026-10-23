import { mkdir, writeFile } from 'node:fs/promises';
import { hashPassword } from './auth.mjs';

// Invoked by setup.ps1 with hidden input via stdin, never command-line arguments or env vars.
let input = '';
for await (const chunk of process.stdin) {
  input += chunk;
  if (input.length > 4096) { console.error('输入过长。'); process.exit(1); }
}
try {
  const parsed = JSON.parse(input);
  const owner = await hashPassword(parsed.password);
  parsed.password = ''; input = '';
  const directory = new URL('../.private/', import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(new URL('owner.json', directory), JSON.stringify(owner), { flag: 'wx', mode: 0o600 });
  console.log('独立看板登录已配置，用户名 owner。未连接 Binance，未修改任何账户权限。');
} catch (error) {
  console.error(error.code === 'EEXIST' ? '登录已配置；未覆盖。重置前请停止服务并按 README 操作。' : '设置失败：密码须为 16–256 字符，且输入格式正确。');
  process.exitCode = 1;
}
