import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { validOwner } from './auth.mjs';

// Reads only this application's locally generated password hash, never vendor credentials.
export function ownerReloader(sessions, path = new URL('../.private/owner.json', import.meta.url)) {
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try {
      let owner = null;
      try { owner = JSON.parse(await readFile(path, 'utf8')); if (!validOwner(owner)) owner = null; }
      catch { /* Missing, inaccessible or malformed owner config must fail closed. */ }
      if (!isDeepStrictEqual(owner, sessions.owner)) sessions.configureOwner(owner);
    } finally { busy = false; }
  };
}
