import { parentPort, workerData } from 'node:worker_threads';
import { createWalletAddressLibrary } from './wallet-address-library.js';

const library = createWalletAddressLibrary({ dataDir: workerData.dataDir });
parentPort.on('message', async ({ id, command, input }) => {
  if (command === 'stop') { await library.stop(); parentPort.close(); return; }
  const summary = await library.capture(input);
  parentPort.postMessage({ id, summary });
});
