import { test, expect } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import { startOAuthDevelopment } from '../dev/oauth.js'

let development, directory
test.beforeAll(async () => {
  directory = await mkdtemp('/tmp/screenwriter/screenwriter-dev-oauth-')
  development = await startOAuthDevelopment({
    ...process.env, DEV_OAUTH_UI_PORT: '5321', DEV_OAUTH_API_PORT: '3321', DEV_OAUTH_ISSUER_PORT: '4321', DEV_OAUTH_DATA_DIR: directory,
  })
})
test.afterAll(async () => { await development?.close(); if (directory) await rm(directory, { recursive: true, force: true }) })
async function signIn(page, name) {
  await page.goto(development.url)
  await page.getByRole('link', { name: 'Sign in', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Development sign-in' })).toBeVisible()
  await page.getByRole('button', { name, exact: true }).click()
  await expect(page.getByRole('textbox', { name: 'Screenplay editor' })).toBeVisible()
}

test('development login uses real browser redirects with separate Alice and Bob workspaces', async ({ page, browser }) => {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await signIn(page, 'Alice')
  const alice = await (await page.request.get(`${development.url}/api/session`)).json()
  expect(alice.authMode).toBe('oauth')
  expect(alice.user).toMatchObject({ name: 'Alice', email: 'alice@example.test', emailVerified: true, account: true })
  const created = await (await page.request.post(`${development.url}/api/documents`, { data: { title: 'Alice only', text: 'INT. ROOM - DAY\n\nPrivate writing.\n' } })).json()
  const other = await browser.newContext()
  try {
    const tab = await other.newPage()
    await signIn(tab, 'Bob')
    const bob = await (await tab.request.get(`${development.url}/api/session`)).json()
    expect(bob.user).toMatchObject({ name: 'Bob', email: 'bob@example.test' })
    expect(bob.user.id).not.toBe(alice.user.id)
    expect((await tab.request.get(`${development.url}/api/documents/${created.id}`)).status()).toBe(404)
    expect((await (await page.request.get(`${development.url}/api/session`)).json()).user.id).toBe(alice.user.id)
    await tab.goto(`${development.url}/auth/logout`)
    await expect(tab.getByRole('link', { name: 'Sign in', exact: true })).toBeVisible()
  } finally { await other.close() }
  expect(errors).toEqual([])
})

test('custom mock login claims an earlier invitation only after verified-email login', async ({ page, browser }) => {
  await signIn(page, 'Alice')
  const created = await (await page.request.post(`${development.url}/api/documents`, { data: { title: 'Invited before login', text: 'INT. ROOM - DAY\n\nA shared page.\n' } })).json()
  const invite = await page.request.post(`${development.url}/api/documents/${created.id}/shares`, {
    data: { kind: 'user', email: 'charlie@example.test', role: 'reviewer', canInvite: false, canExport: false },
  })
  expect(invite.ok()).toBe(true)
  const other = await browser.newContext()
  try {
    const tab = await other.newPage()
    async function customLogin(verified) {
      await tab.goto(development.url)
      await tab.getByRole('link', { name: 'Sign in', exact: true }).click()
      await tab.getByLabel('Email', { exact: true }).fill('charlie@example.test')
      await tab.getByLabel('Name (optional)', { exact: true }).fill('Charlie')
      await tab.getByLabel('Verified email', { exact: true }).setChecked(verified)
      await tab.getByRole('button', { name: 'Sign in', exact: true }).click()
      await expect(tab.getByRole('textbox', { name: 'Screenplay editor' })).toBeVisible()
    }
    await customLogin(false)
    expect((await tab.request.get(`${development.url}/api/documents/${created.id}`)).status()).toBe(404)
    await tab.goto(`${development.url}/auth/logout`)
    await customLogin(true)
    const access = await (await tab.request.get(`${development.url}/api/documents/${created.id}`)).json()
    expect(access.access.role).toBe('reviewer')
    expect(access.access.canExport).toBe(false)
    await tab.goto(`${development.url}/?document=${created.id}`)
    await expect(tab.getByRole('textbox', { name: 'Document title' })).toHaveValue('Invited before login')
  } finally { await other.close() }
})
