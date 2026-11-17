import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { serviceWorkerSource, pwaPlugin } from '../build/pwa.js'
import { createWorkspace } from '../server/index.js'

const origin = 'https://screenplay.example'
const assets = ['/offline.html', '/icons/document.svg', '/assets/index-abcdefgh.js']

function worker(version = 'current', stores = new Map()) {
  const handlers = {}
  let skipped = 0
  let claimed = 0
  let network = async request => new Response(`public:${typeof request === 'string' ? request : request.url}`)
  const key = request => new URL(typeof request === 'string' ? request : request.url, origin).href
  const cacheStorage = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map())
      return {
        async put(request, response) { stores.get(name).set(key(request), response.clone()) },
        async match(request) { return stores.get(name).get(key(request))?.clone() },
      }
    },
    async keys() { return [...stores.keys()] },
    async delete(name) { return stores.delete(name) },
  }
  class WorkerRequest extends Request {
    constructor(input, options) { super(new URL(input, origin), options) }
  }
  vm.runInNewContext(serviceWorkerSource(version, assets), {
    URL, Set, Request: WorkerRequest, Response, caches: cacheStorage,
    fetch: request => network(request),
    self: {
      location: { origin },
      addEventListener(type, callback) { handlers[type] = callback },
      skipWaiting() { skipped++ },
      clients: { async claim() { claimed++ } },
    },
  })
  return {
    stores, caches: cacheStorage,
    setNetwork(callback) { network = callback },
    get skipped() { return skipped },
    get claimed() { return claimed },
    async lifecycle(type) {
      let task
      handlers[type]({ waitUntil(promise) { task = promise } })
      await task
    },
    message(data, url = origin + '/') { handlers.message({ data, source: { url } }) },
    fetch(url, options = {}) {
      let result
      handlers.fetch({
        request: { url: new URL(url, origin).href, method: 'GET', mode: 'cors', ...options },
        respondWith(promise) { result = promise },
      })
      return result
    },
  }
}

test('worker precaches exact public assets, never private requests or document/query responses', async () => {
  const sw = worker()
  const fetched = []
  sw.setNetwork(async request => {
    fetched.push(request)
    return new Response(request.url.endsWith('offline.html') ? 'Reconnect; keep unsynced tabs open' : 'public')
  })
  await sw.lifecycle('install')
  assert.deepEqual(fetched.map(request => new URL(request.url).pathname), assets)
  assert.ok(fetched.every(request => request.credentials === 'omit' && request.cache === 'reload'))
  assert.equal(sw.skipped, 0)
  for (const url of [
    '/api', '/api/session', '/api/documents', '/auth/login', '/auth/callback?code=secret',
    '/uploads/private.png', '/collaboration/abc', '/document/secret',
    '/icons/document.svg?identity=secret',
    'https://external.example/image.png', '/private.png', '/sw.js',
  ]) assert.equal(sw.fetch(url, { mode: 'navigate' }), undefined, url)
  assert.equal(sw.fetch('/icons/document.svg', { method: 'POST' }), undefined)
  assert.equal(sw.fetch('/api/session'), undefined)
  assert.equal(sw.fetch('/assets/index-abcdefgh.js?identity=secret'), undefined)
  assert.equal(sw.fetch('/icons/document.svg?identity=secret'), undefined)
  assert.equal(sw.fetch('https://external.example/image.png'), undefined)
  assert.equal(await (await sw.fetch('/icons/document.svg')).text(), 'public')
  sw.setNetwork(async () => { throw new Error('offline') })
  assert.match(await (await sw.fetch('/', { mode: 'navigate' })).text(), /Reconnect/)
  assert.match(await (await sw.fetch('/index.html', { mode: 'navigate' })).text(), /Reconnect/)
  for (const url of ['/?document=secret', '/index.html?document=secret']) {
    assert.match(await (await sw.fetch(url, { mode: 'navigate' })).text(), /Reconnect/)
  }
  const stored = [...sw.stores.values()].flatMap(store => [...store.keys()])
  assert.deepEqual(stored, assets.map(asset => origin + asset))
})

