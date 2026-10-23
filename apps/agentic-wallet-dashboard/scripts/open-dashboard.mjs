import { readFile, lstat, open } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createLocalAccessDirectory, accessFile, privateDirectory } from '../server/local-access.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
async function current() {
  try {
    const st = await lstat(accessFile);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) return null;
    const state = JSON.parse(await readFile(accessFile, 'utf8'));
    if (state.product !== 'yesp-wallet' || !/^http:\/\/127\.0\.0\.1:\d+$/.test(state.origin) || !/^[a-f0-9]{64}$/.test(state.accessKey)) return null;
    const r = await fetch(`${state.origin}/api/status`, { signal: AbortSignal.timeout(1500) });
    if (!r.ok || (await r.json()).product !== 'yesp-wallet') return null;
    return state;
  } catch { return null; }
}
await createLocalAccessDirectory();
let state = await current();
if (!state) {
  const log = await open(new URL('server.log', privateDirectory), 'a', 0o600);
  const child = spawn(process.execPath, ['server/main.mjs'], { cwd: root, detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
  child.unref(); await log.close();
  for (let i = 0; i < 40 && !state; i++) { await new Promise(r => setTimeout(r, 250)); state = await current(); }
  if (!state) throw new Error('看板未启动。请在项目目录运行 npm start 查看错误；不会停止占用端口的其他程序。');
}
const url = `${state.origin}/#access=${state.accessKey}`;
const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32' : 'xdg-open';
const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
await new Promise((resolve, reject) => { const child = spawn(command, args, { shell: false, stdio: 'ignore' }); child.once('error', reject); child.once('close', code => code === 0 ? resolve() : reject(new Error('浏览器打开失败'))); });
console.log(`已打开 YESP Wallet：${state.origin}`);
