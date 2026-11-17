// Run `npm run icons` after changing the artwork. Requires Playwright Chromium
// (`npx playwright install chromium`), but normal builds use the committed PNGs.
import { readFile, writeFile } from 'node:fs/promises'
import { chromium } from '@playwright/test'

const directory = new URL('../public/icons/', import.meta.url)
const source = `data:image/png;base64,${(await readFile(new URL('icon-nobg-light.png', directory))).toString('base64')}`
const browser = await chromium.launch()
try {
  const page = await browser.newPage()
  for (const [filename, size, scale] of [
    ['document-192.png', 192, .86],
    ['document-512.png', 512, .86],
    ['maskable-192.png', 192, .54],
    ['maskable-512.png', 512, .54],
    ['apple-touch-icon.png', 180, .86],
  ]) {
    const encoded = await page.evaluate(async ({ source, size, scale }) => {
      const image = new Image()
      image.src = source
      await image.decode()
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = size
      const context = canvas.getContext('2d')
      context.fillStyle = '#f6f5f2'
      context.fillRect(0, 0, size, size)
      context.imageSmoothingEnabled = true
      context.imageSmoothingQuality = 'high'
      const width = size * scale
      context.drawImage(image, (size - width) / 2, (size - width) / 2, width, width)
      return canvas.toDataURL('image/png').split(',')[1]
    }, { source, size, scale })
    await writeFile(new URL(filename, directory), Buffer.from(encoded, 'base64'))
  }
} finally { await browser.close() }
