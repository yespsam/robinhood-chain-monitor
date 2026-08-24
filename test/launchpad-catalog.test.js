import test from "node:test";
import assert from "node:assert/strict";
import { launchpadByFactory, launchpadByGmgnPlatform, launchpadFactoryAddresses, registerLaunchpadFactory } from "../src/launchpad-catalog.js";

test("matches pons factory without checksum sensitivity", () => {
  assert.equal(launchpadByFactory("0xA5aAb3F0c6EeadF30Ef1D3Eb997108E976351feB")?.id, "pons");
});

test("attributes both official Flap Robinhood entry contracts", () => {
  const portal = launchpadByFactory("0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09");
  const vaultPortal = launchpadByFactory("0xE9F7AB7DE8FB8756ACBB6A1CD13316A43308197B");

  assert.equal(portal?.id, "flap");
  assert.equal(portal?.name, "Flap");
  assert.equal(portal?.website, "https://flap.sh");
  assert.equal(vaultPortal?.id, "flap");
  assert.equal(vaultPortal?.docs, "https://docs.flap.sh/flap");
  assert.equal(
    launchpadByFactory("0x7777C8743C88B3aff3cf262135beF2c8b2e83333"),
    null,
    "token implementations must not be treated as launch entry contracts",
  );
});

test("attributes official Pools.trade liquidity-launcher strategies to Uniswap", () => {
  for (const address of [
    "0x0000FffFBE8efE702c8703aE3477FF5dE3d319C0",
    "0x05d552391067389EE44fec3924157ed33F976000",
    "0x23f8209572b4a1C2AD88A42749E830791Fb027f1",
    "0xAD44D55E7f8337C3cE113fBb591486E85be104b2",
    "0x1242c9439d589cAE85E121B1f79f2aF51e91DCEE",
  ]) {
    const launchpad = launchpadByFactory(address);
    assert.equal(launchpad?.id, "uniswap-pools");
    assert.equal(launchpad?.twitter, "https://x.com/TradePools");
  }
});

test("matches GMGN launchpad platform", () => {
  assert.equal(launchpadByGmgnPlatform("noxa")?.twitter, "https://x.com/NoxaLaunchpad");
});

test("exposes known factories for bytecode attribution", () => {
  assert.ok(launchpadFactoryAddresses().includes("0xa5aab3f0c6eeadf30ef1d3eb997108e976351feb"));
  assert.ok(launchpadFactoryAddresses().includes("0xa2763ec712a582a8450d7db932081ebfe8d951f8"));
  assert.ok(launchpadFactoryAddresses().includes("0x26605f322f7ff986f381bb9a6e3f5dab0beaeb09"));
  assert.ok(launchpadFactoryAddresses().includes("0xe9f7ab7de8fb8756acbb6a1cd13316a43308197b"));
});

test("registers a newly discovered version factory without duplicates", () => {
  const address = "0x1111111111111111111111111111111111111111";
  assert.equal(registerLaunchpadFactory("pons", address), true);
  assert.equal(registerLaunchpadFactory("pons", address.toUpperCase().replace(/^0X/, "0x")), false);
  assert.equal(launchpadByFactory(address)?.id, "pons");
  assert.equal(registerLaunchpadFactory("missing", "0x2222222222222222222222222222222222222222"), false);
  assert.equal(registerLaunchpadFactory("pons", "not-an-address"), false);
});
