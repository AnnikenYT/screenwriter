import { createHash } from 'node:crypto'
import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'

export function serviceWorkerSource(version, assets) {
  return `// Generated public-only cache. Never store navigation or workspace data.
const PREFIX = 'screenplay-shell-';
const CACHE = PREFIX + ${JSON.stringify(version)};
const ASSETS = ${JSON.stringify(assets)};
const PUBLIC = new Set(ASSETS);
const HASHED = /^\\/assets\\/[^/]+-[A-Za-z0-9_-]{8,}\\.(?:js|css)$/;
self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    try {
      for (const asset of ASSETS) {
        const response = await fetch(new Request(asset, { credentials: 'omit', cache: 'reload' }));
        if (!response.ok || response.redirected || response.type === 'opaque') throw new Error('Public asset unavailable');
        await cache.put(asset, response);
      }
    } catch (error) {
      await caches.delete(CACHE);
      throw error;
    }
  })());
});
// Updates wait until every old tab closes, or an explicit user action.
self.addEventListener('message', event => {
  if (event.data?.type === 'SKIP_WAITING' && event.source?.url &&
      new URL(event.source.url).origin === self.location.origin) self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const previous = (await caches.keys()).filter(name => name.startsWith(PREFIX) && name !== CACHE);
    // Keep one previous build for lazy imports in already-open writer tabs.
    await Promise.all(previous.slice(0, -1).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      /^\\/(?:api|auth|uploads|collaboration)(?:\\/|$)/.test(url.pathname)) return;
  // Root document/query navigations get only the public offline substitute.
  // Neither their network responses nor query URLs are ever persisted.
  if (request.mode === 'navigate') {
    if (url.pathname !== '/' && url.pathname !== '/index.html') return;
    event.respondWith((async () => {
      try { return await fetch(request); }
      catch {
        return (await (await caches.open(CACHE)).match('/offline.html')) ||
          new Response('Reconnect to open your documents.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
      }
    })());
    return;
  }
  if (url.search || (!PUBLIC.has(url.pathname) && !HASHED.test(url.pathname))) return;
  event.respondWith((async () => {
    const current = await caches.open(CACHE);
    const cached = await current.match(url.pathname);
    if (cached) return cached;
    if (HASHED.test(url.pathname)) {
      const previous = (await caches.keys()).filter(name => name.startsWith(PREFIX) && name !== CACHE);
      for (const name of previous.slice(-1)) {
        const old = await (await caches.open(name)).match(url.pathname);
        if (old) return old;
      }
    }
    // No runtime caching, even for asset-shaped URLs.
    return fetch(request);
  })());
});
`
}

async function filesIn(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true })
  const groups = await Promise.all(entries.map(entry => {
    const name = path.posix.join(prefix, entry.name)
    return entry.isDirectory() ? filesIn(path.join(directory, entry.name), name) : [name]
  }))
  return groups.flat()
}

export function pwaPlugin() {
  let output
  return {
    name: 'screenplay-public-pwa',
    apply: 'build',
    configResolved(config) { output = path.resolve(config.root, config.build.outDir) },
    async closeBundle() {
      // Explicit public allowlist: adding unrelated public files cannot silently
      // expand the cache to include private data.
      const publicAssets = ['/offline.html', '/manifest.webmanifest',
        '/icons/document-192.png', '/icons/document-512.png', '/icons/apple-touch-icon.png',
        '/icons/icon-nobg-light.png', '/icons/icon-nobg-dark.png', '/icons/maskable-192.png', '/icons/maskable-512.png']
      const compiled = (await filesIn(output)).filter(name => /^assets\/[^/]+-[A-Za-z0-9_-]{8,}\.(js|css)$/.test(name))
      const assets = [...publicAssets, ...compiled.map(name => '/' + name)].sort()
      const hash = createHash('sha256')
      for (const asset of assets) {
        hash.update(asset)
        hash.update(await readFile(path.join(output, asset.slice(1))))
      }
      // Include the policy itself so a worker-only fix creates a new version.
      hash.update(serviceWorkerSource('', assets))
      await writeFile(path.join(output, 'sw.js'), serviceWorkerSource(hash.digest('hex').slice(0, 20), assets))
    },
  }
}
