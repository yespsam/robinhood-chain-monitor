import fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import dotenv from 'dotenv';

export const TYPESAFE_LOCAL_FILE = new URL('../.env.typesafe.local', import.meta.url);
export const validTypesafeKey = key => typeof key === 'string' && /^[A-Za-z0-9_-]{20,256}$/.test(key);

export async function readTypesafeKey({ env = process.env, localFile = TYPESAFE_LOCAL_FILE,
  envFile = new URL('../.env', import.meta.url) } = {}) {
  if (env.TYPESAFE_API_KEY?.trim()) return env.TYPESAFE_API_KEY.trim();
  for (const file of [localFile, envFile]) {
    try {
      const key = dotenv.parse(await fs.readFile(file)).TYPESAFE_API_KEY;
      if (key?.trim()) return key.trim();
    } catch (error) { if (error.code !== 'ENOENT') throw Error('typesafe_config_unreadable'); }
  }
  return null;
}

// Isolated ignored file: no rewriting the project's other provider credentials.
export async function saveTypesafeKey(key, file = TYPESAFE_LOCAL_FILE) {
  if (!validTypesafeKey(key)) throw Error('invalid_key');
  try { const st = await fs.lstat(file); if (!st.isFile() || st.isSymbolicLink()) throw Error('invalid_config_target'); }
  catch (error) { if (error.code !== 'ENOENT') throw Error('invalid_config_target'); }
  const target = file instanceof URL ? file : new URL(`file://${file}`);
  const temporary = new URL(`${target.href}.${randomBytes(8).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temporary, `TYPESAFE_API_KEY=${key}\n`, { flag: 'wx', mode: 0o600 });
    await fs.rename(temporary, target);
  } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw Error('temporary_cleanup_failed'); }); }
}
