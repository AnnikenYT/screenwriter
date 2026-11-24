import { test, expect } from '@playwright/test'

const text = 'INT. ROOM - DAY\n\nMARA\nHello.\n\nELI\nWait.\n'

test('editor colors are per-person, name-legible and separate from character colors', async ({ page, browser, request }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const response = await request.post('/api/documents', { data: { title: 'Editor colors', text } })
  expect(response.ok()).toBeTruthy()
  const { id } = await response.json()
  const otherContext = await browser.newContext()
  const other = await otherContext.newPage()
  other.on('pageerror', error => errors.push(error.message))
  const editor = target => target.getByRole('textbox', { name: 'Screenplay editor' })
  try {
    await page.goto(`/?document=${id}`)
    await other.goto(`/?document=${id}`)
    await expect(editor(page)).toBeVisible()
    await expect(editor(other)).toBeVisible()
    await expect(page.getByText('2 collaborators')).toBeVisible()

    const sessionUser = async target => (await (await target.request.get('/api/session')).json()).user
    const first = await sessionUser(page), second = await sessionUser(other)
    expect(first.id).not.toBe(second.id)
    expect(first.color).not.toBe(second.color)

    // Names are visible next to presence dots, so identity does not depend on color.
    await expect(page.locator('.presence-names')).toContainText(first.name)
    await expect(page.locator('.presence-names')).toContainText(second.name)
    await expect(other.locator('.presence-names')).toContainText(first.name)
    await expect(other.locator(`.collaborators .avatar[title="${first.name}"]`)).toBeVisible()

    await page.getByRole('button', { name: 'Split', exact: true }).click()
    const mara = page.locator('.ft-character .character-cue-color').filter({ hasText: /^MARA$/ }).first()
    await expect(mara).toBeVisible()
    const characterColor = await mara.evaluate(node => getComputedStyle(node).textDecorationColor)

    await page.getByRole('button', { name: 'Set writer name' }).click()
    const profile = page.getByRole('dialog', { name: 'Your writer name' })
    await profile.getByRole('textbox', { name: 'Display name' }).fill('Ada')
    await profile.getByLabel('Editor color').fill('#1f6feb')
    await profile.getByRole('button', { name: 'Save name', exact: true }).click()
    await expect(page.locator('.collaborators .avatar').first()).toHaveCSS('background-color', 'rgb(31, 111, 235)')
    const adaPeer = other.locator('.collaborators .avatar[title="Ada"]')
    await expect(adaPeer).toHaveCSS('background-color', 'rgb(31, 111, 235)')
    await expect(other.locator('.presence-names')).toContainText('Ada')

    await other.getByRole('button', { name: 'Set writer name' }).click()
    const otherProfile = other.getByRole('dialog', { name: 'Your writer name' })
    await otherProfile.getByRole('textbox', { name: 'Display name' }).fill('Bo')
    await otherProfile.getByLabel('Editor color').fill('#b42318')
    await otherProfile.getByRole('button', { name: 'Save name', exact: true }).click()
    await expect(page.locator('.collaborators .avatar[title="Bo"]')).toHaveCSS('background-color', 'rgb(180, 35, 24)')
    await expect(page.locator('.presence-names')).toContainText('Bo')
    const colours = await page.locator('.collaborators .avatar').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor))
    expect(new Set(colours)).toEqual(new Set(['rgb(31, 111, 235)', 'rgb(180, 35, 24)']))

    // The screenplay character's own color is untouched by an editor color change.
    await expect(mara).toHaveCSS('text-decoration-color', characterColor)
    expect(await mara.evaluate(node => getComputedStyle(node).textDecorationColor)).toBe(characterColor)

    await page.reload()
    await expect(editor(page)).toBeVisible()
    await expect(page.locator('.collaborators .avatar').first()).toHaveCSS('background-color', 'rgb(31, 111, 235)')
    expect((await sessionUser(page)).color).toBe('#1f6feb')
    await page.getByRole('button', { name: 'Set writer name' }).click()
    await expect(page.getByLabel('Editor color')).toHaveValue('#1f6feb')
    expect(errors).toEqual([])
  } finally {
    await otherContext.close()
  }
})
