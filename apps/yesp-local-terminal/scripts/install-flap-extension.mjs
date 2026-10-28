import { chmod, lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HOST_NAME, loadExtensionIdentity } from './flap-native-host.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildWindowsLauncher, buildWindowsSupport } from './build-windows-support.mjs';
import { secureDirectory, windowsFiles } from '../server/platform-files.mjs';
const run = promisify(execFile);
export const WINDOWS_REGISTRY_KEY = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${HOST_NAME}`;

export async function registerWindowsHost(manifestPath, { execute = run,
  verify = path => windowsFiles('verify-host', path),
  registryTool = resolve(process.env.SystemRoot || 'C:\\Windows', 'System32/reg.exe') } = {}) {
  for (const view of ['32', '64']) {
    const options = { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 65536 };
    await execute(registryTool, ['add', WINDOWS_REGISTRY_KEY, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f', `/reg:${view}`], options);
  }
  // Read Unicode registry values with .NET, not localized reg.exe output bytes.
  await verify(manifestPath);
}

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function launcherSource(nodePath, hostPath) {
  if (![nodePath, hostPath].every(p => typeof p === 'string' && isAbsolute(p) && !/[\0\r\n]/.test(p)))
    throw new Error('Launcher paths must be absolute single-line paths.');
  return `#!/bin/sh\n# Generated locally; no extension input is evaluated by a shell.\nexec ${quote(nodePath)} ${quote(hostPath)} "$@"\n`;
}

async function safeExistingFile(path) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid()))
      throw new Error('Refusing to overwrite an unsafe installation file.');
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

async function atomicWrite(path, source, mode) {
  await safeExistingFile(path);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, source, { mode, flag: 'wx' });
  await chmod(temporary, mode); await rename(temporary, path);
}

export async function installExtension({ dryRun = false, root = ROOT, home = homedir(), platform = process.platform, nodePath = process.execPath,
  registerWindows = registerWindowsHost, buildSupport = buildWindowsSupport, buildLauncher = buildWindowsLauncher } = {}) {
  if (!['darwin', 'win32'].includes(platform)) throw new Error('This installer supports Google Chrome on Windows and macOS.');
  const { extensionId } = await loadExtensionIdentity(root);
  const extensionDirectory = resolve(root, 'extension');
  const executable = await realpath(nodePath);
  const hostPath = await realpath(resolve(root, 'scripts/flap-native-host.mjs'));
  await safeExistingFile(hostPath);
  const launcher = platform === 'win32' ? resolve(root, '.generated/native-host/flap-native-host.exe') : resolve(root, 'scripts/flap-native-host.command');
  const manifestPath = platform === 'win32' ? resolve(root, '.generated/native-host', `${HOST_NAME}.json`)
    : resolve(home, 'Library/Application Support/Google/Chrome/NativeMessagingHosts', `${HOST_NAME}.json`);
  const manifest = { name: HOST_NAME, description: 'YESP local Flap wallet bridge', path: launcher, type: 'stdio',
    allowed_origins: [`chrome-extension://${extensionId}/`] };
  if (!dryRun) {
    const hostDirectory = dirname(manifestPath);
    await mkdir(hostDirectory, { recursive: true, mode: 0o700 });
    const st = await lstat(hostDirectory);
    if (!st.isDirectory() || st.isSymbolicLink() || (process.getuid && st.uid !== process.getuid()))
      throw new Error('Native Messaging directory must belong to this user.');
    if (platform === 'win32') {
      await buildSupport();
      await secureDirectory(hostDirectory);
      await secureDirectory(resolve(root, '.private'));
      await buildLauncher({ nodePath: executable, hostPath, extensionId, output: launcher });
    } else await atomicWrite(launcher, launcherSource(executable, hostPath), 0o700);
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
    const installed = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (installed.path !== launcher || installed.allowed_origins?.[0] !== `chrome-extension://${extensionId}/`)
      throw new Error('Native host installation could not be verified.');
    if (platform === 'win32') await registerWindows(manifestPath);
  }
  return { dryRun, installed: !dryRun, platform, extensionId, extensionDirectory, hostName: HOST_NAME, nativeManifest: manifestPath,
    ...(platform === 'win32' ? { registryKey: WINDOWS_REGISTRY_KEY, launcher } : {}),
    nextStep: 'Chrome → chrome://extensions → Developer mode → Load unpacked → select extensionDirectory. No wallet action has been submitted.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--dry-run') || args.length > 1) {
    process.stderr.write('Usage: node scripts/install-flap-extension.mjs [--dry-run]\n'); process.exitCode = 1;
  } else installExtension({ dryRun: args.includes('--dry-run') }).then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(e => { const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code || '') ? e.code : 'INSTALL_FAILED';
      process.stderr.write(`Chrome bridge installation failed (${code}); check Node, .NET Framework, local NTFS path and permissions.\n`); process.exitCode = 1; });
}
