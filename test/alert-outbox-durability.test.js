import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { sendAlerts } from "../src/alerts.js";

const outboxName = "alert-outbox.json";

function alertConfig(dataDir, alertOutboxFsImpl) {
  return {
    dataDir,
    blockedContracts: new Set(),
    telegramToken: "durability-test-token",
    telegramChatId: "1234567890",
    telegramStrongAlerts: false,
    alertBilingualEnabled: false,
    alertChineseTranslationEnabled: false,
    alertTelegramDeliveryMaxAgeMs: 7_200_000,
    webhookUrl: "",
    alertOutboxFsImpl,
  };
}

function platformEvent(id = "first") {
  return {
    type: "platform_capability_update",
    eventKey: `outbox-durability:${id}`,
    platform: { id: "fourmeme", name: "Four.Meme", website: "https://four.meme" },
    changes: {
      newQuoteTokens: [`UUSD-${id}`],
      removedQuoteTokens: [],
      newModules: [],
      newVersions: [],
      newContracts: [],
      newPages: [],
      newAnnouncements: [],
    },
    observedAt: new Date().toISOString(),
    url: "https://four.meme/en/create-token",
  };
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function observedFs(dataDir, { failFileSyncOnce = false, failDirectorySyncOnce = false } = {}) {
  const target = path.join(dataDir, outboxName);
  let pendingFileSyncFailure = failFileSyncOnce;
  let pendingDirectorySyncFailure = failDirectorySyncOnce;
  const observations = {
    fileSyncs: 0,
    directorySyncs: 0,
    tempChmods: 0,
    finalChmods: 0,
    renames: 0,
    firstCreates: 0,
    replacements: 0,
  };

  const impl = {
    mkdir: (...args) => fs.mkdir(...args),
    rm: (...args) => fs.rm(...args),
    chmod: async (file, mode) => {
      if (String(file) === target) observations.finalChmods += 1;
      return fs.chmod(file, mode);
    },
    rename: async (from, to) => {
      let existed = true;
      try {
        await fs.stat(to);
      } catch (error) {
        if (!isMissing(error)) throw error;
        existed = false;
      }
      observations.renames += 1;
      if (existed) observations.replacements += 1;
      else observations.firstCreates += 1;
      return fs.rename(from, to);
    },
    open: async (file, flags, mode) => {
      const handle = await fs.open(file, flags, mode);
      const directoryHandle = String(file) === dataDir;
      return {
        writeFile: (...args) => handle.writeFile(...args),
        chmod: async (...args) => {
          observations.tempChmods += 1;
          return handle.chmod(...args);
        },
        sync: async () => {
          if (directoryHandle) {
            observations.directorySyncs += 1;
            if (pendingDirectorySyncFailure) {
              pendingDirectorySyncFailure = false;
              throw new Error("injected directory sync failure after rename");
            }
          } else {
            observations.fileSyncs += 1;
            if (pendingFileSyncFailure) {
              pendingFileSyncFailure = false;
              throw new Error("injected file sync failure before rename");
            }
          }
          return handle.sync();
        },
        close: () => handle.close(),
      };
    },
  };

  return { impl, observations, target };
}

async function outboxTemps(dataDir) {
  return (await fs.readdir(dataDir)).filter((name) => name.startsWith(`.${outboxName}.`) && name.endsWith(".tmp"));
}

test("outbox success fsyncs file and parent directory for first-create and replacement writes", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alert-outbox-durable-success-"));
  const observed = observedFs(dataDir);
  let telegramCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, result: { message_id: ++telegramCalls } }),
  }));
  t.mock.method(console, "info", () => {});

  assert.equal((await sendAlerts(alertConfig(dataDir, observed.impl), platformEvent())).status, "delivered");

  const mode = (await fs.stat(observed.target)).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.equal(observed.observations.firstCreates, 1);
  assert.ok(observed.observations.replacements >= 1, "claim/render/completion must atomically replace the first outbox");
  assert.equal(observed.observations.fileSyncs, observed.observations.renames);
  assert.equal(observed.observations.directorySyncs, observed.observations.renames);
  assert.equal(observed.observations.tempChmods, observed.observations.renames);
  assert.equal(observed.observations.finalChmods, observed.observations.renames);
  assert.deepEqual(await outboxTemps(dataDir), []);
  assert.equal(telegramCalls, 1);
});

test("outbox replacement migrates an existing 0644 file to 0600", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alert-outbox-durable-mode-"));
  const observed = observedFs(dataDir);
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(observed.target, `${JSON.stringify({ version: 2, events: {} })}\n`, { mode: 0o644 });
  await fs.chmod(observed.target, 0o644);
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, result: { message_id: 601 } }),
  }));
  t.mock.method(console, "info", () => {});

  assert.equal((await sendAlerts(alertConfig(dataDir, observed.impl), platformEvent("mode"))).status, "delivered");
  assert.equal((await fs.stat(observed.target)).mode & 0o777, 0o600);
  assert.equal(observed.observations.firstCreates, 0);
  assert.ok(observed.observations.replacements >= 1);
  assert.equal(observed.observations.finalChmods, observed.observations.renames);
});

test("a pre-rename fsync failure preserves the prior outbox and never delivers", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alert-outbox-durable-prerename-"));
  const observed = observedFs(dataDir, { failFileSyncOnce: true });
  const original = `${JSON.stringify({ version: 2, events: { sentinel: { id: "sentinel", status: "delivered" } } })}\n`;
  let telegramCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  await fs.writeFile(observed.target, original, { mode: 0o600 });
  t.mock.method(globalThis, "fetch", async () => {
    telegramCalls += 1;
    throw new Error("delivery must not begin before durable enqueue");
  });

  await assert.rejects(
    sendAlerts(alertConfig(dataDir, observed.impl), platformEvent("pre-rename")),
    /injected file sync failure before rename/,
  );
  assert.equal(await fs.readFile(observed.target, "utf8"), original);
  assert.equal(observed.observations.renames, 0);
  assert.equal(telegramCalls, 0);
  assert.deepEqual(await outboxTemps(dataDir), []);
});

test("a post-rename directory fsync failure is reported and a retry delivers exactly once", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "alert-outbox-durable-postrename-"));
  const observed = observedFs(dataDir, { failDirectorySyncOnce: true });
  const event = platformEvent("post-rename");
  const config = alertConfig(dataDir, observed.impl);
  let telegramCalls = 0;
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  t.mock.method(globalThis, "fetch", async () => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true, result: { message_id: ++telegramCalls } }),
  }));
  t.mock.method(console, "info", () => {});

  await assert.rejects(sendAlerts(config, event), /injected directory sync failure after rename/);
  const ambiguous = JSON.parse(await fs.readFile(observed.target, "utf8"));
  assert.equal(ambiguous.events[event.eventKey].status, "pending");
  assert.equal(telegramCalls, 0, "delivery cannot begin when enqueue durability is ambiguous");

  assert.equal((await sendAlerts(config, event)).status, "delivered");
  assert.equal(telegramCalls, 1);
  assert.equal((await sendAlerts(config, event)).status, "delivered");
  assert.equal(telegramCalls, 1, "the recovered visible enqueue remains idempotent");
  assert.equal((await fs.stat(observed.target)).mode & 0o777, 0o600);
  assert.deepEqual(await outboxTemps(dataDir), []);
});
