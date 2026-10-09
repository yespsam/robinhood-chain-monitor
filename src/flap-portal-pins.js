// Shared by the producer, alert source gate and health checks. No network or
// runtime side effects: importing the monitor here would create alert cycles.
// Verified 2026-09-30; see FLAP_PORTAL_UPGRADE_* evidence in the producer.
export const FLAP_PORTAL_VERIFIED_VERSION = 'v5.24.0';
export const FLAP_PORTAL_VERIFIED_IMPLEMENTATION = '0x27a0f9Da7F5BEAd616fe0bf02bf0c793bece4e20';
export const FLAP_PORTAL_VERIFIED_IMPLEMENTATION_HASH = '0xb191694f7248773f714234aeb150149a2b9af5d1ab483a53d31c19ec3132b230';
