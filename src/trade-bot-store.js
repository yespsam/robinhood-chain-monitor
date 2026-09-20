import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Persistence only. This module has no market, wallet, signing or execution dependencies.
const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGACY_PAPER = path.resolve(PROJECT, "..", "robinhood-chain-monitor-paper-100");
const MAX_BYTES = 16 * 1024 * 1024;
export const TRADE_BOT_STORE_FILES = Object.freeze({ state: "trade-bot-state.json", lock: ".trade-bot.lock", marker: ".trade-bot-initialized" });
const hash = text => createHash("sha256").update(text).digest("hex");
const failure = (code, cause) => Object.assign(new Error(code, cause ? { cause } : undefined), { code });
const within = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
const plain = value => value !== null && typeof value === "object"
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function directoryPath(directory) {
  if (typeof directory !== "string" || !directory || !path.isAbsolute(directory) || directory.includes("\0")) {
    throw failure("trade_bot_directory_must_be_explicit_absolute");
  }
  const resolved = path.resolve(directory);
  if ([PROJECT, LEGACY_PAPER].some(root => within(resolved, root) || within(root, resolved))
    || within(os.homedir(), resolved) || resolved === path.parse(resolved).root) {
    throw failure("trade_bot_directory_overlaps_protected_path");
  }
  return resolved;
}

function validatorFunction(validate) {
  if (typeof validate !== "function" || validate.constructor?.name === "AsyncFunction") {
    throw failure("trade_bot_validator_must_be_synchronous");
  }
  return validate;
}

async function rejectSymlinks(filename) {
  let current = path.parse(filename).root;
  const parts = filename.slice(current.length).split(path.sep).filter(Boolean);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (error.code === "ENOENT") return; throw error; }
    if (stat.isSymbolicLink()) throw failure("trade_bot_symlink_rejected");
    if (index < parts.length - 1 && !stat.isDirectory()) throw failure("trade_bot_parent_not_directory");
  }
}

// Strict JSON avoids getters/toJSON, dropped properties, sparse arrays and ambiguous checksums.
function stableJson(value) {
  const active = new Set(); let bytes = 0, nodes = 0;
  const emit = text => {
    bytes += Buffer.byteLength(text);
    if (bytes > MAX_BYTES) throw failure("trade_bot_state_too_large");
    return text;
  };
  function visit(item, depth) {
    if (++nodes > 1_000_000 || depth > 64) throw failure("trade_bot_state_structure_too_large");
    if (item === null || typeof item === "boolean" || typeof item === "string") return emit(JSON.stringify(item));
    if (typeof item === "number" && Number.isFinite(item)) return emit(JSON.stringify(item));
    if ((!Array.isArray(item) && !plain(item)) || active.has(item)) throw failure("trade_bot_state_not_strict_json");
    active.add(item);
    let result;
    if (Array.isArray(item)) {
      if (item.length > 1_000_000 || Reflect.ownKeys(item).length !== item.length + 1) throw failure("trade_bot_state_not_strict_json");
      const values = [];
      for (let index = 0; index < item.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(item, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) throw failure("trade_bot_state_not_strict_json");
        values.push(visit(descriptor.value, depth + 1));
      }
      emit("[]"); if (values.length > 1) emit(",".repeat(values.length - 1));
      result = `[${values.join(",")}]`;
    } else {
      const keys = Reflect.ownKeys(item);
      if (keys.some(key => typeof key !== "string")) throw failure("trade_bot_state_not_strict_json");
      const values = [];
      for (const key of keys.sort()) {
        const descriptor = Object.getOwnPropertyDescriptor(item, key);
        if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) throw failure("trade_bot_state_not_strict_json");
        values.push(emit(JSON.stringify(key)) + emit(":") + visit(descriptor.value, depth + 1));
      }
      emit("{}"); if (values.length > 1) emit(",".repeat(values.length - 1));
      result = `{${values.join(",")}}`;
    }
    active.delete(item);
    return result;
  }
  if (!plain(value)) throw failure("trade_bot_state_must_be_object");
  return visit(value, 0);
}

