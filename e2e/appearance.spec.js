import { test, expect } from '@playwright/test'

test('palette colors persist and System reacts to OS changes', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await page.getByRole('button', { name: 'Appearance', exact: true }).click()
  await page.getByLabel('Palette').selectOption('ocean')
  await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(228, 241, 248)')
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog', { name: 'Appearance' })).toBeHidden()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('.topbar')).toHaveCSS('background-color', 'rgb(28, 44, 58)')
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'ocean')
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute('content', '#1c2c3a')
})
