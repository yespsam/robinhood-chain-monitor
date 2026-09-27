import { performance } from 'node:perf_hooks';

// Use only between serialized operations, never partway through a mutation.
// A Promise-only mutex can continuously refill the microtask queue and keep
// ready RPC/socket/timer callbacks from running. setImmediate gives the poll
// phase a turn without a fixed sleep or changing operation order.
export function createCooperativeTurn({
  budgetMs = 8,
  maxOperations = 32,
  now = () => performance.now(),
  yieldImpl = () => new Promise(resolve => setImmediate(resolve)),
} = {}) {
  let startedAt = now();
  let operations = 0;
  return () => {
    if (operations > 0 && (operations >= maxOperations || now() - startedAt >= budgetMs)) {
      return Promise.resolve(yieldImpl()).then(() => {
        startedAt = now();
        operations = 1;
      });
    }
    operations += 1;
    return undefined;
  };
}
