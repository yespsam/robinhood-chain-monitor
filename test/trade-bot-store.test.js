import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createTradeBotStore, readTradeBotState, TRADE_BOT_STORE_FILES } from "../src/trade-bot-store.js";

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = seq => ({ version: 1, seq });
const validate = value => value.version === 1 && Number.isSafeInteger(value.seq) && value.seq >= 0;
const digest = text => createHash("sha256").update(text).digest("hex");
const stable = value => value === null || typeof value !== "object" ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(stable).join(",")}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
function envelope(value, revision = 1) {
  return { schema: "trade_bot_store_v1", version: 1, revision, checksum: digest(stable(value)), state: value };
}

async function fixture(t) {
  // macOS /var is a symlink; the product deliberately rejects symlink ancestors.
  const base = await fs.realpath(os.tmpdir());
  const root = await fs.mkdtemp(path.join(base, "trade-bot-store-test-"));
  const directory = path.join(root, "research"), stores = [];
  const create = (options = {}) => {
    const store = createTradeBotStore({ directory, validate, ...options }); stores.push(store); return store;
  };
  t.after(async () => { for (const store of stores) await store.close().catch(() => {}); await fs.rm(root, { recursive: true, force: true }); });
  return { root, directory, create, stateFile: path.join(directory, TRADE_BOT_STORE_FILES.state),
    lockFile: path.join(directory, TRADE_BOT_STORE_FILES.lock) };
}

test("trade-bot standalone status is read-only and a missing account stays missing", async t => {
  const f = await fixture(t);
  assert.equal(await readTradeBotState(f.directory, validate), null);
  await assert.rejects(fs.stat(f.directory), { code: "ENOENT" });
});

test("trade-bot requires an explicit absolute isolated directory", async t => {
  const f = await fixture(t);
  for (const directory of [undefined, "", ".", "relative", "/", os.homedir(), PROJECT, path.join(PROJECT, "data", "new-bot"),
    path.dirname(PROJECT), path.resolve(PROJECT, "..", "robinhood-chain-monitor-paper-100"),
    path.resolve(PROJECT, "..", "robinhood-chain-monitor-paper-100", "new-bot")]) {
    assert.throws(() => createTradeBotStore({ directory, validate }), /directory/);
  }
  assert.ok(f.create());
});

test("trade-bot open is single-flight and saves require an open writer", async t => {
  const f = await fixture(t), store = f.create();
  await assert.rejects(store.save(state(1)), /not_open/);
  await assert.rejects(store.read(), /not_open/);
  const opening = store.open(); assert.equal(store.open(), opening);
  assert.equal(await opening, null); assert.equal(await store.read(), null);
  await store.close(); await assert.rejects(store.open(), /closed/); await assert.rejects(store.save(state(1)), /not_open/);
});

test("trade-bot atomic checkpoint has canonical checksum, sequential revision and 0600 permissions", async t => {
  const f = await fixture(t), store = f.create(); await store.open();
  const value = { version: 1, seq: 1, nested: { z: [1, { b: false, a: "你好" }], a: null } };
  assert.deepEqual(await store.save(value), value);
  const checkpoint = JSON.parse(await fs.readFile(f.stateFile, "utf8"));
  assert.equal(checkpoint.schema, "trade_bot_store_v1"); assert.equal(checkpoint.version, 1); assert.equal(checkpoint.revision, 1);
  assert.equal(checkpoint.checksum, digest(stable(value)));
  assert.equal((await fs.stat(f.stateFile)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(f.lockFile)).mode & 0o777, 0o600);
  await store.save(state(2)); assert.equal(JSON.parse(await fs.readFile(f.stateFile, "utf8")).revision, 2);
  assert.equal((await fs.stat(path.join(f.directory, TRADE_BOT_STORE_FILES.marker))).mode & 0o777, 0o600);
  assert.deepEqual((await fs.readdir(f.directory)).sort(), Object.values(TRADE_BOT_STORE_FILES).sort());
});

