import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { realpathSync } from 'node:fs'
import { createServer as createViteServer } from 'vite'
import { createWorkspace } from '../server/index.js'
import { startMockOIDC, devClientId, devClientSecret } from './oidc.js'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function developmentSettings(env = process.env) {
  if (env.NODE_ENV === 'production') throw new Error('dev:oauth cannot run in production')
  function port(name, fallback) {
    const value = Number(env[name] || fallback)
    if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error(`Invalid ${name}`)
    return value
  }
  const uiPort = port('DEV_OAUTH_UI_PORT', 5173)
  const apiPort = port('DEV_OAUTH_API_PORT', 3000)
  const issuerPort = port('DEV_OAUTH_ISSUER_PORT', 3999)
  if (new Set([uiPort, apiPort, issuerPort]).size !== 3) throw new Error('Development OAuth ports must be different')
  const dataDir = path.resolve(root, env.DEV_OAUTH_DATA_DIR || 'data/dev-oauth')
  const actualPath = value => { try { return realpathSync(value) } catch { return value } }
  if (actualPath(dataDir) === actualPath(path.resolve(root, env.DATA_DIR || 'data'))) throw new Error('Use a separate DEV_OAUTH_DATA_DIR, not DATA_DIR')
  return {
    uiPort, apiPort, issuerPort, url: `http://127.0.0.1:${uiPort}`,
    dataDir,
  }
}

export async function startOAuthDevelopment(env = process.env) {
  const settings = developmentSettings(env)
  let provider, backend, vite, closed = false
  async function close() {
    if (closed) return
    closed = true
    for (const service of [vite, backend, provider]) {
      try { await service?.close() } catch { /* Continue closing the other local services. */ }
    }
  }
  try {
    provider = await startMockOIDC({ port: settings.issuerPort, redirectUri: `${settings.url}/auth/callback` })
    backend = createWorkspace({
      AUTH_MODE: 'oauth', DATA_DIR: settings.dataDir, PUBLIC_URL: settings.url,
      OIDC_ISSUER: provider.issuer, OIDC_CLIENT_ID: devClientId, OIDC_CLIENT_SECRET: devClientSecret,
      OIDC_ALLOWED_EMAIL_DOMAINS: '', SMTP_URL: '', SMTP_FROM: '',
    })
    await new Promise((resolve, reject) => {
      backend.server.once('error', reject)
      backend.server.listen(settings.apiPort, '127.0.0.1', resolve)
    })
    const api = `http://127.0.0.1:${settings.apiPort}`
    vite = await createViteServer({
      // Bundled config creates temporary imports that trigger Node's --watch.
      root, configFile: path.join(root, 'vite.config.js'), configLoader: 'native', clearScreen: false,
      server: { host: '127.0.0.1', port: settings.uiPort, strictPort: true, proxy: {
        '/api': api, '/auth': api, '/uploads': api,
        '/collaboration': { target: api.replace('http:', 'ws:'), ws: true },
      } },
    })
    await vite.listen()
    return { ...settings, issuer: provider.issuer, close }
  } catch (error) { await close(); throw error }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startOAuthDevelopment().then(development => {
    console.log(`Development OAuth: ${development.url}`)
    console.log(`Test accounts: Alice, Bob, or a custom email. Data: ${development.dataDir}`)
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
      development.close().then(() => process.exit(0))
    })
  }).catch(error => { console.error(error.message); process.exitCode = 1 })
}
