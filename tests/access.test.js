import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { randomBytes } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import * as Y from 'yjs'
import WebSocket from 'ws'
import { WebsocketProvider } from 'y-websocket'
import * as encoding from 'lib0/encoding'
import * as sync from 'y-protocols/sync'
import { createWorkspace } from '../server/index.js'
import { createAccess, digest } from '../server/access.js'
import { relativeAnchor } from '../shared/anchors.js'
import { flushCollaboration } from '../src/lib/sync-barrier.js'

async function fixture(t, options = {}) {
  const directory = await mkdtemp('/tmp/screenwriter/screenwriter-access-')
  let server, db, base, identities
  const peers = []
  async function start(mode = 'oauth') {
    server = createWorkspace({ DATA_DIR: directory, AUTH_MODE: mode, ...options })
    await new Promise(resolve => server.server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.server.address().port}`
    db = new DatabaseSync(`${directory}/workspace.sqlite`)
    identities = createAccess(db, { mode: 'oauth', publicURL: new URL(base) })
  }
  await start()
  function client(user, initialCookie = '') {
    let cookie = initialCookie
    return {
      user,
      get cookie() { return cookie },
      async call(path, method = 'GET', body) {
        const response = await fetch(base + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
        for (const item of response.headers.getSetCookie()) {
          const pair = item.split(';')[0], key = pair.split('=')[0]
          cookie = cookie.split('; ').filter(value => !value.startsWith(key + '=')).concat(pair).filter(Boolean).join('; ')
        }
        return response
      },
      async json(path, method = 'GET', body) {
        const response = await this.call(path, method, body)
        assert.ok(response.ok, `${method} ${path}: ${response.status} ${await response.clone().text()}`)
        return response.json()
      },
    }
  }
  function register(email, verified = true, subject = email) {
    const user = identities.account({ iss: 'https://issuer.test/', sub: subject, email, email_verified: verified, name: email.split('@')[0] })
    const token = randomBytes(32).toString('base64url')
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), JSON.stringify(user), Date.now() + 86400000)
    return client(user, `screenplay_session=${token}`)
  }
  async function connect(actor, id, readonly = false) {
    const doc = new Y.Doc()
    const Socket = class extends WebSocket { constructor(url, protocols) { super(url, protocols, { headers: { cookie: actor.cookie } }) } }
    const provider = new WebsocketProvider(base.replace('http:', 'ws:') + '/collaboration', id, doc, { WebSocketPolyfill: Socket, disableBc: true, connect: false })
    if (readonly) doc.off('update', provider._updateHandler)
    const peer = { doc, provider, close() { provider.destroy(); doc.destroy() } }
    peers.push(peer)
    provider.connect()
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Socket sync timeout')), 5000)
      provider.on('sync', value => { if (value) { clearTimeout(timeout); resolve() } })
    })
    return peer
  }
  t.after(async () => { peers.forEach(peer => peer.close()); db.close(); await server.close(); await rm(directory, { recursive: true, force: true }) })
  return {
    directory, db, client, register, connect, get base() { return base },
    async restart(mode = 'oauth') { peers.splice(0).forEach(peer => peer.close()); db.close(); await server.close(); await start(mode) },
  }
}
const document = { title: 'Private', text: 'INT. ROOM - DAY\n\nMARA\nHello.\n' }
const grant = (email, role = 'viewer', flags = {}) => ({ kind: 'user', email, role, canInvite: false, canExport: false, ...flags })

test('saved link URLs survive restart and are visible only to owners and their creators', async t => {
  const f = await fixture(t), owner = f.register('saved-owner@example.com'), inviter = f.register('saved-inviter@example.com')
  const { id } = await owner.json('/api/documents', 'POST', document)
  const path = `/api/documents/${id}/shares`
  const flags = { kind: 'link', role: 'viewer', canInvite: false, canExport: false }
  const link = await owner.json(path, 'POST', flags)
  await owner.json(path, 'POST', grant(inviter.user.email, 'viewer', { canInvite: true }))
  const delegated = await inviter.json(path, 'POST', { ...flags, password: 'secret-password' })
  assert.equal((await owner.json(path)).find(item => item.id === link.id).url, link.url)
  assert.deepEqual((await inviter.json(path)).map(item => item.url), [delegated.url])
  await f.restart()
  assert.equal((await owner.json(path)).find(item => item.id === link.id).url, link.url)
  assert.equal((await inviter.json(path))[0].url, delegated.url)
  const visitor = f.client()
  assert.equal((await visitor.call('/api/shares/open', 'POST', { token: new URL(link.url).hash.slice(1) })).status, 200)
  assert.equal((await visitor.call(path)).status, 403)
  await owner.json(`${path}/${link.id}`, 'DELETE')
  assert.equal((await owner.json(path)).find(item => item.id === link.id).url, null)
  // Upgrade a hash-only database without breaking its existing links.
  const legacy = new DatabaseSync(`${f.directory}/workspace.sqlite`)
  try { legacy.exec('ALTER TABLE document_grants DROP COLUMN link_token') } finally { legacy.close() }
  await f.restart()
  assert.equal((await inviter.json(path))[0].url, null)
  const oldVisitor = f.client()
  assert.equal((await oldVisitor.call('/api/shares/open', 'POST', { token: new URL(delegated.url).hash.slice(1), password: 'secret-password' })).status, 200)
})

test('share updates enforce delegation limits, never revive removed shares, and invalidate descendants', async t => {
  const f = await fixture(t), owner = f.register('edit-owner@example.com'), inviter = f.register('edit-inviter@example.com')
  const reader = f.register('edit-reader@example.com'), outsider = f.register('edit-other@example.com')
  const { id } = await owner.json('/api/documents', 'POST', document)
  const path = `/api/documents/${id}`
  const parent = await owner.json(`${path}/shares`, 'POST', grant(inviter.user.email, 'reviewer', { canInvite: true }))
  const child = await inviter.json(`${path}/shares`, 'POST', grant(reader.user.email))
  const update = (actor, share, role, flags = {}) => actor.call(`${path}/shares/${share.id}`, 'PATCH', { role, canInvite: false, canExport: false, ...flags })
  assert.equal((await update(inviter, child, 'editor')).status, 403)
  assert.equal((await update(inviter, child, 'viewer', { canExport: true })).status, 403)
  assert.equal((await update(outsider, child, 'viewer')).status, 404)
  assert.equal((await update(inviter, parent, 'viewer')).status, 403)
  assert.equal((await update(inviter, child, 'reviewer', { canInvite: true })).status, 200)
  assert.equal((await reader.json(path)).access.role, 'reviewer')
  const peer = await f.connect(reader, id, true)
  const closed = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Updated role did not close the existing socket')), 5000)
    peer.provider.ws.once('close', code => { clearTimeout(timeout); resolve(code) })
  })
  assert.equal((await update(inviter, child, 'viewer')).status, 200)
  assert.equal(await closed, 4003)
  peer.close()
  assert.equal((await update(inviter, child, 'reviewer', { canInvite: true })).status, 200)
  const grandchild = await reader.json(`${path}/shares`, 'POST', grant('edit-descendant@example.com'))
  assert.equal((await update(owner, parent, 'viewer', { canInvite: true })).status, 200)
  assert.equal((await reader.call(path)).status, 404)
  const shares = await owner.json(`${path}/shares`)
  assert.equal(shares.find(item => item.id === grandchild.id).active, false)
  assert.equal((await update(owner, child, 'viewer')).status, 409)
  await owner.json(`${path}/shares/${parent.id}`, 'DELETE')
  assert.equal((await update(owner, parent, 'viewer')).status, 409)
  assert.equal((await outsider.call(`${path}/sharing-info`)).status, 404)
  assert.equal((await owner.json(`${path}/sharing-info`)).owner.email, owner.user.email)
})

test('OAuth workspaces isolate documents, images and history; anonymous mode never exposes private documents', async t => {
  const f = await fixture(t), owner = f.register('owner@example.com'), other = f.register('other@example.com')
  const { id } = await owner.json('/api/documents', 'POST', document)
  assert.equal((await owner.json('/api/documents')).length, 1)
  assert.deepEqual(await other.json('/api/documents'), [])
  for (const path of ['', '/versions', '/export.pdf', '/export.fountain', '/shares']) assert.equal((await other.call(`/api/documents/${id}${path}`)).status, 404)
  assert.equal((await other.call(`/api/documents/${id}`, 'DELETE')).status, 404)
  const body = new FormData()
  body.append('image', new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')], { type: 'image/png' }), 'image.png')
  const image = await (await fetch(f.base + `/api/documents/${id}/images`, { method: 'POST', headers: { cookie: owner.cookie }, body })).json()
  assert.equal((await other.call(image.url)).status, 404)
  await f.restart('none')
  assert.deepEqual(await f.client().json('/api/documents'), [])
})

test('pending email invitations bind only to verified identities, survive restart and keep their identity after email changes', async t => {
  const f = await fixture(t), owner = f.register('owner@example.com')
  const { id } = await owner.json('/api/documents', 'POST', document)
  await owner.json(`/api/documents/${id}/shares`, 'POST', grant('LATER@example.com', 'reviewer'))
  const unverified = f.register('later@example.com', false, 'unverified')
  assert.equal((await unverified.call(`/api/documents/${id}`)).status, 404)
  const invited = f.register('later@example.com', true, 'verified')
  assert.equal((await invited.json(`/api/documents/${id}`)).access.role, 'reviewer')
  f.register('new-email@example.com', true, 'verified')
  await f.restart()
  assert.equal((await invited.json(`/api/documents/${id}`)).access.role, 'reviewer')
  assert.deepEqual(await f.register('later@example.com', true, 'different-person').json('/api/documents'), [])
})

test('roles and independent invite/export flags are enforced by HTTP and raw collaboration', async t => {
  const f = await fixture(t), owner = f.register('owner@example.com'), viewer = f.register('viewer@example.com'), reviewer = f.register('reviewer@example.com'), editor = f.register('editor@example.com')
  const { id } = await owner.json('/api/documents', 'POST', document)
  for (const [actor, role] of [[viewer, 'viewer'], [reviewer, 'reviewer'], [editor, 'editor']]) await owner.json(`/api/documents/${id}/shares`, 'POST', grant(actor.user.email, role))
  for (const actor of [viewer, reviewer, editor]) {
    assert.equal((await actor.call(`/api/documents/${id}/export.pdf`)).status, 403)
    assert.equal((await actor.call(`/api/documents/${id}/export.fountain`)).status, 403)
    assert.equal((await actor.call(`/api/documents/${id}/shares`, 'POST', grant('extra@example.com'))).status, 403)
    assert.equal((await actor.call(`/api/documents/${id}`, 'PATCH', { archived: true })).status, 403)
    assert.equal((await actor.call(`/api/documents/${id}`, 'DELETE')).status, 403)
  }
  assert.equal((await viewer.call(`/api/documents/${id}/review`, 'POST', {})).status, 403)
  assert.equal((await reviewer.call(`/api/documents/${id}/versions`, 'POST', {})).status, 403)
  assert.equal((await editor.call(`/api/documents/${id}/versions`, 'POST', {})).status, 201)
  await owner.json(`/api/documents/${id}/shares`, 'POST', grant(viewer.user.email, 'viewer', { canInvite: true, canExport: true }))
  assert.equal((await viewer.call(`/api/documents/${id}/export.fountain`)).status, 200)
  await viewer.json(`/api/documents/${id}/shares`, 'POST', grant('extra@example.com', 'viewer'))
  assert.equal((await viewer.call(`/api/documents/${id}/shares`, 'POST', grant('extra@example.com', 'editor'))).status, 403)
  for (const actor of [viewer, reviewer]) {
    const peer = await f.connect(actor, id, true)
    const changed = new Y.Doc()
    Y.applyUpdate(changed, Y.encodeStateAsUpdate(peer.doc))
    const vector = Y.encodeStateVector(changed)
    changed.getText('screenplay').insert(0, 'HACKED')
    const frame = encoding.createEncoder(); encoding.writeVarUint(frame, 0); sync.writeUpdate(frame, Y.encodeStateAsUpdate(changed, vector))
    const closed = new Promise(resolve => peer.provider.once('connection-close', event => { peer.provider.disconnect(); resolve(event) }))
    peer.provider.ws.send(encoding.toUint8Array(frame))
    assert.equal((await closed).code, 4003)
    changed.destroy()
  }
  assert.equal(await (await owner.call(`/api/documents/${id}/export.fountain`)).text(), document.text)
})

test('review commands preserve accepted source and assign comment and suggestion authors on the server', async t => {
  const f = await fixture(t), owner = f.register('owner@example.com'), reviewer = f.register('reviewer@example.com')
  const { id } = await owner.json('/api/documents', 'POST', document)
  await owner.json(`/api/documents/${id}/shares`, 'POST', grant(reviewer.user.email, 'reviewer'))
  const peer = await f.connect(reviewer, id, true)
  const source = peer.doc.getText('screenplay').toString(), anchor = relativeAnchor(peer.doc, 0, 3)
  const comment = await reviewer.json(`/api/documents/${id}/comments`, 'POST', { text: 'A note', anchor, authorId: owner.user.id, author: 'Forged' })
  Y.applyUpdate(peer.doc, Buffer.from(comment.update, 'base64'))
  assert.equal(peer.doc.getMap('comments').get(comment.id).authorId, reviewer.user.id)
  const response = await reviewer.json(`/api/documents/${id}/review`, 'POST', { base: digest(source), changes: [{ from: source.length, to: source.length, replacement: 'A suggestion' }] })
  Y.applyUpdate(peer.doc, Buffer.from(response.update, 'base64'))
  const suggestion = [...peer.doc.getMap('suggestions').values()][0]
  assert.equal(suggestion.authorId, reviewer.user.id)
  assert.equal(suggestion.replacement, 'A suggestion')
  assert.equal(peer.doc.getText('screenplay').toString(), source)
  assert.equal((await reviewer.call(`/api/documents/${id}/suggestions/${suggestion.id}/decide`, 'POST', { decision: 'accepted' })).status, 403)
  assert.equal((await reviewer.call(`/api/documents/${id}/review`, 'POST', { base: digest('stale'), changes: [] })).status, 409)
})

test('password links work without accounts, expire, and bound guest delegation and revocation', async t => {
  const f = await fixture(t), owner = f.register('owner@example.com'), invited = f.register('invited@example.com')
  const { id } = await owner.json('/api/documents', 'POST', document)
  const link = await owner.json(`/api/documents/${id}/shares`, 'POST', { kind: 'link', role: 'reviewer', canInvite: true, canExport: false, expiresAt: Date.now() + 60000, password: 'private-password' })
  const token = new URL(link.url).hash.slice(1), guest = f.client()
  assert.equal((await guest.call('/api/shares/open', 'POST', { token, password: 'wrong' })).status, 401)
  await guest.json('/api/shares/open', 'POST', { token, password: 'private-password' })
  assert.deepEqual(await guest.json('/api/documents'), [])
  assert.equal((await guest.call('/api/documents', 'POST', document)).status, 403)
  assert.equal((await guest.json(`/api/documents/${id}`)).access.role, 'reviewer')
  const child = await guest.json(`/api/documents/${id}/shares`, 'POST', grant(invited.user.email, 'viewer', { expiresAt: Date.now() + 86400000 }))
  assert.ok(child.expiresAt <= link.expiresAt)
  assert.equal((await guest.call(`/api/documents/${id}/shares`, 'POST', grant('x@example.com', 'editor'))).status, 403)
  assert.equal((await guest.call(`/api/documents/${id}/shares`, 'POST', grant('x@example.com', 'viewer', { canExport: true }))).status, 403)
  const stored = f.db.prepare('SELECT * FROM document_grants WHERE id=?').get(link.id)
  assert.notEqual(stored.token_hash, token); assert.ok(!stored.password_hash.includes('private-password'))
  const peer = await f.connect(invited, id, true)
  const closed = new Promise(resolve => peer.provider.once('connection-close', event => { peer.provider.disconnect(); resolve(event) }))
  await owner.json(`/api/documents/${id}/shares/${link.id}`, 'DELETE')
  assert.equal((await closed).code, 4003)
  assert.equal((await invited.call(`/api/documents/${id}`)).status, 404)
  assert.equal((await guest.call(`/api/documents/${id}`)).status, 404)
  const expired = await owner.json(`/api/documents/${id}/shares`, 'POST', { kind: 'link', role: 'viewer', canInvite: false, canExport: false, expiresAt: Date.now() + 30 })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal((await f.client().call('/api/shares/open', 'POST', { token: new URL(expired.url).hash.slice(1) })).status, 404)
})

test('leaving removes old invitations, linked access and descendants until a fresh invitation', async t => {
  const f = await fixture(t), owner = f.register('owner@example.com'), member = f.register('member@example.com'), child = f.register('child@example.com')
  const { id } = await owner.json('/api/documents', 'POST', document)
  await owner.json(`/api/documents/${id}/shares`, 'POST', grant(member.user.email, 'editor', { canInvite: true, canExport: true }))
  const link = await owner.json(`/api/documents/${id}/shares`, 'POST', { kind: 'link', role: 'editor', canInvite: false, canExport: true })
  const token = new URL(link.url).hash.slice(1)
  await member.json('/api/shares/open', 'POST', { token })
  await member.json(`/api/documents/${id}/shares`, 'POST', grant(child.user.email, 'reviewer'))
  const peer = await f.connect(member, id)
  const closed = new Promise(resolve => peer.provider.once('connection-close', event => { peer.provider.disconnect(); resolve(event) }))
  assert.equal((await owner.call(`/api/documents/${id}/leave`, 'POST')).status, 403)
  await member.json(`/api/documents/${id}/leave`, 'POST')
  assert.equal((await closed).code, 4003)
  assert.deepEqual(await member.json('/api/documents'), [])
  assert.equal((await child.call(`/api/documents/${id}`)).status, 404)
  assert.equal((await member.call('/api/shares/open', 'POST', { token })).status, 403)
  f.register(member.user.email)
  await f.restart()
  assert.equal((await member.call(`/api/documents/${id}`)).status, 404)
  await owner.json(`/api/documents/${id}/shares`, 'POST', grant(member.user.email, 'viewer'))
  const access = (await member.json(`/api/documents/${id}`)).access
  assert.equal(access.role, 'viewer')
  assert.equal(access.canExport, false)
})

test('ownership migration is explicit and dry-run does not change document ownership', async t => {
  const f = await fixture(t), owner = f.register('owner@example.com')
  const id = crypto.randomUUID(), doc = new Y.Doc()
  f.db.prepare('INSERT INTO documents(id,title,state,updated_at,scope) VALUES(?,?,?,?,?)').run(id, 'Legacy', Y.encodeStateAsUpdate(doc), Date.now(), 'unassigned')
  doc.destroy()
  assert.equal((await owner.call(`/api/documents/${id}`)).status, 404)
  const map = `${f.directory}/owners.json`
  await writeFile(map, JSON.stringify({ [id]: owner.user.email }))
  const env = { ...process.env, DATA_DIR: f.directory, AUTH_MODE: 'oauth' }
  execFileSync(process.execPath, ['server/ownership.js', map], { env })
  assert.equal(f.db.prepare('SELECT owner_id FROM documents WHERE id=?').get(id).owner_id, null)
  execFileSync(process.execPath, ['server/ownership.js', map, '--apply'], { env })
  assert.equal((await owner.json(`/api/documents/${id}`)).access.owner, true)
})

test('guest editors can collaborate, and expiry closes an idle guest connection', async t => {
  const f = await fixture(t, { HEARTBEAT_INTERVAL_MS: '20' }), owner = f.register('owner@example.com')
  const { id } = await owner.json('/api/documents', 'POST', document)
  const link = await owner.json(`/api/documents/${id}/shares`, 'POST', { kind: 'link', role: 'editor', canInvite: false, canExport: true, expiresAt: Date.now() + 500 })
  const guest = f.client()
  await guest.json('/api/shares/open', 'POST', { token: new URL(link.url).hash.slice(1) })
  const peer = await f.connect(guest, id)
  peer.doc.getText('screenplay').insert(0, 'A guest edit.\n\n')
  await flushCollaboration(peer.provider, peer.doc)
  assert.ok((await (await owner.call(`/api/documents/${id}/export.fountain`)).text()).startsWith('A guest edit.'))
  const closed = new Promise(resolve => peer.provider.once('connection-close', event => { peer.provider.disconnect(); resolve(event) }))
  assert.equal((await closed).code, 4003)
  assert.equal((await guest.call(`/api/documents/${id}/export.fountain`)).status, 404)
})

test('only owners transfer ownership and restoring content never restores revoked access', async t => {
  const f = await fixture(t), owner = f.register('owner@example.com'), editor = f.register('editor@example.com'), target = f.register('target@example.com')
  const { id } = await owner.json('/api/documents', 'POST', document)
  const version = await owner.json(`/api/documents/${id}/versions`, 'POST', { label: 'Before sharing' })
  const share = await owner.json(`/api/documents/${id}/shares`, 'POST', grant(editor.user.email, 'editor'))
  assert.equal((await editor.call(`/api/documents/${id}/owner`, 'POST', { email: target.user.email })).status, 403)
  await owner.json(`/api/documents/${id}/shares/${share.id}`, 'DELETE')
  await owner.json(`/api/documents/${id}/versions/${version.id}/restore`, 'POST')
  assert.equal((await editor.call(`/api/documents/${id}`)).status, 404)
  await owner.json(`/api/documents/${id}/owner`, 'POST', { email: target.user.email })
  assert.equal((await target.json(`/api/documents/${id}`)).access.owner, true)
  assert.equal((await owner.call(`/api/documents/${id}`)).status, 404)
})

test('invites work without mail and optional SMTP delivery does not control access', async t => {
  const messages = []
  const f = await fixture(t, { SMTP_URL: 'smtp://example.invalid', SMTP_FROM: 'writer@example.com', mailer: { sendMail: async value => { messages.push(value) } } })
  const owner = f.register('owner@example.com')
  const { id } = await owner.json('/api/documents', 'POST', document)
  const response = await owner.json(`/api/documents/${id}/shares`, 'POST', grant('later@example.com'))
  assert.equal(response.notificationSent, true)
  assert.equal(messages[0].to, 'later@example.com')
  assert.equal((await f.register('later@example.com').json(`/api/documents/${id}`)).access.role, 'viewer')
})