test("trade-bot concurrent saves serialize and capture a clone before caller mutation", async t => {
  const f = await fixture(t), store = f.create(); await store.open();
  const first = { ...state(1), orders: [{ amount: 10 }] }, second = { ...state(2), orders: [{ amount: 20 }] };
  const a = store.save(first), b = store.save(second);
  first.seq = 101; first.orders[0].amount = 1000; second.seq = 102; second.orders[0].amount = 2000;
  const saved = await Promise.all([a, b]);
  assert.equal(saved[0].seq, 1); assert.equal(saved[1].seq, 2); assert.equal(saved[1].orders[0].amount, 20);
  saved[1].orders[0].amount = 9999;
  const read = await store.read(); assert.equal(read.orders[0].amount, 20); read.seq = 999;
  assert.equal((await store.read()).seq, 2);
  assert.equal(JSON.parse(await fs.readFile(f.stateFile, "utf8")).revision, 2);
});

test("trade-bot restart recovers exact state without resetting revision", async t => {
  const f = await fixture(t), first = f.create(); await first.open(); await first.save(state(4)); await first.close();
  const restarted = f.create(); assert.deepEqual(await restarted.open(), state(4));
  await restarted.save(state(5)); assert.equal(JSON.parse(await fs.readFile(f.stateFile, "utf8")).revision, 2);
  assert.deepEqual(await readTradeBotState(f.directory, validate), state(5));
});

test("trade-bot another writer cannot steal or remove a live lock", async t => {
  const f = await fixture(t), first = f.create(), second = f.create(); await first.open();
  const owned = await fs.readFile(f.lockFile, "utf8");
  await assert.rejects(second.open(), /writer_lock_exists/); await second.close();
  assert.equal(await fs.readFile(f.lockFile, "utf8"), owned);
  await first.save(state(1)); await first.close(); await assert.rejects(fs.stat(f.lockFile), { code: "ENOENT" });
});

test("trade-bot orphan lock is never automatically recovered or deleted", async t => {
  const f = await fixture(t); await fs.mkdir(f.directory);
  const orphan = JSON.stringify({ token: "orphan", pid: 999999999 }); await fs.writeFile(f.lockFile, orphan);
  const store = f.create(); await assert.rejects(store.open(), /manual_review_required/); await store.close();
  assert.equal(await fs.readFile(f.lockFile, "utf8"), orphan);
});

test("trade-bot close refuses to delete a replacement lock even when its PID matches", async t => {
  const f = await fixture(t), store = f.create(); await store.open();
  await fs.unlink(f.lockFile); const foreign = JSON.stringify({ token: "foreign", pid: process.pid }); await fs.writeFile(f.lockFile, foreign);
  await assert.rejects(store.close(), /lock_ownership_lost/);
  assert.equal(await fs.readFile(f.lockFile, "utf8"), foreign);
});

test("trade-bot deleted or replaced writer lock poisons future operations", async t => {
  const f = await fixture(t), store = f.create(); await store.open(); await store.save(state(1));
  const before = await fs.readFile(f.stateFile, "utf8"); await fs.unlink(f.lockFile);
  await assert.rejects(store.save(state(2)), { code: "ENOENT" });
  await assert.rejects(store.save(state(3)), /poisoned/);
  assert.equal(await fs.readFile(f.stateFile, "utf8"), before);
});

test("trade-bot external state replacement is detected even when content is byte-identical", async t => {
  const f = await fixture(t), store = f.create(); await store.open(); await store.save(state(1));
  const original = await fs.readFile(f.stateFile, "utf8"), replacement = path.join(f.root, "replacement.json");
  await fs.writeFile(replacement, original, { mode: 0o600 }); await fs.rename(replacement, f.stateFile);
  await assert.rejects(store.read(), /changed_externally/);
  await assert.rejects(store.save(state(2)), /poisoned/);
  assert.equal(await fs.readFile(f.stateFile, "utf8"), original);
});

test("trade-bot missing checkpoint after an observed state cannot become a fresh account", async t => {
  const f = await fixture(t), store = f.create(); await store.open(); await store.save(state(1));
  await fs.unlink(f.stateFile);
  await assert.rejects(store.save(state(2)), /changed_externally/);
  await assert.rejects(store.read(), /poisoned/); await assert.rejects(fs.stat(f.stateFile), { code: "ENOENT" });
  await store.close(); assert.ok(await fs.stat(f.lockFile), "faulted writer retains its lock for manual review");
  await assert.rejects(f.create().open(), /writer_lock_exists/);
  // Even manually removing the fault lock cannot disguise a lost checkpoint as initialization.
  await fs.unlink(f.lockFile);
  await assert.rejects(f.create().open(), /initialized_state_missing/);
  await assert.rejects(readTradeBotState(f.directory, validate), /initialized_state_missing/);
});

