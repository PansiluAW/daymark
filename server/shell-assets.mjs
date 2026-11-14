import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export function loadShellAssets(root) {
  const names = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .filter(name => !name.split('/').some(segment => segment.startsWith('.')))
    .sort();
  const assets = new Map(names.map(name => [name, readFileSync(join(root, name))]));
  const hash = createHash('sha256');
  for (const [name, bytes] of assets) hash.update(JSON.stringify([name, bytes.length])).update(bytes);
  const revision = hash.digest('hex').slice(0, 12);
  const worker = assets.get('sw.js')?.toString();
  const token = /daymark-shell-v\d+/;
  if (!worker || !token.test(worker)) throw new Error('Service worker is missing its shell version.');
  assets.set('sw.js', Buffer.from(worker.replace(token, 'daymark-shell-' + revision)));
  return { assets, revision };
}
