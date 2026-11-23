import { test, expect } from '@playwright/test'

async function open(page, request, text, mobile = false) {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 })
  const { id } = await (await request.post('/api/documents', { data: { title: 'Screenplay statistics', text } })).json()
  await page.goto(`/?document=${id}`)
  const editor = page.getByRole('textbox', { name: 'Screenplay editor' })
  await expect(editor).toBeVisible()
  if (mobile) await page.getByRole('button', { name: 'Open tools', exact: true }).click()
  await page.getByRole('button', { name: 'Stats', exact: true }).click()
  return editor
}

test('stats report live runtime, scene cast, and speaking time with source jumps', async ({ page, request }) => {
  const editor = await open(page, request, 'INT. ZOO - DAY #7A#\n\nMARA\nWe should go now.\n\nEXT. PARK - DAY\n\nMARA closes a door.\n')
  const stats = page.getByRole('region', { name: 'Screenplay statistics' })
  const runtime = stats.locator('dl div').filter({ hasText: 'Estimated runtime' }).locator('dd')
  const zoo = stats.getByRole('button', { name: /7A · INT. ZOO/ })
  const park = stats.getByRole('button', { name: /2 · EXT. PARK/ })
  await expect(runtime).toHaveText('3s')
  await expect(zoo).toContainText('2s · 1 cast member')
  await expect(park).toContainText('1s · 1 cast member')
  await expect(stats.getByRole('button', { name: /^MARA/ })).toContainText('2s · 4 words · 1 line')
  await park.click()
  await expect(page.locator('.statusbar')).toContainText('Ln 6, Col 1')
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n\nELI\nOne two three four five.\n')
  await expect(park).toContainText('3s · 2 cast members')
  await expect(runtime).toHaveText('5s')
  await expect(stats.getByRole('button', { name: /^ELI/ })).toContainText('2s · 5 words · 1 line')
})

test('stats are reachable on mobile and show an empty screenplay as zero', async ({ page, request }) => {
  await open(page, request, 'Title: Untitled\n', true)
  const tools = page.getByRole('dialog', { name: 'Workspace tools' })
  const stats = tools.getByRole('region', { name: 'Screenplay statistics' })
  await expect(stats.locator('dd')).toHaveText(['0s', '0', '0', '0', '0'])
  await expect(stats.getByText('No scene headings yet.')).toBeVisible()
  await expect(stats.getByText('No dialogue yet.')).toBeVisible()
  await stats.getByText('How runtime is estimated').click()
  await expect(stats.getByText(/150 words per minute/)).toBeVisible()
})
