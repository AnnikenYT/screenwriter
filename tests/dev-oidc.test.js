import test from 'node:test'
import assert from 'node:assert/strict'
import { randomBytes, createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { createLocalJWKSet, jwtVerify } from 'jose'
import { startMockOIDC, devClientId, devClientSecret } from '../dev/oidc.js'
import { developmentSettings, startOAuthDevelopment } from '../dev/oauth.js'

const redirectUri = 'http://127.0.0.1:5173/auth/callback'
const random = () => randomBytes(32).toString('base64url')
const challenge = verifier => createHash('sha256').update(verifier).digest('base64url')
async function fixture(t) {
  const provider = await startMockOIDC({ port: 0, redirectUri })
  t.after(() => provider.close())
  async function authorize(persona = 'alice', fields = {}) {
    const verifier = random(), nonce = random(), state = random()
    const params = new URLSearchParams({ client_id: devClientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid profile email', state, nonce, code_challenge: challenge(verifier), code_challenge_method: 'S256' })
    const response = await fetch(`${provider.issuer}/authorize?${params}`, { redirect: 'manual' })
    assert.equal(response.status, 200)
    const html = await response.text()
    const request = html.match(/name="request" value="([^"]+)"/)[1]
    const cookie = response.headers.get('set-cookie').split(';')[0]
    const result = await fetch(`${provider.issuer}/authorize`, { method: 'POST', redirect: 'manual',
      headers: { cookie, Origin: provider.issuer, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ request, persona, ...fields }),
    })
    assert.equal(result.status, 303)
    const target = new URL(result.headers.get('location'))
    assert.equal(target.origin + target.pathname, redirectUri)
    assert.equal(target.searchParams.get('state'), state)
    return { code: target.searchParams.get('code'), verifier, nonce }
  }
  const exchange = (grant, fields = {}) => fetch(`${provider.issuer}/token`, { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: devClientId, client_secret: devClientSecret, grant_type: 'authorization_code', redirect_uri: redirectUri, code: grant.code, code_verifier: grant.verifier, ...fields }),
  })
  return { ...provider, authorize, exchange }
}

test('development provider uses discovery, signed identities, nonce and single-use authorization codes', async t => {
  const provider = await fixture(t)
  const discovery = await fetch(`${provider.issuer}/.well-known/openid-configuration`)
  assert.equal(discovery.headers.get('cache-control'), 'no-store')
  const metadata = await discovery.json()
  assert.deepEqual(metadata.code_challenge_methods_supported, ['S256'])
  const jwks = await (await fetch(metadata.jwks_uri)).json()
  assert.equal(jwks.keys[0].d, undefined)
  const grant = await provider.authorize()
  const response = await provider.exchange(grant)
  assert.equal(response.status, 200)
  const tokens = await response.json()
  const { payload } = await jwtVerify(tokens.id_token, createLocalJWKSet(jwks), { issuer: provider.issuer, audience: devClientId, algorithms: ['RS256'] })
  assert.equal(payload.name, 'Alice')
  assert.equal(payload.email, 'alice@example.test')
  assert.equal(payload.email_verified, true)
  assert.equal(payload.nonce, grant.nonce)
  assert.equal((await provider.exchange(grant)).status, 400)
})

test('development provider rejects wrong client credentials, PKCE and redirect URIs', async t => {
  const provider = await fixture(t)
  const grant = await provider.authorize('bob')
  assert.equal((await provider.exchange(grant, { client_secret: 'wrong' })).status, 401)
  assert.equal((await provider.exchange(grant, { code_verifier: random() })).status, 400)
  assert.equal((await provider.exchange(grant)).status, 400)
  const second = await provider.authorize()
  assert.equal((await provider.exchange(second, { redirect_uri: 'https://example.invalid/auth/callback' })).status, 400)
  const params = new URLSearchParams({ client_id: devClientId, redirect_uri: 'https://example.invalid/auth/callback' })
  const response = await fetch(`${provider.issuer}/authorize?${params}`, { redirect: 'manual' })
  assert.equal(response.status, 400)
  assert.equal(response.headers.get('location'), null)
})

