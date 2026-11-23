import { test, expect } from '@playwright/test'

const text = [
  '# First act', '', 'INT. ZOO - DAY #7A#', '', '= At the zoo', '',
  'MARA (V.O.)', '(quietly)', 'One.', 'Two.', '',
  'EXT. PARK - DAY', '', 'ELI', 'Wait.', '',
].join('\n')

async function open(page, request) {
  const { id } = await (await request.post('/api/documents', { data: { title: 'Sorting', text } })).json()
  await page.goto(`/?document=${id}`)
  const editor = page.getByRole('textbox', { name: 'Screenplay editor' })
  await expect(editor).toBeVisible()
  return editor
}

test('character sorting and search use live dialogue line counts', async ({ page, request }) => {
  const editor = await open(page, request)
  await page.getByRole('button', { name: 'Characters', exact: true }).click()
  const rows = page.locator('.sheet-list-item')
  const names = rows.locator('strong')
  await expect(names).toHaveText(['ELI', 'MARA'])
  const sort = page.getByLabel('Sort characters')
  await sort.selectOption('lines')
  await expect(names).toHaveText(['MARA', 'ELI'])
  await expect(rows.first()).toContainText('2 dialogue lines')
  await expect(rows.last()).toContainText('1 dialogue line')
  const search = page.getByRole('textbox', { name: 'Search characters' })
  await search.fill('eli')
  await expect(names).toHaveText(['ELI'])
  await search.clear()
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n\nELI (O.S.)\nCome.\nNow.\n')
  await expect(names).toHaveText(['ELI', 'MARA'])
  await expect(rows.first()).toContainText('3 dialogue lines')
})

test('scene sorting preserves numbering, source jumps, and the script outline', async ({ page, request }) => {
  await open(page, request)
  const scenes = page.locator('.outline-item.scene')
  const sort = page.getByLabel('Sort scenes')
  await expect(scenes.locator('.outline-number')).toHaveText(['7A', '2'])
  await expect(page.locator('.outline-item.synopsis')).toBeVisible()
  await sort.selectOption('heading')
  await expect(scenes.locator('.outline-number')).toHaveText(['2', '7A'])
  await expect(page.locator('.outline-item.synopsis')).toHaveCount(0)
  await expect(page.locator('.outline-item.section')).toHaveCount(0)
  await scenes.first().click()
  await expect(page.locator('.statusbar')).toContainText('Ln 12, Col 1')
  await expect(scenes.first()).toHaveClass(/current/)
  await sort.selectOption('script')
  await expect(scenes.locator('.outline-number')).toHaveText(['7A', '2'])
  await expect(scenes.last()).toHaveClass(/current/)
  await expect(page.locator('.outline-item.synopsis')).toBeVisible()
})
