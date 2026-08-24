import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eventAddresses, isEventBlocked } from "../src/blocklist.js";

test("blocklist extracts token, launcher and pool addresses", () => {
  const launcher = "0x1111111111111111111111111111111111111111";
  const token = "0x2222222222222222222222222222222222222222";
  const pool = "0x3333333333333333333333333333333333333333";
  assert.deepEqual(eventAddresses({ launcher, tokens: [{ token }], pools: [{ pool }] }), [launcher, token, pool]);
});

test("blocklist extracts nested launch mode, site and GitHub deployment addresses", () => {
  const addresses = Array.from({ length: 9 }, (_, index) => `0x${String(index + 1).repeat(40)}`);
  const event = {
    newContracts: [addresses[0], { address: addresses[1] }],
    changes: {
      newContracts: [addresses[2]],
      newFlapPools: [{ vaultFactory: addresses[3], quoteAddress: addresses[4] }],
    },
    mode: {
      vaultFactory: addresses[5],
      implementation: addresses[6],
      hook: addresses[7],
      quoteAsset: addresses[8],
    },
    changeEvidence: [{ subject: "factoryAddress", before: addresses[0], after: addresses[1] }],
  };
  assert.deepEqual(new Set(eventAddresses(event)), new Set(addresses));
});

test("malformed blocklist JSON keeps last-known-good file rules", async (t) => {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "blocklist-last-good-"));
  t.after(() => fs.rm(dataDir, { recursive: true, force: true }));
  const blocked = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const filename = path.join(dataDir, "blocked-contracts.json");
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  t.mock.method(console, "error", () => {});
  await fs.writeFile(filename, JSON.stringify({ addresses: [blocked] }));
  const config = { dataDir, blockedContracts: new Set() };

  assert.equal(await isEventBlocked(config, { contract: blocked }), true);
  await fs.writeFile(filename, "{not-valid-json");
  now += 5_001;
  assert.equal(await isEventBlocked(config, { changes: { newContracts: [blocked] } }), true);
  await fs.writeFile(filename, JSON.stringify({ addresses: ["not-an-address"] }));
  now += 5_001;
  assert.equal(await isEventBlocked(config, { mode: { implementation: blocked } }), true);
});
