import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const runFile = promisify(execFile);
const key = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';
// Only read the existing manual proxy settings. Never inspect browser cookies,
// credential stores, PAC scripts or other registry values; never write the registry.
async function readWindowsProxy() {
  const read = async (name, type) => {
    const { stdout } = await runFile('reg.exe', ['query', key, '/v', name], { shell: false, windowsHide: true, timeout: 3000, maxBuffer: 8192 });
    return stdout.match(new RegExp('(?:^|\\n)\\s*' + name + '\\s+' + type + '\\s+([^\\r\\n]*)'))?.[1]?.trim();
  };
  if (await read('ProxyEnable', 'REG_DWORD') !== '0x1') return { enabled: false };
  const server = await read('ProxyServer', 'REG_SZ');
  let bypass = ''; try { bypass = await read('ProxyOverride', 'REG_SZ') || ''; } catch { /* Optional value. */ }
  return { enabled: true, server, bypass };
}
function localProxy(value) {
  // Do not adopt remote/credentialed proxies, infer SOCKS, or invent port numbers.
  const m = typeof value === 'string' && value.match(/^(?:(https?):\/\/)?(127\.0\.0\.1|localhost|\[::1\]):([0-9]{1,5})\/?$/i);
  if (!m || Number(m[3]) < 1 || Number(m[3]) > 65535) return null;
  return `${(m[1] || 'http').toLowerCase()}://${m[2].toLowerCase()}:${Number(m[3])}`;
}
export function proxyEnvironment(base, settings) {
  const unchanged = mode => ({ env: { ...base }, mode });
  if (Object.keys(base).some(k => ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NODE_USE_ENV_PROXY'].includes(k.toUpperCase()) && base[k] !== undefined && base[k] !== '')) return unchanged('explicit-environment-preserved');
  if (!settings?.enabled) return unchanged('system-proxy-disabled');
  const proxy = localProxy(settings.server);
  // This minimal adapter only accepts the single existing manual HTTP(S) proxy
  // used for all protocols. Per-protocol/PAC/SOCKS configurations need review.
  if (!proxy) return unchanged('system-proxy-format-unconfirmed');
  const bypass = (settings.bypass || '').split(/[;\s]+/).filter(Boolean);
  const safeBypass = [];
  for (const value of bypass) {
    if (value.toLowerCase() === '<local>') continue; // CLI destinations are fully qualified hosts.
    // Windows commonly stores IPv4 prefixes as 127.* or 192.168.*.
    // Node documents IP ranges for NO_PROXY, not Windows' trailing wildcard syntax.
    if (/^(?:\d{1,3}\.){1,3}\*$/.test(value)) {
      const prefix = value.slice(0, -2).split('.').map(Number);
      if (prefix.some(octet => octet > 255)) return unchanged('system-proxy-bypass-unconfirmed');
      safeBypass.push([...prefix, ...Array(4 - prefix.length).fill(0)].join('.') + '-' + [...prefix, ...Array(4 - prefix.length).fill(255)].join('.'));
      continue;
    }
    if (!/^(?:\*\.)?[a-z0-9.-]+(?::[0-9]{1,5})?$/i.test(value)) return unchanged('system-proxy-bypass-unconfirmed');
    safeBypass.push(value);
  }
  return { env: { ...base, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, NODE_USE_ENV_PROXY: '1',
    ...(Object.keys(base).some(k => k.toUpperCase() === 'NO_PROXY') ? {} : { NO_PROXY: ['localhost', '127.0.0.1', '[::1]', ...safeBypass].join(',') }) }, mode: 'existing-windows-loopback-proxy' };
}
export async function walletChildEnvironment({ enabled = true, platform = process.platform, version = process.versions.node, base = process.env, readSettings = readWindowsProxy } = {}) {
  const unchanged = mode => ({ env: { ...base }, mode });
  if (!enabled) return unchanged('adapter-disabled');
  if (platform !== 'win32') return unchanged('platform-unchanged');
  if (Number(version.split('.')[0]) < 24) return unchanged('node-proxy-support-unconfirmed');
  try { return proxyEnvironment(base, await readSettings()); }
  catch { return unchanged('system-proxy-read-unavailable'); }
}
