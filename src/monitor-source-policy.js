import fs from "node:fs";
import path from "node:path";

// Non-secret operator choices live separately from credentials. A disabled
// platform is not the shared worker: GMGN, Binance and public X stay enabled.
export function loadMonitorSourcePolicy(dataDir) {
  try {
    const policy = JSON.parse(fs.readFileSync(path.join(dataDir, "monitor-source-policy.json"), "utf8"));
    if (policy.version !== 1 || typeof policy.fomoPlatformSourcesEnabled !== "boolean") throw new Error("invalid policy");
    return { fomoPlatformSourcesEnabled: policy.fomoPlatformSourcesEnabled, monitorSourcePolicyStatus: "loaded" };
  } catch (error) {
    if (error.code === "ENOENT") return { fomoPlatformSourcesEnabled: true, monitorSourcePolicyStatus: "default" };
    // A broken cancellation file must not silently re-enable the platform.
    return { fomoPlatformSourcesEnabled: false, monitorSourcePolicyStatus: "invalid_disabled" };
  }
}

export function monitorSourceOverrides(policy) {
  return {
    ...policy,
    ...(policy.fomoPlatformSourcesEnabled === false ? {
      fomoBuyMonitorEnabled: false,
      fomoPublishedCallEnabled: false,
    } : {}),
  };
}

export function isCancelledFomoPlatformEvent(config, event) {
  if (config?.fomoPlatformSourcesEnabled !== false) return false;
  const sourceId = String(event?.source?.id || "").toLowerCase();
  return event?.signalKind === "fomo_published_call"
    || ["fomo_family_official_thesis", "fomoscan_thesis_relay", "fomoscan_onchain"].includes(sourceId)
    || sourceId.startsWith("fomoscan_")
    || String(event?.caller?.walletBinding?.proofSource || event?.walletBinding?.proofSource || "").toLowerCase() === "fomoscan";
}
