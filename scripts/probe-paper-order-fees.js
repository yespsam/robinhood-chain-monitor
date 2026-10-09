// Explicit one-shot research tool. No daemon, writes, signing or broadcasting.
import fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGmgnAccountGate } from '../src/gmgn-account-gate.js';
import { createPaperOrderFeeProbe } from '../src/paper-order-fee-probe.js';
const [chain, address, amount] = process.argv.slice(2);
if (!['bsc', 'eth'].includes(chain) || !/^0x[0-9a-f]{40}$/i.test(address || '') || !/^[1-9][0-9]*$/.test(amount || '')) {
  throw Error('Usage: node scripts/probe-paper-order-fees.js bsc|eth CA native_amount_in_wei');
}
const prefs = JSON.parse(await fs.readFile(new URL('../data/wallet-funding-preferences.json', import.meta.url), 'utf8'));
const wallet = prefs.preferredWallets?.[chain];
if (!/^0x[0-9a-f]{40}$/i.test(wallet || '')) throw Error('No configured public wallet for this chain; no wallet substitution');
const gate = createGmgnAccountGate(new URL('../data', import.meta.url).pathname);
const probe = createPaperOrderFeeProbe({ quote: async ({ chain, wallet, input, output, amount }) => {
  const { stdout } = await gate(() => promisify(execFile)('gmgn-cli', ['order', 'quote', '--chain', chain,
    '--from', wallet, '--input-token', input, '--output-token', output, '--amount', amount, '--slippage', '1', '--raw'],
  { timeout: 18000, maxBuffer: 500000 }), AbortSignal.timeout(30000));
  const result = JSON.parse(stdout);
  if (result.error || result.success === false || result.code != null && ![0, 200].includes(Number(result.code))) throw Error('quote_failed');
  return result.data ?? result;
} });
const result = await probe.run({ chain, address, wallet, inputAmount: amount });
console.log(JSON.stringify(result));
if (result.status !== 'roundtrip_simulated') process.exitCode = 1;