test('navigation is network-first and never stores HTML, identity or screenplay text', async () => {
  const sw = worker()
  await sw.lifecycle('install')
  sw.setNetwork(async () => new Response('private screenplay and user identity'))
  assert.equal(await (await sw.fetch('/', { mode: 'navigate' })).text(), 'private screenplay and user identity')
  assert.equal(await (await sw.fetch('/?document=private', { mode: 'navigate' })).text(), 'private screenplay and user identity')
  for (const store of sw.stores.values()) {
    assert.equal(store.has(origin + '/'), false)
    for (const response of store.values()) assert.doesNotMatch(await response.clone().text(), /private screenplay/)
  }
  // Unknown asset-shaped URLs may use network, but never populate the cache.
  await sw.fetch('/assets/private-abcdefgh.js')
  assert.equal(sw.stores.get('screenplay-shell-current').has(origin + '/assets/private-abcdefgh.js'), false)
})

test('activation is explicit, retains one previous build, and serves old hashed imports', async () => {
  const sw = worker()
  for (const name of ['unrelated-cache', 'screenplay-shell-oldest', 'screenplay-shell-previous']) {
    const cache = await sw.caches.open(name)
    await cache.put('/assets/editor-oldhash8.js', new Response(name))
  }
  await sw.lifecycle('install')
  await sw.lifecycle('activate')
  assert.equal(sw.claimed, 1)
  assert.equal(sw.skipped, 0)
  assert.deepEqual(await sw.caches.keys(), ['unrelated-cache', 'screenplay-shell-previous', 'screenplay-shell-current'])
  sw.setNetwork(async () => { throw new Error('offline') })
  assert.equal(await (await sw.fetch('/assets/editor-oldhash8.js')).text(), 'screenplay-shell-previous')
  sw.message({ type: 'OTHER' })
  sw.message({ type: 'SKIP_WAITING' }, 'https://external.example/')
  assert.equal(sw.skipped, 0)
  sw.message({ type: 'SKIP_WAITING' })
  assert.equal(sw.skipped, 1)
})

test('failed precache is discarded instead of installing a partial shell', async () => {
  const sw = worker()
  sw.setNetwork(async () => new Response('not found', { status: 404 }))
  await assert.rejects(sw.lifecycle('install'))
  assert.deepEqual(await sw.caches.keys(), [])
})

test('manifest, Apple metadata, maskable PNG dimensions and offline landing are valid', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url)))
  assert.equal(manifest.name, 'Screenplay')
  assert.equal(manifest.id, '/')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.display, 'standalone')
  for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }]) {
    const bytes = await readFile(new URL('../public' + icon.src, import.meta.url))
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes)
  }
  assert.ok(manifest.icons.every(icon => icon.purpose.includes('maskable')))
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /viewport-fit=cover/)
  assert.match(html, /apple-touch-icon/)
  assert.match(html, /apple-mobile-web-app-capable/)
  const offline = await readFile(new URL('../public/offline.html', import.meta.url), 'utf8')
  assert.match(offline, /unsynced/)
  assert.match(offline, /href="\/">Retry/)
  assert.doesNotMatch(offline, /<script|\bonclick=/i)
})

