import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readOutboxJson, outboxJsonChunks } from "../src/outbox-json.js";

const execute = promisify(execFile);

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "outbox-json-test-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return path.join(directory, "outbox.json");
}

test("streaming roundtrip preserves all maps, statuses, unknown fields and JSON property semantics", async (t) => {
  const file = await fixture(t);
  const value = JSON.parse('{"version":2,"events":{"__proto__":{"status":"delivered","event":{"text":"中文🚀\\\"\\\\{}[]"}},"suppressed":{"status":"suppressed","destinations":{"telegram":{"status":"disabled"}}},"failed":{"status":"failed","destinations":{"telegram":{"status":"failed","nextAttemptAt":"2026-10-12T00:00:00Z"}}},"sending":{"status":"pending","destinations":{"telegram":{"status":"sending","leaseUntil":"2026-10-12T01:00:00Z"}}}},"immutableOpenFourSignalOwners":{"key":{"eventId":"delivered"}},"fourRegistryDeliveryOwners":{"owner":{"status":"delivered"}},"unknown":{"nested":[null,true,false,-0,1.25e3]},"__proto__":{"safe":true}}');
  const handle = await fs.open(file, "wx", 0o600);
  try { await handle.writeFile(outboxJsonChunks(value), "utf8"); }
  finally { await handle.close(); }
  const read = await readOutboxJson(file);
  assert.deepEqual(read, JSON.parse(JSON.stringify(value)));
  assert.equal(Object.getPrototypeOf(read), Object.prototype);
  assert.equal(Object.getPrototypeOf(read.events), Object.prototype);
  assert.equal(Object.hasOwn(read, "__proto__"), true);
  assert.equal(Object.hasOwn(read.events, "__proto__"), true);
});

test("filtered reads keep only exact event IDs, while preserving owners and metadata", async (t) => {
  const file = await fixture(t);
  const value = { version: 2, events: { a: { status: "delivered" }, b: { status: "failed" } },
    immutableOpenFourSignalOwners: { a: { eventId: "a" } }, fourRegistryDeliveryOwners: { b: { eventId: "b" } }, unknown: [1, 2] };
  await fs.writeFile(file, JSON.stringify(value));
  assert.deepEqual(await readOutboxJson(file, { eventIds: new Set(["b"]) }), { ...value, events: { b: value.events.b } });
  assert.deepEqual(await readOutboxJson(file, { eventIds: [] }), { ...value, events: {} });
  await assert.rejects(readOutboxJson(file, { eventIds: "a" }), TypeError);
});

test("chunk boundaries preserve Unicode, escapes, long keys and nested value syntax", async (t) => {
  const file = await fixture(t);
  const key = `${"k".repeat(65530)}\\\"🚀`;
  // JSON string opening quote consumes one character; the pair crosses the
  // writer's first 65536-character boundary without its explicit safeguard.
  const value = { version: 2, events: { [key]: { text: `${"a".repeat(65534)}🚀中文\\\"{}[],\n`, nested: [{ text: "\\\\\\\"" }] } },
    other: `${"a".repeat(65534)}🚀`, owners: null };
  let maximum = 0;
  function* observed() {
    for (const chunk of outboxJsonChunks(value)) {
      maximum = Math.max(maximum, chunk.length);
      assert.ok(!/[\uD800-\uDBFF]$/.test(chunk), "a write chunk cannot end in half a surrogate pair");
      yield chunk;
    }
  }
  await fs.writeFile(file, observed(), "utf8");
  assert.ok(maximum <= 65536);
  assert.deepEqual(await readOutboxJson(file), value);
});

test("duplicate keys have JSON.parse last-value-wins behavior including selected events", async (t) => {
  const file = await fixture(t);
  const source = '{"version":1,"version":2,"events":{"a":0,"a":{"status":"delivered"}},"unknown":1,"unknown":2}';
  await fs.writeFile(file, source);
  assert.deepEqual(await readOutboxJson(file), JSON.parse(source));
  assert.deepEqual(await readOutboxJson(file, { eventIds: ["a"] }), JSON.parse(source));
});

