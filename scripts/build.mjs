import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadShellAssets } from '../server/shell-assets.mjs';

const project = new URL('../', import.meta.url);
const get = (filename) => new URL(filename, project);
const { assets, revision } = loadShellAssets(fileURLToPath(get('public/')));
for (const name of ['index.html', 'app.js', 'styles.css', 'model.mjs', 'circle.css', 'circle-view.mjs', 'race-model.mjs', 'manifest.webmanifest', 'sw.js']) {
  if (!assets.has(name)) throw new Error('Missing public asset ' + name);
}
const assetTable = Object.fromEntries([...assets].map(([name, bytes]) => ['/' + name, {
  extension: extname(name), base64: bytes.toString('base64'),
}]));

const imports = await Promise.all(['server/api.mjs', 'server/http.mjs'].map(name => readFile(get(name), 'utf8')));
const worker = imports.join('\n\n') + `

const daymarkAssets = ${JSON.stringify(assetTable)};
export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (pathname.startsWith('/api/')) {
      return handleApi(request, { db: env.DB, trustedIdentity: trustedSiteIdentity(request.headers) });
    }
    const entry = daymarkAssets[pathname === '/' ? '/index.html' : pathname];
    const asset = entry && {
      extension: entry.extension,
      bytes: Uint8Array.from(atob(entry.base64), value => value.charCodeAt(0)),
    };
    return assetResponse(request, asset);
  },
};
`;
await mkdir(get('dist/server/'), { recursive: true });
await mkdir(get('dist/.openai/'), { recursive: true });
await cp(get('.openai/hosting.json'), get('dist/.openai/hosting.json'));
const entrypoint = get('dist/server/index.js');
await writeFile(entrypoint, worker);

const { default: builtWorker } = await import(entrypoint.href);
const response = await builtWorker.fetch(new Request('https://daymark.example/'), {});
if (!response.ok || response.headers.get('x-daymark-shell') !== '1' || !(await response.text()).includes('Daymark')) {
  throw new Error('Worker failed its shell check.');
}
console.log('Built Daymark ' + revision + ' with ' + assets.size + ' bundled assets.');
