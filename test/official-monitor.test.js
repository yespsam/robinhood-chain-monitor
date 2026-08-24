import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

test("official monitor source contains Robinhood and launchpad verified addresses", async () => {
  const source = await fs.readFile(new URL("../src/official-monitor.js", import.meta.url), "utf8");
  assert.match(source, /0x1E324B9316138CA9a73F960213621AD1aaf01B89/);
  assert.match(source, /0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB/);
  assert.match(source, /0x62B33A039D289CBDa50EbeB72Fe4261449E61Bcf/);
  assert.match(source, /0x280996bdDCd10A6eEc637Bfb55bD60131f31aa59/);
});
