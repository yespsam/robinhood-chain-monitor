import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class SquareKeyError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export function validateSquareKey(value) {
  if (typeof value !== 'string') throw new SquareKeyError('invalid_key');
  const key = value.trim();
  // Do not assume an undocumented key prefix. Reject notes, control characters,
  // embedded whitespace and unbounded input, not a particular Binance format.
  if (!/^[\x21-\x7e]{1,4096}$/.test(key)) throw new SquareKeyError('invalid_key');
  return key;
}

const statOrNull = async file => {
  try { return await fs.lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
function assertOwned(stat, directory, privateMode = false) {
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())
      || (process.getuid && stat.uid !== process.getuid())
      || (privateMode && (stat.mode & 0o077) !== 0)
      || (!directory && stat.nlink !== 1)) throw new SquareKeyError('unsafe_storage');
}

// Compatible with Binance's official square-post saved-key format. Never put a
// secret in a snapshot, response, error, log, command argument or project file.
export function createSquareKeyStore({ configDir = path.join(os.homedir(), '.config', 'binance-square'), environmentKeyPresent = () => Boolean(process.env.BINANCE_SQUARE_OPENAPI_KEY?.trim()), publicationReceiptFile = null } = {}) {
  const parent = path.dirname(configDir);
  const keyFile = path.join(configDir, 'openapi-key');
  let tail = Promise.resolve();
  async function inspect() {
    const parentStat = await statOrNull(parent);
    if (parentStat) assertOwned(parentStat, true);
    const dirStat = parentStat ? await statOrNull(configDir) : null;
    if (dirStat) assertOwned(dirStat, true, true);
    const fileStat = dirStat ? await statOrNull(keyFile) : null;
    if (fileStat) assertOwned(fileStat, false, true);
    return { parentStat, dirStat, fileStat };
  }
  async function status() {
    const { fileStat } = await inspect();
    const environmentPresent = Boolean(environmentKeyPresent());
    let publicationTest = null;
    // Only disclose a verified historical result for this exact saved file
    // version. Replacing the key or switching to an environment key invalidates
    // the badge. The key itself is never read to render this status.
    if (fileStat?.size && !environmentPresent && publicationReceiptFile) {
      try {
        const receiptStat = await fs.lstat(publicationReceiptFile);
        assertOwned(receiptStat, false, true);
        if (receiptStat.size > 32768) throw new Error('receipt_too_large');
        const receipt = JSON.parse(await fs.readFile(publicationReceiptFile, 'utf8'));
        const sameCredential = ['dev', 'ino', 'mtimeMs', 'size'].every(field => receipt.credentialFile?.[field] === fileStat[field]);
        const id = typeof receipt.id === 'string' && /^\d{1,30}$/.test(receipt.id) ? receipt.id : null;
        const expectedLink = `https://www.binance.com/zh-CN/square/post/${id}`;
        if (sameCredential && receipt.status === 'confirmed_publication' && id && receipt.link === expectedLink
            && receipt.verifiedAuthor === receipt.requestedAccount && typeof receipt.verifiedAuthor === 'string'
            && Number.isFinite(Date.parse(receipt.verifiedAt))) {
          publicationTest = { id, link: expectedLink, author: receipt.verifiedAuthor.slice(0, 80), verifiedAt: receipt.verifiedAt };
        }
      } catch { /* Missing, malformed or unconfirmed receipts do not verify a key. */ }
    }
    return { stored: Boolean(fileStat?.size), hasSavedFile: Boolean(fileStat), environmentKeyPresent: environmentPresent, verified: Boolean(publicationTest), publishingEnabled: false, ...(publicationTest ? { publicationTest } : {}) };
  }
  async function save(value, { replace = false } = {}) {
    const key = validateSquareKey(value);
    const perform = async () => {
      const existing = await inspect();
      if (existing.fileStat && !replace) throw new SquareKeyError('already_saved');
      if (!existing.parentStat) await fs.mkdir(parent, { mode: 0o700 });
      if (!existing.dirStat) await fs.mkdir(configDir, { mode: 0o700 });
      // Recheck ownership and links before creating a private temporary file.
      await inspect();
      const temporary = path.join(configDir, `.openapi-key-${randomUUID()}.tmp`);
      let handle;
      try {
        handle = await fs.open(temporary, 'wx', 0o600);
        await handle.writeFile(`${key}\n`, 'utf8');
        await handle.sync();
        await handle.close(); handle = null;
        if (replace) await fs.rename(temporary, keyFile);
        else {
          // A concurrent first save must not silently overwrite another key.
          try { await fs.link(temporary, keyFile); }
          catch (error) { if (error.code === 'EEXIST') throw new SquareKeyError('already_saved'); throw error; }
          await fs.unlink(temporary);
        }
        return await status();
      } finally {
        if (handle) await handle.close().catch(() => {});
        await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw new SquareKeyError('save_failed'); });
      }
    };
    const pending = tail.then(perform);
    tail = pending.catch(() => {});
    return pending;
  }
  return { status, save };
}
