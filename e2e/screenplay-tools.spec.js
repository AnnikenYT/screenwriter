import { test, expect } from '@playwright/test'

const source = "INT. ROOM - NOON\n\nMARA (V.O.) (CONT'D)\nHello.\n\nSHOT: A close-up.\nVFX: Sparks.\nSFX: Thunder.\n\nELI (O.S.)\nWait.\n"

for (const [first, second, markup] of [
  ['Bold', 'Underline', '**_A door opens._**'],
  ['Underline', 'Bold', '_**A door opens.**_'],
]) {
  test(`${first} then ${second} renders both styles in live and split views`, async ({ page, request }) => {
    const text = 'A door opens.'
    const { id } = await (await request.post('/api/documents', { data: { title: 'Combined emphasis', text: `${text}\n\nA bell rings.` } })).json()
    await page.goto(`/?document=${id}`)
    const editor = page.getByRole('textbox', { name: 'Screenplay editor' })
    await expect(editor).toBeVisible()
    await editor.focus()
    await page.keyboard.press('Control+Home')
    await page.keyboard.press('Shift+End')
    await page.getByRole('button', { name: first, exact: true }).click()
    await page.getByRole('button', { name: second, exact: true }).click()

    const line = editor.locator('.ft-action').first()
    const combined = line.locator('.emphasis-bold.emphasis-underline')
    await expect(line).toHaveText(markup)
    await expect(combined).toHaveText(text)
    await page.keyboard.press('Control+End')
    await expect(line).toHaveClass(/ft-rendered/)
    await expect(line).toHaveText(text)
    await expect(combined).toHaveCSS('font-weight', '700')
    await expect(combined).toHaveCSS('text-decoration-line', 'underline')

    await page.getByRole('button', { name: 'Split', exact: true }).click()
    await expect(page.locator('.paper .action').first()).toHaveText(text)
    const underlined = page.locator('.paper .action u')
    await expect(underlined).toHaveText(text)
    await expect(underlined).toHaveCSS('text-decoration-line', 'underline')
    await expect(page.locator('.paper .action strong')).toHaveCSS('font-weight', '700')
  })
}

test('uppercase character and location mentions are bold outside dialogue in both views', async ({ page, request }) => {
  const text = 'INT. GREAT HALL - DAY\n\nMARA walks through GREAT HALL. Mara hears an ALARM near MARATHON.\n\nMARA\nHello.\n'
  const { id } = await (await request.post('/api/documents', { data: { title: 'Name mentions', text } })).json()
  await page.goto(`/?document=${id}`)
  const editor = page.getByRole('textbox', { name: 'Screenplay editor' })
  await expect(editor).toBeVisible()
  await expect(page.locator('.ft-action .name-mention')).toHaveText(['MARA', 'GREAT HALL'])
  for (const node of await page.locator('.ft-action .name-mention').all()) await expect(node).toHaveCSS('font-weight', '700')
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(page.locator('.paper .action strong')).toHaveText(['MARA', 'GREAT HALL'])
  await expect(page.locator('.paper .action')).toContainText('Mara hears an ALARM near MARATHON.')
  expect(await (await request.get(`/api/documents/${id}/versions`)).json()).toEqual([])
  // Switching formatting modes must never insert markup into canonical Fountain.
  const downloadEvent = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByRole('button', { name: 'Fountain (.fountain)', exact: true }).click()
  const download = await downloadEvent
  const { readFile } = await import('node:fs/promises')
  expect(await readFile(await download.path(), 'utf8')).toBe(text)
})
async function open(page, request) {
  const { id } = await (await request.post('/api/documents', { data: { title: 'Screenplay tools', text: source } })).json()
  await page.goto(`/?document=${id}`)
  await expect(page.getByRole('textbox', { name: 'Screenplay editor' })).toBeVisible()
}

for (const mobile of [false, true]) {
  test(`unnamed writers can save a name from the top reminder${mobile ? ' on phone' : ''}`, async ({ page, request }) => {
    if (mobile) await page.setViewportSize({ width: 390, height: 844 })
    await open(page, request)
    const nag = page.getByRole('form', { name: 'Set your writer name' })
    await expect(nag).toBeVisible()
    expect((await nag.boundingBox()).y).toBeLessThan(100)
    await nag.getByRole('textbox', { name: 'Your writer name' }).fill('Writer abcd')
    await nag.getByRole('button', { name: 'Save name', exact: true }).click()
    await expect(nag).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Set writer name' })).toHaveAttribute('title', 'Writer abcd · Set your name')
    await page.reload()
    await expect(page.getByRole('textbox', { name: 'Screenplay editor' })).toBeVisible()
    await expect(nag).toHaveCount(0)
  })
}

test('character cues and production abbreviations render bold in live and split views', async ({ page, request }) => {
  await open(page, request)
  const character = page.locator('.ft-character.ft-rendered').first()
  await expect(character).toHaveCSS('font-weight', '700')
  for (const text of ['SHOT:', 'VFX:', 'SFX:', "(CONT'D)", '(V.O.)', '(O.S.)']) {
    await expect(page.locator('.live-editor .emphasis-bold').filter({ hasText: text }).first()).toHaveCSS('font-weight', '700')
  }
  await page.getByRole('button', { name: 'Split', exact: true }).click()
  await expect(page.locator('.paper .fountain.character').first()).toHaveCSS('font-weight', '700')
  for (const text of ['SHOT:', 'VFX:', 'SFX:', "(CONT'D)", '(V.O.)', '(O.S.)']) {
    await expect(page.locator('.paper strong').filter({ hasText: text }).first()).toHaveCSS('font-weight', '700')
  }
  await page.getByRole('button', { name: 'Characters', exact: true }).click()
  await expect(page.locator('.sheet-list-item strong')).toHaveText(['ELI', 'MARA'])
  await page.getByRole('button', { name: 'Locations', exact: true }).click()
  await expect(page.locator('.sheet-list-item strong')).toHaveText(['ROOM'])
})

test('heading, time, production and dialogue extension completions insert their exact syntax', async ({ page, request }) => {
  await open(page, request)
  const editor = page.getByRole('textbox', { name: 'Screenplay editor' })
  const popup = page.getByRole('listbox')
  await editor.focus()
  await page.keyboard.press('Control+End')
  await page.keyboard.insertText('\n\n')
  await page.keyboard.type('I')
  await expect(popup).toContainText('INT./EXT.')
  await popup.getByRole('option').filter({ hasText: 'INT./EXT.' }).click()
  await page.keyboard.type('CAR - N')
  await expect(popup).toContainText('NOON')
  await popup.getByRole('option').filter({ hasText: 'NOON' }).click()
  await expect(editor).toContainText('INT./EXT. CAR - NOON')
  await page.keyboard.insertText('\n\n')
  await page.keyboard.type('VF')
  await popup.getByRole('option').filter({ hasText: 'VFX:' }).click()
  await page.keyboard.type('A passing shimmer.')
  await page.keyboard.insertText('\n\nMARA ')
  await expect(popup).toContainText("(CONT'D)")
  await popup.getByRole('option').filter({ hasText: '(V.O.)' }).click()
  await expect(editor).toContainText('MARA (V.O.)')
  await expect(editor).toContainText('VFX: A passing shimmer.')
})
