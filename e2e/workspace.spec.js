import { test, expect } from '@playwright/test'

const sample = `Title: THE LIGHT BETWEEN
Credit: Written by
Author: You

# Act I

INT. LIGHTHOUSE - NIGHT

A narrow beam turns across the water. MARA watches from the window.

MARA
(almost to herself)
Somebody's still out there.
And they know we're here.

ELI
Then leave the light on.

EXT. SHORE - DAWN

The tide returns what the night has taken.
`

async function open(page, request, text = sample) {
  const response = await request.post('/api/documents', { data: { title: 'The light between', text } })
  const doc = await response.json()
  await page.goto(`/?document=${doc.id}`)
  await expect(page.getByRole('textbox', { name: 'Screenplay editor' })).toBeVisible()
  return doc
}
const screenplay = page => page.getByRole('textbox', { name: 'Screenplay editor' })

test('two independent browsers collaborate, review, take notes and export', async ({ page, browser, request }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const doc = await open(page, request)
  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  other.on('pageerror', error => errors.push(error.message))
  await other.goto(`/?document=${doc.id}`)
  await expect(screenplay(other)).toBeVisible()
  await expect(page.getByText('2 collaborators')).toBeVisible()
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(page.getByLabel('Rendered screenplay')).toContainText("Somebody's still out there.")
  await screenplay(page).click()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\nA gull circles overhead.')
  await expect(screenplay(other)).toContainText('A gull circles overhead.')

  await screenplay(page).focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('Shift+End')
  await page.getByRole('button', { name: 'Add comment', exact: true }).click()
  await page.getByLabel('Comment on selection').fill('Keep this quiet and restrained.')
  await page.locator('.review-compose').getByRole('button', { name: 'Add comment', exact: true }).click()
  await other.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(other.getByText('Keep this quiet and restrained.')).toBeVisible()
  await other.getByLabel('Reply to comment').fill('Agreed.')
  await other.getByRole('button', { name: 'Send reply' }).click()
  await expect(page.getByText('Agreed.', { exact: true })).toBeVisible()
  await other.getByRole('button', { name: 'Resolve', exact: true }).click()
  await expect(page.getByText('Keep this quiet and restrained.')).not.toBeVisible()

  await screenplay(page).focus()
  await page.keyboard.press('Control+End')
  await page.getByRole('button', { name: 'Suggestions', exact: true }).click()
  await page.getByLabel('Suggested insertion at cursor').fill('\n\nA distant bell.')
  await page.getByRole('button', { name: 'Suggest edit', exact: true }).click()
  await other.getByRole('button', { name: 'Suggestions', exact: true }).click()
  await expect(other.locator('.suggestion-diff')).toContainText('A distant bell.')
  await expect(screenplay(other)).not.toContainText('A distant bell.')
  await other.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(screenplay(page)).toContainText('A distant bell.')

  await page.getByRole('button', { name: 'Scratchpad', exact: true }).click()
  await other.getByRole('button', { name: 'Scratchpad', exact: true }).click()
  await page.getByRole('textbox', { name: 'Shared scratchpad' }).fill('# Research\nThe lighthouse keeper knows more.')
  await expect(other.getByRole('textbox', { name: 'Shared scratchpad' })).toContainText('The lighthouse keeper knows more.')

  const pdf = await request.get(`/api/documents/${doc.id}/export.pdf`)
  expect(pdf.ok()).toBeTruthy()
  expect((await pdf.body()).subarray(0, 5).toString()).toBe('%PDF-')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  const downloaded = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Fountain (.fountain)', exact: true }).click()
  expect((await downloaded).suggestedFilename()).toBe('The light between.fountain')
  expect(errors).toEqual([])
  await otherContext.close()
})

