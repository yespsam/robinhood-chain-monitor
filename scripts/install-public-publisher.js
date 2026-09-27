import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = 'com.qohfq.yesp-atm-public-publisher';
const xml = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

export function publisherPlist(root, nodePath) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key><array><string>${xml(nodePath)}</string><string>${xml(path.join(root, 'scripts/publish-public-dashboard.js'))}</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>ProcessType</key><string>Background</string><key>Nice</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(path.join(root, 'data/public-publisher.out.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(root, 'data/public-publisher.err.log'))}</string>
</dict></plist>\n`;
}

export async function installPublicPublisher() {
  if (process.platform !== 'darwin') throw new Error('This installer is for macOS only');
  const configPath = path.join(project, 'data/public-publisher.json');
  const config = JSON.parse(await fs.readFile(configPath, 'utf8'));
  if (!/^https:\/\/[a-z0-9-]+\.netlify\.app\/?$/.test(config.url || '') || typeof config.token !== 'string' || config.token.length < 32) throw new Error('Configure the publisher first');
  if ((await fs.stat(configPath)).mode & 0o077) throw new Error('Publisher credentials must be owner-only (chmod 600)');
  const file = path.join(os.homedir(), 'Library/LaunchAgents', `${label}.plist`);
  const body = publisherPlist(project, process.execPath);
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(file, body, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await fs.readFile(file, 'utf8') !== body) throw new Error('Existing service differs; inspect before replacing');
  }
  const domain = `gui/${process.getuid()}`;
  const loaded = spawnSync('launchctl', ['print', `${domain}/${label}`], { stdio: 'ignore' });
  if (loaded.status !== 0) {
    const result = spawnSync('launchctl', ['bootstrap', domain, file], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`Publisher service could not start (${result.status})`);
  }
  console.log(`Public snapshot publisher installed: ${domain}/${label}`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await installPublicPublisher();
