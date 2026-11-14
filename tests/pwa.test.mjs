import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { assetResponse } from '../server/http.mjs';
import { loadShellAssets } from '../server/shell-assets.mjs';

const assets = new URL('../public/', import.meta.url);
const source = await readFile(new URL('sw.js', assets), 'utf8');
const scope = 'https://daymark.example/daily/';
const mime = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'application/javascript',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

function worker({ version = 'v1', storage = new Map() } = {}) {
  const handlers = new Map();
  const runtime = { storage, offline: false, claimed: false, skipped: false };
  const caches = {
    keys: async () => [...storage.keys()],
    delete: async (key) => storage.delete(key),
    async open(key) {
      if (!storage.has(key)) storage.set(key, new Map());
      const cache = storage.get(key);
      return {
        put: async (request, response) => cache.set(request.url, response),
        match: async (url) => cache.get(url)?.clone(),
      };
    },
  };

  vm.runInNewContext(source.replace(/daymark-shell-v\d+/, `daymark-shell-${version}`), {
    caches, Request, URL,
    async fetch(request) {
      if (runtime.offline) throw new TypeError('network unavailable');
      const { pathname } = new URL(request.url);
      const override = runtime.networkResponse?.(pathname);
      if (override) return override;
      const extension = pathname.slice(pathname.lastIndexOf('.'));
      const type = runtime.badAsset && pathname.endsWith(runtime.badAsset)
        ? 'text/html'
        : mime[extension] ?? 'text/html';
      const headers = { 'Content-Type': type };
      if (type === 'text/html') headers['X-Daymark-Shell'] = '1';
      return new Response(runtime.onlineBody ?? pathname, { headers });
    },
    self: {
      registration: { scope },
      clients: { claim: async () => { runtime.claimed = true; } },
      skipWaiting: async () => { runtime.skipped = true; },
      addEventListener: (type, handler) => handlers.set(type, handler),
    },
  });

  runtime.emit = (type, props = {}) => {
    let result;
    const capture = (value) => { result = value; };
    handlers.get(type)({ ...props, waitUntil: capture, respondWith: capture });
    return result;
  };
  runtime.request = (path, mode = 'same-origin', method = 'GET') =>
    runtime.emit('fetch', { request: { url: new URL(path, scope).href, mode, method } });
  return runtime;
}

test('manifest provides separate app icons and matches the supported scope', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.webmanifest', assets), 'utf8'));
  assert.equal(manifest.display, 'standalone');
  assert.equal(new URL(manifest.start_url, scope).href, scope);
  assert.equal(new URL(manifest.scope, scope).href, scope);
  assert.ok(manifest.icons.some(({ sizes, purpose }) => sizes === '192x192' && purpose === 'any'));
  assert.ok(manifest.icons.some(({ sizes, purpose }) => sizes === '512x512' && purpose === 'any'));
  assert.ok(manifest.icons.some(({ sizes, purpose }) => sizes === '512x512' && purpose === 'maskable'));

  for (const icon of [...manifest.icons, { src: './icons/apple-touch-icon.png', sizes: '180x180' }]) {
    const png = await readFile(new URL(icon.src, assets));
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(`${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`, icon.sizes);
  }
});

test('the same installed shell and assets load online and offline until an update activates', async () => {
  const runtime = worker();
  await runtime.emit('install');
  runtime.onlineBody = 'a newer version from the network';
  assert.equal(await (await runtime.request('./?invite=temporary', 'navigate')).text(), '/daily/index.html');
  assert.equal(await (await runtime.request('./app.js')).text(), '/daily/app.js');

  runtime.offline = true;
  for (const path of ['./', './?invite=temporary', './index.html']) {
    assert.equal(await (await runtime.request(path, 'navigate')).text(), '/daily/index.html');
  }
  for (const path of ['./styles.css', './circle.css', './app.js', './model.mjs', './circle-view.mjs', './race-model.mjs']) {
    assert.equal(await (await runtime.request(path)).text(), new URL(path, scope).pathname);
  }
  const installed = [...runtime.storage.values()][0];
  assert.equal(installed.size, 13);
  assert.ok([...installed.keys()].every((url) => !new URL(url).search));
});

