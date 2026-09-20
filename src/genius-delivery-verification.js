import { createGeniusChainReader, GENIUS_FACTORY } from "./genius-chain-reader.js";
import { isStrictGeniusEvent } from "./genius-source-policy.js";

const stable = value => Array.isArray(value) ? `[${value.map(stable).join(",")}]`
  : value && typeof value === "object" ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const lower = value => String(value || "").toLowerCase();
const failure = (code, message) => Object.assign(new Error(`${code}: ${message}`), { code });

/** Revalidate a queued observation, not token safety or trading eligibility. */
export async function assertGeniusChainDeliveryCanonical(config, event) {
  if (event?.type !== "genius_fun_update" || event.sourceId !== "genius_chain") return;
  if (!isStrictGeniusEvent(event)) throw failure("GENIUS_DELIVERY_INVALID", "queued event failed source authentication");
  // A fresh reader uses configured, independently vetted origins. Never turn
  // URLs supplied in an event into outbound request authority.
  const factory = config.geniusDeliveryReaderFactory || createGeniusChainReader;
  const configured = Number(config.geniusDeliveryVerificationTimeoutMs);
  const budgetMs = Math.max(10, Math.min(15_000, Number.isFinite(configured) && configured > 0 ? configured : 15_000));
  let reader;
  let timer;
  try {
    reader = factory({
      rpcUrls: config.geniusRpcUrls,
      logRpcUrls: config.geniusLogRpcUrls,
      timeoutMs: Math.max(10, Math.min(6_000, Number(config.geniusRequestTimeoutMs) || 6_000)),
      operationTimeoutMs: budgetMs,
      confirmations: 15,
    });
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { Promise.resolve(reader?.stop?.()).catch(() => {}); } catch { /* The deadline still rejects. */ }
        reject(failure("GENIUS_DELIVERY_TIMEOUT", "canonical verification exceeded its delivery budget"));
      }, budgetMs);
    });
    const range = await Promise.race([
      Promise.resolve().then(() => reader.readRange(event.blockNumber, event.blockNumber)),
      deadline,
    ]);
    const exact = range?.events?.find(log => log.blockNumber === event.blockNumber
      && lower(log.address) === lower(GENIUS_FACTORY)
      && lower(log.transactionHash) === lower(event.transactionHash)
      && log.logIndex === event.logIndex
      && lower(log.blockHash) === lower(event.blockHash)
      && log.name === event.evidence.eventName
      && Number.isSafeInteger(log.blockTimestamp)
      && log.blockTimestamp * 1000 === Date.parse(event.sourceOccurredAt)
      && stable(log.args) === stable(event.evidence.args));
    if (range?.fromBlock !== event.blockNumber || range?.toBlock !== event.blockNumber
      || range?.anchor?.number !== event.blockNumber
      || lower(range?.anchor?.hash) !== lower(event.blockHash) || !exact) {
      throw failure("GENIUS_DELIVERY_REORG", "queued event is absent or changed in the current canonical block");
    }
  } finally {
    clearTimeout(timer);
    // Strict reader.stop is synchronous and cancels all queued/in-flight RPCs.
    // Observe an injected asynchronous cleanup without extending the lease.
    try { Promise.resolve(reader?.stop?.()).catch(() => {}); } catch { /* No leaked deadline. */ }
  }
}