test("trade-bot unexpected state creation after empty open is not overwritten", async t => {
  const f = await fixture(t), store = f.create(); await store.open();
  const foreign = JSON.stringify(envelope(state(99))); await fs.writeFile(f.stateFile, foreign, { mode: 0o600 });
  await assert.rejects(store.save(state(1)), /changed_externally/);
  assert.equal(await fs.readFile(f.stateFile, "utf8"), foreign);
});

test("trade-bot bad JSON, checksum, schema and revision fail closed on restart", async t => {
  for (const mutation of [() => "{broken", value => { value.checksum = "0".repeat(64); return JSON.stringify(value); },
    value => { value.schema = "some_other_store"; return JSON.stringify(value); },
    value => { value.revision = 0; return JSON.stringify(value); },
    value => { value.state.seq = -1; return JSON.stringify(value); }]) {
    const f = await fixture(t); await fs.mkdir(f.directory);
    const before = mutation(envelope(state(1))); await fs.writeFile(f.stateFile, before, { mode: 0o600 });
    const store = f.create(); await assert.rejects(store.open(), /invalid|mismatch|validation_failed/);
    await assert.rejects(store.save(state(1)), /poisoned/);
    assert.equal(await fs.readFile(f.stateFile, "utf8"), before);
    await store.close();
  }
});

test("trade-bot invalid save poisons the queue and never silently resumes", async t => {
  const f = await fixture(t), store = f.create(); await store.open(); await store.save(state(1));
  const before = await fs.readFile(f.stateFile, "utf8");
  const queued = store.save(state(2)), invalid = store.save(state(-1));
  const result = await Promise.allSettled([queued, invalid]);
  assert.equal(result[0].status, "rejected"); assert.equal(result[1].status, "rejected");
  await assert.rejects(store.save(state(3)), /poisoned/);
  assert.equal(await fs.readFile(f.stateFile, "utf8"), before);
  await store.close(); assert.ok(await fs.stat(f.lockFile));
  await assert.rejects(f.create().open(), /writer_lock_exists/);
  // Fixture-only manual recovery after verifying the original checkpoint.
  await fs.unlink(f.lockFile);
  const restarted = f.create(); assert.deepEqual(await restarted.open(), state(1));
});

test("trade-bot validator must be synchronous and explicitly return true", async t => {
  const f = await fixture(t);
  assert.throws(() => f.create({ validate: async () => true }), /synchronous/);
  assert.throws(() => f.create({ validate: null }), /synchronous/);
  for (const check of [() => false, () => undefined, () => { throw new Error("invalid"); }, () => Promise.resolve(true)]) {
    const store = f.create({ directory: path.join(f.root, `validator-${Math.random()}`), validate: check });
    await store.open(); await assert.rejects(store.save(state(1)), /validation_failed|synchronous/);
    await assert.rejects(store.save(state(2)), /poisoned/); await store.close();
  }
});

test("trade-bot validation receives a frozen capture and cannot rewrite data being saved", async t => {
  const f = await fixture(t), store = f.create({ validate: value => { value.seq = 99; return true; } });
  await store.open(); await assert.rejects(store.save(state(1)), /validation_failed/);
  await assert.rejects(fs.stat(f.stateFile), { code: "ENOENT" });
});

test("trade-bot strict JSON rejects dropped data, cycles and accessors without invoking them", async t => {
  let invoked = 0;
  const accessor = state(1); Object.defineProperty(accessor, "bad", { enumerable: true, get() { invoked++; return 1; } });
  const cyclic = state(1); cyclic.loop = cyclic;
  const hidden = state(1); Object.defineProperty(hidden, "hidden", { value: 1 });
  const symbol = state(1); symbol[Symbol("hidden")] = 1;
  for (const value of [{ ...state(1), bad: undefined }, { ...state(1), bad: NaN }, { ...state(1), bad: 1n },
    { ...state(1), bad: new Date() }, { ...state(1), bad: [, 1] }, accessor, cyclic, hidden, symbol]) {
    const f = await fixture(t), store = f.create(); await store.open();
    await assert.rejects(store.save(value), /strict_json/); await assert.rejects(fs.stat(f.stateFile), { code: "ENOENT" });
  }
  assert.equal(invoked, 0);
});

