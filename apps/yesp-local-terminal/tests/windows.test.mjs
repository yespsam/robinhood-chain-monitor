import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { verifyHostArguments, loadExtensionIdentity, encodeFrame } from '../scripts/flap-native-host.mjs';
import { installExtension, registerWindowsHost, WINDOWS_REGISTRY_KEY } from '../scripts/install-flap-extension.mjs';
import { buildWindowsLauncher, compileWindowsSource } from '../scripts/build-windows-support.mjs';
import { createFastTradeCli } from '../server/fast-trade-cli.mjs';
import { secureDirectory, windowsFiles } from '../server/platform-files.mjs';

const id = 'elekekjeabljofoefoccekebfdalomfp', origin = `chrome-extension://${id}/`;
const windows = process.platform === 'win32';
async function temporary(t) {
  const root = await mkdtemp(join(tmpdir(), 'yesp-win-test-'));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
}
function invoke(executable, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    const out = [], err = [];
    const timeout = setTimeout(() => { child.kill(); reject(new Error('Launcher test timed out')); }, 15000);
    child.on('error', error => { clearTimeout(timeout); reject(error); });
    child.stdout.on('data', chunk => out.push(chunk)); child.stderr.on('data', chunk => err.push(chunk));
    child.stdin.on('error', () => {});
    child.on('close', code => { clearTimeout(timeout); resolve({ code, stdout: Buffer.concat(out), stderr: Buffer.concat(err).toString() }); });
    child.stdin.end(input);
  });
}

test('Windows accepts only the registered origin and optional numeric parent-window argument', () => {
  assert.equal(verifyHostArguments([origin, '--parent-window=0'], id, 'win32'), true);
  assert.equal(verifyHostArguments([origin, '--parent-window=1234567890'], id, 'win32'), true);
  assert.equal(verifyHostArguments([origin], id, 'win32'), true);
  for (const args of [[], [origin, '--parent-window=-1'], [origin, '--parent-window=1&whoami'],
    [origin, '--parent-window=1', '--extra'], ['https://flap.sh/', '--parent-window=0'], [origin, '--eval=bad']])
    assert.throws(() => verifyHostArguments(args, id, 'win32'), { code: 'CALLER_NOT_ALLOWED' });
  assert.throws(() => verifyHostArguments([origin, '--parent-window=0'], id, 'darwin'), { code: 'CALLER_NOT_ALLOWED' });
});

test('Windows manual proxy parser supports per-protocol settings without accepting credentials or URLs with paths', {skip:!windows}, async t=>{
  const root=await temporary(t),exe=join(root,'proxy-parser.exe');
  const template=(await readFile(new URL('../scripts/windows/NativeLauncher.cs',import.meta.url),'utf8'))
    .replace('__NODE_PATH__','"unused"').replace('__HOST_PATH__','"unused"').replace('__ORIGIN__','"unused"')
    .replace('static int Main(string[] args)','static int LauncherMain(string[] args)');
  await compileWindowsSource(template+`
class ProxyParserTest {
  static int Main() {
    string[,] cases = {
      {"127.0.0.1:7897", "https", "http://127.0.0.1:7897"},
      {"http=127.0.0.1:8080;https=127.0.0.1:7897", "https", "http://127.0.0.1:7897"},
      {"http=127.0.0.1:8080;https=127.0.0.1:7897", "http", "http://127.0.0.1:8080"},
      {"http=127.0.0.1:8080", "https", null},
      {"socks=127.0.0.1:7897", "https", null},
      {"http://user:password@127.0.0.1:7897", "https", null},
      {"http://127.0.0.1:7897/path", "https", null},
      {"http://127.0.0.1:7897?secret=x", "https", null},
      {"http://127.0.0.1:7897#fragment", "https", null},
      {"socks5://127.0.0.1:7897", "https", null},
      {"127.0.0.1:7897 bad", "https", null},
      {null, "https", null}
    };
    for(int i=0;i<cases.GetLength(0);i++) if(NativeLauncher.ManualProxy(cases[i,0],cases[i,1]) != cases[i,2]) return i+1;
    Console.WriteLine("12 proxy cases passed");return 0;
  }
}`,exe);
  const result=await invoke(exe,[],Buffer.alloc(0));assert.equal(result.code,0);assert.match(result.stdout.toString(),/12 proxy cases passed/);
});

test('Windows registration uses both HKCU views, literal argv and verifies the exact manifest', async () => {
  const path = 'C:\\中文目录 & %TEST%!\\host.json', calls = []; let verified = 0;
  await registerWindowsHost(path, { registryTool: 'reg.exe', verify: async value => {assert.equal(value,path);verified++;}, execute: async (file, args, options) => {
    calls.push(args); assert.equal(options.shell, false); assert.equal(options.windowsHide, true);
    assert.equal(args[1], WINDOWS_REGISTRY_KEY);
    if (args[0] === 'add') assert.equal(args[args.indexOf('/d') + 1], path);
    return { stdout: 'localized output is deliberately not parsed' };
  } });
  assert.deepEqual(calls.map(a => a.at(-1)), ['/reg:32','/reg:64']); assert.equal(verified,1);
  await assert.rejects(registerWindowsHost(path, { execute: async () => ({}),
    verify: async () => {throw Object.assign(new Error(),{code:'WINDOWS_REGISTRATION_MISMATCH'});} }),{code:'WINDOWS_REGISTRATION_MISMATCH'});
});

