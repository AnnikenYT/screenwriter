import express from 'express'
import { createServer } from 'node:http'
import { randomBytes, createHash } from 'node:crypto'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { escapeHtml } from '../shared/fountain.js'

export const devClientId = 'screenwriter-development'
export const devClientSecret = 'development-only'
const token = () => randomBytes(32).toString('base64url')
const hash = value => createHash('sha256').update(value).digest('base64url')
const fail = (status, message) => Object.assign(new Error(message), { status })
const personas = {
  alice: { name: 'Alice', email: 'alice@example.test', verified: true },
  bob: { name: 'Bob', email: 'bob@example.test', verified: true },
}

export async function startMockOIDC({ port = 3999, redirectUri }) {
  if (process.env.NODE_ENV === 'production') throw new Error('The mock provider is development-only')
  const callback = new URL(redirectUri)
  if (callback.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(callback.hostname) ||
    callback.username || callback.password || callback.pathname !== '/auth/callback' || callback.search || callback.hash) {
    throw new Error('The mock provider requires a loopback HTTP callback')
  }
  const keys = await generateKeyPair('RS256')
  const publicKey = await exportJWK(keys.publicKey)
  const kid = hash(JSON.stringify(publicKey))
  const jwk = { ...publicKey, kid, use: 'sig', alg: 'RS256' }
  const requests = new Map(), codes = new Map()
  let issuer
  const app = express()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store')
    res.setHeader('Referrer-Policy', 'same-origin')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Content-Security-Policy', `default-src 'none'; style-src 'unsafe-inline'; form-action 'self' ${callback.origin}; base-uri 'none'; frame-ancestors 'none'`)
    if (issuer && req.headers.host !== new URL(issuer).host) return next(fail(400, 'Invalid host'))
    for (const map of [requests, codes]) for (const [id, value] of map) if (value.expires <= Date.now()) map.delete(id)
    next()
  })
  app.use(express.urlencoded({ extended: false, limit: '8kb' }))
  app.use((req, res, next) => { req.body ||= {}; next() })
  app.get('/.well-known/openid-configuration', (req, res) => res.json({
    issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
    response_types_supported: ['code'], grant_types_supported: ['authorization_code'], subject_types_supported: ['public'],
    scopes_supported: ['openid', 'profile', 'email'], id_token_signing_alg_values_supported: ['RS256'],
    token_endpoint_auth_methods_supported: ['client_secret_post'], code_challenge_methods_supported: ['S256'],
  }))
  app.get('/jwks', (req, res) => res.json({ keys: [jwk] }))
  const cookie = req => (req.headers.cookie || '').split(';').map(value => value.trim())
    .find(value => value.startsWith('screenwriter_dev_oidc='))?.slice('screenwriter_dev_oidc='.length)
  app.get('/authorize', (req, res) => {
    const { client_id, redirect_uri, response_type, scope, state, nonce, code_challenge, code_challenge_method } = req.query
    if (client_id !== devClientId || redirect_uri !== redirectUri || response_type !== 'code' ||
      typeof scope !== 'string' || !scope.split(' ').includes('openid') ||
      typeof state !== 'string' || state.length < 16 || state.length > 256 ||
      typeof nonce !== 'string' || nonce.length < 16 || nonce.length > 256 ||
      code_challenge_method !== 'S256' || typeof code_challenge !== 'string' || !/^[\w-]{43}$/.test(code_challenge)) {
      throw fail(400, 'Invalid authorization request')
    }
    if (requests.size >= 1000 || codes.size >= 1000) throw fail(429, 'Too many login attempts')
    let csrf = cookie(req)
    if (!csrf || !/^[\w-]{43}$/.test(csrf)) csrf = token()
    res.cookie('screenwriter_dev_oidc', csrf, { httpOnly: true, sameSite: 'strict', path: '/authorize', maxAge: 600000 })
    const id = token()
    requests.set(id, { state, nonce, challenge: code_challenge, csrf: hash(csrf), expires: Date.now() + 300000 })
    const hidden = `<input type="hidden" name="request" value="${escapeHtml(id)}">`
    res.type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Development sign-in</title>
<style>body{background:#f6f5f2;color:#343b30;font:1rem/1.5 system-ui,sans-serif;margin:0;padding:2rem 1rem}main{max-width:25rem;margin:2rem auto}h1{font-size:1.4rem}p{color:#626e59}form{margin:1rem 0}label{display:block;margin:.8rem 0}input:not([type=checkbox]){display:block;width:100%;box-sizing:border-box;padding:.65rem;background:#fffefa;color:#343b30;border:1px solid #adb69f;border-radius:.3rem;font:inherit}button{min-height:2.75rem;padding:.5rem 1rem;border:1px solid #788b65;border-radius:.3rem;background:#e6eddd;color:#343b30;font:inherit;cursor:pointer}.presets{display:flex;gap:.75rem}.presets form{flex:1}.presets button{width:100%}</style></head><body><main>
<h1>Development sign-in</h1>
<div class="presets"><form method="post" action="/authorize">${hidden}<button name="persona" value="alice">Alice</button></form><form method="post" action="/authorize">${hidden}<button name="persona" value="bob">Bob</button></form></div>
<form method="post" action="/authorize">${hidden}<input type="hidden" name="persona" value="custom"><label>Email<input name="email" type="email" required maxlength="254" autocomplete="off"></label><label>Name (optional)<input name="name" maxlength="120" autocomplete="off"></label><label><input name="verified" type="checkbox" checked> Verified email</label><button>Sign in</button></form>
</main></body></html>`)
  })
  app.post('/authorize', (req, res) => {
    if (req.headers.origin !== issuer) throw fail(403, 'Invalid origin')
    const pending = typeof req.body.request === 'string' && requests.get(req.body.request)
    const csrf = cookie(req)
    if (!pending || pending.expires <= Date.now() || !csrf || hash(csrf) !== pending.csrf) throw fail(400, 'Login expired. Start again.')
    if (codes.size >= 1000) throw fail(429, 'Too many login attempts')
    let identity = Object.hasOwn(personas, req.body.persona) ? personas[req.body.persona] : null
    if (req.body.persona === 'custom') {
      const email = typeof req.body.email === 'string' ? req.body.email.trim().toLowerCase() : ''
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a valid email')
      const name = typeof req.body.name === 'string' ? req.body.name.trim().slice(0, 120) : ''
      identity = { email, name: name || email.split('@')[0], verified: req.body.verified === 'on' }
    }
    if (!identity) throw fail(400, 'Choose a test account')
    requests.delete(req.body.request)
    const code = token()
    codes.set(hash(code), { ...pending, identity, expires: Date.now() + 60000 })
    const target = new URL(redirectUri)
    target.searchParams.set('code', code)
    target.searchParams.set('state', pending.state)
    res.redirect(303, target.href)
  })
  app.post('/token', async (req, res) => {
    if (req.body.client_id !== devClientId || typeof req.body.client_secret !== 'string' || hash(req.body.client_secret) !== hash(devClientSecret)) {
      return res.status(401).json({ error: 'invalid_client' })
    }
    const { code, code_verifier, redirect_uri, grant_type } = req.body
    if (typeof code !== 'string') return res.status(400).json({ error: 'invalid_grant' })
    const pending = codes.get(hash(code))
    codes.delete(hash(code))
    if (!pending || pending.expires <= Date.now() || grant_type !== 'authorization_code' || redirect_uri !== redirectUri ||
      typeof code_verifier !== 'string' || !/^[A-Za-z0-9._~-]{43,128}$/.test(code_verifier) || hash(code_verifier) !== pending.challenge) {
      return res.status(400).json({ error: 'invalid_grant' })
    }
    const identity = pending.identity
    const id_token = await new SignJWT({ nonce: pending.nonce, name: identity.name, email: identity.email, email_verified: identity.verified })
      .setProtectedHeader({ alg: 'RS256', kid }).setIssuer(issuer).setSubject(`dev:${hash(identity.email)}`)
      .setAudience(devClientId).setIssuedAt().setExpirationTime('5m').sign(keys.privateKey)
    res.json({ id_token, token_type: 'Bearer', access_token: token(), expires_in: 300 })
  })
  app.use((req, res) => res.status(404).json({ error: 'not_found' }))
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    res.status(error.status || 500).type('text/plain').send(error.status ? error.message : 'Development provider error')
  })
  const server = createServer(app)
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  } catch (error) { server.close(); throw error }
  issuer = `http://127.0.0.1:${server.address().port}`
  return {
    issuer, server,
    async close() {
      requests.clear(); codes.clear()
      server.closeAllConnections()
      if (server.listening) await new Promise(resolve => server.close(resolve))
    },
  }
}
