import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import {
  assertAllowedCliArgs, createCliRunner, resolveCliInstallation, DOCUMENTED_CLI_VERSION
} from '../server/official-cli.mjs';

const usdt = '0x55d398326f99059fF775485246999027B3197955';
const native = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';
const quote = ['market-order', 'quote', '--fromTokenQty', '0.1', '--fromToken', native,
  '--toToken', usdt, '--binanceChainId', '56', '--slippage', '0.5'];
const reviewedMetadata = () => ({
  name: '@binance/agentic-wallet', version: DOCUMENTED_CLI_VERSION, bin: { baw: 'dist/index.js' }
});
const roots = [
  new URL('file:///opt/homebrew/lib/node_modules/@binance/agentic-wallet/'),
  new URL('file:///usr/local/lib/node_modules/@binance/agentic-wallet/'),
  new URL('file:///synthetic-project/node_modules/@binance/agentic-wallet/')
];
const missing = () => Object.assign(new Error('synthetic missing package'), { code: 'ENOENT' });

test('CLI allowlist preserves the dashboard reads, quote and explicit authentication commands', () => {
  const allowed = [
    ['wallet', 'status'], ['wallet', 'chains'], ['wallet', 'address'], ['wallet', 'settings'],
    ['wallet', 'balance', '--binanceChainId', '56'],
    ['wallet', 'balance', '--binanceChainId', '56', '--tokenAddress', usdt],
    ['wallet', 'balance', '--binanceChainId', 'CT_501', '--tokenAddress', 'So11111111111111111111111111111111111111112'],
    ...['all', 'pending', 'confirmed'].map(type => ['wallet', 'tx-history', '--binanceChainId', '56', '--type', type, '--size', '20']),
    ['market-order', 'list', '--binanceChainId', '8453', '--pageSize', '20'],
    ['limit-order', 'list', '--binanceChainId', '56', '--pageSize', '20'],
    ['approvals', 'list', '--binanceChainId', '1'],
    quote,
    ['auth', 'signin'], ['auth', 'verify', '--qrCodeId', 'synthetic-pairing-id-123'], ['auth', 'signout']
  ];
  for (const args of allowed) {
    assert.doesNotThrow(() => assertAllowedCliArgs(Object.freeze([...args])), args.join(' '));
  }
});

const forbidden = [
  ['wallet', 'send', '--binanceChainId', '56', '--to', usdt, '--amount', '1'],
  ['wallet', 'transfer'], ['wallet', 'swap'], ['wallet', 'execute'],
  ['market-order', 'swap'], ['market-order', 'execute'], ['market-order', 'create'],
  ['limit-order', 'create'], ['limit-order', 'cancel'], ['approvals', 'revoke'],
  ['transaction', 'send'], ['transaction', 'execute'], ['execute'],
  ['wallet', 'unknown'], ['unknown', 'status'],
  ['wallet', 'status', '--help'], ['wallet', 'status', '--execute'],
  ['wallet', 'status', '--binanceChainId', '56'],
  ['wallet', 'balance', '--binanceChainId', '56', '--unknown', 'value'],
  ['wallet', 'balance', '--binanceChainId', '56', '--binanceChainId', '1'],
  ['wallet', 'balance', '--binanceChainId', '56', '--binanceChainId', '56'],
  ['wallet', 'balance', '--binanceChainId=56'],
  ['wallet', 'status', '--json'], ['--json', 'wallet', 'status'],
  [...quote, '--json'], [...quote, '--slippage', '100'],
  ['auth', 'verify', '--qrCodeId', 'valid-id', '--qrCodeId', 'second-id'],
  ['wallet', 'status', 'market-order', 'swap'],
  ['wallet', 'status', '--', 'execute'],
  ['wallet', 'balance'], ['wallet', 'balance', '--binanceChainId'],
  ['wallet', 'balance', '--binanceChainId', '--json'],
  ['auth', 'verify'], ['auth', 'verify', '--qrCodeId', '--json'],
  [], null, 'wallet status', ['wallet', 'status', 1]
];

test('CLI allowlist rejects financial writes and ambiguous, injected or unrecognized arguments', () => {
  for (const args of forbidden) {
    assert.throws(() => assertAllowedCliArgs(args), `must reject ${JSON.stringify(args)}`);
  }
});