test('custom development identities remain stable and can test unverified email invitations', async t => {
  const provider = await fixture(t)
  const jwks = createLocalJWKSet(await (await fetch(`${provider.issuer}/jwks`)).json())
  const first = await provider.authorize('custom', { email: 'NEW@example.test', name: 'New Writer' })
  const a = (await jwtVerify((await (await provider.exchange(first)).json()).id_token, jwks)).payload
  const second = await provider.authorize('custom', { email: 'new@example.test', name: 'Another Name', verified: 'on' })
  const b = (await jwtVerify((await (await provider.exchange(second)).json()).id_token, jwks)).payload
  assert.equal(a.sub, b.sub)
  assert.equal(a.email, 'new@example.test')
  assert.equal(a.email_verified, false)
  assert.equal(b.email_verified, true)
})

test('development authorization forms require their request cookie and same-origin submission', async t => {
  const provider = await fixture(t)
  const params = new URLSearchParams({ client_id: devClientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid',
    state: random(), nonce: random(), code_challenge: challenge(random()), code_challenge_method: 'S256' })
  const response = await fetch(`${provider.issuer}/authorize?${params}`)
  const request = (await response.text()).match(/name="request" value="([^"]+)"/)[1]
  const body = new URLSearchParams({ request, persona: 'alice' })
  assert.equal((await fetch(`${provider.issuer}/authorize`, { method: 'POST', headers: { Origin: 'https://example.invalid' }, body })).status, 403)
  assert.equal((await fetch(`${provider.issuer}/authorize`, { method: 'POST', headers: { Origin: provider.issuer }, body })).status, 400)
})

test('development settings isolate data and reject invalid ports or production use', async () => {
  const settings = developmentSettings({ DATA_DIR: '/real/data', PUBLIC_URL: 'https://example.invalid', PORT: '9000' })
  assert.ok(settings.dataDir.endsWith('/data/dev-oauth'))
  assert.equal(settings.url, 'http://127.0.0.1:5173')
  assert.equal(settings.apiPort, 3000)
  assert.throws(() => developmentSettings({ NODE_ENV: 'production' }), /production/)
  assert.throws(() => developmentSettings({ DEV_OAUTH_API_PORT: 'not-a-port' }), /Invalid/)
  assert.throws(() => developmentSettings({ DEV_OAUTH_UI_PORT: '3000' }), /different/)
  assert.throws(() => developmentSettings({ DEV_OAUTH_DATA_DIR: '/real/data', DATA_DIR: '/real/data' }), /separate/)
  await assert.rejects(startMockOIDC({ port: 0, redirectUri: 'https://example.invalid/auth/callback' }), /loopback/)
  const before = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  try { await assert.rejects(startMockOIDC({ port: 0, redirectUri }), /development-only/) }
  finally { if (before === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = before }
})

test('development launcher cleans up its provider when the API port is already in use', async () => {
  const directory = await mkdtemp('/tmp/screenwriter/screenwriter-dev-startup-')
  const occupied = createServer(), probe = createServer()
  try {
    await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
    await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve))
    const apiPort = occupied.address().port, issuerPort = probe.address().port
    await new Promise(resolve => probe.close(resolve))
    const uiPort = [apiPort, issuerPort].includes(5173) ? 5174 : 5173
    await assert.rejects(startOAuthDevelopment({ DEV_OAUTH_DATA_DIR: directory,
      DEV_OAUTH_UI_PORT: String(uiPort), DEV_OAUTH_API_PORT: String(apiPort), DEV_OAUTH_ISSUER_PORT: String(issuerPort),
    }), /EADDRINUSE/)
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(issuerPort, '127.0.0.1', resolve) })
  } finally {
    if (probe.listening) await new Promise(resolve => probe.close(resolve))
    if (occupied.listening) await new Promise(resolve => occupied.close(resolve))
    await rm(directory, { recursive: true, force: true })
  }
})
