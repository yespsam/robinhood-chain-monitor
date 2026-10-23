import test from 'node:test';
import assert from 'node:assert/strict';
import { createCliRunner, OfficialWallet, cliVersionInfo } from '../server/official-cli.mjs';
import { WalletFailure, safeDiagnostic, officialFailure } from '../server/diagnostics.mjs';
import { LocalWalletAccess } from '../server/local-wallet.mjs';
import { createApplication } from '../server/app.mjs';
import { Sessions } from '../server/auth.mjs';
import { diagnosticText } from '../public/connection-state.js';
import { OFFICIAL_ERRORS } from '../public/official-error-catalog.js';
const metadata = { name: '@binance/agentic-wallet', version: '1.11.0', bin: { baw: 'dist/index.js' } };
const secret = 'SYNTHETIC_MUST_NOT_ESCAPE';
const turn = () => new Promise(setImmediate);
const runner = execute => createCliRunner({ execute, readMetadata: async () => metadata });
function fixture() {
  let now = Date.now(), status = 'UNCONNECTED', signin = 0, verify = 0, finish;
  const wallet = {
    async status() { return status; },
    async beginOfficialSignIn() { signin++; return { urlForWeb: 'https://web3.binance.com/en/agent-login?url=' + secret, pairingCode: '012345', qrCodeId: secret, expireAt: String(now + 300000) }; },
    async verifyOfficialSignIn() { verify++; return new Promise(resolve => { finish = resolve; }); },
    async settings() { return { sessionExpireTime: new Date(now + 3600000).toISOString(), inactiveSignOutTime: new Date(now + 3600000).toISOString() }; },
    async chains() { return [{ id: '56', name: 'BSC' }]; },
    async addresses() { return [{ chainId: '56', address: '0x1111111111111111111111111111111111111111' }]; }
  };
  const local = new LocalWalletAccess(wallet, () => now), key = local.bootstrap().token;
  return { local, key, wallet, counts: () => [signin, verify], advance: ms => { now += ms; }, status: s => { status = s; }, finish: value => finish(value) };
}
test('process start, exit, timeout, parse and official rejection have distinct safe diagnostics', async () => {
  const cases = [
    ['CLI_START_FAILED', { code: 'ENOENT', message: secret }],
    ['CLI_EXIT_FAILED', { code: 7, stdout: secret, stderr: secret }],
    ['CLI_TIMEOUT', { killed: true, code: null, stdout: secret, stderr: secret }],
    ['CLI_EXIT_FAILED', { killed: true, code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', stdout: secret }],
    ['AUTH_REJECTED', { code: 1, stdout: JSON.stringify({ success: false, error: { name: 'AUTH_REJECTED', code: 10002004, message: secret } }) }]
  ];
  for (const [code, cause] of cases) {
    const run = runner(async () => { throw cause; });
    await assert.rejects(run(['auth', 'signin']), error => {
      assert.equal(error.code, code); assert.equal(error.diagnostic.stage, 'SIGNIN');
      assert.ok(!JSON.stringify(error).includes(secret)); return true;
    });
  }
  const malformed = runner(async () => ({ stdout: 'not-json-' + secret }));
  await assert.rejects(malformed(['auth', 'signin']), { code: 'CLI_PARSE_FAILED' });
  const official = new OfficialWallet(runner(async () => ({ stdout: JSON.stringify({ success: false, error: { name: secret, code: secret, message: secret } }) })));
  await assert.rejects(official.status(), e => { assert.equal(e.code, 'OFFICIAL_ERROR'); assert.ok(!JSON.stringify(e).includes(secret)); return true; });
});
test('only auth verify gets the documented five-minute allowance; other commands keep local 25 seconds', async () => {
  const timeouts = [], run = runner(async (_exe, args, options) => { timeouts.push(options.timeout); assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(args.at(-1), '--json'); return { stdout: '{}' }; });
  await run(['auth', 'verify', '--qrCodeId', secret]); await run(['auth', 'signin']); await run(['wallet', 'status']);
  assert.deepEqual(timeouts, [310000, 25000, 25000]);
});
test('diagnostic allowlist drops credentials, provider text, URLs, addresses and arbitrary error labels', () => {
  const unsafe = { code: secret, stage: secret, message: secret, nextStep: secret, token: secret, stderr: secret, urlForWeb: secret, officialName: secret };
  assert.ok(!JSON.stringify(safeDiagnostic({ code: secret, diagnostic: unsafe })).includes(secret));
  const exported = diagnosticText({ phase: 'WAITING', urlForWeb: secret, pairingCode: secret, token: secret }, unsafe, true, { installedVersion: '1.11.0', skillRequiredVersion: '1.11.0' });
  assert.ok(!exported.includes(secret)); const parsed = JSON.parse(exported);
  assert.equal(parsed.environment, 'SIMULATED_TEST_ONLY'); assert.equal(parsed.latestCli, '未确认'); assert.equal(parsed.minimumSupportedCli, '未确认');
  assert.equal(parsed.liveTrades, false); assert.equal(parsed.automation, false);
});
test('known official name/code pairs and connection identifiers survive both sanitizers without raw messages', () => {
  for (const [name, entry] of Object.entries(OFFICIAL_ERRORS)) {
    const error = officialFailure({ success: false, error: { name, code: entry.code, message: 'ECONNRESET https://example.invalid/?token=' + secret, data: { token: secret } } }, 'SIGNIN', { exitCode: 1 });
    const d = safeDiagnostic(error), exported = JSON.parse(diagnosticText({ phase: 'FAILED', stage: 'SIGNIN', diagnostic: d }, d));
    assert.equal(exported.diagnostic.officialName, name); assert.equal(exported.diagnostic.officialCode, entry.code);
    assert.deepEqual(exported.diagnostic.connectionSignals, ['ECONNRESET']); assert.equal(exported.diagnostic.category, entry.category);
    assert.equal(exported.diagnosticScope, 'CURRENT_FAILURE'); assert.ok(!JSON.stringify(exported).includes(secret)); assert.ok(!JSON.stringify(d).includes('https://'));
  }
});
test('unknown service errors retain only bounded numeric codes, never unknown names or arbitrary text', () => {
  for (const name of ['SERVICE_ERROR', secret, { toString: secret }, '__proto__']) {
    const d = safeDiagnostic(officialFailure({ error: { name, code: 87654321, message: 'HTTP 403: token=' + secret } }, 'SIGNIN'));
    assert.equal(d.officialCode, 87654321); assert.equal(d.officialName, name === 'SERVICE_ERROR' ? 'SERVICE_ERROR' : undefined);
    assert.equal(d.httpStatus, 403); assert.ok(!JSON.stringify(d).includes(secret));
  }
  for (const code of [secret, 123456789012345, -1, { key: secret }]) {
    const d = safeDiagnostic(officialFailure({ error: { name: secret, code, message: secret } }, 'SIGNIN'));
    assert.equal(d.officialCode, undefined); assert.ok(!JSON.stringify(d).includes(secret));
  }
});
test('mismatched official name and code cannot fabricate a network or account-eligibility conclusion', () => {
  const d = safeDiagnostic(officialFailure({ error: { name: 'NETWORK_ERROR', code: 10001001, message: secret } }, 'SIGNIN'));
  assert.equal(d.officialName, undefined); assert.equal(d.officialCode, 10001001); assert.equal(d.category, 'OFFICIAL');
  assert.ok(!d.message.includes('网络'));
});
test('checking after a failed signin marks the retained diagnostic as a previous failure', () => {
  const previous = safeDiagnostic(officialFailure({ error: { name: 'LOGIN_API_ERROR', code: 10001001 } }, 'SIGNIN'));
  const v = JSON.parse(diagnosticText({ phase: 'CHECKING', stage: 'STATUS', diagnostic: null }, previous));
  assert.equal(v.schema, 2); assert.equal(v.phase, 'CHECKING'); assert.equal(v.stage, 'STATUS');
  assert.equal(v.diagnosticScope, 'PREVIOUS_FAILURE'); assert.equal(v.diagnostic.stage, 'SIGNIN');
  assert.equal(JSON.parse(diagnosticText(null, null)).diagnosticScope, 'NONE');
});
test('unknown version is not installed, latest or minimum; a mismatched package never executes', async () => {
  const v = await cliVersionInfo(); assert.equal(v.skillRequiredVersion, '1.11.0'); assert.equal(v.latestVersion, null); assert.equal(v.minimumSupportedVersion, null);
  const run = createCliRunner({ readMetadata: async () => ({ ...metadata, version: '9.9.9' }), execute: () => assert.fail('must not launch') });
  await assert.rejects(run(['wallet', 'status']), { code: 'CLI_VERSION_REVIEW_REQUIRED' });
});
test('only exact official HTTPS auth hosts are accepted, never lookalikes or unsafe URLs', async () => {
  for (const urlForWeb of ['http://web3.binance.com/en/agent-login', 'https://web3.binance.com.evil.test/en/agent-login', 'https://unknown.binance.com/agent', 'binance://agent-login', 'https://web3.binance.com/en/agent-login#secret', 'https://user@www.binance.com/login', 'https://app.binance.com:1234/login', 'https://web3.binance.com/\nlogin']) {
    const wallet = new OfficialWallet(async () => ({ success: true, data: { urlForWeb, pairingCode: '123456', qrCodeId: 'test' } }));
    await assert.rejects(wallet.beginOfficialSignIn(), { code: 'AUTH_URL_REVIEW_REQUIRED' });
  }
});

test('auth URL rejection explains only fixed mismatch categories, never the returned address or credential values', async () => {
  const cases = [
    ['not-a-url-' + secret, ['INVALID_URL']],
    ['https://unknown.binance.com/not-documented?secret=' + secret, ['HOST_MISMATCH']],
    ['https://web3.binance.com/en/agent-login#' + secret, ['FRAGMENT_PRESENT']],
    ['http://' + secret + '@evil.example:12345/other', ['SCHEME_MISMATCH', 'HOST_MISMATCH', 'EMBEDDED_CREDENTIALS', 'NONSTANDARD_PORT']]
  ];
  for (const [urlForWeb, reasons] of cases) {
    const wallet = new OfficialWallet(async () => ({ success: true, data: { urlForWeb, pairingCode: secret, qrCodeId: secret } }));
    await assert.rejects(wallet.beginOfficialSignIn(), e => {
      const d = safeDiagnostic(e), exported = JSON.parse(diagnosticText({ phase: 'FAILED', diagnostic: d }, d));
      assert.deepEqual(exported.diagnostic.authUrlIssues, reasons);
      assert.ok(!JSON.stringify(exported).includes(secret)); assert.ok(!JSON.stringify(exported).includes('evil.example')); return true;
    });
  }
  const d = safeDiagnostic(new WalletFailure('AUTH_URL_REVIEW_REQUIRED', 'SIGNIN', { authUrlIssues: ['HOST_MISMATCH', secret, { token: secret }] }));
  assert.deepEqual(d.authUrlIssues, ['HOST_MISMATCH']);
});
test('unknown official status prevents signin; timeout recovery checks status without a new signin', async () => {
  const c = fixture(); c.status('CREATING'); await c.local.start(c.key); await c.local.verification;
  assert.equal(c.local.state(c.key).diagnostic.code, 'AUTH_STATUS_UNCONFIRMED'); assert.deepEqual(c.counts(), [0, 0]);
  c.advance(10001); c.status('UNCONNECTED');
  c.wallet.beginOfficialSignIn = async () => { throw new WalletFailure('CLI_TIMEOUT', 'SIGNIN', { timeoutMs: 25000 }); };
  await c.local.start(c.key); await c.local.verification;
  assert.equal(c.local.state(c.key).phase, 'TIMEOUT'); c.advance(10001);
  c.wallet.beginOfficialSignIn = () => assert.fail('check must not create authorization');
  await c.local.handle('/api/wallet/check', c.key, {}); await c.local.verification;
  assert.equal(c.local.state(c.key).phase, 'DISCONNECTED');
});

test('status recovery never consumes or extends the signin cooldown; repeated signin remains blocked', async () => {
  const c = fixture();
  await c.local.handle('/api/wallet/check', c.key, {}); await c.local.verification;
  assert.equal(c.local.state(c.key).phase, 'DISCONNECTED');
  assert.equal(c.local.state(c.key).nextSignInAt, 0);
  let attempts = 0;
  c.wallet.beginOfficialSignIn = async () => { attempts++; throw new WalletFailure('CLI_TIMEOUT', 'SIGNIN'); };
  await c.local.start(c.key); await c.local.verification;
  const deadline = c.local.state(c.key).nextSignInAt;
  // Recover immediately without creating a second auth request or extending its timer.
  await c.local.handle('/api/wallet/check', c.key, {}); await c.local.verification;
  assert.equal(c.local.state(c.key).phase, 'DISCONNECTED');
  assert.equal(c.local.state(c.key).nextSignInAt, deadline);
  await assert.rejects(c.local.start(c.key), { code: 'AUTH_RATE_LIMIT' });
  assert.equal(attempts, 1);
  c.advance(10001);
  await c.local.handle('/api/wallet/check', c.key, {}); await c.local.verification;
  await c.local.start(c.key); await c.local.verification;
  assert.equal(attempts, 2);
});
test('stop waiting prevents later auto-binding, keeps one verify alive and requires a manual status check', async () => {
  const c = fixture(); await c.local.start(c.key); await turn();
  await assert.rejects(c.local.start(c.key), { code: 'AUTH_IN_PROGRESS' }); assert.deepEqual(c.counts(), [1, 1]);
  const stopped = await c.local.handle('/api/wallet/stop-waiting', c.key, {});
  assert.equal(stopped.phase, 'PAUSED'); assert.equal(stopped.urlForWeb, undefined); assert.equal(stopped.pairingCode, undefined);
  assert.equal(stopped.remoteAuthorizationRevoked, false); assert.equal(stopped.operationPending, true);
  await assert.rejects(c.local.handle('/api/wallet/check', c.key, {}), { code: 'AUTH_IN_PROGRESS' });
  c.status('CONNECTED'); c.finish({ verified: true }); await c.local.verification;
  assert.equal(c.local.state(c.key).phase, 'PAUSED'); assert.equal(c.local.gate.binding, null);
  c.advance(10001); await c.local.handle('/api/wallet/check', c.key, {}); await c.local.verification;
  assert.equal(c.local.state(c.key).phase, 'REVIEW'); assert.deepEqual(c.counts(), [1, 1]);
});
test('verify timeout remains unknown until official status is checked and never reruns verify', async () => {
  const c = fixture(); let verifies = 0;
  c.wallet.verifyOfficialSignIn = async () => { verifies++; throw new WalletFailure('CLI_TIMEOUT', 'VERIFY', { timeoutMs: 310000 }); };
  await c.local.start(c.key); await c.local.verification;
  const timedOut = c.local.state(c.key);
  assert.equal(timedOut.phase, 'TIMEOUT'); assert.equal(timedOut.diagnostic.stage, 'VERIFY'); assert.equal(timedOut.walletConnected, false); assert.equal(timedOut.urlForWeb, undefined);
  c.status('CONNECTED'); c.advance(10001); await c.local.handle('/api/wallet/check', c.key, {}); await c.local.verification;
  assert.equal(c.local.state(c.key).phase, 'REVIEW'); assert.equal(c.counts()[0], 1); assert.equal(verifies, 1);
});
test('opening the auth URL never completes connection; delayed identity check is not connected', async () => {
  const c = fixture(); c.status('CONNECTED'); await c.local.start(c.key); await c.local.verification;
  const candidate = c.local.state(c.key); assert.equal(candidate.walletConnected, false);
  let finish; c.wallet.status = () => new Promise(resolve => { finish = resolve; });
  const binding = c.local.bind(c.key, { candidateId: candidate.candidateId, confirmed: true });
  assert.equal(c.local.state(c.key).phase, 'VERIFYING'); assert.equal(c.local.state(c.key).walletConnected, false);
  finish('CONNECTED'); await binding; assert.equal(c.local.state(c.key).walletConnected, true);
});
test('new recovery endpoints reject cross-origin, missing Origin and absent session before any wallet call', async t => {
  const c = fixture(); c.wallet.status = () => assert.fail('must not call official wallet');
  const app = await createApplication({ sessions: new Sessions(), wallet: c.wallet, localAccess: true, walletAccess: true }); t.after(() => app.close());
  assert.equal(app.server.address().address, '127.0.0.1');
  for (const path of ['/api/wallet/check', '/api/wallet/stop-waiting']) {
    for (const headers of [{}, { Origin: 'https://evil.example' }, { Origin: app.origin, 'Sec-Fetch-Site': 'cross-site' }]) {
      const r = await fetch(app.origin + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' }); assert.equal(r.status, 403);
    }
    const r = await fetch(app.origin + path, { method: 'POST', headers: { Origin: app.origin, 'Content-Type': 'application/json' }, body: '{}' }); assert.equal(r.status, 401);
  }
});
