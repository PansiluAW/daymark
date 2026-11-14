const CACHE_VERSION = 'daymark-shell-v4';
const scope = self.registration.scope;
const CACHE_PREFIX = `daymark-shell:${scope}:`;
const CACHE_NAME = CACHE_PREFIX + CACHE_VERSION;

const shellFiles = new Map([
  ['index.html', 'text/html'],
  ['styles.css', 'text/css'],
  ['circle.css', 'text/css'],
  ['app.js', 'javascript'],
  ['model.mjs', 'javascript'],
  ['circle-view.mjs', 'javascript'],
  ['race-model.mjs', 'javascript'],
  ['manifest.webmanifest', 'json'],
  ['icons/favicon.svg', 'image/svg+xml'],
  ['icons/apple-touch-icon.png', 'image/png'],
  ['icons/icon-192.png', 'image/png'],
  ['icons/icon-512.png', 'image/png'],
  ['icons/icon-maskable-512.png', 'image/png'],
].map(([path, mediaType]) => [new URL(path, scope).href, mediaType]));

const shell = new URL('index.html', scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(installShell());
});

async function installShell() {
  const entries = await Promise.all(Array.from(shellFiles, async ([url, mediaType]) => {
    const request = new Request(url, { cache: 'reload', redirect: 'error' });
    const response = await fetch(request);
    const type = response.headers.get('content-type')?.toLowerCase() ?? '';
    if (!response.ok || response.redirected || !type.includes(mediaType) || (url === shell && !isAppShell(response))) {
      throw new Error(`Daymark could not cache its static asset: ${url}`);
    }
    return [request, response];
  }));

  const cache = await caches.open(CACHE_NAME);
  await Promise.all(entries.map(([request, response]) => cache.put(request, response)));
}

self.addEventListener('activate', (event) => {
  event.waitUntil(removeOldShells());
});

async function removeOldShells() {
  const versions = await caches.keys();
  await Promise.all(versions
    .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
    .map((key) => caches.delete(key)));
  await self.clients.claim();
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') event.waitUntil(self.skipWaiting());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  const navigation = request.mode === 'navigate' &&
    (url.origin + url.pathname === scope || url.origin + url.pathname === shell);

  // The shell is public app code. Account, invite, and check-in requests
  // bypass the service worker entirely.
  if (navigation) event.respondWith(navigate(request));
  else if (shellFiles.has(url.href)) event.respondWith(serveAsset(request, url.href));
});

function isAppShell(response) {
  return response.ok && response.headers.get('x-daymark-shell') === '1';
}

async function installedAsset(url) {
  try {
    const cache = await caches.open(CACHE_NAME);
    return await cache.match(url);
  } catch {
    // If browser storage is unavailable, let the request go to the server.
    return undefined;
  }
}

async function serveAsset(request, url) {
  return (await installedAsset(url)) || fetch(request);
}

async function navigate(request) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const stored = await installedAsset(shell);
    if (!stored) throw error;
    return stored;
  }

  // Check the server so sign-in redirects and access errors are respected.
  // For the app itself, keep HTML and resources on the installed release.
  if (response.redirected || (!isAppShell(response) && response.status !== 304 && response.status < 500)) {
    return response;
  }
  return (await installedAsset(shell)) || response;
}
