import test from "node:test";
import assert from "node:assert/strict";
import { id } from "ethers";
import { assessLocalTokenSecurity, evaluateLocalSecurity } from "../src/local-security.js";

const push4 = (signature) => `0x63${id(signature).slice(2, 10)}00`;

test("local security passes immutable-looking code with live liquidity", () => {
  const result = evaluateLocalSecurity({ code: "0x60006000", owner: null, implementation: null, liquidity: { confirmed: true, value: "1" } });
  assert.equal(result.decision, "pass");
  assert.equal(result.source, "local_onchain");
  assert.equal(result.metrics.coverage.liquidity, "confirmed_nonzero");
  assert.equal(result.metrics.coverage.sellability, "not_checked");
  assert.equal(result.metrics.coverage.holderConcentration, "not_checked");
  assert.match(result.label, /可卖性未验证/);
});

test("local security blocks mint, blacklist, owner and proxy powers", () => {
  const code = `${push4("mint(address,uint256)")}${push4("setBlacklist(address,bool)").slice(2)}`;
  const result = evaluateLocalSecurity({ code, owner: "0x1111111111111111111111111111111111111111", implementation: "0x2222222222222222222222222222222222222222", liquidity: { confirmed: true } });
  assert.equal(result.decision, "block");
  assert.ok(result.reasons.some((reason) => reason.includes("增发")));
  assert.ok(result.reasons.some((reason) => reason.includes("黑名单")));
});

test("local security never passes an unresolved EIP-1167 minimal proxy", () => {
  const implementation = "1111111111111111111111111111111111111111";
  const code = `0x363d3d373d3d3d363d73${implementation}5af43d82803e903d91602b57fd5bf3`;
  const result = evaluateLocalSecurity({ code, owner: null, liquidity: { confirmed: true, value: "1" } });
  assert.equal(result.decision, "block");
  assert.equal(result.metrics.proxyType, "eip1167");
  assert.equal(result.metrics.implementationResolved, false);
  assert.equal(result.metrics.coverage.proxy, "eip1167_implementation_unresolved");
  assert.ok(result.reasons.some((reason) => reason.includes("实现合约未解析")));
  assert.ok(result.reasons.some((reason) => reason.includes("买卖税费未验证")));
});

test("resolved EIP-1167 implementation stays blocked while sellability and tax are unverified", async () => {
  const token = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const pool = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
  const implementation = "0x1111111111111111111111111111111111111111";
  const proxyCode = `0x363d3d373d3d3d363d73${implementation.slice(2)}5af43d82803e903d91602b57fd5bf3`;
  const reserveResult = `0x${1n.toString(16).padStart(64, "0")}${1n.toString(16).padStart(64, "0")}${"0".repeat(64)}`;
  const provider = {
    getCode: async (address) => address.toLowerCase() === token ? proxyCode : "0x60006000",
    getStorage: async () => "0x",
    call: async ({ to }) => {
      if (to.toLowerCase() === pool) return reserveResult;
      throw new Error("not exposed");
    },
  };
  const result = await assessLocalTokenSecurity(provider, token, [{ pool, kind: "v2" }]);
  assert.equal(result.decision, "block");
  assert.equal(result.metrics.proxyType, "eip1167");
  assert.equal(result.metrics.proxyImplementation.toLowerCase(), implementation);
  assert.equal(result.metrics.implementationResolved, true);
  assert.equal(result.metrics.coverage.proxy, "eip1167_implementation_resolved");
  assert.equal(result.metrics.liquidityConfirmed, true);
  assert.equal(result.metrics.coverage.sellability, "not_checked");
  assert.equal(result.metrics.coverage.buySellTax, "not_checked");
  assert.ok(result.reasons.some((reason) => reason.includes("买卖税费未验证")));
});

test("clone templates embedded in larger factory bytecode are not mistaken for proxy runtimes", () => {
  const implementation = "1111111111111111111111111111111111111111";
  const template = `363d3d373d3d3d363d73${implementation}5af43d82803e903d91602b57fd5bf3`;
  const result = evaluateLocalSecurity({ code: `0x60006000${template}`, owner: null, liquidity: { confirmed: true, value: "1" } });
  assert.equal(result.decision, "pass");
  assert.equal(result.metrics.proxyType, null);
});
