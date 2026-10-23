import { randomBytes } from 'node:crypto';
import { mkdir, lstat, writeFile, rename, unlink } from 'node:fs/promises';

export const privateDirectory = new URL('../.private/', import.meta.url);
export const accessFile = new URL('access.json', privateDirectory);

export async function prepareLocalAccess() {
  await mkdir(privateDirectory, { mode: 0o700 });
  return verifyDirectory();
}
async function verifyDirectory() {
  const st = await lstat(privateDirectory);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0
    || (process.getuid && st.uid !== process.getuid())) throw new Error('PRIVATE_DIRECTORY_PERMISSIONS');
}
export async function createLocalAccessDirectory() {
  try { await prepareLocalAccess(); }
  catch (error) { if (error.code !== 'EEXIST') throw error; await verifyDirectory(); }
}
export async function writeLocalAccess(origin, accessKey) {
  const temporary = new URL(`access-${randomBytes(8).toString('hex')}.tmp`, privateDirectory);
  await writeFile(temporary, JSON.stringify({ product: 'yesp-wallet', origin, accessKey, pid: process.pid, createdAt: new Date().toISOString() }), { mode: 0o600, flag: 'wx' });
  await rename(temporary, accessFile);
}
export async function clearLocalAccess() { await unlink(accessFile).catch(() => {}); }
