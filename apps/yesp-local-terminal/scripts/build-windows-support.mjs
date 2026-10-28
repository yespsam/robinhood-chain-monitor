import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const WINDOWS_SUPPORT = resolve(ROOT, '.generated/yesp-private-files.exe');
export async function compileWindowsSource(source, output, { execute = run } = {}) {
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  let compiler;
  for (const framework of ['Framework64', 'Framework']) {
    const candidate = join(systemRoot, 'Microsoft.NET', framework, 'v4.0.30319/csc.exe');
    try { await access(candidate); compiler = candidate; break; } catch { /* next supported location */ }
  }
  if (!compiler) throw Object.assign(new Error('Windows .NET Framework 4 compiler is required.'), { code: 'WINDOWS_COMPILER_MISSING' });
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${randomUUID()}`;
  const sourcePath = temporary + '.cs', executable = temporary + '.exe';
  try {
    await writeFile(sourcePath, source, { flag: 'wx', encoding: 'utf8' });
    await execute(compiler, ['/nologo', '/target:exe', '/optimize+', '/platform:anycpu', '/out:' + executable, sourcePath],
      { shell: false, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    await rename(executable, output);
  } finally {
    await rm(sourcePath, { force: true }); await rm(executable, { force: true });
  }
  return output;
}
export async function buildWindowsSupport() {
  if (process.platform !== 'win32') return null;
  return compileWindowsSource(await readFile(new URL('./windows/PrivateFiles.cs', import.meta.url), 'utf8'), WINDOWS_SUPPORT);
}
export async function buildWindowsLauncher({ nodePath, hostPath, extensionId, output }) {
  const literal = value => '@"' + value.replaceAll('"', '""') + '"';
  if (!/^[a-p]{32}$/.test(extensionId) || [nodePath, hostPath].some(p => !/^[A-Za-z]:[\\/]/.test(p) || /[\x00-\x1f]/.test(p)))
    throw new Error('Invalid Windows launcher identity or paths.');
  const source = (await readFile(new URL('./windows/NativeLauncher.cs', import.meta.url), 'utf8'))
    .replace('__NODE_PATH__', () => literal(nodePath)).replace('__HOST_PATH__', () => literal(hostPath))
    .replace('__ORIGIN__', () => literal(`chrome-extension://${extensionId}/`));
  return compileWindowsSource(source, output);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  buildWindowsSupport().then(path => { if (path) process.stdout.write('Windows private-file helper built.\n'); })
    .catch(e => { process.stderr.write((e.code || 'WINDOWS_BUILD_FAILED') + '\n'); process.exitCode = 1; });
}