function freezeJson(value) {
  if (value && typeof value === "object") { for (const child of Object.values(value)) freezeJson(child); Object.freeze(value); }
  return value;
}

function checkedCapture(state, validate) {
  const serialized = stableJson(state), captured = freezeJson(JSON.parse(serialized));
  let valid;
  try { valid = validate(captured); }
  catch (error) { throw failure("trade_bot_state_validation_failed", error); }
  if (valid instanceof Promise) valid.catch(() => {});
  if (valid !== true) throw failure(valid && typeof valid.then === "function"
    ? "trade_bot_validator_must_be_synchronous" : "trade_bot_state_validation_failed");
  return { state: captured, serialized };
}

const statIdentity = stat => `${stat.dev}:${stat.ino}`;
const statVersion = stat => `${statIdentity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}:${stat.nlink}`;

async function readFileSnapshot(filename, maximumBytes, optional = false) {
  await rejectSymlinks(filename);
  let handle;
  try {
    const named = await fs.lstat(filename, { bigint: true });
    if (!named.isFile() || named.nlink !== 1n) throw failure("trade_bot_file_not_private_regular");
    handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) throw failure("trade_bot_file_not_bounded_regular");
    if (statVersion(named) !== statVersion(before)) throw failure("trade_bot_file_changed_during_read");
    const chunks = []; let total = 0;
    while (true) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, maximumBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > maximumBytes) throw failure("trade_bot_state_too_large");
      chunks.push(buffer.subarray(0, bytesRead));
    }
    const after = await handle.stat({ bigint: true }), current = await fs.lstat(filename, { bigint: true });
    if (statVersion(before) !== statVersion(after) || statVersion(current) !== statVersion(after)
      || current.isSymbolicLink()) throw failure("trade_bot_file_changed_during_read");
    const text = Buffer.concat(chunks, total).toString("utf8");
    let value;
    try { value = JSON.parse(text); } catch (error) { throw failure("trade_bot_file_invalid_json", error); }
    return { value, fingerprint: `${statVersion(after)}:${hash(text)}` };
  } catch (error) {
    if (optional && !handle && error.code === "ENOENT") return null;
    throw error;
  } finally { await handle?.close(); }
}

async function readStateSnapshot(filename, validate) {
  const snapshot = await readFileSnapshot(filename, MAX_BYTES, true);
  if (!snapshot) return null;
  const value = snapshot.value;
  if (!plain(value) || Object.keys(value).sort().join(",") !== "checksum,revision,schema,state,version"
    || value.schema !== "trade_bot_store_v1" || value.version !== 1
    || !Number.isSafeInteger(value.revision) || value.revision < 1
    || typeof value.checksum !== "string" || !/^[0-9a-f]{64}$/.test(value.checksum)) {
    throw failure("trade_bot_envelope_invalid");
  }
  const capture = checkedCapture(value.state, validate);
  if (hash(capture.serialized) !== value.checksum) throw failure("trade_bot_checksum_mismatch");
  return { fingerprint: snapshot.fingerprint, revision: value.revision, ...capture };
}

async function readMarkerSnapshot(directory) {
  const snapshot = await readFileSnapshot(path.join(directory, TRADE_BOT_STORE_FILES.marker), 4096, true);
  if (!snapshot) return null;
  const value = snapshot.value;
  if (!plain(value) || Object.keys(value).sort().join(",") !== "schema,token,version"
    || value.schema !== "trade_bot_store_initialization_v1" || value.version !== 1
    || typeof value.token !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value.token)) {
    throw failure("trade_bot_initialization_marker_invalid");
  }
  return snapshot;
}

function checkInitialization(marker, snapshot) {
  if (marker && !snapshot) throw failure("trade_bot_initialized_state_missing_manual_review_required");
  if (snapshot && !marker) throw failure("trade_bot_initialization_marker_missing_manual_review_required");
}

