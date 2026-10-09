import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const publicAssets = [
  'styles.css', 'brain-desk.css', 'brain-instrument.css', 'brain-desk.js', 'entry-status.js', 'ca-desk.js',
  'strategy-details.js', 'narrative-thesis.js', 'favicon.svg', 'generated-designs/neural-core-v2.png',
];
export async function buildPublicDashboard(destination = path.join(project, 'dist-public')) {
  // Refuse contaminated output instead of silently deploying arbitrary files.
  const expected = new Set([...publicAssets, 'index.html', 'app.js']);
  async function inspect(dir, prefix = '') {
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(e => e.code === 'ENOENT' ? [] : Promise.reject(e))) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) await inspect(path.join(dir, entry.name), name + '/');
      else if (!expected.has(name) || entry.isSymbolicLink()) throw new Error(`Unexpected public output file: ${name}`);
    }
  }
  await inspect(destination);
  for (const asset of publicAssets) {
    const target = path.join(destination, asset);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(project, 'dashboard', asset), target);
  }
  for (const asset of ['index.html', 'app.js']) await fs.copyFile(path.join(project, 'public-dashboard', asset), path.join(destination, asset));
  return expected.size;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(`Public build: ${await buildPublicDashboard()} allowlisted assets`);
