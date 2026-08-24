import { launchpadByFactory, launchpadFactoryAddresses } from "./launchpad-catalog.js";
import { isThreePlatformScope } from "./source-controls.js";

const FOCUS3_ROBINHOOD_PLATFORM_IDS = new Set(["flap", "uniswap-pools"]);
const FOCUS3_MAX_CATCHUP_BLOCKS = 400;

function normalizedAddress(value) {
  const address = String(value || "").trim().toLowerCase();
  return /^0x[0-9a-f]{40}$/.test(address) ? address : null;
}

export function focus3RobinhoodFactoryAddresses() {
  return launchpadFactoryAddresses()
    .filter((address) => FOCUS3_ROBINHOOD_PLATFORM_IDS.has(launchpadByFactory(address)?.id))
    .map((address) => normalizedAddress(address))
    .filter(Boolean);
}

export function createRobinhoodScanPolicy(config) {
  const focused = isThreePlatformScope(config);
  const exactFactories = new Set(focused ? focus3RobinhoodFactoryAddresses() : []);

  return {
    focused,
    exactFactories,
    shouldAnalyzeTransaction(transaction) {
      if (!focused) return true;
      const destination = normalizedAddress(transaction?.to);
      return destination !== null && exactFactories.has(destination);
    },
    retainedFactoryScoreEntries(entries) {
      if (!focused) return [...entries];
      return [...entries].filter(([address]) => exactFactories.has(normalizedAddress(address)));
    },
    catchupLimit(configuredLimit) {
      const configured = Number(configuredLimit);
      if (!focused || !Number.isFinite(configured) || configured <= 0) return configuredLimit;
      return Math.min(configured, FOCUS3_MAX_CATCHUP_BLOCKS);
    },
  };
}

export async function loadRobinhoodSignalCandidate(provider, transactionHash, policy) {
  if (!policy.focused) {
    const [transaction, receipt] = await Promise.all([
      provider.getTransaction(transactionHash),
      provider.getTransactionReceipt(transactionHash),
    ]);
    return transaction && receipt ? { transaction, receipt } : null;
  }

  // Pool events are emitted by the downstream DEX, so filtering eth_getLogs
  // by the launchpad address would lose valid Flap/Pools.trade transactions.
  // Resolve only the lightweight transaction first, then refuse every caller
  // except an exact catalogued factory before requesting its full receipt.
  const transaction = await provider.getTransaction(transactionHash);
  if (!transaction || !policy.shouldAnalyzeTransaction(transaction)) return null;
  const receipt = await provider.getTransactionReceipt(transactionHash);
  return receipt ? { transaction, receipt } : null;
}
