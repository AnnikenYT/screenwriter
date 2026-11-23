import { test, expect } from '@playwright/test'

const text = 'Title: The Film\nAuthor: Ada Writer\nContact: ada@example.com\n\nINT. ROOM - DAY\n\n> CENTERED ACTION <\n'

test('anonymous title page settings update the rendered views and stay local to the browser', async ({ page, browser }) => {
  const response = await page.request.post('/api/documents', { data: { title: 'Local alignment', text } })
  expect(response.ok()).toBe(true)
  const { id } = await response.json()
  await page.goto(`/?document=${id}`)
  await page.getByRole('textbox', { name: 'Screenplay editor' }).press('Control+End')
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  const titleLine = page.locator('.ft-title.ft-rendered').first()
  await expect(titleLine).toHaveCSS('text-align', 'center')

  await settings.click()
  await page.getByLabel('Title page alignment').selectOption('right')
  await page.getByRole('button', { name: 'Cancel' }).click()
  await expect(titleLine).toHaveCSS('text-align', 'center')
  await settings.click()
  await page.getByLabel('Title page alignment').selectOption('left')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await expect(titleLine).toHaveCSS('text-align', 'left')
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(page.locator('.title-page-main')).toHaveCSS('text-align', 'left')
  await expect(page.locator('.title-page-contact')).toHaveCSS('text-align', 'start')
  await expect(page.locator('.fountain.centered')).toHaveCSS('text-align', 'center')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const pdf = page.getByRole('link', { name: 'Screenplay PDF', exact: true })
  await expect(pdf).toHaveAttribute('href', `/api/documents/${id}/export.pdf?titlePageAlignment=left`)
  expect(await (await page.request.get(`/api/documents/${id}/export.fountain`)).text()).toBe(text)

  await page.reload()
  await expect(page.locator('.title-page-main')).toHaveCSS('text-align', 'left')
  const fresh = await browser.newContext()
  try {
    const tab = await fresh.newPage()
    await tab.goto(page.url())
    await tab.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(tab.locator('.title-page-main')).toHaveCSS('text-align', 'center')
  } finally { await fresh.close() }
})

test('title page settings are reachable from mobile tools', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const response = await page.request.post('/api/documents', { data: { title: 'Mobile alignment', text } })
  expect(response.ok()).toBe(true)
  const { id } = await response.json()
  await page.goto(`/?document=${id}`)
  await page.getByRole('button', { name: 'Open tools' }).click()
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByLabel('Title page alignment').selectOption('right')
  await page.getByRole('button', { name: 'Save settings' }).click()
  await page.getByRole('button', { name: 'Close tools' }).click()
  await page.getByRole('button', { name: 'Preview', exact: true }).click()
  await expect(page.locator('.title-page-main')).toBeVisible()
  await expect(page.locator('.title-page-main')).toHaveCSS('text-align', 'right')
})
