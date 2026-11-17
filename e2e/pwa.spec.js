import { test, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

async function controlled(page) {
  await page.goto('/')
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready
    if (navigator.serviceWorker.controller) return
    await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }))
  })
}

test('production PWA registers public assets only and never caches workspace identity or screenplay text', async ({ page, request }) => {
  await controlled(page)
  const marker = `PRIVATE-SCREENPLAY-${Date.now()}`
  const response = await request.post('/api/documents', { data: { title: marker, text: marker } })
  const document = await response.json()
  await page.goto(`/?document=${document.id}`)
  await expect(page.getByRole('textbox', { name: 'Screenplay editor' })).toContainText(marker)
  await page.evaluate(async () => {
    await fetch('/api/session')
    await fetch('/api/documents')
    await fetch('/uploads/not-a-real-image.png')
  })
  const entries = await page.evaluate(async () => {
    const entries = []
    for (const name of await caches.keys()) {
      if (!name.startsWith('screenplay-shell-')) continue
      const cache = await caches.open(name)
      for (const key of await cache.keys()) {
        entries.push({ url: key.url, body: await (await cache.match(key)).text() })
      }
    }
    return entries
  })
  expect(entries.length).toBeGreaterThan(0)
  for (const entry of entries) {
    const url = new URL(entry.url)
    expect(url.search).toBe('')
    expect(url.pathname).toMatch(/^\/(?:offline\.html|manifest\.webmanifest|icons\/(?:document(?:-\d+\.png|\.svg)|maskable-(?:192|512)\.png|icon-nobg-(?:light|dark)\.png|apple-touch-icon\.png)|assets\/[^/]+-[\w-]{8,}\.(?:js|css))$/)
    expect(entry.body).not.toContain(marker)
    expect(entry.url).not.toContain(document.id)
  }
})

test('offline root and document-query refresh show only the public landing, never cached documents', async ({ page, context }) => {
  await controlled(page)
  await context.setOffline(true)
  try {
    for (const url of ['/', '/?document=private-offline-document', '/index.html?document=private-offline-document']) {
      await page.goto(url)
      await expect(page.getByRole('heading', { name: 'Reconnect to open your documents' })).toBeVisible()
      await expect(page.getByText(/Keep any open tabs with unsynced changes open/)).toBeVisible()
      await expect(page.getByRole('link', { name: 'Retry' })).toHaveAttribute('href', '/')
      await expect(page.getByRole('textbox', { name: 'Screenplay editor' })).toHaveCount(0)
      await page.reload()
      await expect(page.getByRole('heading', { name: 'Reconnect to open your documents' })).toBeVisible()
    }
    const keys = await page.evaluate(async () => {
      const urls = []
      for (const name of await caches.keys()) {
        const cache = await caches.open(name)
        urls.push(...(await cache.keys()).map(request => request.url))
      }
      return urls
    })
    expect(keys.length).toBeGreaterThan(0)
    for (const key of keys) {
      expect(new URL(key).search).toBe('')
      expect(key).not.toContain('private-offline-document')
    }
  } finally { await context.setOffline(false) }
  await page.getByRole('link', { name: 'Retry' }).click()
  await expect(page.locator('#app')).not.toBeEmpty()
})