test('Windows CLI paths reach the executor without a shell', { skip: !windows }, async () => {
  let calls = 0;
  const entryPath = 'C:\\Program Files\\钱包\\@binance\\agentic-wallet\\dist\\index.js';
  const cli = createFastTradeCli({ resolveInstallation: async () => ({ metadata: {
    name: '@binance/agentic-wallet', version: '1.11.0', bin: { baw: 'dist/index.js' } }, entryPath }),
    execute: async (_exe, args, options) => {
      calls++; assert.equal(args[0], entryPath); assert.equal(options.shell, false);
      return { stdout: JSON.stringify({ success: true, data: { status: 'CONNECTED' } }) };
    }
  });
  assert.equal((await cli.status()).status, 'CONNECTED'); assert.equal(calls, 1);
});

test('Windows installer dry run is write-free; real file generation uses a mocked registry only', { skip: !windows }, async t => {
  const root = join(await temporary(t), "项目 with %PATH%! & ' spaces");
  await mkdir(join(root, 'extension'), { recursive: true }); await mkdir(join(root, 'scripts'));
  for (const file of ['manifest.json','extension-public-key.txt'])
    await writeFile(join(root, 'extension', file), await readFile(new URL('../extension/' + file, import.meta.url)));
  await writeFile(join(root, 'scripts/flap-native-host.mjs'), 'process.stdin.pipe(process.stdout);\n');
  let registrations = 0, builds = 0;
  const options = { root, platform: 'win32', buildSupport: async () => { builds++; },
    registerWindows: async path => {
      registrations++; assert.equal(path, join(root, '.generated/native-host/com.yesp.flap_wallet.json'));
    } };
  const dry = await installExtension({ ...options, dryRun: true });
  assert.equal(registrations, 0); assert.equal(builds, 0);
  await assert.rejects(readFile(dry.nativeManifest), { code: 'ENOENT' });
  const result = await installExtension(options);
  assert.equal(result.installed, true); assert.equal(registrations, 1); assert.equal(builds, 1);
  const manifest = JSON.parse(await readFile(result.nativeManifest, 'utf8'));
  assert.deepEqual(manifest.allowed_origins, [origin]); assert.ok(manifest.path.endsWith('.exe'));
  await windowsFiles('check-directory', join(root, '.private'));
  const payload = encodeFrame({ message: '中文\n二进制', zero: '\u0000', value: 'a&b!%PATH%' });
  const response = await invoke(manifest.path, [origin, '--parent-window=0'], payload);
  assert.equal(response.code, 0, response.stderr); assert.deepEqual(response.stdout, payload);
});

test('Windows launcher preserves raw bytes and rejects extra or forged arguments before starting Node', { skip: !windows }, async t => {
  const root = join(await temporary(t), "中文 %PATH%! & ' workspace"); await mkdir(root);
  const script = join(root, 'echo %PATH%! &.mjs'), executable = join(root, 'bridge.exe');
  await writeFile(script, "process.stdin.pipe(process.stdout);\n");
  await buildWindowsLauncher({ nodePath: process.execPath, hostPath: script, extensionId: id, output: executable });
  const bytes = Buffer.concat([Buffer.from([0,10,13,26,255]), Buffer.from('中文🙂'), Buffer.alloc(8192, 10)]);
  const result = await invoke(executable, [origin, '--parent-window=42'], bytes);
  assert.equal(result.code, 0, result.stderr); assert.deepEqual(result.stdout, bytes);
  for (const args of [['chrome-extension://' + 'a'.repeat(32) + '/'], [origin, '--parent-window=1&bad'], [origin, '--extra'], []]) {
    const denied = await invoke(executable, args, bytes); assert.notEqual(denied.code, 0); assert.equal(denied.stdout.length, 0);
  }
});

test('Windows launcher forwards consecutive small messages while Chrome keeps stdin open', {skip:!windows}, async t=>{
  const root=await temporary(t),script=join(root,'persistent-echo.mjs'),executable=join(root,'persistent.exe');
  await writeFile(script,'process.stdin.on("data", chunk => process.stdout.write(chunk));\n');
  await buildWindowsLauncher({nodePath:process.execPath,hostPath:script,extensionId:id,output:executable});
  const first=encodeFrame({id:'first',text:'中文'}),second=encodeFrame({id:'second',text:'🙂'});
  const received=await new Promise((resolve,reject)=>{
    const child=spawn(executable,[origin,'--parent-window=0'],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    const chunks=[];let sentSecond=false,length=0;
    const timeout=setTimeout(()=>{child.kill();reject(new Error('Small native message was buffered until EOF'));},8000);
    child.once('error',e=>{clearTimeout(timeout);reject(e);});
    child.stdout.on('data',chunk=>{
      chunks.push(chunk);length+=chunk.length;
      if(!sentSecond&&length===first.length){assert.equal(child.stdin.writableEnded,false);sentSecond=true;child.stdin.write(second);}
      else if(sentSecond&&length===first.length+second.length)child.stdin.end();
    });
    child.once('close',code=>{clearTimeout(timeout);if(code!==0)reject(new Error('Persistent launcher failed'));else resolve(Buffer.concat(chunks));});
    child.stdin.write(first);
  });
  assert.deepEqual(received,Buffer.concat([first,second]));
});

test('Windows journal helper refuses a path through a junction without changing its target ACL', { skip: !windows }, async t => {
  const root = await temporary(t), outside = join(root, 'outside'), junction = join(root, 'link');
  const { symlink } = await import('node:fs/promises');
  await mkdir(outside); await symlink(outside, junction, 'junction');
  await assert.rejects(secureDirectory(join(junction, 'nested')), { code: 'JOURNAL_UNSAFE' });
  await assert.rejects(readFile(join(outside, 'nested')), { code: 'ENOENT' });
});