test('shell navigation falls back on outages but passes through sign-in and access responses', async () => {
  const runtime = worker();
  await runtime.emit('install');
  const navigate = () => runtime.request('./', 'navigate');

  runtime.networkResponse = () => new Response('Temporary gateway error', { status: 503 });
  assert.equal(await (await navigate()).text(), '/daily/index.html');
  runtime.networkResponse = () => new Response(null, { status: 304 });
  assert.equal(await (await navigate()).text(), '/daily/index.html');

  runtime.networkResponse = () => Response.redirect(new URL('./signin-with-chatgpt', scope));
  assert.equal((await navigate()).status, 302);
  for (const status of [401, 403, 404]) {
    runtime.networkResponse = () => new Response('Gateway response', { status });
    assert.equal((await navigate()).status, status);
  }
  runtime.networkResponse = () => new Response('Sign in', { headers: { 'Content-Type': 'text/html' } });
  assert.equal(await (await navigate()).text(), 'Sign in');
});

test('account and other out-of-scope requests bypass the offline shell', async () => {
  const runtime = worker();
  await runtime.emit('install');
  for (const path of [
    './api/me', '/api/checkins', './signin-with-chatgpt', './signout-with-chatgpt',
    './callback', './missing-page', '/another-app/', 'https://other.example/daily/',
  ]) {
    assert.equal(runtime.request(path, 'navigate'), undefined);
  }
  assert.equal(runtime.request('./styles.css?v=example'), undefined);
  assert.equal(runtime.request('./', 'navigate', 'POST'), undefined);
});

test('activation replaces only older shell versions in the same scope', async () => {
  const first = worker();
  await first.emit('install');
  const unrelated = 'daymark-shell:https://daymark.example/other/:daymark-shell-v1';
  first.storage.set(unrelated, new Map());

  const update = worker({ version: 'v2', storage: first.storage });
  update.badAsset = 'app.js';
  await assert.rejects(update.emit('install'), /could not cache/);
  assert.equal(first.storage.size, 2);
  update.badAsset = null;
  update.networkResponse = path => path.endsWith('index.html')
    ? new Response('Sign in', { headers: { 'Content-Type': 'text/html' } })
    : undefined;
  await assert.rejects(update.emit('install'), /could not cache/);
  assert.equal(first.storage.size, 2);
  update.networkResponse = null;

  update.onlineBody = 'new installed revision';
  await update.emit('install');
  assert.equal(first.storage.size, 3);
  assert.equal(update.skipped, false);
  assert.equal(await (await first.request('./app.js')).text(), '/daily/app.js');
  await update.emit('message', { data: { type: 'SKIP_WAITING' } });
  assert.equal(update.skipped, true);
  await update.emit('activate');
  assert.equal(update.claimed, true);
  assert.deepEqual([...first.storage.keys()], [unrelated, `daymark-shell:${scope}:daymark-shell-v2`]);
  assert.equal(await (await update.request('./app.js')).text(), 'new installed revision');
});

test('standalone and built workers derive their cache revision from the whole public shell', async t => {
  const root = await mkdtemp(join(tmpdir(), 'daymark-shell-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, 'sw.js'), source);
  await writeFile(join(root, 'styles.css'), 'body { color: black; }');
  const first = loadShellAssets(root);
  await writeFile(join(root, 'styles.css'), 'body { color: green; }');
  const second = loadShellAssets(root);
  assert.notEqual(first.revision, second.revision);
  assert.ok(second.assets.get('sw.js').includes('daymark-shell-' + second.revision));

  const request = new Request(scope);
  assert.equal(assetResponse(request, { extension: '.html', bytes: 'Daymark' }).headers.get('x-daymark-shell'), '1');
  assert.equal(assetResponse(request, { extension: '.css', bytes: 'body {}' }).headers.get('x-daymark-shell'), null);
});
