import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'
import { createWorkspace } from '../server/index.js'
import { reconcileSheets, changeSheetStatus } from '../shared/entities.js'
import { flushCollaboration } from '../src/lib/sync-barrier.js'

test('sheet archive, restore and deletion preserve source and suppress discovery', () => {
  for (const kind of ['characters', 'locations']) {
    const doc = new Y.Doc()
    const source = 'INT. ROOM - DAY\n\nMARA\nHello.\n'
    doc.getText('screenplay').insert(0, source)
    reconcileSheets(doc)
    const map = doc.getMap(kind), sheet = [...map.values()][0]
    const key = `sheet:${kind}:${sheet.id}:notes`
    doc.getMap('meta').set(key, 'Keep these notes')
    changeSheetStatus(doc, kind, sheet.id, 'archived')
    reconcileSheets(doc)
    assert.equal(map.get(sheet.id).status, 'archived')
    assert.equal(doc.getMap('meta').get(key), 'Keep these notes')
    doc.getText('screenplay').delete(0, source.length)
    reconcileSheets(doc)
    assert.equal(map.get(sheet.id).status, 'archived')
    changeSheetStatus(doc, kind, sheet.id, 'active')
    reconcileSheets(doc)
    assert.equal(map.get(sheet.id).status, 'active')
    doc.getText('screenplay').insert(0, source)
    changeSheetStatus(doc, kind, sheet.id, 'deleted')
    for (let i = 0; i < 3; i++) reconcileSheets(doc)
    assert.deepEqual(map.get(sheet.id), { id: sheet.id, name: sheet.name, status: 'deleted' })
    assert.equal(doc.getMap('meta').has(key), false)
    assert.equal(map.size, 1)
    assert.equal(doc.getText('screenplay').toString(), source)
    const restored = new Y.Doc()
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(doc))
    reconcileSheets(restored)
    assert.equal(restored.getMap(kind).get(sheet.id).status, 'deleted')
    doc.destroy(); restored.destroy()
  }
})

test('document lifecycle migrates old databases, stops sockets, persists archives and deletes owned data', async () => {
  const directory = await mkdtemp('/tmp/opencode/screenwriter-lifecycle-')
  const db = new DatabaseSync(`${directory}/workspace.sqlite`)
  db.exec('CREATE TABLE documents(id TEXT PRIMARY KEY,title TEXT NOT NULL,state BLOB NOT NULL,updated_at INTEGER NOT NULL)')
  db.close()
  let workspace, provider, doc
  async function start() {
    workspace = createWorkspace({ DATA_DIR: directory, AUTH_MODE: 'none' })
    await new Promise(resolve => workspace.server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${workspace.server.address().port}`
  }
  try {
    let base = await start()
    const call = (url, method = 'GET', body) => fetch(base + url, { method, headers: { 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) })
    const { id } = await (await call('/api/documents', 'POST', { title: 'Lifecycle', text: 'INT. ROOM - DAY\n\nMARA\nHello.\n' })).json()
    doc = new Y.Doc()
    provider = new WebsocketProvider(base.replace('http:', 'ws:') + '/collaboration', id, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
    await new Promise(resolve => provider.on('sync', value => { if (value) resolve() }))
    const sheet = [...doc.getMap('characters').values()][0]
    changeSheetStatus(doc, 'characters', sheet.id, 'archived')
    doc.getText('scratchpad').insert(0, 'Preserved')
    await flushCollaboration(provider, doc)
    const version = await (await call(`/api/documents/${id}/versions`, 'POST', { label: 'Before archive' })).json()
    const form = new FormData()
    form.append('image', new Blob([Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex')], { type: 'image/png' }), 'reference.png')
    const image = await (await fetch(base + `/api/documents/${id}/images`, { method: 'POST', body: form })).json()
    assert.ok(image.url)
    const closed = new Promise(resolve => provider.on('connection-close', event => { if (event?.code === 4004) { provider.disconnect(); resolve(event) } }))
    assert.equal((await call(`/api/documents/${id}`, 'PATCH', { archived: true })).status, 200)
    assert.equal((await closed).reason, 'Screenplay archived')
    assert.deepEqual(await (await call('/api/documents')).json(), [])
    assert.equal((await (await call('/api/documents?archived=true')).json())[0].id, id)
    assert.equal((await call(`/api/documents/${id}/export.pdf`)).status, 409)
    provider.destroy(); provider = null; doc.destroy(); doc = null
    await workspace.close()
    base = await start()
    assert.ok((await (await call(`/api/documents/${id}`)).json()).archivedAt)
    await call(`/api/documents/${id}`, 'PATCH', { archived: false })
    assert.equal((await call(`/api/documents/${id}/versions/${version.id}`)).status, 200)
    doc = new Y.Doc()
    provider = new WebsocketProvider(base.replace('http:', 'ws:') + '/collaboration', id, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
    await new Promise(resolve => provider.on('sync', value => { if (value) resolve() }))
    assert.equal(doc.getText('scratchpad').toString(), 'Preserved')
    assert.equal(doc.getMap('characters').get(sheet.id).status, 'archived')
    provider.disconnect()
    assert.equal((await call(`/api/documents/${id}`, 'DELETE')).status, 200)
    assert.equal((await call(`/api/documents/${id}`)).status, 404)
    assert.equal((await call(`/api/documents/${id}/versions/${version.id}`)).status, 404)
    assert.equal((await fetch(base + image.url)).status, 404)
    assert.deepEqual(await readdir(`${directory}/uploads`), [])
    const inspect = new DatabaseSync(`${directory}/workspace.sqlite`)
    for (const table of ['documents', 'document_updates', 'versions', 'images']) assert.equal(inspect.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0)
    inspect.close()
  } finally {
    provider?.destroy(); doc?.destroy(); await workspace?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
