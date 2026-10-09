import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const BSC_WORKER_COMMANDS = new Set([
  "registerDiscoveryCandidates", "registerFlapFeatureActivations",
  "registerFourMemeFeatureActivations", "registerFlapQuotePoolLifecycle",
]);
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
};

// Durable inbound commands only. The scanner remains the sole writer of its
// original state/WAL; monitors never mutate it across the process boundary.
export function createBscWorkerMailbox(dataDir, { now = Date.now, pid = process.pid, alive = isAlive } = {}) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path.join(dataDir, "bsc-worker-mailbox.sqlite"), { timeout: 15 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS commands (
      id TEXT PRIMARY KEY, method TEXT NOT NULL, args TEXT NOT NULL,
      created INTEGER NOT NULL, retry_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', result TEXT, error TEXT
    );
    CREATE INDEX IF NOT EXISTS commands_due ON commands(status, retry_at, created);
    CREATE TABLE IF NOT EXISTS scanner_owner (id INTEGER PRIMARY KEY CHECK(id=1), pid INTEGER NOT NULL);`);
  function tx(action) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = action(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  }
  const get = db.prepare("SELECT * FROM commands WHERE id=?");
  const remove = db.prepare("DELETE FROM commands WHERE id=? AND status='done'");
  return {
    enqueue(method, args) {
      if (!BSC_WORKER_COMMANDS.has(method)) throw new Error("unsupported BSC worker command");
      const encoded = JSON.stringify(args);
      if (Buffer.byteLength(encoded) > 1_048_576) throw new Error("BSC worker command exceeds 1 MiB");
      const id = createHash("sha256").update(`${method}:${encoded}`).digest("hex");
      tx(() => {
        if (get.get(id)) return;
        // Never evict unprocessed commands. Callers retain their retry state.
        if (db.prepare("SELECT COUNT(*) AS n FROM commands").get().n >= 2_000) throw new Error("BSC worker inbox full; command not accepted");
        db.prepare("INSERT INTO commands(id,method,args,created,retry_at) VALUES (?,?,?,?,?)").run(id, method, encoded, now(), now());
      });
      return id;
    },
    get: (id) => get.get(id),
    acknowledge: (id) => remove.run(id),
    next: () => db.prepare("SELECT * FROM commands WHERE status='pending' AND retry_at<=? ORDER BY created, id LIMIT 1").get(now()),
    complete: (id, result) => db.prepare("UPDATE commands SET status='done', result=?, error=NULL WHERE id=?").run(JSON.stringify(result ?? null), id),
    retry(id, error) {
      const row = get.get(id);
      const attempts = Number(row?.attempts || 0) + 1;
      db.prepare("UPDATE commands SET attempts=?, retry_at=?, error=?, status=? WHERE id=?")
        .run(attempts, now() + Math.min(60_000, 1_000 * 2 ** Math.min(attempts, 6)), String(error?.message || error).slice(0, 500), attempts >= 30 ? "failed" : "pending", id);
    },
    claimOwner: () => tx(() => {
      const owner = db.prepare("SELECT pid FROM scanner_owner WHERE id=1").get();
      if (owner && owner.pid !== pid && alive(owner.pid)) return false;
      db.prepare("INSERT INTO scanner_owner VALUES(1,?) ON CONFLICT(id) DO UPDATE SET pid=excluded.pid").run(pid);
      return true;
    }),
    releaseOwner: () => db.prepare("DELETE FROM scanner_owner WHERE id=1 AND pid=?").run(pid),
    summary: () => db.prepare("SELECT status, COUNT(*) AS count, MIN(created) AS oldest FROM commands GROUP BY status").all(),
    close: () => db.close(),
  };
}
