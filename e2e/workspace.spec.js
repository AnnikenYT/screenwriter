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
  await page.getByRole('button', { name: 'Post comment', exact: true }).click()
  await expect(other.getByText('Keep this quiet and restrained.')).toBeVisible()
  await other.screenshot({ path: '/tmp/opencode/screenwriter-line-comments.png', animations: 'disabled' })
  await other.getByLabel('Reply to comment').fill('Agreed.')
  await other.getByRole('button', { name: 'Send reply' }).click()
  await expect(page.getByText('Agreed.', { exact: true })).toBeVisible()
  await other.getByRole('button', { name: 'Resolve comment', exact: true }).click()
  await expect(page.getByText('Keep this quiet and restrained.')).not.toBeVisible()

  await screenplay(page).focus()
  await page.keyboard.press('Control+End')
  await page.getByRole('button', { name: 'Editing', exact: true }).click()
  await screenplay(page).focus()
  await page.keyboard.type(' A distant bell.', { delay: 10 })
  await expect(other.locator('.inline-suggestion-replacement')).toContainText('A distant bell.')
  await other.locator('.inline-suggestion-replacement').hover()
  await other.getByRole('button', { name: 'Accept suggestion', exact: true }).click()
  await expect(other.locator('.inline-suggestion-replacement')).toHaveCount(0)
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
  await expect(page.locator('.inline-suggestion-replacement')).toHaveText(' A proposed ending.')
  await page.locator('.inline-suggestion-replacement').hover()
  await page.getByRole('button', { name: 'Accept suggestion', exact: true }).click()
  await expect(screenplay(page)).toContainText('A proposed ending.')
  await page.getByRole('button', { name: 'Suggesting', exact: true }).click()
  if (await page.getByRole('button', { name: 'Versions', exact: true }).getAttribute('aria-pressed') !== 'true') await page.getByRole('button', { name: 'Versions', exact: true }).click()
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
  await page.getByRole('button', { name: 'Open tools', exact: true }).click()
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

test('visible live selections, named guests, inline replacement and stale-safe rejection', async ({ page, browser, request }) => {
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await open(page, request, 'INT. ROOM - DAY\n\nThe cat waits.\n')
  await page.getByRole('button', { name: 'Set writer name' }).click()
  await page.getByLabel('Display name').fill('Alice')
  await page.getByRole('button', { name: 'Save name', exact: true }).click()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Set writer name' })).toHaveAttribute('title', 'Alice · Set your name')
  await screenplay(page).focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.press('ArrowUp')
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('ArrowRight')
  await page.keyboard.press('Control+Shift+ArrowRight')
  await expect(page.locator('.cm-selectionBackground').first()).toBeVisible()
  expect(await page.locator('.cm-selectionLayer').evaluate(el => Number(getComputedStyle(el).zIndex))).toBeGreaterThan(0)
  await page.screenshot({ path: '/tmp/opencode/screenwriter-selection.png' })
  await page.getByRole('button', { name: 'Editing', exact: true }).click()
  await screenplay(page).focus()
  await page.keyboard.type('dog', { delay: 25 })
  await expect(page.locator('.inline-suggestion-original')).toContainText('cat')
  await expect(page.locator('.inline-suggestion-replacement')).toContainText('dog')
  const other = await browser.newPage()
  await other.goto(page.url())
  await expect(other.locator('.inline-suggestion-original')).toContainText('cat')
  await other.locator('.inline-suggestion-replacement').hover()
  await expect(other.getByRole('dialog', { name: 'Suggestion by Alice' })).toBeVisible()
  await other.screenshot({ path: '/tmp/opencode/screenwriter-inline-suggestion.png', animations: 'disabled' })
  await other.getByRole('button', { name: 'Reject suggestion' }).click()
  await expect(page.locator('.inline-suggestion-replacement')).toHaveCount(0)
  await expect(screenplay(page)).toContainText('The cat waits.')
  await other.close()
  expect(errors).toEqual([])
})