test("non-object map values and optional undefined fields match ordinary JSON serialization", async (t) => {
  const file = await fixture(t);
  const value = { version: 2, events: null, immutableOpenFourSignalOwners: [1, null], fourRegistryDeliveryOwners: false,
    absent: undefined, nested: { absent: undefined, nan: NaN } };
  await fs.writeFile(file, outboxJsonChunks(value), "utf8");
  assert.deepEqual(await readOutboxJson(file), JSON.parse(JSON.stringify(value)));
  assert.throws(() => [...outboxJsonChunks([])], TypeError);
});

test("malformed or truncated JSON fails closed, including unselected event payloads", async (t) => {
  const file = await fixture(t);
  const invalid = [
    "", " ", "null", "[]", "{} trailing", "{}{}", '{"version":2', '{"events":',
    '{"events":{', '{"events":{"skip":{"x":01}}}', '{"events":{"skip":{"x":true,}}}',
    '{"events":{"skip":{"x":"\\q"}}}', '{"events":{"skip":{"x":"unterminated}}}',
    '{"events":{"skip":{"x":[1,2}}}}', '{"events":{"skip":{"x":"line\nbreak"}}}',
    '{"events":{"skip":undefined}}', '{"events":{"skip":1,}}', '{"events":{"skip":1} "version":2}',
    '{"events":{"skip":true false}}', '{"events":{]}}', '{"events":{"skip":1e}}',
  ];
  for (const source of invalid) {
    await fs.writeFile(file, source);
    await assert.rejects(readOutboxJson(file, { eventIds: [] }), SyntaxError, source);
  }
  await assert.rejects(readOutboxJson(`${file}.missing`), { code: "ENOENT" });
});

test("large synthetic outbox reads and rewrites under a 96 MiB V8 heap without full-document strings", { timeout: 60000 }, async (t) => {
  const file = await fixture(t);
  const moduleUrl = new URL("../src/outbox-json.js", import.meta.url).href;
  const program = `
    import fs from 'node:fs/promises';
    import assert from 'node:assert/strict';
    import { readOutboxJson, outboxJsonChunks } from ${JSON.stringify(moduleUrl)};
    const file = process.argv[1];
    const count = 12000;
    const text = '中'.repeat(2048);
    function* initial() {
      yield '{"version":2,"events":{';
      for (let i = 0; i < count; i++) {
        if (i) yield ',';
        yield JSON.stringify('event-' + i) + ':' + JSON.stringify({id:'event-' + i, status:i % 2 ? 'suppressed' : 'delivered', event:{text:text + i}, destinations:{telegram:{status:i % 2 ? 'disabled' : 'delivered'}}});
      }
      yield '},"immutableOpenFourSignalOwners":{"proof":{"eventId":"event-0"}},"fourRegistryDeliveryOwners":{},"unknown":{"keep":true}}';
    }
    await fs.writeFile(file, initial(), 'utf8');
    const bytes = (await fs.stat(file)).size;
    const outbox = await readOutboxJson(file);
    assert.equal(Object.keys(outbox.events).length, count);
    await fs.writeFile(file + '.copy', outboxJsonChunks(outbox), 'utf8');
    const selected = await readOutboxJson(file + '.copy', {eventIds:['event-0','event-11999']});
    assert.deepEqual(selected.events['event-0'], outbox.events['event-0']);
    assert.deepEqual(selected.events['event-11999'], outbox.events['event-11999']);
    assert.equal(Object.keys(selected.events).length, 2);
    assert.equal(selected.unknown.keep, true);
    assert.equal(selected.immutableOpenFourSignalOwners.proof.eventId, 'event-0');
    console.log(JSON.stringify({count, bytes, heapUsed:process.memoryUsage().heapUsed}));
  `;
  const { stdout } = await execute(process.execPath, ["--max-old-space-size=96", "--input-type=module", "-e", program, file],
    { timeout: 55000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.count, 12000);
  assert.ok(result.bytes > 70 * 1024 * 1024);
  t.diagnostic(`synthetic bytes=${result.bytes}; final heapUsed=${result.heapUsed}; child heap limit=96 MiB`);
});
