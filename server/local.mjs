import { createServer } from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './api.mjs';
import { assetResponse } from './http.mjs';
import { loadShellAssets } from './shell-assets.mjs';
import { openDatabase } from './sqlite.mjs';

const root = fileURLToPath(new URL('../public/', import.meta.url));
const dataDirectory = resolve(process.env.DAYMARK_DATA_DIR || '.daymark');
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const db = openDatabase(resolve(dataDirectory, 'daymark.sqlite'));
const host = process.env.DAYMARK_HOST || '127.0.0.1';
const port = Number(process.env.PORT || 4173);
const configuredOrigin = process.env.DAYMARK_ORIGIN ? new URL(process.env.DAYMARK_ORIGIN).origin : null;

const server = createServer(async (incoming, outgoing) => {
  try {
    const origin = configuredOrigin || 'http://' + (incoming.headers.host || 'localhost');
    const url = new URL(incoming.url, origin);
    if (url.origin !== origin) {
      outgoing.writeHead(400).end();
      return;
    }
    const headers = new Headers();
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
    }
    let body;
    if (incoming.method !== 'GET' && incoming.method !== 'HEAD') {
      const chunks = [];
      let size = 0;
      for await (const chunk of incoming) {
        size += chunk.length;
        if (size > 16384) {
          outgoing.writeHead(413, { 'Content-Type': 'text/plain' }).end('Request too large');
          return;
        }
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }

    const request = new Request(url, { method: incoming.method, headers, body });
    let response;
    if (url.pathname.startsWith('/api/')) {
      response = await handleApi(request, { db, standalone: true, remoteAddress: incoming.socket.remoteAddress });
    } else {
      let asset;
      const name = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const filename = resolve(root, '.' + name);
      if (filename.startsWith(root.endsWith(sep) ? root : root + sep) && extname(filename)) {
        try {
          const bytes = name === '/sw.js' ? loadShellAssets(root).assets.get('sw.js') : readFileSync(filename);
          asset = { bytes, extension: extname(filename) };
        } catch (error) {
          if (error.code !== 'ENOENT' && error.code !== 'EISDIR') throw error;
        }
      }
      response = assetResponse(request, asset);
    }
    const responseHeaders = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) responseHeaders['set-cookie'] = cookies;
    outgoing.writeHead(response.status, responseHeaders).end(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    console.error(error);
    if (!outgoing.headersSent) outgoing.writeHead(500, { 'Cache-Control': 'no-store' });
    outgoing.end('Something went wrong.');
  }
});

server.listen(port, host, () => console.log('Daymark is ready at http://' + host + ':' + server.address().port));