test('Tab completes names, formatting wraps selections, images hover, and dark mode persists', async ({ page, request }) => {
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await open(page, request)
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  await screenplay(page).focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n\nMA')
  await page.keyboard.press('Tab')
  await expect(screenplay(page)).toContainText('MARA')
  await page.keyboard.insertText('\nHello.\n\nINT. LIGH')
  await page.keyboard.press('Tab')
  await expect(screenplay(page)).toContainText('INT. LIGHTHOUSE')
  await page.keyboard.insertText('\n\nEmphasis')
  await page.keyboard.press('Control+Shift+ArrowLeft')
  await page.keyboard.type('*')
  await page.keyboard.press('Control+b')
  await expect(screenplay(page)).toContainText('***Emphasis***')
  await page.keyboard.press('Control+u')
  await expect(screenplay(page)).toContainText('***_Emphasis_***')
  await page.keyboard.type('[')
  await expect(screenplay(page)).toContainText('***_[Emphasis]_***')
  await page.getByRole('button', { name: 'Link image to selection', exact: true }).click()
  await page.locator('.image-link-modal input[type="file"]').setInputFiles({
    name: 'reference.png', mimeType: 'image/png',
    buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=', 'base64'),
  })
  await page.getByLabel('Caption (optional)').fill('The room in winter')
  await page.getByRole('button', { name: 'Link image', exact: true }).click()
  await page.locator('.image-linked-passage').first().hover()
  await expect(page.getByRole('img', { name: 'The room in winter' })).toBeVisible()
  await page.getByRole('button', { name: 'Switch to dark mode' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await page.screenshot({ path: '/tmp/opencode/screenwriter-dark.png', animations: 'disabled' })
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  expect(errors).toEqual([])
})

test('dual dialogue renders side by side in live mode and reveals source on click', async ({ page, request }) => {
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await open(page, request, 'INT. ROOM - DAY\n\nMARA\nWe should go.\n\nELI ^\nNot yet.\n\n\nA long silence.\n')
  await expect(page.locator('.live-dual-dialogue')).toBeVisible()
  const left = await page.locator('.live-dual-dialogue .speech').nth(0).boundingBox()
  const right = await page.locator('.live-dual-dialogue .speech').nth(1).boundingBox()
  expect(Math.abs(left.y - right.y)).toBeLessThan(2)
  expect(right.x).toBeGreaterThan(left.x + left.width)
  await page.locator('.live-dual-dialogue').getByText('Not yet.').click()
  await expect(page.locator('.live-dual-dialogue')).toHaveCount(0)
  await expect(screenplay(page)).toContainText('ELI ^')
  await page.keyboard.press('Control+End')
  await expect(page.locator('.live-dual-dialogue')).toBeVisible()
  await page.screenshot({ path: '/tmp/opencode/screenwriter-dual.png' })
  expect(errors).toEqual([])
})

test('split panes scroll together in both directions and can be unlinked', async ({ page, request }) => {
  const text = Array.from({ length: 60 }, (_, i) => `INT. ROOM ${i + 1} - DAY\n\n${'A quiet movement. '.repeat(20)}\n\nMARA\n${'We should go. '.repeat(12)}\n\n`).join('')
  await open(page, request, text)
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  const source = page.locator('.raw-editor .cm-scroller')
  const preview = page.getByLabel('Rendered screenplay')
  await source.evaluate(el => el.scrollTop = 800)
  await expect.poll(() => preview.evaluate(el => el.scrollTop)).toBeGreaterThan(200)
  const oldSource = await source.evaluate(el => el.scrollTop)
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  await preview.evaluate(el => el.scrollTop += 900)
  await expect.poll(() => source.evaluate(el => el.scrollTop)).toBeGreaterThan(oldSource + 200)
  await page.getByRole('button', { name: 'Synchronized scrolling' }).click()
  const oldPreview = await preview.evaluate(el => el.scrollTop)
  await source.evaluate(el => el.scrollTop = 0)
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))
  expect(await preview.evaluate(el => el.scrollTop)).toBeCloseTo(oldPreview, 0)
})

test('unused character and location sheets disappear for all collaborators', async ({ page, browser, request }) => {
  await open(page, request)
  const other = await browser.newPage()
  await other.goto(page.url())
  await other.getByRole('button', { name: 'Characters', exact: true }).click()
  await expect(other.getByRole('button', { name: 'MARA Character sheet' })).toBeVisible()
  await screenplay(page).fill('EXT. SHORE - DAWN\n\nELI\nThe tide returns.')
  await expect(other.getByRole('button', { name: 'MARA Character sheet' })).toHaveCount(0)
  await expect(other.getByRole('button', { name: 'ELI Character sheet' })).toBeVisible()
  await other.getByRole('button', { name: 'Locations', exact: true }).click()
  await expect(other.getByRole('button', { name: 'LIGHTHOUSE Location sheet' })).toHaveCount(0)
  await expect(other.getByRole('button', { name: 'SHORE Location sheet' })).toBeVisible()
  await other.close()
})
