import fs from "node:fs/promises";
import { launchEventDigest } from "./launch-event-identity.js";

export const FLAP_CANONICAL_PROJECTION_FILE = "paper-flap-canonical-state.json";
export const FLAP_CANONICAL_PROJECTION_SCHEMA = "paper_flap_canonical_v1";
export const FLAP_CANONICAL_PROJECTION_MAX_WINDOWS = 256;

// This is an ownership/revocation index, never an additional source of token
// evidence. Only the verified BSC producer may publish it after durable state.
export function buildFlapCanonicalProjection(state) {
  const firstThree = state?.officialSources?.flap?.quotePoolFirstThree || {};
  const rows = Object.entries(firstThree.windows || {}).map(([key, window]) => ({
    ...window,
    generationKey: key,
    active: window.active === true && window.status === "active"
      && firstThree.activeByQuote?.[window.quoteAddress] === key,
  })).sort((a, b) => Number(b.active) - Number(a.active)
    || Number(b.activationBlockNumber || 0) - Number(a.activationBlockNumber || 0)
    || Number(b.activationTransactionIndex || 0) - Number(a.activationTransactionIndex || 0)
    || Number(b.activationLogIndex || 0) - Number(a.activationLogIndex || 0)
    || a.generationKey.localeCompare(b.generationKey));
  const windows = {};
  for (const row of rows.slice(0, FLAP_CANONICAL_PROJECTION_MAX_WINDOWS)) {
    windows[row.generationKey] = {
      generationKey: row.generationKey,
      quoteAddress: row.quoteAddress,
      active: row.active,
      status: row.status,
      proofType: row.proofType,
      activationEventKey: row.activationEventKey,
      activationBlockHash: row.activationBlockHash,
      activationTransactionHash: row.activationTransactionHash,
      activationBlockNumber: row.activationBlockNumber,
      activationTransactionIndex: row.activationTransactionIndex,
      activationLogIndex: row.activationLogIndex,
      supersedesGenerationKey: row.supersedesGenerationKey || null,
      supersededByGenerationKey: row.supersededByGenerationKey || null,
      // Orphaned slots are deliberately absent; a stale compact-feed event
      // cannot resurrect them while replacement proof is pending.
      slots: (row.slots || []).slice(0, 3).map((slot) => ({
        eventKey: slot.eventKey,
        ordinal: slot.ordinal,
        tokenAddress: slot.tokenAddress,
        transactionHash: slot.transactionHash,
        blockHash: slot.blockHash,
        blockNumber: slot.blockNumber,
        transactionIndex: slot.transactionIndex,
        logIndex: slot.logIndex,
        proofDigest: slot.event ? launchEventDigest(slot.event) : null,
      })),
    };
  }
  return {
    schema: FLAP_CANONICAL_PROJECTION_SCHEMA,
    version: 1,
    source: "bsc-launchpad-monitor",
    status: "ready",
    truncated: rows.length > FLAP_CANONICAL_PROJECTION_MAX_WINDOWS,
    windows,
  };
}

export function createFlapCanonicalProjectionWriter({ file, atomicWrite, now = Date.now, fsImpl = fs }) {
  let publishedFingerprint = null;
  let invalidated = false;
  const timestamp = () => new Date(Number(now())).toISOString();
  const failure = (cause) => Object.assign(new Error(`Flap canonical ownership projection failed: ${cause.message}`), {
    code: "BSC_FLAP_CANONICAL_PROJECTION_FAILED", cause,
  });
  async function invalidate() {
    publishedFingerprint = null;
    const tombstone = { schema: FLAP_CANONICAL_PROJECTION_SCHEMA, version: 1,
      source: "bsc-launchpad-monitor", status: "updating", generatedAt: timestamp(), windows: {} };
    try {
      await atomicWrite(file, tombstone);
      invalidated = true;
    } catch (cause) {
      // Best-effort removal of this derived index is revocation, not deletion
      // of history. If even removal fails, expose that failure and stop saves;
      // no new authorization or alert may cross the failed durable boundary.
      try { await fsImpl.unlink(file); invalidated = true; }
      catch (unlinkError) {
        if (unlinkError.code === "ENOENT") invalidated = true;
        else cause.projectionRevocationError = unlinkError;
      }
      throw failure(cause);
    }
  }
  return {
    invalidate,
    beforeSave(snapshot) {
      const fingerprint = JSON.stringify(buildFlapCanonicalProjection(snapshot));
      if (fingerprint !== publishedFingerprint && !invalidated) return invalidate();
      return null;
    },
    async afterSave(durableSnapshot) {
      const projection = buildFlapCanonicalProjection(durableSnapshot);
      const fingerprint = JSON.stringify(projection);
      if (fingerprint === publishedFingerprint && !invalidated) return;
      try {
        await atomicWrite(file, { ...projection, generatedAt: timestamp(),
          journalRevision: Number(durableSnapshot?.journalRevision || 0) });
      } catch (cause) {
        // Atomic replacement can fail after rename (e.g. directory fsync).
        // Revoke even when a seemingly ready file is now present.
        try { await invalidate(); } catch (revocationError) { cause.projectionRevocationError = revocationError; }
        throw failure(cause);
      }
      publishedFingerprint = fingerprint;
      invalidated = false;
    },
  };
}