test('build plugin hashes content and excludes index, API-looking and unrelated files', async () => {
  const root = await mkdtemp('/tmp/opencode/screenplay-pwa-build-')
  try {
    const output = path.join(root, 'dist')
    await mkdir(path.join(output, 'assets'), { recursive: true })
    await mkdir(path.join(output, 'icons'))
    for (const name of ['offline.html', 'manifest.webmanifest', 'icons/document.svg', 'icons/document-192.png', 'icons/document-512.png', 'icons/apple-touch-icon.png']) {
      await writeFile(path.join(output, name), 'public asset')
    }
    for (const name of ['index.html', 'profile.json', 'assets/editor-abcdefgh.js', 'assets/main-12345678.css']) {
      await writeFile(path.join(output, name), name)
    }
    const plugin = pwaPlugin()
    plugin.configResolved({ root, build: { outDir: 'dist' } })
    await plugin.closeBundle()
    const first = await readFile(path.join(output, 'sw.js'), 'utf8')
    assert.match(first, /editor-abcdefgh\.js/)
    assert.match(first, /main-12345678\.css/)
    const precache = JSON.parse(first.match(/const ASSETS = (.*);/)[1])
    assert.ok(!precache.includes('/index.html') && !precache.includes('/profile.json'))
    await writeFile(path.join(output, 'offline.html'), 'updated public content')
    await plugin.closeBundle()
    assert.notEqual(await readFile(path.join(output, 'sw.js'), 'utf8'), first)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('backend worker, manifest, shell and private response headers remain safe', async t => {
  // Build output is required for the production static routes.
  try { await readFile(new URL('../dist/sw.js', import.meta.url)) }
  catch { t.skip('Run npm run build to check production response headers'); return }
  const directory = await mkdtemp('/tmp/opencode/screenplay-pwa-server-')
  const server = createWorkspace({ DATA_DIR: directory, AUTH_MODE: 'none' })
  try {
    await new Promise(resolve => server.server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.server.address().port}`
    const sw = await fetch(base + '/sw.js')
    assert.equal(sw.status, 200)
    assert.match(sw.headers.get('content-type'), /application\/javascript/)
    assert.equal(sw.headers.get('cache-control'), 'no-store')
    assert.equal(sw.headers.get('service-worker-allowed'), '/')
    assert.equal(sw.headers.get('set-cookie'), null, 'public precache assets must not create a guest identity')
    assert.match(sw.headers.get('content-security-policy'), /script-src 'self'/)
    const manifest = await fetch(base + '/manifest.webmanifest')
    assert.equal(manifest.status, 200)
    assert.match(manifest.headers.get('content-type'), /application\/manifest\+json/)
    assert.equal(manifest.headers.get('set-cookie'), null)
    for (const endpoint of ['/', '/?document=private', '/api/session', '/api/documents', '/auth/login', '/uploads/missing.png']) {
      const response = await fetch(base + endpoint, { redirect: 'manual' })
      assert.equal(response.headers.get('cache-control'), 'no-store', endpoint)
    }
  } finally {
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})

async function composable({ production = true, standalone = false, secure = true, failure = false } = {}) {
  let dispose
  let reloads = 0
  let registrations = 0
  const timers = new Map()
  let nextTimer = 0
  const target = () => {
    const listeners = new Map()
    return {
      addEventListener(name, handler) {
        if (!listeners.has(name)) listeners.set(name, new Set())
        listeners.get(name).add(handler)
      },
      removeEventListener(name, handler) { listeners.get(name)?.delete(handler) },
      fire(name, event = {}) { for (const handler of listeners.get(name) || []) handler(event) },
    }
  }
  const display = Object.assign(target(), { matches: standalone })
  const waiting = { messages: [], postMessage(message) { this.messages.push(message.type) } }
  const registration = Object.assign(target(), { waiting, installing: target() })
  const serviceWorker = Object.assign(target(), {
    async register() {
      registrations++
      if (failure) throw new Error('Storage blocked')
      return registration
    },
  })
  const navigator = { serviceWorker }
  const window = Object.assign(target(), {
    navigator, isSecureContext: secure, matchMedia: () => display,
    location: { reload() { reloads++ } },
  })
  const source = (await readFile(new URL('../src/lib/pwa.js', import.meta.url), 'utf8'))
    .replace(/^import .* from 'vue'\n/, '')
    .replace('export function usePwa', 'function usePwa')
    .replaceAll('import.meta.env.PROD', String(production))
  const context = vm.createContext({
    window, navigator, ref: value => ({ value }), onBeforeUnmount: callback => { dispose = callback },
    setTimeout(callback, delay) { const id = ++nextTimer; timers.set(id, { callback, delay }); return id },
    clearTimeout(id) { timers.delete(id) },
  })
  vm.runInContext(source + '\nglobalThis.api = usePwa()', context)
  return { api: context.api, window, display, serviceWorker, registration, waiting,
    dispose: () => dispose(), timers,
    expireTimers() { for (const { callback } of [...timers.values()]) callback() },
    get reloads() { return reloads }, get registrations() { return registrations } }
}

test('composable registers production only, exposes pending updates and reloads only by explicit action', async () => {
  const current = await composable()
  await current.api.register()
  assert.equal(current.api.updateAvailable.value, true)
  current.serviceWorker.fire('controllerchange')
  assert.equal(current.reloads, 0)
  const update = current.api.applyUpdate()
  assert.deepEqual(current.waiting.messages, ['SKIP_WAITING'])
  current.serviceWorker.fire('controllerchange')
  await update
  current.serviceWorker.fire('controllerchange')
  assert.equal(current.reloads, 1)
  assert.equal(current.timers.size, 0)
  current.dispose()
  current.window.fire('beforeinstallprompt', { preventDefault() {} })
  assert.equal(current.api.installAvailable.value, false)
  for (const options of [{ production: false }, { secure: false }]) {
    const instance = await composable(options)
    await instance.api.register()
    assert.equal(instance.registrations, 0)
  }
  const blocked = await composable({ failure: true })
  await assert.doesNotReject(blocked.api.register())
})

test('update rejects missing workers, postMessage failures and timeout without delayed reloads', async () => {
  const missing = await composable()
  await assert.rejects(missing.api.applyUpdate(), /No app update/)
  const failed = await composable()
  await failed.api.register()
  failed.waiting.postMessage = () => { throw new Error('Worker unavailable') }
  await assert.rejects(failed.api.applyUpdate(), /Worker unavailable/)
  assert.equal(failed.timers.size, 0)
  failed.serviceWorker.fire('controllerchange')
  assert.equal(failed.reloads, 0)
  const expired = await composable()
  await expired.api.register()
  const update = expired.api.applyUpdate()
  assert.equal([...expired.timers.values()][0].delay, 8000)
  const rejection = assert.rejects(update, /timed out/)
  expired.expireTimers()
  await rejection
  assert.equal(expired.timers.size, 0)
  expired.serviceWorker.fire('controllerchange')
  assert.equal(expired.reloads, 0)
})

test('unmount cancels pending activation, removes listeners and clears timers', async () => {
  const current = await composable()
  await current.api.register()
  const pending = current.api.applyUpdate()
  assert.equal(current.api.applyUpdate(), pending)
  const rejection = assert.rejects(pending, /cancelled/)
  current.dispose()
  await rejection
  assert.equal(current.timers.size, 0)
  current.serviceWorker.fire('controllerchange')
  current.expireTimers()
  assert.equal(current.reloads, 0)
  await assert.rejects(current.api.applyUpdate(), /No app update/)
})

test('composable handles deferred native install, manual install, display mode and updatefound', async () => {
  const current = await composable()
  await current.api.register()
  assert.equal((await current.api.install()).prompted, false)
  let prompts = 0
  current.window.fire('beforeinstallprompt', {
    preventDefault() {}, async prompt() { prompts++ }, userChoice: Promise.resolve({ outcome: 'accepted' }),
  })
  assert.equal(current.api.installAvailable.value, true)
  const result = await current.api.install()
  assert.equal(result.prompted, true)
  assert.equal(result.outcome, 'accepted')
  assert.equal(prompts, 1)
  assert.equal(current.api.installAvailable.value, false)
  current.display.matches = true
  current.display.fire('change')
  assert.equal(current.api.installed.value, true)
  current.registration.waiting = null
  current.registration.fire('updatefound')
  current.registration.installing.fire('statechange')
  assert.equal(current.api.updateAvailable.value, false)
  current.registration.waiting = current.waiting
  current.registration.installing.fire('statechange')
  assert.equal(current.api.updateAvailable.value, true)
  current.window.navigator.standalone = true
  current.display.matches = false
  current.display.fire('change')
  assert.equal(current.api.installed.value, true)
})
