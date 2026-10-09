import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const coordinators = new Map();
const methodAliases = {
  getNetwork: "eth_chainId",
  getBlockNumber: "eth_blockNumber", getBlock: "eth_getBlockByNumber",
  getTransaction: "eth_getTransactionByHash", getTransactionReceipt: "eth_getTransactionReceipt",
  getCode: "eth_getCode", getStorage: "eth_getStorageAt", call: "eth_call", callBatch: "eth_call",
};
const canonicalMethod = (method) => methodAliases[method] || method;
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}
function unavailable(reason, retryAfterMs = 100, operation = null, scope = "capacity") {
  const error = new Error(`shared RPC coordinator: ${reason}`);
  error.code = "RPC_COORDINATOR_UNAVAILABLE";
  error.retryAfterMs = Math.max(1, retryAfterMs);
  error.rpcOperation = operation;
  error.rpcFailureScope = scope;
  // Local contention is not a new upstream failure. Never extend a circuit
  // because the coordinator correctly refused a request.
  error.rpcCircuitAlreadyOpen = true;
  if (scope === "host") error.rpcHostRetryAfterMs = error.retryAfterMs;
  return error;
}

// One tiny local WAL database, not the 70 MB scan state. Transactions never
// surround network I/O. Busy locks yield to the event loop; errors fail closed.
// No URL, credential, RPC parameters, wallet or trading data is persisted here.
export function createRpcHostCoordinator({ file, now = Date.now, pid = process.pid, alive = processAlive } = {}) {
  if (!file) throw new Error("RPC coordinator file is required");
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(file, { timeout: 15 });
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS rpc_leases (
      id TEXT PRIMARY KEY, host TEXT NOT NULL, pid INTEGER NOT NULL,
      lane TEXT NOT NULL, operation TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rpc_leases_host ON rpc_leases(host);
    CREATE TABLE IF NOT EXISTS rpc_waiters (
      id TEXT PRIMARY KEY, host TEXT NOT NULL, pid INTEGER NOT NULL,
      lane TEXT NOT NULL, deadline_ms INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rpc_waiters_host ON rpc_waiters(host, lane);
    CREATE TABLE IF NOT EXISTS rpc_circuits (
      host TEXT NOT NULL, operation TEXT NOT NULL, until_ms INTEGER NOT NULL,
      generation INTEGER NOT NULL, PRIMARY KEY(host, operation)
    );`);
  const rows = db.prepare("SELECT * FROM rpc_leases WHERE host=?");
  const drop = db.prepare("DELETE FROM rpc_leases WHERE id=?");
  const circuits = db.prepare("SELECT * FROM rpc_circuits WHERE host=? AND operation IN ('*', ?)");
  const insert = db.prepare("INSERT INTO rpc_leases VALUES (?, ?, ?, ?, ?, ?)");
  const enqueue = db.prepare("INSERT INTO rpc_waiters VALUES (?, ?, ?, ?, ?)");
  const waiting = db.prepare("SELECT * FROM rpc_waiters WHERE host=? AND lane=? ORDER BY rowid");
  const dropWaiter = db.prepare("DELETE FROM rpc_waiters WHERE id=?");
  const clear = db.prepare("UPDATE rpc_circuits SET until_ms=0 WHERE host=? AND operation=? AND generation=?");
  const fail = db.prepare(`INSERT INTO rpc_circuits VALUES (?, ?, ?, 1)
    ON CONFLICT(host, operation) DO UPDATE SET
    until_ms=MAX(until_ms, excluded.until_ms), generation=generation+1`);
  let closed = false;
  function transaction(action) {
    if (closed) throw unavailable("closed");
    let began = false;
    try {
      db.exec("BEGIN IMMEDIATE"); began = true;
      const result = action();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      if (began) { try { db.exec("ROLLBACK"); } catch {} }
      if (error.rpcCircuitAlreadyOpen) throw error;
      throw unavailable(/locked|busy/i.test(error.message) ? "database busy" : "database unavailable");
    }
  }
  function tryAcquire(host, operation, lane = "background", waiterId = null) {
    if (!/^[a-z0-9.:-]+$/i.test(host)) throw new Error("RPC coordinator requires a hostname, not a URL");
    operation = canonicalMethod(operation);
    lane = lane === "realtime" ? "realtime" : "background";
    return transaction(() => {
      let active = rows.all(host);
      // Time alone must never release an alive process's physical socket.
      // Dead owners are reclaimable; successful callers release in finally.
      const dead = new Set(active.filter((row) => !alive(row.pid)).map((row) => row.pid));
      for (const row of active) if (dead.has(row.pid)) drop.run(row.id);
      active = active.filter((row) => !dead.has(row.pid));
      const states = circuits.all(host, operation);
      const cooling = states.filter((row) => row.until_ms > now()).sort((a, b) => b.until_ms - a.until_ms)[0];
      if (cooling) throw unavailable("host/method cooling down", cooling.until_ms - now(), operation, cooling.operation === "*" ? "host" : "method");
      // A single half-open probe across processes, including method aliases.
      const probing = states.some((row) => row.until_ms > 0
        && active.some((entry) => row.operation === "*" || entry.operation === operation));
      if (probing || active.length >= 2 || (lane === "background" && active.filter((row) => row.lane !== "realtime").length >= 1)) return null;
      // FIFO within each lane prevents a fast polling producer from taking
      // the background slot every time. Realtime never waits behind queued
      // background work, and no live physical lease is evicted by a timer.
      const queued = waiting.all(host, lane);
      for (const entry of queued) {
        if (entry.deadline_ms <= Date.now() || !alive(entry.pid)) dropWaiter.run(entry.id);
        else {
          if (entry.id !== waiterId) return null;
          break;
        }
      }
      const lease = { id: randomUUID(), host, operation, generations: states.map((row) => ({ operation: row.operation, generation: row.generation })) };
      insert.run(lease.id, host, pid, lane, operation, now());
      if (waiterId) dropWaiter.run(waiterId);
      return lease;
    });
  }
  function release(lease, success = false) {
    transaction(() => {
      if (success) for (const row of lease.generations) clear.run(lease.host, row.operation, row.generation);
      drop.run(lease.id);
    });
  }
  function cooldown(host, operation, until, scope = "host") {
    transaction(() => fail.run(host, scope === "host" ? "*" : canonicalMethod(operation), Math.ceil(until)));
  }
  async function persistCooldown(...args) {
    for (let attempt = 0; ; attempt++) {
      try { return cooldown(...args); }
      catch (error) { if (attempt >= 19) throw error; await delay(25); }
    }
  }
  async function run(host, operation, lane, callback, { waitMs = 1_000 } = {}) {
    const deadline = Date.now() + Math.max(1, waitMs);
    lane = lane === "realtime" ? "realtime" : "background";
    if (!/^[a-z0-9.:-]+$/i.test(host)) throw new Error("RPC coordinator requires a hostname, not a URL");
    const waiterId = randomUUID();
    let lease;
    let registered = false;
    try {
      while (!lease) {
        if (Date.now() >= deadline) throw unavailable("capacity wait deadline", 100, operation);
        try {
          if (!registered) {
            transaction(() => enqueue.run(waiterId, host, pid, lane, deadline));
            registered = true;
          }
          lease = tryAcquire(host, operation, lane, waiterId);
        } catch (error) {
          if (error.rpcFailureScope !== "capacity" || Date.now() >= deadline) throw error;
        }
        if (!lease) {
          if (Date.now() >= deadline) throw unavailable("capacity wait deadline", 100, operation);
          await delay(Math.min(50, Math.max(1, deadline - Date.now())));
        }
      }
    } finally {
      // Successful admission removed its waiter in the same transaction. An
      // expired/error waiter is not allowed to obstruct the next caller.
      if (registered && !lease) {
        try { transaction(() => dropWaiter.run(waiterId)); } catch { /* deadline cleanup on next admission */ }
      }
    }
    let success = false;
    try { const result = await callback(); success = true; return result; }
    finally {
      // A short concurrent writer cannot leak an alive process's slot. Keep
      // retries bounded; if storage is broken stop admitting requests instead
      // of bypassing the shared cap. A process restart reclaims its dead lease.
      let last;
      for (let attempt = 0; attempt < 20; attempt++) {
        try { release(lease, success); last = null; break; }
        catch (error) { last = error; await delay(25); }
      }
      if (last) throw last;
    }
  }
  return { tryAcquire, release, cooldown, persistCooldown, run,
    snapshot: () => ({ leases: db.prepare("SELECT * FROM rpc_leases").all(), circuits: db.prepare("SELECT * FROM rpc_circuits").all(),
      waiters: db.prepare("SELECT * FROM rpc_waiters ORDER BY rowid").all() }),
    close: () => { if (!closed) { closed = true; db.close(); } },
  };
}

export function sharedRpcHostCoordinator(dataDir) {
  const file = path.resolve(dataDir, "rpc-host-coordinator.sqlite");
  if (!coordinators.has(file)) coordinators.set(file, createRpcHostCoordinator({ file }));
  return coordinators.get(file);
}