test('explicit update reloads only the confirming tab and preserves edits across the server flush barrier', async ({ page, context, request }) => {
  test.setTimeout(60000)
  const workerPath = new URL('../dist/sw.js', import.meta.url)
  const original = await readFile(workerPath)
  let other
  try {
    await page.setViewportSize({ width: 1280, height: 900 })
    await controlled(page)
    const response = await request.post('/api/documents', {
      data: { title: 'PWA update lifecycle', text: 'INT. WORKSPACE - DAY\n\nA writer keeps working.\n' },
    })
    expect(response.ok()).toBe(true)
    const document = await response.json()
    await page.goto(`/?document=${document.id}`)
    const editor = page.getByRole('textbox', { name: 'Screenplay editor' })
    await expect(editor).toBeVisible()
    other = await context.newPage()
    await other.goto(`/?document=${document.id}`)
    await expect(other.getByRole('textbox', { name: 'Screenplay editor' })).toBeVisible()
    for (const tab of [page, other]) {
      expect(await tab.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true)
      await tab.evaluate(() => {
        window.__pwaLoadToken = 'original-open-writer'
        window.__pwaPreviousController = navigator.serviceWorker.controller
      })
    }
    let requestingNavigations = 0
    let otherNavigations = 0
    // history.replaceState also fires framenavigated when the app restores its
    // document URL. Count actual document loads, not same-document history.
    page.on('domcontentloaded', () => requestingNavigations++)
    other.on('domcontentloaded', () => otherNavigations++)
    await writeFile(workerPath, Buffer.concat([original, Buffer.from(`\n// E2E explicit update ${randomUUID()}\n`)]))
    await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.getRegistration('/')
      await registration.update()
    })
    await expect(page.getByRole('button', { name: 'Update app', exact: true }).first()).toBeVisible()
    await expect(other.getByRole('button', { name: 'Update app', exact: true }).first()).toBeVisible()
    // A waiting update must not reload either writer before user confirmation.
    expect(requestingNavigations).toBe(0)
    expect(otherNavigations).toBe(0)
    const marker = `Typed immediately before update ${randomUUID()}`
    await editor.click()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText(`\n${marker}`)
    // Do not wait for the other tab to receive the text: the app's explicit
    // server flush barrier, not an arbitrary delay, must make reload safe.
    await page.getByRole('button', { name: 'Update app', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Update available' })
    await expect(dialog).toBeVisible()
    await Promise.all([
      page.waitForEvent('load'),
      dialog.getByRole('button', { name: 'Reload and update', exact: true }).click(),
    ])
    await expect(page.getByRole('textbox', { name: 'Screenplay editor' })).toContainText(marker)
    await expect(other.getByRole('textbox', { name: 'Screenplay editor' })).toContainText(marker)
    await expect.poll(() => other.evaluate(() =>
      navigator.serviceWorker.controller !== window.__pwaPreviousController,
    )).toBe(true)
    expect(requestingNavigations).toBe(1)
    expect(otherNavigations).toBe(0)
    expect(await other.evaluate(() => window.__pwaLoadToken)).toBe('original-open-writer')
    expect(await page.evaluate(() => window.__pwaLoadToken)).toBeUndefined()
    // Updating changes only generated output for this test; the exact original
    // bytes are restored even when an assertion or browser operation fails.
  } finally {
    await writeFile(workerPath, original)
    if (other) await other.close()
  }
})

test('install manifest and Apple icons use a secure-context-compatible standalone configuration', async ({ page, request }) => {
  await page.goto('/')
  const environment = await page.evaluate(() => ({
    secure: window.isSecureContext,
    protocol: location.protocol,
    hostname: location.hostname,
  }))
  // Browser installation requires HTTPS in deployment; loopback HTTP is the
  // secure-context exception used by this local suite. Native OS install UI is
  // not driven by headless Playwright.
  expect(environment.secure).toBe(true)
  expect(environment.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(environment.hostname)).toBe(true)
  const manifestURL = await page.locator('link[rel="manifest"]').getAttribute('href')
  const response = await request.get(manifestURL)
  expect(response.headers()['content-type']).toContain('application/manifest+json')
  const manifest = await response.json()
  expect(manifest).toMatchObject({ id: '/', name: 'Screenplay', start_url: '/', scope: '/', display: 'standalone' })
  for (const icon of manifest.icons) expect((await request.get(icon.src)).ok()).toBe(true)
  const apple = await page.locator('link[rel="apple-touch-icon"]').getAttribute('href')
  expect((await request.get(apple)).headers()['content-type']).toContain('image/png')
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', /viewport-fit=cover/)
})
