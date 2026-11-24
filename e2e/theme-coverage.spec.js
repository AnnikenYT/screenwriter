import { test, expect } from '@playwright/test'

const palettes = ['sage', 'ocean', 'plum', 'mono', 'gruvbox']
const text = 'Title: THE LIGHT BETWEEN\nAuthor: You\n\n# Act I\n\nINT. LIGHTHOUSE - NIGHT\n\nA narrow beam turns across the water.\n\nMARA\nSomebody is still out there.\n\nELI\nThen leave the light on.\n'

for (const palette of palettes) for (const theme of ['light', 'dark']) {
  test(`${palette} ${theme}: workspace tokens, contrast and persistence`, async ({ page, request }, testInfo) => {
    const response = await request.post('/api/documents', { data: { title: 'Theme coverage', text } })
    expect(response.ok()).toBeTruthy()
    const { id } = await response.json()
    await page.setViewportSize({ width: 1440, height: 900 })
    await page.goto(`/?document=${id}`)
    await expect(page.getByRole('textbox', { name: 'Screenplay editor' })).toBeVisible()
    // Sample settled styles, not intermediate transition colors after a switch.
    await page.addStyleTag({ content: '*, *::before, *::after { transition: none !important; }' })
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.getByLabel('Palette').selectOption(palette)
    await page.getByLabel('Brightness').selectOption(theme)
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Characters', exact: true }).click()
    await expect(page.locator('.sheet-list-item').first()).toBeVisible()
    const characterColor = await page.locator('.sheet-initial').first().evaluate(el => el.style.color)

    const inspect = async () => page.evaluate(() => {
      const root = getComputedStyle(document.documentElement)
      const probe = document.createElement('div')
      document.body.append(probe)
      const resolve = (token, property = 'color') => {
        probe.style[property] = `var(--${token})`
        const value = getComputedStyle(probe)[property]
        // Canvas converts both rgb() and color(srgb) to numeric channels.
        const canvas = document.createElement('canvas')
        canvas.width = canvas.height = 1
        const ctx = canvas.getContext('2d')
        ctx.fillStyle = value
        ctx.fillRect(0, 0, 1, 1)
        return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3)
      }
      const tokens = Object.fromEntries([
        'theme-background', 'theme-chrome', 'theme-tools', 'theme-desk', 'paper',
        'accent', 'accent-light', 'accent-contrast', 'theme-hover', 'line', 'text', 'muted',
        'text-secondary', 'text-faint', 'row-hover', 'row-active', 'input-bg', 'input-text',
        'input-focus-border', 'focus-ring', 'segmented-bg', 'surface-muted', 'theme-panel',
        'icon', 'icon-strong', 'scene-text', 'character-text', 'section-text', 'transition-text',
        'danger', 'danger-bg', 'warning', 'warning-bg', 'success', 'success-bg', 'info',
      ].map(token => [token, resolve(token)]))
      const checks = [
        ['.topbar', 'backgroundColor', 'theme-chrome'],
        ['.tool-rail', 'backgroundColor', 'theme-tools'],
        ['.editor-main', 'backgroundColor', 'theme-desk'],
        ['.search-input', 'backgroundColor', 'input-bg'],
        ['.search-input', 'color', 'input-text'],
        ['.mode-switch .active', 'backgroundColor', 'paper'],
        ['.sidebar', 'backgroundColor', 'theme-tools'],
        ['.sheet-list-item', 'borderBottomColor', 'line-soft'],
        ['.sheet-list-item strong', 'color', 'text'],
      ].map(([selector, property, token]) => {
        probe.style[property] = `var(--${token})`
        return { selector, property, actual: getComputedStyle(document.querySelector(selector))[property], expected: getComputedStyle(probe)[property] }
      })
      const chrome = root.getPropertyValue('--theme-chrome').trim()
      probe.remove()
      return { tokens, checks, chrome }
    })
    const result = await inspect()
    for (const check of result.checks) expect(check.actual, `${check.selector} ${check.property}`).toBe(check.expected)
    const lum = channels => channels.map(v => v / 255).map(v => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0)
    const ratio = (a, b) => (Math.max(lum(a), lum(b)) + .05) / (Math.min(lum(a), lum(b)) + .05)
    for (const [fg, bg] of [
      ['text', 'paper'], ['text-secondary', 'theme-tools'], ['text-faint', 'input-bg'],
      ['text-faint', 'surface-muted'], ['accent', 'paper'], ['accent-contrast', 'accent'],
      ['accent-contrast', 'theme-hover'], ['danger', 'danger-bg'], ['success', 'success-bg'],
      ['warning', 'warning-bg'], ['info', 'paper'],
    ]) expect(ratio(result.tokens[fg], result.tokens[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(4.5)
    if (palette === 'mono') {
      for (const [token, channels] of Object.entries(result.tokens)) {
        if (/^(danger|warning|success|info)/.test(token)) continue
        expect(channels[0], token).toBe(channels[1])
        expect(channels[1], token).toBe(channels[2])
      }
    }
    await page.locator('.search-input').focus()
    expect(await page.locator('.search-input').evaluate(el => getComputedStyle(el).outlineStyle)).toBe('solid')
    const row = page.locator('.sheet-list-item').first()
    await row.hover()
    await expect(row).toHaveCSS('background-color', await page.evaluate(() => {
      const probe = document.createElement('div')
      probe.style.backgroundColor = 'var(--row-hover)'
      document.body.append(probe)
      const color = getComputedStyle(probe).backgroundColor
      probe.remove()
      return color
    }))
    await page.mouse.move(1400, 20)
    await page.screenshot({ path: testInfo.outputPath(`${palette}-${theme}-live.png`) })
    await page.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(page.locator('.source-pane')).toBeVisible()
    await expect(page.locator('.preview-pane .paper')).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${palette}-${theme}-split.png`) })
    await page.locator('.sheet-list-item strong').filter({ hasText: 'MARA' }).click()
    await expect(page.getByLabel('Character color', { exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath(`${palette}-${theme}-detail.png`) })
    await page.getByRole('button', { name: 'Appearance', exact: true }).click()
    await page.screenshot({ path: testInfo.outputPath(`${palette}-${theme}-appearance.png`) })
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme)
    await expect(page.locator('html')).toHaveAttribute('data-palette', palette)
    await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', result.chrome)
    await expect(page.locator('.source-pane')).toBeVisible()
    await page.getByRole('button', { name: 'Characters', exact: true }).click()
    expect(await page.locator('.sheet-initial').first().evaluate(el => el.style.color)).toBe(characterColor)
  })
}
