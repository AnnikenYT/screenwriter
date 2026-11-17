import test from 'node:test'
import assert from 'node:assert/strict'
import * as Y from 'yjs'
import { WebsocketProvider } from 'y-websocket'
import WebSocket from 'ws'
import * as encoding from 'lib0/encoding'
import { mkdtemp, rm } from 'node:fs/promises'
import { flushCollaboration } from '../src/lib/sync-barrier.js'
import { createWorkspace } from '../server/index.js'

function fakeProvider() {
  const ws = new EventTarget()
  ws.readyState = 1
  let state = { user: { name: 'Writer' } }
  return { ws, synced: true, awareness: {
    getLocalState: () => state,
    setLocalState: next => { state = next },
    setLocalStateField: (key, value) => { state = { ...state, [key]: value } },
  } }
}
function echo(provider, client, nonce) {
  const update = encoding.createEncoder()
  encoding.writeVarUint(update, 1)
  encoding.writeVarUint(update, client)
  encoding.writeVarUint(update, 1)
  encoding.writeVarString(update, JSON.stringify({ _flush: nonce }))
  const frame = encoding.createEncoder()
  encoding.writeVarUint(frame, 1)
  encoding.writeVarUint8Array(frame, encoding.toUint8Array(update))
  provider.ws.dispatchEvent(new MessageEvent('message', { data: encoding.toUint8Array(frame) }))
}
test('reload barrier waits for its own fresh server echo, not other sync or presence frames', async () => {
  const provider = fakeProvider()
  const promise = flushCollaboration(provider, { clientID: 42 })
  const nonce = provider.awareness.getLocalState()._flush
  let saved = false
  promise.then(() => saved = true)
  echo(provider, 99, nonce)
  echo(provider, 42, 'older-marker')
  provider.ws.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([0, 1, 0]) }))
  await Promise.resolve()
  assert.equal(saved, false)
  echo(provider, 42, nonce)
  await promise
  assert.equal(provider.awareness.getLocalState()._flush, undefined)
  assert.equal(provider.awareness.getLocalState().user.name, 'Writer')
})
test('reload barrier refuses offline sockets and times out without discarding the tab', async () => {
  const provider = fakeProvider()
  provider.ws.readyState = 3
  await assert.rejects(flushCollaboration(provider, { clientID: 42 }), /Reconnect/)
  provider.ws.readyState = 1
  await assert.rejects(flushCollaboration(provider, { clientID: 42 }, 10), /Could not confirm saved/)
  assert.equal(provider.awareness.getLocalState()._flush, undefined)
})
test('a connection closing during a barrier prevents the reload', async () => {
  const provider = fakeProvider()
  const promise = flushCollaboration(provider, { clientID: 42 })
  provider.ws.dispatchEvent(new Event('close'))
  await assert.rejects(promise, /not reloaded/)
})
test('real socket barrier commits text, deletions, and proposals before restart', async () => {
  const directory = await mkdtemp('/tmp/opencode/screenwriter-barrier-')
  let workspace, provider, doc
  async function start() {
    workspace = createWorkspace({ DATA_DIR: directory, AUTH_MODE: 'none' })
    await new Promise(resolve => workspace.server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${workspace.server.address().port}`
  }
  async function connect(base, id) {
    doc = new Y.Doc()
    provider = new WebsocketProvider(base.replace('http:', 'ws:') + '/collaboration', id, doc, { WebSocketPolyfill: WebSocket, disableBc: true })
    await new Promise(resolve => provider.on('sync', value => { if (value) resolve() }))
  }
  try {
    let base = await start()
    const response = await fetch(base + '/api/documents', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: 'Before' }) })
    const { id } = await response.json()
    await connect(base, id)
    doc.getText('screenplay').delete(0, 6)
    doc.getText('screenplay').insert(0, 'Saved writing')
    doc.getMap('suggestions').set('proposal', { id: 'proposal', status: 'pending', replacement: 'Another thought' })
    await flushCollaboration(provider, doc)
    provider.destroy(); provider = null; doc.destroy(); doc = null
    await workspace.close()
    base = await start()
    await connect(base, id)
    assert.equal(doc.getText('screenplay').toString(), 'Saved writing')
    assert.equal(doc.getMap('suggestions').get('proposal').replacement, 'Another thought')
  } finally {
    provider?.destroy(); doc?.destroy(); await workspace?.close()
    await rm(directory, { recursive: true, force: true })
  }
})
