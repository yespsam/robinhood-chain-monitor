import { isThreePlatformScope } from "./source-controls.js";

export const FOCUS3_MONITOR_START_DELAYS_MS = Object.freeze({
  bsc: 0,
  github: 1_000,
  binance: 2_000,
  "platform-capability": 3_000,
  twitter: 4_000,
  uniswap: 5_000,
  site: 10_000,
});

export function createBoundedStartupQueue(limit = 250) {
  const maximum = Math.max(1, Number(limit) || 1);
  const pending = new Map();
  return {
    remember(key, value) {
      if (pending.has(key)) pending.delete(key);
      pending.set(key, value);
      if (pending.size > maximum) pending.delete(pending.keys().next().value);
    },
    drain() {
      const values = [...pending.values()];
      pending.clear();
      return values;
    },
    get size() {
      return pending.size;
    },
  };
}

export function startIndependentMonitor(config, name, start, options = {}) {
  const delayMs = isThreePlatformScope(config)
    ? Number(FOCUS3_MONITOR_START_DELAYS_MS[name] || 0)
    : 0;
  if (delayMs === 0) return start();

  const setTimer = options.setTimer || setTimeout;
  return setTimer(() => {
    try {
      start();
    } catch (error) {
      options.onError?.(error);
      // Match the pre-stagger behavior: a constructor failure is fatal and
      // lets launchd restart the complete monitor set instead of leaving one
      // lane silently disabled for the lifetime of the process.
      throw error;
    }
  }, delayMs);
}
