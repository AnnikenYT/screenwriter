import { test, expect } from '@playwright/test'

test('drag selection stays under the mouse when leaving a section heading', async ({ page, request }) => {
  const text = '# FIRST ACT\n\nINT. ROOM - DAY\n\nA word to select, then the next.\nAnother line, and another.\n'
  const { id } = await (await request.post('/api/documents', { data: { title: 'Selection geometry', text } })).json()
  await page.goto(`/?document=${id}`)
  const heading = page.locator('.live-editor .ft-section')
  await expect(heading).toHaveClass(/ft-active/)
  const line = page.locator('.live-editor .ft-action').filter({ hasText: 'A word to select' })
  const glyphs = await line.evaluate(node => {
    const range = document.createRange()
    range.selectNodeContents(node)
    return range.getBoundingClientRect().toJSON()
  })
  const y = glyphs.top + glyphs.height / 2
  await page.mouse.move(glyphs.left + 1, y)
  await page.mouse.down()
  await page.mouse.move(glyphs.right - 1, y, { steps: 8 })
  await page.mouse.up()
  await expect(heading).toHaveClass(/ft-rendered/)
  expect(await page.evaluate(() => document.getSelection().toString())).toBe('A word to select, then the next.')
  const selection = await page.locator('.live-editor .cm-selectionBackground').boundingBox()
  expect(Math.abs(selection.y - glyphs.top)).toBeLessThanOrEqual(1)
})
