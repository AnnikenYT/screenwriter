import { test, expect } from '@playwright/test'

for (const mode of ['Live', 'Split', 'Phone', 'Suggesting']) {
  test(`typing automatically opens character and location suggestions in ${mode}`, async ({ page, request }) => {
    if (mode === 'Phone') await page.setViewportSize({ width: 390, height: 844 })
    const response = await request.post('/api/documents', { data: {
      title: 'Automatic completion',
      text: 'INT. LIGHTHOUSE - NIGHT\n\nMARA\nHello.\n\nMARTIN\nHi.\n',
    } })
    const { id } = await response.json()
    await page.goto(`/?document=${id}`)
    const editor = page.getByRole('textbox', { name: 'Screenplay editor' })
    await expect(editor).toBeVisible()
    if (mode === 'Live' || mode === 'Split') await page.getByRole('button', { name: mode, exact: true }).click()
    if (mode === 'Suggesting') await page.getByRole('button', { name: 'Editing', exact: true }).click()
    await editor.focus()
    await page.keyboard.press('Control+End')
    await page.keyboard.insertText('\n\n')
    await page.keyboard.type('MA', { delay: 60 })
    const popup = page.getByRole('listbox')
    await expect(popup).toBeVisible()
    await expect(popup).toContainText('MARA')
    await expect(popup).toContainText('MARTIN')
    await page.keyboard.press('Escape')
    await expect(popup).toBeHidden()
    await page.keyboard.type('R')
    await expect(popup).toBeVisible()
    await page.keyboard.press('Tab')
    await expect(editor).toContainText('MARA')
    await page.keyboard.insertText('\nHello again.\n\nINT. ')
    await page.keyboard.type('LIG', { delay: 60 })
    await expect(popup).toBeVisible()
    await expect(popup).toContainText('LIGHTHOUSE')
    await popup.getByRole('option').filter({ hasText: 'LIGHTHOUSE' }).click()
    await expect(editor).toContainText('INT. LIGHTHOUSE')
    await page.keyboard.insertText('\n\nMARA\n')
    await page.keyboard.type('MA', { delay: 60 })
    await expect(popup).toBeHidden()
    await page.keyboard.insertText('\n\nAn ordinary action paragraph.')
    await expect(popup).toBeHidden()
  })
}