test("trade-bot excessive state size is bounded and poisons the writer", async t => {
  const f = await fixture(t), store = f.create(); await store.open();
  await assert.rejects(store.save({ ...state(1), payload: "x".repeat(16 * 1024 * 1024) }), /too_large/);
  await assert.rejects(store.save(state(2)), /poisoned/); await assert.rejects(fs.stat(f.stateFile), { code: "ENOENT" });
});

test("trade-bot excessive persisted file size is rejected before JSON parsing", async t => {
  const f = await fixture(t); await fs.mkdir(f.directory);
  const handle = await fs.open(f.stateFile, "w", 0o600); await handle.truncate(16 * 1024 * 1024 + 1); await handle.close();
  await assert.rejects(readTradeBotState(f.directory, validate), /bounded_regular/);
});

test("trade-bot symlink ancestors and symlink state cannot escape isolation", async t => {
  const f = await fixture(t), target = path.join(f.root, "target"); await fs.mkdir(target);
  const linked = path.join(f.root, "linked"); await fs.symlink(target, linked);
  await assert.rejects(f.create({ directory: path.join(linked, "child") }).open(), /symlink/);
  await assert.rejects(readTradeBotState(path.join(linked, "child"), validate), /symlink/);
  await fs.mkdir(f.directory); const outside = path.join(target, "state.json");
  await fs.writeFile(outside, JSON.stringify(envelope(state(7))), { mode: 0o600 }); await fs.symlink(outside, f.stateFile);
  const before = await fs.readFile(outside, "utf8"); await assert.rejects(f.create().open(), /symlink/);
  assert.equal(await fs.readFile(outside, "utf8"), before);
});

test("trade-bot hard-linked state and symlink lock cannot be adopted", async t => {
  const f = await fixture(t); await fs.mkdir(f.directory);
  const external = path.join(f.root, "external.json"); await fs.writeFile(external, JSON.stringify(envelope(state(1))), { mode: 0o600 });
  await fs.link(external, f.stateFile); const store = f.create(); await assert.rejects(store.open(), /private_regular/); await store.close();
  await fs.unlink(f.stateFile); await fs.unlink(f.lockFile); await fs.symlink(external, f.lockFile);
  const second = f.create(); await assert.rejects(second.open(), /writer_lock_exists/); await second.close();
  assert.equal((await fs.lstat(f.lockFile)).isSymbolicLink(), true);
});

test("trade-bot directory replacement prevents saving and does not delete the relocated lock", async t => {
  const f = await fixture(t), store = f.create(); await store.open(); await store.save(state(1));
  const relocated = path.join(f.root, "relocated"); await fs.rename(f.directory, relocated); await fs.mkdir(f.directory);
  await assert.rejects(store.save(state(2)), /directory_changed/);
  await store.close();
  assert.ok(await fs.stat(path.join(relocated, TRADE_BOT_STORE_FILES.lock)));
  assert.deepEqual(await fs.readdir(f.directory), []);
});

test("trade-bot initialization marker prevents deletion-based resets after a clean shutdown", async t => {
  const f = await fixture(t), first = f.create(); await first.open(); await first.save(state(1)); await first.close();
  await fs.unlink(f.stateFile);
  await assert.rejects(f.create().open(), /initialized_state_missing/);
  await assert.rejects(readTradeBotState(f.directory, validate), /initialized_state_missing/);
});

test("trade-bot initialization marker deletion or replacement poisons a live store", async t => {
  const f = await fixture(t), first = f.create(); await first.open(); await first.save(state(1));
  const before = await fs.readFile(f.stateFile, "utf8");
  await fs.unlink(path.join(f.directory, TRADE_BOT_STORE_FILES.marker));
  await assert.rejects(first.save(state(2)), /initialization_marker_changed/);
  assert.equal(await fs.readFile(f.stateFile, "utf8"), before);
  await first.close(); await fs.unlink(f.lockFile);
  await assert.rejects(f.create().open(), /initialization_marker_missing/);
});

test("trade-bot close drains previously accepted saves and rejects new work", async t => {
  const f = await fixture(t), store = f.create(); await store.open();
  const write = store.save(state(1)), close = store.close(); assert.equal(store.close(), close);
  await assert.rejects(store.save(state(2)), /not_open/); await write; await close;
  assert.deepEqual(await readTradeBotState(f.directory, validate), state(1));
  await assert.rejects(fs.stat(f.lockFile), { code: "ENOENT" });
});
