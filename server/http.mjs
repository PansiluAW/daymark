const types = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

const csp = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:", "connect-src 'self'", "worker-src 'self'",
  "object-src 'none'", "base-uri 'none'", "form-action 'self'",
].join('; ');

export function assetResponse(request, asset) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('Method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (!asset) return new Response('Page not found', { status: 404 });
  return new Response(request.method === 'HEAD' ? null : asset.bytes, {
    headers: {
      'Content-Type': types[asset.extension] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
      ...(asset.extension === '.html' ? { 'X-Daymark-Shell': '1' } : {}),
      'Content-Security-Policy': csp,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    },
  });
}

export function trustedSiteIdentity(headers) {
  const id = headers.get('oai-authenticated-user-id');
  if (!id) return null;
  let name = headers.get('oai-authenticated-user-full-name') || '';
  if (name && headers.get('oai-authenticated-user-full-name-encoding') === 'percent-encoded-utf-8') {
    try { name = decodeURIComponent(name); } catch { name = ''; }
  }
  return { id, name: name || headers.get('oai-authenticated-user-email')?.split('@')[0] || 'Daymark member' };
}
