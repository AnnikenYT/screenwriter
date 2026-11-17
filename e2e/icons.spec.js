import { test, expect } from '@playwright/test'

test('favicon and offline artwork follow browser contrast even when app theme differs', async ({ page }) => {
  const activeIcons = () => page.evaluate(() => [...document.querySelectorAll('link[data-app-icon]')]
    .filter(icon => matchMedia(icon.media).matches).map(icon => icon.getAttribute('href')))
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(await activeIcons()).toEqual(['/icons/icon-nobg-dark.png'])
  await page.getByRole('button', { name: 'Switch to light mode', exact: true }).click()
  // Changing a page's theme does not change the browser tab's background.
  expect(await activeIcons()).toEqual(['/icons/icon-nobg-dark.png'])
  await page.reload()
  expect(await activeIcons()).toEqual(['/icons/icon-nobg-dark.png'])
  await page.emulateMedia({ colorScheme: 'light' })
  expect(await activeIcons()).toEqual(['/icons/icon-nobg-light.png'])
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/offline.html')
  await expect.poll(() => page.locator('picture img').evaluate(image => image.currentSrc)).toContain('/icons/icon-nobg-dark.png')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect.poll(() => page.locator('picture img').evaluate(image => image.currentSrc)).toContain('/icons/icon-nobg-light.png')
})

test('installed icons are opaque and maskable artwork fits inside the safe circle', async ({ page }) => {
  await page.goto('/')
  const icons = await page.evaluate(async () => {
    const manifest = await (await fetch('/manifest.webmanifest')).json()
    const icons = [...manifest.icons, { src: '/icons/apple-touch-icon.png', purpose: 'any' }]
    return Promise.all(icons.map(async icon => {
      const image = new Image()
      image.src = icon.src
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = image.naturalWidth
      canvas.height = image.naturalHeight
      const context = canvas.getContext('2d')
      context.drawImage(image, 0, 0)
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data
      let opaque = true, foreground = 0, maxRadius = 0
      for (let index = 0; index < pixels.length; index += 4) {
        if (pixels[index + 3] !== 255) opaque = false
        if (Math.abs(pixels[index] - 246) + Math.abs(pixels[index + 1] - 245) + Math.abs(pixels[index + 2] - 242) > 12) {
          foreground++
          const x = (index / 4) % canvas.width + .5 - canvas.width / 2
          const y = Math.floor(index / 4 / canvas.width) + .5 - canvas.height / 2
          maxRadius = Math.max(maxRadius, Math.hypot(x, y))
        }
      }
      return { ...icon, opaque, foreground, maxRadius, size: canvas.width }
    }))
  })
  for (const icon of icons) {
    expect(icon.opaque, icon.src).toBe(true)
    expect(icon.foreground, icon.src).toBeGreaterThan(icon.size * icon.size * .002)
    if (icon.purpose === 'maskable') expect(icon.maxRadius, icon.src).toBeLessThanOrEqual(icon.size * .4)
  }
})