async function syncDirectory(directory) {
  const handle = await fs.open(directory, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

export async function readTradeBotState(directory, validate) {
  const resolved = directoryPath(directory), check = validatorFunction(validate);
  await rejectSymlinks(resolved);
  const marker = await readMarkerSnapshot(resolved);
  const snapshot = await readStateSnapshot(path.join(resolved, TRADE_BOT_STORE_FILES.state), check);
  checkInitialization(marker, snapshot);
  return snapshot ? structuredClone(snapshot.state) : null;
}

/** Single-writer research-state store. Failures poison this instance until it is closed. */
export function createTradeBotStore({ directory, validate } = {}) {
  const resolved = directoryPath(directory), check = validatorFunction(validate);
  const stateFile = path.join(resolved, TRADE_BOT_STORE_FILES.state), lockFile = path.join(resolved, TRADE_BOT_STORE_FILES.lock);
  let phase = "new", opening = null, closing = null, poisoned = null, queue = Promise.resolve();
  let snapshot = null, marker = null, directoryIdentity = null, lockHandle = null, lockFingerprint = null, token = null;

  function poison(error) { poisoned ||= failure("trade_bot_store_poisoned_manual_review_required", error); return error; }
  function admission() {
    if (poisoned) throw poisoned;
    if (phase !== "open") throw failure("trade_bot_store_not_open");
  }
  async function checkDirectory() {
    await rejectSymlinks(resolved);
    const stat = await fs.lstat(resolved, { bigint: true });
    if (!stat.isDirectory() || statIdentity(stat) !== directoryIdentity) throw failure("trade_bot_directory_changed");
  }
  async function checkLock() {
    await checkDirectory();
    const current = await readFileSnapshot(lockFile, 4096);
    if (!token || current.fingerprint !== lockFingerprint || current.value?.token !== token) throw failure("trade_bot_lock_ownership_lost");
  }
  async function unchanged() {
    await checkLock();
    const currentMarker = await readMarkerSnapshot(resolved);
    if (currentMarker?.fingerprint !== marker?.fingerprint) throw failure("trade_bot_initialization_marker_changed");
    const current = await readStateSnapshot(stateFile, check);
    if (current?.fingerprint !== snapshot?.fingerprint) throw failure("trade_bot_state_changed_externally");
    await checkDirectory();
    return current;
  }
  async function initializeMarker() {
    if (marker) return;
    const markerFile = path.join(resolved, TRADE_BOT_STORE_FILES.marker);
    const markerToken = randomUUID();
    const handle = await fs.open(markerFile, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let identity;
    try {
      identity = statIdentity(await handle.stat({ bigint: true }));
      await handle.chmod(0o600);
      await handle.writeFile(`${JSON.stringify({ schema: "trade_bot_store_initialization_v1", version: 1, token: markerToken })}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    await syncDirectory(resolved); await checkDirectory();
    marker = await readMarkerSnapshot(resolved);
    if (!marker || marker.value.token !== markerToken || !marker.fingerprint.startsWith(`${identity}:`)) throw failure("trade_bot_initialization_marker_changed");
  }
  function enqueue(operation) {
    try { admission(); } catch (error) { return Promise.reject(error); }
    const work = queue.then(async () => {
      if (poisoned) throw poisoned;
      try { return await operation(); } catch (error) { throw poison(error); }
    });
    queue = work.catch(() => {});
    return work;
  }

  function open() {
    if (poisoned) return Promise.reject(poisoned);
    if (phase === "opening") return opening;
    if (phase === "open") return read();
    if (phase !== "new") return Promise.reject(failure("trade_bot_store_closed"));
    phase = "opening";
    opening = (async () => {
      await rejectSymlinks(resolved);
      await fs.mkdir(resolved, { recursive: true, mode: 0o700 });
      await rejectSymlinks(resolved);
      const directoryStat = await fs.lstat(resolved, { bigint: true });
      if (!directoryStat.isDirectory()) throw failure("trade_bot_directory_invalid");
      directoryIdentity = statIdentity(directoryStat);
      token = randomUUID();
      try { lockHandle = await fs.open(lockFile, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
      catch (error) { if (error.code === "EEXIST") throw failure("trade_bot_writer_lock_exists_manual_review_required"); throw error; }
      await lockHandle.chmod(0o600);
      await lockHandle.writeFile(`${JSON.stringify({ schema: "trade_bot_lock_v1", token, pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      await lockHandle.sync(); await syncDirectory(resolved);
      const currentLock = await readFileSnapshot(lockFile, 4096);
      const ownLock = await lockHandle.stat({ bigint: true });
      if (currentLock.value?.token !== token || !currentLock.fingerprint.startsWith(`${statIdentity(ownLock)}:`)) throw failure("trade_bot_lock_ownership_lost");
      lockFingerprint = currentLock.fingerprint;
      await checkLock(); marker = await readMarkerSnapshot(resolved);
      snapshot = await readStateSnapshot(stateFile, check); checkInitialization(marker, snapshot); await checkDirectory();
      phase = closing ? "closing" : "open";
      return snapshot ? structuredClone(snapshot.state) : null;
    })().catch(error => { throw poison(error); });
    return opening;
  }

  function read() {
    return enqueue(async () => {
      const current = await unchanged();
      return current ? structuredClone(current.state) : null;
    });
  }

  function save(state) {
    let capture;
    try { admission(); capture = checkedCapture(state, check); }
    catch (error) { if (phase === "open") poison(error); return Promise.reject(error); }
    return enqueue(async () => {
      await unchanged();
      const revision = (snapshot?.revision || 0) + 1;
      if (!Number.isSafeInteger(revision)) throw failure("trade_bot_revision_exhausted");
      const text = `{"schema":"trade_bot_store_v1","version":1,"revision":${revision},"checksum":"${hash(capture.serialized)}","state":${capture.serialized}}\n`;
      if (Buffer.byteLength(text) > MAX_BYTES) throw failure("trade_bot_state_too_large");
      // Persist intent before the first checkpoint: a crash or later deletion is not a new account.
      await initializeMarker();
      const temporary = path.join(resolved, `.trade-bot-state.${randomUUID()}.tmp`);
      let handle = null, temporaryIdentity = null;
      try {
        handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        temporaryIdentity = statIdentity(await handle.stat({ bigint: true }));
        await handle.chmod(0o600); await handle.writeFile(text); await handle.sync(); await handle.close(); handle = null;
        await unchanged();
        const beforeRename = await fs.lstat(temporary, { bigint: true });
        if (!beforeRename.isFile() || beforeRename.nlink !== 1n || statIdentity(beforeRename) !== temporaryIdentity) throw failure("trade_bot_temporary_changed");
        await fs.rename(temporary, stateFile); await syncDirectory(resolved); await checkDirectory();
        const saved = await readStateSnapshot(stateFile, check);
        if (!saved || saved.revision !== revision || saved.serialized !== capture.serialized) throw failure("trade_bot_saved_state_changed");
        snapshot = saved;
        return structuredClone(capture.state);
      } finally {
        await handle?.close();
        if (temporaryIdentity) {
          await checkDirectory();
          let remaining;
          try { remaining = await fs.lstat(temporary, { bigint: true }); } catch (error) { if (error.code !== "ENOENT") throw error; }
          if (remaining && remaining.isFile() && statIdentity(remaining) === temporaryIdentity) await fs.unlink(temporary);
        }
      }
    });
  }

  function close() {
    if (closing) return closing;
    phase = "closing";
    closing = (async () => {
      await opening?.catch(() => {}); await queue;
      try {
        if (lockHandle && !poisoned) {
          // Never remove an orphan/replacement lock, even if its PID looks dead.
          await checkLock(); await fs.unlink(lockFile); await syncDirectory(resolved);
        }
      } finally { await lockHandle?.close(); lockHandle = null; phase = "closed"; }
    })();
    return closing;
  }

  return Object.freeze({ open, read, save, close });
}
