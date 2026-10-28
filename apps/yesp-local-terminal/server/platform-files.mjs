import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { chmod, lstat, mkdir, open, rename } from 'node:fs/promises';
import { constants } from 'node:fs';
import { resolve } from 'node:path';
import { WINDOWS_SUPPORT } from '../scripts/build-windows-support.mjs';
const run = promisify(execFile);
export const WINDOWS = process.platform === 'win32';
const fail = code => Object.assign(new Error(code), { code });
const sameOwner = stat => !process.getuid || stat.uid === process.getuid();
export async function windowsFiles(command, ...paths) {
  try { await run(WINDOWS_SUPPORT, [command, ...paths], { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 65536 }); }
  catch (e) {
    if (e.code === 'ENOENT') throw fail('WINDOWS_HELPER_MISSING');
    const code = String(e.stderr || '').trim();
    throw fail(/^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : 'WINDOWS_FILE_ACCESS_FAILED');
  }
}
export async function secureDirectory(directory) {
  if (WINDOWS) await windowsFiles('check-path', resolve(directory));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameOwner(stat)) throw fail('JOURNAL_UNSAFE');
  if (WINDOWS) await windowsFiles('secure-directory', resolve(directory));
  else await chmod(directory, 0o700);
}
export async function checkPrivateFile(path, handle) {
  const stat = await handle.stat(), named = await lstat(path);
  if (!stat.isFile() || stat.nlink !== 1 || !sameOwner(stat) || named.isSymbolicLink() ||
      named.dev !== stat.dev || named.ino !== stat.ino || !WINDOWS && (stat.mode & 0o077)) throw fail('JOURNAL_UNSAFE');
  if (WINDOWS) await windowsFiles('check-file', resolve(path));
  return stat;
}
export async function openPrivateRead(path) {
  try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw fail('JOURNAL_UNSAFE'); }
  catch (e) { throw e; }
  return open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
}
export async function commitFile(temporary, destination, { create = false } = {}) {
  if (WINDOWS) await windowsFiles('commit', resolve(temporary), resolve(destination), create ? 'create' : 'replace');
  else await rename(temporary, destination);
}
export async function syncDirectory(directory) {
  // Windows commits use MoveFileExW(MOVEFILE_WRITE_THROUGH). Opening a directory
  // for fsync is not supported by Node on Windows; do not silently swallow errors.
  if (WINDOWS) return;
  const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); }
}
