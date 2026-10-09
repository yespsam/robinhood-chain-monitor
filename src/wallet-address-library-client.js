import { Worker } from 'node:worker_threads';

// A single local worker, driven by the existing learner's paced cycle. No
// timers, network, additional model requests, or growing in-memory address set.
export function createWalletAddressLibraryClient({ dataDir, timeoutMs = 60_000 } = {}) {
  let worker, pending, status = null, sequence = 0, stopped = false;
  function failure() {
    status = { ...status, status: 'error', lastError: 'address_library_worker_unavailable', autoFollow: false };
    if (pending) { clearTimeout(pending.timer); pending.resolve(structuredClone(status)); pending = null; }
  }
  function start() {
    if (worker) return;
    const current = new Worker(new URL('./wallet-address-library-worker.js', import.meta.url), { workerData: { dataDir }, execArgv: [] });
    worker = current;
    current.on('message', ({ id, summary }) => {
      if (!pending || pending.id !== id) return;
      status = summary; clearTimeout(pending.timer); pending.resolve(structuredClone(status)); pending = null;
    });
    current.on('error', () => { if (worker === current) failure(); });
    current.on('exit', () => { if (worker === current) { worker = null; if (pending) failure(); } });
  }
  return {
    snapshot: () => status ? structuredClone(status) : null,
    capture(input) {
      if (stopped) return Promise.resolve(status);
      if (pending) return pending.promise;
      start(); const id = ++sequence;
      let resolve; const promise = new Promise(r => { resolve = r; });
      const timer = setTimeout(() => { const current = worker; failure(); worker = null; void current?.terminate(); }, timeoutMs);
      pending = { id, resolve, promise, timer };
      try { worker.postMessage({ id, command: 'capture', input }); } catch { failure(); }
      return promise;
    },
    async stop() {
      stopped = true; if (pending) await pending.promise;
      if (worker) {
        const current = worker;
        await new Promise(resolve => { current.once('exit', resolve); current.postMessage({ command: 'stop' }); });
      }
    },
  };
}