test('runner rejects forbidden commands before reading package metadata or executing a process', async () => {
  for (const useDiscovery of [false, true]) {
    let metadataReads = 0, executions = 0;
    const dependencies = useDiscovery ? {
      resolveInstallation: async () => {
        metadataReads++;
        return { root: roots[0], metadata: reviewedMetadata(), entryPath: fileURLToPath(new URL('dist/index.js', roots[0])) };
      }
    } : { readMetadata: async () => { metadataReads++; return reviewedMetadata(); } };
    const run = createCliRunner({
      ...dependencies,
      execute: async () => { executions++; return { stdout: '{"success":true}' }; }
    });
    for (const args of forbidden) await assert.rejects(run(args), `must reject ${JSON.stringify(args)}`);
    assert.equal(metadataReads, 0);
    assert.equal(executions, 0);
  }
});

test('runner adds its own JSON flag once and launches allowed arguments without a shell', async () => {
  let executions = 0;
  const run = createCliRunner({
    readMetadata: async () => reviewedMetadata(),
    execute: async (exe, args, options) => {
      executions++;
      assert.equal(exe, process.execPath);
      assert.deepEqual(args.slice(1), [...quote, '--json']);
      assert.equal(args.filter(arg => arg === '--json').length, 1);
      assert.equal(options.shell, false);
      return { stdout: '{"success":true,"data":{"toCoinAmount":"1"}}' };
    }
  });
  assert.deepEqual(await run(quote), { success: true, data: { toCoinAmount: '1' } });
  assert.equal(executions, 1);
});

test('CLI discovery uses the first reviewed global package and derives its executable path', async () => {
  const seen = [], metadata = reviewedMetadata();
  const result = await resolveCliInstallation({ roots, readMetadataAt: async url => {
    assert.ok(url instanceof URL);
    seen.push(url.href);
    return metadata;
  } });
  assert.deepEqual(seen, [new URL('package.json', roots[0]).href]);
  assert.equal(result.root.href, roots[0].href);
  assert.deepEqual(result.metadata, metadata);
  assert.equal(result.entryPath, fileURLToPath(new URL('dist/index.js', roots[0])));
});

test('runner executes the reviewed entry selected by discovery', async () => {
  const entryPath = fileURLToPath(new URL('dist/index.js', roots[0]));
  let executions = 0;
  const run = createCliRunner({
    resolveInstallation: async () => ({ root: roots[0], metadata: reviewedMetadata(), entryPath }),
    execute: async (exe, args, options) => {
      executions++;
      assert.equal(exe, process.execPath);
      assert.deepEqual(args, [entryPath, 'wallet', 'status', '--json']);
      assert.equal(options.shell, false);
      return { stdout: '{"success":true}' };
    }
  });
  await run(['wallet', 'status']);
  assert.equal(executions, 1);
});

test('CLI discovery falls back in order only when earlier package metadata is absent', async () => {
  for (const foundAt of [1, 2]) {
    const seen = [];
    const result = await resolveCliInstallation({ roots, readMetadataAt: async url => {
      seen.push(url.href);
      if (url.href === new URL('package.json', roots[foundAt]).href) return reviewedMetadata();
      throw missing();
    } });
    assert.deepEqual(seen, roots.slice(0, foundAt + 1).map(root => new URL('package.json', root).href));
    assert.equal(result.root.href, roots[foundAt].href);
    assert.equal(result.entryPath, fileURLToPath(new URL('dist/index.js', roots[foundAt])));
  }
});

test('an existing unreviewed or mismatched package blocks discovery instead of falling back', async () => {
  const badMetadata = [
    { ...reviewedMetadata(), name: '@other/agentic-wallet' },
    { ...reviewedMetadata(), version: '9.9.9' },
    { ...reviewedMetadata(), bin: { baw: '../different-entry.js' } }
  ];
  for (const metadata of badMetadata) {
    const seen = [];
    await assert.rejects(resolveCliInstallation({ roots, readMetadataAt: async url => {
      seen.push(url.href);
      return seen.length === 1 ? metadata : reviewedMetadata();
    } }));
    assert.deepEqual(seen, [new URL('package.json', roots[0]).href]);
  }
});

test('unreadable or malformed package metadata is not treated as an absent installation', async () => {
  for (const error of [Object.assign(new Error('synthetic permission failure'), { code: 'EACCES' }), new SyntaxError('synthetic invalid JSON')]) {
    let reads = 0;
    await assert.rejects(resolveCliInstallation({ roots, readMetadataAt: async () => {
      reads++;
      if (reads === 1) throw error;
      return reviewedMetadata();
    } }));
    assert.equal(reads, 1);
  }
});

test('CLI discovery reports failure when every candidate is absent', async () => {
  const seen = [];
  await assert.rejects(resolveCliInstallation({ roots, readMetadataAt: async url => {
    seen.push(url.href);
    throw missing();
  } }));
  assert.deepEqual(seen, roots.map(root => new URL('package.json', root).href));
});