test('sheets, moodboard, suggesting mode and version restoration', async ({ page, request }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await open(page, request)
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  await page.getByRole('button', { name: 'Characters', exact: true }).click()
  await page.getByRole('button', { name: 'MARA Character sheet' }).click()
  await page.getByLabel('Name', { exact: true }).fill('McClane')
  await page.getByLabel('Name', { exact: true }).press('Tab')
  await expect(screenplay(page)).toContainText('@McClane')
  await page.getByLabel('Age', { exact: true }).fill('34')
  await page.locator('.upload-button input').setInputFiles({
    name: 'mood.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=', 'base64'),
  })
  await expect(page.getByAltText('Moodboard reference')).toBeVisible()
  await page.getByRole('button', { name: 'Locations', exact: true }).click()
  await page.getByRole('button', { name: 'LIGHTHOUSE Location sheet' }).click()
  await expect(page.locator('.reference-link')).toContainText('INT. LIGHTHOUSE - NIGHT')

  await page.getByRole('button', { name: 'Versions', exact: true }).click()
  await page.getByLabel('Version name').fill('First draft')
  await page.getByRole('button', { name: 'Save version', exact: true }).click()
  await expect(page.getByRole('button', { name: /First draft/ })).toBeVisible()
  await screenplay(page).focus()
  await page.keyboard.press('Control+End')
  await page.getByRole('button', { name: 'Editing', exact: true }).click()
  await screenplay(page).focus()
  await page.keyboard.insertText(' A proposed ending.')
  await expect(page.getByLabel('Suggested insertion at cursor')).toHaveValue(' A proposed ending.')
  await expect(screenplay(page)).not.toContainText('A proposed ending.')
  await page.getByRole('button', { name: 'Suggest edit', exact: true }).click()
  await page.getByRole('button', { name: 'Accept', exact: true }).click()
  await expect(screenplay(page)).toContainText('A proposed ending.')
  await page.getByRole('button', { name: 'Suggesting', exact: true }).click()
  await page.getByRole('button', { name: 'Versions', exact: true }).click()
  await page.getByRole('button', { name: /First draft/ }).click()
  await page.getByRole('button', { name: 'Restore this version', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm restore', exact: true }).click()
  await expect(screenplay(page)).not.toContainText('A proposed ending.')
  await expect(page.getByRole('button', { name: /Before restore/ })).toBeVisible()
  expect(errors).toEqual([])
})

test('live formatting reveals source at the cursor and retains dialogue until two lines below', async ({ page, request }) => {
  await open(page, request, 'INT. ROOM - DAY\n\nMARA\n*First line.*\nSecond line.\n\n\nAction.\n')
  await expect(page.locator('.text-editor')).toHaveClass(/live-editor/)
  expect(await screenplay(page).evaluate(el => getComputedStyle(el.parentElement).fontFamily)).toContain('Courier')
  await screenplay(page).focus()
  await page.keyboard.press('Control+Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.cm-line.ft-character')).toHaveClass(/ft-active/)
  await expect(page.locator('.cm-line.ft-dialogue').first()).toHaveClass(/ft-active/)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.cm-line.ft-dialogue').first()).toHaveClass(/ft-active/)
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.cm-line.ft-dialogue').first()).toHaveClass(/ft-rendered/)
  await page.screenshot({ path: '/tmp/opencode/screenplay-desktop.png', fullPage: true })
})

test('mobile editor and sidebar fit without horizontal page overflow', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  await open(page, request)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
  await expect(screenplay(page)).toBeVisible()
  await page.getByRole('button', { name: 'Characters', exact: true }).click()
  await expect(page.getByRole('button', { name: 'MARA Character sheet' })).toBeVisible()
  await page.screenshot({ path: '/tmp/opencode/screenplay-mobile.png', fullPage: true })
})

test('feature-length source stays virtualized and responsive', async ({ page, request }) => {
  const text = Array.from({ length: 120 }, (_, i) => `INT. ROOM ${i + 1} - DAY\n\n${'A careful movement in a quiet room. '.repeat(25)}\n\nMARA\n${'We should keep going. '.repeat(12)}\n\nELI\nThen leave the light on.\n\n`).join('')
  await open(page, request, text)
  await expect(page.locator('.sidebar-heading .count')).toHaveText('120 scenes')
  const renderedLines = await page.locator('.live-editor .cm-line').count()
  expect(renderedLines).toBeGreaterThan(0)
  expect(renderedLines).toBeLessThan(300)
  await screenplay(page).focus()
  await page.keyboard.press('Control+End')
  const start = Date.now()
  await page.keyboard.insertText('One last line.')
  await expect(screenplay(page)).toContainText('One last line.')
  const elapsed = Date.now() - start
  console.log(`Feature-length (${text.length.toLocaleString()} characters) insertion and visible update: ${elapsed}ms`)
  expect(elapsed).toBeLessThan(2000)
})
