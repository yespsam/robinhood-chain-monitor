import test from "node:test";
import assert from "node:assert/strict";
import { isVerifiedFlapPortalEvidenceIdentity } from "../src/flap-portal-pins.js";

const identities = {
  v523: {
    portalVersion: "v5.23.1",
    portalImplementation: "0xAb8Ec926b6e113c2212aF152b086eA62d1FDced9",
    portalImplementationCodeHash: "0x78653cdd7296d940ae531c86bc6700ae163f1f9dec002c2af3143c9ae6696a15",
  },
  v524: {
    portalVersion: "v5.24.0",
    portalImplementation: "0x27a0f9Da7F5BEAd616fe0bf02bf0c793bece4e20",
    portalImplementationCodeHash: "0xb191694f7248773f714234aeb150149a2b9af5d1ab483a53d31c19ec3132b230",
  },
  v525: {
    portalVersion: "v5.25.0",
    portalImplementation: "0xE13227370996f892a56d2Ff4a30f6026887B48Fb",
    portalImplementationCodeHash: "0xf8d56fe09f2ec5e3eeaabdbfeeb0faf55e4ed8996a55bc1b69a78e62dbb792e4",
  },
  v526: {
    portalVersion: "v5.26.0",
    portalImplementation: "0x7a94f37b61a82c395f9812CF266b444783cC5e8c",
    portalImplementationCodeHash: "0x3db27f98826706ac5ddedb919594d4670151874482dff23e31d2186858635194",
  },
  v527: {
    portalVersion: "v5.27.2",
    portalImplementation: "0x6FC1ac64c90A5A6d9E7EFc0d4064452AF3FC9968",
    portalImplementationCodeHash: "0x90b3b19ddc87293d5bbd33167d7d977adf1cda5c078549b8cada05c6f9b3fa75",
  },
};
const proof = (identity, head) => ({
  ...identity, configurationVerifiedAtBlock: head, finalizedHead: head,
});

test("Flap proof pins admit only complete tuples in established evidence windows", () => {
  for (const [version, head, expected] of [
    ["v523", 0, true],
    ["v523", 123_307_496, true],
    ["v523", 123_307_497, false],
    ["v524", 123_307_496, false],
    ["v524", 123_307_497, true],
    ["v524", 128_103_370, true],
    ["v524", 128_103_371, false],
    ["v524", 128_501_895, false],
    ["v525", 128_103_370, false],
    ["v525", 128_501_894, false],
    ["v525", 128_501_895, true],
    ["v525", 128_914_121, true],
    ["v525", 128_914_122, false],
    ["v525", 128_914_178, false],
    ["v525", 128_914_179, false],
    ["v526", 128_914_121, false],
    ["v526", 128_914_122, false],
    ["v526", 128_914_178, false],
    ["v526", 128_914_179, true],
    ["v526", 128_920_137, true],
    ["v526", 129_871_643, true],
    ["v526", 129_871_644, false],
    ["v527", 129_871_643, false],
    ["v527", 129_871_644, true],
    ["v527", 130_645_000, true],
  ]) {
    const value = proof(identities[version], head);
    const before = structuredClone(value);
    assert.equal(isVerifiedFlapPortalEvidenceIdentity(value), expected, `${version} at ${head}`);
    assert.deepEqual(value, before);
  }
});

test("Flap proof pins reject stitched identities, unknown versions and missing fields", () => {
  const valid = proof(identities.v527, 129_871_644);
  for (const [field, value] of [
    ["portalVersion", "v5.28.0"],
    ["portalVersion", identities.v524.portalVersion],
    ["portalImplementation", identities.v524.portalImplementation],
    ["portalImplementationCodeHash", identities.v524.portalImplementationCodeHash],
  ]) assert.equal(isVerifiedFlapPortalEvidenceIdentity({ ...valid, [field]: value }), false, field);
  for (const field of Object.keys(valid)) {
    const missing = { ...valid };
    delete missing[field];
    assert.equal(isVerifiedFlapPortalEvidenceIdentity(missing), false, `missing ${field}`);
  }
  for (const value of [null, undefined, {}, []]) assert.equal(isVerifiedFlapPortalEvidenceIdentity(value), false);
});

test("Flap proof pins require equal nonnegative safe integer verification heights", () => {
  const valid = proof(identities.v527, 129_871_644);
  for (const head of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "128501895", null]) {
    assert.equal(isVerifiedFlapPortalEvidenceIdentity(proof(identities.v525, head)), false, String(head));
  }
  assert.equal(isVerifiedFlapPortalEvidenceIdentity({
    ...valid, configurationVerifiedAtBlock: valid.finalizedHead + 1,
  }), false);
});
