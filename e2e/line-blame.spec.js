import { test, expect, chromium } from '@playwright/test'

test('optional line authorship follows changes across two browsers and reloads', async ({ browser, baseURL }) => {
  const otherBrowser = await chromium.launch()
  const a = await browser.newContext({ baseURL })
  const b = await otherBrowser.newContext({ baseURL })
  try {
    for (const [context, name, color] of [[a, 'Cass', '#1133dd'], [b, 'Robin', '#a82733']]) {
      const response = await context.request.patch('/api/session', { data: { name, color } })
      expect(response.ok()).toBe(true)
    }
    const doc = await (await a.request.post('/api/documents', { data: { text: 'First line.\nSecond line.' } })).json()
    const [alice, robin] = await Promise.all([a.newPage(), b.newPage()])
    await Promise.all([alice, robin].map(async page => {
      await page.goto(`/?document=${doc.id}`)
      await page.getByRole('button', { name: 'Split', exact: true }).click()
      await expect(page.locator('.line-blame-writer')).toHaveCount(0)
      await page.getByRole('button', { name: 'Line authorship' }).click()
      await expect(page.locator('.line-blame-writer')).toHaveText([/^Cass · /, /^Cass · /])
    }))
    const editor = robin.getByRole('textbox', { name: 'Screenplay editor' })
    await editor.press('Control+End')
    await robin.keyboard.insertText(' Edited.\nA new line.')
    const names = [/^Cass · /, /^Robin · /, /^Robin · /]
    for (const page of [alice, robin]) await expect(page.locator('.line-blame-writer')).toHaveText(names)
    await expect(alice.locator('.line-blame-writer').nth(1)).toHaveCSS('border-inline-start-color', 'rgb(168, 39, 51)')
    await alice.reload()
    await expect(alice.locator('.line-blame-writer')).toHaveText(names)
    await alice.getByRole('button', { name: 'Line authorship' }).click()
    await expect(alice.locator('.line-blame-writer')).toHaveCount(0)
  } finally {
    await a.close()
    await otherBrowser.close()
  }
})
