// Shared by the producer, alert source gate and health checks. No network or
// runtime side effects: importing the monitor here would create alert cycles.
// Two-source fixed-block proof and interface checks:
// docs/flap-v526-compatibility-evidence-2026-10-21.json, block 128920137.
export const FLAP_PORTAL_VERIFIED_VERSION = 'v5.26.0';
export const FLAP_PORTAL_VERIFIED_IMPLEMENTATION = '0x7a94f37b61a82c395f9812CF266b444783cC5e8c';
export const FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH = '0x3db27f98826706ac5ddedb919594d4670151874482dff23e31d2186858635194';

// Canonical EIP-1967 activation receipt: PublicNode returned the matching
// Upgraded(address) log and BNB Data Seed independently returned its successful
// canonical receipt and block header. This is an activation proof, not source
// verification or a security audit of the implementation.
export const FLAP_PORTAL_V526_UPGRADE_BLOCK = 128_914_179;
export const FLAP_PORTAL_V526_UPGRADE_BLOCK_HASH = '0x025425840e296cff96ca378705da73882429d0b8cff3276c81bec26494e07616';
export const FLAP_PORTAL_V526_UPGRADE_TRANSACTION = '0x04791db127459ee67718e1ce7610fc87c90483a94411b8c143d97db1bb8cd702';

// Historical immutable receipt proofs remain historical. These bounds describe
// independently supported identity windows, not permission to run an old Portal
// or to trade an old event. Gaps between verified windows stay unsupported.
const evidenceIdentities = Object.freeze([
  Object.freeze({
    version: FLAP_PORTAL_VERIFIED_VERSION,
    implementation: FLAP_PORTAL_VERIFIED_IMPLEMENTATION,
    codeHash: FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH,
    fromBlock: FLAP_PORTAL_V526_UPGRADE_BLOCK, throughBlock: Number.MAX_SAFE_INTEGER,
  }),
  Object.freeze({
    version: 'v5.25.0',
    implementation: '0xE13227370996f892a56d2Ff4a30f6026887B48Fb',
    codeHash: '0xf8d56fe09f2ec5e3eeaabdbfeeb0faf55e4ed8996a55bc1b69a78e62dbb792e4',
    fromBlock: 128501895, throughBlock: 128914121,
  }),
  Object.freeze({
    version: 'v5.24.0',
    implementation: '0x27a0f9Da7F5BEAd616fe0bf02bf0c793bece4e20',
    codeHash: '0xb191694f7248773f714234aeb150149a2b9af5d1ab483a53d31c19ec3132b230',
    fromBlock: 123307497, throughBlock: 128103370,
  }),
  Object.freeze({
    version: 'v5.23.1',
    implementation: '0xAb8Ec926b6e113c2212aF152b086eA62d1FDced9',
    codeHash: '0x78653cdd7296d940ae531c86bc6700ae163f1f9dec002c2af3143c9ae6696a15',
    fromBlock: 0, throughBlock: 123307496,
  }),
]);

export function isVerifiedFlapPortalEvidenceIdentity(evidence) {
  const block = evidence?.configurationVerifiedAtBlock;
  return Number.isSafeInteger(block) && block === evidence.finalizedHead
    && evidenceIdentities.some(identity => evidence.portalVersion === identity.version
      && evidence.portalImplementation === identity.implementation
      && evidence.portalImplementationCodeHash === identity.codeHash
      && block >= identity.fromBlock && block <= identity.throughBlock);
}
